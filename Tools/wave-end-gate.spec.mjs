import test from "node:test";
import {
  CHILD_HARD_STOP_GRACE_MS,
  CHILD_TERMINATE_GRACE_MS,
  CHILD_WATCHDOG_MS,
  ERROR_REASONS,
  EXIT_CODES,
  REFUSAL_REASONS,
  ROOT_BINDING,
  STEP_RESULT_SCHEMA_VERSION,
  buildMarkdownSummary,
  buildServedSubject,
  buildStepPlan,
  classifyRawChildProblem,
  executeStep,
  executeStepPlan,
  main,
  normalizeTypedStepResult,
  parseArgs,
  resolveCurrentStepResult,
  runChildProcess,
  sourceFromArgs,
} from "./wave-end-gate.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";

const SOURCE_COMMIT = "a".repeat(40);
const SOURCE_IDENTITY = "b".repeat(64);

function validArgv(extra = []) {
  return [
    "--wave",
    "wave-1",
    "--port",
    "8094",
    "--bucket-port",
    "8095",
    "--source-commit",
    SOURCE_COMMIT,
    "--source-dirty",
    "false",
    "--source-identity",
    SOURCE_IDENTITY,
    ...extra,
  ];
}

// The one canonical invocation that is still pre-spawn-unbindable. Baseline
// promotion makes the child re-measure the worktree mid-run to prove source
// stability, which a constant root-supplied provenance tuple cannot stand in
// for — so the barrier still has a live path through main() and the tests that
// pin it use this argv rather than the ordinary one.
const BASELINE_REASON = "Reviewed renderer correction";
function unbindableArgv(extra = []) {
  return validArgv([
    "--update-baselines",
    "--reason",
    BASELINE_REASON,
    ...extra,
  ]);
}

function makePreflightRecords(args) {
  return [
    {
      name: "main-bundle",
      path: "Build/CesiumUnminified/Cesium.js",
      origin: `http://localhost:${args.port}`,
      passed: true,
      diskMd5: "1".repeat(32),
      servedMd5: "1".repeat(32),
      byteLength: 10,
      reasons: [],
    },
    {
      name: "sandcastle-engine-bundle",
      path: "packages/engine/Build/Unminified/index.js",
      origin: `http://localhost:${args.bucketPort}`,
      passed: true,
      diskMd5: "2".repeat(32),
      servedMd5: "2".repeat(32),
      byteLength: 20,
      reasons: [],
    },
  ];
}

function makeRaw(overrides = {}) {
  return {
    runId: "current-run",
    spawned: true,
    startedAt: "2026-08-29T10:00:00.000Z",
    finishedAt: "2026-08-29T10:00:01.000Z",
    startedEpochMs: Date.parse("2026-08-29T10:00:00.000Z"),
    finishedEpochMs: Date.parse("2026-08-29T10:00:01.000Z"),
    wallMs: 1000,
    exitCode: 0,
    signal: null,
    error: null,
    timedOut: false,
    watchdogMs: CHILD_WATCHDOG_MS,
    cleanup: {
      terminateAttempted: false,
      terminateAccepted: null,
      hardKillAttempted: false,
      hardKillAccepted: null,
      directChildCloseObserved: true,
      cleanupDeadlineExceeded: false,
      error: null,
    },
    quiescence: {
      directChildCloseObserved: true,
      descendantProcessTreeProven: false,
      limitation:
        "Direct-child close does not prove descendant process-tree quiescence.",
    },
    ...overrides,
  };
}

const INJECTED_ERROR_MESSAGE = "Injected child runtime error.";

function makeErrorStepReceipt(step, raw = makeRaw({ error: "spawn fault" })) {
  return {
    name: step.name,
    command: step.command,
    bindability: step.bindability,
    binding: step.binding,
    raw,
    normalized: {
      status: "ERROR",
      exitCode: EXIT_CODES.ERROR,
      reason: ERROR_REASONS.CHILD_SPAWN_ERROR,
      message: INJECTED_ERROR_MESSAGE,
      typedResult: null,
    },
  };
}

function makeInjectedErrorProblem() {
  return {
    status: "ERROR",
    exitCode: EXIT_CODES.ERROR,
    name: ERROR_REASONS.CHILD_SPAWN_ERROR,
    message: INJECTED_ERROR_MESSAGE,
  };
}

function makeTypedResult({
  step,
  raw,
  source,
  servedSubject,
  status = "PASS",
}) {
  return {
    schemaVersion: STEP_RESULT_SCHEMA_VERSION,
    runId: raw.runId,
    stepName: step.name,
    startedAt: raw.startedAt,
    finishedAt: raw.finishedAt,
    source,
    servedSubject,
    status,
    exitCode: EXIT_CODES[status],
    reason: status === "PASS" ? null : `${status}_WITNESS`,
    message: null,
    quiescence: { descendantProcessTreeProven: true },
  };
}

