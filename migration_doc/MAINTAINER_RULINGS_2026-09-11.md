# Maintainer rulings — 2026-09-11

## R-2026-09-11-1 — Optional adversarial verifier for important batches

The seat reported that reviewers carry the substantive judgement while the seat verifies consistency
(the verdict line, the three-way apply, the gates, and a commit message written from the packet), and
that reviewers' recurring blind spot is anything only an Edge run shows plus counts and mechanism
claims nobody re-derives. The maintainer ruled: "Add the adversarial Opus verifier as optional, lets
run it when we need to verify important functionality and prove something important is well built."

Effect. A second, independent Opus verifier may be dispatched by the seat after the station-3 review
and before landing. It is briefed to REFUTE the packet, not to confirm it: re-derive every mechanism
claim from the code at the lane's HEAD, re-run every mutant on disk and restore byte-identically,
re-read the Edge receipts, and try to construct a failing input for each acceptance clause. It writes
`_lane-out/VERIFY_<Name>.md` ending in exactly one final line `VERDICT: HOLDS` or `VERDICT: REFUTED
(<claim>)`; a REFUTED verdict returns the lane to its worker before landing.

Scope. Optional. The seat runs it when the maintainer or the seat flags a batch as important: a
visual-improvement milestone, a parity claim the record will call well built, a mechanism claim such
as "the engine was right", or a landing that closes a P0 row. It is not required for tools or docs
batches or for routine engine rounds; the proof bar of R-2026-08-29-1 is unchanged.

Authority: charter §1.1. This ruling does not alter the station-3 review, the Edge acceptance, or the
seat's mechanical gates.
