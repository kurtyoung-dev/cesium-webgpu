import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  C12_29_S5_DENSE_BUILD_SOURCE_FILES,
  C12_29_S5_DENSE_CONFIG,
  C12_29_S5_DENSE_LEGACY_SCHEMA,
  C12_29_S5_DENSE_LOCAL_FILES,
  C12_29_S5_DENSE_NASA_V4_SOURCE_FILES,
  C12_29_S5_DENSE_RAW_GENERATED_PAIRS,
  C12_29_S5_DENSE_RENDERERS,
  C12_29_S5_DENSE_RUNTIME_SCHEMA,
  C12_29_S5_DENSE_SCHEDULE,
  C12_29_S5_DENSE_SCHEMA,
  C12_29_S5_DENSE_SERVED_FILES,
  C12_29_S5_DENSE_SOURCE_FILES,
  C12_29_S5_DENSE_SUPERSEDED_BUILD_SOURCE_FILES,
  C12_29_S5_DENSE_SUPERSEDED_LOCAL_FILES,
  C12_29_S5_DENSE_SUPERSEDED_SCHEMA,
  C12_29_S5_DENSE_SUPERSEDED_SOURCE_FILES,
  createC1229S5DenseWaterMask,
  deriveC1229S5DenseSentinel,
  exitCodeForC1229S5DenseStatus,
  foldC1229S5DenseCostGate,
  foldC1229S5DenseLegacyCostGate,
  foldC1229S5DenseSupersededCostGate,
  isC1229S5DenseUuidV4,
  sampleC1229S5DenseRoute,
  selectC1229S5DenseLongTasks,
  stableC1229S5DenseJson,
  summarizeC1229S5DenseSamples,
  validateC1229S5DenseFinalArtifact,
  validateC1229S5DenseLegacyFinalArtifact,
  validateC1229S5DensePrerequisites,
  validateC1229S5DenseRuntimeLeg,
  validateC1229S5DenseSupersededFinalArtifact,
  validateC1229S5DenseWorkload,
} from "./lib/c12-29-s5-dense-cost-gate.mjs";
import {
  C12_29_S5_SVS_SCHEMA,
  C12_29_S5_SVS_SOURCE_FILES,
} from "./lib/c12-29-s5-svs-footprint-gate.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const workload = JSON.parse(
  await readFile(
    resolve(directory, "performance-workloads-s5-dense-cost.json"),
    "utf8",
  ),
);
const readSource = async (...parts) =>
  (await readFile(resolve(directory, ...parts), "utf8")).replaceAll(
    "\r\n",
    "\n",
  );

const RUN_ID = "11111111-2222-4333-8444-555555555555";
const TERRAIN_RUN_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const NASA_RUN_ID = "12345678-1234-4abc-9def-123456789abc";
const SOURCE_SHA = "b".repeat(64);
const PREREQUISITES_SHA = "c".repeat(64);
const WORKLOAD_SHA = C12_29_S5_DENSE_CONFIG.workloadSha256;
const TEST_CAMPAIGN_START_MS = Date.parse("2026-08-13T12:00:00.000Z");

const clone = (value) => structuredClone(value);

function prerequisite(kind, producer, schema, runId, hashCharacter) {
  return {
    kind,
    producer,
    publication: {
      path: `F:/evidence/${producer}/${runId}/manifest.json`,
      schema: "cesium-visual-evidence-publication/v2",
      runId,
      status: "PASS",
      exitCode: 0,
      certificationEligible: true,
      byteLength: 2048,
      sha256: hashCharacter.repeat(64),
    },
    artifact: {
      path: `F:/evidence/${producer}/${runId}/files/${runId}.json`,
      name: `${runId}.json`,
      schema,
      runId,
      status: "PASS",
      incomplete: false,
      exitCode: 0,
      byteLength: 4096,
      sha256: hashCharacter.toUpperCase().repeat(64),
    },
  };
}

function validPrerequisites() {
  return {
    terrain: prerequisite(
      "terrain",
      "c12-29-s5-terrain-selection",
      "c12-29-s5-terrain-selection-evidence-v10",
      TERRAIN_RUN_ID,
      "d",
    ),
    nasa: prerequisite(
      "nasa",
      "c12-29-s5-svs-footprint",
      "c12-29-s5-svs-5073-footprint-evidence-v4",
      NASA_RUN_ID,
      "e",
    ),
  };
}

function terrainFrame(frameIndex, condition, sentinelKeys) {
  const selected = [sentinelKeys[frameIndex % sentinelKeys.length]];
  return {
    frameIndex,
    selectedKeys: selected,
    realMeshKeys: [...selected],
    ownRealMeshKeys: [...selected],
    fillMeshKeys: [],
    foreignTerrainKeys: [],
    selectedCount: selected.length,
    realMeshCount: selected.length,
    ownRealMeshCount: selected.length,
    fillMeshCount: 0,
    gate: condition === "active" ? (frameIndex % 2 === 0 ? 1 : 2) : 0,
    logicalDrawCount: selected.length,
    commandCount: selected.length,
  };
}

function traceSamples(cpuMs, sentinelKeys) {
  return Array.from({ length: 600 }, (_, index) => ({
    frameNumber: index + 1,
    relFrame: index,
    wallDtMs: 16,
    cpuMs,
    drawCount: 1,
    commandCount: 1,
    snapshotFrozen: false,
  }));
}

function validLeg(
  scheduleLeg,
  sourceSha = SOURCE_SHA,
  prerequisitesSha = PREREQUISITES_SHA,
) {
  const legStartedAt = new Date(
    TEST_CAMPAIGN_START_MS + (scheduleLeg.ordinal - 1) * 10 * 60_000,
  ).toISOString();
  const legCompletedAt = new Date(
    TEST_CAMPAIGN_START_MS + ((scheduleLeg.ordinal - 1) * 10 + 5) * 60_000,
  ).toISOString();
  const sentinel = deriveC1229S5DenseSentinel(workload.route);
  const route = Array.from({ length: 600 }, (_, index) => {
    const sample = sampleC1229S5DenseRoute(workload.route, index, 600);
    return {
      ...sample,
      actual: {
        longitude: sample.longitude,
        latitude: sample.latitude,
        height: sample.height,
        heading: sample.heading,
        pitch: sample.pitch,
        roll: sample.roll,
      },
    };
  });
  const frames = Array.from({ length: 600 }, (_, index) =>
    terrainFrame(index, scheduleLeg.condition, sentinel.keys),
  );
  const cpuMs =
    (scheduleLeg.condition === "active" ? 2 : 1) +
    scheduleLeg.repetition * 0.01;
  const trace = { samples: traceSamples(cpuMs, sentinel.keys) };
  const gpuSamples = Array(600).fill(
    (scheduleLeg.condition === "active" ? 3 : 2) +
      scheduleLeg.repetition * 0.01,
  );
  const defaultFeatureSnapshot = {
    highDynamicRange: false,
    sunBloom: true,
    taaEnabled: false,
    motionBlur: false,
    msaaSamples: 4,
    fogEnabled: true,
    skyAtmosphereShown: true,
    skyBoxShown: true,
    sunShown: true,
    moonShown: true,
    globeShown: true,
    groundAtmosphereShown: true,
    waterEffectShown: true,
    imageryLayerCount: 0,
    postProcessStageCount: 0,
    fxaaEnabled: false,
    bloomEnabled: false,
  };
  return {
    schema: C12_29_S5_DENSE_RUNTIME_SCHEMA,
    runId: RUN_ID,
    legId: `r${String(scheduleLeg.repetition).padStart(2, "0")}-${String(scheduleLeg.withinRepetition).padStart(2, "0")}-${scheduleLeg.renderer}-${scheduleLeg.condition}`,
    scheduleLeg: clone(scheduleLeg),
    sourceIdentitySha256: sourceSha,
    prerequisitesSha256: prerequisitesSha,
    workloadIdentity: {
      path: "Tools/visual-regression/performance-workloads-s5-dense-cost.json",
      byteLength: C12_29_S5_DENSE_CONFIG.workloadByteLength,
      sha256: WORKLOAD_SHA,
    },
    startedAt: legStartedAt,
    completedAt: legCompletedAt,
    status: "PASS",
    incomplete: false,
    error: null,
    subprocess: {
      exitCode: 0,
      signal: null,
      timedOut: false,
      childProcessId: 10_000 + scheduleLeg.ordinal,
      launchId: `00000000-0000-4000-8000-${String(scheduleLeg.ordinal).padStart(12, "0")}`,
    },
    browser: {
      channel: "msedge",
      version: "140.0.0.0",
      userAgent: "Edge test",
      viewport: clone(C12_29_S5_DENSE_CONFIG.viewport),
      canvas: {
        clientWidth: 1280,
        clientHeight: 720,
        width: 1280,
        height: 720,
        drawingBufferWidth: 1280,
        drawingBufferHeight: 720,
        resolutionScale: 1,
      },
    },
    renderer: {
      requested: scheduleLeg.renderer,
      actual: scheduleLeg.renderer,
      rendererString: scheduleLeg.renderer === "webgl" ? "test adapter" : "",
      adapterInfo:
        scheduleLeg.renderer === "webgpu"
          ? {
              vendor: "test",
              architecture: "test",
              device: "",
              description: "",
            }
          : null,
      gpuIdentityComplete: true,
    },
    servedEntry: {
      ok: true,
      status: 200,
      byteLength: 1,
      sha256: "2".repeat(64),
    },
    transport: {
      externalRequests: [],
      failedRequests: [],
      pageErrors: [],
      consoleErrors: [],
      dialogs: [],
    },
    errors: { gpu: [], deviceLost: false },
    configuration: {
      fixedClock: C12_29_S5_DENSE_CONFIG.fixedClock,
      shouldAnimate: false,
      maximumScreenSpaceError: 0.1,
      tileCacheSize: 8192,
      globeLighting: true,
      defaultFeaturesRetained: true,
      defaultFeatureSnapshot: clone(defaultFeatureSnapshot),
      defaultFeatureSnapshotEnd: clone(defaultFeatureSnapshot),
      requestRenderMode: true,
      explicitMeasuredRenders: 600,
      enableEclipse: true,
      enableEclipseGlobeShadow: scheduleLeg.condition === "active",
    },
    prime: {
      variants: [
        { condition: "active", frameCount: 600 },
        { condition: "inactive", frameCount: 600 },
      ],
      settledFrames: 30,
      sentinel,
      seenOwnRealSentinelKeys: [...sentinel.keys],
      waterMask: {
        width: 16,
        values: [0, 255],
        pattern: C12_29_S5_DENSE_CONFIG.waterMaskPattern,
        sha256: C12_29_S5_DENSE_CONFIG.waterMaskSha256,
      },
    },
    measurement: {
      frameCount: 600,
      route: clone(route),
      frames: clone(frames),
      trace: clone(trace),
      cpuSummary: summarizeC1229S5DenseSamples(
        trace.samples.map((sample) => sample.cpuMs),
      ),
      framePacing: {
        semantics: C12_29_S5_DENSE_CONFIG.refreshSemantics,
        requestAnimationFrameYieldCount: 600,
        elapsedMs: 9600,
        wallSummary: summarizeC1229S5DenseSamples(
          trace.samples.map((sample) => sample.wallDtMs),
        ),
      },
      longTasks: {
        observerAvailable: true,
        entries: [{ startTime: 2000, rawDuration: 100, duration: 100 }],
        totalDurationMs: 100,
        measurementStartMs: 1000,
        measurementEndMs: 10600,
        measurementDurationMs: 9600,
        share: 100 / 9600,
      },
      terrainActivity: {
        start: {
          requestCount: 1,
          generationCount: 1,
          cacheHitCount: 0,
          requestedKeys: ["12/1723/1469"],
          generatedKeys: ["12/1723/1469"],
          waterMaskWidth: 16,
          waterMaskPattern: C12_29_S5_DENSE_CONFIG.waterMaskPattern,
          waterMaskSha256: C12_29_S5_DENSE_CONFIG.waterMaskSha256,
        },
        end: {
          requestCount: 1,
          generationCount: 1,
          cacheHitCount: 0,
          requestedKeys: ["12/1723/1469"],
          generatedKeys: ["12/1723/1469"],
          waterMaskWidth: 16,
          waterMaskPattern: C12_29_S5_DENSE_CONFIG.waterMaskPattern,
          waterMaskSha256: C12_29_S5_DENSE_CONFIG.waterMaskSha256,
        },
        delta: {
          requestCount: 0,
          generationCount: 0,
          cacheHitCount: 0,
          requestedKeys: [],
          generatedKeys: [],
        },
      },
    },
    replay: {
      timed: false,
      frameCount: 600,
      route: clone(route),
      frames: clone(frames),
      trace: clone(trace),
      alignment: { camera: true, selection: true, draw: true, command: true },
    },
    counterfactual: {
      timed: false,
      frameIndex: 300,
      enableEclipse: true,
      enableEclipseGlobeShadow: true,
      gate: 2,
      selectedKeys: [...frames[300].selectedKeys],
      ownRealMeshKeys: [...frames[300].selectedKeys],
    },
    gpu:
      scheduleLeg.renderer === "webgl"
        ? {
            applicability: "N/A",
            reason: "WebGL has no WebGPU timestamp-query lane",
            attemptedFrameCount: 0,
            samples: [],
          }
        : {
            applicability: "mandatory",
            timestampFeatureAvailable: true,
            armed: true,
            fullFrameOnly: true,
            wrapper: {
              installed: true,
              restored: true,
              originalIdentityRestored: true,
            },
            samples: gpuSamples,
            summary: summarizeC1229S5DenseSamples(gpuSamples),
            drain: {
              drained: 3,
              undrained: 0,
              abandoned: 0,
              timedOut: false,
            },
            results: {
              enabled: true,
              attemptedFrameCount: 600,
              frameCount: 600,
              readbackSkipCount: 0,
              failedReadbackCount: 0,
              lostSampleCount: 0,
              pendingReadbackCount: 0,
              unaccountedSampleCount: 0,
              invertedSampleCount: 0,
              droppedPassCount: 0,
              emptyFrameCount: 0,
              sampleLedgerBalanced: true,
            },
          },
    cleanup: {
      viewerDestroyed: true,
      timestampWrapperRestored: true,
      timestampProfilingRestored: true,
      longTaskObserverDisconnected: true,
      conditionRestored: true,
    },
  };
}

const hashJson = (value) =>
  createHash("sha256").update(stableC1229S5DenseJson(value)).digest("hex");
const identityForPath = (path, hash = hashJson(path)) => ({
  path,
  byteLength: Buffer.byteLength(path) + 1,
  sha256: hash,
});

function validProvenanceSnapshot({
  localFilePaths = C12_29_S5_DENSE_LOCAL_FILES,
  servedFilePaths = C12_29_S5_DENSE_SERVED_FILES,
  buildSourceFiles = C12_29_S5_DENSE_BUILD_SOURCE_FILES,
} = {}) {
  const localFiles = localFilePaths.map((path) =>
    path === "Tools/visual-regression/performance-workloads-s5-dense-cost.json"
      ? {
          path,
          byteLength: C12_29_S5_DENSE_CONFIG.workloadByteLength,
          sha256: C12_29_S5_DENSE_CONFIG.workloadSha256,
        }
      : identityForPath(path),
  );
  const localByPath = new Map(
    localFiles.map((identity) => [identity.path, identity]),
  );
  const servedFiles = servedFilePaths.map((path) => ({
    ...localByPath.get(path),
    url: `http://localhost:8080/${path}`,
    ok: true,
    status: 200,
    contentType: "application/octet-stream",
  }));
  const buildSourceIdentity = {
    ok: true,
    reasons: [],
    sourceMapPath: "Build/CesiumUnminified/index.js.map",
    sourceMapByteLength: localByPath.get("Build/CesiumUnminified/index.js.map")
      .byteLength,
    sourceMapSha256: localByPath.get("Build/CesiumUnminified/index.js.map")
      .sha256,
    entries: buildSourceFiles.map((file) => ({
      file,
      sourceMapEntry: `../../${file}`,
      currentByteLength: Buffer.byteLength(file) + 1,
      embeddedByteLength: Buffer.byteLength(file) + 1,
      currentSha256: hashJson(file),
      embeddedSha256: hashJson(file),
      exact: true,
      reason: null,
    })),
  };
  const rawGenerated = C12_29_S5_DENSE_RAW_GENERATED_PAIRS.map(
    ({ raw, generated }) => ({
      raw,
      generated,
      rawIdentity: identityForPath(raw),
      generatedIdentity: identityForPath(generated),
      exact: true,
    }),
  );
  const identity = {
    gitHead: "1".repeat(40),
    localFiles,
    servedFiles,
    buildSourceIdentity,
    rawGenerated,
  };
  return {
    capturedAt: "2026-08-13T12:00:00.000Z",
    ...identity,
    identitySha256: hashJson(identity),
    ok: true,
    reasons: [],
  };
}

