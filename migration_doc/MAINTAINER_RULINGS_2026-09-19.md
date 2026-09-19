# Maintainer rulings — 2026-09-19

Taken 2026-09-19 ~00:40 EDT, in **one sentence covering fifteen questions**. The questions are
`Q0` … `Q14` of the Campaign 12 close-out plan's §4 "Maintainer items"; the plan is tracked as
[`C12_CLOSEOUT_PLAN_2026-09-19.md`](C12_CLOSEOUT_PLAN_2026-09-19.md), landed with this file because
a tracked ruling may not rest on an untracked basis. Ruling ids are `R-2026-09-19-1` … `-15` and map
one-for-one onto `Q0` … `Q14`.

**The maintainer's words, verbatim:** *"For all the current questions with recommendations use the
recommendations"*.

**Every one of the fifteen is therefore the plan's own RECOMMEND text, adopted as written**, and
each entry below **quotes that text verbatim** from the plan's §4 rather than paraphrasing it. The
entries add three things the sentence does not: the question the recommendation answers, stated
faithfully; what the recommendation's basis is; and what would have to happen for the ruling to be
executed.

**Three of the fifteen are OWED BY THE MAINTAINER and cannot be executed by any lane** —
`R-2026-09-19-8` (the `C12-33` countersign), `R-2026-09-19-9` (the `C12-28` HDR-display check) and
`R-2026-09-19-10` (the Tycho-2 licence determination and the fetch-path scheduling). Accepting the
recommendation on those three **settles what is to be done and by whom; it does not perform the
sitting.** They are the maintainer's own list, and they stay open until the sittings happen.

**One carries a rider that must be answered first.** `R-2026-09-19-7` adopts the `C12-33` banking
route **after** the rider in its own recommendation is answered — why all 18 banked
`c12-33-moon-mip-motion` publications read `NON_CERTIFYING / exit 3 / eligible false` while the
certification folded from them reads `PASS / 0 / true`. The banking route is not built before that
answer exists.

**Provenance.** The maintainer's sentence and the mapping of each ruling to its question come from
the seat's source sheet, banked at
`cesium-webgpu-worker-archive/lanes-2026-09-19/rulings-source/rulings-source-2026-09-18-19.md`. The
plan itself was produced by a read-only scoping workflow — readers Nora, Nina, Peony and Angelica,
synthesis Lily, critic Noakes, for the Fable seat (Gandalf) — and its four reader reports and the
critique are banked at `cesium-webgpu-worker-archive/lanes-2026-09-19/c12-closeout/`.

Recorded 2026-09-19 by the record lane (Hamson).

---

## R-2026-09-19-1 — Q0: the gate library may be repaired on the ruling's tree, with served-bundle byte-identity asserted

**The question.** The standing brief for the `C13-41` discriminator says, verbatim at its line 35,
*"Never edit the probe or the gate module"*. The deck-free control repair edits the gate module. It
is a **Node-side scoring** change: applied as an overlay onto the Bandobras clone it leaves the
served engine bundle byte-identical (`Build/CesiumUnminified/Cesium.js` md5
`ea4d26a1f266d76da0cbfc7d4d0617d9`, re-verified 2026-09-19), so the measurement is still taken on
the engine `R-2026-09-13-1` names. *May the instrument be repaired on the ruling's tree, provided
the served engine bundle is byte-identical?*

**The recommendation, adopted as written** (plan §4, Q0, quoted verbatim):

> **Recommend: yes, with the byte-identity asserted in the preflight and quoted in the receipt.**
> Without it, any run of leg (e) fires red trigger 2 with certainty
> (`lib/c13-41-deckfree-control.mjs:348` vs the bundle's `DirectionalLight2`, both re-verified
> 2026-09-19) and the campaign closes on an esbuild rename.

