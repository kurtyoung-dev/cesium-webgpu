#!/usr/bin/env node
// @purpose Gate spec for the C12-29 S5 multiview certification: phases, renderer set, WebGPU VR error contract, evidence lifecycle and lock/watchdog wiring.
// @status ACTIVE

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  C12_29_S5_MULTIVIEW_BUILD_SOURCE_FILES,
  C12_29_S5_MULTIVIEW_DIAGNOSTICS_SCHEMA,
  C12_29_S5_MULTIVIEW_PAGE_SCHEMA,
  C12_29_S5_MULTIVIEW_PHASES,
  C12_29_S5_MULTIVIEW_RENDERERS,
  C12_29_S5_MULTIVIEW_SCHEMA,
  C12_29_S5_MULTIVIEW_SOURCE_FILES,
  C12_29_S5_MULTIVIEW_WEBGPU_VR_ERROR,
  C12_29_S5_MULTIVIEW_WORKLOAD,
  createC1229S5MultiviewErrorArtifact,
  exitCodeForC1229S5MultiviewStatus,
  foldC1229S5MultiviewGate,
  isC1229S5MultiviewUuidV4,
  stableC1229S5MultiviewJson,
  validateC1229S5MultiviewFinalArtifact,
} from "./lib/c12-29-s5-multiview-gate.mjs";
import {
  beginC1229S5MultiviewEvidenceRun,
  claimC1229S5MultiviewCanonical,
  closeC1229S5MultiviewResourceBounded,
  createC1229S5MultiviewArtifactPaths,
  finalizeC1229S5MultiviewEvidence,
  normalizeC1229S5MultiviewDiagnosticStrings,
  releaseC1229S5MultiviewLock,
  validateC1229S5MultiviewLoopbackBase,
  withC1229S5MultiviewWatchdog,
} from "./probe-c12-29-s5-multiview.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const helperPath = path.join(__dirname, "lib/c12-29-s5-multiview-gate.mjs");
const probePath = path.join(__dirname, "probe-c12-29-s5-multiview.mjs");
const cameraPath = path.join(
  __dirname,
  "../../packages/engine/Source/Scene/Camera.js",
);
const cameraHelpersPath = path.join(
  __dirname,
  "../../packages/engine/Source/Scene/CameraHelpers.js",
);
const helperSource = fs.readFileSync(helperPath, "utf8");
const probeSource = fs.readFileSync(probePath, "utf8");
const cameraSource = fs.readFileSync(cameraPath, "utf8");
const cameraHelpersSource = fs.readFileSync(cameraHelpersPath, "utf8");

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const RUN_ID_2 = "223e4567-e89b-42d3-a456-426614174001";
const RUN_ID_3 = "323e4567-e89b-42d3-a456-426614174002";
const SHA = "a".repeat(64);

function degreesToRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function payloadBytes(payload) {
  const result = new Uint8Array(64);
  const view = new DataView(result.buffer);
  payload.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return Array.from(result);
}

function bytesSha256(bytes) {
  return createHash("sha256").update(Uint8Array.from(bytes)).digest("hex");
}

const WGS84_XY_RADIUS = 6_378_137.0;
const WGS84_Z_RADIUS = 6_356_752.314245179;

