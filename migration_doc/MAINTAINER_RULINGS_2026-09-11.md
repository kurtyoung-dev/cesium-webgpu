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

## R-2026-09-11-2 — C13-42 derived response budget applies to offline leg (M6 scope a)

M6 scope (a) — the derived MAX_SERVED_RESPONSES bound applies to the OFFLINE leg (O-above-deck) as
well as the reported subjects, so a complete C13-42 receipt is producible; the calibration run
replaces the derived value.

Basis: Gamling, M6 scope (a) (`PROGRESS_ELDARION.md:356-358`), with Horn's measured 58
(`PACKET_HORN.md:236`); a reported-only raise leaves `O-above-deck` refusing at 58 while
`validateReceipt` requires all seven subjects, so no complete receipt is producible under M6 as
originally ruled.

Executed: Batch 1467 (`54ca360ea3`, lane C1 fix round, worker Farin).

Authority: charter §1.1.

## R-2026-09-11-3 — C13-42 certification PASS requires provider integration (M6 scope b)

M6 scope (b) — a C13-42 certification PASS requires providerIntegration.implemented === true; the
geometry/fixture release stands; Horn's split of the provider obligation is advisory until then
(restore the enforcement point).

Basis: Gamling, M6 scope (b) / F3 (`PROGRESS_ELDARION.md:219-220`); splitting the obligation had
removed its only enforcement point in `foldReceipt`, making a certification PASS reachable with
provider integration unimplemented once thresholds freeze.

Executed: Batch 1467 (`54ca360ea3`, lane C1 fix round, worker Farin).

Authority: charter §1.1.

## R-2026-09-11-4 — M1 dependency block acceptance re-specified lock-free

M1 acceptance re-specified lock-free: `npm install --package-lock-only` into a temp lock compared
against manifest ranges + the tsd-jsdoc-compat tarball check + a clean Sandcastle2 build; no
committed package-lock.json (.npmrc package-lock=false stands, per upstream).

Basis: Ceorl D1 (this repository keeps no committed lockfile; `.npmrc:1` is tracked with
`package-lock=false` since upstream `a8cacae67b`, `.gitignore:45` ignores `package-lock.json`, and
zero of the nine CI workflows run `npm ci`; an `npm ci` acceptance was unexecutable).

Executed: Batch 1466 (`284e181506`, lane D1, worker Dernhelm / fix worker Fundin, reviewer Ceorl /
Nain).

Authority: charter §1.1.

## R-2026-09-11-5 — God-ray behind-camera architecture: single determination authority (Option B)

God-ray behind-camera design = ONE shader, ONE uniform flag, ONE authority (Bain option B).
Harding's caller-side boolean is the sole determination; it feeds the pass skip (`enabled = usable ||
scene.godRayBehindCamera`, default false = cull, both passes skipped) AND Eothain's shader receptor
via `setSunScreenUV(u, v, usable)` -> `params3.y`; `sunUnusable` gets its own disjoint per-frame
write range so the H2 byte-orphaning cannot recur; grazing `cw ~= 0` guarded as unusable. Ledger:
`NEW-WEBGPU-GODRAY-BEHIND-CAMERA-CALLER` closes SHIPPED in the rebase batch (caller = Harding's
boolean, consumer = params3.y) + a NEW OPEN row for the anticrepuscular visual (weaker emitter, glow
re-centred at the antisolar point, own probe).

Basis: Bain's assessment (`scratchpad/GODRAY_BEHIND_CAMERA_ASSESSMENT.md`), resolving the collision
between Harding's caller-side `enabled` logic and Eothain's shader receptor.

Executed: Batch 1471 (`3a9d6b80f0`, lane C3 rebase/landing, worker Eothain / Tauriel / Arveleg,
reviewers Widfara / Galion / Elfhild).

Authority: charter §1.1.

## Note — 2026-09-11 afternoon quiet-hours verbal lift and guard refusal

On 2026-09-11 the maintainer verbally lifted GitHub quiet hours for the afternoon to recover velocity
following the machine restart. However, the tracked pre-push guard (`.husky/pre-push`,
`Tools/landing-rules.mjs`, governed by R-2026-08-14-4) contains no programmatic override mechanism
and refused the in-window commit timestamp. Batch 1464 (`765feaba0a`) was consequently re-dated and
pushed after the window closed at 19:09 EDT. A formal tracked mechanism for authorized quiet-hours
waivers remains an open ruling request (`RR-2026-09-11-A` in
`migration_doc/RULING_REQUESTS_2026-09-08.md`).
