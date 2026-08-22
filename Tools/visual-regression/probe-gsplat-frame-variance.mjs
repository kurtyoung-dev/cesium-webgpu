#!/usr/bin/env node
/**
 * C15-G9 tower frame-variance discriminator harness.
 * @purpose Runs pre-registered D1-D5 gsplat variance discriminators without changing the mutant-pinned 0.050% bar.
 * @status INVESTIGATION
 *
 * D1 always runs first. A frozen-frame read disagreement makes every later
 * pixel number instrument noise, so D2-D5 are not executed in that branch.
 * This probe names measurements and classifications; it does not claim which
 * mechanism the machine lane will observe.
 *
 * Usage:
 *   node Tools/visual-regression/probe-gsplat-frame-variance.mjs --lane=D1
 *   node Tools/visual-regression/probe-gsplat-frame-variance.mjs --lane=D4
 *   node Tools/visual-regression/probe-gsplat-frame-variance.mjs --lane=all
 *
 * Options:
 *   --lane=D1|D2|D3|D4|D5|all   default all
 *   --backend=webgl|webgpu|both  default both
 *   --base=http://localhost:8080 loopback server with the built viewer
 *   --output-directory=<path>    immutable run directories live below it
 *   --headed                     show Edge
 *
 * Exit: PASS 0, FAIL 1, ERROR 2, STRUCTURAL 3 through the shared table.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import {
  armWebGPUDevices,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import {
  compareEvidenceFileSnapshots,
  createImmutableEvidence,
  fingerprintEvidenceFile,
  safeGitHead,
  snapshotEvidenceFiles,
} from "./lib/build-source-identity.mjs";
import { decodeCloudPng } from "./lib/cloud-image-analysis.mjs";
import {
  FRAME_VARIANCE_ASSETS,
  FRAME_VARIANCE_DESIGNS,
  FRAME_VARIANCE_LANE_IDS,
  analyzeSpatialDistribution,
  changedPixelCount,
  createFrameVarianceErrorResult,
  equivalentD2InitialStates,
  evaluateD1FrozenFrame,
  evaluateD2Ordering,
  evaluateD3AssetFramingCross,
  evaluateD4SortedIndexIdentity,
  evaluateD5SpatialDistribution,
  foldFrameVarianceVerdict,
  maxPairwiseChangedPixels,
} from "./lib/gsplat-frame-variance-model.mjs";
import {
  checkEmbeddedFusedSnapshotIsCanonical,
  checkFusedCaptureUsage,
} from "./lib/same-task-capture.mjs";
import { exitCodeForS5Status } from "./lib/verdict-exit-gate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const PROBE_SOURCE_PATH = fileURLToPath(import.meta.url);
const MODEL_SOURCE_PATH = path.join(
  HERE,
  "lib/gsplat-frame-variance-model.mjs",
);
const CAPTURE_SOURCE_PATH = path.join(HERE, "lib/same-task-capture.mjs");
const BUILD_IDENTITY_SOURCE_PATH = path.join(
  HERE,
  "lib/build-source-identity.mjs",
);
const CLOUD_ANALYSIS_SOURCE_PATH = path.join(
  HERE,
  "lib/cloud-image-analysis.mjs",
);
const VERDICT_EXIT_SOURCE_PATH = path.join(HERE, "lib/verdict-exit-gate.mjs");
const WEBGPU_ERROR_GATE_SOURCE_PATH = path.join(
  ROOT,
  "Tools/lib/webgpu-error-gate.mjs",
);
const ENGINE_SORT_SOURCE_PATH = path.join(
  ROOT,
  "packages/engine/Source/Scene/GaussianSplatPrimitive.js",
);
const ENGINE_SORTER_SOURCE_PATH = path.join(
  ROOT,
  "packages/engine/Source/Scene/GaussianSplatSorter.js",
);
const ENGINE_TASK_PROCESSOR_SOURCE_PATH = path.join(
  ROOT,
  "packages/engine/Source/Core/TaskProcessor.js",
);
const ENGINE_SORT_WORKER_SOURCE_PATH = path.join(
  ROOT,
  "packages/engine/Source/Workers/gaussianSplatSorter.js",
);
const ENGINE_SORT_WASM_SOURCE_PATH = path.join(
  ROOT,
  "packages/engine/Source/ThirdParty/wasm_splats_bg.wasm",
);
const BUILD_ENTRY_PATH = path.join(ROOT, "Build/CesiumUnminified/index.js");
const BUILD_SOURCE_MAP_PATH = path.join(
  ROOT,
  "Build/CesiumUnminified/index.js.map",
);
const BUILD_SORT_WORKER_PATH = path.join(
  ROOT,
  "Build/CesiumUnminified/Workers/gaussianSplatSorter.js",
);
const BUILD_SORT_WASM_PATH = path.join(
  ROOT,
  "Build/CesiumUnminified/ThirdParty/wasm_splats_bg.wasm",
);
const SERVED_SOURCE_FILES = Object.freeze(
  [
    {
      key: "buildEntry",
      relative: "/Build/CesiumUnminified/index.js",
      localPath: BUILD_ENTRY_PATH,
      consumed: true,
    },
    {
      key: "buildSourceMap",
      relative: "/Build/CesiumUnminified/index.js.map",
      localPath: BUILD_SOURCE_MAP_PATH,
      consumed: false,
    },
    {
      key: "sortWorker",
      relative: "/Build/CesiumUnminified/Workers/gaussianSplatSorter.js",
      localPath: BUILD_SORT_WORKER_PATH,
      consumed: true,
    },
    {
      key: "sortWasm",
      relative: "/Build/CesiumUnminified/ThirdParty/wasm_splats_bg.wasm",
      localPath: BUILD_SORT_WASM_PATH,
      consumed: true,
    },
    {
      key: "towerTileset",
      relative: FRAME_VARIANCE_ASSETS.tower.url,
      localPath: path.join(ROOT, FRAME_VARIANCE_ASSETS.tower.url.slice(1)),
      consumed: true,
    },
    {
      key: "towerPayload",
      relative: FRAME_VARIANCE_ASSETS.tower.payloadUrl,
      localPath: path.join(
        ROOT,
        FRAME_VARIANCE_ASSETS.tower.payloadUrl.slice(1),
      ),
      consumed: true,
    },
    {
      key: "cubeTileset",
      relative: FRAME_VARIANCE_ASSETS.sh_unit_cube.url,
      localPath: path.join(
        ROOT,
        FRAME_VARIANCE_ASSETS.sh_unit_cube.url.slice(1),
      ),
      consumed: true,
    },
    {
      key: "cubePayload",
      relative: FRAME_VARIANCE_ASSETS.sh_unit_cube.payloadUrl,
      localPath: path.join(
        ROOT,
        FRAME_VARIANCE_ASSETS.sh_unit_cube.payloadUrl.slice(1),
      ),
      consumed: true,
    },
  ].map(Object.freeze),
);
const DEFAULT_OUTPUT = path.join(HERE, "output/gsplat-frame-variance");
const VIEWPORT = Object.freeze({ width: 1024, height: 768 });
const FRAMING_MARGIN_PIXELS = 32;
const FRAMING_CUSHION_PIXELS = 2;
const FRAME_TIME_ISO = "2026-06-01T18:00:00Z";
const CAMERA_PITCH_DEGREES = -30;
const CAMERA_HEADINGS = Object.freeze({ A: 0, B: 120, RESET: 240 });
const READINESS_TIMEOUT_MS = 120_000;
const PAGE_TIMEOUT_MS = 180_000;
const SORT_QUIESCE_WINDOW_MS = 2_000;
const SORT_QUIESCE_TIMEOUT_MS = 45_000;
const CLOSE_TIMEOUT_MS = 15_000;
const BROWSER_CLOSE_TIMEOUT_MS = 30_000;
const IN_RUN_WATCHDOG_MS = Number(
  process.env.PROBE_GSPLAT_FRAME_VARIANCE_WATCHDOG_MS ?? 1_200_000,
);
const PROCESS_FUSE_MS = IN_RUN_WATCHDOG_MS + BROWSER_CLOSE_TIMEOUT_MS + 60_000;
const ARTIFACT_SCHEMA = "c15-gsplat-frame-variance-artifact-v1";
const RUNNING_SCHEMA = "c15-gsplat-frame-variance-running-v1";
const TERMINAL_RECEIPT_SCHEMA = "c15-gsplat-frame-variance-terminal-receipt-v1";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function validateLoopbackBase(value) {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("--base must be an uncredentialed loopback HTTP URL");
  }
  return parsed.origin;
}

function parseArguments(argv) {
  const options = {
    lane: "all",
    backend: "both",
    base: process.env.PROBE_BASE ?? "http://localhost:8080",
    outputDirectory: DEFAULT_OUTPUT,
    headed: false,
  };
  for (const argument of argv) {
    if (argument.startsWith("--lane=")) {
      options.lane = argument.slice("--lane=".length);
    } else if (argument.startsWith("--backend=")) {
      options.backend = argument.slice("--backend=".length);
    } else if (argument.startsWith("--base=")) {
      options.base = argument.slice("--base=".length);
    } else if (argument.startsWith("--output-directory=")) {
      options.outputDirectory = path.resolve(
        argument.slice("--output-directory=".length),
      );
    } else if (argument === "--headed") {
      options.headed = true;
    } else if (argument === "--help") {
      options.help = true;
    } else {
      throw new Error(`unknown argument ${argument}`);
    }
  }
  if (
    options.lane !== "all" &&
    !FRAME_VARIANCE_LANE_IDS.includes(options.lane)
  ) {
    throw new Error(
      `--lane must be ${FRAME_VARIANCE_LANE_IDS.join(", ")}, or all`,
    );
  }
  if (!["webgl", "webgpu", "both"].includes(options.backend)) {
    throw new Error("--backend must be webgl, webgpu, or both");
  }
  options.base = validateLoopbackBase(options.base);
  return options;
}

function usage() {
  console.log(
    "Usage: node Tools/visual-regression/probe-gsplat-frame-variance.mjs " +
      "[--lane=D1|D2|D3|D4|D5|all] " +
      "[--backend=webgl|webgpu|both] [--base=http://localhost:8080] " +
      "[--output-directory=DIR] [--headed]",
  );
}

function selectedBackends(value) {
  return value === "both" ? ["webgl", "webgpu"] : [value];
}

function selectedDownstreamLanes(value) {
  if (value === "D1") return [];
  if (value === "all") return FRAME_VARIANCE_LANE_IDS.slice(1);
  return [value];
}

function sourceBoundary() {
  const boundary = {
    probe: PROBE_SOURCE_PATH,
    model: MODEL_SOURCE_PATH,
    fusedCapture: CAPTURE_SOURCE_PATH,
    buildIdentity: BUILD_IDENTITY_SOURCE_PATH,
    cloudImageAnalysis: CLOUD_ANALYSIS_SOURCE_PATH,
    verdictExitGate: VERDICT_EXIT_SOURCE_PATH,
    webgpuErrorGate: WEBGPU_ERROR_GATE_SOURCE_PATH,
    engineSortPredicate: ENGINE_SORT_SOURCE_PATH,
    engineSorter: ENGINE_SORTER_SOURCE_PATH,
    engineTaskProcessor: ENGINE_TASK_PROCESSOR_SOURCE_PATH,
    engineSortWorker: ENGINE_SORT_WORKER_SOURCE_PATH,
    engineSortWasm: ENGINE_SORT_WASM_SOURCE_PATH,
  };
  for (const source of SERVED_SOURCE_FILES) {
    boundary[source.key] = source.localPath;
  }
  return boundary;
}

function assertCapturePreflight() {
  const source = fs.readFileSync(PROBE_SOURCE_PATH, "utf8");
  const failures = [
    ...checkEmbeddedFusedSnapshotIsCanonical(source),
    ...checkFusedCaptureUsage(source),
  ];
  if (failures.length > 0) {
    throw new Error(`fused capture preflight failed: ${failures.join("; ")}`);
  }
}

function beginEvidence(options, runId, sourceStart) {
  fs.mkdirSync(options.outputDirectory, { recursive: true });
  const directory = path.join(options.outputDirectory, runId);
  fs.mkdirSync(directory, { recursive: false });
  const runningPath = path.join(directory, "running.json");
  const running = {
    schema: RUNNING_SCHEMA,
    runId,
    status: "RUNNING",
    startedAt: new Date().toISOString(),
    sourceHead: safeGitHead(ROOT) ?? null,
    selection: { lane: options.lane, backend: options.backend },
    frameTime: FRAME_TIME_ISO,
    viewport: VIEWPORT,
    preRegistration: FRAME_VARIANCE_DESIGNS,
    sourceStart,
  };
  createImmutableEvidence(runningPath, jsonBytes(running));
  const fingerprint = fingerprintEvidenceFile(runningPath);
  if (!fingerprint.exists || fingerprint.byteLength <= 0) {
    throw new Error("write-once RUNNING evidence was not readable after write");
  }
  return {
    runId,
    directory,
    runningPath,
    runningFingerprint: fingerprint,
    receipts: [],
  };
}

function writeImmutableJson(file, value) {
  const bytes = jsonBytes(value);
  createImmutableEvidence(file, bytes);
  const persisted = fs.readFileSync(file);
  if (!persisted.equals(bytes)) {
    throw new Error(
      `${path.basename(file)} changed during write-once readback`,
    );
  }
  return fingerprintEvidenceFile(file);
}

function sealTerminalEvidence(evidence, archive, artifact) {
  if (artifact.retainRunningAuthority === true) {
    throw new Error(
      "refusing to release RUNNING authority with unproven cleanup",
    );
  }
  const fingerprint = writeImmutableJson(archive, artifact);
  const receiptPath = path.join(evidence.directory, "terminal-receipt.json");
  const terminalReceipt = {
    schema: TERMINAL_RECEIPT_SCHEMA,
    runId: evidence.runId,
    status: artifact.status,
    releasedRunningAuthority: {
      file: path.basename(evidence.runningPath),
      sha256: evidence.runningFingerprint.sha256,
      byteLength: evidence.runningFingerprint.byteLength,
    },
    terminalArtifact: {
      file: path.basename(archive),
      sha256: fingerprint.sha256,
      byteLength: fingerprint.byteLength,
    },
  };
  const terminalReceiptFingerprint = writeImmutableJson(
    receiptPath,
    terminalReceipt,
  );
  return {
    artifact,
    archive,
    fingerprint,
    terminalReceipt,
    terminalReceiptPath: receiptPath,
    terminalReceiptFingerprint,
  };
}

function decodeDataUrl(value) {
  if (typeof value !== "string") {
    throw new TypeError("capture data URL is absent");
  }
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/u.exec(value);
  if (!match) throw new Error("capture is not a base64 PNG data URL");
  return Buffer.from(match[1], "base64");
}

function safeCaptureName(value) {
  const name = String(value ?? "");
  // Cell names are camelCase (towerAtTower); letters of either case are safe
  // evidence filenames on every filesystem the fleet runs on.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(name)) {
    throw new Error(`unsafe capture name ${name}`);
  }
  return name;
}

async function persistCaptures(state, evidence, prefix, captures) {
  const frames = new Map();
  const receipts = [];
  for (const capture of captures ?? []) {
    if (!state.accepting) throw new Error("watchdog stopped evidence writes");
    const name = safeCaptureName(`${prefix}-${capture.name}`);
    const bytes = decodeDataUrl(capture.dataUrl);
    // Decode before the first filesystem mutation. If the watchdog fires while
    // decoding, the accepting check below prevents any late evidence write.
    const decoded = await decodeCloudPng(bytes);
    if (!state.accepting) throw new Error("watchdog stopped evidence writes");
    if (
      decoded.width !== VIEWPORT.width ||
      decoded.height !== VIEWPORT.height ||
      decoded.channels < 3
    ) {
      throw new Error(
        `${name} decoded ${decoded.width}x${decoded.height}x${decoded.channels}, expected ${VIEWPORT.width}x${VIEWPORT.height} RGBA-compatible`,
      );
    }
    const file = path.join(evidence.directory, `${name}.png`);
    createImmutableEvidence(file, bytes);
    const persisted = fs.readFileSync(file);
    if (!persisted.equals(bytes)) {
      throw new Error(`${name} persisted bytes differ from fused snapshot`);
    }
    const fingerprint = fingerprintEvidenceFile(file);
    if (fingerprint.sha256 !== sha256(bytes)) {
      throw new Error(`${name} fingerprint does not bind persisted bytes`);
    }
    frames.set(capture.name, decoded);
    const receipt = {
      name: capture.name,
      file: path.relative(ROOT, file).replaceAll("\\", "/"),
      byteLength: fingerprint.byteLength,
      sha256: fingerprint.sha256,
    };
    receipts.push(receipt);
    evidence.receipts.push(receipt);
  }
  return { frames, receipts };
}

function comparisonRecord(left, right) {
  return {
    changedPixels: changedPixelCount(left, right),
    canvasPixels: left.width * left.height,
  };
}

function structuralLane(lane, backend, reasons) {
  const design = FRAME_VARIANCE_DESIGNS[lane];
  return {
    lane,
    backend,
    status: "STRUCTURAL",
    exitCode: exitCodeForS5Status("STRUCTURAL"),
    prediction: design.prediction,
    discrimination: design.discrimination,
    control: design.control,
    classification: "UNCLASSIFIED",
    signalFired: false,
    controlFired: false,
    measurements: {},
    checks: {},
    failures: [],
    structural: reasons,
    notes: [],
  };
}

function withBackend(result, backend) {
  return { ...result, backend };
}

function boundedMessage(error) {
  return String(
    error?.stack ?? error?.message ?? error ?? "unknown error",
  ).slice(0, 16_384);
}

async function closeBounded(target, label, timeoutMs = CLOSE_TIMEOUT_MS) {
  if (!target) {
    return { label, attempted: false, closed: true, timedOut: false };
  }
  let timer;
  try {
    const result = await Promise.race([
      target.close().then(
        () => ({ closed: true, timedOut: false }),
        (error) => ({
          closed: false,
          timedOut: false,
          error: boundedMessage(error),
        }),
      ),
      new Promise((resolve) => {
        timer = setTimeout(
          () => resolve({ closed: false, timedOut: true }),
          timeoutMs,
        );
      }),
    ]);
    return { label, attempted: true, ...result };
  } finally {
    clearTimeout(timer);
  }
}

async function withDeadline(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs} ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function closeActiveResources(state) {
  state.accepting = false;
  const outcomes = [];
  for (const active of [...state.active].reverse()) {
    outcomes.push(await closeBounded(active.page, `${active.label} page`));
    outcomes.push(
      await closeBounded(active.context, `${active.label} context`),
    );
    state.active.delete(active);
  }
  outcomes.push(
    await closeBounded(
      state.browser,
      "frame-variance browser",
      BROWSER_CLOSE_TIMEOUT_MS,
    ),
  );
  return outcomes;
}

async function withInRunWatchdog(operation, state) {
  let timer;
  let timingOut = false;
  const operationPromise = Promise.resolve().then(operation);
  const operationSettled = operationPromise.then(
    () => ({ settled: true }),
    (error) => ({ settled: true, error: boundedMessage(error) }),
  );
  try {
    return await Promise.race([
      operationPromise.then(
        (value) => (timingOut ? new Promise(() => {}) : value),
        (error) => (timingOut ? new Promise(() => {}) : Promise.reject(error)),
      ),
      new Promise((_, reject) => {
        timer = setTimeout(async () => {
          timingOut = true;
          state.accepting = false;
          const checkpoint = state.checkpoint;
          let cleanup;
          try {
            cleanup = await closeActiveResources(state);
          } catch (error) {
            const failure = new AggregateError(
              [
                new Error(
                  `frame-variance in-run watchdog expired after ${IN_RUN_WATCHDOG_MS} ms`,
                ),
                error,
              ],
              "watchdog cleanup failed",
            );
            failure.retainRunningAuthority = true;
            state.watchdogCleanup = {
              checkpoint,
              cleanupComplete: false,
              error: boundedMessage(error),
            };
            reject(failure);
            return;
          }
          let drainTimer;
          const drain = await Promise.race([
            operationSettled,
            new Promise((resolve) => {
              drainTimer = setTimeout(
                () => resolve({ settled: false }),
                CLOSE_TIMEOUT_MS,
              );
            }),
          ]).finally(() => clearTimeout(drainTimer));
          const incomplete = cleanup.filter((item) => !item.closed);
          const cleanupComplete =
            incomplete.length === 0 && drain.settled === true;
          state.watchdogCleanup = {
            checkpoint,
            cleanupComplete,
            resources: cleanup,
            operationDrain: drain,
          };
          const error = new Error(
            `frame-variance in-run watchdog expired after ${IN_RUN_WATCHDOG_MS} ms; checkpoint=${JSON.stringify(checkpoint)}; cleanupIncomplete=${incomplete.length}; operationDrained=${drain.settled === true}`,
          );
          error.watchdogCleanup = state.watchdogCleanup;
          if (!cleanupComplete) error.retainRunningAuthority = true;
          reject(error);
        }, IN_RUN_WATCHDOG_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * All live scene pixels enter through the exact canonical source block below.
 * Node later decodes the persisted PNG bytes and computes every verdict metric
 * from those immutable bytes.
 */
