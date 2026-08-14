import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import test from "node:test";
import sharp from "sharp";
import {
  C12_33_CERTIFICATION_SCHEMA,
  C12_33_COUNTERBALANCED_CONTROL_ORDER,
  C12_33_REVIEW_FINDINGS,
  C12_33_REVIEW_SCHEMA,
  countThresholdValues,
  deriveC1233CalibratedThresholds,
  foldC1233MoonMipMotionEvidence,
  finalizeAndWriteC1233MoonMipMotion,
  loadPublishedMoonMipRun,
  loadReviewerAttestation,
  moonMipMetricBindingSha256,
  revalidateImmutableSnapshots,
  reviewerSourceBindings,
  validateRawMoonMipReport,
  validateReviewerAttestation,
} from "./lib/moon-mip-motion-certification.mjs";
import {
  analyzeRgbaFrame,
  cameraMotionSummary,
  computeParitySeries,
  computeTemporalSeries,
  FIXED_TIME_ISO,
  MOON_MIP_MOTION_LANES,
  PAIRED_SENSITIVITY_REQUIREMENTS,
  summarizeSpatial,
} from "./probe-moon-mip-motion-edge.mjs";

const REVIEWED_AT = "2026-08-02T00:00:00.000Z";
const FINALIZED_AT = "2026-08-02T00:01:00.000Z";
const INTEGRITY_CLAIMS = [
  "sourcePrePostStable",
  "repositoryPrePostStable",
  "activeLockAbsentAtPreflightAndPostflight",
  "runningOrIncompleteMarkerAbsent",
  "contentAddressedObjectsVerified",
  "contentAddressedObjectsAreReadOnly",
  "originalPathViewsAreIndependentCopies",
  "originalPathViewsAreReadOnly",
  "publicationNoClobber",
];

