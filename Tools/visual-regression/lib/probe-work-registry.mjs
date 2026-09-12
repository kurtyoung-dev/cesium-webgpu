// probe-work-registry.mjs — who owns the asynchronous work a descriptor starts.
//
// @purpose Tracks every `scope.run` a descriptor starts as an attempt with a settled outcome, so a run cannot be reported complete while work it started is still live, and such work's failure reaches the incident record whenever an incident is written at all; the browser's close is NOT deferred for it — see the header.
// @status ACTIVE
//
// WHY A REGISTRY AND NOT A PROMISE. `descriptor.cells` is free to start work
// and return without awaiting it — a listener installed on a page, a readback
// scheduled behind a settle, a capture kicked off in parallel. The
// pre-adoption runtime closed the browser in a `finally` the moment `cells`
// returned, so that work lost its page mid-flight and the failure it raised
// surfaced (if at all) as an unhandled rejection with no probe name on it.
//
// Under the adopted lifecycle every `scope.run` enrols an ATTEMPT here before
// it starts. An attempt has exactly one terminal outcome — fulfilled, rejected,
// or `not-started`, the last meaning the work never ran (draining is one cause;
// `finishNotStarted` has five call sites and the causes are deliberately NOT
// enumerated here) — and the RUN cannot report complete until every attempt has
// settled. A descriptor that
// leaves work running therefore delays its own completion instead of silently
// orphaning it, and whatever that work reports reaches the incident record
// rather than becoming an unhandled rejection with no probe name on it —
// WHENEVER AN INCIDENT IS WRITTEN AT ALL. That condition is the whole of the
// guarantee, and it is stated as a condition on purpose: several paths write
// no incident, `C13-42a-3` item 6 enumerates the ones known today, and an
// enumeration repeated here would be wrong the moment a new one appears.
// Four rounds of adversarial verification on this lane were spent discovering
// that every sentence of the form "…except X" was falsified by a Y the author
// had not walked.
//
// WHAT THIS DOES NOT DO, STATED HERE BECAUSE THE OBVIOUS READING IS WRONG.
// `closeBrowserAfter` does NOT hold the browser open while the registry drains.
// It starts `browser.close()` in the same tick it starts awaiting the registry
// and then `Promise.all`s the three — so the drain and the teardown run
// CONCURRENTLY, and unawaited work that still needs its page will find the page
// gone. Measured, not inferred: `cells returned` → `browser.close` → `late work
// finished; browser open = false`. The guarantee is "the run does not report
// complete while the work is live, and the work's failure reaches the INCIDENT
// record whenever an incident is written at all" — not "the page survives until
// the work is done". Say INCIDENT, never "report": a measured run writes
// `-report.json`, and the distinction is what item 8 below turned on until it
// was closed on 2026-09-12 — it orphaned work while a report was written. See
// `C13-42a-3` item 6 for the paths that write no incident and spec F5 for the
// pin on the best-known of them.
//
// That is inherited verbatim from the runtime this was adopted from, and it is
// arguably the right default — a close that waits on a hung readback holds the
// single Edge slot for the whole close deadline. But it is not what a reader
// assumes, so: AWAIT your `scope.run` calls if the work needs the page. Making
// the close wait for the drain (and paying for it with a bound) is filed as
// `C13-42a-3` in `DEFERRED_WORK.md`. Both facts are pinned by group F of
// `Tools/visual-regression/probe-runtime-lifecycle-adoption.spec.mjs`.
//
// TWO PROMISES PER ATTEMPT, ON PURPOSE. `rawOutcome` is what the work itself
// did; `wrapperOutcome` is what the caller of `scope.run` saw. They differ
// whenever the work did not run to its own conclusion — a lifecycle
// cancellation is one such case, not the only one — and keeping them separate
// is what lets a failure be reported once rather than twice.
//
// WHAT THE DRAIN COLLECTS (2026-09-12 — `C13-42a-3` item 8 is CLOSED here).
// `closeBrowserAfter` collects on "carries a failure", not on status: every
// settled work outcome holding a `sourceFailure` occurrence reaches the
// incident record, whether it settled `rejected` or `not-started`. Until
// this date it filtered on `status === "rejected"`, so a `not-started`
// record was invisible to it EVEN WHEN IT CARRIED A FAILURE REASON — a
// malformed third argument to `scope.run` reaches exactly that state, and
// the run published a clean measurement over work that never ran. The two
// known triggers (a non-function `abort`; a `null` third argument, which
// throws one line earlier) converge on that ONE terminal state, which is
// why a single predicate closes both rather than each guard being hardened
// separately. `not-started` still does not imply failure — the ordinary
// ones carry a plain string reason and stay silent. Group G of
// `Tools/visual-regression/probe-runtime-lifecycle-adoption.spec.mjs` pins
// both halves.
//
// BOTH COLLECTORS READ IT (corrected 2026-09-12, review finding F5). The
// drain has two: the descriptor's work outcomes, and the RUN ATTEMPT. The
// attempt is registered through the same `registerObservedRun`, whose
// pre-start-cancellation path settles it `not-started` carrying a real
// `sourceFailure`, so a rule the attempt half did not follow would have left
// the file stating one predicate and applying two. It also has a consequence
// beyond tidiness: the attempt's failure is the run's PRIMARY, excluded from
// `secondaries` so it is reported once rather than twice, and a primary the
// filter cannot recognise is a primary re-thrown as a secondary.
//
// Adopted (C13-42a) from the unlanded runtime rewrite that produced the
// 2026-09-09 C13-42 runs; extracted to its own file here so the runtime stays
// inside the fork's size rule.

