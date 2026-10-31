// probe-lifecycle-run.mjs — the body `runProbe` hands the probe lifecycle.
//
// @purpose Derives a probe's orderly deadline from its declared work budget and drives preflight, Edge slot, per-run browser and descriptor cells inside one bounded lifecycle.
// @status ACTIVE
//
// WHY THE DEADLINE IS DERIVED AND NOT CONFIGURED. A probe that hangs is the
// failure mode this fork has paid for most often, and a fixed whole-run
// timeout cannot serve both a two-cell smoke probe and a seven-subject
// reproduction: set it short and the honest probe is killed mid-capture, set
// it long and the wedged one holds the single Edge slot for an hour. So the
// probe declares the only quantity it actually knows — how long ITS work needs
// per run (`descriptor.workBudgetMs(options)`) — and the deadline is composed
// from that plus the parts the runtime owns: one preflight, and per run one
// Edge launch plus a settlement margin. Raising a response cap therefore
// raises the deadline that pays for it, which is exactly the coupling the
// pre-derivation form lost when a global cap bump silently disarmed it.
//
// WHAT THIS MODULE IS *NOT*. It is not a second composition root. It writes no
// file, decides no exit code and holds no policy about receipts; `runProbe`
// still owns all of that. This module exists so the lifecycle branch does not
// have to live inside an already-long runtime, and so the two shapes — the
// pre-adoption path and the lifecycle path — can be read side by side.
//
// WHAT A SLOW BROWSER CLOSE IS ALLOWED TO COST. A run whose cells all
// returned and whose verdicts were computed has measured everything it was
// going to measure; a browser that then takes longer than the close deadline
// to go away (Edge on a machine at 74-100 % load) is a teardown problem, not a
// measurement failure. Such a run is published like any other, its receipt
// records each run's close (`browserCloses`), and the process exits with the
// verdicts' code rather than 2. The same teardown stuck past the hard stop
// banks the receipt from inside the hard stop (`onHardStop`) before the
// process dies, so the hard stop cannot fire ahead of the receipt. A close that
// expires while work is INCOMPLETE stays an error, exactly as before.
//
// Adopted (C13-42a) from the unlanded runtime rewrite that produced the
// 2026-09-09 C13-42 runs.

import { EDGE_SLOT_CLOSE_TIMEOUT_MS } from "./probe-edge-slot.mjs";
import { withProbeLifecycle } from "./probe-lifecycle.mjs";
import {
  closeBrowserAfter,
  makeAttempt,
  makeDescriptorScope,
  makeWorkRegistry,
  registerObservedRun,
} from "./probe-work-registry.mjs";

/** How long the served-build preflight may take before the run is wedged. */
export const PREFLIGHT_BUDGET_MS = 60_000;

/** How long one Edge launch may take. */
export const LAUNCH_BUDGET_MS = 120_000;

/** The close deadline before the 2026-10-31 measurement; the receipt reports against it. */
export const LEGACY_CLOSE_DEADLINE_MS = 10_000;

/**
 * How long a single tracked resource may take to close, unless the descriptor
 * sets `closeDeadlineMs`.
 *
 * WHY 90 s. On the 2026-10-31 Edge legs at 74-100 % machine load,
 * `probe-landing-cells.mjs` exited 2 at teardown in 6 of 14 runs after every
 * capture was written: the 10 s deadline expired and the hard stop fired about
 * 30 s after the last capture, so the browser was still open at roughly 27 s.
 * An executor copy with only this constant at 60 s ran the same cells clean,
 * but failed once under foreign load even at 60 s. 90 s is 3x the longest
 * close observed to be still pending and 1.5x the value that failed once; a
 * run with complete work no longer fails on a close that outlasts it (see the
 * header), so the number only decides how long a genuinely wedged browser holds
 * the Edge slot before the incident is written.
 */
export const RESOURCE_CLOSE_DEADLINE_MS = 90_000;

/**
 * Slack per run for everything between the probe's own work finishing and the
 * run being accounted for: browser close, registry drain, verdict assembly.
 * One millisecond over the close deadline, so the orderly deadline can never
 * fire before a bounded close has had its whole budget.
 */
export const RUN_SETTLEMENT_MARGIN_MS = RESOURCE_CLOSE_DEADLINE_MS + 1;

/**
 * What the hard stop adds above the close deadline: the Edge-slot release
 * budget plus a second.
 */
export const HARD_STOP_MARGIN_MS = EDGE_SLOT_CLOSE_TIMEOUT_MS + 1_000 + 1;

/**
 * The one non-resetting grace after draining begins. It must exceed the
 * per-resource close budget plus the slot release budget, or the hard stop
 * would fire while a bounded close was still legitimately running.
 */
