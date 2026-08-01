#!/usr/bin/env node
/**
 * Campaign 13 C13-37 baked-density periodicity oracle. WebGPU-only.
 *
 * Two full-resolution, temporal-off scenes are captured as a same-build
 * legacy/new density-domain × baked/live × midpoint/IGN factorial. The probe
 * changes only qualityFlags bits 0, 3, and 13 after the cloud renderer has
 * packed and uploaded slot 74. It requires the renderer to be recording into
 * Scene's main command encoder;
 * otherwise the original renderer may already have submitted an orphan encoder
 * and the diagnostic override would be too late, so the artifact fails closed.
 *
 * This is visual-quality characterization, not performance evidence. The first
 * revision does not cross a density-cell boundary and cannot certify temporal
 * history, weather-map seams, cloud shadows, masks, or capture paths.
 *
 * Usage:
 *   node Tools/visual-regression/probe-cloud-density-domain.mjs
 *   TAG=before CLOUD_DENSITY_PAIR_ID=c13-37-001 node Tools/visual-regression/probe-cloud-density-domain.mjs
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { chromium } from "playwright";

import {
  armWebGPUDevices,
  attachConsoleErrorGate,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import {
  analyzeCloudImages,
  classifyCloudPeriodicityFactorial,
  compareCloudImages,
  decodeCloudPng,
} from "./lib/cloud-image-analysis.mjs";
import { installCloudProbeHarnessOnPage } from "./lib/cloud-probe-harness.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const URL = `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu&offline=true`;
const TAG = process.env.TAG || "current";
const PAIR_ID = process.env.CLOUD_DENSITY_PAIR_ID || null;
const OUT_ROOT = "Tools/visual-regression/output/cloud-density-domain";
const PROBE_VERSION = "c13-37-v2";
const WIDTH = 1024;
const HEIGHT = 768;
const FIXED_TIME = "2026-06-21T18:20:00Z";

if (!/^[a-z0-9][a-z0-9._-]*$/i.test(TAG)) {
  throw new Error(`TAG contains unsupported characters: ${TAG}`);
}
if (PAIR_ID !== null && !/^[a-z0-9][a-z0-9._-]*$/i.test(PAIR_ID)) {
  throw new Error(
    `CLOUD_DENSITY_PAIR_ID contains unsupported characters: ${PAIR_ID}`,
  );
}

// ── HARD watchdog: force-exit if anything hangs (machine safety) ──
// The factorial capture awaits rAF settles and device.queue.onSubmittedWorkDone()
// inside page.evaluate; a GPU hang would otherwise leave headless Edge
// (--enable-unsafe-webgpu) alive indefinitely on a machine with a probe-crash
// history. Unref'd so it never keeps an otherwise-finished process alive.
const HARD_LIMIT_MS = 300000; // 300s
const watchdog = setTimeout(() => {
  console.error("[cloud-density-domain] WATCHDOG FIRED (300s) — forcing exit");
  process.exit(2);
}, HARD_LIMIT_MS);
if (watchdog.unref) watchdog.unref();

const SCENES = [
  {
    name: "near-horizon",
    description:
      "below-deck upward oblique view where the existing converging lattice is strongest",
    camera: {
      lon: -95,
      lat: 39,
      height: 800,
      heading: 90,
      pitch: 25,
    },
  },
  {
    name: "above-deck-oblique",
    description:
      "above-deck oblique view that changes the lattice projection and footprint",
    camera: {
      lon: -95,
      lat: 39,
      height: 9000,
      heading: 40,
      pitch: -25,
    },
  },
];

const VOLUMETRIC_CONFIG = Object.freeze({
  cloudCoverage: 0.6,
  cloudDensity: 0.85,
  cloudLayerBottom: 1500,
  cloudLayerTop: 4000,
  cloudVolumetricQuality: "high",
  cloudWeatherMap: false,
  cloudWindSpeed: 0,
  cloudCastShadows: false,
  cloudHighPrecision: true,
});

// Keep legacy/new controls adjacent so exact-isolation comparisons do not span
// unrelated scene work.
const LANES = [
  { source: "baked", baked: true },
  { source: "live", baked: false },
].flatMap(({ source, baked }) =>
  [
    { phase: "midpoint", ign: false },
    { phase: "ign", ign: true },
  ].flatMap(({ phase, ign }) =>
    ["legacy", "new"].map((domain) => ({
      name: `${domain}-${source}-${phase}`,
      domain,
      newDomain: domain === "new",
      source,
      baked,
      phase,
      ign,
    })),
  ),
);

function command(name, args) {
  try {
    return execFileSync(name, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fileFingerprint(filePath) {
  const bytes = fs.readFileSync(filePath);
  return {
    path: filePath.replaceAll("\\", "/"),
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

function contentFingerprint(label, content) {
  const bytes = Buffer.from(content);
  return {
    path: label,
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

function fingerprintSet(files) {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.sha256);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function sourceProvenance() {
  const workerDirectory = "Build/CesiumUnminified/Workers";
  const workers = fs
    .readdirSync(workerDirectory)
    .filter((name) => /^WebGPUProceduralCloudRenderer-.*\.js$/.test(name))
    .sort();
  if (workers.length !== 1) {
    throw new Error(
      `expected one built procedural-cloud worker, found ${workers.length}: ${workers.join(", ")}`,
    );
  }

  const requiredShaderPaths = [
    {
      name: "procedural-clouds",
      source:
        "packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl",
      built:
        "Build/CesiumUnminified/Shaders/WebGPU/Environment/ProceduralClouds.wgsl",
    },
    {
      name: "cloud-noise-bake",
      source:
        "packages/engine/Source/Shaders/WebGPU/Compute/CloudNoiseBake.wgsl",
      built:
        "Build/CesiumUnminified/Shaders/WebGPU/Compute/CloudNoiseBake.wgsl",
    },
    {
      name: "cloud-noise-mipmap",
      source:
        "packages/engine/Source/Shaders/WebGPU/Compute/CloudNoiseMipmap.wgsl",
      built:
        "Build/CesiumUnminified/Shaders/WebGPU/Compute/CloudNoiseMipmap.wgsl",
    },
  ];
  const densityDomainPaths = {
    name: "cloud-density-domain",
    source:
      "packages/engine/Source/Shaders/WebGPU/Environment/CloudDensityDomain.wgsl",
    built:
      "Build/CesiumUnminified/Shaders/WebGPU/Environment/CloudDensityDomain.wgsl",
  };
  const densityDomainSourcePresent = fs.existsSync(densityDomainPaths.source);
  const densityDomainBuiltPresent = fs.existsSync(densityDomainPaths.built);
  if (densityDomainSourcePresent !== densityDomainBuiltPresent) {
    throw new Error(
      "CloudDensityDomain.wgsl exists in only one of Source/Build; rebuild before capturing",
    );
  }
  const shaderPaths = densityDomainSourcePresent
    ? [...requiredShaderPaths, densityDomainPaths]
    : requiredShaderPaths;
  const shaderPairs = shaderPaths.map((pair) => {
    const source = fileFingerprint(pair.source);
    const built = fileFingerprint(pair.built);
    return {
      name: pair.name,
      source,
      built,
      exactMatch: source.sha256 === built.sha256,
    };
  });

  const sourceMapPath = "Build/CesiumUnminified/index.js.map";
  const sourceMap = JSON.parse(fs.readFileSync(sourceMapPath, "utf8"));
  const tsSourcePaths = [
    "packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts",
    "packages/engine/Source/Renderer/WebGPU/WebGPUCloudNoiseResources.ts",
    "packages/engine/Source/Renderer/WebGPU/WebGPUCloudDensityDomain.ts",
    "packages/engine/Source/Renderer/WebGPU/WebGPUCloudTierPresets.ts",
  ];
  const sourceMapPairs = tsSourcePaths.map((sourcePath) => {
    const normalized = sourcePath.replaceAll("\\", "/");
    const index = sourceMap.sources.findIndex((entry) =>
      entry.replaceAll("\\", "/").endsWith(normalized),
    );
    if (index < 0 || typeof sourceMap.sourcesContent?.[index] !== "string") {
      throw new Error(`missing embedded TypeScript source for ${sourcePath}`);
    }
    const source = fileFingerprint(sourcePath);
    const embedded = contentFingerprint(
      `${sourceMapPath}#${sourceMap.sources[index]}`,
      sourceMap.sourcesContent[index],
    );
    return {
      source,
      embedded,
      exactMatch: source.sha256 === embedded.sha256,
    };
  });
  const sourceFiles = [
    ...shaderPairs.map((pair) => pair.source),
    ...sourceMapPairs.map((pair) => pair.source),
    fileFingerprint("Tools/visual-regression/probe-cloud-density-domain.mjs"),
    fileFingerprint("Tools/visual-regression/lib/cloud-image-analysis.mjs"),
    fileFingerprint("Tools/visual-regression/lib/cloud-probe-harness.mjs"),
    fileFingerprint("Tools/lib/webgpu-error-gate.mjs"),
  ];
  const buildFiles = [
    ...shaderPairs.map((pair) => pair.built),
    fileFingerprint("Build/CesiumUnminified/Cesium.js"),
    fileFingerprint("Build/CesiumUnminified/index.js"),
    fileFingerprint(sourceMapPath),
    fileFingerprint(path.join(workerDirectory, workers[0])),
  ];
  const status = command("git", ["status", "--porcelain"]);
  return {
    commit: command("git", ["rev-parse", "HEAD"]),
    dirty: status === null ? null : status.length > 0,
    shaderPairs,
    densityDomainShaderPresent:
      densityDomainSourcePresent && densityDomainBuiltPresent,
    sourceBuildShadersExact: shaderPairs.every((pair) => pair.exactMatch),
    sourceMapPairs,
    sourceMapTypescriptExact: sourceMapPairs.every((pair) => pair.exactMatch),
    sourceFingerprint: fingerprintSet(sourceFiles),
    buildFingerprint: fingerprintSet(buildFiles),
    sourceFiles,
    buildFiles,
  };
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries
      .map(
        ([key, entryValue]) =>
          `${JSON.stringify(key)}:${stableStringify(entryValue)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function dataUrlBuffer(dataUrl) {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) {
    throw new Error("capture did not return a data URL");
  }
  return Buffer.from(dataUrl.slice(comma + 1), "base64");
}

const CAPTURE_FACTORIAL = async ({ fixedTime, scenes, volumetric, lanes }) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const viewer = globalThis.viewer;
  const scene = viewer.scene;
  const context = scene.context;
  const device = context.device || context._device;
  const collection = scene.globe.defaultCloudCollection;
  const frameTime = C.JulianDate.fromIso8601(fixedTime);
  const QF_NOISE_BAKED = 1;
  const QF_HALF_RES = 2;
  const QF_TEMPORAL = 4;
  const QF_JITTER = 8;
  const QF_NEW_DENSITY_DOMAIN = 8192;

  viewer.useDefaultRenderLoop = false;
  viewer.clock.shouldAnimate = false;
  viewer.clock.currentTime = frameTime;
  scene.requestRenderMode = false;
  scene.globe.show = true;
  scene.globe.enableLighting = false;
  if (scene.skyBox) {
    scene.skyBox.show = false;
  }
  if (scene.skyAtmosphere) {
    scene.skyAtmosphere.show = false;
  }
  if (scene.sun) {
    scene.sun.show = false;
  }
  if (scene.moon) {
    scene.moon.show = false;
  }
  if (scene.fog) {
    scene.fog.enabled = false;
  }
  scene.backgroundColor = C.Color.BLACK;

  const setCamera = (camera) => {
    viewer.camera.setView({
      destination: C.Cartesian3.fromDegrees(
        camera.lon,
        camera.lat,
        camera.height,
      ),
      orientation: {
        heading: C.Math.toRadians(camera.heading),
        pitch: C.Math.toRadians(camera.pitch),
        roll: 0,
      },
    });
  };
  setCamera(scenes[0].camera);

  const configTruth = globalThis.__cloudProbe.configure({
    requireWebGPU: true,
    volumetric,
  });
  const readiness = await globalThis.__cloudProbe.awaitProceduralReady({
    featureRendererKey: C.FeatureRendererKey.PROCEDURAL_CLOUDS,
    frameTime,
  });
  const featureRenderer = context.getFeatureRenderer(
    C.FeatureRendererKey.PROCEDURAL_CLOUDS,
  );
  if (!featureRenderer || typeof featureRenderer.execute !== "function") {
    throw new Error("procedural cloud feature renderer is unavailable");
  }

  const originalExecute = featureRenderer.execute;
  const override = {
    active: false,
    lane: null,
    executeCalls: 0,
    forcedWriteCalls: 0,
    failures: [],
    records: [],
  };
  featureRenderer.execute = function (...args) {
    const renderContext = args[0];
    const hasMainEncoder = Boolean(renderContext?._currentCommandEncoder);
    const result = Reflect.apply(originalExecute, this, args);
    override.executeCalls++;
    if (!override.active) {
      return result;
    }

    const cache = renderContext?._cloudCache;
    const device = renderContext?._device;
    if (!hasMainEncoder) {
      override.failures.push(
        `${override.lane?.name ?? "unknown"}: main command encoder absent`,
      );
      return result;
    }
    if (!cache?.uniformBuffer || !cache?.uniformData || !device?.queue) {
      override.failures.push(
        `${override.lane?.name ?? "unknown"}: cloud uniform resources absent`,
      );
      return result;
    }
    if (!cache.noiseBaked || !cache.noise) {
      override.failures.push(
        `${override.lane?.name ?? "unknown"}: baked noise resources absent`,
      );
      return result;
    }

    const originalFlags = Math.trunc(cache.uniformData[74] ?? 0);
    let forcedFlags = originalFlags;
    forcedFlags = override.lane.baked
      ? forcedFlags | QF_NOISE_BAKED
      : forcedFlags & ~QF_NOISE_BAKED;
    forcedFlags = override.lane.ign
      ? forcedFlags | QF_JITTER
      : forcedFlags & ~QF_JITTER;
    forcedFlags = override.lane.newDomain
      ? forcedFlags | QF_NEW_DENSITY_DOMAIN
      : forcedFlags & ~QF_NEW_DENSITY_DOMAIN;
    cache.uniformData[74] = forcedFlags;
    device.queue.writeBuffer(
      cache.uniformBuffer,
      74 * Float32Array.BYTES_PER_ELEMENT,
      Float32Array.of(forcedFlags),
    );
    override.forcedWriteCalls++;
    override.records.push({
      lane: override.lane.name,
      hadMainEncoder: hasMainEncoder,
      originalFlags,
      forcedFlags,
      halfResolution: (forcedFlags & QF_HALF_RES) !== 0,
      temporal: (forcedFlags & QF_TEMPORAL) !== 0,
      newDensityDomain: (forcedFlags & QF_NEW_DENSITY_DOMAIN) !== 0,
    });
    return result;
  };

  const renderFrames = async (count) => {
    for (let frame = 0; frame < count; frame++) {
      scene.render(frameTime);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  };
  const capture = async () => {
    scene.render(frameTime);
    if (device) {
      await device.queue.onSubmittedWorkDone();
    }
    return scene.canvas.toDataURL("image/png");
  };
  const stabilizeCloudOff = async () => {
    const maximumFrames = 360;
    const requiredConsecutiveMatches = 3;
    let previous = null;
    let dataUrl = null;
    let consecutiveMatches = 0;
    let framesRendered = 0;
    for (; framesRendered < maximumFrames; framesRendered++) {
      scene.render(frameTime);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (device) {
        await device.queue.onSubmittedWorkDone();
      }
      dataUrl = scene.canvas.toDataURL("image/png");
      consecutiveMatches = dataUrl === previous ? consecutiveMatches + 1 : 0;
      if (
        consecutiveMatches >= requiredConsecutiveMatches &&
        scene.globe.tilesLoaded === true
      ) {
        return {
          dataUrl,
          stable: true,
          framesRendered: framesRendered + 1,
          consecutiveMatches,
          globeTilesLoaded: true,
        };
      }
      previous = dataUrl;
    }
    return {
      dataUrl,
      stable: false,
      framesRendered,
      consecutiveMatches,
      globeTilesLoaded: scene.globe.tilesLoaded === true,
    };
  };

  const results = [];
  try {
    for (const sceneDefinition of scenes) {
      setCamera(sceneDefinition.camera);
      collection.enableVolumetric = false;
      override.active = false;
      const stabilization = await stabilizeCloudOff();
      const off = stabilization.dataUrl;

      const laneResults = {};
      for (const lane of lanes) {
        // Clear the post-process snapshot/composite source between lanes. The
        // full-resolution cloud pass composites over a frame snapshot; switching
        // diagnostic bits without an intervening cloud-OFF frame can feed the
        // preceding lane back into the next capture and invalidate the factorial.
        collection.enableVolumetric = false;
        override.active = false;
        await renderFrames(2);
        const laneOffDataUrl = await capture();

        collection.enableVolumetric = true;
        override.active = true;
        override.lane = lane;
        const callsBefore = override.executeCalls;
        const writesBefore = override.forcedWriteCalls;
        await renderFrames(2);
        const dataUrl = await capture();
        const repeatDataUrl = await capture();
        const realization = globalThis.__cloudProbe.proceduralRealization();
        const cache = context._cloudCache;
        laneResults[lane.name] = {
          dataUrl,
          repeatDataUrl,
          laneOffDataUrl,
          realization,
          executeCalls: override.executeCalls - callsBefore,
          forcedWriteCalls: override.forcedWriteCalls - writesBefore,
          lastOverrideRecord: override.records.at(-1) ?? null,
          uniformFloatCount: cache?.uniformData?.length ?? null,
          noiseResources: cache?.noise
            ? {
                noiseBaked: cache.noiseBaked === true,
                shapeRes: cache.noise.shapeRes,
                detailRes: cache.noise.detailRes,
                shapeMipLevelCount:
                  cache.noise.shapeTexture?.mipLevelCount ?? null,
                detailMipLevelCount:
                  cache.noise.detailTexture?.mipLevelCount ?? null,
              }
            : null,
        };
      }
      results.push({
        name: sceneDefinition.name,
        off,
        stabilization: {
          stable: stabilization.stable,
          framesRendered: stabilization.framesRendered,
          consecutiveMatches: stabilization.consecutiveMatches,
          globeTilesLoaded: stabilization.globeTilesLoaded,
        },
        lanes: laneResults,
      });
    }
  } finally {
    override.active = false;
    featureRenderer.execute = originalExecute;
  }

  if (device) {
    await device.queue.onSubmittedWorkDone();
  }
  return {
    results,
    configTruth,
    readiness,
    override: {
      executeCalls: override.executeCalls,
      forcedWriteCalls: override.forcedWriteCalls,
      failures: override.failures,
      recordCount: override.records.length,
    },
    effectiveTimeIso: C.JulianDate.toIso8601(frameTime),
    canvas: {
      width: scene.canvas.width,
      height: scene.canvas.height,
    },
    hasDevice: Boolean(device),
    adapterInfo: context.adapter?.info
      ? {
          vendor: context.adapter.info.vendor || "",
          architecture: context.adapter.info.architecture || "",
          device: context.adapter.info.device || "",
          description: context.adapter.info.description || "",
        }
      : null,
  };
};

function expectedLaneFlags(lane, realization) {
  const flags = Math.trunc(realization?.qualityFlags ?? 0);
  return (
    ((flags & 1) !== 0) === lane.baked &&
    ((flags & 8) !== 0) === lane.ign &&
    ((flags & 8192) !== 0) === lane.newDomain &&
    (flags & 6) === 0
  );
}

function expectedOverrideFlags(lane, record) {
  if (!record) {
    return false;
  }
  const diagnosticMask = 1 | 8 | 8192;
  let expected = record.originalFlags & ~diagnosticMask;
  expected |= lane.baked ? 1 : 0;
  expected |= lane.ign ? 8 : 0;
  expected |= lane.newDomain ? 8192 : 0;
  return (
    record.forcedFlags === expected &&
    ((record.forcedFlags ^ record.originalFlags) & ~diagnosticMask) === 0
  );
}

function hasCompleteMipChain(resolution, mipLevelCount) {
  return (
    Number.isInteger(resolution) &&
    resolution > 0 &&
    mipLevelCount === Math.floor(Math.log2(resolution)) + 1
  );
}

function laneName(domain, source, phase) {
  return `${domain}-${source}-${phase}`;
}

function morphologyRatios(next, legacy) {
  const ratio = (value, baseline) => value / Math.max(Math.abs(baseline), 1e-9);
  return {
    cloudPixels: ratio(next.cloudPixels, legacy.cloudPixels),
    cloudFraction: ratio(next.cloudFraction, legacy.cloudFraction),
    meanSignal: ratio(next.meanSignal, legacy.meanSignal),
    p10Signal: ratio(next.p10Signal, legacy.p10Signal),
    p50Signal: ratio(next.p50Signal, legacy.p50Signal),
    p90Signal: ratio(next.p90Signal, legacy.p90Signal),
    edgeEnergy: ratio(next.edgeEnergy, legacy.edgeEnergy),
    componentCount: ratio(next.componentCount, legacy.componentCount),
    correlationScaleIsNotCompared:
      "directional peak lags are reported separately; no one-to-one morphology golden is implied",
  };
}

// The rotated, non-harmonic density domain intentionally changes individual
// baked formations, so pixel parity would be the wrong oracle. These symmetric
// factor-of-two bounds instead fail gross feature loss, opacity collapse, or
// texture over-smoothing while leaving the domain free to remove repetition.
// Low-tail signal and component count remain diagnostic only: both are unstable
// around the fixed cloud-mask threshold and can swing when formations move.
const MORPHOLOGY_RATIO_BOUNDS = Object.freeze({
  cloudFraction: Object.freeze({ minimum: 0.5, maximum: 2.0 }),
  meanSignal: Object.freeze({ minimum: 0.5, maximum: 2.0 }),
  p50Signal: Object.freeze({ minimum: 0.5, maximum: 2.0 }),
  p90Signal: Object.freeze({ minimum: 0.5, maximum: 2.0 }),
  edgeEnergy: Object.freeze({ minimum: 0.5, maximum: 2.0 }),
});

function morphologyPreservationCheck(scene, ratios) {
  const metrics = Object.entries(MORPHOLOGY_RATIO_BOUNDS).map(
    ([metric, bounds]) => {
      const value = ratios[metric];
      return {
        metric,
        value,
        ...bounds,
        passed: value >= bounds.minimum && value <= bounds.maximum,
      };
    },
  );
  return {
    scene,
    description:
      "new-domain baked morphology stays within a symmetric factor-of-two envelope of the explicit legacy-domain control",
    metrics,
    passed: metrics.every((metric) => metric.passed),
  };
}

function isKnownUnrelatedViewerError(error) {
  if (/favicon\.ico/i.test(error)) {
    return true;
  }
  return (
    /Atmosphere ?LUT|SkyAtmosphere/i.test(error) &&
    /default layout|bind group|pipeline layout/i.test(error)
  );
}

async function main() {
  const source = sourceProvenance();
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const pageErrors = [];
  let browserVersion;
  let gpuConsoleErrors;
  let armState;
  let capture;
  let gpuGate;
  try {
    browserVersion = browser.version();
    const page = await browser.newPage({
      viewport: { width: WIDTH, height: HEIGHT },
    });
    gpuConsoleErrors = attachConsoleErrorGate(page);
    page.on("console", (message) => {
      if (message.type() === "error") {
        pageErrors.push(message.text());
      }
    });
    page.on("pageerror", (error) => {
      pageErrors.push(`pageerror: ${error.message}`);
    });
    await page.addInitScript(errorGateInit);
    await installCloudProbeHarnessOnPage(page);
    await page.goto(URL, {
      waitUntil: "networkidle",
      timeout: 90_000,
    });
    await page.waitForFunction(() => Boolean(globalThis.viewer), undefined, {
      timeout: 90_000,
    });
    armState = await armWebGPUDevices(page);
    capture = await page.evaluate(CAPTURE_FACTORIAL, {
      fixedTime: FIXED_TIME,
      scenes: SCENES,
      volumetric: VOLUMETRIC_CONFIG,
      lanes: LANES,
    });
    gpuGate = await collectGateErrors(page);
  } finally {
    // Success- AND failure-path teardown so a GPU/eval hang or thrown error can
    // never leave headless Edge alive (pairs with the force-exit watchdog above).
    await browser.close();
  }

  const collectedErrors = [
    ...pageErrors,
    ...gpuConsoleErrors,
    ...gpuGate.errors,
    ...(gpuGate.deviceLost ? [gpuGate.deviceLost] : []),
    ...(armState.found < 1 ? ["WebGPU error gate did not find a device"] : []),
  ];
  // Record — rather than silently drop — the known-unrelated viewer errors
  // (favicon 404, SkyAtmosphere default-layout warnings) so the evidence
  // manifest stays auditable instead of hiding filtered console output.
  const knownUnrelatedErrors = [
    ...new Set(collectedErrors.filter(isKnownUnrelatedViewerError)),
  ];
  const uniqueErrors = [
    ...new Set(
      collectedErrors.filter((error) => !isKnownUnrelatedViewerError(error)),
    ),
  ];

  const artifactBuffers = new Map();
  for (const scene of capture.results) {
    artifactBuffers.set(`${scene.name}-off.png`, dataUrlBuffer(scene.off));
    for (const lane of LANES) {
      artifactBuffers.set(
        `${scene.name}-${lane.name}.png`,
        dataUrlBuffer(scene.lanes[lane.name].dataUrl),
      );
      artifactBuffers.set(
        `${scene.name}-${lane.name}-repeat.png`,
        dataUrlBuffer(scene.lanes[lane.name].repeatDataUrl),
      );
      artifactBuffers.set(
        `${scene.name}-${lane.name}-off.png`,
        dataUrlBuffer(scene.lanes[lane.name].laneOffDataUrl),
      );
      delete scene.lanes[lane.name].dataUrl;
      delete scene.lanes[lane.name].repeatDataUrl;
      delete scene.lanes[lane.name].laneOffDataUrl;
    }
    delete scene.off;
  }

  const artifactRecords = [...artifactBuffers.entries()]
    .map(([name, buffer]) => ({
      name,
      byteLength: buffer.byteLength,
      sha256: sha256(buffer),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const artifactSetFingerprint = sha256(stableStringify(artifactRecords));
  const identity = {
    probeVersion: PROBE_VERSION,
    pairId: PAIR_ID,
    tag: TAG,
    sourceFingerprint: source.sourceFingerprint,
    buildFingerprint: source.buildFingerprint,
    artifactSetFingerprint,
    browserVersion,
    adapterInfo: capture.adapterInfo,
    canvas: capture.canvas,
    fixedTime: capture.effectiveTimeIso,
    scenes: SCENES,
    volumetricConfig: VOLUMETRIC_CONFIG,
    lanes: LANES,
  };
  const runId = sha256(stableStringify(identity)).slice(0, 16);
  const pairDirectory = PAIR_ID ?? "characterization";
  const outputDirectory = path.join(OUT_ROOT, pairDirectory, `${TAG}-${runId}`);
  fs.mkdirSync(outputDirectory, { recursive: true });
  for (const [name, buffer] of artifactBuffers) {
    fs.writeFileSync(path.join(outputDirectory, name), buffer);
  }

  const sceneAnalysis = [];
  for (const sceneDefinition of SCENES) {
    const analyses = {};
    const decodedLanes = {};
    const decodedRepeatLanes = {};
    const decodedOffLanes = {};
    const canonicalOff = await decodeCloudPng(
      artifactBuffers.get(`${sceneDefinition.name}-off.png`),
    );
    for (const lane of LANES) {
      const decoded = await decodeCloudPng(
        artifactBuffers.get(`${sceneDefinition.name}-${lane.name}.png`),
      );
      const laneOff = await decodeCloudPng(
        artifactBuffers.get(`${sceneDefinition.name}-${lane.name}-off.png`),
      );
      const decodedRepeat = await decodeCloudPng(
        artifactBuffers.get(`${sceneDefinition.name}-${lane.name}-repeat.png`),
      );
      decodedLanes[lane.name] = decoded;
      decodedRepeatLanes[lane.name] = decodedRepeat;
      decodedOffLanes[lane.name] = laneOff;
      analyses[lane.name] = analyzeCloudImages(decoded, laneOff);
    }
    const factorials = {};
    for (const domain of ["legacy", "new"]) {
      factorials[domain] = classifyCloudPeriodicityFactorial({
        bakedMidpoint: analyses[laneName(domain, "baked", "midpoint")],
        bakedIgn: analyses[laneName(domain, "baked", "ign")],
        liveMidpoint: analyses[laneName(domain, "live", "midpoint")],
        liveIgn: analyses[laneName(domain, "live", "ign")],
      });
    }
    const legacyBakedMidpoint =
      decodedLanes[laneName("legacy", "baked", "midpoint")];
    const newBakedMidpoint = decodedLanes[laneName("new", "baked", "midpoint")];
    const legacyBakedIgn = decodedLanes[laneName("legacy", "baked", "ign")];
    const newBakedIgn = decodedLanes[laneName("new", "baked", "ign")];
    const legacyLiveMidpoint =
      decodedLanes[laneName("legacy", "live", "midpoint")];
    const newLiveMidpoint = decodedLanes[laneName("new", "live", "midpoint")];
    const legacyLiveIgn = decodedLanes[laneName("legacy", "live", "ign")];
    const newLiveIgn = decodedLanes[laneName("new", "live", "ign")];
    const legacyBakedMorphology =
      analyses[laneName("legacy", "baked", "midpoint")].morphology;
    const newBakedMorphology =
      analyses[laneName("new", "baked", "midpoint")].morphology;
    const legacyBakedIgnMorphology =
      analyses[laneName("legacy", "baked", "ign")].morphology;
    const newBakedIgnMorphology =
      analyses[laneName("new", "baked", "ign")].morphology;
    sceneAnalysis.push({
      name: sceneDefinition.name,
      analyses,
      factorials,
      sameBuildDomainComparison: {
        legacyBakedMeanScore: factorials.legacy.bakedMeanScore,
        newBakedMeanScore: factorials.new.bakedMeanScore,
        scoreRatio:
          factorials.new.bakedMeanScore /
          Math.max(factorials.legacy.bakedMeanScore, 1e-9),
        scoreReduction:
          factorials.legacy.bakedMeanScore - factorials.new.bakedMeanScore,
        candidateNoRegression:
          factorials.new.bakedMeanScore <= factorials.legacy.bakedMeanScore,
        morphologyRatios: morphologyRatios(
          newBakedMorphology,
          legacyBakedMorphology,
        ),
        morphologyRatiosByPhase: {
          midpoint: morphologyRatios(newBakedMorphology, legacyBakedMorphology),
          ign: morphologyRatios(
            newBakedIgnMorphology,
            legacyBakedIgnMorphology,
          ),
        },
      },
      branchDifferences: {
        legacyMidpointBakedVsLive: compareCloudImages(
          legacyBakedMidpoint,
          decodedLanes[laneName("legacy", "live", "midpoint")],
        ),
        legacyIgnBakedVsLive: compareCloudImages(
          legacyBakedIgn,
          decodedLanes[laneName("legacy", "live", "ign")],
        ),
        newMidpointBakedVsLive: compareCloudImages(
          newBakedMidpoint,
          decodedLanes[laneName("new", "live", "midpoint")],
        ),
        newIgnBakedVsLive: compareCloudImages(
          newBakedIgn,
          decodedLanes[laneName("new", "live", "ign")],
        ),
        legacyVsNewBakedMidpoint: compareCloudImages(
          legacyBakedMidpoint,
          newBakedMidpoint,
        ),
        legacyVsNewBakedIgn: compareCloudImages(legacyBakedIgn, newBakedIgn),
        legacyVsNewLiveMidpoint: compareCloudImages(
          legacyLiveMidpoint,
          newLiveMidpoint,
        ),
        legacyVsNewLiveIgn: compareCloudImages(legacyLiveIgn, newLiveIgn),
        legacyBakedMidpointVsIgn: compareCloudImages(
          legacyBakedMidpoint,
          legacyBakedIgn,
        ),
        newBakedMidpointVsIgn: compareCloudImages(
          newBakedMidpoint,
          newBakedIgn,
        ),
      },
      offBaselineDifferences: Object.fromEntries(
        LANES.map((lane) => [
          lane.name,
          compareCloudImages(canonicalOff, decodedOffLanes[lane.name]),
        ]),
      ),
      repeatDifferences: Object.fromEntries(
        LANES.map((lane) => [
          lane.name,
          compareCloudImages(
            decodedLanes[lane.name],
            decodedRepeatLanes[lane.name],
          ),
        ]),
      ),
    });
  }

  const laneValidity = [];
  for (const scene of capture.results) {
    for (const lane of LANES) {
      const evidence = scene.lanes[lane.name];
      const morphology = sceneAnalysis.find(
        (entry) => entry.name === scene.name,
      ).analyses[lane.name].morphology;
      laneValidity.push({
        scene: scene.name,
        lane: lane.name,
        passed:
          evidence.executeCalls > 0 &&
          evidence.forcedWriteCalls > 0 &&
          evidence.lastOverrideRecord?.hadMainEncoder === true &&
          evidence.realization?.initialized === true &&
          evidence.realization?.pipelineReady === true &&
          evidence.realization?.maxSteps === 96 &&
          evidence.realization?.halfWidth === 0 &&
          evidence.realization?.halfHeight === 0 &&
          evidence.realization?.temporalWidth === 0 &&
          evidence.realization?.temporalHeight === 0 &&
          expectedLaneFlags(lane, evidence.realization) &&
          expectedOverrideFlags(lane, evidence.lastOverrideRecord) &&
          evidence.uniformFloatCount === 168 &&
          evidence.noiseResources?.noiseBaked === true &&
          hasCompleteMipChain(
            evidence.noiseResources?.shapeRes,
            evidence.noiseResources?.shapeMipLevelCount,
          ) &&
          hasCompleteMipChain(
            evidence.noiseResources?.detailRes,
            evidence.noiseResources?.detailMipLevelCount,
          ) &&
          morphology.cloudPixels > 5000 &&
          morphology.interiorPixels > 1000 &&
          morphology.meanSignal > 0.005,
        evidence: {
          executeCalls: evidence.executeCalls,
          forcedWriteCalls: evidence.forcedWriteCalls,
          realization: evidence.realization,
          lastOverrideRecord: evidence.lastOverrideRecord,
          uniformFloatCount: evidence.uniformFloatCount,
          noiseResources: evidence.noiseResources,
          cloudPixels: morphology.cloudPixels,
          interiorPixels: morphology.interiorPixels,
          meanSignal: morphology.meanSignal,
        },
      });
    }
  }

  const branchDifferenceChecks = sceneAnalysis.map((scene) => ({
    scene: scene.name,
    passed:
      scene.branchDifferences.legacyMidpointBakedVsLive.differentPixels >
        1000 &&
      scene.branchDifferences.legacyIgnBakedVsLive.differentPixels > 1000 &&
      scene.branchDifferences.newMidpointBakedVsLive.differentPixels > 1000 &&
      scene.branchDifferences.newIgnBakedVsLive.differentPixels > 1000 &&
      scene.branchDifferences.legacyVsNewBakedMidpoint.differentPixels > 1000 &&
      scene.branchDifferences.legacyVsNewBakedIgn.differentPixels > 1000 &&
      scene.branchDifferences.legacyVsNewLiveMidpoint.differentPixels === 0 &&
      scene.branchDifferences.legacyVsNewLiveIgn.differentPixels === 0 &&
      scene.branchDifferences.legacyBakedMidpointVsIgn.differentPixels > 1000 &&
      scene.branchDifferences.newBakedMidpointVsIgn.differentPixels > 1000,
    ...scene.branchDifferences,
  }));
  const offBaselineChecks = sceneAnalysis.flatMap((scene) =>
    Object.entries(scene.offBaselineDifferences).map(([lane, comparison]) => ({
      scene: scene.name,
      lane,
      description:
        "every lane starts from the pixel-exact stabilized cloud-OFF background",
      passed: comparison.differentPixels === 0,
      ...comparison,
    })),
  );
  const repeatDeterminismChecks = sceneAnalysis.flatMap((scene) =>
    Object.entries(scene.repeatDifferences).map(([lane, comparison]) => ({
      scene: scene.name,
      lane,
      description:
        "two queue-drained captures of the fixed full-resolution lane are pixel-exact",
      passed: comparison.differentPixels === 0,
      ...comparison,
    })),
  );
  const periodicityChecks = sceneAnalysis.map((scene) => ({
    scene: scene.name,
    ...scene.factorials.new.candidateGate,
    controlDomain: "new",
    legacyBakedMeanScore: scene.sameBuildDomainComparison.legacyBakedMeanScore,
    newBakedMeanScore: scene.sameBuildDomainComparison.newBakedMeanScore,
  }));
  const domainNoRegressionChecks = sceneAnalysis.map((scene) => ({
    scene: scene.name,
    description:
      "new-domain baked periodicity does not exceed the explicit legacy-domain control",
    passed: scene.sameBuildDomainComparison.candidateNoRegression,
    value: scene.sameBuildDomainComparison.newBakedMeanScore,
    limit: scene.sameBuildDomainComparison.legacyBakedMeanScore,
    scoreRatio: scene.sameBuildDomainComparison.scoreRatio,
    scoreReduction: scene.sameBuildDomainComparison.scoreReduction,
  }));
  const morphologyPreservationChecks = sceneAnalysis.flatMap((scene) =>
    Object.entries(scene.sameBuildDomainComparison.morphologyRatiosByPhase).map(
      ([phase, ratios]) => ({
        phase,
        ...morphologyPreservationCheck(scene.name, ratios),
      }),
    ),
  );
  const artifactValid =
    source.densityDomainShaderPresent &&
    source.sourceBuildShadersExact &&
    source.sourceMapTypescriptExact &&
    capture.configTruth?.ok === true &&
    capture.readiness?.ok === true &&
    capture.readiness?.executeCalls > 0 &&
    capture.override.failures.length === 0 &&
    capture.hasDevice &&
    capture.adapterInfo !== null &&
    uniqueErrors.length === 0 &&
    capture.results.every((scene) => scene.stabilization?.stable === true) &&
    offBaselineChecks.every((check) => check.passed) &&
    repeatDeterminismChecks.every((check) => check.passed) &&
    laneValidity.every((check) => check.passed) &&
    branchDifferenceChecks.every((check) => check.passed) &&
    morphologyPreservationChecks.every((check) => check.passed);
  const periodicityCandidatePassed = periodicityChecks.every(
    (check) => check.passed,
  );
  const domainNoRegressionPassed = domainNoRegressionChecks.every(
    (check) => check.passed,
  );

  const manifest = {
    probeVersion: PROBE_VERSION,
    measurementKind: "visual-quality-baked-live-density-periodicity",
    explicitlyNotPerformanceEvidence: true,
    pairId: PAIR_ID,
    tag: TAG,
    runId,
    identity,
    source,
    browserVersion,
    adapterInfo: capture.adapterInfo,
    canvas: capture.canvas,
    fixedTime: capture.effectiveTimeIso,
    url: URL,
    configTruth: capture.configTruth,
    readiness: capture.readiness,
    override: capture.override,
    artifacts: artifactRecords,
    scenes: sceneAnalysis,
    gates: {
      densityDomainShaderPresent: source.densityDomainShaderPresent,
      sourceBuildShadersExact: source.sourceBuildShadersExact,
      sourceMapTypescriptExact: source.sourceMapTypescriptExact,
      sceneStabilization: capture.results.map((scene) => ({
        scene: scene.name,
        ...scene.stabilization,
      })),
      offBaselineChecks,
      repeatDeterminismChecks,
      laneValidity,
      branchDifferenceChecks,
      periodicityChecks,
      domainNoRegressionChecks,
      morphologyPreservationChecks,
      artifactValid,
      periodicityCandidatePassed,
      domainNoRegressionPassed,
    },
    gpuGate: { ...gpuGate, armState },
    errors: uniqueErrors,
    knownUnrelatedErrors,
    limitations: [
      "This v2 probe does not cross a density-region/cell boundary and does not certify cell-origin blending, antimeridian continuity, or pole continuity.",
      "Weather is disabled, so this probe cannot close the separate equirectangular weather-map seam and regional-bounds tasks.",
      "Temporal history and half-resolution reconstruction are disabled by construction; their rejection/reset behavior remains outside this oracle.",
      "Cloud shadows, cloud-aware god-ray masks, environment capture, and atmospheric consumers are disabled and require their own coordinate-contract evidence.",
      "Directional autocorrelation detects bounded screen-space repetition over these cameras and lag ranges; it cannot prove mathematical aperiodicity of finite repeated textures.",
      "The baked/live branches use different density algorithms. Their silhouettes are not visual-parity twins; LIVE instead proves exact legacy/new domain-bit isolation and remains a control for raymarch/screen-space repeat peaks.",
      "The legacy/new bit is an internal same-build diagnostic route, not a public cloud feature flag. Every production feature bit other than density source, ray phase, and domain selection is preserved.",
      "Legacy/new morphology ratios guard gross loss and are not a pixel-parity requirement: changing the density domain intentionally changes individual formations.",
      "The candidate periodicity threshold is a frozen same-build control envelope, not a paired before/after improvement claim. A promotion claim still requires separately built, provenance-compatible source states and manual PNG review.",
      "No CPU or GPU duration is recorded; this artifact is not performance evidence.",
    ],
  };
  const manifestPath = path.join(outputDirectory, "manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(
    `[cloud-density-domain:${TAG}] run=${runId} artifact=${artifactValid ? "VALID" : "INVALID"} periodicity=${periodicityCandidatePassed && domainNoRegressionPassed ? "GREEN" : "RED"}`,
  );
  for (const check of periodicityChecks) {
    console.log(
      `  [${check.passed ? "PASS" : "FAIL"}] ${check.scene}: baked=${check.value.toFixed(6)} live-envelope=${check.limit.toFixed(6)}`,
    );
  }
  for (const check of domainNoRegressionChecks) {
    console.log(
      `  [${check.passed ? "PASS" : "FAIL"}] ${check.scene}: new=${check.value.toFixed(6)} legacy=${check.limit.toFixed(6)} ratio=${check.scoreRatio.toFixed(3)}`,
    );
  }
  console.log(`  manifest=${manifestPath}`);
  console.log(
    "  interpretation=characterization; manual PNG review and a compatible pre/post pair remain required",
  );

  process.exitCode =
    artifactValid && periodicityCandidatePassed && domainNoRegressionPassed
      ? 0
      : 1;
}

await main();
