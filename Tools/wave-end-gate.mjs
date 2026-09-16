#!/usr/bin/env node
// @purpose Q-152 — close a multi-batch wave with served-build preflights, smoke/sweep/visual gates, and banked receipts. The verdict is ROOT-BOUND: no child emits a typed receipt, so the root derives one per step from its own run id, time window, root-supplied source tuple, preflighted served subject, fixed-report freshness snapshot, and the step's own declared exit-code map (`binding`, echoed in the receipt). Bindability is a function of the arguments — `--update-baselines` still refuses pre-spawn with exit 3 and zero children spawned, naming every blocker and its remediation.
// @status ACTIVE
//
// WHY THE ROOT BINDS. The gate used to demand a capability from each child that
// no child has: a self-emitted typed result carrying run id, source, served
// subject and a proven-quiescent process tree. Every step was therefore
// `bindable: false` and every invocation refused before spawning anything, so
// the runner produced zero receipts. But the root already owns every binding
// field except the verdict — it minted the run id, it holds the time window, it
// was handed the source tuple, it preflighted the served subject, and it
// snapshots each fixed report before and after the run. Only the verdict was
// missing, and the objection to using the child's exit code was that a RAW exit
// is not a verdict. That objection is answered by DECLARING the mapping: each
// step carries `binding.exitCodeStatus`, visible in the plan, echoed in the
// receipt, and auditable. An undeclared exit code is still refused
// (EXIT_CODE_UNDECLARED) rather than guessed.
//
// WHAT THE ROOT STILL CANNOT PROVE. Descendant process-tree quiescence. A
// child's self-claim of it is unverifiable by the root, so the claim is not a
// gate input; the root records its own `directChildCloseObserved` observation
// and NAMES the limitation in every receipt. A run that neither proves
// quiescence nor names the limitation is refused.

import { spawn } from "node:child_process";
import {
  CHILD_HARD_STOP_GRACE_MS,
  CHILD_TERMINATE_GRACE_MS,
  CHILD_WATCHDOG_MS,
  DESCENDANT_QUIESCENCE_LIMITATION,
  ERROR_REASONS,
  EXIT_CODES,
  REFUSAL_REASONS,
  WAVE_PATTERN,
  buildStepPlan,
  decideArgumentRefusal,
  decideOriginRewriteRefusal,
  decidePreSpawnBindability,
  decidePreflightRefusal,
  isProblemContract,
  isRootBoundStep,
  isValidPort,
  makeError,
  makeRefusal,
  parseArgs,
  runServedBuildPreflights,
  statStepPlanPaths,
  validateStepPlan,
} from "./wave-end-gate-binding.mjs";
import { randomUUID } from "node:crypto";
import {
  buildReceipt,
  buildServedSubject,
  classifyRawChildProblem,
  deriveRootBoundTypedResult,
  finishProblem,
  foldStatuses,
  isAttemptedChildStepContract,
  isExecutionResultContract,
  nonExecutionPlanResult,
  normalizeTypedStepResult,
  normalizedProblem,
  readResultReportSnapshot,
  resolveCurrentStepResult,
  sourceFromArgs,
  writeReceiptFiles,
} from "./wave-end-gate-receipt.mjs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export {
  EXIT_CODES,
  REFUSAL_REASONS,
  ERROR_REASONS,
  CHILD_WATCHDOG_MS,
  CHILD_TERMINATE_GRACE_MS,
  CHILD_HARD_STOP_GRACE_MS,
  STEP_RESULT_SCHEMA_VERSION,
  ROOT_BINDING,
  BINDING_BLOCKERS,
  isRootBoundStep,
  makeRefusal,
  makeError,
  parseArgs,
  decideArgumentRefusal,
  decideOriginRewriteRefusal,
  resolveServedOrigin,
  visualRegressionBlockers,
  buildStepPlan,
  normalizePreflightRecord,
  decidePreflightRefusal,
  validateStepPlan,
  statStepPlanPaths,
  collectPreSpawnBlockers,
  decidePreSpawnBindability,
} from "./wave-end-gate-binding.mjs";
export {
  foldStatuses,
  buildReceipt,
  classifyRawChildProblem,
  buildServedSubject,
  isAttemptedChildStepContract,
  deriveRootBoundTypedResult,
  normalizeTypedStepResult,
  resolveCurrentStepResult,
  sourceFromArgs,
  buildMarkdownSummary,
} from "./wave-end-gate-receipt.mjs";

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
        binding: step.binding ?? null,
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

  let normalized;
  if (resolution?.problem) {
    normalized = normalizedProblem(resolution.problem);
  } else if (
    !isAttemptedChildStepContract(resolvedResult) &&
    isRootBoundStep(step)
  ) {
    const derived = deriveRootBoundTypedResult(step, {
      raw,
      source,
      servedSubject,
      reportSnapshot: resolution?.snapshot ?? null,
    });
    normalized = derived.problem
      ? normalizedProblem(derived.problem)
      : normalizeTypedStepResult(derived.typedResult, {
          step,
          raw,
          source,
          servedSubject,
          rootBound: true,
        });
  } else {
    normalized = normalizeTypedStepResult(resolvedResult, {
      step,
      raw,
      source,
      servedSubject,
    });
  }

  return {
    receipt: {
      name: step.name,
      command: step.command,
      bindability: { ...step.bindability },
      binding: step.binding ?? null,
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
