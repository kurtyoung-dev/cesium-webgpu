#!/usr/bin/env node
/**
 * C12-29 S5 custom-oblate-ellipsoid runtime certification.
 *
 * The probe runs one fresh WebGL context and one fresh WebGPU context in
 * serial. It does not build, launch a server, or contact a non-loopback host.
 * Every final artifact is write-once and the mutable latest name is replaced
 * only while this invocation owns byte-exact RUNNING authority.
 */

import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium } from "playwright";

import {
  C12_29_S5_CUSTOM_AGGREGATION,
  C12_29_S5_CUSTOM_ARTIFACT_PREFIX,
  C12_29_S5_CUSTOM_BUILD_SOURCE_FILES,
  C12_29_S5_CUSTOM_BUILD_SOURCE_MAP,
  C12_29_S5_CUSTOM_CAPTURE_LABELS,
  C12_29_S5_CUSTOM_CAPTURE_METHOD,
  C12_29_S5_CUSTOM_DIAGNOSTICS_SCHEMA,
  C12_29_S5_CUSTOM_GEOMETRY_EPSILON_METERS,
  C12_29_S5_CUSTOM_GEOMETRY_OPERATION_BUDGETS,
  C12_29_S5_CUSTOM_OUTPUT_DIRECTORY,
  C12_29_S5_CUSTOM_PHASES,
  C12_29_S5_CUSTOM_RADIUS_LAW,
  C12_29_S5_CUSTOM_RENDERERS,
  C12_29_S5_CUSTOM_SCENE,
  C12_29_S5_CUSTOM_SCHEMA,
  C12_29_S5_CUSTOM_SOURCE_FILES,
  C12_29_S5_CUSTOM_STABILITY_METHOD,
  C12_29_S5_CUSTOM_WEBGPU_CAMERA_INDICES,
  C12_29_S5_CUSTOM_WEBGPU_ECLIPSE_BINDING,
  c1229S5CustomGeometryTolerance,
  customEllipsoidGeodeticToEcef,
  deriveC1229S5CustomAxisIntersection,
  deriveC1229S5CustomCrossBackend,
  deriveC1229S5CustomOracleSample,
  deriveC1229S5CustomSampleId,
  exitCodeForC1229S5CustomStatus,
  foldC1229S5CustomEllipsoidGate,
  packC1229S5CustomCommonRay,
  stableC1229S5CustomJson,
  validateC1229S5CustomFinalArtifact,
} from "./lib/c12-29-s5-custom-ellipsoid-gate.mjs";
import {
  assertEvidenceReadableOrAbsent,
  compareEvidenceFileSnapshots,
  createImmutableEvidence,
  fingerprintEvidenceFile,
  inspectBuildSourceIdentity,
  preserveFirstRedEvidence,
  snapshotEvidenceFiles,
  validateServedEntryIdentities,
} from "./lib/build-source-identity.mjs";
import {
  armWebGPUDevices,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import {
  checkEmbeddedFusedSnapshotIsCanonical,
  checkFusedCaptureUsage,
} from "./lib/same-task-capture.mjs";

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(toolDirectory, "../..");
const probePath = fileURLToPath(import.meta.url);
const buildEntryPath = path.join(
  repositoryRoot,
  "Build/CesiumUnminified/index.js",
);
const buildSourceMapPath = path.join(
  repositoryRoot,
  C12_29_S5_CUSTOM_BUILD_SOURCE_MAP,
);
const xysDirectory = path.join(
  repositoryRoot,
  "Build/CesiumUnminified/Assets/IAU2006_XYS",
);
const runtimePath = "/Build/CesiumUnminified/index.js";
const viewerPath = "/Apps/CesiumViewer/index.html";
const base = process.env.PROBE_BASE ?? "http://localhost:8080";
const outputDirectory = path.resolve(
  process.env.C12_29_S5_CUSTOM_OUTPUT_DIR ??
    path.join(repositoryRoot, C12_29_S5_CUSTOM_OUTPUT_DIRECTORY),
);

const WATCHDOG_MS = 540_000;
const PAGE_TIMEOUT_MS = 240_000;
const CLOSE_TIMEOUT_MS = 15_000;
const DRAIN_TIMEOUT_MS = 30_000;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function validateC1229S5CustomLoopbackBase(value) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`custom-ellipsoid base is not absolute: ${error.message}`, {
      cause: error,
    });
  }
  const host = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (
    !new Set(["http:", "https:"]).has(url.protocol) ||
    !new Set(["localhost", "127.0.0.1", "::1"]).has(host) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !new Set(["", "/"]).has(url.pathname)
  ) {
    throw new Error(
      "custom-ellipsoid evidence base must be a credential-free loopback root",
    );
  }
  return { href: url.href, origin: url.origin };
}

export function createC1229S5CustomArtifactPaths(
  runId,
  directory = outputDirectory,
) {
  return {
    directory,
    archive: path.join(directory, `${runId}.json`),
    latest: path.join(
      directory,
      `${C12_29_S5_CUSTOM_ARTIFACT_PREFIX}.latest.json`,
    ),
    lock: path.join(directory, `${C12_29_S5_CUSTOM_ARTIFACT_PREFIX}.lock.json`),
    firstRed: path.join(
      directory,
      `${C12_29_S5_CUSTOM_ARTIFACT_PREFIX}.first-red.json`,
    ),
    recovery: path.join(directory, `${runId}.publication-recovery.json`),
  };
}

function exactBytes(file, expected, label, operations = fs) {
  let actual;
  try {
    actual = operations.readFileSync(file);
  } catch (error) {
    throw new Error(`${label} is unreadable`, { cause: error });
  }
  const actualBytes = Buffer.isBuffer(actual) ? actual : Buffer.from(actual);
  const expectedBytes = Buffer.isBuffer(expected)
    ? expected
    : Buffer.from(expected);
  if (!actualBytes.equals(expectedBytes)) {
    throw new Error(`${label} bytes do not match owned authority`);
  }
  return actualBytes;
}

function readBytesIfPresent(file, operations = fs) {
  try {
    const value = operations.readFileSync(file);
    return Buffer.isBuffer(value) ? value : Buffer.from(value);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function readJsonIfPresent(file, operations = fs) {
  const bytes = readBytesIfPresent(file, operations);
  return bytes === undefined ? undefined : JSON.parse(bytes.toString("utf8"));
}

function createExclusive(file, bytes, label, operations = fs) {
  operations.writeFileSync(file, bytes, { flag: "wx" });
  exactBytes(file, bytes, label, operations);
}

function restoreClaimedBytes(file, bytes, label, operations = fs) {
  try {
    createExclusive(file, bytes, label, operations);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
}

/**
 * Atomically claim the directory entry currently at `canonical`, then prove
 * it was the exact entry this run was authorized to replace. A foreign entry
 * is restored exclusively or retained at the unique receipt path; it is never
 * overwritten or unlinked.
 */
export function claimC1229S5CustomCanonical(
  canonical,
  expectedBytes,
  lockPath,
  lockBytes,
  receiptTag,
  operations = fs,
) {
  exactBytes(
    lockPath,
    lockBytes,
    "owned lock before canonical claim",
    operations,
  );
  const receipt = `${canonical}.${receiptTag}-${randomUUID()}.receipt`;
  operations.renameSync(canonical, receipt);
  let claimed;
  try {
    claimed = exactBytes(
      receipt,
      expectedBytes,
      "claimed canonical receipt",
      operations,
    );
  } catch (error) {
    let foreign;
    try {
      foreign = readBytesIfPresent(receipt, operations);
      if (foreign !== undefined) {
        restoreClaimedBytes(
          canonical,
          foreign,
          "foreign canonical restoration",
          operations,
        );
      }
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        "foreign canonical claim could not be restored",
        { cause: restoreError },
      );
    }
    throw new Error(
      `canonical claim captured foreign bytes; receipt retained at ${receipt}`,
      { cause: error },
    );
  }
  exactBytes(
    lockPath,
    lockBytes,
    "owned lock after canonical claim",
    operations,
  );
  const occupied = readBytesIfPresent(canonical, operations);
  if (occupied !== undefined) {
    throw new Error(
      `canonical path was occupied after claim; owned receipt retained at ${receipt}`,
    );
  }
  return { receipt, claimedBytes: claimed };
}

function replaceOwnedCanonical(
  canonical,
  expectedBytes,
  replacementBytes,
  lockPath,
  lockBytes,
  tag,
  operations = fs,
) {
  const claim = claimC1229S5CustomCanonical(
    canonical,
    expectedBytes,
    lockPath,
    lockBytes,
    tag,
    operations,
  );
  try {
    createExclusive(
      canonical,
      replacementBytes,
      `${tag} exclusive replacement`,
      operations,
    );
    exactBytes(lockPath, lockBytes, `${tag} owned lock`, operations);
  } catch (error) {
    const restored = restoreClaimedBytes(
      canonical,
      claim.claimedBytes,
      `${tag} claimed canonical restoration`,
      operations,
    );
    if (!restored) {
      throw new AggregateError(
        [error],
        `${tag} failed and a foreign canonical entry appeared; receipt retained`,
        { cause: error },
      );
    }
    throw error;
  }
  operations.unlinkSync(claim.receipt);
  if (readBytesIfPresent(claim.receipt, operations) !== undefined) {
    throw new Error(`${tag} receipt still exists after deletion`);
  }
  exactBytes(canonical, replacementBytes, `${tag} final canonical`, operations);
}

export function releaseC1229S5CustomLock(lockPath, lockBytes, operations = fs) {
  exactBytes(lockPath, lockBytes, "owned lock before release", operations);
  const receipt = `${lockPath}.release-${randomUUID()}.receipt`;
  operations.renameSync(lockPath, receipt);
  try {
    exactBytes(receipt, lockBytes, "claimed lock release receipt", operations);
    if (readBytesIfPresent(lockPath, operations) !== undefined) {
      throw new Error("foreign lock appeared during owned lock release");
    }
    operations.unlinkSync(receipt);
    if (
      readBytesIfPresent(lockPath, operations) !== undefined ||
      readBytesIfPresent(receipt, operations) !== undefined
    ) {
      throw new Error("lock release absence could not be proven");
    }
  } catch (error) {
    try {
      const retained = readBytesIfPresent(receipt, operations);
      if (retained !== undefined) {
        restoreClaimedBytes(
          lockPath,
          retained,
          "owned lock restoration after failed release",
          operations,
        );
      }
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        "owned lock release and restoration failed",
        { cause: restoreError },
      );
    }
    throw error;
  }
}

export function beginC1229S5CustomEvidenceRun(paths, runId, operations = fs) {
  operations.mkdirSync(paths.directory, { recursive: true });
  const lockBefore = fingerprintEvidenceFile(paths.lock, operations);
  assertEvidenceReadableOrAbsent(lockBefore, "custom-ellipsoid lock preflight");
  if (lockBefore.exists) {
    const owner = readJsonIfPresent(paths.lock, operations);
    throw new Error(
      `custom-ellipsoid lock is owned by ${String(owner?.runId)}`,
    );
  }
  const latestBefore = fingerprintEvidenceFile(paths.latest, operations);
  assertEvidenceReadableOrAbsent(
    latestBefore,
    "custom-ellipsoid latest preflight",
  );
  const priorLatestBytes = readBytesIfPresent(paths.latest, operations);
  const priorLatest =
    priorLatestBytes === undefined
      ? undefined
      : JSON.parse(priorLatestBytes.toString("utf8"));
  if (priorLatest?.status === "RUNNING" || priorLatest?.incomplete === true) {
    throw new Error(
      `custom-ellipsoid latest is RUNNING for ${String(priorLatest?.runId)}`,
    );
  }
  const firstRedBefore = fingerprintEvidenceFile(paths.firstRed, operations);
  assertEvidenceReadableOrAbsent(
    firstRedBefore,
    "custom-ellipsoid first-red preflight",
  );
  const firstRedBeforeBytes = readBytesIfPresent(paths.firstRed, operations);
  if (
    firstRedBefore.exists !== (firstRedBeforeBytes !== undefined) ||
    (firstRedBeforeBytes !== undefined &&
      (firstRedBefore.byteLength !== firstRedBeforeBytes.byteLength ||
        firstRedBefore.sha256 !== sha256(firstRedBeforeBytes)))
  ) {
    throw new Error("custom-ellipsoid first-red preflight identity raced");
  }
  const nonce = randomUUID();
  const acquiredAt = new Date().toISOString();
  const lock = {
    schema: C12_29_S5_CUSTOM_SCHEMA,
    runId,
    nonce,
    status: "RUNNING",
    incomplete: true,
    acquiredAt,
  };
  const lockBytes = Buffer.from(stableC1229S5CustomJson(lock, 2));
  createExclusive(
    paths.lock,
    lockBytes,
    "exclusive custom-ellipsoid lock",
    operations,
  );
  const running = {
    schema: C12_29_S5_CUSTOM_SCHEMA,
    runId,
    nonce,
    status: "RUNNING",
    incomplete: true,
    startedAt: acquiredAt,
    artifactName: `${runId}.json`,
  };
  const runningBytes = Buffer.from(stableC1229S5CustomJson(running, 2));
  try {
    if (priorLatestBytes === undefined) {
      createExclusive(
        paths.latest,
        runningBytes,
        "exclusive custom-ellipsoid RUNNING latest",
        operations,
      );
    } else {
      replaceOwnedCanonical(
        paths.latest,
        priorLatestBytes,
        runningBytes,
        paths.lock,
        lockBytes,
        "running",
        operations,
      );
    }
  } catch (error) {
    try {
      if (readBytesIfPresent(paths.latest, operations)?.equals(runningBytes)) {
        // RUNNING is already authoritative: preserve it with the lock.
        error.retainCustomRunning = true;
      } else {
        releaseC1229S5CustomLock(paths.lock, lockBytes, operations);
      }
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "custom-ellipsoid evidence acquisition failed",
        { cause: cleanupError },
      );
    }
    throw error;
  }
  exactBytes(paths.lock, lockBytes, "owned custom-ellipsoid lock", operations);
  exactBytes(paths.latest, runningBytes, "owned RUNNING latest", operations);
  return {
    lock,
    lockBytes,
    running,
    runningBytes,
    firstRedBefore,
    firstRedBeforeBytes,
  };
}

