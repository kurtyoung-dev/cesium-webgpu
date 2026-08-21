// purpose-header-allowlist.mjs — the PINNED census of probes and gate
// libraries that do not yet carry the `@purpose` / `@status`
// self-registration header required by maintainer ruling M4.
//
// @purpose Frozen shrink-only snapshot of the probes and gate libs that predate the @purpose/@status header rule.
// @status ACTIVE
//
// This file is DATA, not policy. Every entry is a file that shipped before
// the header rule existed, recorded here so `purpose-header-contract.spec.mjs`
// can fail on a NEW unregistered probe without failing on the whole inherited
// fleet. Unlike its machine-safety sibling, every entry has the SAME reason —
// the file predates the rule and carries no header — so the reason is stated
// once here rather than repeated 652 times.
//
// THE RATCHET, IN THREE PARTS, all asserted by the spec:
//   1. Every name still resolves to a file that is still in scope. A rename
//      or a deletion cannot silently retire an entry.
//   2. Every name still LACKS a header. A file that gains one must be deleted
//      from this list in the same change — that is what makes the debt
//      monotonically non-increasing rather than a number somebody re-measures.
//   3. The list never exceeds `PURPOSE_HEADER_ALLOWLIST_SNAPSHOT_SIZE`. There
//      is no mechanism to add to it except deliberately editing this file AND
//      raising that constant, which is a reviewable act rather than an
//      accident.
//
// HOW THIS LIST ENDS. `Tools/inject-purpose-headers.mjs` writes the headers
// for the whole fleet in one batch; the same batch empties the array below and
// leaves the snapshot constant as the record of what the debt WAS. Until then
// the list covers every in-scope file, which is recorded honestly by the spec
// rather than hidden: the fleet leg of the contract is vacuous today and the
// synthetic mutation controls are what carry the detector's credibility.
//
// Census taken 2026-08-16 over `Tools/visual-regression/probe-*.mjs`
// (excluding `.spec.mjs`) and `Tools/visual-regression/lib/*-gate.mjs`:
// 652 files in scope, 652 carrying no readable header.

/**
 * Files exempt from the `@purpose` header rule, relative to
 * `Tools/visual-regression/`.
 *
 * @type {readonly string[]}
 */
export const PURPOSE_HEADER_ALLOWLIST = Object.freeze([
  // Emptied 2026-08-21: the C12-11 harness rebuild landed with headers, so
  // the two frozen-bytes holds are discharged. The ratchet is shrink-only.
]);

/**
 * The size of the 2026-08-16 census. The allowlist may only shrink, so the
 * spec asserts `PURPOSE_HEADER_ALLOWLIST.length <= this`. Raising it is a
 * deliberate, reviewable act and needs a reason in the commit message.
 *
 * @type {number}
 */
export const PURPOSE_HEADER_ALLOWLIST_SNAPSHOT_SIZE = 0;