function resignSnapshot(snapshot) {
  snapshot.identitySha256 = hashJson({
    gitHead: snapshot.gitHead,
    localFiles: snapshot.localFiles,
    servedFiles: snapshot.servedFiles,
    buildSourceIdentity: snapshot.buildSourceIdentity,
    rawGenerated: snapshot.rawGenerated,
  });
}

function validReport() {
  const prerequisites = validPrerequisites();
  const prerequisitesSha256 = hashJson(prerequisites);
  const provenanceStart = validProvenanceSnapshot();
  const report = {
    schema: C12_29_S5_DENSE_SCHEMA,
    schemaVersion: 3,
    runId: RUN_ID,
    status: "PASS",
    incomplete: false,
    pass: true,
    exitCode: 0,
    startedAt: "2026-08-13T12:00:00.000Z",
    completedAt: "2026-08-13T16:00:00.000Z",
    workload: {
      path: "Tools/visual-regression/performance-workloads-s5-dense-cost.json",
      byteLength: C12_29_S5_DENSE_CONFIG.workloadByteLength,
      sha256: WORKLOAD_SHA,
      value: clone(workload),
    },
    prerequisites,
    prerequisitesSha256,
    provenance: {
      stable: true,
      start: provenanceStart,
      end: clone(provenanceStart),
    },
    legs: C12_29_S5_DENSE_SCHEDULE.map((leg) =>
      validLeg(leg, provenanceStart.identitySha256, prerequisitesSha256),
    ),
    assessment: null,
    lifecycle: {
      lockCreatedExclusively: true,
      runningReceiptCreatedExclusively: true,
      runningLatestPublishedBeforeLaunch: true,
      immutableRunCreatedExclusively: true,
      firstRedPreserved: false,
      firstRedFingerprintPolicy: "write-once-exact-sha256-byte-length",
      finalReceiptCreatedExclusively: true,
      latestEqualsImmutableRunBeforeUnlock: true,
      predecessorAuthorityBoundToRunningReceipt: true,
      publicationAuthorityReverifiedThroughUnlock: true,
      runningReceiptReverifiedThroughUnlock: true,
      lockReleasedByOwnedReceipt: true,
      publicationOrder: [
        "lock",
        "running-receipt",
        "running-latest",
        "immutable-run",
        "first-red",
        "final-latest",
        "final-receipt",
        "unlock",
      ],
    },
  };
  const servedEntry = provenanceStart.servedFiles.find(
    (identity) => identity.path === "Build/CesiumUnminified/index.js",
  );
  for (const leg of report.legs) {
    leg.servedEntry = {
      ok: true,
      status: 200,
      byteLength: servedEntry.byteLength,
      sha256: servedEntry.sha256,
    };
  }
  report.assessment = foldC1229S5DenseCostGate(report);
  return report;
}

function validHistoricalReport({
  schema,
  schemaVersion,
  runId,
  terrainSchema,
  nasaSchema,
  fold,
}) {
  const report = validReport();
  report.schema = schema;
  report.schemaVersion = schemaVersion;
  report.runId = runId;
  delete report.lifecycle.predecessorAuthorityBoundToRunningReceipt;
  delete report.lifecycle.publicationAuthorityReverifiedThroughUnlock;
  delete report.lifecycle.runningReceiptReverifiedThroughUnlock;
  report.prerequisites.terrain.artifact.schema = terrainSchema;
  report.prerequisites.nasa.artifact.schema = nasaSchema;
  report.prerequisitesSha256 = hashJson(report.prerequisites);
  const provenance = validProvenanceSnapshot({
    localFilePaths: C12_29_S5_DENSE_SUPERSEDED_LOCAL_FILES,
    buildSourceFiles: C12_29_S5_DENSE_SUPERSEDED_BUILD_SOURCE_FILES,
  });
  report.provenance = {
    stable: true,
    start: provenance,
    end: clone(provenance),
  };
  for (const leg of report.legs) {
    leg.runId = runId;
    leg.sourceIdentitySha256 = provenance.identitySha256;
    leg.prerequisitesSha256 = report.prerequisitesSha256;
  }
  report.assessment = fold(report);
  return report;
}

function validSupersededReport(runId = RUN_ID) {
  return validHistoricalReport({
    schema: C12_29_S5_DENSE_SUPERSEDED_SCHEMA,
    schemaVersion: 2,
    runId,
    terrainSchema: "c12-29-s5-terrain-selection-evidence-v10",
    nasaSchema: "c12-29-s5-svs-5073-footprint-evidence-v3",
    fold: foldC1229S5DenseSupersededCostGate,
  });
}

function validLegacyReport(runId = RUN_ID) {
  return validHistoricalReport({
    schema: C12_29_S5_DENSE_LEGACY_SCHEMA,
    schemaVersion: 1,
    runId,
    terrainSchema: "c12-29-s5-terrain-selection-evidence-v8",
    nasaSchema: "c12-29-s5-svs-5073-footprint-evidence-v2",
    fold: foldC1229S5DenseLegacyCostGate,
  });
}

function validReportForRun(runId, mutation) {
  const report = validReport();
  report.runId = runId;
  for (const leg of report.legs) leg.runId = runId;
  mutation?.(report);
  let assessment = foldC1229S5DenseCostGate(report);
  report.status = assessment.status;
  report.exitCode = assessment.exitCode;
  report.pass = assessment.pass;
  report.lifecycle.firstRedPreserved = report.status !== "PASS";
  assessment = foldC1229S5DenseCostGate(report);
  report.status = assessment.status;
  report.exitCode = assessment.exitCode;
  report.pass = assessment.pass;
  report.assessment = assessment;
  assert.equal(validateC1229S5DenseFinalArtifact(report).valid, true);
  return report;
}

test("01 frozen workload closes the full valid 24-process gate", () => {
  assert.deepEqual(validateC1229S5DenseWorkload(workload), {
    valid: true,
    reasons: [],
  });
  const report = validReport();
  assert.equal(
    report.assessment.status,
    "PASS",
    JSON.stringify(report.assessment.structural),
  );
  assert.equal(
    report.assessment.characterization.passIndependentOfCostSignOrMagnitude,
    true,
  );
  assert.deepEqual(validateC1229S5DenseFinalArtifact(report).reasons, []);
});

test("02 status precedence and exit codes are STRUCTURAL over ERROR over FAIL over PASS", () => {
  assert.deepEqual(
    ["PASS", "FAIL", "ERROR", "STRUCTURAL"].map(exitCodeForC1229S5DenseStatus),
    [0, 1, 2, 3],
  );
  const fail = validReport();
  fail.legs[0].measurement.frames[0].gate = 0;
  assert.equal(foldC1229S5DenseCostGate(fail).status, "FAIL");
  fail.legs[0].transport.pageErrors.push("boom");
  assert.equal(foldC1229S5DenseCostGate(fail).status, "ERROR");
  fail.legs.pop();
  assert.equal(foldC1229S5DenseCostGate(fail).status, "STRUCTURAL");
});

test("03 schema, UUID-v4, final status, and recomputation fail closed", () => {
  assert.equal(isC1229S5DenseUuidV4(RUN_ID), true);
  assert.equal(
    isC1229S5DenseUuidV4("11111111-2222-3333-8444-555555555555"),
    false,
  );
  for (const mutation of [
    (r) => (r.schema = "v2"),
    (r) => (r.schemaVersion = 1),
    (r) => (r.runId = "not-a-uuid"),
    (r) => (r.incomplete = true),
    (r) => (r.exitCode = 1),
    (r) => delete r.startedAt,
    (r) => (r.completedAt = "2026-08-13 16:00:00Z"),
    (r) => (r.completedAt = r.startedAt),
    (r) => (r.completedAt = "2026-08-13T11:59:59.999Z"),
    (r) => (r.assessment.characterization.policy = "ceiling"),
    (r) => (r.lifecycle.finalReceiptCreatedExclusively = false),
    (r) => (r.lifecycle.predecessorAuthorityBoundToRunningReceipt = false),
    (r) => (r.lifecycle.publicationAuthorityReverifiedThroughUnlock = false),
    (r) => (r.lifecycle.runningReceiptReverifiedThroughUnlock = false),
    (r) => (r.lifecycle.firstRedFingerprintPolicy = "existence-only"),
    (r) => r.lifecycle.publicationOrder.reverse(),
  ]) {
    const report = validReport();
    mutation(report);
    assert.equal(validateC1229S5DenseFinalArtifact(report).valid, false);
  }
});

test("04 exact 24-leg counterbalance has 3/3 condition order and backend-first balance", () => {
  assert.equal(C12_29_S5_DENSE_SCHEDULE.length, 24);
  for (const renderer of C12_29_S5_DENSE_RENDERERS) {
    let activeFirst = 0;
    let inactiveFirst = 0;
    for (let repetition = 1; repetition <= 6; repetition++) {
      const pair = C12_29_S5_DENSE_SCHEDULE.filter(
        (leg) => leg.repetition === repetition && leg.renderer === renderer,
      );
      if (pair[0].condition === "active") activeFirst++;
      else inactiveFirst++;
    }
    assert.deepEqual([activeFirst, inactiveFirst], [3, 3]);
  }
  const backendFirst = Array.from(
    { length: 6 },
    (_, index) => C12_29_S5_DENSE_SCHEDULE[index * 4].renderer,
  );
  assert.deepEqual(
    backendFirst.reduce(
      (a, value) => ({ ...a, [value]: (a[value] ?? 0) + 1 }),
      {},
    ),
    { webgl: 3, webgpu: 3 },
  );
});

test("05 route is 600 unique states over eight covered 25-45km segments", () => {
  const samples = Array.from({ length: 600 }, (_, index) =>
    sampleC1229S5DenseRoute(workload.route, index, 600),
  );
  assert.equal(samples[0].progress, 0);
  assert.equal(samples.at(-1).progress, 1);
  assert.deepEqual(
    [samples[0].longitude, samples[0].latitude],
    [samples.at(-1).longitude, samples.at(-1).latitude],
  );
  assert.notEqual(samples[0].height, samples.at(-1).height);
  assert.equal(
    new Set(samples.map((value) => stableC1229S5DenseJson(value))).size,
    600,
  );
  const counts = Array(8).fill(0);
  for (const sample of samples) {
    counts[sample.segmentIndex]++;
    assert.ok(sample.height >= 25_000 && sample.height <= 45_000);
  }
  assert.ok(counts.every((count) => count >= 30));
});

test("06 route-bounds transcript derives an exact 8x8 L12 sentinel and mixed mask hash", () => {
  const sentinel = deriveC1229S5DenseSentinel(workload.route, 12);
  assert.deepEqual(sentinel.routeTileBounds, {
    minimumX: 1724,
    maximumX: 1729,
    minimumY: 1469,
    maximumY: 1475,
  });
  assert.deepEqual(sentinel.padding, { west: 1, east: 1, north: 0, south: 1 });
  assert.equal(sentinel.keys.length, 64);
  assert.equal(new Set(sentinel.keys).size, 64);
  assert.equal(sentinel.keys[0], "12/1723/1469");
  assert.equal(sentinel.keys.at(-1), "12/1730/1476");
  const mask = createC1229S5DenseWaterMask();
  assert.deepEqual(new Set(mask), new Set([0, 255]));
  assert.equal(
    createHash("sha256").update(mask).digest("hex"),
    C12_29_S5_DENSE_CONFIG.waterMaskSha256,
  );
});

test("07 prerequisites require two exact archived immutable PASS identities", () => {
  assert.deepEqual(validateC1229S5DensePrerequisites(validPrerequisites()), {
    valid: true,
    reasons: [],
  });
  for (const mutation of [
    (p) => (p.terrain.artifact.schema = "v6"),
    (p) => (p.terrain.artifact.status = "ERROR"),
    (p) => (p.nasa.publication.certificationEligible = false),
    (p) => (p.nasa.artifact.sha256 = "placeholder"),
    (p) => (p.nasa.artifact.runId = p.terrain.artifact.runId),
  ]) {
    const value = validPrerequisites();
    mutation(value);
    assert.equal(validateC1229S5DensePrerequisites(value).valid, false);
  }
});

test("08 source, build, served, workload, and prerequisite closure cannot drift", () => {
  for (const mutation of [
    (r) => (r.provenance.stable = false),
    (r) => (r.provenance.end.gitHead = "2".repeat(40)),
    (r) => (r.provenance.end.localFiles[0].sha256 = "3".repeat(64)),
    (r) => (r.provenance.end.servedFiles[0].byteLength = 2),
    (r) => (r.legs[0].sourceIdentitySha256 = "f".repeat(64)),
    (r) => (r.legs[1].prerequisitesSha256 = "f".repeat(64)),
    (r) => (r.legs[2].workloadIdentity.sha256 = "f".repeat(64)),
  ]) {
    const report = validReport();
    mutation(report);
    assert.equal(foldC1229S5DenseCostGate(report).status, "STRUCTURAL");
  }
});

test("09 every leg is a fresh exact Edge/backend/viewport identity", () => {
  for (const mutation of [
    (l) => (l.browser.channel = "chromium"),
    (l) => (l.browser.viewport.width = 1279),
    (l) =>
      (l.renderer.actual = l.renderer.actual === "webgl" ? "webgpu" : "webgl"),
    (l) => (l.renderer.gpuIdentityComplete = false),
    (l) => (l.scheduleLeg.ordinal = 24),
  ]) {
    const leg = validLeg(C12_29_S5_DENSE_SCHEDULE[0]);
    mutation(leg);
    assert.equal(validateC1229S5DenseRuntimeLeg(leg, workload).valid, false);
  }
  for (const [scheduleLeg, mutation] of [
    [C12_29_S5_DENSE_SCHEDULE[0], (leg) => (leg.renderer.rendererString = "")],
    [C12_29_S5_DENSE_SCHEDULE[2], (leg) => (leg.renderer.adapterInfo = null)],
    [
      C12_29_S5_DENSE_SCHEDULE[2],
      (leg) => {
        for (const key of Object.keys(leg.renderer.adapterInfo)) {
          leg.renderer.adapterInfo[key] = "";
        }
      },
    ],
    [
      C12_29_S5_DENSE_SCHEDULE[2],
      (leg) => delete leg.renderer.adapterInfo.device,
    ],
  ]) {
    const leg = validLeg(scheduleLeg);
    mutation(leg);
    leg.renderer.gpuIdentityComplete = true;
    assert.equal(validateC1229S5DenseRuntimeLeg(leg, workload).valid, false);
  }
  const symmetricIdentityReport = validReport();
  for (const leg of symmetricIdentityReport.legs) {
    if (leg.scheduleLeg.renderer === "webgl") {
      leg.renderer.rendererString = "";
    } else {
      leg.renderer.adapterInfo = null;
    }
    leg.renderer.gpuIdentityComplete = true;
  }
  assert.equal(
    foldC1229S5DenseCostGate(symmetricIdentityReport).status,
    "STRUCTURAL",
  );
  const report = validReport();
  const pair = report.legs.filter(
    (leg) =>
      leg.scheduleLeg.repetition === 1 && leg.scheduleLeg.renderer === "webgl",
  );
  pair[1].browser.version = "141.0.0.0";
  assert.equal(foldC1229S5DenseCostGate(report).status, "STRUCTURAL");
  const cameraReport = validReport();
  const cameraPair = cameraReport.legs.filter(
    (leg) =>
      leg.scheduleLeg.repetition === 1 && leg.scheduleLeg.renderer === "webgl",
  );
  cameraPair[1].measurement.route[4].actual.longitude += 1e-10;
  cameraPair[1].replay.route[4].actual.longitude += 1e-10;
  assert.equal(
    validateC1229S5DenseRuntimeLeg(cameraPair[1], workload).valid,
    true,
  );
  assert.equal(foldC1229S5DenseCostGate(cameraReport).status, "STRUCTURAL");
  const processReport = validReport();
  processReport.legs[1].subprocess.launchId =
    processReport.legs[0].subprocess.launchId;
  assert.equal(foldC1229S5DenseCostGate(processReport).status, "STRUCTURAL");
  const timeoutReport = validReport();
  timeoutReport.legs[0].subprocess.timedOut = true;
  assert.equal(foldC1229S5DenseCostGate(timeoutReport).status, "STRUCTURAL");
});

