# Maintainer rulings — 2026-09-18

Taken 2026-09-18 between ~14:25 and ~23:30 EDT, each by prompt from the seat during the evening's
landing chain; **each entry is the option the maintainer selected**, and the maintainer's words are
quoted **verbatim**, including their punctuation and their typos. Ruling ids are `R-2026-09-18-1`
… `-5`.

**Three further items of the same day are recorded here without a ruling id**, because none of them
is a decision that binds future work: a per-day quiet-hours lift that could not take mechanical
effect, a branch deletion taken on a recommendation and already executed, and a one-sentence
directive that set the next piece of work. They are here because a reader who finds only the five
numbered entries would not know why the evening ran as it did.

**Provenance.** The seat's source sheet for this file and for
[`MAINTAINER_RULINGS_2026-09-19.md`](MAINTAINER_RULINGS_2026-09-19.md) — the maintainer's verbatim
words, the mapping of each ruling to the question put, and the seat's statement of what was
recommended — is banked at
`cesium-webgpu-worker-archive/lanes-2026-09-19/rulings-source/rulings-source-2026-09-18-19.md`.
Where a ruling accepts a recommendation, the recommendation is **quoted from its own basis document**
and its substance is restated here, so this file stands alone and no reader has to open an untracked
one to know what was accepted.

Recorded 2026-09-19 by the record lane (Hamson) — the sitting itself carried no rulings file.

---

## Record only — the per-day quiet-hours lift that could not take mechanical effect

Maintainer, ~14:25 EDT: *"Okay well it is Friday so we can lift the quiet hours early at 5pm EST,
roughly a little less than 3 hours from now"*. Maintainer, ~17:48 EDT: *"Okay lets left the quiet
hours so we can get back to work"*.

**Outcome: the lift did not take mechanical effect, and nothing was pushed inside the window.** The
tracked pre-push guard (`Tools/pre-push-guard.mjs` with `Tools/landing-rules.mjs`, under
`R-2026-08-14-4`) refuses both the push instant and any commit **dated** inside the weekday window,
and it has no bypass; `R-2026-09-13-3` declined a waiver mechanism outright, on the stated ground
that a waiver path is a bypass however it is signed. The auto-mode classifier then refused the
seat's lift-flagged landing command as a CI bypass, and the seat did not work around it. Every
landing of the day happened after 19:00 ET (20:15 onward); the 19:03 session cron never fired,
because a background workflow kept the session busy.

This entry is the record that **a per-day lift in the maintainer's own words remains the only lift
that exists, and that it reaches the seat's judgement rather than the guard.** Nothing was built,
changed or waived on the strength of it.

Authority: none claimed — record only.

---

## R-2026-09-18-1 — `C15-05` and `C15-06` are released from the `R4` hold, as a second named narrow override

`C15-05` (OVATION + planetary-Kp asynchronous ingest and source-authority policy) and `C15-06` (new
RTSW + GOES asynchronous ingest with separate geomagnetic and flare state) are **RELEASED from the
`R4` hold and dispatchable as pure-Node lanes**, started after the CI fix lands, with their fixtures
re-captured first. `C15-05` publishes its source-authority contract before `C15-06` is built against
it. This is a **second named narrow override of `R4`'s literal text, for two named rows** — the
same shape as `R-2026-09-17-9`, which released `C15-01` and `C15-02` — and **not** an exercise of
Option C of `R-2026-08-10-1`. It pre-empts neither arm of `R-2026-09-13-1`, and it does not claim
that `R4`'s condition (C12 closure) is met.

**The maintainer's words, verbatim:** *"1. Go with the recommendation."*

**What was put to them** — decision 1 of the seat's three-decision brief, quoted from the source
sheet: *"release C15-05 and C15-06 now as a second narrow override; start them after the CI fix
lands; re-capture the fixtures first"*.

Basis: the `C15-05` and `C15-06` rows of
[`QUEUE_2026-08-02_CAMPAIGN15.md`](QUEUE_2026-08-02_CAMPAIGN15.md) — both are pure-Node ingest rows
whose written exit gates are frozen-fixture and mutation-test exits with no pixels, no shader and no
Edge slot, and `C15-06`'s own dependency column already reads "`C15-01`, `C15-05` authority
contract". The contact-sheet condition of `R-2026-09-17-9` exists for rows that are judged by how
they **look**, under the protocol of `R-2026-09-17-10`, and does not reach these two. The fixtures
are re-captured first because that queue's §2a schemas were measured **2026-08-06** against live
feeds.

