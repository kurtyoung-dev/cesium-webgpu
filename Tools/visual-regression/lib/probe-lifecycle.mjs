// probe-lifecycle.mjs — bounded shutdown ownership for browser probe work.
// @purpose Coordinates a probe deadline, tracked browser resources, and the Edge lease so a probe cannot report completion while owned work remains live.
// @status ACTIVE
//
// WHERE THIS CAME FROM, AND WHAT IS OPT-IN ABOUT IT. This module is adopted
// (C13-42a) from the unlanded probe-runtime rewrite that produced the six
// 2026-09-09 C13-42 runs; their own stack traces name this file. It is reached
// ONLY from `runProbe` when a descriptor declares `workBudgetMs`. A probe that
// declares no budget never enters a lifecycle at all and keeps the runtime's
// pre-adoption behaviour exactly — see `probe-runtime.mjs` §6 for why the
// adoption is staged that way and `probe-lifecycle-run.mjs` for the body the
// runtime hands this module.
//
// THE SLOT IS THIS FORK'S LOCK FILE, NOT A LISTENER. The version this was
// adopted from coordinated the Edge slot through a loopback listener. This
// fork keeps the exclusive-create lock file every other Edge job on the
// machine already takes, and `probe-edge-slot.mjs`'s `withEdgeSlot` supplies
// the same lease observations over it. The lock path travels as
// `options.edgeSlotLockPath`, because a path-addressed slot needs to be told
// which path a port-addressed one did not.

import { withEdgeSlot as acquireEdgeSlot } from "./probe-edge-slot.mjs";
import { PROBE_EXIT_CODES, ProbeRefusal } from "./probe-refusal.mjs";

const RESOURCE_ORDER = Object.freeze({
  session: 0,
  page: 1,
  context: 2,
  browser: 3,
});
const TRANSITION_OBSERVED = Symbol("probe-lifecycle-transition-observed");
const HARD_EXIT_PENDING = new Promise(() => {});

export class ProbeLifecycleError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ProbeLifecycleError";
    this.details = details;
    this.completedValue = details.completedValue;
    this.primaryCause = details.primaryCause;
    this.causes = details.causes ?? [];
    this.failureOccurrences = details.failureOccurrences ?? Object.freeze([]);
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function failure(label, raw) {
  return Object.freeze({ occurred: true, label, raw });
}

function fulfilled(value) {
  return Object.freeze({ status: "fulfilled", value });
}