function dot(left, right) {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function magnitude(value) {
  return Math.sqrt(dot(value, value));
}

function normalize(value) {
  const length = magnitude(value);
  return value.map((entry) => entry / length);
}

function subtract(left, right) {
  return left.map((entry, index) => entry - right[index]);
}

function addScaled(origin, direction, scale) {
  return origin.map((entry, index) => entry + direction[index] * scale);
}

function geodeticPosition(requestedView, heightMeters) {
  const longitude = degreesToRadians(requestedView.longitudeDegrees);
  const latitude = degreesToRadians(requestedView.latitudeDegrees);
  const normal = [
    Math.cos(latitude) * Math.cos(longitude),
    Math.cos(latitude) * Math.sin(longitude),
    Math.sin(latitude),
  ];
  const radiiSquared = [
    WGS84_XY_RADIUS ** 2,
    WGS84_XY_RADIUS ** 2,
    WGS84_Z_RADIUS ** 2,
  ];
  const scaled = normal.map((entry, index) => entry * radiiSquared[index]);
  const gamma = Math.sqrt(dot(normal, scaled));
  return scaled.map(
    (entry, index) => entry / gamma + normal[index] * heightMeters,
  );
}

function cameraAxes(requestedView) {
  const heading = degreesToRadians(requestedView.headingDegrees);
  const pitch = degreesToRadians(requestedView.pitchDegrees);
  const position = geodeticPosition(requestedView, requestedView.heightMeters);
  const up = normalize([
    position[0] / WGS84_XY_RADIUS ** 2,
    position[1] / WGS84_XY_RADIUS ** 2,
    position[2] / WGS84_Z_RADIUS ** 2,
  ]);
  const east = normalize([-position[1], position[0], 0]);
  const north = [
    up[1] * east[2] - up[2] * east[1],
    up[2] * east[0] - up[0] * east[2],
    up[0] * east[1] - up[1] * east[0],
  ];
  const combine = (eastScale, northScale, upScale) =>
    east.map(
      (entry, index) =>
        entry * eastScale + north[index] * northScale + up[index] * upScale,
    );
  return {
    direction: normalize(
      combine(
        Math.cos(pitch) * Math.sin(heading),
        Math.cos(pitch) * Math.cos(heading),
        Math.sin(pitch),
      ),
    ),
    up: normalize(
      combine(
        -Math.sin(pitch) * Math.sin(heading),
        -Math.sin(pitch) * Math.cos(heading),
        Math.cos(pitch),
      ),
    ),
    right: normalize(combine(Math.cos(heading), -Math.sin(heading), 0)),
  };
}

function viewMatrix(position, axes) {
  const { direction, up, right } = axes;
  return [
    right[0],
    up[0],
    -direction[0],
    0,
    right[1],
    up[1],
    -direction[1],
    0,
    right[2],
    up[2],
    -direction[2],
    0,
    -dot(right, position),
    -dot(up, position),
    dot(direction, position),
    1,
  ];
}

function projectionMatrix(frustumValue) {
  const fovy =
    frustumValue.aspectRatio <= 1
      ? frustumValue.fov
      : 2 *
        Math.atan(Math.tan(frustumValue.fov * 0.5) / frustumValue.aspectRatio);
  let top = frustumValue.near * Math.tan(fovy * 0.5);
  let bottom = -top;
  let right = frustumValue.aspectRatio * top;
  let left = -right;
  right += frustumValue.xOffset;
  left += frustumValue.xOffset;
  top += frustumValue.yOffset;
  bottom += frustumValue.yOffset;
  const near = frustumValue.near;
  const far = frustumValue.far;
  return [
    (2 * near) / (right - left),
    0,
    0,
    0,
    0,
    (2 * near) / (top - bottom),
    0,
    0,
    (right + left) / (right - left),
    (top + bottom) / (top - bottom),
    -(far + near) / (far - near),
    -1,
    0,
    0,
    (-2 * far * near) / (far - near),
    0,
  ];
}

function camera(cameraId, requestedView = C12_29_S5_MULTIVIEW_WORKLOAD.viewA) {
  const positionWC = geodeticPosition(
    requestedView,
    requestedView.heightMeters,
  );
  const axes = cameraAxes(requestedView);
  const frustumValue = frustum(requestedView);
  return {
    cameraId,
    positionWC,
    directionWC: axes.direction,
    upWC: axes.up,
    rightWC: axes.right,
    viewMatrix: viewMatrix(positionWC, axes),
    projectionMatrix: projectionMatrix(frustumValue),
  };
}

function frustum(
  requestedView = C12_29_S5_MULTIVIEW_WORKLOAD.viewA,
  orthographic = false,
) {
  return {
    constructor: orthographic ? "OrthographicFrustum" : "PerspectiveFrustum",
    near: requestedView.cameraNearMeters,
    far: requestedView.cameraFarMeters,
    aspectRatio: orthographic
      ? 1
      : requestedView.viewport.width / requestedView.viewport.height,
    fov: orthographic ? null : degreesToRadians(requestedView.cameraFovDegrees),
    width: orthographic ? 1_000 : null,
    xOffset: orthographic ? null : 0,
    yOffset: orthographic ? null : 0,
  };
}

function shadow(active, revision, seed) {
  const result = {
    active,
    revision,
    sunDirectionAndInvRange: [1, seed, 0, 1e-11],
    moonDirectionDeltaAndInvRange: [seed * 0.01, 0, 0, 2e-9],
    params: [active ? 1 : 0, 1, seed * 0.1, 1],
    params2: [0.00005, 1 / 3, 0, seed * 0.01],
  };
  result.packedF32 = [
    ...result.sunDirectionAndInvRange,
    ...result.moonDirectionDeltaAndInvRange,
    ...result.params,
    ...result.params2,
  ].map(Math.fround);
  return result;
}

function eclipse(stateId, shadowId, value, selectionRevision = 8) {
  return {
    stateObjectId: stateId,
    shadowObjectId: shadowId,
    state: {
      enabled: true,
      valid: true,
      sunVisibleFraction: value === 1 ? 0.05 : 0.98,
      earthOcclusionFraction: 0,
      moonObscuration: value === 1 ? 0.95 : 0.02,
      sceneLightFactor: value === 1 ? 0.12 : 0.99,
    },
    shadow: shadow(value === 1, value === 1 ? 7 : 2, value),
    prepared: true,
    selectionRevision,
    surfaceRadius: 6_378_137,
  };
}

function command(
  renderer,
  commandId,
  carrierId,
  eclipseValue,
  offset = 0,
  commandNumber = 1,
  viewId = "view-1",
) {
  const resolvedPayload = eclipseValue.shadow.packedF32.slice();
  const uploadBytes = payloadBytes(resolvedPayload);
  const result = {
    kind:
      renderer === "webgl"
        ? "webgl-production-uniform-resolver"
        : "webgpu-bind-group-dynamic-offset",
    commandId,
    ownerIsGlobe: true,
    carrierId,
    eclipseDynamicOffset: offset,
    resolvedPayload,
  };
  result.backendReceipt =
    renderer === "webgl"
      ? {
          kind: "webgl-production-uniform-resolver",
          uniformMapId: carrierId,
          pooledUniformMapId: "carrier-10",
          propertiesOverlayId: `properties-${commandNumber}`,
          pooledPropertiesId: "properties-10",
          getterId: `getter-${commandNumber}`,
          snapshotObjectId: `snapshot-${commandNumber}`,
          sourceShadowObjectId: eclipseValue.shadowObjectId,
          snapshotDistinctFromSource: true,
          snapshotFrozen: true,
          snapshotPayloadFrozen: true,
          snapshotWrapperExact: true,
          carrierPropertiesDescriptorExact: true,
          propertiesOverlayDistinctFromPooled: true,
          propertiesPrototypeExact: true,
          onlyEclipseOwnProperty: true,
          nonS5UniformDescriptorsExact: true,
          nonS5ResolvedValueExact: true,
          resolvedPayload: resolvedPayload.slice(),
        }
      : {
          kind: "webgpu-binding-2-upload",
          rendererClass: "WebGPUGlobeSurfaceRenderer",
          rendererId: "renderer-1",
          managerId: "manager-1",
          tileProviderId: "tileProvider-1",
          publishedTileProviderExact: true,
          bindGroupId: carrierId,
          bufferId: `buffer-${commandNumber}`,
          baseOffset: 0,
          dynamicOffset: offset,
          absoluteOffset: offset,
          size: 64,
          allocationEpoch: commandNumber,
          viewId,
          shadowRevision: eclipseValue.shadow.revision,
          selectionRevision: eclipseValue.selectionRevision,
          prepareCallCount: 2,
          managerResultExact: true,
          bindGroupResourceExact: true,
          uploadSource: "allocator-staging+dirty-range-queue-write",
          stagingReceiptExact: true,
          allocatorDirtyRangeFlush: true,
          flushQueueId: "queue-1",
          flushBufferId: `buffer-${commandNumber}`,
          flushOffset: 0,
          flushSize: offset + 256,
          flushSliceOffset: offset,
          flushSliceBytes: uploadBytes.slice(),
          flushSequence: commandNumber * 5 - 2,
          frameEncoderId: `encoder-${commandNumber}`,
          renderPassEncoderId: `passEncoder-${commandNumber}`,
          renderPassFrameEncoderId: `encoder-${commandNumber}`,
          consumedCommandId: commandId,
          consumedBindGroupId: carrierId,
          consumedDynamicOffsets: [0, 0, offset],
          bindSequence: commandNumber * 5 - 4,
          drawSequence: commandNumber * 5 - 3,
          drawKind: "drawIndexed",
          drawCount: 6,
          renderPassOwnedByFrameEncoder: true,
          drawConsumedCommandExact: true,
          submittedCommandBufferId: `commandBuffer-${commandNumber}`,
          finishedFrameEncoderId: `encoder-${commandNumber}`,
          finishSequence: commandNumber * 5 - 1,
          submitQueueId: "queue-1",
          submitSequence: commandNumber * 5,
          submitCommandBufferCount: 1,
          submitContainsOwningCommandBuffer: true,
          owningSubmitObserved: true,
          submittedAfterFlush: true,
          submittedAfterDraw: true,
          uploadReceiptExact: true,
          uploadBytes,
          uploadSha256: bytesSha256(uploadBytes),
        };
  return result;
}

function viewCapture(renderer, label, viewNumber, kind) {
  const isB = kind === "b";
  const eclipseValue = eclipse(
    isB ? "state-2" : "state-1",
    isB ? "shadow-2" : "shadow-1",
    isB ? 2 : 1,
  );
  const commandNumber = label === "A-before" ? 1 : label === "B" ? 2 : 3;
  const requestedView = isB
    ? C12_29_S5_MULTIVIEW_WORKLOAD.viewB
    : C12_29_S5_MULTIVIEW_WORKLOAD.viewA;
  return {
    label,
    viewId: isB ? "view-2" : "view-1",
    constructorIsView: true,
    contextId: "context-1",
    canvasId: "canvas-1",
    defaultViewId: "view-1",
    isDefaultView: !isB,
    frameStateViewId: isB ? "view-2" : "view-1",
    frameNumber: 10 + viewNumber,
    camera: camera(isB ? "camera-2" : "camera-1", requestedView),
    frustum: frustum(requestedView),
    viewport: isB
      ? structuredClone(C12_29_S5_MULTIVIEW_WORKLOAD.viewB.viewport)
      : structuredClone(C12_29_S5_MULTIVIEW_WORKLOAD.viewA.viewport),
    eclipse: eclipseValue,
    command: command(
      renderer,
      `command-${commandNumber}`,
      `carrier-${commandNumber}`,
      eclipseValue,
      renderer === "webgpu" ? commandNumber * 256 : 0,
      commandNumber,
      isB ? "view-2" : "view-1",
    ),
  };
}

function pageProgress(renderer) {
  return {
    schema: C12_29_S5_MULTIVIEW_PAGE_SCHEMA,
    renderer,
    phase: "cleanup-publication",
    phaseOrdinal: C12_29_S5_MULTIVIEW_PHASES.length,
    completedPhases: [...C12_29_S5_MULTIVIEW_PHASES],
    incomplete: false,
    checkpoint: {
      engineSchedulerAvailable: false,
      sceneRenderResetsDefaultView: true,
      contextId: "context-1",
      canvasId: "canvas-1",
      defaultViewId: "view-1",
      defaultCameraId: "camera-1",
      defaultEclipseStateObjectId: "state-1",
      defaultEclipseShadowObjectId: "shadow-1",
    },
  };
}

function baseline(renderer) {
  return {
    renderer,
    contextId: "context-1",
    canvasId: "canvas-1",
    defaultViewId: "view-1",
    defaultCameraId: "camera-1",
    defaultEclipseStateObjectId: "state-1",
    defaultEclipseShadowObjectId: "shadow-1",
    currentViewId: "view-1",
    frameStateViewId: "view-1",
    sameContextCanvas: true,
    supportsStereoViewport: renderer === "webgl",
    canvas: { width: 960, height: 640 },
  };
}

function isolation(renderer, views) {
  const aReceipt = views.aBefore.command.backendReceipt;
  const bReceipt = views.b.command.backendReceipt;
  const retained = {
    kind: views.aBefore.command.kind,
    beforeCommandId: views.aBefore.command.commandId,
    afterBCommandId: views.aBefore.command.commandId,
    afterAReentryCommandId: views.aBefore.command.commandId,
    bCommandId: views.b.command.commandId,
    beforeCarrierId: views.aBefore.command.carrierId,
    afterBCarrierId: views.aBefore.command.carrierId,
    afterAReentryCarrierId: views.aBefore.command.carrierId,
    bCarrierId: views.b.command.carrierId,
    beforeOffset: views.aBefore.command.eclipseDynamicOffset,
    afterBOffset: views.aBefore.command.eclipseDynamicOffset,
    afterAReentryOffset: views.aBefore.command.eclipseDynamicOffset,
    bOffset: views.b.command.eclipseDynamicOffset,
    beforePayload: views.aBefore.command.resolvedPayload.slice(),
    afterBPayload: views.aBefore.command.resolvedPayload.slice(),
    afterAReentryPayload: views.aBefore.command.resolvedPayload.slice(),
    bPayload: views.b.command.resolvedPayload.slice(),
    resolvesA: true,
    resolvesAAfterReentry: true,
    doesNotResolveB: true,
    backendReceipt:
      renderer === "webgl"
        ? {
            kind: "webgl-retained-uniform-map",
            beforeGetterId: aReceipt.getterId,
            afterBGetterId: aReceipt.getterId,
            afterAReentryGetterId: aReceipt.getterId,
            bGetterId: bReceipt.getterId,
            beforeSnapshotObjectId: aReceipt.snapshotObjectId,
            afterBSnapshotObjectId: aReceipt.snapshotObjectId,
            afterAReentrySnapshotObjectId: aReceipt.snapshotObjectId,
            bSnapshotObjectId: bReceipt.snapshotObjectId,
          }
        : {
            kind: "webgpu-retained-binding-2-slice",
            beforeRendererId: aReceipt.rendererId,
            afterBRendererId: aReceipt.rendererId,
            afterAReentryRendererId: aReceipt.rendererId,
            bRendererId: bReceipt.rendererId,
            beforeManagerId: aReceipt.managerId,
            afterBManagerId: aReceipt.managerId,
            afterAReentryManagerId: aReceipt.managerId,
            bManagerId: bReceipt.managerId,
            beforeBufferId: aReceipt.bufferId,
            afterBBufferId: aReceipt.bufferId,
            afterAReentryBufferId: aReceipt.bufferId,
            bBufferId: bReceipt.bufferId,
            beforeAbsoluteOffset: aReceipt.absoluteOffset,
            afterBAbsoluteOffset: aReceipt.absoluteOffset,
            afterAReentryAbsoluteOffset: aReceipt.absoluteOffset,
            bAbsoluteOffset: bReceipt.absoluteOffset,
            beforeSize: aReceipt.size,
            afterBSize: aReceipt.size,
            afterAReentrySize: aReceipt.size,
            bSize: bReceipt.size,
            beforeUploadBytes: aReceipt.uploadBytes.slice(),
            afterBUploadBytes: aReceipt.uploadBytes.slice(),
            afterAReentryUploadBytes: aReceipt.uploadBytes.slice(),
            bUploadBytes: bReceipt.uploadBytes.slice(),
            beforeUploadSha256: aReceipt.uploadSha256,
            afterBUploadSha256: aReceipt.uploadSha256,
            afterAReentryUploadSha256: aReceipt.uploadSha256,
            bUploadSha256: bReceipt.uploadSha256,
            aSliceUnchangedAfterB: true,
            aSliceUnchangedAfterAReentry: true,
            aAndBNonOverlapping: true,
          },
  };
  return {
    sequence: ["A", "B", "A"],
    toolsSchedulerOwned: true,
    engineSchedulerAvailable: false,
    nativeSceneRenderUsed: false,
    sameContext: true,
    sameCanvas: true,
    defaultViewStable: true,
    viewsDistinct: true,
    camerasDistinct: true,
    frustumsDistinct: true,
    viewportsDistinct: true,
    viewOwnedStateDistinct: true,
    viewOwnedShadowDistinct: true,
    aCameraStable: true,
    aFrustumStable: true,
    aViewportStable: true,
    aStatePayloadStable: true,
    aShadowPayloadStable: true,
    aRevisionStable: true,
    aSelectionRevisionProgressed: true,
    bPayloadDistinct: true,
    retainedACommand: retained,
  };
}

function offscreenRayPick(renderer) {
  const webgl = renderer === "webgl";
  const requested = C12_29_S5_MULTIVIEW_WORKLOAD.viewA;
  const origin = geodeticPosition(requested, requested.heightMeters);
  const target = geodeticPosition(requested, 0);
  const direction = normalize(subtract(target, origin));
  const scaledOrigin = [
    origin[0] / WGS84_XY_RADIUS,
    origin[1] / WGS84_XY_RADIUS,
    origin[2] / WGS84_Z_RADIUS,
  ];
  const scaledDirection = [
    direction[0] / WGS84_XY_RADIUS,
    direction[1] / WGS84_XY_RADIUS,
    direction[2] / WGS84_Z_RADIUS,
  ];
  const q2 = dot(scaledOrigin, scaledOrigin);
  const qw = dot(scaledOrigin, scaledDirection);
  const w2 = dot(scaledDirection, scaledDirection);
  const root = Math.sqrt(qw * qw - w2 * (q2 - 1));
  const interval = {
    start: (-qw - root) / w2,
    stop: (-qw + root) / w2,
  };
  const cpuIntersectionPosition = addScaled(origin, direction, interval.start);
  return {
    viewId: "view-3",
    defaultViewId: "view-1",
    cameraId: "camera-3",
    defaultCameraId: "camera-1",
    constructorIsView: true,
    distinctFromDefault: true,
    orthographicFrustum: true,
    realViewObservedDuringUpdate: true,
    frameStateViewIdDuringUpdate: "view-3",
    frameStateCameraIdDuringUpdate: "camera-3",
    eclipseStateObjectId: "state-3",
    defaultEclipseStateObjectId: "state-1",
    eclipseShadowObjectId: "shadow-3",
    defaultEclipseShadowObjectId: "shadow-1",
    ray: {
      origin,
      direction,
      widthMeters: C12_29_S5_MULTIVIEW_WORKLOAD.rayWidthMeters,
    },
    attempts: 2,
    supportsSynchronousReadback: webgl,
    resultPolicy: webgl
      ? "sync-position-only-globe"
      : "known-webgpu-no-position-globe",
    hit: webgl,
    hitGlobe: webgl,
    objectPresent: false,
    position: webgl ? cpuIntersectionPosition.slice() : null,
    cpuEllipsoidInterval: interval,
    cpuIntersectionPosition: cpuIntersectionPosition.slice(),
    geometricGlobeHit: true,
    geometricPosition: cpuIntersectionPosition.slice(),
  };
}

function restoration() {
  const position = geodeticPosition(
    C12_29_S5_MULTIVIEW_WORKLOAD.viewA,
    C12_29_S5_MULTIVIEW_WORKLOAD.viewA.heightMeters,
  );
  return {
    sceneViewId: "view-1",
    defaultViewId: "view-1",
    frameStateViewId: "view-1",
    frameStateCameraId: "camera-1",
    defaultCameraId: "camera-1",
    uniformCameraPosition: position.slice(),
    defaultCameraPosition: position.slice(),
    eclipseStateObjectId: "state-1",
    defaultEclipseStateObjectId: "state-1",
    eclipseShadowObjectId: "shadow-1",
    defaultEclipseShadowObjectId: "shadow-1",
    allAliasesRestored: true,
  };
}

function webglVr() {
  const payload = eclipse("state-1", "shadow-1", 1).shadow.packedF32;
  const cameraA = camera("camera-1", C12_29_S5_MULTIVIEW_WORKLOAD.viewA);
  const centerCameraPosition = cameraA.positionWC.slice();
  const centerCameraRight = cameraA.rightWC.slice();
  const eyePosition = (sign) =>
    addScaled(centerCameraPosition, centerCameraRight, sign * 0.1);
  const eye = (side, x, position, offset) => ({
    side,
    cameraPosition: position,
    xOffset: offset,
    viewport: { x, y: 0, width: 480, height: 640 },
    eclipseStateObjectId: "state-1",
    eclipseShadowObjectId: "shadow-1",
    shadowRevision: 7,
    shadowPayload: payload.slice(),
  });
  return {
    method: C12_29_S5_MULTIVIEW_WORKLOAD.webglStereoMethod,
    supported: true,
    centerCameraPosition,
    centerCameraRight,
    centerStateObjectId: "state-1",
    centerShadowObjectId: "shadow-1",
    centerShadowPayload: payload.slice(),
    left: eye("left", 0, eyePosition(1), 0.001),
    right: eye("right", 480, eyePosition(-1), -0.001),
    twoEyesObserved: true,
    distinctViewports: true,
    symmetricEyePositions: true,
    symmetricFrustumOffsets: true,
    sharedCenterAnchoredS5: true,
    centerCameraRestored: true,
    useWebVRRestoredFalse: true,
  };
}

function rejectState() {
  const position = geodeticPosition(
    C12_29_S5_MULTIVIEW_WORKLOAD.viewA,
    C12_29_S5_MULTIVIEW_WORKLOAD.viewA.heightMeters,
  );
  return {
    useWebVR: false,
    sceneViewId: "view-1",
    defaultViewId: "view-1",
    cameraId: "camera-1",
    cameraPosition: position,
    frustum: frustum(),
    cameraVrPresent: false,
    deviceOrientationControllerPresent: false,
    creditVisibility: "visible",
    frameNumber: 14,
    commandCount: 8,
    canvasFingerprint: { byteLength: 100, sha256: SHA },
  };
}

function webgpuVr() {
  const before = rejectState();
  return {
    method: C12_29_S5_MULTIVIEW_WORKLOAD.webgpuStereoMethod,
    supportsStereoViewport: false,
    before,
    error: {
      name: "DeveloperError",
      message: C12_29_S5_MULTIVIEW_WEBGPU_VR_ERROR,
    },
    synchronous: true,
    renderCalls: 0,
    pngSideEffects: 0,
    gpuSideEffects: 0,
    after: structuredClone(before),
    stateUnchanged: true,
  };
}

function session(renderer) {
  const views = {
    aBefore: viewCapture(renderer, "A-before", 1, "a"),
    b: viewCapture(renderer, "B", 2, "b"),
    aAfter: viewCapture(renderer, "A-after", 3, "a"),
  };
  return {
    renderer,
    status: "PASS",
    progress: pageProgress(renderer),
    baseline: baseline(renderer),
    views,
    isolation: isolation(renderer, views),
    offscreenRayPick: offscreenRayPick(renderer),
    restoration: restoration(),
    webglVr: renderer === "webgl" ? webglVr() : null,
    webgpuVr: renderer === "webgpu" ? webgpuVr() : null,
    runtime: {
      pageErrors: [],
      consoleErrors: [],
      gpuErrors: [],
      deviceLost: false,
      armedDevices: renderer === "webgpu" ? 1 : 0,
      ignoredConsoleErrors: [],
    },
    transport: {
      loopback: true,
      sameOriginOnly: true,
      externalRequests: [],
      failedRequests: [],
      httpErrors: [],
    },
    cleanup: {
      complete: true,
      secondaryViewDestroyed: true,
      sceneViewRestored: true,
      useWebVRFalse: true,
      instrumentationRestored: true,
      pageClosed: true,
      contextClosed: true,
      timersCleared: true,
      pendingRequests: 0,
      pageCloseTimedOut: false,
      contextCloseTimedOut: false,
    },
  };
}

function report(runId = RUN_ID) {
  return {
    schema: C12_29_S5_MULTIVIEW_SCHEMA,
    runId,
    artifactName: `${runId}.json`,
    startedAt: "2026-08-13T12:00:00.000Z",
    completedAt: "2026-08-13T12:05:00.000Z",
    incomplete: false,
    claim: {
      scope: C12_29_S5_MULTIVIEW_WORKLOAD.claim,
      scheduler: C12_29_S5_MULTIVIEW_WORKLOAD.scheduler,
      engineSchedulerAvailable: false,
      nativeArbitraryViewSchedulingClaimed: false,
      sceneRenderResetsDefaultView: true,
    },
    workload: structuredClone(C12_29_S5_MULTIVIEW_WORKLOAD),
    provenance: {
      localStable: true,
      servedEntryExact: true,
      buildSourceExact: true,
      localFiles: C12_29_S5_MULTIVIEW_SOURCE_FILES.map((file) => ({
        file,
        byteLength: 100,
        sha256: SHA,
      })),
      runtimeEntry: { byteLength: 2_000, sha256: SHA },
      buildSourceMap: { byteLength: 1_000, sha256: SHA },
      servedEntries: C12_29_S5_MULTIVIEW_RENDERERS.map((renderer) => ({
        renderer,
        status: 200,
        byteLength: 2_000,
        sha256: SHA,
      })),
      reasons: [],
    },
    sessions: C12_29_S5_MULTIVIEW_RENDERERS.map(session),
    crossBackend: {
      sameWorkload: true,
      sameClaim: true,
      bothSameContextIsolation: true,
      bothRayPickRealView: true,
      stereoPolicyComplementary: true,
    },
    cleanup: {
      complete: true,
      browserClosed: true,
      contextsClosed: true,
      timersCleared: true,
      pendingRequests: 0,
      lockReleased: true,
    },
  };
}

function artifactFromReport(value = report()) {
  const verdict = foldC1229S5MultiviewGate(value);
  return {
    ...value,
    status: verdict.status,
    exitCode: verdict.exitCode,
    reasons: {
      structural: verdict.structuralReasons,
      failures: verdict.failureReasons,
    },
    checks: verdict.checks,
  };
}

function clone(value) {
  return structuredClone(value);
}

function mutateReport(mutator) {
  const value = report();
  mutator(value);
  return foldC1229S5MultiviewGate(value);
}

function captureError(callback, pattern) {
  let caught;
  try {
    callback();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error, "expected callback to throw");
  if (pattern) assert.match(caught.message, pattern);
  return caught;
}

test("freezes the narrow 12-phase same-context contract", () => {
  // This repair strengthens only the writer lifecycle. The final envelope and
  // fold are unchanged, so exact v3 evidence remains the sole accepted prior
  // schema and can be superseded only with its matching immutable archive.
  assert.equal(C12_29_S5_MULTIVIEW_SCHEMA, "c12-29-s5-multiview-evidence-v3");
  assert.equal(C12_29_S5_MULTIVIEW_PHASES.length, 12);
  assert.deepEqual(C12_29_S5_MULTIVIEW_PHASES, [
    "eligibility-provenance",
    "context-default-view-baseline",
    "logical-view-a-prepare-capture",
    "logical-view-b-prepare-capture",
    "logical-view-a-reentry-capture",
    "a-b-a-isolation-fold",
    "real-offscreen-ray-pick-view",
    "post-pick-default-view-restoration",
    "webgl-vr-left-eye-observation",
    "webgl-vr-right-eye-center-anchor-fold",
    "webgpu-vr-synchronous-rejection-control",
    "cleanup-publication",
  ]);
  assert.equal(C12_29_S5_MULTIVIEW_WORKLOAD.engineSchedulerAvailable, false);
  assert.equal(
    C12_29_S5_MULTIVIEW_WORKLOAD.nativeArbitraryViewSchedulingClaimed,
    false,
  );
  assert.equal(C12_29_S5_MULTIVIEW_WORKLOAD.sceneRenderResetsDefaultView, true);
  assert.equal(
    C12_29_S5_MULTIVIEW_BUILD_SOURCE_FILES.includes(probePath),
    false,
  );
  assert.equal(
    C12_29_S5_MULTIVIEW_SOURCE_FILES.length,
    new Set(C12_29_S5_MULTIVIEW_SOURCE_FILES).size,
  );
  for (const cameraProvenanceSource of [
    "packages/engine/Source/Core/Transforms.js",
    "packages/engine/Source/Scene/CameraHelpers.js",
  ]) {
    assert.equal(
      C12_29_S5_MULTIVIEW_SOURCE_FILES.includes(cameraProvenanceSource),
      true,
    );
    assert.equal(
      C12_29_S5_MULTIVIEW_BUILD_SOURCE_FILES.includes(cameraProvenanceSource),
      true,
    );
  }
  for (const carrierSource of [
    "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeEclipseUniforms.ts",
    "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceCameraUB.ts",
    "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts",
    "packages/engine/Source/Renderer/WebGPU/WebGPURingBufferAllocator.ts",
    "packages/engine/Source/Scene/GlobeSurfaceTileProviderRendering.js",
  ]) {
    assert.equal(
      C12_29_S5_MULTIVIEW_SOURCE_FILES.includes(carrierSource),
      true,
    );
  }
  assert.match(
    cameraSource,
    /setView3D,[\s\S]*?from "\.\/CameraHelpers\.js";/u,
  );
  assert.match(
    cameraHelpersSource,
    /export function setView3D\([\s\S]*?Transforms\.eastNorthUpToFixedFrame\(/u,
  );
});

test("the complete reference graph folds PASS and validates exactly", () => {
  const value = report();
  const verdict = foldC1229S5MultiviewGate(value);
  assert.equal(verdict.status, "PASS", verdict.structuralReasons.join("\n"));
  assert.equal(verdict.exitCode, 0);
  const artifact = artifactFromReport(value);
  assert.deepEqual(validateC1229S5MultiviewFinalArtifact(artifact), {
    ok: true,
    reasons: [],
  });
});

test("camera ENU implementation provenance is exact and load-bearing", () => {
  for (const source of [
    "packages/engine/Source/Core/Transforms.js",
    "packages/engine/Source/Scene/CameraHelpers.js",
  ]) {
    assert.notEqual(
      mutateReport((value) => {
        const index = value.provenance.localFiles.findIndex(
          (entry) => entry.file === source,
        );
        value.provenance.localFiles.splice(index, 1);
      }).status,
      "PASS",
    );
    assert.notEqual(
      mutateReport((value) => {
        const entry = value.provenance.localFiles.find(
          (candidate) => candidate.file === source,
        );
        entry.file = `${source}.stale`;
      }).status,
      "PASS",
    );
  }
});

test("repaired WebGL overlays may copy one pooled getter and still PASS", () => {
  const value = report();
  const session = value.sessions[0];
  const getterId = session.views.aBefore.command.backendReceipt.getterId;
  session.views.b.command.backendReceipt.getterId = getterId;
  session.views.aAfter.command.backendReceipt.getterId = getterId;
  session.isolation.retainedACommand.backendReceipt.bGetterId = getterId;
  const verdict = foldC1229S5MultiviewGate(value);
  assert.equal(verdict.status, "PASS", verdict.structuralReasons.join("\n"));
});

test("schema, status, phase, and claim forgeries cannot pass", () => {
  assert.notEqual(
    mutateReport((value) => {
      value.schema = "c12-29-s5-multiview-evidence-v0";
    }).status,
    "PASS",
  );
  assert.notEqual(
    mutateReport((value) => {
      value.claim.engineSchedulerAvailable = true;
    }).status,
    "PASS",
  );
  assert.notEqual(
    mutateReport((value) => {
      value.claim.nativeArbitraryViewSchedulingClaimed = true;
    }).status,
    "PASS",
  );
  assert.notEqual(
    mutateReport((value) => {
      value.sessions[0].progress.completedPhases[2] = "fake-scheduler";
    }).status,
    "PASS",
  );
  const forged = artifactFromReport();
  forged.status = "FAIL";
  assert.equal(validateC1229S5MultiviewFinalArtifact(forged).ok, false);
});

test("malformed provenance and calendar timestamps fail without throwing", () => {
  const badPath = report();
  badPath.provenance.localFiles[0].file = 7;
  assert.doesNotThrow(() => foldC1229S5MultiviewGate(badPath));
  assert.equal(foldC1229S5MultiviewGate(badPath).status, "STRUCTURAL");

  const rollover = report();
  rollover.startedAt = "2026-02-31T12:00:00.000Z";
  assert.equal(foldC1229S5MultiviewGate(rollover).status, "STRUCTURAL");

  const noncanonical = report();
  noncanonical.startedAt = "2026-08-13T12:00:00Z";
  assert.equal(foldC1229S5MultiviewGate(noncanonical).status, "STRUCTURAL");
});

test("fake scheduling, same A/B, and context/default-View drift are rejected", () => {
  const mutations = [
    (value) => {
      value.sessions[0].isolation.toolsSchedulerOwned = false;
    },
    (value) => {
      value.sessions[0].status = "FAIL";
    },
    (value) => {
      value.sessions[1].views.aBefore.label = "A-after";
    },
    (value) => {
      value.sessions[0].isolation.nativeSceneRenderUsed = true;
    },
    (value) => {
      value.sessions[0].views.b.viewId = "view-1";
    },
    (value) => {
      value.sessions[1].views.b.camera = clone(
        value.sessions[1].views.aBefore.camera,
      );
    },
    (value) => {
      value.sessions[0].views.b.contextId = "context-2";
    },
    (value) => {
      value.sessions[1].views.aAfter.canvasId = "canvas-2";
    },
    (value) => {
      value.sessions[0].views.b.defaultViewId = "view-4";
    },
    (value) => {
      value.sessions[0].progress.checkpoint.contextId = "context-2";
    },
    (value) => {
      value.sessions[1].baseline.canvasId = "canvas-2";
    },
    (value) => {
      value.sessions[0].progress.checkpoint.defaultCameraId = "camera-2";
    },
    (value) => {
      value.sessions[1].baseline.defaultEclipseShadowObjectId = "shadow-4";
    },
  ];
  for (const mutation of mutations) {
    assert.notEqual(mutateReport(mutation).status, "PASS");
  }
});

test("runtime frustums must match exact per-View workload requests", () => {
  for (const mutation of [
    (value) => {
      value.sessions[0].views.b.frustum.fov = degreesToRadians(
        C12_29_S5_MULTIVIEW_WORKLOAD.viewB.cameraFovDegrees + 1,
      );
    },
    (value) => {
      value.sessions[1].views.b.frustum.aspectRatio = 1.6;
    },
    (value) => {
      value.sessions[0].views.b.frustum.near = 2;
    },
    (value) => {
      value.sessions[1].views.aBefore.viewport.width--;
    },
    (value) => {
      value.sessions[0].views.b.camera.cameraId = "camera-1";
    },
    (value) => {
      value.sessions[1].views.b.camera.positionWC[0] += 100;
    },
    (value) => {
      value.sessions[0].views.b.camera.projectionMatrix =
        value.sessions[0].views.aBefore.camera.projectionMatrix.slice();
    },
    (value) => {
      value.sessions[1].views.b.camera.viewMatrix[12] += 1;
    },
  ]) {
    const value = report();
    mutation(value);
    assert.equal(value.sessions[0].isolation.frustumsDistinct, true);
    assert.equal(value.sessions[1].isolation.frustumsDistinct, true);
    assert.notEqual(foldC1229S5MultiviewGate(value).status, "PASS");
  }
});

test("A-after contamination and retained-command B resolution are rejected", () => {
  assert.notEqual(
    mutateReport((value) => {
      value.sessions[0].views.aAfter.eclipse = clone(
        value.sessions[0].views.b.eclipse,
      );
    }).status,
    "PASS",
  );
  assert.notEqual(
    mutateReport((value) => {
      const retained = value.sessions[0].isolation.retainedACommand;
      retained.afterBPayload = retained.bPayload.slice();
      retained.resolvesA = false;
      retained.doesNotResolveB = false;
    }).status,
    "PASS",
  );
  assert.notEqual(
    mutateReport((value) => {
      const retained = value.sessions[1].isolation.retainedACommand;
      retained.afterBCarrierId = retained.bCarrierId;
    }).status,
    "PASS",
  );
});

test("backend carrier receipts reject aliasing, overlap, copies, and overwrite", () => {
  const attacks = [
    (value) => {
      const session = value.sessions[1];
      const a = session.views.aBefore.command;
      const b = session.views.b.command;
      const retained = session.isolation.retainedACommand;
      b.carrierId = a.carrierId;
      b.eclipseDynamicOffset = a.eclipseDynamicOffset;
      b.backendReceipt.bindGroupId = a.backendReceipt.bindGroupId;
      b.backendReceipt.bufferId = a.backendReceipt.bufferId;
      b.backendReceipt.dynamicOffset = a.backendReceipt.dynamicOffset;
      b.backendReceipt.absoluteOffset = a.backendReceipt.absoluteOffset;
      retained.bCarrierId = a.carrierId;
      retained.bOffset = a.eclipseDynamicOffset;
      retained.backendReceipt.bBufferId = a.backendReceipt.bufferId;
      retained.backendReceipt.bAbsoluteOffset = a.backendReceipt.absoluteOffset;
      retained.backendReceipt.aAndBNonOverlapping = true;
    },
    (value) => {
      const session = value.sessions[1];
      session.views.b.command.commandId =
        session.views.aBefore.command.commandId;
      session.isolation.retainedACommand.bCommandId =
        session.views.aBefore.command.commandId;
    },
    (value) => {
      const session = value.sessions[1];
      const a = session.views.aBefore.command;
      const b = session.views.b.command;
      const retained = session.isolation.retainedACommand;
      const overlappingOffset = a.backendReceipt.absoluteOffset + 32;
      b.carrierId = a.carrierId;
      b.eclipseDynamicOffset = overlappingOffset;
      b.backendReceipt.bindGroupId = a.backendReceipt.bindGroupId;
      b.backendReceipt.bufferId = a.backendReceipt.bufferId;
      b.backendReceipt.dynamicOffset = overlappingOffset;
      b.backendReceipt.absoluteOffset = overlappingOffset;
      retained.bCarrierId = a.carrierId;
      retained.bOffset = overlappingOffset;
      retained.backendReceipt.bBufferId = a.backendReceipt.bufferId;
      retained.backendReceipt.bAbsoluteOffset = overlappingOffset;
      retained.backendReceipt.aAndBNonOverlapping = true;
    },
    (value) => {
      const session = value.sessions[1];
      const a = session.views.aBefore.command;
      const retained = session.isolation.retainedACommand;
      const disconnected = Array(16).fill(Math.fround(77));
      const bytes = payloadBytes(disconnected);
      a.resolvedPayload = disconnected.slice();
      a.backendReceipt.uploadBytes = bytes;
      a.backendReceipt.uploadSha256 = bytesSha256(bytes);
      retained.beforePayload = disconnected.slice();
      retained.afterBPayload = disconnected.slice();
      retained.backendReceipt.beforeUploadBytes = bytes.slice();
      retained.backendReceipt.afterBUploadBytes = bytes.slice();
      retained.backendReceipt.beforeUploadSha256 = bytesSha256(bytes);
      retained.backendReceipt.afterBUploadSha256 = bytesSha256(bytes);
    },
    (value) => {
      value.sessions[1].views.aBefore.command.backendReceipt.managerResultExact = false;
    },
    (value) => {
      value.sessions[1].views.aBefore.command.backendReceipt.uploadReceiptExact = false;
    },
    (value) => {
      value.sessions[1].views.aBefore.command.backendReceipt.bindGroupResourceExact = false;
    },
    (value) => {
      value.sessions[1].views.aBefore.command.backendReceipt.flushSize = 32;
    },
    (value) => {
      const receipt = value.sessions[1].views.aBefore.command.backendReceipt;
      receipt.flushSliceBytes[0] ^= 1;
    },
    (value) => {
      const receipt = value.sessions[1].views.aBefore.command.backendReceipt;
      receipt.submitSequence = receipt.flushSequence;
    },
    (value) => {
      const receipt = value.sessions[1].views.aBefore.command.backendReceipt;
      receipt.finishSequence = receipt.submitSequence;
    },
    (value) => {
      value.sessions[1].views.aBefore.command.backendReceipt.owningSubmitObserved = false;
    },
    (value) => {
      value.sessions[1].views.aBefore.command.backendReceipt.submitContainsOwningCommandBuffer = false;
    },
    (value) => {
      value.sessions[1].views.b.command.backendReceipt.viewId = "view-1";
    },
    (value) => {
      value.sessions[1].views.b.command.backendReceipt.selectionRevision++;
    },
    (value) => {
      const retained = value.sessions[1].isolation.retainedACommand;
      const bReceipt = value.sessions[1].views.b.command.backendReceipt;
      retained.backendReceipt.afterBUploadBytes = bReceipt.uploadBytes.slice();
      retained.backendReceipt.afterBUploadSha256 = bReceipt.uploadSha256;
      retained.backendReceipt.aSliceUnchangedAfterB = true;
    },
    (value) => {
      const retained = value.sessions[1].isolation.retainedACommand;
      const bReceipt = value.sessions[1].views.b.command.backendReceipt;
      retained.backendReceipt.afterAReentryUploadBytes =
        bReceipt.uploadBytes.slice();
      retained.backendReceipt.afterAReentryUploadSha256 = bReceipt.uploadSha256;
      retained.backendReceipt.aSliceUnchangedAfterAReentry = true;
    },
    (value) => {
      value.sessions[1].views.b.command.backendReceipt.size = 60;
    },
    (value) => {
      value.sessions[1].views.b.command.backendReceipt.consumedBindGroupId =
        value.sessions[1].views.aBefore.command.backendReceipt.bindGroupId;
    },
    (value) => {
      const receipt = value.sessions[1].views.b.command.backendReceipt;
      receipt.consumedDynamicOffsets[2]++;
    },
    (value) => {
      value.sessions[1].views.b.command.backendReceipt.drawKind = "draw";
    },
    (value) => {
      const receipt = value.sessions[1].views.b.command.backendReceipt;
      receipt.drawSequence = receipt.bindSequence;
    },
    (value) => {
      value.sessions[1].views.b.command.backendReceipt.drawConsumedCommandExact = false;
    },
    (value) => {
      value.sessions[1].views.b.command.backendReceipt.consumedCommandId =
        value.sessions[1].views.aBefore.command.commandId;
    },
    (value) => {
      value.sessions[1].views.b.command.backendReceipt.renderPassFrameEncoderId =
        value.sessions[1].views.aBefore.command.backendReceipt.frameEncoderId;
    },
    (value) => {
      value.sessions[1].views.b.command.backendReceipt.finishedFrameEncoderId =
        value.sessions[1].views.aBefore.command.backendReceipt.frameEncoderId;
    },
    (value) => {
      value.sessions[1].views.b.command.backendReceipt.renderPassOwnedByFrameEncoder = false;
    },
    (value) => {
      const receipts = value.sessions[1].views;
      receipts.b.command.backendReceipt.frameEncoderId =
        receipts.aBefore.command.backendReceipt.frameEncoderId;
    },
    (value) => {
      const receipts = value.sessions[1].views;
      receipts.b.command.backendReceipt.allocationEpoch =
        receipts.aBefore.command.backendReceipt.allocationEpoch;
    },
    (value) => {
      const receipts = value.sessions[1].views;
      receipts.b.command.backendReceipt.submittedCommandBufferId =
        receipts.aBefore.command.backendReceipt.submittedCommandBufferId;
    },
    (value) => {
      const receipts = value.sessions[1].views;
      receipts.b.command.backendReceipt.bindSequence =
        receipts.aBefore.command.backendReceipt.submitSequence;
    },
    (value) => {
      const session = value.sessions[0];
      const a = session.views.aBefore.command;
      const b = session.views.b.command;
      const retained = session.isolation.retainedACommand;
      b.carrierId = a.carrierId;
      b.backendReceipt.uniformMapId = a.carrierId;
      retained.bCarrierId = a.carrierId;
    },
    (value) => {
      const session = value.sessions[0];
      const retained = session.isolation.retainedACommand;
      retained.backendReceipt.afterBGetterId =
        session.views.b.command.backendReceipt.getterId;
      retained.backendReceipt.afterBSnapshotObjectId =
        session.views.b.command.backendReceipt.snapshotObjectId;
    },
    (value) => {
      value.sessions[0].views.aBefore.command.backendReceipt.snapshotFrozen = false;
    },
    (value) => {
      value.sessions[0].views.aBefore.command.backendReceipt.carrierPropertiesDescriptorExact = false;
    },
    (value) => {
      const receipt = value.sessions[0].views.aBefore.command.backendReceipt;
      receipt.propertiesPrototypeExact = false;
    },
    (value) => {
      const receipt = value.sessions[0].views.aBefore.command.backendReceipt;
      receipt.nonS5UniformDescriptorsExact = false;
    },
    (value) => {
      value.sessions[1].cleanup.instrumentationRestored = false;
      value.sessions[1].cleanup.complete = false;
    },
  ];
  for (const [index, attack] of attacks.entries()) {
    assert.notEqual(
      mutateReport(attack).status,
      "PASS",
      `carrier attack ${index} was accepted`,
    );
  }
});

test("real pooled WebGL overwrite is a well-shaped product FAIL", () => {
  const value = report();
  const session = value.sessions[0];
  const a = session.views.aBefore.command;
  const b = session.views.b.command;
  const aReentry = session.views.aAfter.command;
  const retained = session.isolation.retainedACommand;

  for (const command of [b, aReentry]) {
    command.commandId = a.commandId;
    command.carrierId = a.carrierId;
    command.backendReceipt.uniformMapId = a.carrierId;
    command.backendReceipt.getterId = a.backendReceipt.getterId;
  }
  for (const command of [a, b, aReentry]) {
    const receipt = command.backendReceipt;
    receipt.pooledUniformMapId = command.carrierId;
    receipt.propertiesOverlayId = receipt.pooledPropertiesId;
    receipt.snapshotDistinctFromSource = false;
    receipt.snapshotFrozen = false;
    receipt.snapshotPayloadFrozen = false;
    receipt.snapshotWrapperExact = false;
    receipt.carrierPropertiesDescriptorExact = false;
    receipt.propertiesOverlayDistinctFromPooled = false;
    receipt.propertiesPrototypeExact = false;
    receipt.onlyEclipseOwnProperty = false;
  }
  aReentry.backendReceipt.snapshotObjectId = a.backendReceipt.snapshotObjectId;

  retained.bCommandId = a.commandId;
  retained.bCarrierId = a.carrierId;
  retained.afterBPayload = b.resolvedPayload.slice();
  retained.resolvesA = false;
  retained.doesNotResolveB = false;
  retained.backendReceipt.afterBGetterId = a.backendReceipt.getterId;
  retained.backendReceipt.afterBSnapshotObjectId =
    b.backendReceipt.snapshotObjectId;
  retained.backendReceipt.bGetterId = a.backendReceipt.getterId;
  retained.backendReceipt.afterAReentryGetterId = a.backendReceipt.getterId;
  retained.backendReceipt.afterAReentrySnapshotObjectId =
    a.backendReceipt.snapshotObjectId;

  const verdict = foldC1229S5MultiviewGate(value);
  assert.equal(verdict.status, "FAIL");
  assert.deepEqual(verdict.structuralReasons, []);
  assert.deepEqual(verdict.failureReasons, ["webglSession acceptance failed"]);
  const artifact = artifactFromReport(value);
  assert.equal(validateC1229S5MultiviewFinalArtifact(artifact).ok, true);
});

test("fake ray Views, non-globe hits, and restoration leaks are rejected", () => {
  const mutations = [
    (value) => {
      value.sessions[0].offscreenRayPick.constructorIsView = false;
    },
    (value) => {
      value.sessions[1].offscreenRayPick.viewId = "view-1";
    },
    (value) => {
      value.sessions[0].offscreenRayPick.hitGlobe = false;
    },
    (value) => {
      value.sessions[1].offscreenRayPick.resultPolicy =
        "sync-position-only-globe";
    },
    (value) => {
      value.sessions[1].offscreenRayPick.geometricGlobeHit = false;
    },
    (value) => {
      value.sessions[1].offscreenRayPick.realViewObservedDuringUpdate = false;
    },
    (value) => {
      const pick = value.sessions[0].offscreenRayPick;
      pick.frameStateCameraIdDuringUpdate = pick.defaultCameraId;
    },
    (value) => {
      const pick = value.sessions[1].offscreenRayPick;
      pick.eclipseShadowObjectId = pick.defaultEclipseShadowObjectId;
    },
    (value) => {
      value.sessions[0].offscreenRayPick.position[0] += 100;
    },
    (value) => {
      value.sessions[0].offscreenRayPick.ray.direction = [2, 0, 0];
    },
    (value) => {
      value.sessions[1].offscreenRayPick.ray.origin[0] += 100;
    },
    (value) => {
      value.sessions[0].offscreenRayPick.cpuEllipsoidInterval.start += 100;
    },
    (value) => {
      value.sessions[1].offscreenRayPick.geometricPosition[0] += 100;
    },
    (value) => {
      value.sessions[0].restoration.frameStateViewId = "view-3";
    },
    (value) => {
      value.sessions[1].restoration.allAliasesRestored = false;
    },
  ];
  for (const mutation of mutations) {
    assert.notEqual(mutateReport(mutation).status, "PASS");
  }
});

test("WebGL requires two distinct symmetric center-anchored eyes", () => {
  const mutations = [
    (value) => {
      value.sessions[0].webglVr.twoEyesObserved = false;
    },
    (value) => {
      value.sessions[0].webglVr.right.viewport.x = 0;
      value.sessions[0].webglVr.distinctViewports = false;
    },
    (value) => {
      value.sessions[0].webglVr.right.xOffset = 0.001;
    },
    (value) => {
      value.sessions[0].webglVr.right.xOffset = -0.002;
    },
    (value) => {
      value.sessions[0].webglVr.left.viewport.x = 1;
      value.sessions[0].webglVr.right.viewport.x = 481;
    },
    (value) => {
      value.sessions[0].webglVr.left.cameraPosition[0] += 10;
      value.sessions[0].webglVr.right.cameraPosition[0] += 10;
    },
    (value) => {
      value.sessions[0].webglVr.right.eclipseShadowObjectId = "shadow-2";
    },
    (value) => {
      value.sessions[0].webglVr.right.shadowPayload[0] += 0.1;
    },
    (value) => {
      const vr = value.sessions[0].webglVr;
      vr.left.cameraPosition = vr.centerCameraPosition.slice();
      vr.right.cameraPosition = vr.centerCameraPosition.slice();
    },
    (value) => {
      const vr = value.sessions[0].webglVr;
      vr.left.shadowPayload[0] += 0.1;
      vr.right.shadowPayload[0] += 0.1;
    },
    (value) => {
      value.sessions[0].webglVr.centerCameraRestored = false;
    },
    (value) => {
      const vr = value.sessions[0].webglVr;
      const leftDistance = Math.hypot(
        ...subtract(vr.left.cameraPosition, vr.centerCameraPosition),
      );
      const rightDistance = Math.hypot(
        ...subtract(vr.right.cameraPosition, vr.centerCameraPosition),
      );
      vr.left.cameraPosition = addScaled(
        vr.centerCameraPosition,
        [1, 0, 0],
        leftDistance,
      );
      vr.right.cameraPosition = addScaled(
        vr.centerCameraPosition,
        [1, 0, 0],
        -rightDistance,
      );
    },
  ];
  for (const mutation of mutations) {
    assert.notEqual(mutateReport(mutation).status, "PASS");
  }
});

test("WebGPU must reject synchronously with exact error and zero side effects", () => {
  const mutations = [
    (value) => {
      value.sessions[1].webgpuVr.supportsStereoViewport = true;
    },
    (value) => {
      value.sessions[1].webgpuVr.error.message += " drift";
    },
    (value) => {
      value.sessions[1].webgpuVr.synchronous = false;
    },
    (value) => {
      value.sessions[1].webgpuVr.renderCalls = 1;
    },
    (value) => {
      value.sessions[1].webgpuVr.pngSideEffects = 1;
    },
    (value) => {
      value.sessions[1].webgpuVr.gpuSideEffects = 1;
    },
    (value) => {
      value.sessions[1].webgpuVr.after.commandCount++;
      value.sessions[1].webgpuVr.stateUnchanged = false;
    },
  ];
  for (const mutation of mutations) {
    assert.notEqual(mutateReport(mutation).status, "PASS");
  }
});

test("provenance, runtime, transport, and cleanup ledgers are load-bearing", () => {
  const mutations = [
    (value) => {
      value.provenance.localStable = false;
      value.provenance.reasons.push("source changed");
    },
    (value) => {
      value.provenance.servedEntries[0].sha256 = "b".repeat(64);
    },
    (value) => {
      value.provenance.localFiles[0].file = `forged-prefix/${value.provenance.localFiles[0].file}`;
    },
    (value) => {
      value.sessions[0].runtime.gpuErrors.push("INVALID_OPERATION");
    },
    (value) => {
      value.sessions[1].transport.externalRequests.push("https://example.com/");
      value.sessions[1].transport.sameOriginOnly = false;
    },
    (value) => {
      value.sessions[0].cleanup.pendingRequests = 1;
      value.sessions[0].cleanup.complete = false;
    },
    (value) => {
      value.cleanup.lockReleased = false;
      value.cleanup.complete = false;
    },
  ];
  for (const mutation of mutations) {
    assert.notEqual(mutateReport(mutation).status, "PASS");
  }
});

test("ERROR diagnostics are exact, bounded, plain, finite JSON", () => {
  const valid = createC1229S5MultiviewErrorArtifact(
    RUN_ID,
    new Error("browser failed"),
    { renderer: "webgpu", stage: "page", timeoutMs: 1_000, page: null },
  );
  assert.deepEqual(validateC1229S5MultiviewFinalArtifact(valid), {
    ok: true,
    reasons: [],
  });
  const mutants = [
    () => ({}),
    () => {
      const value = clone(valid);
      delete value.diagnostics.stage;
      return value;
    },
    () => {
      const value = clone(valid);
      value.diagnostics.extra = true;
      return value;
    },
    () => {
      const value = clone(valid);
      value.diagnostics.schema = "v0";
      return value;
    },
    () => {
      const value = clone(valid);
      value.diagnostics.renderer = "vulkan";
      return value;
    },
    () => {
      const value = clone(valid);
      value.diagnostics.stage = "whatever";
      return value;
    },
    () => {
      const value = clone(valid);
      value.diagnostics.timeoutMs = Number.NaN;
      return value;
    },
    () => {
      const value = clone(valid);
      value.diagnostics.errorMessage = "x".repeat(70_000);
      return value;
    },
    () => {
      const value = clone(valid);
      value.diagnostics = Object.assign(
        Object.create({ poisoned: true }),
        value.diagnostics,
      );
      return value;
    },
    () => {
      const value = clone(valid);
      const sparse = [];
      sparse.length = 2;
      value.diagnostics.page = sparse;
      return value;
    },
  ];
  for (const make of mutants) {
    assert.equal(validateC1229S5MultiviewFinalArtifact(make()).ok, false);
  }
  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error("hostile getter ran");
      },
    },
  );
  const hostileArtifact = createC1229S5MultiviewErrorArtifact(RUN_ID, hostile);
  assert.equal(validateC1229S5MultiviewFinalArtifact(hostileArtifact).ok, true);
  assert.equal(
    hostileArtifact.diagnostics.errorMessage,
    "uninspectable multiview error",
  );
});