**Rows this ruling left held.** `C15-03`, `C15-04`, `C15-06P`, `C15-07`, `C15-07H` and `C15-08`
remained `HELD (R4)` on 2026-09-18. What changed the following day is `R-2026-09-19-5`
([`MAINTAINER_RULINGS_2026-09-19.md`](MAINTAINER_RULINGS_2026-09-19.md)), which lifts the `R4` hold
as part of Option C; a reader who finds only this entry must read that one before treating any of
those six as held.

Executed: **the ledger half is executed by the batch that carries this file** — the hold paragraph
and the `C15-05` / `C15-06` status cells in
[`QUEUE_2026-08-02_CAMPAIGN15.md`](QUEUE_2026-08-02_CAMPAIGN15.md), and the matching dated line in
[`CAMPAIGN_STATE.md`](CAMPAIGN_STATE.md) §C15. **The lanes themselves are NOT dispatched**, and the
fixture re-capture has not been taken.

Authority: charter §1.1.

---

## Record only — the banked-then-deleted backup branch `backup-inwindow-1405-1429-20260905`

Maintainer: *"2. Go with the recommendation"* — decision 2 of the same three-decision brief, whose
recommendation was to **bank the branch, then delete it**.

Executed 2026-09-18 ~22:55 EDT, in that order: a verified bundle plus `redate-map.txt`,
`original-commits.txt` and a `README.txt` carrying the restore command were written to
`cesium-webgpu-backups/branch-backup-inwindow-1405-1429-20260905/`; **then** the local branch was
deleted. Local branches are `main` only.

It is recorded rather than numbered because it decides nothing beyond its own act. It is, however,
the **second of `R-2026-09-13-4`'s three-part P0-2 close, executed out of band** — one of the two
reasons that ruling's close is no longer atomic; see the dated note under it in
[`MAINTAINER_RULINGS_2026-09-13.md`](MAINTAINER_RULINGS_2026-09-13.md), and `R-2026-09-19-14`.

Authority: none claimed — record only.

---

## R-2026-09-18-2 — the seat's `tmp/` folder is audited read-only and kept; the cleanup is Astra's when Codex usage returns

The seat's `tmp/` folder is **audited, read-only, and kept**. Nothing is deleted now. The cleanup
itself is Astra's work, to be taken when Codex usage returns.

**The maintainer's words, verbatim:** *"3. Run the audit but we likely keep it until we get Codex
usage again, then we let Astra do the cleanup"*.

**What was put to them** — decision 3 of the same three-decision brief: run the audit read-only and
decide disposal separately, rather than sweeping the folder under the standing temp-hygiene rule.

Basis: the temp-hygiene rule (maintainer, 2026-09-11;
[`WORKER_ISOLATION_AND_BRANCH_HANDOFF.md`](WORKER_ISOLATION_AND_BRANCH_HANDOFF.md) §8i) is a
**two-phase, positive-list** sweep by construction — bank first, delete only from a list read back
from the file — and this folder is the case that rule was written for: large, old, and holding the
only copy of some things.

Executed: **the audit is done, 2026-09-19 ~00:30 EDT, and nothing was deleted.** It is banked at
`cesium-webgpu-worker-archive/tmp-audit-2026-09-18/` as `TMP_AUDIT_2026-09-18.md` with
`keep-list.txt` (3,705 paths) and `disposable-list.txt`.

**HAZARD, recorded in the audit and repeated here because it binds whoever does the cleanup:**
three **junctions inside `tmp/` point into the live `packages/engine`, `packages/sandcastle` and
`packages/widgets` trees.** A link-blind recursive delete would therefore reach live source. The
cleanup must be link-aware, and must be taken from the positive list, never from a glob.

Authority: charter §1.1.

---

## Record only — the Campaign 12 directive

Maintainer, ~23:05 EDT: *"Lets see if we can finish out what is left in campaign 12 as well"*.

This is the directive that produced the read-only scoping of Campaign 12's remainder — the plan
tracked as [`C12_CLOSEOUT_PLAN_2026-09-19.md`](C12_CLOSEOUT_PLAN_2026-09-19.md) — and through it the
fifteen rulings of [`MAINTAINER_RULINGS_2026-09-19.md`](MAINTAINER_RULINGS_2026-09-19.md). It is
recorded because those fifteen rest on it, and a reader is entitled to know what asked for them.