export const HARD_STOP_GRACE_MS =
  RESOURCE_CLOSE_DEADLINE_MS + HARD_STOP_MARGIN_MS;

/** `setTimeout` silently fires immediately past this delay. */
export const MAX_TIMER_DELAY_MS = 2_147_000_000;

/**
 * The close deadline and the hard-stop grace above it for a descriptor.
 * `descriptor.closeDeadlineMs` overrides the default; the grace keeps the
 * fleet's own margin above whatever the deadline becomes, the same way the
 * capture seam derives its grace.
 *
 * @param {object} descriptor The probe descriptor.
 * @returns {{closeDeadlineMs: number, hardStopGraceMs: number}} The budgets.
 */
export function resolveCloseDeadlines(descriptor) {
  const closeDeadlineMs =
    descriptor.closeDeadlineMs ?? RESOURCE_CLOSE_DEADLINE_MS;
  if (
    !Number.isSafeInteger(closeDeadlineMs) ||
    closeDeadlineMs < 1 ||
    closeDeadlineMs > MAX_TIMER_DELAY_MS - HARD_STOP_MARGIN_MS
  ) {
    throw new TypeError(
      `${descriptor.name}: descriptor.closeDeadlineMs must be a positive safe integer of at most ${MAX_TIMER_DELAY_MS - HARD_STOP_MARGIN_MS} ms`,
    );
  }
  return {
    closeDeadlineMs,
    hardStopGraceMs: closeDeadlineMs + HARD_STOP_MARGIN_MS,
  };
}

/**
 * Compose the whole-run orderly deadline from the probe's declared per-run
 * work budget.
 *
 * @param {object} options Parsed probe options.
 * @param {object} descriptor The probe descriptor.
 * @returns {number} The deadline in milliseconds.
 */
