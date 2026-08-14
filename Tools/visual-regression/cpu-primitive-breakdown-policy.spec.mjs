import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  applyPrimitiveFirstRedPolicy,
  buildPrimitiveBreakdownReport,
  CONTROL_PAIRS,
  PRIMITIVE_BREAKDOWN_CONFIG,
  PRIMITIVE_DETAIL_CONTROL_SPECS,
  PRIMITIVE_DETAIL_NAMES,
  evaluateDefaultGlobeScope,
  evaluatePrimitiveInstrumentation,
  evaluatePrimitiveDetailControl,
  evaluatePrimitiveDetailFrames,
  normalizePrimitiveCapture,
} from "./probe-c11-169-primitive-breakdown.mjs";
import { CPU_SCENE_PHASE_NAMES } from "./probe-webgpu-frame-breakdown.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const probeSource = fs.readFileSync(
  path.join(__dirname, "probe-c11-169-primitive-breakdown.mjs"),
  "utf8",
);
const viewportSource = fs.readFileSync(
  path.join(
    __dirname,
    "../../packages/engine/Source/Scene/ViewportExecutor.js",
  ),
  "utf8",
);

const BASE_DETAIL_MS = Object.freeze({
  groundPrimitiveUpdate: 0.5,
  ordinaryPrimitiveUpdate: 1,
  dynamicEnvironmentDrain: 0.25,
  globeRender: 2,
});

function makeCapture(index, overrides = {}) {
  const phaseMs = Object.fromEntries(
    CPU_SCENE_PHASE_NAMES.map((phase) => [phase, 0.1]),
  );
  phaseMs.sceneUpdate = 1;
  phaseMs.primitiveTraversal = 4;
  phaseMs.computeShadows = 2;
  Object.assign(phaseMs, overrides.phaseMs);
  const phaseTotalMs = Object.values(phaseMs).reduce(
    (sum, value) => sum + value,
    0,
  );
  const profiledPassMs = overrides.profiledPassMs ?? 1;
  const totalMs = overrides.totalMs ?? profiledPassMs + phaseTotalMs;
  const sequence = overrides.sequence ?? index + 1;
  return {
    profile: {
      lastFrame: {
        sequence,
        sceneFrameNumber: overrides.sceneFrameNumber ?? 100 + index,
        kind: "scene",
        totalMs,
        profiledPassMs,
        unaccountedMs: phaseTotalMs,
        overlapMs: 0,
        coverageRatio: profiledPassMs / totalMs,
        valid: true,
        passMs: { globe: profiledPassMs },
        phaseAttributionEnabled: true,
        phaseMs,
        phaseTotalMs,
        unattributedMs: 0,
        attributionOverlapMs: 0,
        attributionValid: true,
      },
    },
    detail: {
      detailMs: { ...BASE_DETAIL_MS, ...overrides.detailMs },
      hits: Object.fromEntries(PRIMITIVE_DETAIL_NAMES.map((name) => [name, 1])),
      sequenceBefore: sequence - 1,
      sequenceAfter: sequence,
      normalSampleDelta: 1,
      ...overrides.detail,
    },
    metadata: {
      routeProgress: overrides.routeProgress ?? index / 10,
      segmentIndex: overrides.segmentIndex ?? Math.min(7, index),
      segmentName: overrides.segmentName ?? `segment-${Math.min(7, index)}`,
      height: overrides.height ?? 1_000_000,
      frameIndex: overrides.frameIndex,
      frustumCount: 1,
      seamHitDelta: overrides.seamHitDelta,
      spinHitDelta: overrides.spinHitDelta,
      controlId: overrides.controlId,
      targetDetail: overrides.targetDetail,
      parentPhase: overrides.parentPhase,
      pairIndex: overrides.pairIndex,
      injected: overrides.injected,
    },
  };
}