It is **not** a ruling that C12 closes. What closing C12 costs, and on what reading, is
`R-2026-09-19-4`.

Authority: none claimed — record only.

---

The three rulings that follow were taken together, ~23:30 EDT, on the three decisions lane L5's
adjudication reserved for the maintainer.

**The maintainer's words, verbatim, covering all three:** *"1. go with recommended 2. Go with
recommended 3. Go with recommendation"*.

**Their basis document** is `RECOMMENDATION_L5.md` §5.1–5.3 — the adjudication of L5 (`C13-N22`, the
1440 × 721 weather field) by lane Marmadoc with the adversarial verifier Marmadas, banked at
`cesium-webgpu-worker-archive/lanes-2026-09-18/l5-adjudication/`. Each ruling below quotes its own
§5 question **verbatim** from that document **and** states the substance of what the seat
recommended, so the record does not depend on the banked file being at hand.

---

## R-2026-09-18-3 — L5 lands with `C13-N22`'s acceptance OPEN, and `C13-N13` is promoted out of Wave 3

L5 lands with `C13-N22`'s image-side acceptance recorded **OPEN and UNDISCHARGED**, and `C13-N13`
— the metre-floored, interval-aware march step, whose absence renders concentric ray-march ring arcs
instead of a cloud field from roughly 600 km up — is **PROMOTED out of Wave 3 to be the next cloud
engine row**, ahead of the remaining W2/W3 rows. The inversion is not accepted as filed.

**The question, quoted verbatim from `RECOMMENDATION_L5.md` §5.1:**

> **5.1 — Landing an engine change whose only quantitative Edge bar returned null, and parking a
> Wave-1 acceptance behind a Wave-3 row.** Both reviewers agree the row may land and that its
> acceptance must be recorded as undischarged. But the *scheduling* consequence is a maintainer's
> call, not a reviewer's: `C13-N22` is W1 and `C13-N13` is W3, and `C13-GATE-D` — which depends on
> `C13-N22` and is scored in part by `O5` — cannot be declared while the rings stand.
> **Question: accept the inversion as filed, or promote `C13-N13` out of W3?**

**What the seat recommended, and what was accepted: promote.** A Wave-1 row's image-side claim
cannot sit behind a Wave-3 row, and `C13-GATE-D` cannot be declared while the rings stand.

Basis: `RECOMMENDATION_L5.md` §5.1 as above, resting on L5's Edge leg 4 (2026-09-18, executor
Ferumbras), which measured the orbital march at **3,721.2 m** against `C13-N13`'s own **O7 ≤ 2 km**
bar at 96 primary steps.

Executed: **yes — Batch 1515 (`0f0fa444e8`).** That batch's ledger text carries the promotion in
`DEFERRED_WORK.md` (the `C13-N13` row and
`LEG-4-ORBITAL-MARCH-RINGS-DEFEAT-THE-SPECTRAL-BAR`), in the `C13-N13` and `C13-N22` rows of
[`QUEUE_2026-07-23_CAMPAIGN13.md`](QUEUE_2026-07-23_CAMPAIGN13.md), in
[`CAMPAIGN_STATE.md`](CAMPAIGN_STATE.md) §C13 and in
[`FEATURE_INVENTORY.md`](FEATURE_INVENTORY.md) — each carrying the forward reference *"to be
recorded as `R-2026-09-18-3`"*. **This file is that record**, and those forward references now
resolve.

Authority: charter §1.1.

---

## R-2026-09-18-4 — `C13-N22`'s image-side claim is a LOOK, not a re-measure; no further Edge leg is owed for the spectral statistic

The image-side claim — *"finer geography visible from orbit"* — is **re-homed as a LOOK under
`R-2026-09-17-10`**: a contact sheet at the recipe's own camera, with a **real EDR provider** so
that there is geography in the field to see at all, taken once `C13-N13` lands. **No verdict, no
threshold, and one pinned baseline if the look is accepted.** The CPU-side spectrum spec in
`weather-map-seam.spec.mjs` **stays the invariant** for the resolution claim, and **no further Edge
leg is owed for the spectral statistic.**

**The question, quoted verbatim from `RECOMMENDATION_L5.md` §5.2:**

