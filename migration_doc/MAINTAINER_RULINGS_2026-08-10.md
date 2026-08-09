# Maintainer Rulings — 2026-08-10

Seven decisions ruled by the maintainer on 2026-08-10, from the decision
brief delivered the same day. **Every alternative option is preserved here
verbatim-in-substance per the maintainer's instruction** ("Document all of
the other options, this we might need to come back to depending on the
success of each sub-item"). Each ruling names its fallback trigger.

> **⚠ DATING NOTE (added 2026-08-09 by the handover-readiness audit, FIX 9) — and the
> global evidence-ordering convention it anchors.**
>
> **These rulings were ruled and landed on 2026-08-08 per `git log`.** The `2026-08-10`
> label in the filename and in every `R-2026-08-10-N` identifier is retained **for ruling-ID
> stability** — those IDs are cited from four campaign queues, `DEFERRED_WORK.md` and the
> close-out plan, and renaming them would break more than it fixes. Read the date as a
> **label, not a timestamp**.
>
> **The convention this anchors, fork-wide: order evidence by BATCH NUMBER, never by printed
> date.** Document and ruling date stamps across `migration_doc/**` run two to three days
> ahead of their git commit dates, are non-monotonic against batch order, and are not even in
> positional order within a single queue document (the C12 queue carries `2026-08-11` stamps
> on batches that landed 2026-08-08). Batch numbers are global, monotonic and never reused —
> they are the spine of the entire evidence system. When ordering matters, confirm against
> `git log`. Recorded in [`ORCHESTRATION_HANDBOOK.md`](ORCHESTRATION_HANDBOOK.md) §6 as a
> [HARD] rule.

---

## R-2026-08-10-1 — C12-29 scope vs. the C12 exit gate: **Option B, maximal gate**

**Ruled:** C12 stays open until every C12-29 slice lands, including S3
(clouds+IBL eclipse response, canonically owned by `C13-41`). "Lets keep
working towards this."

**Consequence:** C14 (Dynamic Ocean & Wind) remains blocked on C12
completion, which now transitively includes `C13-41`. **`C13-41` is the C14
critical path** and is elevated accordingly; the S4 remainder
(orbital-sunrise limb glow) and S5 verification (umbra vs. NASA shapefiles)
are active queue work, not deferrals.

**Documented alternative (fallback):** Option A — narrow the gate to
S1/S2/S4/S6, transfer S3 formally to C13-41, close C12 and unblock C14
early. *Trigger to revisit:* if C13-41 stalls long enough that C14's absence
costs more than the totality-consistency gap Option A accepts. Option C
(re-file S3/S4 as C13 rows and close C12-29) remains the ledger-cleanest
variant of A.

---

## R-2026-08-10-2 — §5 limb-darkening band: **Option A, conditional**

**Ruled:** Re-ratify the band against the shipped physics via the disc-only
measurement arm — **conditional on first confirming the shipped physics is
as accurate as possible while remaining performant.**

**Work this creates (in order):** (1) a verification batch on
`SolarDiscModel` — limb-darkening law and coefficients audited against
astrophysical references, radiance derivation re-checked, plus a performance
accounting (bake cost, per-frame cost) proving the accuracy is free or
cheap; (2) only then, the disc-only band re-derivation lands in the G4 gate
and §5 is re-ratified with the derivation written down.

**Documented alternatives (fallbacks):** Option B — raise the radiance until
the composite ratio enters [0.3, 0.5] (L≈3–5); rejected because display
limb contrast is strictly decreasing in radiance (101 codes at L=1 → 18 at
L=3) — satisfying the number destroys the feature it measures. *Trigger:*
if the physics audit finds the shipped law inaccurate in the direction that
higher radiance would fix. Option C — accept a standing red; rejected as
gate-rot. *Trigger:* none foreseen.

---

## R-2026-08-10-3 — WebGL sun-bloom parity: **Option A, mirror it**

**Ruled:** Implement a WebGPU sun-bloom equivalent (bright-pass on the sun
region feeding the existing post-process chain) so both backends carry the
effect at defaults. This supersedes the orchestrator's recommendation
(Option B, default-off).

**Consequence:** new row `C12-34` (WebGPU sun-bloom mirror). Expected to
clear the G4 `webgl:limb_shape_matches_shipped_law` watch-red by removing
the cross-backend spread at its source (both backends bloomed, the
disc-only limb arm untouched). Gate membership follows the C12 queue's
standing exit-gate definition; this ruling does not itself add it to the
gate.

