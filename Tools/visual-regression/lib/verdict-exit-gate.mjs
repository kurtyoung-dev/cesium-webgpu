// verdict-exit-gate.mjs — the single home for the evidence-gate verdict tiers
// and the exit code each one leaves with.
//
// WHY THIS EXISTS. Six sibling gate libraries each carried their own copy of
// the status-to-exit mapping. Five agreed; one routed STRUCTURAL to 2, the code
// reserved for "the harness broke", so a lane that could not see its subject
// was indistinguishable from a crashed run for every orchestrator that scores
// by exit status. A rule copied six times is a rule that holds five times.
//
// THE TIERS.
//   0 PASS       — the lane saw its subject and the subject met the bar.
//   1 FAIL       — the lane saw its subject and the subject missed the bar.
//   2 ERROR      — the harness broke: an exception, a timeout, a wedged page.
//   3 STRUCTURAL — the lane could not see its subject at all, so it has no
//                  standing to report either a pass or a fail.
//
// TWO READERS, ONE TABLE. `exitCodeForS5Status` is the canonical accessor and
// refuses an unrecognized status, because a status the mapping has never heard
// of is a programming error rather than a verdict. Artifact VALIDATORS need the
// opposite disposition — they are fed hostile data on purpose and their job is
// to collect reasons, not to throw out of the middle of a reason list — so they
// read the same table through `exitCodeForS5StatusOrStructural`, which treats
// an unreadable status as blindness. Both read `S5_STATUS_EXIT_CODES`; neither
// carries a mapping of its own.

/** The frozen verdict-tier table every gate library resolves against. */
export const S5_STATUS_EXIT_CODES = Object.freeze({
  PASS: 0,
  FAIL: 1,
  ERROR: 2,
  STRUCTURAL: 3,
});

/** The verdict tiers a published final artifact may carry. */
export const S5_FINAL_STATUSES = Object.freeze(
  Object.keys(S5_STATUS_EXIT_CODES),
);

/**
 * Exit code for a recognized verdict tier.
 *
 * @param {string} status One of PASS / FAIL / ERROR / STRUCTURAL.
 * @returns {number} The tier's exit code.
 * @throws {RangeError} When the status is not a recognized tier.
 */
export function exitCodeForS5Status(status) {
  if (
    typeof status === "string" &&
    Object.hasOwn(S5_STATUS_EXIT_CODES, status)
  ) {
    return S5_STATUS_EXIT_CODES[status];
  }
  throw new RangeError(`unknown S5 evidence status ${String(status)}`);
}

/**
 * Exit code for a verdict tier read out of untrusted artifact data, where an
 * unreadable status means the artifact cannot vouch for what it saw.
 *
 * @param {unknown} status Candidate verdict tier.
 * @returns {number} The tier's exit code, or the STRUCTURAL code.
 */
export function exitCodeForS5StatusOrStructural(status) {
  if (
    typeof status === "string" &&
    Object.hasOwn(S5_STATUS_EXIT_CODES, status)
  ) {
    return S5_STATUS_EXIT_CODES[status];
  }
  return S5_STATUS_EXIT_CODES.STRUCTURAL;
}
