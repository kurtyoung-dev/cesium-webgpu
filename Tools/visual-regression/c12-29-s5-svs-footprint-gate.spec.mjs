// C12-29 S5 NASA-SVS absolute-footprint gate — pure policy, provenance,
// lifecycle, and adversarial mutant suite.
//
// Run:
//   node --test Tools/visual-regression/c12-29-s5-svs-footprint-gate.spec.mjs

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  C12_29_S5_SVS_BUILD_SOURCE_FILES,
  C12_29_S5_SVS_CAPTURE_LABELS,
  C12_29_S5_SVS_CAPTURE_METHOD,
  C12_29_S5_SVS_CONTROL,
  C12_29_S5_SVS_DIAGNOSTICS_SCHEMA,
  C12_29_S5_SVS_FIXTURE,
  C12_29_S5_SVS_PHASES,
  C12_29_S5_SVS_RENDERERS,
  C12_29_S5_SVS_ROWS,
  C12_29_S5_SVS_SCENE,
  C12_29_S5_SVS_SCHEMA,
  C12_29_S5_SVS_SIMON1994_BUDGET_KM,
  C12_29_S5_SVS_SOURCE_EDGE,
  C12_29_S5_SVS_SOURCE_FILES,
  C12_29_S5_SVS_SOURCE_MOTION,
  C12_29_S5_SVS_TERRAIN,
  computeSvsFootprintBudget,
  deriveSvsSpatialMetrics,
  exitCodeForSvsStatus,
  foldC1229S5SvsGate,
  validateSvsFinalArtifactShape,
  validateSvsRunningArtifactShape,
  wgs84GeodesicDistanceKm,
} from "./lib/c12-29-s5-svs-footprint-gate.mjs";
import {
  checkEmbeddedCaptureIsCanonical,
  checkEmbeddedFusedSnapshotIsCanonical,
  checkFusedCaptureUsage,
} from "./lib/same-task-capture.mjs";
import { parseSvs5073UmbraShapefile } from "./fixtures/nasa-svs-5073/nasa-svs-5073-shapefile.mjs";
import {
  beginSvsEvidenceRun,
  createSvsRequestLedger,
  createSvsArtifactPaths,
  drainSvsRequestLedger,
  inspectSvsPriorState,
  publishSvsFinalArtifact,
  closeSvsResourceBounded,
  validateSvsLoopbackBase,
  withSvsWatchdog,
} from "./probe-c12-29-s5-svs-footprint.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "../..");
const probePath = path.join(directory, "probe-c12-29-s5-svs-footprint.mjs");
const helperPath = path.join(directory, "lib/c12-29-s5-svs-footprint-gate.mjs");
const probeSource = fs.readFileSync(probePath, "utf8");
const helperSource = fs.readFileSync(helperPath, "utf8");
const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const NONCE = "223e4567-e89b-42d3-a456-426614174000";
const fixtureDirectory = path.join(directory, "fixtures/nasa-svs-5073");
const fixtureInputs = Object.fromEntries(
  Object.keys(C12_29_S5_SVS_FIXTURE.members).map((extension) => [
    extension,
    fs.readFileSync(
      path.join(fixtureDirectory, `${C12_29_S5_SVS_FIXTURE.stem}.${extension}`),
    ),
  ]),
);
const fixtureCollection = parseSvs5073UmbraShapefile(fixtureInputs);

const clone = (value) => structuredClone(value);
const ids = (count, start = 0) =>
  Array.from({ length: count }, (_, index) => start + index);
const imageId = (index) =>
  `00000000-0000-4000-a000-${String(index).padStart(12, "0")}`;

