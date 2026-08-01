#!/usr/bin/env node
/**
 * Campaign 13 C13-05 temporal-history/RTE acceptance probe. WebGPU-only.
 *
 * This is deliberately separate from probe-cloud-temporal.mjs. The older probe
 * remains a visual smoke check; this probe certifies the renderer's production
 * history state machine by observing the exact 60-float upload sent to
 * "CloudTemporalResolve UB".
 *
 * Covered in one deterministic browser session:
 *   - initial seed -> continuous acceptance;
 *   - bounded camera translation/pan without reset;
 *   - >50 km teleports and their next accepted frame;
 *   - continuous antimeridian crossing;
 *   - north-pole, south-pole, and orbit teleports;
 *   - temporal medium -> non-temporal high -> medium re-entry;
 *   - deck-bound and multi-deck topology changes;
 *   - temporal-target resize/reallocation;
 *   - look-away frustum cull -> re-entry when the cull is observable.
 *
 * Uniform diagnostics are packed by the renderer at:
 *   55 current-only/first-frame flag
 *   56 history generation
 *   57 reset-reason mask
 *   58 Scene frame number
 *
 * Usage:
 *   PROBE_BASE=http://localhost:8080 \
 *     node Tools/visual-regression/probe-cloud-temporal-rte.mjs
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
import { installCloudProbeHarnessOnPage } from "./lib/cloud-probe-harness.mjs";

const HARD_LIMIT_MS = 120_000;
const watchdog = setTimeout(() => {
  console.error(
    `[cloud-temporal-rte] WATCHDOG FIRED (${HARD_LIMIT_MS / 1000}s) — forcing exit`,
  );
  process.exit(2);
}, HARD_LIMIT_MS);
watchdog.unref?.();

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const URL = `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu&offline=true`;
const FIXED_TIME = "2026-06-21T18:20:00Z";
const INITIAL_VIEWPORT = Object.freeze({ width: 768, height: 432 });
const RESIZED_VIEWPORT = Object.freeze({ width: 800, height: 450 });
const OUT_DIR = "Tools/visual-regression/output/cloud-temporal-rte";
const MANIFEST_PATH = path.join(OUT_DIR, "manifest.json");
const PROBE_VERSION = "c13-05-temporal-rte-v1";

const RESET = Object.freeze({
  INITIAL: 1 << 0,
  FRAME_GAP: 1 << 2,
  TELEPORT: 1 << 3,
  REACTIVATED: 1 << 7,
  DECK_BOUNDS: 1 << 8,
  MULTI_DECK: 1 << 9,
  RESOURCE: 1 << 10,
});

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
  const sourceMapPath = "Build/CesiumUnminified/index.js.map";
  const sourceMap = JSON.parse(fs.readFileSync(sourceMapPath, "utf8"));
  const typescriptPaths = [
    "packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts",
    "packages/engine/Source/Renderer/WebGPU/WebGPUCloudTemporalHistory.ts",
  ];
  const sourceMapPairs = typescriptPaths.map((sourcePath) => {
    const normalized = sourcePath.replaceAll("\\", "/");
    const sourceIndex = sourceMap.sources.findIndex((entry) =>
      entry.replaceAll("\\", "/").endsWith(normalized),
    );
    if (
      sourceIndex < 0 ||
      typeof sourceMap.sourcesContent?.[sourceIndex] !== "string"
    ) {
      throw new Error(
        `missing embedded TypeScript source in ${sourceMapPath}: ${sourcePath}`,
      );
    }
    const source = fileFingerprint(sourcePath);
    const embedded = contentFingerprint(
      `${sourceMapPath}#${sourceMap.sources[sourceIndex]}`,
      sourceMap.sourcesContent[sourceIndex],
    );
    return {
      source,
      embedded,
      exactMatch: source.sha256 === embedded.sha256,
    };
  });

  const shaderSourcePath =
    "packages/engine/Source/Shaders/WebGPU/Environment/CloudTemporalResolve.wgsl";
  const shaderBuildPath =
    "Build/CesiumUnminified/Shaders/WebGPU/Environment/CloudTemporalResolve.wgsl";
  const shaderPair = {
    source: fileFingerprint(shaderSourcePath),
    built: fileFingerprint(shaderBuildPath),
  };
  shaderPair.exactMatch = shaderPair.source.sha256 === shaderPair.built.sha256;

  const workerDirectory = "Build/CesiumUnminified/Workers";
  const workerPaths = fs
    .readdirSync(workerDirectory)
    .filter((name) => /^WebGPUProceduralCloudRenderer-.*\.js$/.test(name))
    .sort()
    .map((name) => path.join(workerDirectory, name));

  const sourceFiles = [
    ...sourceMapPairs.map((pair) => pair.source),
    shaderPair.source,
    fileFingerprint("Tools/visual-regression/probe-cloud-temporal-rte.mjs"),
    fileFingerprint("Tools/visual-regression/lib/cloud-probe-harness.mjs"),
    fileFingerprint("Tools/lib/webgpu-error-gate.mjs"),
  ];
  const buildFiles = [
    shaderPair.built,
    fileFingerprint("Build/CesiumUnminified/Cesium.js"),
    fileFingerprint("Build/CesiumUnminified/index.js"),
    fileFingerprint(sourceMapPath),
    ...workerPaths.map(fileFingerprint),
  ];
  const status = command("git", ["status", "--porcelain"]);

  return {
    commit: command("git", ["rev-parse", "HEAD"]),
    dirty: status === null ? null : status.length > 0,
    dirtyFingerprint: status === null ? null : sha256(Buffer.from(status)),
    shaderPair,
    sourceMapPairs,
    workerCount: workerPaths.length,
    sourceBuildExact:
      shaderPair.exactMatch && sourceMapPairs.every((pair) => pair.exactMatch),
    sourceFingerprint: fingerprintSet(sourceFiles),
    buildFingerprint: fingerprintSet(buildFiles),
    sourceFiles,
    buildFiles,
  };
}

/**
 * Runs before application JavaScript and instruments only the target uniform
 * upload. Copies are probe-side diagnostics; no production object is mutated.
 */
