#!/usr/bin/env node
// @purpose Q-152 — close a multi-batch wave with served-build preflights, smoke/sweep/visual gates, and banked receipts. FAIL-CLOSED at HEAD: every step is bindable:false, so every invocation refuses pre-spawn with exit 3 and zero children spawned (decidePreSpawnBindability); Q-152 is open with zero receipts produced by this runner — use the manual three-step per R-2026-09-02-3 instead.
// @status ACTIVE

import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  S5_FINAL_STATUSES,
  S5_STATUS_EXIT_CODES,
  exitCodeForS5Status,
} from "./visual-regression/lib/verdict-exit-gate.mjs";

export const EXIT_CODES = S5_STATUS_EXIT_CODES;

export const REFUSAL_REASONS = Object.freeze({
  BAD_ARGUMENT: "BAD_ARGUMENT",
  MISSING_OPTION_VALUE: "MISSING_OPTION_VALUE",
  WAVE_REQUIRED: "WAVE_REQUIRED",
  INVALID_WAVE: "INVALID_WAVE",
  INVALID_PORT: "INVALID_PORT",
  INVALID_BUCKET_PORT: "INVALID_BUCKET_PORT",
  INVALID_RUNS: "INVALID_RUNS",
  PORT_8080_FORBIDDEN: "PORT_8080_FORBIDDEN",
  PORT_8081_FORBIDDEN: "PORT_8081_FORBIDDEN",
  ENDPOINTS_MUST_DIFFER: "ENDPOINTS_MUST_DIFFER",
  SOURCE_COMMIT_REQUIRED: "SOURCE_COMMIT_REQUIRED",
  SOURCE_DIRTY_REQUIRED: "SOURCE_DIRTY_REQUIRED",
  SOURCE_IDENTITY_REQUIRED: "SOURCE_IDENTITY_REQUIRED",
  BASELINE_REASON_REQUIRED: "BASELINE_REASON_REQUIRED",
  ORIGIN_REWRITE_EXPORTS_MISSING: "ORIGIN_REWRITE_EXPORTS_MISSING",
  SERVED_BUILD_PREFLIGHT_FAILED: "SERVED_BUILD_PREFLIGHT_FAILED",
  PLAN_INVALID: "PLAN_INVALID",
  PLAN_PATH_MISSING: "PLAN_PATH_MISSING",
  CHILD_CONTRACT_ABSENT: "CHILD_CONTRACT_ABSENT",
  CHILD_CONTRACT_MALFORMED: "CHILD_CONTRACT_MALFORMED",
  CHILD_RECEIPT_STALE: "CHILD_RECEIPT_STALE",
  PROVENANCE_MISMATCH: "PROVENANCE_MISMATCH",
  SERVED_SUBJECT_MISMATCH: "SERVED_SUBJECT_MISMATCH",
  DRY_RUN_NON_EXECUTION: "DRY_RUN_NON_EXECUTION",
  CAPTURE_AND_DIFF_UNBINDABLE: "CAPTURE_AND_DIFF_UNBINDABLE",
  DESCENDANT_QUIESCENCE_UNPROVEN: "DESCENDANT_QUIESCENCE_UNPROVEN",
});

export const ERROR_REASONS = Object.freeze({
  ORIGIN_REWRITE_IMPORT_FAILED: "ORIGIN_REWRITE_IMPORT_FAILED",
  SERVED_BUILD_PREFLIGHT_IMPORT_FAILED: "SERVED_BUILD_PREFLIGHT_IMPORT_FAILED",
  SERVED_BUILD_PREFLIGHT_RUNTIME_FAILED:
    "SERVED_BUILD_PREFLIGHT_RUNTIME_FAILED",
  PLAN_STAT_FAILED: "PLAN_STAT_FAILED",
  CHILD_SPAWN_ERROR: "CHILD_SPAWN_ERROR",
  CHILD_TIMEOUT: "CHILD_TIMEOUT",
  CHILD_SIGNAL: "CHILD_SIGNAL",
  CHILD_NULL_EXIT: "CHILD_NULL_EXIT",
  CHILD_UNKNOWN_EXIT: "CHILD_UNKNOWN_EXIT",
  CHILD_CLEANUP_ERROR: "CHILD_CLEANUP_ERROR",
  CHILD_RESULT_READ_FAILED: "CHILD_RESULT_READ_FAILED",
  UNEXPECTED_GATE_ERROR: "UNEXPECTED_GATE_ERROR",
});

const WAVE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const REQUIRED_PREFLIGHT_ARTIFACT_COUNT = 2;
export const CHILD_WATCHDOG_MS = 2 * 60 * 60 * 1000;
export const CHILD_TERMINATE_GRACE_MS = 5_000;
export const CHILD_HARD_STOP_GRACE_MS = 2_000;
export const STEP_RESULT_SCHEMA_VERSION = 1;
const DESCENDANT_QUIESCENCE_LIMITATION =
  "Direct-child close does not prove descendant process-tree quiescence.";

export function makeRefusal(name, message) {
  return Object.freeze({
    name,
    message,
    status: "STRUCTURAL",
    exitCode: exitCodeForS5Status("STRUCTURAL"),
  });
}

export function makeError(name, message) {
  return Object.freeze({
    name,
    message,
    status: "ERROR",
    exitCode: exitCodeForS5Status("ERROR"),
  });
}

function isProblemContract(value) {
  try {
    return (
      value !== null &&
      typeof value === "object" &&
      (value.status === "ERROR" || value.status === "STRUCTURAL") &&
      typeof value.name === "string" &&
      value.name.length > 0 &&
      typeof value.message === "string" &&
      value.exitCode === exitCodeForS5Status(value.status)
    );
  } catch {
    return false;
  }
}

export function foldStatuses(statuses) {
  if (!Array.isArray(statuses) || statuses.length === 0) {
    return "STRUCTURAL";
  }

  let folded = "PASS";
  for (const status of statuses) {
    if (!S5_FINAL_STATUSES.includes(status)) {
      return "ERROR";
    }
    if (exitCodeForS5Status(status) > exitCodeForS5Status(folded)) {
      folded = status;
    }
  }
  return folded;
}

export function parseArgs(argv) {
  const args = {
    wave: null,
    port: 8094,
    bucketPort: 8095,
    runs: 1,
    sourceCommit: null,
    sourceDirty: null,
    sourceIdentity: null,
    updateBaselines: false,
    reason: null,
    dryRun: false,
    argumentError: null,
  };

  const takeValue = (flag, index) => {
    if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
      if (!args.argumentError) {
        args.argumentError = makeRefusal(
          REFUSAL_REASONS.MISSING_OPTION_VALUE,
          `${flag} requires a value.`,
        );
      }
      return { value: null, nextIndex: index };
    }

    return { value: argv[index + 1], nextIndex: index + 1 };
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    switch (token) {
      case "--wave": {
        const taken = takeValue(token, index);
        args.wave = taken.value;
        index = taken.nextIndex;
        break;
      }

      case "--port": {
        const taken = takeValue(token, index);
        args.port = taken.value === null ? Number.NaN : Number(taken.value);
        index = taken.nextIndex;
        break;
      }

      case "--bucket-port": {
        const taken = takeValue(token, index);
        args.bucketPort =
          taken.value === null ? Number.NaN : Number(taken.value);
        index = taken.nextIndex;
        break;
      }

      case "--runs": {
        const taken = takeValue(token, index);
        args.runs = taken.value === null ? Number.NaN : Number(taken.value);
        index = taken.nextIndex;
        break;
      }

      case "--source-commit": {
        const taken = takeValue(token, index);
        args.sourceCommit = taken.value;
        index = taken.nextIndex;
        break;
      }

      case "--source-dirty": {
        const taken = takeValue(token, index);
        args.sourceDirty = taken.value;
        index = taken.nextIndex;
        break;
      }

      case "--source-identity": {
        const taken = takeValue(token, index);
        args.sourceIdentity = taken.value;
        index = taken.nextIndex;
        break;
      }

      case "--reason": {
        const taken = takeValue(token, index);
        args.reason = taken.value?.trim() || null;
        index = taken.nextIndex;
        break;
      }

      case "--update-baselines":
        args.updateBaselines = true;
        break;

      case "--dry-run":
        args.dryRun = true;
        break;

      default:
        if (!args.argumentError) {
          args.argumentError = makeRefusal(
            REFUSAL_REASONS.BAD_ARGUMENT,
            `Unknown argument: ${token}`,
          );
        }
        break;
    }
  }

  return args;
}

function isValidPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

export function decideArgumentRefusal(args) {
  if (args.argumentError) {
    return args.argumentError;
  }

  if (!args.wave) {
    return makeRefusal(
      REFUSAL_REASONS.WAVE_REQUIRED,
      "--wave <id> is required.",
    );
  }

  if (!WAVE_PATTERN.test(args.wave)) {
    return makeRefusal(
      REFUSAL_REASONS.INVALID_WAVE,
      "--wave must contain only letters, digits, dots, underscores, and hyphens.",
    );
  }

  if (!isValidPort(args.port)) {
    return makeRefusal(
      REFUSAL_REASONS.INVALID_PORT,
      "--port must be an integer from 1 through 65535.",
    );
  }

  if (!isValidPort(args.bucketPort)) {
    return makeRefusal(
      REFUSAL_REASONS.INVALID_BUCKET_PORT,
      "--bucket-port must be an integer from 1 through 65535.",
    );
  }

  if (args.port === 8080 || args.bucketPort === 8080) {
    return makeRefusal(
      REFUSAL_REASONS.PORT_8080_FORBIDDEN,
      "Port 8080 is forbidden for the wave-end gate.",
    );
  }

  if (args.port === 8081 || args.bucketPort === 8081) {
    return makeRefusal(
      REFUSAL_REASONS.PORT_8081_FORBIDDEN,
      "Port 8081 is forbidden for the wave-end gate.",
    );
  }

  if (args.port === args.bucketPort) {
    return makeRefusal(
      REFUSAL_REASONS.ENDPOINTS_MUST_DIFFER,
      "--port and --bucket-port must identify different endpoints.",
    );
  }

  if (!Number.isInteger(args.runs) || args.runs < 1) {
    return makeRefusal(
      REFUSAL_REASONS.INVALID_RUNS,
      "--runs must be a positive integer.",
    );
  }

  if (!SOURCE_COMMIT_PATTERN.test(args.sourceCommit ?? "")) {
    return makeRefusal(
      REFUSAL_REASONS.SOURCE_COMMIT_REQUIRED,
      "--source-commit must be a root-supplied 40-hex commit id.",
    );
  }

  if (args.sourceDirty !== "true" && args.sourceDirty !== "false") {
    return makeRefusal(
      REFUSAL_REASONS.SOURCE_DIRTY_REQUIRED,
      "--source-dirty must be root-supplied as true or false.",
    );
  }

  if (!SHA256_PATTERN.test(args.sourceIdentity ?? "")) {
    return makeRefusal(
      REFUSAL_REASONS.SOURCE_IDENTITY_REQUIRED,
      "--source-identity must be a root-supplied 64-hex identity.",
    );
  }

  if (args.updateBaselines && !args.reason) {
    return makeRefusal(
      REFUSAL_REASONS.BASELINE_REASON_REQUIRED,
      '--update-baselines requires --reason "<text>".',
    );
  }

  return null;
}

export function decideOriginRewriteRefusal(moduleNamespace) {
  if (
    typeof moduleNamespace?.installOriginRewrite !== "function" ||
    typeof moduleNamespace?.createGuardedPage !== "function"
  ) {
    return makeRefusal(
      REFUSAL_REASONS.ORIGIN_REWRITE_EXPORTS_MISSING,
      "Tools/visual-regression/lib/sandcastle2-origin-rewrite.mjs must export installOriginRewrite and createGuardedPage.",
    );
  }

  return null;
}

function quoteCommandArgument(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:@=-]+$/.test(text) ? text : JSON.stringify(text);
}

function formatNodeCommand(file, args) {
  return ["node", file, ...args].map(quoteCommandArgument).join(" ");
}

export function buildStepPlan(args) {
  const servedBase = `http://localhost:${args.port}`;
  const sandcastleBase = `http://localhost:${args.bucketPort}`;
  const definitions = [
    {
      name: "variant-smoke-test",
      file: "Tools/variant-smoke-test.mjs",
      args: ["--url", servedBase],
      env: {},
      resultReportPath: null,
      bindability: {
        bindable: false,
        phase: "post-spawn",
        reason:
          "The child emits no canonical typed current-run receipt with source, served-subject, and freshness binding; raw exit 0/1 is not a verdict.",
      },
    },
  ];

  for (let run = 1; run <= args.runs; run += 1) {
    for (const renderer of ["webgl", "webgpu"]) {
      definitions.push({
        name: `sandcastle2-sweep-${renderer}-run-${run}`,
        file: "Tools/visual-regression/sandcastle-smoke.mjs",
        args: ["--sandcastle2", `--renderer=${renderer}`],
        env: {
          PROBE_BASE: servedBase,
          PROBE_SANDCASTLE_BASE: sandcastleBase,
        },
        resultReportPath: `Tools/visual-regression/output/sandcastle2-sweep/report-${renderer}.json`,
        bindability: {
          bindable: false,
          phase: "post-spawn",
          reason:
            "The fixed report lacks a canonical typed status, root-supplied source identity, served-subject identity, and current-run freshness binding; raw exit 0/1/2 is not a verdict.",
        },
      });
    }
  }

  definitions.push({
    name: "visual-regression",
    file: "Tools/visual-regression/capture-and-diff.mjs",
    args: args.updateBaselines
      ? [
          "--update",
          "--confirm-baseline-promotion",
          "--update-rationale",
          args.reason,
          "--reviewed-by",
          `wave-end-gate:${args.wave}`,
        ]
      : [],
    env: {},
    resultReportPath: "Tools/visual-regression/output/report.json",
    bindability: {
      bindable: false,
      phase: "pre-spawn",
      reason:
        "The child reads scenes.json on forbidden port 8080, exposes no served-origin CLI or canonical typed current-run receipt, and invokes Git internally.",
    },
  });

  return Object.freeze(
    definitions.map((definition) =>
      Object.freeze({
        ...definition,
        args: Object.freeze([...definition.args]),
        env: Object.freeze({ ...definition.env }),
        bindability: Object.freeze({ ...definition.bindability }),
        command: formatNodeCommand(definition.file, definition.args),
      }),
    ),
  );
}