function pointInRing([longitude, latitude], ring) {
  let inside = false;
  for (
    let index = 0, previous = ring.length - 1;
    index < ring.length;
    previous = index++
  ) {
    const [x, y] = ring[index];
    const [priorX, priorY] = ring[previous];
    if (
      y > latitude !== priorY > latitude &&
      longitude < ((priorX - x) * (latitude - y)) / (priorY - y) + x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function syntheticBuildSourceIdentity() {
  return {
    ok: true,
    entries: C12_29_S5_SVS_BUILD_SOURCE_FILES.map((relative) => ({
      file: `F:/Dev/GH/cesium-webgpu/${relative}`,
      sourceMapEntry: `../../${relative}`,
      currentByteLength: 100,
      embeddedByteLength: 100,
      currentSha256: "a".repeat(64),
      embeddedSha256: "a".repeat(64),
      exact: true,
      reason: null,
    })),
  };
}

function syntheticFixtureProof() {
  return {
    parser: "parseSvs5073UmbraShapefile",
    manifestSchema: C12_29_S5_SVS_FIXTURE.manifest.schema,
    manifestFingerprint: {
      byteLength: C12_29_S5_SVS_FIXTURE.manifest.bytes,
      sha256: C12_29_S5_SVS_FIXTURE.manifest.sha256,
    },
    projectionWkt:
      'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137,298.257223563]]]',
    featureCount: 4,
    storedPointCount: C12_29_S5_SVS_FIXTURE.storedPointCount,
    fingerprints: Object.fromEntries(
      Object.entries(C12_29_S5_SVS_FIXTURE.members).map(
        ([extension, expected]) => [
          extension,
          { byteLength: expected.bytes, sha256: expected.sha256 },
        ],
      ),
    ),
    recordIdentities: C12_29_S5_SVS_ROWS.map((row) => ({
      sourceIndexZeroBased: row.sourceIndexZeroBased,
      sourceRecordNumber: row.sourceRecordNumber,
      outputRecordNumber: row.outputRecordNumber,
    })),
    manifestRecordIdentities: C12_29_S5_SVS_ROWS.map((row) => ({
      sourceIndexZeroBased: row.sourceIndexZeroBased,
      sourceRecordNumber: row.sourceRecordNumber,
      outputRecordNumber: row.outputRecordNumber,
    })),
    maximumSourceEdge: {
      distanceKm: C12_29_S5_SVS_SOURCE_EDGE.maximumAdjacentDistanceKm,
      method: C12_29_S5_SVS_SOURCE_EDGE.method,
      units: C12_29_S5_SVS_SOURCE_EDGE.units,
      outputRecordNumber: C12_29_S5_SVS_SOURCE_EDGE.outputRecordNumber,
      edgeIndexZeroBased: C12_29_S5_SVS_SOURCE_EDGE.edgeIndexZeroBased,
      startLonLat: [...C12_29_S5_SVS_SOURCE_EDGE.startLonLat],
      endLonLat: [...C12_29_S5_SVS_SOURCE_EDGE.endLonLat],
    },
  };
}

function syntheticRow(expected) {
  const feature = fixtureCollection.features[expected.outputRecordNumber - 1];
  const bbox = [...feature.bbox];
  const ring = feature.geometry.coordinates[0].map((point) => [...point]);
  const side = C12_29_S5_SVS_SCENE.latticeSide;
  const west = bbox[0] - C12_29_S5_SVS_SCENE.cameraGuardDegrees;
  const south = bbox[1] - C12_29_S5_SVS_SCENE.cameraGuardDegrees;
  const east = bbox[2] + C12_29_S5_SVS_SCENE.cameraGuardDegrees;
  const north = bbox[3] + C12_29_S5_SVS_SCENE.cameraGuardDegrees;
  const coordinateForId = (id) => [
    west + (((id % side) + 0.5) / side) * (east - west),
    north - ((Math.floor(id / side) + 0.5) / side) * (north - south),
  ];
  const valid = ids(side ** 2);
  const nasa = valid.filter((id) => pointInRing(coordinateForId(id), ring));
  const terrain = [...valid];
  const classified = [...nasa];
  const heightMeters = 400_000;
  const verticalFovRadians = 0.96;
  const latticePitchKm = Math.max(
    wgs84GeodesicDistanceKm(
      [west, expected.sourceCenter[1]],
      [west + (east - west) / side, expected.sourceCenter[1]],
    ),
    wgs84GeodesicDistanceKm(
      [expected.sourceCenter[0], south],
      [expected.sourceCenter[0], south + (north - south) / side],
    ),
  );
  const pixelGroundFootprintKm =
    (2 * heightMeters * Math.tan(verticalFovRadians * 0.5)) /
    C12_29_S5_SVS_SCENE.viewport.height /
    1000;
  const budget = computeSvsFootprintBudget({
    latticePitchKm,
    pixelGroundFootprintKm,
  });
  const transitionRole = expected.role;
  const transitionIso = expected.iso;
  const cameraIdentity = `camera:${expected.role}`;
  const terrainContent = [
    {
      tileId: "1/0/1",
      tileObjectId: 1,
      terrainDataObjectId: 2,
      renderedMeshObjectId: 3,
      realMeshObjectId: 3,
      fillMeshObjectId: 0,
    },
  ];
  const tupleAt = (frameNumber, selectionRevision) => ({
    prepared: true,
    selectionRoute:
      "GlobeSurfaceTileProvider.showTileThisFrame/pass-through-events",
    preparationRoute: "frameState.commandList/Pass.GLOBE/command.owner",
    selectionFrameNumber: frameNumber,
    preparedFrameNumber: frameNumber,
    captureFrameNumber: frameNumber,
    selectionEventCount: 1,
    selectionEventsUnique: true,
    preparedCommandCount: 1,
    preparedCommandOwnersMatchSelection: true,
    selectedTileId: "1/0/1",
    preparedTileId: "1/0/1",
    selectedTileIds: ["1/0/1"],
    preparedSelectedTileIds: ["1/0/1"],
    selectedRealTileIds: ["1/0/1"],
    selectedFillTileIds: [],
    selectedPreparedTileSetsMatch: true,
    preparedSelectionContainsRealTile: true,
    terrainDataInstanceProof: "instanceof-C.QuantizedMeshTerrainData",
    renderedMeshIsRealMesh: true,
    renderedMeshIsFillMesh: false,
    selectionRevision,
    surfaceRadiusMeters: 6_378_137,
    providerSelectionRevision: selectionRevision,
    providerSurfaceRadiusMeters: 6_378_137,
    selectionRevisionMatches: true,
    surfaceRadiusMatches: true,
    mainViewShadowMatches: true,
    preparedCapturedInEndUpdate: true,
    preparedRealTileIds: ["1/0/1"],
    preparedFillTileIds: [],
    tilesLoadedAfterRender: true,
    terrainProviderIdentity: 4,
    sourceTerrainProviderIdentity: 4,
    sourceTerrainProviderMatches: true,
    surfaceProviderIdentity: 5,
    providerContentRevision: 6,
    cameraIdentity,
    expectedCameraIdentity: cameraIdentity,
    transitionRole,
    transitionIso,
    clockTimeIso: transitionIso,
    frameStateTimeIso: transitionIso,
    selectedContent: clone(terrainContent),
    preparedContent: clone(terrainContent),
    selectionContentIdentity: JSON.stringify({
      selected: terrainContent,
      prepared: terrainContent,
    }),
  });
  const readinessTuples = [tupleAt(15, 1), tupleAt(16, 2), tupleAt(17, 3)];
  const captureTuples = [
    tupleAt(18, 4),
    tupleAt(19, 5),
    tupleAt(20, 6),
    tupleAt(21, 7),
  ];
  const row = {
    ...expected,
    sourceCenter: [...expected.sourceCenter],
    fixtureGeometry: {
      bbox,
      ring,
      storedPointCount: ring.length,
      canonicalSha256: expected.fixtureGeometry.canonicalSha256,
    },
    clock: {
      shouldAnimate: false,
      currentTimeIso: expected.iso,
      renderArgumentIso: expected.iso,
      frameStateTimeIso: expected.iso,
      exactPinnedFrame: true,
    },
    cameraFrame: {
      centerLonLat: [...expected.sourceCenter],
      mode: C12_29_S5_SVS_SCENE.cameraMode,
      derivedFromGuardedBbox: true,
      fixedAcrossRows: true,
      allFixtureVerticesProjected: true,
      actualMarginPixels: C12_29_S5_SVS_SCENE.minimumMarginPixels,
      nadirAlignment: 0,
      heightMeters,
      verticalFovRadians,
    },
    terrainTuple: captureTuples.at(-1),
    transitionReadiness: {
      method: C12_29_S5_SVS_SCENE.readinessMethod,
      transitionRole,
      transitionIso,
      forcedRenderBeforeFirstReadinessCheck: true,
      settled: true,
      boundedMaxFrames: C12_29_S5_SVS_SCENE.transitionReadinessMaxFrames,
      renderCount: 3,
      requiredConsecutiveStableFrames:
        C12_29_S5_SVS_SCENE.readinessConsecutiveStableFrames,
      consecutiveStableFrames:
        C12_29_S5_SVS_SCENE.readinessConsecutiveStableFrames,
      cameraIdentity,
      sourceTerrainProviderIdentity: 4,
      surfaceProviderIdentity: 5,
      providerContentRevision: 6,
      selectionContentIdentity: readinessTuples.at(-1).selectionContentIdentity,
      lastFrameNumber: 17,
      lastSelectionRevision: 3,
      observations: readinessTuples.map((tuple, index) => ({
        renderOrdinal: index + 1,
        tuple,
      })),
    },
    captureTerrainProofs: ["white", "black", "off", "on"].map(
      (label, index) => ({ label, tuple: captureTuples[index] }),
    ),
    thresholdOrigin:
      "exact-WGS84-source-edge+half-lattice+half-pixel;40km-Simon1994",
    sourceEdge: clone(C12_29_S5_SVS_SOURCE_EDGE),
    iouUsedAsGate: false,
    recentered: false,
    translatedToModel: false,
    budget: { ...budget },
    lattice: {
      side: C12_29_S5_SVS_SCENE.latticeSide,
      candidateCellCount: C12_29_S5_SVS_SCENE.latticeSide ** 2,
      sampling: "cell-centre",
      guardDegrees: C12_29_S5_SVS_SCENE.cameraGuardDegrees,
      uniqueProjectedCellCount: valid.length,
      validProjectedCellCount: valid.length,
      nasaInsideCount: nasa.length,
      nasaOutsideCount: valid.length - nasa.length,
      duplicateProjectedCellCount: 0,
      latticePitchKm,
      pixelGroundFootprintKm,
      validProjectedCellIds: valid,
      nasaInsideCellIds: nasa,
      terrainCellIds: terrain,
      classifiedCellIds: classified,
      qBoundaryBandCellIds: [],
      cellLonLat: valid.map((id) => [id, ...coordinateForId(id)]),
    },
    mask: {
      method: C12_29_S5_SVS_SCENE.terrainMaskMethod,
      terrainPixelCount: terrain.length,
      classifiedCellCount: classified.length,
      strictlyClassifiedCellCount: classified.length,
      oneCodeBoundaryCount: 0,
      oneCodeBoundaryCellIds: [],
      offMinimumLuminanceCode: C12_29_S5_SVS_SCENE.offMinimumLuminanceCode,
      onOffRatioMaximum: C12_29_S5_SVS_SCENE.onOffRatioMaximum,
      allClassifiedMeetOffMinimum: true,
      allClassifiedMeetOnOffRatio: true,
      classificationAppliedOnlyInsideTerrainMask: true,
      offBrightTerrainPixelCount: terrain.length,
      offBrightTerrainCellIds: [...terrain],
    },
    boundary: {
      p95Km: 1,
      maximumKm: 2,
      classifiedOutsideDilatedCount: 0,
      erodedOutsideClassifiedCount: 0,
      erodedNasaCellCount: 550,
      dilatedNasaCellCount: 650,
      areaRatio: 1,
      minimumAreaRatio: 550 / 600,
      maximumAreaRatio: 650 / 600,
      rawIou: 1,
    },
    centroid: {
      measuredLonLat: [0, 0],
      sourceLonLat: [0, 0],
      errorKm: 0,
      longitudeResidualDegrees: 0,
      latitudeResidualDegrees: 0,
    },
  };
  const derived = deriveSvsSpatialMetrics(row);
  row.lattice.qBoundaryBandCellIds = derived.qBoundaryBandCellIds;
  row.boundary = derived.boundary;
  row.centroid = derived.centroid;
  return row;
}

function syntheticSession(renderer, serialIndex) {
  const providerRow = syntheticRow(C12_29_S5_SVS_ROWS[0]);
  const providerReadiness = clone(providerRow.transitionReadiness);
  providerReadiness.transitionRole = "terrain-provider";
  providerReadiness.boundedMaxFrames =
    C12_29_S5_SVS_SCENE.providerReadinessMaxFrames;
  for (const observation of providerReadiness.observations) {
    observation.tuple.transitionRole = "terrain-provider";
  }
  const session = {
    schema: C12_29_S5_SVS_DIAGNOSTICS_SCHEMA,
    renderer,
    serialIndex,
    freshContext: true,
    startedAtMs: serialIndex === 0 ? 100 : 201,
    completedAtMs: serialIndex === 0 ? 200 : 300,
    phaseOrder: [...C12_29_S5_SVS_PHASES],
    transport: {
      loopbackOnly: true,
      externalRequests: 0,
      failedRequests: 0,
      ledgerMethod: "generation-aware-post-cleanup-response-drain",
      ledgerSealed: true,
      ledgerGeneration: 40,
      quiescentStableTurns: 3,
      postSealTurnObserved: true,
      responseBodiesPending: 0,
      responseBodyErrors: 0,
      lateEvents: [],
    },
    errors: { page: [], console: [], gpu: [], deviceLost: false },
    scene: {
      renderer,
      viewport: { ...C12_29_S5_SVS_SCENE.viewport },
      cameraMode: C12_29_S5_SVS_SCENE.cameraMode,
      framingRule: C12_29_S5_SVS_SCENE.framingRule,
      cameraGuardDegrees: C12_29_S5_SVS_SCENE.cameraGuardDegrees,
      minimumMarginPixels: C12_29_S5_SVS_SCENE.minimumMarginPixels,
      actualMarginPixels: C12_29_S5_SVS_SCENE.minimumMarginPixels,
      cameraHeightMeters: 400_000,
      verticalFovRadians: 0.96,
      recentered: false,
      translatedToModel: false,
      fixedCameraHeightAcrossRows: true,
      shouldAnimate: false,
      requestRenderMode: false,
      hdr: false,
      bloom: false,
      taa: false,
      fxaa: false,
      fog: false,
      volumetricFog: false,
      atmosphere: false,
      clouds: false,
      water: false,
      eclipseAutoExposure: true,
    },
    ephemeris: {
      preloadComplete: true,
      matrixMethod: "Transforms.computeIcrfToFixedMatrix",
      allMatricesDefined: true,
      allMatricesFinite: true,
      allMatricesOrthonormal: true,
      temeUsed: false,
      fallbackUsed: false,
      independentSimon1994: true,
      maximumSunPositionDeltaMeters: 0,
      maximumMoonPositionDeltaMeters: 0,
      xysFiles: [
        {
          route:
            "/Build/CesiumUnminified/Assets/IAU2006_XYS/IAU2006_XYS_10.json",
          status: 200,
          byteLength: 100,
          sha256: "b".repeat(64),
          localStart: {
            exists: true,
            byteLength: 100,
            sha256: "b".repeat(64),
          },
          localEnd: {
            exists: true,
            byteLength: 100,
            sha256: "b".repeat(64),
          },
        },
      ],
    },
    fixtureProof: syntheticFixtureProof(),
    terrain: {
      providerClass: "CesiumTerrainProvider",
      terrainDataInstanceProof: "instanceof-C.QuantizedMeshTerrainData",
      decodedQuantizedMeshCount: 4,
      selectedRealMeshCount: 4,
      preparedRealMeshCount: 4,
      preparedTupleCount: 4,
      allPreparedTuplesMatchSelected: true,
      allPreparedTuplesReal: true,
      fillMeshCount: 0,
      surrogateUsed: false,
      ellipsoidOnly: false,
      maskMethod: C12_29_S5_SVS_SCENE.terrainMaskMethod,
      responseCodeThreshold: C12_29_S5_SVS_SCENE.terrainResponseCodeThreshold,
      whiteBlackSameCamera: true,
      validWgs84Intersection: true,
      sourceTerrainProviderIdentity: 4,
      surfaceProviderIdentity: 5,
      providerReadiness,
    },
    rows: C12_29_S5_SVS_ROWS.map(syntheticRow),
    motion: {
      fromRole: C12_29_S5_SVS_SOURCE_MOTION.fromRole,
      toRole: C12_29_S5_SVS_SOURCE_MOTION.toRole,
      seconds: C12_29_S5_SVS_SOURCE_MOTION.seconds,
      sourceVectorDistanceKm: C12_29_S5_SVS_SOURCE_MOTION.vectorDistanceKm,
      sourceInitialHeadingDegrees:
        C12_29_S5_SVS_SOURCE_MOTION.initialHeadingDegrees,
      sourceEastKm: C12_29_S5_SVS_SOURCE_MOTION.eastKm,
      sourceNorthKm: C12_29_S5_SVS_SOURCE_MOTION.northKm,
      sourceDirection: C12_29_S5_SVS_SOURCE_MOTION.direction,
      sourceSpeedKmPerHour: C12_29_S5_SVS_SOURCE_MOTION.speedKmPerHour,
      method: C12_29_S5_SVS_SOURCE_MOTION.method,
      measuredDirectionEast: true,
      measuredDirectionNorth: true,
      vectorErrorKm: 0,
      measuredSpeedKmPerHour: C12_29_S5_SVS_SOURCE_MOTION.speedKmPerHour,
      vectorLimitKm: 0,
      speedUncertaintyKmPerHour: 0,
    },
    control: null,
    images: C12_29_S5_SVS_CAPTURE_LABELS.map((label, index) => ({
      imageId: imageId(serialIndex * 20 + index),
      label,
      renderer,
      runId: RUN_ID,
      file: `${RUN_ID}.${renderer}.${label}.${index}.png`,
      byteLength: 10_000 + index,
      sha256: String(index + serialIndex)
        .padStart(64, "a")
        .slice(-64),
      width: C12_29_S5_SVS_SCENE.viewport.width,
      height: C12_29_S5_SVS_SCENE.viewport.height,
      pngSignatureValid: true,
      decoded: true,
      captureMethod: C12_29_S5_SVS_CAPTURE_METHOD,
    })),
    capture: {
      method: C12_29_S5_SVS_CAPTURE_METHOD,
      canonicalSameTask: true,
    },
    cleanup: {
      contextClosed: true,
      contextCloseAttempted: true,
      contextCloseTimedOut: false,
      pageClosed: true,
      pageCloseAttempted: true,
      pageCloseTimedOut: false,
      closeTimeoutMs: C12_29_S5_SVS_SCENE.cleanupCloseTimeoutMs,
      pendingRequestsMeasured: true,
      pendingRequests: 0,
      requestStartedCount: 20,
      requestSettledCount: 20,
      pendingRequestPeak: 5,
      deviceLost: false,
    },
  };
  const controlSource = session.rows.find(
    (row) => row.role === C12_29_S5_SVS_CONTROL.cameraSourceRole,
  );
  const controlLattice = clone(controlSource.lattice);
  controlLattice.classifiedCellIds = [];
  session.control = {
    ...C12_29_S5_SVS_CONTROL,
    clock: {
      shouldAnimate: false,
      currentTimeIso: C12_29_S5_SVS_CONTROL.iso,
      renderArgumentIso: C12_29_S5_SVS_CONTROL.iso,
      frameStateTimeIso: C12_29_S5_SVS_CONTROL.iso,
      exactPinnedFrame: true,
    },
    classifiedCellCount: 0,
    strictlyClassifiedCellCount: 0,
    oneCodeBoundaryCount: 0,
    classificationAppliedOnlyInsideTerrainMask: true,
    cameraFrame: clone(controlSource.cameraFrame),
    terrainTuple: clone(controlSource.terrainTuple),
    transitionReadiness: clone(controlSource.transitionReadiness),
    captureTerrainProofs: clone(controlSource.captureTerrainProofs),
    lattice: controlLattice,
    mask: {
      method: C12_29_S5_SVS_SCENE.terrainMaskMethod,
      terrainPixelCount: controlLattice.terrainCellIds.length,
      classifiedCellCount: 0,
      strictlyClassifiedCellCount: 0,
      oneCodeBoundaryCount: 0,
      oneCodeBoundaryCellIds: [],
      offBrightTerrainPixelCount: controlLattice.terrainCellIds.length,
      offBrightTerrainCellIds: [...controlLattice.terrainCellIds],
      offMinimumLuminanceCode: C12_29_S5_SVS_SCENE.offMinimumLuminanceCode,
      onOffRatioMaximum: C12_29_S5_SVS_SCENE.onOffRatioMaximum,
      allClassifiedMeetOffMinimum: true,
      allClassifiedMeetOnOffRatio: true,
      classificationAppliedOnlyInsideTerrainMask: true,
    },
  };
  session.control.transitionReadiness.transitionRole =
    C12_29_S5_SVS_CONTROL.role;
  session.control.transitionReadiness.transitionIso = C12_29_S5_SVS_CONTROL.iso;
  for (const observation of session.control.transitionReadiness.observations) {
    observation.tuple.transitionRole = C12_29_S5_SVS_CONTROL.role;
    observation.tuple.transitionIso = C12_29_S5_SVS_CONTROL.iso;
    observation.tuple.clockTimeIso = C12_29_S5_SVS_CONTROL.iso;
    observation.tuple.frameStateTimeIso = C12_29_S5_SVS_CONTROL.iso;
  }
  for (const proof of session.control.captureTerrainProofs) {
    proof.tuple.transitionRole = C12_29_S5_SVS_CONTROL.role;
    proof.tuple.transitionIso = C12_29_S5_SVS_CONTROL.iso;
    proof.tuple.clockTimeIso = C12_29_S5_SVS_CONTROL.iso;
    proof.tuple.frameStateTimeIso = C12_29_S5_SVS_CONTROL.iso;
  }
  session.control.terrainTuple = clone(
    session.control.captureTerrainProofs.at(-1).tuple,
  );
  const motionQKm = Math.max(
    session.rows[1].budget.qKm,
    session.rows[2].budget.qKm,
  );
  session.motion.vectorLimitKm = 2 * motionQKm;
  session.motion.speedUncertaintyKmPerHour =
    ((2 * motionQKm) / C12_29_S5_SVS_SOURCE_MOTION.seconds) * 3600;
  const byLabel = new Map(session.images.map((image) => [image.label, image]));
  const binding = (label) => {
    const image = byLabel.get(label);
    const owner = label.startsWith("noneclipse-control")
      ? session.control
      : session.rows.find((row) => label.startsWith(`${row.role}-`));
    const channel = label.endsWith("-off") ? "off" : "on";
    const proof = owner.captureTerrainProofs.find(
      (candidate) => candidate.label === channel,
    );
    return {
      imageId: image.imageId,
      sha256: image.sha256,
      byteLength: image.byteLength,
      width: image.width,
      height: image.height,
      captureFrameNumber: proof.tuple.captureFrameNumber,
      selectionRevision: proof.tuple.selectionRevision,
      selectionContentIdentity: proof.tuple.selectionContentIdentity,
    };
  };
  for (const row of session.rows) {
    row.metricImageBindings = {
      off: binding(`${row.role}-off`),
      on: binding(`${row.role}-on`),
    };
  }
  session.control.metricImageBindings = {
    off: binding("noneclipse-control-off"),
    on: binding("noneclipse-control-on"),
  };
  const before = session.rows[1].centroid.measuredLonLat;
  const after = session.rows[2].centroid.measuredLonLat;
  const radians = Math.PI / 180;
  const deltaLongitude = (after[0] - before[0]) * radians;
  const beforeLatitude = before[1] * radians;
  const afterLatitude = after[1] * radians;
  const heading = Math.atan2(
    Math.sin(deltaLongitude) * Math.cos(afterLatitude),
    Math.cos(beforeLatitude) * Math.sin(afterLatitude) -
      Math.sin(beforeLatitude) *
        Math.cos(afterLatitude) *
        Math.cos(deltaLongitude),
  );
  const measuredDistance = wgs84GeodesicDistanceKm(before, after);
  session.motion.measuredDirectionEast = Math.sin(heading) > 0;
  session.motion.measuredDirectionNorth = Math.cos(heading) > 0;
  session.motion.vectorErrorKm = Math.hypot(
    measuredDistance * Math.sin(heading) - C12_29_S5_SVS_SOURCE_MOTION.eastKm,
    measuredDistance * Math.cos(heading) - C12_29_S5_SVS_SOURCE_MOTION.northKm,
  );
  session.motion.measuredSpeedKmPerHour =
    (measuredDistance / C12_29_S5_SVS_SOURCE_MOTION.seconds) * 3600;
  return session;
}

function greenReport() {
  const sessions = C12_29_S5_SVS_RENDERERS.map(syntheticSession);
  return {
    schema: C12_29_S5_SVS_SCHEMA,
    runId: RUN_ID,
    lifecycle: {
      firstRedStable: true,
      firstRedBaselineValidated: true,
      firstRedBaseline: {
        file: "c12-29-s5-svs-5073-footprint.first-red.json",
        exists: false,
        byteLength: null,
        sha256: null,
        error: "ENOENT",
      },
      firstRedCurrent: {
        file: "c12-29-s5-svs-5073-footprint.first-red.json",
        exists: false,
        byteLength: null,
        sha256: null,
        error: "ENOENT",
      },
      browserCleanup: {
        attempted: true,
        closed: true,
        timedOut: false,
        closeTimeoutMs: C12_29_S5_SVS_SCENE.cleanupCloseTimeoutMs,
      },
      lockCreatedExclusively: true,
      runningReceiptCreatedExclusively: true,
      foreignOwnerPreserved: true,
      recoveryInspected: true,
      runningPublishedBeforeBrowser: true,
      immutableBeforeLatest: true,
      latestBeforeUnlock: true,
      lockOwnedByRun: true,
      archiveLatestByteIdentical: true,
      runningReceipt: {
        schema: C12_29_S5_SVS_SCHEMA,
        runId: RUN_ID,
        generatedAt: "2026-08-13T00:00:00.000Z",
        status: "RUNNING",
        incomplete: true,
        nonce: NONCE,
      },
      finalReceipt: {
        schema: C12_29_S5_SVS_SCHEMA,
        runId: RUN_ID,
        status: "PASS",
        incomplete: false,
        publicationProtocol:
          "exclusive-lock+write-once-receipts+claim-verify-latest+foreign-preserving-unlock",
      },
      finalStatus: "PASS",
      lock: {
        runId: RUN_ID,
        nonce: NONCE,
        released: true,
        releaseAfterLatestVerified: true,
      },
      priorStateInspected: true,
      publicationOrder: [
        "LOCK",
        "RUNNING",
        "ARCHIVE",
        "LATEST",
        "RECEIPT",
        "UNLOCK",
      ],
    },
    provenance: {
      gitHead: "c".repeat(40),
      sourceStable: true,
      buildStable: true,
      servedEntry: { ok: true },
      buildSourceIdentity: syntheticBuildSourceIdentity(),
      fixtureSetSha256: C12_29_S5_SVS_FIXTURE.fixtureSetSha256,
      generatedShaders: { globeFsExact: true, globeTerrainExact: true },
      fixtures: Object.fromEntries([
        [
          "manifest",
          {
            byteLength: C12_29_S5_SVS_FIXTURE.manifest.bytes,
            sha256: C12_29_S5_SVS_FIXTURE.manifest.sha256,
          },
        ],
        ...Object.entries(C12_29_S5_SVS_FIXTURE.members).map(
          ([extension, expected]) => [
            extension,
            { byteLength: expected.bytes, sha256: expected.sha256 },
          ],
        ),
      ]),
      terrain: {
        layer: {
          byteLength: C12_29_S5_SVS_TERRAIN.layer.byteLength,
          sha256: C12_29_S5_SVS_TERRAIN.layer.sha256,
        },
        tile: {
          byteLength: C12_29_S5_SVS_TERRAIN.tile.byteLength,
          sha256: C12_29_S5_SVS_TERRAIN.tile.sha256,
        },
      },
    },
    sessions,
    crossBackend: C12_29_S5_SVS_ROWS.map((row, index) => ({
      role: row.role,
      differingCellIds: [],
      differingCellCount: 0,
      allDifferingCellsWithinUnionQBoundaryBands: true,
      centroidDistanceKm: 0,
      centroidDistanceMethod: "WGS84-Vincenty-inverse",
      centroidLimitKm:
        2 *
        Math.max(
          sessions[0].rows[index].budget.qKm,
          sessions[1].rows[index].budget.qKm,
        ),
    })),
  };
}

function expectStatus(mutator, status, pattern) {
  const report = greenReport();
  mutator(report);
  const result = foldC1229S5SvsGate(report);
  assert.equal(result.status, status, JSON.stringify(result, null, 2));
  if (pattern) {
    assert.match(
      [...result.structuralReasons, ...result.failures].join("\n"),
      pattern,
    );
  }
}

const finalArtifactTemplates = new Map();

function bindSyntheticReportRunId(report, runId) {
  report.runId = runId;
  report.lifecycle.runningReceipt.runId = runId;
  report.lifecycle.finalReceipt.runId = runId;
  report.lifecycle.lock.runId = runId;
  for (const session of report.sessions) {
    for (const image of session.images) {
      image.runId = runId;
      image.file = image.file.replace(RUN_ID, runId);
    }
  }
}

function makeSyntheticProductFailure(report) {
  for (const session of report.sessions) {
    const row = session.rows[0];
    row.lattice.classifiedCellIds = row.lattice.validProjectedCellIds.slice(
      0,
      C12_29_S5_SVS_SCENE.minimumNasaInsideCells,
    );
    row.mask.classifiedCellCount = row.lattice.classifiedCellIds.length;
    const derived = deriveSvsSpatialMetrics(row);
    row.lattice.qBoundaryBandCellIds = derived.qBoundaryBandCellIds;
    row.boundary = derived.boundary;
    row.centroid = derived.centroid;
  }
}

function finalArtifact(status, runId = RUN_ID) {
  const key = `${status}:${runId}`;
  if (finalArtifactTemplates.has(key)) {
    return clone(finalArtifactTemplates.get(key));
  }
  if (status === "ERROR") {
    const errorArtifact = {
      schema: C12_29_S5_SVS_SCHEMA,
      runId,
      generatedAt: "2026-08-13T00:00:00.000Z",
      status,
      exitCode: exitCodeForSvsStatus(status),
      incomplete: false,
      error: "synthetic final error",
      diagnostics: null,
    };
    finalArtifactTemplates.set(key, clone(errorArtifact));
    return errorArtifact;
  }
  const report = greenReport();
  bindSyntheticReportRunId(report, runId);
  if (status === "FAIL") makeSyntheticProductFailure(report);
  report.lifecycle.finalStatus = status;
  report.lifecycle.finalReceipt.status = status;
  report.lifecycle.publicationOrder =
    status === "PASS"
      ? ["LOCK", "RUNNING", "ARCHIVE", "LATEST", "RECEIPT", "UNLOCK"]
      : [
          "LOCK",
          "RUNNING",
          "ARCHIVE",
          "FIRST_RED",
          "LATEST",
          "RECEIPT",
          "UNLOCK",
        ];
  const verdict = foldC1229S5SvsGate(report);
  assert.equal(verdict.status, status, JSON.stringify(verdict, null, 2));
  Object.assign(report, verdict);
  const artifact = {
    schema: C12_29_S5_SVS_SCHEMA,
    runId,
    generatedAt: "2026-08-13T00:00:00.000Z",
    status,
    exitCode: exitCodeForSvsStatus(status),
    incomplete: false,
    report,
  };
  finalArtifactTemplates.set(key, clone(artifact));
  return artifact;
}

test("01 green synthetic report closes every frozen gate", () => {
  assert.deepEqual(foldC1229S5SvsGate(greenReport()), {
    status: "PASS",
    exitCode: 0,
    structuralReasons: [],
    failures: [],
  });
});

test("02 schemas, A-H phases, exact rows, control, and ten labels are frozen", () => {
  assert.equal(
    C12_29_S5_SVS_SCHEMA,
    "c12-29-s5-svs-5073-footprint-evidence-v2",
  );
  assert.equal(
    C12_29_S5_SVS_DIAGNOSTICS_SCHEMA,
    "c12-29-s5-svs-5073-footprint-runtime-diagnostics-v2",
  );
  assert.equal(C12_29_S5_SVS_PHASES.length, 8);
  assert.equal(C12_29_S5_SVS_ROWS.length, 4);
  assert.equal(C12_29_S5_SVS_CAPTURE_LABELS.length, 10);
  assert.equal(C12_29_S5_SVS_CONTROL.iso, "2024-04-09T18:17:15Z");
  assert.equal(
    C12_29_S5_SVS_CONTROL.bracketMidpointIso,
    "2024-04-08T18:17:15Z",
  );
  assert.equal(C12_29_S5_SVS_CONTROL.offsetSeconds, 86_400);
  const priorRunning = {
    schema: "c12-29-s5-svs-5073-footprint-evidence-v1",
    runId: RUN_ID,
    generatedAt: "2026-08-13T00:00:00.000Z",
    status: "RUNNING",
    incomplete: true,
    nonce: NONCE,
  };
  assert.match(
    validateSvsRunningArtifactShape(priorRunning).join("\n"),
    /schema/u,
  );
  const manifest = fs.readFileSync(
    path.join(directory, "fixtures/nasa-svs-5073/manifest.json"),
  );
  assert.equal(manifest.byteLength, C12_29_S5_SVS_FIXTURE.manifest.bytes);
  assert.equal(
    createHash("sha256").update(manifest).digest("hex"),
    C12_29_S5_SVS_FIXTURE.manifest.sha256,
  );
});

test("03 exact maximum source edge is recomputed over all fixture vertices", async () => {
  const fixtureDirectory = path.join(directory, "fixtures/nasa-svs-5073");
  const files = Object.fromEntries(
    Object.keys(C12_29_S5_SVS_FIXTURE.members).map((extension) => [
      extension,
      fs.readFileSync(
        path.join(
          fixtureDirectory,
          `${C12_29_S5_SVS_FIXTURE.stem}.${extension}`,
        ),
      ),
    ]),
  );
  const collection = parseSvs5073UmbraShapefile(files);
  const { default: Cartographic } = await import(
    pathToFileURL(
      path.join(root, "packages/engine/Source/Core/Cartographic.js"),
    ).href
  );
  const { default: Ellipsoid } = await import(
    pathToFileURL(path.join(root, "packages/engine/Source/Core/Ellipsoid.js"))
      .href
  );
  const { default: EllipsoidGeodesic } = await import(
    pathToFileURL(
      path.join(root, "packages/engine/Source/Core/EllipsoidGeodesic.js"),
    ).href
  );
  let maximum = { distanceKm: -Infinity };
  collection.features.forEach((feature, featureIndex) => {
    const ring = feature.geometry.coordinates[0];
    for (let edgeIndex = 0; edgeIndex < ring.length - 1; edgeIndex++) {
      const start = ring[edgeIndex];
      const end = ring[edgeIndex + 1];
      const geodesic = new EllipsoidGeodesic(
        Cartographic.fromDegrees(...start),
        Cartographic.fromDegrees(...end),
        Ellipsoid.WGS84,
      );
      const distanceKm = geodesic.surfaceDistance / 1000;
      if (distanceKm > maximum.distanceKm) {
        maximum = {
          distanceKm,
          outputRecordNumber: featureIndex + 1,
          edgeIndexZeroBased: edgeIndex,
          startLonLat: start,
          endLonLat: end,
        };
      }
    }
  });
  assert.ok(
    Math.abs(
      maximum.distanceKm - C12_29_S5_SVS_SOURCE_EDGE.maximumAdjacentDistanceKm,
    ) < 1e-12,
  );
  assert.equal(maximum.outputRecordNumber, 4);
  assert.equal(maximum.edgeIndexZeroBased, 3);
  assert.deepEqual(maximum.startLonLat, C12_29_S5_SVS_SOURCE_EDGE.startLonLat);
  assert.deepEqual(maximum.endLonLat, C12_29_S5_SVS_SOURCE_EDGE.endLonLat);
});

test("04 exact source motion is WGS84-geodesic derived, not rounded", async () => {
  const { default: Cartographic } = await import(
    pathToFileURL(
      path.join(root, "packages/engine/Source/Core/Cartographic.js"),
    ).href
  );
  const { default: Ellipsoid } = await import(
    pathToFileURL(path.join(root, "packages/engine/Source/Core/Ellipsoid.js"))
      .href
  );
  const { default: EllipsoidGeodesic } = await import(
    pathToFileURL(
      path.join(root, "packages/engine/Source/Core/EllipsoidGeodesic.js"),
    ).href
  );
  const geodesic = new EllipsoidGeodesic(
    Cartographic.fromDegrees(...C12_29_S5_SVS_ROWS[1].sourceCenter),
    Cartographic.fromDegrees(...C12_29_S5_SVS_ROWS[2].sourceCenter),
    Ellipsoid.WGS84,
  );
  const distance = geodesic.surfaceDistance / 1000;
  assert.ok(
    Math.abs(distance - C12_29_S5_SVS_SOURCE_MOTION.vectorDistanceKm) < 1e-12,
  );
  assert.ok(
    Math.abs(
      wgs84GeodesicDistanceKm(
        C12_29_S5_SVS_ROWS[1].sourceCenter,
        C12_29_S5_SVS_ROWS[2].sourceCenter,
      ) - distance,
    ) < 1e-9,
  );
  assert.ok(
    Math.abs(
      distance * Math.sin(geodesic.startHeading) -
        C12_29_S5_SVS_SOURCE_MOTION.eastKm,
    ) < 1e-12,
  );
  assert.ok(
    Math.abs(
      distance * Math.cos(geodesic.startHeading) -
        C12_29_S5_SVS_SOURCE_MOTION.northKm,
    ) < 1e-12,
  );
});

test("05 Q and centroid/motion bounds contain only source and quantizer terms", () => {
  const budget = computeSvsFootprintBudget({
    latticePitchKm: 2,
    pixelGroundFootprintKm: 1,
  });
  assert.equal(
    budget.qKm,
    C12_29_S5_SVS_SOURCE_EDGE.maximumAdjacentDistanceKm + 1 + 0.5,
  );
  assert.equal(
    budget.centroidLimitKm,
    C12_29_S5_SVS_SIMON1994_BUDGET_KM + budget.qKm,
  );
  assert.equal(budget.motionVectorLimitKm, 2 * budget.qKm);
  assert.equal(
    budget.speedUncertaintyKmPerHour,
    ((2 * budget.qKm) / 10) * 3600,
  );
  assert.throws(
    () =>
      computeSvsFootprintBudget({
        latticePitchKm: 2,
        pixelGroundFootprintKm: 1,
        sourceMaxAdjacentEdgeKm: 8.155,
      }),
    /frozen design/u,
  );
});

test("06 IoU and observed centroid cannot fit or widen the budget", () => {
  const left = computeSvsFootprintBudget({
    latticePitchKm: 2,
    pixelGroundFootprintKm: 1,
    rawIou: 0,
    observedCentroidKm: 500,
  });
  const right = computeSvsFootprintBudget({
    latticePitchKm: 2,
    pixelGroundFootprintKm: 1,
    rawIou: 1,
    observedCentroidKm: 0,
  });
  assert.deepEqual(left, right);
  const report = greenReport();
  report.sessions.forEach((session) => {
    session.rows.forEach((row) => {
      row.boundary.rawIou = 0;
    });
  });
  assert.equal(foldC1229S5SvsGate(report).status, "STRUCTURAL");
});

test("07 final artifact UUID, status, exit, and report identity fail closed", () => {
  const artifact = finalArtifact("PASS");
  assert.deepEqual(validateSvsFinalArtifactShape(artifact), []);
  assert.equal(exitCodeForSvsStatus("FAIL"), 1);
  assert.equal(exitCodeForSvsStatus("ERROR"), 2);
  artifact.exitCode = 3;
  artifact.report.runId = "alien";
  assert.match(
    validateSvsFinalArtifactShape(artifact).join("\n"),
    /exit code|identity mismatch|pure fold/u,
  );
  const contradictoryFinalChain = finalArtifact("PASS");
  contradictoryFinalChain.report.lifecycle.finalStatus = "FAIL";
  contradictoryFinalChain.report.lifecycle.finalReceipt.status = "FAIL";
  contradictoryFinalChain.report.lifecycle.publicationOrder = [
    "LOCK",
    "RUNNING",
    "ARCHIVE",
    "FIRST_RED",
    "LATEST",
    "RECEIPT",
    "UNLOCK",
  ];
  assert.match(
    validateSvsFinalArtifactShape(contradictoryFinalChain).join("\n"),
    /pure fold/u,
  );
  const shallowRed = {
    schema: C12_29_S5_SVS_SCHEMA,
    runId: RUN_ID,
    generatedAt: "2026-08-13T00:00:00.000Z",
    status: "FAIL",
    exitCode: 1,
    incomplete: false,
    report: { schema: C12_29_S5_SVS_SCHEMA, runId: RUN_ID, status: "FAIL" },
  };
  assert.match(
    validateSvsFinalArtifactShape(shallowRed).join("\n"),
    /report keys|pure fold/u,
  );
  const errorArtifact = finalArtifact("ERROR");
  assert.deepEqual(validateSvsFinalArtifactShape(errorArtifact), []);
  delete errorArtifact.error;
  assert.match(
    validateSvsFinalArtifactShape(errorArtifact).join("\n"),
    /error diagnostic/u,
  );
  const runningArtifact = {
    schema: C12_29_S5_SVS_SCHEMA,
    runId: RUN_ID,
    generatedAt: "2026-08-13T00:00:00.000Z",
    status: "RUNNING",
    incomplete: true,
    nonce: NONCE,
  };
  assert.deepEqual(validateSvsRunningArtifactShape(runningArtifact), []);
  runningArtifact.generatedAt = "2026-08-13T00:00:00Z";
  runningArtifact.unexpected = true;
  assert.match(
    validateSvsRunningArtifactShape(runningArtifact).join("\n"),
    /keys|generatedAt/u,
  );
});

test("08 all three fixture record identifiers are distinct and mandatory", () => {
  expectStatus(
    (report) => {
      report.sessions[0].rows[0].sourceIndexZeroBased = 0;
    },
    "STRUCTURAL",
    /exact NASA row/u,
  );
  expectStatus(
    (report) => {
      report.sessions[0].rows[0].sourceRecordNumber = 1;
    },
    "STRUCTURAL",
    /exact NASA row/u,
  );
  expectStatus(
    (report) => {
      report.sessions[0].rows[0].outputRecordNumber = 545;
    },
    "STRUCTURAL",
    /exact NASA row/u,
  );
});

test("09 fixture member pins, browser parser, WGS84, and exact edge are gated", () => {
  for (const mutate of [
    (report) => (report.provenance.fixtures.shp.sha256 = "0".repeat(64)),
    (report) => (report.sessions[0].fixtureProof.parser = "ad-hoc"),
    (report) =>
      (report.sessions[0].fixtureProof.maximumSourceEdge.distanceKm = 8.155),
    (report) =>
      (report.sessions[0].fixtureProof.recordIdentities[0].sourceRecordNumber = 1),
    (report) =>
      (report.sessions[0].fixtureProof.manifestRecordIdentities[0].sourceRecordNumber = 1),
  ]) {
    expectStatus(mutate, "STRUCTURAL", /fixture|runtime NASA/u);
  }
});

test("10 source-map provenance is absolute, exact, ordered, and one-to-one", () => {
  for (const mutate of [
    (report) =>
      (report.provenance.buildSourceIdentity.entries[0].file =
        C12_29_S5_SVS_BUILD_SOURCE_FILES[0]),
    (report) =>
      (report.provenance.buildSourceIdentity.entries[0].sourceMapEntry =
        "wrong"),
    (report) =>
      (report.provenance.buildSourceIdentity.entries[0].embeddedSha256 =
        "0".repeat(64)),
    (report) => report.provenance.buildSourceIdentity.entries.pop(),
    (report) =>
      report.provenance.buildSourceIdentity.entries.splice(
        C12_29_S5_SVS_BUILD_SOURCE_FILES.indexOf(
          "packages/engine/Source/Core/Cartesian3.js",
        ),
        1,
      ),
    (report) =>
      report.provenance.buildSourceIdentity.entries.splice(
        C12_29_S5_SVS_BUILD_SOURCE_FILES.indexOf(
          "packages/engine/Source/Renderer/Pass.js",
        ),
        1,
      ),
  ]) {
    expectStatus(mutate, "STRUCTURAL", /source-map entries/u);
  }
});

test("11 stable source/build/served/generated identities are structural", () => {
  for (const mutate of [
    (report) => (report.provenance.sourceStable = false),
    (report) => (report.provenance.buildStable = false),
    (report) => (report.provenance.servedEntry.ok = false),
    (report) => (report.provenance.generatedShaders.globeTerrainExact = false),
  ]) {
    expectStatus(mutate, "STRUCTURAL", /unstable|served|shader/u);
  }
});

test("12 true ICRF, real XYS fingerprints, and independent Simon1994 are mandatory", () => {
  for (const mutate of [
    (report) => (report.sessions[0].ephemeris.temeUsed = true),
    (report) => (report.sessions[0].ephemeris.preloadComplete = false),
    (report) => (report.sessions[0].ephemeris.xysFiles = []),
    (report) =>
      (report.sessions[0].ephemeris.maximumMoonPositionDeltaMeters = 1),
    (report) =>
      (report.sessions[0].ephemeris.maximumSunPositionDeltaMeters = NaN),
  ]) {
    expectStatus(mutate, "STRUCTURAL", /ICRF|XYS/u);
  }
});

test("13 neutral scene, derived framing, and no recentering fail closed", () => {
  for (const mutate of [
    (report) => (report.sessions[0].scene.hdr = true),
    (report) => (report.sessions[0].scene.actualMarginPixels = 31),
    (report) => (report.sessions[0].scene.recentered = true),
    (report) => (report.sessions[0].scene.eclipseAutoExposure = false),
    (report) => (report.sessions[0].scene.fixedCameraHeightAcrossRows = false),
    (report) => (report.sessions[0].scene.volumetricFog = true),
    (report) =>
      (report.sessions[0].rows[0].cameraFrame.actualMarginPixels = 31),
  ]) {
    expectStatus(mutate, "STRUCTURAL", /scene|camera/u);
  }
});

test("14 real QuantizedMesh selection/preparation and terrain-pixel mask are gated", () => {
  for (const mutate of [
    (report) => (report.sessions[0].terrain.ellipsoidOnly = true),
    (report) => (report.sessions[0].terrain.fillMeshCount = 1),
    (report) =>
      (report.sessions[0].rows[0].terrainTuple.renderedMeshIsRealMesh = false),
    (report) =>
      (report.sessions[0].rows[0].terrainTuple.selectedPreparedTileSetsMatch = false),
    (report) => (report.sessions[0].terrain.whiteBlackSameCamera = false),
  ]) {
    expectStatus(mutate, "STRUCTURAL", /terrain|tuple/u);
  }
});

test("15 129-square cell-centre lattice is nonvacuous, unique, and exact", () => {
  for (const mutate of [
    (report) => (report.sessions[0].rows[0].lattice.side = 128),
    (report) =>
      (report.sessions[0].rows[0].lattice.validProjectedCellCount = 11_999),
    (report) =>
      (report.sessions[0].rows[0].lattice.duplicateProjectedCellCount = 1),
    (report) => report.sessions[0].rows[0].lattice.classifiedCellIds.reverse(),
  ]) {
    expectStatus(mutate, "STRUCTURAL", /lattice|sorted/u);
  }
});

test("16 serial renderer order, A-H cardinality, and exact clock/frame pins are structural", () => {
  for (const mutate of [
    (report) => report.sessions[0].phaseOrder.pop(),
    (report) => (report.sessions[1].startedAtMs = 199),
    (report) =>
      (report.sessions[0].rows[0].clock.frameStateTimeIso =
        "2024-04-08T18:09:31Z"),
    (report) => report.sessions.reverse(),
    (report) => (report.sessions[0].startedAtMs = NaN),
  ]) {
    expectStatus(mutate, "STRUCTURAL", /phase|overlap|clock|session/u);
  }
});

test("17 ten direct same-task PNGs require unique UUID-bound filenames", () => {
  for (const mutate of [
    (report) => report.sessions[0].images.pop(),
    (report) =>
      (report.sessions[0].images[0].captureMethod = "deferred-drawImage"),
    (report) =>
      (report.sessions[0].images[1].imageId =
        report.sessions[0].images[0].imageId),
    (report) => (report.sessions[0].capture.canonicalSameTask = false),
  ]) {
    expectStatus(mutate, "STRUCTURAL", /capture|expected ten/u);
  }
});

test("18 classifier floors, ratios, and terrain intersection are structural", () => {
  for (const mutate of [
    (report) => (report.sessions[0].rows[0].mask.offMinimumLuminanceCode = 15),
    (report) => (report.sessions[0].rows[0].mask.onOffRatioMaximum = 0.03),
    (report) =>
      (report.sessions[0].rows[0].mask.classificationAppliedOnlyInsideTerrainMask = false),
  ]) {
    expectStatus(mutate, "STRUCTURAL", /classifier/u);
  }
});

test("19 boundary p95/max and erode/dilate containment independently go FAIL", () => {
  const q = greenReport().sessions[0].rows[0].budget.qKm;
  for (const mutate of [
    (report) => (report.sessions[0].rows[0].boundary.p95Km = q + 0.001),
    (report) => (report.sessions[0].rows[0].boundary.maximumKm = 2 * q + 0.001),
    (report) =>
      (report.sessions[0].rows[0].boundary.classifiedOutsideDilatedCount = 1),
    (report) =>
      (report.sessions[0].rows[0].boundary.erodedOutsideClassifiedCount = 1),
  ]) {
    expectStatus(mutate, "STRUCTURAL", /morphology summary/u);
  }
});

test("20 exact morphology-derived area band rejects count and ratio tricks", () => {
  for (const mutate of [
    (report) => (report.sessions[0].rows[0].boundary.erodedNasaCellCount = 601),
    (report) => (report.sessions[0].rows[0].boundary.areaRatio = 0.99),
    (report) => (report.sessions[0].rows[0].boundary.maximumAreaRatio = 0.9),
  ]) {
    expectStatus(mutate, "STRUCTURAL", /morphology summary/u);
  }
});

test("21 absolute centroid uses the independent 40 km Simon1994 budget", () => {
  const limit = greenReport().sessions[0].rows[0].budget.centroidLimitKm;
  expectStatus(
    (report) => {
      report.sessions[0].rows[0].centroid.errorKm = limit + 0.001;
    },
    "STRUCTURAL",
    /centroid summary/u,
  );
  expectStatus(
    (report) => {
      report.sessions[0].rows[0].budget.simon1994BudgetKm = 140;
    },
    "STRUCTURAL",
    /derived budget/u,
  );
});

test("22 raw IoU is reported but never substitutes for morphology", () => {
  expectStatus(
    (report) => {
      report.sessions[0].rows[0].boundary.rawIou = NaN;
    },
    "STRUCTURAL",
    /raw IoU/u,
  );
  const report = greenReport();
  report.sessions[0].rows[0].boundary.rawIou = 0.01;
  assert.equal(foldC1229S5SvsGate(report).status, "STRUCTURAL");
});

test("23 exact east+north motion, 2Q vector, and derived speed uncertainty are gated", () => {
  for (const mutate of [
    (report) => (report.sessions[0].motion.measuredDirectionEast = false),
    (report) =>
      (report.sessions[0].motion.vectorErrorKm =
        report.sessions[0].motion.vectorLimitKm + 0.001),
    (report) =>
      (report.sessions[0].motion.measuredSpeedKmPerHour +=
        report.sessions[0].motion.speedUncertaintyKmPerHour + 1),
  ]) {
    expectStatus(mutate, "STRUCTURAL", /motion budget/u);
  }
  expectStatus(
    (report) => {
      report.sessions[0].motion.sourceSpeedKmPerHour = 2522.2;
    },
    "STRUCTURAL",
    /motion budget/u,
  );
});

test("24 cross-backend differences must stay inside union-Q bands and 2Q centroid", () => {
  expectStatus(
    (report) => {
      report.crossBackend[0].differingCellIds = [500];
      report.crossBackend[0].differingCellCount = 1;
    },
    "STRUCTURAL",
    /cross-backend summary/u,
  );
  expectStatus(
    (report) => {
      report.crossBackend[0].centroidDistanceKm =
        report.crossBackend[0].centroidLimitKm + 0.001;
    },
    "STRUCTURAL",
    /cross-backend summary/u,
  );
});

test("25 noneclipse control allows no classified cell and at most one code boundary", () => {
  for (const mutate of [
    (report) => (report.sessions[0].control.classifiedCellCount = 1),
    (report) => (report.sessions[0].control.oneCodeBoundaryCount = 2),
    (report) =>
      (report.sessions[0].control.clock.currentTimeIso =
        "2024-04-08T06:00:01Z"),
    (report) => delete report.sessions[0].control.oneCodeBoundaryCount,
  ]) {
    expectStatus(mutate, "STRUCTURAL", /noneclipse/u);
  }
});

test("26 lifecycle writes RUNNING+lock, immutable red, latest, then unlocks", (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "c1229-svs-life-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const paths = createSvsArtifactPaths(RUN_ID, temporary);
  const { running } = beginSvsEvidenceRun(paths, RUN_ID);
  assert.equal(JSON.parse(fs.readFileSync(paths.latest)).status, "RUNNING");
  assert.equal(JSON.parse(fs.readFileSync(paths.lock)).nonce, running.nonce);
  const artifact = finalArtifact("FAIL");
  const publication = publishSvsFinalArtifact(paths, artifact, running);
  assert.equal(publication.archive.sha256, publication.latest.sha256);
  assert.equal(publication.firstRed.exists, true);
  assert.equal(fs.existsSync(paths.lock), false);
  assert.equal(JSON.parse(fs.readFileSync(paths.latest)).status, "FAIL");
});

test("27 lifecycle rejects prior RUNNING, extant lock, and alien ownership", (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "c1229-svs-own-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const paths = createSvsArtifactPaths(RUN_ID, temporary);
  const { running } = beginSvsEvidenceRun(paths, RUN_ID);
  assert.throws(() => inspectSvsPriorState(paths), /lock already exists/u);
  const alien = { ...running, nonce: randomNonce() };
  assert.throws(
    () =>
      publishSvsFinalArtifact(
        paths,
        { schema: C12_29_S5_SVS_SCHEMA, status: "PASS" },
        alien,
      ),
    /ownership/u,
  );
});

function randomNonce() {
  return "323e4567-e89b-42d3-a456-426614174000";
}

test("28 publication tolerates move-then-throw but detects silent unlock", (t) => {
  const moved = fs.mkdtempSync(path.join(os.tmpdir(), "c1229-svs-move-"));
  const stuck = fs.mkdtempSync(path.join(os.tmpdir(), "c1229-svs-stuck-"));
  t.after(() => {
    fs.rmSync(moved, { recursive: true, force: true });
    fs.rmSync(stuck, { recursive: true, force: true });
  });
  const artifact = finalArtifact("PASS");
  {
    const paths = createSvsArtifactPaths(RUN_ID, moved);
    const { running } = beginSvsEvidenceRun(paths, RUN_ID);
    const operations = Object.create(fs);
    operations.renameSync = (from, to) => {
      fs.renameSync(from, to);
      throw new Error("rename moved then threw");
    };
    const result = publishSvsFinalArtifact(
      paths,
      artifact,
      running,
      operations,
    );
    assert.equal(result.archive.sha256, result.latest.sha256);
  }
  {
    const paths = createSvsArtifactPaths(RUN_ID, stuck);
    const { running } = beginSvsEvidenceRun(paths, RUN_ID);
    const operations = Object.create(fs);
    operations.unlinkSync = () => {};
    assert.throws(
      () => publishSvsFinalArtifact(paths, artifact, running, operations),
      /silent no-op|could not prove|cleanup receipt|reconciliation retained ownership evidence/u,
    );
    assert.equal(fs.existsSync(paths.lock), true);
  }
});

test("29 loopback validation rejects credentials, paths, public hosts, and queries", () => {
  assert.equal(
    validateSvsLoopbackBase("http://localhost:8080").origin,
    "http://localhost:8080",
  );
  for (const value of [
    "https://example.com",
    "http://user:pass@localhost:8080",
    "http://localhost:8080/path",
    "http://localhost:8080/?token=secret",
  ]) {
    assert.throws(() => validateSvsLoopbackBase(value), /loopback root/u);
  }
});

test("30 probe embeds canonical same-task capture and forbids fallback/recentering", () => {
  assert.deepEqual(checkEmbeddedCaptureIsCanonical(probeSource), []);
  assert.deepEqual(checkEmbeddedFusedSnapshotIsCanonical(probeSource), []);
  assert.deepEqual(checkFusedCaptureUsage(probeSource), []);
  assert.match(probeSource, /computeIcrfToFixedMatrix/u);
  assert.doesNotMatch(probeSource, /computeTemeToPseudoFixedMatrix/u);
  assert.doesNotMatch(
    probeSource,
    /(?:translate|recenter)\w*\s*\(|(?:recentered|translatedToModel)\s*:\s*true/iu,
  );
  assert.match(probeSource, /parseSvs5073UmbraShapefile/u);
  assert.match(probeSource, /inspectBuildSourceIdentity/u);
  assert.match(probeSource, /scene\.render\(timeFn\(\)\)/u);
});

test("31 semantic source boundary is complete and raw shaders are map-excluded", () => {
  assert.equal(C12_29_S5_SVS_SOURCE_FILES.length, 51);
  assert.equal(C12_29_S5_SVS_BUILD_SOURCE_FILES.length, 49);
  for (const required of [
    "packages/engine/Source/Core/Cartesian2.js",
    "packages/engine/Source/Core/Cartesian3.js",
    "packages/engine/Source/Core/Cartographic.js",
    "packages/engine/Source/Core/Color.js",
    "packages/engine/Source/Core/EllipsoidGeodesic.js",
    "packages/engine/Source/Core/JulianDate.js",
    "packages/engine/Source/Core/Math.js",
    "packages/engine/Source/Core/Matrix3.js",
    "packages/engine/Source/Core/TimeInterval.js",
    "packages/engine/Source/Core/Transforms.js",
    "packages/engine/Source/Core/Iau2006XysData.js",
    "packages/engine/Source/Core/Simon1994PlanetaryPositions.js",
    "packages/engine/Source/Scene/QuadtreePrimitive.js",
    "packages/engine/Source/Scene/SceneTransforms.js",
    "packages/engine/Source/Renderer/Pass.js",
    "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts",
    "packages/engine/Source/Shaders/GlobeFS.glsl",
    "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
  ]) {
    assert.ok(C12_29_S5_SVS_SOURCE_FILES.includes(required), required);
  }
  assert.ok(
    C12_29_S5_SVS_BUILD_SOURCE_FILES.every(
      (file) => !file.endsWith(".glsl") && !file.endsWith(".wgsl"),
    ),
  );
  assert.match(helperSource, /currentSha256 !== entry\?\.embeddedSha256/u);
});

test("32 watchdog returns fast work and closes then drains timed-out work", async () => {
  assert.equal(
    await withSvsWatchdog(
      async () => 7,
      async () => {},
      100,
    ),
    7,
  );
  let closed = false;
  await assert.rejects(
    () =>
      withSvsWatchdog(
        () => new Promise((resolve) => setTimeout(resolve, 20)),
        async () => {
          closed = true;
        },
        1,
      ),
    /watchdog expired.*drained=true/u,
  );
  assert.equal(closed, true);
  let closeTimeout;
  try {
    await withSvsWatchdog(
      () => new Promise((resolve) => setTimeout(resolve, 20)),
      () => new Promise(() => {}),
      1,
      2,
    );
    assert.fail("watchdog should reject");
  } catch (error) {
    closeTimeout = error;
  }
  assert.match(closeTimeout.message, /watchdog expired.*drained=true/u);
  assert.equal(closeTimeout.diagnostics.closeTimedOut, true);
});

test("33 fused snapshot validator and metric bindings reject split evidence", () => {
  const split = `${probeSource}\nawait captureNow();\ngrabNow();\n`;
  assert.match(checkFusedCaptureUsage(split).join(";"), /different renders/u);
  assert.match(
    checkFusedCaptureUsage(`${probeSource}\ncaptureSnapshot();\n`).join(";"),
    /not awaited/u,
  );
  expectStatus(
    (report) => {
      report.sessions[0].rows[0].metricImageBindings.off.sha256 = "0".repeat(
        64,
      );
    },
    "STRUCTURAL",
    /metric\/PNG binding/u,
  );
  expectStatus(
    (report) => {
      report.sessions[0].control.metricImageBindings.on.imageId = imageId(999);
    },
    "STRUCTURAL",
    /metric\/PNG binding/u,
  );
});

test("34 primitive recomputation rejects widened bands and summary lies", () => {
  for (const mutate of [
    (report) =>
      report.sessions[0].rows[0].lattice.qBoundaryBandCellIds.push(12_001),
    (report) => (report.sessions[0].rows[0].centroid.errorKm += 1),
    (report) => (report.crossBackend[0].centroidDistanceKm = 1),
  ]) {
    expectStatus(mutate, "STRUCTURAL", /derived|summary|sorted/u);
  }
});

test("35 daylight control and served XYS identities are nonvacuous", () => {
  for (const [mutate, pattern] of [
    [
      (report) =>
        (report.sessions[0].control.clock.currentTimeIso =
          "2024-04-09T18:17:16Z"),
      /noneclipse/u,
    ],
    [
      (report) =>
        (report.sessions[0].control.cameraFrame.centerLonLat[0] += 0.01),
      /noneclipse/u,
    ],
    [
      (report) => report.sessions[0].control.terrainTuple.captureFrameNumber++,
      /terrain tuple/u,
    ],
    [
      (report) =>
        report.sessions[0].control.lattice.classifiedCellIds.push(
          report.sessions[0].control.lattice.terrainCellIds[0],
        ),
      /classifier/u,
    ],
    [
      (report) => {
        report.sessions[0].control.lattice.terrainCellIds = [];
        report.sessions[0].control.mask.terrainPixelCount = 0;
      },
      /projection\/terrain|classifier/u,
    ],
    [
      (report) => {
        report.sessions[0].control.mask.offBrightTerrainCellIds = [];
        report.sessions[0].control.mask.offBrightTerrainPixelCount = 0;
      },
      /classifier/u,
    ],
    [
      (report) =>
        (report.sessions[0].ephemeris.xysFiles[0].localStart.sha256 =
          "0".repeat(64)),
      /XYS/u,
    ],
  ]) {
    expectStatus(mutate, "STRUCTURAL", pattern);
  }
});

test("36 lifecycle preserves late foreign owners and recovers stale RUNNING", (t) => {
  const directories = [];
  t.after(() => {
    for (const directory of directories) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  const make = (prefix) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    directories.push(directory);
    return createSvsArtifactPaths(RUN_ID, directory);
  };
  const foreign = {
    schema: C12_29_S5_SVS_SCHEMA,
    runId: "323e4567-e89b-42d3-a456-426614174000",
    nonce: "423e4567-e89b-42d3-a456-426614174000",
    status: "RUNNING",
    incomplete: true,
    generatedAt: "2026-08-12T00:00:00.000Z",
  };
  const foreignBytes = Buffer.from(`${JSON.stringify(foreign, null, 2)}\n`);
  const lateForeign = {
    ...foreign,
    runId: "523e4567-e89b-42d3-a456-426614174000",
    nonce: "623e4567-e89b-42d3-a456-426614174000",
  };
  const lateForeignBytes = Buffer.from(
    `${JSON.stringify(lateForeign, null, 2)}\n`,
  );
  const newerForeign = {
    ...foreign,
    runId: "723e4567-e89b-42d3-a456-426614174000",
    nonce: "823e4567-e89b-42d3-a456-426614174000",
  };
  const newerForeignBytes = Buffer.from(
    `${JSON.stringify(newerForeign, null, 2)}\n`,
  );
  {
    const paths = make("c1229-svs-foreign-absent-latest-");
    const operations = Object.create(fs);
    operations.linkSync = (from, to) => {
      fs.writeFileSync(paths.latest, foreignBytes, { flag: "wx" });
      return fs.linkSync(from, to);
    };
    assert.throws(
      () => beginSvsEvidenceRun(paths, RUN_ID, operations),
      /EEXIST|latest/u,
    );
    assert.deepEqual(fs.readFileSync(paths.latest), foreignBytes);
    assert.equal(
      fs.readdirSync(paths.directory).some((file) => file.endsWith(".prior")),
      false,
    );
  }
  {
    const paths = make("c1229-svs-foreign-pair-after-exclusive-create-");
    const lateForeignLockBytes = Buffer.from(
      `${JSON.stringify(
        {
          ...lateForeign,
          kind: "exclusive-run-lock",
          released: false,
        },
        null,
        2,
      )}\n`,
    );
    const operations = Object.create(fs);
    let injected = false;
    operations.linkSync = (from, to) => {
      const result = fs.linkSync(from, to);
      if (!injected && to === paths.latest) {
        injected = true;
        fs.writeFileSync(paths.lock, lateForeignLockBytes);
        fs.writeFileSync(paths.latest, lateForeignBytes);
      }
      return result;
    };
    operations.renameSync = (from, to) => {
      fs.renameSync(from, to);
      if (from === paths.latest && to.includes(".failed.")) {
        throw new Error("synthetic exclusive claim moved then threw");
      }
    };
    assert.throws(
      () => beginSvsEvidenceRun(paths, RUN_ID, operations),
      /ownership/u,
    );
    assert.deepEqual(fs.readFileSync(paths.latest), lateForeignBytes);
    assert.deepEqual(fs.readFileSync(paths.lock), lateForeignLockBytes);
  }
  {
    const paths = make("c1229-svs-corrupt-latest-shape-");
    const corruptBytes = Buffer.from(
      `${JSON.stringify({
        schema: C12_29_S5_SVS_SCHEMA,
        runId: RUN_ID,
        status: "PASS",
        exitCode: 0,
        incomplete: false,
      })}\n`,
    );
    fs.mkdirSync(paths.directory, { recursive: true });
    fs.writeFileSync(paths.latest, corruptBytes, { flag: "wx" });
    assert.throws(() => beginSvsEvidenceRun(paths, RUN_ID), /latest shape/u);
    assert.deepEqual(fs.readFileSync(paths.latest), corruptBytes);
  }
  for (const [name, mutate] of [
    ["extra-key", (value) => (value.unexpected = true)],
    ["missing-generated-at", (value) => delete value.generatedAt],
    [
      "noncanonical-generated-at",
      (value) => (value.generatedAt = "2026-08-12T00:00:00Z"),
    ],
    ["invalid-generated-at", (value) => (value.generatedAt = "not-a-date")],
    ["missing-nonce", (value) => delete value.nonce],
    ["invalid-nonce", (value) => (value.nonce = "not-a-uuid")],
    ["invalid-run-id", (value) => (value.runId = "not-a-uuid")],
    ["wrong-schema", (value) => (value.schema = "alien")],
    ["wrong-status", (value) => (value.status = "PASS")],
    ["wrong-incomplete", (value) => (value.incomplete = false)],
  ]) {
    const paths = make(`c1229-svs-malformed-running-${name}-`);
    fs.mkdirSync(paths.directory, { recursive: true });
    const malformed = structuredClone(foreign);
    mutate(malformed);
    const malformedBytes = Buffer.from(
      `${JSON.stringify(malformed, null, 2)}\n`,
    );
    fs.writeFileSync(paths.latest, malformedBytes, { flag: "wx" });
    assert.throws(() => beginSvsEvidenceRun(paths, RUN_ID), /latest shape/u);
    assert.deepEqual(fs.readFileSync(paths.latest), malformedBytes, name);
    assert.equal(fs.existsSync(paths.lock), false, name);
    assert.equal(
      fs
        .readdirSync(paths.directory)
        .some((file) => file.includes(".recovered-")),
      false,
      name,
    );
  }
  {
    const paths = make("c1229-svs-foreign-begin-");
    const operations = Object.create(fs);
    operations.linkSync = (from, to) => {
      fs.writeFileSync(paths.lock, foreignBytes);
      fs.linkSync(from, to);
    };
    assert.throws(
      () => beginSvsEvidenceRun(paths, RUN_ID, operations),
      /ownership/u,
    );
    assert.deepEqual(fs.readFileSync(paths.lock), foreignBytes);
    assert.equal(fs.existsSync(paths.latest), false);
  }
  {
    const paths = make("c1229-svs-foreign-final-");
    const ownership = beginSvsEvidenceRun(paths, RUN_ID);
    const operations = Object.create(fs);
    operations.linkSync = (from, to) => {
      fs.writeFileSync(to, foreignBytes, { flag: "wx" });
      fs.linkSync(from, to);
    };
    assert.throws(
      () =>
        publishSvsFinalArtifact(
          paths,
          finalArtifact("PASS"),
          ownership,
          operations,
        ),
      /EEXIST|publication|latest/u,
    );
    assert.deepEqual(fs.readFileSync(paths.latest), foreignBytes);
  }
  {
    const paths = make("c1229-svs-late-latest-move-then-throw-");
    fs.mkdirSync(paths.directory, { recursive: true });
    fs.writeFileSync(paths.latest, foreignBytes, { flag: "wx" });
    const operations = Object.create(fs);
    operations.linkSync = (from, to) => {
      if (to === paths.latest) {
        fs.writeFileSync(paths.latest, lateForeignBytes, { flag: "wx" });
      }
      return fs.linkSync(from, to);
    };
    operations.renameSync = (from, to) => {
      fs.renameSync(from, to);
      if (from === paths.latest && to.includes(".failed.")) {
        throw new Error("synthetic failed-latest claim moved then threw");
      }
    };
    assert.throws(
      () => beginSvsEvidenceRun(paths, RUN_ID, operations),
      /EEXIST|latest replacement/u,
    );
    assert.deepEqual(fs.readFileSync(paths.latest), lateForeignBytes);
    assert.notDeepEqual(fs.readFileSync(paths.latest), foreignBytes);
    assert.equal(
      fs
        .readdirSync(paths.directory)
        .some((file) => file.includes(".failed.") && file.endsWith(".receipt")),
      false,
    );
  }
  {
    const paths = make("c1229-svs-late-foreign-pair-");
    fs.mkdirSync(paths.directory, { recursive: true });
    fs.writeFileSync(paths.latest, foreignBytes, { flag: "wx" });
    const lateForeignLockBytes = Buffer.from(
      `${JSON.stringify(
        {
          ...lateForeign,
          kind: "exclusive-run-lock",
          released: false,
        },
        null,
        2,
      )}\n`,
    );
    const operations = Object.create(fs);
    operations.linkSync = (from, to) => {
      if (to === paths.latest) {
        fs.writeFileSync(paths.lock, lateForeignLockBytes);
        fs.writeFileSync(paths.latest, lateForeignBytes, { flag: "wx" });
      }
      return fs.linkSync(from, to);
    };
    assert.throws(
      () => beginSvsEvidenceRun(paths, RUN_ID, operations),
      /EEXIST|latest replacement/u,
    );
    assert.deepEqual(fs.readFileSync(paths.latest), lateForeignBytes);
    assert.deepEqual(fs.readFileSync(paths.lock), lateForeignLockBytes);
  }
  {
    const paths = make("c1229-svs-unsafe-foreign-restore-");
    fs.mkdirSync(paths.directory, { recursive: true });
    fs.writeFileSync(paths.latest, foreignBytes, { flag: "wx" });
    const operations = Object.create(fs);
    let latestLinkCount = 0;
    operations.linkSync = (from, to) => {
      if (to === paths.latest) {
        latestLinkCount++;
        fs.writeFileSync(
          paths.latest,
          latestLinkCount === 1 ? lateForeignBytes : newerForeignBytes,
          { flag: "wx" },
        );
      }
      return fs.linkSync(from, to);
    };
    assert.throws(
      () => beginSvsEvidenceRun(paths, RUN_ID, operations),
      /reconciliation retained ownership evidence/u,
    );
    assert.deepEqual(fs.readFileSync(paths.latest), newerForeignBytes);
    const failedReceipts = fs
      .readdirSync(paths.directory)
      .filter((file) => file.includes(".failed.") && file.endsWith(".receipt"));
    assert.equal(failedReceipts.length, 1);
    assert.deepEqual(
      fs.readFileSync(path.join(paths.directory, failedReceipts[0])),
      lateForeignBytes,
    );
  }
  {
    const paths = make("c1229-svs-recovery-");
    fs.mkdirSync(paths.directory, { recursive: true });
    fs.writeFileSync(paths.latest, foreignBytes);
    const ownership = beginSvsEvidenceRun(paths, RUN_ID);
    assert.ok(ownership.recovery);
    assert.deepEqual(fs.readFileSync(ownership.recovery), foreignBytes);
  }
  {
    const firstRunId = "523e4567-e89b-42d3-a456-426614174000";
    const secondRunId = "623e4567-e89b-42d3-a456-426614174000";
    const firstPaths = make("c1229-svs-recovery-retry-");
    fs.mkdirSync(firstPaths.directory, { recursive: true });
    fs.writeFileSync(firstPaths.latest, foreignBytes);
    const recovery = `${firstPaths.latest}.recovered-${foreign.runId}.json`;
    const operations = Object.create(fs);
    operations.linkSync = (from, to) => {
      if (to === firstPaths.latest) {
        throw new Error("synthetic post-recovery publication failure");
      }
      return fs.linkSync(from, to);
    };
    assert.throws(
      () =>
        beginSvsEvidenceRun(
          createSvsArtifactPaths(firstRunId, firstPaths.directory),
          firstRunId,
          operations,
        ),
      /post-recovery publication failure/u,
    );
    assert.equal(fs.existsSync(firstPaths.lock), false);
    assert.deepEqual(fs.readFileSync(firstPaths.latest), foreignBytes);
    assert.deepEqual(fs.readFileSync(recovery), foreignBytes);

    const secondPaths = createSvsArtifactPaths(
      secondRunId,
      firstPaths.directory,
    );
    const second = beginSvsEvidenceRun(secondPaths, secondRunId);
    assert.equal(second.prior.latest.runId, foreign.runId);
    assert.deepEqual(fs.readFileSync(recovery), foreignBytes);
    assert.equal(
      JSON.parse(fs.readFileSync(secondPaths.latest)).runId,
      secondRunId,
    );
  }
  for (const [name, receiptBytes, inject, pattern] of [
    [
      "corrupt-recovery",
      Buffer.from("not-json"),
      () => {},
      /recovery receipt is not exact JSON/u,
    ],
    [
      "foreign-recovery",
      Buffer.from(
        `${JSON.stringify(
          { ...foreign, runId: "723e4567-e89b-42d3-a456-426614174000" },
          null,
          2,
        )}\n`,
      ),
      () => {},
      /recovery receipt differs/u,
    ],
    [
      "deleted-recovery",
      foreignBytes,
      (paths, recovery, operations) => {
        let receiptReads = 0;
        operations.readFileSync = (file, options) => {
          if (file === recovery && ++receiptReads === 1) fs.unlinkSync(file);
          return fs.readFileSync(file, options);
        };
      },
      /recovery receipt is unreadable/u,
    ],
    [
      "unreadable-recovery",
      foreignBytes,
      (_paths, recovery, operations) => {
        operations.readFileSync = (file, options) => {
          if (file === recovery) {
            throw Object.assign(new Error("synthetic denied"), {
              code: "EACCES",
            });
          }
          return fs.readFileSync(file, options);
        };
      },
      /recovery receipt is unreadable/u,
    ],
  ]) {
    const runId = "823e4567-e89b-42d3-a456-426614174000";
    const paths = make(`c1229-svs-${name}-`);
    fs.mkdirSync(paths.directory, { recursive: true });
    fs.writeFileSync(paths.latest, foreignBytes);
    const recovery = `${paths.latest}.recovered-${foreign.runId}.json`;
    fs.writeFileSync(recovery, receiptBytes, { flag: "wx" });
    const operations = Object.create(fs);
    inject(paths, recovery, operations);
    assert.throws(
      () =>
        beginSvsEvidenceRun(
          createSvsArtifactPaths(runId, paths.directory),
          runId,
          operations,
        ),
      pattern,
      name,
    );
    assert.deepEqual(fs.readFileSync(paths.latest), foreignBytes, name);
    assert.equal(fs.existsSync(paths.lock), false, name);
  }
  {
    const paths = make("c1229-svs-foreign-unlock-");
    const ownership = beginSvsEvidenceRun(paths, RUN_ID);
    const operations = Object.create(fs);
    operations.renameSync = (from, to) => {
      if (from === paths.lock && to.includes(".release.")) {
        fs.writeFileSync(paths.lock, foreignBytes);
      }
      fs.renameSync(from, to);
    };
    assert.throws(
      () =>
        publishSvsFinalArtifact(
          paths,
          finalArtifact("PASS"),
          ownership,
          operations,
        ),
      /release claim/u,
    );
    assert.deepEqual(fs.readFileSync(paths.lock), foreignBytes);
  }
  {
    const paths = make("c1229-svs-foreign-post-lock-claim-");
    const ownership = beginSvsEvidenceRun(paths, RUN_ID);
    const operations = Object.create(fs);
    operations.renameSync = (from, to) => {
      fs.renameSync(from, to);
      if (from === paths.lock && to.includes(".release.")) {
        fs.writeFileSync(paths.lock, foreignBytes, { flag: "wx" });
      }
    };
    assert.throws(
      () =>
        publishSvsFinalArtifact(
          paths,
          finalArtifact("PASS"),
          ownership,
          operations,
        ),
      /canonical lock|release/u,
    );
    assert.deepEqual(fs.readFileSync(paths.lock), foreignBytes);
  }
  {
    const paths = make("c1229-svs-foreign-latest-before-unlock-");
    const ownership = beginSvsEvidenceRun(paths, RUN_ID);
    const operations = Object.create(fs);
    operations.writeFileSync = (file, data, options) => {
      const result = fs.writeFileSync(file, data, options);
      if (file === paths.finalReceipt) {
        fs.writeFileSync(paths.latest, foreignBytes);
      }
      return result;
    };
    assert.throws(
      () =>
        publishSvsFinalArtifact(
          paths,
          finalArtifact("PASS"),
          ownership,
          operations,
        ),
      /final latest changed/u,
    );
    assert.deepEqual(fs.readFileSync(paths.latest), foreignBytes);
    assert.equal(fs.existsSync(paths.lock), true);
  }
});

test("37 primitive lattice is absolutely anchored to the frozen bbox and ring", () => {
  expectStatus(
    (report) => {
      for (const session of report.sessions) {
        for (const row of session.rows) {
          row.lattice.cellLonLat = row.lattice.cellLonLat.map(
            ([id, longitude, latitude]) => [id, longitude + 10, latitude],
          );
          const derived = deriveSvsSpatialMetrics(row);
          row.lattice.qBoundaryBandCellIds = derived.qBoundaryBandCellIds;
          row.boundary = derived.boundary;
          row.centroid = derived.centroid;
        }
      }
      report.crossBackend.forEach((entry) => (entry.centroidDistanceKm = 0));
    },
    "STRUCTURAL",
    /cell centres/u,
  );
  for (const [mutate, pattern] of [
    [(row) => row.lattice.cellLonLat.reverse(), /primitive cell coordinates/u],
    [
      (row) => {
        const removed = row.lattice.nasaInsideCellIds.pop();
        row.lattice.nasaInsideCount--;
        row.lattice.nasaOutsideCount++;
        row.lattice.classifiedCellIds = row.lattice.classifiedCellIds.filter(
          (id) => id !== removed,
        );
        row.mask.classifiedCellCount = row.lattice.classifiedCellIds.length;
        const derived = deriveSvsSpatialMetrics(row);
        row.lattice.qBoundaryBandCellIds = derived.qBoundaryBandCellIds;
        row.boundary = derived.boundary;
        row.centroid = derived.centroid;
      },
      /NASA membership/u,
    ],
    [
      (row) => row.lattice.qBoundaryBandCellIds.push(99_999),
      /out of range|sorted/u,
    ],
    [
      (row) =>
        row.fixtureGeometry.bbox.splice(0, 1, row.fixtureGeometry.bbox[0] + 1),
      /fixture geometry/u,
    ],
    [(row) => (row.fixtureGeometry.ring[0][0] += 1), /fixture geometry/u],
  ]) {
    expectStatus(
      (report) => mutate(report.sessions[0].rows[0]),
      "STRUCTURAL",
      pattern,
    );
  }
});

test("38 selection events and emitted command owners are independent and exact", () => {
  for (const [mutate, pattern] of [
    [
      (tuple) => tuple.selectedTileIds.splice(0, 1, "1/0/2"),
      /selected\/prepared terrain tuple/u,
    ],
    [
      (tuple) => tuple.preparedSelectedTileIds.splice(0, 1, "1/0/2"),
      /selected\/prepared terrain tuple/u,
    ],
    [
      (tuple) => tuple.selectedRealTileIds.pop(),
      /selected\/prepared terrain tuple|terrain selection/u,
    ],
    [
      (tuple) => tuple.selectedFillTileIds.push("1/0/1"),
      /selected\/prepared terrain tuple/u,
    ],
    [
      (tuple) => tuple.preparedFrameNumber++,
      /selected\/prepared terrain tuple/u,
    ],
    [
      (tuple) => tuple.captureFrameNumber++,
      /selected\/prepared terrain tuple/u,
    ],
    [
      (tuple) => {
        tuple.selectedTileIds.push("1/0/2");
        tuple.preparedSelectedTileIds.push("1/0/2");
        tuple.selectionEventCount++;
        tuple.preparedCommandCount++;
      },
      /selected\/prepared terrain tuple/u,
    ],
    [
      (tuple) => {
        tuple.surfaceRadiusMeters = 0;
        tuple.providerSurfaceRadiusMeters = 0;
      },
      /selected\/prepared terrain tuple/u,
    ],
    [
      (tuple) => tuple.providerSelectionRevision++,
      /selected\/prepared terrain tuple/u,
    ],
    [
      (tuple) => tuple.selectionEventCount++,
      /selected\/prepared terrain tuple/u,
    ],
    [
      (tuple) => {
        tuple.selectedContent[0].terrainDataObjectId++;
        tuple.selectionContentIdentity = JSON.stringify({
          selected: tuple.selectedContent,
          prepared: tuple.preparedContent,
        });
      },
      /terrain selection\/content identity/u,
    ],
    [
      (tuple) => {
        tuple.preparedContent[0].renderedMeshObjectId++;
        tuple.preparedContent[0].realMeshObjectId++;
        tuple.selectionContentIdentity = JSON.stringify({
          selected: tuple.selectedContent,
          prepared: tuple.preparedContent,
        });
      },
      /terrain selection\/content identity/u,
    ],
  ]) {
    expectStatus(
      (report) => mutate(report.sessions[0].rows[0].terrainTuple),
      "STRUCTURAL",
      pattern,
    );
  }
  assert.match(probeSource, /showTileThisFrame\s*=\s*\(tile, frameState\)/u);
  assert.match(
    probeSource,
    /content:\s*Object\.freeze\(contentRecord\(tile\)\)/u,
  );
  assert.match(
    probeSource,
    /const selectedContent = selectionEvents\s*\.map\(\(event\) => \(\{ \.\.\.event\.content \}\)\)/u,
  );
  assert.match(
    probeSource,
    /const preparedContent = commandOwners\s*\.map\(contentRecord\)/u,
  );
  assert.doesNotMatch(
    probeSource,
    /const selectedContent\s*=\s*(?:preparedContent|commandOwners)|const preparedContent\s*=\s*(?:selectedContent|selectionEvents)/u,
  );
  assert.match(
    probeSource,
    /frameState\.commandList\s*\.slice\(commandListStart\)/u,
  );
  assert.doesNotMatch(probeSource, /_quadtree\?\._tilesToRender/u);
  for (const [mutate, pattern] of [
    [
      (row) =>
        (row.transitionReadiness.forcedRenderBeforeFirstReadinessCheck = false),
      /render-first readiness/u,
    ],
    [
      (row) => (row.transitionReadiness.observations = []),
      /render-first readiness/u,
    ],
    [
      (row) =>
        (row.transitionReadiness.observations[1].tuple.selectionRevision =
          row.transitionReadiness.observations[0].tuple.selectionRevision),
      /consecutive readiness|terrain tuple/u,
    ],
    [
      (row) =>
        (row.transitionReadiness.observations[1].tuple.cameraIdentity =
          "stale-camera"),
      /readiness identity|terrain tuple/u,
    ],
    [
      (row) =>
        (row.captureTerrainProofs[1].tuple.tilesLoadedAfterRender = false),
      /terrain tuple/u,
    ],
    [
      (row) => (row.captureTerrainProofs[2].tuple.providerContentRevision += 1),
      /inter-capture|terrain tuple/u,
    ],
    [
      (row) =>
        (row.captureTerrainProofs[2].tuple.selectionContentIdentity =
          "drifted-selection-content"),
      /inter-capture|content identity/u,
    ],
  ]) {
    expectStatus(
      (report) => mutate(report.sessions[0].rows[0]),
      "STRUCTURAL",
      pattern,
    );
  }
  assert.match(
    probeSource,
    /scene\.render\(timeFn\(\)\);\s*renderCount\+\+;\s*const tuple = preparedTuple/u,
  );
  assert.doesNotMatch(
    probeSource,
    /settleThen\(120, \(\) => globe\.tilesLoaded === true\)/u,
  );
});

test("39 first-red remains exact across EEXIST, substitution, deletion, and read races", (t) => {
  const directories = [];
  t.after(() => {
    for (const directory of directories) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  const make = (prefix) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    directories.push(directory);
    return createSvsArtifactPaths(RUN_ID, directory);
  };
  const foreignArtifact = finalArtifact(
    "FAIL",
    "323e4567-e89b-42d3-a456-426614174000",
  );
  const foreignBytes = Buffer.from(
    `${JSON.stringify(foreignArtifact, null, 2)}\n`,
  );
  {
    const paths = make("c1229-svs-first-red-baseline-");
    fs.mkdirSync(paths.directory, { recursive: true });
    fs.writeFileSync(paths.firstRed, foreignBytes, { flag: "wx" });
    const ownership = beginSvsEvidenceRun(paths, RUN_ID);
    const publication = publishSvsFinalArtifact(
      paths,
      finalArtifact("FAIL"),
      ownership,
    );
    assert.equal(publication.firstRed.written, false);
    assert.equal(publication.firstRedStable, true);
    assert.equal(publication.firstRedStabilityChecks, 3);
    assert.deepEqual(publication.firstRedCurrent, publication.firstRedBaseline);
    assert.deepEqual(fs.readFileSync(paths.firstRed), foreignBytes);
  }
  for (const [name, inject, pattern] of [
    [
      "corrupt-eexist",
      (paths, operations) => {
        operations.writeFileSync = (file, data, options) => {
          if (file === paths.firstRed && options?.flag === "wx") {
            fs.writeFileSync(file, Buffer.from("not-json"), { flag: "wx" });
          }
          return fs.writeFileSync(file, data, options);
        };
      },
      /first-red/u,
    ],
    [
      "valid-foreign-eexist",
      (paths, operations) => {
        operations.writeFileSync = (file, data, options) => {
          if (file === paths.firstRed && options?.flag === "wx") {
            fs.writeFileSync(file, foreignBytes, { flag: "wx" });
          }
          return fs.writeFileSync(file, data, options);
        };
      },
      /late first-red owner/u,
    ],
    [
      "substitution",
      (paths, operations) => {
        let existingReads = 0;
        operations.readFileSync = (file, options) => {
          if (file === paths.firstRed && fs.existsSync(file)) {
            existingReads++;
            if (existingReads === 2) fs.writeFileSync(file, foreignBytes);
          }
          return fs.readFileSync(file, options);
        };
      },
      /stability/u,
    ],
    [
      "deletion",
      (paths, operations) => {
        let existingReads = 0;
        operations.readFileSync = (file, options) => {
          if (file === paths.firstRed && fs.existsSync(file)) {
            existingReads++;
            if (existingReads === 2) fs.unlinkSync(file);
          }
          return fs.readFileSync(file, options);
        };
      },
      /stability/u,
    ],
    [
      "read-error",
      (paths, operations) => {
        let existingReads = 0;
        operations.readFileSync = (file, options) => {
          if (file === paths.firstRed && fs.existsSync(file)) {
            existingReads++;
            if (existingReads === 2) {
              throw Object.assign(new Error("synthetic denied"), {
                code: "EACCES",
              });
            }
          }
          return fs.readFileSync(file, options);
        };
      },
      /unreadable/u,
    ],
  ]) {
    const paths = make(`c1229-svs-first-red-${name}-`);
    const ownership = beginSvsEvidenceRun(paths, RUN_ID);
    const operations = Object.create(fs);
    inject(paths, operations);
    assert.throws(
      () =>
        publishSvsFinalArtifact(
          paths,
          finalArtifact("FAIL"),
          ownership,
          operations,
        ),
      pattern,
    );
    assert.equal(fs.existsSync(paths.lock), true, name);
  }
  assert.doesNotMatch(
    probeSource,
    /lifecycle:\s*\{\s*firstRedStable:\s*true/su,
  );
  assert.match(probeSource, /ownership\.firstRedBaselineValidated/u);
  assert.match(
    probeSource,
    /firstRedSnapshotsEqual\(\s*ownership\.firstRedBaseline/u,
  );
  expectStatus(
    (report) => (report.lifecycle.firstRedCurrent.sha256 = "f".repeat(64)),
    "STRUCTURAL",
    /lifecycle/u,
  );
});

test("40 page/context closure and request accounting are observed and bounded", async () => {
  const closed = await closeSvsResourceBounded(
    { close: async () => {} },
    "page",
    50,
  );
  assert.equal(closed.closed, true);
  const rejected = await closeSvsResourceBounded(
    { close: async () => Promise.reject(new Error("close rejected")) },
    "context",
    50,
  );
  assert.equal(rejected.closed, false);
  assert.match(rejected.error.message, /close rejected/u);
  const hung = await closeSvsResourceBounded(
    { close: () => new Promise(() => {}) },
    "browser",
    2,
  );
  assert.equal(hung.timedOut, true);
  let undrained;
  try {
    await withSvsWatchdog(
      () => new Promise(() => {}),
      async () => {},
      1,
      2,
      2,
    );
  } catch (error) {
    undrained = error;
  }
  assert.equal(undrained.diagnostics.taskDrained, false);
  assert.equal(undrained.retainSvsRunning, true);
  for (const mutate of [
    (cleanup) => (cleanup.pendingRequests = 1),
    (cleanup) => (cleanup.pendingRequestsMeasured = false),
    (cleanup) => (cleanup.requestStartedCount = 0),
    (cleanup) => cleanup.requestSettledCount--,
    (cleanup) => (cleanup.pendingRequestPeak = 0),
    (cleanup) => (cleanup.pageCloseTimedOut = true),
    (cleanup) => (cleanup.contextClosed = false),
  ]) {
    expectStatus(
      (report) => mutate(report.sessions[0].cleanup),
      "STRUCTURAL",
      /cleanup/u,
    );
  }
  for (const mutate of [
    (cleanup) => (cleanup.attempted = false),
    (cleanup) => (cleanup.closed = false),
    (cleanup) => (cleanup.timedOut = true),
    (cleanup) => cleanup.closeTimeoutMs++,
  ]) {
    expectStatus(
      (report) => mutate(report.lifecycle.browserCleanup),
      "STRUCTURAL",
      /lifecycle/u,
    );
  }
  for (const mutate of [
    (transport) => (transport.externalRequests = 1),
    (transport) => (transport.failedRequests = 1),
    (transport) => (transport.ledgerSealed = false),
    (transport) => (transport.ledgerGeneration = 0),
    (transport) => (transport.quiescentStableTurns = 2),
    (transport) => (transport.postSealTurnObserved = false),
    (transport) => (transport.responseBodiesPending = 1),
    (transport) => (transport.responseBodyErrors = 1),
    (transport) => transport.lateEvents.push({ kind: "request-started" }),
  ]) {
    expectStatus(
      (report) => mutate(report.sessions[0].transport),
      "STRUCTURAL",
      /runtime error surface/u,
    );
  }

  const request = (suffix) => ({
    url: () => `http://localhost:8080/${suffix}`,
  });
  const injected = createSvsRequestLedger("http://localhost:8080");
  const initial = request("initial");
  injected.noteRequest(initial);
  injected.noteRequestFinished(initial);
  const inspectInjected = injected.inspect.bind(injected);
  let inspectionCount = 0;
  injected.inspect = () => {
    inspectionCount++;
    if (inspectionCount === 2) {
      const duringClosure = request("during-closure");
      injected.noteRequest(duringClosure);
      injected.noteRequestFailed(duringClosure);
      injected.noteExternalRequest(request("external-during-closure"));
      injected.trackXysResponse({
        route: "/Build/CesiumUnminified/Assets/IAU2006_XYS/IAU2006_XYS_10.json",
        status: 200,
        body: async () => Buffer.from("late-xys-body"),
      });
    }
    return inspectInjected();
  };
  const injectedSnapshot = await drainSvsRequestLedger(injected, 1000, 3);
  assert.equal(injectedSnapshot.quiescentStableTurns, 3);
  assert.equal(injectedSnapshot.requestStartedCount, 2);
  assert.equal(injectedSnapshot.requestSettledCount, 2);
  assert.equal(injectedSnapshot.failedRequests, 1);
  assert.equal(injectedSnapshot.externalRequests, 1);
  assert.equal(injectedSnapshot.xysResponses.length, 1);
  assert.equal(injectedSnapshot.responseBodiesPending, 0);
  assert.equal(injectedSnapshot.lateEvents.length, 0);

  const afterSeal = createSvsRequestLedger("http://localhost:8080");
  const sealOriginal = afterSeal.seal.bind(afterSeal);
  afterSeal.seal = (stableTurns) => {
    const snapshot = sealOriginal(stableTurns);
    setTimeout(() => afterSeal.noteRequest(request("post-seal")), 0);
    return snapshot;
  };
  await assert.rejects(
    () => drainSvsRequestLedger(afterSeal, 1000, 3),
    /after ledger seal/u,
  );

  const failedBody = createSvsRequestLedger("http://localhost:8080");
  failedBody.trackXysResponse({
    route: "/Build/CesiumUnminified/Assets/IAU2006_XYS/IAU2006_XYS_10.json",
    status: 200,
    body: async () => {
      throw new Error("synthetic late XYS body failure");
    },
  });
  await assert.rejects(
    () => drainSvsRequestLedger(failedBody, 1000, 3),
    /XYS response body was unreadable/u,
  );

  const materializeIndex = probeSource.indexOf(
    "await materializeImages(session, runId, paths);",
  );
  const pageCloseIndex = probeSource.indexOf(
    "const pageClose = await closeSvsResourceBounded(page",
  );
  const contextCloseIndex = probeSource.indexOf(
    "const contextClose = await closeSvsResourceBounded(",
    pageCloseIndex,
  );
  const drainIndex = probeSource.indexOf(
    "ledgerSnapshot = await drainSvsRequestLedger(requestLedger);",
  );
  const freezeTransportIndex = probeSource.indexOf(
    "session.ephemeris.xysFiles = ledgerSnapshot.xysResponses;",
  );
  assert.ok(materializeIndex > 0);
  assert.ok(materializeIndex < pageCloseIndex);
  assert.ok(pageCloseIndex < contextCloseIndex);
  assert.ok(contextCloseIndex < drainIndex);
  assert.ok(drainIndex < freezeTransportIndex);
  assert.match(probeSource, /const pendingRequests = new Set\(\)/u);
  assert.match(probeSource, /requestStartedCount\+\+/u);
  assert.match(probeSource, /requestSettledCount\+\+/u);
  assert.match(probeSource, /closeSvsResourceBounded\(page/u);
  assert.match(probeSource, /closeSvsResourceBounded\(\s*context/u);
  assert.doesNotMatch(
    probeSource,
    /await page\.close\(\)|await context\.close\(\)/u,
  );
});