const RUN_ASSET_SCENARIO = async (configuration) => {
  const C = (globalThis.Cesium =
    globalThis.Cesium || (await import("/Build/CesiumUnminified/index.js")));
  const viewer = globalThis.viewer;
  const scene = viewer.scene;
  const canvas = scene.canvas;
  viewer.useDefaultRenderLoop = false;
  scene.requestRenderMode = false;
  viewer.clock.shouldAnimate = false;
  const frameTime = C.JulianDate.fromIso8601(configuration.frameTimeIso);
  const frameTimeSignature = C.JulianDate.toIso8601(frameTime);
  viewer.clock.currentTime = frameTime;
  scene.globe.show = false;
  scene.globe.imageryLayers.removeAll();
  scene.globe.enableLighting = false;
  scene.globe.showGroundAtmosphere = false;
  if (scene.skyBox) scene.skyBox.show = false;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;
  if (scene.fog) scene.fog.enabled = false;
  scene.backgroundColor = C.Color.BLACK;
  for (const selector of [
    ".cesium-viewer-timelineContainer",
    ".cesium-viewer-animationContainer",
    ".cesium-viewer-bottom",
    ".cesium-viewer-toolbar",
    ".cesium-viewer-fullscreenContainer",
    ".cesium-viewer-navigationContainer",
    ".cesium-navigation-help",
    ".cesium-renderer-toggle",
  ]) {
    const element = document.querySelector(selector);
    if (element) element.style.display = "none";
  }

  // ==BEGIN fused-snapshot-capture==
  const makeFusedSnapshotCapture = (scene, canvas, timeFn) => {
    const tmp = document.createElement("canvas");
    const ctx = tmp.getContext("2d", { willReadFrequently: true });
    const decode = async (dataUrl) => {
      const image = new Image();
      const loaded = new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error("fused PNG decode failed"));
      });
      image.src = dataUrl;
      await loaded;
      tmp.width = image.naturalWidth;
      tmp.height = image.naturalHeight;
      ctx.drawImage(image, 0, 0);
      return ctx.getImageData(0, 0, tmp.width, tmp.height);
    };
    const captureSnapshot = async () => {
      scene.render(timeFn());
      const dataUrl = canvas.toDataURL("image/png");
      const imageData = await decode(dataUrl);
      return { dataUrl, imageData };
    };
    return { captureSnapshot };
  };
  // ==END fused-snapshot-capture==

  const captures = [];
  const structural = [];
  const objectIds = new WeakMap();
  let nextObjectId = 1;
  const objectId = (value) => {
    if (!value || (typeof value !== "object" && typeof value !== "function")) {
      return -1;
    }
    let id = objectIds.get(value);
    if (id === undefined) {
      id = nextObjectId++;
      objectIds.set(value, id);
    }
    return id;
  };
  const quickHash = (view) => {
    if (!view?.buffer) return "absent";
    const bytes = new Uint8Array(
      view.buffer,
      view.byteOffset ?? 0,
      view.byteLength,
    );
    let a = 2166136261;
    let b = 2246822519;
    for (let index = 0; index < bytes.length; index++) {
      a = Math.imul(a ^ bytes[index], 16777619) >>> 0;
      b = Math.imul(b ^ bytes[index], 3266489917) >>> 0;
    }
    return `${bytes.length}:${a.toString(16).padStart(8, "0")}:${b
      .toString(16)
      .padStart(8, "0")}`;
  };
  const matrixSignature = (matrix) =>
    Array.from({ length: 16 }, (_, index) => Number(matrix[index])).join(",");
  const sortInFlight = (primitive) =>
    primitive?._sorterPromise !== undefined ||
    primitive?._pendingSortPromise !== undefined ||
    primitive?._pendingSnapshot !== undefined;
  const sortWitness = (primitive) => ({
    indexesObjectId: objectId(primitive?._indexes),
    indexesHash: quickHash(primitive?._indexes),
    indexesLength: primitive?._indexes?.length ?? -1,
    sequence: primitive?._indexesSortSequence ?? -1,
    generation: primitive?._indexesDataGeneration ?? -1,
    requestId: primitive?._sortRequestId ?? -1,
    dataGeneration: primitive?._splatDataGeneration ?? -1,
    positionsHash: quickHash(primitive?._positions),
    positionsLength: primitive?._positions?.length ?? -1,
    lastSteadySortFrameNumber: primitive?._lastSteadySortFrameNumber ?? -1,
    framesSinceLastSteadySort:
      (primitive?._lastSteadySortFrameNumber ?? -1) >= 0
        ? frameNumber() - primitive._lastSteadySortFrameNumber
        : -1,
    inFlight: sortInFlight(primitive),
  });
  const quiescentSortWitness = (primitive) => {
    const witness = sortWitness(primitive);
    // This counter advances on every render after the last sort and therefore
    // cannot participate in the stable-output signature used by quiescence.
    const { framesSinceLastSteadySort: _advancingCounter, ...stable } = witness;
    return stable;
  };
  const frameNumber = () =>
    scene.frameState?.frameNumber ?? scene._frameState?.frameNumber ?? -1;
  const julianSignature = () =>
    C.JulianDate.toIso8601(viewer.clock.currentTime);
  const stateWitness = (primitive) => ({
    frameNumber: frameNumber(),
    julian: julianSignature(),
    camera: matrixSignature(scene.camera.viewMatrix),
    sort: sortWitness(primitive),
  });
  const frozenStateSignature = (witness) =>
    JSON.stringify({
      frameNumber: witness?.frameNumber,
      julian: witness?.julian,
      camera: witness?.camera,
      sort: witness?.sort,
    });
  const copySortInput = (primitive) => {
    const rootTransform = primitive?._rootTransform ?? C.Matrix4.IDENTITY;
    const modelView = C.Matrix4.multiply(
      scene.camera.viewMatrix,
      rootTransform,
      new C.Matrix4(),
    );
    return {
      julian: julianSignature(),
      positions: primitive?._positions
        ? Float32Array.from(primitive._positions)
        : new Float32Array(),
      modelView: Float32Array.from(modelView),
      positionsLength: primitive?._positions?.length ?? -1,
      dataGeneration: primitive?._splatDataGeneration ?? -1,
      splatCount: primitive?._numSplats ?? -1,
    };
  };
  const digestHex = async (view) => {
    const bytes = new Uint8Array(
      view.buffer,
      view.byteOffset ?? 0,
      view.byteLength,
    );
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  };
  const exactResetStateSignature = async (witness, primitive) => {
    const indexes = primitive?._indexes
      ? Uint32Array.from(primitive._indexes)
      : new Uint32Array();
    const input = copySortInput(primitive);
    const [indexesSha256, positionsSha256, modelViewSha256] = await Promise.all(
      [
        digestHex(indexes),
        digestHex(input.positions),
        digestHex(input.modelView),
      ],
    );
    return JSON.stringify({
      julian: witness?.julian,
      camera: witness?.camera,
      indexesSha256,
      indexesLength: indexes.length,
      positionsSha256,
      modelViewSha256,
      positionsLength: input.positionsLength,
      sequence: witness?.sort?.sequence,
      generation: witness?.sort?.generation,
      dataGeneration: witness?.sort?.dataGeneration,
      sortThrottleSatisfied: witness?.sort?.framesSinceLastSteadySort >= 3,
      inFlight: witness?.sort?.inFlight,
    });
  };

  let tileset;
  try {
    // The tileset loader owns the one registered tileset request. A separate
    // status probe here could be the response an attestor records even though
    // Cesium consumes a later, different response.
    tileset = await C.Cesium3DTileset.fromUrl(configuration.asset.url, {
      maximumScreenSpaceError: 1,
      cullRequestsWhileMoving: false,
    });
    scene.primitives.add(tileset);
  } catch (error) {
    return {
      ok: false,
      structural: [`asset-load:${String(error?.message ?? error)}`],
      captures,
    };
  }

  const configuredScale = Number(configuration.assetScale ?? 1);
  if (!Number.isFinite(configuredScale) || configuredScale <= 0) {
    structural.push("asset-scale-invalid");
  }
  const assetScale =
    Number.isFinite(configuredScale) && configuredScale > 0
      ? configuredScale
      : 1;
  const unscaledSphere = tileset.boundingSphere;
  const unscaledCenter = C.Cartesian3.clone(unscaledSphere.center);
  const unscaledRadius = unscaledSphere.radius;
  if (assetScale !== 1) {
    // Preserve asset contents while transferring the donor framing: scale in
    // world space about the asset's own bounding-sphere center, then use the
    // donor's absolute camera range. This retains the donor angular footprint
    // without putting the camera inside the larger cube.
    const aboutCenter = C.Matrix4.fromUniformScale(assetScale, new C.Matrix4());
    aboutCenter[12] = (1 - assetScale) * unscaledCenter.x;
    aboutCenter[13] = (1 - assetScale) * unscaledCenter.y;
    aboutCenter[14] = (1 - assetScale) * unscaledCenter.z;
    tileset.modelMatrix = C.Matrix4.multiply(
      aboutCenter,
      tileset.modelMatrix,
      new C.Matrix4(),
    );
  }
  const sphere = tileset.boundingSphere;
  const frustum = scene.camera.frustum;
  const verticalHalfFov = Number(frustum?.fovy) * 0.5;
  const frustumAspect = Number(frustum?.aspectRatio);
  const horizontalHalfFov = Math.atan(
    Math.tan(verticalHalfFov) * frustumAspect,
  );
  const usableHalfWidth =
    canvas.width * 0.5 -
    configuration.framingMarginPixels -
    configuration.framingCushionPixels;
  const usableHalfHeight =
    canvas.height * 0.5 -
    configuration.framingMarginPixels -
    configuration.framingCushionPixels;
  const horizontalAngularLimit = Math.atan(
    Math.tan(horizontalHalfFov) * (usableHalfWidth / (canvas.width * 0.5)),
  );
  const verticalAngularLimit = Math.atan(
    Math.tan(verticalHalfFov) * (usableHalfHeight / (canvas.height * 0.5)),
  );
  const registeredAngularRadius = Math.min(
    horizontalAngularLimit,
    verticalAngularLimit,
  );
  function registeredRangeForSphere(radius, angularRadius) {
    return radius / Math.sin(angularRadius);
  }
  function tangentSpherePixelRadii(
    radius,
    range,
    horizontalHalfAngle,
    verticalHalfAngle,
    width,
    height,
  ) {
    const angularRadius =
      range > radius ? Math.asin(radius / range) : Number.NaN;
    const tangent = Math.tan(angularRadius);
    return {
      angularRadius,
      x: (tangent / Math.tan(horizontalHalfAngle)) * (width * 0.5),
      y: (tangent / Math.tan(verticalHalfAngle)) * (height * 0.5),
    };
  }
  const normalRange = registeredRangeForSphere(
    sphere.radius,
    registeredAngularRadius,
  );
  if (
    !Number.isFinite(normalRange) ||
    normalRange <= sphere.radius ||
    usableHalfWidth <= 0 ||
    usableHalfHeight <= 0
  ) {
    structural.push("registered-framing-range-invalid");
  }
  const captureRange = Number.isFinite(configuration.range)
    ? configuration.range
    : normalRange;
  const frameCameraAt = (heading) => {
    scene.camera.lookAt(
      sphere.center,
      new C.HeadingPitchRange(
        C.Math.toRadians(heading),
        C.Math.toRadians(configuration.pitchDegrees),
        captureRange,
      ),
    );
    scene.camera.lookAtTransform(C.Matrix4.IDENTITY);
  };
  frameCameraAt(
    configuration.mode === "D2"
      ? configuration.headings.RESET
      : configuration.headings.A,
  );
  const renderNow = () => scene.render(frameTime);

  const readyStart = performance.now();
  let primitive;
  while (performance.now() - readyStart < configuration.readinessTimeoutMs) {
    renderNow();
    primitive = tileset.gaussianSplatPrimitive;
    const sharedReady =
      tileset.tilesLoaded === true &&
      tileset.root?.contentReady === true &&
      primitive?._numSplats === configuration.asset.expectedSplats &&
      primitive?._indexes?.length === configuration.asset.expectedSplats;
    const nativeReady =
      configuration.renderer !== "webgpu" ||
      primitive?._webgpuCache?.splatCount ===
        configuration.asset.expectedSplats;
    if (sharedReady && nativeReady) break;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  primitive = tileset.gaussianSplatPrimitive;
  if (
    primitive?._numSplats !== configuration.asset.expectedSplats ||
    primitive?._indexes?.length !== configuration.asset.expectedSplats
  ) {
    structural.push("splat-data-not-ready");
  }
  if (
    configuration.renderer === "webgpu" &&
    primitive?._webgpuCache?.splatCount !== configuration.asset.expectedSplats
  ) {
    structural.push("webgpu-splat-buffer-not-ready");
  }

  const waitForSortQuiescence = async () => {
    const start = performance.now();
    let signature = JSON.stringify(quiescentSortWitness(primitive));
    let stableSince = start;
    while (performance.now() - start < configuration.sortQuiesceTimeoutMs) {
      renderNow();
      const next = JSON.stringify(quiescentSortWitness(primitive));
      if (next !== signature || sortInFlight(primitive)) {
        signature = next;
        stableSince = performance.now();
      } else if (
        performance.now() - stableSince >=
        configuration.sortQuiesceWindowMs
      ) {
        return { quiesced: true, signature, ms: performance.now() - start };
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return {
      quiesced: false,
      signature: JSON.stringify(quiescentSortWitness(primitive)),
      ms: performance.now() - start,
    };
  };
  const framingWitness = () => {
    const center = C.SceneTransforms.worldToWindowCoordinates(
      scene,
      sphere.center,
    );
    // The silhouette of a perspective sphere is the tangent cone, not the
    // projection of a same-depth radial point. tan(asin(r / d)) is exactly
    // r / sqrt(d^2 - r^2), so these radii conservatively cover the sphere.
    const tangentRadii = tangentSpherePixelRadii(
      sphere.radius,
      captureRange,
      horizontalHalfFov,
      verticalHalfFov,
      canvas.width,
      canvas.height,
    );
    const angularRadius = tangentRadii.angularRadius;
    const radiusPxX = tangentRadii.x;
    const radiusPxY = tangentRadii.y;
    const radiusPx = Math.max(radiusPxX, radiusPxY);
    const centerOnCanvas =
      !!center &&
      center.x >= 0 &&
      center.x <= canvas.width &&
      center.y >= 0 &&
      center.y <= canvas.height;
    const projectedExtent =
      center && Number.isFinite(radiusPx)
        ? {
            left: center.x - radiusPxX,
            right: center.x + radiusPxX,
            top: center.y - radiusPxY,
            bottom: center.y + radiusPxY,
          }
        : null;
    const projectedExtentOnCanvas =
      projectedExtent !== null &&
      projectedExtent.left >= configuration.framingMarginPixels &&
      projectedExtent.right <=
        canvas.width - configuration.framingMarginPixels &&
      projectedExtent.top >= configuration.framingMarginPixels &&
      projectedExtent.bottom <=
        canvas.height - configuration.framingMarginPixels;
    const near = Number(scene.camera.frustum?.near);
    const far = Number(scene.camera.frustum?.far);
    const depthUnclipped =
      Number.isFinite(near) &&
      Number.isFinite(far) &&
      captureRange - sphere.radius > near &&
      captureRange + sphere.radius < far;
    const unclipped = depthUnclipped && projectedExtentOnCanvas;
    const finite =
      !!center &&
      Number.isFinite(center.x) &&
      Number.isFinite(center.y) &&
      Number.isFinite(radiusPx);
    return {
      center: center ? [center.x, center.y] : null,
      radiusPx,
      radiusPxX,
      radiusPxY,
      angularRadius,
      registeredAngularRadius,
      framingMarginPixels: configuration.framingMarginPixels,
      framingCushionPixels: configuration.framingCushionPixels,
      range: captureRange,
      normalRange,
      assetScale,
      unscaledRadius,
      sphereRadius: sphere.radius,
      near,
      far,
      finite,
      centerOnCanvas,
      projectedExtent,
      projectedExtentOnCanvas,
      depthUnclipped,
      unclipped,
      valid: finite && centerOnCanvas && unclipped && radiusPx >= 1,
    };
  };

  // Every lane, including D4, starts with no sort in flight. D4 then schedules
  // three controlled requests itself; it never attributes a pre-existing
  // publication to the frozen input registered below.
  const initialQuiescence = await waitForSortQuiescence();
  if (!initialQuiescence.quiesced) {
    structural.push("sort-not-quiesced");
  }
  const initialFraming = framingWitness();
  if (!initialFraming.valid) structural.push("camera-framing-invalid");
  if (structural.length > 0) {
    return {
      ok: false,
      structural,
      captures,
      normalRange,
      framing: initialFraming,
    };
  }

  const appendCapture = (name, snapshot) => {
    captures.push({ name, dataUrl: snapshot.dataUrl });
  };

  if (configuration.mode === "D1") {
    let renderCount = 0;
    let afterRender;
    let afterSynchronousReads;
    const beforeBatch = stateWitness(primitive);
    const oneRenderScene = {
      render(time) {
        if (renderCount === 0) {
          scene.render(time);
          renderCount++;
          afterRender = stateWitness(primitive);
        }
      },
    };
    const { captureSnapshot } = makeFusedSnapshotCapture(
      oneRenderScene,
      canvas,
      () => frameTime,
    );
    const snapshots = await Promise.all([
      captureSnapshot(),
      captureSnapshot(),
      captureSnapshot(),
      captureSnapshot(),
      captureSnapshot(),
      ((afterSynchronousReads = stateWitness(primitive)),
      Promise.resolve(null)),
    ]);
    for (let index = 0; index < 5; index++) {
      appendCapture(`read-${index}`, snapshots[index]);
    }
    const postDecode = stateWitness(primitive);
    return {
      ok: true,
      captures,
      normalRange,
      framing: initialFraming,
      metadata: {
        renderCount,
        readCount: 5,
        fixedJulian:
          beforeBatch.julian === frameTimeSignature &&
          afterRender?.julian === frameTimeSignature &&
          afterSynchronousReads?.julian === afterRender?.julian,
        fixedCamera: afterSynchronousReads?.camera === afterRender?.camera,
        fixedSceneState:
          frozenStateSignature(afterSynchronousReads) ===
            frozenStateSignature(afterRender) &&
          afterRender?.frameNumber === beforeBatch.frameNumber + 1,
        fixedSortInput:
          afterSynchronousReads?.sort?.positionsHash ===
            afterRender?.sort?.positionsHash &&
          afterSynchronousReads?.sort?.dataGeneration ===
            afterRender?.sort?.dataGeneration,
        beforeBatch,
        afterRender,
        afterSynchronousReads,
        postDecode,
      },
    };
  }

  const { captureSnapshot } = makeFusedSnapshotCapture(
    scene,
    canvas,
    () => frameTime,
  );
  const captureAt = async (name, heading) => {
    frameCameraAt(heading);
    const quiescence = await waitForSortQuiescence();
    if (!quiescence.quiesced) structural.push(`${name}:sort-not-quiesced`);
    const before = stateWitness(primitive);
    const snapshot = await captureSnapshot();
    const after = stateWitness(primitive);
    appendCapture(name, snapshot);
    return {
      name,
      heading,
      before,
      after,
      framing: framingWitness(),
      quiescence,
    };
  };

  if (configuration.mode === "D2") {
    if (!/^(?:AA|BB|AB|BA)$/u.test(configuration.order ?? "")) {
      return {
        ok: false,
        structural: ["D2-order-not-registered"],
        captures,
        normalRange,
        framing: initialFraming,
      };
    }
    const resetWitness = stateWitness(primitive);
    const resetSignature = await exactResetStateSignature(
      resetWitness,
      primitive,
    );
    const views = [...configuration.order];
    const records = [
      await captureAt("first", configuration.headings[views[0]]),
      await captureAt("second", configuration.headings[views[1]]),
    ];
    for (const record of records) {
      if (record.before.julian !== frameTimeSignature) {
        structural.push("D2-julian-advanced");
      }
      if (!record.framing.valid)
        structural.push(`${record.name}:framing-invalid`);
    }
    return {
      ok: structural.length === 0,
      structural,
      captures,
      normalRange,
      framing: initialFraming,
      metadata: {
        records,
        fixedJulian: !structural.includes("D2-julian-advanced"),
        order: configuration.order,
        views,
        resetSignature,
        resetWitness,
      },
    };
  }

  if (configuration.mode === "D3") {
    const first = await captureAt("frame-0", configuration.headings.A);
    const second = await captureAt("frame-1", configuration.headings.A);
    tileset.show = false;
    renderNow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const off = await captureSnapshot();
    appendCapture("off", off);
    return {
      ok: structural.length === 0,
      structural,
      captures,
      normalRange,
      framing: initialFraming,
      metadata: {
        fixedJulian:
          first.before.julian === frameTimeSignature &&
          second.before.julian === frameTimeSignature,
        fixedCamera: first.before.camera === second.before.camera,
        framingValid: first.framing.valid && second.framing.valid,
      },
    };
  }

  const materializeSortInput = async (rawInput) =>
    JSON.stringify({
      julian: rawInput.julian,
      positionsSha256: await digestHex(rawInput.positions),
      modelViewSha256: await digestHex(rawInput.modelView),
      positionsLength: rawInput.positionsLength,
      dataGeneration: rawInput.dataGeneration,
      splatCount: rawInput.splatCount,
    });
  const copySortState = (inputSignature, provenance = {}) => {
    const indexes = primitive?._indexes;
    return {
      indexes: indexes ? Uint32Array.from(indexes) : new Uint32Array(),
      sourceObjectId: objectId(indexes),
      generation: primitive?._indexesDataGeneration ?? -1,
      sequence: primitive?._indexesSortSequence ?? -1,
      residentBufferObjectId: objectId(
        primitive?._webgpuCache?.sortedIndexBuffer,
      ),
      inputSignature,
      ...provenance,
    };
  };
  const materializeSortState = async (raw) => {
    return {
      sourceObjectId: raw.sourceObjectId,
      permutationSha256: await digestHex(raw.indexes),
      length: raw.indexes.length,
      generation: raw.generation,
      sequence: raw.sequence,
      residentBufferObjectId: raw.residentBufferObjectId,
      inputSignature: raw.inputSignature,
      cleanStart: raw.cleanStart,
      publicationComplete: raw.publicationComplete,
      requestSequence: raw.requestSequence,
      requestGeneration: raw.requestGeneration,
      requestInputSignature: raw.requestInputSignature,
    };
  };

  if (configuration.mode === "D4") {
    let rawAfterRender;
    let publicationProvenance;
    const witnessedScene = {
      render(time) {
        scene.render(time);
        rawAfterRender = copySortState(
          publicationProvenance.requestInputSignature,
          publicationProvenance,
        );
      },
    };
    const { captureSnapshot: captureSortSnapshot } = makeFusedSnapshotCapture(
      witnessedScene,
      canvas,
      () => frameTime,
    );
    const snapshots = [];
    for (let index = 0; index < 3; index++) {
      const cleanStart = !sortInFlight(primitive);
      if (!cleanStart) {
        structural.push(`D4-request-${index}:sort-in-flight-at-start`);
        break;
      }
      const requestInputSignature = await materializeSortInput(
        copySortInput(primitive),
      );
      const requestSequence = (primitive?._sortRequestId ?? -1) + 1;
      const requestGeneration = primitive?._splatDataGeneration ?? -1;
      // This changes scheduler history only. The camera, Julian date, splat
      // positions, model-view matrix, count, and data generation remain fixed.
      primitive._lastSteadySortFrameNumber = -1;
      primitive._hasLastSteadySortCameraPosition = false;
      primitive._hasLastSteadySortCameraDirection = false;
      renderNow();
      const active = primitive?._activeSort;
      const requestBound =
        primitive?._sortRequestId === requestSequence &&
        active?.requestId === requestSequence &&
        active?.dataGeneration === requestGeneration &&
        active?.expectedCount === primitive?._numSplats;
      if (!requestBound) {
        structural.push(`D4-request-${index}:request-not-bound`);
        break;
      }
      const publicationStart = performance.now();
      while (
        performance.now() - publicationStart <
          configuration.sortQuiesceTimeoutMs &&
        !(
          primitive?._indexesSortSequence === requestSequence &&
          primitive?._indexesDataGeneration === requestGeneration
        )
      ) {
        if (primitive?._sortRequestId !== requestSequence) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const publicationComplete =
        primitive?._sortRequestId === requestSequence &&
        primitive?._indexesSortSequence === requestSequence &&
        primitive?._indexesDataGeneration === requestGeneration;
      if (!publicationComplete) {
        structural.push(`D4-request-${index}:publication-not-complete`);
        break;
      }
      const preCaptureInputSignature = await materializeSortInput(
        copySortInput(primitive),
      );
      if (preCaptureInputSignature !== requestInputSignature) {
        structural.push(`D4-request-${index}:request-input-drift`);
        break;
      }
      publicationProvenance = {
        cleanStart,
        publicationComplete,
        requestSequence,
        requestGeneration,
        requestInputSignature,
      };
      const captured = await captureSortSnapshot();
      appendCapture(`frame-${index}`, captured);
      const snapshot = await materializeSortState(rawAfterRender);
      const postCaptureInputSignature = await materializeSortInput(
        copySortInput(primitive),
      );
      if (
        snapshot.sequence !== requestSequence ||
        snapshot.generation !== requestGeneration ||
        postCaptureInputSignature !== requestInputSignature ||
        sortInFlight(primitive)
      ) {
        structural.push(`D4-request-${index}:post-capture-provenance-drift`);
        break;
      }
      snapshots.push(snapshot);
    }
    const pinnedInputSignature = await materializeSortInput(
      copySortInput(primitive),
    );
    const pinnedRawA = copySortState(pinnedInputSignature);
    const pinnedRawB = copySortState(pinnedInputSignature);
    const controlPinnedReads = [
      await materializeSortState(pinnedRawA),
      await materializeSortState(pinnedRawB),
    ];
    return {
      ok: structural.length === 0 && snapshots.length === 3,
      structural,
      captures,
      normalRange,
      framing: initialFraming,
      metadata: { snapshots, controlPinnedReads, initialQuiescence },
    };
  }

  if (configuration.mode === "D5") {
    const first = await captureAt("on-0", configuration.headings.A);
    const second = await captureAt("on-1", configuration.headings.A);
    tileset.show = false;
    renderNow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    renderNow();
    const off = await captureSnapshot();
    appendCapture("off", off);
    return {
      ok: structural.length === 0,
      structural,
      captures,
      normalRange,
      framing: initialFraming,
      metadata: {
        fixedJulian:
          first.before.julian === frameTimeSignature &&
          second.before.julian === frameTimeSignature,
        fixedCamera: first.before.camera === second.before.camera,
      },
    };
  }

  return {
    ok: false,
    structural: [`unknown-scenario-${configuration.mode}`],
    captures,
  };
};

function pageErrors(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror:${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") {
      const text = message.text();
      if (!/favicon|Ion access token/iu.test(text)) {
        errors.push(`console.error:${text}`);
      }
    }
  });
  return errors;
}

function beginConsumedSourceAttestation(
  page,
  options,
  asset,
  expectedByRelative,
) {
  const required = [
    "/Build/CesiumUnminified/index.js",
    "/Build/CesiumUnminified/Workers/gaussianSplatSorter.js",
    "/Build/CesiumUnminified/ThirdParty/wasm_splats_bg.wasm",
    asset.url,
    asset.payloadUrl,
  ];
  const pending = new Map();
  const listener = (response) => {
    let parsed;
    try {
      parsed = new URL(response.url());
    } catch {
      return;
    }
    if (parsed.origin !== options.base || !required.includes(parsed.pathname)) {
      return;
    }
    if (!pending.has(parsed.pathname)) pending.set(parsed.pathname, []);
    pending.get(parsed.pathname).push(
      response.body().then(
        (bytes) => ({
          relative: parsed.pathname,
          status: response.status(),
          byteLength: bytes.length,
          sha256: sha256(bytes),
        }),
        (error) => ({
          relative: parsed.pathname,
          status: response.status(),
          error: boundedMessage(error),
        }),
      ),
    );
  };
  page.on("response", listener);
  return {
    async finish() {
      page.off("response", listener);
      const records = [];
      for (const relative of required) {
        const attempts = pending.has(relative)
          ? await Promise.all(pending.get(relative))
          : [];
        const expected = expectedByRelative.get(relative);
        const identityMatches =
          expected?.ok === true &&
          attempts.length > 0 &&
          attempts.every(
            (observed) =>
              observed.status >= 200 &&
              observed.status < 300 &&
              observed.byteLength === expected.served.byteLength &&
              observed.sha256 === expected.served.sha256,
          );
        records.push({
          relative,
          attempts,
          identityMatches,
          error:
            attempts.length === 0
              ? "required response was not observed"
              : undefined,
        });
      }
      return records;
    },
    dispose() {
      page.off("response", listener);
    },
  };
}

async function runAssetScenario(state, options, request) {
  if (!state.accepting) throw new Error("watchdog stopped new work");
  const label = `${request.backend}/${request.mode}${request.order ? `-${request.order}` : ""}/${request.asset.name}`;
  state.checkpoint = { stage: "page", label };
  const context = await state.browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
  });
  const active = { label, context, page: undefined };
  state.active.add(active);
  let page;
  try {
    page = await context.newPage();
    active.page = page;
  } catch (error) {
    const contextClose = await closeBounded(context, `${label} context`);
    state.active.delete(active);
    if (!contextClose.closed) {
      throw new AggregateError(
        [error, new Error(`${label} context cleanup incomplete`)],
        `${label} page creation failed`,
        { cause: error },
      );
    }
    throw error;
  }
  const errors = pageErrors(page);
  const consumedSourceAttestation = beginConsumedSourceAttestation(
    page,
    options,
    request.asset,
    state.serverSourceByRelative,
  );
  await page.addInitScript(errorGateInit);
  let primaryError;
  let result;
  try {
    await withDeadline(
      page.goto(
        `${options.base}/Apps/CesiumViewer/index.html?renderer=${request.backend}&offline=true`,
        { waitUntil: "domcontentloaded", timeout: 90_000 },
      ),
      95_000,
      `${label} navigation`,
    );
    await withDeadline(
      page.waitForFunction(() => Boolean(globalThis.viewer?.scene?.context)),
      90_000,
      `${label} viewer readiness`,
    );
    if (request.backend === "webgpu") await armWebGPUDevices(page);
    result = await withDeadline(
      page.evaluate(RUN_ASSET_SCENARIO, {
        renderer: request.backend,
        asset: request.asset,
        mode: request.mode,
        order: request.order ?? null,
        range: request.range ?? null,
        assetScale: request.assetScale ?? 1,
        frameTimeIso: FRAME_TIME_ISO,
        pitchDegrees: CAMERA_PITCH_DEGREES,
        headings: CAMERA_HEADINGS,
        framingMarginPixels: FRAMING_MARGIN_PIXELS,
        framingCushionPixels: FRAMING_CUSHION_PIXELS,
        readinessTimeoutMs: READINESS_TIMEOUT_MS,
        sortQuiesceWindowMs: SORT_QUIESCE_WINDOW_MS,
        sortQuiesceTimeoutMs: SORT_QUIESCE_TIMEOUT_MS,
      }),
      PAGE_TIMEOUT_MS,
      `${label} page evaluation`,
    );
    const consumedSources = await withDeadline(
      consumedSourceAttestation.finish(),
      15_000,
      `${label} consumed-source attestation`,
    );
    const consumedFailures = consumedSources
      .filter((entry) => !entry.identityMatches)
      .map((entry) => `consumed-source-mismatch:${entry.relative}`);
    if (!state.accepting)
      throw new Error("watchdog stopped source attestation");
    state.consumedSources.push({ label, sources: consumedSources });
    result.consumedSources = consumedSources;
    if (consumedFailures.length > 0) {
      result.ok = false;
      result.structural = [...(result.structural ?? []), ...consumedFailures];
    }
    const gpu = await collectGateErrors(page);
    const runtimeErrors = [
      ...errors,
      ...(gpu.errors ?? []),
      ...(gpu.deviceLost ? [gpu.deviceLost] : []),
    ];
    if (runtimeErrors.length > 0) {
      throw new Error(`${label} runtime errors: ${runtimeErrors.join("; ")}`);
    }
  } catch (error) {
    primaryError = error;
  } finally {
    consumedSourceAttestation.dispose();
    const pageClose = await closeBounded(page, `${label} page`);
    const contextClose = await closeBounded(context, `${label} context`);
    state.active.delete(active);
    if (!pageClose.closed || !contextClose.closed) {
      const closeError = new Error(
        `${label} cleanup incomplete: ${JSON.stringify([pageClose, contextClose])}`,
      );
      primaryError = primaryError
        ? new AggregateError([primaryError, closeError], `${label} failed`)
        : closeError;
    }
  }
  if (primaryError) throw primaryError;
  return result;
}