test("runtime diagnostic arrays preserve bounded overflow evidence", () => {
  const normalized = normalizeC1229S5MultiviewDiagnosticStrings(
    Array.from({ length: 200 }, (_, index) => `${index}:${"x".repeat(3_000)}`),
    "pageErrors",
  );
  assert.equal(normalized.length, 32);
  assert.equal(normalized[0].length, 2_048);
  assert.equal(
    normalized.at(-1),
    "[MULTIVIEW_OVERFLOW pageErrors total=200 retained=31 omitted=169]",
  );
});

test("partial page diagnostics retain the exact runtime checkpoint", () => {
  const page = {
    schema: C12_29_S5_MULTIVIEW_PAGE_SCHEMA,
    renderer: "webgl",
    phase: C12_29_S5_MULTIVIEW_PHASES[2],
    phaseOrdinal: 3,
    completedPhases: C12_29_S5_MULTIVIEW_PHASES.slice(0, 2),
    incomplete: true,
    checkpoint: {
      engineSchedulerAvailable: false,
      sceneRenderResetsDefaultView: true,
      contextId: "context-1",
      canvasId: "canvas-1",
      defaultViewId: "view-1",
      defaultCameraId: "camera-1",
      defaultEclipseStateObjectId: "state-1",
      defaultEclipseShadowObjectId: "shadow-1",
    },
  };
  const artifact = createC1229S5MultiviewErrorArtifact(
    RUN_ID,
    new Error("mid-page"),
    { renderer: "webgl", stage: "page", timeoutMs: 1_000, page },
  );
  assert.deepEqual(artifact.diagnostics.page, page);
  assert.equal(validateC1229S5MultiviewFinalArtifact(artifact).ok, true);
  artifact.diagnostics.stage = "preflight";
  assert.equal(validateC1229S5MultiviewFinalArtifact(artifact).ok, false);
  artifact.diagnostics.stage = "page";
  artifact.diagnostics.page.checkpoint.engineSchedulerAvailable = true;
  assert.equal(validateC1229S5MultiviewFinalArtifact(artifact).ok, false);

  const impossible = [
    () => {
      const value = clone(page);
      value.phase = C12_29_S5_MULTIVIEW_PHASES[9];
      value.phaseOrdinal = 10;
      value.completedPhases = [];
      return value;
    },
    () => {
      const value = clone(page);
      value.phase = C12_29_S5_MULTIVIEW_PHASES[0];
      value.phaseOrdinal = 1;
      value.completedPhases = [...C12_29_S5_MULTIVIEW_PHASES];
      return value;
    },
    () => {
      const value = clone(page);
      value.completedPhases = C12_29_S5_MULTIVIEW_PHASES.slice(0, 4);
      return value;
    },
    () => {
      const value = clone(page);
      value.incomplete = false;
      return value;
    },
    () => {
      const value = clone(page);
      value.checkpoint.contextId = null;
      value.checkpoint.defaultViewId = null;
      return value;
    },
    () => {
      const value = clone(page);
      delete value.checkpoint.canvasId;
      return value;
    },
  ];
  for (const makePage of impossible) {
    const mutant = createC1229S5MultiviewErrorArtifact(
      RUN_ID,
      new Error("impossible progress"),
      {
        renderer: "webgl",
        stage: "page",
        timeoutMs: 1_000,
        page: makePage(),
      },
    );
    assert.equal(mutant.diagnostics.page, null);
    mutant.diagnostics.page = makePage();
    assert.equal(validateC1229S5MultiviewFinalArtifact(mutant).ok, false);
  }

  const rendererless = createC1229S5MultiviewErrorArtifact(
    RUN_ID,
    new Error("rendererless page"),
    { renderer: null, stage: "page", timeoutMs: 1_000, page: clone(page) },
  );
  assert.equal(rendererless.diagnostics.page, null);
  rendererless.diagnostics.page = clone(page);
  assert.equal(validateC1229S5MultiviewFinalArtifact(rendererless).ok, false);

  const initial = clone(page);
  initial.phase = C12_29_S5_MULTIVIEW_PHASES[0];
  initial.phaseOrdinal = 1;
  initial.completedPhases = [];
  for (const key of [
    "contextId",
    "canvasId",
    "defaultViewId",
    "defaultCameraId",
    "defaultEclipseStateObjectId",
    "defaultEclipseShadowObjectId",
  ]) {
    initial.checkpoint[key] = null;
  }
  const initialArtifact = createC1229S5MultiviewErrorArtifact(
    RUN_ID,
    new Error("pre-context page"),
    {
      renderer: "webgl",
      stage: "page",
      timeoutMs: 1_000,
      page: initial,
    },
  );
  assert.deepEqual(initialArtifact.diagnostics.page, initial);
  assert.equal(validateC1229S5MultiviewFinalArtifact(initialArtifact).ok, true);

  const mixedInitial = clone(initial);
  mixedInitial.checkpoint.contextId = "context-1";
  const mixedInitialArtifact = createC1229S5MultiviewErrorArtifact(
    RUN_ID,
    new Error("partially initialized checkpoint"),
    {
      renderer: "webgl",
      stage: "watchdog",
      timeoutMs: 1_000,
      page: mixedInitial,
    },
  );
  assert.equal(mixedInitialArtifact.diagnostics.page, null);
  mixedInitialArtifact.diagnostics.page = mixedInitial;
  assert.equal(
    validateC1229S5MultiviewFinalArtifact(mixedInitialArtifact).ok,
    false,
  );
});