test("10 offline transport, page, console, failed-request, and dialog surfaces are clean", () => {
  for (const field of [
    "externalRequests",
    "failedRequests",
    "pageErrors",
    "consoleErrors",
    "dialogs",
  ]) {
    const report = validReport();
    report.legs[0].transport[field].push("unexpected");
    assert.equal(foldC1229S5DenseCostGate(report).status, "ERROR");
  }
});

test("11 clock, globe lighting, SSE, cache, and the two toggles are exact", () => {
  for (const mutation of [
    (l) => (l.configuration.fixedClock = "2024-04-08T18:17:15Z"),
    (l) => (l.configuration.shouldAnimate = true),
    (l) => (l.configuration.maximumScreenSpaceError = 0.2),
    (l) => (l.configuration.tileCacheSize = 4096),
    (l) => (l.configuration.globeLighting = false),
    (l) => (l.configuration.defaultFeatureSnapshot.skyBoxShown = false),
    (l) => (l.configuration.enableEclipse = false),
    (l) => (l.configuration.enableEclipseGlobeShadow = false),
  ]) {
    const leg = validLeg(C12_29_S5_DENSE_SCHEDULE[0]);
    mutation(leg);
    assert.ok(
      validateC1229S5DenseRuntimeLeg(leg, workload).structural.length > 0,
    );
  }
});

test("12 both variants prewarm and the full own-real sentinel primes before timing", () => {
  for (const mutation of [
    (l) => l.prime.variants.pop(),
    (l) => (l.prime.variants[0].frameCount = 599),
    (l) => l.prime.seenOwnRealSentinelKeys.pop(),
    (l) =>
      (l.prime.seenOwnRealSentinelKeys = [
        ...l.prime.seenOwnRealSentinelKeys,
      ].sort()),
    (l) => (l.prime.settledFrames = 29),
    (l) => delete l.prime.settledFrames,
    (l) => (l.prime.settledFrames = "30"),
    (l) => (l.prime.settledFrames = 30.5),
  ]) {
    const leg = validLeg(C12_29_S5_DENSE_SCHEDULE[0]);
    mutation(leg);
    assert.ok(
      validateC1229S5DenseRuntimeLeg(leg, workload).structural.length > 0,
    );
  }
});

test("13 timed route evidence cannot truncate, repeat, skip a segment, or drift camera", () => {
  for (const mutation of [
    (l) => l.measurement.route.pop(),
    (l) => (l.measurement.route[10].frameIndex = 9),
    (l) => (l.measurement.route[10].progress = 0),
    (l) => (l.measurement.route[10].actual.height += 1),
  ]) {
    const leg = validLeg(C12_29_S5_DENSE_SCHEDULE[0]);
    mutation(leg);
    assert.ok(
      validateC1229S5DenseRuntimeLeg(leg, workload).structural.length > 0,
    );
  }
});

test("14 measured terrain has zero activity, zero fill, and only owned real meshes", () => {
  const cases = [
    (l) => (l.measurement.terrainActivity.delta.requestCount = 1),
    (l) => l.measurement.terrainActivity.end.requestCount++,
    (l) => l.measurement.terrainActivity.end.requestedKeys.push("12/1730/1476"),
    (l) => l.measurement.frames[0].fillMeshKeys.push("12/1/1"),
    (l) => l.measurement.frames[0].foreignTerrainKeys.push("12/1/1"),
    (l) => l.measurement.frames[0].ownRealMeshKeys.pop(),
  ];
  for (const mutation of cases) {
    const leg = validLeg(C12_29_S5_DENSE_SCHEDULE[0]);
    mutation(leg);
    assert.equal(validateC1229S5DenseRuntimeLeg(leg, workload).valid, false);
  }
});

test("15 ACTIVE is gate 1/2 and INACTIVE is exact gate zero", () => {
  const active = validLeg(C12_29_S5_DENSE_SCHEDULE[0]);
  active.measurement.frames[0].gate = 0;
  assert.ok(
    validateC1229S5DenseRuntimeLeg(active, workload).behavioral.length > 0,
  );
  const inactiveSchedule = C12_29_S5_DENSE_SCHEDULE[1];
  const inactive = validLeg(inactiveSchedule);
  inactive.measurement.frames[0].gate = 1;
  assert.ok(
    validateC1229S5DenseRuntimeLeg(inactive, workload).behavioral.length > 0,
  );
});

test("16 INACTIVE still proves an untimed exact-selection ACTIVE counterfactual", () => {
  for (const mutation of [
    (l) => (l.counterfactual.timed = true),
    (l) => (l.counterfactual.frameIndex = 301),
    (l) => (l.counterfactual.gate = 0),
    (l) => (l.counterfactual.enableEclipseGlobeShadow = false),
    (l) => l.counterfactual.ownRealMeshKeys.pop(),
  ]) {
    const leg = validLeg(C12_29_S5_DENSE_SCHEDULE[1]);
    mutation(leg);
    assert.ok(
      validateC1229S5DenseRuntimeLeg(leg, workload).behavioral.length > 0,
    );
  }
});

test("17 untimed replay must align camera, selection, draw, and command exactly", () => {
  for (const mutation of [
    (l) => (l.replay.alignment.selection = false),
    (l) => (l.replay.route[4].actual.longitude += 1e-10),
    (l) => l.replay.frames[1].selectedKeys.pop(),
    (l) => l.replay.trace.samples[2].drawCount++,
    (l) => l.replay.frames[3].commandCount++,
  ]) {
    const leg = validLeg(C12_29_S5_DENSE_SCHEDULE[0]);
    mutation(leg);
    assert.ok(
      validateC1229S5DenseRuntimeLeg(leg, workload).structural.length > 0,
    );
  }
});

test("18 CPU validity is exactly 600 raw samples with recomputed quantiles", () => {
  for (const mutation of [
    (l) => l.measurement.trace.samples.pop(),
    (l) => (l.measurement.trace.samples[0].cpuMs = -1),
    (l) => (l.measurement.cpuSummary.p95 += 1),
    (l) => l.measurement.trace.samples[1].commandCount++,
    (l) => (l.measurement.trace.samples[1].frameNumber = 1),
    (l) => (l.measurement.trace.samples[1].snapshotFrozen = true),
    (l) => (l.measurement.frameCount = 599),
  ]) {
    const leg = validLeg(C12_29_S5_DENSE_SCHEDULE[0]);
    mutation(leg);
    assert.ok(
      validateC1229S5DenseRuntimeLeg(leg, workload).structural.length > 0,
    );
  }
});

test("19 long-task share is exact and cannot exceed 25 percent", () => {
  const leg = validLeg(C12_29_S5_DENSE_SCHEDULE[0]);
  leg.measurement.longTasks.totalDurationMs = 251;
  leg.measurement.longTasks.measurementDurationMs = 1000;
  leg.measurement.longTasks.share = 0.251;
  assert.ok(
    validateC1229S5DenseRuntimeLeg(leg, workload).structural.length > 0,
  );
  const inconsistent = validLeg(C12_29_S5_DENSE_SCHEDULE[0]);
  inconsistent.measurement.longTasks.share = 0.2;
  assert.ok(
    validateC1229S5DenseRuntimeLeg(inconsistent, workload).structural.length >
      0,
  );
});

test("20 six-rep per-condition CPU p95 spread cannot exceed 2x", () => {
  const report = validReport();
  const target = report.legs.find(
    (leg) =>
      leg.scheduleLeg.renderer === "webgl" &&
      leg.scheduleLeg.condition === "active",
  );
  for (const sample of target.measurement.trace.samples) sample.cpuMs = 10;
  target.measurement.cpuSummary = summarizeC1229S5DenseSamples(
    target.measurement.trace.samples.map((sample) => sample.cpuMs),
  );
  assert.equal(foldC1229S5DenseCostGate(report).status, "STRUCTURAL");
});

test("21 WebGPU timestamps require 600 attempts, >=540 samples, <=10% skips, and a drained zero-error ledger", () => {
  const index = C12_29_S5_DENSE_SCHEDULE.findIndex(
    (leg) => leg.renderer === "webgpu",
  );
  for (const mutation of [
    (l) => (l.gpu.timestampFeatureAvailable = false),
    (l) => (l.gpu.results.attemptedFrameCount = 599),
    (l) => {
      l.gpu.samples.length = 539;
      l.gpu.results.frameCount = 539;
      l.gpu.summary = summarizeC1229S5DenseSamples(l.gpu.samples);
    },
    (l) => (l.gpu.results.readbackSkipCount = 61),
    (l) => (l.gpu.results.failedReadbackCount = 1),
    (l) => (l.gpu.results.lostSampleCount = 1),
    (l) => (l.gpu.results.pendingReadbackCount = 1),
    (l) => (l.gpu.results.unaccountedSampleCount = 1),
    (l) => (l.gpu.results.invertedSampleCount = 1),
    (l) => (l.gpu.results.droppedPassCount = 1),
    (l) => (l.gpu.results.emptyFrameCount = 1),
    (l) => (l.gpu.drain.undrained = 1),
    (l) => (l.gpu.wrapper.restored = false),
  ]) {
    const leg = validLeg(C12_29_S5_DENSE_SCHEDULE[index]);
    mutation(leg);
    assert.ok(
      validateC1229S5DenseRuntimeLeg(leg, workload).structural.length > 0,
    );
  }
});

test("22 WebGL GPU timing is exact N/A and cannot masquerade as sampled", () => {
  for (const mutation of [
    (l) => (l.gpu.applicability = "optional"),
    (l) => (l.gpu.attemptedFrameCount = 600),
    (l) => l.gpu.samples.push(1),
    (l) => (l.gpu.reason = "unsupported"),
  ]) {
    const leg = validLeg(C12_29_S5_DENSE_SCHEDULE[0]);
    mutation(leg);
    assert.ok(
      validateC1229S5DenseRuntimeLeg(leg, workload).structural.length > 0,
    );
  }
});

test("23 cost sign and magnitude never change PASS; raw paired deltas, ratios, median, range, and MAD remain", () => {
  for (const [activeCpu, inactiveCpu, activeGpu, inactiveGpu] of [
    [100, 1, 200, 2],
    [1, 100, 2, 200],
    [5, 5, 7, 7],
  ]) {
    const report = validReport();
    for (const leg of report.legs) {
      const cpu =
        leg.scheduleLeg.condition === "active" ? activeCpu : inactiveCpu;
      for (const sample of leg.measurement.trace.samples) sample.cpuMs = cpu;
      for (const sample of leg.replay.trace.samples) sample.cpuMs = cpu;
      leg.measurement.cpuSummary = summarizeC1229S5DenseSamples(
        leg.measurement.trace.samples.map((sample) => sample.cpuMs),
      );
      if (leg.scheduleLeg.renderer === "webgpu") {
        const gpu =
          leg.scheduleLeg.condition === "active" ? activeGpu : inactiveGpu;
        leg.gpu.samples.fill(gpu);
        leg.gpu.summary = summarizeC1229S5DenseSamples(leg.gpu.samples);
      }
    }
    const folded = foldC1229S5DenseCostGate(report);
    assert.equal(folded.status, "PASS");
    assert.equal(folded.characterization.pairRecords.length, 12);
    assert.ok("deltaMad" in folded.characterization.byRenderer.webgpu.gpuP95);
    assert.ok("deltaRange" in folded.characterization.byRenderer.webgl.cpuP95);
    assert.ok("ratioMad" in folded.characterization.byRenderer.webgpu.gpuP95);
    assert.ok("ratioRange" in folded.characterization.byRenderer.webgl.cpuP95);
  }
});