**Documented alternatives (fallbacks):** Option B — default WebGL's
`SunPostProcess` bloom off, making the C12-18 screen halo the single shared
glow source (small change, but departs from upstream WebGL's default look).
*Trigger:* if the mirror proves expensive or visually double-counts with
the C12-18 halo in a way tuning cannot reconcile. Option C — accept and
bound the ~8% spread. *Trigger:* only as a stopgap while A is in flight.

---

## R-2026-08-10-4 — Star map: **Option A, 4096 re-bake — with fallbacks staged**

**Ruled:** Re-bake the star cubemap at 4096/face and re-run G3. "Lets give
Option A a shot but document the other options in case this misses."

**Decision protocol:** if the 4096 bake clears the angular arms but twinkle
still triggers, the asset variable is eliminated and the DR-01 revisit
(sprite-vs-cubemap certification) becomes a clean, single-variable
question. DR-01 is NOT decided until then.

**Documented alternatives (staged fallbacks):** Option B — re-derive the
ratified bars against what the shipped tiers can express (weakest
epistemics; *trigger:* the 4096 bake fails to clear the arms for reasons
inherent to the source catalog, not resolution). Option C — accept the
standing reds until after C16/C14 (*trigger:* the bake's VRAM/download cost
proves incompatible with the C12-12 tier policy and B is unpalatable).

---

## R-2026-08-10-5 — STBN provenance: **Option A, generate our own**

**Ruled:** Build an in-repo STBN generator "from the ground up if we need
to" — void-and-cluster / simulated-annealing per the published algorithms,
as a reproducible build tool with hash-pinned output, plus Fourier-spectrum
validation that our noise matches reference quality. Unblocks `C13-11` and
removes the Gate C provenance blocker. Follows the moon-albedo-bake
pattern (reproducible bake + pin + LICENSE entry).

**Documented alternatives (fallbacks):** Option B — NVIDIA's reference STBN
textures with attribution (*trigger:* only if a license review clears
redistribution AND our generator's spectrum validation fails). Option C —
ship without STBN (*trigger:* none; the dither is visible and the row is
wanted).

---

## R-2026-08-10-6 — Upstream v1.144 sync: **Option A, sync now**

**Ruled:** "Lets update." The 57-commit sync (1.144 release, screenspace
camera controllers, vector-terrain polygons, FBO cache fix, MVT types, CZML
validation) proceeds immediately, before any C16 rewrite shard, per the
standard sync procedure (safety branch → fetch → merge → resolve preferring
theirs then re-add fork code → verify → push). The C16 audit re-runs cached
against the new base afterward.

**Documented alternative:** Option B — sync after C16 (*rejected:*
guaranteed merge friction across hundreds of freshly rewritten files).

---

## R-2026-08-10-7 — Confirmation cluster: **all recommendations adopted**

- **C16 = Comment Remediation** confirmed; CLT epic renumbers to proposed
  C17.
- **C12-26** (earth-limb airglow) defers out of C12's gate as its own
  future row. *Fallback:* pull back in if a celestial-appearance pass wants
  it bundled.
- **C12-32** (shared ephemeris state) defers into **C14 W1** (it feeds C14
  tides and was sequenced with C12-29 anyway). *Fallback:* if C14 stays
  blocked long (see R-1), it may land standalone earlier — it is
  independent work.
- **C13-16** per-genus mixtures **signed off** with CIRRUS carried as the
  named residual; W3 rows may build on the pair.
- **Exit-3 fleet ruling:** STRUCTURAL exits are **yellow** — every one
  carries a named reason, and any structural line older than **30 batches**
  (FIRST-PASS number, revisable) escalates to the maintainer queue.
  *Fallback:* red-equivalent treatment if yellow proves too permissive in
  practice.
- **4096 bake + HDR-hardware check** batched into one manual maintainer
  session once the bake artifact exists.

---

*Referenced from `DEFERRED_WORK.md` ruling block RULING-2026-08-10 and the
C12/C13/C16 queue stamps of the same date. The full pros/cons text behind
each option is preserved in this document's rulings above; the underlying
evidence sets live in the G3/G4 run stamps and the C12-19/C13-39 ledger
records.*