Basis: the plan's §1 and its risk R2 — the gate demands `side?.constructorName === kind` against the
literal `"DirectionalLight"` while esbuild emits `DirectionalLight2`, and the spec that should have
caught it **synthesises** the field instead of observing a bundle. The repair's scope is one
Node-side scoring file; the byte-identity assertion is what keeps the ruling's tree the tree the
measurement is taken on.

Executed: **NOT YET.** Executed by the deck-free repair lane (`S3-N1-DECKFREE`) landing with its
overlay confined to the Node-side gate library, and by any re-issued Edge brief for leg (e)
asserting the served-bundle md5 in its preflight and quoting it in the receipt.

Authority: charter §1.1.

---

## R-2026-09-19-2 — Q1: `R-2026-09-13-1`'s condition is satisfied by the banked 2026-09-03 sweep; an exit 2 or exit 3 fires neither arm

**The question.** `R-2026-09-13-1` is conditional on "tonight's re-run", and that re-run never
happened. But the sweep it re-decides **did** run, on the same tree, with a byte-identical
instrument, and it is banked: `shadowContrastInvariant: false`, `shadowContrastRatioAtDeepest:
1.0341102079879674`, nine unscored predicates, sixteen constructor-name structural reasons. Two
sound readings: **(i)** the ruling means a *fresh* run and one must be taken; **(ii)** the
condition is **already satisfied** by the 2026-09-03 sweep, and what was actually owed is the
deck-free repair. A third outcome is unaddressed by the ruling's own text: *which arm does an exit 2
or exit 3 fire?*

**The recommendation, adopted as written** (plan §4, Q1, quoted verbatim):

> **Recommend (ii), with (i) as a cheap confirmation afterwards if wanted.** Under (ii) ARM RED
> fires tonight on evidence already in hand and C14 unblocks a week earlier. And answer the **third
> outcome** in the same line: a run with `shadowContrastInvariant` in band, the control lane scored,
> and the WebGPU refresh-cost drain failing again calls `markBlind("refresh-cost")` and exits
> **3 STRUCTURAL** — neither red trigger, not a PASS. *Which arm does an exit 2 or exit 3 fire?*
> **Recommend: neither** — bank it, re-run once after `S3-N2-REFRESHCOST` lands; a second structural
> result fires Option C on the ground that the instrument cannot answer at honest cost.

Basis: the plan's §1 and §6 — with a byte-identical instrument on a byte-identical engine, a literal
re-run is a **repeat measurement**, not a new observation, and red trigger 1 is already on disk at
the ruling's own tree. The plan's §3 stop rule still binds the other direction: a receipt in band on
`shadowContrastInvariant` but blind on the deck-free lane is banked and stops **before** the arm is
executed.

Executed: **NOT YET.** Executed by the Option C close batch (plan §6a), taken after the offline
re-score `S3-N1b-RESCORE` has disposed of trigger 2 on the same banked evidence. The optional
~45-minute confirming run under reading (i) is not a precondition of it.

Authority: charter §1.1.

---

## R-2026-09-19-3 — Q2: leg (e), if it is run, runs on `ea651de6d8`

**The question.** `R-2026-09-13-1` names the tree `ea651de6d8`; the tip is thirty-one batches ahead,
and Batch 1504 deleted the aerial term the deck pre-registrations were fitted to. *Which tree does
leg (e) run on?*

**The recommendation, adopted as written** (plan §4, Q2, quoted verbatim):

> **Recommend: `ea651de6d8`, unchanged from v1 and strengthened.** Exact ruling fit, zero build, and
> it keeps the pre-registrations intact — at the tip a fresh deck red would be a C13-N20
> consequence, not an S3 finding, and would put an unexplained red into S3's closure record
> permanently. A tip reading is worth having **later**, as its own job, after C13-N20 has its own
> deck pre-registration. Batches 1504/1507/1508 **do not** invalidate banked S3/S4/S5 evidence —
> every banked run is stamped to its own tree; what they invalidate is the *tip* as a comparison
> base for S3.

