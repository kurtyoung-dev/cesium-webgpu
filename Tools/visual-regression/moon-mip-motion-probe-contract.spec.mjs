// @purpose Contract over the C12-33 shimmer-envelope probe: honest scope, frame analysis, exit codes, evidence paths, and minimum paired sensitivity.
// @status ACTIVE

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  analyzeRgbaFrame,
  CALIBRATED_THRESHOLDS,
  C12_33_DOES_NOT_MEASURE,
  C12_33_SHIMMER_ENVELOPE_CERTIFICATION,
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
  PAIRED_SENSITIVITY_MINIMUM_EFFECT,
  parseControlMode,
  parseRunId,
  parseSampleCount,
  portableEvidencePath,
  summarizeSpatial,
  validateCalibratedThresholds,
} from "./probe-moon-mip-motion-edge.mjs";
import { S5_STATUS_EXIT_CODES } from "./lib/verdict-exit-gate.mjs";

const probeUrl = new URL("./probe-moon-mip-motion-edge.mjs", import.meta.url);
const probeSource = await readFile(probeUrl, "utf8");
const normalizedProbeSource = probeSource.replace(/\r\n/gu, "\n");
const webgpuEnvironmentRendererSource = (
  await readFile(
    new URL(
      "../../packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js",
      import.meta.url,
    ),
    "utf8",
  )
).replace(/\r\n/gu, "\n");
const moonSource = (
  await readFile(
    new URL("../../packages/engine/Source/Scene/Moon.js", import.meta.url),
    "utf8",
  )
).replace(/\r\n/gu, "\n");

function loadReadinessFailureEvaluator(source) {
  const startAnchor = "  const readinessBlockedBy =";
  const endAnchor = "\n  const compile = report.webglShaderCompile;";
  const start = source.indexOf(startAnchor);
  assert.ok(start >= 0, "readiness failure block opening anchor is missing");
  const end = source.indexOf(endAnchor, start);
  assert.ok(end > start, "readiness failure block closing anchor is missing");
  const block = source.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function(
    "report",
    `"use strict"; const failures = []; const ready = report.readiness?.diagnostics;\n${block}\nreturn failures;`,
  );
}

function loadMipDiagnosticsDerivation(source) {
  const startAnchor = "      const expectedMipCount =";
  const endAnchor = "      const backendDiagnostics =";
  const start = source.indexOf(startAnchor);
  assert.ok(start >= 0, "mip derivation opening anchor is missing");
  const end = source.indexOf(endAnchor, start);
  assert.ok(end > start, "mip derivation closing anchor is missing");
  const block = source.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function(
    "stats",
    "channel",
    `"use strict";\n${block}\nreturn channelMipDiagnostics(stats, channel);`,
  );
}

function loadPickContract(source) {
  const startAnchor = "  const webGLPickContractFailures =";
  const start = source.indexOf(startAnchor);
  assert.ok(start >= 0, "pick contract opening anchor is missing");
  const end = source.indexOf("\n  };", start);
  assert.ok(end > start, "pick contract closing anchor is missing");
  const declaration = source.slice(start, end + "\n  };".length);
  // eslint-disable-next-line no-new-func
  return new Function(
    `"use strict";\n${declaration}\nreturn webGLPickContractFailures;`,
  )();
}

function loadWebGPUBaseLevelGate(source) {
  const startAnchor = "      const webGPUBaseLevelOnly =";
  const endAnchor = "\n\n      const applyControlMode =";
  const start = source.indexOf(startAnchor);
  assert.ok(start >= 0, "WebGPU base-level gate opening anchor is missing");
  const end = source.indexOf(endAnchor, start);
  assert.ok(end > start, "WebGPU base-level gate closing anchor is missing");
  const declaration = source.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function(
    `"use strict";\n${declaration}\nreturn webGPUBaseLevelOnly;`,
  )();
}

function harnessReadinessSequence(source) {
  const startAnchor = "    const setup = await installBrowserHarness(page);";
  const endAnchor = "    const lanes = [];";
  const start = source.indexOf(startAnchor);
  assert.ok(start >= 0, "harness sequence opening anchor is missing");
  const end = source.indexOf(endAnchor, start);
  assert.ok(end > start, "harness sequence closing anchor is missing");
  return source.slice(start, end);
}

function harnessReadinessDeadlineMs(sequence) {
  const match =
    /globalThis\.__c12MoonMipMotionProbe\.waitForReadiness\(([\d_]+)\)/u.exec(
      sequence,
    );
  return match === null ? null : Number(match[1].replaceAll("_", ""));
}