function hash(value) {
  return createHash("sha256")
    .update(
      typeof value === "string" || ArrayBuffer.isView(value)
        ? value
        : JSON.stringify(value),
    )
    .digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalHash(value) {
  return hash(canonicalJson(value));
}

function runtimeIdentity() {
  const adapterIdentity = {
    kind: "Apps/WebGPUTest/split-screen-comparison.html",
    loadedCesiumScriptUrl:
      "http://localhost:8080/Build/CesiumUnminified/Cesium.js",
    globalCesiumObjectPresent: true,
    globalMoonConstructorPresent: true,
    webglMoonUsesGlobalConstructor: true,
    webgpuMoonUsesGlobalConstructor: true,
    distinctMoonInstances: true,
    webglSceneUsesGlobalConstructor: true,
    webgpuSceneUsesGlobalConstructor: true,
  };
  const entries = {};
  for (const [id, label, path] of [
    [
      "adapter",
      "split-view-adapter",
      "Apps/WebGPUTest/split-screen-comparison.html",
    ],
    ["bundle", "cesium-global-bundle", "Build/CesiumUnminified/Cesium.js"],
    ["index", "cesium-module-index", "Build/CesiumUnminified/index.js"],
    [
      "moonAlbedo",
      "moon-albedo",
      "Build/CesiumUnminified/Assets/Textures/Moon/lroc_color_poles_2k.jpg",
    ],
    [
      "moonNormal",
      "moon-normal",
      "Build/CesiumUnminified/Assets/Textures/Moon/ldem_normal_1k.png",
    ],
  ]) {
    const sha256 = hash(id);
    entries[id] = {
      label,
      served: {
        url:
          id === "adapter"
            ? `http://localhost:8080/${path}?baseLayer=false`
            : `http://localhost:8080/${path}`,
        byteLength: 100 + id.length,
        sha256,
      },
      local: { path, byteLength: 100 + id.length, sha256 },
      servedMatchesLocal: true,
    };
  }
  return {
    schemaVersion: 1,
    entries,
    adapterIdentity,
    identitySha256: hash(JSON.stringify({ entries, adapterIdentity })),
  };
}

function expectedLocalDirection(lane, sampleIndex) {
  const fraction = sampleIndex / 12;
  const angle = lane.angularSweepRadians * (2 * fraction - 1);
  const [x, y] = lane.localCameraDirection;
  const rotated = [
    x * Math.cos(angle) - y * Math.sin(angle),
    x * Math.sin(angle) + y * Math.cos(angle),
    0,
  ];
  const magnitude = Math.hypot(...rotated);
  return rotated.map((component) => component / magnitude);
}

function backendDiagnostics(rendererType) {
  return {
    rendererType,
    frameNumber: 200,
    clockOffsetSeconds: 0,
    textureLoaded: true,
    normalLoaded: true,
    pipelineReady: true,
    mips: {
      albedo: {
        actualMipLevelCount: 12,
        expectedMipLevelCount: 12,
        fullChain: true,
      },
      normal: {
        actualMipLevelCount: 11,
        expectedMipLevelCount: 11,
        fullChain: true,
      },
    },
    pendingTextureMipJobs: 0,
  };
}

function cameraSample(lane, sampleIndex, backend) {
  const localDirection = expectedLocalDirection(lane, sampleIndex);
  const moonRadiusMeters = 10;
  const canvasHeight = 852;
  const fovyRadians = 0.8;
  const focalPixels = canvasHeight / (2 * Math.tan(fovyRadians * 0.5));
  const tangentDistance =
    (moonRadiusMeters * focalPixels) / (lane.targetDiscDiameterPx * 0.5);
  const centerDistanceMeters = Math.sqrt(
    moonRadiusMeters ** 2 + tangentDistance ** 2,
  );
  const cameraWorldPosition = localDirection.map(
    (component) => component * centerDistanceMeters,
  );
  const directionWC = localDirection.map((component) => -component);
  const upWC = [0, 0, 1];
  const rightWC = [directionWC[1], -directionWC[0], 0];
  return {
    frameNumberBefore: 99 + sampleIndex,
    frameNumber: 100 + sampleIndex,
    requestedCameraWorldPosition: [...cameraWorldPosition],
    requestedDirectionWC: [...directionWC],
    requestedUpWC: [...upWC],
    moonCenterWorld: [0, 0, 0],
    moonLocalToWorldBasis: {
      xWC: [1, 0, 0],
      yWC: [0, 1, 0],
      zWC: [0, 0, 1],
    },
    requestedCameraLocalDirection: localDirection,
    centerDistanceMeters,
    altitudeAboveMoonMeters: centerDistanceMeters - moonRadiusMeters,
    moonRadiusMeters,
    lightingFixture: "camera-coincident-directional-light",
    targetDiscDiameterPx: lane.targetDiscDiameterPx,
    canvasHeight,
    fovyRadians,
    cameraWorldPosition: [...cameraWorldPosition],
    directionWC: [...directionWC],
    rightWC: [...rightWC],
    upWC: [...upWC],
    cameraLocalDirection: localDirection,
    seamNormalDot: -localDirection[0],
    positionErrorMeters: 0,
    directionDotRequested: 1,
    upDotRequested: 1,
    directionToMoonDot: 1,
    basis: {
      directionMagnitude: 1,
      rightMagnitude: 1,
      upMagnitude: 1,
      directionRightDot: 0,
      directionUpDot: 0,
      rightUpDot: 0,
      handedness: 1,
    },
    clockOffsetSeconds: 0,
    postSyncStableFrameCount: 2,
    poseSource: "post-sync-camera-world-coordinates",
    backend,
  };
}

function syntheticReport(index, controlMode, value) {
  const runId = `c12-33-run-${String(index + 1).padStart(2, "0")}`;
  const lanes = MOON_MIP_MOTION_LANES.map((lane) => {
    const motion = Array.from({ length: 13 }, (_, sampleIndex) => ({
      webgl: cameraSample(lane, sampleIndex, "webgl"),
      webgpu: cameraSample(lane, sampleIndex, "webgpu"),
      backendPoseDelta: {
        positionMeters: 0,
        direction: 0,
        right: 0,
        up: 0,
      },
    }));
    const interiorPixels = lane.id === "minified-16px" ? 64 : 4096;
    const backends = {};
    for (const backend of ["webgl", "webgpu"]) {
      const spatialAmplitude = value * Math.sqrt(13 / 12);
      const spatialValues = Array.from({ length: 13 }, (_, sampleIndex) =>
        sampleIndex < 6
          ? 1 + spatialAmplitude
          : sampleIndex < 12
            ? 1 - spatialAmplitude
            : 1,
      );
      const spatialP95 = Math.max(...spatialValues);
      const frames = Array.from({ length: 13 }, (_, sampleIndex) => ({
        pngPath: `${runId}-frames/${lane.id}-${String(sampleIndex).padStart(2, "0")}-${backend}.png`,
        pngSha256: hash(`${runId}:${lane.id}:${sampleIndex}:${backend}`),
        width: 799,
        height: 852,
        coveredPixels: interiorPixels + 10,
        coveredFraction: 0.1,
        coveredMeanLuminance: 100,
        interiorPixels,
        meanInteriorLuminance: 100,
        gradientEnergy: 1,
        laplacianEnergy: 1,
        normalizedSpatialHighFrequency: spatialValues[sampleIndex],
        normalizedLaplacianEnergy: value,
        illuminatedBounds: { minX: 1, minY: 1, maxX: 20, maxY: 20 },
        discDiameterPx: lane.targetDiscDiameterPx,
      }));
      const pairs = Array.from({ length: 12 }, () => ({
        comparedPixels: interiorPixels,
        meanAbsoluteLumaDelta: value,
        p95AbsoluteLumaDelta: value,
        normalizedMeanAbsoluteLumaDelta: value,
        meanHighPassDelta: value,
        normalizedMeanHighPassDelta: value,
      }));
      backends[backend] = {
        captureKind: "playwright-canvas-element-png",
        canvasSelector:
          backend === "webgl" ? "#leftViewer canvas" : "#rightViewer canvas",
        frames,
        spatial: {
          discDiameterPxMedian: lane.targetDiscDiameterPx,
          discDiameterPxMin: lane.targetDiscDiameterPx,
          discDiameterPxMax: lane.targetDiscDiameterPx,
          normalizedSpatialHighFrequencyMean: 1,
          normalizedSpatialHighFrequencyP95: spatialP95,
          normalizedLaplacianEnergyMean: value,
          normalizedLaplacianEnergyP95: value,
        },
        temporal: {
          pairCount: 12,
          comparedPixelsMin: interiorPixels,
          meanAbsoluteLumaDelta: value,
          p95PairMeanAbsoluteLumaDelta: value,
          normalizedMeanAbsoluteLumaDelta: value,
          normalizedP95PairLumaDelta: value,
          normalizedMeanHighPassDelta: value,
          normalizedP95HighPassDelta: value,
          spatialHighFrequencyMean: 1,
          spatialHighFrequencyP95: spatialP95,
          spatialHighFrequencyCoefficientOfVariation: value,
          pairs,
        },
      };
    }
    return {
      ...lane,
      motion,
      motionSummary: {
        webgl: cameraMotionSummary(motion, "webgl"),
        webgpu: cameraMotionSummary(motion, "webgpu"),
      },
      backends,
      parity: {
        sampleCount: 13,
        comparedPixelsMin: interiorPixels,
        maskIntersectionOverUnionMean: 1 - value / 10,
        meanAbsoluteRgbError: value,
        meanAbsoluteLumaError: value,
        normalizedMeanAbsoluteLumaError: value,
        normalizedP95AbsoluteLumaError: value,
        changedPixelFractionMean: value,
        spatialHighFrequencyRatioMean: 1,
        samples: Array.from({ length: 13 }, () => ({
          comparedPixels: interiorPixels,
          maskIntersectionOverUnion: 1 - value / 10,
          meanAbsoluteRgbError: value,
          meanAbsoluteLumaError: value,
          normalizedMeanAbsoluteLumaError: value,
          changedPixelFraction: value,
          spatialHighFrequencyRatio: 1,
        })),
      },
    };
  });
  const identity = runtimeIdentity();
  const adapterIdentity = identity.adapterIdentity;
  return {
    schemaVersion: 1,
    campaign: "C12-33",
    probe: "probe-moon-mip-motion-edge",
    runId,
    capturedAt: new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString(),
    status: "NON_CERTIFYING",
    exitCode: 2,
    certificationEligible: false,
    controlMode,
    viewerUrl:
      "http://localhost:8080/Apps/WebGPUTest/split-screen-comparison.html?baseLayer=false",
    fixedTimeIso: FIXED_TIME_ISO,
    sampleCount: 13,
    browser: { channel: "msedge", version: "140.0.0.0", headed: false },
    runtimeIdentity: identity,
    setup: {
      fixedTimeIso: FIXED_TIME_ISO,
      albedoUrl:
        "http://localhost:8080/Build/CesiumUnminified/Assets/Textures/Moon/lroc_color_poles_2k.jpg",
      normalUrl:
        "http://localhost:8080/Build/CesiumUnminified/Assets/Textures/Moon/ldem_normal_1k.png",
      lightingFixture: "camera-coincident-directional-light",
      sameJavaScriptRealm: true,
      adapterIdentity,
    },
    readiness: {
      ready: true,
      elapsedWallClockMs: 100,
      diagnostics: {
        webgl: backendDiagnostics("webgl"),
        webgpu: backendDiagnostics("webgpu"),
      },
    },
    control:
      controlMode === "normal"
        ? {
            requestedMode: "normal",
            appliedMode: "normal",
            webgl: { baseLevelOnly: false },
            webgpu: { baseLevelOnly: false, bindGroupRebuilt: false },
          }
        : {
            requestedMode: "force-lod0",
            appliedMode: "force-lod0",
            webgl: { baseLevelOnly: true },
            webgpu: { baseLevelOnly: true, bindGroupRebuilt: true },
          },
    webglShaderCompile: {
      colorProgramReady: true,
      pickProgramReady: true,
      colorDefines: [
        "LUNAR_EXPLICIT_GRADIENTS",
        "LUNAR_ALBEDO_EXPLICIT_GRADIENTS",
        "LUNAR_NORMAL_EXPLICIT_GRADIENTS",
      ],
      pickDefines: [
        "LUNAR_EXPLICIT_GRADIENTS",
        "LUNAR_ALBEDO_EXPLICIT_GRADIENTS",
      ],
      pickedProbeId: true,
    },
    lanes,
    spatialScale: {},
    finalDiagnostics: {
      webgl: backendDiagnostics("webgl"),
      webgpu: backendDiagnostics("webgpu"),
    },
    gpuDrain: { completed: true, pendingTextureMipJobs: 0 },
    gpuGateArm: { total: 1 },
    gpuGate: { errors: [], deviceLost: null },
    gpuConsoleFaults: [],
    pageErrors: [],
    consoleMessages: [],
    requestFailures: [],
    calibratedThresholds: null,
    manualInspection: {
      required: true,
      status: "PENDING",
      requiredLaneIds: ["seam-centered", "seam-at-limb"],
      checks: ["center", "limb", "parity"],
      evidence: [],
    },
    result: {
      verdict: "INCONCLUSIVE",
      exitCode: 2,
      failures: [],
      inconclusive: ["offline calibration required"],
      hardFailures: [],
      qualityFailures: [],
    },
    measurementStatus: "CALIBRATION_PENDING",
  };
}

function refreshSource(source) {
  const reportBytes = `${JSON.stringify(source.report, null, 2)}\n`;
  source.reportByteLength = Buffer.byteLength(reportBytes);
  source.reportSha256 = hash(reportBytes);
  const reportEntry = source.manifest.files.find(
    (entry) => entry.originalPath === source.reportOriginalPath,
  );
  reportEntry.byteLength = source.reportByteLength;
  reportEntry.sha256 = source.reportSha256;
  reportEntry.objectPath = `objects/sha256/${source.reportSha256.slice(0, 2)}/${source.reportSha256}`;
  reportEntry.sourcePre = captureIdentity(
    source.reportSha256,
    source.reportByteLength,
    1,
  );
  reportEntry.sourcePost = { ...reportEntry.sourcePre };
  source.reportRole = reportEntry.role;
  source.reportMediaType = reportEntry.mediaType;
  source.reportObjectPath = reportEntry.objectPath;
  source.reportViewPath = reportEntry.viewPath;
  source.manifest.runId = source.report.runId;
  source.manifest.result = {
    status: source.report.status,
    exitCode: source.report.exitCode,
    certificationEligible: source.report.certificationEligible,
  };
  source.reportCanonicalSha256 = canonicalHash(source.report);
  source.metricBinding = {
    schema: "cesium-c12-33-moon-mip-png-metric-binding/v1",
    sha256: moonMipMetricBindingSha256(source.report),
  };
  source.manifestCanonicalSha256 = canonicalHash(source.manifest);
  const manifestBytes = `${JSON.stringify(source.manifest, null, 2)}\n`;
  source.manifestByteLength = Buffer.byteLength(manifestBytes);
  source.manifestSha256 = hash(manifestBytes);
}

function captureIdentity(sha256, byteLength, inode) {
  return {
    byteLength,
    sha256,
    modifiedMs: 1_000 + inode,
    changedMs: 2_000 + inode,
    device: 1,
    inode,
  };
}

function syntheticSource(index, controlMode, value) {
  const report = syntheticReport(index, controlMode, value);
  const reportOriginalPath = `Tools/visual-regression/output/c12-33/${report.runId}.json`;
  const reportDirectory = posix.dirname(reportOriginalPath);
  const pngs = report.lanes
    .flatMap((lane) =>
      ["webgl", "webgpu"].flatMap((backend) =>
        lane.backends[backend].frames.map((frame) => ({
          originalPath: posix.join(reportDirectory, frame.pngPath),
          role: "file",
          mediaType: "image/png",
          objectPath: `objects/sha256/${frame.pngSha256.slice(0, 2)}/${frame.pngSha256}`,
          viewPath: `files/${posix.join(reportDirectory, frame.pngPath)}`,
          byteLength: 32,
          sha256: frame.pngSha256,
        })),
      ),
    )
    .sort((left, right) => left.originalPath.localeCompare(right.originalPath));
  const repositorySnapshot = {
    capturedAt: "2026-08-01T00:00:00.000Z",
    head: "1234567890abcdef1234567890abcdef12345678",
    branch: null,
    detached: true,
    dirty: false,
    statusByteLength: 0,
    statusSha256: hash(""),
    statusTokenCount: 0,
  };
  const manifest = {
    schema: "cesium-visual-evidence-publication/v2",
    schemaVersion: 2,
    kind: "run",
    namespace: null,
    producer: "c12-33-moon-mip-motion",
    runId: report.runId,
    publicationPath: `runs/c12-33-moon-mip-motion/${report.runId}`,
    publishedAt: new Date(Date.UTC(2026, 7, 1, 1, index)).toISOString(),
    result: {
      status: "NON_CERTIFYING",
      exitCode: 2,
      certificationEligible: false,
    },
    invocation: { command: null },
    legacyImport: null,
    upgradedFrom: null,
    source: {
      worktreeLabel: "cesium-webgpu",
      guardPath: ".",
      repository: {
        pre: repositorySnapshot,
        post: { ...repositorySnapshot, capturedAt: "2026-08-01T00:00:01.000Z" },
        stable: true,
      },
    },
    integrity: Object.fromEntries(
      INTEGRITY_CLAIMS.map((claim) => [claim, true]),
    ),
    files: [
      {
        originalPath: reportOriginalPath,
        role: "artifact",
        mediaType: "application/json",
        objectPath: `objects/sha256/${hash("pending").slice(0, 2)}/${hash("pending")}`,
        viewPath: `files/${reportOriginalPath}`,
        byteLength: 1,
        sha256: hash("pending"),
        sourcePre: captureIdentity(hash("pending"), 1, 1),
        sourcePost: captureIdentity(hash("pending"), 1, 1),
      },
      ...pngs.map((png, index) => ({
        ...png,
        sourcePre: captureIdentity(png.sha256, png.byteLength, index + 2),
        sourcePost: captureIdentity(png.sha256, png.byteLength, index + 2),
      })),
    ],
  };
  const source = {
    manifestPath: `C:/evidence/${report.runId}/manifest.json`,
    manifest,
    manifestSha256: hash("pending-manifest"),
    report,
    reportOriginalPath,
    reportRole: "artifact",
    reportMediaType: "application/json",
    reportObjectPath: "pending",
    reportViewPath: `files/${reportOriginalPath}`,
    reportByteLength: 1,
    reportSha256: hash("pending-report"),
    pngs,
    publicationVerified: true,
  };
  refreshSource(source);
  return source;
}

function syntheticSources() {
  return C12_33_COUNTERBALANCED_CONTROL_ORDER.map((controlMode, index) =>
    syntheticSource(index, controlMode, controlMode === "normal" ? 0.2 : 0.6),
  );
}

function reviewerAttestation(sources, overrides = {}) {
  const document = {
    schema: C12_33_REVIEW_SCHEMA,
    schemaVersion: 1,
    campaign: "C12-33",
    reviewer: { identity: "independent-reviewer" },
    reviewedAt: REVIEWED_AT,
    verdict: "PASS",
    findings: C12_33_REVIEW_FINDINGS.map((id) => ({
      id,
      verdict: "PASS",
      notes: `reviewed ${id} without resampling`,
    })),
    sources: reviewerSourceBindings(sources),
    ...overrides,
  };
  const bytes = `${JSON.stringify(document, null, 2)}\n`;
  return {
    path: "C:/review/attestation.json",
    byteLength: Buffer.byteLength(bytes),
    sha256: hash(bytes),
    documentCanonicalSha256: canonicalHash(document),
    document,
  };
}

function fold(sources, attestation = reviewerAttestation(sources)) {
  return foldC1233MoonMipMotionEvidence({
    sources,
    reviewerAttestation: attestation,
    finalizedAt: FINALIZED_AT,
  });
}

function fixtureMean(values) {
  return values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function fixturePercentile(values, fraction) {
  if (values.length === 0) {
    return null;
  }
  const ordered = values.slice().sort((left, right) => left - right);
  return ordered[
    Math.min(
      ordered.length - 1,
      Math.max(0, Math.ceil(fraction * ordered.length) - 1),
    )
  ];
}

function fixtureStandardDeviation(values, average = fixtureMean(values)) {
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
      values.length,
  );
}

function fixturePublicFrame(decoded, pngPath, bytes) {
  const rounded = (value) => Number(value.toFixed(6));
  return {
    pngPath,
    pngSha256: hash(bytes),
    width: decoded.width,
    height: decoded.height,
    coveredPixels: decoded.coveredPixels,
    coveredFraction: rounded(decoded.coveredFraction),
    coveredMeanLuminance: rounded(decoded.coveredMeanLuminance),
    interiorPixels: decoded.interiorPixels,
    meanInteriorLuminance: rounded(decoded.meanInteriorLuminance),
    gradientEnergy: rounded(decoded.gradientEnergy),
    laplacianEnergy: rounded(decoded.laplacianEnergy),
    normalizedSpatialHighFrequency: rounded(
      decoded.normalizedSpatialHighFrequency,
    ),
    normalizedLaplacianEnergy: rounded(decoded.normalizedLaplacianEnergy),
    illuminatedBounds: decoded.illuminatedBounds,
    discDiameterPx: decoded.discDiameterPx,
  };
}

function fixtureTemporalSummary(frames, pairs) {
  const meanDeltas = pairs.map((pair) => pair.meanAbsoluteLumaDelta);
  const normalizedDeltas = pairs.map(
    (pair) => pair.normalizedMeanAbsoluteLumaDelta,
  );
  const normalizedHighPass = pairs.map(
    (pair) => pair.normalizedMeanHighPassDelta,
  );
  const spatialValues = frames.map(
    (frame) => frame.normalizedSpatialHighFrequency,
  );
  const spatialMean = fixtureMean(spatialValues) ?? 0;
  return {
    pairCount: pairs.length,
    comparedPixelsMin: Math.min(...pairs.map((pair) => pair.comparedPixels)),
    meanAbsoluteLumaDelta: fixtureMean(meanDeltas) ?? 0,
    p95PairMeanAbsoluteLumaDelta: fixturePercentile(meanDeltas, 0.95) ?? 0,
    normalizedMeanAbsoluteLumaDelta: fixtureMean(normalizedDeltas) ?? 0,
    normalizedP95PairLumaDelta: fixturePercentile(normalizedDeltas, 0.95) ?? 0,
    normalizedMeanHighPassDelta: fixtureMean(normalizedHighPass) ?? 0,
    normalizedP95HighPassDelta:
      fixturePercentile(normalizedHighPass, 0.95) ?? 0,
    spatialHighFrequencyMean: spatialMean,
    spatialHighFrequencyP95: fixturePercentile(spatialValues, 0.95) ?? 0,
    spatialHighFrequencyCoefficientOfVariation:
      fixtureStandardDeviation(spatialValues, spatialMean) /
      Math.max(1e-9, spatialMean),
  };
}

function fixtureParitySummary(samples) {
  const keyMean = (key) =>
    fixtureMean(samples.map((sample) => sample[key])) ?? 0;
  return {
    sampleCount: samples.length,
    comparedPixelsMin: Math.min(
      ...samples.map((sample) => sample.comparedPixels),
    ),
    maskIntersectionOverUnionMean: keyMean("maskIntersectionOverUnion"),
    meanAbsoluteRgbError: keyMean("meanAbsoluteRgbError"),
    meanAbsoluteLumaError: keyMean("meanAbsoluteLumaError"),
    normalizedMeanAbsoluteLumaError: keyMean("normalizedMeanAbsoluteLumaError"),
    normalizedP95AbsoluteLumaError:
      fixturePercentile(
        samples.map((sample) => sample.normalizedMeanAbsoluteLumaError),
        0.95,
      ) ?? 0,
    changedPixelFractionMean: keyMean("changedPixelFraction"),
    spatialHighFrequencyRatioMean: keyMean("spatialHighFrequencyRatio"),
  };
}

const fixtureImageCache = new Map();

async function fixtureImage(controlMode, lane, sampleIndex) {
  const variant =
    controlMode === "force-lod0" && lane.id === "minified-16px"
      ? sampleIndex % 2 === 0
        ? "control-checker"
        : "control-flat"
      : "stable-checker";
  const key = `${lane.id}:${variant}`;
  if (!fixtureImageCache.has(key)) {
    fixtureImageCache.set(
      key,
      (async () => {
        const minified = lane.id === "minified-16px";
        const width = minified ? 32 : 256;
        const height = width;
        const diameter = minified ? 16 : 200;
        const start = Math.floor((width - diameter) * 0.5);
        const data = Buffer.alloc(width * height * 4);
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const offset = (y * width + x) * 4;
            const covered =
              x >= start &&
              x < start + diameter &&
              y >= start &&
              y < start + diameter;
            let value = 0;
            if (covered) {
              value =
                variant === "control-flat"
                  ? 130
                  : (x + y) % 2 === 0
                    ? variant === "control-checker"
                      ? 230
                      : 175
                    : variant === "control-checker"
                      ? 40
                      : 95;
            }
            data[offset] = value;
            data[offset + 1] = value;
            data[offset + 2] = value;
            data[offset + 3] = 255;
          }
        }
        const decoded = analyzeRgbaFrame({ data, width, height });
        const bytes = await sharp(data, {
          raw: { width, height, channels: 4 },
        })
          .png({ compressionLevel: 1 })
          .toBuffer();
        return { bytes, decoded };
      })(),
    );
  }
  return fixtureImageCache.get(key);
}