function makeRawControlPair(spec, pairIndex = 0) {
  const controlSpecIndex = PRIMITIVE_DETAIL_CONTROL_SPECS.findIndex(
    (candidate) => candidate.id === spec.id,
  );
  const routeProgress = pairIndex / (CONTROL_PAIRS - 1);
  const injectedFirst = (pairIndex + controlSpecIndex) % 2 === 1;
  const metadata = {
    controlId: spec.id,
    targetDetail: spec.detail,
    parentPhase: spec.parentPhase,
    pairIndex,
    routeProgress,
  };
  const baselineCapture = makeCapture(pairIndex * 2 + (injectedFirst ? 1 : 0), {
    seamHitDelta: 1,
    spinHitDelta: 0,
    injected: false,
    ...metadata,
  });
  const injectedDetailMs = {
    ...BASE_DETAIL_MS,
    [spec.detail]: BASE_DETAIL_MS[spec.detail] + 8,
  };
  const injectedPhaseMs = {
    ...baselineCapture.profile.lastFrame.phaseMs,
    [spec.parentPhase]:
      baselineCapture.profile.lastFrame.phaseMs[spec.parentPhase] + 8,
  };
  const injectedCapture = makeCapture(pairIndex * 2 + (injectedFirst ? 0 : 1), {
    detailMs: injectedDetailMs,
    phaseMs: injectedPhaseMs,
    seamHitDelta: 1,
    spinHitDelta: 1,
    injected: true,
    ...metadata,
  });
  return {
    routeProgress,
    injectedFirst,
    baseline: baselineCapture,
    injected: injectedCapture,
  };
}

function makeControlPair(spec, pairIndex = 0) {
  const pair = makeRawControlPair(spec, pairIndex);
  return {
    ...pair,
    baseline: normalizePrimitiveCapture(pair.baseline),
    injected: normalizePrimitiveCapture(pair.injected),
  };
}

function makeValidInstrumentation() {
  return {
    mode: "tools-instance-wrappers",
    installed: true,
    restored: true,
    targets: PRIMITIVE_DETAIL_CONTROL_SPECS.map((spec) => ({
      owner: spec.owner,
      detailName: spec.detail,
      methodName: spec.method,
      hadOwn: false,
      installedExact: true,
      restoredExact: true,
    })),
  };
}

function makeValidRawReport() {
  const routeFrames = Array.from(
    { length: PRIMITIVE_BREAKDOWN_CONFIG.measureFrames },
    (_, index) => {
      const routeProgress =
        index / (PRIMITIVE_BREAKDOWN_CONFIG.measureFrames - 1);
      const segmentIndex = Math.min(7, Math.floor(routeProgress * 8));
      return makeCapture(index, {
        frameIndex: index,
        routeProgress,
        segmentIndex,
        segmentName: `segment-${segmentIndex}`,
        height: 1_000_000 - index,
      });
    },
  );
  const lanes = PRIMITIVE_DETAIL_CONTROL_SPECS.map((spec) => {
    const pairs = Array.from(
      { length: PRIMITIVE_BREAKDOWN_CONFIG.controlPairs },
      (_, index) => makeRawControlPair(spec, index),
    );
    return {
      id: spec.id,
      targetDetail: spec.detail,
      parentPhase: spec.parentPhase,
      seamHits: PRIMITIVE_BREAKDOWN_CONFIG.controlPairs * 2,
      spinHits: PRIMITIVE_BREAKDOWN_CONFIG.controlPairs,
      frames: pairs.flatMap((pair) =>
        pair.injectedFirst
          ? [pair.injected, pair.baseline]
          : [pair.baseline, pair.injected],
      ),
      pairs,
    };
  });
  const scopePoint = {
    ordinaryPrimitiveCount: 0,
    groundPrimitiveCount: 0,
    globePresent: true,
    globeShown: true,
  };
  return {
    runId: "synthetic-valid-report",
    rendererType: "webgpu",
    setup: { imagery: "NaturalEarthII-local", fixedTime: "fixed" },
    profiler: {
      available: true,
      defaultDisabled: true,
      disabledAfter: true,
    },
    instrumentation: makeValidInstrumentation(),
    scope: {
      id: "default-globe-local-v1",
      explicitAssetsAdded: 0,
      representativeTilesetWorkload: false,
      transferableToC11168: false,
      beforePrime: { ...scopePoint },
      afterScoring: { ...scopePoint },
    },
    prime: { frames: 58 },
    route: {
      frames: routeFrames,
      sequenceDelta: PRIMITIVE_BREAKDOWN_CONFIG.measureFrames,
      accountingStart: {},
      accountingEnd: {},
    },
    controls: { lanes },
    renderErrors: [],
    pageErrors: [],
    localRequestFailures: [],
    inPageFatal: null,
  };
}

