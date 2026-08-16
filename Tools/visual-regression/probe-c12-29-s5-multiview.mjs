#!/usr/bin/env node
/**
 * C12-29 S5 same-context logical-View / stereo policy certification.
 * @purpose Logical-View/stereo policy certification: offscreen ray View, WebGL two-eye VR executor, WebGPU synchronous unsupported-path rejection
 * @status ACTIVE
 *
 * The A -> B -> A lane is deliberately Tools-owned. `Scene.render` is used to
 * settle the ordinary default view, but never to pretend that Cesium has an
 * arbitrary-View scheduler: production render currently restores
 * `_defaultView`. The packet separately exercises the real offscreen ray View,
 * WebGL's real two-eye VR executor, and WebGPU's synchronous unsupported-path
 * rejection.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import {
  C12_29_S5_MULTIVIEW_ARTIFACT_PREFIX,
  C12_29_S5_MULTIVIEW_BUILD_SOURCE_FILES,
  C12_29_S5_MULTIVIEW_BUILD_SOURCE_MAP,
  C12_29_S5_MULTIVIEW_OUTPUT_DIRECTORY,
  C12_29_S5_MULTIVIEW_PAGE_SCHEMA,
  C12_29_S5_MULTIVIEW_PHASES,
  C12_29_S5_MULTIVIEW_RENDERERS,
  C12_29_S5_MULTIVIEW_SCHEMA,
  C12_29_S5_MULTIVIEW_SOURCE_FILES,
  C12_29_S5_MULTIVIEW_WEBGPU_VR_ERROR,
  C12_29_S5_MULTIVIEW_WORKLOAD,
  createC1229S5MultiviewErrorArtifact,
  foldC1229S5MultiviewGate,
  isC1229S5MultiviewUuidV4,
  stableC1229S5MultiviewJson,
  validateC1229S5MultiviewFinalArtifact,
} from "./lib/c12-29-s5-multiview-gate.mjs";
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

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(toolDirectory, "../..");
const buildEntryPath = path.join(
  repositoryRoot,
  "Build/CesiumUnminified/index.js",
);
const buildSourceMapPath = path.join(
  repositoryRoot,
  C12_29_S5_MULTIVIEW_BUILD_SOURCE_MAP,
);
const runtimePath = "/Build/CesiumUnminified/index.js";
const viewerPath = "/Apps/CesiumViewer/index.html";
const defaultBase = process.env.PROBE_BASE ?? "http://localhost:8080";
const defaultOutputDirectory = path.resolve(
  process.env.C12_29_S5_MULTIVIEW_OUTPUT_DIR ??
    path.join(repositoryRoot, C12_29_S5_MULTIVIEW_OUTPUT_DIRECTORY),
);

const WATCHDOG_MS = 540_000;
const PAGE_TIMEOUT_MS = 240_000;
const CLOSE_TIMEOUT_MS = 15_000;
const WATCHDOG_SETTLEMENT_MS = CLOSE_TIMEOUT_MS + 5_000;
// The in-run watchdog plus its settlement, with a minute of slack, is the
// longest a healthy run can legitimately take; past that the process is stuck.
const PROCESS_WATCHDOG_MS = WATCHDOG_MS + WATCHDOG_SETTLEMENT_MS + 60_000;
const DIAGNOSTIC_ARRAY_LIMIT = 32;
const DIAGNOSTIC_STRING_LIMIT = 2_048;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const multiviewOwnershipAuthorities = new WeakMap();
const multiviewReleaseFences = new WeakSet();

export function normalizeC1229S5MultiviewDiagnosticStrings(value, category) {
  const source = Array.isArray(value) ? value : [value];
  const text = source.map((entry) => {
    let result;
    try {
      result = typeof entry === "string" ? entry : String(entry);
    } catch {
      result = `[multiview uninspectable ${category} entry]`;
    }
    return (
      result.slice(0, DIAGNOSTIC_STRING_LIMIT) ||
      `[multiview empty ${category} entry]`
    );
  });
  if (text.length <= DIAGNOSTIC_ARRAY_LIMIT) return text;
  const retained = DIAGNOSTIC_ARRAY_LIMIT - 1;
  return [
    ...text.slice(0, retained),
    `[MULTIVIEW_OVERFLOW ${category} total=${text.length} retained=${retained} omitted=${text.length - retained}]`,
  ];
}

export function validateC1229S5MultiviewLoopbackBase(value) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`multiview base is not absolute: ${error.message}`, {
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
      "multiview evidence base must be a credential-free loopback root",
    );
  }
  return { href: url.href, origin: url.origin };
}

export function createC1229S5MultiviewArtifactPaths(
  runId,
  directory = defaultOutputDirectory,
) {
  if (!isC1229S5MultiviewUuidV4(runId)) {
    throw new Error("multiview artifact paths require UUID v4");
  }
  directory = path.resolve(directory);
  return {
    directory,
    archive: path.join(directory, `${runId}.json`),
    latest: path.join(
      directory,
      `${C12_29_S5_MULTIVIEW_ARTIFACT_PREFIX}.latest.json`,
    ),
    lock: path.join(
      directory,
      `${C12_29_S5_MULTIVIEW_ARTIFACT_PREFIX}.lock.json`,
    ),
    firstRed: path.join(
      directory,
      `${C12_29_S5_MULTIVIEW_ARTIFACT_PREFIX}.first-red.json`,
    ),
    recovery: path.join(directory, `${runId}.publication-recovery.json`),
  };
}

function assertCanonicalRunPaths(paths, runId, label) {
  if (!isC1229S5MultiviewUuidV4(runId)) {
    throw new Error(`${label} runId is not UUID v4`);
  }
  const keys = [
    "directory",
    "archive",
    "latest",
    "lock",
    "firstRed",
    "recovery",
  ];
  if (
    !paths ||
    typeof paths !== "object" ||
    Reflect.ownKeys(paths).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(paths, key)) ||
    typeof paths.directory !== "string" ||
    paths.directory !== path.resolve(paths.directory)
  ) {
    throw new Error(`${label} paths are not an exact canonical path set`);
  }
  const expected = createC1229S5MultiviewArtifactPaths(runId, paths.directory);
  if (!keys.every((key) => paths[key] === expected[key])) {
    throw new Error(`${label} paths are not bound to the owned run`);
  }
  if (
    new Set(keys.slice(1).map((key) => canonicalPathKey(paths[key]))).size !== 5
  ) {
    throw new Error(`${label} canonical paths alias one another`);
  }
  return expected;
}

function readBytesIfPresent(file, operations = fs) {
  try {
    const bytes = operations.readFileSync(file);
    return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function readJsonIfPresent(file, operations = fs) {
  const bytes = readBytesIfPresent(file, operations);
  return bytes === undefined ? undefined : JSON.parse(bytes.toString("utf8"));
}

function exactBytes(file, expected, label, operations = fs) {
  const actual = readBytesIfPresent(file, operations);
  if (actual === undefined) throw new Error(`${label} is absent`);
  const expectedBytes = Buffer.isBuffer(expected)
    ? expected
    : Buffer.from(expected);
  if (!actual.equals(expectedBytes)) {
    throw new Error(`${label} bytes do not match owned authority`);
  }
  return actual;
}

function canonicalPathKey(file) {
  const resolved = path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function assertCanonicalDirectory(directory, label, operations = fs) {
  if (
    typeof operations.lstatSync !== "function" ||
    typeof operations.realpathSync !== "function"
  ) {
    throw new Error(`${label} directory authorities are unavailable`);
  }
  const descriptor = operations.lstatSync(directory);
  const real = operations.realpathSync(directory);
  const dev = String(descriptor.dev);
  const ino = String(descriptor.ino);
  const mode = Number(descriptor.mode);
  if (
    descriptor.isDirectory() !== true ||
    descriptor.isSymbolicLink() === true ||
    canonicalPathKey(real) !== canonicalPathKey(directory) ||
    !/^\d+$/u.test(dev) ||
    !/^\d+$/u.test(ino) ||
    !Number.isSafeInteger(mode) ||
    mode < 0
  ) {
    throw new Error(`${label} directory is not canonical and symlink-free`);
  }
  return { path: directory, dev, ino, mode };
}

function assertDirectoryAuthority(authority, label, operations = fs) {
  const actual = assertCanonicalDirectory(authority.path, label, operations);
  if (
    actual.dev !== authority.dev ||
    actual.ino !== authority.ino ||
    actual.mode !== authority.mode
  ) {
    throw new Error(`${label} directory identity changed`);
  }
}

function publicDirectoryAuthority(authority) {
  return Object.freeze({ ...authority });
}

function samePublicDirectoryAuthority(value, authority) {
  return (
    value &&
    Reflect.ownKeys(value).length === 4 &&
    value.path === authority.path &&
    value.dev === authority.dev &&
    value.ino === authority.ino &&
    value.mode === authority.mode
  );
}

function inspectImmutableDescriptor(file, label, operations = fs) {
  if (typeof operations.lstatSync !== "function") {
    throw new Error(`${label} lstat authority is unavailable`);
  }
  const descriptor = operations.lstatSync(file);
  const dev = String(descriptor.dev);
  const ino = String(descriptor.ino);
  const mode = Number(descriptor.mode);
  const nlink = Number(descriptor.nlink);
  const size = Number(descriptor.size);
  const mtimeMs = Number(descriptor.mtimeMs);
  const ctimeMs = Number(descriptor.ctimeMs);
  if (
    descriptor.isFile() !== true ||
    descriptor.isSymbolicLink() === true ||
    !/^\d+$/u.test(dev) ||
    !/^\d+$/u.test(ino) ||
    !Number.isSafeInteger(mode) ||
    mode < 0 ||
    !Number.isSafeInteger(nlink) ||
    nlink !== 1 ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    !Number.isFinite(mtimeMs) ||
    !Number.isFinite(ctimeMs)
  ) {
    throw new Error(`${label} is not one uniquely linked regular file`);
  }
  return {
    dev,
    ino,
    mode,
    nlink,
    size,
    mtimeMs,
    ctimeMs,
  };
}

function sameImmutableDescriptor(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function sameFileObjectIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size
  );
}

function resolveImmutableArchivePath(paths, artifact, label) {
  const directory = path.resolve(paths.directory);
  const expectedName = `${artifact.runId}.json`;
  const archive = path.resolve(directory, artifact.artifactName);
  const expectedArchive = path.resolve(directory, expectedName);
  const reserved = [
    paths.archive,
    paths.latest,
    paths.lock,
    paths.firstRed,
    paths.recovery,
  ].map(canonicalPathKey);
  if (
    artifact.artifactName !== expectedName ||
    canonicalPathKey(path.dirname(archive)) !== canonicalPathKey(directory) ||
    canonicalPathKey(archive) !== canonicalPathKey(expectedArchive) ||
    reserved.includes(canonicalPathKey(archive))
  ) {
    throw new Error(
      `multiview ${label} immutable archive path is not canonical-safe`,
    );
  }
  return archive;
}

function assertImmutableFileAuthority(authority, label, operations = fs) {
  if (authority === null) return;
  try {
    const before = inspectImmutableDescriptor(
      authority.path,
      `${label} descriptor`,
      operations,
    );
    if (!sameImmutableDescriptor(before, authority.descriptor)) {
      throw new Error("descriptor identity changed");
    }
    exactBytes(authority.path, authority.bytes, `${label} bytes`, operations);
    const after = inspectImmutableDescriptor(
      authority.path,
      `${label} descriptor after read`,
      operations,
    );
    if (
      !sameImmutableDescriptor(before, after) ||
      !sameImmutableDescriptor(after, authority.descriptor)
    ) {
      throw new Error("descriptor identity raced during exact read");
    }
  } catch (error) {
    throw new Error(`${label} is unavailable, unsafe, or differs`, {
      cause: error,
    });
  }
}

function assertPriorArchiveAuthority(authority, label, operations = fs) {
  assertImmutableFileAuthority(
    authority,
    `multiview ${label} prior immutable archive`,
    operations,
  );
}

function captureImmutableFileAuthority(file, bytes, label, operations = fs) {
  let descriptor;
  try {
    descriptor = inspectImmutableDescriptor(
      file,
      `${label} descriptor`,
      operations,
    );
  } catch (error) {
    throw new Error(`${label} is unavailable or descriptor-unsafe`, {
      cause: error,
    });
  }
  const authority = {
    path: file,
    bytes: Buffer.from(bytes),
    descriptor,
  };
  assertImmutableFileAuthority(authority, label, operations);
  return authority;
}

function publicImmutableAuthority(authority) {
  if (authority === null) return null;
  return Object.freeze({
    path: authority.path,
    byteLength: authority.bytes.byteLength,
    sha256: sha256(authority.bytes),
    descriptor: Object.freeze({ ...authority.descriptor }),
  });
}

function samePublicImmutableAuthority(value, authority) {
  if (authority === null) return value === null;
  const expected = publicImmutableAuthority(authority);
  return (
    value &&
    Reflect.ownKeys(value).length === 4 &&
    value.path === expected.path &&
    value.byteLength === expected.byteLength &&
    value.sha256 === expected.sha256 &&
    value.descriptor &&
    Reflect.ownKeys(value.descriptor).length ===
      Reflect.ownKeys(expected.descriptor).length &&
    Reflect.ownKeys(expected.descriptor).every(
      (key) => value.descriptor[key] === expected.descriptor[key],
    )
  );
}

function inspectPriorLatestAuthority(paths, priorLatestBytes, operations = fs) {
  let priorLatest;
  try {
    priorLatest = JSON.parse(priorLatestBytes.toString("utf8"));
    const validation = validateC1229S5MultiviewFinalArtifact(priorLatest);
    if (
      priorLatest.schema !== C12_29_S5_MULTIVIEW_SCHEMA ||
      !validation.ok ||
      !priorLatestBytes.equals(
        Buffer.from(stableC1229S5MultiviewJson(priorLatest, 2)),
      )
    ) {
      throw new Error(
        validation.reasons.join("; ") || "schema/canonical drift",
      );
    }
  } catch (error) {
    throw new Error("multiview prior latest is not an exact canonical final", {
      cause: error,
    });
  }
  const archive = resolveImmutableArchivePath(paths, priorLatest, "prior");
  let authority;
  try {
    authority = captureImmutableFileAuthority(
      archive,
      priorLatestBytes,
      "multiview initial prior immutable archive",
      operations,
    );
  } catch (error) {
    throw new Error(
      "multiview initial prior immutable archive is unavailable, unsafe, or differs",
      { cause: error },
    );
  }
  return { priorLatest, authority };
}

function createExclusive(file, bytes, label, operations = fs) {
  operations.writeFileSync(file, bytes, { flag: "wx" });
  exactBytes(file, bytes, label, operations);
}

function restoreExclusive(file, bytes, label, operations = fs) {
  try {
    createExclusive(file, bytes, label, operations);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
}

function assertOwnedLockAuthority(
  lockPath,
  lockBytes,
  authority,
  label,
  operations = fs,
) {
  exactBytes(lockPath, lockBytes, label, operations);
  if (authority === undefined) return;
  if (
    authority.path !== lockPath ||
    !authority.bytes.equals(Buffer.from(lockBytes))
  ) {
    throw new Error(`${label} does not match the bound lock authority`);
  }
  assertImmutableFileAuthority(authority, `${label} descriptor`, operations);
}

/**
 * Claim the exact canonical entry this run owns. A raced foreign entry is
 * restored exclusively or retained at its unique receipt; it is never
 * overwritten or unlinked.
 */
