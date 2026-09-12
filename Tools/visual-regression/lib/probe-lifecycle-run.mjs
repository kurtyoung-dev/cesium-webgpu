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

/**
 * Slack per run for everything between the probe's own work finishing and the
 * run being accounted for: browser close, registry drain, verdict assembly.
 * One millisecond over a round minute so a deadline is never mistakable for a
 * hand-rounded number.
 */
export const RUN_SETTLEMENT_MARGIN_MS = 60_001;

/** How long a single tracked resource may take to close. */
export const RESOURCE_CLOSE_DEADLINE_MS = 10_000;

/**
 * The one non-resetting grace after draining begins. It must exceed the
 * per-resource close budget plus the slot release budget, or the hard stop
 * would fire while a bounded close was still legitimately running.
 */
export const HARD_STOP_GRACE_MS =
  RESOURCE_CLOSE_DEADLINE_MS + EDGE_SLOT_CLOSE_TIMEOUT_MS + 1_000 + 1;

/** `setTimeout` silently fires immediately past this delay. */
export const MAX_TIMER_DELAY_MS = 2_147_000_000;

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

  // BigInt so a probe with an implausible budget produces a refusable range
  // error rather than a silently-saturated timer.
  const required =
    BigInt(PREFLIGHT_BUDGET_MS) +
    BigInt(options.runs) *
      (BigInt(LAUNCH_BUDGET_MS) +
        BigInt(work) +
        BigInt(RUN_SETTLEMENT_MARGIN_MS));
  if (required > BigInt(MAX_TIMER_DELAY_MS)) {
    throw new RangeError(
      "probe lifecycle deadline exceeds the supported timer delay",
    );
  }
  return Number(required);
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
 * @param {{slot: object|null, verdicts: Array<object>}} inputs.state Mutated with what the run learned.
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
  state,
}) {
  const lifecycleOptions = {
    probe: descriptor.name,
    deadlineMs: deriveLifecycleDeadline(options, descriptor),
    closeDeadlineMs: RESOURCE_CLOSE_DEADLINE_MS,
    hardStopGraceMs: HARD_STOP_GRACE_MS,
    edgeSlotLockPath,
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
                return closeBrowserAfter(
                  attempt.rawOutcome,
                  workRegistry.settleAndSeal(),
                  browser,
                );
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
