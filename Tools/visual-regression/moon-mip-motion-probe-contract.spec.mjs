import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  analyzeRgbaFrame,
  CALIBRATED_THRESHOLDS,
  classifyRawReport,
  computeParitySeries,
  computeTemporalSeries,
  decideVerdict,
  deriveMeasurementStatus,
  evaluateCalibratedQuality,
  evaluatePairedReportSensitivity,
  EXIT_CODES,
  FIXED_TIME_ISO,
  isPortableEvidencePath,
  MANUAL_INSPECTION_REQUIREMENT,
  MOON_MIP_CONTROL_MODES,
  MOON_MIP_MOTION_LANES,
  MOON_MIP_SAMPLE_COUNT,
  PAIRED_SENSITIVITY_REQUIREMENTS,
  parseControlMode,
  parseRunId,
  parseSampleCount,
  portableEvidencePath,
  validateCalibratedThresholds,
} from "./probe-moon-mip-motion-edge.mjs";

const probeUrl = new URL("./probe-moon-mip-motion-edge.mjs", import.meta.url);
const probeSource = await readFile(probeUrl, "utf8");

function syntheticFrame({ checker = false, phase = 0 } = {}) {
  const width = 11;
  const height = 11;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const inside = x >= 2 && x <= 8 && y >= 2 && y <= 8;
      const value = inside
        ? checker
          ? (x + y + phase) % 2 === 0
            ? 220
            : 40
          : 130
        : 0;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return analyzeRgbaFrame({ data, width, height });
}

function syntheticThresholds() {
  return {
    schemaVersion: 1,
    lanes: Object.fromEntries(
      MOON_MIP_MOTION_LANES.map((lane) => [
        lane.id,
        {
          webgl: {
            temporal: {
              maxNormalizedMeanAbsoluteLumaDelta: 1,
              maxNormalizedP95PairLumaDelta: 1,
              maxNormalizedMeanHighPassDelta: 1,
              maxNormalizedP95HighPassDelta: 1,
              maxSpatialHighFrequencyCoefficientOfVariation: 1,
            },
            spatial: {
              minNormalizedSpatialHighFrequencyMean: 0,
              maxNormalizedSpatialHighFrequencyMean: 1,
              minNormalizedLaplacianEnergyMean: 0,
              maxNormalizedLaplacianEnergyMean: 1,
            },
          },
          webgpu: {
            temporal: {
              maxNormalizedMeanAbsoluteLumaDelta: 1,
              maxNormalizedP95PairLumaDelta: 1,
              maxNormalizedMeanHighPassDelta: 1,
              maxNormalizedP95HighPassDelta: 1,
              maxSpatialHighFrequencyCoefficientOfVariation: 1,
            },
            spatial: {
              minNormalizedSpatialHighFrequencyMean: 0,
              maxNormalizedSpatialHighFrequencyMean: 1,
              minNormalizedLaplacianEnergyMean: 0,
              maxNormalizedLaplacianEnergyMean: 1,
            },
          },
          parity: {
            minMaskIntersectionOverUnionMean: 0,
            maxNormalizedMeanAbsoluteLumaError: 1,
            maxNormalizedP95AbsoluteLumaError: 1,
            maxChangedPixelFractionMean: 1,
          },
        },
      ]),
    ),
  };
}

function syntheticQualityReport(value = 0.25) {
  return {
    lanes: MOON_MIP_MOTION_LANES.map((lane) => ({
      id: lane.id,
      backends: Object.fromEntries(
        ["webgl", "webgpu"].map((backend) => [
          backend,
          {
            temporal: {
              normalizedMeanAbsoluteLumaDelta: value,
              normalizedP95PairLumaDelta: value,
              normalizedMeanHighPassDelta: value,
              normalizedP95HighPassDelta: value,
              spatialHighFrequencyCoefficientOfVariation: value,
            },
            spatial: {
              normalizedSpatialHighFrequencyMean: value,
              normalizedLaplacianEnergyMean: value,
            },
          },
        ]),
      ),
      parity: {
        maskIntersectionOverUnionMean: 1 - value,
        normalizedMeanAbsoluteLumaError: value,
        normalizedP95AbsoluteLumaError: value,
        changedPixelFractionMean: value,
      },
    })),
  };
}

