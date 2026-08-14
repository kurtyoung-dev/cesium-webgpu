#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  C12_29_S5_CUSTOM_AGGREGATION,
  C12_29_S5_CUSTOM_BUILD_SOURCE_FILES,
  C12_29_S5_CUSTOM_CAPTURE_LABELS,
  C12_29_S5_CUSTOM_CAPTURE_METHOD,
  C12_29_S5_CUSTOM_DIAGNOSTICS_SCHEMA,
  C12_29_S5_CUSTOM_ECLIPSE_FLOATS,
  C12_29_S5_CUSTOM_EPHEMERIS,
  C12_29_S5_CUSTOM_GEOMETRY_EPSILON_METERS,
  C12_29_S5_CUSTOM_GEOMETRY_OPERATION_BUDGETS,
  C12_29_S5_CUSTOM_PHASES,
  C12_29_S5_CUSTOM_RENDERERS,
  C12_29_S5_CUSTOM_SCENE,
  C12_29_S5_CUSTOM_SCHEMA,
  C12_29_S5_CUSTOM_SOURCE_FILES,
  C12_29_S5_CUSTOM_STABILITY_METHOD,
  C12_29_S5_CUSTOM_WEBGPU_CAMERA_INDICES,
  C12_29_S5_CUSTOM_WEBGPU_ECLIPSE_BINDING,
  c1229S5CustomGeometryTolerance,
  captureC1229S5CustomPropertyDescriptor,
  computeC1229S5CustomSurfaceRadius,
  customEllipsoidGeodeticToEcef,
  deriveC1229S5CustomAxisIntersection,
  deriveC1229S5CustomCrossBackend,
  deriveC1229S5CustomOracleSample,
  deriveC1229S5CustomSampleId,
  evaluateC1229S5CustomFragment,
  exitCodeForC1229S5CustomStatus,
  foldC1229S5CustomEllipsoidGate,
  isC1229S5CustomUuidV4,
  packC1229S5CustomCommonRay,
  restoreC1229S5CustomPropertyDescriptor,
  stableC1229S5CustomJson,
  validateC1229S5CustomEphemerisLineage,
  validateC1229S5CustomFinalArtifact,
  validateC1229S5CustomMoonTopology,
} from "./lib/c12-29-s5-custom-ellipsoid-gate.mjs";
import { inspectBuildSourceIdentity } from "./lib/build-source-identity.mjs";
import {
  checkEmbeddedFusedSnapshotIsCanonical,
  checkFusedCaptureUsage,
} from "./lib/same-task-capture.mjs";
import {
  beginC1229S5CustomEvidenceRun,
  boundedC1229S5CustomErrorText,
  claimC1229S5CustomCanonical,
  cleanupC1229S5CustomOwnedPngs,
  closeC1229S5CustomBrowserBounded,
  closeC1229S5CustomResourceBounded,
  combineC1229S5CustomPrimaryAndCleanup,
  createC1229S5CustomArtifactPaths,
  createC1229S5CustomErrorArtifact,
  createC1229S5CustomImmutableAuthority,
  finalizeC1229S5CustomEvidence,
  releaseC1229S5CustomLock,
  runC1229S5CustomBestEffortCleanup,
  runC1229S5CustomBrowserSession,
  runC1229S5CustomEllipsoidProbe,
  settleC1229S5CustomTasksBounded,
  validateC1229S5CustomLoopbackBase,
  validateC1229S5CustomPriorFinal,
  withC1229S5CustomWatchdog,
} from "./probe-c12-29-s5-custom-ellipsoid.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const helperPath = path.join(
  __dirname,
  "lib/c12-29-s5-custom-ellipsoid-gate.mjs",
);
const probePath = path.join(__dirname, "probe-c12-29-s5-custom-ellipsoid.mjs");
const helperSource = fs.readFileSync(helperPath, "utf8");
const probeSource = fs.readFileSync(probePath, "utf8");

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const SHA = "a".repeat(64);
const FIXTURE_SUN = { x: 149_600_000_000, y: 0, z: 0 };
const FIXTURE_MOON = { x: 350_000_000, y: 0, z: 0 };

function fp() {
  return { exists: true, byteLength: 7, sha256: SHA };
}

function params() {
  return {
    params: { x: 1, y: 1, z: 0.08, w: -0.03 },
    params2: { x: 0.00005, y: 1 / 3, z: 0, w: 0.01 },
  };
}

function alignedBodies() {
  return {
    sun: { x: 149_600_000_000, y: 0, z: 0 },
    moon: { x: 384_400_000, y: 0, z: 0 },
    ...params(),
  };
}

function fixtureEphemeris(frameNumber, clockIso) {
  return {
    frameNumber,
    clockIso,
    provider: {
      constructor: C12_29_S5_CUSTOM_EPHEMERIS.providerConstructor,
      id: C12_29_S5_CUSTOM_EPHEMERIS.providerId,
      revision: C12_29_S5_CUSTOM_EPHEMERIS.providerRevision,
      provenance: structuredClone(C12_29_S5_CUSTOM_EPHEMERIS.provenance),
      timePolicy: structuredClone(C12_29_S5_CUSTOM_EPHEMERIS.timePolicy),
      provenanceFrozen: true,
      timePolicyFrozen: true,
    },
    sample: {
      providerId: C12_29_S5_CUSTOM_EPHEMERIS.providerId,
      providerRevision: C12_29_S5_CUSTOM_EPHEMERIS.providerRevision,
      provenance: structuredClone(C12_29_S5_CUSTOM_EPHEMERIS.provenance),
      timePolicy: structuredClone(C12_29_S5_CUSTOM_EPHEMERIS.timePolicy),
      referenceFrame: C12_29_S5_CUSTOM_EPHEMERIS.referenceFrame,
      units: C12_29_S5_CUSTOM_EPHEMERIS.units,
      transformBranch: C12_29_S5_CUSTOM_EPHEMERIS.transformBranch,
      outputAllocationStable: true,
      thirdPartyTemporaryFree: true,
      sunPositionWC: { ...FIXTURE_SUN },
      moonPositionWC: { ...FIXTURE_MOON },
    },
    independent: {
      method: C12_29_S5_CUSTOM_EPHEMERIS.independentMethod,
      sunPositionWC: { ...FIXTURE_SUN },
      moonPositionWC: { ...FIXTURE_MOON },
      sunDeltaMeters: 0,
      moonDeltaMeters: 0,
    },
    eclipseState: {
      sunPositionWC: { ...FIXTURE_SUN },
      moonPositionWC: { ...FIXTURE_MOON },
      sunDeltaMeters: 0,
      moonDeltaMeters: 0,
      sunStorageDistinct: true,
      moonStorageDistinct: true,
    },
    consumers: {
      uniformSunPositionWC: { ...FIXTURE_SUN },
      uniformSunStorageDistinct: true,
      viewRotation3D: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      moonDirectionEC: { x: 1, y: 0, z: 0 },
      moonDirectionStorageDistinct: true,
      moonModelTranslation: { ...FIXTURE_MOON },
      moonModelStorageDistinct: true,
    },
    identities: {
      providerIsSceneProvider: true,
      sampleIsFrameStateSample: true,
      sampleProvenanceIsProviderProvenance: true,
      sampleTimePolicyIsProviderTimePolicy: true,
    },
  };
}

