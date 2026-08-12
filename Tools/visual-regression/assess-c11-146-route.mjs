#!/usr/bin/env node
/**
 * C11-146 authoritative route wrapper and artifact assessor.
 *
 * Recommended:
 *   node Tools/visual-regression/assess-c11-146-route.mjs run
 *
 * The `run` command fingerprints local + served inputs before and after the
 * exact clean moving-altitude route, preserves stdout/stderr, assesses the raw
 * campaign artifact, and writes only run-unique evidence. A first non-green
 * assessment is additionally preserved with create-new semantics.
 *
 * A split workflow is also supported for machine-lane coordination:
 *   ... prepare --output <preflight.json>
 *   node Tools/visual-regression/run-performance-campaign.mjs ...
 *   ... assess --preflight <preflight.json> --artifact <raw.json>
 */

import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  C11_146_ARTIFACT_PREFIX,
  C11_146_RUNTIME_PATH,
  C11_146_SERVER_ORIGIN,
  C11_146_WORKLOAD_ID,
  assessC11146RouteArtifact,
  collectC11146LocalProvenance,
  fingerprintC11146Bytes,
  preserveC11146FirstRed,
  writeC11146UniqueJson,
} from "./lib/c11-146-route-evidence.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(HERE, "..", "..");
const DEFAULT_OUTPUT_DIRECTORY = path.resolve(HERE, "output", "performance");
const DEFAULT_FIRST_RED = path.join(
  DEFAULT_OUTPUT_DIRECTORY,
  "c11-146-first-complete-route.first-red.json",
);
const DEFAULT_BASE_URL = C11_146_SERVER_ORIGIN;
const DEFAULT_TIMEOUT_MS = 300_000;

function usage() {
  console.log(`Usage:
  node Tools/visual-regression/assess-c11-146-route.mjs run [options]
  node Tools/visual-regression/assess-c11-146-route.mjs prepare --output FILE [options]
  node Tools/visual-regression/assess-c11-146-route.mjs assess --preflight FILE --artifact FILE [options]

Options:
  --base-url URL       Local server origin (default http://localhost:8080)
  --output-dir DIR     Run-unique artifact directory
  --output FILE        Unique prepare/assessment output path
  --first-red FILE     Write-once first-red path
  --preflight FILE     Pre-route snapshot for assess
  --artifact FILE      Raw performance artifact for assess
  --timeout-ms N       Runner watchdog for run (default 300000)
  --help               Show this help

Exit: 0 accepted, 1 product/protocol failure, 2 exception, 3 structural/provenance.`);
}

function parseArguments(argv) {
  const values = [...argv];
  const command = values.shift() ?? "run";
  if (command === "--help") {
    usage();
    return null;
  }
  if (!["run", "prepare", "assess"].includes(command)) {
    throw new Error(`unknown command ${command}`);
  }
  const options = {
    command,
    baseUrl: DEFAULT_BASE_URL,
    outputDirectory: DEFAULT_OUTPUT_DIRECTORY,
    output: null,
    firstRed: DEFAULT_FIRST_RED,
    preflight: null,
    artifact: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let index = 0; index < values.length; index++) {
    const argument = values[index];
    if (argument === "--base-url") {
      options.baseUrl = values[++index];
    } else if (argument === "--output-dir") {
      options.outputDirectory = path.resolve(values[++index]);
    } else if (argument === "--output") {
      options.output = path.resolve(values[++index]);
    } else if (argument === "--first-red") {
      options.firstRed = path.resolve(values[++index]);
    } else if (argument === "--preflight") {
      options.preflight = path.resolve(values[++index]);
    } else if (argument === "--artifact") {
      options.artifact = path.resolve(values[++index]);
    } else if (argument === "--timeout-ms") {
      options.timeoutMs = Number.parseInt(values[++index], 10);
    } else if (argument === "--help") {
      usage();
      return null;
    } else {
      throw new Error(`unknown option ${argument}`);
    }
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new Error("--timeout-ms must be a positive integer");
  }
  const parsedBaseUrl = new URL(options.baseUrl);
  if (
    parsedBaseUrl.origin !== C11_146_SERVER_ORIGIN ||
    parsedBaseUrl.pathname !== "/" ||
    parsedBaseUrl.search !== "" ||
    parsedBaseUrl.hash !== ""
  ) {
    throw new Error(
      `--base-url must identify the manifest's authoritative origin ${C11_146_SERVER_ORIGIN}`,
    );
  }
  options.baseUrl = parsedBaseUrl.origin;
  if (command === "prepare" && !options.output) {
    throw new Error("prepare requires --output");
  }
  if (command === "assess" && (!options.preflight || !options.artifact)) {
    throw new Error("assess requires --preflight and --artifact");
  }
  return options;
}

