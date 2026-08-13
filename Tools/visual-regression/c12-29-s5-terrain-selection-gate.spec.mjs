import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  C12_29_S5_LOW_DETAIL_FILL,
  C12_29_S5_PHASES,
  C12_29_S5_PICK_FRAME_DRIVER,
  C12_29_S5_PICK_MAX_PUMP_FRAMES,
  C12_29_S5_PAGE_VALIDATION_FAILURE_FIELDS,
  C12_29_S5_PAGE_VALIDATION_REASONS,
  C12_29_S5_RAW_PAGE_MAX_ARRAY_LENGTH,
  C12_29_S5_RAW_PAGE_MAX_KEY_LENGTH,
  C12_29_S5_RAW_PAGE_MAX_JSON_LENGTH,
  C12_29_S5_RAW_PAGE_MAX_STRING_LENGTH,
  C12_29_S5_RENDERERS,
  C12_29_S5_REVEAL_LIFECYCLE,
  C12_29_S5_SCENE,
  C12_29_S5_SCHEMA,
  C12_29_S5_SOURCE_FILES,
  C12_29_S5_WEBGPU_ECLIPSE_BINDING,
  C12_29_S5_WEBGPU_LAYOUT_FILE,
  C12_29_S5_WEBGPU_PREWARM_MAX_FRAMES,
  computeExpectedTerrainSurfaceRadius,
  createS5PageValidationWitness,
  deriveS5SouthLevelOneTarget,
  evaluateS5ControlledVisibilityObservation,
  exitCodeForS5Status,
  foldC1229S5Gate,
  isUuidV4,
  validateS5FinalArtifactShape,
  validateS5PageDiagnosticProjection,
  validateS5PageProgress,
  validateS5RawPageDiagnosticJson,
} from "./lib/c12-29-s5-terrain-selection-gate.mjs";
import {
  awaitS5PageMeasurement,
  beginS5EvidenceRun,
  boundS5RawPageDiagnostic,
  classifyS5PageDiagnosticValue,
  createS5ArtifactPaths,
  inspectS5PriorState,
  inspectS5QuantizedMeshHeader,
  inspectS5WebGPUEclipseBinding,
  materializeS5CanonicalJsonValue,
  publishS5FinalArtifact,
  redactS5OutputPayload,
  serializeS5Artifact,
  snapshotS5PageProgress,
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
const V4_SCHEMA = "c12-29-s5-terrain-selection-evidence-v4";
const V5_SCHEMA = "c12-29-s5-terrain-selection-evidence-v5";
const V6_SCHEMA = "c12-29-s5-terrain-selection-evidence-v6";
const V7_SCHEMA = "c12-29-s5-terrain-selection-evidence-v7";
const V8_SCHEMA = "c12-29-s5-terrain-selection-evidence-v8";
const V9_SCHEMA = "c12-29-s5-terrain-selection-evidence-v9";
const diagnosticSha256 = (value) =>
  createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

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
const heldTarget = deriveS5SouthLevelOneTarget(
  SYNTHETIC_TRACK.longitude,
  SYNTHETIC_TRACK.latitude,
);
const siblingKey = heldTarget.anchorKey;
const FILL_SSE = C12_29_S5_SCENE.fillFrontierMaximumScreenSpaceError;

function selectionObservation(tileId, frame, rawResult, name) {
  return {
    tileId,
    instantiated: true,
    selectionFrame: frame,
    resultFrame: frame,
    sameFrame: true,
    rawResult,
    rawResultName: name,
    originalResult: rawResult,
    originalResultName: name,
    wasKicked: false,
  };
}

function visibilityCall({
  ordinal,
  frameNumber,
  tileKey,
  mode,
  originalVisibility,
  returnedVisibility = originalVisibility,
}) {
  const name = (value) => ["PARTIAL", "FULL"][value] ?? "NONE";
  return {
    ordinal,
    frameNumber,
    tileKey,
    mode,
    target: tileKey === heldTarget.key,
    originalCallCompleted: true,
    originalVisibility,
    originalVisibilityName: name(originalVisibility),
    returnedVisibility,
    returnedVisibilityName: name(returnedVisibility),
    overridden: !Object.is(originalVisibility, returnedVisibility),
  };
}

const visibilityCalls = Object.freeze([
  visibilityCall({
    ordinal: 1,
    frameNumber: 20,
    tileKey: heldTarget.parentKey,
    mode: "warm-mask",
    originalVisibility: 1,
  }),
  visibilityCall({
    ordinal: 2,
    frameNumber: 20,
    tileKey: heldTarget.key,
    mode: "warm-mask",
    originalVisibility: 0,
    returnedVisibility: -1,
  }),
  visibilityCall({
    ordinal: 3,
    frameNumber: 20,
    tileKey: siblingKey,
    mode: "warm-mask",
    originalVisibility: 1,
  }),
  visibilityCall({
    ordinal: 4,
    frameNumber: 21,
    tileKey: heldTarget.parentKey,
    mode: "pass-through",
    originalVisibility: 1,
  }),
  visibilityCall({
    ordinal: 5,
    frameNumber: 21,
    tileKey: heldTarget.key,
    mode: "pass-through",
    originalVisibility: 0,
  }),
  visibilityCall({
    ordinal: 6,
    frameNumber: 21,
    tileKey: siblingKey,
    mode: "pass-through",
    originalVisibility: 1,
  }),
]);
const visibilityCounts = Object.freeze({
  totalCalls: visibilityCalls.length,
  originalCalls: visibilityCalls.length,
  targetCalls: 2,
  nonTargetCalls: 4,
  overrideCalls: 1,
  nonTargetAlteredCalls: 0,
  skippedOriginalCalls: 0,
});
const sseDenominator = 2 * Math.tan((55 * Math.PI) / 360);
const levelZeroGeometricError = 77_067.34;
const levelOneGeometricError = levelZeroGeometricError / 2;
const parentDistance = 8_000_000;
const targetDistance = 8_000_000;
const parentComputedSse =
  (levelZeroGeometricError * C12_29_S5_SCENE.viewport.height) /
  (parentDistance * sseDenominator);
const targetComputedSse =
  (levelOneGeometricError * C12_29_S5_SCENE.viewport.height) /
  (targetDistance * sseDenominator);

function syntheticTileState(overrides = {}) {
  return {
    instantiated: true,
    quadtreeState: C12_29_S5_REVEAL_LIFECYCLE.quadtreeStart,
    renderable: true,
    dataDefined: true,
    terrainState: C12_29_S5_REVEAL_LIFECYCLE.terrainUnloaded,
    terrainDataDefined: false,
    realMeshDefined: false,
    vertexArrayDefined: false,
    fillDefined: false,
    fillMeshDefined: false,
    renderedMeshDefined: false,
    renderedMeshMatchesReal: false,
    renderedMeshMatchesFill: false,
    terrainFillMeshInstance: false,
    vertexCountWithoutSkirts: 0,
    indexCountWithoutSkirts: 0,
    verticesLength: 0,
    stride: 0,
    derivedVertexCount: 0,
    indexCount: 0,
    ...overrides,
  };
}

function providerFlags(hasLoadedTilesThisFrame, hasFillTilesThisFrame) {
  return {
    hasLoadedTilesThisFrame,
    hasFillTilesThisFrame,
    loadedAndFillFlags: hasLoadedTilesThisFrame && hasFillTilesThisFrame,
  };
}

function syntheticOrderInstallation() {
  return {
    originalIdentityCaptured: true,
    prototypeDescriptorFound: true,
    beforeHadOwn: false,
    beforeDescriptor: null,
    installedHadOwn: true,
    installedDescriptor: {
      configurable: true,
      enumerable: false,
      writable: true,
      hasValue: true,
      hasGetter: false,
      hasSetter: false,
    },
    installedWrapperIdentityMatches: true,
  };
}

function syntheticOrderProof() {
  const emptyTarget = syntheticTileState();
  const filledTarget = syntheticTileState({
    quadtreeState: C12_29_S5_REVEAL_LIFECYCLE.quadtreeLoading,
    fillDefined: true,
    fillMeshDefined: true,
    renderedMeshDefined: true,
    renderedMeshMatchesFill: true,
    terrainFillMeshInstance: true,
    vertexCountWithoutSkirts:
      C12_29_S5_LOW_DETAIL_FILL.vertexCountWithoutSkirts,
    indexCountWithoutSkirts: C12_29_S5_LOW_DETAIL_FILL.indexCountWithoutSkirts,
    verticesLength: C12_29_S5_LOW_DETAIL_FILL.derivedVertexCount * 6,
    stride: 6,
    derivedVertexCount: C12_29_S5_LOW_DETAIL_FILL.derivedVertexCount,
    indexCount: C12_29_S5_LOW_DETAIL_FILL.totalIndexCount,
  });
  const realSibling = syntheticTileState({
    quadtreeState: C12_29_S5_REVEAL_LIFECYCLE.quadtreeLoading,
    terrainDataDefined: true,
    realMeshDefined: true,
    vertexArrayDefined: true,
    renderedMeshDefined: true,
    renderedMeshMatchesReal: true,
  });
  return {
    state: "restored",
    targetKey: heldTarget.key,
    eventCount: 6,
    installation: {
      showTileThisFrame: syntheticOrderInstallation(),
      endUpdate: syntheticOrderInstallation(),
    },
    showTileThisFrameCalls: [
      {
        ordinal: 1,
        enterEventOrdinal: 1,
        exitEventOrdinal: 2,
        frameNumber: 21,
        tileKey: siblingKey,
        target: false,
        tileStateBefore: realSibling,
        tileStateAfter: realSibling,
        providerFlagsBefore: providerFlags(false, false),
        providerFlagsAfter: providerFlags(true, false),
      },
      {
        ordinal: 2,
        enterEventOrdinal: 3,
        exitEventOrdinal: 4,
        frameNumber: 21,
        tileKey: heldTarget.key,
        target: true,
        tileStateBefore: emptyTarget,
        tileStateAfter: emptyTarget,
        providerFlagsBefore: providerFlags(true, false),
        providerFlagsAfter: providerFlags(true, true),
      },
    ],
    endUpdateCalls: [
      {
        ordinal: 1,
        enterEventOrdinal: 5,
        exitEventOrdinal: 6,
        frameNumber: 21,
        targetStateBefore: emptyTarget,
        targetStateAfter: filledTarget,
        providerFlagsBefore: providerFlags(true, true),
        providerFlagsAfter: providerFlags(true, true),
      },
    ],
    restoration: {
      attempted: true,
      attemptedAt: "immediately-after-reveal-snapshot",
      restored: true,
      showIdentityMatches: true,
      showDescriptorMatches: true,
      endIdentityMatches: true,
      endDescriptorMatches: true,
      finallyVerified: true,
    },
  };
}

function syntheticFirstReveal(revealTargetSelection, revealSiblingSelection) {
  const targetState = syntheticTileState({
    quadtreeState: C12_29_S5_REVEAL_LIFECYCLE.quadtreeLoading,
    terrainState: C12_29_S5_REVEAL_LIFECYCLE.terrainReceiving,
    fillDefined: true,
    fillMeshDefined: true,
    renderedMeshDefined: true,
    renderedMeshMatchesFill: true,
    terrainFillMeshInstance: true,
    vertexCountWithoutSkirts:
      C12_29_S5_LOW_DETAIL_FILL.vertexCountWithoutSkirts,
    indexCountWithoutSkirts: C12_29_S5_LOW_DETAIL_FILL.indexCountWithoutSkirts,
    verticesLength: C12_29_S5_LOW_DETAIL_FILL.derivedVertexCount * 6,
    stride: 6,
    derivedVertexCount: C12_29_S5_LOW_DETAIL_FILL.derivedVertexCount,
    indexCount: C12_29_S5_LOW_DETAIL_FILL.totalIndexCount,
  });
  return {
    state: "evaluated",
    targetKey: heldTarget.key,
    captureWasFirstRenderAfterPassThrough: true,
    sameTaskModeSwitchAndCapture: true,
    noYieldBeforeCapture: true,
    warmFrame: 20,
    frameBefore: 20,
    frameAfter: 21,
    frameDelta: 1,
    longitude: SYNTHETIC_TRACK.longitude,
    latitude: SYNTHETIC_TRACK.latitude,
    cameraHeightMeters: C12_29_S5_SCENE.cameraHeightMeters,
    cameraFovDegrees: C12_29_S5_SCENE.cameraFovDegrees,
    maximumScreenSpaceError: FILL_SSE,
    targetRequestAttemptsBefore: 0,
    targetRequestAttemptsAfter: 1,
    postArmTargetRequestAttempts: 1,
    targetSelection: revealTargetSelection,
    visibilityTargetCallOrdinals: [5],
    visibilityCalls: [{ ...visibilityCalls[4] }],
    selectedTileIds: [siblingKey, heldTarget.key].sort(),
    realTileIds: [siblingKey],
    fillTileIds: [heldTarget.key],
    selectedCount: 2,
    realMeshCount: 1,
    fillCount: 1,
    targetSelectedDescendantTileIds: [heldTarget.key],
    targetRealDescendantTileIds: [],
    targetFillDescendantTileIds: [heldTarget.key],
    targetSelectedStrictDescendantTileIds: [],
    targetRealStrictDescendantTileIds: [],
    targetFillStrictDescendantTileIds: [],
    selectedRealSiblingTileIds: [siblingKey],
    selectedRealSiblingObservations: [revealSiblingSelection],
    siblingKey,
    heldKeys: [heldTarget.key],
    reservedKeys: [heldTarget.key],
    heldRequestCount: 1,
    reservedPromiseCount: 1,
    releasedRequestCount: 0,
    rejectedRequestCount: 0,
    targetHeldPromisePresent: true,
    targetReservedPromisePresent: true,
    providerFlags: providerFlags(true, true),
    loadedAndFillFlags: true,
    tilesLoaded: false,
    targetSelected: true,
    targetReal: false,
    targetFill: true,
    targetState,
    fillMesh: {
      tileId: heldTarget.key,
      fillDefined: true,
      fillMeshDefined: true,
      renderedMeshDefined: true,
      realMeshDefined: false,
      terrainFillMeshInstance: true,
      renderedMeshMatches: true,
      realMeshAbsent: true,
      vertexCountWithoutSkirts:
        C12_29_S5_LOW_DETAIL_FILL.vertexCountWithoutSkirts,
      indexCountWithoutSkirts:
        C12_29_S5_LOW_DETAIL_FILL.indexCountWithoutSkirts,
      verticesLength: C12_29_S5_LOW_DETAIL_FILL.derivedVertexCount * 6,
      stride: 6,
      derivedVertexCount: C12_29_S5_LOW_DETAIL_FILL.derivedVertexCount,
      indexCount: C12_29_S5_LOW_DETAIL_FILL.totalIndexCount,
    },
    restoration: {
      visibilityRestored: true,
      orderInstrumentationRestored: true,
    },
    predicateResults: Object.fromEntries(
      [
        "captureWasFirstRenderAfterPassThrough",
        "sameTaskModeSwitchAndCapture",
        "noYieldBeforeCapture",
        "consecutiveWarmAndRevealFrames",
        "exactlyOnePostArmTargetRequest",
        "exactHeldTargetSet",
        "exactReservedTargetSet",
        "targetSameFrameRendered",
        "targetVisibilityPassThrough",
        "targetSelected",
        "targetFill",
        "targetRealAbsent",
        "terrainFillMeshInstance",
        "renderedMeshMatchesFill",
        "realMeshAbsent",
        "positiveVertexCount",
        "positiveIndexCount",
        "noSelectedStrictDescendants",
        "noRealStrictDescendants",
        "noFillStrictDescendants",
        "anchorSiblingRendered",
        "providerLoadedAndFillFlags",
        "targetShownExactlyOnce",
        "targetShowBeforeEndUpdate",
        "endUpdateExactlyOnce",
        "coherentSameFrameOrderSurfaces",
        "postEndUpdateLoadTransitionExact",
        "showMarkedFillBeforeEndUpdate",
        "exactLowDetailFillMeshShape",
        "endUpdateConstructedFill",
        "visibilityRestored",
        "orderInstrumentationRestored",
      ].map((key) => [key, true]),
    ),
  };
}

function syntheticProgress(renderer = "webgl") {
  const revealTargetSelection = selectionObservation(
    heldTarget.key,
    21,
    2,
    "RENDERED",
  );
  const revealSiblingSelection = selectionObservation(
    siblingKey,
    21,
    2,
    "RENDERED",
  );
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
    firstReveal: syntheticFirstReveal(
      revealTargetSelection,
      revealSiblingSelection,
    ),
    orderProof: syntheticOrderProof(),
    visibilitySeam: {
      state: "restored",
      targetKey: heldTarget.key,
      mode: "restored",
      config: {
        claim:
          "controlled-visibility-input-production-selection-request-fill-release-render",
        maximumScreenSpaceError: FILL_SSE,
        cameraHeightMeters: C12_29_S5_SCENE.cameraHeightMeters,
        cameraFovDegrees: C12_29_S5_SCENE.cameraFovDegrees,
        maskMode: "warm-only-exact-target-Visibility.NONE",
      },
      calls: visibilityCalls.map((call) => ({ ...call })),
      counts: { ...visibilityCounts },
      terminalReason: null,
      restoration: {
        attempted: true,
        restored: true,
        identityMatches: true,
        descriptorMatches: true,
      },
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
  const warmTargetSelection = selectionObservation(
    heldTarget.key,
    20,
    1,
    "CULLED",
  );
  const warmParentSelection = selectionObservation(
    heldTarget.parentKey,
    20,
    3,
    "REFINED",
  );
  const warmSiblingSelection = selectionObservation(
    siblingKey,
    20,
    2,
    "RENDERED",
  );
  const revealTargetSelection = selectionObservation(
    heldTarget.key,
    21,
    2,
    "RENDERED",
  );
  const revealSiblingSelection = selectionObservation(
    siblingKey,
    21,
    2,
    "RENDERED",
  );
  const phases = {
    [C12_29_S5_PHASES[0]]: {
      provider: "EllipsoidTerrainProvider",
      stable: true,
      tilesLoaded: true,
      selectedCount: 2,
      selectedTileIds: [siblingKey, heldTarget.key].sort(),
      fillLodPrecondition: {
        claim: "fixed-camera-direct-level-one-no-scan",
        derivation: "pinned-sse-production-selection",
        target: heldTarget,
        siblingKey,
        maximumScreenSpaceError: FILL_SSE,
        longitude: SYNTHETIC_TRACK.longitude,
        latitude: SYNTHETIC_TRACK.latitude,
        cameraFovDegrees: C12_29_S5_SCENE.cameraFovDegrees,
        cameraHeightMeters: C12_29_S5_SCENE.cameraHeightMeters,
        preloadSiblings: false,
        preloadAncestors: false,
        cameraReference: {
          cameraCartographicInsideTarget: false,
          referenceFrameOriginDefined: false,
          referenceFrameOriginInsideTarget: false,
          neededPositionInsideTarget: false,
        },
        sseInputs: {
          drawingBufferHeight: C12_29_S5_SCENE.viewport.height,
          pixelRatio: 1,
          sseDenominator,
          levelZeroGeometricError,
          levelOneGeometricError,
          parentDistance,
          targetDistance,
          parentComputedSse,
          targetComputedSse,
        },
        selectedTileIds: [siblingKey, heldTarget.key].sort(),
        realTileIds: [siblingKey, heldTarget.key].sort(),
        fillTileIds: [],
        parentSelection: selectionObservation(
          heldTarget.parentKey,
          10,
          3,
          "REFINED",
        ),
        targetSelection: selectionObservation(
          heldTarget.key,
          10,
          2,
          "RENDERED",
        ),
        siblingSelection: selectionObservation(siblingKey, 10, 2, "RENDERED"),
      },
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
      selectedTileIds: [siblingKey, heldTarget.key].sort(),
      selectedCount: 2,
      realTileIds: [siblingKey],
      holdTarget: heldTarget,
      warmup: {
        proofCompletedBeforeArm: true,
        settled: true,
        boundedMaxFrames: C12_29_S5_SCENE.fillWarmMaximumFrames,
        settleFrames: 4,
        stableFrames: 3,
        tilesLoaded: true,
        fillCount: 0,
        longitude: SYNTHETIC_TRACK.longitude,
        latitude: SYNTHETIC_TRACK.latitude,
        cameraHeightMeters: C12_29_S5_SCENE.cameraHeightMeters,
        cameraFovDegrees: C12_29_S5_SCENE.cameraFovDegrees,
        maximumScreenSpaceError: FILL_SSE,
        preloadSiblings: false,
        preloadAncestors: false,
        holdTargetUndefinedDuringWarmup: true,
        holdInterceptionEnabled: false,
        heldRequestCount: 0,
        reservedPromiseCount: 0,
        targetKey: heldTarget.key,
        targetRequestAttempts: 0,
        targetHeldPromisePresent: false,
        targetReservedPromisePresent: false,
        selectedTileIds: [siblingKey],
        realTileIds: [siblingKey],
        fillTileIds: [],
        targetSelectedDescendantTileIds: [],
        targetRealDescendantTileIds: [],
        targetFillDescendantTileIds: [],
        parentSelection: warmParentSelection,
        targetSelection: warmTargetSelection,
        visibilityTargetCallOrdinals: [2],
        cameraReference: {
          cameraCartographicInsideTarget: false,
          referenceFrameOriginDefined: false,
          referenceFrameOriginInsideTarget: false,
          neededPositionInsideTarget: false,
        },
        sseInputs: {
          drawingBufferHeight: C12_29_S5_SCENE.viewport.height,
          pixelRatio: 1,
          sseDenominator,
          levelZeroGeometricError,
          levelOneGeometricError,
          parentDistance,
          targetDistance,
          parentComputedSse,
          targetComputedSse,
        },
        selectedRealSiblingTileIds: [siblingKey],
        selectedRealSiblingObservations: [warmSiblingSelection],
        siblingKey,
      },
      holdArm: {
        afterSettledWarmup: true,
        assignedAfterWarmProof: true,
        warmProofFrame: 20,
        targetKey: heldTarget.key,
        holdInterceptionEnabledBefore: false,
        targetRequestAttemptsBefore: 0,
        targetReservedBefore: false,
        heldRequestCountBefore: 0,
        visibilityModeBefore: "warm-mask",
        visibilityModeAfter: "pass-through",
        cameraMovedForReveal: false,
        cameraFovDegrees: C12_29_S5_SCENE.cameraFovDegrees,
        cameraHeightMeters: C12_29_S5_SCENE.cameraHeightMeters,
        maximumScreenSpaceError: FILL_SSE,
        holdInterceptionEnabledAfter: true,
      },
      firstRevealProof: syntheticFirstReveal(
        revealTargetSelection,
        revealSiblingSelection,
      ),
      orderProof: syntheticOrderProof(),
      visibilitySeam: {
        claim:
          "controlled-visibility-input-production-selection-request-fill-release-render",
        method: "GlobeSurfaceTileProvider.computeTileVisibility",
        maskMode: "warm-only-exact-target-Visibility.NONE",
        targetKey: heldTarget.key,
        siblingKey,
        maximumScreenSpaceError: FILL_SSE,
        installation: {
          originalIdentityCaptured: true,
          prototypeDescriptorFound: true,
          beforeHadOwn: false,
          beforeDescriptor: null,
          installedHadOwn: true,
          installedDescriptor: {
            configurable: true,
            enumerable: false,
            writable: true,
            hasValue: true,
            hasGetter: false,
            hasSetter: false,
          },
          installedWrapperIdentityMatches: true,
        },
        calls: visibilityCalls.map((call) => ({ ...call })),
        counts: { ...visibilityCounts },
        warmTargetCallOrdinals: [2],
        revealTargetCallOrdinals: [5],
        modeSwitch: {
          from: "warm-mask",
          to: "pass-through",
          warmFrame: 20,
          revealFrame: 21,
          sameTaskReveal: true,
        },
        restoration: {
          attempted: true,
          attemptedAt: "immediately-after-reveal-snapshot",
          restored: true,
          immediateAfterReveal: true,
          beforeRelease: true,
          afterHadOwn: false,
          afterDescriptor: null,
          identityMatches: true,
          descriptorMatches: true,
          finallyVerified: true,
        },
      },
      holdInterceptionEnabled: true,
      cameraFovDegrees: C12_29_S5_SCENE.cameraFovDegrees,
      maximumScreenSpaceError: FILL_SSE,
      preloadSiblings: false,
      holdTargetRequestAttemptsAfterArm: 1,
      holdTargetReserved: true,
      heldRequestCount: 1,
      heldKeys: [heldTarget.key],
      fillCount: 1,
      fillTileIds: [heldTarget.key],
      loadedAndFillFlags: true,
      heldTargetIntersectsSelectedFill: true,
      realSiblingTileIds: [siblingKey],
      heldDecodeWaitFrames: 1,
      heldTargetDecodedBeforeRelease: true,
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
      selectedTileIds: [heldTarget.key],
      selectedCount: 1,
      holdTargetKey: heldTarget.key,
      settled: true,
      tilesLoaded: true,
      fillTileIds: [],
      fillCount: 0,
      decodedQuantizedMeshCount: 2,
      realTileIds: [heldTarget.key],
      realMeshCount: 1,
      holdInterceptionEnabled: false,
      visibilitySeamRestoredBeforeRelease: true,
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
      trackRestore: {
        settled: true,
        boundedMaxFrames: 240,
        settleFrames: 4,
        stableFrames: 3,
        longitude: SYNTHETIC_TRACK.longitude,
        latitude: SYNTHETIC_TRACK.latitude,
        cameraHeightMeters: C12_29_S5_SCENE.cameraHeightMeters,
        cameraFovDegrees: C12_29_S5_SCENE.cameraFovDegrees,
        maximumScreenSpaceError: C12_29_S5_SCENE.terrainMaximumScreenSpaceError,
        targetLongitude: SYNTHETIC_TRACK.longitude,
        targetLatitude: SYNTHETIC_TRACK.latitude,
      },
    },
    [C12_29_S5_PHASES[4]]: {
      ...radiusInput,
      settled: true,
      tilesLoaded: true,
      selectedCount: selectedTileIds.length,
      realTileIds: [...selectedTileIds],
      realMeshCount: selectedTileIds.length,
      fillTileIds: [],
      fillCount: 0,
      expectedSurfaceRadius: radius.radius,
      surfaceRadius: radius.radius,
      mainViewOwnerMatches: true,
      prepared: true,
      preparedSelectionRevision: 17,
      providerSelectionRevision: 17,
      preparedSurfaceRadius: radius.radius,
      preparedSelectedTileIds: [...selectedTileIds],
      selectedTileIds: [...selectedTileIds],
      webgpuCommandMaterializationPrewarm:
        renderer === "webgpu"
          ? {
              applicable: true,
              off: {
                applicable: true,
                boundedMaxFrames: C12_29_S5_WEBGPU_PREWARM_MAX_FRAMES,
                frames: 2,
                settled: true,
                carrierState: "OFF",
                eclipseEnabled: false,
                lightingFlagMatches: true,
                frameShadowPrepared: true,
                frameShadowActive: false,
                frameShadowGate: 0,
                frameShadowRevision: 20,
                frameSelectionRevision: 17,
                route: "scene.frameState.commandList/Pass.GLOBE/native-WebGPU",
                commandIdentity: "isWebGPUDrawCommand===true+pass===Pass.GLOBE",
                emittedCommandCount: 2,
                materializedCommandCount: 2,
                positiveIndexCommandCount: 2,
                threeDynamicOffsetCommandCount: 2,
                pipelineIdentityIds: ["pipeline-1"],
                pipelineLabels: [],
                ownerTileIds: [...selectedTileIds],
                frameNumber: 40,
              },
              on: {
                applicable: true,
                boundedMaxFrames: C12_29_S5_WEBGPU_PREWARM_MAX_FRAMES,
                frames: 1,
                settled: true,
                carrierState: "ON",
                eclipseEnabled: true,
                lightingFlagMatches: true,
                frameShadowPrepared: true,
                frameShadowActive: true,
                frameShadowGate: 1,
                frameShadowRevision: 21,
                frameSelectionRevision: 17,
                route: "scene.frameState.commandList/Pass.GLOBE/native-WebGPU",
                commandIdentity: "isWebGPUDrawCommand===true+pass===Pass.GLOBE",
                emittedCommandCount: 2,
                materializedCommandCount: 2,
                positiveIndexCommandCount: 2,
                threeDynamicOffsetCommandCount: 2,
                pipelineIdentityIds: ["pipeline-1"],
                pipelineLabels: [],
                ownerTileIds: [...selectedTileIds],
                frameNumber: 42,
              },
              expectedOwnerTileIds: [...selectedTileIds],
              sameMaterializedPipelines: true,
              offBeforeOn: true,
              terminalCapturesAfterPrewarm: { off: true, on: true },
            }
          : {
              applicable: false,
              reason: "WebGPU-only native globe command materialization",
            },
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
        claimSource: "bounded-post-first-beginFrame-settle",
        immediateSnapshotUsedForClaim: false,
        immediateSnapshot: {
          selectedCount: 0,
          tilesLoaded: false,
          selectionRevision: 30,
        },
        settled: true,
        boundedMaxFrames: 180,
        settleFrames: 4,
        stableFrames: 3,
        tilesLoaded: true,
        contentRevisionAdvanced: true,
        contentRevision: 10,
        providerIsFreshEllipsoid: true,
        tileProviderMatchesFreshEllipsoid: true,
        selectionRevisionAdvanced: true,
        selectionRevision: 31,
        selectedCount: 1,
        terrainRequestAttempts: 2,
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
      ignoredConsoleErrors: [],
      gpuErrors: [],
      deviceLost: false,
      deviceLostReason: null,
      deviceLostMessage: null,
      cleanupComplete: true,
    },
    deviceGate: {
      gpuErrors: [],
      deviceLost: false,
    },
    sameTaskCapture: {
      method: C12_29_S5_CAPTURE_METHOD,
      canonicalSourcePinned: true,
      yieldBetweenRenderAndRead: false,
    },
  };
}

function syntheticBuildSourceIdentity() {
  return {
    ok: true,
    entries: C12_29_S5_BUILD_SOURCE_FILES.map((file, index) => {
      const byteLength = 1000 + index;
      const sha256 = (index % 16).toString(16).repeat(64);
      return {
        file: path.join(repositoryRoot, file),
        sourceMapEntry: `../../${file}`,
        currentByteLength: byteLength,
        embeddedByteLength: byteLength,
        currentSha256: sha256,
        embeddedSha256: sha256,
        exact: true,
        reason: null,
      };
    }),
    reasons: [],
    sourceMapPath: path.join(
      repositoryRoot,
      "Build/CesiumUnminified/index.js.map",
    ),
    sourceMapByteLength: 1_000_000,
    sourceMapSha256: "f".repeat(64),
  };
}

function syntheticSourceIdentities() {
  return C12_29_S5_SOURCE_FILES.map((file, index) => {
    const buildIndex = C12_29_S5_BUILD_SOURCE_FILES.indexOf(file);
    return {
      file: path.join(repositoryRoot, file),
      exists: true,
      byteLength: buildIndex >= 0 ? 1_000 + buildIndex : 2_000 + index,
      sha256:
        buildIndex >= 0
          ? (buildIndex % 16).toString(16).repeat(64)
          : ((index + 3) % 16).toString(16).repeat(64),
    };
  });
}

function syntheticSourceLocalIdentity(identities) {
  return Object.fromEntries(
    identities.map((identity, index) => [
      `source${String(index).padStart(2, "0")}`,
      structuredClone(identity),
    ]),
  );
}

function greenReport() {
  const buildSourceIdentity = syntheticBuildSourceIdentity();
  const sourceIdentities = syntheticSourceIdentities();
  const sourceLocalIdentity = syntheticSourceLocalIdentity(sourceIdentities);
  const report = {
    schema: C12_29_S5_SCHEMA,
    runId: RUN_ID,
    provenance: {
      ok: true,
      stable: true,
      reasons: [],
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
        identities: structuredClone(sourceIdentities),
        allReadable: true,
      },
      buildSourceIdentity,
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
        observedLabels: [...C12_29_S5_RENDERERS],
        reasons: [],
      },
      harnessStable: true,
      start: {
        reasons: [],
        localIdentity: structuredClone(sourceLocalIdentity),
        buildSourceIdentity: structuredClone(buildSourceIdentity),
      },
      end: {
        reasons: [],
        localIdentity: structuredClone(sourceLocalIdentity),
        buildSourceIdentity: structuredClone(buildSourceIdentity),
      },
    },
    sessions: C12_29_S5_RENDERERS.map(syntheticSession),
  };
  return materializeS5CanonicalJsonValue(report, "synthetic green S5 report")
    .value;
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
  assert.equal(
    verdict.status,
    "PASS",
    JSON.stringify({
      structuralReasons: verdict.structuralReasons,
      failureReasons: verdict.failureReasons,
    }),
  );
  assert.equal(verdict.exitCode, 0);
  assert.equal(C12_29_S5_SCHEMA, "c12-29-s5-terrain-selection-evidence-v10");
  assert.equal(
    C12_29_S5_DIAGNOSTICS_SCHEMA,
    "c12-29-s5-runtime-diagnostics-v5",
  );
  assert.equal(verdict.checks.sourceBoundaryCount, 43);
  assert.equal(verdict.checks.buildSourceBoundaryCount, 41);
  for (const session of greenReport().sessions) {
    assert.deepEqual(Object.keys(session.deviceGate), [
      "gpuErrors",
      "deviceLost",
    ]);
    assert.deepEqual(Object.keys(session.runtime), [
      "pageErrors",
      "consoleErrors",
      "ignoredConsoleErrors",
      "gpuErrors",
      "deviceLost",
      "deviceLostReason",
      "deviceLostMessage",
      "cleanupComplete",
    ]);
  }
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
  const finalizedV4Artifact = { ...artifact, schema: V4_SCHEMA };
  assert.equal(validateS5FinalArtifactShape(finalizedV4Artifact).ok, false);
  const v4Report = greenReport();
  v4Report.schema = V4_SCHEMA;
  assert.equal(foldC1229S5Gate(v4Report).status, "STRUCTURAL");
  const v5Report = greenReport();
  v5Report.schema = V5_SCHEMA;
  assert.equal(foldC1229S5Gate(v5Report).status, "STRUCTURAL");
  const v6Report = greenReport();
  v6Report.schema = V6_SCHEMA;
  assert.equal(foldC1229S5Gate(v6Report).status, "STRUCTURAL");
  const v7Report = greenReport();
  v7Report.schema = V7_SCHEMA;
  assert.equal(foldC1229S5Gate(v7Report).status, "STRUCTURAL");
  const v8Report = greenReport();
  v8Report.schema = V8_SCHEMA;
  assert.equal(foldC1229S5Gate(v8Report).status, "STRUCTURAL");
  const v9Report = greenReport();
  v9Report.schema = V9_SCHEMA;
  assert.equal(foldC1229S5Gate(v9Report).status, "STRUCTURAL");
  assert.equal(
    validateS5FinalArtifactShape({ ...artifact, schema: V7_SCHEMA }).ok,
    false,
  );
  assert.equal(
    validateS5FinalArtifactShape({ ...artifact, schema: V8_SCHEMA }).ok,
    false,
  );
  assert.equal(
    validateS5FinalArtifactShape({ ...artifact, schema: V9_SCHEMA }).ok,
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
      timeoutMs: 240_000,
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
      ...classifyS5PageDiagnosticValue(syntheticProgress(), "webgl"),
    },
  };
  assert.equal(validateS5FinalArtifactShape(errorArtifact).ok, true);
  const v8ErrorArtifact = structuredClone(errorArtifact);
  v8ErrorArtifact.schema = V8_SCHEMA;
  v8ErrorArtifact.diagnostics.schema = "c12-29-s5-runtime-diagnostics-v4";
  v8ErrorArtifact.diagnostics.page.schema = "c12-29-s5-runtime-diagnostics-v4";
  v8ErrorArtifact.diagnostics.page.validationWitness.schema =
    "c12-29-s5-runtime-diagnostics-v4";
  v8ErrorArtifact.diagnostics.pageValidation.diagnosticSha256 =
    diagnosticSha256(v8ErrorArtifact.diagnostics.page);
  assert.equal(validateS5FinalArtifactShape(v8ErrorArtifact).ok, false);
  const v8Progress = syntheticProgress();
  v8Progress.schema = "c12-29-s5-runtime-diagnostics-v4";
  assert.equal(validateS5PageProgress(v8Progress, "webgl").ok, false);
  assert.equal(
    validateS5PageDiagnosticProjection(errorArtifact.diagnostics.page, "webgl"),
    true,
  );
  assert.equal(validateS5PageProgress(syntheticProgress()).ok, true);
  const startedProgress = syntheticProgress();
  startedProgress.completedPhases = C12_29_S5_PHASES.slice(0, 2);
  startedProgress.firstReveal.state = "started";
  for (const key of [
    "captureWasFirstRenderAfterPassThrough",
    "frameAfter",
    "frameDelta",
    "longitude",
    "latitude",
    "cameraHeightMeters",
    "cameraFovDegrees",
    "maximumScreenSpaceError",
    "targetRequestAttemptsAfter",
    "postArmTargetRequestAttempts",
    "targetSelection",
    "selectedCount",
    "realMeshCount",
    "fillCount",
    "heldRequestCount",
    "reservedPromiseCount",
    "releasedRequestCount",
    "rejectedRequestCount",
    "targetHeldPromisePresent",
    "targetReservedPromisePresent",
    "providerFlags",
    "loadedAndFillFlags",
    "tilesLoaded",
    "targetSelected",
    "targetReal",
    "targetFill",
    "targetState",
    "fillMesh",
    "predicateResults",
  ]) {
    startedProgress.firstReveal[key] = null;
  }
  for (const key of [
    "visibilityTargetCallOrdinals",
    "visibilityCalls",
    "selectedTileIds",
    "realTileIds",
    "fillTileIds",
    "targetSelectedDescendantTileIds",
    "targetRealDescendantTileIds",
    "targetFillDescendantTileIds",
    "targetSelectedStrictDescendantTileIds",
    "targetRealStrictDescendantTileIds",
    "targetFillStrictDescendantTileIds",
    "selectedRealSiblingTileIds",
    "selectedRealSiblingObservations",
    "heldKeys",
    "reservedKeys",
  ]) {
    startedProgress.firstReveal[key] = [];
  }
  startedProgress.firstReveal.restoration = {
    visibilityRestored: true,
    orderInstrumentationRestored: true,
  };
  startedProgress.orderProof.state = "error-restored";
  startedProgress.orderProof.restoration.attemptedAt = "finally-after-error";
  startedProgress.currentPhase = C12_29_S5_PHASES[2];
  startedProgress.step = "first-pass-through-render-and-fused-fill-capture";
  assert.equal(validateS5PageProgress(startedProgress).ok, true);
  startedProgress.firstReveal.targetRequestAttemptsBefore = 0.5;
  assert.equal(validateS5PageProgress(startedProgress).ok, false);
  const contradictoryProgress = syntheticProgress();
  contradictoryProgress.orderProof.endUpdateCalls[0].targetStateAfter.terrainState =
    C12_29_S5_REVEAL_LIFECYCLE.terrainReceiving;
  contradictoryProgress.firstReveal.predicateResults.postEndUpdateLoadTransitionExact = false;
  contradictoryProgress.visibilitySeam.terminalReason =
    "first pass-through render did not produce the exact held L1 fill";
  assert.equal(validateS5PageProgress(contradictoryProgress).ok, true);
  assert.equal(
    validateS5PageProgress({
      ...syntheticProgress(),
      completedPhases: [C12_29_S5_PHASES[1]],
    }).ok,
    false,
  );
  for (const mutateVisibilityProgress of [
    (progress) => delete progress.visibilitySeam,
    (progress) => progress.visibilitySeam.counts.originalCalls--,
    (progress) => (progress.visibilitySeam.calls[0].overridden = true),
    (progress) => (progress.visibilitySeam.targetKey = "2/0/0"),
    (progress) => (progress.visibilitySeam.restoration.identityMatches = false),
    (progress) => delete progress.firstReveal,
    (progress) => (progress.firstReveal.predicateResults.targetFill = false),
    (progress) =>
      (progress.firstReveal.visibilityCalls[0].ordinal =
        progress.visibilitySeam.calls.length),
    (progress) =>
      (progress.orderProof.endUpdateCalls[0].targetStateAfter.fillMeshDefined = false),
    (progress) => (progress.orderProof.restoration.restored = false),
  ]) {
    const mutated = structuredClone(syntheticProgress());
    mutateVisibilityProgress(mutated);
    assert.equal(validateS5PageProgress(mutated).ok, false);
  }
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
  assert.equal(
    redactS5OutputPayload("Bearer sk-live-secret password=secret"),
    "Bearer [REDACTED] password=[REDACTED]",
  );
  assert.deepEqual(
    redactS5OutputPayload({ token: "secret", nested: { password: "secret" } }),
    { token: "[REDACTED]", nested: { password: "[REDACTED]" } },
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

  const enumerateArrayLocations = (value, path = [], locations = []) => {
    if (Array.isArray(value)) {
      locations.push(path);
      for (let index = 0; index < value.length; index++) {
        enumerateArrayLocations(value[index], [...path, index], locations);
      }
      return locations;
    }
    if (value !== null && typeof value === "object") {
      for (const key of Object.keys(value)) {
        enumerateArrayLocations(value[key], [...path, key], locations);
      }
    }
    return locations;
  };
  const valueAt = (value, location) =>
    location.reduce((current, key) => current[key], value);
  const displayLocation = (location) =>
    location
      .map((key) => (typeof key === "number" ? "[]" : `.${key}`))
      .join("")
      .slice(1);
  const base = greenReport();
  const arrayLocations = enumerateArrayLocations(base);
  assert.equal(arrayLocations.length, 143);
  assert.equal(
    new Set(arrayLocations.map((location) => valueAt(base, location))).size,
    arrayLocations.length,
  );
  const retainedReferences = [];
  const enumerateRetainedReferences = (value) => {
    if (value === null || typeof value !== "object") return;
    retainedReferences.push(value);
    if (Array.isArray(value)) {
      value.forEach(enumerateRetainedReferences);
      return;
    }
    Object.values(value).forEach(enumerateRetainedReferences);
  };
  enumerateRetainedReferences(base);
  assert.equal(
    new Set(retainedReferences).size,
    retainedReferences.length,
    "the canonical synthetic report must not share certifying objects",
  );

  const liveGraphAlias = greenReport();
  const webglSelected =
    liveGraphAlias.sessions[0].phases["A-ellipsoid-stable"].selectedTileIds;
  const webgpuSelected =
    liveGraphAlias.sessions[1].phases["A-ellipsoid-stable"].selectedTileIds;
  assert.deepEqual(webgpuSelected, webglSelected);
  liveGraphAlias.sessions[1].phases["A-ellipsoid-stable"].selectedTileIds =
    webglSelected;
  assert.strictEqual(
    liveGraphAlias.sessions[0].phases["A-ellipsoid-stable"].selectedTileIds,
    liveGraphAlias.sessions[1].phases["A-ellipsoid-stable"].selectedTileIds,
  );
  const liveAliasVerdict = foldC1229S5Gate(liveGraphAlias);
  assert.equal(liveAliasVerdict.status, "PASS");
  const canonicalAlias = materializeS5CanonicalJsonValue(
    liveGraphAlias,
    "aliased S5 report mutant",
  );
  assert.equal(canonicalAlias.bytes, serializeS5Artifact(base));
  assert.equal(serializeS5Artifact(canonicalAlias.value), canonicalAlias.bytes);
  assert.deepEqual(foldC1229S5Gate(canonicalAlias.value), liveAliasVerdict);
  assert.notStrictEqual(
    canonicalAlias.value.sessions[0].phases["A-ellipsoid-stable"]
      .selectedTileIds,
    canonicalAlias.value.sessions[1].phases["A-ellipsoid-stable"]
      .selectedTileIds,
  );
  for (const [label, mutateUnsafeReport] of [
    [
      "undefined",
      (report) => (report.provenance.generatedShaders.lossy = undefined),
    ],
    ["NaN", (report) => (report.sessions[0].fixture.cameraFovDegrees = NaN)],
    [
      "infinity",
      (report) => (report.sessions[0].fixture.cameraFovDegrees = Infinity),
    ],
    [
      "negative zero",
      (report) => (report.sessions[0].fixture.cameraFovDegrees = -0),
    ],
  ]) {
    const unsafe = greenReport();
    mutateUnsafeReport(unsafe);
    assert.throws(
      () => materializeS5CanonicalJsonValue(unsafe, label),
      /non-JSON|lossy JSON/u,
    );
  }
  const cyclicReport = greenReport();
  cyclicReport.provenance.cycle = cyclicReport;
  assert.throws(
    () => materializeS5CanonicalJsonValue(cyclicReport, "cyclic report"),
    /JSON cycle/u,
  );
  const accessorReport = greenReport();
  let accessorReads = 0;
  Object.defineProperty(accessorReport.provenance, "accessor", {
    enumerable: true,
    get() {
      accessorReads++;
      return "must-not-be-read";
    },
  });
  assert.throws(
    () => materializeS5CanonicalJsonValue(accessorReport, "accessor report"),
    /non-data JSON property/u,
  );
  assert.equal(accessorReads, 0);
  for (const accessorBehavior of ["throwing", "mutating"]) {
    const arrayAccessorReport = greenReport();
    const selectedTileIds =
      arrayAccessorReport.sessions[0].phases["A-ellipsoid-stable"]
        .selectedTileIds;
    const originalSecondTileId = selectedTileIds[1];
    let arrayAccessorReads = 0;
    Object.defineProperty(selectedTileIds, "0", {
      configurable: true,
      enumerable: true,
      get() {
        arrayAccessorReads++;
        if (accessorBehavior === "throwing") {
          throw new Error("array accessor must not execute");
        }
        selectedTileIds[1] = "30/0/0";
        return heldTarget.key;
      },
    });
    assert.throws(
      () =>
        materializeS5CanonicalJsonValue(
          arrayAccessorReport,
          `${accessorBehavior} array accessor report`,
        ),
      /non-data JSON property/u,
    );
    assert.equal(arrayAccessorReads, 0);
    assert.equal(selectedTileIds[1], originalSecondTileId);
  }
  const nonEnumerableArrayIndexReport = greenReport();
  const nonEnumerableSelectedTileIds =
    nonEnumerableArrayIndexReport.sessions[0].phases["A-ellipsoid-stable"]
      .selectedTileIds;
  Object.defineProperty(nonEnumerableSelectedTileIds, "0", {
    configurable: true,
    enumerable: false,
    value: nonEnumerableSelectedTileIds[0],
    writable: true,
  });
  assert.throws(
    () =>
      materializeS5CanonicalJsonValue(
        nonEnumerableArrayIndexReport,
        "non-enumerable array index report",
      ),
    /non-data JSON property/u,
  );
  const symbolArrayKeyReport = greenReport();
  symbolArrayKeyReport.sessions[0].phases["A-ellipsoid-stable"].selectedTileIds[
    Symbol("hidden array value")
  ] = "must-not-be-dropped";
  assert.throws(
    () =>
      materializeS5CanonicalJsonValue(
        symbolArrayKeyReport,
        "symbol array key report",
      ),
    /lossy JSON array/u,
  );
  for (const [label, lossyNumber] of [
    ["array negative zero", -0],
    ["array NaN", NaN],
    ["array infinity", Infinity],
  ]) {
    const lossyArrayReport = greenReport();
    const selectedTileIds =
      lossyArrayReport.sessions[0].phases["A-ellipsoid-stable"].selectedTileIds;
    Object.defineProperty(selectedTileIds, "0", {
      configurable: true,
      enumerable: true,
      value: lossyNumber,
      writable: true,
    });
    assert.throws(
      () => materializeS5CanonicalJsonValue(lossyArrayReport, label),
      /lossy JSON number/u,
    );
  }
  for (const location of arrayLocations) {
    for (const [label, mutateArray] of [
      [
        "sparse",
        (array) => {
          if (array.length === 0) array.length = 1;
          else delete array[Math.floor(array.length / 2)];
        },
      ],
      ["extra-own-key", (array) => (array.extra = true)],
      [
        "custom-prototype",
        (array) => Object.setPrototypeOf(array, Object.create(Array.prototype)),
      ],
    ]) {
      const report = structuredClone(base);
      mutateArray(valueAt(report, location));
      const verdict = foldC1229S5Gate(report);
      assert.equal(
        verdict.status,
        "STRUCTURAL",
        `${label}: ${displayLocation(location)}`,
      );
      assert.match(
        verdict.structuralReasons.join("\n"),
        /final report array is not canonical dense bounded data/u,
        `${label}: ${displayLocation(location)}`,
      );
    }
  }

  // Every retained array has a named semantic contract. Shape validation is
  // only the outer boundary; these generated mutants prove that a meaningful
  // element change, deletion, insertion, or observable reorder cannot retain
  // a certifying PASS.
  const semanticArrayContracts = [
    {
      name: "renderer-order/cardinality",
      matches: (arrayPath) => arrayPath === "sessions",
    },
    {
      name: "provenance-frozen-order/digest-identity",
      matches: (arrayPath) => arrayPath.startsWith("provenance."),
    },
    {
      name: "capture-label/UUID/file-identity",
      matches: (arrayPath) => arrayPath.endsWith(".images"),
    },
    {
      name: "transport/runtime/device-gate-empty-ledger",
      matches: (arrayPath) =>
        /\.transport\.(?:externalRequests|failedRequests|httpErrors)$/u.test(
          arrayPath,
        ) ||
        /\.runtime\.(?:pageErrors|consoleErrors|ignoredConsoleErrors|gpuErrors)$/u.test(
          arrayPath,
        ) ||
        /\.deviceGate\.gpuErrors$/u.test(arrayPath),
    },
    {
      name: "phase-tile-set/count/transition-identity",
      matches: (arrayPath) =>
        /(?:TileIds|Keys)$/u.test(arrayPath) &&
        !arrayPath.endsWith("pipelineIdentityIds"),
    },
    {
      name: "phase-pipeline/materialization-identity",
      matches: (arrayPath) =>
        /\.(?:pipelineIdentityIds|pipelineLabels)$/u.test(arrayPath),
    },
    {
      name: "phase-call/count/order-identity",
      matches: (arrayPath) =>
        /(?:CallOrdinals|\.calls|Calls|dynamicOffsetLengths)$/u.test(arrayPath),
    },
    {
      name: "phase-observation/bounds-identity",
      matches: (arrayPath) =>
        /(?:Observations|decodedFixtureBounds)$/u.test(arrayPath),
    },
  ];
  const classifiedPaths = new Map();
  for (const location of arrayLocations) {
    const arrayPath = displayLocation(location);
    const matches = semanticArrayContracts.filter((contract) =>
      contract.matches(arrayPath),
    );
    assert.equal(
      matches.length,
      1,
      `semantic contract classification: ${arrayPath}`,
    );
    classifiedPaths.set(arrayPath, matches[0].name);
  }
  assert.ok(classifiedPaths.size >= 70);

  const semanticTileId = "30/0/0";
  const differentSha256 = "e".repeat(64);
  const mutateMeaningfulElement = (array, arrayPath) => {
    if (array.length === 0) return false;
    const entry = array[0];
    if (arrayPath === "sessions") {
      entry.renderer = entry.renderer === "webgl" ? "webgpu" : "webgl";
      return true;
    }
    if (arrayPath.endsWith(".images")) {
      entry.label = C12_29_S5_CAPTURE_LABELS[1];
      return true;
    }
    if (
      /(?:TileIds|Keys)$/u.test(arrayPath) &&
      !arrayPath.endsWith("pipelineIdentityIds")
    ) {
      array[0] = semanticTileId;
      array.sort();
      return true;
    }
    if (arrayPath.endsWith("pipelineIdentityIds")) {
      array[0] = "pipeline-999999";
      return true;
    }
    if (typeof entry === "number") {
      array[0] = entry + 1;
      return true;
    }
    if (typeof entry === "string") {
      array[0] = `${entry}-semantic-mutant`;
      return true;
    }
    if (entry !== null && typeof entry === "object") {
      if (Object.hasOwn(entry, "ordinal")) {
        entry.ordinal += 1_000;
        return true;
      }
      if (Object.hasOwn(entry, "tileId")) {
        entry.tileId = semanticTileId;
        return true;
      }
      if (
        Object.hasOwn(entry, "currentSha256") &&
        Object.hasOwn(entry, "embeddedSha256")
      ) {
        entry.currentSha256 = differentSha256;
        entry.embeddedSha256 = differentSha256;
        return true;
      }
      if (Object.hasOwn(entry, "sha256")) {
        entry.sha256 = differentSha256;
        return true;
      }
    }
    return false;
  };
  const insertedElement = (array, arrayPath) => {
    if (array.length > 0) return structuredClone(array[0]);
    if (/(?:TileIds|Keys)$/u.test(arrayPath)) return semanticTileId;
    if (arrayPath.endsWith("pipelineIdentityIds")) return "pipeline-999999";
    if (arrayPath.endsWith("dynamicOffsetLengths")) return 3;
    return "semantic-mutant";
  };
  const semanticOperations = [
    {
      name: "mutate",
      applicable: (array) => array.length > 0,
      apply: mutateMeaningfulElement,
    },
    {
      name: "delete",
      applicable: (array) => array.length > 0,
      apply: (array) => {
        array.splice(0, 1);
        return true;
      },
    },
    {
      name: "insert",
      applicable: () => true,
      apply: (array, arrayPath) => {
        array.push(insertedElement(array, arrayPath));
        return true;
      },
    },
    {
      name: "reorder",
      applicable: (array) =>
        array.length > 1 &&
        JSON.stringify(array) !== JSON.stringify([...array].reverse()),
      apply: (array) => {
        array.reverse();
        return true;
      },
    },
  ];
  const operationCounts = new Map(
    semanticOperations.map((operation) => [operation.name, 0]),
  );
  const semanticMutantsThatPassed = [];
  for (const location of arrayLocations) {
    const arrayPath = displayLocation(location);
    for (const operation of semanticOperations) {
      const report = structuredClone(base);
      const array = valueAt(report, location);
      if (!operation.applicable(array)) continue;
      assert.equal(
        operation.apply(array, arrayPath),
        true,
        `${operation.name} applicability: ${arrayPath}`,
      );
      operationCounts.set(
        operation.name,
        operationCounts.get(operation.name) + 1,
      );
      if (foldC1229S5Gate(report).status === "PASS") {
        semanticMutantsThatPassed.push(
          `${operation.name}: ${arrayPath} (${classifiedPaths.get(arrayPath)})`,
        );
      }
    }
  }
  assert.equal(operationCounts.get("insert"), arrayLocations.length);
  assert.equal(operationCounts.get("mutate"), 96);
  assert.equal(operationCounts.get("delete"), 96);
  assert.equal(operationCounts.get("reorder"), 39);
  assert.deepEqual(semanticMutantsThatPassed, []);

  // The validator must fail closed even if a hostile page has polluted the
  // realm-wide numeric prototype surface.
  for (const writable of [true, false]) {
    const pristineReport = greenReport();
    // eslint-disable-next-line no-extend-native
    Object.defineProperty(Array.prototype, "1", {
      configurable: true,
      writable,
      value: "numeric-prototype-pollution",
    });
    try {
      const verdict = foldC1229S5Gate(pristineReport);
      assert.equal(verdict.status, "STRUCTURAL");
      assert.match(
        verdict.structuralReasons.join("\n"),
        /final report array is not canonical dense bounded data/u,
      );
    } finally {
      delete Array.prototype[1];
    }
  }

  for (const mutateFrozenOrder of [
    (report) => report.provenance.sourceBoundary.files.reverse(),
    (report) => report.provenance.buildSourceIdentity.entries.reverse(),
    (report) => report.provenance.servedEntryIdentity.expectedLabels.reverse(),
    (report) => report.sessions.reverse(),
    (report) => report.sessions[0].images.reverse(),
  ]) {
    const report = structuredClone(base);
    mutateFrozenOrder(report);
    assert.equal(foldC1229S5Gate(report).status, "STRUCTURAL");
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
  const buildIdentityMutants = [
    (identity) => (identity.entries[1] = structuredClone(identity.entries[0])),
    (identity) => (identity.entries[0].file = "C:/wrong/Scene.js"),
    (identity) => (identity.entries[0].file = C12_29_S5_BUILD_SOURCE_FILES[0]),
    (identity) => {
      identity.entries.pop();
      identity.entries.push(structuredClone(identity.entries[0]));
    },
    (identity) => {
      identity.entries = undefined;
      identity.count = C12_29_S5_BUILD_SOURCE_FILES.length;
      identity.ok = true;
    },
    (identity) =>
      (identity.entries[0].file = `${identity.entries[0].file}/../${path.basename(
        identity.entries[0].file,
      )}`),
    (identity) =>
      (identity.entries[0].sourceMapEntry = identity.entries[1].sourceMapEntry),
    (identity) => identity.entries[0].currentByteLength++,
    (identity) => identity.entries[0].embeddedByteLength++,
    (identity) => (identity.entries[0].currentSha256 = "e".repeat(64)),
    (identity) => (identity.entries[0].embeddedSha256 = "1".repeat(64)),
    (identity) => (identity.entries[0].exact = false),
    (identity) =>
      (identity.entries[0].reason =
        "current source bytes differ from built sourcesContent"),
    (identity) => identity.reasons.push("spoofed ok/count"),
    (identity) => (identity.sourceMapByteLength = 0),
    (identity) => (identity.sourceMapSha256 = "not-a-sha256"),
    (identity) =>
      (identity.sourceMapPath = "Build/CesiumUnminified/index.js.map"),
    (identity) =>
      (identity.sourceMapPath = path.join(repositoryRoot, "Build/wrong.map")),
  ];
  for (const [index, mutateIdentity] of buildIdentityMutants.entries()) {
    const verdict = mutateReport((report) =>
      mutateIdentity(report.provenance.buildSourceIdentity),
    );
    assert.equal(
      verdict.status,
      "STRUCTURAL",
      `build identity mutant ${index}`,
    );
    assert.match(verdict.structuralReasons.join("\n"), /source-map identity/u);
  }
});