function prepositionPrecedesReadiness(sequence) {
  const position = sequence.indexOf(
    "globalThis.__c12MoonMipMotionProbe.positionForReadiness(count)",
  );
  const readiness = sequence.search(
    /globalThis\.__c12MoonMipMotionProbe\.waitForReadiness\(/u,
  );
  return position >= 0 && readiness > position;
}

function loadForceLod0SamplerInstall(source) {
  const startAnchor = "        const samplerDescriptor = {";
  const endAnchor = "        const bundleManager =";
  const start = source.indexOf(startAnchor);
  assert.ok(start >= 0, "force-lod0 sampler descriptor anchor is missing");
  const end = source.indexOf(endAnchor, start);
  assert.ok(
    end > start,
    "force-lod0 sampler install closing anchor is missing",
  );
  const block = source.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function(
    "cache",
    "device",
    "webGPUBaseLevelOnly",
    `"use strict";\n${block}\nreturn {
      baseLevelOnly: webGPUBaseLevelOnly(cache.sampler, appliedSamplerState),
      samplerState: {
        live: cache.sampler === appliedSamplerState.sampler,
        lodMinClamp: appliedSamplerState.lodMinClamp,
        lodMaxClamp: appliedSamplerState.lodMaxClamp,
      },
    };`,
  );
}

function loadWebGPUMipDerivation(source, width, height) {
  const countAnchor =
    "const mipLevelCount = Math.floor(Math.log2(Math.max(width, height))) + 1;";
  assert.ok(
    source.includes(countAnchor),
    "WebGPU mip-count derivation anchor is missing",
  );
  const maxLod = /^[ \t]*mipLevelCount,\n[ \t]*maxLod: (.*),$/mu.exec(source);
  assert.ok(maxLod !== null, "WebGPU published maxLod anchor is missing");
  // eslint-disable-next-line no-new-func
  return new Function(
    "width",
    "height",
    `"use strict";\n${countAnchor}\nreturn { mipLevelCount, maxLod: ${maxLod[1]} };`,
  )(width, height);
}

function loadWebGLPublishedMipShape(source, channel, mipLevelCount) {
  const prefix = channel === "albedo" ? "moon" : "normal";
  const binding = `${channel}MipLevelCount`;
  const block = new RegExp(
    `^[ \\t]*${prefix}TextureMipLevelCount:[\\s\\S]*?^[ \\t]*${prefix}TextureMaxLod:[\\s\\S]*?,$`,
    "mu",
  ).exec(source);
  assert.ok(block !== null, `${channel} WebGL published mip anchor is missing`);
  // eslint-disable-next-line no-new-func
  return new Function(binding, `"use strict"; return ({\n${block[0]}\n});`)(
    mipLevelCount,
  );
}

const PUBLISHED_STATISTICS_FUNCTIONS = {
  webgpu: "function getWebGPUMoonStatistics(",
  webgl: "getDebugStatistics(scene) {",
};

function loadPublishedDimensionShape(source, backend, state) {
  const functionAnchor = PUBLISHED_STATISTICS_FUNCTIONS[backend];
  const functionIndex = source.indexOf(functionAnchor);
  assert.ok(
    functionIndex >= 0,
    `${backend} statistics function anchor is missing`,
  );
  const backendAnchor = `backend: "${backend}",`;
  const backendIndex = source.indexOf(backendAnchor, functionIndex);
  assert.ok(
    backendIndex >= 0,
    `${backend} statistics opening anchor is missing`,
  );
  const start = source.lastIndexOf("\n", backendIndex) + 1;
  const endAnchor =
    backend === "webgpu" ? "\n    pipelineReady:" : "\n        lifecycle,";
  const end = source.indexOf(endAnchor, backendIndex);
  assert.ok(end > start, `${backend} statistics closing anchor is missing`);
  const fields = source.slice(start, end);
  if (backend === "webgpu") {
    // eslint-disable-next-line no-new-func
    return new Function("cache", `"use strict"; return ({\n${fields}\n});`)(
      state,
    );
  }
  // eslint-disable-next-line no-new-func
  return new Function(`"use strict"; return ({\n${fields}\n});`).call(state);
}

function removePublishedDimension(source, field) {
  return source.replace(new RegExp(`^\\s*${field}:.*\\n`, "mu"), "");
}

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

function syntheticDiscMetric({ diameter, canvasSize, stray = false }) {
  const data = new Uint8Array(canvasSize * canvasSize * 4);
  const center = (canvasSize - 1) * 0.5;
  const radius = diameter * 0.5;
  for (let y = 0; y < canvasSize; y++) {
    for (let x = 0; x < canvasSize; x++) {
      const offset = (y * canvasSize + x) * 4;
      const inside = (x - center) ** 2 + (y - center) ** 2 <= radius ** 2;
      const value = inside ? 130 : 0;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  if (stray) {
    const offset = (canvasSize * canvasSize - 1) * 4;
    data[offset] = 20;
    data[offset + 1] = 20;
    data[offset + 2] = 20;
  }
  return analyzeRgbaFrame({ data, width: canvasSize, height: canvasSize });
}

function extractStructuralFramingBlock(source) {
  const startAnchor = "    const target = laneDefinition.targetDiscDiameterPx;";
  const endAnchor = "    const centerDots =";
  const start = source.indexOf(startAnchor);
  assert.ok(start >= 0, "structural framing block opening anchor is missing");
  const end = source.indexOf(endAnchor, start);
  assert.ok(end > start, "structural framing block closing anchor is missing");
  return source.slice(start, end);
}

function loadStructuralFramingBlock(source) {
  const block = extractStructuralFramingBlock(source);
  // eslint-disable-next-line no-new-func
  return new Function(
    "lane",
    "laneDefinition",
    "summarizeSpatial",
    `"use strict"; const failures = [];\n${block}\nreturn failures;`,
  );
}

function structuralFramingFailures(source, laneDefinition, frame) {
  const lane = {
    id: laneDefinition.id,
    backends: {
      webgl: { frames: [frame] },
      webgpu: {
        frames: [
          syntheticDiscMetric({
            diameter: laneDefinition.targetDiscDiameterPx,
            canvasSize: laneDefinition.id === "minified-16px" ? 64 : 500,
          }),
        ],
      },
    },
  };
  return loadStructuralFramingBlock(source)(
    lane,
    laneDefinition,
    summarizeSpatial,
  );
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

test("scene hygiene disables the independent catalog starfield and records it", () => {
  assert.match(
    probeSource,
    /if \(scene\.skyBox\) \{[\s\S]*?scene\.skyBox\.show = false;[\s\S]*?if \(scene\.skyBox\.starField\) \{[\s\S]*?scene\.skyBox\.starField\.show = false;/u,
  );
  assert.match(
    probeSource,
    /The catalog starfield renders independently of skyBox\.show\./u,
  );
  assert.match(probeSource, /catalogStarFieldDisabled:/u);
  assert.match(probeSource, /strayLitPixels: metric\.strayLitPixels/u);
  assert.match(
    probeSource,
    /principalComponentBounds: metric\.principalComponentBounds/u,
  );
});

test("the evidence claim is the narrower shimmer envelope and disclaims mip/LOD observation", () => {
  assert.equal(
    C12_33_SHIMMER_ENVELOPE_CERTIFICATION,
    "C12-33-SHIMMER-ENVELOPE-CERTIFICATION",
  );
  assert.deepEqual(C12_33_DOES_NOT_MEASURE, [
    "observed mip or texture-LOD selection across camera motion",
  ]);
  assert.ok(Object.isFrozen(C12_33_DOES_NOT_MEASURE));
  assert.match(
    probeSource,
    /does not claim observed mip or texture-LOD selection/,
  );
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
      exitCode: EXIT_CODES.STRUCTURAL,
      certificationEligible: false,
    },
  );
  assert.deepEqual(
    classifyRawReport({
      verdict: "FAIL",
      hardFailures: ["fault"],
      qualityFailures: [],
    }),
    {
      status: "STRUCTURAL",
      exitCode: EXIT_CODES.STRUCTURAL,
      certificationEligible: false,
    },
  );
  assert.deepEqual(
    classifyRawReport({
      verdict: "FAIL",
      hardFailures: [],
      qualityFailures: ["quality"],
    }),
    {
      status: "FAIL",
      exitCode: EXIT_CODES.FAIL,
      certificationEligible: false,
    },
  );
  assert.match(probeSource, /Object\.assign\(report, classifyRawReport/);
  assert.match(probeSource, /status: "ERROR"/);
  assert.match(probeSource, /emitFatalProbeArtifact\(error, "WATCHDOG"\)/);
  assert.match(probeSource, /process\.exit\(EXIT_CODES\.HARNESS\)/);
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

test("unpublished readiness diagnostics are structural and never print equal missing operands", (t) => {
  const completeMips = {
    albedo: {
      actualMipLevelCount: 12,
      expectedMipLevelCount: 12,
      maxLod: 11,
      fullChain: true,
    },
    normal: {
      actualMipLevelCount: 11,
      expectedMipLevelCount: 11,
      maxLod: 10,
      fullChain: true,
    },
  };
  const report = {
    readiness: {
      ready: false,
      blockedBy: [
        { backend: "webgl", channel: "albedo", reason: "texture" },
        { backend: "webgpu", channel: "renderer", reason: "pipeline" },
      ],
      diagnostics: { webgl: null, webgpu: null },
    },
    gpuDrain: { completed: true, pendingTextureMipJobs: 0 },
    finalDiagnostics: {
      webgl: {
        textureLoaded: true,
        normalLoaded: true,
        pipelineReady: true,
        mips: completeMips,
      },
      webgpu: {
        textureLoaded: true,
        normalLoaded: true,
        pipelineReady: true,
        mips: completeMips,
      },
    },
  };
  const evaluate = loadReadinessFailureEvaluator(normalizedProbeSource);
  const failures = evaluate(report);
  assert.ok(
    failures.some((failure) =>
      failure.startsWith("readiness instrument was structurally invalid:"),
    ),
  );
  for (const backend of ["webgl", "webgpu"]) {
    for (const channel of ["albedo", "normal"]) {
      assert.ok(
        failures.includes(
          `${backend} ${channel} mip diagnostics were never published (renderer realized no texture)`,
        ),
      );
    }
  }
  assert.equal(
    failures.some((failure) =>
      failure.includes("actual=missing, expected=missing"),
    ),
    false,
  );
  assert.equal(
    failures.some((failure) => failure.includes("not retained through final")),
    false,
  );
  assert.match(
    failures.find((failure) =>
      failure.startsWith("readiness instrument was structurally invalid:"),
    ),
    /camera-facing observation was never published for webgl, webgpu/,
  );

  const branch = `if (
        !Number.isFinite(actualMipLevelCount) ||
        !Number.isFinite(expectedMipLevelCount)
      ) {`;
  assert.equal(normalizedProbeSource.split(branch).length - 1, 1);
  const inertSource = normalizedProbeSource.replace(
    branch,
    `if (
        false &&
        (!Number.isFinite(actualMipLevelCount) ||
          !Number.isFinite(expectedMipLevelCount))
      ) {`,
  );
  const inertFailures = loadReadinessFailureEvaluator(inertSource)(report);
  assert.equal(
    inertFailures.some((failure) =>
      failure.includes("mip diagnostics were never published"),
    ),
    false,
  );
  t.diagnostic(
    "MUTATION RED: an inert unpublished-diagnostics branch loses the structural renderer-realization reasons",
  );
});

test("readiness distinguishes observed behind-camera state from unpublished camera-facing state", () => {
  const incompleteMips = { albedo: null, normal: null };
  const backend = (rendererType, moonInFrontOfCamera) => ({
    rendererType,
    clockOffsetSeconds: 0,
    textureLoaded: false,
    normalLoaded: false,
    pipelineReady: false,
    pendingTextureMipJobs: 1,
    moonInFrontOfCamera,
    mips: incompleteMips,
  });
  const report = {
    readiness: {
      ready: false,
      blockedBy: [
        { backend: "webgpu", channel: "renderer", reason: "pipeline" },
      ],
      diagnostics: {
        webgl: backend("webgl", true),
        webgpu: backend("webgpu", false),
      },
    },
    gpuDrain: { completed: true, pendingTextureMipJobs: 0 },
    finalDiagnostics: {
      webgl: { textureLoaded: true, normalLoaded: true, mips: {} },
      webgpu: {
        textureLoaded: true,
        normalLoaded: true,
        pipelineReady: true,
        mips: {},
      },
    },
  };
  const evaluate = loadReadinessFailureEvaluator(normalizedProbeSource);
  const offCameraFailures = evaluate(report);
  assert.ok(
    offCameraFailures.some((failure) =>
      failure.includes(
        "Moon was behind the camera on the last sampled frame for webgpu",
      ),
    ),
  );
  assert.equal(
    offCameraFailures.some((failure) =>
      failure.includes("camera-facing observation was never published"),
    ),
    false,
  );

  delete report.readiness.diagnostics.webgpu.moonInFrontOfCamera;
  const unknownFailures = evaluate(report);
  assert.ok(
    unknownFailures.some((failure) =>
      failure.includes(
        "Moon camera-facing observation was never published for webgpu",
      ),
    ),
  );
  assert.equal(
    unknownFailures.some((failure) =>
      failure.includes("Moon was behind the camera"),
    ),
    false,
  );
});

test("finite equal mip counts produce no incomplete-count reason", () => {
  const mip = {
    actualMipLevelCount: 12,
    expectedMipLevelCount: 12,
    maxLod: 11,
    fullChain: true,
  };
  const backend = {
    rendererType: "webgl",
    clockOffsetSeconds: 0,
    textureLoaded: true,
    normalLoaded: true,
    pipelineReady: true,
    pendingTextureMipJobs: 0,
    moonInFrontOfCamera: true,
    mips: { albedo: mip, normal: mip },
  };
  const report = {
    readiness: {
      ready: true,
      blockedBy: [],
      diagnostics: {
        webgl: backend,
        webgpu: { ...backend, rendererType: "webgpu" },
      },
    },
    gpuDrain: { completed: true, pendingTextureMipJobs: 0 },
    finalDiagnostics: {
      webgl: backend,
      webgpu: { ...backend, rendererType: "webgpu" },
    },
  };
  const failures = loadReadinessFailureEvaluator(normalizedProbeSource)(report);
  assert.deepEqual(failures, []);
  assert.equal(
    failures.some((failure) => failure.includes("actual=12, expected=12")),
    false,
  );
});

test("expected mip counts derive only from published texture dimensions", (t) => {
  const published = {
    moonTextureWidth: 2048,
    moonTextureHeight: 1024,
    moonTextureMipLevelCount: 12,
    moonTextureMaxLod: 11,
    normalTextureWidth: 1024,
    normalTextureHeight: 512,
    normalTextureMipLevelCount: 11,
    normalTextureMaxLod: 10,
  };
  const guarded = new Proxy(published, {
    get(target, property, receiver) {
      assert.equal(String(property).startsWith("_"), false);
      return Reflect.get(target, property, receiver);
    },
  });
  const derive = loadMipDiagnosticsDerivation(normalizedProbeSource);
  assert.deepEqual(derive(guarded, "albedo"), {
    width: 2048,
    height: 1024,
    actualMipLevelCount: 12,
    expectedMipLevelCount: 12,
    maxLod: 11,
    fullChain: true,
  });
  assert.equal(derive(guarded, "normal").expectedMipLevelCount, 11);

  const fieldAnchor = "stats?.moonTextureWidth";
  assert.equal(normalizedProbeSource.split(fieldAnchor).length - 1, 1);
  const renamedSource = normalizedProbeSource.replace(
    fieldAnchor,
    "stats?.renamedMoonTextureWidth",
  );
  const renamed = loadMipDiagnosticsDerivation(renamedSource)(
    published,
    "albedo",
  );
  assert.equal(renamed.expectedMipLevelCount, null);
  assert.equal(renamed.fullChain, false);
  t.diagnostic(
    "MUTATION RED: renaming the published width prevents expected mip derivation",
  );
});

test("pick define contract is conditional on the color albedo-gradient axis", (t) => {
  const pickFailures = loadPickContract(normalizedProbeSource);
  assert.deepEqual(pickFailures([], []), []);
  const colorDefines = ["LUNAR_ALBEDO_EXPLICIT_GRADIENTS"];
  const completePickDefines = [
    "LUNAR_EXPLICIT_GRADIENTS",
    "LUNAR_ALBEDO_EXPLICIT_GRADIENTS",
  ];
  assert.deepEqual(pickFailures(colorDefines, completePickDefines), []);
  assert.deepEqual(pickFailures(colorDefines, [completePickDefines[0]]), [
    "WebGL pick shader contract did not carry LUNAR_ALBEDO_EXPLICIT_GRADIENTS",
  ]);
  t.diagnostic(
    "MUTATION RED: dropping one required pick define violates the color-to-pick contract",
  );
});

test("force-lod0 gate checks requested clamps and installed sampler identity", (t) => {
  assert.deepEqual(MOON_MIP_CONTROL_MODES, ["normal", "force-lod0"]);
  assert.equal(parseControlMode("normal"), "normal");
  assert.equal(parseControlMode(" FORCE-LOD0 "), "force-lod0");
  assert.throws(() => parseControlMode("unknown"), /must be one of/);

  const sampler = {};
  const gate = loadWebGPUBaseLevelGate(normalizedProbeSource);
  assert.equal(
    gate(sampler, { sampler, lodMinClamp: 0, lodMaxClamp: 0 }),
    true,
  );
  const requestedLiteral = { lodMinClamp: 0, lodMaxClamp: 0 };
  const appliedState = {
    sampler,
    lodMinClamp: requestedLiteral.lodMinClamp,
    lodMaxClamp: 32,
  };
  assert.equal(gate(sampler, appliedState), false);
  t.diagnostic(
    "MUTATION RED: an applied lodMaxClamp of 32 cannot pass a requested level-zero literal",
  );
});

test("Moon pre-positioning precedes readiness", (t) => {
  const sequence = harnessReadinessSequence(normalizedProbeSource);
  assert.equal(prepositionPrecedesReadiness(sequence), true);
  const removed = sequence.replace(
    "globalThis.__c12MoonMipMotionProbe.positionForReadiness(count)",
    "undefined",
  );
  assert.equal(prepositionPrecedesReadiness(removed), false);
  t.diagnostic(
    "MUTATION RED: removing the Moon pre-position call invalidates readiness order",
  );
});

test("the readiness wall-clock deadline is pinned to twenty seconds", (t) => {
  const sequence = harnessReadinessSequence(normalizedProbeSource);
  assert.equal(harnessReadinessDeadlineMs(sequence), 20_000);
  const relaxed = sequence.replace(
    "waitForReadiness(20_000)",
    "waitForReadiness(60_000)",
  );
  assert.equal(harnessReadinessDeadlineMs(relaxed), 60_000);
  t.diagnostic(
    "MUTATION RED: restoring the sixty second readiness deadline breaks the pinned bound",
  );
});

test("force-lod0 install binds a base-level-only sampler at the call site", (t) => {
  const gate = loadWebGPUBaseLevelGate(normalizedProbeSource);
  const device = { createSampler: (descriptor) => ({ descriptor }) };
  assert.match(
    normalizedProbeSource,
    /baseLevelOnly: webGPUBaseLevelOnly\(\s*cache\.sampler,\s*appliedSamplerState,\s*\)/u,
  );

  const applied = loadForceLod0SamplerInstall(normalizedProbeSource)(
    {},
    device,
    gate,
  );
  assert.equal(applied.baseLevelOnly, true);
  assert.equal(applied.samplerState.live, true);
  assert.equal(applied.samplerState.lodMinClamp, 0);
  assert.equal(applied.samplerState.lodMaxClamp, 0);

  const clampAnchor = "          lodMaxClamp: 0,\n        };";
  assert.equal(normalizedProbeSource.split(clampAnchor).length - 1, 1);
  const clamped = loadForceLod0SamplerInstall(
    normalizedProbeSource.replace(
      clampAnchor,
      "          lodMaxClamp: 32,\n        };",
    ),
  )({}, device, gate);
  assert.equal(clamped.baseLevelOnly, false);
  assert.equal(clamped.samplerState.lodMaxClamp, 32);

  const installAnchor =
    "        cache.sampler = appliedSamplerState.sampler;\n";
  assert.equal(normalizedProbeSource.split(installAnchor).length - 1, 1);
  const uninstalled = loadForceLod0SamplerInstall(
    normalizedProbeSource.replace(installAnchor, ""),
  )({}, device, gate);
  assert.equal(uninstalled.baseLevelOnly, false);
  assert.equal(uninstalled.samplerState.live, false);
  t.diagnostic(
    "MUTATION RED: a non-zero descriptor clamp and a skipped sampler install both fail the force-lod0 gate",
  );
});

test("both Moon statistics shapes publish all texture dimensions", (t) => {
  const fields = [
    "moonTextureWidth",
    "moonTextureHeight",
    "normalTextureWidth",
    "normalTextureHeight",
  ];
  const webgpuState = {
    moonTextureWidth: 2048,
    moonTextureHeight: 1024,
    normalTextureWidth: 1024,
    normalTextureHeight: 512,
  };
  const webglState = {
    _albedoMapTexture: { width: 2048, height: 1024 },
    _normalMapTexture: { width: 1024, height: 512 },
  };
  assert.deepEqual(
    loadPublishedDimensionShape(
      webgpuEnvironmentRendererSource,
      "webgpu",
      webgpuState,
    ),
    { backend: "webgpu", ...webgpuState },
  );
  assert.deepEqual(
    loadPublishedDimensionShape(moonSource, "webgl", webglState),
    {
      backend: "webgl",
      moonTextureWidth: 2048,
      moonTextureHeight: 1024,
      normalTextureWidth: 1024,
      normalTextureHeight: 512,
    },
  );

  for (const [backend, source, state] of [
    ["webgpu", webgpuEnvironmentRendererSource, webgpuState],
    ["webgl", moonSource, webglState],
  ]) {
    for (const field of fields) {
      const mutated = removePublishedDimension(source, field);
      assert.equal(mutated === source, false, `${backend}/${field} mutant bit`);
      const shape = loadPublishedDimensionShape(mutated, backend, state);
      assert.equal(Object.hasOwn(shape, field), false);
      t.diagnostic(
        `MUTATION RED: removing ${backend}.${field} loses a published dimension`,
      );
    }
  }
});

test("both Moon statistics shapes derive maxLod from the published mip count", (t) => {
  assert.deepEqual(
    loadWebGPUMipDerivation(webgpuEnvironmentRendererSource, 2048, 1024),
    { mipLevelCount: 12, maxLod: 11 },
  );
  for (const [channel, prefix, count] of [
    ["albedo", "moon", 12],
    ["normal", "normal", 11],
  ]) {
    const shape = loadWebGLPublishedMipShape(moonSource, channel, count);
    assert.equal(shape[`${prefix}TextureMipLevelCount`], count);
    assert.equal(shape[`${prefix}TextureMaxLod`], count - 1);
    const absent = loadWebGLPublishedMipShape(moonSource, channel, null);
    assert.equal(absent[`${prefix}TextureMaxLod`], null);
  }

  const webgpuAnchor = "maxLod: mipLevelCount - 1,";
  assert.equal(
    webgpuEnvironmentRendererSource.split(webgpuAnchor).length - 1,
    1,
  );
  assert.deepEqual(
    loadWebGPUMipDerivation(
      webgpuEnvironmentRendererSource.replace(
        webgpuAnchor,
        "maxLod: mipLevelCount,",
      ),
      2048,
      1024,
    ),
    { mipLevelCount: 12, maxLod: 12 },
  );

  const webglAnchor =
    "albedoMipLevelCount === null ? null : albedoMipLevelCount - 1,";
  assert.equal(moonSource.split(webglAnchor).length - 1, 1);
  assert.equal(
    loadWebGLPublishedMipShape(
      moonSource.replace(
        webglAnchor,
        "albedoMipLevelCount === null ? null : albedoMipLevelCount,",
      ),
      "albedo",
      12,
    ).moonTextureMaxLod,
    12,
  );
  t.diagnostic(
    "MUTATION RED: breaking either maxLod derivation loses the mipLevelCount minus one invariant",
  );
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
  assert.equal(pending.exitCode, EXIT_CODES.STRUCTURAL);
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

test("principal-component metrics expose one stray pixel without changing the frozen bounding metric", () => {
  const clean = syntheticDiscMetric({ diameter: 240, canvasSize: 500 });
  const polluted = syntheticDiscMetric({
    diameter: 240,
    canvasSize: 500,
    stray: true,
  });

  assert.equal(clean.strayLitPixels, 0);
  assert.equal(clean.discDiameterPx, 240);
  assert.deepEqual(clean.illuminatedBounds, clean.principalComponentBounds);
  assert.equal(polluted.strayLitPixels, 1);
  assert.deepEqual(
    polluted.principalComponentBounds,
    clean.principalComponentBounds,
  );
  assert.equal(polluted.discDiameterPx, 370);
  assert.equal(polluted.illuminatedBounds.width, 370);
  assert.equal(polluted.illuminatedBounds.height, 370);
});

test("the minified disc routes one isolated pixel through the same component metric", () => {
  const clean = syntheticDiscMetric({ diameter: 16, canvasSize: 64 });
  const polluted = syntheticDiscMetric({
    diameter: 16,
    canvasSize: 64,
    stray: true,
  });

  assert.equal(clean.strayLitPixels, 0);
  assert.equal(clean.discDiameterPx, 16);
  assert.equal(polluted.strayLitPixels, 1);
  assert.deepEqual(
    polluted.principalComponentBounds,
    clean.principalComponentBounds,
  );
  assert.equal(polluted.discDiameterPx, 40);
});

test("background pollution is structural before framing while clean frames stay unchanged", () => {
  for (const fixture of [
    {
      laneId: "close",
      diameter: 240,
      canvasSize: 500,
      expectedDiameter: 370,
      expectedBand: "132-348",
    },
    {
      laneId: "minified-16px",
      diameter: 16,
      canvasSize: 64,
      expectedDiameter: 40,
      expectedBand: "8-28",
    },
  ]) {
    const laneDefinition = MOON_MIP_MOTION_LANES.find(
      (lane) => lane.id === fixture.laneId,
    );
    const clean = syntheticDiscMetric({
      diameter: fixture.diameter,
      canvasSize: fixture.canvasSize,
    });
    const polluted = syntheticDiscMetric({
      diameter: fixture.diameter,
      canvasSize: fixture.canvasSize,
      stray: true,
    });
    assert.deepEqual(
      structuralFramingFailures(probeSource, laneDefinition, clean),
      [],
    );
    assert.deepEqual(
      structuralFramingFailures(probeSource, laneDefinition, polluted),
      [
        `${fixture.laneId}/webgl frame 0: 1 stray lit pixel(s) outside the principal disc - background is not black`,
        `${fixture.laneId}/webgl measured ${fixture.expectedDiameter}px, outside structural framing band ${fixture.expectedBand}px`,
      ],
    );
  }
});

test("mutation control catches an inert black-background precondition", (t) => {
  const anchor = "if (strayLitPixels > 0) {";
  assert.equal(probeSource.split(anchor).length - 1, 1);
  const mutatedSource = probeSource.replace(
    anchor,
    "if (false && strayLitPixels > 0) {",
  );
  const laneDefinition = MOON_MIP_MOTION_LANES.find(
    (lane) => lane.id === "close",
  );
  const polluted = syntheticDiscMetric({
    diameter: 240,
    canvasSize: 500,
    stray: true,
  });
  const expected =
    "close/webgl frame 0: 1 stray lit pixel(s) outside the principal disc - background is not black";
  const productionFailures = structuralFramingFailures(
    probeSource,
    laneDefinition,
    polluted,
  );
  const mutantFailures = structuralFramingFailures(
    mutatedSource,
    laneDefinition,
    polluted,
  );
  assert.equal(productionFailures[0], expected);
  assert.notEqual(mutantFailures[0], expected);
  assert.deepEqual(mutantFailures, [
    "close/webgl measured 370px, outside structural framing band 132-348px",
  ]);
  t.diagnostic(`MUTATION RED: inert check lost ${expected}`);
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
  assert.equal(PAIRED_SENSITIVITY_MINIMUM_EFFECT, 1e-9);
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
      (comparison) =>
        comparison.controlStrictlyWorse &&
        comparison.controlMinusNormal >= comparison.minimumControlMinusNormal &&
        comparison.minimumControlMinusNormal ===
          PAIRED_SENSITIVITY_MINIMUM_EFFECT,
    ),
  );

  const numericallyDifferentOnly = syntheticSensitivityReport(
    "force-lod0",
    0.2 + 1e-15,
  );
  const negligible = evaluatePairedReportSensitivity(
    normal,
    numericallyDifferentOnly,
  );
  assert.equal(negligible.verdict, "FAIL");
  assert.ok(
    negligible.failures.every((failure) =>
      failure.includes("derived minimum effect"),
    ),
    "the historical 1e-15 false green must fail every fixed sensitivity cell",
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

test("uncalibrated quality is explicitly INCONCLUSIVE with hard 0/1/2/3 exits", () => {
  assert.equal(CALIBRATED_THRESHOLDS, null);
  // The inconclusive verdict leaves with 3 (the lane could not see its
  // subject), not 2 (the harness broke) — the two tiers are distinct again.
  assert.deepEqual(EXIT_CODES, {
    PASS: 0,
    FAIL: 1,
    HARNESS: 2,
    STRUCTURAL: 3,
  });
  // The literals above are the readable form; these equalities are what
  // keeps them the fleet's numerals instead of a seventh private copy of
  // the table. HARNESS is this probe's name for the ERROR tier.
  assert.equal(EXIT_CODES.PASS, S5_STATUS_EXIT_CODES.PASS);
  assert.equal(EXIT_CODES.FAIL, S5_STATUS_EXIT_CODES.FAIL);
  assert.equal(EXIT_CODES.HARNESS, S5_STATUS_EXIT_CODES.ERROR);
  assert.equal(EXIT_CODES.STRUCTURAL, S5_STATUS_EXIT_CODES.STRUCTURAL);
  assert.equal(decideVerdict([], [], null).verdict, "INCONCLUSIVE");
  assert.equal(decideVerdict([], [], null).exitCode, 3);
  assert.equal(decideVerdict(["fault"], [], null).verdict, "FAIL");
  assert.equal(decideVerdict(["fault"], [], null).exitCode, 1);
  assert.equal(decideVerdict([], [], {}).verdict, "FAIL");
  assert.equal(decideVerdict([], [], {}).exitCode, 1);
  assert.equal(
    deriveMeasurementStatus(decideVerdict([], [], null), null),
    "CALIBRATION_PENDING",
  );
});