async function bindFixturePngMetrics(source) {
  const reportDirectory = posix.dirname(source.reportOriginalPath);
  const bytesByOriginalPath = new Map();
  for (const lane of source.report.lanes) {
    const rawFrames = { webgl: [], webgpu: [] };
    const publicFrames = { webgl: [], webgpu: [] };
    for (const backend of ["webgl", "webgpu"]) {
      for (let sampleIndex = 0; sampleIndex < 13; sampleIndex++) {
        const { bytes, decoded } = await fixtureImage(
          source.report.controlMode,
          lane,
          sampleIndex,
        );
        const pngPath = lane.backends[backend].frames[sampleIndex].pngPath;
        const frame = fixturePublicFrame(decoded, pngPath, bytes);
        rawFrames[backend].push(decoded);
        publicFrames[backend].push(frame);
        bytesByOriginalPath.set(posix.join(reportDirectory, pngPath), bytes);
      }
      const temporal = computeTemporalSeries(rawFrames[backend]);
      Object.assign(
        temporal,
        fixtureTemporalSummary(publicFrames[backend], temporal.pairs),
      );
      Object.assign(lane.backends[backend], {
        frames: publicFrames[backend],
        spatial: summarizeSpatial(publicFrames[backend]),
        temporal,
      });
    }
    const parity = computeParitySeries(rawFrames.webgl, rawFrames.webgpu);
    parity.samples.forEach((sample, sampleIndex) => {
      sample.spatialHighFrequencyRatio =
        publicFrames.webgpu[sampleIndex].normalizedSpatialHighFrequency /
        Math.max(
          1e-9,
          publicFrames.webgl[sampleIndex].normalizedSpatialHighFrequency,
        );
    });
    Object.assign(parity, fixtureParitySummary(parity.samples));
    lane.parity = parity;
  }
  return bytesByOriginalPath;
}

