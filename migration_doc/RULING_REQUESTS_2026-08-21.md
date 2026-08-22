# Ruling requests — 2026-08-21

All twelve items below were RULED in session on 2026-08-21 evening (R-2026-08-21-13..24); the text is retained as the decision record. Everything that was blocked on a maintainer decision, consolidated from the six
2026-08-21 campaign audits and the day's landings. Each item carries a
recommendation with its costs stated. Items 1-2 are the C14 critical path.

## 1. G3 celestial gate: the 4096 bake + HDR check (manual session)

**RULED 2026-08-21 evening -> `R-2026-08-21-13` in `MAINTAINER_RULINGS_2026-08-21.md`.**

**Question.** The G3 gate now honestly FAILS at the shipped 2048 asset against
the ratified >= 2700 px bar (SOL-2 landed Batch 1107). Only the ruled manual
maintainer session - bake/bundle the 4096 faces, run the HDR-hardware check -
can turn it. Discharges C12-12's tier item and C12-28 in one sitting (R-7
batches them).
**Recommendation: schedule the session.** It is the largest single step toward
C12 closure that no agent can take.
**Pros:** unblocks G3 + C12-12 + C12-28 together; the gate and probes are ready
and will score it honestly the same day. **Cons:** maintainer time (~one
session); 4096 assets grow the repo/bundle; if the bake tooling fights back the
session could spill.

## 2. G1 sky-atmosphere shell-extent: rule CLT-D10 or accept-red-at-close

**RULED 2026-08-21 evening -> `R-2026-08-21-14` in `MAINTAINER_RULINGS_2026-08-21.md`.**

**Question.** G1 is RED on `NEW-WEBGPU-SKYATMOSPHERE-SHELL-EXTENT-ALPHA`, whose
canonical answer is owned by unlaunched C17 (CLT-D10). C12 cannot reach this
from inside. Options: (a) rule the shell-extent question now, out of band;
(b) explicitly accept "G1 stays red at C12 close" with the red carried forward
to C17.
**Recommendation: (b) accept-red-at-close.** The measured red is preserved
honestly; C17 owns the physics decision and will inherit a well-documented
defect rather than a rushed convention.
**Pros:** removes G1 from the C12 critical path today; no risk of pre-empting
C17's light-transport design; the red stays visible. **Cons:** C12 closes with
a known cosmetic defect; a later C17 fix may re-open celestial acceptance
imagery for re-baseline.

## 3. C12-33 moon-mip: sign-test-v1 vs the ruled sixteen-cell design

**RULED 2026-08-21 evening -> `R-2026-08-21-15` in `MAINTAINER_RULINGS_2026-08-21.md`.**

**Question.** The shipped, custody-hashed design is a four-cell SIGN TEST with
an absolute 1e-9 gate (`sign-test-v1`, Batch 1100). The ruling text described a
sixteen-cell ratio design with a pre-registered correlation `r` that does not
exist anywhere in shipped source (worker refutation, accepted). Options:
(a) bless sign-test-v1 as the design of record; (b) supply `r` and order the
sixteen-cell implementation.
**Recommendation: (a) bless sign-test-v1.** It is implemented, custody-bound,
mutation-pinned, and the 2.5-hour Edge ten-run set can start the same day.
**Pros:** immediate unblock of the C12-33 acceptance (2.5 h machine time,
already scripted); no invented statistics - the hash binds what actually runs.
**Cons:** the sign test is coarser than the ratio design (detects direction,
not magnitude, of mip drift); if magnitude sensitivity is ever needed the
sixteen-cell build becomes new work with a new custody hash (designId bump
makes that visible, by design).

## 4. In/out-of-gate calls for the C12 exit (four small decisions)

**RULED 2026-08-21 evening -> `R-2026-08-21-16` in `MAINTAINER_RULINGS_2026-08-21.md`.**

- **C11-79 (celestial retained resources, partial):** membership in the C12
  exit gate is stated nowhere. **Recommend OUT** - it is a perf rider, not
  appearance correctness; track in C11. Pro: shrinks the gate to what the gate
  is about. Con: a retained-resource leak on celestial paths would outlive C12.
- **C12-26 (earth-limb airglow, not started, M-L):** **Recommend OUT (defer to
  C17)** - it is new light-transport physics, exactly C17's charter. Pro: keeps
  C12 closeable; the W6 row said "file, don't fold". Con: the limb stays
  visually plain until C17.
- **C12-31-FOLLOWUP-A/B/C (aureole refinements):** **Recommend OUT** for A/B/C
  with the C12-31 acceptance sweep still IN. Pro: the sweep proves the shipped
  aureole; refinements are additive. Con: findings #4/#6 remain open in-source.