Basis: the plan's Q2 and its risk R4 — the gate library's own mechanism citations already point at
moved lines, and a far-target inscatter branch exists at the tip that did not exist when the
pre-registration was derived.

Executed: **NOT YET.** Executed by whichever run of leg (e) is taken, on `ea651de6d8`; and the tip
reading, when it is wanted, is a **separate, later job** with its own `C13-N20` deck
pre-registration.

Authority: charter §1.1.

---

## R-2026-09-19-4 — Q3: Option C inherits Option A's narrowed gate, and "close C12" carries the remainder forward by name

**The question.** Option C's silence on S5 is not silence: `MAINTAINER_RULINGS_2026-08-10.md` reads
*"Option A — narrow the gate to S1/S2/S4/S6, transfer S3 formally to C13-41 … Option C (re-file
S3/S4 as C13 rows and close C12-29) remains the ledger-cleanest variant of A"* (re-read at the seat
tip: the paragraph runs `MAINTAINER_RULINGS_2026-08-10.md:41-46`, and the "ledger-cleanest variant
of A" clause sits at `:44-46`). *Confirm that reading — and with it that S5 leaves the gate unmet,
at 18 banked runs and 1 PASS, with three of its six lanes carrying no ledger owner.*

The 18 is the plan's own corrected total, not the queue's.
[`QUEUE_2026-07-19_CAMPAIGN12.md`](QUEUE_2026-07-19_CAMPAIGN12.md) still totals *"15 banked / 1 PASS
/ 4 STRUCTURAL / 10 ERROR"* at `:389`, because the table above it (`:382-387`) records dense-cost,
multiview and replacement-device as never executed in a browser — which the plan's finding L-B
measures as stale, three 2026-08-29 artifacts existing. Correcting that table is scoped into the
plan's own step 3 (`REC-7-RECORD`). S5 is unmet on either figure; they differ only in how badly.

**The recommendation, adopted as written** (plan §4, Q3, quoted verbatim):

> **Recommend (a): confirm, and close with every carried item named in the closing statement and
> re-homed explicitly** — S5's lanes and `C12-31`'s sweep into the Edge queue as their own rows;
> `C12-12`'s and `C12-13`'s acceptances beside them; `C12-33` ×2, `C12-28`'s HDR check and the
> licence determination onto the maintainer's own list; `G1`/`CLT-D10`, `C12-11`, `C11-79`,
> `C12-26`, `probe-stars-catalog`, the KTX2 half and the live DR-01 revisit named with their homes.
> Option (b) — close only once they are met — is not a close; it is the maximal gate under another
> name. **Answer this before the Option-C docs batch is written: it determines every word of the
> closing statement.**

Basis: `R-2026-08-10-1`'s own text as quoted above, plus the plan's risk R10 — **anything omitted
from that list is being closed by relabelling** — and risk R6, which is why the re-file must be a
**document act, not a ledger act**: `finding-ownership-audit.spec.mjs` closes the owner state model
over `{active, closed, reopened}` and asserts every owner's `reference` string still appears in the
document it names.

Executed: **NOT YET.** Executed by the Option C close batch (plan §6a), whose acceptance is that
`CAMPAIGN_STATE.md`'s C12 block reads CLOSED with a dated ruling id **and carries risk R10's list in
full**.

Authority: charter §1.1.

---

## R-2026-09-19-5 — Q4: Option C lifts the `R4` aurora hold; the contact-sheet condition is a sequencing preference, not a second hold

**The question.** Option C's red arm says "release the aurora R4 hold"; `R-2026-09-17-9` routes
`C15-03`…`C15-08`, `C15-06P` and `C15-07H` through *"a later one-line ruling once the contact sheet
exists (DX-105)"*, and `DX-105` has not landed. The two texts read as contradictory. *Which one
governs?*

**The recommendation, adopted as written** (plan §4, Q4, quoted verbatim):

> **Recommend:** Option C lifts the **R4 hold**; the contact-sheet condition is a *sequencing*
> preference for the rows that need something to iterate on, not a second hold. Say which, because
> the two texts currently read as contradictory.