async function writeObjectIfAbsent(path, bytes) {
  await mkdir(join(path, ".."), { recursive: true });
  try {
    const existing = await readFile(path);
    assert.equal(hash(existing), hash(bytes));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    await writeFile(path, bytes);
    await chmod(path, 0o444);
  }
}

async function writePublishedFixture(
  root,
  {
    index = 0,
    controlMode = "normal",
    corruptFirstPng = false,
    mutateReport,
  } = {},
) {
  const source = syntheticSource(
    index,
    controlMode,
    controlMode === "normal" ? 0.2 : 0.6,
  );
  const bytesByOriginalPath = await bindFixturePngMetrics(source);
  if (corruptFirstPng) {
    bytesByOriginalPath.set(
      source.pngs[0].originalPath,
      Buffer.from("not-a-png", "utf8"),
    );
  }
  mutateReport?.(source.report);
  const publicationDirectory = join(
    root,
    ...source.manifest.publicationPath.split("/"),
  );
  await mkdir(publicationDirectory, { recursive: true });
  const frameByOriginalPath = new Map();
  const reportDirectory = posix.dirname(source.reportOriginalPath);
  for (const lane of source.report.lanes) {
    for (const backend of ["webgl", "webgpu"]) {
      for (const frame of lane.backends[backend].frames) {
        frameByOriginalPath.set(
          posix.join(reportDirectory, frame.pngPath),
          frame,
        );
      }
    }
  }
  for (let index = 0; index < source.pngs.length; index++) {
    const png = source.pngs[index];
    const bytes = bytesByOriginalPath.get(png.originalPath);
    assert.ok(bytes, `missing fixture bytes for ${png.originalPath}`);
    png.byteLength = bytes.byteLength;
    png.sha256 = hash(bytes);
    frameByOriginalPath.get(png.originalPath).pngSha256 = png.sha256;
    const manifestEntry = source.manifest.files.find(
      (entry) => entry.originalPath === png.originalPath,
    );
    manifestEntry.byteLength = png.byteLength;
    manifestEntry.sha256 = png.sha256;
    manifestEntry.objectPath = `objects/sha256/${png.sha256.slice(0, 2)}/${png.sha256}`;
    manifestEntry.sourcePre = captureIdentity(
      png.sha256,
      png.byteLength,
      index + 2,
    );
    manifestEntry.sourcePost = { ...manifestEntry.sourcePre };
    Object.assign(png, {
      role: manifestEntry.role,
      mediaType: manifestEntry.mediaType,
      objectPath: manifestEntry.objectPath,
      viewPath: manifestEntry.viewPath,
      byteLength: manifestEntry.byteLength,
      sha256: manifestEntry.sha256,
    });
    const viewPath = join(
      publicationDirectory,
      ...manifestEntry.viewPath.split("/"),
    );
    const objectPath = join(root, ...manifestEntry.objectPath.split("/"));
    await mkdir(join(viewPath, ".."), { recursive: true });
    await mkdir(join(objectPath, ".."), { recursive: true });
    await writeFile(viewPath, bytes);
    await writeObjectIfAbsent(objectPath, bytes);
    await chmod(viewPath, 0o444);
  }
  refreshSource(source);
  const reportEntry = source.manifest.files.find(
    (entry) => entry.originalPath === source.reportOriginalPath,
  );
  const reportBytes = `${JSON.stringify(source.report, null, 2)}\n`;
  const reportViewPath = join(
    publicationDirectory,
    ...reportEntry.viewPath.split("/"),
  );
  const reportObjectPath = join(root, ...reportEntry.objectPath.split("/"));
  await mkdir(join(reportViewPath, ".."), { recursive: true });
  await mkdir(join(reportObjectPath, ".."), { recursive: true });
  await writeFile(reportViewPath, reportBytes);
  await writeObjectIfAbsent(reportObjectPath, Buffer.from(reportBytes));
  await chmod(reportViewPath, 0o444);
  const manifestBytes = `${JSON.stringify(source.manifest, null, 2)}\n`;
  const manifestPath = join(publicationDirectory, "manifest.json");
  await writeFile(manifestPath, manifestBytes);
  const sidecarPath = join(publicationDirectory, "manifest.sha256");
  await writeFile(sidecarPath, `${hash(manifestBytes)}\n`);
  await chmod(manifestPath, 0o444);
  await chmod(sidecarPath, 0o444);
  return {
    root,
    manifestPath,
    sidecarPath,
    publicationDirectory,
    firstPngPath: join(
      publicationDirectory,
      ...source.manifest.files[1].viewPath.split("/"),
    ),
    firstObjectPath: join(
      root,
      ...source.manifest.files[1].objectPath.split("/"),
    ),
    source,
  };
}