function quarantineFinalLookingLatest(
  paths,
  finalBytes,
  ownership,
  operations = fs,
) {
  try {
    exactBytes(paths.lock, ownership.lockBytes, "recovery lock", operations);
    exactBytes(paths.latest, finalBytes, "recovery final latest", operations);
    const claim = claimC1229S5CustomCanonical(
      paths.latest,
      finalBytes,
      paths.lock,
      ownership.lockBytes,
      "recovery",
      operations,
    );
    createExclusive(
      paths.recovery,
      finalBytes,
      "write-once final publication recovery",
      operations,
    );
    createExclusive(
      paths.latest,
      ownership.runningBytes,
      "restored RUNNING latest after publication failure",
      operations,
    );
    operations.unlinkSync(claim.receipt);
    exactBytes(
      paths.latest,
      ownership.runningBytes,
      "recovered RUNNING latest",
      operations,
    );
    return { ok: true, recovery: paths.recovery };
  } catch (error) {
    return { ok: false, error };
  }
}

export function finalizeC1229S5CustomEvidence(
  paths,
  artifact,
  ownership,
  operations = fs,
) {
  const validated = validateC1229S5CustomFinalArtifact(artifact);
  if (!validated.ok) {
    throw new Error(`invalid final artifact: ${validated.reasons.join("; ")}`);
  }
  const finalBytes = Buffer.from(stableC1229S5CustomJson(artifact, 2));
  exactBytes(
    paths.lock,
    ownership.lockBytes,
    "owned finalization lock",
    operations,
  );
  exactBytes(
    paths.latest,
    ownership.runningBytes,
    "owned RUNNING latest at finalization",
    operations,
  );
  if (ownership.firstRedBeforeBytes !== undefined) {
    exactBytes(
      paths.firstRed,
      ownership.firstRedBeforeBytes,
      "stable pre-existing custom-ellipsoid first-red",
      operations,
    );
  } else if (readBytesIfPresent(paths.firstRed, operations) !== undefined) {
    throw new Error(
      "custom-ellipsoid first-red appeared after absent preflight",
    );
  }
  let firstRed;
  if (artifact.status !== "PASS") {
    firstRed = preserveFirstRedEvidence(paths.firstRed, finalBytes, operations);
    const expectedFirstRedBytes = ownership.firstRedBeforeBytes ?? finalBytes;
    exactBytes(
      paths.firstRed,
      expectedFirstRedBytes,
      "exact retained custom-ellipsoid first-red",
      operations,
    );
    if (
      firstRed.byteLength !== expectedFirstRedBytes.byteLength ||
      firstRed.sha256 !== sha256(expectedFirstRedBytes) ||
      firstRed.written !== (ownership.firstRedBeforeBytes === undefined)
    ) {
      throw new Error("custom-ellipsoid first-red receipt is not exact");
    }
  }
  createImmutableEvidence(paths.archive, finalBytes, operations);
  exactBytes(
    paths.archive,
    finalBytes,
    "immutable custom-ellipsoid archive",
    operations,
  );
  try {
    replaceOwnedCanonical(
      paths.latest,
      ownership.runningBytes,
      finalBytes,
      paths.lock,
      ownership.lockBytes,
      "final",
      operations,
    );
    exactBytes(
      paths.archive,
      finalBytes,
      "archive after latest publication",
      operations,
    );
    if (ownership.firstRedBeforeBytes !== undefined) {
      exactBytes(
        paths.firstRed,
        ownership.firstRedBeforeBytes,
        "publication retained custom-ellipsoid first-red",
        operations,
      );
    } else if (artifact.status === "PASS") {
      if (readBytesIfPresent(paths.firstRed, operations) !== undefined) {
        throw new Error(
          "PASS publication created a custom-ellipsoid first-red",
        );
      }
    } else {
      exactBytes(
        paths.firstRed,
        finalBytes,
        "publication new custom-ellipsoid first-red",
        operations,
      );
    }
    releaseC1229S5CustomLock(paths.lock, ownership.lockBytes, operations);
  } catch (error) {
    const finalLatest = readBytesIfPresent(paths.latest, operations);
    const lockCurrent = readBytesIfPresent(paths.lock, operations);
    if (
      finalLatest?.equals(finalBytes) &&
      lockCurrent?.equals(ownership.lockBytes)
    ) {
      const recovery = quarantineFinalLookingLatest(
        paths,
        finalBytes,
        ownership,
        operations,
      );
      error.publicationRecovery = recovery;
      error.retainCustomRunning = true;
    }
    throw error;
  }
  if (
    readBytesIfPresent(paths.lock, operations) !== undefined ||
    !readBytesIfPresent(paths.latest, operations)?.equals(finalBytes) ||
    !readBytesIfPresent(paths.archive, operations)?.equals(finalBytes)
  ) {
    throw new Error("custom-ellipsoid final publication postcondition failed");
  }
  return {
    runIdentity: fingerprintEvidenceFile(paths.archive, operations),
    firstRed,
  };
}

async function readGeneratedDefault(file) {
  const imported = await import(
    `${pathToFileURL(file).href}?custom-ellipsoid=${randomUUID()}`
  );
  if (typeof imported.default !== "string") {
    throw new TypeError(`${file} does not export generated shader text`);
  }
  return imported.default;
}

function sourcePathsByName() {
  return Object.fromEntries(
    C12_29_S5_CUSTOM_SOURCE_FILES.map((file) => [
      file,
      path.join(repositoryRoot, file),
    ]),
  );
}

async function collectC1229S5CustomProvenanceSnapshot() {
  const local = snapshotEvidenceFiles(sourcePathsByName());
  const servedEntry = fingerprintEvidenceFile(buildEntryPath);
  const buildSourceIdentity = inspectBuildSourceIdentity({
    sourceMapPath: buildSourceMapPath,
    sourceFiles: C12_29_S5_CUSTOM_BUILD_SOURCE_FILES.map((file) =>
      path.join(repositoryRoot, file),
    ),
  });
  const rawGlobeFs = fs
    .readFileSync(
      path.join(repositoryRoot, "packages/engine/Source/Shaders/GlobeFS.glsl"),
      "utf8",
    )
    .replaceAll("\r\n", "\n");
  const rawGlobeTerrain = fs
    .readFileSync(
      path.join(
        repositoryRoot,
        "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
      ),
      "utf8",
    )
    .replaceAll("\r\n", "\n");
  const generatedGlobeFs = await readGeneratedDefault(
    path.join(repositoryRoot, "packages/engine/Source/Shaders/GlobeFS.js"),
  );
  const generatedGlobeTerrain = await readGeneratedDefault(
    path.join(
      repositoryRoot,
      "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.js",
    ),
  );
  const probeSource = fs.readFileSync(probePath, "utf8");
  const canonicalCaptureReasons =
    checkEmbeddedFusedSnapshotIsCanonical(probeSource);
  const captureUsageReasons = checkFusedCaptureUsage(probeSource);
  const xys = Object.fromEntries(
    fs
      .readdirSync(xysDirectory)
      .filter((file) => /^IAU2006_XYS_\d+\.json$/u.test(file))
      .sort((left, right) => left.localeCompare(right))
      .map((file) => [
        file,
        fingerprintEvidenceFile(path.join(xysDirectory, file)),
      ]),
  );
  return {
    gitHead: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim(),
    local,
    servedEntry,
    buildSourceIdentity,
    generatedShaders: {
      globeFsExact: generatedGlobeFs === rawGlobeFs,
      globeTerrainExact: generatedGlobeTerrain === rawGlobeTerrain,
    },
    sameTaskCapture: {
      canonical: canonicalCaptureReasons.length === 0,
      canonicalReasons: canonicalCaptureReasons,
      usageExact: captureUsageReasons.length === 0,
      usageReasons: captureUsageReasons,
      helperPinned:
        local["Tools/visual-regression/lib/same-task-capture.mjs"]?.exists ===
        true,
    },
    xys,
  };
}

