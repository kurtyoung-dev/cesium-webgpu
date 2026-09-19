# Maintainer rulings — 2026-09-13

Taken 2026-09-13, rulings 1–7 at ~14:40 EDT and ruling 8 at ~15:10 EDT, each by prompt from the
seat; **each entry is the option the maintainer selected**, quoted from the sitting's own note
(`scratchpad/rulings-2026-09-13-maintainer.md`, the seat's untracked scratchpad, banked with this
record round's lane packet). Recorded here by record round 5 on 2026-09-16 — the sitting itself
carried no rulings file, and `STOP_CHECKPOINT_2026-09-13.md` §2 named writing one as owed work.

Ruling ids are `R-2026-09-13-1` … `-8`. The "Executed" line names the batch that carried the ruling
out, or says plainly that it has not been carried out — three of these eight were overtaken by the
2026-09-13 wind-down and are still owed.

## R-2026-09-13-1 — `C13-41` / `C12-29` S3: the S3 re-decision is CONDITIONAL on the discriminator re-run (RR-2026-09-13-E)

CONDITIONAL ON TONIGHT'S RE-RUN. If Bandobras's leg (e) on ea651de6d8 is red again on shadowContrastInvariant (outside [0.97, 1.03]) or its deck-free control lane is still BLIND, the seat executes Option C of R-2026-08-10-1 (re-file S3/S4 as C13 rows, close C12, unblock C14, release the aurora R4 hold); if it turns green, S3 continues. No further round-trip; both sweeps go into the record either way.

Basis: `RULING_REQUESTS_2026-09-08.md` `RR-2026-09-13-E`, raised against `R-2026-09-02-5` and
`R-2026-08-10-1`; the 2026-09-03 sweep it re-decides is stamped in `QUEUE_2026-07-23_CAMPAIGN13.md`
§9 row `C13-41` and summarised in `CAMPAIGN_STATE.md`'s C13 block.

Executed: **NOT EXECUTED.** Leg (e) never ran — job 13c stopped mid-leg (b) at the 16:05 EDT
wind-down (`STOP_CHECKPOINT_2026-09-13.md` §5), so neither arm of the conditional has fired and the
S3 re-decision is still owed. The ruling stands as written and applies to the first re-run that
completes.

Authority: charter §1.1.

## R-2026-09-13-2 — `RR-2026-09-13-A` … `-D` ratified, all four

RATIFIED, all four - A the quarantine-runner convention; B a red guard gets a repair row in the next batch; C a seat gate never runs a suite that reads a maintainer-held file; D the landing gate runs every runner a batch's files are homed in (by hand through runCensus until the landing-gate tool from its DX row lands).

Basis: `RULING_REQUESTS_2026-09-08.md` `RR-2026-09-13-A`…`-D`, carried into the record by Batch 1484
(`ac58f9a73c`); D's tool is `QUEUE_2026-08-29_RESEARCH_DISPATCH.md` `DX-93`.

Executed: ratified here; A is already the convention (`C13-N02`, Batch 1479), B and C bind every
subsequent landing, and D runs **by hand through `runCensus`** until `DX-93` lands.

Authority: charter §1.1.

## R-2026-09-13-3 — `RR-2026-09-11-A` DECLINED: the pre-push guard stays override-free

DECLINED - the pre-push guard stays override-free; a quiet-hours lift stays a per-day instruction in the maintainer's words and the seat lands after 19:00 ET. Reason on the record: nothing can push in-window by construction; a waiver path is a bypass however it is signed.

Basis: `RULING_REQUESTS_2026-09-08.md` `RR-2026-09-11-A`, raised in `MAINTAINER_RULINGS_2026-09-11.md`
after Batch 1464 was re-dated by the tracked guard; the guard is `.husky/pre-push` plus
`Tools/landing-rules.mjs` under `R-2026-08-14-4`.

Executed: nothing to build — the ruling's effect is that no waiver mechanism is written.
`RR-2026-09-11-A` closes DECLINED.

Authority: charter §1.1.

## R-2026-09-13-4 — the P0-2 close is a three-part act: close on green, delete the backup branch, retire the served sync clone

on all job-13c legs green the seat records P0-2 CLOSED, DELETES the local backup branch backup-inwindow-1405-1429-20260905 (its commits are re-dated on origin; redate-map archived), and RETIRES the served sync clone cesium-lane-sync-1145-20260904 @ 5be896fe3a (bank md5s + receipts, stop its servers on 8080/8082/8094, delete the clone) since the fresh clone of the fixed tree supersedes it.

Basis: the P0-2 gate as carried in `CAMPAIGN_STATE.md` and the job-13c leg list; the branch and the
served clone are the two items standing in `CAMPAIGN_STATE.md` §3 and §3a.

Executed: **NOT EXECUTED.** Job 13c stopped mid-leg (b); legs (c), (b3) and (e) never ran, so P0-2
is **not** closed, the branch `backup-inwindow-1405-1429-20260905` still exists, and the sync clone
is still served (`STOP_CHECKPOINT_2026-09-13.md` §0 and §5). The spot-check that did run is the one
positive result: `sample-height-from-3d-tiles` at settle 25000 measured WebGPU 3/3 PASS and WebGL
3/3 PASS on the fixed tree.

*[Note added 2026-09-19 under `R-2026-09-19-14`
([`MAINTAINER_RULINGS_2026-09-19.md`](MAINTAINER_RULINGS_2026-09-19.md)) — a note, not a rewrite:
the ruling above stands exactly as written, and its "Executed" line is corrected only as to fact.
**This three-part close is no longer atomic.** Part 2 — delete the local backup branch
`backup-inwindow-1405-1429-20260905` — was **executed out of band on 2026-09-18 ~22:55 EDT**, on a
separate maintainer recommendation and **not** on this ruling's own trigger: the branch was banked
first (bundle, `redate-map.txt`, `original-commits.txt` and a restore README under
`cesium-webgpu-backups/branch-backup-inwindow-1405-1429-20260905/`) and then deleted, and
`git branch` at the seat now lists `main` alone. That entry is recorded in
[`MAINTAINER_RULINGS_2026-09-18.md`](MAINTAINER_RULINGS_2026-09-18.md). Part 1 — record P0-2 CLOSED
— **cannot have fired**, because the legs it is conditional on still have not run and P0-2 is still
OPEN; and part 3 — retire the served sync clone `cesium-lane-sync-1145-20260904` — is **not done**:
the clone directory is still present at the seat. So a reader must not treat the branch's deletion
as evidence that any other part of this act was carried out.]*

Authority: charter §1.1.

## R-2026-09-13-5 — the solo roster stays RESERVED for the maintainer's own sessions

KEEP RESERVED for the maintainer's Astra/Gemini sessions; the seat runs Opus-grade lanes only and replenishes the roster in each record round.

Basis: `SOLO_WORKER_HANDOFF_2026-09-13.md` and its companion
`CAMPAIGN_13_V2_SOLO_ROWS_2026-09-12.md`, the classification landed in Batch 1482.

Executed: standing. Re-cut in scope the same afternoon by `R-2026-09-13-8`, which changed **who** the
roster is for; the reservation itself is unchanged.

Authority: charter §1.1.

## R-2026-09-13-6 — Edge order: engine legs first (amends `R-2026-09-12-7`'s tail)

after tonight's discriminator re-run, ENGINE LEGS FIRST - L3 leg, land L3; L4 legs 3a/3b, land L4; L5 leg, land L5; THEN L6 leg 1 captures its baselines on the landed engine (the engine legs carry their own BEFORE/AFTER trees; baselines captured earlier would need re-capture).

Basis: amends the tail of `R-2026-09-12-7` in `MAINTAINER_RULINGS_2026-09-12.md`, which had ordered the
cloud Edge queue L6 → L3 → L4 → L5 → L7; the legs themselves are named in the three frozen lanes'
packets and summarised in `STOP_CHECKPOINT_2026-09-13.md` §3.

Executed: **not yet.** The engine-legs job was briefed (executor Ferumbras) and **not dispatched**
before the wind-down; L3's leg 2 is the first to run under this order.

*[Note added 2026-09-19 under `R-2026-09-19-14`
([`MAINTAINER_RULINGS_2026-09-19.md`](MAINTAINER_RULINGS_2026-09-19.md)) — a note, not a rewrite:
the ordering above stands, and it has since been **executed**, but **its own precondition never
happened.** The ruling's first clause is *"after tonight's discriminator re-run"*; that re-run — job
13c leg (e) — has still not been taken, and `R-2026-09-13-1` records it as NOT EXECUTED. **The
engine legs ran anyway**: L3's Edge leg on 2026-09-16 and its landing at Batch 1493, L4's legs on
2026-09-17 and its landing at Batch 1504, L5's leg 4 on 2026-09-18 (executor Ferumbras) and its
landing at Batch 1515. The ENGINE-LEGS-FIRST half was therefore carried out while the clause that
gated it was unmet, and that is recorded here so no reader infers from the legs' completion that the
discriminator re-run took place. The consequence for the slot is settled separately:
`R-2026-09-19-14` strikes the sequencing that put the discriminator behind P0-2, so the
discriminator now takes the Edge slot on its own merits rather than behind anything.]*

Authority: charter §1.1.

## R-2026-09-13-7 — the `C13-N10` seat-hands-on experiment is DROPPED

DROPPED; the pyramid stands (C13-N10 was delivered by L3).

Basis: the proposed experiment would have had the Fable seat implement `C13-N10` by hand against the
pyramid convention the seat operates under; `C13-N10` was in fact delivered by lane L3 (Ulmo),
frozen and reviewed.

Executed: dropped; no work follows from it.

Authority: charter §1.1.

## R-2026-09-13-8 — the solo roster is RE-CUT for two solo workers: Astra takes everything fully defined, Gemini takes what is overkill for Astra

ASTRA SOLO SCOPE = EVERYTHING FULLY DEFINED - tools, docs, fixtures AND engine/shader rows, Astra running the full proof bar itself (behaviour spec, inertness mutants, its own station-3 checklist on its own patch, and the named Edge leg under the machine's Edge-slot lock); excluded only files a live seat lane holds, rows whose design shape is undecided, and seat-only mechanics (landing, rulings); the seat still reviews at landing. GEMINI = the rows that are overkill for Astra (bounded docs/mechanical, <30 min, no build/browser). 'Sonnet' is not a solo worker; R-HANDOFF-3/-7/-10 superseded.

The maintainer's own framing, quoted in the sitting note as the question this ruling answers: *"for
the solo roster I was looking for things Astra could run solo, which is likely a lot but there are
things that would be overkill for Astra. The overkill things could be good things for Gemini… Astra
would be running as its own worker, reviewer, testers, etc as we'd drop the tier orchestration for
both Astra and Gemini"*.

Basis: the roster as landed in Batch 1482 gave Astra **zero** rows — eleven named Sonnet and one
Gemini, because `R-HANDOFF-3`, `-7` and `-10` in `SOLO_WORKER_HANDOFF_2026-09-13.md` §2.3 resolved
every open assignment to the seat's tier-3 worker.

Executed: **Batch 1487** (`c325f858c3`, 2026-09-13 17:19:36 EDT) — the re-cut classification (156
distinct rows: **19** ASTRA-SOLO, **2** GEMINI-SOLO, **135** NOT-SOLO, of which **111** wait on a seat
act) in `CAMPAIGN_13_V2_SOLO_ROWS_2026-09-12.md` §9, with `R-HANDOFF-12`, the two-profile roster, the
§7 self-review bar and the §8 Edge-slot protocol in `SOLO_WORKER_HANDOFF_2026-09-13.md`, and
`[SOLO-A]` / `[SOLO-G]` tags on the queue rows.

**Execution note, recorded because the sitting note carries it and it reads as a contradiction
otherwise.** At 16:05 EDT the sitting note recorded ruling 8's execution as **STOPPED** at the
maintainer's 97 %-usage wind-down "before the critic/assembler ran; nothing landed", with Astra to
run from the Batch 1482 handoff page plus this ruling relayed verbatim. The workflow
(`c13v2-solo-recut`, run `wf_80f7d1f6-cb0`) was indeed stopped after its twelve Read/Classify/Refute
results were journalled; the critic (Estella) and assembler (Everard) were then run as **standalone
agents on those cached results**, reviewed by Fastolph, and landed as Batch 1487 at 17:19 EDT the
same afternoon (`STOP_CHECKPOINT_2026-09-13.md` §7). The 16:05 note is therefore true of the
workflow and superseded as to the outcome.

Authority: charter §1.1.