function chronologicalFrames(pairs) {
  return pairs.flatMap((pair) =>
    pair.injectedFirst
      ? [pair.injected, pair.baseline]
      : [pair.baseline, pair.injected],
  );
}

function evaluateControl(pairs, spec) {
  return evaluatePrimitiveDetailControl(
    pairs,
    spec,
    8,
    chronologicalFrames(pairs),
  );
}

test("normalizes exact nested intervals and derives non-overlapping residuals", () => {
  const record = normalizePrimitiveCapture(makeCapture(0));
  assert.deepEqual(record.primitiveDetail.detailMs, BASE_DETAIL_MS);
  assert.equal(record.primitiveDetail.primitiveNestedMs, 3.5);
  assert.equal(record.primitiveDetail.primitiveResidualMs, 0.5);
  assert.equal(record.primitiveDetail.computeResidualMs, 1.75);
  assert.equal(record.primitiveDetail.settlementResidualMs, 0);
  const gate = evaluatePrimitiveDetailFrames([record], {
    expectedSamples: 1,
  });
  assert.equal(gate.pass, true, gate.failures.join("\n"));
});

test("missing lastFrame and missing detail fail closed without throwing", () => {
  const missingFrame = normalizePrimitiveCapture({
    profile: {},
    detail: makeCapture(0).detail,
  });
  const missingDetail = normalizePrimitiveCapture({
    profile: makeCapture(0).profile,
  });
  for (const record of [missingFrame, missingDetail]) {
    const gate = evaluatePrimitiveDetailFrames([record], {
      expectedSamples: 1,
    });
    assert.equal(gate.pass, false);
    assert.match(gate.failures.join("\n"), /missing/);
  }
});

test("detail settlement rejects overlap, bad hits, and stale sequence", () => {
  const overlap = makeCapture(0, {
    detailMs: { globeRender: 5 },
  });
  const badHits = makeCapture(1);
  badHits.detail.hits.globeRender = 0;
  const stale = makeCapture(2);
  stale.detail.sequenceAfter = 2;
  stale.detail.normalSampleDelta = 0;
  const gate = evaluatePrimitiveDetailFrames(
    [overlap, badHits, stale].map(normalizePrimitiveCapture),
    { expectedSamples: 3 },
  );
  assert.equal(gate.pass, false);
  assert.match(gate.failures.join("\n"), /primitive residual/);
  assert.match(gate.failures.join("\n"), /hit count/);
  assert.match(gate.failures.join("\n"), /detail sequence/);
});

test("detail settlement rejects extra or reordered schema keys", () => {
  const extraDetail = makeCapture(0);
  extraDetail.detail.detailMs.extraBucket = 1;
  const extraHit = makeCapture(1);
  extraHit.detail.hits.extraBucket = 1;
  const reordered = makeCapture(2);
  reordered.detail.detailMs = {
    globeRender: 2,
    groundPrimitiveUpdate: 0.5,
    ordinaryPrimitiveUpdate: 1,
    dynamicEnvironmentDrain: 0.25,
  };
  const gate = evaluatePrimitiveDetailFrames(
    [extraDetail, extraHit, reordered].map(normalizePrimitiveCapture),
    { expectedSamples: 3 },
  );
  assert.equal(gate.pass, false);
  assert.match(gate.failures.join("\n"), /detail keys/);
  assert.match(gate.failures.join("\n"), /hit keys/);
});