const MEASURE_C1229_S5_CUSTOM_SESSION = async (contract) => {
  const progress = {
    schema: contract.diagnosticsSchema,
    renderer: contract.renderer,
    currentPhase: "preflight",
    completedPhases: [],
    step: "start",
    elapsedMs: 0,
  };
  const startedAt = performance.now();
  globalThis.__c1229S5CustomProgress = progress;
  const mark = (phase, step) => {
    progress.currentPhase = phase;
    progress.step = step;
    progress.elapsedMs = performance.now() - startedAt;
  };
  const complete = (phase) => {
    progress.completedPhases.push(phase);
    mark(phase, "complete");
  };
  const C = await import(contract.runtimePath);
  const previousViewer = globalThis.viewer;
  if (previousViewer && !previousViewer.isDestroyed?.()) {
    previousViewer.useDefaultRenderLoop = false;
    previousViewer.destroy();
  }
  const container = document.getElementById("cesiumContainer");
  if (!container) throw new Error("CesiumViewer container is unavailable");
  container.innerHTML = "";
  Object.assign(container.style, {
    position: "fixed",
    inset: "0",
    width: `${contract.viewport.width}px`,
    height: `${contract.viewport.height}px`,
  });

  mark(contract.phases[0], "constructing-explicit-custom-scene");
  const originalDefaultEllipsoid = C.Ellipsoid.default;
  const ellipsoid = new C.Ellipsoid(
    contract.radii.x,
    contract.radii.y,
    contract.radii.z,
  );
  C.Ellipsoid.default = ellipsoid;
  const projection = new C.GeographicProjection(ellipsoid);
  const tilingScheme = new C.GeographicTilingScheme({
    ellipsoid,
    numberOfLevelZeroTilesX: 2,
    numberOfLevelZeroTilesY: 1,
  });
  const terrainRequests = [];
  const provider = new C.CustomHeightmapTerrainProvider({
    width: contract.terrainWidth,
    height: contract.terrainHeight,
    tilingScheme,
    callback(x, y, level) {
      terrainRequests.push({ x, y, level, height: contract.heightMeters });
      const heights = new Float32Array(
        contract.terrainWidth * contract.terrainHeight,
      );
      heights.fill(contract.heightMeters);
      return heights;
    },
  });
  const globe = new C.Globe(ellipsoid);
  const commonOptions = {
    ellipsoid,
    globe,
    mapProjection: projection,
    terrainProvider: provider,
    baseLayer: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    animation: false,
    timeline: false,
    fullscreenButton: false,
    selectionIndicator: false,
    infoBox: false,
    skyBox: false,
    skyAtmosphere: false,
    requestRenderMode: false,
    creditContainer: document.createElement("div"),
  };
  const viewer =
    contract.renderer === "webgpu"
      ? await C.Viewer.createAsync(container, {
          ...commonOptions,
          contextOptions: { renderer: "webgpu" },
        })
      : new C.Viewer(container, commonOptions);
  globalThis.viewer = viewer;
  const scene = viewer.scene;
  const canvas = scene.canvas;
  const actualRenderer = scene.context.isWebGPU ? "webgpu" : "webgl";
  if (actualRenderer !== contract.renderer) {
    throw new Error(
      `renderer resolved ${actualRenderer}, expected ${contract.renderer}`,
    );
  }
  globalThis.__armWebGPUDevice?.(
    scene.context?._device,
    `custom-${actualRenderer}`,
  );
  viewer.useDefaultRenderLoop = false;
  viewer.resolutionScale = 1;
  scene.requestRenderMode = false;
  scene.highDynamicRange = false;
  scene.sunBloom = false;
  scene.taaEnabled = false;
  scene.backgroundColor = C.Color.BLACK;
  if (scene.fog) scene.fog.enabled = false;
  if (scene.postProcessStages?.fxaa) {
    scene.postProcessStages.fxaa.enabled = false;
  }
  if (scene.postProcessStages?.bloom) {
    scene.postProcessStages.bloom.enabled = false;
  }
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;
  globe.show = true;
  globe.enableLighting = false;
  globe.showGroundAtmosphere = false;
  globe.showWaterEffect = false;
  globe.maximumScreenSpaceError = contract.maximumScreenSpaceError;
  scene.verticalExaggeration = contract.verticalExaggeration;
  scene.verticalExaggerationRelativeHeight =
    contract.verticalExaggerationRelativeHeight;
  const grid = new C.GridImageryProvider({
    tilingScheme,
    cells: 1,
    color: C.Color.fromBytes(238, 238, 238, 255),
    glowColor: C.Color.fromBytes(190, 190, 190, 255),
    glowWidth: 1,
    backgroundColor: C.Color.fromBytes(210, 210, 210, 255),
  });
  viewer.imageryLayers.removeAll();
  viewer.imageryLayers.addImageryProvider(grid);
  const lighting = globe.atmosphericConditions?.lighting;
  if (!lighting || !("enableEclipseGlobeShadow" in lighting)) {
    throw new Error("S5 custom-ellipsoid controls are unavailable");
  }
  lighting.enableEclipse = true;
  lighting.eclipseAutoExposure = false;
  lighting.enableEclipseGlobeShadow = true;
  if ("enableEclipseHorizonTwilight" in lighting) {
    lighting.enableEclipseHorizonTwilight = false;
  }

  let pinnedTime = C.JulianDate.fromIso8601(contract.eventIso);
  viewer.clock.currentTime = pinnedTime.clone();
  viewer.clock.startTime = pinnedTime.clone();
  viewer.clock.stopTime = pinnedTime.clone();
  viewer.clock.shouldAnimate = false;
  viewer.clock.multiplier = 0;
  const timeFn = () => pinnedTime;

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

  const { captureSnapshot } = makeFusedSnapshotCapture(scene, canvas, timeFn);
  const nextFrame = () =>
    new Promise((resolve) => requestAnimationFrame(resolve));
  const renderNow = () => scene.render(pinnedTime);
  const settle = async (predicate, maximumFrames, label) => {
    for (let frame = 0; frame < maximumFrames; frame++) {
      renderNow();
      if (predicate()) return frame + 1;
      await nextFrame();
    }
    renderNow();
    if (predicate()) return maximumFrames + 1;
    throw new Error(`${label} did not settle in ${maximumFrames} frames`);
  };
  const tileProvider = () => globe._surface?.tileProvider;
  const tileId = (tile) => `${tile.level}/${tile.x}/${tile.y}`;
  const selectedTiles = () => [
    ...(tileProvider()?._quadtree?._tilesToRender ?? []),
  ];
  const selectedIds = () => selectedTiles().map(tileId).sort();
  const tuple = () => ({
    prepared: scene.frameState?.eclipseGlobeShadowPrepared === true,
    selectionRevision:
      scene.frameState?.eclipseGlobeShadowSelectionRevision ?? null,
    surfaceRadius: scene.frameState?.eclipseGlobeShadowSurfaceRadius ?? null,
    selectedTileIds: selectedIds(),
  });

  const preloadStart = C.JulianDate.addHours(
    C.JulianDate.fromIso8601(contract.eventIso),
    -1,
    new C.JulianDate(),
  );
  const preloadStop = C.JulianDate.addHours(
    C.JulianDate.fromIso8601(contract.controlIso),
    1,
    new C.JulianDate(),
  );
  await C.Transforms.preloadIcrfFixed(
    new C.TimeInterval({ start: preloadStart, stop: preloadStop }),
  );
  const fixedBodies = (time) => {
    const matrix = C.Transforms.computeIcrfToFixedMatrix(time, new C.Matrix3());
    if (!matrix) throw new Error("ICRF-to-fixed matrix remained unavailable");
    const sunInertial =
      C.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
        time,
        new C.Cartesian3(),
      );
    const moonInertial =
      C.Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(
        time,
        new C.Cartesian3(),
      );
    return {
      sun: C.Matrix3.multiplyByVector(matrix, sunInertial, new C.Cartesian3()),
      moon: C.Matrix3.multiplyByVector(
        matrix,
        moonInertial,
        new C.Cartesian3(),
      ),
      sunInertial: {
        x: sunInertial.x,
        y: sunInertial.y,
        z: sunInertial.z,
      },
      moonInertial: {
        x: moonInertial.x,
        y: moonInertial.y,
        z: moonInertial.z,
      },
      matrix: Array.from(matrix),
    };
  };
  const eventBodies = fixedBodies(pinnedTime);
  const deriveAxisSurface = ({ sun, moon }) => {
    const direction = C.Cartesian3.normalize(
      C.Cartesian3.subtract(moon, sun, new C.Cartesian3()),
      new C.Cartesian3(),
    );
    const inverseSquared = {
      x: 1 / (contract.radii.x * contract.radii.x),
      y: 1 / (contract.radii.y * contract.radii.y),
      z: 1 / (contract.radii.z * contract.radii.z),
    };
    const a =
      direction.x * direction.x * inverseSquared.x +
      direction.y * direction.y * inverseSquared.y +
      direction.z * direction.z * inverseSquared.z;
    const b =
      2 *
      (moon.x * direction.x * inverseSquared.x +
        moon.y * direction.y * inverseSquared.y +
        moon.z * direction.z * inverseSquared.z);
    const c =
      moon.x * moon.x * inverseSquared.x +
      moon.y * moon.y * inverseSquared.y +
      moon.z * moon.z * inverseSquared.z -
      1;
    const discriminant = b * b - 4 * a * c;
    if (!(discriminant >= 0)) {
      throw new Error("runtime Sun/Moon shadow axis misses custom ellipsoid");
    }
    const root = Math.sqrt(discriminant);
    const candidates = [(-b - root) / (2 * a), (-b + root) / (2 * a)]
      .filter((value) => value > 0)
      .sort((left, right) => left - right);
    if (candidates.length === 0) {
      throw new Error("shadow-axis intersection has no forward root");
    }
    const point = C.Cartesian3.add(
      moon,
      C.Cartesian3.multiplyByScalar(
        direction,
        candidates[0],
        new C.Cartesian3(),
      ),
      new C.Cartesian3(),
    );
    const cartographic = ellipsoid.cartesianToCartographic(
      point,
      new C.Cartographic(),
    );
    return {
      point: { x: point.x, y: point.y, z: point.z },
      longitude: cartographic.longitude,
      latitude: cartographic.latitude,
      forwardRoot: candidates[0],
      direction: {
        x: direction.x,
        y: direction.y,
        z: direction.z,
      },
    };
  };
  const eventCentre = deriveAxisSurface(eventBodies);
  const wrapLongitude = (longitude) => C.Math.negativePiToPi(longitude);
  let activeCameraTarget;
  const cameraAt = (longitude, latitude) => {
    const cameraCartographic = new C.Cartographic(
      longitude,
      latitude,
      contract.cameraHeightMeters,
    );
    const destination = ellipsoid.cartographicToCartesian(cameraCartographic);
    const target = ellipsoid.cartographicToCartesian(
      new C.Cartographic(longitude, latitude, contract.heightMeters),
    );
    const frame = C.Transforms.eastNorthUpToFixedFrame(
      target,
      ellipsoid,
      new C.Matrix4(),
    );
    const north4 = C.Matrix4.getColumn(frame, 1, new C.Cartesian4());
    const direction = C.Cartesian3.normalize(
      C.Cartesian3.negate(destination, new C.Cartesian3()),
      new C.Cartesian3(),
    );
    const north = new C.Cartesian3(north4.x, north4.y, north4.z);
    const right = C.Cartesian3.normalize(
      C.Cartesian3.cross(direction, north, new C.Cartesian3()),
      new C.Cartesian3(),
    );
    const up = C.Cartesian3.normalize(
      C.Cartesian3.cross(right, direction, new C.Cartesian3()),
      new C.Cartesian3(),
    );
    scene.camera.frustum.fov = C.Math.toRadians(contract.cameraFovDegrees);
    scene.camera.setView({ destination, orientation: { direction, up } });
    activeCameraTarget = {
      longitude,
      latitude,
      height: contract.heightMeters,
    };
  };
  cameraAt(eventCentre.longitude, eventCentre.latitude);

  const construction = {
    ellipsoid: {
      constructor: ellipsoid.constructor.name,
      radii: {
        x: ellipsoid.radii.x,
        y: ellipsoid.radii.y,
        z: ellipsoid.radii.z,
      },
      sceneIdentity: scene.ellipsoid === ellipsoid,
    },
    provider: {
      constructor: provider.constructor.name,
      width: provider._width,
      height: provider._height,
      constantHeight: contract.heightMeters,
      tilingSchemeIdentity: provider.tilingScheme === tilingScheme,
    },
    projection: {
      constructor: projection.constructor.name,
      ellipsoidIdentity: projection.ellipsoid === ellipsoid,
      sceneIdentity: scene.mapProjection === projection,
    },
    tilingScheme: {
      constructor: tilingScheme.constructor.name,
      ellipsoidIdentity: tilingScheme.ellipsoid === ellipsoid,
    },
    globe: {
      constructor: globe.constructor.name,
      ellipsoidIdentity: globe.ellipsoid === ellipsoid,
      sceneIdentity: scene.globe === globe,
    },
    imagery: {
      constructor: grid.constructor.name,
      tilingSchemeIdentity: grid.tilingScheme === tilingScheme,
    },
  };
  complete(contract.phases[0]);

  mark(contract.phases[1], "settling-selected-custom-terrain");
  const settleFrames = await settle(
    () => {
      const tp = tileProvider();
      const selected = selectedTiles();
      return (
        globe.tilesLoaded === true &&
        selected.length > 0 &&
        selected.every((tile) => !!tile.data?.renderedMesh) &&
        tp?._eclipseKnownBoundsValid === true &&
        tp?._eclipseKnownMaximumHeight === contract.heightMeters &&
        scene.frameState?.eclipseGlobeShadowPrepared === true
      );
    },
    contract.maximumSettleFrames,
    "custom terrain preparation",
  );
  const preparedTuple = tuple();
  const tp = tileProvider();
  const preparation = {
    prepared: preparedTuple.prepared,
    settleFrames,
    tilesLoaded: globe.tilesLoaded,
    selectedTileIds: preparedTuple.selectedTileIds,
    selectionRevision: preparedTuple.selectionRevision,
    knownMinimumHeight: tp._eclipseKnownMinimumHeight,
    knownMaximumHeight: tp._eclipseKnownMaximumHeight,
    knownBoundsValid: tp._eclipseKnownBoundsValid,
    surfaceRadius: preparedTuple.surfaceRadius,
    radiusLaw: {
      maximumRadius: ellipsoid.maximumRadius,
      minimumHeight: tp._eclipseKnownMinimumHeight,
      maximumHeight: tp._eclipseKnownMaximumHeight,
      height: contract.heightMeters,
      fillSkirtAllowanceMeters: contract.radiusLaw.fillSkirtAllowanceMeters,
      absoluteSafetyMeters: contract.radiusLaw.absoluteSafetyMeters,
      relativeSafety: contract.radiusLaw.relativeSafety,
    },
    terrainRequestCount: terrainRequests.length,
    terrainRequests: terrainRequests.slice(),
    backendIdentity: null,
  };
  complete(contract.phases[1]);

  const globeRenderer =
    contract.renderer === "webgpu"
      ? scene.context.getFeatureRenderer?.(C.FeatureRendererKey.GLOBE_SURFACE)
      : null;
  const eclipsePrepareRecords = [];
  const eclipseManager = globeRenderer?._eclipseUniforms;
  const originalEclipsePrepare = eclipseManager?.prepare;
  if (contract.renderer === "webgpu") {
    if (!globeRenderer || typeof originalEclipsePrepare !== "function") {
      throw new Error("WebGPU globe eclipse manager is unavailable");
    }
    eclipseManager.prepare = function (device, frameState) {
      const result = originalEclipsePrepare.call(this, device, frameState);
      const block = frameState.eclipseGlobeShadow;
      eclipsePrepareRecords.push({
        frameNumber: frameState.frameNumber,
        offset: result.offset,
        size: result.size,
        alignment: device.limits.minUniformBufferOffsetAlignment,
        payload: Array.from(this._scratch),
        block:
          block && block.params?.x > 0.5
            ? {
                revision: block.revision,
                sunDirectionAndInvRange: { ...block.sunDirectionAndInvRange },
                moonDirectionDeltaAndInvRange: {
                  ...block.moonDirectionDeltaAndInvRange,
                },
                params: { ...block.params },
                params2: { ...block.params2 },
              }
            : null,
      });
      return result;
    };
  }

  const offsetsDegrees = [
    0, 0.1, 0.2, 0.35, 0.5, 0.75, 1, 1.5, 2, 3, 5, 8, 12, 18, 26, 36, 50, 65,
  ];
  const bearingsDegrees = [0, 45, 90, 135, 180, 225, 270, 315];
  const destinationOnSphere = (origin, angularDistance, bearing) => {
    const sinLatitude = Math.sin(origin.latitude);
    const cosLatitude = Math.cos(origin.latitude);
    const sinDistance = Math.sin(angularDistance);
    const cosDistance = Math.cos(angularDistance);
    const latitude = Math.asin(
      sinLatitude * cosDistance + cosLatitude * sinDistance * Math.cos(bearing),
    );
    const longitude = wrapLongitude(
      origin.longitude +
        Math.atan2(
          Math.sin(bearing) * sinDistance * cosLatitude,
          cosDistance - sinLatitude * Math.sin(latitude),
        ),
    );
    return { longitude, latitude };
  };
  const makeCandidates = (origin) => {
    const values = [];
    const seenPixels = new Set();
    for (const offsetDegrees of offsetsDegrees) {
      const bearings = offsetDegrees === 0 ? [0] : bearingsDegrees;
      for (const bearingDegrees of bearings) {
        const location = destinationOnSphere(
          origin,
          C.Math.toRadians(offsetDegrees),
          C.Math.toRadians(bearingDegrees),
        );
        const cartographic = new C.Cartographic(
          location.longitude,
          location.latitude,
          contract.heightMeters,
        );
        const world = ellipsoid.cartographicToCartesian(cartographic);
        const windowPoint = C.SceneTransforms.worldToWindowCoordinates(
          scene,
          world,
          new C.Cartesian2(),
        );
        if (!windowPoint) continue;
        const x = Math.round(windowPoint.x);
        const y = Math.round(windowPoint.y);
        if (x < 1 || y < 1 || x >= canvas.width - 1 || y >= canvas.height - 1) {
          continue;
        }
        const containing = selectedTiles().find((tile) =>
          C.Rectangle.contains(tile.rectangle, cartographic),
        );
        if (!containing) continue;
        const rectangle = containing.rectangle;
        let east = rectangle.east;
        let longitude = location.longitude;
        if (east < rectangle.west) east += C.Math.TWO_PI;
        if (longitude < rectangle.west) longitude += C.Math.TWO_PI;
        const u = (longitude - rectangle.west) / (east - rectangle.west);
        const v =
          (location.latitude - rectangle.south) /
          (rectangle.north - rectangle.south);
        const normalizedBoundaryDistance = Math.min(u, 1 - u, v, 1 - v);
        const tileBoundaryPixels = [
          [rectangle.west, location.latitude],
          [rectangle.east, location.latitude],
          [location.longitude, rectangle.south],
          [location.longitude, rectangle.north],
        ].map(([boundaryLongitude, boundaryLatitude]) => {
          const boundaryWorld = ellipsoid.cartographicToCartesian(
            new C.Cartographic(
              boundaryLongitude,
              boundaryLatitude,
              contract.heightMeters,
            ),
          );
          const boundaryWindow = C.SceneTransforms.worldToWindowCoordinates(
            scene,
            boundaryWorld,
            new C.Cartesian2(),
          );
          return boundaryWindow
            ? { x: boundaryWindow.x, y: boundaryWindow.y }
            : { x, y };
        });
        const tileBoundaryDistancesPixels = tileBoundaryPixels.map((boundary) =>
          Math.hypot(boundary.x - x, boundary.y - y),
        );
        const boundaryDistancePixels = Math.min(...tileBoundaryDistancesPixels);
        const key = `${x}/${y}`;
        if (seenPixels.has(key)) continue;
        seenPixels.add(key);
        values.push({
          longitude: location.longitude,
          latitude: location.latitude,
          height: contract.heightMeters,
          runtimePosition: { x: world.x, y: world.y, z: world.z },
          x,
          y,
          tileId: tileId(containing),
          tileUv: [u, v],
          normalizedBoundaryDistance,
          tileBoundaryPixels,
          tileBoundaryDistancesPixels,
          boundaryDistancePixels,
          flatTileInterior:
            normalizedBoundaryDistance > 0 &&
            boundaryDistancePixels > contract.tileInteriorPixelFootprintRadius,
          offsetDegrees,
          bearingDegrees,
        });
      }
    }
    return values;
  };
  const rgbaAt = (imageData, x, y) => {
    const index = (y * imageData.width + x) * 4;
    return Array.from(imageData.data.slice(index, index + 4));
  };
  const compareCandidates = (candidates, offImage, onImage) =>
    candidates.map((candidate) => ({
      ...candidate,
      offRgba: rgbaAt(offImage, candidate.x, candidate.y),
      onRgba: rgbaAt(onImage, candidate.x, candidate.y),
    }));
  const meshIdentities = new WeakMap();
  let nextMeshIdentity = 1;
  const meshIdentity = (mesh) => {
    if ((typeof mesh !== "object" && typeof mesh !== "function") || !mesh) {
      throw new Error("stable capture selected content has no rendered mesh");
    }
    let identity = meshIdentities.get(mesh);
    if (identity === undefined) {
      identity = `mesh-${nextMeshIdentity++}`;
      meshIdentities.set(mesh, identity);
    }
    return identity;
  };
  const array3 = (value) => [value.x, value.y, value.z];
  const blockVec4 = (value) =>
    value ? { x: value.x, y: value.y, z: value.z, w: value.w } : null;
  const captureFrameState = () => {
    const block = scene.frameState?.eclipseGlobeShadow;
    const content = selectedTiles()
      .map((tile) => ({
        tileId: tileId(tile),
        meshIdentity: meshIdentity(tile.data?.renderedMesh),
        renderedMesh: true,
      }))
      .sort((left, right) => left.tileId.localeCompare(right.tileId));
    return {
      clockIso: C.JulianDate.toIso8601(pinnedTime),
      cameraTarget: { ...activeCameraTarget },
      camera: {
        positionWC: array3(scene.camera.positionWC),
        directionWC: array3(scene.camera.directionWC),
        upWC: array3(scene.camera.upWC),
        rightWC: array3(scene.camera.rightWC),
        viewMatrix: Array.from(scene.camera.viewMatrix),
        projectionMatrix: Array.from(scene.camera.frustum.projectionMatrix),
        frustum: {
          fov: scene.camera.frustum.fov,
          aspectRatio: scene.camera.frustum.aspectRatio,
          near: scene.camera.frustum.near,
          far: scene.camera.frustum.far,
        },
      },
      provider: {
        constructor: provider.constructor.name,
        objectIdentity:
          globe.terrainProvider === provider &&
          scene.terrainProvider === provider,
        tilingSchemeIdentity: provider.tilingScheme === tilingScheme,
        width: provider._width,
        height: provider._height,
        constantHeight: contract.heightMeters,
        requestCount: terrainRequests.length,
      },
      preparedTuple: tuple(),
      content,
      eclipse: {
        lightingEnabled: lighting.enableEclipseGlobeShadow,
        blockPresent: !!block,
        active: block?.active === true,
        revision: block?.revision ?? null,
        sunDirectionAndInvRange: blockVec4(block?.sunDirectionAndInvRange),
        moonDirectionDeltaAndInvRange: blockVec4(
          block?.moonDirectionDeltaAndInvRange,
        ),
        params: blockVec4(block?.params),
        params2: blockVec4(block?.params2),
      },
    };
  };
  const stableComparableState = (state) => ({
    ...state,
    preparedTuple: {
      ...state.preparedTuple,
      selectionRevision: 0,
    },
  });
  const sameStableFrame = (left, right) => {
    const leftRevision = left.state.preparedTuple.selectionRevision;
    const rightRevision = right.state.preparedTuple.selectionRevision;
    return (
      left.dataUrl === right.dataUrl &&
      right.frameNumber === left.frameNumber + 1 &&
      Number.isInteger(leftRevision) &&
      rightRevision === leftRevision + 1 &&
      JSON.stringify(stableComparableState(left.state)) ===
        JSON.stringify(stableComparableState(right.state))
    );
  };
  const captures = [];
  const captureImages = new Map();
  const capture = async (label) => {
    let attemptedFrames = 0;
    let stableWindow = [];
    // Every observation renders first through the canonical fused primitive.
    // Only an immediate fourth render with byte-identical output and an exact
    // camera/time/provider/prepared-content state becomes evidence. A changed
    // fourth render starts a fresh candidate window; it is never published.
    while (attemptedFrames < contract.maximumStabilityFrames) {
      const [observationSnapshot, observationFrame] = await Promise.all([
        captureSnapshot(),
        Promise.resolve().then(() => ({
          frameNumber: scene.frameState.frameNumber,
          state: captureFrameState(),
        })),
      ]);
      attemptedFrames++;
      const observation = {
        ordinal: attemptedFrames,
        frameNumber: observationFrame.frameNumber,
        dataUrl: observationSnapshot.dataUrl,
        state: observationFrame.state,
      };
      stableWindow =
        stableWindow.length > 0 &&
        sameStableFrame(stableWindow.at(-1), observation)
          ? [...stableWindow, observation].slice(-contract.minimumStableFrames)
          : [observation];
      if (stableWindow.length < contract.minimumStableFrames) continue;
      if (attemptedFrames >= contract.maximumStabilityFrames) break;

      const renderTaskToken = crypto.randomUUID();
      const [evidenceSnapshot, evidenceFrameState] = await Promise.all([
        captureSnapshot(),
        Promise.resolve().then(() => ({
          frameNumber: scene.frameState.frameNumber,
          state: captureFrameState(),
        })),
      ]);
      attemptedFrames++;
      const evidenceFrame = {
        ordinal: attemptedFrames,
        frameNumber: evidenceFrameState.frameNumber,
        dataUrl: evidenceSnapshot.dataUrl,
        state: evidenceFrameState.state,
      };
      if (
        evidenceFrame.frameNumber === stableWindow.at(-1).frameNumber + 1 &&
        sameStableFrame(stableWindow.at(-1), evidenceFrame)
      ) {
        captureImages.set(label, evidenceSnapshot.imageData);
        captures.push({
          label,
          dataUrl: evidenceSnapshot.dataUrl,
          width: evidenceSnapshot.imageData.width,
          height: evidenceSnapshot.imageData.height,
          captureMethod: contract.captureMethod,
          renderTaskToken,
          captureTaskToken: renderTaskToken,
          temporalStability: {
            method: contract.stabilityMethod,
            requiredConsecutiveFrames: contract.minimumStableFrames,
            maximumFrames: contract.maximumStabilityFrames,
            attemptedFrames,
            observations: stableWindow,
            captureFrameNumber: evidenceFrame.frameNumber,
            captureState: evidenceFrame.state,
            renderFirst: true,
            sameTaskFusedCapture: true,
          },
        });
        return evidenceSnapshot.imageData;
      }
      stableWindow = [evidenceFrame];
    }
    throw new Error(
      `${label} did not produce ${contract.minimumStableFrames} consecutive stable frames plus an immediate fused capture in ${contract.maximumStabilityFrames} frames`,
    );
  };

  const eventCandidates = makeCandidates(eventCentre);
  mark(contract.phases[2], "event-off-fused-snapshot");
  lighting.enableEclipseGlobeShadow = false;
  const eventOffImage = await capture("event-off");
  const eventOffTuple = tuple();
  const eventOff = {
    enabled: false,
    clockIso: C.JulianDate.toIso8601(pinnedTime),
    preparedTuple: eventOffTuple,
    captureLabel: "event-off",
  };
  complete(contract.phases[2]);

  mark(contract.phases[3], "event-on-fused-snapshot");
  lighting.enableEclipseGlobeShadow = true;
  const eventOnImage = await capture("event-on");
  const eventOnTuple = tuple();
  const eventShadow = scene.frameState?.eclipseGlobeShadow;
  if (!eventShadow || !(eventShadow.params?.x > 0.5)) {
    throw new Error("event frame did not publish an active S5 block");
  }
  const eventOn = {
    enabled: true,
    clockIso: C.JulianDate.toIso8601(pinnedTime),
    preparedTuple: eventOnTuple,
    eventCentre: {
      ...eventCentre,
      derivedFromRuntimeBodies: true,
      hardcodedLongitude: false,
    },
    runtimeBodies: {
      sun: { ...eventBodies.sun },
      moon: { ...eventBodies.moon },
      sunInertial: { ...eventBodies.sunInertial },
      moonInertial: { ...eventBodies.moonInertial },
      icrfToFixed: eventBodies.matrix,
    },
    shadowBlock: {
      revision: eventShadow.revision,
      sunDirectionAndInvRange: { ...eventShadow.sunDirectionAndInvRange },
      moonDirectionDeltaAndInvRange: {
        ...eventShadow.moonDirectionDeltaAndInvRange,
      },
      params: { ...eventShadow.params },
      params2: { ...eventShadow.params2 },
      webglPackedUniform: Array.from(eventShadow.webglPackedUniform ?? []),
    },
    candidates: compareCandidates(eventCandidates, eventOffImage, eventOnImage),
    oracleSampleCount: 0,
    allSamplesWithinDerivedTolerance: false,
    hasUmbra: false,
    hasPenumbra: false,
    hasClear: false,
    captureLabel: "event-on",
  };

  if (contract.renderer === "webgl") {
    const automaticModule =
      await import("/packages/engine/Source/Renderer/AutomaticUniforms.js");
    const automaticUniforms = automaticModule.default;
    const uniformState = scene.context.uniformState;
    const radii = automaticUniforms.czm_ellipsoidRadii.getValue(uniformState);
    const inverse =
      automaticUniforms.czm_ellipsoidInverseRadii.getValue(uniformState);
    preparation.backendIdentity = {
      automaticUniforms: {
        radii: { x: radii.x, y: radii.y, z: radii.z },
        inverseRadii: { x: inverse.x, y: inverse.y, z: inverse.z },
        radiiExact:
          radii.x === contract.radii.x &&
          radii.y === contract.radii.y &&
          radii.z === contract.radii.z,
        inverseRadiiExact:
          inverse.x === 1 / contract.radii.x &&
          inverse.y === 1 / contract.radii.y &&
          inverse.z === 1 / contract.radii.z,
        source: "AutomaticUniforms.getValue(scene.context.uniformState)",
      },
    };
  } else {
    const cameraData = globeRenderer._cameraUniformData;
    const activePrepare = [...eclipsePrepareRecords]
      .reverse()
      .find((record) => record.block !== null);
    preparation.backendIdentity = {
      cameraUbo: {
        indices: { ...contract.cameraUboIndices },
        values: {
          inverseRadiiX: cameraData[contract.cameraUboIndices.inverseRadiiX],
          inverseRadiiY: cameraData[contract.cameraUboIndices.inverseRadiiY],
          inverseRadiiZ: cameraData[contract.cameraUboIndices.inverseRadiiZ],
          maximumRadius: cameraData[contract.cameraUboIndices.maximumRadius],
        },
        valuesExact: false,
      },
      eclipseBinding: {
        binding: contract.eclipseBinding,
        offset: activePrepare?.offset ?? null,
        alignment: activePrepare?.alignment ?? null,
        offsetAligned:
          Number.isInteger(activePrepare?.offset) &&
          activePrepare.offset % activePrepare.alignment === 0,
        size: activePrepare?.size ?? null,
        payload: activePrepare?.payload ?? [],
        block: activePrepare?.block ?? null,
        payloadExact: false,
      },
    };
  }
  complete(contract.phases[3]);

  mark(contract.phases[4], "antipodal-horizon-pair");
  const antipode = {
    longitude: wrapLongitude(eventCentre.longitude + Math.PI),
    latitude: -eventCentre.latitude,
  };
  cameraAt(antipode.longitude, antipode.latitude);
  await settle(
    () => tuple().prepared && selectedIds().length > 0,
    30,
    "antipode camera",
  );
  const antipodeCandidates = makeCandidates(antipode);
  lighting.enableEclipseGlobeShadow = false;
  renderNow();
  const antipodePreparedTupleBefore = tuple();
  const antipodeOffImage = await capture("antipode-off");
  const antipodeOffPreparedTuple = tuple();
  lighting.enableEclipseGlobeShadow = true;
  const antipodeOnImage = await capture("antipode-on");
  const antipodeOnPreparedTuple = tuple();
  const antipodePhase = {
    centre: antipode,
    preparedTupleBefore: antipodePreparedTupleBefore,
    offPreparedTuple: antipodeOffPreparedTuple,
    onPreparedTuple: antipodeOnPreparedTuple,
    candidates: compareCandidates(
      antipodeCandidates,
      antipodeOffImage,
      antipodeOnImage,
    ),
    allCandidatesHorizonRejected: false,
    offOnByteIdentical: false,
  };
  complete(contract.phases[4]);

  mark(contract.phases[5], "real-pickAsync");
  cameraAt(eventCentre.longitude, eventCentre.latitude);
  pinnedTime = C.JulianDate.fromIso8601(contract.eventIso);
  viewer.clock.currentTime = pinnedTime.clone();
  lighting.enableEclipseGlobeShadow = true;
  await settle(() => tuple().prepared, 30, "pre-pick event tuple");
  const pickProvider = tileProvider();
  const originalUpdateForPick = pickProvider.updateForPick;
  const pickCalls = [];
  if (typeof originalUpdateForPick !== "function") {
    throw new Error("terrain provider updateForPick seam is unavailable");
  }
  pickProvider.updateForPick = function (...args) {
    const before = tuple();
    const result = originalUpdateForPick.apply(this, args);
    const after = tuple();
    pickCalls.push({ before, after });
    return result;
  };
  let picked;
  let pickFrames = 0;
  let pickSettled = false;
  let pickError;
  const pickableBefore = globe.pickable;
  globe.pickable = true;
  renderNow();
  const globePickId = globe._pickId;
  const pickIdKey = globePickId?.key ?? null;
  const pickIdAllocated = Number.isInteger(pickIdKey) && pickIdKey > 0;
  const pickIdRegistryOwnsGlobe =
    scene.context?._pickObjects?.get(pickIdKey)?.primitive === globe;
  const mirroredPickColor = pickProvider._webgpuGlobePickColor;
  const allocatedPickColor = globePickId?.color;
  const pickColorMirrorExact =
    mirroredPickColor === allocatedPickColor &&
    mirroredPickColor?.red === allocatedPickColor?.red &&
    mirroredPickColor?.green === allocatedPickColor?.green &&
    mirroredPickColor?.blue === allocatedPickColor?.blue &&
    mirroredPickColor?.alpha === allocatedPickColor?.alpha;
  try {
    const operation = scene.pickAsync(
      new C.Cartesian2(canvas.width / 2, canvas.height / 2),
    );
    operation.then(
      (value) => {
        picked = value;
        pickSettled = true;
      },
      (error) => {
        pickError = error;
        pickSettled = true;
      },
    );
    while (!pickSettled && pickFrames < contract.maximumPickPumpFrames) {
      renderNow();
      pickFrames++;
      await nextFrame();
    }
    if (!pickSettled) throw new Error("scene.pickAsync did not settle");
    if (pickError) throw pickError;
  } finally {
    pickProvider.updateForPick = originalUpdateForPick;
    globe.pickable = pickableBefore;
    renderNow();
  }
  const observedPick = pickCalls.at(-1);
  const behavioralPick = {
    method: "scene.pickAsync",
    invoked: true,
    awaited: true,
    settled: pickSettled,
    renderPumpFrames: pickFrames,
    maximumPumpFrames: contract.maximumPickPumpFrames,
    directUpdateForPickCall: false,
    pickableBefore,
    pickableRequested: true,
    pickIdAllocated,
    pickIdKey,
    pickIdRegistryOwnsGlobe,
    pickColorMirrorExact,
    updateForPickObserved: pickCalls.length > 0,
    updateForPickCalls: pickCalls.length,
    resultKind: picked?.primitive === globe ? "globe" : typeof picked,
    resultPrimitiveIdentity: picked?.primitive === globe,
    pickableAfterRestore: globe.pickable,
    pickableRestored:
      globe.pickable === pickableBefore &&
      pickProvider._webgpuGlobePickColor === undefined,
    postcondition: {
      before: observedPick?.before ?? null,
      after: observedPick?.after ?? null,
      surfaceRadius: observedPick?.after?.surfaceRadius ?? null,
      selectionRevision: observedPick?.after?.selectionRevision ?? null,
      selectedTileIds: observedPick?.after?.selectedTileIds ?? [],
    },
  };
  complete(contract.phases[5]);

  mark(contract.phases[6], "manager-driven-retained-capture");
  let retainedCapture;
  if (contract.renderer === "webgl") {
    retainedCapture = { applicability: "N/A-WebGPU-only" };
  } else {
    scene.context._options.webgpu ??= {};
    scene.context._options.webgpu.sceneCaptureReflections = true;
    const modelPosition = ellipsoid.cartographicToCartesian(
      new C.Cartographic(
        eventCentre.longitude,
        eventCentre.latitude,
        contract.heightMeters + 100,
      ),
    );
    const model = await C.Model.fromGltfAsync({
      url: contract.tinyModelRoute,
      modelMatrix: C.Transforms.eastNorthUpToFixedFrame(
        modelPosition,
        ellipsoid,
      ),
      scale: 1,
    });
    scene.primitives.add(model);
    await settle(() => model.ready === true, 180, "tiny retained model");
    const manager = model.environmentMapManager;
    manager.enabled = true;
    manager.enableSceneCapture = false;
    for (let index = 0; index < 4; index++) {
      renderNow();
      await nextFrame();
    }
    const sources = scene.context._webgpuSceneCaptureSources;
    const retainedTiles = [
      ...(sources?.tileProvider?._quadtree?._tilesToRender ?? []),
    ];
    const retainedTileIds = retainedTiles.map(tileId).sort();
    const retainedSelectionRevision =
      sources?.tileProvider?._eclipseSelectionRevision;
    const retainedRadius = sources?.tileProvider?._eclipseSurfaceRadius;
    const captureGlobeRenderer = sources?.globeRenderer;
    if (captureGlobeRenderer !== globeRenderer) {
      throw new Error("retained capture globe renderer identity drifted");
    }
    const captureCalls = [];
    const originalCaptureCommands =
      captureGlobeRenderer.getOrCreateCaptureTileCommands;
    captureGlobeRenderer.getOrCreateCaptureTileCommands = function (...args) {
      const frameState = args[3];
      const uniformState = args[4];
      const commands = originalCaptureCommands.apply(this, args);
      const eclipsePrepare = [...eclipsePrepareRecords]
        .reverse()
        .find((record) => record.frameNumber === frameState.frameNumber);
      captureCalls.push({
        tileId: tileId(args[0]),
        prepared: frameState.eclipseGlobeShadowPrepared === true,
        selectionRevision: frameState.eclipseGlobeShadowSelectionRevision,
        surfaceRadius: frameState.eclipseGlobeShadowSurfaceRadius,
        eclipseOffset: eclipsePrepare?.offset ?? null,
        eclipseSize: eclipsePrepare?.size ?? null,
        eclipsePayload: eclipsePrepare?.payload ?? [],
        view: Array.from(uniformState.view),
        dynamicOffsets: (commands ?? []).map((command) =>
          Array.from(command.bindGroup0DynamicOffsets ?? []),
        ),
        positiveDraws: (commands ?? []).filter(
          (command) => command.indexCount > 0,
        ).length,
        cameraInverseRadii: [
          this._cameraUniformData[contract.cameraUboIndices.inverseRadiiX],
          this._cameraUniformData[contract.cameraUboIndices.inverseRadiiY],
          this._cameraUniformData[contract.cameraUboIndices.inverseRadiiZ],
        ],
      });
      return commands;
    };
    const uniformState = scene.context.uniformState;
    const cameraBefore = {
      position: [
        uniformState.cameraPosition.x,
        uniformState.cameraPosition.y,
        uniformState.cameraPosition.z,
      ],
      view: Array.from(uniformState.view),
      projection: Array.from(uniformState.projection),
    };
    manager.enableSceneCapture = true;
    manager.reset();
    try {
      await settle(
        () =>
          manager._webgpuCache?.lastSceneCaptureResult === 2 &&
          captureCalls.length >= 6,
        contract.maximumRetainedCaptureFrames,
        "manager-driven retained capture",
      );
    } finally {
      captureGlobeRenderer.getOrCreateCaptureTileCommands =
        originalCaptureCommands;
    }
    const cameraAfter = {
      position: [
        uniformState.cameraPosition.x,
        uniformState.cameraPosition.y,
        uniformState.cameraPosition.z,
      ],
      view: Array.from(uniformState.view),
      projection: Array.from(uniformState.projection),
    };
    const sameNumbers = (left, right) =>
      left.length === right.length &&
      left.every((value, index) => Object.is(value, right[index]));
    const uniqueViews = new Set(
      captureCalls.map((call) => JSON.stringify(call.view)),
    );
    const calledTileIds = [
      ...new Set(captureCalls.map((call) => call.tileId)),
    ].sort();
    const positiveDraws = captureCalls.reduce(
      (sum, call) => sum + call.positiveDraws,
      0,
    );
    const tilesByView = new Map();
    for (const call of captureCalls) {
      const key = JSON.stringify(call.view);
      const tiles = tilesByView.get(key) ?? new Set();
      tiles.add(call.tileId);
      tilesByView.set(key, tiles);
    }
    const faceTileCardinalityExact =
      uniqueViews.size === 6 &&
      captureCalls.length === 6 * retainedTileIds.length &&
      [...tilesByView.values()].every(
        (tiles) =>
          JSON.stringify([...tiles].sort()) === JSON.stringify(retainedTileIds),
      );
    const expectedInverse = [
      Math.fround(1 / contract.radii.x),
      Math.fround(1 / contract.radii.y),
      Math.fround(1 / contract.radii.z),
    ];
    retainedCapture = {
      applicability: "required",
      managerDriven: true,
      directCaptureHelperCall: false,
      tinyLocalModel: true,
      faceCount: uniqueViews.size,
      faceTileCardinalityExact,
      captureTileCallCount: captureCalls.length,
      terrainDrawCount: positiveDraws,
      selectedTileIds: retainedTileIds,
      calledTileIds,
      cameraRestored:
        sameNumbers(cameraBefore.position, cameraAfter.position) &&
        sameNumbers(cameraBefore.view, cameraAfter.view) &&
        sameNumbers(cameraBefore.projection, cameraAfter.projection),
      preparedTuplePreserved:
        captureCalls.length > 0 &&
        captureCalls.every(
          (call) =>
            call.prepared === true &&
            call.selectionRevision === retainedSelectionRevision &&
            call.surfaceRadius === retainedRadius &&
            JSON.stringify(calledTileIds) === JSON.stringify(retainedTileIds),
        ),
      cameraUboInverseRadiiExact: captureCalls.every((call) =>
        call.cameraInverseRadii.every((value, index) =>
          Object.is(value, expectedInverse[index]),
        ),
      ),
      eclipseBindingOffsetsExact:
        captureCalls.length > 0 &&
        captureCalls.every(
          (call) =>
            call.eclipseSize === 64 &&
            call.dynamicOffsets.length > 0 &&
            call.dynamicOffsets.every(
              (offsets) =>
                offsets.length === 3 &&
                offsets[2] === call.eclipseOffset &&
                Number.isInteger(offsets[2]) &&
                offsets[2] %
                  scene.context._device.limits
                    .minUniformBufferOffsetAlignment ===
                  0,
            ),
        ),
      eclipseBindingPayloads: captureCalls.map((call) => call.eclipsePayload),
      eclipseBindingPayloadsExact: false,
      submittedWork: manager._webgpuCache?.lastSceneCaptureResult === 2,
      statusCode: manager._webgpuCache?.lastSceneCaptureResult ?? null,
    };
    scene.primitives.remove(model);
  }
  complete(contract.phases[6]);

  mark(contract.phases[7], "plus-24h-identity-pair");
  pinnedTime = C.JulianDate.fromIso8601(contract.controlIso);
  viewer.clock.currentTime = pinnedTime.clone();
  cameraAt(eventCentre.longitude, eventCentre.latitude);
  lighting.enableEclipseGlobeShadow = false;
  await settle(() => tuple().prepared, 30, "noneclipse control tuple");
  renderNow();
  const controlPreparedTupleBefore = tuple();
  await capture("control-off");
  const controlOffPreparedTuple = tuple();
  lighting.enableEclipseGlobeShadow = true;
  await capture("control-on");
  const controlOnPreparedTuple = tuple();
  const controlShadow = scene.frameState?.eclipseGlobeShadow;
  const noneclipseControl = {
    clockIso: C.JulianDate.toIso8601(pinnedTime),
    runtimeBodies: fixedBodies(pinnedTime),
    inactive:
      !controlShadow ||
      controlShadow.active !== true ||
      !(controlShadow.params?.x > 0.5),
    gate: controlShadow?.params?.x ?? 0,
    preparedTupleBefore: controlPreparedTupleBefore,
    offPreparedTuple: controlOffPreparedTuple,
    onPreparedTuple: controlOnPreparedTuple,
    offOnByteIdentical: false,
  };
  complete(contract.phases[7]);

  mark(contract.phases[8], "restoring-instrumentation");
  if (contract.renderer === "webgpu") {
    eclipseManager.prepare = originalEclipsePrepare;
  }
  C.Ellipsoid.default = originalDefaultEllipsoid;
  const sessionCleanup = {
    complete: true,
    timersCleared: true,
    instrumentationRestored:
      contract.renderer !== "webgpu" ||
      eclipseManager.prepare === originalEclipsePrepare,
    defaultEllipsoidRestored: C.Ellipsoid.default === originalDefaultEllipsoid,
  };
  complete(contract.phases[8]);

  const phases = {
    [contract.phases[0]]: construction,
    [contract.phases[1]]: preparation,
    [contract.phases[2]]: eventOff,
    [contract.phases[3]]: eventOn,
    [contract.phases[4]]: antipodePhase,
    [contract.phases[5]]: behavioralPick,
    [contract.phases[6]]: retainedCapture,
    [contract.phases[7]]: noneclipseControl,
    [contract.phases[8]]: sessionCleanup,
  };
  return {
    renderer: contract.renderer,
    actualRenderer,
    phaseOrder: [...contract.phases],
    completedPhases: [...progress.completedPhases],
    phases,
    captures,
    oracleSamples: [],
    runtime: {
      pageErrors: [],
      consoleErrors: [],
      gpuErrors: [],
      deviceLost: false,
    },
    cleanup: {
      complete: true,
      pageClosed: false,
      timersCleared: sessionCleanup.timersCleared,
    },
  };
};