export function buildReceipt({
  wave,
  startedAt,
  finishedAt,
  source,
  servedSubject,
  preflight,
  plan,
  steps,
  updateBaselines,
  reason,
  problem = null,
  verdict,
}) {
  return {
    schemaVersion: 1,
    wave,
    startedAt,
    finishedAt,
    source: Object.freeze({
      commit: source.commit,
      dirty: source.dirty,
      identity: source.identity,
    }),
    servedSubject: {
      base: servedSubject.base,
      sandcastleBase: servedSubject.sandcastleBase,
      artifacts: servedSubject.artifacts.map((artifact) => ({ ...artifact })),
    },
    preflight: preflight.map((record) => ({
      ...record,
      reasons: [...record.reasons],
    })),
    plan: plan.map((step) => ({
      name: step.name,
      file: step.file,
      args: [...step.args],
      env: { ...step.env },
      command: step.command,
      resultReportPath: step.resultReportPath,
      bindability: { ...step.bindability },
    })),
    steps: steps.map((step) => ({
      name: step.name,
      command: step.command,
      bindability: { ...step.bindability },
      raw: {
        ...step.raw,
        cleanup: { ...step.raw.cleanup },
        quiescence: { ...step.raw.quiescence },
      },
      normalized: {
        ...step.normalized,
        typedResult: step.normalized.typedResult ?? null,
      },
    })),
    baselineUpdate: {
      requested: Boolean(updateBaselines),
      reason: updateBaselines ? (reason ?? null) : null,
    },
    problem: problem
      ? {
          status: problem.status,
          reason: problem.name,
          message: problem.message,
        }
      : null,
    verdict,
    exitCode: exitCodeForS5Status(verdict),
  };
}

const MD5_PATTERN = /^[0-9a-f]{32}$/i;
const EXPECTED_PREFLIGHTS = Object.freeze([
  Object.freeze({
    name: "main-bundle",
    path: "Build/CesiumUnminified/Cesium.js",
    portKey: "port",
  }),
  Object.freeze({
    name: "sandcastle-engine-bundle",
    path: "packages/engine/Build/Unminified/index.js",
    portKey: "bucketPort",
  }),
]);

export function normalizePreflightRecord(expected, origin, result) {
  const reasons = [];
  const artifact = Array.isArray(result?.artifacts)
    ? result.artifacts[0]
    : null;
  const diskMd5 = artifact?.disk?.md5;
  const servedMd5 = artifact?.served?.md5;
  const expectedUrl = new URL(expected.path, `${origin}/`).href;

  if (!result || typeof result !== "object") reasons.push("RESULT_MISSING");
  if (result?.ok !== true) reasons.push("RESULT_NOT_OK");
  if (result?.origin !== origin) reasons.push("ORIGIN_MISMATCH");
  if (!Array.isArray(result?.artifacts) || result.artifacts.length !== 1) {
    reasons.push("ARTIFACT_COUNT_MISMATCH");
  }
  if (artifact?.path !== expected.path) reasons.push("PATH_MISMATCH");
  if (artifact?.url !== expectedUrl) reasons.push("URL_MISMATCH");
  if (artifact?.disk?.exists !== true) reasons.push("DISK_ARTIFACT_MISSING");
  if (
    !Number.isInteger(artifact?.disk?.byteLength) ||
    artifact.disk.byteLength < 1
  ) {
    reasons.push("DISK_LENGTH_INVALID");
  }
  if (!MD5_PATTERN.test(diskMd5 ?? "")) reasons.push("DISK_MD5_INVALID");
  if (artifact?.served?.ok !== true) reasons.push("SERVED_ARTIFACT_MISSING");
  if (
    !Number.isInteger(artifact?.served?.status) ||
    artifact.served.status < 200 ||
    artifact.served.status >= 300
  ) {
    reasons.push("SERVED_STATUS_INVALID");
  }
  if (artifact?.served?.byteLength !== artifact?.disk?.byteLength) {
    reasons.push("BYTE_LENGTH_MISMATCH");
  }
  if (!MD5_PATTERN.test(servedMd5 ?? "")) reasons.push("SERVED_MD5_INVALID");
  if (diskMd5 !== servedMd5) reasons.push("MD5_MISMATCH");
  if (artifact?.match !== true) reasons.push("MATCH_NOT_PROVEN");

  return {
    name: expected.name,
    path: expected.path,
    origin,
    passed: reasons.length === 0,
    diskMd5: MD5_PATTERN.test(diskMd5 ?? "") ? diskMd5 : null,
    servedMd5: MD5_PATTERN.test(servedMd5 ?? "") ? servedMd5 : null,
    byteLength: Number.isInteger(artifact?.served?.byteLength)
      ? artifact.served.byteLength
      : null,
    reasons,
  };
}

export function decidePreflightRefusal(records) {
  if (
    !Array.isArray(records) ||
    records.length !== EXPECTED_PREFLIGHTS.length
  ) {
    return makeRefusal(
      REFUSAL_REASONS.SERVED_BUILD_PREFLIGHT_FAILED,
      `Served-build preflight must verify exactly ${REQUIRED_PREFLIGHT_ARTIFACT_COUNT} bundles.`,
    );
  }

  const names = records.map((record) => record?.name);
  if (
    new Set(names).size !== names.length ||
    names.some((name, index) => name !== EXPECTED_PREFLIGHTS[index].name)
  ) {
    return makeRefusal(
      REFUSAL_REASONS.SERVED_BUILD_PREFLIGHT_FAILED,
      "Served-build preflight records are duplicate, missing, or out of order.",
    );
  }

  const failed = records.filter((record) => record.passed !== true);
  if (failed.length > 0) {
    return makeRefusal(
      REFUSAL_REASONS.SERVED_BUILD_PREFLIGHT_FAILED,
      `Served-build preflight failed for: ${failed
        .map((record) => `${record.name} (${record.reasons.join(",")})`)
        .join("; ")}.`,
    );
  }

  return null;
}

async function runServedBuildPreflights(
  preflightModule,
  { projectRoot, port, bucketPort },
) {
  const artifacts = preflightModule.DEFAULT_SERVED_BUILD_ARTIFACTS;
  if (
    !Array.isArray(artifacts) ||
    artifacts.length !== EXPECTED_PREFLIGHTS.length ||
    artifacts.some(
      (artifact, index) => artifact !== EXPECTED_PREFLIGHTS[index].path,
    )
  ) {
    return {
      records: [],
      problem: makeRefusal(
        REFUSAL_REASONS.SERVED_BUILD_PREFLIGHT_FAILED,
        "Served-build preflight exports do not match the exact two-artifact contract.",
      ),
    };
  }

  const records = [];
  for (const expected of EXPECTED_PREFLIGHTS) {
    const origin = `http://localhost:${
      expected.portKey === "port" ? port : bucketPort
    }`;
    try {
      const result = await preflightModule.preflightServedBuildArtifacts({
        artifacts: [expected.path],
        origin,
        repositoryRoot: projectRoot,
        fetchImpl: globalThis.fetch,
      });
      records.push(normalizePreflightRecord(expected, origin, result));
    } catch (error) {
      return {
        records,
        problem: makeError(
          ERROR_REASONS.SERVED_BUILD_PREFLIGHT_RUNTIME_FAILED,
          `Served-build preflight threw for ${expected.name}: ${error.message ?? error}`,
        ),
      };
    }
  }

  return { records, problem: null };
}

