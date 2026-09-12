import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  BINDING_BLOCKERS,
  CHILD_HARD_STOP_GRACE_MS,
  CHILD_TERMINATE_GRACE_MS,
  CHILD_WATCHDOG_MS,
  ERROR_REASONS,
  EXIT_CODES,
  REFUSAL_REASONS,
  ROOT_BINDING,
  STEP_RESULT_SCHEMA_VERSION,
  buildMarkdownSummary,
  buildReceipt,
  buildServedSubject,
  buildStepPlan,
  classifyRawChildProblem,
  collectPreSpawnBlockers,
  decideArgumentRefusal,
  decidePreSpawnBindability,
  decidePreflightRefusal,
  deriveRootBoundTypedResult,
  executeStep,
  executeStepPlan,
  foldStatuses,
  main,
  normalizePreflightRecord,
  normalizeTypedStepResult,
  parseArgs,
  resolveCurrentStepResult,
  resolveServedOrigin,
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
  const sourceText = await readFile(
    new URL("./wave-end-gate.mjs", import.meta.url),
    "utf8",
  );
  assert.equal(
    sourceText.split(target).length - 1,
    1,
    `${label} mutation must have exactly one target`,
  );
  const verdictUrl = new URL(
    "./visual-regression/lib/verdict-exit-gate.mjs",
    import.meta.url,
  ).href;
  const mutant = sourceText
    .replace(target, replacement)
    .replace(/^#![^\r\n]*(?:\r?\n)?/, "")
    .replace(
      'from "./visual-regression/lib/verdict-exit-gate.mjs";',
      `from ${JSON.stringify(verdictUrl)};`,
    );
  return import(
    `data:text/javascript;base64,${Buffer.from(mutant).toString("base64")}`
  );
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
      "node Tools/visual-regression/capture-and-diff.mjs --served-base http://localhost:8094",
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
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(
    plan.every((step) => Object.isFrozen(step)),
    true,
  );
});

// REPLACES the former `assert.match(plan.at(-1).bindability.reason,
// /forbidden port 8080/)`, which pinned a constant refusal. Bindability is now a
// function of the arguments, so the stronger claim is that EVERY step declares a
// complete, auditable binding when it is bindable, and that the one invocation
// that is still blocked says so with a named blocker AND a remediation.
test("every planned step declares the binding its verdict is derived from", () => {
  const plan = buildStepPlan(parseArgs(validArgv()));

  for (const step of plan) {
    assert.equal(step.bindability.bindable, true, step.name);
    assert.equal(step.bindability.boundBy, ROOT_BINDING, step.name);
    assert.deepEqual(step.bindability.blockers, [], step.name);
    assert.equal(step.binding.boundBy, ROOT_BINDING, step.name);
    // The declared map is the answer to "raw exit 0/1 is not a verdict": the
    // mapping is data on the step, readable in the plan and in the receipt.
    assert.deepEqual(step.binding.exitCodeStatus, {
      0: "PASS",
      1: "FAIL",
      2: "STRUCTURAL",
    });
    for (const code of ["0", "1", "2"]) {
      assert.equal(typeof step.binding.exitCodeMeaning[code], "string");
      assert.ok(step.binding.exitCodeMeaning[code].length > 0);
    }
    // Every binding field names where the root got it.
    for (const field of Object.values(step.binding.fields)) {
      assert.match(
        field,
        /^root:/,
        `${step.name} field must name a root source`,
      );
    }
    // What was NOT proven is named, on every step, always.
    assert.deepEqual(step.binding.limitations, [
      "Direct-child close does not prove descendant process-tree quiescence.",
    ]);
  }

  assert.equal(collectPreSpawnBlockers(plan).length, 0);
  assert.equal(decidePreSpawnBindability(plan), null);

  const promotionPlan = buildStepPlan(parseArgs(unbindableArgv()));
  const promotionStep = promotionPlan.at(-1);
  assert.equal(promotionStep.bindability.bindable, false);
  assert.equal(promotionStep.bindability.phase, "pre-spawn");
  assert.equal(promotionStep.bindability.boundBy, null);
  assert.deepEqual(
    promotionStep.bindability.blockers.map((blocker) => blocker.code),
    [BINDING_BLOCKERS.BASELINE_PROMOTION_UNBINDABLE],
  );
  assert.match(promotionStep.bindability.remediation, /capture-and-diff\.mjs/);
});

