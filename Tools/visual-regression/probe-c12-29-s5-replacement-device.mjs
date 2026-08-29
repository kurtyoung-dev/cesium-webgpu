#!/usr/bin/env node
/**
 * Genuine C12-29 S5 replacement-device recovery certification.
 * @purpose Genuine device-loss recovery certification via Chromium GPU-process termination (never destroy()); 'destroyed' losses archived STRUCTURAL not recovery
 * @status ACTIVE
 *
 * The only loss trigger in this probe is Chromium's normal GPU-process
 * termination hook, exposed by exactly --enable-gpu-benchmarking.  The probe
 * never calls GPUDevice.destroy and never invokes a crash hook.  A loss whose
 * reason is "destroyed" is archived as STRUCTURAL, never counted as recovery.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import {
  C12_29_S5_REPLACEMENT_CONFIG,
  C12_29_S5_REPLACEMENT_CONTRACT,
  C12_29_S5_REPLACEMENT_CONTROL_PHASES,
  C12_29_S5_REPLACEMENT_LOCAL_FILES,
  C12_29_S5_REPLACEMENT_PAGE_PROGRESS_SCHEMA,
  C12_29_S5_REPLACEMENT_PHASES,
  C12_29_S5_REPLACEMENT_POLICY_BOUNDARY_SCHEMA,
  C12_29_S5_REPLACEMENT_POLICY_EXTERNALS,
  C12_29_S5_REPLACEMENT_POLICY_FILES,
  C12_29_S5_REPLACEMENT_POLICY_ROOTS,
  C12_29_S5_REPLACEMENT_PREFLIGHT_REFUSAL_SCHEMA,
  C12_29_S5_REPLACEMENT_PREFLIGHT_REFUSAL_RECEIPT_SCHEMA,
  C12_29_S5_REPLACEMENT_PROVENANCE_SCHEMA,
  C12_29_S5_REPLACEMENT_RUNNING_SCHEMA,
  C12_29_S5_REPLACEMENT_RUNTIME_DIAGNOSTICS_SCHEMA,
  C12_29_S5_REPLACEMENT_SCHEMA,
  C12_29_S5_REPLACEMENT_SERVED_FILES,
  C12_29_S5_REPLACEMENT_SOURCE_FILES,
  C12_29_S5_REPLACEMENT_SOURCE_BOUNDARY_SCHEMA,
  C12_29_S5_REPLACEMENT_WEBGPU_PHASES,
  createC1229S5ReplacementErrorArtifact,
  createC1229S5ReplacementErrorDiagnostics,
  deriveC1229S5ReplacementPreflightSha256,
  exitCodeForC1229S5ReplacementStatus,
  foldC1229S5ReplacementDeviceGate,
  isC1229S5ReplacementUuidV4,
  materializeC1229S5ReplacementEvidence,
  stableC1229S5ReplacementJson,
  validateC1229S5ReplacementFinalArtifact,
  validateC1229S5ReplacementPageProgress,
  validateC1229S5ReplacementPreflightProvenance,
  validateC1229S5ReplacementPreflightRefusalArtifact,
} from "./lib/c12-29-s5-replacement-device-gate.mjs";
import {
  C12_29_S5_REPLACEMENT_CAPTURE_TRANSACTION_SCHEMA,
  C12_29_S5_REPLACEMENT_RUNTIME_ATTESTATION_SCHEMA,
  C12_29_S5_REPLACEMENT_RUNTIME_ATTESTOR_SOURCE_SHA256,
  C12_29_S5_REPLACEMENT_SAMPLER_SCHEMA,
  analyzeC1229S5ReplacementCaptureSource,
  deriveC1229S5ReplacementCaptureFrameSha256,
  deriveC1229S5ReplacementCaptureTransactionSha256,
  inspectC1229S5ReplacementPng,
  inspectC1229S5ReplacementModuleImports,
  installC1229S5ReplacementRuntimeAttestor,
} from "./lib/c12-29-s5-replacement-device-capture.mjs";
import {
  inspectBuildSourceIdentity,
  safeGitHead,
} from "./lib/build-source-identity.mjs";
import {
  armWebGPUDevices,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(toolDirectory, "../..");
const probeSourcePath = fileURLToPath(import.meta.url);
const buildEntryPath = path.join(
  repositoryRoot,
  "Build/CesiumUnminified/index.js",
);
const buildSourceMapPath = `${buildEntryPath}.map`;
const runtimePath = "/Build/CesiumUnminified/index.js";
const viewerPath = "/Apps/CesiumViewer/index.html";
const defaultBase = process.env.PROBE_BASE ?? "http://localhost:8080";
const defaultOutputDirectory = path.resolve(
  process.env.C12_29_S5_REPLACEMENT_OUTPUT_DIR ??
    path.join(toolDirectory, "output/c12-29-s5-replacement-device-v8"),
);
const WATCHDOG_MS = C12_29_S5_REPLACEMENT_CONFIG.watchdogMs;
const CONTEXT_DEVICE_LOSS_CONSOLE =
  /^\[WebGPU\] Device lost \(reason: (?!destroyed\b)([^)]+)\): (.*)$/u;
const POOL_DEVICE_LOSS_CONSOLE =
  /^\[CesiumJS:WebGPUDevicePool\] Device lost: (\S+) — (.*)$/u;
const SESSION_CLOSE_TIMEOUT_MS = 15_000;
const BROWSER_CLOSE_TIMEOUT_MS = 30_000;
// The in-run watchdog plus a bounded browser close, with a minute of slack, is
// the longest a healthy run can legitimately take; past that the process is
// stuck and only `process.exit` ends it.
const PROCESS_WATCHDOG_MS = WATCHDOG_MS + BROWSER_CLOSE_TIMEOUT_MS + 60_000;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const jsonBytes = (value) =>
  Buffer.from(`${stableC1229S5ReplacementJson(value, 2)}\n`);
const asError = (value, fallback) =>
  value instanceof Error ? value : new Error(String(value ?? fallback));

export function validateC1229S5ReplacementLoopbackBase(value) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("--base must be an uncredentialed loopback HTTP URL");
  }
  return { origin: url.origin, href: url.href };
}

export function createC1229S5ReplacementArtifactPaths(
  runId,
  outputDirectory = defaultOutputDirectory,
) {
  if (!isC1229S5ReplacementUuidV4(runId)) {
    throw new Error("replacement-device runId must be a UUID v4");
  }
  const directory = path.resolve(outputDirectory);
  return {
    directory,
    archive: path.join(directory, `${runId}.json`),
    candidate: path.join(directory, `${runId}.candidate.receipt.json`),
    running: path.join(directory, `${runId}.running.json`),
    latest: path.join(directory, "latest.json"),
    lock: path.join(directory, "active.lock.json"),
    finalizing: path.join(directory, "finalizing.receipt.json"),
    // Q-116 — a run whose PREFLIGHT itself is invalid (source-identity
    // drift, an unclosed policy boundary, ...) never legitimately begins:
    // `beginC1229S5ReplacementEvidenceRun` requires a VALID preflight before
    // it hands out `active.lock.json`/`latest.json` authority, by design (an
    // invalid preflight must not bind the canonical lock to a preflightSha256
    // it does not honestly certify). These two paths are the write-once,
    // runId-scoped destination for that case: no CAS contention with the
    // lock/latest chain above, because nothing above was ever claimed.
    refusal: path.join(directory, `${runId}.preflight-refusal.json`),
    refusalReceipt: path.join(
      directory,
      `${runId}.preflight-refusal.receipt.json`,
    ),
    receipts: Object.freeze({
      priorLatest: path.join(directory, `${runId}.prior-latest.receipt`),
      runningRelease: path.join(directory, `${runId}.running.release.receipt`),
      lockRelease: path.join(directory, `${runId}.lock.release.receipt`),
      latestRelease: path.join(directory, `${runId}.latest.release.receipt`),
    }),
    images: Object.freeze({
      controlBefore: path.join(directory, `${runId}.control-before.png`),
      controlAfterGap: path.join(directory, `${runId}.control-after-gap.png`),
      webgpuBefore: path.join(directory, `${runId}.webgpu-before.png`),
      webgpuAfter: path.join(directory, `${runId}.webgpu-after.png`),
    }),
  };
}

function assertC1229S5ReplacementArtifactPaths(paths, runId) {
  const expected = createC1229S5ReplacementArtifactPaths(
    runId,
    paths?.directory,
  );
  for (const key of [
    "directory",
    "archive",
    "candidate",
    "running",
    "latest",
    "lock",
    "finalizing",
  ]) {
    if (paths?.[key] !== expected[key]) {
      throw new Error(
        `replacement-device ${key} path is not owned by run ${runId}`,
      );
    }
  }
  for (const key of Object.keys(expected.images)) {
    if (paths?.images?.[key] !== expected.images[key]) {
      throw new Error(
        `replacement-device ${key} image path is not owned by run ${runId}`,
      );
    }
  }
  for (const key of Object.keys(expected.receipts)) {
    if (paths?.receipts?.[key] !== expected.receipts[key]) {
      throw new Error(
        `replacement-device ${key} receipt path is not owned by run ${runId}`,
      );
    }
  }
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

function exactBytes(file, expected, label, operations = fs) {
  const actual = readBytesIfPresent(file, operations);
  if (!actual || !actual.equals(Buffer.from(expected))) {
    throw new Error(`${label} bytes differ from owned canonical bytes`);
  }
  return actual;
}

function exclusive(file, bytes, operations = fs) {
  operations.writeFileSync(file, bytes, { flag: "wx" });
  exactBytes(file, bytes, path.basename(file), operations);
}

function writeOnceExact(file, bytes, label, operations = fs) {
  try {
    exclusive(file, bytes, operations);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    exactBytes(file, bytes, label, operations);
  }
  return exactBytes(file, bytes, label, operations);
}

function canonicalArtifactImages(artifact) {
  if (artifact?.status === "ERROR") return [];
  const images = [
    artifact?.control?.before?.image,
    artifact?.control?.afterGap?.image,
  ];
  if (artifact?.webgpu?.before?.image)
    images.push(artifact.webgpu.before.image);
  if (artifact?.webgpu?.classification === "eligible-replacement") {
    images.push(artifact.webgpu.terrain?.after?.image);
  }
  return images.filter(Boolean);
}

function imageBytesFrom(store, pngFile) {
  const value =
    store instanceof Map ? store.get(pngFile) : (store?.[pngFile] ?? undefined);
  return value === undefined
    ? undefined
    : Buffer.isBuffer(value)
      ? value
      : Buffer.from(value);
}

const C12_29_S5_REPLACEMENT_CANDIDATE_SCHEMA =
  "c12-29-s5-replacement-device-publication-candidate-v1";

function createC1229S5ReplacementCandidate(
  artifact,
  artifactBytes,
  preflightSha256,
  imageBytes,
) {
  const images = canonicalArtifactImages(artifact).map((image) => {
    const bytes = imageBytesFrom(imageBytes, image.pngFile);
    if (!bytes)
      throw new Error(`${image.label} candidate PNG bytes are absent`);
    assertPersistedImageMatches(image, bytes);
    return {
      label: image.label,
      pngFile: image.pngFile,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
      base64: bytes.toString("base64"),
    };
  });
  const value = {
    schema: C12_29_S5_REPLACEMENT_CANDIDATE_SCHEMA,
    runId: artifact.runId,
    preflightSha256,
    artifactByteLength: artifactBytes.byteLength,
    artifactSha256: sha256(artifactBytes),
    artifact,
    images,
  };
  return { value, bytes: jsonBytes(value) };
}

function readC1229S5ReplacementCandidate(paths, ownership, operations = fs) {
  const bytes = readBytesIfPresent(paths.candidate, operations);
  if (!bytes) return null;
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error("replacement-device publication candidate is not JSON", {
      cause: error,
    });
  }
  if (!bytes.equals(jsonBytes(value))) {
    throw new Error(
      "replacement-device publication candidate is not canonical",
    );
  }
  if (
    value?.schema !== C12_29_S5_REPLACEMENT_CANDIDATE_SCHEMA ||
    value?.runId !== ownership.runId ||
    value?.preflightSha256 !== ownership.preflightSha256 ||
    !Number.isInteger(value?.artifactByteLength) ||
    value.artifactByteLength <= 0 ||
    typeof value?.artifactSha256 !== "string" ||
    !Array.isArray(value?.images)
  ) {
    throw new Error(
      "replacement-device publication candidate belongs to a foreign owner",
    );
  }
  const artifactBytes = jsonBytes(value.artifact);
  if (
    artifactBytes.byteLength !== value.artifactByteLength ||
    sha256(artifactBytes) !== value.artifactSha256
  ) {
    throw new Error(
      "replacement-device publication candidate artifact differs",
    );
  }
  const valid = validateC1229S5ReplacementFinalArtifact(value.artifact);
  if (!valid.ok) {
    throw new Error(
      `replacement-device publication candidate artifact is invalid: ${valid.reasons.join("; ")}`,
    );
  }
  const expectedImages = canonicalArtifactImages(value.artifact);
  if (value.images.length !== expectedImages.length) {
    throw new Error(
      "replacement-device publication candidate image set differs",
    );
  }
  const recoveredImages = new Map();
  for (let index = 0; index < expectedImages.length; index++) {
    const image = expectedImages[index];
    const entry = value.images[index];
    if (
      entry?.label !== image.label ||
      entry?.pngFile !== image.pngFile ||
      typeof entry?.base64 !== "string"
    ) {
      throw new Error(
        "replacement-device publication candidate image identity differs",
      );
    }
    const png = Buffer.from(entry.base64, "base64");
    if (
      png.toString("base64") !== entry.base64 ||
      png.byteLength !== entry.byteLength ||
      sha256(png) !== entry.sha256
    ) {
      throw new Error(
        "replacement-device publication candidate image bytes differ",
      );
    }
    assertPersistedImageMatches(image, png);
    recoveredImages.set(image.pngFile, png);
  }
  return {
    artifact: value.artifact,
    artifactBytes,
    candidateBytes: bytes,
    imageBytes: recoveredImages,
  };
}

function assertPersistedImageMatches(image, bytes) {
  const decoded = inspectC1229S5ReplacementPng(bytes);
  if (!decoded.ok) {
    throw new Error(
      `${image.label} persisted PNG is invalid: ${decoded.reasons.join("; ")}`,
    );
  }
  const proof = decoded.proof;
  if (
    image.width !== proof.width ||
    image.height !== proof.height ||
    image.byteLength !== proof.byteLength ||
    image.sha256 !== proof.sha256 ||
    image.sampleSha256 !==
      sha256(Buffer.from(JSON.stringify(proof.sampleRgba))) ||
    image.samplerSchema !== proof.samplerSchema ||
    image.sampleWidth !== proof.sampleWidth ||
    image.sampleHeight !== proof.sampleHeight ||
    image.nonBlackPixels !== proof.nonBlackPixels ||
    !Object.is(image.meanLuminance, proof.meanLuminance) ||
    stableC1229S5ReplacementJson(image.sampleRgba) !==
      stableC1229S5ReplacementJson(proof.sampleRgba) ||
    image.transactionSha256 !==
      deriveC1229S5ReplacementCaptureTransactionSha256(image)
  ) {
    throw new Error(
      `${image.label} metadata does not rederive from its persisted PNG bytes`,
    );
  }
  return proof;
}

function persistAndRederiveImages(
  paths,
  artifact,
  imageBytes,
  operations = fs,
) {
  const publications = [];
  for (const image of canonicalArtifactImages(artifact)) {
    const expectedPath = path.join(paths.directory, image.pngFile);
    if (!Object.values(paths.images).includes(expectedPath)) {
      throw new Error(
        `${image.label} PNG path is outside this run's ownership`,
      );
    }
    const bytes = imageBytesFrom(imageBytes, image.pngFile);
    if (!bytes) throw new Error(`${image.label} PNG bytes are absent`);
    // Decode once before mutation, then persist exclusively, re-read exact
    // owned bytes, and decode again. The second decode is the publication
    // authority and catches coordinated JSON/sample mutations.
    assertPersistedImageMatches(image, bytes);
    const persisted = writeOnceExact(
      expectedPath,
      bytes,
      `${image.label} immutable PNG`,
      operations,
    );
    assertPersistedImageMatches(image, persisted);
    publications.push({
      label: image.label,
      path: expectedPath,
      byteLength: persisted.byteLength,
      sha256: sha256(persisted),
    });
  }
  return publications;
}

function validateFinalBytes(bytes, directory, operations, label) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not JSON`, { cause: error });
  }
  const valid = validateC1229S5ReplacementFinalArtifact(value);
  if (!valid.ok) {
    throw new Error(
      `${label} is not finalized valid evidence: ${valid.reasons.join("; ")}`,
    );
  }
  const canonical = jsonBytes(value);
  if (!bytes.equals(canonical)) {
    throw new Error(`${label} is not canonical replacement-device evidence`);
  }
  for (const image of canonicalArtifactImages(value)) {
    const persisted = readBytesIfPresent(
      path.join(directory, image.pngFile),
      operations,
    );
    if (!persisted)
      throw new Error(`${label} ${image.label} immutable PNG is absent`);
    assertPersistedImageMatches(image, persisted);
  }
  exactBytes(
    path.join(directory, `${value.runId}.json`),
    canonical,
    `${label} immutable replacement-device archive`,
    operations,
  );
  return { value, canonical };
}

function transitionBytes(runId, preflightSha256, kind) {
  return jsonBytes({
    schema: "c12-29-s5-replacement-device-transition-v1",
    runId,
    preflightSha256,
    kind,
  });
}

function removeExact(file, bytes, label, operations) {
  const current = readBytesIfPresent(file, operations);
  if (!current) return;
  // Ownership cannot be established against an absent expectation. The
  // prior-latest call site passes `priorLatest ?? priorReceipt`, and a run with
  // neither arrives here with `bytes` undefined — `Buffer.equals(undefined)`
  // then throws a TypeError that reads as a harness crash rather than the
  // ownership failure it actually is. Refuse explicitly: a file whose owner
  // cannot be verified is never safe to unlink.
  if (!Buffer.isBuffer(bytes)) {
    throw new Error(
      `${label} cannot be verified for removal: no expected bytes were supplied`,
    );
  }
  if (!current.equals(bytes))
    throw new Error(`${label} belongs to a foreign owner`);
  operations.unlinkSync(file);
  if (readBytesIfPresent(file, operations)) {
    throw new Error(`${label} remained after removal`);
  }
}

function claimAndRemoveOwned(file, receipt, bytes, label, operations) {
  const current = readBytesIfPresent(file, operations);
  const claimed = readBytesIfPresent(receipt, operations);
  if (current && !current.equals(bytes)) {
    throw new Error(`${label} belongs to a foreign owner`);
  }
  if (claimed && !claimed.equals(bytes)) {
    throw new Error(`${label} receipt belongs to a foreign owner`);
  }
  if (current && !claimed) {
    operations.renameSync(file, receipt);
    exactBytes(receipt, bytes, `${label} claimed receipt`, operations);
  } else if (current && claimed) {
    operations.unlinkSync(file);
  }
  removeExact(receipt, bytes, `${label} receipt`, operations);
  if (readBytesIfPresent(file, operations)) {
    throw new Error(`${label} remained after release`);
  }
}

export function beginC1229S5ReplacementEvidenceRun(
  paths,
  runId,
  preflight,
  operations = fs,
) {
  assertC1229S5ReplacementArtifactPaths(paths, runId);
  const preflightValid =
    validateC1229S5ReplacementPreflightProvenance(preflight);
  if (!preflightValid.ok) {
    throw new Error(
      `replacement-device preflight provenance is invalid: ${preflightValid.reasons.join("; ")}`,
    );
  }
  const preflightSha256 = deriveC1229S5ReplacementPreflightSha256(preflight);
  if (preflight.preflightSha256 !== preflightSha256) {
    throw new Error("replacement-device preflight digest does not recompute");
  }
  operations.mkdirSync(paths.directory, { recursive: true });
  const runningBytes = jsonBytes({
    schema: C12_29_S5_REPLACEMENT_RUNNING_SCHEMA,
    runId,
    incomplete: true,
    status: "RUNNING",
    phase: "preflight",
    preflightSha256,
  });
  const lockBytes = jsonBytes({
    schema: "c12-29-s5-replacement-device-run-lock-v2",
    runId,
    preflightSha256,
  });
  const ownership = { runId, lockBytes, runningBytes, preflightSha256 };
  const beginTransition = transitionBytes(runId, preflightSha256, "begin");
  const finalTransition = transitionBytes(runId, preflightSha256, "finalize");
  const transition = readBytesIfPresent(paths.finalizing, operations);
  if (transition && !transition.equals(beginTransition)) {
    if (!transition.equals(finalTransition)) {
      throw new Error(
        "replacement-device canonical transition belongs to a foreign owner",
      );
    }
  }
  for (const [file, expected, label] of [
    [paths.lock, lockBytes, "replacement-device lock"],
    [paths.running, runningBytes, "replacement-device RUNNING sidecar"],
  ]) {
    const current = readBytesIfPresent(file, operations);
    if (current && !current.equals(expected)) {
      throw new Error(`${label} belongs to a foreign owner`);
    }
  }

  const candidate = readC1229S5ReplacementCandidate(
    paths,
    ownership,
    operations,
  );
  const existingArchive = readBytesIfPresent(paths.archive, operations);
  if (existingArchive && !candidate) {
    const existingLatest = readBytesIfPresent(paths.latest, operations);
    if (!existingLatest || !existingLatest.equals(existingArchive)) {
      throw new Error(
        "replacement-device orphan immutable archive has no owned publication candidate",
      );
    }
  }
  if (candidate) {
    if (transition?.equals(beginTransition)) {
      throw new Error(
        "replacement-device publication candidate conflicts with begin transition",
      );
    }
    if (existingArchive && !existingArchive.equals(candidate.artifactBytes)) {
      throw new Error(
        "replacement-device immutable archive conflicts with publication candidate",
      );
    }
    return { ...ownership, resumeCandidate: true };
  }
  if (transition?.equals(finalTransition)) {
    throw new Error(
      "replacement-device finalization transition has no owned publication candidate",
    );
  }

  let latest = readBytesIfPresent(paths.latest, operations);
  let priorReceipt = readBytesIfPresent(paths.receipts.priorLatest, operations);
  let priorLatest;
  if (latest && latest.equals(runningBytes)) {
    // Same-run idempotent resume. A retained begin transition/receipt is
    // cleaned only after the canonical RUNNING authority is reverified.
    if (priorReceipt) {
      if (!transition?.equals(beginTransition)) {
        throw new Error(
          "prior latest receipt exists without its owned begin transition",
        );
      }
      priorLatest = validateFinalBytes(
        priorReceipt,
        paths.directory,
        operations,
        "claimed prior latest",
      ).canonical;
    }
  } else {
    if (latest) {
      const validatedPrior = validateFinalBytes(
        latest,
        paths.directory,
        operations,
        "prior latest",
      );
      if (validatedPrior.value.runId === runId) {
        throw new Error(
          "replacement-device run is already finalized; begin cannot demote it",
        );
      }
      priorLatest = validatedPrior.canonical;
    }
    if (priorReceipt) {
      const receiptPrior = validateFinalBytes(
        priorReceipt,
        paths.directory,
        operations,
        "claimed prior latest",
      ).canonical;
      if (priorLatest && !priorLatest.equals(receiptPrior)) {
        throw new Error("prior latest receipt disagrees with canonical latest");
      }
      priorLatest = receiptPrior;
    }
    writeOnceExact(
      paths.finalizing,
      beginTransition,
      "replacement-device begin transition",
      operations,
    );
    latest = readBytesIfPresent(paths.latest, operations);
    priorReceipt = readBytesIfPresent(paths.receipts.priorLatest, operations);
    if (latest && !latest.equals(runningBytes)) {
      if (priorReceipt) {
        throw new Error("prior latest and its claim receipt both exist");
      }
      if (!Buffer.isBuffer(priorLatest)) {
        // `priorLatest` is only set from a latest/receipt this run validated
        // before publishing its begin transition. Arriving here without one
        // means a foreign latest appeared inside that window: claiming it
        // would move another owner's publication into this run's receipt, and
        // the `exactBytes` below would report the theft as a Buffer.from
        // TypeError instead of the ownership failure it is.
        throw new Error(
          "canonical latest appeared after this run's begin transition and cannot be claimed",
        );
      }
      operations.renameSync(paths.latest, paths.receipts.priorLatest);
      exactBytes(
        paths.receipts.priorLatest,
        priorLatest,
        "claimed prior latest",
        operations,
      );
    } else if (!latest && !priorReceipt && priorLatest) {
      throw new Error("prior latest disappeared before its claim");
    }
    writeOnceExact(
      paths.latest,
      runningBytes,
      "canonical replacement-device RUNNING authority",
      operations,
    );
  }
  exactBytes(
    paths.latest,
    runningBytes,
    "canonical replacement-device RUNNING authority",
    operations,
  );
  removeExact(
    paths.receipts.priorLatest,
    priorLatest ?? priorReceipt,
    "prior latest receipt",
    operations,
  );
  removeExact(
    paths.finalizing,
    beginTransition,
    "replacement-device begin transition",
    operations,
  );
  writeOnceExact(paths.lock, lockBytes, "replacement-device lock", operations);
  writeOnceExact(
    paths.running,
    runningBytes,
    "replacement-device RUNNING sidecar",
    operations,
  );
  return ownership;
}

export function finalizeC1229S5ReplacementEvidence(
  paths,
  artifact,
  ownership,
  imageBytes = new Map(),
  operations = fs,
) {
  let materialized;
  try {
    materialized = materializeC1229S5ReplacementEvidence(artifact);
  } catch (error) {
    throw new Error(
      `refusing non-materializable final artifact: ${String(error?.message ?? error)}`,
      { cause: error },
    );
  }
  if (materialized?.runId !== ownership?.runId) {
    throw new Error(
      "replacement-device artifact runId does not match owned evidence run",
    );
  }
  const artifactPreflightSha256 =
    materialized?.status === "ERROR"
      ? materialized?.preflightSha256
      : materialized?.provenance?.preflightSha256;
  if (artifactPreflightSha256 !== ownership.preflightSha256) {
    throw new Error(
      "final artifact is not bound to the owned preflight authority",
    );
  }
  assertC1229S5ReplacementArtifactPaths(paths, ownership.runId);
  const valid = validateC1229S5ReplacementFinalArtifact(materialized);
  if (!valid.ok)
    throw new Error(
      `refusing invalid final artifact: ${valid.reasons.join("; ")}`,
    );
  // Entry no longer demands that the lock and RUNNING sidecars exist and be
  // byte-exact before any write, as it once did. That precondition predates
  // crash resume: a run that died after releasing both sidecars but before the
  // final latest CAS re-enters here through its retained publication
  // candidate, and a completed run re-enters idempotently — both arrive with
  // the sidecars already gone, so the old gate would refuse exactly the
  // re-entries the protocol exists to serve. Ownership moved to canonical
  // latest: begin installs this run's RUNNING bytes there, the publication
  // boundary below refuses a latest that is neither those bytes nor the final
  // bytes, and the sidecars are demoted to secondary authority claimed by
  // exact bytes only when present. The cost of the drop is litter, not
  // corruption — a run whose ownership was stolen writes its candidate, PNGs
  // and archive before refusing, and every one of those paths is run-id
  // scoped, so none of it can collide with the owner that displaced it.
  const bytes = jsonBytes(materialized);
  const roundTrip = JSON.parse(bytes.toString("utf8"));
  const roundTripValid = validateC1229S5ReplacementFinalArtifact(roundTrip);
  if (!roundTripValid.ok || !jsonBytes(roundTrip).equals(bytes)) {
    throw new Error(
      `refusing non-round-tripping final artifact: ${roundTripValid.reasons.join("; ")}`,
    );
  }
  const candidate = createC1229S5ReplacementCandidate(
    roundTrip,
    bytes,
    ownership.preflightSha256,
    imageBytes,
  );
  writeOnceExact(
    paths.candidate,
    candidate.bytes,
    "replacement-device publication candidate",
    operations,
  );
  const images = persistAndRederiveImages(
    paths,
    roundTrip,
    imageBytes,
    operations,
  );
  writeOnceExact(
    paths.archive,
    bytes,
    "replacement-device immutable archive",
    operations,
  );
  exactBytes(
    paths.archive,
    bytes,
    "replacement-device immutable archive",
    operations,
  );

  const finalTransition = transitionBytes(
    ownership.runId,
    ownership.preflightSha256,
    "finalize",
  );
  let latest = readBytesIfPresent(paths.latest, operations);
  if (latest?.equals(bytes)) {
    if (
      readBytesIfPresent(paths.running, operations) ||
      readBytesIfPresent(paths.lock, operations)
    ) {
      throw new Error(
        "final latest coexists with RUNNING/lock authority and is not certifying",
      );
    }
  } else {
    if (latest && !latest.equals(ownership.runningBytes)) {
      throw new Error(
        "canonical latest belongs to a foreign owner before finalization",
      );
    }
    const transition = readBytesIfPresent(paths.finalizing, operations);
    if (transition && !transition.equals(finalTransition)) {
      throw new Error("replacement-device finalization transition is foreign");
    }
    // Publish the durable finalization exclusion before releasing either
    // secondary RUNNING authority. Canonical latest remains RUNNING until the
    // final CAS; begin refuses this same-run transition, closing the release
    // window even for an exact retry process.
    writeOnceExact(
      paths.finalizing,
      finalTransition,
      "replacement-device finalization transition",
      operations,
    );
    claimAndRemoveOwned(
      paths.running,
      paths.receipts.runningRelease,
      ownership.runningBytes,
      "replacement-device RUNNING sidecar",
      operations,
    );
    claimAndRemoveOwned(
      paths.lock,
      paths.receipts.lockRelease,
      ownership.lockBytes,
      "replacement-device lock",
      operations,
    );
    latest = readBytesIfPresent(paths.latest, operations);
    const latestReceipt = readBytesIfPresent(
      paths.receipts.latestRelease,
      operations,
    );
    if (latest && latest.equals(ownership.runningBytes)) {
      if (latestReceipt) {
        throw new Error(
          "canonical RUNNING and its final claim receipt both exist",
        );
      }
      operations.renameSync(paths.latest, paths.receipts.latestRelease);
      exactBytes(
        paths.receipts.latestRelease,
        ownership.runningBytes,
        "claimed canonical RUNNING authority",
        operations,
      );
    } else if (latest && !latest.equals(bytes)) {
      throw new Error(
        "canonical latest changed at the final publication boundary",
      );
    } else if (!latest && !latestReceipt) {
      throw new Error(
        "canonical RUNNING authority disappeared before final publication",
      );
    } else if (latestReceipt && !latestReceipt.equals(ownership.runningBytes)) {
      throw new Error("canonical latest receipt belongs to a foreign owner");
    }
    writeOnceExact(
      paths.latest,
      bytes,
      "replacement-device canonical final authority",
      operations,
    );
  }
  exactBytes(
    paths.latest,
    bytes,
    "replacement-device canonical final authority",
    operations,
  );
  try {
    removeExact(
      paths.receipts.latestRelease,
      ownership.runningBytes,
      "canonical RUNNING final receipt",
      operations,
    );
    removeExact(
      paths.finalizing,
      finalTransition,
      "replacement-device finalization transition",
      operations,
    );
    removeExact(
      paths.candidate,
      candidate.bytes,
      "replacement-device publication candidate",
      operations,
    );
  } catch (error) {
    error.publicationCommitted = true;
    throw error;
  }
  if (
    readBytesIfPresent(paths.running, operations) ||
    readBytesIfPresent(paths.lock, operations)
  ) {
    throw new Error(
      "replacement-device final publication retained RUNNING/lock",
    );
  }
  return {
    archive: paths.archive,
    latest: paths.latest,
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
    images,
  };
}

export function resumeC1229S5ReplacementEvidenceCandidate(
  paths,
  ownership,
  operations = fs,
) {
  assertC1229S5ReplacementArtifactPaths(paths, ownership.runId);
  const candidate = readC1229S5ReplacementCandidate(
    paths,
    ownership,
    operations,
  );
  if (!candidate) return null;
  const publication = finalizeC1229S5ReplacementEvidence(
    paths,
    candidate.artifact,
    ownership,
    candidate.imageBytes,
    operations,
  );
  return { artifact: candidate.artifact, publication };
}

/** Install the descriptor-exact method patch used by the retained-capture audit. */
export function installC1229S5ReplacementMethodPatch() {
  const w = /** @type {any} */ (window);
  if (w.__withC1229S5ReplacementMethodPatch) return;
  const descriptorsEqual = (left, right) => {
    if (left === undefined || right === undefined) return left === right;
    return (
      left.configurable === right.configurable &&
      left.enumerable === right.enumerable &&
      "value" in left === "value" in right &&
      ("value" in left
        ? Object.is(left.value, right.value) && left.writable === right.writable
        : Object.is(left.get, right.get) && Object.is(left.set, right.set))
    );
  };
  w.__withC1229S5ReplacementMethodPatch = async (
    target,
    key,
    replacement,
    operation,
  ) => {
    if (
      (typeof target !== "object" && typeof target !== "function") ||
      target === null ||
      typeof key !== "string" ||
      typeof replacement !== "function" ||
      typeof operation !== "function"
    ) {
      throw new TypeError(
        "replacement-device method patch arguments are invalid",
      );
    }
    const ownBefore = Object.getOwnPropertyDescriptor(target, key);
    const resolvedBefore = Reflect.get(target, key);
    if (typeof resolvedBefore !== "function") {
      throw new TypeError(`replacement-device ${key} is not callable`);
    }
    const patchedDescriptor =
      ownBefore && "value" in ownBefore
        ? { ...ownBefore, value: replacement }
        : {
            value: replacement,
            writable: true,
            enumerable: ownBefore?.enumerable ?? false,
            configurable: ownBefore?.configurable ?? true,
          };
    let operationResult;
    let operationError;
    let operationFailed = false;
    try {
      // The mutation is inside the guarded operation: every exit after the
      // first write reaches the exact descriptor restoration below.
      Object.defineProperty(target, key, patchedDescriptor);
      if (Reflect.get(target, key) !== replacement) {
        throw new Error(`replacement-device ${key} patch did not install`);
      }
      operationResult = await operation(resolvedBefore);
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }

    let restorationError;
    try {
      if (ownBefore === undefined) {
        if (!Reflect.deleteProperty(target, key)) {
          throw new Error(
            `replacement-device inherited ${key} patch could not be removed`,
          );
        }
      } else {
        Object.defineProperty(target, key, ownBefore);
      }
      const ownAfter = Object.getOwnPropertyDescriptor(target, key);
      if (
        !descriptorsEqual(ownAfter, ownBefore) ||
        !Object.is(Reflect.get(target, key), resolvedBefore)
      ) {
        throw new Error(
          `replacement-device ${key} descriptor was not restored exactly`,
        );
      }
    } catch (error) {
      restorationError = error;
    }
    if (restorationError !== undefined) {
      throw restorationError;
    }
    if (operationFailed) {
      throw operationError;
    }
    return operationResult;
  };
}