test("07 first-beginFrame provider-reset boundary is exact and pre-selection", () => {
  assert.deepEqual(
    {
      key: heldTarget.key,
      edge: heldTarget.edge,
      distanceDegrees: heldTarget.distanceDegrees,
    },
    { key: "1/0/1", edge: "south", distanceDegrees: 25 },
  );
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
  expectStatus(
    (report) => {
      report.sessions[0].phases[
        C12_29_S5_PHASES[7]
      ].nextEpoch.immediateSnapshotUsedForClaim = true;
    },
    "STRUCTURAL",
    /immediate reset snapshot/u,
  );
});

test("08 controlled visibility produces one exact L1 fill and release", () => {
  const naturalObservation = {
    settled: true,
    tilesLoaded: true,
    selectedTileIds: [siblingKey, heldTarget.key].sort(),
    realTileIds: [siblingKey, heldTarget.key].sort(),
    fillTileIds: [],
    targetSelection: selectionObservation(heldTarget.key, 10, 2, "RENDERED"),
    selectedRealSiblingObservations: [
      selectionObservation(siblingKey, 10, 2, "RENDERED"),
    ],
  };
  assert.equal(
    evaluateS5ControlledVisibilityObservation(heldTarget, naturalObservation)
      .directLevelOneNatural,
    true,
  );
  for (const mutateLod of [
    (phase) => (phase.maximumScreenSpaceError = FILL_SSE + 1),
    (phase) => (phase.cameraFovDegrees = 54),
    (phase) => phase.cameraHeightMeters++,
    (phase) => (phase.cameraReference.cameraCartographicInsideTarget = true),
    (phase) => (phase.cameraReference.referenceFrameOriginDefined = true),
    (phase) => (phase.cameraReference.neededPositionInsideTarget = true),
    (phase) => (phase.parentSelection.rawResult = 2),
    (phase) => (phase.targetSelection.rawResult = 3),
    (phase) => (phase.siblingSelection.wasKicked = true),
    (phase) => (phase.sseInputs.drawingBufferHeight = 959),
    (phase) => (phase.sseInputs.parentComputedSse = FILL_SSE),
    (phase) => (phase.sseInputs.targetComputedSse = FILL_SSE + 1),
  ]) {
    expectStatus(
      (report) =>
        mutateLod(
          report.sessions[0].phases[C12_29_S5_PHASES[0]].fillLodPrecondition,
        ),
      "STRUCTURAL",
      /fixed-SSE direct level-one/u,
    );
  }
  for (const mutateFill of [
    (phase) => (phase.fillCount = 0),
    (phase) => (phase.heldRequestCount = 0),
    (phase) => {
      phase.heldRequestCount = 2;
      phase.heldKeys.push("1/1/1");
    },
    (phase) => phase.selectedTileIds.pop(),
    (phase) => (phase.realSiblingTileIds = []),
    (phase) => (phase.warmup.settled = false),
    (phase) => (phase.warmup.fillCount = 1),
    (phase) => (phase.holdArm.holdInterceptionEnabledBefore = true),
    (phase) => (phase.warmup.targetRequestAttempts = 1),
    (phase) => (phase.warmup.targetSelection.rawResult = 2),
    (phase) => (phase.warmup.targetSelection.wasKicked = true),
    (phase) => (phase.warmup.parentSelection.rawResult = 2),
    (phase) => (phase.warmup.cameraReference.neededPositionInsideTarget = true),
    (phase) => (phase.warmup.sseInputs.targetComputedSse = FILL_SSE + 1),
    (phase) =>
      (phase.warmup.targetSelectedDescendantTileIds = [heldTarget.key]),
    (phase) => (phase.warmup.selectedRealSiblingTileIds = []),
    (phase) => (phase.holdArm.targetRequestAttemptsBefore = 1),
    (phase) => (phase.firstRevealProof.postArmTargetRequestAttempts = 0),
    (phase) => (phase.firstRevealProof.postArmTargetRequestAttempts = 2),
    (phase) => (phase.firstRevealProof.frameDelta = 2),
    (phase) => {
      phase.firstRevealProof.frameBefore = 25;
      phase.firstRevealProof.frameAfter = 26;
      phase.firstRevealProof.warmFrame = 25;
      phase.firstRevealProof.targetSelection.selectionFrame = 26;
      phase.firstRevealProof.targetSelection.resultFrame = 26;
    },
    (phase) => (phase.firstRevealProof.targetSelection.rawResult = 3),
    (phase) => (phase.firstRevealProof.targetSelection.extra = true),
    (phase) =>
      (phase.firstRevealProof.fillMesh.terrainFillMeshInstance = false),
    (phase) => (phase.firstRevealProof.fillMesh.renderedMeshMatches = false),
    (phase) => (phase.firstRevealProof.fillMesh.realMeshAbsent = false),
    (phase) => (phase.firstRevealProof.fillMesh.vertexCountWithoutSkirts = 0),
    (phase) => (phase.firstRevealProof.fillMesh.indexCount = 0),
    (phase) =>
      phase.firstRevealProof.targetSelectedStrictDescendantTileIds.push(
        "2/0/2",
      ),
    (phase) => (phase.firstRevealProof.selectedRealSiblingTileIds = []),
    (phase) => {
      const nonSibling = selectionObservation("1/3/0", 21, 2, "RENDERED");
      phase.firstRevealProof.selectedTileIds.push(nonSibling.tileId);
      phase.firstRevealProof.selectedTileIds.sort();
      phase.firstRevealProof.selectedCount++;
      phase.firstRevealProof.realTileIds.push(nonSibling.tileId);
      phase.firstRevealProof.realTileIds.sort();
      phase.firstRevealProof.realMeshCount++;
      phase.firstRevealProof.selectedRealSiblingTileIds.push(nonSibling.tileId);
      phase.firstRevealProof.selectedRealSiblingTileIds.sort();
      phase.firstRevealProof.selectedRealSiblingObservations.push(nonSibling);
    },
    (phase) => (phase.firstRevealProof.predicateResults.targetFill = false),
    (phase) =>
      (phase.firstRevealProof.visibilityCalls[0].returnedVisibility = -1),
    (phase) => (phase.firstRevealProof.targetState.renderable = "yes"),
    (phase) =>
      phase.firstRevealProof.targetRealDescendantTileIds.push(heldTarget.key),
    (phase) =>
      (phase.orderProof.showTileThisFrameCalls[1].exitEventOrdinal = 5),
    (phase) => {
      phase.orderProof.showTileThisFrameCalls[1].tileStateBefore = {
        ...phase.orderProof.showTileThisFrameCalls[1].tileStateBefore,
        renderable: false,
      };
    },
    (phase) => {
      phase.orderProof.endUpdateCalls[0].targetStateBefore = {
        ...phase.orderProof.endUpdateCalls[0].targetStateBefore,
        renderable: false,
      };
    },
    (phase) => {
      phase.orderProof.showTileThisFrameCalls[1].providerFlagsAfter =
        providerFlags(false, true);
    },
    (phase) =>
      phase.orderProof.endUpdateCalls[0].targetStateAfter
        .vertexCountWithoutSkirts++,
    (phase) => {
      phase.orderProof.endUpdateCalls[0].providerFlagsAfter = providerFlags(
        false,
        true,
      );
    },
    (phase) =>
      (phase.orderProof.endUpdateCalls[0].targetStateAfter.fillMeshDefined = false),
    (phase) => (phase.orderProof.installation.endUpdate.beforeHadOwn = true),
    (phase) =>
      (phase.orderProof.installation.endUpdate.installedDescriptor.enumerable = true),
    (phase) =>
      (phase.orderProof.installation.endUpdate.installedDescriptor.extra = true),
    (phase) => (phase.orderProof.restoration.attemptedAt = null),
    (phase) => (phase.orderProof.restoration.finallyVerified = false),
    (phase) => (phase.holdTarget.level = 2),
    (phase) => (phase.maximumScreenSpaceError = FILL_SSE + 1),
  ]) {
    expectStatus(
      (report) => mutateFill(report.sessions[0].phases[C12_29_S5_PHASES[2]]),
      "STRUCTURAL",
      /pass-through reveal/u,
    );
  }
  const expectTruthfulRedProgress = (mutator, falsePredicates) => {
    const progress = syntheticProgress();
    mutator(progress);
    for (const predicate of falsePredicates) {
      progress.firstReveal.predicateResults[predicate] = false;
    }
    progress.visibilitySeam.terminalReason =
      "first pass-through render did not produce the exact held L1 fill";
    assert.equal(
      validateS5PageProgress(progress, "webgl").ok,
      true,
      falsePredicates.join(","),
    );
    const forgedGreen = structuredClone(progress);
    for (const predicate of falsePredicates) {
      forgedGreen.firstReveal.predicateResults[predicate] = true;
    }
    assert.equal(validateS5PageProgress(forgedGreen, "webgl").ok, false);
  };
  for (const mutateLifecycle of [
    (progress) =>
      (progress.orderProof.endUpdateCalls[0].targetStateAfter.terrainState =
        C12_29_S5_REVEAL_LIFECYCLE.terrainReceiving),
    (progress) =>
      (progress.firstReveal.targetState.terrainState =
        C12_29_S5_REVEAL_LIFECYCLE.terrainUnloaded),
    (progress) => (progress.firstReveal.targetState.terrainState = 3),
    (progress) =>
      (progress.firstReveal.targetState.quadtreeState =
        C12_29_S5_REVEAL_LIFECYCLE.quadtreeStart),
    (progress) => (progress.firstReveal.targetState.renderable = false),
    (progress) => (progress.firstReveal.releasedRequestCount = 1),
    (progress) => (progress.firstReveal.rejectedRequestCount = 1),
  ]) {
    expectTruthfulRedProgress(mutateLifecycle, [
      "postEndUpdateLoadTransitionExact",
    ]);
  }
  expectTruthfulRedProgress(
    (progress) => {
      progress.firstReveal.heldKeys = [];
      progress.firstReveal.heldRequestCount = 0;
      progress.firstReveal.targetHeldPromisePresent = false;
    },
    ["exactHeldTargetSet", "postEndUpdateLoadTransitionExact"],
  );
  expectTruthfulRedProgress(
    (progress) => {
      progress.firstReveal.reservedKeys = [];
      progress.firstReveal.reservedPromiseCount = 0;
      progress.firstReveal.targetReservedPromisePresent = false;
    },
    ["exactReservedTargetSet", "postEndUpdateLoadTransitionExact"],
  );
  const mutateFillMeasurements = (progress, mutator) => {
    for (const measurements of [
      progress.orderProof.endUpdateCalls[0].targetStateAfter,
      progress.firstReveal.targetState,
      progress.firstReveal.fillMesh,
    ]) {
      mutator(measurements);
    }
  };
  for (const mutateMesh of [
    (value) => (value.vertexCountWithoutSkirts = 80),
    (value) => (value.indexCountWithoutSkirts = 383),
    (value) => (value.indexCount = 575),
    (value) => {
      value.derivedVertexCount = 116;
      value.verticesLength = value.derivedVertexCount * value.stride;
    },
  ]) {
    expectTruthfulRedProgress(
      (progress) => mutateFillMeasurements(progress, mutateMesh),
      ["exactLowDetailFillMeshShape", "endUpdateConstructedFill"],
    );
  }
  expectTruthfulRedProgress(
    (progress) =>
      mutateFillMeasurements(
        progress,
        (value) => (value.vertexCountWithoutSkirts = 0),
      ),
    [
      "positiveVertexCount",
      "exactLowDetailFillMeshShape",
      "endUpdateConstructedFill",
    ],
  );
  const inconsistentStride = syntheticProgress();
  mutateFillMeasurements(
    inconsistentStride,
    (value) => (value.stride = value.stride + 1),
  );
  assert.equal(validateS5PageProgress(inconsistentStride, "webgl").ok, false);
  for (const mutateSeam of [
    (seam) => (seam.installation.beforeHadOwn = true),
    (seam) => (seam.installation.installedWrapperIdentityMatches = false),
    (seam) => seam.counts.originalCalls--,
    (seam) => (seam.calls[1].originalCallCompleted = false),
    (seam) => (seam.calls[1].tileKey = siblingKey),
    (seam) => {
      seam.calls[0].returnedVisibility = -1;
      seam.calls[0].returnedVisibilityName = "NONE";
      seam.calls[0].overridden = true;
      seam.counts.overrideCalls++;
      seam.counts.nonTargetAlteredCalls++;
    },
    (seam) => {
      seam.calls[1].originalVisibility = -1;
      seam.calls[1].originalVisibilityName = "NONE";
      seam.calls[1].returnedVisibility = -1;
      seam.calls[1].returnedVisibilityName = "NONE";
      seam.calls[1].overridden = false;
      seam.counts.overrideCalls--;
    },
    (seam) => {
      seam.calls[4].returnedVisibility = -1;
      seam.calls[4].returnedVisibilityName = "NONE";
      seam.calls[4].overridden = true;
      seam.counts.overrideCalls++;
    },
    (seam) => (seam.modeSwitch.revealFrame = 22),
    (seam) => (seam.restoration.attemptedAt = "finally-verification"),
    (seam) => (seam.restoration.immediateAfterReveal = false),
    (seam) => (seam.restoration.beforeRelease = false),
    (seam) => (seam.restoration.identityMatches = false),
    (seam) => (seam.restoration.descriptorMatches = false),
    (seam) => (seam.restoration.afterHadOwn = true),
  ]) {
    expectStatus(
      (report) =>
        mutateSeam(
          report.sessions[0].phases[C12_29_S5_PHASES[2]].visibilitySeam,
        ),
      "STRUCTURAL",
      /visibility seam/u,
    );
  }
  for (const mutateRelease of [
    (phase) => (phase.holdInterceptionEnabled = true),
    (phase) => (phase.newHeldRequestCountAfterRelease = 1),
    (phase) => (phase.holdTargetKey = heldTarget.anchorKey),
    (phase) => (phase.visibilitySeamRestoredBeforeRelease = false),
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
      ].trackRestore.maximumScreenSpaceError = FILL_SSE),
    "FAIL",
    /held fill did not transition/u,
  );
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
  for (const mutatePrewarm of [
    (prewarm) => delete prewarm.off,
    (prewarm) => (prewarm.off.settled = false),
    (prewarm) => (prewarm.on.settled = false),
    (prewarm) => {
      prewarm.on.emittedCommandCount = 0;
      prewarm.on.materializedCommandCount = 0;
      prewarm.on.positiveIndexCommandCount = 0;
      prewarm.on.threeDynamicOffsetCommandCount = 0;
    },
    (prewarm) => (prewarm.off.frames = 0),
    (prewarm) => (prewarm.on.frames = C12_29_S5_WEBGPU_PREWARM_MAX_FRAMES + 1),
    (prewarm) => (prewarm.off.ownerTileIds = []),
    (prewarm) => prewarm.off.ownerTileIds.pop(),
    (prewarm) => (prewarm.on.ownerTileIds[0] = "1/3/1"),
    (prewarm) => prewarm.on.pipelineIdentityIds.push("pipeline-2"),
    (prewarm) => (prewarm.on.frameNumber = prewarm.off.frameNumber),
    (prewarm) => (prewarm.offBeforeOn = false),
  ]) {
    expectStatus(
      (report) =>
        mutatePrewarm(
          report.sessions[1].phases[C12_29_S5_PHASES[4]]
            .webgpuCommandMaterializationPrewarm,
        ),
      "STRUCTURAL",
      /materially prewarmed/u,
    );
  }
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

  for (const mutateDeviceGate of [
    (session) => delete session.deviceGate,
    (session) => delete session.deviceGate.gpuErrors,
    (session) => delete session.deviceGate.deviceLost,
    (session) => (session.deviceGate.extra = true),
    (session) => session.deviceGate.gpuErrors.push("validation"),
    (session) => {
      session.deviceGate.gpuErrors.length = 1;
    },
    (session) =>
      Object.setPrototypeOf(
        session.deviceGate.gpuErrors,
        Object.create(Array.prototype),
      ),
    (session) => (session.deviceGate.deviceLost = true),
  ]) {
    expectStatus(
      (report) => mutateDeviceGate(report.sessions[1]),
      "STRUCTURAL",
      /device gate|canonical dense bounded data/u,
    );
  }

  for (const mutateCrossBinding of [
    (session) => session.deviceGate.gpuErrors.push("device-gate-only"),
    (session) => (session.deviceGate.deviceLost = true),
    (session) => session.runtime.gpuErrors.push("runtime-only"),
    (session) => (session.runtime.deviceLost = true),
  ]) {
    expectStatus(
      (report) => mutateCrossBinding(report.sessions[1]),
      "STRUCTURAL",
      /device gate is not cross-bound to runtime/u,
    );
  }

  for (const mutateRuntimeShape of [
    (session) => delete session.runtime.ignoredConsoleErrors,
    (session) => delete session.runtime.deviceLost,
    (session) => (session.runtime.extra = true),
    (session) => session.runtime.ignoredConsoleErrors.push("ignored error"),
    (session) => {
      session.runtime.ignoredConsoleErrors.length = 1;
    },
    (session) =>
      Object.setPrototypeOf(
        session.runtime.ignoredConsoleErrors,
        Object.create(Array.prototype),
      ),
    (session) => (session.runtime.deviceLost = true),
    (session) => (session.runtime.deviceLostReason = "unknown"),
    (session) => (session.runtime.deviceLostMessage = "lost"),
    (session) => session.runtime.gpuErrors.push("runtime-only validation"),
  ]) {
    expectStatus(
      (report) => mutateRuntimeShape(report.sessions[1]),
      "STRUCTURAL",
      /browser\/GPU|cross-bound|canonical dense bounded data/u,
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
      error?.s5Diagnostics?.pageValidation?.status === "fulfilled-valid" &&
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
      error?.s5Diagnostics?.pageValidation?.status === "timeout" &&
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
    (error) => {
      const diagnostics = error?.s5Diagnostics;
      assert.equal(error?.code, "S5_PAGE_TIMEOUT");
      assert.equal(diagnostics?.page, null);
      assert.equal(diagnostics?.node?.diagnosticRead, "fulfilled-invalid");
      assert.equal(diagnostics?.pageValidation?.status, "fulfilled-invalid");
      assert.deepEqual(
        diagnostics?.pageValidation?.reasons,
        validateS5PageProgress(
          {
            ...syntheticProgress(),
            terrainRequests: {
              ...syntheticProgress().terrainRequests,
              attempted: 3,
            },
          },
          "webgl",
        ).reasons,
      );
      assert.equal(diagnostics?.rawPage?.truncated, true);
      assert.equal(diagnostics?.rawPage?.originalByteLength, null);
      assert.equal(diagnostics?.rawPage?.json.length > 0, true);
      return true;
    },
  );

  const invalidProgress = structuredClone(syntheticProgress());
  invalidProgress.firstReveal.predicateResults.targetFill = false;
  invalidProgress.visibilitySeam.terminalReason =
    "first pass-through render did not produce the exact held L1 fill";
  const rejectedSnapshot = await snapshotS5PageProgress(
    { evaluate: async () => invalidProgress },
    "webgl",
  );
  assert.equal(rejectedSnapshot.page, null);
  assert.equal(rejectedSnapshot.pageValidation.status, "fulfilled-invalid");
  assert.deepEqual(
    rejectedSnapshot.pageValidation.reasons,
    validateS5PageProgress(invalidProgress, "webgl").reasons,
  );
  assert.equal(
    JSON.parse(rejectedSnapshot.rawPage.json).firstReveal.predicateResults
      .targetFill,
    false,
  );
  assert.equal(
    JSON.parse(rejectedSnapshot.rawPage.json).visibilitySeam.terminalReason,
    "first pass-through render did not produce the exact held L1 fill",
  );
  assert.equal(
    validateS5FinalArtifactShape({
      schema: C12_29_S5_SCHEMA,
      runId: RUN_ID,
      status: "ERROR",
      exitCode: 2,
      incomplete: false,
      artifactName: `${RUN_ID}.json`,
      error: "page.evaluate rejected after first-reveal aggregate failure",
      diagnostics: {
        schema: C12_29_S5_DIAGNOSTICS_SCHEMA,
        renderer: "webgl",
        stage: "page-measurement-error",
        timeoutMs: 240_000,
        node: {
          stage: "page-measurement-error",
          requestLedger: {
            started: 123,
            completed: 122,
            failed: 0,
            inFlight: 1,
            lastRequest: null,
            lastResponse: null,
            lastFailure: null,
          },
        },
        page: rejectedSnapshot.page,
        pageValidation: rejectedSnapshot.pageValidation,
        rawPage: rejectedSnapshot.rawPage,
      },
    }).ok,
    true,
  );

  const readFailure = await snapshotS5PageProgress(
    {
      evaluate: async () => {
        throw new Error("snapshot failed");
      },
    },
    "webgl",
  );
  assert.equal(readFailure.pageValidation.status, "rejected");
  assert.equal(readFailure.rawPage, null);
  assert.equal(readFailure.error, "snapshot failed");
});