export function validateStepPlan(plan, args) {
  try {
    const expected = buildStepPlan(args);
    if (!Array.isArray(plan) || plan.length !== expected.length) {
      return makeRefusal(
        REFUSAL_REASONS.PLAN_INVALID,
        `The child plan must contain exactly ${expected.length} steps.`,
      );
    }

    const names = plan.map((step) => step?.name);
    if (
      names.some((name) => typeof name !== "string" || name.length === 0) ||
      new Set(names).size !== names.length
    ) {
      return makeRefusal(
        REFUSAL_REASONS.PLAN_INVALID,
        "The child plan contains an empty or duplicate step name.",
      );
    }

    for (let index = 0; index < expected.length; index += 1) {
      if (JSON.stringify(plan[index]) !== JSON.stringify(expected[index])) {
        return makeRefusal(
          REFUSAL_REASONS.PLAN_INVALID,
          `The child plan has a missing, unknown, or altered step at index ${index}.`,
        );
      }
    }

    return null;
  } catch (error) {
    return makeRefusal(
      REFUSAL_REASONS.PLAN_INVALID,
      `The child plan is unreadable: ${error.message ?? error}`,
    );
  }
}

export async function statStepPlanPaths(
  plan,
  projectRoot,
  statPath = (absolutePath) => fs.stat(absolutePath),
) {
  const files = [...new Set(plan.map((step) => step.file))];
  const rootPrefix = `${path.resolve(projectRoot)}${path.sep}`;

  for (const file of files) {
    const absolutePath = path.resolve(projectRoot, file);
    if (!absolutePath.startsWith(rootPrefix)) {
      return makeRefusal(
        REFUSAL_REASONS.PLAN_INVALID,
        `Planned child path escapes the project root: ${file}.`,
      );
    }

    try {
      const stat = await statPath(absolutePath);
      if (!stat?.isFile?.()) {
        return makeRefusal(
          REFUSAL_REASONS.PLAN_PATH_MISSING,
          `Planned child path is not a file: ${file}.`,
        );
      }
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        return makeRefusal(
          REFUSAL_REASONS.PLAN_PATH_MISSING,
          `Planned child path is missing: ${file}.`,
        );
      }
      return makeError(
        ERROR_REASONS.PLAN_STAT_FAILED,
        `Could not stat planned child path ${file}: ${error.message ?? error}`,
      );
    }
  }

  return null;
}

export function decidePreSpawnBindability(plan) {
  const blocked = plan.find(
    (step) =>
      step?.bindability?.phase === "pre-spawn" &&
      step.bindability.bindable !== true,
  );
  if (!blocked) {
    return null;
  }

  return makeRefusal(
    REFUSAL_REASONS.CAPTURE_AND_DIFF_UNBINDABLE,
    `No child spawned because the whole plan is blocked by ${blocked.name}: ${blocked.bindability.reason}`,
  );
}

export async function runChildProcess(
  step,
  projectRoot,
  {
    spawnChild = spawn,
    now = () => Date.now(),
    watchdogMs = CHILD_WATCHDOG_MS,
    terminateGraceMs = CHILD_TERMINATE_GRACE_MS,
    hardStopGraceMs = CHILD_HARD_STOP_GRACE_MS,
    contextEnvironment = {},
  } = {},
) {
  const runId = randomUUID();
  const startedEpochMs = now();
  const cleanup = {
    terminateAttempted: false,
    terminateAccepted: null,
    hardKillAttempted: false,
    hardKillAccepted: null,
    directChildCloseObserved: false,
    cleanupDeadlineExceeded: false,
    error: null,
  };

  return new Promise((resolve) => {
    let settled = false;
    let spawned = false;
    let timedOut = false;
    let watchdogTimer;
    let terminateTimer;
    let hardStopTimer;

    const finish = ({ exitCode = null, signal = null, error = null } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdogTimer);
      clearTimeout(terminateTimer);
      clearTimeout(hardStopTimer);
      const finishedEpochMs = now();
      resolve({
        runId,
        spawned,
        startedAt: new Date(startedEpochMs).toISOString(),
        finishedAt: new Date(finishedEpochMs).toISOString(),
        startedEpochMs,
        finishedEpochMs,
        wallMs: Math.max(0, finishedEpochMs - startedEpochMs),
        exitCode,
        signal: typeof signal === "string" ? signal : null,
        error: error ? String(error.message ?? error) : null,
        timedOut,
        watchdogMs,
        cleanup: { ...cleanup },
        quiescence: {
          directChildCloseObserved: cleanup.directChildCloseObserved,
          descendantProcessTreeProven: false,
          limitation: DESCENDANT_QUIESCENCE_LIMITATION,
        },
      });
    };

    let child;
    try {
      child = spawnChild(process.execPath, [step.file, ...step.args], {
        cwd: projectRoot,
        env: {
          ...process.env,
          ...step.env,
          ...contextEnvironment,
          WAVE_END_RUN_ID: runId,
        },
        stdio: "inherit",
        windowsHide: true,
      });
      spawned = true;
    } catch (error) {
      finish({ error });
      return;
    }

    if (!child || typeof child.once !== "function") {
      finish({ error: new TypeError("spawn did not return a child process") });
      return;
    }

    child.once("error", (error) => finish({ error }));
    child.once("close", (exitCode, signal) => {
      cleanup.directChildCloseObserved = true;
      finish({ exitCode, signal });
    });

    watchdogTimer = setTimeout(() => {
      timedOut = true;
      cleanup.terminateAttempted = true;
      try {
        cleanup.terminateAccepted = child.kill("SIGTERM");
      } catch (error) {
        cleanup.error = String(error.message ?? error);
      }

      terminateTimer = setTimeout(() => {
        cleanup.hardKillAttempted = true;
        try {
          cleanup.hardKillAccepted = child.kill("SIGKILL");
        } catch (error) {
          cleanup.error ??= String(error.message ?? error);
        }

        hardStopTimer = setTimeout(() => {
          cleanup.cleanupDeadlineExceeded = true;
          finish();
        }, hardStopGraceMs);
      }, terminateGraceMs);
    }, watchdogMs);
  });
}

function normalizedProblem(problem, typedResult = null) {
  return {
    status: problem.status,
    exitCode: problem.exitCode,
    reason: problem.name,
    message: problem.message,
    typedResult,
  };
}

export function classifyRawChildProblem(raw) {
  if (raw?.error) {
    return makeError(
      ERROR_REASONS.CHILD_SPAWN_ERROR,
      `Child process error: ${raw.error}`,
    );
  }
  if (raw?.timedOut) {
    return makeError(
      ERROR_REASONS.CHILD_TIMEOUT,
      `Child exceeded its ${raw.watchdogMs} ms watchdog.`,
    );
  }
  if (raw?.cleanup?.error || raw?.cleanup?.cleanupDeadlineExceeded) {
    return makeError(
      ERROR_REASONS.CHILD_CLEANUP_ERROR,
      `Child cleanup did not complete: ${raw.cleanup.error ?? "deadline exceeded"}.`,
    );
  }
  if (raw?.signal) {
    return makeError(
      ERROR_REASONS.CHILD_SIGNAL,
      `Child closed from signal ${raw.signal}.`,
    );
  }
  if (raw?.exitCode === null || raw?.exitCode === undefined) {
    return makeError(
      ERROR_REASONS.CHILD_NULL_EXIT,
      "Child closed without an exit code or signal.",
    );
  }
  if (
    !Number.isInteger(raw.exitCode) ||
    !Object.values(S5_STATUS_EXIT_CODES).includes(raw.exitCode)
  ) {
    return makeError(
      ERROR_REASONS.CHILD_UNKNOWN_EXIT,
      `Child returned unsupported raw exit code ${String(raw.exitCode)}.`,
    );
  }
  return null;
}