test("raw synthetic fixture satisfies the complete structural contract", () => {
  const source = syntheticSources()[0];
  assert.deepEqual(validateRawMoonMipReport(source.report), []);
  assert.equal(source.report.lanes.length, 4);
  assert.equal(
    source.report.lanes.flatMap((lane) =>
      ["webgl", "webgpu"].flatMap((backend) => lane.backends[backend].frames),
    ).length,
    104,
  );
});

test("publication loader verifies manifest sidecar and every report/PNG byte", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "c12-33-publication-"));
  const root = join(workspace, "evidence");
  await mkdir(root);
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const fixture = await writePublishedFixture(root);
  const loaded = await loadPublishedMoonMipRun(fixture.manifestPath);
  assert.equal(loaded.publicationVerified, true);
  assert.equal(loaded.report.status, "NON_CERTIFYING");
  assert.equal(loaded.pngs.length, 104);

  const reviewPath = join(workspace, "immutable-review.json");
  const reviewDocument = {
    schema: C12_33_REVIEW_SCHEMA,
    schemaVersion: 1,
    campaign: "C12-33",
    reviewer: { identity: "independent-reviewer" },
    reviewedAt: REVIEWED_AT,
    verdict: "PASS",
    findings: C12_33_REVIEW_FINDINGS.map((id) => ({
      id,
      verdict: "PASS",
      notes: `reviewed ${id}`,
    })),
    sources: reviewerSourceBindings([loaded]),
  };
  await writeFile(reviewPath, `${JSON.stringify(reviewDocument, null, 2)}\n`);
  await chmod(reviewPath, 0o444);
  const loadedReview = await loadReviewerAttestation(reviewPath);
  assert.deepEqual(
    validateReviewerAttestation(
      loadedReview,
      reviewerSourceBindings([loaded]),
      {
        latestPublicationAt: loaded.manifest.publishedAt,
        finalizedAt: FINALIZED_AT,
      },
    ),
    [],
  );

  const tenSourceReviewPath = join(workspace, "ten-source-review.json");
  const tenSourceReview = {
    ...reviewDocument,
    sources: reviewerSourceBindings(Array(10).fill(loaded)),
  };
  await writeFile(
    tenSourceReviewPath,
    `${JSON.stringify(tenSourceReview, null, 2)}\n`,
  );
  await chmod(tenSourceReviewPath, 0o444);
  const structuralOutputPath = join(workspace, "structural-final.json");
  const written = await finalizeAndWriteC1233MoonMipMotion({
    outputPath: structuralOutputPath,
    manifestPaths: Array(10).fill(fixture.manifestPath),
    reviewerAttestationPath: tenSourceReviewPath,
    finalizedAt: FINALIZED_AT,
  });
  assert.equal(written.status, "STRUCTURAL");
  assert.equal(
    JSON.parse(await readFile(structuralOutputPath, "utf8")).status,
    "STRUCTURAL",
  );
  await assert.rejects(
    () =>
      finalizeAndWriteC1233MoonMipMotion({
        outputPath: structuralOutputPath,
        manifestPaths: Array(10).fill(fixture.manifestPath),
        reviewerAttestationPath: tenSourceReviewPath,
        finalizedAt: FINALIZED_AT,
      }),
    /already exists/,
  );

  const originalPngBytes = await readFile(fixture.firstPngPath);
  await chmod(fixture.firstPngPath, 0o644);
  await writeFile(fixture.firstPngPath, "mutated-after-publication");
  await assert.rejects(
    () => revalidateImmutableSnapshots(loaded.immutableSnapshots),
    /immutable input changed before PASS/,
  );
  await chmod(reviewPath, 0o644);
  await writeFile(reviewPath, "{}\n");
  await assert.rejects(
    () => revalidateImmutableSnapshots(loadedReview.immutableSnapshots),
    /immutable input changed before PASS/,
  );
  await assert.rejects(
    () => loadPublishedMoonMipRun(fixture.manifestPath),
    /writable|publication file bytes disagree with manifest/,
  );
  await writeFile(fixture.firstPngPath, originalPngBytes);
  await chmod(fixture.firstPngPath, 0o444);

  await chmod(fixture.firstPngPath, 0o644);
  await unlink(fixture.firstPngPath);
  await link(fixture.firstObjectPath, fixture.firstPngPath);
  await assert.rejects(
    () => loadPublishedMoonMipRun(fixture.manifestPath),
    /hardlinks|not independent/,
  );
  await chmod(fixture.firstPngPath, 0o644);
  await unlink(fixture.firstPngPath);
  await chmod(fixture.firstObjectPath, 0o444);
  await writeFile(fixture.firstPngPath, originalPngBytes);
  await chmod(fixture.firstPngPath, 0o444);

  try {
    await chmod(fixture.firstPngPath, 0o644);
    await unlink(fixture.firstPngPath);
    await symlink(fixture.firstObjectPath, fixture.firstPngPath, "file");
    await assert.rejects(
      () => loadPublishedMoonMipRun(fixture.manifestPath),
      /symbolic|symlink/,
    );
    await unlink(fixture.firstPngPath);
    await writeFile(fixture.firstPngPath, originalPngBytes);
    await chmod(fixture.firstPngPath, 0o444);
  } catch (error) {
    if (error?.code !== "EPERM") {
      throw error;
    }
    t.diagnostic("file symlink creation is not permitted on this host");
    await writeFile(fixture.firstPngPath, originalPngBytes);
    await chmod(fixture.firstPngPath, 0o444);
  }

  for (const outputPath of [
    fixture.manifestPath,
    reviewPath,
    join(fixture.publicationDirectory, "nested", "final.json"),
    root,
    join(root, "runs"),
    join(root, "objects"),
  ]) {
    await assert.rejects(
      () =>
        finalizeAndWriteC1233MoonMipMotion({
          outputPath,
          manifestPaths: Array(10).fill(fixture.manifestPath),
          reviewerAttestationPath: reviewPath,
        }),
      /overlaps immutable input\/publication/,
    );
  }

  const addedFile = join(fixture.publicationDirectory, "unmanifested.bin");
  await writeFile(addedFile, "unexpected");
  await assert.rejects(
    () => loadPublishedMoonMipRun(fixture.manifestPath),
    /missing\/unmanifested files/,
  );
  await rm(addedFile);

  const addedDirectory = join(fixture.publicationDirectory, "unmanifested");
  await mkdir(addedDirectory);
  await assert.rejects(
    () => loadPublishedMoonMipRun(fixture.manifestPath),
    /missing\/unmanifested files/,
  );
  await rm(addedDirectory, { recursive: true });

  try {
    const addedSymlink = join(
      fixture.publicationDirectory,
      "unmanifested-link",
    );
    await symlink(fixture.firstPngPath, addedSymlink, "file");
    await assert.rejects(
      () => loadPublishedMoonMipRun(fixture.manifestPath),
      /publication tree contains a symlink/,
    );
    await unlink(addedSymlink);
  } catch (error) {
    if (error?.code !== "EPERM") {
      throw error;
    }
    t.diagnostic("added symlink creation is not permitted on this host");
  }

  const aliasManifest = JSON.parse(
    await readFile(fixture.manifestPath, "utf8"),
  );
  aliasManifest.files[1].viewPath = aliasManifest.files[2].viewPath;
  const aliasManifestBytes = `${JSON.stringify(aliasManifest, null, 2)}\n`;
  await chmod(fixture.manifestPath, 0o644);
  await chmod(fixture.sidecarPath, 0o644);
  await writeFile(fixture.manifestPath, aliasManifestBytes);
  await writeFile(fixture.sidecarPath, `${hash(aliasManifestBytes)}\n`);
  await chmod(fixture.manifestPath, 0o444);
  await chmod(fixture.sidecarPath, 0o444);
  await assert.rejects(
    () => loadPublishedMoonMipRun(fixture.manifestPath),
    /path\/media\/source identity is invalid/,
  );
});

