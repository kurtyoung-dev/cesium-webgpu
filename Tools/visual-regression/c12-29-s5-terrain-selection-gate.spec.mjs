import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  C12_29_S5_BUILD_SOURCE_FILES,
  C12_29_S5_CAPTURE_LABELS,
  C12_29_S5_CAPTURE_METHOD,
  C12_29_S5_DIAGNOSTICS_SCHEMA,
  C12_29_S5_FIXTURE,
  C12_29_S5_PHASES,
  C12_29_S5_PICK_FRAME_DRIVER,
  C12_29_S5_PICK_MAX_PUMP_FRAMES,
  C12_29_S5_RENDERERS,
  C12_29_S5_SCENE,
  C12_29_S5_SCHEMA,
  C12_29_S5_SOURCE_FILES,
  C12_29_S5_WEBGPU_ECLIPSE_BINDING,
  C12_29_S5_WEBGPU_LAYOUT_FILE,
  computeExpectedTerrainSurfaceRadius,
  deriveS5HeldLevelOneTarget,
  exitCodeForS5Status,
  foldC1229S5Gate,
  isUuidV4,
  validateS5FinalArtifactShape,
  validateS5PageProgress,
} from "./lib/c12-29-s5-terrain-selection-gate.mjs";
import {
  awaitS5PageMeasurement,
  beginS5EvidenceRun,
  createS5ArtifactPaths,
  inspectS5PriorState,
  inspectS5QuantizedMeshHeader,
  inspectS5WebGPUEclipseBinding,
  publishS5FinalArtifact,
  redactS5OutputPayload,
  validateS5LoopbackBase,
  withS5Watchdog,
} from "./probe-c12-29-s5-terrain-selection.mjs";
import {
  checkEmbeddedCaptureIsCanonical,
  checkFusedCaptureUsage,
} from "./lib/same-task-capture.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(directory, "../..");
const probePath = path.join(directory, "probe-c12-29-s5-terrain-selection.mjs");
const probeSource = fs.readFileSync(probePath, "utf8");
const specSource = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";

const IMAGE_IDS = Object.freeze([
  "123e4567-e89b-42d3-a456-426614174001",
  "123e4567-e89b-42d3-a456-426614174002",
  "123e4567-e89b-42d3-a456-426614174003",
  "123e4567-e89b-42d3-a456-426614174004",
  "123e4567-e89b-42d3-a456-426614174005",
  "123e4567-e89b-42d3-a456-426614174006",
  "123e4567-e89b-42d3-a456-426614174007",
  "123e4567-e89b-42d3-a456-426614174008",
  "123e4567-e89b-42d3-a456-426614174009",
  "123e4567-e89b-42d3-a456-42661417400a",
]);

const radiusInput = Object.freeze({
  knownMinimumHeight: C12_29_S5_FIXTURE.tile.quantizedMeshHeader.minimumHeight,
  knownMaximumHeight: C12_29_S5_FIXTURE.tile.quantizedMeshHeader.maximumHeight,
  ellipsoidMaximumRadius: 6_378_137,
  verticalExaggeration: C12_29_S5_SCENE.verticalExaggeration,
  verticalExaggerationRelativeHeight:
    C12_29_S5_SCENE.verticalExaggerationRelativeHeight,
});
const radius = computeExpectedTerrainSurfaceRadius(radiusInput);
const SYNTHETIC_TRACK = Object.freeze({
  longitude: -100,
  latitude: 25,
  magnitude: 1.01,
});
const heldTarget = deriveS5HeldLevelOneTarget(
  SYNTHETIC_TRACK.longitude,
  SYNTHETIC_TRACK.latitude,
);

function syntheticProgress(renderer = "webgl") {
  return {
    schema: C12_29_S5_DIAGNOSTICS_SCHEMA,
    renderer,
    currentPhase: C12_29_S5_PHASES[5],
    step: "pick-start",
    completedPhases: C12_29_S5_PHASES.slice(0, 5),
    elapsedMs: 12_345,
    settle: null,
    terrainRequests: {
      attempted: 2,
      accepted: 2,
      throttled: 0,
      decoded: 2,
      held: 1,
      released: 1,
      fulfilled: 2,
      rejected: 0,
      lastTileId: "1/1/0",
      lastError: null,
    },
    pick: {
      started: true,
      settled: false,
      frameDriver: C12_29_S5_PICK_FRAME_DRIVER,
      renderPumpFrames: 0,
    },
  };
}

function syntheticImages(renderer) {
  const idOffset = renderer === "webgpu" ? 4 : 0;
  return C12_29_S5_CAPTURE_LABELS.map((label, index) => ({
    imageId: IMAGE_IDS[idOffset + index],
    label,
    fileName: `${RUN_ID}.${IMAGE_IDS[idOffset + index]}.${renderer}.${label}.png`,
    byteLength: 1000 + index,
    width: C12_29_S5_SCENE.viewport.width,
    height: C12_29_S5_SCENE.viewport.height,
    sha256: String(index + 1).repeat(64),
    fingerprintVerified: true,
    captureMethod: C12_29_S5_CAPTURE_METHOD,
    renderTaskToken: `${renderer}-${index}`,
    captureTaskToken: `${renderer}-${index}`,
  }));
}

function syntheticSession(renderer) {
  const selectedTileIds = ["1/0/0", "1/1/0"];
  const phases = {
    [C12_29_S5_PHASES[0]]: {
      provider: "EllipsoidTerrainProvider",
      stable: true,
      tilesLoaded: true,
      selectedCount: 2,
      selectedTileIds: [...selectedTileIds],
    },
    [C12_29_S5_PHASES[1]]: {
      fromProvider: "EllipsoidTerrainProvider",
      toProvider: "CesiumTerrainProvider-held",
      publicAssignment: {
        sceneProviderMatches: true,
        tileProviderAwaitingFirstBeginFrame: true,
        terrainRequestsBeforeFirstFrame: 0,
      },
      firstBeginFramePropagation: {
        observedAt:
          "first-pinned-render-after-globe.beginFrame-before-selection-load",
        beginFrameCallOrdinal: 1,
        tileProviderIdentityPreserved: true,
        tileProviderMatchesAssigned: true,
        publicProviderMatchesAssigned: true,
        terrainRequestAttemptsAtObservation: 0,
        observedBeforeSelectionAndLoad: true,
        observedInFirstRender: true,
        selectionRevisionUnchanged: true,
        surfaceRadiusUndefined: true,
        knownMinimumHeight: 0,
        knownMaximumHeight: 0,
        knownBoundsValid: true,
        contentRevisionAdvanced: true,
        contentRevisionBefore: 3,
        contentRevisionAtObservation: 4,
        selectionRevisionBefore: 16,
        selectionRevisionAtObservation: 16,
      },
    },
    [C12_29_S5_PHASES[2]]: {
      selectedTileIds: [...selectedTileIds],
      realTileIds: [heldTarget.anchorKey],
      holdTarget: heldTarget,
      holdInterceptionEnabled: true,
      maximumScreenSpaceError: C12_29_S5_SCENE.fillMaximumScreenSpaceError,
      heldRequestCount: 1,
      heldKeys: [heldTarget.key],
      fillCount: 1,
      fillTileIds: [heldTarget.key],
      loadedAndFillFlags: true,
      heldTargetIntersectsSelectedFill: true,
      realSiblingTileIds: [heldTarget.anchorKey],
      decodedQuantizedMeshCount: 1,
      realMeshCount: 1,
      decodedFixtureIdentity: "QuantizedMeshTerrainData-instance",
      decodedFixtureIdentityVerified: true,
      decodedFixtureBounds: [
        {
          tileId: heldTarget.key,
          minimumHeight:
            C12_29_S5_FIXTURE.tile.quantizedMeshHeader.minimumHeight,
          maximumHeight:
            C12_29_S5_FIXTURE.tile.quantizedMeshHeader.maximumHeight,
        },
      ],
    },
    [C12_29_S5_PHASES[3]]: {
      tilesLoaded: true,
      fillCount: 0,
      decodedQuantizedMeshCount: 2,
      realTileIds: [heldTarget.key],
      holdInterceptionEnabled: false,
      heldRequestCountAfterRelease: 0,
      releasedKeys: [heldTarget.key],
      releasedTargetKey: heldTarget.key,
      releasedRequestCount: 1,
      newHeldRequestCountAfterRelease: 0,
      transitionedKeys: [heldTarget.key],
      transitionObservation: {
        tileId: heldTarget.key,
        selected: true,
        renderedReal: true,
        renderedFill: false,
        frame: 1,
      },
    },
    [C12_29_S5_PHASES[4]]: {
      ...radiusInput,
      expectedSurfaceRadius: radius.radius,
      surfaceRadius: radius.radius,
      mainViewOwnerMatches: true,
      prepared: true,
      preparedSelectionRevision: 17,
      providerSelectionRevision: 17,
      preparedSurfaceRadius: radius.radius,
      preparedSelectedTileIds: [...selectedTileIds],
      selectedTileIds: [...selectedTileIds],
    },
    [C12_29_S5_PHASES[5]]: {
      method: "scene.pickAsync",
      awaited: true,
      settlement: "fulfilled",
      surrogateUsed: false,
      frameDriver: C12_29_S5_PICK_FRAME_DRIVER,
      renderPumpFrames: renderer === "webgl" ? 1 : 0,
      updateForPickCalls: 1,
      postcondition: {
        sampledAt: "same-updateForPick-call",
        callOrdinal: 1,
        prepared: true,
        selectionRevision: 17,
        surfaceRadius: radius.radius,
        ownerMatches: true,
      },
      expected: {
        sampledAt: "same-updateForPick-call",
        callOrdinal: 1,
        selectionRevision: 17,
        surfaceRadius: radius.radius,
      },
    },
    [C12_29_S5_PHASES[6]]:
      renderer === "webgl"
        ? {
            applicable: false,
            reason: "WebGPU-only manager-driven retained capture",
          }
        : {
            applicable: true,
            driver: "DynamicEnvironmentMapManager.update",
            directRunSceneCapture: false,
            transientAliasesOnlyCleared: true,
            managerResetRequested: true,
            selectedTileIds: [...selectedTileIds],
            calledTileIds: [...selectedTileIds],
            captureTileCalls: 12,
            expectedCaptureTileCalls: 12,
            positiveDrawCalls: 12,
            dynamicOffsetLengths: Array(12).fill(3),
            eclipseBinding: C12_29_S5_WEBGPU_ECLIPSE_BINDING,
            status: "SUBMITTED",
            statusCode: 2,
            preparedBeforeFirstTile: true,
            preparedSelectionRevision: 17,
            retainedSelectionRevision: 17,
            preparedSurfaceRadius: radius.radius,
            retainedSurfaceRadius: radius.radius,
            cameraRestored: true,
          },
    [C12_29_S5_PHASES[7]]: {
      fromProvider: "CesiumTerrainProvider-held",
      toProvider: "EllipsoidTerrainProvider-fresh",
      publicAssignment: {
        sceneProviderMatches: true,
        tileProviderAwaitingFirstBeginFrame: true,
        terrainRequestsBeforeFirstFrame: 0,
      },
      firstBeginFramePropagation: {
        observedAt:
          "first-pinned-render-after-globe.beginFrame-before-selection-load",
        beginFrameCallOrdinal: 1,
        tileProviderIdentityPreserved: true,
        tileProviderMatchesAssigned: true,
        publicProviderMatchesAssigned: true,
        terrainRequestAttemptsAtObservation: 0,
        observedBeforeSelectionAndLoad: true,
        observedInFirstRender: true,
        selectionRevisionUnchanged: true,
        surfaceRadiusUndefined: true,
        knownMinimumHeight: 0,
        knownMaximumHeight: 0,
        knownBoundsValid: true,
        contentRevisionAdvanced: true,
        contentRevisionBefore: 8,
        contentRevisionAtObservation: 9,
        selectionRevisionBefore: 30,
        selectionRevisionAtObservation: 30,
      },
      nextEpoch: {
        contentRevisionAdvanced: true,
        contentRevision: 10,
        providerIsFreshEllipsoid: true,
        tileProviderMatchesFreshEllipsoid: true,
        selectionRevisionAdvanced: true,
        selectionRevision: 31,
        selectedCount: 1,
      },
    },
  };
  return {
    renderer,
    actualRenderer: renderer,
    fixture: {
      pinnedIso: C12_29_S5_SCENE.pinnedIso,
      clockIso: C12_29_S5_SCENE.pinnedIso,
      cameraHeightMeters: C12_29_S5_SCENE.cameraHeightMeters,
      actualCameraHeightMeters: C12_29_S5_SCENE.cameraHeightMeters,
      cameraFovDegrees: C12_29_S5_SCENE.cameraFovDegrees,
      viewport: { ...C12_29_S5_SCENE.viewport },
      trackDerivation: "live-f64-ephemeris-global-grid-plus-two-refinements",
      deepestTrack: SYNTHETIC_TRACK,
    },
    phases,
    images: syntheticImages(renderer),
    x2OffOnComparison: {
      sameDimensions: true,
      changedPixels: 500,
      maximumChannelDelta: 12,
    },
    transport: {
      loopback: true,
      sameOriginOnly: true,
      externalRequests: [],
      failedRequests: [],
      httpErrors: [],
    },
    runtime: {
      pageErrors: [],
      consoleErrors: [],
      gpuErrors: [],
      deviceLost: false,
      cleanupComplete: true,
    },
    sameTaskCapture: {
      method: C12_29_S5_CAPTURE_METHOD,
      canonicalSourcePinned: true,
      yieldBetweenRenderAndRead: false,
    },
  };
}

