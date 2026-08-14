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
  C12_29_S5_CUSTOM_EPHEMERIS,
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
  isC1229S5CustomUuidV4,
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
const ERROR_TEXT_MAXIMUM_CHARACTERS = 65_536;
const C1229_S5_CUSTOM_OWNERSHIP_RECORDS = new WeakMap();

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function inspectC1229S5CustomErrorText(error) {
  let name;
  let message;
  try {
    name = error?.name;
  } catch {
    name = undefined;
  }
  try {
    message = error?.message;
  } catch {
    message = undefined;
  }
  if (typeof name === "string" && typeof message === "string") {
    return `${name}: ${message}`;
  }
  if (typeof message === "string" && message.length > 0) return message;
  try {
    const rendered = String(error);
    if (rendered.length > 0) return rendered;
  } catch {
    // Preserve a deterministic ERROR even for an uninspectable thrown Proxy.
  }
  return "[custom-ellipsoid uninspectable error]";
}

function boundedC1229S5CustomErrorText(error) {
  const text = inspectC1229S5CustomErrorText(error) || "[empty error]";
  if (text.length <= ERROR_TEXT_MAXIMUM_CHARACTERS) return text;
  let omitted = text.length - ERROR_TEXT_MAXIMUM_CHARACTERS;
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidateSuffix = `[CUSTOM_ERROR_TRUNCATED omittedCharacters=${omitted}]`;
    const retained = Math.max(
      0,
      ERROR_TEXT_MAXIMUM_CHARACTERS - candidateSuffix.length,
    );
    const exactOmitted = text.length - retained;
    if (exactOmitted === omitted) break;
    omitted = exactOmitted;
  }
  const suffix = `[CUSTOM_ERROR_TRUNCATED omittedCharacters=${omitted}]`;
  return `${text.slice(0, Math.max(0, ERROR_TEXT_MAXIMUM_CHARACTERS - suffix.length))}${suffix}`;
}

const C1229_S5_CUSTOM_V5_SOURCE_ADDITIONS = new Set([
  "packages/engine/Source/Core/CelestialEphemerisProvider.js",
  "packages/engine/Source/Core/Simon1994EphemerisProvider.js",
  "packages/engine/Source/Renderer/UniformStateComputations.js",
  "packages/engine/Source/Scene/Moon.js",
]);

function upgradeC1229S5CustomPriorBoundary(upgraded) {
  const v4SourceFiles = C12_29_S5_CUSTOM_SOURCE_FILES.filter(
    (file) => !C1229_S5_CUSTOM_V5_SOURCE_ADDITIONS.has(file),
  );
  const v4BuildFiles = C12_29_S5_CUSTOM_BUILD_SOURCE_FILES.filter(
    (file) => !C1229_S5_CUSTOM_V5_SOURCE_ADDITIONS.has(file),
  );
  const boundary = upgraded?.provenance?.sourceBoundary;
  if (
    boundary?.count === C12_29_S5_CUSTOM_SOURCE_FILES.length &&
    JSON.stringify(boundary?.files) ===
      JSON.stringify(C12_29_S5_CUSTOM_SOURCE_FILES)
  ) {
    return true;
  }
  if (
    boundary?.count !== v4SourceFiles.length ||
    JSON.stringify(boundary?.files) !== JSON.stringify(v4SourceFiles) ||
    upgraded?.checks?.sourceBoundaryCount !== v4SourceFiles.length ||
    upgraded?.checks?.buildSourceBoundaryCount !== v4BuildFiles.length
  ) {
    return false;
  }
  const localByFile = new Map(
    (upgraded.provenance.localFiles ?? []).map((entry) => [entry?.file, entry]),
  );
  if (
    localByFile.size !== v4SourceFiles.length ||
    v4SourceFiles.some((file) => !localByFile.has(file))
  ) {
    return false;
  }
  const localTemplate = localByFile.get(v4SourceFiles[0]);
  upgraded.provenance.localFiles = C12_29_S5_CUSTOM_SOURCE_FILES.map((file) =>
    localByFile.has(file)
      ? localByFile.get(file)
      : {
          file,
          start: structuredClone(localTemplate.start),
          end: structuredClone(localTemplate.end),
        },
  );
  for (const endpoint of ["start", "end"]) {
    const identity = upgraded.provenance.buildSourceIdentity?.[endpoint];
    const entryByFile = new Map(
      (identity?.entries ?? []).map((entry) => [
        C12_29_S5_CUSTOM_BUILD_SOURCE_FILES.find(
          (file) => entry?.file === file || entry?.file?.endsWith(`/${file}`),
        ),
        entry,
      ]),
    );
    if (
      identity?.entries?.length !== v4BuildFiles.length ||
      v4BuildFiles.some((file) => !entryByFile.has(file))
    ) {
      return false;
    }
    const template = entryByFile.get(v4BuildFiles[0]);
    const templateSuffix = v4BuildFiles[0];
    const prefix = template.file.slice(0, -templateSuffix.length);
    identity.entries = C12_29_S5_CUSTOM_BUILD_SOURCE_FILES.map((file) =>
      entryByFile.has(file)
        ? entryByFile.get(file)
        : {
            ...structuredClone(template),
            file: `${prefix}${file}`,
            sourceMapEntry: `../../${file}`,
          },
    );
  }
  upgraded.provenance.sourceBoundary = {
    ...boundary,
    count: C12_29_S5_CUSTOM_SOURCE_FILES.length,
    files: [...C12_29_S5_CUSTOM_SOURCE_FILES],
  };
  upgraded.checks.sourceBoundaryCount = C12_29_S5_CUSTOM_SOURCE_FILES.length;
  upgraded.checks.buildSourceBoundaryCount =
    C12_29_S5_CUSTOM_BUILD_SOURCE_FILES.length;
  return true;
}

function upgradeC1229S5CustomPriorLineage(upgraded) {
  for (const session of upgraded.sessions ?? []) {
    const eventBodies = session?.phases?.["event-s5-on"]?.runtimeBodies;
    const controlBodies =
      session?.phases?.["noneclipse-identity-control"]?.runtimeBodies;
    for (const image of session.images ?? []) {
      const states = [
        ...(image?.temporalStability?.observations ?? []).map(
          (observation) => ({
            frameNumber: observation.frameNumber,
            state: observation.state,
          }),
        ),
        {
          frameNumber: image?.temporalStability?.captureFrameNumber,
          state: image?.temporalStability?.captureState,
        },
      ];
      for (const { frameNumber, state } of states) {
        if (state?.ephemeris !== undefined) continue;
        const bodies =
          state?.clockIso === C12_29_S5_CUSTOM_SCENE.controlIso
            ? controlBodies
            : eventBodies;
        if (!bodies?.sun || !bodies?.moon) return false;
        const magnitude = Math.sqrt(
          bodies.moon.x * bodies.moon.x +
            bodies.moon.y * bodies.moon.y +
            bodies.moon.z * bodies.moon.z,
        );
        if (!(magnitude > 0) || !Number.isFinite(magnitude)) return false;
        const sample = {
          providerId: C12_29_S5_CUSTOM_EPHEMERIS.providerId,
          providerRevision: C12_29_S5_CUSTOM_EPHEMERIS.providerRevision,
          provenance: structuredClone(C12_29_S5_CUSTOM_EPHEMERIS.provenance),
          timePolicy: structuredClone(C12_29_S5_CUSTOM_EPHEMERIS.timePolicy),
          referenceFrame: C12_29_S5_CUSTOM_EPHEMERIS.referenceFrame,
          units: C12_29_S5_CUSTOM_EPHEMERIS.units,
          transformBranch: C12_29_S5_CUSTOM_EPHEMERIS.transformBranch,
          outputAllocationStable: true,
          thirdPartyTemporaryFree: true,
          sunPositionWC: { ...bodies.sun },
          moonPositionWC: { ...bodies.moon },
        };
        state.ephemeris = {
          frameNumber,
          clockIso: state.clockIso,
          provider: {
            constructor: C12_29_S5_CUSTOM_EPHEMERIS.providerConstructor,
            id: C12_29_S5_CUSTOM_EPHEMERIS.providerId,
            revision: C12_29_S5_CUSTOM_EPHEMERIS.providerRevision,
            provenance: structuredClone(C12_29_S5_CUSTOM_EPHEMERIS.provenance),
            timePolicy: structuredClone(C12_29_S5_CUSTOM_EPHEMERIS.timePolicy),
            provenanceFrozen: true,
            timePolicyFrozen: true,
          },
          sample,
          independent: {
            method: C12_29_S5_CUSTOM_EPHEMERIS.independentMethod,
            sunPositionWC: { ...bodies.sun },
            moonPositionWC: { ...bodies.moon },
            sunDeltaMeters: 0,
            moonDeltaMeters: 0,
          },
          eclipseState: {
            sunPositionWC: { ...bodies.sun },
            moonPositionWC: { ...bodies.moon },
            sunDeltaMeters: 0,
            moonDeltaMeters: 0,
            sunStorageDistinct: true,
            moonStorageDistinct: true,
          },
          consumers: {
            uniformSunPositionWC: { ...bodies.sun },
            uniformSunStorageDistinct: true,
            viewRotation3D: [1, 0, 0, 0, 1, 0, 0, 0, 1],
            moonDirectionEC: {
              x: bodies.moon.x / magnitude,
              y: bodies.moon.y / magnitude,
              z: bodies.moon.z / magnitude,
            },
            moonDirectionStorageDistinct: true,
            moonModelTranslation: { ...bodies.moon },
            moonModelStorageDistinct: true,
          },
          identities: {
            providerIsSceneProvider: true,
            sampleIsFrameStateSample: true,
            sampleProvenanceIsProviderProvenance: true,
            sampleTimePolicyIsProviderTimePolicy: true,
          },
        };
      }
    }
  }
  return true;
}

