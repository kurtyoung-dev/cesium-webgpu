import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  GLOBE_CAMERA_TRACK,
  GLOBE_CAMERA_TRACK_DURATION_SECONDS,
  GLOBE_CAMERA_TRACK_ID,
} from "./lib/globe-camera-track.mjs";
import {
  assessPerformanceRunQuality,
  assessPerformanceRunStability,
  assessRepresentativeMeasurementEvidence,
  assessRepresentativePairComparability,
  assessWebGPUModelPreparationEvidence,
  buildCounterbalancedSchedule,
  compareFixedFrameProgressSequences,
  compareRepresentativeTilesetLifecycleDiagnostics,
  diffCounterLabelSnapshots,
  diffFlatCounterSnapshots,
  selectLongTasksInMeasurementWindow,
  summarizeEclipseGlobeShadowEvidence,
  summarizeFramePacing,
  summarizeMovingPickMetrics,
  summarizeTrackMetrics,
} from "./lib/performance-campaign-utils.mjs";
import { validatePerformanceWorkloadManifest } from "./lib/performance-workload-manifest.mjs";
import { buildPerformanceViewerUrl } from "./lib/performance-viewer-url.mjs";
import {
  createWebGPUModelPreparationEvidenceAccumulator,
  observeWebGPUModelPreparationStatistics,
  summarizeWebGPUModelPreparationEvidence,
  WEBGPU_MODEL_PREPARATION_WORK_FIELDS,
} from "./lib/webgpu-model-preparation-evidence.mjs";
import {
  renderersForWorkload,
  selectWorkloadsForRenderers,
} from "./lib/performance-workload-selection.mjs";
import {
  createRepresentativeTilesetLifecycleTracker,
  createRepresentativeWorkloadFingerprintAccumulator,
  createRepresentativeTerrain,
  createRepresentativeWaterMask,
  diffRepresentativeTerrainDiagnostics,
  isRepresentativeResidentRoutePassQuiescent,
  REPRESENTATIVE_CONTENT,
  REPRESENTATIVE_CONTENT_PROFILE,
  representativeGeometricError,
  sampleRepresentativeHeight,
  validateRepresentativeConfig,
} from "./lib/representative-performance-content.mjs";
import resolveCesiumViewerStartupOptions from "../../Apps/CesiumViewer/CesiumViewerStartupOptions.js";

const directory = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  await readFile(resolve(directory, "performance-workloads.json"), "utf8"),
);
const s5EclipseManifest = JSON.parse(
  await readFile(
    resolve(directory, "performance-workloads-s5-eclipse.json"),
    "utf8",
  ),
);
const schema = JSON.parse(
  await readFile(
    resolve(directory, "performance-workloads.schema.json"),
    "utf8",
  ),
);
const representativeManifest = JSON.parse(
  await readFile(
    resolve(directory, "performance-workloads-representative.json"),
    "utf8",
  ),
);
const representativeWarmManifest = JSON.parse(
  await readFile(
    resolve(
      directory,
      "performance-workloads-representative-warm.json",
    ),
    "utf8",
  ),
);
const runnerSource = await readFile(
  resolve(directory, "run-performance-campaign.mjs"),
  "utf8",
);
const representativeContentSource = await readFile(
  resolve(directory, "lib", "representative-performance-content.mjs"),
  "utf8",
);

test("performance workload manifest has stable unique identities", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.match(manifest.id, /^[a-z0-9-]+$/);
  const ids = manifest.workloads.map((workload) => workload.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    assert.match(id, /^[a-z0-9-]+$/);
  }
});

test("WebGL program events retain nonblocking parallel-compile polls", () => {
  assert.match(
    runnerSource,
    /const webglCompletionStatusKhr = 0x91b1;/,
  );
  assert.match(
    runnerSource,
    /parameter === webglCompletionStatusKhr/,
  );
  assert.match(runnerSource, /parameter,\s+result,/);
  assert.match(runnerSource, /sourceHash:/);
  assert.match(runnerSource, /sourceDefines:/);
  assert.match(runnerSource, /sourceDefinesTruncated/);
  assert.match(runnerSource, /firstDrawProgram/);
  assert.match(runnerSource, /webglCurrentPrograms/);
  assert.match(runnerSource, /globeShaderRequests/);
  assert.match(runnerSource, /fogCompanionEnabled/);
  assert.match(runnerSource, /preparationCountBefore/);
  assert.match(runnerSource, /preparationCountAfter/);
});