function decodePngDataUrl(dataUrl) {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/u.exec(
    dataUrl ?? "",
  );
  if (!match) throw new Error("capture is not a canonical base64 PNG data URL");
  const bytes = Buffer.from(match[1], "base64");
  if (
    bytes.length < 8 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    throw new Error("capture data URL does not contain a PNG signature");
  }
  return bytes;
}

function pngDimensions(bytes) {
  if (bytes.length < 24 || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("capture PNG has no complete IHDR dimensions");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width <= 0 || height <= 0) {
    throw new Error("capture PNG dimensions are not positive");
  }
  return { width, height };
}

function materializeC1229S5CustomImages(
  session,
  runId,
  paths,
  ownedPngs,
  operations = fs,
) {
  const byLabel = new Map();
  const images = [];
  for (const capture of session.captures ?? []) {
    if (byLabel.has(capture.label)) {
      throw new Error(
        `${session.renderer}: duplicate ${capture.label} capture`,
      );
    }
    const bytes = decodePngDataUrl(capture.dataUrl);
    const dimensions = pngDimensions(bytes);
    if (
      dimensions.width !== capture.width ||
      dimensions.height !== capture.height
    ) {
      throw new Error(
        `${session.renderer}: ${capture.label} browser/PNG dimensions disagree`,
      );
    }
    const imageId = randomUUID();
    const fileName = `${runId}.${imageId}.${session.renderer}.${capture.label}.png`;
    const file = path.join(paths.directory, fileName);
    operations.writeFileSync(file, bytes, { flag: "wx" });
    ownedPngs.push({ file, bytes: Buffer.from(bytes) });
    const retained = operations.readFileSync(file);
    const retainedBytes = Buffer.isBuffer(retained)
      ? retained
      : Buffer.from(retained);
    if (!retainedBytes.equals(bytes)) {
      throw new Error(
        `${session.renderer}: ${capture.label} PNG changed on write`,
      );
    }
    const image = {
      label: capture.label,
      imageId,
      fileName,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
      width: dimensions.width,
      height: dimensions.height,
      captureMethod: capture.captureMethod,
      renderTaskToken: capture.renderTaskToken,
      captureTaskToken: capture.captureTaskToken,
      metricImageId: imageId,
      fingerprintVerified: true,
      temporalStability: {
        method: capture.temporalStability?.method,
        requiredConsecutiveFrames:
          capture.temporalStability?.requiredConsecutiveFrames,
        maximumFrames: capture.temporalStability?.maximumFrames,
        attemptedFrames: capture.temporalStability?.attemptedFrames,
        observations: (capture.temporalStability?.observations ?? []).map(
          (observation) => {
            const observationBytes = decodePngDataUrl(observation.dataUrl);
            const observationDimensions = pngDimensions(observationBytes);
            return {
              ordinal: observation.ordinal,
              frameNumber: observation.frameNumber,
              byteLength: observationBytes.byteLength,
              sha256: sha256(observationBytes),
              width: observationDimensions.width,
              height: observationDimensions.height,
              state: observation.state,
            };
          },
        ),
        captureFrameNumber: capture.temporalStability?.captureFrameNumber,
        captureState: capture.temporalStability?.captureState,
        captureOutput: {
          byteLength: bytes.byteLength,
          sha256: sha256(bytes),
          width: dimensions.width,
          height: dimensions.height,
        },
        renderFirst: capture.temporalStability?.renderFirst,
        sameTaskFusedCapture: capture.temporalStability?.sameTaskFusedCapture,
      },
    };
    byLabel.set(capture.label, { image, bytes });
    images.push(image);
  }
  if (
    images.length !== C12_29_S5_CUSTOM_CAPTURE_LABELS.length ||
    !C12_29_S5_CUSTOM_CAPTURE_LABELS.every(
      (label, index) => images[index]?.label === label,
    )
  ) {
    throw new Error(`${session.renderer}: exact six-capture order is absent`);
  }
  session.images = images;
  delete session.captures;
  return byLabel;
}