export function buildServedSubject(args, preflightRecords) {
  return {
    base: `http://localhost:${args.port}`,
    sandcastleBase: `http://localhost:${args.bucketPort}`,
    artifacts: preflightRecords.map((record) => ({
      path: record.path,
      origin: record.origin,
      byteLength: record.byteLength,
      md5: record.servedMd5,
    })),
  };
}

function normalizeTypedStepResultUnsafe(
  result,
  { step, raw, source, servedSubject },
) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return normalizedProblem(
      makeRefusal(
        REFUSAL_REASONS.CHILD_CONTRACT_ABSENT,
        `${step.name} produced no typed current-run result.`,
      ),
    );
  }

  if (
    result.schemaVersion !== STEP_RESULT_SCHEMA_VERSION ||
    result.stepName !== step.name ||
    !S5_FINAL_STATUSES.includes(result.status) ||
    result.exitCode !== exitCodeForS5Status(result.status) ||
    (result.status === "PASS"
      ? result.reason !== null && result.reason !== undefined
      : typeof result.reason !== "string" || result.reason.length === 0) ||
    (result.message !== null &&
      result.message !== undefined &&
      typeof result.message !== "string")
  ) {
    return normalizedProblem(
      makeRefusal(
        REFUSAL_REASONS.CHILD_CONTRACT_MALFORMED,
        `${step.name} produced a malformed typed result contract.`,
      ),
      result,
    );
  }

  const resultStartedMs = Date.parse(result.startedAt);
  const resultFinishedMs = Date.parse(result.finishedAt);
  if (
    result.runId !== raw.runId ||
    !Number.isFinite(resultStartedMs) ||
    !Number.isFinite(resultFinishedMs) ||
    resultStartedMs < raw.startedEpochMs ||
    resultFinishedMs < resultStartedMs ||
    resultFinishedMs > raw.finishedEpochMs
  ) {
    return normalizedProblem(
      makeRefusal(
        REFUSAL_REASONS.CHILD_RECEIPT_STALE,
        `${step.name} result is not bound to this child run and time window.`,
      ),
      result,
    );
  }

  if (JSON.stringify(result.source) !== JSON.stringify(source)) {
    return normalizedProblem(
      makeRefusal(
        REFUSAL_REASONS.PROVENANCE_MISMATCH,
        `${step.name} result is not bound to the root-supplied source tuple.`,
      ),
      result,
    );
  }

  if (JSON.stringify(result.servedSubject) !== JSON.stringify(servedSubject)) {
    return normalizedProblem(
      makeRefusal(
        REFUSAL_REASONS.SERVED_SUBJECT_MISMATCH,
        `${step.name} result is not bound to the preflighted served subject.`,
      ),
      result,
    );
  }

  if (result.quiescence?.descendantProcessTreeProven !== true) {
    return normalizedProblem(
      makeRefusal(
        REFUSAL_REASONS.DESCENDANT_QUIESCENCE_UNPROVEN,
        `${step.name} did not prove descendant process-tree quiescence.`,
      ),
      result,
    );
  }

  if (raw.exitCode !== result.exitCode) {
    return normalizedProblem(
      makeRefusal(
        REFUSAL_REASONS.CHILD_CONTRACT_MALFORMED,
        `${step.name} typed exit does not match the observed raw exit.`,
      ),
      result,
    );
  }

  return {
    status: result.status,
    exitCode: result.exitCode,
    reason: result.reason ?? null,
    message:
      result.message ??
      (result.status === "PASS"
        ? null
        : `${step.name} reported ${result.status} [${result.reason}].`),
    typedResult: result,
  };
}

export function normalizeTypedStepResult(result, context) {
  try {
    return normalizeTypedStepResultUnsafe(result, context);
  } catch (error) {
    return normalizedProblem(
      makeRefusal(
        REFUSAL_REASONS.CHILD_CONTRACT_MALFORMED,
        `The typed result contract is unreadable: ${error.message ?? error}`,
      ),
    );
  }
}

async function readResultReportSnapshot(
  step,
  projectRoot,
  {
    readFile = (absolutePath) => fs.readFile(absolutePath),
    statPath = (absolutePath) => fs.stat(absolutePath),
  } = {},
) {
  if (!step.resultReportPath) {
    return { exists: false, bytes: null, mtimeMs: null, sha256: null };
  }

  const absolutePath = path.resolve(projectRoot, step.resultReportPath);
  try {
    const [bytes, stat] = await Promise.all([
      readFile(absolutePath),
      statPath(absolutePath),
    ]);
    return {
      exists: true,
      bytes,
      mtimeMs: stat.mtimeMs,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return { exists: false, bytes: null, mtimeMs: null, sha256: null };
    }
    return {
      exists: false,
      bytes: null,
      mtimeMs: null,
      sha256: null,
      problem: makeError(
        ERROR_REASONS.CHILD_RESULT_READ_FAILED,
        `Could not read ${step.resultReportPath}: ${error.message ?? error}`,
      ),
    };
  }
}

export async function resolveCurrentStepResult(
  { step, raw, projectRoot, priorSnapshot },
  snapshotDependencies = {},
) {
  if (!step.resultReportPath) {
    return {
      problem: makeRefusal(
        REFUSAL_REASONS.CHILD_CONTRACT_ABSENT,
        step.bindability.reason,
      ),
      snapshot: priorSnapshot,
    };
  }

  const snapshot = await readResultReportSnapshot(
    step,
    projectRoot,
    snapshotDependencies,
  );
  if (snapshot.problem) {
    return { problem: snapshot.problem, snapshot };
  }
  if (!snapshot.exists) {
    return {
      problem: makeRefusal(
        REFUSAL_REASONS.CHILD_CONTRACT_ABSENT,
        `${step.name} did not produce ${step.resultReportPath}.`,
      ),
      snapshot,
    };
  }

  if (
    !Number.isFinite(snapshot.mtimeMs) ||
    snapshot.mtimeMs < raw.startedEpochMs ||
    snapshot.mtimeMs > raw.finishedEpochMs ||
    (priorSnapshot?.exists && priorSnapshot.sha256 === snapshot.sha256)
  ) {
    return {
      problem: makeRefusal(
        REFUSAL_REASONS.CHILD_RECEIPT_STALE,
        `${step.resultReportPath} is not fresh for ${raw.runId}.`,
      ),
      snapshot,
    };
  }

  try {
    return {
      result: JSON.parse(Buffer.from(snapshot.bytes).toString("utf8")),
      snapshot,
    };
  } catch (error) {
    return {
      problem: makeRefusal(
        REFUSAL_REASONS.CHILD_CONTRACT_MALFORMED,
        `${step.resultReportPath} is not valid JSON: ${error.message}`,
      ),
      snapshot,
    };
  }
}

export function sourceFromArgs(args) {
  return Object.freeze({
    commit: args.sourceCommit,
    dirty:
      args.sourceDirty === "true"
        ? true
        : args.sourceDirty === "false"
          ? false
          : null,
    identity: args.sourceIdentity,
  });
}