function syntheticSensitivityReport(controlMode, value) {
  return {
    controlMode,
    runId: `synthetic-${controlMode}`,
    sampleCount: 13,
    fixedTimeIso: FIXED_TIME_ISO,
    browser: { version: "synthetic-edge" },
    runtimeIdentity: { identitySha256: "SYNTHETIC" },
    setup: { albedoUrl: "albedo", normalUrl: "normal" },
    result: { hardFailures: [] },
    lanes: MOON_MIP_MOTION_LANES.map((lane) => ({
      id: lane.id,
      backends: Object.fromEntries(
        ["webgl", "webgpu"].map((backend) => [
          backend,
          {
            temporal: {
              normalizedP95PairLumaDelta: value,
              normalizedP95HighPassDelta: value,
              spatialHighFrequencyCoefficientOfVariation: value,
            },
            spatial: {
              normalizedSpatialHighFrequencyMean: value,
              normalizedLaplacianEnergyMean: value,
            },
          },
        ]),
      ),
    })),
  };
}

test("probe is Node/Playwright Microsoft Edge only and captures canvas elements", () => {
  assert.match(probeSource, /from "playwright"/);
  assert.match(probeSource, /channel: "msedge"/);
  assert.match(probeSource, /--enable-unsafe-webgpu/);
  assert.match(probeSource, /page\.locator\(selector\)\.first\(\)\.screenshot/);
  assert.doesNotMatch(probeSource, /page\.screenshot\s*\(/);
  assert.doesNotMatch(probeSource, /node:child_process/);
});

test("probe pins one clock and declares all four required moving lanes", () => {
  assert.equal(FIXED_TIME_ISO, "2026-07-02T16:22:00Z");
  assert.deepEqual(
    MOON_MIP_MOTION_LANES.map((lane) => lane.id),
    ["close", "seam-centered", "seam-at-limb", "minified-16px"],
  );
  assert.equal(
    MOON_MIP_MOTION_LANES.find((lane) => lane.id === "minified-16px")
      .targetDiscDiameterPx,
    16,
  );
  assert.match(probeSource, /camera\.setView/);
  assert.match(probeSource, /requestAnimationFrame/);
  assert.match(probeSource, /performance\.now\(\) \+ timeoutMs/);
  assert.match(probeSource, /minStepDistanceMeters/);
  assert.match(probeSource, /motion\?\.length !== report\.sampleCount/);
  assert.match(
    probeSource,
    /recomputedParity\.sampleCount !== report\.sampleCount/,
  );
  assert.equal(MOON_MIP_SAMPLE_COUNT, 13);
  assert.equal(parseSampleCount(13), 13);
  assert.throws(() => parseSampleCount(11), /pre-registered count 13/);
  assert.throws(() => parseSampleCount(15), /pre-registered count 13/);
});

test("raw reports use library-compatible non-certifying states and cannot self-promote", () => {
  assert.deepEqual(
    classifyRawReport({
      verdict: "INCONCLUSIVE",
      hardFailures: [],
      qualityFailures: [],
    }),
    {
      status: "NON_CERTIFYING",
      exitCode: 2,
      certificationEligible: false,
    },
  );
  assert.equal(
    classifyRawReport({
      verdict: "FAIL",
      hardFailures: ["fault"],
      qualityFailures: [],
    }).status,
    "STRUCTURAL",
  );
  assert.equal(
    classifyRawReport({
      verdict: "FAIL",
      hardFailures: [],
      qualityFailures: ["quality"],
    }).status,
    "FAIL",
  );
  assert.match(probeSource, /Object\.assign\(report, classifyRawReport/);
  assert.match(probeSource, /status: "ERROR"/);
  assert.match(probeSource, /emitFatalProbeArtifact\(error, "WATCHDOG"\)/);
  assert.match(probeSource, /process\.exit\(EXIT_CODES\.FAIL\)/);
  assert.match(probeSource, /clearTimeout\(watchdog\)/);
  assert.match(probeSource, /error\?\.failureKind \?\? "ERROR"/);
  assert.match(probeSource, /failureKind = "ERROR"/);
  assert.match(probeSource, /cleanupError\.failureKind = "CLEANUP"/);
  assert.match(probeSource, /Promise\.allSettled/);
  assert.match(probeSource, /completedReport = report/);
  assert.doesNotMatch(probeSource, /process\.exit\(2\)/);
  assert.doesNotMatch(probeSource, /status:\s*"PASS"/);
});

test("PNG paths are portable and repository escapes fail closed", () => {
  assert.equal(isPortableEvidencePath("frames/close-00-webgl.png"), true);
  assert.equal(isPortableEvidencePath("./frames/close-00-webgl.png"), false);
  assert.equal(isPortableEvidencePath("frames/./close-00-webgl.png"), false);
  const outputDirectory = resolve("tmp", "c12-33-output");
  assert.equal(
    portableEvidencePath(
      resolve(outputDirectory, "report.json"),
      resolve(outputDirectory, "report-frames", "close-00-webgl.png"),
    ),
    "report-frames/close-00-webgl.png",
  );
  assert.throws(
    () =>
      portableEvidencePath(
        resolve(outputDirectory, "report.json"),
        resolve(outputDirectory, "..", "outside.png"),
      ),
    /beneath the report directory/,
  );
  assert.match(probeSource, /portableEvidencePath\(outputPath, pngPath\)/);
  assert.doesNotMatch(
    probeSource,
    /publicFrameMetric\(frame, pngPath, buffer\)/,
  );
});

test("runtime provenance binds served and local adapter, bundles, and Moon assets", () => {
  for (const token of [
    "split-view-adapter",
    "cesium-global-bundle",
    "cesium-module-index",
    "moon-albedo",
    "moon-normal",
    "servedMatchesLocal",
    "identitySha256",
    "loadedCesiumScriptUrl",
    "webglMoonUsesGlobalConstructor",
    "webgpuMoonUsesGlobalConstructor",
  ]) {
    assert.ok(probeSource.includes(token), `missing runtime identity ${token}`);
  }
  assert.match(probeSource, /await fetch\(canonicalUrl/);
  assert.match(
    probeSource,
    /servedBytes\.byteLength !== localBytes\.byteLength/,
  );
  assert.match(probeSource, /servedSha256 !== localSha256/);
});

test("camera evidence is read from the settled post-sync WC pose and basis", () => {
  for (const token of [
    "postSyncCameraPose",
    "camera.positionWC",
    "camera.directionWC",
    "camera.rightWC",
    "camera.upWC",
    "postSyncStableFrameCount",
    "post-sync-camera-world-coordinates",
    "backendPoseDelta",
    "basis self-attestation",
    "moonLocalToWorldBasis",
    "expectedRequestedPosition",
    "expectedCenterDistance",
    "fixedMoonGeometry",
  ]) {
    assert.ok(probeSource.includes(token), `missing post-sync proof ${token}`);
  }
  assert.match(probeSource, /stableFrameCount >= 2/);
  assert.doesNotMatch(
    probeSource,
    /cameraWorldPosition:\s*\[\s*cameraPosition\.x/,
  );
});

test("run ids make default evidence paths unique and reject unsafe names", () => {
  assert.equal(parseRunId(undefined), null);
  assert.equal(parseRunId(" pair-01-normal "), "pair-01-normal");
  assert.throws(() => parseRunId("../escape"), /path-safe/);
  assert.throws(() => parseRunId("contains spaces"), /path-safe/);
  for (const suffix of [".", "_", "-"]) {
    assert.throws(() => parseRunId(`trailing${suffix}`), /path-safe/);
  }
  assert.match(probeSource, /C12_MOON_MIP_RUN_ID/);
  assert.match(probeSource, /defaultOutputPath\(controlMode, runId\)/);
  assert.match(probeSource, /flag: "wx"/);
  assert.match(
    probeSource,
    /mkdir\(evidenceDirectory, \{ recursive: false \}\)/,
  );
  assert.match(probeSource, /mkdirWithoutSymbolicAncestors/);
  assert.match(
    probeSource,
    /symbolic output ancestor is forbidden before mkdir/,
  );
});

test("probe requires both full texture chains and the frame-owned queue drain", () => {
  for (const token of [
    "moonTextureMipLevelCount",
    "moonTextureMaxLod",
    "normalTextureMipLevelCount",
    "normalTextureMaxLod",
    "_pendingTextureMipJobs",
    "onSubmittedWorkDone",
  ]) {
    assert.ok(probeSource.includes(token), `missing diagnostic token ${token}`);
  }
  assert.match(probeSource, /actualMipLevelCount === expected/);
  assert.match(probeSource, /pendingTextureMipJobs !== 0/);
});

test("mip-0 calibration control is symmetric, recorded, and fail-closed", () => {
  assert.deepEqual(MOON_MIP_CONTROL_MODES, ["normal", "force-lod0"]);
  assert.equal(parseControlMode("normal"), "normal");
  assert.equal(parseControlMode(" FORCE-LOD0 "), "force-lod0");
  assert.throws(() => parseControlMode("unknown"), /must be one of/);
  for (const token of [
    "C12_MOON_MIP_CONTROL",
    "TextureMinificationFilter.LINEAR",
    "lodMaxClamp: 0",
    "renderBundleManager",
    "bindGroupRebuilt",
    "controlMode",
    'report.browser?.channel !== "msedge"',
    '"playwright-canvas-element-png"',
    '"#leftViewer canvas"',
    '"#rightViewer canvas"',
    "normal control did not retain mip-capable sampling",
  ]) {
    assert.ok(probeSource.includes(token), `missing control token ${token}`);
  }
});

test("probe records WebGL color/pick compile proof and browser/GPU faults", () => {
  for (const token of [
    "LUNAR_EXPLICIT_GRADIENTS",
    "LUNAR_ALBEDO_EXPLICIT_GRADIENTS",
    "LUNAR_NORMAL_EXPLICIT_GRADIENTS",
    "scene.pick",
    "attachConsoleErrorGate",
    "armWebGPUDevices",
    "collectGateErrors",
    'page.on("pageerror"',
    'page.on("console"',
  ]) {
    assert.ok(
      probeSource.includes(token),
      `missing fault/compile token ${token}`,
    );
  }
});

test("camera samples retain an exact clock and a deterministic front-lit fixture", () => {
  assert.match(probeSource, /clockOffsetSeconds/);
  assert.match(
    probeSource,
    /Math\.abs\(sample\[backend\]\.clockOffsetSeconds\)/,
  );
  assert.match(probeSource, /camera-coincident-directional-light/);
  assert.match(probeSource, /scene\.light\.direction/);
  assert.match(probeSource, /minimumInteriorPixels/);
});

test("manual seam inspection is explicit and blocks calibrated promotion", () => {
  assert.equal(MANUAL_INSPECTION_REQUIREMENT.required, true);
  assert.deepEqual(MANUAL_INSPECTION_REQUIREMENT.requiredLaneIds, [
    "seam-centered",
    "seam-at-limb",
  ]);
  const thresholds = syntheticThresholds();
  const pending = decideVerdict([], [], thresholds);
  assert.equal(pending.verdict, "INCONCLUSIVE");
  assert.equal(pending.exitCode, EXIT_CODES.INCONCLUSIVE);
  assert.equal(
    deriveMeasurementStatus(pending, thresholds),
    "MANUAL_INSPECTION_PENDING",
  );
  const passed = decideVerdict([], [], thresholds, {
    required: true,
    status: "PASS",
    evidence: ["review://synthetic-seam-contact-sheet"],
  });
  assert.equal(passed.verdict, "PASS");
  assert.equal(
    deriveMeasurementStatus(passed, thresholds, {
      required: true,
      status: "PASS",
      evidence: ["review://synthetic-seam-contact-sheet"],
    }),
    "CALIBRATED_PASS",
  );
});

test("spatial HF metric distinguishes a checker from a smooth disc", () => {
  const smooth = syntheticFrame();
  const checker = syntheticFrame({ checker: true });
  assert.ok(smooth.coveredPixels > 0);
  assert.ok(checker.interiorPixels > 0);
  assert.ok(
    checker.normalizedSpatialHighFrequency >
      smooth.normalizedSpatialHighFrequency,
  );
  assert.ok(
    checker.normalizedLaplacianEnergy > smooth.normalizedLaplacianEnergy,
  );
});

test("temporal shimmer is zero for identical pixels and positive for a phase flip", () => {
  const frame = syntheticFrame({ checker: true, phase: 0 });
  const identical = computeTemporalSeries([frame, frame]);
  const changed = computeTemporalSeries([
    frame,
    syntheticFrame({ checker: true, phase: 1 }),
  ]);
  assert.equal(identical.normalizedMeanAbsoluteLumaDelta, 0);
  assert.equal(identical.normalizedMeanHighPassDelta, 0);
  assert.ok(changed.normalizedMeanAbsoluteLumaDelta > 0);
  assert.ok(changed.normalizedMeanHighPassDelta > 0);
});

test("parity metric is exact for identical frames and detects changed pixels", () => {
  const smooth = syntheticFrame();
  const checker = syntheticFrame({ checker: true });
  const exact = computeParitySeries([smooth], [smooth]);
  const changed = computeParitySeries([smooth], [checker]);
  assert.equal(exact.meanAbsoluteLumaError, 0);
  assert.equal(exact.changedPixelFractionMean, 0);
  assert.ok(changed.meanAbsoluteLumaError > 0);
  assert.ok(changed.changedPixelFractionMean > 0);
});

test("calibrated threshold schema is complete, lane keyed, and fail-closed", () => {
  const valid = syntheticThresholds();
  assert.deepEqual(validateCalibratedThresholds(valid), []);

  assert.ok(validateCalibratedThresholds({}).length > 0);
  const missingLane = structuredClone(valid);
  delete missingLane.lanes.close;
  assert.ok(validateCalibratedThresholds(missingLane).length > 0);
  const missingMetric = structuredClone(valid);
  delete missingMetric.lanes.close.webgpu.temporal
    .maxNormalizedP95HighPassDelta;
  assert.ok(validateCalibratedThresholds(missingMetric).length > 0);
  const nonFinite = structuredClone(valid);
  nonFinite.lanes.close.webgl.spatial.maxNormalizedLaplacianEnergyMean =
    Number.NaN;
  assert.ok(validateCalibratedThresholds(nonFinite).length > 0);
  const invertedBand = structuredClone(valid);
  invertedBand.lanes.close.webgl.spatial.minNormalizedSpatialHighFrequencyMean = 2;
  assert.ok(validateCalibratedThresholds(invertedBand).length > 0);

  const invalidVerdict = decideVerdict(
    [],
    [],
    {},
    {
      required: true,
      status: "PASS",
      evidence: ["review://synthetic-seam-contact-sheet"],
    },
  );
  assert.equal(invalidVerdict.verdict, "FAIL");
  assert.match(
    invalidVerdict.failures[0],
    /invalid calibrated-threshold schema/,
  );
});

test("quality evaluation gates p95 shimmer, CV, spatial bands, and parity IoU", () => {
  const thresholds = syntheticThresholds();
  assert.deepEqual(
    evaluateCalibratedQuality(syntheticQualityReport(), thresholds),
    [],
  );

  const report = syntheticQualityReport();
  report.lanes[0].backends.webgpu.temporal.normalizedP95HighPassDelta = 2;
  report.lanes[1].backends.webgl.temporal.spatialHighFrequencyCoefficientOfVariation = 2;
  report.lanes[2].backends.webgpu.spatial.normalizedLaplacianEnergyMean = 2;
  report.lanes[3].parity.maskIntersectionOverUnionMean = -0.1;
  const failures = evaluateCalibratedQuality(report, thresholds);
  assert.ok(failures.some((failure) => /p95 temporal high-pass/.test(failure)));
  assert.ok(
    failures.some((failure) =>
      /spatial high-frequency variation/.test(failure),
    ),
  );
  assert.ok(failures.some((failure) => /laplacian detail/.test(failure)));
  assert.ok(
    failures.some((failure) => /intersection-over-union/.test(failure)),
  );

  const missingMeasurement = syntheticQualityReport();
  delete missingMeasurement.lanes[0].backends.webgl.temporal
    .normalizedP95PairLumaDelta;
  assert.ok(
    evaluateCalibratedQuality(missingMeasurement, thresholds).some((failure) =>
      /finite measured value/.test(failure),
    ),
  );
});

test("paired reports prove requested normal versus force-lod0 sensitivity", () => {
  assert.deepEqual(PAIRED_SENSITIVITY_REQUIREMENTS, [
    {
      laneId: "minified-16px",
      backend: "webgl",
      metric: "normalizedP95HighPassDelta",
    },
    {
      laneId: "minified-16px",
      backend: "webgl",
      metric: "spatialHighFrequencyCoefficientOfVariation",
    },
    {
      laneId: "minified-16px",
      backend: "webgpu",
      metric: "normalizedP95HighPassDelta",
    },
    {
      laneId: "minified-16px",
      backend: "webgpu",
      metric: "spatialHighFrequencyCoefficientOfVariation",
    },
  ]);
  assert.ok(Object.isFrozen(PAIRED_SENSITIVITY_REQUIREMENTS));
  assert.ok(PAIRED_SENSITIVITY_REQUIREMENTS.every(Object.isFrozen));
  const normal = syntheticSensitivityReport("normal", 0.2);
  const control = syntheticSensitivityReport("force-lod0", 0.6);
  const sensitive = evaluatePairedReportSensitivity(normal, control);
  assert.equal(sensitive.verdict, "PASS");
  assert.equal(
    sensitive.comparisons.length,
    PAIRED_SENSITIVITY_REQUIREMENTS.length,
  );
  assert.ok(
    sensitive.comparisons.every(
      (comparison) => comparison.controlStrictlyWorse,
    ),
  );

  const regressedNormal = syntheticSensitivityReport("normal", 0.8);
  const insensitive = evaluatePairedReportSensitivity(regressedNormal, control);
  assert.equal(insensitive.verdict, "FAIL");
  assert.ok(insensitive.failures.length > 0);

  const callerChosenEasyCell = [
    { laneId: "close", backend: "webgl", metric: "normalizedP95HighPassDelta" },
  ];
  const manipulated = structuredClone(control);
  manipulated.lanes.find(
    (lane) => lane.id === "minified-16px",
  ).backends.webgl.temporal.normalizedP95HighPassDelta = 0.1;
  assert.equal(
    evaluatePairedReportSensitivity(normal, manipulated, callerChosenEasyCell)
      .verdict,
    "FAIL",
    "a third-argument caller cell must not replace the fixed authority",
  );
});

test("uncalibrated quality is explicitly INCONCLUSIVE with hard 0/1/2 exits", () => {
  assert.equal(CALIBRATED_THRESHOLDS, null);
  assert.deepEqual(EXIT_CODES, { PASS: 0, FAIL: 1, INCONCLUSIVE: 2 });
  assert.equal(decideVerdict([], [], null).verdict, "INCONCLUSIVE");
  assert.equal(decideVerdict([], [], null).exitCode, 2);
  assert.equal(decideVerdict(["fault"], [], null).verdict, "FAIL");
  assert.equal(decideVerdict(["fault"], [], null).exitCode, 1);
  assert.equal(decideVerdict([], [], {}).verdict, "FAIL");
  assert.equal(decideVerdict([], [], {}).exitCode, 1);
  assert.equal(
    deriveMeasurementStatus(decideVerdict([], [], null), null),
    "CALIBRATION_PENDING",
  );
});