/** Remove only UUID image bytes created and still owned by this invocation. */
export function cleanupC1229S5CustomOwnedPngs(ownedPngs, operations = fs) {
  const reasons = [];
  let removed = 0;
  for (const owned of [...ownedPngs].reverse()) {
    let current;
    try {
      current = readBytesIfPresent(owned.file, operations);
    } catch (error) {
      reasons.push(`${owned.file}: cleanup read failed: ${error.message}`);
      continue;
    }
    if (current === undefined) continue;
    if (!Buffer.from(current).equals(owned.bytes)) {
      reasons.push(`${owned.file}: foreign replacement preserved`);
      continue;
    }
    try {
      operations.unlinkSync(owned.file);
      if (readBytesIfPresent(owned.file, operations) !== undefined) {
        reasons.push(`${owned.file}: owned PNG remained after unlink`);
      } else {
        removed++;
      }
    } catch (error) {
      reasons.push(`${owned.file}: cleanup unlink failed: ${error.message}`);
    }
  }
  return { ok: reasons.length === 0, removed, reasons };
}

function exactNumberArray(left, right) {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]))
  );
}

function c1229S5CustomRgbaLuminance(value) {
  return (0.2126 * value[0] + 0.7152 * value[1] + 0.0722 * value[2]) / 255;
}