Basis: `R-2026-09-17-9`'s own construction — it is a **narrow override of `R4`'s literal text for
two named rows**, taken while `R4`'s condition was unmet, and its contact-sheet clause exists for the
rows that are **judged** under `R-2026-09-17-10` rather than measured. Once `R4`'s condition is
discharged by the close itself, that clause is left governing sequence, not permission.

Executed: **NOT YET.** Executed by the Option C close batch, which rewrites the remaining
`HELD (R4)` cells in [`QUEUE_2026-08-02_CAMPAIGN15.md`](QUEUE_2026-08-02_CAMPAIGN15.md) and the
matching text in [`CAMPAIGN_STATE.md`](CAMPAIGN_STATE.md) §C15. `C15-05` and `C15-06` are **already
out from under the hold** by `R-2026-09-18-1`
([`MAINTAINER_RULINGS_2026-09-18.md`](MAINTAINER_RULINGS_2026-09-18.md)) and are not waiting on this
ruling.

Authority: charter §1.1.

---

## R-2026-09-19-6 — Q5: C14 is UNBLOCKED, NOT LAUNCHED

**The question.** `RULING-2026-08-06` R1 makes C12 completion C14's sole remaining bar, and
`CAMPAIGN_STATE.md` records C14 as "Not launched" with a ratified identity and plan. No ruling in
the set launches it. *Does closing C12 unblock C14, or launch it?*

**The recommendation, adopted as written** (plan §4, Q5, quoted verbatim):

> **Recommend: unblock only.** Launching has always been a separate directive here (C16, C18).
> Record C14 as UNBLOCKED / NOT LAUNCHED — C13 v2, the Gemini fix waves and the probe kit are all in
> flight.

Basis: the plan's Q5, and the house convention it cites — a campaign launch is a maintainer
directive of its own, as C16 and C18 both were.

Executed: **NOT YET.** Executed by the Option C close batch, whose acceptance includes
`CAMPAIGN_STATE.md`'s C14 block reading **UNBLOCKED / NOT LAUNCHED** and `git grep -n "sole
remaining bar is"` returning nothing pointing at C12.

Authority: charter §1.1.

---

## R-2026-09-19-7 — Q6: `C12-33` debt (a) — the schema gains `runId` and the custody hash is re-stamped, AFTER the rider is answered

**The question.** The `C12-33` certification reads `status PASS / exitCode 0 / certificationEligible
true / designId sign-test-v1` and **has no `runId` key at all**, while the evidence library's
`assertFinalArtifact` fails any `kind:"run"` publication whose `artifact.runId !== options.runId`.
Sound options: **(i)** extend the schema with `runId`, which **changes the artefact's sha256** and so
requires the custody hash stamped in the queue to be re-stamped in the same act; **(ii)** publish
under a kind that does not assert it; **(iii)** accept the certification as formally unbanked with
the reason recorded. *Which banking route?*

**The recommendation, adopted as written** (plan §4, Q6, quoted verbatim):

> **Recommend (i) plus a re-stamp** — a small Node lane and a re-bank of the existing artefact, no
> re-run. **But answer the rider first:** all 18 banked `c12-33-moon-mip-motion` publications read
> `NON_CERTIFYING / exit 3 / eligible false` while the certification folded from them reads
> `PASS / 0 / true`, and the 2026-08-25 audit says that *"should be answered before a banking route
> is chosen"*.

**The rider is a precondition, not a footnote.** No banking route is built until there is a written
answer to why eighteen non-certifying publications fold into a certifying result. A route built
before that answer would bank the discrepancy rather than resolve it.

Basis: the plan's Q6, resting on the parsed key set of the certification artefact and on the
2026-08-25 audit's own sentence.

Executed: **NOT YET, and blocked on its own rider.** Executed by a small Node lane that extends the
schema with `runId`, re-banks the existing artefact without a re-run, and re-stamps the custody
hash in the same act — **after** the rider is answered in writing.