async function executeD1(state, options, evidence, backend) {
  const towerRaw = await runAssetScenario(state, options, {
    backend,
    mode: "D1",
    asset: FRAME_VARIANCE_ASSETS.tower,
  });
  const cubeRaw = await runAssetScenario(state, options, {
    backend,
    mode: "D1",
    asset: FRAME_VARIANCE_ASSETS.sh_unit_cube,
  });
  if (!towerRaw.ok || !cubeRaw.ok) {
    return {
      result: structuralLane("D1", backend, [
        ...(towerRaw.structural ?? []).map((reason) => `tower:${reason}`),
        ...(cubeRaw.structural ?? []).map((reason) => `control:${reason}`),
      ]),
      receipts: [],
    };
  }
  const tower = await persistCaptures(
    state,
    evidence,
    `${backend}-d1-tower`,
    towerRaw.captures,
  );
  const cube = await persistCaptures(
    state,
    evidence,
    `${backend}-d1-cube`,
    cubeRaw.captures,
  );
  const towerImages = towerRaw.captures.map((capture) =>
    tower.frames.get(capture.name),
  );
  const cubeImages = cubeRaw.captures.map((capture) =>
    cube.frames.get(capture.name),
  );
  const towerPair = maxPairwiseChangedPixels(towerImages);
  const cubePair = maxPairwiseChangedPixels(cubeImages);
  const canvasPixels = VIEWPORT.width * VIEWPORT.height;
  const result = evaluateD1FrozenFrame({
    tower: {
      ...towerRaw.metadata,
      changedPixels: towerPair.changedPixels,
      canvasPixels,
    },
    control: {
      ...cubeRaw.metadata,
      changedPixels: cubePair.changedPixels,
      canvasPixels,
    },
  });
  result.measurements.maxPairs = {
    tower: towerPair.pair,
    control: cubePair.pair,
  };
  return {
    result: withBackend(result, backend),
    receipts: [...tower.receipts, ...cube.receipts],
  };
}