- **C12-11 (star-catalog run; packet HELD on ten architecture blockers):**
  **Recommend OUT of the exit gate** - rule that C12 closes on the shipped
  starfield with the rebuilt harness (landed tonight) remaining the instrument
  of record for a post-C12 certification. Pro: ten architecture blockers stop
  gating an entire campaign. Con: the star catalog ships uncertified until the
  packet resumes; the HELD state must stay visibly recorded.

## 5. C15-G9 tower frame-variance: the escalation the ruling already ordered

**RULED 2026-08-21 evening -> `R-2026-08-21-17` in `MAINTAINER_RULINGS_2026-08-21.md`.**

**Question.** `R-2026-08-10-7` escalates any structural line older than 30
batches to the maintainer queue. `C15-GSPLAT-TOWER-FRAME-VARIANCE` has been
STRUCTURAL since Batch 916 - ~191 batches. The G9 discriminator harness (D1-D5)
is being authored today; the machine lane can run it immediately after landing.
**Recommendation: acknowledge the escalation and authorize the G9 run as the
disposition.** No design decision is needed yet - D1 (N reads of one frozen
frame) decides whether the variance is instrument noise before any deeper call.
**Pros:** converts an aging embarrassment into a scheduled measurement; the
0.050% bar stays pinned. **Cons:** none material - the alternative is the
clock keeps running.

## 6. C16-20 exit gate vs the grandfather file

**RULED 2026-08-21 evening -> `R-2026-08-21-18` in `MAINTAINER_RULINGS_2026-08-21.md`.**

**Question.** The C16 exit demands CENSUS = 0, but the grandfather file
currently parks 187 findings on clean-listed paths - the gate can read green
while 187 markers ship. Options: (a) add an "empty grandfather file" clause to
C16-20; (b) rule an accepted-residue set explicitly.
**Recommendation: (a) empty-grandfather clause.** The file's own design is
shrink-only toward zero; today's three shards retired 5 rows in the normal
course of work.
**Pros:** the exit means what it says; no privileged residue class to audit
forever. **Cons:** C16-20 moves further out by however long the remaining
44 rows take (they retire naturally as their files' shards land, so the real
added cost is small).

## 7. C16-02c: the build-ts `.d.ts` lane in/out call

**RULED 2026-08-21 evening -> `R-2026-08-21-19` in `MAINTAINER_RULINGS_2026-08-21.md`.**

**Question.** The `.d.ts` surface fails the C16 marker standard but is not in
the shipped-comment path the campaign targets; the lane has sat unruled.
**Recommendation: IN, as a late shard** (after P4-P9), because `.d.ts` files
are read by downstream TypeScript consumers - they ARE shipped documentation.
**Pros:** the standard stays coherent ("everything a consumer reads").
**Cons:** one more M-sized shard before C16-20.

## 8. U2 regression disposition (informational; default path already ruled)

**RULED 2026-08-21 evening -> `R-2026-08-21-20` in `MAINTAINER_RULINGS_2026-08-21.md`.**

**Fact.** The completed A/B campaign scores the landed U2 morphology at ~+5%
shadow map, +2-12% cumulus full-res march, +9-19% cascade atlas (cirrus march
cheaper; pixels byte-identical - static register pressure). The row's
acceptance is RED; C13-39B (variant split) is the named containment vehicle.
**Recommendation: no new ruling needed** - the standing framework (land
correctness with disclosed cost, file the containment) is being followed. Flag
only if you want the U2 visuals default-OFF until C13-39B lands; the fork's
performance principle ("never default-disable a feature to win a metric") says
leave it ON, and that is what is landing.

## 9. The provisional R-2026-08-21 batch: ratification checkpoint

**RULED 2026-08-21 evening -> `R-2026-08-21-21` in `MAINTAINER_RULINGS_2026-08-21.md`.**

