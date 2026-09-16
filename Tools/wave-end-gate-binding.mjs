// @purpose Validates wave-end arguments, planned child bindings and served-build preconditions.
// @status ACTIVE

import {
  S5_STATUS_EXIT_CODES,
  exitCodeForS5Status,
} from "./visual-regression/lib/verdict-exit-gate.mjs";
import path from "node:path";
import { promises as fs } from "node:fs";

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
  EXIT_CODE_UNDECLARED: "EXIT_CODE_UNDECLARED",
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

export const WAVE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const REQUIRED_PREFLIGHT_ARTIFACT_COUNT = 2;
export const CHILD_WATCHDOG_MS = 2 * 60 * 60 * 1000;
export const CHILD_TERMINATE_GRACE_MS = 5_000;
export const CHILD_HARD_STOP_GRACE_MS = 2_000;
export const STEP_RESULT_SCHEMA_VERSION = 1;
export const DESCENDANT_QUIESCENCE_LIMITATION =
  "Direct-child close does not prove descendant process-tree quiescence.";

/** The one `boundBy` value the root mints for itself. */
export const ROOT_BINDING = "root-binding";

/** Blocker codes a pre-spawn-unbindable step may carry. */
export const BINDING_BLOCKERS = Object.freeze({
  SERVED_ORIGIN_UNAVAILABLE: "SERVED_ORIGIN_UNAVAILABLE",
  BASELINE_PROMOTION_UNBINDABLE: "BASELINE_PROMOTION_UNBINDABLE",
});

/**
 * The exit-code map every canonical child shares. Each child exits 0 when it
 * saw its subject and the subject met the bar, 1 when it saw its subject and
 * the subject missed it, and 2 when it could not see its subject at all
 * (Playwright absent, an argument it refused, an origin-rewrite refusal).
 * Every other code is undeclared and is refused rather than mapped.
 */
const CANONICAL_EXIT_CODE_STATUS = Object.freeze({
  0: "PASS",
  1: "FAIL",
  2: "STRUCTURAL",
});

function bindingFor(step, exitCodeMeaning) {
  return {
    boundBy: ROOT_BINDING,
    fields: {
      runId: "root:runChildProcess.runId",
      timeWindow: "root:runChildProcess.startedEpochMs..finishedEpochMs",
      source: "root:--source-commit/--source-dirty/--source-identity",
      servedSubject: "root:served-build-preflight(disk md5 === served md5)",
      freshness: step.resultReportPath
        ? `root:readResultReportSnapshot(${step.resultReportPath}) before and after the run`
        : "root:runChildProcess direct-child close (no fixed report declared)",
      status: "root:binding.exitCodeStatus over the observed raw exit",
      quiescence: "root:runChildProcess.cleanup.directChildCloseObserved",
    },
    exitCodeStatus: { ...CANONICAL_EXIT_CODE_STATUS },
    exitCodeMeaning,
    limitations: [DESCENDANT_QUIESCENCE_LIMITATION],
  };
}

/**
 * Whether the root derives this step's verdict itself. The single predicate the
 * whole root-binding path routes through, so an inertness mutant has one place
 * to reach.
 *
 * @param {object} step A planned step.
 * @returns {boolean} True when the step carries a root binding.
 */
export function isRootBoundStep(step) {
  return step?.binding?.boundBy === ROOT_BINDING;
}

function boundBindability(reason) {
  return {
    bindable: true,
    phase: "post-spawn",
    boundBy: ROOT_BINDING,
    reason,
    blockers: [],
    remediation: null,
    limitations: [DESCENDANT_QUIESCENCE_LIMITATION],
  };
}

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