function nonExecutionStepReceipt(step, problem) {
  return {
    name: step.name,
    command: step.command,
    bindability: { ...step.bindability },
    raw: {
      runId: null,
      spawned: false,
      startedAt: null,
      finishedAt: null,
      startedEpochMs: null,
      finishedEpochMs: null,
      wallMs: 0,
      exitCode: null,
      signal: null,
      error: null,
      timedOut: false,
      watchdogMs: CHILD_WATCHDOG_MS,
      cleanup: {
        terminateAttempted: false,
        terminateAccepted: null,
        hardKillAttempted: false,
        hardKillAccepted: null,
        directChildCloseObserved: false,
        cleanupDeadlineExceeded: false,
        error: null,
      },
      quiescence: {
        directChildCloseObserved: false,
        descendantProcessTreeProven: false,
        limitation: DESCENDANT_QUIESCENCE_LIMITATION,
      },
    },
    normalized: normalizedProblem(problem),
  };
}

function nonExecutionPlanResult(plan, problem) {
  return {
    steps: plan.map((step) => nonExecutionStepReceipt(step, problem)),
    problem,
  };
}

export async function executeStep(
  step,
  { projectRoot, source, servedSubject, priorSnapshot },
  {
    runChild = runChildProcess,
    resolveStepResult = resolveCurrentStepResult,
  } = {},
) {
  const raw = await runChild(step, projectRoot, {
    contextEnvironment: {
      WAVE_END_SOURCE_COMMIT: source.commit,
      WAVE_END_SOURCE_DIRTY: String(source.dirty),
      WAVE_END_SOURCE_IDENTITY: source.identity,
      WAVE_END_SERVED_BASE: servedSubject.base,
      WAVE_END_SANDCASTLE_BASE: servedSubject.sandcastleBase,
    },
  });
  const rawProblem = classifyRawChildProblem(raw);
  if (rawProblem) {
    return {
      receipt: {
        name: step.name,
        command: step.command,
        bindability: { ...step.bindability },
        raw,
        normalized: normalizedProblem(rawProblem),
      },
      snapshot: priorSnapshot,
    };
  }

  let resolution;
  try {
    resolution = await resolveStepResult({
      step,
      raw,
      projectRoot,
      source,
      servedSubject,
      priorSnapshot,
    });
  } catch (error) {
    resolution = {
      problem: makeError(
        ERROR_REASONS.CHILD_RESULT_READ_FAILED,
        `Typed result resolver threw for ${step.name}: ${error.message ?? error}`,
      ),
      snapshot: priorSnapshot,
    };
  }

  const resolvedResult =
    resolution &&
    typeof resolution === "object" &&
    Object.hasOwn(resolution, "result")
      ? resolution.result
      : resolution;
  const normalized = resolution?.problem
    ? normalizedProblem(resolution.problem)
    : normalizeTypedStepResult(resolvedResult, {
        step,
        raw,
        source,
        servedSubject,
      });
  return {
    receipt: {
      name: step.name,
      command: step.command,
      bindability: { ...step.bindability },
      raw,
      normalized,
    },
    snapshot: resolution?.snapshot ?? priorSnapshot,
  };
}

export async function executeStepPlan(plan, context, dependencies = {}) {
  const bindabilityProblem = decidePreSpawnBindability(plan);
  if (bindabilityProblem) {
    return nonExecutionPlanResult(plan, bindabilityProblem);
  }

  const snapshots = new Map();
  for (const step of plan) {
    if (!step.resultReportPath || snapshots.has(step.resultReportPath)) {
      continue;
    }
    const snapshot = await readResultReportSnapshot(
      step,
      context.projectRoot,
      dependencies.snapshotDependencies,
    );
    if (snapshot.problem) {
      return { steps: [], problem: snapshot.problem };
    }
    snapshots.set(step.resultReportPath, snapshot);
  }

  const steps = [];
  for (const step of plan) {
    const executed = await executeStep(
      step,
      {
        ...context,
        priorSnapshot: step.resultReportPath
          ? snapshots.get(step.resultReportPath)
          : null,
      },
      dependencies,
    );
    steps.push(executed.receipt);
    if (step.resultReportPath) {
      snapshots.set(step.resultReportPath, executed.snapshot);
    }
    if (
      executed.receipt.normalized.status === "STRUCTURAL" ||
      executed.receipt.normalized.status === "ERROR"
    ) {
      return {
        steps,
        problem: {
          status: executed.receipt.normalized.status,
          exitCode: executed.receipt.normalized.exitCode,
          name: executed.receipt.normalized.reason,
          message: executed.receipt.normalized.message,
        },
      };
    }
  }

  return { steps, problem: null };
}

function markdownCell(value) {
  return String(value ?? "")
    .replaceAll("|", "\\|")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ");
}

