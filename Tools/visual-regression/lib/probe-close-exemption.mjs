// probe-close-exemption.mjs — what a lingering browser close is allowed to cost, shared.
//
// @purpose Decides from a lifecycle rejection whether it is only a browser that lingered after the run's work was complete, and describes each run's browser close for the receipt; the one rule `runProbe` and the capture seam both apply.
// @status ACTIVE
//
// WHY THIS IS ITS OWN MODULE. Batch 1638 gave `runProbe` an exemption for a
// browser close that outlives its deadline after every cell and verdict
// completed, and wrote it inside `probe-lifecycle-run.mjs`. The capture seam
// (`capture.mjs`) drives the same lifecycle through a different composition
// root and had no such exemption, so a capture whose cells were all written
// but whose browser close lingered past its own deadline was lost: an incident
// instead of a manifest. Copying the rule into the seam would let the two
// drift on exactly the clause that decides whether a measurement is published,
// so the rule lives here and both call it. A caller keeps its own `state`
// (`complete`, `closes`); this module holds no state of its own and writes
// nothing.
//
// THE RULE. A rejection is non-fatal only when the run reports `complete`,
// every failure is a close deadline (or the orderly deadline, which after
// complete work can only have measured the same slow teardown), and every
// close that expired had already drained the work it was closing. Anything
// else - a cell that threw, a close that rejected, a slot that was lost, a
// close that expired while work was still pending - stays the error it was.

/** The close deadline before the 2026-10-31 measurement; the receipt reports against it. */
export const LEGACY_CLOSE_DEADLINE_MS = 10_000;

/**
 * One browser-close record, as the lifecycle callers keep it in `state.closes`.
 * Created when the close begins and completed in place as it settles.
 *
 * @param {object} fields Fields.
 * @param {number} fields.run Zero-based run the browser belonged to.
 * @param {string} fields.label The resource label the lifecycle reports the close under.
 * @param {number} fields.deadlineMs The close deadline in force.
 * @param {number} fields.startedAt Clock reading when the close began.
 * @returns {object} A fresh, unsettled record.
 */
export function createCloseRecord({ run, label, deadlineMs, startedAt }) {
  return {
    run,
    label,
    deadlineMs,
    startedAt,
    closeMs: null,
    browserCloseMs: null,
    drained: false,
    expired: false,
  };
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
