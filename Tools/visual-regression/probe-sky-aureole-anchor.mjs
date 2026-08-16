#!/usr/bin/env node
// C12-31 — NATURAL SOLAR ATMOSPHERIC AUREOLE: is the sky's bright lobe anchored
// to the SUN or to the VIEW?
// @purpose C12-31 aureole certification: whether the sky's bright lobe anchors to the SUN or the VIEW (L1-L4: azimuth, displacement, sunset rejection).
// @status ACTIVE
//
// First browser run passed on 2026-08-01. Re-run on 2026-08-09 against the
// current uncommitted tree: both backends passed every lane with no console
// errors, and the WebGL/WebGPU measurements stayed within about one percent.
//
// This certificate is intentionally bounded to the original L1-L4 core:
// azimuth response, lobe displacement, after-sunset rejection, and backend
// truth. It does not claim the deferred C12-31 follow-ups or full-row closure.
// The Node fold scores centroidX displacement and the toward/anti mean ratio
// from the exact persisted UUID PNG bytes; absolute brightness is not the
// discriminator.
//
// Requires an already-current local build and server. It never builds, starts
// a server, edits engine code, or publishes outside its UUID-owned output.
//
//   node Tools/visual-regression/probe-sky-aureole-anchor.mjs
//
// Unrepaired findings (handoff §5)
//
// The independent review that put this tuple on hold raised eight findings.
// Two remain OPEN in this probe; a green run is silent on both:
//
//   #4 OPEN - prior latest is not required to be byte-identical to its UUID
//      archive. beginC1231AureoleEvidence re-parses and re-folds the prior
//      .latest.json but never reads <prefix>.<prior.runId>.json to compare
//      bytes, so a rewritten predecessor that still folds clean is accepted.
//      validateRetainedFirstRed does make that archive comparison for the
//      retained red; the latest branch has no equivalent.
//   #6 OPEN - browser/context/page acquisition and teardown are unbounded and
//      carry no observed-closure proof. chromium.launch, browser.newPage,
//      page.close and browser.close are awaited with no per-operation timeout,
//      nothing about closure reaches the artifact, and the single WATCHDOG_MS
//      process watchdog exits 2 without proving anything closed.
//
// Their two neighbours ARE repaired, recorded here so a later reader does not
// re-open them:
//
//   #5 REPAIRED (lib/c12-31-aureole-gate.mjs) - the source map is folded, not
//      merely recorded. buildMap is a member of C12_31_AUREOLE_PROVENANCE_KEYS,
//      so validateProvenance demands an exact key set, a valid fingerprint at
//      both start and end, and start-equals-end bytes for it; each
//      buildSourceIdentity entry is re-derived there against the independently
//      recorded local fingerprints rather than trusting this probe's ok flag.
//   #7 REPAIRED (this file, the runProbe catch) - a failure after lock
//      acquisition re-asserts the owned RUNNING bytes and calls
//      releaseC1231AureoleLock inside its own try/catch, so the lock is handed
//      back and a release failure is logged instead of masking the original
//      error. The watchdog-timeout path still exits without releasing; that
//      residual belongs to #6, not to #7.

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium } from "playwright";