> **5.2 — Whether the re-measure may be RE-SPECIFIED rather than merely re-run.** The arithmetic in
> §3.3 says a bare re-run at the recipe's camera after `C13-N13` is not expected to be decidable,
> because the predicted effect is ≈ 0.4 % of a statistic with no registered noise floor. My §3.3
> exit condition adds a background arm, a repeat-capture floor and a pre-registered magnitude —
> **additions to the design, with the band, camera and crop untouched.** From outside, "repairing an
> under-powered instrument" and "widening a bar" look identical, and the standing rule is absolute.
> **Question: are those three additions authorised, and is the standing rule satisfied by leaving
> band, camera and crop fixed?** The seat should not decide this.

**What the seat recommended, and what was accepted: do not re-specify the instrument at all.**
Route the image-side claim to the contact sheet, where it belongs under `R-2026-09-17-10` —
aesthetic questions are **judged**, not scored — and leave the CPU spectrum spec as the invariant.
That answers §5.2 without touching the band, the camera or the crop, and without a repaired
instrument that would be indistinguishable from outside from a widened bar.

Basis: `RECOMMENDATION_L5.md` §5.2 as above, and `R-2026-09-17-10`
([`MAINTAINER_RULINGS_2026-09-17.md`](MAINTAINER_RULINGS_2026-09-17.md)), the visual-acceptance
protocol that distinguishes an invariant from a look. The measured null that provoked the question
is in the leg's own table: slope delta **−0.0002** over the lane's unwidened `[56.15, 281.46] km`
band across 13 bins, band power ratio **1.0037**; **+0.0025** at the 512-px crop.

Executed: **yes — Batch 1515 (`0f0fa444e8`)**, in `DEFERRED_WORK.md` (the `C13-N22` owed/not-done
bullet and the `LEG-4-…` row's "what is owed, and where" paragraph) and in the `C13-N13` /
`C13-N22` rows of [`QUEUE_2026-07-23_CAMPAIGN13.md`](QUEUE_2026-07-23_CAMPAIGN13.md) and
[`CAMPAIGN_STATE.md`](CAMPAIGN_STATE.md) §C13, each carrying the forward reference *"to be recorded
as `R-2026-09-18-4`"* that this entry resolves. **The look itself has not been taken** — it waits on
`C13-N13` and on a real EDR provider.

Authority: charter §1.1.

---

## R-2026-09-18-5 — L5 ships with the performance row open; the device measurement is REQUIRED before `C13-N23`

L5 ships **now**, with `PERF-C13-N22-WIDENED-WEATHER-RESOURCE-UNMEASURED` open. The **device
measurement is REQUIRED before `C13-N23`** multiplies the resource, and `C13-N23` carries it as an
added dependency. **The field build moves off the main thread if the measurement confirms the
~51 ms → ~298 ms first-frame cost.**

**The question, quoted verbatim from `RECOMMENDATION_L5.md` §5.3:**

> **5.3 — Whether the first-cloud-frame regression ships.** With the map ON, `51.0 ms → 298 ms`
> main-thread, synchronously on the render path, is a 5.84× regression against the status quo that
> no leg measured on device; `C13-N23` then triples the resident resource. Default-OFF cost is
> provably zero, which is why neither reviewer blocks on it. **Question: ship it with
> `PERF-C13-N22-WIDENED-WEATHER-RESOURCE-UNMEASURED` open, or require the measurement (and a fix,
> if it is bad) before `C13-N23`?**

**What the seat recommended, and what was accepted: both halves.** Ship, because the default-OFF
cost is provably zero; **and** require the measurement before `C13-N23`, because that row triples a
resource whose cost has never been read on a device. The two are not alternatives.

Basis: `RECOMMENDATION_L5.md` §5.3 as above. The resident texture goes from 4,152,960 B to
12,458,880 B per context at `C13-N23`, and CLAUDE.md's multi-metric performance rule is **not**
satisfied for `C13-N22` as landed — no frame time, no upload count and no first-frame latency was
measured anywhere.

Executed: **yes — Batch 1515 (`0f0fa444e8`)**: the
`PERF-C13-N22-WIDENED-WEATHER-RESOURCE-UNMEASURED` row in `DEFERRED_WORK.md`, the added dependency
in `C13-N23`'s row of [`QUEUE_2026-07-23_CAMPAIGN13.md`](QUEUE_2026-07-23_CAMPAIGN13.md), and the
`C13-N22` "what the leg did not cover at all" paragraph — each carrying the forward reference *"to
be recorded as `R-2026-09-18-5`"* that this entry resolves. **The measurement itself has not been
taken.**

Authority: charter §1.1.
