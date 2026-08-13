#!/usr/bin/env node
/**
 * C12-29 S5 dense ACTIVE/INACTIVE cost characterization.
 *
 * The coordinator launches 24 child Node processes in the frozen order. Each
 * child launches exactly one fresh Edge process, runs one 600-frame condition,
 * and exits. The probe requires already-certified terrain-v10 and NASA-SVS-v3
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
  c1229S5DenseLegId,
  exitCodeForC1229S5DenseStatus,
  foldC1229S5DenseCostGate,
  stableC1229S5DenseJson,
  validateC1229S5DenseFinalArtifact,
  validateC1229S5DenseLegacyFinalArtifact,
  validateC1229S5DensePrerequisites,
  validateC1229S5DenseRuntimeLeg,
  validateC1229S5DenseWorkload,
} from "./lib/c12-29-s5-dense-cost-gate.mjs";
import {
  assertEvidenceReadableOrAbsent,
  createImmutableEvidence,
  fingerprintEvidenceFile,
  inspectBuildSourceIdentity,
  preserveFirstRedEvidence,
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

const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex").toLowerCase();
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

function usage() {
  console.log(`Usage: node Tools/visual-regression/probe-c12-29-s5-dense-cost.mjs [options]

Required coordinator options:
  --terrain-publication FILE  Certified terrain-v10 publication manifest
  --nasa-publication FILE     Certified NASA-SVS-v3 publication manifest

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
      schema: "c12-29-s5-svs-5073-footprint-evidence-v3",
    }),
  };
  const validation = validateC1229S5DensePrerequisites(prerequisites);
  if (!validation.valid) {
    throw new Error(`[structural] ${validation.reasons.join("; ")}`);
  }
  return prerequisites;
}

export function createC1229S5DenseArtifactPaths(outputDirectory, runId) {
  return {
    directory: outputDirectory,
    immutable: path.join(outputDirectory, `${runId}.json`),
    latest: path.join(outputDirectory, `${artifactPrefix}.latest.json`),
    recoveryLatest: path.join(
      outputDirectory,
      `${runId}.publication-recovery-latest.json`,
    ),
    firstRed: path.join(outputDirectory, `${artifactPrefix}.first-red.json`),
    lock: path.join(outputDirectory, `${artifactPrefix}.lock.json`),
    runningReceipt: path.join(outputDirectory, `${runId}.running-receipt.json`),
    finalReceipt: path.join(outputDirectory, `${runId}.final-receipt.json`),
    rawDirectory: path.join(outputDirectory, `${runId}.legs`),
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
      "[persistence] dense prior latest is not a finalized v1/v2 envelope",
    );
  }
  const validation =
    schemaVersion === 1
      ? validateC1229S5DenseLegacyFinalArtifact(value)
      : validateC1229S5DenseFinalArtifact(value);
  if (!validation.valid) {
    throw new Error(
      `[persistence] dense prior latest is not valid finalized v${schemaVersion} evidence: ${validation.reasons.join("; ")}`,
    );
  }
  return { value, schemaVersion };
}

function preserveDenseLegacyV1Latest(paths, bytes, prior, operations = fs) {
  const receipt = path.join(
    paths.directory,
    `${artifactPrefix}.superseded-v1-${prior.runId}.json`,
  );
  try {
    writeExclusive(receipt, bytes, operations);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    assertExactBytes(
      receipt,
      bytes,
      "existing dense v1 supersession receipt",
      operations,
    );
  }
  assertExactBytes(receipt, bytes, "dense v1 supersession receipt", operations);
  return receipt;
}

function assertDensePriorRetained(
  paths,
  bytes,
  prior,
  legacyReceipt,
  label,
  operations = fs,
) {
  if (!prior) return;
  try {
    assertExactBytes(
      path.join(paths.directory, `${prior.value.runId}.json`),
      bytes,
      `${label} prior immutable v${prior.schemaVersion} archive`,
      operations,
    );
  } catch (error) {
    throw new Error(
      `[persistence] ${label} prior immutable v${prior.schemaVersion} archive is unavailable or differs: ${String(error?.message ?? error)}`,
      { cause: error },
    );
  }
  if (prior.schemaVersion === 1 && legacyReceipt !== null) {
    try {
      assertExactBytes(
        legacyReceipt,
        bytes,
        `${label} dense v1 supersession receipt`,
        operations,
      );
    } catch (error) {
      throw new Error(
        `[persistence] ${label} dense v1 supersession receipt is unavailable or differs: ${String(error?.message ?? error)}`,
        { cause: error },
      );
    }
  }
}

function readBytes(file, operations = fs) {
  const value = operations.readFileSync(file);
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function writeExclusive(file, bytes, operations = fs) {
  createImmutableEvidence(file, bytes, operations);
  const observed = readBytes(file, operations);
  if (!observed.equals(Buffer.from(bytes)))
    throw new Error(`[persistence] ${file} bytes differ after exclusive write`);
}

function requireOwnedLock(paths, lockBytes, operations = fs) {
  const observed = readBytes(paths.lock, operations);
  if (!observed.equals(lockBytes))
    throw new Error("[persistence] dense lock ownership differs");
}

function assertExactBytes(file, expectedBytes, label, operations = fs) {
  const observed = readBytes(file, operations);
  if (!observed.equals(Buffer.from(expectedBytes))) {
    throw new Error(`[persistence] ${label} bytes differ`);
  }
  return observed;
}

function sameFingerprint(left, right) {
  return (
    left?.exists === right?.exists &&
    left?.byteLength === right?.byteLength &&
    left?.sha256 === right?.sha256 &&
    left?.error === right?.error
  );
}

function requireAbsent(file, label, operations = fs) {
  const identity = fingerprintEvidenceFile(file, operations);
  assertEvidenceReadableOrAbsent(identity, label);
  if (identity.exists !== false || identity.error !== "ENOENT") {
    throw new Error(`[persistence] ${label} is occupied`);
  }
  return identity;
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

function claimCanonicalBytes(
  canonical,
  expectedBytes,
  receipt,
  label,
  operations,
) {
  const expected = Buffer.from(expectedBytes);
  assertExactBytes(canonical, expected, `${label} before claim`, operations);
  let renameError;
  try {
    operations.renameSync(canonical, receipt);
  } catch (error) {
    renameError = error;
  }
  let claimed;
  try {
    claimed = readBytes(receipt, operations);
  } catch (claimError) {
    if (renameError && claimError?.code === "ENOENT") throw renameError;
    throw aggregatePersistence(`${label} claim could not be inspected`, [
      renameError,
      claimError,
    ]);
  }
  if (!claimed.equals(expected) || renameError) {
    const ownershipError = claimed.equals(expected)
      ? renameError
      : new Error(`${label} captured foreign canonical bytes`);
    try {
      restoreClaimedBytes(
        canonical,
        claimed,
        `${label} exact claimed bytes restored`,
        operations,
      );
    } catch (restoreError) {
      throw aggregatePersistence(
        `${label} failed and its claimed bytes could not be restored`,
        [ownershipError, restoreError],
      );
    }
    throw ownershipError;
  }
  return claimed;
}

export function replaceC1229S5DenseLatestOwned(
  paths,
  bytes,
  lockBytes,
  tag,
  expectedPriorBytes = undefined,
  operations = fs,
) {
  requireOwnedLock(paths, lockBytes, operations);
  const replacement = Buffer.from(bytes);
  const priorReceipt = `${paths.latest}.${tag}-${randomUUID()}.receipt`;
  const initial = fingerprintEvidenceFile(paths.latest, operations);
  assertEvidenceReadableOrAbsent(initial, "dense canonical latest at claim");
  let expected;
  if (expectedPriorBytes === null) {
    if (initial.exists !== false || initial.error !== "ENOENT") {
      throw new Error(
        "[persistence] canonical latest appeared before exclusive creation",
      );
    }
  } else if (expectedPriorBytes !== undefined) {
    expected = Buffer.from(expectedPriorBytes);
    assertExactBytes(
      paths.latest,
      expected,
      "canonical latest before owned claim",
      operations,
    );
  } else if (initial.exists === true) {
    expected = readBytes(paths.latest, operations);
    const afterRead = fingerprintEvidenceFile(paths.latest, operations);
    assertEvidenceReadableOrAbsent(
      afterRead,
      "dense canonical latest after claim snapshot",
    );
    if (!sameFingerprint(initial, afterRead)) {
      throw new Error(
        "[persistence] canonical latest changed during claim snapshot",
      );
    }
  }

  if (expected === undefined) {
    requireOwnedLock(paths, lockBytes, operations);
    writeExclusive(paths.latest, replacement, operations);
    assertExactBytes(
      paths.latest,
      replacement,
      "exclusive canonical latest",
      operations,
    );
    requireOwnedLock(paths, lockBytes, operations);
    return { mode: "exclusive-create", receipt: null };
  }

  let claimed;
  let replacementCreated = false;
  try {
    requireOwnedLock(paths, lockBytes, operations);
    claimed = claimCanonicalBytes(
      paths.latest,
      expected,
      priorReceipt,
      "dense canonical latest",
      operations,
    );
    requireOwnedLock(paths, lockBytes, operations);
    requireAbsent(
      paths.latest,
      "canonical latest after owned claim",
      operations,
    );
    requireOwnedLock(paths, lockBytes, operations);
    writeExclusive(paths.latest, replacement, operations);
    replacementCreated = true;
    assertExactBytes(
      paths.latest,
      replacement,
      "exclusive canonical replacement",
      operations,
    );
    assertExactBytes(
      priorReceipt,
      expected,
      "retained prior latest receipt",
      operations,
    );
    requireOwnedLock(paths, lockBytes, operations);
    operations.unlinkSync(priorReceipt);
    requireAbsent(priorReceipt, "deleted prior latest receipt", operations);
    assertExactBytes(
      paths.latest,
      replacement,
      "canonical replacement after receipt deletion",
      operations,
    );
    requireOwnedLock(paths, lockBytes, operations);
    return { mode: "receipt-exclusive-replace", receipt: priorReceipt };
  } catch (error) {
    if (claimed && !replacementCreated) {
      try {
        restoreClaimedBytes(
          paths.latest,
          claimed,
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
) {
  requireOwnedLock(paths, lockBytes, operations);
  const receipt = `${paths.lock}.release-${randomUUID()}.receipt`;
  const claimed = claimCanonicalBytes(
    paths.lock,
    lockBytes,
    receipt,
    "dense RUNNING lock release",
    operations,
  );
  const canonical = fingerprintEvidenceFile(paths.lock, operations);
  assertEvidenceReadableOrAbsent(
    canonical,
    "dense canonical lock after release claim",
  );
  if (canonical.exists !== false || canonical.error !== "ENOENT") {
    throw new Error(
      "[persistence] foreign canonical lock appeared during owned release",
    );
  }
  try {
    operations.unlinkSync(receipt);
  } catch (error) {
    try {
      restoreClaimedBytes(
        paths.lock,
        claimed,
        "owned RUNNING lock restored after release failure",
        operations,
      );
    } catch (restoreError) {
      throw aggregatePersistence(
        "lock receipt deletion failed and authority could not be restored",
        [error, restoreError],
      );
    }
    throw error;
  }
  requireAbsent(receipt, "deleted lock release receipt", operations);
  requireAbsent(paths.lock, "released canonical lock", operations);
  return { receipt, claimedByteLength: claimed.byteLength };
}

export function beginC1229S5DenseRun(paths, runId, operations = fs) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      runId,
    )
  ) {
    throw new Error("[persistence] dense runId must be UUID-v4");
  }
  operations.mkdirSync(paths.directory, { recursive: true });
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
  writeExclusive(paths.lock, lockBytes, operations);
  const running = {
    schema: C12_29_S5_DENSE_SCHEMA,
    schemaVersion: 2,
    runId,
    status: "RUNNING",
    incomplete: true,
    pass: null,
    exitCode: null,
    startedAt: lock.startedAt,
    lifecycle: {
      lockCreatedExclusively: true,
      runningReceiptCreatedExclusively: true,
      runningLatestPublishedBeforeLaunch: true,
    },
  };
  const runningBytes = jsonBytes(running);
  let runningAuthorityEstablished = false;
  try {
    const priorBefore = fingerprintEvidenceFile(paths.latest, operations);
    assertEvidenceReadableOrAbsent(priorBefore, "dense prior latest");
    let priorBytes = null;
    let prior = null;
    let legacyReceipt = null;
    if (priorBefore.exists === true) {
      priorBytes = readBytes(paths.latest, operations);
      prior = inspectDensePriorFinalBytes(priorBytes);
      assertDensePriorRetained(
        paths,
        priorBytes,
        prior,
        legacyReceipt,
        "initial",
        operations,
      );
      if (prior.schemaVersion === 1) {
        legacyReceipt = preserveDenseLegacyV1Latest(
          paths,
          priorBytes,
          prior.value,
          operations,
        );
      }
      assertDensePriorRetained(
        paths,
        priorBytes,
        prior,
        legacyReceipt,
        "post-supersession",
        operations,
      );
    }
    const priorAfter = fingerprintEvidenceFile(paths.latest, operations);
    assertEvidenceReadableOrAbsent(
      priorAfter,
      "dense prior latest after parse",
    );
    if (!sameFingerprint(priorBefore, priorAfter)) {
      throw new Error("[persistence] dense prior latest changed while parsing");
    }
    requireOwnedLock(paths, lockBytes, operations);
    writeExclusive(paths.runningReceipt, runningBytes, operations);
    assertDensePriorRetained(
      paths,
      priorBytes,
      prior,
      legacyReceipt,
      "post-running-receipt",
      operations,
    );
    replaceC1229S5DenseLatestOwned(
      paths,
      runningBytes,
      lockBytes,
      "running",
      priorBytes,
      operations,
    );
    runningAuthorityEstablished = true;
    assertDensePriorRetained(
      paths,
      priorBytes,
      prior,
      legacyReceipt,
      "post-latest-replacement",
      operations,
    );
    assertExactBytes(
      paths.latest,
      runningBytes,
      "canonical RUNNING latest",
      operations,
    );
    requireOwnedLock(paths, lockBytes, operations);
    operations.mkdirSync(paths.rawDirectory, { recursive: false });
    assertDensePriorRetained(
      paths,
      priorBytes,
      prior,
      legacyReceipt,
      "pre-return",
      operations,
    );
    assertExactBytes(
      paths.latest,
      runningBytes,
      "canonical RUNNING latest after raw-directory creation",
      operations,
    );
    requireOwnedLock(paths, lockBytes, operations);
    return { lock, lockBytes, running, runningBytes };
  } catch (error) {
    if (!runningAuthorityEstablished) {
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
        releaseC1229S5DenseOwnedLock(paths, lockBytes, operations);
      } catch {
        // Preserve the acquisition error and any uncertain/foreign authority.
      }
    }
    throw error;
  }
}

function recoverDenseOwnedLock(paths, lockBytes, operations) {
  const before = fingerprintEvidenceFile(paths.lock, operations);
  try {
    assertEvidenceReadableOrAbsent(before, "dense lock at recovery");
    if (before.exists === false && before.error === "ENOENT") {
      try {
        createImmutableEvidence(paths.lock, lockBytes, operations);
      } catch {
        // Exact verification below decides post-write throws and collisions.
      }
    }
    requireOwnedLock(paths, lockBytes, operations);
    return { ok: true, method: before.exists ? "retained" : "recreated" };
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
  hasOwnedLock,
) {
  const errors = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      assertExactBytes(
        paths.latest,
        runningBytes,
        `canonical RUNNING latest recovery ${attempt}`,
        operations,
      );
      return { ok: true, method: "verified-running" };
    } catch (error) {
      errors.push(error);
    }
    if (!hasOwnedLock) break;
    try {
      requireOwnedLock(paths, lockBytes, operations);
      const current = fingerprintEvidenceFile(paths.latest, operations);
      assertEvidenceReadableOrAbsent(
        current,
        `dense latest before recovery ${attempt}`,
      );
      if (current.exists === false && current.error === "ENOENT") {
        replaceC1229S5DenseLatestOwned(
          paths,
          runningBytes,
          lockBytes,
          `running-recovery-${attempt}`,
          null,
          operations,
        );
      } else {
        assertExactBytes(
          paths.latest,
          finalBytes,
          `owned final-looking latest recovery ${attempt}`,
          operations,
        );
        replaceC1229S5DenseLatestOwned(
          paths,
          runningBytes,
          lockBytes,
          `running-recovery-${attempt}`,
          finalBytes,
          operations,
        );
      }
      assertExactBytes(
        paths.latest,
        runningBytes,
        `restored canonical RUNNING latest ${attempt}`,
        operations,
      );
      return { ok: true, method: `exclusive-recovery-${attempt}` };
    } catch (error) {
      errors.push(error);
    }
  }
  return {
    ok: false,
    method: hasOwnedLock ? "exclusive-recovery-failed" : "no-lock-authority",
    error: aggregatePersistence(
      "canonical RUNNING latest recovery failed",
      errors,
    ),
  };
}

function quarantineDenseFinalLatest(
  paths,
  finalBytes,
  runningBytes,
  lockBytes,
  operations,
) {
  try {
    requireOwnedLock(paths, lockBytes, operations);
    assertExactBytes(
      paths.immutable,
      finalBytes,
      "immutable archive before final quarantine",
      operations,
    );
    const recovery = fingerprintEvidenceFile(paths.recoveryLatest, operations);
    assertEvidenceReadableOrAbsent(
      recovery,
      "dense recovery quarantine identity",
    );
    if (recovery.exists === false && recovery.error === "ENOENT") {
      writeExclusive(paths.recoveryLatest, finalBytes, operations);
    } else {
      assertExactBytes(
        paths.recoveryLatest,
        finalBytes,
        "existing dense recovery quarantine",
        operations,
      );
    }
    replaceC1229S5DenseLatestOwned(
      paths,
      runningBytes,
      lockBytes,
      "quarantine-recovery",
      finalBytes,
      operations,
    );
    return { ok: true, method: "immutable-quarantine-and-running-restore" };
  } catch (error) {
    return { ok: false, method: "quarantine-failed", error };
  }
}

function verifyFirstRedWriteOnce(paths, bytes, operations) {
  const before = fingerprintEvidenceFile(paths.firstRed, operations);
  assertEvidenceReadableOrAbsent(before, "dense first-red before preserve");
  const retained = preserveFirstRedEvidence(paths.firstRed, bytes, operations);
  const after = fingerprintEvidenceFile(paths.firstRed, operations);
  assertEvidenceReadableOrAbsent(after, "dense first-red after preserve");
  if (
    after.exists !== true ||
    retained.exists !== true ||
    after.byteLength !== retained.byteLength ||
    after.sha256 !== retained.sha256 ||
    (before.exists === true &&
      (!sameFingerprint(before, after) || retained.written !== false)) ||
    (before.exists === false &&
      (retained.written !== true ||
        after.byteLength !== Buffer.byteLength(bytes) ||
        after.sha256 !== sha256(bytes)))
  ) {
    throw new Error(
      "[persistence] first-red write-once fingerprint verification failed",
    );
  }
  return { before, after, written: retained.written, verified: true };
}

export function publishC1229S5DenseFinal(
  paths,
  lockBytes,
  report,
  operations = fs,
) {
  requireOwnedLock(paths, lockBytes, operations);
  const lock = JSON.parse(Buffer.from(lockBytes).toString("utf8"));
  const runningBytes = readBytes(paths.runningReceipt, operations);
  const running = JSON.parse(runningBytes.toString("utf8"));
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
  assertExactBytes(
    paths.latest,
    runningBytes,
    "canonical latest is not the owned RUNNING marker",
    operations,
  );
  const bytes = jsonBytes(report);
  writeExclusive(paths.immutable, bytes, operations);
  assertExactBytes(
    paths.immutable,
    bytes,
    "immutable dense run archive",
    operations,
  );
  const runIdentity = fingerprintEvidenceFile(paths.immutable, operations);
  assertEvidenceReadableOrAbsent(runIdentity, "dense immutable run archive");
  let firstRed = { applicable: false, verified: true };
  if (report.status !== "PASS") {
    firstRed = {
      applicable: true,
      ...verifyFirstRedWriteOnce(paths, bytes, operations),
    };
  }
  try {
    replaceC1229S5DenseLatestOwned(
      paths,
      bytes,
      lockBytes,
      "final",
      runningBytes,
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
      latestByteIdentical: readBytes(paths.latest, operations).equals(bytes),
    };
    writeExclusive(paths.finalReceipt, jsonBytes(receipt), operations);
    if (!receipt.latestByteIdentical) {
      throw new Error("[persistence] final latest differs from immutable run");
    }
    assertExactBytes(
      paths.immutable,
      bytes,
      "immutable dense run before unlock",
      operations,
    );
    assertExactBytes(
      paths.latest,
      bytes,
      "canonical final latest before unlock",
      operations,
    );
    assertExactBytes(
      paths.finalReceipt,
      jsonBytes(receipt),
      "final receipt before unlock",
      operations,
    );
    if (firstRed.applicable) {
      const retainedFirstRed = fingerprintEvidenceFile(
        paths.firstRed,
        operations,
      );
      assertEvidenceReadableOrAbsent(
        retainedFirstRed,
        "dense first-red before unlock",
      );
      if (!sameFingerprint(retainedFirstRed, firstRed.after)) {
        throw new Error("[persistence] first-red changed before unlock");
      }
    }
    requireOwnedLock(paths, lockBytes, operations);
    releaseC1229S5DenseOwnedLock(paths, lockBytes, operations);
    return receipt;
  } catch (error) {
    const lockRecovery = recoverDenseOwnedLock(paths, lockBytes, operations);
    const latestRecovery = recoverDenseRunningLatest(
      paths,
      runningBytes,
      bytes,
      lockBytes,
      operations,
      lockRecovery.ok,
    );
    const quarantine = latestRecovery.ok
      ? null
      : quarantineDenseFinalLatest(
          paths,
          bytes,
          runningBytes,
          lockBytes,
          operations,
        );
    const failures = [
      lockRecovery.ok ? null : lockRecovery.error,
      latestRecovery.ok ? null : latestRecovery.error,
      quarantine === null || quarantine.ok ? null : quarantine.error,
    ].filter(Boolean);
    if (failures.length === 0) throw error;
    const recoveryError = aggregatePersistence(
      `final publication failed; recovery lock=${lockRecovery.ok} latest=${latestRecovery.ok} quarantine=${quarantine?.ok ?? null}`,
      [error, ...failures],
    );
    recoveryError.code = "C12_29_S5_DENSE_PUBLICATION_RECOVERY";
    recoveryError.denseRecovery = {
      lock: { ok: lockRecovery.ok, method: lockRecovery.method },
      latest: { ok: latestRecovery.ok, method: latestRecovery.method },
      quarantine:
        quarantine === null
          ? { ok: null, method: "not-required" }
          : { ok: quarantine.ok, method: quarantine.method },
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
  const { lockBytes, running } = beginC1229S5DenseRun(paths, runId);
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
    schemaVersion: 2,
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
    publishC1229S5DenseFinal(paths, lockBytes, report);
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