test("all four paired controls move only their detail and parent phase", () => {
  for (const spec of PRIMITIVE_DETAIL_CONTROL_SPECS) {
    const pairs = Array.from({ length: CONTROL_PAIRS }, (_, index) =>
      makeControlPair(spec, index),
    );
    const gate = evaluateControl(pairs, spec);
    assert.equal(gate.pass, true, `${spec.id}: ${gate.failures.join("\n")}`);
    assert.equal(gate.observed.targetDetailDeltaMs.median, 8);
    assert.equal(gate.observed.parentPhaseDeltaMs.median, 8);
  }
});

test("control schema is literal, unique, ordered, and deeply frozen", () => {
  assert.deepEqual(PRIMITIVE_DETAIL_CONTROL_SPECS, [
    {
      id: "ground-primitives",
      detail: "groundPrimitiveUpdate",
      parentPhase: "primitiveTraversal",
      owner: "scene._groundPrimitives",
      method: "update",
    },
    {
      id: "ordinary-primitives",
      detail: "ordinaryPrimitiveUpdate",
      parentPhase: "primitiveTraversal",
      owner: "scene._primitives",
      method: "update",
    },
    {
      id: "dynamic-environment-drain",
      detail: "dynamicEnvironmentDrain",
      parentPhase: "computeShadows",
      owner: "frameState.context",
      method: "drainEnvironmentMapUpdates",
    },
    {
      id: "globe-render",
      detail: "globeRender",
      parentPhase: "primitiveTraversal",
      owner: "scene._globe",
      method: "render",
    },
  ]);
  assert.equal(Object.isFrozen(PRIMITIVE_DETAIL_CONTROL_SPECS), true);
  assert.equal(
    PRIMITIVE_DETAIL_CONTROL_SPECS.every((spec) => Object.isFrozen(spec)),
    true,
  );
  assert.equal(
    new Set(PRIMITIVE_DETAIL_CONTROL_SPECS.map((spec) => spec.id)).size,
    4,
  );
  assert.equal(
    new Set(PRIMITIVE_DETAIL_CONTROL_SPECS.map((spec) => spec.detail)).size,
    4,
  );
});

test("paired controls reject rerouting, leakage, and hit-count mutants", () => {
  const spec = PRIMITIVE_DETAIL_CONTROL_SPECS[3];
  const rerouted = Array.from({ length: CONTROL_PAIRS }, (_, index) =>
    makeControlPair(spec, index),
  );
  for (const pair of rerouted) {
    pair.injected.primitiveDetail.detailMs.globeRender -= 8;
    pair.injected.primitiveDetail.detailMs.ordinaryPrimitiveUpdate += 8;
  }
  assert.equal(evaluateControl(rerouted, spec).pass, false);

  const namedLeak = Array.from({ length: CONTROL_PAIRS }, (_, index) =>
    makeControlPair(spec, index),
  );
  for (const pair of namedLeak) {
    pair.injected.passMs.globe += 3;
    pair.injected.profiledPassMs += 3;
  }
  assert.equal(evaluateControl(namedLeak, spec).pass, false);

  const badHits = Array.from({ length: CONTROL_PAIRS }, (_, index) =>
    makeControlPair(spec, index),
  );
  badHits[0].injected.spinHitDelta = 2;
  assert.equal(evaluateControl(badHits, spec).pass, false);
});

test("paired controls independently reject accounting and leakage mutants", () => {
  const spec = PRIMITIVE_DETAIL_CONTROL_SPECS[0];
  const mutate = (callback) => {
    const pairs = Array.from({ length: CONTROL_PAIRS }, (_, index) =>
      makeControlPair(spec, index),
    );
    for (const pair of pairs) callback(pair);
    return evaluateControl(pairs, spec);
  };
  for (const field of ["totalMs", "phaseTotalMs", "unaccountedMs"]) {
    const gate = mutate((pair) => {
      pair.injected[field] = pair.baseline[field];
    });
    assert.equal(gate.pass, false, `${field} mutant passed`);
  }
  assert.equal(
    mutate((pair) => {
      pair.injected.phaseMs.frameState += 3;
    }).pass,
    false,
  );
  assert.equal(
    mutate((pair) => {
      pair.injected.primitiveDetail.detailMs.globeRender += 3;
    }).pass,
    false,
  );
  assert.equal(
    mutate((pair) => {
      pair.injected.primitiveDetail.primitiveResidualMs += 3;
    }).pass,
    false,
  );
  for (const field of ["unattributedMs", "overlapMs", "attributionOverlapMs"]) {
    const gate = mutate((pair) => {
      pair.injected[field] += 3;
    });
    assert.equal(gate.pass, false, `${field} leakage mutant passed`);
  }
});