function greenReport() {
  return {
    schema: C12_29_S5_SCHEMA,
    runId: RUN_ID,
    provenance: {
      ok: true,
      stable: true,
      gitHead: "a".repeat(40),
      fixtures: {
        layer: { exists: true, ...C12_29_S5_FIXTURE.layer },
        tile: { exists: true, ...C12_29_S5_FIXTURE.tile },
      },
      quantizedMeshHeader: {
        ok: true,
        ...C12_29_S5_FIXTURE.tile.quantizedMeshHeader,
      },
      sourceBoundary: {
        count: C12_29_S5_SOURCE_FILES.length,
        files: [...C12_29_S5_SOURCE_FILES],
        allReadable: true,
      },
      buildSourceIdentity: {
        ok: true,
        entries: C12_29_S5_BUILD_SOURCE_FILES.map((file) => ({ file })),
      },
      generatedShaders: { globeFsExact: true, globeTerrainExact: true },
      webgpuEclipseBinding: {
        ok: true,
        file: C12_29_S5_WEBGPU_LAYOUT_FILE,
        binding: C12_29_S5_WEBGPU_ECLIPSE_BINDING,
        stage: "FRAGMENT",
        hasDynamicOffset: true,
        minimumSizeSymbol: "ECLIPSE_UNIFORM_BYTES",
      },
      servedEntryIdentity: {
        ok: true,
        expectedLabels: [...C12_29_S5_RENDERERS],
      },
      harnessStable: true,
    },
    sessions: C12_29_S5_RENDERERS.map(syntheticSession),
  };
}

function mutateReport(mutator) {
  const report = structuredClone(greenReport());
  mutator(report);
  return foldC1229S5Gate(report);
}

function expectStatus(mutator, status, pattern) {
  const verdict = mutateReport(mutator);
  assert.equal(verdict.status, status);
  assert.equal(verdict.exitCode, exitCodeForS5Status(status));
  assert.match(
    [...verdict.structuralReasons, ...verdict.failureReasons].join("\n"),
    pattern,
  );
}

test("01 full valid fixture closes the pure S5 gate", () => {
  const verdict = foldC1229S5Gate(greenReport());
  assert.equal(verdict.status, "PASS");
  assert.equal(verdict.exitCode, 0);
  assert.equal(C12_29_S5_SCHEMA, "c12-29-s5-terrain-selection-evidence-v2");
  assert.equal(verdict.checks.sourceBoundaryCount, 35);
  assert.equal(verdict.checks.buildSourceBoundaryCount, 33);
});

test("02 precedence is STRUCTURAL over FAIL over PASS with frozen exits", () => {
  assert.deepEqual(
    ["PASS", "FAIL", "ERROR", "STRUCTURAL"].map(exitCodeForS5Status),
    [0, 1, 2, 3],
  );
  const report = greenReport();
  report.sessions[0].phases[C12_29_S5_PHASES[4]].surfaceRadius++;
  assert.equal(foldC1229S5Gate(report).status, "FAIL");
  report.provenance.ok = false;
  assert.equal(foldC1229S5Gate(report).status, "STRUCTURAL");
});

test("03 UUID, artifact naming, schema, and final shape fail closed", () => {
  assert.equal(isUuidV4(RUN_ID), true);
  const artifact = {
    schema: C12_29_S5_SCHEMA,
    runId: RUN_ID,
    status: "PASS",
    exitCode: 0,
    incomplete: false,
    artifactName: `${RUN_ID}.json`,
  };
  assert.equal(validateS5FinalArtifactShape(artifact).ok, true);
  assert.equal(
    validateS5FinalArtifactShape({ ...artifact, artifactName: "latest.json" })
      .ok,
    false,
  );
  assert.equal(
    validateS5FinalArtifactShape({ ...artifact, runId: "bad" }).ok,
    false,
  );
  const errorArtifact = {
    ...artifact,
    status: "ERROR",
    exitCode: 2,
    error: "simulated page timeout",
    diagnostics: {
      schema: C12_29_S5_DIAGNOSTICS_SCHEMA,
      renderer: "webgl",
      stage: "page-measurement-timeout",
      node: {
        stage: "page-measurement",
        requestLedger: {
          started: 5,
          completed: 4,
          failed: 0,
          inFlight: 1,
          lastRequest: null,
          lastResponse: null,
          lastFailure: null,
        },
      },
      page: syntheticProgress(),
    },
  };
  assert.equal(validateS5FinalArtifactShape(errorArtifact).ok, true);
  assert.equal(validateS5PageProgress(syntheticProgress()).ok, true);
  assert.equal(
    validateS5PageProgress({
      ...syntheticProgress(),
      completedPhases: [C12_29_S5_PHASES[1]],
    }).ok,
    false,
  );
  assert.equal(
    validateS5FinalArtifactShape({
      ...errorArtifact,
      diagnostics: {
        ...errorArtifact.diagnostics,
        node: { stage: "page-measurement" },
      },
    }).ok,
    false,
  );
  assert.equal(
    redactS5OutputPayload(
      "https://user:secret@localhost:8080/x?token=secret&flag#fragment",
    ),
    "https://[REDACTED]@localhost:8080/x?token=[REDACTED]&flag=[REDACTED]#[REDACTED]",
  );
});

test("04 renderer and A-H phase cardinality cannot shrink", () => {
  expectStatus(
    (report) => report.sessions.pop(),
    "STRUCTURAL",
    /renderer cardinality/u,
  );
  expectStatus(
    (report) => delete report.sessions[0].phases[C12_29_S5_PHASES[3]],
    "STRUCTURAL",
    /phase cardinality/u,
  );
  for (const mutateCameraFixture of [
    (report) => delete report.sessions[0].fixture.actualCameraHeightMeters,
    (report) => (report.sessions[0].fixture.actualCameraHeightMeters = NaN),
    (report) => delete report.sessions[0].fixture.cameraFovDegrees,
    (report) => (report.sessions[0].fixture.cameraFovDegrees = NaN),
  ]) {
    expectStatus(
      mutateCameraFixture,
      "STRUCTURAL",
      /named-event camera\/clock fixture/u,
    );
  }
});

test("05 local QuantizedMesh byte and SHA pins are immutable", () => {
  assert.equal(C12_29_S5_FIXTURE.layer.byteLength, 569);
  assert.equal(C12_29_S5_FIXTURE.tile.byteLength, 3914);
  assert.deepEqual(inspectS5QuantizedMeshHeader(), {
    ok: true,
    ...C12_29_S5_FIXTURE.tile.quantizedMeshHeader,
  });
  const corruptedTile = fs.readFileSync(
    path.join(repositoryRoot, C12_29_S5_FIXTURE.tile.file),
  );
  corruptedTile.writeFloatLE(
    0,
    C12_29_S5_FIXTURE.tile.quantizedMeshHeader.minimumHeightByteOffset,
  );
  assert.equal(
    inspectS5QuantizedMeshHeader("ignored", {
      readFileSync: () => corruptedTile,
    }).ok,
    false,
  );
  expectStatus(
    (report) => (report.provenance.fixtures.tile.sha256 = "0".repeat(64)),
    "STRUCTURAL",
    /fixture bytes/u,
  );
});

test("06 source, build, generated, served, and stability mutants are STRUCTURAL", () => {
  const mutants = [
    (report) => report.provenance.sourceBoundary.files.pop(),
    (report) => (report.provenance.buildSourceIdentity.ok = false),
    (report) => (report.provenance.generatedShaders.globeTerrainExact = false),
    (report) => (report.provenance.quantizedMeshHeader.ok = false),
    (report) => (report.provenance.webgpuEclipseBinding.ok = false),
    (report) => (report.provenance.servedEntryIdentity.ok = false),
    (report) => (report.provenance.harnessStable = false),
  ];
  for (const mutant of mutants) {
    assert.equal(mutateReport(mutant).status, "STRUCTURAL");
  }
});

test("07 first-beginFrame provider-reset boundary is exact and pre-selection", () => {
  assert.deepEqual(heldTarget, {
    level: 1,
    anchorKey: "1/0/0",
    key: "1/1/0",
    edge: "east",
    distanceDegrees: 10,
    derivation: "nearest-level-1-anchor-edge-neighbor",
    siblingKeys: ["1/0/0", "1/0/1", "1/1/1"],
  });
  for (const mutateBoundary of [
    (phase) => delete phase.firstBeginFramePropagation,
    (phase) =>
      (phase.firstBeginFramePropagation.terrainRequestAttemptsAtObservation = 1),
    (phase) =>
      (phase.firstBeginFramePropagation.selectionRevisionUnchanged = false),
  ]) {
    expectStatus(
      (report) =>
        mutateBoundary(report.sessions[0].phases[C12_29_S5_PHASES[1]]),
      "STRUCTURAL",
      /first-beginFrame observation/u,
    );
  }
  for (const mutateReset of [
    (phase) =>
      (phase.firstBeginFramePropagation.surfaceRadiusUndefined = false),
    (phase) => (phase.firstBeginFramePropagation.knownMinimumHeight = -1),
    (phase) =>
      (phase.firstBeginFramePropagation.contentRevisionAdvanced = false),
  ]) {
    expectStatus(
      (report) => mutateReset(report.sessions[0].phases[C12_29_S5_PHASES[1]]),
      "FAIL",
      /first beginFrame propagation/u,
    );
  }
  expectStatus(
    (report) => {
      report.sessions[0].phases[
        C12_29_S5_PHASES[7]
      ].firstBeginFramePropagation.terrainRequestAttemptsAtObservation = 1;
    },
    "STRUCTURAL",
    /final provider first-beginFrame observation/u,
  );
});