async function executeD2(state, options, evidence, backend) {
  const orders = ["AA", "BB", "AB", "BA"];
  const rawByOrder = {};
  for (const order of orders) {
    rawByOrder[order] = await runAssetScenario(state, options, {
      backend,
      mode: "D2",
      order,
      asset: FRAME_VARIANCE_ASSETS.tower,
    });
  }
  const structural = Object.entries(rawByOrder).flatMap(([order, raw]) =>
    raw.ok
      ? []
      : (raw.structural ?? ["acquisition failed"]).map(
          (reason) => `${order}:${reason}`,
        ),
  );
  if (structural.length > 0) {
    return {
      result: structuralLane("D2", backend, structural),
      receipts: [],
    };
  }
  const persistedByOrder = {};
  const receipts = [];
  for (const order of orders) {
    persistedByOrder[order] = await persistCaptures(
      state,
      evidence,
      `${backend}-d2-${order.toLowerCase()}-tower`,
      rawByOrder[order].captures,
    );
    receipts.push(...persistedByOrder[order].receipts);
  }
  const frame = (order, name) => persistedByOrder[order].frames.get(name);
  const cameraSignatures = { A: [], B: [] };
  for (const order of orders) {
    const raw = rawByOrder[order];
    raw.metadata.views.forEach((view, index) => {
      cameraSignatures[view].push(raw.metadata.records[index].before.camera);
    });
  }
  const fixedCameras = Object.values(cameraSignatures).every(
    (signatures) =>
      signatures.length === 4 &&
      signatures.every((signature) => signature === signatures[0]),
  );
  const resetSignatures = orders.map(
    (order) => rawByOrder[order].metadata.resetSignature,
  );
  const result = evaluateD2Ordering({
    fixedJulian: orders.every(
      (order) => rawByOrder[order].metadata.fixedJulian === true,
    ),
    fixedCameras,
    // Fresh-page scheduling counters are timing artifacts, not scene state;
    // full signatures remain recorded as evidence below.
    equivalentInitialStates: equivalentD2InitialStates(resetSignatures),
    sameStateControls: [
      comparisonRecord(frame("AA", "first"), frame("AA", "second")),
      comparisonRecord(frame("BB", "first"), frame("BB", "second")),
    ],
    oppositeOrderSameState: [
      comparisonRecord(frame("AB", "first"), frame("BA", "second")),
      comparisonRecord(frame("AB", "second"), frame("BA", "first")),
    ],
  });
  result.measurements.resetSignatures = resetSignatures;
  result.measurements.cameraSignatures = cameraSignatures;
  return { result: withBackend(result, backend), receipts };
}