test("paired controls reject wrong pairing, chronology, route, and balance", () => {
  const spec = PRIMITIVE_DETAIL_CONTROL_SPECS[1];

  const wrongPairing = Array.from({ length: CONTROL_PAIRS }, (_, index) =>
    makeControlPair(spec, index),
  );
  const wrongPairingChronology = chronologicalFrames(wrongPairing);
  [wrongPairing[0].injected, wrongPairing[1].injected] = [
    wrongPairing[1].injected,
    wrongPairing[0].injected,
  ];
  const wrongPairingGate = evaluatePrimitiveDetailControl(
    wrongPairing,
    spec,
    8,
    wrongPairingChronology,
  );
  assert.equal(wrongPairingGate.pass, false);
  assert.match(
    wrongPairingGate.failures.join("\n"),
    /pair index|route progress|chronological frame/,
  );

  const reversed = Array.from({ length: CONTROL_PAIRS }, (_, index) =>
    makeControlPair(spec, index),
  );
  const reversedChronology = chronologicalFrames(reversed);
  reversed[0].injectedFirst = !reversed[0].injectedFirst;
  const reversedGate = evaluatePrimitiveDetailControl(
    reversed,
    spec,
    8,
    reversedChronology,
  );
  assert.equal(reversedGate.pass, false);
  assert.match(
    reversedGate.failures.join("\n"),
    /counterbalance|chronology|chronological frame/,
  );

  const unbalanced = Array.from({ length: CONTROL_PAIRS }, (_, index) =>
    makeControlPair(spec, index),
  );
  for (const pair of unbalanced) pair.injectedFirst = false;
  const unbalancedGate = evaluateControl(unbalanced, spec);
  assert.equal(unbalancedGate.pass, false);
  assert.match(unbalancedGate.failures.join("\n"), /counterbalance/);

  const badRoute = Array.from({ length: CONTROL_PAIRS }, (_, index) =>
    makeControlPair(spec, index),
  );
  badRoute.at(-1).routeProgress = 0.9;
  const badRouteGate = evaluateControl(badRoute, spec);
  assert.equal(badRouteGate.pass, false);
  assert.match(badRouteGate.failures.join("\n"), /route progress/);

  const short = Array.from({ length: CONTROL_PAIRS - 1 }, (_, index) =>
    makeControlPair(spec, index),
  );
  const shortGate = evaluateControl(short, spec);
  assert.equal(shortGate.pass, false);
  assert.match(shortGate.failures.join("\n"), /control pair count/);
});

test("paired controls reject same-sequence payload divergence", () => {
  const spec = PRIMITIVE_DETAIL_CONTROL_SPECS[2];
  const pairs = Array.from({ length: CONTROL_PAIRS }, (_, index) =>
    makeControlPair(spec, index),
  );
  const chronology = chronologicalFrames(pairs).map((record) =>
    structuredClone(record),
  );
  pairs[0].injected.totalMs += 8;
  pairs[0].injected.phaseMs.computeShadows += 8;
  pairs[0].injected.phaseTotalMs += 8;
  pairs[0].injected.unaccountedMs += 8;
  pairs[0].injected.primitiveDetail.detailMs.dynamicEnvironmentDrain += 8;
  const gate = evaluatePrimitiveDetailControl(pairs, spec, 8, chronology);
  assert.equal(gate.pass, false);
  assert.match(gate.failures.join("\n"), /payload diverged/);
});