test("24 static packet pins new namespace, source closure, wrapper finally, fresh processes, and no ceiling", async () => {
  assert.equal(
    C12_29_S5_SVS_SCHEMA,
    "c12-29-s5-svs-5073-footprint-evidence-v4",
  );
  assert.deepEqual(
    C12_29_S5_DENSE_NASA_V4_SOURCE_FILES,
    C12_29_S5_SVS_SOURCE_FILES,
  );
  assert.ok(
    C12_29_S5_DENSE_LOCAL_FILES.includes("Build/CesiumUnminified/index.js.map"),
  );
  assert.ok(
    C12_29_S5_DENSE_SERVED_FILES.includes("Build/CesiumUnminified/index.js"),
  );
  assert.equal(
    new Set(C12_29_S5_DENSE_LOCAL_FILES).size,
    C12_29_S5_DENSE_LOCAL_FILES.length,
  );
  assert.equal(
    new Set(C12_29_S5_DENSE_SERVED_FILES).size,
    C12_29_S5_DENSE_SERVED_FILES.length,
  );
  assert.equal(C12_29_S5_DENSE_NASA_V4_SOURCE_FILES.length, 56);
  assert.equal(C12_29_S5_DENSE_SOURCE_FILES.length, 65);
  assert.equal(C12_29_S5_DENSE_BUILD_SOURCE_FILES.length, 63);
  assert.equal(C12_29_S5_DENSE_SUPERSEDED_SOURCE_FILES.length, 46);
  assert.equal(C12_29_S5_DENSE_SUPERSEDED_BUILD_SOURCE_FILES.length, 44);
  assert.ok(
    C12_29_S5_DENSE_RAW_GENERATED_PAIRS.every(
      ({ raw, generated }) =>
        C12_29_S5_DENSE_SOURCE_FILES.includes(raw) &&
        C12_29_S5_DENSE_SOURCE_FILES.includes(generated),
    ),
  );
  const helper = await readSource("lib", "c12-29-s5-dense-cost-gate.mjs");
  const manifest = await readSource("performance-workloads-s5-dense-cost.json");
  assert.match(helper, /threshold-free-characterization/);
  assert.doesNotMatch(helper, /maximum(?:Allowed)?(?:Cpu|Gpu|Cost)/i);
  assert.match(manifest, /freshProcessPerLeg/);
  assert.match(manifest, /regardless of sign or magnitude/);
  const probePath = resolve(directory, "probe-c12-29-s5-dense-cost.mjs");
  let probe = "";
  try {
    probe = (await readFile(probePath, "utf8")).replaceAll("\r\n", "\n");
  } catch {}
  if (probe.length > 0) {
    assert.match(probe, /chromium\.launch/);
    assert.match(probe, /channel:\s*"msedge"/);
    assert.match(probe, /finally/);
    assert.match(probe, /drainPendingReadbacks/);
    assert.match(probe, /createImmutableEvidence/);
    assert.match(probe, /first-red/);
    assert.doesNotMatch(probe, /npm run build|gulp build|execSync\([^)]*build/);
  }

  const publication = await import("./probe-c12-29-s5-dense-cost.mjs");
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "c12-29-s5-dense-lifecycle-"),
  );
  const operationProxy = (overrides) =>
    new Proxy(fs, {
      get(target, property) {
        return overrides[property] ?? Reflect.get(target, property);
      },
    });
  try {
    const foreignRunId = "99999999-8888-4777-8666-555555555555";
    const foreignPaths = publication.createC1229S5DenseArtifactPaths(
      join(temporaryRoot, "foreign-lock"),
      foreignRunId,
    );
    const foreignStart = publication.beginC1229S5DenseRun(
      foreignPaths,
      foreignRunId,
    );
    const foreignLock = Buffer.from("foreign authority\n");
    await writeFile(foreignPaths.lock, foreignLock);
    assert.throws(
      () =>
        publication.publishC1229S5DenseFinal(
          foreignPaths,
          foreignStart.publicationAuthority,
          { runId: foreignRunId, status: "ERROR" },
        ),
      /lock.*(ownership|authority).*differ/u,
    );
    assert.deepEqual(await readFile(foreignPaths.lock), foreignLock);
    await assert.rejects(readFile(foreignPaths.immutable), /ENOENT/);

    const foreignLatestRunId = "88888888-7777-4666-8555-444444444444";
    const foreignLatestPaths = publication.createC1229S5DenseArtifactPaths(
      join(temporaryRoot, "foreign-latest"),
      foreignLatestRunId,
    );
    const foreignLatestStart = publication.beginC1229S5DenseRun(
      foreignLatestPaths,
      foreignLatestRunId,
    );
    const foreignLatest = Buffer.from("foreign latest authority\n");
    await writeFile(foreignLatestPaths.latest, foreignLatest);
    assert.throws(
      () =>
        publication.publishC1229S5DenseFinal(
          foreignLatestPaths,
          foreignLatestStart.publicationAuthority,
          { runId: foreignLatestRunId, status: "ERROR" },
        ),
      /RUNNING latest authority.*bytes differ|owned RUNNING marker/,
    );
    assert.deepEqual(await readFile(foreignLatestPaths.latest), foreignLatest);
    await assert.rejects(readFile(foreignLatestPaths.immutable), /ENOENT/);

    const latePairRunId = "12121212-3434-4567-89ab-cdefabcdefab";
    const latePairPaths = publication.createC1229S5DenseArtifactPaths(
      join(temporaryRoot, "late-pair"),
      latePairRunId,
    );
    const latePairStart = publication.beginC1229S5DenseRun(
      latePairPaths,
      latePairRunId,
    );
    const lateForeignLock = Buffer.from("late foreign lock authority\n");
    const lateForeignLatest = Buffer.from("late foreign latest authority\n");
    let latePairInjected = false;
    const latePairOperations = operationProxy({
      renameSync(from, to) {
        fs.renameSync(from, to);
        if (
          !latePairInjected &&
          from === latePairPaths.latest &&
          String(to).includes(".final-")
        ) {
          latePairInjected = true;
          fs.writeFileSync(latePairPaths.latest, lateForeignLatest, {
            flag: "wx",
          });
          fs.writeFileSync(latePairPaths.lock, lateForeignLock);
        }
      },
    });
    assert.throws(
      () =>
        publication.publishC1229S5DenseFinal(
          latePairPaths,
          latePairStart.publicationAuthority,
          { runId: latePairRunId, status: "PASS" },
          latePairOperations,
        ),
      /persistence/,
    );
    assert.equal(latePairInjected, true);
    assert.deepEqual(await readFile(latePairPaths.lock), lateForeignLock);
    assert.deepEqual(await readFile(latePairPaths.latest), lateForeignLatest);
    assert.ok((await readFile(latePairPaths.immutable)).byteLength > 0);

    const captureRunId = "abababab-cdcd-4efe-8aba-123456789abc";
    const capturePaths = publication.createC1229S5DenseArtifactPaths(
      join(temporaryRoot, "foreign-lock-capture"),
      captureRunId,
    );
    const captureStart = publication.beginC1229S5DenseRun(
      capturePaths,
      captureRunId,
    );
    const capturedForeignLock = Buffer.from("captured foreign lock\n");
    const capturedForeignLatest = Buffer.from("captured foreign latest\n");
    let captureInjected = false;
    const captureOperations = operationProxy({
      renameSync(from, to) {
        if (
          !captureInjected &&
          from === capturePaths.lock &&
          String(to).includes(".release-")
        ) {
          captureInjected = true;
          fs.writeFileSync(capturePaths.lock, capturedForeignLock);
          fs.writeFileSync(capturePaths.latest, capturedForeignLatest);
        }
        fs.renameSync(from, to);
      },
    });
    assert.throws(
      () =>
        publication.publishC1229S5DenseFinal(
          capturePaths,
          captureStart.publicationAuthority,
          { runId: captureRunId, status: "PASS" },
          captureOperations,
        ),
      /persistence/,
    );
    assert.equal(captureInjected, true);
    assert.deepEqual(await readFile(capturePaths.lock), capturedForeignLock);
    assert.deepEqual(
      await readFile(capturePaths.latest),
      capturedForeignLatest,
    );

    const postRenameRunId = "cdcdcdcd-abab-4fef-8bab-abcdefabcdef";
    const postRenamePaths = publication.createC1229S5DenseArtifactPaths(
      join(temporaryRoot, "foreign-after-lock-claim"),
      postRenameRunId,
    );
    const postRenameStart = publication.beginC1229S5DenseRun(
      postRenamePaths,
      postRenameRunId,
    );
    const postRenameForeignLock = Buffer.from("post-rename foreign lock\n");
    const postRenameForeignLatest = Buffer.from("post-rename foreign latest\n");
    let postRenameInjected = false;
    const postRenameOperations = operationProxy({
      renameSync(from, to) {
        fs.renameSync(from, to);
        if (
          !postRenameInjected &&
          from === postRenamePaths.lock &&
          String(to).includes(".release-")
        ) {
          postRenameInjected = true;
          fs.writeFileSync(postRenamePaths.lock, postRenameForeignLock, {
            flag: "wx",
          });
          fs.writeFileSync(postRenamePaths.latest, postRenameForeignLatest);
        }
      },
    });
    const postRenameReceipt = publication.publishC1229S5DenseFinal(
      postRenamePaths,
      postRenameStart.publicationAuthority,
      { runId: postRenameRunId, status: "PASS" },
      postRenameOperations,
    );
    assert.equal(postRenameReceipt.kind, "c12-29-s5-dense-cost-final-receipt");
    assert.equal(postRenameInjected, true);
    assert.deepEqual(
      await readFile(postRenamePaths.lock),
      postRenameForeignLock,
    );
    assert.deepEqual(
      await readFile(postRenamePaths.latest),
      postRenameForeignLatest,
    );

    const recoveryRunId = "efefefef-1212-4343-8565-787878787878";
    const recoveryPaths = publication.createC1229S5DenseArtifactPaths(
      join(temporaryRoot, "post-final-recovery"),
      recoveryRunId,
    );
    const recoveryStart = publication.beginC1229S5DenseRun(
      recoveryPaths,
      recoveryRunId,
    );
    let finalReceiptFailureInjected = false;
    const finalReceiptDescriptors = new Set();
    const recoveryOperations = operationProxy({
      openSync(file, flags, mode) {
        const descriptor = fs.openSync(file, flags, mode);
        if (
          resolve(file) === resolve(recoveryPaths.finalReceipt) &&
          (flags & fs.constants.O_EXCL) !== 0
        ) {
          finalReceiptDescriptors.add(descriptor);
        }
        return descriptor;
      },
      closeSync(descriptor) {
        fs.closeSync(descriptor);
        if (
          !finalReceiptFailureInjected &&
          finalReceiptDescriptors.has(descriptor)
        ) {
          finalReceiptFailureInjected = true;
          throw new Error("injected failure after final receipt write");
        }
      },
    });
    assert.throws(
      () =>
        publication.publishC1229S5DenseFinal(
          recoveryPaths,
          recoveryStart.publicationAuthority,
          { runId: recoveryRunId, status: "PASS" },
          recoveryOperations,
        ),
      /injected failure after final receipt write/,
    );
    assert.equal(finalReceiptFailureInjected, true);
    assert.deepEqual(
      await readFile(recoveryPaths.lock),
      recoveryStart.lockBytes,
    );
    assert.deepEqual(
      await readFile(recoveryPaths.latest),
      recoveryStart.runningBytes,
    );
    assert.notDeepEqual(
      await readFile(recoveryPaths.latest),
      await readFile(recoveryPaths.immutable),
    );

    const output = join(temporaryRoot, "success");
    const firstRunId = "77777777-6666-4555-8444-333333333333";
    const firstPaths = publication.createC1229S5DenseArtifactPaths(
      output,
      firstRunId,
    );
    const firstStart = publication.beginC1229S5DenseRun(firstPaths, firstRunId);
    const firstReceipt = publication.publishC1229S5DenseFinal(
      firstPaths,
      firstStart.publicationAuthority,
      validReportForRun(firstRunId, (report) => {
        report.legs[0].transport.pageErrors.push("first");
      }),
    );
    assert.equal(firstReceipt.firstRed.writeOnceFingerprintVerified, true);
    assert.equal(firstReceipt.firstRed.written, true);
    assert.equal(firstReceipt.firstRed.beforeSha256, null);
    assert.match(firstReceipt.firstRed.afterSha256, /^[0-9a-f]{64}$/u);
    assert.equal(firstReceipt.predecessorAuthority, null);
    assert.deepEqual(
      await readFile(firstPaths.immutable),
      await readFile(firstPaths.latest),
    );
    const firstRed = await readFile(firstPaths.firstRed);
    await assert.rejects(readFile(firstPaths.lock), /ENOENT/);

    const secondRunId = "22222222-3333-4444-8555-666666666666";
    const secondPaths = publication.createC1229S5DenseArtifactPaths(
      output,
      secondRunId,
    );
    const secondStart = publication.beginC1229S5DenseRun(
      secondPaths,
      secondRunId,
    );
    const secondReceipt = publication.publishC1229S5DenseFinal(
      secondPaths,
      secondStart.publicationAuthority,
      validReportForRun(secondRunId, (report) => {
        report.legs[0].measurement.frames[0].gate = 0;
      }),
    );
    assert.equal(secondReceipt.firstRed.writeOnceFingerprintVerified, true);
    assert.equal(secondReceipt.firstRed.written, false);
    assert.equal(
      secondReceipt.firstRed.beforeSha256,
      secondReceipt.firstRed.afterSha256,
    );
    assert.equal(secondReceipt.predecessorAuthority.schemaVersion, 3);
    assert.equal(secondReceipt.predecessorAuthority.runId, firstRunId);
    assert.equal(secondReceipt.predecessorAuthority.supersessionReceipt, null);
    assert.deepEqual(await readFile(secondPaths.firstRed), firstRed);
    assert.deepEqual(
      await readFile(secondPaths.immutable),
      await readFile(secondPaths.latest),
    );
    assert.ok((await readFile(secondPaths.finalReceipt)).byteLength > 0);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("25 terrain-v10, NASA-v4, and every operational bound are exact prerequisites", () => {
  for (const [kind, staleSchema] of [
    ["terrain", "c12-29-s5-terrain-selection-evidence-v8"],
    ["terrain", "c12-29-s5-terrain-selection-evidence-v9"],
    ["nasa", "c12-29-s5-svs-5073-footprint-evidence-v1"],
    ["nasa", "c12-29-s5-svs-5073-footprint-evidence-v2"],
    ["nasa", "c12-29-s5-svs-5073-footprint-evidence-v3"],
  ]) {
    const stale = validPrerequisites();
    stale[kind].artifact.schema = staleSchema;
    assert.equal(validateC1229S5DensePrerequisites(stale).valid, false);
  }
  for (const mutation of [
    (value) => (value.protocol.refreshSemantics = "render whenever convenient"),
    (value) => (value.protocol.settleStableFrames = 0),
    (value) => (value.protocol.settleTimeoutMs = 0),
    (value) => (value.protocol.gpuReadbackTimeoutMs = 0),
    (value) => (value.protocol.legTimeoutMs = 0),
    (value) => (value.validity.wallSampleCount = 599),
  ]) {
    const value = clone(workload);
    mutation(value);
    assert.equal(validateC1229S5DenseWorkload(value).valid, false);
  }
});

test("25a campaign/leg timestamps and leg workload identities are exact and cross-bound", () => {
  for (const mutation of [
    (leg) => delete leg.startedAt,
    (leg) => (leg.completedAt = "2026-08-13 12:05:00Z"),
    (leg) => (leg.completedAt = leg.startedAt),
    (leg) => (leg.completedAt = "2026-08-13T11:59:59.999Z"),
    (leg) => delete leg.workloadIdentity.path,
    (leg) => delete leg.workloadIdentity.byteLength,
    (leg) => (leg.workloadIdentity.byteLength = "7137"),
    (leg) => (leg.workloadIdentity.byteLength = 7137.5),
    (leg) => (leg.workloadIdentity.path = "foreign-workload.json"),
  ]) {
    const leg = validLeg(C12_29_S5_DENSE_SCHEDULE[0]);
    mutation(leg);
    assert.ok(
      validateC1229S5DenseRuntimeLeg(leg, workload).structural.length > 0,
    );
  }

  for (const mutation of [
    (report) => (report.legs[0].startedAt = "2026-08-13T11:59:59.999Z"),
    (report) => (report.legs.at(-1).completedAt = "2026-08-13T16:00:00.001Z"),
    (report) =>
      (report.legs[1].startedAt = new Date(
        Date.parse(report.legs[0].completedAt) - 1,
      ).toISOString()),
  ]) {
    const report = validReport();
    mutation(report);
    assert.equal(foldC1229S5DenseCostGate(report).status, "STRUCTURAL");
  }
});

test("25b dense v3 accepts only validated archived v1/v2/v3 authority and makes both predecessor receipts race-safe", async () => {
  const publication = await import("./probe-c12-29-s5-dense-cost.mjs");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "c12-29-s5-dense-v3-"));
  const legacyRunId = "10101010-2020-4030-8040-505050505050";
  const legacy = validLegacyReport(legacyRunId);
  const legacyBytes = Buffer.from(`${JSON.stringify(legacy, null, 2)}\n`);
  const supersededRunId = "20202020-3030-4141-8252-606060606060";
  const superseded = validSupersededReport(supersededRunId);
  const supersededBytes = Buffer.from(
    `${JSON.stringify(superseded, null, 2)}\n`,
  );
  const operationProxy = (overrides) =>
    new Proxy(fs, {
      get(target, property) {
        return overrides[property] ?? Reflect.get(target, property);
      },
    });
  const injectAfterExclusiveClose = (file, inject) => {
    const exclusiveDescriptors = new Set();
    let injected = false;
    return {
      operations: operationProxy({
        openSync(candidate, flags, mode) {
          const descriptor = fs.openSync(candidate, flags, mode);
          if (
            resolve(candidate) === resolve(file) &&
            typeof flags === "number" &&
            (flags & fs.constants.O_EXCL) !== 0
          ) {
            exclusiveDescriptors.add(descriptor);
          }
          return descriptor;
        },
        closeSync(descriptor) {
          fs.closeSync(descriptor);
          if (!injected && exclusiveDescriptors.delete(descriptor)) {
            injected = true;
            inject();
          }
        },
      }),
      injected: () => injected,
    };
  };
  const seedPrior = (paths, prior, bytes, archiveBytes = bytes) => {
    fs.mkdirSync(paths.directory, { recursive: true });
    fs.writeFileSync(paths.latest, bytes);
    fs.writeFileSync(
      join(paths.directory, `${prior.runId}.json`),
      archiveBytes,
    );
  };
  const predecessorReceipt = (paths, version, runId) =>
    join(
      paths.directory,
      `campaign12-c12-29-s5-dense-cost.superseded-v${version}-${runId}.json`,
    );
  const legacyReceipt = (paths) => predecessorReceipt(paths, 1, legacyRunId);
  const supersededReceipt = (paths) =>
    predecessorReceipt(paths, 2, supersededRunId);

  assert.equal(validateC1229S5DenseFinalArtifact(legacy).valid, false);
  for (const historical of [legacy, superseded]) {
    assert.equal(
      "predecessorAuthorityBoundToRunningReceipt" in historical.lifecycle,
      false,
    );
    assert.equal(
      "publicationAuthorityReverifiedThroughUnlock" in historical.lifecycle,
      false,
    );
    assert.equal(
      "runningReceiptReverifiedThroughUnlock" in historical.lifecycle,
      false,
    );
  }
  assert.equal(validateC1229S5DenseLegacyFinalArtifact(legacy).valid, true);
  assert.equal(validateC1229S5DenseFinalArtifact(superseded).valid, false);
  assert.equal(
    validateC1229S5DenseSupersededFinalArtifact(superseded).valid,
    true,
  );
  for (const [historical, validate] of [
    [legacy, validateC1229S5DenseLegacyFinalArtifact],
    [superseded, validateC1229S5DenseSupersededFinalArtifact],
  ]) {
    for (const field of [
      "predecessorAuthorityBoundToRunningReceipt",
      "publicationAuthorityReverifiedThroughUnlock",
      "runningReceiptReverifiedThroughUnlock",
    ]) {
      const mutated = clone(historical);
      mutated.lifecycle[field] = true;
      assert.equal(validate(mutated).valid, false, field);
    }
  }
  try {
    const output = join(temporaryRoot, "exact-v1-retry");
    const runId = "60606060-7070-4080-8090-a0a0a0a0a0a0";
    const paths = publication.createC1229S5DenseArtifactPaths(output, runId);
    seedPrior(paths, legacy, legacyBytes);
    fs.writeFileSync(legacyReceipt(paths), legacyBytes);
    const started = publication.beginC1229S5DenseRun(paths, runId);
    assert.equal(started.running.schema, C12_29_S5_DENSE_SCHEMA);
    assert.equal(started.running.schemaVersion, 3);
    assert.deepEqual(await readFile(legacyReceipt(paths)), legacyBytes);
    assert.deepEqual(await readFile(paths.latest), started.runningBytes);
    assert.deepEqual(
      await readFile(join(output, `${legacyRunId}.json`)),
      legacyBytes,
    );

    const supersededOutput = join(temporaryRoot, "exact-v2-prior");
    const supersededNextRunId = "71717171-8282-4939-8a4a-b5b5b5b5b5b5";
    const supersededPaths = publication.createC1229S5DenseArtifactPaths(
      supersededOutput,
      supersededNextRunId,
    );
    seedPrior(supersededPaths, superseded, supersededBytes);
    const supersededStarted = publication.beginC1229S5DenseRun(
      supersededPaths,
      supersededNextRunId,
    );
    assert.deepEqual(
      await readFile(supersededPaths.latest),
      supersededStarted.runningBytes,
    );
    assert.deepEqual(
      await readFile(join(supersededOutput, `${superseded.runId}.json`)),
      supersededBytes,
    );
    assert.deepEqual(
      await readFile(supersededReceipt(supersededPaths)),
      supersededBytes,
    );

    const current = validReport();
    const currentBytes = Buffer.from(`${JSON.stringify(current, null, 2)}\n`);
    const currentOutput = join(temporaryRoot, "exact-v3-prior");
    const currentRunId = "72727272-8383-4a4a-8b5b-c6c6c6c6c6c6";
    const currentPaths = publication.createC1229S5DenseArtifactPaths(
      currentOutput,
      currentRunId,
    );
    seedPrior(currentPaths, current, currentBytes);
    const currentStarted = publication.beginC1229S5DenseRun(
      currentPaths,
      currentRunId,
    );
    assert.deepEqual(
      await readFile(currentPaths.latest),
      currentStarted.runningBytes,
    );
    assert.deepEqual(
      await readFile(join(currentOutput, `${current.runId}.json`)),
      currentBytes,
    );

    const lockBoundaryRunId = "25252525-3535-4949-8a0a-727272727272";
    const lockBoundaryPaths = publication.createC1229S5DenseArtifactPaths(
      join(temporaryRoot, "lock-exclusive-boundary"),
      lockBoundaryRunId,
    );
    seedPrior(lockBoundaryPaths, legacy, legacyBytes);
    const lockBoundary = injectAfterExclusiveClose(
      lockBoundaryPaths.lock,
      () => {
        const bytes = fs.readFileSync(lockBoundaryPaths.lock);
        fs.unlinkSync(lockBoundaryPaths.lock);
        fs.writeFileSync(lockBoundaryPaths.lock, bytes);
      },
    );
    assert.throws(
      () =>
        publication.beginC1229S5DenseRun(
          lockBoundaryPaths,
          lockBoundaryRunId,
          lockBoundary.operations,
        ),
      /lock.*descriptor authority differs/u,
    );
    assert.equal(lockBoundary.injected(), true);
    await assert.rejects(readFile(legacyReceipt(lockBoundaryPaths)), /ENOENT/u);
    assert.deepEqual(await readFile(lockBoundaryPaths.latest), legacyBytes);

    const runningBoundaryRunId = "26262626-3636-4a4a-8b1b-737373737373";
    const runningBoundaryPaths = publication.createC1229S5DenseArtifactPaths(
      join(temporaryRoot, "running-receipt-exclusive-boundary"),
      runningBoundaryRunId,
    );
    seedPrior(runningBoundaryPaths, legacy, legacyBytes);
    const runningBoundary = injectAfterExclusiveClose(
      runningBoundaryPaths.runningReceipt,
      () => {
        const bytes = fs.readFileSync(runningBoundaryPaths.runningReceipt);
        fs.unlinkSync(runningBoundaryPaths.runningReceipt);
        fs.writeFileSync(runningBoundaryPaths.runningReceipt, bytes);
      },
    );
    assert.throws(
      () =>
        publication.beginC1229S5DenseRun(
          runningBoundaryPaths,
          runningBoundaryRunId,
          runningBoundary.operations,
        ),
      /RUNNING receipt at exclusive creation boundary.*descriptor authority differs/u,
    );
    assert.equal(runningBoundary.injected(), true);
    assert.deepEqual(
      await readFile(legacyReceipt(runningBoundaryPaths)),
      legacyBytes,
    );
    assert.deepEqual(await readFile(runningBoundaryPaths.latest), legacyBytes);
    await assert.rejects(readFile(runningBoundaryPaths.lock), /ENOENT/u);

    const archiveHardlinkRunId = "27272727-3737-4b4b-8c2c-747474747474";
    const archiveHardlinkPaths = publication.createC1229S5DenseArtifactPaths(
      join(temporaryRoot, "predecessor-archive-hardlink"),
      archiveHardlinkRunId,
    );
    seedPrior(archiveHardlinkPaths, legacy, legacyBytes);
    fs.linkSync(
      join(archiveHardlinkPaths.directory, `${legacyRunId}.json`),
      join(archiveHardlinkPaths.directory, "archive.alias"),
    );
    assert.throws(
      () =>
        publication.beginC1229S5DenseRun(
          archiveHardlinkPaths,
          archiveHardlinkRunId,
        ),
      /predecessor archive.*single-link/u,
    );
    await assert.rejects(
      readFile(legacyReceipt(archiveHardlinkPaths)),
      /ENOENT/u,
    );

    const receiptHardlinkRunId = "28282828-3838-4c4c-8d3d-757575757575";
    const receiptHardlinkPaths = publication.createC1229S5DenseArtifactPaths(
      join(temporaryRoot, "predecessor-receipt-hardlink"),
      receiptHardlinkRunId,
    );
    seedPrior(receiptHardlinkPaths, legacy, legacyBytes);
    fs.writeFileSync(legacyReceipt(receiptHardlinkPaths), legacyBytes);
    fs.linkSync(
      legacyReceipt(receiptHardlinkPaths),
      join(receiptHardlinkPaths.directory, "receipt.alias"),
    );
    assert.throws(
      () =>
        publication.beginC1229S5DenseRun(
          receiptHardlinkPaths,
          receiptHardlinkRunId,
        ),
      /supersession receipt.*single-link/u,
    );

    const archiveShapedRunId = "29292929-3939-4d4d-8e4e-767676767676";
    const archiveShapedPaths = publication.createC1229S5DenseArtifactPaths(
      join(temporaryRoot, "predecessor-archive-symlink-shaped"),
      archiveShapedRunId,
    );
    seedPrior(archiveShapedPaths, legacy, legacyBytes);
    const shapedArchive = join(
      archiveShapedPaths.directory,
      `${legacyRunId}.json`,
    );
    const archiveShapedOperations = operationProxy({
      lstatSync(file, options) {
        const stat = fs.lstatSync(file, options);
        if (resolve(file) !== resolve(shapedArchive)) return stat;
        return new Proxy(stat, {
          get(target, property) {
            if (property === "isFile") return () => false;
            if (property === "isSymbolicLink") return () => true;
            return Reflect.get(target, property, target);
          },
        });
      },
    });
    assert.throws(
      () =>
        publication.beginC1229S5DenseRun(
          archiveShapedPaths,
          archiveShapedRunId,
          archiveShapedOperations,
        ),
      /predecessor archive.*single-link no-follow/u,
    );
    await assert.rejects(
      readFile(legacyReceipt(archiveShapedPaths)),
      /ENOENT/u,
    );

    for (const [name, prior, malformedRunId] of [
      [
        "malformed-v3",
        {
          schema: C12_29_S5_DENSE_SCHEMA,
          schemaVersion: 3,
          runId: RUN_ID,
          status: "PASS",
          incomplete: false,
          pass: true,
          exitCode: 0,
        },
        "81818181-9292-4a3a-8b4b-c6c6c6c6c6c6",
      ],
      [
        "malformed-v2",
        {
          schema: C12_29_S5_DENSE_SUPERSEDED_SCHEMA,
          schemaVersion: 2,
          runId: supersededRunId,
          status: "PASS",
          incomplete: false,
          pass: true,
          exitCode: 0,
        },
        "82828282-9393-4b4b-8c5c-d7d7d7d7d7d7",
      ],
      [
        "malformed-v1",
        {
          schema: C12_29_S5_DENSE_LEGACY_SCHEMA,
          schemaVersion: 1,
          runId: legacyRunId,
          status: "ERROR",
          incomplete: false,
          pass: false,
          exitCode: 2,
        },
        "91919191-a2a2-4b3b-8c4c-d7d7d7d7d7d7",
      ],
    ]) {
      const malformedBytes = Buffer.from(`${JSON.stringify(prior, null, 2)}\n`);
      const malformedPaths = publication.createC1229S5DenseArtifactPaths(
        join(temporaryRoot, name),
        malformedRunId,
      );
      seedPrior(malformedPaths, prior, malformedBytes);
      assert.throws(
        () => publication.beginC1229S5DenseRun(malformedPaths, malformedRunId),
        /not valid finalized v[123] evidence/u,
      );
      assert.deepEqual(await readFile(malformedPaths.latest), malformedBytes);
      await assert.rejects(readFile(malformedPaths.lock), /ENOENT/u);
    }

    for (const [name, prior, bytes, corruptRunId] of [
      [
        "corrupt-v3-archive",
        current,
        currentBytes,
        "a1a1a1a1-b2b2-4c3c-8d4d-e8e8e8e8e8e8",
      ],
      [
        "corrupt-v2-archive",
        superseded,
        supersededBytes,
        "a2a2a2a2-b3b3-4d4d-8e5e-f9f9f9f9f9f9",
      ],
      [
        "corrupt-v1-archive",
        legacy,
        legacyBytes,
        "b1b1b1b1-c2c2-4d3d-8e4e-f9f9f9f9f9f9",
      ],
    ]) {
      const corruptPaths = publication.createC1229S5DenseArtifactPaths(
        join(temporaryRoot, name),
        corruptRunId,
      );
      seedPrior(corruptPaths, prior, bytes, Buffer.from("corrupt archive\n"));
      assert.throws(
        () => publication.beginC1229S5DenseRun(corruptPaths, corruptRunId),
        /predecessor archive.*bytes differ/u,
      );
      assert.deepEqual(await readFile(corruptPaths.latest), bytes);
      if (prior.schemaVersion < 3) {
        await assert.rejects(
          readFile(
            predecessorReceipt(corruptPaths, prior.schemaVersion, prior.runId),
          ),
          /ENOENT/u,
        );
      }
      await assert.rejects(readFile(corruptPaths.lock), /ENOENT/u);
    }

    for (const [name, prior, bytes, receipt, corruptRunId] of [
      [
        "corrupt-v1-receipt",
        legacy,
        legacyBytes,
        legacyReceipt,
        "b0b0b0b0-c0c0-4d0d-8e0e-f0f0f0f0f0f0",
      ],
      [
        "corrupt-v2-receipt",
        superseded,
        supersededBytes,
        supersededReceipt,
        "b2b2b2b2-c3c3-4e4e-8f5f-a0a0a0a0a0a0",
      ],
    ]) {
      const corruptPaths = publication.createC1229S5DenseArtifactPaths(
        join(temporaryRoot, name),
        corruptRunId,
      );
      seedPrior(corruptPaths, prior, bytes);
      fs.writeFileSync(receipt(corruptPaths), "foreign receipt\n");
      assert.throws(
        () => publication.beginC1229S5DenseRun(corruptPaths, corruptRunId),
        /supersession receipt.*bytes differ/u,
      );
      assert.deepEqual(await readFile(corruptPaths.latest), bytes);
      await assert.rejects(readFile(corruptPaths.lock), /ENOENT/u);
    }

    for (const [name, prior, noncanonicalRunId] of [
      ["noncanonical-v1", legacy, "12121212-3434-4567-89ab-cdef12345678"],
      ["noncanonical-v2", superseded, "13131313-3535-4678-8abc-def123456789"],
      ["noncanonical-v3", current, "14141414-3636-4789-8bcd-ef123456789a"],
    ]) {
      const noncanonicalPaths = publication.createC1229S5DenseArtifactPaths(
        join(temporaryRoot, name),
        noncanonicalRunId,
      );
      const noncanonical = Buffer.from(JSON.stringify(prior));
      seedPrior(noncanonicalPaths, prior, noncanonical, noncanonical);
      assert.throws(
        () =>
          publication.beginC1229S5DenseRun(
            noncanonicalPaths,
            noncanonicalRunId,
          ),
        /not canonical JSON/u,
      );
      assert.deepEqual(await readFile(noncanonicalPaths.latest), noncanonical);
      await assert.rejects(readFile(noncanonicalPaths.lock), /ENOENT/u);
    }

    const deletedRunId = "c1c1c1c1-d2d2-4e3e-8f4f-a0a0a0a0a0a0";
    const deletedPaths = publication.createC1229S5DenseArtifactPaths(
      join(temporaryRoot, "receipt-deleted-post-running"),
      deletedRunId,
    );
    seedPrior(deletedPaths, legacy, legacyBytes);
    fs.writeFileSync(legacyReceipt(deletedPaths), legacyBytes);
    const deleted = injectAfterExclusiveClose(deletedPaths.runningReceipt, () =>
      fs.unlinkSync(legacyReceipt(deletedPaths)),
    );
    assert.throws(
      () =>
        publication.beginC1229S5DenseRun(
          deletedPaths,
          deletedRunId,
          deleted.operations,
        ),
      /post-running-receipt predecessor supersession receipt/u,
    );
    assert.equal(deleted.injected(), true);
    assert.deepEqual(await readFile(deletedPaths.latest), legacyBytes);
    assert.deepEqual(
      await readFile(join(deletedPaths.directory, `${legacyRunId}.json`)),
      legacyBytes,
    );
    await assert.rejects(readFile(deletedPaths.lock), /ENOENT/u);

    const changedRunId = "d1d1d1d1-e2e2-4f3f-8040-b1b1b1b1b1b1";
    const changedPaths = publication.createC1229S5DenseArtifactPaths(
      join(temporaryRoot, "receipt-corrupt-post-latest"),
      changedRunId,
    );
    seedPrior(changedPaths, legacy, legacyBytes);
    fs.writeFileSync(legacyReceipt(changedPaths), legacyBytes);
    let changed = false;
    const changeOperations = operationProxy({
      unlinkSync(file) {
        fs.unlinkSync(file);
        if (
          !changed &&
          String(file).startsWith(`${changedPaths.latest}.running-`)
        ) {
          changed = true;
          fs.writeFileSync(legacyReceipt(changedPaths), "foreign receipt\n");
        }
      },
    });
    assert.throws(
      () =>
        publication.beginC1229S5DenseRun(
          changedPaths,
          changedRunId,
          changeOperations,
        ),
      /post-latest-replacement predecessor supersession receipt.*bytes differ/u,
    );
    assert.equal(changed, true);
    assert.deepEqual(
      await readFile(join(changedPaths.directory, `${legacyRunId}.json`)),
      legacyBytes,
    );
    assert.ok(
      (await readFile(changedPaths.latest)).includes(Buffer.from("RUNNING")),
    );
    assert.ok((await readFile(changedPaths.lock)).byteLength > 0);

    const unreadableRunId = "e1e1e1e1-f2f2-4030-8141-c2c2c2c2c2c2";
    const unreadablePaths = publication.createC1229S5DenseArtifactPaths(
      join(temporaryRoot, "receipt-unreadable-pre-return"),
      unreadableRunId,
    );
    seedPrior(unreadablePaths, legacy, legacyBytes);
    fs.writeFileSync(legacyReceipt(unreadablePaths), legacyBytes);
    let rawCreated = false;
    const unreadableOperations = operationProxy({
      mkdirSync(file, options) {
        fs.mkdirSync(file, options);
        if (file === unreadablePaths.rawDirectory) rawCreated = true;
      },
      openSync(file, flags, mode) {
        if (
          rawCreated &&
          resolve(file) === resolve(legacyReceipt(unreadablePaths))
        ) {
          const error = new Error("receipt read denied");
          error.code = "EACCES";
          throw error;
        }
        return fs.openSync(file, flags, mode);
      },
    });
    assert.throws(
      () =>
        publication.beginC1229S5DenseRun(
          unreadablePaths,
          unreadableRunId,
          unreadableOperations,
        ),
      /receipt read denied/u,
    );
    assert.equal(rawCreated, true);
    assert.deepEqual(
      await readFile(join(unreadablePaths.directory, `${legacyRunId}.json`)),
      legacyBytes,
    );
    assert.ok(
      (await readFile(unreadablePaths.latest)).includes(Buffer.from("RUNNING")),
    );
    assert.ok((await readFile(unreadablePaths.lock)).byteLength > 0);

    const v2DeletedRunId = "e2e2e2e2-f3f3-4141-8252-d3d3d3d3d3d3";
    const v2DeletedPaths = publication.createC1229S5DenseArtifactPaths(
      join(temporaryRoot, "v2-receipt-deleted-post-running"),
      v2DeletedRunId,
    );
    seedPrior(v2DeletedPaths, superseded, supersededBytes);
    fs.writeFileSync(supersededReceipt(v2DeletedPaths), supersededBytes);
    const v2Deleted = injectAfterExclusiveClose(
      v2DeletedPaths.runningReceipt,
      () => fs.unlinkSync(supersededReceipt(v2DeletedPaths)),
    );
    assert.throws(
      () =>
        publication.beginC1229S5DenseRun(
          v2DeletedPaths,
          v2DeletedRunId,
          v2Deleted.operations,
        ),
      /post-running-receipt predecessor supersession receipt/u,
    );
    assert.equal(v2Deleted.injected(), true);
    assert.deepEqual(await readFile(v2DeletedPaths.latest), supersededBytes);
    assert.deepEqual(
      await readFile(join(v2DeletedPaths.directory, `${supersededRunId}.json`)),
      supersededBytes,
    );
    await assert.rejects(readFile(v2DeletedPaths.lock), /ENOENT/u);

    const v2ChangedRunId = "e3e3e3e3-f4f4-4252-8363-e4e4e4e4e4e4";
    const v2ChangedPaths = publication.createC1229S5DenseArtifactPaths(
      join(temporaryRoot, "v2-receipt-corrupt-post-latest"),
      v2ChangedRunId,
    );
    seedPrior(v2ChangedPaths, superseded, supersededBytes);
    fs.writeFileSync(supersededReceipt(v2ChangedPaths), supersededBytes);
    let v2Changed = false;
    const v2ChangeOperations = operationProxy({
      unlinkSync(file) {
        fs.unlinkSync(file);
        if (
          !v2Changed &&
          String(file).startsWith(`${v2ChangedPaths.latest}.running-`)
        ) {
          v2Changed = true;
          fs.writeFileSync(
            supersededReceipt(v2ChangedPaths),
            "foreign receipt\n",
          );
        }
      },
    });
    assert.throws(
      () =>
        publication.beginC1229S5DenseRun(
          v2ChangedPaths,
          v2ChangedRunId,
          v2ChangeOperations,
        ),
      /post-latest-replacement predecessor supersession receipt.*bytes differ/u,
    );
    assert.equal(v2Changed, true);
    assert.deepEqual(
      await readFile(join(v2ChangedPaths.directory, `${supersededRunId}.json`)),
      supersededBytes,
    );
    assert.ok(
      (await readFile(v2ChangedPaths.latest)).includes(Buffer.from("RUNNING")),
    );
    assert.ok((await readFile(v2ChangedPaths.lock)).byteLength > 0);

    const v2UnreadableRunId = "e4e4e4e4-f5f5-4363-8474-f5f5f5f5f5f5";
    const v2UnreadablePaths = publication.createC1229S5DenseArtifactPaths(
      join(temporaryRoot, "v2-receipt-unreadable-pre-return"),
      v2UnreadableRunId,
    );
    seedPrior(v2UnreadablePaths, superseded, supersededBytes);
    fs.writeFileSync(supersededReceipt(v2UnreadablePaths), supersededBytes);
    let v2RawCreated = false;
    const v2UnreadableOperations = operationProxy({
      mkdirSync(file, options) {
        fs.mkdirSync(file, options);
        if (file === v2UnreadablePaths.rawDirectory) v2RawCreated = true;
      },
      openSync(file, flags, mode) {
        if (
          v2RawCreated &&
          resolve(file) === resolve(supersededReceipt(v2UnreadablePaths))
        ) {
          const error = new Error("v2 receipt read denied");
          error.code = "EACCES";
          throw error;
        }
        return fs.openSync(file, flags, mode);
      },
    });
    assert.throws(
      () =>
        publication.beginC1229S5DenseRun(
          v2UnreadablePaths,
          v2UnreadableRunId,
          v2UnreadableOperations,
        ),
      /v2 receipt read denied/u,
    );
    assert.equal(v2RawCreated, true);
    assert.deepEqual(
      await readFile(
        join(v2UnreadablePaths.directory, `${supersededRunId}.json`),
      ),
      supersededBytes,
    );
    assert.ok(
      (await readFile(v2UnreadablePaths.latest)).includes(
        Buffer.from("RUNNING"),
      ),
    );
    assert.ok((await readFile(v2UnreadablePaths.lock)).byteLength > 0);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("25c final publication retains predecessor archive and receipt authority after begin", async () => {
  const publication = await import("./probe-c12-29-s5-dense-cost.mjs");
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "c12-29-s5-dense-predecessor-finality-"),
  );
  const operationProxy = (overrides) =>
    new Proxy(fs, {
      get(target, property) {
        return overrides[property] ?? Reflect.get(target, property);
      },
    });
  const injectAfterExclusiveClose = (file, inject) => {
    const exclusiveDescriptors = new Set();
    let injected = false;
    return {
      operations: operationProxy({
        openSync(candidate, flags, mode) {
          const descriptor = fs.openSync(candidate, flags, mode);
          if (
            resolve(candidate) === resolve(file) &&
            typeof flags === "number" &&
            (flags & fs.constants.O_EXCL) !== 0
          ) {
            exclusiveDescriptors.add(descriptor);
          }
          return descriptor;
        },
        closeSync(descriptor) {
          fs.closeSync(descriptor);
          if (!injected && exclusiveDescriptors.delete(descriptor)) {
            injected = true;
            inject();
          }
        },
      }),
      injected: () => injected,
    };
  };
  const legacyRunId = "10101010-2020-4343-8454-565656565656";
  const supersededRunId = "30303030-4040-4545-8656-787878787878";
  const legacy = validLegacyReport(legacyRunId);
  const superseded = validSupersededReport(supersededRunId);
  const legacyBytes = Buffer.from(`${JSON.stringify(legacy, null, 2)}\n`);
  const supersededBytes = Buffer.from(
    `${JSON.stringify(superseded, null, 2)}\n`,
  );
  const seed = (name, runId, predecessor, predecessorBytes) => {
    const output = join(temporaryRoot, name);
    const paths = publication.createC1229S5DenseArtifactPaths(output, runId);
    const archive = join(output, `${predecessor.runId}.json`);
    const receipt = join(
      output,
      `campaign12-c12-29-s5-dense-cost.superseded-v${predecessor.schemaVersion}-${predecessor.runId}.json`,
    );
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(paths.latest, predecessorBytes);
    fs.writeFileSync(archive, predecessorBytes);
    const started = publication.beginC1229S5DenseRun(paths, runId);
    return { archive, paths, receipt, runId, started };
  };
  const publish = (entry, operations = fs) =>
    publication.publishC1229S5DenseFinal(
      entry.paths,
      entry.started.publicationAuthority,
      { runId: entry.runId, status: "PASS", incomplete: false },
      operations,
    );
  const assertOwnedRunningRetained = async (entry) => {
    assert.deepEqual(await readFile(entry.paths.lock), entry.started.lockBytes);
    assert.deepEqual(
      await readFile(entry.paths.latest),
      entry.started.runningBytes,
    );
  };
  try {
    const deleted = seed(
      "v1-deleted-post-begin",
      "20202020-3030-4444-8565-676767676767",
      legacy,
      legacyBytes,
    );
    const clonedAuthority = structuredClone(
      deleted.started.publicationAuthority,
    );
    assert.throws(
      () =>
        publication.publishC1229S5DenseFinal(deleted.paths, clonedAuthority, {
          runId: deleted.runId,
          status: "PASS",
          incomplete: false,
        }),
      /not issued by begin/u,
    );
    fs.unlinkSync(deleted.archive);
    fs.unlinkSync(deleted.receipt);
    assert.throws(
      () => publish(deleted),
      /predecessor|prior immutable|supersession receipt/u,
    );
    await assertOwnedRunningRetained(deleted);

    const runningChanged = seed(
      "v1-running-receipt-substituted",
      "21212121-3131-4545-8676-686868686868",
      legacy,
      legacyBytes,
    );
    fs.writeFileSync(runningChanged.paths.runningReceipt, "foreign RUNNING\n");
    assert.throws(
      () => publish(runningChanged),
      /immutable RUNNING receipt authority.*bytes differ/u,
    );
    await assertOwnedRunningRetained(runningChanged);

    const postImmutableEntry = seed(
      "v1-receipt-deleted-post-immutable",
      "22222222-3232-4646-8787-696969696969",
      legacy,
      legacyBytes,
    );
    const postImmutable = injectAfterExclusiveClose(
      postImmutableEntry.paths.immutable,
      () => fs.unlinkSync(postImmutableEntry.receipt),
    );
    assert.throws(
      () => publish(postImmutableEntry, postImmutable.operations),
      /post-immutable predecessor.*supersession receipt/u,
    );
    assert.equal(postImmutable.injected(), true);
    await assertOwnedRunningRetained(postImmutableEntry);

    const postReceiptEntry = seed(
      "v1-receipt-deleted-post-final-receipt",
      "23232323-3333-4747-8888-707070707070",
      legacy,
      legacyBytes,
    );
    const postReceipt = injectAfterExclusiveClose(
      postReceiptEntry.paths.finalReceipt,
      () => fs.unlinkSync(postReceiptEntry.receipt),
    );
    assert.throws(
      () => publish(postReceiptEntry, postReceipt.operations),
      /post-final-receipt predecessor.*supersession receipt/u,
    );
    assert.equal(postReceipt.injected(), true);
    await assertOwnedRunningRetained(postReceiptEntry);

    const legacySuccess = seed(
      "v1-success",
      "24242424-3434-4848-8999-717171717171",
      legacy,
      legacyBytes,
    );
    const legacySuccessReceipt = publish(legacySuccess);
    assert.equal(legacySuccessReceipt.predecessorAuthority.schemaVersion, 1);
    assert.equal(legacySuccessReceipt.predecessorAuthority.runId, legacyRunId);
    assert.deepEqual(await readFile(legacySuccess.archive), legacyBytes);
    assert.deepEqual(await readFile(legacySuccess.receipt), legacyBytes);
    await assert.rejects(readFile(legacySuccess.paths.lock), /ENOENT/u);

    const receiptChanged = seed(
      "v2-receipt-substituted-post-begin",
      "70707070-8080-4949-8a9a-b2b2b2b2b2b2",
      superseded,
      supersededBytes,
    );
    fs.writeFileSync(receiptChanged.receipt, "foreign v2 receipt\n");
    assert.throws(() => publish(receiptChanged), /predecessor.*bytes differ/u);
    await assertOwnedRunningRetained(receiptChanged);

    const postLatest = seed(
      "v2-substituted-post-final-latest",
      "71717171-8181-4a5a-8b0b-c3c3c3c3c3c3",
      superseded,
      supersededBytes,
    );
    let postLatestInjected = false;
    const postLatestOperations = operationProxy({
      unlinkSync(file) {
        fs.unlinkSync(file);
        if (
          !postLatestInjected &&
          String(file).startsWith(`${postLatest.paths.latest}.final-`)
        ) {
          postLatestInjected = true;
          fs.writeFileSync(postLatest.archive, "foreign v2 archive\n");
        }
      },
    });
    assert.throws(
      () => publish(postLatest, postLatestOperations),
      /post-final-latest predecessor.*archive.*bytes differ/u,
    );
    assert.equal(postLatestInjected, true);
    await assertOwnedRunningRetained(postLatest);

    const successor = seed(
      "v2-successor-after-unlock",
      "72727272-8282-4b6b-8c1c-d4d4d4d4d4d4",
      superseded,
      supersededBytes,
    );
    const successorLock = Buffer.from("successor lock authority\n");
    const successorLatest = Buffer.from("successor latest authority\n");
    let unlockInjected = false;
    const unlockOperations = operationProxy({
      renameSync(from, to) {
        fs.renameSync(from, to);
        if (
          !unlockInjected &&
          from === successor.paths.lock &&
          String(to).includes(".release-")
        ) {
          unlockInjected = true;
          fs.writeFileSync(successor.paths.lock, successorLock, {
            flag: "wx",
          });
          fs.writeFileSync(successor.paths.latest, successorLatest);
          fs.writeFileSync(successor.receipt, "foreign v2 receipt\n");
        }
      },
    });
    const successorReceipt = publish(successor, unlockOperations);
    assert.equal(successorReceipt.kind, "c12-29-s5-dense-cost-final-receipt");
    assert.equal(unlockInjected, true);
    assert.deepEqual(await readFile(successor.paths.lock), successorLock);
    assert.deepEqual(await readFile(successor.paths.latest), successorLatest);
    assert.deepEqual(await readFile(successor.archive), supersededBytes);
    assert.deepEqual(
      await readFile(successor.receipt),
      Buffer.from("foreign v2 receipt\n"),
    );

    const throwingSuccessor = seed(
      "v2-successor-after-throwing-unlock",
      "73737373-8383-4c7c-8d2d-e5e5e5e5e5e5",
      superseded,
      supersededBytes,
    );
    const throwingSuccessorLock = Buffer.from("throwing successor lock\n");
    const throwingSuccessorLatest = Buffer.from("throwing successor latest\n");
    let throwingUnlockInjected = false;
    const throwingUnlockOperations = operationProxy({
      renameSync(from, to) {
        fs.renameSync(from, to);
        if (
          !throwingUnlockInjected &&
          from === throwingSuccessor.paths.lock &&
          String(to).includes(".release-")
        ) {
          throwingUnlockInjected = true;
          fs.writeFileSync(
            throwingSuccessor.paths.lock,
            throwingSuccessorLock,
            { flag: "wx" },
          );
          fs.writeFileSync(
            throwingSuccessor.paths.latest,
            throwingSuccessorLatest,
          );
          fs.writeFileSync(
            throwingSuccessor.receipt,
            "throwing successor predecessor receipt\n",
          );
          const error = new Error("rename reported EIO after owned move");
          error.code = "EIO";
          throw error;
        }
      },
    });
    const throwingSuccessorReceipt = publish(
      throwingSuccessor,
      throwingUnlockOperations,
    );
    assert.equal(
      throwingSuccessorReceipt.kind,
      "c12-29-s5-dense-cost-final-receipt",
    );
    assert.equal(throwingUnlockInjected, true);
    assert.deepEqual(
      await readFile(throwingSuccessor.paths.lock),
      throwingSuccessorLock,
    );
    assert.deepEqual(
      await readFile(throwingSuccessor.paths.latest),
      throwingSuccessorLatest,
    );

    const throwingLatest = seed(
      "v2-throwing-latest-claim",
      "76767676-8686-4faf-8050-b8b8b8b8b8b8",
      superseded,
      supersededBytes,
    );
    let throwingLatestInjected = false;
    const throwingLatestOperations = operationProxy({
      renameSync(from, to) {
        fs.renameSync(from, to);
        if (
          !throwingLatestInjected &&
          from === throwingLatest.paths.latest &&
          String(to).includes(".final-")
        ) {
          throwingLatestInjected = true;
          const error = new Error("latest rename reported EIO after move");
          error.code = "EIO";
          throw error;
        }
      },
    });
    const throwingLatestFinal = publish(
      throwingLatest,
      throwingLatestOperations,
    );
    assert.equal(throwingLatestFinal.status, "PASS");
    assert.equal(throwingLatestInjected, true);
    await assert.rejects(readFile(throwingLatest.paths.lock), /ENOENT/u);

    const latestDelete = seed(
      "v2-latest-held-descriptor-delete",
      "74747474-8484-4d8d-8e3e-f6f6f6f6f6f6",
      superseded,
      supersededBytes,
    );
    const latestDeleteDescriptors = new Map();
    const foreignLatestReceipt = Buffer.from("foreign latest receipt\n");
    let deletedLatestReceipt = null;
    let latestDeleteInjected = false;
    const latestDeleteOperations = operationProxy({
      openSync(file, flags, mode) {
        const descriptor = fs.openSync(file, flags, mode);
        latestDeleteDescriptors.set(descriptor, resolve(file));
        return descriptor;
      },
      unlinkSync(file) {
        fs.unlinkSync(file);
        if (String(file).startsWith(`${latestDelete.paths.latest}.final-`)) {
          deletedLatestReceipt = resolve(file);
        }
      },
      closeSync(descriptor) {
        const file = latestDeleteDescriptors.get(descriptor);
        fs.closeSync(descriptor);
        latestDeleteDescriptors.delete(descriptor);
        if (
          !latestDeleteInjected &&
          deletedLatestReceipt !== null &&
          file === deletedLatestReceipt
        ) {
          latestDeleteInjected = true;
          assert.equal(fs.existsSync(deletedLatestReceipt), false);
          fs.writeFileSync(deletedLatestReceipt, foreignLatestReceipt, {
            flag: "wx",
          });
        }
      },
    });
    const latestDeleteFinal = publish(latestDelete, latestDeleteOperations);
    assert.equal(latestDeleteFinal.status, "PASS");
    assert.equal(latestDeleteInjected, true);
    assert.deepEqual(
      await readFile(deletedLatestReceipt),
      foreignLatestReceipt,
    );

    const unlockDelete = seed(
      "v2-unlock-held-descriptor-delete",
      "75757575-8585-4e9e-8f4f-a7a7a7a7a7a7",
      superseded,
      supersededBytes,
    );
    const unlockDeleteDescriptors = new Map();
    const unlockDeleteSuccessorLock = Buffer.from("delete successor lock\n");
    const unlockDeleteSuccessorLatest = Buffer.from(
      "delete successor latest\n",
    );
    const foreignUnlockReceipt = Buffer.from("foreign unlock receipt\n");
    let deletedUnlockReceipt = null;
    let unlockDeleteInjected = false;
    const unlockDeleteOperations = operationProxy({
      openSync(file, flags, mode) {
        const descriptor = fs.openSync(file, flags, mode);
        unlockDeleteDescriptors.set(descriptor, resolve(file));
        return descriptor;
      },
      unlinkSync(file) {
        fs.unlinkSync(file);
        if (String(file).includes(".release-")) {
          deletedUnlockReceipt = resolve(file);
        }
      },
      closeSync(descriptor) {
        const file = unlockDeleteDescriptors.get(descriptor);
        fs.closeSync(descriptor);
        unlockDeleteDescriptors.delete(descriptor);
        if (
          !unlockDeleteInjected &&
          deletedUnlockReceipt !== null &&
          file === deletedUnlockReceipt
        ) {
          unlockDeleteInjected = true;
          assert.equal(fs.existsSync(deletedUnlockReceipt), false);
          fs.writeFileSync(unlockDelete.paths.lock, unlockDeleteSuccessorLock, {
            flag: "wx",
          });
          fs.writeFileSync(
            unlockDelete.paths.latest,
            unlockDeleteSuccessorLatest,
          );
          fs.writeFileSync(deletedUnlockReceipt, foreignUnlockReceipt, {
            flag: "wx",
          });
          fs.writeFileSync(
            unlockDelete.receipt,
            "foreign post-delete predecessor receipt\n",
          );
        }
      },
    });
    const unlockDeleteFinal = publish(unlockDelete, unlockDeleteOperations);
    assert.equal(unlockDeleteFinal.status, "PASS");
    assert.equal(unlockDeleteInjected, true);
    assert.deepEqual(
      await readFile(unlockDelete.paths.lock),
      unlockDeleteSuccessorLock,
    );
    assert.deepEqual(
      await readFile(unlockDelete.paths.latest),
      unlockDeleteSuccessorLatest,
    );
    assert.deepEqual(
      await readFile(deletedUnlockReceipt),
      foreignUnlockReceipt,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("25d publication authority binds exact path topology and no-follow file identities", async () => {
  const publication = await import("./probe-c12-29-s5-dense-cost.mjs");
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "c12-29-s5-dense-path-authority-"),
  );
  const operationProxy = (overrides) =>
    new Proxy(fs, {
      get(target, property) {
        return overrides[property] ?? Reflect.get(target, property);
      },
    });
  const report = (runId) => ({
    runId,
    status: "PASS",
    incomplete: false,
  });
  try {
    const runId = "a0a0a0a0-b1b1-4c2c-8d3d-e4e4e4e4e4e4";
    const paths = publication.createC1229S5DenseArtifactPaths(
      join(temporaryRoot, "bound"),
      runId,
    );
    const started = publication.beginC1229S5DenseRun(paths, runId);
    const alternateDirectory = publication.createC1229S5DenseArtifactPaths(
      join(temporaryRoot, "cross-directory"),
      runId,
    );
    const crossRun = publication.createC1229S5DenseArtifactPaths(
      paths.directory,
      "b1b1b1b1-c2c2-4d3d-8e4e-f5f5f5f5f5f5",
    );
    for (const mutatedPaths of [
      alternateDirectory,
      crossRun,
      { ...paths, immutable: join(paths.directory, "alternate.json") },
      { ...paths, finalReceipt: paths.immutable },
    ]) {
      assert.throws(
        () =>
          publication.publishC1229S5DenseFinal(
            mutatedPaths,
            started.publicationAuthority,
            report(runId),
          ),
        /path.*(topology|authority).*differs/u,
      );
    }

    const symlinkShapedOperations = operationProxy({
      lstatSync(file, options) {
        const stat = fs.lstatSync(file, options);
        if (resolve(file) !== resolve(paths.runningReceipt)) return stat;
        return new Proxy(stat, {
          get(target, property) {
            if (property === "isFile") return () => false;
            if (property === "isSymbolicLink") return () => true;
            return Reflect.get(target, property, target);
          },
        });
      },
    });
    assert.throws(
      () =>
        publication.publishC1229S5DenseFinal(
          paths,
          started.publicationAuthority,
          report(runId),
          symlinkShapedOperations,
        ),
      /single-link no-follow regular file/u,
    );

    const unreadableOperations = operationProxy({
      openSync(file, flags, mode) {
        if (resolve(file) === resolve(paths.runningReceipt)) {
          const error = new Error("RUNNING receipt read denied");
          error.code = "EACCES";
          throw error;
        }
        return fs.openSync(file, flags, mode);
      },
    });
    assert.throws(
      () =>
        publication.publishC1229S5DenseFinal(
          paths,
          started.publicationAuthority,
          report(runId),
          unreadableOperations,
        ),
      /RUNNING receipt read denied/u,
    );

    fs.unlinkSync(paths.runningReceipt);
    fs.writeFileSync(paths.runningReceipt, started.runningBytes);
    assert.throws(
      () =>
        publication.publishC1229S5DenseFinal(
          paths,
          started.publicationAuthority,
          report(runId),
        ),
      /descriptor authority differs/u,
    );
    assert.deepEqual(await readFile(paths.lock), started.lockBytes);

    const hardlinkRunId = "c2c2c2c2-d3d3-4e4e-8f5f-a6a6a6a6a6a6";
    const hardlinkPaths = publication.createC1229S5DenseArtifactPaths(
      join(temporaryRoot, "hardlink"),
      hardlinkRunId,
    );
    const hardlinkStarted = publication.beginC1229S5DenseRun(
      hardlinkPaths,
      hardlinkRunId,
    );
    fs.unlinkSync(hardlinkPaths.runningReceipt);
    fs.linkSync(hardlinkPaths.latest, hardlinkPaths.runningReceipt);
    assert.throws(
      () =>
        publication.publishC1229S5DenseFinal(
          hardlinkPaths,
          hardlinkStarted.publicationAuthority,
          report(hardlinkRunId),
        ),
      /single-link no-follow regular file/u,
    );
    assert.deepEqual(
      await readFile(hardlinkPaths.lock),
      hardlinkStarted.lockBytes,
    );

    const directoryRunId = "d3d3d3d3-e4e4-4f5f-8060-b7b7b7b7b7b7";
    const directoryPaths = publication.createC1229S5DenseArtifactPaths(
      join(temporaryRoot, "directory-identity"),
      directoryRunId,
    );
    const directoryStarted = publication.beginC1229S5DenseRun(
      directoryPaths,
      directoryRunId,
    );
    const directoryIdentityOperations = operationProxy({
      lstatSync(file, options) {
        const stat = fs.lstatSync(file, options);
        if (resolve(file) !== resolve(directoryPaths.directory)) return stat;
        return new Proxy(stat, {
          get(target, property) {
            if (property === "ino") return target.ino + 1n;
            return Reflect.get(target, property, target);
          },
        });
      },
    });
    assert.throws(
      () =>
        publication.publishC1229S5DenseFinal(
          directoryPaths,
          directoryStarted.publicationAuthority,
          report(directoryRunId),
          directoryIdentityOperations,
        ),
      /output directory.*identity differs/u,
    );

    const lockRunId = "e4e4e4e4-f5f5-4060-8171-c8c8c8c8c8c8";
    const lockPaths = publication.createC1229S5DenseArtifactPaths(
      join(temporaryRoot, "same-byte-lock-replacement"),
      lockRunId,
    );
    const lockStarted = publication.beginC1229S5DenseRun(lockPaths, lockRunId);
    fs.unlinkSync(lockPaths.lock);
    fs.writeFileSync(lockPaths.lock, lockStarted.lockBytes);
    assert.throws(
      () =>
        publication.publishC1229S5DenseFinal(
          lockPaths,
          lockStarted.publicationAuthority,
          report(lockRunId),
        ),
      /lock authority.*descriptor authority differs/u,
    );
    assert.deepEqual(
      await readFile(lockPaths.latest),
      lockStarted.runningBytes,
    );

    const latestRunId = "f5f5f5f5-a6a6-4171-8282-d9d9d9d9d9d9";
    const latestPaths = publication.createC1229S5DenseArtifactPaths(
      join(temporaryRoot, "hardlink-latest"),
      latestRunId,
    );
    const latestStarted = publication.beginC1229S5DenseRun(
      latestPaths,
      latestRunId,
    );
    fs.linkSync(
      latestPaths.latest,
      join(latestPaths.directory, "latest.alias"),
    );
    assert.throws(
      () =>
        publication.publishC1229S5DenseFinal(
          latestPaths,
          latestStarted.publicationAuthority,
          report(latestRunId),
        ),
      /single-link no-follow regular file/u,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("25e first-red authority is canonical, archive-backed, retained for PASS, and immutable", async () => {
  const publication = await import("./probe-c12-29-s5-dense-cost.mjs");
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "c12-29-s5-dense-first-red-authority-"),
  );
  const operationProxy = (overrides) =>
    new Proxy(fs, {
      get(target, property) {
        return overrides[property] ?? Reflect.get(target, property);
      },
    });
  const minimalPass = (runId) => ({
    runId,
    status: "PASS",
    incomplete: false,
  });
  try {
    const lateRunId = "d3d3d3d3-e4e4-4f5f-8060-b7b7b7b7b7b7";
    const latePaths = publication.createC1229S5DenseArtifactPaths(
      join(temporaryRoot, "late-appearance"),
      lateRunId,
    );
    const lateStarted = publication.beginC1229S5DenseRun(latePaths, lateRunId);
    fs.writeFileSync(latePaths.firstRed, "late foreign first-red\n");
    assert.throws(
      () =>
        publication.publishC1229S5DenseFinal(
          latePaths,
          lateStarted.publicationAuthority,
          minimalPass(lateRunId),
        ),
      /first-red.*occupied/u,
    );
    assert.deepEqual(await readFile(latePaths.lock), lateStarted.lockBytes);

    const shapedRunId = "e4e4e4e4-f5f5-4060-8171-c8c8c8c8c8c8";
    const shapedPaths = publication.createC1229S5DenseArtifactPaths(
      join(temporaryRoot, "symlink-shaped"),
      shapedRunId,
    );
    fs.mkdirSync(shapedPaths.directory, { recursive: true });
    fs.writeFileSync(shapedPaths.firstRed, "symlink-shaped first-red\n");
    const shapedOperations = operationProxy({
      lstatSync(file, options) {
        const stat = fs.lstatSync(file, options);
        if (resolve(file) !== resolve(shapedPaths.firstRed)) return stat;
        return new Proxy(stat, {
          get(target, property) {
            if (property === "isFile") return () => false;
            if (property === "isSymbolicLink") return () => true;
            return Reflect.get(target, property, target);
          },
        });
      },
    });
    assert.throws(
      () =>
        publication.beginC1229S5DenseRun(
          shapedPaths,
          shapedRunId,
          shapedOperations,
        ),
      /single-link no-follow regular file/u,
    );

    const hardlinkRunId = "f5f5f5f5-a6a6-4171-8282-d9d9d9d9d9d9";
    const hardlinkPaths = publication.createC1229S5DenseArtifactPaths(
      join(temporaryRoot, "hardlink-shaped"),
      hardlinkRunId,
    );
    fs.mkdirSync(hardlinkPaths.directory, { recursive: true });
    const backing = join(hardlinkPaths.directory, "first-red-backing.json");
    fs.writeFileSync(backing, "hardlinked first-red\n");
    fs.linkSync(backing, hardlinkPaths.firstRed);
    assert.throws(
      () => publication.beginC1229S5DenseRun(hardlinkPaths, hardlinkRunId),
      /single-link no-follow regular file/u,
    );

    const passEvidenceRunId = "a6a6a6a6-b7b7-4282-8393-e0e0e0e0e0e0";
    const passEvidence = validReportForRun(passEvidenceRunId);
    const passEvidenceBytes = Buffer.from(
      `${JSON.stringify(passEvidence, null, 2)}\n`,
    );
    const passPaths = publication.createC1229S5DenseArtifactPaths(
      join(temporaryRoot, "pass-is-not-red"),
      "b7b7b7b7-c8c8-4393-84a4-f1f1f1f1f1f1",
    );
    fs.mkdirSync(passPaths.directory, { recursive: true });
    fs.writeFileSync(passPaths.firstRed, passEvidenceBytes);
    fs.writeFileSync(
      join(passPaths.directory, `${passEvidenceRunId}.json`),
      passEvidenceBytes,
    );
    assert.throws(
      () =>
        publication.beginC1229S5DenseRun(
          passPaths,
          "b7b7b7b7-c8c8-4393-84a4-f1f1f1f1f1f1",
        ),
      /not red final evidence/u,
    );

    const redEvidenceRunId = "c8c8c8c8-d9d9-44a4-85b5-a2a2a2a2a2a2";
    const redEvidence = validReportForRun(redEvidenceRunId, (report) => {
      report.legs[0].transport.pageErrors.push("first-red authority seed");
    });
    const redEvidenceBytes = Buffer.from(
      `${JSON.stringify(redEvidence, null, 2)}\n`,
    );
    const missingArchiveRunId = "d9d9d9d9-e0e0-45b5-86c6-b3b3b3b3b3b3";
    const missingArchivePaths = publication.createC1229S5DenseArtifactPaths(
      join(temporaryRoot, "missing-first-red-archive"),
      missingArchiveRunId,
    );
    fs.mkdirSync(missingArchivePaths.directory, { recursive: true });
    fs.writeFileSync(missingArchivePaths.firstRed, redEvidenceBytes);
    assert.throws(
      () =>
        publication.beginC1229S5DenseRun(
          missingArchivePaths,
          missingArchiveRunId,
        ),
      /first-red immutable archive.*lstat failed/u,
    );

    const retainedRunId = "e0e0e0e0-f1f1-46c6-87d7-c4c4c4c4c4c4";
    const retainedPaths = publication.createC1229S5DenseArtifactPaths(
      join(temporaryRoot, "retained-first-red"),
      retainedRunId,
    );
    fs.mkdirSync(retainedPaths.directory, { recursive: true });
    const redArchive = join(
      retainedPaths.directory,
      `${redEvidenceRunId}.json`,
    );
    fs.writeFileSync(retainedPaths.firstRed, redEvidenceBytes);
    fs.writeFileSync(redArchive, redEvidenceBytes);
    const retainedStarted = publication.beginC1229S5DenseRun(
      retainedPaths,
      retainedRunId,
    );

    const unreadableOperations = operationProxy({
      lstatSync(file, options) {
        if (resolve(file) === resolve(retainedPaths.firstRed)) {
          const error = new Error("first-red lstat denied");
          error.code = "EACCES";
          throw error;
        }
        return fs.lstatSync(file, options);
      },
    });
    assert.throws(
      () =>
        publication.publishC1229S5DenseFinal(
          retainedPaths,
          retainedStarted.publicationAuthority,
          minimalPass(retainedRunId),
          unreadableOperations,
        ),
      /first-red lstat denied/u,
    );

    const deletedOperations = operationProxy({
      lstatSync(file, options) {
        if (resolve(file) === resolve(retainedPaths.firstRed)) {
          const error = new Error("first-red deleted");
          error.code = "ENOENT";
          throw error;
        }
        return fs.lstatSync(file, options);
      },
    });
    assert.throws(
      () =>
        publication.publishC1229S5DenseFinal(
          retainedPaths,
          retainedStarted.publicationAuthority,
          minimalPass(retainedRunId),
          deletedOperations,
        ),
      /first-red.*lstat failed/u,
    );

    const archiveAliasOperations = operationProxy({
      lstatSync(file, options) {
        const stat = fs.lstatSync(file, options);
        if (resolve(file) !== resolve(redArchive)) return stat;
        return new Proxy(stat, {
          get(target, property) {
            if (property === "ino") return target.ino + 1n;
            return Reflect.get(target, property, target);
          },
        });
      },
    });
    assert.throws(
      () =>
        publication.publishC1229S5DenseFinal(
          retainedPaths,
          retainedStarted.publicationAuthority,
          minimalPass(retainedRunId),
          archiveAliasOperations,
        ),
      /descriptor authority differs|opened descriptor differs/u,
    );

    const retainedReceipt = publication.publishC1229S5DenseFinal(
      retainedPaths,
      retainedStarted.publicationAuthority,
      minimalPass(retainedRunId),
    );
    assert.equal(retainedReceipt.status, "PASS");
    assert.deepEqual(await readFile(retainedPaths.firstRed), redEvidenceBytes);
    assert.deepEqual(await readFile(redArchive), redEvidenceBytes);
    await assert.rejects(readFile(retainedPaths.lock), /ENOENT/u);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("25f every newly published file remains descriptor-bound at each boundary", async () => {
  const publication = await import("./probe-c12-29-s5-dense-cost.mjs");
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "c12-29-s5-dense-current-authority-"),
  );
  const operationProxy = (overrides) =>
    new Proxy(fs, {
      get(target, property) {
        return overrides[property] ?? Reflect.get(target, property);
      },
    });
  const report = (runId, status = "PASS") => ({
    runId,
    status,
    incomplete: false,
  });
  const start = (name, runId) => {
    const paths = publication.createC1229S5DenseArtifactPaths(
      join(temporaryRoot, name),
      runId,
    );
    return {
      paths,
      started: publication.beginC1229S5DenseRun(paths, runId),
      runId,
    };
  };
  const afterExclusiveClose = (target, mutation) => {
    const createdDescriptors = new Map();
    let injected = false;
    return {
      get injected() {
        return injected;
      },
      operations: operationProxy({
        openSync(file, flags, mode) {
          const descriptor = fs.openSync(file, flags, mode);
          if (
            resolve(file) === resolve(target) &&
            (flags & fs.constants.O_EXCL) !== 0
          ) {
            createdDescriptors.set(descriptor, resolve(file));
          }
          return descriptor;
        },
        closeSync(descriptor) {
          const createdPath = createdDescriptors.get(descriptor);
          fs.closeSync(descriptor);
          if (!injected && createdPath === resolve(target)) {
            injected = true;
            mutation(createdPath);
          }
        },
      }),
    };
  };
  try {
    const immutable = start(
      "immutable-replacement",
      "f1f1f1f1-a2a2-47d7-88e8-d5d5d5d5d5d5",
    );
    const immutableBoundary = afterExclusiveClose(
      immutable.paths.immutable,
      (file) => {
        const bytes = fs.readFileSync(file);
        fs.unlinkSync(file);
        fs.writeFileSync(file, bytes);
      },
    );
    assert.throws(
      () =>
        publication.publishC1229S5DenseFinal(
          immutable.paths,
          immutable.started.publicationAuthority,
          report(immutable.runId),
          immutableBoundary.operations,
        ),
      /descriptor authority differs/u,
    );
    assert.equal(immutableBoundary.injected, true);
    assert.deepEqual(
      await readFile(immutable.paths.lock),
      immutable.started.lockBytes,
    );

    const firstRed = start(
      "first-red-hardlink",
      "a2a2a2a2-b3b3-48e8-89f9-e6e6e6e6e6e6",
    );
    const firstRedAlias = `${firstRed.paths.firstRed}.alias`;
    const firstRedBoundary = afterExclusiveClose(
      firstRed.paths.firstRed,
      (file) => fs.linkSync(file, firstRedAlias),
    );
    assert.throws(
      () =>
        publication.publishC1229S5DenseFinal(
          firstRed.paths,
          firstRed.started.publicationAuthority,
          report(firstRed.runId, "ERROR"),
          firstRedBoundary.operations,
        ),
      /single-link no-follow regular file/u,
    );
    assert.equal(firstRedBoundary.injected, true);
    assert.deepEqual(
      await readFile(firstRed.paths.lock),
      firstRed.started.lockBytes,
    );

    const finalLatest = start(
      "final-latest-replacement",
      "b3b3b3b3-c4c4-49f9-8a0a-f7f7f7f7f7f7",
    );
    const latestBoundary = afterExclusiveClose(
      finalLatest.paths.latest,
      (file) => {
        const bytes = fs.readFileSync(file);
        fs.unlinkSync(file);
        fs.writeFileSync(file, bytes);
      },
    );
    assert.throws(
      () =>
        publication.publishC1229S5DenseFinal(
          finalLatest.paths,
          finalLatest.started.publicationAuthority,
          report(finalLatest.runId),
          latestBoundary.operations,
        ),
      /descriptor authority differs|recovery refused/u,
    );
    assert.equal(latestBoundary.injected, true);
    assert.deepEqual(
      await readFile(finalLatest.paths.lock),
      finalLatest.started.lockBytes,
    );

    const finalReceipt = start(
      "final-receipt-replacement",
      "c4c4c4c4-d5d5-4a0a-8b1b-a8a8a8a8a8a8",
    );
    const receiptBoundary = afterExclusiveClose(
      finalReceipt.paths.finalReceipt,
      (file) => {
        const bytes = fs.readFileSync(file);
        fs.unlinkSync(file);
        fs.writeFileSync(file, bytes);
      },
    );
    assert.throws(
      () =>
        publication.publishC1229S5DenseFinal(
          finalReceipt.paths,
          finalReceipt.started.publicationAuthority,
          report(finalReceipt.runId),
          receiptBoundary.operations,
        ),
      /descriptor authority differs/u,
    );
    assert.equal(receiptBoundary.injected, true);
    assert.deepEqual(
      await readFile(finalReceipt.paths.lock),
      finalReceipt.started.lockBytes,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("26 provenance closure rejects omission, forged digests, stale served bytes, empty maps, and raw drift", () => {
  const mutations = [
    (report) => report.provenance.start.localFiles.pop(),
    (report) => report.provenance.start.servedFiles.pop(),
    (report) => {
      const identity = report.provenance.start.servedFiles.find(
        (item) =>
          item.path ===
          "Tools/visual-regression/lib/c12-29-s5-dense-cost-gate.mjs",
      );
      identity.sha256 = "f".repeat(64);
    },
    (report) => (report.provenance.start.buildSourceIdentity.entries = []),
    (report) => (report.provenance.start.rawGenerated[0].exact = false),
  ];
  for (const mutation of mutations) {
    const report = validReport();
    mutation(report);
    report.provenance.end = clone(report.provenance.start);
    resignSnapshot(report.provenance.start);
    resignSnapshot(report.provenance.end);
    for (const leg of report.legs) {
      leg.sourceIdentitySha256 = report.provenance.start.identitySha256;
    }
    assert.equal(foldC1229S5DenseCostGate(report).status, "STRUCTURAL");
  }
  const forgedPrerequisiteDigest = validReport();
  forgedPrerequisiteDigest.prerequisitesSha256 = "f".repeat(64);
  for (const leg of forgedPrerequisiteDigest.legs) {
    leg.prerequisitesSha256 = forgedPrerequisiteDigest.prerequisitesSha256;
  }
  assert.equal(
    foldC1229S5DenseCostGate(forgedPrerequisiteDigest).status,
    "STRUCTURAL",
  );
});

test("27 refresh pacing and observed camera attitude recompute from raw evidence", () => {
  for (const mutation of [
    (leg) => (leg.measurement.trace.samples[0].wallDtMs = null),
    (leg) =>
      (leg.measurement.framePacing.requestAnimationFrameYieldCount = 599),
    (leg) => (leg.measurement.framePacing.elapsedMs += 1),
    (leg) => (leg.measurement.framePacing.wallSummary.p99 += 1),
    (leg) => (leg.measurement.route[0].actual.heading = 1),
    (leg) => (leg.measurement.route[0].actual.pitch = -89),
    (leg) => (leg.measurement.route[0].actual.roll = 1),
  ]) {
    const leg = validLeg(C12_29_S5_DENSE_SCHEDULE[0]);
    mutation(leg);
    assert.ok(
      validateC1229S5DenseRuntimeLeg(leg, workload).structural.length > 0,
    );
  }
});

test("28 long tasks exclude setup, clip the terminal boundary, and cannot be forged or overlap", () => {
  assert.deepEqual(
    selectC1229S5DenseLongTasks(
      [
        { startTime: 999, duration: 100 },
        { startTime: 2000, duration: 100 },
        { startTime: 10550, duration: 100 },
        { startTime: 10600, duration: 100 },
      ],
      1000,
      10600,
    ),
    [
      { startTime: 2000, rawDuration: 100, duration: 100 },
      { startTime: 10550, rawDuration: 100, duration: 50 },
    ],
  );
  for (const mutation of [
    (leg) => (leg.measurement.longTasks.entries = []),
    (leg) => (leg.measurement.longTasks.totalDurationMs = 0),
    (leg) => (leg.measurement.longTasks.share = 0),
    (leg) => (leg.measurement.longTasks.measurementStartMs = 999),
    (leg) => {
      leg.measurement.longTasks.entries = [
        { startTime: 2000, rawDuration: 100, duration: 100 },
        { startTime: 2050, rawDuration: 100, duration: 100 },
      ];
      leg.measurement.longTasks.totalDurationMs = 200;
      leg.measurement.longTasks.share = 200 / 9600;
    },
  ]) {
    const leg = validLeg(C12_29_S5_DENSE_SCHEDULE[0]);
    mutation(leg);
    assert.ok(
      validateC1229S5DenseRuntimeLeg(leg, workload).structural.length > 0,
    );
  }
});

test("29 WebGPU ledger arithmetic, drain shape, cleanup, and raw status cannot be self-asserted", () => {
  const webgpu = C12_29_S5_DENSE_SCHEDULE.find(
    (leg) => leg.renderer === "webgpu",
  );
  const ledger = validLeg(webgpu);
  ledger.gpu.samples.pop();
  ledger.gpu.results.frameCount = 599;
  ledger.gpu.summary = summarizeC1229S5DenseSamples(ledger.gpu.samples);
  assert.ok(
    validateC1229S5DenseRuntimeLeg(ledger, workload).structural.length > 0,
  );
  const drain = validLeg(webgpu);
  drain.gpu.drain.abandoned = 1;
  assert.ok(
    validateC1229S5DenseRuntimeLeg(drain, workload).structural.length > 0,
  );
  const cleanup = validLeg(webgpu);
  cleanup.cleanup.timestampProfilingRestored = false;
  assert.ok(
    validateC1229S5DenseRuntimeLeg(cleanup, workload).errors.length > 0,
  );
  const claimedFail = validLeg(C12_29_S5_DENSE_SCHEDULE[0]);
  claimedFail.status = "FAIL";
  assert.ok(
    validateC1229S5DenseRuntimeLeg(claimedFail, workload).behavioral.length > 0,
  );
});

test("30 child watchdog is bounded and success clears response timers before forced child exit", async () => {
  const publication = await import("./probe-c12-29-s5-dense-cost.mjs");
  const outcome = await publication.childProcessResult(
    ["-e", "setInterval(() => {}, 1000)"],
    100,
    1000,
  );
  assert.equal(outcome.timedOut, true);
  assert.match(String(outcome.signal), /SIGKILL|WATCHDOG|null/u);
  const probe = await readSource("probe-c12-29-s5-dense-cost.mjs");
  assert.match(probe, /clearTimeout\(entryTimeout\)/u);
  assert.match(probe, /process\.exit\(await runLegChild\(options\)\)/u);
  assert.match(probe, /postKillCloseTimeoutMs/u);
  assert.match(probe, /boundedAwait/u);
});

test("31 begin and pre-unlock publication boundaries preserve every late foreign authority", async () => {
  const publication = await import("./probe-c12-29-s5-dense-cost.mjs");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "c12-29-s5-dense-late-"));
  const operationProxy = (overrides) =>
    new Proxy(fs, {
      get(target, property) {
        return overrides[property] ?? Reflect.get(target, property);
      },
    });
  const injectAfterExclusiveClose = (file, inject) => {
    const exclusiveDescriptors = new Set();
    let injected = false;
    return {
      operations: operationProxy({
        openSync(candidate, flags, mode) {
          const descriptor = fs.openSync(candidate, flags, mode);
          if (
            resolve(candidate) === resolve(file) &&
            typeof flags === "number" &&
            (flags & fs.constants.O_EXCL) !== 0
          ) {
            exclusiveDescriptors.add(descriptor);
          }
          return descriptor;
        },
        closeSync(descriptor) {
          fs.closeSync(descriptor);
          if (!injected && exclusiveDescriptors.delete(descriptor)) {
            injected = true;
            inject();
          }
        },
      }),
      injected: () => injected,
    };
  };
  try {
    const beginRunId = "31313131-4242-4535-8646-575757575757";
    const beginPaths = publication.createC1229S5DenseArtifactPaths(
      join(temporaryRoot, "begin"),
      beginRunId,
    );
    const foreignBeginLock = Buffer.from("foreign begin lock\n");
    const foreignBeginLatest = Buffer.from("foreign begin latest\n");
    let beginInjected = false;
    const beginOperations = operationProxy({
      mkdirSync(file, options) {
        fs.mkdirSync(file, options);
        if (!beginInjected && file === beginPaths.rawDirectory) {
          beginInjected = true;
          fs.writeFileSync(beginPaths.lock, foreignBeginLock);
          fs.writeFileSync(beginPaths.latest, foreignBeginLatest);
        }
      },
    });
    assert.throws(
      () =>
        publication.beginC1229S5DenseRun(
          beginPaths,
          beginRunId,
          beginOperations,
        ),
      /persistence/u,
    );
    assert.equal(beginInjected, true);
    assert.deepEqual(await readFile(beginPaths.lock), foreignBeginLock);
    assert.deepEqual(await readFile(beginPaths.latest), foreignBeginLatest);

    const latestRunId = "41414141-5252-4636-8747-686868686868";
    const latestPaths = publication.createC1229S5DenseArtifactPaths(
      join(temporaryRoot, "latest-before-unlock"),
      latestRunId,
    );
    const latestStart = publication.beginC1229S5DenseRun(
      latestPaths,
      latestRunId,
    );
    const foreignLatest = Buffer.from("foreign latest before unlock\n");
    const latestInjection = injectAfterExclusiveClose(
      latestPaths.finalReceipt,
      () => fs.writeFileSync(latestPaths.latest, foreignLatest),
    );
    assert.throws(
      () =>
        publication.publishC1229S5DenseFinal(
          latestPaths,
          latestStart.publicationAuthority,
          { runId: latestRunId, status: "PASS" },
          latestInjection.operations,
        ),
      /persistence/u,
    );
    assert.equal(latestInjection.injected(), true);
    assert.deepEqual(await readFile(latestPaths.latest), foreignLatest);
    assert.deepEqual(await readFile(latestPaths.lock), latestStart.lockBytes);
    assert.ok((await readFile(latestPaths.immutable)).byteLength > 0);

    const redRunId = "51515151-6262-4737-8848-797979797979";
    const redPaths = publication.createC1229S5DenseArtifactPaths(
      join(temporaryRoot, "first-red-before-unlock"),
      redRunId,
    );
    const redStart = publication.beginC1229S5DenseRun(redPaths, redRunId);
    const foreignFirstRed = Buffer.from("foreign first-red before unlock\n");
    const redInjection = injectAfterExclusiveClose(redPaths.finalReceipt, () =>
      fs.writeFileSync(redPaths.firstRed, foreignFirstRed),
    );
    assert.throws(
      () =>
        publication.publishC1229S5DenseFinal(
          redPaths,
          redStart.publicationAuthority,
          { runId: redRunId, status: "ERROR" },
          redInjection.operations,
        ),
      /first-red.*(changed|bytes differ|authority)/u,
    );
    assert.equal(redInjection.injected(), true);
    assert.deepEqual(await readFile(redPaths.firstRed), foreignFirstRed);
    assert.deepEqual(await readFile(redPaths.latest), redStart.runningBytes);
    assert.deepEqual(await readFile(redPaths.lock), redStart.lockBytes);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("feature snapshot 1/3 pins every stable source default", () => {
  const mutations = [
    ["sunBloom", false],
    ["taaEnabled", true],
    ["motionBlur", true],
    ["msaaSamples", 1],
    ["postProcessStageCount", 1],
    ["fxaaEnabled", true],
    ["bloomEnabled", true],
  ];
  for (const [field, value] of mutations) {
    const leg = validLeg(C12_29_S5_DENSE_SCHEDULE[0]);
    leg.configuration.defaultFeatureSnapshot[field] = value;
    leg.configuration.defaultFeatureSnapshotEnd[field] = value;
    assert.ok(
      validateC1229S5DenseRuntimeLeg(leg, workload).structural.length > 0,
      field,
    );
  }
});

test("feature snapshot 2/3 requires a raw terminal snapshot", () => {
  const missing = validLeg(C12_29_S5_DENSE_SCHEDULE[0]);
  delete missing.configuration.defaultFeatureSnapshotEnd;
  assert.ok(
    validateC1229S5DenseRuntimeLeg(missing, workload).structural.length > 0,
  );
});

test("feature snapshot 3/3 recomputes retention despite a true claim", () => {
  const changed = validLeg(C12_29_S5_DENSE_SCHEDULE[0]);
  changed.configuration.defaultFeatureSnapshotEnd.highDynamicRange = true;
  changed.configuration.defaultFeaturesRetained = true;
  assert.ok(
    validateC1229S5DenseRuntimeLeg(changed, workload).structural.length > 0,
  );
});