test("published bytes are real PNGs and decoded primitives defeat coordinated report forgery", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "c12-33-pixel-binding-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));

  const nonPngRoot = join(workspace, "non-png-library");
  await mkdir(nonPngRoot);
  const nonPng = await writePublishedFixture(nonPngRoot, {
    corruptFirstPng: true,
  });
  await assert.rejects(
    () => loadPublishedMoonMipRun(nonPng.manifestPath),
    /non-PNG signature/,
  );

  const forgedRoot = join(workspace, "forged-library");
  await mkdir(forgedRoot);
  const forged = await writePublishedFixture(forgedRoot, {
    mutateReport(report) {
      const backend = report.lanes.find((lane) => lane.id === "minified-16px")
        .backends.webgpu;
      for (const frame of backend.frames) {
        frame.normalizedSpatialHighFrequency += 0.25;
        frame.normalizedLaplacianEnergy += 0.25;
      }
      backend.spatial = summarizeSpatial(backend.frames);
      for (const pair of backend.temporal.pairs) {
        pair.meanHighPassDelta += 10;
        pair.normalizedMeanHighPassDelta += 0.25;
      }
      Object.assign(
        backend.temporal,
        fixtureTemporalSummary(backend.frames, backend.temporal.pairs),
      );
      const lane = report.lanes.find(
        (candidate) => candidate.id === "minified-16px",
      );
      lane.parity.samples.forEach((sample, sampleIndex) => {
        sample.spatialHighFrequencyRatio =
          lane.backends.webgpu.frames[sampleIndex]
            .normalizedSpatialHighFrequency /
          Math.max(
            1e-9,
            lane.backends.webgl.frames[sampleIndex]
              .normalizedSpatialHighFrequency,
          );
      });
      Object.assign(lane.parity, fixtureParitySummary(lane.parity.samples));
    },
  });
  await assert.rejects(
    () => loadPublishedMoonMipRun(forged.manifestPath),
    /metric primitives disagree with decoded pixels/,
  );
});

test(
  "path-backed certification reloads, refolds, topology-checks, and atomically commits PASS",
  { timeout: 300_000 },
  async (t) => {
    const workspace = await mkdtemp(join(tmpdir(), "c12-33-path-pass-"));
    const evidenceRoot = join(workspace, "evidence-library");
    const outputDirectory = join(workspace, "certification-output");
    await mkdir(evidenceRoot);
    t.after(() => rm(workspace, { recursive: true, force: true }));

    const fixtures = [];
    for (
      let index = 0;
      index < C12_33_COUNTERBALANCED_CONTROL_ORDER.length;
      index++
    ) {
      fixtures.push(
        await writePublishedFixture(evidenceRoot, {
          index,
          controlMode: C12_33_COUNTERBALANCED_CONTROL_ORDER[index],
        }),
      );
    }
    const sources = fixtures.map((fixture) => fixture.source);
    const reviewDocument = reviewerAttestation(sources).document;
    const reviewPath = join(workspace, "independent-review.json");
    await writeFile(reviewPath, `${JSON.stringify(reviewDocument, null, 2)}\n`);
    await chmod(reviewPath, 0o444);

    const outputPath = join(outputDirectory, "c12-33-final.json");
    let finalRevalidationHookCount = 0;
    const artifact = await finalizeAndWriteC1233MoonMipMotion({
      outputPath,
      manifestPaths: fixtures.map((fixture) => fixture.manifestPath),
      reviewerAttestationPath: reviewPath,
      finalizedAt: FINALIZED_AT,
      onBeforeFinalRevalidation({ sources: initiallyLoadedSources }) {
        finalRevalidationHookCount++;
        assert.equal(initiallyLoadedSources.length, 10);
      },
    });
    assert.equal(finalRevalidationHookCount, 1);
    assert.equal(
      artifact.status,
      "PASS",
      JSON.stringify(artifact.structuralFailures, null, 2),
    );
    assert.equal(artifact.exitCode, 0);
    assert.equal(artifact.certificationEligible, true);
    assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), artifact);
    assert.deepEqual(
      (await readdir(outputDirectory)).filter((name) => name.endsWith(".tmp")),
      [],
    );
    await assert.rejects(
      () =>
        finalizeAndWriteC1233MoonMipMotion({
          outputPath,
          manifestPaths: fixtures.map((fixture) => fixture.manifestPath),
          reviewerAttestationPath: reviewPath,
          finalizedAt: FINALIZED_AT,
        }),
      /already exists/,
    );

    const addedDuringCommit = join(
      fixtures[0].publicationDirectory,
      "added-during-final-revalidation.bin",
    );
    const driftOutputPath = join(outputDirectory, "c12-33-topology-drift.json");
    const driftArtifact = await finalizeAndWriteC1233MoonMipMotion({
      outputPath: driftOutputPath,
      manifestPaths: fixtures.map((fixture) => fixture.manifestPath),
      reviewerAttestationPath: reviewPath,
      finalizedAt: FINALIZED_AT,
      async onBeforeFinalRevalidation() {
        await writeFile(addedDuringCommit, "unmanifested topology drift");
      },
    });
    assert.equal(driftArtifact.status, "STRUCTURAL");
    assert.equal(driftArtifact.certificationEligible, false);
    assert.ok(
      driftArtifact.structuralFailures.some((failure) =>
        failure.includes("immutable pre-PASS revalidation failed"),
      ),
    );
    assert.equal(
      JSON.parse(await readFile(driftOutputPath, "utf8")).status,
      "STRUCTURAL",
    );
    await rm(addedDuringCommit);
  },
);

