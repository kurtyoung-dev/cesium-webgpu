#!/usr/bin/env node
/**
 * C12-29 S5 dense ACTIVE/INACTIVE cost characterization.
 *
 * The coordinator launches 24 child Node processes in the frozen order. Each
 * child launches exactly one fresh Edge process, runs one 600-frame condition,
 * and exits. The probe requires already-certified terrain-v10 and NASA-SVS-v4
 * publication manifests, a current Build/CesiumUnminified bundle, and an
 * already-running loopback server. It does not build or start infrastructure.
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium } from "playwright";

import {
  C12_29_S5_DENSE_BUILD_SOURCE_FILES,
  C12_29_S5_DENSE_CONFIG,
  C12_29_S5_DENSE_LOCAL_FILES,
  C12_29_S5_DENSE_LEGACY_SCHEMA,
  C12_29_S5_DENSE_RAW_GENERATED_PAIRS,
  C12_29_S5_DENSE_RUNTIME_SCHEMA,
  C12_29_S5_DENSE_SCHEDULE,
  C12_29_S5_DENSE_SCHEMA,
  C12_29_S5_DENSE_SERVED_FILES,
  C12_29_S5_DENSE_SUPERSEDED_SCHEMA,
  c1229S5DenseLegId,
  exitCodeForC1229S5DenseStatus,
  foldC1229S5DenseCostGate,
  stableC1229S5DenseJson,
  validateC1229S5DenseFinalArtifact,
  validateC1229S5DenseLegacyFinalArtifact,
  validateC1229S5DensePrerequisites,
  validateC1229S5DenseRuntimeLeg,
  validateC1229S5DenseSupersededFinalArtifact,
  validateC1229S5DenseWorkload,
} from "./lib/c12-29-s5-dense-cost-gate.mjs";
import {
  createImmutableEvidence,
  inspectBuildSourceIdentity,
} from "./lib/build-source-identity.mjs";

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(toolDirectory, "../..");
const probePath = fileURLToPath(import.meta.url);
const workloadPath = path.join(
  toolDirectory,
  "performance-workloads-s5-dense-cost.json",
);
const buildEntryPath = path.join(
  repositoryRoot,
  "Build/CesiumUnminified/index.js",
);
const buildSourceMapPath = `${buildEntryPath}.map`;
const defaultOutputDirectory = path.resolve(
  process.env.C12_29_S5_DENSE_OUTPUT_DIR ??
    path.join(toolDirectory, "output/performance/c12-29-s5-dense-cost"),
);
const artifactPrefix = "campaign12-c12-29-s5-dense-cost";
const defaultBase = process.env.PROBE_BASE ?? "http://localhost:8080";
const densePublicationAuthorityState = new WeakMap();
const denseArtifactPathKeys = Object.freeze([
  "directory",
  "immutable",
  "latest",
  "recoveryLatest",
  "firstRed",
  "lock",
  "runningReceipt",
  "finalReceipt",
  "rawDirectory",
]);

const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex").toLowerCase();
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

function usage() {
  console.log(`Usage: node Tools/visual-regression/probe-c12-29-s5-dense-cost.mjs [options]

Required coordinator options:
  --terrain-publication FILE  Certified terrain-v10 publication manifest
  --nasa-publication FILE     Certified NASA-SVS-v4 publication manifest

Options:
  --base URL                  Loopback server (default ${defaultBase})
  --output-directory DIR      Dedicated output namespace
  --headed                    Show each fresh Edge process
  --help                      Show this help

Internal --leg-* options are reserved for coordinator child processes.`);
}

function parseArguments(argv) {
  const options = {
    base: defaultBase,
    outputDirectory: defaultOutputDirectory,
    headed: false,
    terrainPublication: null,
    nasaPublication: null,
    legOrdinal: null,
    legOutput: null,
    runId: null,
    sourceSha: null,
    prerequisitesSha: null,
    workloadSha: null,
  };
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
    else if (argument === "--terrain-publication")
      options.terrainPublication = path.resolve(value());
    else if (argument === "--nasa-publication")
      options.nasaPublication = path.resolve(value());
    else if (argument === "--headed") options.headed = true;
    else if (argument === "--leg-ordinal") options.legOrdinal = Number(value());
    else if (argument === "--leg-output")
      options.legOutput = path.resolve(value());
    else if (argument === "--run-id") options.runId = value();
    else if (argument === "--source-sha") options.sourceSha = value();
    else if (argument === "--prerequisites-sha")
      options.prerequisitesSha = value();
    else if (argument === "--workload-sha") options.workloadSha = value();
    else if (argument === "--help") {
      usage();
      process.exit(0);
    } else throw new Error(`unknown argument ${argument}`);
  }
  return options;
}

function loopbackIdentity(value) {
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

function fileIdentity(absolutePath) {
  const bytes = fs.readFileSync(absolutePath);
  return {
    path: path.relative(repositoryRoot, absolutePath).replaceAll("\\", "/"),
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

async function servedIdentity(origin, relativePath) {
  const url = new URL(`/${relativePath}`, origin);
  const response = await fetch(url, { cache: "no-store", redirect: "error" });
  if (!response.ok) {
    throw new Error(
      `[structural] ${url.href} returned HTTP ${response.status}`,
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    path: relativePath,
    url: url.href,
    status: response.status,
    contentType: response.headers.get("content-type"),
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

function safeGitHead() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

async function rawGeneratedIdentity(pair) {
  const rawPath = path.join(repositoryRoot, pair.raw);
  const generatedPath = path.join(repositoryRoot, pair.generated);
  const raw = fs.readFileSync(rawPath, "utf8").replaceAll("\r\n", "\n");
  const generated = await import(
    `${pathToFileURL(generatedPath).href}?dense=${randomUUID()}`
  );
  return {
    ...pair,
    rawIdentity: fileIdentity(rawPath),
    generatedIdentity: fileIdentity(generatedPath),
    exact: typeof generated.default === "string" && generated.default === raw,
  };
}

async function collectProvenanceSnapshot(baseIdentity) {
  const reasons = [];
  const localFiles = [];
  for (const relativePath of C12_29_S5_DENSE_LOCAL_FILES) {
    try {
      localFiles.push(fileIdentity(path.join(repositoryRoot, relativePath)));
    } catch (error) {
      reasons.push(
        `${relativePath}: ${error?.code ?? error?.message ?? error}`,
      );
    }
  }
  const servedFiles = [];
  for (const relativePath of C12_29_S5_DENSE_SERVED_FILES) {
    try {
      servedFiles.push(await servedIdentity(baseIdentity.origin, relativePath));
    } catch (error) {
      reasons.push(String(error?.message ?? error));
    }
  }
  const rawGenerated = [];
  for (const pair of C12_29_S5_DENSE_RAW_GENERATED_PAIRS) {
    try {
      const identity = await rawGeneratedIdentity(pair);
      rawGenerated.push(identity);
      if (!identity.exact)
        reasons.push(
          `${pair.raw} does not equal ${pair.generated} default text`,
        );
    } catch (error) {
      reasons.push(`${pair.raw}/${pair.generated}: ${error?.message ?? error}`);
    }
  }
  let buildSourceIdentity;
  try {
    buildSourceIdentity = inspectBuildSourceIdentity({
      sourceMapPath: buildSourceMapPath,
      sourceFiles: C12_29_S5_DENSE_BUILD_SOURCE_FILES.map((relativePath) =>
        path.join(repositoryRoot, relativePath),
      ),
    });
    buildSourceIdentity = {
      ...buildSourceIdentity,
      sourceMapPath: path
        .relative(repositoryRoot, buildSourceIdentity.sourceMapPath)
        .replaceAll("\\", "/"),
      entries: buildSourceIdentity.entries.map((entry) => ({
        ...entry,
        file: path.relative(repositoryRoot, entry.file).replaceAll("\\", "/"),
      })),
    };
    reasons.push(...(buildSourceIdentity.reasons ?? []));
  } catch (error) {
    buildSourceIdentity = { ok: false, entries: [], reasons: [String(error)] };
    reasons.push(String(error?.message ?? error));
  }
  const localEntry = localFiles.find(
    (identity) => identity.path === "Build/CesiumUnminified/index.js",
  );
  const servedEntry = servedFiles.find(
    (identity) => identity.path === "Build/CesiumUnminified/index.js",
  );
  if (
    !localEntry ||
    !servedEntry ||
    localEntry.byteLength !== servedEntry.byteLength ||
    localEntry.sha256 !== servedEntry.sha256
  ) {
    reasons.push("served runtime entry differs from the local build entry");
  }
  const identity = {
    gitHead: safeGitHead(),
    localFiles,
    servedFiles,
    buildSourceIdentity,
    rawGenerated,
  };
  return {
    capturedAt: new Date().toISOString(),
    ...identity,
    identitySha256: sha256(Buffer.from(stableC1229S5DenseJson(identity))),
    ok: reasons.length === 0,
    reasons,
  };
}

function sameProvenance(start, end) {
  return (
    start.ok === true &&
    end.ok === true &&
    start.identitySha256 === end.identitySha256 &&
    start.gitHead === end.gitHead &&
    stableC1229S5DenseJson(start.localFiles) ===
      stableC1229S5DenseJson(end.localFiles) &&
    stableC1229S5DenseJson(start.servedFiles) ===
      stableC1229S5DenseJson(end.servedFiles) &&
    stableC1229S5DenseJson(start.buildSourceIdentity) ===
      stableC1229S5DenseJson(end.buildSourceIdentity) &&
    stableC1229S5DenseJson(start.rawGenerated) ===
      stableC1229S5DenseJson(end.rawGenerated)
  );
}

function resolvePublicationArtifact(manifestPath, expected) {
  if (!manifestPath)
    throw new Error(
      `[structural] ${expected.kind} publication manifest is required`,
    );
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (
    manifest.schema !== "cesium-visual-evidence-publication/v2" ||
    manifest.producer !== expected.producer ||
    manifest.result?.status !== "PASS" ||
    manifest.result?.exitCode !== 0 ||
    manifest.result?.certificationEligible !== true ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error(
      `[structural] ${expected.kind} publication is not an eligible PASS`,
    );
  }
  const candidates = manifest.files.filter(
    (file) =>
      file.role === "artifact" &&
      file.mediaType === "application/json" &&
      typeof file.viewPath === "string",
  );
  if (candidates.length !== 1) {
    throw new Error(
      `[structural] ${expected.kind} publication must contain one JSON artifact`,
    );
  }
  const file = candidates[0];
  const artifactPath = path.resolve(path.dirname(manifestPath), file.viewPath);
  const artifactBytes = fs.readFileSync(artifactPath);
  if (
    artifactBytes.byteLength !== file.byteLength ||
    sha256(artifactBytes) !== String(file.sha256).toLowerCase()
  ) {
    throw new Error(
      `[structural] ${expected.kind} artifact bytes differ from publication`,
    );
  }
  const artifact = JSON.parse(artifactBytes.toString("utf8"));
  if (
    artifact.schema !== expected.schema ||
    artifact.runId !== manifest.runId ||
    artifact.status !== "PASS" ||
    artifact.incomplete !== false ||
    artifact.exitCode !== 0
  ) {
    throw new Error(
      `[structural] ${expected.kind} artifact is not the exact final PASS`,
    );
  }
  return {
    kind: expected.kind,
    producer: expected.producer,
    publication: {
      path: manifestPath.replaceAll("\\", "/"),
      schema: manifest.schema,
      runId: manifest.runId,
      status: manifest.result.status,
      exitCode: manifest.result.exitCode,
      certificationEligible: manifest.result.certificationEligible,
      byteLength: manifestBytes.byteLength,
      sha256: sha256(manifestBytes),
    },
    artifact: {
      path: artifactPath.replaceAll("\\", "/"),
      name: path.basename(artifactPath),
      schema: artifact.schema,
      runId: artifact.runId,
      status: artifact.status,
      incomplete: artifact.incomplete,
      exitCode: artifact.exitCode,
      byteLength: artifactBytes.byteLength,
      sha256: sha256(artifactBytes),
    },
  };
}

function loadPrerequisites(options) {
  const prerequisites = {
    terrain: resolvePublicationArtifact(options.terrainPublication, {
      kind: "terrain",
      producer: "c12-29-s5-terrain-selection",
      schema: "c12-29-s5-terrain-selection-evidence-v10",
    }),
    nasa: resolvePublicationArtifact(options.nasaPublication, {
      kind: "nasa",
      producer: "c12-29-s5-svs-footprint",
      schema: "c12-29-s5-svs-5073-footprint-evidence-v4",
    }),
  };
  const validation = validateC1229S5DensePrerequisites(prerequisites);
  if (!validation.valid) {
    throw new Error(`[structural] ${validation.reasons.join("; ")}`);
  }
  return prerequisites;
}

export function createC1229S5DenseArtifactPaths(outputDirectory, runId) {
  const directory = path.resolve(outputDirectory);
  return {
    directory,
    immutable: path.join(directory, `${runId}.json`),
    latest: path.join(directory, `${artifactPrefix}.latest.json`),
    recoveryLatest: path.join(
      directory,
      `${runId}.publication-recovery-latest.json`,
    ),
    firstRed: path.join(directory, `${artifactPrefix}.first-red.json`),
    lock: path.join(directory, `${artifactPrefix}.lock.json`),
    runningReceipt: path.join(directory, `${runId}.running-receipt.json`),
    finalReceipt: path.join(directory, `${runId}.final-receipt.json`),
    rawDirectory: path.join(directory, `${runId}.legs`),
  };
}

function normalizeDenseArtifactPaths(paths, runId) {
  if (!paths || typeof paths !== "object") {
    throw new Error("[persistence] dense artifact paths are absent");
  }
  const keys = Object.keys(paths).sort();
  if (keys.join(",") !== [...denseArtifactPathKeys].sort().join(",")) {
    throw new Error("[persistence] dense artifact path fields differ");
  }
  const normalized = {};
  for (const key of denseArtifactPathKeys) {
    if (typeof paths[key] !== "string" || paths[key].length === 0) {
      throw new Error(`[persistence] dense artifact path ${key} is invalid`);
    }
    normalized[key] = path.resolve(paths[key]);
  }
  const expected = createC1229S5DenseArtifactPaths(normalized.directory, runId);
  for (const key of denseArtifactPathKeys) {
    if (normalized[key] !== expected[key]) {
      throw new Error(
        `[persistence] dense artifact path topology differs at ${key}`,
      );
    }
  }
  return Object.freeze(normalized);
}

function statValue(stat, field) {
  const value = stat?.[field];
  return typeof value === "bigint" ? value.toString() : String(value);
}

function regularFileDescriptor(stat) {
  return {
    dev: statValue(stat, "dev"),
    ino: statValue(stat, "ino"),
    mode: statValue(stat, "mode"),
    nlink: statValue(stat, "nlink"),
    size: statValue(stat, "size"),
    ctimeNs: statValue(stat, "ctimeNs"),
    birthtimeNs: statValue(stat, "birthtimeNs"),
  };
}

function directoryDescriptor(stat) {
  return {
    dev: statValue(stat, "dev"),
    ino: statValue(stat, "ino"),
    mode: statValue(stat, "mode"),
    birthtimeNs: statValue(stat, "birthtimeNs"),
  };
}

function sameDescriptor(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameFileObject(left, right) {
  return (
    left?.dev === right?.dev &&
    left?.ino === right?.ino &&
    left?.mode === right?.mode &&
    left?.nlink === right?.nlink &&
    left?.size === right?.size &&
    left?.birthtimeNs === right?.birthtimeNs
  );
}

function lstatNoFollow(file, label, operations = fs) {
  try {
    return operations.lstatSync(file, { bigint: true });
  } catch (error) {
    throw new Error(
      `[persistence] ${label} no-follow lstat failed: ${String(error?.message ?? error)}`,
      { cause: error },
    );
  }
}

function requireAbsentNoFollow(file, label, operations = fs) {
  try {
    operations.lstatSync(file, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "absent" };
    throw new Error(
      `[persistence] ${label} absence lstat failed: ${String(error?.message ?? error)}`,
      { cause: error },
    );
  }
  throw new Error(`[persistence] ${label} is occupied`);
}

function captureDirectoryAuthority(directory, label, operations = fs) {
  const stat = lstatNoFollow(directory, label, operations);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`[persistence] ${label} is not a no-follow directory`);
  }
  return Object.freeze({
    path: path.resolve(directory),
    descriptor: Object.freeze(directoryDescriptor(stat)),
  });
}

function assertDirectoryAuthority(authority, label, operations = fs) {
  const observed = captureDirectoryAuthority(authority.path, label, operations);
  if (!sameDescriptor(observed.descriptor, authority.descriptor)) {
    throw new Error(`[persistence] ${label} directory identity differs`);
  }
}

function readRegularFileNoFollow(file, label, operations = fs) {
  const normalizedPath = path.resolve(file);
  const before = lstatNoFollow(
    normalizedPath,
    `${label} before open`,
    operations,
  );
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    statValue(before, "nlink") !== "1"
  ) {
    throw new Error(
      `[persistence] ${label} is not a single-link no-follow regular file`,
    );
  }
  const beforeDescriptor = regularFileDescriptor(before);
  let descriptor;
  let bytes;
  let fileDescriptor;
  try {
    descriptor = operations.openSync(
      normalizedPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = operations.fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      statValue(opened, "nlink") !== "1" ||
      !sameDescriptor(regularFileDescriptor(opened), beforeDescriptor)
    ) {
      throw new Error(`[persistence] ${label} opened descriptor differs`);
    }
    const value = operations.readFileSync(descriptor);
    bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const afterRead = operations.fstatSync(descriptor, { bigint: true });
    fileDescriptor = regularFileDescriptor(afterRead);
    if (!sameDescriptor(fileDescriptor, beforeDescriptor)) {
      throw new Error(`[persistence] ${label} descriptor changed while read`);
    }
    const afterPath = lstatNoFollow(
      normalizedPath,
      `${label} after read`,
      operations,
    );
    if (!sameDescriptor(regularFileDescriptor(afterPath), beforeDescriptor)) {
      throw new Error(
        `[persistence] ${label} path identity changed while read`,
      );
    }
  } finally {
    if (descriptor !== undefined) operations.closeSync(descriptor);
  }
  return {
    path: normalizedPath,
    descriptor: Object.freeze(fileDescriptor),
    bytes,
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

function captureExactFileAuthority(
  file,
  expectedBytes,
  label,
  operations = fs,
) {
  const observed = readRegularFileNoFollow(file, label, operations);
  if (!observed.bytes.equals(Buffer.from(expectedBytes))) {
    throw new Error(`[persistence] ${label} bytes differ`);
  }
  return Object.freeze({
    path: observed.path,
    descriptor: observed.descriptor,
    byteLength: observed.byteLength,
    sha256: observed.sha256,
  });
}

function assertExactFileAuthority(
  authority,
  expectedBytes,
  label,
  operations = fs,
) {
  const observed = captureExactFileAuthority(
    authority.path,
    expectedBytes,
    label,
    operations,
  );
  if (!sameDescriptor(observed.descriptor, authority.descriptor)) {
    throw new Error(`[persistence] ${label} descriptor authority differs`);
  }
  return observed;
}

function inspectOptionalRegularFile(file, label, operations = fs) {
  try {
    operations.lstatSync(file, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "absent" };
    throw new Error(
      `[persistence] ${label} no-follow lstat failed: ${String(error?.message ?? error)}`,
      { cause: error },
    );
  }
  return {
    state: "present",
    ...readRegularFileNoFollow(file, label, operations),
  };
}

function inspectDensePriorFinalBytes(bytes) {
  const source = Buffer.from(bytes);
  let value;
  try {
    value = JSON.parse(source.toString("utf8"));
  } catch {
    throw new Error("[persistence] dense prior latest is not valid JSON");
  }
  if (!jsonBytes(value).equals(source)) {
    throw new Error("[persistence] dense prior latest is not canonical JSON");
  }
  const schemaVersion =
    value?.schema === C12_29_S5_DENSE_SCHEMA
      ? 3
      : value?.schema === C12_29_S5_DENSE_SUPERSEDED_SCHEMA
        ? 2
        : value?.schema === C12_29_S5_DENSE_LEGACY_SCHEMA
          ? 1
          : null;
  if (
    schemaVersion === null ||
    value?.schemaVersion !== schemaVersion ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value?.runId ?? "",
    ) ||
    !["PASS", "FAIL", "ERROR", "STRUCTURAL"].includes(value?.status) ||
    value?.incomplete !== false ||
    value?.pass !== (value.status === "PASS") ||
    value?.exitCode !== exitCodeForC1229S5DenseStatus(value.status)
  ) {
    throw new Error(
      "[persistence] dense prior latest is not a finalized v1/v2/v3 envelope",
    );
  }
  const validation =
    schemaVersion === 3
      ? validateC1229S5DenseFinalArtifact(value)
      : schemaVersion === 2
        ? validateC1229S5DenseSupersededFinalArtifact(value)
        : validateC1229S5DenseLegacyFinalArtifact(value);
  if (!validation.valid) {
    throw new Error(
      `[persistence] dense prior latest is not valid finalized v${schemaVersion} evidence: ${validation.reasons.join("; ")}`,
    );
  }
  return { value, schemaVersion };
}

function preserveDenseSupersededLatest(paths, bytes, prior, operations = fs) {
  const receipt = path.join(
    paths.directory,
    `${artifactPrefix}.superseded-v${prior.schemaVersion}-${prior.value.runId}.json`,
  );
  let authority;
  try {
    authority = writeExclusive(receipt, bytes, operations);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    authority = captureExactFileAuthority(
      receipt,
      bytes,
      `existing dense v${prior.schemaVersion} supersession receipt`,
      operations,
    );
  }
  assertExactFileAuthority(
    authority,
    bytes,
    `dense v${prior.schemaVersion} supersession receipt`,
    operations,
  );
  return { path: receipt, authority };
}

function captureDensePredecessorAuthority(
  paths,
  bytes,
  prior,
  supersessionReceipt,
  boundReceiptAuthority,
  label,
  operations = fs,
  boundArchiveAuthority = null,
) {
  if (!prior) return null;
  const archivePath = path.join(paths.directory, `${prior.value.runId}.json`);
  const archive =
    boundArchiveAuthority ??
    captureExactFileAuthority(
      archivePath,
      bytes,
      `${label} predecessor archive`,
      operations,
    );
  const receipt =
    prior.schemaVersion < 3
      ? (boundReceiptAuthority ??
        captureExactFileAuthority(
          supersessionReceipt,
          bytes,
          `${label} predecessor supersession receipt`,
          operations,
        ))
      : null;
  assertExactFileAuthority(
    archive,
    bytes,
    `${label} predecessor archive`,
    operations,
  );
  if (receipt) {
    assertExactFileAuthority(
      receipt,
      bytes,
      `${label} predecessor supersession receipt`,
      operations,
    );
  }
  return Object.freeze({ archive, receipt });
}

function assertDensePredecessorAuthority(
  authority,
  bytes,
  label,
  operations = fs,
) {
  if (!authority) return;
  assertExactFileAuthority(
    authority.archive,
    bytes,
    `${label} predecessor archive`,
    operations,
  );
  if (authority.receipt) {
    assertExactFileAuthority(
      authority.receipt,
      bytes,
      `${label} predecessor supersession receipt`,
      operations,
    );
  }
}

function captureInitialFirstRedAuthority(paths, label, operations = fs) {
  const firstRed = inspectOptionalRegularFile(
    paths.firstRed,
    label,
    operations,
  );
  if (firstRed.state === "absent") {
    return Object.freeze({ state: "absent", path: paths.firstRed });
  }
  const prior = inspectDensePriorFinalBytes(firstRed.bytes);
  if (prior.value.status === "PASS") {
    throw new Error(`[persistence] ${label} is not red final evidence`);
  }
  const archivePath = path.join(paths.directory, `${prior.value.runId}.json`);
  const archive = captureExactFileAuthority(
    archivePath,
    firstRed.bytes,
    `${label} immutable archive`,
    operations,
  );
  return Object.freeze({
    state: "present",
    path: paths.firstRed,
    bytes: Buffer.from(firstRed.bytes),
    file: Object.freeze({
      path: firstRed.path,
      descriptor: firstRed.descriptor,
      byteLength: firstRed.byteLength,
      sha256: firstRed.sha256,
    }),
    archive,
    runId: prior.value.runId,
    schemaVersion: prior.schemaVersion,
  });
}

function assertFirstRedAuthority(authority, label, operations = fs) {
  if (authority.state === "absent") {
    requireAbsentNoFollow(authority.path, label, operations);
    return;
  }
  assertExactFileAuthority(
    authority.file,
    authority.bytes,
    `${label} first-red`,
    operations,
  );
  assertExactFileAuthority(
    authority.archive,
    authority.bytes,
    `${label} first-red immutable archive`,
    operations,
  );
}

function densePredecessorDescriptor(bytes, prior) {
  if (!prior) return null;
  return {
    schemaVersion: prior.schemaVersion,
    runId: prior.value.runId,
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
    immutableArchive: `${prior.value.runId}.json`,
    supersessionReceipt:
      prior.schemaVersion < 3
        ? `${artifactPrefix}.superseded-v${prior.schemaVersion}-${prior.value.runId}.json`
        : null,
  };
}

function createDensePublicationAuthority(
  runId,
  lockBytes,
  runningBytes,
  predecessorDescriptor,
  predecessorBytes,
  predecessorPrior,
  boundState,
) {
  const predecessor = predecessorDescriptor
    ? Object.freeze({
        ...predecessorDescriptor,
        bytesBase64: predecessorBytes.toString("base64"),
      })
    : null;
  const authority = Object.freeze({
    schema: C12_29_S5_DENSE_SCHEMA,
    kind: "c12-29-s5-dense-cost-publication-authority",
    runId,
    lockBytesBase64: lockBytes.toString("base64"),
    runningBytesBase64: runningBytes.toString("base64"),
    predecessor,
    paths: Object.freeze({ ...boundState.paths }),
    outputDirectoryDescriptor: boundState.directoryAuthority.descriptor,
  });
  densePublicationAuthorityState.set(authority, {
    ...boundState,
    lockBytes: Buffer.from(lockBytes),
    runningBytes: Buffer.from(runningBytes),
    predecessor:
      predecessorDescriptor === null
        ? null
        : {
            bytes: Buffer.from(predecessorBytes),
            prior: {
              schemaVersion: predecessorPrior.schemaVersion,
              value: { runId: predecessorPrior.value.runId },
            },
          },
  });
  return authority;
}

function decodeCanonicalBase64(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`[persistence] ${label} is absent`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw new Error(`[persistence] ${label} is not canonical base64`);
  }
  return bytes;
}

function assertSameCanonicalJson(actual, expected, label) {
  if (!jsonBytes(actual).equals(jsonBytes(expected))) {
    throw new Error(`[persistence] ${label} differs`);
  }
}

function inspectDensePublicationAuthority(paths, authority, operations = fs) {
  if (
    authority?.schema !== C12_29_S5_DENSE_SCHEMA ||
    authority?.kind !== "c12-29-s5-dense-cost-publication-authority" ||
    typeof authority?.runId !== "string"
  ) {
    throw new Error("[persistence] dense publication authority is invalid");
  }
  const retained = densePublicationAuthorityState.get(authority);
  if (!retained) {
    throw new Error(
      "[persistence] dense publication authority was not issued by begin",
    );
  }
  const normalizedPaths = normalizeDenseArtifactPaths(paths, authority.runId);
  for (const key of denseArtifactPathKeys) {
    if (
      normalizedPaths[key] !== retained.paths[key] ||
      authority.paths?.[key] !== retained.paths[key]
    ) {
      throw new Error(
        `[persistence] dense publication path authority differs at ${key}`,
      );
    }
  }
  assertSameCanonicalJson(
    authority.outputDirectoryDescriptor,
    retained.directoryAuthority.descriptor,
    "output directory descriptor authority",
  );
  assertDirectoryAuthority(
    retained.directoryAuthority,
    "dense output directory",
    operations,
  );
  assertDirectoryAuthority(
    retained.rawDirectoryAuthority,
    "dense raw directory",
    operations,
  );
  const lockBytes = decodeCanonicalBase64(
    authority.lockBytesBase64,
    "dense lock byte authority",
  );
  const runningBytes = decodeCanonicalBase64(
    authority.runningBytesBase64,
    "dense RUNNING byte authority",
  );
  if (
    !lockBytes.equals(retained.lockBytes) ||
    !runningBytes.equals(retained.runningBytes)
  ) {
    throw new Error(
      "[persistence] retained publication byte authority differs",
    );
  }
  let lock;
  let running;
  try {
    lock = JSON.parse(lockBytes.toString("utf8"));
    running = JSON.parse(runningBytes.toString("utf8"));
  } catch (error) {
    throw new Error("[persistence] dense publication authority is not JSON", {
      cause: error,
    });
  }
  if (
    !jsonBytes(lock).equals(lockBytes) ||
    !jsonBytes(running).equals(runningBytes)
  ) {
    throw new Error(
      "[persistence] dense publication authority bytes are not canonical JSON",
    );
  }
  if (
    lock?.runId !== authority.runId ||
    running?.runId !== authority.runId ||
    path.basename(paths.immutable) !== `${authority.runId}.json`
  ) {
    throw new Error("[persistence] dense publication authority run differs");
  }

  let predecessor = null;
  if (running.predecessorAuthority === null) {
    if (authority.predecessor !== null || retained.predecessor !== null) {
      throw new Error(
        "[persistence] unexpected dense predecessor byte authority",
      );
    }
  } else {
    const predecessorBytes = decodeCanonicalBase64(
      authority.predecessor?.bytesBase64,
      "dense predecessor byte authority",
    );
    if (
      retained.predecessor === null ||
      !predecessorBytes.equals(retained.predecessor.bytes)
    ) {
      throw new Error(
        "[persistence] retained predecessor byte authority differs",
      );
    }
    const prior = retained.predecessor.prior;
    const descriptor = densePredecessorDescriptor(predecessorBytes, prior);
    const suppliedDescriptor = { ...authority.predecessor };
    delete suppliedDescriptor.bytesBase64;
    assertSameCanonicalJson(
      running.predecessorAuthority,
      descriptor,
      "RUNNING predecessor descriptor authority",
    );
    assertSameCanonicalJson(
      suppliedDescriptor,
      descriptor,
      "returned predecessor descriptor authority",
    );
    predecessor = {
      bytes: predecessorBytes,
      prior,
      receipt:
        descriptor.supersessionReceipt === null
          ? null
          : path.join(paths.directory, descriptor.supersessionReceipt),
      descriptor,
    };
  }

  assertExactFileAuthority(
    retained.lockAuthority,
    lockBytes,
    "owned RUNNING lock authority",
    operations,
  );
  assertExactFileAuthority(
    retained.runningReceiptAuthority,
    runningBytes,
    "immutable RUNNING receipt authority",
    operations,
  );
  assertExactFileAuthority(
    retained.runningLatestAuthority,
    runningBytes,
    "canonical RUNNING latest authority",
    operations,
  );
  if (predecessor) {
    assertDensePredecessorAuthority(
      retained.predecessorFileAuthority,
      predecessor.bytes,
      "publication",
      operations,
    );
  }
  assertFirstRedAuthority(
    retained.initialFirstRedAuthority,
    "initial first-red publication authority",
    operations,
  );
  return {
    lock,
    lockBytes,
    running,
    runningBytes,
    predecessor,
    retained,
    paths: normalizedPaths,
  };
}

function assertDensePublicationAuthorityRetained(
  retained,
  runningBytes,
  predecessor,
  firstRedAuthority,
  label,
  operations = fs,
) {
  assertDirectoryAuthority(
    retained.directoryAuthority,
    `${label} output directory`,
    operations,
  );
  assertDirectoryAuthority(
    retained.rawDirectoryAuthority,
    `${label} raw directory`,
    operations,
  );
  assertExactFileAuthority(
    retained.lockAuthority,
    retained.lockBytes,
    `${label} RUNNING lock authority`,
    operations,
  );
  assertExactFileAuthority(
    retained.runningReceiptAuthority,
    runningBytes,
    `${label} immutable RUNNING receipt authority`,
    operations,
  );
  if (predecessor) {
    assertDensePredecessorAuthority(
      retained.predecessorFileAuthority,
      predecessor.bytes,
      label,
      operations,
    );
  }
  assertFirstRedAuthority(firstRedAuthority, `${label} first-red`, operations);
}

function readBytes(file, operations = fs) {
  const value = operations.readFileSync(file);
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function writeExclusive(file, bytes, operations = fs) {
  const normalizedPath = path.resolve(file);
  const expected = Buffer.from(bytes);
  let descriptor;
  try {
    descriptor = operations.openSync(
      normalizedPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR,
      0o600,
    );
    operations.writeFileSync(descriptor, expected);
    operations.fsyncSync(descriptor);
    const created = operations.fstatSync(descriptor, { bigint: true });
    if (
      !created.isFile() ||
      statValue(created, "nlink") !== "1" ||
      statValue(created, "size") !== String(expected.byteLength)
    ) {
      throw new Error(
        `[persistence] ${normalizedPath} exclusive descriptor shape differs`,
      );
    }
    const createdDescriptor = regularFileDescriptor(created);
    const observed = readRegularFileNoFollow(
      normalizedPath,
      `${normalizedPath} exclusive write`,
      operations,
    );
    if (
      !observed.bytes.equals(expected) ||
      !sameDescriptor(observed.descriptor, createdDescriptor)
    ) {
      throw new Error(
        `[persistence] ${normalizedPath} differs from exclusive descriptor authority`,
      );
    }
    return Object.freeze({
      path: normalizedPath,
      descriptor: observed.descriptor,
      byteLength: observed.byteLength,
      sha256: observed.sha256,
    });
  } finally {
    if (descriptor !== undefined) operations.closeSync(descriptor);
  }
}

function deleteExactFileAuthority(
  authority,
  expectedBytes,
  label,
  operations = fs,
) {
  const expected = Buffer.from(expectedBytes);
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let descriptor;
  let unlinkError = null;
  let deleted = false;
  let result;
  let failure = null;
  try {
    const before = lstatNoFollow(
      authority.path,
      `${label} before descriptor delete`,
      operations,
    );
    const beforeDescriptor = regularFileDescriptor(before);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      statValue(before, "nlink") !== "1" ||
      !sameDescriptor(beforeDescriptor, authority.descriptor)
    ) {
      throw new Error(`[persistence] ${label} deletion authority differs`);
    }
    descriptor = operations.openSync(
      authority.path,
      fs.constants.O_RDONLY | noFollow,
    );
    const opened = operations.fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      !sameDescriptor(regularFileDescriptor(opened), authority.descriptor)
    ) {
      throw new Error(
        `[persistence] ${label} opened deletion descriptor differs`,
      );
    }
    const value = operations.readFileSync(descriptor);
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (!bytes.equals(expected)) {
      throw new Error(`[persistence] ${label} deletion bytes differ`);
    }
    const beforeUnlink = operations.fstatSync(descriptor, { bigint: true });
    const pathBeforeUnlink = lstatNoFollow(
      authority.path,
      `${label} at deletion boundary`,
      operations,
    );
    if (
      !sameDescriptor(
        regularFileDescriptor(beforeUnlink),
        authority.descriptor,
      ) ||
      !sameDescriptor(
        regularFileDescriptor(pathBeforeUnlink),
        authority.descriptor,
      )
    ) {
      throw new Error(`[persistence] ${label} changed at deletion boundary`);
    }
    try {
      operations.unlinkSync(authority.path);
    } catch (error) {
      unlinkError = error;
    }
    const afterUnlink = operations.fstatSync(descriptor, { bigint: true });
    if (
      statValue(afterUnlink, "dev") !== authority.descriptor.dev ||
      statValue(afterUnlink, "ino") !== authority.descriptor.ino ||
      statValue(afterUnlink, "mode") !== authority.descriptor.mode ||
      statValue(afterUnlink, "size") !== authority.descriptor.size ||
      statValue(afterUnlink, "birthtimeNs") !==
        authority.descriptor.birthtimeNs ||
      statValue(afterUnlink, "nlink") !== "0"
    ) {
      throw aggregatePersistence(`${label} descriptor deletion failed`, [
        unlinkError,
        new Error(`[persistence] ${label} opened descriptor was not unlinked`),
      ]);
    }
    deleted = true;
    result = { deleted: true, unlinkError };
  } catch (error) {
    failure = error;
  }
  if (descriptor !== undefined) {
    try {
      operations.closeSync(descriptor);
    } catch (error) {
      if (!deleted && failure === null) failure = error;
    }
  }
  if (failure) throw failure;
  return result;
}

function requireOwnedLock(paths, lockBytes, operations = fs) {
  const observed = readRegularFileNoFollow(
    paths.lock,
    "dense lock ownership",
    operations,
  );
  if (!observed.bytes.equals(lockBytes))
    throw new Error("[persistence] dense lock ownership differs");
}

function assertExactBytes(file, expectedBytes, label, operations = fs) {
  const observed = readBytes(file, operations);
  if (!observed.equals(Buffer.from(expectedBytes))) {
    throw new Error(`[persistence] ${label} bytes differ`);
  }
  return observed;
}

function restoreClaimedBytes(file, claimedBytes, label, operations = fs) {
  try {
    createImmutableEvidence(file, claimedBytes, operations);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  assertExactBytes(file, claimedBytes, label, operations);
}

function aggregatePersistence(label, errors) {
  return new AggregateError(
    errors.filter(Boolean),
    `[persistence] ${label}: ${errors
      .filter(Boolean)
      .map((error) => error?.message ?? String(error))
      .join(" | ")}`,
  );
}

export function replaceC1229S5DenseLatestOwned(
  paths,
  bytes,
  lockBytes,
  tag,
  expectedPriorBytes = undefined,
  operations = fs,
  boundPriorAuthority = null,
  boundLockAuthority = null,
) {
  const assertOwnedLock = (label) => {
    if (boundLockAuthority) {
      assertExactFileAuthority(
        boundLockAuthority,
        lockBytes,
        `dense ${label} lock authority`,
        operations,
      );
    } else {
      requireOwnedLock(paths, lockBytes, operations);
    }
  };
  assertOwnedLock("latest replacement entry");
  const replacement = Buffer.from(bytes);
  const priorReceipt = `${paths.latest}.${tag}-${randomUUID()}.receipt`;
  requireAbsentNoFollow(
    priorReceipt,
    "dense prior latest receipt before claim",
    operations,
  );
  let expected = null;
  let priorAuthority = null;
  if (expectedPriorBytes === null) {
    requireAbsentNoFollow(
      paths.latest,
      "canonical latest before exclusive creation",
      operations,
    );
  } else if (expectedPriorBytes !== undefined) {
    expected = Buffer.from(expectedPriorBytes);
    priorAuthority = captureExactFileAuthority(
      paths.latest,
      expected,
      "canonical latest before owned claim",
      operations,
    );
  } else {
    const observed = inspectOptionalRegularFile(
      paths.latest,
      "dense canonical latest at claim",
      operations,
    );
    if (observed.state === "present") {
      expected = Buffer.from(observed.bytes);
      priorAuthority = Object.freeze({
        path: observed.path,
        descriptor: observed.descriptor,
        byteLength: observed.byteLength,
        sha256: observed.sha256,
      });
    }
  }
  if (
    boundPriorAuthority &&
    (!priorAuthority ||
      !sameDescriptor(
        priorAuthority.descriptor,
        boundPriorAuthority.descriptor,
      ))
  ) {
    throw new Error("[persistence] canonical latest bound authority differs");
  }

  if (expected === null) {
    assertOwnedLock("latest exclusive creation pre-write");
    const authority = writeExclusive(paths.latest, replacement, operations);
    assertOwnedLock("latest exclusive creation post-write");
    assertExactFileAuthority(
      authority,
      replacement,
      "exclusive canonical latest",
      operations,
    );
    return { mode: "exclusive-create", receipt: null, authority };
  }

  let claimedAuthority = null;
  let claimedBytes = null;
  let replacementAuthority = null;
  try {
    assertOwnedLock("latest claim pre-rename");
    let renameError = null;
    try {
      operations.renameSync(paths.latest, priorReceipt);
    } catch (error) {
      renameError = error;
    }
    let claimed;
    try {
      claimed = readRegularFileNoFollow(
        priorReceipt,
        "dense claimed prior latest",
        operations,
      );
    } catch (claimError) {
      if (renameError) {
        try {
          assertExactFileAuthority(
            priorAuthority,
            expected,
            "canonical latest after failed claim rename",
            operations,
          );
        } catch (authorityError) {
          throw aggregatePersistence(
            "latest claim rename failed with uncertain authority",
            [renameError, claimError, authorityError],
          );
        }
        throw renameError;
      }
      throw claimError;
    }
    claimedBytes = Buffer.from(claimed.bytes);
    claimedAuthority = Object.freeze({
      path: claimed.path,
      descriptor: claimed.descriptor,
      byteLength: claimed.byteLength,
      sha256: claimed.sha256,
    });
    if (
      !claimedBytes.equals(expected) ||
      !sameFileObject(claimedAuthority.descriptor, priorAuthority.descriptor)
    ) {
      const ownershipError = new Error(
        "[persistence] dense claimed prior latest ownership differs",
      );
      try {
        assertExactFileAuthority(
          priorAuthority,
          expected,
          "canonical latest retained after hostile claim",
          operations,
        );
      } catch (authorityError) {
        throw aggregatePersistence(
          "latest claim captured foreign or uncertain authority",
          [renameError, ownershipError, authorityError],
        );
      }
      throw aggregatePersistence("latest claim was not owned", [
        renameError,
        ownershipError,
      ]);
    }
    // A throwing rename hook may report failure after the owned rename has
    // completed. Exact descriptor identity at the unique receipt is the
    // authoritative outcome; continuing avoids touching a concurrent latest.
    assertOwnedLock("latest claim post-rename");
    requireAbsentNoFollow(
      paths.latest,
      "canonical latest after owned claim",
      operations,
    );
    assertOwnedLock("latest replacement pre-write");
    replacementAuthority = writeExclusive(
      paths.latest,
      replacement,
      operations,
    );
    assertExactFileAuthority(
      claimedAuthority,
      expected,
      "retained prior latest receipt",
      operations,
    );
    assertExactFileAuthority(
      replacementAuthority,
      replacement,
      "exclusive canonical replacement",
      operations,
    );
    assertOwnedLock("latest prior receipt pre-delete");
    deleteExactFileAuthority(
      claimedAuthority,
      expected,
      "retained prior latest receipt",
      operations,
    );
    assertExactFileAuthority(
      replacementAuthority,
      replacement,
      "canonical replacement after receipt deletion",
      operations,
    );
    assertOwnedLock("latest replacement return");
    return {
      mode: "receipt-exclusive-replace",
      receipt: priorReceipt,
      authority: replacementAuthority,
    };
  } catch (error) {
    if (
      claimedBytes &&
      claimedAuthority &&
      priorAuthority &&
      claimedBytes.equals(expected) &&
      sameFileObject(claimedAuthority.descriptor, priorAuthority.descriptor) &&
      replacementAuthority === null
    ) {
      try {
        restoreClaimedBytes(
          paths.latest,
          claimedBytes,
          "canonical latest restored after failed replacement",
          operations,
        );
      } catch (restoreError) {
        throw aggregatePersistence(
          "latest replacement failed and exact claim could not be restored",
          [error, restoreError],
        );
      }
    }
    throw error;
  }
}

export function releaseC1229S5DenseOwnedLock(
  paths,
  lockBytes,
  operations = fs,
  verifyRetainedAuthority = () => {},
  boundLockAuthority = null,
) {
  const lockAuthority =
    boundLockAuthority ??
    captureExactFileAuthority(
      paths.lock,
      lockBytes,
      "dense RUNNING lock release authority",
      operations,
    );
  assertExactFileAuthority(
    lockAuthority,
    lockBytes,
    "dense RUNNING lock before release linearization",
    operations,
  );
  const receipt = `${paths.lock}.release-${randomUUID()}.receipt`;
  requireAbsentNoFollow(
    receipt,
    "dense lock release receipt before linearization",
    operations,
  );
  assertExactFileAuthority(
    lockAuthority,
    lockBytes,
    "dense RUNNING lock at release linearization",
    operations,
  );
  verifyRetainedAuthority("at lock release linearization");
  let renameError = null;
  try {
    operations.renameSync(paths.lock, receipt);
  } catch (error) {
    renameError = error;
  }
  let observedReceipt;
  try {
    observedReceipt = readRegularFileNoFollow(
      receipt,
      "dense linearized lock receipt",
      operations,
    );
  } catch (receiptError) {
    const failure = aggregatePersistence(
      "lock release rename outcome could not be proved from its receipt",
      [renameError, receiptError],
    );
    failure.denseLockLinearized = true;
    throw failure;
  }
  const receiptAuthority = Object.freeze({
    path: observedReceipt.path,
    descriptor: observedReceipt.descriptor,
    byteLength: observedReceipt.byteLength,
    sha256: observedReceipt.sha256,
  });
  if (
    !observedReceipt.bytes.equals(lockBytes) ||
    !sameFileObject(receiptAuthority.descriptor, lockAuthority.descriptor)
  ) {
    const ownershipError = new Error(
      "[persistence] linearized lock receipt ownership differs",
    );
    try {
      writeExclusive(paths.lock, observedReceipt.bytes, operations);
    } catch (restoreError) {
      const failure = aggregatePersistence(
        "hostile release rename captured authority that could not be restored exclusively",
        [renameError, ownershipError, restoreError],
      );
      failure.denseLockLinearized = true;
      throw failure;
    }
    const failure = aggregatePersistence("lock release receipt was not owned", [
      renameError,
      ownershipError,
    ]);
    failure.denseLockLinearized = true;
    throw failure;
  }
  try {
    deleteExactFileAuthority(
      receiptAuthority,
      lockBytes,
      "dense linearized lock receipt",
      operations,
    );
  } catch (error) {
    error.denseLockLinearized = true;
    throw error;
  }
  return {
    receipt,
    claimedByteLength: lockBytes.byteLength,
    linearization: "owned-lock-to-receipt-rename",
  };
}

export function beginC1229S5DenseRun(paths, runId, operations = fs) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      runId,
    )
  ) {
    throw new Error("[persistence] dense runId must be UUID-v4");
  }
  paths = normalizeDenseArtifactPaths(paths, runId);
  operations.mkdirSync(paths.directory, { recursive: true });
  const directoryAuthority = captureDirectoryAuthority(
    paths.directory,
    "dense output directory at begin",
    operations,
  );
  const lock = {
    schema: C12_29_S5_DENSE_SCHEMA,
    kind: "c12-29-s5-dense-cost-running-lock",
    runId,
    nonce: randomUUID(),
    status: "RUNNING",
    incomplete: true,
    startedAt: new Date().toISOString(),
  };
  const lockBytes = jsonBytes(lock);
  const lockAuthority = writeExclusive(paths.lock, lockBytes, operations);
  assertDirectoryAuthority(
    directoryAuthority,
    "dense output directory after lock creation",
    operations,
  );
  assertExactFileAuthority(
    lockAuthority,
    lockBytes,
    "dense lock at exclusive creation boundary",
    operations,
  );
  let running;
  let runningBytes = null;
  let runningAuthorityEstablished = false;
  try {
    const priorLatest = inspectOptionalRegularFile(
      paths.latest,
      "dense prior latest",
      operations,
    );
    let priorBytes = null;
    let prior = null;
    let supersessionReceipt = null;
    let supersessionReceiptAuthority = null;
    let priorLatestAuthority = null;
    let predecessorFileAuthority = null;
    if (priorLatest.state === "present") {
      priorBytes = Buffer.from(priorLatest.bytes);
      priorLatestAuthority = Object.freeze({
        path: priorLatest.path,
        descriptor: priorLatest.descriptor,
        byteLength: priorLatest.byteLength,
        sha256: priorLatest.sha256,
      });
      prior = inspectDensePriorFinalBytes(priorBytes);
      assertDirectoryAuthority(
        directoryAuthority,
        "dense output directory before predecessor archive bind",
        operations,
      );
      assertExactFileAuthority(
        lockAuthority,
        lockBytes,
        "dense lock before predecessor archive bind",
        operations,
      );
      const predecessorArchiveAuthority = captureExactFileAuthority(
        path.join(paths.directory, `${prior.value.runId}.json`),
        priorBytes,
        "begin predecessor archive",
        operations,
      );
      if (prior.schemaVersion < 3) {
        assertDirectoryAuthority(
          directoryAuthority,
          "dense output directory before predecessor receipt",
          operations,
        );
        assertExactFileAuthority(
          lockAuthority,
          lockBytes,
          "dense lock before predecessor receipt",
          operations,
        );
        const supersession = preserveDenseSupersededLatest(
          paths,
          priorBytes,
          prior,
          operations,
        );
        supersessionReceipt = supersession.path;
        supersessionReceiptAuthority = supersession.authority;
        assertDirectoryAuthority(
          directoryAuthority,
          "dense output directory after predecessor receipt",
          operations,
        );
        assertExactFileAuthority(
          lockAuthority,
          lockBytes,
          "dense lock after predecessor receipt",
          operations,
        );
      }
      predecessorFileAuthority = captureDensePredecessorAuthority(
        paths,
        priorBytes,
        prior,
        supersessionReceipt,
        supersessionReceiptAuthority,
        "begin",
        operations,
        predecessorArchiveAuthority,
      );
    }
    if (priorLatestAuthority) {
      assertExactFileAuthority(
        priorLatestAuthority,
        priorBytes,
        "dense prior latest after parse",
        operations,
      );
    } else {
      requireAbsentNoFollow(
        paths.latest,
        "dense prior latest after absence observation",
        operations,
      );
    }
    const initialFirstRedAuthority = captureInitialFirstRedAuthority(
      paths,
      "dense initial first-red",
      operations,
    );
    assertDirectoryAuthority(
      directoryAuthority,
      "dense output directory before RUNNING receipt",
      operations,
    );
    assertExactFileAuthority(
      lockAuthority,
      lockBytes,
      "dense lock before RUNNING receipt",
      operations,
    );
    assertDensePredecessorAuthority(
      predecessorFileAuthority,
      priorBytes,
      "before RUNNING receipt",
      operations,
    );
    assertFirstRedAuthority(
      initialFirstRedAuthority,
      "initial first-red before RUNNING receipt",
      operations,
    );
    const predecessorDescriptor = densePredecessorDescriptor(priorBytes, prior);
    running = {
      schema: C12_29_S5_DENSE_SCHEMA,
      schemaVersion: 3,
      runId,
      status: "RUNNING",
      incomplete: true,
      pass: null,
      exitCode: null,
      startedAt: lock.startedAt,
      predecessorAuthority: predecessorDescriptor,
      lifecycle: {
        lockCreatedExclusively: true,
        runningReceiptCreatedExclusively: true,
        runningLatestPublishedBeforeLaunch: true,
      },
    };
    runningBytes = jsonBytes(running);
    const runningReceiptAuthority = writeExclusive(
      paths.runningReceipt,
      runningBytes,
      operations,
    );
    assertExactFileAuthority(
      runningReceiptAuthority,
      runningBytes,
      "RUNNING receipt at exclusive creation boundary",
      operations,
    );
    assertExactFileAuthority(
      lockAuthority,
      lockBytes,
      "dense lock post-running-receipt",
      operations,
    );
    assertDensePredecessorAuthority(
      predecessorFileAuthority,
      priorBytes,
      "post-running-receipt",
      operations,
    );
    assertFirstRedAuthority(
      initialFirstRedAuthority,
      "initial first-red post-running-receipt",
      operations,
    );
    const runningLatestPublication = replaceC1229S5DenseLatestOwned(
      paths,
      runningBytes,
      lockBytes,
      "running",
      priorBytes,
      operations,
      priorLatestAuthority,
      lockAuthority,
    );
    runningAuthorityEstablished = true;
    const runningLatestAuthority = runningLatestPublication.authority;
    assertExactFileAuthority(
      lockAuthority,
      lockBytes,
      "dense lock post-latest-replacement",
      operations,
    );
    assertExactFileAuthority(
      runningReceiptAuthority,
      runningBytes,
      "RUNNING receipt post-latest-replacement",
      operations,
    );
    assertDensePredecessorAuthority(
      predecessorFileAuthority,
      priorBytes,
      "post-latest-replacement",
      operations,
    );
    assertFirstRedAuthority(
      initialFirstRedAuthority,
      "initial first-red post-latest-replacement",
      operations,
    );
    operations.mkdirSync(paths.rawDirectory, { recursive: false });
    const rawDirectoryAuthority = captureDirectoryAuthority(
      paths.rawDirectory,
      "dense raw directory",
      operations,
    );
    assertDirectoryAuthority(
      directoryAuthority,
      "dense output directory pre-return",
      operations,
    );
    assertExactFileAuthority(
      lockAuthority,
      lockBytes,
      "dense lock pre-return",
      operations,
    );
    assertExactFileAuthority(
      runningReceiptAuthority,
      runningBytes,
      "RUNNING receipt pre-return",
      operations,
    );
    assertExactFileAuthority(
      runningLatestAuthority,
      runningBytes,
      "RUNNING latest pre-return",
      operations,
    );
    assertDensePredecessorAuthority(
      predecessorFileAuthority,
      priorBytes,
      "pre-return",
      operations,
    );
    assertFirstRedAuthority(
      initialFirstRedAuthority,
      "initial first-red pre-return",
      operations,
    );
    const boundState = {
      paths,
      directoryAuthority,
      rawDirectoryAuthority,
      lockAuthority,
      runningReceiptAuthority,
      runningLatestAuthority,
      predecessorFileAuthority,
      initialFirstRedAuthority,
    };
    const publicationAuthority = createDensePublicationAuthority(
      runId,
      lockBytes,
      runningBytes,
      predecessorDescriptor,
      priorBytes,
      prior,
      boundState,
    );
    return { lock, lockBytes, running, runningBytes, publicationAuthority };
  } catch (error) {
    if (!runningAuthorityEstablished && runningBytes !== null) {
      try {
        assertExactBytes(
          paths.latest,
          runningBytes,
          "canonical RUNNING latest after begin failure",
          operations,
        );
        runningAuthorityEstablished = true;
      } catch {
        // A failed pre-publication start releases only exact owned authority.
      }
    }
    if (!runningAuthorityEstablished) {
      try {
        releaseC1229S5DenseOwnedLock(
          paths,
          lockBytes,
          operations,
          () => {},
          lockAuthority,
        );
      } catch {
        // Preserve the acquisition error and any uncertain/foreign authority.
      }
    }
    throw error;
  }
}

function recoverDenseOwnedLock(lockAuthority, lockBytes, operations) {
  try {
    assertExactFileAuthority(
      lockAuthority,
      lockBytes,
      "dense lock descriptor authority at recovery",
      operations,
    );
    return { ok: true, method: "descriptor-retained" };
  } catch (error) {
    return { ok: false, method: "foreign-or-unverifiable", error };
  }
}

function recoverDenseRunningLatest(
  paths,
  runningBytes,
  finalBytes,
  lockBytes,
  operations,
  lockAuthority,
  finalLatestAuthority,
  immutableAuthority,
) {
  try {
    assertExactFileAuthority(
      lockAuthority,
      lockBytes,
      "dense recovery lock authority",
      operations,
    );
    assertExactFileAuthority(
      immutableAuthority,
      finalBytes,
      "dense recovery immutable authority",
      operations,
    );
    assertExactFileAuthority(
      finalLatestAuthority,
      finalBytes,
      "dense recovery final latest authority",
      operations,
    );
    const recovered = replaceC1229S5DenseLatestOwned(
      paths,
      runningBytes,
      lockBytes,
      "running-recovery",
      finalBytes,
      operations,
      finalLatestAuthority,
      lockAuthority,
    );
    assertExactFileAuthority(
      lockAuthority,
      lockBytes,
      "dense recovery lock authority after latest restore",
      operations,
    );
    assertExactFileAuthority(
      immutableAuthority,
      finalBytes,
      "dense recovery immutable authority after latest restore",
      operations,
    );
    assertExactFileAuthority(
      recovered.authority,
      runningBytes,
      "restored descriptor-bound RUNNING latest",
      operations,
    );
    return { ok: true, method: "descriptor-exclusive-recovery" };
  } catch (error) {
    return {
      ok: false,
      method: "descriptor-exclusive-recovery-failed",
      error,
    };
  }
}

function verifyFirstRedWriteOnce(paths, bytes, operations) {
  const observed = inspectOptionalRegularFile(
    paths.firstRed,
    "dense first-red before preserve",
    operations,
  );
  const before =
    observed.state === "absent"
      ? { exists: false, byteLength: null, sha256: null, error: "ENOENT" }
      : {
          exists: true,
          byteLength: observed.byteLength,
          sha256: observed.sha256,
          error: null,
        };
  const written = observed.state === "absent";
  const authority = written
    ? writeExclusive(paths.firstRed, bytes, operations)
    : Object.freeze({
        path: observed.path,
        descriptor: observed.descriptor,
        byteLength: observed.byteLength,
        sha256: observed.sha256,
      });
  const expected = written ? bytes : observed.bytes;
  assertExactFileAuthority(
    authority,
    expected,
    "dense first-red after preserve",
    operations,
  );
  const after = {
    exists: true,
    byteLength: authority.byteLength,
    sha256: authority.sha256,
    error: null,
  };
  return { before, after, written, verified: true, authority };
}

function bindPublishedFirstRedAuthority(
  paths,
  bytes,
  immutableAuthority,
  initialAuthority,
  retained,
  operations = fs,
) {
  if (initialAuthority.state === "present") {
    if (retained.written !== false) {
      throw new Error("[persistence] existing first-red was not retained");
    }
    assertFirstRedAuthority(
      initialAuthority,
      "retained initial first-red",
      operations,
    );
    return initialAuthority;
  }
  if (retained.written !== true) {
    throw new Error("[persistence] new first-red was not created exclusively");
  }
  const file = captureExactFileAuthority(
    retained.authority.path,
    bytes,
    "new first-red",
    operations,
  );
  if (!sameDescriptor(file.descriptor, retained.authority.descriptor)) {
    throw new Error("[persistence] new first-red descriptor authority differs");
  }
  assertExactFileAuthority(
    immutableAuthority,
    bytes,
    "new first-red backing immutable archive",
    operations,
  );
  return Object.freeze({
    state: "present",
    path: paths.firstRed,
    bytes: Buffer.from(bytes),
    file,
    archive: immutableAuthority,
    runId: path.basename(paths.immutable, ".json"),
    schemaVersion: 3,
  });
}

export function publishC1229S5DenseFinal(
  paths,
  publicationAuthority,
  report,
  operations = fs,
) {
  const inspected = inspectDensePublicationAuthority(
    paths,
    publicationAuthority,
    operations,
  );
  const { lock, lockBytes, running, runningBytes, predecessor, retained } =
    inspected;
  paths = inspected.paths;
  if (
    lock?.schema !== C12_29_S5_DENSE_SCHEMA ||
    lock?.kind !== "c12-29-s5-dense-cost-running-lock" ||
    lock?.status !== "RUNNING" ||
    lock?.incomplete !== true ||
    running?.schema !== C12_29_S5_DENSE_SCHEMA ||
    running?.status !== "RUNNING" ||
    running?.incomplete !== true ||
    running?.runId !== lock.runId ||
    report?.runId !== lock.runId ||
    !["PASS", "FAIL", "ERROR", "STRUCTURAL"].includes(report?.status) ||
    report?.incomplete === true ||
    path.basename(paths.immutable) !== `${report.runId}.json`
  ) {
    throw new Error(
      "[persistence] final artifact does not own the exact RUNNING identity",
    );
  }
  let activeFirstRedAuthority = retained.initialFirstRedAuthority;
  assertDensePublicationAuthorityRetained(
    retained,
    runningBytes,
    predecessor,
    activeFirstRedAuthority,
    "pre-publication",
    operations,
  );
  assertExactFileAuthority(
    retained.runningLatestAuthority,
    runningBytes,
    "pre-publication canonical RUNNING latest",
    operations,
  );
  const bytes = jsonBytes(report);
  const immutableAuthority = writeExclusive(paths.immutable, bytes, operations);
  assertDensePublicationAuthorityRetained(
    retained,
    runningBytes,
    predecessor,
    activeFirstRedAuthority,
    "post-immutable",
    operations,
  );
  assertExactFileAuthority(
    retained.runningLatestAuthority,
    runningBytes,
    "post-immutable canonical RUNNING latest",
    operations,
  );
  assertExactFileAuthority(
    immutableAuthority,
    bytes,
    "post-immutable dense run archive",
    operations,
  );
  let firstRed = { applicable: false, verified: true };
  if (report.status !== "PASS") {
    firstRed = {
      applicable: true,
      ...verifyFirstRedWriteOnce(paths, bytes, operations),
    };
    activeFirstRedAuthority = bindPublishedFirstRedAuthority(
      paths,
      bytes,
      immutableAuthority,
      activeFirstRedAuthority,
      firstRed,
      operations,
    );
  }
  assertDensePublicationAuthorityRetained(
    retained,
    runningBytes,
    predecessor,
    activeFirstRedAuthority,
    "post-first-red",
    operations,
  );
  assertExactFileAuthority(
    retained.runningLatestAuthority,
    runningBytes,
    "post-first-red canonical RUNNING latest",
    operations,
  );
  assertExactFileAuthority(
    immutableAuthority,
    bytes,
    "post-first-red immutable run",
    operations,
  );
  let finalLatestAuthority = null;
  try {
    const finalLatestPublication = replaceC1229S5DenseLatestOwned(
      paths,
      bytes,
      lockBytes,
      "final",
      runningBytes,
      operations,
      retained.runningLatestAuthority,
      retained.lockAuthority,
    );
    finalLatestAuthority = finalLatestPublication.authority;
    assertDensePublicationAuthorityRetained(
      retained,
      runningBytes,
      predecessor,
      activeFirstRedAuthority,
      "post-final-latest",
      operations,
    );
    assertExactFileAuthority(
      immutableAuthority,
      bytes,
      "post-final-latest immutable run",
      operations,
    );
    assertExactFileAuthority(
      finalLatestAuthority,
      bytes,
      "post-final-latest canonical final latest",
      operations,
    );
    const receipt = {
      schema: C12_29_S5_DENSE_SCHEMA,
      kind: "c12-29-s5-dense-cost-final-receipt",
      runId: report.runId,
      status: report.status,
      incomplete: false,
      immutable: {
        path: paths.immutable.replaceAll("\\", "/"),
        byteLength: bytes.byteLength,
        sha256: sha256(bytes),
      },
      firstRed: {
        applicable: firstRed.applicable,
        written: firstRed.written ?? null,
        beforeSha256: firstRed.before?.sha256 ?? null,
        afterSha256: firstRed.after?.sha256 ?? null,
        writeOnceFingerprintVerified: firstRed.verified === true,
      },
      latestByteIdentical: true,
      predecessorAuthority: running.predecessorAuthority,
    };
    const receiptBytes = jsonBytes(receipt);
    const finalReceiptAuthority = writeExclusive(
      paths.finalReceipt,
      receiptBytes,
      operations,
    );
    assertDensePublicationAuthorityRetained(
      retained,
      runningBytes,
      predecessor,
      activeFirstRedAuthority,
      "post-final-receipt",
      operations,
    );
    assertExactFileAuthority(
      immutableAuthority,
      bytes,
      "post-final-receipt immutable run",
      operations,
    );
    assertExactFileAuthority(
      finalLatestAuthority,
      bytes,
      "post-final-receipt canonical final latest",
      operations,
    );
    assertExactFileAuthority(
      finalReceiptAuthority,
      receiptBytes,
      "post-final-receipt final receipt",
      operations,
    );
    const verifyFinalAuthority = (label) => {
      assertDensePublicationAuthorityRetained(
        retained,
        runningBytes,
        predecessor,
        activeFirstRedAuthority,
        label,
        operations,
      );
      assertExactFileAuthority(
        immutableAuthority,
        bytes,
        `${label} immutable dense run`,
        operations,
      );
      assertExactFileAuthority(
        finalLatestAuthority,
        bytes,
        `${label} canonical final latest`,
        operations,
      );
      assertExactFileAuthority(
        finalReceiptAuthority,
        receiptBytes,
        `${label} final receipt`,
        operations,
      );
    };
    verifyFinalAuthority("pre-release-linearization");
    releaseC1229S5DenseOwnedLock(
      paths,
      lockBytes,
      operations,
      verifyFinalAuthority,
      retained.lockAuthority,
    );
    return receipt;
  } catch (error) {
    if (error?.denseLockLinearized === true) throw error;
    try {
      assertExactFileAuthority(
        retained.lockAuthority,
        lockBytes,
        "publication recovery owned lock",
        operations,
      );
      if (finalLatestAuthority === null) {
        assertExactFileAuthority(
          retained.runningLatestAuthority,
          runningBytes,
          "publication recovery RUNNING latest",
          operations,
        );
        throw error;
      }
      assertExactFileAuthority(
        finalLatestAuthority,
        bytes,
        "publication recovery owned final latest",
        operations,
      );
    } catch (authorityError) {
      if (authorityError === error) throw error;
      throw aggregatePersistence(
        "publication recovery refused unowned descriptor authority",
        [error, authorityError],
      );
    }
    const lockRecovery = recoverDenseOwnedLock(
      retained.lockAuthority,
      lockBytes,
      operations,
    );
    const latestRecovery = recoverDenseRunningLatest(
      paths,
      runningBytes,
      bytes,
      lockBytes,
      operations,
      retained.lockAuthority,
      finalLatestAuthority,
      immutableAuthority,
    );
    const failures = [
      lockRecovery.ok ? null : lockRecovery.error,
      latestRecovery.ok ? null : latestRecovery.error,
    ].filter(Boolean);
    if (failures.length === 0) throw error;
    const recoveryError = aggregatePersistence(
      `final publication failed; descriptor recovery lock=${lockRecovery.ok} latest=${latestRecovery.ok}`,
      [error, ...failures],
    );
    recoveryError.code = "C12_29_S5_DENSE_PUBLICATION_RECOVERY";
    recoveryError.denseRecovery = {
      lock: { ok: lockRecovery.ok, method: lockRecovery.method },
      latest: { ok: latestRecovery.ok, method: latestRecovery.method },
      quarantine: { ok: null, method: "not-permitted-with-bound-authority" },
    };
    throw recoveryError;
  }
}

export function childProcessResult(
  args,
  timeoutMs,
  postKillCloseTimeoutMs = C12_29_S5_DENSE_CONFIG.postKillCloseTimeoutMs,
) {
  return new Promise((resolve) => {
    const launchId = randomUUID();
    const child = spawn(process.execPath, args, {
      cwd: repositoryRoot,
      stdio: ["ignore", "ignore", "inherit"],
      windowsHide: true,
    });
    let timedOut = false;
    let settled = false;
    let postKillTimer;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(postKillTimer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32") {
        const killer = spawn(
          "taskkill",
          ["/pid", String(child.pid), "/T", "/F"],
          {
            stdio: "ignore",
            windowsHide: true,
          },
        );
        killer.unref();
      } else {
        child.kill("SIGKILL");
      }
      postKillTimer = setTimeout(() => {
        child.unref();
        settle({
          exitCode: null,
          signal: "WATCHDOG",
          timedOut: true,
          childProcessId: child.pid,
          launchId,
          error: `child did not close within ${postKillCloseTimeoutMs}ms after termination`,
        });
      }, postKillCloseTimeoutMs);
      postKillTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.once("close", (exitCode, signal) => {
      settle({
        exitCode,
        signal,
        timedOut,
        childProcessId: child.pid,
        launchId,
      });
    });
    child.once("error", (error) => {
      settle({
        exitCode: null,
        signal: null,
        timedOut,
        childProcessId: child.pid,
        launchId,
        error: String(error),
      });
    });
  });
}

async function measureDenseLegInPage(contract) {
  const helper = await import(
    new URL(
      "/Tools/visual-regression/lib/c12-29-s5-dense-cost-gate.mjs",
      location.origin,
    ).href
  );
  const C = await import("/Build/CesiumUnminified/index.js");
  const viewer = globalThis.viewer;
  const scene = viewer?.scene;
  const globe = scene?.globe;
  const context = scene?._context;
  if (!viewer || !scene || !globe || !context) {
    throw new Error("[structural] Cesium Viewer scene did not initialize");
  }
  const actualRenderer = context.isWebGPU ? "webgpu" : "webgl";
  if (actualRenderer !== contract.scheduleLeg.renderer) {
    throw new Error(
      `[structural] requested ${contract.scheduleLeg.renderer}, got ${actualRenderer}`,
    );
  }
  const lighting = globe.atmosphericConditions?.lighting;
  if (
    !lighting ||
    !("enableEclipse" in lighting) ||
    !("enableEclipseGlobeShadow" in lighting)
  ) {
    throw new Error("[structural] eclipse lighting controls are unavailable");
  }

  const fixedTime = C.JulianDate.fromIso8601(
    contract.workload.protocol.fixedClock,
  );
  const original = {
    useDefaultRenderLoop: viewer.useDefaultRenderLoop,
    resolutionScale: viewer.resolutionScale,
    shouldAnimate: viewer.clock.shouldAnimate,
    currentTime: C.JulianDate.clone(viewer.clock.currentTime),
    requestRenderMode: scene.requestRenderMode,
    terrainProvider: globe.terrainProvider,
    maximumScreenSpaceError: globe.maximumScreenSpaceError,
    tileCacheSize: globe.tileCacheSize,
    enableLighting: globe.enableLighting,
    enableEclipse: lighting.enableEclipse,
    enableEclipseGlobeShadow: lighting.enableEclipseGlobeShadow,
    timestampProfiling:
      context.performanceManager?.config?.timestampProfiling ?? null,
  };
  const featureSnapshot = () => ({
    highDynamicRange: scene.highDynamicRange ?? null,
    sunBloom: scene.sunBloom ?? null,
    taaEnabled: scene.taaEnabled ?? null,
    motionBlur: scene.motionBlur ?? null,
    msaaSamples: scene.msaaSamples ?? null,
    fogEnabled: scene.fog?.enabled ?? null,
    skyAtmosphereShown: scene.skyAtmosphere?.show ?? null,
    skyBoxShown: scene.skyBox?.show ?? null,
    sunShown: scene.sun?.show ?? null,
    moonShown: scene.moon?.show ?? null,
    globeShown: globe.show ?? null,
    groundAtmosphereShown: globe.showGroundAtmosphere ?? null,
    waterEffectShown: globe.showWaterEffect ?? null,
    imageryLayerCount: viewer.imageryLayers.length,
    postProcessStageCount: scene.postProcessStages?.length ?? null,
    fxaaEnabled: scene.postProcessStages?.fxaa?.enabled ?? null,
    bloomEnabled: scene.postProcessStages?.bloom?.enabled ?? null,
  });
  const defaultFeaturesAtStart = featureSnapshot();
  const errors = { gpu: [], deviceLost: false };
  const onGpuError = (event) =>
    errors.gpu.push(event?.error?.message ?? String(event?.error ?? event));
  context.device?.addEventListener?.("uncapturederror", onGpuError);
  if (context.device?.lost) {
    void context.device.lost.then(() => {
      errors.deviceLost = true;
    });
  }

  let longTaskObserver = null;
  let longTaskObserverDisconnected;
  let conditionRestored;
  let timestampWrapperRestored = actualRenderer === "webgl";
  let timestampProfilingRestored = actualRenderer === "webgl";
  let timestampRestore = null;
  let viewerDestroyed;
  let result;
  const restoreTimestampWrapper = () => {
    if (!timestampRestore) return null;
    const restore = timestampRestore;
    timestampRestore = null;
    try {
      return restore();
    } catch (error) {
      timestampWrapperRestored = false;
      errors.gpu.push(
        `timestamp wrapper restoration: ${error?.message ?? String(error)}`,
      );
      return {
        installed: true,
        restored: false,
        originalIdentityRestored: false,
      };
    }
  };
  const restoreTimestampProfiling = () => {
    if (actualRenderer !== "webgpu") return;
    if (context.performanceManager?.config) {
      context.performanceManager.config.timestampProfiling =
        original.timestampProfiling;
      timestampProfilingRestored =
        context.performanceManager.config.timestampProfiling ===
        original.timestampProfiling;
    } else {
      timestampProfilingRestored = false;
    }
  };

  const setCondition = (condition) => {
    lighting.enableEclipse = true;
    lighting.enableEclipseGlobeShadow = condition === "active";
  };
  const applyRoute = (sample) => {
    scene.camera.setView({
      destination: C.Cartesian3.fromDegrees(
        sample.longitude,
        sample.latitude,
        sample.height,
      ),
      orientation: {
        heading: C.Math.toRadians(sample.heading),
        pitch: C.Math.toRadians(sample.pitch),
        roll: C.Math.toRadians(sample.roll),
      },
    });
  };
  const renderFixed = () => {
    scene.requestRender();
    scene.render(fixedTime);
  };
  const yieldFrame = () =>
    new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
  const boundedAwait = async (promise, timeoutMs, label) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`[structural] ${label} timed out`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const routeObservation = (expected) => {
    const actual = scene.camera.positionCartographic;
    return {
      ...expected,
      actual: {
        longitude: C.Math.toDegrees(actual.longitude),
        latitude: C.Math.toDegrees(actual.latitude),
        height: actual.height,
        heading: C.Math.toDegrees(scene.camera.heading),
        pitch: C.Math.toDegrees(scene.camera.pitch),
        roll: C.Math.toDegrees(scene.camera.roll),
      },
    };
  };

  try {
    viewer.useDefaultRenderLoop = false;
    viewer.resolutionScale = 1;
    viewer.clock.shouldAnimate = false;
    viewer.clock.currentTime = C.JulianDate.clone(fixedTime);
    scene.requestRenderMode = true;
    globe.maximumScreenSpaceError =
      contract.workload.scene.maximumScreenSpaceError;
    globe.tileCacheSize = contract.workload.scene.tileCacheSize;
    globe.enableLighting = true;
    const terrain = helper.createC1229S5DenseTerrain(
      C,
      contract.workload.terrain,
    );
    globe.terrainProvider = terrain.provider;
    const sentinel = helper.deriveC1229S5DenseSentinel(contract.workload.route);
    const waterMask = helper.createC1229S5DenseWaterMask();
    const waterMaskDigest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", waterMask),
    );
    const waterMaskSha256 = [...waterMaskDigest]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");

    const seenSentinel = new Set();
    const sentinelSet = new Set(sentinel.keys);
    const variants = [];
    for (const condition of ["active", "inactive"]) {
      setCondition(condition);
      for (
        let index = 0;
        index < contract.workload.protocol.measuredFrames;
        index++
      ) {
        const sample = helper.sampleC1229S5DenseRoute(
          contract.workload.route,
          index,
          contract.workload.protocol.measuredFrames,
        );
        applyRoute(sample);
        renderFixed();
        const frame = helper.inspectC1229S5DenseTerrainFrame(scene, terrain);
        for (const key of frame.ownRealMeshKeys) {
          if (sentinelSet.has(key)) seenSentinel.add(key);
        }
        await Promise.resolve();
        if (index % 16 === 15)
          await new Promise((resolveTick) => setTimeout(resolveTick, 0));
      }
      variants.push({
        condition,
        frameCount: contract.workload.protocol.measuredFrames,
      });
    }

    setCondition(contract.scheduleLeg.condition);
    let settledFrames = 0;
    let priorTerrain = terrain.snapshot();
    const settleDeadline =
      performance.now() + contract.workload.protocol.settleTimeoutMs;
    while (
      settledFrames < contract.workload.protocol.settleStableFrames &&
      performance.now() < settleDeadline
    ) {
      const end = helper.sampleC1229S5DenseRoute(
        contract.workload.route,
        contract.workload.protocol.measuredFrames - 1,
        contract.workload.protocol.measuredFrames,
      );
      applyRoute(end);
      renderFixed();
      await yieldFrame();
      const nextTerrain = terrain.snapshot();
      const delta = helper.diffC1229S5DenseTerrainDiagnostics(
        priorTerrain,
        nextTerrain,
      );
      const quiescent =
        delta.requestCount === 0 &&
        delta.generationCount === 0 &&
        globe.tilesLoaded === true;
      settledFrames = quiescent ? settledFrames + 1 : 0;
      priorTerrain = nextTerrain;
    }

    const prime = {
      variants,
      settledFrames,
      sentinel,
      // Preserve the sentinel's derived row-major authority. Lexicographic
      // sorting groups by x before y and cannot equal the frozen row-major
      // transcript even when all 64 keys were observed.
      seenOwnRealSentinelKeys: sentinel.keys.filter((key) =>
        seenSentinel.has(key),
      ),
      waterMask: {
        width: waterMask.length ** 0.5,
        values: [...new Set(waterMask)].sort((a, b) => a - b),
        pattern: contract.workload.terrain.waterMaskPattern,
        sha256: waterMaskSha256,
      },
    };
    const measuredCondition = {
      enableEclipse: lighting.enableEclipse,
      enableEclipseGlobeShadow: lighting.enableEclipseGlobeShadow,
    };

    const longTaskEntries = [];
    const longTaskSupported =
      typeof PerformanceObserver === "function" &&
      PerformanceObserver.supportedEntryTypes?.includes("longtask") === true;
    if (longTaskSupported) {
      longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTaskEntries.push({
            startTime: entry.startTime,
            duration: entry.duration,
          });
        }
      });
      longTaskObserver.observe({ type: "longtask", buffered: true });
    }

    const gpuSamples = [];
    let gpu =
      actualRenderer === "webgl"
        ? {
            applicability: "N/A",
            reason: "WebGL has no WebGPU timestamp-query lane",
            attemptedFrameCount: 0,
            samples: [],
          }
        : null;
    if (actualRenderer === "webgpu") {
      const featureAvailable = context.hasFeature?.("timestamp-query") === true;
      if (!featureAvailable) {
        gpu = {
          applicability: "mandatory",
          timestampFeatureAvailable: false,
          armed: false,
          fullFrameOnly: true,
          wrapper: {
            installed: false,
            restored: true,
            originalIdentityRestored: true,
          },
          samples: [],
          summary: null,
          drain: null,
          results: null,
        };
      } else {
        globalThis.CesiumDebug?.gpuPassCost?.(true);
        const profiler = context.timestampProfiler;
        const hadOwn = Object.hasOwn(profiler, "_addToRollingWindow");
        const ownDescriptor = Object.getOwnPropertyDescriptor(
          profiler,
          "_addToRollingWindow",
        );
        const originalFunction = profiler._addToRollingWindow;
        const frameArray = profiler._frameTimings;
        const wrapper = function (array, value) {
          if (array === frameArray) gpuSamples.push(value);
          return originalFunction.call(this, array, value);
        };
        timestampRestore = () => {
          if (hadOwn) {
            Object.defineProperty(
              profiler,
              "_addToRollingWindow",
              ownDescriptor,
            );
          } else {
            delete profiler._addToRollingWindow;
          }
          timestampWrapperRestored =
            profiler._addToRollingWindow === originalFunction;
          return {
            installed: profiler !== null && wrapper !== originalFunction,
            restored: timestampWrapperRestored,
            originalIdentityRestored: timestampWrapperRestored,
          };
        };
        profiler._addToRollingWindow = wrapper;
      }
    }

    const terrainStart = terrain.snapshot();
    let priorAnimationFrameMs = await yieldFrame();
    const measurementStartMs = priorAnimationFrameMs;
    const measuredRoute = [];
    const measuredFrames = [];
    const measuredTraceSamples = [];
    let explicitMeasuredRenders = 0;
    try {
      for (
        let index = 0;
        index < contract.workload.protocol.measuredFrames;
        index++
      ) {
        const expected = helper.sampleC1229S5DenseRoute(
          contract.workload.route,
          index,
          contract.workload.protocol.measuredFrames,
        );
        applyRoute(expected);
        scene.requestRender();
        const cpuStart = performance.now();
        scene.render(fixedTime);
        const cpuMs = performance.now() - cpuStart;
        explicitMeasuredRenders++;
        const frame = {
          frameIndex: index,
          ...helper.inspectC1229S5DenseTerrainFrame(scene, terrain),
        };
        measuredRoute.push(routeObservation(expected));
        measuredFrames.push(frame);
        const animationFrameMs = await yieldFrame();
        measuredTraceSamples.push({
          frameNumber: scene.frameState.frameNumber,
          relFrame: index,
          wallDtMs: animationFrameMs - priorAnimationFrameMs,
          cpuMs,
          drawCount: frame.logicalDrawCount,
          commandCount: frame.commandCount,
          snapshotFrozen: false,
        });
        priorAnimationFrameMs = animationFrameMs;
      }
      if (
        actualRenderer === "webgpu" &&
        gpu?.timestampFeatureAvailable !== false
      ) {
        await boundedAwait(
          context.device.queue.onSubmittedWorkDone(),
          contract.workload.protocol.gpuReadbackTimeoutMs,
          "WebGPU submitted-work drain",
        );
        const profiler = context.timestampProfiler;
        const drain = await boundedAwait(
          profiler.drainPendingReadbacks(
            contract.workload.protocol.gpuReadbackTimeoutMs,
          ),
          contract.workload.protocol.gpuReadbackTimeoutMs + 1_000,
          "WebGPU timestamp readback drain",
        );
        const results = profiler.getResults();
        const wrapper = restoreTimestampWrapper();
        restoreTimestampProfiling();
        gpu = {
          applicability: "mandatory",
          timestampFeatureAvailable: true,
          armed: results.enabled === true,
          fullFrameOnly: true,
          wrapper,
          samples: [...gpuSamples],
          summary: helper.summarizeC1229S5DenseSamples(gpuSamples),
          drain,
          results: {
            enabled: results.enabled,
            attemptedFrameCount: results.attemptedFrameCount,
            frameCount: results.frameCount,
            readbackSkipCount: results.readbackSkipCount,
            failedReadbackCount: results.failedReadbackCount,
            lostSampleCount: results.lostSampleCount,
            pendingReadbackCount: results.pendingReadbackCount,
            unaccountedSampleCount: results.unaccountedSampleCount,
            invertedSampleCount: results.invertedSampleCount,
            droppedPassCount: results.droppedPassCount,
            emptyFrameCount: results.emptyFrameCount,
            sampleLedgerBalanced: results.sampleLedgerBalanced,
          },
        };
      }
    } finally {
      if (timestampRestore) {
        const wrapper = restoreTimestampWrapper();
        if (gpu) gpu.wrapper = wrapper;
        restoreTimestampProfiling();
      }
    }
    const measurementEndMs = priorAnimationFrameMs;
    await new Promise((resolveObserver) => setTimeout(resolveObserver, 0));
    for (const entry of longTaskObserver?.takeRecords?.() ?? []) {
      longTaskEntries.push({
        startTime: entry.startTime,
        duration: entry.duration,
      });
    }
    longTaskObserver?.disconnect();
    longTaskObserverDisconnected = true;
    const selectedLongTasks = helper.selectC1229S5DenseLongTasks(
      longTaskEntries,
      measurementStartMs,
      measurementEndMs,
    );
    const longTaskDuration = selectedLongTasks.reduce(
      (sum, entry) => sum + entry.duration,
      0,
    );
    const measurementDuration = measurementEndMs - measurementStartMs;
    const terrainEnd = terrain.snapshot();
    const measurement = {
      frameCount: explicitMeasuredRenders,
      route: measuredRoute,
      frames: measuredFrames,
      trace: { samples: measuredTraceSamples },
      cpuSummary: helper.summarizeC1229S5DenseSamples(
        measuredTraceSamples.map((sample) => sample.cpuMs),
      ),
      framePacing: {
        semantics: contract.workload.protocol.refreshSemantics,
        requestAnimationFrameYieldCount: measuredTraceSamples.length,
        elapsedMs: measuredTraceSamples.reduce(
          (sum, sample) => sum + sample.wallDtMs,
          0,
        ),
        wallSummary: helper.summarizeC1229S5DenseSamples(
          measuredTraceSamples.map((sample) => sample.wallDtMs),
        ),
      },
      longTasks: {
        observerAvailable: longTaskSupported,
        entries: selectedLongTasks,
        measurementStartMs,
        measurementEndMs,
        totalDurationMs: longTaskDuration,
        measurementDurationMs: measurementDuration,
        share: longTaskDuration / measurementDuration,
      },
      terrainActivity: {
        start: terrainStart,
        end: terrainEnd,
        delta: helper.diffC1229S5DenseTerrainDiagnostics(
          terrainStart,
          terrainEnd,
        ),
      },
    };

    const replayRoute = [];
    const replayFrames = [];
    const replayTraceSamples = [];
    for (
      let index = 0;
      index < contract.workload.protocol.measuredFrames;
      index++
    ) {
      const expected = helper.sampleC1229S5DenseRoute(
        contract.workload.route,
        index,
        contract.workload.protocol.measuredFrames,
      );
      applyRoute(expected);
      renderFixed();
      const frame = {
        frameIndex: index,
        ...helper.inspectC1229S5DenseTerrainFrame(scene, terrain),
      };
      replayRoute.push(routeObservation(expected));
      replayFrames.push(frame);
      replayTraceSamples.push({
        frameNumber: scene.frameState.frameNumber,
        relFrame: index,
        wallDtMs: null,
        cpuMs: 0,
        drawCount: frame.logicalDrawCount,
        commandCount: frame.commandCount,
        snapshotFrozen: false,
      });
      await Promise.resolve();
    }
    const projection = (route, frames, trace) => ({
      route,
      selection: frames.map((frame) => ({
        selectedKeys: frame.selectedKeys,
        realMeshKeys: frame.realMeshKeys,
        ownRealMeshKeys: frame.ownRealMeshKeys,
        fillMeshKeys: frame.fillMeshKeys,
      })),
      draw: trace.map((sample) => sample.drawCount),
      command: trace.map((sample) => sample.commandCount),
    });
    const measuredProjection = projection(
      measurement.route,
      measurement.frames,
      measurement.trace.samples,
    );
    const replayProjection = projection(
      replayRoute,
      replayFrames,
      replayTraceSamples,
    );
    const replay = {
      timed: false,
      frameCount: replayFrames.length,
      route: replayRoute,
      frames: replayFrames,
      trace: { samples: replayTraceSamples },
      alignment: {
        camera:
          helper.stableC1229S5DenseJson(measuredProjection.route) ===
          helper.stableC1229S5DenseJson(replayProjection.route),
        selection:
          helper.stableC1229S5DenseJson(measuredProjection.selection) ===
          helper.stableC1229S5DenseJson(replayProjection.selection),
        draw:
          helper.stableC1229S5DenseJson(measuredProjection.draw) ===
          helper.stableC1229S5DenseJson(replayProjection.draw),
        command:
          helper.stableC1229S5DenseJson(measuredProjection.command) ===
          helper.stableC1229S5DenseJson(replayProjection.command),
      },
    };

    setCondition("active");
    const counterfactualExpected = helper.sampleC1229S5DenseRoute(
      contract.workload.route,
      Math.floor(contract.workload.protocol.measuredFrames / 2),
      contract.workload.protocol.measuredFrames,
    );
    applyRoute(counterfactualExpected);
    renderFixed();
    const counterfactualFrame = helper.inspectC1229S5DenseTerrainFrame(
      scene,
      terrain,
    );
    const counterfactual = {
      timed: false,
      frameIndex: Math.floor(contract.workload.protocol.measuredFrames / 2),
      enableEclipse: lighting.enableEclipse,
      enableEclipseGlobeShadow: lighting.enableEclipseGlobeShadow,
      gate: counterfactualFrame.gate,
      selectedKeys: counterfactualFrame.selectedKeys,
      ownRealMeshKeys: counterfactualFrame.ownRealMeshKeys,
    };
    const defaultFeaturesAtEnd = featureSnapshot();

    const adapterInfo = context.adapter?.info
      ? {
          vendor: context.adapter.info.vendor || "",
          architecture: context.adapter.info.architecture || "",
          device: context.adapter.info.device || "",
          description: context.adapter.info.description || "",
        }
      : null;
    const rendererString = context.getRendererString?.() ?? "";
    const adapterParts = adapterInfo
      ? Object.values(adapterInfo).filter(
          (value) => typeof value === "string" && value.length > 0,
        )
      : [];
    result = {
      browserData: {
        userAgent: navigator.userAgent,
        viewport: {
          width: innerWidth,
          height: innerHeight,
          deviceScaleFactor: devicePixelRatio,
        },
        canvas: {
          clientWidth: scene.canvas.clientWidth,
          clientHeight: scene.canvas.clientHeight,
          width: scene.canvas.width,
          height: scene.canvas.height,
          drawingBufferWidth: context.drawingBufferWidth ?? scene.canvas.width,
          drawingBufferHeight:
            context.drawingBufferHeight ?? scene.canvas.height,
          resolutionScale: viewer.resolutionScale,
        },
      },
      renderer: {
        requested: contract.scheduleLeg.renderer,
        actual: actualRenderer,
        rendererString,
        adapterInfo,
        gpuIdentityComplete:
          actualRenderer === "webgl"
            ? rendererString.length > 0
            : adapterParts.length > 0,
      },
      configuration: {
        fixedClock: C.JulianDate.toIso8601(viewer.clock.currentTime),
        shouldAnimate: viewer.clock.shouldAnimate,
        maximumScreenSpaceError: globe.maximumScreenSpaceError,
        tileCacheSize: globe.tileCacheSize,
        globeLighting: globe.enableLighting,
        defaultFeaturesRetained:
          JSON.stringify(defaultFeaturesAtStart) ===
          JSON.stringify(defaultFeaturesAtEnd),
        defaultFeatureSnapshot: defaultFeaturesAtStart,
        defaultFeatureSnapshotEnd: defaultFeaturesAtEnd,
        requestRenderMode: scene.requestRenderMode,
        explicitMeasuredRenders,
        enableEclipse: measuredCondition.enableEclipse,
        enableEclipseGlobeShadow: measuredCondition.enableEclipseGlobeShadow,
      },
      prime,
      measurement,
      replay,
      counterfactual,
      gpu,
      errors: { gpu: [...errors.gpu], deviceLost: errors.deviceLost },
      cleanup: {
        viewerDestroyed: false,
        timestampWrapperRestored,
        timestampProfilingRestored,
        longTaskObserverDisconnected,
        conditionRestored: false,
      },
    };
  } finally {
    restoreTimestampWrapper();
    if (actualRenderer === "webgpu") {
      restoreTimestampProfiling();
    }
    longTaskObserver?.disconnect();
    longTaskObserverDisconnected = true;
    context.device?.removeEventListener?.("uncapturederror", onGpuError);
    lighting.enableEclipse = original.enableEclipse;
    lighting.enableEclipseGlobeShadow = original.enableEclipseGlobeShadow;
    globe.enableLighting = original.enableLighting;
    globe.maximumScreenSpaceError = original.maximumScreenSpaceError;
    globe.tileCacheSize = original.tileCacheSize;
    globe.terrainProvider = original.terrainProvider;
    scene.requestRenderMode = original.requestRenderMode;
    viewer.clock.shouldAnimate = original.shouldAnimate;
    viewer.clock.currentTime = original.currentTime;
    viewer.resolutionScale = original.resolutionScale;
    viewer.useDefaultRenderLoop = original.useDefaultRenderLoop;
    conditionRestored =
      lighting.enableEclipse === original.enableEclipse &&
      lighting.enableEclipseGlobeShadow === original.enableEclipseGlobeShadow;
    if (!viewer.isDestroyed?.()) viewer.destroy();
    viewerDestroyed = viewer.isDestroyed?.() === true;
    if (result) {
      result.cleanup = {
        viewerDestroyed,
        timestampWrapperRestored,
        timestampProfilingRestored,
        longTaskObserverDisconnected,
        conditionRestored,
      };
    }
  }
  return result;
}

async function runLegChild(options) {
  const scheduleLeg = C12_29_S5_DENSE_SCHEDULE[options.legOrdinal - 1];
  if (
    !scheduleLeg ||
    !options.legOutput ||
    !options.runId ||
    !/^[0-9a-f]{64}$/i.test(options.sourceSha ?? "") ||
    !/^[0-9a-f]{64}$/i.test(options.prerequisitesSha ?? "") ||
    !/^[0-9a-f]{64}$/i.test(options.workloadSha ?? "")
  ) {
    throw new Error("[structural] incomplete internal dense leg invocation");
  }
  const baseIdentity = loopbackIdentity(options.base);
  const workloadBytes = fs.readFileSync(workloadPath);
  if (sha256(workloadBytes) !== options.workloadSha.toLowerCase()) {
    throw new Error("[structural] workload bytes changed before child launch");
  }
  const workload = JSON.parse(workloadBytes.toString("utf8"));
  const workloadValidation = validateC1229S5DenseWorkload(workload);
  if (!workloadValidation.valid) {
    throw new Error(`[structural] ${workloadValidation.reasons.join("; ")}`);
  }
  const startedAt = new Date().toISOString();
  const externalRequests = [];
  const failedRequests = [];
  const pageErrors = [];
  const consoleErrors = [];
  const dialogs = [];
  let browser;
  let runtime;
  let servedEntry;
  try {
    browser = await chromium.launch({
      channel: "msedge",
      headless: !options.headed,
      args: ["--enable-unsafe-webgpu"],
    });
    const browserVersion = browser.version();
    const context = await browser.newContext({
      viewport: {
        width: C12_29_S5_DENSE_CONFIG.viewport.width,
        height: C12_29_S5_DENSE_CONFIG.viewport.height,
      },
      deviceScaleFactor: C12_29_S5_DENSE_CONFIG.viewport.deviceScaleFactor,
    });
    const page = await context.newPage();
    let resolveEntry;
    let rejectEntry;
    const entryPromise = new Promise((resolve, reject) => {
      resolveEntry = resolve;
      rejectEntry = reject;
    });
    let entryCaptured = false;
    page.on("response", (response) => {
      let url;
      try {
        url = new URL(response.url());
      } catch {
        return;
      }
      if (
        !entryCaptured &&
        url.pathname === "/Build/CesiumUnminified/index.js"
      ) {
        entryCaptured = true;
        void response.body().then(
          (bytes) =>
            resolveEntry({
              ok: response.ok(),
              status: response.status(),
              byteLength: bytes.byteLength,
              sha256: sha256(bytes),
            }),
          rejectEntry,
        );
      }
    });
    page.on("request", (request) => {
      try {
        const url = new URL(request.url());
        if (
          ["http:", "https:"].includes(url.protocol) &&
          url.origin !== baseIdentity.origin
        ) {
          externalRequests.push(request.url());
        }
      } catch {
        externalRequests.push(request.url());
      }
    });
    page.on("requestfailed", (request) => {
      failedRequests.push({
        url: request.url(),
        error: request.failure()?.errorText ?? "unknown",
      });
    });
    page.on("pageerror", (error) =>
      pageErrors.push(String(error?.stack ?? error)),
    );
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("dialog", (dialog) => {
      dialogs.push({ type: dialog.type(), message: dialog.message() });
      void dialog.dismiss();
    });
    const viewerUrl = new URL(
      "/Apps/CesiumViewer/index.html",
      baseIdentity.origin,
    );
    viewerUrl.searchParams.set("renderer", scheduleLeg.renderer);
    viewerUrl.searchParams.set("offline", "true");
    await page.goto(viewerUrl.href, {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    await page.waitForFunction(
      () => Boolean(globalThis.viewer?.scene?._context),
      undefined,
      { timeout: 90_000 },
    );
    runtime = await page.evaluate(measureDenseLegInPage, {
      workload,
      scheduleLeg,
    });
    let entryTimeout;
    try {
      servedEntry = await Promise.race([
        entryPromise,
        new Promise((_, reject) => {
          entryTimeout = setTimeout(
            () =>
              reject(
                new Error(
                  "[structural] served entry response identity timed out",
                ),
              ),
            30_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(entryTimeout);
    }
    await page.close();
    await context.close();
    await browser.close();
    browser = null;

    const leg = {
      schema: C12_29_S5_DENSE_RUNTIME_SCHEMA,
      runId: options.runId,
      legId: c1229S5DenseLegId(scheduleLeg),
      scheduleLeg,
      sourceIdentitySha256: options.sourceSha.toLowerCase(),
      prerequisitesSha256: options.prerequisitesSha.toLowerCase(),
      workloadIdentity: {
        path: path.relative(repositoryRoot, workloadPath).replaceAll("\\", "/"),
        byteLength: workloadBytes.byteLength,
        sha256: options.workloadSha.toLowerCase(),
      },
      startedAt,
      completedAt: new Date().toISOString(),
      status: "PASS",
      incomplete: false,
      error: null,
      browser: {
        channel: "msedge",
        version: browserVersion,
        userAgent: runtime.browserData.userAgent,
        viewport: runtime.browserData.viewport,
        canvas: runtime.browserData.canvas,
      },
      renderer: runtime.renderer,
      servedEntry,
      transport: {
        externalRequests,
        failedRequests,
        pageErrors,
        consoleErrors,
        dialogs,
      },
      errors: runtime.errors,
      configuration: runtime.configuration,
      prime: runtime.prime,
      measurement: runtime.measurement,
      replay: runtime.replay,
      counterfactual: runtime.counterfactual,
      gpu: runtime.gpu,
      cleanup: runtime.cleanup,
    };
    const assessment = validateC1229S5DenseRuntimeLeg(leg, workload, {
      runId: options.runId,
      sourceIdentitySha256: options.sourceSha.toLowerCase(),
      prerequisitesSha256: options.prerequisitesSha.toLowerCase(),
      workloadSha256: options.workloadSha.toLowerCase(),
    });
    if (assessment.behavioral.length > 0) leg.status = "FAIL";
    if (assessment.errors.length > 0) leg.status = "ERROR";
    if (assessment.structural.length > 0) leg.status = "STRUCTURAL";
    leg.assessment = assessment;
    writeExclusive(options.legOutput, jsonBytes(leg));
    return exitCodeForC1229S5DenseStatus(leg.status);
  } catch (error) {
    try {
      await browser?.close();
    } catch {}
    const text = String(error?.stack ?? error);
    const structural = text.includes("[structural]");
    const leg = {
      schema: C12_29_S5_DENSE_RUNTIME_SCHEMA,
      runId: options.runId,
      legId: c1229S5DenseLegId(scheduleLeg),
      scheduleLeg,
      sourceIdentitySha256: options.sourceSha.toLowerCase(),
      prerequisitesSha256: options.prerequisitesSha.toLowerCase(),
      workloadIdentity: {
        path: path.relative(repositoryRoot, workloadPath).replaceAll("\\", "/"),
        byteLength: workloadBytes.byteLength,
        sha256: options.workloadSha.toLowerCase(),
      },
      startedAt,
      completedAt: new Date().toISOString(),
      status: structural ? "STRUCTURAL" : "ERROR",
      incomplete: false,
      error: text,
      browser: null,
      renderer: null,
      servedEntry: servedEntry ?? null,
      transport: {
        externalRequests,
        failedRequests,
        pageErrors,
        consoleErrors,
        dialogs,
      },
      errors: runtime?.errors ?? { gpu: [], deviceLost: false },
      configuration: runtime?.configuration ?? null,
      prime: runtime?.prime ?? null,
      measurement: runtime?.measurement ?? null,
      replay: runtime?.replay ?? null,
      counterfactual: runtime?.counterfactual ?? null,
      gpu: runtime?.gpu ?? null,
      cleanup: runtime?.cleanup ?? {
        viewerDestroyed: false,
        timestampWrapperRestored: false,
        timestampProfilingRestored: false,
        longTaskObserverDisconnected: false,
        conditionRestored: false,
      },
    };
    writeExclusive(options.legOutput, jsonBytes(leg));
    return structural ? 3 : 2;
  }
}

async function runCoordinator(options) {
  const runId = randomUUID();
  const paths = createC1229S5DenseArtifactPaths(options.outputDirectory, runId);
  const started = beginC1229S5DenseRun(paths, runId);
  const { running, publicationAuthority } = started;
  const workloadBytes = fs.readFileSync(workloadPath);
  const workload = JSON.parse(workloadBytes.toString("utf8"));
  const workloadValidation = validateC1229S5DenseWorkload(workload);
  const legs = [];
  let prerequisites = null;
  let prerequisitesSha256 = null;
  let start = null;
  let end = null;
  let pendingError = null;
  let published = false;
  try {
    if (!workloadValidation.valid) {
      throw new Error(`[structural] ${workloadValidation.reasons.join("; ")}`);
    }
    const baseIdentity = loopbackIdentity(options.base);
    start = await collectProvenanceSnapshot(baseIdentity);
    if (!start.ok) throw new Error(`[structural] ${start.reasons.join("; ")}`);
    prerequisites = loadPrerequisites(options);
    prerequisitesSha256 = sha256(
      Buffer.from(stableC1229S5DenseJson(prerequisites)),
    );
    const workloadSha256 = sha256(workloadBytes);
    for (const scheduleLeg of C12_29_S5_DENSE_SCHEDULE) {
      const legId = c1229S5DenseLegId(scheduleLeg);
      const rawPath = path.join(paths.rawDirectory, `${legId}.json`);
      console.error(
        `[c12-29-s5-dense] ${scheduleLeg.ordinal}/24 ${legId}: fresh Edge process`,
      );
      const child = await childProcessResult(
        [
          probePath,
          "--leg-ordinal",
          String(scheduleLeg.ordinal),
          "--leg-output",
          rawPath,
          "--run-id",
          runId,
          "--source-sha",
          start.identitySha256,
          "--prerequisites-sha",
          prerequisitesSha256,
          "--workload-sha",
          workloadSha256,
          "--base",
          baseIdentity.href,
          ...(options.headed ? ["--headed"] : []),
        ],
        workload.protocol.legTimeoutMs,
      );
      let leg;
      try {
        leg = readJson(rawPath);
      } catch (error) {
        leg = {
          schema: C12_29_S5_DENSE_RUNTIME_SCHEMA,
          runId,
          legId,
          scheduleLeg,
          status: "ERROR",
          incomplete: false,
          error: `raw leg unreadable: ${error?.message ?? error}`,
        };
      }
      leg.subprocess = child;
      legs.push(leg);
    }
    end = await collectProvenanceSnapshot(baseIdentity);
  } catch (error) {
    pendingError = String(error?.stack ?? error);
    try {
      end = await collectProvenanceSnapshot(loopbackIdentity(options.base));
    } catch (endError) {
      pendingError += `\nprovenance end: ${endError?.stack ?? endError}`;
    }
  }

  const lifecycle = {
    lockCreatedExclusively: true,
    runningReceiptCreatedExclusively: true,
    runningLatestPublishedBeforeLaunch: true,
    immutableRunCreatedExclusively: true,
    firstRedPreserved: pendingError !== null,
    firstRedFingerprintPolicy: "write-once-exact-sha256-byte-length",
    finalReceiptCreatedExclusively: true,
    latestEqualsImmutableRunBeforeUnlock: true,
    predecessorAuthorityBoundToRunningReceipt: true,
    publicationAuthorityReverifiedThroughUnlock: true,
    runningReceiptReverifiedThroughUnlock: true,
    lockReleasedByOwnedReceipt: true,
    publicationOrder: [
      "lock",
      "running-receipt",
      "running-latest",
      "immutable-run",
      "first-red",
      "final-latest",
      "final-receipt",
      "unlock",
    ],
  };
  const startValue = start ?? {
    ok: false,
    identitySha256: null,
    gitHead: null,
    localFiles: [],
    servedFiles: [],
    buildSourceIdentity: null,
    reasons: ["provenance start absent"],
  };
  const endValue = end ?? {
    ok: false,
    identitySha256: null,
    gitHead: null,
    localFiles: [],
    servedFiles: [],
    buildSourceIdentity: null,
    reasons: ["provenance end absent"],
  };
  const report = {
    schema: C12_29_S5_DENSE_SCHEMA,
    schemaVersion: 3,
    runId,
    status: "PASS",
    incomplete: false,
    pass: true,
    exitCode: 0,
    startedAt: running.startedAt,
    completedAt: new Date().toISOString(),
    workload: {
      path: path.relative(repositoryRoot, workloadPath).replaceAll("\\", "/"),
      byteLength: workloadBytes.byteLength,
      sha256: sha256(workloadBytes),
      value: workload,
    },
    prerequisites,
    prerequisitesSha256,
    provenance: {
      stable: sameProvenance(startValue, endValue),
      start: startValue,
      end: endValue,
    },
    legs,
    pendingError,
    assessment: null,
    lifecycle,
  };
  const assessment = foldC1229S5DenseCostGate(report);
  report.status = assessment.status;
  report.exitCode = assessment.exitCode;
  report.pass = assessment.pass;
  report.lifecycle.firstRedPreserved = report.status !== "PASS";
  report.assessment = foldC1229S5DenseCostGate(report);
  report.status = report.assessment.status;
  report.exitCode = report.assessment.exitCode;
  report.pass = report.assessment.pass;
  const finalValidation = validateC1229S5DenseFinalArtifact(report);
  if (!finalValidation.valid) {
    throw new Error(
      `[persistence] refusing invalid dense final artifact: ${finalValidation.reasons.join("; ")}`,
    );
  }
  try {
    publishC1229S5DenseFinal(paths, publicationAuthority, report);
    published = true;
  } finally {
    if (!published) {
      console.error(
        `[c12-29-s5-dense] publication failed; owned RUNNING lock retained at ${paths.lock}`,
      );
    }
  }
  console.log(JSON.stringify(report, null, 2));
  console.error(
    `C12-29 S5 dense ${report.status}: ${report.assessment?.structural?.length ?? 0} structural, ${report.assessment?.errors?.length ?? 0} errors, ${report.assessment?.behavioral?.length ?? 0} behavioral`,
  );
  return report.exitCode;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() ===
    path.resolve(probePath).toLowerCase()
) {
  const options = parseArguments(process.argv.slice(2));
  if (options.legOrdinal !== null) {
    process.exit(await runLegChild(options));
  } else {
    process.exitCode = await runCoordinator(options);
  }
}