function installTemporalWriteBufferProbe() {
  const root = globalThis;
  const targetLabel = "CloudTemporalResolve UB";
  const state = {
    targetLabel,
    installed: false,
    installationFailures: [],
    currentStepLabel: null,
    totalWriteBufferCalls: 0,
    uploads: [],
  };
  root.__cloudTemporalWriteProbe = state;

  const queuePrototype = root.GPUQueue?.prototype;
  if (!queuePrototype || typeof queuePrototype.writeBuffer !== "function") {
    state.installationFailures.push(
      "GPUQueue.prototype.writeBuffer unavailable",
    );
    return;
  }

  try {
    const original = queuePrototype.writeBuffer;
    queuePrototype.writeBuffer = function (
      buffer,
      bufferOffset,
      data,
      dataOffset,
      size,
    ) {
      state.totalWriteBufferCalls++;
      try {
        if (buffer?.label === targetLabel) {
          let floats;
          if (ArrayBuffer.isView(data)) {
            const elementOffset = dataOffset ?? 0;
            const elementCount = size ?? data.length - elementOffset;
            const byteOffset =
              data.byteOffset + elementOffset * data.BYTES_PER_ELEMENT;
            floats = new Float32Array(
              data.buffer,
              byteOffset,
              Math.min(60, elementCount),
            );
          } else if (data instanceof ArrayBuffer) {
            const byteOffset = dataOffset ?? 0;
            const byteLength = size ?? data.byteLength - byteOffset;
            floats = new Float32Array(
              data,
              byteOffset,
              Math.min(60, Math.floor(byteLength / 4)),
            );
          }

          if (!floats || floats.length < 60) {
            state.uploads.push({
              step: state.currentStepLabel,
              malformed: true,
              floatCount: floats?.length ?? 0,
            });
          } else {
            const values = Array.from(floats.subarray(0, 60));
            const nonFiniteIndices = [];
            for (let index = 0; index < values.length; index++) {
              if (!Number.isFinite(values[index])) {
                nonFiniteIndices.push(index);
              }
            }
            state.uploads.push({
              step: state.currentStepLabel,
              malformed: false,
              floatCount: values.length,
              bufferOffset: bufferOffset ?? 0,
              sourceType: data?.constructor?.name ?? typeof data,
              sourceDataOffset: dataOffset ?? 0,
              sourceSize: size ?? null,
              firstCurrentOnly: values[55],
              generation: values[56],
              resetReasons: values[57],
              frame: values[58],
              encodedCameraHigh: values.slice(32, 35),
              encodedCameraLow: values.slice(36, 39),
              cameraHeight: values[39],
              cameraDelta: values.slice(40, 43),
              halfResolution: [values[43], values[46]],
              primaryDeck: values.slice(44, 46),
              deckTopology: values.slice(48, 55),
              nonFiniteIndices,
            });
          }
        }
      } catch (error) {
        state.installationFailures.push(
          `writeBuffer observation failed: ${String(error)}`,
        );
      }
      return original.apply(this, arguments);
    };
    state.installed = queuePrototype.writeBuffer !== original;
    if (!state.installed) {
      state.installationFailures.push(
        "GPUQueue.writeBuffer patch did not stick",
      );
    }
  } catch (error) {
    state.installationFailures.push(
      `GPUQueue.writeBuffer patch failed: ${String(error)}`,
    );
  }
}