test("five counterbalanced pairs fold to the only certification-eligible PASS", () => {
  const sources = syntheticSources();
  const result = fold(sources);
  assert.equal(result.schema, C12_33_CERTIFICATION_SCHEMA);
  assert.equal(result.status, "PASS");
  assert.equal(result.exitCode, 0);
  assert.equal(result.certificationEligible, true);
  assert.equal(result.calibration.pairCount, 5);
  assert.equal(result.calibration.pairResults.length, 5);
  assert.equal(result.calibration.thresholdValueCount, 88);
  assert.deepEqual(result.structuralFailures, []);
  assert.deepEqual(result.acceptanceFailures, []);
  assert.ok(
    result.calibration.pairResults.every(
      (pair) =>
        pair.sensitivity.sensitive &&
        pair.sensitivity.comparisons.length ===
          PAIRED_SENSITIVITY_REQUIREMENTS.length,
    ),
  );
});

test("calibration produces the complete fixed 88-value threshold schema", () => {
  const normalReports = syntheticSources()
    .filter((source) => source.report.controlMode === "normal")
    .map((source) => source.report);
  const thresholds = deriveC1233CalibratedThresholds(normalReports);
  assert.equal(countThresholdValues(thresholds), 88);
  assert.equal(
    thresholds.lanes.close.webgpu.temporal.maxNormalizedP95HighPassDelta,
    0.2,
  );
  assert.equal(
    thresholds.lanes["seam-at-limb"].webgl.spatial
      .minNormalizedLaplacianEnergyMean,
    0.2,
  );
  const missing = structuredClone(normalReports);
  delete missing[0].lanes[0].backends.webgl.temporal.normalizedP95HighPassDelta;
  assert.throws(
    () => deriveC1233CalibratedThresholds(missing),
    /five finite non-negative values/,
  );
});

test("ten distinct runs and the fixed chronological counterbalance are mandatory", () => {
  const missing = syntheticSources().slice(0, 9);
  assert.equal(fold(missing).status, "STRUCTURAL");

  const duplicate = syntheticSources();
  duplicate[9].report.runId = duplicate[8].report.runId;
  refreshSource(duplicate[9]);
  assert.equal(
    fold(duplicate, reviewerAttestation(duplicate)).status,
    "STRUCTURAL",
  );

  const wrongOrder = syntheticSources();
  wrongOrder[0].report.controlMode = "force-lod0";
  wrongOrder[0].report.control = structuredClone(wrongOrder[1].report.control);
  refreshSource(wrongOrder[0]);
  assert.equal(
    fold(wrongOrder, reviewerAttestation(wrongOrder)).status,
    "STRUCTURAL",
  );
});

test("coordinated browser, control, and capture substitutions fail closed", () => {
  for (const mutate of [
    (reports) => {
      for (const report of reports) {
        report.browser.channel = "chromium";
      }
    },
    (reports) => {
      for (const report of reports) {
        for (const lane of report.lanes) {
          lane.backends.webgl.captureKind = "playwright-page-png";
          lane.backends.webgl.canvasSelector = "canvas";
          lane.backends.webgpu.captureKind = "playwright-page-png";
          lane.backends.webgpu.canvasSelector = "canvas";
        }
      }
    },
    (reports) => {
      for (const report of reports) {
        const substituted = report.controlMode !== "force-lod0";
        report.control.webgl.baseLevelOnly = substituted;
        report.control.webgpu.baseLevelOnly = substituted;
        report.control.webgpu.bindGroupRebuilt = substituted;
      }
    },
    (reports) => {
      for (const report of reports) {
        report.control.requestedMode = "substituted";
        report.control.appliedMode = "substituted";
      }
    },
  ]) {
    const sources = syntheticSources();
    mutate(sources.map((source) => source.report));
    for (const source of sources) {
      refreshSource(source);
    }
    assert.equal(
      fold(sources, reviewerAttestation(sources)).status,
      "STRUCTURAL",
    );
  }
});

test("source/build/assets/browser/adapter/sample identity mutations fail closed", () => {
  for (const mutate of [
    (source) => {
      source.report.browser.version = "different-edge";
    },
    (source) => {
      source.report.sampleCount = 11;
    },
    (source) => {
      source.report.runtimeIdentity.entries.bundle.local.sha256 =
        hash("mutated");
      source.report.runtimeIdentity.entries.bundle.served.sha256 =
        hash("mutated");
      source.report.runtimeIdentity.identitySha256 = hash(
        JSON.stringify({
          entries: source.report.runtimeIdentity.entries,
          adapterIdentity: source.report.runtimeIdentity.adapterIdentity,
        }),
      );
    },
    (source) => {
      source.report.runtimeIdentity.adapterIdentity.webgpuMoonUsesGlobalConstructor = false;
      source.report.setup.adapterIdentity.webgpuMoonUsesGlobalConstructor = false;
      source.report.runtimeIdentity.identitySha256 = hash(
        JSON.stringify({
          entries: source.report.runtimeIdentity.entries,
          adapterIdentity: source.report.runtimeIdentity.adapterIdentity,
        }),
      );
    },
    (source) => {
      source.manifest.source.repository.pre.head = "f".repeat(40);
      source.manifest.source.repository.post.head = "f".repeat(40);
    },
    (source) => {
      source.report.runtimeIdentity.entries.bundle.label = "substituted-bundle";
      source.report.runtimeIdentity.identitySha256 = hash(
        JSON.stringify({
          entries: source.report.runtimeIdentity.entries,
          adapterIdentity: source.report.runtimeIdentity.adapterIdentity,
        }),
      );
    },
    (source) => {
      source.report.setup.normalUrl = source.report.setup.albedoUrl;
    },
    (source) => {
      source.report.runtimeIdentity.schemaVersion = 2;
    },
    (source) => {
      source.report.runtimeIdentity.adapterIdentity.kind = "substitute.html";
      source.report.setup.adapterIdentity.kind = "substitute.html";
      source.report.runtimeIdentity.identitySha256 = hash(
        JSON.stringify({
          entries: source.report.runtimeIdentity.entries,
          adapterIdentity: source.report.runtimeIdentity.adapterIdentity,
        }),
      );
    },
  ]) {
    const sources = syntheticSources();
    mutate(sources[3]);
    refreshSource(sources[3]);
    assert.notEqual(fold(sources, reviewerAttestation(sources)).status, "PASS");
  }
});