function rejected(label, raw) {
  return Object.freeze({ status: "rejected", failure: failure(label, raw) });
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function resourceKind(kind) {
  if (!Object.hasOwn(RESOURCE_ORDER, kind)) {
    throw new TypeError(`unknown probe resource kind ${String(kind)}`);
  }
  return kind;
}

function aggregate(message, failures, details = {}) {
  const occurred = failures.filter((entry) => entry?.occurred);
  const raw = occurred.map((entry) => entry.raw);
  const seen = new Set();
  const failureOccurrences = [];
  for (const entry of occurred) {
    if (seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    failureOccurrences.push(
      Object.freeze({
        occurred: true,
        occurrence: failureOccurrences.length + 1,
        label: entry.label,
        raw: entry.raw,
      }),
    );
  }
  return new ProbeLifecycleError(message, {
    ...details,
    causes: raw,
    failureOccurrences: Object.freeze(failureOccurrences),
  });
}

function normaliseDependencies(dependencies) {
  const source = dependencies ?? {};
  return {
    AbortController: source.AbortController ?? AbortController,
    clearTimeout: source.clearTimeout ?? clearTimeout,
    edgeSlot: source.edgeSlot ?? acquireEdgeSlot,
    exit: source.exit ?? process.exit,
    setTimeout: source.setTimeout ?? setTimeout,
    writeDiagnostic:
      source.writeDiagnostic ?? ((text) => process.stderr.write(text)),
  };
}

function isEdgeSlotBusyRefusal(raw) {
  try {
    return raw instanceof ProbeRefusal && raw.reason === "edge-slot-busy";
  } catch {
    return false;
  }
}

/**
 * Runs a browser probe under one bounded lifecycle.
 *
 * Production callers pass exactly `options` and `body`. The third argument is
 * a hermetic test seam; it is not an option and is intentionally absent from
 * the production callback surface.
 *
 * @param {object} options Lifecycle budgets and ownership label.
 * @param {string} options.probe Probe/lease owner label.
 * @param {number} options.deadlineMs Whole-run orderly deadline.
 * @param {number} options.hardStopGraceMs One non-resetting grace after drain begins.
 * @param {number} options.closeDeadlineMs Per-resource close budget.
 * @param {string} [options.edgeSlotLockPath] Absolute path to this fork's Edge-slot lock file; required before `scope.withEdgeSlot` may be used.
 * @param {(scope: Readonly<object>) => Promise<unknown>|unknown} body Probe work.
 * @param {object} [testDependencies] Hermetic timer, exit, slot, and abort seams.
 * @returns {Promise<unknown>} The body value after owned work is quiescent.
 */
export async function withProbeLifecycle(options, body, testDependencies) {
  if (!options || typeof options !== "object") {
    throw new TypeError("probe lifecycle options are required");
  }
  if (typeof options.probe !== "string" || options.probe.length === 0) {
    throw new TypeError("probe lifecycle probe must be a non-empty string");
  }
  if (typeof body !== "function") {
    throw new TypeError("probe lifecycle body must be a function");
  }
  const deadlineMs = positiveInteger(options.deadlineMs, "deadlineMs");
  const hardStopGraceMs = positiveInteger(
    options.hardStopGraceMs,
    "hardStopGraceMs",
  );
  const closeDeadlineMs = positiveInteger(
    options.closeDeadlineMs,
    "closeDeadlineMs",
  );
  if (hardStopGraceMs <= closeDeadlineMs) {
    throw new RangeError(
      "hardStopGraceMs must exceed closeDeadlineMs so a bounded close can settle before hard exit",
    );
  }

  const dependencies = normaliseDependencies(testDependencies);
  const controller = new dependencies.AbortController();
  const drainingGate = deferred();
  const stopGate = deferred();
  const tracked = new Set();
  const phaseATracked = new Set();
  const resources = [];
  const failures = [];
  let accepting = true;
  let phase = "ACTIVE";
  let abortRequested = false;
  let cleanupBarrier;
  let orderlyTimer;
  let hardTimer;
  let orderlySettled = false;
  let hardArmed = false;
  let hardExited = false;
  let closeSequence = 0;
  let deadlineRecorded = false;

  const retain = (promise, label, includeInPhaseA = true) => {
    const observed = Promise.resolve(promise).then(
      (value) => fulfilled(value),
      (raw) => rejected(label, raw),
    );
    tracked.add(observed);
    if (includeInPhaseA) {
      phaseATracked.add(observed);
    }
    return observed;
  };

  const retainFailure = (entry) => {
    if (entry?.occurred) {
      failures.push(entry);
    }
    return entry;
  };

  const settleStop = (kind) => {
    if (orderlySettled) {
      return;
    }
    orderlySettled = true;
    dependencies.clearTimeout(orderlyTimer);
    stopGate.resolve(Object.freeze({ kind }));
  };

  const hardExit = () => {
    if (hardExited) {
      return;
    }
    hardExited = true;
    phase = "HARD_EXIT";
    try {
      dependencies.writeDiagnostic(
        `${options.probe}: lifecycle did not reach quiescence before hard-stop grace\n`,
      );
    } catch (raw) {
      retainFailure(failure("hard-stop diagnostic", raw));
    } finally {
      dependencies.exit(PROBE_EXIT_CODES.ERROR);
    }
  };

  const armHardGrace = () => {
    if (hardArmed || hardExited || phase === "QUIESCENT") {
      return;
    }
    hardArmed = true;
    hardTimer = dependencies.setTimeout(hardExit, hardStopGraceMs);
  };

  const requestAbort = () => {
    if (abortRequested) {
      return;
    }
    abortRequested = true;
    try {
      controller.abort();
    } catch (raw) {
      retainFailure(failure("abort controller", raw));
    }
  };

  const checkpoint = () => {
    if (accepting && phase === "ACTIVE") {
      return;
    }
    throw new ProbeLifecycleError("probe lifecycle is draining");
  };

  const runAborters = new Set();
  const requestOperationAborts = () => {
    for (const registration of runAborters) {
      const outcome = retain(
        Promise.resolve().then(() => registration.abort(controller.signal)),
        "operation abort request",
      );
      retain(
        outcome.then((result) => {
          if (result.status === "rejected") {
            retainFailure(result.failure);
          }
          return TRANSITION_OBSERVED;
        }),
        "operation abort transition",
      );
    }
  };

  const resourceClosedByParent = (parent) => {
    for (const resource of resources) {
      if (
        (resource.parent === parent || resource.parent === parent.handle) &&
        !resource.closed
      ) {
        resource.closed = true;
        resource.closedByParent = true;
        resourceClosedByParent(resource);
      }
    }
  };

  let enterDraining;

  const startClose = (resource) => {
    if (resource.closeRace) {
      return resource.closeRace;
    }
    resource.closeStarted = true;
    const observeResource = (promise, label) => {
      const outcome = retain(promise, label);
      resource.tracked?.add(outcome);
      return outcome;
    };
    const closer = observeResource(
      Promise.resolve().then(() => resource.close(resource.handle)),
      `${resource.label} close`,
    );
    resource.closeOutcome = observeResource(
      closer.then(async (closeResult) => {
        let closed;
        try {
          closed = await Promise.resolve().then(() =>
            resource.isClosed(resource.handle),
          );
        } catch (raw) {
          if (closeResult.status === "rejected") {
            throw aggregate(`${resource.label} close and observation failed`, [
              closeResult.failure,
              failure(`${resource.label} close observation`, raw),
            ]);
          }
          throw raw;
        }
        if (closed === true) {
          resource.closed = true;
          resourceClosedByParent(resource);
        }
        if (closeResult.status === "rejected") {
          throw closeResult.failure.raw;
        }
        if (!resource.closed) {
          const stateFailure = failure(
            `${resource.label} close observation`,
            new ProbeLifecycleError(`${resource.label} did not report closed`),
          );
          throw stateFailure.raw;
        }
        return undefined;
      }),
      `${resource.label} close observation`,
    );
    const closeDeadline = deferred();
    const closeTimer = dependencies.setTimeout(() => {
      closeDeadline.resolve(Object.freeze({ kind: "close-deadline" }));
    }, closeDeadlineMs);
    const settledClose = resource.closeOutcome.then((outcome) => {
      dependencies.clearTimeout(closeTimer);
      return Object.freeze({ kind: "close-settled", outcome });
    });
    resource.closeRace = observeResource(
      Promise.race([settledClose, closeDeadline.promise]),
      `${resource.label} close deadline race`,
    );
    observeResource(
      resource.closeRace.then((outcome) => {
        if (
          outcome.status === "fulfilled" &&
          outcome.value.kind === "close-deadline"
        ) {
          const timeout = failure(
            `${resource.label} close deadline`,
            new ProbeLifecycleError(
              `${resource.label} did not close before its deadline`,
            ),
          );
          enterDraining("resource-close-deadline", timeout);
        }
        if (
          outcome.status === "fulfilled" &&
          outcome.value.kind === "close-settled" &&
          outcome.value.outcome.status === "rejected"
        ) {
          enterDraining(
            "resource-close-failure",
            outcome.value.outcome.failure,
          );
        }
        return TRANSITION_OBSERVED;
      }),
      `${resource.label} close transition`,
    );
    return resource.closeRace;
  };

  const startFixedPointCleanup = async () => {
    let inspected = 0;
    while (!hardExited) {
      const pending = resources
        .filter((resource) => !resource.closeStarted)
        .sort(
          (left, right) =>
            RESOURCE_ORDER[left.kind] - RESOURCE_ORDER[right.kind] ||
            right.sequence - left.sequence,
        );
      if (pending.length === 0) {
        if (inspected === resources.length) {
          return;
        }
        inspected = resources.length;
        await Promise.resolve();
        continue;
      }
      for (const resource of pending) {
        const closeRace = startClose(resource);
        const outcome = await closeRace;
        if (outcome.status === "rejected") {
          retainFailure(outcome.failure);
          enterDraining("resource-close-failure", outcome.failure);
        }
      }
      inspected = 0;
    }
  };

  async function waitForOwnedFixedPoint(owned) {
    let observedSize = -1;
    while (!hardExited) {
      const snapshot = [...owned];
      await Promise.all(snapshot);
      await Promise.resolve();
      if (snapshot.length === owned.size && observedSize === owned.size) {
        return;
      }
      observedSize = owned.size;
    }
  }

  enterDraining = (reason, occurrence) => {
    try {
      if (
        occurrence?.status === "rejected" &&
        reason !== "body-rejected" &&
        reason !== "initial-wake"
      ) {
        retainFailure(occurrence.failure);
      } else if (occurrence?.occurred) {
        retainFailure(occurrence);
      }
      if (reason === "orderly-deadline" && !deadlineRecorded) {
        deadlineRecorded = true;
        retainFailure(
          failure(
            "orderly deadline",
            new ProbeLifecycleError(
              `${options.probe} exceeded its orderly deadline`,
            ),
          ),
        );
      }
      if (phase !== "ACTIVE") {
        for (const resource of resources) {
          if (!resource.closeStarted) {
            startClose(resource);
          }
        }
        return;
      }
      phase = "DRAINING";
      accepting = false;
      drainingGate.resolve();
      requestAbort();
      requestOperationAborts();
      cleanupBarrier = retain(startFixedPointCleanup(), "fixed-point cleanup");
      retain(
        cleanupBarrier.then((outcome) => {
          if (outcome.status === "rejected") {
            retainFailure(outcome.failure);
          }
          return TRANSITION_OBSERVED;
        }),
        "cleanup transition",
      );
      armHardGrace();
    } catch (raw) {
      retainFailure(failure("enter draining", raw));
      accepting = false;
      if (phase === "ACTIVE") {
        phase = "DRAINING";
        drainingGate.resolve();
      }
      armHardGrace();
    }
  };

  const makeScope = (slotChild, owned = null) => {
    const scope = {
      signal: controller.signal,
      checkpoint,
      async run(label, start, operationOptions = {}) {
        checkpoint();
        if (typeof start !== "function") {
          throw new TypeError(`${label} start must be a function`);
        }
        const abort = operationOptions.abort;
        if (abort !== undefined && typeof abort !== "function") {
          throw new TypeError(`${label} abort must be a function`);
        }
        const abortRegistration =
          abort === undefined ? undefined : Object.freeze({ abort });
        if (abortRegistration !== undefined) {
          runAborters.add(abortRegistration);
        }
        const outcome = retain(
          Promise.resolve().then(() => start(controller.signal)),
          `${label} operation`,
        );
        owned?.add(outcome);
        const result = await outcome;
        if (abortRegistration !== undefined) {
          runAborters.delete(abortRegistration);
        }
        if (result.status === "rejected") {
          throw result.failure.raw;
        }
        if (hardExited) {
          return HARD_EXIT_PENDING;
        }
        checkpoint();
        return result.value;
      },
      async withResource(descriptor, use) {
        if (!descriptor || typeof descriptor !== "object") {
          throw new TypeError("resource descriptor is required");
        }
        const kind = resourceKind(descriptor.kind);
        if (!slotChild && kind === "browser") {
          throw new ProbeLifecycleError(
            "browser resources require lifecycle.withEdgeSlot",
          );
        }
        if (
          typeof descriptor.acquire !== "function" ||
          typeof descriptor.close !== "function" ||
          typeof descriptor.isClosed !== "function" ||
          typeof use !== "function"
        ) {
          throw new TypeError(
            "resource acquire, close, isClosed, and callback must be functions",
          );
        }
        checkpoint();
        const acquisition = retain(
          Promise.resolve().then(descriptor.acquire),
          `${descriptor.label ?? kind} acquisition`,
        );
        owned?.add(acquisition);
        const acquired = await acquisition;
        if (hardExited) {
          return HARD_EXIT_PENDING;
        }
        if (acquired.status === "rejected") {
          throw acquired.failure.raw;
        }
        const resource = {
          closed: false,
          closedByParent: false,
          closeOutcome: null,
          closeRace: null,
          closeStarted: false,
          close: descriptor.close,
          handle: acquired.value,
          isClosed: descriptor.isClosed,
          kind,
          label: descriptor.label ?? kind,
          parent: descriptor.parent ?? null,
          sequence: closeSequence++,
          tracked: owned,
        };
        resources.push(resource);
        if (!accepting || phase !== "ACTIVE") {
          startClose(resource);
          const lateAcquisition = failure(
            `${resource.label} late acquisition`,
            new ProbeLifecycleError(
              `${resource.label} acquired after lifecycle cancellation`,
            ),
          );
          retainFailure(lateAcquisition);
          throw lateAcquisition.raw;
        }
        const useOutcome = retain(
          Promise.resolve().then(() => use(resource.handle)),
          `${resource.label} resource callback`,
        );
        owned?.add(useOutcome);
        const used = await useOutcome;
        const closeRace = startClose(resource);
        const closeResult = await closeRace;
        if (used.status === "rejected") {
          if (closeResult.status === "rejected") {
            throw aggregate(`${resource.label} work and close both failed`, [
              used.failure,
              closeResult.failure,
            ]);
          }
          throw used.failure.raw;
        }
        if (closeResult.status === "rejected") {
          throw closeResult.failure.raw;
        }
        if (closeResult.value.kind === "close-deadline") {
          throw new ProbeLifecycleError(
            `${resource.label} close deadline expired`,
          );
        }
        if (closeResult.value.outcome.status === "rejected") {
          throw closeResult.value.outcome.failure.raw;
        }
        if (hardExited) {
          return HARD_EXIT_PENDING;
        }
        checkpoint();
        return used.value;
      },
      async withEdgeSlot(callback) {
        if (slotChild) {
          throw new ProbeLifecycleError("an Edge slot cannot be nested");
        }
        if (typeof callback !== "function") {
          throw new TypeError("Edge-slot callback must be a function");
        }
        checkpoint();
        let leaseObservation;
        let slotCallbackFailed = false;
        let slotLossObserved = false;
        const onLeaseObservation = (observation) => {
          leaseObservation = observation;
          if (!observation || typeof observation !== "object") {
            throw new TypeError("Edge slot supplied no lease observation");
          }
          if (
            observation.releaseOutcome === undefined ||
            observation.whenClosed === undefined
          ) {
            throw new TypeError(
              "Edge slot supplied an incomplete lease observation",
            );
          }
          const releaseOutcome = retain(
            observation.releaseOutcome,
            "Edge-slot release outcome",
          );
          retain(
            releaseOutcome.then((outcome) => {
              if (outcome.status === "rejected") {
                enterDraining("slot-release-observation", outcome.failure);
              } else if (outcome.value?.succeeded !== true) {
                const releaseFailure = failure(
                  "Edge-slot release",
                  outcome.value?.rawCause,
                );
                enterDraining("slot-release-failure", releaseFailure);
              }
              return TRANSITION_OBSERVED;
            }),
            "Edge-slot release transition",
          );
          const closeObservation = retain(
            observation.whenClosed,
            "Edge-slot close observation",
          );
          retain(
            closeObservation.then((outcome) => {
              if (outcome.status === "rejected") {
                enterDraining("slot-close-observation", outcome.failure);
              }
              return TRANSITION_OBSERVED;
            }),
            "Edge-slot close transition",
          );
        };
        const slotOutcome = retain(
          Promise.resolve().then(() =>
            dependencies.edgeSlot(
              {
                owner: options.probe,
                lockPath: options.edgeSlotLockPath,
                onLeaseObservation,
              },
              async (slot) => {
                if (!leaseObservation || !accepting || phase !== "ACTIVE") {
                  return undefined;
                }
                const childTracked = new Set();
                const slotLossWatcher = retain(
                  Promise.race([
                    Promise.resolve(slot.loss).then(
                      (raw) => {
                        slotLossObserved = true;
                        return Object.freeze({ kind: "slot-loss", raw });
                      },
                      (raw) => {
                        slotLossObserved = true;
                        return Object.freeze({
                          kind: "slot-loss-observation",
                          raw,
                        });
                      },
                    ),
                    drainingGate.promise.then(() =>
                      Object.freeze({ kind: "draining" }),
                    ),
                  ]),
                  "Edge-slot loss watcher",
                );
                retain(
                  slotLossWatcher.then((outcome) => {
                    if (outcome.status === "rejected") {
                      enterDraining("slot-loss-observation", outcome.failure);
                    } else if (outcome.value.kind === "slot-loss") {
                      enterDraining(
                        "slot-loss",
                        failure("Edge-slot loss", outcome.value.raw),
                      );
                    } else if (outcome.value.kind === "slot-loss-observation") {
                      enterDraining(
                        "slot-loss-observation",
                        failure(
                          "Edge-slot loss observation",
                          outcome.value.raw,
                        ),
                      );
                    }
                    return TRANSITION_OBSERVED;
                  }),
                  "Edge-slot loss transition",
                );
                let value;
                try {
                  value = await callback(makeScope(true, childTracked), slot);
                } catch (raw) {
                  slotCallbackFailed = true;
                  throw raw;
                } finally {
                  await waitForOwnedFixedPoint(childTracked);
                }
                return hardExited ? HARD_EXIT_PENDING : value;
              },
            ),
          ),
          "Edge-slot outcome",
        );
        const slotResult = await slotOutcome;
        if (
          !leaseObservation &&
          slotResult.status === "rejected" &&
          isEdgeSlotBusyRefusal(slotResult.failure.raw)
        ) {
          throw slotResult.failure.raw;
        }
        if (
          slotResult.status === "rejected" &&
          !slotCallbackFailed &&
          !slotLossObserved
        ) {
          enterDraining("slot-loss", slotResult.failure);
        }
        if (!leaseObservation) {
          const missing = failure(
            "Edge-slot close observation",
            new ProbeLifecycleError(
              "Edge slot did not expose a lease observation",
            ),
          );
          enterDraining("slot-pre-callback-loss", missing);
        }
        if (slotResult.status === "rejected") {
          throw slotResult.failure.raw;
        }
        if (hardExited) {
          return HARD_EXIT_PENDING;
        }
        checkpoint();
        return slotResult.value;
      },
    };
    return Object.freeze(scope);
  };

  const outerScope = makeScope(false);
  orderlyTimer = dependencies.setTimeout(
    () => settleStop("deadline"),
    deadlineMs,
  );
  const stopOutcome = retain(stopGate.promise, "orderly stop control", false);
  const bodyOutcome = retain(
    Promise.resolve().then(() => body(outerScope)),
    "lifecycle body",
  );
  const bodyTransition = retain(
    bodyOutcome.then((outcome) => {
      enterDraining(
        outcome.status === "fulfilled" ? "body-fulfilled" : "body-rejected",
        outcome,
      );
      return TRANSITION_OBSERVED;
    }),
    "body transition",
  );
  const stopTransition = retain(
    stopOutcome.then((outcome) => {
      if (outcome.status === "fulfilled" && outcome.value.kind === "deadline") {
        enterDraining("orderly-deadline", outcome);
      }
      return TRANSITION_OBSERVED;
    }),
    "orderly stop transition",
    false,
  );

  const wake = await Promise.race([
    bodyOutcome.then((outcome) => Object.freeze({ source: "body", outcome })),
    stopOutcome.then((outcome) => Object.freeze({ source: "stop", outcome })),
  ]);
  enterDraining(
    wake.source === "stop" &&
      wake.outcome.status === "fulfilled" &&
      wake.outcome.value.kind === "deadline"
      ? "orderly-deadline"
      : "initial-wake",
    wake.outcome,
  );

  const waitForFixedPoint = async () => {
    let observedSize = -1;
    while (!hardExited) {
      const snapshot = [...phaseATracked];
      await Promise.all(snapshot);
      await Promise.resolve();
      if (
        snapshot.length === phaseATracked.size &&
        observedSize === phaseATracked.size
      ) {
        return;
      }
      observedSize = phaseATracked.size;
    }
  };

  await drainingGate.promise;
  await cleanupBarrier;
  await waitForFixedPoint();
  if (hardExited) {
    return HARD_EXIT_PENDING;
  }
  const unclosed = resources.filter((resource) => resource.closed !== true);
  if (unclosed.length > 0) {
    const unproved = failure(
      "resource closure",
      new ProbeLifecycleError("a probe resource did not prove closed"),
    );
    enterDraining("resource-close-unobserved", unproved);
    return HARD_EXIT_PENDING;
  }

  settleStop("cleared");
  await bodyTransition;
  await stopTransition;
  if (hardExited) {
    return HARD_EXIT_PENDING;
  }
  dependencies.clearTimeout(hardTimer);
  phase = "QUIESCENT";
  const bodyResult = await bodyOutcome;
  const lifecycleFailures = failures.filter((entry) => entry?.occurred);
  if (bodyResult.status === "rejected" && lifecycleFailures.length === 0) {
    throw bodyResult.failure.raw;
  }
  if (lifecycleFailures.length > 0) {
    throw aggregate("probe lifecycle failed", lifecycleFailures, {
      completedValue:
        bodyResult.status === "fulfilled" ? bodyResult.value : undefined,
      primaryCause:
        bodyResult.status === "rejected" ? bodyResult.failure.raw : undefined,
    });
  }
  return bodyResult.value;
}

export default { ProbeLifecycleError, withProbeLifecycle };