/**
 * Page-init native ledger.  It wraps only observation seams and forwards every
 * native call with the original receiver/arguments.  No WebGPU object is
 * created by the instrumentation itself.
 */
export function installC1229S5ReplacementNativeLedger() {
  const w = /** @type {any} */ (window);
  if (w.__c1229S5ReplacementNative) return;
  const state = {
    ordinal: 0,
    stage: "startup",
    deviceSerial: 0,
    bufferSerial: 0,
    bindGroupSerial: 0,
    encoderSerial: 0,
    passSerial: 0,
    commandBufferSerial: 0,
    devices: [],
    buffers: [],
    bindGroups: [],
    writes: [],
    writeMeta: [],
    binds: [],
    bindMeta: [],
    encoders: [],
    passes: [],
    commandBuffers: [],
    submissions: [],
    marks: [],
    counters: {
      requestDevice: 0,
      armedAtAcquisition: 0,
      createBuffer: 0,
      createBindGroup: 0,
      writeBuffer: 0,
      setBindGroup: 0,
      createCommandEncoder: 0,
      beginRenderPass: 0,
      finishCommandEncoder: 0,
      submit: 0,
    },
    deviceMap: new WeakMap(),
    queueMap: new WeakMap(),
    bufferMap: new WeakMap(),
    bindGroupMap: new WeakMap(),
    encoderMap: new WeakMap(),
    passMap: new WeakMap(),
    commandBufferMap: new WeakMap(),
    proofReceiptMap: new WeakMap(),
  };
  const next = () => ++state.ordinal;
  const mark = (kind) => {
    const entry = { kind, ordinal: next(), stage: state.stage };
    state.marks.push(entry);
    return entry.ordinal;
  };
  const deviceInfo = (device, role) => {
    if (!device) return null;
    let info = state.deviceMap.get(device);
    if (!info) {
      info = {
        token: `device-${++state.deviceSerial}`,
        role: role ?? null,
        firstOrdinal: next(),
        armedAtAcquisition: false,
        createBufferCount: 0,
        createBindGroupCount: 0,
      };
      state.deviceMap.set(device, info);
      state.devices.push(info);
      try {
        state.queueMap.set(device.queue, info);
      } catch {
        /* diagnostic only */
      }
    }
    if (role) info.role = role;
    return info;
  };
  const bytesOf = (data, dataOffset = 0, size) => {
    let source;
    let unitBytes = 1;
    if (data instanceof ArrayBuffer) source = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) {
      source = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      // WebGPU defines dataOffset/size in typed-array elements, but in bytes
      // for ArrayBuffer/DataView. Preserve the native call's exact unit law.
      unitBytes = Number(data.BYTES_PER_ELEMENT ?? 1);
    } else return new Uint8Array();
    const start = Math.max(0, Number(dataOffset) || 0) * unitBytes;
    const end =
      size === undefined
        ? source.byteLength
        : Math.min(
            source.byteLength,
            start + Math.max(0, Number(size) || 0) * unitBytes,
          );
    return source.slice(start, end);
  };
  const wrap = (prototype, name, factory) => {
    if (!prototype || typeof prototype[name] !== "function") return false;
    const original = prototype[name];
    if (original.__c1229S5ReplacementWrapped) return true;
    const replacement = factory(original);
    Object.defineProperty(replacement, "__c1229S5ReplacementWrapped", {
      value: true,
    });
    prototype[name] = replacement;
    return prototype[name] === replacement;
  };
  const featureList = (features) =>
    [...new Set(Array.from(features ?? [], String))].sort();
  const limitIdentity = (limits) => ({
    maxBindGroups: Number(limits?.maxBindGroups ?? 0),
    maxBufferSize: Number(limits?.maxBufferSize ?? 0),
    maxTextureDimension2D: Number(limits?.maxTextureDimension2D ?? 0),
    maxUniformBufferBindingSize: Number(
      limits?.maxUniformBufferBindingSize ?? 0,
    ),
    minUniformBufferOffsetAlignment: Number(
      limits?.minUniformBufferOffsetAlignment ?? 0,
    ),
  });
  const adapterIdentity = async (adapter, device) => {
    let adapterInfo = adapter?.info;
    if (!adapterInfo && typeof adapter?.requestAdapterInfo === "function") {
      adapterInfo = await adapter.requestAdapterInfo();
    }
    return {
      adapterInfo: {
        vendor: String(adapterInfo?.vendor ?? ""),
        architecture: String(adapterInfo?.architecture ?? ""),
        device: String(adapterInfo?.device ?? ""),
        description: String(adapterInfo?.description ?? ""),
      },
      adapterFeatures: featureList(adapter?.features),
      adapterLimits: limitIdentity(adapter?.limits),
      deviceLabel: String(device?.label ?? ""),
      deviceFeatures: featureList(device?.features),
      deviceLimits: limitIdentity(device?.limits),
    };
  };

  // Arm every newly acquired device before the requestDevice promise is
  // released to Cesium. This closes the otherwise-unobserved D0 construction
  // and D1 recovery-initialization intervals for uncaptured GPU errors.
  const adapterWrapped = wrap(
    w.GPUAdapter?.prototype,
    "requestDevice",
    (original) =>
      function () {
        state.counters.requestDevice++;
        const requested = Reflect.apply(original, this, arguments);
        return Promise.resolve(requested).then(async (device) => {
          const info = deviceInfo(device);
          info.identity = await adapterIdentity(this, device);
          const arm = w.__armWebGPUDevice;
          if (typeof arm !== "function") {
            throw new Error(
              "replacement-device error gate was unavailable at acquisition",
            );
          }
          arm(device, `replacement-${info.token}`);
          if (device.__gateArmed !== true) {
            throw new Error(
              "replacement-device error gate did not arm acquired device",
            );
          }
          info.armedAtAcquisition = true;
          state.counters.armedAtAcquisition++;
          return device;
        });
      },
  );

  const deviceWrapped =
    wrap(
      w.GPUDevice?.prototype,
      "createBuffer",
      (original) =>
        function (descriptor) {
          const device = deviceInfo(this);
          const buffer = Reflect.apply(original, this, arguments);
          const record = {
            token: `buffer-${++state.bufferSerial}`,
            deviceToken: device?.token ?? "unowned",
            label: String(descriptor?.label ?? ""),
            size: Number(descriptor?.size ?? 0),
            usage: Number(descriptor?.usage ?? 0),
            createdOrdinal: next(),
            createdStage: state.stage,
            destroyedOrdinal: null,
            destroyCount: 0,
          };
          state.counters.createBuffer++;
          if (device) device.createBufferCount++;
          state.bufferMap.set(buffer, record);
          state.buffers.push(record);
          return buffer;
        },
    ) &&
    wrap(
      w.GPUDevice?.prototype,
      "createBindGroup",
      (original) =>
        function (descriptor) {
          const device = deviceInfo(this);
          const bindGroup = Reflect.apply(original, this, arguments);
          const entries = Array.from(descriptor?.entries ?? []).map((entry) => {
            const resource = entry?.resource;
            const buffer = resource?.buffer;
            const record = buffer ? state.bufferMap.get(buffer) : null;
            return {
              binding: Number(entry?.binding),
              bufferToken: record?.token ?? null,
              offset: Number(resource?.offset ?? 0),
              size: Number(resource?.size ?? 0),
            };
          });
          const record = {
            token: `bind-group-${++state.bindGroupSerial}`,
            deviceToken: device?.token ?? "unowned",
            createdOrdinal: next(),
            createdStage: state.stage,
            entries,
          };
          state.counters.createBindGroup++;
          if (device) device.createBindGroupCount++;
          state.bindGroupMap.set(bindGroup, record);
          state.bindGroups.push(record);
          return bindGroup;
        },
    ) &&
    wrap(
      w.GPUDevice?.prototype,
      "createCommandEncoder",
      (original) =>
        function (descriptor) {
          const device = deviceInfo(this);
          const encoder = Reflect.apply(original, this, arguments);
          const record = {
            token: `encoder-${++state.encoderSerial}`,
            deviceToken: device?.token ?? "unowned",
            label: String(descriptor?.label ?? ""),
            createdOrdinal: next(),
          };
          state.counters.createCommandEncoder++;
          state.encoderMap.set(encoder, record);
          state.encoders.push(record);
          return encoder;
        },
    );

  const commandEncoderWrapped =
    wrap(
      w.GPUCommandEncoder?.prototype,
      "beginRenderPass",
      (original) =>
        function (descriptor) {
          const encoder = state.encoderMap.get(this);
          const pass = Reflect.apply(original, this, arguments);
          const record = {
            token: `pass-${++state.passSerial}`,
            deviceToken: encoder?.deviceToken ?? "unowned",
            commandEncoderToken: encoder?.token ?? "untracked",
            label: String(descriptor?.label ?? ""),
            beginOrdinal: next(),
          };
          state.counters.beginRenderPass++;
          state.passMap.set(pass, record);
          state.passes.push(record);
          return pass;
        },
    ) &&
    wrap(
      w.GPUCommandEncoder?.prototype,
      "finish",
      (original) =>
        function () {
          const encoder = state.encoderMap.get(this);
          const commandBuffer = Reflect.apply(original, this, arguments);
          const record = {
            token: `command-buffer-${++state.commandBufferSerial}`,
            deviceToken: encoder?.deviceToken ?? "unowned",
            commandEncoderToken: encoder?.token ?? "untracked",
            finishOrdinal: next(),
            stage: state.stage,
          };
          state.counters.finishCommandEncoder++;
          state.commandBufferMap.set(commandBuffer, record);
          state.commandBuffers.push(record);
          return commandBuffer;
        },
    );

  const queueWrapped =
    wrap(
      w.GPUQueue?.prototype,
      "writeBuffer",
      (original) =>
        function (buffer, bufferOffset, data, dataOffset, size) {
          const result = Reflect.apply(original, this, arguments);
          const ordinal = next();
          const resource = state.bufferMap.get(buffer);
          const device = state.queueMap.get(this);
          // Retain bytes only for UNIFORM buffers. The ownership/order ledger
          // still records every successful write below, while texture/storage
          // uploads can be many MiB and are irrelevant to binding-2 proof.
          const uniformUsage = Number(w.GPUBufferUsage?.UNIFORM ?? 64);
          const bytes =
            resource && (resource.usage & uniformUsage) !== 0
              ? bytesOf(data, dataOffset, size)
              : null;
          const write = {
            ordinal,
            stage: state.stage,
            deviceToken: device?.token ?? "unowned",
            bufferToken: resource?.token ?? "untracked",
            offset: Number(bufferOffset ?? 0),
            bytes,
          };
          if (bytes !== null) state.writes.push(write);
          state.writeMeta.push({
            ordinal: write.ordinal,
            stage: write.stage,
            deviceToken: write.deviceToken,
            bufferToken: write.bufferToken,
          });
          if (state.writes.length > 512)
            state.writes.splice(0, state.writes.length - 512);
          state.counters.writeBuffer++;
          return result;
        },
    ) &&
    wrap(
      w.GPUQueue?.prototype,
      "submit",
      (original) =>
        function (commandBuffers) {
          const device = state.queueMap.get(this);
          // Production submits arrays. Snapshot an array without consuming a
          // caller-provided one-shot iterable before the native WebIDL layer.
          const buffers = Array.isArray(commandBuffers)
            ? commandBuffers.slice()
            : null;
          const result = Reflect.apply(original, this, arguments);
          const ordinal = next();
          state.submissions.push({
            ordinal,
            stage: state.stage,
            deviceToken: device?.token ?? "unowned",
            commandBufferTokens: (buffers ?? []).map(
              (buffer) =>
                state.commandBufferMap.get(buffer)?.token ?? "untracked",
            ),
          });
          state.counters.submit++;
          return result;
        },
    );

  const bufferWrapped = wrap(
    w.GPUBuffer?.prototype,
    "destroy",
    (original) =>
      function () {
        const result = Reflect.apply(original, this, arguments);
        const record = state.bufferMap.get(this);
        if (record) {
          record.destroyCount++;
          const ordinal = next();
          record.destroyedOrdinal ??= ordinal;
        }
        return result;
      },
  );

  const renderPassWrapped = wrap(
    w.GPURenderPassEncoder?.prototype,
    "setBindGroup",
    (original) =>
      function (
        index,
        bindGroup,
        dynamicOffsets,
        dynamicOffsetsStart,
        dynamicOffsetsLength,
      ) {
        const result = Reflect.apply(original, this, arguments);
        const record = state.bindGroupMap.get(bindGroup);
        const pass = state.passMap.get(this);
        let offsets = [];
        if (
          dynamicOffsets &&
          typeof dynamicOffsets[Symbol.iterator] === "function"
        ) {
          offsets = Array.from(dynamicOffsets, Number);
          if (dynamicOffsetsStart !== undefined) {
            const start = Number(dynamicOffsetsStart) || 0;
            const length =
              dynamicOffsetsLength === undefined
                ? offsets.length - start
                : Number(dynamicOffsetsLength);
            offsets = offsets.slice(start, start + length);
          }
        }
        const bind = {
          ordinal: next(),
          stage: state.stage,
          group: Number(index),
          bindGroupToken: record?.token ?? "untracked",
          deviceToken: record?.deviceToken ?? "unowned",
          dynamicOffsets: offsets,
          passToken: pass?.token ?? "untracked",
          passLabel: pass?.label ?? "",
          commandEncoderToken: pass?.commandEncoderToken ?? "untracked",
        };
        state.binds.push(bind);
        state.bindMeta.push({
          ordinal: bind.ordinal,
          stage: bind.stage,
          group: bind.group,
          bindGroupToken: bind.bindGroupToken,
          deviceToken: bind.deviceToken,
        });
        if (state.binds.length > 2048)
          state.binds.splice(0, state.binds.length - 2048);
        state.counters.setBindGroup++;
        return result;
      },
  );

  const proof = (role, expectedPayload, requirements = {}) => {
    const {
      requiredBindGroupToken = null,
      requiredDynamicOffsets = null,
      descriptorOrdinal = null,
      requiredPassLabel = null,
      requireScenePass = false,
      requireCapturePass = false,
      minimumBindOrdinal = 0,
    } = requirements;
    const device = state.devices.find((entry) => entry.role === role);
    const expected = Array.from(expectedPayload, Math.fround);
    for (let index = state.binds.length - 1; index >= 0; index--) {
      const bind = state.binds[index];
      if (bind.group !== 0 || bind.deviceToken !== device?.token) continue;
      if (bind.ordinal < minimumBindOrdinal) continue;
      if (descriptorOrdinal !== null && bind.ordinal <= descriptorOrdinal)
        continue;
      if (
        requiredBindGroupToken !== null &&
        bind.bindGroupToken !== requiredBindGroupToken
      ) {
        continue;
      }
      if (
        requiredDynamicOffsets !== null &&
        (bind.dynamicOffsets.length !== requiredDynamicOffsets.length ||
          !bind.dynamicOffsets.every((value, offsetIndex) =>
            Object.is(value, requiredDynamicOffsets[offsetIndex]),
          ))
      ) {
        continue;
      }
      if (requiredPassLabel !== null && bind.passLabel !== requiredPassLabel)
        continue;
      if (
        requireScenePass &&
        !/^(?:Scene Main|Scene Framebuffer) Render Pass$/u.test(bind.passLabel)
      )
        continue;
      if (
        requireCapturePass &&
        !/^DynEnvMap Capture Face [0-5]$/u.test(bind.passLabel)
      )
        continue;
      const group = state.bindGroups.find(
        (entry) => entry.token === bind.bindGroupToken,
      );
      const entry = group?.entries.find(
        (candidate) => candidate.binding === 2 && candidate.size === 64,
      );
      if (!entry?.bufferToken || bind.dynamicOffsets.length !== 3) continue;
      const dynamicOffset = bind.dynamicOffsets[2];
      const commandBuffer = state.commandBuffers.find(
        (candidate) =>
          candidate.commandEncoderToken === bind.commandEncoderToken &&
          candidate.deviceToken === device.token &&
          candidate.finishOrdinal > bind.ordinal,
      );
      if (!commandBuffer) continue;
      const submission = state.submissions.find(
        (candidate) =>
          candidate.deviceToken === device.token &&
          candidate.ordinal > commandBuffer.finishOrdinal &&
          candidate.commandBufferTokens.includes(commandBuffer.token),
      );
      if (!submission) continue;
      const effectiveOffset = entry.offset + dynamicOffset;
      const effectiveEnd = effectiveOffset + 64;
      for (
        let writeIndex = state.writes.length - 1;
        writeIndex >= 0;
        writeIndex--
      ) {
        const write = state.writes[writeIndex];
        if (write.ordinal <= bind.ordinal) continue;
        if (write.ordinal >= submission.ordinal) continue;
        if (write.bufferToken !== entry.bufferToken) continue;
        const writeEnd = write.offset + write.bytes.byteLength;
        if (write.offset >= effectiveEnd || writeEnd <= effectiveOffset)
          continue;
        // The most recent write touching the selected 64-byte range must
        // cover it in full. Otherwise an older full upload could mask a later
        // partial overwrite and falsely certify bytes no longer bound.
        if (write.offset > effectiveOffset || writeEnd < effectiveEnd) break;
        // Queue writes after encoder.finish can affect execution, but they do
        // not satisfy this packet's stronger retained-command chronology. A
        // newer touching write after finish also invalidates any older upload.
        if (write.ordinal >= commandBuffer.finishOrdinal) break;
        const relative = effectiveOffset - write.offset;
        const bytes = write.bytes.slice(relative, relative + 64);
        const view = new DataView(
          bytes.buffer,
          bytes.byteOffset,
          bytes.byteLength,
        );
        const observed = Array.from({ length: 16 }, (_, component) =>
          view.getFloat32(component * 4, true),
        );
        const exact = observed.every((value, component) =>
          Object.is(value, expected[component]),
        );
        const proofValue = {
          role,
          deviceToken: device.token,
          bufferToken: entry.bufferToken,
          bindGroupToken: group.token,
          group: 0,
          binding: 2,
          bindingSize: entry.size,
          bindingOffset: entry.offset,
          dynamicOffset,
          dynamicOffsets: [...bind.dynamicOffsets],
          alignment:
            Number(
              w.navigator?.gpu
                ? role === "D0"
                  ? w.viewer?.scene?.context?._device?.limits
                      ?.minUniformBufferOffsetAlignment
                  : w.viewer?.scene?.context?._device?.limits
                      ?.minUniformBufferOffsetAlignment
                : 256,
            ) || 256,
          descriptorOrdinal,
          passLabel: bind.passLabel,
          renderPassToken: bind.passToken,
          commandEncoderToken: bind.commandEncoderToken,
          commandBufferToken: commandBuffer.token,
          bindOrdinal: bind.ordinal,
          finishOrdinal: commandBuffer.finishOrdinal,
          uploadOrdinal: write.ordinal,
          uploadOffset: write.offset,
          uploadByteLength: write.bytes.byteLength,
          submitOrdinal: submission.ordinal,
          expectedPayload: expected,
          observedPayload: observed,
          payloadExact: exact,
          ownedByDevice:
            group.deviceToken === device.token &&
            state.buffers.find(
              (candidate) => candidate.token === entry.bufferToken,
            )?.deviceToken === device.token &&
            write.deviceToken === device.token,
          coveredByUpload: true,
        };
        state.proofReceiptMap.set(proofValue, {
          role,
          device: {
            token: device.token,
            firstOrdinal: device.firstOrdinal,
            armedAtAcquisition: device.armedAtAcquisition,
          },
          bind: {
            ordinal: bind.ordinal,
            stage: bind.stage,
            group: bind.group,
            deviceToken: bind.deviceToken,
            bindGroupToken: bind.bindGroupToken,
            dynamicOffsets: [...bind.dynamicOffsets],
            renderPassToken: bind.passToken,
            passLabel: bind.passLabel,
            commandEncoderToken: bind.commandEncoderToken,
          },
          upload: {
            ordinal: write.ordinal,
            stage: write.stage,
            deviceToken: write.deviceToken,
            bufferToken: write.bufferToken,
            offset: write.offset,
            byteLength: write.bytes.byteLength,
            effectiveOffset,
            observedPayload: [...observed],
          },
          finish: {
            ordinal: commandBuffer.finishOrdinal,
            stage: commandBuffer.stage,
            deviceToken: commandBuffer.deviceToken,
            commandEncoderToken: commandBuffer.commandEncoderToken,
            commandBufferToken: commandBuffer.token,
          },
          submit: {
            ordinal: submission.ordinal,
            stage: submission.stage,
            deviceToken: submission.deviceToken,
            commandBufferTokens: [...submission.commandBufferTokens],
          },
        });
        return proofValue;
      }
    }
    throw new Error(
      `no exact group-0/binding-2 64-byte upload proof for ${role}`,
    );
  };

  const resource = (role, proofValue) => {
    const buffer = state.buffers.find(
      (entry) => entry.token === proofValue.bufferToken,
    );
    return {
      role,
      deviceToken: buffer.deviceToken,
      bufferToken: proofValue.bufferToken,
      createdOrdinal: buffer.createdOrdinal,
      destroyedOrdinal: buffer.destroyedOrdinal,
      destroyCount: buffer.destroyCount,
      boundOrdinals: state.bindMeta
        .filter(
          (entry) =>
            entry.deviceToken === proofValue.deviceToken &&
            entry.bindGroupToken === proofValue.bindGroupToken,
        )
        .map((entry) => entry.ordinal),
      writeOrdinals: state.writeMeta
        .filter((entry) => entry.bufferToken === proofValue.bufferToken)
        .map((entry) => entry.ordinal),
    };
  };

  const receipt = (role, proofValue, resourceValue) => {
    const selected = state.proofReceiptMap.get(proofValue);
    if (!selected || selected.role !== role) {
      throw new Error(`native ${role} proof has no retained event receipt`);
    }
    return {
      role,
      device: { ...selected.device },
      buffer: {
        deviceToken: resourceValue.deviceToken,
        bufferToken: resourceValue.bufferToken,
        createdOrdinal: resourceValue.createdOrdinal,
        destroyedOrdinal: resourceValue.destroyedOrdinal,
        destroyCount: resourceValue.destroyCount,
      },
      bind: {
        ...selected.bind,
        dynamicOffsets: [...selected.bind.dynamicOffsets],
      },
      upload: {
        ...selected.upload,
        observedPayload: [...selected.upload.observedPayload],
      },
      finish: { ...selected.finish },
      submit: {
        ...selected.submit,
        commandBufferTokens: [...selected.submit.commandBufferTokens],
      },
    };
  };

  w.__c1229S5ReplacementNative = {
    installedBeforeViewer: !w.viewer,
    instrumentation: {
      deviceWrapped,
      queueWrapped,
      bufferWrapped,
      renderPassWrapped,
    },
    trackDevice(device, role) {
      return deviceInfo(device, role)?.token ?? null;
    },
    bindGroupToken(bindGroup) {
      return state.bindGroupMap.get(bindGroup)?.token ?? null;
    },
    setStage(stage) {
      state.stage = String(stage);
    },
    mark,
    proof,
    resource,
    finalize(beforeProof, afterProof) {
      const d0 = state.devices.find((entry) => entry.role === "D0");
      const d1 = state.devices.find((entry) => entry.role === "D1");
      const d0Resource = resource("D0", beforeProof);
      const d1Resource = resource("D1", afterProof);
      const ordinal = (kind) =>
        state.marks.find((entry) => entry.kind === kind)?.ordinal ?? 0;
      const lossOrdinal = ordinal("loss");
      const invalidationOrdinal = ordinal("invalidation");
      const healthyOrdinal = ordinal("healthy");
      const firstD1CreateOrdinal = Math.min(
        ...state.buffers
          .filter((entry) => entry.deviceToken === d1.token)
          .map((entry) => entry.createdOrdinal),
      );
      const postLoss = (entry) => entry.ordinal > lossOrdinal;
      const retirement = {
        lossOrdinal,
        oldDestroyOrdinal: d0Resource.destroyedOrdinal ?? 0,
        invalidationOrdinal,
        healthyOrdinal,
        firstD1CreateOrdinal,
        oldDestroyCount: d0Resource.destroyCount,
        postLossD0CreateCount: state.buffers.filter(
          (entry) =>
            entry.deviceToken === d0.token &&
            entry.createdOrdinal > lossOrdinal,
        ).length,
        postLossD0WriteCount: state.writeMeta.filter(
          (entry) => entry.deviceToken === d0.token && postLoss(entry),
        ).length,
        postLossD0BindCount: state.bindMeta.filter(
          (entry) => entry.deviceToken === d0.token && postLoss(entry),
        ).length,
        invalidationCount: state.marks.filter(
          (entry) => entry.kind === "invalidation",
        ).length,
        ordered:
          lossOrdinal > 0 &&
          d0Resource.destroyedOrdinal > lossOrdinal &&
          d0Resource.destroyedOrdinal <= invalidationOrdinal &&
          invalidationOrdinal < healthyOrdinal &&
          firstD1CreateOrdinal > lossOrdinal &&
          firstD1CreateOrdinal <= healthyOrdinal,
      };
      return {
        schema: "c12-29-s5-replacement-device-native-resource-ledger-v8",
        instrumentation: {
          installedBeforeViewer: this.installedBeforeViewer,
          adapterPrototypeWrapped: adapterWrapped,
          devicePrototypeWrapped: deviceWrapped,
          commandEncoderPrototypeWrapped: commandEncoderWrapped,
          queuePrototypeWrapped: queueWrapped,
          bufferPrototypeWrapped: bufferWrapped,
          renderPassPrototypeWrapped: renderPassWrapped,
          createBufferCalls: state.counters.createBuffer,
          createBindGroupCalls: state.counters.createBindGroup,
          writeBufferCalls: state.counters.writeBuffer,
          setBindGroupCalls: state.counters.setBindGroup,
          createCommandEncoderCalls: state.counters.createCommandEncoder,
          beginRenderPassCalls: state.counters.beginRenderPass,
          finishCommandEncoderCalls: state.counters.finishCommandEncoder,
          submitCalls: state.counters.submit,
          requestDeviceCalls: state.counters.requestDevice,
          armedAtAcquisitionCalls: state.counters.armedAtAcquisition,
        },
        devices: [d0, d1].map((entry, index) => ({
          role: index === 0 ? "D0" : "D1",
          token: entry.token,
          firstOrdinal: entry.firstOrdinal,
          armedAtAcquisition: entry.armedAtAcquisition,
          createBufferCount: entry.createBufferCount,
          createBindGroupCount: entry.createBindGroupCount,
          identity: {
            adapterInfo: { ...entry.identity.adapterInfo },
            adapterFeatures: [...entry.identity.adapterFeatures],
            adapterLimits: { ...entry.identity.adapterLimits },
            deviceLabel: entry.identity.deviceLabel,
            deviceFeatures: [...entry.identity.deviceFeatures],
            deviceLimits: { ...entry.identity.deviceLimits },
          },
        })),
        binding2: {
          group: 0,
          binding: 2,
          byteLength: 64,
          floatCount: 16,
          before: beforeProof,
          after: afterProof,
        },
        resources: { d0Binding2: d0Resource, d1Binding2: d1Resource },
        retirement,
        sequence: {
          marks: state.marks.map(({ kind, ordinal, stage }) => ({
            kind,
            ordinal,
            stage,
          })),
          receipts: [
            receipt("D0", beforeProof, d0Resource),
            receipt("D1", afterProof, d1Resource),
          ],
        },
      };
    },
  };
}