// A root-bound step that declares a fixed report must still be bound to a
// current-run digest of it — the verdict may not rest on the exit code alone.
// This is what a child that rewrote its report, but emitted no typed receipt,
// looks like to the root.
function freshResolution({ step, raw, priorSnapshot }) {
  if (!step.resultReportPath) {
    return { result: null, snapshot: priorSnapshot };
  }
  return {
    result: null,
    snapshot: {
      exists: true,
      bytes: null,
      mtimeMs: raw.startedEpochMs,
      sha256: createHash("sha256")
        .update(`${step.name}:${raw.runId}`)
        .digest("hex"),
    },
  };
}

function makeMainDependencies(args, overrides = {}) {
  const receipts = [];
  const dependencies = {
    nowIso: () => "2026-08-29T10:00:00.000Z",
    logError: () => {},
    logInfo: () => {},
    toolsDir: "X:/isolated/Tools",
    projectRoot: "X:/isolated",
    writeReceipt: async (_toolsDir, receipt) => {
      receipts.push(receipt);
    },
    loadOriginRewrite: async () => ({
      installOriginRewrite() {},
      createGuardedPage() {},
    }),
    loadPreflight: async () => ({
      preflightServedBuildArtifacts() {},
    }),
    runPreflights: async () => ({
      records: makePreflightRecords(args),
      problem: null,
    }),
    statPlanPaths: async () => null,
    ...overrides,
  };
  return { dependencies, receipts };
}