function changedFootprintExtent(left, right) {
  if (
    left?.width !== right?.width ||
    left?.height !== right?.height ||
    left?.data?.length !== right?.data?.length
  ) {
    return { valid: false, contained: false, reason: "dimension-mismatch" };
  }
  let minX = left.width;
  let minY = left.height;
  let maxX = -1;
  let maxY = -1;
  let changed = 0;
  for (let y = 0; y < left.height; y++) {
    for (let x = 0; x < left.width; x++) {
      const offset = (y * left.width + x) * 4;
      if (
        left.data[offset] === right.data[offset] &&
        left.data[offset + 1] === right.data[offset + 1] &&
        left.data[offset + 2] === right.data[offset + 2]
      ) {
        continue;
      }
      changed++;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return {
    valid: true,
    changed,
    extent: changed > 0 ? { minX, minY, maxX, maxY } : null,
    // A subject pixel on any outermost row or column could continue beyond
    // the documentary canvas. Require an observed quiet border on all sides.
    contained:
      changed > 0 &&
      minX > 0 &&
      minY > 0 &&
      maxX < left.width - 1 &&
      maxY < left.height - 1,
  };
}

async function persistD3Cell(state, evidence, backend, cell, raw) {
  const persisted = await persistCaptures(
    state,
    evidence,
    `${backend}-d3-${cell}`,
    raw.captures,
  );
  const first = persisted.frames.get("frame-0");
  const second = persisted.frames.get("frame-1");
  const off = persisted.frames.get("off");
  const footprintExtents = [
    changedFootprintExtent(first, off),
    changedFootprintExtent(second, off),
  ];
  return {
    record: {
      ...comparisonRecord(first, second),
      framingValid:
        raw.framing?.valid === true &&
        raw.metadata?.framingValid === true &&
        raw.registeredFramingMatch === true &&
        footprintExtents.every((extent) => extent.contained === true),
      footprintPixels: Math.max(
        ...footprintExtents.map((extent) => extent.changed ?? 0),
      ),
      footprintExtents,
    },
    receipts: persisted.receipts,
  };
}

function registeredFramingMatches(donor, crossed) {
  if (donor?.valid !== true || crossed?.valid !== true) return false;
  const close = (left, right, tolerance) =>
    Number.isFinite(left) &&
    Number.isFinite(right) &&
    Math.abs(left - right) <= tolerance;
  const radiusTolerance = Math.max(1e-7, Math.abs(donor.sphereRadius) * 1e-9);
  const rangeTolerance = Math.max(1e-7, Math.abs(donor.range) * 1e-9);
  const pixelTolerance = Math.max(1, Math.abs(donor.radiusPx) * 0.01);
  return (
    donor.projectedExtentOnCanvas === true &&
    crossed.projectedExtentOnCanvas === true &&
    close(crossed.range, donor.range, rangeTolerance) &&
    close(crossed.sphereRadius, donor.sphereRadius, radiusTolerance) &&
    close(crossed.radiusPx, donor.radiusPx, pixelTolerance) &&
    close(crossed.center?.[0], donor.center?.[0], 1) &&
    close(crossed.center?.[1], donor.center?.[1], 1)
  );
}

function donorAssetScale(donor, target) {
  const donorRadius = Number(donor?.framing?.sphereRadius);
  const targetRadius = Number(target?.framing?.sphereRadius);
  return donorRadius / targetRadius;
}

async function executeD3(state, options, evidence, backend) {
  const towerAtTowerRaw = await runAssetScenario(state, options, {
    backend,
    mode: "D3",
    asset: FRAME_VARIANCE_ASSETS.tower,
  });
  const cubeAtCubeRaw = await runAssetScenario(state, options, {
    backend,
    mode: "D3",
    asset: FRAME_VARIANCE_ASSETS.sh_unit_cube,
  });
  if (!towerAtTowerRaw.ok || !cubeAtCubeRaw.ok) {
    return {
      result: structuralLane("D3", backend, [
        ...(towerAtTowerRaw.structural ?? []).map(
          (reason) => `towerAtTower:${reason}`,
        ),
        ...(cubeAtCubeRaw.structural ?? []).map(
          (reason) => `cubeAtCube:${reason}`,
        ),
      ]),
      receipts: [],
    };
  }
  const towerAtCubeRaw = await runAssetScenario(state, options, {
    backend,
    mode: "D3",
    asset: FRAME_VARIANCE_ASSETS.tower,
    range: cubeAtCubeRaw.normalRange,
    assetScale: donorAssetScale(cubeAtCubeRaw, towerAtTowerRaw),
  });
  const cubeAtTowerRaw = await runAssetScenario(state, options, {
    backend,
    mode: "D3",
    asset: FRAME_VARIANCE_ASSETS.sh_unit_cube,
    range: towerAtTowerRaw.normalRange,
    assetScale: donorAssetScale(towerAtTowerRaw, cubeAtCubeRaw),
  });
  towerAtTowerRaw.registeredFramingMatch = true;
  cubeAtCubeRaw.registeredFramingMatch = true;
  towerAtCubeRaw.registeredFramingMatch = registeredFramingMatches(
    cubeAtCubeRaw.framing,
    towerAtCubeRaw.framing,
  );
  cubeAtTowerRaw.registeredFramingMatch = registeredFramingMatches(
    towerAtTowerRaw.framing,
    cubeAtTowerRaw.framing,
  );
  const rawCells = {
    towerAtTower: towerAtTowerRaw,
    towerAtCube: towerAtCubeRaw,
    cubeAtTower: cubeAtTowerRaw,
    cubeAtCube: cubeAtCubeRaw,
  };
  const structural = Object.entries(rawCells).flatMap(([cell, raw]) =>
    raw.ok
      ? []
      : (raw.structural ?? ["acquisition failed"]).map(
          (reason) => `${cell}:${reason}`,
        ),
  );
  if (structural.length > 0) {
    return {
      result: structuralLane("D3", backend, structural),
      receipts: [],
    };
  }
  const cells = {};
  const receipts = [];
  for (const [cell, raw] of Object.entries(rawCells)) {
    const persisted = await persistD3Cell(state, evidence, backend, cell, raw);
    cells[cell] = persisted.record;
    raw.persistedFootprintExtents = persisted.record.footprintExtents;
    receipts.push(...persisted.receipts);
  }
  const result = evaluateD3AssetFramingCross({
    fixedJulian: Object.values(rawCells).every(
      (raw) => raw.metadata?.fixedJulian === true,
    ),
    fixedCameras: Object.values(rawCells).every(
      (raw) => raw.metadata?.fixedCamera === true,
    ),
    cells,
  });
  result.measurements.ranges = {
    tower: towerAtTowerRaw.normalRange,
    cube: cubeAtCubeRaw.normalRange,
  };
  result.measurements.framingWitnesses = Object.fromEntries(
    Object.entries(rawCells).map(([cell, raw]) => [
      cell,
      {
        ...raw.framing,
        registeredFramingMatch: raw.registeredFramingMatch,
        persistedFootprintExtents: raw.persistedFootprintExtents,
      },
    ]),
  );
  return { result: withBackend(result, backend), receipts };
}

async function executeD4(state, options, evidence, backend) {
  const raw = await runAssetScenario(state, options, {
    backend,
    mode: "D4",
    asset: FRAME_VARIANCE_ASSETS.tower,
  });
  if (!raw.ok) {
    return {
      result: structuralLane(
        "D4",
        backend,
        raw.structural ?? ["D4 acquisition failed"],
      ),
      receipts: [],
    };
  }
  const persisted = await persistCaptures(
    state,
    evidence,
    `${backend}-d4-tower`,
    raw.captures,
  );
  const images = raw.captures.map((capture) =>
    persisted.frames.get(capture.name),
  );
  const pair = maxPairwiseChangedPixels(images);
  const result = evaluateD4SortedIndexIdentity({
    towerSnapshots: raw.metadata.snapshots,
    controlPinnedReads: raw.metadata.controlPinnedReads,
    towerFrameVariance: {
      changedPixels: pair.changedPixels,
      canvasPixels: VIEWPORT.width * VIEWPORT.height,
    },
  });
  result.measurements.maxPair = pair.pair;
  return { result: withBackend(result, backend), receipts: persisted.receipts };
}

async function executeD5(state, options, evidence, backend) {
  const towerRaw = await runAssetScenario(state, options, {
    backend,
    mode: "D5",
    asset: FRAME_VARIANCE_ASSETS.tower,
  });
  const cubeRaw = await runAssetScenario(state, options, {
    backend,
    mode: "D5",
    asset: FRAME_VARIANCE_ASSETS.sh_unit_cube,
  });
  if (!towerRaw.ok || !cubeRaw.ok) {
    return {
      result: structuralLane("D5", backend, [
        ...(towerRaw.structural ?? []).map((reason) => `tower:${reason}`),
        ...(cubeRaw.structural ?? []).map((reason) => `control:${reason}`),
      ]),
      receipts: [],
    };
  }
  const tower = await persistCaptures(
    state,
    evidence,
    `${backend}-d5-tower`,
    towerRaw.captures,
  );
  const cube = await persistCaptures(
    state,
    evidence,
    `${backend}-d5-cube`,
    cubeRaw.captures,
  );
  const towerSpatial = analyzeSpatialDistribution(
    tower.frames.get("on-0"),
    tower.frames.get("on-1"),
    tower.frames.get("off"),
  );
  const cubeSpatial = analyzeSpatialDistribution(
    cube.frames.get("on-0"),
    cube.frames.get("on-1"),
    cube.frames.get("off"),
  );
  const result = evaluateD5SpatialDistribution({
    fixedJulian:
      towerRaw.metadata.fixedJulian === true &&
      cubeRaw.metadata.fixedJulian === true,
    fixedCameras:
      towerRaw.metadata.fixedCamera === true &&
      cubeRaw.metadata.fixedCamera === true,
    tower: towerSpatial,
    control: cubeSpatial,
  });
  return {
    result: withBackend(result, backend),
    receipts: [...tower.receipts, ...cube.receipts],
  };
}

const DOWNSTREAM_EXECUTORS = Object.freeze({
  D2: executeD2,
  D3: executeD3,
  D4: executeD4,
  D5: executeD5,
});

async function executeSelection(state, options, evidence) {
  const results = state.results;
  const receipts = evidence.receipts;
  const backends = selectedBackends(options.backend);
  for (const backend of backends) {
    state.checkpoint = { stage: "D1", backend };
    const d1 = await executeD1(state, options, evidence, backend);
    results.push(d1.result);
  }
  // D1 is global and first. One reader disagreement makes every later number
  // in this invocation ineligible, even if the sibling backend happened not to
  // reproduce it.
  if (results.some((result) => result.status !== "PASS")) {
    return { results, receipts };
  }

  for (const lane of selectedDownstreamLanes(options.lane)) {
    const execute = DOWNSTREAM_EXECUTORS[lane];
    for (const backend of backends) {
      state.checkpoint = { stage: lane, backend };
      const outcome = await execute(state, options, evidence, backend);
      results.push(outcome.result);
    }
  }
  return { results, receipts };
}

async function fetchPreflightBytes(url, label) {
  const controller = new AbortController();
  let timer;
  try {
    timer = setTimeout(() => {
      controller.abort(new Error(`${label} timed out after 10000 ms`));
    }, 10_000);
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { response, bytes };
  } finally {
    clearTimeout(timer);
  }
}

const SOURCE_MAP_BASE64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeSourceMapVlq(segment) {
  const values = [];
  let value = 0;
  let shift = 0;
  for (const character of segment) {
    const digit = SOURCE_MAP_BASE64.indexOf(character);
    if (digit < 0) throw new Error(`invalid source-map VLQ ${character}`);
    value += (digit & 31) * 2 ** shift;
    if ((digit & 32) !== 0) {
      shift += 5;
      continue;
    }
    const negative = (value & 1) === 1;
    values.push(negative ? -(value >> 1) : value >> 1);
    value = 0;
    shift = 0;
  }
  if (shift !== 0) throw new Error("unterminated source-map VLQ");
  return values;
}

function traceSourceMapLocation(sourceMap, targetLine, targetColumn) {
  let previousSource = 0;
  let previousOriginalLine = 0;
  let previousOriginalColumn = 0;
  let previousName = 0;
  const lines = sourceMap.mappings.split(";");
  for (let line = 0; line <= targetLine && line < lines.length; line++) {
    let generatedColumn = 0;
    let candidate = null;
    for (const encoded of lines[line].split(",")) {
      if (!encoded) continue;
      const values = decodeSourceMapVlq(encoded);
      generatedColumn += values[0];
      if (values.length >= 4) {
        previousSource += values[1];
        previousOriginalLine += values[2];
        previousOriginalColumn += values[3];
        if (values.length >= 5) previousName += values[4];
        if (line === targetLine && generatedColumn <= targetColumn) {
          candidate = {
            generatedLine: line,
            generatedColumn,
            sourceIndex: previousSource,
            originalLine: previousOriginalLine,
            originalColumn: previousOriginalColumn,
            nameIndex: values.length >= 5 ? previousName : null,
          };
        }
      }
    }
    if (line === targetLine) return candidate;
  }
  return null;
}

function generatedPosition(source, token) {
  const offset = source.indexOf(token);
  if (offset < 0) return null;
  const prefix = source.slice(0, offset);
  const lines = prefix.split("\n");
  return { line: lines.length - 1, column: lines.at(-1).length };
}

function sourceMapBindings(mapBytes, buildEntryBytes) {
  const targets = [
    { key: "primitive", localPath: ENGINE_SORT_SOURCE_PATH },
    { key: "sorter", localPath: ENGINE_SORTER_SOURCE_PATH },
    { key: "taskProcessor", localPath: ENGINE_TASK_PROCESSOR_SOURCE_PATH },
  ];
  try {
    const sourceMap = JSON.parse(mapBytes.toString("utf8"));
    if (
      sourceMap.version !== 3 ||
      (sourceMap.file !== undefined &&
        path.basename(sourceMap.file) !== "index.js") ||
      typeof sourceMap.mappings !== "string" ||
      sourceMap.mappings.length === 0 ||
      !Array.isArray(sourceMap.sources) ||
      !Array.isArray(sourceMap.sourcesContent) ||
      sourceMap.sources.length !== sourceMap.sourcesContent.length
    ) {
      return { ok: false, error: "source map lacks aligned sourcesContent" };
    }
    const buildEntry = buildEntryBytes?.toString("utf8") ?? "";
    const sourceMapUrlBound =
      /^\/\/# sourceMappingURL=index\.js\.map\s*$/mu.test(buildEntry);
    const records = targets.map((target) => {
      const suffix = path
        .relative(ROOT, target.localPath)
        .replaceAll("\\", "/");
      const matches = sourceMap.sources
        .map((name, index) => ({
          index,
          name: `${sourceMap.sourceRoot ?? ""}/${name}`.replaceAll("\\", "/"),
        }))
        .filter(({ name }) => name.endsWith(suffix));
      const expected = fingerprintEvidenceFile(target.localPath);
      const embeddedContent =
        matches.length === 1
          ? sourceMap.sourcesContent[matches[0].index]
          : null;
      const embeddedBytes =
        typeof embeddedContent === "string"
          ? Buffer.from(embeddedContent, "utf8")
          : null;
      const embedded = embeddedBytes
        ? { byteLength: embeddedBytes.length, sha256: sha256(embeddedBytes) }
        : { byteLength: null, sha256: null };
      return {
        key: target.key,
        source: matches.length === 1 ? matches[0].name : null,
        matchCount: matches.length,
        expected,
        embedded,
        identityMatches:
          matches.length === 1 &&
          expected.exists === true &&
          expected.byteLength === embedded.byteLength &&
          expected.sha256 === embedded.sha256,
      };
    });
    const predicatePosition = generatedPosition(
      buildEntry,
      "function shouldStartSteadySort",
    );
    const predicateTrace = predicatePosition
      ? traceSourceMapLocation(
          sourceMap,
          predicatePosition.line,
          predicatePosition.column,
        )
      : null;
    const primitiveRecord = records.find(
      (record) => record.key === "primitive",
    );
    const primitiveSourceIndex = primitiveRecord
      ? sourceMap.sources.findIndex((name) =>
          `${sourceMap.sourceRoot ?? ""}/${name}`
            .replaceAll("\\", "/")
            .endsWith(
              path
                .relative(ROOT, ENGINE_SORT_SOURCE_PATH)
                .replaceAll("\\", "/"),
            ),
        )
      : -1;
    const originalPredicateWindow =
      predicateTrace && primitiveSourceIndex >= 0
        ? (sourceMap.sourcesContent[primitiveSourceIndex] ?? "")
            .split("\n")
            .slice(
              Math.max(0, predicateTrace.originalLine - 1),
              predicateTrace.originalLine + 3,
            )
            .join("\n")
        : "";
    const mappedPredicate = {
      generated: predicatePosition,
      traced: predicateTrace,
      sourceIndex: primitiveSourceIndex,
      identityMatches:
        predicateTrace?.sourceIndex === primitiveSourceIndex &&
        originalPredicateWindow.includes("function shouldStartSteadySort"),
    };
    return {
      ok:
        sourceMapUrlBound &&
        records.every((record) => record.identityMatches) &&
        mappedPredicate.identityMatches,
      sourceMapUrlBound,
      records,
      mappedPredicate,
    };
  } catch (error) {
    return { ok: false, error: boundedMessage(error) };
  }
}

function extractWorkerFunction(source, baseName) {
  const match = new RegExp(
    `(?:async\\s+)?function\\s+${baseName}[A-Za-z0-9_$]*\\s*\\(`,
    "u",
  ).exec(source);
  if (!match) return null;
  const open = source.indexOf("{", match.index + match[0].length);
  if (open < 0) return null;
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}") {
      depth--;
      if (depth === 0) return source.slice(match.index, index + 1);
    }
  }
  return null;
}

