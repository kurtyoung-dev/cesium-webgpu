// @purpose Verifies wave-end binding and receipt contracts independently of process execution.
// @status ACTIVE

import test from "node:test";
import {
  BINDING_BLOCKERS,
  CHILD_WATCHDOG_MS,
  ERROR_REASONS,
  EXIT_CODES,
  REFUSAL_REASONS,
  ROOT_BINDING,
  STEP_RESULT_SCHEMA_VERSION,
  buildStepPlan,
  collectPreSpawnBlockers,
  decideArgumentRefusal,
  decidePreSpawnBindability,
  decidePreflightRefusal,
  normalizePreflightRecord,
  parseArgs,
  resolveServedOrigin,
  statStepPlanPaths,
  validateStepPlan,
} from "./wave-end-gate-binding.mjs";
import assert from "node:assert/strict";
import {
  buildReceipt,
  buildServedSubject,
  classifyRawChildProblem,
  deriveRootBoundTypedResult,
  foldStatuses,
  normalizeTypedStepResult,
  resolveCurrentStepResult,
  sourceFromArgs,
} from "./wave-end-gate-receipt.mjs";
import { createHash } from "node:crypto";

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