async function importProductionMutant(target, replacement, label) {
  const files = [
    "wave-end-gate.mjs",
    "wave-end-gate-binding.mjs",
    "wave-end-gate-receipt.mjs",
  ];
  const sources = new Map(
    await Promise.all(
      files.map(async (file) => [
        file,
        await readFile(new URL("./" + file, import.meta.url), "utf8"),
      ]),
    ),
  );
  assert.equal(
    [...sources.values()].reduce(
      (count, text) => count + text.split(target).length - 1,
      0,
    ),
    1,
    `${label} mutation must have exactly one target`,
  );
  const urls = new Map();
  const encode = (file) => {
    if (urls.has(file)) return urls.get(file);
    const origin = new URL("./" + file, import.meta.url);
    const source = sources
      .get(file)
      .replace(target, replacement)
      .replace(/^#![^\r\n]*(?:\r?\n)?/, "")
      .replace(
        /(from\s+|import\s*\(\s*)(["'])(\.[^"']+)\2/g,
        (_match, prefix, _quote, specifier) => {
          const local = specifier.slice(2);
          const resolved = sources.has(local)
            ? encode(local)
            : new URL(specifier, origin).href;
          return prefix + JSON.stringify(resolved);
        },
      );
    const url = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
    urls.set(file, url);
    return url;
  };
  return import(encode("wave-end-gate.mjs"));
}

let rootBindingMutantPromise;

// Makes the root-binding path UNREACHABLE without deleting it: every call site
// routes through isRootBoundStep, so `false &&` in its body leaves the
// derivation, the declared maps and the plan text exactly where they are and
// simply stops them from being reached. A spec that survives this is asserting
// text, not behaviour.
function importRootBindingMutant() {
  rootBindingMutantPromise ??= importProductionMutant(
    "return step?.binding?.boundBy === ROOT_BINDING;",
    "return false && step?.binding?.boundBy === ROOT_BINDING;",
    "root-binding predicate",
  );
  return rootBindingMutantPromise;
}

let barrierMutantPromise;

function importBarrierMutant() {
  barrierMutantPromise ??= importProductionMutant(
    'step?.bindability?.phase === "pre-spawn"',
    "false",
    "shared pre-spawn predicate",
  );
  return barrierMutantPromise;
}

test("main rejects an altered injected plan before stat or execution", async () => {
  const args = parseArgs(validArgv());
  const altered = buildStepPlan(args).map((step) => ({
    ...step,
    args: [...step.args],
    env: { ...step.env },
    bindability: { ...step.bindability },
  }));
  altered[0].command = "node hostile.mjs";
  let statCalls = 0;
  let executeCalls = 0;
  const { dependencies, receipts } = makeMainDependencies(args, {
    buildPlan: () => altered,
    statPlanPaths: async () => {
      statCalls += 1;
      return null;
    },
    executePlan: async () => {
      executeCalls += 1;
      return { steps: [], problem: null };
    },
  });

  const exitCode = await main(validArgv(), dependencies);
  assert.equal(exitCode, EXIT_CODES.STRUCTURAL);
  assert.equal(statCalls, 0);
  assert.equal(executeCalls, 0);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].problem.reason, REFUSAL_REASONS.PLAN_INVALID);
  assert.deepEqual(receipts[0].plan, []);
});

test("main discards a mutable validated plan before stat and barrier receipt", async () => {
  const argv = unbindableArgv();
  const args = parseArgs(argv);
  const canonicalNames = buildStepPlan(args).map((step) => step.name);
  const injected = buildStepPlan(args).map((step) => ({
    ...step,
    args: [...step.args],
    env: { ...step.env },
    bindability: { ...step.bindability },
  }));
  const events = [];
  let statPlan;
  let executeCalls = 0;
  const { dependencies, receipts } = makeMainDependencies(args, {
    buildPlan: () => injected,
    statPlanPaths: async (plan) => {
      events.push("stat");
      statPlan = plan;
      injected[0].name = "mutated-after-validation";
      return null;
    },
    executePlan: async () => {
      executeCalls += 1;
      throw new Error("must remain unreachable");
    },
  });

  const exitCode = await main(argv, dependencies);
  assert.equal(exitCode, EXIT_CODES.STRUCTURAL);
  assert.deepEqual(events, ["stat"]);
  assert.equal(executeCalls, 0);
  assert.notEqual(statPlan, injected);
  assert.equal(Object.isFrozen(statPlan), true);
  assert.deepEqual(
    statPlan.map((step) => step.name),
    canonicalNames,
  );
  assert.deepEqual(
    receipts[0].plan.map((step) => step.name),
    canonicalNames,
  );
  assert.equal(receipts[0].steps[0].raw.spawned, false);
});

// INVERTED from "the whole canonical plan is blocked": the ordinary invocation
// is no longer blocked, so this now pins the barrier on the invocation that IS
// still unbindable — baseline promotion — and additionally requires the banked
// receipt to carry the blocker's remediation, which the old assertion did not.
test("a pre-spawn blocker still blocks the whole plan before spawn", async () => {
  const argv = unbindableArgv();
  const args = parseArgs(argv);
  const canonicalPlan = buildStepPlan(args);
  let spawnCalls = 0;
  const { dependencies, receipts } = makeMainDependencies(args, {
    executionDependencies: {
      runChild: async () => {
        spawnCalls += 1;
        throw new Error("must remain unreachable");
      },
      resolveStepResult: async () => {
        throw new Error("must remain unreachable");
      },
    },
  });

  const exitCode = await main(argv, dependencies);
  assert.equal(exitCode, EXIT_CODES.STRUCTURAL);
  assert.equal(spawnCalls, 0);
  assert.equal(receipts.length, 1);
  assert.equal(
    receipts[0].problem.reason,
    REFUSAL_REASONS.CAPTURE_AND_DIFF_UNBINDABLE,
  );
  assert.match(
    receipts[0].problem.message,
    /BASELINE_PROMOTION_UNBINDABLE.*REMEDIATION: /s,
  );
  // The banked summary is what a reader actually sees, so the blocker and its
  // remediation have to survive into it, not just into the JSON.
  const summary = buildMarkdownSummary(receipts[0]);
  assert.match(summary, /## Pre-spawn blockers/);
  assert.match(summary, /BASELINE_PROMOTION_UNBINDABLE/);
  assert.match(
    summary,
    /## Limitations this receipt does NOT prove[\s\S]*descendant process-tree quiescence/,
  );
  assert.equal(receipts[0].steps.length, canonicalPlan.length);
  assert.deepEqual(
    receipts[0].steps.map((step) => step.name),
    canonicalPlan.map((step) => step.name),
  );
  assert.equal(receipts[0].steps.at(-1).name, "visual-regression");
  assert.equal(
    receipts[0].steps.every((step) => !step.raw.spawned),
    true,
  );
  assert.equal(
    receipts[0].steps.every(
      (step) =>
        step.normalized.status === "STRUCTURAL" &&
        step.normalized.reason ===
          REFUSAL_REASONS.CAPTURE_AND_DIFF_UNBINDABLE &&
        /No child spawned/.test(step.normalized.message) &&
        step.raw.quiescence.descendantProcessTreeProven === false,
    ),
    true,
  );
});

test("main-level bindability makes an injected all-PASS executor inert", async () => {
  const argv = unbindableArgv();
  const args = parseArgs(argv);
  const canonicalPlan = buildStepPlan(args);
  let executorCalls = 0;
  let childCalls = 0;
  const { dependencies, receipts } = makeMainDependencies(args, {
    executionDependencies: {
      runChild: async () => {
        childCalls += 1;
        return makeRaw();
      },
    },
    executePlan: async (
      plan,
      { source, servedSubject },
      executionDependencies,
    ) => {
      executorCalls += 1;
      await executionDependencies.runChild();
      return {
        steps: plan.map((step, index) => {
          const raw = makeRaw({ runId: `offered-pass-${index}` });
          const typedResult = makeTypedResult({
            step,
            raw,
            source,
            servedSubject,
          });
          return {
            name: step.name,
            command: step.command,
            bindability: step.bindability,
            raw,
            normalized: normalizeTypedStepResult(typedResult, {
              step,
              raw,
              source,
              servedSubject,
            }),
          };
        }),
        problem: null,
      };
    },
  });

  const exitCode = await main(argv, dependencies);
  assert.equal(exitCode, EXIT_CODES.STRUCTURAL);
  assert.equal(executorCalls, 0);
  assert.equal(childCalls, 0);
  assert.equal(
    receipts[0].problem.reason,
    REFUSAL_REASONS.CAPTURE_AND_DIFF_UNBINDABLE,
  );
  assert.deepEqual(
    receipts[0].steps.map((step) => step.name),
    canonicalPlan.map((step) => step.name),
  );
  assert.equal(
    receipts[0].steps.every(
      (step) =>
        step.raw.spawned === false && step.normalized.status === "STRUCTURAL",
    ),
    true,
  );
});

test("dry-run is a nonexecution STRUCTURAL result", async () => {
  const argv = validArgv(["--dry-run"]);
  const args = parseArgs(argv);
  let executeCalls = 0;
  const { dependencies, receipts } = makeMainDependencies(args, {
    executePlan: async () => {
      executeCalls += 1;
      return { steps: [], problem: null };
    },
  });

  const exitCode = await main(argv, dependencies);
  assert.equal(exitCode, EXIT_CODES.STRUCTURAL);
  assert.equal(executeCalls, 0);
  assert.equal(
    receipts[0].problem.reason,
    REFUSAL_REASONS.DRY_RUN_NON_EXECUTION,
  );
});

test("valid-wave argument provenance failures bank a STRUCTURAL receipt", async () => {
  const argv = validArgv();
  argv[argv.indexOf("--source-dirty") + 1] = "invalid";
  const args = parseArgs(argv);
  const { dependencies, receipts } = makeMainDependencies(args);

  const exitCode = await main(argv, dependencies);
  assert.equal(exitCode, EXIT_CODES.STRUCTURAL);
  assert.equal(receipts.length, 1);
  assert.deepEqual(receipts[0].source, {
    commit: SOURCE_COMMIT,
    dirty: null,
    identity: SOURCE_IDENTITY,
  });
  assert.equal(
    receipts[0].problem.reason,
    REFUSAL_REASONS.SOURCE_DIRTY_REQUIRED,
  );
  assert.equal(receipts[0].verdict, "STRUCTURAL");
});

test("an invalid wave cannot invent a receipt output path", async () => {
  const args = parseArgs([]);
  const { dependencies, receipts } = makeMainDependencies(args);

  const exitCode = await main([], dependencies);
  assert.equal(exitCode, EXIT_CODES.STRUCTURAL);
  assert.equal(receipts.length, 0);
});

// INVERTED from "raw canonical exits without a typed current-run result are
// STRUCTURAL". The root now derives the result, so the stronger claim is that
// the verdict follows the step's DECLARED map exactly — and that an exit the map
// does not declare is still refused rather than guessed.
test("a child that emits no typed result gets the verdict its declared map assigns", async () => {
  const args = parseArgs(validArgv());
  const source = sourceFromArgs(args);
  const servedSubject = buildServedSubject(args, makePreflightRecords(args));
  const step = buildStepPlan(args)[0];

  const runStep = async (exitCode) =>
    executeStep(
      step,
      {
        projectRoot: "X:/isolated",
        source,
        servedSubject,
        priorSnapshot: null,
      },
      {
        runChild: async () => makeRaw({ exitCode }),
        resolveStepResult: async () => ({ result: null, snapshot: null }),
      },
    );

  for (const [exitCode, status] of [
    [0, "PASS"],
    [1, "FAIL"],
    [2, "STRUCTURAL"],
  ]) {
    const executed = await runStep(exitCode);
    assert.equal(
      executed.receipt.normalized.status,
      status,
      `exit ${exitCode}`,
    );
    assert.equal(executed.receipt.normalized.exitCode, EXIT_CODES[status]);
    assert.equal(executed.receipt.normalized.typedResult.boundBy, ROOT_BINDING);
    // The message quotes the declared meaning, so the receipt explains the
    // verdict rather than just asserting it.
    assert.ok(
      executed.receipt.normalized.typedResult.message.includes(
        step.binding.exitCodeMeaning[String(exitCode)],
      ),
    );
    // The root's own observations, not the child's claims.
    assert.equal(
      executed.receipt.normalized.typedResult.runId,
      makeRaw().runId,
    );
    assert.deepEqual(executed.receipt.normalized.typedResult.source, source);
    assert.deepEqual(
      executed.receipt.normalized.typedResult.servedSubject,
      servedSubject,
    );
  }

  // Exit 3 is a real S5 code that classifyRawChildProblem lets through, and no
  // canonical child declares it. An undeclared code is refused, not mapped.
  const undeclared = await runStep(3);
  assert.equal(undeclared.receipt.normalized.status, "STRUCTURAL");
  assert.equal(
    undeclared.receipt.normalized.reason,
    REFUSAL_REASONS.EXIT_CODE_UNDECLARED,
  );
});

test("a stale fixed report still fails a root-bound step closed", async () => {
  const args = parseArgs(validArgv());
  const source = sourceFromArgs(args);
  const servedSubject = buildServedSubject(args, makePreflightRecords(args));
  const step = buildStepPlan(args)[1];
  const raw = makeRaw();
  const bytes = Buffer.from('{"sweep":"report"}');
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  // Byte-identical to the snapshot taken before the run: the child exited 0 but
  // did not rewrite its report, so there is no evidence it ran this time.
  const stale = await executeStep(
    step,
    {
      projectRoot: "X:/isolated",
      source,
      servedSubject,
      priorSnapshot: {
        exists: true,
        bytes,
        mtimeMs: raw.startedEpochMs - 1,
        sha256,
      },
    },
    {
      runChild: async () => raw,
      resolveStepResult: (context) =>
        resolveCurrentStepResult(context, {
          readFile: async () => bytes,
          statPath: async () => ({ mtimeMs: raw.startedEpochMs }),
        }),
    },
  );
  assert.equal(stale.receipt.normalized.status, "STRUCTURAL");
  assert.equal(
    stale.receipt.normalized.reason,
    REFUSAL_REASONS.CHILD_RECEIPT_STALE,
  );

  // A freshly rewritten report binds, and its digest is banked as the evidence.
  const freshBytes = Buffer.from('{"sweep":"report","run":2}');
  const fresh = await executeStep(
    step,
    {
      projectRoot: "X:/isolated",
      source,
      servedSubject,
      priorSnapshot: {
        exists: true,
        bytes,
        mtimeMs: raw.startedEpochMs - 1,
        sha256,
      },
    },
    {
      runChild: async () => raw,
      resolveStepResult: (context) =>
        resolveCurrentStepResult(context, {
          readFile: async () => freshBytes,
          statPath: async () => ({ mtimeMs: raw.startedEpochMs }),
        }),
    },
  );
  assert.equal(fresh.receipt.normalized.status, "PASS");
  assert.equal(
    fresh.receipt.normalized.typedResult.evidence.resultReportSha256,
    createHash("sha256").update(freshBytes).digest("hex"),
  );
  assert.equal(
    fresh.receipt.normalized.typedResult.evidence.resultReportPath,
    step.resultReportPath,
  );
});

test("a separate injected typed-result resolver can normalize all canonical statuses", async () => {
  const args = parseArgs(validArgv());
  const source = sourceFromArgs(args);
  const servedSubject = buildServedSubject(args, makePreflightRecords(args));
  const step = buildStepPlan(args)[0];

  for (const status of ["PASS", "FAIL", "ERROR", "STRUCTURAL"]) {
    const exitCode = EXIT_CODES[status];
    const executed = await executeStep(
      step,
      {
        projectRoot: "X:/isolated",
        source,
        servedSubject,
        priorSnapshot: null,
      },
      {
        runChild: async () => makeRaw({ exitCode }),
        resolveStepResult: async (context) => ({
          result: makeTypedResult({ ...context, status }),
          snapshot: null,
        }),
      },
    );
    assert.equal(executed.receipt.normalized.status, status);
    assert.equal(executed.receipt.normalized.exitCode, exitCode);
  }
  // INVERTED from `assert.equal(step.bindability.bindable, false)`. The
  // stronger claim: the step is bound, it says by what, and a child that DOES
  // offer its own typed receipt is still validated strictly rather than being
  // quietly replaced by the root's derivation.
  assert.equal(step.bindability.bindable, true);
  assert.equal(step.bindability.boundBy, ROOT_BINDING);
  const hostile = await executeStep(
    step,
    {
      projectRoot: "X:/isolated",
      source,
      servedSubject,
      priorSnapshot: null,
    },
    {
      runChild: async () => makeRaw({ exitCode: 1 }),
      // A child result that claims to be a typed contract but is bound to
      // another run must fail closed — the root binding is not a way around the
      // child contract, only a substitute when there is no child contract.
      resolveStepResult: async (context) => ({
        result: {
          ...makeTypedResult({ ...context, status: "PASS" }),
          runId: "some-other-run",
        },
        snapshot: null,
      }),
    },
  );
  assert.equal(hostile.receipt.normalized.status, "STRUCTURAL");
  assert.equal(
    hostile.receipt.normalized.reason,
    REFUSAL_REASONS.CHILD_RECEIPT_STALE,
  );
});

test("the bounded watchdog records timeout cleanup without claiming descendant quiescence", async () => {
  const child = new EventEmitter();
  const killSignals = [];
  child.kill = (signal) => {
    killSignals.push(signal);
    return true;
  };
  let clock = Date.parse("2026-08-29T10:00:00.000Z");
  const raw = await runChildProcess(
    buildStepPlan(parseArgs(validArgv()))[0],
    "X:/isolated",
    {
      spawnChild: () => child,
      now: () => {
        clock += 1;
        return clock;
      },
      watchdogMs: 1,
      terminateGraceMs: 1,
      hardStopGraceMs: 1,
    },
  );

  assert.equal(CHILD_WATCHDOG_MS > 0, true);
  assert.equal(CHILD_TERMINATE_GRACE_MS > 0, true);
  assert.equal(CHILD_HARD_STOP_GRACE_MS > 0, true);
  assert.equal(raw.timedOut, true);
  assert.equal(raw.watchdogMs, 1);
  assert.deepEqual(killSignals, ["SIGTERM", "SIGKILL"]);
  assert.equal(raw.cleanup.cleanupDeadlineExceeded, true);
  assert.equal(raw.quiescence.directChildCloseObserved, false);
  assert.equal(raw.quiescence.descendantProcessTreeProven, false);
  assert.match(raw.quiescence.limitation, /does not prove/);
  const problem = classifyRawChildProblem(raw);
  assert.equal(problem.status, "ERROR");
  assert.equal(problem.name, ERROR_REASONS.CHILD_TIMEOUT);
});

test("watchdog cleanup stops after an orderly direct-child close following SIGTERM", async () => {
  const child = new EventEmitter();
  const killSignals = [];
  child.kill = (signal) => {
    killSignals.push(signal);
    if (signal === "SIGTERM") {
      setTimeout(() => child.emit("close", 0, null), 0);
    }
    return true;
  };
  const raw = await runChildProcess(
    buildStepPlan(parseArgs(validArgv()))[0],
    "X:/isolated",
    {
      spawnChild: () => child,
      watchdogMs: 1,
      terminateGraceMs: 10,
      hardStopGraceMs: 10,
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.deepEqual(killSignals, ["SIGTERM"]);
  assert.equal(raw.timedOut, true);
  assert.equal(raw.cleanup.terminateAttempted, true);
  assert.equal(raw.cleanup.hardKillAttempted, false);
  assert.equal(raw.cleanup.directChildCloseObserved, true);
  assert.equal(raw.cleanup.cleanupDeadlineExceeded, false);
});

test("direct executeStepPlan stops after the first explicit child ERROR", async () => {
  const args = parseArgs(validArgv());
  const source = sourceFromArgs(args);
  const servedSubject = buildServedSubject(args, makePreflightRecords(args));
  const plan = buildStepPlan(args).slice(0, 2);
  let childCalls = 0;
  const result = await executeStepPlan(
    plan,
    { projectRoot: "X:/isolated", source, servedSubject },
    {
      snapshotDependencies: {
        readFile: async () => {
          const error = new Error("missing report");
          error.code = "ENOENT";
          throw error;
        },
        statPath: async () => ({ mtimeMs: 0 }),
      },
      runChild: async () => {
        childCalls += 1;
        return makeRaw({ error: "spawn fault" });
      },
      resolveStepResult: async () => {
        throw new Error("must remain unreachable after raw ERROR");
      },
    },
  );

  assert.equal(childCalls, 1);
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].normalized.status, "ERROR");
  assert.equal(result.problem.name, ERROR_REASONS.CHILD_SPAWN_ERROR);
});

test("main banks import and malformed injected runtime contracts as ERROR", async () => {
  const args = parseArgs(validArgv());
  const barrierMutant = await importBarrierMutant();
  const cases = [
    {
      overrides: {
        loadOriginRewrite: async () => {
          throw new Error("import fault");
        },
      },
      expectedReason: ERROR_REASONS.ORIGIN_REWRITE_IMPORT_FAILED,
    },
    {
      overrides: {
        runPreflights: async () => ({ records: "not-an-array", problem: null }),
      },
      expectedReason: ERROR_REASONS.SERVED_BUILD_PREFLIGHT_RUNTIME_FAILED,
    },
    {
      overrides: {
        executePlan: async () => ({ steps: "not-an-array", problem: null }),
      },
      expectedReason: ERROR_REASONS.UNEXPECTED_GATE_ERROR,
    },
    {
      overrides: {
        executePlan: async () => ({
          steps: [{ raw: {}, normalized: { status: "PASS" } }],
          problem: null,
        }),
      },
      expectedReason: ERROR_REASONS.UNEXPECTED_GATE_ERROR,
    },
  ];

  for (const { overrides, expectedReason } of cases) {
    const { dependencies, receipts } = makeMainDependencies(args, overrides);
    const entryPoint = overrides.executePlan ? barrierMutant.main : main;
    const exitCode = await entryPoint(validArgv(), dependencies);
    assert.equal(exitCode, EXIT_CODES.ERROR);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].problem.status, "ERROR");
    assert.equal(receipts[0].problem.reason, expectedReason);
    assert.equal(receipts[0].exitCode, EXIT_CODES.ERROR);
  }
});

test("barrier mutant accepts an exact ordered execution prefix ending in a bound ERROR", async () => {
  const args = parseArgs(validArgv());
  const barrierMutant = await importBarrierMutant();
  const { dependencies, receipts } = makeMainDependencies(args, {
    executePlan: async (plan) => ({
      steps: [makeErrorStepReceipt(plan[0])],
      problem: makeInjectedErrorProblem(),
    }),
  });

  const exitCode = await barrierMutant.main(validArgv(), dependencies);
  assert.equal(exitCode, EXIT_CODES.ERROR);
  assert.equal(receipts[0].steps.length, 1);
  assert.equal(receipts[0].steps[0].name, buildStepPlan(args)[0].name);
  assert.equal(receipts[0].problem.reason, ERROR_REASONS.CHILD_SPAWN_ERROR);
});

test("barrier mutant rejects skipped or incomplete injected execution receipts", async () => {
  const args = parseArgs(validArgv());
  const barrierMutant = await importBarrierMutant();
  const cases = [
    (plan) => ({
      steps: [makeErrorStepReceipt(plan[1])],
      problem: makeInjectedErrorProblem(),
    }),
    (plan) => ({
      steps: [makeErrorStepReceipt(plan[0]), makeErrorStepReceipt(plan[2])],
      problem: makeInjectedErrorProblem(),
    }),
    (plan) => {
      const receipt = makeErrorStepReceipt(plan[0]);
      const { runId: _runId, ...incompleteRaw } = receipt.raw;
      receipt.raw = incompleteRaw;
      return { steps: [receipt], problem: makeInjectedErrorProblem() };
    },
    (plan) => {
      const receipt = makeErrorStepReceipt(plan[0]);
      const { hardKillAccepted: _hardKillAccepted, ...incompleteCleanup } =
        receipt.raw.cleanup;
      receipt.raw = { ...receipt.raw, cleanup: incompleteCleanup };
      return { steps: [receipt], problem: makeInjectedErrorProblem() };
    },
    (plan) => {
      const receipt = makeErrorStepReceipt(plan[0]);
      const { limitation: _limitation, ...incompleteQuiescence } =
        receipt.raw.quiescence;
      receipt.raw = { ...receipt.raw, quiescence: incompleteQuiescence };
      return { steps: [receipt], problem: makeInjectedErrorProblem() };
    },
    (plan) => {
      const receipt = makeErrorStepReceipt(plan[0]);
      const { message: _message, ...incompleteNormalized } = receipt.normalized;
      receipt.normalized = incompleteNormalized;
      return { steps: [receipt], problem: makeInjectedErrorProblem() };
    },
  ];

  for (const createExecution of cases) {
    const { dependencies, receipts } = makeMainDependencies(args, {
      executePlan: async (plan) => createExecution(plan),
    });
    const exitCode = await barrierMutant.main(validArgv(), dependencies);
    assert.equal(exitCode, EXIT_CODES.ERROR);
    assert.equal(receipts.length, 1);
    assert.equal(
      receipts[0].problem.reason,
      ERROR_REASONS.UNEXPECTED_GATE_ERROR,
    );
  }
});

test("executed production-source mutant proves the pre-spawn barrier is load-bearing", async () => {
  const mutatedModule = await importBarrierMutant();
  const argv = unbindableArgv();
  const args = parseArgs(argv);

  const makeAdapterDependencies = (counter) => ({
    snapshotDependencies: {
      readFile: async () => {
        const error = new Error("no prior fixed report");
        error.code = "ENOENT";
        throw error;
      },
      statPath: async () => ({ mtimeMs: 0 }),
    },
    runChild: async () => {
      counter.value += 1;
      return makeRaw({ runId: `adapter-run-${counter.value}` });
    },
    resolveStepResult: async (context) => ({
      result: makeTypedResult(context),
      snapshot: context.priorSnapshot,
    }),
  });

  const currentCounter = { value: 0 };
  const currentHarness = makeMainDependencies(args, {
    executionDependencies: makeAdapterDependencies(currentCounter),
  });
  const currentExit = await main(argv, currentHarness.dependencies);
  assert.equal(currentExit, EXIT_CODES.STRUCTURAL);
  assert.equal(currentCounter.value, 0);

  const mutantCounter = { value: 0 };
  const mutantHarness = makeMainDependencies(args, {
    executionDependencies: makeAdapterDependencies(mutantCounter),
  });
  const mutantExit = await mutatedModule.main(argv, mutantHarness.dependencies);
  assert.equal(mutantExit, EXIT_CODES.PASS);
  assert.equal(mutantCounter.value, buildStepPlan(args).length);
  assert.equal(mutantHarness.receipts[0].verdict, "PASS");
});

// The row's acceptance, minus the browser: the gate must be able to REACH a
// non-refused receipt with a named exit code that folds from the step statuses.
// Children are injected; nothing is spawned and no browser is launched.
test("a bindable plan banks a non-refused receipt whose exit code folds from its steps", async () => {
  const args = parseArgs(validArgv());

  const runWithExits = async (exitsByStepName) => {
    const spawned = [];
    const { dependencies, receipts } = makeMainDependencies(args, {
      executionDependencies: {
        snapshotDependencies: {
          readFile: async () => {
            const error = new Error("no prior fixed report");
            error.code = "ENOENT";
            throw error;
          },
          statPath: async () => ({ mtimeMs: 0 }),
        },
        runChild: async (step) => {
          spawned.push(step.name);
          return makeRaw({
            runId: `bound-run-${spawned.length}`,
            exitCode: exitsByStepName[step.name] ?? 0,
          });
        },
        // Every canonical child emits no typed result and no fresh fixed
        // report, which is exactly the situation the root binding exists for.
        resolveStepResult: async (context) => freshResolution(context),
      },
    });
    const exitCode = await main(validArgv(), dependencies);
    return { exitCode, receipt: receipts[0], spawned };
  };

  const passing = await runWithExits({});
  assert.equal(passing.exitCode, EXIT_CODES.PASS);
  assert.ok(
    Object.values(EXIT_CODES).includes(passing.exitCode),
    "the exit code must be one of the named EXIT_CODES",
  );
  assert.equal(passing.receipt.problem, null);
  assert.equal(passing.receipt.verdict, "PASS");
  assert.deepEqual(
    passing.spawned,
    buildStepPlan(args).map((step) => step.name),
  );
  assert.equal(
    passing.receipt.steps.every(
      (step) =>
        step.normalized.status === "PASS" &&
        step.normalized.typedResult.boundBy === ROOT_BINDING,
    ),
    true,
  );
  // The receipt names what it did not prove rather than omitting it.
  assert.equal(
    passing.receipt.steps.every(
      (step) =>
        step.raw.quiescence.descendantProcessTreeProven === false &&
        step.raw.quiescence.limitation ===
          "Direct-child close does not prove descendant process-tree quiescence." &&
        step.normalized.typedResult.limitations.includes(
          "Direct-child close does not prove descendant process-tree quiescence.",
        ),
    ),
    true,
  );
  assert.match(
    buildMarkdownSummary(passing.receipt),
    /## Limitations this receipt does NOT prove[\s\S]*descendant process-tree quiescence/,
  );

  // A FAIL-shaped run folds to FAIL, and it is a verdict, not a refusal: the
  // steps still executed and the receipt still has standing.
  const failing = await runWithExits({ "sandcastle2-sweep-webgpu-run-1": 1 });
  assert.equal(failing.exitCode, EXIT_CODES.FAIL);
  assert.equal(failing.receipt.verdict, "FAIL");
  assert.equal(failing.receipt.problem, null);
  assert.equal(
    failing.receipt.steps.find(
      (step) => step.name === "sandcastle2-sweep-webgpu-run-1",
    ).normalized.status,
    "FAIL",
  );
  assert.equal(
    failing.receipt.steps.find((step) => step.name === "variant-smoke-test")
      .normalized.status,
    "PASS",
  );
});

test("executed production-source mutant proves the root binding is load-bearing", async () => {
  const mutated = await importRootBindingMutant();
  const args = parseArgs(validArgv());

  const makeHarness = (module) => {
    const spawned = [];
    const { dependencies, receipts } = makeMainDependencies(args, {
      executionDependencies: {
        snapshotDependencies: {
          readFile: async () => {
            const error = new Error("no prior fixed report");
            error.code = "ENOENT";
            throw error;
          },
          statPath: async () => ({ mtimeMs: 0 }),
        },
        runChild: async (step) => {
          spawned.push(step.name);
          return makeRaw({
            runId: `mutant-run-${spawned.length}`,
            exitCode: 0,
          });
        },
        resolveStepResult: async (context) => freshResolution(context),
      },
    });
    return { module, dependencies, receipts, spawned };
  };

  const live = makeHarness(main);
  assert.equal(await main(validArgv(), live.dependencies), EXIT_CODES.PASS);
  assert.equal(live.receipts[0].verdict, "PASS");

  // With the binding unreachable, the identical run cannot certify: the child
  // offered no typed contract and nothing is left to derive one from.
  const inert = makeHarness(mutated.main);
  assert.equal(
    await mutated.main(validArgv(), inert.dependencies),
    EXIT_CODES.STRUCTURAL,
  );
  assert.equal(
    inert.receipts[0].problem.reason,
    REFUSAL_REASONS.CHILD_CONTRACT_ABSENT,
  );
  assert.equal(inert.receipts[0].verdict, "STRUCTURAL");
});