import {
  C12_31_AUREOLE_ARTIFACT_PREFIX,
  C12_31_AUREOLE_CAPTURE_METHOD,
  C12_31_AUREOLE_MAX_SETTLE_FRAMES,
  C12_31_AUREOLE_PROVENANCE_KEYS,
  C12_31_AUREOLE_PUBLICATION_ORDER,
  C12_31_AUREOLE_RENDERERS,
  C12_31_AUREOLE_SCHEMA,
  C12_31_AUREOLE_SCOPE,
  C12_31_AUREOLE_SHOTS,
  C12_31_AUREOLE_SOURCE_KEYS,
  C12_31_AUREOLE_VIEWPORT,
  finalizeC1231AureoleReport,
  inspectAureolePng,
  isC1231UuidV4,
  requestedAureoleShotState,
  validateC1231AureoleFinalArtifact,
} from "./lib/c12-31-aureole-gate.mjs";
import {
  inspectBuildSourceIdentity,
  snapshotEvidenceFiles,
} from "./lib/build-source-identity.mjs";

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(toolDirectory, "../..");
const base = process.env.PROBE_BASE ?? "http://localhost:8080";
const viewerUrl = `${base}/Apps/CesiumViewer/index.html`;
const runtimeUrl = `${base}/Build/CesiumUnminified/index.js`;
const outputDirectory = path.resolve(
  process.env.C12_31_AUREOLE_OUTPUT_DIR ??
    path.join(toolDirectory, "output", "c12-31-aureole"),
);
const probePath = fileURLToPath(import.meta.url);
const gatePath = fileURLToPath(
  new URL("./lib/c12-31-aureole-gate.mjs", import.meta.url),
);
const specPath = path.join(toolDirectory, "c12-31-aureole-gate.spec.mjs");
const identityHelperPath = fileURLToPath(
  new URL("./lib/build-source-identity.mjs", import.meta.url),
);
const buildEntryPath = path.join(
  repositoryRoot,
  "Build",
  "CesiumUnminified",
  "index.js",
);
const buildMapPath = `${buildEntryPath}.map`;
const sourceFiles = Object.freeze({
  skyAtmosphere: path.join(
    repositoryRoot,
    "packages/engine/Source/Scene/SkyAtmosphere.js",
  ),
  dynamicLightingType: path.join(
    repositoryRoot,
    "packages/engine/Source/Scene/DynamicAtmosphereLightingType.js",
  ),
  skyLightSelector: path.join(
    repositoryRoot,
    "packages/engine/Source/Shaders/Builtin/Functions/getSkyAtmosphereLightDirection.js",
  ),
  webglSkyShader: path.join(
    repositoryRoot,
    "packages/engine/Source/Shaders/SkyAtmosphereFS.js",
  ),
  // The rest of the load-bearing boundary. The fragment shader alone does not
  // determine what the sky renders: the vertex stage supplies the ray the
  // fragment stage integrates, and both sky shaders pull their scattering and
  // extinction math out of the shared common modules. Scene and
  // EnvironmentRenderer decide whether the sky command is built and executed at
  // all, so a change in either can move the aureole without touching a shader.
  webglSkyVertexShader: path.join(
    repositoryRoot,
    "packages/engine/Source/Shaders/SkyAtmosphereVS.js",
  ),
  webglSkyCommon: path.join(
    repositoryRoot,
    "packages/engine/Source/Shaders/SkyAtmosphereCommon.js",
  ),
  atmosphereCommon: path.join(
    repositoryRoot,
    "packages/engine/Source/Shaders/AtmosphereCommon.js",
  ),
  scene: path.join(repositoryRoot, "packages/engine/Source/Scene/Scene.js"),
  environmentRenderer: path.join(
    repositoryRoot,
    "packages/engine/Source/Scene/EnvironmentRenderer.js",
  ),
  webgpuRenderer: path.join(
    repositoryRoot,
    "packages/engine/Source/Renderer/WebGPU/WebGPUSkyAtmosphereRenderer.js",
  ),
  webgpuAtmosphereUniforms: path.join(
    repositoryRoot,
    "packages/engine/Source/Renderer/WebGPU/WebGPUAtmosphereUniforms.ts",
  ),
  wgslSky: path.join(
    repositoryRoot,
    "packages/engine/Source/Shaders/WebGPU/Environment/SkyAtmosphere.js",
  ),
});
const provenanceFiles = Object.freeze({
  probe: probePath,
  gate: gatePath,
  spec: specPath,
  identityHelper: identityHelperPath,
  buildEntry: buildEntryPath,
  buildMap: buildMapPath,
  ...sourceFiles,
});
const WATCHDOG_MS = 600_000;
const SHOT_OFFSETS = Object.freeze({
  toward: 0,
  left60: -60,
  right60: 60,
  anti: 180,
  night: 0,
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function serialize(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function evidenceFingerprint(file, operations = fs) {
  try {
    const stat = operations.lstatSync(file);
    if (!stat.isFile()) {
      return { file: path.basename(file), exists: false, error: "NOT_FILE" };
    }
    const bytes = operations.readFileSync(file);
    return {
      file: path.basename(file),
      exists: true,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
      linkCount: stat.nlink,
    };
  } catch (error) {
    return {
      file: path.basename(file),
      exists: false,
      error: error?.code ?? error?.message ?? String(error),
    };
  }
}

function readAuthority(file, operations = fs, allowAbsent = true) {
  try {
    const stat = operations.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error(
        `${path.basename(file)} is not one single-link regular file`,
      );
    }
    const bytes = operations.readFileSync(file);
    if (bytes.byteLength === 0) {
      throw new Error(`${path.basename(file)} is empty`);
    }
    return {
      exists: true,
      bytes,
      fingerprint: evidenceFingerprint(file, operations),
    };
  } catch (error) {
    if (allowAbsent && error?.code === "ENOENT") {
      return {
        exists: false,
        bytes: null,
        fingerprint: {
          file: path.basename(file),
          exists: false,
          error: "ENOENT",
        },
      };
    }
    throw error;
  }
}

function sameAuthority(left, right) {
  if (left?.exists !== right?.exists) return false;
  if (!left?.exists) {
    return left?.fingerprint?.error === right?.fingerprint?.error;
  }
  return left.bytes.equals(right.bytes);
}

function assertBytes(file, expected, label, operations = fs) {
  const authority = readAuthority(file, operations, false);
  if (!authority.bytes.equals(expected)) {
    throw new Error(`${label} bytes differ`);
  }
  return authority;
}

/** Restore whatever actually occupied a moved receipt; never invent bytes. */
function restoreReceiptExclusively(receipt, canonical, operations = fs) {
  let receiptAuthority;
  try {
    receiptAuthority = readAuthority(receipt, operations, false);
  } catch {
    return false;
  }
  try {
    operations.writeFileSync(canonical, receiptAuthority.bytes, { flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
  assertBytes(
    canonical,
    receiptAuthority.bytes,
    "restored foreign successor",
    operations,
  );
  operations.unlinkSync(receipt);
  return true;
}

function replaceOwnedCanonical({
  canonical,
  expectedCurrent,
  replacement,
  receipt,
  label,
  operations = fs,
}) {
  operations.renameSync(canonical, receipt);
  const moved = readAuthority(receipt, operations, false);
  if (!moved.bytes.equals(expectedCurrent)) {
    restoreReceiptExclusively(receipt, canonical, operations);
    throw new Error(`${label}: foreign canonical owner won before claim`);
  }
  try {
    operations.writeFileSync(canonical, replacement, { flag: "wx" });
    assertBytes(canonical, replacement, `${label} replacement`, operations);
  } catch (error) {
    restoreReceiptExclusively(receipt, canonical, operations);
    throw error;
  }
  operations.unlinkSync(receipt);
}

function createOwnedCanonical({
  canonical,
  replacement,
  label,
  operations = fs,
}) {
  try {
    operations.writeFileSync(canonical, replacement, { flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`${label}: foreign owner won absent-path claim`, {
        cause: error,
      });
    }
    throw error;
  }
  assertBytes(canonical, replacement, label, operations);
}

export function c1231AureoleEvidencePaths(directory, runId) {
  if (!isC1231UuidV4(runId)) throw new Error("C12-31 runId is not UUID v4");
  return {
    directory,
    lock: path.join(directory, `${C12_31_AUREOLE_ARTIFACT_PREFIX}.lock.json`),
    latest: path.join(
      directory,
      `${C12_31_AUREOLE_ARTIFACT_PREFIX}.latest.json`,
    ),
    firstRed: path.join(
      directory,
      `${C12_31_AUREOLE_ARTIFACT_PREFIX}.first-red.json`,
    ),
    run: path.join(
      directory,
      `${C12_31_AUREOLE_ARTIFACT_PREFIX}.${runId}.json`,
    ),
    latestReceipt: path.join(
      directory,
      `.${C12_31_AUREOLE_ARTIFACT_PREFIX}.${runId}.latest-receipt`,
    ),
    lockReceipt: path.join(
      directory,
      `.${C12_31_AUREOLE_ARTIFACT_PREFIX}.${runId}.lock-receipt`,
    ),
  };
}

function assertArtifactPngAuthorities(directory, artifact, operations = fs) {
  for (const session of artifact.sessions) {
    for (const shot of session.shots) {
      const target = path.join(directory, shot.image.file);
      const authority = readAuthority(target, operations, false);
      const inspected = inspectAureolePng(authority.bytes);
      if (!inspected.ok) {
        throw new Error(
          `${session.requestedRenderer}/${shot.id}: persisted PNG became invalid: ${inspected.reasons.join("; ")}`,
        );
      }
      if (
        inspected.proof.sha256 !== shot.image.pngProof.sha256 ||
        inspected.proof.byteLength !== shot.image.pngProof.byteLength ||
        authority.fingerprint.sha256 !== shot.image.immutableFile.sha256 ||
        authority.fingerprint.byteLength !==
          shot.image.immutableFile.byteLength ||
        JSON.stringify(inspected.metrics) !== JSON.stringify(shot.metrics)
      ) {
        throw new Error(
          `${session.requestedRenderer}/${shot.id}: persisted UUID PNG/score authority changed`,
        );
      }
    }
  }
}

function validateRetainedFirstRed(authority, directory, operations = fs) {
  if (!authority.exists) return;
  let artifact;
  try {
    artifact = JSON.parse(authority.bytes.toString("utf8"));
  } catch (error) {
    throw new Error("retained first-red is not exact JSON", { cause: error });
  }
  const validation = validateC1231AureoleFinalArtifact(artifact);
  if (
    !validation.ok ||
    !["FAIL", "ERROR", "STRUCTURAL"].includes(artifact.status)
  ) {
    throw new Error(
      `retained first-red is not canonical red: ${validation.reasons.join("; ")}`,
    );
  }
  const archive = path.join(
    directory,
    `${C12_31_AUREOLE_ARTIFACT_PREFIX}.${artifact.runId}.json`,
  );
  assertBytes(
    archive,
    authority.bytes,
    "retained first-red immutable archive",
    operations,
  );
  assertArtifactPngAuthorities(directory, artifact, operations);
}

export function beginC1231AureoleEvidence(directory, runId, operations = fs) {
  operations.mkdirSync(directory, { recursive: true });
  const paths = c1231AureoleEvidencePaths(directory, runId);
  const priorLatest = readAuthority(paths.latest, operations, true);
  const firstRed = readAuthority(paths.firstRed, operations, true);
  validateRetainedFirstRed(firstRed, directory, operations);
  if (priorLatest.exists) {
    let prior;
    try {
      prior = JSON.parse(priorLatest.bytes.toString("utf8"));
    } catch (error) {
      throw new Error("prior latest is not exact JSON", { cause: error });
    }
    const validation = validateC1231AureoleFinalArtifact(prior);
    if (!validation.ok || prior.incomplete !== false) {
      throw new Error(
        `prior latest is incomplete or invalid: ${validation.reasons.join("; ")}`,
      );
    }
    assertArtifactPngAuthorities(directory, prior, operations);
  }

  const lockBytes = serialize({
    schema: C12_31_AUREOLE_SCHEMA,
    scope: C12_31_AUREOLE_SCOPE,
    status: "LOCK",
    runId,
    nonce: randomUUID(),
    pid: process.pid,
  });
  operations.writeFileSync(paths.lock, lockBytes, { flag: "wx" });
  assertBytes(paths.lock, lockBytes, "exclusive C12-31 lock", operations);
  const afterLockLatest = readAuthority(paths.latest, operations, true);
  const afterLockFirstRed = readAuthority(paths.firstRed, operations, true);
  if (!sameAuthority(priorLatest, afterLockLatest)) {
    throw new Error("C12-31 predecessor changed across lock acquisition");
  }
  if (!sameAuthority(firstRed, afterLockFirstRed)) {
    throw new Error("C12-31 first-red changed across lock acquisition");
  }

  const runningBytes = serialize({
    schema: C12_31_AUREOLE_SCHEMA,
    scope: C12_31_AUREOLE_SCOPE,
    status: "RUNNING",
    incomplete: true,
    runId,
    paths: {
      immutableRun: path.basename(paths.run),
      latest: path.basename(paths.latest),
      firstRed: path.basename(paths.firstRed),
    },
  });
  if (priorLatest.exists) {
    replaceOwnedCanonical({
      canonical: paths.latest,
      expectedCurrent: priorLatest.bytes,
      replacement: runningBytes,
      receipt: paths.latestReceipt,
      label: "C12-31 RUNNING publication",
      operations,
    });
  } else {
    createOwnedCanonical({
      canonical: paths.latest,
      replacement: runningBytes,
      label: "C12-31 RUNNING publication",
      operations,
    });
  }
  return {
    paths,
    lockBytes,
    runningBytes,
    priorLatest,
    firstRed,
  };
}

function assertFirstRedStable(state, operations = fs) {
  const current = readAuthority(state.paths.firstRed, operations, true);
  if (!sameAuthority(state.firstRed, current)) {
    throw new Error("C12-31 first-red authority changed during the run");
  }
  return current;
}

function publishFirstRed(state, finalArtifact, finalBytes, operations = fs) {
  if (finalArtifact.status === "PASS") {
    return assertFirstRedStable(state, operations);
  }
  if (state.firstRed.exists) return assertFirstRedStable(state, operations);
  try {
    operations.writeFileSync(state.paths.firstRed, finalBytes, { flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error("C12-31 foreign first-red owner won exclusive creation", {
        cause: error,
      });
    }
    throw error;
  }
  return assertBytes(
    state.paths.firstRed,
    finalBytes,
    "new write-once C12-31 first-red",
    operations,
  );
}

export function releaseC1231AureoleLock(state, operations = fs) {
  operations.renameSync(state.paths.lock, state.paths.lockReceipt);
  const moved = readAuthority(state.paths.lockReceipt, operations, false);
  if (!moved.bytes.equals(state.lockBytes)) {
    restoreReceiptExclusively(
      state.paths.lockReceipt,
      state.paths.lock,
      operations,
    );
    throw new Error("C12-31 foreign lock successor won before unlock");
  }
  operations.unlinkSync(state.paths.lockReceipt);
}

export function finalizeC1231AureoleEvidence(
  state,
  finalArtifact,
  operations = fs,
) {
  const validation = validateC1231AureoleFinalArtifact(finalArtifact);
  if (!validation.ok) {
    throw new Error(
      `C12-31 final artifact is invalid: ${validation.reasons.join("; ")}`,
    );
  }
  if (
    path.basename(state.paths.run) !==
    `${C12_31_AUREOLE_ARTIFACT_PREFIX}.${finalArtifact.runId}.json`
  ) {
    throw new Error("C12-31 final runId differs from its immutable path");
  }
  assertBytes(
    state.paths.lock,
    state.lockBytes,
    "owned C12-31 lock",
    operations,
  );
  assertBytes(
    state.paths.latest,
    state.runningBytes,
    "owned C12-31 RUNNING latest",
    operations,
  );
  assertFirstRedStable(state, operations);
  assertArtifactPngAuthorities(
    state.paths.directory,
    finalArtifact,
    operations,
  );
  const bytes = serialize(finalArtifact);
  operations.writeFileSync(state.paths.run, bytes, { flag: "wx" });
  assertBytes(state.paths.run, bytes, "immutable C12-31 run", operations);
  assertArtifactPngAuthorities(
    state.paths.directory,
    finalArtifact,
    operations,
  );
  const firstRed = publishFirstRed(state, finalArtifact, bytes, operations);
  assertArtifactPngAuthorities(
    state.paths.directory,
    finalArtifact,
    operations,
  );
  replaceOwnedCanonical({
    canonical: state.paths.latest,
    expectedCurrent: state.runningBytes,
    replacement: bytes,
    receipt: state.paths.latestReceipt,
    label: "C12-31 final latest publication",
    operations,
  });
  try {
    assertArtifactPngAuthorities(
      state.paths.directory,
      finalArtifact,
      operations,
    );
    assertBytes(state.paths.run, bytes, "immutable C12-31 run", operations);
    assertBytes(state.paths.latest, bytes, "final C12-31 latest", operations);
    if (finalArtifact.status === "PASS") {
      assertFirstRedStable(state, operations);
    } else if (!state.firstRed.exists && !firstRed.bytes.equals(bytes)) {
      throw new Error("new C12-31 first-red differs from immutable archive");
    }
    assertArtifactPngAuthorities(
      state.paths.directory,
      finalArtifact,
      operations,
    );
  } catch (error) {
    try {
      replaceOwnedCanonical({
        canonical: state.paths.latest,
        expectedCurrent: bytes,
        replacement: state.runningBytes,
        receipt: state.paths.latestReceipt,
        label: "C12-31 failed-final rollback",
        operations,
      });
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "C12-31 post-final authority failed and RUNNING rollback also failed",
        { cause: rollbackError },
      );
    }
    throw new Error(
      "C12-31 post-final authority failed; canonical RUNNING was restored",
      { cause: error },
    );
  }
  releaseC1231AureoleLock(state, operations);
  // A successor may acquire immediately after our descriptor-safe release.
  // Never unlink or rewrite the canonical lock after this boundary.
  assertBytes(
    state.paths.run,
    bytes,
    "released immutable C12-31 run",
    operations,
  );
  const latest = readAuthority(state.paths.latest, operations, false);
  return {
    immutableRun: evidenceFingerprint(state.paths.run, operations),
    latest: latest.bytes.equals(bytes)
      ? evidenceFingerprint(state.paths.latest, operations)
      : {
          ...evidenceFingerprint(state.paths.latest, operations),
          foreignSuccessor: true,
        },
    firstRed: evidenceFingerprint(state.paths.firstRed, operations),
    foreignSuccessorPreserved: !latest.bytes.equals(bytes),
  };
}

function dataUrlPngBytes(dataUrl) {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+=*)$/u.exec(
    String(dataUrl ?? ""),
  );
  if (!match) throw new Error("capture did not return an exact PNG data URL");
  return Buffer.from(match[1], "base64");
}

function materializeShotImage(runId, renderer, shotId, dataUrl) {
  const bytes = dataUrlPngBytes(dataUrl);
  const file = `${C12_31_AUREOLE_ARTIFACT_PREFIX}.${runId}.${renderer}.${shotId}.png`;
  const target = path.join(outputDirectory, file);
  fs.writeFileSync(target, bytes, { flag: "wx" });
  const persisted = fs.readFileSync(target);
  if (!persisted.equals(bytes)) {
    throw new Error(
      `${renderer}/${shotId}: persisted PNG differs from capture`,
    );
  }
  const inspected = inspectAureolePng(persisted);
  if (!inspected.ok) {
    throw new Error(`${renderer}/${shotId}: ${inspected.reasons.join("; ")}`);
  }
  const immutableFile = evidenceFingerprint(target);
  if (immutableFile.linkCount !== 1) {
    throw new Error(`${renderer}/${shotId}: UUID PNG is hard-linked`);
  }
  return {
    image: {
      file,
      pngProof: inspected.proof,
      immutableFile,
      captureSha256: sha256(bytes),
      captureByteLength: bytes.byteLength,
      scoredSha256: inspected.proof.sha256,
      scoredByteLength: inspected.proof.byteLength,
      singleCapture: true,
    },
    metrics: inspected.metrics,
  };
}

async function configureRuntimeErrorGate(page, renderer) {
  return page.evaluate((requestedRenderer) => {
    const scene = window.viewer.scene;
    const device = scene.context.device ?? scene.context._device;
    const state = window.__c1231Errors;
    state.requestedRenderer = requestedRenderer;
    state.gpuErrors = [];
    state.deviceLosses = [];
    state.gpuErrorScopesArmed = null;
    state.uncapturedErrorListenerArmed = null;
    state.deviceLossListenerArmed = null;
    if (requestedRenderer === "webgpu") {
      if (!device) throw new Error("WebGPU device is absent before capture");
      for (const filter of ["validation", "out-of-memory", "internal"]) {
        device.pushErrorScope(filter);
      }
      state.gpuErrorScopesArmed = true;
      device.addEventListener("uncapturederror", (event) => {
        state.gpuErrors.push(
          event?.error?.message ?? String(event?.error ?? event),
        );
      });
      state.uncapturedErrorListenerArmed = true;
      void device.lost.then((info) => {
        state.deviceLosses.push(
          `${info?.reason ?? "unknown"}: ${info?.message ?? ""}`,
        );
      });
      state.deviceLossListenerArmed = true;
    }
    return {
      gpuErrorScopesArmed: state.gpuErrorScopesArmed,
      uncapturedErrorListenerArmed: state.uncapturedErrorListenerArmed,
      deviceLossListenerArmed: state.deviceLossListenerArmed,
      // KNOWN GAP (C12-31 independent-review finding 2, not yet repaired).
      // These three arm HERE — after navigation, once the viewer has built a
      // GPUDevice — because there is no device to attach them to before that.
      // Any GPU error raised between device creation and this call is therefore
      // outside the gate's coverage. Closing it needs a
      // `navigator.gpu.requestDevice` interceptor installed via addInitScript so
      // the hooks attach at device-creation time, with the pre-armed
      // interceptor itself becoming the thing the gate scores. Reported rather
      // than asserted so the artifact does not imply coverage it lacks.
      armedAt: "post-navigation-device-creation",
    };
  }, renderer);
}

let currentRunId;

async function measureShot(page, renderer, shotId) {
  const requested = requestedAureoleShotState(shotId);
  const result = await page.evaluate(
    async ({ requested, renderer, shotId, offset, maximumFrames }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const viewer = window.viewer;
      const scene = viewer.scene;
      const canvas = scene.canvas;
      const pinned = C.JulianDate.fromIso8601(requested.timeIso);
      const timeFn = () => pinned.clone();

      viewer.clock.currentTime = pinned.clone();
      viewer.clock.startTime = pinned.clone();
      viewer.clock.stopTime = pinned.clone();
      viewer.clock.shouldAnimate = false;
      viewer.clock.multiplier = 0;
      scene.requestRenderMode = false;

      // ==BEGIN same-task-capture==
      const makeSameTaskCapture = (scene, canvas, timeFn) => {
        const renderNow = () => scene.render(timeFn());
        const tmp = document.createElement("canvas");
        const ctx = tmp.getContext("2d", { willReadFrequently: true });
        const decodeSnapshot = async (snapshot) => {
          const image = new Image();
          const loaded = new Promise((resolve, reject) => {
            const decodeFailed = "same-task PNG decode failed";
            image.onload = resolve;
            image.onerror = () => reject(new Error(decodeFailed));
          });
          image.src = snapshot;
          await loaded;
          tmp.width = image.naturalWidth;
          tmp.height = image.naturalHeight;
          ctx.drawImage(image, 0, 0);
          return ctx.getImageData(0, 0, tmp.width, tmp.height);
        };
        const snapshotNow = () => {
          renderNow();
          return canvas.toDataURL("image/png");
        };
        const captureNow = () => {
          const snapshot = snapshotNow();
          return decodeSnapshot(snapshot);
        };
        const grabNow = snapshotNow;
        const settleThen = async (maxFrames, done, capture) => {
          let settled = false;
          for (let k = 0; k < maxFrames; k++) {
            if (typeof done === "function" && done() === true) {
              settled = true;
              break;
            }
            renderNow();
            await new Promise((r) => requestAnimationFrame(r));
          }
          if (!settled && typeof done === "function") {
            settled = done() === true;
          }
          const hasCapture = typeof capture === "function";
          const result = hasCapture ? await capture() : undefined;
          return { settled, result };
        };
        return { renderNow, captureNow, grabNow, settleThen };
      };
      // ==END same-task-capture==

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
        // `sealNow` runs in the SAME synchronous task as the certifying render
        // and the toDataURL that reads its pixels, and strictly BEFORE the
        // decode await. That ordering is the whole proof: nothing can render
        // between the frame whose pixels were read and the moment the witness
        // is frozen, so a witness sealed here cannot belong to a later frame.
        const captureSnapshot = async (sealNow) => {
          scene.render(timeFn());
          const snapshotFrameNumber = scene.frameState.frameNumber;
          const dataUrl = canvas.toDataURL("image/png");
          const postToDataUrlFrameNumber = scene.frameState.frameNumber;
          if (typeof sealNow === "function") {
            sealNow({ snapshotFrameNumber, postToDataUrlFrameNumber });
          }
          const imageData = await decode(dataUrl);
          return {
            dataUrl,
            imageData,
            snapshotFrameNumber,
            postToDataUrlFrameNumber,
          };
        };
        return { captureSnapshot };
      };
      // ==END fused-snapshot-capture==

      const capture = makeSameTaskCapture(scene, canvas, timeFn);
      const fused = makeFusedSnapshotCapture(scene, canvas, timeFn);

      scene.skyAtmosphere.show = true;
      scene.skyBox.show = false;
      if (scene.starField) scene.starField.show = false;
      if (scene.skyBox?.starField) scene.skyBox.starField.show = false;
      scene.sun.show = false;
      scene.moon.show = false;
      scene.fog.enabled = false;
      scene.globe.show = true;
      scene.globe.showGroundAtmosphere = false;
      scene.globe.enableLighting = false;
      scene.highDynamicRange = false;
      const stages = scene.postProcessStages;
      if (stages?.bloom) stages.bloom.enabled = false;
      if (stages?.fxaa) stages.fxaa.enabled = false;
      if (stages?.ambientOcclusion) stages.ambientOcclusion.enabled = false;

      const cartographic = C.Cartographic.fromDegrees(
        requested.site.longitudeDegrees,
        requested.site.latitudeDegrees,
        requested.site.heightMeters,
      );
      const origin = C.Cartographic.toCartesian(cartographic);
      const enu = C.Transforms.eastNorthUpToFixedFrame(origin);
      const inverseEnu = C.Matrix4.inverseTransformation(enu, new C.Matrix4());
      let icrfToFixed;
      let sunInertial;
      const resolveSun = () => {
        sunInertial =
          C.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
            pinned,
            new C.Cartesian3(),
          );
        icrfToFixed = C.Transforms.computeIcrfToFixedMatrix(
          pinned,
          new C.Matrix3(),
        );
        return icrfToFixed;
      };

      let readinessChecks = 0;
      const transformSettle = await capture.settleThen(maximumFrames, () => {
        readinessChecks++;
        return !!resolveSun();
      });
      const transformFrames = Math.min(
        maximumFrames,
        Math.max(0, readinessChecks - 1),
      );
      if (!transformSettle.settled || !icrfToFixed) {
        throw new Error("ICRF-to-fixed transform unresolved within bound");
      }
      const sunFixed = C.Matrix3.multiplyByVector(
        icrfToFixed,
        sunInertial,
        new C.Cartesian3(),
      );
      const sunDirection = C.Cartesian3.normalize(
        C.Cartesian3.subtract(sunFixed, origin, new C.Cartesian3()),
        new C.Cartesian3(),
      );
      const sunLocal = C.Matrix4.multiplyByPointAsVector(
        inverseEnu,
        sunDirection,
        new C.Cartesian3(),
      );
      const sunAzimuth =
        ((((Math.atan2(sunLocal.x, sunLocal.y) * 180) / Math.PI) % 360) + 360) %
        360;
      const sunElevation =
        (Math.asin(Math.max(-1, Math.min(1, sunLocal.z))) * 180) / Math.PI;
      const heading = (((sunAzimuth + offset) % 360) + 360) % 360;
      scene.camera.setView({
        destination: origin,
        orientation: {
          heading: C.Math.toRadians(heading),
          pitch: C.Math.toRadians(requested.camera.pitchDegrees),
          roll: 0,
        },
      });

      let tileChecks = 0;
      const remainingFrames = maximumFrames - transformFrames;
      const tileSettle = await capture.settleThen(remainingFrames, () => {
        tileChecks++;
        return scene.globe.tilesLoaded === true && !!resolveSun();
      });
      const tileFrames = Math.min(remainingFrames, Math.max(0, tileChecks - 1));

      // Render after the final camera assignment so the command we wrap is the
      // exact live command that the certifying snapshot will execute.
      capture.renderNow();
      const command = scene._environmentState?.skyAtmosphereCommand;
      const originalExecute = command?.execute;
      const drawWitness = {
        armedBeforeCapture: false,
        ownerIsSkyAtmosphere: command?.owner === scene.skyAtmosphere,
        commandIsEnvironmentSkyAtmosphere:
          command === scene._environmentState?.skyAtmosphereCommand,
        skyAtmosphereVisible:
          scene._environmentState?.isSkyAtmosphereVisible === true &&
          scene.frameState?.skyAtmosphereVisible === true,
        snapshotFrameNumber: null,
        executedFrameNumber: null,
        postToDataUrlFrameNumber: null,
        executionCountAtSnapshot: null,
        witnessSealedBeforeDecode: false,
        executeRestoredBeforeDecode: false,
      };
      // The live counters stay OUTSIDE the witness. The witness holds only
      // sealed values, so a stray execution during the decode await moves these
      // locals and cannot reach the published record.
      let liveExecutionCount = 0;
      let liveExecutedFrameNumber = null;
      if (command && typeof originalExecute === "function") {
        command.execute = function (...args) {
          liveExecutionCount++;
          liveExecutedFrameNumber = scene.frameState.frameNumber;
          return Reflect.apply(originalExecute, this, args);
        };
        drawWitness.armedBeforeCapture = true;
      }
      let snapshot;
      try {
        snapshot = await fused.captureSnapshot((sealed) => {
          drawWitness.snapshotFrameNumber = sealed.snapshotFrameNumber;
          drawWitness.postToDataUrlFrameNumber =
            sealed.postToDataUrlFrameNumber;
          drawWitness.executedFrameNumber = liveExecutedFrameNumber;
          drawWitness.executionCountAtSnapshot = liveExecutionCount;
          drawWitness.commandIsEnvironmentSkyAtmosphere =
            command === scene._environmentState?.skyAtmosphereCommand;
          drawWitness.skyAtmosphereVisible =
            scene._environmentState?.isSkyAtmosphereVisible === true &&
            scene.frameState?.skyAtmosphereVisible === true;
          // Un-patch inside the seal, not in the finally: once decode is
          // awaiting, a continuously rendering scene would otherwise keep
          // running the wrapper, and the restore is itself part of what the
          // gate checks.
          if (command && typeof originalExecute === "function") {
            command.execute = originalExecute;
            drawWitness.executeRestoredBeforeDecode = true;
          }
          drawWitness.witnessSealedBeforeDecode = true;
        });
      } finally {
        // Only reachable when the seal never ran (a throw at render or
        // toDataURL); the seal restores on every path it reaches.
        if (
          command &&
          typeof originalExecute === "function" &&
          command.execute !== originalExecute
        ) {
          command.execute = originalExecute;
        }
      }

      const camera = scene.camera;
      const toArray = (value) => [value.x, value.y, value.z];
      const sceneState = {
        mode: scene.mode,
        globeShown: scene.globe.show,
        globeTilesRequired: true,
        globeGroundAtmosphereShown: scene.globe.showGroundAtmosphere,
        globeEnableLighting: scene.globe.enableLighting,
        skyAtmosphereShown: scene.skyAtmosphere.show,
        skyBoxShown: scene.skyBox.show,
        starFieldShown:
          (scene.starField?.show ?? scene.skyBox?.starField?.show) === true,
        sunShown: scene.sun.show,
        moonShown: scene.moon.show,
        fogEnabled: scene.fog.enabled,
        highDynamicRange: scene.highDynamicRange,
        bloomEnabled: stages?.bloom?.enabled ?? false,
        fxaaEnabled: stages?.fxaa?.enabled ?? false,
        ambientOcclusionEnabled: stages?.ambientOcclusion?.enabled ?? false,
        requestRenderMode: scene.requestRenderMode,
        dynamicLightingEnum: scene.skyAtmosphere.dynamicLighting,
      };
      return {
        rendererType: scene.context.rendererType,
        dataUrl: snapshot.dataUrl,
        decodedWidth: snapshot.imageData.width,
        decodedHeight: snapshot.imageData.height,
        requestedState: requested,
        observedState: {
          timeIso: C.JulianDate.toIso8601(pinned, 3),
          clock: {
            currentTimeIso: C.JulianDate.toIso8601(viewer.clock.currentTime, 3),
            startTimeIso: C.JulianDate.toIso8601(viewer.clock.startTime, 3),
            stopTimeIso: C.JulianDate.toIso8601(viewer.clock.stopTime, 3),
            shouldAnimate: viewer.clock.shouldAnimate,
            multiplier: viewer.clock.multiplier,
          },
          camera: {
            positionWC: toArray(camera.positionWC),
            directionWC: toArray(camera.directionWC),
            upWC: toArray(camera.upWC),
            rightWC: toArray(camera.rightWC),
            headingDegrees: C.Math.toDegrees(camera.heading),
            pitchDegrees: C.Math.toDegrees(camera.pitch),
            rollDegrees: C.Math.toDegrees(camera.roll),
          },
          sunFrame: {
            inertialWC: toArray(sunInertial),
            icrfToFixedMatrix: C.Matrix3.pack(icrfToFixed, []),
            fixedWC: toArray(sunFixed),
            directionWC: toArray(sunDirection),
            localENU: toArray(sunLocal),
            azimuthDegrees: sunAzimuth,
            elevationDegrees: sunElevation,
          },
          scene: sceneState,
        },
        readiness: {
          bounded: true,
          maximumFrames,
          frames: transformFrames + tileFrames,
          settled: tileSettle.settled,
          globeTilesLoaded: scene.globe.tilesLoaded === true,
          icrfToFixedResolved: !!icrfToFixed,
          transformMethod: "Transforms.computeIcrfToFixedMatrix",
          ecefFallbackUsed: false,
        },
        drawWitness,
        shotId,
        renderer,
      };
    },
    {
      requested,
      renderer,
      shotId,
      offset: SHOT_OFFSETS[shotId],
      maximumFrames: C12_31_AUREOLE_MAX_SETTLE_FRAMES,
    },
  );
  if (
    result.decodedWidth !== C12_31_AUREOLE_VIEWPORT.width ||
    result.decodedHeight !== C12_31_AUREOLE_VIEWPORT.height
  ) {
    throw new Error(
      `${renderer}/${shotId}: in-page PNG decode dimensions differ`,
    );
  }
  const materialized = materializeShotImage(
    currentRunId,
    renderer,
    shotId,
    result.dataUrl,
  );
  return {
    id: shotId,
    requestedState: result.requestedState,
    observedState: result.observedState,
    readiness: result.readiness,
    drawWitness: result.drawWitness,
    ...materialized,
  };
}

async function completeGraphicsAndErrors(page, renderer) {
  return page.evaluate(async (requestedRenderer) => {
    const scene = window.viewer.scene;
    const device = scene.context.device ?? scene.context._device;
    const state = window.__c1231Errors;
    let method;
    if (requestedRenderer === "webgpu") {
      method = "GPUQueue.onSubmittedWorkDone";
      await device.queue.onSubmittedWorkDone();
      for (let index = 0; index < 3; index++) {
        const error = await device.popErrorScope();
        if (error) state.gpuErrors.push(error.message ?? String(error));
      }
    } else {
      method = "WebGLRenderingContext.finish";
      const gl = scene.context._gl;
      if (!gl || typeof gl.finish !== "function") {
        throw new Error("WebGL finish completion primitive is absent");
      }
      gl.finish();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    return {
      method,
      complete: true,
      afterLastCapture: true,
      lateErrorTurns: 2,
      runtimeErrors: [...state.runtimeErrors],
      unhandledRejections: [...state.unhandledRejections],
      gpuErrors: [...state.gpuErrors],
      deviceLosses: [...state.deviceLosses],
      errorGate: {
        runtimeErrorListenerArmed: state.runtimeErrorListenerArmed === true,
        unhandledRejectionListenerArmed:
          state.unhandledRejectionListenerArmed === true,
        gpuErrorScopesArmed: state.gpuErrorScopesArmed,
        uncapturedErrorListenerArmed: state.uncapturedErrorListenerArmed,
        deviceLossListenerArmed: state.deviceLossListenerArmed,
      },
    };
  }, renderer);
}

async function servedRuntimeIdentity(page, renderer) {
  return page.evaluate(
    async ({ url, requestedRenderer }) => {
      const response = await fetch(url, { cache: "no-store" });
      const bytes = await response.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const hash = [...new Uint8Array(digest)]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
      return {
        requestedRenderer,
        observedRenderer: window.viewer.scene.context.rendererType,
        status: response.status,
        byteLength: bytes.byteLength,
        sha256: hash,
      };
    },
    { url: runtimeUrl, requestedRenderer: renderer },
  );
}

async function runBackend(browser, renderer) {
  const backend = renderer;
  const page = await browser.newPage({ viewport: C12_31_AUREOLE_VIEWPORT });
  const consoleErrors = [];
  const pageErrors = [];
  // Observed arming order, not an assertion. Each listener records that it was
  // attached; `navigated` flips at goto. The published claim is then derived
  // from what actually happened, so a future reordering that arms a listener
  // after navigation reports itself instead of being papered over by a
  // hardcoded `true`.
  const arming = {
    consoleListenerArmed: false,
    pageErrorListenerArmed: false,
    initScriptAdded: false,
    navigated: false,
  };
  // The browser's OWN response for the runtime script, recorded off the network
  // event rather than re-fetched. This is what the page actually executed.
  let consumedRuntime = null;
  const externalRequests = [];
  const externalResponsesSucceeded = [];
  const isLoopback = (value) => {
    try {
      const parsed = new URL(value);
      return (
        parsed.hostname === "localhost" ||
        parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "[::1]"
      );
    } catch {
      return false;
    }
  };
  page.on("request", (request) => {
    const url = request.url();
    if (!isLoopback(url) && !url.startsWith("data:")) {
      externalRequests.push(url);
    }
  });
  page.on("response", async (response) => {
    const url = response.url();
    if (!isLoopback(url) && !url.startsWith("data:") && response.ok()) {
      externalResponsesSucceeded.push(`${response.status()} ${url}`);
      return;
    }
    if (url !== runtimeUrl || consumedRuntime !== null) return;
    try {
      const bytes = await response.body();
      consumedRuntime = {
        observedByBrowser: true,
        url,
        origin: new URL(url).origin + "/",
        status: response.status(),
        fromServiceWorker: response.fromServiceWorker(),
        byteLength: bytes.byteLength,
        sha256: sha256(bytes),
      };
    } catch (error) {
      consumedRuntime = {
        observedByBrowser: false,
        url,
        error: error?.message ?? String(error),
      };
    }
  });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  arming.consoleListenerArmed = !arming.navigated;
  page.on("pageerror", (error) => pageErrors.push(error.message));
  arming.pageErrorListenerArmed = !arming.navigated;
  await page.addInitScript(() => {
    window.__c1231Errors = {
      runtimeErrors: [],
      unhandledRejections: [],
      runtimeErrorListenerArmed: false,
      unhandledRejectionListenerArmed: false,
    };
    window.addEventListener("error", (event) => {
      window.__c1231Errors.runtimeErrors.push(
        event?.error?.message ?? event?.message ?? "window error",
      );
    });
    window.__c1231Errors.runtimeErrorListenerArmed = true;
    window.addEventListener("unhandledrejection", (event) => {
      window.__c1231Errors.unhandledRejections.push(
        event?.reason?.message ??
          String(event?.reason ?? "unhandled rejection"),
      );
    });
    window.__c1231Errors.unhandledRejectionListenerArmed = true;
  });
  arming.initScriptAdded = !arming.navigated;
  arming.navigated = true;
  await page.goto(`${viewerUrl}?renderer=${renderer}&offline=true`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);
  const rendererType = await page.evaluate(
    () => window.viewer.scene.context.rendererType,
  );
  if (rendererType !== backend) {
    throw new Error(
      `${renderer}: rendererType is ${String(rendererType)} (fallback forbidden)`,
    );
  }
  const deviceGate = await configureRuntimeErrorGate(page, renderer);
  const servedEntry = {
    ...(await servedRuntimeIdentity(page, renderer)),
    // What the page actually ran, plus the offline proof, travel with the
    // served identity so the gate scores them against the same build entry.
    consumedRuntime: consumedRuntime ?? {
      observedByBrowser: false,
      error: "no runtime response was observed",
    },
    externalRequests: [...externalRequests],
    externalResponsesSucceeded: [...externalResponsesSucceeded],
  };
  const shots = [];
  for (const shotId of C12_31_AUREOLE_SHOTS) {
    shots.push(await measureShot(page, renderer, shotId));
  }
  const completion = await completeGraphicsAndErrors(page, renderer);
  await page.close();
  return {
    session: {
      requestedRenderer: renderer,
      observedRenderer: rendererType,
      rendererTruth: rendererType === renderer,
      errorGate: {
        // Scoped to the page-level surfaces, which is all this flag can honestly
        // cover: the WebGPU device hooks below cannot arm before navigation
        // because the GPUDevice does not exist until the viewer builds it. They
        // arm at device creation and are reported separately.
        armedBeforeNavigation:
          arming.consoleListenerArmed &&
          arming.pageErrorListenerArmed &&
          arming.initScriptAdded,
        consoleListenerArmed: arming.consoleListenerArmed,
        pageErrorListenerArmed: arming.pageErrorListenerArmed,
        runtimeErrorListenerArmed:
          completion.errorGate.runtimeErrorListenerArmed,
        unhandledRejectionListenerArmed:
          completion.errorGate.unhandledRejectionListenerArmed,
        gpuErrorScopesArmed: deviceGate.gpuErrorScopesArmed,
        uncapturedErrorListenerArmed: deviceGate.uncapturedErrorListenerArmed,
        deviceLossListenerArmed: deviceGate.deviceLossListenerArmed,
      },
      consoleErrors,
      pageErrors,
      runtimeErrors: completion.runtimeErrors,
      unhandledRejections: completion.unhandledRejections,
      gpuErrors: completion.gpuErrors,
      deviceLosses: completion.deviceLosses,
      gpuCompletion: {
        method: completion.method,
        complete: completion.complete,
        afterLastCapture: completion.afterLastCapture,
        lateErrorTurns: completion.lateErrorTurns,
      },
      shots,
    },
    servedEntry,
  };
}

function buildSourceIdentity() {
  const inspected = inspectBuildSourceIdentity({
    sourceMapPath: buildMapPath,
    sourceFiles: C12_31_AUREOLE_SOURCE_KEYS.map((key) => sourceFiles[key]),
  });
  const fileToKey = new Map(
    C12_31_AUREOLE_SOURCE_KEYS.map((key) => [
      path.resolve(sourceFiles[key]),
      key,
    ]),
  );
  return {
    ok: inspected.ok,
    sourceMapByteLength: inspected.sourceMapByteLength,
    sourceMapSha256: inspected.sourceMapSha256,
    reasons: inspected.reasons,
    entries: inspected.entries.map((entry) => ({
      key: fileToKey.get(path.resolve(entry.file)),
      exact: entry.exact,
      currentByteLength: entry.currentByteLength,
      embeddedByteLength: entry.embeddedByteLength,
      currentSha256: entry.currentSha256,
      embeddedSha256: entry.embeddedSha256,
    })),
  };
}

async function runProbe() {
  currentRunId = randomUUID();
  const state = beginC1231AureoleEvidence(outputDirectory, currentRunId);
  const watchdog = setTimeout(() => {
    console.error(
      `[probe-sky-aureole-anchor] watchdog fired after ${WATCHDOG_MS} ms; RUNNING retained`,
    );
    process.exit(2);
  }, WATCHDOG_MS);
  watchdog.unref?.();

  try {
    const filesAtStart = snapshotEvidenceFiles(provenanceFiles);
    if (
      !C12_31_AUREOLE_PROVENANCE_KEYS.every((key) => filesAtStart[key]?.exists)
    ) {
      throw new Error("required local/build provenance file is absent");
    }
    const buildIdentity = buildSourceIdentity();
    const browser = await chromium.launch({
      channel: "msedge",
      headless: true,
      args: ["--enable-unsafe-webgpu", "--use-vulkan", "--disable-cache"],
    });
    const sessions = [];
    const servedEntries = [];
    try {
      for (const renderer of C12_31_AUREOLE_RENDERERS) {
        const result = await runBackend(browser, renderer);
        sessions.push(result.session);
        servedEntries.push(result.servedEntry);
      }
    } finally {
      await browser.close();
    }
    const filesAtEnd = snapshotEvidenceFiles(provenanceFiles);
    const report = finalizeC1231AureoleReport({
      schema: C12_31_AUREOLE_SCHEMA,
      scope: C12_31_AUREOLE_SCOPE,
      runId: currentRunId,
      captureMethod: C12_31_AUREOLE_CAPTURE_METHOD,
      viewport: { ...C12_31_AUREOLE_VIEWPORT },
      sessions,
      provenance: {
        filesAtStart,
        filesAtEnd,
        buildSourceIdentity: buildIdentity,
        servedEntries,
        stable: true,
      },
      lifecycle: {
        lockOwned: true,
        runningAuthority: true,
        predecessorStable: true,
        firstRedStable: true,
        pngsImmutable: true,
        foreignSuccessorPreserved: true,
        publicationOrder: [...C12_31_AUREOLE_PUBLICATION_ORDER],
      },
    });
    const validation = validateC1231AureoleFinalArtifact(report);
    if (!validation.ok) {
      throw new Error(
        `final C12-31 artifact invalid: ${validation.reasons.join("; ")}`,
      );
    }
    const publication = finalizeC1231AureoleEvidence(state, report);
    clearTimeout(watchdog);
    console.log(JSON.stringify({ report, publication }, null, 2));
    if (report.status === "PASS") process.exit(0);
    if (report.status === "FAIL") process.exit(1);
    process.exit(report.exitCode);
  } catch (error) {
    clearTimeout(watchdog);
    console.error(error?.stack ?? error);
    // RUNNING remains authoritative. Release only our exact lock so a manual
    // investigation distinguishes interrupted evidence from active ownership.
    try {
      assertBytes(
        state.paths.latest,
        state.runningBytes,
        "retained C12-31 RUNNING",
      );
      releaseC1231AureoleLock(state);
    } catch (releaseError) {
      console.error(releaseError?.stack ?? releaseError);
    }
    process.exit(2);
  }
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  await runProbe();
}