function enrichC1229S5CustomOracle(session, imageBytes) {
  const event = session.phases["event-s5-on"];
  const bodies = event.runtimeBodies;
  const params = event.shadowBlock.params;
  const params2 = event.shadowBlock.params2;
  const derive = (candidate, offLabel, onLabel) => {
    const offLuminance = c1229S5CustomRgbaLuminance(candidate.offRgba);
    const onLuminance = c1229S5CustomRgbaLuminance(candidate.onRgba);
    const oracle = deriveC1229S5CustomOracleSample({
      cartographic: {
        longitude: candidate.longitude,
        latitude: candidate.latitude,
        height: candidate.height,
      },
      sun: bodies.sun,
      moon: bodies.moon,
      params,
      params2,
      offLuminance,
      onLuminance,
      runtimePosition: candidate.runtimePosition,
    });
    if (!oracle) return undefined;
    const sample = {
      id: "pending",
      cartographic: {
        longitude: candidate.longitude,
        latitude: candidate.latitude,
        height: candidate.height,
      },
      pixel: { x: candidate.x, y: candidate.y },
      tileId: candidate.tileId,
      tileUv: candidate.tileUv,
      normalizedBoundaryDistance: candidate.normalizedBoundaryDistance,
      tileBoundaryPixels: candidate.tileBoundaryPixels,
      tileBoundaryDistancesPixels: candidate.tileBoundaryDistancesPixels,
      boundaryDistancePixels: candidate.boundaryDistancePixels,
      flatTileInterior: candidate.flatTileInterior,
      runtimePosition: candidate.runtimePosition,
      offRgba: candidate.offRgba,
      onRgba: candidate.onRgba,
      offMetricImageId: imageBytes.get(offLabel).image.imageId,
      onMetricImageId: imageBytes.get(onLabel).image.imageId,
      boundaryAmbiguous: oracle.boundaryAmbiguous,
      classification: oracle.classificationF64,
      classificationF32: oracle.classificationF32,
      offLuminance,
      onLuminance,
      f64: oracle.f64,
      f32: oracle.f32,
      f32Error: oracle.f32Error,
      quantizationBound: oracle.quantizationBound,
      tolerance: oracle.tolerance,
      observedFactor: oracle.observedFactor,
      absoluteError: oracle.absoluteError,
      withinTolerance: oracle.withinTolerance,
      horizonRejectedF64: oracle.horizonRejectedF64,
      horizonRejectedF32: oracle.horizonRejectedF32,
      geometricF64: oracle.geometricF64,
      geometricF32: oracle.geometricF32,
      geometryIdentity: oracle.geometryIdentity,
    };
    sample.id = deriveC1229S5CustomSampleId(sample);
    return sample;
  };
  const eligible = event.candidates
    .map((candidate) => derive(candidate, "event-off", "event-on"))
    .filter(Boolean)
    .filter(
      (sample) =>
        sample.flatTileInterior &&
        !sample.boundaryAmbiguous &&
        sample.geometryIdentity?.withinTolerance &&
        sample.offLuminance >= C12_29_S5_CUSTOM_SCENE.minimumOffLuminance,
    );
  const selected = [];
  for (const classification of ["umbra", "penumbra", "clear"]) {
    const classSamples = eligible
      .filter((sample) => sample.classification === classification)
      // Selection is outcome-blind: observed error never chooses a patch.
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, C12_29_S5_CUSTOM_SCENE.minimumOracleSamplesPerClass);
    selected.push(...classSamples);
  }
  session.oracleSamples = selected;
  event.oracleSampleCount = selected.length;
  event.oracleSampleCounts = Object.fromEntries(
    ["umbra", "penumbra", "clear"].map((classification) => [
      classification,
      selected.filter((sample) => sample.classification === classification)
        .length,
    ]),
  );
  event.hasUmbra = event.oracleSampleCounts.umbra >= 3;
  event.hasPenumbra = event.oracleSampleCounts.penumbra >= 3;
  event.hasClear = event.oracleSampleCounts.clear >= 3;
  event.allSamplesWithinDerivedTolerance =
    selected.length >= 9 && selected.every((sample) => sample.withinTolerance);
  const independentAxis = deriveC1229S5CustomAxisIntersection({
    sun: bodies.sun,
    moon: bodies.moon,
  });
  const axisPointTolerance = c1229S5CustomGeometryTolerance(
    "axisIntersectionPoint",
    "meters",
  );
  const axisDirectionTolerance = c1229S5CustomGeometryTolerance(
    "axisDirection",
    "dimensionless",
  );
  const pointDifferenceMeters = independentAxis
    ? Math.hypot(
        independentAxis.point.x - event.eventCentre.point.x,
        independentAxis.point.y - event.eventCentre.point.y,
        independentAxis.point.z - event.eventCentre.point.z,
      )
    : Number.POSITIVE_INFINITY;
  const directionDifference = independentAxis
    ? Math.hypot(
        independentAxis.direction.x - event.eventCentre.direction.x,
        independentAxis.direction.y - event.eventCentre.direction.y,
        independentAxis.direction.z - event.eventCentre.direction.z,
      )
    : Number.POSITIVE_INFINITY;
  const rootDifferenceMeters = independentAxis
    ? Math.abs(independentAxis.forwardRoot - event.eventCentre.forwardRoot)
    : Number.POSITIVE_INFINITY;
  const surfacePoint = customEllipsoidGeodeticToEcef({
    longitude: event.eventCentre.longitude,
    latitude: event.eventCentre.latitude,
    height: 0,
  });
  const surfacePointDifferenceMeters = surfacePoint
    ? Math.hypot(
        surfacePoint.x - event.eventCentre.point.x,
        surfacePoint.y - event.eventCentre.point.y,
        surfacePoint.z - event.eventCentre.point.z,
      )
    : Number.POSITIVE_INFINITY;
  const surfacePointToleranceMeters =
    axisPointTolerance +
    c1229S5CustomGeometryTolerance("ecefPosition", "meters");
  event.eventCentre.geometryIdentity = {
    baseEpsilonMeters: C12_29_S5_CUSTOM_GEOMETRY_EPSILON_METERS,
    pointDifferenceMeters,
    pointToleranceMeters: axisPointTolerance,
    directionDifference,
    directionTolerance: axisDirectionTolerance,
    rootDifferenceMeters,
    rootToleranceMeters: axisPointTolerance,
    surfacePointDifferenceMeters,
    surfacePointToleranceMeters,
    withinTolerance:
      pointDifferenceMeters <= axisPointTolerance &&
      directionDifference <= axisDirectionTolerance &&
      rootDifferenceMeters <= axisPointTolerance &&
      surfacePointDifferenceMeters <= surfacePointToleranceMeters,
  };
  delete event.candidates;

  const expectedPayload = Array.from(
    packC1229S5CustomCommonRay(
      { sun: bodies.sun, moon: bodies.moon, params, params2 },
      "f32",
    ),
  );
  if (session.renderer === "webgl") {
    event.shadowBlock.webglPackedF32 = event.shadowBlock.webglPackedUniform.map(
      Math.fround,
    );
    event.shadowBlock.payloadExact = exactNumberArray(
      event.shadowBlock.webglPackedF32,
      expectedPayload,
    );
  } else {
    const identity =
      session.phases["selected-terrain-preparation"].backendIdentity;
    const values = identity.cameraUbo.values;
    identity.cameraUbo.valuesExact =
      Object.is(values.inverseRadiiX, Math.fround(1 / 8_000_000)) &&
      Object.is(values.inverseRadiiY, Math.fround(1 / 8_000_000)) &&
      Object.is(values.inverseRadiiZ, Math.fround(1 / 5_000_000)) &&
      Object.is(values.maximumRadius, Math.fround(8_000_000));
    identity.eclipseBinding.payloadExact = exactNumberArray(
      identity.eclipseBinding.payload,
      expectedPayload,
    );
    const retained = session.phases["retained-capture"];
    retained.eclipseBindingPayloadsExact =
      Array.isArray(retained.eclipseBindingPayloads) &&
      retained.eclipseBindingPayloads.length > 0 &&
      retained.eclipseBindingPayloads.every((payload) =>
        exactNumberArray(payload, expectedPayload),
      );
  }

  const antipode = session.phases["antipode-horizon-control"];
  const antipodeOracle = antipode.candidates
    .map((candidate) => derive(candidate, "antipode-off", "antipode-on"))
    .filter(Boolean)
    .filter(
      (sample) =>
        sample.flatTileInterior &&
        !sample.boundaryAmbiguous &&
        sample.geometryIdentity?.withinTolerance &&
        sample.geometryIdentity?.horizonCompared &&
        sample.offLuminance >= C12_29_S5_CUSTOM_SCENE.minimumOffLuminance &&
        sample.horizonRejectedF64 &&
        sample.horizonRejectedF32,
    )
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, 8);
  antipode.samples = antipodeOracle;
  antipode.allCandidatesHorizonRejected =
    antipodeOracle.length >= 3 &&
    antipodeOracle.every(
      (sample) => sample.horizonRejectedF64 && sample.horizonRejectedF32,
    );
  antipode.offOnByteIdentical = imageBytes
    .get("antipode-off")
    .bytes.equals(imageBytes.get("antipode-on").bytes);
  delete antipode.candidates;
  const control = session.phases["noneclipse-identity-control"];
  control.offOnByteIdentical = imageBytes
    .get("control-off")
    .bytes.equals(imageBytes.get("control-on").bytes);
}