The eleven amendment adoptions were provisional ("give the recommendations an
honest shot"). Evidence so far: A1 (precedence order) landed under non-author
review and is holding; C1/C3 executed; A2's launcher/guard slice landed with
one declared deviation (guard scoping) and one integration correction (the
bounded advisory); the picking answers remain unexercised until the
architecture resumes. **Recommendation: leave provisional until the picking
programme (B1-B5) runs under them, then ratify in one pass.**

## 10. 3D Tiles extension workstream (separate track, still open from B1057)

**RULED 2026-08-21 evening -> `R-2026-08-21-22` in `MAINTAINER_RULINGS_2026-08-21.md`.**

Decision 23 (adopt the `3DTiles_temporal` transition vocabulary) wants a
conscious yes/no; the reframed title/abstract wants a read; wave B (fix pass
over the 51 surviving audit findings) wants scoping. **Recommendation: batch
all three into one sitting when the fork campaigns are quieter; nothing in the
fork blocks on them.**

## 11. License baseline: the fork is Apache-2.0, not MIT (verified 2026-08-21)

**RULED 2026-08-21 evening -> `R-2026-08-21-23` in `MAINTAINER_RULINGS_2026-08-21.md`.**

**Fact, orchestrator-verified:** `LICENSE.md`, `packages/engine/LICENSE.md`, and the root
`package.json` (`"license": "Apache-2.0"`) all state Apache-2.0 — upstream CesiumJS's
license, inherited by the fork. Several migration docs and queue rows instead assert an
"MIT repo" baseline (e.g. the `C11-178` star-map asset row and both C14/C15 reference
plans), and the new `LICENSE_VETTING_AURORA_OCEAN_2026-08-21.md` (109 determinations)
was authored against that stated-MIT baseline and surfaced the contradiction itself.
**Question.** Confirm Apache-2.0 as the operative baseline for all external code/asset
intake decisions.
**Recommendation: confirm Apache-2.0.** It is what the repository actually ships. The
practical effects are mild and mostly relaxing: MIT/BSD/PD sources remain intake-eligible
(with NOTICE-file attribution obligations Apache-2.0 carries that MIT does not), copyleft
and NC/SA sources remain disqualified either way, and the vetting doc's conservative
verdicts stay valid as ceilings — a re-baseline pass over its 109 rows can only soften,
never tighten, and should be run before any C14/C15 intake begins.
**Pros:** removes a false premise from every future license decision; unblocks the
determinations that were held solely on MIT-vs-Apache framing. **Cons:** one editing pass
over the vetting doc and the handful of "MIT repo" queue rows; NOTICE-file discipline
becomes an explicit obligation on every intake.
**Follow-up riding this ruling (station-3 review, deferred edits):** the vetting doc's
softening pass should also fold in the review's quality items — register evidence on
O-37/O-39 plus the ocean plan's own §4-vs-§5 self-contradiction on dli/waves and
EncinoWaves; O-25/O-23 recording the plan's fetched-license ✔-upgrades with the hold
scoped to the OTFFT sub-component; four considered-and-excluded or new not-adopted rows
(EGM2008, Cesium World Terrain, grib2json, the 10cm-flux endpoint and GOES secondary
feed); the A-16/O-46 one-source-two-campaigns note; the GRIB2/NetCDF dedupe rationale;
and the S-09 transitive-attribution wording.

## 12. SOL-4: the WebGPU refresh cost is below the wall-clock sweep's resolution

**RULED 2026-08-21 evening -> `R-2026-08-21-24` in `MAINTAINER_RULINGS_2026-08-21.md`.**

**Fact (two runs, 2026-08-21 evening, attestable bundle, repaired gate).** WebGL banks
3.342 / 2.714 ms per refresh. WebGPU cannot be attributed: the no-refresh control leg is
consistently SLOWER than the eclipse leg (5982 vs 5418 ms; 5092 vs 4958 ms over 801
frames), so the interleaved ABBA differential is negative and the probe refuses to print
a cost - by design. Both WebGPU legs run ~6.5 ms/frame (WebGL ~1.2); the historical
1.607 ms/refresh would be ~440 ms, inside the 134-564 ms drift. The busy-leg-faster sign
is what a GPU power-state down-clock on the idler leg produces.
**Question.** R-2026-08-14-1 made a banked fresh refresh cost an operative C13-41 exit
prerequisite, so the instrument is ratified and the orchestrator cannot change it alone.
Options: (a) re-instrument the cost lane on GPU timestamp queries (the repository's
`gpuPassCost` path) so the fills' GPU time is measured directly, with the same
pre-registered sweep and both-backends-valid rule; (b) rule the WebGPU refresh cost
unmeasurable by wall clock at this fixture's frame cost and accept the WebGL figure
plus the WebGPU negative-differential record as the banked artifact; (c) both - bank (b)
now and run (a) as the durable instrument.
**Recommendation: (c).** (b) unblocks the C13-41 exit chain on honest evidence today;
(a) is the only instrument that can ever resolve a ~1.6 ms effect under a ~6.5 ms frame.
**Pros:** the critical path moves without inventing a number; the durable instrument is
the right one. **Cons:** (a) is S-M of probe work plus a delta review; (b) leaves the
WebGPU cost as a bound, not a figure, in the ledger until (a) runs.