const INITIAL_SEQUENCE = async ({ fixedTime }) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const viewer = globalThis.viewer;
  const scene = viewer.scene;
  const frameTime = C.JulianDate.fromIso8601(fixedTime);
  const writeProbe = globalThis.__cloudTemporalWriteProbe;

  viewer.useDefaultRenderLoop = false;
  viewer.clock.shouldAnimate = false;
  viewer.clock.currentTime = frameTime;
  scene.requestRenderMode = false;
  scene.taaEnabled = false;
  scene.globe.show = true;
  scene.globe.enableLighting = true;
  scene.skyBox.show = true;
  scene.skyAtmosphere.show = true;
  scene.sun.show = true;

  const baseVolumetric = {
    cloudCoverage: 0.6,
    cloudDensity: 0.85,
    cloudLayerBottom: 1500,
    cloudLayerTop: 4000,
    cloudVolumetricQuality: "high",
    cloudWeatherMap: false,
    cloudWindSpeed: 0,
    cloudMultiDeck: false,
    cloudHighPrecision: true,
  };
  const configTruthHigh = globalThis.__cloudProbe.configure({
    requireWebGPU: true,
    volumetric: baseVolumetric,
  });

  const setCamera = (view) => {
    viewer.camera.setView({
      destination: C.Cartesian3.fromDegrees(view.lon, view.lat, view.height),
      orientation: {
        heading: C.Math.toRadians(view.heading),
        pitch: C.Math.toRadians(view.pitch),
        roll: 0,
      },
    });
  };
  setCamera({
    lon: -95,
    lat: 39,
    height: 9000,
    heading: 0,
    pitch: -25,
  });

  const readiness = await globalThis.__cloudProbe.awaitProceduralReady({
    featureRendererKey: C.FeatureRendererKey.PROCEDURAL_CLOUDS,
    frameTime,
    maxFrames: 120,
  });
  writeProbe.uploads.length = 0;

  const snapshot = () => {
    const cache = scene.context?._cloudCache;
    const history = cache?.temporalHistoryState;
    const cartographic = viewer.camera.positionCartographic;
    const position = viewer.camera.positionWC;
    return {
      cachePresent: Boolean(cache),
      temporalRead: cache?.temporalRead ?? null,
      temporalFirstFrame: cache?.temporalFirstFrame ?? null,
      temporalWidth: cache?.temporalWidth ?? null,
      temporalHeight: cache?.temporalHeight ?? null,
      generation: cache?.temporalHistoryGeneration ?? null,
      resetReasons: cache?.temporalHistoryResetReasons ?? null,
      resetCount: cache?.temporalHistoryResetCount ?? null,
      acceptedFrames: cache?.temporalHistoryAcceptedFrames ?? null,
      history: history
        ? {
            initialized: history.initialized,
            temporalActive: history.temporalActive,
            transformValid: history.transformValid,
            lastHistoryFrameNumber: history.lastHistoryFrameNumber,
          }
        : null,
      canvas: {
        width: scene.canvas.width,
        height: scene.canvas.height,
      },
      camera: {
        x: position.x,
        y: position.y,
        z: position.z,
        longitudeDegrees: C.Math.toDegrees(cartographic.longitude),
        latitudeDegrees: C.Math.toDegrees(cartographic.latitude),
        height: cartographic.height,
      },
    };
  };

  const steps = [];
  const renderStep = async (label) => {
    const before = snapshot();
    const uploadStart = writeProbe.uploads.length;
    writeProbe.currentStepLabel = label;
    scene.requestRender();
    scene.render(frameTime);
    writeProbe.currentStepLabel = null;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const uploads = writeProbe.uploads
      .slice(uploadStart)
      .map((upload) => ({ ...upload }));
    const step = { label, before, after: snapshot(), uploads };
    steps.push(step);
    return step;
  };

  globalThis.__cloudTemporalRuntime = {
    frameTime,
    steps,
    renderStep,
    setCamera,
    snapshot,
  };

  const configTruthMedium = globalThis.__cloudProbe.configure({
    requireWebGPU: true,
    volumetric: { cloudVolumetricQuality: "medium" },
  });

  await renderStep("initial-seed");
  await renderStep("initial-continuous");

  setCamera({
    lon: -94.998,
    lat: 39,
    height: 9000,
    heading: 0,
    pitch: -25,
  });
  await renderStep("bounded-translate-1");
  setCamera({
    lon: -94.998,
    lat: 39,
    height: 9000,
    heading: 5,
    pitch: -25,
  });
  await renderStep("bounded-pan");
  setCamera({
    lon: -94.996,
    lat: 39.001,
    height: 9050,
    heading: 8,
    pitch: -24,
  });
  await renderStep("bounded-translate-pan-2");

  setCamera({
    lon: -80,
    lat: 39,
    height: 9000,
    heading: 25,
    pitch: -25,
  });
  await renderStep("teleport-seed");
  await renderStep("teleport-continuous");

  setCamera({
    lon: 179.6,
    lat: 10,
    height: 9000,
    heading: 90,
    pitch: -10,
  });
  await renderStep("antimeridian-anchor-seed");
  setCamera({
    lon: 179.85,
    lat: 10,
    height: 9000,
    heading: 90,
    pitch: -10,
  });
  await renderStep("antimeridian-east");
  setCamera({
    lon: -179.9,
    lat: 10,
    height: 9000,
    heading: 90,
    pitch: -10,
  });
  await renderStep("antimeridian-cross");

  setCamera({
    lon: 45,
    lat: 89.5,
    height: 20_000,
    heading: 0,
    pitch: -30,
  });
  await renderStep("north-pole-seed");
  await renderStep("north-pole-continuous");

  setCamera({
    lon: -45,
    lat: -89.5,
    height: 20_000,
    heading: 180,
    pitch: -30,
  });
  await renderStep("south-pole-seed");
  await renderStep("south-pole-continuous");

  setCamera({
    lon: -95,
    lat: 39,
    height: 18_000_000,
    heading: 0,
    pitch: -90,
  });
  await renderStep("orbit-seed");
  await renderStep("orbit-continuous");

  const configTruthTierOff = globalThis.__cloudProbe.configure({
    requireWebGPU: true,
    volumetric: { cloudVolumetricQuality: "high" },
  });
  await renderStep("tier-high-off");
  const configTruthTierReentry = globalThis.__cloudProbe.configure({
    requireWebGPU: true,
    volumetric: { cloudVolumetricQuality: "medium" },
  });
  await renderStep("tier-medium-reentry-seed");
  await renderStep("tier-medium-continuous");

  const configTruthDeck = globalThis.__cloudProbe.configure({
    requireWebGPU: true,
    volumetric: {
      cloudLayerBottom: 1600,
      cloudLayerTop: 4200,
    },
  });
  await renderStep("deck-bounds-seed");
  await renderStep("deck-bounds-continuous");

  const configTruthMultiDeck = globalThis.__cloudProbe.configure({
    requireWebGPU: true,
    volumetric: { cloudMultiDeck: true },
  });
  await renderStep("multi-deck-seed");
  await renderStep("multi-deck-continuous");

  const context = scene.context;
  const adapter = context.adapter?.info;
  return {
    readiness,
    configTruth: {
      high: configTruthHigh,
      medium: configTruthMedium,
      tierOff: configTruthTierOff,
      tierReentry: configTruthTierReentry,
      deck: configTruthDeck,
      multiDeck: configTruthMultiDeck,
    },
    adapterInfo: adapter
      ? {
          vendor: adapter.vendor ?? "",
          architecture: adapter.architecture ?? "",
          device: adapter.device ?? "",
          description: adapter.description ?? "",
          backend: adapter.backend ?? "",
        }
      : null,
    steps,
  };
};