function canonicalWorkerSemantics(source) {
  const functions = [
    extractWorkerFunction(source, "initWorker"),
    extractWorkerFunction(source, "generateGaussianSortWorker"),
  ];
  if (functions.some((value) => value === null)) return null;
  return functions
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\/\/.*$/gmu, "")
    .replace(/\bdefined(?:_default|\d+)?\b/gu, "defined")
    .replace(/\binitSync\d*\b/gu, "initSync")
    .replace(
      /\bradix_sort_gaussians_indexes\d*\b/gu,
      "radix_sort_gaussians_indexes",
    )
    .replace(/\binitWorker\d*\b/gu, "initWorker")
    .replace(
      /\bgenerateGaussianSortWorker\d*\b/gu,
      "generateGaussianSortWorker",
    )
    .replace(/\s+/gu, "")
    .replace(/,\)/gu, ")");
}

function sorterWorkerBinding(buildBytes) {
  const sourceBytes = fs.readFileSync(ENGINE_SORT_WORKER_SOURCE_PATH);
  const sourceText = sourceBytes.toString("utf8");
  const buildText = buildBytes.toString("utf8");
  const semanticPatterns = [
    [
      "wasm-init",
      /initSync\s*\(\s*\{\s*module:\s*wasmConfig\.wasmBinary\s*\}\s*\)/su,
    ],
    ["index-only", /sortType\s*===\s*["']Index["']/su],
    [
      "sort-input-tuple",
      /radix_sort_gaussians_indexes\s*\(\s*primitive\.positions\s*,\s*primitive\.modelView\s*,\s*primitive\.count\s*,?\s*\)/su,
    ],
  ];
  const records = semanticPatterns.map(([key, pattern]) => ({
    key,
    sourceMatches: pattern.test(sourceText),
    buildMatches: pattern.test(buildText),
  }));
  const sourceSemantics = canonicalWorkerSemantics(sourceText);
  const buildSemantics = canonicalWorkerSemantics(buildText);
  const semanticIdentityMatches =
    sourceSemantics !== null && sourceSemantics === buildSemantics;
  return {
    ok:
      semanticIdentityMatches &&
      records.every((record) => record.sourceMatches && record.buildMatches),
    source: {
      byteLength: sourceBytes.length,
      sha256: sha256(sourceBytes),
    },
    build: { byteLength: buildBytes.length, sha256: sha256(buildBytes) },
    semanticIdentityMatches,
    semanticSha256:
      buildSemantics === null ? null : sha256(Buffer.from(buildSemantics)),
    records,
  };
}

function sorterWasmBinding(buildBytes) {
  const source = fingerprintEvidenceFile(ENGINE_SORT_WASM_SOURCE_PATH);
  const build = { byteLength: buildBytes.length, sha256: sha256(buildBytes) };
  return {
    ok:
      source.exists === true &&
      source.byteLength === build.byteLength &&
      source.sha256 === build.sha256,
    source,
    build,
  };
}

function servedBuildProvenance(source, servedBytes, servedBytesByKey) {
  if (source.key === "buildSourceMap") {
    return sourceMapBindings(servedBytes, servedBytesByKey.get("buildEntry"));
  }
  if (source.key === "sortWorker") return sorterWorkerBinding(servedBytes);
  if (source.key === "sortWasm") return sorterWasmBinding(servedBytes);
  return { ok: true, kind: "exact-served-local-identity" };
}

async function preflightServer(options) {
  const results = [];
  const servedBytesByKey = new Map();
  for (const source of SERVED_SOURCE_FILES) {
    const local = fingerprintEvidenceFile(source.localPath);
    try {
      const { response, bytes } = await fetchPreflightBytes(
        `${options.base}${source.relative}`,
        `server preflight ${source.relative}`,
      );
      const served = {
        byteLength: bytes.length,
        sha256: sha256(bytes),
      };
      servedBytesByKey.set(source.key, bytes);
      const identityMatches =
        local.exists === true &&
        local.byteLength === served.byteLength &&
        local.sha256 === served.sha256;
      const provenance = servedBuildProvenance(source, bytes, servedBytesByKey);
      results.push({
        relative: source.relative,
        localPath: path.relative(ROOT, source.localPath).replaceAll("\\", "/"),
        ok: response.ok && identityMatches && provenance.ok,
        status: response.status,
        local,
        served,
        identityMatches,
        provenance,
      });
    } catch (error) {
      results.push({
        relative: source.relative,
        localPath: path.relative(ROOT, source.localPath).replaceAll("\\", "/"),
        ok: false,
        local,
        error: boundedMessage(error),
      });
    }
  }
  return results;
}

async function runProbe(options) {
  assertCapturePreflight();
  const runId = randomUUID();
  const sourceStart = snapshotEvidenceFiles(sourceBoundary());
  const evidence = beginEvidence(options, runId, sourceStart);
  const server = await preflightServer(options);
  const unavailable = server.filter((entry) => !entry.ok);
  if (unavailable.length > 0) {
    const sourceEnd = snapshotEvidenceFiles(sourceBoundary());
    const sourceStability = compareEvidenceFileSnapshots(
      sourceStart,
      sourceEnd,
    );
    const structuralReasons = unavailable.map(
      (entry) =>
        `server-source-unavailable-or-mismatched:${entry.relative}:${entry.status ?? entry.error}:${entry.identityMatches ?? false}`,
    );
    if (!sourceStability.ok) {
      structuralReasons.push(...sourceStability.reasons);
    }
    const results = [structuralLane("D1", options.backend, structuralReasons)];
    const verdict = foldFrameVarianceVerdict(results, options.lane);
    const artifact = {
      schema: ARTIFACT_SCHEMA,
      runId,
      generatedAt: new Date().toISOString(),
      selection: { lane: options.lane, backend: options.backend },
      preRegistration: FRAME_VARIANCE_DESIGNS,
      server,
      sourceStart,
      sourceEnd,
      sourceStability,
      results,
      receipts: [],
      ...verdict,
    };
    const archive = path.join(evidence.directory, "artifact.json");
    return sealTerminalEvidence(evidence, archive, artifact);
  }

  let browser;
  const state = {
    browser: null,
    active: new Set(),
    accepting: true,
    checkpoint: { stage: "browser-launch" },
    results: [],
    consumedSources: [],
    serverSourceByRelative: new Map(
      server.map((entry) => [entry.relative, entry]),
    ),
    watchdogCleanup: null,
  };
  let execution;
  let primaryError;
  try {
    browser = await chromium.launch({
      channel: process.env.PROBE_BROWSER_CHANNEL || "msedge",
      headless: !options.headed,
      args: ["--enable-unsafe-webgpu", "--use-vulkan", "--disable-cache"],
    });
    state.browser = browser;
    execution = await withInRunWatchdog(
      () => executeSelection(state, options, evidence),
      state,
    );
  } catch (error) {
    primaryError = error;
  } finally {
    if (browser !== undefined) {
      const browserClose = await closeBounded(
        browser,
        "frame-variance browser",
        BROWSER_CLOSE_TIMEOUT_MS,
      );
      if (!browserClose.closed) {
        const closeError = new Error(
          `browser cleanup incomplete: ${JSON.stringify(browserClose)}`,
        );
        closeError.retainRunningAuthority = true;
        if (primaryError) {
          const aggregate = new AggregateError(
            [primaryError, closeError],
            "probe and cleanup failed",
          );
          aggregate.retainRunningAuthority = true;
          primaryError = aggregate;
        } else {
          primaryError = closeError;
        }
        try {
          // Fleet-visible last-resort close. The terminating process fuse owns
          // the case where a browser ignores both close attempts.
          await browser.close();
        } catch {
          // Preserve the bounded-close error in the immutable error artifact.
        }
      }
      state.browser = null;
    }
    state.accepting = false;
  }

  const sourceEnd = snapshotEvidenceFiles(sourceBoundary());
  const sourceStability = compareEvidenceFileSnapshots(sourceStart, sourceEnd);
  if (primaryError) {
    if (primaryError.retainRunningAuthority === true) {
      throw primaryError;
    }
    const errorResult = createFrameVarianceErrorResult(
      boundedMessage(primaryError),
    );
    const partialVerdict = foldFrameVarianceVerdict(
      state.results,
      options.lane,
    );
    const artifact = {
      schema: ARTIFACT_SCHEMA,
      runId,
      generatedAt: new Date().toISOString(),
      selection: { lane: options.lane, backend: options.backend },
      preRegistration: FRAME_VARIANCE_DESIGNS,
      server,
      sourceStart,
      sourceEnd,
      sourceStability,
      checkpoint: state.checkpoint,
      watchdogCleanup: state.watchdogCleanup,
      receipts: evidence.receipts,
      consumedSources: state.consumedSources,
      results: state.results,
      ...errorResult,
      partialStatus: partialVerdict.status,
      failures: partialVerdict.failures,
      structural: [
        ...partialVerdict.structural,
        ...(sourceStability.ok ? [] : sourceStability.reasons),
      ],
    };
    const archive = path.join(evidence.directory, "error.json");
    return sealTerminalEvidence(evidence, archive, artifact);
  }

  if (!sourceStability.ok) {
    execution.results.push(
      structuralLane("D1", "source-boundary", sourceStability.reasons),
    );
  }
  const verdict = foldFrameVarianceVerdict(execution.results, options.lane);
  const artifact = {
    schema: ARTIFACT_SCHEMA,
    runId,
    generatedAt: new Date().toISOString(),
    selection: { lane: options.lane, backend: options.backend },
    frameTime: FRAME_TIME_ISO,
    viewport: VIEWPORT,
    preRegistration: FRAME_VARIANCE_DESIGNS,
    server,
    sourceStart,
    sourceEnd,
    sourceStability,
    receipts: execution.receipts,
    consumedSources: state.consumedSources,
    results: execution.results,
    ...verdict,
  };
  const archive = path.join(evidence.directory, "artifact.json");
  return sealTerminalEvidence(evidence, archive, artifact);
}

async function runMain(options) {
  const result = await runProbe(options);
  console.log("=== C15-G9 GSPLAT FRAME-VARIANCE DISCRIMINATOR ===");
  console.log(
    JSON.stringify(
      {
        status: result.artifact.status,
        exitCode: result.artifact.exitCode,
        runId: result.artifact.runId,
        selection: result.artifact.selection,
        archive: result.archive,
        sha256: result.fingerprint.sha256,
        terminalReceipt: result.terminalReceiptPath,
        terminalReceiptSha256: result.terminalReceiptFingerprint.sha256,
        classifications: (result.artifact.results ?? []).map((lane) => ({
          backend: lane.backend,
          lane: lane.lane,
          status: lane.status,
          classification: lane.classification,
        })),
      },
      null,
      2,
    ),
  );
  console.log(
    `GATE ${result.artifact.status} — this is a discriminator result, not a variance-mechanism claim by the authoring lane.`,
  );
  process.exitCode = exitCodeForS5Status(result.artifact.status);
}

async function main() {
  const processFuse = setTimeout(() => {
    console.error(
      `[probe-gsplat-frame-variance] terminating process fuse fired after ${PROCESS_FUSE_MS} ms`,
    );
    process.exit(exitCodeForS5Status("ERROR"));
  }, PROCESS_FUSE_MS);
  processFuse.unref?.();
  let retainProcessFuse = false;
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      usage();
      return;
    }
    await runMain(options);
  } catch (error) {
    console.error(
      "[probe-gsplat-frame-variance] uncaught harness failure — ERROR (2):",
      boundedMessage(error),
    );
    retainProcessFuse = error?.retainRunningAuthority === true;
    process.exitCode = exitCodeForS5Status("ERROR");
  } finally {
    if (!retainProcessFuse) clearTimeout(processFuse);
  }
}

export {
  beginConsumedSourceAttestation,
  changedFootprintExtent,
  donorAssetScale,
  registeredFramingMatches,
  sorterWasmBinding,
  sorterWorkerBinding,
  sourceMapBindings,
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