test("a pre-spawn refusal names every blocker and what each child must gain", () => {
  // Two independent blockers on one step: an unusable served origin and the
  // promotion re-measurement. Naming only the first is what turns a fail-closed
  // gate into a dead one.
  const args = {
    ...parseArgs(unbindableArgv()),
    port: 8080,
  };
  const plan = buildStepPlan(args);
  const blockers = collectPreSpawnBlockers(plan);

  assert.deepEqual(
    blockers.map((blocker) => blocker.code),
    [
      BINDING_BLOCKERS.SERVED_ORIGIN_UNAVAILABLE,
      BINDING_BLOCKERS.BASELINE_PROMOTION_UNBINDABLE,
    ],
  );
  assert.equal(
    blockers.every((blocker) => blocker.step === "visual-regression"),
    true,
  );
  for (const blocker of blockers) {
    assert.ok(blocker.remediation.length > 0);
  }

  // With no served origin to hand down, the gate does not pretend otherwise:
  // the child is invoked without --served-base.
  assert.equal(plan.at(-1).args.includes("--served-base"), false);

  const refusal = decidePreSpawnBindability(plan);
  assert.equal(refusal.status, "STRUCTURAL");
  assert.equal(refusal.name, REFUSAL_REASONS.CAPTURE_AND_DIFF_UNBINDABLE);
  for (const blocker of blockers) {
    assert.ok(
      refusal.message.includes(blocker.code),
      `refusal must name ${blocker.code}`,
    );
    assert.ok(
      refusal.message.includes(blocker.remediation),
      `refusal must carry the remediation for ${blocker.code}`,
    );
  }
  assert.match(refusal.message, /2 pre-spawn blocker\(s\)/);
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
    'node Tools/visual-regression/capture-and-diff.mjs --served-base http://localhost:8094 --update --confirm-baseline-promotion --update-rationale "WebGPU lighting correction" --reviewed-by wave-end-gate:wave-1',
  );
});