test("08 one selected L1 hold, real sibling, and disabled release are exact", () => {
  for (const mutateFill of [
    (phase) => (phase.fillCount = 0),
    (phase) => (phase.heldRequestCount = 0),
    (phase) => {
      phase.heldRequestCount = 2;
      phase.heldKeys.push("1/1/1");
    },
    (phase) => phase.selectedTileIds.pop(),
    (phase) => (phase.realSiblingTileIds = []),
    (phase) => (phase.maximumScreenSpaceError = 2),
  ]) {
    expectStatus(
      (report) => mutateFill(report.sessions[0].phases[C12_29_S5_PHASES[2]]),
      "STRUCTURAL",
      /exactly one derived level-one hold/u,
    );
  }
  for (const mutateRelease of [
    (phase) => (phase.holdInterceptionEnabled = true),
    (phase) => (phase.newHeldRequestCountAfterRelease = 1),
  ]) {
    expectStatus(
      (report) => mutateRelease(report.sessions[0].phases[C12_29_S5_PHASES[3]]),
      "STRUCTURAL",
      /disabled before the one release/u,
    );
  }
  expectStatus(
    (report) =>
      (report.sessions[0].phases[
        C12_29_S5_PHASES[3]
      ].transitionObservation.renderedReal = false),
    "FAIL",
    /held fill did not transition/u,
  );
});

test("09 decoded real QuantizedMesh is independently nonvacuous", () => {
  expectStatus(
    (report) => {
      report.sessions[1].phases[C12_29_S5_PHASES[2]].decodedQuantizedMeshCount =
        0;
    },
    "STRUCTURAL",
    /QuantizedMesh/u,
  );
  expectStatus(
    (report) => {
      report.sessions[1].phases[
        C12_29_S5_PHASES[2]
      ].decodedFixtureIdentityVerified = false;
    },
    "STRUCTURAL",
    /QuantizedMesh/u,
  );
  expectStatus(
    (report) => {
      report.sessions[0].phases[
        C12_29_S5_PHASES[2]
      ].decodedFixtureBounds[0].minimumHeight = 0;
    },
    "STRUCTURAL",
    /header pins/u,
  );
});

test("10 exact corrected radius formula is accepted and measured bit-exactly", () => {
  assert.equal(C12_29_S5_SCENE.pinnedIso, "2024-04-08T18:17:16Z");
  assert.deepEqual(radius, {
    exaggeratedMinimum: -9312.008514404297,
    exaggeratedMaximum: 6654.23828125,
    unprotectedRadius: 6_387_449.008514404,
    safety: 6_387_449.008514404 * (8 * 2 ** -23),
    radius: 6_387_449.008514404 + 6_387_449.008514404 * (8 * 2 ** -23),
  });
  expectStatus(
    (report) =>
      (report.sessions[0].phases[C12_29_S5_PHASES[4]].surfaceRadius += 1),
    "FAIL",
    /exact law/u,
  );
  expectStatus(
    (report) => {
      const zeroEnvelope = computeExpectedTerrainSurfaceRadius({
        ...radiusInput,
        knownMinimumHeight: 0,
        knownMaximumHeight: 0,
      });
      for (const session of report.sessions) {
        const e = session.phases[C12_29_S5_PHASES[4]];
        e.knownMinimumHeight = 0;
        e.knownMaximumHeight = 0;
        e.expectedSurfaceRadius = zeroEnvelope.radius;
        e.surfaceRadius = zeroEnvelope.radius;
        e.preparedSurfaceRadius = zeroEnvelope.radius;
        const f = session.phases[C12_29_S5_PHASES[5]];
        f.expected.surfaceRadius = zeroEnvelope.radius;
        f.postcondition.surfaceRadius = zeroEnvelope.radius;
      }
      const capture = report.sessions[1].phases[C12_29_S5_PHASES[6]];
      capture.preparedSurfaceRadius = zeroEnvelope.radius;
      capture.retainedSurfaceRadius = zeroEnvelope.radius;
    },
    "FAIL",
    /did not advance from reset/u,
  );
});

test("11 no-exaggeration and no-relative-height radius mutants are rejected", () => {
  const noExaggeration = computeExpectedTerrainSurfaceRadius({
    ...radiusInput,
    verticalExaggeration: 1,
  });
  const noRelativeHeight = computeExpectedTerrainSurfaceRadius({
    ...radiusInput,
    verticalExaggerationRelativeHeight: 0,
  });
  assert.notEqual(noExaggeration.radius, radius.radius);
  assert.notEqual(noRelativeHeight.radius, radius.radius);
});

test("12 omitted and post-exaggeration fill-skirt mutants are rejected", () => {
  const eMinWithOmittedSkirt =
    (radiusInput.knownMinimumHeight -
      radiusInput.verticalExaggerationRelativeHeight) *
      radiusInput.verticalExaggeration +
    radiusInput.verticalExaggerationRelativeHeight;
  const protectedMutantRadius = (minimumEndpoint) => {
    const unprotected =
      radiusInput.ellipsoidMaximumRadius +
      Math.max(Math.abs(minimumEndpoint), Math.abs(radius.exaggeratedMaximum));
    return unprotected + Math.max(2, unprotected * (8 * 2 ** -23));
  };
  const omittedSkirtRadius = protectedMutantRadius(eMinWithOmittedSkirt);
  const postExaggerationSkirtRadius = protectedMutantRadius(
    eMinWithOmittedSkirt - 1000,
  );
  assert.notEqual(omittedSkirtRadius, radius.radius);
  assert.notEqual(postExaggerationSkirtRadius, radius.radius);
  assert.equal(radius.exaggeratedMinimum, -9312.008514404297);
  for (const mutantRadius of [
    omittedSkirtRadius,
    postExaggerationSkirtRadius,
  ]) {
    expectStatus(
      (report) => {
        report.sessions[0].phases[C12_29_S5_PHASES[4]].surfaceRadius =
          mutantRadius;
      },
      "FAIL",
      /exact law/u,
    );
  }
});

test("13 main-view exact owner and prepared tuple are gated", () => {
  expectStatus(
    (report) => {
      report.sessions[0].phases[C12_29_S5_PHASES[4]].preparedSelectionRevision =
        16;
    },
    "FAIL",
    /main-view/u,
  );
});

test("14 real fulfilled scene.pickAsync and updateForPick postcondition are gated", () => {
  expectStatus(
    (report) =>
      (report.sessions[0].phases[C12_29_S5_PHASES[5]].renderPumpFrames = 0),
    "STRUCTURAL",
    /frame-driven scene\.pickAsync/u,
  );
  expectStatus(
    (report) => {
      report.sessions[1].phases[C12_29_S5_PHASES[5]].frameDriver = "none";
      report.sessions[1].phases[C12_29_S5_PHASES[5]].renderPumpFrames =
        C12_29_S5_PICK_MAX_PUMP_FRAMES + 1;
    },
    "STRUCTURAL",
    /frame-driven scene\.pickAsync/u,
  );
  expectStatus(
    (report) =>
      (report.sessions[1].phases[C12_29_S5_PHASES[5]].updateForPickCalls = 0),
    "FAIL",
    /updateForPick/u,
  );
  expectStatus(
    (report) =>
      (report.sessions[1].phases[C12_29_S5_PHASES[5]].expected.callOrdinal = 2),
    "FAIL",
    /updateForPick/u,
  );
});

test("15 ellipsoid and position surrogate picks cannot certify the lane", () => {
  expectStatus(
    (report) =>
      (report.sessions[0].phases[C12_29_S5_PHASES[5]].surrogateUsed = true),
    "STRUCTURAL",
    /scene\.pickAsync/u,
  );
});

test("16 WebGPU retained capture is mandatory and WebGL is explicit N-A", () => {
  expectStatus(
    (report) =>
      (report.sessions[1].phases[C12_29_S5_PHASES[6]].applicable = false),
    "STRUCTURAL",
    /manager-driven/u,
  );
  expectStatus(
    (report) =>
      (report.sessions[0].phases[C12_29_S5_PHASES[6]].reason = "skip"),
    "STRUCTURAL",
    /explicit N\/A/u,
  );
});

test("17 capture union, six-face call count, positive draws, and SUBMITTED are gated", () => {
  for (const mutator of [
    (phase) => phase.calledTileIds.pop(),
    (phase) => phase.captureTileCalls--,
    (phase) => (phase.positiveDrawCalls = 0),
    (phase) => (phase.status = "PARTIAL"),
  ]) {
    expectStatus(
      (report) => mutator(report.sessions[1].phases[C12_29_S5_PHASES[6]]),
      "FAIL",
      /capture|retained/u,
    );
  }
});

test("18 three dynamic offsets, binding two carrier, and camera restore are gated", () => {
  expectStatus(
    (report) =>
      (report.sessions[1].phases[C12_29_S5_PHASES[6]].dynamicOffsetLengths[0] =
        2),
    "FAIL",
    /offsets|restoration/u,
  );
  expectStatus(
    (report) =>
      (report.sessions[1].phases[C12_29_S5_PHASES[6]].cameraRestored = false),
    "FAIL",
    /offsets|restoration/u,
  );
});

test("19 PNG UUID/hash/bytes uniqueness and x2 OFF-ON nonvacuity are gated", () => {
  expectStatus(
    (report) =>
      (report.sessions[0].images[1].imageId =
        report.sessions[0].images[0].imageId),
    "STRUCTURAL",
    /PNG UUID/u,
  );
  expectStatus(
    (report) => {
      report.sessions[1].images[0].imageId =
        report.sessions[0].images[0].imageId;
    },
    "STRUCTURAL",
    /globally unique/u,
  );
  expectStatus(
    (report) => (report.sessions[0].images[0].fileName = "renamed.png"),
    "STRUCTURAL",
    /PNG UUID/u,
  );
  expectStatus(
    (report) => (report.sessions[0].x2OffOnComparison.changedPixels = 0),
    "FAIL",
    /vacuous/u,
  );
});

