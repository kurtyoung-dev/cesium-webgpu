# Maintainer rulings — 2026-08-28

**Authority and character.** Two rulings were taken in session on 2026-08-28 at approximately
06:12 ET, at the close of the wave-3 fix campaign against `main` @ `af9c42a052` (Batch 1212),
in answer to the two questions the W3-A prototype lane returned with its stage-1 packet
(recorded in [AUDIT_2026-08-27_SOL_WAVE_AND_PROJECT_SWEEP.md](AUDIT_2026-08-27_SOL_WAVE_AND_PROJECT_SWEEP.md)'s
wave-3 close). They are **operative**, per the convention of the prior rulings files.

**Add-only.** Ruling IDs are never renumbered or reused. Supersessions are stated inside the
superseding ruling's own section and nowhere else.

**Scope note.** This file is the record. The R9 preregistration remains the frozen execution
authority for the prototype repair wave; these rulings direct how it is amended, and nothing
here silently rewrites its frozen text.

---

## R-2026-08-28-1 — The unmasked arity defect is HELD for a full R9 amendment round

**Question.** W3-A's preregistered gate separation (P-8) exposed a pre-existing defect the
source gate had masked for the prototype's entire recorded life: three call sites pass a
zero-arity reader to a two-pass API whose validator requires arity one, so neither pass ever
ran. R9 §1 freezes P0B-21 as permanently red on the explicit premise that "both tests stopped
at the 820-line gate before behavioural adjudication" — a premise the separation has now
falsified by measurement. With the one-line arity correction, P0B-21 passes for the first time
in its recorded history (proven in a derived image with a pristine-tree control; nothing
landed). The fix sits outside R9's sixteen preregistered repair rows.

**Ruling: hold.** The fix does not land until a review-round amendment re-freezes R9 with the
corrected premise. The maximally conservative option was chosen deliberately: the campaign's
value rests on the preregistration discipline, and a frozen "permanently red" scoring row does
not flip to green through the landing seat, however decisive the isolating control. The
amendment round follows the same reviewer pre-commitment pattern the R9 convergence loop used.

**Consequences, stated so nobody re-derives them wrongly later:**

- Stage 2 proceeds around the held fix. `R9A-20`'s 360/360 terminal figure is unreachable
  until the amendment lands; interim stage-2 packets report against the pre-amendment
  expectation and say so.
- The defect's isolation evidence (pristine-spec-against-pristine-helpers control reproducing
  `0 !== 2`, and the derived-image green) is banked with the W3-A stage-1 packet and MUST NOT
  be re-derived from scratch by the amendment round — it is the amendment's exhibit.
- P0B-22 is untouched by this ruling: its red has a separate cause inside the mutation
  machinery and stays governed by R9's frozen text.

## R-2026-08-28-2 — P-1 reads raw bytes by extending SPEC_IMPORTS, with the topology pin moved in the same amendment

**Question.** R9 §4 requires the provenance-core spec to walk all 31 paths reading raw
Buffers, but the spec has no `node:fs` import and its import list is pinned to exactly four
specifiers by both its own source gate and the topology test's exact assertion, while the
file-reading harness is a frozen unchanged anchor. R9 does not say which side gives.

**Ruling: extend the pins, on the record.** `SPEC_IMPORTS` gains `node:fs`, and the topology
assertion is updated to match, both in the same explicit R9 amendment — the two pins move
together or not at all, because a round where one gate admits the import and the other rejects
it certifies nothing. The alternative (routing bytes through the frozen harness) was declined:
the lane did not confirm the harness exposes a raw read, and bending a frozen anchor's usage
to avoid an honest pin change is the wrong trade. The descope option was declined as the
weakest evidence form.

**Sequencing.** Both rulings feed the same amendment round: the round carries the P0B-21
premise correction (R-2026-08-28-1) and the SPEC_IMPORTS/topology extension (this ruling) as
its two exhibits, is reviewed under the pre-commitment pattern, and re-freezes R9 before
stage-2's P-1 arm executes.
