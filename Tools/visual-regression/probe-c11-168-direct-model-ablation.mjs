#!/usr/bin/env node
/**
 * C11-168 fresh-process direct-model causal discriminator.
 *
 * Runs two exact reverse-order quartets. Every leg launches a separate Node
 * runner, which launches one fresh Edge process and measures the canonical
 * 600-frame resident route with API instrumentation and GPU timestamps off.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assessC11168DirectModelAblationCampaign,
  c11168LegId,
  C11_168_DIRECT_MODEL_ABLATION_CONFIG,
  C11_168_LOCAL_EXECUTION_PATHS,
  C11_168_SERVED_EXECUTION_PATHS,
  monitorC11168ChildProcess,
  terminateC11168ChildTree,
} from "./lib/c11-168-direct-model-ablation.mjs";

const toolDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = resolve(toolDirectory, "..", "..");
const runnerPath = resolve(toolDirectory, "run-performance-campaign.mjs");
const manifestPath = resolve(
  repositoryDirectory,
  C11_168_DIRECT_MODEL_ABLATION_CONFIG.manifestFile,
);
const defaultOutputPath = resolve(
  toolDirectory,
  "output",
  "performance",
  "c11-168-direct-model-ablation.json",
);

function usage() {
  console.log(`Usage: node Tools/visual-regression/probe-c11-168-direct-model-ablation.mjs [options]

Options:
  --output FILE  Summary artifact (default c11-168-direct-model-ablation.json)
  --headed       Launch visible Edge windows
  --help         Show this help

The local Cesium server and a clean, current Build/CesiumUnminified bundle must
already exist. The canonical protocol is locked: two reverse-order quartets,
one fresh process per leg, 600 frames, no API instrumentation, no GPU timestamps.`);
}

function parseArguments(argv) {
  const options = { output: defaultOutputPath, headed: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--output") {
      const value = argv[++index];
      if (!value) throw new Error("--output requires a file");
      options.output = resolve(value);
    } else if (argument === "--headed") {
      options.headed = true;
    } else if (argument === "--help") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument ${argument}`);
    }
  }
  return options;
}

async function fileIdentity(path) {
  const bytes = await readFile(path);
  return {
    path: relative(repositoryDirectory, path).replaceAll("\\", "/"),
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex").toUpperCase(),
  };
}

async function servedIdentity(baseUrl, path) {
  const url = new URL(`/${path}`, baseUrl);
  const response = await fetch(url, {
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(
      `[structural] ${url.href} returned HTTP ${response.status}`,
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    path,
    url: url.href,
    status: response.status,
    contentType: response.headers.get("content-type"),
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex").toUpperCase(),
  };
}

async function captureFrozenInputIdentities() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const localFiles = await Promise.all(
    C11_168_LOCAL_EXECUTION_PATHS.map((path) =>
      fileIdentity(resolve(repositoryDirectory, path)),
    ),
  );
  const servedFiles = [];
  for (const path of C11_168_SERVED_EXECUTION_PATHS) {
    servedFiles.push(await servedIdentity(manifest.baseUrl, path));
  }
  return {
    schemaVersion: 1,
    localFiles,
    servedFiles,
  };
}

async function requireFrozenInputs(expected, phase) {
  const observed = await captureFrozenInputIdentities();
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    throw new Error(
      `[structural] C11-168 source/build identity changed ${phase}; no cross-leg causal claim is allowed`,
    );
  }
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`[structural] unreadable ${label} at ${path}`, {
      cause: error,
    });
  }
}

async function requireOwnedLock(lockPath, runId) {
  const record = await readJson(lockPath, "C11-168 lock");
  if (
    record?.schemaVersion !== 1 ||
    record?.kind !== "c11-168-direct-model-causal-discriminator-lock" ||
    record?.runId !== runId
  ) {
    throw new Error(
      `[structural] C11-168 lock ownership mismatch for run ${runId}`,
    );
  }
  return record;
}

async function requireCanonicalRun(options, runId) {
  const record = await readJson(options.output, "C11-168 canonical artifact");
  if (record?.runId !== runId) {
    throw new Error(
      `[structural] C11-168 canonical artifact is not owned by run ${runId}`,
    );
  }
  return record;
}

async function persistInitialRunning(options, lockPath, value, runId) {
  if (
    value?.runId !== runId ||
    value?.status !== "RUNNING" ||
    value?.incomplete !== true
  ) {
    throw new Error("invalid initial C11-168 RUNNING marker");
  }
  await requireOwnedLock(lockPath, runId);
  await writeFile(
    options.output,
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
  await requireOwnedLock(lockPath, runId);
  const persisted = await requireCanonicalRun(options, runId);
  if (persisted.status !== "RUNNING" || persisted.incomplete !== true) {
    throw new Error("initial C11-168 RUNNING marker did not persist");
  }
}

async function writeOwnedJsonAtomic(options, lockPath, value, runId) {
  if (value?.runId !== runId) {
    throw new Error(
      `[structural] refusing a canonical C11-168 write for another run id`,
    );
  }
  const temporaryPath = `${options.output}.${runId}.tmp`;
  try {
    await requireOwnedLock(lockPath, runId);
    await requireCanonicalRun(options, runId);
    await writeFile(
      temporaryPath,
      `${JSON.stringify(value, null, 2)}\n`,
      "utf8",
    );
    await requireOwnedLock(lockPath, runId);
    await requireCanonicalRun(options, runId);
    await rename(temporaryPath, options.output);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") {
        console.error(String(cleanupError?.stack ?? cleanupError));
      }
    }
    const persistenceError = new Error(
      `[persistence] C11-168 canonical artifact update failed for run ${runId}`,
      { cause: error },
    );
    persistenceError.c11168PersistenceFailure = true;
    throw persistenceError;
  }
}

async function releaseOwnedLock(options, lockPath, runId) {
  await requireOwnedLock(lockPath, runId);
  await requireCanonicalRun(options, runId);
  await unlink(lockPath);
}

function terminateChildTree(child, force) {
  return terminateC11168ChildTree({
    child,
    force,
    platform: process.platform,
    spawnTaskkill: (command, args) =>
      spawn(command, args, {
        cwd: repositoryDirectory,
        stdio: "ignore",
        windowsHide: true,
      }),
  });
}

function runChild(args) {
  const child = spawn(process.execPath, args, {
    cwd: repositoryDirectory,
    stdio: ["ignore", "ignore", "inherit"],
    windowsHide: true,
  });
  return monitorC11168ChildProcess({
    child,
    timeoutMs: C11_168_DIRECT_MODEL_ABLATION_CONFIG.childProcessTimeoutMs,
    terminationGraceMs:
      C11_168_DIRECT_MODEL_ABLATION_CONFIG.childTerminationGraceMs,
    hardDeadlineMs:
      C11_168_DIRECT_MODEL_ABLATION_CONFIG.childHardTerminationDeadlineMs,
    terminate: terminateChildTree,
    unrefTimers: true,
  });
}

const quartetSchedules = C11_168_DIRECT_MODEL_ABLATION_CONFIG.quartetSchedules;

const options = parseArguments(process.argv.slice(2));
const runId = randomUUID();
const lockPath = `${options.output}.lock`;
const rawDirectory = resolve(
  repositoryDirectory,
  C11_168_DIRECT_MODEL_ABLATION_CONFIG.rawArtifactRoot,
  runId,
);
const rawDirectoryRelative = relative(
  repositoryDirectory,
  rawDirectory,
).replaceAll("\\", "/");
const startedAt = new Date().toISOString();
const lockRecord = {
  schemaVersion: 1,
  kind: "c11-168-direct-model-causal-discriminator-lock",
  runId,
  startedAt,
};
try {
  await writeFile(lockPath, `${JSON.stringify(lockRecord, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
} catch (error) {
  if (error?.code === "EEXIST") {
    throw new Error(
      `C11-168 lock exists at ${lockPath}; verify no discriminator remains before removing a stale lock`,
      { cause: error },
    );
  }
  throw error;
}

const rawLegs = [];
const runningReport = {
  schemaVersion: 1,
  kind: "c11-168-direct-model-causal-discriminator",
  runId,
  status: "RUNNING",
  incomplete: true,
  pass: null,
  exitCode: null,
  generatedAt: new Date().toISOString(),
  config: C11_168_DIRECT_MODEL_ABLATION_CONFIG,
  protocol: {
    orderPairs: quartetSchedules.length,
    quartetSchedules,
    freshProcessPerLeg: true,
    apiInstrumentation: false,
    gpuTimestamps: false,
    conclusionPolicy:
      "a valid non-selected direct-model hypothesis is a completed measurement, not a product FAIL",
  },
  source: null,
  rawDirectory: rawDirectoryRelative,
  completedLegs: [],
  assessment: null,
};

let finalReport;
let exitCode;
let preserveLock = false;
let terminalPersisted = false;

// Ownership and the canonical RUNNING marker are established before source
// capture, raw-directory creation, server fetches, or any child launch. If
// this persistence fails the lock is deliberately retained.
await persistInitialRunning(options, lockPath, runningReport, runId);

try {
  const identities = await captureFrozenInputIdentities();
  runningReport.source = identities;
  await mkdir(rawDirectory, { recursive: true });
  await writeOwnedJsonAtomic(options, lockPath, runningReport, runId);
  let stop = false;
  for (
    let orderPairIndex = 0;
    orderPairIndex < quartetSchedules.length && !stop;
    orderPairIndex++
  ) {
    const schedule = quartetSchedules[orderPairIndex];
    for (
      let executionIndex = 0;
      executionIndex < schedule.length;
      executionIndex++
    ) {
      const leg = schedule[executionIndex];
      const orderPair = orderPairIndex + 1;
      const id = c11168LegId({
        orderPair,
        executionIndex,
        renderer: leg.renderer,
        condition: leg.condition,
      });
      const rawPath = resolve(rawDirectory, `${id}.json`);
      console.error(
        `[c11-168] ${id}: fresh process, ${C11_168_DIRECT_MODEL_ABLATION_CONFIG.measuredFrames} frames`,
      );
      await requireFrozenInputs(identities, `before ${id}`);
      const args = [
        runnerPath,
        "--manifest",
        manifestPath,
        "--renderer",
        leg.renderer,
        "--workload",
        C11_168_DIRECT_MODEL_ABLATION_CONFIG.workloadId,
        "--repetitions",
        String(C11_168_DIRECT_MODEL_ABLATION_CONFIG.repetitionsPerOrder),
        "--frames",
        String(C11_168_DIRECT_MODEL_ABLATION_CONFIG.measuredFrames),
        "--output",
        rawPath,
        "--no-gpu-timestamps",
        "--direct-model-ablation",
        leg.condition,
        ...(options.headed ? ["--headed"] : []),
      ];
      const child = await runChild(args);
      await requireFrozenInputs(identities, `after ${id}`);
      let report = null;
      let readError = null;
      try {
        report = JSON.parse(await readFile(rawPath, "utf8"));
      } catch (error) {
        readError = String(error?.stack ?? error);
      }
      const rawIdentity = report ? await fileIdentity(rawPath) : null;
      rawLegs.push({
        id,
        orderPair,
        executionIndex,
        renderer: leg.renderer,
        condition: leg.condition,
        childProcessId: child.childProcessId,
        subprocessExitCode: child.exitCode,
        subprocessSignal: child.signal,
        subprocessTimedOut: child.timedOut,
        subprocessForcedKill: child.forcedKill,
        subprocessHardDeadlineExceeded: child.hardDeadlineExceeded,
        subprocessTimeoutMs: child.timeoutMs,
        subprocessHardDeadlineMs: child.hardDeadlineMs,
        runId,
        rawDirectory: rawDirectoryRelative,
        inputClosure: identities,
        rawIdentity,
        readError,
        report,
      });
      runningReport.completedLegs = rawLegs.map((entry) => ({
        id: entry.id,
        orderPair: entry.orderPair,
        executionIndex: entry.executionIndex,
        renderer: entry.renderer,
        condition: entry.condition,
        childProcessId: entry.childProcessId,
        subprocessExitCode: entry.subprocessExitCode,
        subprocessSignal: entry.subprocessSignal,
        subprocessTimedOut: entry.subprocessTimedOut,
        subprocessForcedKill: entry.subprocessForcedKill,
        subprocessHardDeadlineExceeded: entry.subprocessHardDeadlineExceeded,
        subprocessTimeoutMs: entry.subprocessTimeoutMs,
        subprocessHardDeadlineMs: entry.subprocessHardDeadlineMs,
        runId: entry.runId,
        rawDirectory: entry.rawDirectory,
        inputClosure: entry.inputClosure,
        rawIdentity: entry.rawIdentity,
        readError: entry.readError,
      }));
      await writeOwnedJsonAtomic(options, lockPath, runningReport, runId);
      if (
        child.timedOut ||
        child.hardDeadlineExceeded ||
        child.exitCode !== 0 ||
        report === null
      ) {
        stop = true;
        break;
      }
    }
  }

  const assessment = assessC11168DirectModelAblationCampaign(rawLegs);
  exitCode = assessment.valid ? 0 : 3;
  finalReport = {
    ...runningReport,
    status: assessment.valid ? "PASS" : "STRUCTURAL",
    incomplete: false,
    pass: assessment.valid,
    exitCode,
    completedAt: new Date().toISOString(),
    completedLegs: runningReport.completedLegs,
    assessment,
  };
  await writeOwnedJsonAtomic(options, lockPath, finalReport, runId);
  terminalPersisted = true;
} catch (error) {
  const errorText = String(error?.stack ?? error);
  if (error?.c11168PersistenceFailure === true) {
    preserveLock = true;
    exitCode = 2;
    finalReport = {
      ...runningReport,
      status: "RUNNING",
      incomplete: true,
      pass: null,
      exitCode: null,
      persistenceFailure: errorText,
    };
    console.error(errorText);
  } else {
    const structural = errorText.includes("[structural]");
    const terminalErrorReport = {
      ...runningReport,
      status: structural ? "STRUCTURAL" : "ERROR",
      incomplete: false,
      pass: false,
      exitCode: structural ? 3 : 2,
      completedAt: new Date().toISOString(),
      error: errorText,
    };
    exitCode = terminalErrorReport.exitCode;
    try {
      await writeOwnedJsonAtomic(options, lockPath, terminalErrorReport, runId);
      finalReport = terminalErrorReport;
      terminalPersisted = true;
    } catch (writeError) {
      preserveLock = true;
      exitCode = 2;
      finalReport = {
        ...runningReport,
        status: "RUNNING",
        incomplete: true,
        pass: null,
        exitCode: null,
        persistenceFailure: String(writeError?.stack ?? writeError),
        pendingError: errorText,
      };
      console.error(String(writeError?.stack ?? writeError));
    }
  }
}

if (!preserveLock && terminalPersisted) {
  try {
    await releaseOwnedLock(options, lockPath, runId);
  } catch (error) {
    const pendingTerminalReport = finalReport;
    const retainedRunningReport = {
      ...runningReport,
      status: "RUNNING",
      incomplete: true,
      pass: null,
      exitCode: null,
      lockReleaseError: String(error?.stack ?? error),
      pendingTerminal: {
        status: pendingTerminalReport.status,
        pass: pendingTerminalReport.pass,
        exitCode: pendingTerminalReport.exitCode,
        completedAt: pendingTerminalReport.completedAt ?? null,
      },
    };
    exitCode = 2;
    try {
      await writeOwnedJsonAtomic(
        options,
        lockPath,
        retainedRunningReport,
        runId,
      );
      finalReport = retainedRunningReport;
    } catch (writeError) {
      finalReport = retainedRunningReport;
      finalReport.persistenceFailure = String(writeError?.stack ?? writeError);
      console.error(String(writeError?.stack ?? writeError));
    }
  }
}

console.log(JSON.stringify(finalReport, null, 2));
console.error(
  `C11-168 ${finalReport.status}: ${finalReport.assessment?.hypothesis?.verdict ?? "no verdict"}`,
);
process.exitCode = exitCode;