export function claimC1229S5MultiviewCanonical(
  canonical,
  expectedBytes,
  lockPath,
  lockBytes,
  tag,
  operations = fs,
  lockAuthority = undefined,
) {
  assertOwnedLockAuthority(
    lockPath,
    lockBytes,
    lockAuthority,
    `${tag} owned lock before claim`,
    operations,
  );
  const receipt = `${canonical}.${tag}-${randomUUID()}.receipt`;
  operations.renameSync(canonical, receipt);
  let claimed;
  try {
    claimed = exactBytes(
      receipt,
      expectedBytes,
      `${tag} claimed canonical receipt`,
      operations,
    );
  } catch (error) {
    const foreign = readBytesIfPresent(receipt, operations);
    if (foreign !== undefined) {
      restoreExclusive(
        canonical,
        foreign,
        `${tag} foreign canonical restoration`,
        operations,
      );
    }
    throw new Error(
      `${tag} canonical claim captured foreign bytes; receipt retained at ${receipt}`,
      { cause: error },
    );
  }
  assertOwnedLockAuthority(
    lockPath,
    lockBytes,
    lockAuthority,
    `${tag} owned lock after claim`,
    operations,
  );
  if (readBytesIfPresent(canonical, operations) !== undefined) {
    throw new Error(`${tag} canonical path was occupied after claim`);
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
  lockAuthority = undefined,
) {
  const claim = claimC1229S5MultiviewCanonical(
    canonical,
    expectedBytes,
    lockPath,
    lockBytes,
    tag,
    operations,
    lockAuthority,
  );
  try {
    createExclusive(
      canonical,
      replacementBytes,
      `${tag} exclusive replacement`,
      operations,
    );
    assertOwnedLockAuthority(
      lockPath,
      lockBytes,
      lockAuthority,
      `${tag} replacement lock`,
      operations,
    );
  } catch (error) {
    if (
      !restoreExclusive(
        canonical,
        claim.claimedBytes,
        `${tag} canonical rollback`,
        operations,
      )
    ) {
      throw new AggregateError(
        [error],
        `${tag} failed and a foreign canonical entry appeared`,
        { cause: error },
      );
    }
    throw error;
  }
  operations.unlinkSync(claim.receipt);
  if (readBytesIfPresent(claim.receipt, operations) !== undefined) {
    throw new Error(`${tag} receipt remains after replacement`);
  }
  exactBytes(canonical, replacementBytes, `${tag} final canonical`, operations);
  assertOwnedLockAuthority(
    lockPath,
    lockBytes,
    lockAuthority,
    `${tag} final lock authority`,
    operations,
  );
}

export function releaseC1229S5MultiviewLock(
  lockPath,
  lockBytes,
  operations = fs,
  guard = undefined,
  expectedAuthority = undefined,
) {
  const proveGuard = (stage) => {
    if (guard !== undefined) guard(stage);
  };
  const createReleaseError = (cause, marker, receipt) => {
    let message = "multiview lock release failed after rename attempt";
    try {
      if (typeof cause?.message === "string" && cause.message.length > 0) {
        message = cause.message;
      }
    } catch {
      // The release fence must not depend on inspecting an arbitrary thrown
      // value.
    }
    const error = new Error(message, { cause });
    multiviewReleaseFences.add(error);
    Object.defineProperties(error, {
      [marker]: {
        value: true,
        enumerable: false,
      },
      c1229MultiviewReleaseReceipt: {
        value: receipt,
        enumerable: false,
      },
    });
    return error;
  };
  const lockAuthority = captureImmutableFileAuthority(
    lockPath,
    lockBytes,
    "owned lock before release",
    operations,
  );
  if (
    expectedAuthority !== undefined &&
    (expectedAuthority.path !== lockPath ||
      !expectedAuthority.bytes.equals(lockBytes) ||
      !sameImmutableDescriptor(
        expectedAuthority.descriptor,
        lockAuthority.descriptor,
      ))
  ) {
    throw new Error("owned lock authority changed before release");
  }
  assertImmutableFileAuthority(
    lockAuthority,
    "owned lock at release linearization",
    operations,
  );
  proveGuard("before-release-linearization");
  const receipt = `${lockPath}.release-${randomUUID()}.receipt`;
  try {
    operations.renameSync(lockPath, receipt);
  } catch (error) {
    throw createReleaseError(
      error,
      "c1229MultiviewReleaseOutcomeUnknown",
      receipt,
    );
  }
  try {
    const receiptDescriptor = inspectImmutableDescriptor(
      receipt,
      "claimed lock release receipt descriptor",
      operations,
    );
    if (!sameFileObjectIdentity(lockAuthority.descriptor, receiptDescriptor)) {
      throw new Error("claimed lock release receipt changed file identity");
    }
    const receiptAuthority = {
      path: receipt,
      bytes: Buffer.from(lockBytes),
      descriptor: receiptDescriptor,
    };
    assertImmutableFileAuthority(
      receiptAuthority,
      "claimed lock release receipt",
      operations,
    );
    operations.unlinkSync(receipt);
  } catch (error) {
    throw createReleaseError(error, "c1229MultiviewReleaseLinearized", receipt);
  }
}

export function beginC1229S5MultiviewEvidenceRun(
  paths,
  runId,
  operations = fs,
) {
  const canonicalPaths = Object.freeze(
    assertCanonicalRunPaths(paths, runId, "multiview begin"),
  );
  paths = canonicalPaths;
  operations.mkdirSync(paths.directory, { recursive: true });
  const directoryAuthority = assertCanonicalDirectory(
    paths.directory,
    "multiview begin",
    operations,
  );
  for (const [file, label] of [
    [paths.archive, "multiview current immutable archive preflight"],
    [paths.recovery, "multiview current recovery preflight"],
  ]) {
    const identity = fingerprintEvidenceFile(file, operations);
    assertEvidenceReadableOrAbsent(identity, label);
    if (identity.exists !== false || identity.error !== "ENOENT") {
      throw new Error(`${label} is occupied before run ownership`);
    }
  }
  const lockBefore = fingerprintEvidenceFile(paths.lock, operations);
  assertEvidenceReadableOrAbsent(lockBefore, "multiview lock preflight");
  if (lockBefore.exists) {
    const owner = readJsonIfPresent(paths.lock, operations);
    throw new Error(`multiview lock is owned by ${String(owner?.runId)}`);
  }

  const latestBefore = fingerprintEvidenceFile(paths.latest, operations);
  assertEvidenceReadableOrAbsent(latestBefore, "multiview latest preflight");
  const priorLatestBytes = readBytesIfPresent(paths.latest, operations);
  if (
    latestBefore.exists !== (priorLatestBytes !== undefined) ||
    (priorLatestBytes !== undefined &&
      (latestBefore.byteLength !== priorLatestBytes.byteLength ||
        latestBefore.sha256 !== sha256(priorLatestBytes)))
  ) {
    throw new Error("multiview prior latest preflight identity raced");
  }
  let priorArchiveAuthority = null;
  let priorLatestArtifact;
  if (priorLatestBytes !== undefined) {
    ({ priorLatest: priorLatestArtifact, authority: priorArchiveAuthority } =
      inspectPriorLatestAuthority(paths, priorLatestBytes, operations));
    exactBytes(
      paths.latest,
      priorLatestBytes,
      "validated multiview prior latest",
      operations,
    );
  }

  const firstRedBefore = fingerprintEvidenceFile(paths.firstRed, operations);
  assertEvidenceReadableOrAbsent(
    firstRedBefore,
    "multiview first-red preflight",
  );
  const firstRedBeforeBytes = readBytesIfPresent(paths.firstRed, operations);
  if (
    firstRedBefore.exists !== (firstRedBeforeBytes !== undefined) ||
    (firstRedBeforeBytes !== undefined &&
      (firstRedBefore.byteLength !== firstRedBeforeBytes.byteLength ||
        firstRedBefore.sha256 !== sha256(firstRedBeforeBytes)))
  ) {
    throw new Error("multiview first-red preflight identity raced");
  }
  const firstRedBeforeArtifact =
    firstRedBeforeBytes === undefined
      ? undefined
      : JSON.parse(firstRedBeforeBytes.toString("utf8"));
  if (
    firstRedBeforeBytes !== undefined &&
    (!validateC1229S5MultiviewFinalArtifact(firstRedBeforeArtifact).ok ||
      firstRedBeforeArtifact.status === "PASS" ||
      !firstRedBeforeBytes.equals(
        Buffer.from(stableC1229S5MultiviewJson(firstRedBeforeArtifact, 2)),
      ))
  ) {
    throw new Error("multiview first-red is not an exact canonical red final");
  }
  if (
    priorLatestArtifact?.status !== undefined &&
    priorLatestArtifact.status !== "PASS" &&
    firstRedBeforeBytes === undefined
  ) {
    throw new Error(
      "multiview prior red latest has no extant first-red continuity",
    );
  }
  let firstRedAuthority = null;
  let firstRedArchiveAuthority = null;
  if (firstRedBeforeBytes !== undefined) {
    firstRedAuthority = captureImmutableFileAuthority(
      paths.firstRed,
      firstRedBeforeBytes,
      "multiview initial first-red authority",
      operations,
    );
    const firstRedArchive = resolveImmutableArchivePath(
      paths,
      firstRedBeforeArtifact,
      "first-red",
    );
    firstRedArchiveAuthority = captureImmutableFileAuthority(
      firstRedArchive,
      firstRedBeforeBytes,
      "multiview initial first-red immutable archive",
      operations,
    );
  }
  if (priorLatestBytes !== undefined) {
    exactBytes(
      paths.latest,
      priorLatestBytes,
      "pre-lock multiview prior latest",
      operations,
    );
  }
  assertPriorArchiveAuthority(priorArchiveAuthority, "pre-lock", operations);
  assertImmutableFileAuthority(
    firstRedAuthority,
    "multiview pre-lock first-red authority",
    operations,
  );
  assertImmutableFileAuthority(
    firstRedArchiveAuthority,
    "multiview pre-lock first-red immutable archive",
    operations,
  );

  const nonce = randomUUID();
  const acquiredAt = new Date().toISOString();
  const lock = {
    schema: C12_29_S5_MULTIVIEW_SCHEMA,
    runId,
    nonce,
    status: "RUNNING",
    incomplete: true,
    acquiredAt,
  };
  const lockBytes = Buffer.from(stableC1229S5MultiviewJson(lock, 2));
  createExclusive(
    paths.lock,
    lockBytes,
    "exclusive multiview lock",
    operations,
  );
  const lockAuthority = captureImmutableFileAuthority(
    paths.lock,
    lockBytes,
    "initial multiview lock authority",
    operations,
  );

  const running = {
    schema: C12_29_S5_MULTIVIEW_SCHEMA,
    runId,
    nonce,
    status: "RUNNING",
    incomplete: true,
    startedAt: acquiredAt,
    artifactName: `${runId}.json`,
  };
  const runningBytes = Buffer.from(stableC1229S5MultiviewJson(running, 2));
  try {
    assertDirectoryAuthority(
      directoryAuthority,
      "multiview pre-RUNNING-publication",
      operations,
    );
    assertImmutableFileAuthority(
      lockAuthority,
      "multiview pre-RUNNING-publication lock authority",
      operations,
    );
    if (priorLatestBytes !== undefined) {
      exactBytes(
        paths.latest,
        priorLatestBytes,
        "post-lock multiview prior latest",
        operations,
      );
    }
    assertPriorArchiveAuthority(priorArchiveAuthority, "post-lock", operations);
    assertImmutableFileAuthority(
      firstRedAuthority,
      "multiview post-lock first-red authority",
      operations,
    );
    assertImmutableFileAuthority(
      firstRedArchiveAuthority,
      "multiview post-lock first-red immutable archive",
      operations,
    );
    assertPriorArchiveAuthority(
      priorArchiveAuthority,
      "pre-RUNNING-publication",
      operations,
    );
    if (priorLatestBytes === undefined) {
      createExclusive(
        paths.latest,
        runningBytes,
        "exclusive multiview RUNNING latest",
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
        lockAuthority,
      );
    }
    assertPriorArchiveAuthority(
      priorArchiveAuthority,
      "post-RUNNING-publication",
      operations,
    );
    assertImmutableFileAuthority(
      firstRedAuthority,
      "multiview post-RUNNING-publication first-red authority",
      operations,
    );
    assertImmutableFileAuthority(
      firstRedArchiveAuthority,
      "multiview post-RUNNING-publication first-red immutable archive",
      operations,
    );
    assertDirectoryAuthority(
      directoryAuthority,
      "multiview post-RUNNING-publication",
      operations,
    );
    assertImmutableFileAuthority(
      lockAuthority,
      "multiview post-RUNNING-publication lock authority",
      operations,
    );
    exactBytes(paths.lock, lockBytes, "owned multiview lock", operations);
    exactBytes(
      paths.latest,
      runningBytes,
      "owned multiview RUNNING",
      operations,
    );
    assertPriorArchiveAuthority(
      priorArchiveAuthority,
      "pre-return",
      operations,
    );
    assertImmutableFileAuthority(
      firstRedAuthority,
      "multiview pre-return first-red authority",
      operations,
    );
    assertImmutableFileAuthority(
      firstRedArchiveAuthority,
      "multiview pre-return first-red immutable archive",
      operations,
    );
    exactBytes(
      paths.latest,
      runningBytes,
      "pre-return owned multiview RUNNING",
      operations,
    );
    exactBytes(
      paths.lock,
      lockBytes,
      "pre-return owned multiview lock",
      operations,
    );
    assertDirectoryAuthority(
      directoryAuthority,
      "multiview pre-return",
      operations,
    );
    assertImmutableFileAuthority(
      lockAuthority,
      "multiview pre-return lock authority",
      operations,
    );
    const ownership = {
      runId,
      paths: Object.freeze({ ...canonicalPaths }),
      lock,
      lockBytes,
      running,
      runningBytes,
      firstRedBefore,
      firstRedBeforeBytes,
      directoryAuthority: publicDirectoryAuthority(directoryAuthority),
      lockAuthority: publicImmutableAuthority(lockAuthority),
      priorArchiveAuthority: publicImmutableAuthority(priorArchiveAuthority),
      firstRedAuthority: publicImmutableAuthority(firstRedAuthority),
      firstRedArchiveAuthority: publicImmutableAuthority(
        firstRedArchiveAuthority,
      ),
      currentArchiveAuthority: null,
    };
    multiviewOwnershipAuthorities.set(ownership, {
      runId,
      nonce,
      paths: canonicalPaths,
      lock: structuredClone(lock),
      lockBytes: Buffer.from(lockBytes),
      running: structuredClone(running),
      runningBytes: Buffer.from(runningBytes),
      directoryAuthority,
      lockAuthority,
      priorArchiveAuthority,
      firstRedAuthority,
      firstRedArchiveAuthority,
      currentArchiveAuthority: null,
    });
    return ownership;
  } catch (error) {
    let latestAfterFailure;
    try {
      latestAfterFailure = readBytesIfPresent(paths.latest, operations);
    } catch (inspectionError) {
      error.retainMultiviewRunning = true;
      const aggregate = new AggregateError(
        [error, inspectionError],
        "multiview begin failed and latest authority became unreadable",
        { cause: inspectionError },
      );
      aggregate.retainMultiviewRunning = true;
      throw aggregate;
    }
    if (latestAfterFailure?.equals(runningBytes)) {
      error.retainMultiviewRunning = true;
    } else {
      releaseC1229S5MultiviewLock(
        paths.lock,
        lockBytes,
        operations,
        undefined,
        lockAuthority,
      );
    }
    throw error;
  }
}

function quarantineFinalLatest(paths, finalBytes, ownership, operations = fs) {
  const assertRecoveryAuthorities = (label) => {
    assertDirectoryAuthority(
      ownership.directoryAuthority,
      `multiview ${label}`,
      operations,
    );
    assertOwnedLockAuthority(
      paths.lock,
      ownership.lockBytes,
      ownership.lockAuthority,
      `multiview ${label} lock`,
      operations,
    );
  };
  let claim;
  try {
    assertRecoveryAuthorities("recovery entry");
    claim = claimC1229S5MultiviewCanonical(
      paths.latest,
      finalBytes,
      paths.lock,
      ownership.lockBytes,
      "recovery",
      operations,
      ownership.lockAuthority,
    );
  } catch (error) {
    return {
      ok: false,
      error,
      finalRetained:
        readBytesIfPresent(paths.latest, operations)?.equals(finalBytes) ===
        true,
    };
  }

  try {
    createExclusive(
      paths.recovery,
      finalBytes,
      "write-once multiview publication recovery",
      operations,
    );
    assertRecoveryAuthorities("recovery after immutable write");
    createExclusive(
      paths.latest,
      ownership.runningBytes,
      "restored multiview RUNNING latest",
      operations,
    );
    assertRecoveryAuthorities("recovery after RUNNING restoration");
    exactBytes(
      paths.recovery,
      finalBytes,
      "multiview publication recovery",
      operations,
    );
    exactBytes(
      paths.latest,
      ownership.runningBytes,
      "restored multiview RUNNING latest",
      operations,
    );
    assertRecoveryAuthorities("recovery before receipt delete");
    operations.unlinkSync(claim.receipt);
    if (readBytesIfPresent(claim.receipt, operations) !== undefined) {
      throw new Error("multiview recovery receipt was not removed");
    }
    assertRecoveryAuthorities("recovery completion");
    return { ok: true, recovery: paths.recovery };
  } catch (error) {
    let canonicalRestoreError;
    let canonicalBytes = readBytesIfPresent(paths.latest, operations);
    if (canonicalBytes === undefined) {
      try {
        assertRecoveryAuthorities("failure-safe final restoration entry");
        createExclusive(
          paths.latest,
          finalBytes,
          "failure-safe restored multiview final latest",
          operations,
        );
        assertRecoveryAuthorities("failure-safe final restoration completion");
        canonicalBytes = readBytesIfPresent(paths.latest, operations);
      } catch (restoreError) {
        canonicalRestoreError = restoreError;
      }
    }
    const receiptBytes = readBytesIfPresent(claim.receipt, operations);
    const recoveryBytes = readBytesIfPresent(paths.recovery, operations);
    const finalRetained = [canonicalBytes, receiptBytes, recoveryBytes].some(
      (bytes) => bytes?.equals(finalBytes) === true,
    );
    if (!finalRetained) {
      throw new AggregateError(
        [error, canonicalRestoreError].filter(Boolean),
        "multiview recovery failed without retaining final bytes",
        { cause: error },
      );
    }
    return {
      ok: false,
      error,
      canonicalRestoreError,
      canonicalFinalRestored: canonicalBytes?.equals(finalBytes) === true,
      receiptRetained: receiptBytes?.equals(finalBytes) === true,
      recoveryRetained: recoveryBytes?.equals(finalBytes) === true,
      finalRetained,
    };
  }
}

function sameCanonicalPathSet(left, right) {
  const keys = [
    "directory",
    "archive",
    "latest",
    "lock",
    "firstRed",
    "recovery",
  ];
  return (
    left &&
    right &&
    Reflect.ownKeys(left).length === keys.length &&
    keys.every(
      (key) =>
        Object.hasOwn(left, key) &&
        Object.hasOwn(right, key) &&
        left[key] === right[key],
    )
  );
}

function assertFinalizationOwnership(
  paths,
  artifact,
  ownership,
  operations = fs,
) {
  const authority = multiviewOwnershipAuthorities.get(ownership);
  if (!authority) {
    throw new Error("multiview finalization ownership was not issued by begin");
  }
  const canonicalPaths = assertCanonicalRunPaths(
    paths,
    authority.runId,
    "multiview finalization",
  );
  if (
    !sameCanonicalPathSet(canonicalPaths, authority.paths) ||
    !sameCanonicalPathSet(ownership.paths, authority.paths) ||
    ownership.runId !== authority.runId ||
    artifact?.runId !== authority.runId ||
    artifact?.artifactName !== `${authority.runId}.json` ||
    (artifact?.status !== "ERROR" &&
      artifact?.startedAt !== authority.running.startedAt) ||
    canonicalPaths.archive !==
      path.join(canonicalPaths.directory, artifact.artifactName) ||
    ownership.lock?.runId !== authority.runId ||
    ownership.running?.runId !== authority.runId ||
    ownership.lock?.nonce !== authority.nonce ||
    ownership.running?.nonce !== authority.nonce ||
    authority.lock.nonce !== authority.running.nonce ||
    authority.lock.acquiredAt !== authority.running.startedAt ||
    !samePublicDirectoryAuthority(
      ownership.directoryAuthority,
      authority.directoryAuthority,
    ) ||
    !samePublicImmutableAuthority(
      ownership.lockAuthority,
      authority.lockAuthority,
    ) ||
    !samePublicImmutableAuthority(
      ownership.priorArchiveAuthority,
      authority.priorArchiveAuthority,
    ) ||
    !samePublicImmutableAuthority(
      ownership.firstRedAuthority,
      authority.firstRedAuthority,
    ) ||
    !samePublicImmutableAuthority(
      ownership.firstRedArchiveAuthority,
      authority.firstRedArchiveAuthority,
    ) ||
    ownership.currentArchiveAuthority !== null ||
    !Buffer.isBuffer(ownership.lockBytes) ||
    !ownership.lockBytes.equals(authority.lockBytes) ||
    !Buffer.isBuffer(ownership.runningBytes) ||
    !ownership.runningBytes.equals(authority.runningBytes)
  ) {
    throw new Error(
      "multiview final artifact, start, paths, RUNNING nonce, and lock ownership are not one run",
    );
  }
  let encodedLock;
  let encodedRunning;
  try {
    encodedLock = Buffer.from(stableC1229S5MultiviewJson(ownership.lock, 2));
    encodedRunning = Buffer.from(
      stableC1229S5MultiviewJson(ownership.running, 2),
    );
  } catch (error) {
    throw new Error("multiview finalization ownership is noncanonical", {
      cause: error,
    });
  }
  if (
    !encodedLock.equals(authority.lockBytes) ||
    !encodedRunning.equals(authority.runningBytes)
  ) {
    throw new Error("multiview finalization ownership bytes were mutated");
  }
  assertDirectoryAuthority(
    authority.directoryAuthority,
    "multiview finalization",
    operations,
  );
  assertImmutableFileAuthority(
    authority.lockAuthority,
    "multiview finalization lock authority",
    operations,
  );
  return authority;
}

function assertFirstRedAuthority(authority, paths, label, operations = fs) {
  if (authority.firstRedAuthority !== null) {
    if (authority.firstRedArchiveAuthority === null) {
      throw new Error(
        `multiview ${label} first-red has no immutable archive authority`,
      );
    }
    assertImmutableFileAuthority(
      authority.firstRedAuthority,
      `multiview ${label} first-red authority`,
      operations,
    );
    assertImmutableFileAuthority(
      authority.firstRedArchiveAuthority,
      `multiview ${label} first-red immutable archive authority`,
      operations,
    );
    if (
      !authority.firstRedAuthority.bytes.equals(
        authority.firstRedArchiveAuthority.bytes,
      )
    ) {
      throw new Error(
        `multiview ${label} first-red and immutable archive differ`,
      );
    }
    return;
  }
  if (authority.firstRedArchiveAuthority !== null) {
    throw new Error(
      `multiview ${label} first-red archive exists without first-red authority`,
    );
  }
  const identity = fingerprintEvidenceFile(paths.firstRed, operations);
  assertEvidenceReadableOrAbsent(identity, `multiview ${label} first-red`);
  if (identity.exists !== false || identity.error !== "ENOENT") {
    throw new Error(`multiview ${label} first-red appeared unexpectedly`);
  }
}

function assertFinalPublicationAuthorities(
  authority,
  paths,
  finalBytes,
  label,
  operations = fs,
) {
  assertDirectoryAuthority(
    authority.directoryAuthority,
    `multiview ${label}`,
    operations,
  );
  exactBytes(
    paths.latest,
    finalBytes,
    `multiview ${label} final latest`,
    operations,
  );
  assertPriorArchiveAuthority(
    authority.priorArchiveAuthority,
    label,
    operations,
  );
  assertFirstRedAuthority(authority, paths, label, operations);
  assertImmutableFileAuthority(
    authority.currentArchiveAuthority,
    `multiview ${label} current immutable archive`,
    operations,
  );
}

export function finalizeC1229S5MultiviewEvidence(
  paths,
  artifact,
  ownership,
  operations = fs,
) {
  let authority;
  let finalBytes;
  let firstRed;
  let releaseCompleted = false;
  try {
    authority = assertFinalizationOwnership(
      paths,
      artifact,
      ownership,
      operations,
    );
    paths = authority.paths;
    const validation = validateC1229S5MultiviewFinalArtifact(artifact);
    if (!validation.ok) {
      throw new Error(
        `invalid multiview final artifact: ${validation.reasons.join("; ")}`,
      );
    }
    finalBytes = Buffer.from(stableC1229S5MultiviewJson(artifact, 2));
    exactBytes(
      paths.lock,
      authority.lockBytes,
      "finalization owned lock",
      operations,
    );
    exactBytes(
      paths.latest,
      authority.runningBytes,
      "finalization owned RUNNING latest",
      operations,
    );
    assertPriorArchiveAuthority(
      authority.priorArchiveAuthority,
      "finalization-entry",
      operations,
    );
    assertFirstRedAuthority(authority, paths, "finalization-entry", operations);

    assertPriorArchiveAuthority(
      authority.priorArchiveAuthority,
      "pre-current-publication",
      operations,
    );
    assertFirstRedAuthority(
      authority,
      paths,
      "pre-current-publication",
      operations,
    );
    createImmutableEvidence(paths.archive, finalBytes, operations);
    authority.currentArchiveAuthority = captureImmutableFileAuthority(
      paths.archive,
      finalBytes,
      "multiview current immutable archive",
      operations,
    );
    ownership.currentArchiveAuthority = publicImmutableAuthority(
      authority.currentArchiveAuthority,
    );

    if (artifact.status !== "PASS") {
      firstRed = preserveFirstRedEvidence(
        paths.firstRed,
        finalBytes,
        operations,
      );
      const expected = authority.firstRedAuthority?.bytes ?? finalBytes;
      exactBytes(
        paths.firstRed,
        expected,
        "exact multiview first-red",
        operations,
      );
      if (
        firstRed.byteLength !== expected.byteLength ||
        firstRed.sha256 !== sha256(expected) ||
        firstRed.written !== (authority.firstRedAuthority === null)
      ) {
        throw new Error("multiview first-red receipt is not exact");
      }
      if (authority.firstRedAuthority === null) {
        authority.firstRedAuthority = captureImmutableFileAuthority(
          paths.firstRed,
          finalBytes,
          "multiview newly preserved first-red authority",
          operations,
        );
        ownership.firstRedAuthority = publicImmutableAuthority(
          authority.firstRedAuthority,
        );
        authority.firstRedArchiveAuthority = authority.currentArchiveAuthority;
        ownership.firstRedArchiveAuthority = publicImmutableAuthority(
          authority.firstRedArchiveAuthority,
        );
      }
    }
    assertPriorArchiveAuthority(
      authority.priorArchiveAuthority,
      "pre-final-canonical-replacement",
      operations,
    );
    assertFirstRedAuthority(
      authority,
      paths,
      "pre-final-canonical-replacement",
      operations,
    );
    assertImmutableFileAuthority(
      authority.currentArchiveAuthority,
      "multiview pre-final-canonical-replacement current immutable archive",
      operations,
    );
    replaceOwnedCanonical(
      paths.latest,
      authority.runningBytes,
      finalBytes,
      paths.lock,
      authority.lockBytes,
      "final",
      operations,
      authority.lockAuthority,
    );
    assertFinalPublicationAuthorities(
      authority,
      paths,
      finalBytes,
      "post-publication",
      operations,
    );
    assertImmutableFileAuthority(
      authority.lockAuthority,
      "multiview pre-unlock lock authority",
      operations,
    );
    releaseC1229S5MultiviewLock(
      paths.lock,
      authority.lockBytes,
      operations,
      (stage) =>
        assertFinalPublicationAuthorities(
          authority,
          paths,
          finalBytes,
          `unlock-${stage}`,
          operations,
        ),
      authority.lockAuthority,
    );
    releaseCompleted = true;
    return {
      runIdentity: {
        file: paths.archive,
        exists: true,
        byteLength: authority.currentArchiveAuthority.bytes.byteLength,
        sha256: sha256(authority.currentArchiveAuthority.bytes),
      },
      firstRed,
    };
  } catch (caught) {
    const error = caught;
    if (releaseCompleted || multiviewReleaseFences.has(error)) {
      throw error;
    }
    error.retainMultiviewRunning = true;
    if (authority && finalBytes) {
      try {
        assertDirectoryAuthority(
          authority.directoryAuthority,
          "multiview failed-finalization recovery",
          operations,
        );
        const currentLatest = readBytesIfPresent(paths.latest, operations);
        if (currentLatest?.equals(finalBytes) === true) {
          let recoveryLockAuthority;
          if (readBytesIfPresent(paths.lock, operations) !== undefined) {
            assertOwnedLockAuthority(
              paths.lock,
              authority.lockBytes,
              authority.lockAuthority,
              "retained finalization lock",
              operations,
            );
            recoveryLockAuthority = authority.lockAuthority;
          } else if (
            restoreExclusive(
              paths.lock,
              authority.lockBytes,
              "late finalization failure lock restoration",
              operations,
            )
          ) {
            recoveryLockAuthority = captureImmutableFileAuthority(
              paths.lock,
              authority.lockBytes,
              "late restored finalization lock authority",
              operations,
            );
          }
          if (recoveryLockAuthority !== undefined) {
            authority.lockAuthority = recoveryLockAuthority;
            ownership.lockAuthority = publicImmutableAuthority(
              recoveryLockAuthority,
            );
            error.publicationRecovery = quarantineFinalLatest(
              paths,
              finalBytes,
              authority,
              operations,
            );
          }
        }
      } catch (recoveryError) {
        Object.defineProperty(error, "c1229MultiviewRecoveryFailure", {
          value: recoveryError,
          enumerable: false,
        });
      }
    }
    throw error;
  }
}

function sourcePathsByName() {
  return Object.fromEntries(
    C12_29_S5_MULTIVIEW_SOURCE_FILES.map((file) => [
      file,
      path.join(repositoryRoot, file),
    ]),
  );
}

function collectC1229S5MultiviewProvenanceSnapshot() {
  return {
    local: snapshotEvidenceFiles(sourcePathsByName()),
    servedEntry: fingerprintEvidenceFile(buildEntryPath),
    buildSourceIdentity: inspectBuildSourceIdentity({
      sourceMapPath: buildSourceMapPath,
      sourceFiles: C12_29_S5_MULTIVIEW_BUILD_SOURCE_FILES.map((file) =>
        path.join(repositoryRoot, file),
      ),
    }),
  };
}

function composeC1229S5MultiviewProvenance(start, end, sessions) {
  const local = compareEvidenceFileSnapshots(start.local, end.local);
  const served = validateServedEntryIdentities({
    entries: sessions.map((session) => session.servedEntry),
    expectedLabels: C12_29_S5_MULTIVIEW_RENDERERS,
    localEntry: start.servedEntry,
  });
  const buildStart = start.buildSourceIdentity;
  const buildEnd = end.buildSourceIdentity;
  const buildStable =
    buildStart.ok === true &&
    buildEnd.ok === true &&
    buildStart.sourceMapByteLength === buildEnd.sourceMapByteLength &&
    buildStart.sourceMapSha256 === buildEnd.sourceMapSha256 &&
    stableC1229S5MultiviewJson(buildStart.entries) ===
      stableC1229S5MultiviewJson(buildEnd.entries);
  const reasons = [
    ...local.reasons,
    ...served.reasons,
    ...buildStart.reasons,
    ...buildEnd.reasons,
  ];
  if (!buildStable)
    reasons.push("build/source-map identity changed or is inexact");
  return {
    localStable: local.ok,
    servedEntryExact: served.ok,
    buildSourceExact: buildStable,
    localFiles: C12_29_S5_MULTIVIEW_SOURCE_FILES.map((file) => ({
      file,
      byteLength: start.local[file].byteLength,
      sha256: start.local[file].sha256,
    })),
    runtimeEntry: {
      byteLength: start.servedEntry.byteLength,
      sha256: start.servedEntry.sha256,
    },
    buildSourceMap: {
      byteLength: buildStart.sourceMapByteLength,
      sha256: buildStart.sourceMapSha256,
    },
    servedEntries: sessions.map((session) => ({
      renderer: session.renderer,
      status: session.servedEntry.status,
      byteLength: session.servedEntry.byteLength,
      sha256: session.servedEntry.sha256,
    })),
    reasons,
  };
}

const MEASURE_C1229_S5_MULTIVIEW_SESSION = async (contract) => {
  const progress = {
    schema: contract.pageSchema,
    renderer: contract.renderer,
    phase: contract.phases[0],
    phaseOrdinal: 1,
    completedPhases: [],
    incomplete: true,
    checkpoint: {
      engineSchedulerAvailable: false,
      sceneRenderResetsDefaultView: true,
      contextId: null,
      canvasId: null,
      defaultViewId: null,
      defaultCameraId: null,
      defaultEclipseStateObjectId: null,
      defaultEclipseShadowObjectId: null,
    },
  };
  globalThis.__c1229S5MultiviewProgress = progress;
  const beginPhase = (phase) => {
    const expected = contract.phases[progress.completedPhases.length];
    if (phase !== expected) {
      throw new Error(`phase order drift: ${phase}, expected ${expected}`);
    }
    progress.phase = phase;
    progress.phaseOrdinal = progress.completedPhases.length + 1;
  };
  const completePhase = (phase) => {
    beginPhase(phase);
    progress.completedPhases.push(phase);
    if (progress.completedPhases.length === contract.phases.length) {
      progress.incomplete = false;
    }
  };

  let activeLogicalLabel = null;
  let insideAllocatorFlush = 0;
  let queueEventSequence = 0;
  const queueWrites = [];
  const queueSubmits = [];
  const commandBufferFinishes = new WeakMap();
  const renderPassParents = new WeakMap();
  const renderPassBinds = [];
  const renderPassDraws = [];
  let activeWebgpuCommand = null;
  const platformRestorations = [];
  const sameDescriptor = (actual, expected) =>
    actual !== undefined &&
    expected !== undefined &&
    actual.value === expected.value &&
    actual.get === expected.get &&
    actual.set === expected.set &&
    actual.writable === expected.writable &&
    actual.enumerable === expected.enumerable &&
    actual.configurable === expected.configurable;
  const patchPlatformMethod = (prototype, key, wrap) => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype ?? {}, key);
    if (!prototype || typeof descriptor?.value !== "function") {
      throw new Error(`${key} platform descriptor is unavailable`);
    }
    const next = { ...descriptor, value: wrap(descriptor.value) };
    const restore = () => {
      Object.defineProperty(prototype, key, descriptor);
      return sameDescriptor(
        Object.getOwnPropertyDescriptor(prototype, key),
        descriptor,
      );
    };
    Object.defineProperty(prototype, key, next);
    if (
      !sameDescriptor(Object.getOwnPropertyDescriptor(prototype, key), next)
    ) {
      const restored = restore();
      throw new Error(
        `${key} platform instrumentation did not install exactly; restored=${restored}`,
      );
    }
    platformRestorations.push(restore);
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
    width: `${contract.workload.viewport.width}px`,
    height: `${contract.workload.viewport.height}px`,
  });

  const commonOptions = {
    terrainProvider: new C.EllipsoidTerrainProvider(),
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
  viewer.useDefaultRenderLoop = false;
  viewer.resolutionScale = 1;
  const scene = viewer.scene;
  const context = scene.context;
  const canvas = scene.canvas;
  const actualRenderer = context.isWebGPU ? "webgpu" : "webgl";
  if (actualRenderer !== contract.renderer) {
    throw new Error(
      `renderer resolved ${actualRenderer}, expected ${contract.renderer}`,
    );
  }
  globalThis.__armWebGPUDevice?.(
    context?._device,
    `multiview-${actualRenderer}`,
  );
  if (actualRenderer === "webgpu") {
    context._options.webgpu = {
      ...(context._options.webgpu ?? {}),
      sceneCaptureReflections: true,
    };
  }

  scene.requestRenderMode = false;
  scene.highDynamicRange = false;
  scene.sunBloom = false;
  scene.taaEnabled = false;
  scene.backgroundColor = C.Color.BLACK;
  scene.globe.terrainProvider = viewer.terrainProvider;
  scene.globe.pickable = true;
  scene.globe.show = true;
  scene.globe.enableLighting = false;
  scene.globe.showGroundAtmosphere = false;
  scene.globe.showWaterEffect = false;
  scene.globe.maximumScreenSpaceError = 2;
  if (scene.fog) scene.fog.enabled = false;
  if (scene.postProcessStages?.fxaa)
    scene.postProcessStages.fxaa.enabled = false;
  if (scene.postProcessStages?.bloom)
    scene.postProcessStages.bloom.enabled = false;
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;
  const lighting = scene.globe.atmosphericConditions?.lighting;
  if (!lighting) throw new Error("eclipse lighting facade is unavailable");
  lighting.enableEclipse = true;
  lighting.enableEclipseGlobeShadow = true;
  lighting.eclipseAutoExposure = false;

  const pinnedTime = C.JulianDate.fromIso8601(contract.workload.eventIso);
  viewer.clock.currentTime = pinnedTime.clone();
  viewer.clock.startTime = pinnedTime.clone();
  viewer.clock.stopTime = pinnedTime.clone();
  viewer.clock.shouldAnimate = false;
  viewer.clock.multiplier = 0;

  const identityMaps = new Map();
  const identityCounters = new Map();
  const identity = (prefix, object) => {
    if (
      (typeof object !== "object" && typeof object !== "function") ||
      object === null
    ) {
      return null;
    }
    let map = identityMaps.get(prefix);
    if (!map) {
      map = new WeakMap();
      identityMaps.set(prefix, map);
    }
    let value = map.get(object);
    if (!value) {
      const next = (identityCounters.get(prefix) ?? 0) + 1;
      identityCounters.set(prefix, next);
      value = `${prefix}-${next}`;
      map.set(object, value);
    }
    return value;
  };
  const vector = (value, length = 3) =>
    Array.from({ length }, (_, index) => {
      if (length === 3 && value && !Array.isArray(value)) {
        return Number(value[["x", "y", "z"][index]]);
      }
      return Number(value?.[index]);
    });
  const vec4 = (value) => [value.x, value.y, value.z, value.w].map(Number);
  const matrix = (value) =>
    Array.from({ length: 16 }, (_, index) => Number(value[index]));
  const viewportSnapshot = (value) => ({
    x: Number(value.x),
    y: Number(value.y),
    width: Number(value.width),
    height: Number(value.height),
  });
  const cameraSnapshot = (camera) => ({
    cameraId: identity("camera", camera),
    positionWC: vector(camera.positionWC),
    directionWC: vector(camera.directionWC),
    upWC: vector(camera.upWC),
    rightWC: vector(camera.rightWC),
    viewMatrix: matrix(camera.viewMatrix),
    projectionMatrix: matrix(camera.frustum.projectionMatrix),
  });
  const frustumSnapshot = (frustum) => ({
    constructor: frustum.constructor?.name ?? "UnknownFrustum",
    near: Number(frustum.near),
    far: Number(frustum.far),
    aspectRatio:
      typeof frustum.aspectRatio === "number"
        ? Number(frustum.aspectRatio)
        : null,
    fov: typeof frustum.fov === "number" ? Number(frustum.fov) : null,
    width: typeof frustum.width === "number" ? Number(frustum.width) : null,
    xOffset:
      typeof frustum.xOffset === "number" ? Number(frustum.xOffset) : null,
    yOffset:
      typeof frustum.yOffset === "number" ? Number(frustum.yOffset) : null,
  });
  const packedShadow = (shadow) =>
    [
      ...vec4(shadow.sunDirectionAndInvRange),
      ...vec4(shadow.moonDirectionDeltaAndInvRange),
      ...vec4(shadow.params),
      ...vec4(shadow.params2),
    ].map(Math.fround);
  const shadowSnapshot = (shadow) => ({
    active: shadow.active === true,
    revision: Number(shadow.revision),
    sunDirectionAndInvRange: vec4(shadow.sunDirectionAndInvRange),
    moonDirectionDeltaAndInvRange: vec4(shadow.moonDirectionDeltaAndInvRange),
    params: vec4(shadow.params),
    params2: vec4(shadow.params2),
    packedF32: packedShadow(shadow),
  });
  const eclipseSnapshot = (frameState, view) => ({
    stateObjectId: identity("state", view._eclipseState),
    shadowObjectId: identity("shadow", view._eclipseGlobeShadow),
    state: {
      enabled: frameState.eclipseState.enabled === true,
      valid: frameState.eclipseState.valid === true,
      sunVisibleFraction: Number(frameState.eclipseState.sunVisibleFraction),
      earthOcclusionFraction: Number(
        frameState.eclipseState.earthOcclusionFraction,
      ),
      moonObscuration: Number(frameState.eclipseState.moonObscuration),
      sceneLightFactor: Number(frameState.eclipseSceneLightFactor),
    },
    shadow: shadowSnapshot(frameState.eclipseGlobeShadow),
    prepared: frameState.eclipseGlobeShadowPrepared === true,
    selectionRevision: Number(frameState.eclipseGlobeShadowSelectionRevision),
    surfaceRadius: Number(frameState.eclipseGlobeShadowSurfaceRadius),
  });
  const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const distance = (left, right) =>
    Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
  const waitFrame = () =>
    new Promise((resolve) => requestAnimationFrame(resolve));
  const restoreOwnDescriptor = (object, key, hadOwn, descriptor) => {
    if (hadOwn) {
      Object.defineProperty(object, key, descriptor);
    } else {
      delete object[key];
    }
    const restored = Object.getOwnPropertyDescriptor(object, key);
    return hadOwn
      ? sameDescriptor(restored, descriptor)
      : restored === undefined;
  };

  const defaultView = scene.defaultView;
  const viewA = defaultView;
  const defaultCamera = viewA.camera;
  const frustumFovHadOwn = Object.hasOwn(defaultCamera.frustum, "fov");
  const frustumFovDescriptor = Object.getOwnPropertyDescriptor(
    defaultCamera.frustum,
    "fov",
  );
  defaultCamera.frustum.fov = C.Math.toRadians(
    contract.workload.viewA.cameraFovDegrees,
  );
  defaultCamera.frustum.near = contract.workload.viewA.cameraNearMeters;
  defaultCamera.frustum.far = contract.workload.viewA.cameraFarMeters;
  defaultCamera.frustum.aspectRatio =
    contract.workload.viewA.viewport.width /
    contract.workload.viewA.viewport.height;
  defaultCamera.frustum.xOffset = 0;
  defaultCamera.frustum.yOffset = 0;
  defaultCamera.setView({
    destination: C.Cartesian3.fromDegrees(
      contract.workload.viewA.longitudeDegrees,
      contract.workload.viewA.latitudeDegrees,
      contract.workload.viewA.heightMeters,
      scene.globe.ellipsoid,
    ),
    orientation: {
      heading: C.Math.toRadians(contract.workload.viewA.headingDegrees),
      pitch: C.Math.toRadians(contract.workload.viewA.pitchDegrees),
      roll: C.Math.toRadians(contract.workload.viewA.rollDegrees),
    },
  });
  Object.assign(viewA.viewport, contract.workload.viewA.viewport);
  Object.assign(viewA.passState.viewport, contract.workload.viewA.viewport);

  const cameraB = C.Camera.clone(defaultCamera, new C.Camera(scene));
  cameraB.setView({
    destination: C.Cartesian3.fromDegrees(
      contract.workload.viewB.longitudeDegrees,
      contract.workload.viewB.latitudeDegrees,
      contract.workload.viewB.heightMeters,
      scene.globe.ellipsoid,
    ),
    orientation: {
      heading: C.Math.toRadians(contract.workload.viewB.headingDegrees),
      pitch: C.Math.toRadians(contract.workload.viewB.pitchDegrees),
      roll: C.Math.toRadians(contract.workload.viewB.rollDegrees),
    },
  });
  cameraB.frustum.fov = C.Math.toRadians(
    contract.workload.viewB.cameraFovDegrees,
  );
  cameraB.frustum.near = contract.workload.viewB.cameraNearMeters;
  cameraB.frustum.far = contract.workload.viewB.cameraFarMeters;
  cameraB.frustum.aspectRatio =
    contract.workload.viewB.viewport.width /
    contract.workload.viewB.viewport.height;
  cameraB.frustum.xOffset = 0;
  cameraB.frustum.yOffset = 0;
  const viewB = scene.createView(
    cameraB,
    new C.BoundingRectangle(
      contract.workload.viewB.viewport.x,
      contract.workload.viewB.viewport.y,
      contract.workload.viewB.viewport.width,
      contract.workload.viewB.viewport.height,
    ),
  );

  progress.checkpoint.contextId = identity("context", context);
  progress.checkpoint.canvasId = identity("canvas", canvas);
  progress.checkpoint.defaultViewId = identity("view", defaultView);
  progress.checkpoint.defaultCameraId = identity("camera", defaultView.camera);
  progress.checkpoint.defaultEclipseStateObjectId = identity(
    "state",
    defaultView._eclipseState,
  );
  progress.checkpoint.defaultEclipseShadowObjectId = identity(
    "shadow",
    defaultView._eclipseGlobeShadow,
  );
  completePhase(contract.phases[0]);

  scene.view = defaultView;
  scene.initializeFrame();
  scene.render(pinnedTime);
  const baseline = {
    renderer: actualRenderer,
    contextId: identity("context", context),
    canvasId: identity("canvas", canvas),
    defaultViewId: identity("view", defaultView),
    defaultCameraId: identity("camera", defaultView.camera),
    defaultEclipseStateObjectId: identity("state", defaultView._eclipseState),
    defaultEclipseShadowObjectId: identity(
      "shadow",
      defaultView._eclipseGlobeShadow,
    ),
    currentViewId: identity("view", scene.view),
    frameStateViewId: identity("view", scene.frameState.view),
    sameContextCanvas:
      defaultView.effectiveContext === context &&
      scene.context.canvas === canvas,
    supportsStereoViewport: context.supportsStereoViewport === true,
    canvas: {
      width: Number(context.drawingBufferWidth),
      height: Number(context.drawingBufferHeight),
    },
  };
  completePhase(contract.phases[1]);

  let stable = 0;
  for (let frame = 0; frame < contract.workload.maximumSettleFrames; frame++) {
    scene.render(pinnedTime);
    const tileProvider = scene.globe._surface?.tileProvider;
    const selected = tileProvider?._quadtree?._tilesToRender?.length ?? 0;
    const globeCommands = scene.frameState.commandList.filter(
      (command) => command?.pass === C.Pass.GLOBE,
    ).length;
    if (scene.globe.tilesLoaded && selected > 0 && globeCommands > 0) {
      stable++;
      if (stable >= contract.workload.requiredStableFrames) break;
    } else {
      stable = 0;
    }
    await waitFrame();
  }
  if (stable < contract.workload.requiredStableFrames) {
    throw new Error(
      "default-view terrain and globe commands did not stabilize",
    );
  }

  const tileProvider = scene.globe._surface.tileProvider;
  const hashByteArray = async (bytes) => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      Uint8Array.from(bytes),
    );
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  };
  const payloadFromBytes = (bytes) => {
    const data = Uint8Array.from(bytes);
    const view = new DataView(data.buffer);
    return Array.from({ length: 16 }, (_, index) =>
      Math.fround(view.getFloat32(index * 4, true)),
    );
  };
  const methodRestorations = [];
  const installExactMethod = (object, key, wrap) => {
    const hadOwn = Object.hasOwn(object, key);
    const ownDescriptor = Object.getOwnPropertyDescriptor(object, key);
    const original = object[key];
    if (typeof original !== "function") {
      throw new Error(`${key} instrumentation target is not callable`);
    }
    const instrumented = wrap(original);
    if (hadOwn && !Object.hasOwn(ownDescriptor, "value")) {
      throw new Error(`${key} instrumentation requires a data descriptor`);
    }
    const installedDescriptor = hadOwn
      ? { ...ownDescriptor, value: instrumented }
      : {
          value: instrumented,
          writable: true,
          enumerable: false,
          configurable: true,
        };
    const restore = () => {
      if (hadOwn) {
        Object.defineProperty(object, key, ownDescriptor);
      } else {
        delete object[key];
      }
      const restoredDescriptor = Object.getOwnPropertyDescriptor(object, key);
      return (
        object[key] === original &&
        (hadOwn
          ? sameDescriptor(restoredDescriptor, ownDescriptor)
          : restoredDescriptor === undefined)
      );
    };
    Object.defineProperty(object, key, installedDescriptor);
    if (
      !sameDescriptor(
        Object.getOwnPropertyDescriptor(object, key),
        installedDescriptor,
      )
    ) {
      const restored = restore();
      throw new Error(
        `${key} instrumentation did not install exactly; restored=${restored}`,
      );
    }
    return {
      original,
      restore,
    };
  };
  const patchMethod = (object, key, wrap) => {
    const patch = installExactMethod(object, key, wrap);
    methodRestorations.push(patch.restore);
    return patch.original;
  };
  let instrumentationRestored = false;
  const restoreInstrumentation = () => {
    if (instrumentationRestored) return true;
    let exact = true;
    const errors = [];
    for (const restore of methodRestorations.reverse()) {
      try {
        exact = restore() && exact;
      } catch (error) {
        exact = false;
        errors.push(error);
      }
    }
    for (const restore of platformRestorations.reverse()) {
      try {
        exact = restore() && exact;
      } catch (error) {
        exact = false;
        errors.push(error);
      }
    }
    methodRestorations.length = 0;
    platformRestorations.length = 0;
    instrumentationRestored = exact;
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        "multiview instrumentation restoration threw",
        { cause: errors[0] },
      );
    }
    return exact;
  };

  let webgpuProof = null;
  if (actualRenderer === "webgpu") {
    try {
      const queuePrototype = globalThis.GPUQueue?.prototype;
      const encoderPrototype = globalThis.GPUCommandEncoder?.prototype;
      const renderPassPrototype = globalThis.GPURenderPassEncoder?.prototype;
      patchPlatformMethod(
        queuePrototype,
        "writeBuffer",
        (original) =>
          function (buffer, bufferOffset, data, dataOffset = 0, size) {
            const source =
              data instanceof ArrayBuffer
                ? new Uint8Array(data)
                : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            const length = Number(size ?? source.byteLength - dataOffset);
            if (activeLogicalLabel !== null) {
              queueWrites.push({
                label: activeLogicalLabel,
                queue: this,
                buffer,
                offset: Number(bufferOffset),
                size: length,
                bytes: source.slice(dataOffset, dataOffset + length),
                insideAllocatorFlush: insideAllocatorFlush > 0,
                sequence: ++queueEventSequence,
              });
            }
            return original.call(
              this,
              buffer,
              bufferOffset,
              data,
              dataOffset,
              size,
            );
          },
      );
      patchPlatformMethod(
        queuePrototype,
        "submit",
        (original) =>
          function (commandBuffers) {
            const buffers = Array.from(commandBuffers);
            if (activeLogicalLabel !== null) {
              queueSubmits.push({
                label: activeLogicalLabel,
                queue: this,
                commandBuffers: buffers,
                sequence: ++queueEventSequence,
              });
            }
            return original.call(this, buffers);
          },
      );
      patchPlatformMethod(
        encoderPrototype,
        "beginRenderPass",
        (original) =>
          function (...args) {
            const renderPass = original.apply(this, args);
            if (activeLogicalLabel !== null) {
              renderPassParents.set(renderPass, {
                label: activeLogicalLabel,
                encoder: this,
              });
            }
            return renderPass;
          },
      );
      patchPlatformMethod(
        encoderPrototype,
        "finish",
        (original) =>
          function (...args) {
            const commandBuffer = original.apply(this, args);
            if (activeLogicalLabel !== null) {
              commandBufferFinishes.set(commandBuffer, {
                label: activeLogicalLabel,
                encoder: this,
                sequence: ++queueEventSequence,
              });
            }
            return commandBuffer;
          },
      );
      patchPlatformMethod(
        renderPassPrototype,
        "setBindGroup",
        (original) =>
          function (...args) {
            const result = original.apply(this, args);
            if (activeLogicalLabel !== null && activeWebgpuCommand !== null) {
              const suppliedOffsets = args[2];
              let dynamicOffsets =
                suppliedOffsets === undefined
                  ? []
                  : Array.from(suppliedOffsets, Number);
              if (args[3] !== undefined) {
                const start = Number(args[3]);
                const length = Number(args[4] ?? dynamicOffsets.length - start);
                dynamicOffsets = dynamicOffsets.slice(start, start + length);
              }
              renderPassBinds.push({
                label: activeLogicalLabel,
                command: activeWebgpuCommand,
                renderPass: this,
                index: Number(args[0]),
                bindGroup: args[1],
                dynamicOffsets,
                sequence: ++queueEventSequence,
              });
            }
            return result;
          },
      );
      const patchRenderPassDraw = (drawKind) => {
        patchPlatformMethod(
          renderPassPrototype,
          drawKind,
          (original) =>
            function (...args) {
              const result = original.apply(this, args);
              if (activeLogicalLabel !== null && activeWebgpuCommand !== null) {
                renderPassDraws.push({
                  label: activeLogicalLabel,
                  command: activeWebgpuCommand,
                  renderPass: this,
                  kind: drawKind,
                  count: Number(args[0]),
                  sequence: ++queueEventSequence,
                });
              }
              return result;
            },
        );
      };
      patchRenderPassDraw("draw");
      patchRenderPassDraw("drawIndexed");
      const sources = context._webgpuSceneCaptureSources;
      const renderer = sources?.globeRenderer;
      const manager = renderer?._eclipseUniforms;
      const allocator = context.uniformAllocator;
      if (
        !sources ||
        sources.tileProvider !== tileProvider ||
        renderer?.constructor?.name !== "WebGPUGlobeSurfaceRenderer" ||
        !manager ||
        !allocator ||
        !Array.isArray(allocator._pages)
      ) {
        throw new Error(
          "actual WebGPU globe renderer/manager/allocator publication is unavailable",
        );
      }
      const allocationUploads = [];
      const prepareRecords = [];
      const bindGroupRecords = [];
      const frameEncoders = new Map();
      let insideManagerPrepare = 0;
      patchMethod(
        allocator,
        "allocateAndWrite",
        (original) =>
          function (data, allocationSize) {
            const result = original.call(this, data, allocationSize);
            if (insideManagerPrepare > 0 && activeLogicalLabel !== null) {
              const bytes =
                data instanceof ArrayBuffer
                  ? new Uint8Array(data)
                  : new Uint8Array(
                      data.buffer,
                      data.byteOffset,
                      data.byteLength,
                    );
              allocationUploads.push({
                label: activeLogicalLabel,
                buffer: result.buffer,
                offset: Number(result.offset),
                size: Number(allocationSize ?? bytes.byteLength),
                allocatedSize: Number(result.size),
                bytes: Array.from(bytes),
                allocationEpoch: Number(allocator.allocationEpoch),
              });
            }
            return result;
          },
      );
      patchMethod(
        allocator,
        "flush",
        (original) =>
          function (...args) {
            insideAllocatorFlush++;
            try {
              return original.apply(this, args);
            } finally {
              insideAllocatorFlush--;
            }
          },
      );
      patchMethod(
        manager,
        "prepare",
        (original) =>
          function (device, frameState) {
            insideManagerPrepare++;
            let result;
            try {
              result = original.call(this, device, frameState);
            } finally {
              insideManagerPrepare--;
            }
            if (activeLogicalLabel !== null) {
              prepareRecords.push({
                label: activeLogicalLabel,
                managerThisExact: this === manager,
                result,
                viewId: identity("view", frameState.view),
                shadowRevision: Number(frameState.eclipseGlobeShadow?.revision),
                selectionRevision: Number(
                  frameState.eclipseGlobeShadowSelectionRevision,
                ),
                allocationEpoch: Number(allocator.allocationEpoch),
              });
            }
            return result;
          },
      );
      patchMethod(
        renderer,
        "_getOrCreateBindGroup0",
        (original) =>
          function (device, cameraUB, tileUB, eclipseUB) {
            const result = original.call(
              this,
              device,
              cameraUB,
              tileUB,
              eclipseUB,
            );
            if (activeLogicalLabel !== null) {
              bindGroupRecords.push({
                label: activeLogicalLabel,
                rendererThisExact: this === renderer,
                bindGroup: result.bindGroup,
                dynamicOffsets: Array.from(result.dynamicOffsets, Number),
                eclipseUB,
              });
            }
            return result;
          },
      );

      const execute = (command, label, passState) => {
        if (activeLogicalLabel !== label || activeWebgpuCommand !== null) {
          throw new Error("WebGPU command execution scope is inconsistent");
        }
        const encoder = frameEncoders.get(label);
        if (!encoder) {
          throw new Error("WebGPU logical frame encoder is unavailable");
        }
        const device = context._device;
        const sampleCount = Number(renderer._sampleCount ?? 1);
        const textureSize = {
          width: 4,
          height: 4,
          depthOrArrayLayers: 1,
        };
        const textureOptions = (format) => ({
          size: textureSize,
          sampleCount,
          format,
          usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        const color = device.createTexture(
          textureOptions(renderer._canvasFormat),
        );
        const normal = device.createTexture(textureOptions("rgba16float"));
        const depth = device.createTexture(
          textureOptions("depth24plus-stencil8"),
        );
        const renderPass = encoder.beginRenderPass({
          label: `C12-29 S5 ${label} command-consumption proof`,
          colorAttachments: [color, normal].map((texture) => ({
            view: texture.createView(),
            loadOp: "clear",
            storeOp: "discard",
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
          })),
          depthStencilAttachment: {
            view: depth.createView(),
            depthLoadOp: "clear",
            depthStoreOp: "discard",
            depthClearValue: 1,
            stencilLoadOp: "clear",
            stencilStoreOp: "discard",
            stencilClearValue: 0,
          },
        });
        activeWebgpuCommand = command;
        let executeError;
        try {
          command.execute(renderPass, context, passState);
        } catch (error) {
          executeError = error;
        } finally {
          activeWebgpuCommand = null;
          renderPass.end();
        }
        if (executeError) {
          color.destroy();
          normal.destroy();
          depth.destroy();
          throw executeError;
        }
        return () => {
          color.destroy();
          normal.destroy();
          depth.destroy();
        };
      };

      const readSlice = (buffer, offset, size, label, consumption) => {
        const page = allocator._pages.find(
          (candidate) => candidate.buffer === buffer,
        );
        if (!page || offset + size > page.staging.byteLength) {
          throw new Error("binding-2 allocator staging slice is unavailable");
        }
        const bytes = Array.from(page.staging.slice(offset, offset + size));
        const upload = allocationUploads.findLast(
          (entry) =>
            entry.buffer === buffer &&
            entry.offset === offset &&
            entry.size === size &&
            entry.label === label,
        );
        const write = queueWrites.findLast(
          (entry) =>
            entry.label === label &&
            entry.queue === context._device.queue &&
            entry.buffer === buffer &&
            entry.insideAllocatorFlush === true &&
            entry.offset <= offset &&
            entry.offset + entry.size >= offset + size,
        );
        if (!write) {
          throw new Error(
            "binding-2 slice is not covered by an allocator dirty-range queue.writeBuffer",
          );
        }
        const flushSliceOffset = offset - write.offset;
        const flushSliceBytes = Array.from(
          write.bytes.slice(flushSliceOffset, flushSliceOffset + size),
        );
        const frameEncoder = frameEncoders.get(label);
        const renderPassParent = renderPassParents.get(consumption.renderPass);
        if (
          !frameEncoder ||
          renderPassParent?.label !== label ||
          renderPassParent.encoder !== frameEncoder
        ) {
          throw new Error(
            "consuming render pass is not owned by the logical frame encoder",
          );
        }
        const isOwningCommandBuffer = (commandBuffer, submitSequence) => {
          const finish = commandBufferFinishes.get(commandBuffer);
          return (
            finish?.label === label &&
            finish.encoder === frameEncoder &&
            finish.sequence > write.sequence &&
            finish.sequence > consumption.draw.sequence &&
            finish.sequence < submitSequence
          );
        };
        const submit = queueSubmits.find(
          (entry) =>
            entry.label === label &&
            entry.queue === write.queue &&
            entry.sequence > write.sequence &&
            entry.sequence > consumption.draw.sequence &&
            entry.commandBuffers.some((commandBuffer) =>
              isOwningCommandBuffer(commandBuffer, entry.sequence),
            ),
        );
        if (!submit) {
          throw new Error(
            "binding-2 dirty-range write has no later owning frame submit",
          );
        }
        const submittedCommandBuffer = submit.commandBuffers.find(
          (commandBuffer) =>
            isOwningCommandBuffer(commandBuffer, submit.sequence),
        );
        const finish = commandBufferFinishes.get(submittedCommandBuffer);
        const stagingReceiptExact = Boolean(
          upload &&
          upload.allocatedSize >= size &&
          upload.bytes.length === size &&
          equal(upload.bytes, bytes),
        );
        const submittedAfterFlush = submit.sequence > write.sequence;
        const submittedAfterDraw = submit.sequence > consumption.draw.sequence;
        return {
          bytes,
          source: "allocator-staging+dirty-range-queue-write",
          stagingReceiptExact,
          allocatorDirtyRangeFlush: write.insideAllocatorFlush === true,
          flushQueueId: identity("queue", write.queue),
          flushBufferId: identity("buffer", write.buffer),
          flushOffset: write.offset,
          flushSize: write.size,
          flushSliceOffset,
          flushSliceBytes,
          flushSequence: write.sequence,
          frameEncoderId: identity("encoder", frameEncoder),
          renderPassEncoderId: identity("passEncoder", consumption.renderPass),
          renderPassFrameEncoderId: identity(
            "encoder",
            renderPassParent.encoder,
          ),
          consumedCommandId: identity("command", consumption.draw.command),
          consumedBindGroupId: identity("carrier", consumption.bind.bindGroup),
          consumedDynamicOffsets: consumption.bind.dynamicOffsets.slice(),
          bindSequence: consumption.bind.sequence,
          drawSequence: consumption.draw.sequence,
          drawKind: consumption.draw.kind,
          drawCount: consumption.draw.count,
          renderPassOwnedByFrameEncoder: true,
          drawConsumedCommandExact:
            consumption.bind.command === consumption.draw.command,
          submittedCommandBufferId: identity(
            "commandBuffer",
            submittedCommandBuffer,
          ),
          finishedFrameEncoderId: identity("encoder", finish.encoder),
          finishSequence: finish.sequence,
          submitQueueId: identity("queue", submit.queue),
          submitSequence: submit.sequence,
          submitCommandBufferCount: submit.commandBuffers.length,
          submitContainsOwningCommandBuffer: submit.commandBuffers.includes(
            submittedCommandBuffer,
          ),
          owningSubmitObserved: true,
          submittedAfterFlush,
          submittedAfterDraw,
          receiptExact:
            stagingReceiptExact &&
            equal(flushSliceBytes, bytes) &&
            submittedAfterFlush &&
            submittedAfterDraw &&
            consumption.bind.command === consumption.draw.command,
          allocationEpoch: upload.allocationEpoch,
        };
      };
      const resolve = (command, label = null) => {
        const bindGroup = command._bindGroups?.[0];
        const dynamicOffset = command._bindGroup0DynamicOffsets?.[2];
        if (
          !bindGroup ||
          !Number.isSafeInteger(dynamicOffset) ||
          dynamicOffset < 0
        ) {
          throw new Error(
            "WebGPU globe command has no binding-2 dynamic-offset carrier",
          );
        }
        const binding = bindGroupRecords.findLast(
          (entry) =>
            entry.bindGroup === bindGroup &&
            entry.dynamicOffsets[2] === dynamicOffset &&
            (label === null || entry.label === label),
        );
        if (!binding) {
          throw new Error(
            "command has no observed actual binding-2 descriptor",
          );
        }
        const prepare = prepareRecords.findLast(
          (entry) =>
            entry.label === binding.label &&
            entry.result.buffer === binding.eclipseUB.buffer &&
            entry.result.offset === binding.eclipseUB.offset &&
            entry.result.size === binding.eclipseUB.size,
        );
        if (!prepare) {
          throw new Error(
            "binding-2 descriptor has no manager.prepare receipt",
          );
        }
        const draw = renderPassDraws.findLast(
          (entry) =>
            entry.command === command &&
            entry.label === binding.label &&
            entry.kind === "drawIndexed",
        );
        const consumedBind = draw
          ? renderPassBinds.findLast(
              (entry) =>
                entry.command === command &&
                entry.label === binding.label &&
                entry.renderPass === draw.renderPass &&
                entry.sequence < draw.sequence &&
                entry.index === 0 &&
                entry.bindGroup === bindGroup &&
                entry.dynamicOffsets.length === 3 &&
                entry.dynamicOffsets[2] === dynamicOffset,
            )
          : undefined;
        if (!draw || !(draw.count > 0) || !consumedBind) {
          throw new Error(
            "WebGPU globe command was not consumed by an indexed draw with its exact binding-2 carrier",
          );
        }
        const consumption = {
          renderPass: draw.renderPass,
          bind: consumedBind,
          draw,
        };
        const slice = readSlice(
          binding.eclipseUB.buffer,
          dynamicOffset,
          binding.eclipseUB.size,
          binding.label,
          consumption,
        );
        return {
          commandId: identity("command", command),
          carrierId: identity("carrier", bindGroup),
          offset: Number(dynamicOffset),
          payload: payloadFromBytes(slice.bytes),
          rendererId: identity("renderer", renderer),
          managerId: identity("manager", manager),
          tileProviderId: identity("tileProvider", tileProvider),
          bindGroupId: identity("carrier", bindGroup),
          bufferId: identity("buffer", binding.eclipseUB.buffer),
          baseOffset: 0,
          absoluteOffset: Number(dynamicOffset),
          size: Number(binding.eclipseUB.size),
          allocationEpoch: prepare.allocationEpoch,
          viewId: prepare.viewId,
          shadowRevision: prepare.shadowRevision,
          selectionRevision: prepare.selectionRevision,
          prepareCallCount: prepareRecords.filter(
            (entry) => entry.label === binding.label,
          ).length,
          managerResultExact:
            prepare.managerThisExact === true &&
            prepare.result.buffer === binding.eclipseUB.buffer &&
            prepare.result.offset === dynamicOffset &&
            prepare.result.size === binding.eclipseUB.size,
          bindGroupResourceExact:
            binding.rendererThisExact === true &&
            binding.dynamicOffsets.length === 3 &&
            binding.dynamicOffsets[2] === dynamicOffset,
          uploadSource: slice.source,
          stagingReceiptExact: slice.stagingReceiptExact,
          allocatorDirtyRangeFlush: slice.allocatorDirtyRangeFlush,
          flushQueueId: slice.flushQueueId,
          flushBufferId: slice.flushBufferId,
          flushOffset: slice.flushOffset,
          flushSize: slice.flushSize,
          flushSliceOffset: slice.flushSliceOffset,
          flushSliceBytes: slice.flushSliceBytes,
          flushSequence: slice.flushSequence,
          frameEncoderId: slice.frameEncoderId,
          renderPassEncoderId: slice.renderPassEncoderId,
          renderPassFrameEncoderId: slice.renderPassFrameEncoderId,
          consumedCommandId: slice.consumedCommandId,
          consumedBindGroupId: slice.consumedBindGroupId,
          consumedDynamicOffsets: slice.consumedDynamicOffsets,
          bindSequence: slice.bindSequence,
          drawSequence: slice.drawSequence,
          drawKind: slice.drawKind,
          drawCount: slice.drawCount,
          renderPassOwnedByFrameEncoder: slice.renderPassOwnedByFrameEncoder,
          drawConsumedCommandExact: slice.drawConsumedCommandExact,
          submittedCommandBufferId: slice.submittedCommandBufferId,
          finishedFrameEncoderId: slice.finishedFrameEncoderId,
          finishSequence: slice.finishSequence,
          submitQueueId: slice.submitQueueId,
          submitSequence: slice.submitSequence,
          submitCommandBufferCount: slice.submitCommandBufferCount,
          submitContainsOwningCommandBuffer:
            slice.submitContainsOwningCommandBuffer,
          owningSubmitObserved: slice.owningSubmitObserved,
          submittedAfterFlush: slice.submittedAfterFlush,
          submittedAfterDraw: slice.submittedAfterDraw,
          uploadReceiptExact:
            slice.receiptExact &&
            slice.allocationEpoch === prepare.allocationEpoch,
          uploadBytes: slice.bytes,
        };
      };
      webgpuProof = {
        renderer,
        manager,
        sources,
        frameEncoders,
        execute,
        resolve,
      };
    } catch (error) {
      if (!restoreInstrumentation()) {
        throw new AggregateError(
          [error],
          "WebGPU carrier instrumentation failed and did not restore exactly",
          { cause: error },
        );
      }
      throw error;
    }
  }

  const commandCapture = (frameState, label) => {
    const selected = tileProvider._quadtree._tilesToRender;
    const command = frameState.commandList.find(
      (candidate) =>
        candidate?.pass === C.Pass.GLOBE && selected.includes(candidate.owner),
    );
    if (!command)
      throw new Error("logical View preparation emitted no globe command");
    if (actualRenderer === "webgl") {
      const uniformMap = command.uniformMap;
      const resolver = uniformMap?.u_eclipseGlobeShadow;
      if (typeof resolver !== "function") {
        throw new Error(
          "WebGL globe command has no production S5 uniform resolver",
        );
      }
      const payload = Array.from(resolver.call(uniformMap), Number).map(
        Math.fround,
      );
      const valueObject = uniformMap?.properties?.eclipseGlobeShadow;
      if (!valueObject) {
        throw new Error("WebGL uniform map has no retained eclipse value");
      }
      const propertiesOverlay = uniformMap.properties;
      const propertiesPrototype = Object.getPrototypeOf(propertiesOverlay);
      const pooledUniformMap =
        tileProvider._uniformMaps.find(
          (candidate) => candidate?.properties === propertiesPrototype,
        ) ?? uniformMap;
      const pooledProperties = pooledUniformMap.properties;
      const nonS5Keys = Reflect.ownKeys(pooledUniformMap).filter(
        (key) => key !== "properties",
      );
      const overlayNonS5Keys = Reflect.ownKeys(uniformMap).filter(
        (key) => key !== "properties",
      );
      const eclipseDescriptor = Object.getOwnPropertyDescriptor(
        propertiesOverlay,
        "eclipseGlobeShadow",
      );
      const carrierPropertiesDescriptor = Object.getOwnPropertyDescriptor(
        uniformMap,
        "properties",
      );
      const snapshotPayloadDescriptor = Object.getOwnPropertyDescriptor(
        valueObject,
        "webglPackedUniform",
      );
      const onlyEclipseOwnProperty =
        Reflect.ownKeys(propertiesOverlay).length === 1 &&
        eclipseDescriptor?.value === valueObject &&
        eclipseDescriptor.writable === false &&
        eclipseDescriptor.enumerable === true &&
        eclipseDescriptor.configurable === false;
      const nonS5UniformDescriptorsExact =
        overlayNonS5Keys.length === nonS5Keys.length &&
        nonS5Keys.every(
          (key) =>
            Object.hasOwn(uniformMap, key) &&
            sameDescriptor(
              Object.getOwnPropertyDescriptor(uniformMap, key),
              Object.getOwnPropertyDescriptor(pooledUniformMap, key),
            ),
        );
      const nonS5ResolvedValueExact =
        typeof uniformMap.u_initialColor === "function" &&
        uniformMap.u_initialColor === pooledUniformMap.u_initialColor &&
        uniformMap.u_initialColor.call(uniformMap) ===
          pooledUniformMap.u_initialColor.call(pooledUniformMap);
      const uniformMapId = identity("carrier", uniformMap);
      const pooledUniformMapId = identity("carrier", pooledUniformMap);
      const propertiesOverlayId = identity("properties", propertiesOverlay);
      const pooledPropertiesId = identity("properties", pooledProperties);
      const getterId = identity("getter", resolver);
      const snapshotObjectId = identity("snapshot", valueObject);
      const sourceShadowObjectId = identity(
        "shadow",
        frameState.eclipseGlobeShadow,
      );
      return {
        record: {
          kind: "webgl-production-uniform-resolver",
          commandId: identity("command", command),
          ownerIsGlobe: true,
          carrierId: uniformMapId,
          eclipseDynamicOffset: 0,
          resolvedPayload: payload,
          backendReceipt: {
            kind: "webgl-production-uniform-resolver",
            uniformMapId,
            pooledUniformMapId,
            propertiesOverlayId,
            pooledPropertiesId,
            getterId,
            snapshotObjectId,
            sourceShadowObjectId,
            snapshotDistinctFromSource:
              valueObject !== frameState.eclipseGlobeShadow,
            snapshotFrozen: Object.isFrozen(valueObject),
            snapshotPayloadFrozen: Object.isFrozen(
              valueObject.webglPackedUniform,
            ),
            snapshotWrapperExact:
              Reflect.ownKeys(valueObject).length === 1 &&
              snapshotPayloadDescriptor?.value ===
                valueObject.webglPackedUniform &&
              snapshotPayloadDescriptor.writable === false &&
              snapshotPayloadDescriptor.enumerable === true &&
              snapshotPayloadDescriptor.configurable === false,
            carrierPropertiesDescriptorExact:
              carrierPropertiesDescriptor?.value === propertiesOverlay &&
              carrierPropertiesDescriptor.writable === false &&
              carrierPropertiesDescriptor.enumerable === true &&
              carrierPropertiesDescriptor.configurable === false,
            propertiesOverlayDistinctFromPooled:
              propertiesOverlay !== pooledProperties,
            propertiesPrototypeExact: propertiesPrototype === pooledProperties,
            onlyEclipseOwnProperty,
            nonS5UniformDescriptorsExact,
            nonS5ResolvedValueExact,
            resolvedPayload: payload.slice(),
          },
        },
        retained: {
          command,
          carrier: uniformMap,
          getter: resolver,
          offset: 0,
          resolve: () => ({
            commandId: identity("command", command),
            carrierId: identity("carrier", uniformMap),
            offset: 0,
            getterId: identity("getter", uniformMap.u_eclipseGlobeShadow),
            snapshotObjectId: identity(
              "snapshot",
              uniformMap.properties.eclipseGlobeShadow,
            ),
            payload: Array.from(
              uniformMap.u_eclipseGlobeShadow.call(uniformMap),
              Number,
            ).map(Math.fround),
          }),
        },
      };
    }
    return {
      record: null,
      retained: {
        command,
        carrier: command._bindGroups[0],
        offset: Number(command._bindGroup0DynamicOffsets?.[2]),
        resolve: () => webgpuProof.resolve(command),
      },
    };
  };

  const captureWebgpuCommandAfterSubmit = (command, label) => {
    const resolved = webgpuProof.resolve(command, label);
    return {
      kind: "webgpu-bind-group-dynamic-offset",
      commandId: resolved.commandId,
      ownerIsGlobe: true,
      carrierId: resolved.carrierId,
      eclipseDynamicOffset: resolved.offset,
      resolvedPayload: resolved.payload,
      backendReceipt: {
        kind: "webgpu-binding-2-upload",
        rendererClass: webgpuProof.renderer.constructor.name,
        rendererId: resolved.rendererId,
        managerId: resolved.managerId,
        tileProviderId: resolved.tileProviderId,
        publishedTileProviderExact:
          webgpuProof.sources.tileProvider === tileProvider,
        bindGroupId: resolved.bindGroupId,
        bufferId: resolved.bufferId,
        baseOffset: resolved.baseOffset,
        dynamicOffset: resolved.offset,
        absoluteOffset: resolved.absoluteOffset,
        size: resolved.size,
        allocationEpoch: resolved.allocationEpoch,
        viewId: resolved.viewId,
        shadowRevision: resolved.shadowRevision,
        selectionRevision: resolved.selectionRevision,
        prepareCallCount: resolved.prepareCallCount,
        managerResultExact: resolved.managerResultExact,
        bindGroupResourceExact: resolved.bindGroupResourceExact,
        uploadSource: resolved.uploadSource,
        stagingReceiptExact: resolved.stagingReceiptExact,
        allocatorDirtyRangeFlush: resolved.allocatorDirtyRangeFlush,
        flushQueueId: resolved.flushQueueId,
        flushBufferId: resolved.flushBufferId,
        flushOffset: resolved.flushOffset,
        flushSize: resolved.flushSize,
        flushSliceOffset: resolved.flushSliceOffset,
        flushSliceBytes: resolved.flushSliceBytes,
        flushSequence: resolved.flushSequence,
        frameEncoderId: resolved.frameEncoderId,
        renderPassEncoderId: resolved.renderPassEncoderId,
        renderPassFrameEncoderId: resolved.renderPassFrameEncoderId,
        consumedCommandId: resolved.consumedCommandId,
        consumedBindGroupId: resolved.consumedBindGroupId,
        consumedDynamicOffsets: resolved.consumedDynamicOffsets,
        bindSequence: resolved.bindSequence,
        drawSequence: resolved.drawSequence,
        drawKind: resolved.drawKind,
        drawCount: resolved.drawCount,
        renderPassOwnedByFrameEncoder: resolved.renderPassOwnedByFrameEncoder,
        drawConsumedCommandExact: resolved.drawConsumedCommandExact,
        submittedCommandBufferId: resolved.submittedCommandBufferId,
        finishedFrameEncoderId: resolved.finishedFrameEncoderId,
        finishSequence: resolved.finishSequence,
        submitQueueId: resolved.submitQueueId,
        submitSequence: resolved.submitSequence,
        submitCommandBufferCount: resolved.submitCommandBufferCount,
        submitContainsOwningCommandBuffer:
          resolved.submitContainsOwningCommandBuffer,
        owningSubmitObserved: resolved.owningSubmitObserved,
        submittedAfterFlush: resolved.submittedAfterFlush,
        submittedAfterDraw: resolved.submittedAfterDraw,
        uploadReceiptExact: resolved.uploadReceiptExact,
        uploadBytes: resolved.uploadBytes,
        uploadSha256: null,
      },
    };
  };

  const prepareLogicalView = (view, label) => {
    scene.view = view;
    activeLogicalLabel = label;
    let frameBegun = false;
    let capture;
    let destroyProofTargets = null;
    try {
      context.beginFrame();
      frameBegun = true;
      if (actualRenderer === "webgpu") {
        const frameEncoder =
          context.currentCommandEncoder ?? context._currentCommandEncoder;
        if (!frameEncoder) {
          throw new Error("WebGPU logical View frame encoder is unavailable");
        }
        webgpuProof.frameEncoders.set(label, frameEncoder);
      }
      scene.initializeFrame();
      scene.updateFrameState();
      const frameState = scene.frameState;
      frameState.passes.pick = true;
      frameState.passes.offscreen = view !== defaultView;
      context.uniformState.update(frameState);
      tileProvider.updateForPick(frameState);
      const command = commandCapture(frameState, label);
      if (actualRenderer === "webgpu") {
        destroyProofTargets = webgpuProof.execute(
          command.retained.command,
          label,
          view.passState,
        );
      }
      capture = {
        value: {
          label,
          viewId: identity("view", view),
          constructorIsView: view instanceof C.View,
          contextId: identity("context", view.effectiveContext),
          canvasId: identity("canvas", view.effectiveContext.canvas),
          defaultViewId: identity("view", defaultView),
          isDefaultView: view === defaultView,
          frameStateViewId: identity("view", frameState.view),
          frameNumber: Number(frameState.frameNumber),
          camera: cameraSnapshot(view.camera),
          frustum: frustumSnapshot(view.camera.frustum),
          viewport: viewportSnapshot(view.viewport),
          eclipse: eclipseSnapshot(frameState, view),
          command: command.record,
        },
        retained: command.retained,
      };
    } finally {
      try {
        if (frameBegun) context.endFrame();
      } finally {
        try {
          destroyProofTargets?.();
        } finally {
          activeLogicalLabel = null;
        }
      }
    }
    if (actualRenderer === "webgpu") {
      capture.value.command = captureWebgpuCommandAfterSubmit(
        capture.retained.command,
        label,
      );
    }
    return capture;
  };

  let aBefore;
  let b;
  let aAfter;
  let retainedAfterB;
  let retainedAfterAReentry;
  let carrierSequenceError;
  try {
    aBefore = prepareLogicalView(viewA, "A-before");
    completePhase(contract.phases[2]);
    b = prepareLogicalView(viewB, "B");
    retainedAfterB = aBefore.retained.resolve();
    completePhase(contract.phases[3]);
    aAfter = prepareLogicalView(viewA, "A-after");
    retainedAfterAReentry = aBefore.retained.resolve();
    completePhase(contract.phases[4]);
  } catch (error) {
    carrierSequenceError = error;
  }
  let instrumentationRestoreError;
  try {
    if (!restoreInstrumentation()) {
      instrumentationRestoreError = new Error(
        "multiview backend instrumentation did not restore exactly",
      );
    }
  } catch (error) {
    instrumentationRestoreError = error;
  }
  if (carrierSequenceError && instrumentationRestoreError) {
    throw new AggregateError(
      [carrierSequenceError, instrumentationRestoreError],
      "multiview carrier sequence and instrumentation restoration failed",
      { cause: carrierSequenceError },
    );
  }
  if (carrierSequenceError) throw carrierSequenceError;
  if (instrumentationRestoreError) throw instrumentationRestoreError;

  if (actualRenderer === "webgpu") {
    for (const capture of [aBefore, b, aAfter]) {
      const receipt = capture.value.command.backendReceipt;
      receipt.uploadSha256 = await hashByteArray(receipt.uploadBytes);
    }
    retainedAfterB.uploadSha256 = await hashByteArray(
      retainedAfterB.uploadBytes,
    );
    retainedAfterAReentry.uploadSha256 = await hashByteArray(
      retainedAfterAReentry.uploadBytes,
    );
  }

  const retainedACommand = {
    kind: aBefore.value.command.kind,
    beforeCommandId: aBefore.value.command.commandId,
    afterBCommandId: retainedAfterB.commandId,
    afterAReentryCommandId: retainedAfterAReentry.commandId,
    bCommandId: b.value.command.commandId,
    beforeCarrierId: aBefore.value.command.carrierId,
    afterBCarrierId: retainedAfterB.carrierId,
    afterAReentryCarrierId: retainedAfterAReentry.carrierId,
    bCarrierId: b.value.command.carrierId,
    beforeOffset: aBefore.value.command.eclipseDynamicOffset,
    afterBOffset: retainedAfterB.offset,
    afterAReentryOffset: retainedAfterAReentry.offset,
    bOffset: b.value.command.eclipseDynamicOffset,
    beforePayload: aBefore.value.command.resolvedPayload,
    afterBPayload: retainedAfterB.payload,
    afterAReentryPayload: retainedAfterAReentry.payload,
    bPayload: b.value.command.resolvedPayload,
    resolvesA: equal(
      aBefore.value.command.resolvedPayload,
      retainedAfterB.payload,
    ),
    resolvesAAfterReentry: equal(
      aBefore.value.command.resolvedPayload,
      retainedAfterAReentry.payload,
    ),
    doesNotResolveB: !equal(
      retainedAfterB.payload,
      b.value.command.resolvedPayload,
    ),
    backendReceipt:
      actualRenderer === "webgl"
        ? {
            kind: "webgl-retained-uniform-map",
            beforeGetterId: aBefore.value.command.backendReceipt.getterId,
            afterBGetterId: retainedAfterB.getterId,
            afterAReentryGetterId: retainedAfterAReentry.getterId,
            bGetterId: b.value.command.backendReceipt.getterId,
            beforeSnapshotObjectId:
              aBefore.value.command.backendReceipt.snapshotObjectId,
            afterBSnapshotObjectId: retainedAfterB.snapshotObjectId,
            afterAReentrySnapshotObjectId:
              retainedAfterAReentry.snapshotObjectId,
            bSnapshotObjectId: b.value.command.backendReceipt.snapshotObjectId,
          }
        : {
            kind: "webgpu-retained-binding-2-slice",
            beforeRendererId: aBefore.value.command.backendReceipt.rendererId,
            afterBRendererId: retainedAfterB.rendererId,
            afterAReentryRendererId: retainedAfterAReentry.rendererId,
            bRendererId: b.value.command.backendReceipt.rendererId,
            beforeManagerId: aBefore.value.command.backendReceipt.managerId,
            afterBManagerId: retainedAfterB.managerId,
            afterAReentryManagerId: retainedAfterAReentry.managerId,
            bManagerId: b.value.command.backendReceipt.managerId,
            beforeBufferId: aBefore.value.command.backendReceipt.bufferId,
            afterBBufferId: retainedAfterB.bufferId,
            afterAReentryBufferId: retainedAfterAReentry.bufferId,
            bBufferId: b.value.command.backendReceipt.bufferId,
            beforeAbsoluteOffset:
              aBefore.value.command.backendReceipt.absoluteOffset,
            afterBAbsoluteOffset: retainedAfterB.absoluteOffset,
            afterAReentryAbsoluteOffset: retainedAfterAReentry.absoluteOffset,
            bAbsoluteOffset: b.value.command.backendReceipt.absoluteOffset,
            beforeSize: aBefore.value.command.backendReceipt.size,
            afterBSize: retainedAfterB.size,
            afterAReentrySize: retainedAfterAReentry.size,
            bSize: b.value.command.backendReceipt.size,
            beforeUploadBytes:
              aBefore.value.command.backendReceipt.uploadBytes.slice(),
            afterBUploadBytes: retainedAfterB.uploadBytes.slice(),
            afterAReentryUploadBytes: retainedAfterAReentry.uploadBytes.slice(),
            bUploadBytes: b.value.command.backendReceipt.uploadBytes.slice(),
            beforeUploadSha256:
              aBefore.value.command.backendReceipt.uploadSha256,
            afterBUploadSha256: retainedAfterB.uploadSha256,
            afterAReentryUploadSha256: retainedAfterAReentry.uploadSha256,
            bUploadSha256: b.value.command.backendReceipt.uploadSha256,
            aSliceUnchangedAfterB: equal(
              aBefore.value.command.backendReceipt.uploadBytes,
              retainedAfterB.uploadBytes,
            ),
            aSliceUnchangedAfterAReentry: equal(
              aBefore.value.command.backendReceipt.uploadBytes,
              retainedAfterAReentry.uploadBytes,
            ),
            aAndBNonOverlapping:
              aBefore.value.command.backendReceipt.bufferId !==
                b.value.command.backendReceipt.bufferId ||
              aBefore.value.command.backendReceipt.absoluteOffset +
                aBefore.value.command.backendReceipt.size <=
                b.value.command.backendReceipt.absoluteOffset ||
              b.value.command.backendReceipt.absoluteOffset +
                b.value.command.backendReceipt.size <=
                aBefore.value.command.backendReceipt.absoluteOffset,
          },
  };
  const isolation = {
    sequence: ["A", "B", "A"],
    toolsSchedulerOwned: true,
    engineSchedulerAvailable: false,
    nativeSceneRenderUsed: false,
    sameContext:
      aBefore.value.contextId === b.value.contextId &&
      b.value.contextId === aAfter.value.contextId,
    sameCanvas:
      aBefore.value.canvasId === b.value.canvasId &&
      b.value.canvasId === aAfter.value.canvasId,
    defaultViewStable:
      aBefore.value.defaultViewId === b.value.defaultViewId &&
      b.value.defaultViewId === aAfter.value.defaultViewId &&
      defaultView === viewA,
    viewsDistinct: aBefore.value.viewId !== b.value.viewId,
    camerasDistinct: !equal(aBefore.value.camera, b.value.camera),
    frustumsDistinct: !equal(aBefore.value.frustum, b.value.frustum),
    viewportsDistinct: !equal(aBefore.value.viewport, b.value.viewport),
    viewOwnedStateDistinct:
      aBefore.value.eclipse.stateObjectId !== b.value.eclipse.stateObjectId,
    viewOwnedShadowDistinct:
      aBefore.value.eclipse.shadowObjectId !== b.value.eclipse.shadowObjectId,
    aCameraStable: equal(aBefore.value.camera, aAfter.value.camera),
    aFrustumStable: equal(aBefore.value.frustum, aAfter.value.frustum),
    aViewportStable: equal(aBefore.value.viewport, aAfter.value.viewport),
    aStatePayloadStable: equal(
      aBefore.value.eclipse.state,
      aAfter.value.eclipse.state,
    ),
    aShadowPayloadStable: equal(
      aBefore.value.eclipse.shadow,
      aAfter.value.eclipse.shadow,
    ),
    aRevisionStable:
      aBefore.value.eclipse.shadow.revision ===
      aAfter.value.eclipse.shadow.revision,
    aSelectionRevisionProgressed:
      aAfter.value.eclipse.selectionRevision >=
      aBefore.value.eclipse.selectionRevision,
    bPayloadDistinct:
      !equal(aBefore.value.eclipse.state, b.value.eclipse.state) ||
      !equal(aBefore.value.eclipse.shadow, b.value.eclipse.shadow),
    retainedACommand,
  };
  completePhase(contract.phases[5]);

  scene.view = defaultView;
  scene.updateFrameState();
  context.uniformState.update(scene.frameState);
  const offscreenView = scene.picking._pickOffscreenView;
  const rayOrigin = C.Cartesian3.fromDegrees(
    contract.workload.viewA.longitudeDegrees,
    contract.workload.viewA.latitudeDegrees,
    contract.workload.viewA.heightMeters,
    scene.globe.ellipsoid,
  );
  const rayTarget = C.Cartesian3.fromDegrees(
    contract.workload.viewA.longitudeDegrees,
    contract.workload.viewA.latitudeDegrees,
    0,
    scene.globe.ellipsoid,
  );
  const rayDirection = C.Cartesian3.normalize(
    C.Cartesian3.subtract(rayTarget, rayOrigin, new C.Cartesian3()),
    new C.Cartesian3(),
  );
  const ray = new C.Ray(rayOrigin, rayDirection);
  let observedOffscreen = false;
  let observedFrameStateViewId = null;
  let observedFrameStateCameraId = null;
  let observedStateObjectId = null;
  let observedShadowObjectId = null;
  const updateFrameStatePatch = installExactMethod(
    scene,
    "updateFrameState",
    (original) =>
      function (...args) {
        const activeIsOffscreen = scene.view === offscreenView;
        const result = original.apply(this, args);
        if (activeIsOffscreen) {
          observedOffscreen = true;
          observedFrameStateViewId = identity("view", scene.frameState.view);
          observedFrameStateCameraId = identity(
            "camera",
            scene.frameState.camera,
          );
          observedStateObjectId = identity(
            "state",
            scene.frameState.view._eclipseState,
          );
          observedShadowObjectId = identity(
            "shadow",
            scene.frameState.view._eclipseGlobeShadow,
          );
        }
        return result;
      },
  );
  let pickResult;
  let attempts = 0;
  let pickError;
  let updateFrameStateRestoreError;
  try {
    while (attempts < contract.workload.maximumRayPickAttempts) {
      attempts++;
      pickResult = scene.pickFromRay(ray, [], contract.workload.rayWidthMeters);
      const object = pickResult?.object;
      const rawGlobeHit =
        pickResult !== undefined &&
        object === undefined &&
        pickResult.position !== undefined;
      if (rawGlobeHit || (actualRenderer === "webgpu" && observedOffscreen)) {
        break;
      }
      scene.render(pinnedTime);
      await waitFrame();
    }
  } catch (error) {
    pickError = error;
  } finally {
    try {
      if (!updateFrameStatePatch.restore()) {
        updateFrameStateRestoreError = new Error(
          "offscreen updateFrameState descriptor did not restore",
        );
      }
    } catch (error) {
      updateFrameStateRestoreError = error;
    }
  }
  if (pickError && updateFrameStateRestoreError) {
    throw new AggregateError(
      [pickError, updateFrameStateRestoreError],
      "offscreen ray pick and descriptor restoration failed",
      { cause: pickError },
    );
  }
  if (pickError) throw pickError;
  if (updateFrameStateRestoreError) throw updateFrameStateRestoreError;
  const pickedObject = pickResult?.object;
  const rawGlobeHit =
    pickResult !== undefined &&
    pickedObject === undefined &&
    pickResult.position !== undefined;
  const cpuEllipsoidInterval = C.IntersectionTests.rayEllipsoid(
    ray,
    scene.globe.ellipsoid,
  );
  if (!cpuEllipsoidInterval) {
    throw new Error("workload ray has no CPU WGS84 ellipsoid intersection");
  }
  const cpuIntersectionPosition = C.Ray.getPoint(
    ray,
    cpuEllipsoidInterval.start,
    new C.Cartesian3(),
  );
  const geometricPosition = scene.globe.pick(ray, scene, new C.Cartesian3());
  const offscreenRayPick = {
    viewId: identity("view", offscreenView),
    defaultViewId: identity("view", defaultView),
    cameraId: identity("camera", offscreenView.camera),
    defaultCameraId: identity("camera", defaultView.camera),
    constructorIsView: offscreenView instanceof C.View,
    distinctFromDefault: offscreenView !== defaultView,
    orthographicFrustum:
      offscreenView.camera.frustum instanceof C.OrthographicFrustum,
    realViewObservedDuringUpdate: observedOffscreen,
    frameStateViewIdDuringUpdate: observedFrameStateViewId,
    frameStateCameraIdDuringUpdate: observedFrameStateCameraId,
    eclipseStateObjectId: observedStateObjectId,
    defaultEclipseStateObjectId: identity("state", defaultView._eclipseState),
    eclipseShadowObjectId: observedShadowObjectId,
    defaultEclipseShadowObjectId: identity(
      "shadow",
      defaultView._eclipseGlobeShadow,
    ),
    ray: {
      origin: vector(ray.origin),
      direction: vector(ray.direction),
      widthMeters: contract.workload.rayWidthMeters,
    },
    attempts,
    supportsSynchronousReadback: context.supportsSynchronousReadback === true,
    resultPolicy:
      actualRenderer === "webgl"
        ? "sync-position-only-globe"
        : "known-webgpu-no-position-globe",
    hit: pickResult !== undefined,
    hitGlobe: rawGlobeHit,
    objectPresent: pickedObject !== undefined,
    position: pickResult?.position ? vector(pickResult.position) : null,
    cpuEllipsoidInterval: {
      start: Number(cpuEllipsoidInterval.start),
      stop: Number(cpuEllipsoidInterval.stop),
    },
    cpuIntersectionPosition: vector(cpuIntersectionPosition),
    geometricGlobeHit: geometricPosition !== undefined,
    geometricPosition: geometricPosition ? vector(geometricPosition) : null,
  };
  completePhase(contract.phases[6]);

  const defaultCameraPosition = vector(defaultView.camera.positionWC);
  const uniformCameraPosition = vector(context.uniformState.cameraPosition);
  const restoration = {
    sceneViewId: identity("view", scene.view),
    defaultViewId: identity("view", defaultView),
    frameStateViewId: identity("view", scene.frameState.view),
    frameStateCameraId: identity("camera", scene.frameState.camera),
    defaultCameraId: identity("camera", defaultView.camera),
    uniformCameraPosition,
    defaultCameraPosition,
    eclipseStateObjectId: identity(
      "state",
      scene.frameState.view._eclipseState,
    ),
    defaultEclipseStateObjectId: identity("state", defaultView._eclipseState),
    eclipseShadowObjectId: identity(
      "shadow",
      scene.frameState.view._eclipseGlobeShadow,
    ),
    defaultEclipseShadowObjectId: identity(
      "shadow",
      defaultView._eclipseGlobeShadow,
    ),
    allAliasesRestored:
      scene.view === defaultView &&
      scene.frameState.view === defaultView &&
      scene.frameState.camera === defaultView.camera &&
      distance(uniformCameraPosition, defaultCameraPosition) <= 1e-7,
  };
  completePhase(contract.phases[7]);

  let webglVr = null;
  let webgpuVr = null;
  if (actualRenderer === "webgl") {
    prepareLogicalView(viewA, "A-after");
    const centerCameraPosition = vector(defaultView.camera.positionWC);
    const centerCameraRight = vector(defaultView.camera.rightWC);
    const centerStateObjectId = identity("state", defaultView._eclipseState);
    const centerShadowObjectId = identity(
      "shadow",
      defaultView._eclipseGlobeShadow,
    );
    const centerShadowPayload = packedShadow(defaultView._eclipseGlobeShadow);
    const passState = defaultView.passState;
    const originalViewport = passState.viewport;
    const viewportProxy = new Proxy(originalViewport, {
      set(target, property, value) {
        target[property] = value;
        return true;
      },
    });
    passState.viewport = viewportProxy;
    const uniformState = context.uniformState;
    const observations = [];
    const updateCameraPatch = installExactMethod(
      uniformState,
      "updateCamera",
      (original) =>
        function (camera, ...args) {
          if (
            scene.useWebVR === true &&
            camera === scene.camera &&
            typeof camera.frustum.xOffset === "number" &&
            camera.frustum.xOffset !== 0
          ) {
            observations.push({
              side: camera.frustum.xOffset > 0 ? "left" : "right",
              cameraPosition: vector(camera.positionWC),
              xOffset: Number(camera.frustum.xOffset),
              viewport: viewportSnapshot(viewportProxy),
              eclipseStateObjectId: identity(
                "state",
                scene.frameState.view._eclipseState,
              ),
              eclipseShadowObjectId: identity(
                "shadow",
                scene.frameState.view._eclipseGlobeShadow,
              ),
              shadowRevision: Number(
                scene.frameState.view._eclipseGlobeShadow.revision,
              ),
              shadowPayload: packedShadow(
                scene.frameState.view._eclipseGlobeShadow,
              ),
            });
          }
          return original.call(this, camera, ...args);
        },
    );
    let left;
    let right;
    let vrRenderError;
    let vrCleanupError;
    try {
      scene.useWebVR = true;
      scene.render(pinnedTime);
      left = observations.find((entry) => entry.side === "left");
      right = observations.find((entry) => entry.side === "right");
    } catch (error) {
      vrRenderError = error;
    } finally {
      const cleanupErrors = [];
      try {
        if (!updateCameraPatch.restore()) {
          cleanupErrors.push(
            new Error("WebGL VR updateCamera descriptor did not restore"),
          );
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        if (scene.useWebVR) scene.useWebVR = false;
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        passState.viewport = originalViewport;
        Object.assign(originalViewport, contract.workload.viewA.viewport);
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        if (
          !restoreOwnDescriptor(
            defaultCamera.frustum,
            "fov",
            frustumFovHadOwn,
            frustumFovDescriptor,
          )
        ) {
          cleanupErrors.push(
            new Error("WebGL VR frustum fov descriptor did not restore"),
          );
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0) {
        vrCleanupError = new AggregateError(
          cleanupErrors,
          "WebGL VR cleanup did not restore exactly",
          { cause: cleanupErrors[0] },
        );
      }
    }
    if (vrRenderError && vrCleanupError) {
      throw new AggregateError(
        [vrRenderError, vrCleanupError],
        "WebGL VR render and cleanup failed",
        { cause: vrRenderError },
      );
    }
    if (vrRenderError) throw vrRenderError;
    if (vrCleanupError) throw vrCleanupError;
    if (!left || !right)
      throw new Error("WebGL VR did not expose both eye observations");
    completePhase(contract.phases[8]);
    const midpoint = left.cameraPosition.map(
      (value, index) => (value + right.cameraPosition[index]) * 0.5,
    );
    webglVr = {
      method: contract.workload.webglStereoMethod,
      supported: context.supportsStereoViewport === true,
      centerCameraPosition,
      centerCameraRight,
      centerStateObjectId,
      centerShadowObjectId,
      centerShadowPayload,
      left,
      right,
      twoEyesObserved: left.side === "left" && right.side === "right",
      distinctViewports:
        left.viewport.x !== right.viewport.x &&
        left.viewport.width === right.viewport.width &&
        left.viewport.width === contract.workload.viewport.width * 0.5,
      symmetricEyePositions: distance(midpoint, centerCameraPosition) <= 1e-6,
      symmetricFrustumOffsets: Math.abs(left.xOffset + right.xOffset) <= 1e-15,
      sharedCenterAnchoredS5:
        left.eclipseStateObjectId === centerStateObjectId &&
        right.eclipseStateObjectId === centerStateObjectId &&
        left.eclipseShadowObjectId === centerShadowObjectId &&
        right.eclipseShadowObjectId === centerShadowObjectId &&
        equal(left.shadowPayload, right.shadowPayload),
      centerCameraRestored:
        distance(vector(defaultView.camera.positionWC), centerCameraPosition) <=
        1e-7,
      useWebVRRestoredFalse: scene.useWebVR === false,
    };
    completePhase(contract.phases[9]);
    completePhase(contract.phases[10]);
  } else {
    completePhase(contract.phases[8]);
    completePhase(contract.phases[9]);
    const hashCanvas = async () => {
      const encoded = new TextEncoder().encode(canvas.toDataURL("image/png"));
      const digest = await crypto.subtle.digest("SHA-256", encoded);
      return {
        byteLength: encoded.byteLength,
        sha256: Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join(""),
      };
    };
    const rejectState = async () => ({
      useWebVR: scene.useWebVR === true,
      sceneViewId: identity("view", scene.view),
      defaultViewId: identity("view", defaultView),
      cameraId: identity("camera", scene.camera),
      cameraPosition: vector(scene.camera.positionWC),
      frustum: frustumSnapshot(scene.camera.frustum),
      cameraVrPresent: scene._cameraVR !== undefined,
      deviceOrientationControllerPresent:
        scene._deviceOrientationCameraController !== undefined,
      creditVisibility:
        scene.frameState.creditDisplay.container.style.visibility,
      frameNumber: Number(scene.frameState.frameNumber),
      commandCount: Number(scene.frameState.commandList.length),
      canvasFingerprint: await hashCanvas(),
    });
    const before = await rejectState();
    let renderCalls = 0;
    const renderPatch = installExactMethod(
      scene,
      "render",
      (original) =>
        function (...args) {
          renderCalls++;
          return original.apply(this, args);
        },
    );
    let caught;
    let returned = false;
    let renderPatchRestoreError;
    try {
      scene.useWebVR = true;
      returned = true;
    } catch (error) {
      caught = { name: error.name, message: error.message };
    } finally {
      try {
        if (!renderPatch.restore()) {
          renderPatchRestoreError = new Error(
            "WebGPU VR render descriptor did not restore",
          );
        }
      } catch (error) {
        renderPatchRestoreError = error;
      }
    }
    if (renderPatchRestoreError) throw renderPatchRestoreError;
    const after = await rejectState();
    webgpuVr = {
      method: contract.workload.webgpuStereoMethod,
      supportsStereoViewport: context.supportsStereoViewport === true,
      before,
      error: caught ?? {
        name: "MissingError",
        message: "useWebVR setter returned",
      },
      synchronous: caught !== undefined && returned === false,
      renderCalls,
      pngSideEffects: equal(before.canvasFingerprint, after.canvasFingerprint)
        ? 0
        : 1,
      gpuSideEffects:
        before.frameNumber === after.frameNumber &&
        before.commandCount === after.commandCount
          ? 0
          : 1,
      after,
      stateUnchanged: equal(before, after),
    };
    if (
      !restoreOwnDescriptor(
        defaultCamera.frustum,
        "fov",
        frustumFovHadOwn,
        frustumFovDescriptor,
      )
    ) {
      throw new Error("WebGPU frustum fov descriptor did not restore");
    }
    completePhase(contract.phases[10]);
  }

  const pageCleanup = {
    secondaryViewDestroyed: false,
    sceneViewRestored: false,
    useWebVRFalse: false,
    instrumentationRestored,
    timersCleared: true,
  };
  scene.view = defaultView;
  if (scene.useWebVR) scene.useWebVR = false;
  viewB.destroy();
  pageCleanup.secondaryViewDestroyed = true;
  pageCleanup.sceneViewRestored = scene.view === defaultView;
  pageCleanup.useWebVRFalse = scene.useWebVR === false;
  viewer.destroy();
  globalThis.viewer = undefined;
  completePhase(contract.phases[11]);

  const result = {
    renderer: actualRenderer,
    status: "PASS",
    progress: JSON.parse(JSON.stringify(progress)),
    baseline,
    views: {
      aBefore: aBefore.value,
      b: b.value,
      aAfter: aAfter.value,
    },
    isolation,
    offscreenRayPick,
    restoration,
    webglVr,
    webgpuVr,
    cleanup: pageCleanup,
  };
  return result;
};

function pageContract(renderer) {
  return {
    renderer,
    runtimePath,
    pageSchema: C12_29_S5_MULTIVIEW_PAGE_SCHEMA,
    phases: C12_29_S5_MULTIVIEW_PHASES,
    workload: C12_29_S5_MULTIVIEW_WORKLOAD,
    webgpuVrError: C12_29_S5_MULTIVIEW_WEBGPU_VR_ERROR,
  };
}

export async function closeC1229S5MultiviewResourceBounded(
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

export async function withC1229S5MultiviewWatchdog(
  task,
  onTimeout,
  timeoutMs = WATCHDOG_MS,
  renderer = () => null,
  settlementTimeoutMs = WATCHDOG_SETTLEMENT_MS,
  monotonicNow = () => performance.now(),
) {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isSafeInteger(settlementTimeoutMs) ||
    settlementTimeoutMs < 1 ||
    typeof monotonicNow !== "function"
  ) {
    throw new Error("multiview watchdog deadlines must be positive integers");
  }
  const startedAt = monotonicNow();
  if (!Number.isFinite(startedAt)) {
    throw new Error("multiview watchdog monotonic clock is invalid");
  }
  const deadlineAt = startedAt + timeoutMs;
  const settledAt = () => {
    try {
      const value = monotonicNow();
      return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  };
  let deadlineTimer;
  const abortController = new AbortController();
  const taskPromise = Promise.resolve().then(() =>
    task(abortController.signal),
  );
  const taskOutcome = taskPromise.then(
    (value) => ({ kind: "fulfilled", value, settledAt: settledAt() }),
    (error) => ({ kind: "rejected", error, settledAt: settledAt() }),
  );
  const deadline = new Promise((resolve) => {
    deadlineTimer = setTimeout(() => resolve({ kind: "deadline" }), timeoutMs);
  });
  const first = await Promise.race([taskOutcome, deadline]);
  clearTimeout(deadlineTimer);
  const taskWonBeforeDeadline =
    first.kind !== "deadline" &&
    first.settledAt >= startedAt &&
    first.settledAt < deadlineAt;
  if (first.kind === "fulfilled" && taskWonBeforeDeadline) return first.value;
  if (first.kind === "rejected" && taskWonBeforeDeadline) throw first.error;

  let deadlineRenderer = null;
  try {
    deadlineRenderer = renderer();
  } catch {
    deadlineRenderer = null;
  }
  const error = new Error(
    `multiview watchdog expired after ${timeoutMs} ms; settlement=pending`,
  );
  error.c1229MultiviewDiagnostic = {
    renderer: deadlineRenderer,
    stage: "watchdog",
    timeoutMs,
    page: null,
  };
  abortController.abort(error);

  let taskSettled = false;
  let drainSettled = false;
  let drainSnapshot;
  const boundedTaskOutcome = taskOutcome.then((outcome) => {
    taskSettled = true;
    return outcome;
  });
  const drainOutcome = Promise.resolve()
    .then(() => onTimeout(abortController.signal))
    .then(
      (diagnostic) => ({
        renderer: diagnostic?.renderer ?? deadlineRenderer,
        page: diagnostic?.page ?? null,
        drainError: diagnostic?.drainError,
      }),
      (drainError) => ({
        renderer:
          drainError?.c1229MultiviewDiagnostic?.renderer ?? deadlineRenderer,
        page: drainError?.c1229MultiviewDiagnostic?.page ?? null,
        drainError,
      }),
    )
    .then((diagnostic) => {
      drainSettled = true;
      drainSnapshot = diagnostic;
      return diagnostic;
    });
  let settlementTimer;
  const bounded = await Promise.race([
    Promise.all([boundedTaskOutcome, drainOutcome]).then(
      ([outcome, diagnostic]) => ({ kind: "settled", outcome, diagnostic }),
    ),
    new Promise((resolve) => {
      settlementTimer = setTimeout(
        () => resolve({ kind: "settlement-deadline" }),
        settlementTimeoutMs,
      );
    }),
  ]);
  clearTimeout(settlementTimer);
  if (bounded.kind === "settlement-deadline") {
    if (drainSnapshot) {
      error.c1229MultiviewDiagnostic.renderer = drainSnapshot.renderer;
      error.c1229MultiviewDiagnostic.page = drainSnapshot.page;
    }
    error.message =
      `multiview watchdog expired after ${timeoutMs} ms; ` +
      `settlement exceeded ${settlementTimeoutMs} ms; ` +
      `taskSettled=${taskSettled}; drainSettled=${drainSettled}`;
    error.retainMultiviewRunning = true;
    Object.defineProperty(error, "c1229MultiviewSettlement", {
      value: Object.freeze({
        bounded: true,
        timeoutMs: settlementTimeoutMs,
        taskSettled,
        drainSettled,
      }),
      enumerable: false,
    });
    // These handlers own eventual rejection observation only. The caller is
    // deliberately released with retainMultiviewRunning=true, which fences all
    // ERROR/final publication behind the still-owned RUNNING lock.
    taskPromise.catch(() => {});
    drainOutcome.catch(() => {});
    throw error;
  }

  const { outcome, diagnostic } = bounded;
  error.c1229MultiviewDiagnostic.renderer = diagnostic.renderer;
  error.c1229MultiviewDiagnostic.page = diagnostic.page;
  let drainError = diagnostic.drainError;
  if (outcome.kind === "fulfilled") {
    const lateSuccess = new Error(
      "multiview task fulfilled after watchdog deadline",
    );
    drainError =
      drainError === undefined
        ? lateSuccess
        : new AggregateError(
            [drainError, lateSuccess],
            "multiview drain failed and task fulfilled after deadline",
            { cause: drainError },
          );
  }
  error.message =
    `multiview watchdog expired after ${timeoutMs} ms; ` +
    `settled=true; drained=${drainError === undefined}`;
  if (drainError !== undefined) {
    error.cause = drainError;
    error.retainMultiviewRunning = true;
  }
  throw error;
}

async function runC1229S5MultiviewBrowserSession(
  browser,
  renderer,
  baseIdentity,
  watchdogState,
) {
  const browserContext = await browser.newContext({
    viewport: { ...C12_29_S5_MULTIVIEW_WORKLOAD.viewport },
    deviceScaleFactor: 1,
  });
  const externalRequests = [];
  const failedRequests = [];
  const httpErrors = [];
  const pageErrors = [];
  const consoleErrors = [];
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
      externalRequests.push(route.request().url());
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  const page = await browserContext.newPage();
  watchdogState.renderer = renderer;
  watchdogState.page = page;
  watchdogState.pageDiagnostic = null;
  await page.addInitScript(errorGateInit);
  page.on("request", (request) => pending.add(request));
  const settle = (request) => pending.delete(request);
  page.on("requestfinished", settle);
  page.on("requestfailed", (request) => {
    settle(request);
    if (!externalRequests.includes(request.url()))
      failedRequests.push(request.url());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  let capturedEntry = false;
  let resolveEntry;
  let rejectEntry;
  const entryPromise = new Promise((resolve, reject) => {
    resolveEntry = resolve;
    rejectEntry = reject;
  });
  const responseTasks = [];
  page.on("response", (response) => {
    let url;
    try {
      url = new URL(response.url());
    } catch {
      return;
    }
    if (response.status() >= 400) {
      httpErrors.push(`${response.status()} ${url.href}`);
    }
    if (!capturedEntry && url.pathname === runtimePath) {
      capturedEntry = true;
      const task = response.body().then(
        (bytes) =>
          resolveEntry({
            sessionLabel: renderer,
            ok: response.ok(),
            status: response.status(),
            byteLength: bytes.byteLength,
            sha256: sha256(bytes),
          }),
        rejectEntry,
      );
      responseTasks.push(task);
    }
  });

  let measured;
  let sessionError;
  let pageDiagnostic = null;
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
        page.evaluate(
          MEASURE_C1229_S5_MULTIVIEW_SESSION,
          pageContract(renderer),
        ),
        new Promise((_, reject) => {
          pageTimer = setTimeout(
            () => reject(new Error(`${renderer} multiview page timeout`)),
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
      pageErrors: normalizeC1229S5MultiviewDiagnosticStrings(
        pageErrors,
        "pageErrors",
      ),
      consoleErrors: normalizeC1229S5MultiviewDiagnosticStrings(
        consoleErrors,
        "consoleErrors",
      ),
      gpuErrors: normalizeC1229S5MultiviewDiagnosticStrings(
        gpuGate.errors,
        "gpuErrors",
      ),
      deviceLost: gpuGate.deviceLost !== null,
      armedDevices: gpuGate.armedDevices,
      ignoredConsoleErrors: [],
    };
    measured.transport = {
      loopback: true,
      sameOriginOnly: externalRequests.length === 0,
      externalRequests: normalizeC1229S5MultiviewDiagnosticStrings(
        externalRequests,
        "externalRequests",
      ),
      failedRequests: normalizeC1229S5MultiviewDiagnosticStrings(
        failedRequests,
        "failedRequests",
      ),
      httpErrors: normalizeC1229S5MultiviewDiagnosticStrings(
        httpErrors,
        "httpErrors",
      ),
    };
  } catch (error) {
    sessionError = error;
    try {
      pageDiagnostic = await page.evaluate(() =>
        globalThis.__c1229S5MultiviewProgress
          ? JSON.parse(JSON.stringify(globalThis.__c1229S5MultiviewProgress))
          : null,
      );
    } catch {
      pageDiagnostic = null;
    }
    watchdogState.pageDiagnostic = pageDiagnostic;
  }

  const pageClose = await closeC1229S5MultiviewResourceBounded(
    page,
    `${renderer} page`,
  );
  const contextClose = await closeC1229S5MultiviewResourceBounded(
    browserContext,
    `${renderer} context`,
  );
  watchdogState.page = null;
  const closeErrors = [pageClose, contextClose]
    .filter((result) => !result.closed)
    .map(
      (result) =>
        result.error ??
        new Error(`${result.label} close expired after ${CLOSE_TIMEOUT_MS} ms`),
    );
  if (sessionError || closeErrors.length > 0) {
    const errors = [sessionError, ...closeErrors].filter(Boolean);
    const error =
      errors.length === 1
        ? errors[0]
        : new AggregateError(errors, `${renderer} multiview session failed`);
    error.c1229MultiviewDiagnostic = {
      renderer,
      stage: sessionError ? "page" : "browser",
      timeoutMs: PAGE_TIMEOUT_MS,
      page: pageDiagnostic,
    };
    throw error;
  }
  measured.cleanup = {
    complete:
      measured.cleanup.secondaryViewDestroyed === true &&
      measured.cleanup.sceneViewRestored === true &&
      measured.cleanup.useWebVRFalse === true &&
      measured.cleanup.instrumentationRestored === true &&
      measured.cleanup.timersCleared === true &&
      pageClose.closed &&
      contextClose.closed &&
      pending.size === 0,
    secondaryViewDestroyed: measured.cleanup.secondaryViewDestroyed === true,
    sceneViewRestored: measured.cleanup.sceneViewRestored === true,
    useWebVRFalse: measured.cleanup.useWebVRFalse === true,
    instrumentationRestored: measured.cleanup.instrumentationRestored === true,
    pageClosed: pageClose.closed,
    contextClosed: contextClose.closed,
    timersCleared: measured.cleanup.timersCleared === true,
    pendingRequests: pending.size,
    pageCloseTimedOut: pageClose.timedOut,
    contextCloseTimedOut: contextClose.timedOut,
  };
  return measured;
}

async function readC1229S5MultiviewPageProgressBounded(
  page,
  timeoutMs = 1_000,
) {
  if (!page) return null;
  let timer;
  try {
    return await Promise.race([
      page
        .evaluate(() =>
          globalThis.__c1229S5MultiviewProgress
            ? JSON.parse(JSON.stringify(globalThis.__c1229S5MultiviewProgress))
            : null,
        )
        .catch(() => null),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function closeBrowserOrThrow(browser) {
  const result = await closeC1229S5MultiviewResourceBounded(
    browser,
    "multiview browser",
  );
  if (!result.closed) {
    throw (
      result.error ??
      new Error(`multiview browser close expired after ${CLOSE_TIMEOUT_MS} ms`)
    );
  }
  return result;
}

function deriveCrossBackend(sessions) {
  const [webgl, webgpu] = sessions;
  return {
    sameWorkload: true,
    sameClaim:
      webgl.isolation.engineSchedulerAvailable === false &&
      webgpu.isolation.engineSchedulerAvailable === false,
    bothSameContextIsolation:
      webgl.isolation.sameContext === true &&
      webgpu.isolation.sameContext === true,
    bothRayPickRealView:
      webgl.offscreenRayPick.constructorIsView === true &&
      webgpu.offscreenRayPick.constructorIsView === true,
    stereoPolicyComplementary:
      webgl.webglVr?.supported === true &&
      webgpu.webgpuVr?.supportsStereoViewport === false,
  };
}

export async function runC1229S5MultiviewProbe(options = {}) {
  const operations = options.operations ?? fs;
  const launchBrowser =
    options.launchBrowser ??
    ((launchOptions) => chromium.launch(launchOptions));
  const runId = options.runId ?? randomUUID();
  const paths = createC1229S5MultiviewArtifactPaths(
    runId,
    options.outputDirectory,
  );
  const baseIdentity = validateC1229S5MultiviewLoopbackBase(
    options.base ?? defaultBase,
  );
  let ownership;
  let browser;
  let activeRenderer = null;
  const watchdogState = {
    renderer: null,
    page: null,
    pageDiagnostic: null,
  };
  try {
    ownership = beginC1229S5MultiviewEvidenceRun(paths, runId, operations);
    const startedAt = ownership.running.startedAt;
    const start = collectC1229S5MultiviewProvenanceSnapshot();
    browser = await launchBrowser({
      channel: process.env.PROBE_BROWSER_CHANNEL || "msedge",
      headless: process.env.PROBE_HEADED !== "1",
    });
    const sessions = await withC1229S5MultiviewWatchdog(
      async (signal) => {
        const results = [];
        for (const renderer of C12_29_S5_MULTIVIEW_RENDERERS) {
          signal.throwIfAborted();
          activeRenderer = renderer;
          const session = await runC1229S5MultiviewBrowserSession(
            browser,
            renderer,
            baseIdentity,
            watchdogState,
          );
          signal.throwIfAborted();
          results.push(session);
        }
        return results;
      },
      async () => {
        const page =
          watchdogState.pageDiagnostic ??
          (await readC1229S5MultiviewPageProgressBounded(watchdogState.page));
        const closing = browser;
        browser = undefined;
        let drainError;
        try {
          await closeBrowserOrThrow(closing);
        } catch (error) {
          drainError = error;
        }
        return {
          renderer: watchdogState.renderer ?? activeRenderer,
          page,
          drainError,
        };
      },
      options.watchdogMs ?? WATCHDOG_MS,
      () => activeRenderer,
      options.watchdogSettlementMs ?? WATCHDOG_SETTLEMENT_MS,
    );
    const closing = browser;
    browser = undefined;
    const browserCleanup = await closeBrowserOrThrow(closing);
    const end = collectC1229S5MultiviewProvenanceSnapshot();
    const provenance = composeC1229S5MultiviewProvenance(start, end, sessions);
    for (const session of sessions) delete session.servedEntry;
    const report = {
      schema: C12_29_S5_MULTIVIEW_SCHEMA,
      runId,
      artifactName: `${runId}.json`,
      startedAt,
      completedAt: new Date().toISOString(),
      incomplete: false,
      claim: {
        scope: C12_29_S5_MULTIVIEW_WORKLOAD.claim,
        scheduler: C12_29_S5_MULTIVIEW_WORKLOAD.scheduler,
        engineSchedulerAvailable: false,
        nativeArbitraryViewSchedulingClaimed: false,
        sceneRenderResetsDefaultView: true,
      },
      workload: C12_29_S5_MULTIVIEW_WORKLOAD,
      provenance,
      sessions,
      crossBackend: deriveCrossBackend(sessions),
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
        lockReleased: true,
      },
    };
    const verdict = foldC1229S5MultiviewGate(report);
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
    const validation = validateC1229S5MultiviewFinalArtifact(artifact);
    if (!validation.ok) {
      throw new Error(
        `multiview self-validation failed: ${validation.reasons.join("; ")}`,
      );
    }
    const publication = finalizeC1229S5MultiviewEvidence(
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
          "multiview probe and browser cleanup failed",
          { cause: error },
        );
        error.retainMultiviewRunning = true;
      }
    }
    const archiveExists =
      ownership && readBytesIfPresent(paths.archive, operations) !== undefined;
    if (ownership && !archiveExists && error?.retainMultiviewRunning !== true) {
      const diagnostic = error.c1229MultiviewDiagnostic ?? {};
      const artifact = createC1229S5MultiviewErrorArtifact(runId, error, {
        renderer: diagnostic.renderer ?? activeRenderer,
        stage: diagnostic.stage ?? "node",
        timeoutMs: diagnostic.timeoutMs ?? options.watchdogMs ?? WATCHDOG_MS,
        page: diagnostic.page ?? null,
      });
      try {
        const publication = finalizeC1229S5MultiviewEvidence(
          paths,
          artifact,
          ownership,
          operations,
        );
        return { artifact, publication, paths, error };
      } catch (publicationError) {
        publicationError.cause ??= error;
        publicationError.retainMultiviewRunning = true;
        throw publicationError;
      }
    }
    throw error;
  } finally {
    // Last-resort reclamation. Both paths above clear `browser` before handing
    // the handle to `closeBrowserOrThrow`, so this only runs when something
    // left the loop without doing either — the leak a `finally` is the only
    // construct that can cover.
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

async function main() {
  // Terminating watchdog. `withC1229S5MultiviewWatchdog` only REJECTS the task
  // it wraps, which needs the event loop to come back to it; a wedged page loop
  // never yields, so nothing but `process.exit` ends the run. `unref` keeps the
  // timer from extending a healthy one.
  const processWatchdog = setTimeout(() => {
    console.error(
      `[probe-c12-29-s5-multiview] process watchdog fired after ` +
        `${PROCESS_WATCHDOG_MS} ms; the in-run watchdog did not settle`,
    );
    process.exit(2);
  }, PROCESS_WATCHDOG_MS);
  processWatchdog.unref?.();
  try {
    await runMain();
  } finally {
    clearTimeout(processWatchdog);
  }
}

async function runMain() {
  const result = await runC1229S5MultiviewProbe();
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
      },
      null,
      2,
    ),
  );
  process.exitCode = artifact.exitCode;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  await main();
}