test("20 browser, GPU-error, transport, and cleanup surfaces fail closed", async () => {
  for (const mutator of [
    (session) => session.runtime.pageErrors.push("boom"),
    (session) => session.runtime.gpuErrors.push("validation"),
    (session) => (session.runtime.deviceLost = true),
    (session) => (session.runtime.cleanupComplete = false),
    (session) => session.transport.externalRequests.push("remote"),
  ]) {
    expectStatus(
      (report) => mutator(report.sessions[1]),
      "STRUCTURAL",
      /browser\/GPU|transport/u,
    );
  }

  let closeCalls = 0;
  await assert.rejects(
    withS5Watchdog(
      () => new Promise(() => {}),
      async () => {
        closeCalls++;
      },
      5,
      10,
    ),
    (error) =>
      error?.code === "S5_WATCHDOG_UNDRAINED" &&
      error?.retainS5RunningLock === true,
  );
  assert.equal(closeCalls, 1);
  assert.match(
    probeSource,
    /if \(error\?\.retainS5RunningLock === true\) \{\s*throw error;/u,
  );

  const nodeDiagnostics = {
    stage: "page-measurement",
    requestLedger: {
      started: 12,
      completed: 11,
      failed: 0,
      inFlight: 1,
      lastRequest: { path: C12_29_S5_FIXTURE.tile.file },
      lastResponse: null,
      lastFailure: null,
    },
  };
  await assert.rejects(
    awaitS5PageMeasurement({
      renderer: "webgl",
      timeoutMs: 5,
      diagnosticReadTimeoutMs: 20,
      nodeDiagnostics,
      measure: () => new Promise(() => {}),
      readPageDiagnostics: async () => syntheticProgress(),
    }),
    (error) =>
      error?.code === "S5_PAGE_TIMEOUT" &&
      error?.s5Diagnostics?.stage === "page-measurement-timeout" &&
      error?.s5Diagnostics?.node?.requestLedger?.inFlight === 1 &&
      error?.s5Diagnostics?.page?.currentPhase === C12_29_S5_PHASES[5] &&
      error?.s5Diagnostics?.page?.pick?.settled === false,
  );
  await assert.rejects(
    awaitS5PageMeasurement({
      renderer: "webgl",
      timeoutMs: 5,
      diagnosticReadTimeoutMs: 5,
      nodeDiagnostics,
      measure: () => new Promise(() => {}),
      readPageDiagnostics: () => new Promise(() => {}),
    }),
    (error) =>
      error?.code === "S5_PAGE_TIMEOUT" &&
      error?.s5Diagnostics?.page === null &&
      error?.s5Diagnostics?.node?.diagnosticRead === "timeout" &&
      error?.s5Diagnostics?.node?.requestLedger?.started === 12,
  );
  await assert.rejects(
    awaitS5PageMeasurement({
      renderer: "webgl",
      timeoutMs: 5,
      diagnosticReadTimeoutMs: 20,
      nodeDiagnostics,
      measure: () => new Promise(() => {}),
      readPageDiagnostics: async () => ({
        ...syntheticProgress(),
        terrainRequests: {
          ...syntheticProgress().terrainRequests,
          attempted: 3,
        },
      }),
    }),
    (error) =>
      error?.code === "S5_PAGE_TIMEOUT" &&
      error?.s5Diagnostics?.page === null &&
      error?.s5Diagnostics?.node?.diagnosticRead === "invalid",
  );
});

test("21 prior RUNNING and extant lock both reject before browser work", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "c1229-s5-lock-"));
  try {
    const paths = createS5ArtifactPaths(RUN_ID, temp);
    fs.writeFileSync(
      paths.latest,
      JSON.stringify({ status: "RUNNING", runId: RUN_ID }),
    );
    assert.throws(() => inspectS5PriorState(paths), /still RUNNING/u);
    fs.unlinkSync(paths.latest);
    fs.writeFileSync(paths.lock, JSON.stringify({ runId: RUN_ID }));
    assert.throws(() => inspectS5PriorState(paths), /lock already exists/u);
    assert.throws(() => beginS5EvidenceRun(paths, RUN_ID), /EEXIST/u);
    assert.throws(
      () => validateS5LoopbackBase("https://example.com"),
      /loopback/u,
    );

    const runningDirectory = path.join(temp, "prior-running");
    fs.mkdirSync(runningDirectory);
    const runningPaths = createS5ArtifactPaths(IMAGE_IDS[0], runningDirectory);
    fs.writeFileSync(
      runningPaths.latest,
      JSON.stringify({ status: "RUNNING", runId: RUN_ID }),
    );
    assert.throws(
      () => beginS5EvidenceRun(runningPaths, IMAGE_IDS[0]),
      /still RUNNING/u,
    );
    assert.equal(fs.existsSync(runningPaths.lock), false);

    const malformedDirectory = path.join(temp, "malformed-latest");
    fs.mkdirSync(malformedDirectory);
    const malformedPaths = createS5ArtifactPaths(
      IMAGE_IDS[1],
      malformedDirectory,
    );
    fs.writeFileSync(malformedPaths.latest, "{");
    assert.throws(() => beginS5EvidenceRun(malformedPaths, IMAGE_IDS[1]));
    assert.equal(fs.existsSync(malformedPaths.lock), false);

    const orderedDirectory = path.join(temp, "ordered-acquire");
    const orderedPaths = createS5ArtifactPaths(IMAGE_IDS[2], orderedDirectory);
    const events = [];
    const operations = Object.create(fs);
    operations.writeFileSync = (...args) => {
      events.push(`write:${path.basename(args[0])}`);
      return fs.writeFileSync(...args);
    };
    operations.readFileSync = (...args) => {
      events.push(`read:${path.basename(args[0])}`);
      return fs.readFileSync(...args);
    };
    beginS5EvidenceRun(orderedPaths, IMAGE_IDS[2], operations);
    assert.ok(
      events.indexOf(`write:${path.basename(orderedPaths.lock)}`) <
        events.indexOf(`read:${path.basename(orderedPaths.latest)}`),
    );

    const raceDirectory = path.join(temp, "latest-parse-race");
    fs.mkdirSync(raceDirectory);
    const racePaths = createS5ArtifactPaths(IMAGE_IDS[3], raceDirectory);
    fs.writeFileSync(
      racePaths.latest,
      JSON.stringify({ status: "PASS", runId: RUN_ID }),
    );
    const raceOperations = Object.create(fs);
    let latestReads = 0;
    raceOperations.readFileSync = (...args) => {
      if (args[0] === racePaths.latest && ++latestReads === 2) {
        fs.writeFileSync(
          racePaths.latest,
          JSON.stringify({ status: "FAIL", runId: IMAGE_IDS[0] }),
        );
      }
      return fs.readFileSync(...args);
    };
    assert.throws(
      () => beginS5EvidenceRun(racePaths, IMAGE_IDS[3], raceOperations),
      /changed while parsing/u,
    );
    assert.equal(fs.existsSync(racePaths.lock), false);

    // A competing owner arriving at the canonical RUNNING mutation boundary
    // must keep both of its records byte-exact. The prior latest claim captures
    // and inspects the directory entry instead of replacing it by pathname.
    const claimDirectory = path.join(temp, "running-publication-claim-race");
    fs.mkdirSync(claimDirectory);
    const claimPaths = createS5ArtifactPaths(IMAGE_IDS[8], claimDirectory);
    fs.writeFileSync(
      claimPaths.latest,
      `${JSON.stringify({ status: "PASS", runId: RUN_ID }, null, 2)}\n`,
    );
    const foreignRunId = IMAGE_IDS[9];
    const foreignLockBytes = `${JSON.stringify(
      {
        schema: C12_29_S5_SCHEMA,
        runId: foreignRunId,
        status: "RUNNING",
        incomplete: true,
        acquiredAt: "2026-08-12T20:04:00.000Z",
      },
      null,
      2,
    )}\n`;
    const foreignLatestBytes = `${JSON.stringify(
      {
        schema: C12_29_S5_SCHEMA,
        runId: foreignRunId,
        status: "RUNNING",
        incomplete: true,
        startedAt: "2026-08-12T20:04:00.000Z",
      },
      null,
      2,
    )}\n`;
    const claimOperations = Object.create(fs);
    let foreignOwnerInjected = false;
    claimOperations.renameSync = (source, destination) => {
      if (!foreignOwnerInjected && source === claimPaths.latest) {
        foreignOwnerInjected = true;
        fs.unlinkSync(claimPaths.lock);
        fs.writeFileSync(claimPaths.lock, foreignLockBytes, { flag: "wx" });
        fs.writeFileSync(claimPaths.latest, foreignLatestBytes);
      }
      return fs.renameSync(source, destination);
    };
    assert.throws(
      () => beginS5EvidenceRun(claimPaths, IMAGE_IDS[8], claimOperations),
      /claimed foreign canonical latest/u,
    );
    assert.equal(foreignOwnerInjected, true);
    assert.equal(fs.readFileSync(claimPaths.lock, "utf8"), foreignLockBytes);
    assert.equal(
      fs.readFileSync(claimPaths.latest, "utf8"),
      foreignLatestBytes,
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("22 run then first-red then latest then unlock is ordered and write-once", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "c1229-s5-publish-"));
  const events = [];
  const operations = Object.create(fs);
  operations.writeFileSync = (...args) => {
    events.push(`write:${path.basename(args[0])}`);
    return fs.writeFileSync(...args);
  };
  operations.renameSync = (...args) => {
    events.push(`rename:${path.basename(args[1])}`);
    return fs.renameSync(...args);
  };
  operations.unlinkSync = (...args) => {
    events.push(`unlink:${path.basename(args[0])}`);
    return fs.unlinkSync(...args);
  };
  try {
    const paths = createS5ArtifactPaths(RUN_ID, temp);
    beginS5EvidenceRun(paths, RUN_ID, operations);
    events.length = 0;
    const artifact = {
      schema: C12_29_S5_SCHEMA,
      runId: RUN_ID,
      status: "FAIL",
      exitCode: 1,
      incomplete: false,
      artifactName: `${RUN_ID}.json`,
    };
    publishS5FinalArtifact(paths, artifact, operations);
    const runIndex = events.findIndex(
      (event) => event === `write:${RUN_ID}.json`,
    );
    const redIndex = events.findIndex((event) => event.includes("first-red"));
    const latestIndex = events.findIndex((event) =>
      event.includes("latest.json"),
    );
    const unlockIndex = events.findIndex((event) =>
      event.includes("lock.json"),
    );
    assert.ok(runIndex >= 0 && runIndex < redIndex && redIndex < latestIndex);
    assert.ok(latestIndex < unlockIndex);
    beginS5EvidenceRun(paths, RUN_ID, operations);
    assert.throws(
      () => publishS5FinalArtifact(paths, artifact, operations),
      /EEXIST/u,
    );

    const releaseRunId = IMAGE_IDS[0];
    const releasePaths = createS5ArtifactPaths(
      releaseRunId,
      path.join(temp, "release-failure"),
    );
    beginS5EvidenceRun(releasePaths, releaseRunId);
    const releaseOperations = Object.create(fs);
    releaseOperations.renameSync = (source, destination) => {
      if (source === releasePaths.lock) {
        const error = new Error("simulated lock release failure");
        error.code = "EACCES";
        throw error;
      }
      return fs.renameSync(source, destination);
    };
    assert.throws(
      () =>
        publishS5FinalArtifact(
          releasePaths,
          {
            ...artifact,
            runId: releaseRunId,
            status: "PASS",
            exitCode: 0,
            artifactName: `${releaseRunId}.json`,
          },
          releaseOperations,
        ),
      /lock release failure/u,
    );
    assert.equal(
      JSON.parse(fs.readFileSync(releasePaths.latest, "utf8")).status,
      "RUNNING",
    );
    assert.equal(fs.existsSync(releasePaths.lock), true);

    const silentReleaseRunId = IMAGE_IDS[3];
    const silentReleasePaths = createS5ArtifactPaths(
      silentReleaseRunId,
      path.join(temp, "silent-release-failure"),
    );
    beginS5EvidenceRun(silentReleasePaths, silentReleaseRunId);
    const silentReleaseOperations = Object.create(fs);
    silentReleaseOperations.renameSync = (source, destination) => {
      if (source === silentReleasePaths.lock) return undefined;
      return fs.renameSync(source, destination);
    };
    assert.throws(
      () =>
        publishS5FinalArtifact(
          silentReleasePaths,
          {
            ...artifact,
            runId: silentReleaseRunId,
            status: "PASS",
            exitCode: 0,
            artifactName: `${silentReleaseRunId}.json`,
          },
          silentReleaseOperations,
        ),
      /release claim could not be inspected/u,
    );
    assert.equal(
      JSON.parse(fs.readFileSync(silentReleasePaths.latest, "utf8")).status,
      "RUNNING",
    );
    assert.equal(fs.existsSync(silentReleasePaths.lock), true);

    // A filesystem wrapper may report unlink failure only after deleting the
    // owned lock. A failed RUNNING rewrite must not prevent independent lock
    // recreation or leave an apparently final canonical PASS without authority.
    const deletedReleaseRunId = IMAGE_IDS[4];
    const deletedReleasePaths = createS5ArtifactPaths(
      deletedReleaseRunId,
      path.join(temp, "deleted-release-failure"),
    );
    beginS5EvidenceRun(deletedReleasePaths, deletedReleaseRunId);
    const deletedReleaseOperations = Object.create(fs);
    let deletedReleaseLatestCreates = 0;
    let deletedReleaseLockRecreates = 0;
    let deletedReleaseAttempted = false;
    deletedReleaseOperations.renameSync = (source, destination) => {
      if (source === deletedReleasePaths.lock && !deletedReleaseAttempted) {
        deletedReleaseAttempted = true;
        fs.renameSync(source, destination);
        throw new Error("simulated lock release claim moved then threw");
      }
      return fs.renameSync(source, destination);
    };
    deletedReleaseOperations.writeFileSync = (file, ...args) => {
      if (
        file === deletedReleasePaths.latest &&
        deletedReleaseAttempted &&
        ++deletedReleaseLatestCreates >= 1
      ) {
        throw new Error("simulated RUNNING latest recovery failure");
      }
      if (file === deletedReleasePaths.lock && deletedReleaseAttempted) {
        deletedReleaseLockRecreates++;
      }
      return fs.writeFileSync(file, ...args);
    };
    let deletedReleaseError;
    assert.throws(
      () =>
        publishS5FinalArtifact(
          deletedReleasePaths,
          {
            ...artifact,
            runId: deletedReleaseRunId,
            status: "PASS",
            exitCode: 0,
            artifactName: `${deletedReleaseRunId}.json`,
          },
          deletedReleaseOperations,
        ),
      (error) => {
        deletedReleaseError = error;
        return (
          error instanceof AggregateError &&
          error.code === "S5_PUBLICATION_RECOVERY" &&
          error.s5Recovery?.lock?.ok === true &&
          error.s5Recovery?.latest?.ok === false &&
          /lock release claim moved then threw/u.test(error.message)
        );
      },
    );
    assert.equal(deletedReleaseError.errors.length, 2);
    assert.equal(deletedReleaseLockRecreates, 1);
    assert.equal(deletedReleaseLatestCreates, 3);
    assert.equal(fs.existsSync(deletedReleasePaths.latest), false);
    assert.ok(
      fs
        .readdirSync(deletedReleasePaths.directory)
        .some(
          (file) =>
            file.includes(".running-recovery-") && file.endsWith(".receipt"),
        ),
    );
    const recoveredDeletedReleaseLock = JSON.parse(
      fs.readFileSync(deletedReleasePaths.lock, "utf8"),
    );
    assert.equal(recoveredDeletedReleaseLock.schema, C12_29_S5_SCHEMA);
    assert.equal(recoveredDeletedReleaseLock.runId, deletedReleaseRunId);
    assert.equal(recoveredDeletedReleaseLock.status, "RUNNING");
    assert.equal(recoveredDeletedReleaseLock.incomplete, true);
    assert.match(
      recoveredDeletedReleaseLock.acquiredAt,
      /^\d{4}-\d{2}-\d{2}T/u,
    );

    // If the first lock recovery attempt fails, quarantine independently
    // reacquires the exact owned lock before it may mutate canonical latest.
    // A failed recovery-copy write then moves the exact final bytes atomically
    // into the UUID quarantine while that lock remains authoritative.
    const noAuthorityRunId = IMAGE_IDS[5];
    const noAuthorityPaths = createS5ArtifactPaths(
      noAuthorityRunId,
      path.join(temp, "no-authority-recovery"),
    );
    beginS5EvidenceRun(noAuthorityPaths, noAuthorityRunId);
    const noAuthorityOperations = Object.create(fs);
    let noAuthorityLatestReplaces = 0;
    let noAuthorityLockRecreates = 0;
    let noAuthorityReleaseAttempted = false;
    noAuthorityOperations.renameSync = (source, destination) => {
      if (
        destination === noAuthorityPaths.latest &&
        ++noAuthorityLatestReplaces >= 1
      ) {
        throw new Error("simulated persistent RUNNING latest recovery failure");
      }
      if (source === noAuthorityPaths.lock && !noAuthorityReleaseAttempted) {
        noAuthorityReleaseAttempted = true;
        fs.renameSync(source, destination);
        throw new Error("simulated destructive lock release failure");
      }
      return fs.renameSync(source, destination);
    };
    noAuthorityOperations.writeFileSync = (file, ...args) => {
      if (file === noAuthorityPaths.lock && noAuthorityReleaseAttempted) {
        noAuthorityLockRecreates++;
        if (noAuthorityLockRecreates <= 2) {
          throw new Error("simulated first owned lock recreation failure");
        }
      }
      if (file === noAuthorityPaths.recoveryLatest) {
        throw new Error("simulated recovery quarantine write failure");
      }
      return fs.writeFileSync(file, ...args);
    };
    const noAuthorityArtifact = {
      ...artifact,
      runId: noAuthorityRunId,
      status: "PASS",
      exitCode: 0,
      artifactName: `${noAuthorityRunId}.json`,
    };
    let noAuthorityError;
    assert.throws(
      () =>
        publishS5FinalArtifact(
          noAuthorityPaths,
          noAuthorityArtifact,
          noAuthorityOperations,
        ),
      (error) => {
        noAuthorityError = error;
        return (
          error instanceof AggregateError &&
          error.code === "S5_PUBLICATION_RECOVERY" &&
          error.s5Recovery?.lock?.ok === false &&
          error.s5Recovery?.latest?.ok === false &&
          error.s5Recovery?.finalLatest?.ok === true &&
          error.s5Recovery?.finalLatest?.lockAuthority === true &&
          error.s5Recovery?.finalLatest?.method ===
            "claimed-and-linked-to-quarantine" &&
          /recovery quarantine write failure/u.test(
            error.errors.map((entry) => entry.message).join(" | "),
          )
        );
      },
    );
    assert.ok(noAuthorityError.errors.length >= 5);
    assert.equal(noAuthorityLockRecreates, 3);
    assert.equal(noAuthorityLatestReplaces, 0);
    assert.equal(fs.existsSync(noAuthorityPaths.lock), true);
    assert.equal(
      JSON.parse(fs.readFileSync(noAuthorityPaths.lock, "utf8")).runId,
      noAuthorityRunId,
    );
    assert.equal(fs.existsSync(noAuthorityPaths.latest), false);
    assert.equal(
      fs.readFileSync(noAuthorityPaths.recoveryLatest, "utf8"),
      `${JSON.stringify(noAuthorityArtifact, null, 2)}\n`,
    );
    assert.equal(
      fs.readFileSync(noAuthorityPaths.run, "utf8"),
      `${JSON.stringify(noAuthorityArtifact, null, 2)}\n`,
    );

    // An absence observation is not authority. Install a genuine competing
    // RUNNING owner at the first no-lock latest verification and prove recovery
    // neither rewrites nor unlinks either foreign canonical record.
    const interleavingRunId = IMAGE_IDS[6];
    const competingRunId = IMAGE_IDS[7];
    const interleavingPaths = createS5ArtifactPaths(
      interleavingRunId,
      path.join(temp, "foreign-owner-interleaving"),
    );
    beginS5EvidenceRun(interleavingPaths, interleavingRunId);
    const competingLockBytes = `${JSON.stringify(
      {
        schema: C12_29_S5_SCHEMA,
        runId: competingRunId,
        status: "RUNNING",
        incomplete: true,
        acquiredAt: "2026-08-12T20:00:00.000Z",
      },
      null,
      2,
    )}\n`;
    const competingLatestBytes = `${JSON.stringify(
      {
        schema: C12_29_S5_SCHEMA,
        runId: competingRunId,
        status: "RUNNING",
        incomplete: true,
        startedAt: "2026-08-12T20:00:00.000Z",
      },
      null,
      2,
    )}\n`;
    const interleavingOperations = Object.create(fs);
    let interleavingReleaseAttempted = false;
    let competingOwnerInjected = false;
    let interleavingLatestReplaces = 0;
    let interleavingLatestUnlinks = 0;
    interleavingOperations.renameSync = (source, destination) => {
      if (destination === interleavingPaths.latest) {
        interleavingLatestReplaces++;
      }
      if (source === interleavingPaths.lock && !interleavingReleaseAttempted) {
        interleavingReleaseAttempted = true;
        fs.renameSync(source, destination);
        throw new Error("simulated destructive interleaving lock release");
      }
      return fs.renameSync(source, destination);
    };
    interleavingOperations.unlinkSync = (file) => {
      if (file === interleavingPaths.latest) interleavingLatestUnlinks++;
      return fs.unlinkSync(file);
    };
    interleavingOperations.writeFileSync = (file, ...args) => {
      if (file === interleavingPaths.lock && interleavingReleaseAttempted) {
        throw new Error("simulated interleaving own-lock recreation failure");
      }
      return fs.writeFileSync(file, ...args);
    };
    interleavingOperations.readFileSync = (file, ...args) => {
      if (
        file === interleavingPaths.latest &&
        interleavingReleaseAttempted &&
        !competingOwnerInjected
      ) {
        competingOwnerInjected = true;
        fs.writeFileSync(interleavingPaths.lock, competingLockBytes, {
          flag: "wx",
        });
        fs.writeFileSync(interleavingPaths.latest, competingLatestBytes);
      }
      return fs.readFileSync(file, ...args);
    };
    let interleavingError;
    assert.throws(
      () =>
        publishS5FinalArtifact(
          interleavingPaths,
          {
            ...artifact,
            runId: interleavingRunId,
            status: "PASS",
            exitCode: 0,
            artifactName: `${interleavingRunId}.json`,
          },
          interleavingOperations,
        ),
      (error) => {
        interleavingError = error;
        return (
          error instanceof AggregateError &&
          error.code === "S5_PUBLICATION_RECOVERY" &&
          error.s5Recovery?.lock?.ok === false &&
          error.s5Recovery?.latest?.ok === false &&
          error.s5Recovery?.latest?.method ===
            "verify-only-without-owned-lock" &&
          error.s5Recovery?.finalLatest?.ok === false &&
          error.s5Recovery?.finalLatest?.method ===
            "quarantine-lock-unavailable" &&
          error.s5Recovery?.finalLatest?.lockAuthority === false
        );
      },
    );
    assert.equal(interleavingError.errors.length, 4);
    assert.equal(competingOwnerInjected, true);
    assert.equal(interleavingLatestReplaces, 0);
    assert.equal(interleavingLatestUnlinks, 0);
    assert.equal(
      fs.readFileSync(interleavingPaths.lock, "utf8"),
      competingLockBytes,
    );
    assert.equal(
      fs.readFileSync(interleavingPaths.latest, "utf8"),
      competingLatestBytes,
    );
    assert.equal(fs.existsSync(interleavingPaths.recoveryLatest), false);

    const exerciseForeignPublicationBoundary = ({
      runId,
      foreignRunId,
      directoryName,
      boundary,
    }) => {
      const paths = createS5ArtifactPaths(
        runId,
        path.join(temp, directoryName),
      );
      beginS5EvidenceRun(paths, runId);
      const foreignLockBytes = `${JSON.stringify(
        {
          schema: C12_29_S5_SCHEMA,
          runId: foreignRunId,
          status: "RUNNING",
          incomplete: true,
          acquiredAt: "2026-08-12T20:00:30.000Z",
        },
        null,
        2,
      )}\n`;
      const foreignLatestBytes = `${JSON.stringify(
        {
          schema: C12_29_S5_SCHEMA,
          runId: foreignRunId,
          status: "RUNNING",
          incomplete: true,
          startedAt: "2026-08-12T20:00:30.000Z",
        },
        null,
        2,
      )}\n`;
      const operations = Object.create(fs);
      let injected = false;
      let canonicalUnlinks = 0;
      operations.renameSync = (source, destination) => {
        if (!injected && source === paths[boundary]) {
          injected = true;
          fs.unlinkSync(paths.lock);
          fs.writeFileSync(paths.lock, foreignLockBytes, { flag: "wx" });
          fs.writeFileSync(paths.latest, foreignLatestBytes);
        }
        return fs.renameSync(source, destination);
      };
      operations.unlinkSync = (file) => {
        if (file === paths.lock || file === paths.latest) canonicalUnlinks++;
        return fs.unlinkSync(file);
      };
      assert.throws(
        () =>
          publishS5FinalArtifact(
            paths,
            {
              ...artifact,
              runId,
              status: "PASS",
              exitCode: 0,
              artifactName: `${runId}.json`,
            },
            operations,
          ),
        (error) =>
          error.code === "S5_PUBLICATION_RECOVERY" &&
          error.s5Recovery?.lock?.ok === false &&
          error.s5Recovery?.latest?.ok === false &&
          error.s5Recovery?.finalLatest?.ok === false,
      );
      assert.equal(injected, true);
      assert.equal(canonicalUnlinks, 0);
      assert.equal(fs.readFileSync(paths.lock, "utf8"), foreignLockBytes);
      assert.equal(fs.readFileSync(paths.latest, "utf8"), foreignLatestBytes);
    };

    // Final publication claims RUNNING/latest and creates the final pathname
    // exclusively. A foreign owner installed at that claim boundary is kept
    // byte-for-byte instead of being overwritten by this run's PASS.
    exerciseForeignPublicationBoundary({
      runId: IMAGE_IDS[0],
      foreignRunId: IMAGE_IDS[1],
      directoryName: "foreign-owner-at-final-latest-claim",
      boundary: "latest",
    });

    // Lock release claims the canonical directory entry by rename. A foreign
    // lock swapped in at that exact boundary is restored and never unlinked by
    // the releasing run, while its matching foreign RUNNING latest survives.
    exerciseForeignPublicationBoundary({
      runId: IMAGE_IDS[2],
      foreignRunId: IMAGE_IDS[3],
      directoryName: "foreign-owner-at-lock-release-claim",
      boundary: "lock",
    });

    // Recovery also claims the exact final-looking latest before recreating
    // RUNNING exclusively. A foreign owner arriving at that exclusive-create
    // boundary must keep both canonical records byte-for-byte; rollback may
    // retain its UUID receipt, but it may not overwrite the foreign latest.
    const recoveryRaceRunId = IMAGE_IDS[4];
    const recoveryRaceForeignRunId = IMAGE_IDS[5];
    const recoveryRacePaths = createS5ArtifactPaths(
      recoveryRaceRunId,
      path.join(temp, "foreign-owner-at-running-recovery-create"),
    );
    beginS5EvidenceRun(recoveryRacePaths, recoveryRaceRunId);
    const recoveryRaceForeignLockBytes = `${JSON.stringify(
      {
        schema: C12_29_S5_SCHEMA,
        runId: recoveryRaceForeignRunId,
        status: "RUNNING",
        incomplete: true,
        acquiredAt: "2026-08-12T20:00:45.000Z",
      },
      null,
      2,
    )}\n`;
    const recoveryRaceForeignLatestBytes = `${JSON.stringify(
      {
        schema: C12_29_S5_SCHEMA,
        runId: recoveryRaceForeignRunId,
        status: "RUNNING",
        incomplete: true,
        startedAt: "2026-08-12T20:00:45.000Z",
      },
      null,
      2,
    )}\n`;
    const recoveryRaceOperations = Object.create(fs);
    let recoveryRaceReleaseFailed = false;
    let recoveryRaceInjected = false;
    let recoveryRaceForeignLatestMoves = 0;
    let recoveryRaceForeignLatestUnlinks = 0;
    recoveryRaceOperations.renameSync = (source, destination) => {
      if (source === recoveryRacePaths.lock && !recoveryRaceReleaseFailed) {
        recoveryRaceReleaseFailed = true;
        fs.renameSync(source, destination);
        throw new Error("simulated destructive release before recovery race");
      }
      if (recoveryRaceInjected && source === recoveryRacePaths.latest) {
        recoveryRaceForeignLatestMoves++;
      }
      return fs.renameSync(source, destination);
    };
    recoveryRaceOperations.unlinkSync = (file) => {
      if (recoveryRaceInjected && file === recoveryRacePaths.latest) {
        recoveryRaceForeignLatestUnlinks++;
      }
      return fs.unlinkSync(file);
    };
    recoveryRaceOperations.writeFileSync = (file, bytes, options) => {
      if (
        recoveryRaceReleaseFailed &&
        !recoveryRaceInjected &&
        file === recoveryRacePaths.latest &&
        options?.flag === "wx"
      ) {
        recoveryRaceInjected = true;
        fs.unlinkSync(recoveryRacePaths.lock);
        fs.writeFileSync(recoveryRacePaths.lock, recoveryRaceForeignLockBytes, {
          flag: "wx",
        });
        fs.writeFileSync(
          recoveryRacePaths.latest,
          recoveryRaceForeignLatestBytes,
          { flag: "wx" },
        );
      }
      return fs.writeFileSync(file, bytes, options);
    };
    assert.throws(
      () =>
        publishS5FinalArtifact(
          recoveryRacePaths,
          {
            ...artifact,
            runId: recoveryRaceRunId,
            status: "PASS",
            exitCode: 0,
            artifactName: `${recoveryRaceRunId}.json`,
          },
          recoveryRaceOperations,
        ),
      (error) =>
        error.code === "S5_PUBLICATION_RECOVERY" &&
        error.s5Recovery?.lock?.ok === true &&
        error.s5Recovery?.latest?.ok === false,
    );
    assert.equal(recoveryRaceInjected, true);
    assert.equal(recoveryRaceForeignLatestMoves, 0);
    assert.equal(recoveryRaceForeignLatestUnlinks, 0);
    assert.equal(
      fs.readFileSync(recoveryRacePaths.lock, "utf8"),
      recoveryRaceForeignLockBytes,
    );
    assert.equal(
      fs.readFileSync(recoveryRacePaths.latest, "utf8"),
      recoveryRaceForeignLatestBytes,
    );
    assert.ok(
      fs
        .readdirSync(recoveryRacePaths.directory)
        .some(
          (file) =>
            file.includes(".running-recovery-") && file.endsWith(".receipt"),
        ),
    );

    const installLateCompetitorAtClaim = ({
      paths,
      operations,
      receiptMarker,
    }) => {
      const lateLockBytes = `${JSON.stringify(
        {
          schema: C12_29_S5_SCHEMA,
          runId: IMAGE_IDS[7],
          status: "RUNNING",
          incomplete: true,
          acquiredAt: "2026-08-12T20:01:00.000Z",
        },
        null,
        2,
      )}\n`;
      const lateLatestBytes = `${JSON.stringify(
        {
          schema: C12_29_S5_SCHEMA,
          runId: IMAGE_IDS[7],
          status: "RUNNING",
          incomplete: true,
          startedAt: "2026-08-12T20:01:00.000Z",
        },
        null,
        2,
      )}\n`;
      let injected = false;
      let lateLatestUnlinks = 0;
      let lateLatestMoves = 0;
      const baseUnlink =
        operations.unlinkSync?.bind(operations) ?? fs.unlinkSync;
      operations.unlinkSync = (file) => {
        if (injected && file === paths.latest) lateLatestUnlinks++;
        return baseUnlink(file);
      };
      const baseRename =
        operations.renameSync?.bind(operations) ?? fs.renameSync;
      operations.renameSync = (source, destination) => {
        if (
          !injected &&
          source === paths.latest &&
          destination.includes(receiptMarker)
        ) {
          injected = true;
          fs.unlinkSync(paths.lock);
          fs.writeFileSync(paths.lock, lateLockBytes, { flag: "wx" });
          fs.unlinkSync(paths.latest);
          fs.writeFileSync(paths.latest, lateLatestBytes, { flag: "wx" });
        }
        if (injected && source === paths.latest) lateLatestMoves++;
        return baseRename(source, destination);
      };
      return {
        get injected() {
          return injected;
        },
        get lateLatestUnlinks() {
          return lateLatestUnlinks;
        },
        get lateLatestMoves() {
          return lateLatestMoves;
        },
        lateLockBytes,
        lateLatestBytes,
      };
    };

    // Copy-success path: install a foreign lock+matching RUNNING latest inside
    // the exact canonical claim call. The receipt may capture those bytes, but
    // the shared primitive must restore them exactly and never unlink them.
    const lateUnlinkRunId = IMAGE_IDS[8];
    const lateUnlinkPaths = createS5ArtifactPaths(
      lateUnlinkRunId,
      path.join(temp, "late-unlink-interleaving"),
    );
    beginS5EvidenceRun(lateUnlinkPaths, lateUnlinkRunId);
    const lateUnlinkOperations = Object.create(fs);
    let lateUnlinkReleaseAttempted = false;
    let lateUnlinkLockWrites = 0;
    lateUnlinkOperations.renameSync = (source, destination) => {
      if (source === lateUnlinkPaths.lock && !lateUnlinkReleaseAttempted) {
        lateUnlinkReleaseAttempted = true;
        fs.renameSync(source, destination);
        throw new Error("simulated late-unlink destructive release");
      }
      return fs.renameSync(source, destination);
    };
    lateUnlinkOperations.writeFileSync = (file, ...args) => {
      if (file === lateUnlinkPaths.lock && lateUnlinkReleaseAttempted) {
        lateUnlinkLockWrites++;
        if (lateUnlinkLockWrites <= 2) {
          throw new Error("simulated late-unlink first lock recovery failure");
        }
      }
      return fs.writeFileSync(file, ...args);
    };
    const lateUnlinkControl = installLateCompetitorAtClaim({
      paths: lateUnlinkPaths,
      operations: lateUnlinkOperations,
      receiptMarker: ".quarantine-copy-attempt-",
    });
    let lateUnlinkError;
    assert.throws(
      () =>
        publishS5FinalArtifact(
          lateUnlinkPaths,
          {
            ...artifact,
            runId: lateUnlinkRunId,
            status: "PASS",
            exitCode: 0,
            artifactName: `${lateUnlinkRunId}.json`,
          },
          lateUnlinkOperations,
        ),
      (error) => {
        lateUnlinkError = error;
        return (
          error.code === "S5_PUBLICATION_RECOVERY" &&
          error.s5Recovery?.finalLatest?.ok === false &&
          error.s5Recovery?.finalLatest?.lockAuthority === false
        );
      },
    );
    assert.equal(lateUnlinkControl.injected, true);
    assert.equal(lateUnlinkControl.lateLatestUnlinks, 0);
    assert.equal(lateUnlinkControl.lateLatestMoves, 1);
    assert.ok(lateUnlinkError.errors.length >= 3);
    assert.equal(
      fs.readFileSync(lateUnlinkPaths.lock, "utf8"),
      lateUnlinkControl.lateLockBytes,
    );
    assert.equal(
      fs.readFileSync(lateUnlinkPaths.latest, "utf8"),
      lateUnlinkControl.lateLatestBytes,
    );

    // Fallback path: fail the recovery-copy write, then install a foreign pair
    // inside the fallback claim. Its latest is restored from the exact receipt;
    // the owned final remains safely archived under its UUID.
    const lateMoveRunId = IMAGE_IDS[9];
    const lateMovePaths = createS5ArtifactPaths(
      lateMoveRunId,
      path.join(temp, "late-move-interleaving"),
    );
    beginS5EvidenceRun(lateMovePaths, lateMoveRunId);
    const lateMoveOperations = Object.create(fs);
    let lateMoveReleaseAttempted = false;
    let lateMoveLockWrites = 0;
    lateMoveOperations.renameSync = (source, destination) => {
      if (source === lateMovePaths.lock && !lateMoveReleaseAttempted) {
        lateMoveReleaseAttempted = true;
        fs.renameSync(source, destination);
        throw new Error("simulated late-move destructive release");
      }
      return fs.renameSync(source, destination);
    };
    lateMoveOperations.writeFileSync = (file, ...args) => {
      if (file === lateMovePaths.lock && lateMoveReleaseAttempted) {
        lateMoveLockWrites++;
        if (lateMoveLockWrites <= 2) {
          throw new Error("simulated late-move first lock recovery failure");
        }
      }
      if (file === lateMovePaths.recoveryLatest) {
        throw new Error("simulated late-move recovery-copy failure");
      }
      return fs.writeFileSync(file, ...args);
    };
    const lateMoveControl = installLateCompetitorAtClaim({
      paths: lateMovePaths,
      operations: lateMoveOperations,
      receiptMarker: ".quarantine-fallback-",
    });
    assert.throws(
      () =>
        publishS5FinalArtifact(
          lateMovePaths,
          {
            ...artifact,
            runId: lateMoveRunId,
            status: "PASS",
            exitCode: 0,
            artifactName: `${lateMoveRunId}.json`,
          },
          lateMoveOperations,
        ),
      (error) =>
        error.code === "S5_PUBLICATION_RECOVERY" &&
        error.s5Recovery?.finalLatest?.ok === false &&
        error.s5Recovery?.finalLatest?.lockAuthority === false,
    );
    assert.equal(lateMoveControl.injected, true);
    assert.equal(lateMoveControl.lateLatestUnlinks, 0);
    assert.equal(lateMoveControl.lateLatestMoves, 1);
    assert.equal(
      fs.readFileSync(lateMovePaths.lock, "utf8"),
      lateMoveControl.lateLockBytes,
    );
    assert.equal(
      fs.readFileSync(lateMovePaths.latest, "utf8"),
      lateMoveControl.lateLatestBytes,
    );

    const makeClaimRecoveryOperations = (paths, onLatestClaim) => {
      const operations = Object.create(fs);
      let releaseAttempted = false;
      let lockRecreates = 0;
      let latestReplaces = 0;
      let latestClaims = 0;
      let latestUnlinks = 0;
      operations.renameSync = (source, destination) => {
        if (destination === paths.latest && ++latestReplaces >= 1) {
          throw new Error("simulated persistent RUNNING restore failure");
        }
        if (source === paths.lock && !releaseAttempted) {
          releaseAttempted = true;
          fs.renameSync(source, destination);
          throw new Error("simulated destructive lock release failure");
        }
        if (
          source === paths.latest &&
          destination.includes(".quarantine-copy-attempt-")
        ) {
          latestClaims++;
          return onLatestClaim(latestClaims, source, destination);
        }
        return fs.renameSync(source, destination);
      };
      operations.writeFileSync = (file, ...args) => {
        if (file === paths.lock && releaseAttempted && ++lockRecreates <= 2) {
          throw new Error("simulated first owned lock recovery failure");
        }
        return fs.writeFileSync(file, ...args);
      };
      operations.unlinkSync = (file) => {
        if (file === paths.latest) {
          latestUnlinks++;
        }
        return fs.unlinkSync(file);
      };
      return {
        operations,
        get lockRecreates() {
          return lockRecreates;
        },
        get latestReplaces() {
          return latestReplaces;
        },
        get latestClaims() {
          return latestClaims;
        },
        get latestUnlinks() {
          return latestUnlinks;
        },
      };
    };
    const makeRemovalArtifact = (runId) => ({
      ...artifact,
      runId,
      status: "PASS",
      exitCode: 0,
      artifactName: `${runId}.json`,
    });

    // A transient claim exception that leaves the exact owned final in place
    // must use the second bounded attempt under the same exact lock.
    const retryRemovalRunId = IMAGE_IDS[5];
    const retryRemovalPaths = createS5ArtifactPaths(
      retryRemovalRunId,
      path.join(temp, "retry-removal-after-transient-error"),
    );
    beginS5EvidenceRun(retryRemovalPaths, retryRemovalRunId);
    const retryRemovalControl = makeClaimRecoveryOperations(
      retryRemovalPaths,
      (attempt, source, destination) => {
        if (attempt === 1) {
          throw new Error("simulated transient pre-claim rename failure");
        }
        return fs.renameSync(source, destination);
      },
    );
    const retryRemovalArtifact = makeRemovalArtifact(retryRemovalRunId);
    assert.throws(
      () =>
        publishS5FinalArtifact(
          retryRemovalPaths,
          retryRemovalArtifact,
          retryRemovalControl.operations,
        ),
      (error) =>
        error.code === "S5_PUBLICATION_RECOVERY" &&
        error.s5Recovery?.finalLatest?.ok === true &&
        error.s5Recovery?.finalLatest?.method ===
          "quarantined-by-receipt-attempt-2" &&
        error.s5Recovery?.finalLatest?.lockAuthority === true,
    );
    assert.equal(retryRemovalControl.lockRecreates, 3);
    assert.equal(retryRemovalControl.latestReplaces, 0);
    assert.equal(retryRemovalControl.latestClaims, 2);
    assert.equal(retryRemovalControl.latestUnlinks, 0);
    assert.equal(fs.existsSync(retryRemovalPaths.latest), false);
    assert.equal(
      fs.readFileSync(retryRemovalPaths.recoveryLatest, "utf8"),
      `${JSON.stringify(retryRemovalArtifact, null, 2)}\n`,
    );
    assert.equal(
      JSON.parse(fs.readFileSync(retryRemovalPaths.lock, "utf8")).runId,
      retryRemovalRunId,
    );

    // Rename-then-throw restores the exact claimed bytes exclusively; the
    // second bounded claim then retains them in its identity-bearing receipt.
    const deletedRemovalRunId = IMAGE_IDS[6];
    const deletedRemovalPaths = createS5ArtifactPaths(
      deletedRemovalRunId,
      path.join(temp, "deleted-removal-then-threw"),
    );
    beginS5EvidenceRun(deletedRemovalPaths, deletedRemovalRunId);
    const deletedRemovalControl = makeClaimRecoveryOperations(
      deletedRemovalPaths,
      (attempt, source, destination) => {
        fs.renameSync(source, destination);
        if (attempt === 1) {
          throw new Error("simulated latest claim renamed then threw");
        }
      },
    );
    const deletedRemovalArtifact = makeRemovalArtifact(deletedRemovalRunId);
    assert.throws(
      () =>
        publishS5FinalArtifact(
          deletedRemovalPaths,
          deletedRemovalArtifact,
          deletedRemovalControl.operations,
        ),
      (error) =>
        error.code === "S5_PUBLICATION_RECOVERY" &&
        error.s5Recovery?.finalLatest?.ok === true &&
        error.s5Recovery?.finalLatest?.method ===
          "quarantined-by-receipt-attempt-2" &&
        error.s5Recovery?.finalLatest?.lockAuthority === true,
    );
    assert.equal(deletedRemovalControl.latestClaims, 2);
    assert.equal(deletedRemovalControl.latestUnlinks, 0);
    assert.equal(fs.existsSync(deletedRemovalPaths.latest), false);
    assert.equal(
      fs.readFileSync(deletedRemovalPaths.recoveryLatest, "utf8"),
      `${JSON.stringify(deletedRemovalArtifact, null, 2)}\n`,
    );
    assert.equal(
      JSON.parse(fs.readFileSync(deletedRemovalPaths.lock, "utf8")).runId,
      deletedRemovalRunId,
    );

    // If the lock becomes foreign only after the owned latest was claimed, the
    // claim is restored exactly and cleanup must not claim authority.
    const postUnlinkRunId = IMAGE_IDS[8];
    const postUnlinkForeignRunId = IMAGE_IDS[9];
    const postUnlinkPaths = createS5ArtifactPaths(
      postUnlinkRunId,
      path.join(temp, "post-unlink-foreign-lock"),
    );
    beginS5EvidenceRun(postUnlinkPaths, postUnlinkRunId);
    const postUnlinkForeignLockBytes = `${JSON.stringify(
      {
        schema: C12_29_S5_SCHEMA,
        runId: postUnlinkForeignRunId,
        status: "RUNNING",
        incomplete: true,
        acquiredAt: "2026-08-12T20:02:00.000Z",
      },
      null,
      2,
    )}\n`;
    const postUnlinkControl = makeClaimRecoveryOperations(
      postUnlinkPaths,
      (_attempt, source, destination) => {
        fs.renameSync(source, destination);
        fs.unlinkSync(postUnlinkPaths.lock);
        fs.writeFileSync(postUnlinkPaths.lock, postUnlinkForeignLockBytes, {
          flag: "wx",
        });
      },
    );
    const postUnlinkArtifact = makeRemovalArtifact(postUnlinkRunId);
    assert.throws(
      () =>
        publishS5FinalArtifact(
          postUnlinkPaths,
          postUnlinkArtifact,
          postUnlinkControl.operations,
        ),
      (error) =>
        error.code === "S5_PUBLICATION_RECOVERY" &&
        error.s5Recovery?.finalLatest?.ok === false &&
        error.s5Recovery?.finalLatest?.method === "receipt-claim-failed" &&
        error.s5Recovery?.finalLatest?.lockAuthority === false,
    );
    assert.equal(postUnlinkControl.latestClaims, 1);
    assert.equal(postUnlinkControl.latestUnlinks, 0);
    assert.equal(
      fs.readFileSync(postUnlinkPaths.latest, "utf8"),
      `${JSON.stringify(postUnlinkArtifact, null, 2)}\n`,
    );
    assert.equal(
      fs.readFileSync(postUnlinkPaths.recoveryLatest, "utf8"),
      `${JSON.stringify(postUnlinkArtifact, null, 2)}\n`,
    );
    assert.equal(
      fs.readFileSync(postUnlinkPaths.lock, "utf8"),
      postUnlinkForeignLockBytes,
    );

    // Canonical absence itself is not lock authority. Swap in a foreign lock
    // only after quarantine's first ENOENT read and prove the already-absent
    // branch ends red without rewriting either canonical path.
    const absentAuthorityRunId = IMAGE_IDS[3];
    const absentAuthorityForeignRunId = IMAGE_IDS[4];
    const absentAuthorityPaths = createS5ArtifactPaths(
      absentAuthorityRunId,
      path.join(temp, "already-absent-foreign-lock"),
    );
    beginS5EvidenceRun(absentAuthorityPaths, absentAuthorityRunId);
    const absentAuthorityForeignLockBytes = `${JSON.stringify(
      {
        schema: C12_29_S5_SCHEMA,
        runId: absentAuthorityForeignRunId,
        status: "RUNNING",
        incomplete: true,
        acquiredAt: "2026-08-12T20:03:00.000Z",
      },
      null,
      2,
    )}\n`;
    const absentAuthorityOperations = Object.create(fs);
    let absentAuthorityReleaseAttempted = false;
    let absentAuthorityLockRecreates = 0;
    let absentAuthorityInjected = false;
    absentAuthorityOperations.renameSync = (source, destination) => {
      if (
        source === absentAuthorityPaths.lock &&
        !absentAuthorityReleaseAttempted
      ) {
        absentAuthorityReleaseAttempted = true;
        fs.renameSync(source, destination);
        fs.unlinkSync(absentAuthorityPaths.latest);
        throw new Error("simulated release removed lock and canonical latest");
      }
      return fs.renameSync(source, destination);
    };
    absentAuthorityOperations.writeFileSync = (file, ...args) => {
      if (
        file === absentAuthorityPaths.lock &&
        absentAuthorityReleaseAttempted
      ) {
        absentAuthorityLockRecreates++;
        if (absentAuthorityLockRecreates <= 2) {
          throw new Error("simulated first absent-state lock recovery failure");
        }
      }
      return fs.writeFileSync(file, ...args);
    };
    absentAuthorityOperations.readFileSync = (file, ...args) => {
      try {
        return fs.readFileSync(file, ...args);
      } catch (error) {
        if (
          file === absentAuthorityPaths.latest &&
          error?.code === "ENOENT" &&
          absentAuthorityLockRecreates >= 3 &&
          !absentAuthorityInjected
        ) {
          absentAuthorityInjected = true;
          fs.unlinkSync(absentAuthorityPaths.lock);
          fs.writeFileSync(
            absentAuthorityPaths.lock,
            absentAuthorityForeignLockBytes,
            { flag: "wx" },
          );
        }
        throw error;
      }
    };
    const absentAuthorityArtifact = makeRemovalArtifact(absentAuthorityRunId);
    assert.throws(
      () =>
        publishS5FinalArtifact(
          absentAuthorityPaths,
          absentAuthorityArtifact,
          absentAuthorityOperations,
        ),
      (error) =>
        error.code === "S5_PUBLICATION_RECOVERY" &&
        error.s5Recovery?.lock?.ok === false &&
        error.s5Recovery?.latest?.ok === false &&
        error.s5Recovery?.finalLatest?.ok === false &&
        error.s5Recovery?.finalLatest?.method ===
          "already-absent-authority-lost" &&
        error.s5Recovery?.finalLatest?.lockAuthority === false,
    );
    assert.equal(absentAuthorityInjected, true);
    assert.equal(absentAuthorityLockRecreates, 3);
    assert.equal(fs.existsSync(absentAuthorityPaths.latest), false);
    assert.equal(fs.existsSync(absentAuthorityPaths.recoveryLatest), false);
    assert.equal(
      fs.readFileSync(absentAuthorityPaths.lock, "utf8"),
      absentAuthorityForeignLockBytes,
    );
    assert.equal(
      fs.readFileSync(absentAuthorityPaths.run, "utf8"),
      `${JSON.stringify(absentAuthorityArtifact, null, 2)}\n`,
    );

    const archiveRunId = IMAGE_IDS[1];
    const archivePaths = createS5ArtifactPaths(
      archiveRunId,
      path.join(temp, "archive-corruption"),
    );
    beginS5EvidenceRun(archivePaths, archiveRunId);
    const archiveOperations = Object.create(fs);
    archiveOperations.writeFileSync = (file, bytes, options) => {
      if (file === archivePaths.run) {
        return fs.writeFileSync(file, "{}\n", options);
      }
      return fs.writeFileSync(file, bytes, options);
    };
    assert.throws(
      () =>
        publishS5FinalArtifact(
          archivePaths,
          {
            ...artifact,
            runId: archiveRunId,
            status: "PASS",
            exitCode: 0,
            artifactName: `${archiveRunId}.json`,
          },
          archiveOperations,
        ),
      /immutable run archive bytes differ/u,
    );
    assert.equal(
      JSON.parse(fs.readFileSync(archivePaths.latest, "utf8")).status,
      "RUNNING",
    );
    assert.equal(fs.existsSync(archivePaths.lock), true);

    const latestRunId = IMAGE_IDS[2];
    const latestPaths = createS5ArtifactPaths(
      latestRunId,
      path.join(temp, "latest-corruption"),
    );
    beginS5EvidenceRun(latestPaths, latestRunId);
    const latestOperations = Object.create(fs);
    let corruptNextFinalCreate = true;
    latestOperations.writeFileSync = (file, bytes, options) => {
      const result = fs.writeFileSync(file, bytes, options);
      if (file === latestPaths.latest && corruptNextFinalCreate) {
        corruptNextFinalCreate = false;
        fs.appendFileSync(file, " ");
      }
      return result;
    };
    assert.throws(
      () =>
        publishS5FinalArtifact(
          latestPaths,
          {
            ...artifact,
            runId: latestRunId,
            status: "PASS",
            exitCode: 0,
            artifactName: `${latestRunId}.json`,
          },
          latestOperations,
        ),
      /canonical final latest bytes differ/u,
    );
    assert.equal(
      JSON.parse(fs.readFileSync(latestPaths.latest, "utf8")).status,
      "RUNNING",
    );
    assert.equal(fs.existsSync(latestPaths.lock), true);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("23 canonical same-task capture block is exact and has no unfused reader", () => {
  assert.deepEqual(checkEmbeddedCaptureIsCanonical(probeSource), []);
  assert.deepEqual(checkFusedCaptureUsage(probeSource), []);
  assert.match(probeSource, /const dataUrl = grabNow\(\);/u);
  assert.doesNotMatch(probeSource, /grabNow\(\);\s*await/gu);
});

test("24 static seams, ordering, exact imports, and forbidden operations are pinned", () => {
  assert.equal((specSource.match(/^test\(/gmu) ?? []).length, 24);
  assert.equal(C12_29_S5_SOURCE_FILES.length, 35);
  assert.equal(new Set(C12_29_S5_SOURCE_FILES).size, 35);
  assert.equal(C12_29_S5_BUILD_SOURCE_FILES.length, 33);
  assert.equal(
    C12_29_S5_SOURCE_FILES.includes(C12_29_S5_WEBGPU_LAYOUT_FILE),
    true,
  );
  const provider = fs.readFileSync(
    path.join(
      repositoryRoot,
      "packages/engine/Source/Scene/GlobeSurfaceTileProvider.js",
    ),
    "utf8",
  );
  const capture = fs.readFileSync(
    path.join(
      repositoryRoot,
      "packages/engine/Source/Renderer/WebGPU/WebGPUDynamicEnvironmentMapCapture.ts",
    ),
    "utf8",
  );
  const layouts = fs.readFileSync(
    path.join(repositoryRoot, C12_29_S5_WEBGPU_LAYOUT_FILE),
    "utf8",
  );
  const pickFramebuffer = fs.readFileSync(
    path.join(
      repositoryRoot,
      "packages/engine/Source/Scene/PickFramebuffer.js",
    ),
    "utf8",
  );
  const sync = fs.readFileSync(
    path.join(repositoryRoot, "packages/engine/Source/Renderer/Sync.js"),
    "utf8",
  );
  const sceneUtilities = fs.readFileSync(
    path.join(repositoryRoot, "packages/engine/Source/Scene/SceneUtilities.js"),
    "utf8",
  );
  const scene = fs.readFileSync(
    path.join(repositoryRoot, "packages/engine/Source/Scene/Scene.js"),
    "utf8",
  );
  assert.match(
    provider,
    /set terrainProvider\(terrainProvider\)[\s\S]*?_eclipseSurfaceRadius = undefined;[\s\S]*?resetKnownTerrainEclipseBounds\(this\)/u,
  );
  assert.match(
    provider,
    /observeTerrainMeshForEclipse\(this, tile\.data\?\.mesh\);/u,
  );
  assert.doesNotMatch(
    provider.replace(
      "observeTerrainMeshForEclipse(this, tile.data?.mesh);",
      "",
    ),
    /observeTerrainMeshForEclipse\(this, tile\.data\?\.mesh\);/u,
  );
  assert.match(
    provider,
    /const ECLIPSE_FILL_SKIRT_ALLOWANCE_METERS = 1000\.0;[\s\S]*?const exaggeratedMinimumHeight = VerticalExaggeration\.getHeight\(\s*tileProvider\._eclipseKnownMinimumHeight -\s*ECLIPSE_FILL_SKIRT_ALLOWANCE_METERS,\s*exaggeration,\s*relativeHeight,\s*\);/u,
  );
  assert.match(
    provider,
    /updateEclipseGlobeShadowForFrameState\([\s\S]*?_eclipseSelectionRevision[\s\S]*?for \([\s\S]*?tilesToRenderByTextureCount/u,
  );
  assert.match(
    provider,
    /updateForPick\(frameState\)[\s\S]*?updateEclipseGlobeShadowForFrameState/u,
  );
  assert.ok(
    capture.indexOf("updateEclipseGlobeShadowForFrameState(") <
      capture.indexOf("for (let face = 0; face < 6; face++)"),
  );
  assert.match(
    layouts,
    /uniformBuffer\(2, Stage\.FRAGMENT,[\s\S]*?hasDynamicOffset: true/u,
  );
  assert.match(
    pickFramebuffer,
    /await sync\.waitForSignal\(\(next\) => frameState\.afterRender\.push\(next\)\);/u,
  );
  assert.match(
    sync,
    /scheduleFunction\(waitForSignal0\(resolve, reject, ttl - 1\)\);/u,
  );
  assert.match(
    sceneUtilities,
    /const functionsCpy = functions\.slice\(\);[\s\S]*?functions\.length = 0;[\s\S]*?functionsCpy\[i\]\(\)/u,
  );
  assert.match(scene, /callAfterRenderFunctions\(this\);/u);
  assert.match(
    scene,
    /scene\.globe\.beginFrame\(frameState\);[\s\S]*?scene\.updateEnvironment\(\);/u,
  );
  assert.deepEqual(inspectS5WebGPUEclipseBinding(), {
    ok: true,
    file: C12_29_S5_WEBGPU_LAYOUT_FILE,
    binding: C12_29_S5_WEBGPU_ECLIPSE_BINDING,
    stage: "FRAGMENT",
    hasDynamicOffset: true,
    minimumSizeSymbol: "ECLIPSE_UNIFORM_BYTES",
    exactMarkerCount: 1,
  });
  assert.equal(
    inspectS5WebGPUEclipseBinding("ignored", {
      readFileSync: () => layouts.replace("uniformBuffer(2", "uniformBuffer(3"),
    }).ok,
    false,
  );
  assert.match(
    probeSource,
    /import \{[\s\S]*?inspectBuildSourceIdentity,[\s\S]*?validateServedEntryIdentities,[\s\S]*?from "\.\/lib\/build-source-identity\.mjs";/u,
  );
  assert.doesNotMatch(
    probeSource,
    /\b(?:Ion|createWorldTerrain|Terrain\.fromWorldTerrain)\b/u,
  );
  assert.doesNotMatch(probeSource, /\brunSceneCapture\s*\(/u);
  assert.doesNotMatch(probeSource, /GPUDevice\.destroy\s*\(/u);
  assert.doesNotMatch(probeSource, /\.(?:pickEllipsoid|pickPosition)\s*\(/u);
  assert.doesNotMatch(probeSource, /await\s+scene\.pickAsync\s*\(/u);
  assert.equal(
    (probeSource.match(/globe\.beginFrame = function \(frameState\)/gu) ?? [])
      .length,
    2,
  );
  assert.match(
    probeSource,
    /const result = originalGlobeBeginFrame\.call\(this, frameState\);[\s\S]*?terrainRequestAttemptsAtObservation[\s\S]*?selectionRevisionUnchanged/u,
  );
  assert.match(
    probeSource,
    /const result = originalFinalGlobeBeginFrame\.call\(this, frameState\);[\s\S]*?freshTerrainRequestAttempts[\s\S]*?selectionRevisionUnchanged/u,
  );
  assert.match(
    probeSource,
    /terrainData instanceof C\.QuantizedMeshTerrainData/u,
  );
  assert.doesNotMatch(probeSource, /terrainData\?\.constructor\?\.name/u);
  assert.ok(
    probeSource.indexOf("holdEnabled = false;") <
      probeSource.indexOf(
        "for (const entry of held.values()) entry.resolve(entry.terrainData);",
      ),
  );
  assert.match(
    probeSource,
    /const callOrdinal = updateForPickCalls;[\s\S]*?pickPostcondition = \{[\s\S]*?callOrdinal[\s\S]*?pickExpected = \{[\s\S]*?callOrdinal/u,
  );
  assert.match(
    probeSource,
    /const pickOperation = scene\.pickAsync\([\s\S]*?await awaitFrameDrivenOperation\([\s\S]*?contract\.pickMaxPumpFrames/u,
  );
  assert.match(
    probeSource,
    /globalThis\.__c1229S5Progress = progress;[\s\S]*?terrainRequests[\s\S]*?requestLedger/u,
  );
  assert.match(
    probeSource,
    /diagnostics:\s*cloneS5DiagnosticValue\(error\?\.s5Diagnostics\)/u,
  );
  assert.doesNotMatch(
    probeSource,
    /(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:build|start|serve)/u,
  );
});