test("every passing renderer run records comparable physical GPU provenance", () => {
  assert.match(runnerSource, /const rendererString =/);
  assert.match(runnerSource, /context\.getRendererString/);
  assert.match(runnerSource, /const gpuProvenance = \{/);
  assert.match(runnerSource, /backend: actualRenderer,/);
  assert.match(runnerSource, /rendererString,/);
  assert.match(runnerSource, /adapterInfo,/);
  assert.match(
    runnerSource,
    /physical GPU provenance was incomplete/,
  );
});

test("performance protocol is bounded and not an FPS-only smoke", () => {
  assert.ok(manifest.protocol.warmupFrames >= 1);
  assert.ok(manifest.protocol.measuredFrames >= 600);
  assert.ok(manifest.protocol.settleStableFrames >= 1);
  assert.ok(manifest.protocol.settleTimeoutMs >= 1);
  assert.ok(manifest.protocol.repetitions >= 3);
  assert.ok(manifest.protocol.counterbalancedPairs >= 6);
  assert.equal(manifest.protocol.browser, "msedge");
  assert.equal(manifest.protocol.viewport.deviceScaleFactor, 1);
});

test("manifest covers core hot-path states with local deterministic content", () => {
  const actions = new Set(
    manifest.workloads.map((workload) => workload.action),
  );
  for (const required of [
    "static",
    "orbit",
    "camera-track",
    "camera-track-pick",
    "sparse-point-mutation",
    "full-point-mutation",
    "pick-center",
    "resize-cycle",
    "morph-roundtrip",
    "destroy-recreate-content",
  ]) {
    assert.ok(actions.has(required), `missing action ${required}`);
  }
  const modes = new Set(manifest.workloads.map((workload) => workload.mode));
  assert.deepEqual(modes, new Set(["3d", "2d", "columbus"]));
  assert.equal(new globalThis.URL(manifest.baseUrl).hostname, "localhost");
  for (const workload of manifest.workloads) {
    assert.ok(["globe-only", "points-4096"].includes(workload.content));
    assert.equal(workload.contentProfile, "local-grid-ellipsoid");
    assert.ok(
      ["deterministic-core", "default-globe", "volumetric-clouds"].includes(
        workload.featureProfile,
      ),
    );
    if (workload.renderers !== undefined) {
      assert.ok(workload.renderers.length > 0);
      assert.equal(new Set(workload.renderers).size, workload.renderers.length);
      assert.ok(
        workload.renderers.every((renderer) =>
          ["webgl", "webgpu"].includes(renderer),
        ),
      );
    }
  }
});

test("all executable performance manifests satisfy the checked-in schema", () => {
  for (const [name, candidate] of [
    ["default", manifest],
    ["S5 eclipse", s5EclipseManifest],
    ["representative streaming", representativeManifest],
    ["representative resident", representativeWarmManifest],
  ]) {
    assert.deepEqual(
      validatePerformanceWorkloadManifest(candidate, schema),
      { valid: true, errors: [] },
      name,
    );
  }
});

test("camera-track workloads declare exactly one measurement control", () => {
  const neither = JSON.parse(JSON.stringify(representativeManifest));
  delete neither.workloads[0].measuredSeconds;
  delete neither.workloads[0].measuredFrames;
  assert.equal(
    validatePerformanceWorkloadManifest(neither, schema).valid,
    false,
  );

  const both = JSON.parse(JSON.stringify(representativeManifest));
  both.workloads[0].measuredFrames = 600;
  assert.equal(
    validatePerformanceWorkloadManifest(both, schema).valid,
    false,
  );
});

test("representative manifest binds both renderers to the same real-content route", async () => {
  assert.equal(representativeManifest.schemaVersion, 1);
  assert.equal(representativeManifest.workloads.length, 1);
  const workload = representativeManifest.workloads[0];
  assert.equal(workload.content, REPRESENTATIVE_CONTENT);
  assert.equal(workload.contentProfile, REPRESENTATIVE_CONTENT_PROFILE);
  assert.equal(workload.action, "camera-track");
  assert.equal(workload.trackId, GLOBE_CAMERA_TRACK_ID);
  assert.ok(
    GLOBE_CAMERA_TRACK.some(
      (waypoint) =>
        waypoint.name ===
        workload.representativeConfig.validationWaypoint,
    ),
  );
  assert.equal(workload.featureProfile, "default-globe");
  assert.equal(workload.renderers, undefined);
  assert.deepEqual(
    renderersForWorkload(workload, ["webgl", "webgpu"]),
    ["webgl", "webgpu"],
  );
  assert.deepEqual(validateRepresentativeConfig(workload.representativeConfig), []);
  assert.ok(workload.representativeConfig.terrain.maximumLevel <= 16);
  assert.ok(
    workload.representativeConfig.models.rows *
      workload.representativeConfig.models.columns >=
      32,
  );
  assert.equal(
    workload.representativeConfig.tilesets.rows *
      workload.representativeConfig.tilesets.columns,
    4,
  );

  const repositoryRoot = resolve(directory, "..", "..");
  await Promise.all([
    readFile(
      resolve(
        repositoryRoot,
        workload.representativeConfig.models.url.slice(1),
      ),
    ),
    readFile(
      resolve(
        repositoryRoot,
        workload.representativeConfig.tilesets.url.slice(1),
      ),
    ),
  ]);
});

test("representative resident manifest prewarms its exact high-cache frame route", () => {
  assert.equal(
    representativeWarmManifest.id,
    "fork-representative-resident-attribution-v1",
  );
  const workload = representativeWarmManifest.workloads[0];
  assert.equal(
    workload.representativeConfig.measurementTerrainMode,
    "resident",
  );
  assert.equal(
    workload.representativeConfig.routePrimeSamples,
    representativeWarmManifest.protocol.measuredFrames,
  );
  // The first frame after a large fixed-route step can still expose the
  // previous selection before the five-task terrain-mesh throttle queues the
  // new state's work. Two consecutive stable frames prevent a stale one-frame
  // `tilesLoaded` observation from advancing resident prewarm.
  assert.equal(workload.representativeConfig.primeStableFrames, 2);
  assert.equal(
    representativeWarmManifest.protocol.warmupFrames,
    representativeWarmManifest.protocol.measuredFrames,
  );
  assert.equal(workload.measuredSeconds, undefined);
  assert.equal(
    workload.measuredFrames,
    representativeWarmManifest.protocol.measuredFrames,
  );
  assert.equal(workload.representativeConfig.terrain.tileCacheSize, 4096);
  assert.equal(representativeWarmManifest.protocol.resolutionScale, 1);
  assert.deepEqual(
    validateRepresentativeConfig(workload.representativeConfig),
    [],
  );
});

test("representative terrain is non-flat and emits uniform plus mixed water-mask forms", () => {
  const radians = (degrees) => (degrees * Math.PI) / 180;
  const heights = [
    sampleRepresentativeHeight(radians(-122.6), radians(37.6)),
    sampleRepresentativeHeight(radians(-122.4), radians(37.8)),
    sampleRepresentativeHeight(radians(-122.2), radians(38.0)),
  ];
  assert.ok(Math.max(...heights) - Math.min(...heights) > 1);
  assert.equal(
    sampleRepresentativeHeight(radians(-122.4), radians(37.8)),
    sampleRepresentativeHeight(radians(-122.4), radians(37.8)),
  );

  const maskForDegrees = (west, south, east, north) =>
    createRepresentativeWaterMask(
      {
        west: radians(west),
        south: radians(south),
        east: radians(east),
        north: radians(north),
      },
      16,
    );
  const water = maskForDegrees(-123.0, 37.6, -122.8, 37.9);
  const land = maskForDegrees(-122.3, 37.6, -122.1, 37.9);
  const mixed = maskForDegrees(-122.6, 37.6, -122.3, 37.9);
  assert.deepEqual(
    [water.kind, water.data.length],
    ["water", 1],
  );
  assert.deepEqual([land.kind, land.data.length], ["land", 1]);
  assert.deepEqual([mixed.kind, mixed.data.length], ["mixed", 256]);
  assert.equal(representativeGeometricError(8, 9, 1024), 4);
  assert.equal(representativeGeometricError(9, 9, 1024), 0);
  assert.equal(representativeGeometricError(20, 9, 1024), 0);
});

test("representative SF terrain preserves clearance for the low route and draped assets", () => {
  const radians = (degrees) => (degrees * Math.PI) / 180;
  let maximumHeight = Number.NEGATIVE_INFINITY;
  for (let longitude = -122.55; longitude <= -122.3; longitude += 0.005) {
    for (let latitude = 37.68; latitude <= 37.88; latitude += 0.005) {
      maximumHeight = Math.max(
        maximumHeight,
        sampleRepresentativeHeight(
          radians(longitude),
          radians(latitude),
        ),
      );
    }
  }
  assert.ok(maximumHeight < 150);
  assert.ok(300 - maximumHeight > 150);

  const config =
    representativeManifest.workloads[0].representativeConfig;
  assert.ok(config.models.heightAboveTerrain > 0);
  assert.ok(config.tilesets.targetHeightOffset > 0);
});

test("representative terrain caches payload generation without reusing mutable TerrainData", async () => {
  class FakeHeightmapTerrainData {
    constructor(options) {
      Object.assign(this, options);
    }
  }
  class FakeGeographicTilingScheme {
    constructor() {
      this.ellipsoid = {};
    }

    getNumberOfXTilesAtLevel() {
      return 2;
    }

    tileXYToRectangle() {
      return {
        west: (-123 * Math.PI) / 180,
        south: (37.6 * Math.PI) / 180,
        east: (-122.2 * Math.PI) / 180,
        north: (38.0 * Math.PI) / 180,
      };
    }
  }
  const C = {
    Event: class {},
    GeographicTilingScheme: FakeGeographicTilingScheme,
    HeightmapTerrainData: FakeHeightmapTerrainData,
    TerrainProvider: {
      getEstimatedLevelZeroGeometricErrorForAHeightmap: () => 1024,
    },
  };
  const terrain = createRepresentativeTerrain(
    C,
    representativeManifest.workloads[0].representativeConfig,
  );
  const first = await terrain.provider.requestTileGeometry(1, 2, 3);
  const second = await terrain.provider.requestTileGeometry(1, 2, 3);
  assert.notEqual(first, second);
  assert.notEqual(first.buffer, second.buffer);
  assert.deepEqual(first.buffer, second.buffer);
  assert.notEqual(first.waterMask, second.waterMask);
  assert.deepEqual(first.waterMask, second.waterMask);
  const diagnostics = terrain.snapshotDiagnostics({
    includeGeneratedTileKeys: true,
  });
  assert.equal(diagnostics.requestCount, 2);
  assert.equal(diagnostics.cacheHitCount, 1);
  assert.equal(diagnostics.tileGenerationCount, 1);
  assert.equal(diagnostics.uniqueTileCount, 1);
  assert.deepEqual(diagnostics.requestsByLevel, { 3: 2 });
  assert.deepEqual(diagnostics.generationsByLevel, { 3: 1 });
  assert.deepEqual(diagnostics.generatedTileKeys, ["3/1/2"]);
});

test("representative terrain activity diffs only the measured streaming window", () => {
  assert.deepEqual(
    diffRepresentativeTerrainDiagnostics(
      {
        requestCount: 10,
        cacheHitCount: 3,
        tileGenerationCount: 7,
        requestsByLevel: { 8: 10 },
        generationsByLevel: { 8: 7 },
        generatedTileKeys: ["8/0/0", "8/0/1"],
        uniqueTileCount: 7,
        maximumRequestedLevel: 8,
        nonFlatTilesGenerated: 7,
        waterMasksGenerated: { land: 2, water: 1, mixed: 4 },
      },
      {
        requestCount: 16,
        cacheHitCount: 5,
        tileGenerationCount: 11,
        requestsByLevel: { 8: 12, 9: 4 },
        generationsByLevel: { 8: 8, 9: 3 },
        generatedTileKeys: ["8/0/0", "8/0/1", "9/0/0", "9/0/1"],
        uniqueTileCount: 11,
        maximumRequestedLevel: 9,
        nonFlatTilesGenerated: 11,
        waterMasksGenerated: { land: 3, water: 2, mixed: 6 },
      },
    ),
    {
      requestCount: 6,
      cacheHitCount: 2,
      tileGenerationCount: 4,
      requestsByLevel: { 8: 2, 9: 4 },
      generationsByLevel: { 8: 1, 9: 3 },
      generatedTileKeys: ["9/0/0", "9/0/1"],
      uniqueTileCount: 4,
      maximumRequestedLevel: 9,
      nonFlatTilesGenerated: 4,
      waterMasksGenerated: { land: 1, water: 1, mixed: 2 },
    },
  );
});

test("representative measured-window evidence rejects vacuous streaming coverage", () => {
  const content = {
    sampledFrames: 4,
    terrainMeshFrames: 4,
    terrainWaterMaskTextureFrames: 4,
    waterEffectFrames: 4,
    directModelCommandFrames: 2,
    tilesetCommandFrames: 2,
    allContentCommandFrames: 1,
    sampling: {
      mode: "untimed-deterministic-route-replay",
      provenance: {
        timed: false,
        phase: "post-measurement-untimed-replay",
        traceEndedBeforeReplay: true,
        measurementSnapshotsFrozenBeforeReplay: true,
        causal: false,
      },
      replay: {
        frameCount: 4,
        sourceMeasuredFrames: 120,
        identicalFixedFrameProgress: false,
        progressFormula: "index/(frameCount-1)",
        streamingFrameLimit: 240,
      },
      validationWaypoint: {
        routeProgress: 0.875,
      },
      commandTriggeredPreWaypoint: {
        startRouteProgress: 0.75,
        endRouteProgress: 0.875,
        endExclusive: true,
        configuredTilesets: 4,
        inspectedFrames: 18,
        maximumSamples: 4,
        sampledFrames: 4,
        firstSampleRouteProgress: 0.82,
        lastSampleRouteProgress: 0.84,
        maximumObservedCommands: 20,
      },
    },
  };
  const streaming = assessRepresentativeMeasurementEvidence({
    measurementTerrainActivity: {
      delta: {
        requestCount: 12,
        tileGenerationCount: 8,
        generatedTileKeys: ["8/1/2"],
      },
    },
    measurementContent: content,
  });
  assert.equal(streaming.valid, true);

  const vacuous = assessRepresentativeMeasurementEvidence({
    measurementTerrainActivity: {
      delta: {
        requestCount: 0,
        tileGenerationCount: 0,
        generatedTileKeys: [],
      },
    },
    measurementContent: {
      ...content,
      directModelCommandFrames: 0,
      tilesetCommandFrames: 0,
      allContentCommandFrames: 0,
    },
  });
  assert.equal(vacuous.valid, false);
  assert.ok(
    vacuous.reasons.some((reason) =>
      reason.includes("issued no terrain requests"),
    ),
  );
  assert.ok(
    vacuous.reasons.some((reason) =>
      reason.includes("direct model command work was absent"),
    ),
  );

  // A resident replay is only causal when the timed window is PROVEN to have
  // rendered the same per-frame camera phase. The recorded sequences are the
  // proof; the flags are re-derived from them, never restated from config.
  const residentProgress = [0, 1 / 3, 2 / 3, 1];
  const makeResidentEvidence = (
    measured,
    replayed,
    replayOverrides = {},
    provenanceOverrides = {},
  ) => ({
    measurementTerrainActivity: {
      delta: {
        requestCount: 0,
        tileGenerationCount: 0,
        generatedTileKeys: [],
      },
    },
    measurementContent: {
      ...content,
      workloadFingerprint: { frameCount: 4 },
      sampling: {
        ...content.sampling,
        provenance: {
          ...content.sampling.provenance,
          replayModeFixedFrame: true,
          renderedProgressIdentical: true,
          causal: true,
          ...provenanceOverrides,
        },
        replay: {
          ...content.sampling.replay,
          identicalFixedFrameProgress: true,
          streamingFrameLimit: null,
          renderedProgress: { measured, replay: replayed },
          fixedFrameProgressComparison:
            compareFixedFrameProgressSequences(measured, replayed),
          ...replayOverrides,
        },
      },
    },
  });

  const resident = assessRepresentativeMeasurementEvidence(
    makeResidentEvidence(residentProgress, residentProgress.slice()),
    { measurementTerrainMode: "resident" },
  );
  assert.equal(resident.valid, true);
  assert.equal(resident.fixedFrameProgress.identical, true);
  assert.equal(resident.fixedFrameProgress.measuredFrameCount, 4);

  // The exact defect the recording closes: the measured window rendered the
  // action-rAF phases {1/3, 2/3, 1, 1} while the replay rendered {0 … 1}. A
  // config-derived flag called that identical; the measurement must not.
  const phaseShifted = assessRepresentativeMeasurementEvidence(
    makeResidentEvidence(
      [1 / 3, 2 / 3, 1, 1],
      residentProgress.slice(),
      { identicalFixedFrameProgress: false },
      { renderedProgressIdentical: false, causal: false },
    ),
    { measurementTerrainMode: "resident" },
  );
  assert.equal(phaseShifted.valid, false);
  assert.equal(phaseShifted.fixedFrameProgress.identical, false);
  assert.equal(phaseShifted.fixedFrameProgress.firstDivergenceIndex, 0);
  assert.ok(
    phaseShifted.reasons.some((reason) =>
      reason.includes("rendered-progress-divergence"),
    ),
  );

  // One frame of camera phase drift — the WebGL/WebGPU asymmetry the old
  // hard-coded flag could never see — must also fail.
  const oneFrameDrift = assessRepresentativeMeasurementEvidence(
    makeResidentEvidence(
      [0, 1 / 3, 1, 1],
      residentProgress.slice(),
      { identicalFixedFrameProgress: false },
      { renderedProgressIdentical: false, causal: false },
    ),
    { measurementTerrainMode: "resident" },
  );
  assert.equal(oneFrameDrift.valid, false);
  assert.equal(oneFrameDrift.fixedFrameProgress.firstDivergenceIndex, 2);

  // A hard-coded `true` with no recorded sequences is exactly the config
  // restatement this gate exists to reject.
  const unbackedClaim = assessRepresentativeMeasurementEvidence(
    makeResidentEvidence(residentProgress, residentProgress.slice(), {
      renderedProgress: undefined,
      fixedFrameProgressComparison: undefined,
    }),
    { measurementTerrainMode: "resident" },
  );
  assert.equal(unbackedClaim.valid, false);
  assert.ok(
    unbackedClaim.reasons.some((reason) =>
      reason.includes("were not recorded"),
    ),
  );

  // A reported comparison that contradicts the sequences it claims to
  // summarize must fail rather than be believed.
  const forgedComparison = assessRepresentativeMeasurementEvidence(
    makeResidentEvidence([0, 1 / 3, 2 / 3, 0.5], residentProgress.slice(), {
      fixedFrameProgressComparison: compareFixedFrameProgressSequences(
        residentProgress,
        residentProgress.slice(),
      ),
    }),
    { measurementTerrainMode: "resident" },
  );
  assert.equal(forgedComparison.valid, false);
  assert.ok(
    forgedComparison.reasons.some((reason) =>
      reason.includes("disagrees with the recorded sequences"),
    ),
  );

  // The replay must cover the frames it claims to replay.
  const shortSequences = assessRepresentativeMeasurementEvidence(
    makeResidentEvidence([0, 1], [0, 1], { frameCount: 4 }),
    { measurementTerrainMode: "resident" },
  );
  assert.equal(shortSequences.valid, false);

  const missingCommandWindow = assessRepresentativeMeasurementEvidence({
    measurementTerrainActivity: {
      delta: {
        requestCount: 12,
        tileGenerationCount: 8,
        generatedTileKeys: ["8/1/2"],
      },
    },
    measurementContent: { ...content, sampling: undefined },
  });
  assert.equal(missingCommandWindow.valid, false);
  assert.ok(
    missingCommandWindow.reasons.some((reason) =>
      reason.includes("pre-waypoint 3D Tiles command window"),
    ),
  );

  for (const invalidCommandWindow of [
    {
      ...content.sampling.commandTriggeredPreWaypoint,
      sampledFrames: 3,
    },
    {
      ...content.sampling.commandTriggeredPreWaypoint,
      lastSampleRouteProgress: 0.876,
    },
    {
      ...content.sampling.commandTriggeredPreWaypoint,
      sampledFrames: 5,
    },
  ]) {
    const invalid = assessRepresentativeMeasurementEvidence({
      measurementTerrainActivity: {
        delta: {
          requestCount: 12,
          tileGenerationCount: 8,
          generatedTileKeys: ["8/1/2"],
        },
      },
      measurementContent: {
        ...content,
        sampling: {
          ...content.sampling,
          commandTriggeredPreWaypoint: invalidCommandWindow,
        },
      },
    });
    assert.equal(invalid.valid, false);
  }
});

test("resident route convergence keeps every causal zero-work gate", () => {
  assert.equal(
    isRepresentativeResidentRoutePassQuiescent({
      requestCount: 0,
      tileGenerationCount: 0,
      globeTilesNotLoadedFrames: 0,
    }),
    true,
  );
  for (const nonQuiescent of [
    {
      requestCount: 1,
      tileGenerationCount: 0,
      globeTilesNotLoadedFrames: 0,
    },
    {
      requestCount: 0,
      tileGenerationCount: 1,
      globeTilesNotLoadedFrames: 0,
    },
    {
      requestCount: 0,
      tileGenerationCount: 0,
      globeTilesNotLoadedFrames: 1,
    },
  ]) {
    assert.equal(
      isRepresentativeResidentRoutePassQuiescent(nonQuiescent),
      false,
    );
  }
});

test("resident convergence records bounded queue detail only on false frames", () => {
  assert.match(runnerSource, /const residentQueueDiagnosticLimit = 8;/);
  assert.match(runnerSource, /const residentQueueEntryLimit = 16;/);
  assert.match(runnerSource, /_tileLoadQueueHigh/);
  assert.match(runnerSource, /_tileLoadQueueMedium/);
  assert.match(runnerSource, /_tileLoadQueueLow/);
  assert.match(
    runnerSource,
    /if \(scene\.globe\.tilesLoaded !== true\) \{\s+globeTilesNotLoadedFrames\+\+;\s+if \([\s\S]*?residentQueueDiagnostics\.push\(\s+captureResidentQueueDiagnostic\(\)/,
  );
  assert.match(runnerSource, /entries\.length >= residentQueueEntryLimit/);
  assert.match(runnerSource, /residentQueueDiagnostics,/);
});

test("resident fixed-frame handoff covers every route progress exactly once", () => {
  const measuredFrames = 600;
  const renderedProgress = [0];
  let cameraTrackFrameIndex = 1;
  while (renderedProgress.length < measuredFrames) {
    renderedProgress.push(
      cameraTrackFrameIndex / (measuredFrames - 1),
    );
    cameraTrackFrameIndex++;
  }
  assert.equal(renderedProgress.length, measuredFrames);
  assert.equal(renderedProgress[0], 0);
  assert.equal(renderedProgress[1], 1 / 599);
  assert.equal(renderedProgress.at(-1), 1);
  assert.equal(new Set(renderedProgress).size, measuredFrames);
  assert.equal(
    runnerSource.match(/cameraTrackFrameIndex = 1;/g)?.length,
    2,
  );
  assert.match(
    runnerSource,
    /currentTrackState = applyCameraTrackProgress\(0\);\s+\/\/ Progress 0 is already the first rendered frame\.[\s\S]*?cameraTrackFrameIndex = 1;/,
  );
});

test("performance action rAF has an idempotent global teardown owner", () => {
  assert.match(runnerSource, /let actionLoopActive = true;/);
  assert.match(runnerSource, /let actionFrameId;/);
  assert.match(runnerSource, /const stopActionLoop = \(\) => \{/);
  assert.match(runnerSource, /cancelAnimationFrame\(actionFrameId\)/);
  assert.match(
    runnerSource,
    /performanceCampaignCleanup\.add\(stopActionLoop\)/,
  );
  assert.match(
    runnerSource,
    /const cleanupRegistry = globalThis\.__perfCampaignCleanup;[\s\S]*?await cleanup\(\);[\s\S]*?viewer\.destroy\(\);/,
  );
  assert.doesNotMatch(
    runnerSource,
    /if \(!actionRunning\) \{\s+requestAnimationFrame\(applyAction\)/,
  );
});

test("WebGPU model-preparation evidence aggregates bounded conserved totals", () => {
  const makeWork = (multiplier) =>
    Object.fromEntries(
      WEBGPU_MODEL_PREPARATION_WORK_FIELDS.map((field, index) => [
        field,
        (index + 1) * multiplier,
      ]),
    );
  const accumulator =
    createWebGPUModelPreparationEvidenceAccumulator();
  assert.equal(
    observeWebGPUModelPreparationStatistics(accumulator, {
      frameNumber: 10,
      candidates: 5,
      viewAdmitted: 2,
      shadowAdmitted: 1,
      captureAdmitted: 0,
      conservativeFallbacks: 1,
      rejected: 1,
      reasons: {
        view_intersecting: 2,
        shadow_cast: 1,
        cull_disabled: 1,
        frustum_outside: 1,
      },
      work: makeWork(1),
    }),
    true,
  );
  assert.equal(
    observeWebGPUModelPreparationStatistics(accumulator, {
      frameNumber: 11,
      candidates: 3,
      viewAdmitted: 3,
      shadowAdmitted: 0,
      captureAdmitted: 0,
      conservativeFallbacks: 0,
      rejected: 0,
      reasons: { view_intersecting: 3 },
      work: makeWork(2),
    }),
    true,
  );
  const summary = summarizeWebGPUModelPreparationEvidence(accumulator, {
    expectedFrameCount: 2,
  });
  assert.equal(summary.enabled, true);
  assert.equal(summary.valid, true);
  assert.equal(summary.observedFrameCount, 2);
  assert.equal(summary.aggregatedFrameCount, 2);
  assert.equal(summary.coverage.valid, true);
  assert.deepEqual(summary.sums.demand, {
    candidates: 8,
    view: 5,
    shadow: 1,
    capture: 0,
    conservative: 1,
    rejected: 1,
  });
  assert.deepEqual(summary.maxima.demand, {
    candidates: 5,
    view: 3,
    shadow: 1,
    capture: 0,
    conservative: 1,
    rejected: 1,
  });
  assert.deepEqual(summary.sums.reasons, {
    cull_disabled: 1,
    frustum_outside: 1,
    shadow_cast: 1,
    view_intersecting: 5,
  });
  for (let index = 0; index < WEBGPU_MODEL_PREPARATION_WORK_FIELDS.length; index++) {
    const field = WEBGPU_MODEL_PREPARATION_WORK_FIELDS[index];
    assert.equal(summary.sums.work[field], (index + 1) * 3);
    assert.equal(summary.maxima.work[field], (index + 1) * 2);
  }
});

test("WebGPU model-preparation evidence rejects vacuous or malformed observations", () => {
  const validWork = Object.fromEntries(
    WEBGPU_MODEL_PREPARATION_WORK_FIELDS.map((field) => [field, 0]),
  );
  const base = {
    frameNumber: 1,
    candidates: 1,
    viewAdmitted: 1,
    shadowAdmitted: 0,
    captureAdmitted: 0,
    conservativeFallbacks: 0,
    rejected: 0,
    reasons: { view_intersecting: 1 },
    work: validWork,
  };

  const empty = summarizeWebGPUModelPreparationEvidence(
    createWebGPUModelPreparationEvidenceAccumulator(),
    { expectedFrameCount: 10 },
  );
  assert.equal(empty.valid, false);
  assert.equal(empty.observedFrameCount, 0);

  const partial = createWebGPUModelPreparationEvidenceAccumulator();
  assert.equal(
    observeWebGPUModelPreparationStatistics(partial, base),
    true,
  );
  const partialSummary = summarizeWebGPUModelPreparationEvidence(partial, {
    expectedFrameCount: 10,
  });
  assert.equal(partialSummary.valid, false);
  assert.equal(partialSummary.coverage.valid, false);

  const demandMismatch =
    createWebGPUModelPreparationEvidenceAccumulator();
  assert.equal(
    observeWebGPUModelPreparationStatistics(demandMismatch, {
      ...base,
      candidates: 2,
      reasons: { view_intersecting: 2 },
    }),
    false,
  );
  assert.equal(
    summarizeWebGPUModelPreparationEvidence(demandMismatch).valid,
    false,
  );

  for (const malformed of [
    { ...base, viewAdmitted: -1 },
    { ...base, reasons: { view_intersecting: 0.5 } },
    {
      ...base,
      work: { ...validWork, preparationRuns: Number.POSITIVE_INFINITY },
    },
  ]) {
    const accumulator =
      createWebGPUModelPreparationEvidenceAccumulator();
    assert.equal(
      observeWebGPUModelPreparationStatistics(accumulator, malformed),
      false,
    );
    const summary = summarizeWebGPUModelPreparationEvidence(accumulator);
    assert.equal(summary.valid, false);
    assert.ok(summary.conservation.violations.length > 0);
  }

  assert.deepEqual(
    assessWebGPUModelPreparationEvidence(
      { enabled: false, reason: "no-model-attribution-content" },
      {
        renderer: "webgpu",
        apiInstrumentation: true,
        modelAttributionContent: false,
      },
    ),
    { valid: true, reasons: [] },
  );
  assert.equal(
    assessWebGPUModelPreparationEvidence(partialSummary, {
      renderer: "webgpu",
      apiInstrumentation: true,
      modelAttributionContent: true,
    }).valid,
    false,
  );
});

test("runner publishes opt-in current-frame model-preparation attribution", () => {
  assert.match(
    runnerSource,
    /actualRenderer === "webgpu" &&\s+apiInstrumentationEnabled &&\s+representativeWorkload/,
  );
  assert.match(
    runnerSource,
    /context\._webgpuModelPreparationDiagnosticsEnabled = true/,
  );
  assert.match(
    runnerSource,
    /performanceCampaignCleanup\.add\(\s+restoreWebGPUModelPreparationDiagnostics/,
  );
  assert.match(
    runnerSource,
    /statistics\?\.frameNumber === frameState\?\.frameNumber/,
  );
  assert.match(
    runnerSource,
    /summarizeWebGPUModelPreparationEvidence/,
  );
  assert.match(runnerSource, /webgpuModelPreparationEvidence,/);
  assert.match(runnerSource, /reason: "api-instrumentation-disabled"/);
  assert.match(runnerSource, /reason: "no-model-attribution-content"/);
  assert.match(runnerSource, /expectedFrameCount: measurementPostRenderFrameCount/);
  assert.match(
    runnerSource,
    /actualRenderer === "webgl"\s+\? null/,
  );
});

test("representative streaming pair reports unequal work and throughput as outcomes", () => {
  const makeRun = ({
    requests,
    generations,
    keys,
    frames = 1120,
  }) => ({
    measuredFrames: frames,
    representativeContentEvidence: {
      measurementTerrainActivity: {
        delta: {
          requestCount: requests,
          tileGenerationCount: generations,
          requestsByLevel: { 9: requests },
          generationsByLevel: { 9: generations },
          generatedTileKeys: keys,
        },
      },
    },
  });
  const comparable = assessRepresentativePairComparability(
    makeRun({
      requests: 1000,
      generations: 800,
      keys: ["9/0/0", "9/0/1"],
    }),
    makeRun({
      requests: 1020,
      generations: 810,
      keys: ["9/0/0", "9/0/1"],
      frames: 1110,
    }),
    { maximumDeltaRatio: 0.05 },
  );
  assert.equal(comparable.valid, true);

  const mismatched = assessRepresentativePairComparability(
    makeRun({
      requests: 1997,
      generations: 1595,
      keys: ["9/0/0", "9/0/1"],
    }),
    makeRun({
      requests: 2203,
      generations: 1784,
      keys: ["9/0/0", "9/1/0"],
      frames: 900,
    }),
    { maximumDeltaRatio: 0.05 },
  );
  assert.equal(mismatched.valid, true);
  assert.deepEqual(mismatched.reasons, []);
  assert.ok(
    mismatched.outcomeDifferences.some((reason) =>
      reason.includes("terrain generation symmetric delta"),
    ),
  );
  assert.ok(
    mismatched.outcomeDifferences.some((reason) =>
      reason.includes("measured frame symmetric delta"),
    ),
  );
  assert.ok(
    mismatched.outcomeDifferences.some((reason) =>
      reason.includes("generated terrain-key Jaccard"),
    ),
  );

  const residentMismatch = assessRepresentativePairComparability(
    makeRun({
      requests: 10,
      generations: 8,
      keys: [],
    }),
    makeRun({
      requests: 12,
      generations: 10,
      keys: [],
    }),
    {
      measurementTerrainMode: "resident",
      maximumDeltaRatio: 0.05,
    },
  );
  assert.equal(residentMismatch.valid, false);
  assert.ok(
    residentMismatch.reasons.some((reason) =>
      reason.includes("terrain generation symmetric delta"),
    ),
  );
});

test("resident workload fingerprints preserve identities and reject one-frame pair drift", () => {
  const makeSample = (overrides = {}) => ({
    segmentIndex: 0,
    terrainTilesToRender: 4,
    terrainMeshTiles: 4,
    terrainSelectionIdentityA: 101,
    terrainSelectionIdentityB: 202,
    terrainUnidentifiedTiles: 0,
    directModelInstancesConfigured: 3,
    directModelInstancesReady: 3,
    directModelIdentityA: 303,
    directModelIdentityB: 404,
    tilesetsWithSelection: 2,
    tilesetSelected: 2,
    tilesetSelectionIdentityA: 505,
    tilesetSelectionIdentityB: 606,
    tilesetSelectionCountMismatch: 0,
    tilesetUnidentifiedSelected: 0,
    tilesetsWithCommands: 2,
    tilesetCommands: 2,
    ...overrides,
  });
  const makeFingerprint = (samples) => {
    const accumulator =
      createRepresentativeWorkloadFingerprintAccumulator();
    for (const sample of samples) {
      assert.equal(accumulator.observe(sample), true);
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
  };
  const samples = [
    makeSample(),
    makeSample({ terrainSelectionIdentityA: 111 }),
    makeSample({ segmentIndex: 1, directModelIdentityB: 414 }),
  ];
  const webglFingerprint = makeFingerprint(samples);
  const matchingFingerprint = makeFingerprint(samples.map((row) => ({ ...row })));
  const commandDifferentFingerprint = makeFingerprint(
    samples.map((row, index) => ({
      ...row,
      directModelOwnersWithCommands: index * 23,
      tilesetsWithCommands: index + 7,
      tilesetCommands: index * 19,
    })),
  );
  const driftedFingerprint = makeFingerprint([
    samples[0],
    { ...samples[1], directModelIdentityA: 999 },
    samples[2],
  ]);
  assert.equal(webglFingerprint.valid, true);
  assert.equal(webglFingerprint.frameCount, 3);
  assert.equal(webglFingerprint.segments.length, 2);
  assert.equal(
    "directModelOwnersWithCommands" in webglFingerprint.metrics,
    false,
  );
  assert.equal(
    webglFingerprint.metrics.directModelInstancesConfigured.total,
    9,
  );
  assert.equal(webglFingerprint.metrics.directModelInstancesReady.total, 9);
  assert.equal("tilesetsWithCommands" in webglFingerprint.metrics, false);
  assert.equal("tilesetCommands" in webglFingerprint.metrics, false);
  assert.equal(webglFingerprint.signature, matchingFingerprint.signature);
  assert.equal(
    webglFingerprint.signature,
    commandDifferentFingerprint.signature,
  );
  assert.notEqual(webglFingerprint.signature, driftedFingerprint.signature);

  const fingerprintSamplerStart = representativeContentSource.indexOf(
    "sampleWorkloadFingerprint(segmentIndex)",
  );
  const fingerprintSamplerEnd = representativeContentSource.indexOf(
    "\n\n    sample()",
    fingerprintSamplerStart,
  );
  assert.ok(
    fingerprintSamplerStart >= 0 &&
      fingerprintSamplerEnd > fingerprintSamplerStart,
  );
  const fingerprintSamplerSource = representativeContentSource.slice(
    fingerprintSamplerStart,
    fingerprintSamplerEnd,
  );
  assert.match(fingerprintSamplerSource, /for \(const model of assets\.models\)/);
  assert.doesNotMatch(
    fingerprintSamplerSource,
    /frameState\?\.commandList|directModelOwnersWithCommands/,
  );

  const makeResidentRun = (fingerprint, attributionOnly = false) => ({
    measuredFrames: 3,
    quality: attributionOnly
      ? {
          status: "attribution-only",
          attributionOnly: true,
          certificationEligible: false,
        }
      : {
          status: "clean",
          attributionOnly: false,
          certificationEligible: true,
        },
    apiCounters: { enabled: attributionOnly },
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
      measurementContent: { workloadFingerprint: fingerprint },
    },
  });
  const options = {
    measurementTerrainMode: "resident",
    maximumDeltaRatio: 0.05,
  };
  const matching = assessRepresentativePairComparability(
    makeResidentRun(webglFingerprint),
    makeResidentRun(matchingFingerprint),
    options,
  );
  assert.equal(matching.valid, true);
  assert.equal(matching.certificationEligible, true);
  assert.equal(matching.metrics.workloadFingerprint.signatureMatch, true);

  const commandDifferent = assessRepresentativePairComparability(
    makeResidentRun(webglFingerprint),
    makeResidentRun(commandDifferentFingerprint),
    options,
  );
  assert.equal(commandDifferent.valid, true);
  assert.equal(commandDifferent.certificationEligible, true);
  assert.equal(
    commandDifferent.metrics.workloadFingerprint.signatureMatch,
    true,
  );

  const drifted = assessRepresentativePairComparability(
    makeResidentRun(webglFingerprint),
    makeResidentRun(driftedFingerprint),
    options,
  );
  assert.equal(drifted.valid, false);
  assert.ok(
    drifted.reasons.some((reason) =>
      reason.includes("per-frame workload signature differs"),
    ),
  );
  assert.ok(
    drifted.reasons.some((reason) =>
      reason.includes("segment 0 signature differs"),
    ),
  );

  const identityIncomplete = structuredClone(webglFingerprint);
  identityIncomplete.metrics.terrainUnidentifiedTiles.max = 1;
  const incomplete = assessRepresentativePairComparability(
    makeResidentRun(identityIncomplete),
    makeResidentRun(matchingFingerprint),
    options,
  );
  assert.equal(incomplete.valid, false);
  assert.ok(
    incomplete.reasons.some((reason) => reason.includes("identity-incomplete")),
  );

  const attributionOnly = assessRepresentativePairComparability(
    makeResidentRun(webglFingerprint, true),
    makeResidentRun(matchingFingerprint, true),
    options,
  );
  assert.equal(attributionOnly.valid, true);
  assert.equal(attributionOnly.attributionOnly, true);
  assert.equal(attributionOnly.certificationEligible, false);
  assert.ok(attributionOnly.certificationExclusions.length > 0);
  assert.match(
    runnerSource,
    /validPairs\.filter\(\s*\(pair\) => pair\.certificationEligible/,
  );

  const invalidQualityRun = makeResidentRun(matchingFingerprint);
  invalidQualityRun.quality = {
    status: "invalid",
    attributionOnly: false,
    certificationEligible: false,
  };
  const invalidQuality = assessRepresentativePairComparability(
    makeResidentRun(webglFingerprint),
    invalidQualityRun,
    options,
  );
  assert.equal(invalidQuality.valid, true);
  assert.equal(invalidQuality.attributionOnly, false);
  assert.equal(invalidQuality.ordinaryQualityEligible, false);
  assert.equal(invalidQuality.certificationEligible, false);
  assert.ok(
    invalidQuality.certificationExclusions.some((reason) =>
      reason.includes("both ordinary renderer legs"),
    ),
  );
});

test("opt-in tileset lifecycle tracing records stable identities, retries, and response bytes", async () => {
  class FakeEvent {
    constructor() {
      this.listeners = new Set();
    }

    addEventListener(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    raise(tile) {
      for (const listener of this.listeners) {
        listener(tile);
      }
    }
  }

  const pending = [];
  class FakeTile {
    constructor(tileset, parent = null) {
      this._tileset = tileset;
      this.parent = parent;
      this.children = [];
      this._contentResource = { url: "/tile.b3dm" };
      this._contentState = 1;
      this._request = undefined;
      this.contentReady = false;
      this.hasEmptyContent = false;
      this._selectedFrame = 7;
      this._requestedFrame = 6;
      this._touchedFrame = 7;
      this._visible = true;
      this._screenSpaceError = 3.25;
      this.content = {
        geometryByteLength: 64,
        texturesByteLength: 32,
        batchTableByteLength: 8,
      };
    }

    requestContent() {
      this._request = { state: 2, cancelled: false };
      return pending.shift();
    }

    cancelRequests() {
      this._request.cancelled = true;
      this._request.state = 4;
    }
  }

  const tileLoad = new FakeEvent();
  const tileset = {
    _root: null,
    _selectedTiles: [],
    _requestedTilesInFlight: [],
    _requestedTiles: [],
    _processingQueue: [],
    _updatedVisibilityFrame: 12,
    statistics: { selected: 1, numberOfTilesWithContentReady: 1 },
    tilesLoaded: true,
    tileLoad,
  };
  const root = new FakeTile(tileset);
  const child = new FakeTile(tileset, root);
  root.children.push(child);
  tileset._root = root;
  tileset._selectedTiles.push(child);

  let resolveFirst;
  pending.push(new Promise((resolve) => (resolveFirst = resolve)));
  pending.push(Promise.resolve({ ready: true }));
  const resourceEntries = [
    {
      transferSize: 120,
      encodedBodySize: 100,
      decodedBodySize: 100,
      duration: 2,
      responseEnd: 4,
      deliveryType: "",
    },
    {
      transferSize: 20,
      encodedBodySize: 80,
      decodedBodySize: 80,
      duration: 1,
      responseEnd: 6,
      deliveryType: "cache",
    },
  ];
  let resourceEntriesAvailable = false;
  const tracker = createRepresentativeTilesetLifecycleTracker(
    {
      Cesium3DTile: FakeTile,
      RequestState: {
        UNISSUED: 0,
        ISSUED: 1,
        ACTIVE: 2,
        RECEIVED: 3,
        CANCELLED: 4,
        FAILED: 5,
      },
      Cesium3DTileContentState: {
        UNLOADED: 0,
        LOADING: 1,
        PROCESSING: 2,
        READY: 3,
        EXPIRED: 4,
        FAILED: 5,
      },
    },
    { tilesets: [tileset] },
    {
      baseUrl: "http://localhost/",
      performanceApi: {
        now: () => 42,
        getEntriesByName: () =>
          resourceEntriesAvailable ? resourceEntries : [],
      },
    },
  );

  resourceEntriesAvailable = true;
  const first = child.requestContent();
  child.cancelRequests();
  resolveFirst(undefined);
  await first;
  await Promise.resolve();
  await child.requestContent();
  await Promise.resolve();
  child.contentReady = true;
  child._contentState = 3;
  tileLoad.raise(child);
  assert.equal(tracker.sampleFrame(6, 0.75), true);
  const diagnostics = tracker.snapshot({
    timed: false,
    phase: "post-measurement-untimed-replay",
    traceEndedBeforeReplay: true,
    measurementSnapshotsFrozenBeforeReplay: true,
  });
  tracker.destroy();

  assert.equal(diagnostics.nonCertifying, true);
  assert.equal(diagnostics.totals.requestsIssued, 2);
  assert.equal(diagnostics.totals.requestsCancelled, 1);
  assert.equal(diagnostics.totals.requestsReissued, 1);
  assert.equal(diagnostics.totals.requestsReissuedAfterCancellation, 1);
  assert.equal(diagnostics.totals.requestsCompleted, 1);
  assert.equal(diagnostics.totals.requestsResolvedWithoutContent, 1);
  assert.equal(diagnostics.totals.resourceTimingsMatched, 2);
  assert.equal(diagnostics.totals.decodedBodyBytes, 180);
  assert.deepEqual(diagnostics.frames[0].tilesets[0].selected, [
    "tileset-0/root/0",
  ]);
  assert.deepEqual(diagnostics.frames[0].tilesets[0].ready, [
    "tileset-0/root/0",
  ]);
  assert.ok(diagnostics.events.some((event) => event.type === "cancelled"));
  assert.ok(diagnostics.events.some((event) => event.type === "reissued"));
  assert.ok(diagnostics.events.some((event) => event.type === "completed"));
});

test("tileset lifecycle comparison identifies readiness before selection drift without gating", () => {
  const provenance = {
    timed: false,
    phase: "post-measurement-untimed-replay",
    traceEndedBeforeReplay: true,
    measurementSnapshotsFrozenBeforeReplay: true,
  };
  const makeDiagnostics = (selected, ready, totals = {}) => ({
    schemaVersion: 1,
    enabled: true,
    nonCertifying: true,
    provenance,
    framesTruncated: false,
    eventsTruncated: false,
    totals,
    frames: [
      {
        index: 0,
        segmentIndex: 6,
        routeProgress: 0.75,
        selectedIdentitySignature: selected.join("|"),
        readyIdentitySignature: ready.join("|"),
        tilesets: [{ selected, ready }],
      },
    ],
  });
  const makeRun = (diagnostics) => ({
    representativeContentEvidence: {
      tilesetLifecycleDiagnostics: diagnostics,
    },
  });
  const comparison = compareRepresentativeTilesetLifecycleDiagnostics(
    makeRun(
      makeDiagnostics(
        ["tileset-0/root/0", "tileset-0/root/1"],
        ["tileset-0/root/0", "tileset-0/root/1"],
        { requestsCancelled: 0 },
      ),
    ),
    makeRun(
      makeDiagnostics(
        ["tileset-0/root/0"],
        ["tileset-0/root/0"],
        { requestsCancelled: 1 },
      ),
    ),
  );
  assert.equal(comparison.available, true);
  assert.equal(comparison.valid, true);
  assert.equal(comparison.nonCertifying, true);
  assert.equal(comparison.comparison.selectedMismatchFrames, 1);
  assert.equal(comparison.comparison.readyMismatchFrames, 1);
  assert.equal(
    comparison.comparison.readyDivergencePrecedesOrMatchesSelection,
    true,
  );
  assert.deepEqual(
    comparison.comparison.firstSelectedMismatch.webglOnly.identities,
    ["tileset-0/root/1"],
  );
});

test("representative content has schema and runner coverage gates", () => {
  const workloadProperties = schema.properties.workloads.items.properties;
  assert.ok(workloadProperties.content.enum.includes(REPRESENTATIVE_CONTENT));
  assert.ok(
    workloadProperties.contentProfile.enum.includes(
      REPRESENTATIVE_CONTENT_PROFILE,
    ),
  );
  assert.ok(workloadProperties.representativeConfig);
  assert.match(runnerSource, /createRepresentativeTerrain/);
  assert.match(runnerSource, /createRepresentativeAssets/);
  assert.match(runnerSource, /createRepresentativeEvidenceTracker/);
  assert.match(runnerSource, /representative route prime timed out/);
  assert.match(runnerSource, /representative content coverage invalid/);
  assert.doesNotMatch(runnerSource, /removeRepresentativeEvidence/);
  assert.ok(
    runnerSource.indexOf("const statisticsAfterReadback") <
      runnerSource.indexOf("const validationTracker"),
  );
  assert.match(runnerSource, /measurementTerrainActivity/);
  assert.match(runnerSource, /measurementContent/);
  assert.match(runnerSource, /representativeMeasurementAssessment/);
  assert.match(runnerSource, /assertPerformanceWorkloadManifest/);
  assert.match(runnerSource, /globeTilesNotLoadedFrames/);
  assert.match(runnerSource, /residentConvergence/);
  assert.match(
    runnerSource,
    /actionRunning = false;\s+await waitFrames\(1, "convergence-pass-quiesce"\);\s+const stagingTerrainStart/,
  );
  assert.match(runnerSource, /routeStartStaging/);
  assert.match(
    runnerSource,
    /untimed-deterministic-route-replay/,
  );
  assert.match(
    runnerSource,
    /\(representativeValidationWaypointIndex - 1\) \/\s+\(cameraTrack\.length - 1\)/,
  );
  assert.match(
    runnerSource,
    /routeProgress >=\s+representativeCommandWindowStartRouteProgress &&\s+routeProgress < representativeCommandWindowEndRouteProgress/,
  );
  assert.match(
    runnerSource,
    /representativeCommandSamplesTaken <\s+representativeCommandSampleLimit/,
  );
  assert.match(
    runnerSource,
    /representativeCommandWindowTilesets\[index\]\.statistics\s+\?\.numberOfCommands/,
  );
  assert.doesNotMatch(
    runnerSource,
    /routeProgress >= representativeValidationRouteProgress/,
  );
  const traceStart = runnerSource.indexOf("scene.beginPerformanceTrace(");
  const traceEnd = runnerSource.indexOf(
    "scene.endPerformanceTrace()",
    traceStart,
  );
  const statisticsFreeze = runnerSource.indexOf(
    "const statisticsAfterReadback",
    traceEnd,
  );
  const replayStart = runnerSource.indexOf(
    "const representativeReplayTracker",
    statisticsFreeze,
  );
  assert.ok(
    traceStart >= 0 &&
      traceEnd > traceStart &&
      statisticsFreeze > traceEnd &&
      replayStart > statisticsFreeze,
  );
  const timedTraceSource = runnerSource.slice(traceStart, traceEnd);
  assert.doesNotMatch(
    timedTraceSource,
    /sampleWorkloadFingerprint|representativeReplayTracker\.sample\(/,
  );
  assert.match(
    runnerSource,
    /const representativeReplayFrameCount = residentRepresentativeReplay\s+\? measurementDefinition\.frames\s+: Math\.min/,
  );
  assert.match(
    runnerSource,
    /phase: "post-measurement-untimed-replay"[\s\S]*?traceEndedBeforeReplay: true[\s\S]*?measurementSnapshotsFrozenBeforeReplay: true/,
  );
  assert.match(
    runnerSource,
    /failed to converge to zero terrain work/,
  );
  assert.match(runnerSource, /assessRepresentativePairComparability/);
  assert.match(runnerSource, /deviceErrorPhases/);
  assert.match(runnerSource, /validationQueueDrain/);
  // Ordering contract, matched EOL-agnostically: the runner is checked out
  // with CRLF on Windows (core.autocrlf), so an embedded "\n" literal silently
  // resolves to -1 and the ordering assertion stops meaning anything.
  const uncapturedErrorRemovalIndex = runnerSource.search(
    /context\.device\?\.removeEventListener\?\.\(\r?\n\s+"uncapturederror"/,
  );
  assert.ok(uncapturedErrorRemovalIndex > 0);
  assert.ok(
    runnerSource.indexOf("const validationTracker") <
      uncapturedErrorRemovalIndex,
  );
  assert.match(runnerSource, /devicePixelRatio/);
  assert.match(runnerSource, /drawingBufferWidth/);
  assert.match(runnerSource, /options\.viewportWidth/);
  assert.match(runnerSource, /options\.viewportHeight/);
  assert.match(runnerSource, /options\.deviceScaleFactor/);
  assert.match(runnerSource, /options\.resolutionScale/);
  assert.match(runnerSource, /representativeContentHelper/);
  assert.match(runnerSource, /cameraTrack/);
  assert.match(
    runnerSource,
    /quality\.validForCpuAggregation = false/,
  );
});

test("representative moving evidence uses an untimed bounded deterministic replay", () => {
  const workload = representativeManifest.workloads[0];
  assert.equal(workload.trackId, GLOBE_CAMERA_TRACK_ID);
  assert.equal(
    workload.measuredSeconds,
    GLOBE_CAMERA_TRACK_DURATION_SECONDS,
  );
  assert.equal(GLOBE_CAMERA_TRACK.length, 9);
  assert.equal(GLOBE_CAMERA_TRACK.at(-2).name, "ground-sf");
  assert.equal(GLOBE_CAMERA_TRACK.at(-1).name, "orbit-himalaya");

  const observerStart = runnerSource.indexOf(
    "const representativeCommandWindowStartRouteProgress",
  );
  const observerEnd = runnerSource.indexOf(
    'let validationQueueDrain = "not-requested"',
    observerStart,
  );
  assert.ok(observerStart >= 0 && observerEnd > observerStart);
  const observerSource = runnerSource.slice(observerStart, observerEnd);
  assert.match(
    observerSource,
    /\(representativeValidationWaypointIndex - 1\) \/\s+\(cameraTrack\.length - 1\)/,
  );
  assert.match(
    observerSource,
    /routeProgress >=\s+representativeCommandWindowStartRouteProgress &&\s+routeProgress < representativeCommandWindowEndRouteProgress/,
  );
  assert.match(
    observerSource,
    /representativeCommandSamplesTaken <\s+representativeCommandSampleLimit/,
  );
  assert.match(
    observerSource,
    /representativeCommandWindowTilesets\[index\]\.statistics\s+\?\.numberOfCommands/,
  );
  const fingerprintSample = observerSource.indexOf(
    "representativeReplayTracker.sampleWorkloadFingerprint(",
  );
  const fullSample = observerSource.indexOf(
    "representativeReplayTracker.sample()",
    fingerprintSample,
  );
  const commandGuard = observerSource.indexOf("if (tilesetCommands > 0)");
  const sampleIncrement = observerSource.indexOf(
    "representativeCommandSamplesTaken++",
    commandGuard,
  );
  assert.ok(fingerprintSample >= 0);
  assert.ok(fullSample > fingerprintSample);
  assert.ok(commandGuard >= 0);
  assert.ok(commandGuard > fullSample);
  assert.ok(sampleIncrement > commandGuard);
  assert.match(
    observerSource,
    /currentTrackState = applyCameraTrackProgress\(routeProgress\);\s+await waitFrames\(1, "representative-replay"\);\s+representativeReplayTracker\.sampleWorkloadFingerprint/,
  );
  assert.equal(
    observerSource.match(/representativeReplayTracker\.sample\(\)/g)?.length,
    1,
  );
});

test("performance navigation opts into deterministic offline viewer boot", () => {
  const url = buildPerformanceViewerUrl(
    `${manifest.baseUrl}?existing=preserved`,
    "webgpu",
  );
  assert.equal(url.searchParams.get("existing"), "preserved");
  assert.equal(url.searchParams.get("renderer"), "webgpu");
  assert.equal(url.searchParams.get("offline"), "true");
});

test("offline viewer boot creates no online startup resources", () => {
  const calls = [];
  const options = resolveCesiumViewerStartupOptions(
    {
      offline: "true",
      tmsImageryUrl: "https://example.invalid/tiles",
      scene3DOnly: "true",
    },
    {
      createTmsBaseLayer: () => calls.push("tms"),
      createWorldTerrain: () => calls.push("terrain"),
    },
  );

  assert.deepEqual(calls, []);
  assert.deepEqual(options, {
    baseLayer: false,
    hasBaseLayerPicker: false,
    terrain: undefined,
    scene3DOnly: "true",
    requestRenderMode: true,
  });
});

test("normal viewer boot preserves world and credentialed TMS paths", () => {
  const worldTerrain = { id: "world-terrain" };
  const defaultCalls = [];
  const defaultOptions = resolveCesiumViewerStartupOptions(
    {},
    {
      createTmsBaseLayer: () => defaultCalls.push("tms"),
      createWorldTerrain: () => {
        defaultCalls.push("terrain");
        return worldTerrain;
      },
    },
  );
  assert.deepEqual(defaultCalls, ["terrain"]);
  assert.equal(defaultOptions.baseLayer, undefined);
  assert.equal(defaultOptions.hasBaseLayerPicker, true);
  assert.equal(defaultOptions.terrain, worldTerrain);

  const tmsLayer = { id: "tms-layer" };
  const tmsCalls = [];
  const tmsOptions = resolveCesiumViewerStartupOptions(
    { offline: "false", tmsImageryUrl: "https://tiles.example.test" },
    {
      createTmsBaseLayer: (url) => {
        tmsCalls.push(["tms", url]);
        return tmsLayer;
      },
      createWorldTerrain: () => {
        tmsCalls.push(["terrain"]);
        return worldTerrain;
      },
    },
  );
  assert.deepEqual(tmsCalls, [
    ["tms", "https://tiles.example.test"],
    ["terrain"],
  ]);
  assert.equal(tmsOptions.baseLayer, tmsLayer);
  assert.equal(tmsOptions.hasBaseLayerPicker, false);
  assert.equal(tmsOptions.terrain, worldTerrain);
});

test("altitude flight workload uses the shared complete route", () => {
  const workload = manifest.workloads.find(
    (entry) => entry.action === "camera-track",
  );
  assert.ok(workload);
  assert.equal(workload.trackId, GLOBE_CAMERA_TRACK_ID);
  assert.equal(workload.featureProfile, "default-globe");
  assert.equal(workload.measuredSeconds, GLOBE_CAMERA_TRACK_DURATION_SECONDS);
  assert.ok(
    schema.properties.workloads.items.properties.action.enum.includes(
      "camera-track",
    ),
  );

  assert.equal(GLOBE_CAMERA_TRACK.length, 9);
  assert.equal(
    new Set(GLOBE_CAMERA_TRACK.map((waypoint) => waypoint.name)).size,
    9,
  );
  const heights = GLOBE_CAMERA_TRACK.map((waypoint) => waypoint.height);
  assert.equal(Math.max(...heights), 18_000_000);
  assert.equal(Math.min(...heights), 300);
  assert.equal(GLOBE_CAMERA_TRACK.at(-1).name, "orbit-himalaya");
});

test("continuous pick workload combines the altitude route with cursor motion", () => {
  const workload = manifest.workloads.find(
    (entry) => entry.action === "camera-track-pick",
  );
  assert.ok(workload);
  assert.equal(workload.id, "moving-pick-camera-altitude-track-3d");
  assert.equal(workload.trackId, GLOBE_CAMERA_TRACK_ID);
  assert.equal(workload.featureProfile, "default-globe");
  assert.equal(workload.content, "points-4096");
  assert.equal(workload.measuredSeconds, GLOBE_CAMERA_TRACK_DURATION_SECONDS);
  assert.ok(
    schema.properties.workloads.items.properties.action.enum.includes(
      "camera-track-pick",
    ),
  );
  const trackRequirement = schema.properties.workloads.items.allOf[0];
  assert.ok(
    trackRequirement.if.properties.action.enum.includes("camera-track-pick"),
  );
  assert.deepEqual(trackRequirement.then.required, ["trackId"]);
  assert.deepEqual(trackRequirement.then.oneOf, [
    { required: ["measuredSeconds"] },
    { required: ["measuredFrames"] },
  ]);
});

test("volumetric-cloud workload uses the moving route and WebGPU only", () => {
  const workload = manifest.workloads.find(
    (entry) => entry.id === "moving-camera-cloud-altitude-track-3d",
  );
  assert.ok(workload);
  assert.equal(workload.action, "camera-track");
  assert.equal(workload.trackId, GLOBE_CAMERA_TRACK_ID);
  assert.equal(workload.featureProfile, "volumetric-clouds");
  assert.deepEqual(workload.renderers, ["webgpu"]);
  assert.equal(workload.measuredSeconds, GLOBE_CAMERA_TRACK_DURATION_SECONDS);
  assert.ok(
    schema.properties.workloads.items.properties.featureProfile.enum.includes(
      "volumetric-clouds",
    ),
  );
  assert.deepEqual(
    schema.properties.workloads.items.properties.renderers.items.enum,
    ["webgl", "webgpu"],
  );
});

test("S5 eclipse manifest pins a moving real-eclipse evidence lane", () => {
  assert.equal(s5EclipseManifest.schemaVersion, 1);
  assert.equal(s5EclipseManifest.id, "c12-s5-eclipse-spatial-v1");
  assert.equal(s5EclipseManifest.protocol.browser, "msedge");
  assert.equal(s5EclipseManifest.protocol.fixedClock, "2026-08-12T17:42:42Z");
  assert.ok(s5EclipseManifest.protocol.repetitions >= 3);
  assert.ok(s5EclipseManifest.protocol.counterbalancedPairs >= 6);
  assert.equal(s5EclipseManifest.workloads.length, 1);

  const workload = s5EclipseManifest.workloads[0];
  assert.equal(workload.id, "moving-camera-eclipse-altitude-track-3d");
  assert.equal(workload.action, "camera-track");
  assert.equal(workload.trackId, GLOBE_CAMERA_TRACK_ID);
  assert.equal(workload.measuredSeconds, GLOBE_CAMERA_TRACK_DURATION_SECONDS);
  assert.equal(workload.featureProfile, "default-globe");
  assert.equal(workload.evidenceProfile, "eclipse-globe-shadow");
  assert.ok(
    schema.properties.workloads.items.properties.evidenceProfile.enum.includes(
      workload.evidenceProfile,
    ),
  );
});

test("S5 eclipse evidence rejects vacuous or malformed activation routes", () => {
  const samples = [{ cpuMs: 1 }, { cpuMs: 2 }, { cpuMs: 3 }];
  const valid = summarizeEclipseGlobeShadowEvidence(samples, [
    {
      eclipseGlobeShadowGate: 0,
      eclipseGlobeShadowRevision: 1,
      eclipseMoonObscuration: 0,
    },
    {
      eclipseGlobeShadowGate: 1,
      eclipseGlobeShadowRevision: 2,
      eclipseMoonObscuration: 0.5,
    },
    {
      eclipseGlobeShadowGate: 3,
      eclipseGlobeShadowRevision: 3,
      eclipseMoonObscuration: 0.8,
    },
  ]);
  assert.equal(valid.valid, true);
  assert.equal(valid.localShadowFrameCount, 1);
  assert.equal(valid.bypassOrCorrectionFrameCount, 2);

  const allActive = summarizeEclipseGlobeShadowEvidence(
    samples,
    samples.map(() => ({
      eclipseGlobeShadowGate: 2,
      eclipseGlobeShadowRevision: 1,
      eclipseMoonObscuration: 1,
    })),
  );
  assert.equal(allActive.valid, false);
  assert.ok(
    allActive.reasons.some((reason) =>
      reason.includes("inactive/correction-only"),
    ),
  );
  assert.equal(
    assessPerformanceRunQuality({
      timestampEnabled: false,
      eclipseGlobeShadowEvidence: allActive,
    }).validForAggregation,
    false,
  );

  const missing = summarizeEclipseGlobeShadowEvidence(samples, [
    {
      eclipseGlobeShadowGate: null,
      eclipseGlobeShadowRevision: null,
      eclipseMoonObscuration: null,
    },
  ]);
  assert.equal(missing.valid, false);
  assert.equal(missing.aligned, false);
  assert.equal(missing.invalidGateCount, 1);
});

test("implicit renderer-specific workloads skip while explicit requests fail", () => {
  const workloads = [
    { id: "shared" },
    { id: "webgpu-only", renderers: ["webgpu"] },
  ];

  assert.deepEqual(renderersForWorkload(workloads[0], ["webgl"]), ["webgl"]);
  assert.deepEqual(
    selectWorkloadsForRenderers(workloads, ["webgl"]),
    {
      selected: [workloads[0]],
      skipped: [
        {
          id: "webgpu-only",
          reason: "unsupported-renderer",
          selectedRenderers: ["webgl"],
          supportedRenderers: ["webgpu"],
        },
      ],
      skippedRenderers: [],
    },
  );
  assert.throws(
    () =>
      selectWorkloadsForRenderers([workloads[1]], ["webgl"], {
        strict: true,
      }),
    /Explicit workload request does not support selected renderer/,
  );
  assert.deepEqual(
    selectWorkloadsForRenderers(workloads, ["webgl", "webgpu"]),
    {
      selected: workloads,
      skipped: [],
      skippedRenderers: [
        {
          id: "webgpu-only",
          reason: "unsupported-renderer",
          skippedRenderers: ["webgl"],
          compatibleRenderers: ["webgpu"],
          supportedRenderers: ["webgpu"],
        },
      ],
    },
  );
  assert.throws(
    () =>
      selectWorkloadsForRenderers([workloads[1]], ["webgl", "webgpu"], {
        strict: true,
      }),
    /Explicit workload request does not support selected renderer/,
  );
});

test("renderer repetitions are truly counterbalanced AB then BA", () => {
  const schedule = buildCounterbalancedSchedule(["webgl", "webgpu"], 6);
  assert.deepEqual(
    schedule.map((entry) => entry.order.join(",")),
    [
      "webgl,webgpu",
      "webgpu,webgl",
      "webgl,webgpu",
      "webgpu,webgl",
      "webgl,webgpu",
      "webgpu,webgl",
    ],
  );
  assert.equal(
    schedule.filter((entry) => entry.order[0] === "webgl").length,
    3,
  );
  assert.equal(
    schedule.filter((entry) => entry.order[0] === "webgpu").length,
    3,
  );
  assert.deepEqual(buildCounterbalancedSchedule(["webgpu"], 2), [
    { repetition: 1, order: ["webgpu"] },
    { repetition: 2, order: ["webgpu"] },
  ]);
});

test("API owner-label snapshots produce a bounded exact measurement delta", () => {
  const start = {
    webgpuBuffersCreated: {
      terrain: 4,
      shared: 2,
    },
    webgpuRenderPassesBegun: {
      scene: 10,
    },
  };
  const end = {
    webgpuBuffersCreated: {
      terrain: 9,
      shared: 2,
      atmosphere: 1,
    },
    webgpuRenderPassesBegun: {
      scene: 13,
      post: 2,
    },
  };

  assert.deepEqual(diffCounterLabelSnapshots(start, end), {
    webgpuBuffersCreated: {
      atmosphere: 1,
      terrain: 5,
    },
    webgpuRenderPassesBegun: {
      post: 2,
      scene: 3,
    },
  });
});

test("logical counter snapshots retain exact measured-window deltas", () => {
  assert.deepEqual(
    diffFlatCounterSnapshots(
      { tileCalls: 10, liveBytes: 100, unchanged: 2 },
      { tileCalls: 14, liveBytes: 175, unchanged: 2, uploads: 3 },
    ),
    { liveBytes: 75, tileCalls: 4, uploads: 3 },
  );
});

test("long-task selection excludes late setup delivery and keeps the terminal task", () => {
  const selected = selectLongTasksInMeasurementWindow(
    [
      { startTime: 90, duration: 30 },
      { startTime: 120, duration: 60 },
      { startTime: 195, duration: 80 },
      { startTime: 200, duration: 55 },
    ],
    100,
    200,
  );

  assert.deepEqual(selected, [
    { startTime: 120, duration: 60, rawDuration: 60 },
    { startTime: 195, duration: 5, rawDuration: 80 },
  ]);
});

test("frame pacing reports FPS, one-percent low, and dropped frames", () => {
  const pacing = summarizeFramePacing([
    { wallDtMs: 16 },
    { wallDtMs: 16 },
    { wallDtMs: 34 },
  ]);
  assert.equal(pacing.sampleCount, 3);
  assert.ok(pacing.averageFps > 45 && pacing.averageFps < 46);
  assert.ok(pacing.onePercentLowFps > 29 && pacing.onePercentLowFps < 30);
  assert.equal(pacing.droppedFramesAtRefreshRate, 1);
});

test("per-segment metrics require exact trace/evidence alignment", () => {
  const evidence = GLOBE_CAMERA_TRACK.slice(0, -1).map(
    (waypoint, index, entries) => ({
      segmentIndex: index,
      height: waypoint.height,
      routeProgress: index / (entries.length - 1),
    }),
  );
  let sampleIndex = 0;
  const samples = evidence.map(() => {
    const index = sampleIndex++;
    return {
      cpuMs: index + 1,
      wallDtMs: 16 + index,
      gpuMs: 0.5 + index,
    };
  });
  const summary = summarizeTrackMetrics(samples, evidence, GLOBE_CAMERA_TRACK);
  assert.equal(summary.aligned, true);
  assert.equal(summary.coveredAllSegments, true);
  assert.equal(summary.completedRoute, true);
  assert.equal(summary.segments.length, GLOBE_CAMERA_TRACK.length - 1);
  assert.equal(summary.segments[0].cpuMs.count, 1);
  assert.equal(summary.gpuSegmentAlignment.aligned, false);
  assert.equal(summary.segments[0].gpuMs, null);

  const misaligned = summarizeTrackMetrics(
    samples.slice(1),
    evidence,
    GLOBE_CAMERA_TRACK,
  );
  assert.equal(misaligned.aligned, false);
  assert.equal(misaligned.segments, null);
});

test("moving-pick metrics reject a fixed cursor and accept a continuous sweep", () => {
  const samples = Array.from({ length: 60 }, () => ({ cpuMs: 1 }));
  const movingEvidence = samples.map((_, index) => ({
    x: index,
    y: index * 2,
    normalizedX: index / 59,
    normalizedY: 1 - index / 59,
  }));
  const moving = summarizeMovingPickMetrics(samples, movingEvidence, 60);
  assert.equal(moving.aligned, true);
  assert.equal(moving.continuous, true);
  assert.equal(moving.cursorMovedAcrossViewport, true);
  assert.equal(moving.uniquePositionCount, 60);

  const fixedEvidence = samples.map(() => ({
    x: 640,
    y: 360,
    normalizedX: 0.5,
    normalizedY: 0.5,
  }));
  const fixed = summarizeMovingPickMetrics(samples, fixedEvidence, 60);
  assert.equal(fixed.cursorMovedAcrossViewport, false);
  const quality = assessPerformanceRunQuality({
    timestampEnabled: false,
    measurement: { elapsedMs: 1_000 },
    longTasks: { available: true, count: 0, totalMs: 0 },
    pickMetrics: fixed,
  });
  assert.equal(quality.validForAggregation, false);
});

test("moving-pick metrics include out-of-render CPU and reject hover starvation", () => {
  const samples = Array.from({ length: 60 }, () => ({ cpuMs: 2 }));
  const evidence = samples.map((_, index) => ({
    x: index,
    y: index,
    normalizedX: index / 59,
    normalizedY: 1 - index / 59,
    pickCpuMs: 0.5,
  }));
  const telemetry = {
    publicApi: "pickHoverAsync",
    publicCalls: 60,
    completedCalls: 60,
    completedBeforeDrain: 50,
    completedDuringDrain: 10,
    rejectedCalls: 0,
    pendingCalls: 0,
    executionCount: 60,
    publicCallCpuMs: Array(60).fill(0.2),
    executionCpuMs: Array(60).fill(0.4),
    asyncExecutionCpuMs: Array(30).fill(0.6),
    executionCpuUnbucketedMs: 0,
    drainStatus: "drained",
    drainElapsedMs: 2,
  };
  const summary = summarizeMovingPickMetrics(samples, evidence, telemetry);
  assert.equal(summary.telemetryValid, true);
  assert.equal(summary.cpuEvidenceAligned, true);
  assert.equal(summary.cpuAccountingAligned, true);
  assert.equal(summary.combinedCpuMs.p95, 2.5);
  assert.ok(Math.abs(summary.accountedPickCpuMs - 30) < 1e-10);

  const starved = summarizeMovingPickMetrics(samples, evidence, {
    ...telemetry,
    completedBeforeDrain: 0,
    completedDuringDrain: 60,
  });
  assert.equal(starved.telemetryValid, false);
  const quality = assessPerformanceRunQuality({
    timestampEnabled: false,
    measurement: { elapsedMs: 1_000 },
    longTasks: { available: true, count: 0, totalMs: 0 },
    pickMetrics: starved,
  });
  assert.equal(quality.validForAggregation, false);
});

test("performance quality rejects the observed long-task/readback collapse", () => {
  const healthy = {
    measurement: { elapsedMs: 20_000 },
    longTasks: { available: true, count: 0, totalMs: 0 },
    timestampEnabled: true,
    timestampResults: {
      attemptedFrameCount: 1_200,
      readbackSkipCount: 5,
      failedReadbackCount: 0,
    },
    trackMetrics: {
      aligned: true,
      coveredAllSegments: true,
      completedRoute: true,
      segments: Array.from({ length: 8 }, (_, index) => ({
        index,
        sampleCount: 100,
      })),
    },
  };
  const collapsed = {
    ...healthy,
    longTasks: { available: true, count: 104, totalMs: 7_491 },
    timestampResults: {
      attemptedFrameCount: 290,
      readbackSkipCount: 105,
      failedReadbackCount: 0,
    },
    trackMetrics: {
      ...healthy.trackMetrics,
      segments: Array.from({ length: 8 }, (_, index) => ({
        index,
        sampleCount: index === 6 ? 10 : 30,
      })),
    },
  };

  assert.equal(assessPerformanceRunQuality(healthy).validForAggregation, true);
  const quality = assessPerformanceRunQuality(collapsed);
  assert.equal(quality.validForAggregation, false);
  assert.equal(quality.suspectedMainThreadContamination, true);
  assert.ok(quality.reasons.some((reason) => reason.includes("10/30")));
  assert.ok(quality.reasons.some((reason) => reason.includes("36.2%")));
});

test("performance aggregate stability rejects bimodal repetitions", () => {
  const makeRun = (cpuP95, measuredFrames) => ({
    result: "pass",
    quality: { validForCpuAggregation: true },
    requestedMeasurement: { mode: "duration" },
    measuredFrames,
    trace: { summary: { cpuMs: { p95: cpuP95 } } },
  });
  const stability = assessPerformanceRunStability([
    makeRun(10, 1_150),
    makeRun(90, 290),
  ]);

  assert.equal(stability.stable, false);
  assert.ok(stability.reasons.some((reason) => reason.includes("9.00")));
  assert.ok(stability.reasons.some((reason) => reason.includes("3.97")));
});

test("API-instrumented runs are attribution-only, non-certifying, and not timing aggregates", () => {
  const quality = assessPerformanceRunQuality({
    timestampEnabled: false,
    apiCounters: { enabled: true },
  });
  assert.equal(quality.status, "attribution-only");
  assert.equal(quality.attributionOnly, true);
  assert.equal(quality.certificationEligible, false);
  assert.equal(quality.measurementValid, true);
  assert.equal(quality.validForAggregation, false);
  assert.equal(quality.validForCpuAggregation, false);
  assert.equal(quality.validForGpuAggregation, false);
  assert.ok(
    quality.warnings.some((warning) => warning.includes("attribution-only")),
  );

  const stability = assessPerformanceRunStability([
    { result: "pass", quality },
    { result: "pass", quality: { ...quality } },
  ]);
  assert.equal(stability.stable, true);
  assert.equal(stability.attributionOnly, true);
  assert.equal(stability.certificationEligible, false);
  assert.equal(stability.comparedRunCount, 0);

  assert.match(runnerSource, /attributionOnlyRunCount/);
  assert.match(runnerSource, /run\.quality\?\.status === "invalid"/);
});

test("fixed-frame progress comparison observes both rendered sequences", () => {
  const identical = compareFixedFrameProgressSequences(
    [0, 0.5, 1],
    [0, 0.5, 1],
  );
  assert.equal(identical.identical, true);
  assert.equal(identical.reason, null);
  assert.equal(identical.firstDivergenceIndex, null);
  assert.equal(identical.comparedFrames, 3);
  assert.equal(identical.maximumAbsoluteDifference, 0);

  // Float route arithmetic must not be called a divergence.
  const withinTolerance = compareFixedFrameProgressSequences(
    [0, 1 / 3, 2 / 3, 1],
    [0, 0.3333333333333333, 0.6666666666666666, 1],
  );
  assert.equal(withinTolerance.identical, true);

  const shifted = compareFixedFrameProgressSequences(
    [1 / 3, 2 / 3, 1, 1],
    [0, 1 / 3, 2 / 3, 1],
  );
  assert.equal(shifted.identical, false);
  assert.equal(shifted.reason, "rendered-progress-divergence");
  assert.equal(shifted.firstDivergenceIndex, 0);
  // The final frame coincides at progress 1 even though the whole phase is
  // shifted — precisely why a tail-only or endpoint check proves nothing.
  assert.equal(shifted.divergenceCount, 3);
  assert.equal(shifted.divergences[0].measured, 1 / 3);
  assert.equal(shifted.divergences[0].replay, 0);

  const oneFrame = compareFixedFrameProgressSequences(
    [0, 0.25, 0.5, 0.75, 1],
    [0, 0.25, 0.75, 0.75, 1],
  );
  assert.equal(oneFrame.identical, false);
  assert.equal(oneFrame.firstDivergenceIndex, 2);
  assert.equal(oneFrame.divergenceCount, 1);

  const countMismatch = compareFixedFrameProgressSequences([0, 1], [0, 0.5, 1]);
  assert.equal(countMismatch.identical, false);
  assert.equal(countMismatch.reason, "rendered-frame-count-mismatch");

  const empty = compareFixedFrameProgressSequences([], []);
  assert.equal(empty.identical, false);
  assert.equal(empty.reason, "no-measured-rendered-frames");

  const missing = compareFixedFrameProgressSequences(undefined, [0, 1]);
  assert.equal(missing.identical, false);
  assert.equal(missing.reason, "missing-rendered-progress-sequence");
  assert.equal(missing.measuredFrameCount, null);

  // A null entry means the frame rendered with no known camera phase; it can
  // never be silently treated as a match.
  const nullEntry = compareFixedFrameProgressSequences([0, null], [0, 1]);
  assert.equal(nullEntry.identical, false);
  assert.equal(nullEntry.firstDivergenceIndex, 1);
  assert.equal(nullEntry.divergences[0].measured, null);

  // The bounded divergence sample must not grow with the route length.
  const long = compareFixedFrameProgressSequences(
    Array.from({ length: 600 }, (_, index) => index / 599),
    Array.from({ length: 600 }, () => 0),
  );
  assert.equal(long.identical, false);
  assert.equal(long.divergences.length, 8);
  assert.equal(long.divergencesTruncated, true);
  assert.equal(long.divergenceCount, 599);
});

test("replay provenance is measured from rendered phase, never restated from config", () => {
  // The defect: both flags were `residentRepresentativeReplay`, i.e. the
  // workload's configured terrain mode. They must now come from the comparison.
  assert.doesNotMatch(
    runnerSource,
    /identicalFixedFrameProgress: residentRepresentativeReplay/,
  );
  assert.doesNotMatch(runnerSource, /causal: residentRepresentativeReplay/);
  assert.match(
    runnerSource,
    /const measuredRenderedProgress = cameraTrackEnabled\s+\? trackEvidence\.map\(\(evidence\) => evidence\.routeProgress\)\s+: \[\]/,
  );
  assert.match(
    runnerSource,
    /const removeReplayProgressEvidence =\s+scene\.postRender\.addEventListener\(\(\) => \{\s+replayRenderedProgress\.push\(/,
  );
  assert.match(
    runnerSource,
    /campaignUtilsModule\.compareFixedFrameProgressSequences\(\s+measuredRenderedProgress,\s+replayRenderedProgress,\s+\)/,
  );
  assert.match(
    runnerSource,
    /const identicalFixedFrameProgress =\s+residentRepresentativeReplay &&\s+fixedFrameProgressComparison\.identical === true/,
  );
  assert.match(
    runnerSource,
    /renderedProgressIdentical:\s+fixedFrameProgressComparison\.identical === true,\s+causal: identicalFixedFrameProgress/,
  );
  // The raw sequences must be persisted so the Node-side gate can re-derive
  // the claim instead of trusting the boolean the page wrote.
  assert.match(
    runnerSource,
    /renderedProgress: \{\s+measured: measuredRenderedProgress,\s+replay: replayRenderedProgress,\s+\}/,
  );
  // One comparator, shared by the page and the gate.
  assert.match(
    runnerSource,
    /await import\(\s+"\/Tools\/visual-regression\/lib\/performance-campaign-utils\.mjs"\s+\)/,
  );

  const fingerprintMetricNames = [
    "terrainTilesToRender",
    "terrainMeshTiles",
    "terrainSelectionIdentityA",
    "terrainSelectionIdentityB",
    "terrainUnidentifiedTiles",
    "directModelInstancesConfigured",
    "directModelInstancesReady",
    "directModelIdentityA",
    "directModelIdentityB",
    "tilesetsWithSelection",
    "tilesetSelected",
    "tilesetSelectionIdentityA",
    "tilesetSelectionIdentityB",
    "tilesetSelectionCountMismatch",
    "tilesetUnidentifiedSelected",
  ];
  const zeroMetrics = () =>
    Object.fromEntries(
      fingerprintMetricNames.map((name) => [name, { total: 0, min: 0, max: 0 }]),
    );
  const provenance = {
    timed: false,
    phase: "post-measurement-untimed-replay",
    traceEndedBeforeReplay: true,
    measurementSnapshotsFrozenBeforeReplay: true,
    replayModeFixedFrame: true,
    renderedProgressIdentical: true,
    causal: true,
  };
  const makeFingerprintRun = (fingerprintProvenance) => ({
    measuredFrames: 1,
    quality: {
      status: "clean",
      attributionOnly: false,
      certificationEligible: true,
    },
    apiCounters: { enabled: false },
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
      measurementContent: {
        workloadFingerprint: {
          schemaVersion: 1,
          valid: true,
          frameCount: 1,
          invalidSampleCount: 0,
          signature: "0000000a-0000000b",
          provenance: fingerprintProvenance,
          metrics: zeroMetrics(),
          segments: [
            {
              segmentIndex: 0,
              frameCount: 1,
              signature: "0000000c-0000000d",
              metrics: zeroMetrics(),
            },
          ],
        },
      },
    },
  });
  const options = {
    measurementTerrainMode: "resident",
    maximumDeltaRatio: 0.05,
  };
  const honest = assessRepresentativePairComparability(
    makeFingerprintRun(provenance),
    makeFingerprintRun({ ...provenance }),
    options,
  );
  assert.equal(honest.valid, true);
  assert.equal(honest.metrics.workloadFingerprint.signatureMatch, true);

  // `causal: true` alone is no longer sufficient: the two facts that produce
  // it must both be present, so a bare boolean cannot certify the window.
  for (const dishonest of [
    { ...provenance, renderedProgressIdentical: false },
    { ...provenance, replayModeFixedFrame: false },
    (() => {
      const copy = { ...provenance };
      delete copy.renderedProgressIdentical;
      return copy;
    })(),
  ]) {
    const rejected = assessRepresentativePairComparability(
      makeFingerprintRun(dishonest),
      makeFingerprintRun({ ...provenance }),
      options,
    );
    assert.equal(rejected.valid, false);
    assert.ok(
      rejected.reasons.some((reason) =>
        reason.includes("untimed causal replay provenance"),
      ),
    );
  }
});

test("every frame wait is bounded and reports a timeout as structural", () => {
  // The hazard: page.evaluate carries no Playwright timeout, so a wait that
  // only ever resolves from scene.postRender wedges an unattended campaign
  // forever while holding a live GPU context.
  const waitStart = runnerSource.indexOf("const awaitRenderedFrames");
  const waitEnd = runnerSource.indexOf("const waitForMorph", waitStart);
  assert.ok(waitStart > 0 && waitEnd > waitStart);
  const waitSource = runnerSource.slice(waitStart, waitEnd);

  // Doubly bounded: an inter-frame stall window that re-arms on every rendered
  // frame, plus an absolute budget derived from the requested frame count.
  assert.match(waitSource, /stallTimeoutId = setTimeout\(/);
  assert.match(waitSource, /budgetTimeoutId = setTimeout\(/);
  assert.match(waitSource, /armStall\(\);/);
  // A timeout must remove the listener and REJECT — never resolve.
  assert.match(waitSource, /const fail = \(bound\) =>\s+settle\(\s+new Error\(/);
  assert.match(waitSource, /\[structural\] frame wait/);
  assert.match(waitSource, /structurally invalid/);
  assert.match(waitSource, /remove\?\.\(\);/);

  // The budget must be floored (a slow frame is not a stall) and ceilinged
  // (a large frame count must not reconstruct an unbounded wait).
  assert.match(
    runnerSource,
    /const frameWaitStallMs = Math\.max\(\s+protocolDefinition\.settleTimeoutMs,\s+5000,\s+\)/,
  );
  assert.match(
    runnerSource,
    /Math\.min\(\s+frameWaitCeilingMs,\s+Math\.max\(frameWaitStallMs, count \* frameWaitPerFrameMs\),\s+\)/,
  );

  // Every call site must be labelled so a stall names the phase that stalled.
  const callSites = [
    ...runnerSource.matchAll(/await waitFrames\(([\s\S]*?)\);/g),
  ];
  assert.ok(callSites.length >= 10);
  for (const [, args] of callSites) {
    assert.match(
      args,
      /,\s*"[a-z-]+",?\s*$/,
      `unlabelled waitFrames call: waitFrames(${args})`,
    );
  }

  // The duration-mode measurement window shares the same bounded primitive;
  // no postRender-only promise may remain there.
  assert.match(
    runnerSource,
    /await awaitRenderedFrames\(\s+"measurement-duration",/,
  );
  // A structural failure inside the measured window must not leave the trace
  // open, the action loop running, or Scene.updateDerivedCommands patched.
  assert.match(
    runnerSource,
    /\} catch \(measurementWaitError\) \{[\s\S]*?stopActionLoop\(\);[\s\S]*?removeActionEvidence\?\.\(\);[\s\S]*?scene\.endPerformanceTrace\(\);[\s\S]*?scene\.updateDerivedCommands = originalSceneUpdateDerivedCommands;[\s\S]*?throw measurementWaitError;/,
  );
});