test("20b invalid raw page diagnostics are bounded and never certify", () => {
  const numericPathSecret =
    "12345678901234567890/98765432109876543210/11223344556677889900";
  const d866Reason =
    "first pass-through render did not produce the exact held L1 fill";
  const hostile = structuredClone(syntheticProgress());
  hostile.secret = "must-not-be-retained";
  hostile.terrainRequests.password = "terrain-secret";
  hostile.pick.authorization = "pick-secret";
  hostile.firstReveal.predicateResults.targetFill = false;
  hostile.firstReveal.predicateResults.apiToken = "predicate-secret";
  hostile.firstReveal.visibilityCalls[0].cookie = "visibility-call-secret";
  hostile.firstReveal.predicateResults["💣".repeat(20_000)] = "界".repeat(
    100_000,
  );
  hostile.firstReveal.visibilityCalls = Array.from(
    { length: 10_000 },
    (_, ordinal) => ({ ordinal, payload: "🧪".repeat(10_000) }),
  );
  hostile.orderProof.installation.showTileThisFrame.loop = hostile;
  hostile.orderProof.installation.secret = "installation-secret";
  hostile.visibilitySeam.calls[0].credential = "seam-call-secret";
  hostile.visibilitySeam.restoration.password = "restoration-secret";
  let deep = hostile.orderProof.installation.endUpdate;
  for (let index = 0; index < 100; index++) {
    deep.next = {};
    deep = deep.next;
  }

  const classified = classifyS5PageDiagnosticValue(hostile, "webgl");
  assert.equal(classified.page, null);
  assert.equal(classified.pageValidation.status, "fulfilled-invalid");
  assert.deepEqual(
    classified.pageValidation.reasons,
    validateS5PageProgress(hostile, "webgl").reasons,
  );
  assert.equal(classified.rawPage.truncated, true);
  assert.equal(classified.rawPage.originalByteLength, null);
  assert.ok(
    Buffer.byteLength(classified.rawPage.json, "utf8") <=
      C12_29_S5_RAW_PAGE_MAX_JSON_LENGTH,
  );
  assert.doesNotThrow(() => JSON.parse(classified.rawPage.json));
  assert.doesNotMatch(classified.rawPage.json, /must-not-be-retained/u);
  assert.doesNotMatch(
    classified.rawPage.json,
    /terrain-secret|pick-secret|predicate-secret|visibility-call-secret|installation-secret|seam-call-secret|restoration-secret/u,
  );
  assert.equal(
    validateS5RawPageDiagnosticJson(classified.rawPage.json).ok,
    true,
  );

  const boundedUndefined = boundS5RawPageDiagnostic(undefined);
  assert.ok(
    Buffer.byteLength(boundedUndefined.json, "utf8") <=
      C12_29_S5_RAW_PAGE_MAX_JSON_LENGTH,
  );
  assert.doesNotThrow(() => JSON.parse(boundedUndefined.json));

  const unicodeHostile = structuredClone(syntheticProgress());
  unicodeHostile.unexpected = "force invalid classification";
  unicodeHostile.step = "🧪".repeat(10_000);
  unicodeHostile.terrainRequests.lastError = "界🧪".repeat(10_000);
  unicodeHostile.completedPhases = Array.from(
    { length: C12_29_S5_RAW_PAGE_MAX_ARRAY_LENGTH + 1 },
    () => "🧪".repeat(10_000),
  );
  unicodeHostile.firstReveal.predicateResults["💣".repeat(10_000)] =
    "dynamic-key-secret";
  unicodeHostile.loop = unicodeHostile;
  const boundedUnicode = classifyS5PageDiagnosticValue(unicodeHostile, "webgl");
  assert.equal(boundedUnicode.pageValidation.status, "fulfilled-invalid");
  const parsedUnicode = JSON.parse(boundedUnicode.rawPage.json);
  let maximumKeyLength = 0;
  let maximumStringLength = 0;
  let maximumArrayLength = 0;
  const inspectBoundedTree = (value) => {
    if (typeof value === "string") {
      maximumStringLength = Math.max(maximumStringLength, value.length);
      return;
    }
    if (Array.isArray(value)) {
      maximumArrayLength = Math.max(maximumArrayLength, value.length);
      value.forEach(inspectBoundedTree);
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) {
        maximumKeyLength = Math.max(maximumKeyLength, key.length);
        inspectBoundedTree(entry);
      }
    }
  };
  inspectBoundedTree(parsedUnicode);
  assert.ok(maximumKeyLength <= C12_29_S5_RAW_PAGE_MAX_KEY_LENGTH);
  assert.ok(maximumStringLength <= C12_29_S5_RAW_PAGE_MAX_STRING_LENGTH);
  assert.ok(maximumArrayLength <= C12_29_S5_RAW_PAGE_MAX_ARRAY_LENGTH);
  assert.doesNotMatch(boundedUnicode.rawPage.json, /dynamic-key-secret/u);
  assert.equal(
    Buffer.byteLength(boundedUnicode.rawPage.json, "utf8") <=
      C12_29_S5_RAW_PAGE_MAX_JSON_LENGTH,
    true,
  );

  const accessorFailure = classifyS5PageDiagnosticValue(
    {
      get renderer() {
        throw new Error("accessor secret");
      },
    },
    "webgl",
  );
  assert.deepEqual(accessorFailure, {
    page: null,
    pageValidation: {
      status: "rejected",
      reasons: [],
      diagnosticSha256: null,
    },
    rawPage: null,
  });
  assert.equal(
    boundS5RawPageDiagnostic({
      get schema() {
        throw new Error("projection accessor secret");
      },
    }),
    null,
  );
  let schemaReads = 0;
  assert.equal(
    boundS5RawPageDiagnostic(
      {
        get schema() {
          schemaReads++;
          if (schemaReads === 1) return C12_29_S5_DIAGNOSTICS_SCHEMA;
          throw new Error("second projection accessor secret");
        },
      },
      [],
      "webgl",
    ),
    null,
  );
  assert.equal(
    boundS5RawPageDiagnostic({
      get renderer() {
        throw new Error("default renderer accessor secret");
      },
    }),
    null,
  );
  const proxyFailure = classifyS5PageDiagnosticValue(
    new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("proxy secret");
        },
      },
    ),
    "webgl",
  );
  assert.equal(proxyFailure.pageValidation.status, "rejected");
  assert.equal(proxyFailure.rawPage, null);

  const diagnosticErrorArtifact = (diagnostic, error) => ({
    schema: C12_29_S5_SCHEMA,
    runId: RUN_ID,
    status: "ERROR",
    exitCode: 2,
    incomplete: false,
    artifactName: `${RUN_ID}.json`,
    error,
    diagnostics: {
      schema: C12_29_S5_DIAGNOSTICS_SCHEMA,
      renderer: "webgl",
      stage: "page-measurement-error",
      timeoutMs: 240_000,
      node: {
        stage: "page-measurement-error",
        requestLedger: {
          started: 1,
          completed: 1,
          failed: 0,
          inFlight: 0,
          lastRequest: null,
          lastResponse: null,
          lastFailure: null,
        },
      },
      ...diagnostic,
    },
  });

  const validHostile = syntheticProgress();
  validHostile.settle = {
    nested: { password: "valid-settle-secret" },
  };
  validHostile.settle.loop = validHostile.settle;
  validHostile.detail = {
    authorization: "valid-detail-secret",
  };
  validHostile.detail.loop = validHostile.detail;
  validHostile.terrainRequests.lastError = {
    token: "valid-ledger-secret",
  };
  assert.equal(validateS5PageProgress(validHostile, "webgl").ok, true);
  const validClassified = classifyS5PageDiagnosticValue(validHostile, "webgl");
  assert.equal(validClassified.pageValidation.status, "fulfilled-valid");
  assert.equal(validClassified.rawPage, null);
  assert.equal(
    validateS5PageDiagnosticProjection(validClassified.page, "webgl"),
    true,
  );
  assert.equal(Object.hasOwn(validClassified.page, "settle"), false);
  assert.equal(Object.hasOwn(validClassified.page, "detail"), false);
  assert.equal(validClassified.page.terrainRequests.lastError, "non-string");
  assert.doesNotMatch(
    JSON.stringify(validClassified),
    /valid-settle-secret|valid-detail-secret|valid-ledger-secret/u,
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(validClassified.page), "utf8") <=
      C12_29_S5_RAW_PAGE_MAX_JSON_LENGTH,
  );
  const validHostileArtifact = diagnosticErrorArtifact(
    validClassified,
    "simulated timeout with valid hostile progress",
  );
  assert.equal(validateS5FinalArtifactShape(validHostileArtifact).ok, true);
  const validSecretInjection = structuredClone(validHostileArtifact);
  validSecretInjection.diagnostics.page.secret = "late-valid-secret";
  assert.equal(validateS5FinalArtifactShape(validSecretInjection).ok, false);
  const crossFieldValidPageForge = structuredClone(validHostileArtifact);
  crossFieldValidPageForge.diagnostics.page.step = numericPathSecret;
  crossFieldValidPageForge.diagnostics.page.validationWitness.step =
    numericPathSecret;
  crossFieldValidPageForge.diagnostics.pageValidation.diagnosticSha256 =
    diagnosticSha256(crossFieldValidPageForge.diagnostics.page);
  assert.equal(
    validateS5FinalArtifactShape(crossFieldValidPageForge).ok,
    false,
  );
  const reorderedValidPage = structuredClone(validHostileArtifact);
  reorderedValidPage.diagnostics.page = Object.fromEntries(
    Object.entries(reorderedValidPage.diagnostics.page).reverse(),
  );
  reorderedValidPage.diagnostics.pageValidation.diagnosticSha256 =
    diagnosticSha256(reorderedValidPage.diagnostics.page);
  assert.equal(validateS5FinalArtifactShape(reorderedValidPage).ok, false);

  validHostileArtifact.diagnostics.node.authorization =
    "Bearer node-secret-token";
  validHostileArtifact.diagnostics.node.cookie = "cookie-secret-value";
  const validBytes = serializeS5Artifact(validHostileArtifact);
  const validRoundTrip = JSON.parse(validBytes);
  assert.equal(validateS5FinalArtifactShape(validRoundTrip).ok, true);
  assert.equal(serializeS5Artifact(validRoundTrip), validBytes);
  assert.equal(
    validRoundTrip.diagnostics.pageValidation.diagnosticSha256,
    diagnosticSha256(validRoundTrip.diagnostics.page),
  );
  assert.doesNotMatch(
    validBytes,
    /valid-settle-secret|valid-detail-secret|valid-ledger-secret|node-secret-token|cookie-secret-value/u,
  );

  const categoricalStrings = [
    ["https://user:password@terrain.invalid/tile", "url-userinfo"],
    ["https://terrain.invalid/tile?token=top-secret", "url-query"],
    ["https://terrain.invalid/tile#top-secret", "url-fragment"],
    ["Bearer sk-live-top-secret", "message"],
    ["password=top-secret", "message"],
  ];
  for (const [lastError, expectedCode] of categoricalStrings) {
    const source = structuredClone(syntheticProgress());
    source.unexpectedSecret = "must-never-survive";
    source["api-key-top-secret"] = "secret-key-value";
    source.schema = `schema-${lastError}`;
    source.terrainRequests.lastError = lastError;
    const diagnostic = classifyS5PageDiagnosticValue(source, "webgl");
    assert.equal(diagnostic.pageValidation.status, "fulfilled-invalid");
    const artifact = diagnosticErrorArtifact(
      diagnostic,
      "categorical diagnostic round trip",
    );
    const bytes = serializeS5Artifact(artifact);
    const roundTrip = JSON.parse(bytes);
    const raw = JSON.parse(roundTrip.diagnostics.rawPage.json);
    assert.equal(raw.validationWitness.schema, "[redacted-string]");
    assert.equal(raw.validationWitness.terrainRequests.lastError, expectedCode);
    assert.equal(roundTrip.diagnostics.rawPage.json, diagnostic.rawPage.json);
    assert.equal(validateS5FinalArtifactShape(roundTrip).ok, true);
    assert.equal(serializeS5Artifact(roundTrip), bytes);
    assert.equal(
      roundTrip.diagnostics.pageValidation.diagnosticSha256,
      createHash("sha256")
        .update(roundTrip.diagnostics.rawPage.json, "utf8")
        .digest("hex"),
    );
    assert.doesNotMatch(
      bytes,
      /top-secret|password@|sk-live|must-never-survive|secret-key-value/u,
    );
  }

  const witnessFromDiagnostic = (diagnostic) =>
    diagnostic.page?.validationWitness ??
    JSON.parse(diagnostic.rawPage.json).validationWitness;
  const crossFieldStringMutants = [
    {
      value: numericPathSecret,
      mutate: (source) => (source.step = numericPathSecret),
      read: (witness) => witness.step,
      expected: "other-step",
    },
    {
      value: RUN_ID,
      mutate: (source) => (source.schema = RUN_ID),
      read: (witness) => witness.schema,
      expected: "[redacted-string]",
    },
    {
      value: C12_29_S5_PHASES[0],
      mutate: (source) => (source.schema = C12_29_S5_PHASES[0]),
      read: (witness) => witness.schema,
      expected: "[redacted-string]",
    },
    {
      value: d866Reason,
      mutate: (source) => (source.step = d866Reason),
      read: (witness) => witness.step,
      expected: "other-step",
    },
    {
      value: "[invalid-super-secret-token]",
      mutate: (source) => (source.step = "[invalid-super-secret-token]"),
      read: (witness) => witness.step,
      expected: "other-step",
    },
    {
      value: RUN_ID,
      mutate: (source) => (source.visibilitySeam.terminalReason = RUN_ID),
      read: (witness) => witness.visibilitySeam.terminalReason,
      expected: "other-terminal-reason",
    },
  ];
  for (const mutant of crossFieldStringMutants) {
    const source = structuredClone(syntheticProgress());
    mutant.mutate(source);
    const diagnostic = classifyS5PageDiagnosticValue(source, "webgl");
    assert.notEqual(diagnostic.pageValidation.status, "rejected");
    assert.deepEqual(
      diagnostic.pageValidation.reasons,
      validateS5PageProgress(source, "webgl").reasons,
    );
    const witness = witnessFromDiagnostic(diagnostic);
    assert.equal(mutant.read(witness), mutant.expected);
    if (mutant.value !== C12_29_S5_PHASES[0]) {
      const escapedValue = mutant.value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      assert.doesNotMatch(
        JSON.stringify(diagnostic),
        new RegExp(escapedValue, "u"),
      );
    }
  }

  const numericWitnessSecret = 123_456_789_012_345;
  const misplacedKnownKeyMutants = [
    {
      mutate: (source) => (source.targetFill = numericWitnessSecret),
      read: (witness) => witness,
      misplacedKey: "targetFill",
    },
    {
      mutate: (source) =>
        (source.terrainRequests.targetFill = numericWitnessSecret),
      read: (witness) => witness.terrainRequests,
      misplacedKey: "targetFill",
    },
    {
      mutate: (source) =>
        (source.firstReveal.visibilityCalls[0].vertexCount =
          numericWitnessSecret),
      read: (witness) => witness.firstReveal.visibilityCalls[0],
      misplacedKey: "vertexCount",
    },
    {
      mutate: (source) =>
        (source.pick.providerFlags = structuredClone(
          source.firstReveal.providerFlags,
        )),
      read: (witness) => witness.pick,
      misplacedKey: "providerFlags",
    },
    {
      mutate: (source) =>
        (source.firstReveal.providerFlags = {
          ...structuredClone(source.orderProof),
          targetFill: numericWitnessSecret,
        }),
      read: (witness) => witness.firstReveal.providerFlags,
      misplacedKey: "targetFill",
    },
  ];
  for (const mutant of misplacedKnownKeyMutants) {
    const source = structuredClone(syntheticProgress());
    mutant.mutate(source);
    const diagnostic = classifyS5PageDiagnosticValue(source, "webgl");
    assert.equal(diagnostic.pageValidation.status, "fulfilled-invalid");
    assert.deepEqual(
      diagnostic.pageValidation.reasons,
      validateS5PageProgress(source, "webgl").reasons,
    );
    const raw = JSON.parse(diagnostic.rawPage.json);
    const container = mutant.read(raw.validationWitness);
    assert.equal(Object.hasOwn(container, mutant.misplacedKey), false);
    const sentinels = Object.entries(container).filter(([key]) =>
      /^__unexpected_s5_\d{4}$/u.test(key),
    );
    assert.ok(sentinels.length > 0);
    assert.deepEqual(
      sentinels,
      sentinels.map((_entry, index) => [
        `__unexpected_s5_${String(index + 1).padStart(4, "0")}`,
        "[unexpected]",
      ]),
    );
    assert.doesNotMatch(
      diagnostic.rawPage.json,
      new RegExp(String(numericWitnessSecret), "u"),
    );
    assert.equal(
      validateS5RawPageDiagnosticJson(diagnostic.rawPage.json, "webgl").ok,
      true,
    );
    assert.equal(
      validateS5FinalArtifactShape(
        diagnosticErrorArtifact(diagnostic, "misplaced known-key diagnostic"),
      ).ok,
      true,
    );
  }

  const misplacedArrayElement = createS5PageValidationWitness({
    completedPhases: [{ targetFill: numericWitnessSecret }],
  });
  assert.deepEqual(misplacedArrayElement, {
    completedPhases: ["[unexpected]"],
  });
  assert.doesNotMatch(
    JSON.stringify(misplacedArrayElement),
    new RegExp(String(numericWitnessSecret), "u"),
  );

  const wrongPathTypeMutants = [
    {
      mutate: (source) =>
        (source.firstReveal.targetFill = numericWitnessSecret),
      read: (witness) => witness.firstReveal.targetFill,
    },
    {
      mutate: (source) => (source.completedPhases[0] = numericWitnessSecret),
      read: (witness) => witness.completedPhases[0],
    },
    {
      mutate: (source) =>
        (source.firstReveal.selectedTileIds[0] = numericWitnessSecret),
      read: (witness) => witness.firstReveal.selectedTileIds[0],
    },
    {
      mutate: (source) =>
        (source.firstReveal.visibilityCalls[0] = numericWitnessSecret),
      read: (witness) => witness.firstReveal.visibilityCalls[0],
    },
    {
      mutate: (source) =>
        (source.firstReveal.visibilityTargetCallOrdinals[0] = "RENDERED"),
      read: (witness) => witness.firstReveal.visibilityTargetCallOrdinals[0],
    },
  ];
  for (const mutant of wrongPathTypeMutants) {
    const source = structuredClone(syntheticProgress());
    mutant.mutate(source);
    const diagnostic = classifyS5PageDiagnosticValue(source, "webgl");
    assert.equal(diagnostic.pageValidation.status, "fulfilled-invalid");
    assert.deepEqual(
      diagnostic.pageValidation.reasons,
      validateS5PageProgress(source, "webgl").reasons,
    );
    const witness = JSON.parse(diagnostic.rawPage.json).validationWitness;
    assert.equal(mutant.read(witness), "[unexpected]");
    assert.doesNotMatch(
      diagnostic.rawPage.json,
      new RegExp(String(numericWitnessSecret), "u"),
    );
    assert.equal(
      validateS5FinalArtifactShape(
        diagnosticErrorArtifact(diagnostic, "wrong path-type diagnostic"),
      ).ok,
      true,
    );
  }

  const hugeTileComponent = `1/${"9".repeat(4_096)}/0`;
  for (const invalidTileId of [
    numericPathSecret,
    hugeTileComponent,
    "31/0/0",
    "1/4/0",
    "1/0/2",
    "01/0/0",
  ]) {
    const lastTileWitness = createS5PageValidationWitness({
      terrainRequests: { lastTileId: invalidTileId },
    });
    assert.equal(lastTileWitness.terrainRequests.lastTileId, "present");
  }
  assert.equal(
    createS5PageValidationWitness({
      terrainRequests: { lastTileId: "1/3/1" },
    }).terrainRequests.lastTileId,
    "1/3/1",
  );
  const hugeTileProgress = structuredClone(syntheticProgress());
  hugeTileProgress.firstReveal.targetKey = hugeTileComponent;
  const hugeTileDiagnostic = classifyS5PageDiagnosticValue(
    hugeTileProgress,
    "webgl",
  );
  assert.equal(hugeTileDiagnostic.pageValidation.status, "fulfilled-invalid");
  const hugeTileRaw = JSON.parse(hugeTileDiagnostic.rawPage.json);
  assert.equal(
    hugeTileRaw.validationWitness.firstReveal.targetKey,
    "[redacted-string]",
  );
  assert.doesNotMatch(hugeTileDiagnostic.rawPage.json, /9{128}/u);

  const publicationSource = structuredClone(syntheticProgress());
  publicationSource.unexpected = true;
  publicationSource.terrainRequests.lastError =
    "https://terrain.invalid/tile?token=publication-secret";
  const publicationDiagnostic = classifyS5PageDiagnosticValue(
    publicationSource,
    "webgl",
  );
  const publicationArtifact = diagnosticErrorArtifact(
    publicationDiagnostic,
    "categorical publication round trip",
  );
  const publicationDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "c1229-s5-diagnostic-publication-"),
  );
  try {
    const publicationPaths = createS5ArtifactPaths(
      RUN_ID,
      publicationDirectory,
    );
    beginS5EvidenceRun(publicationPaths, RUN_ID);
    publishS5FinalArtifact(publicationPaths, publicationArtifact);
    const publishedBytes = fs.readFileSync(publicationPaths.run, "utf8");
    const publishedArtifact = JSON.parse(publishedBytes);
    assert.equal(validateS5FinalArtifactShape(publishedArtifact).ok, true);
    assert.equal(
      publishedArtifact.diagnostics.rawPage.json,
      publicationDiagnostic.rawPage.json,
    );
    assert.doesNotMatch(publishedBytes, /publication-secret/u);
  } finally {
    fs.rmSync(publicationDirectory, { recursive: true, force: true });
  }

  const sparseProgress = syntheticProgress();
  delete sparseProgress.completedPhases[4];
  assert.deepEqual(validateS5PageProgress(sparseProgress, "webgl").reasons, [
    "page progress completed phases are not an A-H prefix",
    "page progress reveal diagnostics began out of order",
  ]);
  const sparseClassified = classifyS5PageDiagnosticValue(
    sparseProgress,
    "webgl",
  );
  assert.equal(sparseClassified.pageValidation.status, "fulfilled-invalid");
  assert.equal(sparseClassified.page, null);
  assert.equal(
    validateS5RawPageDiagnosticJson(sparseClassified.rawPage.json, "webgl").ok,
    true,
  );

  const rendererMismatch = classifyS5PageDiagnosticValue(
    syntheticProgress("webgpu"),
    "webgl",
  );
  assert.equal(rendererMismatch.pageValidation.status, "fulfilled-invalid");
  assert.ok(
    rendererMismatch.pageValidation.reasons.includes(
      "page progress schema/renderer is invalid",
    ),
  );
  assert.equal(
    validateS5RawPageDiagnosticJson(rendererMismatch.rawPage.json, "webgl").ok,
    true,
  );
  assert.equal(
    validateS5RawPageDiagnosticJson(rendererMismatch.rawPage.json, "webgpu").ok,
    false,
  );
  assert.equal(
    validateS5FinalArtifactShape(
      diagnosticErrorArtifact(rendererMismatch, "renderer mismatch"),
    ).ok,
    true,
  );

  const witnessIdempotent = createS5PageValidationWitness(validHostile);
  assert.deepEqual(
    createS5PageValidationWitness(witnessIdempotent),
    witnessIdempotent,
  );
  const nonfiniteProgress = syntheticProgress();
  nonfiniteProgress.firstReveal.fillMesh.vertexCountWithoutSkirts = Number.NaN;
  const nonfiniteWitness = createS5PageValidationWitness(nonfiniteProgress);
  assert.equal(
    nonfiniteWitness.firstReveal.fillMesh.vertexCountWithoutSkirts,
    "[non-finite-number]",
  );
  const nonfiniteWitnessSecondPass =
    createS5PageValidationWitness(nonfiniteWitness);
  assert.deepEqual(nonfiniteWitnessSecondPass, nonfiniteWitness);
  assert.equal(
    nonfiniteWitnessSecondPass.firstReveal.fillMesh.vertexCountWithoutSkirts,
    "[non-finite-number]",
  );
  const classifiedNonfinite = classifyS5PageDiagnosticValue(
    nonfiniteProgress,
    "webgl",
  );
  assert.equal(classifiedNonfinite.pageValidation.status, "fulfilled-invalid");
  assert.equal(
    JSON.parse(classifiedNonfinite.rawPage.json).validationWitness.firstReveal
      .fillMesh.vertexCountWithoutSkirts,
    "[non-finite-number]",
  );
  const unbrandedForgery = structuredClone(nonfiniteWitness);
  const sanitizedForgery = createS5PageValidationWitness(unbrandedForgery);
  assert.equal(
    sanitizedForgery.firstReveal.fillMesh.vertexCountWithoutSkirts,
    "[unexpected]",
  );
  assert.equal(validateS5PageProgress(sanitizedForgery, "webgl").ok, false);

  const allowlistedGetterFailure = syntheticProgress();
  Object.defineProperty(allowlistedGetterFailure.terrainRequests, "lastError", {
    enumerable: true,
    get() {
      throw new Error("allowlisted getter secret");
    },
  });
  assert.equal(
    classifyS5PageDiagnosticValue(allowlistedGetterFailure, "webgl")
      .pageValidation.status,
    "rejected",
  );

  const d866Progress = structuredClone(syntheticProgress());
  d866Progress.orderProof.endUpdateCalls[0].targetStateAfter.terrainState =
    C12_29_S5_REVEAL_LIFECYCLE.terrainReceiving;
  d866Progress.firstReveal.predicateResults.postEndUpdateLoadTransitionExact = false;
  d866Progress.visibilitySeam.terminalReason =
    "first pass-through render did not produce the exact held L1 fill";
  assert.equal(validateS5PageProgress(d866Progress, "webgl").ok, true);
  const d866Classified = classifyS5PageDiagnosticValue(d866Progress, "webgl");
  assert.equal(d866Classified.pageValidation.status, "fulfilled-valid");
  assert.equal(
    d866Classified.page.firstReveal.predicateResults
      .postEndUpdateLoadTransitionExact,
    false,
  );
  assert.deepEqual(d866Classified.page.validationBasis.falsePredicateFields, [
    "postEndUpdateLoadTransitionExact",
  ]);
  const d866Artifact = diagnosticErrorArtifact(
    d866Classified,
    "d866 aggregate failure remains non-certifying",
  );
  assert.equal(validateS5FinalArtifactShape(d866Artifact).ok, true);
  for (const mutateD866 of [
    (page) =>
      (page.firstReveal.predicateResults.postEndUpdateLoadTransitionExact = true),
    (page) => (page.validationBasis.falsePredicateFields = []),
    (page) => (page.visibilitySeam.terminalReason = null),
  ]) {
    const mutated = structuredClone(d866Artifact);
    mutateD866(mutated.diagnostics.page);
    mutated.diagnostics.pageValidation.diagnosticSha256 = diagnosticSha256(
      mutated.diagnostics.page,
    );
    assert.equal(validateS5FinalArtifactShape(mutated).ok, false);
  }

  const extendVisibilityLedger = (count) => {
    const source = syntheticProgress();
    const calls = source.visibilitySeam.calls;
    const template = structuredClone(calls.at(-1));
    while (calls.length < count) {
      calls.push({ ...template, ordinal: calls.length + 1 });
    }
    const counts = source.visibilitySeam.counts;
    counts.totalCalls = calls.length;
    counts.originalCalls = calls.length;
    counts.targetCalls = calls.filter((call) => call.target).length;
    counts.nonTargetCalls = calls.filter((call) => !call.target).length;
    counts.overrideCalls = calls.filter((call) => call.overridden).length;
    counts.nonTargetAlteredCalls = calls.filter(
      (call) => !call.target && call.overridden,
    ).length;
    counts.skippedOriginalCalls = 0;
    return source;
  };
  const maximumVisibilityCalls = C12_29_S5_SCENE.fillWarmMaximumFrames * 64;
  for (const callCount of [65, maximumVisibilityCalls]) {
    const source = extendVisibilityLedger(callCount);
    const sourceValidation = validateS5PageProgress(source, "webgl");
    assert.deepEqual(sourceValidation, { ok: true, reasons: [] });
    const witness = createS5PageValidationWitness(source);
    assert.equal(
      witness.visibilitySeam.calls.schema,
      "c12-29-s5-validation-array-summary-v1",
    );
    assert.equal(witness.visibilitySeam.calls.path, "visibilitySeam.calls");
    assert.equal(witness.visibilitySeam.calls.length, callCount);
    assert.deepEqual(validateS5PageProgress(witness, "webgl"), {
      ok: true,
      reasons: [],
    });
    const diagnostic = classifyS5PageDiagnosticValue(source, "webgl");
    assert.equal(diagnostic.pageValidation.status, "fulfilled-valid");
    assert.equal(diagnostic.rawPage, null);
    assert.equal(
      validateS5PageDiagnosticProjection(diagnostic.page, "webgl"),
      true,
    );
    assert.ok(
      Buffer.byteLength(JSON.stringify(diagnostic.page), "utf8") <=
        C12_29_S5_RAW_PAGE_MAX_JSON_LENGTH,
    );

    // A page cannot submit a forged summary as if it were raw progress. Only
    // the locally branded witness produced after raw validation may use it.
    const unbrandedRoundTrip = JSON.parse(JSON.stringify(witness));
    assert.equal(validateS5PageProgress(unbrandedRoundTrip, "webgl").ok, false);
    assert.equal(
      classifyS5PageDiagnosticValue(unbrandedRoundTrip, "webgl").pageValidation
        .status,
      "rejected",
    );
  }

  const assertExactInvalidDiagnostic = (source, expectedReasons) => {
    const sourceValidation = validateS5PageProgress(source, "webgl");
    assert.deepEqual(sourceValidation.reasons, expectedReasons);
    const diagnostic = classifyS5PageDiagnosticValue(source, "webgl");
    assert.equal(diagnostic.pageValidation.status, "fulfilled-invalid");
    assert.deepEqual(diagnostic.pageValidation.reasons, expectedReasons);
    assert.equal(
      validateS5RawPageDiagnosticJson(diagnostic.rawPage.json, "webgl").ok,
      true,
    );
  };
  const sparseVisibilityReasons = [
    "page progress visibility seam diagnostics are inconsistent",
    "page progress first-reveal/order diagnostics are inconsistent",
  ];
  for (const callCount of [65, maximumVisibilityCalls]) {
    const sparse = extendVisibilityLedger(callCount);
    delete sparse.visibilitySeam.calls[Math.floor(callCount / 2)];
    assertExactInvalidDiagnostic(sparse, sparseVisibilityReasons);
  }

  const sparseSelected = syntheticProgress();
  sparseSelected.firstReveal.selectedTileIds.length = 65;
  sparseSelected.firstReveal.selectedCount = 65;
  assertExactInvalidDiagnostic(sparseSelected, [
    "page progress first-reveal/order diagnostics are inconsistent",
  ]);
  const sparseReal = syntheticProgress();
  sparseReal.firstReveal.realTileIds.length = 65;
  sparseReal.firstReveal.realMeshCount = 65;
  assertExactInvalidDiagnostic(sparseReal, [
    "page progress first-reveal/order diagnostics are inconsistent",
  ]);
  const sparseFill = syntheticProgress();
  sparseFill.firstReveal.fillTileIds.length = 65;
  sparseFill.firstReveal.fillCount = 65;
  assertExactInvalidDiagnostic(sparseFill, [
    "page progress first-reveal/order diagnostics are inconsistent",
  ]);
  const sparseOrder = syntheticProgress();
  sparseOrder.orderProof.showTileThisFrameCalls.length = 17;
  assertExactInvalidDiagnostic(sparseOrder, [
    "page progress first-reveal/order diagnostics are inconsistent",
  ]);

  const arrayShapeMutants = [
    (source) => {
      source.visibilitySeam.calls.extra = true;
    },
    (source) => {
      Object.defineProperty(source.visibilitySeam.calls, "01", {
        configurable: true,
        enumerable: true,
        value: source.visibilitySeam.calls[1],
      });
    },
    (source) => {
      const inherited = Object.create(Array.prototype);
      Object.defineProperty(inherited, "99", {
        configurable: true,
        value: source.visibilitySeam.calls[1],
      });
      Object.setPrototypeOf(source.visibilitySeam.calls, inherited);
    },
  ];
  for (const mutateArrayShape of arrayShapeMutants) {
    const source = syntheticProgress();
    mutateArrayShape(source);
    assertExactInvalidDiagnostic(source, sparseVisibilityReasons);
  }

  const maximumPlusOne = extendVisibilityLedger(maximumVisibilityCalls + 1);
  const maximumPlusOneSourceValidation = validateS5PageProgress(
    maximumPlusOne,
    "webgl",
  );
  assert.deepEqual(maximumPlusOneSourceValidation.reasons, [
    "page progress visibility seam diagnostics are inconsistent",
    "page progress first-reveal/order diagnostics are inconsistent",
  ]);
  const maximumPlusOneDiagnostic = classifyS5PageDiagnosticValue(
    maximumPlusOne,
    "webgl",
  );
  assert.equal(
    maximumPlusOneDiagnostic.pageValidation.status,
    "fulfilled-invalid",
  );
  assert.deepEqual(
    maximumPlusOneDiagnostic.pageValidation.reasons,
    maximumPlusOneSourceValidation.reasons,
  );
  assert.equal(
    validateS5RawPageDiagnosticJson(
      maximumPlusOneDiagnostic.rawPage.json,
      "webgl",
    ).ok,
    true,
  );
  assert.ok(
    Buffer.byteLength(maximumPlusOneDiagnostic.rawPage.json, "utf8") <=
      C12_29_S5_RAW_PAGE_MAX_JSON_LENGTH,
  );

  const largeSelectionProgress = syntheticProgress();
  const largeSelectedRealIds = Array.from(
    { length: 4_096 },
    (_, index) => `12/${index}/0`,
  );
  const largeFillIds = Array.from(
    { length: 4_096 },
    (_, index) => `12/${index + 4_096}/1`,
  );
  largeSelectionProgress.firstReveal.selectedTileIds = [
    ...largeSelectionProgress.firstReveal.selectedTileIds,
    ...largeSelectedRealIds,
    ...largeFillIds,
  ].sort();
  largeSelectionProgress.firstReveal.realTileIds = [
    ...largeSelectionProgress.firstReveal.realTileIds,
    ...largeSelectedRealIds,
  ].sort();
  largeSelectionProgress.firstReveal.fillTileIds = [
    ...largeSelectionProgress.firstReveal.fillTileIds,
    ...largeFillIds,
  ].sort();
  largeSelectionProgress.firstReveal.selectedCount =
    largeSelectionProgress.firstReveal.selectedTileIds.length;
  largeSelectionProgress.firstReveal.realMeshCount =
    largeSelectionProgress.firstReveal.realTileIds.length;
  largeSelectionProgress.firstReveal.fillCount =
    largeSelectionProgress.firstReveal.fillTileIds.length;
  assert.deepEqual(validateS5PageProgress(largeSelectionProgress, "webgl"), {
    ok: true,
    reasons: [],
  });
  const largeSelectionDiagnostic = classifyS5PageDiagnosticValue(
    largeSelectionProgress,
    "webgl",
  );
  assert.equal(
    largeSelectionDiagnostic.pageValidation.status,
    "fulfilled-valid",
  );
  assert.equal(
    validateS5PageDiagnosticProjection(largeSelectionDiagnostic.page, "webgl"),
    true,
  );
  for (const field of ["selectedTileIds", "realTileIds", "fillTileIds"]) {
    assert.equal(
      largeSelectionDiagnostic.page.validationWitness.firstReveal[field].schema,
      "c12-29-s5-validation-array-summary-v1",
    );
  }
  assert.ok(
    Buffer.byteLength(JSON.stringify(largeSelectionDiagnostic.page), "utf8") <=
      C12_29_S5_RAW_PAGE_MAX_JSON_LENGTH,
  );
  const largeSelectionArtifact = diagnosticErrorArtifact(
    largeSelectionDiagnostic,
    "large selection ledger diagnostic",
  );
  assert.equal(validateS5FinalArtifactShape(largeSelectionArtifact).ok, true);
  const largeSelectionBytes = serializeS5Artifact(largeSelectionArtifact);
  const largeSelectionRoundTrip = JSON.parse(largeSelectionBytes);
  assert.equal(validateS5FinalArtifactShape(largeSelectionRoundTrip).ok, true);
  assert.equal(
    serializeS5Artifact(largeSelectionRoundTrip),
    largeSelectionBytes,
  );
  for (const mutateLargeWitness of [
    (page) => page.validationWitness.firstReveal.selectedCount++,
    (page) => (page.validationWitness.firstReveal.longitude = 0),
    (page) =>
      (page.validationWitness.firstReveal.predicateResults.targetSelected = false),
    (page) =>
      (page.validationWitness.firstReveal.selectedTileIds.path =
        "firstReveal.realTileIds"),
    (page) => page.validationWitness.firstReveal.selectedTileIds.length++,
    (page) =>
      (page.validationWitness.firstReveal.selectedTileIds.sha256 = "0".repeat(
        64,
      )),
    (page) =>
      (page.validationWitness.firstReveal.selectedTileIds.facts.firstRevealArrayRelationsValid = false),
    (page) =>
      (page.validationWitness.firstReveal.realTileIds = structuredClone(
        page.validationWitness.firstReveal.selectedTileIds,
      )),
  ]) {
    const mutated = structuredClone(largeSelectionArtifact);
    mutateLargeWitness(mutated.diagnostics.page);
    mutated.diagnostics.pageValidation.diagnosticSha256 = diagnosticSha256(
      mutated.diagnostics.page,
    );
    assert.equal(validateS5FinalArtifactShape(mutated).ok, false);
  }

  const maximumOrderProgress = syntheticProgress();
  const nonTargetShow = structuredClone(
    maximumOrderProgress.orderProof.showTileThisFrameCalls[0],
  );
  const targetShow = structuredClone(
    maximumOrderProgress.orderProof.showTileThisFrameCalls[1],
  );
  maximumOrderProgress.orderProof.showTileThisFrameCalls = Array.from(
    { length: 64 },
    (_, index) => {
      const target = index === 63;
      return {
        ...(target ? targetShow : nonTargetShow),
        ordinal: index + 1,
        enterEventOrdinal: index * 2 + 1,
        exitEventOrdinal: index * 2 + 2,
      };
    },
  );
  maximumOrderProgress.orderProof.endUpdateCalls[0].enterEventOrdinal = 129;
  maximumOrderProgress.orderProof.endUpdateCalls[0].exitEventOrdinal = 130;
  maximumOrderProgress.orderProof.eventCount = 130;
  assert.deepEqual(validateS5PageProgress(maximumOrderProgress, "webgl"), {
    ok: true,
    reasons: [],
  });
  const maximumOrderDiagnostic = classifyS5PageDiagnosticValue(
    maximumOrderProgress,
    "webgl",
  );
  assert.equal(maximumOrderDiagnostic.pageValidation.status, "fulfilled-valid");
  assert.equal(
    maximumOrderDiagnostic.page.validationWitness.orderProof
      .showTileThisFrameCalls.length,
    64,
  );
  assert.equal(
    maximumOrderDiagnostic.page.validationWitness.orderProof
      .showTileThisFrameCalls.schema,
    "c12-29-s5-validation-array-summary-v1",
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(maximumOrderDiagnostic.page), "utf8") <=
      C12_29_S5_RAW_PAGE_MAX_JSON_LENGTH,
  );

  const invalidErrorArtifact = diagnosticErrorArtifact(
    classified,
    "simulated invalid page progress",
  );
  assert.equal(validateS5FinalArtifactShape(invalidErrorArtifact).ok, true);
  const crossFieldRawForge = structuredClone(invalidErrorArtifact);
  const crossFieldRaw = JSON.parse(crossFieldRawForge.diagnostics.rawPage.json);
  crossFieldRaw.step = numericPathSecret;
  crossFieldRaw.validationWitness.step = numericPathSecret;
  crossFieldRawForge.diagnostics.rawPage.json = JSON.stringify(crossFieldRaw);
  crossFieldRawForge.diagnostics.pageValidation.diagnosticSha256 = createHash(
    "sha256",
  )
    .update(crossFieldRawForge.diagnostics.rawPage.json, "utf8")
    .digest("hex");
  assert.equal(validateS5FinalArtifactShape(crossFieldRawForge).ok, false);

  const openEndedSentinelForge = structuredClone(invalidErrorArtifact);
  const openEndedSentinelRaw = JSON.parse(
    openEndedSentinelForge.diagnostics.rawPage.json,
  );
  openEndedSentinelRaw.step = "[invalid-super-secret-token]";
  openEndedSentinelRaw.validationWitness.step = "[invalid-super-secret-token]";
  openEndedSentinelForge.diagnostics.rawPage.json =
    JSON.stringify(openEndedSentinelRaw);
  openEndedSentinelForge.diagnostics.pageValidation.diagnosticSha256 =
    createHash("sha256")
      .update(openEndedSentinelForge.diagnostics.rawPage.json, "utf8")
      .digest("hex");
  assert.equal(validateS5FinalArtifactShape(openEndedSentinelForge).ok, false);

  const nonSequentialSentinelForge = structuredClone(invalidErrorArtifact);
  const nonSequentialSentinelRaw = JSON.parse(
    nonSequentialSentinelForge.diagnostics.rawPage.json,
  );
  nonSequentialSentinelRaw.validationWitness.__unexpected_s5_9999 =
    "[unexpected]";
  nonSequentialSentinelForge.diagnostics.rawPage.json = JSON.stringify(
    nonSequentialSentinelRaw,
  );
  nonSequentialSentinelForge.diagnostics.pageValidation.diagnosticSha256 =
    createHash("sha256")
      .update(nonSequentialSentinelForge.diagnostics.rawPage.json, "utf8")
      .digest("hex");
  assert.equal(
    validateS5FinalArtifactShape(nonSequentialSentinelForge).ok,
    false,
  );

  for (const sentinelValue of [
    true,
    numericWitnessSecret,
    "RENDERED",
    null,
    { targetFill: true },
    ["RENDERED"],
  ]) {
    const sentinelValueForge = structuredClone(invalidErrorArtifact);
    const sentinelValueRaw = JSON.parse(
      sentinelValueForge.diagnostics.rawPage.json,
    );
    assert.equal(
      sentinelValueRaw.validationWitness.__unexpected_s5_0001,
      "[unexpected]",
    );
    sentinelValueRaw.validationWitness.__unexpected_s5_0001 = sentinelValue;
    sentinelValueForge.diagnostics.rawPage.json =
      JSON.stringify(sentinelValueRaw);
    sentinelValueForge.diagnostics.pageValidation.diagnosticSha256 = createHash(
      "sha256",
    )
      .update(sentinelValueForge.diagnostics.rawPage.json, "utf8")
      .digest("hex");
    assert.equal(
      validateS5RawPageDiagnosticJson(
        sentinelValueForge.diagnostics.rawPage.json,
        "webgl",
      ).ok,
      false,
    );
    assert.equal(validateS5FinalArtifactShape(sentinelValueForge).ok, false);
  }

  const misplacedRawKnownKeyForge = structuredClone(invalidErrorArtifact);
  const misplacedRawKnownKey = JSON.parse(
    misplacedRawKnownKeyForge.diagnostics.rawPage.json,
  );
  const misplacedRootSentinels = Object.entries(
    misplacedRawKnownKey.validationWitness,
  ).filter(([key]) => /^__unexpected_s5_\d{4}$/u.test(key));
  misplacedRawKnownKey.validationWitness = Object.fromEntries([
    ...Object.entries(misplacedRawKnownKey.validationWitness).filter(
      ([key]) => !/^__unexpected_s5_\d{4}$/u.test(key),
    ),
    ["targetFill", numericWitnessSecret],
    ...misplacedRootSentinels,
  ]);
  misplacedRawKnownKeyForge.diagnostics.rawPage.json =
    JSON.stringify(misplacedRawKnownKey);
  misplacedRawKnownKeyForge.diagnostics.pageValidation.diagnosticSha256 =
    createHash("sha256")
      .update(misplacedRawKnownKeyForge.diagnostics.rawPage.json, "utf8")
      .digest("hex");
  assert.equal(
    validateS5RawPageDiagnosticJson(
      misplacedRawKnownKeyForge.diagnostics.rawPage.json,
      "webgl",
    ).ok,
    false,
  );
  assert.equal(
    validateS5FinalArtifactShape(misplacedRawKnownKeyForge).ok,
    false,
  );

  const movedSubtreeForge = structuredClone(invalidErrorArtifact);
  const movedSubtreeRaw = JSON.parse(
    movedSubtreeForge.diagnostics.rawPage.json,
  );
  const pickSentinels = Object.entries(
    movedSubtreeRaw.validationWitness.pick,
  ).filter(([key]) => /^__unexpected_s5_\d{4}$/u.test(key));
  movedSubtreeRaw.validationWitness.pick = Object.fromEntries([
    ...Object.entries(movedSubtreeRaw.validationWitness.pick).filter(
      ([key]) => !/^__unexpected_s5_\d{4}$/u.test(key),
    ),
    [
      "providerFlags",
      {
        hasLoadedTilesThisFrame: true,
        hasFillTilesThisFrame: true,
        loadedAndFillFlags: true,
      },
    ],
    ...pickSentinels,
  ]);
  movedSubtreeForge.diagnostics.rawPage.json = JSON.stringify(movedSubtreeRaw);
  movedSubtreeForge.diagnostics.pageValidation.diagnosticSha256 = createHash(
    "sha256",
  )
    .update(movedSubtreeForge.diagnostics.rawPage.json, "utf8")
    .digest("hex");
  assert.equal(
    validateS5RawPageDiagnosticJson(
      movedSubtreeForge.diagnostics.rawPage.json,
      "webgl",
    ).ok,
    false,
  );
  assert.equal(validateS5FinalArtifactShape(movedSubtreeForge).ok, false);

  const canonicalRawJson = invalidErrorArtifact.diagnostics.rawPage.json;
  const coordinatedAssertionMutant = structuredClone(invalidErrorArtifact);
  const coordinatedRaw = JSON.parse(
    coordinatedAssertionMutant.diagnostics.rawPage.json,
  );
  const coordinatedField = C12_29_S5_PAGE_VALIDATION_FAILURE_FIELDS.find(
    (field) => coordinatedRaw.validationFailures[field],
  );
  assert.ok(coordinatedField);
  coordinatedRaw.validationFailures[coordinatedField] = false;
  coordinatedRaw.validationBasis.validationFailureFields =
    C12_29_S5_PAGE_VALIDATION_FAILURE_FIELDS.filter(
      (field) => coordinatedRaw.validationFailures[field],
    );
  coordinatedAssertionMutant.diagnostics.pageValidation.reasons =
    C12_29_S5_PAGE_VALIDATION_REASONS.filter(
      (_reason, index) =>
        coordinatedRaw.validationFailures[
          C12_29_S5_PAGE_VALIDATION_FAILURE_FIELDS[index]
        ],
    );
  coordinatedAssertionMutant.diagnostics.rawPage.json =
    JSON.stringify(coordinatedRaw);
  coordinatedAssertionMutant.diagnostics.pageValidation.diagnosticSha256 =
    createHash("sha256")
      .update(coordinatedAssertionMutant.diagnostics.rawPage.json, "utf8")
      .digest("hex");
  assert.equal(
    validateS5FinalArtifactShape(coordinatedAssertionMutant).ok,
    false,
  );

  for (const forgeWitness of [
    (raw) => delete raw.validationWitness,
    (raw) => (raw.validationWitness = {}),
    (raw) =>
      (raw.validationWitness.firstReveal.predicateResults.targetFill = true),
  ]) {
    const mutated = structuredClone(invalidErrorArtifact);
    const raw = JSON.parse(mutated.diagnostics.rawPage.json);
    forgeWitness(raw);
    mutated.diagnostics.rawPage.json = JSON.stringify(raw);
    mutated.diagnostics.pageValidation.diagnosticSha256 = createHash("sha256")
      .update(mutated.diagnostics.rawPage.json, "utf8")
      .digest("hex");
    assert.equal(validateS5FinalArtifactShape(mutated).ok, false);
  }

  const duplicateKeyJson = `{"schema":"collision-secret",${canonicalRawJson.slice(1)}`;
  assert.equal(
    JSON.parse(duplicateKeyJson).schema,
    JSON.parse(canonicalRawJson).schema,
  );
  assert.equal(validateS5RawPageDiagnosticJson(duplicateKeyJson).ok, false);
  const duplicateKeyMutant = structuredClone(invalidErrorArtifact);
  duplicateKeyMutant.diagnostics.rawPage.json = duplicateKeyJson;
  duplicateKeyMutant.diagnostics.pageValidation.diagnosticSha256 = createHash(
    "sha256",
  )
    .update(duplicateKeyJson, "utf8")
    .digest("hex");
  assert.equal(validateS5FinalArtifactShape(duplicateKeyMutant).ok, false);

  const reorderedRaw = Object.fromEntries(
    Object.entries(JSON.parse(canonicalRawJson)).reverse(),
  );
  const reorderedRawJson = JSON.stringify(reorderedRaw);
  assert.equal(validateS5RawPageDiagnosticJson(reorderedRawJson).ok, false);
  const whitespaceRawJson = `${canonicalRawJson.slice(0, 1)} ${canonicalRawJson.slice(1)}`;
  assert.equal(validateS5RawPageDiagnosticJson(whitespaceRawJson).ok, false);

  for (const mutateReasons of [
    (reasons) => (reasons[0] = "fabricated reason"),
    (reasons) => reasons.push(reasons[0]),
    (reasons) => reasons.reverse(),
    (reasons) => reasons.splice(0, 1),
  ]) {
    const mutated = structuredClone(invalidErrorArtifact);
    mutateReasons(mutated.diagnostics.pageValidation.reasons);
    assert.equal(validateS5FinalArtifactShape(mutated).ok, false);
  }

  const basisMutant = structuredClone(invalidErrorArtifact);
  const basisRaw = JSON.parse(basisMutant.diagnostics.rawPage.json);
  const assertedFailure = C12_29_S5_PAGE_VALIDATION_FAILURE_FIELDS.find(
    (field) => basisRaw.validationFailures[field],
  );
  assert.ok(assertedFailure);
  basisRaw.validationFailures[assertedFailure] = false;
  basisMutant.diagnostics.rawPage.json = JSON.stringify(basisRaw);
  basisMutant.diagnostics.pageValidation.diagnosticSha256 = createHash("sha256")
    .update(basisMutant.diagnostics.rawPage.json, "utf8")
    .digest("hex");
  assert.equal(validateS5FinalArtifactShape(basisMutant).ok, false);

  const falsePredicateBasisMutant = structuredClone(invalidErrorArtifact);
  const falsePredicateBasisRaw = JSON.parse(
    falsePredicateBasisMutant.diagnostics.rawPage.json,
  );
  const falsePredicate =
    falsePredicateBasisRaw.validationBasis.falsePredicateFields[0];
  assert.ok(falsePredicate);
  falsePredicateBasisRaw.firstReveal.predicateResults[falsePredicate] = true;
  falsePredicateBasisMutant.diagnostics.rawPage.json = JSON.stringify(
    falsePredicateBasisRaw,
  );
  falsePredicateBasisMutant.diagnostics.pageValidation.diagnosticSha256 =
    createHash("sha256")
      .update(falsePredicateBasisMutant.diagnostics.rawPage.json, "utf8")
      .digest("hex");
  assert.equal(
    validateS5FinalArtifactShape(falsePredicateBasisMutant).ok,
    false,
  );

  const rawUnknownKeyMutators = [
    (raw) => (raw.secret = "top-secret"),
    (raw) => (raw.terrainRequests.password = "terrain-secret"),
    (raw) => (raw.pick.authorization = "pick-secret"),
    (raw) => (raw.firstReveal.secret = "reveal-secret"),
    (raw) => (raw.firstReveal.predicateResults.apiToken = "predicate-secret"),
    (raw) => (raw.orderProof.cookie = "order-secret"),
    (raw) => (raw.visibilitySeam.credential = "seam-secret"),
    (raw) => (raw.validationFailures.unexpected = true),
    (raw) => (raw.validationBasis.unexpected = "basis-secret"),
  ];
  for (const mutateRaw of rawUnknownKeyMutators) {
    const mutated = structuredClone(invalidErrorArtifact);
    const raw = JSON.parse(mutated.diagnostics.rawPage.json);
    mutateRaw(raw);
    mutated.diagnostics.rawPage.json = JSON.stringify(raw);
    assert.equal(validateS5FinalArtifactShape(mutated).ok, false);
  }

  for (const rawJson of ["null", "[]", '"scalar"', "{", "123"]) {
    const mutated = structuredClone(invalidErrorArtifact);
    mutated.diagnostics.rawPage.json = rawJson;
    assert.equal(validateS5FinalArtifactShape(mutated).ok, false);
  }

  assert.deepEqual(
    invalidErrorArtifact.diagnostics.pageValidation.reasons,
    C12_29_S5_PAGE_VALIDATION_REASONS.filter(
      (_reason, index) =>
        JSON.parse(invalidErrorArtifact.diagnostics.rawPage.json)
          .validationFailures[C12_29_S5_PAGE_VALIDATION_FAILURE_FIELDS[index]],
    ),
  );
  for (const status of ["not-read", "fulfilled-valid", "rejected", "timeout"]) {
    const mutated = structuredClone(invalidErrorArtifact);
    mutated.diagnostics.pageValidation = {
      status,
      reasons: [],
      diagnosticSha256: null,
    };
    assert.equal(validateS5FinalArtifactShape(mutated).ok, false);
  }
  const missingRaw = structuredClone(invalidErrorArtifact);
  missingRaw.diagnostics.rawPage = null;
  assert.equal(validateS5FinalArtifactShape(missingRaw).ok, false);
  const missingInvalidRenderer = structuredClone(invalidErrorArtifact);
  missingInvalidRenderer.diagnostics.renderer = null;
  assert.equal(validateS5FinalArtifactShape(missingInvalidRenderer).ok, false);
  assert.equal(
    validateS5FinalArtifactShape({
      ...invalidErrorArtifact,
      diagnostics: {
        ...invalidErrorArtifact.diagnostics,
        page: syntheticProgress(),
      },
    }).ok,
    false,
  );
  assert.equal(
    validateS5FinalArtifactShape({
      ...invalidErrorArtifact,
      diagnostics: {
        ...invalidErrorArtifact.diagnostics,
        rawPage: {
          ...classified.rawPage,
          json: `"${"界".repeat(C12_29_S5_RAW_PAGE_MAX_JSON_LENGTH)}"`,
        },
      },
    }).ok,
    false,
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

    const v4Directory = path.join(temp, "finalized-v4-latest");
    fs.mkdirSync(v4Directory);
    const v4Paths = createS5ArtifactPaths(IMAGE_IDS[4], v4Directory);
    fs.writeFileSync(
      v4Paths.latest,
      JSON.stringify({
        schema: V4_SCHEMA,
        runId: RUN_ID,
        status: "PASS",
        exitCode: 0,
        incomplete: false,
        artifactName: `${RUN_ID}.json`,
      }),
    );
    assert.equal(inspectS5PriorState(v4Paths).latest.schema, V4_SCHEMA);
    const v6StartOverV4 = beginS5EvidenceRun(v4Paths, IMAGE_IDS[4]);
    assert.equal(v6StartOverV4.prior.latest.schema, V4_SCHEMA);
    assert.equal(v6StartOverV4.running.schema, C12_29_S5_SCHEMA);
    assert.equal(v6StartOverV4.running.status, "RUNNING");

    const v6Directory = path.join(temp, "finalized-v6-latest");
    fs.mkdirSync(v6Directory);
    const v6Paths = createS5ArtifactPaths(IMAGE_IDS[5], v6Directory);
    fs.writeFileSync(
      v6Paths.latest,
      JSON.stringify({
        schema: V6_SCHEMA,
        runId: RUN_ID,
        status: "ERROR",
        exitCode: 2,
        incomplete: false,
        artifactName: `${RUN_ID}.json`,
        error: "archived v6 diagnostic outcome",
      }),
    );
    const v7StartOverV6 = beginS5EvidenceRun(v6Paths, IMAGE_IDS[5]);
    assert.equal(v7StartOverV6.prior.latest.schema, V6_SCHEMA);
    assert.equal(v7StartOverV6.prior.latest.status, "ERROR");
    assert.equal(v7StartOverV6.running.schema, C12_29_S5_SCHEMA);
    assert.equal(v7StartOverV6.running.status, "RUNNING");

    const v7Directory = path.join(temp, "finalized-v7-latest");
    fs.mkdirSync(v7Directory);
    const v7Paths = createS5ArtifactPaths(IMAGE_IDS[6], v7Directory);
    fs.writeFileSync(
      v7Paths.latest,
      JSON.stringify({
        schema: V7_SCHEMA,
        runId: RUN_ID,
        status: "ERROR",
        exitCode: 2,
        incomplete: false,
        artifactName: `${RUN_ID}.json`,
        error: "archived v7 diagnostic outcome",
      }),
    );
    const v9StartOverV7 = beginS5EvidenceRun(v7Paths, IMAGE_IDS[6]);
    assert.equal(v9StartOverV7.prior.latest.schema, V7_SCHEMA);
    assert.equal(v9StartOverV7.prior.latest.status, "ERROR");
    assert.equal(v9StartOverV7.running.schema, C12_29_S5_SCHEMA);
    assert.equal(v9StartOverV7.running.status, "RUNNING");
    assert.equal(v7StartOverV6.running.incomplete, true);

    const v8Directory = path.join(temp, "finalized-v8-latest");
    fs.mkdirSync(v8Directory);
    const v8Paths = createS5ArtifactPaths(IMAGE_IDS[7], v8Directory);
    fs.writeFileSync(
      v8Paths.latest,
      JSON.stringify({
        schema: V8_SCHEMA,
        runId: RUN_ID,
        status: "ERROR",
        exitCode: 2,
        incomplete: false,
        artifactName: `${RUN_ID}.json`,
        error: "archived v8 diagnostic outcome",
      }),
    );
    const v9StartOverV8 = beginS5EvidenceRun(v8Paths, IMAGE_IDS[7]);
    assert.equal(v9StartOverV8.prior.latest.schema, V8_SCHEMA);
    assert.equal(v9StartOverV8.prior.latest.status, "ERROR");
    assert.equal(v9StartOverV8.running.schema, C12_29_S5_SCHEMA);
    assert.equal(v9StartOverV8.running.status, "RUNNING");
    assert.equal(v9StartOverV8.running.incomplete, true);

    const v9Directory = path.join(temp, "finalized-v9-latest");
    fs.mkdirSync(v9Directory);
    const v9Paths = createS5ArtifactPaths(IMAGE_IDS[0], v9Directory);
    fs.writeFileSync(
      v9Paths.latest,
      JSON.stringify({
        schema: V9_SCHEMA,
        runId: RUN_ID,
        status: "STRUCTURAL",
        exitCode: 3,
        incomplete: false,
        artifactName: `${RUN_ID}.json`,
      }),
    );
    const v10StartOverV9 = beginS5EvidenceRun(v9Paths, IMAGE_IDS[0]);
    assert.equal(v10StartOverV9.prior.latest.schema, V9_SCHEMA);
    assert.equal(v10StartOverV9.prior.latest.status, "STRUCTURAL");
    assert.equal(v10StartOverV9.running.schema, C12_29_S5_SCHEMA);
    assert.equal(v10StartOverV9.running.status, "RUNNING");
    assert.equal(v10StartOverV9.running.incomplete, true);

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
    assert.throws(
      () => publishS5FinalArtifact(paths, artifact, operations, "wrong bytes"),
      /changed after canonical materialization/u,
    );
    assert.equal(fs.existsSync(paths.run), false);
    events.length = 0;
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
  assert.equal((specSource.match(/^test\(/gmu) ?? []).length, 25);
  assert.equal(C12_29_S5_SOURCE_FILES.length, 43);
  assert.equal(new Set(C12_29_S5_SOURCE_FILES).size, 43);
  assert.equal(C12_29_S5_BUILD_SOURCE_FILES.length, 41);
  assert.equal(
    C12_29_S5_SOURCE_FILES.includes(
      "packages/engine/Source/Core/Visibility.js",
    ),
    true,
  );
  assert.equal(
    C12_29_S5_SOURCE_FILES.includes(
      "packages/engine/Source/Scene/TileSelectionResult.js",
    ),
    true,
  );
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
  assert.match(
    probeSource,
    /deviceGate: globalThis\.__c1229S5DeviceGate \?\? \{\s*gpuErrors: \[\],\s*deviceLost: false,\s*\}/u,
  );
  assert.match(
    probeSource,
    /runtime: \{\s*pageErrors,\s*consoleErrors,\s*ignoredConsoleErrors,\s*gpuErrors: settledDeviceGate\.gpuErrors,\s*deviceLost: settledDeviceGate\.deviceLost,\s*deviceLostReason: settledDeviceGate\.deviceLostReason,\s*deviceLostMessage: settledDeviceGate\.deviceLostMessage,\s*cleanupComplete: false,\s*\}/u,
  );
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
  assert.doesNotMatch(
    probeSource,
    /frontierScreenSpaceErrorCandidates|frontierLatitudeStepDegrees|frontierMaxSteps|frontierSettleMaxFrames/u,
  );
  const providerCreation = probeSource.indexOf(
    "const quantizedProvider = await C.CesiumTerrainProvider.fromUrl(quantizedUrl);",
  );
  const targetUndefinedDeclaration = probeSource.indexOf(
    "let holdTarget;",
    providerCreation,
  );
  const installVisibilityWrapper = probeSource.indexOf(
    "Object.defineProperty(providerBeforeSwap, visibilityProperty, {",
    targetUndefinedDeclaration,
  );
  const providerAssignment = probeSource.indexOf(
    "scene.terrainProvider = quantizedProvider;",
    installVisibilityWrapper,
  );
  const quantizedWarmupSettle = probeSource.indexOf(
    'markProgress(contract.phases[2], "settle-quantized-warm-visibility-mask");',
    providerAssignment,
  );
  const settledWarmupProof = probeSource.indexOf(
    "!warmupProof.settled",
    quantizedWarmupSettle,
  );
  const deferredTargetAssignment = probeSource.indexOf(
    "holdTarget = fillTarget;",
    settledWarmupProof,
  );
  const exactHoldArm = probeSource.indexOf(
    "holdEnabled = true;",
    deferredTargetAssignment,
  );
  const passThroughSwitch = probeSource.indexOf(
    'visibilityMode = "pass-through";',
    exactHoldArm,
  );
  const installShowOrderWrapper = probeSource.indexOf(
    'Object.defineProperty(providerBeforeSwap, "showTileThisFrame", {',
    passThroughSwitch,
  );
  const installEndOrderWrapper = probeSource.indexOf(
    'Object.defineProperty(providerBeforeSwap, "endUpdate", {',
    installShowOrderWrapper,
  );
  const publishOrderProof = probeSource.indexOf(
    "progress.orderProof = orderProof;",
    installEndOrderWrapper,
  );
  const publishRevealStarted = probeSource.indexOf(
    "progress.firstReveal = firstRevealProof;",
    publishOrderProof,
  );
  const firstRevealCapture = probeSource.indexOf(
    "const fillImageId = captureDocumentaryPng(contract.captureLabels[0]);",
    passThroughSwitch,
  );
  const revealSnapshot = probeSource.indexOf(
    "const cSnapshot = snapshotTerrain();",
    firstRevealCapture,
  );
  const publishRawReveal = probeSource.indexOf(
    "Object.assign(firstRevealProof, {",
    revealSnapshot,
  );
  const immediateRestore = probeSource.indexOf(
    'restoreVisibilitySeam("immediately-after-reveal-snapshot");',
    publishRawReveal,
  );
  const immediateOrderRestore = probeSource.indexOf(
    'restoreOrderInstrumentation("immediately-after-reveal-snapshot");',
    immediateRestore,
  );
  const publishPredicateResults = probeSource.indexOf(
    "firstRevealProof.predicateResults = {",
    immediateOrderRestore,
  );
  const aggregateRevealGate = probeSource.indexOf(
    "if (!Object.values(firstRevealProof.predicateResults).every(Boolean))",
    publishPredicateResults,
  );
  const releasePhase = probeSource.indexOf(
    'markProgress(contract.phases[3], "release-held-requests"',
    immediateRestore,
  );
  const restoreProductionSse = probeSource.indexOf(
    "globe.maximumScreenSpaceError = contract.terrainMaximumScreenSpaceError;",
    releasePhase,
  );
  assert.ok(
    providerCreation >= 0 &&
      providerCreation < targetUndefinedDeclaration &&
      targetUndefinedDeclaration < installVisibilityWrapper &&
      installVisibilityWrapper < providerAssignment &&
      providerAssignment < quantizedWarmupSettle &&
      targetUndefinedDeclaration < quantizedWarmupSettle &&
      quantizedWarmupSettle < settledWarmupProof &&
      deferredTargetAssignment < exactHoldArm &&
      settledWarmupProof < exactHoldArm &&
      exactHoldArm < passThroughSwitch &&
      passThroughSwitch < installShowOrderWrapper &&
      installShowOrderWrapper < installEndOrderWrapper &&
      installEndOrderWrapper < publishOrderProof &&
      publishOrderProof < publishRevealStarted &&
      publishRevealStarted < firstRevealCapture &&
      firstRevealCapture < revealSnapshot &&
      revealSnapshot < publishRawReveal &&
      publishRawReveal < immediateRestore &&
      immediateRestore < immediateOrderRestore &&
      immediateOrderRestore < publishPredicateResults &&
      publishPredicateResults < aggregateRevealGate &&
      immediateRestore < releasePhase &&
      releasePhase < restoreProductionSse,
  );
  assert.doesNotMatch(
    probeSource.slice(passThroughSwitch, firstRevealCapture),
    /\bawait\b/u,
  );
  assert.doesNotMatch(
    probeSource.slice(publishRevealStarted, firstRevealCapture),
    /renderNow\s*\(/u,
  );
  assert.equal(
    (
      probeSource.match(
        /captureDocumentaryPng\(contract\.captureLabels\[0\]\)/gu,
      ) ?? []
    ).length,
    1,
  );
  assert.match(
    probeSource,
    /originalComputeTileVisibility\.call\([\s\S]*?const returnedVisibility =[\s\S]*?visibilityMode === "warm-mask" && target[\s\S]*?C\.Visibility\.NONE[\s\S]*?: originalVisibility/u,
  );
  assert.match(
    probeSource,
    /if \(visibilityOwnDescriptorBefore\)[\s\S]*?Object\.defineProperty\([\s\S]*?visibilityOwnDescriptorBefore[\s\S]*?else \{[\s\S]*?delete providerBeforeSwap\[visibilityProperty\]/u,
  );
  assert.match(
    probeSource,
    /finally \{[\s\S]*?restoreVisibilitySeam\(restorationAttempt\);[\s\S]*?restoreOrderInstrumentation\(restorationAttempt\);[\s\S]*?orderProof\.restoration\.finallyVerified/u,
  );
  assert.match(probeSource, /globe\.preloadSiblings = false;/u);
  assert.match(probeSource, /let holdEnabled = false;/u);
  assert.doesNotMatch(
    probeSource,
    /\b(?:deriveS5CardinalLevelOneCandidates|evaluateS5HoldCandidateObservation)\b/u,
  );
  assert.match(
    probeSource,
    /requestAttemptsByKey\.has\(key\)[\s\S]*?key === holdTarget\?\.key/u,
  );
  const x2Phase = probeSource.indexOf(
    'markProgress(contract.phases[4], "settle-exaggerated-terrain")',
  );
  const eclipseOff = probeSource.indexOf(
    "lighting.enableEclipseGlobeShadow = false;",
    x2Phase,
  );
  const prewarmOff = probeSource.indexOf(
    "const x2OffPrewarm = await prewarmWebGPUGlobeCarrierState(",
    eclipseOff,
  );
  const captureOff = probeSource.indexOf(
    "captureDocumentaryPng(contract.captureLabels[2])",
    prewarmOff,
  );
  const eclipseOn = probeSource.indexOf(
    "lighting.enableEclipseGlobeShadow = true;",
    captureOff,
  );
  const prewarmOn = probeSource.indexOf(
    "const x2OnPrewarm = await prewarmWebGPUGlobeCarrierState(",
    eclipseOn,
  );
  const captureOn = probeSource.indexOf(
    "captureDocumentaryPng(contract.captureLabels[3])",
    prewarmOn,
  );
  assert.ok(
    x2Phase >= 0 &&
      x2Phase < eclipseOff &&
      eclipseOff < prewarmOff &&
      prewarmOff < captureOff &&
      captureOff < eclipseOn &&
      eclipseOn < prewarmOn &&
      prewarmOn < captureOn,
  );
  assert.match(
    probeSource,
    /scene\.frameState\.commandList\.filter\([\s\S]*?isWebGPUDrawCommand === true[\s\S]*?command\?\.pass === C\.Pass\.GLOBE/u,
  );
  assert.match(
    probeSource,
    /command\?\._pipeline[\s\S]*?command\?\._vertexBuffer[\s\S]*?command\?\._indexBuffer[\s\S]*?command\._indexCount > 0/u,
  );
  assert.ok(
    probeSource.indexOf("holdEnabled = false;") <
      probeSource.indexOf(
        "for (const entry of held.values()) entry.release();",
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
  assert.match(
    probeSource,
    /function assertS5CanonicalJsonSafe\([\s\S]*?Number\.isFinite\(entry\)[\s\S]*?Object\.is\(entry, -0\)[\s\S]*?has a JSON cycle/u,
  );
  const canonicalReport = probeSource.indexOf(
    "const report = materializeS5CanonicalJsonValue(",
  );
  const firstCertificationFold = probeSource.indexOf(
    "const verdict = foldC1229S5Gate(report);",
    canonicalReport,
  );
  const canonicalArtifact = probeSource.indexOf(
    "const artifactMaterialization = materializeS5CanonicalJsonValue(",
    firstCertificationFold,
  );
  const archiveBoundFold = probeSource.indexOf(
    "const archiveBoundVerdict = foldC1229S5Gate({",
    canonicalArtifact,
  );
  const finalPublication = probeSource.indexOf(
    "const publication = publishS5FinalArtifact(",
    archiveBoundFold,
  );
  assert.ok(
    canonicalReport >= 0 &&
      canonicalReport < firstCertificationFold &&
      firstCertificationFold < canonicalArtifact &&
      canonicalArtifact < archiveBoundFold &&
      archiveBoundFold < finalPublication,
  );
  assert.match(
    probeSource.slice(archiveBoundFold, finalPublication),
    /isDeepStrictEqual\(archiveBoundVerdict, verdict\)/u,
  );
  assert.match(
    probeSource.slice(finalPublication),
    /publishS5FinalArtifact\([\s\S]*?artifactMaterialization\.bytes/u,
  );
  assert.match(probeSource, /coherentSameFrameOrderSurfaces:/u);
  assert.doesNotMatch(
    probeSource,
    /(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:build|start|serve)/u,
  );
});