import { appendOnce, sourceFailure } from "./probe-lifecycle-diagnostics.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return Object.freeze({ promise, resolve });
}

const fulfilled = (value) => Object.freeze({ status: "fulfilled", value });
const rejected = (failure) => Object.freeze({ status: "rejected", failure });
const notStarted = (reason) => Object.freeze({ status: "not-started", reason });

function makeAttempt(run) {
  const raw = deferred();
  const wrapper = deferred();
  let phase = "never-admitted";
  let terminal;
  let wrapperAttached = false;
  let wrapperSettled = false;

  const settle = (outcome) => {
    if (phase === "settled") {
      return false;
    }
    phase = "settled";
    terminal = outcome;
    raw.resolve(outcome);
    return true;
  };

  return Object.freeze({
    run,
    get phase() {
      return phase;
    },
    get terminal() {
      return terminal;
    },
    rawOutcome: raw.promise,
    wrapperOutcome: wrapper.promise,
    schedule() {
      if (phase !== "never-admitted") {
        return false;
      }
      phase = "scheduled";
      return true;
    },
    start() {
      if (phase !== "scheduled") {
        return false;
      }
      phase = "started";
      return true;
    },
    fulfill(value) {
      return settle(fulfilled(value));
    },
    reject(failure) {
      return settle(rejected(failure));
    },
    finishNotStarted(reason) {
      if (phase !== "never-admitted" && phase !== "scheduled") {
        return false;
      }
      const changed = settle(notStarted(reason));
      if (changed && !wrapperAttached && !wrapperSettled) {
        wrapperSettled = true;
        wrapper.resolve(notStarted(reason));
      }
      return changed;
    },
    attachWrapper() {
      if (wrapperAttached || wrapperSettled) {
        return false;
      }
      wrapperAttached = true;
      return true;
    },
    settleWrapper(outcome) {
      if (wrapperSettled) {
        return false;
      }
      wrapperSettled = true;
      wrapper.resolve(outcome);
      return true;
    },
  });
}

function makeWorkRegistry() {
  const records = [];
  const byWrapper = new Map();
  let propagatedFailure;
  let sealed = false;

  return Object.freeze({
    enroll(label) {
      if (sealed) {
        throw new Error("descriptor work registration is sealed");
      }
      const record = makeAttempt(label);
      if (!record.schedule()) {
        throw new Error("work could not be scheduled");
      }
      records.push(record);
      return record;
    },
    bindWrapper(wrapper, record) {
      if (sealed || byWrapper.has(wrapper)) {
        throw new Error("descriptor work wrapper was already bound");
      }
      byWrapper.set(wrapper, record);
    },
    recordFor(wrapper) {
      return byWrapper.get(wrapper);
    },
    propagate(failure) {
      if (propagatedFailure !== undefined) {
        throw new Error("descriptor result propagated more than one cause");
      }
      propagatedFailure = failure;
    },
    takePropagatedFailure() {
      const failure = propagatedFailure;
      propagatedFailure = undefined;
      return failure;
    },
    seal() {
      sealed = true;
    },
    async settleAndSeal() {
      sealed = true;
      return Promise.all(records.map((record) => record.rawOutcome));
    },
  });
}

async function observeExistingCallerRace(registry, work, watchdog) {
  const record = registry.recordFor(work);
  if (!record) {
    throw new TypeError("scope.race work was not registered");
  }

  const winner = await Promise.race([
    Promise.resolve(work).then(
      (value) => fulfilled(value),
      async (raw) => {
        const wrapper = await record.wrapperOutcome;
        return wrapper.status === "rejected"
          ? wrapper
          : rejected(sourceFailure("registered work wrapper", raw));
      },
    ),
    Promise.resolve(watchdog).then(
      (value) => fulfilled(value),
      (raw) => rejected(sourceFailure("descriptor watchdog", raw)),
    ),
  ]);
  if (winner.status === "fulfilled") {
    return winner.value;
  }
  registry.propagate(winner.failure);
  throw winner.failure.raw;
}