function deriveC1229S5CustomCrossBackendReport(sessions) {
  const [webgl, webgpu] = sessions;
  const gpuById = new Map(
    webgpu.oracleSamples.map((sample) => [sample.id, sample]),
  );
  const samples = [];
  for (const left of webgl.oracleSamples) {
    const right = gpuById.get(left.id);
    if (!right || right.classification !== left.classification) continue;
    const comparison = deriveC1229S5CustomCrossBackend(left, right);
    if (!comparison) continue;
    samples.push({
      id: left.id,
      classification: left.classification,
      webglObservedFactor: left.observedFactor,
      webgpuObservedFactor: right.observedFactor,
      maximumF32Error: comparison.maximumF32Error,
      quantizationBound: comparison.quantizationBound,
      tolerance: comparison.tolerance,
      absoluteDifference: comparison.absoluteDifference,
      withinTolerance: comparison.withinTolerance,
    });
  }
  return {
    aggregation: C12_29_S5_CUSTOM_AGGREGATION,
    matchedSampleCount: samples.length,
    allWithinDerivedTolerance:
      samples.length >=
        3 * C12_29_S5_CUSTOM_SCENE.minimumOracleSamplesPerClass &&
      samples.every((sample) => sample.withinTolerance),
    samples,
  };
}

function pageContract(renderer) {
  return {
    diagnosticsSchema: C12_29_S5_CUSTOM_DIAGNOSTICS_SCHEMA,
    renderer,
    runtimePath,
    phases: [...C12_29_S5_CUSTOM_PHASES],
    captureMethod: C12_29_S5_CUSTOM_CAPTURE_METHOD,
    stabilityMethod: C12_29_S5_CUSTOM_STABILITY_METHOD,
    eventIso: C12_29_S5_CUSTOM_SCENE.eventIso,
    controlIso: C12_29_S5_CUSTOM_SCENE.controlIso,
    radii: { ...C12_29_S5_CUSTOM_SCENE.radii },
    heightMeters: C12_29_S5_CUSTOM_SCENE.heightMeters,
    terrainWidth: C12_29_S5_CUSTOM_SCENE.terrainWidth,
    terrainHeight: C12_29_S5_CUSTOM_SCENE.terrainHeight,
    verticalExaggeration: C12_29_S5_CUSTOM_SCENE.verticalExaggeration,
    verticalExaggerationRelativeHeight:
      C12_29_S5_CUSTOM_SCENE.verticalExaggerationRelativeHeight,
    viewport: { ...C12_29_S5_CUSTOM_SCENE.viewport },
    cameraHeightMeters: C12_29_S5_CUSTOM_SCENE.cameraHeightMeters,
    cameraFovDegrees: C12_29_S5_CUSTOM_SCENE.cameraFovDegrees,
    maximumScreenSpaceError: C12_29_S5_CUSTOM_SCENE.maximumScreenSpaceError,
    tileInteriorPixelFootprintRadius:
      C12_29_S5_CUSTOM_SCENE.tileInteriorPixelFootprintRadius,
    minimumStableFrames: C12_29_S5_CUSTOM_SCENE.minimumStableFrames,
    maximumStabilityFrames: C12_29_S5_CUSTOM_SCENE.maximumStabilityFrames,
    maximumSettleFrames: C12_29_S5_CUSTOM_SCENE.maximumSettleFrames,
    maximumPickPumpFrames: C12_29_S5_CUSTOM_SCENE.maximumPickPumpFrames,
    maximumRetainedCaptureFrames:
      C12_29_S5_CUSTOM_SCENE.maximumRetainedCaptureFrames,
    radiusLaw: { ...C12_29_S5_CUSTOM_RADIUS_LAW },
    cameraUboIndices: { ...C12_29_S5_CUSTOM_WEBGPU_CAMERA_INDICES },
    eclipseBinding: C12_29_S5_CUSTOM_WEBGPU_ECLIPSE_BINDING,
    tinyModelRoute:
      "/Specs/Data/Models/glTF-2.0/BoxTextured/glTF-Binary/BoxTextured.glb",
  };
}

export async function closeC1229S5CustomResourceBounded(
  instance,
  label,
  timeoutMs = CLOSE_TIMEOUT_MS,
) {
  if (!instance) {
    return { label, attempted: false, closed: true, timedOut: false };
  }
  let timer;
  const result = await Promise.race([
    Promise.resolve()
      .then(() => instance.close())
      .then(
        () => ({ closed: true, timedOut: false }),
        (error) => ({ closed: false, timedOut: false, error }),
      ),
    new Promise((resolve) => {
      timer = setTimeout(
        () => resolve({ closed: false, timedOut: true }),
        timeoutMs,
      );
    }),
  ]);
  clearTimeout(timer);
  return { label, attempted: true, ...result };
}