async function runResizeSequence(page) {
  await page.setViewportSize(RESIZED_VIEWPORT);
  return await page.evaluate(async () => {
    const runtime = globalThis.__cloudTemporalRuntime;
    globalThis.viewer.resize();
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    await runtime.renderStep("resize-seed");
    await runtime.renderStep("resize-continuous");
    return runtime.steps.slice(-2);
  });
}

async function runLookAwaySequence(page) {
  return await page.evaluate(async () => {
    const runtime = globalThis.__cloudTemporalRuntime;
    runtime.setCamera({
      lon: -95,
      lat: 39,
      height: 18_000_000,
      heading: 0,
      pitch: 90,
    });
    const away = await runtime.renderStep("look-away-cull");
    const cullObserved = away.uploads.length === 0;

    runtime.setCamera({
      lon: -95,
      lat: 39,
      height: 18_000_000,
      heading: 0,
      pitch: -90,
    });
    await runtime.renderStep("look-away-reentry-seed");
    await runtime.renderStep("look-away-continuous");
    return {
      cullObserved,
      steps: runtime.steps.slice(-3),
    };
  });
}

function analyzeEvidence(evidence, gpuGate, armState, errors) {
  const checks = [];
  const addCheck = (name, passed, details) => {
    checks.push({ name, passed: Boolean(passed), details });
  };
  if (!evidence) {
    addCheck("browser evidence captured", false, "no evidence returned");
    return checks;
  }

  const steps = evidence.steps;
  const byLabel = new Map(steps.map((step) => [step.label, step]));
  const uploadFor = (label) => {
    const uploads = byLabel.get(label)?.uploads ?? [];
    return uploads.length === 1 ? uploads[0] : null;
  };
  addCheck(
    "procedural cloud renderer reached an executed, realized state",
    evidence.readiness?.ok === true &&
      evidence.readiness?.executeCalls > 0 &&
      evidence.readiness?.pipelineReady === true,
    evidence.readiness,
  );
  const configEntries = Object.entries(evidence.configTruth ?? {});
  addCheck(
    "every authored tier/deck configuration round-tripped through the live collection",
    configEntries.length > 0 &&
      configEntries.every(([, truth]) => truth?.ok === true),
    evidence.configTruth,
  );
  const oneUploadLabels = [
    "initial-seed",
    "initial-continuous",
    "bounded-translate-1",
    "bounded-pan",
    "bounded-translate-pan-2",
    "teleport-seed",
    "teleport-continuous",
    "antimeridian-anchor-seed",
    "antimeridian-east",
    "antimeridian-cross",
    "north-pole-seed",
    "north-pole-continuous",
    "south-pole-seed",
    "south-pole-continuous",
    "orbit-seed",
    "orbit-continuous",
    "tier-medium-reentry-seed",
    "tier-medium-continuous",
    "deck-bounds-seed",
    "deck-bounds-continuous",
    "multi-deck-seed",
    "multi-deck-continuous",
    "resize-seed",
    "resize-continuous",
    "look-away-reentry-seed",
    "look-away-continuous",
  ];
  if (!evidence.lookAwayCullObserved) {
    oneUploadLabels.push("look-away-cull");
  }
  const zeroUploadLabels = ["tier-high-off"];
  if (evidence.lookAwayCullObserved) {
    zeroUploadLabels.push("look-away-cull");
  }
  addCheck(
    "exactly one temporal uniform upload per active frame",
    oneUploadLabels.every((label) => byLabel.get(label)?.uploads.length === 1),
    Object.fromEntries(
      oneUploadLabels.map((label) => [
        label,
        byLabel.get(label)?.uploads.length ?? -1,
      ]),
    ),
  );
  addCheck(
    "temporal-off and observed-cull frames skip the temporal upload",
    zeroUploadLabels.every((label) => byLabel.get(label)?.uploads.length === 0),
    Object.fromEntries(
      zeroUploadLabels.map((label) => [
        label,
        byLabel.get(label)?.uploads.length ?? -1,
      ]),
    ),
  );

  const baseSeedLabels = [
    "initial-seed",
    "teleport-seed",
    "antimeridian-anchor-seed",
    "north-pole-seed",
    "south-pole-seed",
    "orbit-seed",
    "tier-medium-reentry-seed",
    "deck-bounds-seed",
    "multi-deck-seed",
    "resize-seed",
  ];
  if (evidence.lookAwayCullObserved) {
    baseSeedLabels.push("look-away-reentry-seed");
  }
  const actualSeedLabels = steps.flatMap((step) =>
    step.uploads
      .filter((upload) => upload.firstCurrentOnly === 1)
      .map(() => step.label),
  );
  addCheck(
    "current-only flag is one exactly on expected seed frames",
    JSON.stringify(actualSeedLabels) === JSON.stringify(baseSeedLabels),
    { expected: baseSeedLabels, actual: actualSeedLabels },
  );
  addCheck(
    "all non-seed uploads accept history",
    steps
      .flatMap((step) => step.uploads)
      .every(
        (upload) =>
          upload.firstCurrentOnly === 0 || baseSeedLabels.includes(upload.step),
      ),
    steps.flatMap((step) =>
      step.uploads.map((upload) => ({
        step: step.label,
        firstCurrentOnly: upload.firstCurrentOnly,
      })),
    ),
  );

  const seedNextPairs = [
    ["initial-seed", "initial-continuous"],
    ["teleport-seed", "teleport-continuous"],
    ["antimeridian-anchor-seed", "antimeridian-east"],
    ["north-pole-seed", "north-pole-continuous"],
    ["south-pole-seed", "south-pole-continuous"],
    ["orbit-seed", "orbit-continuous"],
    ["tier-medium-reentry-seed", "tier-medium-continuous"],
    ["deck-bounds-seed", "deck-bounds-continuous"],
    ["multi-deck-seed", "multi-deck-continuous"],
    ["resize-seed", "resize-continuous"],
  ];
  if (evidence.lookAwayCullObserved) {
    seedNextPairs.push(["look-away-reentry-seed", "look-away-continuous"]);
  }
  addCheck(
    "every seed is followed by an accepted frame",
    seedNextPairs.every(
      ([seed, next]) =>
        uploadFor(seed)?.firstCurrentOnly === 1 &&
        uploadFor(next)?.firstCurrentOnly === 0,
    ),
    seedNextPairs.map(([seed, next]) => ({
      seed,
      seedFlag: uploadFor(seed)?.firstCurrentOnly,
      next,
      nextFlag: uploadFor(next)?.firstCurrentOnly,
    })),
  );

  const reasonExpectations = [
    ["initial-seed", RESET.INITIAL | RESET.RESOURCE],
    ["teleport-seed", RESET.TELEPORT],
    ["antimeridian-anchor-seed", RESET.TELEPORT],
    ["north-pole-seed", RESET.TELEPORT],
    ["south-pole-seed", RESET.TELEPORT],
    ["orbit-seed", RESET.TELEPORT],
    ["tier-medium-reentry-seed", RESET.FRAME_GAP | RESET.REACTIVATED],
    ["deck-bounds-seed", RESET.DECK_BOUNDS],
    ["multi-deck-seed", RESET.MULTI_DECK],
    ["resize-seed", RESET.RESOURCE],
  ];
  if (evidence.lookAwayCullObserved) {
    reasonExpectations.push([
      "look-away-reentry-seed",
      RESET.FRAME_GAP | RESET.REACTIVATED,
    ]);
  }
  addCheck(
    "reset-reason masks identify each logical discontinuity",
    reasonExpectations.every(([label, mask]) => {
      const reasons = uploadFor(label)?.resetReasons;
      return Number.isInteger(reasons) && reasons === mask;
    }),
    reasonExpectations.map(([label, mask]) => ({
      label,
      expectedMask: mask,
      actual: uploadFor(label)?.resetReasons,
    })),
  );

  const noResetLabels = [
    "initial-continuous",
    "bounded-translate-1",
    "bounded-pan",
    "bounded-translate-pan-2",
    "teleport-continuous",
    "antimeridian-east",
    "antimeridian-cross",
    "north-pole-continuous",
    "south-pole-continuous",
    "orbit-continuous",
    "tier-medium-continuous",
    "deck-bounds-continuous",
    "multi-deck-continuous",
    "resize-continuous",
    "look-away-continuous",
  ];
  if (!evidence.lookAwayCullObserved) {
    noResetLabels.push("look-away-cull", "look-away-reentry-seed");
  }
  addCheck(
    "continuous frames after each seed avoid coarse compatibility resets",
    noResetLabels.every((label) => uploadFor(label)?.resetReasons === 0),
    Object.fromEntries(
      noResetLabels.map((label) => [
        label,
        uploadFor(label)?.resetReasons ?? null,
      ]),
    ),
  );

  const boundedLabels = [
    "initial-continuous",
    "bounded-translate-1",
    "bounded-pan",
    "bounded-translate-pan-2",
  ];
  const boundedGeneration = uploadFor("initial-continuous")?.generation;
  addCheck(
    "bounded translated/panning motion preserves history generation",
    boundedLabels.every(
      (label) =>
        uploadFor(label)?.generation === boundedGeneration &&
        uploadFor(label)?.firstCurrentOnly === 0 &&
        uploadFor(label)?.resetReasons === 0,
    ),
    boundedLabels.map((label) => ({
      label,
      generation: uploadFor(label)?.generation,
      firstCurrentOnly: uploadFor(label)?.firstCurrentOnly,
      resetReasons: uploadFor(label)?.resetReasons,
    })),
  );

  const logicalGenerationSeeds = new Set(
    reasonExpectations.map(([label]) => label),
  );
  let priorGeneration = 0;
  const generationTrace = [];
  let generationCorrect = true;
  for (const step of steps) {
    const upload = step.uploads.length === 1 ? step.uploads[0] : null;
    if (!upload) {
      continue;
    }
    const isLogicalSeed = logicalGenerationSeeds.has(step.label);
    const expected = isLogicalSeed ? priorGeneration + 1 : priorGeneration;
    if (upload.generation !== expected) {
      generationCorrect = false;
    }
    generationTrace.push({
      label: step.label,
      generation: upload.generation,
      logicalSeed: isLogicalSeed,
    });
    priorGeneration = upload.generation;
  }
  addCheck(
    "history generation advances once per logical reset",
    generationCorrect,
    generationTrace,
  );

  const pingPong = [];
  let pingPongCorrect = true;
  for (const step of steps) {
    if (step.uploads.length === 1) {
      const expected =
        step.label === "resize-seed"
          ? 1
          : (Number(step.before.temporalRead) & 1) ^ 1;
      const passed =
        step.after.temporalRead === expected &&
        step.after.temporalFirstFrame === false;
      pingPong.push({
        label: step.label,
        before: step.before.temporalRead,
        after: step.after.temporalRead,
        expected,
        passed,
      });
      pingPongCorrect &&= passed;
    } else {
      const passed = step.after.temporalRead === step.before.temporalRead;
      pingPong.push({
        label: step.label,
        before: step.before.temporalRead,
        after: step.after.temporalRead,
        expected: step.before.temporalRead,
        passed,
      });
      pingPongCorrect &&= passed;
    }
  }
  addCheck(
    "temporal history ping-pong advances exactly",
    pingPongCorrect,
    pingPong,
  );

  const allUploads = steps.flatMap((step) => step.uploads);
  addCheck(
    "all temporal uniform uploads contain 60 finite floats",
    allUploads.length > 0 &&
      allUploads.every(
        (upload) =>
          upload.malformed === false &&
          upload.floatCount === 60 &&
          upload.nonFiniteIndices.length === 0,
      ),
    allUploads.map((upload) => ({
      step: upload.step,
      floatCount: upload.floatCount,
      malformed: upload.malformed,
      nonFiniteIndices: upload.nonFiniteIndices,
    })),
  );
  addCheck(
    "temporal uniform uploads target the complete Float32 row at offset zero",
    allUploads.length > 0 &&
      allUploads.every(
        (upload) =>
          upload.bufferOffset === 0 &&
          upload.sourceType === "Float32Array" &&
          upload.sourceDataOffset === 0 &&
          (upload.sourceSize === null || upload.sourceSize === 60),
      ),
    allUploads.map((upload) => ({
      step: upload.step,
      bufferOffset: upload.bufferOffset,
      sourceType: upload.sourceType,
      sourceDataOffset: upload.sourceDataOffset,
      sourceSize: upload.sourceSize,
    })),
  );

  const cameraDeltaChecks = [];
  let lastHistoryCamera = null;
  for (const step of steps) {
    const upload = step.uploads.length === 1 ? step.uploads[0] : null;
    if (!upload) {
      continue;
    }
    const currentCamera = [
      step.after.camera.x,
      step.after.camera.y,
      step.after.camera.z,
    ];
    if (upload.firstCurrentOnly === 0 && lastHistoryCamera) {
      // eslint-disable-next-line no-loop-func -- the closure is consumed inside this iteration (or reads a shared kill switch), not a stale per-iteration binding
      const expected = currentCamera.map((value, index) =>
        Math.fround(value - lastHistoryCamera[index]),
      );
      const absoluteError = expected.map((value, index) =>
        Math.abs(upload.cameraDelta[index] - value),
      );
      cameraDeltaChecks.push({
        label: step.label,
        expected,
        actual: upload.cameraDelta,
        absoluteError,
        passed: absoluteError.every((error) => error <= 0.02),
      });
    }
    // Every active temporal pass writes history, including a current-only seed.
    lastHistoryCamera = currentCamera;
  }
  addCheck(
    "accepted history uploads use currentWC minus last history-writing camera",
    cameraDeltaChecks.length > 0 &&
      cameraDeltaChecks.every((entry) => entry.passed),
    cameraDeltaChecks,
  );

  const rteErrors = [];
  for (const step of steps) {
    const upload = step.uploads.length === 1 ? step.uploads[0] : null;
    if (!upload) {
      continue;
    }
    const encoded = upload.encodedCameraHigh.map(
      (high, index) => high + upload.encodedCameraLow[index],
    );
    const actual = [
      step.after.camera.x,
      step.after.camera.y,
      step.after.camera.z,
    ];
    const error = Math.hypot(
      encoded[0] - actual[0],
      encoded[1] - actual[1],
      encoded[2] - actual[2],
    );
    const heightError = Math.abs(
      upload.cameraHeight - step.after.camera.height,
    );
    rteErrors.push({
      label: step.label,
      cameraReconstructionErrorMeters: error,
      heightErrorMeters: heightError,
    });
  }
  addCheck(
    "encoded high/low RTE camera reconstructs globally within one meter",
    rteErrors.length > 0 &&
      rteErrors.every(
        (entry) =>
          entry.cameraReconstructionErrorMeters <= 1 &&
          entry.heightErrorMeters <= 1,
      ),
    rteErrors,
  );

  const globalLabels = [
    "antimeridian-east",
    "antimeridian-cross",
    "north-pole-seed",
    "south-pole-seed",
    "orbit-seed",
  ];
  addCheck(
    "antimeridian, poles, and orbit keep finite RTE temporal diagnostics",
    globalLabels.every((label) => {
      const upload = uploadFor(label);
      return (
        upload &&
        upload.nonFiniteIndices.length === 0 &&
        upload.encodedCameraHigh.every(Number.isFinite) &&
        upload.encodedCameraLow.every(Number.isFinite) &&
        upload.cameraDelta.every(Number.isFinite)
      );
    }),
    globalLabels.map((label) => ({
      label,
      cameraDelta: uploadFor(label)?.cameraDelta,
      encodedCameraHigh: uploadFor(label)?.encodedCameraHigh,
      encodedCameraLow: uploadFor(label)?.encodedCameraLow,
    })),
  );

  const initialSeed = byLabel.get("initial-seed");
  const resizeSeed = byLabel.get("resize-seed");
  addCheck(
    "resize reallocates half-resolution temporal history and seeds once",
    resizeSeed?.after.temporalWidth !== initialSeed?.after.temporalWidth &&
      resizeSeed?.after.temporalHeight !== initialSeed?.after.temporalHeight &&
      resizeSeed?.after.temporalWidth ===
        Math.floor(resizeSeed?.after.canvas.width * 0.5) &&
      resizeSeed?.after.temporalHeight ===
        Math.floor(resizeSeed?.after.canvas.height * 0.5) &&
      uploadFor("resize-seed")?.firstCurrentOnly === 1 &&
      uploadFor("resize-continuous")?.firstCurrentOnly === 0,
    {
      initial: {
        canvas: initialSeed?.after.canvas,
        temporal: [
          initialSeed?.after.temporalWidth,
          initialSeed?.after.temporalHeight,
        ],
      },
      resized: {
        canvas: resizeSeed?.after.canvas,
        temporal: [
          resizeSeed?.after.temporalWidth,
          resizeSeed?.after.temporalHeight,
        ],
      },
    },
  );

  addCheck(
    "medium-high-medium transition marks history inactive then reseeds",
    byLabel.get("tier-high-off")?.after.history?.temporalActive === false &&
      uploadFor("tier-medium-reentry-seed")?.firstCurrentOnly === 1 &&
      byLabel.get("tier-medium-reentry-seed")?.after.history?.temporalActive ===
        true,
    {
      high: byLabel.get("tier-high-off")?.after.history,
      reentry: byLabel.get("tier-medium-reentry-seed")?.after.history,
    },
  );

  addCheck(
    "deck and topology uniforms match the authored reset",
    uploadFor("deck-bounds-seed")?.primaryDeck[0] === 1600 &&
      uploadFor("deck-bounds-seed")?.primaryDeck[1] === 4200 &&
      uploadFor("multi-deck-seed")?.deckTopology[6] === 1,
    {
      deck: uploadFor("deck-bounds-seed")?.primaryDeck,
      multiDeckTopology: uploadFor("multi-deck-seed")?.deckTopology,
    },
  );

  addCheck(
    "look-away cull re-entry reseeds when the cull is observable",
    evidence.lookAwayCullObserved
      ? byLabel.get("look-away-cull")?.after.history?.temporalActive ===
          false && uploadFor("look-away-reentry-seed")?.firstCurrentOnly === 1
      : uploadFor("look-away-cull")?.firstCurrentOnly === 0 &&
          uploadFor("look-away-reentry-seed")?.firstCurrentOnly === 0,
    {
      cullObserved: evidence.lookAwayCullObserved,
      awayUploads: byLabel.get("look-away-cull")?.uploads.length,
      awayHistory: byLabel.get("look-away-cull")?.after.history,
      reentry: uploadFor("look-away-reentry-seed"),
    },
  );

  addCheck(
    "GPUQueue target instrumentation installed cleanly",
    evidence.instrumentation.installed === true &&
      evidence.instrumentation.installationFailures.length === 0 &&
      evidence.instrumentation.uploadCount === allUploads.length,
    evidence.instrumentation,
  );
  addCheck(
    "WebGPU error gate is armed and clean",
    armState?.found >= 1 &&
      gpuGate?.armedDevices >= 1 &&
      gpuGate?.errors.length === 0 &&
      gpuGate?.deviceLost === null &&
      errors.length === 0,
    { armState, gpuGate, errors },
  );
  return checks;
}