function registerObservedRun({
  slotScope,
  owner,
  label,
  start,
  operationOptions = {},
  propagatedFailure = () => undefined,
}) {
  const record = owner.enroll ? owner.enroll(label) : owner;
  let rawFailureOccurrence;
  let wrapperPromise;
  record.attachWrapper();

  try {
    wrapperPromise = slotScope.run(
      label,
      (signal) => {
        try {
          slotScope.checkpoint();
        } catch (raw) {
          const failure = sourceFailure(`${label} pre-start cancellation`, raw);
          rawFailureOccurrence = failure;
          record.finishNotStarted(failure);
          throw raw;
        }
        if (!record.start()) {
          return undefined;
        }

        let produced;
        try {
          produced = start(signal);
        } catch (raw) {
          const failure = sourceFailure(label, raw);
          rawFailureOccurrence = failure;
          record.reject(failure);
          throw raw;
        }
        return Promise.resolve(produced).then(
          (value) => {
            record.fulfill(value);
            return value;
          },
          (raw) => {
            const failure = propagatedFailure() ?? sourceFailure(label, raw);
            rawFailureOccurrence = failure;
            record.reject(failure);
            throw raw;
          },
        );
      },
      operationOptions,
    );
  } catch (raw) {
    wrapperPromise = Promise.reject(raw);
  }

  const wrapperOutcome = Promise.resolve(wrapperPromise).then(
    (value) => fulfilled(value),
    (raw) => {
      const failure =
        rawFailureOccurrence ?? sourceFailure(`${label} wrapper`, raw);
      record.finishNotStarted(failure);
      return rejected(failure);
    },
  );
  owner.bindWrapper?.(wrapperPromise, record);
  wrapperOutcome.then((outcome) => record.settleWrapper(outcome));
  return Object.freeze({ wrapper: wrapperPromise, record });
}

function makeDescriptorScope(slotScope, workRegistry) {
  return Object.freeze({
    signal: slotScope.signal,
    checkpoint: slotScope.checkpoint,
    run(label, start, operationOptions) {
      return registerObservedRun({
        slotScope,
        owner: workRegistry,
        label,
        start,
        operationOptions,
      }).wrapper;
    },
    race(work, watchdog) {
      return observeExistingCallerRace(workRegistry, work, watchdog);
    },
  });
}

// The failure a settled work outcome carries, or `undefined` when it carries
// none. Collecting on THIS rather than on `status` is what closes
// `C13-42a-3` item 8: a record can settle `not-started` and still carry a
// real failure, because a malformed third argument to `scope.run` rejects
// inside `slotScope.run` before the work is ever entered, and
// `registerObservedRun` records that rejection through `finishNotStarted`.
// `occurred` is the stamp `sourceFailure` puts on a real occurrence, so this
// agrees by construction with `appendOnce`, which already ignores anything
// without it; it is also what keeps the ORDINARY not-started reasons, which
// are plain strings (`probe-lifecycle-run.mjs`), from failing every healthy
// run, and it guarantees the numeric `occurrence` the caller orders by.
function carriedFailure(outcome) {
  const carried =
    outcome.status === "rejected" ? outcome.failure : outcome.reason;
  return carried?.occurred === true ? carried : undefined;
}

async function closeBrowserAfter(
  attemptOutcomePromise,
  workOutcomesPromise,
  browser,
) {
  const browserCloseOutcome = Promise.resolve()
    .then(() => browser.close())
    .then(
      () => Object.freeze({ status: "fulfilled" }),
      (raw) => Object.freeze({ status: "rejected", raw }),
    );
  const [attemptOutcome, workOutcomes, closeOutcome] = await Promise.all([
    attemptOutcomePromise,
    workOutcomesPromise,
    browserCloseOutcome,
  ]);
  const failures = [];
  const seen = new Set();
  // Same predicate on both halves — see the header. `carriedFailure` reads a
  // `rejected` outcome's `failure` and any other outcome's `reason`, so this
  // is unchanged for every attempt that rejects.
  const attemptFailure = carriedFailure(attemptOutcome);
  if (attemptFailure !== undefined) {
    appendOnce(failures, seen, attemptFailure);
  }
  // "Carries a failure", not `status === "rejected"` — see `carriedFailure`.
  const failedWork = workOutcomes
    .map(carriedFailure)
    .filter((failure) => failure !== undefined)
    .sort((left, right) => left.occurrence - right.occurrence);
  for (const failure of failedWork) {
    appendOnce(failures, seen, failure);
  }

  if (closeOutcome.status === "rejected") {
    const { raw } = closeOutcome;
    appendOnce(failures, seen, sourceFailure("Edge browser close", raw));
  }

  const secondaries = failures.filter(
    (entry) =>
      attemptFailure === undefined ||
      entry.occurrence !== attemptFailure.occurrence,
  );
  if (secondaries.length === 1) {
    throw secondaries[0].raw;
  }
  if (secondaries.length > 1) {
    throw new AggregateError(
      secondaries.map((entry) => entry.raw),
      "descriptor drain and browser close failed",
    );
  }
}

export {
  closeBrowserAfter,
  makeAttempt,
  makeDescriptorScope,
  makeWorkRegistry,
  registerObservedRun,
};