test("instrumentation gate requires exact ordered owners and restoration", () => {
  const targets = PRIMITIVE_DETAIL_CONTROL_SPECS.map((spec) => ({
    owner: spec.owner,
    detailName: spec.detail,
    methodName: spec.method,
    hadOwn: false,
    installedExact: true,
    restoredExact: true,
  }));
  const good = evaluatePrimitiveInstrumentation({
    installed: true,
    restored: true,
    targets,
  });
  assert.equal(good.pass, true, good.failures.join("\n"));

  const wrongOwner = structuredClone(targets);
  wrongOwner[2].owner = "scene.context";
  assert.equal(
    evaluatePrimitiveInstrumentation({
      installed: true,
      restored: true,
      targets: wrongOwner,
    }).pass,
    false,
  );

  const notRestored = structuredClone(targets);
  notRestored[3].restoredExact = false;
  assert.equal(
    evaluatePrimitiveInstrumentation({
      installed: true,
      restored: true,
      targets: notRestored,
    }).pass,
    false,
  );
});

test("default-globe scope is explicit and rejects tileset-transfer claims", () => {
  const scope = {
    id: "default-globe-local-v1",
    explicitAssetsAdded: 0,
    representativeTilesetWorkload: false,
    transferableToC11168: false,
    beforePrime: {
      ordinaryPrimitiveCount: 0,
      groundPrimitiveCount: 0,
      globePresent: true,
      globeShown: true,
    },
    afterScoring: {
      ordinaryPrimitiveCount: 0,
      groundPrimitiveCount: 0,
      globePresent: true,
      globeShown: true,
    },
  };
  assert.equal(evaluateDefaultGlobeScope(scope).pass, true);
  assert.equal(
    evaluateDefaultGlobeScope({
      ...scope,
      representativeTilesetWorkload: true,
    }).pass,
    false,
  );
  assert.equal(
    evaluateDefaultGlobeScope({
      ...scope,
      afterScoring: { ...scope.afterScoring, ordinaryPrimitiveCount: 1 },
    }).pass,
    false,
  );

  const mutations = [
    (candidate) => (candidate.id = "other"),
    (candidate) => (candidate.explicitAssetsAdded = 1),
    (candidate) => (candidate.representativeTilesetWorkload = true),
    (candidate) => (candidate.transferableToC11168 = true),
    (candidate) => (candidate.beforePrime.ordinaryPrimitiveCount = 1),
    (candidate) => (candidate.beforePrime.groundPrimitiveCount = 1),
    (candidate) => (candidate.beforePrime.globePresent = false),
    (candidate) => (candidate.beforePrime.globeShown = false),
    (candidate) => (candidate.afterScoring.ordinaryPrimitiveCount = 1),
    (candidate) => (candidate.afterScoring.groundPrimitiveCount = 1),
    (candidate) => (candidate.afterScoring.globePresent = false),
    (candidate) => (candidate.afterScoring.globeShown = false),
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(scope);
    mutate(candidate);
    assert.equal(evaluateDefaultGlobeScope(candidate).pass, false);
  }
});