test("stable JSON rejects hidden, active, exotic, cyclic, and lossy values", () => {
  assert.throws(
    () => stableC1229S5MultiviewJson(new Array(2)),
    /noncanonical/u,
  );
  assert.throws(
    () => stableC1229S5MultiviewJson(Object.create({ inherited: true })),
    /custom prototype/u,
  );
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => stableC1229S5MultiviewJson(cyclic), /cycle/u);
  assert.throws(
    () => stableC1229S5MultiviewJson({ value: Infinity }),
    /lossy/u,
  );
  assert.throws(
    () => stableC1229S5MultiviewJson({ value: undefined }),
    /rejects undefined/u,
  );
  const hidden = { visible: true };
  Object.defineProperty(hidden, "hidden", { value: true });
  assert.throws(() => stableC1229S5MultiviewJson(hidden), /hidden/u);
  const symbol = { visible: true, [Symbol("hidden")]: true };
  assert.throws(() => stableC1229S5MultiviewJson(symbol), /symbol/u);
  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, "active", {
    enumerable: true,
    get() {
      getterCalls++;
      return true;
    },
  });
  assert.throws(() => stableC1229S5MultiviewJson(accessor), /accessors/u);
  assert.equal(getterCalls, 0);
  assert.throws(() => stableC1229S5MultiviewJson(new Proxy({}, {})), /Proxy/u);
});

test("loopback validation excludes credentials, paths, and remote origins", () => {
  assert.equal(
    validateC1229S5MultiviewLoopbackBase("http://localhost:8080").origin,
    "http://localhost:8080",
  );
  assert.equal(
    validateC1229S5MultiviewLoopbackBase("https://[::1]:8080/").origin,
    "https://[::1]:8080",
  );
  for (const value of [
    "https://example.com/",
    "http://user:pass@localhost:8080/",
    "http://localhost:8080/path",
    "file:///tmp/index.html",
  ]) {
    assert.throws(() => validateC1229S5MultiviewLoopbackBase(value));
  }
  assert.throws(
    () => createC1229S5MultiviewArtifactPaths("../foreign"),
    /UUID v4/u,
  );
  assert.equal(
    path.isAbsolute(createC1229S5MultiviewArtifactPaths(RUN_ID, ".").directory),
    true,
  );
});

function bindFinalArtifactToOwnership(artifact, ownership) {
  if (artifact.status === "ERROR") return artifact;
  artifact.startedAt = ownership.running.startedAt;
  if (Date.parse(artifact.completedAt) < Date.parse(artifact.startedAt)) {
    artifact.completedAt = artifact.startedAt;
  }
  return artifact;
}