test("the served origin the root hands down is the preflighted one, or none", () => {
  assert.equal(
    resolveServedOrigin(parseArgs(validArgv())),
    "http://localhost:8094",
  );
  // A forbidden or unusable port never becomes a served origin, so a plan built
  // straight from hostile arguments cannot claim bindability behind
  // decideArgumentRefusal's back.
  for (const port of [8080, 8081, 0, 70000, Number.NaN]) {
    assert.equal(
      resolveServedOrigin({ ...parseArgs(validArgv()), port }),
      null,
      `port ${port}`,
    );
  }

  // The origin handed to the child is the same origin the served-build
  // preflight proves disk md5 === served md5 for.
  const args = parseArgs(validArgv());
  const servedSubject = buildServedSubject(args, makePreflightRecords(args));
  const plan = buildStepPlan(args);
  const servedBaseIndex = plan.at(-1).args.indexOf("--served-base");
  assert.notEqual(servedBaseIndex, -1);
  assert.equal(plan.at(-1).args[servedBaseIndex + 1], servedSubject.base);
  assert.equal(
    servedSubject.artifacts[0].origin,
    plan.at(-1).args[servedBaseIndex + 1],
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

test("root binding fails closed when a root-owned binding field does not hold", () => {
  const args = parseArgs(validArgv());
  const source = sourceFromArgs(args);
  const servedSubject = buildServedSubject(args, makePreflightRecords(args));
  const step = buildStepPlan(args)[0];
  const raw = makeRaw();
  const derived = deriveRootBoundTypedResult(step, {
    raw,
    source,
    servedSubject,
  }).typedResult;

  assert.equal(
    normalizeTypedStepResult(derived, {
      step,
      raw,
      source,
      servedSubject,
      rootBound: true,
    }).status,
    "PASS",
  );

  const cases = [
    [
      { ...derived, runId: "some-other-run" },
      REFUSAL_REASONS.CHILD_RECEIPT_STALE,
    ],
    [
      { ...derived, finishedAt: "2026-08-29T10:00:01.001Z" },
      REFUSAL_REASONS.CHILD_RECEIPT_STALE,
    ],
    [
      { ...derived, startedAt: "2026-08-29T09:59:59.999Z" },
      REFUSAL_REASONS.CHILD_RECEIPT_STALE,
    ],
    [
      { ...derived, source: { ...source, commit: "c".repeat(40) } },
      REFUSAL_REASONS.PROVENANCE_MISMATCH,
    ],
    [
      {
        ...derived,
        servedSubject: { ...servedSubject, base: "http://localhost:9000" },
      },
      REFUSAL_REASONS.SERVED_SUBJECT_MISMATCH,
    ],
  ];

  for (const [result, expectedReason] of cases) {
    const normalized = normalizeTypedStepResult(result, {
      step,
      raw,
      source,
      servedSubject,
      rootBound: true,
    });
    assert.equal(normalized.status, "STRUCTURAL");
    assert.equal(normalized.reason, expectedReason);
  }

  // Quiescence is a root observation. A run where the root never saw the direct
  // child close cannot be bound, however the result describes itself.
  const unobserved = makeRaw({
    quiescence: {
      directChildCloseObserved: false,
      descendantProcessTreeProven: false,
      limitation:
        "Direct-child close does not prove descendant process-tree quiescence.",
    },
  });
  const unobservedNormalized = normalizeTypedStepResult(
    deriveRootBoundTypedResult(step, {
      raw: unobserved,
      source,
      servedSubject,
    }).typedResult,
    {
      step,
      raw: unobserved,
      source,
      servedSubject,
      rootBound: true,
    },
  );
  assert.equal(unobservedNormalized.status, "STRUCTURAL");
  assert.equal(
    unobservedNormalized.reason,
    REFUSAL_REASONS.DESCENDANT_QUIESCENCE_UNPROVEN,
  );

  // A silent downgrade is refused: unproven AND unnamed is not acceptable.
  const silent = {
    ...derived,
    quiescence: { descendantProcessTreeProven: false },
  };
  const silentNormalized = normalizeTypedStepResult(silent, {
    step,
    raw,
    source,
    servedSubject,
    rootBound: true,
  });
  assert.equal(silentNormalized.status, "STRUCTURAL");
  assert.equal(
    silentNormalized.reason,
    REFUSAL_REASONS.DESCENDANT_QUIESCENCE_UNPROVEN,
  );

  // A step that DECLARES a fixed report may not certify on its exit code
  // alone: without a current-run digest of that report there is no evidence the
  // child produced anything this run.
  const reportStep = buildStepPlan(args)[1];
  assert.equal(reportStep.resultReportPath.length > 0, true);
  const undigested = deriveRootBoundTypedResult(reportStep, {
    raw,
    source,
    servedSubject,
    reportSnapshot: { exists: false, bytes: null, mtimeMs: null, sha256: null },
  });
  assert.equal(undigested.typedResult, undefined);
  assert.equal(undigested.problem.status, "STRUCTURAL");
  assert.equal(undigested.problem.name, REFUSAL_REASONS.CHILD_CONTRACT_ABSENT);
  assert.match(undigested.problem.message, /no current-run digest/);

  // What the derived result DOES carry is the limitation, named.
  assert.equal(derived.quiescence.descendantProcessTreeProven, false);
  assert.deepEqual(derived.limitations, [
    "Direct-child close does not prove descendant process-tree quiescence.",
  ]);
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