Authority: charter §1.1.

---

## R-2026-09-19-8 — Q7: `C12-33` debt (b) — the countersign is one maintainer sitting · **OWED BY THE MAINTAINER**

**The question.** `review-attestation-20260824b.json` carries `verdict PASS` and a `reviewer.identity`
that reads, verbatim, `"opus-5-station-3-seam-review-pattern-v4-maintainer-countersign-owed"` — a
self-asserted automated label. Each of its three findings states the countersignature is OWED. *How
is it cleared?*

**The recommendation, adopted as written** (plan §4, Q7, quoted verbatim):

> **Recommend:** one sitting — read the three findings against the named samples (00/06/12 on WebGL,
> 06 on WebGPU) and sign; the signature binds to the sha256 above. No machine work clears this one.

Basis: the attestation's own reviewer identity and its three findings, each of which names the
countersignature as owed.

Executed: **NOT EXECUTABLE BY ANY LANE — this is the maintainer's own list.** Adopting the
recommendation settles **what** clears the debt and **who** clears it; it does not perform the
sitting. The debt stays open until the maintainer reads the three findings against the named samples
and signs, with the signature bound to the attestation's sha256.

Authority: charter §1.1.

---

## R-2026-09-19-9 — Q8: `C12-28`'s HDR check is one maintainer sitting on real hardware · **OWED BY THE MAINTAINER**

**The question.** `C12-28`'s manual HDR-hardware check is named in the C12 queue's own W4 gate row
and is unreachable by any probe: headless Edge reports the opposite and there is no CDP override for
`dynamic-range`, so a probe could only exercise the SDR leg — which is required to be byte-identical
and would pass with the feature reverted. *How is it discharged?*

**The recommendation, adopted as written** (plan §4, Q8, quoted verbatim):

> **Recommend:** a sitting on a real HDR display — confirm `scene.highDynamicRange === true`
> untouched, then that `hdrDisplayPolicy = 'scene-and-canvas'` produces a correct extended-range
> image on WebGPU.

Basis: the plan's Q8 — the SDR leg is a byte-identity requirement and therefore cannot discriminate
the feature from its absence, which is exactly why a probe cannot stand in for the sitting.

Executed: **NOT EXECUTABLE BY ANY LANE — this is the maintainer's own list.** Accepting the
recommendation fixes the protocol of the sitting; the sitting itself has not been taken, and no
probe may be written to manufacture a number in its place (`R-2026-09-17-10`).

Authority: charter §1.1.

---

## R-2026-09-19-10 — Q9: the Tycho-2 licence determination and the fetch path · **OWED BY THE MAINTAINER**

**The question.** `R-2026-09-02-7` makes the licence determination, **together with a fetch path**,
the release condition for the 4096 star tier: the twelve JPEGs and the policy file *"stay
uncommitted until the fetch path and a licence determination … exist"*. **The fetch path is NOT
BUILT**, and the held files are live in the seat working tree — `SkyBoxResolutionPolicy.ts` and
`skybox-resolution-policy.spec.mjs` modified, twelve `tycho2t5_80_[diffuse_]4096_*.jpg` untracked.
*Is the determination made and the fetch path scheduled, or does the tier stay uncommitted?*

**The recommendation, adopted as written** (plan §4, Q9, quoted verbatim):

> **Recommend:** make the determination and schedule the fetch path, or record that the tier stays
> uncommitted indefinitely and strike it from C12's close set. **Do not let any step's acceptance be
> met by stashing these files** to produce an empty `git status --porcelain` (see step 7).

Basis: `R-2026-09-02-7`'s own two-part condition, and the measured state of the tree — the fetch path
does not exist and the files are held.

