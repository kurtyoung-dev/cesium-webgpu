// runtime-residency-allowlist.mjs — the shrink-only ratchet for
// `@runtime`-resident probes that still carry an anti-re-accretion violation.
//
// @purpose Frozen, shrink-only allowlist of runtime-resident probes still carrying an anti-re-accretion violation, mirroring lib/prohibited-reader-allowlist.mjs's ratchet shape.
// @status ACTIVE
//
// EMPTY ON PURPOSE, AT THIS SNAPSHOT. `DX-01` migrated exactly one probe onto
// the runtime (`probe-globe-cold-start-readiness.mjs`), and it is clean — see
// `runtime-residency-contract.spec.mjs`'s pilot test. There is nothing to
// grandfather yet. The ratchet still ships now, empty, rather than being
// added later alongside the first offender: `DX-06` migrates probes in
// batches of 40-60 (queue `QUEUE_2026-08-29_RESEARCH_DISPATCH.md` §6a), and a
// migration that tags a probe resident before its four-concern cleanup is
// finished needs a place to record that honestly, in the same shrink-only
// shape `lib/prohibited-reader-allowlist.mjs` already established — a `size`
// that can only fall, and a membership no batch may grow beyond a name it
// removes.

/**
 * Source path (relative to `Tools/visual-regression/`) -> one-line reason it
 * is temporarily exempt, with an add-date. Deleting a row is how a probe's
 * repair is recorded; the row must be removed in the SAME change that fixes
 * the file, per `runtime-residency-contract.spec.mjs`'s "repaired" check.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const RUNTIME_RESIDENCY_ALLOWLIST = Object.freeze({});

/**
 * Frozen 2026-09-02 census, at zero: the pilot migration was clean. The live
 * allowlist may be a subset of these members, never a superset; the spec pins
 * both this size and this membership.
 */
export const RUNTIME_RESIDENCY_ALLOWLIST_SNAPSHOT = Object.freeze({
  size: 0,
  members: Object.freeze([]),
});
