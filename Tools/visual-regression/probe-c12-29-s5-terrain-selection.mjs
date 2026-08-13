#!/usr/bin/env node
/**
 * C12-29 S5 real-terrain/selection browser acceptance.
 *
 * Runs serial WebGL and WebGPU sessions over the local QuantizedMesh fixture.
 * Each session proves an ellipsoid control, first-beginFrame provider reset,
 * an actual single-held-request TerrainFillMesh, fill-to-real transition,
 * exact x2 radius law, real awaited async picking, and a fresh-provider reset.
 * WebGPU
 * additionally drives retained six-face capture through a tiny Model's normal
 * DynamicEnvironmentMapManager update; WebGL records that phase as N/A.
 *
 * Requires a current local build and an already-running loopback server. This
 * probe does not build, start infrastructure, or publish outside its output
 * directory.
 */

import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium } from "playwright";
import sharp from "sharp";

import {
  C12_29_S5_BUILD_SOURCE_FILES,
  C12_29_S5_CAPTURE_LABELS,
  C12_29_S5_CAPTURE_METHOD,
  C12_29_S5_DIAGNOSTICS_SCHEMA,
  C12_29_S5_FIXTURE,
  C12_29_S5_PHASES,
  C12_29_S5_PICK_FRAME_DRIVER,
  C12_29_S5_PICK_MAX_PUMP_FRAMES,
  C12_29_S5_RADIUS_LAW,
  C12_29_S5_RENDERERS,
  C12_29_S5_SCENE,
  C12_29_S5_SCHEMA,
  C12_29_S5_SOURCE_FILES,
  C12_29_S5_WEBGPU_ECLIPSE_BINDING,
  C12_29_S5_WEBGPU_LAYOUT_FILE,
  C12_29_S5_WEBGPU_PREWARM_MAX_FRAMES,
  exitCodeForS5Status,
  foldC1229S5Gate,
  isUuidV4,
  validateS5FinalArtifactShape,
  validateS5PageProgress,
} from "./lib/c12-29-s5-terrain-selection-gate.mjs";
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

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(toolDirectory, "../..");
const probePath = fileURLToPath(import.meta.url);
const gateHelperPath = fileURLToPath(
  new URL("./lib/c12-29-s5-terrain-selection-gate.mjs", import.meta.url),
);
const specPath = path.join(
  toolDirectory,
  "c12-29-s5-terrain-selection-gate.spec.mjs",
);
const identityHelperPath = fileURLToPath(
  new URL("./lib/build-source-identity.mjs", import.meta.url),
);
const buildEntryPath = path.join(
  repositoryRoot,
  "Build/CesiumUnminified/index.js",
);
const buildSourceMapPath = `${buildEntryPath}.map`;
const webgpuLayoutPath = path.join(
  repositoryRoot,
  C12_29_S5_WEBGPU_LAYOUT_FILE,
);
const outputDirectory = path.resolve(
  process.env.C12_29_S5_OUTPUT_DIR ??
    path.join(toolDirectory, "output/c12-29-s5-terrain-selection"),
);
const artifactPrefix = "campaign12-c12-29-s5-terrain-selection";
const base = process.env.PROBE_BASE ?? "http://localhost:8080";
const runtimePath = "/Build/CesiumUnminified/index.js";
const viewerPath = "/Apps/CesiumViewer/index.html";
const WATCHDOG_MS = 540_000;
const PAGE_TIMEOUT_MS = 240_000;
const WATCHDOG_DRAIN_MS = 30_000;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function validateS5LoopbackBase(value) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`S5 base is not an absolute URL: ${error.message}`, {
      cause: error,
    });
  }
  const bracketed = url.hostname.toLowerCase();
  const hostname =
    bracketed.startsWith("[") && bracketed.endsWith("]")
      ? bracketed.slice(1, -1)
      : bracketed;
  if (
    !new Set(["http:", "https:"]).has(url.protocol) ||
    !new Set(["localhost", "127.0.0.1", "::1"]).has(hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !new Set(["", "/"]).has(url.pathname)
  ) {
    throw new Error(
      "S5 base must be credential-free, query-free HTTP(S) on a loopback host",
    );
  }
  return Object.freeze({ href: url.href, origin: url.origin, hostname });
}

export function createS5ArtifactPaths(runId, directory = outputDirectory) {
  if (!isUuidV4(runId)) throw new Error("S5 artifact paths require UUID v4");
  return Object.freeze({
    directory,
    lock: path.join(directory, `${artifactPrefix}.lock.json`),
    latest: path.join(directory, `${artifactPrefix}.latest.json`),
    firstRed: path.join(directory, `${artifactPrefix}.first-red.json`),
    run: path.join(directory, `${runId}.json`),
    recoveryLatest: path.join(
      directory,
      `${runId}.publication-recovery-latest.json`,
    ),
  });
}

function redactQueriesInString(value) {
  const withoutCredentials = value.replace(
    /(https?:\/\/)[^\s/@]+@/giu,
    "$1[REDACTED]@",
  );
  return withoutCredentials
    .replace(/\?([^\s#"'<>]*)/gu, (_match, query) => {
      if (query.length === 0) return "?";
      return `?${query
        .split("&")
        .map((field) => {
          if (field.length === 0) return field;
          const equals = field.indexOf("=");
          const name = equals < 0 ? field : field.slice(0, equals);
          return `${name}=[REDACTED]`;
        })
        .join("&")}`;
    })
    .replace(/#([^\s"'<>]*)/gu, (match, fragment) =>
      fragment.length === 0 ? match : "#[REDACTED]",
    );
}

export function redactS5OutputPayload(value) {
  if (typeof value === "string") return redactQueriesInString(value);
  if (Array.isArray(value)) return value.map(redactS5OutputPayload);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactS5OutputPayload(entry),
      ]),
    );
  }
  return value;
}

export const serializeS5Artifact = (value) =>
  `${JSON.stringify(redactS5OutputPayload(value), null, 2)}\n`;

function cloneS5DiagnosticValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(redactS5OutputPayload(value)));
}

export async function awaitS5PageMeasurement(options) {
  const renderer = options?.renderer;
  const timeoutMs = options?.timeoutMs ?? PAGE_TIMEOUT_MS;
  const diagnosticReadTimeoutMs = options?.diagnosticReadTimeoutMs ?? 2_000;
  if (
    !C12_29_S5_RENDERERS.includes(renderer) ||
    typeof options?.measure !== "function" ||
    !(timeoutMs > 0) ||
    !(diagnosticReadTimeoutMs > 0)
  ) {
    throw new Error("S5 page measurement options are invalid");
  }

  const measurement = Promise.resolve()
    .then(options.measure)
    .then(
      (value) => ({ status: "fulfilled", value }),
      (error) => ({ status: "rejected", error }),
    );
  let timeoutTimer;
  const timeout = new Promise((resolve) => {
    timeoutTimer = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
  });
  try {
    const outcome = await Promise.race([measurement, timeout]);
    if (outcome.status === "fulfilled") return outcome.value;
    if (outcome.status === "rejected") throw outcome.error;

    let readTimer;
    const pageRead =
      typeof options?.readPageDiagnostics === "function"
        ? Promise.resolve()
            .then(options.readPageDiagnostics)
            .then(
              (value) => ({ status: "fulfilled", value }),
              (error) => ({
                status: "rejected",
                error: error?.message ?? String(error),
              }),
            )
        : Promise.resolve({ status: "unavailable" });
    const readTimeout = new Promise((resolve) => {
      readTimer = setTimeout(
        () => resolve({ status: "timeout" }),
        diagnosticReadTimeoutMs,
      );
    });
    let pageOutcome;
    try {
      pageOutcome = await Promise.race([pageRead, readTimeout]);
    } finally {
      clearTimeout(readTimer);
    }
    const validPage =
      pageOutcome.status === "fulfilled" &&
      validateS5PageProgress(pageOutcome.value, renderer).ok;
    const node = cloneS5DiagnosticValue(options?.nodeDiagnostics) ?? {
      stage: "page-measurement",
    };
    node.diagnosticRead = validPage
      ? "fulfilled"
      : pageOutcome.status === "fulfilled"
        ? "invalid"
        : pageOutcome.status;
    if (pageOutcome.status === "rejected") {
      node.diagnosticReadError = pageOutcome.error;
    }
    const error = new Error(`${renderer} S5 page timeout`);
    error.code = "S5_PAGE_TIMEOUT";
    error.s5Diagnostics = {
      schema: C12_29_S5_DIAGNOSTICS_SCHEMA,
      renderer,
      stage: "page-measurement-timeout",
      timeoutMs,
      node,
      page: validPage ? cloneS5DiagnosticValue(pageOutcome.value) : null,
    };
    throw error;
  } finally {
    clearTimeout(timeoutTimer);
  }
}

async function snapshotS5PageProgress(page, renderer, timeoutMs = 2_000) {
  const read = Promise.resolve()
    .then(() => page.evaluate(() => globalThis.__c1229S5Progress ?? null))
    .then(
      (value) => ({ status: "fulfilled", value }),
      (error) => ({
        status: "rejected",
        error: error?.message ?? String(error),
      }),
    );
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
  });
  try {
    const outcome = await Promise.race([read, timeout]);
    return outcome.status === "fulfilled" &&
      validateS5PageProgress(outcome.value, renderer).ok
      ? { status: "fulfilled", page: cloneS5DiagnosticValue(outcome.value) }
      : { status: outcome.status, page: null, error: outcome.error };
  } finally {
    clearTimeout(timer);
  }
}

export function inspectS5QuantizedMeshHeader(
  file = path.join(repositoryRoot, C12_29_S5_FIXTURE.tile.file),
  operations = fs,
) {
  const pin = C12_29_S5_FIXTURE.tile.quantizedMeshHeader;
  try {
    const loaded = operations.readFileSync(file);
    const bytes = Buffer.isBuffer(loaded) ? loaded : Buffer.from(loaded);
    const minimumHeight = bytes.readFloatLE(pin.minimumHeightByteOffset);
    const maximumHeight = bytes.readFloatLE(pin.maximumHeightByteOffset);
    return {
      ok:
        Object.is(minimumHeight, pin.minimumHeight) &&
        Object.is(maximumHeight, pin.maximumHeight),
      byteOrder: pin.byteOrder,
      minimumHeightByteOffset: pin.minimumHeightByteOffset,
      maximumHeightByteOffset: pin.maximumHeightByteOffset,
      minimumHeight,
      maximumHeight,
    };
  } catch (error) {
    return {
      ok: false,
      byteOrder: pin.byteOrder,
      minimumHeightByteOffset: pin.minimumHeightByteOffset,
      maximumHeightByteOffset: pin.maximumHeightByteOffset,
      minimumHeight: null,
      maximumHeight: null,
      error: error?.message ?? String(error),
    };
  }
}

export function inspectS5WebGPUEclipseBinding(
  file = webgpuLayoutPath,
  operations = fs,
) {
  try {
    const source = operations.readFileSync(file, "utf8");
    const exactMarkers =
      source.match(
        /uniformBuffer\(2, Stage\.FRAGMENT, \{\s*hasDynamicOffset: true,\s*minBindingSize: ECLIPSE_UNIFORM_BYTES,\s*\}\)/gu,
      ) ?? [];
    return {
      ok: exactMarkers.length === 1,
      file: C12_29_S5_WEBGPU_LAYOUT_FILE,
      binding: C12_29_S5_WEBGPU_ECLIPSE_BINDING,
      stage: "FRAGMENT",
      hasDynamicOffset: true,
      minimumSizeSymbol: "ECLIPSE_UNIFORM_BYTES",
      exactMarkerCount: exactMarkers.length,
    };
  } catch (error) {
    return {
      ok: false,
      file: C12_29_S5_WEBGPU_LAYOUT_FILE,
      binding: C12_29_S5_WEBGPU_ECLIPSE_BINDING,
      stage: "FRAGMENT",
      hasDynamicOffset: true,
      minimumSizeSymbol: "ECLIPSE_UNIFORM_BYTES",
      exactMarkerCount: 0,
      error: error?.message ?? String(error),
    };
  }
}