Executed: **NOT EXECUTABLE BY ANY LANE — this is the maintainer's own list.** The determination is
the maintainer's; the fetch path is schedulable only once it is made; and the alternative — the
explicit "stays uncommitted indefinitely" record, struck from C12's close set — is equally the
maintainer's to state. **The anti-stashing clause binds every lane immediately:** no step's
acceptance may be met by stashing the held files to produce an empty porcelain, and a clean-tree
reading is taken in a throwaway clone instead.

Authority: charter §1.1.

---

## R-2026-09-19-11 — Q10: `C12-38` is OUT of the exit gate, filed as a follow-up row with its measured red visible

**The question.** The `C12-38` row says "not in the current C12 exit gate **until triaged**". Triage
happened 2026-08-25, the option-A fix landed, and **no ruling records the in/out call**. Its
acceptance ran 2026-09-03 and FAILED — exit 3 then exit 1; chroma:webgpu 0.9659 below the 0.9677 bar,
parity 0.0233 above the 0.02 bar, disc-centre luminance WebGL 0.971–0.976 against WebGPU 0.310–0.323.
*In or out?*

**The recommendation, adopted as written** (plan §4, Q10, quoted verbatim):

> **Recommend: OUT**, filed as a C17/follow-up row with its measured red visible.

Basis: the plan's Q10 and the measured acceptance failure it quotes. Filing it with the red
**visible** is the operative half — an out-of-gate row whose red is invisible is closed by
relabelling, which risk R10 forbids.

Executed: **NOT YET.** Executed by the Option C close batch, which files `C12-38` as a C17 /
follow-up row carrying those measured numbers.

Authority: charter §1.1.

---

## R-2026-09-19-12 — Q11: `C12-36`'s star-pixel leg is IN as a named follow-up, OUT of the gate

**The question.** `C12-36` is not in the C12 queue's OPEN list at all, yet the row says it remains
incomplete and `FEATURE_INVENTORY.md` carries it as acceptance-open. *Is its star-pixel leg in the
gate?*

**The recommendation, adopted as written** (plan §4, Q11, quoted verbatim):

> **Recommend:** one line either way, like `R-2026-08-21-16` did for the other four. My suggestion is
> **IN as a named follow-up, OUT of the gate** — the remaining work is a filed diagnostic, not a
> re-run.

Basis: the 2026-08-25 audit stamp, which establishes that the star chain carries zero non-comment
change between `c810dbace2` and HEAD — so a bare re-run reproduces exit 3 and the remaining work is
a diagnostic that says **why** the star-pixel leg is unreachable in terms of a measured quantity.

Executed: **NOT YET.** Executed by the Option C close batch naming `C12-36`'s star-pixel leg as a
follow-up row outside the gate, and by the `C12-36` diagnostic row itself when it is taken.

Authority: charter §1.1.

---

## R-2026-09-19-13 — Q12: `C12-13`'s "EDGE ACCEPTANCE OWED" banner is stale; EXIT-4 rides the Node spec

**The question.** The `C12-13` cell carries an "EDGE ACCEPTANCE OWED" banner while the gate the same
cell names is the Node spec `solar-glare-star-washout.spec.mjs`, at 41/41 as of 2026-08-28. The
identical banner was flagged on `C12-13` and `C12-14` by the 2026-08-28 C14 readiness review;
`C12-14`'s has resolved and `C12-13`'s has not. *Is the banner live or stale?*

**The recommendation, adopted as written** (plan §4, Q12, quoted verbatim):

> **Recommend:** one line — "the banner is stale; EXIT-4 rides the Node spec" — unless a
> licence-attribution capture is wanted, in which case it is 45 minutes of Edge.

Basis: the plan's Q12 — the cell names its own gate, and that gate is a green Node spec.

Executed: **NOT YET.** Executed by a dated line in the `C12-13` cell retiring the banner and naming
the Node spec as EXIT-4's gate, together with the confirmation that `LICENSE.md`'s third-party
attributions are current with live URLs.

Authority: charter §1.1.

---