test("stable substituted resources cannot become a shared certifying identity", () => {
  const sources = syntheticSources();
  for (const source of sources) {
    const bundle = source.report.runtimeIdentity.entries.bundle;
    bundle.local.path = "Build/Substituted/Cesium.js";
    bundle.served.url = "http://localhost:8080/Build/Substituted/Cesium.js";
    source.report.runtimeIdentity.adapterIdentity.loadedCesiumScriptUrl =
      bundle.served.url;
    source.report.setup.adapterIdentity.loadedCesiumScriptUrl =
      bundle.served.url;
    source.report.runtimeIdentity.identitySha256 = hash(
      JSON.stringify({
        entries: source.report.runtimeIdentity.entries,
        adapterIdentity: source.report.runtimeIdentity.adapterIdentity,
      }),
    );
    refreshSource(source);
  }
  assert.equal(
    fold(sources, reviewerAttestation(sources)).status,
    "STRUCTURAL",
  );
});

test("lane/backend/frame counts, WC pose proof, and raw failures are revalidated", () => {
  for (const mutate of [
    (report) => report.lanes.reverse(),
    (report) => report.lanes[0].backends.webgpu.frames.pop(),
    (report) => {
      report.lanes[0].motion[0].webgl.directionWC = [1, 0, 0];
    },
    (report) => report.result.hardFailures.push("forged fault"),
    (report) => {
      report.lanes[0].backends.webgpu.temporal.normalizedMeanHighPassDelta =
        null;
    },
    (report) => {
      report.manualInspection.status = "PASS";
      report.manualInspection.evidence = ["self://attested"];
    },
    (report) => {
      const previous = report.lanes[0].motion[0];
      const stationary = report.lanes[0].motion[1];
      for (const backend of ["webgl", "webgpu"]) {
        stationary[backend].cameraWorldPosition = [
          ...previous[backend].cameraWorldPosition,
        ];
        stationary[backend].requestedCameraWorldPosition = [
          ...previous[backend].requestedCameraWorldPosition,
        ];
        stationary[backend].moonCenterWorld = [
          ...previous[backend].moonCenterWorld,
        ];
      }
    },
    (report) => {
      const sample = report.lanes[1].motion[6];
      sample.webgl.cameraLocalDirection = [0, -1, 0];
      sample.webgl.requestedCameraLocalDirection = [0, -1, 0];
      sample.webgl.seamNormalDot = 0;
    },
    (report) => {
      report.lanes[2].motion[4].webgpu.cameraWorldPosition[0] += 2;
      report.lanes[2].motion[4].webgpu.requestedCameraWorldPosition[0] += 2;
      report.lanes[2].motion[4].webgpu.moonCenterWorld[0] += 2;
    },
    (report) => {
      report.lanes[0].motion[0].webgl.moonLocalToWorldBasis.xWC = [0, 1, 0];
    },
    (report) => {
      report.lanes[3].targetDiscDiameterPx = 24;
      report.lanes[3].backends.webgl.spatial.discDiameterPxMedian = 24;
    },
    (report) => {
      report.lanes[0].backends.webgl.temporal.normalizedP95HighPassDelta = 0;
    },
    (report) => {
      report.readiness.diagnostics.webgpu.pipelineReady = false;
    },
    (report) => {
      report.lanes[0].backends.webgl.frames[0].pngPath = `./${report.lanes[0].backends.webgl.frames[0].pngPath}`;
    },
  ]) {
    const sources = syntheticSources();
    mutate(sources[4].report);
    refreshSource(sources[4]);
    assert.equal(
      fold(sources, reviewerAttestation(sources)).status,
      "STRUCTURAL",
    );
  }
});

test("publication chronology and malformed direct folds fail structurally", () => {
  const sources = syntheticSources();
  sources[0].manifest.publishedAt = "2026-07-31T00:00:00.000Z";
  refreshSource(sources[0]);
  assert.equal(
    fold(sources, reviewerAttestation(sources)).status,
    "STRUCTURAL",
  );
  for (const malformed of [undefined, null, {}, { sources: [{}] }]) {
    const result = foldC1233MoonMipMotionEvidence(malformed);
    assert.equal(result.status, "STRUCTURAL");
    assert.equal(result.certificationEligible, false);
  }
});

test("every fixed sensitivity cell must separate in every pair", () => {
  const sources = syntheticSources();
  const control = sources[1].report.lanes.find(
    (lane) => lane.id === "minified-16px",
  ).backends.webgpu.temporal;
  for (const pair of control.pairs) {
    pair.normalizedMeanHighPassDelta = 0.1;
  }
  control.normalizedMeanHighPassDelta = 0.1;
  control.normalizedP95HighPassDelta = 0.1;
  refreshSource(sources[1]);
  const result = fold(sources, reviewerAttestation(sources));
  assert.equal(result.status, "FAIL");
  assert.equal(result.certificationEligible, false);
  assert.ok(
    result.acceptanceFailures.some((failure) =>
      failure.includes("minified-16px:webgpu:normalizedP95HighPassDelta"),
    ),
  );
});

test("reviewer PASS is separate, fixed, post-publication, and hash-bound", () => {
  const sources = syntheticSources();

  const failedReview = reviewerAttestation(sources, {
    verdict: "FAIL",
    findings: C12_33_REVIEW_FINDINGS.map((id, index) => ({
      id,
      verdict: index === 0 ? "FAIL" : "PASS",
      notes: "independent visual finding",
    })),
  });
  assert.equal(fold(sources, failedReview).status, "FAIL");

  const stale = reviewerAttestation(sources, {
    reviewedAt: "2026-07-31T00:00:00.000Z",
  });
  assert.equal(fold(sources, stale).status, "STRUCTURAL");

  const wrongFindings = reviewerAttestation(sources);
  wrongFindings.document.findings[0].id = "caller-selected-check";
  assert.equal(fold(sources, wrongFindings).status, "STRUCTURAL");

  const rebound = reviewerAttestation(sources);
  rebound.document.sources[0].pngs[0].sha256 = hash("different-png");
  assert.equal(fold(sources, rebound).status, "STRUCTURAL");

  const reboundView = reviewerAttestation(sources);
  reboundView.document.sources[0].pngs[0].viewPath =
    reboundView.document.sources[0].pngs[1].viewPath;
  assert.equal(fold(sources, reboundView).status, "STRUCTURAL");

  const reboundObject = reviewerAttestation(sources);
  reboundObject.document.sources[0].report.objectPath =
    reboundObject.document.sources[0].pngs[0].objectPath;
  assert.equal(fold(sources, reboundObject).status, "STRUCTURAL");

  assert.deepEqual(
    validateReviewerAttestation(
      reviewerAttestation(sources),
      reviewerSourceBindings(sources),
      {
        latestPublicationAt: sources.at(-1).manifest.publishedAt,
        finalizedAt: FINALIZED_AT,
      },
    ),
    [],
  );
});

test("mutating an immutable report, manifest, or PNG identity is structural", () => {
  for (const mutate of [
    (source) => {
      source.reportSha256 = hash("rewritten-report");
    },
    (source) => {
      source.manifestSha256 = hash("rewritten-manifest");
    },
    (source) => {
      source.pngs[0].sha256 = hash("rewritten-png");
    },
  ]) {
    const sources = syntheticSources();
    const attestation = reviewerAttestation(sources);
    mutate(sources[0]);
    assert.equal(fold(sources, attestation).status, "STRUCTURAL");
  }
});