test("lifecycle atomically publishes archive/latest and releases the owned lock", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s5-multiview-pass-"),
  );
  try {
    const paths = createC1229S5MultiviewArtifactPaths(RUN_ID, directory);
    const ownership = beginC1229S5MultiviewEvidenceRun(paths, RUN_ID);
    assert.equal(fs.existsSync(paths.lock), true);
    assert.equal(JSON.parse(fs.readFileSync(paths.latest)).status, "RUNNING");
    const artifact = bindFinalArtifactToOwnership(
      artifactFromReport(report(RUN_ID)),
      ownership,
    );
    const publication = finalizeC1229S5MultiviewEvidence(
      paths,
      artifact,
      ownership,
    );
    assert.equal(publication.runIdentity.exists, true);
    assert.equal(fs.existsSync(paths.lock), false);
    assert.deepEqual(
      fs.readFileSync(paths.archive),
      fs.readFileSync(paths.latest),
    );
    assert.equal(ownership.currentArchiveAuthority.path, paths.archive);
    assert.equal(ownership.currentArchiveAuthority.descriptor.nlink, 1);
    assert.equal(fs.lstatSync(paths.archive).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(paths.archive).isFile(), true);
    assert.equal(fs.existsSync(paths.firstRed), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("finalization is bound to one begun run, start, nonce, lock, artifact, and paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "s5-multiview-bound-"));
  const setup = (name) => {
    const directory = path.join(root, name);
    const paths = createC1229S5MultiviewArtifactPaths(RUN_ID, directory);
    const ownership = beginC1229S5MultiviewEvidenceRun(paths, RUN_ID);
    return {
      artifact: bindFinalArtifactToOwnership(
        artifactFromReport(report(RUN_ID)),
        ownership,
      ),
      ownership,
      paths,
    };
  };
  const assertRunningRetained = ({ ownership, paths }) => {
    assert.deepEqual(fs.readFileSync(paths.lock), ownership.lockBytes);
    assert.deepEqual(fs.readFileSync(paths.latest), ownership.runningBytes);
    assert.equal(fs.existsSync(paths.archive), false);
    assert.equal(fs.existsSync(paths.firstRed), false);
  };
  try {
    const crossArtifact = setup("cross-artifact");
    const artifact2 = artifactFromReport(report(RUN_ID_2));
    const crossArtifactError = captureError(
      () =>
        finalizeC1229S5MultiviewEvidence(
          crossArtifact.paths,
          artifact2,
          crossArtifact.ownership,
        ),
      /not one run/u,
    );
    assert.equal(crossArtifactError.retainMultiviewRunning, true);
    assertRunningRetained(crossArtifact);

    const badName = setup("bad-artifact-name");
    badName.artifact.artifactName = `${RUN_ID_2}.json`;
    const badNameError = captureError(
      () =>
        finalizeC1229S5MultiviewEvidence(
          badName.paths,
          badName.artifact,
          badName.ownership,
        ),
      /not one run/u,
    );
    assert.equal(badNameError.retainMultiviewRunning, true);
    assertRunningRetained(badName);

    const startDrift = setup("artifact-start-drift");
    const foreignStart = new Date(
      Date.parse(startDrift.ownership.running.startedAt) + 1_000,
    ).toISOString();
    startDrift.artifact.startedAt = foreignStart;
    startDrift.artifact.completedAt = foreignStart;
    const startDriftError = captureError(
      () =>
        finalizeC1229S5MultiviewEvidence(
          startDrift.paths,
          startDrift.artifact,
          startDrift.ownership,
        ),
      /not one run/u,
    );
    assert.equal(startDriftError.retainMultiviewRunning, true);
    assertRunningRetained(startDrift);

    const crossPaths = setup("cross-paths");
    const paths2 = createC1229S5MultiviewArtifactPaths(
      RUN_ID_2,
      path.join(root, "cross-paths-foreign"),
    );
    const crossPathsError = captureError(
      () =>
        finalizeC1229S5MultiviewEvidence(
          paths2,
          crossPaths.artifact,
          crossPaths.ownership,
        ),
      /paths are not bound/u,
    );
    assert.equal(crossPathsError.retainMultiviewRunning, true);
    assertRunningRetained(crossPaths);

    const aliasedPaths = setup("aliased-paths");
    const alias = { ...aliasedPaths.paths, archive: aliasedPaths.paths.latest };
    const aliasError = captureError(
      () =>
        finalizeC1229S5MultiviewEvidence(
          alias,
          aliasedPaths.artifact,
          aliasedPaths.ownership,
        ),
      /paths are not bound/u,
    );
    assert.equal(aliasError.retainMultiviewRunning, true);
    assertRunningRetained(aliasedPaths);

    const forgedOwnership = setup("forged-ownership");
    const forgedError = captureError(
      () =>
        finalizeC1229S5MultiviewEvidence(
          forgedOwnership.paths,
          forgedOwnership.artifact,
          { ...forgedOwnership.ownership },
        ),
      /was not issued by begin/u,
    );
    assert.equal(forgedError.retainMultiviewRunning, true);
    assertRunningRetained(forgedOwnership);

    const nonceDrift = setup("nonce-drift");
    nonceDrift.ownership.running.nonce = "foreign-nonce";
    const nonceError = captureError(
      () =>
        finalizeC1229S5MultiviewEvidence(
          nonceDrift.paths,
          nonceDrift.artifact,
          nonceDrift.ownership,
        ),
      /not one run/u,
    );
    assert.equal(nonceError.retainMultiviewRunning, true);
    assertRunningRetained(nonceDrift);

    const lockLedgerDrift = setup("lock-ledger-drift");
    lockLedgerDrift.ownership.lockAuthority = {
      ...lockLedgerDrift.ownership.lockAuthority,
      path: lockLedgerDrift.paths.latest,
    };
    const lockLedgerError = captureError(
      () =>
        finalizeC1229S5MultiviewEvidence(
          lockLedgerDrift.paths,
          lockLedgerDrift.artifact,
          lockLedgerDrift.ownership,
        ),
      /not one run/u,
    );
    assert.equal(lockLedgerError.retainMultiviewRunning, true);
    assertRunningRetained(lockLedgerDrift);

    const directoryLedgerDrift = setup("directory-ledger-drift");
    directoryLedgerDrift.ownership.directoryAuthority = {
      ...directoryLedgerDrift.ownership.directoryAuthority,
      ino: "foreign-inode",
    };
    const directoryLedgerError = captureError(
      () =>
        finalizeC1229S5MultiviewEvidence(
          directoryLedgerDrift.paths,
          directoryLedgerDrift.artifact,
          directoryLedgerDrift.ownership,
        ),
      /not one run/u,
    );
    assert.equal(directoryLedgerError.retainMultiviewRunning, true);
    assertRunningRetained(directoryLedgerDrift);

    const directoryDrift = setup("directory-drift");
    const directoryOperations = {
      ...fs,
      lstatSync(file, ...args) {
        const descriptor = fs.lstatSync(file, ...args);
        if (file !== directoryDrift.paths.directory) return descriptor;
        return {
          isDirectory: () => true,
          isSymbolicLink: () => true,
        };
      },
    };
    const directoryError = captureError(
      () =>
        finalizeC1229S5MultiviewEvidence(
          directoryDrift.paths,
          directoryDrift.artifact,
          directoryDrift.ownership,
          directoryOperations,
        ),
      /directory is not canonical and symlink-free/u,
    );
    assert.equal(directoryError.retainMultiviewRunning, true);
    assertRunningRetained(directoryDrift);

    const directoryIdentityDrift = setup("directory-identity-drift");
    const directoryIdentityOperations = {
      ...fs,
      lstatSync(file, ...args) {
        const descriptor = fs.lstatSync(file, ...args);
        if (file !== directoryIdentityDrift.paths.directory) return descriptor;
        return new Proxy(descriptor, {
          get(target, property) {
            if (property === "ino") return Number(target.ino) === 0 ? 1 : 0;
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    };
    const directoryIdentityError = captureError(
      () =>
        finalizeC1229S5MultiviewEvidence(
          directoryIdentityDrift.paths,
          directoryIdentityDrift.artifact,
          directoryIdentityDrift.ownership,
          directoryIdentityOperations,
        ),
      /directory identity changed/u,
    );
    assert.equal(directoryIdentityError.retainMultiviewRunning, true);
    assertRunningRetained(directoryIdentityDrift);

    const linkedLock = setup("linked-lock");
    const linkedLockPath = path.join(root, "foreign-linked-lock.json");
    fs.linkSync(linkedLock.paths.lock, linkedLockPath);
    const linkedLockError = captureError(
      () =>
        finalizeC1229S5MultiviewEvidence(
          linkedLock.paths,
          linkedLock.artifact,
          linkedLock.ownership,
        ),
      /finalization lock authority/u,
    );
    assert.equal(linkedLockError.retainMultiviewRunning, true);
    assertRunningRetained(linkedLock);
    assert.deepEqual(
      fs.readFileSync(linkedLockPath),
      linkedLock.ownership.lockBytes,
    );

    const substitutedLock = setup("substituted-lock");
    fs.unlinkSync(substitutedLock.paths.lock);
    fs.writeFileSync(
      substitutedLock.paths.lock,
      substitutedLock.ownership.lockBytes,
      { flag: "wx" },
    );
    const substitutedLockError = captureError(
      () =>
        finalizeC1229S5MultiviewEvidence(
          substitutedLock.paths,
          substitutedLock.artifact,
          substitutedLock.ownership,
        ),
      /finalization lock authority/u,
    );
    assert.equal(substitutedLockError.retainMultiviewRunning, true);
    assertRunningRetained(substitutedLock);

    const symlinkLock = setup("symlink-lock");
    const symlinkLockOperations = {
      ...fs,
      lstatSync(file, ...args) {
        const descriptor = fs.lstatSync(file, ...args);
        if (file !== symlinkLock.paths.lock) return descriptor;
        return {
          ...descriptor,
          isFile: () => true,
          isSymbolicLink: () => true,
        };
      },
    };
    const symlinkLockError = captureError(
      () =>
        finalizeC1229S5MultiviewEvidence(
          symlinkLock.paths,
          symlinkLock.artifact,
          symlinkLock.ownership,
          symlinkLockOperations,
        ),
      /finalization lock authority/u,
    );
    assert.equal(symlinkLockError.retainMultiviewRunning, true);
    assertRunningRetained(symlinkLock);

    const foreignLock = setup("foreign-lock");
    const foreignLockBytes = Buffer.from("foreign lock authority");
    fs.unlinkSync(foreignLock.paths.lock);
    fs.writeFileSync(foreignLock.paths.lock, foreignLockBytes, { flag: "wx" });
    const lockError = captureError(
      () =>
        finalizeC1229S5MultiviewEvidence(
          foreignLock.paths,
          foreignLock.artifact,
          foreignLock.ownership,
        ),
      /finalization lock authority/u,
    );
    assert.equal(lockError.retainMultiviewRunning, true);
    assert.deepEqual(fs.readFileSync(foreignLock.paths.lock), foreignLockBytes);
    assert.deepEqual(
      fs.readFileSync(foreignLock.paths.latest),
      foreignLock.ownership.runningBytes,
    );
    assert.equal(fs.existsSync(foreignLock.paths.archive), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("finalization consumes its issued immutable path snapshot", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s5-multiview-path-snapshot-"),
  );
  try {
    const paths = createC1229S5MultiviewArtifactPaths(RUN_ID, directory);
    const ownership = beginC1229S5MultiviewEvidenceRun(paths, RUN_ID);
    const artifact = createC1229S5MultiviewErrorArtifact(
      RUN_ID,
      new Error("path snapshot final"),
    );
    const finalBytes = Buffer.from(stableC1229S5MultiviewJson(artifact, 2));
    const redirectedArchive = path.join(directory, "redirected-archive.json");
    let redirectCallerPaths = false;
    let recoveryReads = 0;
    const statefulPaths = new Proxy(paths, {
      get(target, property, receiver) {
        if (redirectCallerPaths && property === "archive") {
          return redirectedArchive;
        }
        const value = Reflect.get(target, property, receiver);
        if (property === "recovery" && ++recoveryReads === 2) {
          // assertCanonicalRunPaths reads recovery last. Any later caller-path
          // read sees the redirected view, while the issued snapshot stays exact.
          redirectCallerPaths = true;
        }
        return value;
      },
    });
    const operations = {
      ...fs,
      lstatSync(file, ...args) {
        const descriptor = fs.lstatSync(file, ...args);
        if (file === paths.directory) {
          assert.equal(statefulPaths.archive, redirectedArchive);
        }
        return descriptor;
      },
    };

    const publication = finalizeC1229S5MultiviewEvidence(
      statefulPaths,
      artifact,
      ownership,
      operations,
    );
    assert.equal(redirectCallerPaths, true);
    assert.equal(publication.runIdentity.file, paths.archive);
    assert.deepEqual(fs.readFileSync(paths.archive), finalBytes);
    assert.deepEqual(fs.readFileSync(paths.latest), finalBytes);
    assert.equal(fs.existsSync(redirectedArchive), false);
    assert.equal(fs.existsSync(paths.lock), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("release rejects a substituted claimed receipt without reclaiming canonical state", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s5-multiview-release-receipt-"),
  );
  try {
    const paths = createC1229S5MultiviewArtifactPaths(RUN_ID, directory);
    const ownership = beginC1229S5MultiviewEvidenceRun(paths, RUN_ID);
    const artifact = createC1229S5MultiviewErrorArtifact(
      RUN_ID,
      new Error("receipt identity final"),
    );
    const finalBytes = Buffer.from(stableC1229S5MultiviewJson(artifact, 2));
    let receipt;
    const operations = {
      ...fs,
      renameSync(from, to) {
        fs.renameSync(from, to);
        if (from === paths.lock) {
          receipt = to;
          fs.unlinkSync(to);
          fs.writeFileSync(to, ownership.lockBytes, { flag: "wx" });
        }
      },
    };
    const error = captureError(
      () =>
        finalizeC1229S5MultiviewEvidence(
          paths,
          artifact,
          ownership,
          operations,
        ),
      /release receipt changed file identity/u,
    );
    assert.equal(error.c1229MultiviewReleaseLinearized, true);
    assert.equal(error.c1229MultiviewReleaseReceipt, receipt);
    assert.equal(error.retainMultiviewRunning, undefined);
    assert.equal(error.publicationRecovery, undefined);
    assert.equal(fs.existsSync(paths.lock), false);
    assert.deepEqual(fs.readFileSync(paths.latest), finalBytes);
    assert.deepEqual(fs.readFileSync(paths.archive), finalBytes);
    assert.deepEqual(fs.readFileSync(receipt), ownership.lockBytes);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a frozen rename-then-throw outcome never permits canonical recovery", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s5-multiview-release-unknown-"),
  );
  try {
    const paths = createC1229S5MultiviewArtifactPaths(RUN_ID, directory);
    const ownership = beginC1229S5MultiviewEvidenceRun(paths, RUN_ID);
    const artifact = createC1229S5MultiviewErrorArtifact(
      RUN_ID,
      new Error("release fencing final"),
    );
    const finalBytes = Buffer.from(stableC1229S5MultiviewJson(artifact, 2));
    const renameFailure = Object.freeze(
      new Error("injected post-rename failure"),
    );
    let receipt;
    let renameCompleted = false;
    const forbidCanonicalTouch = (file) => {
      if (renameCompleted && (file === paths.lock || file === paths.latest)) {
        throw new Error(`post-rename canonical touch ${file}`);
      }
    };
    const operations = {
      ...fs,
      renameSync(from, to) {
        fs.renameSync(from, to);
        if (from === paths.lock) {
          receipt = to;
          renameCompleted = true;
          throw renameFailure;
        }
      },
      lstatSync(file, ...args) {
        forbidCanonicalTouch(file);
        return fs.lstatSync(file, ...args);
      },
      readFileSync(file, ...args) {
        forbidCanonicalTouch(file);
        return fs.readFileSync(file, ...args);
      },
    };
    const error = captureError(
      () =>
        finalizeC1229S5MultiviewEvidence(
          paths,
          artifact,
          ownership,
          operations,
        ),
      /injected post-rename failure/u,
    );
    assert.equal(error.c1229MultiviewReleaseOutcomeUnknown, true);
    assert.equal(error.c1229MultiviewReleaseReceipt, receipt);
    assert.equal(error.cause, renameFailure);
    assert.equal(
      Object.hasOwn(renameFailure, "c1229MultiviewReleaseOutcomeUnknown"),
      false,
    );
    assert.equal(
      Object.hasOwn(renameFailure, "c1229MultiviewReleaseReceipt"),
      false,
    );
    assert.equal(error.retainMultiviewRunning, undefined);
    assert.equal(error.publicationRecovery, undefined);
    assert.equal(fs.existsSync(paths.lock), false);
    assert.deepEqual(fs.readFileSync(paths.latest), finalBytes);
    assert.deepEqual(fs.readFileSync(paths.archive), finalBytes);
    assert.deepEqual(fs.readFileSync(receipt), ownership.lockBytes);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a legitimate successor begin may win immediately after release linearizes", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s5-multiview-release-successor-"),
  );
  try {
    const paths = createC1229S5MultiviewArtifactPaths(RUN_ID, directory);
    const successorPaths = createC1229S5MultiviewArtifactPaths(
      RUN_ID_2,
      directory,
    );
    const ownership = beginC1229S5MultiviewEvidenceRun(paths, RUN_ID);
    const artifact = createC1229S5MultiviewErrorArtifact(
      RUN_ID,
      new Error("successor-safe final"),
    );
    const finalBytes = Buffer.from(stableC1229S5MultiviewJson(artifact, 2));
    let receipt;
    let successorOwnership;
    const forbidPredecessorCanonicalTouch = (file) => {
      if (
        successorOwnership !== undefined &&
        (file === paths.lock || file === paths.latest)
      ) {
        throw new Error(`predecessor touched successor canonical ${file}`);
      }
    };
    const operations = {
      ...fs,
      renameSync(from, to) {
        fs.renameSync(from, to);
        if (from === paths.lock && successorOwnership === undefined) {
          receipt = to;
          successorOwnership = beginC1229S5MultiviewEvidenceRun(
            successorPaths,
            RUN_ID_2,
          );
        }
      },
      lstatSync(file, ...args) {
        forbidPredecessorCanonicalTouch(file);
        return fs.lstatSync(file, ...args);
      },
      readFileSync(file, ...args) {
        forbidPredecessorCanonicalTouch(file);
        return fs.readFileSync(file, ...args);
      },
      unlinkSync(file) {
        forbidPredecessorCanonicalTouch(file);
        fs.unlinkSync(file);
      },
    };
    const publication = finalizeC1229S5MultiviewEvidence(
      paths,
      artifact,
      ownership,
      operations,
    );
    assert.equal(publication.runIdentity.exists, true);
    assert.equal(fs.existsSync(receipt), false);
    assert.deepEqual(fs.readFileSync(paths.archive), finalBytes);
    assert.deepEqual(
      fs.readFileSync(successorPaths.lock),
      successorOwnership.lockBytes,
    );
    assert.deepEqual(
      fs.readFileSync(successorPaths.latest),
      successorOwnership.runningBytes,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a post-linearization receipt-delete failure never reclaims canonical state", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s5-multiview-recovery-"),
  );
  try {
    const paths = createC1229S5MultiviewArtifactPaths(RUN_ID, directory);
    const ownership = beginC1229S5MultiviewEvidenceRun(paths, RUN_ID);
    const artifact = createC1229S5MultiviewErrorArtifact(
      RUN_ID,
      new Error("receipt-delete final"),
    );
    const finalBytes = Buffer.from(stableC1229S5MultiviewJson(artifact, 2));
    let receipt;
    const forbidCanonicalTouch = (file) => {
      if (
        receipt !== undefined &&
        (file === paths.lock || file === paths.latest)
      ) {
        throw new Error(`post-linearization canonical touch ${file}`);
      }
    };
    const operations = {
      ...fs,
      renameSync(from, to) {
        fs.renameSync(from, to);
        if (from === paths.lock) receipt = to;
      },
      lstatSync(file, ...args) {
        forbidCanonicalTouch(file);
        return fs.lstatSync(file, ...args);
      },
      readFileSync(file, ...args) {
        forbidCanonicalTouch(file);
        return fs.readFileSync(file, ...args);
      },
      unlinkSync(file) {
        forbidCanonicalTouch(file);
        if (file === receipt) {
          throw new Error("injected lock-release failure");
        }
        fs.unlinkSync(file);
      },
    };
    let caught;
    try {
      finalizeC1229S5MultiviewEvidence(paths, artifact, ownership, operations);
    } catch (error) {
      caught = error;
    }
    assert.match(caught.message, /injected lock-release failure/u);
    assert.equal(caught.c1229MultiviewReleaseLinearized, true);
    assert.equal(caught.c1229MultiviewReleaseReceipt, receipt);
    assert.equal(caught.retainMultiviewRunning, undefined);
    assert.equal(caught.publicationRecovery, undefined);
    assert.deepEqual(fs.readFileSync(paths.latest), finalBytes);
    assert.deepEqual(fs.readFileSync(paths.archive), finalBytes);
    assert.equal(fs.existsSync(paths.lock), false);
    assert.deepEqual(fs.readFileSync(receipt), ownership.lockBytes);
    assert.equal(fs.existsSync(paths.recovery), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a prior red latest cannot continue after first-red is lost", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s5-multiview-missing-first-red-"),
  );
  try {
    const prior = createC1229S5MultiviewErrorArtifact(
      RUN_ID,
      new Error("prior red evidence"),
    );
    const priorBytes = Buffer.from(stableC1229S5MultiviewJson(prior, 2));
    const paths = createC1229S5MultiviewArtifactPaths(RUN_ID_2, directory);
    const priorArchive = path.join(directory, prior.artifactName);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(paths.latest, priorBytes, { flag: "wx" });
    fs.writeFileSync(priorArchive, priorBytes, { flag: "wx" });

    assert.throws(
      () => beginC1229S5MultiviewEvidenceRun(paths, RUN_ID_2),
      /prior red latest has no extant first-red continuity/u,
    );
    assert.deepEqual(fs.readFileSync(paths.latest), priorBytes);
    assert.deepEqual(fs.readFileSync(priorArchive), priorBytes);
    assert.equal(fs.existsSync(paths.firstRed), false);
    assert.equal(fs.existsSync(paths.lock), false);
    assert.equal(fs.existsSync(paths.archive), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("finalized prior evidence is superseded while first-red stays write-once", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "s5-multiview-red-"));
  try {
    const failReport = report(RUN_ID);
    failReport.sessions[0].isolation.retainedACommand.afterBPayload =
      failReport.sessions[0].isolation.retainedACommand.bPayload.slice();
    failReport.sessions[0].isolation.retainedACommand.resolvesA = false;
    failReport.sessions[0].isolation.retainedACommand.doesNotResolveB = false;
    const first = artifactFromReport(failReport);
    assert.equal(first.status, "FAIL");
    const paths1 = createC1229S5MultiviewArtifactPaths(RUN_ID, directory);
    const owner1 = beginC1229S5MultiviewEvidenceRun(paths1, RUN_ID);
    bindFinalArtifactToOwnership(first, owner1);
    const pub1 = finalizeC1229S5MultiviewEvidence(paths1, first, owner1);
    assert.equal(pub1.firstRed.written, true);
    const retained = fs.readFileSync(paths1.firstRed);
    const priorArchiveBytes = fs.readFileSync(paths1.archive);

    const failReport2 = report(RUN_ID_2);
    failReport2.sessions[1].webgpuVr.renderCalls = 1;
    const second = artifactFromReport(failReport2);
    const paths2 = createC1229S5MultiviewArtifactPaths(RUN_ID_2, directory);
    const owner2 = beginC1229S5MultiviewEvidenceRun(paths2, RUN_ID_2);
    bindFinalArtifactToOwnership(second, owner2);
    const pub2 = finalizeC1229S5MultiviewEvidence(paths2, second, owner2);
    assert.equal(pub2.firstRed.written, false);
    assert.deepEqual(fs.readFileSync(paths2.firstRed), retained);
    assert.deepEqual(
      fs.readFileSync(paths2.latest),
      fs.readFileSync(paths2.archive),
    );
    assert.deepEqual(fs.readFileSync(paths1.archive), priorArchiveBytes);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("current immutable archive rejects link, substitution, and deletion races", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "s5-multiview-current-archive-"),
  );
  const runCase = (name, operationsFactory, expected) => {
    const directory = path.join(root, name);
    const paths = createC1229S5MultiviewArtifactPaths(RUN_ID, directory);
    const ownership = beginC1229S5MultiviewEvidenceRun(paths, RUN_ID);
    const artifact = bindFinalArtifactToOwnership(
      artifactFromReport(report(RUN_ID)),
      ownership,
    );
    const state = {};
    const operations = operationsFactory({ directory, paths, state });
    const error = captureError(
      () =>
        finalizeC1229S5MultiviewEvidence(
          paths,
          artifact,
          ownership,
          operations,
        ),
      expected,
    );
    assert.equal(error.retainMultiviewRunning, true);
    assert.deepEqual(fs.readFileSync(paths.lock), ownership.lockBytes);
    assert.deepEqual(fs.readFileSync(paths.latest), ownership.runningBytes);
    assert.equal(state.attacked, true);
    return { artifact, ownership, paths, state };
  };
  try {
    const hardlink = runCase(
      "hardlink",
      ({ directory, paths, state }) => ({
        ...fs,
        writeFileSync(file, bytes, options) {
          fs.writeFileSync(file, bytes, options);
          if (file === paths.archive) {
            fs.linkSync(file, path.join(directory, "foreign-hardlink.json"));
            state.attacked = true;
          }
        },
      }),
      /descriptor-unsafe/u,
    );
    assert.deepEqual(
      fs.readFileSync(
        path.join(hardlink.paths.directory, "foreign-hardlink.json"),
      ),
      fs.readFileSync(hardlink.paths.archive),
    );

    runCase(
      "symlink-descriptor",
      ({ paths, state }) => ({
        ...fs,
        writeFileSync(file, bytes, options) {
          fs.writeFileSync(file, bytes, options);
          if (file === paths.archive) state.attacked = true;
        },
        lstatSync(file, ...args) {
          const descriptor = fs.lstatSync(file, ...args);
          if (file !== paths.archive || !state.attacked) return descriptor;
          return {
            dev: descriptor.dev,
            ino: descriptor.ino,
            mode: descriptor.mode,
            nlink: descriptor.nlink,
            size: descriptor.size,
            mtimeMs: descriptor.mtimeMs,
            ctimeMs: descriptor.ctimeMs,
            isFile: () => true,
            isSymbolicLink: () => true,
          };
        },
      }),
      /descriptor-unsafe/u,
    );

    const substituted = runCase(
      "substitution",
      ({ paths, state }) => ({
        ...fs,
        writeFileSync(file, bytes, options) {
          fs.writeFileSync(file, bytes, options);
          if (file === paths.archive) {
            fs.unlinkSync(file);
            fs.writeFileSync(file, "foreign current archive", { flag: "wx" });
            state.attacked = true;
          }
        },
      }),
      /current immutable archive/u,
    );
    assert.equal(
      fs.readFileSync(substituted.paths.archive, "utf8"),
      "foreign current archive",
    );

    const deleted = runCase(
      "deletion",
      ({ paths, state }) => ({
        ...fs,
        writeFileSync(file, bytes, options) {
          fs.writeFileSync(file, bytes, options);
          if (file === paths.archive) {
            fs.unlinkSync(file);
            state.attacked = true;
          }
        },
      }),
      /current immutable archive/u,
    );
    assert.equal(fs.existsSync(deleted.paths.archive), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("new first-red must also be one descriptor-safe immutable file", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s5-multiview-first-red-link-"),
  );
  try {
    const paths = createC1229S5MultiviewArtifactPaths(RUN_ID, directory);
    const ownership = beginC1229S5MultiviewEvidenceRun(paths, RUN_ID);
    const failedReport = report(RUN_ID);
    failedReport.sessions[0].isolation.retainedACommand.afterBPayload =
      failedReport.sessions[0].isolation.retainedACommand.bPayload.slice();
    failedReport.sessions[0].isolation.retainedACommand.resolvesA = false;
    failedReport.sessions[0].isolation.retainedACommand.doesNotResolveB = false;
    const artifact = artifactFromReport(failedReport);
    bindFinalArtifactToOwnership(artifact, ownership);
    const linked = path.join(directory, "foreign-first-red-hardlink.json");
    let attacked = false;
    const operations = {
      ...fs,
      writeFileSync(file, bytes, options) {
        fs.writeFileSync(file, bytes, options);
        if (file === paths.firstRed && !attacked) {
          fs.linkSync(file, linked);
          attacked = true;
        }
      },
    };
    const error = captureError(
      () =>
        finalizeC1229S5MultiviewEvidence(
          paths,
          artifact,
          ownership,
          operations,
        ),
      /newly preserved first-red authority/u,
    );
    assert.equal(error.retainMultiviewRunning, true);
    assert.equal(attacked, true);
    assert.deepEqual(fs.readFileSync(paths.lock), ownership.lockBytes);
    assert.deepEqual(fs.readFileSync(paths.latest), ownership.runningBytes);
    assert.deepEqual(fs.readFileSync(paths.firstRed), fs.readFileSync(linked));
    assert.deepEqual(
      fs.readFileSync(paths.archive),
      Buffer.from(stableC1229S5MultiviewJson(artifact, 2)),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("first-red is archive-bound and is never published before its archive", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "s5-multiview-first-red-binding-"),
  );
  try {
    const orphanDirectory = path.join(root, "orphan");
    fs.mkdirSync(orphanDirectory, { recursive: true });
    const orphanPaths = createC1229S5MultiviewArtifactPaths(
      RUN_ID_2,
      orphanDirectory,
    );
    const orphan = createC1229S5MultiviewErrorArtifact(
      RUN_ID,
      new Error("orphan first-red"),
    );
    fs.writeFileSync(
      orphanPaths.firstRed,
      stableC1229S5MultiviewJson(orphan, 2),
    );
    assert.throws(
      () => beginC1229S5MultiviewEvidenceRun(orphanPaths, RUN_ID_2),
      /initial first-red immutable archive/u,
    );
    assert.equal(fs.existsSync(orphanPaths.lock), false);
    assert.equal(fs.existsSync(orphanPaths.latest), false);

    const orderedDirectory = path.join(root, "ordered");
    const orderedPaths = createC1229S5MultiviewArtifactPaths(
      RUN_ID_2,
      orderedDirectory,
    );
    const ownership = beginC1229S5MultiviewEvidenceRun(orderedPaths, RUN_ID_2);
    const currentRed = createC1229S5MultiviewErrorArtifact(
      RUN_ID_2,
      new Error("current first-red"),
    );
    const archiveFailure = new Error("injected archive creation failure");
    const operations = {
      ...fs,
      writeFileSync(file, ...args) {
        if (file === orderedPaths.archive) throw archiveFailure;
        return fs.writeFileSync(file, ...args);
      },
    };
    const error = captureError(
      () =>
        finalizeC1229S5MultiviewEvidence(
          orderedPaths,
          currentRed,
          ownership,
          operations,
        ),
      /injected archive creation failure/u,
    );
    assert.equal(error.retainMultiviewRunning, true);
    assert.equal(fs.existsSync(orderedPaths.archive), false);
    assert.equal(fs.existsSync(orderedPaths.firstRed), false);
    assert.deepEqual(
      fs.readFileSync(orderedPaths.latest),
      ownership.runningBytes,
    );
    assert.deepEqual(fs.readFileSync(orderedPaths.lock), ownership.lockBytes);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("first-red archive authority is independent of a newer latest archive", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s5-multiview-first-red-archive-race-"),
  );
  try {
    const redReport = report(RUN_ID);
    redReport.sessions[0].isolation.retainedACommand.afterBPayload =
      redReport.sessions[0].isolation.retainedACommand.bPayload.slice();
    redReport.sessions[0].isolation.retainedACommand.resolvesA = false;
    redReport.sessions[0].isolation.retainedACommand.doesNotResolveB = false;
    const firstRed = artifactFromReport(redReport);
    const firstPaths = createC1229S5MultiviewArtifactPaths(RUN_ID, directory);
    const firstOwner = beginC1229S5MultiviewEvidenceRun(firstPaths, RUN_ID);
    bindFinalArtifactToOwnership(firstRed, firstOwner);
    finalizeC1229S5MultiviewEvidence(firstPaths, firstRed, firstOwner);

    const secondPaths = createC1229S5MultiviewArtifactPaths(
      RUN_ID_2,
      directory,
    );
    const secondOwner = beginC1229S5MultiviewEvidenceRun(secondPaths, RUN_ID_2);
    finalizeC1229S5MultiviewEvidence(
      secondPaths,
      bindFinalArtifactToOwnership(
        artifactFromReport(report(RUN_ID_2)),
        secondOwner,
      ),
      secondOwner,
    );

    const thirdPaths = createC1229S5MultiviewArtifactPaths(RUN_ID_3, directory);
    const thirdOwner = beginC1229S5MultiviewEvidenceRun(thirdPaths, RUN_ID_3);
    assert.equal(thirdOwner.priorArchiveAuthority.path, secondPaths.archive);
    assert.equal(thirdOwner.firstRedArchiveAuthority.path, firstPaths.archive);
    assert.notEqual(
      thirdOwner.priorArchiveAuthority.path,
      thirdOwner.firstRedArchiveAuthority.path,
    );

    fs.unlinkSync(firstPaths.archive);
    fs.writeFileSync(firstPaths.archive, "foreign first-red archive", {
      flag: "wx",
    });
    const error = captureError(
      () =>
        finalizeC1229S5MultiviewEvidence(
          thirdPaths,
          bindFinalArtifactToOwnership(
            artifactFromReport(report(RUN_ID_3)),
            thirdOwner,
          ),
          thirdOwner,
        ),
      /finalization-entry first-red immutable archive authority/u,
    );
    assert.equal(error.retainMultiviewRunning, true);
    assert.deepEqual(
      fs.readFileSync(thirdPaths.latest),
      thirdOwner.runningBytes,
    );
    assert.deepEqual(fs.readFileSync(thirdPaths.lock), thirdOwner.lockBytes);
    assert.equal(fs.existsSync(thirdPaths.archive), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("current archive remains exact through publication and the release fence", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "s5-multiview-current-unlock-"),
  );
  const runCase = (name, operationsFactory, expected) => {
    const directory = path.join(root, name);
    const paths = createC1229S5MultiviewArtifactPaths(RUN_ID, directory);
    const ownership = beginC1229S5MultiviewEvidenceRun(paths, RUN_ID);
    const artifact = bindFinalArtifactToOwnership(
      artifactFromReport(report(RUN_ID)),
      ownership,
    );
    const finalBytes = Buffer.from(stableC1229S5MultiviewJson(artifact, 2));
    const state = {};
    const operations = operationsFactory({ directory, paths, state });
    const error = captureError(
      () =>
        finalizeC1229S5MultiviewEvidence(
          paths,
          artifact,
          ownership,
          operations,
        ),
      expected,
    );
    assert.equal(error.retainMultiviewRunning, true);
    assert.equal(error.publicationRecovery.ok, true);
    assert.equal(state.attacked, true);
    assert.deepEqual(fs.readFileSync(paths.lock), ownership.lockBytes);
    assert.deepEqual(fs.readFileSync(paths.latest), ownership.runningBytes);
    assert.deepEqual(fs.readFileSync(paths.recovery), finalBytes);
    return { artifact, finalBytes, ownership, paths, state };
  };
  try {
    const postPublication = runCase(
      "post-publication-substitution",
      ({ paths, state }) => ({
        ...fs,
        writeFileSync(file, bytes, options) {
          fs.writeFileSync(file, bytes, options);
          if (
            file === paths.latest &&
            JSON.parse(Buffer.from(bytes).toString("utf8")).status === "PASS"
          ) {
            fs.unlinkSync(paths.archive);
            fs.writeFileSync(paths.archive, "foreign after publication", {
              flag: "wx",
            });
            state.attacked = true;
          }
        },
      }),
      /post-publication current immutable archive/u,
    );
    assert.equal(
      fs.readFileSync(postPublication.paths.archive, "utf8"),
      "foreign after publication",
    );

    const preLinearization = runCase(
      "pre-linearization-substitution",
      ({ paths, state }) => ({
        ...fs,
        readFileSync(file, ...args) {
          const bytes = fs.readFileSync(file, ...args);
          if (
            file === paths.latest &&
            JSON.parse(Buffer.from(bytes).toString("utf8")).status === "PASS"
          ) {
            state.finalLatestReads = (state.finalLatestReads ?? 0) + 1;
            if (state.finalLatestReads === 4 && !state.attacked) {
              fs.unlinkSync(paths.archive);
              fs.writeFileSync(paths.archive, "foreign at release fence", {
                flag: "wx",
              });
              state.attacked = true;
            }
          }
          return bytes;
        },
      }),
      /unlock-before-release-linearization current immutable archive/u,
    );
    assert.equal(preLinearization.state.finalLatestReads >= 4, true);
    assert.equal(
      fs.readFileSync(preLinearization.paths.archive, "utf8"),
      "foreign at release fence",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("predecessor archive and first-red authorities survive pre-release races", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "s5-multiview-predecessor-finalize-"),
  );
  const setup = (name) => {
    const directory = path.join(root, name);
    const priorReport = report(RUN_ID);
    priorReport.sessions[0].isolation.retainedACommand.afterBPayload =
      priorReport.sessions[0].isolation.retainedACommand.bPayload.slice();
    priorReport.sessions[0].isolation.retainedACommand.resolvesA = false;
    priorReport.sessions[0].isolation.retainedACommand.doesNotResolveB = false;
    const priorArtifact = artifactFromReport(priorReport);
    const priorPaths = createC1229S5MultiviewArtifactPaths(RUN_ID, directory);
    const priorOwner = beginC1229S5MultiviewEvidenceRun(priorPaths, RUN_ID);
    bindFinalArtifactToOwnership(priorArtifact, priorOwner);
    finalizeC1229S5MultiviewEvidence(priorPaths, priorArtifact, priorOwner);
    const paths = createC1229S5MultiviewArtifactPaths(RUN_ID_2, directory);
    const ownership = beginC1229S5MultiviewEvidenceRun(paths, RUN_ID_2);
    assert.equal(ownership.priorArchiveAuthority.path, priorPaths.archive);
    assert.equal(
      ownership.priorArchiveAuthority.sha256,
      createHash("sha256")
        .update(fs.readFileSync(priorPaths.archive))
        .digest("hex"),
    );
    assert.equal(ownership.firstRedAuthority.path, paths.firstRed);
    return {
      artifact: bindFinalArtifactToOwnership(
        artifactFromReport(report(RUN_ID_2)),
        ownership,
      ),
      ownership,
      paths,
      priorPaths,
    };
  };
  try {
    const beforeFinalize = setup("before-finalize");
    const foreignBefore = Buffer.from("foreign predecessor before finalize");
    fs.unlinkSync(beforeFinalize.priorPaths.archive);
    fs.writeFileSync(beforeFinalize.priorPaths.archive, foreignBefore, {
      flag: "wx",
    });
    const beforeError = captureError(
      () =>
        finalizeC1229S5MultiviewEvidence(
          beforeFinalize.paths,
          beforeFinalize.artifact,
          beforeFinalize.ownership,
        ),
      /finalization-entry prior immutable archive/u,
    );
    assert.equal(beforeError.retainMultiviewRunning, true);
    assert.deepEqual(
      fs.readFileSync(beforeFinalize.priorPaths.archive),
      foreignBefore,
    );
    assert.deepEqual(
      fs.readFileSync(beforeFinalize.paths.latest),
      beforeFinalize.ownership.runningBytes,
    );
    assert.deepEqual(
      fs.readFileSync(beforeFinalize.paths.lock),
      beforeFinalize.ownership.lockBytes,
    );
    assert.equal(fs.existsSync(beforeFinalize.paths.archive), false);

    const postPublication = setup("post-publication");
    const finalBytes = Buffer.from(
      stableC1229S5MultiviewJson(postPublication.artifact, 2),
    );
    const foreignPost = Buffer.from("foreign predecessor after archive create");
    let predecessorSubstituted = false;
    const postOperations = {
      ...fs,
      writeFileSync(file, bytes, options) {
        fs.writeFileSync(file, bytes, options);
        if (file === postPublication.paths.archive && !predecessorSubstituted) {
          fs.unlinkSync(postPublication.priorPaths.archive);
          fs.writeFileSync(postPublication.priorPaths.archive, foreignPost, {
            flag: "wx",
          });
          predecessorSubstituted = true;
        }
      },
    };
    const postError = captureError(
      () =>
        finalizeC1229S5MultiviewEvidence(
          postPublication.paths,
          postPublication.artifact,
          postPublication.ownership,
          postOperations,
        ),
      /pre-final-canonical-replacement prior immutable archive/u,
    );
    assert.equal(postError.retainMultiviewRunning, true);
    assert.equal(postError.publicationRecovery, undefined);
    assert.deepEqual(
      fs.readFileSync(postPublication.priorPaths.archive),
      foreignPost,
    );
    assert.deepEqual(
      fs.readFileSync(postPublication.paths.latest),
      postPublication.ownership.runningBytes,
    );
    assert.deepEqual(
      fs.readFileSync(postPublication.paths.lock),
      postPublication.ownership.lockBytes,
    );
    assert.deepEqual(
      fs.readFileSync(postPublication.paths.archive),
      finalBytes,
    );
    assert.equal(fs.existsSync(postPublication.paths.recovery), false);

    const unlockPrior = setup("release-fence-prior-delete");
    let priorDeleted = false;
    let priorFinalLatestReads = 0;
    const unlockPriorOperations = {
      ...fs,
      readFileSync(file, ...args) {
        const bytes = fs.readFileSync(file, ...args);
        if (
          file === unlockPrior.paths.latest &&
          JSON.parse(Buffer.from(bytes).toString("utf8")).status === "PASS"
        ) {
          priorFinalLatestReads++;
          if (priorFinalLatestReads === 4 && !priorDeleted) {
            fs.unlinkSync(unlockPrior.priorPaths.archive);
            priorDeleted = true;
          }
        }
        return bytes;
      },
    };
    const unlockPriorError = captureError(
      () =>
        finalizeC1229S5MultiviewEvidence(
          unlockPrior.paths,
          unlockPrior.artifact,
          unlockPrior.ownership,
          unlockPriorOperations,
        ),
      /unlock-before-release-linearization prior immutable archive/u,
    );
    assert.equal(unlockPriorError.retainMultiviewRunning, true);
    assert.equal(unlockPriorError.publicationRecovery.ok, true);
    assert.equal(fs.existsSync(unlockPrior.priorPaths.archive), false);
    assert.deepEqual(
      fs.readFileSync(unlockPrior.paths.latest),
      unlockPrior.ownership.runningBytes,
    );
    assert.deepEqual(
      fs.readFileSync(unlockPrior.paths.lock),
      unlockPrior.ownership.lockBytes,
    );

    const unlockFirstRed = setup("release-fence-first-red-substitute");
    const foreignFirstRed = Buffer.from("foreign first-red at unlock");
    let firstRedSubstituted = false;
    let firstRedFinalLatestReads = 0;
    const unlockFirstRedOperations = {
      ...fs,
      readFileSync(file, ...args) {
        const bytes = fs.readFileSync(file, ...args);
        if (
          file === unlockFirstRed.paths.latest &&
          JSON.parse(Buffer.from(bytes).toString("utf8")).status === "PASS"
        ) {
          firstRedFinalLatestReads++;
          if (firstRedFinalLatestReads === 4 && !firstRedSubstituted) {
            fs.unlinkSync(unlockFirstRed.paths.firstRed);
            fs.writeFileSync(unlockFirstRed.paths.firstRed, foreignFirstRed, {
              flag: "wx",
            });
            firstRedSubstituted = true;
          }
        }
        return bytes;
      },
    };
    const firstRedError = captureError(
      () =>
        finalizeC1229S5MultiviewEvidence(
          unlockFirstRed.paths,
          unlockFirstRed.artifact,
          unlockFirstRed.ownership,
          unlockFirstRedOperations,
        ),
      /unlock-before-release-linearization first-red authority/u,
    );
    assert.equal(firstRedError.retainMultiviewRunning, true);
    assert.equal(firstRedError.publicationRecovery.ok, true);
    assert.deepEqual(
      fs.readFileSync(unlockFirstRed.paths.firstRed),
      foreignFirstRed,
    );
    assert.deepEqual(
      fs.readFileSync(unlockFirstRed.paths.latest),
      unlockFirstRed.ownership.runningBytes,
    );
    assert.deepEqual(
      fs.readFileSync(unlockFirstRed.paths.lock),
      unlockFirstRed.ownership.lockBytes,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("lifecycle rejects malformed prior latest and first-red authorities", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s5-multiview-prior-final-"),
  );
  try {
    const paths = createC1229S5MultiviewArtifactPaths(RUN_ID_2, directory);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(paths.latest, "{}\n");
    assert.throws(
      () => beginC1229S5MultiviewEvidenceRun(paths, RUN_ID_2),
      /prior latest is not an exact canonical final/u,
    );
    assert.equal(fs.existsSync(paths.lock), false);

    const prior = artifactFromReport(report(RUN_ID));
    fs.writeFileSync(paths.latest, ` ${stableC1229S5MultiviewJson(prior, 2)}`);
    assert.throws(
      () => beginC1229S5MultiviewEvidenceRun(paths, RUN_ID_2),
      /prior latest is not an exact canonical final/u,
    );
    assert.equal(fs.existsSync(paths.lock), false);

    const priorBytes = Buffer.from(stableC1229S5MultiviewJson(prior, 2));
    const priorArchive = path.join(directory, prior.artifactName);
    fs.writeFileSync(paths.latest, priorBytes);
    fs.writeFileSync(priorArchive, priorBytes);
    fs.writeFileSync(paths.firstRed, "{}\n");
    assert.throws(
      () => beginC1229S5MultiviewEvidenceRun(paths, RUN_ID_2),
      /first-red is not an exact canonical red final/u,
    );
    assert.equal(fs.existsSync(paths.lock), false);

    const redReport = report(RUN_ID);
    redReport.sessions[0].isolation.retainedACommand.resolvesA = false;
    const red = artifactFromReport(redReport);
    fs.writeFileSync(paths.firstRed, ` ${stableC1229S5MultiviewJson(red, 2)}`);
    assert.throws(
      () => beginC1229S5MultiviewEvidenceRun(paths, RUN_ID_2),
      /first-red is not an exact canonical red final/u,
    );
    assert.equal(fs.existsSync(paths.lock), false);

    fs.writeFileSync(paths.firstRed, stableC1229S5MultiviewJson(prior, 2));
    assert.throws(
      () => beginC1229S5MultiviewEvidenceRun(paths, RUN_ID_2),
      /first-red is not an exact canonical red final/u,
    );
    assert.equal(fs.existsSync(paths.lock), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("prior immutable archive authority is exact, schema-bound, and descriptor-safe", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "s5-multiview-prior-archive-"),
  );
  const setup = (name, prior = artifactFromReport(report(RUN_ID))) => {
    const directory = path.join(root, name);
    fs.mkdirSync(directory, { recursive: true });
    const paths = createC1229S5MultiviewArtifactPaths(RUN_ID_2, directory);
    const bytes = Buffer.from(stableC1229S5MultiviewJson(prior, 2));
    const archive = path.join(directory, prior.artifactName);
    fs.writeFileSync(paths.latest, bytes);
    return { archive, bytes, directory, paths, prior };
  };
  try {
    const missing = setup("missing");
    assert.throws(
      () => beginC1229S5MultiviewEvidenceRun(missing.paths, RUN_ID_2),
      /initial prior immutable archive/u,
    );
    assert.deepEqual(fs.readFileSync(missing.paths.latest), missing.bytes);
    assert.equal(fs.existsSync(missing.paths.lock), false);

    const mismatch = setup("mismatch");
    const foreignMismatch = Buffer.from("foreign immutable bytes");
    fs.writeFileSync(mismatch.archive, foreignMismatch);
    assert.throws(
      () => beginC1229S5MultiviewEvidenceRun(mismatch.paths, RUN_ID_2),
      /initial prior immutable archive/u,
    );
    assert.deepEqual(fs.readFileSync(mismatch.archive), foreignMismatch);
    assert.deepEqual(fs.readFileSync(mismatch.paths.latest), mismatch.bytes);
    assert.equal(fs.existsSync(mismatch.paths.lock), false);

    const unreadable = setup("unreadable");
    fs.writeFileSync(unreadable.archive, unreadable.bytes);
    const readFailure = Object.assign(
      new Error("injected prior archive read failure"),
      { code: "EACCES" },
    );
    const unreadableOperations = {
      ...fs,
      readFileSync(file, ...args) {
        if (file === unreadable.archive) throw readFailure;
        return fs.readFileSync(file, ...args);
      },
    };
    assert.throws(
      () =>
        beginC1229S5MultiviewEvidenceRun(
          unreadable.paths,
          RUN_ID_2,
          unreadableOperations,
        ),
      /initial prior immutable archive/u,
    );
    assert.deepEqual(fs.readFileSync(unreadable.archive), unreadable.bytes);
    assert.deepEqual(
      fs.readFileSync(unreadable.paths.latest),
      unreadable.bytes,
    );
    assert.equal(fs.existsSync(unreadable.paths.lock), false);

    const unsafe = setup("unsafe-descriptor");
    fs.writeFileSync(unsafe.archive, unsafe.bytes);
    const unsafeOperations = {
      ...fs,
      lstatSync(file, ...args) {
        const descriptor = fs.lstatSync(file, ...args);
        if (file !== unsafe.archive) return descriptor;
        return {
          dev: descriptor.dev,
          ino: descriptor.ino,
          mode: descriptor.mode,
          nlink: descriptor.nlink,
          size: descriptor.size,
          mtimeMs: descriptor.mtimeMs,
          ctimeMs: descriptor.ctimeMs,
          isFile: () => true,
          isSymbolicLink: () => true,
        };
      },
    };
    assert.throws(
      () =>
        beginC1229S5MultiviewEvidenceRun(
          unsafe.paths,
          RUN_ID_2,
          unsafeOperations,
        ),
      /initial prior immutable archive/u,
    );
    assert.deepEqual(fs.readFileSync(unsafe.archive), unsafe.bytes);
    assert.deepEqual(fs.readFileSync(unsafe.paths.latest), unsafe.bytes);
    assert.equal(fs.existsSync(unsafe.paths.lock), false);

    const predecessor = artifactFromReport(report(RUN_ID));
    predecessor.schema = "c12-29-s5-multiview-evidence-v2";
    const wrongSchema = setup("wrong-schema", predecessor);
    fs.writeFileSync(wrongSchema.archive, wrongSchema.bytes);
    assert.throws(
      () => beginC1229S5MultiviewEvidenceRun(wrongSchema.paths, RUN_ID_2),
      /prior latest is not an exact canonical final/u,
    );
    assert.deepEqual(fs.readFileSync(wrongSchema.archive), wrongSchema.bytes);
    assert.deepEqual(
      fs.readFileSync(wrongSchema.paths.latest),
      wrongSchema.bytes,
    );
    assert.equal(fs.existsSync(wrongSchema.paths.lock), false);

    const sameRun = setup("same-run");
    const sameRunPaths = createC1229S5MultiviewArtifactPaths(
      RUN_ID,
      sameRun.directory,
    );
    fs.writeFileSync(sameRun.archive, sameRun.bytes);
    assert.throws(
      () => beginC1229S5MultiviewEvidenceRun(sameRunPaths, RUN_ID),
      /current immutable archive preflight is occupied/u,
    );
    assert.deepEqual(fs.readFileSync(sameRun.archive), sameRun.bytes);
    assert.deepEqual(fs.readFileSync(sameRunPaths.latest), sameRun.bytes);
    assert.equal(fs.existsSync(sameRunPaths.lock), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("prior archive deletion after lock fails closed without replacing latest", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s5-multiview-prior-delete-"),
  );
  try {
    const prior = artifactFromReport(report(RUN_ID));
    const priorBytes = Buffer.from(stableC1229S5MultiviewJson(prior, 2));
    const priorArchive = path.join(directory, prior.artifactName);
    const paths = createC1229S5MultiviewArtifactPaths(RUN_ID_2, directory);
    fs.writeFileSync(paths.latest, priorBytes);
    fs.writeFileSync(priorArchive, priorBytes);
    let deleted = false;
    const operations = {
      ...fs,
      writeFileSync(file, bytes, options) {
        fs.writeFileSync(file, bytes, options);
        if (file === paths.lock && !deleted) {
          deleted = true;
          fs.unlinkSync(priorArchive);
        }
      },
    };
    assert.throws(
      () => beginC1229S5MultiviewEvidenceRun(paths, RUN_ID_2, operations),
      /post-lock prior immutable archive/u,
    );
    assert.equal(deleted, true);
    assert.deepEqual(fs.readFileSync(paths.latest), priorBytes);
    assert.equal(fs.existsSync(priorArchive), false);
    assert.equal(fs.existsSync(paths.lock), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("late prior archive substitutions retain exact RUNNING authority", () => {
  const runCase = (name, operationsFactory, expectedBoundary) => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), `s5-multiview-${name}-`),
    );
    try {
      const prior = artifactFromReport(report(RUN_ID));
      const priorBytes = Buffer.from(stableC1229S5MultiviewJson(prior, 2));
      const priorArchive = path.join(directory, prior.artifactName);
      const paths = createC1229S5MultiviewArtifactPaths(RUN_ID_2, directory);
      const foreign = Buffer.from(`foreign-${name}`);
      fs.writeFileSync(paths.latest, priorBytes);
      fs.writeFileSync(priorArchive, priorBytes);
      const state = {};
      const operations = operationsFactory({
        foreign,
        paths,
        priorArchive,
        state,
      });
      let caught;
      try {
        beginC1229S5MultiviewEvidenceRun(paths, RUN_ID_2, operations);
      } catch (error) {
        caught = error;
      }
      assert.match(caught?.message ?? "", expectedBoundary);
      assert.equal(caught?.retainMultiviewRunning, true);
      assert.equal(state.substituted, true);
      assert.deepEqual(fs.readFileSync(priorArchive), foreign);
      assert.equal(JSON.parse(fs.readFileSync(paths.latest)).status, "RUNNING");
      assert.equal(fs.existsSync(paths.lock), true);
      return state;
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };

  runCase(
    "post-publication-substitute",
    ({ foreign, paths, priorArchive, state }) => ({
      ...fs,
      writeFileSync(file, bytes, options) {
        fs.writeFileSync(file, bytes, options);
        if (
          file === paths.latest &&
          options?.flag === "wx" &&
          JSON.parse(Buffer.from(bytes).toString("utf8")).status === "RUNNING"
        ) {
          fs.unlinkSync(priorArchive);
          fs.writeFileSync(priorArchive, foreign, { flag: "wx" });
          state.substituted = true;
        }
      },
    }),
    /post-RUNNING-publication prior immutable archive/u,
  );

  const preReturnState = runCase(
    "pre-return-substitute",
    ({ foreign, priorArchive, state }) => ({
      ...fs,
      lstatSync(file, ...args) {
        const descriptor = fs.lstatSync(file, ...args);
        if (file === priorArchive) {
          state.archiveLstatCount = (state.archiveLstatCount ?? 0) + 1;
          // The eleventh archive descriptor read closes the post-publication
          // assertion. Substitute immediately afterward so only the distinct
          // pre-return boundary can catch the raced authority.
          if (state.archiveLstatCount === 11) {
            fs.unlinkSync(priorArchive);
            fs.writeFileSync(priorArchive, foreign, { flag: "wx" });
            state.substituted = true;
          }
        }
        return descriptor;
      },
    }),
    /pre-return prior immutable archive/u,
  );
  assert.ok(preReturnState.archiveLstatCount >= 12);
});

test("lifecycle refuses live locks and never replaces foreign canonical bytes", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s5-multiview-race-"),
  );
  try {
    const paths = createC1229S5MultiviewArtifactPaths(RUN_ID, directory);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(paths.lock, JSON.stringify({ runId: "foreign" }));
    assert.throws(
      () => beginC1229S5MultiviewEvidenceRun(paths, RUN_ID),
      /owned by foreign/u,
    );
    fs.unlinkSync(paths.lock);

    const expected = Buffer.from("expected");
    const foreign = Buffer.from("foreign");
    const lock = Buffer.from("lock");
    fs.writeFileSync(paths.latest, expected);
    fs.writeFileSync(paths.lock, lock);
    const operations = {
      ...fs,
      renameSync(from, to) {
        fs.renameSync(from, to);
        if (from === paths.latest)
          fs.writeFileSync(from, foreign, { flag: "wx" });
      },
    };
    assert.throws(
      () =>
        claimC1229S5MultiviewCanonical(
          paths.latest,
          expected,
          paths.lock,
          lock,
          "race",
          operations,
        ),
      /occupied/u,
    );
    assert.deepEqual(fs.readFileSync(paths.latest), foreign);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("owned lock release proves exact bytes and absence", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "s5-multiview-lock-"),
  );
  try {
    const lockPath = path.join(directory, "lock.json");
    const bytes = Buffer.from("owned");
    fs.writeFileSync(lockPath, bytes);
    releaseC1229S5MultiviewLock(lockPath, bytes);
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("watchdog settlement is bounded and fences late work from publication", async () => {
  const clock = (...samples) => {
    let index = 0;
    return () => samples[Math.min(index++, samples.length - 1)];
  };
  assert.equal(
    await withC1229S5MultiviewWatchdog(
      async () => 42,
      async () => {},
      1_000,
    ),
    42,
  );

  assert.equal(
    await withC1229S5MultiviewWatchdog(
      async () => 7,
      async () => {
        throw new Error("pre-deadline task must not drain");
      },
      10,
      () => null,
      1_000,
      clock(100, 109.999),
    ),
    7,
  );

  let edgeDrainCount = 0;
  let edgeError;
  try {
    await withC1229S5MultiviewWatchdog(
      async () => 7,
      async (signal) => {
        assert.equal(signal.aborted, true);
        edgeDrainCount++;
      },
      10,
      () => "webgl",
      1_000,
      clock(100, 110),
    );
  } catch (error) {
    edgeError = error;
  }
  assert.match(edgeError.message, /watchdog expired/u);
  assert.match(edgeError.cause.message, /fulfilled after watchdog deadline/u);
  assert.equal(edgeError.retainMultiviewRunning, true);
  assert.equal(edgeDrainCount, 1);

  const starvationStarted = Date.now();
  let starvationDrainCount = 0;
  let starvationError;
  try {
    await withC1229S5MultiviewWatchdog(
      async () => {
        while (Date.now() - starvationStarted < 80) {
          // Deliberately starve the timer callback. Monotonic settlement must
          // still reject this late success after the task yields.
        }
        return 42;
      },
      async (signal) => {
        assert.equal(signal.aborted, true);
        starvationDrainCount++;
      },
      5,
      () => "webgpu",
      1_000,
    );
  } catch (error) {
    starvationError = error;
  }
  assert.match(starvationError.message, /watchdog expired/u);
  assert.match(
    starvationError.cause.message,
    /fulfilled after watchdog deadline/u,
  );
  assert.equal(starvationError.retainMultiviewRunning, true);
  assert.equal(starvationDrainCount, 1);
  assert.ok(Date.now() - starvationStarted >= 80);

  let lateRejectDrainCount = 0;
  let lateRejectError;
  try {
    await withC1229S5MultiviewWatchdog(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error("late task rejection")), 20);
        }),
      async (signal) => {
        assert.equal(signal.aborted, true);
        lateRejectDrainCount++;
      },
      5,
      () => "webgl",
      1_000,
    );
  } catch (error) {
    lateRejectError = error;
  }
  assert.match(lateRejectError.message, /watchdog expired/u);
  assert.match(lateRejectError.message, /settled=true/u);
  assert.equal(lateRejectError.retainMultiviewRunning, undefined);
  assert.equal(lateRejectDrainCount, 1);

  const earlyRejection = new Error("early task rejection");
  let earlyDrainCalled = false;
  await assert.rejects(
    withC1229S5MultiviewWatchdog(
      async () => {
        throw earlyRejection;
      },
      async () => {
        earlyDrainCalled = true;
      },
      1_000,
    ),
    (error) => error === earlyRejection,
  );
  assert.equal(earlyDrainCalled, false);
  let drained = false;
  let watchdogError;
  try {
    await withC1229S5MultiviewWatchdog(
      (signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
      async () => {
        drained = true;
        return {
          renderer: "webgpu",
          page: pageProgress("webgpu"),
        };
      },
      10,
      () => "webgpu",
      1_000,
    );
  } catch (error) {
    watchdogError = error;
  }
  assert.match(watchdogError.message, /watchdog expired/u);
  assert.match(watchdogError.message, /settled=true/u);
  assert.equal(watchdogError.retainMultiviewRunning, undefined);
  assert.equal(watchdogError.c1229MultiviewDrain, undefined);
  assert.equal(watchdogError.c1229MultiviewDiagnostic.renderer, "webgpu");
  assert.deepEqual(
    watchdogError.c1229MultiviewDiagnostic.page,
    pageProgress("webgpu"),
  );
  assert.equal(drained, true);

  let failedDrainError;
  try {
    await withC1229S5MultiviewWatchdog(
      (signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
      async () => ({
        renderer: "webgpu",
        page: null,
        drainError: new Error("browser close remained unproven"),
      }),
      5,
      () => "webgpu",
      1_000,
    );
  } catch (error) {
    failedDrainError = error;
  }
  assert.match(failedDrainError.cause.message, /close remained unproven/u);
  assert.equal(failedDrainError.retainMultiviewRunning, true);

  const boundedCase = async ({ settleTask, settleDrain }) => {
    let resolveLateTask;
    let releaseDrain;
    let successContinuation = false;
    const lateTask = new Promise((resolve, reject) => {
      resolveLateTask = settleTask
        ? () => reject(new Error("late task rejected"))
        : () => resolve(42);
    });
    const lateDrain = new Promise((resolve) => {
      releaseDrain = () =>
        resolve({ renderer: "webgl", page: pageProgress("webgl") });
    });
    if (settleTask) setTimeout(resolveLateTask, 15);
    if (settleDrain) setTimeout(releaseDrain, 15);
    const started = Date.now();
    let caught;
    try {
      await withC1229S5MultiviewWatchdog(
        () => lateTask,
        () => lateDrain,
        5,
        () => "webgl",
        30,
      ).then((value) => {
        successContinuation = true;
        return value;
      });
    } catch (error) {
      caught = error;
    }
    const elapsed = Date.now() - started;
    assert.match(caught.message, /settlement exceeded 30 ms/u);
    assert.equal(caught.retainMultiviewRunning, true);
    assert.equal(caught.c1229MultiviewDrain, undefined);
    assert.equal(caught.c1229MultiviewSettlement.bounded, true);
    assert.equal(caught.c1229MultiviewSettlement.taskSettled, settleTask);
    assert.equal(caught.c1229MultiviewSettlement.drainSettled, settleDrain);
    assert.ok(elapsed < 500, `bounded watchdog took ${elapsed} ms`);
    if (!settleTask) resolveLateTask();
    if (!settleDrain) releaseDrain();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(successContinuation, false);
  };
  await boundedCase({ settleTask: false, settleDrain: true });
  await boundedCase({ settleTask: true, settleDrain: false });

  await assert.rejects(
    withC1229S5MultiviewWatchdog(
      async () => 1,
      async () => {},
      0,
      () => null,
      1,
    ),
    /positive integers/u,
  );
  const closed = await closeC1229S5MultiviewResourceBounded(
    { close: async () => {} },
    "fake",
    1_000,
  );
  assert.equal(closed.closed, true);
});

test("probe source uses real production seams and contains no fake support claim", () => {
  for (const marker of [
    "scene.createView(",
    "scene.picking._pickOffscreenView",
    "scene.pickFromRay(",
    "scene.useWebVR = true",
    "context.supportsStereoViewport",
    "tileProvider.updateForPick(frameState)",
    "webgl-production-uniform-resolver",
    "webgpu-bind-group-dynamic-offset",
    "context._webgpuSceneCaptureSources",
    "allocator._pages.find",
    "allocator dirty-range queue.writeBuffer",
    "binding-2 dirty-range write has no later owning frame submit",
    "snapshotObjectId",
    "propertiesPrototypeExact",
    "nonS5UniformDescriptorsExact",
    "snapshotPayloadFrozen",
    "snapshotWrapperExact",
    "submittedCommandBufferId",
    "instrumentationRestored",
    "engineSchedulerAvailable: false",
    "nativeArbitraryViewSchedulingClaimed: false",
  ]) {
    assert.match(
      probeSource,
      new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
    );
  }
  assert.match(probeSource, /patchMethod\(\s*manager,\s*"prepare"/u);
  assert.match(probeSource, /patchMethod\(\s*allocator,\s*"allocateAndWrite"/u);
  assert.match(probeSource, /patchMethod\(\s*allocator,\s*"flush"/u);
  assert.match(
    probeSource,
    /patchPlatformMethod\(\s*queuePrototype,\s*"submit"/u,
  );
  assert.match(
    probeSource,
    /patchMethod\(\s*renderer,\s*"_getOrCreateBindGroup0"/u,
  );
  assert.doesNotMatch(probeSource, /GPUDevice\.destroy|_device\.destroy\s*\(/u);
  assert.doesNotMatch(probeSource, /resolve:\s*\(\)\s*=>\s*payload\.slice/u);
  assert.doesNotMatch(probeSource, /c1229MultiviewDrain/u);
  assert.match(probeSource, /watchdogSettlementMs/u);
  assert.match(probeSource, /settlement exceeded/u);
  assert.match(probeSource, /multiviewOwnershipAuthorities/u);
  assert.match(
    probeSource,
    /size:\s*Number\(allocationSize \?\? bytes\.byteLength\)/u,
  );
  assert.match(probeSource, /scene\.globe\.pick\(/u);
  assert.match(probeSource, /known-webgpu-no-position-globe/u);
  assert.doesNotMatch(probeSource, /engineSchedulerAvailable:\s*true/u);
  assert.match(helperSource, /same-context-logical-view-isolation-only/u);
  assert.match(helperSource, /Scene\.render.*_defaultView/su);
});

test("status and UUID utilities remain exact", () => {
  assert.equal(isC1229S5MultiviewUuidV4(RUN_ID), true);
  assert.equal(isC1229S5MultiviewUuidV4("not-a-uuid"), false);
  assert.deepEqual(
    ["PASS", "FAIL", "ERROR", "STRUCTURAL"].map(
      exitCodeForC1229S5MultiviewStatus,
    ),
    [0, 1, 2, 3],
  );
  assert.equal(C12_29_S5_MULTIVIEW_SCHEMA.endsWith("v3"), true);
  assert.equal(C12_29_S5_MULTIVIEW_DIAGNOSTICS_SCHEMA.endsWith("v3"), true);
});
