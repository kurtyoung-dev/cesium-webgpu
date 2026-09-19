// @purpose The one fixed `buildReceipt` input shared by the golden-comparison
// and contact-sheet cases in Tools/wave-end-contact-sheet-index.spec.mjs, so
// the golden bytes and the spec's own calls are provably the same input.
// @status ACTIVE

/**
 * A minimal but shape-complete `buildReceipt` input. Every field a
 * `buildReceipt` reads (Tools/wave-end-gate-receipt.mjs) is present; every
 * field `buildMarkdownSummary` walks (bindability, raw, normalized) is
 * present too, so neither function can throw on this input. Returns a fresh
 * object each call — the spec sometimes overlays a `contactSheets` field, and
 * a shared mutable object would leak that between cases.
 *
 * @returns {object} The `buildReceipt` argument.
 */
export function buildFixtureReceiptInput() {
  const bindability = Object.freeze({
    bindable: true,
    phase: "post-spawn",
    boundBy: "child",
    reason: "fixture step always binds",
    limitations: [],
  });

  const planStep = {
    name: "fixture-step",
    file: "fixture-step.mjs",
    args: ["--fixture"],
    env: {},
    command: "node fixture-step.mjs --fixture",
    resultReportPath: null,
    bindability,
    binding: null,
  };

  const stepRaw = {
    runId: "fixture-run-1",
    spawned: true,
    startedAt: "2026-09-19T00:00:00.000Z",
    finishedAt: "2026-09-19T00:00:01.000Z",
    startedEpochMs: 1758240000000,
    finishedEpochMs: 1758240001000,
    wallMs: 1000,
    exitCode: 0,
    signal: null,
    error: null,
    timedOut: false,
    watchdogMs: 600000,
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
  };

  const stepNormalized = {
    status: "PASS",
    exitCode: 0,
    reason: null,
    message: null,
    typedResult: null,
  };

  return {
    wave: "kit-wave-b-fixture",
    startedAt: "2026-09-19T00:00:00.000Z",
    finishedAt: "2026-09-19T00:00:02.000Z",
    source: Object.freeze({
      commit: "f".repeat(40),
      dirty: false,
      identity: "e".repeat(64),
    }),
    servedSubject: {
      base: "http://localhost:8094",
      sandcastleBase: "http://localhost:8095",
      artifacts: [
        {
          path: "Build/CesiumUnminified/Cesium.js",
          origin: "http://localhost:8094",
          byteLength: 42,
          md5: "1".repeat(32),
        },
      ],
    },
    preflight: [],
    plan: [planStep],
    steps: [
      {
        name: planStep.name,
        command: planStep.command,
        bindability,
        raw: stepRaw,
        normalized: stepNormalized,
      },
    ],
    updateBaselines: false,
    reason: null,
    problem: null,
    verdict: "PASS",
  };
}
