import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CHILD_HARD_STOP_GRACE_MS,
  CHILD_TERMINATE_GRACE_MS,
  CHILD_WATCHDOG_MS,
  ERROR_REASONS,
  EXIT_CODES,
  REFUSAL_REASONS,
  STEP_RESULT_SCHEMA_VERSION,
  buildReceipt,
  buildServedSubject,
  buildStepPlan,
  classifyRawChildProblem,
  decideArgumentRefusal,
  decidePreflightRefusal,
  executeStep,
  executeStepPlan,
  foldStatuses,
  main,
  normalizePreflightRecord,
  normalizeTypedStepResult,
  parseArgs,
  resolveCurrentStepResult,
  runChildProcess,
  sourceFromArgs,
  statStepPlanPaths,
  validateStepPlan,
} from "./wave-end-gate.mjs";

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

let barrierMutantPromise;

function importBarrierMutant() {
  barrierMutantPromise ??= (async () => {
    const sourceText = await readFile(
      new URL("./wave-end-gate.mjs", import.meta.url),
      "utf8",
    );
    const barrier = 'step?.bindability?.phase === "pre-spawn"';
    assert.equal(
      sourceText.split(barrier).length - 1,
      1,
      "shared pre-spawn predicate mutation must have exactly one target",
    );
    let mutant = sourceText.replace(barrier, "false");

    const verdictUrl = new URL(
      "./visual-regression/lib/verdict-exit-gate.mjs",
      import.meta.url,
    ).href;
    mutant = mutant
      .replace(/^#![^\r\n]*(?:\r?\n)?/, "")
      .replace(
        'from "./visual-regression/lib/verdict-exit-gate.mjs";',
        `from ${JSON.stringify(verdictUrl)};`,
      );
    const dataUrl = `data:text/javascript;base64,${Buffer.from(mutant).toString("base64")}`;
    return import(dataUrl);
  })();
  return barrierMutantPromise;
}

test("step plan preserves the required order and commands", () => {
  const args = parseArgs(validArgv(["--runs", "2"]));

  assert.equal(decideArgumentRefusal(args), null);

  const plan = buildStepPlan(args);
  assert.deepEqual(
    plan.map((step) => step.name),
    [
      "variant-smoke-test",
      "sandcastle2-sweep-webgl-run-1",
      "sandcastle2-sweep-webgpu-run-1",
      "sandcastle2-sweep-webgl-run-2",
      "sandcastle2-sweep-webgpu-run-2",
      "visual-regression",
    ],
  );
  assert.deepEqual(
    plan.map((step) => step.command),
    [
      "node Tools/variant-smoke-test.mjs --url http://localhost:8094",
      "node Tools/visual-regression/sandcastle-smoke.mjs --sandcastle2 --renderer=webgl",
      "node Tools/visual-regression/sandcastle-smoke.mjs --sandcastle2 --renderer=webgpu",
      "node Tools/visual-regression/sandcastle-smoke.mjs --sandcastle2 --renderer=webgl",
      "node Tools/visual-regression/sandcastle-smoke.mjs --sandcastle2 --renderer=webgpu",
      "node Tools/visual-regression/capture-and-diff.mjs",
    ],
  );
  assert.deepEqual(plan[1].env, {
    PROBE_BASE: "http://localhost:8094",
    PROBE_SANDCASTLE_BASE: "http://localhost:8095",
  });
  assert.equal(
    plan.some((step) => step.args.includes("--runs")),
    false,
  );
  assert.equal(new Set(plan.map((step) => step.name)).size, plan.length);
  assert.equal(plan.at(-1).bindability.phase, "pre-spawn");
  assert.match(plan.at(-1).bindability.reason, /forbidden port 8080/);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(
    plan.every((step) => Object.isFrozen(step)),
    true,
  );
});

test("exact-plan validation fails closed for incomplete, duplicate, altered, and unreadable plans", () => {
  const args = parseArgs(validArgv());
  const canonical = buildStepPlan(args);
  const duplicate = canonical.map((step) => ({
    ...step,
    args: [...step.args],
    env: { ...step.env },
    bindability: { ...step.bindability },
  }));
  duplicate[1].name = duplicate[0].name;
  const altered = canonical.map((step) => ({
    ...step,
    args: [...step.args],
    env: { ...step.env },
    bindability: { ...step.bindability },
  }));
  altered[0].command = "node hostile.mjs";
  const cyclic = [...altered];
  cyclic[0] = { ...canonical[0] };
  cyclic[0].cycle = cyclic[0];
  const getter = [...canonical];
  getter[0] = {};
  Object.defineProperty(getter[0], "name", {
    get() {
      throw new Error("hostile getter");
    },
  });

  for (const candidate of [[], duplicate, altered, cyclic, getter]) {
    const problem = validateStepPlan(candidate, args);
    assert.equal(problem.status, "STRUCTURAL");
    assert.equal(problem.name, REFUSAL_REASONS.PLAN_INVALID);
  }
});

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

test("all unique planned files are statted before execution", async () => {
  const args = parseArgs(validArgv());
  const plan = buildStepPlan(args);
  const statted = [];
  const problem = await statStepPlanPaths(
    plan,
    "X:/isolated",
    async (absolutePath) => {
      statted.push(absolutePath);
      return { isFile: () => true };
    },
  );

  assert.equal(problem, null);
  assert.equal(statted.length, new Set(plan.map((step) => step.file)).size);
});

test("main discards a mutable validated plan before stat and barrier receipt", async () => {
  const args = parseArgs(validArgv());
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

  const exitCode = await main(validArgv(), dependencies);
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

test("capture-and-diff bindability blocks the whole canonical plan before spawn", async () => {
  const args = parseArgs(validArgv());
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

  const exitCode = await main(validArgv(), dependencies);
  assert.equal(exitCode, EXIT_CODES.STRUCTURAL);
  assert.equal(spawnCalls, 0);
  assert.equal(receipts.length, 1);
  assert.equal(
    receipts[0].problem.reason,
    REFUSAL_REASONS.CAPTURE_AND_DIFF_UNBINDABLE,
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
  const args = parseArgs(validArgv());
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

  const exitCode = await main(validArgv(), dependencies);
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

test("strict arguments reject missing provenance and unsafe endpoints as STRUCTURAL", () => {
  const missingSource = decideArgumentRefusal(parseArgs(["--wave", "wave-1"]));
  assert.equal(missingSource.status, "STRUCTURAL");
  assert.equal(missingSource.exitCode, EXIT_CODES.STRUCTURAL);
  assert.equal(missingSource.name, REFUSAL_REASONS.SOURCE_COMMIT_REQUIRED);

  const port8081 = decideArgumentRefusal(
    parseArgs(validArgv(["--bucket-port", "8081"])),
  );
  assert.equal(port8081.name, REFUSAL_REASONS.PORT_8081_FORBIDDEN);

  const equalPorts = decideArgumentRefusal(
    parseArgs(validArgv(["--bucket-port", "8094"])),
  );
  assert.equal(equalPorts.name, REFUSAL_REASONS.ENDPOINTS_MUST_DIFFER);
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

test("--update-baselines without --reason is STRUCTURAL with a named reason", () => {
  const refusal = decideArgumentRefusal(
    parseArgs(validArgv(["--update-baselines"])),
  );
  assert.equal(refusal.exitCode, EXIT_CODES.STRUCTURAL);
  assert.equal(refusal.name, REFUSAL_REASONS.BASELINE_REASON_REQUIRED);
});

test("baseline-update plan forwards the reviewed rationale", () => {
  const args = parseArgs(
    validArgv(["--update-baselines", "--reason", "WebGPU lighting correction"]),
  );
  const visualStep = buildStepPlan(args).at(-1);

  assert.equal(
    visualStep.command,
    'node Tools/visual-regression/capture-and-diff.mjs --update --confirm-baseline-promotion --update-rationale "WebGPU lighting correction" --reviewed-by wave-end-gate:wave-1',
  );
});

test("status fold is explicitly STRUCTURAL over ERROR over FAIL over PASS", () => {
  assert.equal(foldStatuses([]), "STRUCTURAL");
  assert.equal(foldStatuses(["PASS", "FAIL"]), "FAIL");
  assert.equal(foldStatuses(["FAIL", "ERROR"]), "ERROR");
  assert.equal(foldStatuses(["ERROR", "STRUCTURAL"]), "STRUCTURAL");
  assert.equal(foldStatuses(["PASS", "UNKNOWN"]), "ERROR");
});

test("served-build preflight requires the nested disk and served identity", () => {
  const expected = {
    name: "main-bundle",
    path: "Build/CesiumUnminified/Cesium.js",
  };
  const origin = "http://localhost:8094";
  const result = {
    ok: true,
    origin,
    artifacts: [
      {
        path: expected.path,
        url: `${origin}/${expected.path}`,
        disk: {
          exists: true,
          byteLength: 42,
          md5: "1".repeat(32),
        },
        served: {
          ok: true,
          status: 200,
          byteLength: 42,
          md5: "1".repeat(32),
        },
        match: true,
      },
    ],
  };

  const healthy = normalizePreflightRecord(expected, origin, result);
  assert.equal(healthy.passed, true);
  assert.equal(healthy.diskMd5, "1".repeat(32));
  assert.equal(healthy.servedMd5, "1".repeat(32));

  const mismatch = normalizePreflightRecord(expected, origin, {
    ...result,
    artifacts: [
      {
        ...result.artifacts[0],
        served: {
          ...result.artifacts[0].served,
          md5: "2".repeat(32),
        },
        match: false,
      },
    ],
  });
  assert.equal(mismatch.passed, false);
  assert.deepEqual(mismatch.reasons, ["MD5_MISMATCH", "MATCH_NOT_PROVEN"]);
  const refusal = decidePreflightRefusal([
    mismatch,
    makePreflightRecords(parseArgs(validArgv()))[1],
  ]);
  assert.equal(refusal.status, "STRUCTURAL");
  assert.equal(refusal.name, REFUSAL_REASONS.SERVED_BUILD_PREFLIGHT_FAILED);
});

test("receipt shape contains every required field", () => {
  const args = parseArgs(validArgv());
  const source = sourceFromArgs(args);
  const preflight = makePreflightRecords(args);
  const servedSubject = buildServedSubject(args, preflight);
  const plan = buildStepPlan(args);
  const step = plan[0];
  const raw = makeRaw();
  const typedResult = makeTypedResult({ step, raw, source, servedSubject });
  const receipt = buildReceipt({
    wave: "wave-1",
    startedAt: "2026-08-29T10:00:00.000Z",
    finishedAt: "2026-08-29T10:01:00.000Z",
    source,
    servedSubject,
    preflight,
    plan,
    steps: [
      {
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
      },
    ],
    updateBaselines: true,
    reason: "Reviewed renderer correction",
    verdict: "PASS",
  });

  assert.deepEqual(Object.keys(receipt), [
    "schemaVersion",
    "wave",
    "startedAt",
    "finishedAt",
    "source",
    "servedSubject",
    "preflight",
    "plan",
    "steps",
    "baselineUpdate",
    "problem",
    "verdict",
    "exitCode",
  ]);
  assert.deepEqual(receipt.source, {
    commit: SOURCE_COMMIT,
    dirty: false,
    identity: SOURCE_IDENTITY,
  });
  assert.equal(Object.isFrozen(receipt.source), true);
  assert.deepEqual(receipt.servedSubject, servedSubject);
  assert.deepEqual(receipt.preflight, preflight);
  assert.deepEqual(receipt.plan[0].bindability, step.bindability);
  assert.deepEqual(receipt.steps[0].raw, raw);
  assert.equal(receipt.steps[0].normalized.status, "PASS");
  assert.deepEqual(receipt.steps[0].normalized.typedResult, typedResult);
  assert.deepEqual(receipt.baselineUpdate, {
    requested: true,
    reason: "Reviewed renderer correction",
  });
  assert.equal(receipt.problem, null);
  assert.equal(receipt.verdict, "PASS");
  assert.equal(receipt.exitCode, EXIT_CODES.PASS);
});

test("raw canonical exits without a typed current-run result are STRUCTURAL", async () => {
  const args = parseArgs(validArgv());
  const source = sourceFromArgs(args);
  const servedSubject = buildServedSubject(args, makePreflightRecords(args));
  const step = buildStepPlan(args)[0];

  for (const exitCode of Object.values(EXIT_CODES)) {
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
        resolveStepResult: async () => ({ result: null, snapshot: null }),
      },
    );
    assert.equal(executed.receipt.normalized.status, "STRUCTURAL");
    assert.equal(
      executed.receipt.normalized.reason,
      REFUSAL_REASONS.CHILD_CONTRACT_ABSENT,
    );
  }
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
  assert.equal(step.bindability.bindable, false);
});

test("runtime child witnesses normalize as ERROR", () => {
  const cases = [
    [makeRaw({ error: "spawn failed" }), ERROR_REASONS.CHILD_SPAWN_ERROR],
    [makeRaw({ timedOut: true }), ERROR_REASONS.CHILD_TIMEOUT],
    [
      makeRaw({ signal: "SIGTERM", exitCode: null }),
      ERROR_REASONS.CHILD_SIGNAL,
    ],
    [makeRaw({ exitCode: null }), ERROR_REASONS.CHILD_NULL_EXIT],
    [makeRaw({ exitCode: 99 }), ERROR_REASONS.CHILD_UNKNOWN_EXIT],
    [
      makeRaw({
        cleanup: {
          ...makeRaw().cleanup,
          cleanupDeadlineExceeded: true,
        },
      }),
      ERROR_REASONS.CHILD_CLEANUP_ERROR,
    ],
  ];

  for (const [raw, expectedReason] of cases) {
    const problem = classifyRawChildProblem(raw);
    assert.equal(problem.status, "ERROR");
    assert.equal(problem.exitCode, EXIT_CODES.ERROR);
    assert.equal(problem.name, expectedReason);
  }
});

test("typed results fail closed on freshness, provenance, served subject, and quiescence", () => {
  const args = parseArgs(validArgv());
  const source = sourceFromArgs(args);
  const servedSubject = buildServedSubject(args, makePreflightRecords(args));
  const step = buildStepPlan(args)[0];
  const raw = makeRaw();
  const healthy = makeTypedResult({ step, raw, source, servedSubject });
  const cases = [
    [
      { ...healthy, schemaVersion: 999 },
      REFUSAL_REASONS.CHILD_CONTRACT_MALFORMED,
    ],
    [
      { ...healthy, stepName: "wrong-step" },
      REFUSAL_REASONS.CHILD_CONTRACT_MALFORMED,
    ],
    [
      { ...healthy, status: "UNKNOWN" },
      REFUSAL_REASONS.CHILD_CONTRACT_MALFORMED,
    ],
    [
      { ...healthy, exitCode: EXIT_CODES.FAIL },
      REFUSAL_REASONS.CHILD_CONTRACT_MALFORMED,
    ],
    [{ ...healthy, runId: "prior-run" }, REFUSAL_REASONS.CHILD_RECEIPT_STALE],
    [
      { ...healthy, startedAt: "2026-08-29T09:59:59.999Z" },
      REFUSAL_REASONS.CHILD_RECEIPT_STALE,
    ],
    [
      { ...healthy, finishedAt: "2026-08-29T10:00:01.001Z" },
      REFUSAL_REASONS.CHILD_RECEIPT_STALE,
    ],
    [
      { ...healthy, source: { ...source, commit: "c".repeat(40) } },
      REFUSAL_REASONS.PROVENANCE_MISMATCH,
    ],
    [
      {
        ...healthy,
        servedSubject: { ...servedSubject, base: "http://localhost:9000" },
      },
      REFUSAL_REASONS.SERVED_SUBJECT_MISMATCH,
    ],
    [
      { ...healthy, quiescence: { descendantProcessTreeProven: false } },
      REFUSAL_REASONS.DESCENDANT_QUIESCENCE_UNPROVEN,
    ],
  ];

  for (const [result, expectedReason] of cases) {
    const normalized = normalizeTypedStepResult(result, {
      step,
      raw,
      source,
      servedSubject,
    });
    assert.equal(normalized.status, "STRUCTURAL");
    assert.equal(normalized.reason, expectedReason);
  }

  const cyclic = { ...healthy };
  cyclic.source = cyclic;
  const cyclicNormalized = normalizeTypedStepResult(cyclic, {
    step,
    raw,
    source,
    servedSubject,
  });
  assert.equal(cyclicNormalized.status, "STRUCTURAL");
  assert.equal(
    cyclicNormalized.reason,
    REFUSAL_REASONS.CHILD_CONTRACT_MALFORMED,
  );
});

test("a byte-identical rewritten fixed report remains non-certifying", async () => {
  const args = parseArgs(validArgv());
  const step = buildStepPlan(args)[1];
  const raw = makeRaw();
  const bytes = Buffer.from('{"status":"PASS"}');
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const resolution = await resolveCurrentStepResult(
    {
      step,
      raw,
      projectRoot: "X:/isolated",
      priorSnapshot: {
        exists: true,
        bytes,
        mtimeMs: raw.startedEpochMs - 1,
        sha256,
      },
    },
    {
      readFile: async () => bytes,
      statPath: async () => ({ mtimeMs: raw.startedEpochMs }),
    },
  );

  assert.equal(resolution.problem.status, "STRUCTURAL");
  assert.equal(resolution.problem.name, REFUSAL_REASONS.CHILD_RECEIPT_STALE);
  assert.equal(resolution.snapshot.sha256, sha256);
});

test("fixed-report resolution distinguishes structural freshness loss from runtime read failure", async () => {
  const args = parseArgs(validArgv());
  const step = buildStepPlan(args)[1];
  const raw = makeRaw();
  const structuralCases = [
    {
      readFile: async () => {
        const error = new Error("absent");
        error.code = "ENOENT";
        throw error;
      },
      statPath: async () => ({ mtimeMs: raw.startedEpochMs }),
      reason: REFUSAL_REASONS.CHILD_CONTRACT_ABSENT,
    },
    {
      readFile: async () => Buffer.from("{}"),
      statPath: async () => ({ mtimeMs: raw.startedEpochMs - 1 }),
      reason: REFUSAL_REASONS.CHILD_RECEIPT_STALE,
    },
    {
      readFile: async () => Buffer.from("{}"),
      statPath: async () => ({ mtimeMs: raw.finishedEpochMs + 1 }),
      reason: REFUSAL_REASONS.CHILD_RECEIPT_STALE,
    },
    {
      readFile: async () => Buffer.from("{"),
      statPath: async () => ({ mtimeMs: raw.startedEpochMs }),
      reason: REFUSAL_REASONS.CHILD_CONTRACT_MALFORMED,
    },
  ];

  for (const { reason, ...snapshotDependencies } of structuralCases) {
    const resolution = await resolveCurrentStepResult(
      { step, raw, projectRoot: "X:/isolated", priorSnapshot: null },
      snapshotDependencies,
    );
    assert.equal(resolution.problem.status, "STRUCTURAL");
    assert.equal(resolution.problem.name, reason);
  }

  const readError = await resolveCurrentStepResult(
    { step, raw, projectRoot: "X:/isolated", priorSnapshot: null },
    {
      readFile: async () => {
        const error = new Error("access denied");
        error.code = "EACCES";
        throw error;
      },
      statPath: async () => ({ mtimeMs: raw.startedEpochMs }),
    },
  );
  assert.equal(readError.problem.status, "ERROR");
  assert.equal(readError.problem.name, ERROR_REASONS.CHILD_RESULT_READ_FAILED);
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
  const args = parseArgs(validArgv());

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
  const currentExit = await main(validArgv(), currentHarness.dependencies);
  assert.equal(currentExit, EXIT_CODES.STRUCTURAL);
  assert.equal(currentCounter.value, 0);

  const mutantCounter = { value: 0 };
  const mutantHarness = makeMainDependencies(args, {
    executionDependencies: makeAdapterDependencies(mutantCounter),
  });
  const mutantExit = await mutatedModule.main(
    validArgv(),
    mutantHarness.dependencies,
  );
  assert.equal(mutantExit, EXIT_CODES.PASS);
  assert.equal(mutantCounter.value, buildStepPlan(args).length);
  assert.equal(mutantHarness.receipts[0].verdict, "PASS");
});