export function isProblemContract(value) {
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

export function isValidPort(value) {
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

/**
 * The served origin the root is willing to hand a child, or null when the
 * arguments do not yield one. A forbidden port is not merely refused later by
 * `decideArgumentRefusal` — it never becomes a served origin here either, so a
 * plan built directly from hostile arguments cannot claim bindability.
 *
 * @param {object} args Parsed arguments.
 * @returns {string|null} The served origin, or null.
 */
export function resolveServedOrigin(args) {
  if (!isValidPort(args?.port) || args.port === 8080 || args.port === 8081) {
    return null;
  }
  return `http://localhost:${args.port}`;
}

/**
 * Every reason the visual-regression child cannot be bound under these
 * arguments. Empty means bindable. Each blocker names what that child must
 * gain, so a refusal tells the next engineer what to build.
 *
 * @param {object} args Parsed arguments.
 * @returns {Array<object>} Blocker records.
 */
export function visualRegressionBlockers(args) {
  const blockers = [];
  if (resolveServedOrigin(args) === null) {
    blockers.push({
      code: BINDING_BLOCKERS.SERVED_ORIGIN_UNAVAILABLE,
      reason:
        "scenes.json hard-codes its baseUrl on forbidden port 8080 and these arguments yield no served origin for the root to override it with.",
      remediation:
        "Invoke the gate with a --port that is a valid, non-forbidden port so the root can pass --served-base <origin> to Tools/visual-regression/capture-and-diff.mjs.",
    });
  }
  if (args?.updateBaselines === true) {
    blockers.push({
      code: BINDING_BLOCKERS.BASELINE_PROMOTION_UNBINDABLE,
      reason:
        "--update-baselines makes the child re-measure the worktree mid-run to prove promotion-source stability, and a root-supplied constant provenance tuple cannot stand in for that second measurement without making the stability proof vacuous.",
      remediation:
        "Give Tools/visual-regression/capture-and-diff.mjs a promotion-stability proof the root can bind — a re-measured worktree identity carried in a typed result — or promote baselines in their own separately reviewed commit outside this gate.",
    });
  }
  return blockers;
}

function unbindableBindability(phase, blockers) {
  return {
    bindable: false,
    phase,
    boundBy: null,
    reason: blockers.map((blocker) => blocker.reason).join(" "),
    blockers: blockers.map((blocker) => ({ ...blocker })),
    remediation: blockers.map((blocker) => blocker.remediation).join(" "),
    limitations: [DESCENDANT_QUIESCENCE_LIMITATION],
  };
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
      bindability: boundBindability(
        "The root binds this step itself: run id, time window, root-supplied source tuple, preflighted served subject, and the declared exit-code map below. The child is not asked for a typed receipt it cannot emit.",
      ),
      binding: bindingFor(
        { resultReportPath: null },
        {
          0: "every variant loaded, rendered a frame, and logged no console error",
          1: "at least one variant failed its smoke assertions",
          2: "the smoke test could not see its subject (Playwright absent, unknown argument, or no variant matched)",
        },
      ),
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
        bindability: boundBindability(
          "The root binds this step itself: the fixed report's before/after snapshot proves current-run freshness, the root supplies source and served subject, and the declared exit-code map below supplies the verdict. The report's own contents are evidence, not the verdict.",
        ),
        binding: bindingFor(
          {
            resultReportPath: `Tools/visual-regression/output/sandcastle2-sweep/report-${renderer}.json`,
          },
          {
            0: "every swept demo started on the requested renderer and rendered frames",
            1: "at least one swept demo failed, timed out, or the renderer was not sweepable",
            2: "the sweep refused its own results because the origin-rewrite guard fired, so it was not measuring the server it was asked to measure",
          },
        ),
      });
    }
  }

  const servedOrigin = resolveServedOrigin(args);
  const visualBlockers = visualRegressionBlockers(args);
  definitions.push({
    name: "visual-regression",
    file: "Tools/visual-regression/capture-and-diff.mjs",
    args: [
      ...(servedOrigin === null ? [] : ["--served-base", servedOrigin]),
      ...(args.updateBaselines
        ? [
            "--update",
            "--confirm-baseline-promotion",
            "--update-rationale",
            args.reason,
            "--reviewed-by",
            `wave-end-gate:${args.wave}`,
          ]
        : []),
    ],
    env: {},
    resultReportPath: "Tools/visual-regression/output/report.json",
    bindability:
      visualBlockers.length > 0
        ? unbindableBindability("pre-spawn", visualBlockers)
        : {
            ...boundBindability(
              "The root passes --served-base <origin> for the origin scenes.json hard-codes, exports WAVE_END_SOURCE_* so the child prefers root provenance over its own Git shell-out, snapshots output/report.json for current-run freshness, and reads the verdict off the declared exit-code map below.",
            ),
            phase: "pre-spawn",
          },
    binding: bindingFor(
      { resultReportPath: "Tools/visual-regression/output/report.json" },
      {
        0: "all three visual gates certified every scene and the WebGPU error gate was clean",
        1: "a visual gate or the WebGPU error gate failed, or baseline provenance was missing, stale, or unreviewed",
        2: "the runner could not see its subject (Playwright absent, a refused argument, or a denied promotion request)",
      },
    ),
  });

  return Object.freeze(
    definitions.map((definition) =>
      Object.freeze({
        ...definition,
        args: Object.freeze([...definition.args]),
        env: Object.freeze({ ...definition.env }),
        bindability: Object.freeze({
          ...definition.bindability,
          blockers: Object.freeze(
            definition.bindability.blockers.map((blocker) =>
              Object.freeze({ ...blocker }),
            ),
          ),
          limitations: Object.freeze([...definition.bindability.limitations]),
        }),
        binding: Object.freeze({
          ...definition.binding,
          fields: Object.freeze({ ...definition.binding.fields }),
          exitCodeStatus: Object.freeze({
            ...definition.binding.exitCodeStatus,
          }),
          exitCodeMeaning: Object.freeze({
            ...definition.binding.exitCodeMeaning,
          }),
          limitations: Object.freeze([...definition.binding.limitations]),
        }),
        command: formatNodeCommand(definition.file, definition.args),
      }),
    ),
  );
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

