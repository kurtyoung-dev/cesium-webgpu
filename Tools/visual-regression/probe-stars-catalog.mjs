#!/usr/bin/env node
/**
 * C12-11 star-catalog certification harness.
 * @purpose UUID-bound write-once WebGPU star-catalog evidence acquisition (checks A-G); the gate lib owns the verdict fold.
 * @status ACTIVE
 *
 * The four historical fixed-name Batch-837 PNGs are instrument-red evidence.
 * This harness never writes, renames, or deletes them.  Every new capture and
 * report is UUID-bound and write-once; only latest.json is mutable, and it is
 * replaced while this invocation owns byte-exact lock and prior-latest state.
 *
 * Canonical checks (the historical labels/formulas are preserved):
 *   A — sprites add a resolved Sirius source and the nearest source is <= 6 px
 *   B — the Sirius-aimed centre box is brighter than the blank-aimed box
 *   C — a Sirius source is present and the blank patch contains no source
 *   D — intensity 3.0 increases the bright-pixel count
 *   E — the live default SkyBox exposes its starField hook
 *   F — no runtime/page/console/WebGPU/device-loss errors
 *   G — the cubemap-only frame contains at most two resolved sources
 */

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { pointSourceCensus } from "../skybox-bake/starmap-census.mjs";
import {
  armWebGPUDevices,
  attachConsoleErrorGate,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import { inspectBuildSourceIdentity } from "./lib/build-source-identity.mjs";
import { foldG3Verdict } from "./lib/celestial-g3-gate.mjs";
import {
  C12_11_STAR_CATALOG_BUILD_SOURCE_FILES,
  C12_11_STAR_CATALOG_BUILD_SOURCE_MAP,
  C12_11_STAR_CATALOG_CAPTURE_LABELS,
  C12_11_STAR_CATALOG_DIAGNOSTICS_SCHEMA,
  C12_11_STAR_CATALOG_G3_PREREQUISITE_FILES,
  C12_11_STAR_CATALOG_G3_REPORT,
  C12_11_STAR_CATALOG_LOCK_SCHEMA,
  C12_11_STAR_CATALOG_OUTPUT_DIRECTORY,
  C12_11_STAR_CATALOG_PROTECTED_HISTORICAL_PNGS,
  C12_11_STAR_CATALOG_PROVENANCE_SCHEMA,
  C12_11_STAR_CATALOG_RENDERER,
  C12_11_STAR_CATALOG_RUNTIME_PATH,
  C12_11_STAR_CATALOG_SCENE,
  C12_11_STAR_CATALOG_SCHEMA,
  C12_11_STAR_CATALOG_SOURCE_FILES,
  C12_11_STAR_CATALOG_VIEWER_PATH,
  createC1211StarCatalogErrorArtifact,
  decodeC1211RgbaPng,
  exitCodeForC1211StarCatalogStatus,
  expectedC1211CaptureFilename,
  inspectC1211Png,
  isC1211UuidV4,
  materializeC1211StarCatalogArtifact,
  sha256C1211,
  stableC1211StarCatalogJson,
  summarizeC1211G3Report,
  validateC1211G3Prerequisite,
  validateC1211StarCatalogFinalArtifact,
} from "./lib/c12-11-star-catalog-gate.mjs";

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(toolDirectory, "../..");
const defaultBase = process.env.PROBE_BASE ?? "http://localhost:8080";
const defaultOutputDirectory = path.resolve(
  process.env.C12_11_STAR_CATALOG_OUTPUT_DIR ??
    path.join(repositoryRoot, C12_11_STAR_CATALOG_OUTPUT_DIRECTORY),
);
const buildEntryPath = path.join(
  repositoryRoot,
  "Build/CesiumUnminified/index.js",
);
const buildSourceMapPath = path.join(
  repositoryRoot,
  C12_11_STAR_CATALOG_BUILD_SOURCE_MAP,
);

const WATCHDOG_MS = 240_000;
// Stage-2 terminating fuse: the in-run watchdog aborts and closes, but an
// unawaited close cannot end a wedged event loop; only process.exit can.
const CLOSE_TIMEOUT_MS = 15_000;
const PROCESS_WATCHDOG_MS = WATCHDOG_MS + CLOSE_TIMEOUT_MS + 60_000;
const PAGE_TIMEOUT_MS = 120_000;
const GPU_DRAIN_TIMEOUT_MS = 20_000;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const jsonBytes = (value) =>
  Buffer.from(`${stableC1211StarCatalogJson(value, 2)}\n`);

export function validateC1211LoopbackBase(value) {
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

export function createC1211ArtifactPaths(
  runId,
  outputDirectory = defaultOutputDirectory,
) {
  if (!isC1211UuidV4(runId))
    throw new TypeError("C12-11 runId must be UUID v4");
  const directory = path.resolve(outputDirectory);
  const captures = Object.fromEntries(
    C12_11_STAR_CATALOG_CAPTURE_LABELS.map((label) => [
      label,
      path.join(directory, expectedC1211CaptureFilename(runId, label)),
    ]),
  );
  return {
    directory,
    archive: path.join(directory, `${runId}.json`),
    running: path.join(directory, `${runId}.running.json`),
    latest: path.join(directory, "latest.json"),
    lock: path.join(directory, "active.lock.json"),
    captures,
  };
}

function assertArtifactPaths(paths, runId) {
  const expected = createC1211ArtifactPaths(runId, paths?.directory);
  for (const key of ["directory", "archive", "running", "latest", "lock"])
    if (paths?.[key] !== expected[key])
      throw new Error(`C12-11 ${key} path is not owned by run ${runId}`);
  for (const label of C12_11_STAR_CATALOG_CAPTURE_LABELS)
    if (paths?.captures?.[label] !== expected.captures[label])
      throw new Error(
        `C12-11 ${label} capture path is not owned by run ${runId}`,
      );
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

function exactBytes(file, expected, label, operations = fs) {
  const actual = readBytesIfPresent(file, operations);
  if (!actual || !actual.equals(Buffer.from(expected)))
    throw new Error(`${label} bytes differ from owned canonical bytes`);
  return actual;
}

function exclusive(file, bytes, operations = fs) {
  operations.writeFileSync(file, bytes, { flag: "wx" });
  exactBytes(file, bytes, path.basename(file), operations);
}

function restoreExclusive(file, bytes, label, operations = fs) {
  try {
    exclusive(file, bytes, operations);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    exactBytes(file, bytes, label, operations);
  }
}

function assertNeverProtectedMutationPath(file) {
  const resolved = path.resolve(file);
  for (const entry of C12_11_STAR_CATALOG_PROTECTED_HISTORICAL_PNGS) {
    if (resolved === path.join(repositoryRoot, entry.path))
      throw new Error(
        `refusing mutation of protected historical PNG ${entry.path}`,
      );
  }
}

export function beginC1211EvidenceRun(paths, runId, operations = fs) {
  assertArtifactPaths(paths, runId);
  operations.mkdirSync(paths.directory, { recursive: true });
  for (const file of [
    paths.archive,
    paths.running,
    paths.lock,
    ...Object.values(paths.captures),
  ]) {
    assertNeverProtectedMutationPath(file);
    if (readBytesIfPresent(file, operations))
      throw new Error(`write-once C12-11 run path already exists: ${file}`);
  }

  const priorLatest = readBytesIfPresent(paths.latest, operations);
  if (priorLatest) {
    const prior = JSON.parse(priorLatest.toString("utf8"));
    const valid = validateC1211StarCatalogFinalArtifact(prior);
    if (!valid.ok)
      throw new Error(`prior latest is invalid: ${valid.reasons.join("; ")}`);
    const canonical = jsonBytes(prior);
    if (!priorLatest.equals(canonical))
      throw new Error("prior latest is not canonical C12-11 evidence");
    exactBytes(
      path.join(paths.directory, `${prior.runId}.json`),
      canonical,
      "prior immutable C12-11 report",
      operations,
    );
  }

  const lock = {
    schema: C12_11_STAR_CATALOG_LOCK_SCHEMA,
    runId,
    pid: process.pid,
  };
  const lockBytes = jsonBytes(lock);
  exclusive(paths.lock, lockBytes, operations);
  const running = {
    schema: C12_11_STAR_CATALOG_SCHEMA,
    runId,
    incomplete: true,
    status: "RUNNING",
    stage: "preflight",
  };
  const runningBytes = jsonBytes(running);
  try {
    exclusive(paths.running, runningBytes, operations);
  } catch (error) {
    exactBytes(paths.lock, lockBytes, "C12-11 lock cleanup", operations);
    operations.unlinkSync(paths.lock);
    throw error;
  }
  return { runId, lockBytes, runningBytes, priorLatest };
}

function atomicReplaceLatestOwned(paths, bytes, ownership, operations = fs) {
  exactBytes(
    paths.lock,
    ownership.lockBytes,
    "C12-11 publication lock",
    operations,
  );
  const current = readBytesIfPresent(paths.latest, operations);
  if (
    (current === undefined) !== (ownership.priorLatest === undefined) ||
    (current && !current.equals(ownership.priorLatest))
  ) {
    throw new Error("C12-11 latest changed after this run acquired its lock");
  }

  const candidate = `${paths.latest}.${ownership.runId}.candidate`;
  const receipt = `${paths.latest}.${ownership.runId}.prior`;
  assertNeverProtectedMutationPath(candidate);
  assertNeverProtectedMutationPath(receipt);
  exclusive(candidate, bytes, operations);
  let priorClaimed = false;
  let candidateInstalled = false;
  try {
    if (current) {
      operations.renameSync(paths.latest, receipt);
      priorClaimed = true;
      exactBytes(receipt, current, "claimed prior C12-11 latest", operations);
    }
    operations.renameSync(candidate, paths.latest);
    candidateInstalled = true;
    exactBytes(paths.latest, bytes, "installed C12-11 latest", operations);
    if (priorClaimed) operations.unlinkSync(receipt);
  } catch (error) {
    const cleanup = [];
    try {
      if (!candidateInstalled && readBytesIfPresent(candidate, operations)) {
        exactBytes(candidate, bytes, "owned latest candidate", operations);
        operations.unlinkSync(candidate);
      }
    } catch (cleanupError) {
      cleanup.push(cleanupError);
    }
    try {
      if (priorClaimed && !readBytesIfPresent(paths.latest, operations)) {
        const claimed = exactBytes(
          receipt,
          ownership.priorLatest,
          "prior latest restoration receipt",
          operations,
        );
        restoreExclusive(
          paths.latest,
          claimed,
          "restored prior C12-11 latest",
          operations,
        );
        operations.unlinkSync(receipt);
      }
    } catch (restoreError) {
      cleanup.push(restoreError);
    }
    if (cleanup.length > 0)
      throw new AggregateError(
        [error, ...cleanup],
        "C12-11 latest publication reconciliation failed",
        { cause: error },
      );
    throw error;
  }
}

function releaseOwnedLock(paths, ownership, operations = fs) {
  exactBytes(
    paths.lock,
    ownership.lockBytes,
    "C12-11 lock before release",
    operations,
  );
  const receipt = `${paths.lock}.${ownership.runId}.release`;
  operations.renameSync(paths.lock, receipt);
  try {
    exactBytes(receipt, ownership.lockBytes, "claimed C12-11 lock", operations);
    operations.unlinkSync(receipt);
  } catch (error) {
    try {
      if (!readBytesIfPresent(paths.lock, operations)) {
        const bytes = exactBytes(
          receipt,
          ownership.lockBytes,
          "C12-11 lock receipt",
          operations,
        );
        restoreExclusive(paths.lock, bytes, "restored C12-11 lock", operations);
        operations.unlinkSync(receipt);
      }
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        "C12-11 lock release reconciliation failed",
        { cause: restoreError },
      );
    }
    throw error;
  }
}

export function writeC1211Capture(paths, runId, label, bytes, operations = fs) {
  assertArtifactPaths(paths, runId);
  if (!C12_11_STAR_CATALOG_CAPTURE_LABELS.includes(label))
    throw new Error(`unknown C12-11 capture ${String(label)}`);
  const file = paths.captures[label];
  assertNeverProtectedMutationPath(file);
  const png = inspectC1211Png(bytes);
  if (!png.ok)
    throw new Error(`refusing invalid ${label} PNG: ${png.reasons.join("; ")}`);
  exclusive(file, bytes, operations);
  const retained = exactBytes(
    file,
    bytes,
    `${label} immutable capture`,
    operations,
  );
  return {
    runId,
    renderer: C12_11_STAR_CATALOG_RENDERER,
    label,
    file: path.basename(file),
    byteLength: retained.byteLength,
    sha256: sha256(retained),
    width: png.width,
    height: png.height,
  };
}

export function verifyC1211CaptureFiles(paths, artifact, operations = fs) {
  const reasons = [];
  for (const binding of artifact?.captureBindings ?? []) {
    const expected = paths?.captures?.[binding?.label];
    if (!expected || path.basename(expected) !== binding?.file) {
      reasons.push(`${String(binding?.label)} capture path binding is invalid`);
      continue;
    }
    try {
      const bytes = operations.readFileSync(expected);
      const png = inspectC1211Png(bytes);
      if (!png.ok) reasons.push(`${binding.label}: ${png.reasons.join("; ")}`);
      if (
        bytes.byteLength !== binding.byteLength ||
        sha256C1211(bytes) !== binding.sha256
      )
        reasons.push(
          `${binding.label} capture bytes differ from the final report`,
        );
    } catch (error) {
      reasons.push(
        `${binding.label} capture is unreadable: ${error?.code ?? error?.message}`,
      );
    }
  }
  try {
    const derived = deriveC1211MetricsFromCaptureFiles(paths, operations);
    if (
      stableC1211StarCatalogJson(derived.metrics) !==
      stableC1211StarCatalogJson(artifact?.runtime?.metrics)
    )
      reasons.push(
        "reported star-catalog metrics were not derived from the exact immutable PNG bytes",
      );
  } catch (error) {
    reasons.push(
      `immutable PNG metric derivation failed: ${error?.code ?? error?.message}`,
    );
  }
  return { ok: reasons.length === 0, reasons };
}

export function finalizeC1211Evidence(
  paths,
  artifact,
  ownership,
  operations = fs,
) {
  assertArtifactPaths(paths, ownership?.runId);
  if (artifact?.runId !== ownership?.runId)
    throw new Error("C12-11 artifact runId does not match the owned run");
  const valid = validateC1211StarCatalogFinalArtifact(artifact);
  if (!valid.ok)
    throw new Error(
      `refusing invalid C12-11 artifact: ${valid.reasons.join("; ")}`,
    );
  if (artifact.status !== "ERROR") {
    const captures = verifyC1211CaptureFiles(paths, artifact, operations);
    if (!captures.ok)
      throw new Error(
        `refusing unbound C12-11 captures: ${captures.reasons.join("; ")}`,
      );
  }
  exactBytes(
    paths.lock,
    ownership.lockBytes,
    "C12-11 finalization lock",
    operations,
  );
  exactBytes(
    paths.running,
    ownership.runningBytes,
    "C12-11 RUNNING record",
    operations,
  );
  const bytes = jsonBytes(artifact);
  const roundTrip = JSON.parse(bytes.toString("utf8"));
  const roundTripValid = validateC1211StarCatalogFinalArtifact(roundTrip);
  if (!roundTripValid.ok || !jsonBytes(roundTrip).equals(bytes))
    throw new Error(
      `C12-11 artifact does not round-trip: ${roundTripValid.reasons.join("; ")}`,
    );

  exclusive(paths.archive, bytes, operations);
  let runningRemoved = false;
  try {
    atomicReplaceLatestOwned(paths, bytes, ownership, operations);
    exactBytes(paths.archive, bytes, "immutable C12-11 report", operations);
    exactBytes(paths.latest, bytes, "canonical C12-11 latest", operations);
    operations.unlinkSync(paths.running);
    runningRemoved = true;
    releaseOwnedLock(paths, ownership, operations);
  } catch (error) {
    error.retainC1211Running = true;
    if (runningRemoved) {
      try {
        restoreExclusive(
          paths.running,
          ownership.runningBytes,
          "restored C12-11 RUNNING record",
          operations,
        );
      } catch (restoreError) {
        const aggregate = new AggregateError(
          [error, restoreError],
          "C12-11 publication and RUNNING restoration failed",
          { cause: error },
        );
        aggregate.retainC1211Running = true;
        throw aggregate;
      }
    }
    throw error;
  }
  return {
    archive: paths.archive,
    latest: paths.latest,
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

function identity(relativePath, operations = fs) {
  const bytes = operations.readFileSync(
    path.join(repositoryRoot, relativePath),
  );
  return {
    path: relativePath,
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

function identityList(relativePaths, operations = fs) {
  return relativePaths.map((relativePath) =>
    identity(relativePath, operations),
  );
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

async function servedEntryIdentity(origin, parentSignal) {
  const url = new URL(C12_11_STAR_CATALOG_RUNTIME_PATH, origin);
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, PAGE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok)
      throw new Error(`${url.href} returned HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const local = fs.readFileSync(buildEntryPath);
    return {
      path: "Build/CesiumUnminified/index.js",
      url: url.href,
      status: response.status,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
      matchesLocalBuildEntry: bytes.equals(local),
    };
  } catch (error) {
    if (!timedOut) throw error;
    const timeout = new Error(
      `served runtime identity timed out after ${PAGE_TIMEOUT_MS} ms`,
      { cause: error },
    );
    timeout.c1211TimeoutMs = PAGE_TIMEOUT_MS;
    throw timeout;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

function collectBuildIdentity() {
  const result = inspectBuildSourceIdentity({
    sourceMapPath: buildSourceMapPath,
    sourceFiles: C12_11_STAR_CATALOG_BUILD_SOURCE_FILES.map((file) =>
      path.join(repositoryRoot, file),
    ),
  });
  const buildEntryBytes = fs.readFileSync(buildEntryPath);
  return {
    ok: result.ok,
    sourceMapByteLength: result.sourceMapByteLength,
    sourceMapSha256: result.sourceMapSha256,
    buildEntryByteLength: buildEntryBytes.byteLength,
    buildEntrySha256: sha256(buildEntryBytes),
    endSourceMapByteLength: null,
    endSourceMapSha256: null,
    endBuildEntryByteLength: null,
    endBuildEntrySha256: null,
    stable: false,
    entries: result.entries.map((entry, index) => ({
      path: C12_11_STAR_CATALOG_BUILD_SOURCE_FILES[index],
      sourceMapEntry: entry.sourceMapEntry ?? null,
      currentByteLength: entry.currentByteLength ?? null,
      embeddedByteLength: entry.embeddedByteLength ?? null,
      currentSha256: entry.currentSha256 ?? null,
      embeddedSha256: entry.embeddedSha256 ?? null,
      exact: entry.exact === true,
      reason: entry.reason ?? null,
    })),
    reasons: result.reasons,
  };
}

function finishBuildIdentity(start) {
  const sourceMapBytes = fs.readFileSync(buildSourceMapPath);
  const buildEntryBytes = fs.readFileSync(buildEntryPath);
  const endSourceMapSha256 = sha256(sourceMapBytes);
  const endBuildEntrySha256 = sha256(buildEntryBytes);
  return {
    ...start,
    endSourceMapByteLength: sourceMapBytes.byteLength,
    endSourceMapSha256,
    endBuildEntryByteLength: buildEntryBytes.byteLength,
    endBuildEntrySha256,
    stable:
      sourceMapBytes.byteLength === start.sourceMapByteLength &&
      endSourceMapSha256 === start.sourceMapSha256 &&
      buildEntryBytes.byteLength === start.buildEntryByteLength &&
      endBuildEntrySha256 === start.buildEntrySha256,
  };
}

function collectG3Start() {
  let reportBytes;
  const files = C12_11_STAR_CATALOG_G3_PREREQUISITE_FILES.map(
    (relativePath) => {
      const bytes = fs.readFileSync(path.join(repositoryRoot, relativePath));
      if (relativePath === C12_11_STAR_CATALOG_G3_REPORT) reportBytes = bytes;
      return {
        path: relativePath,
        byteLength: bytes.byteLength,
        sha256: sha256(bytes),
      };
    },
  );
  const report = JSON.parse(reportBytes.toString("utf8"));
  const summary = summarizeC1211G3Report(report);
  const recomputed = foldG3Verdict(report?.backends);
  const foldVerified =
    summary.verdict === recomputed.verdict &&
    summary.exitCode === recomputed.exitCode &&
    summary.pass === (recomputed.exitCode === 0) &&
    stableC1211StarCatalogJson(summary.failures) ===
      stableC1211StarCatalogJson(recomputed.failures) &&
    stableC1211StarCatalogJson(summary.structural) ===
      stableC1211StarCatalogJson(recomputed.structural);
  return { files, report: summary, foldVerified };
}

function finishG3(start) {
  const end = identityList(C12_11_STAR_CATALOG_G3_PREREQUISITE_FILES);
  const stable =
    stableC1211StarCatalogJson(start.files) === stableC1211StarCatalogJson(end);
  const candidate = {
    files: start.files,
    report: start.report,
    foldVerified: start.foldVerified,
    stable,
    valid: true,
  };
  candidate.valid = validateC1211G3Prerequisite(candidate).ok;
  return candidate;
}

function protectedHistoricalIdentity() {
  return identityList(
    C12_11_STAR_CATALOG_PROTECTED_HISTORICAL_PNGS.map((entry) => entry.path),
  );
}

function assertProtectedHistoricalFrozen(identities) {
  for (
    let index = 0;
    index < C12_11_STAR_CATALOG_PROTECTED_HISTORICAL_PNGS.length;
    index++
  ) {
    const expected = C12_11_STAR_CATALOG_PROTECTED_HISTORICAL_PNGS[index];
    const actual = identities[index];
    if (
      actual?.path !== expected.path ||
      actual?.byteLength !== expected.byteLength ||
      actual?.sha256 !== expected.sha256
    ) {
      throw new Error(
        `protected historical C12-11 PNG changed: ${expected.path}`,
      );
    }
  }
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`${label} timed out after ${timeoutMs} ms`);
        error.c1211TimeoutMs = timeoutMs;
        reject(error);
      }, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function closeBounded(instance, label) {
  if (!instance)
    return {
      label,
      attempted: false,
      closed: true,
      timedOut: false,
      error: null,
    };
  try {
    await withTimeout(instance.close(), CLOSE_TIMEOUT_MS, `${label} close`);
    return {
      label,
      attempted: true,
      closed: true,
      timedOut: false,
      error: null,
    };
  } catch (error) {
    return {
      label,
      attempted: true,
      closed: false,
      timedOut: error?.c1211TimeoutMs === CLOSE_TIMEOUT_MS,
      error: String(error?.message ?? error).slice(0, 4096),
    };
  }
}

const lum = (data, index) =>
  0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];

function brightCount(image, threshold) {
  let count = 0;
  for (let pixel = 0; pixel < image.w * image.h; pixel++)
    if (lum(image.data, 4 * pixel) > threshold) count += 1;
  return count;
}

function brightCountCenter(image, threshold, fraction) {
  const x0 = Math.floor(image.w * (0.5 - fraction));
  const x1 = Math.floor(image.w * (0.5 + fraction));
  const y0 = Math.floor(image.h * (0.5 - fraction));
  const y1 = Math.floor(image.h * (0.5 + fraction));
  let count = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++)
      if (lum(image.data, 4 * (y * image.w + x)) > threshold) count += 1;
  return count;
}

function pointCensusCenter(image, fraction) {
  const x0 = Math.floor(image.w * (0.5 - fraction));
  const x1 = Math.floor(image.w * (0.5 + fraction));
  const y0 = Math.floor(image.h * (0.5 - fraction));
  const y1 = Math.floor(image.h * (0.5 + fraction));
  const width = x1 - x0;
  const height = y1 - y0;
  const plane = new Float32Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      plane[y * width + x] = lum(image.data, 4 * ((y0 + y) * image.w + x0 + x));
  const result = pointSourceCensus(plane, width, height, {
    collectSources: true,
  });
  return {
    count: result.count,
    strongest: result.strongest,
    sources: (result.sources ?? []).map((source) => ({
      x: source.x + x0,
      y: source.y + y0,
      peak: source.peak,
      contrast: source.contrast,
    })),
  };
}

function nearestSourceToCenter(image, census) {
  let best = Infinity;
  for (const source of census.sources)
    best = Math.min(
      best,
      Math.hypot(source.x + 0.5 - image.w / 2, source.y + 0.5 - image.h / 2),
    );
  return Number.isFinite(best) ? best : null;
}

function decodePngDataUrl(dataUrl, label) {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/u.exec(
    dataUrl ?? "",
  );
  if (!match) throw new Error(`${label} capture did not return a PNG data URL`);
  return Buffer.from(match[1], "base64");
}

function deriveC1211Metrics(images) {
  const threshold = C12_11_STAR_CATALOG_SCENE.brightThreshold;
  const fraction = C12_11_STAR_CATALOG_SCENE.centerHalfWidthFraction;
  const siriusCensus = pointCensusCenter(images.sirius, fraction);
  const offCensus = pointCensusCenter(images.off, fraction);
  const blankCensus = pointCensusCenter(images.blank, fraction);
  return {
    metrics: {
      offBright: brightCount(images.off, threshold),
      onBright: brightCount(images.sirius, threshold),
      brightBright: brightCount(images.bright, threshold),
      siriusCenter: brightCountCenter(images.sirius, threshold, fraction),
      blankCenter: brightCountCenter(images.blank, threshold, fraction),
      offCenter: brightCountCenter(images.off, threshold, fraction),
      siriusPoints: siriusCensus.count,
      offPoints: offCensus.count,
      blankPoints: blankCensus.count,
      siriusAimPx: nearestSourceToCenter(images.sirius, siriusCensus),
    },
    census: { sirius: siriusCensus, off: offCensus, blank: blankCensus },
    nearestSource: siriusCensus.sources.reduce((nearest, source) => {
      const distance = Math.hypot(
        source.x + 0.5 - images.sirius.w / 2,
        source.y + 0.5 - images.sirius.h / 2,
      );
      return !nearest || distance < nearest.distance
        ? { x: source.x, y: source.y, distance }
        : nearest;
    }, null),
  };
}

export function deriveC1211MetricsFromCaptureFiles(paths, operations = fs) {
  const images = {};
  for (const label of C12_11_STAR_CATALOG_CAPTURE_LABELS) {
    const bytes = operations.readFileSync(paths.captures[label]);
    const decoded = decodeC1211RgbaPng(bytes);
    images[label] = {
      data: decoded.data,
      w: decoded.width,
      h: decoded.height,
    };
  }
  return deriveC1211Metrics(images);
}

async function acquireRuntime(base, headed, watchdogState) {
  let browser;
  let page;
  const consoleErrors = [];
  const pageErrors = [];
  const requestErrors = [];
  const responseErrors = [];
  let gpuConsoleErrors = [];
  let gpuGate = null;
  let webgpu = { errors: [], deviceLost: null };
  const cleanup = {
    pageClosed: false,
    browserClosed: false,
    timedOut: false,
    errors: [],
  };
  try {
    browser = await chromium.launch({
      channel: "msedge",
      headless: !headed,
      args: ["--enable-unsafe-webgpu"],
      timeout: PAGE_TIMEOUT_MS,
    });
    watchdogState.browser = browser;
    page = await browser.newPage({
      viewport: C12_11_STAR_CATALOG_SCENE.viewport,
    });
    watchdogState.page = page;
    page.setDefaultTimeout(PAGE_TIMEOUT_MS);
    gpuConsoleErrors = attachConsoleErrorGate(page);
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("requestfailed", (request) =>
      requestErrors.push(
        `${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "failed"}`,
      ),
    );
    page.on("response", (response) => {
      if (response.status() >= 400)
        responseErrors.push(`${response.status()} ${response.url()}`);
    });
    await page.addInitScript(errorGateInit);
    const url = new URL(C12_11_STAR_CATALOG_VIEWER_PATH, base.origin);
    url.searchParams.set("renderer", C12_11_STAR_CATALOG_RENDERER);
    const runtimeUrl = new URL(C12_11_STAR_CATALOG_RUNTIME_PATH, base.origin)
      .href;
    // Capture the response consumed by this browser context. A separate
    // preflight fetch is not allowed to stand in for the runtime's own bytes.
    const runtimeResponseOutcome = page
      .waitForResponse((response) => response.url() === runtimeUrl, {
        timeout: PAGE_TIMEOUT_MS,
      })
      .then(
        (response) => ({ response, error: null }),
        (error) => ({ response: null, error }),
      );
    await page.goto(url.href, {
      waitUntil: "networkidle",
      timeout: PAGE_TIMEOUT_MS,
    });
    await page.waitForFunction(() => Boolean(window.viewer), null, {
      timeout: PAGE_TIMEOUT_MS,
    });
    const runtimeResponseResult = await runtimeResponseOutcome;
    if (runtimeResponseResult.error) throw runtimeResponseResult.error;
    const runtimeResponse = runtimeResponseResult.response;
    const runtimeBytes = Buffer.from(
      await withTimeout(
        runtimeResponse.body(),
        PAGE_TIMEOUT_MS,
        "browser-served runtime body",
      ),
    );
    const localRuntimeBytes = fs.readFileSync(buildEntryPath);
    const servedEntry = {
      path: "Build/CesiumUnminified/index.js",
      url: runtimeResponse.url(),
      status: runtimeResponse.status(),
      byteLength: runtimeBytes.byteLength,
      sha256: sha256(runtimeBytes),
      matchesLocalBuildEntry: runtimeBytes.equals(localRuntimeBytes),
    };
    gpuGate = await armWebGPUDevices(page);

    const measured = await withTimeout(
      page.evaluate(
        async (sceneContract) => {
          const C = await import(sceneContract.runtimePath);
          const viewer = window.viewer;
          const scene = viewer.scene;
          scene.requestRenderMode = false;
          viewer.clock.shouldAnimate = false;
          const time = C.JulianDate.fromIso8601(sceneContract.timeIso);
          viewer.clock.currentTime = time;
          if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
          if (scene.sun) scene.sun.show = false;
          if (scene.moon) scene.moon.show = false;
          scene.fog.enabled = false;
          if (scene.globe) scene.globe.show = false;
          viewer.imageryLayers.removeAll();
          const hasStarField = Boolean(scene.skyBox?.starField);
          scene.morphTo3D(0);

          const oncePostRender = () =>
            new Promise((resolve) => {
              const remove = scene.postRender.addEventListener(() => {
                remove();
                resolve();
              });
            });
          const renderFrames = async (count) => {
            for (let index = 0; index < count; index++) await oncePostRender();
          };
          const grab = () =>
            new Promise((resolve) => {
              const remove = scene.postRender.addEventListener(() => {
                remove();
                const canvas = scene.canvas;
                const copy = document.createElement("canvas");
                copy.width = canvas.width;
                copy.height = canvas.height;
                const context = copy.getContext("2d", {
                  alpha: true,
                });
                context.drawImage(canvas, 0, 0);
                resolve({
                  png: copy.toDataURL("image/png"),
                  w: canvas.width,
                  h: canvas.height,
                });
              });
            });
          const aimAt = (directionFixed) => {
            const eye = C.Cartesian3.multiplyByScalar(
              directionFixed,
              -sceneContract.cameraAltitudeMeters,
              new C.Cartesian3(),
            );
            const direction = C.Cartesian3.clone(directionFixed);
            let up = C.Cartesian3.UNIT_Z;
            if (Math.abs(C.Cartesian3.dot(direction, up)) > 0.95)
              up = C.Cartesian3.UNIT_X;
            const right = C.Cartesian3.normalize(
              C.Cartesian3.cross(direction, up, new C.Cartesian3()),
              new C.Cartesian3(),
            );
            const realUp = C.Cartesian3.normalize(
              C.Cartesian3.cross(right, direction, new C.Cartesian3()),
              new C.Cartesian3(),
            );
            scene.camera.setView({
              destination: eye,
              orientation: { direction, up: realUp },
            });
          };

          const ra = C.Math.toRadians(sceneContract.siriusRaDegrees);
          const dec = C.Math.toRadians(sceneContract.siriusDecDegrees);
          const temeDirection = new C.Cartesian3(
            Math.cos(dec) * Math.cos(ra),
            Math.cos(dec) * Math.sin(ra),
            Math.sin(dec),
          );
          const temeToFixed = C.Transforms.computeTemeToPseudoFixedMatrix(
            time,
            new C.Matrix3(),
          );
          const siriusFixed = C.Cartesian3.normalize(
            C.Matrix3.multiplyByVector(
              temeToFixed,
              temeDirection,
              new C.Cartesian3(),
            ),
            new C.Cartesian3(),
          );
          const blankFixed = C.Cartesian3.negate(
            siriusFixed,
            new C.Cartesian3(),
          );

          aimAt(siriusFixed);
          await renderFrames(sceneContract.warmupFrames);
          if (scene.skyBox?.starField) {
            scene.skyBox.starField.intensity = 1.0;
            scene.skyBox.starField.show = false;
          }
          await renderFrames(sceneContract.settleFrames);
          const off = await grab();

          if (scene.skyBox?.starField) scene.skyBox.starField.show = true;
          await renderFrames(sceneContract.settleFrames);
          const sirius = await grab();

          aimAt(blankFixed);
          await renderFrames(sceneContract.settleFrames);
          const blank = await grab();

          aimAt(siriusFixed);
          if (scene.skyBox?.starField)
            scene.skyBox.starField.intensity = sceneContract.highIntensity;
          await renderFrames(sceneContract.settleFrames);
          const bright = await grab();

          let stats;
          try {
            stats = scene.skyBox?.starField
              ? scene.skyBox.starField.getDebugStatistics(scene.frameState)
              : { missingStarField: true };
          } catch (error) {
            stats = { error: String(error) };
          }
          return { off, sirius, blank, bright, hasStarField, stats };
        },
        {
          ...C12_11_STAR_CATALOG_SCENE,
          runtimePath: C12_11_STAR_CATALOG_RUNTIME_PATH,
        },
      ),
      PAGE_TIMEOUT_MS,
      "C12-11 browser acquisition",
    );

    await withTimeout(
      page.evaluate(async () => {
        const device = window.viewer?.scene?.context?._device;
        if (device?.queue?.onSubmittedWorkDone)
          await device.queue.onSubmittedWorkDone();
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
      }),
      GPU_DRAIN_TIMEOUT_MS,
      "WebGPU submission/error drain",
    );
    webgpu = await collectGateErrors(page);
    return {
      measured,
      servedEntry,
      gpuGate,
      errors: {
        console: boundDiagnosticStrings(consoleErrors),
        page: boundDiagnosticStrings(pageErrors),
        request: boundDiagnosticStrings(requestErrors),
        response: boundDiagnosticStrings(responseErrors),
        webgpu: boundDiagnosticStrings([...gpuConsoleErrors, ...webgpu.errors]),
        deviceLoss:
          webgpu.deviceLost === null
            ? null
            : String(webgpu.deviceLost).slice(0, 4096),
      },
      cleanup,
    };
  } catch (caught) {
    const error =
      caught instanceof Error
        ? caught
        : new Error("non-Error C12-11 runtime failure", { cause: caught });
    const runtime = {
      errors: {
        console: [...consoleErrors],
        page: [...pageErrors],
        request: [...requestErrors],
        response: [...responseErrors],
        webgpu: [...gpuConsoleErrors, ...webgpu.errors],
        deviceLoss: webgpu.deviceLost,
      },
      gpuGate,
      cleanup,
    };
    try {
      error.c1211Runtime = runtime;
    } catch (assignmentError) {
      const wrapped = new AggregateError(
        [error, assignmentError],
        "C12-11 runtime diagnostics attachment failed",
        { cause: assignmentError },
      );
      wrapped.c1211Runtime = runtime;
      throw wrapped;
    }
    throw error;
  } finally {
    const pageResult = await closeBounded(page, "C12-11 page");
    watchdogState.page = null;
    cleanup.pageClosed = pageResult.closed;
    cleanup.timedOut ||= pageResult.timedOut;
    if (pageResult.error) cleanup.errors.push(pageResult.error);
    const browserResult = await closeBounded(browser, "C12-11 browser");
    watchdogState.browser = null;
    cleanup.browserClosed = browserResult.closed;
    cleanup.timedOut ||= browserResult.timedOut;
    if (browserResult.error) cleanup.errors.push(browserResult.error);
  }
}

function analyzeAndWriteCaptures(paths, runId, acquired) {
  const images = acquired.measured;
  const bindings = [];
  const captures = {};
  for (const label of C12_11_STAR_CATALOG_CAPTURE_LABELS) {
    const image = images[label];
    const binding = writeC1211Capture(
      paths,
      runId,
      label,
      decodePngDataUrl(image.png, label),
    );
    bindings.push(binding);
    captures[label] = {
      label,
      width: image.w,
      height: image.h,
      sha256: binding.sha256,
    };
  }
  // The certifying metrics are decoded from the retained PNG files, not from
  // a parallel page-returned pixel array. The same derivation runs again in
  // finalization before latest.json can move.
  const derived = deriveC1211MetricsFromCaptureFiles(paths);
  return {
    bindings,
    runtime: {
      completed: true,
      renderer: C12_11_STAR_CATALOG_RENDERER,
      hasStarField: acquired.measured.hasStarField,
      metrics: derived.metrics,
      captures,
      diagnostics: {
        stats: acquired.measured.stats,
        siriusStrongest: derived.census.sirius.strongest,
        offStrongest: derived.census.off.strongest,
        blankStrongest: derived.census.blank.strongest,
        nearestSource: derived.nearestSource,
        offlinePrediction: C12_11_STAR_CATALOG_SCENE.offlinePrediction,
      },
      errors: acquired.errors,
      gpuGate: acquired.gpuGate,
    },
  };
}

function buildContract() {
  return {
    renderer: C12_11_STAR_CATALOG_RENDERER,
    runtimePath: C12_11_STAR_CATALOG_RUNTIME_PATH,
    viewerPath: C12_11_STAR_CATALOG_VIEWER_PATH,
    captureLabels: [...C12_11_STAR_CATALOG_CAPTURE_LABELS],
    scene: C12_11_STAR_CATALOG_SCENE,
  };
}

function boundDiagnosticStrings(value) {
  return Array.isArray(value)
    ? value.slice(0, 32).map((entry) => String(entry).slice(0, 4096))
    : [];
}

function boundRuntimeDiagnostics(value) {
  if (!value || typeof value !== "object") return null;
  const errors = value.errors ?? {};
  const gpuGate = value.gpuGate;
  const cleanup = value.cleanup ?? {};
  return {
    errors: {
      console: boundDiagnosticStrings(errors.console),
      page: boundDiagnosticStrings(errors.page),
      request: boundDiagnosticStrings(errors.request),
      response: boundDiagnosticStrings(errors.response),
      webgpu: boundDiagnosticStrings(errors.webgpu),
      deviceLoss:
        errors.deviceLoss === null || errors.deviceLoss === undefined
          ? null
          : String(errors.deviceLoss).slice(0, 4096),
    },
    gpuGate:
      gpuGate && typeof gpuGate === "object"
        ? {
            found: Number.isSafeInteger(gpuGate.found) ? gpuGate.found : 0,
            armed: Number.isSafeInteger(gpuGate.armed) ? gpuGate.armed : 0,
            total: Number.isSafeInteger(gpuGate.total) ? gpuGate.total : 0,
          }
        : null,
    cleanup: {
      pageClosed: cleanup.pageClosed === true,
      browserClosed: cleanup.browserClosed === true,
      timedOut: cleanup.timedOut === true,
      errors: boundDiagnosticStrings(cleanup.errors),
    },
  };
}

function errorDiagnostics(error, stage) {
  const message = String(
    error?.message ?? error ?? "unknown C12-11 probe error",
  );
  return {
    schema: C12_11_STAR_CATALOG_DIAGNOSTICS_SCHEMA,
    stage,
    message: message.slice(0, 4096) || "unknown C12-11 probe error",
    stack:
      typeof error?.stack === "string" ? error.stack.slice(0, 16_384) : null,
    timeoutMs: Number.isSafeInteger(error?.c1211TimeoutMs)
      ? error.c1211TimeoutMs
      : null,
    runtime: boundRuntimeDiagnostics(error?.c1211Runtime),
  };
}

export async function runC1211StarCatalogProbe(options = {}) {
  const base = validateC1211LoopbackBase(options.base ?? defaultBase);
  const runId = options.runId ?? randomUUID();
  const paths = createC1211ArtifactPaths(
    runId,
    options.outputDirectory ?? defaultOutputDirectory,
  );
  const ownership = beginC1211EvidenceRun(paths, runId);
  let stage = "preflight";
  let watchdog;
  const watchdogState = {
    expired: false,
    failure: null,
    browser: null,
    page: null,
    abortController: new AbortController(),
  };
  const throwIfWatchdogExpired = () => {
    if (!watchdogState.expired) return;
    throw watchdogState.failure;
  };
  try {
    watchdog = setTimeout(() => {
      watchdogState.expired = true;
      const failure = new Error(
        `C12-11 watchdog expired after ${WATCHDOG_MS} ms`,
      );
      failure.c1211TimeoutMs = WATCHDOG_MS;
      watchdogState.failure = failure;
      watchdogState.abortController.abort(failure);
      // Closing the owning browser interrupts an in-flight page operation. We
      // then await that operation's rejection before publishing ERROR, so no
      // timed-out acquisition continues writing behind a finalized report.
      void watchdogState.browser?.close().catch(() => {});
    }, WATCHDOG_MS);
    const execute = async () => {
      const protectedBefore = protectedHistoricalIdentity();
      assertProtectedHistoricalFrozen(protectedBefore);
      const localStart = identityList(C12_11_STAR_CATALOG_SOURCE_FILES);
      const g3Start = collectG3Start();
      const buildIdentityStart = collectBuildIdentity();
      const servedEntryPreflight = await servedEntryIdentity(
        base.origin,
        watchdogState.abortController.signal,
      );
      throwIfWatchdogExpired();

      stage = "browser";
      const acquired = await acquireRuntime(
        base,
        options.headed === true,
        watchdogState,
      );
      const servedEntry = {
        ...acquired.servedEntry,
        matchesLocalBuildEntry:
          acquired.servedEntry.matchesLocalBuildEntry === true &&
          servedEntryPreflight.matchesLocalBuildEntry === true &&
          acquired.servedEntry.url === servedEntryPreflight.url &&
          acquired.servedEntry.status === servedEntryPreflight.status &&
          acquired.servedEntry.byteLength === servedEntryPreflight.byteLength &&
          acquired.servedEntry.sha256 === servedEntryPreflight.sha256,
      };
      throwIfWatchdogExpired();
      stage = "capture-publication";
      const analyzed = analyzeAndWriteCaptures(paths, runId, acquired);

      stage = "final-provenance";
      const localEnd = identityList(C12_11_STAR_CATALOG_SOURCE_FILES);
      const protectedAfter = protectedHistoricalIdentity();
      assertProtectedHistoricalFrozen(protectedAfter);
      const g3Prerequisite = finishG3(g3Start);
      const buildSourceIdentity = finishBuildIdentity(buildIdentityStart);
      const provenance = {
        schema: C12_11_STAR_CATALOG_PROVENANCE_SCHEMA,
        gitHead: safeGitHead(),
        localStart,
        localEnd,
        localStable:
          stableC1211StarCatalogJson(localStart) ===
          stableC1211StarCatalogJson(localEnd),
        buildSourceIdentity,
        servedEntry,
        g3Prerequisite,
        protectedHistorical: {
          before: protectedBefore,
          after: protectedAfter,
          stable:
            stableC1211StarCatalogJson(protectedBefore) ===
            stableC1211StarCatalogJson(protectedAfter),
        },
      };
      const report = {
        runId,
        contract: buildContract(),
        provenance,
        captureBindings: analyzed.bindings,
        runtime: analyzed.runtime,
        cleanup: acquired.cleanup,
      };
      const artifact = materializeC1211StarCatalogArtifact(report);
      const valid = validateC1211StarCatalogFinalArtifact(artifact);
      if (!valid.ok)
        throw new Error(
          `C12-11 self-validation failed: ${valid.reasons.join("; ")}`,
        );
      stage = "final-publication";
      throwIfWatchdogExpired();
      const publication = finalizeC1211Evidence(paths, artifact, ownership);
      return { artifact, publication, paths };
    };
    return await execute();
  } catch (caught) {
    if (caught?.retainC1211Running) throw caught;
    let error = caught;
    if (
      watchdogState.expired &&
      watchdogState.failure &&
      error !== watchdogState.failure
    ) {
      watchdogState.failure.cause = error;
      if (error?.c1211Runtime)
        watchdogState.failure.c1211Runtime = error.c1211Runtime;
      error = watchdogState.failure;
    }
    const artifact = createC1211StarCatalogErrorArtifact(
      runId,
      errorDiagnostics(error, stage),
    );
    const publication = finalizeC1211Evidence(paths, artifact, ownership);
    return { artifact, publication, paths, error };
  } finally {
    clearTimeout(watchdog);
  }
}

function usage() {
  console.log(
    "Usage: node Tools/visual-regression/probe-stars-catalog.mjs " +
      "[--base URL] [--output-directory DIR] [--headed]\n\n" +
      "Requires an already-running loopback server and a current Build/CesiumUnminified build.",
  );
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const take = () => {
      const value = argv[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      return value;
    };
    if (argument === "--base") options.base = take();
    else if (argument === "--output-directory")
      options.outputDirectory = path.resolve(take());
    else if (argument === "--headed") options.headed = true;
    else if (argument === "--help") {
      usage();
      process.exit(0);
    } else throw new Error(`unknown argument ${argument}`);
  }
  return options;
}

async function main() {
  try {
    const result = await runC1211StarCatalogProbe(
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
    process.exitCode = exitCodeForC1211StarCatalogStatus(
      result.artifact.status,
    );
  } catch (error) {
    console.error(
      `[probe-stars-catalog] ERROR: ${String(error?.message ?? error)}`,
    );
    process.exitCode = exitCodeForC1211StarCatalogStatus("ERROR");
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const processWatchdog = setTimeout(() => {
    console.error(
      "[probe-stars-catalog] PROCESS WATCHDOG FIRED after " +
        PROCESS_WATCHDOG_MS +
        " ms; the in-run watchdog did not settle - forcing ERROR exit",
    );
    process.exit(2);
  }, PROCESS_WATCHDOG_MS);
  processWatchdog.unref?.();
  try {
    await main();
  } catch (error) {
    // main() self-catches; this fires only if its catch body itself threw.
    // Node's default exit 1 would collide with the FAIL tier, so route the
    // escape to ERROR explicitly.
    console.error("[probe-stars-catalog] uncaught failure - ERROR (2):", error);
    process.exitCode = 2;
  } finally {
    clearTimeout(processWatchdog);
  }
}