function gitValue(args) {
  try {
    return execFileSync("git", args, {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function collectRepositoryIdentity() {
  const commit = gitValue(["rev-parse", "HEAD"]);
  const branch = gitValue(["branch", "--show-current"]);
  return {
    commit,
    branch,
    dirty: Boolean(gitValue(["status", "--porcelain"])),
    ok: Boolean(commit && branch),
  };
}

async function fetchRuntimeIdentity(baseUrl, timeoutMs = 15_000) {
  const url = new URL(C11_146_RUNTIME_PATH, baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      url: response.url,
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get("content-type"),
      ...fingerprintC11146Bytes(bytes),
    };
  } catch (error) {
    return {
      url: url.href,
      status: null,
      ok: false,
      error: String(error?.stack ?? error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function collectSnapshot(runId, baseUrl) {
  return {
    schemaVersion: 1,
    kind: "c11-146-route-provenance-snapshot",
    runId,
    generatedAt: new Date().toISOString(),
    baseUrl,
    repository: collectRepositoryIdentity(),
    local: collectC11146LocalProvenance({ root: REPOSITORY_ROOT }),
    servedRuntime: await fetchRuntimeIdentity(baseUrl),
  };
}

function preflightCanLaunch(snapshot) {
  const localRuntime = snapshot?.local?.files?.runtimeEntry;
  const served = snapshot?.servedRuntime;
  return (
    snapshot?.repository?.ok === true &&
    snapshot?.local?.ok === true &&
    served?.ok === true &&
    served?.status === 200 &&
    localRuntime?.sha256 === served?.sha256 &&
    localRuntime?.byteLength === served?.byteLength
  );
}

function readJsonWithIdentity(filePath) {
  const bytes = fs.readFileSync(filePath);
  return {
    value: JSON.parse(bytes.toString("utf8")),
    identity: fingerprintC11146Bytes(bytes, filePath),
  };
}

function serializableProcessResult(result, stdoutPath, stderrPath) {
  return {
    status: result?.status ?? null,
    signal: result?.signal ?? null,
    error: result?.error ? String(result.error?.stack ?? result.error) : null,
    stdout: stdoutPath,
    stderr: stderrPath,
  };
}

function routeCommand(rawArtifact) {
  return [
    path.resolve(HERE, "run-performance-campaign.mjs"),
    "--manifest",
    path.resolve(HERE, "performance-workloads.json"),
    "--workload",
    C11_146_WORKLOAD_ID,
    "--renderer",
    "both",
    "--repetitions",
    "1",
    "--no-gpu-timestamps",
    "--output",
    rawArtifact,
  ];
}

function runRoute(rawArtifact, stdoutPath, stderrPath, timeoutMs) {
  const stdout = fs.openSync(stdoutPath, "wx");
  let stderr = null;
  try {
    stderr = fs.openSync(stderrPath, "wx");
    return spawnSync(process.execPath, routeCommand(rawArtifact), {
      cwd: REPOSITORY_ROOT,
      env: process.env,
      stdio: ["ignore", stdout, stderr],
      timeout: timeoutMs,
      windowsHide: true,
    });
  } finally {
    fs.closeSync(stdout);
    if (stderr !== null) {
      fs.closeSync(stderr);
    }
  }
}

function safeRunId(value) {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value)
    ? value
    : randomUUID();
}

function assessmentPaths(options, runId) {
  const prefix = `${C11_146_ARTIFACT_PREFIX}.run-${runId}`;
  return {
    raw: path.join(options.outputDirectory, `${prefix}.raw.json`),
    preflight: path.join(options.outputDirectory, `${prefix}.preflight.json`),
    postflight: path.join(options.outputDirectory, `${prefix}.postflight.json`),
    stdout: path.join(options.outputDirectory, `${prefix}.stdout.log`),
    stderr: path.join(options.outputDirectory, `${prefix}.stderr.log`),
    assessment:
      options.output ??
      path.join(options.outputDirectory, `${prefix}.assessment.json`),
  };
}

function printSummary(assessment, outputPath) {
  console.log(
    JSON.stringify(
      {
        campaign: assessment.campaign,
        runId: assessment.runId,
        status: assessment.status,
        exitCode: assessment.exitCode,
        accepted: assessment.accepted,
        output: path
          .relative(REPOSITORY_ROOT, outputPath)
          .replaceAll("\\", "/"),
        firstRed: assessment.firstRed,
        runSummaries: assessment.runSummaries,
        errors: assessment.errors,
        productFailures: assessment.productFailures,
        structuralFailures: assessment.structuralFailures,
      },
      null,
      2,
    ),
  );
}

function persistAssessment(options, assessment, outputPath) {
  const firstRed = preserveC11146FirstRed(options.firstRed, assessment);
  const payload = {
    ...firstRed.payload,
    firstRed: {
      ...firstRed.payload.firstRed,
      identity: firstRed.identity,
    },
  };
  const outputIdentity = writeC11146UniqueJson(outputPath, payload);
  return {
    payload: { ...payload, outputIdentity },
    outputIdentity,
  };
}

async function prepare(options) {
  const runId = randomUUID();
  const paths = assessmentPaths(options, runId);
  const snapshot = await collectSnapshot(runId, options.baseUrl);
  writeC11146UniqueJson(options.output, snapshot);
  const ready = preflightCanLaunch(snapshot);
  console.log(
    JSON.stringify(
      {
        campaign: "C11-146",
        runId,
        status: ready ? "READY" : "STRUCTURAL",
        output: options.output,
        rawArtifact: paths.raw,
        localReady: snapshot.local.ok,
        servedRuntimeReady: snapshot.servedRuntime.ok,
      },
      null,
      2,
    ),
  );
  return ready ? 0 : 3;
}

async function assessExisting(options) {
  const preflight = readJsonWithIdentity(options.preflight).value;
  const runId = safeRunId(preflight?.runId);
  const paths = assessmentPaths(options, runId);
  let artifact = null;
  let artifactIdentity = null;
  let exception = null;
  try {
    const read = readJsonWithIdentity(options.artifact);
    artifact = read.value;
    artifactIdentity = read.identity;
  } catch (error) {
    exception = String(error?.stack ?? error);
  }
  const postflight = await collectSnapshot(runId, options.baseUrl);
  writeC11146UniqueJson(paths.postflight, postflight);
  const assessment = assessC11146RouteArtifact({
    artifact,
    artifactIdentity,
    startSnapshot: preflight,
    endSnapshot: postflight,
    exception,
    runId,
  });
  const persisted = persistAssessment(options, assessment, paths.assessment);
  printSummary(persisted.payload, paths.assessment);
  return assessment.exitCode;
}

async function run(options) {
  const runId = randomUUID();
  const paths = assessmentPaths(options, runId);
  fs.mkdirSync(options.outputDirectory, { recursive: true });
  const preflight = await collectSnapshot(runId, options.baseUrl);
  writeC11146UniqueJson(paths.preflight, preflight);

  let processResult = null;
  let artifact = null;
  let artifactIdentity = null;
  let exception = null;
  if (preflightCanLaunch(preflight)) {
    const rawResult = runRoute(
      paths.raw,
      paths.stdout,
      paths.stderr,
      options.timeoutMs,
    );
    processResult = serializableProcessResult(
      rawResult,
      paths.stdout,
      paths.stderr,
    );
    try {
      const read = readJsonWithIdentity(paths.raw);
      artifact = read.value;
      artifactIdentity = read.identity;
    } catch (error) {
      exception = String(error?.stack ?? error);
    }
  }
  const postflight = await collectSnapshot(runId, options.baseUrl);
  writeC11146UniqueJson(paths.postflight, postflight);
  const assessment = assessC11146RouteArtifact({
    artifact,
    artifactIdentity,
    startSnapshot: preflight,
    endSnapshot: postflight,
    wrapperProcess: processResult,
    exception,
    runId,
  });
  const persisted = persistAssessment(options, assessment, paths.assessment);
  printSummary(persisted.payload, paths.assessment);
  return assessment.exitCode;
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArguments(argv);
    if (!options) {
      return 0;
    }
    if (options.command === "prepare") {
      return await prepare(options);
    }
    if (options.command === "assess") {
      return await assessExisting(options);
    }
    return await run(options);
  } catch (error) {
    console.error(String(error?.stack ?? error));
    return 2;
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  process.exitCode = await main();
}