## R-2026-09-19-14 — Q13: `C13-41`'s discriminator takes the Edge slot on its own merits; the brief's ORDER clause is struck

**The question.** `CAMPAIGN_STATE.md` still carries the sequencing *"P0-2 closes → and only then
does `C13-41`'s exposure-sweep discriminator take the single Edge slot"* (the plan cites
`CAMPAIGN_STATE.md:480-487`; re-read at the seat tip `0f0fa444e8`, that sentence is at `:484` inside
the "Wave P0-2 — order from here" paragraph, `:480-486`), and the discriminator brief's ORDER line
puts leg (e) after job 13c's legs (a)/(b)/(c)/(b3). Both are stale: L3, L4 and L5's Edge legs all
ran ahead of the discriminator on 2026-09-16/-17/-18 and P0-2 is still open. *Does the discriminator
wait?*

**The recommendation, adopted as written** (plan §4, Q13, quoted verbatim):

> **Recommend:** one line — *"`C13-41`'s discriminator takes the slot on its own merits; P0-2's
> remaining legs do not stand in front of it, and the brief's ORDER clause is struck"* — plus dated
> correction hunks to `CAMPAIGN_STATE.md:480-487` and the brief in `REC-7-RECORD`. Also worth
> recording: `R-2026-09-13-6`'s precondition ("after tonight's discriminator re-run") never happened
> and the engine legs ran anyway; and `R-2026-09-13-4`'s three-part close is no longer atomic.

Basis: the measured Edge history — six Edge jobs have taken the slot since 2026-09-16 without P0-2
closing — and the plan's §2b Edge-slot schedule, which is the first written ordering of the
contended slot.

Executed: **PARTLY, by the batch that carries this file.** The dated correction to
[`CAMPAIGN_STATE.md`](CAMPAIGN_STATE.md)'s stale sequencing paragraph lands here, as do the dated
in-place notes under `R-2026-09-13-6` and `R-2026-09-13-4` in
[`MAINTAINER_RULINGS_2026-09-13.md`](MAINTAINER_RULINGS_2026-09-13.md). **What is NOT yet done:** the
discriminator brief itself is re-issued with its ORDER clause struck when that Edge job is
dispatched, and `R-2026-09-13-1`'s own "Executed" line is flipped by the Option C close batch, not
by this one.

Authority: charter §1.1.

---

## R-2026-09-19-15 — Q14: the terrain-selection re-run proceeds, with the reopen consequence written down first

**The question.** `FINDING_DISPOSITIONS_2026-08-13.json` carries `C12-29-S5-TERRAIN-SELECTION` at
`state "closed"` with a `closureRunId`, and the queue's honest table records that lane at 12 runs and
**1 PASS** — that same run. But dense-cost **requires** a fresh terrain publication: its own
`pendingError` names the three-step chain and it refuses without it. So the re-run is a prerequisite,
not a freshness whim, and a red would force `finding-ownership-audit` to demand the `closed` entry be
reopened. *Proceed with the re-run knowing a red reopens a closed lane, or leave dense-cost unrun?*

**The recommendation, adopted as written** (plan §4, Q14, quoted verbatim):

> **Recommend: proceed, with the reopen consequence written into the brief and into `S5-ROSTER`
> beforehand**, so a red is a recorded outcome rather than a surprise that stalls the session. If Q3
> is answered (a), this question becomes optional — S5 leaves the gate and the session can be
> scheduled at leisure.

Basis: the plan's Q14 and its risk R6 — the ledger's owner state model is closed over
`{active, closed, reopened}`, and `finding-ownership-audit.spec.mjs` is the gate on any move between
them.

Executed: **NOT YET, and now optional.** `R-2026-09-19-4` adopts Q3(a), which takes S5 out of the
gate — so the S5 Edge session, and this re-run inside it, can be scheduled at leisure. When it is
taken, it is executed by the `S5-ROSTER` row recording the reopen consequence **before** the session
brief is written, and by that brief carrying it.

Authority: charter §1.1.