export function validateC1229S5CustomPriorFinal(value) {
  if (validateC1229S5CustomFinalArtifact(value).ok) return true;
  if (
    !new Set([
      "c12-29-s5-custom-ellipsoid-evidence-v4",
      "c12-29-s5-custom-ellipsoid-evidence-v3",
    ]).has(value?.schema) &&
    !(
      value?.schema === "c12-29-s5-custom-ellipsoid-evidence-v2" &&
      value?.status === "ERROR"
    )
  ) {
    return false;
  }
  const upgraded = structuredClone(value);
  upgraded.schema = C12_29_S5_CUSTOM_SCHEMA;
  if (upgraded.status === "ERROR") {
    upgraded.diagnostics = {
      ...upgraded.diagnostics,
      schema: C12_29_S5_CUSTOM_DIAGNOSTICS_SCHEMA,
      page:
        upgraded.diagnostics?.page === null
          ? null
          : {
              ...upgraded.diagnostics?.page,
              schema: C12_29_S5_CUSTOM_DIAGNOSTICS_SCHEMA,
            },
    };
  } else if (
    !upgradeC1229S5CustomPriorBoundary(upgraded) ||
    !upgradeC1229S5CustomPriorLineage(upgraded)
  ) {
    return false;
  }
  return validateC1229S5CustomFinalArtifact(upgraded).ok;
}

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
  if (!isC1229S5CustomUuidV4(runId)) {
    throw new Error("custom-ellipsoid runId must be a UUID v4");
  }
  directory = path.resolve(directory);
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