const MEASURE_C1229_S5_REPLACEMENT_SESSION =
  async function MEASURE_C1229_S5_REPLACEMENT_SESSION(contract) {
    const startedAt = performance.now();
    const progress = {
      schema: contract.progressSchema,
      renderer: contract.renderer,
      currentPhase: "preflight",
      completedPhases: [],
      step: "start",
      elapsedMs: 0,
    };
    globalThis.__c1229S5ReplacementProgress = progress;
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
    const existing = globalThis.viewer;
    if (existing && !existing.isDestroyed?.()) {
      existing.useDefaultRenderLoop = false;
      existing.destroy();
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
    const terrainRequests = [];
    const tilingScheme = new C.GeographicTilingScheme({
      ellipsoid: C.Ellipsoid.WGS84,
    });
    const provider = new C.CustomHeightmapTerrainProvider({
      width: contract.terrainWidth,
      height: contract.terrainHeight,
      tilingScheme,
      callback(x, y, level) {
        terrainRequests.push({ x, y, level });
        const heights = new Float32Array(
          contract.terrainWidth * contract.terrainHeight,
        );
        heights.fill(contract.terrainMeters);
        return heights;
      },
    });
    const globe = new C.Globe(C.Ellipsoid.WGS84);
    const options = {
      globe,
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
            ...options,
            contextOptions: { renderer: "webgpu" },
          })
        : new C.Viewer(container, options);
    globalThis.viewer = viewer;
    viewer.useDefaultRenderLoop = false;
    viewer.resolutionScale = 1;
    const scene = viewer.scene;
    const canvas = scene.canvas;
    const context = scene.context;
    const actualRenderer = context.isWebGPU ? "webgpu" : "webgl";
    if (actualRenderer !== contract.renderer)
      throw new Error(
        `renderer resolved ${actualRenderer}, expected ${contract.renderer}`,
      );
    const runtimeIdentity = {
      renderer: actualRenderer,
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
      devicePixelRatio: globalThis.devicePixelRatio,
      secureContext: globalThis.isSecureContext === true,
      webdriver: navigator.webdriver === true,
    };
    scene.requestRenderMode = false;
    scene.highDynamicRange = false;
    scene.sunBloom = false;
    scene.taaEnabled = false;
    scene.backgroundColor = C.Color.BLACK;
    if (scene.fog) scene.fog.enabled = false;
    if (scene.postProcessStages?.fxaa)
      scene.postProcessStages.fxaa.enabled = false;
    if (scene.postProcessStages?.bloom)
      scene.postProcessStages.bloom.enabled = false;
    if (scene.sun) scene.sun.show = false;
    if (scene.moon) scene.moon.show = false;
    globe.enableLighting = false;
    globe.showGroundAtmosphere = false;
    globe.showWaterEffect = false;
    globe.maximumScreenSpaceError = contract.maximumScreenSpaceError;
    const grid = new C.GridImageryProvider({
      tilingScheme,
      cells: 1,
      color: C.Color.fromBytes(238, 238, 238, 255),
      glowColor: C.Color.fromBytes(180, 180, 180, 255),
      backgroundColor: C.Color.fromBytes(210, 210, 210, 255),
    });
    viewer.imageryLayers.removeAll();
    viewer.imageryLayers.addImageryProvider(grid);
    const lighting = globe.atmosphericConditions?.lighting;
    if (!lighting || !("enableEclipseGlobeShadow" in lighting))
      throw new Error("S5 controls are unavailable");
    lighting.enableEclipse = true;
    lighting.eclipseAutoExposure = false;
    lighting.enableEclipseGlobeShadow = true;
    if ("enableEclipseHorizonTwilight" in lighting)
      lighting.enableEclipseHorizonTwilight = false;
    const pinnedTime = C.JulianDate.fromIso8601(contract.eventIso);
    viewer.clock.currentTime = pinnedTime.clone();
    viewer.clock.startTime = pinnedTime.clone();
    viewer.clock.stopTime = pinnedTime.clone();
    viewer.clock.shouldAnimate = false;
    viewer.clock.multiplier = 0;

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

    const preloadStart = C.JulianDate.addHours(
      pinnedTime,
      -1,
      new C.JulianDate(),
    );
    const preloadStop = C.JulianDate.addHours(
      pinnedTime,
      1,
      new C.JulianDate(),
    );
    await C.Transforms.preloadIcrfFixed(
      new C.TimeInterval({ start: preloadStart, stop: preloadStop }),
    );
    const matrix = C.Transforms.computeIcrfToFixedMatrix(
      pinnedTime,
      new C.Matrix3(),
    );
    if (!matrix) throw new Error("ICRF-to-fixed matrix is unavailable");
    const sunI =
      C.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
        pinnedTime,
        new C.Cartesian3(),
      );
    const moonI =
      C.Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(
        pinnedTime,
        new C.Cartesian3(),
      );
    const sun = C.Matrix3.multiplyByVector(matrix, sunI, new C.Cartesian3());
    const moon = C.Matrix3.multiplyByVector(matrix, moonI, new C.Cartesian3());
    const direction = C.Cartesian3.normalize(
      C.Cartesian3.subtract(moon, sun, new C.Cartesian3()),
      new C.Cartesian3(),
    );
    const radii = C.Ellipsoid.WGS84.radii;
    const inv2 = {
      x: 1 / (radii.x * radii.x),
      y: 1 / (radii.y * radii.y),
      z: 1 / (radii.z * radii.z),
    };
    const qa =
      direction.x ** 2 * inv2.x +
      direction.y ** 2 * inv2.y +
      direction.z ** 2 * inv2.z;
    const qb =
      2 *
      (moon.x * direction.x * inv2.x +
        moon.y * direction.y * inv2.y +
        moon.z * direction.z * inv2.z);
    const qc =
      moon.x ** 2 * inv2.x + moon.y ** 2 * inv2.y + moon.z ** 2 * inv2.z - 1;
    const disc = qb * qb - 4 * qa * qc;
    if (!(disc >= 0)) throw new Error("eclipse axis misses WGS84");
    const roots = [
      (-qb - Math.sqrt(disc)) / (2 * qa),
      (-qb + Math.sqrt(disc)) / (2 * qa),
    ]
      .filter((root) => root > 0)
      .sort((a, b) => a - b);
    if (!roots.length)
      throw new Error("eclipse axis has no forward WGS84 root");
    const surface = C.Cartesian3.add(
      moon,
      C.Cartesian3.multiplyByScalar(direction, roots[0], new C.Cartesian3()),
      new C.Cartesian3(),
    );
    const centre = C.Ellipsoid.WGS84.cartesianToCartographic(
      surface,
      new C.Cartographic(),
    );
    const destination = C.Ellipsoid.WGS84.cartographicToCartesian(
      new C.Cartographic(
        centre.longitude,
        centre.latitude,
        contract.cameraHeightMeters,
      ),
    );
    const target = C.Ellipsoid.WGS84.cartographicToCartesian(
      new C.Cartographic(
        centre.longitude,
        centre.latitude,
        contract.terrainMeters,
      ),
    );
    const enu = C.Transforms.eastNorthUpToFixedFrame(
      target,
      C.Ellipsoid.WGS84,
      new C.Matrix4(),
    );
    const north4 = C.Matrix4.getColumn(enu, 1, new C.Cartesian4());
    const cameraDirection = C.Cartesian3.normalize(
      C.Cartesian3.subtract(target, destination, new C.Cartesian3()),
      new C.Cartesian3(),
    );
    const north = new C.Cartesian3(north4.x, north4.y, north4.z);
    const right = C.Cartesian3.normalize(
      C.Cartesian3.cross(cameraDirection, north, new C.Cartesian3()),
      new C.Cartesian3(),
    );
    const up = C.Cartesian3.normalize(
      C.Cartesian3.cross(right, cameraDirection, new C.Cartesian3()),
      new C.Cartesian3(),
    );
    scene.camera.frustum.fov = C.Math.toRadians(contract.cameraFovDegrees);
    scene.camera.setView({
      destination,
      orientation: { direction: cameraDirection, up },
    });

    const nextFrame = () =>
      new Promise((resolve) => requestAnimationFrame(resolve));
    const render = () => scene.render(pinnedTime);

    // ==BEGIN replacement-device-box-grid-sampler==
    function sampleC1229S5ReplacementRgba(
      imageData,
      sampleWidth = 16,
      sampleHeight = 16,
    ) {
      const data = imageData?.data;
      const width = imageData?.width;
      const height = imageData?.height;
      if (
        !Number.isInteger(width) ||
        width <= 0 ||
        !Number.isInteger(height) ||
        height <= 0 ||
        !Number.isInteger(sampleWidth) ||
        sampleWidth <= 0 ||
        !Number.isInteger(sampleHeight) ||
        sampleHeight <= 0 ||
        sampleWidth > width ||
        sampleHeight > height ||
        data === null ||
        data === undefined ||
        typeof data.length !== "number" ||
        data.length !== width * height * 4
      ) {
        throw new Error("replacement-device sample input is invalid");
      }
      const rgba = [];
      for (let sampleY = 0; sampleY < sampleHeight; sampleY++) {
        const y0 = Math.floor((sampleY * height) / sampleHeight);
        const y1 = Math.floor(((sampleY + 1) * height) / sampleHeight);
        for (let sampleX = 0; sampleX < sampleWidth; sampleX++) {
          const x0 = Math.floor((sampleX * width) / sampleWidth);
          const x1 = Math.floor(((sampleX + 1) * width) / sampleWidth);
          const sums = [0, 0, 0, 0];
          let count = 0;
          for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
              const offset = (y * width + x) * 4;
              for (let channel = 0; channel < 4; channel++) {
                const value = data[offset + channel];
                if (!Number.isInteger(value) || value < 0 || value > 255) {
                  throw new Error(
                    "replacement-device certified sample grid channel is invalid",
                  );
                }
                sums[channel] += value;
              }
              count++;
            }
          }
          if (count <= 0) {
            throw new Error("replacement-device sample box is empty");
          }
          for (const sum of sums) rgba.push(Math.round(sum / count));
        }
      }
      return rgba;
    }
    // ==END replacement-device-box-grid-sampler==
    const selectedTiles = () => [
      ...(globe._surface?.tileProvider?._quadtree?._tilesToRender ?? []),
    ];
    const selectedIds = () =>
      selectedTiles()
        .map((tile) => `${tile.level}/${tile.x}/${tile.y}`)
        .sort();
    const payload = () => {
      const block = scene.frameState?.eclipseGlobeShadow;
      if (!block) return [];
      return [
        block.sunDirectionAndInvRange.x,
        block.sunDirectionAndInvRange.y,
        block.sunDirectionAndInvRange.z,
        block.sunDirectionAndInvRange.w,
        block.moonDirectionDeltaAndInvRange.x,
        block.moonDirectionDeltaAndInvRange.y,
        block.moonDirectionDeltaAndInvRange.z,
        block.moonDirectionDeltaAndInvRange.w,
        block.params.x,
        block.params.y,
        block.params.z,
        block.params.w,
        block.params2.x,
        block.params2.y,
        block.params2.z,
        block.params2.w,
      ].map(Math.fround);
    };
    const active = () =>
      scene.frameState?.eclipseGlobeShadowPrepared === true &&
      scene.frameState?.eclipseGlobeShadow?.params?.x > 0.5 &&
      selectedTiles().length > 0;
    const settle = async (predicate, maximum, label) => {
      for (let frame = 0; frame < maximum; frame++) {
        render();
        if (predicate()) return frame + 1;
        await nextFrame();
      }
      throw new Error(`${label} did not settle in ${maximum} frames`);
    };
    const readCaptureFrame = () => ({
      frameNumber: scene.frameState.frameNumber,
      selectionRevision: scene.frameState.eclipseGlobeShadowSelectionRevision,
      surfaceRadius: scene.frameState.eclipseGlobeShadowSurfaceRadius,
      selectedTileIds: selectedIds(),
      providerToken: "provider-1",
      s5: {
        prepared: scene.frameState.eclipseGlobeShadowPrepared === true,
        revision: scene.frameState.eclipseGlobeShadow.revision,
        gate: scene.frameState.eclipseGlobeShadow.params.x,
        payload: payload(),
      },
    });
    const attestedCapture =
      await globalThis.__c1229S5ReplacementRuntimeAttestor.prepare({
        measurement: MEASURE_C1229_S5_REPLACEMENT_SESSION,
        captureFactory: makeFusedSnapshotCapture,
        sampler: sampleC1229S5ReplacementRgba,
        frameReader: readCaptureFrame,
        scene,
        canvas,
        timeFn: () => pinnedTime,
        expected: contract.attestation,
      });
    const snapshot = (label) => attestedCapture.capture(label);
    const sameArray = (left, right) =>
      left.length === right.length &&
      left.every((value, index) => Object.is(value, right[index]));
    const imageDelta = (left, right) => {
      let absolute = 0;
      let changed = 0;
      for (let i = 0; i < left.length; i += 4) {
        const delta =
          Math.abs(left[i] - right[i]) +
          Math.abs(left[i + 1] - right[i + 1]) +
          Math.abs(left[i + 2] - right[i + 2]);
        absolute += delta / 3;
        if (delta > contract.changedSampleRgbSumThreshold) changed++;
      }
      return {
        meanAbsoluteDelta: absolute / (left.length / 4),
        changedPixelShare: changed / (left.length / 4),
      };
    };
    await settle(
      active,
      contract.maximumSettleFrames,
      `${contract.renderer} active S5 terrain`,
    );
    const owner = {
      scene,
      context,
      canvas,
      canvasContext: context._context,
      view: scene._view,
      globe,
      provider,
    };

    if (contract.renderer === "webgl") {
      mark(contract.controlPhases[0], "capture-before-gap");
      const before = await snapshot("control-before");
      complete(contract.controlPhases[0]);
      mark(contract.controlPhases[1], "request-animation-frame-gap");
      const gapStart = performance.now();
      for (let frame = 0; frame < contract.controlGapFrames; frame++)
        await nextFrame();
      await settle(
        active,
        contract.maximumSettleFrames,
        "WebGL post-gap S5 terrain",
      );
      const afterGap = await snapshot("control-after-gap");
      const gapElapsed = performance.now() - gapStart;
      complete(contract.controlPhases[1]);
      const delta = imageDelta(
        before.image.sampleRgba,
        afterGap.image.sampleRgba,
      );
      return await attestedCapture.finish({
        renderer: "webgl",
        runtimeIdentity,
        progress,
        before,
        afterGap,
        gap: {
          requestedFrames: contract.controlGapFrames,
          observedFrames: contract.controlGapFrames,
          elapsedMs: gapElapsed,
          triggerInvocations: 0,
        },
        continuity: {
          sameScene: scene === owner.scene,
          sameContext: scene.context === owner.context,
          sameCanvas: scene.canvas === owner.canvas,
          sameView: scene._view === owner.view,
          sameProvider: globe.terrainProvider === owner.provider,
          frameAdvanced: afterGap.frameNumber > before.frameNumber,
          terrainExact: sameArray(
            before.selectedTileIds,
            afterGap.selectedTileIds,
          ),
          s5PayloadExact: sameArray(before.s5.payload, afterGap.s5.payload),
          renderComparable:
            delta.meanAbsoluteDelta <=
              contract.controlMaximumMeanAbsoluteDelta &&
            delta.changedPixelShare <= contract.controlMaximumChangedPixelShare,
          nonVacuous:
            before.image.nonBlackPixels >=
              contract.minimumNonBlackSamplePixels &&
            afterGap.image.nonBlackPixels >=
              contract.minimumNonBlackSamplePixels,
        },
        listenersRemoved: true,
      });
    }

    const native = globalThis.__c1229S5ReplacementNative;
    if (!native)
      throw new Error(
        "native resource ledger was not installed before viewer construction",
      );
    const oldDevice = context._device;
    const oldAdapter = context._adapter;
    const oldGeneration = context.resourceGeneration;
    native.trackDevice(oldDevice, "D0");
    globalThis.__armWebGPUDevice?.(oldDevice, "replacement-D0");

    const modelPosition = C.Ellipsoid.WGS84.cartographicToCartesian(
      new C.Cartographic(
        centre.longitude,
        centre.latitude,
        contract.terrainMeters + 100,
      ),
    );
    const model = await C.Model.fromGltfAsync({
      url: contract.tinyModelRoute,
      modelMatrix: C.Transforms.eastNorthUpToFixedFrame(
        modelPosition,
        C.Ellipsoid.WGS84,
      ),
      scale: 1,
    });
    scene.primitives.add(model);
    await settle(
      () => model.ready === true,
      contract.maximumSettleFrames,
      "pre-loss retained model",
    );
    const manager = model.environmentMapManager;
    manager.enabled = true;
    manager.enableSceneCapture = false;
    render();
    owner.model = model;
    owner.manager = manager;

    mark(contract.webgpuPhases[0], "inspect-normal-termination-hook");
    const benchmark = globalThis.chrome?.gpuBenchmarking;
    const methodValue = benchmark?.terminateGpuProcessNormally;
    const eligibility = {
      secureContext: globalThis.isSecureContext === true,
      navigatorGpu: Boolean(navigator.gpu),
      objectPath: "chrome.gpuBenchmarking",
      objectPresent: Boolean(benchmark),
      method: "terminateGpuProcessNormally",
      methodType:
        typeof methodValue === "function"
          ? "function"
          : methodValue === undefined
            ? "undefined"
            : "other",
      launchFlag: "--enable-gpu-benchmarking",
      eligible:
        globalThis.isSecureContext === true &&
        Boolean(navigator.gpu) &&
        Boolean(benchmark) &&
        typeof methodValue === "function",
    };
    complete(contract.webgpuPhases[0]);
    if (!eligibility.eligible) {
      return await attestedCapture.finish({
        renderer: "webgpu",
        runtimeIdentity,
        progress,
        classification: "hook-unavailable",
        eligibility,
        before: null,
        trigger: null,
        loss: null,
        recovery: null,
        identity: null,
        generations: null,
        invalidation: null,
        ledger: null,
        terrain: null,
        render: null,
        pick: null,
        capture: null,
        listenersRemoved: true,
      });
    }

    const recoveryEvents = [];
    const invalidationOrdinals = [];
    const removeLoss = context.onDeviceLost((info) =>
      recoveryEvents.push({
        reason: String(info.reason ?? "unknown"),
        state: String(info.state ?? "unknown"),
        willRecover: Boolean(info.willRecover),
      }),
    );
    const removeInvalidation = context.onDeviceInvalidated(() =>
      invalidationOrdinals.push(native.mark("invalidation")),
    );
    let listenersRemoved = false;
    try {
      mark(contract.webgpuPhases[1], "capture-D0-carrier-and-terrain");
      native.setStage("before-loss");
      const before = await snapshot("webgpu-before");
      const beforeProof = native.proof("D0", before.s5.payload, {
        requireScenePass: true,
      });
      complete(contract.webgpuPhases[1]);

      mark(contract.webgpuPhases[2], "invoke-normal-GPU-process-termination");
      native.setStage("loss-pending");
      const lossStart = performance.now();
      const lossPromise = oldDevice.lost.then((info) => {
        native.setStage("after-loss");
        native.mark("loss");
        return {
          reason: String(info?.reason ?? "unknown"),
          message: String(info?.message ?? ""),
        };
      });
      let invoked = 0;
      let returned = false;
      console.info(contract.recoveryIntervalBeginMarker);
      invoked++;
      Reflect.apply(methodValue, benchmark, []);
      returned = true;
      const lossInfo = await Promise.race([
        lossPromise,
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  "normal GPU-process termination did not resolve D0 device.lost",
                ),
              ),
            contract.maximumRecoveryMs,
          ),
        ),
      ]);
      const loss = {
        observed: true,
        reason: lossInfo.reason,
        message: lossInfo.message,
        recoverable: lossInfo.reason !== "destroyed",
        eventCount: 1,
        elapsedMs: performance.now() - lossStart,
        classification:
          lossInfo.reason === "destroyed"
            ? "destroyed-terminal-not-replacement"
            : "replacement",
      };
      const trigger = {
        objectPath: "chrome.gpuBenchmarking",
        method: "terminateGpuProcessNormally",
        invocations: invoked,
        returned,
        destroyCalls: 0,
        crashHookCalls: 0,
        onlyAuthorizedTrigger: invoked === 1,
      };
      if (lossInfo.reason === "destroyed") {
        console.info(contract.recoveryIntervalEndMarker);
        complete(contract.webgpuPhases[2]);
        removeLoss();
        removeInvalidation();
        listenersRemoved = true;
        return await attestedCapture.finish({
          renderer: "webgpu",
          runtimeIdentity,
          progress,
          classification: "destroyed-not-replacement",
          eligibility,
          before,
          trigger,
          loss,
          recovery: null,
          identity: null,
          generations: null,
          invalidation: null,
          ledger: null,
          terrain: null,
          render: null,
          pick: null,
          capture: null,
          listenersRemoved,
        });
      }

      const recoveryStart = performance.now();
      for (;;) {
        if (
          context._device &&
          context._device !== oldDevice &&
          context.resourceGeneration === oldGeneration + 1 &&
          String(context.deviceLossState).toLowerCase() === "healthy" &&
          recoveryEvents.some((entry) => entry.reason === "recovered")
        )
          break;
        if (performance.now() - recoveryStart > contract.maximumRecoveryMs)
          throw new Error("replacement device did not become healthy in time");
        await nextFrame();
      }
      complete(contract.webgpuPhases[2]);

      mark(contract.webgpuPhases[3], "bind-fresh-D1-generation");
      const newDevice = context._device;
      const newAdapter = context._adapter;
      native.trackDevice(newDevice, "D1");
      globalThis.__armWebGPUDevice?.(newDevice, "replacement-D1");
      native.mark("healthy");
      native.setStage("replacement-healthy");
      console.info(contract.recoveryIntervalEndMarker);
      const recovery = {
        healthy: String(context.deviceLossState).toLowerCase() === "healthy",
        state: String(context.deviceLossState),
        attempts: context.recoveryAttempts,
        elapsedMs: performance.now() - recoveryStart,
        deviceLostEvents: recoveryEvents.filter(
          (entry) => entry.reason !== "recovered",
        ).length,
        recoveredEvents: recoveryEvents.filter(
          (entry) => entry.reason === "recovered",
        ).length,
      };
      const identity = {
        sameScene: scene === owner.scene,
        sameContext: scene.context === owner.context,
        sameCanvas: scene.canvas === owner.canvas,
        sameCanvasContext: context._context === owner.canvasContext,
        sameView: scene._view === owner.view,
        sameGlobe: scene.globe === owner.globe,
        sameProvider: globe.terrainProvider === owner.provider,
        sameModel: model === owner.model,
        sameManager: manager === owner.manager,
        freshAdapter: newAdapter !== oldAdapter,
        freshDevice: newDevice !== oldDevice,
      };
      const generations = {
        before: oldGeneration,
        after: context.resourceGeneration,
        delta: context.resourceGeneration - oldGeneration,
      };
      const lossMark = native.mark("retirement-observed");
      void lossMark;
      complete(contract.webgpuPhases[3]);

      mark(contract.webgpuPhases[4], "render-terrain-S5-on-D1");
      await settle(
        () =>
          active() &&
          selectedIds().join("|") === before.selectedTileIds.join("|"),
        contract.maximumSettleFrames,
        "D1 terrain/S5 continuity",
      );
      const after = await snapshot("webgpu-after");
      const delta = imageDelta(before.image.sampleRgba, after.image.sampleRgba);
      const terrain = {
        before,
        after,
        sameProvider: globe.terrainProvider === owner.provider,
        selectedIdsExact: sameArray(
          before.selectedTileIds,
          after.selectedTileIds,
        ),
        surfaceRadiusExact: Object.is(
          before.surfaceRadius,
          after.surfaceRadius,
        ),
        s5PayloadExact: sameArray(before.s5.payload, after.s5.payload),
        activeBoth: before.s5.gate > 0.5 && after.s5.gate > 0.5,
      };
      const renderResult = {
        beforeImage: before.image,
        afterImage: after.image,
        meanAbsoluteDelta: delta.meanAbsoluteDelta,
        changedPixelShare: delta.changedPixelShare,
        comparable:
          delta.meanAbsoluteDelta <=
            contract.replacementMaximumMeanAbsoluteDelta &&
          delta.changedPixelShare <=
            contract.replacementMaximumChangedPixelShare,
        nonVacuous:
          before.image.nonBlackPixels >= contract.minimumNonBlackSamplePixels &&
          after.image.nonBlackPixels >= contract.minimumNonBlackSamplePixels,
      };
      complete(contract.webgpuPhases[4]);

      mark(contract.webgpuPhases[5], "real-scene-pickAsync-on-D1");
      const pickableBefore = globe.pickable;
      globe.pickable = true;
      render();
      let pickSettled = false;
      let picked;
      let pickError;
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
      let pickFrames = 0;
      while (!pickSettled && pickFrames < contract.maximumPickFrames) {
        render();
        pickFrames++;
        await nextFrame();
      }
      globe.pickable = pickableBefore;
      if (!pickSettled)
        throw new Error("replacement scene.pickAsync did not settle");
      if (pickError) throw pickError;
      const pick = {
        method: "scene.pickAsync",
        invoked: true,
        awaited: true,
        settled: pickSettled,
        renderPumpFrames: pickFrames,
        resultKind: picked?.primitive === globe ? "globe" : typeof picked,
        resultPrimitiveIdentity: picked?.primitive === globe,
        sameScene: scene === owner.scene,
        sameContext: scene.context === owner.context,
        s5Active: scene.frameState.eclipseGlobeShadow?.params?.x > 0.5,
        generation: context.resourceGeneration,
      };
      complete(contract.webgpuPhases[5]);

      mark(contract.webgpuPhases[6], "manager-driven-retained-capture-on-D1");
      context._options.webgpu ??= {};
      context._options.webgpu.sceneCaptureReflections = true;
      // Correlate one descriptor produced by the retained-capture path with the
      // exact native setBindGroup/writeBuffer proof. A generic D1 main-frame
      // bind is insufficient to certify the capture carrier.
      for (let frame = 0; frame < 4; frame++) {
        render();
        await nextFrame();
      }
      const captureGlobeRenderer =
        context._webgpuSceneCaptureSources?.globeRenderer;
      const originalCaptureCommands =
        captureGlobeRenderer?.getOrCreateCaptureTileCommands;
      if (typeof originalCaptureCommands !== "function") {
        throw new Error(
          "retained-capture globe command producer is unavailable",
        );
      }
      const withMethodPatch = globalThis.__withC1229S5ReplacementMethodPatch;
      if (typeof withMethodPatch !== "function") {
        throw new Error("retained-capture method-patch guard is unavailable");
      }
      const captureDescriptors = [];
      const captureWrapper = function (...args) {
        const commands = originalCaptureCommands.apply(this, args);
        for (const command of commands ?? []) {
          const offsets = Array.from(
            command.bindGroup0DynamicOffsets ?? [],
            Number,
          );
          captureDescriptors.push({
            bindGroupToken: native.bindGroupToken(command.bindGroups?.[0]),
            dynamicOffsets: offsets,
            descriptorOrdinal: native.mark("capture-descriptor"),
            positiveDraw: command.indexCount > 0,
          });
        }
        return commands;
      };
      let captureFrames = 0;
      let captureProof;
      let captureDescriptor;
      await withMethodPatch(
        captureGlobeRenderer,
        "getOrCreateCaptureTileCommands",
        captureWrapper,
        async () => {
          const captureStartOrdinal = native.mark("capture-native-start");
          native.setStage("replacement-capture");
          manager.enableSceneCapture = true;
          manager.reset();
          while (
            manager._webgpuCache?.lastSceneCaptureResult !== 2 &&
            captureFrames < contract.maximumCaptureFrames
          ) {
            render();
            captureFrames++;
            await nextFrame();
          }
          captureDescriptor = [...captureDescriptors]
            .reverse()
            .find(
              (entry) =>
                entry.positiveDraw &&
                typeof entry.bindGroupToken === "string" &&
                entry.dynamicOffsets.length === 3 &&
                entry.dynamicOffsets.every(Number.isInteger) &&
                Number.isInteger(entry.descriptorOrdinal),
            );
          if (!captureDescriptor) {
            throw new Error(
              "retained capture emitted no witnessed terrain command",
            );
          }
          captureProof = native.proof("D1", after.s5.payload, {
            requiredBindGroupToken: captureDescriptor.bindGroupToken,
            requiredDynamicOffsets: captureDescriptor.dynamicOffsets,
            descriptorOrdinal: captureDescriptor.descriptorOrdinal,
            requireCapturePass: true,
            minimumBindOrdinal: captureStartOrdinal,
          });
        },
      );
      const captureSources = context._webgpuSceneCaptureSources;
      const captureSelected = [
        ...(captureSources?.tileProvider?._quadtree?._tilesToRender ?? []),
      ];
      const captureStatus = manager._webgpuCache?.lastSceneCaptureResult ?? 0;
      const submitted = captureStatus === 2;
      const removed = scene.primitives.remove(model);
      render();
      const capture = {
        managerDriven: true,
        directHelperCall: false,
        sameModel: model === owner.model,
        sameManager: manager === owner.manager,
        submitted,
        statusCode: captureStatus,
        settleFrames: captureFrames,
        selectedTileCount: captureSelected.length,
        s5Active: scene.frameState.eclipseGlobeShadow?.params?.x > 0.5,
        generation: context.resourceGeneration,
        d1Binding2Observed:
          captureProof.deviceToken === native.trackDevice(newDevice, "D1") &&
          captureProof.bindGroupToken === captureDescriptor.bindGroupToken &&
          captureProof.descriptorOrdinal ===
            captureDescriptor.descriptorOrdinal &&
          captureProof.dynamicOffsets.every((value, index) =>
            Object.is(value, captureDescriptor.dynamicOffsets[index]),
          ) &&
          /^DynEnvMap Capture Face [0-5]$/u.test(captureProof.passLabel) &&
          captureProof.bindOrdinal > captureDescriptor.descriptorOrdinal &&
          captureProof.bindOrdinal < captureProof.uploadOrdinal &&
          captureProof.uploadOrdinal < captureProof.finishOrdinal &&
          captureProof.finishOrdinal < captureProof.submitOrdinal,
        modelRemoved: removed && !scene.primitives.contains(model),
        modelDestroyed: model.isDestroyed?.() === true,
        captureSourcesCleared:
          context._webgpuSceneCaptureModels == null ||
          !context._webgpuSceneCaptureModels?.includes?.(model),
      };
      complete(contract.webgpuPhases[6]);

      removeLoss();
      removeInvalidation();
      listenersRemoved = true;
      const ledgerWithSequence = native.finalize(beforeProof, captureProof);
      return await attestedCapture.finish({
        renderer: "webgpu",
        runtimeIdentity,
        progress,
        classification: "eligible-replacement",
        eligibility,
        before,
        trigger,
        loss,
        recovery,
        identity,
        generations,
        invalidation: {
          count: invalidationOrdinals.length,
          ordinals: invalidationOrdinals,
          afterLossBeforeHealthy:
            invalidationOrdinals.length === 1 &&
            invalidationOrdinals[0] >
              ledgerWithSequence.retirement.lossOrdinal &&
            invalidationOrdinals[0] <
              ledgerWithSequence.retirement.healthyOrdinal,
        },
        ledgerWithSequence,
        terrain,
        render: renderResult,
        pick,
        capture,
        listenersRemoved,
      });
    } finally {
      if (!listenersRemoved) {
        try {
          removeLoss();
        } catch {
          /* preserve primary error */
        }
        try {
          removeInvalidation();
        } catch {
          /* preserve primary error */
        }
      }
    }
  };