test("full report composes fail-closed status and exact error snapshots", () => {
  const gpuGate = { armedDevices: 1, errors: [], deviceLost: null };
  const goodRaw = makeValidRawReport();
  const good = buildPrimitiveBreakdownReport(goodRaw, [], gpuGate);
  assert.equal(good.status, "PASS", good.failures.join("\n"));
  assert.equal(good.pass, true);
  assert.equal(good.exitCode, 0);
  assert.deepEqual(good.failures, []);

  const notRestored = structuredClone(goodRaw);
  notRestored.instrumentation.targets[0].restoredExact = false;
  const restoreReport = buildPrimitiveBreakdownReport(notRestored, [], gpuGate);
  assert.equal(restoreReport.status, "FAIL");
  assert.equal(restoreReport.exitCode, 1);

  const missingLane = structuredClone(goodRaw);
  missingLane.controls.lanes.pop();
  const laneReport = buildPrimitiveBreakdownReport(missingLane, [], gpuGate);
  assert.equal(laneReport.status, "FAIL");
  assert.equal(laneReport.exitCode, 1);
  assert.match(laneReport.failures.join("\n"), /missing control lane/);

  const runtimeRaw = structuredClone(goodRaw);
  runtimeRaw.pageErrors.push("synthetic page error");
  runtimeRaw.localRequestFailures.push("synthetic request failure");
  runtimeRaw.renderErrors.push("synthetic render error");
  const runtimeReport = buildPrimitiveBreakdownReport(
    runtimeRaw,
    ["synthetic console error"],
    {
      armedDevices: 1,
      errors: ["synthetic GPU error"],
      deviceLost: "synthetic device loss",
    },
  );
  assert.equal(runtimeReport.status, "FAIL");
  assert.equal(runtimeReport.exitCode, 1);
  assert.deepEqual(runtimeReport.errors, {
    console: ["synthetic console error"],
    page: ["synthetic page error"],
    localRequestFailures: ["synthetic request failure"],
    render: ["synthetic render error"],
    gpu: ["synthetic GPU error"],
    deviceLost: "synthetic device loss",
    fatal: null,
  });

  const inPageFatal = structuredClone(goodRaw);
  inPageFatal.inPageFatal = "synthetic in-page fatal";
  const inPageFatalReport = buildPrimitiveBreakdownReport(
    inPageFatal,
    [],
    gpuGate,
  );
  assert.equal(inPageFatalReport.status, "ERROR");
  assert.equal(inPageFatalReport.exitCode, 2);
  assert.equal(inPageFatalReport.errors.fatal, "synthetic in-page fatal");

  const outerFatalReport = buildPrimitiveBreakdownReport(
    goodRaw,
    [],
    gpuGate,
    "synthetic outer fatal",
  );
  assert.equal(outerFatalReport.status, "ERROR");
  assert.equal(outerFatalReport.exitCode, 2);
  assert.equal(outerFatalReport.errors.fatal, "synthetic outer fatal");
});

test("first-red policy is write-once for failures and preserves prior evidence", () => {
  const base = { path: "first-red.json", policy: "write-once" };
  const pass = applyPrimitiveFirstRedPolicy(
    { status: "PASS", exitCode: 0 },
    { ...base, existedBefore: false },
  );
  assert.deepEqual(pass.firstRed, {
    ...base,
    existedBefore: false,
    written: false,
    preserved: false,
  });
  const firstFailure = applyPrimitiveFirstRedPolicy(
    { status: "FAIL", exitCode: 1 },
    { ...base, existedBefore: false },
  );
  assert.equal(firstFailure.firstRed.written, true);
  assert.equal(firstFailure.firstRed.preserved, false);
  const laterFailure = applyPrimitiveFirstRedPolicy(
    { status: "FAIL", exitCode: 1 },
    { ...base, existedBefore: true },
  );
  assert.equal(laterFailure.firstRed.written, false);
  assert.equal(laterFailure.firstRed.preserved, true);
});

