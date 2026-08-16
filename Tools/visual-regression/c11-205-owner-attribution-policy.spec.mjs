// @purpose Contract + mutants for C11-205 owner-attribution evidence: collector, lock records, first-red decisions, pair comparability, runner wiring.
// @status ACTIVE

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assessC11205OwnerAttribution,
  C11_205_OWNER_ATTRIBUTION_CONFIG,
  C11_205_OWNER_DETAIL_NAMES,
  C11_205_SCENE_PHASE_NAMES,
  createC11205OwnerAttributionCollector,
  createC11205OwnerAttributionLockRecord,
  createC11205OwnerAttributionRunningMarker,
  evaluateC11205OwnerAttributionConfig,
  ownerAttributionFirstRedLookupDecision,
  ownerAttributionFirstRedDecision,
  ownsC11205OwnerAttributionLock,
} from "./lib/c11-205-owner-attribution.mjs";
import {
  assessPerformanceRunQuality,
  assessRepresentativePairComparability,
} from "./lib/performance-campaign-utils.mjs";
import { GLOBE_CAMERA_TRACK } from "./lib/globe-camera-track.mjs";
import { createRepresentativeWorkloadFingerprintAccumulator } from "./lib/representative-performance-content.mjs";

const runnerSource = await readFile(
  new URL("./run-performance-campaign.mjs", import.meta.url),
  "utf8",
);
const helperSource = await readFile(
  new URL("./lib/c11-205-owner-attribution.mjs", import.meta.url),
  "utf8",
);
const cesiumWidgetSource = await readFile(
  new URL(
    "../../packages/engine/Source/Widget/CesiumWidget.js",
    import.meta.url,
  ),
  "utf8",
);
const warmManifest = JSON.parse(
  await readFile(
    new URL(
      "./performance-workloads-representative-warm.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const ownerAttributionFrames = C11_205_OWNER_ATTRIBUTION_CONFIG.measuredFrames;
const ownerAttributionSegmentCount =
  C11_205_OWNER_ATTRIBUTION_CONFIG.expectedTrackWaypoints - 1;
const ownerAttributionSamplesPerSegment =
  ownerAttributionFrames / ownerAttributionSegmentCount;

function expectedOwnerRouteState(index) {
  const routeProgress =
    ownerAttributionFrames <= 1 ? 0 : index / (ownerAttributionFrames - 1);
  const scaledSegmentProgress = routeProgress * ownerAttributionSegmentCount;
  const segmentIndex = Math.min(
    ownerAttributionSegmentCount - 1,
    Math.floor(scaledSegmentProgress),
  );
  return {
    routeProgress,
    segmentIndex,
    segmentProgress: scaledSegmentProgress - segmentIndex,
  };
}

function exactConfigInput() {
  return {
    manifest: structuredClone(warmManifest),
    workload: structuredClone(warmManifest.workloads[0]),
    options: {
      renderer: "both",
      frames: ownerAttributionFrames,
      apiInstrumentation: false,
      gpuTimestamps: false,
      reuseBrowser: false,
      headed: false,
    },
    repetitions: 2,
    selectedWorkloadIds: [C11_205_OWNER_ATTRIBUTION_CONFIG.workloadId],
    manifestRelativePath: C11_205_OWNER_ATTRIBUTION_CONFIG.manifestFile,
    outputRelativePath: C11_205_OWNER_ATTRIBUTION_CONFIG.diagnosticOutput,
    manifestSha256: C11_205_OWNER_ATTRIBUTION_CONFIG.manifestSha256,
    causalReferenceRelativePath:
      C11_205_OWNER_ATTRIBUTION_CONFIG.causalReference,
    causalReferenceSha256:
      C11_205_OWNER_ATTRIBUTION_CONFIG.causalReferenceSha256,
  };
}

test("CPU owner mode accepts only the exact resident r2x600 configuration", () => {
  assert.equal(ownerAttributionFrames, 600);
  assert.equal(
    C11_205_OWNER_ATTRIBUTION_CONFIG.expectedTrackWaypoints,
    GLOBE_CAMERA_TRACK.length,
  );
  assert.equal(ownerAttributionSegmentCount, 8);
  assert.equal(ownerAttributionSamplesPerSegment, 75);
  assert.equal(warmManifest.protocol.measuredFrames, ownerAttributionFrames);
  assert.equal(
    warmManifest.workloads[0].measuredFrames,
    ownerAttributionFrames,
  );
  assert.equal(
    warmManifest.workloads[0].representativeConfig.routePrimeSamples,
    ownerAttributionFrames,
  );
  assert.deepEqual(evaluateC11205OwnerAttributionConfig(exactConfigInput()), {
    pass: true,
    failures: [],
    diagnostic: true,
    noncausal: true,
    certificationEligible: false,
  });

  const mutants = [
    ["manifest path", (value) => (value.manifestRelativePath = "other.json")],
    ["output path", (value) => (value.outputRelativePath = "latest.json")],
    ["manifest hash", (value) => (value.manifestSha256 = "BAD")],
    [
      "causal path",
      (value) => (value.causalReferenceRelativePath = "replacement.json"),
    ],
    ["causal hash", (value) => (value.causalReferenceSha256 = "BAD")],
    ["manifest id", (value) => (value.manifest.id = "same-shape-other")],
    ["renderer", (value) => (value.options.renderer = "webgpu")],
    ["workload", (value) => (value.selectedWorkloadIds = ["other"])],
    ["repetitions", (value) => (value.repetitions = 1)],
    ["frames", (value) => (value.options.frames = ownerAttributionFrames - 1)],
    [
      "API instrumentation",
      (value) => (value.options.apiInstrumentation = true),
    ],
    ["timestamps", (value) => (value.options.gpuTimestamps = true)],
    ["browser reuse", (value) => (value.options.reuseBrowser = true)],
    ["headed", (value) => (value.options.headed = true)],
    ["viewport", (value) => (value.manifest.protocol.viewport.width = 1279)],
    ["resolution", (value) => (value.manifest.protocol.resolutionScale = 0.5)],
    [
      "protocol frames",
      (value) =>
        (value.manifest.protocol.measuredFrames = ownerAttributionFrames - 1),
    ],
    ["clock", (value) => (value.manifest.protocol.fixedClock = "other")],
    [
      "resident",
      (value) => {
        value.workload.representativeConfig.measurementTerrainMode =
          "streaming";
      },
    ],
    [
      "route prime",
      (value) => {
        value.workload.representativeConfig.routePrimeSamples =
          ownerAttributionFrames - 1;
      },
    ],
    [
      "workload frames",
      (value) => (value.workload.measuredFrames = ownerAttributionFrames - 1),
    ],
    [
      "direct models",
      (value) => {
        value.workload.representativeConfig.models.rows = 5;
      },
    ],
    [
      "tilesets",
      (value) => {
        value.workload.representativeConfig.tilesets.columns = 1;
      },
    ],
  ];
  for (const [name, mutate] of mutants) {
    const input = exactConfigInput();
    mutate(input);
    assert.equal(evaluateC11205OwnerAttributionConfig(input).pass, false, name);
  }
});

class FakeEvent {
  #listeners = [];

  addEventListener(listener) {
    this.#listeners.push(listener);
    return () => {
      this.#listeners = this.#listeners.filter((entry) => entry !== listener);
    };
  }

  raiseEvent(...args) {
    for (const listener of [...this.#listeners]) listener(...args);
  }

  get listenerCount() {
    return this.#listeners.length;
  }
}

function assertExactOwnerMeasurementProgress(progress) {
  assert.equal(progress.length, ownerAttributionFrames);
  for (let index = 0; index < ownerAttributionFrames; index++) {
    assert.equal(
      progress[index],
      index / (ownerAttributionFrames - 1),
      "route progress " + index,
    );
  }
  assert.equal(progress[0], 0);
  assert.equal(progress.at(-1), 1);
  assert.equal(new Set(progress).size, ownerAttributionFrames);
}

function runFakeOwnerMeasurement({
  siblingOrder,
  observedFrames = ownerAttributionFrames,
  cursorFrameLimit = ownerAttributionFrames,
  progressIndex = (index) => index,
  cursorRemovalThrows = false,
  retainEvidenceAfterStop = false,
} = {}) {
  assert.ok(siblingOrder === "action-first" || siblingOrder === "viewer-first");
  const clockTick = new FakeEvent();
  const postRender = new FakeEvent();
  const measuredProgress = [];
  let cursorRunning = true;
  let actionRunning = true;
  let cursorFrameIndex = 0;
  let siblingFrameIndex = 1;
  let currentProgress = 0;
  let actionFrames = 0;
  let cameraTrackUpdates = 0;
  let suppressedSiblingCallbacks = 0;

  const removeCursorListener = clockTick.addEventListener(() => {
    if (!cursorRunning || cursorFrameIndex >= cursorFrameLimit) return;
    const frameIndex = progressIndex(cursorFrameIndex++);
    currentProgress = frameIndex / (ownerAttributionFrames - 1);
    actionFrames++;
    cameraTrackUpdates++;
  });
  const removeEvidenceListener = postRender.addEventListener(() => {
    measuredProgress.push(currentProgress);
  });
  const runSiblingAction = () => {
    if (!actionRunning) return;
    if (cursorRunning) {
      suppressedSiblingCallbacks++;
      return;
    }
    currentProgress = Math.min(
      1,
      siblingFrameIndex++ / (ownerAttributionFrames - 1),
    );
    actionFrames++;
    cameraTrackUpdates++;
  };
  const renderViewerFrame = () => {
    clockTick.raiseEvent();
    postRender.raiseEvent();
  };

  for (let index = 0; index < observedFrames; index++) {
    if (siblingOrder === "action-first") runSiblingAction();
    renderViewerFrame();
    if (siblingOrder === "viewer-first") runSiblingAction();
  }

  cursorRunning = false;
  try {
    if (cursorRemovalThrows) {
      throw new Error("injected cursor-removal failure");
    }
    removeCursorListener();
  } catch {
    // Mirrors the production cursor's non-blocking teardown contract.
  }
  actionRunning = false;
  if (!retainEvidenceAfterStop) removeEvidenceListener();
  const remainingCleanupRan = true;

  // A late tick/render must not mutate or append after the boundary. When
  // removal itself failed, the running guard still makes the cursor inert.
  clockTick.raiseEvent();
  postRender.raiseEvent();

  return {
    measuredProgress,
    actionFrames,
    cameraTrackUpdates,
    suppressedSiblingCallbacks,
    remainingCleanupRan,
    clockListenerCount: clockTick.listenerCount,
    evidenceListenerCount: postRender.listenerCount,
  };
}

async function fakeYieldingOwnerHelperImport(evidenceBeforeImport) {
  const postRender = new FakeEvent();
  const evidence = [];
  const installEvidence = () =>
    postRender.addEventListener(() => evidence.push("observed"));
  let removeEvidence;
  if (evidenceBeforeImport) removeEvidence = installEvidence();
  await Promise.resolve().then(() => postRender.raiseEvent());
  if (!evidenceBeforeImport) removeEvidence = installEvidence();
  removeEvidence();
  return evidence;
}

function assertOwnerCursorSourceContract(source) {
  const importMarker =
    'await import("/Tools/visual-regression/lib/c11-205-owner-attribution.mjs")';
  const counterSnapshotMarker =
    "const actionCountersStart = { ...actionCounters };";
  const evidenceMarker = "const removeActionEvidence =";
  const startCallMarker =
    "          startCpuOwnerAttributionMeasurementCursor();";
  const traceMarker = "        scene.beginPerformanceTrace(";
  const importIndex = source.indexOf(importMarker);
  const evidenceIndex = source.indexOf(evidenceMarker);
  const startCallIndex = source.indexOf(startCallMarker);
  const traceIndex = source.indexOf(traceMarker, startCallIndex);
  assert.ok(importIndex >= 0, "owner helper import is present");
  assert.ok(
    importIndex < source.indexOf(counterSnapshotMarker),
    "owner helper precedes measured counter snapshots",
  );
  assert.ok(importIndex < evidenceIndex, "owner helper precedes evidence");
  assert.ok(evidenceIndex < startCallIndex, "evidence precedes cursor start");
  assert.ok(startCallIndex < traceIndex, "cursor starts at trace boundary");
  assert.doesNotMatch(
    source.slice(evidenceIndex, startCallIndex),
    /\bawait\s/,
    "no yield exists between listener installation and cursor start",
  );
  assert.match(
    source.slice(
      source.lastIndexOf("if (cpuOwnerAttributionEnabled)", importIndex),
      evidenceIndex,
    ),
    /if \(cpuOwnerAttributionEnabled\) \{[\s\S]*?ownerAttributionModule =\s+await import\("\/Tools\/visual-regression\/lib\/c11-205-owner-attribution\.mjs"\)/,
    "default-off mode never imports the owner helper",
  );
  assert.match(
    source,
    /let cpuOwnerAttributionMeasurementCursorRunning = false;/,
    "default-off mode leaves the ordinary action rAF enabled",
  );
  assert.match(
    source,
    /const startCpuOwnerAttributionMeasurementCursor = \(\) => \{\s+if \(!cpuOwnerAttributionEnabled\) return;/,
  );
  assert.match(
    source,
    /actionRunning &&\s+!cpuOwnerAttributionMeasurementCursorRunning/,
    "the sibling action rAF is suppressed while the owner cursor runs",
  );
  assert.match(
    source,
    /viewer\.clock\.onTick\.addEventListener\(\(\) => \{[\s\S]*?frameIndex \/ \(measuredFrameCount - 1\);[\s\S]*?actionCounters\.frames\+\+;[\s\S]*?actionCounters\.cameraTrackUpdates\+\+;/,
    "the cursor applies the exact fixed-frame formula outside Scene.render",
  );
  assert.match(
    source,
    /const stopCpuOwnerAttributionMeasurementCursor = \(\) => \{\s+cpuOwnerAttributionMeasurementCursorRunning = false;[\s\S]*?const remove = removeCpuOwnerAttributionMeasurementCursor;\s+removeCpuOwnerAttributionMeasurementCursor = null;\s+try \{\s+remove\?\.\(\);\s+\} catch \{/,
    "cursor removal is idempotent and cannot block remaining cleanup",
  );

  const waitCatchIndex = source.indexOf("} catch (measurementWaitError) {");
  const catchCursorStopIndex = source.indexOf(
    "stopCpuOwnerAttributionMeasurementCursor();",
    waitCatchIndex,
  );
  const catchActionStopIndex = source.indexOf(
    "stopActionLoop();",
    waitCatchIndex,
  );
  assert.ok(waitCatchIndex >= 0);
  assert.ok(catchCursorStopIndex > waitCatchIndex);
  assert.ok(catchCursorStopIndex < catchActionStopIndex);

  const successBoundaryIndex = source.indexOf(
    "const measurementEndMs = performance.now();",
  );
  const successCursorStopIndex = source.indexOf(
    "stopCpuOwnerAttributionMeasurementCursor();",
    successBoundaryIndex,
  );
  const successActionStopIndex = source.indexOf(
    "stopActionLoop();",
    successBoundaryIndex,
  );
  assert.ok(successBoundaryIndex >= 0);
  assert.ok(successCursorStopIndex > successBoundaryIndex);
  assert.ok(successCursorStopIndex < successActionStopIndex);
  assert.match(
    source.slice(startCallIndex - 600, startCallIndex),
    /performanceCampaignCleanup\.add\(\s+stopCpuOwnerAttributionMeasurementCursor,\s+\);/,
    "outer teardown owns cursor cleanup after every later error",
  );
}

function assertViewerClockTickPrecedesSceneRender(source) {
  assert.match(
    source,
    /const currentTime = this\._clock\.tick\(\);\s+this\._scene\.render\(currentTime\);/,
    "CesiumWidget must raise clock.onTick before Scene.render",
  );
}

test("owner measurement cursor is exact for both sibling rAF callback orders", () => {
  for (const siblingOrder of ["action-first", "viewer-first"]) {
    const result = runFakeOwnerMeasurement({ siblingOrder });
    assertExactOwnerMeasurementProgress(result.measuredProgress);
    assert.equal(result.actionFrames, ownerAttributionFrames, siblingOrder);
    assert.equal(
      result.cameraTrackUpdates,
      ownerAttributionFrames,
      siblingOrder,
    );
    assert.equal(
      result.suppressedSiblingCallbacks,
      ownerAttributionFrames,
      siblingOrder,
    );
    assert.equal(result.remainingCleanupRan, true, siblingOrder);
    assert.equal(result.clockListenerCount, 0, siblingOrder);
    assert.equal(result.evidenceListenerCount, 0, siblingOrder);
  }
});

test("owner measurement cursor policy kills phase and boundary mutants", () => {
  const mutants = [
    [
      "duplicate zero",
      runFakeOwnerMeasurement({
        siblingOrder: "action-first",
        progressIndex: (index) => Math.max(0, index - 1),
      }).measuredProgress,
    ],
    [
      "missing endpoint",
      runFakeOwnerMeasurement({
        siblingOrder: "viewer-first",
        cursorFrameLimit: ownerAttributionFrames - 1,
      }).measuredProgress,
    ],
    [
      "601st observation",
      runFakeOwnerMeasurement({
        siblingOrder: "action-first",
        observedFrames: ownerAttributionFrames + 1,
      }).measuredProgress,
    ],
    [
      "retained post-boundary evidence listener",
      runFakeOwnerMeasurement({
        siblingOrder: "viewer-first",
        retainEvidenceAfterStop: true,
      }).measuredProgress,
    ],
  ];
  for (const [name, progress] of mutants) {
    assert.throws(
      () => assertExactOwnerMeasurementProgress(progress),
      undefined,
      name,
    );
  }
});

test("owner helper preload cannot leak a yielded render into evidence", async () => {
  assert.deepEqual(await fakeYieldingOwnerHelperImport(false), []);
  assert.deepEqual(await fakeYieldingOwnerHelperImport(true), ["observed"]);
});

test("owner cursor cleanup remains non-blocking when event removal throws", () => {
  const result = runFakeOwnerMeasurement({
    siblingOrder: "action-first",
    cursorRemovalThrows: true,
  });
  assertExactOwnerMeasurementProgress(result.measuredProgress);
  assert.equal(result.remainingCleanupRan, true);
  assert.equal(result.clockListenerCount, 1);
  assert.equal(result.evidenceListenerCount, 0);
  assert.equal(result.actionFrames, ownerAttributionFrames);
  assert.equal(result.cameraTrackUpdates, ownerAttributionFrames);
});

test("runner owner cursor lifecycle is fail-closed under source mutants", () => {
  assertOwnerCursorSourceContract(runnerSource);

  const importMarker =
    'await import("/Tools/visual-regression/lib/c11-205-owner-attribution.mjs")';
  const evidenceMarker = "const removeActionEvidence =";
  const importMovedAfterEvidence = runnerSource
    .replace(
      importMarker,
      'import("/Tools/visual-regression/lib/c11-205-owner-attribution.mjs")',
    )
    .replace(evidenceMarker, evidenceMarker + "\n" + importMarker);
  assert.notEqual(importMovedAfterEvidence, runnerSource);
  assert.throws(() =>
    assertOwnerCursorSourceContract(importMovedAfterEvidence),
  );

  const waitCatchIndex = runnerSource.indexOf(
    "} catch (measurementWaitError) {",
  );
  const catchCursorStopIndex = runnerSource.indexOf(
    "stopCpuOwnerAttributionMeasurementCursor();",
    waitCatchIndex,
  );
  const missingErrorCleanup =
    runnerSource.slice(0, catchCursorStopIndex) +
    runnerSource.slice(
      catchCursorStopIndex +
        "stopCpuOwnerAttributionMeasurementCursor();".length,
    );
  assert.notEqual(missingErrorCleanup, runnerSource);
  assert.throws(() => assertOwnerCursorSourceContract(missingErrorCleanup));

  const unsuppressedSibling = runnerSource.replace(
    "actionRunning && !cpuOwnerAttributionMeasurementCursorRunning",
    "actionRunning",
  );
  assert.notEqual(unsuppressedSibling, runnerSource);
  assert.throws(() => assertOwnerCursorSourceContract(unsuppressedSibling));

  const blockingRemoval = runnerSource.replace(
    /try \{\r?\n\s+remove\?\.\(\);\r?\n\s+\} catch \{/,
    "remove?.();",
  );
  assert.notEqual(blockingRemoval, runnerSource);
  assert.throws(() => assertOwnerCursorSourceContract(blockingRemoval));

  const defaultOnCursor = runnerSource.replace(
    "let cpuOwnerAttributionMeasurementCursorRunning = false;",
    "let cpuOwnerAttributionMeasurementCursorRunning = true;",
  );
  assert.notEqual(defaultOnCursor, runnerSource);
  assert.throws(() => assertOwnerCursorSourceContract(defaultOnCursor));
});

test("CesiumWidget raises owner cursor tick outside Scene.render", () => {
  assertViewerClockTickPrecedesSceneRender(cesiumWidgetSource);
  const reversedOrder = cesiumWidgetSource.replace(
    /const currentTime = this\._clock\.tick\(\);\r?\n\s+this\._scene\.render\(currentTime\);/,
    "this._scene.render(this._clock.currentTime);\n    const currentTime = this._clock.tick();",
  );
  assert.notEqual(reversedOrder, cesiumWidgetSource);
  assert.throws(() => assertViewerClockTickPrecedesSceneRender(reversedOrder));
});

function fakeLastFrame(sequence, sceneFrameNumber) {
  const phaseMs = Object.fromEntries(
    C11_205_SCENE_PHASE_NAMES.map((name) => [name, 1]),
  );
  phaseMs.sceneUpdate = 10;
  phaseMs.primitiveTraversal = 180;
  const totalMs = 219;
  const profiledPassMs = 20;
  const phaseTotalMs = 199;
  return {
    sequence,
    sceneFrameNumber,
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
  };
}

function fakeTimedWork() {
  let total = 0;
  for (let index = 0; index < 100; index++) total += Math.sqrt(index);
  return total;
}

function createFakeHarness(
  actualRenderer,
  {
    enableThrows = false,
    snapshotThrowsAfterEnable = false,
    disableThrows = false,
    restoreThrows = false,
    partialInstallFailure = false,
    duplicateModel = false,
    duplicateTileset = false,
    crossSetAlias = false,
    sceneOwnerAlias = false,
  } = {},
) {
  const postRender = new FakeEvent();
  const frameState = { frameNumber: 0 };
  const inheritedModelPrototype = { update: fakeTimedWork };
  const models = Array.from({ length: 48 }, () =>
    Object.create(inheritedModelPrototype),
  );
  const tilesets = Array.from({ length: 4 }, () => ({
    update: fakeTimedWork,
  }));

  if (duplicateModel) models[47] = models[0];
  if (duplicateTileset) tilesets[3] = tilesets[0];
  if (crossSetAlias) tilesets[3] = models[0];

  if (partialInstallFailure) {
    Object.defineProperty(models[7], "update", {
      value() {},
      writable: false,
      configurable: false,
    });
  }

  if (restoreThrows) {
    const target = models[0];
    const original = target.update;
    Object.defineProperty(target, "update", {
      value: original,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    models[0] = new Proxy(target, {
      defineProperty(object, property, descriptor) {
        if (property === "update" && descriptor.value === original) {
          throw new Error("injected restore failure");
        }
        return Reflect.defineProperty(object, property, descriptor);
      },
    });
  }

  const scene = {
    frameState,
    postRender,
    _groundPrimitives: { update: fakeTimedWork },
    _globe: { render: fakeTimedWork },
    _primitives: {
      update(currentFrameState) {
        for (const model of models) model.update(currentFrameState);
        for (const tileset of tilesets) tileset.update(currentFrameState);
      },
    },
  };
  if (sceneOwnerAlias) scene._groundPrimitives = models[0];
  const renderer = {
    enabled: false,
    last: null,
    setCpuPassProfiling(enabled) {
      if (enabled) {
        this.enabled = true;
        this.last = null;
        if (enableThrows) throw new Error("injected enable failure");
      } else {
        this.enabled = false;
        if (disableThrows) throw new Error("injected disable failure");
      }
    },
    getCpuPassProfile() {
      if (snapshotThrowsAfterEnable && this.enabled) {
        throw new Error("injected snapshot failure");
      }
      return {
        enabled: this.enabled,
        frameCount: this.last?.sequence ?? 0,
        frameAccounting: this.last
          ? { totalFrames: this.last.sequence, lastFrame: this.last }
          : null,
        lastFrame: this.last,
      };
    },
  };
  let routeState = {};
  const collector = createC11205OwnerAttributionCollector({
    scene,
    renderer: actualRenderer === "webgpu" ? renderer : null,
    actualRenderer,
    directModels: models,
    tilesets,
    metadataProvider: () => routeState,
  });
  return {
    collector,
    models,
    tilesets,
    renderer,
    scene,
    setRouteState(value) {
      routeState = value;
    },
  };
}

async function captureFakeRoute(actualRenderer) {
  const harness = createFakeHarness(actualRenderer);
  const originals = {
    ground: harness.scene._groundPrimitives.update,
    ordinary: harness.scene._primitives.update,
    globe: harness.scene._globe.render,
    models: harness.models.map((model) => model.update),
    modelOwn: harness.models.map((model) =>
      Object.prototype.hasOwnProperty.call(model, "update"),
    ),
    tilesets: harness.tilesets.map((tileset) => tileset.update),
  };
  harness.collector.start();
  const traceSamples = [];
  const trackEvidence = [];
  for (let index = 0; index < ownerAttributionFrames; index++) {
    const sceneFrameNumber = 1001 + index;
    const route = expectedOwnerRouteState(index);
    harness.setRouteState(route);
    harness.scene.frameState.frameNumber = sceneFrameNumber;
    harness.scene._groundPrimitives.update(harness.scene.frameState);
    harness.scene._primitives.update(harness.scene.frameState);
    harness.scene._globe.render(harness.scene.frameState);
    harness.scene.postRender.raiseEvent();
    if (actualRenderer === "webgpu") {
      harness.renderer.last = fakeLastFrame(index + 1, sceneFrameNumber);
    }
    traceSamples.push({ frameNumber: sceneFrameNumber, cpuMs: 200 });
    trackEvidence.push(route);
    // Deliberately leave the final capture queued. stop() must await that
    // postRender microtask before disabling the profiler.
    if (index < ownerAttributionFrames - 1) await Promise.resolve();
  }
  const raw = await harness.collector.stop();
  const secondStop = await harness.collector.stop({ aborted: true });
  assert.strictEqual(secondStop, raw, "stop must be idempotent");
  assert.equal(harness.scene._groundPrimitives.update, originals.ground);
  assert.equal(harness.scene._primitives.update, originals.ordinary);
  assert.equal(harness.scene._globe.render, originals.globe);
  for (let index = 0; index < harness.models.length; index++) {
    assert.equal(harness.models[index].update, originals.models[index]);
    assert.equal(
      Object.prototype.hasOwnProperty.call(harness.models[index], "update"),
      originals.modelOwn[index],
    );
  }
  for (let index = 0; index < harness.tilesets.length; index++) {
    assert.equal(harness.tilesets[index].update, originals.tilesets[index]);
  }
  return { raw, traceSamples, trackEvidence };
}

test("WebGL captures exact owner frames without synthesizing phases", async () => {
  const capture = await captureFakeRoute("webgl");
  const assessment = assessC11205OwnerAttribution(capture.raw, capture);
  assert.equal(assessment.pass, true, assessment.failures.join("\n"));
  assert.equal(capture.raw.phaseAccounting.available, false);
  assert.equal(capture.raw.profiler.applicable, false);
  assert.deepEqual(assessment.alignment.routeBinding, {
    waypointCount: C11_205_OWNER_ATTRIBUTION_CONFIG.expectedTrackWaypoints,
    segmentCount: ownerAttributionSegmentCount,
    expectedSamplesPerSegment: ownerAttributionSamplesPerSegment,
    ownerSegmentSampleCounts: Array(ownerAttributionSegmentCount).fill(
      ownerAttributionSamplesPerSegment,
    ),
    routeSegmentSampleCounts: Array(ownerAttributionSegmentCount).fill(
      ownerAttributionSamplesPerSegment,
    ),
  });
  assert.deepEqual(
    Object.keys(capture.raw.frames[0].detailMs),
    C11_205_OWNER_DETAIL_NAMES,
  );
  assert.equal("phaseMs" in capture.raw.frames[0], false);

  const forbiddenFrameFields = [
    "structuralError",
    "sequence",
    "sceneFrameNumber",
    "kind",
    "totalMs",
    "profiledPassMs",
    "unaccountedMs",
    "overlapMs",
    "coverageRatio",
    "valid",
    "passMs",
    "phaseAttributionEnabled",
    "phaseMs",
    "phaseTotalMs",
    "unattributedMs",
    "attributionOverlapMs",
    "attributionValid",
  ];
  for (const field of forbiddenFrameFields) {
    const raw = structuredClone(capture.raw);
    raw.frames[0][field] = field.endsWith("Ms") ? 0 : true;
    assert.equal(
      assessC11205OwnerAttribution(raw, capture).pass,
      false,
      `WebGL accepted synthetic profiler field ${field}`,
    );
  }
  for (const field of ["before", "start", "end", "after"]) {
    const raw = structuredClone(capture.raw);
    raw.profiler[field] = { enabled: false };
    assert.equal(
      assessC11205OwnerAttribution(raw, capture).pass,
      false,
      `WebGL accepted synthetic profiler.${field}`,
    );
  }
});

test("WebGPU final microtask binds exact lastFrame before profiler cleanup", async () => {
  const capture = await captureFakeRoute("webgpu");
  const assessment = assessC11205OwnerAttribution(capture.raw, capture);
  assert.equal(assessment.pass, true, assessment.failures.join("\n"));
  assert.equal(capture.raw.frames[0].sequence, 1);
  assert.equal(capture.raw.frames.at(-1).sequence, ownerAttributionFrames);
  assert.equal(
    capture.raw.frames.at(-1).sceneFrameNumber,
    1000 + ownerAttributionFrames,
  );
  assert.equal(capture.raw.profiler.after.enabled, false);
  assert.equal(
    capture.raw.captureDiagnostics.microtasksCompleted,
    ownerAttributionFrames,
  );
});

test("collector rolls back enable, snapshot, partial-install, disable, and restore failures", async () => {
  for (const options of [
    { enableThrows: true },
    { snapshotThrowsAfterEnable: true },
    { partialInstallFailure: true },
    { duplicateModel: true },
    { duplicateTileset: true },
    { crossSetAlias: true },
    { sceneOwnerAlias: true },
  ]) {
    const harness = createFakeHarness("webgpu", options);
    const ground = harness.scene._groundPrimitives.update;
    assert.throws(() => harness.collector.start());
    assert.equal(harness.scene._groundPrimitives.update, ground);
    assert.equal(harness.renderer.enabled, false);
  }

  const disable = createFakeHarness("webgpu", { disableThrows: true });
  disable.collector.start();
  const disabledRaw = await disable.collector.stop();
  assert.ok(
    disabledRaw.cleanup.errors.some((entry) => entry.includes("disable")),
  );
  assert.equal(assessC11205OwnerAttribution(disabledRaw, {}).pass, false);

  const restore = createFakeHarness("webgl", { restoreThrows: true });
  restore.collector.start();
  const restoredRaw = await restore.collector.stop();
  assert.ok(
    restoredRaw.cleanup.errors.some((entry) => entry.includes("restore")),
  );
  assert.equal(
    restoredRaw.instrumentation.targets.filter(
      (target) => target.restoredExact !== true,
    ).length,
    1,
  );
});

test("owner assessment fails closed on schema, target, ledger, and capture mutants", async () => {
  const capture = await captureFakeRoute("webgpu");
  const mutants = [
    ["schema", (raw) => delete raw.schemaVersion],
    ["mode", (raw) => (raw.mode = "other")],
    ["aborted", (raw) => delete raw.aborted],
    ["expected", (raw) => (raw.expected.frames = ownerAttributionFrames - 1)],
    [
      "target order",
      (raw) => {
        [raw.instrumentation.targets[0], raw.instrumentation.targets[1]] = [
          raw.instrumentation.targets[1],
          raw.instrumentation.targets[0],
        ];
      },
    ],
    [
      "per-target skipped plus duplicated hit",
      (raw) => {
        raw.frames[0].targetHits[2] = 0;
        raw.frames[0].targetHits[3] = 2;
      },
    ],
    [
      "out-of-ordinary nested owner",
      (raw) => raw.frames[0].outOfOrdinaryPrimitiveCalls++,
    ],
    [
      "missing microtask",
      (raw) => raw.captureDiagnostics.microtasksCompleted--,
    ],
    ["microtask error", (raw) => raw.captureDiagnostics.errors.push("boom")],
    ["duplicate", (raw) => raw.captureDiagnostics.duplicateSceneFrames++],
    ["NaN profiled", (raw) => (raw.frames[0].profiledPassMs = Number.NaN)],
    ["negative profiled", (raw) => (raw.frames[0].profiledPassMs = -1)],
    ["NaN coverage", (raw) => (raw.frames[0].coverageRatio = Number.NaN)],
    ["coverage semantics", (raw) => (raw.frames[0].coverageRatio = 1)],
    ["profiler applicability", (raw) => (raw.profiler.applicable = false)],
    ["phase schema", (raw) => delete raw.frames[0].phaseMs.sceneUpdate],
    ["route", (raw) => (raw.frames[0].routeProgress = 0.25)],
    [
      "missing segment metadata",
      (raw, context) => {
        delete raw.frames[0].segmentIndex;
        delete raw.frames[0].segmentProgress;
        delete context.trackEvidence[0].segmentIndex;
        delete context.trackEvidence[0].segmentProgress;
      },
      /owner segmentIndex is not an integer/,
    ],
    [
      "wrong owner segment index",
      (raw) => (raw.frames[0].segmentIndex = 1),
      /owner\/route segmentIndex did not match exactly/,
    ],
    [
      "wrong owner segment progress",
      (raw) => (raw.frames[0].segmentProgress = 0.5),
      /owner\/route segmentProgress did not match exactly/,
    ],
    [
      "wrong shared endpoint segment progress",
      (raw, context) => {
        raw.frames.at(-1).segmentProgress = 0;
        context.trackEvidence.at(-1).segmentProgress = 0;
      },
      /segmentProgress did not match the 9-waypoint route formula/,
    ],
    [
      "wrong segment population",
      (raw, context) => {
        raw.frames[ownerAttributionSamplesPerSegment].segmentIndex = 0;
        context.trackEvidence[ownerAttributionSamplesPerSegment].segmentIndex =
          0;
      },
      /owner segment\[0\] population 76 != 75[\s\S]*route segment\[0\] population 76 != 75/,
    ],
    ["trace frame", (_raw, context) => context.traceSamples[0].frameNumber++],
    ["trace CPU", (_raw, context) => delete context.traceSamples[0].cpuMs],
    [
      "trace/profile nesting",
      (_raw, context) => {
        context.traceSamples[0].cpuMs = 1000;
      },
    ],
    [
      "all named passes zero",
      (raw) => {
        for (const frame of raw.frames) {
          frame.passMs = {};
          frame.profiledPassMs = 0;
          frame.phaseMs.sceneUpdate = 30;
          frame.phaseTotalMs = 219;
          frame.totalMs = 219;
          frame.unaccountedMs = 219;
          frame.coverageRatio = 0;
        }
      },
    ],
    [
      "90 percent positive named-pass boundary",
      (raw) => {
        const minimumPositiveFrames = Math.ceil(ownerAttributionFrames * 0.9);
        for (
          let index = minimumPositiveFrames - 1;
          index < raw.frames.length;
          index++
        ) {
          const frame = raw.frames[index];
          frame.passMs = {};
          frame.profiledPassMs = 0;
          frame.phaseMs.sceneUpdate = 30;
          frame.phaseTotalMs = 219;
          frame.totalMs = 219;
          frame.unaccountedMs = 219;
          frame.coverageRatio = 0;
        }
      },
    ],
    [
      "one phase always zero",
      (raw) => {
        for (const frame of raw.frames) {
          frame.phaseMs.contextBegin = 0;
          frame.phaseTotalMs = 198;
          frame.totalMs = 218;
          frame.unaccountedMs = 198;
          frame.coverageRatio = 20 / 218;
        }
      },
    ],
    [
      "one owner always zero",
      (raw) => {
        for (const frame of raw.frames) {
          frame.detailMs.directModelUpdate = 0;
        }
      },
    ],
  ];
  for (const [name, mutate, expectedFailure] of mutants) {
    const raw = structuredClone(capture.raw);
    const context = {
      traceSamples: structuredClone(capture.traceSamples),
      trackEvidence: structuredClone(capture.trackEvidence),
    };
    mutate(raw, context);
    const assessment = assessC11205OwnerAttribution(raw, context);
    assert.equal(assessment.pass, false, name);
    if (expectedFailure) {
      assert.match(assessment.failures.join("\n"), expectedFailure, name);
    }
  }
});

test("coverage policy preserves the engine zero-total zero-pass value of one", async () => {
  const capture = await captureFakeRoute("webgpu");
  const raw = capture.raw;
  const frame = raw.frames[0];
  frame.totalMs = 0;
  frame.profiledPassMs = 0;
  frame.unaccountedMs = 0;
  frame.phaseTotalMs = 0;
  frame.phaseMs = Object.fromEntries(
    C11_205_SCENE_PHASE_NAMES.map((name) => [name, 0]),
  );
  frame.detailMs = Object.fromEntries(
    C11_205_OWNER_DETAIL_NAMES.map((name) => [name, 0]),
  );
  frame.passMs = {};
  frame.coverageRatio = 1;
  capture.traceSamples[0].cpuMs = 0;
  assert.equal(assessC11205OwnerAttribution(raw, capture).pass, true);
  frame.coverageRatio = 0;
  assert.equal(assessC11205OwnerAttribution(raw, capture).pass, false);
});

function matchingFingerprint() {
  const accumulator = createRepresentativeWorkloadFingerprintAccumulator();
  const sample = {
    segmentIndex: 0,
    terrainTilesToRender: 4,
    terrainMeshTiles: 4,
    terrainSelectionIdentityA: 101,
    terrainSelectionIdentityB: 202,
    terrainUnidentifiedTiles: 0,
    directModelInstancesConfigured: 48,
    directModelInstancesReady: 48,
    directModelIdentityA: 303,
    directModelIdentityB: 404,
    tilesetsWithSelection: 4,
    tilesetSelected: 4,
    tilesetSelectionIdentityA: 505,
    tilesetSelectionIdentityB: 606,
    tilesetSelectionCountMismatch: 0,
    tilesetUnidentifiedSelected: 0,
    tilesetsWithReadyContent: 4,
    tilesetContentReady: 7,
    tilesetReadyIdentityA: 707,
    tilesetReadyIdentityB: 808,
    tilesetReadyCountMismatch: 0,
    tilesetUnidentifiedReady: 0,
  };
  for (let index = 0; index < ownerAttributionFrames; index++) {
    const { segmentIndex } = expectedOwnerRouteState(index);
    accumulator.observe({
      ...sample,
      segmentIndex,
    });
  }
  const fingerprint = accumulator.snapshot();
  fingerprint.provenance = {
    timed: false,
    phase: "post-measurement-untimed-replay",
    traceEndedBeforeReplay: true,
    measurementSnapshotsFrozenBeforeReplay: true,
    replayModeFixedFrame: true,
    renderedProgressIdentical: true,
    causal: true,
  };
  return fingerprint;
}

function ownerPairRun({ api = false } = {}) {
  return {
    measuredFrames: ownerAttributionFrames,
    quality: {
      status: "attribution-only",
      attributionOnly: true,
      certificationEligible: false,
    },
    apiInstrumentationEnabled: api,
    apiCounters: { enabled: api },
    representativeContentEvidence: {
      measurementTerrainActivity: {
        delta: {
          requestCount: 0,
          tileGenerationCount: 0,
          requestsByLevel: {},
          generationsByLevel: {},
          generatedTileKeys: [],
        },
      },
      measurementContent: { workloadFingerprint: matchingFingerprint() },
    },
  };
}

test("CPU-owner pairs remain identity-gated without requiring API lifecycle tracing", () => {
  const options = {
    measurementTerrainMode: "resident",
    maximumDeltaRatio: 0.05,
  };
  const ownerPair = assessRepresentativePairComparability(
    ownerPairRun(),
    ownerPairRun(),
    options,
  );
  assert.equal(ownerPair.valid, true, ownerPair.reasons.join("\n"));
  assert.equal(ownerPair.attributionOnly, true);
  assert.equal(ownerPair.apiLifecycleAttributionRequired, false);
  assert.equal(ownerPair.certificationEligible, false);
  assert.match(ownerPair.certificationExclusions[0], /cannot certify/);

  const apiPair = assessRepresentativePairComparability(
    ownerPairRun({ api: true }),
    ownerPairRun({ api: true }),
    options,
  );
  assert.equal(apiPair.apiLifecycleAttributionRequired, true);
  assert.equal(apiPair.valid, false);
  assert.ok(
    apiPair.reasons.some((reason) =>
      reason.includes("tileset lifecycle attribution is incomplete"),
    ),
  );
});

test("explicit quality option is attribution-only and never certification eligible", () => {
  const ownerQuality = assessPerformanceRunQuality(
    {
      measurement: { elapsedMs: 1 },
      longTasks: { available: false, totalMs: 0 },
      timestampEnabled: false,
      apiCounters: { enabled: false },
    },
    {
      attributionOnly: true,
      attributionReason: "owner diagnostic",
    },
  );
  assert.equal(ownerQuality.status, "attribution-only");
  assert.equal(ownerQuality.attributionOnly, true);
  assert.equal(ownerQuality.certificationEligible, false);
  assert.equal(ownerQuality.validForCpuAggregation, false);
  assert.deepEqual(ownerQuality.warnings, ["owner diagnostic"]);
});

test("runner source keeps the owner lane bounded, fail-closed, and noncertifying", () => {
  assert.match(runnerSource, /--cpu-owner-attribution/);
  assert.match(runnerSource, /options\.repetitions = config\.repetitions/);
  assert.match(runnerSource, /options\.frames = config\.measuredFrames/);
  assert.match(runnerSource, /options\.renderer = config\.renderer/);
  assert.match(runnerSource, /c11-205-owner-attribution\.mjs/);
  assert.match(
    runnerSource,
    /options\.output = resolve\(repositoryDirectory, config\.diagnosticOutput\)/,
  );
  assert.match(
    runnerSource,
    /options\.cpuOwnerAttribution\s*\? \{ runId: cpuOwnerAttributionRunId \}\s*: \{\}/,
  );
  assert.equal((runnerSource.match(/randomUUID\(\)/g) ?? []).length, 1);
  assert.ok(
    runnerSource.indexOf("cpuOwnerAttributionCollector.start()") <
      runnerSource.indexOf("scene.beginPerformanceTrace("),
  );
  assert.match(
    runnerSource,
    /const trace = scene\.endPerformanceTrace\(\);\s*const cpuOwnerAttributionResult =\s*await stopCpuOwnerAttribution\(false\)/,
  );
  assert.match(runnerSource, /attributionOnly: cpuOwnerAttribution/);
  assert.match(
    runnerSource,
    /options\.apiInstrumentation === true \|\|\s*options\.cpuOwnerAttribution === true/,
  );
  const optionsIndex = runnerSource.indexOf(
    "const options = parseArguments(process.argv.slice(2));",
  );
  const exclusiveLockIndex = runnerSource.indexOf(
    '{ encoding: "utf8", flag: "wx" }',
    optionsIndex,
  );
  const runningMarkerWriteIndex = runnerSource.indexOf(
    "JSON.stringify(cpuOwnerAttributionRunningMarker, null, 2)",
    exclusiveLockIndex,
  );
  const manifestReadIndex = runnerSource.indexOf(
    "const manifest = JSON.parse",
    runningMarkerWriteIndex,
  );
  assert.ok(optionsIndex >= 0);
  assert.ok(exclusiveLockIndex > optionsIndex);
  assert.ok(runningMarkerWriteIndex > exclusiveLockIndex);
  assert.ok(manifestReadIndex > runningMarkerWriteIndex);
  assert.match(
    runnerSource.slice(optionsIndex, manifestReadIndex),
    /if \(options\.cpuOwnerAttribution\) \{[\s\S]*?randomUUID\(\)[\s\S]*?flag: "wx"[\s\S]*?cpuOwnerAttributionRunningMarker/,
  );
  assert.match(helperSource, /result: "running"/);
  assert.match(helperSource, /incomplete: true/);
  assert.match(helperSource, /error\?\.code === "ENOENT"/);
  const finalOwnershipIndex = runnerSource.indexOf(
    "owner-attribution lock ownership failed before final output",
  );
  const finalOutputWriteIndex = runnerSource.indexOf(
    "options.output,",
    finalOwnershipIndex,
  );
  const lockReleaseIndex = runnerSource.indexOf(
    "await unlink(cpuOwnerAttributionLockPath)",
    finalOutputWriteIndex,
  );
  assert.ok(finalOwnershipIndex >= 0);
  assert.ok(finalOutputWriteIndex > finalOwnershipIndex);
  assert.ok(lockReleaseIndex > finalOutputWriteIndex);
  assert.match(
    runnerSource,
    /write-once; an existing first red is referenced, never overwritten/,
  );
  assert.match(
    runnerSource,
    /pre-existing uninstrumented causal evidence; referenced read-only and never recertified/,
  );
  assert.match(
    helperSource,
    /WebGL\n \* records no synthetic phase or pass fields/,
  );
});

test("first-red policy and exclusive run ownership fail closed", async () => {
  assert.deepEqual(
    ownerAttributionFirstRedDecision({ exitCode: 1, existedBefore: false }),
    { existedBefore: false, written: true, preserved: false },
  );
  assert.deepEqual(
    ownerAttributionFirstRedDecision({ exitCode: 1, existedBefore: true }),
    { existedBefore: true, written: false, preserved: true },
  );
  assert.deepEqual(
    ownerAttributionFirstRedDecision({ exitCode: 0, existedBefore: false }),
    { existedBefore: false, written: false, preserved: false },
  );

  assert.deepEqual(ownerAttributionFirstRedLookupDecision(), {
    existedBefore: true,
    lookupError: null,
  });
  assert.deepEqual(
    ownerAttributionFirstRedLookupDecision(
      Object.assign(new Error("absent"), { code: "ENOENT" }),
    ),
    { existedBefore: false, lookupError: null },
  );
  const deniedLookup = ownerAttributionFirstRedLookupDecision(
    Object.assign(new Error("denied"), { code: "EACCES" }),
  );
  assert.equal(deniedLookup.existedBefore, null);
  assert.match(deniedLookup.lookupError, /denied/);

  const runA = "owner-run-a";
  const runB = "owner-run-b";
  const lockA = createC11205OwnerAttributionLockRecord(
    runA,
    "2026-08-11T00:00:00.000Z",
  );
  const lockB = createC11205OwnerAttributionLockRecord(
    runB,
    "2026-08-11T00:00:01.000Z",
  );
  assert.equal(ownsC11205OwnerAttributionLock(lockA, runA), true);
  assert.equal(ownsC11205OwnerAttributionLock(lockA, runB), false);
  const marker = createC11205OwnerAttributionRunningMarker({
    runId: runA,
    generatedAt: lockA.acquiredAt,
  });
  assert.equal(marker.result, "running");
  assert.equal(marker.status, "RUNNING");
  assert.equal(marker.incomplete, true);
  assert.equal(marker.pass, null);
  assert.equal(marker.runId, runA);
  assert.equal(marker.cpuOwnerAttribution.lock.ownedByRunId, runA);
  assert.match(marker.cpuOwnerAttribution.lock.staleRecovery, /manually/);

  const directory = await mkdtemp(join(tmpdir(), "c11-owner-lock-"));
  const lockPath = join(directory, "owner-attribution.lock");
  try {
    await writeFile(lockPath, `${JSON.stringify(lockA)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await assert.rejects(
      writeFile(lockPath, `${JSON.stringify(lockB)}\n`, {
        encoding: "utf8",
        flag: "wx",
      }),
      (error) => error?.code === "EEXIST",
    );
    const persisted = JSON.parse(await readFile(lockPath, "utf8"));
    assert.equal(ownsC11205OwnerAttributionLock(persisted, runA), true);
    assert.equal(ownsC11205OwnerAttributionLock(persisted, runB), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