export async function runServedBuildPreflights(
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

/**
 * Every blocker on every pre-spawn-unbindable step, flattened. Naming only the
 * first blocker turns a fail-closed gate into a dead one: the next engineer
 * fixes what the message named, re-runs, and is refused again for a reason the
 * gate knew about all along.
 *
 * @param {Array<object>} plan The canonical step plan.
 * @returns {Array<object>} One record per blocker, tagged with its step.
 */
export function collectPreSpawnBlockers(plan) {
  const records = [];
  for (const step of plan) {
    if (
      step?.bindability?.phase === "pre-spawn" &&
      step.bindability.bindable !== true
    ) {
      const blockers =
        Array.isArray(step.bindability.blockers) &&
        step.bindability.blockers.length > 0
          ? step.bindability.blockers
          : [
              {
                code: "UNSPECIFIED",
                reason: step.bindability.reason,
                remediation: step.bindability.remediation ?? "unspecified",
              },
            ];
      for (const blocker of blockers) {
        records.push({ step: step.name, ...blocker });
      }
    }
  }
  return records;
}

export function decidePreSpawnBindability(plan) {
  const blockers = collectPreSpawnBlockers(plan);
  if (blockers.length === 0) {
    return null;
  }

  const steps = [...new Set(blockers.map((blocker) => blocker.step))];
  const detail = blockers
    .map(
      (blocker) =>
        `${blocker.step} [${blocker.code}]: ${blocker.reason} REMEDIATION: ${blocker.remediation}`,
    )
    .join(" | ");
  return makeRefusal(
    REFUSAL_REASONS.CAPTURE_AND_DIFF_UNBINDABLE,
    `No child spawned because ${blockers.length} pre-spawn blocker(s) remain across ${steps.length} step(s) (${steps.join(", ")}): ${detail}`,
  );
}