export function deriveLifecycleDeadline(options, descriptor) {
  if (!Number.isSafeInteger(options.runs) || options.runs < 1) {
    throw new TypeError("--runs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new TypeError("--timeout-ms must be a positive safe integer");
  }
  if (typeof descriptor.workBudgetMs !== "function") {
    throw new TypeError(
      "descriptor.workBudgetMs must be a function returning the per-run work budget",
    );
  }

  const work = descriptor.workBudgetMs(options);
  if (!Number.isSafeInteger(work) || work < 1) {
    throw new TypeError(
      "descriptor.workBudgetMs must return a positive safe integer",
    );
  }
  // A close deadline longer than the default settlement slack raises the slack
  // with it, so the orderly deadline never fires inside a bounded close.
  const settlement = Math.max(
    RUN_SETTLEMENT_MARGIN_MS,
    resolveCloseDeadlines(descriptor).closeDeadlineMs + 1,
  );

  // BigInt so a probe with an implausible budget produces a refusable range
  // error rather than a silently-saturated timer.
  const required =
    BigInt(PREFLIGHT_BUDGET_MS) +
    BigInt(options.runs) *
      (BigInt(LAUNCH_BUDGET_MS) + BigInt(work) + BigInt(settlement));
  if (required > BigInt(MAX_TIMER_DELAY_MS)) {
    throw new RangeError(
      "probe lifecycle deadline exceeds the supported timer delay",
    );
  }
  return Number(required);
}

const failureKind = (raw) => {
  try {
    return raw?.details?.kind;
  } catch {
    return undefined;
  }
};

/**
 * Note on each browser-close record which closes the lifecycle reported as
 * past their deadline. Idempotent.
 *
 * @param {{closes?: Array<object>}} state The run state.
 * @param {unknown[]} raws The lifecycle's raw failures.
 * @returns {void}
 */
export function recordCloseExpiries(state, raws) {
  for (const raw of raws) {
    if (failureKind(raw) !== "close-deadline") {
      continue;
    }
    for (const record of state.closes ?? []) {
      if (record.label === raw.details.resource) {
        record.expired = true;
      }
    }
  }
}

/**
 * Whether the failures are nothing but a browser that lingered after the run's
 * work was complete: every cell of every run returned, the verdicts were
 * computed, every expired close had already drained the descriptor's work, and
 * the only failures are close deadlines (plus an orderly deadline, which after
 * complete work can only have measured the same slow teardown).
 *
 * @param {unknown[]} raws The lifecycle's raw failures.
 * @param {{complete?: boolean, closes?: Array<object>}} state The run state.
 * @returns {boolean} True when the receipt may be published.
 */
export function onlyLingeringClose(raws, state) {
  if (state.complete !== true || raws.length === 0) {
    return false;
  }
  if (!raws.some((raw) => failureKind(raw) === "close-deadline")) {
    return false;
  }
  if (
    !raws.every((raw) =>
      ["close-deadline", "orderly-deadline"].includes(failureKind(raw)),
    )
  ) {
    return false;
  }
  return (state.closes ?? []).every(
    (record) => record.expired !== true || record.drained === true,
  );
}

/**
 * Read a lifecycle rejection: record which closes expired and say whether it
 * is a lingering browser after complete work (published, not an error).
 *
 * @param {unknown} error What the lifecycle rejected with.
 * @param {{complete?: boolean, closes?: Array<object>}} state The run state.
 * @returns {boolean} True when the rejection is only a lingering close.
 */
export function assessLifecycleFailure(error, state) {
  const occurrences = Array.isArray(error?.failureOccurrences)
    ? error.failureOccurrences
    : [];
  const raws = occurrences.map((occurrence) => occurrence.raw);
  recordCloseExpiries(state, raws);
  if (occurrences.length === 0) {
    return false;
  }
  const primary = error.primaryCause;
  return (
    onlyLingeringClose(raws, state) &&
    (primary === undefined || failureKind(primary) === "close-deadline")
  );
}

/**
 * The per-run browser-close records for the runtime receipt. A close that
 * never settled has `closeMs: null` and is measured to `now`.
 *
 * @param {{closes?: Array<object>}} state The run state.
 * @param {() => number} now Clock.
 * @returns {Array<object>} One entry per browser run that began closing.
 */
export function describeBrowserCloses(state, now) {
  return (state.closes ?? []).map((record) => {
    const elapsedMs =
      record.closeMs === null ? now() - record.startedAt : record.closeMs;
    return {
      run: record.run,
      deadlineMs: record.deadlineMs,
      legacyDeadlineMs: LEGACY_CLOSE_DEADLINE_MS,
      settled: record.closeMs !== null,
      closeMs: record.closeMs,
      browserCloseMs: record.browserCloseMs,
      elapsedMs,
      exceededLegacy: elapsedMs > LEGACY_CLOSE_DEADLINE_MS,
      expired: record.expired === true || elapsedMs >= record.deadlineMs,
    };
  });
}

/**
 * Run a descriptor's preflight, Edge slot, browsers and cells inside one
 * bounded lifecycle.
 *
 * The `state` object is mutated rather than returned because the caller needs
 * what was learned even when this rejects: a run that took the slot and then
 * failed must still publish the slot in its incident record.
 *
 * @param {object} inputs Inputs.
 * @param {object} inputs.descriptor The probe descriptor.
 * @param {object} inputs.options Parsed probe options.
 * @param {string} inputs.origin Resolved origin.
 * @param {string} inputs.outputDirectory Where artifacts go.
 * @param {string} inputs.repositoryRoot Repository root.
 * @param {Array<object>} inputs.captures Capture sink.
 * @param {Array<object>} inputs.cells Cell sink.
 * @param {string[]} inputs.launchArgs Edge flags for every launch.
 * @param {string} inputs.edgeSlotLockPath Absolute path to the Edge-slot lock.
 * @param {() => Promise<void>} inputs.preflight Runs the served-build preflight and its refusal decision.
 * @param {Function} inputs.launch Edge launcher.
 * @param {object} [inputs.chromium] Playwright chromium namespace.
 * @param {Function} [inputs.lifecycle] Lifecycle implementation (test seam).
 * @param {object} [inputs.lifecycleDependencies] Lifecycle dependencies (test seam).
 * @param {() => number} [inputs.now] Clock for the browser-close records.
 * @param {() => number} [inputs.finalizeOnHardStop] Publishes the run and returns its exit code; called from the hard stop when only a lingering browser kept a complete run from finishing.
 * @param {{slot: object|null, verdicts: Array<object>, complete?: boolean, closes?: Array<object>}} inputs.state Mutated with what the run learned: the slot, the verdicts, whether every run's cells and verdicts completed, and one record per browser close.
 * @returns {Promise<void>} Resolves when the lifecycle is quiescent.
 */
export async function runDescriptorUnderLifecycle({
  descriptor,
  options,
  origin,
  outputDirectory,
  repositoryRoot,
  captures,
  cells,
  launchArgs,
  edgeSlotLockPath,
  preflight,
  launch,
  chromium,
  lifecycle = withProbeLifecycle,
  lifecycleDependencies,
  now = Date.now,
  finalizeOnHardStop,
  state,
}) {
  const { closeDeadlineMs, hardStopGraceMs } =
    resolveCloseDeadlines(descriptor);
  state.closes ??= [];
  state.complete ??= false;
  const lifecycleOptions = {
    probe: descriptor.name,
    deadlineMs: deriveLifecycleDeadline(options, descriptor),
    closeDeadlineMs,
    hardStopGraceMs,
    edgeSlotLockPath,
    ...(finalizeOnHardStop === undefined
      ? {}
      : {
          onHardStop: (raws) => {
            recordCloseExpiries(state, raws);
            return onlyLingeringClose(raws, state)
              ? finalizeOnHardStop()
              : undefined;
          },
        }),
  };

  let completedRuns = 0;

  const runAttempt = async ({
    browser,
    descriptorScope,
    workRegistry,
    run,
  }) => {
    let produced;
    try {
      produced = await descriptor.cells({
        browser,
        run,
        options,
        origin,
        outputDirectory,
        repositoryRoot,
        captures,
        scope: descriptorScope,
      });
    } finally {
      // Sealed whether cells returned or threw: work registered after this
      // point is not in the set the close drains. Note that the close does not
      // WAIT for that set either — it races it; see `probe-work-registry.mjs`.
      workRegistry.seal();
    }
    // A descriptor that returns its single cell as a bare object used to reach
    // the spread below and die as "Spread syntax requires ...iterable"; the
    // contract is checked here so the violation names itself.
    if (
      produced !== null &&
      produced !== undefined &&
      !Array.isArray(produced)
    ) {
      throw new TypeError(
        `${descriptor.name}: descriptor.cells must return an array of cells, got ${Object.prototype.toString.call(produced)}; wrap a single cell as [cell]`,
      );
    }
    cells.push(...(produced ?? []));
    completedRuns++;
    if (completedRuns === options.runs) {
      state.verdicts = descriptor.verdicts
        ? (descriptor.verdicts(cells, {
            options,
            origin,
            outputDirectory,
          }) ?? [])
        : [];
      state.complete = true;
    }
    return produced;
  };

  const lifecycleBody = async (lifecycleScope) => {
    await lifecycleScope.run("served-build preflight", async () => {
      await preflight();
    });

    await lifecycleScope.withEdgeSlot(async (slotScope, heldSlot) => {
      state.slot = heldSlot;
      for (let run = 0; run < options.runs; run++) {
        const workRegistry = makeWorkRegistry();
        const descriptorScope = makeDescriptorScope(slotScope, workRegistry);
        const attempt = makeAttempt(run);
        let runFailureOccurred = false;
        let runFailure;

        try {
          heldSlot.assertHeld();
          // One browser PER RUN. A repeat that reuses the previous browser
          // inherits its warm shader cache, which is the confound every
          // cold-start and first-frame measurement in this fork avoids.
          await slotScope.withResource(
            {
              kind: "browser",
              label: `${descriptor.name} browser run ${run}`,
              acquire: () =>
                launch({ headed: options.headed, launchArgs, chromium }),
              close: async (browser) => {
                attempt.finishNotStarted("resource use was not started");
                const record = {
                  run,
                  label: `${descriptor.name} browser run ${run}`,
                  deadlineMs: closeDeadlineMs,
                  startedAt: now(),
                  closeMs: null,
                  browserCloseMs: null,
                  drained: false,
                  expired: false,
                };
                state.closes.push(record);
                const drained = Promise.resolve(
                  workRegistry.settleAndSeal(),
                ).then((outcomes) => {
                  record.drained = true;
                  return outcomes;
                });
                try {
                  return await closeBrowserAfter(attempt.rawOutcome, drained, {
                    close: async () => {
                      try {
                        return await browser.close();
                      } finally {
                        record.browserCloseMs = now() - record.startedAt;
                      }
                    },
                  });
                } finally {
                  record.closeMs = now() - record.startedAt;
                }
              },
              isClosed: (browser) => !browser.isConnected(),
            },
            (browser) => {
              if (!attempt.schedule()) {
                return undefined;
              }
              return registerObservedRun({
                slotScope,
                owner: attempt,
                label: `${descriptor.name} attempt ${run}`,
                start: () =>
                  runAttempt({ browser, descriptorScope, workRegistry, run }),
                propagatedFailure: () => workRegistry.takePropagatedFailure(),
              }).wrapper;
            },
          );
        } catch (error) {
          runFailureOccurred = true;
          runFailure = error;
        } finally {
          attempt.finishNotStarted(
            "browser acquisition did not admit resource use",
          );
        }

        try {
          heldSlot.assertHeld();
        } catch (error) {
          runFailure = runFailureOccurred
            ? new AggregateError(
                [runFailure, error],
                "the Edge run lost slot ownership",
              )
            : error;
          runFailureOccurred = true;
        }
        if (runFailureOccurred) {
          throw runFailure;
        }
      }
    });
  };

  if (lifecycleDependencies === undefined) {
    await lifecycle(lifecycleOptions, lifecycleBody);
    return;
  }
  await lifecycle(lifecycleOptions, lifecycleBody, lifecycleDependencies);
}