export function buildMarkdownSummary(receipt, { dryRun = false } = {}) {
  const lines = [
    `# Wave-end gate: ${receipt.wave}`,
    "",
    `- Verdict: **${receipt.verdict}**`,
    `- Started: ${receipt.startedAt}`,
    `- Finished: ${receipt.finishedAt}`,
    `- Source commit: \`${receipt.source.commit ?? "missing"}\``,
    `- Source dirty: ${receipt.source.dirty ?? "missing"}`,
    `- Source identity: \`${receipt.source.identity ?? "missing"}\``,
    `- Baseline update requested: ${receipt.baselineUpdate.requested ? "yes" : "no"}`,
    `- Baseline reason: ${receipt.baselineUpdate.reason ?? "n/a"}`,
  ];

  if (receipt.problem) {
    lines.push(
      `- Problem: **${receipt.problem.reason}** — ${markdownCell(receipt.problem.message)}`,
    );
  }

  if (dryRun) {
    lines.push("- Dry run: **STRUCTURAL**. Child processes were not executed.");
  }

  lines.push("", "## Served subject", "");
  lines.push(
    `- Base: \`${receipt.servedSubject.base}\``,
    `- Sandcastle base: \`${receipt.servedSubject.sandcastleBase}\``,
    "",
    "| Artifact | Origin | Bytes | MD5 |",
    "| --- | --- | ---: | --- |",
  );
  for (const artifact of receipt.servedSubject.artifacts) {
    lines.push(
      `| ${markdownCell(artifact.path)} | ${markdownCell(artifact.origin)} | ${markdownCell(artifact.byteLength)} | ${markdownCell(artifact.md5)} |`,
    );
  }

  lines.push(
    "",
    "## Plan",
    "",
    "| Step | Command | Bindable now | Phase | Reason |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const step of receipt.plan) {
    lines.push(
      `| ${markdownCell(step.name)} | \`${markdownCell(step.command)}\` | ${step.bindability.bindable ? "yes" : "no"} | ${markdownCell(step.bindability.phase)} | ${markdownCell(step.bindability.reason)} |`,
    );
  }

  lines.push("", "## Steps", "");
  if (receipt.steps.length === 0) {
    lines.push("No child steps were executed.");
  } else {
    lines.push(
      "| Step | Spawned | Raw exit | Signal | Error | Timeout | Cleanup closed | Descendant quiescence | Normalized |",
      "| --- | --- | ---: | --- | --- | --- | --- | --- | --- |",
    );
    for (const step of receipt.steps) {
      lines.push(
        `| ${markdownCell(step.name)} | ${step.raw.spawned ? "yes" : "no"} | ${markdownCell(step.raw.exitCode)} | ${markdownCell(step.raw.signal)} | ${markdownCell(step.raw.error)} | ${step.raw.timedOut ? "yes" : "no"} | ${step.raw.cleanup.directChildCloseObserved ? "yes" : "no"} | ${step.raw.quiescence.descendantProcessTreeProven ? "proven" : "unproven"} | ${markdownCell(step.normalized.status)} (${markdownCell(step.normalized.reason ?? "typed")}) |`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

async function writeReceiptFiles(toolsDir, receipt, summaryOptions = {}) {
  const outputDirectory = path.join(
    toolsDir,
    "visual-regression",
    "output",
    "wave-end",
    receipt.wave,
  );

  await fs.mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    fs.writeFile(
      path.join(outputDirectory, "receipt.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
      "utf8",
    ),
    fs.writeFile(
      path.join(outputDirectory, "summary.md"),
      buildMarkdownSummary(receipt, summaryOptions),
      "utf8",
    ),
  ]);
}

async function finishProblem({
  args,
  problem,
  startedAt,
  toolsDir,
  source,
  servedSubject,
  preflight = [],
  plan = [],
  steps = [],
  dryRun = false,
  writeReceipt = writeReceiptFiles,
  logError = (message) => console.error(message),
}) {
  const verdict = foldStatuses([
    ...steps.map((step) => step.normalized.status),
    problem.status,
  ]);
  const receipt = buildReceipt({
    wave: args.wave,
    startedAt,
    finishedAt: new Date().toISOString(),
    source,
    servedSubject,
    preflight,
    plan,
    steps,
    updateBaselines: args.updateBaselines,
    reason: args.reason,
    problem,
    verdict,
  });

  await writeReceipt(toolsDir, receipt, { dryRun });
  logError(`${verdict} [${problem.name}]: ${problem.message}`);
  return receipt.exitCode;
}

function hasOwnFields(record, fields) {
  return fields.every((field) => Object.hasOwn(record, field));
}

function isNullableString(value) {
  return value === null || typeof value === "string";
}

function isRawStepReceiptContract(raw) {
  const topLevelFields = [
    "runId",
    "spawned",
    "startedAt",
    "finishedAt",
    "startedEpochMs",
    "finishedEpochMs",
    "wallMs",
    "exitCode",
    "signal",
    "error",
    "timedOut",
    "watchdogMs",
    "cleanup",
    "quiescence",
  ];
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    !hasOwnFields(raw, topLevelFields)
  ) {
    return false;
  }

  const isNonExecutionIdentity =
    raw.runId === null &&
    raw.startedAt === null &&
    raw.finishedAt === null &&
    raw.startedEpochMs === null &&
    raw.finishedEpochMs === null;
  const isCurrentRunIdentity =
    typeof raw.runId === "string" &&
    raw.runId.length > 0 &&
    typeof raw.startedAt === "string" &&
    Number.isFinite(Date.parse(raw.startedAt)) &&
    typeof raw.finishedAt === "string" &&
    Number.isFinite(Date.parse(raw.finishedAt)) &&
    Number.isFinite(raw.startedEpochMs) &&
    Number.isFinite(raw.finishedEpochMs);
  if (!isNonExecutionIdentity && !isCurrentRunIdentity) {
    return false;
  }

  const cleanupFields = [
    "terminateAttempted",
    "terminateAccepted",
    "hardKillAttempted",
    "hardKillAccepted",
    "directChildCloseObserved",
    "cleanupDeadlineExceeded",
    "error",
  ];
  const quiescenceFields = [
    "directChildCloseObserved",
    "descendantProcessTreeProven",
    "limitation",
  ];
  return (
    typeof raw.spawned === "boolean" &&
    Number.isFinite(raw.wallMs) &&
    raw.wallMs >= 0 &&
    (raw.exitCode === null || Number.isInteger(raw.exitCode)) &&
    isNullableString(raw.signal) &&
    isNullableString(raw.error) &&
    typeof raw.timedOut === "boolean" &&
    Number.isInteger(raw.watchdogMs) &&
    raw.watchdogMs > 0 &&
    raw.cleanup &&
    typeof raw.cleanup === "object" &&
    !Array.isArray(raw.cleanup) &&
    hasOwnFields(raw.cleanup, cleanupFields) &&
    typeof raw.cleanup.terminateAttempted === "boolean" &&
    (raw.cleanup.terminateAccepted === null ||
      typeof raw.cleanup.terminateAccepted === "boolean") &&
    typeof raw.cleanup.hardKillAttempted === "boolean" &&
    (raw.cleanup.hardKillAccepted === null ||
      typeof raw.cleanup.hardKillAccepted === "boolean") &&
    typeof raw.cleanup.directChildCloseObserved === "boolean" &&
    typeof raw.cleanup.cleanupDeadlineExceeded === "boolean" &&
    isNullableString(raw.cleanup.error) &&
    raw.quiescence &&
    typeof raw.quiescence === "object" &&
    !Array.isArray(raw.quiescence) &&
    hasOwnFields(raw.quiescence, quiescenceFields) &&
    typeof raw.quiescence.directChildCloseObserved === "boolean" &&
    typeof raw.quiescence.descendantProcessTreeProven === "boolean" &&
    typeof raw.quiescence.limitation === "string" &&
    raw.quiescence.limitation.length > 0
  );
}

function isNormalizedStepReceiptContract(normalized) {
  if (
    !normalized ||
    typeof normalized !== "object" ||
    Array.isArray(normalized) ||
    !hasOwnFields(normalized, [
      "status",
      "exitCode",
      "reason",
      "message",
      "typedResult",
    ]) ||
    !S5_FINAL_STATUSES.includes(normalized.status) ||
    normalized.exitCode !== exitCodeForS5Status(normalized.status) ||
    (normalized.status === "PASS"
      ? normalized.reason !== null
      : typeof normalized.reason !== "string" ||
        normalized.reason.length === 0) ||
    (normalized.status === "PASS"
      ? !isNullableString(normalized.message)
      : typeof normalized.message !== "string" ||
        normalized.message.length === 0) ||
    (normalized.typedResult !== null &&
      (typeof normalized.typedResult !== "object" ||
        Array.isArray(normalized.typedResult))) ||
    ((normalized.status === "PASS" || normalized.status === "FAIL") &&
      normalized.typedResult === null)
  ) {
    return false;
  }
  return true;
}

function isExecutionResultContract(execution, plan) {
  try {
    if (
      !execution ||
      typeof execution !== "object" ||
      !Array.isArray(execution.steps) ||
      (execution.problem !== null && !isProblemContract(execution.problem))
    ) {
      return false;
    }

    if (
      execution.steps.length > plan.length ||
      execution.steps.some((step, index) => step?.name !== plan[index]?.name) ||
      (execution.problem === null && execution.steps.length !== plan.length)
    ) {
      return false;
    }

    for (let index = 0; index < execution.steps.length; index += 1) {
      const step = execution.steps[index];
      const planned = plan[index];
      if (
        step.command !== planned.command ||
        JSON.stringify(step.bindability) !==
          JSON.stringify(planned.bindability) ||
        !isRawStepReceiptContract(step.raw) ||
        !isNormalizedStepReceiptContract(step.normalized)
      ) {
        return false;
      }
    }

    if (execution.problem === null) {
      return true;
    }
    if (execution.steps.length === 0) {
      return true;
    }
    const terminal = execution.steps.at(-1).normalized;
    return (
      terminal.status === execution.problem.status &&
      terminal.exitCode === execution.problem.exitCode &&
      terminal.reason === execution.problem.name &&
      terminal.message === execution.problem.message
    );
  } catch {
    return false;
  }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const nowIso = dependencies.nowIso ?? (() => new Date().toISOString());
  const logError =
    dependencies.logError ?? ((message) => console.error(message));
  const logInfo = dependencies.logInfo ?? ((message) => console.log(message));
  const startedAt = nowIso();
  const args = parseArgs(argv);
  const toolsDir =
    dependencies.toolsDir ?? path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = dependencies.projectRoot ?? path.resolve(toolsDir, "..");
  const writeReceipt = dependencies.writeReceipt ?? writeReceiptFiles;

  let problem = decideArgumentRefusal(args);
  if (problem) {
    if (typeof args.wave === "string" && WAVE_PATTERN.test(args.wave)) {
      const argumentServedSubject = {
        base: isValidPort(args.port) ? `http://localhost:${args.port}` : null,
        sandcastleBase: isValidPort(args.bucketPort)
          ? `http://localhost:${args.bucketPort}`
          : null,
        artifacts: [],
      };
      return finishProblem({
        args,
        problem,
        startedAt,
        toolsDir,
        source: sourceFromArgs(args),
        servedSubject: argumentServedSubject,
        preflight: [],
        plan: [],
        steps: [],
        writeReceipt,
        logError,
      });
    }
    logError(`${problem.status} [${problem.name}]: ${problem.message}`);
    return problem.exitCode;
  }

  const source = sourceFromArgs(args);
  let plan;
  try {
    plan = (dependencies.buildPlan ?? buildStepPlan)(args);
  } catch (error) {
    problem = makeError(
      ERROR_REASONS.UNEXPECTED_GATE_ERROR,
      `Child plan builder threw: ${error.message ?? error}`,
    );
    return finishProblem({
      args,
      problem,
      startedAt,
      toolsDir,
      source,
      servedSubject: buildServedSubject(args, []),
      preflight: [],
      plan: [],
      steps: [],
      writeReceipt,
      logError,
    });
  }
  let preflightRecords = [];
  let servedSubject = buildServedSubject(args, preflightRecords);
  const finish = (currentProblem, options = {}) =>
    finishProblem({
      args,
      problem: currentProblem,
      startedAt,
      toolsDir,
      source,
      servedSubject,
      preflight: preflightRecords,
      plan: options.plan ?? plan,
      steps: options.steps ?? [],
      dryRun: options.dryRun ?? false,
      writeReceipt,
      logError,
    });

  let originRewriteModule;
  try {
    originRewriteModule = dependencies.loadOriginRewrite
      ? await dependencies.loadOriginRewrite()
      : await import(
          new URL(
            "./visual-regression/lib/sandcastle2-origin-rewrite.mjs",
            import.meta.url,
          )
        );
  } catch (error) {
    problem = makeError(
      ERROR_REASONS.ORIGIN_REWRITE_IMPORT_FAILED,
      `Could not import the Sandcastle2 origin-rewrite helper: ${error.message}`,
    );
    return finish(problem);
  }

  problem = decideOriginRewriteRefusal(originRewriteModule);
  if (problem) {
    return finish(problem);
  }

  let preflightModule;
  try {
    preflightModule = dependencies.loadPreflight
      ? await dependencies.loadPreflight()
      : await import(
          new URL(
            "./visual-regression/lib/served-build-preflight.mjs",
            import.meta.url,
          )
        );
    if (typeof preflightModule.preflightServedBuildArtifacts !== "function") {
      throw new TypeError(
        "preflightServedBuildArtifacts is not exported as a function",
      );
    }
  } catch (error) {
    problem = makeError(
      ERROR_REASONS.SERVED_BUILD_PREFLIGHT_IMPORT_FAILED,
      `Could not import the served-build preflight: ${error.message}`,
    );
    return finish(problem);
  }

  let preflightRun;
  try {
    preflightRun = await (
      dependencies.runPreflights ?? runServedBuildPreflights
    )(preflightModule, {
      projectRoot,
      port: args.port,
      bucketPort: args.bucketPort,
    });
  } catch (error) {
    problem = makeError(
      ERROR_REASONS.SERVED_BUILD_PREFLIGHT_RUNTIME_FAILED,
      `Served-build preflight failed unexpectedly: ${error.message ?? error}`,
    );
    return finish(problem);
  }
  try {
    if (
      !preflightRun ||
      typeof preflightRun !== "object" ||
      !Array.isArray(preflightRun.records) ||
      (preflightRun.problem !== null &&
        !isProblemContract(preflightRun.problem))
    ) {
      throw new TypeError("malformed preflight-run contract");
    }
    preflightRecords = [...preflightRun.records];
    servedSubject = buildServedSubject(args, preflightRecords);
    if (preflightRun.problem) {
      return finish(preflightRun.problem);
    }
    problem = decidePreflightRefusal(preflightRecords);
  } catch (error) {
    preflightRecords = [];
    servedSubject = buildServedSubject(args, preflightRecords);
    problem = makeError(
      ERROR_REASONS.SERVED_BUILD_PREFLIGHT_RUNTIME_FAILED,
      `Served-build preflight returned an unreadable runtime result: ${error.message ?? error}`,
    );
    return finish(problem);
  }
  if (problem) {
    return finish(problem);
  }

  problem = validateStepPlan(plan, args);
  if (problem) {
    return finish(problem, { plan: [] });
  }
  plan = buildStepPlan(args);

  problem = await (dependencies.statPlanPaths ?? statStepPlanPaths)(
    plan,
    projectRoot,
    dependencies.statPath,
  );
  if (problem) {
    return finish(problem);
  }

  if (args.dryRun) {
    for (const step of plan) {
      logInfo(step.command);
    }
    problem = makeRefusal(
      REFUSAL_REASONS.DRY_RUN_NON_EXECUTION,
      "Dry-run mode does not execute or certify the canonical child plan.",
    );
    return finish(problem, { dryRun: true });
  }

  problem = decidePreSpawnBindability(plan);
  if (problem) {
    const nonExecution = nonExecutionPlanResult(plan, problem);
    return finish(problem, { steps: nonExecution.steps });
  }

  let execution;
  try {
    execution = await (dependencies.executePlan ?? executeStepPlan)(
      plan,
      { projectRoot, source, servedSubject },
      dependencies.executionDependencies,
    );
    if (!isExecutionResultContract(execution, plan)) {
      throw new TypeError("malformed execution-result contract");
    }
  } catch (error) {
    problem = makeError(
      ERROR_REASONS.UNEXPECTED_GATE_ERROR,
      `Unexpected gate execution failure: ${error.stack ?? error}`,
    );
    return finish(problem);
  }

  problem = execution.problem;
  if (!problem && execution.steps.length === 0) {
    problem = makeRefusal(
      REFUSAL_REASONS.PLAN_INVALID,
      "The canonical plan produced no normalized step results.",
    );
  }
  const verdict = foldStatuses([
    ...execution.steps.map((step) => step.normalized.status),
    ...(problem ? [problem.status] : []),
  ]);
  const receipt = buildReceipt({
    wave: args.wave,
    startedAt,
    finishedAt: nowIso(),
    source,
    servedSubject,
    preflight: preflightRecords,
    plan,
    steps: execution.steps,
    updateBaselines: args.updateBaselines,
    reason: args.reason,
    problem,
    verdict,
  });

  await writeReceipt(toolsDir, receipt);
  return receipt.exitCode;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(`ERROR [UNEXPECTED_GATE_ERROR]: ${error.stack ?? error}`);
      process.exitCode = EXIT_CODES.ERROR;
    });
}