async function main() {
  const startedAt = Date.now();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let sourceAtStart;
  let sourceAtEnd;
  let browser;
  let browserVersion = null;
  let gpuConsoleErrors = [];
  let gpuGate = { errors: [], deviceLost: null, armedDevices: 0 };
  let armState = { armed: 0, found: 0, total: 0 };
  let evidence = null;
  let fatalError = null;

  try {
    sourceAtStart = sourceProvenance();
    browser = await chromium.launch({
      channel: "msedge",
      headless: true,
      args: ["--enable-unsafe-webgpu"],
    });
    browserVersion = browser.version();
    const page = await browser.newPage({ viewport: INITIAL_VIEWPORT });
    gpuConsoleErrors = attachConsoleErrorGate(page);
    await page.addInitScript(errorGateInit);
    await page.addInitScript(installTemporalWriteBufferProbe);
    await installCloudProbeHarnessOnPage(page);
    await page.goto(URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForFunction(() => Boolean(globalThis.viewer), undefined, {
      timeout: 60_000,
    });
    armState = await armWebGPUDevices(page);

    const initial = await page.evaluate(INITIAL_SEQUENCE, {
      fixedTime: FIXED_TIME,
    });
    const resizeSteps = await runResizeSequence(page);
    const lookAway = await runLookAwaySequence(page);
    gpuGate = await collectGateErrors(page);
    const instrumentation = await page.evaluate(() => {
      const state = globalThis.__cloudTemporalWriteProbe;
      return {
        installed: state.installed,
        installationFailures: state.installationFailures.slice(),
        targetLabel: state.targetLabel,
        totalWriteBufferCalls: state.totalWriteBufferCalls,
        uploadCount: state.uploads.length,
      };
    });
    evidence = {
      ...initial,
      steps: [...initial.steps, ...resizeSteps, ...lookAway.steps],
      lookAwayCullObserved: lookAway.cullObserved,
      instrumentation,
    };
  } catch (error) {
    fatalError = error?.stack || String(error);
  } finally {
    await browser?.close().catch(() => {});
  }

  try {
    sourceAtEnd = sourceProvenance();
  } catch (error) {
    fatalError ??= error?.stack || String(error);
  }

  const errors = [...new Set(gpuConsoleErrors)];
  const checks = analyzeEvidence(evidence, gpuGate, armState, errors);
  const elapsedMs = Date.now() - startedAt;
  const provenanceStable =
    sourceAtStart?.sourceFingerprint === sourceAtEnd?.sourceFingerprint &&
    sourceAtStart?.buildFingerprint === sourceAtEnd?.buildFingerprint;
  checks.push({
    name: "source and served build are exact and stable",
    passed:
      sourceAtStart?.sourceBuildExact === true &&
      sourceAtEnd?.sourceBuildExact === true &&
      provenanceStable,
    details: {
      startExact: sourceAtStart?.sourceBuildExact ?? false,
      endExact: sourceAtEnd?.sourceBuildExact ?? false,
      provenanceStable,
    },
  });
  checks.push({
    name: "probe completes within the 90 second machine-safety budget",
    passed: elapsedMs < 90_000,
    details: { elapsedMs, limitMs: 90_000 },
  });
  checks.push({
    name: "probe completed without a fatal harness error",
    passed: fatalError === null,
    details: fatalError,
  });

  const failedChecks = checks
    .filter((check) => !check.passed)
    .map((check) => check.name);
  const manifest = {
    probeVersion: PROBE_VERSION,
    measurementKind: "cloud-temporal-history-state-and-rte-correctness",
    explicitlyNotPerformanceEvidence: true,
    generatedAt: new Date().toISOString(),
    elapsedMs,
    url: URL,
    fixedTime: FIXED_TIME,
    browserVersion,
    initialViewport: INITIAL_VIEWPORT,
    resizedViewport: RESIZED_VIEWPORT,
    provenance: {
      start: sourceAtStart,
      end: sourceAtEnd,
      stable: provenanceStable,
    },
    adapterInfo: evidence?.adapterInfo ?? null,
    readiness: evidence?.readiness ?? null,
    configTruth: evidence?.configTruth ?? null,
    instrumentation: evidence?.instrumentation ?? null,
    lookAwayCullObserved: evidence?.lookAwayCullObserved ?? null,
    steps: evidence?.steps ?? [],
    gpuGate: { ...gpuGate, armState },
    errors,
    fatalError,
    checks,
    failedChecks,
    limitations: [
      "This probe certifies temporal state transitions and uploaded RTE diagnostics; it is not a ghosting/image-quality metric.",
      "The look-away leg is conditional because platform frustum realization can keep a sliver of the planetary shell visible. Its cull/re-entry assertions become mandatory whenever a zero-upload cull is observed.",
      "Weather/wind/depth rejection and richer per-pixel disocclusion remain the separate C13-12 temporal reconstruction task.",
      "The high tier is used only as the production temporal-off transition; this probe does not compare tier image quality.",
      "No FPS, CPU duration, or GPU timestamp is treated as performance evidence.",
    ],
    artifacts: { manifest: MANIFEST_PATH },
    pass: failedChecks.length === 0,
  };
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`Manifest: ${MANIFEST_PATH}`);
  console.log(
    `Temporal uploads: ${evidence?.instrumentation.uploadCount ?? 0}; ` +
      `look-away cull observed: ${String(evidence?.lookAwayCullObserved)}`,
  );
  console.log(
    `RESULT: ${manifest.pass ? "GREEN" : "RED"} (${elapsedMs}ms)` +
      (failedChecks.length ? ` — ${failedChecks.join("; ")}` : ""),
  );
  process.exitCode = manifest.pass ? 0 : 1;
}

try {
  await main();
} finally {
  clearTimeout(watchdog);
}