function readJsonIfPresent(file, operations = fs) {
  try {
    return JSON.parse(operations.readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function assertExactEvidenceBytes(file, expectedBytes, label, operations = fs) {
  const expected = Buffer.from(expectedBytes);
  const actual = operations.readFileSync(file);
  const actualBytes = Buffer.isBuffer(actual) ? actual : Buffer.from(actual);
  if (!actualBytes.equals(expected)) {
    throw new Error(`${label} bytes differ from the canonical serialization`);
  }
  return actualBytes;
}

function sameEvidenceFingerprint(left, right) {
  return (
    left?.exists === right?.exists &&
    left?.byteLength === right?.byteLength &&
    left?.sha256 === right?.sha256 &&
    left?.error === right?.error
  );
}

function describeS5RecoveryError(error) {
  return error?.message ?? String(error);
}

function aggregateS5RecoveryErrors(label, errors) {
  const failures = errors.length > 0 ? errors : [new Error(`${label} failed`)];
  return new AggregateError(
    failures,
    `${label}: ${failures.map(describeS5RecoveryError).join(" | ")}`,
  );
}

function restoreS5ClaimedEvidence(
  canonicalPath,
  claimedBytes,
  label,
  operations,
) {
  try {
    operations.writeFileSync(canonicalPath, claimedBytes, { flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  assertExactEvidenceBytes(canonicalPath, claimedBytes, label, operations);
}

function claimS5OwnedCanonicalLatest(
  paths,
  expectedLatestBytes,
  lockBytes,
  receiptTag,
  label,
  operations,
) {
  const expected = Buffer.from(expectedLatestBytes);
  const receipt = `${paths.latest}.${receiptTag}-${randomUUID()}.receipt`;
  assertExactEvidenceBytes(
    paths.lock,
    lockBytes,
    `${label} owned RUNNING lock before claim`,
    operations,
  );
  assertExactEvidenceBytes(
    paths.latest,
    expected,
    `${label} canonical latest before claim`,
    operations,
  );
  assertExactEvidenceBytes(
    paths.lock,
    lockBytes,
    `${label} owned RUNNING lock at claim`,
    operations,
  );

  let renameError;
  try {
    // The unique receipt claims whichever directory entry is canonical at the
    // mutation instant. Exact inspection below distinguishes owned bytes from
    // a late foreign pair before anything can be discarded.
    operations.renameSync(paths.latest, receipt);
  } catch (error) {
    renameError = error;
  }

  let claimedBytes;
  try {
    const value = operations.readFileSync(receipt);
    claimedBytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  } catch (claimError) {
    if (renameError !== undefined && claimError?.code === "ENOENT") {
      throw renameError;
    }
    throw new AggregateError(
      [renameError, claimError].filter(Boolean),
      `${label} claim could not be inspected`,
      { cause: claimError },
    );
  }

  const restoreClaim = (reason) => {
    try {
      // Exclusive restoration preserves a late canonical replacement. If it
      // already exists, exact comparison accepts only the same claimed bytes.
      restoreS5ClaimedEvidence(
        paths.latest,
        claimedBytes,
        `${label} claimed latest restored after failed claim`,
        operations,
      );
    } catch (restoreError) {
      throw new AggregateError(
        [reason, restoreError],
        `${label} claim failed and its exact latest could not be restored`,
        { cause: restoreError },
      );
    }
    throw reason;
  };

  if (!claimedBytes.equals(expected)) {
    restoreClaim(new Error(`${label} claim captured foreign canonical latest`));
  }
  if (renameError !== undefined) {
    restoreClaim(renameError);
  }

  try {
    assertExactEvidenceBytes(
      paths.lock,
      lockBytes,
      `${label} owned RUNNING lock after claim`,
      operations,
    );
    const canonicalAfterClaim = fingerprintEvidenceFile(
      paths.latest,
      operations,
    );
    assertEvidenceReadableOrAbsent(
      canonicalAfterClaim,
      `${label} canonical latest after claim`,
    );
    if (
      canonicalAfterClaim.exists !== false ||
      canonicalAfterClaim.error !== "ENOENT"
    ) {
      throw new Error(`${label} canonical latest was occupied after claim`);
    }
    assertExactEvidenceBytes(
      receipt,
      expected,
      `${label} exact retained claim receipt`,
      operations,
    );
    assertExactEvidenceBytes(
      paths.lock,
      lockBytes,
      `${label} owned RUNNING lock at claim outcome`,
      operations,
    );
  } catch (error) {
    restoreClaim(error);
  }
  return { receipt, claimedBytes };
}

function publishS5OwnedRunningLatest(
  paths,
  priorFingerprint,
  runningBytes,
  lockBytes,
  operations,
) {
  assertEvidenceReadableOrAbsent(
    priorFingerprint,
    "S5 prior latest at RUNNING publication",
  );
  assertExactEvidenceBytes(
    paths.lock,
    lockBytes,
    "S5 owned RUNNING lock before canonical RUNNING publication",
    operations,
  );
  const canonicalBeforeClaim = fingerprintEvidenceFile(
    paths.latest,
    operations,
  );
  assertEvidenceReadableOrAbsent(
    canonicalBeforeClaim,
    "S5 canonical latest before RUNNING publication claim",
  );
  if (!sameEvidenceFingerprint(priorFingerprint, canonicalBeforeClaim)) {
    throw new Error("S5 latest changed before canonical RUNNING publication");
  }
  assertExactEvidenceBytes(
    paths.lock,
    lockBytes,
    "S5 owned RUNNING lock at canonical RUNNING publication claim",
    operations,
  );

  if (priorFingerprint.exists === false) {
    createImmutableEvidence(paths.latest, runningBytes, operations);
    assertExactEvidenceBytes(
      paths.latest,
      runningBytes,
      "S5 canonical RUNNING latest after exclusive creation",
      operations,
    );
    assertExactEvidenceBytes(
      paths.lock,
      lockBytes,
      "S5 owned RUNNING lock after exclusive RUNNING creation",
      operations,
    );
    return;
  }

  const receipt = `${paths.latest}.running-replace-${randomUUID()}.receipt`;
  let renameError;
  try {
    // Claim the exact prior directory entry before creating RUNNING. A late
    // competing owner can occupy the canonical path, but exclusive creation
    // and receipt inspection prevent this invocation from overwriting it.
    operations.renameSync(paths.latest, receipt);
  } catch (error) {
    renameError = error;
  }
  let claimedBytes;
  try {
    const value = operations.readFileSync(receipt);
    claimedBytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  } catch (claimError) {
    if (renameError !== undefined && claimError?.code === "ENOENT") {
      throw renameError;
    }
    throw new AggregateError(
      [renameError, claimError].filter(Boolean),
      "S5 prior latest RUNNING publication claim could not be inspected",
      { cause: claimError },
    );
  }
  const claimedFingerprint = {
    exists: true,
    byteLength: claimedBytes.byteLength,
    sha256: sha256(claimedBytes),
  };
  if (!sameEvidenceFingerprint(priorFingerprint, claimedFingerprint)) {
    const ownershipError = new Error(
      "S5 RUNNING publication claimed foreign canonical latest bytes",
    );
    try {
      restoreS5ClaimedEvidence(
        paths.latest,
        claimedBytes,
        "S5 foreign canonical latest restored after RUNNING claim",
        operations,
      );
    } catch (restoreError) {
      throw new AggregateError(
        [ownershipError, restoreError],
        "S5 foreign canonical latest RUNNING claim could not be restored",
        { cause: restoreError },
      );
    }
    throw ownershipError;
  }
  if (renameError !== undefined) {
    try {
      restoreS5ClaimedEvidence(
        paths.latest,
        claimedBytes,
        "S5 prior latest restored after ambiguous RUNNING claim",
        operations,
      );
    } catch (restoreError) {
      throw new AggregateError(
        [renameError, restoreError],
        "S5 RUNNING latest claim failed and prior latest could not be restored",
        { cause: restoreError },
      );
    }
    throw renameError;
  }

  assertExactEvidenceBytes(
    paths.lock,
    lockBytes,
    "S5 owned RUNNING lock after prior latest claim",
    operations,
  );
  const canonicalBeforeCreate = fingerprintEvidenceFile(
    paths.latest,
    operations,
  );
  assertEvidenceReadableOrAbsent(
    canonicalBeforeCreate,
    "S5 canonical latest before exclusive RUNNING creation",
  );
  if (
    canonicalBeforeCreate.exists !== false ||
    canonicalBeforeCreate.error !== "ENOENT"
  ) {
    throw new Error(
      "S5 canonical latest was occupied after the prior latest claim",
    );
  }
  assertExactEvidenceBytes(
    paths.lock,
    lockBytes,
    "S5 owned RUNNING lock at exclusive RUNNING creation",
    operations,
  );
  createImmutableEvidence(paths.latest, runningBytes, operations);
  assertExactEvidenceBytes(
    paths.latest,
    runningBytes,
    "S5 canonical RUNNING latest after exclusive replacement",
    operations,
  );
  assertExactEvidenceBytes(
    receipt,
    claimedBytes,
    "S5 claimed prior latest RUNNING publication receipt",
    operations,
  );
  assertExactEvidenceBytes(
    paths.lock,
    lockBytes,
    "S5 owned RUNNING lock after exclusive RUNNING replacement",
    operations,
  );

  operations.unlinkSync(receipt);
  const receiptAfterDelete = fingerprintEvidenceFile(receipt, operations);
  assertEvidenceReadableOrAbsent(
    receiptAfterDelete,
    "S5 deleted prior latest RUNNING publication receipt",
  );
  if (
    receiptAfterDelete.exists !== false ||
    receiptAfterDelete.error !== "ENOENT"
  ) {
    throw new Error("S5 prior latest RUNNING publication receipt still exists");
  }
  assertExactEvidenceBytes(
    paths.latest,
    runningBytes,
    "S5 canonical RUNNING latest after prior receipt deletion",
    operations,
  );
  assertExactEvidenceBytes(
    paths.lock,
    lockBytes,
    "S5 owned RUNNING lock after canonical RUNNING publication",
    operations,
  );
}

function releaseS5OwnedRunningLock(paths, lockBytes, operations) {
  assertExactEvidenceBytes(
    paths.lock,
    lockBytes,
    "S5 owned RUNNING lock before release claim",
    operations,
  );
  const receipt = `${paths.lock}.lock-release-${randomUUID()}.receipt`;
  let renameError;
  try {
    // Rename atomically claims the directory entry that is canonical at the
    // release instant. A late owner can replace the canonical pathname, but it
    // can never make this invocation unlink those foreign bytes by name.
    operations.renameSync(paths.lock, receipt);
  } catch (error) {
    renameError = error;
  }

  let claimedBytes;
  try {
    const value = operations.readFileSync(receipt);
    claimedBytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  } catch (claimError) {
    if (renameError !== undefined && claimError?.code === "ENOENT") {
      throw renameError;
    }
    throw new AggregateError(
      [renameError, claimError].filter(Boolean),
      "S5 RUNNING lock release claim could not be inspected",
      { cause: claimError },
    );
  }

  const expected = Buffer.from(lockBytes);
  if (!claimedBytes.equals(expected)) {
    const ownershipError = new Error(
      "S5 RUNNING lock release claim captured foreign authority",
    );
    try {
      restoreS5ClaimedEvidence(
        paths.lock,
        claimedBytes,
        "S5 foreign RUNNING lock restored after release claim",
        operations,
      );
    } catch (restoreError) {
      throw new AggregateError(
        [ownershipError, restoreError],
        "S5 foreign RUNNING lock release claim could not be restored",
        { cause: restoreError },
      );
    }
    throw ownershipError;
  }

  if (renameError !== undefined) {
    try {
      restoreS5ClaimedEvidence(
        paths.lock,
        expected,
        "S5 owned RUNNING lock restored after ambiguous release claim",
        operations,
      );
    } catch (restoreError) {
      throw new AggregateError(
        [renameError, restoreError],
        "S5 RUNNING lock release claim failed and ownership could not be restored",
        { cause: restoreError },
      );
    }
    throw renameError;
  }

  const canonicalBeforeDelete = fingerprintEvidenceFile(paths.lock, operations);
  assertEvidenceReadableOrAbsent(
    canonicalBeforeDelete,
    "S5 canonical RUNNING lock after release claim",
  );
  if (
    canonicalBeforeDelete.exists !== false ||
    canonicalBeforeDelete.error !== "ENOENT"
  ) {
    throw new Error(
      "S5 new canonical RUNNING lock authority appeared during release",
    );
  }

  try {
    operations.unlinkSync(receipt);
  } catch (error) {
    try {
      restoreS5ClaimedEvidence(
        paths.lock,
        expected,
        "S5 owned RUNNING lock restored after receipt deletion failure",
        operations,
      );
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        "S5 RUNNING lock receipt deletion failed and ownership could not be restored",
        { cause: restoreError },
      );
    }
    throw error;
  }

  const receiptAfterDelete = fingerprintEvidenceFile(receipt, operations);
  const canonicalAfterDelete = fingerprintEvidenceFile(paths.lock, operations);
  assertEvidenceReadableOrAbsent(
    receiptAfterDelete,
    "S5 deleted RUNNING lock release receipt",
  );
  assertEvidenceReadableOrAbsent(
    canonicalAfterDelete,
    "S5 released canonical RUNNING lock",
  );
  if (
    receiptAfterDelete.exists !== false ||
    receiptAfterDelete.error !== "ENOENT" ||
    canonicalAfterDelete.exists !== false ||
    canonicalAfterDelete.error !== "ENOENT"
  ) {
    try {
      restoreS5ClaimedEvidence(
        paths.lock,
        expected,
        "S5 owned RUNNING lock restored after unverifiable release",
        operations,
      );
    } catch (restoreError) {
      throw new Error(
        "S5 RUNNING lock release could not prove canonical and receipt absence",
        { cause: restoreError },
      );
    }
    throw new Error(
      "S5 RUNNING lock release could not prove canonical and receipt absence; ownership restored",
    );
  }
}

function publishS5OwnedFinalLatest(
  paths,
  runningBytes,
  finalBytes,
  lockBytes,
  operations,
) {
  const receipt = `${paths.latest}.final-replace-${randomUUID()}.receipt`;
  assertExactEvidenceBytes(
    paths.lock,
    lockBytes,
    "S5 owned RUNNING lock before final latest claim",
    operations,
  );
  assertExactEvidenceBytes(
    paths.latest,
    runningBytes,
    "S5 owned canonical RUNNING latest before final claim",
    operations,
  );
  assertExactEvidenceBytes(
    paths.lock,
    lockBytes,
    "S5 owned RUNNING lock at final latest claim",
    operations,
  );

  let renameError;
  try {
    // Claim the exact RUNNING directory entry before creating the final name.
    // The final create is exclusive, so a late foreign latest is preserved
    // instead of being overwritten by a replacement rename.
    operations.renameSync(paths.latest, receipt);
  } catch (error) {
    renameError = error;
  }
  let claimedBytes;
  try {
    const value = operations.readFileSync(receipt);
    claimedBytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  } catch (claimError) {
    if (renameError !== undefined && claimError?.code === "ENOENT") {
      throw renameError;
    }
    throw new AggregateError(
      [renameError, claimError].filter(Boolean),
      "S5 canonical RUNNING latest claim could not be inspected",
      { cause: claimError },
    );
  }
  const expectedRunning = Buffer.from(runningBytes);
  if (!claimedBytes.equals(expectedRunning)) {
    const ownershipError = new Error(
      "S5 final publication claimed foreign canonical latest bytes",
    );
    try {
      restoreS5ClaimedEvidence(
        paths.latest,
        claimedBytes,
        "S5 foreign canonical latest restored after final claim",
        operations,
      );
    } catch (restoreError) {
      throw new AggregateError(
        [ownershipError, restoreError],
        "S5 foreign canonical latest claim could not be restored",
        { cause: restoreError },
      );
    }
    throw ownershipError;
  }
  if (renameError !== undefined) {
    try {
      restoreS5ClaimedEvidence(
        paths.latest,
        expectedRunning,
        "S5 canonical RUNNING latest restored after ambiguous final claim",
        operations,
      );
    } catch (restoreError) {
      throw new AggregateError(
        [renameError, restoreError],
        "S5 final latest claim failed and RUNNING could not be restored",
        { cause: restoreError },
      );
    }
    throw renameError;
  }

  assertExactEvidenceBytes(
    paths.lock,
    lockBytes,
    "S5 owned RUNNING lock after final latest claim",
    operations,
  );
  const canonicalBeforeCreate = fingerprintEvidenceFile(
    paths.latest,
    operations,
  );
  assertEvidenceReadableOrAbsent(
    canonicalBeforeCreate,
    "S5 canonical latest before exclusive final creation",
  );
  if (
    canonicalBeforeCreate.exists !== false ||
    canonicalBeforeCreate.error !== "ENOENT"
  ) {
    throw new Error(
      "S5 canonical latest was occupied after the owned RUNNING claim",
    );
  }
  assertExactEvidenceBytes(
    paths.lock,
    lockBytes,
    "S5 owned RUNNING lock at exclusive final creation",
    operations,
  );
  createImmutableEvidence(paths.latest, finalBytes, operations);
  assertExactEvidenceBytes(
    paths.latest,
    finalBytes,
    "S5 canonical final latest",
    operations,
  );
  assertExactEvidenceBytes(
    receipt,
    expectedRunning,
    "S5 claimed canonical RUNNING latest receipt",
    operations,
  );
  assertExactEvidenceBytes(
    paths.lock,
    lockBytes,
    "S5 owned RUNNING lock after exclusive final creation",
    operations,
  );

  operations.unlinkSync(receipt);
  const receiptAfterDelete = fingerprintEvidenceFile(receipt, operations);
  assertEvidenceReadableOrAbsent(
    receiptAfterDelete,
    "S5 deleted canonical RUNNING latest receipt",
  );
  if (
    receiptAfterDelete.exists !== false ||
    receiptAfterDelete.error !== "ENOENT"
  ) {
    throw new Error("S5 canonical RUNNING latest receipt still exists");
  }
  assertExactEvidenceBytes(
    paths.latest,
    finalBytes,
    "S5 canonical final latest after receipt deletion",
    operations,
  );
  assertExactEvidenceBytes(
    paths.lock,
    lockBytes,
    "S5 owned RUNNING lock after final latest publication",
    operations,
  );
}

function recoverS5OwnedRunningLock(paths, lockBytes, operations) {
  const errors = [];
  let before;
  try {
    before = fingerprintEvidenceFile(paths.lock, operations);
    assertEvidenceReadableOrAbsent(before, "S5 RUNNING lock at recovery");
  } catch (error) {
    errors.push(error);
    return {
      ok: false,
      method: "inspection-failed",
      lockAbsenceVerified: false,
      error: aggregateS5RecoveryErrors(
        "S5 owned RUNNING lock recovery failed",
        errors,
      ),
    };
  }

  if (before.exists === false && before.error === "ENOENT") {
    try {
      createImmutableEvidence(paths.lock, lockBytes, operations);
    } catch (error) {
      // A wrapper may throw after creating the file. Exact verification below,
      // rather than the call's return path, decides whether lock authority was
      // actually recovered.
      errors.push(error);
    }
  }

  try {
    assertExactEvidenceBytes(
      paths.lock,
      lockBytes,
      "S5 recovered owned RUNNING lock",
      operations,
    );
    return {
      ok: true,
      method: before.exists === true ? "retained" : "recreated",
      lockAbsenceVerified: false,
      recoveredErrors: errors,
    };
  } catch (error) {
    errors.push(error);
    let lockAbsenceVerified = false;
    try {
      const after = fingerprintEvidenceFile(paths.lock, operations);
      assertEvidenceReadableOrAbsent(after, "S5 RUNNING lock after recovery");
      lockAbsenceVerified = after.exists === false && after.error === "ENOENT";
    } catch (inspectionError) {
      errors.push(inspectionError);
    }
    return {
      ok: false,
      method: before.exists === true ? "retention-failed" : "recreate-failed",
      lockAbsenceVerified,
      error: aggregateS5RecoveryErrors(
        "S5 owned RUNNING lock recovery failed",
        errors,
      ),
    };
  }
}

function recoverS5CanonicalRunningLatest(
  paths,
  runningBytes,
  lockBytes,
  operations,
  hasOwnedLockAuthority,
) {
  const errors = [];
  if (!hasOwnedLockAuthority) {
    try {
      assertExactEvidenceBytes(
        paths.latest,
        runningBytes,
        "S5 existing canonical RUNNING latest without owned lock authority",
        operations,
      );
      return { ok: true, method: "verified-existing" };
    } catch (error) {
      errors.push(error);
      errors.push(
        new Error(
          "S5 canonical latest replacement requires the exact owned RUNNING lock",
        ),
      );
      return {
        ok: false,
        method: "verify-only-without-owned-lock",
        error: aggregateS5RecoveryErrors(
          "S5 canonical RUNNING latest recovery failed",
          errors,
        ),
      };
    }
  }
  const expectedRunning = Buffer.from(runningBytes);
  for (let attempt = 1; attempt <= 2; attempt++) {
    const receipt = `${paths.latest}.running-recovery-${randomUUID()}.receipt`;
    let claimedBytes;
    let runningCreated = false;
    try {
      assertExactEvidenceBytes(
        paths.lock,
        lockBytes,
        `S5 owned RUNNING lock before latest recovery attempt ${attempt}`,
        operations,
      );
      const canonical = fingerprintEvidenceFile(paths.latest, operations);
      assertEvidenceReadableOrAbsent(
        canonical,
        `S5 canonical latest before recovery attempt ${attempt}`,
      );

      if (canonical.exists === true) {
        let renameError;
        try {
          // Claim the exact canonical directory entry before recreating
          // RUNNING. A late competitor can occupy the canonical pathname, but
          // exclusive creation below can never overwrite its matching latest.
          operations.renameSync(paths.latest, receipt);
        } catch (error) {
          renameError = error;
        }
        try {
          const value = operations.readFileSync(receipt);
          claimedBytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
        } catch (claimError) {
          if (renameError !== undefined && claimError?.code === "ENOENT") {
            throw renameError;
          }
          throw new AggregateError(
            [renameError, claimError].filter(Boolean),
            `S5 canonical latest recovery claim ${attempt} could not be inspected`,
            { cause: claimError },
          );
        }
        if (renameError !== undefined) {
          throw renameError;
        }
      }

      assertExactEvidenceBytes(
        paths.lock,
        lockBytes,
        `S5 owned RUNNING lock at exclusive latest recovery attempt ${attempt}`,
        operations,
      );
      const canonicalBeforeCreate = fingerprintEvidenceFile(
        paths.latest,
        operations,
      );
      assertEvidenceReadableOrAbsent(
        canonicalBeforeCreate,
        `S5 canonical latest before exclusive recovery attempt ${attempt}`,
      );
      if (
        canonicalBeforeCreate.exists !== false ||
        canonicalBeforeCreate.error !== "ENOENT"
      ) {
        throw new Error(
          `S5 canonical latest was occupied at recovery attempt ${attempt}`,
        );
      }
      assertExactEvidenceBytes(
        paths.lock,
        lockBytes,
        `S5 owned RUNNING lock immediately before exclusive latest recovery attempt ${attempt}`,
        operations,
      );
      createImmutableEvidence(paths.latest, expectedRunning, operations);
      runningCreated = true;
      assertExactEvidenceBytes(
        paths.lock,
        lockBytes,
        `S5 owned RUNNING lock after latest recovery attempt ${attempt}`,
        operations,
      );
      assertExactEvidenceBytes(
        paths.latest,
        expectedRunning,
        `S5 restored canonical RUNNING latest (attempt ${attempt})`,
        operations,
      );
      const receiptFingerprint = fingerprintEvidenceFile(receipt, operations);
      assertEvidenceReadableOrAbsent(
        receiptFingerprint,
        `S5 retained latest recovery receipt (attempt ${attempt})`,
      );
      return {
        ok: true,
        method: `receipt-exclusive-attempt-${attempt}`,
        receiptRetained: receiptFingerprint.exists === true,
      };
    } catch (error) {
      if (claimedBytes !== undefined && !runningCreated) {
        try {
          // Before an owned RUNNING create succeeds, restore exactly what the
          // receipt claimed. Exclusive creation never overwrites a late foreign
          // canonical latest; a mismatch retains both records for recovery.
          restoreS5ClaimedEvidence(
            paths.latest,
            claimedBytes,
            `S5 claimed canonical latest restored after recovery attempt ${attempt}`,
            operations,
          );
        } catch (restoreError) {
          errors.push(
            new AggregateError(
              [error, restoreError],
              `S5 canonical latest recovery attempt ${attempt} could not restore its claim`,
              { cause: restoreError },
            ),
          );
          continue;
        }
      }
      errors.push(error);
    }
  }
  return {
    ok: false,
    method: "receipt-exclusive-failed",
    error: aggregateS5RecoveryErrors(
      "S5 canonical RUNNING latest recovery failed",
      errors,
    ),
  };
}

function quarantineS5FinalLookingLatest(
  paths,
  finalBytes,
  lockBytes,
  operations,
) {
  const quarantineLock = recoverS5OwnedRunningLock(
    paths,
    lockBytes,
    operations,
  );
  const errors = [...(quarantineLock.recoveredErrors ?? [])];
  const exactOwnedLockStillHeld = () => {
    try {
      assertExactEvidenceBytes(
        paths.lock,
        lockBytes,
        "S5 owned RUNNING lock at quarantine outcome",
        operations,
      );
      return true;
    } catch {
      return false;
    }
  };
  if (!quarantineLock.ok) {
    errors.push(quarantineLock.error);
    return {
      ok: false,
      method: "quarantine-lock-unavailable",
      lockAuthority: false,
      error: aggregateS5RecoveryErrors(
        "S5 final-looking latest quarantine failed",
        errors,
      ),
    };
  }
  try {
    // The UUID archive is the immutable safety copy that makes removal of this
    // run's exact mutable final bytes non-destructive.
    assertExactEvidenceBytes(
      paths.run,
      finalBytes,
      "S5 immutable run archive before recovery quarantine",
      operations,
    );
  } catch (error) {
    errors.push(error);
    return {
      ok: false,
      method: "unsafe-without-archive",
      lockAuthority: exactOwnedLockStillHeld(),
      error: aggregateS5RecoveryErrors(
        "S5 final-looking latest quarantine failed",
        errors,
      ),
    };
  }

  const current = fingerprintEvidenceFile(paths.latest, operations);
  try {
    assertEvidenceReadableOrAbsent(
      current,
      "S5 final-looking latest before recovery quarantine",
    );
  } catch (error) {
    errors.push(error);
    return {
      ok: false,
      method: "latest-inspection-failed",
      lockAuthority: exactOwnedLockStillHeld(),
      error: aggregateS5RecoveryErrors(
        "S5 final-looking latest quarantine failed",
        errors,
      ),
    };
  }
  if (current.exists === false && current.error === "ENOENT") {
    try {
      assertExactEvidenceBytes(
        paths.lock,
        lockBytes,
        "S5 owned RUNNING lock after absent latest quarantine observation",
        operations,
      );
      const confirmedAbsent = fingerprintEvidenceFile(paths.latest, operations);
      assertEvidenceReadableOrAbsent(
        confirmedAbsent,
        "S5 canonical latest confirmation while already absent",
      );
      if (
        confirmedAbsent.exists !== false ||
        confirmedAbsent.error !== "ENOENT"
      ) {
        throw new Error(
          "S5 canonical latest reappeared during absent quarantine confirmation",
        );
      }
      assertExactEvidenceBytes(
        paths.run,
        finalBytes,
        "S5 immutable run archive at absent quarantine outcome",
        operations,
      );
      // End on the exact owned lock so an absence observation can never be
      // misreported as lock authority after a foreign replacement.
      assertExactEvidenceBytes(
        paths.lock,
        lockBytes,
        "S5 owned RUNNING lock at absent quarantine outcome",
        operations,
      );
      return { ok: true, method: "already-absent", lockAuthority: true };
    } catch (error) {
      errors.push(error);
      return {
        ok: false,
        method: "already-absent-authority-lost",
        lockAuthority: exactOwnedLockStillHeld(),
        error: aggregateS5RecoveryErrors(
          "S5 final-looking latest quarantine failed",
          errors,
        ),
      };
    }
  }
  try {
    assertExactEvidenceBytes(
      paths.latest,
      finalBytes,
      "S5 owned final-looking latest before recovery quarantine",
      operations,
    );
  } catch (error) {
    errors.push(error);
    return {
      ok: false,
      method: "foreign-or-corrupt-latest-retained",
      lockAuthority: exactOwnedLockStillHeld(),
      error: aggregateS5RecoveryErrors(
        "S5 final-looking latest quarantine failed",
        errors,
      ),
    };
  }

  const recoveryBefore = fingerprintEvidenceFile(
    paths.recoveryLatest,
    operations,
  );
  try {
    assertEvidenceReadableOrAbsent(
      recoveryBefore,
      "S5 publication-recovery quarantine before creation",
    );
  } catch (error) {
    errors.push(error);
    return {
      ok: false,
      method: "quarantine-inspection-failed",
      lockAuthority: exactOwnedLockStillHeld(),
      error: aggregateS5RecoveryErrors(
        "S5 final-looking latest quarantine failed",
        errors,
      ),
    };
  }

  let recoveryWriteError;
  if (recoveryBefore.exists === false && recoveryBefore.error === "ENOENT") {
    try {
      createImmutableEvidence(paths.recoveryLatest, finalBytes, operations);
    } catch (error) {
      // Exact verification below decides whether a post-write throw succeeded.
      recoveryWriteError = error;
    }
  }
  let recoveryCopyExact = false;
  let recoveryVerifyError;
  try {
    assertExactEvidenceBytes(
      paths.recoveryLatest,
      finalBytes,
      "S5 publication-recovery latest quarantine",
      operations,
    );
    recoveryCopyExact = true;
  } catch (error) {
    recoveryVerifyError = error;
  }

  // If immutable creation failed before writing, first claim the exact
  // canonical entry to a unique receipt. Linking that receipt into the UUID
  // quarantine path is exclusive, so neither destination can be overwritten.
  if (
    !recoveryCopyExact &&
    recoveryBefore.exists === false &&
    recoveryBefore.error === "ENOENT"
  ) {
    try {
      const recoveryAfterCreate = fingerprintEvidenceFile(
        paths.recoveryLatest,
        operations,
      );
      assertEvidenceReadableOrAbsent(
        recoveryAfterCreate,
        "S5 publication-recovery quarantine before fallback claim",
      );
      if (
        recoveryAfterCreate.exists !== false ||
        recoveryAfterCreate.error !== "ENOENT"
      ) {
        throw new Error(
          "S5 publication-recovery quarantine path is not absent before fallback claim",
        );
      }
      const claim = claimS5OwnedCanonicalLatest(
        paths,
        finalBytes,
        lockBytes,
        "quarantine-fallback",
        "S5 fallback recovery quarantine",
        operations,
      );
      let linkError;
      try {
        operations.linkSync(claim.receipt, paths.recoveryLatest);
      } catch (error) {
        // A wrapper can throw after creating the link. Exact verification,
        // rather than its return path, decides whether publication succeeded.
        linkError = error;
      }
      const latestAfterClaim = fingerprintEvidenceFile(
        paths.latest,
        operations,
      );
      assertEvidenceReadableOrAbsent(
        latestAfterClaim,
        "S5 canonical latest after fallback recovery claim",
      );
      assertExactEvidenceBytes(
        paths.recoveryLatest,
        finalBytes,
        "S5 exclusively linked publication-recovery latest quarantine",
        operations,
      );
      assertExactEvidenceBytes(
        claim.receipt,
        finalBytes,
        "S5 retained fallback recovery claim receipt",
        operations,
      );
      if (
        latestAfterClaim.exists !== false ||
        latestAfterClaim.error !== "ENOENT"
      ) {
        throw new Error(
          "S5 canonical final-looking latest remains after fallback recovery claim",
        );
      }
      assertExactEvidenceBytes(
        paths.lock,
        lockBytes,
        "S5 owned RUNNING lock after fallback recovery quarantine",
        operations,
      );
      return {
        ok: true,
        method: "claimed-and-linked-to-quarantine",
        lockAuthority: true,
        recoveredErrors: [
          recoveryWriteError,
          recoveryVerifyError,
          linkError,
          ...errors,
        ].filter(Boolean),
      };
    } catch (error) {
      errors.push(error);
    }
  }

  if (!recoveryCopyExact) {
    if (recoveryWriteError) errors.push(recoveryWriteError);
    if (recoveryVerifyError) errors.push(recoveryVerifyError);
    return {
      ok: false,
      method: "quarantine-copy-failed",
      lockAuthority: exactOwnedLockStillHeld(),
      error: aggregateS5RecoveryErrors(
        "S5 final-looking latest quarantine failed",
        errors,
      ),
    };
  }

  // Claim canonical bytes to an identity-bearing receipt instead of unlinking
  // a pathname after a snapshot. A late foreign pair is restored exactly by
  // the shared claim primitive and the recovery copy remains immutable.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      assertExactEvidenceBytes(
        paths.recoveryLatest,
        finalBytes,
        `S5 publication-recovery latest at recovery claim attempt ${attempt}`,
        operations,
      );
      const claim = claimS5OwnedCanonicalLatest(
        paths,
        finalBytes,
        lockBytes,
        `quarantine-copy-attempt-${attempt}`,
        `S5 copy-backed recovery quarantine attempt ${attempt}`,
        operations,
      );
      assertExactEvidenceBytes(
        claim.receipt,
        finalBytes,
        `S5 retained copy-backed recovery claim receipt attempt ${attempt}`,
        operations,
      );
      assertExactEvidenceBytes(
        paths.recoveryLatest,
        finalBytes,
        `S5 publication-recovery latest after recovery claim attempt ${attempt}`,
        operations,
      );
      const after = fingerprintEvidenceFile(paths.latest, operations);
      assertEvidenceReadableOrAbsent(
        after,
        `S5 latest after recovery claim attempt ${attempt}`,
      );
      if (after.exists !== false || after.error !== "ENOENT") {
        throw new Error(
          `S5 canonical latest remains after recovery claim attempt ${attempt}`,
        );
      }
      assertExactEvidenceBytes(
        paths.lock,
        lockBytes,
        `S5 owned RUNNING lock at recovery claim outcome ${attempt}`,
        operations,
      );
      return {
        ok: true,
        method: `quarantined-by-receipt-attempt-${attempt}`,
        lockAuthority: true,
        recoveredErrors: [recoveryWriteError, ...errors].filter(Boolean),
      };
    } catch (error) {
      errors.push(error);
    }
    try {
      assertExactEvidenceBytes(
        paths.latest,
        finalBytes,
        `S5 restored final-looking latest after recovery claim attempt ${attempt}`,
        operations,
      );
      assertExactEvidenceBytes(
        paths.recoveryLatest,
        finalBytes,
        `S5 publication-recovery latest retained after recovery claim attempt ${attempt}`,
        operations,
      );
      assertExactEvidenceBytes(
        paths.lock,
        lockBytes,
        `S5 owned RUNNING lock retained after recovery claim attempt ${attempt}`,
        operations,
      );
    } catch (error) {
      errors.push(error);
      break;
    }
  }
  return {
    ok: false,
    method: "receipt-claim-failed",
    lockAuthority: exactOwnedLockStillHeld(),
    error: aggregateS5RecoveryErrors(
      "S5 final-looking latest quarantine failed",
      errors,
    ),
  };
}

export function inspectS5PriorState(paths, operations = fs) {
  const lock = readJsonIfPresent(paths.lock, operations);
  if (lock !== undefined) {
    throw new Error(
      `S5 evidence lock already exists for ${String(lock.runId)}`,
    );
  }
  const latest = readJsonIfPresent(paths.latest, operations);
  if (latest?.status === "RUNNING" || latest?.incomplete === true) {
    throw new Error(
      `S5 latest is still RUNNING for ${String(latest?.runId ?? "unknown")}`,
    );
  }
  return {
    latest,
    latestFingerprint: fingerprintEvidenceFile(paths.latest, operations),
  };
}

export function beginS5EvidenceRun(paths, runId, operations = fs) {
  operations.mkdirSync(paths.directory, { recursive: true });
  const lock = {
    schema: C12_29_S5_SCHEMA,
    runId,
    status: "RUNNING",
    incomplete: true,
    acquiredAt: new Date().toISOString(),
  };
  const lockBytes = serializeS5Artifact(lock);
  // Authority is acquired before prior mutable state is parsed or trusted.
  // `wx` makes competing starts mutually exclusive, while the complete lock
  // record remains sufficient to identify the owner if later I/O fails.
  createImmutableEvidence(paths.lock, lockBytes, operations);
  let runningPublished = false;
  try {
    assertExactEvidenceBytes(
      paths.lock,
      lockBytes,
      "S5 owned RUNNING lock",
      operations,
    );
    const beforeParse = fingerprintEvidenceFile(paths.latest, operations);
    assertEvidenceReadableOrAbsent(
      beforeParse,
      "S5 prior latest artifact before parse",
    );
    const latest = readJsonIfPresent(paths.latest, operations);
    const afterParse = fingerprintEvidenceFile(paths.latest, operations);
    assertEvidenceReadableOrAbsent(
      afterParse,
      "S5 prior latest artifact after parse",
    );
    if (!sameEvidenceFingerprint(beforeParse, afterParse)) {
      throw new Error("S5 latest changed while parsing prior evidence");
    }
    if (latest?.status === "RUNNING" || latest?.incomplete === true) {
      throw new Error(
        `S5 latest is still RUNNING for ${String(latest?.runId ?? "unknown")}`,
      );
    }
    const prior = {
      latest,
      latestFingerprint: afterParse,
    };
    assertEvidenceReadableOrAbsent(
      prior.latestFingerprint,
      "S5 prior latest artifact",
    );
    assertExactEvidenceBytes(
      paths.lock,
      lockBytes,
      "S5 owned RUNNING lock",
      operations,
    );
    const beforePublish = fingerprintEvidenceFile(paths.latest, operations);
    assertEvidenceReadableOrAbsent(
      beforePublish,
      "S5 prior latest artifact recheck",
    );
    if (!sameEvidenceFingerprint(prior.latestFingerprint, beforePublish)) {
      throw new Error("S5 latest changed while acquiring the evidence lock");
    }
    const running = {
      schema: C12_29_S5_SCHEMA,
      runId,
      status: "RUNNING",
      incomplete: true,
      startedAt: lock.acquiredAt,
      supersedesLatest: prior.latestFingerprint,
    };
    const runningBytes = serializeS5Artifact(running);
    runningPublished = true;
    publishS5OwnedRunningLatest(
      paths,
      prior.latestFingerprint,
      runningBytes,
      lockBytes,
      operations,
    );
    assertExactEvidenceBytes(
      paths.latest,
      runningBytes,
      "S5 canonical RUNNING latest",
      operations,
    );
    assertExactEvidenceBytes(
      paths.lock,
      lockBytes,
      "S5 owned RUNNING lock",
      operations,
    );
    return { prior, lock, running };
  } catch (error) {
    // Before RUNNING is published, release only a byte-exact lock that is
    // still ours. After publication, any failure retains lock+latest as the
    // authoritative incomplete run.
    if (!runningPublished) {
      try {
        assertExactEvidenceBytes(
          paths.lock,
          lockBytes,
          "S5 owned RUNNING lock",
          operations,
        );
        releaseS5OwnedRunningLock(paths, lockBytes, operations);
      } catch {
        // Preserve the acquisition error and retain uncertain authority.
      }
    }
    throw error;
  }
}

export function publishS5FinalArtifact(paths, artifact, operations = fs) {
  const shape = validateS5FinalArtifactShape(artifact);
  if (!shape.ok) {
    throw new Error(`invalid S5 final artifact: ${shape.reasons.join("; ")}`);
  }
  const lock = readJsonIfPresent(paths.lock, operations);
  const running = readJsonIfPresent(paths.latest, operations);
  if (
    lock?.runId !== artifact.runId ||
    lock?.status !== "RUNNING" ||
    running?.runId !== artifact.runId ||
    running?.status !== "RUNNING" ||
    running?.incomplete !== true
  ) {
    throw new Error(
      "S5 final publication does not own its RUNNING lock/latest",
    );
  }
  const lockBytes = serializeS5Artifact(lock);
  const runningBytes = serializeS5Artifact(running);
  assertExactEvidenceBytes(
    paths.lock,
    lockBytes,
    "S5 owned RUNNING lock",
    operations,
  );
  assertExactEvidenceBytes(
    paths.latest,
    runningBytes,
    "S5 canonical RUNNING latest",
    operations,
  );
  const bytes = serializeS5Artifact(artifact);
  createImmutableEvidence(paths.run, bytes, operations);
  assertExactEvidenceBytes(
    paths.run,
    bytes,
    "S5 immutable run archive",
    operations,
  );
  const runIdentity = fingerprintEvidenceFile(paths.run, operations);
  assertEvidenceReadableOrAbsent(runIdentity, "S5 immutable run artifact");
  if (
    runIdentity.exists !== true ||
    runIdentity.byteLength !== Buffer.byteLength(bytes) ||
    runIdentity.sha256 !== sha256(bytes)
  ) {
    throw new Error("S5 immutable run archive fingerprint is not exact");
  }
  let firstRed;
  if (artifact.status !== "PASS") {
    firstRed = preserveFirstRedEvidence(paths.firstRed, bytes, operations);
    if (firstRed.written === true) {
      assertExactEvidenceBytes(
        paths.firstRed,
        bytes,
        "S5 new first-red artifact",
        operations,
      );
    }
  }
  try {
    publishS5OwnedFinalLatest(
      paths,
      runningBytes,
      bytes,
      lockBytes,
      operations,
    );
    releaseS5OwnedRunningLock(paths, lockBytes, operations);
  } catch (error) {
    // Lock release may have deleted its target before throwing. Recover and
    // verify the two authoritative incomplete states independently so failure
    // in one lane can never suppress the other lane's attempt.
    const lockRecovery = recoverS5OwnedRunningLock(
      paths,
      lockBytes,
      operations,
    );
    const latestRecovery = recoverS5CanonicalRunningLatest(
      paths,
      runningBytes,
      lockBytes,
      operations,
      lockRecovery.ok,
    );
    const cleanup =
      lockRecovery.ok || latestRecovery.ok
        ? null
        : quarantineS5FinalLookingLatest(paths, bytes, lockBytes, operations);
    const recoveryFailures = [
      lockRecovery.ok ? null : lockRecovery.error,
      latestRecovery.ok ? null : latestRecovery.error,
      cleanup === null || cleanup.ok ? null : cleanup.error,
      ...(cleanup?.recoveredErrors ?? []),
    ].filter(Boolean);
    if (recoveryFailures.length === 0) throw error;

    const recoveryError = new AggregateError(
      [error, ...recoveryFailures],
      `S5 final publication failed (${describeS5RecoveryError(error)}); ` +
        `recovery authority lock=${lockRecovery.ok}, latest=${latestRecovery.ok}, ` +
        `finalLatestFailClosed=${cleanup?.ok === true}`,
      { cause: error },
    );
    recoveryError.code = "S5_PUBLICATION_RECOVERY";
    recoveryError.s5Recovery = {
      lock: { ok: lockRecovery.ok, method: lockRecovery.method },
      latest: { ok: latestRecovery.ok, method: latestRecovery.method },
      finalLatest: cleanup
        ? {
            ok: cleanup.ok,
            method: cleanup.method,
            lockAuthority: cleanup.lockAuthority === true,
          }
        : { ok: null, method: "authority-recovered" },
    };
    throw recoveryError;
  }
  return { runIdentity, firstRed };
}

function safeGitHead() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

async function inspectGeneratedShader(rawRelative, generatedRelative) {
  const rawPath = path.join(repositoryRoot, rawRelative);
  const generatedPath = path.join(repositoryRoot, generatedRelative);
  const raw = fs.readFileSync(rawPath, "utf8").replaceAll("\r\n", "\n");
  const generated = await import(
    `${pathToFileURL(generatedPath).href}?s5_identity=${randomUUID()}`
  );
  return typeof generated.default === "string" && generated.default === raw;
}

const sourceEvidenceFiles = Object.freeze(
  Object.fromEntries(
    C12_29_S5_SOURCE_FILES.map((file, index) => [
      `source${String(index).padStart(2, "0")}`,
      path.join(repositoryRoot, file),
    ]),
  ),
);
const harnessEvidenceFiles = Object.freeze({
  gateHelper: gateHelperPath,
  focusedSpec: specPath,
  probe: probePath,
  identityHelper: identityHelperPath,
  buildEntry: buildEntryPath,
  buildSourceMap: buildSourceMapPath,
});

async function collectS5ProvenanceSnapshot() {
  const localIdentity = snapshotEvidenceFiles({
    ...sourceEvidenceFiles,
    ...harnessEvidenceFiles,
    fixtureLayer: path.join(repositoryRoot, C12_29_S5_FIXTURE.layer.file),
    fixtureTile: path.join(repositoryRoot, C12_29_S5_FIXTURE.tile.file),
  });
  const reasons = Object.entries(localIdentity)
    .filter(([, identity]) => identity.exists !== true)
    .map(([key]) => `${key}: unreadable`);
  const quantizedMeshHeader = inspectS5QuantizedMeshHeader();
  if (!quantizedMeshHeader.ok) {
    reasons.push("QuantizedMesh header height pins differ");
  }
  const webgpuEclipseBinding = inspectS5WebGPUEclipseBinding();
  if (!webgpuEclipseBinding.ok) {
    reasons.push("WebGPU eclipse binding-2 layout marker differs");
  }
  let buildSourceIdentity;
  try {
    buildSourceIdentity = inspectBuildSourceIdentity({
      sourceMapPath: buildSourceMapPath,
      sourceFiles: C12_29_S5_BUILD_SOURCE_FILES.map((file) =>
        path.join(repositoryRoot, file),
      ),
    });
  } catch (error) {
    buildSourceIdentity = {
      ok: false,
      entries: [],
      reasons: [error?.message ?? String(error)],
    };
  }
  reasons.push(...(buildSourceIdentity.reasons ?? []));
  let generatedShaders;
  try {
    generatedShaders = {
      globeFsExact: await inspectGeneratedShader(
        "packages/engine/Source/Shaders/GlobeFS.glsl",
        "packages/engine/Source/Shaders/GlobeFS.js",
      ),
      globeTerrainExact: await inspectGeneratedShader(
        "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
        "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.js",
      ),
    };
  } catch (error) {
    generatedShaders = {
      globeFsExact: false,
      globeTerrainExact: false,
      error: error?.message ?? String(error),
    };
  }
  if (!generatedShaders.globeFsExact || !generatedShaders.globeTerrainExact) {
    reasons.push("raw/generated globe shader identity differs");
  }
  return {
    capturedAt: new Date().toISOString(),
    gitHead: safeGitHead(),
    localIdentity,
    buildSourceIdentity,
    generatedShaders,
    quantizedMeshHeader,
    webgpuEclipseBinding,
    ok: reasons.length === 0,
    reasons,
  };
}

function assessS5Provenance(start, end, sessions) {
  const reasons = [];
  if (start.ok !== true) reasons.push(...start.reasons);
  if (end.ok !== true) reasons.push(...end.reasons);
  if (start.gitHead !== end.gitHead)
    reasons.push("git HEAD changed during run");
  const stability = compareEvidenceFileSnapshots(
    start.localIdentity,
    end.localIdentity,
  );
  reasons.push(...stability.reasons);
  const servedEntryIdentity = validateServedEntryIdentities({
    entries: sessions.map((session) => session.servedEntry).filter(Boolean),
    expectedLabels: [...C12_29_S5_RENDERERS],
    localEntry: start.localIdentity.buildEntry,
  });
  reasons.push(...servedEntryIdentity.reasons);
  const sourceIdentities = C12_29_S5_SOURCE_FILES.map(
    (_file, index) =>
      start.localIdentity[`source${String(index).padStart(2, "0")}`],
  );
  const fixtures = {
    layer: start.localIdentity.fixtureLayer,
    tile: start.localIdentity.fixtureTile,
  };
  if (
    fixtures.layer?.byteLength !== C12_29_S5_FIXTURE.layer.byteLength ||
    fixtures.layer?.sha256 !== C12_29_S5_FIXTURE.layer.sha256 ||
    fixtures.tile?.byteLength !== C12_29_S5_FIXTURE.tile.byteLength ||
    fixtures.tile?.sha256 !== C12_29_S5_FIXTURE.tile.sha256
  ) {
    reasons.push("fixture bytes differ from frozen pins");
  }
  const harnessKeys = [
    "gateHelper",
    "focusedSpec",
    "probe",
    "identityHelper",
    "buildEntry",
    "buildSourceMap",
  ];
  const harnessStable = harnessKeys.every((key) => {
    const left = start.localIdentity[key];
    const right = end.localIdentity[key];
    return (
      left?.exists === true &&
      right?.exists === true &&
      left.byteLength === right.byteLength &&
      left.sha256 === right.sha256
    );
  });
  if (!harnessStable) reasons.push("harness/build identity moved during run");
  return {
    ok: reasons.length === 0,
    stable: stability.ok && start.gitHead === end.gitHead,
    reasons,
    gitHead: start.gitHead,
    fixtures,
    quantizedMeshHeader: start.quantizedMeshHeader,
    sourceBoundary: {
      count: C12_29_S5_SOURCE_FILES.length,
      files: [...C12_29_S5_SOURCE_FILES],
      allReadable: sourceIdentities.every((entry) => entry?.exists === true),
      identities: sourceIdentities,
    },
    buildSourceIdentity: start.buildSourceIdentity,
    generatedShaders: start.generatedShaders,
    webgpuEclipseBinding: start.webgpuEclipseBinding,
    servedEntryIdentity,
    harnessStable,
    start,
    end,
  };
}

const MEASURE_S5_SESSION = async (contract) => {
  const progressStartedAt = performance.now();
  const terrainRequests = {
    attempted: 0,
    accepted: 0,
    throttled: 0,
    decoded: 0,
    held: 0,
    released: 0,
    fulfilled: 0,
    rejected: 0,
    lastTileId: null,
    lastError: null,
  };
  const progress = {
    schema: contract.diagnosticsSchema,
    renderer: contract.renderer,
    currentPhase: "preflight",
    step: "runtime-import",
    completedPhases: [],
    elapsedMs: 0,
    settle: null,
    terrainRequests,
    pick: {
      started: false,
      settled: false,
      frameDriver: contract.pickFrameDriver,
      renderPumpFrames: 0,
    },
    visibilitySeam: {
      state: "not-installed",
      targetKey: null,
      mode: "not-installed",
      config: {
        claim:
          "controlled-visibility-input-production-selection-request-fill-release-render",
        maximumScreenSpaceError: contract.fillFrontierMaximumScreenSpaceError,
        cameraHeightMeters: contract.cameraHeightMeters,
        cameraFovDegrees: contract.cameraFovDegrees,
        maskMode: "warm-only-exact-target-Visibility.NONE",
      },
      calls: [],
      counts: {
        totalCalls: 0,
        originalCalls: 0,
        targetCalls: 0,
        nonTargetCalls: 0,
        overrideCalls: 0,
        nonTargetAlteredCalls: 0,
        skippedOriginalCalls: 0,
      },
      terminalReason: null,
      restoration: {
        attempted: false,
        restored: false,
        identityMatches: false,
        descriptorMatches: false,
      },
    },
  };
  globalThis.__c1229S5Progress = progress;
  const markProgress = (phase, step, detail) => {
    if (phase !== progress.currentPhase) progress.settle = null;
    progress.currentPhase = phase;
    progress.step = step;
    progress.elapsedMs = Math.round(performance.now() - progressStartedAt);
    if (detail === undefined) {
      delete progress.detail;
    } else {
      progress.detail = detail;
    }
  };
  const completePhase = (phase, detail) => {
    if (!progress.completedPhases.includes(phase)) {
      progress.completedPhases.push(phase);
    }
    markProgress(phase, "complete", detail);
  };
  const C = await import(contract.runtimePath);
  markProgress("preflight", "runtime-imported");
  const viewer = globalThis.viewer;
  const scene = viewer?.scene;
  if (!scene?.context || !scene.globe) {
    throw new Error("CesiumViewer did not expose a scene, context, and globe");
  }
  const actualRenderer = scene.context.isWebGPU ? "webgpu" : "webgl";
  if (actualRenderer !== contract.renderer) {
    throw new Error(
      `renderer resolved ${actualRenderer}, expected ${contract.renderer}`,
    );
  }
  markProgress("preflight", "renderer-verified", { actualRenderer });
  const canvas = scene.canvas;
  const globe = scene.globe;
  const pinnedTime = C.JulianDate.fromIso8601(contract.pinnedIso);
  const timeFn = () => pinnedTime;
  viewer.useDefaultRenderLoop = false;
  viewer.resolutionScale = 1;
  viewer.clock.shouldAnimate = false;
  viewer.clock.currentTime = pinnedTime;
  scene.requestRenderMode = false;
  scene.highDynamicRange = false;
  scene.sunBloom = false;
  scene.taaEnabled = false;
  scene.backgroundColor = C.Color.BLACK;
  scene.fog.enabled = false;
  if (scene.postProcessStages?.fxaa)
    scene.postProcessStages.fxaa.enabled = false;
  if (scene.postProcessStages?.bloom)
    scene.postProcessStages.bloom.enabled = false;
  globe.show = true;
  globe.enableLighting = true;
  globe.showGroundAtmosphere = false;
  globe.showWaterEffect = false;
  globe.pickable = false;
  viewer.imageryLayers.removeAll();
  viewer.imageryLayers.addImageryProvider(
    new C.GridImageryProvider({
      cells: 8,
      color: C.Color.fromBytes(86, 124, 162, 255),
      glowColor: C.Color.fromBytes(18, 26, 38, 255),
      glowWidth: 1,
      backgroundColor: C.Color.fromBytes(8, 14, 22, 255),
    }),
  );
  const lighting = globe.atmosphericConditions?.lighting;
  if (!lighting || !("enableEclipseGlobeShadow" in lighting)) {
    throw new Error("S5 lighting controls are unavailable");
  }
  lighting.enableEclipse = true;
  lighting.enableEclipseGlobeShadow = true;
  lighting.eclipseAutoExposure = false;
  if ("enableEclipseHorizonTwilight" in lighting) {
    lighting.enableEclipseHorizonTwilight = false;
  }
  markProgress("preflight", "scene-configured");

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

  const { renderNow, grabNow, settleThen } = makeSameTaskCapture(
    scene,
    canvas,
    timeFn,
  );
  let captureTask = 0;
  const captures = [];
  const captureDocumentaryPng = (label) => {
    const taskToken = `${contract.renderer}-capture-${++captureTask}`;
    const dataUrl = grabNow();
    const record = {
      imageId: crypto.randomUUID(),
      label,
      dataUrl,
      captureMethod: contract.captureMethod,
      renderTaskToken: taskToken,
      captureTaskToken: taskToken,
    };
    captures.push(record);
    return record.imageId;
  };

  const tileId = (tile) =>
    `${tile?.level ?? "?"}/${tile?.x ?? "?"}/${tile?.y ?? "?"}`;
  const levelOneAncestorId = (id) => {
    const match = /^(\d+)\/(\d+)\/(\d+)$/u.exec(id ?? "");
    if (!match) return undefined;
    const level = Number(match[1]);
    const x = Number(match[2]);
    const y = Number(match[3]);
    if (![level, x, y].every(Number.isInteger) || level < 1) {
      return undefined;
    }
    const divisor = 2 ** (level - 1);
    return `1/${Math.floor(x / divisor)}/${Math.floor(y / divisor)}`;
  };
  const getTileProvider = () =>
    globe._surface?.tileProvider ?? globe._surface?._tileProvider;
  const selectedTiles = () => [...(globe._surface?._tilesToRender ?? [])];
  const snapshotTerrain = () => {
    const provider = getTileProvider();
    const tiles = selectedTiles();
    const selectedTileIds = [];
    const realTileIds = [];
    const fillTileIds = [];
    let decodedQuantizedMeshCount = 0;
    let realMeshCount = 0;
    let fillCount = 0;
    for (const tile of tiles) {
      const id = tileId(tile);
      selectedTileIds.push(id);
      const data = tile?.data;
      if (data?.terrainData instanceof C.QuantizedMeshTerrainData) {
        decodedQuantizedMeshCount++;
      }
      if (data?.mesh && data?.renderedMesh === data.mesh) {
        realMeshCount++;
        realTileIds.push(id);
      }
      if (data?.fill?.mesh && data?.renderedMesh === data.fill.mesh) {
        fillCount++;
        fillTileIds.push(id);
      }
    }
    selectedTileIds.sort();
    realTileIds.sort();
    fillTileIds.sort();
    return {
      selectedTileIds,
      selectedCount: tiles.length,
      realTileIds,
      realMeshCount,
      fillTileIds,
      fillCount,
      decodedQuantizedMeshCount,
      loadedAndFillFlags:
        provider?._hasLoadedTilesThisFrame === true &&
        provider?._hasFillTilesThisFrame === true,
      tilesLoaded: globe.tilesLoaded === true,
      providerSelectionRevision: provider?._eclipseSelectionRevision ?? null,
      surfaceRadius: provider?._eclipseSurfaceRadius ?? null,
      knownMinimumHeight: provider?._eclipseKnownMinimumHeight ?? null,
      knownMaximumHeight: provider?._eclipseKnownMaximumHeight ?? null,
      knownBoundsValid: provider?._eclipseKnownBoundsValid ?? null,
      contentRevision: provider?._sceneCaptureContentRevision ?? null,
    };
  };
  const findInstantiatedTile = (id) => {
    const match = /^(\d+)\/(\d+)\/(\d+)$/u.exec(id ?? "");
    if (!match) return undefined;
    const [level, x, y] = match.slice(1).map(Number);
    const quadtree = globe._surface?._levelZeroTiles
      ? globe._surface
      : getTileProvider()?._quadtree;
    const pending = [...(quadtree?._levelZeroTiles ?? [])];
    while (pending.length > 0) {
      const tile = pending.pop();
      if (tile?.level === level && tile?.x === x && tile?.y === y) return tile;
      if ((tile?.level ?? level) >= level) continue;
      for (const key of [
        "_southwestChild",
        "_southeastChild",
        "_northwestChild",
        "_northeastChild",
      ]) {
        if (tile?.[key]) pending.push(tile[key]);
      }
    }
    return undefined;
  };
  const tileSelectionObservation = (id) => {
    const tile = findInstantiatedTile(id);
    const quadtree = getTileProvider()?._quadtree ?? globe._surface;
    const selectionFrame = quadtree?._lastSelectionFrameNumber ?? null;
    const resultFrame = tile?._lastSelectionResultFrame ?? null;
    const sameFrame =
      Number.isInteger(selectionFrame) && resultFrame === selectionFrame;
    const rawResult = sameFrame
      ? tile?._lastSelectionResult
      : C.TileSelectionResult.NONE;
    const originalResult = C.TileSelectionResult.originalResult(rawResult);
    const resultName = (value) =>
      ["NONE", "CULLED", "RENDERED", "REFINED"].find(
        (name) => C.TileSelectionResult[name] === value,
      ) ?? "UNKNOWN";
    return {
      tileId: id,
      instantiated: Boolean(tile),
      selectionFrame,
      resultFrame,
      sameFrame,
      rawResult,
      rawResultName:
        rawResult === C.TileSelectionResult.CULLED_BUT_NEEDED
          ? "CULLED_BUT_NEEDED"
          : rawResult === C.TileSelectionResult.RENDERED_AND_KICKED
            ? "RENDERED_AND_KICKED"
            : rawResult === C.TileSelectionResult.REFINED_AND_KICKED
              ? "REFINED_AND_KICKED"
              : resultName(rawResult),
      originalResult,
      originalResultName: resultName(originalResult),
      wasKicked: C.TileSelectionResult.wasKicked(rawResult),
    };
  };
  const selectedRealSiblingObservations = (target, snapshot) =>
    snapshot.realTileIds
      .filter(
        (id) =>
          snapshot.selectedTileIds.includes(id) &&
          target.siblingKeys.includes(id),
      )
      .map(tileSelectionObservation)
      .filter(
        (observation) =>
          observation.sameFrame &&
          observation.originalResult === C.TileSelectionResult.RENDERED &&
          !observation.wasKicked,
      );
  const settleTerrain = async (predicate, maxFrames = 240) => {
    let latest;
    let stable = 0;
    let previous = "";
    let frame = 0;
    const settled = await settleThen(maxFrames, () => {
      frame++;
      latest = snapshotTerrain();
      const signature = JSON.stringify({
        ids: latest.selectedTileIds,
        real: latest.realTileIds,
        fill: latest.fillTileIds,
        radius: latest.surfaceRadius,
      });
      stable = signature === previous ? stable + 1 : 0;
      previous = signature;
      progress.settle = {
        frame,
        maxFrames,
        stableFrames: stable,
        selectedCount: latest.selectedCount,
        realMeshCount: latest.realMeshCount,
        fillCount: latest.fillCount,
        decodedQuantizedMeshCount: latest.decodedQuantizedMeshCount,
        tilesLoaded: latest.tilesLoaded,
      };
      progress.elapsedMs = Math.round(performance.now() - progressStartedAt);
      return predicate(latest) && stable >= 3;
    });
    latest = snapshotTerrain();
    return {
      settled: settled.settled,
      settleFrames: frame,
      stableFrames: stable,
      ...latest,
    };
  };
  const awaitFrameDrivenOperation = async (operation, label, maxFrames) => {
    let outcome;
    Promise.resolve(operation).then(
      (value) => {
        outcome = { status: "fulfilled", value };
      },
      (error) => {
        outcome = { status: "rejected", error };
      },
    );
    let renderPumpFrames = 0;
    while (!outcome && renderPumpFrames < maxFrames) {
      // Let an already-completed WebGPU readback publish before driving a
      // frame. WebGL's Sync poll is queued in frameState.afterRender, so the
      // pinned-time render below is required when the viewer loop is disabled.
      await Promise.resolve();
      if (outcome) break;
      renderNow();
      renderPumpFrames++;
      progress.pick.renderPumpFrames = renderPumpFrames;
      progress.elapsedMs = Math.round(performance.now() - progressStartedAt);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    if (!outcome) {
      throw new Error(
        `${label} did not settle after ${maxFrames} pinned-time render-pump frames`,
      );
    }
    if (outcome.status === "rejected") throw outcome.error;
    return { value: outcome.value, renderPumpFrames };
  };

  // Derive the named-event observer from the live f64 ephemeris. No city or
  // hand-picked footprint coordinate participates in the result.
  markProgress("preflight", "ephemeris-search");
  scene.terrainProvider = new C.EllipsoidTerrainProvider();
  scene.camera.setView({
    destination: C.Cartesian3.fromDegrees(
      -100,
      25,
      contract.cameraHeightMeters,
    ),
    orientation: { heading: 0, pitch: -C.Math.PI_OVER_TWO, roll: 0 },
  });
  for (let index = 0; index < 4; index++) {
    renderNow();
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  const eclipseState = scene.frameState?.eclipseState;
  if (!eclipseState?.valid) throw new Error("named-event ephemeris is invalid");
  const sun = C.Cartesian3.clone(eclipseState.sunPositionWC);
  const moon = C.Cartesian3.clone(eclipseState.moonPositionWC);
  const scoreObserver = (longitude, latitude) => {
    const surface = C.Cartesian3.fromDegrees(longitude, latitude, 0);
    const toSun = C.Cartesian3.subtract(sun, surface, new C.Cartesian3());
    const toMoon = C.Cartesian3.subtract(moon, surface, new C.Cartesian3());
    const sunRange = C.Cartesian3.magnitude(toSun);
    const moonRange = C.Cartesian3.magnitude(toMoon);
    const sunRadius = Math.asin(Math.min(1, 695_700_000 / sunRange));
    const moonRadius = Math.asin(Math.min(1, 1_737_400 / moonRange));
    const separation = Math.atan2(
      C.Cartesian3.magnitude(
        C.Cartesian3.cross(toSun, toMoon, new C.Cartesian3()),
      ),
      C.Cartesian3.dot(toSun, toMoon),
    );
    return {
      longitude,
      latitude,
      magnitude: (sunRadius + moonRadius - separation) / (2 * sunRadius),
      totalityMargin: moonRadius - sunRadius - separation,
    };
  };
  let track;
  const search = (center, radius, step) => {
    let best = center;
    const lon0 = center?.longitude ?? 0;
    const lat0 = center?.latitude ?? 0;
    const lonRadius = center ? radius : 180;
    const latRadius = center ? radius : 70;
    for (
      let latitude = lat0 - latRadius;
      latitude <= lat0 + latRadius;
      latitude += step
    ) {
      if (latitude < -75 || latitude > 75) continue;
      for (
        let longitude = lon0 - lonRadius;
        longitude < lon0 + lonRadius;
        longitude += step
      ) {
        const wrapped = ((longitude + 540) % 360) - 180;
        const candidate = scoreObserver(wrapped, latitude);
        if (!best || candidate.totalityMargin > best.totalityMargin)
          best = candidate;
      }
    }
    return best;
  };
  track = search(undefined, 0, 2);
  track = search(track, 3, 0.25);
  track = search(track, 0.4, 0.025);
  if (!(track?.magnitude > 0.95)) {
    throw new Error(
      `deepest named-event track is too shallow: ${track?.magnitude}`,
    );
  }
  const setNadirCamera = (latitude) => {
    scene.camera.setView({
      destination: C.Cartesian3.fromDegrees(
        track.longitude,
        latitude,
        contract.cameraHeightMeters,
      ),
      orientation: { heading: 0, pitch: -C.Math.PI_OVER_TWO, roll: 0 },
    });
  };
  setNadirCamera(track.latitude);
  scene.camera.frustum.fov = C.Math.toRadians(contract.cameraFovDegrees);
  globe.maximumScreenSpaceError = contract.fillFrontierMaximumScreenSpaceError;
  globe.preloadSiblings = false;
  globe.preloadAncestors = false;

  const phases = {};
  markProgress(contract.phases[0], "settle-start");
  const a = await settleTerrain(
    (state) => state.tilesLoaded && state.selectedCount > 0,
    180,
  );
  const ellipsoidTilingScheme = scene.terrainProvider.tilingScheme;
  const heldLevel = 1;
  const trackPosition = C.Cartographic.fromDegrees(
    track.longitude,
    track.latitude,
  );
  const anchorTile = ellipsoidTilingScheme.positionToTileXY(
    trackPosition,
    heldLevel,
  );
  const levelOneXTiles =
    ellipsoidTilingScheme.getNumberOfXTilesAtLevel(heldLevel);
  const levelOneYTiles =
    ellipsoidTilingScheme.getNumberOfYTilesAtLevel(heldLevel);
  if (
    levelOneXTiles !== 4 ||
    levelOneYTiles !== 2 ||
    anchorTile.y + 1 >= levelOneYTiles
  ) {
    throw new Error("S5 south level-one fill target is unavailable");
  }
  const targetX = anchorTile.x;
  const targetY = anchorTile.y + 1;
  const targetParentX = Math.floor(targetX / 2);
  const targetParentY = Math.floor(targetY / 2);
  const siblingKeys = [];
  for (let y = targetParentY * 2; y < targetParentY * 2 + 2; y++) {
    for (let x = targetParentX * 2; x < targetParentX * 2 + 2; x++) {
      if (x !== targetX || y !== targetY) {
        siblingKeys.push(`${heldLevel}/${x}/${y}`);
      }
    }
  }
  siblingKeys.sort();
  const fillTarget = {
    level: heldLevel,
    anchorKey: `${heldLevel}/${anchorTile.x}/${anchorTile.y}`,
    parentKey: `0/${targetParentX}/${targetParentY}`,
    key: `${heldLevel}/${targetX}/${targetY}`,
    edge: "south",
    targetX,
    targetY,
    distanceDegrees: Math.abs(track.latitude - (90 - (anchorTile.y + 1) * 90)),
    derivation: "south-level-1-anchor-neighbor",
    siblingKeys,
  };
  const lodTargetSelection = tileSelectionObservation(fillTarget.key);
  const lodParentSelection = tileSelectionObservation(fillTarget.parentKey);
  const lodSiblingSelection = tileSelectionObservation(fillTarget.anchorKey);
  const lodTargetTile = findInstantiatedTile(fillTarget.key);
  const lodParentTile = findInstantiatedTile(fillTarget.parentKey);
  const lodProvider = getTileProvider();
  const lodDrawingBufferHeight = scene.frameState.context.drawingBufferHeight;
  const lodPixelRatio = scene.frameState.pixelRatio;
  const lodSseDenominator = scene.camera.frustum.sseDenominator;
  const lodLevelZeroGeometricError =
    lodProvider.getLevelMaximumGeometricError(0);
  const lodLevelOneGeometricError =
    lodProvider.getLevelMaximumGeometricError(1);
  const computeLodSse = (geometricError, tile) =>
    Number.isFinite(tile?._distance) && tile._distance > 0
      ? (geometricError * lodDrawingBufferHeight) /
        (tile._distance * lodSseDenominator * lodPixelRatio)
      : null;
  const lodParentComputedSse = computeLodSse(
    lodLevelZeroGeometricError,
    lodParentTile,
  );
  const lodTargetComputedSse = computeLodSse(
    lodLevelOneGeometricError,
    lodTargetTile,
  );
  const lodCameraInsideTarget =
    Boolean(lodTargetTile?.rectangle) &&
    C.Rectangle.contains(
      lodTargetTile.rectangle,
      scene.camera.positionCartographic,
    );
  const lodReferenceOrigin =
    getTileProvider()?._quadtree?._cameraReferenceFrameOriginCartographic ??
    globe._surface?._cameraReferenceFrameOriginCartographic;
  const lodReferenceInsideTarget =
    Boolean(lodReferenceOrigin && lodTargetTile?.rectangle) &&
    C.Rectangle.contains(lodTargetTile.rectangle, lodReferenceOrigin);
  const lodStrictDescendants = a.selectedTileIds.filter(
    (id) => id !== fillTarget.key && levelOneAncestorId(id) === fillTarget.key,
  );
  const directLevelOneExact =
    a.settled &&
    a.tilesLoaded &&
    a.fillCount === 0 &&
    a.selectedTileIds.includes(fillTarget.key) &&
    a.realTileIds.includes(fillTarget.key) &&
    a.selectedTileIds.includes(fillTarget.anchorKey) &&
    a.realTileIds.includes(fillTarget.anchorKey) &&
    !a.selectedTileIds.includes(fillTarget.parentKey) &&
    lodStrictDescendants.length === 0 &&
    lodParentSelection.sameFrame &&
    lodParentSelection.rawResult === C.TileSelectionResult.REFINED &&
    !lodParentSelection.wasKicked &&
    lodTargetSelection.sameFrame &&
    lodTargetSelection.rawResult === C.TileSelectionResult.RENDERED &&
    !lodTargetSelection.wasKicked &&
    lodSiblingSelection.sameFrame &&
    lodSiblingSelection.rawResult === C.TileSelectionResult.RENDERED &&
    !lodSiblingSelection.wasKicked &&
    Number.isFinite(lodParentComputedSse) &&
    Number.isFinite(lodTargetComputedSse) &&
    lodParentComputedSse > contract.fillFrontierMaximumScreenSpaceError &&
    lodTargetComputedSse <= contract.fillFrontierMaximumScreenSpaceError &&
    !lodCameraInsideTarget &&
    !lodReferenceInsideTarget;
  if (!directLevelOneExact) {
    progress.visibilitySeam.terminalReason =
      "fixed-SSE direct level-one target/sibling precondition failed";
    throw new Error(
      "fixed-SSE direct level-one target/sibling precondition failed",
    );
  }
  phases[contract.phases[0]] = {
    provider: "EllipsoidTerrainProvider",
    stable: a.settled,
    tilesLoaded: a.tilesLoaded,
    selectedCount: a.selectedCount,
    selectedTileIds: a.selectedTileIds,
    fillLodPrecondition: {
      claim: "fixed-camera-direct-level-one-no-scan",
      derivation: "pinned-sse-production-selection",
      target: fillTarget,
      siblingKey: fillTarget.anchorKey,
      maximumScreenSpaceError: globe.maximumScreenSpaceError,
      longitude: track.longitude,
      latitude: track.latitude,
      cameraFovDegrees: C.Math.toDegrees(scene.camera.frustum.fov),
      cameraHeightMeters: scene.camera.positionCartographic.height,
      preloadSiblings: globe.preloadSiblings,
      preloadAncestors: globe.preloadAncestors,
      cameraReference: {
        cameraCartographicInsideTarget: lodCameraInsideTarget,
        referenceFrameOriginDefined: Boolean(lodReferenceOrigin),
        referenceFrameOriginInsideTarget: lodReferenceInsideTarget,
        neededPositionInsideTarget:
          lodCameraInsideTarget || lodReferenceInsideTarget,
      },
      sseInputs: {
        drawingBufferHeight: lodDrawingBufferHeight,
        pixelRatio: lodPixelRatio,
        sseDenominator: lodSseDenominator,
        levelZeroGeometricError: lodLevelZeroGeometricError,
        levelOneGeometricError: lodLevelOneGeometricError,
        parentDistance: lodParentTile?._distance ?? null,
        targetDistance: lodTargetTile?._distance ?? null,
        parentComputedSse: lodParentComputedSse,
        targetComputedSse: lodTargetComputedSse,
      },
      selectedTileIds: a.selectedTileIds,
      realTileIds: a.realTileIds,
      fillTileIds: a.fillTileIds,
      parentSelection: lodParentSelection,
      targetSelection: lodTargetSelection,
      siblingSelection: lodSiblingSelection,
    },
  };
  completePhase(contract.phases[0], {
    settled: a.settled,
    tilesLoaded: a.tilesLoaded,
    selectedCount: a.selectedCount,
  });

  markProgress(contract.phases[1], "fixture-provider-create");
  const quantizedUrl = new URL(contract.fixtureRoute, location.origin).href;
  const quantizedProvider = await C.CesiumTerrainProvider.fromUrl(quantizedUrl);
  globe.maximumScreenSpaceError = contract.fillFrontierMaximumScreenSpaceError;
  globe.preloadSiblings = false;
  globe.preloadAncestors = false;
  scene.camera.frustum.fov = C.Math.toRadians(contract.cameraFovDegrees);
  setNadirCamera(track.latitude);
  const tilingScheme = quantizedProvider.tilingScheme;
  const quantizedAnchor = tilingScheme.positionToTileXY(
    trackPosition,
    heldLevel,
  );
  if (
    tilingScheme.getNumberOfXTilesAtLevel(heldLevel) !== 4 ||
    tilingScheme.getNumberOfYTilesAtLevel(heldLevel) !== 2 ||
    quantizedAnchor.x !== anchorTile.x ||
    quantizedAnchor.y !== anchorTile.y
  ) {
    throw new Error("S5 QuantizedMesh fixture is not level-one 4x2 geographic");
  }
  let holdTarget;
  const realRequestTileGeometry =
    quantizedProvider.requestTileGeometry.bind(quantizedProvider);
  const held = new Map();
  const decodedFixtureBounds = new Map();
  let decodedQuantizedMeshInstances = 0;
  let decodedIdentityMismatches = 0;
  let holdEnabled = false;
  const requestAttemptsByKey = new Map([[fillTarget.key, 0]]);
  const reservedPromises = new Set();
  quantizedProvider.requestTileGeometry = (x, y, level, request) => {
    const key = `${level}/${x}/${y}`;
    terrainRequests.attempted++;
    terrainRequests.lastTileId = key;
    if (requestAttemptsByKey.has(key)) {
      requestAttemptsByKey.set(key, requestAttemptsByKey.get(key) + 1);
    }
    const requested = realRequestTileGeometry(x, y, level, request);
    if (!requested) {
      terrainRequests.throttled++;
      return requested;
    }
    terrainRequests.accepted++;
    const reserveHold =
      holdEnabled && key === holdTarget?.key && !reservedPromises.has(key);
    let heldEntry;
    if (reserveHold) {
      reservedPromises.add(key);
      terrainRequests.held++;
      let resolveDeferred;
      const deferred = new Promise((resolve) => {
        resolveDeferred = resolve;
      });
      heldEntry = {
        key,
        terrainData: undefined,
        ready: false,
        releaseRequested: false,
        resolveDeferred,
        deferred,
        release() {
          if (this.releaseRequested) return;
          this.releaseRequested = true;
          terrainRequests.released++;
          if (this.ready) {
            terrainRequests.fulfilled++;
            this.resolveDeferred(this.terrainData);
          }
        },
      };
      held.set(key, heldEntry);
    }
    return Promise.resolve(requested).then(
      (terrainData) => {
        terrainRequests.decoded++;
        if (terrainData instanceof C.QuantizedMeshTerrainData) {
          decodedQuantizedMeshInstances++;
        } else {
          decodedIdentityMismatches++;
        }
        decodedFixtureBounds.set(key, {
          tileId: key,
          minimumHeight: terrainData?._minimumHeight ?? null,
          maximumHeight: terrainData?._maximumHeight ?? null,
        });
        if (!heldEntry) {
          terrainRequests.fulfilled++;
          return terrainData;
        }
        heldEntry.terrainData = terrainData;
        heldEntry.ready = true;
        if (heldEntry.releaseRequested) {
          terrainRequests.fulfilled++;
          heldEntry.resolveDeferred(terrainData);
        }
        return heldEntry.deferred;
      },
      (error) => {
        if (heldEntry) {
          held.delete(key);
          reservedPromises.delete(key);
        }
        terrainRequests.rejected++;
        terrainRequests.lastError = error?.message ?? String(error);
        throw error;
      },
    );
  };
  const providerBeforeSwap = getTileProvider();
  const contentRevisionBeforeSwap =
    providerBeforeSwap._sceneCaptureContentRevision;
  const selectionRevisionBeforeSwap =
    providerBeforeSwap._eclipseSelectionRevision;
  const descriptorShape = (descriptor) =>
    descriptor
      ? {
          configurable: descriptor.configurable === true,
          enumerable: descriptor.enumerable === true,
          writable:
            "writable" in descriptor ? descriptor.writable === true : null,
          hasValue: "value" in descriptor,
          hasGetter: typeof descriptor.get === "function",
          hasSetter: typeof descriptor.set === "function",
        }
      : null;
  const locatePropertyDescriptor = (value, property) => {
    let owner = value;
    while (owner) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, property);
      if (descriptor) return { owner, descriptor };
      owner = Object.getPrototypeOf(owner);
    }
    return undefined;
  };
  const visibilityProperty = "computeTileVisibility";
  const visibilityOwnDescriptorBefore = Object.getOwnPropertyDescriptor(
    providerBeforeSwap,
    visibilityProperty,
  );
  const visibilityDescriptorBefore = locatePropertyDescriptor(
    providerBeforeSwap,
    visibilityProperty,
  );
  const originalComputeTileVisibility =
    providerBeforeSwap.computeTileVisibility;
  if (
    typeof originalComputeTileVisibility !== "function" ||
    !visibilityDescriptorBefore
  ) {
    progress.visibilitySeam.terminalReason =
      "computeTileVisibility descriptor/identity is unavailable";
    throw new Error("computeTileVisibility descriptor/identity is unavailable");
  }
  const visibilityDiagnostic = progress.visibilitySeam;
  const visibilityCalls = visibilityDiagnostic.calls;
  const visibilityCounts = visibilityDiagnostic.counts;
  visibilityDiagnostic.targetKey = fillTarget.key;
  visibilityDiagnostic.mode = "warm-mask";
  visibilityDiagnostic.state = "installed";
  let visibilityMode = "warm-mask";
  let visibilityRestored = false;
  const visibilityInstallation = {
    originalIdentityCaptured: true,
    prototypeDescriptorFound: Boolean(visibilityDescriptorBefore),
    beforeHadOwn: Boolean(visibilityOwnDescriptorBefore),
    beforeDescriptor: descriptorShape(visibilityOwnDescriptorBefore),
    installedHadOwn: false,
    installedDescriptor: null,
    installedWrapperIdentityMatches: false,
  };
  const visibilityRestoration = {
    attempted: false,
    attemptedAt: null,
    restored: false,
    immediateAfterReveal: false,
    beforeRelease: false,
    afterHadOwn: null,
    afterDescriptor: null,
    identityMatches: false,
    descriptorMatches: false,
    finallyVerified: false,
  };
  const visibilityName = (value) =>
    value === C.Visibility.NONE
      ? "NONE"
      : value === C.Visibility.PARTIAL
        ? "PARTIAL"
        : value === C.Visibility.FULL
          ? "FULL"
          : "UNKNOWN";
  const controlledComputeTileVisibility = function (
    tile,
    frameState,
    occluders,
  ) {
    let originalVisibility;
    try {
      originalVisibility = originalComputeTileVisibility.call(
        this,
        tile,
        frameState,
        occluders,
      );
    } catch (error) {
      visibilityDiagnostic.terminalReason = `original computeTileVisibility threw: ${error?.message ?? String(error)}`;
      throw error;
    }
    const key = tileId(tile);
    const target = key === fillTarget.key;
    const returnedVisibility =
      visibilityMode === "warm-mask" && target
        ? C.Visibility.NONE
        : originalVisibility;
    const overridden = !Object.is(originalVisibility, returnedVisibility);
    const call = {
      ordinal: visibilityCalls.length + 1,
      frameNumber: frameState.frameNumber,
      tileKey: key,
      mode: visibilityMode,
      target,
      originalCallCompleted: true,
      originalVisibility,
      originalVisibilityName: visibilityName(originalVisibility),
      returnedVisibility,
      returnedVisibilityName: visibilityName(returnedVisibility),
      overridden,
    };
    visibilityCalls.push(call);
    visibilityCounts.totalCalls++;
    visibilityCounts.originalCalls++;
    if (target) visibilityCounts.targetCalls++;
    else visibilityCounts.nonTargetCalls++;
    if (overridden) visibilityCounts.overrideCalls++;
    if (!target && overridden) visibilityCounts.nonTargetAlteredCalls++;
    return returnedVisibility;
  };
  Object.defineProperty(providerBeforeSwap, visibilityProperty, {
    configurable: true,
    enumerable: visibilityOwnDescriptorBefore?.enumerable === true,
    writable: true,
    value: controlledComputeTileVisibility,
  });
  visibilityInstallation.installedHadOwn = Object.hasOwn(
    providerBeforeSwap,
    visibilityProperty,
  );
  visibilityInstallation.installedDescriptor = descriptorShape(
    Object.getOwnPropertyDescriptor(providerBeforeSwap, visibilityProperty),
  );
  visibilityInstallation.installedWrapperIdentityMatches =
    providerBeforeSwap.computeTileVisibility ===
    controlledComputeTileVisibility;
  const restoreVisibilitySeam = (attemptedAt) => {
    visibilityRestoration.attempted = true;
    visibilityRestoration.attemptedAt ??= attemptedAt;
    if (!visibilityRestored) {
      if (visibilityOwnDescriptorBefore) {
        Object.defineProperty(
          providerBeforeSwap,
          visibilityProperty,
          visibilityOwnDescriptorBefore,
        );
      } else {
        delete providerBeforeSwap[visibilityProperty];
      }
      visibilityRestored = true;
    }
    const afterOwnDescriptor = Object.getOwnPropertyDescriptor(
      providerBeforeSwap,
      visibilityProperty,
    );
    visibilityRestoration.afterHadOwn = Boolean(afterOwnDescriptor);
    visibilityRestoration.afterDescriptor = descriptorShape(afterOwnDescriptor);
    visibilityRestoration.identityMatches =
      providerBeforeSwap.computeTileVisibility ===
      originalComputeTileVisibility;
    visibilityRestoration.descriptorMatches =
      JSON.stringify(visibilityRestoration.afterDescriptor) ===
      JSON.stringify(descriptorShape(visibilityOwnDescriptorBefore));
    visibilityRestoration.restored =
      visibilityRestoration.identityMatches &&
      visibilityRestoration.descriptorMatches;
    visibilityDiagnostic.restoration = {
      attempted: visibilityRestoration.attempted,
      restored: visibilityRestoration.restored,
      identityMatches: visibilityRestoration.identityMatches,
      descriptorMatches: visibilityRestoration.descriptorMatches,
    };
    visibilityDiagnostic.mode = "restored";
    visibilityDiagnostic.state =
      attemptedAt === "finally-after-error" ? "error-restored" : "restored";
  };
  const terrainRequestsBeforeFirstFrame = terrainRequests.attempted;
  let providerAfterSwap;
  try {
    scene.terrainProvider = quantizedProvider;
    const publicAssignment = {
      sceneProviderMatches: scene.terrainProvider === quantizedProvider,
      tileProviderAwaitingFirstBeginFrame:
        providerBeforeSwap.terrainProvider !== quantizedProvider,
      terrainRequestsBeforeFirstFrame,
    };
    let beginFrameCallCount = 0;
    let firstBeginFramePropagation;
    const originalGlobeBeginFrame = globe.beginFrame;
    globe.beginFrame = function (frameState) {
      beginFrameCallCount++;
      const result = originalGlobeBeginFrame.call(this, frameState);
      if (beginFrameCallCount === 1) {
        const propagatedProvider = getTileProvider();
        const terrainRequestAttemptsAtObservation = terrainRequests.attempted;
        const selectionRevisionUnchanged =
          propagatedProvider?._eclipseSelectionRevision ===
          selectionRevisionBeforeSwap;
        firstBeginFramePropagation = {
          observedAt:
            "first-pinned-render-after-globe.beginFrame-before-selection-load",
          beginFrameCallOrdinal: beginFrameCallCount,
          frameNumber: frameState.frameNumber,
          tileProviderIdentityPreserved:
            propagatedProvider === providerBeforeSwap,
          tileProviderMatchesAssigned:
            propagatedProvider?.terrainProvider === quantizedProvider,
          publicProviderMatchesAssigned:
            scene.terrainProvider === quantizedProvider,
          surfaceRadiusUndefined:
            propagatedProvider?._eclipseSurfaceRadius === undefined,
          knownMinimumHeight: propagatedProvider?._eclipseKnownMinimumHeight,
          knownMaximumHeight: propagatedProvider?._eclipseKnownMaximumHeight,
          knownBoundsValid: propagatedProvider?._eclipseKnownBoundsValid,
          contentRevisionAdvanced:
            propagatedProvider?._sceneCaptureContentRevision >
            contentRevisionBeforeSwap,
          contentRevisionBefore: contentRevisionBeforeSwap,
          contentRevisionAtObservation:
            propagatedProvider?._sceneCaptureContentRevision,
          selectionRevisionUnchanged,
          selectionRevisionBefore: selectionRevisionBeforeSwap,
          selectionRevisionAtObservation:
            propagatedProvider?._eclipseSelectionRevision,
          terrainRequestAttemptsAtObservation,
          observedBeforeSelectionAndLoad:
            terrainRequestAttemptsAtObservation === 0 &&
            selectionRevisionUnchanged,
        };
      }
      return result;
    };
    let firstRenderFrameNumber;
    try {
      renderNow();
      firstRenderFrameNumber = scene.frameState.frameNumber;
    } finally {
      globe.beginFrame = originalGlobeBeginFrame;
    }
    providerAfterSwap = getTileProvider();
    firstBeginFramePropagation = {
      ...firstBeginFramePropagation,
      observedInFirstRender:
        beginFrameCallCount === 1 &&
        firstBeginFramePropagation?.frameNumber === firstRenderFrameNumber,
    };
    phases[contract.phases[1]] = {
      fromProvider: "EllipsoidTerrainProvider",
      toProvider: "CesiumTerrainProvider-held",
      publicAssignment,
      firstBeginFramePropagation,
    };
    completePhase(contract.phases[1], {
      contentRevisionAdvanced:
        firstBeginFramePropagation.contentRevisionAdvanced,
    });

    markProgress(contract.phases[2], "settle-quantized-warm-visibility-mask");
    const targetVisibilityCallsForFrame = (frameNumber) =>
      visibilityCalls.filter(
        (call) =>
          call.frameNumber === frameNumber && call.tileKey === fillTarget.key,
      );
    const quantizedWarm = await settleTerrain((state) => {
      const targetSelection = tileSelectionObservation(fillTarget.key);
      const parentSelection = tileSelectionObservation(fillTarget.parentKey);
      const targetBranchAbsent = ![
        ...state.selectedTileIds,
        ...state.realTileIds,
        ...state.fillTileIds,
      ].some((id) => levelOneAncestorId(id) === fillTarget.key);
      const siblingSelections = selectedRealSiblingObservations(
        fillTarget,
        state,
      );
      const targetVisibilityCalls = targetVisibilityCallsForFrame(
        targetSelection.selectionFrame,
      );
      return (
        state.tilesLoaded &&
        state.fillCount === 0 &&
        targetBranchAbsent &&
        parentSelection.sameFrame &&
        parentSelection.rawResult === C.TileSelectionResult.REFINED &&
        !parentSelection.wasKicked &&
        targetSelection.sameFrame &&
        targetSelection.rawResult === C.TileSelectionResult.CULLED &&
        !targetSelection.wasKicked &&
        siblingSelections.some(
          (entry) => entry.tileId === fillTarget.anchorKey,
        ) &&
        targetVisibilityCalls.length > 0 &&
        targetVisibilityCalls.every(
          (call) =>
            new Set([C.Visibility.PARTIAL, C.Visibility.FULL]).has(
              call.originalVisibility,
            ) &&
            call.returnedVisibility === C.Visibility.NONE &&
            call.overridden === true &&
            call.mode === "warm-mask",
        ) &&
        (requestAttemptsByKey.get(fillTarget.key) ?? 0) === 0 &&
        holdEnabled === false &&
        holdTarget === undefined &&
        held.size === 0 &&
        reservedPromises.size === 0
      );
    }, contract.fillWarmMaximumFrames);
    const warmTargetSelection = tileSelectionObservation(fillTarget.key);
    const warmParentSelection = tileSelectionObservation(fillTarget.parentKey);
    const warmSiblingSelections = selectedRealSiblingObservations(
      fillTarget,
      quantizedWarm,
    );
    const warmTargetVisibilityCalls = targetVisibilityCallsForFrame(
      warmTargetSelection.selectionFrame,
    );
    const warmTargetTile = findInstantiatedTile(fillTarget.key);
    const warmCameraInsideTarget =
      Boolean(warmTargetTile?.rectangle) &&
      C.Rectangle.contains(
        warmTargetTile.rectangle,
        scene.camera.positionCartographic,
      );
    const warmReferenceOrigin =
      providerAfterSwap?._quadtree?._cameraReferenceFrameOriginCartographic ??
      globe._surface?._cameraReferenceFrameOriginCartographic;
    const warmReferenceInsideTarget =
      Boolean(warmReferenceOrigin && warmTargetTile?.rectangle) &&
      C.Rectangle.contains(warmTargetTile.rectangle, warmReferenceOrigin);
    const warmParentTile = findInstantiatedTile(fillTarget.parentKey);
    const warmDrawingBufferHeight =
      scene.frameState.context.drawingBufferHeight;
    const warmPixelRatio = scene.frameState.pixelRatio;
    const warmSseDenominator = scene.camera.frustum.sseDenominator;
    const warmLevelZeroGeometricError =
      providerAfterSwap.getLevelMaximumGeometricError(0);
    const warmLevelOneGeometricError =
      providerAfterSwap.getLevelMaximumGeometricError(1);
    const computeWarmSse = (geometricError, tile) =>
      Number.isFinite(tile?._distance) && tile._distance > 0
        ? (geometricError * warmDrawingBufferHeight) /
          (tile._distance * warmSseDenominator * warmPixelRatio)
        : null;
    const warmParentComputedSse = computeWarmSse(
      warmLevelZeroGeometricError,
      warmParentTile,
    );
    const warmTargetComputedSse = computeWarmSse(
      warmLevelOneGeometricError,
      warmTargetTile,
    );
    const warmTargetSelectedDescendantTileIds =
      quantizedWarm.selectedTileIds.filter(
        (id) => levelOneAncestorId(id) === fillTarget.key,
      );
    const warmTargetRealDescendantTileIds = quantizedWarm.realTileIds.filter(
      (id) => levelOneAncestorId(id) === fillTarget.key,
    );
    const warmTargetFillDescendantTileIds = quantizedWarm.fillTileIds.filter(
      (id) => levelOneAncestorId(id) === fillTarget.key,
    );
    const warmupProof = {
      proofCompletedBeforeArm: true,
      settled: quantizedWarm.settled,
      boundedMaxFrames: contract.fillWarmMaximumFrames,
      settleFrames: quantizedWarm.settleFrames,
      stableFrames: quantizedWarm.stableFrames,
      tilesLoaded: quantizedWarm.tilesLoaded,
      fillCount: quantizedWarm.fillCount,
      longitude: track.longitude,
      latitude: track.latitude,
      cameraHeightMeters: scene.camera.positionCartographic.height,
      cameraFovDegrees: C.Math.toDegrees(scene.camera.frustum.fov),
      maximumScreenSpaceError: globe.maximumScreenSpaceError,
      preloadSiblings: globe.preloadSiblings,
      preloadAncestors: globe.preloadAncestors,
      holdTargetUndefinedDuringWarmup: holdTarget === undefined,
      holdInterceptionEnabled: holdEnabled,
      heldRequestCount: held.size,
      reservedPromiseCount: reservedPromises.size,
      targetKey: fillTarget.key,
      targetRequestAttempts: requestAttemptsByKey.get(fillTarget.key) ?? 0,
      targetHeldPromisePresent: held.has(fillTarget.key),
      targetReservedPromisePresent: reservedPromises.has(fillTarget.key),
      selectedTileIds: quantizedWarm.selectedTileIds,
      realTileIds: quantizedWarm.realTileIds,
      fillTileIds: quantizedWarm.fillTileIds,
      targetSelectedDescendantTileIds: warmTargetSelectedDescendantTileIds,
      targetRealDescendantTileIds: warmTargetRealDescendantTileIds,
      targetFillDescendantTileIds: warmTargetFillDescendantTileIds,
      parentSelection: warmParentSelection,
      targetSelection: warmTargetSelection,
      visibilityTargetCallOrdinals: warmTargetVisibilityCalls.map(
        (call) => call.ordinal,
      ),
      cameraReference: {
        cameraCartographicInsideTarget: warmCameraInsideTarget,
        referenceFrameOriginDefined: Boolean(warmReferenceOrigin),
        referenceFrameOriginInsideTarget: warmReferenceInsideTarget,
        neededPositionInsideTarget:
          warmCameraInsideTarget || warmReferenceInsideTarget,
      },
      sseInputs: {
        drawingBufferHeight: warmDrawingBufferHeight,
        pixelRatio: warmPixelRatio,
        sseDenominator: warmSseDenominator,
        levelZeroGeometricError: warmLevelZeroGeometricError,
        levelOneGeometricError: warmLevelOneGeometricError,
        parentDistance: warmParentTile?._distance ?? null,
        targetDistance: warmTargetTile?._distance ?? null,
        parentComputedSse: warmParentComputedSse,
        targetComputedSse: warmTargetComputedSse,
      },
      selectedRealSiblingTileIds: warmSiblingSelections
        .map((entry) => entry.tileId)
        .sort(),
      selectedRealSiblingObservations: warmSiblingSelections,
      siblingKey: fillTarget.anchorKey,
    };
    if (
      !warmupProof.settled ||
      warmupProof.targetRequestAttempts !== 0 ||
      !warmupProof.holdTargetUndefinedDuringWarmup ||
      warmupProof.heldRequestCount !== 0 ||
      warmupProof.reservedPromiseCount !== 0 ||
      warmTargetSelectedDescendantTileIds.length !== 0 ||
      warmTargetRealDescendantTileIds.length !== 0 ||
      warmTargetFillDescendantTileIds.length !== 0 ||
      !warmParentSelection.sameFrame ||
      warmParentSelection.rawResult !== C.TileSelectionResult.REFINED ||
      warmParentSelection.wasKicked ||
      !warmTargetSelection.sameFrame ||
      warmTargetSelection.rawResult !== C.TileSelectionResult.CULLED ||
      warmTargetSelection.wasKicked ||
      warmCameraInsideTarget ||
      warmReferenceInsideTarget ||
      !Number.isFinite(warmParentComputedSse) ||
      !Number.isFinite(warmTargetComputedSse) ||
      warmParentComputedSse <= contract.fillFrontierMaximumScreenSpaceError ||
      warmTargetComputedSse > contract.fillFrontierMaximumScreenSpaceError ||
      warmTargetVisibilityCalls.length === 0 ||
      !warmTargetVisibilityCalls.every(
        (call) =>
          new Set([C.Visibility.PARTIAL, C.Visibility.FULL]).has(
            call.originalVisibility,
          ) &&
          call.returnedVisibility === C.Visibility.NONE &&
          call.overridden === true &&
          call.mode === "warm-mask",
      ) ||
      !warmSiblingSelections.some(
        (entry) => entry.tileId === fillTarget.anchorKey,
      )
    ) {
      visibilityDiagnostic.terminalReason =
        "quantized warm visibility-mask proof is inexact";
      throw new Error("quantized warm visibility-mask proof is inexact");
    }
    visibilityDiagnostic.state = "warm-proven";
    holdTarget = fillTarget;
    markProgress(contract.phases[2], "arm-exact-hold-and-pass-through-reveal");
    const holdArm = {
      afterSettledWarmup: warmupProof.settled,
      assignedAfterWarmProof: true,
      warmProofFrame: warmTargetSelection.selectionFrame,
      targetKey: holdTarget.key,
      holdInterceptionEnabledBefore: holdEnabled,
      targetRequestAttemptsBefore: requestAttemptsByKey.get(holdTarget.key),
      targetReservedBefore: reservedPromises.has(holdTarget.key),
      heldRequestCountBefore: held.size,
      visibilityModeBefore: visibilityMode,
      visibilityModeAfter: null,
      cameraMovedForReveal: false,
      cameraFovDegrees: C.Math.toDegrees(scene.camera.frustum.fov),
      cameraHeightMeters: scene.camera.positionCartographic.height,
      maximumScreenSpaceError: globe.maximumScreenSpaceError,
    };
    holdEnabled = true;
    const visibilityModeSwitch = {
      from: visibilityMode,
      to: "pass-through",
      warmFrame: warmTargetSelection.selectionFrame,
      revealFrame: null,
      sameTaskReveal: true,
    };
    visibilityMode = "pass-through";
    visibilityDiagnostic.mode = visibilityMode;
    holdArm.holdInterceptionEnabledAfter = holdEnabled;
    holdArm.visibilityModeAfter = visibilityMode;

    markProgress(
      contract.phases[2],
      "first-pass-through-render-and-fused-fill-capture",
    );
    const targetAttemptsBeforeReveal =
      requestAttemptsByKey.get(holdTarget.key) ?? 0;
    const revealFrameBefore = scene.frameState.frameNumber;
    const fillImageId = captureDocumentaryPng(contract.captureLabels[0]);
    const revealFrameAfter = scene.frameState.frameNumber;
    const cSnapshot = snapshotTerrain();
    const revealTargetSelection = tileSelectionObservation(holdTarget.key);
    visibilityModeSwitch.revealFrame = revealTargetSelection.selectionFrame;
    const revealSiblingSelections = selectedRealSiblingObservations(
      holdTarget,
      cSnapshot,
    );
    const targetAttemptsAfterReveal =
      requestAttemptsByKey.get(holdTarget.key) ?? 0;
    const heldKeys = [...held.keys()].sort();
    const targetSelectedStrictDescendantTileIds =
      cSnapshot.selectedTileIds.filter(
        (id) =>
          id !== holdTarget.key && levelOneAncestorId(id) === holdTarget.key,
      );
    const revealTargetVisibilityCalls = targetVisibilityCallsForFrame(
      revealTargetSelection.selectionFrame,
    );
    const revealTile = findInstantiatedTile(holdTarget.key);
    const revealTileData = revealTile?.data;
    const revealFill = revealTileData?.fill;
    const revealFillMesh = revealFill?.mesh;
    const fillMeshProof = {
      tileId: holdTarget.key,
      terrainFillMeshInstance: revealFill instanceof C.TerrainFillMesh,
      renderedMeshMatches:
        Boolean(revealFillMesh) &&
        revealTileData?.renderedMesh === revealFillMesh,
      realMeshAbsent: !revealTileData?.mesh,
      vertexCount:
        revealFillMesh?.vertexCountWithoutSkirts ??
        (revealFillMesh?.vertices?.length && revealFillMesh?.stride
          ? Math.floor(revealFillMesh.vertices.length / revealFillMesh.stride)
          : 0),
      indexCount: revealFillMesh?.indices?.length ?? 0,
    };
    restoreVisibilitySeam("immediately-after-reveal-snapshot");
    visibilityRestoration.immediateAfterReveal = true;
    visibilityRestoration.beforeRelease = true;
    visibilityDiagnostic.state = "restored";
    const firstRevealProof = {
      captureWasFirstRenderAfterPassThrough:
        revealFrameAfter === revealFrameBefore + 1,
      sameTaskModeSwitchAndCapture: true,
      noYieldBeforeCapture: true,
      frameBefore: revealFrameBefore,
      frameAfter: revealFrameAfter,
      frameDelta: revealFrameAfter - revealFrameBefore,
      longitude: track.longitude,
      latitude: track.latitude,
      cameraHeightMeters: scene.camera.positionCartographic.height,
      cameraFovDegrees: C.Math.toDegrees(scene.camera.frustum.fov),
      maximumScreenSpaceError: globe.maximumScreenSpaceError,
      targetRequestAttemptsBefore: targetAttemptsBeforeReveal,
      targetRequestAttemptsAfter: targetAttemptsAfterReveal,
      postArmTargetRequestAttempts:
        targetAttemptsAfterReveal - targetAttemptsBeforeReveal,
      targetSelection: revealTargetSelection,
      visibilityTargetCallOrdinals: revealTargetVisibilityCalls.map(
        (call) => call.ordinal,
      ),
      targetSelectedStrictDescendantTileIds,
      selectedRealSiblingTileIds: revealSiblingSelections
        .map((entry) => entry.tileId)
        .sort(),
      selectedRealSiblingObservations: revealSiblingSelections,
      siblingKey: fillTarget.anchorKey,
      heldKeys,
      heldRequestCount: held.size,
      loadedAndFillFlags: cSnapshot.loadedAndFillFlags,
      targetSelected: cSnapshot.selectedTileIds.includes(holdTarget.key),
      targetFill: cSnapshot.fillTileIds.includes(holdTarget.key),
      fillMesh: fillMeshProof,
    };
    if (
      !firstRevealProof.captureWasFirstRenderAfterPassThrough ||
      visibilityModeSwitch.revealFrame !== visibilityModeSwitch.warmFrame + 1 ||
      firstRevealProof.postArmTargetRequestAttempts !== 1 ||
      heldKeys.length !== 1 ||
      heldKeys[0] !== holdTarget.key ||
      !reservedPromises.has(holdTarget.key) ||
      !revealTargetSelection.sameFrame ||
      revealTargetSelection.rawResult !== C.TileSelectionResult.RENDERED ||
      revealTargetSelection.wasKicked ||
      revealTargetVisibilityCalls.length === 0 ||
      !revealTargetVisibilityCalls.every(
        (call) =>
          new Set([C.Visibility.PARTIAL, C.Visibility.FULL]).has(
            call.originalVisibility,
          ) &&
          call.returnedVisibility === call.originalVisibility &&
          call.overridden === false &&
          call.mode === "pass-through",
      ) ||
      !firstRevealProof.targetSelected ||
      !firstRevealProof.targetFill ||
      !fillMeshProof.terrainFillMeshInstance ||
      !fillMeshProof.renderedMeshMatches ||
      !fillMeshProof.realMeshAbsent ||
      !(fillMeshProof.vertexCount > 0) ||
      !(fillMeshProof.indexCount > 0) ||
      targetSelectedStrictDescendantTileIds.length !== 0 ||
      !revealSiblingSelections.some(
        (entry) => entry.tileId === fillTarget.anchorKey,
      ) ||
      !cSnapshot.loadedAndFillFlags ||
      !visibilityRestoration.restored
    ) {
      visibilityDiagnostic.terminalReason =
        "first pass-through render did not produce the exact held L1 fill";
      throw new Error(
        "first pass-through render did not produce the exact held L1 fill",
      );
    }
    visibilityDiagnostic.state = "revealed";
    let heldDecodeWaitFrames = 0;
    while (!held.get(holdTarget.key)?.ready && heldDecodeWaitFrames < 120) {
      heldDecodeWaitFrames++;
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    phases[contract.phases[2]] = {
      ...cSnapshot,
      holdTarget,
      warmup: warmupProof,
      holdArm,
      firstRevealProof,
      visibilitySeam: {
        claim:
          "controlled-visibility-input-production-selection-request-fill-release-render",
        method: "GlobeSurfaceTileProvider.computeTileVisibility",
        maskMode: "warm-only-exact-target-Visibility.NONE",
        targetKey: holdTarget.key,
        siblingKey: fillTarget.anchorKey,
        maximumScreenSpaceError: globe.maximumScreenSpaceError,
        installation: visibilityInstallation,
        calls: visibilityCalls.map((call) => ({ ...call })),
        counts: { ...visibilityCounts },
        warmTargetCallOrdinals: warmTargetVisibilityCalls.map(
          (call) => call.ordinal,
        ),
        revealTargetCallOrdinals: revealTargetVisibilityCalls.map(
          (call) => call.ordinal,
        ),
        modeSwitch: visibilityModeSwitch,
        restoration: visibilityRestoration,
      },
      holdInterceptionEnabled: holdEnabled,
      cameraFovDegrees: C.Math.toDegrees(scene.camera.frustum.fov),
      maximumScreenSpaceError: globe.maximumScreenSpaceError,
      preloadSiblings: globe.preloadSiblings,
      holdTargetRequestAttemptsAfterArm: targetAttemptsAfterReveal,
      holdTargetReserved: reservedPromises.has(holdTarget.key),
      heldRequestCount: held.size,
      heldKeys,
      heldTargetIntersectsSelectedFill:
        cSnapshot.selectedTileIds.includes(holdTarget.key) &&
        cSnapshot.fillTileIds.includes(holdTarget.key),
      realSiblingTileIds: firstRevealProof.selectedRealSiblingTileIds,
      heldDecodeWaitFrames,
      heldTargetDecodedBeforeRelease: held.get(holdTarget.key)?.ready === true,
      decodedFixtureIdentity:
        decodedQuantizedMeshInstances > 0 && decodedIdentityMismatches === 0
          ? "QuantizedMeshTerrainData-instance"
          : "identity-mismatch",
      decodedFixtureIdentityVerified:
        decodedQuantizedMeshInstances > 0 && decodedIdentityMismatches === 0,
      decodedFixtureBounds: [...decodedFixtureBounds.values()].sort(
        (left, right) => left.tileId.localeCompare(right.tileId),
      ),
      imageId: fillImageId,
    };
    completePhase(contract.phases[2], {
      heldRequestCount: held.size,
      realMeshCount: cSnapshot.realMeshCount,
      fillCount: cSnapshot.fillCount,
    });
  } catch (error) {
    visibilityDiagnostic.terminalReason ??= `controlled visibility seam failed: ${error?.message ?? String(error)}`;
    throw error;
  } finally {
    const restorationAttempt = visibilityRestored
      ? "finally-verification"
      : "finally-after-error";
    restoreVisibilitySeam(restorationAttempt);
    visibilityRestoration.finallyVerified =
      visibilityRestoration.restored &&
      providerBeforeSwap.computeTileVisibility ===
        originalComputeTileVisibility;
    if (!visibilityRestoration.finallyVerified) {
      visibilityDiagnostic.terminalReason =
        "computeTileVisibility restoration verification failed";
    }
  }
  if (!visibilityRestoration.finallyVerified) {
    throw new Error("computeTileVisibility restoration verification failed");
  }

  markProgress(contract.phases[3], "release-held-requests", {
    heldKeys: [...held.keys()].sort(),
  });
  const releasedKeys = [...held.keys()].sort();
  const heldRequestCountBeforeRelease = terrainRequests.held;
  const releasedRequestCountBeforeRelease = terrainRequests.released;
  holdEnabled = false;
  for (const entry of held.values()) entry.release();
  held.clear();
  reservedPromises.clear();
  let transitionObservation;
  let transitionFrame = 0;
  let transitionLatest;
  const transitionSettle = await settleThen(300, () => {
    transitionFrame++;
    transitionLatest = snapshotTerrain();
    if (
      !transitionObservation &&
      transitionLatest.selectedTileIds.includes(holdTarget.key) &&
      transitionLatest.realTileIds.includes(holdTarget.key) &&
      !transitionLatest.fillTileIds.includes(holdTarget.key)
    ) {
      transitionObservation = {
        tileId: holdTarget.key,
        selected: true,
        renderedReal: true,
        renderedFill: false,
        frame: transitionFrame,
      };
    }
    progress.settle = {
      frame: transitionFrame,
      maxFrames: 300,
      transitionObserved: Boolean(transitionObservation),
      selectedCount: transitionLatest.selectedCount,
      realMeshCount: transitionLatest.realMeshCount,
      fillCount: transitionLatest.fillCount,
      decodedQuantizedMeshCount: transitionLatest.decodedQuantizedMeshCount,
      tilesLoaded: transitionLatest.tilesLoaded,
    };
    return (
      Boolean(transitionObservation) &&
      transitionLatest.tilesLoaded &&
      transitionLatest.fillCount === 0 &&
      transitionLatest.decodedQuantizedMeshCount > 0
    );
  });
  const transitionedKeys = transitionObservation ? [holdTarget.key] : [];
  setNadirCamera(track.latitude);
  scene.camera.frustum.fov = C.Math.toRadians(contract.cameraFovDegrees);
  globe.maximumScreenSpaceError = contract.terrainMaximumScreenSpaceError;
  const trackRestore = await settleTerrain(
    (state) => state.tilesLoaded && state.fillCount === 0,
    240,
  );
  const trackRestoreProof = {
    settled: trackRestore.settled,
    boundedMaxFrames: 240,
    settleFrames: trackRestore.settleFrames,
    stableFrames: trackRestore.stableFrames,
    longitude: C.Math.toDegrees(scene.camera.positionCartographic.longitude),
    latitude: C.Math.toDegrees(scene.camera.positionCartographic.latitude),
    cameraHeightMeters: scene.camera.positionCartographic.height,
    cameraFovDegrees: C.Math.toDegrees(scene.camera.frustum.fov),
    maximumScreenSpaceError: globe.maximumScreenSpaceError,
    targetLongitude: track.longitude,
    targetLatitude: track.latitude,
  };
  const realX1ImageId = captureDocumentaryPng(contract.captureLabels[1]);
  const d = {
    ...snapshotTerrain(),
    settled: transitionSettle.settled && trackRestore.settled,
    transitionObservation,
    trackRestore: trackRestoreProof,
  };
  phases[contract.phases[3]] = {
    ...d,
    holdTargetKey: holdTarget.key,
    holdInterceptionEnabled: holdEnabled,
    visibilitySeamRestoredBeforeRelease:
      visibilityRestoration.finallyVerified && visibilityRestored,
    heldRequestCountAfterRelease: held.size,
    releasedKeys,
    releasedTargetKey: releasedKeys[0] ?? null,
    releasedRequestCount:
      terrainRequests.released - releasedRequestCountBeforeRelease,
    newHeldRequestCountAfterRelease:
      terrainRequests.held - heldRequestCountBeforeRelease,
    transitionedKeys,
    imageId: realX1ImageId,
  };
  completePhase(contract.phases[3], {
    settled: d.settled,
    tilesLoaded: d.tilesLoaded,
    transitionedKeys,
  });

  const pipelineIdentities = new WeakMap();
  let nextPipelineIdentity = 0;
  const identifyPipeline = (pipeline) => {
    let identity = pipelineIdentities.get(pipeline);
    if (!identity) {
      identity = `pipeline-${++nextPipelineIdentity}`;
      pipelineIdentities.set(pipeline, identity);
    }
    return identity;
  };
  const inspectWebGPUGlobeMaterialization = (carrierState, eclipseEnabled) => {
    const commands = scene.frameState.commandList.filter(
      (command) =>
        command?.isWebGPUDrawCommand === true && command?.pass === C.Pass.GLOBE,
    );
    const materialized = commands.filter(
      (command) =>
        command?._pipeline &&
        command?._vertexBuffer &&
        command?._indexBuffer &&
        Number.isInteger(command?._indexCount) &&
        command._indexCount > 0,
    );
    const shadow = scene.frameState.eclipseGlobeShadow;
    return {
      carrierState,
      eclipseEnabled,
      lightingFlagMatches: lighting.enableEclipseGlobeShadow === eclipseEnabled,
      frameShadowPrepared: scene.frameState.eclipseGlobeShadowPrepared === true,
      frameShadowActive: shadow?.active === true,
      frameShadowGate: shadow?.params?.x ?? null,
      frameShadowRevision: shadow?.revision ?? null,
      frameSelectionRevision:
        scene.frameState.eclipseGlobeShadowSelectionRevision ?? null,
      route: "scene.frameState.commandList/Pass.GLOBE/native-WebGPU",
      commandIdentity: "isWebGPUDrawCommand===true+pass===Pass.GLOBE",
      emittedCommandCount: commands.length,
      materializedCommandCount: materialized.length,
      positiveIndexCommandCount: commands.filter(
        (command) =>
          Number.isInteger(command?._indexCount) && command._indexCount > 0,
      ).length,
      threeDynamicOffsetCommandCount: commands.filter(
        (command) => command?._bindGroup0DynamicOffsets?.length === 3,
      ).length,
      pipelineIdentityIds: [
        ...new Set(
          materialized.map((command) => identifyPipeline(command._pipeline)),
        ),
      ].sort(),
      pipelineLabels: [
        ...new Set(
          materialized
            .map((command) => command._pipeline?.label)
            .filter((label) => typeof label === "string" && label.length > 0),
        ),
      ].sort(),
      ownerTileIds: [
        ...new Set(materialized.map((command) => tileId(command.owner))),
      ].sort(),
      frameNumber: scene.frameState.frameNumber,
    };
  };
  const prewarmWebGPUGlobeCarrierState = async (
    carrierState,
    eclipseEnabled,
    expectedOwnerTileIds,
  ) => {
    if (contract.renderer !== "webgpu") {
      return {
        applicable: false,
        reason: "WebGPU-only native globe command materialization",
      };
    }
    let proof;
    let settled = false;
    let frames = 0;
    while (frames < contract.webgpuPrewarmMaxFrames) {
      renderNow();
      frames++;
      proof = inspectWebGPUGlobeMaterialization(carrierState, eclipseEnabled);
      const shadowStateMatches = eclipseEnabled
        ? proof.frameShadowActive === true && proof.frameShadowGate > 0.5
        : proof.frameShadowActive === false && proof.frameShadowGate === 0;
      settled =
        proof.lightingFlagMatches &&
        proof.frameShadowPrepared &&
        shadowStateMatches &&
        proof.emittedCommandCount > 0 &&
        proof.materializedCommandCount === proof.emittedCommandCount &&
        proof.positiveIndexCommandCount === proof.emittedCommandCount &&
        proof.threeDynamicOffsetCommandCount === proof.emittedCommandCount &&
        proof.pipelineIdentityIds.length > 0 &&
        proof.ownerTileIds.length === expectedOwnerTileIds.length &&
        proof.ownerTileIds.every(
          (id, index) => id === expectedOwnerTileIds[index],
        );
      if (settled) break;
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return {
      applicable: true,
      boundedMaxFrames: contract.webgpuPrewarmMaxFrames,
      frames,
      settled,
      ...proof,
    };
  };

  markProgress(contract.phases[4], "settle-exaggerated-terrain");
  scene.verticalExaggeration = contract.verticalExaggeration;
  scene.verticalExaggerationRelativeHeight = contract.relativeHeight;
  const eSettled = await settleTerrain(
    (state) => state.tilesLoaded && state.fillCount === 0,
    240,
  );
  const expectedX2OwnerTileIds = [...eSettled.selectedTileIds].sort();
  lighting.enableEclipseGlobeShadow = false;
  const x2OffPrewarm = await prewarmWebGPUGlobeCarrierState(
    "OFF",
    false,
    expectedX2OwnerTileIds,
  );
  const x2OffImageId = captureDocumentaryPng(contract.captureLabels[2]);
  lighting.enableEclipseGlobeShadow = true;
  const x2OnPrewarm = await prewarmWebGPUGlobeCarrierState(
    "ON",
    true,
    expectedX2OwnerTileIds,
  );
  const x2OnImageId = captureDocumentaryPng(contract.captureLabels[3]);
  const sameMaterializedPipelines =
    contract.renderer === "webgpu" &&
    x2OffPrewarm.pipelineIdentityIds.length ===
      x2OnPrewarm.pipelineIdentityIds.length &&
    x2OffPrewarm.pipelineIdentityIds.every(
      (identity, index) => identity === x2OnPrewarm.pipelineIdentityIds[index],
    );
  const e = snapshotTerrain();
  const ellipsoidMaximumRadius =
    providerAfterSwap.tilingScheme.ellipsoid.maximumRadius;
  const exaggeratedMinimum =
    (e.knownMinimumHeight -
      contract.radiusLaw.fillSkirtAllowanceMeters -
      contract.relativeHeight) *
      contract.verticalExaggeration +
    contract.relativeHeight;
  const exaggeratedMaximum =
    (e.knownMaximumHeight - contract.relativeHeight) *
      contract.verticalExaggeration +
    contract.relativeHeight;
  const unprotectedRadius =
    ellipsoidMaximumRadius +
    Math.max(Math.abs(exaggeratedMinimum), Math.abs(exaggeratedMaximum));
  const radiusSafety = Math.max(
    contract.radiusLaw.absoluteSafetyMeters,
    unprotectedRadius * contract.radiusLaw.relativeSafety,
  );
  const expectedSurfaceRadius = unprotectedRadius + radiusSafety;
  phases[contract.phases[4]] = {
    ...e,
    settled: eSettled.settled,
    ellipsoidMaximumRadius,
    verticalExaggeration: scene.frameState.verticalExaggeration,
    verticalExaggerationRelativeHeight:
      scene.frameState.verticalExaggerationRelativeHeight,
    expectedSurfaceRadius,
    mainViewOwnerMatches:
      scene.frameState.eclipseGlobeShadow ===
      scene.frameState.view?._eclipseGlobeShadow,
    prepared: scene.frameState.eclipseGlobeShadowPrepared === true,
    preparedSelectionRevision:
      scene.frameState.eclipseGlobeShadowSelectionRevision,
    preparedSurfaceRadius: scene.frameState.eclipseGlobeShadowSurfaceRadius,
    preparedSelectedTileIds: e.selectedTileIds,
    selectedTileIds: e.selectedTileIds,
    webgpuCommandMaterializationPrewarm:
      contract.renderer === "webgpu"
        ? {
            applicable: true,
            off: x2OffPrewarm,
            on: x2OnPrewarm,
            expectedOwnerTileIds: expectedX2OwnerTileIds,
            sameMaterializedPipelines,
            offBeforeOn: x2OffPrewarm.frameNumber < x2OnPrewarm.frameNumber,
            terminalCapturesAfterPrewarm: {
              off: x2OffPrewarm.settled,
              on: x2OnPrewarm.settled,
            },
          }
        : {
            applicable: false,
            reason: "WebGPU-only native globe command materialization",
          },
    imageIds: { off: x2OffImageId, on: x2OnImageId },
  };
  completePhase(contract.phases[4], {
    settled: eSettled.settled,
    tilesLoaded: e.tilesLoaded,
    fillCount: e.fillCount,
    surfaceRadius: e.surfaceRadius,
  });

  markProgress(contract.phases[5], "pick-start");
  globe.pickable = true;
  let updateForPickCalls = 0;
  let pickPostcondition;
  let pickExpected;
  const originalUpdateForPick = providerAfterSwap.updateForPick;
  providerAfterSwap.updateForPick = function (frameState) {
    updateForPickCalls++;
    const callOrdinal = updateForPickCalls;
    const expectedSelectionRevision = this._eclipseSelectionRevision;
    const expectedSurfaceRadius = this._eclipseSurfaceRadius;
    const result = originalUpdateForPick.call(this, frameState);
    pickPostcondition = {
      sampledAt: "same-updateForPick-call",
      callOrdinal,
      prepared: frameState.eclipseGlobeShadowPrepared === true,
      selectionRevision: frameState.eclipseGlobeShadowSelectionRevision,
      surfaceRadius: frameState.eclipseGlobeShadowSurfaceRadius,
      ownerMatches:
        frameState.eclipseGlobeShadow === frameState.view?._eclipseGlobeShadow,
    };
    pickExpected = {
      sampledAt: "same-updateForPick-call",
      callOrdinal,
      selectionRevision: expectedSelectionRevision,
      surfaceRadius: expectedSurfaceRadius,
    };
    return result;
  };
  let picked;
  let pickRenderPumpFrames;
  try {
    progress.pick.started = true;
    const pickOperation = scene.pickAsync(
      new C.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2),
    );
    const pickOutcome = await awaitFrameDrivenOperation(
      pickOperation,
      "scene.pickAsync",
      contract.pickMaxPumpFrames,
    );
    picked = pickOutcome.value;
    pickRenderPumpFrames = pickOutcome.renderPumpFrames;
    progress.pick.settled = true;
  } finally {
    providerAfterSwap.updateForPick = originalUpdateForPick;
  }
  phases[contract.phases[5]] = {
    method: "scene.pickAsync",
    awaited: true,
    settlement: "fulfilled",
    surrogateUsed: false,
    frameDriver: contract.pickFrameDriver,
    renderPumpFrames: pickRenderPumpFrames,
    pickResultKind: picked?.primitive === globe ? "globe" : typeof picked,
    updateForPickCalls,
    postcondition: pickPostcondition,
    expected: pickExpected,
  };
  completePhase(contract.phases[5], {
    updateForPickCalls,
    renderPumpFrames: pickRenderPumpFrames,
  });

  markProgress(contract.phases[6], "retained-capture-start");
  if (contract.renderer === "webgl") {
    phases[contract.phases[6]] = {
      applicable: false,
      reason: "WebGPU-only manager-driven retained capture",
    };
  } else {
    scene.context._options.webgpu ??= {};
    scene.context._options.webgpu.sceneCaptureReflections = true;
    const modelPosition = C.Cartesian3.fromDegrees(
      track.longitude,
      track.latitude,
      100,
    );
    const model = await C.Model.fromGltfAsync({
      url: contract.tinyModelRoute,
      modelMatrix: C.Transforms.eastNorthUpToFixedFrame(modelPosition),
      scale: 1,
    });
    scene.primitives.add(model);
    const manager = model.environmentMapManager;
    manager.enabled = true;
    manager.enableSceneCapture = false;
    await settleThen(180, () => model.ready === true);
    // Warm the ordinary manager graph and ensure the prior-frame terrain
    // producer has published the exact retained array before enabling capture.
    for (let index = 0; index < 4; index++) {
      renderNow();
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const sources = scene.context._webgpuSceneCaptureSources;
    const retainedTiles = [
      ...(sources?.tileProvider?._quadtree?._tilesToRender ?? []),
    ];
    const selectedTileIds = retainedTiles.map(tileId).sort();
    const retainedSelectionRevision =
      sources?.tileProvider?._eclipseSelectionRevision ?? null;
    const retainedSurfaceRadius =
      sources?.tileProvider?._eclipseSurfaceRadius ?? null;
    const globeRenderer = sources?.globeRenderer;
    const captureCalls = [];
    const originalCaptureCommands =
      globeRenderer?.getOrCreateCaptureTileCommands;
    if (typeof originalCaptureCommands !== "function") {
      throw new Error("retained globe capture command seam is unavailable");
    }
    globeRenderer.getOrCreateCaptureTileCommands = function (...args) {
      const frameState = args[3];
      const commands = originalCaptureCommands.apply(this, args);
      captureCalls.push({
        tileId: tileId(args[0]),
        prepared: frameState.eclipseGlobeShadowPrepared === true,
        preparedSelectionRevision:
          frameState.eclipseGlobeShadowSelectionRevision,
        preparedSurfaceRadius: frameState.eclipseGlobeShadowSurfaceRadius,
        dynamicOffsetLengths: (commands ?? []).map(
          (command) => command.bindGroup0DynamicOffsets?.length ?? 0,
        ),
        positiveDraws: (commands ?? []).filter(
          (command) => command.indexCount > 0,
        ).length,
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
    // Clear only the transient FrameState aliases. The View-owned block,
    // provider radius/revision, retained selection, and manager cache remain.
    scene.frameState.eclipseGlobeShadow = undefined;
    scene.frameState.eclipseGlobeShadowPrepared = false;
    scene.frameState.eclipseGlobeShadowSurfaceRadius = undefined;
    scene.frameState.eclipseGlobeShadowSelectionRevision = undefined;
    manager.enableSceneCapture = true;
    manager.reset();
    renderNow();
    await Promise.resolve();
    const cache = manager._webgpuCache;
    const cameraAfter = {
      position: [
        uniformState.cameraPosition.x,
        uniformState.cameraPosition.y,
        uniformState.cameraPosition.z,
      ],
      view: Array.from(uniformState.view),
      projection: Array.from(uniformState.projection),
    };
    globeRenderer.getOrCreateCaptureTileCommands = originalCaptureCommands;
    const calledTileIds = [
      ...new Set(captureCalls.map((call) => call.tileId)),
    ].sort();
    const dynamicOffsetLengths = captureCalls.flatMap(
      (call) => call.dynamicOffsetLengths,
    );
    const positiveDrawCalls = captureCalls.reduce(
      (sum, call) => sum + call.positiveDraws,
      0,
    );
    const sameNumbers = (left, right) =>
      left.length === right.length &&
      left.every((value, index) => Object.is(value, right[index]));
    phases[contract.phases[6]] = {
      applicable: true,
      driver: "DynamicEnvironmentMapManager.update",
      directRunSceneCapture: false,
      transientAliasesOnlyCleared: true,
      managerResetRequested: true,
      selectedTileIds,
      calledTileIds,
      captureTileCalls: captureCalls.length,
      expectedCaptureTileCalls: 6 * selectedTileIds.length,
      positiveDrawCalls,
      dynamicOffsetLengths,
      eclipseBinding: contract.webgpuEclipseBinding,
      status:
        cache?.lastSceneCaptureResult === 2 ? "SUBMITTED" : "NOT_SUBMITTED",
      statusCode: cache?.lastSceneCaptureResult ?? null,
      preparedBeforeFirstTile: captureCalls[0]?.prepared === true,
      preparedSelectionRevision:
        captureCalls[0]?.preparedSelectionRevision ?? null,
      retainedSelectionRevision,
      preparedSurfaceRadius: captureCalls[0]?.preparedSurfaceRadius ?? null,
      retainedSurfaceRadius,
      cameraRestored:
        sameNumbers(cameraBefore.position, cameraAfter.position) &&
        sameNumbers(cameraBefore.view, cameraAfter.view) &&
        sameNumbers(cameraBefore.projection, cameraAfter.projection),
    };
    scene.primitives.remove(model);
  }
  completePhase(contract.phases[6], {
    applicable: phases[contract.phases[6]].applicable,
    status: phases[contract.phases[6]].status ?? "N/A",
  });

  markProgress(contract.phases[7], "fresh-provider-reset");
  const providerBeforeFinalSwap = getTileProvider();
  const contentRevisionBeforeFinalSwap =
    providerBeforeFinalSwap._sceneCaptureContentRevision;
  const selectionRevisionBeforeFinalSwap =
    providerBeforeFinalSwap._eclipseSelectionRevision;
  const freshEllipsoid = new C.EllipsoidTerrainProvider();
  let freshTerrainRequestAttempts = 0;
  const originalFreshRequestTileGeometry = freshEllipsoid.requestTileGeometry;
  freshEllipsoid.requestTileGeometry = function (...args) {
    freshTerrainRequestAttempts++;
    return originalFreshRequestTileGeometry.apply(this, args);
  };
  scene.terrainProvider = freshEllipsoid;
  const finalPublicAssignment = {
    sceneProviderMatches: scene.terrainProvider === freshEllipsoid,
    tileProviderAwaitingFirstBeginFrame:
      providerBeforeFinalSwap.terrainProvider !== freshEllipsoid,
    terrainRequestsBeforeFirstFrame: freshTerrainRequestAttempts,
  };
  let finalBeginFrameCallCount = 0;
  let finalFirstBeginFramePropagation;
  const originalFinalGlobeBeginFrame = globe.beginFrame;
  globe.beginFrame = function (frameState) {
    finalBeginFrameCallCount++;
    const result = originalFinalGlobeBeginFrame.call(this, frameState);
    if (finalBeginFrameCallCount === 1) {
      const propagatedProvider = getTileProvider();
      const terrainRequestAttemptsAtObservation = freshTerrainRequestAttempts;
      const selectionRevisionUnchanged =
        propagatedProvider?._eclipseSelectionRevision ===
        selectionRevisionBeforeFinalSwap;
      finalFirstBeginFramePropagation = {
        observedAt:
          "first-pinned-render-after-globe.beginFrame-before-selection-load",
        beginFrameCallOrdinal: finalBeginFrameCallCount,
        frameNumber: frameState.frameNumber,
        tileProviderIdentityPreserved:
          propagatedProvider === providerBeforeFinalSwap,
        tileProviderMatchesAssigned:
          propagatedProvider?.terrainProvider === freshEllipsoid,
        publicProviderMatchesAssigned: scene.terrainProvider === freshEllipsoid,
        surfaceRadiusUndefined:
          propagatedProvider?._eclipseSurfaceRadius === undefined,
        knownMinimumHeight: propagatedProvider?._eclipseKnownMinimumHeight,
        knownMaximumHeight: propagatedProvider?._eclipseKnownMaximumHeight,
        knownBoundsValid: propagatedProvider?._eclipseKnownBoundsValid,
        contentRevisionAdvanced:
          propagatedProvider?._sceneCaptureContentRevision >
          contentRevisionBeforeFinalSwap,
        contentRevisionBefore: contentRevisionBeforeFinalSwap,
        contentRevisionAtObservation:
          propagatedProvider?._sceneCaptureContentRevision,
        selectionRevisionUnchanged,
        selectionRevisionBefore: selectionRevisionBeforeFinalSwap,
        selectionRevisionAtObservation:
          propagatedProvider?._eclipseSelectionRevision,
        terrainRequestAttemptsAtObservation,
        observedBeforeSelectionAndLoad:
          terrainRequestAttemptsAtObservation === 0 &&
          selectionRevisionUnchanged,
      };
    }
    return result;
  };
  let finalFirstRenderFrameNumber;
  try {
    renderNow();
    finalFirstRenderFrameNumber = scene.frameState.frameNumber;
  } finally {
    globe.beginFrame = originalFinalGlobeBeginFrame;
  }
  finalFirstBeginFramePropagation = {
    ...finalFirstBeginFramePropagation,
    observedInFirstRender:
      finalBeginFrameCallCount === 1 &&
      finalFirstBeginFramePropagation?.frameNumber ===
        finalFirstRenderFrameNumber,
  };
  const immediateNextEpoch = snapshotTerrain();
  let nextEpoch;
  try {
    nextEpoch = await settleTerrain(
      (state) =>
        state.tilesLoaded &&
        state.selectedCount > 0 &&
        getTileProvider() === providerBeforeFinalSwap &&
        scene.terrainProvider === freshEllipsoid &&
        getTileProvider()?.terrainProvider === freshEllipsoid &&
        state.providerSelectionRevision >
          finalFirstBeginFramePropagation.selectionRevisionAtObservation,
      180,
    );
  } finally {
    freshEllipsoid.requestTileGeometry = originalFreshRequestTileGeometry;
  }
  const finalProvider = getTileProvider();
  phases[contract.phases[7]] = {
    fromProvider: "CesiumTerrainProvider-held",
    toProvider: "EllipsoidTerrainProvider-fresh",
    publicAssignment: finalPublicAssignment,
    firstBeginFramePropagation: finalFirstBeginFramePropagation,
    nextEpoch: {
      claimSource: "bounded-post-first-beginFrame-settle",
      immediateSnapshotUsedForClaim: false,
      immediateSnapshot: {
        selectedCount: immediateNextEpoch.selectedCount,
        tilesLoaded: immediateNextEpoch.tilesLoaded,
        selectionRevision: immediateNextEpoch.providerSelectionRevision,
      },
      settled: nextEpoch.settled,
      boundedMaxFrames: 180,
      settleFrames: nextEpoch.settleFrames,
      stableFrames: nextEpoch.stableFrames,
      tilesLoaded: nextEpoch.tilesLoaded,
      contentRevisionAdvanced:
        finalProvider._sceneCaptureContentRevision >
        contentRevisionBeforeFinalSwap,
      contentRevision: finalProvider._sceneCaptureContentRevision,
      providerIsFreshEllipsoid: scene.terrainProvider === freshEllipsoid,
      tileProviderMatchesFreshEllipsoid:
        finalProvider.terrainProvider === freshEllipsoid,
      selectionRevision: nextEpoch.providerSelectionRevision,
      selectionRevisionAdvanced:
        nextEpoch.providerSelectionRevision > selectionRevisionBeforeFinalSwap,
      selectedCount: nextEpoch.selectedCount,
      terrainRequestAttempts: freshTerrainRequestAttempts,
    },
  };
  completePhase(contract.phases[7], {
    providerIsFreshEllipsoid:
      phases[contract.phases[7]].nextEpoch.providerIsFreshEllipsoid,
  });

  return {
    renderer: contract.renderer,
    actualRenderer,
    browserMeasurementComplete: true,
    track,
    fixture: {
      pinnedIso: contract.pinnedIso,
      clockIso: C.JulianDate.toIso8601(viewer.clock.currentTime),
      cameraHeightMeters: contract.cameraHeightMeters,
      actualCameraHeightMeters: scene.camera.positionCartographic.height,
      cameraFovDegrees: C.Math.toDegrees(scene.camera.frustum.fov),
      viewport: {
        width: canvas.width,
        height: canvas.height,
      },
      trackDerivation: "live-f64-ephemeris-global-grid-plus-two-refinements",
      deepestTrack: track,
    },
    phases,
    captures,
    sameTaskCapture: {
      method: contract.captureMethod,
      canonicalSourcePinned: true,
      yieldBetweenRenderAndRead: false,
    },
    deviceGate: globalThis.__c1229S5DeviceGate ?? {
      gpuErrors: [],
      deviceLost: false,
    },
  };
};

function makePageContract(renderer) {
  return {
    renderer,
    runtimePath,
    pinnedIso: C12_29_S5_SCENE.pinnedIso,
    cameraHeightMeters: C12_29_S5_SCENE.cameraHeightMeters,
    cameraFovDegrees: C12_29_S5_SCENE.cameraFovDegrees,
    terrainMaximumScreenSpaceError:
      C12_29_S5_SCENE.terrainMaximumScreenSpaceError,
    fillFrontierMaximumScreenSpaceError:
      C12_29_S5_SCENE.fillFrontierMaximumScreenSpaceError,
    fillWarmMaximumFrames: C12_29_S5_SCENE.fillWarmMaximumFrames,
    verticalExaggeration: C12_29_S5_SCENE.verticalExaggeration,
    relativeHeight: C12_29_S5_SCENE.verticalExaggerationRelativeHeight,
    radiusLaw: { ...C12_29_S5_RADIUS_LAW },
    fixtureRoute: C12_29_S5_FIXTURE.baseRoute,
    tinyModelRoute:
      "/Specs/Data/Models/glTF-2.0/BoxTextured/glTF-Binary/BoxTextured.glb",
    phases: [...C12_29_S5_PHASES],
    captureLabels: [...C12_29_S5_CAPTURE_LABELS],
    captureMethod: C12_29_S5_CAPTURE_METHOD,
    diagnosticsSchema: C12_29_S5_DIAGNOSTICS_SCHEMA,
    pickFrameDriver: C12_29_S5_PICK_FRAME_DRIVER,
    pickMaxPumpFrames: C12_29_S5_PICK_MAX_PUMP_FRAMES,
    webgpuEclipseBinding: C12_29_S5_WEBGPU_ECLIPSE_BINDING,
    webgpuPrewarmMaxFrames: C12_29_S5_WEBGPU_PREWARM_MAX_FRAMES,
  };
}

async function comparePngs(leftPath, rightPath) {
  const left = await sharp(leftPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const right = await sharp(rightPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const sameDimensions =
    left.info.width === right.info.width &&
    left.info.height === right.info.height;
  if (!sameDimensions)
    return { sameDimensions, changedPixels: 0, maximumChannelDelta: 0 };
  let changedPixels = 0;
  let maximumChannelDelta = 0;
  for (let offset = 0; offset < left.data.length; offset += 4) {
    let pixelChanged = false;
    for (let channel = 0; channel < 3; channel++) {
      const delta = Math.abs(
        left.data[offset + channel] - right.data[offset + channel],
      );
      maximumChannelDelta = Math.max(maximumChannelDelta, delta);
      if (delta >= 3) pixelChanged = true;
    }
    if (pixelChanged) changedPixels++;
  }
  return { sameDimensions, changedPixels, maximumChannelDelta };
}

async function materializeSessionPngs(session, runId, paths) {
  const records = [];
  for (const capture of session.captures ?? []) {
    const match = /^data:image\/png;base64,([a-z0-9+/=]+)$/iu.exec(
      capture.dataUrl ?? "",
    );
    if (!match || !isUuidV4(capture.imageId)) {
      throw new Error(
        `${session.renderer}:${capture.label}: invalid PNG snapshot`,
      );
    }
    const bytes = Buffer.from(match[1], "base64");
    const metadata = await sharp(bytes).metadata();
    const fileName = `${runId}.${capture.imageId}.${session.renderer}.${capture.label}.png`;
    const file = path.join(paths.directory, fileName);
    createImmutableEvidence(file, bytes);
    const identity = fingerprintEvidenceFile(file);
    records.push({
      imageId: capture.imageId,
      label: capture.label,
      fileName,
      byteLength: bytes.byteLength,
      width: metadata.width,
      height: metadata.height,
      sha256: sha256(bytes),
      fingerprintVerified:
        identity.exists === true &&
        identity.byteLength === bytes.byteLength &&
        identity.sha256 === sha256(bytes),
      captureMethod: capture.captureMethod,
      renderTaskToken: capture.renderTaskToken,
      captureTaskToken: capture.captureTaskToken,
      absolutePath: file,
    });
  }
  session.images = records.map(
    ({ absolutePath: _absolutePath, ...record }) => record,
  );
  const off = records.find((record) => record.label === "real-x2-off");
  const on = records.find((record) => record.label === "real-x2-on");
  session.x2OffOnComparison =
    off && on
      ? await comparePngs(off.absolutePath, on.absolutePath)
      : { sameDimensions: false, changedPixels: 0, maximumChannelDelta: 0 };
  delete session.captures;
}

async function runBrowserSession(
  browser,
  renderer,
  baseIdentity,
  runId,
  paths,
) {
  const requestLedger = {
    started: 0,
    completed: 0,
    failed: 0,
    inFlight: 0,
    lastRequest: null,
    lastResponse: null,
    lastFailure: null,
  };
  const diagnostics = {
    schema: C12_29_S5_DIAGNOSTICS_SCHEMA,
    renderer,
    stage: "context-create",
    timeoutMs: PAGE_TIMEOUT_MS,
    node: {
      stage: "context-create",
      requestLedger,
      pageErrors: [],
      consoleErrors: [],
    },
    page: null,
  };
  const context = await browser.newContext({
    viewport: C12_29_S5_SCENE.viewport,
    deviceScaleFactor: 1,
  });
  const externalRequests = [];
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
  const pageErrors = [];
  const consoleErrors = [];
  const ignoredConsoleErrors = [];
  const failedRequests = [];
  const httpErrors = [];
  diagnostics.stage = "page-created";
  diagnostics.node.stage = "page-created";
  const inFlightRequests = new Set();
  const describeRequest = (request) => {
    try {
      const url = new URL(request.url());
      return {
        method: request.method(),
        resourceType: request.resourceType(),
        sameOrigin: url.origin === baseIdentity.origin,
        path: url.pathname,
      };
    } catch {
      return {
        method: request.method(),
        resourceType: request.resourceType(),
        sameOrigin: false,
        path: "[unparseable]",
      };
    }
  };
  page.on("request", (request) => {
    requestLedger.started++;
    requestLedger.inFlight++;
    requestLedger.lastRequest = describeRequest(request);
    inFlightRequests.add(request);
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (text.includes("/engine/Source/Widget/") && text.includes("MIME type")) {
      ignoredConsoleErrors.push(text);
    } else {
      consoleErrors.push(text);
    }
  });
  page.on("requestfailed", (request) => {
    if (inFlightRequests.delete(request)) {
      requestLedger.inFlight--;
      requestLedger.failed++;
    }
    requestLedger.lastFailure = {
      ...describeRequest(request),
      error: request.failure()?.errorText ?? "unknown request failure",
    };
    if (!externalRequests.includes(request.url())) {
      failedRequests.push({
        url: request.url(),
        error: request.failure()?.errorText ?? "unknown request failure",
      });
    }
  });
  page.on("requestfinished", (request) => {
    if (inFlightRequests.delete(request)) {
      requestLedger.inFlight--;
      requestLedger.completed++;
    }
  });
  page.on("response", (response) => {
    const request = response.request();
    requestLedger.lastResponse = {
      ...describeRequest(request),
      status: response.status(),
    };
    if (response.status() >= 400) {
      httpErrors.push({ url: response.url(), status: response.status() });
    }
  });
  let entryCaptured = false;
  const servedEntryPromise = new Promise((resolve, reject) => {
    page.on("response", (response) => {
      let url;
      try {
        url = new URL(response.url());
      } catch {
        return;
      }
      if (
        !entryCaptured &&
        url.origin === baseIdentity.origin &&
        url.pathname === runtimePath
      ) {
        entryCaptured = true;
        void response.body().then(
          (bytes) =>
            resolve({
              sessionLabel: renderer,
              ok: response.ok(),
              status: response.status(),
              byteLength: bytes.byteLength,
              sha256: sha256(bytes),
            }),
          reject,
        );
      }
    });
  });
  let session;
  try {
    diagnostics.stage = "navigation";
    diagnostics.node.stage = "navigation";
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
      {
        timeout: 90_000,
      },
    );
    diagnostics.stage = "device-gate-install";
    diagnostics.node.stage = "device-gate-install";
    await page.evaluate(() => {
      const gate = { gpuErrors: [], deviceLost: false };
      const device = globalThis.viewer.scene.context.device;
      device?.addEventListener?.("uncapturederror", (event) => {
        gate.gpuErrors.push(
          String(event?.error?.message ?? event?.error ?? "unknown"),
        );
      });
      if (device?.lost) {
        void device.lost.then((info) => {
          gate.deviceLost = true;
          gate.deviceLostReason = info?.reason ?? "unknown";
          gate.deviceLostMessage = info?.message ?? "";
        });
      }
      globalThis.__c1229S5DeviceGate = gate;
    });
    diagnostics.stage = "page-measurement";
    diagnostics.node.stage = "page-measurement";
    const measured = await awaitS5PageMeasurement({
      renderer,
      timeoutMs: PAGE_TIMEOUT_MS,
      nodeDiagnostics: diagnostics.node,
      measure: () =>
        page.evaluate(MEASURE_S5_SESSION, makePageContract(renderer)),
      readPageDiagnostics: () =>
        page.evaluate(() => globalThis.__c1229S5Progress ?? null),
    });
    diagnostics.stage = "device-gate-settle";
    diagnostics.node.stage = "device-gate-settle";
    await page.waitForTimeout(100);
    const settledDeviceGate = await page.evaluate(() => ({
      gpuErrors: [...(globalThis.__c1229S5DeviceGate?.gpuErrors ?? [])],
      deviceLost: globalThis.__c1229S5DeviceGate?.deviceLost === true,
      deviceLostReason:
        globalThis.__c1229S5DeviceGate?.deviceLostReason ?? null,
      deviceLostMessage:
        globalThis.__c1229S5DeviceGate?.deviceLostMessage ?? null,
    }));
    const servedEntry = await Promise.race([
      servedEntryPromise,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`${renderer} runtime identity timeout`)),
          15_000,
        ),
      ),
    ]);
    session = {
      ...measured,
      servedEntry,
      transport: {
        loopback: true,
        sameOriginOnly: externalRequests.length === 0,
        externalRequests,
        failedRequests,
        httpErrors,
      },
      runtime: {
        pageErrors,
        consoleErrors,
        ignoredConsoleErrors,
        gpuErrors: settledDeviceGate.gpuErrors,
        deviceLost: settledDeviceGate.deviceLost,
        deviceLostReason: settledDeviceGate.deviceLostReason,
        deviceLostMessage: settledDeviceGate.deviceLostMessage,
        cleanupComplete: false,
      },
    };
    diagnostics.stage = "png-materialization";
    diagnostics.node.stage = "png-materialization";
    await materializeSessionPngs(session, runId, paths);
  } catch (error) {
    if (!error?.s5Diagnostics) {
      const pageSnapshot = await snapshotS5PageProgress(page, renderer);
      diagnostics.stage = `${diagnostics.stage}-error`;
      diagnostics.node.stage = diagnostics.stage;
      diagnostics.node.pageDiagnosticRead = pageSnapshot.status;
      diagnostics.node.pageErrors = [...pageErrors];
      diagnostics.node.consoleErrors = [...consoleErrors];
      if (pageSnapshot.error) {
        diagnostics.node.pageDiagnosticReadError = pageSnapshot.error;
      }
      diagnostics.page = pageSnapshot.page;
      error.s5Diagnostics = cloneS5DiagnosticValue(diagnostics);
    }
    throw error;
  } finally {
    diagnostics.stage = "context-close";
    diagnostics.node.stage = "context-close";
    diagnostics.node.pageErrors = [...pageErrors];
    diagnostics.node.consoleErrors = [...consoleErrors];
    await context.close();
    if (session) session.runtime.cleanupComplete = true;
  }
  return session;
}

export async function withS5Watchdog(
  task,
  closeBrowser,
  timeoutMs = WATCHDOG_MS,
  drainTimeoutMs = WATCHDOG_DRAIN_MS,
) {
  if (!(timeoutMs > 0) || !(drainTimeoutMs > 0)) {
    throw new Error("S5 watchdog and drain timeouts must be positive");
  }
  let watchdogTimer;
  const taskPromise = Promise.resolve().then(task);
  // A non-rejecting tracker owns the losing task's eventual settlement, so a
  // bounded-drain failure cannot later surface as an unhandled rejection.
  const taskSettlement = taskPromise.then(
    (value) => ({ status: "fulfilled", value }),
    (error) => ({ status: "rejected", error }),
  );
  const watchdogError = new Error(`S5 watchdog fired after ${timeoutMs} ms`);
  watchdogError.code = "S5_WATCHDOG_TIMEOUT";
  const timeout = new Promise((_, reject) => {
    watchdogTimer = setTimeout(() => reject(watchdogError), timeoutMs);
  });
  try {
    return await Promise.race([taskPromise, timeout]);
  } catch (error) {
    if (error !== watchdogError) throw error;

    const closeSettlement = Promise.resolve()
      .then(closeBrowser)
      .then(
        () => ({ status: "fulfilled" }),
        (closeError) => ({ status: "rejected", error: closeError }),
      );
    const settleWithin = async (settlement, label) => {
      let drainTimer;
      const drainExpired = new Promise((resolve) => {
        drainTimer = setTimeout(
          () => resolve({ status: "timeout", label }),
          drainTimeoutMs,
        );
      });
      try {
        return await Promise.race([settlement, drainExpired]);
      } finally {
        clearTimeout(drainTimer);
      }
    };
    const [closeResult, taskResult] = await Promise.all([
      settleWithin(closeSettlement, "browser close"),
      settleWithin(taskSettlement, "losing browser task"),
    ]);
    if (
      closeResult.status !== "fulfilled" ||
      !new Set(["fulfilled", "rejected"]).has(taskResult.status)
    ) {
      const drainError = new Error(
        `S5 watchdog cleanup did not drain: close=${closeResult.status}, task=${taskResult.status}`,
        { cause: error },
      );
      drainError.code = "S5_WATCHDOG_UNDRAINED";
      drainError.retainS5RunningLock = true;
      drainError.closeResult = closeResult;
      drainError.taskResult = taskResult;
      throw drainError;
    }
    throw error;
  } finally {
    clearTimeout(watchdogTimer);
  }
}

export async function runC1229S5Probe(options = {}) {
  const runId = options.runId ?? randomUUID();
  const paths = createS5ArtifactPaths(runId, options.outputDirectory);
  const baseIdentity = validateS5LoopbackBase(options.base ?? base);
  beginS5EvidenceRun(paths, runId, options.operations ?? fs);
  const runDiagnostics = {
    schema: C12_29_S5_DIAGNOSTICS_SCHEMA,
    renderer: null,
    stage: "provenance-start",
    timeoutMs: PAGE_TIMEOUT_MS,
    node: {
      stage: "provenance-start",
      completedRenderers: [],
      activeRenderer: null,
      requestLedger: null,
    },
    page: null,
  };
  let browser;
  try {
    const provenanceStart = await collectS5ProvenanceSnapshot();
    runDiagnostics.stage = "browser-launch";
    runDiagnostics.node.stage = "browser-launch";
    browser = await chromium.launch({
      channel: "msedge",
      headless: true,
      timeout: 90_000,
      args: ["--enable-unsafe-webgpu", "--use-vulkan", "--disable-cache"],
    });
    runDiagnostics.stage = "browser-sessions";
    runDiagnostics.node.stage = "browser-sessions";
    const sessions = await withS5Watchdog(
      async () => {
        const values = [];
        for (const renderer of C12_29_S5_RENDERERS) {
          runDiagnostics.renderer = renderer;
          runDiagnostics.node.activeRenderer = renderer;
          values.push(
            await runBrowserSession(
              browser,
              renderer,
              baseIdentity,
              runId,
              paths,
            ),
          );
          runDiagnostics.node.completedRenderers.push(renderer);
        }
        return values;
      },
      async () => {
        await browser?.close();
        browser = undefined;
      },
      options.watchdogMs,
      options.watchdogDrainMs,
    );
    await browser.close();
    browser = undefined;
    runDiagnostics.renderer = null;
    runDiagnostics.node.activeRenderer = null;
    runDiagnostics.stage = "provenance-end";
    runDiagnostics.node.stage = "provenance-end";
    const provenanceEnd = await collectS5ProvenanceSnapshot();
    const provenance = assessS5Provenance(
      provenanceStart,
      provenanceEnd,
      sessions,
    );
    const report = {
      schema: C12_29_S5_SCHEMA,
      runId,
      generatedAt: new Date().toISOString(),
      provenance,
      sessions,
    };
    const verdict = foldC1229S5Gate(report);
    const artifact = {
      ...report,
      ...verdict,
      incomplete: false,
      artifactName: `${runId}.json`,
    };
    const publication = publishS5FinalArtifact(
      paths,
      artifact,
      options.operations ?? fs,
    );
    return { artifact, publication, paths };
  } catch (error) {
    if (error?.retainS5RunningLock === true) {
      throw error;
    }
    if (browser) {
      try {
        await browser.close();
      } catch {
        // A failed browser close keeps RUNNING+lock authoritative.
        throw error;
      }
    }
    const operations = options.operations ?? fs;
    const runAfterFailure = fingerprintEvidenceFile(paths.run, operations);
    if (
      runAfterFailure.exists === true ||
      (runAfterFailure.exists === false && runAfterFailure.error !== "ENOENT")
    ) {
      // Publication already began, or its archive identity is unreadable.
      // Retrying as ERROR could only collide with/mask the immutable archive;
      // leave the owned RUNNING lock authoritative for audit and recovery.
      error.retainS5RunningLock = true;
      throw error;
    }
    const artifact = {
      schema: C12_29_S5_SCHEMA,
      runId,
      generatedAt: new Date().toISOString(),
      status: "ERROR",
      exitCode: exitCodeForS5Status("ERROR"),
      incomplete: false,
      artifactName: `${runId}.json`,
      error: error?.stack ?? error?.message ?? String(error),
      diagnostics:
        cloneS5DiagnosticValue(error?.s5Diagnostics) ??
        cloneS5DiagnosticValue(runDiagnostics),
    };
    const publication = publishS5FinalArtifact(paths, artifact, operations);
    return { artifact, publication, paths };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === probePath) {
  const result = await runC1229S5Probe();
  console.log(
    JSON.stringify(
      {
        runId: result.artifact.runId,
        status: result.artifact.status,
        exitCode: result.artifact.exitCode,
        artifact: result.paths.run,
      },
      null,
      2,
    ),
  );
  process.exitCode = result.artifact.exitCode;
}
