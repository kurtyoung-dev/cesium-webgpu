// probe-refusal.mjs — the probe fleet's exit-code table and refusal primitives.
//
// @purpose Frozen OK/FAILURE/ERROR/REFUSAL exit codes plus the ProbeRefusal error and the accepted/refused decision shape every probe-runtime guard returns.
// @status ACTIVE
//
// WHY THIS IS ITS OWN FILE. A refusal is the one thing every guard in the probe
// runtime produces, and the runtime, the Edge-slot lock and each migrated probe
// all need to raise one. Keeping the table here means the lock module does not
// import the runtime that imports the lock, and it keeps each of the three
// files a reviewable size.
//
// THE TIERS, AND WHY THERE ARE FOUR. The `DX-01` row names 0/2/3 — the three
// codes the RUNTIME can produce on its own: the run completed, the harness
// broke, or the runtime refused to measure. A probe's own verdicts need the
// fourth: a measured red exits 1. That 1 is read off `verdict-exit-gate.mjs`'s
// FAIL tier rather than written as a second literal, because that table is
// already the single home for the mapping and six copies of it once disagreed.
//
// The ordering matters as much as the values. A REFUSAL outranks a measured
// red: a run whose preconditions could not be validated has no standing to
// report either a pass or a fail, and an orchestrator that scores by exit
// status must not read one as the other. A measured red, in turn, is never
// rounded down to OK.

import { S5_STATUS_EXIT_CODES } from "./verdict-exit-gate.mjs";

/** The probe fleet's exit-code table. */
export const PROBE_EXIT_CODES = Object.freeze({
  OK: 0,
  FAILURE: S5_STATUS_EXIT_CODES.FAIL,
  ERROR: 2,
  REFUSAL: 3,
});

/**
 * Thrown when a probe declines to measure. A refusal is never a result: it
 * exits 3 so an orchestrator scoring by exit status cannot read it as either a
 * pass or a measured red.
 */
export class ProbeRefusal extends Error {
  /**
   * @param {string} reason Machine-readable refusal reason.
   * @param {string} message Human-readable explanation.
   * @param {object|null} [details] Structured context for the receipt.
   */
  constructor(reason, message, details = null) {
    super(message);
    this.name = "ProbeRefusal";
    this.reason = reason;
    this.exitCode = PROBE_EXIT_CODES.REFUSAL;
    this.details = details;
  }
}

/**
 * @returns {{refuse: false, exitCode: number, reason: null}} An accepted decision.
 */
export function acceptedDecision() {
  return { refuse: false, exitCode: PROBE_EXIT_CODES.OK, reason: null };
}

/**
 * @param {string} reason Machine-readable refusal reason.
 * @param {object|null} [details] Structured context.
 * @returns {{refuse: true, exitCode: number, reason: string, details: object|null}} A refusal.
 */
export function refusedDecision(reason, details = null) {
  return {
    refuse: true,
    exitCode: PROBE_EXIT_CODES.REFUSAL,
    reason,
    details,
  };
}

/**
 * Turn a refusing decision into a thrown {@link ProbeRefusal}; a no-op on an
 * accepted one. Every guard in the runtime returns a decision and is raised
 * through here, so "decided to refuse" and "actually refused" cannot drift.
 *
 * @param {{refuse: boolean, reason: string|null, details?: object|null}} decision The decision.
 * @param {string} message Human-readable explanation for the refusal.
 * @returns {void}
 */
export function throwForDecision(decision, message) {
  if (decision && decision.refuse === true) {
    throw new ProbeRefusal(decision.reason, message, decision.details ?? null);
  }
}

/**
 * The final exit code for a run.
 *
 * @param {object} options Options.
 * @param {object|null} [options.refusal] A refusal, when one occurred.
 * @param {boolean} [options.errored] Whether the harness threw.
 * @param {Array<{pass: boolean}>} [options.verdicts] The probe's verdicts.
 * @returns {number} The exit code.
 */
export function exitCodeForOutcome({ refusal, errored, verdicts }) {
  if (refusal) {
    return PROBE_EXIT_CODES.REFUSAL;
  }
  if (errored === true) {
    return PROBE_EXIT_CODES.ERROR;
  }
  const failed = (verdicts ?? []).filter((verdict) => verdict.pass !== true);
  return failed.length === 0 ? PROBE_EXIT_CODES.OK : PROBE_EXIT_CODES.FAILURE;
}