function fixtureTemporalState(label, preparedTuple, frameNumber) {
  const antipode = label.startsWith("antipode-");
  const control = label.startsWith("control-");
  const lightingEnabled = label.endsWith("-on");
  const active = lightingEnabled && !control && !antipode;
  const target = {
    longitude: antipode ? -Math.PI : 0,
    latitude: 0,
    height: C12_29_S5_CUSTOM_SCENE.heightMeters,
  };
  const positionObject = customEllipsoidGeodeticToEcef({
    ...target,
    height: C12_29_S5_CUSTOM_SCENE.cameraHeightMeters,
  });
  const positionWC = [positionObject.x, positionObject.y, positionObject.z];
  const normalize = (value) => {
    const magnitude = Math.hypot(...value);
    return value.map((entry) => entry / magnitude);
  };
  const cross = (left, right) => [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
  const directionWC = normalize(positionWC.map((value) => -value));
  const north = [
    -Math.sin(target.latitude) * Math.cos(target.longitude),
    -Math.sin(target.latitude) * Math.sin(target.longitude),
    Math.cos(target.latitude),
  ];
  const rightWC = normalize(cross(directionWC, north));
  const upWC = normalize(cross(rightWC, directionWC));
  const clockIso = control
    ? C12_29_S5_CUSTOM_SCENE.controlIso
    : C12_29_S5_CUSTOM_SCENE.eventIso;
  return {
    clockIso,
    cameraTarget: target,
    camera: {
      positionWC,
      directionWC,
      upWC,
      rightWC,
      viewMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      projectionMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      frustum: {
        fov: (C12_29_S5_CUSTOM_SCENE.cameraFovDegrees * Math.PI) / 180,
        aspectRatio:
          C12_29_S5_CUSTOM_SCENE.viewport.width /
          C12_29_S5_CUSTOM_SCENE.viewport.height,
        near: 1,
        far: 20_000_000,
      },
    },
    provider: {
      constructor: "CustomHeightmapTerrainProvider",
      objectIdentity: true,
      tilingSchemeIdentity: true,
      width: C12_29_S5_CUSTOM_SCENE.terrainWidth,
      height: C12_29_S5_CUSTOM_SCENE.terrainHeight,
      constantHeight: C12_29_S5_CUSTOM_SCENE.heightMeters,
      requestCount: 2,
    },
    preparedTuple: structuredClone(preparedTuple),
    content: preparedTuple.selectedTileIds.map((tileId, contentIndex) => ({
      tileId,
      meshIdentity: `mesh-${contentIndex + 1}`,
      renderedMesh: true,
    })),
    eclipse: {
      lightingEnabled,
      blockPresent: true,
      active,
      revision: 7,
      sunDirectionAndInvRange: { x: 1, y: 0, z: 0, w: 1 },
      moonDirectionDeltaAndInvRange: { x: 1, y: 0, z: 0, w: 1 },
      params: { x: active ? 1 : 0, y: 1, z: 0, w: 0 },
      params2: { x: 0.00005, y: 1 / 3, z: 0, w: 0 },
    },
    ephemeris: fixtureEphemeris(frameNumber, clockIso),
  };
}

function image(renderer, label, index, preparedTuple, firstSelectionRevision) {
  const imageId = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  const taskToken = `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  const result = {
    label,
    imageId,
    fileName: `${RUN_ID}.${imageId}.${renderer}.${label}.png`,
    byteLength: label.startsWith("antipode-")
      ? 103
      : label.startsWith("control-")
        ? 105
        : 100 + index,
    sha256: SHA,
    width: C12_29_S5_CUSTOM_SCENE.viewport.width,
    height: C12_29_S5_CUSTOM_SCENE.viewport.height,
    captureMethod: C12_29_S5_CUSTOM_CAPTURE_METHOD,
    renderTaskToken: taskToken,
    captureTaskToken: taskToken,
    metricImageId: imageId,
    fingerprintVerified: true,
  };
  const firstFrame = index * 10 + 1;
  result.temporalStability = {
    method: C12_29_S5_CUSTOM_STABILITY_METHOD,
    requiredConsecutiveFrames: C12_29_S5_CUSTOM_SCENE.minimumStableFrames,
    maximumFrames: C12_29_S5_CUSTOM_SCENE.maximumStabilityFrames,
    attemptedFrames: C12_29_S5_CUSTOM_SCENE.minimumStableFrames + 1,
    observations: Array.from(
      { length: C12_29_S5_CUSTOM_SCENE.minimumStableFrames },
      (_, observationIndex) => ({
        ordinal: observationIndex + 1,
        frameNumber: firstFrame + observationIndex,
        byteLength: result.byteLength,
        sha256: result.sha256,
        width: result.width,
        height: result.height,
        state: {
          ...fixtureTemporalState(
            label,
            preparedTuple,
            firstFrame + observationIndex,
          ),
          preparedTuple: {
            ...structuredClone(preparedTuple),
            selectionRevision: firstSelectionRevision + observationIndex,
          },
        },
      }),
    ),
    captureFrameNumber: firstFrame + C12_29_S5_CUSTOM_SCENE.minimumStableFrames,
    captureState: {
      ...fixtureTemporalState(
        label,
        preparedTuple,
        firstFrame + C12_29_S5_CUSTOM_SCENE.minimumStableFrames,
      ),
      preparedTuple: {
        ...structuredClone(preparedTuple),
        selectionRevision:
          firstSelectionRevision + C12_29_S5_CUSTOM_SCENE.minimumStableFrames,
      },
    },
    captureOutput: {
      byteLength: result.byteLength,
      sha256: result.sha256,
      width: result.width,
      height: result.height,
    },
    renderFirst: true,
    sameTaskFusedCapture: true,
  };
  return result;
}

function temporalStates(image) {
  return [
    ...image.temporalStability.observations.map(
      (observation) => observation.state,
    ),
    image.temporalStability.captureState,
  ];
}

function luminance(rgba) {
  return (0.2126 * rgba[0] + 0.7152 * rgba[1] + 0.0722 * rgba[2]) / 255;
}

function distance(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function tileCoordinates(cartographic, level = 2) {
  const tilesX = 2 * 2 ** level;
  const tilesY = 2 ** level;
  const tileWidth = (2 * Math.PI) / tilesX;
  const tileHeight = Math.PI / tilesY;
  const x = Math.min(
    tilesX - 1,
    Math.floor((cartographic.longitude + Math.PI) / tileWidth),
  );
  const y = Math.min(
    tilesY - 1,
    Math.floor((Math.PI / 2 - cartographic.latitude) / tileHeight),
  );
  const west = -Math.PI + x * tileWidth;
  const south = Math.PI / 2 - (y + 1) * tileHeight;
  return {
    tileId: `${level}/${x}/${y}`,
    tileUv: [
      (cartographic.longitude - west) / tileWidth,
      (cartographic.latitude - south) / tileHeight,
    ],
  };
}

function primaryOracleSample({
  longitudeDegrees,
  latitudeDegrees,
  pixelIndex,
  offMetricImageId,
  onMetricImageId,
  event,
  horizon = false,
}) {
  const cartographic = {
    longitude: (longitudeDegrees * Math.PI) / 180,
    latitude: (latitudeDegrees * Math.PI) / 180,
    height: C12_29_S5_CUSTOM_SCENE.heightMeters,
  };
  const pixel = { x: 100 + pixelIndex * 23, y: 200 + pixelIndex * 17 };
  const runtimePosition = customEllipsoidGeodeticToEcef(cartographic, "f64");
  const offRgba = [200, 200, 200, 255];
  const preview = deriveC1229S5CustomOracleSample({
    cartographic,
    sun: event.runtimeBodies.sun,
    moon: event.runtimeBodies.moon,
    params: event.shadowBlock.params,
    params2: event.shadowBlock.params2,
    offLuminance: luminance(offRgba),
    onLuminance: luminance(offRgba),
    runtimePosition,
  });
  assert.ok(preview);
  const onByte = horizon ? 200 : Math.round(preview.f64 * 200);
  const onRgba = [onByte, onByte, onByte, 255];
  const derived = deriveC1229S5CustomOracleSample({
    cartographic,
    sun: event.runtimeBodies.sun,
    moon: event.runtimeBodies.moon,
    params: event.shadowBlock.params,
    params2: event.shadowBlock.params2,
    offLuminance: luminance(offRgba),
    onLuminance: luminance(onRgba),
    runtimePosition,
  });
  assert.ok(derived?.geometryIdentity);
  const tile = tileCoordinates(cartographic);
  const tileBoundaryPixels = [
    { x: pixel.x + 10, y: pixel.y },
    { x: pixel.x - 17, y: pixel.y },
    { x: pixel.x, y: pixel.y + 13 },
    { x: pixel.x, y: pixel.y - 19 },
  ];
  const tileBoundaryDistancesPixels = tileBoundaryPixels.map((boundary) =>
    Math.hypot(boundary.x - pixel.x, boundary.y - pixel.y),
  );
  const normalizedBoundaryDistance = Math.min(
    tile.tileUv[0],
    1 - tile.tileUv[0],
    tile.tileUv[1],
    1 - tile.tileUv[1],
  );
  const sample = {
    id: "pending",
    cartographic,
    pixel,
    tileId: tile.tileId,
    tileUv: tile.tileUv,
    normalizedBoundaryDistance,
    tileBoundaryPixels,
    tileBoundaryDistancesPixels,
    boundaryDistancePixels: Math.min(...tileBoundaryDistancesPixels),
    flatTileInterior: true,
    runtimePosition,
    offRgba,
    onRgba,
    offMetricImageId,
    onMetricImageId,
    boundaryAmbiguous: derived.boundaryAmbiguous,
    classification: derived.classificationF64,
    classificationF32: derived.classificationF32,
    offLuminance: luminance(offRgba),
    onLuminance: luminance(onRgba),
    f64: derived.f64,
    f32: derived.f32,
    f32Error: derived.f32Error,
    quantizationBound: derived.quantizationBound,
    tolerance: derived.tolerance,
    observedFactor: derived.observedFactor,
    absoluteError: derived.absoluteError,
    withinTolerance: derived.withinTolerance,
    horizonRejectedF64: derived.horizonRejectedF64,
    horizonRejectedF32: derived.horizonRejectedF32,
    geometricF64: derived.geometricF64,
    geometricF32: derived.geometricF32,
    geometryIdentity: derived.geometryIdentity,
  };
  sample.id = deriveC1229S5CustomSampleId(sample);
  return sample;
}

function passingInstrumentationRestorations(renderer) {
  const labels = [
    ...(renderer === "webgpu"
      ? [
          "captureGlobeRenderer.getOrCreateCaptureTileCommands",
          "eclipseManager.prepare",
        ]
      : []),
    "moon.show",
    "moon.update",
    "pickProvider.updateForPick",
  ];
  return labels.map((label) => {
    const hadOwnBefore = label === "moon.show";
    const ownerDescriptor = {
      kind: "data",
      writable: true,
      enumerable: hadOwnBefore,
      configurable: true,
    };
    return {
      label,
      hadOwnBefore,
      hasOwnAfter: hadOwnBefore,
      ownerDepthBefore: hadOwnBefore ? 0 : 1,
      ownerDepthAfter: hadOwnBefore ? 0 : 1,
      ownerDescriptorBefore: { ...ownerDescriptor },
      ownerDescriptorAfter: { ...ownerDescriptor },
      preResolvedAuthorityExact: true,
      ownershipExact: true,
      ownDescriptorExact: true,
      targetPrototypeExact: true,
      prototypeChainExact: true,
      ownerDescriptorExact: true,
      resolvedIdentityExact: true,
      restored: true,
    };
  });
}

function passingSession(renderer, imageOffset) {
  const radius = computeC1229S5CustomSurfaceRadius({
    maximumRadius: 8_000_000,
    minimumHeight: 0,
    maximumHeight: 24_000,
  });
  const selectedTileIds = ["0/0/0", "0/1/0"];
  const preparedTuple = {
    prepared: true,
    selectionRevision: 5,
    surfaceRadius: radius.radius,
    selectedTileIds,
  };
  const firstSelectionRevisions = [6, 10, 21, 25, 41, 45];
  const sessionImages = C12_29_S5_CUSTOM_CAPTURE_LABELS.map((label, index) =>
    image(
      renderer,
      label,
      imageOffset + index,
      preparedTuple,
      firstSelectionRevisions[index],
    ),
  );
  const imageIdFor = (label) =>
    sessionImages.find((entry) => entry.label === label).imageId;
  const bodies = {
    sun: { x: 149_600_000_000, y: 0, z: 0 },
    moon: { x: 350_000_000, y: 0, z: 0 },
    sunInertial: { x: 149_600_000_000, y: 0, z: 0 },
    moonInertial: { x: 350_000_000, y: 0, z: 0 },
    icrfToFixed: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  };
  const shadowParams = params();
  const expectedPayload = Array.from(
    packC1229S5CustomCommonRay({ ...bodies, ...shadowParams }, "f32"),
  );
  const shadowVectors = {
    sunDirectionAndInvRange: {
      x: expectedPayload[0],
      y: expectedPayload[1],
      z: expectedPayload[2],
      w: expectedPayload[3],
    },
    moonDirectionDeltaAndInvRange: {
      x: expectedPayload[4],
      y: expectedPayload[5],
      z: expectedPayload[6],
      w: expectedPayload[7],
    },
    params: { ...shadowParams.params },
    params2: { ...shadowParams.params2 },
  };
  const backendIdentity =
    renderer === "webgl"
      ? {
          automaticUniforms: {
            exportName: "AutomaticUniforms",
            servedBundleExport: true,
            bundleExportIdentity: true,
            radiiUniformIdentity: true,
            inverseRadiiUniformIdentity: true,
            radiiExact: true,
            inverseRadiiExact: true,
            radii: { ...C12_29_S5_CUSTOM_SCENE.radii },
            inverseRadii: {
              x: 1 / C12_29_S5_CUSTOM_SCENE.radii.x,
              y: 1 / C12_29_S5_CUSTOM_SCENE.radii.y,
              z: 1 / C12_29_S5_CUSTOM_SCENE.radii.z,
            },
            radiiSource:
              "C.AutomaticUniforms.czm_ellipsoidRadii.getValue(scene.context.uniformState)",
            inverseRadiiSource:
              "C.AutomaticUniforms.czm_ellipsoidInverseRadii.getValue(scene.context.uniformState)",
          },
        }
      : {
          cameraUbo: {
            indices: { ...C12_29_S5_CUSTOM_WEBGPU_CAMERA_INDICES },
            values: {
              inverseRadiiX: Math.fround(1 / 8_000_000),
              inverseRadiiY: Math.fround(1 / 8_000_000),
              inverseRadiiZ: Math.fround(1 / 5_000_000),
              maximumRadius: Math.fround(8_000_000),
            },
            valuesExact: true,
          },
          eclipseBinding: {
            binding: C12_29_S5_CUSTOM_WEBGPU_ECLIPSE_BINDING,
            offsetAligned: true,
            size: 64,
            payload: [...expectedPayload],
            block: { revision: 1, ...structuredClone(shadowVectors) },
            payloadExact: true,
          },
        };
  const phases = Object.fromEntries(
    C12_29_S5_CUSTOM_PHASES.map((phase) => [phase, {}]),
  );
  phases["custom-scene-construction"] = {
    ellipsoid: {
      constructor: "Ellipsoid",
      radii: { ...C12_29_S5_CUSTOM_SCENE.radii },
      sceneIdentity: true,
    },
    provider: {
      constructor: "CustomHeightmapTerrainProvider",
      width: 17,
      height: 17,
      constantHeight: 24_000,
      tilingSchemeIdentity: true,
    },
    projection: {
      constructor: "GeographicProjection",
      ellipsoidIdentity: true,
      sceneIdentity: true,
    },
    tilingScheme: {
      constructor: "GeographicTilingScheme",
      ellipsoidIdentity: true,
    },
    globe: { ellipsoidIdentity: true, sceneIdentity: true },
    imagery: {
      constructor: "GridImageryProvider",
      tilingSchemeIdentity: true,
    },
    moon: {
      widgetDefaultAbsent: true,
      explicitlyConstructed: true,
      servedConstructorIdentity: true,
      sceneIdentity: true,
      lifecycleOwner: "scene.moon",
      updateIsFunction: true,
      destroyIsFunction: true,
    },
  };
  phases["selected-terrain-preparation"] = {
    ...preparedTuple,
    tilesLoaded: true,
    knownMinimumHeight: 0,
    knownMaximumHeight: 24_000,
    knownBoundsValid: true,
    radiusLaw: {
      maximumRadius: 8_000_000,
      minimumHeight: 0,
      maximumHeight: 24_000,
      height: 24_000,
    },
    terrainRequestCount: 2,
    terrainRequests: [
      { x: 0, y: 0, level: 0, height: 24_000 },
      { x: 1, y: 0, level: 0, height: 24_000 },
    ],
    backendIdentity,
  };
  phases["event-s5-off"] = {
    enabled: false,
    clockIso: C12_29_S5_CUSTOM_SCENE.eventIso,
    preparedTuple: structuredClone(
      sessionImages[0].temporalStability.captureState.preparedTuple,
    ),
  };
  const axis = deriveC1229S5CustomAxisIntersection(bodies);
  assert.ok(axis);
  const axisCartographic = { longitude: 0, latitude: 0, height: 0 };
  const axisSurface = customEllipsoidGeodeticToEcef(axisCartographic, "f64");
  const pointTolerance = c1229S5CustomGeometryTolerance(
    "axisIntersectionPoint",
    "meters",
  );
  const directionTolerance = c1229S5CustomGeometryTolerance(
    "axisDirection",
    "dimensionless",
  );
  const surfaceTolerance =
    pointTolerance + c1229S5CustomGeometryTolerance("ecefPosition", "meters");
  const eventCentre = {
    derivedFromRuntimeBodies: true,
    hardcodedLongitude: false,
    longitude: 0,
    latitude: 0,
    point: axis.point,
    direction: axis.direction,
    forwardRoot: axis.forwardRoot,
    geometryIdentity: {
      baseEpsilonMeters: C12_29_S5_CUSTOM_GEOMETRY_EPSILON_METERS,
      pointDifferenceMeters: 0,
      pointToleranceMeters: pointTolerance,
      directionDifference: 0,
      directionTolerance,
      rootDifferenceMeters: 0,
      rootToleranceMeters: pointTolerance,
      surfacePointDifferenceMeters: distance(axisSurface, axis.point),
      surfacePointToleranceMeters: surfaceTolerance,
      withinTolerance: distance(axisSurface, axis.point) <= surfaceTolerance,
    },
  };
  phases["event-s5-on"] = {
    enabled: true,
    clockIso: C12_29_S5_CUSTOM_SCENE.eventIso,
    preparedTuple: structuredClone(
      sessionImages[1].temporalStability.captureState.preparedTuple,
    ),
    eventCentre,
    runtimeBodies: bodies,
    shadowBlock: {
      ...structuredClone(shadowVectors),
      ...(renderer === "webgl"
        ? {
            webglPackedUniform: [...expectedPayload],
            webglPackedF32: [...expectedPayload],
            payloadExact: true,
          }
        : {}),
    },
    oracleSampleCount: 9,
    oracleSampleCounts: { umbra: 3, penumbra: 3, clear: 3 },
    allSamplesWithinDerivedTolerance: true,
    hasUmbra: true,
    hasPenumbra: true,
    hasClear: true,
  };
  const eventSamples = [
    [0.2, 0.2],
    [0.4, 0.3],
    [0.6, 0.4],
    [2, 0.5],
    [5, 1],
    [10, 2],
    [30, 2],
    [35, 3],
    [40, 4],
  ].map(([longitudeDegrees, latitudeDegrees], index) =>
    primaryOracleSample({
      longitudeDegrees,
      latitudeDegrees,
      pixelIndex: index,
      offMetricImageId: imageIdFor("event-off"),
      onMetricImageId: imageIdFor("event-on"),
      event: phases["event-s5-on"],
    }),
  );
  assert.deepEqual(
    eventSamples.map((sample) => sample.classification),
    [
      "umbra",
      "umbra",
      "umbra",
      "penumbra",
      "penumbra",
      "penumbra",
      "clear",
      "clear",
      "clear",
    ],
  );
  const antipodeSamples = [
    [-179, 1],
    [-178, 2],
    [-177, 3],
  ].map(([longitudeDegrees, latitudeDegrees], index) =>
    primaryOracleSample({
      longitudeDegrees,
      latitudeDegrees,
      pixelIndex: 20 + index,
      offMetricImageId: imageIdFor("antipode-off"),
      onMetricImageId: imageIdFor("antipode-on"),
      event: phases["event-s5-on"],
      horizon: true,
    }),
  );
  phases["antipode-horizon-control"] = {
    centre: { longitude: -Math.PI, latitude: 0 },
    preparedTupleBefore: {
      ...structuredClone(preparedTuple),
      selectionRevision: 20,
    },
    offPreparedTuple: structuredClone(
      sessionImages[2].temporalStability.captureState.preparedTuple,
    ),
    onPreparedTuple: structuredClone(
      sessionImages[3].temporalStability.captureState.preparedTuple,
    ),
    allCandidatesHorizonRejected: true,
    offOnByteIdentical: true,
    samples: antipodeSamples,
  };
  phases["behavioral-pick"] = {
    method: "scene.pickAsync",
    invoked: true,
    awaited: true,
    settled: true,
    renderPumpFrames: 1,
    maximumPumpFrames: C12_29_S5_CUSTOM_SCENE.maximumPickPumpFrames,
    directUpdateForPickCall: false,
    pickableBefore: false,
    pickableRequested: true,
    pickIdAllocated: true,
    pickIdKey: 7,
    pickIdRegistryOwnsGlobe: true,
    pickColorMirrorExact: true,
    updateForPickObserved: true,
    updateForPickCalls: 1,
    resultKind: renderer === "webgpu" ? "globe" : "undefined",
    resultPrimitiveIdentity: renderer === "webgpu",
    pickableAfterRestore: false,
    pickableRestored: true,
    postcondition: {
      before: {
        prepared: false,
        selectionRevision: null,
        surfaceRadius: null,
        selectedTileIds: [...selectedTileIds],
      },
      after: {
        ...structuredClone(preparedTuple),
        selectionRevision: 30,
      },
      surfaceRadius: radius.radius,
      selectionRevision: 30,
      selectedTileIds,
    },
  };
  phases["retained-capture"] =
    renderer === "webgl"
      ? { applicability: "N/A-WebGPU-only" }
      : {
          applicability: "required",
          managerDriven: true,
          directCaptureHelperCall: false,
          tinyLocalModel: true,
          faceCount: 6,
          faceTileCardinalityExact: true,
          terrainDrawCount: 6,
          cameraRestored: true,
          preparedTuplePreserved: true,
          cameraUboInverseRadiiExact: true,
          eclipseBindingOffsetsExact: true,
          eclipseBindingPayloads: [[...expectedPayload]],
          eclipseBindingPayloadsExact: true,
          submittedWork: true,
        };
  phases["noneclipse-identity-control"] = {
    clockIso: C12_29_S5_CUSTOM_SCENE.controlIso,
    runtimeBodies: {
      sun: { ...FIXTURE_SUN },
      moon: { ...FIXTURE_MOON },
    },
    inactive: true,
    preparedTupleBefore: {
      ...structuredClone(preparedTuple),
      selectionRevision: 40,
    },
    offPreparedTuple: structuredClone(
      sessionImages[4].temporalStability.captureState.preparedTuple,
    ),
    onPreparedTuple: structuredClone(
      sessionImages[5].temporalStability.captureState.preparedTuple,
    ),
    offOnByteIdentical: true,
  };
  phases["session-cleanup"] = {
    complete: true,
    timersCleared: true,
    cleanupFailures: [],
    instrumentationRestorations: passingInstrumentationRestorations(renderer),
    instrumentationRestored: true,
    defaultEllipsoidRestored: true,
  };
  return {
    renderer,
    actualRenderer: renderer,
    phaseOrder: [...C12_29_S5_CUSTOM_PHASES],
    completedPhases: [...C12_29_S5_CUSTOM_PHASES],
    phases,
    images: sessionImages,
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
    },
    oracleSamples: eventSamples,
    cleanup: {
      complete: true,
      pageClosed: true,
      contextClosed: true,
      timersCleared: true,
      pendingRequests: 0,
      pageCloseTimedOut: false,
      contextCloseTimedOut: false,
    },
  };
}

function passingReport() {
  const sessions = [passingSession("webgl", 1), passingSession("webgpu", 7)];
  const crossSamples = sessions[0].oracleSamples.map((left, index) => {
    const right = sessions[1].oracleSamples[index];
    const derived = deriveC1229S5CustomCrossBackend(left, right);
    return {
      id: left.id,
      classification: left.classification,
      webglObservedFactor: left.observedFactor,
      webgpuObservedFactor: right.observedFactor,
      maximumF32Error: derived.maximumF32Error,
      quantizationBound: derived.quantizationBound,
      tolerance: derived.tolerance,
      absoluteDifference: derived.absoluteDifference,
      withinTolerance: derived.withinTolerance,
    };
  });
  const buildIdentity = {
    ok: true,
    entries: C12_29_S5_CUSTOM_BUILD_SOURCE_FILES.map((file) => ({
      file: `/repo/${file}`,
      sourceMapEntry: `../../${file}`,
      currentByteLength: 7,
      embeddedByteLength: 7,
      currentSha256: SHA,
      embeddedSha256: SHA,
      exact: true,
      reason: null,
    })),
    reasons: [],
    sourceMapPath: "/repo/Build/CesiumUnminified/index.js.map",
    sourceMapByteLength: 10,
    sourceMapSha256: SHA,
  };
  return {
    schema: C12_29_S5_CUSTOM_SCHEMA,
    runId: RUN_ID,
    aggregation: C12_29_S5_CUSTOM_AGGREGATION,
    incomplete: false,
    contract: {
      eventIso: C12_29_S5_CUSTOM_SCENE.eventIso,
      controlIso: C12_29_S5_CUSTOM_SCENE.controlIso,
      radii: { ...C12_29_S5_CUSTOM_SCENE.radii },
      heightMeters: C12_29_S5_CUSTOM_SCENE.heightMeters,
      cameraHeightMeters: C12_29_S5_CUSTOM_SCENE.cameraHeightMeters,
      terrainDimensions: { width: 17, height: 17 },
      phaseOrder: [...C12_29_S5_CUSTOM_PHASES],
      captureLabels: [...C12_29_S5_CUSTOM_CAPTURE_LABELS],
      temporalStability: {
        method: C12_29_S5_CUSTOM_STABILITY_METHOD,
        minimumConsecutiveFrames: C12_29_S5_CUSTOM_SCENE.minimumStableFrames,
        maximumFrames: C12_29_S5_CUSTOM_SCENE.maximumStabilityFrames,
      },
      cameraUboIndices: { ...C12_29_S5_CUSTOM_WEBGPU_CAMERA_INDICES },
      eclipseBinding: C12_29_S5_CUSTOM_WEBGPU_ECLIPSE_BINDING,
      radiusLaw: {
        fillSkirtAllowanceMeters: 1000,
        absoluteSafetyMeters: 2,
        relativeSafety: 8 * 2 ** -23,
      },
      tileInteriorPixelFootprintRadius:
        C12_29_S5_CUSTOM_SCENE.tileInteriorPixelFootprintRadius,
      geometryEpsilonMeters: C12_29_S5_CUSTOM_GEOMETRY_EPSILON_METERS,
      geometryOperationBudgets: C12_29_S5_CUSTOM_GEOMETRY_OPERATION_BUDGETS,
    },
    provenance: {
      ok: true,
      stable: true,
      reasons: [],
      gitHead: {
        start: "1".repeat(40),
        end: "1".repeat(40),
        stable: true,
      },
      sourceBoundary: {
        count: C12_29_S5_CUSTOM_SOURCE_FILES.length,
        files: [...C12_29_S5_CUSTOM_SOURCE_FILES],
        allReadable: true,
      },
      localFiles: C12_29_S5_CUSTOM_SOURCE_FILES.map((file) => ({
        file,
        start: fp(),
        end: fp(),
      })),
      generatedShaders: {
        start: { globeFsExact: true, globeTerrainExact: true },
        end: { globeFsExact: true, globeTerrainExact: true },
        stable: true,
      },
      buildSourceIdentity: {
        start: buildIdentity,
        end: structuredClone(buildIdentity),
        stable: true,
      },
      servedEntryIdentity: {
        ok: true,
        reasons: [],
        expectedLabels: ["webgl", "webgpu"],
        observedLabels: ["webgl", "webgpu"],
        localStart: fp(),
        localEnd: fp(),
        stable: true,
      },
      xys: [
        {
          renderer: "webgl",
          file: "IAU2006_XYS_26.json",
          localStart: fp(),
          localEnd: fp(),
          served: fp(),
        },
        {
          renderer: "webgpu",
          file: "IAU2006_XYS_26.json",
          localStart: fp(),
          localEnd: fp(),
          served: fp(),
        },
      ],
      sameTaskCapture: {
        canonical: true,
        usageExact: true,
        helperPinned: true,
        helperIdentity: {
          file: "Tools/visual-regression/lib/same-task-capture.mjs",
          start: fp(),
          end: fp(),
        },
      },
      harnessStable: true,
    },
    sessions,
    crossBackendOracle: {
      aggregation: C12_29_S5_CUSTOM_AGGREGATION,
      matchedSampleCount: 9,
      allWithinDerivedTolerance: true,
      samples: crossSamples,
    },
    cleanup: {
      complete: true,
      browserClosed: true,
      contextsClosed: true,
      timersCleared: true,
      pendingRequests: 0,
    },
  };
}

function passingArtifact() {
  const report = passingReport();
  return finalArtifactFromReport(report);
}

function finalArtifactFromReport(report) {
  const verdict = foldC1229S5CustomEllipsoidGate(report);
  return {
    ...report,
    artifactName: `${report.runId}.json`,
    status: verdict.status,
    exitCode: verdict.exitCode,
    reasons: {
      structural: verdict.structuralReasons,
      failures: verdict.failureReasons,
    },
    checks: verdict.checks,
  };
}

function legacyV5Final(artifact) {
  const legacy = structuredClone(artifact);
  legacy.schema = "c12-29-s5-custom-ellipsoid-evidence-v5";
  if (legacy.status === "ERROR") {
    legacy.diagnostics.schema =
      "c12-29-s5-custom-ellipsoid-runtime-diagnostics-v5";
    if (legacy.diagnostics.page !== null) {
      legacy.diagnostics.page.schema =
        "c12-29-s5-custom-ellipsoid-runtime-diagnostics-v5";
    }
  } else {
    for (const session of legacy.sessions) {
      session.phases["custom-scene-construction"].moon.constructor = "Moon";
    }
  }
  return legacy;
}

function materializePassingArtifactPngs(paths, artifact, ownership) {
  assert.equal(artifact.runId, ownership.runId);
  assert.deepEqual(ownership.pngAuthorities, []);
  for (const session of artifact.sessions) {
    for (const image of session.images) {
      const visualClass = image.label.startsWith("antipode-")
        ? "antipode"
        : image.label.startsWith("control-")
          ? "control"
          : image.label;
      const seed = createHash("sha256")
        .update(`${session.renderer}:${visualClass}`, "utf8")
        .digest();
      const bytes = Buffer.alloc(image.byteLength);
      for (let index = 0; index < bytes.length; index++) {
        bytes[index] = seed[index % seed.length];
      }
      const digest = createHash("sha256").update(bytes).digest("hex");
      image.sha256 = digest;
      for (const observation of image.temporalStability.observations) {
        observation.byteLength = bytes.length;
        observation.sha256 = digest;
      }
      image.temporalStability.captureOutput.byteLength = bytes.length;
      image.temporalStability.captureOutput.sha256 = digest;
      const file = path.join(paths.directory, image.fileName);
      ownership.pngAuthorities.push(
        createC1229S5CustomImmutableAuthority(
          file,
          bytes,
          `${session.renderer} ${image.label} fixture PNG`,
        ),
      );
    }
  }
  assert.equal(ownership.pngAuthorities.length, 12);
  assert.equal(validateC1229S5CustomFinalArtifact(artifact).ok, true);
}

function errorArtifact(runId, message = "deliberate red") {
  return {
    schema: C12_29_S5_CUSTOM_SCHEMA,
    runId,
    status: "ERROR",
    incomplete: false,
    exitCode: 2,
    artifactName: `${runId}.json`,
    error: message,
    diagnostics: {
      schema: C12_29_S5_CUSTOM_DIAGNOSTICS_SCHEMA,
      renderer: "webgl",
      stage: "node",
      timeoutMs: 540_000,
      page: null,
    },
  };
}

function tempEvidenceDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "c1229-s5-custom-"));
}

function removeTempEvidenceDirectory(directory) {
  const resolved = path.resolve(directory);
  const tempRoot = path.resolve(os.tmpdir());
  assert.equal(resolved.startsWith(`${tempRoot}${path.sep}`), true);
  fs.rmSync(resolved, { recursive: true, force: true });
}

function operationsWith(overrides) {
  return new Proxy(fs, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return overrides[property];
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function assertOwnedRunning(paths, ownership) {
  assert.deepEqual(fs.readFileSync(paths.latest), ownership.runningBytes);
  assert.deepEqual(fs.readFileSync(paths.lock), ownership.lockBytes);
}

test("descriptor restoration deletes an inherited instrumentation override", () => {
  const originalUpdate = () => "original";
  const prototype = {};
  Object.defineProperty(prototype, "update", {
    value: originalUpdate,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  const target = Object.create(prototype);
  const receipt = captureC1229S5CustomPropertyDescriptor(target, "update");
  target.update = () => "instrumented";
  assert.equal(Object.hasOwn(target, "update"), true);

  const proof = restoreC1229S5CustomPropertyDescriptor(
    target,
    "update",
    receipt,
  );
  assert.deepEqual(proof, {
    hadOwnBefore: false,
    hasOwnAfter: false,
    ownerDepthBefore: 1,
    ownerDepthAfter: 1,
    ownerDescriptorBefore: {
      kind: "data",
      writable: true,
      enumerable: false,
      configurable: true,
    },
    ownerDescriptorAfter: {
      kind: "data",
      writable: true,
      enumerable: false,
      configurable: true,
    },
    preResolvedAuthorityExact: true,
    ownershipExact: true,
    ownDescriptorExact: true,
    targetPrototypeExact: true,
    prototypeChainExact: true,
    ownerDescriptorExact: true,
    resolvedIdentityExact: true,
    restored: true,
  });
  assert.equal(Object.hasOwn(target, "update"), false);
  assert.equal(target.update, originalUpdate);
});

test("descriptor restoration reinstates an exact original own descriptor", () => {
  const originalUpdate = () => "original";
  const target = {};
  const originalDescriptor = {
    value: originalUpdate,
    writable: true,
    enumerable: false,
    configurable: true,
  };
  Object.defineProperty(target, "update", originalDescriptor);
  const receipt = captureC1229S5CustomPropertyDescriptor(target, "update");
  Object.defineProperty(target, "update", {
    value: () => "instrumented",
    writable: false,
    enumerable: true,
    configurable: true,
  });

  const proof = restoreC1229S5CustomPropertyDescriptor(
    target,
    "update",
    receipt,
  );
  assert.equal(proof.restored, true);
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(target, "update"),
    originalDescriptor,
  );
  assert.equal(target.update, originalUpdate);
});

test("descriptor restoration exposes adversarial inherited identity drift", () => {
  const originalUpdate = () => "original";
  const replacementUpdate = () => "replacement";
  const prototype = { update: originalUpdate };
  const target = Object.create(prototype);
  const receipt = captureC1229S5CustomPropertyDescriptor(target, "update");
  target.update = () => "instrumented";
  prototype.update = replacementUpdate;

  const proof = restoreC1229S5CustomPropertyDescriptor(
    target,
    "update",
    receipt,
  );
  assert.equal(proof.ownershipExact, true);
  assert.equal(proof.ownDescriptorExact, true);
  assert.equal(proof.resolvedIdentityExact, false);
  assert.equal(proof.restored, false);
  assert.equal(Object.hasOwn(target, "update"), false);
  assert.equal(target.update, replacementUpdate);
});

test("descriptor capture rejects an own accessor without invoking it", () => {
  let getterCalls = 0;
  const target = {};
  Object.defineProperty(target, "update", {
    get() {
      getterCalls++;
      return () => undefined;
    },
    enumerable: false,
    configurable: true,
  });
  assert.throws(
    () => captureC1229S5CustomPropertyDescriptor(target, "update"),
    /must resolve through data/u,
  );
  assert.equal(getterCalls, 0);
});

test("restore overwrites a hostile own accessor before any resolved read", () => {
  const originalUpdate = () => "original";
  const target = {};
  Object.defineProperty(target, "update", {
    value: originalUpdate,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  const receipt = captureC1229S5CustomPropertyDescriptor(target, "update");
  let getterCalls = 0;
  Object.defineProperty(target, "update", {
    get() {
      getterCalls++;
      delete target.update;
      return originalUpdate;
    },
    enumerable: true,
    configurable: true,
  });

  const proof = restoreC1229S5CustomPropertyDescriptor(
    target,
    "update",
    receipt,
  );
  assert.equal(getterCalls, 0);
  assert.equal(proof.preResolvedAuthorityExact, true);
  assert.equal(proof.restored, true);
  assert.equal(target.update, originalUpdate);
});

test("pre-read authority check skips a hostile inherited getter", () => {
  const originalUpdate = () => "original";
  const prototype = {};
  Object.defineProperty(prototype, "update", {
    value: originalUpdate,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  const target = Object.create(prototype);
  const receipt = captureC1229S5CustomPropertyDescriptor(target, "update");
  target.update = () => "instrumented";
  let getterCalls = 0;
  Object.defineProperty(prototype, "update", {
    get() {
      getterCalls++;
      Object.defineProperty(prototype, "update", {
        value: originalUpdate,
        writable: true,
        enumerable: false,
        configurable: true,
      });
      return originalUpdate;
    },
    enumerable: false,
    configurable: true,
  });

  const proof = restoreC1229S5CustomPropertyDescriptor(
    target,
    "update",
    receipt,
  );
  assert.equal(getterCalls, 0);
  assert.equal(proof.preResolvedAuthorityExact, false);
  assert.equal(proof.ownerDescriptorExact, false);
  assert.equal(proof.resolvedIdentityExact, false);
  assert.equal(proof.restored, false);
});

test("same resolved function cannot hide target prototype replacement", () => {
  const originalUpdate = () => "original";
  const makePrototype = () => {
    const prototype = {};
    Object.defineProperty(prototype, "update", {
      value: originalUpdate,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    return prototype;
  };
  const originalPrototype = makePrototype();
  const replacementPrototype = makePrototype();
  const target = Object.create(originalPrototype);
  const receipt = captureC1229S5CustomPropertyDescriptor(target, "update");
  target.update = () => "instrumented";
  Object.setPrototypeOf(target, replacementPrototype);

  const proof = restoreC1229S5CustomPropertyDescriptor(
    target,
    "update",
    receipt,
  );
  assert.equal(proof.preResolvedAuthorityExact, false);
  assert.equal(proof.targetPrototypeExact, false);
  assert.equal(proof.prototypeChainExact, false);
  assert.equal(proof.restored, false);
});

test("descriptor capture fails closed on a Proxy target", () => {
  const target = new Proxy({ update() {} }, {});
  assert.throws(
    () => captureC1229S5CustomPropertyDescriptor(target, "update"),
    /must not be a Proxy/u,
  );
});

test("descriptor capture fails closed on a Proxy prototype authority", () => {
  const prototype = new Proxy({ update() {} }, {});
  const target = Object.create(prototype);
  assert.throws(
    () => captureC1229S5CustomPropertyDescriptor(target, "update"),
    /prototype must not be a Proxy/u,
  );
});

test("hostile setup throw still runs every registered cleanup", () => {
  const calls = [];
  const actions = [];
  let cleanup;
  assert.throws(() => {
    try {
      actions.push(
        {
          label: "Ellipsoid.default",
          restore() {
            calls.push("Ellipsoid.default");
            return true;
          },
        },
        {
          label: "moon.update",
          restore() {
            calls.push("moon.update");
            return true;
          },
        },
      );
      throw new Error("hostile setup throw");
    } finally {
      cleanup = runC1229S5CustomBestEffortCleanup(actions);
    }
  }, /hostile setup throw/u);
  assert.deepEqual(calls, ["moon.update", "Ellipsoid.default"]);
  assert.deepEqual(cleanup.attempted, ["moon.update", "Ellipsoid.default"]);
  assert.deepEqual(cleanup.failures, []);
});

test("hostile restoration and error hooks cannot skip later cleanup", () => {
  const calls = [];
  const cleanup = runC1229S5CustomBestEffortCleanup([
    {
      label: "Ellipsoid.default",
      restore() {
        calls.push("Ellipsoid.default");
        return true;
      },
    },
    {
      label: "moon.update",
      restore() {
        calls.push("moon.update");
        throw new Error("hostile restoration throw");
      },
      onError() {
        calls.push("moon.update:onError");
        throw new Error("hostile restoration error hook");
      },
    },
    {
      label: "moon.show",
      restore() {
        calls.push("moon.show");
        return true;
      },
    },
  ]);
  assert.deepEqual(calls, [
    "moon.show",
    "moon.update",
    "moon.update:onError",
    "Ellipsoid.default",
  ]);
  assert.deepEqual(cleanup.attempted, [
    "moon.show",
    "moon.update",
    "Ellipsoid.default",
  ]);
  assert.deepEqual(cleanup.failures, ["moon.update", "moon.update:onError"]);
});

test("viewer cleanup is LIFO, fail-closed, and cannot skip baseline restoration", () => {
  const calls = [];
  const cleanup = runC1229S5CustomBestEffortCleanup([
    {
      label: "Ellipsoid.default",
      restore() {
        calls.push("Ellipsoid.default");
        return true;
      },
    },
    {
      label: "viewer",
      restore() {
        calls.push("viewer");
        return false;
      },
    },
    {
      label: "moon.update",
      restore() {
        calls.push("moon.update");
        return true;
      },
    },
  ]);
  assert.deepEqual(calls, ["moon.update", "viewer", "Ellipsoid.default"]);
  assert.deepEqual(cleanup.attempted, [
    "moon.update",
    "viewer",
    "Ellipsoid.default",
  ]);
  assert.deepEqual(cleanup.failures, ["viewer"]);
});

test("contract freezes schemas, renderer order, nine phases, and six captures", () => {
  assert.equal(
    C12_29_S5_CUSTOM_SCHEMA,
    "c12-29-s5-custom-ellipsoid-evidence-v6",
  );
  assert.equal(
    C12_29_S5_CUSTOM_DIAGNOSTICS_SCHEMA,
    "c12-29-s5-custom-ellipsoid-runtime-diagnostics-v6",
  );
  assert.deepEqual(C12_29_S5_CUSTOM_RENDERERS, ["webgl", "webgpu"]);
  assert.equal(C12_29_S5_CUSTOM_PHASES.length, 9);
  assert.deepEqual(C12_29_S5_CUSTOM_PHASES, [
    "custom-scene-construction",
    "selected-terrain-preparation",
    "event-s5-off",
    "event-s5-on",
    "antipode-horizon-control",
    "behavioral-pick",
    "retained-capture",
    "noneclipse-identity-control",
    "session-cleanup",
  ]);
  assert.deepEqual(C12_29_S5_CUSTOM_CAPTURE_LABELS, [
    "event-off",
    "event-on",
    "antipode-off",
    "antipode-on",
    "control-off",
    "control-on",
  ]);
  assert.equal(
    C12_29_S5_CUSTOM_STABILITY_METHOD,
    "render-first-consecutive-fused-snapshots-v1",
  );
  assert.equal(C12_29_S5_CUSTOM_SCENE.minimumStableFrames, 3);
  assert.equal(C12_29_S5_CUSTOM_SCENE.maximumStabilityFrames, 60);
  assert.equal(C12_29_S5_CUSTOM_SCENE.cameraHeightMeters, 12_000_000);
});

test("source boundary is complete, ordered, unique, readable, and build-derived", () => {
  assert.equal(C12_29_S5_CUSTOM_SOURCE_FILES.length, 53);
  assert.equal(C12_29_S5_CUSTOM_BUILD_SOURCE_FILES.length, 46);
  assert.equal(
    new Set(C12_29_S5_CUSTOM_SOURCE_FILES).size,
    C12_29_S5_CUSTOM_SOURCE_FILES.length,
  );
  for (const file of C12_29_S5_CUSTOM_SOURCE_FILES) {
    if (file.endsWith("probe-c12-29-s5-custom-ellipsoid.mjs")) continue;
    assert.equal(fs.existsSync(path.join(root, file)), true, file);
  }
  assert.deepEqual(
    C12_29_S5_CUSTOM_BUILD_SOURCE_FILES,
    C12_29_S5_CUSTOM_SOURCE_FILES.filter(
      (file) =>
        !file.startsWith("Tools/") &&
        !file.endsWith(".glsl") &&
        !file.endsWith(".wgsl"),
    ),
  );
  for (const required of [
    "packages/engine/Source/Core/CustomHeightmapTerrainProvider.js",
    "packages/engine/Source/Core/CelestialEphemerisProvider.js",
    "packages/engine/Source/Core/Simon1994EphemerisProvider.js",
    "packages/engine/Source/Core/GeographicProjection.js",
    "packages/engine/Source/Renderer/AutomaticUniforms.js",
    "packages/engine/Source/Renderer/UniformStateComputations.js",
    "packages/engine/Source/Renderer/FeatureRendererKey.js",
    "packages/engine/Source/Renderer/WebGPU/WebGPUFeatureRenderers.ts",
    "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceCameraUB.ts",
    "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeEclipseUniforms.ts",
    "packages/engine/Source/Shaders/GlobeFS.glsl",
    "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
    "packages/engine/Source/Scene/Moon.js",
    "packages/widgets/Source/Viewer/Viewer.js",
    "Tools/visual-regression/lib/same-task-capture.mjs",
    "Tools/visual-regression/lib/build-source-identity.mjs",
  ]) {
    assert.ok(C12_29_S5_CUSTOM_SOURCE_FILES.includes(required), required);
  }
});

test("static oracle has no Earth constants or production eclipse oracle import", () => {
  assert.doesNotMatch(helperSource, /6378137|6356752/u);
  assert.doesNotMatch(
    helperSource,
    /from\s+["'][^"']*(?:EclipseGlobeShadow|Ellipsoid|Transforms)[^"']*["']/u,
  );
  assert.doesNotMatch(helperSource, /Ellipsoid\.WGS84/u);
});

test("custom scene freezes oblate axes, honest terrain, and exact UBO indices", () => {
  assert.deepEqual(C12_29_S5_CUSTOM_SCENE.radii, {
    x: 8_000_000,
    y: 8_000_000,
    z: 5_000_000,
  });
  assert.equal(C12_29_S5_CUSTOM_SCENE.heightMeters, 24_000);
  assert.equal(C12_29_S5_CUSTOM_SCENE.terrainWidth, 17);
  assert.equal(C12_29_S5_CUSTOM_SCENE.terrainHeight, 17);
  assert.deepEqual(C12_29_S5_CUSTOM_WEBGPU_CAMERA_INDICES, {
    inverseRadiiX: 51,
    inverseRadiiY: 55,
    inverseRadiiZ: 59,
    maximumRadius: 86,
  });
  assert.equal(C12_29_S5_CUSTOM_WEBGPU_ECLIPSE_BINDING, 2);
  assert.equal(C12_29_S5_CUSTOM_ECLIPSE_FLOATS, 16);
});

test("radius law includes skirt endpoint and max(relative, two metre) safety", () => {
  const result = computeC1229S5CustomSurfaceRadius({
    maximumRadius: 8_000_000,
    minimumHeight: 24_000,
    maximumHeight: 24_000,
  });
  assert.equal(result.unprotectedRadius, 8_024_000);
  assert.equal(result.safety, 8_024_000 * 8 * 2 ** -23);
  assert.equal(result.radius, result.unprotectedRadius + result.safety);
  assert.equal(
    computeC1229S5CustomSurfaceRadius({
      maximumRadius: 10,
      minimumHeight: 0,
      maximumHeight: 0,
    }).safety,
    2,
  );
});

test("radius-law mutants fail exact expected radius", () => {
  const expected = computeC1229S5CustomSurfaceRadius({
    maximumRadius: 8_000_000,
    minimumHeight: -24_000,
    maximumHeight: -24_000,
  });
  const noSkirt = 8_000_000 + 24_000 + (8_000_000 + 24_000) * 8 * 2 ** -23;
  const noSafety = expected.unprotectedRadius;
  assert.notEqual(noSkirt, expected.radius);
  assert.notEqual(noSafety, expected.radius);
});

test("independent f64 oblate ECEF resolves equator and pole", () => {
  const equator = customEllipsoidGeodeticToEcef({
    longitude: 0,
    latitude: 0,
    height: 24_000,
  });
  assert.deepEqual(equator, { x: 8_024_000, y: 0, z: 0 });
  const pole = customEllipsoidGeodeticToEcef({
    longitude: 1.2,
    latitude: Math.PI / 2,
    height: 24_000,
  });
  assert.ok(Math.abs(pole.x) < 1e-8);
  assert.ok(Math.abs(pole.y) < 1e-8);
  assert.ok(Math.abs(pole.z - 5_024_000) < 1e-8);
});

test("f32 ECEF is strict f32 and diverges detectably from f64 off-axis", () => {
  const cartographic = { longitude: 0.713, latitude: 0.432, height: 24_000 };
  const f64 = customEllipsoidGeodeticToEcef(cartographic, "f64");
  const f32 = customEllipsoidGeodeticToEcef(cartographic, "f32");
  for (const key of ["x", "y", "z"]) {
    assert.equal(f32[key], Math.fround(f32[key]));
  }
  assert.notDeepEqual(f32, f64);
});

test("f64 geometry tolerances derive from maxRadius times EPS and operation counts", () => {
  assert.equal(
    C12_29_S5_CUSTOM_GEOMETRY_EPSILON_METERS,
    8_000_000 * Number.EPSILON,
  );
  for (const [comparison, budget] of Object.entries(
    C12_29_S5_CUSTOM_GEOMETRY_OPERATION_BUDGETS,
  )) {
    const derivedTotal = Object.entries(budget)
      .filter(([key]) => key !== "total")
      .reduce((sum, [, count]) => sum + count, 0);
    assert.equal(budget.total, derivedTotal, comparison);
    assert.equal(
      c1229S5CustomGeometryTolerance(comparison, "meters"),
      C12_29_S5_CUSTOM_GEOMETRY_EPSILON_METERS * derivedTotal,
    );
  }
  const intersection = deriveC1229S5CustomAxisIntersection(alignedBodies());
  assert.ok(intersection);
  assert.ok(intersection.point.x > 0);
  assert.ok(intersection.point.x < alignedBodies().moon.x);
  assert.equal(intersection.direction.x, -1);
  assert.equal(intersection.point.y, 0);
  assert.equal(intersection.point.z, 0);
});

test("common-ray f32 packing rounds every one of sixteen values", () => {
  const input = {
    sun: { x: 149_600_000_000, y: 31_000_003, z: -17_000_009 },
    moon: { x: 384_400_000, y: -8_000_003, z: 4_000_007 },
    ...params(),
  };
  const f64 = packC1229S5CustomCommonRay(input, "f64");
  const f32 = packC1229S5CustomCommonRay(input, "f32");
  assert.equal(f64.length, 16);
  assert.ok(f32 instanceof Float32Array);
  assert.equal(f32.length, 16);
  for (let index = 0; index < f32.length; index++) {
    assert.equal(f32[index], Math.fround(f64[index]));
  }
  assert.equal(f32[8], 1);
  assert.equal(f32[12], Math.fround(0.00005));
});

test("aligned near-side sample eclipses while antipode is horizon rejected", () => {
  const payload64 = packC1229S5CustomCommonRay(alignedBodies(), "f64");
  const inverseRadii = { x: 1 / 8e6, y: 1 / 8e6, z: 1 / 5e6 };
  const near = evaluateC1229S5CustomFragment(
    {
      position: { x: 8_024_000, y: 0, z: 0 },
      inverseRadii,
      payload: payload64,
    },
    "f64",
  );
  const far = evaluateC1229S5CustomFragment(
    {
      position: { x: -8_024_000, y: 0, z: 0 },
      inverseRadii,
      payload: payload64,
    },
    "f64",
  );
  assert.ok(near.factor < 1);
  assert.equal(near.horizonRejected, false);
  assert.equal(far.factor, 1);
  assert.equal(far.horizonRejected, true);
});

test("oracle tolerance is derived only from f32 error and image quantization", () => {
  const sample = deriveC1229S5CustomOracleSample({
    cartographic: { longitude: 0, latitude: 0, height: 24_000 },
    offLuminance: 0.5,
    onLuminance: 0.25,
    ...alignedBodies(),
  });
  assert.ok(sample);
  assert.equal(
    sample.tolerance,
    4 * sample.f32Error + sample.quantizationBound,
  );
  assert.equal(
    sample.quantizationBound,
    (1 + sample.f64) / (255 * Math.max(0.5 - 1 / 255, 32 / 255)),
  );
  assert.equal(sample.observedFactor, 0.5);
});

test("cross-backend tolerance uses larger f32 error and both quantization bounds", () => {
  const result = deriveC1229S5CustomCrossBackend(
    { f32Error: 0.002, quantizationBound: 0.01, observedFactor: 0.5 },
    { f32Error: 0.004, quantizationBound: 0.02, observedFactor: 0.54 },
  );
  assert.equal(result.maximumF32Error, 0.004);
  assert.equal(result.quantizationBound, 0.03);
  assert.equal(result.tolerance, 4 * 0.004 + 0.03);
  assert.equal(result.withinTolerance, true);
  const mutant = deriveC1229S5CustomCrossBackend(
    { f32Error: 0, quantizationBound: 0, observedFactor: 0 },
    { f32Error: 0, quantizationBound: 0, observedFactor: 1 },
  );
  assert.equal(mutant.withinTolerance, false);
});

test("pure fold accepts the exact fully attested report", () => {
  const verdict = foldC1229S5CustomEllipsoidGate(passingReport());
  assert.equal(verdict.status, "PASS", JSON.stringify(verdict, null, 2));
  assert.equal(verdict.exitCode, 0);
  assert.equal(verdict.checks.phaseCountPerRenderer, 9);
  assert.equal(verdict.checks.captureCountPerRenderer, 6);
  for (const schema of [
    "c12-29-s5-custom-ellipsoid-evidence-v2",
    "c12-29-s5-custom-ellipsoid-evidence-v3",
    "c12-29-s5-custom-ellipsoid-evidence-v4",
  ]) {
    const legacyReport = passingReport();
    legacyReport.schema = schema;
    assert.equal(
      foldC1229S5CustomEllipsoidGate(legacyReport).status,
      "STRUCTURAL",
    );
  }
});

test("default-Simon fused lineage rejects declaration, vector, alias, and consumer mutants", () => {
  const frameNumber = 41;
  const iso = C12_29_S5_CUSTOM_SCENE.eventIso;
  const passing = fixtureEphemeris(frameNumber, iso);
  assert.equal(
    validateC1229S5CustomEphemerisLineage(passing, frameNumber, iso),
    true,
  );
  const mutants = [
    (value) => delete value.sample,
    (value) => (value.provider.constructor = "Object"),
    (value) => (value.provider.id = "wrong-provider"),
    (value) => (value.provider.revision = 1),
    (value) => (value.identities.sampleProvenanceIsProviderProvenance = false),
    (value) => (value.identities.sampleTimePolicyIsProviderTimePolicy = false),
    (value) => (value.provider.provenanceFrozen = false),
    (value) => (value.provider.timePolicyFrozen = false),
    (value) => delete value.provider.provenance.outputFrame,
    (value) => (value.provider.provenance.outputFrame = "ICRF"),
    (value) => delete value.provider.timePolicy.inputTimeScale,
    (value) => (value.provider.timePolicy.inputTimeScale = "UTC"),
    (value) => value.frameNumber++,
    (value) => (value.clockIso = C12_29_S5_CUSTOM_SCENE.controlIso),
    (value) => (value.sample.referenceFrame = "ICRF"),
    (value) => (value.sample.units = "kilometres"),
    (value) => (value.sample.transformBranch = "TEME"),
    (value) => (value.sample.outputAllocationStable = false),
    (value) => (value.sample.thirdPartyTemporaryFree = false),
    (value) => (value.sample.sunPositionWC.x = Number.NaN),
    (value) => (value.independent.sunPositionWC.x += 0.002),
    (value) => (value.independent.sunDeltaMeters = 1),
    (value) => (value.eclipseState.sunPositionWC.x += 1),
    (value) => (value.eclipseState.sunStorageDistinct = false),
    (value) => (value.consumers.uniformSunPositionWC.x += 1),
    (value) => (value.consumers.uniformSunStorageDistinct = false),
    (value) => (value.consumers.moonDirectionEC.y = 1),
    (value) => (value.consumers.moonDirectionStorageDistinct = false),
    (value) => (value.consumers.moonModelTranslation.x += 1),
    (value) => (value.consumers.moonModelStorageDistinct = false),
  ];
  for (const mutate of mutants) {
    const mutant = structuredClone(passing);
    mutate(mutant);
    assert.equal(
      validateC1229S5CustomEphemerisLineage(mutant, frameNumber, iso),
      false,
    );
  }
});

test("fused ephemeris frame binding and event sample ownership are load-bearing", () => {
  for (const mutate of [
    (report) =>
      report.sessions[0].images[0].temporalStability.observations[0].state
        .ephemeris.frameNumber++,
    (report) =>
      (report.sessions[0].images[1].temporalStability.captureState.ephemeris.clockIso =
        C12_29_S5_CUSTOM_SCENE.controlIso),
    (report) =>
      (report.sessions[0].phases["event-s5-on"].runtimeBodies.sun.x += 1),
  ]) {
    const report = passingReport();
    mutate(report);
    assert.notEqual(foldC1229S5CustomEllipsoidGate(report).status, "PASS");
  }
});

for (const [name, mutate, expected] of [
  [
    "Earth-shaped minor axis",
    (r) => (r.contract.radii.z = 6_356_752),
    "STRUCTURAL",
  ],
  ["renderer order", (r) => r.sessions.reverse(), "STRUCTURAL"],
  [
    "custom scene owner identity",
    (r) =>
      (r.sessions[0].phases["custom-scene-construction"].globe.sceneIdentity =
        false),
    "STRUCTURAL",
  ],
  [
    "custom widget default Moon was assumed",
    (r) =>
      (r.sessions[0].phases[
        "custom-scene-construction"
      ].moon.widgetDefaultAbsent = false),
    "STRUCTURAL",
  ],
  [
    "custom Moon was not explicitly constructed",
    (r) =>
      (r.sessions[0].phases[
        "custom-scene-construction"
      ].moon.explicitlyConstructed = false),
    "STRUCTURAL",
  ],
  [
    "custom Moon constructor export identity drift",
    (r) =>
      (r.sessions[0].phases[
        "custom-scene-construction"
      ].moon.servedConstructorIdentity = false),
    "STRUCTURAL",
  ],
  [
    "custom Moon Scene ownership drift",
    (r) =>
      (r.sessions[0].phases["custom-scene-construction"].moon.lifecycleOwner =
        "probe"),
    "STRUCTURAL",
  ],
  [
    "phase omission",
    (r) => delete r.sessions[0].phases["behavioral-pick"],
    "STRUCTURAL",
  ],
  [
    "direct updateForPick",
    (r) =>
      (r.sessions[0].phases["behavioral-pick"].directUpdateForPickCall = true),
    "FAIL",
  ],
  [
    "event OFF accidentally enabled",
    (r) => (r.sessions[0].phases["event-s5-off"].enabled = true),
    "FAIL",
  ],
  [
    "WebGL S5 payload drift",
    (r) =>
      (r.sessions[0].phases["event-s5-on"].shadowBlock.payloadExact = false),
    "FAIL",
  ],
  [
    "WebGL packed payload self-attestation",
    (r) =>
      (r.sessions[0].phases["event-s5-on"].shadowBlock.webglPackedF32[0] +=
        0.01),
    "FAIL",
  ],
  [
    "runtime shadow vector drift",
    (r) =>
      (r.sessions[0].phases[
        "event-s5-on"
      ].shadowBlock.sunDirectionAndInvRange.x += 0.01),
    "FAIL",
  ],
  [
    "inertial/fixed Sun disconnect",
    (r) =>
      (r.sessions[0].phases["event-s5-on"].runtimeBodies.sunInertial.y +=
        1_000_000),
    "FAIL",
  ],
  [
    "non-orthonormal ICRF transform",
    (r) =>
      (r.sessions[0].phases["event-s5-on"].runtimeBodies.icrfToFixed[0] = 2),
    "FAIL",
  ],
  [
    "event-axis f64 identity drift",
    (r) =>
      (r.sessions[0].phases[
        "event-s5-on"
      ].eventCentre.geometryIdentity.withinTolerance = false),
    "FAIL",
  ],
  [
    "pick radius drift",
    (r) =>
      (r.sessions[1].phases[
        "behavioral-pick"
      ].postcondition.after.surfaceRadius += 1),
    "FAIL",
  ],
  [
    "pick mini-frame begins with stale prepared memo",
    (r) => {
      const postcondition =
        r.sessions[1].phases["behavioral-pick"].postcondition;
      postcondition.before = structuredClone(postcondition.after);
    },
    "FAIL",
  ],
  [
    "pickable route not enabled",
    (r) => (r.sessions[1].phases["behavioral-pick"].pickableRequested = false),
    "FAIL",
  ],
  [
    "pick registry disconnect",
    (r) =>
      (r.sessions[1].phases["behavioral-pick"].pickIdRegistryOwnsGlobe = false),
    "FAIL",
  ],
  [
    "pick color mirror disconnect",
    (r) =>
      (r.sessions[1].phases["behavioral-pick"].pickColorMirrorExact = false),
    "FAIL",
  ],
  [
    "pickable flag not restored",
    (r) => (r.sessions[1].phases["behavioral-pick"].pickableRestored = false),
    "FAIL",
  ],
  [
    "pick promise did not settle",
    (r) => (r.sessions[1].phases["behavioral-pick"].settled = false),
    "FAIL",
  ],
  [
    "pick pump did not render",
    (r) => (r.sessions[1].phases["behavioral-pick"].renderPumpFrames = 0),
    "FAIL",
  ],
  [
    "pick pump exceeded its bound",
    (r) =>
      (r.sessions[1].phases["behavioral-pick"].renderPumpFrames =
        C12_29_S5_CUSTOM_SCENE.maximumPickPumpFrames + 1),
    "FAIL",
  ],
  [
    "pick pump bound self-attestation drift",
    (r) => (r.sessions[1].phases["behavioral-pick"].maximumPumpFrames -= 1),
    "FAIL",
  ],
  [
    "fractional updateForPick count",
    (r) => (r.sessions[1].phases["behavioral-pick"].updateForPickCalls = 1.5),
    "FAIL",
  ],
  [
    "updateForPick count exceeds pumped frames",
    (r) => (r.sessions[1].phases["behavioral-pick"].updateForPickCalls = 2),
    "FAIL",
  ],
  [
    "WebGPU camera radius drift",
    (r) =>
      (r.sessions[1].phases[
        "selected-terrain-preparation"
      ].backendIdentity.cameraUbo.valuesExact = false),
    "FAIL",
  ],
  [
    "WebGPU camera value drift behind green boolean",
    (r) =>
      (r.sessions[1].phases[
        "selected-terrain-preparation"
      ].backendIdentity.cameraUbo.values.maximumRadius += 1),
    "FAIL",
  ],
  [
    "WebGPU binding-2 offset drift",
    (r) =>
      (r.sessions[1].phases[
        "selected-terrain-preparation"
      ].backendIdentity.eclipseBinding.offsetAligned = false),
    "FAIL",
  ],
  [
    "WebGPU binding-2 payload drift behind green boolean",
    (r) =>
      (r.sessions[1].phases[
        "selected-terrain-preparation"
      ].backendIdentity.eclipseBinding.payload[0] += 0.01),
    "FAIL",
  ],
  [
    "WebGL served AutomaticUniforms evidence missing",
    (r) =>
      delete r.sessions[0].phases["selected-terrain-preparation"]
        .backendIdentity.automaticUniforms,
    "STRUCTURAL",
  ],
  [
    "WebGL served AutomaticUniforms identity forged",
    (r) =>
      (r.sessions[0].phases[
        "selected-terrain-preparation"
      ].backendIdentity.automaticUniforms.bundleExportIdentity = false),
    "FAIL",
  ],
  [
    "WebGL automatic radii drift",
    (r) =>
      (r.sessions[0].phases[
        "selected-terrain-preparation"
      ].backendIdentity.automaticUniforms.radiiExact = false),
    "FAIL",
  ],
  [
    "selected surface radius drift",
    (r) =>
      (r.sessions[0].phases["selected-terrain-preparation"].surfaceRadius += 1),
    "FAIL",
  ],
  [
    "antipodal shadow",
    (r) =>
      (r.sessions[0].phases["antipode-horizon-control"].offOnByteIdentical =
        false),
    "FAIL",
  ],
  [
    "antipode paired tuple drift",
    (r) =>
      (r.sessions[0].phases[
        "antipode-horizon-control"
      ].onPreparedTuple.selectionRevision += 1),
    "STRUCTURAL",
  ],
  [
    "control activity",
    (r) =>
      (r.sessions[1].phases["noneclipse-identity-control"].inactive = false),
    "FAIL",
  ],
  [
    "control paired tuple drift",
    (r) =>
      r.sessions[1].phases[
        "noneclipse-identity-control"
      ].onPreparedTuple.selectedTileIds.reverse(),
    "STRUCTURAL",
  ],
  [
    "retained face loss",
    (r) => (r.sessions[1].phases["retained-capture"].faceCount = 5),
    "FAIL",
  ],
  [
    "retained binding offset drift",
    (r) =>
      (r.sessions[1].phases["retained-capture"].eclipseBindingOffsetsExact =
        false),
    "FAIL",
  ],
  [
    "retained face/tile cardinality drift",
    (r) =>
      (r.sessions[1].phases["retained-capture"].faceTileCardinalityExact =
        false),
    "FAIL",
  ],
  [
    "retained binding payload drift",
    (r) =>
      (r.sessions[1].phases["retained-capture"].eclipseBindingPayloadsExact =
        false),
    "FAIL",
  ],
  [
    "retained payload array drift behind green boolean",
    (r) =>
      (r.sessions[1].phases["retained-capture"].eclipseBindingPayloads[0][0] +=
        0.01),
    "FAIL",
  ],
  [
    "boundary sample",
    (r) => (r.sessions[0].oracleSamples[0].boundaryAmbiguous = true),
    "FAIL",
  ],
  [
    "tile-interior pixel shortfall",
    (r) => (r.sessions[0].oracleSamples[0].boundaryDistancePixels = 0.5),
    "FAIL",
  ],
  [
    "derived sample identity drift",
    (r) => (r.sessions[0].oracleSamples[0].id = "arbitrary-joined-label"),
    "FAIL",
  ],
  [
    "cartographic/tile disconnect",
    (r) => (r.sessions[0].oracleSamples[0].tileId = "2/0/0"),
    "FAIL",
  ],
  [
    "tile UV self-attestation",
    (r) => (r.sessions[0].oracleSamples[0].tileUv[0] += 0.01),
    "FAIL",
  ],
  [
    "boundary minimum self-attestation",
    (r) => (r.sessions[0].oracleSamples[0].boundaryDistancePixels += 1),
    "FAIL",
  ],
  [
    "boundary primary geometry drift",
    (r) => (r.sessions[0].oracleSamples[0].tileBoundaryPixels[0].x += 1),
    "FAIL",
  ],
  [
    "primary off RGBA drift",
    (r) => (r.sessions[0].oracleSamples[0].offRgba[0] -= 1),
    "FAIL",
  ],
  [
    "primary runtime position drift",
    (r) => (r.sessions[0].oracleSamples[0].runtimePosition.x += 10),
    "FAIL",
  ],
  [
    "derived observed factor drift",
    (r) => (r.sessions[0].oracleSamples[0].observedFactor += 0.01),
    "FAIL",
  ],
  [
    "derived f64 factor drift",
    (r) => (r.sessions[0].oracleSamples[0].f64 += 0.01),
    "FAIL",
  ],
  [
    "derived tolerance drift",
    (r) => (r.sessions[0].oracleSamples[0].tolerance += 0.01),
    "FAIL",
  ],
  [
    "derived f32 class drift",
    (r) => (r.sessions[0].oracleSamples[0].classificationF32 = "clear"),
    "FAIL",
  ],
  [
    "oracle sample schema extension",
    (r) => (r.sessions[0].oracleSamples[0].untrustedClaim = true),
    "FAIL",
  ],
  [
    "sample ECEF identity drift",
    (r) =>
      (r.sessions[0].oracleSamples[0].geometryIdentity.withinTolerance = false),
    "FAIL",
  ],
  [
    "event sample PNG binding drift",
    (r) =>
      (r.sessions[0].oracleSamples[0].offMetricImageId =
        r.sessions[0].images[1].imageId),
    "FAIL",
  ],
  ["oracle class shortage", (r) => r.sessions[0].oracleSamples.pop(), "FAIL"],
  [
    "dim off sample",
    (r) => (r.sessions[0].oracleSamples[0].offLuminance = 31 / 255),
    "FAIL",
  ],
  [
    "cross-backend mismatch",
    (r) => (r.crossBackendOracle.allWithinDerivedTolerance = false),
    "FAIL",
  ],
  [
    "cross-backend arbitrary join id",
    (r) => (r.crossBackendOracle.samples[0].id = "arbitrary-cross-id"),
    "FAIL",
  ],
  [
    "XYS mismatch",
    (r) => (r.provenance.xys[0].served.sha256 = "b".repeat(64)),
    "STRUCTURAL",
  ],
  [
    "source-map entry drift",
    (r) => (r.provenance.buildSourceIdentity.start.entries[0].exact = false),
    "STRUCTURAL",
  ],
  [
    "served entry drift",
    (r) => (r.provenance.servedEntryIdentity.ok = false),
    "STRUCTURAL",
  ],
  [
    "served entry end drift",
    (r) => (r.provenance.servedEntryIdentity.localEnd.sha256 = "b".repeat(64)),
    "STRUCTURAL",
  ],
  [
    "same-task helper identity drift",
    (r) => (r.provenance.sameTaskCapture.helperPinned = false),
    "STRUCTURAL",
  ],
  [
    "geometry epsilon drift",
    (r) => (r.contract.geometryEpsilonMeters *= 2),
    "STRUCTURAL",
  ],
  ["phase reorder", (r) => r.sessions[0].phaseOrder.reverse(), "STRUCTURAL"],
  [
    "instrumentation ownership restoration drift",
    (r) =>
      (r.sessions[0].phases[
        "session-cleanup"
      ].instrumentationRestorations[0].hasOwnAfter = false),
    "STRUCTURAL",
  ],
  [
    "instrumentation descriptor restoration drift",
    (r) =>
      (r.sessions[1].phases[
        "session-cleanup"
      ].instrumentationRestorations[0].ownDescriptorExact = false),
    "STRUCTURAL",
  ],
  [
    "instrumentation resolved identity drift",
    (r) =>
      (r.sessions[1].phases[
        "session-cleanup"
      ].instrumentationRestorations[1].resolvedIdentityExact = false),
    "STRUCTURAL",
  ],
  [
    "dual-field inherited ownership forgery",
    (r) => {
      const restoration =
        r.sessions[0].phases["session-cleanup"].instrumentationRestorations[1];
      restoration.hadOwnBefore = true;
      restoration.hasOwnAfter = true;
    },
    "STRUCTURAL",
  ],
  [
    "dual-field inherited owner-depth forgery",
    (r) => {
      const restoration =
        r.sessions[1].phases["session-cleanup"].instrumentationRestorations[0];
      restoration.ownerDepthBefore = 2;
      restoration.ownerDepthAfter = 2;
    },
    "STRUCTURAL",
  ],
  [
    "dual-field inherited descriptor-shape forgery",
    (r) => {
      const restoration =
        r.sessions[1].phases["session-cleanup"].instrumentationRestorations[1];
      restoration.ownerDescriptorBefore.enumerable = true;
      restoration.ownerDescriptorAfter.enumerable = true;
    },
    "STRUCTURAL",
  ],
  [
    "best-effort cleanup failure behind green instrumentation",
    (r) =>
      r.sessions[0].phases["session-cleanup"].cleanupFailures.push(
        "Ellipsoid.default",
      ),
    "STRUCTURAL",
  ],
  [
    "instrumentation restoration record omission",
    (r) =>
      r.sessions[1].phases["session-cleanup"].instrumentationRestorations.pop(),
    "STRUCTURAL",
  ],
  [
    "pending cleanup request",
    (r) => (r.cleanup.pendingRequests = 1),
    "STRUCTURAL",
  ],
  [
    "pick result is not globe",
    (r) => (r.sessions[0].phases["behavioral-pick"].resultKind = "model"),
    "FAIL",
  ],
  [
    "generated shader drift",
    (r) => (r.provenance.generatedShaders.start.globeTerrainExact = false),
    "STRUCTURAL",
  ],
  [
    "image/metric split",
    (r) =>
      (r.sessions[0].images[0].metricImageId = r.sessions[0].images[1].imageId),
    "STRUCTURAL",
  ],
  [
    "transient stability fingerprint",
    (r) =>
      (r.sessions[0].images[0].temporalStability.observations[1].sha256 =
        "b".repeat(64)),
    "STRUCTURAL",
  ],
  [
    "stale fused capture fingerprint",
    (r) =>
      (r.sessions[0].images[1].temporalStability.captureOutput.sha256 =
        "b".repeat(64)),
    "STRUCTURAL",
  ],
  [
    "gapped stability frame",
    (r) =>
      (r.sessions[0].images[2].temporalStability.observations[1].frameNumber += 2),
    "STRUCTURAL",
  ],
  [
    "gapped prepared selection epoch",
    (r) =>
      (r.sessions[0].images[2].temporalStability.observations[1].state.preparedTuple.selectionRevision += 1),
    "STRUCTURAL",
  ],
  [
    "non-immediate evidence frame",
    (r) => (r.sessions[0].images[3].temporalStability.captureFrameNumber += 1),
    "STRUCTURAL",
  ],
  [
    "camera changed inside stable window",
    (r) =>
      (r.sessions[0].images[4].temporalStability.observations[2].state.camera.positionWC[0] += 1),
    "STRUCTURAL",
  ],
  [
    "stable but wrong camera target",
    (r) => {
      for (const state of temporalStates(r.sessions[0].images[0])) {
        state.cameraTarget.longitude += 0.1;
      }
    },
    "STRUCTURAL",
  ],
  [
    "stable but geometrically false camera",
    (r) => {
      for (const state of temporalStates(r.sessions[0].images[1])) {
        state.camera.positionWC[0] += 1;
      }
    },
    "STRUCTURAL",
  ],
  [
    "prepared content changed inside stable window",
    (r) =>
      (r.sessions[1].images[2].temporalStability.observations[1].state.content[0].meshIdentity =
        "mesh-99"),
    "STRUCTURAL",
  ],
  [
    "stable content changed between OFF and ON",
    (r) => {
      for (const state of temporalStates(r.sessions[1].images[1])) {
        state.content[0].meshIdentity = "mesh-99";
      }
    },
    "STRUCTURAL",
  ],
  [
    "event ON stable window is inactive",
    (r) => {
      for (const state of temporalStates(r.sessions[0].images[1])) {
        state.eclipse.active = false;
        state.eclipse.params.x = 0;
      }
    },
    "STRUCTURAL",
  ],
  [
    "antipode ON stable window is spuriously active",
    (r) => {
      for (const state of temporalStates(r.sessions[0].images[3])) {
        state.eclipse.active = true;
        state.eclipse.params.x = 1;
      }
    },
    "STRUCTURAL",
  ],
  [
    "wrong provider behind stable output",
    (r) => {
      for (const state of temporalStates(r.sessions[1].images[3])) {
        state.provider.objectIdentity = false;
      }
    },
    "STRUCTURAL",
  ],
  [
    "stale control clock behind stable output",
    (r) => {
      for (const state of temporalStates(r.sessions[1].images[4])) {
        state.clockIso = C12_29_S5_CUSTOM_SCENE.eventIso;
      }
    },
    "STRUCTURAL",
  ],
  [
    "prepared tuple disconnected from capture",
    (r) => {
      for (const state of temporalStates(r.sessions[1].images[5])) {
        state.preparedTuple.selectionRevision += 1;
      }
    },
    "STRUCTURAL",
  ],
  [
    "reused prior capture frame window",
    (r) => {
      const stability = r.sessions[0].images[1].temporalStability;
      for (const observation of stability.observations) {
        observation.frameNumber -= 10;
      }
      stability.captureFrameNumber -= 10;
    },
    "STRUCTURAL",
  ],
  [
    "unbounded stability attempt count",
    (r) =>
      (r.sessions[0].images[0].temporalStability.attemptedFrames =
        C12_29_S5_CUSTOM_SCENE.maximumStabilityFrames + 1),
    "STRUCTURAL",
  ],
  [
    "capture did not render first",
    (r) => (r.sessions[0].images[0].temporalStability.renderFirst = false),
    "STRUCTURAL",
  ],
  [
    "null capture task token",
    (r) => (r.sessions[0].images[0].captureTaskToken = null),
    "STRUCTURAL",
  ],
  [
    "render and capture task token split",
    (r) =>
      (r.sessions[0].images[0].captureTaskToken =
        "20000000-0000-4000-8000-000000000001"),
    "STRUCTURAL",
  ],
  [
    "capture task token reused globally",
    (r) => {
      r.sessions[0].images[1].renderTaskToken =
        r.sessions[0].images[0].renderTaskToken;
      r.sessions[0].images[1].captureTaskToken =
        r.sessions[0].images[0].captureTaskToken;
    },
    "STRUCTURAL",
  ],
]) {
  test(`mutation: ${name} cannot pass`, () => {
    const report = passingReport();
    mutate(report);
    const verdict = foldC1229S5CustomEllipsoidGate(report);
    assert.equal(verdict.status, expected, JSON.stringify(verdict, null, 2));
  });
}

test("final artifact must reproduce the pure fold exactly", () => {
  const report = passingReport();
  const verdict = foldC1229S5CustomEllipsoidGate(report);
  const artifact = {
    ...report,
    status: verdict.status,
    exitCode: verdict.exitCode,
    artifactName: `${RUN_ID}.json`,
    reasons: {
      structural: verdict.structuralReasons,
      failures: verdict.failureReasons,
    },
    checks: verdict.checks,
  };
  assert.deepEqual(validateC1229S5CustomFinalArtifact(artifact), {
    ok: true,
    reasons: [],
  });
  for (const schema of [
    "c12-29-s5-custom-ellipsoid-evidence-v2",
    "c12-29-s5-custom-ellipsoid-evidence-v3",
    "c12-29-s5-custom-ellipsoid-evidence-v4",
  ]) {
    const legacyArtifact = structuredClone(artifact);
    legacyArtifact.schema = schema;
    assert.equal(validateC1229S5CustomFinalArtifact(legacyArtifact).ok, false);
  }
  const retained = JSON.parse(stableC1229S5CustomJson(artifact, 2));
  const retainedVerdict = foldC1229S5CustomEllipsoidGate(retained);
  assert.equal(
    retainedVerdict.status,
    "PASS",
    JSON.stringify(retainedVerdict, null, 2),
  );
  assert.deepEqual(validateC1229S5CustomFinalArtifact(retained), {
    ok: true,
    reasons: [],
  });
  artifact.checks.phaseCountPerRenderer = 8;
  assert.equal(validateC1229S5CustomFinalArtifact(artifact).ok, false);
});

test("ERROR artifact requires bounded schema/stage/renderer diagnostics", () => {
  const artifact = {
    schema: C12_29_S5_CUSTOM_SCHEMA,
    runId: RUN_ID,
    status: "ERROR",
    incomplete: false,
    exitCode: 2,
    artifactName: `${RUN_ID}.json`,
    error: "browser failed",
    diagnostics: {
      schema: C12_29_S5_CUSTOM_DIAGNOSTICS_SCHEMA,
      renderer: "webgpu",
      stage: "event-s5-on",
      timeoutMs: 240_000,
      page: {
        schema: C12_29_S5_CUSTOM_DIAGNOSTICS_SCHEMA,
        renderer: "webgpu",
        currentPhase: "event-s5-on",
        completedPhases: [
          "custom-scene-construction",
          "selected-terrain-preparation",
          "event-s5-off",
        ],
        step: "event-on-fused-snapshot",
        elapsedMs: 123,
      },
    },
  };
  assert.equal(validateC1229S5CustomFinalArtifact(artifact).ok, true);
  for (const schema of [
    "c12-29-s5-custom-ellipsoid-runtime-diagnostics-v2",
    "c12-29-s5-custom-ellipsoid-runtime-diagnostics-v3",
    "c12-29-s5-custom-ellipsoid-runtime-diagnostics-v4",
  ]) {
    const legacyDiagnostics = structuredClone(artifact);
    legacyDiagnostics.diagnostics.schema = schema;
    assert.equal(
      validateC1229S5CustomFinalArtifact(legacyDiagnostics).ok,
      false,
    );
  }
  artifact.diagnostics.renderer = "fake";
  assert.equal(validateC1229S5CustomFinalArtifact(artifact).ok, false);
});

test("ERROR diagnostics and prior-version finals are exact and fail closed", () => {
  const artifact = errorArtifact(RUN_ID);
  assert.equal(validateC1229S5CustomFinalArtifact(artifact).ok, true);
  for (const mutate of [
    (value) => (value.diagnostics = {}),
    (value) => (value.diagnostics.extra = true),
    (value) => delete value.diagnostics.timeoutMs,
    (value) => (value.diagnostics.timeoutMs = 1),
    (value) => (value.diagnostics.page = []),
    (value) => (value.diagnostics.__proto__ = { polluted: true }),
    (value) => (value.error = "x".repeat(65_537)),
  ]) {
    const mutant = structuredClone(artifact);
    mutate(mutant);
    assert.equal(validateC1229S5CustomFinalArtifact(mutant).ok, false);
  }
  const runtime = structuredClone(artifact);
  runtime.diagnostics = {
    schema: C12_29_S5_CUSTOM_DIAGNOSTICS_SCHEMA,
    renderer: "webgpu",
    stage: "event-s5-on",
    timeoutMs: 240_000,
    page: {
      schema: C12_29_S5_CUSTOM_DIAGNOSTICS_SCHEMA,
      renderer: "webgpu",
      currentPhase: "event-s5-on",
      completedPhases: [
        "custom-scene-construction",
        "selected-terrain-preparation",
        "event-s5-off",
      ],
      step: "event-on-fused-snapshot",
      elapsedMs: 123,
    },
  };
  assert.equal(validateC1229S5CustomFinalArtifact(runtime).ok, true);
  for (const mutate of [
    (value) => value.diagnostics.page.completedPhases.reverse(),
    (value) => delete value.diagnostics.page.step,
    (value) => (value.diagnostics.page.extra = 1),
    (value) => (value.diagnostics.page.elapsedMs = Number.NaN),
    (value) => (value.diagnostics.stage = "event-s5-off"),
    (value) => (value.diagnostics.page.completedPhases = new Array(3)),
    (value) => {
      value.diagnostics.stage = "preflight";
      value.diagnostics.page.currentPhase = "preflight";
      value.diagnostics.page.completedPhases = [...C12_29_S5_CUSTOM_PHASES];
      value.diagnostics.page.step = "start";
    },
    (value) => {
      value.diagnostics.stage = C12_29_S5_CUSTOM_PHASES[0];
      value.diagnostics.page.currentPhase = C12_29_S5_CUSTOM_PHASES[0];
      value.diagnostics.page.completedPhases = [...C12_29_S5_CUSTOM_PHASES];
      value.diagnostics.page.step = "constructing-explicit-custom-scene";
    },
    (value) => {
      value.diagnostics.page.step = "complete";
    },
    (value) => {
      value.diagnostics.page.completedPhases.push("event-s5-on");
    },
  ]) {
    const mutant = structuredClone(runtime);
    mutate(mutant);
    assert.equal(validateC1229S5CustomFinalArtifact(mutant).ok, false);
  }
  for (const version of ["v2", "v3", "v4"]) {
    const legacy = structuredClone(runtime);
    legacy.schema = `c12-29-s5-custom-ellipsoid-evidence-${version}`;
    legacy.diagnostics.schema = `c12-29-s5-custom-ellipsoid-runtime-diagnostics-${version}`;
    legacy.diagnostics.page.schema = `c12-29-s5-custom-ellipsoid-runtime-diagnostics-${version}`;
    assert.equal(validateC1229S5CustomPriorFinal(legacy), true);
    legacy.diagnostics.extra = true;
    assert.equal(validateC1229S5CustomPriorFinal(legacy), false);
  }
  let toJsonReads = 0;
  const hiddenToJson = structuredClone(artifact);
  Object.defineProperty(hiddenToJson, "toJSON", {
    value() {
      toJsonReads++;
      return { substituted: true };
    },
  });
  assert.equal(validateC1229S5CustomFinalArtifact(hiddenToJson).ok, false);
  assert.equal(toJsonReads, 0);
});

test("frozen v5 finals migrate to v6 without repairing malformed v5 evidence", () => {
  const failReport = passingReport();
  failReport.sessions[0].phases["behavioral-pick"].directUpdateForPickCall =
    true;
  const structuralReport = passingReport();
  structuralReport.cleanup.complete = false;
  const currentFinals = [
    passingArtifact(),
    finalArtifactFromReport(failReport),
    finalArtifactFromReport(structuralReport),
  ];
  assert.deepEqual(
    currentFinals.map((artifact) => artifact.status),
    ["PASS", "FAIL", "STRUCTURAL"],
  );

  for (const current of currentFinals) {
    const legacy = legacyV5Final(current);
    assert.equal(validateC1229S5CustomFinalArtifact(legacy).ok, false);
    assert.equal(validateC1229S5CustomPriorFinal(legacy), true, current.status);

    const extraTopologyKey = structuredClone(legacy);
    extraTopologyKey.sessions[0].phases[
      "custom-scene-construction"
    ].moon.extra = true;
    assert.equal(
      validateC1229S5CustomPriorFinal(extraTopologyKey),
      false,
      `${current.status}: extra topology key`,
    );

    const wrongConstructor = structuredClone(legacy);
    wrongConstructor.sessions[0].phases[
      "custom-scene-construction"
    ].moon.constructor = "_Moon";
    assert.equal(
      validateC1229S5CustomPriorFinal(wrongConstructor),
      false,
      `${current.status}: wrong frozen constructor`,
    );

    const missingIdentity = structuredClone(legacy);
    delete missingIdentity.sessions[0].phases["custom-scene-construction"].moon
      .servedConstructorIdentity;
    assert.equal(
      validateC1229S5CustomPriorFinal(missingIdentity),
      false,
      `${current.status}: missing served identity`,
    );
  }

  const v5BoundaryMutant = legacyV5Final(passingArtifact());
  const v5SourceAdditions = new Set([
    "packages/engine/Source/Core/CelestialEphemerisProvider.js",
    "packages/engine/Source/Core/Simon1994EphemerisProvider.js",
    "packages/engine/Source/Renderer/UniformStateComputations.js",
    "packages/engine/Source/Scene/Moon.js",
  ]);
  const v4SourceFiles = C12_29_S5_CUSTOM_SOURCE_FILES.filter(
    (file) => !v5SourceAdditions.has(file),
  );
  const v4BuildFiles = C12_29_S5_CUSTOM_BUILD_SOURCE_FILES.filter(
    (file) => !v5SourceAdditions.has(file),
  );
  v5BoundaryMutant.provenance.sourceBoundary.count = v4SourceFiles.length;
  v5BoundaryMutant.provenance.sourceBoundary.files = v4SourceFiles;
  v5BoundaryMutant.provenance.localFiles =
    v5BoundaryMutant.provenance.localFiles.filter((entry) =>
      v4SourceFiles.includes(entry.file),
    );
  for (const endpoint of ["start", "end"]) {
    v5BoundaryMutant.provenance.buildSourceIdentity[endpoint].entries =
      v5BoundaryMutant.provenance.buildSourceIdentity[endpoint].entries.filter(
        (entry) =>
          v4BuildFiles.some(
            (file) => entry.file === file || entry.file.endsWith(`/${file}`),
          ),
      );
  }
  v5BoundaryMutant.checks.sourceBoundaryCount = v4SourceFiles.length;
  v5BoundaryMutant.checks.buildSourceBoundaryCount = v4BuildFiles.length;
  assert.equal(validateC1229S5CustomPriorFinal(v5BoundaryMutant), false);

  const v5LineageMutant = legacyV5Final(passingArtifact());
  delete v5LineageMutant.sessions[0].images[0].temporalStability.observations[0]
    .state.ephemeris;
  assert.equal(validateC1229S5CustomPriorFinal(v5LineageMutant), false);

  for (const schema of [
    "c12-29-s5-custom-ellipsoid-evidence-v3",
    "c12-29-s5-custom-ellipsoid-evidence-v4",
  ]) {
    const earlier = legacyV5Final(passingArtifact());
    earlier.schema = schema;
    assert.equal(validateC1229S5CustomPriorFinal(earlier), true, schema);
  }

  const currentRuntimeError = errorArtifact(randomUUID());
  currentRuntimeError.diagnostics = {
    schema: C12_29_S5_CUSTOM_DIAGNOSTICS_SCHEMA,
    renderer: "webgpu",
    stage: "event-s5-on",
    timeoutMs: 240_000,
    page: {
      schema: C12_29_S5_CUSTOM_DIAGNOSTICS_SCHEMA,
      renderer: "webgpu",
      currentPhase: "event-s5-on",
      completedPhases: [
        "custom-scene-construction",
        "selected-terrain-preparation",
        "event-s5-off",
      ],
      step: "event-on-fused-snapshot",
      elapsedMs: 123,
    },
  };
  const v5Error = legacyV5Final(currentRuntimeError);
  assert.equal(validateC1229S5CustomPriorFinal(v5Error), true);
  for (const mutate of [
    (value) => (value.extra = true),
    (value) => (value.diagnostics.extra = true),
    (value) => (value.diagnostics.schema = C12_29_S5_CUSTOM_DIAGNOSTICS_SCHEMA),
    (value) =>
      (value.diagnostics.page.schema = C12_29_S5_CUSTOM_DIAGNOSTICS_SCHEMA),
  ]) {
    const mutant = structuredClone(v5Error);
    mutate(mutant);
    assert.equal(validateC1229S5CustomPriorFinal(mutant), false);
  }
});

test("status, UUID, and stable serialization utilities are exact", () => {
  assert.equal(isC1229S5CustomUuidV4(RUN_ID), true);
  assert.equal(isC1229S5CustomUuidV4(RUN_ID.replace("-42d3", "-52d3")), false);
  assert.deepEqual(
    ["PASS", "FAIL", "STRUCTURAL", "ERROR"].map(exitCodeForC1229S5CustomStatus),
    [0, 1, 2, 2],
  );
  assert.throws(() => exitCodeForC1229S5CustomStatus("RUNNING"));
  assert.equal(
    stableC1229S5CustomJson({ z: 1, a: { y: 2, b: 3 } }, 2),
    '{\n  "a": {\n    "b": 3,\n    "y": 2\n  },\n  "z": 1\n}\n',
  );
  let accessorReads = 0;
  const hostileValues = [
    Object.defineProperty({}, "hidden", { value: true }),
    Object.defineProperty({}, "value", {
      enumerable: true,
      get() {
        accessorReads++;
        throw new Error("accessor must not execute");
      },
    }),
    Object.assign({}, { [Symbol("hidden")]: true }),
    Object.create({ inherited: true }),
    new Array(1),
    { value: Number.NaN },
    new Proxy({}, {}),
  ];
  for (const value of hostileValues) {
    assert.throws(() => stableC1229S5CustomJson(value, 2));
  }
  assert.equal(accessorReads, 0);
  assert.equal(stableC1229S5CustomJson({ value: -0 }), '{"value":0}\n');
});

test("ERROR construction is bounded and hostile-error safe", () => {
  const oversized = createC1229S5CustomErrorArtifact(
    RUN_ID,
    new Error("x".repeat(70_000)),
  );
  assert.ok(oversized.error.length <= 65_536);
  assert.match(oversized.error, /COMPONENT_TRUNCATED/u);
  assert.deepEqual(validateC1229S5CustomFinalArtifact(oversized), {
    ok: true,
    reasons: [],
  });
  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error("hostile error accessor");
      },
    },
  );
  const retained = createC1229S5CustomErrorArtifact(RUN_ID, hostile);
  assert.equal(retained.error, "[custom-ellipsoid uninspectable error]");
  assert.deepEqual(validateC1229S5CustomFinalArtifact(retained), {
    ok: true,
    reasons: [],
  });

  const global = createC1229S5CustomErrorArtifact(
    RUN_ID,
    new AggregateError(
      Array.from(
        { length: 32 },
        (_, index) => new Error(`${index}:${"x".repeat(10_000)}`),
      ),
      "many failures",
    ),
  );
  assert.equal(global.error.length, 65_536);
  assert.match(global.error, /CUSTOM_ERROR_TRUNCATED/u);
});

test("recursive error rendering survives hostile child collections and labels shared causes", () => {
  const { proxy: revokedErrors, revoke } = Proxy.revocable([], {});
  revoke();
  assert.doesNotThrow(() =>
    boundedC1229S5CustomErrorText({
      name: "Error",
      message: "revoked children",
      errors: revokedErrors,
    }),
  );

  const throwingLength = new Proxy([], {
    get(target, key, receiver) {
      if (key === "length") throw new Error("hostile length");
      return Reflect.get(target, key, receiver);
    },
  });
  assert.doesNotThrow(() =>
    boundedC1229S5CustomErrorText({
      name: "Error",
      message: "hostile children",
      errors: throwingLength,
    }),
  );

  const shared = new Error("shared cleanup failure");
  const aggregate = new AggregateError([shared], "primary failure", {
    cause: shared,
  });
  const rendered = boundedC1229S5CustomErrorText(aggregate);
  assert.match(rendered, /error\.errors\[0\]: Error: shared cleanup failure/u);
  assert.match(
    rendered,
    /error\.cause: \[error reference -> error\.errors\[0\]\]/u,
  );

  const cycle = new Error("cycle root");
  cycle.cause = cycle;
  assert.match(
    boundedC1229S5CustomErrorText(cycle),
    /error\.cause: \[error reference -> error\]/u,
  );

  const oversizedPrimary = new Error(`primary:${"p".repeat(10_000)}`);
  const oversizedCleanup = new Error(`cleanup:${"c".repeat(10_000)}`);
  const oversizedCombined = combineC1229S5CustomPrimaryAndCleanup(
    oversizedPrimary,
    oversizedCleanup,
    "oversized combined failure",
  );
  const oversizedRendered = boundedC1229S5CustomErrorText(oversizedCombined);
  assert.match(oversizedRendered, /primary:/u);
  assert.match(oversizedRendered, /cleanup:/u);
  assert.equal(
    (oversizedRendered.match(/COMPONENT_TRUNCATED/gu) ?? []).length,
    2,
  );
});

test("cleanup aggregation preserves primary diagnostics and renders recursive causes", () => {
  const primary = new Error("measurement failed");
  primary.customDiagnostics = {
    schema: C12_29_S5_CUSTOM_DIAGNOSTICS_SCHEMA,
    renderer: "webgpu",
    stage: "event-s5-on",
    timeoutMs: 240_000,
    page: {
      schema: C12_29_S5_CUSTOM_DIAGNOSTICS_SCHEMA,
      renderer: "webgpu",
      currentPhase: "event-s5-on",
      completedPhases: [
        "custom-scene-construction",
        "selected-terrain-preparation",
        "event-s5-off",
      ],
      step: "event-on-fused-snapshot",
      elapsedMs: 123,
    },
  };
  const cleanup = new AggregateError(
    [new Error("page close failed"), new Error("context close failed")],
    "session cleanup failed",
  );
  const combined = combineC1229S5CustomPrimaryAndCleanup(
    primary,
    cleanup,
    "measurement and cleanup failed",
  );
  assert.equal(combined.cause, primary);
  assert.equal(combined.customDiagnostics, primary.customDiagnostics);
  const artifact = createC1229S5CustomErrorArtifact(RUN_ID, combined);
  assert.equal(artifact.diagnostics.renderer, "webgpu");
  assert.equal(artifact.diagnostics.stage, "event-s5-on");
  assert.match(artifact.error, /measurement failed/u);
  assert.match(artifact.error, /page close failed/u);
  assert.match(artifact.error, /context close failed/u);

  cleanup.retainCustomRunning = true;
  const retained = combineC1229S5CustomPrimaryAndCleanup(
    primary,
    cleanup,
    "retained cleanup",
  );
  assert.equal(retained.retainCustomRunning, true);
});

test("oversized launch failure finalizes exact ERROR and releases authority", async () => {
  const directory = tempEvidenceDirectory();
  try {
    const result = await runC1229S5CustomEllipsoidProbe({
      outputDirectory: directory,
      runId: randomUUID(),
      launchBrowser: async () => {
        throw new Error("x".repeat(70_000));
      },
    });
    assert.equal(result.artifact.status, "ERROR");
    assert.ok(result.artifact.error.length <= 65_536);
    assert.match(result.artifact.error, /COMPONENT_TRUNCATED/u);
    assert.equal(fs.existsSync(result.paths.lock), false);
    assert.deepEqual(
      fs.readFileSync(result.paths.latest),
      fs.readFileSync(result.paths.archive),
    );
  } finally {
    removeTempEvidenceDirectory(directory);
  }
});

test("ERROR publication aggregation preserves primary and hostile publication failures", () => {
  for (const publicationFailure of [
    "primitive publication failure",
    undefined,
    Object.freeze(new Error("frozen publication failure")),
  ]) {
    const primary = new Error("primary browser launch failure");
    const combined = combineC1229S5CustomPrimaryAndCleanup(
      primary,
      publicationFailure,
      "custom-ellipsoid probe and ERROR publication failed",
    );
    combined.retainCustomRunning = true;
    assert.ok(combined instanceof AggregateError);
    assert.equal(combined.cause, primary);
    assert.equal(combined.retainCustomRunning, true);
    const rendered = boundedC1229S5CustomErrorText(combined);
    assert.match(rendered, /primary browser launch failure/u);
    assert.match(
      rendered,
      publicationFailure === undefined
        ? /publication failed: cleanup failure: undefined/u
        : /publication failure/u,
    );
  }

  const { proxy: revokedArray, revoke } = Proxy.revocable([], {});
  revoke();
  const hostileIterableArray = new Proxy([], {
    get(target, key, receiver) {
      if (key === Symbol.iterator) {
        throw new Error("hostile cleanup iterator");
      }
      return Reflect.get(target, key, receiver);
    },
  });
  for (const hostileCleanup of [revokedArray, hostileIterableArray]) {
    const primary = new Error("primary publication failure");
    let combined;
    assert.doesNotThrow(() => {
      combined = combineC1229S5CustomPrimaryAndCleanup(
        primary,
        hostileCleanup,
        "hostile cleanup collection",
      );
    });
    assert.ok(combined instanceof AggregateError);
    assert.equal(combined.cause, primary);
    assert.equal(combined.errors.length, 2);
    assert.ok(combined.errors[1] instanceof Error);
    assert.match(
      boundedC1229S5CustomErrorText(combined),
      /hostile cleanup collection: cleanup failure/u,
    );
  }
});

test("source map proves every frozen production entry byte-for-byte", () => {
  const identity = inspectBuildSourceIdentity({
    sourceMapPath: path.join(root, "Build/CesiumUnminified/index.js.map"),
    sourceFiles: C12_29_S5_CUSTOM_BUILD_SOURCE_FILES.map((file) =>
      path.join(root, file),
    ),
  });
  assert.equal(identity.ok, true, identity.reasons.join("\n"));
  assert.equal(
    identity.entries.length,
    C12_29_S5_CUSTOM_BUILD_SOURCE_FILES.length,
  );
  assert.ok(identity.entries.every((entry) => entry.exact === true));
});

test("probe embeds the canonical fused one-snapshot capture and uses it exclusively", () => {
  assert.deepEqual(checkEmbeddedFusedSnapshotIsCanonical(probeSource), []);
  assert.deepEqual(checkFusedCaptureUsage(probeSource), []);
  assert.match(probeSource, /metricImageId: imageId/u);
  assert.match(
    probeSource,
    /createC1229S5CustomImmutableAuthority\(\s*file,\s*bytes,/u,
  );
});

test("every evidence capture follows a bounded render-first stable window", () => {
  assert.match(
    probeSource,
    /const \[observationSnapshot, observationFrame\] = await Promise\.all\(\[\s*captureSnapshot\(\),\s*Promise\.resolve\(\)\.then\(\(\) => \(\{\s*frameNumber: scene\.frameState\.frameNumber,\s*state: captureFrameState\(\),/u,
  );
  assert.match(
    probeSource,
    /stableWindow\.length < contract\.minimumStableFrames[\s\S]*?const \[evidenceSnapshot, evidenceFrameState\] = await Promise\.all\(\[[\s\S]*?captureSnapshot\(\),[\s\S]*?frameNumber: scene\.frameState\.frameNumber,[\s\S]*?state: captureFrameState\(\),[\s\S]*?evidenceFrame\.frameNumber === stableWindow\.at\(-1\)\.frameNumber \+ 1[\s\S]*?sameStableFrame\(stableWindow\.at\(-1\), evidenceFrame\)/u,
  );
  assert.match(
    probeSource,
    /right\.frameNumber === left\.frameNumber \+ 1[\s\S]*?rightRevision === leftRevision \+ 1[\s\S]*?JSON\.stringify\(stableComparableState\(left\.state\)\)[\s\S]*?JSON\.stringify\(stableComparableState\(right\.state\)\)/u,
  );
  assert.match(
    probeSource,
    /const observationBytes = decodePngDataUrl\(observation\.dataUrl\);[\s\S]*?sha256: sha256\(observationBytes\)/u,
  );
  assert.match(
    probeSource,
    /maximumStabilityFrames: C12_29_S5_CUSTOM_SCENE\.maximumStabilityFrames/u,
  );
});

test("new oracle/probe artifacts contain no Earth axes or production-oracle call", () => {
  for (const [name, source] of [
    ["helper", helperSource],
    ["probe", probeSource],
  ]) {
    assert.doesNotMatch(source, /6378137|6356752(?:\.314245179)?/u, name);
    assert.doesNotMatch(source, /Ellipsoid\.WGS84/u, name);
    assert.doesNotMatch(
      source,
      /(?:fitEclipseLimbDarkening|computeUniformObscuration|updateEclipseGlobeShadow)\s*\(/u,
      name,
    );
  }
});

test("custom Moon topology ignores function-name drift while preserving served identity", () => {
  class ServedMoon {
    update() {}
    destroy() {}
  }
  const moon = new ServedMoon();
  const scene = { moon };
  const topology = () => ({
    widgetDefaultAbsent: true,
    explicitlyConstructed: true,
    servedConstructorIdentity: moon.constructor === ServedMoon,
    sceneIdentity: scene.moon === moon,
    lifecycleOwner: "scene.moon",
    updateIsFunction: typeof moon.update === "function",
    destroyIsFunction: typeof moon.destroy === "function",
  });
  for (const bundledName of ["Moon", "_Moon", "a", "arbitrary-name"]) {
    Object.defineProperty(ServedMoon, "name", {
      configurable: true,
      value: bundledName,
    });
    assert.equal(validateC1229S5CustomMoonTopology(topology()), true);
  }

  class DifferentMoon {}
  const wrongIdentity = topology();
  wrongIdentity.servedConstructorIdentity = moon.constructor === DifferentMoon;
  assert.equal(validateC1229S5CustomMoonTopology(wrongIdentity), false);

  const passing = topology();
  for (const mutate of [
    (value) => (value.widgetDefaultAbsent = false),
    (value) => (value.explicitlyConstructed = false),
    (value) => (value.servedConstructorIdentity = false),
    (value) => (value.sceneIdentity = false),
    (value) => (value.lifecycleOwner = "probe"),
    (value) => (value.updateIsFunction = false),
    (value) => (value.destroyIsFunction = false),
    (value) => (value.assumedDefault = true),
  ]) {
    const mutant = structuredClone(passing);
    mutate(mutant);
    assert.equal(validateC1229S5CustomMoonTopology(mutant), false);
  }
});

test("probe uses the served bundle for browser modules, constructs every custom scene owner, and derives the axis", () => {
  assert.match(
    probeSource,
    /const C = await import\(contract\.runtimePath\);/u,
  );
  assert.doesNotMatch(
    probeSource,
    /import\s*\(\s*["']\/packages\/engine\/Source\//u,
  );
  assert.match(probeSource, /Object\.hasOwn\(C, "AutomaticUniforms"\)/u);
  assert.match(
    probeSource,
    /C\.AutomaticUniforms\.czm_ellipsoidRadii\.getValue\(\s*scene\.context\.uniformState,\s*\)/u,
  );
  assert.match(
    probeSource,
    /C\.AutomaticUniforms\.czm_ellipsoidInverseRadii\.getValue\(\s*scene\.context\.uniformState,\s*\)/u,
  );
  assert.match(
    probeSource,
    /served production bundle AutomaticUniforms export is missing or invalid/u,
  );
  assert.match(
    probeSource,
    /const globeRendererDescriptor =[\s\S]*?getFeatureRenderer\?\.\(C\.FeatureRendererKey\.GLOBE_SURFACE\)/u,
  );
  assert.match(
    probeSource,
    /const sceneCaptureSources =[\s\S]*?scene\.context\._webgpuSceneCaptureSources/u,
  );
  assert.match(
    probeSource,
    /const globeRenderer = sceneCaptureSources\?\.globeRenderer \?\? null/u,
  );
  assert.match(
    probeSource,
    /globeRenderer instanceof globeRendererDescriptor\.RendererClass/u,
  );
  assert.match(probeSource, /sceneCaptureSources\?\.tileProvider !== tp/u);
  assert.match(probeSource, /new C\.Ellipsoid\(\s*contract\.radii\.x,/u);
  assert.match(probeSource, /new C\.GeographicProjection\(ellipsoid\)/u);
  assert.match(probeSource, /new C\.GeographicTilingScheme\(\{\s*ellipsoid,/u);
  assert.match(
    probeSource,
    /new C\.CustomHeightmapTerrainProvider\(\{[\s\S]*?width: contract\.terrainWidth,[\s\S]*?height: contract\.terrainHeight,[\s\S]*?tilingScheme,/u,
  );
  assert.match(probeSource, /heights\.fill\(contract\.heightMeters\)/u);
  assert.match(probeSource, /const globe = new C\.Globe\(ellipsoid\)/u);
  assert.match(probeSource, /new C\.GridImageryProvider\(\{\s*tilingScheme,/u);
  assert.match(
    probeSource,
    /const widgetDefaultMoon = scene\.moon;[\s\S]*?widgetDefaultMoon !== undefined[\s\S]*?typeof C\.Moon !== "function"[\s\S]*?const moon = new C\.Moon\(\);[\s\S]*?scene\.moon = moon;/u,
  );
  assert.match(
    probeSource,
    /servedConstructorIdentity: moon\.constructor === C\.Moon,[\s\S]*?sceneIdentity: scene\.moon === moon,[\s\S]*?lifecycleOwner: "scene\.moon"/u,
  );
  assert.doesNotMatch(
    probeSource,
    /constructor:\s*moon\.constructor\.name|moonTopology\.constructor/u,
  );
  assert.match(
    probeSource,
    /const commonOptions = \{[\s\S]*?useDefaultRenderLoop: false,[\s\S]*?: new C\.Viewer\(container, commonOptions\);\s*registerCleanupAction\("viewer"/u,
  );
  assert.match(
    probeSource,
    /registerCleanupAction\("viewer", \(\) => \{[\s\S]*?viewer\.useDefaultRenderLoop = false;[\s\S]*?viewer\.destroy\(\);[\s\S]*?Reflect\.deleteProperty\(globalThis, "viewer"\)[\s\S]*?viewerCleanupState\.globalIdentityCleared[\s\S]*?\}\);\s*viewer\.useDefaultRenderLoop = false;\s*globalThis\.viewer = viewer;/u,
  );
  const sessionStart = probeSource.indexOf(
    "async function runC1229S5CustomBrowserSession(",
  );
  const sessionEnd = probeSource.indexOf(
    "async function closeBrowserOrThrow(",
    sessionStart,
  );
  const sessionSource = probeSource.slice(sessionStart, sessionEnd);
  assert.match(
    sessionSource,
    /const handleResponse = \(response\) => \{\s*if \(!acceptResponseTasks\) return;\s*observeResponseTask\(\s*Promise\.resolve\(\)\.then\(async \(\) => \{/u,
  );
  const sessionFinally = sessionSource.lastIndexOf("} finally {");
  const pageClose = sessionSource.indexOf(
    "pageClose = await closeC1229S5CustomResourceBounded(",
    sessionFinally,
  );
  const contextClose = sessionSource.indexOf(
    "contextClose = await closeC1229S5CustomResourceBounded(",
    pageClose,
  );
  const stopResponses = sessionSource.indexOf(
    "acceptResponseTasks = false;",
    contextClose,
  );
  const detachResponse = sessionSource.indexOf(
    "const off = page.off;",
    stopResponses,
  );
  const freezeResponses = sessionSource.indexOf(
    "const frozenResponseTasks = [...responseTasks];",
    detachResponse,
  );
  const drainResponses = sessionSource.indexOf(
    "responseDrain = await settleC1229S5CustomTasksBounded(",
    freezeResponses,
  );
  assert.ok(
    sessionFinally >= 0 &&
      pageClose > sessionFinally &&
      contextClose > pageClose &&
      stopResponses > contextClose &&
      detachResponse > stopResponses &&
      freezeResponses > detachResponse &&
      drainResponses > freezeResponses,
  );
  assert.match(
    probeSource,
    /catch \(publicationError\) \{\s*const combined = combineC1229S5CustomPrimaryAndCleanup\(\s*error,\s*publicationError,[\s\S]*?combined\.retainCustomRunning = true;\s*throw combined;/u,
  );
  assert.match(
    probeSource,
    /originalMoonUpdate\.apply\(this, args\);[\s\S]*?return undefined;/u,
  );
  assert.doesNotMatch(probeSource, /const moon = scene\.moon/u);
  assert.match(probeSource, /computeSunPositionInEarthInertialFrame/u);
  assert.match(probeSource, /computeMoonPositionInEarthInertialFrame/u);
  assert.match(
    probeSource,
    /captureInstrumentationDescriptor\(\s*moon,\s*"update",?\s*\)/u,
  );
  assert.match(
    probeSource,
    /installInstrumentationValue\(\s*"moon\.update",[\s\S]*?moonUpdateDescriptor/u,
  );
  assert.match(probeSource, /Reflect\.deleteProperty\(target, key\)/u);
  assert.match(
    probeSource,
    /Object\.defineProperty\(\s*target,\s*key,\s*receipt\.authority\.ownDescriptor,?\s*\)/u,
  );
  assert.match(
    probeSource,
    /const authorityBeforeResolvedRead = capturePropertyAuthorityState\([\s\S]*?const resolvedValueAfter = preResolvedAuthorityExact[\s\S]*?const authorityAfter = capturePropertyAuthorityState/u,
  );
  assert.match(
    probeSource,
    /finally \{[\s\S]*?attemptAllCleanup\(\);[\s\S]*?\}/u,
  );
  assert.match(
    probeSource,
    /for \(let index = cleanupActions\.length - 1; index >= 0; index--\)[\s\S]*?attemptCleanupAction/u,
  );
  assert.doesNotMatch(probeSource, /moon\.update = originalMoonUpdate/u);
  assert.doesNotMatch(
    probeSource,
    /eclipseManager\.prepare = originalEclipsePrepare/u,
  );
  assert.match(probeSource, /deriveAxisSurface\(eventBodies\)/u);
  assert.doesNotMatch(
    probeSource,
    /eventCentre\s*=\s*\{[^}]*longitude:\s*[-\d]/u,
  );
});

test("production carriers still expose the pinned custom radii and binding seams", () => {
  const automatic = fs.readFileSync(
    path.join(root, "packages/engine/Source/Renderer/AutomaticUniforms.js"),
    "utf8",
  );
  const camera = fs.readFileSync(
    path.join(
      root,
      "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceCameraUB.ts",
    ),
    "utf8",
  );
  const layout = fs.readFileSync(
    path.join(
      root,
      "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceLayouts.ts",
    ),
    "utf8",
  );
  const wgsl = fs.readFileSync(
    path.join(
      root,
      "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
    ),
    "utf8",
  );
  assert.match(
    automatic,
    /czm_ellipsoidRadii:[\s\S]*?return uniformState\.ellipsoid\.radii;/u,
  );
  assert.match(
    automatic,
    /czm_ellipsoidInverseRadii:[\s\S]*?return uniformState\.ellipsoid\.oneOverRadii;/u,
  );
  assert.match(camera, /data\[offset\+\+\] = ellipsoidInverseRadii\.x;/u);
  assert.match(camera, /data\[offset\+\+\] = ellipsoidInverseRadii\.y;/u);
  assert.match(camera, /data\[offset\+\+\] = ellipsoidInverseRadii\.z;/u);
  assert.match(
    camera,
    /data\[offset\+\+\] = ellipsoid\?\.maximumRadius \?\? 0\.0;/u,
  );
  assert.match(
    layout,
    /uniformBuffer\(2, Stage\.FRAGMENT, \{\s*hasDynamicOffset: true,\s*minBindingSize: ECLIPSE_UNIFORM_BYTES,/u,
  );
  assert.match(wgsl, /@group\(0\) @binding\(2\) var<uniform> eclipseUniforms/u);
  assert.match(
    wgsl,
    /camera\.ellipsoidInverseRadiiX[\s\S]*camera\.ellipsoidInverseRadiiY[\s\S]*camera\.ellipsoidInverseRadiiZ/u,
  );
});

test("frozen production sources bind the cleanup topology contract", () => {
  const scene = fs.readFileSync(
    path.join(root, "packages/engine/Source/Scene/Scene.js"),
    "utf8",
  );
  const moon = fs.readFileSync(
    path.join(root, "packages/engine/Source/Scene/Moon.js"),
    "utf8",
  );
  const widget = fs.readFileSync(
    path.join(root, "packages/engine/Source/Widget/CesiumWidget.js"),
    "utf8",
  );
  const tileProvider = fs.readFileSync(
    path.join(root, "packages/engine/Source/Scene/GlobeSurfaceTileProvider.js"),
    "utf8",
  );
  const eclipseManager = fs.readFileSync(
    path.join(
      root,
      "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeEclipseUniforms.ts",
    ),
    "utf8",
  );
  const captureRenderer = fs.readFileSync(
    path.join(
      root,
      "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts",
    ),
    "utf8",
  );
  assert.match(moon, /class Moon \{[\s\S]*?this\.show = options\.show/u);
  assert.match(moon, /\n {2}update\(frameState, depthRouteState\) \{/u);
  assert.match(
    widget,
    /if \(Ellipsoid\.WGS84\.equals\(ellipsoid\)\) \{\s*scene\.moon = new Moon\(\);\s*\}/u,
  );
  assert.match(
    scene,
    /const ownedResources = \[[\s\S]*?"sun",\s*"moon",[\s\S]*?\];/u,
  );
  assert.match(tileProvider, /\n {2}updateForPick\(frameState\) \{/u);
  assert.match(eclipseManager, /\n {2}prepare\(\s*device: GPUDevice,/u);
  assert.match(
    captureRenderer,
    /\n {2}getOrCreateCaptureTileCommands\(\s*tile: \{/u,
  );
});

test("probe uses real pickAsync and observes rather than directly invokes updateForPick", () => {
  assert.match(probeSource, /const operation = scene\.pickAsync\(/u);
  assert.match(
    probeSource,
    /Object\.defineProperty\(globe, "pickable", \{[\s\S]*?value: true/u,
  );
  assert.match(
    probeSource,
    /scene\.context\?\._pickObjects\?\.get\(pickIdKey\)/u,
  );
  assert.match(probeSource, /pickProvider\._webgpuGlobePickColor/u);
  assert.match(
    probeSource,
    /installInstrumentationValue\(\s*"pickProvider\.updateForPick"/u,
  );
  assert.match(
    probeSource,
    /finally \{\s*attemptCleanupAction\(updateForPickCleanup\);\s*attemptCleanupAction\(pickableCleanup\);/u,
  );
  assert.match(probeSource, /originalUpdateForPick\.apply\(this, args\)/u);
  assert.doesNotMatch(
    probeSource,
    /(?:pickProvider|tileProvider\(\))\.updateForPick\s*\(/u,
  );
});

test("probe retains the real manager-driven six-face WebGPU path", () => {
  assert.match(probeSource, /model\.environmentMapManager/u);
  assert.match(probeSource, /manager\.enableSceneCapture = true;/u);
  assert.match(probeSource, /manager\.reset\(\);/u);
  assert.match(probeSource, /const captureCommandsWrapper = function/u);
  assert.match(
    probeSource,
    /installInstrumentationValue\(\s*"captureGlobeRenderer\.getOrCreateCaptureTileCommands"/u,
  );
  assert.match(probeSource, /const uniqueViews = new Set/u);
  assert.match(probeSource, /lastSceneCaptureResult === 2/u);
  assert.match(probeSource, /offsets\.length === 3/u);
  assert.doesNotMatch(probeSource, /runWebGPUSceneCapture\s*\(/u);
});

test("loopback transport rejects credentials, paths, search, and external hosts", () => {
  assert.equal(
    validateC1229S5CustomLoopbackBase("http://localhost:8080").origin,
    "http://localhost:8080",
  );
  assert.equal(
    validateC1229S5CustomLoopbackBase("https://[::1]").origin,
    "https://[::1]",
  );
  for (const value of [
    "https://example.com",
    "http://user:pass@localhost:8080",
    "http://localhost:8080/path",
    "http://localhost:8080/?x=1",
    "relative",
  ]) {
    assert.throws(() => validateC1229S5CustomLoopbackBase(value), value);
  }
});

test("evidence begin creates exclusive byte-exact lock and RUNNING latest", () => {
  const directory = tempEvidenceDirectory();
  try {
    const legacyRunId = randomUUID();
    const legacyArtifact = {
      schema: "c12-29-s5-custom-ellipsoid-evidence-v3",
      runId: legacyRunId,
      status: "ERROR",
      incomplete: false,
      exitCode: 2,
      artifactName: `${legacyRunId}.json`,
      error: "finalized legacy error",
      diagnostics: {
        schema: "c12-29-s5-custom-ellipsoid-runtime-diagnostics-v3",
        renderer: "webgl",
        stage: "node",
        timeoutMs: 540_000,
        page: null,
      },
    };
    const legacyBytes = Buffer.from(stableC1229S5CustomJson(legacyArtifact, 2));
    const runId = randomUUID();
    const paths = createC1229S5CustomArtifactPaths(runId, directory);
    const legacyArchive = path.join(directory, `${legacyRunId}.json`);
    fs.writeFileSync(legacyArchive, legacyBytes, { flag: "wx" });
    fs.writeFileSync(paths.latest, legacyBytes, { flag: "wx" });
    const ownership = beginC1229S5CustomEvidenceRun(paths, runId);
    assert.deepEqual(fs.readFileSync(paths.lock), ownership.lockBytes);
    assert.deepEqual(fs.readFileSync(paths.latest), ownership.runningBytes);
    assert.equal(ownership.running.schema, C12_29_S5_CUSTOM_SCHEMA);
    assert.deepEqual(fs.readFileSync(legacyArchive), legacyBytes);
    assert.throws(() => beginC1229S5CustomEvidenceRun(paths, randomUUID()));
  } finally {
    removeTempEvidenceDirectory(directory);
  }
});

test("run, path, and ownership binding fails before any foreign publication", () => {
  const directory = tempEvidenceDirectory();
  try {
    const runId = randomUUID();
    const foreignRunId = randomUUID();
    const nested = path.join(directory, "not-created");
    const unstartedPaths = createC1229S5CustomArtifactPaths(runId, nested);
    assert.throws(
      () => beginC1229S5CustomEvidenceRun(unstartedPaths, foreignRunId),
      /path is not bound to run/u,
    );
    assert.equal(fs.existsSync(nested), false);

    const paths = createC1229S5CustomArtifactPaths(runId, directory);
    const ownership = beginC1229S5CustomEvidenceRun(paths, runId);
    assert.throws(
      () =>
        finalizeC1229S5CustomEvidence(
          paths,
          errorArtifact(foreignRunId),
          ownership,
        ),
      /path is not bound to run|ownership binding is invalid/u,
    );
    assert.equal(
      fs.existsSync(path.join(directory, `${foreignRunId}.json`)),
      false,
    );
    assert.equal(fs.existsSync(paths.archive), false);
    assertOwnedRunning(paths, ownership);

    ownership.runId = foreignRunId;
    assert.throws(
      () =>
        finalizeC1229S5CustomEvidence(paths, errorArtifact(runId), ownership),
      /ownership binding is invalid/u,
    );
    assert.equal(fs.existsSync(paths.archive), false);
    assertOwnedRunning(paths, ownership);
  } finally {
    removeTempEvidenceDirectory(directory);
  }
});

test("stored predecessor authority cannot be removed or rebound", () => {
  const directory = tempEvidenceDirectory();
  try {
    const prior = errorArtifact(randomUUID(), "prior final");
    const priorBytes = Buffer.from(stableC1229S5CustomJson(prior, 2));
    const runId = randomUUID();
    const paths = createC1229S5CustomArtifactPaths(runId, directory);
    const priorArchive = path.join(directory, prior.artifactName);
    fs.writeFileSync(paths.latest, priorBytes, { flag: "wx" });
    fs.writeFileSync(priorArchive, priorBytes, { flag: "wx" });
    const ownership = beginC1229S5CustomEvidenceRun(paths, runId);
    ownership.priorArchiveAuthority = null;
    assert.throws(
      () =>
        finalizeC1229S5CustomEvidence(paths, errorArtifact(runId), ownership),
      /ownership binding is invalid/u,
    );
    assert.equal(fs.existsSync(paths.archive), false);
    assertOwnedRunning(paths, ownership);
  } finally {
    removeTempEvidenceDirectory(directory);
  }
});

test("first-red requires its exact canonical immutable archive", () => {
  const directory = tempEvidenceDirectory();
  try {
    const priorRed = errorArtifact(randomUUID(), "retained first red");
    const priorRedBytes = Buffer.from(stableC1229S5CustomJson(priorRed, 2));
    const runId = randomUUID();
    const paths = createC1229S5CustomArtifactPaths(runId, directory);
    fs.writeFileSync(paths.firstRed, priorRedBytes, { flag: "wx" });
    assert.throws(
      () => beginC1229S5CustomEvidenceRun(paths, runId),
      /first-red immutable archive/u,
    );
    assert.equal(fs.existsSync(paths.lock), false);
    assert.equal(fs.existsSync(paths.latest), false);
    assert.deepEqual(fs.readFileSync(paths.firstRed), priorRedBytes);
    fs.writeFileSync(
      path.join(directory, priorRed.artifactName),
      priorRedBytes,
      { flag: "wx" },
    );
    const ownership = beginC1229S5CustomEvidenceRun(paths, runId);
    ownership.firstRedArchiveAuthority = ownership.firstRedAuthority;
    assert.throws(
      () =>
        finalizeC1229S5CustomEvidence(paths, errorArtifact(runId), ownership),
      /ownership binding is invalid/u,
    );
    assert.equal(fs.existsSync(paths.archive), false);
    assertOwnedRunning(paths, ownership);
  } finally {
    removeTempEvidenceDirectory(directory);
  }
});

test("evidence begin rejects noncanonical prior latest and first-red bytes", () => {
  for (const target of ["latest", "firstRed"]) {
    const directory = tempEvidenceDirectory();
    try {
      const prior = errorArtifact(randomUUID(), "prior red");
      const noncanonicalBytes = Buffer.from(
        ` ${stableC1229S5CustomJson(prior, 2)}`,
      );
      const runId = randomUUID();
      const paths = createC1229S5CustomArtifactPaths(runId, directory);
      fs.writeFileSync(paths[target], noncanonicalBytes, { flag: "wx" });
      assert.throws(
        () => beginC1229S5CustomEvidenceRun(paths, runId),
        /exact canonical/u,
      );
      assert.deepEqual(fs.readFileSync(paths[target]), noncanonicalBytes);
      assert.equal(fs.existsSync(paths.lock), false);
    } finally {
      removeTempEvidenceDirectory(directory);
    }
  }
});

test("evidence begin rejects a canonical PASS masquerading as first-red", () => {
  const directory = tempEvidenceDirectory();
  try {
    const passBytes = Buffer.from(
      stableC1229S5CustomJson(passingArtifact(), 2),
    );
    const runId = randomUUID();
    const paths = createC1229S5CustomArtifactPaths(runId, directory);
    fs.writeFileSync(paths.firstRed, passBytes, { flag: "wx" });
    assert.throws(
      () => beginC1229S5CustomEvidenceRun(paths, runId),
      /first-red is not an exact canonical red final/u,
    );
    assert.deepEqual(fs.readFileSync(paths.firstRed), passBytes);
    assert.equal(fs.existsSync(paths.lock), false);
  } finally {
    removeTempEvidenceDirectory(directory);
  }
});

test("evidence begin requires the prior latest's exact immutable archive", () => {
  for (const mutation of ["missing", "mismatched"]) {
    const directory = tempEvidenceDirectory();
    try {
      const prior = errorArtifact(randomUUID(), "prior final");
      const priorBytes = Buffer.from(stableC1229S5CustomJson(prior, 2));
      const runId = randomUUID();
      const paths = createC1229S5CustomArtifactPaths(runId, directory);
      const priorArchive = path.join(directory, prior.artifactName);
      fs.writeFileSync(paths.latest, priorBytes, { flag: "wx" });
      if (mutation === "mismatched") {
        fs.writeFileSync(priorArchive, Buffer.from("foreign archive"), {
          flag: "wx",
        });
      }
      assert.throws(
        () => beginC1229S5CustomEvidenceRun(paths, runId),
        /prior latest immutable archive/u,
      );
      assert.deepEqual(fs.readFileSync(paths.latest), priorBytes);
      assert.equal(fs.existsSync(paths.lock), false);
      if (mutation === "mismatched") {
        assert.deepEqual(
          fs.readFileSync(priorArchive),
          Buffer.from("foreign archive"),
        );
      }
    } finally {
      removeTempEvidenceDirectory(directory);
    }
  }
});

test("prior immutable archive rejects hard links and symbolic-link descriptors", () => {
  for (const mutation of ["hardlink", "symlink-descriptor"]) {
    const directory = tempEvidenceDirectory();
    try {
      const prior = errorArtifact(randomUUID(), "prior final");
      const priorBytes = Buffer.from(stableC1229S5CustomJson(prior, 2));
      const runId = randomUUID();
      const paths = createC1229S5CustomArtifactPaths(runId, directory);
      const priorArchive = path.join(directory, prior.artifactName);
      fs.writeFileSync(paths.latest, priorBytes, { flag: "wx" });
      let operations = fs;
      if (mutation === "hardlink") {
        const backing = path.join(directory, "prior-backing.json");
        fs.writeFileSync(backing, priorBytes, { flag: "wx" });
        fs.linkSync(backing, priorArchive);
      } else {
        fs.writeFileSync(priorArchive, priorBytes, { flag: "wx" });
        operations = operationsWith({
          lstatSync(file, ...args) {
            const descriptor = fs.lstatSync(file, ...args);
            if (path.resolve(file) !== path.resolve(priorArchive)) {
              return descriptor;
            }
            return {
              dev: descriptor.dev,
              ino: descriptor.ino,
              mode: descriptor.mode,
              nlink: descriptor.nlink,
              size: descriptor.size,
              mtimeMs: descriptor.mtimeMs,
              ctimeMs: descriptor.ctimeMs,
              isFile: () => false,
              isSymbolicLink: () => true,
            };
          },
        });
      }
      assert.throws(
        () => beginC1229S5CustomEvidenceRun(paths, runId, operations),
        /prior latest immutable archive/u,
      );
      assert.deepEqual(fs.readFileSync(paths.latest), priorBytes);
      assert.equal(fs.existsSync(paths.lock), false);
    } finally {
      removeTempEvidenceDirectory(directory);
    }
  }
});

test("prior archive races fail closed before or after RUNNING publication", () => {
  for (const corruptOnArchiveRead of [2, 3, 4, 5, 6]) {
    const directory = tempEvidenceDirectory();
    try {
      const prior = errorArtifact(randomUUID(), "prior final");
      const priorBytes = Buffer.from(stableC1229S5CustomJson(prior, 2));
      const runId = randomUUID();
      const paths = createC1229S5CustomArtifactPaths(runId, directory);
      const priorArchive = path.join(directory, prior.artifactName);
      const foreign = Buffer.from(`foreign archive ${corruptOnArchiveRead}`);
      fs.writeFileSync(paths.latest, priorBytes, { flag: "wx" });
      fs.writeFileSync(priorArchive, priorBytes, { flag: "wx" });
      let archiveReads = 0;
      const operations = operationsWith({
        readFileSync(file, ...args) {
          if (path.resolve(file) === path.resolve(priorArchive)) {
            archiveReads += 1;
            if (archiveReads === corruptOnArchiveRead) {
              fs.writeFileSync(priorArchive, foreign);
            }
          }
          return fs.readFileSync(file, ...args);
        },
      });
      let thrown;
      try {
        beginC1229S5CustomEvidenceRun(paths, runId, operations);
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown);
      assert.match(String(thrown), /prior immutable archive/u);
      assert.deepEqual(fs.readFileSync(priorArchive), foreign);
      if (corruptOnArchiveRead <= 4) {
        assert.deepEqual(fs.readFileSync(paths.latest), priorBytes);
        assert.equal(fs.existsSync(paths.lock), false);
      } else {
        assert.equal(thrown.retainCustomRunning, true);
        assert.equal(fs.existsSync(paths.lock), true);
        assert.equal(
          JSON.parse(fs.readFileSync(paths.latest, "utf8")).status,
          "RUNNING",
        );
      }
    } finally {
      removeTempEvidenceDirectory(directory);
    }
  }
});

test("identical prior-archive substitutions fail every finalization boundary", () => {
  for (let substituteOnRead = 1; substituteOnRead <= 7; substituteOnRead++) {
    const directory = tempEvidenceDirectory();
    try {
      const prior = errorArtifact(randomUUID(), "prior final");
      const priorBytes = Buffer.from(stableC1229S5CustomJson(prior, 2));
      const artifact = passingArtifact();
      const paths = createC1229S5CustomArtifactPaths(artifact.runId, directory);
      const priorArchive = path.join(directory, prior.artifactName);
      fs.writeFileSync(paths.latest, priorBytes, { flag: "wx" });
      fs.writeFileSync(priorArchive, priorBytes, { flag: "wx" });
      const ownership = beginC1229S5CustomEvidenceRun(paths, artifact.runId);
      materializePassingArtifactPngs(paths, artifact, ownership);
      let priorReads = 0;
      const operations = operationsWith({
        readFileSync(file, ...args) {
          if (path.resolve(file) === path.resolve(priorArchive)) {
            priorReads += 1;
            if (priorReads === substituteOnRead) {
              fs.unlinkSync(priorArchive);
              fs.writeFileSync(priorArchive, priorBytes, { flag: "wx" });
            }
          }
          return fs.readFileSync(file, ...args);
        },
      });
      let thrown;
      try {
        finalizeC1229S5CustomEvidence(paths, artifact, ownership, operations);
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown, `boundary ${substituteOnRead}`);
      assert.match(String(thrown), /prior immutable archive/u);
      assert.equal(thrown.retainCustomRunning, true);
      assert.equal(priorReads, substituteOnRead);
      assert.deepEqual(fs.readFileSync(paths.latest), ownership.runningBytes);
      assert.deepEqual(fs.readFileSync(paths.lock), ownership.lockBytes);
      assert.deepEqual(fs.readFileSync(priorArchive), priorBytes);
    } finally {
      removeTempEvidenceDirectory(directory);
    }
  }
});

test("current archive failures occur before first-red and retain RUNNING", () => {
  for (const mutation of ["write-failure", "hardlink", "substitution"]) {
    const directory = tempEvidenceDirectory();
    try {
      const runId = randomUUID();
      const paths = createC1229S5CustomArtifactPaths(runId, directory);
      const ownership = beginC1229S5CustomEvidenceRun(paths, runId);
      const final = errorArtifact(runId, `archive ${mutation}`);
      let injected = false;
      const alias = path.join(directory, `${runId}.archive-alias.json`);
      const operations = operationsWith({
        writeFileSync(file, bytes, options) {
          if (
            !injected &&
            mutation === "write-failure" &&
            path.resolve(file) === path.resolve(paths.archive)
          ) {
            injected = true;
            const error = new Error("injected archive write failure");
            error.code = "EIO";
            throw error;
          }
          const result = fs.writeFileSync(file, bytes, options);
          if (
            !injected &&
            mutation === "hardlink" &&
            path.resolve(file) === path.resolve(paths.archive)
          ) {
            injected = true;
            fs.linkSync(paths.archive, alias);
          }
          return result;
        },
        readFileSync(file, ...args) {
          if (
            !injected &&
            mutation === "substitution" &&
            path.resolve(file) === path.resolve(paths.archive)
          ) {
            injected = true;
            const original = fs.readFileSync(paths.archive);
            const foreign = Buffer.from(original);
            foreign[0] ^= 1;
            fs.unlinkSync(paths.archive);
            fs.writeFileSync(paths.archive, foreign, { flag: "wx" });
          }
          return fs.readFileSync(file, ...args);
        },
      });
      assert.throws(() =>
        finalizeC1229S5CustomEvidence(paths, final, ownership, operations),
      );
      assert.equal(injected, true, mutation);
      assert.equal(fs.existsSync(paths.firstRed), false, mutation);
      assertOwnedRunning(paths, ownership);
    } finally {
      removeTempEvidenceDirectory(directory);
    }
  }
});

test("a hard-linked new first-red cannot reach canonical latest", () => {
  const directory = tempEvidenceDirectory();
  try {
    const runId = randomUUID();
    const paths = createC1229S5CustomArtifactPaths(runId, directory);
    const ownership = beginC1229S5CustomEvidenceRun(paths, runId);
    const alias = path.join(directory, `${runId}.first-red-alias.json`);
    let injected = false;
    const operations = operationsWith({
      writeFileSync(file, bytes, options) {
        const result = fs.writeFileSync(file, bytes, options);
        if (!injected && path.resolve(file) === path.resolve(paths.firstRed)) {
          injected = true;
          fs.linkSync(paths.firstRed, alias);
        }
        return result;
      },
    });
    assert.throws(() =>
      finalizeC1229S5CustomEvidence(
        paths,
        errorArtifact(runId),
        ownership,
        operations,
      ),
    );
    assert.equal(injected, true);
    assert.equal(fs.existsSync(paths.archive), true);
    assert.equal(fs.existsSync(paths.firstRed), true);
    assertOwnedRunning(paths, ownership);
  } finally {
    removeTempEvidenceDirectory(directory);
  }
});

test("all twelve PNG authorities fail closed before JSON publication", () => {
  for (const mutation of ["missing", "hardlink", "substitution"]) {
    const directory = tempEvidenceDirectory();
    try {
      const artifact = passingArtifact();
      const paths = createC1229S5CustomArtifactPaths(artifact.runId, directory);
      const ownership = beginC1229S5CustomEvidenceRun(paths, artifact.runId);
      materializePassingArtifactPngs(paths, artifact, ownership);
      const target = ownership.pngAuthorities[5];
      const alias = `${target.path}.alias`;
      let injected = false;
      let operations = fs;
      if (mutation === "missing") {
        fs.unlinkSync(target.path);
        injected = true;
      } else if (mutation === "hardlink") {
        fs.linkSync(target.path, alias);
        injected = true;
      } else {
        operations = operationsWith({
          readFileSync(file, ...args) {
            if (!injected && path.resolve(file) === path.resolve(target.path)) {
              injected = true;
              const foreign = Buffer.from(target.bytes);
              foreign[0] ^= 1;
              fs.unlinkSync(target.path);
              fs.writeFileSync(target.path, foreign, { flag: "wx" });
            }
            return fs.readFileSync(file, ...args);
          },
        });
      }
      assert.throws(() =>
        finalizeC1229S5CustomEvidence(paths, artifact, ownership, operations),
      );
      assert.equal(injected, true, mutation);
      assert.equal(fs.existsSync(paths.archive), false, mutation);
      assertOwnedRunning(paths, ownership);
    } finally {
      removeTempEvidenceDirectory(directory);
    }
  }
});

test("archive, latest, PNG, and first-red races fail at the unlock boundary", () => {
  for (const targetKind of ["archive", "latest", "png", "first-red"]) {
    const directory = tempEvidenceDirectory();
    try {
      const artifact = passingArtifact();
      const paths = createC1229S5CustomArtifactPaths(artifact.runId, directory);
      const ownership = beginC1229S5CustomEvidenceRun(paths, artifact.runId);
      materializePassingArtifactPngs(paths, artifact, ownership);
      const finalBytes = Buffer.from(stableC1229S5CustomJson(artifact, 2));
      const png = ownership.pngAuthorities[3];
      let latestPublished = false;
      let postPublicationReads = 0;
      let postPublicationLatestLstats = 0;
      let injected = false;
      const operations = operationsWith({
        writeFileSync(file, bytes, options) {
          const result = fs.writeFileSync(file, bytes, options);
          if (
            path.resolve(file) === path.resolve(paths.latest) &&
            Buffer.from(bytes).equals(finalBytes)
          ) {
            latestPublished = true;
          }
          return result;
        },
        lstatSync(file, ...args) {
          if (
            targetKind === "latest" &&
            latestPublished &&
            path.resolve(file) === path.resolve(paths.latest)
          ) {
            postPublicationLatestLstats += 1;
            if (!injected && postPublicationLatestLstats === 6) {
              injected = true;
              fs.unlinkSync(paths.latest);
              fs.writeFileSync(paths.latest, finalBytes, { flag: "wx" });
            }
          }
          return fs.lstatSync(file, ...args);
        },
        readFileSync(file, ...args) {
          const expectedTarget =
            targetKind === "archive"
              ? paths.archive
              : targetKind === "png"
                ? png.path
                : targetKind === "first-red"
                  ? paths.firstRed
                  : null;
          if (
            expectedTarget !== null &&
            latestPublished &&
            path.resolve(file) === path.resolve(expectedTarget)
          ) {
            postPublicationReads += 1;
            if (!injected && postPublicationReads === 2) {
              injected = true;
              if (targetKind === "first-red") {
                fs.writeFileSync(
                  paths.firstRed,
                  Buffer.from("late foreign red"),
                  {
                    flag: "wx",
                  },
                );
              } else {
                const retained = fs.readFileSync(expectedTarget);
                fs.unlinkSync(expectedTarget);
                fs.writeFileSync(expectedTarget, retained, { flag: "wx" });
              }
            }
          }
          return fs.readFileSync(file, ...args);
        },
      });
      let thrown;
      try {
        finalizeC1229S5CustomEvidence(paths, artifact, ownership, operations);
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown, targetKind);
      assert.equal(injected, true, targetKind);
      assert.equal(thrown.retainCustomRunning, true, targetKind);
      assert.equal(thrown.publicationRecovery?.ok, true, targetKind);
      assertOwnedRunning(paths, ownership);
      assert.deepEqual(fs.readFileSync(paths.recovery), finalBytes);
      if (targetKind === "first-red") {
        assert.deepEqual(
          fs.readFileSync(paths.firstRed),
          Buffer.from("late foreign red"),
        );
      }
    } finally {
      removeTempEvidenceDirectory(directory);
    }
  }
});

test("post-linearization replacement cannot revoke a completed unlock", () => {
  const directory = tempEvidenceDirectory();
  try {
    const prior = errorArtifact(randomUUID(), "prior final");
    const priorBytes = Buffer.from(stableC1229S5CustomJson(prior, 2));
    const artifact = passingArtifact();
    const paths = createC1229S5CustomArtifactPaths(artifact.runId, directory);
    const priorArchive = path.join(directory, prior.artifactName);
    fs.writeFileSync(paths.latest, priorBytes, { flag: "wx" });
    fs.writeFileSync(priorArchive, priorBytes, { flag: "wx" });
    const ownership = beginC1229S5CustomEvidenceRun(paths, artifact.runId);
    materializePassingArtifactPngs(paths, artifact, ownership);
    let substituted = false;
    const operations = operationsWith({
      unlinkSync(file) {
        const result = fs.unlinkSync(file);
        if (
          !substituted &&
          file.includes(".release-") &&
          file.endsWith(".receipt")
        ) {
          substituted = true;
          fs.unlinkSync(priorArchive);
          fs.writeFileSync(priorArchive, priorBytes, { flag: "wx" });
        }
        return result;
      },
    });
    finalizeC1229S5CustomEvidence(paths, artifact, ownership, operations);
    assert.equal(substituted, true);
    assert.equal(fs.existsSync(paths.lock), false);
    assert.equal(fs.existsSync(paths.recovery), false);
    assert.deepEqual(
      fs.readFileSync(paths.latest),
      fs.readFileSync(paths.archive),
    );
    assert.deepEqual(fs.readFileSync(priorArchive), priorBytes);
  } finally {
    removeTempEvidenceDirectory(directory);
  }
});

test("canonical claim restores a late foreign replacement instead of overwriting it", () => {
  const directory = tempEvidenceDirectory();
  try {
    const canonical = path.join(directory, "latest.json");
    const lock = path.join(directory, "lock.json");
    const expected = Buffer.from("expected");
    const foreign = Buffer.from("foreign");
    const lockBytes = Buffer.from("lock");
    fs.writeFileSync(canonical, expected, { flag: "wx" });
    fs.writeFileSync(lock, lockBytes, { flag: "wx" });
    let injected = false;
    const operations = operationsWith({
      renameSync(source, destination) {
        if (!injected && source === canonical) {
          injected = true;
          fs.writeFileSync(canonical, foreign);
        }
        return fs.renameSync(source, destination);
      },
    });
    assert.throws(() =>
      claimC1229S5CustomCanonical(
        canonical,
        expected,
        lock,
        lockBytes,
        "mutant",
        operations,
      ),
    );
    assert.deepEqual(fs.readFileSync(canonical), foreign);
    assert.deepEqual(fs.readFileSync(lock), lockBytes);
  } finally {
    removeTempEvidenceDirectory(directory);
  }
});

test("lock release is successor-safe after its linearization point", () => {
  const directory = tempEvidenceDirectory();
  try {
    const lock = path.join(directory, "lock.json");
    const owned = Buffer.from("owned");
    const foreign = Buffer.from("foreign");
    fs.writeFileSync(lock, owned, { flag: "wx" });
    let injected = false;
    const operations = operationsWith({
      renameSync(source, destination) {
        const result = fs.renameSync(source, destination);
        if (!injected && source === lock) {
          injected = true;
          fs.writeFileSync(lock, foreign, { flag: "wx" });
        }
        return result;
      },
    });
    assert.deepEqual(releaseC1229S5CustomLock(lock, owned, operations), {
      released: true,
      receiptRemoved: true,
    });
    assert.deepEqual(fs.readFileSync(lock), foreign);
    const receipts = fs
      .readdirSync(directory)
      .filter(
        (file) => file.includes(".release-") && file.endsWith(".receipt"),
      );
    assert.equal(receipts.length, 0);
  } finally {
    removeTempEvidenceDirectory(directory);
  }
});

test("successful finalization publishes byte-identical archive/latest then unlocks", () => {
  const directory = tempEvidenceDirectory();
  try {
    const artifact = passingArtifact();
    const paths = createC1229S5CustomArtifactPaths(artifact.runId, directory);
    const ownership = beginC1229S5CustomEvidenceRun(paths, artifact.runId);
    materializePassingArtifactPngs(paths, artifact, ownership);
    finalizeC1229S5CustomEvidence(paths, artifact, ownership);
    assert.deepEqual(
      fs.readFileSync(paths.archive),
      fs.readFileSync(paths.latest),
    );
    assert.equal(fs.existsSync(paths.lock), false);
    assert.equal(
      fs.readdirSync(directory).some((file) => file.endsWith(".receipt")),
      false,
    );
  } finally {
    removeTempEvidenceDirectory(directory);
  }
});

test("failed post-final receipt deletion quarantines final and restores RUNNING authority", () => {
  const directory = tempEvidenceDirectory();
  try {
    const artifact = passingArtifact();
    const paths = createC1229S5CustomArtifactPaths(artifact.runId, directory);
    const ownership = beginC1229S5CustomEvidenceRun(paths, artifact.runId);
    materializePassingArtifactPngs(paths, artifact, ownership);
    let failedOnce = false;
    const operations = operationsWith({
      unlinkSync(file) {
        if (
          !failedOnce &&
          file.includes(".final-") &&
          file.endsWith(".receipt")
        ) {
          failedOnce = true;
          const error = new Error("injected final receipt deletion failure");
          error.code = "EIO";
          throw error;
        }
        return fs.unlinkSync(file);
      },
    });
    let thrown;
    try {
      finalizeC1229S5CustomEvidence(paths, artifact, ownership, operations);
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown);
    assert.equal(thrown.retainCustomRunning, true);
    assert.deepEqual(fs.readFileSync(paths.latest), ownership.runningBytes);
    assert.deepEqual(fs.readFileSync(paths.lock), ownership.lockBytes);
    assert.deepEqual(
      fs.readFileSync(paths.recovery),
      fs.readFileSync(paths.archive),
    );
  } finally {
    removeTempEvidenceDirectory(directory);
  }
});

test("write-once first-red remains byte-identical across later red runs", () => {
  const directory = tempEvidenceDirectory();
  try {
    const firstRunId = randomUUID();
    const firstPaths = createC1229S5CustomArtifactPaths(firstRunId, directory);
    const firstOwnership = beginC1229S5CustomEvidenceRun(
      firstPaths,
      firstRunId,
    );
    finalizeC1229S5CustomEvidence(
      firstPaths,
      errorArtifact(firstRunId, "first red"),
      firstOwnership,
    );
    const firstBytes = fs.readFileSync(firstPaths.firstRed);
    const secondRunId = randomUUID();
    const secondPaths = createC1229S5CustomArtifactPaths(
      secondRunId,
      directory,
    );
    const secondOwnership = beginC1229S5CustomEvidenceRun(
      secondPaths,
      secondRunId,
    );
    const publication = finalizeC1229S5CustomEvidence(
      secondPaths,
      errorArtifact(secondRunId, "second red"),
      secondOwnership,
    );
    assert.equal(publication.firstRed.written, false);
    assert.deepEqual(fs.readFileSync(secondPaths.firstRed), firstBytes);
  } finally {
    removeTempEvidenceDirectory(directory);
  }
});

test("first-red appearing after an absent preflight is preserved and rejected", () => {
  const directory = tempEvidenceDirectory();
  try {
    const runId = randomUUID();
    const paths = createC1229S5CustomArtifactPaths(runId, directory);
    const ownership = beginC1229S5CustomEvidenceRun(paths, runId);
    const foreign = Buffer.from("foreign first-red authority");
    fs.writeFileSync(paths.firstRed, foreign, { flag: "wx" });
    assert.throws(
      () =>
        finalizeC1229S5CustomEvidence(paths, errorArtifact(runId), ownership),
      /first-red appeared after absent preflight/u,
    );
    assert.deepEqual(fs.readFileSync(paths.firstRed), foreign);
    assert.equal(fs.existsSync(paths.archive), false);
    assert.deepEqual(fs.readFileSync(paths.latest), ownership.runningBytes);
    assert.deepEqual(fs.readFileSync(paths.lock), ownership.lockBytes);
  } finally {
    removeTempEvidenceDirectory(directory);
  }
});

test("UUID-owned partial PNG cleanup removes exact bytes and preserves foreign replacements", () => {
  const directory = tempEvidenceDirectory();
  try {
    const ownedFile = path.join(
      directory,
      `${RUN_ID}.00000000-0000-4000-8000-000000000099.webgpu.event-on.png`,
    );
    const foreignFile = path.join(
      directory,
      `${RUN_ID}.00000000-0000-4000-8000-000000000100.webgpu.control-on.png`,
    );
    const absentFile = path.join(
      directory,
      `${RUN_ID}.00000000-0000-4000-8000-000000000101.webgpu.control-off.png`,
    );
    const owned = Buffer.from("owned-custom-png");
    const original = Buffer.from("original-custom-png");
    const foreign = Buffer.from("foreign-custom-png");
    const ownedAuthority = createC1229S5CustomImmutableAuthority(
      ownedFile,
      owned,
      "owned fixture PNG",
    );
    const foreignAuthority = createC1229S5CustomImmutableAuthority(
      foreignFile,
      original,
      "replaced fixture PNG",
    );
    const absentAuthority = createC1229S5CustomImmutableAuthority(
      absentFile,
      owned,
      "absent fixture PNG",
    );
    fs.unlinkSync(foreignFile);
    fs.writeFileSync(foreignFile, foreign, { flag: "wx" });
    fs.unlinkSync(absentFile);
    const result = cleanupC1229S5CustomOwnedPngs([
      ownedAuthority,
      foreignAuthority,
      absentAuthority,
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.removed, 1);
    assert.equal(fs.existsSync(ownedFile), false);
    assert.deepEqual(fs.readFileSync(foreignFile), foreign);
    assert.match(result.reasons.join("\n"), /foreign replacement preserved/u);
  } finally {
    removeTempEvidenceDirectory(directory);
  }
});

test("PNG cleanup restores a replacement racing its atomic claim", () => {
  const directory = tempEvidenceDirectory();
  try {
    const file = path.join(
      directory,
      `${RUN_ID}.00000000-0000-4000-8000-000000000102.webgpu.event-on.png`,
    );
    const owned = Buffer.from("owned-racing-custom-png");
    const foreign = Buffer.from("foreign-racing-custom-png");
    const authority = createC1229S5CustomImmutableAuthority(
      file,
      owned,
      "racing cleanup fixture PNG",
    );
    let injected = false;
    const operations = operationsWith({
      renameSync(source, destination) {
        if (!injected && path.resolve(source) === path.resolve(file)) {
          injected = true;
          fs.unlinkSync(file);
          fs.writeFileSync(file, foreign, { flag: "wx" });
        }
        return fs.renameSync(source, destination);
      },
    });
    const result = cleanupC1229S5CustomOwnedPngs([authority], operations);
    assert.equal(injected, true);
    assert.equal(result.ok, false);
    assert.equal(result.removed, 0);
    assert.deepEqual(fs.readFileSync(file), foreign);
    assert.equal(
      fs.readdirSync(directory).some((entry) => entry.endsWith(".receipt")),
      false,
    );
    assert.match(result.reasons.join("\n"), /replacement.*restored/u);
  } finally {
    removeTempEvidenceDirectory(directory);
  }
});

test("bounded close reports an uncooperative resource without hanging", async () => {
  const result = await closeC1229S5CustomResourceBounded(
    { close: () => new Promise(() => {}) },
    "hung",
    10,
  );
  assert.equal(result.closed, false);
  assert.equal(result.timedOut, true);
  for (const timeoutMs of [0, -1, 1.5, Number.MAX_VALUE]) {
    await assert.rejects(
      closeC1229S5CustomResourceBounded(undefined, "invalid", timeoutMs),
      /positive safe integer within the timer range/u,
    );
  }
});

test("browser close separates clean fulfillment from proven disconnection", async () => {
  let connected = true;
  const clean = await closeC1229S5CustomBrowserBounded({
    async close() {
      connected = false;
    },
    isConnected() {
      return connected;
    },
  });
  assert.equal(clean.closeFulfilled, true);
  assert.equal(clean.disconnectedProven, true);
  assert.equal(clean.closeClean, true);

  const rejectedButDisconnected = await closeC1229S5CustomBrowserBounded({
    async close() {
      throw new Error("close rejected after disconnect");
    },
    isConnected() {
      return false;
    },
  });
  assert.equal(rejectedButDisconnected.closeFulfilled, false);
  assert.equal(rejectedButDisconnected.disconnectedProven, true);
  assert.equal(rejectedButDisconnected.closeClean, false);

  let delayedConnected = true;
  let disconnectedListener;
  const delayed = await closeC1229S5CustomBrowserBounded(
    {
      async close() {
        setTimeout(() => {
          delayedConnected = false;
          disconnectedListener?.();
        }, 5);
        throw new Error("channel rejected before delayed disconnect");
      },
      isConnected() {
        return delayedConnected;
      },
      once(event, listener) {
        assert.equal(event, "disconnected");
        disconnectedListener = listener;
      },
      off(event, listener) {
        assert.equal(event, "disconnected");
        if (disconnectedListener === listener) disconnectedListener = undefined;
      },
    },
    100,
  );
  assert.equal(delayed.closeFulfilled, false);
  assert.equal(delayed.disconnectedProven, true);
  assert.equal(delayed.closeClean, false);
  assert.equal(disconnectedListener, undefined);

  for (const browser of [
    {
      async close() {},
      isConnected() {
        return true;
      },
    },
    {
      async close() {},
      isConnected() {
        throw new Error("hostile connection probe");
      },
    },
  ]) {
    const unproven = await closeC1229S5CustomBrowserBounded(browser);
    assert.equal(unproven.closeFulfilled, true);
    assert.equal(unproven.disconnectedProven, false);
    assert.equal(unproven.closeClean, false);
  }
});

test("response-task settlement observes rejection and bounds a hung body", async () => {
  const rejection = new Error("response body rejected");
  const settled = await settleC1229S5CustomTasksBounded(
    [Promise.resolve({ status: "rejected", error: rejection })],
    "response tasks",
    100,
  );
  assert.equal(settled.timedOut, false);
  assert.deepEqual(settled.errors, [rejection]);

  const timedOut = await settleC1229S5CustomTasksBounded(
    [new Promise(() => {})],
    "hung response tasks",
    10,
  );
  assert.equal(timedOut.timedOut, true);
  assert.match(timedOut.errors[0].message, /settlement expired/u);
  assert.equal(timedOut.errors[0].retainCustomRunning, true);

  const primitive = await settleC1229S5CustomTasksBounded(
    [Promise.resolve({ status: "rejected", error: "primitive rejection" })],
    "primitive response task",
    100,
  );
  assert.ok(primitive.errors[0] instanceof Error);
  assert.match(primitive.errors[0].message, /primitive rejection/u);

  for (const timeoutMs of [0, -1, 1.5, Number.MAX_VALUE]) {
    await assert.rejects(
      settleC1229S5CustomTasksBounded([], "invalid response tasks", timeoutMs),
      /positive safe integer within the timer range/u,
    );
  }

  let newContextCalls = 0;
  await assert.rejects(
    runC1229S5CustomBrowserSession(
      {
        async newContext() {
          newContextCalls += 1;
        },
      },
      "webgl",
      { origin: "http://localhost:8080" },
      RUN_ID,
      {},
      [],
      { renderer: null, page: null, pageDiagnostic: null },
      fs,
      Number.MAX_VALUE,
    ),
    /response-drain timeout must be a positive safe integer within the timer range/u,
  );
  assert.equal(newContextCalls, 0);
});

test("watchdog rejects at the deadline while owning cleanup and task drain", async () => {
  let finishTask;
  let finishCleanup;
  let taskSignal;
  const startedAt = Date.now();
  let watchdogError;
  try {
    await withC1229S5CustomWatchdog(
      (signal) => {
        taskSignal = signal;
        return new Promise((resolve) => {
          finishTask = resolve;
        });
      },
      () =>
        new Promise((resolve) => {
          finishCleanup = () =>
            resolve({ page: null, disconnectedProven: true });
        }),
      10,
    );
  } catch (error) {
    watchdogError = error;
  }
  assert.ok(watchdogError);
  assert.match(watchdogError.message, /watchdog expired/u);
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(taskSignal.aborted, true);
  assert.equal(watchdogError.retainCustomRunning, true);
  assert.equal(typeof watchdogError.c1229S5CustomDrain?.then, "function");
  let drainSettled = false;
  watchdogError.c1229S5CustomDrain.finally(() => {
    drainSettled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drainSettled, false);
  finishCleanup();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drainSettled, false);
  finishTask("late success");
  const drain = await watchdogError.c1229S5CustomDrain;
  assert.equal(drain.cleanupProven, true);
  assert.equal(drain.taskStatus, "fulfilled");
  assert.equal(watchdogError.retainCustomRunning, undefined);
  assert.match(String(watchdogError.cause), /fulfilled after watchdog/u);
});

test("watchdog is deadline-first under event-loop starvation", async () => {
  let taskSignal;
  let cleanupCalls = 0;
  let watchdogError;
  try {
    await withC1229S5CustomWatchdog(
      (signal) => {
        taskSignal = signal;
        const stop = process.hrtime.bigint() + BigInt(25_000_000);
        while (process.hrtime.bigint() < stop) {
          // Deliberately starve the timer queue past the monotonic deadline.
        }
        return "late success";
      },
      async () => {
        cleanupCalls += 1;
        return { page: null, disconnectedProven: true };
      },
      5,
    );
  } catch (error) {
    watchdogError = error;
  }
  assert.ok(watchdogError);
  assert.match(watchdogError.message, /watchdog expired/u);
  assert.equal(taskSignal.aborted, true);
  const drain = await watchdogError.c1229S5CustomDrain;
  assert.equal(cleanupCalls, 1);
  assert.equal(drain.cleanupProven, true);
  assert.equal(drain.taskStatus, "fulfilled");
  assert.match(String(watchdogError.cause), /fulfilled after watchdog/u);
});

test("watchdog drain has a terminal deadline when the task never settles", async () => {
  let watchdogError;
  const startedAt = Date.now();
  try {
    await withC1229S5CustomWatchdog(
      () => new Promise(() => {}),
      async () => ({ page: null, disconnectedProven: true }),
      1,
      "webgl",
      10,
    );
  } catch (error) {
    watchdogError = error;
  }
  assert.ok(watchdogError);
  const drain = await watchdogError.c1229S5CustomDrain;
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(drain.cleanupProven, false);
  assert.equal(drain.quiescenceProven, false);
  assert.equal(drain.taskStatus, "pending");
  assert.equal(watchdogError.retainCustomRunning, true);
  assert.match(String(watchdogError.cause), /drain expired/u);
});

test("watchdog rejects non-positive or fractional deadlines", async () => {
  for (const timeoutMs of [0, -1, 1.5, Number.MAX_VALUE]) {
    await assert.rejects(
      withC1229S5CustomWatchdog(
        async () => true,
        async () => {},
        timeoutMs,
      ),
      /positive safe integer/u,
    );
  }
});

test("watchdog rejects non-positive or fractional drain deadlines", async () => {
  for (const drainTimeoutMs of [0, -1, 1.5, Number.MAX_VALUE]) {
    await assert.rejects(
      withC1229S5CustomWatchdog(
        async () => true,
        async () => ({ disconnectedProven: true }),
        10,
        "webgl",
        drainTimeoutMs,
      ),
      /drain timeout must be a positive safe integer/u,
    );
  }
});

test("watchdog preserves deadline renderer and exact page progress", async () => {
  let renderer = "webgl";
  const page = {
    schema: C12_29_S5_CUSTOM_DIAGNOSTICS_SCHEMA,
    renderer: "webgl",
    currentPhase: "event-s5-on",
    completedPhases: C12_29_S5_CUSTOM_PHASES.slice(0, 3),
    step: "capturing-stable-window",
    elapsedMs: 1,
  };
  let watchdogError;
  try {
    await withC1229S5CustomWatchdog(
      (signal) =>
        new Promise((_, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              renderer = "webgpu";
              reject(signal.reason);
            },
            { once: true },
          );
        }),
      async () => ({ page, disconnectedProven: true }),
      1,
      () => renderer,
    );
  } catch (error) {
    watchdogError = error;
  }
  assert.ok(watchdogError);
  assert.equal(watchdogError.customDiagnostics.renderer, "webgl");
  const drain = await watchdogError.c1229S5CustomDrain;
  assert.equal(drain.cleanupProven, true);
  assert.deepEqual(watchdogError.customDiagnostics.page, page);
  assert.equal(watchdogError.customDiagnostics.stage, page.currentPhase);
  assert.equal(watchdogError.customDiagnostics.renderer, "webgl");
});

test("watchdog retains RUNNING when cleanup proof is red", async () => {
  let watchdogError;
  try {
    await withC1229S5CustomWatchdog(
      (signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
      async () => ({
        disconnectedProven: false,
        drainError: new Error("cleanup unproven"),
      }),
      1,
    );
  } catch (error) {
    watchdogError = error;
  }
  assert.ok(watchdogError);
  const drain = await watchdogError.c1229S5CustomDrain;
  assert.equal(drain.cleanupProven, false);
  assert.equal(watchdogError.retainCustomRunning, true);
  assert.match(String(watchdogError.cause), /cleanup unproven/u);
});

test("watchdog preserves cleanup error but releases RUNNING after proven disconnection", async () => {
  const closeError = new Error("browser close rejected after disconnect");
  let watchdogError;
  try {
    await withC1229S5CustomWatchdog(
      (signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
      async () => ({
        disconnectedProven: true,
        drainError: closeError,
      }),
      1,
    );
  } catch (error) {
    watchdogError = error;
  }
  assert.ok(watchdogError);
  const drain = await watchdogError.c1229S5CustomDrain;
  assert.equal(drain.cleanupProven, true);
  assert.equal(drain.quiescenceProven, true);
  assert.equal(watchdogError.retainCustomRunning, undefined);
  assert.equal(watchdogError.cause, closeError);
});

test("watchdog cannot clear a retain-marked late task after proven disconnection", async () => {
  const closeError = new Error("browser close rejected after disconnect");
  const pendingTaskError = new Error("response body remains unsettled");
  pendingTaskError.retainCustomRunning = true;
  let watchdogError;
  try {
    await withC1229S5CustomWatchdog(
      (signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(pendingTaskError), {
            once: true,
          });
        }),
      async () => ({
        disconnectedProven: true,
        drainError: closeError,
      }),
      1,
    );
  } catch (error) {
    watchdogError = error;
  }
  assert.ok(watchdogError);
  const drain = await watchdogError.c1229S5CustomDrain;
  assert.equal(drain.cleanupProven, true);
  assert.equal(drain.quiescenceProven, false);
  assert.equal(drain.taskStatus, "rejected");
  assert.equal(watchdogError.retainCustomRunning, true);
  assert.equal(drain.drainError.retainCustomRunning, true);
  const rendered = boundedC1229S5CustomErrorText(watchdogError);
  assert.match(rendered, /browser close rejected after disconnect/u);
  assert.match(rendered, /response body remains unsettled/u);
});

test("watchdog labels undefined cleanup and late-task rejections", async () => {
  for (const rejectionPoint of ["cleanup", "task"]) {
    let watchdogError;
    try {
      await withC1229S5CustomWatchdog(
        (signal) =>
          new Promise((_, reject) => {
            signal.addEventListener(
              "abort",
              () =>
                reject(rejectionPoint === "task" ? undefined : signal.reason),
              { once: true },
            );
          }),
        async () => {
          if (rejectionPoint === "cleanup") throw undefined;
          return { disconnectedProven: true };
        },
        1,
      );
    } catch (error) {
      watchdogError = error;
    }
    assert.ok(watchdogError);
    await watchdogError.c1229S5CustomDrain;
    const rendered = boundedC1229S5CustomErrorText(watchdogError);
    assert.match(
      rendered,
      rejectionPoint === "cleanup"
        ? /watchdog cleanup rejected: undefined/u
        : /late task rejected: undefined/u,
      rejectionPoint,
    );
  }
});

test("session setup failures preserve the primary and close every acquired resource", async () => {
  const failureMessages = {
    newContext: "hostile context primitive",
    route: "hostile route setup",
    newPage: "hostile page acquisition",
    addInitScript: "hostile init-script setup",
  };
  for (const failurePoint of [
    "newContext",
    "route",
    "newPage",
    "addInitScript",
  ]) {
    const directory = tempEvidenceDirectory();
    const runId = randomUUID();
    let connected = true;
    let contextClosed = false;
    let pageClosed = false;
    const page = {
      async addInitScript() {
        if (failurePoint === "addInitScript") {
          throw new Error("hostile init-script setup");
        }
      },
      on() {},
      async close() {
        pageClosed = true;
      },
    };
    const context = {
      async route() {
        if (failurePoint === "route") throw new Error("hostile route setup");
      },
      async newPage() {
        if (failurePoint === "newPage") {
          throw new Error("hostile page acquisition");
        }
        return page;
      },
      async close() {
        contextClosed = true;
      },
    };
    const browser = {
      async newContext() {
        if (failurePoint === "newContext") throw "hostile context primitive";
        return context;
      },
      async close() {
        connected = false;
      },
      isConnected() {
        return connected;
      },
    };
    try {
      let sessionError;
      try {
        await runC1229S5CustomBrowserSession(
          browser,
          "webgl",
          { origin: "http://localhost:8080" },
          runId,
          createC1229S5CustomArtifactPaths(runId, directory),
          [],
          { renderer: null, page: null, pageDiagnostic: null },
        );
      } catch (error) {
        sessionError = error;
      }
      assert.ok(sessionError, failurePoint);
      assert.match(
        boundedC1229S5CustomErrorText(sessionError),
        new RegExp(failureMessages[failurePoint], "u"),
        failurePoint,
      );
      assert.equal(contextClosed, failurePoint !== "newContext", failurePoint);
      assert.equal(pageClosed, failurePoint === "addInitScript", failurePoint);
      const browserClose = await closeC1229S5CustomBrowserBounded(browser);
      assert.equal(browserClose.closeClean, true, failurePoint);
      assert.equal(connected, false, failurePoint);
    } finally {
      removeTempEvidenceDirectory(directory);
    }
  }
});

test("close-time responses with hostile listener cleanup preserve primary and retain a pending body", async () => {
  const directory = tempEvidenceDirectory();
  const runId = randomUUID();
  let connected = true;
  let contextClosed = false;
  let pageClosed = false;
  let responseHandler;
  let queuedResponseHandler;
  let closeTimeBodyCalls = 0;
  const runtimeResponse = {
    url: () => "http://localhost:8080/Build/CesiumUnminified/index.js",
    status: () => 200,
    ok: () => true,
    body: () => new Promise(() => {}),
  };
  const closeTimeResponse = {
    url: () =>
      "http://localhost:8080/Build/CesiumUnminified/Assets/IAU2006_XYS/IAU2006_XYS_0.json",
    status: () => 200,
    body() {
      closeTimeBodyCalls += 1;
      return Promise.resolve(Buffer.from("{}"));
    },
  };
  const page = {
    async addInitScript() {},
    on(event, listener) {
      if (event === "response") responseHandler = listener;
    },
    get off() {
      throw new Error("hostile response off getter");
    },
    async goto() {
      queuedResponseHandler = responseHandler;
      queuedResponseHandler(runtimeResponse);
      throw new Error("hostile navigation after runtime response");
    },
    async evaluate() {
      return null;
    },
    async close() {
      queuedResponseHandler(closeTimeResponse);
      await Promise.resolve();
      pageClosed = true;
    },
  };
  const context = {
    async route() {},
    async newPage() {
      return page;
    },
    async close() {
      contextClosed = true;
    },
  };
  const browser = {
    async newContext() {
      return context;
    },
    async close() {
      connected = false;
    },
    isConnected() {
      return connected;
    },
  };
  try {
    let sessionError;
    try {
      await runC1229S5CustomBrowserSession(
        browser,
        "webgl",
        { origin: "http://localhost:8080" },
        runId,
        createC1229S5CustomArtifactPaths(runId, directory),
        [],
        { renderer: null, page: null, pageDiagnostic: null },
        fs,
        10,
      );
    } catch (error) {
      sessionError = error;
    }
    assert.ok(sessionError);
    assert.equal(sessionError.retainCustomRunning, true);
    const rendered = boundedC1229S5CustomErrorText(sessionError);
    assert.match(rendered, /hostile navigation after runtime response/u);
    assert.match(rendered, /hostile response off getter/u);
    assert.match(rendered, /response tasks settlement expired/u);
    assert.equal(closeTimeBodyCalls, 1);
    assert.equal(pageClosed, true);
    assert.equal(contextClosed, true);
    assert.equal(connected, true);
    const browserClose = await closeC1229S5CustomBrowserBounded(browser);
    assert.equal(browserClose.closeClean, true);
    assert.equal(connected, false);
  } finally {
    removeTempEvidenceDirectory(directory);
  }
});

test("probe keeps RUNNING and lock when watchdog cleanup is unproven", async () => {
  const directory = tempEvidenceDirectory();
  const runId = randomUUID();
  let rejectContext;
  const browser = {
    newContext() {
      return new Promise((_, reject) => {
        rejectContext = reject;
      });
    },
    close() {
      rejectContext(new Error("context aborted by watchdog"));
      throw new Error("browser cleanup unproven");
    },
  };
  try {
    let thrown;
    try {
      await runC1229S5CustomEllipsoidProbe({
        runId,
        outputDirectory: directory,
        watchdogMs: 10,
        launchBrowser: async () => browser,
      });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown);
    assert.equal(thrown.retainCustomRunning, true);
    assert.match(String(thrown.cause), /browser cleanup unproven/u);
    const paths = createC1229S5CustomArtifactPaths(runId, directory);
    assert.equal(
      JSON.parse(fs.readFileSync(paths.latest, "utf8")).status,
      "RUNNING",
    );
    assert.equal(
      JSON.parse(fs.readFileSync(paths.lock, "utf8")).status,
      "RUNNING",
    );
    assert.equal(fs.existsSync(paths.archive), false);
  } finally {
    removeTempEvidenceDirectory(directory);
  }
});

test("probe skeleton eventually exists and must not call production oracle", () => {
  if (!fs.existsSync(probePath)) return;
  const source = fs.readFileSync(probePath, "utf8");
  assert.doesNotMatch(source, /fitEclipseLimbDarkening\s*\(/u);
  assert.doesNotMatch(source, /computeUniformObscuration\s*\(/u);
  assert.match(source, /scene\.pickAsync\s*\(/u);
  assert.doesNotMatch(source, /\.updateForPick\s*\(/u);
});