async function runC1229S5CustomBrowserSession(
  browser,
  renderer,
  baseIdentity,
  runId,
  paths,
  ownedPngs,
  operations = fs,
) {
  const context = await browser.newContext({
    viewport: { ...C12_29_S5_CUSTOM_SCENE.viewport },
    deviceScaleFactor: 1,
  });
  const externalRequests = [];
  const failedRequests = [];
  const httpErrors = [];
  const pageErrors = [];
  const consoleErrors = [];
  const pending = new Set();
  await context.route("**/*", async (route) => {
    let url;
    try {
      url = new URL(route.request().url());
    } catch {
      await route.continue();
      return;
    }
    if (/^https?:$/u.test(url.protocol) && url.origin !== baseIdentity.origin) {
      externalRequests.push(route.request().url());
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  const page = await context.newPage();
  await page.addInitScript(errorGateInit);
  page.on("request", (request) => pending.add(request));
  const settleRequest = (request) => pending.delete(request);
  page.on("requestfinished", settleRequest);
  page.on("requestfailed", (request) => {
    settleRequest(request);
    if (!externalRequests.includes(request.url()))
      failedRequests.push(request.url());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  const xysResponses = [];
  const responseTasks = [];
  let capturedEntry = false;
  let entryResolve;
  let entryReject;
  const entryPromise = new Promise((resolve, reject) => {
    entryResolve = resolve;
    entryReject = reject;
  });
  page.on("response", (response) => {
    let url;
    try {
      url = new URL(response.url());
    } catch {
      return;
    }
    if (response.status() >= 400)
      httpErrors.push(`${response.status()} ${url.href}`);
    if (!capturedEntry && url.pathname === runtimePath) {
      capturedEntry = true;
      const task = response.body().then(
        (bytes) =>
          entryResolve({
            sessionLabel: renderer,
            ok: response.ok(),
            status: response.status(),
            byteLength: bytes.byteLength,
            sha256: sha256(bytes),
          }),
        entryReject,
      );
      responseTasks.push(task);
    }
    if (
      url.origin === baseIdentity.origin &&
      /^\/Build\/CesiumUnminified\/Assets\/IAU2006_XYS\/IAU2006_XYS_\d+\.json$/u.test(
        url.pathname,
      )
    ) {
      responseTasks.push(
        response.body().then((bytes) => {
          xysResponses.push({
            file: path.basename(url.pathname),
            route: url.pathname,
            status: response.status(),
            exists: true,
            byteLength: bytes.byteLength,
            sha256: sha256(bytes),
          });
        }),
      );
    }
  });
  let measured;
  let sessionError;
  let diagnostics;
  try {
    const url = new URL(viewerPath, baseIdentity.origin);
    url.searchParams.set("renderer", renderer);
    url.searchParams.set("offline", "true");
    await page.goto(url.href, {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    await page.waitForFunction(
      () => Boolean(globalThis.viewer?.scene?.context),
      undefined,
      { timeout: 90_000 },
    );
    await armWebGPUDevices(page);
    let pageTimer;
    try {
      measured = await Promise.race([
        page.evaluate(MEASURE_C1229_S5_CUSTOM_SESSION, pageContract(renderer)),
        new Promise((_, reject) => {
          pageTimer = setTimeout(
            () => reject(new Error(`${renderer} custom page timeout`)),
            PAGE_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      clearTimeout(pageTimer);
    }
    await Promise.all(responseTasks);
    measured.servedEntry = await entryPromise;
    const gpuGate = await collectGateErrors(page);
    measured.runtime = {
      pageErrors: [...pageErrors],
      consoleErrors: [...consoleErrors],
      gpuErrors: [...gpuGate.errors],
      deviceLost: gpuGate.deviceLost !== null,
      armedDevices: gpuGate.armedDevices,
    };
    measured.transport = {
      loopback: true,
      sameOriginOnly: externalRequests.length === 0,
      externalRequests,
      failedRequests,
      httpErrors,
    };
    measured.xysResponses = xysResponses.sort((left, right) =>
      left.file.localeCompare(right.file),
    );
    const imageBytes = materializeC1229S5CustomImages(
      measured,
      runId,
      paths,
      ownedPngs,
      operations,
    );
    enrichC1229S5CustomOracle(measured, imageBytes);
  } catch (error) {
    sessionError = error;
    try {
      diagnostics = await page.evaluate(() =>
        globalThis.__c1229S5CustomProgress
          ? JSON.parse(JSON.stringify(globalThis.__c1229S5CustomProgress))
          : null,
      );
    } catch {
      diagnostics = null;
    }
  }
  const pageClose = await closeC1229S5CustomResourceBounded(
    page,
    `${renderer} page`,
  );
  const contextClose = await closeC1229S5CustomResourceBounded(
    context,
    `${renderer} context`,
  );
  if (measured) {
    measured.cleanup = {
      complete: pageClose.closed && contextClose.closed && pending.size === 0,
      pageClosed: pageClose.closed,
      contextClosed: contextClose.closed,
      timersCleared: measured.phases["session-cleanup"]?.timersCleared === true,
      pendingRequests: pending.size,
      pageCloseTimedOut: pageClose.timedOut,
      contextCloseTimedOut: contextClose.timedOut,
    };
  }
  const closeErrors = [pageClose, contextClose]
    .filter((result) => !result.closed)
    .map(
      (result) =>
        result.error ??
        new Error(`${result.label} close expired after ${CLOSE_TIMEOUT_MS} ms`),
    );
  if (sessionError || closeErrors.length > 0) {
    const errors = [...(sessionError ? [sessionError] : []), ...closeErrors];
    const error =
      errors.length === 1
        ? errors[0]
        : new AggregateError(errors, `${renderer} custom session failed`);
    error.customDiagnostics = {
      schema: C12_29_S5_CUSTOM_DIAGNOSTICS_SCHEMA,
      renderer,
      stage: diagnostics?.currentPhase ?? "node-session",
      timeoutMs: PAGE_TIMEOUT_MS,
      page: diagnostics,
    };
    throw error;
  }
  return measured;
}

async function closeBrowserOrThrow(browser) {
  const result = await closeC1229S5CustomResourceBounded(browser, "browser");
  if (!result.closed) {
    const error =
      result.error ??
      new Error(`browser close expired after ${CLOSE_TIMEOUT_MS} ms`);
    error.retainCustomRunning = true;
    throw error;
  }
  return result;
}

export async function withC1229S5CustomWatchdog(
  task,
  closeOnTimeout,
  timeoutMs,
  renderer = "webgl",
) {
  const settlement = Promise.resolve()
    .then(task)
    .then(
      (value) => ({ kind: "value", value }),
      (error) => ({ kind: "error", error }),
    );
  let timer;
  const first = await Promise.race([
    settlement,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  if (first.kind === "value") return first.value;
  if (first.kind === "error") throw first.error;
  let closeTimer;
  const closed = await Promise.race([
    Promise.resolve()
      .then(closeOnTimeout)
      .then(
        () => ({ ok: true }),
        (error) => ({ ok: false, error }),
      ),
    new Promise((resolve) => {
      closeTimer = setTimeout(
        () => resolve({ ok: false, timedOut: true }),
        CLOSE_TIMEOUT_MS,
      );
    }),
  ]);
  clearTimeout(closeTimer);
  let drainTimer;
  const drained = await Promise.race([
    settlement.then(() => true),
    new Promise((resolve) => {
      drainTimer = setTimeout(() => resolve(false), DRAIN_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(drainTimer);
  const error = new Error(
    `custom-ellipsoid watchdog expired after ${timeoutMs} ms; drained=${drained}`,
  );
  const activeRenderer = typeof renderer === "function" ? renderer() : renderer;
  error.customDiagnostics = {
    schema: C12_29_S5_CUSTOM_DIAGNOSTICS_SCHEMA,
    renderer: C12_29_S5_CUSTOM_RENDERERS.includes(activeRenderer)
      ? activeRenderer
      : "webgl",
    stage: "watchdog",
    timeoutMs,
    page: null,
  };
  if (!closed.ok || !drained) error.retainCustomRunning = true;
  if (closed.error) error.cause = closed.error;
  throw error;
}

function publicFingerprint(value) {
  return {
    exists: value?.exists === true,
    byteLength: value?.byteLength ?? null,
    sha256: value?.sha256 ?? null,
  };
}

function composeC1229S5CustomProvenance(start, end, sessions) {
  const comparison = compareEvidenceFileSnapshots(start.local, end.local);
  const servedValidation = validateServedEntryIdentities({
    entries: sessions.map((session) => session.servedEntry),
    expectedLabels: [...C12_29_S5_CUSTOM_RENDERERS],
    localEntry: start.servedEntry,
  });
  const servedStable =
    start.servedEntry?.exists === true &&
    end.servedEntry?.exists === true &&
    start.servedEntry.byteLength === end.servedEntry.byteLength &&
    start.servedEntry.sha256 === end.servedEntry.sha256;
  const servedEntryIdentity = {
    ...servedValidation,
    localStart: publicFingerprint(start.servedEntry),
    localEnd: publicFingerprint(end.servedEntry),
    stable: servedStable,
  };
  const reasons = [...comparison.reasons, ...servedValidation.reasons];
  if (!servedStable) {
    reasons.push("local served runtime entry changed during the run");
  }
  if (start.gitHead !== end.gitHead) {
    reasons.push("git HEAD changed during the custom-ellipsoid run");
  }
  if (!start.buildSourceIdentity.ok) {
    reasons.push(...start.buildSourceIdentity.reasons);
  }
  if (!end.buildSourceIdentity.ok) {
    reasons.push(...end.buildSourceIdentity.reasons);
  }
  if (
    start.buildSourceIdentity.sourceMapSha256 !==
    end.buildSourceIdentity.sourceMapSha256
  ) {
    reasons.push("build source map changed during the run");
  }
  if (
    !start.generatedShaders.globeFsExact ||
    !start.generatedShaders.globeTerrainExact ||
    !end.generatedShaders.globeFsExact ||
    !end.generatedShaders.globeTerrainExact
  ) {
    reasons.push("raw/generated shader identity is not exact");
  }
  if (
    !start.sameTaskCapture.canonical ||
    !start.sameTaskCapture.usageExact ||
    !end.sameTaskCapture.canonical ||
    !end.sameTaskCapture.usageExact
  ) {
    reasons.push(
      ...start.sameTaskCapture.canonicalReasons,
      ...start.sameTaskCapture.usageReasons,
      ...end.sameTaskCapture.canonicalReasons,
      ...end.sameTaskCapture.usageReasons,
    );
  }
  const xys = [];
  for (const session of sessions) {
    for (const served of session.xysResponses ?? []) {
      const localStart = start.xys[served.file];
      const localEnd = end.xys[served.file];
      if (!localStart || !localEnd) {
        reasons.push(
          `${session.renderer}: ${served.file} has no local XYS pin`,
        );
      }
      xys.push({
        renderer: session.renderer,
        file: served.file,
        localStart: publicFingerprint(localStart),
        localEnd: publicFingerprint(localEnd),
        served: publicFingerprint(served),
      });
    }
  }
  if (xys.length < C12_29_S5_CUSTOM_RENDERERS.length) {
    reasons.push("each renderer must serve at least one exact local XYS shard");
  }
  const localFiles = C12_29_S5_CUSTOM_SOURCE_FILES.map((file) => ({
    file,
    start: publicFingerprint(start.local[file]),
    end: publicFingerprint(end.local[file]),
  }));
  const allReadable = localFiles.every(
    (entry) => entry.start.exists && entry.end.exists,
  );
  if (!allReadable)
    reasons.push("one or more source-boundary files are absent");
  const buildSourceStable =
    start.buildSourceIdentity.sourceMapSha256 ===
      end.buildSourceIdentity.sourceMapSha256 &&
    JSON.stringify(start.buildSourceIdentity.entries) ===
      JSON.stringify(end.buildSourceIdentity.entries);
  const generatedShadersStable =
    start.generatedShaders.globeFsExact &&
    start.generatedShaders.globeTerrainExact &&
    end.generatedShaders.globeFsExact &&
    end.generatedShaders.globeTerrainExact;
  const captureHelperFile = "Tools/visual-regression/lib/same-task-capture.mjs";
  return {
    ok: reasons.length === 0,
    stable: reasons.length === 0,
    reasons,
    gitHead: {
      start: start.gitHead,
      end: end.gitHead,
      stable: start.gitHead === end.gitHead,
    },
    sourceBoundary: {
      count: C12_29_S5_CUSTOM_SOURCE_FILES.length,
      files: [...C12_29_S5_CUSTOM_SOURCE_FILES],
      allReadable,
    },
    localFiles,
    generatedShaders: {
      start: { ...start.generatedShaders },
      end: { ...end.generatedShaders },
      stable: generatedShadersStable,
    },
    buildSourceIdentity: {
      start: start.buildSourceIdentity,
      end: end.buildSourceIdentity,
      stable: buildSourceStable,
    },
    servedEntryIdentity,
    xys,
    sameTaskCapture: {
      canonical:
        start.sameTaskCapture.canonical && end.sameTaskCapture.canonical,
      helperPinned:
        start.sameTaskCapture.helperPinned && end.sameTaskCapture.helperPinned,
      usageExact:
        start.sameTaskCapture.usageExact && end.sameTaskCapture.usageExact,
      helperIdentity: {
        file: captureHelperFile,
        start: publicFingerprint(start.local[captureHelperFile]),
        end: publicFingerprint(end.local[captureHelperFile]),
      },
    },
    harnessStable: comparison.ok,
  };
}

function finalContract() {
  return {
    eventIso: C12_29_S5_CUSTOM_SCENE.eventIso,
    controlIso: C12_29_S5_CUSTOM_SCENE.controlIso,
    radii: { ...C12_29_S5_CUSTOM_SCENE.radii },
    heightMeters: C12_29_S5_CUSTOM_SCENE.heightMeters,
    cameraHeightMeters: C12_29_S5_CUSTOM_SCENE.cameraHeightMeters,
    terrainDimensions: {
      width: C12_29_S5_CUSTOM_SCENE.terrainWidth,
      height: C12_29_S5_CUSTOM_SCENE.terrainHeight,
    },
    phaseOrder: [...C12_29_S5_CUSTOM_PHASES],
    captureLabels: [...C12_29_S5_CUSTOM_CAPTURE_LABELS],
    temporalStability: {
      method: C12_29_S5_CUSTOM_STABILITY_METHOD,
      minimumConsecutiveFrames: C12_29_S5_CUSTOM_SCENE.minimumStableFrames,
      maximumFrames: C12_29_S5_CUSTOM_SCENE.maximumStabilityFrames,
    },
    cameraUboIndices: { ...C12_29_S5_CUSTOM_WEBGPU_CAMERA_INDICES },
    eclipseBinding: C12_29_S5_CUSTOM_WEBGPU_ECLIPSE_BINDING,
    radiusLaw: { ...C12_29_S5_CUSTOM_RADIUS_LAW },
    tileInteriorPixelFootprintRadius:
      C12_29_S5_CUSTOM_SCENE.tileInteriorPixelFootprintRadius,
    geometryEpsilonMeters: C12_29_S5_CUSTOM_GEOMETRY_EPSILON_METERS,
    geometryOperationBudgets: C12_29_S5_CUSTOM_GEOMETRY_OPERATION_BUDGETS,
  };
}

function createC1229S5CustomErrorArtifact(runId, error) {
  const diagnostic = error?.customDiagnostics;
  const renderer = C12_29_S5_CUSTOM_RENDERERS.includes(diagnostic?.renderer)
    ? diagnostic.renderer
    : "webgl";
  return {
    schema: C12_29_S5_CUSTOM_SCHEMA,
    runId,
    status: "ERROR",
    incomplete: false,
    exitCode: exitCodeForC1229S5CustomStatus("ERROR"),
    artifactName: `${runId}.json`,
    error:
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error),
    diagnostics: {
      schema: C12_29_S5_CUSTOM_DIAGNOSTICS_SCHEMA,
      renderer,
      stage: diagnostic?.stage ?? "node",
      timeoutMs: diagnostic?.timeoutMs ?? WATCHDOG_MS,
      page: diagnostic?.page ?? null,
    },
  };
}

export async function runC1229S5CustomEllipsoidProbe(options = {}) {
  const operations = options.operations ?? fs;
  const launchBrowser =
    options.launchBrowser ??
    ((launchOptions) => chromium.launch(launchOptions));
  const runId = options.runId ?? randomUUID();
  const paths = createC1229S5CustomArtifactPaths(
    runId,
    options.outputDirectory,
  );
  const baseIdentity = validateC1229S5CustomLoopbackBase(options.base ?? base);
  let ownership;
  let browser;
  const ownedPngs = [];
  let watchdogRenderer = C12_29_S5_CUSTOM_RENDERERS[0];
  try {
    ownership = beginC1229S5CustomEvidenceRun(paths, runId, operations);
    const start = await collectC1229S5CustomProvenanceSnapshot();
    browser = await launchBrowser({
      channel: process.env.PROBE_BROWSER_CHANNEL || "msedge",
      headless: process.env.PROBE_HEADED !== "1",
    });
    const sessions = await withC1229S5CustomWatchdog(
      async () => {
        const measured = [];
        for (const renderer of C12_29_S5_CUSTOM_RENDERERS) {
          watchdogRenderer = renderer;
          measured.push(
            await runC1229S5CustomBrowserSession(
              browser,
              renderer,
              baseIdentity,
              runId,
              paths,
              ownedPngs,
              operations,
            ),
          );
        }
        return measured;
      },
      async () => {
        const closing = browser;
        browser = undefined;
        await closeBrowserOrThrow(closing);
      },
      options.watchdogMs ?? WATCHDOG_MS,
      () => watchdogRenderer,
    );
    const closing = browser;
    browser = undefined;
    const browserCleanup = await closeBrowserOrThrow(closing);
    const end = await collectC1229S5CustomProvenanceSnapshot();
    const provenance = composeC1229S5CustomProvenance(start, end, sessions);
    for (const session of sessions) {
      delete session.xysResponses;
      delete session.servedEntry;
    }
    const crossBackendOracle = deriveC1229S5CustomCrossBackendReport(sessions);
    const report = {
      schema: C12_29_S5_CUSTOM_SCHEMA,
      runId,
      aggregation: C12_29_S5_CUSTOM_AGGREGATION,
      incomplete: false,
      artifactName: `${runId}.json`,
      contract: finalContract(),
      provenance,
      sessions,
      crossBackendOracle,
      cleanup: {
        complete:
          browserCleanup.closed &&
          sessions.every((session) => session.cleanup.complete),
        browserClosed: browserCleanup.closed,
        contextsClosed: sessions.every(
          (session) => session.cleanup.contextClosed,
        ),
        timersCleared: sessions.every(
          (session) => session.cleanup.timersCleared,
        ),
        pendingRequests: sessions.reduce(
          (sum, session) => sum + session.cleanup.pendingRequests,
          0,
        ),
      },
    };
    const verdict = foldC1229S5CustomEllipsoidGate(report);
    const artifact = {
      ...report,
      status: verdict.status,
      exitCode: verdict.exitCode,
      reasons: {
        structural: verdict.structuralReasons,
        failures: verdict.failureReasons,
      },
      checks: verdict.checks,
    };
    const valid = validateC1229S5CustomFinalArtifact(artifact);
    if (!valid.ok) {
      throw new Error(`self-validation failed: ${valid.reasons.join("; ")}`);
    }
    const publication = finalizeC1229S5CustomEvidence(
      paths,
      artifact,
      ownership,
      operations,
    );
    return { artifact, publication, paths };
  } catch (caughtError) {
    let error = caughtError;
    if (browser) {
      const closing = browser;
      browser = undefined;
      try {
        await closeBrowserOrThrow(closing);
      } catch (closeError) {
        error = new AggregateError(
          [error, closeError],
          "custom-ellipsoid probe and browser cleanup failed",
          { cause: error },
        );
        error.retainCustomRunning = true;
      }
    }
    const archiveExists =
      ownership && readBytesIfPresent(paths.archive, operations) !== undefined;
    if (ownership && !archiveExists && ownedPngs.length > 0) {
      const pngCleanup = cleanupC1229S5CustomOwnedPngs(ownedPngs, operations);
      if (!pngCleanup.ok) {
        const cleanupError = new Error(
          `owned PNG cleanup failed: ${pngCleanup.reasons.join("; ")}`,
        );
        error = new AggregateError(
          [error, cleanupError],
          "custom-ellipsoid probe and UUID PNG cleanup failed",
          { cause: error },
        );
        error.retainCustomRunning = true;
      }
    }
    if (ownership && error?.retainCustomRunning !== true) {
      const artifact = createC1229S5CustomErrorArtifact(runId, error);
      try {
        const publication = finalizeC1229S5CustomEvidence(
          paths,
          artifact,
          ownership,
          operations,
        );
        return { artifact, publication, paths, error };
      } catch (publicationError) {
        publicationError.cause ??= error;
        publicationError.retainCustomRunning = true;
        throw publicationError;
      }
    }
    throw error;
  }
}

async function main() {
  const result = await runC1229S5CustomEllipsoidProbe();
  const { artifact, paths } = result;
  console.log(
    JSON.stringify(
      {
        schema: artifact.schema,
        runId: artifact.runId,
        status: artifact.status,
        exitCode: artifact.exitCode,
        archive: paths.archive,
        latest: paths.latest,
        firstRed: result.publication?.firstRed ?? null,
      },
      null,
      2,
    ),
  );
  process.exitCode = artifact.exitCode;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === path.resolve(probePath)) {
  main().catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exitCode = 2;
  });
}