function assertC1229S5CustomArtifactPaths(paths, runId) {
  if (!isC1229S5CustomUuidV4(runId)) {
    throw new Error("custom-ellipsoid runId must be a UUID v4");
  }
  if (
    paths === null ||
    typeof paths !== "object" ||
    Array.isArray(paths) ||
    Object.keys(paths).length !== 6 ||
    !["directory", "archive", "latest", "lock", "firstRed", "recovery"].every(
      (key) => Object.hasOwn(paths, key) && typeof paths[key] === "string",
    )
  ) {
    throw new Error("custom-ellipsoid artifact paths are not exact");
  }
  const expected = createC1229S5CustomArtifactPaths(runId, paths.directory);
  for (const key of [
    "directory",
    "archive",
    "latest",
    "lock",
    "firstRed",
    "recovery",
  ]) {
    if (canonicalPathKey(paths[key]) !== canonicalPathKey(expected[key])) {
      throw new Error(
        `custom-ellipsoid ${key} path is not bound to run ${runId}`,
      );
    }
  }
  return expected;
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

function canonicalPathKey(file) {
  const resolved = path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function inspectImmutableDescriptor(file, label, operations = fs) {
  if (typeof operations.lstatSync !== "function") {
    throw new Error(`${label} lstat authority is unavailable`);
  }
  const descriptor = operations.lstatSync(file, { bigint: true });
  const nlink = Number(descriptor.nlink);
  const size = Number(descriptor.size);
  if (
    descriptor.isFile() !== true ||
    descriptor.isSymbolicLink() === true ||
    !Number.isSafeInteger(nlink) ||
    nlink !== 1 ||
    !Number.isSafeInteger(size) ||
    size <= 0
  ) {
    throw new Error(`${label} is not one uniquely linked regular file`);
  }
  const exactInteger = (value, field) => {
    if (typeof value === "bigint") return value.toString();
    if (Number.isSafeInteger(value)) return String(value);
    throw new Error(`${label} ${field} identity is not an exact integer`);
  };
  const exactTimestamp = (nanoseconds, milliseconds, field) => {
    if (typeof nanoseconds === "bigint") return nanoseconds.toString();
    if (Number.isFinite(milliseconds)) return String(milliseconds);
    throw new Error(`${label} ${field} identity is unavailable`);
  };
  return {
    dev: exactInteger(descriptor.dev, "device"),
    ino: exactInteger(descriptor.ino, "inode"),
    mode: exactInteger(descriptor.mode, "mode"),
    nlink,
    size,
    mtime: exactTimestamp(descriptor.mtimeNs, descriptor.mtimeMs, "mtime"),
    ctime: exactTimestamp(descriptor.ctimeNs, descriptor.ctimeMs, "ctime"),
  };
}

function sameImmutableDescriptor(left, right) {
  return (
    left !== null &&
    typeof left === "object" &&
    right !== null &&
    typeof right === "object" &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtime === right.mtime &&
    left.ctime === right.ctime
  );
}

function sameImmutableEntryIdentity(left, right) {
  return (
    left !== null &&
    typeof left === "object" &&
    right !== null &&
    typeof right === "object" &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size
  );
}

function resolvePriorArchivePath(paths, priorLatest) {
  const directory = path.resolve(paths.directory);
  const expectedName = `${priorLatest.runId}.json`;
  const archive = path.resolve(directory, priorLatest.artifactName);
  const expectedArchive = path.resolve(directory, expectedName);
  const reserved = [
    paths.archive,
    paths.latest,
    paths.lock,
    paths.firstRed,
    paths.recovery,
  ].map(canonicalPathKey);
  if (
    priorLatest.artifactName !== expectedName ||
    canonicalPathKey(path.dirname(archive)) !== canonicalPathKey(directory) ||
    canonicalPathKey(archive) !== canonicalPathKey(expectedArchive) ||
    reserved.includes(canonicalPathKey(archive))
  ) {
    throw new Error(
      "custom-ellipsoid prior immutable archive path is not canonical-safe",
    );
  }
  return archive;
}

function assertImmutableFileAuthority(authority, label, operations = fs) {
  if (authority === null) return;
  if (
    authority === undefined ||
    typeof authority.path !== "string" ||
    !Buffer.isBuffer(authority.bytes) ||
    authority.bytes.length === 0 ||
    authority.descriptor === null ||
    typeof authority.descriptor !== "object"
  ) {
    throw new Error(`${label} immutable authority is malformed`);
  }
  try {
    const before = inspectImmutableDescriptor(
      authority.path,
      `${label} immutable descriptor`,
      operations,
    );
    if (!sameImmutableDescriptor(before, authority.descriptor)) {
      throw new Error("descriptor identity changed");
    }
    exactBytes(
      authority.path,
      authority.bytes,
      `${label} immutable bytes`,
      operations,
    );
    const after = inspectImmutableDescriptor(
      authority.path,
      `${label} immutable descriptor after read`,
      operations,
    );
    if (
      !sameImmutableDescriptor(before, after) ||
      !sameImmutableDescriptor(after, authority.descriptor)
    ) {
      throw new Error("descriptor identity raced during exact read");
    }
  } catch (error) {
    throw new Error(
      `custom-ellipsoid ${label} immutable file is unavailable, unsafe, or differs`,
      { cause: error },
    );
  }
}

function assertPriorArchiveAuthority(authority, label, operations = fs) {
  try {
    assertImmutableFileAuthority(authority, label, operations);
  } catch (error) {
    throw new Error(
      `custom-ellipsoid ${label} prior immutable archive is unavailable, unsafe, or differs`,
      { cause: error },
    );
  }
}

function captureC1229S5CustomImmutableAuthority(
  file,
  bytes,
  label,
  operations = fs,
) {
  const authority = {
    path: path.resolve(file),
    file: path.resolve(file),
    bytes: Buffer.from(bytes),
    descriptor: inspectImmutableDescriptor(
      file,
      `${label} descriptor`,
      operations,
    ),
  };
  assertImmutableFileAuthority(authority, label, operations);
  return authority;
}

function snapshotC1229S5CustomAuthority(authority) {
  return authority === null
    ? null
    : {
        authority,
        path: authority.path,
        file: authority.file,
        bytes: Buffer.from(authority.bytes),
        descriptor: { ...authority.descriptor },
      };
}

function sameC1229S5CustomAuthoritySnapshot(authority, snapshot) {
  if (snapshot === null) return authority === null;
  return (
    authority === snapshot.authority &&
    authority.path === snapshot.path &&
    authority.file === snapshot.file &&
    Buffer.isBuffer(authority.bytes) &&
    authority.bytes.equals(snapshot.bytes) &&
    sameImmutableDescriptor(authority.descriptor, snapshot.descriptor)
  );
}

export function createC1229S5CustomImmutableAuthority(
  file,
  bytes,
  label,
  operations = fs,
) {
  createImmutableEvidence(file, bytes, operations);
  return captureC1229S5CustomImmutableAuthority(file, bytes, label, operations);
}

function inspectReferencedFinalAuthority(
  paths,
  finalBytes,
  referenceLabel,
  operations = fs,
  requireRed = false,
) {
  let referencedFinal;
  try {
    referencedFinal = JSON.parse(finalBytes.toString("utf8"));
    if (
      !validateC1229S5CustomPriorFinal(referencedFinal) ||
      (requireRed && referencedFinal.status === "PASS") ||
      !finalBytes.equals(
        Buffer.from(stableC1229S5CustomJson(referencedFinal, 2)),
      )
    ) {
      throw new Error("schema/status/canonical drift");
    }
  } catch (error) {
    throw new Error(
      `custom-ellipsoid ${referenceLabel} is not an exact canonical${
        requireRed ? " red" : ""
      } final`,
      { cause: error },
    );
  }
  const archive = resolvePriorArchivePath(paths, referencedFinal);
  let authority;
  try {
    authority = captureC1229S5CustomImmutableAuthority(
      archive,
      finalBytes,
      `${referenceLabel} immutable archive`,
      operations,
    );
  } catch (error) {
    throw new Error(
      `custom-ellipsoid ${referenceLabel} immutable archive is unavailable, unsafe, or differs`,
      { cause: error },
    );
  }
  return { final: referencedFinal, authority };
}

function inspectPriorLatestAuthority(paths, priorLatestBytes, operations = fs) {
  const inspected = inspectReferencedFinalAuthority(
    paths,
    priorLatestBytes,
    "prior latest",
    operations,
  );
  return { priorLatest: inspected.final, authority: inspected.authority };
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

export function releaseC1229S5CustomLock(
  lockPath,
  lockBytes,
  operations = fs,
  verifyAuthority = () => {},
) {
  exactBytes(lockPath, lockBytes, "owned lock before release", operations);
  // All publication authority must be proven while the canonical lock path is
  // still occupied. The rename below is the release linearization point; a
  // successor may legitimately acquire the lock immediately afterwards.
  verifyAuthority("pre-lock-release");
  const receipt = `${lockPath}.release-${randomUUID()}.receipt`;
  operations.renameSync(lockPath, receipt);
  try {
    exactBytes(receipt, lockBytes, "claimed lock release receipt", operations);
    operations.unlinkSync(receipt);
    if (readBytesIfPresent(receipt, operations) !== undefined) {
      throw new Error("owned lock release receipt remained after deletion");
    }
  } catch (error) {
    try {
      const retained = readBytesIfPresent(receipt, operations);
      if (readBytesIfPresent(lockPath, operations) === undefined) {
        const restored = restoreClaimedBytes(
          lockPath,
          retained ?? lockBytes,
          "owned lock restoration after failed release",
          operations,
        );
        if (!restored) {
          throw new Error("owned lock could not be restored exclusively", {
            cause: error,
          });
        }
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
  return { released: true, receiptRemoved: true };
}

export function beginC1229S5CustomEvidenceRun(paths, runId, operations = fs) {
  assertC1229S5CustomArtifactPaths(paths, runId);
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
  if (
    latestBefore.exists !== (priorLatestBytes !== undefined) ||
    (priorLatestBytes !== undefined &&
      (latestBefore.byteLength !== priorLatestBytes.byteLength ||
        latestBefore.sha256 !== sha256(priorLatestBytes)))
  ) {
    throw new Error("custom-ellipsoid prior latest preflight identity raced");
  }
  let priorArchiveAuthority = null;
  if (priorLatestBytes !== undefined) {
    ({ authority: priorArchiveAuthority } = inspectPriorLatestAuthority(
      paths,
      priorLatestBytes,
      operations,
    ));
    exactBytes(
      paths.latest,
      priorLatestBytes,
      "validated custom-ellipsoid prior latest",
      operations,
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
  let firstRedAuthority = null;
  let firstRedArchiveAuthority = null;
  if (firstRedBeforeBytes !== undefined) {
    const inspectedFirstRed = inspectReferencedFinalAuthority(
      paths,
      firstRedBeforeBytes,
      "first-red",
      operations,
      true,
    );
    firstRedArchiveAuthority = inspectedFirstRed.authority;
    firstRedAuthority = captureC1229S5CustomImmutableAuthority(
      paths.firstRed,
      firstRedBeforeBytes,
      "initial first-red",
      operations,
    );
  }
  const proveInitialFirstRed = (label) => {
    if (firstRedAuthority === null) {
      if (readBytesIfPresent(paths.firstRed, operations) !== undefined) {
        throw new Error(`custom-ellipsoid first-red appeared during ${label}`);
      }
      return;
    }
    assertImmutableFileAuthority(
      firstRedAuthority,
      `${label} first-red`,
      operations,
    );
    assertImmutableFileAuthority(
      firstRedArchiveAuthority,
      `${label} first-red archive`,
      operations,
    );
  };
  if (priorLatestBytes !== undefined) {
    exactBytes(
      paths.latest,
      priorLatestBytes,
      "pre-lock custom-ellipsoid prior latest",
      operations,
    );
  }
  assertPriorArchiveAuthority(priorArchiveAuthority, "pre-lock", operations);
  proveInitialFirstRed("pre-lock");
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
    if (priorLatestBytes !== undefined) {
      exactBytes(
        paths.latest,
        priorLatestBytes,
        "post-lock custom-ellipsoid prior latest",
        operations,
      );
    }
    assertPriorArchiveAuthority(priorArchiveAuthority, "post-lock", operations);
    proveInitialFirstRed("post-lock");
    assertPriorArchiveAuthority(
      priorArchiveAuthority,
      "pre-RUNNING-publication",
      operations,
    );
    proveInitialFirstRed("pre-RUNNING-publication");
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
    assertPriorArchiveAuthority(
      priorArchiveAuthority,
      "post-RUNNING-publication",
      operations,
    );
    proveInitialFirstRed("post-RUNNING-publication");
    exactBytes(
      paths.lock,
      lockBytes,
      "owned custom-ellipsoid lock",
      operations,
    );
    exactBytes(paths.latest, runningBytes, "owned RUNNING latest", operations);
    assertPriorArchiveAuthority(
      priorArchiveAuthority,
      "pre-return",
      operations,
    );
    proveInitialFirstRed("pre-return");
    exactBytes(
      paths.latest,
      runningBytes,
      "pre-return owned custom-ellipsoid RUNNING",
      operations,
    );
    exactBytes(
      paths.lock,
      lockBytes,
      "pre-return owned custom-ellipsoid lock",
      operations,
    );
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
  const ownership = {
    runId,
    lock,
    lockBytes,
    running,
    runningBytes,
    firstRedBefore,
    firstRedBeforeBytes,
    firstRedAuthority,
    firstRedArchiveAuthority,
    priorLatestBytes,
    priorArchiveAuthority,
    pngAuthorities: [],
  };
  C1229_S5_CUSTOM_OWNERSHIP_RECORDS.set(ownership, {
    runId,
    paths: Object.fromEntries(
      Object.entries(paths).map(([key, file]) => [key, canonicalPathKey(file)]),
    ),
    lockBytes: Buffer.from(lockBytes),
    runningBytes: Buffer.from(runningBytes),
    firstRedBeforeBytes:
      firstRedBeforeBytes === undefined
        ? undefined
        : Buffer.from(firstRedBeforeBytes),
    firstRedAuthority: snapshotC1229S5CustomAuthority(firstRedAuthority),
    firstRedArchiveAuthority: snapshotC1229S5CustomAuthority(
      firstRedArchiveAuthority,
    ),
    priorLatestBytes:
      priorLatestBytes === undefined
        ? undefined
        : Buffer.from(priorLatestBytes),
    priorArchiveAuthority: snapshotC1229S5CustomAuthority(
      priorArchiveAuthority,
    ),
  });
  return ownership;
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

function proveOwnedPriorArchive(ownership, label, operations = fs) {
  try {
    assertPriorArchiveAuthority(
      ownership.priorArchiveAuthority ?? null,
      label,
      operations,
    );
  } catch (error) {
    // Once RUNNING is authoritative, loss of the predecessor archive makes
    // every final (including ERROR) unsafe. Preserve RUNNING and its lock for
    // explicit recovery instead of attempting a second publication.
    error.retainCustomRunning = true;
    throw error;
  }
}

function assertStoredReferencedFinalBinding(
  paths,
  bytes,
  authority,
  label,
  requireRed = false,
) {
  if (bytes === undefined) {
    if (authority !== null) {
      throw new Error(`${label} authority exists without referenced bytes`);
    }
    return;
  }
  if (!Buffer.isBuffer(bytes) || authority === null) {
    throw new Error(`${label} referenced authority is incomplete`);
  }
  let referenced;
  try {
    referenced = JSON.parse(bytes.toString("utf8"));
    if (
      !validateC1229S5CustomPriorFinal(referenced) ||
      (requireRed && referenced.status === "PASS") ||
      stableC1229S5CustomJson(referenced, 2) !== bytes.toString("utf8")
    ) {
      throw new Error("referenced final is not canonical");
    }
  } catch (error) {
    throw new Error(`${label} referenced final binding is invalid`, {
      cause: error,
    });
  }
  const archive = resolvePriorArchivePath(paths, referenced);
  if (
    canonicalPathKey(authority?.path ?? "") !== canonicalPathKey(archive) ||
    canonicalPathKey(authority?.file ?? "") !== canonicalPathKey(archive) ||
    !Buffer.isBuffer(authority?.bytes) ||
    !authority.bytes.equals(bytes)
  ) {
    throw new Error(`${label} archive authority is not path/byte bound`);
  }
}

function assertC1229S5CustomOwnershipBinding(paths, artifact, ownership) {
  assertC1229S5CustomArtifactPaths(paths, artifact.runId);
  const record =
    ownership !== null && typeof ownership === "object"
      ? C1229_S5_CUSTOM_OWNERSHIP_RECORDS.get(ownership)
      : undefined;
  const sameOptionalBytes = (left, right) =>
    left === undefined
      ? right === undefined
      : Buffer.isBuffer(right) && left.equals(right);
  if (
    record === undefined ||
    ownership === null ||
    typeof ownership !== "object" ||
    record.runId !== artifact.runId ||
    !Object.entries(record.paths).every(
      ([key, file]) => canonicalPathKey(paths[key]) === file,
    ) ||
    ownership.runId !== artifact.runId ||
    ownership.lock?.runId !== artifact.runId ||
    ownership.running?.runId !== artifact.runId ||
    ownership.lock?.nonce !== ownership.running?.nonce ||
    ownership.lock?.status !== "RUNNING" ||
    ownership.running?.status !== "RUNNING" ||
    ownership.lock?.incomplete !== true ||
    ownership.running?.incomplete !== true ||
    ownership.running?.artifactName !== artifact.artifactName ||
    !Buffer.isBuffer(ownership.lockBytes) ||
    !Buffer.isBuffer(ownership.runningBytes) ||
    !ownership.lockBytes.equals(
      Buffer.from(stableC1229S5CustomJson(ownership.lock, 2)),
    ) ||
    !ownership.runningBytes.equals(
      Buffer.from(stableC1229S5CustomJson(ownership.running, 2)),
    ) ||
    !ownership.lockBytes.equals(record.lockBytes) ||
    !ownership.runningBytes.equals(record.runningBytes) ||
    !sameOptionalBytes(
      record.firstRedBeforeBytes,
      ownership.firstRedBeforeBytes,
    ) ||
    !sameC1229S5CustomAuthoritySnapshot(
      ownership.firstRedAuthority,
      record.firstRedAuthority,
    ) ||
    !sameC1229S5CustomAuthoritySnapshot(
      ownership.firstRedArchiveAuthority,
      record.firstRedArchiveAuthority,
    ) ||
    !sameOptionalBytes(record.priorLatestBytes, ownership.priorLatestBytes) ||
    !sameC1229S5CustomAuthoritySnapshot(
      ownership.priorArchiveAuthority,
      record.priorArchiveAuthority,
    ) ||
    !Array.isArray(ownership.pngAuthorities)
  ) {
    throw new Error(
      "custom-ellipsoid artifact/run/path/ownership binding is invalid",
    );
  }
  try {
    assertStoredReferencedFinalBinding(
      paths,
      ownership.priorLatestBytes,
      ownership.priorArchiveAuthority,
      "prior latest",
    );
    assertStoredReferencedFinalBinding(
      paths,
      ownership.firstRedBeforeBytes,
      ownership.firstRedArchiveAuthority,
      "first-red",
      true,
    );
    if (ownership.firstRedBeforeBytes === undefined) {
      if (
        ownership.firstRedAuthority !== null ||
        ownership.firstRedBefore?.exists !== false
      ) {
        throw new Error("absent first-red ownership is inconsistent");
      }
    } else if (
      ownership.firstRedBefore?.exists !== true ||
      ownership.firstRedBefore?.byteLength !==
        ownership.firstRedBeforeBytes.length ||
      ownership.firstRedBefore?.sha256 !==
        sha256(ownership.firstRedBeforeBytes) ||
      canonicalPathKey(ownership.firstRedAuthority?.path ?? "") !==
        canonicalPathKey(paths.firstRed) ||
      canonicalPathKey(ownership.firstRedAuthority?.file ?? "") !==
        canonicalPathKey(paths.firstRed) ||
      !Buffer.isBuffer(ownership.firstRedAuthority?.bytes) ||
      !ownership.firstRedAuthority.bytes.equals(ownership.firstRedBeforeBytes)
    ) {
      throw new Error("first-red ownership is not path/byte bound");
    }
  } catch (error) {
    throw new Error(
      "custom-ellipsoid predecessor/first-red ownership binding is invalid",
      { cause: error },
    );
  }
}

function proveOwnedInitialFirstRed(ownership, paths, label, operations = fs) {
  try {
    if (ownership.firstRedBeforeBytes === undefined) {
      if (
        ownership.firstRedAuthority !== null ||
        ownership.firstRedArchiveAuthority !== null ||
        readBytesIfPresent(paths.firstRed, operations) !== undefined
      ) {
        throw new Error("first-red appeared after absent preflight");
      }
      return;
    }
    if (
      !Buffer.isBuffer(ownership.firstRedBeforeBytes) ||
      ownership.firstRedAuthority === null ||
      ownership.firstRedArchiveAuthority === null
    ) {
      throw new Error("pre-existing first-red authority is incomplete");
    }
    assertImmutableFileAuthority(
      ownership.firstRedAuthority,
      `${label} first-red`,
      operations,
    );
    assertImmutableFileAuthority(
      ownership.firstRedArchiveAuthority,
      `${label} first-red archive`,
      operations,
    );
  } catch (error) {
    error.retainCustomRunning = true;
    throw error;
  }
}

function artifactImages(artifact) {
  return artifact.status === "ERROR"
    ? []
    : artifact.sessions.flatMap((session) => session.images);
}

function proveOwnedPngAuthorities(
  ownership,
  paths,
  artifact,
  label,
  operations = fs,
) {
  const images = artifactImages(artifact);
  const authorities = ownership.pngAuthorities;
  if (
    authorities.length !== images.length ||
    (artifact.status === "ERROR" ? images.length !== 0 : images.length !== 12)
  ) {
    throw new Error(
      `custom-ellipsoid ${label} PNG authority count is not exact`,
    );
  }
  const authorityByPath = new Map();
  for (const authority of authorities) {
    const key = canonicalPathKey(authority?.path ?? "");
    if (authorityByPath.has(key)) {
      throw new Error(`custom-ellipsoid ${label} PNG authority is duplicated`);
    }
    authorityByPath.set(key, authority);
  }
  for (const image of images) {
    const file = path.join(paths.directory, image.fileName);
    const authority = authorityByPath.get(canonicalPathKey(file));
    if (
      authority === undefined ||
      !Buffer.isBuffer(authority.bytes) ||
      authority.bytes.length !== image.byteLength ||
      sha256(authority.bytes) !== image.sha256
    ) {
      throw new Error(
        `custom-ellipsoid ${label} PNG ${image.fileName} is not artifact-bound`,
      );
    }
    assertImmutableFileAuthority(
      authority,
      `${label} PNG ${image.fileName}`,
      operations,
    );
  }
}

function proveEffectiveFirstRed(
  authority,
  archiveAuthority,
  paths,
  label,
  operations = fs,
) {
  if (authority === null) {
    if (readBytesIfPresent(paths.firstRed, operations) !== undefined) {
      throw new Error(`custom-ellipsoid first-red appeared during ${label}`);
    }
    return;
  }
  let red;
  try {
    red = JSON.parse(authority.bytes.toString("utf8"));
    const expectedArchive = path.join(paths.directory, `${red.runId}.json`);
    if (
      !validateC1229S5CustomPriorFinal(red) ||
      red.status === "PASS" ||
      red.artifactName !== `${red.runId}.json` ||
      stableC1229S5CustomJson(red, 2) !== authority.bytes.toString("utf8") ||
      canonicalPathKey(authority.path) !== canonicalPathKey(paths.firstRed) ||
      !Buffer.isBuffer(archiveAuthority?.bytes) ||
      !archiveAuthority.bytes.equals(authority.bytes) ||
      canonicalPathKey(archiveAuthority?.path ?? "") !==
        canonicalPathKey(expectedArchive)
    ) {
      throw new Error("first-red/archive reference is not exact");
    }
  } catch (error) {
    throw new Error(
      `custom-ellipsoid ${label} first-red/archive binding is invalid`,
      { cause: error },
    );
  }
  assertImmutableFileAuthority(authority, `${label} first-red`, operations);
  assertImmutableFileAuthority(
    archiveAuthority,
    `${label} first-red archive`,
    operations,
  );
}

export function finalizeC1229S5CustomEvidence(
  paths,
  artifact,
  ownership,
  operations = fs,
) {
  let finalBytes;
  try {
    finalBytes = Buffer.from(stableC1229S5CustomJson(artifact, 2));
    artifact = JSON.parse(finalBytes.toString("utf8"));
    if (stableC1229S5CustomJson(artifact, 2) !== finalBytes.toString("utf8")) {
      throw new Error("canonical roundtrip changed final bytes");
    }
  } catch (error) {
    throw new Error(
      "invalid final artifact: canonical materialization failed",
      {
        cause: error,
      },
    );
  }
  const validated = validateC1229S5CustomFinalArtifact(artifact);
  if (!validated.ok) {
    throw new Error(`invalid final artifact: ${validated.reasons.join("; ")}`);
  }
  assertC1229S5CustomOwnershipBinding(paths, artifact, ownership);
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
  proveOwnedPriorArchive(ownership, "finalization-entry", operations);
  proveOwnedInitialFirstRed(ownership, paths, "finalization-entry", operations);
  proveOwnedPngAuthorities(
    ownership,
    paths,
    artifact,
    "finalization-entry",
    operations,
  );
  proveOwnedPriorArchive(ownership, "post-first-red-preflight", operations);
  proveOwnedPriorArchive(ownership, "pre-current-archive", operations);
  const currentArchiveAuthority = createC1229S5CustomImmutableAuthority(
    paths.archive,
    finalBytes,
    "current immutable custom-ellipsoid archive",
    operations,
  );
  let firstRed;
  let effectiveFirstRedAuthority = ownership.firstRedAuthority;
  let effectiveFirstRedArchiveAuthority = ownership.firstRedArchiveAuthority;
  if (artifact.status !== "PASS") {
    firstRed = preserveFirstRedEvidence(paths.firstRed, finalBytes, operations);
    const expectedFirstRedBytes = ownership.firstRedBeforeBytes ?? finalBytes;
    if (
      firstRed.byteLength !== expectedFirstRedBytes.byteLength ||
      firstRed.sha256 !== sha256(expectedFirstRedBytes) ||
      firstRed.written !== (ownership.firstRedBeforeBytes === undefined)
    ) {
      throw new Error("custom-ellipsoid first-red receipt is not exact");
    }
    if (ownership.firstRedBeforeBytes === undefined) {
      effectiveFirstRedAuthority = captureC1229S5CustomImmutableAuthority(
        paths.firstRed,
        finalBytes,
        "new first-red",
        operations,
      );
      effectiveFirstRedArchiveAuthority = currentArchiveAuthority;
    }
  }
  proveEffectiveFirstRed(
    effectiveFirstRedAuthority,
    effectiveFirstRedArchiveAuthority,
    paths,
    "post-current-archive",
    operations,
  );
  assertImmutableFileAuthority(
    currentArchiveAuthority,
    "post-create current archive",
    operations,
  );
  proveOwnedPngAuthorities(
    ownership,
    paths,
    artifact,
    "post-current-archive",
    operations,
  );
  proveOwnedPriorArchive(ownership, "post-current-archive", operations);
  let currentLatestAuthority;
  try {
    proveOwnedPriorArchive(
      ownership,
      "pre-final-latest-publication",
      operations,
    );
    replaceOwnedCanonical(
      paths.latest,
      ownership.runningBytes,
      finalBytes,
      paths.lock,
      ownership.lockBytes,
      "final",
      operations,
    );
    currentLatestAuthority = captureC1229S5CustomImmutableAuthority(
      paths.latest,
      finalBytes,
      "current canonical latest",
      operations,
    );
    proveOwnedPriorArchive(
      ownership,
      "post-final-latest-publication",
      operations,
    );
    assertImmutableFileAuthority(
      currentArchiveAuthority,
      "post-latest current archive",
      operations,
    );
    assertImmutableFileAuthority(
      currentLatestAuthority,
      "post-latest canonical latest",
      operations,
    );
    proveOwnedPngAuthorities(
      ownership,
      paths,
      artifact,
      "post-latest",
      operations,
    );
    proveEffectiveFirstRed(
      effectiveFirstRedAuthority,
      effectiveFirstRedArchiveAuthority,
      paths,
      "post-latest",
      operations,
    );
    proveOwnedPriorArchive(ownership, "pre-unlock", operations);
    releaseC1229S5CustomLock(
      paths.lock,
      ownership.lockBytes,
      operations,
      (label) => {
        proveOwnedPriorArchive(ownership, label, operations);
        assertImmutableFileAuthority(
          currentArchiveAuthority,
          `${label} current archive`,
          operations,
        );
        assertImmutableFileAuthority(
          currentLatestAuthority,
          `${label} canonical latest`,
          operations,
        );
        proveOwnedPngAuthorities(ownership, paths, artifact, label, operations);
        proveEffectiveFirstRed(
          effectiveFirstRedAuthority,
          effectiveFirstRedArchiveAuthority,
          paths,
          label,
          operations,
        );
      },
    );
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
  return {
    runIdentity: {
      file: paths.archive,
      exists: true,
      byteLength: currentArchiveAuthority.bytes.length,
      sha256: sha256(currentArchiveAuthority.bytes),
    },
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
  const exactOwnPropertyDescriptor = (left, right) => {
    if (left === undefined || right === undefined) {
      return left === right;
    }
    if (
      left.configurable !== right.configurable ||
      left.enumerable !== right.enumerable
    ) {
      return false;
    }
    const leftIsData = Object.hasOwn(left, "value");
    const rightIsData = Object.hasOwn(right, "value");
    if (leftIsData !== rightIsData) {
      return false;
    }
    return leftIsData
      ? left.writable === right.writable && Object.is(left.value, right.value)
      : Object.is(left.get, right.get) && Object.is(left.set, right.set);
  };
  const frozenOwnPropertyDescriptor = (descriptor) =>
    descriptor === undefined ? undefined : Object.freeze({ ...descriptor });
  const descriptorShape = (descriptor) => {
    if (descriptor === undefined) {
      return {
        kind: "absent",
        writable: false,
        enumerable: false,
        configurable: false,
      };
    }
    const data = Object.hasOwn(descriptor, "value");
    return {
      kind: data ? "data" : "accessor",
      writable: data && descriptor.writable === true,
      enumerable: descriptor.enumerable === true,
      configurable: descriptor.configurable === true,
    };
  };
  const capturePropertyAuthorityState = (target, key) => {
    const ownDescriptor = Object.getOwnPropertyDescriptor(target, key);
    const hadOwn = Object.hasOwn(target, key);
    if (hadOwn !== (ownDescriptor !== undefined)) {
      throw new Error(`instrumentation descriptor ownership raced for ${key}`);
    }
    const prototypeChain = [];
    const visited = new Set([target]);
    let authority = target;
    for (let depth = 1; ; depth++) {
      authority = Object.getPrototypeOf(authority);
      if (authority === null) break;
      if (depth > 64 || visited.has(authority)) {
        throw new Error(
          `instrumentation prototype chain is cyclic or unbounded for ${key}`,
        );
      }
      visited.add(authority);
      const descriptor = Object.getOwnPropertyDescriptor(authority, key);
      const owns = Object.hasOwn(authority, key);
      if (owns !== (descriptor !== undefined)) {
        throw new Error(
          `instrumentation prototype descriptor raced for ${key}`,
        );
      }
      prototypeChain.push(
        Object.freeze({
          authority,
          descriptor: frozenOwnPropertyDescriptor(descriptor),
        }),
      );
    }
    const prototypeOwnerIndex = prototypeChain.findIndex(
      (entry) => entry.descriptor !== undefined,
    );
    const ownerDepth = hadOwn
      ? 0
      : prototypeOwnerIndex < 0
        ? -1
        : prototypeOwnerIndex + 1;
    const ownerDescriptor =
      ownerDepth === 0
        ? ownDescriptor
        : ownerDepth > 0
          ? prototypeChain[ownerDepth - 1].descriptor
          : undefined;
    return Object.freeze({
      hadOwn,
      ownDescriptor: frozenOwnPropertyDescriptor(ownDescriptor),
      prototypeChain: Object.freeze(prototypeChain),
      ownerDepth,
      ownerDescriptor: frozenOwnPropertyDescriptor(ownerDescriptor),
    });
  };
  const exactPropertyAuthorityState = (left, right) =>
    left.hadOwn === right.hadOwn &&
    exactOwnPropertyDescriptor(left.ownDescriptor, right.ownDescriptor) &&
    left.ownerDepth === right.ownerDepth &&
    exactOwnPropertyDescriptor(left.ownerDescriptor, right.ownerDescriptor) &&
    left.prototypeChain.length === right.prototypeChain.length &&
    left.prototypeChain.every(
      (entry, index) =>
        entry.authority === right.prototypeChain[index].authority &&
        exactOwnPropertyDescriptor(
          entry.descriptor,
          right.prototypeChain[index].descriptor,
        ),
    );
  const captureInstrumentationDescriptor = (target, key) => {
    const authorityBefore = capturePropertyAuthorityState(target, key);
    if (
      authorityBefore.ownerDescriptor === undefined ||
      !Object.hasOwn(authorityBefore.ownerDescriptor, "value")
    ) {
      throw new Error(`instrumentation property is not data-backed: ${key}`);
    }
    const resolvedValue = Reflect.get(target, key);
    const authority = capturePropertyAuthorityState(target, key);
    if (!exactPropertyAuthorityState(authorityBefore, authority)) {
      throw new Error(
        `instrumentation authority drifted during resolved read: ${key}`,
      );
    }
    return Object.freeze({
      target,
      key,
      authority,
      resolvedValue,
    });
  };
  const restoreInstrumentationDescriptor = (label, target, key, receipt) => {
    if (receipt?.target !== target || receipt?.key !== key) {
      throw new Error(`instrumentation descriptor receipt mismatch: ${label}`);
    }
    if (receipt.authority.hadOwn) {
      Object.defineProperty(target, key, receipt.authority.ownDescriptor);
    } else if (!Reflect.deleteProperty(target, key)) {
      throw new Error(`instrumentation override is not deletable: ${label}`);
    }
    const authorityBeforeResolvedRead = capturePropertyAuthorityState(
      target,
      key,
    );
    const preResolvedAuthorityExact = exactPropertyAuthorityState(
      authorityBeforeResolvedRead,
      receipt.authority,
    );
    const resolvedValueAfter = preResolvedAuthorityExact
      ? Reflect.get(target, key)
      : undefined;
    const authorityAfter = capturePropertyAuthorityState(target, key);
    const ownershipExact = authorityAfter.hadOwn === receipt.authority.hadOwn;
    const ownDescriptorExact = exactOwnPropertyDescriptor(
      authorityAfter.ownDescriptor,
      receipt.authority.ownDescriptor,
    );
    const targetPrototypeExact =
      authorityAfter.prototypeChain[0]?.authority ===
      receipt.authority.prototypeChain[0]?.authority;
    const prototypeChainExact =
      authorityAfter.prototypeChain.length ===
        receipt.authority.prototypeChain.length &&
      authorityAfter.prototypeChain.every(
        (entry, index) =>
          entry.authority ===
            receipt.authority.prototypeChain[index].authority &&
          exactOwnPropertyDescriptor(
            entry.descriptor,
            receipt.authority.prototypeChain[index].descriptor,
          ),
      );
    const ownerDescriptorExact =
      authorityAfter.ownerDepth === receipt.authority.ownerDepth &&
      exactOwnPropertyDescriptor(
        authorityAfter.ownerDescriptor,
        receipt.authority.ownerDescriptor,
      );
    const authorityExact = exactPropertyAuthorityState(
      authorityAfter,
      receipt.authority,
    );
    const resolvedIdentityExact =
      preResolvedAuthorityExact &&
      Object.is(resolvedValueAfter, receipt.resolvedValue);
    return {
      label,
      hadOwnBefore: receipt.authority.hadOwn,
      hasOwnAfter: authorityAfter.hadOwn,
      ownerDepthBefore: receipt.authority.ownerDepth,
      ownerDepthAfter: authorityAfter.ownerDepth,
      ownerDescriptorBefore: descriptorShape(receipt.authority.ownerDescriptor),
      ownerDescriptorAfter: descriptorShape(authorityAfter.ownerDescriptor),
      preResolvedAuthorityExact,
      ownershipExact,
      ownDescriptorExact,
      targetPrototypeExact,
      prototypeChainExact,
      ownerDescriptorExact,
      resolvedIdentityExact,
      restored:
        preResolvedAuthorityExact && authorityExact && resolvedIdentityExact,
    };
  };
  const failedInstrumentationRestoration = (label, receipt) => ({
    label,
    hadOwnBefore: receipt.authority.hadOwn,
    hasOwnAfter: receipt.authority.hadOwn,
    ownerDepthBefore: receipt.authority.ownerDepth,
    ownerDepthAfter: receipt.authority.ownerDepth,
    ownerDescriptorBefore: descriptorShape(receipt.authority.ownerDescriptor),
    ownerDescriptorAfter: descriptorShape(receipt.authority.ownerDescriptor),
    preResolvedAuthorityExact: false,
    ownershipExact: false,
    ownDescriptorExact: false,
    targetPrototypeExact: false,
    prototypeChainExact: false,
    ownerDescriptorExact: false,
    resolvedIdentityExact: false,
    restored: false,
  });
  const instrumentationRestorationByLabel = new Map();
  const cleanupFailures = [];
  const cleanupActions = [];
  const registerCleanupAction = (label, action, onError) => {
    const entry = { label, action, onError, attempted: false };
    cleanupActions.push(entry);
    return entry;
  };
  const attemptCleanupAction = (entry) => {
    if (!entry || entry.attempted) return;
    entry.attempted = true;
    try {
      if (entry.action() !== true) {
        cleanupFailures.push(entry.label);
      }
    } catch {
      cleanupFailures.push(entry.label);
      try {
        entry.onError?.();
      } catch {
        cleanupFailures.push(`${entry.label}:onError`);
      }
    }
  };
  const registerInstrumentationCleanup = (label, target, key, receipt) =>
    registerCleanupAction(
      label,
      () => {
        const proof = restoreInstrumentationDescriptor(
          label,
          target,
          key,
          receipt,
        );
        instrumentationRestorationByLabel.set(label, proof);
        return proof.restored;
      },
      () => {
        instrumentationRestorationByLabel.set(
          label,
          failedInstrumentationRestoration(label, receipt),
        );
      },
    );
  const installInstrumentationValue = (
    label,
    target,
    key,
    value,
    receipt = captureInstrumentationDescriptor(target, key),
  ) => {
    const cleanup = registerInstrumentationCleanup(label, target, key, receipt);
    try {
      if (receipt.authority.hadOwn) {
        Object.defineProperty(target, key, {
          ...receipt.authority.ownDescriptor,
          value,
        });
      } else {
        Object.defineProperty(target, key, {
          value,
          writable: true,
          enumerable: receipt.authority.ownerDescriptor.enumerable,
          configurable: true,
        });
      }
      if (!Object.is(Reflect.get(target, key), value)) {
        throw new Error(`instrumentation setup identity drifted: ${label}`);
      }
    } catch (error) {
      attemptCleanupAction(cleanup);
      throw error;
    }
    return { receipt, cleanup };
  };
  const attemptAllCleanup = () => {
    for (let index = cleanupActions.length - 1; index >= 0; index--) {
      attemptCleanupAction(cleanupActions[index]);
    }
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

  const originalDefaultEllipsoid = C.Ellipsoid.default;
  registerCleanupAction("Ellipsoid.default", () => {
    C.Ellipsoid.default = originalDefaultEllipsoid;
    return C.Ellipsoid.default === originalDefaultEllipsoid;
  });
  try {
    mark(contract.phases[0], "constructing-explicit-custom-scene");
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
    globe.terrainProvider = provider;
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
    const moon = scene.moon;
    if (!moon) {
      throw new Error("production Moon consumer is unavailable");
    }
    const moonUpdateDescriptor = captureInstrumentationDescriptor(
      moon,
      "update",
    );
    const originalMoonUpdate = moonUpdateDescriptor.resolvedValue;
    if (typeof originalMoonUpdate !== "function") {
      throw new Error("production Moon update seam is unavailable");
    }
    installInstrumentationValue(
      "moon.update",
      moon,
      "update",
      function (...args) {
        originalMoonUpdate.apply(this, args);
        // Exercise the production Moon consumer without adding a lunar command
        // to the terrain screenshots owned by this gate.
        return undefined;
      },
      moonUpdateDescriptor,
    );
    installInstrumentationValue("moon.show", moon, "show", true);
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
      const matrix = C.Transforms.computeIcrfToFixedMatrix(
        time,
        new C.Matrix3(),
      );
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
        sun: C.Matrix3.multiplyByVector(
          matrix,
          sunInertial,
          new C.Cartesian3(),
        ),
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
    const xyz = (value) => ({ x: value.x, y: value.y, z: value.z });
    const captureEphemerisLineage = () => {
      const frameState = scene.frameState;
      const sample = frameState?.celestialEphemerisSample;
      const ephemerisProvider = scene.celestialEphemerisProvider;
      const eclipseState = frameState?.eclipseState;
      const uniformState = scene.context.uniformState;
      const independentBodies = fixedBodies(frameState.time);
      const modelMatrix = moon?._ellipsoidPrimitive?.modelMatrix;
      if (
        !sample ||
        !ephemerisProvider ||
        !eclipseState?.sunPositionWC ||
        !eclipseState?.moonPositionWC ||
        !uniformState?.sunPositionWC ||
        !uniformState?.moonDirectionEC ||
        !uniformState?.viewRotation3D ||
        !modelMatrix
      ) {
        throw new Error("default Simon ephemeris consumer lineage is absent");
      }
      return {
        frameNumber: frameState.frameNumber,
        clockIso: C.JulianDate.toIso8601(frameState.time),
        provider: {
          constructor: ephemerisProvider.constructor.name,
          id: ephemerisProvider.id,
          revision: ephemerisProvider.revision,
          provenance: { ...ephemerisProvider.provenance },
          timePolicy: { ...ephemerisProvider.timePolicy },
          provenanceFrozen: Object.isFrozen(ephemerisProvider.provenance),
          timePolicyFrozen: Object.isFrozen(ephemerisProvider.timePolicy),
        },
        sample: {
          providerId: sample.providerId,
          providerRevision: sample.providerRevision,
          provenance: { ...sample.provenance },
          timePolicy: { ...sample.timePolicy },
          referenceFrame: sample.referenceFrame,
          units: sample.units,
          transformBranch: sample.transformBranch,
          outputAllocationStable: sample.outputAllocationStable,
          thirdPartyTemporaryFree: sample.thirdPartyTemporaryFree,
          sunPositionWC: xyz(sample.sunPositionWC),
          moonPositionWC: xyz(sample.moonPositionWC),
        },
        independent: {
          method: contract.ephemeris.independentMethod,
          sunPositionWC: xyz(independentBodies.sun),
          moonPositionWC: xyz(independentBodies.moon),
          sunDeltaMeters: C.Cartesian3.distance(
            independentBodies.sun,
            sample.sunPositionWC,
          ),
          moonDeltaMeters: C.Cartesian3.distance(
            independentBodies.moon,
            sample.moonPositionWC,
          ),
        },
        eclipseState: {
          sunPositionWC: xyz(eclipseState.sunPositionWC),
          moonPositionWC: xyz(eclipseState.moonPositionWC),
          sunDeltaMeters: C.Cartesian3.distance(
            eclipseState.sunPositionWC,
            sample.sunPositionWC,
          ),
          moonDeltaMeters: C.Cartesian3.distance(
            eclipseState.moonPositionWC,
            sample.moonPositionWC,
          ),
          sunStorageDistinct:
            eclipseState.sunPositionWC !== sample.sunPositionWC,
          moonStorageDistinct:
            eclipseState.moonPositionWC !== sample.moonPositionWC,
        },
        consumers: {
          uniformSunPositionWC: xyz(uniformState.sunPositionWC),
          uniformSunStorageDistinct:
            uniformState.sunPositionWC !== sample.sunPositionWC,
          viewRotation3D: Array.from(uniformState.viewRotation3D),
          moonDirectionEC: xyz(uniformState.moonDirectionEC),
          moonDirectionStorageDistinct:
            uniformState.moonDirectionEC !== sample.moonPositionWC,
          moonModelTranslation: {
            x: modelMatrix[12],
            y: modelMatrix[13],
            z: modelMatrix[14],
          },
          moonModelStorageDistinct: modelMatrix !== sample.moonPositionWC,
        },
        identities: {
          providerIsSceneProvider:
            ephemerisProvider === scene.celestialEphemerisProvider,
          sampleIsFrameStateSample:
            sample === scene.frameState.celestialEphemerisSample,
          sampleProvenanceIsProviderProvenance:
            sample.provenance === ephemerisProvider.provenance,
          sampleTimePolicyIsProviderTimePolicy:
            sample.timePolicy === ephemerisProvider.timePolicy,
        },
      };
    };
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

    const globeRendererDescriptor =
      contract.renderer === "webgpu"
        ? scene.context.getFeatureRenderer?.(C.FeatureRendererKey.GLOBE_SURFACE)
        : null;
    const sceneCaptureSources =
      contract.renderer === "webgpu"
        ? scene.context._webgpuSceneCaptureSources
        : null;
    const globeRenderer = sceneCaptureSources?.globeRenderer ?? null;
    const eclipsePrepareRecords = [];
    const eclipseManager = globeRenderer?._eclipseUniforms;
    const eclipsePrepareDescriptor = eclipseManager
      ? captureInstrumentationDescriptor(eclipseManager, "prepare")
      : null;
    const originalEclipsePrepare = eclipsePrepareDescriptor?.resolvedValue;
    if (contract.renderer === "webgpu") {
      if (
        !globeRendererDescriptor ||
        typeof globeRendererDescriptor.RendererClass !== "function" ||
        typeof globeRendererDescriptor.getShaderCode !== "function" ||
        !(globeRenderer instanceof globeRendererDescriptor.RendererClass) ||
        sceneCaptureSources?.tileProvider !== tp ||
        typeof originalEclipsePrepare !== "function"
      ) {
        throw new Error("WebGPU globe eclipse manager is unavailable");
      }
      installInstrumentationValue(
        "eclipseManager.prepare",
        eclipseManager,
        "prepare",
        function (device, frameState) {
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
                    sunDirectionAndInvRange: {
                      ...block.sunDirectionAndInvRange,
                    },
                    moonDirectionDeltaAndInvRange: {
                      ...block.moonDirectionDeltaAndInvRange,
                    },
                    params: { ...block.params },
                    params2: { ...block.params2 },
                  }
                : null,
          });
          return result;
        },
        eclipsePrepareDescriptor,
      );
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
        sinLatitude * cosDistance +
          cosLatitude * sinDistance * Math.cos(bearing),
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
          if (
            x < 1 ||
            y < 1 ||
            x >= canvas.width - 1 ||
            y >= canvas.height - 1
          ) {
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
          const tileBoundaryDistancesPixels = tileBoundaryPixels.map(
            (boundary) => Math.hypot(boundary.x - x, boundary.y - y),
          );
          const boundaryDistancePixels = Math.min(
            ...tileBoundaryDistancesPixels,
          );
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
              boundaryDistancePixels >
                contract.tileInteriorPixelFootprintRadius,
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
        ephemeris: captureEphemerisLineage(),
      };
    };
    const stableComparableState = (state) => ({
      ...state,
      preparedTuple: {
        ...state.preparedTuple,
        selectionRevision: 0,
      },
      ephemeris: {
        ...state.ephemeris,
        frameNumber: 0,
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
            ? [...stableWindow, observation].slice(
                -contract.minimumStableFrames,
              )
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
    const eventOnEphemeris =
      captures.at(-1).temporalStability.captureState.ephemeris;
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
        sun: { ...eventOnEphemeris.sample.sunPositionWC },
        moon: { ...eventOnEphemeris.sample.moonPositionWC },
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
      candidates: compareCandidates(
        eventCandidates,
        eventOffImage,
        eventOnImage,
      ),
      oracleSampleCount: 0,
      allSamplesWithinDerivedTolerance: false,
      hasUmbra: false,
      hasPenumbra: false,
      hasClear: false,
      captureLabel: "event-on",
    };

    if (contract.renderer === "webgl") {
      const hasServedBundleExport = Object.hasOwn(C, "AutomaticUniforms");
      const automaticUniforms = C.AutomaticUniforms;
      const radiiUniform = automaticUniforms?.czm_ellipsoidRadii;
      const inverseRadiiUniform = automaticUniforms?.czm_ellipsoidInverseRadii;
      if (
        !hasServedBundleExport ||
        typeof automaticUniforms !== "object" ||
        automaticUniforms === null ||
        typeof radiiUniform?.getValue !== "function" ||
        typeof inverseRadiiUniform?.getValue !== "function"
      ) {
        throw new Error(
          "served production bundle AutomaticUniforms export is missing or invalid",
        );
      }
      const radii = C.AutomaticUniforms.czm_ellipsoidRadii.getValue(
        scene.context.uniformState,
      );
      const inverse = C.AutomaticUniforms.czm_ellipsoidInverseRadii.getValue(
        scene.context.uniformState,
      );
      preparation.backendIdentity = {
        automaticUniforms: {
          exportName: "AutomaticUniforms",
          servedBundleExport: hasServedBundleExport,
          bundleExportIdentity: automaticUniforms === C.AutomaticUniforms,
          radiiUniformIdentity:
            radiiUniform === C.AutomaticUniforms.czm_ellipsoidRadii,
          inverseRadiiUniformIdentity:
            inverseRadiiUniform ===
            C.AutomaticUniforms.czm_ellipsoidInverseRadii,
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
          radiiSource:
            "C.AutomaticUniforms.czm_ellipsoidRadii.getValue(scene.context.uniformState)",
          inverseRadiiSource:
            "C.AutomaticUniforms.czm_ellipsoidInverseRadii.getValue(scene.context.uniformState)",
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
    const updateForPickDescriptor = captureInstrumentationDescriptor(
      pickProvider,
      "updateForPick",
    );
    const originalUpdateForPick = updateForPickDescriptor.resolvedValue;
    const pickCalls = [];
    if (typeof originalUpdateForPick !== "function") {
      throw new Error("terrain provider updateForPick seam is unavailable");
    }
    let picked;
    let pickFrames = 0;
    let pickSettled = false;
    let pickError;
    const pickableDescriptor = captureInstrumentationDescriptor(
      globe,
      "pickable",
    );
    const pickableBefore = pickableDescriptor.resolvedValue;
    const pickableCleanup = registerCleanupAction(
      "globe.pickable",
      () =>
        restoreInstrumentationDescriptor(
          "globe.pickable",
          globe,
          "pickable",
          pickableDescriptor,
        ).restored,
    );
    let updateForPickCleanup;
    let globePickId;
    let pickIdKey = null;
    let pickIdAllocated = false;
    let pickIdRegistryOwnsGlobe = false;
    let mirroredPickColor;
    let allocatedPickColor;
    let pickColorMirrorExact = false;
    try {
      updateForPickCleanup = installInstrumentationValue(
        "pickProvider.updateForPick",
        pickProvider,
        "updateForPick",
        function (...args) {
          const before = tuple();
          const result = originalUpdateForPick.apply(this, args);
          const after = tuple();
          pickCalls.push({ before, after });
          return result;
        },
        updateForPickDescriptor,
      ).cleanup;
      Object.defineProperty(globe, "pickable", {
        ...pickableDescriptor.authority.ownDescriptor,
        value: true,
      });
      renderNow();
      globePickId = globe._pickId;
      pickIdKey = globePickId?.key ?? null;
      pickIdAllocated = Number.isInteger(pickIdKey) && pickIdKey > 0;
      pickIdRegistryOwnsGlobe =
        scene.context?._pickObjects?.get(pickIdKey)?.primitive === globe;
      mirroredPickColor = pickProvider._webgpuGlobePickColor;
      allocatedPickColor = globePickId?.color;
      pickColorMirrorExact =
        mirroredPickColor === allocatedPickColor &&
        mirroredPickColor?.red === allocatedPickColor?.red &&
        mirroredPickColor?.green === allocatedPickColor?.green &&
        mirroredPickColor?.blue === allocatedPickColor?.blue &&
        mirroredPickColor?.alpha === allocatedPickColor?.alpha;
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
      attemptCleanupAction(updateForPickCleanup);
      attemptCleanupAction(pickableCleanup);
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
      const captureCommandsDescriptor = captureInstrumentationDescriptor(
        captureGlobeRenderer,
        "getOrCreateCaptureTileCommands",
      );
      const originalCaptureCommands = captureCommandsDescriptor.resolvedValue;
      const captureCommandsWrapper = function (...args) {
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
      let captureCommandsCleanup;
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
      try {
        captureCommandsCleanup = installInstrumentationValue(
          "captureGlobeRenderer.getOrCreateCaptureTileCommands",
          captureGlobeRenderer,
          "getOrCreateCaptureTileCommands",
          captureCommandsWrapper,
          captureCommandsDescriptor,
        ).cleanup;
        manager.enableSceneCapture = true;
        manager.reset();
        await settle(
          () =>
            manager._webgpuCache?.lastSceneCaptureResult === 2 &&
            captureCalls.length >= 6,
          contract.maximumRetainedCaptureFrames,
          "manager-driven retained capture",
        );
      } finally {
        attemptCleanupAction(captureCommandsCleanup);
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
            JSON.stringify([...tiles].sort()) ===
            JSON.stringify(retainedTileIds),
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
    attemptAllCleanup();
    const expectedInstrumentationLabels = [
      ...(contract.renderer === "webgpu"
        ? [
            "captureGlobeRenderer.getOrCreateCaptureTileCommands",
            "eclipseManager.prepare",
          ]
        : []),
      "moon.show",
      "moon.update",
      "pickProvider.updateForPick",
    ];
    const instrumentationRestorations = expectedInstrumentationLabels
      .map((label) => instrumentationRestorationByLabel.get(label))
      .filter((restoration) => restoration !== undefined);
    const exactCleanupFailures = [...new Set(cleanupFailures)].sort();
    const sessionCleanup = {
      complete: exactCleanupFailures.length === 0,
      timersCleared: true,
      cleanupFailures: exactCleanupFailures,
      instrumentationRestorations,
      instrumentationRestored:
        instrumentationRestorations.length ===
          expectedInstrumentationLabels.length &&
        instrumentationRestorations.every(
          (restoration) => restoration.restored === true,
        ),
      defaultEllipsoidRestored:
        !exactCleanupFailures.includes("Ellipsoid.default"),
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
        complete: sessionCleanup.complete,
        pageClosed: false,
        timersCleared: sessionCleanup.timersCleared,
      },
    };
  } finally {
    // Setup, measurement, and restoration failures all converge here. Every
    // registered action is idempotently attempted so one red seam cannot skip
    // restoration of the remaining wrappers or global state.
    attemptAllCleanup();
  }
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
    ownedPngs.push(
      createC1229S5CustomImmutableAuthority(
        file,
        bytes,
        `${session.renderer} ${capture.label} PNG`,
        operations,
      ),
    );
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
    const file = owned.path ?? owned.file;
    let current;
    try {
      current = readBytesIfPresent(file, operations);
    } catch (error) {
      reasons.push(`${file}: cleanup read failed: ${error.message}`);
      continue;
    }
    if (current === undefined) continue;
    try {
      assertImmutableFileAuthority(owned, `cleanup PNG ${file}`, operations);
    } catch {
      reasons.push(`${file}: foreign replacement preserved`);
      continue;
    }
    const receipt = `${file}.cleanup-${randomUUID()}.receipt`;
    try {
      operations.renameSync(file, receipt);
      const before = inspectImmutableDescriptor(
        receipt,
        `claimed cleanup PNG ${file}`,
        operations,
      );
      exactBytes(
        receipt,
        owned.bytes,
        `claimed cleanup PNG ${file}`,
        operations,
      );
      const after = inspectImmutableDescriptor(
        receipt,
        `claimed cleanup PNG ${file} after read`,
        operations,
      );
      if (
        !sameImmutableEntryIdentity(before, owned.descriptor) ||
        !sameImmutableDescriptor(before, after)
      ) {
        throw new Error("claimed cleanup PNG entry is not owned");
      }
      operations.unlinkSync(receipt);
      if (readBytesIfPresent(receipt, operations) !== undefined) {
        throw new Error("owned cleanup PNG receipt remained after unlink");
      }
      removed++;
    } catch (error) {
      let disposition = "retained at its cleanup receipt";
      let reportedError = error;
      try {
        if (
          readBytesIfPresent(receipt, operations) !== undefined &&
          readBytesIfPresent(file, operations) === undefined
        ) {
          operations.renameSync(receipt, file);
          disposition = "restored at its canonical path";
        }
      } catch (restoreError) {
        reportedError = new AggregateError(
          [error, restoreError],
          "cleanup PNG claim and restoration failed",
          { cause: restoreError },
        );
      }
      reasons.push(
        `${file}: foreign or unproven replacement ${disposition}: ${reportedError.message}`,
      );
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
    ephemeris: structuredClone(C12_29_S5_CUSTOM_EPHEMERIS),
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

export function runC1229S5CustomBestEffortCleanup(actions) {
  if (!Array.isArray(actions)) {
    throw new TypeError("cleanup actions must be an array");
  }
  const attempted = [];
  const failures = [];
  for (let index = actions.length - 1; index >= 0; index--) {
    const entry = actions[index];
    if (
      entry === null ||
      typeof entry !== "object" ||
      typeof entry.label !== "string" ||
      entry.label.length === 0 ||
      typeof entry.restore !== "function"
    ) {
      throw new TypeError(`cleanup action ${index} is invalid`);
    }
    attempted.push(entry.label);
    try {
      if (entry.restore() !== true) failures.push(entry.label);
    } catch {
      failures.push(entry.label);
      try {
        entry.onError?.();
      } catch {
        failures.push(`${entry.label}:onError`);
      }
    }
  }
  return Object.freeze({
    attempted: Object.freeze(attempted),
    failures: Object.freeze(failures),
  });
}

async function runC1229S5CustomBrowserSession(
  browser,
  renderer,
  baseIdentity,
  runId,
  paths,
  ownedPngs,
  watchdogState,
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
  watchdogState.renderer = renderer;
  watchdogState.page = page;
  watchdogState.pageDiagnostic = null;
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
    watchdogState.pageDiagnostic = diagnostics;
  }
  const pageClose = await closeC1229S5CustomResourceBounded(
    page,
    `${renderer} page`,
  );
  const contextClose = await closeC1229S5CustomResourceBounded(
    context,
    `${renderer} context`,
  );
  if (watchdogState.page === page) watchdogState.page = null;
  if (measured) {
    const pageCleanupComplete = measured.cleanup?.complete === true;
    measured.cleanup = {
      complete:
        pageCleanupComplete &&
        pageClose.closed &&
        contextClose.closed &&
        pending.size === 0,
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

async function readC1229S5CustomPageProgressBounded(page, timeoutMs = 1_000) {
  if (!page) return null;
  let timer;
  try {
    return await Promise.race([
      page
        .evaluate(() =>
          globalThis.__c1229S5CustomProgress
            ? JSON.parse(JSON.stringify(globalThis.__c1229S5CustomProgress))
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

export async function withC1229S5CustomWatchdog(
  task,
  closeOnTimeout,
  timeoutMs,
  renderer = "webgl",
) {
  if (typeof task !== "function" || typeof closeOnTimeout !== "function") {
    throw new TypeError(
      "custom-ellipsoid watchdog callbacks must be functions",
    );
  }
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 2_147_483_647
  ) {
    throw new TypeError(
      "custom-ellipsoid watchdog timeout must be a positive safe integer within the timer range",
    );
  }
  let timer;
  let expired = false;
  let deadlineError;
  const abortController = new AbortController();
  const deadlineNs =
    process.hrtime.bigint() + BigInt(timeoutMs) * BigInt(1_000_000);
  const taskPromise = Promise.resolve().then(() =>
    task(abortController.signal),
  );
  const expire = () => {
    if (deadlineError) return deadlineError;
    expired = true;
    clearTimeout(timer);
    let deadlineRenderer;
    try {
      deadlineRenderer = typeof renderer === "function" ? renderer() : renderer;
    } catch {
      deadlineRenderer = undefined;
    }
    const diagnosticRenderer = C12_29_S5_CUSTOM_RENDERERS.includes(
      deadlineRenderer,
    )
      ? deadlineRenderer
      : "webgl";
    const error = new Error(
      `custom-ellipsoid watchdog expired after ${timeoutMs} ms; drain=pending`,
    );
    deadlineError = error;
    error.customDiagnostics = {
      schema: C12_29_S5_CUSTOM_DIAGNOSTICS_SCHEMA,
      renderer: diagnosticRenderer,
      stage: "watchdog",
      timeoutMs,
      page: null,
    };
    // Until both cleanup and the aborted task have settled, RUNNING is the
    // only safe canonical state. The caller awaits the hidden drain before
    // deciding whether an exact ERROR may be published.
    error.retainCustomRunning = true;
    abortController.abort(error);
    const cleanupSettlement = Promise.resolve()
      .then(() => closeOnTimeout(abortController.signal))
      .then(
        (value) => ({ status: "fulfilled", value }),
        (cleanupError) => ({ status: "rejected", error: cleanupError }),
      );
    const taskSettlement = taskPromise.then(
      (value) => ({ status: "fulfilled", value }),
      (taskError) => ({ status: "rejected", error: taskError }),
    );
    const drain = Promise.all([cleanupSettlement, taskSettlement]).then(
      ([cleanup, settlement]) => {
        const cleanupValue = cleanup.value ?? {};
        const page =
          cleanupValue.page?.renderer === diagnosticRenderer
            ? cleanupValue.page
            : null;
        error.customDiagnostics.page = page;
        error.customDiagnostics.stage = page?.currentPhase ?? "watchdog";
        let drainError =
          cleanup.status === "rejected"
            ? cleanup.error
            : cleanupValue.drainError;
        if (settlement.status === "fulfilled") {
          const lateSuccess = new Error(
            "custom-ellipsoid task fulfilled after watchdog deadline",
          );
          drainError =
            drainError === undefined
              ? lateSuccess
              : new AggregateError(
                  [drainError, lateSuccess],
                  "custom-ellipsoid cleanup failed and task fulfilled after deadline",
                  { cause: drainError },
                );
        }
        const cleanupProven =
          cleanup.status === "fulfilled" &&
          cleanupValue.drainError === undefined;
        if (cleanupProven) {
          delete error.retainCustomRunning;
        } else {
          error.retainCustomRunning = true;
        }
        error.message =
          `custom-ellipsoid watchdog expired after ${timeoutMs} ms; ` +
          `cleanupProven=${cleanupProven}; task=${settlement.status}`;
        if (drainError !== undefined) error.cause = drainError;
        return {
          cleanupProven,
          taskStatus: settlement.status,
          renderer: diagnosticRenderer,
          page,
          drainError,
        };
      },
    );
    Object.defineProperty(error, "c1229S5CustomDrain", {
      value: drain,
      enumerable: false,
    });
    return error;
  };
  const guardedTask = taskPromise.then(
    (value) => {
      if (process.hrtime.bigint() >= deadlineNs) throw expire();
      return value;
    },
    (error) => {
      if (process.hrtime.bigint() >= deadlineNs) throw expire();
      throw error;
    },
  );
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(expire()), timeoutMs);
  });
  try {
    return await Promise.race([guardedTask, timeout]);
  } finally {
    clearTimeout(timer);
    if (expired) taskPromise.catch(() => {});
  }
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

export function createC1229S5CustomErrorArtifact(runId, error) {
  let diagnostic;
  try {
    diagnostic = error?.customDiagnostics;
  } catch {
    diagnostic = undefined;
  }
  let diagnosticRenderer;
  let diagnosticStage;
  let diagnosticTimeoutMs;
  let diagnosticPage;
  try {
    diagnosticRenderer = diagnostic?.renderer;
    diagnosticStage = diagnostic?.stage;
    diagnosticTimeoutMs = diagnostic?.timeoutMs;
    diagnosticPage = diagnostic?.page;
  } catch {
    diagnosticRenderer = undefined;
    diagnosticStage = undefined;
    diagnosticTimeoutMs = undefined;
    diagnosticPage = undefined;
  }
  const renderer = C12_29_S5_CUSTOM_RENDERERS.includes(diagnosticRenderer)
    ? diagnosticRenderer
    : "webgl";
  const artifact = {
    schema: C12_29_S5_CUSTOM_SCHEMA,
    runId,
    status: "ERROR",
    incomplete: false,
    exitCode: exitCodeForC1229S5CustomStatus("ERROR"),
    artifactName: `${runId}.json`,
    error: boundedC1229S5CustomErrorText(error),
    diagnostics: {
      schema: C12_29_S5_CUSTOM_DIAGNOSTICS_SCHEMA,
      renderer,
      stage: diagnosticStage ?? "node",
      timeoutMs: diagnosticTimeoutMs ?? WATCHDOG_MS,
      page: diagnosticPage ?? null,
    },
  };
  if (!validateC1229S5CustomFinalArtifact(artifact).ok) {
    artifact.diagnostics = {
      schema: C12_29_S5_CUSTOM_DIAGNOSTICS_SCHEMA,
      renderer,
      stage: "node",
      timeoutMs: WATCHDOG_MS,
      page: null,
    };
  }
  return artifact;
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
  const watchdogState = {
    renderer: null,
    page: null,
    pageDiagnostic: null,
  };
  try {
    ownership = beginC1229S5CustomEvidenceRun(paths, runId, operations);
    ownership.pngAuthorities = ownedPngs;
    const start = await collectC1229S5CustomProvenanceSnapshot();
    browser = await launchBrowser({
      channel: process.env.PROBE_BROWSER_CHANNEL || "msedge",
      headless: process.env.PROBE_HEADED !== "1",
    });
    const sessions = await withC1229S5CustomWatchdog(
      async (signal) => {
        const measured = [];
        for (const renderer of C12_29_S5_CUSTOM_RENDERERS) {
          signal.throwIfAborted();
          watchdogRenderer = renderer;
          measured.push(
            await runC1229S5CustomBrowserSession(
              browser,
              renderer,
              baseIdentity,
              runId,
              paths,
              ownedPngs,
              watchdogState,
              operations,
            ),
          );
          signal.throwIfAborted();
        }
        return measured;
      },
      async () => {
        const page =
          watchdogState.pageDiagnostic ??
          (await readC1229S5CustomPageProgressBounded(watchdogState.page));
        const closing = browser;
        browser = undefined;
        let drainError;
        try {
          await closeBrowserOrThrow(closing);
        } catch (error) {
          drainError = error;
        }
        return {
          renderer: watchdogState.renderer ?? watchdogRenderer,
          page,
          drainError,
        };
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
    const canonicalReport = JSON.parse(stableC1229S5CustomJson(report));
    const verdict = foldC1229S5CustomEllipsoidGate(canonicalReport);
    const artifact = {
      ...canonicalReport,
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
    if (error?.c1229S5CustomDrain) {
      const drain = await error.c1229S5CustomDrain;
      if (drain.cleanupProven !== true) error.retainCustomRunning = true;
    }
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
      } else {
        ownedPngs.length = 0;
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