test("Viewport seams are sequential and keep dynamic drain outside traversal", () => {
  const start = viewportSource.indexOf("function updateAndRenderPrimitives(");
  const end = viewportSource.indexOf("const scratchEyeTranslation", start);
  const body = viewportSource.slice(start, end);
  const collectionBegin = body.indexOf(
    "beginEnvironmentMapUpdateCollection?.()",
  );
  const ground = body.indexOf("scene._groundPrimitives.update(frameState)");
  const ordinary = body.indexOf("scene._primitives.update(frameState)");
  const collectionEnd = body.indexOf("endEnvironmentMapUpdateCollection()");
  const drain = body.indexOf("drainEnvironmentMapUpdates(");
  const drainComputeMarker = body.lastIndexOf(
    'setCpuScenePhase(scene, "computeShadows")',
    drain,
  );
  const drainPrimitiveRestore = body.indexOf(
    'setCpuScenePhase(scene, "primitiveTraversal")',
    drain,
  );
  const shadowComputeMarker = body.indexOf(
    'setCpuScenePhase(scene, "computeShadows")',
    drainPrimitiveRestore + 1,
  );
  const shadows = body.indexOf("updateShadowMaps(scene)");
  const globePrimitiveRestore = body.indexOf(
    'setCpuScenePhase(scene, "primitiveTraversal")',
    shadows,
  );
  const globe = body.indexOf("scene._globe.render(frameState)");
  assert.ok(
    start >= 0 &&
      end > start &&
      collectionBegin >= 0 &&
      ground >= 0 &&
      ordinary >= 0 &&
      collectionEnd >= 0 &&
      drainComputeMarker >= 0 &&
      drain >= 0 &&
      drainPrimitiveRestore >= 0 &&
      shadowComputeMarker >= 0 &&
      shadows >= 0 &&
      globePrimitiveRestore >= 0 &&
      globe >= 0 &&
      collectionBegin < ground &&
      ground < ordinary &&
      ordinary < collectionEnd &&
      collectionEnd < drainComputeMarker &&
      drainComputeMarker < drain &&
      drain < drainPrimitiveRestore &&
      drainPrimitiveRestore < shadowComputeMarker &&
      shadowComputeMarker < shadows &&
      shadows < globePrimitiveRestore &&
      globePrimitiveRestore < globe,
  );
});

test("probe configuration is exact, bounded, and immutable", () => {
  assert.deepEqual(PRIMITIVE_BREAKDOWN_CONFIG, {
    viewport: { width: 1280, height: 720 },
    measureFrames: 120,
    primeFramesPerWaypoint: 5,
    routeStartPrimeFrames: 18,
    controlPairs: 12,
    injectedMs: 8,
    detailEpsilonMs: 0.05,
    controlTargetMinRatio: 0.625,
    controlOffTargetMaxRatio: 0.25,
    minProfiledFrameRatio: 0.85,
    watchdogMs: 240_000,
  });
  assert.equal(Object.isFrozen(PRIMITIVE_BREAKDOWN_CONFIG), true);
});

test("probe is bounded, Tools-only, and fail-closed before browser launch", () => {
  assert.match(probeSource, /c11-169-primitive-traversal-breakdown\.json/);
  assert.doesNotMatch(
    probeSource,
    /c11-169-whole-frame-phase-attribution\.json/,
  );
  assert.match(probeSource, /status: "RUNNING"/);
  assert.match(probeSource, /policy: "write-once"/);
  assert.match(
    probeSource,
    /fs\.writeFileSync\(OUTPUT_PATH,[\s\S]*?runBrowserProbe\(\)/,
  );
  assert.match(probeSource, /restoreWrappers\(\)/);
  assert.match(probeSource, /renderer\.setCpuPassProfiling\(false\)/);
  assert.equal(PRIMITIVE_DETAIL_CONTROL_SPECS.length, 4);
  assert.equal(Object.isFrozen(PRIMITIVE_DETAIL_NAMES), true);

  const installPatterns = [
    /installTimedWrapper\(\s*scene\._groundPrimitives,\s*"update",\s*"groundPrimitiveUpdate",\s*"scene\._groundPrimitives",\s*\)/,
    /installTimedWrapper\(\s*scene\._primitives,\s*"update",\s*"ordinaryPrimitiveUpdate",\s*"scene\._primitives",\s*\)/,
    /installTimedWrapper\(\s*scene\.frameState\.context,\s*"drainEnvironmentMapUpdates",\s*"dynamicEnvironmentDrain",\s*"frameState\.context",\s*\)/,
    /installTimedWrapper\(\s*scene\._globe,\s*"render",\s*"globeRender",\s*"scene\._globe",\s*\)/,
  ];
  let previousIndex = -1;
  for (const pattern of installPatterns) {
    const index = probeSource.search(pattern);
    assert.ok(index > previousIndex, `missing or reordered ${pattern}`);
    previousIndex = index;
  }
});