function fileIdentity(relativePath) {
  const bytes = fs.readFileSync(path.join(repositoryRoot, relativePath));
  return {
    path: relativePath,
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

async function servedIdentity(origin, relativePath) {
  const url = new URL(`/${relativePath}`, origin);
  const response = await fetch(url, { cache: "no-store", redirect: "error" });
  if (!response.ok)
    throw new Error(`${url.href} returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    path: relativePath,
    url: url.href,
    status: response.status,
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

function collectLocalFiles() {
  return C12_29_S5_REPLACEMENT_LOCAL_FILES.map(fileIdentity);
}

function repositoryPath(file) {
  const relative = path.relative(repositoryRoot, file);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`replacement-device path escaped the repository: ${file}`);
  }
  return relative.split(path.sep).join("/");
}

function resolvePolicyImport(from, specifier) {
  const resolved = path.resolve(
    repositoryRoot,
    path.posix.dirname(from),
    specifier,
  );
  return repositoryPath(resolved);
}

export function collectC1229S5ReplacementPolicyBoundary(
  localStart,
  operations = fs,
) {
  const expectedFiles = new Set(C12_29_S5_REPLACEMENT_POLICY_FILES);
  const visited = new Set();
  const queue = [...C12_29_S5_REPLACEMENT_POLICY_ROOTS];
  const edges = [];
  const externalSpecifiers = new Set();
  const dynamicImports = [];
  while (queue.length > 0) {
    const from = queue.shift();
    if (visited.has(from)) continue;
    if (!expectedFiles.has(from)) {
      throw new Error(
        `replacement-device policy closure reached undeclared file ${from}`,
      );
    }
    visited.add(from);
    const source = operations.readFileSync(
      path.join(repositoryRoot, from),
      "utf8",
    );
    const imports = inspectC1229S5ReplacementModuleImports(source);
    for (const specifier of imports.staticSpecifiers) {
      if (!specifier.startsWith(".")) {
        externalSpecifiers.add(specifier);
        continue;
      }
      const to = resolvePolicyImport(from, specifier);
      if (!expectedFiles.has(to)) {
        throw new Error(
          `replacement-device policy closure reached undeclared import ${from} -> ${specifier} (${to})`,
        );
      }
      edges.push({ from, specifier, to });
      queue.push(to);
    }
    for (const expression of imports.dynamicExpressions) {
      dynamicImports.push({ from, expression });
    }
  }
  edges.sort((left, right) =>
    `${left.from}\0${left.specifier}\0${left.to}`.localeCompare(
      `${right.from}\0${right.specifier}\0${right.to}`,
    ),
  );
  dynamicImports.sort((left, right) =>
    `${left.from}\0${left.expression}`.localeCompare(
      `${right.from}\0${right.expression}`,
    ),
  );
  const external = [...externalSpecifiers].sort();
  const files = C12_29_S5_REPLACEMENT_POLICY_FILES.map((file) => {
    const fingerprint = localStart.find((entry) => entry.path === file);
    if (!fingerprint) {
      throw new Error(
        `replacement-device policy fingerprint is absent for ${file}`,
      );
    }
    return { ...fingerprint };
  });
  const closed =
    visited.size === expectedFiles.size &&
    [...expectedFiles].every((file) => visited.has(file)) &&
    stableC1229S5ReplacementJson(external) ===
      stableC1229S5ReplacementJson([
        ...C12_29_S5_REPLACEMENT_POLICY_EXTERNALS,
      ]) &&
    dynamicImports.length === 1 &&
    dynamicImports[0].from ===
      "Tools/visual-regression/probe-c12-29-s5-replacement-device.mjs" &&
    dynamicImports[0].expression === "contract.runtimePath";
  return {
    schema: C12_29_S5_REPLACEMENT_POLICY_BOUNDARY_SCHEMA,
    roots: [...C12_29_S5_REPLACEMENT_POLICY_ROOTS],
    files,
    edges,
    externalSpecifiers: external,
    dynamicImports,
    closed,
  };
}

function sourceSetSha256(entries) {
  return sha256(Buffer.from(stableC1229S5ReplacementJson(entries)));
}

export function collectC1229S5ReplacementSourceBoundary(operations = fs) {
  const sourceMapBytes = operations.readFileSync(buildSourceMapPath);
  let sourceMap;
  try {
    sourceMap = JSON.parse(sourceMapBytes.toString("utf8"));
  } catch (error) {
    throw new Error("replacement-device source map is not JSON", {
      cause: error,
    });
  }
  if (
    sourceMap?.version !== 3 ||
    !Array.isArray(sourceMap.sources) ||
    !Array.isArray(sourceMap.sourcesContent) ||
    sourceMap.sources.length === 0 ||
    sourceMap.sources.length !== sourceMap.sourcesContent.length
  ) {
    throw new Error(
      "replacement-device source map does not expose a complete embedded source set",
    );
  }
  const pathEntries = [];
  const currentEntries = [];
  const embeddedEntries = [];
  const duplicatePaths = [];
  const missingPaths = [];
  const seen = new Set();
  let exactEntryCount = 0;
  for (let index = 0; index < sourceMap.sources.length; index++) {
    const specifier = sourceMap.sources[index];
    const embedded = sourceMap.sourcesContent[index];
    if (typeof specifier !== "string" || typeof embedded !== "string") {
      missingPaths.push(`source-map-entry-${index}`);
      continue;
    }
    const resolved = path.resolve(
      path.dirname(buildSourceMapPath),
      String(sourceMap.sourceRoot ?? ""),
      specifier,
    );
    let relative;
    try {
      relative = repositoryPath(resolved);
    } catch {
      missingPaths.push(specifier);
      continue;
    }
    if (seen.has(relative)) duplicatePaths.push(relative);
    seen.add(relative);
    pathEntries.push(relative);
    const embeddedBytes = Buffer.from(embedded);
    const embeddedFingerprint = {
      path: relative,
      byteLength: embeddedBytes.byteLength,
      sha256: sha256(embeddedBytes),
    };
    embeddedEntries.push(embeddedFingerprint);
    let currentBytes;
    try {
      currentBytes = operations.readFileSync(resolved);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (currentBytes) {
      currentEntries.push({
        path: relative,
        origin: "repository",
        byteLength: currentBytes.byteLength,
        sha256: sha256(currentBytes),
      });
      if (currentBytes.equals(embeddedBytes)) exactEntryCount++;
      else missingPaths.push(relative);
    } else if (relative.startsWith("node_modules/")) {
      // Published dependencies commonly omit their original TypeScript while
      // the build map embeds it. The embedded bytes are still a closed,
      // hash-bound authority; repository-owned source may never use this path.
      currentEntries.push({
        path: relative,
        origin: "embedded-only",
        byteLength: embeddedBytes.byteLength,
        sha256: embeddedFingerprint.sha256,
      });
      exactEntryCount++;
    } else {
      missingPaths.push(relative);
      currentEntries.push({
        path: relative,
        origin: "missing",
        byteLength: 0,
        sha256: sha256(Buffer.alloc(0)),
      });
    }
  }
  pathEntries.sort();
  currentEntries.sort((left, right) => left.path.localeCompare(right.path));
  embeddedEntries.sort((left, right) => left.path.localeCompare(right.path));
  duplicatePaths.sort();
  missingPaths.sort();
  const rootsPresent = C12_29_S5_REPLACEMENT_SOURCE_FILES.every((root) =>
    seen.has(root),
  );
  const resolvedEntryCount = pathEntries.length;
  const allExact =
    resolvedEntryCount === sourceMap.sources.length &&
    exactEntryCount === resolvedEntryCount &&
    duplicatePaths.length === 0 &&
    missingPaths.length === 0 &&
    rootsPresent;
  return {
    schema: C12_29_S5_REPLACEMENT_SOURCE_BOUNDARY_SCHEMA,
    sourceMapByteLength: sourceMapBytes.byteLength,
    sourceMapSha256: sha256(sourceMapBytes),
    sourceMapEntryCount: sourceMap.sources.length,
    resolvedEntryCount,
    exactEntryCount,
    pathSetSha256: sourceSetSha256(pathEntries),
    currentSetSha256: sourceSetSha256(currentEntries),
    embeddedSetSha256: sourceSetSha256(embeddedEntries),
    roots: [...C12_29_S5_REPLACEMENT_SOURCE_FILES],
    rootsPresent,
    duplicatePaths,
    missingPaths,
    allExact,
  };
}

async function collectProvenanceStart(
  baseIdentity,
  launch,
  captureSourceProof,
) {
  const localStart = collectLocalFiles();
  const policyBoundary = collectC1229S5ReplacementPolicyBoundary(localStart);
  const sourceBoundaryStart = collectC1229S5ReplacementSourceBoundary();
  const served = [];
  for (const file of C12_29_S5_REPLACEMENT_SERVED_FILES)
    served.push(await servedIdentity(baseIdentity.origin, file));
  const identity = inspectBuildSourceIdentity({
    sourceMapPath: buildSourceMapPath,
    sourceFiles: C12_29_S5_REPLACEMENT_SOURCE_FILES.map((file) =>
      path.join(repositoryRoot, file),
    ),
  });
  const servedMatchesLocal = C12_29_S5_REPLACEMENT_SERVED_FILES.every(
    (servedPath) => {
      const local = localStart.find((entry) => entry.path === servedPath);
      const response = served.find((entry) => entry.path === servedPath);
      return (
        local?.byteLength === response?.byteLength &&
        local?.sha256 === response?.sha256
      );
    },
  );
  const provenance = {
    schema: C12_29_S5_REPLACEMENT_PROVENANCE_SCHEMA,
    gitHead: safeGitHead(repositoryRoot) ?? null,
    localStart,
    localEnd: [],
    served,
    buildSourceIdentity: {
      ok: identity.ok,
      sourceMapByteLength: identity.sourceMapByteLength,
      sourceMapSha256: identity.sourceMapSha256,
      entryCount: identity.entries.length,
      entries: identity.entries.map((entry, index) => {
        const sourcePath = C12_29_S5_REPLACEMENT_SOURCE_FILES[index];
        const local = localStart.find((item) => item.path === sourcePath);
        return {
          path: sourcePath,
          sourceMapEntry: entry.sourceMapEntry ?? null,
          currentByteLength: entry.currentByteLength ?? local?.byteLength ?? 0,
          embeddedByteLength: entry.embeddedByteLength ?? null,
          currentSha256: entry.currentSha256,
          embeddedSha256: entry.embeddedSha256 ?? null,
          exact: entry.exact,
          reason: entry.reason,
        };
      }),
      reasons: identity.reasons,
    },
    captureSourceProof,
    policyBoundary,
    sourceBoundaryStart,
    sourceBoundaryEnd: null,
    preflightSha256: "",
    stable: false,
    buildEntryMatchesServed:
      localStart.find(
        (entry) => entry.path === "Build/CesiumUnminified/index.js",
      )?.sha256 ===
        served.find((entry) => entry.path === "Build/CesiumUnminified/index.js")
          ?.sha256 &&
      localStart.find(
        (entry) => entry.path === "Build/CesiumUnminified/index.js",
      )?.byteLength ===
        served.find((entry) => entry.path === "Build/CesiumUnminified/index.js")
          ?.byteLength,
    servedMatchesLocal,
    browserResponsesMatchLocal: false,
    launch,
    browser: null,
    sessions: [],
  };
  provenance.preflightSha256 =
    deriveC1229S5ReplacementPreflightSha256(provenance);
  // Q-116 — this used to `throw` here on an invalid preflight (source-
  // identity drift, an unclosed policy boundary, a served/local mismatch,
  // ...). The caller had not yet acquired the RUNNING lock at that point
  // (`beginC1229S5ReplacementEvidenceRun` runs AFTER this returns), so the
  // throw reached the generic catch-all with `ownership` still `undefined`
  // and its `if (!ownership || ...) throw error;` re-threw uncaught — a
  // legitimate structural refusal with no published artifact. Returning the
  // verdict instead of throwing lets the caller build and WRITE a refusal
  // artifact for this exact case (`buildC1229S5ReplacementPreflightRefusalArtifact`
  // / `writeC1229S5ReplacementPreflightRefusal`, below) rather than crashing.
  const valid = validateC1229S5ReplacementPreflightProvenance(provenance);
  return { provenance, valid };
}

/**
 * Builds the structured artifact for a preflight that refused before any
 * RUNNING lock existed. Pure and synchronous: everything it reads was
 * already collected by `collectProvenanceStart`, so this is unit-testable
 * against a hand-built `provenance`/`valid` pair with no filesystem, network,
 * or browser (Q-116).
 *
 * @param {string} runId
 * @param {object} provenance The (invalid) provenance `collectProvenanceStart` collected.
 * @param {{ok: boolean, reasons: Array<string>}} valid Its validation verdict.
 * @returns {object} A self-describing STRUCTURAL artifact — reasons, and the
 *   identity deltas / build-vs-tree tuples the reasons are about.
 */
export function buildC1229S5ReplacementPreflightRefusalArtifact(
  runId,
  provenance,
  valid,
) {
  return {
    schema: C12_29_S5_REPLACEMENT_PREFLIGHT_REFUSAL_SCHEMA,
    runId,
    status: "STRUCTURAL",
    incomplete: true,
    exitCode: exitCodeForC1229S5ReplacementStatus("STRUCTURAL"),
    // Q-116 (N7, station-3 review) — non-reproducible by construction, so a
    // second build+write attempt under the SAME runId produces different
    // bytes and `writeOnceExact` throws (the uncaught-crash shape this row
    // removed, resurfacing at a narrower seam). Unreachable in production
    // today: `runId = options.runId ?? randomUUID()` in
    // `runC1229S5ReplacementDeviceProbe`, and the CLI never passes
    // `--run-id`, so no caller can retry under a fixed runId. Latent, not
    // live — noted here rather than dropped, since the timestamp has real
    // diagnostic value for a human reading the artifact later.
    refusedAt: new Date().toISOString(),
    reasons: [...(valid?.reasons ?? [])],
    gitHead: provenance?.gitHead ?? null,
    preflightSha256: provenance?.preflightSha256 ?? null,
    // The build/tree tuples: each entry names one source file's current
    // on-disk identity next to what the served build's source map embeds.
    buildSourceIdentity: provenance?.buildSourceIdentity ?? null,
    policyBoundary: provenance?.policyBoundary
      ? { closed: provenance.policyBoundary.closed }
      : null,
    sourceBoundaryStart: provenance?.sourceBoundaryStart
      ? { allExact: provenance.sourceBoundaryStart.allExact }
      : null,
    buildEntryMatchesServed: provenance?.buildEntryMatchesServed ?? null,
    servedMatchesLocal: provenance?.servedMatchesLocal ?? null,
  };
}

/**
 * Writes the preflight-refusal artifact and its receipt to their write-once,
 * runId-scoped paths. Neither path participates in the lock/`latest.json` CAS
 * chain (no ownership was ever claimed for this run), so this needs no
 * `ownership` object and touches no shared state another run could contend
 * for (Q-116).
 *
 * @param {object} paths From {@link createC1229S5ReplacementArtifactPaths}.
 * @param {object} artifact From {@link buildC1229S5ReplacementPreflightRefusalArtifact}.
 * @param {object} [operations] Filesystem operations (test seam).
 * @returns {object} Shaped like {@link finalizeC1229S5ReplacementEvidence}'s
 *   return value so callers (`runC1229S5ReplacementDeviceProbe`'s own CLI
 *   reporter) can read `publication.archive`/`publication.sha256` uniformly.
 */
export function writeC1229S5ReplacementPreflightRefusal(
  paths,
  artifact,
  operations = fs,
) {
  // Q-116 (N4, station-3 review) — dense-cost refuses to publish an invalid
  // final artifact (`validateC1229S5DenseFinalArtifact`); this write-once
  // path had no equivalent, so a malformed artifact would be permanently
  // baked at its path with nothing to catch it. Refuse BEFORE any write.
  const validity = validateC1229S5ReplacementPreflightRefusalArtifact(artifact);
  if (!validity.ok) {
    throw new Error(
      `refusing invalid preflight refusal artifact: ${validity.reasons.join("; ")}`,
    );
  }
  operations.mkdirSync(paths.directory, { recursive: true });
  const artifactBytes = jsonBytes(artifact);
  writeOnceExact(
    paths.refusal,
    artifactBytes,
    "replacement-device preflight refusal artifact",
    operations,
  );
  const receipt = {
    schema: C12_29_S5_REPLACEMENT_PREFLIGHT_REFUSAL_RECEIPT_SCHEMA,
    runId: artifact.runId,
    status: artifact.status,
    exitCode: artifact.exitCode,
    reasons: artifact.reasons,
    archive: paths.refusal,
    archiveByteLength: artifactBytes.byteLength,
    archiveSha256: sha256(artifactBytes),
  };
  const receiptBytes = jsonBytes(receipt);
  writeOnceExact(
    paths.refusalReceipt,
    receiptBytes,
    "replacement-device preflight refusal receipt",
    operations,
  );
  return {
    archive: paths.refusal,
    latest: null,
    byteLength: artifactBytes.byteLength,
    sha256: sha256(artifactBytes),
    images: [],
    receipt: paths.refusalReceipt,
    receiptByteLength: receiptBytes.byteLength,
    receiptSha256: sha256(receiptBytes),
  };
}

function finishProvenance(provenance) {
  provenance.localEnd = collectLocalFiles();
  provenance.sourceBoundaryEnd = collectC1229S5ReplacementSourceBoundary();
  provenance.stable =
    stableC1229S5ReplacementJson(provenance.localStart) ===
      stableC1229S5ReplacementJson(provenance.localEnd) &&
    stableC1229S5ReplacementJson(provenance.sourceBoundaryStart) ===
      stableC1229S5ReplacementJson(provenance.sourceBoundaryEnd);
  return provenance;
}

function enrichImage(snapshot, runId, imageBytes) {
  const image = snapshot?.image;
  const match = /^data:image\/png;base64,(.+)$/u.exec(image.dataUrl);
  if (!match) throw new Error(`${image.label} did not return a PNG data URL`);
  const bytes = Buffer.from(match[1], "base64");
  if (bytes.toString("base64") !== match[1]) {
    throw new Error(`${image.label} PNG data URL is not canonical base64`);
  }
  const decoded = inspectC1229S5ReplacementPng(bytes);
  if (!decoded.ok) {
    throw new Error(
      `${image.label} PNG decode failed: ${decoded.reasons.join("; ")}`,
    );
  }
  const proof = decoded.proof;
  if (
    image.width !== proof.width ||
    image.height !== proof.height ||
    image.capturePngSha256 !== proof.sha256 ||
    image.sampleSha256 !==
      sha256(Buffer.from(JSON.stringify(proof.sampleRgba))) ||
    image.frameSha256 !==
      deriveC1229S5ReplacementCaptureFrameSha256(snapshot) ||
    image.samplerSchema !== C12_29_S5_REPLACEMENT_SAMPLER_SCHEMA ||
    image.sampleWidth !== proof.sampleWidth ||
    image.sampleHeight !== proof.sampleHeight ||
    image.nonBlackPixels !== proof.nonBlackPixels ||
    !Object.is(image.meanLuminance, proof.meanLuminance) ||
    stableC1229S5ReplacementJson(image.sampleRgba) !==
      stableC1229S5ReplacementJson(proof.sampleRgba)
  ) {
    throw new Error(
      `${image.label} browser samples do not derive from its documentary PNG`,
    );
  }
  if (
    image.transactionSha256 !==
    deriveC1229S5ReplacementCaptureTransactionSha256(image)
  ) {
    throw new Error(`${image.label} capture transaction seal is invalid`);
  }
  const pngFile = `${runId}.${image.label}.png`;
  imageBytes.set(pngFile, bytes);
  return {
    label: image.label,
    sessionId: image.sessionId,
    renderer: image.renderer,
    witnessNonce: image.witnessNonce,
    witnessSequence: image.witnessSequence,
    sceneToken: image.sceneToken,
    contextToken: image.contextToken,
    canvasToken: image.canvasToken,
    adapterToken: image.adapterToken,
    deviceToken: image.deviceToken,
    resourceGeneration: image.resourceGeneration,
    captureNonce: image.captureNonce,
    captureOrdinal: image.captureOrdinal,
    frameSha256: image.frameSha256,
    transactionSha256: image.transactionSha256,
    width: proof.width,
    height: proof.height,
    pngFile,
    byteLength: proof.byteLength,
    sha256: proof.sha256,
    sampleSha256: image.sampleSha256,
    samplerSchema: proof.samplerSchema,
    sampleWidth: proof.sampleWidth,
    sampleHeight: proof.sampleHeight,
    nonBlackPixels: proof.nonBlackPixels,
    meanLuminance: proof.meanLuminance,
    sampleRgba: proof.sampleRgba,
  };
}

function enrichMeasurementImages(measured, runId, imageBytes) {
  if (measured.before?.image?.dataUrl)
    measured.before.image = enrichImage(measured.before, runId, imageBytes);
  if (measured.afterGap?.image?.dataUrl)
    measured.afterGap.image = enrichImage(measured.afterGap, runId, imageBytes);
  if (measured.terrain) {
    if (measured.terrain.before?.image?.dataUrl)
      measured.terrain.before.image = enrichImage(
        measured.terrain.before,
        runId,
        imageBytes,
      );
    if (measured.terrain.after?.image?.dataUrl)
      measured.terrain.after.image = enrichImage(
        measured.terrain.after,
        runId,
        imageBytes,
      );
  }
  if (measured.render) {
    measured.render.beforeImage = measured.terrain.before.image;
    measured.render.afterImage = measured.terrain.after.image;
  }
  // WebGPU's pre-loss snapshot is the same value later embedded in terrain.
  if (measured.before && measured.terrain)
    measured.before = measured.terrain.before;
  if (measured.ledgerWithSequence) {
    measured.ledger = measured.ledgerWithSequence;
    delete measured.ledgerWithSequence;
  }
  return measured;
}

function sessionContract(renderer, sessionId, captureSourceProof) {
  return {
    renderer,
    runtimePath,
    progressSchema: C12_29_S5_REPLACEMENT_PAGE_PROGRESS_SCHEMA,
    controlPhases: [...C12_29_S5_REPLACEMENT_CONTROL_PHASES],
    webgpuPhases: [...C12_29_S5_REPLACEMENT_WEBGPU_PHASES],
    eventIso: C12_29_S5_REPLACEMENT_CONFIG.eventIso,
    viewport: { ...C12_29_S5_REPLACEMENT_CONFIG.viewport },
    terrainWidth: C12_29_S5_REPLACEMENT_CONFIG.terrainWidth,
    terrainHeight: C12_29_S5_REPLACEMENT_CONFIG.terrainHeight,
    terrainMeters: C12_29_S5_REPLACEMENT_CONFIG.terrainMeters,
    maximumScreenSpaceError:
      C12_29_S5_REPLACEMENT_CONFIG.maximumScreenSpaceError,
    cameraHeightMeters: C12_29_S5_REPLACEMENT_CONFIG.cameraHeightMeters,
    cameraFovDegrees: C12_29_S5_REPLACEMENT_CONFIG.cameraFovDegrees,
    controlGapFrames: C12_29_S5_REPLACEMENT_CONFIG.controlGapFrames,
    maximumSettleFrames: C12_29_S5_REPLACEMENT_CONFIG.maximumSettleFrames,
    maximumRecoveryMs: C12_29_S5_REPLACEMENT_CONFIG.maximumRecoveryMs,
    maximumPickFrames: C12_29_S5_REPLACEMENT_CONFIG.maximumPickFrames,
    maximumCaptureFrames: C12_29_S5_REPLACEMENT_CONFIG.maximumCaptureFrames,
    sampleWidth: C12_29_S5_REPLACEMENT_CONFIG.sampleWidth,
    sampleHeight: C12_29_S5_REPLACEMENT_CONFIG.sampleHeight,
    samplerSchema: C12_29_S5_REPLACEMENT_CONFIG.samplerSchema,
    captureTransactionSchema: C12_29_S5_REPLACEMENT_CAPTURE_TRANSACTION_SCHEMA,
    attestation: {
      schema: C12_29_S5_REPLACEMENT_RUNTIME_ATTESTATION_SCHEMA,
      sessionId,
      renderer,
      installerSha256: C12_29_S5_REPLACEMENT_RUNTIME_ATTESTOR_SOURCE_SHA256,
      measurementSha256: captureSourceProof.measurement.executedSha256,
      captureFactorySha256: captureSourceProof.fused.executedSha256,
      samplerSha256: captureSourceProof.sampler.executedSha256,
      frameReaderSha256: captureSourceProof.frameReader.executedSha256,
      captureTransactionSchema:
        C12_29_S5_REPLACEMENT_CAPTURE_TRANSACTION_SCHEMA,
      samplerSchema: C12_29_S5_REPLACEMENT_SAMPLER_SCHEMA,
      sampleWidth: C12_29_S5_REPLACEMENT_CONFIG.sampleWidth,
      sampleHeight: C12_29_S5_REPLACEMENT_CONFIG.sampleHeight,
    },
    changedSampleRgbSumThreshold:
      C12_29_S5_REPLACEMENT_CONTRACT.thresholds.changedSampleRgbSumThreshold,
    minimumNonBlackSamplePixels:
      C12_29_S5_REPLACEMENT_CONFIG.minimumNonBlackSamplePixels,
    controlMaximumMeanAbsoluteDelta:
      C12_29_S5_REPLACEMENT_CONFIG.controlMaximumMeanAbsoluteDelta,
    controlMaximumChangedPixelShare:
      C12_29_S5_REPLACEMENT_CONFIG.controlMaximumChangedPixelShare,
    replacementMaximumMeanAbsoluteDelta:
      C12_29_S5_REPLACEMENT_CONFIG.replacementMaximumMeanAbsoluteDelta,
    replacementMaximumChangedPixelShare:
      C12_29_S5_REPLACEMENT_CONFIG.replacementMaximumChangedPixelShare,
    tinyModelRoute: C12_29_S5_REPLACEMENT_CONFIG.tinyModelRoute,
    recoveryIntervalBeginMarker:
      C12_29_S5_REPLACEMENT_CONFIG.recoveryIntervalBeginMarker,
    recoveryIntervalEndMarker:
      C12_29_S5_REPLACEMENT_CONFIG.recoveryIntervalEndMarker,
  };
}

async function closeBounded(
  instance,
  label,
  timeoutMs = SESSION_CLOSE_TIMEOUT_MS,
) {
  if (!instance)
    return { label, attempted: false, closed: true, timedOut: false };
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

function progressFrom(value, renderer) {
  const candidate = value && JSON.parse(JSON.stringify(value));
  return validateC1229S5ReplacementPageProgress(candidate).ok &&
    candidate.renderer === renderer
    ? candidate
    : null;
}

async function captureWatchdogCheckpoint(watchdogState) {
  const current = watchdogState?.current;
  if (!current?.renderer) return null;
  let progress = current.pageProgress ?? null;
  if (current.page && !current.page.isClosed?.()) {
    let timer;
    try {
      const raw = await Promise.race([
        current.page.evaluate(
          () => globalThis.__c1229S5ReplacementProgress ?? null,
        ),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), 2_000);
        }),
      ]);
      progress = progressFrom(raw, current.renderer) ?? progress;
    } catch {
      /* retain the last already-materialized checkpoint */
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    stage: current.renderer === "webgl" ? "control-page" : "webgpu-page",
    phase: progress?.currentPhase ?? "preflight",
    renderer: current.renderer,
    kind: "timeout",
    timeoutMs: null,
    pageProgress: progress,
  };
}

async function runBrowserSession(
  browser,
  renderer,
  baseIdentity,
  watchdogState,
  runId,
  imageBytes,
  captureSourceProof,
) {
  const sessionId = randomUUID();
  const witnessBindingName = `__c1229S5ReplacementWitness_${randomUUID().replaceAll("-", "")}`;
  const attestationEvents = [];
  const browserContext = await browser.newContext({
    viewport: { ...C12_29_S5_REPLACEMENT_CONFIG.viewport },
    deviceScaleFactor: 1,
  });
  await browserContext.exposeBinding(witnessBindingName, (_source, event) => {
    if (
      event?.schema !== C12_29_S5_REPLACEMENT_RUNTIME_ATTESTATION_SCHEMA ||
      event?.sessionId !== sessionId ||
      event?.renderer !== renderer ||
      event?.sequence !== attestationEvents.length + 1
    ) {
      throw new Error(
        "replacement-device out-of-band witness event is invalid",
      );
    }
    attestationEvents.push(structuredClone(event));
  });
  const externalRequests = [];
  const failedRequests = [];
  const httpErrors = [];
  const pageErrors = [];
  const consoleErrors = [];
  const expectedRecoveryConsole = [];
  const expectedPoolRecoveryConsole = [];
  const recoveryConsoleInterval = {
    beginCount: 0,
    endCount: 0,
    openAtEnd: false,
  };
  const consumedResponses = [];
  const responseBodyTasks = [];
  const pending = new Set();
  await browserContext.route("**/*", async (route) => {
    let url;
    try {
      url = new URL(route.request().url());
    } catch {
      await route.continue();
      return;
    }
    if (/^https?:$/u.test(url.protocol) && url.origin !== baseIdentity.origin) {
      externalRequests.push(url.href);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  const page = await browserContext.newPage();
  if (watchdogState) {
    watchdogState.current = {
      renderer,
      page,
      browserContext,
      pending,
      pageProgress: null,
    };
  }
  await page.addInitScript(errorGateInit);
  await page.addInitScript(installC1229S5ReplacementRuntimeAttestor, {
    bindingName: witnessBindingName,
    schema: C12_29_S5_REPLACEMENT_RUNTIME_ATTESTATION_SCHEMA,
    sessionId,
    renderer,
  });
  if (renderer === "webgpu") {
    await page.addInitScript(installC1229S5ReplacementMethodPatch);
    await page.addInitScript(installC1229S5ReplacementNativeLedger);
  }
  page.on("request", (request) => pending.add(request));
  const settle = (request) => pending.delete(request);
  page.on("requestfinished", settle);
  page.on("requestfailed", (request) => {
    settle(request);
    if (!externalRequests.includes(request.url()))
      failedRequests.push(request.url());
  });
  page.on("response", (response) => {
    if (response.status() >= 400)
      httpErrors.push(`${response.status()} ${response.url()}`);
    let responseUrl;
    try {
      responseUrl = new URL(response.url());
    } catch {
      return;
    }
    const relativePath = responseUrl.pathname.replace(/^\//u, "");
    if (
      responseUrl.origin === baseIdentity.origin &&
      C12_29_S5_REPLACEMENT_SERVED_FILES.includes(relativePath)
    ) {
      responseBodyTasks.push(
        response.body().then((body) => {
          const bytes = Buffer.from(body);
          consumedResponses.push({
            path: relativePath,
            url: response.url(),
            status: response.status(),
            method: response.request().method(),
            resourceType: response.request().resourceType(),
            fromServiceWorker: response.fromServiceWorker(),
            byteLength: bytes.byteLength,
            sha256: sha256(bytes),
          });
        }),
      );
    }
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    const text = message.text();
    if (
      renderer === "webgpu" &&
      text === C12_29_S5_REPLACEMENT_CONFIG.recoveryIntervalBeginMarker
    ) {
      recoveryConsoleInterval.beginCount++;
      if (recoveryConsoleInterval.openAtEnd) {
        consoleErrors.push("duplicate recovery-console interval begin marker");
      }
      recoveryConsoleInterval.openAtEnd = true;
      return;
    }
    if (
      renderer === "webgpu" &&
      text === C12_29_S5_REPLACEMENT_CONFIG.recoveryIntervalEndMarker
    ) {
      recoveryConsoleInterval.endCount++;
      if (!recoveryConsoleInterval.openAtEnd) {
        consoleErrors.push("recovery-console interval ended while closed");
      }
      recoveryConsoleInterval.openAtEnd = false;
      return;
    }
    if (message.type() !== "error" && message.type() !== "warning") return;
    if (
      renderer === "webgpu" &&
      recoveryConsoleInterval.openAtEnd &&
      CONTEXT_DEVICE_LOSS_CONSOLE.test(text)
    ) {
      expectedRecoveryConsole.push(text);
    } else if (
      renderer === "webgpu" &&
      recoveryConsoleInterval.openAtEnd &&
      POOL_DEVICE_LOSS_CONSOLE.test(text)
    ) {
      expectedPoolRecoveryConsole.push(text);
    } else {
      // Every non-allowlisted error/warning is evidence. Silently filtering a
      // message by vocabulary would permit an unrelated runtime fault to pass.
      consoleErrors.push(`${message.type()}: ${text}`);
    }
  });
  let measured;
  let primaryError;
  let capturedProgress = null;
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
    if (renderer === "webgpu") await armWebGPUDevices(page);
    let pageTimeoutTimer = null;
    try {
      measured = await Promise.race([
        page.evaluate(
          MEASURE_C1229_S5_REPLACEMENT_SESSION,
          sessionContract(renderer, sessionId, captureSourceProof),
        ),
        new Promise((_, reject) => {
          pageTimeoutTimer = setTimeout(
            () =>
              reject(new Error(`${renderer} replacement-device page timeout`)),
            C12_29_S5_REPLACEMENT_CONFIG.pageTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (pageTimeoutTimer !== null) clearTimeout(pageTimeoutTimer);
    }
    capturedProgress = progressFrom(measured.progress, renderer);
    if (watchdogState?.current)
      watchdogState.current.pageProgress = capturedProgress;
  } catch (error) {
    primaryError = error;
    try {
      capturedProgress = progressFrom(
        await page.evaluate(
          () => globalThis.__c1229S5ReplacementProgress ?? null,
        ),
        renderer,
      );
      if (watchdogState?.current)
        watchdogState.current.pageProgress = capturedProgress;
    } catch {
      /* page may be gone */
    }
  }
  if (!primaryError) {
    try {
      await Promise.all(responseBodyTasks);
    } catch (error) {
      primaryError = asError(error, `${renderer} response-body capture failed`);
    }
  }
  if (!primaryError) {
    const beginEvent = attestationEvents[0];
    const finishEvent = attestationEvents.at(-1);
    if (
      beginEvent?.kind !== "begin" ||
      finishEvent?.kind !== "finish" ||
      finishEvent?.bodySha256 !== sha256(Buffer.from(JSON.stringify(measured)))
    ) {
      primaryError = new Error(
        `${renderer} replacement-device runtime attestation did not bind the returned body`,
      );
    }
  }
  let gate = { errors: [], deviceLost: null, armedDevices: 0 };
  if (!primaryError && renderer === "webgpu") {
    gate = await collectGateErrors(page);
    // D0 loss is expected and independently classified. The shared gate keeps
    // its first non-destroyed loss string; it is not an unexpected D1 loss.
    if (
      measured.classification === "eligible-replacement" &&
      gate.deviceLost ===
        `[replacement-${measured.ledgerWithSequence.devices[0].token}] device lost: reason=${measured.loss.reason} message=${measured.loss.message}`
    ) {
      gate.deviceLost = null;
    }
  }
  const pageClose = await closeBounded(page, `${renderer} page`);
  const contextClose = await closeBounded(
    browserContext,
    `${renderer} context`,
  );
  const runtime = {
    schema: C12_29_S5_REPLACEMENT_RUNTIME_DIAGNOSTICS_SCHEMA,
    renderer,
    pageErrors,
    consoleErrors,
    expectedRecoveryConsole,
    expectedPoolRecoveryConsole,
    recoveryConsoleInterval,
    gpuErrors: gate.errors,
    unexpectedDeviceLoss: gate.deviceLost,
    externalRequests,
    failedRequests,
    httpErrors,
    pendingRequests: pending.size,
    armedDevices: gate.armedDevices,
  };
  if (primaryError || !pageClose.closed || !contextClose.closed) {
    const errors = [
      primaryError,
      pageClose.timedOut
        ? new Error(`${renderer} page close timed out`)
        : pageClose.error,
      contextClose.timedOut
        ? new Error(`${renderer} context close timed out`)
        : contextClose.error,
    ]
      .filter(Boolean)
      .map((value) => asError(value, `${renderer} session failed`));
    const error =
      errors.length === 1
        ? errors[0]
        : new AggregateError(errors, `${renderer} session and cleanup failed`);
    const primaryTimedOut =
      Boolean(primaryError) && /timeout/iu.test(primaryError.message);
    const cleanupTimedOut = pageClose.timedOut || contextClose.timedOut;
    error.c1229Replacement = {
      stage: renderer === "webgl" ? "control-page" : "webgpu-page",
      phase: capturedProgress?.currentPhase ?? "preflight",
      renderer,
      kind:
        primaryTimedOut || cleanupTimedOut
          ? "timeout"
          : primaryError
            ? "exception"
            : "cleanup",
      timeoutMs: primaryTimedOut
        ? C12_29_S5_REPLACEMENT_CONFIG.pageTimeoutMs
        : cleanupTimedOut
          ? SESSION_CLOSE_TIMEOUT_MS
          : null,
      pageProgress: capturedProgress,
    };
    if (watchdogState) watchdogState.current = null;
    throw error;
  }
  enrichMeasurementImages(measured, runId, imageBytes);
  const runtimeIdentity = measured.runtimeIdentity;
  delete measured.runtimeIdentity;
  measured.runtime = runtime;
  measured.cleanup =
    renderer === "webgl"
      ? {
          complete:
            pageClose.closed && contextClose.closed && pending.size === 0,
          pageClosed: pageClose.closed,
          contextClosed: contextClose.closed,
          pendingRequestsDrained: pending.size === 0,
        }
      : {
          complete:
            pageClose.closed &&
            contextClose.closed &&
            pending.size === 0 &&
            measured.listenersRemoved,
          pageClosed: pageClose.closed,
          contextClosed: contextClose.closed,
          pendingRequestsDrained: pending.size === 0,
          listenersRemoved: measured.listenersRemoved,
        };
  delete measured.listenersRemoved;
  if (watchdogState) watchdogState.current = null;
  consumedResponses.sort(
    (left, right) =>
      C12_29_S5_REPLACEMENT_SERVED_FILES.indexOf(left.path) -
        C12_29_S5_REPLACEMENT_SERVED_FILES.indexOf(right.path) ||
      left.url.localeCompare(right.url),
  );
  return {
    measured,
    session: {
      sessionId,
      renderer,
      runtimeIdentity,
      responses: consumedResponses,
      attestation: {
        schema: C12_29_S5_REPLACEMENT_RUNTIME_ATTESTATION_SCHEMA,
        sessionId,
        renderer,
        installerSha256: C12_29_S5_REPLACEMENT_RUNTIME_ATTESTOR_SOURCE_SHA256,
        events: attestationEvents,
      },
    },
  };
}

export async function withC1229S5ReplacementWatchdog(
  operation,
  onTimeout,
  timeoutMs = WATCHDOG_MS,
) {
  let timer;
  let timingOut = false;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(operation)
        .then(
          (value) => (timingOut ? new Promise(() => {}) : value),
          (error) =>
            timingOut ? new Promise(() => {}) : Promise.reject(error),
        ),
      new Promise((_, reject) => {
        timer = setTimeout(async () => {
          timingOut = true;
          let cleanup;
          try {
            cleanup = await onTimeout();
          } catch (closeError) {
            const error = new AggregateError(
              [
                new Error(
                  `replacement-device watchdog expired after ${timeoutMs} ms`,
                ),
                closeError,
              ],
              "watchdog and browser close failed",
            );
            error.c1229Replacement = {
              stage: "watchdog",
              phase: "preflight",
              renderer: null,
              kind: "timeout",
              timeoutMs,
              pageProgress: null,
            };
            error.retainReplacementRunning = true;
            reject(error);
            return;
          }
          const checkpoint = cleanup?.checkpoint ?? null;
          const cleanupComplete = cleanup?.cleanupComplete === true;
          const error = new Error(
            cleanupComplete
              ? `replacement-device watchdog expired after ${timeoutMs} ms`
              : `replacement-device watchdog expired after ${timeoutMs} ms and cleanup remained unproven`,
          );
          error.c1229Replacement = checkpoint
            ? { ...checkpoint, kind: "timeout", timeoutMs }
            : {
                stage: "watchdog",
                phase: "preflight",
                renderer: null,
                kind: "timeout",
                timeoutMs,
                pageProgress: null,
              };
          if (!cleanupComplete) error.retainReplacementRunning = true;
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runC1229S5ReplacementDeviceProbe(options = {}) {
  const operations = options.operations ?? fs;
  const launchBrowser =
    options.launchBrowser ??
    ((launchOptions) => chromium.launch(launchOptions));
  // Q-116 — narrow test-only injection seam, mirroring `options.launchBrowser`
  // above and the `options.buildSourceMapPath` precedent in the multiview
  // probe's Q-99 fix. `collectProvenanceStart` reads the real served build,
  // the real source tree and (via `servedIdentity`) a real running dev
  // server, none of which a unit test controls; overriding it lets a test
  // exercise the refuse-vs-proceed branch below deterministically — with a
  // fabricated drifted or matching `{provenance, valid}` — without any of
  // those dependencies. Defaults to the real function, so every production
  // caller (including this file's own CLI `main()`) is unaffected.
  const collectProvenanceStartFn =
    options.collectProvenanceStart ?? collectProvenanceStart;
  // Q-116 — same rationale, for the step immediately after: proving the
  // POSITIVE path ("a matching preflight reaches the launch call") needs
  // `beginC1229S5ReplacementEvidenceRun` to succeed, which needs a provenance
  // object satisfying every field `validateC1229S5ReplacementPreflightProvenance`
  // checks (`localStart`/`served`/`sourceBoundaryStart`/... in the shape
  // `collectLocalFiles`/`servedIdentity`/a real dev server actually produce).
  // Overriding this narrow seam lets a test assert the CONTROL FLOW this fix
  // changes — refuse-vs-proceed — without also having to reconstruct that
  // unrelated, already-covered lock-acquisition machinery byte for byte.
  const beginEvidenceRunFn =
    options.beginC1229S5ReplacementEvidenceRun ??
    beginC1229S5ReplacementEvidenceRun;
  const runId = options.runId ?? randomUUID();
  const paths = createC1229S5ReplacementArtifactPaths(
    runId,
    options.outputDirectory,
  );
  const baseIdentity = validateC1229S5ReplacementLoopbackBase(
    options.base ?? defaultBase,
  );
  const captureSource = fs.readFileSync(probeSourcePath, "utf8");
  const captureAnalysis = analyzeC1229S5ReplacementCaptureSource(captureSource);
  if (!captureAnalysis.ok) {
    throw new Error(
      `replacement-device capture preflight failed: ${captureAnalysis.failures.join("; ")}`,
    );
  }
  const captureSourceProof = captureAnalysis.proof;
  const imageBytes = new Map();
  let ownership;
  let browser;
  let provenance;
  const watchdogState = { current: null };
  try {
    const launch = {
      channel: process.env.PROBE_BROWSER_CHANNEL || "msedge",
      headless: process.env.PROBE_HEADED !== "1",
      args: [C12_29_S5_REPLACEMENT_CONFIG.launchFlag],
    };
    const collected = await collectProvenanceStartFn(
      baseIdentity,
      launch,
      captureSourceProof,
    );
    if (!collected.valid.ok) {
      // Q-116 — the preflight itself refused: no run legitimately began
      // (see the comment on `collectProvenanceStart`'s return), so there is
      // no RUNNING lock to acquire or release for this exit and no browser
      // is launched. Write the refusal artifact + receipt and return —
      // `browser` stays `undefined`, so the `finally` below is a no-op, and
      // this `return` bypasses the generic `catch` entirely rather than
      // routing an invalid-preflight refusal through machinery built for
      // errors that occur AFTER a lock exists.
      const refusalArtifact = buildC1229S5ReplacementPreflightRefusalArtifact(
        runId,
        collected.provenance,
        collected.valid,
      );
      const publication = writeC1229S5ReplacementPreflightRefusal(
        paths,
        refusalArtifact,
        operations,
      );
      return {
        artifact: refusalArtifact,
        publication,
        paths,
        refused: true,
      };
    }
    provenance = collected.provenance;
    ownership = beginEvidenceRunFn(paths, runId, provenance, operations);
    const resumed = resumeC1229S5ReplacementEvidenceCandidate(
      paths,
      ownership,
      operations,
    );
    if (resumed) {
      return {
        ...resumed,
        paths,
        recoveredPublicationCandidate: true,
      };
    }
    try {
      browser = await launchBrowser({ ...launch });
    } catch (caught) {
      const error =
        caught instanceof Error ? caught : new Error(String(caught));
      error.c1229Replacement = {
        stage: "browser-launch",
        phase: "preflight",
        renderer: null,
        kind: "exception",
        timeoutMs: null,
        pageProgress: null,
      };
      throw error;
    }
    provenance.browser = {
      name: browser.browserType().name(),
      version: browser.version(),
    };
    const sessions = await withC1229S5ReplacementWatchdog(
      async () => {
        const control = await runBrowserSession(
          browser,
          "webgl",
          baseIdentity,
          watchdogState,
          runId,
          imageBytes,
          captureSourceProof,
        );
        const webgpu = await runBrowserSession(
          browser,
          "webgpu",
          baseIdentity,
          watchdogState,
          runId,
          imageBytes,
          captureSourceProof,
        );
        return { control, webgpu };
      },
      async () => {
        const checkpoint = await captureWatchdogCheckpoint(watchdogState);
        const pending = watchdogState.current?.pending;
        const closing = browser;
        browser = undefined;
        const closed = await closeBounded(
          closing,
          "watchdog browser",
          BROWSER_CLOSE_TIMEOUT_MS,
        );
        const pendingRequestsDrained = (pending?.size ?? 0) === 0;
        watchdogState.current = null;
        return {
          cleanupComplete: closed.closed && pendingRequestsDrained,
          checkpoint,
          closed,
          pendingRequestsDrained,
        };
      },
      options.watchdogMs ?? WATCHDOG_MS,
    );
    const closing = browser;
    browser = undefined;
    const browserClose = await closeBounded(
      closing,
      "replacement-device browser",
      BROWSER_CLOSE_TIMEOUT_MS,
    );
    if (!browserClose.closed) {
      const error = asError(
        browserClose.error,
        "replacement-device browser close timed out",
      );
      error.c1229Replacement = {
        stage: "node",
        phase: "preflight",
        renderer: null,
        kind: browserClose.timedOut ? "timeout" : "cleanup",
        timeoutMs: browserClose.timedOut ? BROWSER_CLOSE_TIMEOUT_MS : null,
        pageProgress: null,
      };
      error.retainReplacementRunning = true;
      throw error;
    }
    provenance.sessions = [sessions.control.session, sessions.webgpu.session];
    provenance.browserResponsesMatchLocal = true;
    finishProvenance(provenance);
    const report = {
      schema: C12_29_S5_REPLACEMENT_SCHEMA,
      runId,
      incomplete: false,
      contract: C12_29_S5_REPLACEMENT_CONTRACT,
      phaseOrder: [...C12_29_S5_REPLACEMENT_PHASES],
      provenance,
      control: sessions.control.measured,
      webgpu: sessions.webgpu.measured,
      cleanup: {
        complete:
          browserClose.closed &&
          sessions.control.measured.cleanup.complete &&
          sessions.webgpu.measured.cleanup.complete,
        browserClosed: browserClose.closed,
        contextsClosed:
          sessions.control.measured.cleanup.contextClosed &&
          sessions.webgpu.measured.cleanup.contextClosed,
        pagesClosed:
          sessions.control.measured.cleanup.pageClosed &&
          sessions.webgpu.measured.cleanup.pageClosed,
      },
    };
    const verdict = foldC1229S5ReplacementDeviceGate(report);
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
    const valid = validateC1229S5ReplacementFinalArtifact(artifact);
    if (!valid.ok)
      throw new Error(
        `replacement-device self-validation failed: ${valid.reasons.join("; ")}`,
      );
    const publication = finalizeC1229S5ReplacementEvidence(
      paths,
      artifact,
      ownership,
      imageBytes,
      operations,
    );
    return { artifact, publication, paths };
  } catch (caught) {
    let error = caught;
    if (browser) {
      const closing = browser;
      browser = undefined;
      const closed = await closeBounded(
        closing,
        "replacement-device error browser",
        BROWSER_CLOSE_TIMEOUT_MS,
      );
      if (!closed.closed) {
        const aggregate = new AggregateError(
          [error, closed.error ?? new Error("browser close timed out")],
          "probe and browser cleanup failed",
        );
        aggregate.c1229Replacement = error?.c1229Replacement ?? {
          stage: "node",
          phase: "preflight",
          renderer: null,
          kind: closed.timedOut ? "timeout" : "cleanup",
          timeoutMs: closed.timedOut ? BROWSER_CLOSE_TIMEOUT_MS : null,
          pageProgress: null,
        };
        aggregate.retainReplacementRunning = true;
        error = aggregate;
      }
    }
    if (ownership) {
      const resumed = resumeC1229S5ReplacementEvidenceCandidate(
        paths,
        ownership,
        operations,
      );
      if (resumed) {
        return {
          ...resumed,
          paths,
          recoveredPublicationError: error,
        };
      }
      const latestBytes = readBytesIfPresent(paths.latest, operations);
      if (latestBytes && !latestBytes.equals(ownership.runningBytes)) {
        let committed;
        try {
          committed = validateFinalBytes(
            latestBytes,
            paths.directory,
            operations,
            "possibly committed canonical latest",
          ).value;
        } catch {
          committed = undefined;
        }
        const committedPreflight =
          committed?.status === "ERROR"
            ? committed?.preflightSha256
            : committed?.provenance?.preflightSha256;
        if (
          committed?.runId === ownership.runId &&
          committedPreflight === ownership.preflightSha256
        ) {
          const publication = finalizeC1229S5ReplacementEvidence(
            paths,
            committed,
            ownership,
            imageBytes,
            operations,
          );
          return {
            artifact: committed,
            publication,
            paths,
            recoveredPublicationError: error,
          };
        }
      }
    }
    if (!ownership || error?.retainReplacementRunning) throw error;
    const detail = error.c1229Replacement ?? {};
    const rawMessage = String(error?.message ?? error ?? "");
    const boundedMessage =
      rawMessage.length > 0
        ? rawMessage.slice(0, 4096)
        : "Unknown replacement-device probe error";
    const diagnostics = createC1229S5ReplacementErrorDiagnostics({
      stage: detail.stage ?? "node",
      phase: detail.phase ?? "preflight",
      renderer: detail.renderer ?? null,
      kind: detail.kind ?? "exception",
      message: boundedMessage,
      stack:
        typeof error?.stack === "string" ? error.stack.slice(0, 16_384) : null,
      timeoutMs: detail.timeoutMs ?? null,
      pageProgress: detail.pageProgress ?? null,
    });
    const artifact = createC1229S5ReplacementErrorArtifact(
      runId,
      diagnostics,
      ownership.preflightSha256,
    );
    const publication = finalizeC1229S5ReplacementEvidence(
      paths,
      artifact,
      ownership,
      imageBytes,
      operations,
    );
    return { artifact, publication, paths, error };
  } finally {
    // Last-resort reclamation. Both paths above clear `browser` before handing
    // the handle to `closeBounded`, so this only runs when something left the
    // loop without doing either — the leak a `finally` is the only construct
    // that can cover.
    if (browser !== undefined) {
      try {
        await browser.close();
      } catch {
        // The verdict (or the primary error) is already decided and reported;
        // a failure here must not replace it.
      }
      browser = undefined;
    }
  }
}

function usage() {
  console.log(
    `Usage: node Tools/visual-regression/probe-c12-29-s5-replacement-device.mjs [--base URL] [--output-directory DIR] [--headed]\n\nRequires an already-running loopback server and a current Build/CesiumUnminified build.`,
  );
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const value = () => {
      const next = argv[++index];
      if (!next) throw new Error(`${argument} requires a value`);
      return next;
    };
    if (argument === "--base") options.base = value();
    else if (argument === "--output-directory")
      options.outputDirectory = path.resolve(value());
    else if (argument === "--headed") process.env.PROBE_HEADED = "1";
    else if (argument === "--help") {
      usage();
      process.exit(0);
    } else throw new Error(`unknown argument ${argument}`);
  }
  return options;
}

async function main() {
  // Terminating watchdog. `withC1229S5ReplacementWatchdog` only REJECTS the
  // task it wraps, which needs the event loop to come back to it; a wedged page
  // loop or an unresponsive GPU process never yields, so nothing but
  // `process.exit` ends the run. `unref` keeps the timer from extending a
  // healthy one.
  const processWatchdog = setTimeout(() => {
    console.error(
      `[probe-c12-29-s5-replacement-device] process watchdog fired after ` +
        `${PROCESS_WATCHDOG_MS} ms; the in-run watchdog did not settle`,
    );
    process.exit(2);
  }, PROCESS_WATCHDOG_MS);
  processWatchdog.unref?.();
  try {
    await runMain();
  } catch (error) {
    // An uncaught throw here is an environment or harness failure, never a
    // measured product miss; Node's default exit 1 would collide with the
    // FAIL tier, so route it to ERROR (2) explicitly.
    console.error(
      "[c12-29-s5-replacement] uncaught failure - exiting ERROR (2):",
      error,
    );
    process.exitCode = 2;
  } finally {
    clearTimeout(processWatchdog);
  }
}

async function runMain() {
  const result = await runC1229S5ReplacementDeviceProbe(
    parseArguments(process.argv.slice(2)),
  );
  console.log(
    JSON.stringify(
      {
        status: result.artifact.status,
        exitCode: result.artifact.exitCode,
        runId: result.artifact.runId,
        archive: result.publication.archive,
        sha256: result.publication.sha256,
      },
      null,
      2,
    ),
  );
  if (result.recoveredPublicationError) {
    console.error(
      "[c12-29-s5-replacement] committed verdict stands; the post-publication error was:",
      result.recoveredPublicationError,
    );
  }
  process.exitCode = exitCodeForC1229S5ReplacementStatus(
    result.artifact.status,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
