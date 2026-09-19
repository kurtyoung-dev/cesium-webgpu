# C12 CLOSE-OUT PLAN — v2, post-critique

> **Provenance, added when this plan was tracked (2026-09-19, record lane Hamson).** This document
> is the **basis** of `R-2026-09-19-1` … `-15`
> ([`MAINTAINER_RULINGS_2026-09-19.md`](MAINTAINER_RULINGS_2026-09-19.md)), and it is tracked for
> exactly that reason: **a tracked ruling may not rest on an untracked basis** — the plan's own risk
> R7 says so about three other documents, and it applies to the plan itself. It is landed **as
> written**, not paraphrased; nothing in §1–§8 below has been edited, and the only additions are
> this block and the STATUS line under it.
>
> **Who produced it.** Read-only scoping for the Fable seat (Gandalf), 2026-09-19: readers **Nora**,
> **Nina**, **Peony** and **Angelica**; synthesis **Lily**; critic **Noakes**. No git writes, no
> build, no browser, no Python.
>
> **Where its companions are.** The four reader reports (`READ_NORA.md`, `READ_NINA.md`,
> `READ_PEONY.md`, `READ_ANGELICA.md`), the critique (`CRITIQUE_NOAKES.md`) and this plan's own v1
> (`C12_CLOSEOUT_PLAN.v1.bak.md`) are banked at
> `cesium-webgpu-worker-archive/lanes-2026-09-19/c12-closeout/`. Wherever the text below names one of
> them by bare filename — as it does in the header's "Sources" line and throughout §8 — **that is the
> path**. Two other untracked paths the text names are **not** in that folder and are not repointed
> to it: `scratchpad/brief-edge-c13-41-discriminator.md` (§4, Q0) is the seat's untracked Edge brief
> for the `C13-41` discriminator, and the two checkpoints named in risk R7,
> `STOP_CHECKPOINT_2026-09-13.md` and `RESTART_CHECKPOINT_2026-09-12.md`, are untracked files in the
> seat's session scratchpad, **not** under `migration_doc/`. R7's point stands unchanged: a
> temp-hygiene sweep orphans all three.
>
> **This plan is the argument, not the authority.**
> [`MAINTAINER_RULINGS_2026-09-19.md`](MAINTAINER_RULINGS_2026-09-19.md) is the authority for the
> fifteen decisions taken on it, and queue rows remain the sole status authorities for every row it
> names.

**STATUS (2026-09-19) — which of this plan's questions are now answered, and by which ruling.**
All fifteen of §4's maintainer items were answered in one sentence — *"For all the current questions
with recommendations use the recommendations"* — so **every RECOMMEND text in §4 is adopted as
written**: `Q0` → `R-2026-09-19-1`, `Q1` → `-2`, `Q2` → `-3`, `Q3` → `-4`, `Q4` → `-5`, `Q5` → `-6`,
`Q6` → `-7`, `Q7` → `-8`, `Q8` → `-9`, `Q9` → `-10`, `Q10` → `-11`, `Q11` → `-12`, `Q12` → `-13`,
`Q13` → `-14`, `Q14` → `-15`. **Three of them are owed by the maintainer in person and are not
executable by any lane** — `Q7`'s countersign (`-8`), `Q8`'s HDR-display sitting (`-9`) and `Q9`'s
Tycho-2 licence determination with its fetch-path scheduling (`-10`); accepting a recommendation
settles what is to be done, it does not perform a sitting. **`Q6` (`-7`) is blocked on its own
rider** — the eighteen `NON_CERTIFYING` publications folding into a `PASS` certification must be
explained before the banking route is built. **`Q13` (`-14`) is partly executed** by the record
batch that tracked this plan: the dated correction to `CAMPAIGN_STATE.md`'s stale Edge-slot
sequencing paragraph and the dated notes under `R-2026-09-13-6` and `R-2026-09-13-4`. Separately,
`R-2026-09-18-1` ([`MAINTAINER_RULINGS_2026-09-18.md`](MAINTAINER_RULINGS_2026-09-18.md)) has
already released `C15-05` and `C15-06` from the `R4` hold, which is narrower than and prior to the
lift `Q4` (`-5`) describes. **Nothing else in §2's step table has been executed**, and §6a's arm has
not fired.

---

Synthesis: **Lily** (Opus), for the Fable seat (Gandalf). v1 written **2026-09-18 ~23:40 EDT**;
**v2 revised 2026-09-19** against `CRITIQUE_NOAKES.md` (read in full) and against my own
re-measurement at the current tip.

**Base commit corrected.** v1 was written against `5d6be1f686` (Batch 1512). `main` is now
**`245cdc7e9d` (Batch 1514, 2026-09-18 23:53:02 -0400)** — **two** commits ahead of v1's stated base
and **one** ahead of the critic's. Batch 1513 (`58c5147763`, 23:44:44) fixed the npm manifest; Batch
1514 fixed the WGSL mini-evaluator. Both falsify v1 §5. Every measurement below carries its date;
claims I measured myself at `245cdc7e9d` on 2026-09-19 are marked **[Lily-reverified 2026-09-19]**,
claims carried from v1 at `5d6be1f686` are marked **[Lily-verified 2026-09-18]**.

**The tip is moving under this plan.** While I was writing v2 the seat landed **Batch 1515
(`0f0fa444e8`)**, so `main` is already one commit past every measurement below. Nothing in v2 turns on
Batch 1515 (a weather-texture grid change), but a reader re-running my numbers should expect the tip
hash to differ and should re-measure rather than assume — the same discipline that caught v1 out.

Sources: `READ_NORA.md`, `READ_NINA.md`, `READ_PEONY.md`, `READ_ANGELICA.md`, `CRITIQUE_NOAKES.md`
(all read in full), plus my own re-derivation of every decision-bearing claim (CLAUDE.md Principle 10
— which binds a critique's findings exactly as it binds a queue row: I re-ran or re-read the cited
`file:line` for all fourteen of Noakes's findings before accepting any of them).
**Read-only. Nothing outside this folder was modified; no git writes, no build, no browser, no Python.**

**The single most consequential change in v2.** The deck-free control lane's answer does **not** need
the Edge slot. The 2026-09-03 sweep's raw evidence is banked on disk —
`Tools/visual-regression/output/eclipse-cloud-response-2026-09-02b/probe-output/eclipse-cloud-response-report.json`
carries `webgpuCloudLanes.deckFreeControl.sessions` as the exact 4-element array
`foldDeckFreeControlSessions` (`lib/c13-41-deckfree-control.mjs:431`) consumes, alongside its
`factorTolerance`, `scheduleObscurationTolerance`, `rungs`, 16 identical `structuralReasons` and
`nonVacuityReasons: []`, with 40 occurrences of the string `DirectionalLight2`
**[Lily-reverified 2026-09-19]**. So the repaired predicate can be re-scored **offline, tonight, on a
Node lane**, against evidence already captured at the ruling's own tree. That turns the deck-free
question from "an Edge night that can only come back BLIND" into a bounded Node lane whose negative
controls are already on disk — and it leaves the Edge slot with exactly one question to answer.

## 1. What closing C12 actually takes — honestly

C12 does not close on one Edge run. The queue's own §0 — which declares *"on conflict THIS section
wins"* (`QUEUE_2026-07-19_CAMPAIGN12.md:3`) — plus the rows §0 omits, leaves **eleven work items and
nine maintainer acts** standing (v1 said seven and six; Noakes N-05 named six items v1 never
mentioned and I confirmed every one of them in the queue's own §0 and ASKS lines 20-53
**[Lily-reverified 2026-09-19]**).

**The discriminator's second trigger is already decided, and not by the product.** The gate demands
`side?.constructorName === kind` with `kind` the literal `"DirectionalLight"`
(`Tools/visual-regression/lib/c13-41-deckfree-control.mjs:348`, consumed by
`directionalLightEvidenceMatches` at `:366-370`); esbuild emits `function DirectionalLight2(` —
`grep -c` over `Build/CesiumUnminified/Cesium.js` returns **1** at HEAD and `function SunLight2(`
returns **0**, which is why the sibling restore check works and review never caught it
**[Lily-reverified 2026-09-19]**. ~~The instrument is **byte-identical between `ea651de6d8` and
HEAD**: `git diff ea651de6d8..245cdc7e9d` over `probe-eclipse-cloud-response.mjs` and the five
consumed libs is **empty** **[Lily-reverified 2026-09-19]**.~~ **CORRECTED 2026-09-19** by the batch
that carries this line, on the adversarial critic **Bingo**'s finding: that sentence is **true at
`245cdc7e9d`** (Batch 1514 — re-derived here, the diff is empty) and **false at the tip this batch
is based on**, `30d1ceb60f` (Batch 1527). `git diff --numstat ea651de6d8 30d1ceb60f` over the probe
and the six libraries in its transitive import closure reports `lib/build-source-identity.mjs` **47 / 0** (Batch 1519 `df92ce5d5b`, pure additions) and
`lib/c13-41-deckfree-control.mjs` **14 / 1** (Batch 1518 `3e6feaae24`, the deck-free repair). The
leg (e) receipt names both and applied only the second. So *any* run of the unrepaired instrument,
on either tree, fires `R-2026-09-13-1`'s second red trigger with certainty — **that conclusion is
untouched**: the only drifted file that bears on it is the repair itself, and this sentence is about
the *unrepaired* instrument. **v1 planned to spend the Edge night
obtaining that foregone conclusion. v2 does not** (Noakes N-01, accepted).

~~**And the first trigger has already fired, on a completed sweep at the ruling's own tree.** The
2026-09-03 banked report reads `verdicts.shadowContrastInvariant: false`,
`verdicts.shadowContrastRatioAtDeepest: 1.0341102079879674`, nine `unscoredPredicates` and the 16
constructor-name structural reasons **[Lily-reverified 2026-09-19]**. With a byte-identical instrument
on a byte-identical engine, a literal re-run is a **repeat measurement**, not a new one. That is the
real question for the maintainer (Q1 below), and it is sharper than anything v1 put.~~

**CORRECTED 2026-09-19** by the batch that carries this line — struck above, restated here, nothing
deleted. **The report's VALUES are right; the run's TREE is not.** That sweep ran on
**`fbea2028cc`** (Batch 1403), **not** on the `ea651de6d8` (Batch 1483) `R-2026-09-13-1` names.
Its own receipt says so —
`Tools/visual-regression/output/eclipse-cloud-response-2026-09-02b/README.txt`, line 6:
*"Clone commit   fbea2028cc (== origin/main, Batch 1403); worktree clean"* — and the two commits are
**443 commits** apart (`git merge-base --is-ancestor fbea2028cc ea651de6d8` succeeds). The
**engine** is not identical:
`packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts` alone differs by **2,742
insertions / 1,660 deletions**, and the report pins that same file as `engineSource3` at
`byteLength` **198654** where the 2026-09-19 run's report reads **237065**. **And the instrument is
not identical either.** That half of the claim was asserted, wrongly, by the first draft of this
very correction, and the same adversarial critic caught it on a second pass: `git diff --numstat
fbea2028cc ea651de6d8` over the probe and the **six** libraries in its transitive import closure
(the five it imports directly, plus `lib/same-task-capture.mjs` reached through
`lib/weather-probe-pinning.mjs`) reports
`Tools/visual-regression/lib/cloud-probe-harness.mjs` at **289 insertions / 22 deletions** — Batch
1478 (`e69d3e4fc7`), which changed what `awaitProceduralReady` counts as recorded work, and Batch
1480 (`39283ec388`), which added the pre-tonemap capture path. Those are the *when* and the *what*
of a measurement. The probe itself and the other five libraries are byte-identical. So the sentence
"at the ruling's own tree" is false, "on a byte-identical engine" is false, **and "with a
byte-identical instrument" — the form the claim takes in `R-2026-09-19-2`'s question text and in §4
Q1 below — is false as well. The substitution rests on no measured identity at all.** This
correction binds every occurrence of all three claims in this document, including the one in §6
corrected in place below and the Q1 text §4 carries.
Found by the adversarial critic **Bingo** (Opus) under `R-2026-09-11-1`, while judging the close
patch that rested on this paragraph — before it landed.

**The S5 matrix is not "run six probes", and it is not what v1 said either.** Noakes N-02 is correct
and I re-read every artifact myself: `output/edge-tranche3e-e-2026-08-29/j1-dense-cost/` holds a
**complete** artifact set whose verdict JSON reads `status "STRUCTURAL"`, `exitCode 3`,
`incomplete false`, `legs []` and **seven named structural reasons**, and whose `j1-dense-cost.log`
ends `lockReleasedByOwnedReceipt: true` with the full eight-step publication order
**[Lily-reverified 2026-09-19]**. The three repairs v1 budgeted 4-6 h for **already exist and work**.
Dense-cost's actual blocker is that it is a **dependent** lane: its own `pendingError` spells out the
chain — run `probe-c12-29-s5-terrain-selection.mjs`, archive that run through
`visual-evidence-library.mjs archive --producer … --status PASS --exit-code 0`, pass the resulting
`manifest.json` as `--terrain-publication`, and the same again for `--nasa-publication`
(`probe-c12-29-s5-dense-cost.mjs:91-92`, `:127-129`, `:309`, `:347`, `:445`)
**[Lily-reverified 2026-09-19]**. It refuses in seconds when run alone. Its 6 h 22 m ceiling
(`:3771-3775`, 24 × (900,000 + 30,000) + 600,000 = 22,920,000 ms) is real arithmetic but is **not the
risk being managed**. Replacement-device is **not** "0 runs": `j1-replacement-device/8a1f6a67….json`
is a banked browser run, `status "ERROR"`, `exitCode 2`, reason *"replacement-device executed
measurementSha256 is not canonical"*, thrown from `page.evaluate` **[Lily-reverified 2026-09-19]**.
And multiview's exit 2 failed on **both** backends — its own diagnostics read *"multiview
self-validation failed: webgl: offscreen ray pick is invalid; webgpu: offscreen ray pick is
invalid"*, `stage "node"` **[Lily-reverified 2026-09-19]** — so v1's WebGPU-only `hit === false`
hypothesis cannot explain it (Noakes N-08, accepted).

**Two of the S5 gate specs are RED at HEAD, and none of the ten is homed in any runner.** I ran both:
`c12-29-s5-custom-ellipsoid-gate.spec.mjs` is **204 pass / 1 fail** — test 154 *"source map proves
every frozen production entry byte-for-byte"*, reading the **build**, so it is red on any tree whose
`Build/` is stale; `c12-29-s5-replacement-device-gate.spec.mjs` is **36 pass / 1 fail** — test 5,
`ENOENT … package-lock.json` at `:1376-1378`, a file this project deliberately does not keep
**[both Lily-reverified 2026-09-19]**. There are **ten** `c12-29-s5-*.spec.mjs`, not eleven (the
eleventh tracked `c12-29-s5-*` path is `c12-29-s5-custom-ellipsoid-harness.html`), `grep -c "c12-29"
package.json` is **0**, and so are the counts for `c12-31-aureole-gate.spec`,
`celestial-gate-class-audit`, `finding-ownership-audit`, `visual-evidence-library.spec`,
`eclipse-globe-shadow-visual`, `eclipse-deckfree-night-law` and `verify-no-doc-shred`
**[Lily-reverified 2026-09-19]**. The runner name is **already ratified** — `R-2026-09-02-16`
(`MAINTAINER_RULINGS_2026-09-02.md:26`) fixes a seven-name family set including **`test-s5`**, and
`test-s5`, `typecheck-tooling`, `typecheck-visual-probe-contracts` and `test-webgpu-error-gate` are
all still **MISSING** from `package.json`: NEVER-BUILT since that ruling (Noakes N-03, accepted).

**Six C12 items v1 never named, four of which the closing statement cannot omit.** From the queue's
own §0 and ASKS: **G1 is RED at close and carried to *proposed* C17 as `CLT-D10`** (`:20`, `:50`, on
`R-2026-08-21-14`) and **C17 is unlaunched**; **`C12-11`** is RETURNED TO HELD with ten architecture
blockers plus a hermeticity red and closes *out of the gate* under `R-2026-08-21-16` (`:42`, `:51`);
**`C11-79`** stays in C11 and **`C12-26`** (earth-limb airglow) defers to C17 under the same ruling
(`:51`); **`probe-stars-catalog.mjs`** is named residual instrument debt on both the G3 lane (`:21`)
and `C12-11` (`:42`); **`C12-12`'s KTX2 half** stays tooling-blocked as
`C12-12-KTX2-SKYBOX-NOT-BUNDLED` (`:44`); and **DR-01 is explicitly NOT decided** — the OWED list
(`:56`) makes a certifying asset the precondition for a clean single-variable revisit, and the
2026-08-29 G3 stamp records that the asset variable **is now eliminated** (`:22`), so the revisit is
live **[all Lily-reverified 2026-09-19]** (Noakes N-05, accepted). §5's close conditions **1** and
**5** are also never mentioned in v1: condition 1 (`C12-03`/`C11-175` adapter pairing) is **COMPLETE
2026-07-28** and condition 5 is a constraint rather than a deliverable — both are stated here so a
reader cannot conclude they were overlooked.

**Option C is not silent on S5 after all.** `MAINTAINER_RULINGS_2026-08-10.md:41-46` reads: *"Option
A — narrow the gate to S1/S2/S4/S6, transfer S3 formally to C13-41 … Option C (re-file S3/S4 as C13
rows and close C12-29) **remains the ledger-cleanest variant of A**"* **[Lily-reverified
2026-09-19]**. Option C therefore **inherits A's narrowed list**, which excludes S5. v1 called this
undefined; it is not — it is available from the ruling's own words. So Q3 below is put as *confirm
this reading*, together with what it costs: under it S5 leaves the gate **unmet**, with 15 banked runs
in the queue's own honest table (`:383-387`) and **1 PASS** (Noakes N-12.2, accepted).

**Realistic shape of the work:** **one Node lane tonight that answers the deck-free question off
banked evidence**; two more Node lanes (record round; S5 roster) tonight; **~45 min of Edge that is a
repeat measurement and needs a maintainer line first**; ~3 h of Edge for the four owed S5 lanes plus a
dependent dense-cost lane that must run *in the same session, after* terrain and NASA publish and are
archived; one docs batch of ~18 edits across 8 live documents; and **nine** maintainer sittings. If
the maintainer confirms Q3, C12 can be *closed* this weekend and the remainder re-homed as named
follow-ups. If not, C12 is the maximal gate under another name and C14/C15 stay held behind a browser
backlog measured in days.

## 2. Ordered steps

`needsEdgeSlot` = takes the machine's single browser slot. Estimates carry their basis.
Acceptance is stated as an **observable outcome**, never as "the lane did the thing".
**Order changed in v2:** the deck-free repair moved from step 4 to step 1 and lost its only claimed
landing dependency; the Edge run moved from step 1 to step 6 and is now gated on a maintainer line.

### Phase A — tonight / Saturday, Node only, no Edge slot

| # | id | what | kind | dependsOn | Edge? | estimate (basis) | ACCEPTANCE |
|---|---|---|---|---|---|---|---|
| 1 | `S3-N1-DECKFREE` | Repair the deck-free control's light identity: `lightSideMatches` keys on `side?.constructorName === kind` (`lib/c13-41-deckfree-control.mjs:348`, consumed at `:366-370`) against the literal `"DirectionalLight"`, while esbuild emits `DirectionalLight2`. Match on the `isSunLight` / `isDirectionalLight` brand flags already carried in the same evidence object, or normalise esbuild's numeric suffix. **Confine the change to the Node-side gate lib** so the probe and the served engine bundle are untouched. Today's spec certifies the brief, not the bundle — it *synthesises* the field (`spec:506` builds `constructorName: kind`); the new spec must pin **both** the mangled and unmangled forms | node-lane | **none** — v1's `CI-EVAL-FIX` dependency is dead: `npm run test-cloud-c13` at HEAD is **641 pass / 0 fail, exit 0** and `package.json` reads `overrides.eslint = "$eslint"` **[both Lily-reverified 2026-09-19]** | no | **3-4 h** incl. spec + inertness mutant + Opus review. Tools-class bar (`R-2026-08-29-1`), runner home `test-cloud-c13` (which contains `eclipse-cloud-response-gate.spec.mjs` **[Lily-reverified]**) | A fixture carrying `constructorName: "DirectionalLight2"` with correct brand flags scores `deckFreeControlStateIsolated` **true**; a fixture carrying a genuinely wrong light (`isDirectionalLight: false`, or wrong intensity/colour/direction) still scores **false**; the fix made inert (`if (false && …)`) turns the new spec red; `npm run test-cloud-c13` stays at 641/0 |
| 2 | `S3-N1b-RESCORE` | **New in v2, and the step that makes the Edge night optional.** Re-score the **banked** 2026-09-03 evidence with the repaired predicate: read `output/eclipse-cloud-response-2026-09-02b/probe-output/eclipse-cloud-response-report.json`, feed `webgpuCloudLanes.deckFreeControl.sessions` (4 elements, present **[Lily-reverified 2026-09-19]**) plus that block's own `factorTolerance`, `scheduleObscurationTolerance` and rung ladder to `foldDeckFreeControlSessions` (`:431`), and record what `stateIsolated` becomes. This answers `R-2026-09-13-1`'s **second red trigger on evidence already captured at the ruling's own tree**, with no browser | node-lane | `S3-N1-DECKFREE` | no | **1-2 h**: pure function, banked input, no build, no server | A banked re-score receipt records three results from the same input: (a) the **repaired** predicate over the banked sessions → `stateIsolated` and the residual `structuralReasons`; (b) the **original** predicate over the same input → the 16 constructor-name reasons reproduced exactly (negative control 1, proves the re-score reaches the predicate); (c) a mutated session with a genuinely wrong light → still not isolated (negative control 2). The receipt states in its own words that it scores **only** trigger 2 and is silent on `shadowContrastInvariant` |
| 3 | `REC-7-RECORD` | Record round 7, record-only. v1's list **plus five additions**: stamp `R-2026-09-02-7` into the C12 queue (intake item 4, the G3 cell, the C12-12 tier cell, M-06..M-10) and **repoint §5's stale G3 close clause at `R-2026-09-02-7` rather than "repairing" it by citing the 2026-08-29 re-bake** — under that ruling G3's red is *by construction*, and the tier stays uncommitted until the fetch path **and** a licence determination exist, neither of which does (Noakes N-12.1); repair §0's G3 self-contradiction (`:21` "NOT YET EXECUTED at HEAD" four lines above `:22` recording the execution); add `C12-36`, `C12-28`, `C12-38`, `C12-38b` to §0's OPEN list; **correct the S5 honest table (`:383-387`), which records dense-cost / multiview / replacement-device as "never executed in a browser" while three 2026-08-29 artifacts exist** (my own finding, L-B — totals move 15 → 18 banked); **file the gate lib's stale mechanism citations** (`lib/eclipse-cloud-response-gate.mjs:414-418` cites `ProceduralClouds.wgsl:2643/2644/2658`; the block is now at `:2833/:2834/:2865`, Noakes N-07b); record tonight's `C15-05`/`C15-06` release; repoint `DEFERRED_WORK.md:2464` → `:2549`; **track or transcribe all THREE untracked basis documents** — `STOP_CHECKPOINT_2026-09-13.md`, `RESTART_CHECKPOINT_2026-09-12.md` **and `migration_doc/branches/SUNDISC_RECONCILIATION_2026-09-02.md`**, which is `??` in `git status` and is the cited basis of the `C12-38b` row at `QUEUE_2026-07-19_CAMPAIGN12.md:2505` **[Lily-reverified 2026-09-19]** (Noakes N-13) | docs-lane | none | no | **3-4 h** incl. independent Opus review (docs bar, `R-2026-08-29-1`: review + no spec) | `git grep -c "R-2026-09-02-7" -- migration_doc/QUEUE_2026-07-19_CAMPAIGN12.md` ≥ 1 (**0 today**); §0's OPEN list names all four missing rows; the S5 table's totals read 18 banked / 1 PASS; all three basis documents are tracked or transcribed; `npm run verify-readme-index` and `npm run verify-tracked-references` exit 0; `node Tools/verify-no-doc-shred.mjs` exits 0; `node --test Tools/visual-regression/finding-ownership-audit.spec.mjs` 9/9; **`npm run verify-doc-citations` reports no citation dead that was live at `245cdc7e9d`** — it exits **1** today with *"FAIL: 51 dead citation(s), 241 advisory(ies)"*, none of them in the C12 or C13 queues **[Lily-reverified 2026-09-19]**, so the packet enumerates those 51 as the pinned baseline (Noakes N-04) |
| 4 | `S5-ROSTER` | Name the matrix's lanes. The tree carries **six** `probe-c12-29-s5-*.mjs` and six gate libs (+ one capture helper); the queue's honest table tabulates six; "seven-lane" appears in 12 live `migration_doc` files and **none enumerates seven**. Either name the seventh or retire the count with a dated note. **Same row (v2):** record that `FINDING_DISPOSITIONS_2026-08-13.json` carries only **three** S5 owners — `C12-29-S5-TERRAIN-SELECTION` `state "closed"` with `closureRunId "83aea7d0-…"`, `C12-29-S5-CUSTOM-ELLIPSOID` `active`, `C12-29-S5-NASA-SVS` `active` — so **dense-cost, multiview and replacement-device have no machine-readable owner at all** **[Lily-reverified 2026-09-19]** (Noakes N-09) | docs-lane | none (seat call; maintainer may own it) | no | **1-1.5 h** | The queue's S5 section carries a numbered roster, each lane with its probe path, its gate-lib path, its banked-run state **and its ledger owner or an explicit "no owner"**; every surviving "seven-lane" occurrence resolves to that roster or carries the dated correction |
| 5 | `S5-N4-RUNNERS` (DX) | Home the orphan specs under the **ratified** name. `R-2026-09-02-16` (`MAINTAINER_RULINGS_2026-09-02.md:26`) already fixes `test-s5` as one of the seven family names — **implement it, do not invent a runner**. Scope is **ten** `c12-29-s5-*.spec.mjs` (not eleven) plus `c12-31-aureole-gate.spec.mjs`, `celestial-gate-class-audit.spec.mjs`, `finding-ownership-audit.spec.mjs`, `eclipse-deckfree-night-law.spec.mjs`, `visual-evidence-library.spec.mjs`, `eclipse-globe-shadow-visual.spec.mjs` — all `grep -c` **0** in `package.json` **[Lily-reverified 2026-09-19]** — and an npm script for `Tools/verify-no-doc-shred.mjs`. Two cannot run bounded (`svs-footprint`, `dense-cost-gate`) → quarantine runner per `R-2026-09-13-2`(A). **Two are RED and must be fixed or declared build-dependent in this row**: custom-ellipsoid 204/1 (test 154 reads the build's sourcemap) and replacement-device 36/1 (`ENOENT package-lock.json` at `:1376-1378` — a file this project deliberately does not keep) | node-lane | none | no | **3-4 h** (up from 2-3: two real spec repairs) | `grep -c "c12-29" package.json` > 0 and the runner is named `test-s5`; **every spec homed under it is green** — i.e. custom-ellipsoid and replacement-device are repaired, or moved behind a runner that builds first with the dependency stated; the two slow ones appear only under the quarantine runner; `finding-ownership-audit.spec.mjs` runs under a named runner |
| 6 | `S5-N1-MULTIVIEW` | **Re-scoped in v2.** (a) Retain `session.offscreenRayPick` on the error path — `createC1229S5MultiviewErrorArtifact` (`lib/c12-29-s5-multiview-gate.mjs:2738`) drops the session objects, so the 2026-08-29 exit 2 is undiagnosable. Worth doing on its own. (b) Diagnose that exit 2 from the **shared** cause: its diagnostics say the offscreen ray pick was invalid on **both** backends **[Lily-reverified 2026-09-19]**, so it is a session / offscreen-view construction defect, not a renderer-policy defect. (c) **File separately as a latent defect** the real policy clash v1 conflated with it: the WebGPU arm requires `supportsSynchronousReadback === false && hit === false && hitGlobe === false && objectPresent === false && position === null` (`:1440-1451`) while `WebGPUContext.ts:1929-1931` says `Scene.pickFromRay` *"still returns its hit object with `position` undefined"* — a Principle-10 stale premise inside a close-gate instrument | node-lane | none | no | **(a) 1-2 h; (b) unsized until (a) lands a diagnosable artifact; (c) 30 min to file.** v1's "4-6 h, genuinely uncertain" had no basis and conflated three things | (a) A replayed 2026-08-29-shaped error artifact retains the session objects and names **which** conjunct failed, **per renderer**; (b) the both-backend invalidity is attributed to a named construction step with evidence; (c) the `hit === false` clash exists as its own filed row with its `file:line` pair |
| 7 | `EXIT-2-CONFIRM` | §5 close-condition 2 freshness re-read: `node --test Tools/visual-regression/celestial-gate-class-audit.spec.mjs`. **v1 mis-sized this.** I ran it at HEAD on the seat's **dirty** tree: **6 pass / 0 fail in 4.15 s** **[Lily-reverified 2026-09-19]**, and the queue's own 2026-08-28 intake table row 7 already reads *"§5 exit tail EXIT-2 \| **DISCHARGED**"* (`:86`) with FINDING 1 recording that the ordering caveat was met when lane F landed at Batch 1167 | node-lane | none | no | **10 min** (measured 4.15 s + recording) | The audit reports 6/0 and that transcript with its tree hash is quoted into §5 condition 2. **If a clean-tree reading is wanted, use a throwaway clone** — do **not** stash the maintainer-**held** 4096 tier (Q9's own subject under `R-2026-09-02-7`) to make `git status --porcelain` empty |
| 8 | `C12-31-FINDINGS` | Dispose of review findings #4 and #6, OPEN since 2026-08-14. **v1 called them "uncertain until read"; they are written verbatim in 27 lines at `lib/c12-31-aureole-gate.mjs:17-43`** **[Lily-reverified 2026-09-19]**: **#4** — `beginC1231AureoleEvidence` re-folds the prior `.latest.json` but never reads `<prefix>.<prior.runId>.json` and compares bytes, so a rewritten predecessor that still folds clean is accepted (the retained-first-red path *does* make that archive comparison); **#6** — launch / `newPage` / `page.close` / `browser.close` are awaited with no per-operation timeout and no observed-closure evidence reaches the artifact, and #7's residual (the watchdog-timeout path exits without releasing the lock) is explicitly assigned to #6. Both are bounded Node edits with obvious negative controls | node-lane | none | no | **3-4 h**, now costed rather than "uncertain" | Each finding is either closed with its evidence, or is a scored predicate in `lib/c12-31-aureole-gate.mjs` whose negative control fires: for #4, a byte-rewritten predecessor that still folds clean is **refused**; for #6, a hung close is reported as a bounded timeout with the lock released |
| 9 | `S3-N2-REFRESHCOST` | The **second, independent** S3 blocker: `refreshCostMeasured` is FALSE because *"pair 0 eclipse: the pre-segment GPU readback drain did not close (timedOut=true, undrained=1)"*. **v1 called this "uncertain — may reach the IBL pipeline". It is a named file.** `packages/engine/Source/Renderer/WebGPU/WebGPUTimestampProfiler.ts` is the **only** engine file mentioning `undrained` (`git grep -l`), owns `timedOut` (`:604-609`), calls `readbackBuffer.mapAsync` directly at `:641`, and is **unchanged since `ea651de6d8`** (last touched Batch 1165 `c27ca59021`) **[all Lily-reverified 2026-09-19]**. Batch **1506** (`54907f3815`, 2026-09-18) routed mapped-buffer readbacks through one `finally`-scoped helper — `WebGPUBufferMapper.ts` (+255/−75), `WebGPUPerformanceManager.ts` (+33) — and the profiler was **not** migrated. The row is: migrate the profiler's readback onto that helper and prove the drain closes | node-lane, engine class | none (v1 made this depend on `S3-N1-DECKFREE`; it does not) | no | **1 day**, engine bar (`R-2026-08-29-1`: behaviour spec + inertness mutant + separate review + a named Edge leg) | A refresh-cost leg returns `webgpuCost.valid === true` from a GPU-timestamp source rather than the wall-clock bound, on a run where `refreshCostMeasured` scores; and a spec pins that a timed-out drain is reported, not silently counted as `undrained` |

### Phase B — Edge, in the order the slot allows

| # | id | what | kind | dependsOn | Edge? | estimate (basis) | ACCEPTANCE |
|---|---|---|---|---|---|---|---|
| 10 | `S3-EDGE-LEG-E` | Job 13c leg (e): `PROBE_BASE=http://localhost:8096 node Tools/visual-regression/probe-eclipse-cloud-response.mjs --exposure-sweep` on `F:/Dev/GH/cesium-lane-bandobras-20260913` @ `ea651de6d8`. **Brief must be RE-ISSUED, not reused** (Noakes N-06): its ORDER line reads *"after job 13c's legs (a), (b) both renderers, (c) and (b3) are banked"* and its §Run line 35 reads *"Never edit the probe or the gate module"* — the first forbids this position, the second forbids the step-1 overlay. Strike both with the reason recorded. **Preflight must whitelist** ` M migration_doc/MAINTAINER_RULINGS_2026-08-17.md` in the clone — an LF→CRLF-only change with an empty diff, which cannot reach the probe (it gates through `lib/build-source-identity.mjs`) but **will** trip any empty-porcelain assertion, and that pattern exists here (`lib/celestial-capture-harness.mjs:93`, `lib/visual-gate-policy.mjs:315`) **[Lily-reverified 2026-09-19]**. No rebuild: clone build md5 `ea4d26a1f266d76da0cbfc7d4d0617d9` **[Lily-reverified 2026-09-19]** | edge-job | **`MAINT-Q0`** (instrument-overlay permission) + **`MAINT-Q1`** (is a repeat measurement what the ruling means) + `S3-N1b-RESCORE` | **yes** | **~45 min**: probe measured 4 m 51 s on 2026-09-03 with the same flag; watchdog 720 s + 60 s grace; server start + md5 preflight + banking ~25-30 min | Receipts under `output/eclipse-cloud-response-2026-09-13/` in the 2026-09-02b shape (README/command/exit/started/finished/preflight/stdout/stderr/probe-output + the two deepest-rung PNGs); `exit.txt` carries the code; and `verdicts.shadowContrastInvariant`, `verdicts.shadowContrastRatioAtDeepest`, `structuralReasons[]`, `unscoredPredicates[]` are each quoted verbatim beside their 2026-09-03 values (`false`; `1.0341102079879674`; the 16 constructor-name reasons; 9 unscored) |
| 11 | `ARM-EXECUTE` | Execute whichever arm of `R-2026-09-13-1` fired — §6 gives both, step by step | docs-lane | step 10 (or `MAINT-Q1` answered on the banked sweep), `MAINT-Q3` | no | RED arm **4-6 h** (≈18 edits / 8 documents / 1 ledger + independent Opus review); GREEN arm opens four more lanes (§6b) | §6a or §6b's acceptance, whichever fired |
| 12 | `S5-EDGE-SESSION` | **v1's steps 10 and 11 merged — this is the correction that matters.** ONE session on a freshly built served clone, in this order: **terrain-selection → archive its run into the evidence library → svs-footprint (NASA) → archive → custom-ellipsoid → replacement-device → multiview → dense-cost with `--terrain-publication` and `--nasa-publication` pointing at those two fresh manifests.** Dense-cost run "alone, as its own night" refuses in seconds, exactly as on 2026-08-29: its `pendingError` names the three-step publication chain literally (`probe-c12-29-s5-dense-cost.mjs:347`, `:445`) **[Lily-reverified 2026-09-19]**. Brief must carry: per-lane watchdogs above 25 min so timeouts are not misread as reds; the preflight fact that five of the six gate libs hash `packages/engine/Source/Shaders/GlobeFS.js`, gitignored build output, so they ENOENT on an unbuilt clone by design; and **`--status PASS --exit-code 0` are literal, required arguments of the archive command** | edge-job | `S5-ROSTER`, `S5-N4-RUNNERS`, `S5-N1-MULTIVIEW`(a), **`MAINT-Q14`** (the terrain re-run reopens a `closed` ledger entry on a red), a built clone | **yes** | **3-4 h** for the five bounded lanes (four at 540,000 ms watchdog, replacement-device at 600,000 ms) **plus** dense-cost's own time, bounded by 6 h 22 m but unmeasured — plan the session to **stop and bank** if dense-cost is still running at the session's declared end | Each lane writes a verdict artifact with an exit code; no lane exits 2 on a *preflight* cause; dense-cost's artifact names **how many of the 24 legs completed** (0 is an acceptable answer if it is a *measured* condition with a reason, not an uncaught throw); and the two lanes that previously exited 2 (`custom-ellipsoid`, `svs-footprint`) either PASS or name a **product** predicate that failed |
| 13 | `C12-31-SWEEP` | `C12-31`'s FULL acceptance sweep (`probe-sky-aureole-anchor.mjs`, `@status ACTIVE`, landed `c572d6aa41`). Explicitly kept **IN** the gate by `R-2026-08-21-16` | edge-job | `C12-31-FINDINGS`, a built clone | **yes** | **1-1.5 h** on a built clone | The sweep writes a banked verdict on both backends **and** the receipt states in its own words what findings #4 and #6 are now bound to, or that it remains silent on them |
| 14 | `C12-12-IDENTITY` | The default-sky pixel-identity capture pair against the 2026-08-29 tranche-3d J2 pins (ground −75.16/39.95, clock `2026-08-29T05:00:00Z`, height 300,000 m, heading 0, pitch +30, 1280×720). J2 exited 0 but says *"Pixel identity — HONESTLY NOT PROVEN BY THIS JOB"* | edge-job | `MAINT-Q9` (licence) if the tier must be installed to compare; otherwise none | **yes** | **45 min** | Two captures at those exact pins on both backends with a byte/pixel comparison reported as a number — or a recorded ruling that the banked structural evidence suffices |
| 15 | `C12-13-EXIT4` | Adjudicate EXIT-4: the banner reads "EDGE ACCEPTANCE OWED" while the gate the same cell names is the Node spec `solar-glare-star-washout.spec.mjs` (41/41 at 2026-08-28) | maintainer → docs or edge | `MAINT-Q12` | conditional | **15 min** if stale; **45 min** of Edge if not | The `C12-13` cell names either a banked Edge receipt or a dated line retiring the banner, and `LICENSE.md`'s third-party attributions are confirmed current with live URLs |
| 16 | `C12-36-STARPIXEL` | `TWILIGHT-STAR-REACHABILITY-BLACK-BOX` — the named next action. The 2026-08-25 audit stamp establishes the remaining work is the **filed diagnostic, not a re-run**: the star chain carries zero non-comment change between `c810dbace2` and HEAD, so a bare re-run reproduces exit 3 | node-lane | `MAINT-Q11` | no | **half a day**, uncertain | The instrument says **why** the star-pixel leg is unreachable in terms of a measured quantity, not by returning STRUCTURAL again |
| 17 | `C12-38B-FLAGS` | Add the `sun.show=false` and bloom-off probe flags `R-2026-09-02-33`'s discriminator sweeps need and do not have. **This is a different discriminator from C13-41's** — the record uses one word for both. The sun-disc engine freeze holds until these are read, and the salvage behind them holds the only written copy of the station-3 finding that **eight mutations of the landed C12-38 fix survive all 134 tests**. **Its basis document is untracked** (`migration_doc/branches/SUNDISC_RECONCILIATION_2026-09-02.md`, `??` in `git status`, cited at queue `:2505` **[Lily-reverified 2026-09-19]**) — step 3 tracks it first | node-lane | `MAINT-Q10`, `REC-7-RECORD` | no | **3-4 h** | `probe-sun-disc-dawn.mjs` accepts both flags; a sweep with `sun.show=false` records zero sun-disc pixels and a bloom-off sweep records bloom inactive on all samples — both as banked receipts |
| 18 | `P0-2-REMAINDER` | Job 13c legs (b)-remainder (both WebGPU halves + `webgl-h2` from ~241/686 + the czml transient-CDN re-run), (c) capture-and-diff, (b3) settle control; then `R-2026-09-13-4`'s close act, now **partially dissolved** (part 2 executed out of band; part 3 undone) | edge-job | driver rebuild (a short Node lane — **these** are the drivers that were lost, not leg (e)'s) | **yes** | **~5.5-7 h** by job 13c's own sizing | Legs (b), (c) and (b3) each hold a complete receipt with an exit code on one named tree, and P0-2's close is recorded with the three-part act's current state |

**Unrecorded fork in the road on step 18, which nobody has written down:** the Bandobras clone predates
Batch 1490 (`e774ad70d3`, 2026-09-16), which landed the per-demo watchdog
(`sandcastle-smoke.mjs:416-417`, `FAILED-TIMEOUT` at `:499`), the split-per-demo report and the
browser-orphan preflight. **Resuming in-clone re-runs the stall-prone harness; resuming on the tip
moves the tree the wave-end gate is measured on.** Neither option is free. Decide it in the brief.

### 2b. Edge-slot schedule — the queue this plan enters (new in v2, Noakes N-14)

The slot is **not** free-for-the-taking; four jobs are already ordered ahead of or alongside these,
under the stated constraint *"one Edge job at a time"* (`PROBE_KIT_PLAN_2026-09-17.md:539`):

| order | job | ordered by |
|---:|---|---|
| 1 | **Kit wave B** — one Edge job: the captured-pair leg + one rendered sheet | `PROBE_KIT_PLAN_2026-09-17.md:521-522` |
| 2 | **`S3-EDGE-LEG-E`** (step 10) — *the seat's own standing recommendation was "right after kit wave B"* | `R-2026-09-02-5`, `R-2026-09-13-1`; sequencing contested, see `MAINT-Q13` |
| 3 | **C13 v2 Edge job leg 1** — recorded in `CAMPAIGN_STATE.md`'s C13 block as "now blocked on the `C13-41` slot" | `R-2026-09-12-7` as amended by `R-2026-09-13-6` |
| 4 | **`C15-01`'s karma twin** — "owed to the wave's Edge job" | `CAMPAIGN_STATE.md` C15 block |
| 5 | **`S5-EDGE-SESSION`** (step 12), then steps 13, 14, 18 | this plan |

`CAMPAIGN_STATE.md:480-487` still reads *"P0-2 closes → and only then does `C13-41`'s exposure-sweep
discriminator take the single Edge slot"* **[Lily-reverified 2026-09-19]** — stale on both halves
(L3/L4/L5's Edge legs all ran ahead of it on 2026-09-16/-17/-18, and P0-2 is still open), which is
exactly what `MAINT-Q13` asks the maintainer to strike.

## 3. What can start TONIGHT without any decision

Quiet hours ended at 19:00; **today is Saturday 2026-09-19, unrestricted** — landings are open all
weekend and the rule re-arms Monday 07:00 ET.

**v1 put the Edge run at the top of this list. v2 removes it.** Three things changed that: the run
can only return BLIND on trigger 2 with the unrepaired instrument (§1); the brief that governs it
forbids both the position and the repair (Noakes N-06); and its own §4 already carried `MAINT-Q13` as
the line needed to run it ahead of P0-2 — v1 contradicted itself by also listing it here. It is one or
the other, and it is the other.

**Start tonight, no decision needed, no Edge slot:**

1. **`S3-N1-DECKFREE`** (step 1) — the deck-free gate repair. Its only claimed blocker is gone:
   `npm run test-cloud-c13` is **641 pass / 0 fail, exit 0** at HEAD and the manifest conflict was
   fixed by Batch 1513 **[both Lily-reverified 2026-09-19]**. Nothing gates writing, reviewing or
   landing it.
2. **`S3-N1b-RESCORE`** (step 2) — re-score the banked 2026-09-03 evidence with the repaired
   predicate. This is the lane that can answer `R-2026-09-13-1`'s second trigger **tonight**, off
   disk, with two negative controls. It is the highest-value hour in the whole plan.
3. **`REC-7-RECORD`** (step 3) — the record round, now carrying five more corrections.
4. **`S5-ROSTER`** (step 4) — naming the lanes and the three lanes with no ledger owner.
5. **`S5-N4-RUNNERS`** (step 5) — `test-s5` under its ratified name, plus the two red specs.
6. **`S5-N1-MULTIVIEW`(a) and (c)** (step 6) — retain the session objects on the error path; file the
   `hit === false` clash as its own row.
7. **`EXIT-2-CONFIRM`** (step 7) — ten minutes, of which 4.15 s is the spec.
8. **`C12-31-FINDINGS`** (step 8) — the two findings are readable in 27 lines; cost the row properly
   and do it.
9. **`S3-N2-REFRESHCOST`** (step 9) — engine class, so it owes the full bar and a named Edge leg at
   the end, but the *work* — migrating `WebGPUTimestampProfiler`'s readback onto Batch 1506's
   `WebGPUBufferMapper` helper — starts tonight with no decision.

**Needs a maintainer line before it starts:** `S3-EDGE-LEG-E` (`MAINT-Q0` + `MAINT-Q1` + `MAINT-Q13`),
`S5-EDGE-SESSION` (`MAINT-Q5`), and everything in §6a (`MAINT-Q3`).

**One stop rule to hand any executor of step 10** (it costs nothing and prevents the one bad outcome):
if the run comes back **red on `shadowContrastInvariant`**, Option C fires as ruled and the seat
proceeds. If it comes back **in band on `shadowContrastInvariant` but BLIND on the deck-free lane**,
the seat **banks the receipt and stops before executing the arm** — that is the case where a campaign
closes on an esbuild rename. With steps 1 and 2 done first this case should be impossible; the rule
stays as the belt to that braces.

## 4. Maintainer items

Each is one question, with a recommended answer and only sound options. **Q0 and Q14 are new in v2;
Q1, Q3 and Q13 are restated.** Nine sittings, not six.

**Q0 — NEW, and the one that decides whether the Edge night buys an answer.** The standing brief
`scratchpad/brief-edge-c13-41-discriminator.md` says verbatim, at line 35, *"Never edit the probe or
the gate module"*. The deck-free repair (step 1) edits the gate module. It is a **Node-side scoring**
change: applied as an overlay onto the Bandobras clone it leaves the served engine bundle
byte-identical (`Build/CesiumUnminified/Cesium.js` md5 `ea4d26a1f266d76da0cbfc7d4d0617d9`, re-verified
2026-09-19), so the measurement is still on the engine `R-2026-09-13-1` names. *May the instrument be
repaired on the ruling's tree, provided the served engine bundle is byte-identical?*
**Recommend: yes, with the byte-identity asserted in the preflight and quoted in the receipt.**
Without it, any run of leg (e) fires red trigger 2 with certainty (`lib/c13-41-deckfree-control.mjs:348`
vs the bundle's `DirectionalLight2`, both re-verified 2026-09-19) and the campaign closes on an
esbuild rename.

**Q1 — RESTATED, and now the sharpest question in the set.** `R-2026-09-13-1` is conditional on
"tonight's re-run". That re-run never happened. But the sweep it re-decides **did** run, on the same
tree, with a **byte-identical** instrument, and it is banked: `shadowContrastInvariant: false`,
`shadowContrastRatioAtDeepest: 1.0341102079879674`, nine unscored predicates, 16 constructor-name
structural reasons **[Lily-reverified 2026-09-19]**. A literal re-run is therefore a **repeat
measurement of a banked result**, not a new observation. Two sound readings:
(i) the ruling means a *fresh* run and one must be taken (≈45 min of Edge, plus Q0 and Q13);
(ii) the ruling's condition is **already satisfied by the 2026-09-03 sweep**, whose red trigger 1 is
on disk, and what was actually owed was the deck-free repair — which step 2 discharges off the same
banked evidence, tonight, with no browser.
**Recommend (ii), with (i) as a cheap confirmation afterwards if wanted.** Under (ii) ARM RED fires
tonight on evidence already in hand and C14 unblocks a week earlier. And answer the **third outcome**
in the same line: a run with `shadowContrastInvariant` in band, the control lane scored, and the
WebGPU refresh-cost drain failing again calls `markBlind("refresh-cost")` and exits **3 STRUCTURAL** —
neither red trigger, not a PASS. *Which arm does an exit 2 or exit 3 fire?* **Recommend: neither** —
bank it, re-run once after `S3-N2-REFRESHCOST` lands; a second structural result fires Option C on the
ground that the instrument cannot answer at honest cost.

**Q2 — which tree.** `R-2026-09-13-1` names `ea651de6d8`; the tip is 31 batches ahead, and Batch 1504
(`ba9f4ff3bb`) deleted `clamp(midDist / 60000.0 * cloud.aerialStrength, 0.0, 0.85)` — the exact term
the deck pre-registrations were fitted to (CO-17 measured lane A's aerial share as 0.654 at a ~39 km
midpoint; 39000/60000 = 0.650). The removal is **understated** in v1: in
`packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl` the block the gate's
mechanism argues from has moved from `:2643/:2644/:2658` to `:2833/:2834/:2865`, `:2249` records the
replacement in its own words, a far-target inscatter branch now exists at `:2901-2917` that did not
when CO-22 was derived, and `WebGPUCloudRenderer.ts` changed again at Batch 1508.
**Recommend: `ea651de6d8`, unchanged from v1 and strengthened.** Exact ruling fit, zero build, and it
keeps the pre-registrations intact — at the tip a fresh deck red would be a C13-N20 consequence, not
an S3 finding, and would put an unexplained red into S3's closure record permanently. A tip reading is
worth having **later**, as its own job, after C13-N20 has its own deck pre-registration. Batches
1504/1507/1508 **do not** invalidate banked S3/S4/S5 evidence — every banked run is stamped to its own
tree; what they invalidate is the *tip* as a comparison base for S3.

**Q3 — RESTATED as a confirmation, not an open term. Does "close C12" carry the remainder forward?**
v1 called Option C's silence on S5 undefined. It is not: `MAINTAINER_RULINGS_2026-08-10.md:41-46` says
Option A narrows the gate to **S1/S2/S4/S6** and that *"Option C … remains the ledger-cleanest variant
of A"*, so **Option C inherits A's narrowed list and S5 is excluded** **[Lily-reverified 2026-09-19]**.
*Confirm that reading.* What it costs, stated plainly: S5 leaves the gate **unmet**, at 15 banked runs
(18 counting the three 2026-08-29 artifacts the queue table omits) and **1 PASS**, with three of its
six lanes carrying no ledger owner.
**Recommend (a): confirm, and close with every carried item named in the closing statement and
re-homed explicitly** — S5's lanes and `C12-31`'s sweep into the Edge queue as their own rows;
`C12-12`'s and `C12-13`'s acceptances beside them; `C12-33` ×2, `C12-28`'s HDR check and the licence
determination onto the maintainer's own list; `G1`/`CLT-D10`, `C12-11`, `C11-79`, `C12-26`,
`probe-stars-catalog`, the KTX2 half and the live DR-01 revisit named with their homes. Option (b) —
close only once they are met — is not a close; it is the maximal gate under another name.
**Answer this before the Option-C docs batch is written: it determines every word of the closing
statement.**

**Q4 — the aurora release collides with `R-2026-09-17-9`.** Option C's red arm says "release the
aurora R4 hold"; `R-2026-09-17-9` routes `C15-03..08`, `C15-06P`, `C15-07H` through *"a later one-line
ruling once the contact sheet exists (DX-105)"*, and DX-105 has not landed.
**Recommend:** Option C lifts the **R4 hold**; the contact-sheet condition is a *sequencing*
preference for the rows that need something to iterate on, not a second hold. Say which, because the
two texts currently read as contradictory.

**Q5 — unblock or launch C14?** `RULING-2026-08-06` R1 makes C12 completion C14's sole remaining bar;
`CAMPAIGN_STATE.md:235` records C14 as "Not launched" with a ratified identity and plan. No ruling in
the set launches it.
**Recommend: unblock only.** Launching has always been a separate directive here (C16, C18). Record
C14 as UNBLOCKED / NOT LAUNCHED — C13 v2, the Gemini fix waves and the probe kit are all in flight.

**Q6 — `C12-33` debt (a), the banking route.** The certification reads `status PASS / exitCode 0 /
certificationEligible true / designId sign-test-v1` and **has no `runId` key at all** — I parsed it:
the key set is `schema, schemaVersion, campaign, certificationClaim, doesNotMeasure, designId,
preregistrationSha256, filedDiscrepancy, producer, finalizedAt, status, exitCode,
certificationEligible, structuralFailures, acceptanceFailures, calibration, reviewer, sources`
**[Lily-verified 2026-09-18, independently re-parsed by the critic 2026-09-19]** — while
`assertFinalArtifact` (`lib/visual-evidence-library.mjs:837-852`) fails any `kind:"run"` publication
whose `artifact.runId !== options.runId`. Sound options: (i) extend the schema with `runId` — this
**changes the artefact's sha256**, currently stamped in the queue as `c2a0bcf9…fb9ed`, so the custody
hash must be re-stamped in the same act; (ii) publish under a kind that does not assert it;
(iii) accept the certification as formally unbanked with the reason recorded.
**Recommend (i) plus a re-stamp** — a small Node lane and a re-bank of the existing artefact, no
re-run. **But answer the rider first:** all 18 banked `c12-33-moon-mip-motion` publications read
`NON_CERTIFYING / exit 3 / eligible false` while the certification folded from them reads
`PASS / 0 / true`, and the 2026-08-25 audit says that *"should be answered before a banking route is
chosen"*.

**Q7 — `C12-33` debt (b), the countersign.** `review-attestation-20260824b.json`, sha256
`430de639…e2518`, `reviewedAt 2026-08-25T00:17:32.525Z`, `verdict PASS`, and `reviewer.identity` reads
verbatim `"opus-5-station-3-seam-review-pattern-v4-maintainer-countersign-owed"` — a self-asserted
automated label. Each of its three findings states the countersignature is OWED.
**Recommend:** one sitting — read the three findings against the named samples (00/06/12 on WebGL, 06
on WebGPU) and sign; the signature binds to the sha256 above. No machine work clears this one.

**Q8 — `C12-28`'s manual HDR-hardware check.** Named in §5's own W4 gate row. Unreachable by any
probe: headless Edge reports the opposite and there is no CDP override for `dynamic-range`, so a probe
could only exercise the SDR leg — which is required to be byte-identical and would pass with the
feature reverted.
**Recommend:** a sitting on a real HDR display — confirm `scene.highDynamicRange === true` untouched,
then that `hdrDisplayPolicy = 'scene-and-canvas'` produces a correct extended-range image on WebGPU.

**Q9 — the Tycho-2 licence determination.** `R-2026-09-02-7` makes it, **together with a fetch path**,
the release condition for the 4096 tier: the twelve JPEGs and the policy file *"stay uncommitted until
the fetch path and a licence determination … exist"*. **The fetch path is NOT BUILT**, and the held
files are live in the seat working tree right now — `SkyBoxResolutionPolicy.ts` and
`skybox-resolution-policy.spec.mjs` modified, twelve `tycho2t5_80_[diffuse_]4096_*.jpg` untracked
**[Lily-reverified 2026-09-19 in `git status`]**.
**Recommend:** make the determination and schedule the fetch path, or record that the tier stays
uncommitted indefinitely and strike it from C12's close set. **Do not let any step's acceptance be met
by stashing these files** to produce an empty `git status --porcelain` (see step 7).

**Q10 — is `C12-38` in the exit gate?** The row says "not in the current C12 exit gate **until
triaged**". Triage happened 2026-08-25, the option-A fix landed Batch 1184, and **no ruling records
the in/out call**. Its acceptance ran 2026-09-03 and FAILED (exit 3 then exit 1; chroma:webgpu 0.9659
< 0.9677, parity 0.0233 > 0.02; disc-centre luminance WebGL 0.971-0.976 vs WebGPU 0.310-0.323).
**Recommend: OUT**, filed as a C17/follow-up row with its measured red visible.

**Q11 — is `C12-36`'s star-pixel leg in the gate?** `C12-36` is not in §0's OPEN list at all, yet the
row says it remains incomplete and `FEATURE_INVENTORY.md:1283` carries it as acceptance-open.
**Recommend:** one line either way, like `R-2026-08-21-16` did for the other four. My suggestion is
**IN as a named follow-up, OUT of the gate** — the remaining work is a filed diagnostic, not a re-run.

**Q12 — `C12-13` / EXIT-4.** The banner says "EDGE ACCEPTANCE OWED"; the gate the same cell names is a
Node spec at 41/41. `C14_READINESS_REVIEW_2026-08-28.md:84` flagged the identical banner on `C12-13`
and `C12-14`; `C12-14`'s has resolved, `C12-13`'s has not.
**Recommend:** one line — "the banner is stale; EXIT-4 rides the Node spec" — unless a
licence-attribution capture is wanted, in which case it is 45 minutes of Edge.

**Q13 — RESTATED, and v1's internal contradiction resolved.** `CAMPAIGN_STATE.md:480-487` still reads
*"P0-2 closes → and only then does `C13-41`'s exposure-sweep discriminator take the single Edge
slot"* **[Lily-reverified 2026-09-19]**, and the discriminator brief's ORDER line puts leg (e) after
job 13c's legs (a)/(b)/(c)/(b3). Both are stale: L3/L4/L5's Edge legs all ran ahead of the
discriminator (2026-09-16/-17/-18) and P0-2 is still open — six Edge jobs have taken the slot since
2026-09-16 without P0-2 closing. **v1 listed this run under both "needs a maintainer line" and "no
decision required". It needs the line.**
**Recommend:** one line — *"`C13-41`'s discriminator takes the slot on its own merits; P0-2's
remaining legs do not stand in front of it, and the brief's ORDER clause is struck"* — plus dated
correction hunks to `CAMPAIGN_STATE.md:480-487` and the brief in `REC-7-RECORD`. Also worth recording:
`R-2026-09-13-6`'s precondition ("after tonight's discriminator re-run") never happened and the engine
legs ran anyway; and `R-2026-09-13-4`'s three-part close is no longer atomic.

**Q14 — NEW. The terrain-selection re-run reopens a closed ledger entry if it goes red.**
`FINDING_DISPOSITIONS_2026-08-13.json` carries `C12-29-S5-TERRAIN-SELECTION` at `state "closed"` with
`closureRunId "83aea7d0-7c8e-4543-8818-7cc459cb01c3"` — the queue's honest table records that lane at
12 runs / **1 PASS**, that same run **[Lily-reverified 2026-09-19]**. But dense-cost **requires** a
fresh terrain publication: its own `pendingError` names the three-step chain and refuses without it.
So the re-run is not optional if S5 is to be completed, and a red would force `finding-ownership-audit`
(9/9 today) to demand the `closed` entry be reopened. *Proceed with the re-run knowing a red reopens a
closed lane, or leave dense-cost unrun?*
**Recommend: proceed, with the reopen consequence written into the brief and into `S5-ROSTER`
beforehand**, so a red is a recorded outcome rather than a surprise that stalls the session. If Q3 is
answered (a), this question becomes optional — S5 leaves the gate and the session can be scheduled at
leisure.

## 5. Risks — what turns this into a longer campaign

**R1 — the contrast red is very likely a REAL defect, not an instrument artefact.** Unlike the BLIND,
the `shadowContrastInvariant` red has a derived mechanism: CO-17's closed form has no free parameter,
the directional-only model is the supremum of the whole split family, and the measured 1.0341 sits
against `predicted` 1.00035 / `supremum` 1.00084 **[Lily-verified 2026-09-18 in the banked JSON]** —
~59× past the family cap. The reading has drifted 1.0555 → 1.0496 → 1.0341 and the band top is 1.03,
so it is only 0.0041 outside; an in-band reading would itself need explaining rather than being a
clean green. **If the maintainer ever wants S3 to *close* rather than re-file, that is an engine
investigation of unknown size, not a re-run.**

**R2 — closing a campaign on an esbuild rename.** This is the risk I would not let pass silently, and
v2 removes it structurally rather than containing it. `R-2026-09-13-1` fires Option C on *either*
trigger, and the second is *"deck-free control lane still BLIND"*. The probe reads
`light.constructor.name` (`probe:1606`), the bundle emits `function DirectionalLight2(options)` (seat
build `grep -c` = 1 at HEAD, and the Bandobras build — two independent builds), the gate demands
`constructorName === "DirectionalLight"` exactly (`lib/c13-41-deckfree-control.mjs:348`, `:366-370`),
and the banked run carries 16 identical isolation reasons while `isDirectionalLight`, `sameObject`,
`diagnosticOnly`, `litSurfaceNonVacuous` and `nonVacuityReasons` are all correct
**[all Lily-reverified 2026-09-19]**. `SunLight` is **not** renamed (`grep -c "function SunLight2("`
= 0), which is why the sibling restore check works and review never saw it; and the gate spec is green
because it *synthesises* the field (`spec:506`) instead of observing a bundle — Principle 10's exact
failure mode. `RR-2026-09-13-E` priced this repair as "a control redesign"; it is a predicate fix in
one Node-side file. Executing Option C on it is compliant with the ruling as written, and it is also
the instrument-defect-as-product-defect inversion `RULING_AUDIT_2026-08-18.md:49` banks as this
project's core lesson. **Steps 1 and 2 remove the risk instead of containing it.**

**R3 — REVISED. S5's lanes are three different problems, and v1 misdiagnosed two of them.**
(a) Dense-cost is a **dependent** lane, not a broken one: its coordinator wrote a complete verdict
artifact with seven named prerequisite reasons, released its lock (`lockReleasedByOwnedReceipt: true`)
and refused correctly — the repairs v1 budgeted for already exist **[Lily-reverified 2026-09-19]**.
Its risk is *scheduling*: it must run after terrain and NASA publish **and are archived**, in the same
session. (b) Multiview's exit 2 failed on **both** backends (*"webgl: offscreen ray pick is invalid;
webgpu: offscreen ray pick is invalid"*), so it is a session-construction defect; the `hit === false`
vs `WebGPUContext.ts:1929-1931` clash is a **separate latent defect**, real but not the cause, and
until they are separated no estimate on it has a basis. (c) Replacement-device has a **banked browser
run** (ERROR / exit 2, *"executed measurementSha256 is not canonical"*), not zero runs. What survives
of v1's risk is narrower and truer: **two of six lanes have a diagnosed blocker, one has a scheduling
dependency, and three of six have no ledger owner at all.**

**R4 — the base-commit question can poison the closure record.** Batch 1504 removed the aerial term
the deck pre-registrations (`deckPureRatioInBand` 0.635 ± 0.01, the `s = 0.7101` / `e = 1.01`
decomposition) were derived against, and the gate lib's own mechanism citations now point at moved
lines (`:2643/:2644/:2658` → `:2833/:2834/:2865`) **[Lily-reverified 2026-09-19]**. A tip run risks a
*fresh* deck red that is a C13-N20 consequence misfiled as an S3 finding. It would not change which
arm fires, but it would land an unexplained red in S3's closure record permanently. **The stale
citations are themselves a repair row in `REC-7-RECORD`** — otherwise the next reader re-derives the
mechanism from lines that no longer say what is quoted.

**R5 — `refreshCostMeasured` cannot be discharged by any run of this instrument, and v2 names its
owner.** It has its own blindness domain (`gate:1756`) and its own defect, so it returns **UNSCORED,
never FAILED**. It is one of `R-2026-08-14-1`'s two restored exit conditions, so **even a fully green
discriminator leaves S3 short of its own exit criteria — ARM GREEN is strictly more work than ARM
RED.** The defect is not open-ended: `WebGPUTimestampProfiler.ts` is the only engine file mentioning
`undrained`, owns `timedOut`, calls `mapAsync` directly at `:641`, and was not migrated onto Batch
1506's `WebGPUBufferMapper` helper **[all Lily-reverified 2026-09-19]**. Separately, the FAIL-capable
successor `refreshCostWithinBudget`, ordered by `R-2026-08-18-27`, is **NEVER-BUILT**.

**R6 — the ledger has no legal state for "re-filed".** `finding-ownership-audit.spec.mjs` closes the
owner state model over exactly `{active, closed, reopened}` and pins `closed-by-certifying-pass`
entries to `closed` or `reopened`; `active` additionally forbids `closureRunId`. Setting
`owners["C13-41"].state = "active"` turns the spec red. It also asserts every owner's `reference`
string still appears in the document it names — so **an Option-C edit that deletes or rewords
`"S4 COMPLETE / EDGE VERIFIED 2026-08-12"` from the C12 queue, or `R-2026-08-14-1` from the C13 queue,
goes red in the same commit.** The re-file must be a **document act, not a ledger act**, and the
closing ruling should say so in one line. Do **not** widen the spec's tables in the same commit.
**Pointed the other way, the same hazard applies to the terrain re-run** (Q14): a red there forces the
`closed` entry with `closureRunId "83aea7d0-…"` to be reopened, and this spec is the gate on it.

**R7 — record fragility, three documents not two.** `STOP_CHECKPOINT_2026-09-13.md` and
`RESTART_CHECKPOINT_2026-09-12.md` are untracked scratchpad files (`git ls-files migration_doc/`
returns neither), yet `MAINTAINER_RULINGS_2026-09-13.md` cites the stop checkpoint as the basis for
four "Executed" lines and `DEFERRED_WORK.md:2545` cites it as its `Source:`. **Add
`migration_doc/branches/SUNDISC_RECONCILIATION_2026-09-02.md`**, which is `??` in `git status` and is
the cited basis of the `C12-38b` row (`QUEUE_2026-07-19_CAMPAIGN12.md:2505`) — step 17's subject
**[all Lily-reverified 2026-09-19]**. A temp-hygiene sweep orphans all three. `REC-7-RECORD` fixes it.

**R8 — Q3 unanswered turns the close into a rename.** If "close C12" is read as (b), nothing unblocks
and the seat spends a weekend producing a closing statement that closes nothing.

**R9 — NEW. The Edge slot is contended and this plan never sequenced against it.** Four jobs are
already ordered: kit wave B's single Edge job (`PROBE_KIT_PLAN_2026-09-17.md:521-522`), C13 v2's leg 1
(blocked on the `C13-41` slot per the C13 block), `C15-01`'s karma twin (owed to the wave's Edge job),
and the P0-2 remainder — under *"one Edge job at a time"* (`:539`) **[all Lily-reverified
2026-09-19]**. §2b schedules them. Without that, the plan's Edge steps collide with work already
ordered and the collision is adjudicated by whoever dispatches first.

**R10 — NEW. "Closed" must mean listed, not relabelled.** For ARM RED's acceptance sentence to be
*truthful*, `CAMPAIGN_STATE.md`'s C12 block must carry, in one list: G1 RED → C17/`CLT-D10` (C17
unlaunched); G3 RED **by construction** under `R-2026-09-02-7` with the tier unshipped and the fetch
path **NOT BUILT**; `C12-11` HELD, out of gate, with its Batch-1109 instrument of record; S5's six
lanes at 18 banked runs / 1 PASS with three lanes unowned; `C12-31`'s sweep never run with findings
#4/#6 open; `C12-12`'s identity capture and its KTX2 half; `C12-13`'s EXIT-4 banner; `C12-33`'s two
maintainer debts; `C12-28`'s HDR sitting; `C12-36`; `C12-38`/`C12-38b`; `C11-79` and `C12-26` with
their homes; `probe-stars-catalog`; and **DR-01 undecided**. **Anything omitted from that list is
being closed by relabelling.**

### CI: does either fix have to land before a C12 lane? — REWRITTEN, v1's answer inverted

**v1's whole CI section is stale and its load-bearing conclusion is false.** Measured by me at HEAD
`245cdc7e9d` on **2026-09-19**:

- **`npm run test-cloud-c13` → 641 pass / 0 fail, exit 0** (the whole 29-spec runner). v1 reported
  `wgsl-mini-eval.spec.mjs` at "3 pass / 1 fail"; Batch 1507 rewrote the evaluator and **Batch 1514
  (`245cdc7e9d`, 2026-09-18 23:53)** finished the job — its own message records that the three reds
  lived in "two specs that no landing runs".
- **`package.json` reads `overrides.eslint = "$eslint"` with `devDependencies.eslint = "10.10.0"`** —
  the npm reference form, no conflict — landed by **Batch 1513 (`58c5147763`, 23:44:44)**, four
  minutes after v1 was written. v1's "`overrides.eslint = "10.10.0"` vs `devDependencies.eslint =
  "^10.9.1"`" is false at HEAD.

**Consequence, and it is the reason step 1 moved to the front:** v1 made `S3-N1-DECKFREE` depend on
`CI-EVAL-FIX` *for landing*, on the ground that `lib/c13-41-deckfree-control.mjs` is consumed by
`eclipse-cloud-response-gate.spec.mjs`, homed in `test-cloud-c13`, which was red. **That runner is
green. The dependency is dead and `CI-EVAL-FIX` is struck from the plan.** The deck-free repair has no
landing blocker of any kind, and the two things v1 put in front of it are both already executed.

What remains true from v1: **worker clones never run `npm install`** —
`Tools/provision-worker-clone.mjs` junctions `node_modules` from the seat (`:734-744`, `:784`)
**[Lily-verified 2026-09-18]**, which is also the standing rule — so no manifest state could ever have
reached an Edge run path. And `verify-doc-citations` is a **separate** red that v1 never measured: it
exits **1** at HEAD with *"FAIL: 51 dead citation(s), 241 advisory(ies)"*, all in the archive sweep and
**none** in the C12 or C13 queues, while `verify-readme-index` (316 paths, 0 violations) and
`verify-tracked-references` both exit 0 **[all Lily-reverified 2026-09-19]**. Every acceptance in v1
that required `verify-doc-citations` to exit 0 was unreachable; v2 pins the 51 as an enumerated
baseline and owes the archive re-point its own repair row under `R-2026-09-13-2`(B).

## 6. Both arms of `R-2026-09-13-1`, step by step

The ruling, verbatim at `MAINTAINER_RULINGS_2026-09-13.md:15`, with its
*"Executed: **NOT EXECUTED**"* line at `:21-24` **[both Lily-reverified 2026-09-19]**:

> CONDITIONAL ON TONIGHT'S RE-RUN. If Bandobras's leg (e) on ea651de6d8 is red again on
> shadowContrastInvariant (outside [0.97, 1.03]) or its deck-free control lane is still BLIND, the seat
> executes Option C of R-2026-08-10-1 (re-file S3/S4 as C13 rows, close C12, unblock C14, release the
> aurora R4 hold); if it turns green, S3 continues. No further round-trip; both sweeps go into the
> record either way.

**How to read the receipt, mechanically.** Red trigger 1: `verdicts.shadowContrastInvariant === false`,
i.e. `verdicts.shadowContrastRatioAtDeepest` outside `[0.97, 1.03]`. Red trigger 2: a
`structuralReasons` entry beginning *"the deck-free control is not four fresh ABBA configure
epochs…"*, or `deckFreeControlStateIsolated` present in `unscoredPredicates`. Either alone suffices.
Green: trigger 1 false **and** trigger 2 absent. Exit contract: `0 PASS / 1 gate FAIL / 2 HARNESS /
3 STRUCTURAL`.

~~**Which arm the evidence already on disk points at.** The 2026-09-03 banked sweep on `ea651de6d8`
reads trigger 1 **fired** (`shadowContrastInvariant: false`, ratio `1.0341102079879674`) and trigger 2
**fired** (16 constructor-name structural reasons; `deckFreeControlStateIsolated` among nine
`unscoredPredicates`) **[Lily-reverified 2026-09-19]**. Under Q1 reading (ii), ARM RED is already
determined; under reading (i) it must be re-observed. Trigger 2's firing is an instrument artefact
(R2) and steps 1-2 dispose of it; trigger 1's is not (R1).~~

**CORRECTED 2026-09-19** by the batch that carries this line — struck above, restated here, nothing
deleted. **That sweep ran on `fbea2028cc` (Batch 1403), not on `ea651de6d8`** (its own receipt's
"Clone commit" line; see the dated correction before §1). Its values are quoted correctly and the
two triggers did fire **on that tree**. **But the question this paragraph asks has since been
answered by measurement rather than by inference:** leg (e) was taken on **2026-09-19** on
`ea651de6d8` itself, and **neither trigger fired** —
`shadowContrastInvariant` **true** at **0.9893862265081094**, `deckFreeControlStateIsolated`
**true**. See the dated section **"Leg (e) result, 2026-09-19"** at the end of this document. The
run is nonetheless **GATE FAIL, exit 1**, on `deckPureRatioInBand`.

### 6a. ARM RED — Option C fires

1. **Bank first.** Receipts to `Tools/visual-regression/output/eclipse-cloud-response-2026-09-13/` in
   the 2026-09-02b shape; append the numbers to `RR-2026-09-13-E`
   (`RULING_REQUESTS_2026-09-08.md:181-236`, which reserves that append in its own words). If ARM RED
   fires on the **banked** sweep under Q1(ii), bank the `S3-N1b-RESCORE` receipt instead and say so.
2. **Check the two triggers separately.** If trigger 1 fired, proceed. If **only** trigger 2 fired,
   apply the §3 stop rule and put R2 to the maintainer before continuing.
3. **Record the ruling.** A dated entry: leg (e) / the banked sweep returned RED on `<predicate(s)>`
   at tree `<hash>`; Option C of `R-2026-08-10-1` is exercised **on the reading that it inherits
   Option A's narrowed gate (S1/S2/S4/S6)**; C12 closes with the dispositions in Q3's answer. Flip
   `R-2026-09-13-1`'s "Executed: NOT EXECUTED" to name the batch. A **new** rulings file needs a
   `migration_doc/README.md` index row or `verify-readme-index` exits 1.
4. **The document batch — ~18 edits across 8 live documents** (Angelica's §4b is the edit table with
   current text and line numbers; use it verbatim, **plus the six items v1 omitted**):
   `QUEUE_2026-07-19_CAMPAIGN12.md` §0 `C12-29` row + §5 close text + the GATES cells + **the S5
   honest table's 15→18 totals**;
   `QUEUE_2026-07-23_CAMPAIGN13.md:166` and `:895` (drop the "ELEVATED TO THE C14 CRITICAL PATH"
   framing; **keep `C13-41` OPEN** — `RULING-2026-08-06` R2 forbids redefining C13's deliverable);
   `CAMPAIGN_STATE.md` C12 (closing statement **carrying R10's full list**), C13, C14 (UNBLOCKED /
   **NOT LAUNCHED**), C15 (R4 lift), **and the stale `:480-487` sequencing paragraph**;
   `QUEUE_2026-08-02_CAMPAIGN15.md:13-26` and `:387-396` (every `HELD (R4)` cell);
   `DEFERRED_WORK.md:5411` (annotate, do not rewrite — recorded verbatim by design), `:7415`,
   `:7387-7403`, `:2549`; `CAMPAIGN_PORTFOLIO_QUEUE.md:35`, `:122`, `:421`; `migration_doc/README.md`.
   **The closing statement must name, each with its new home:** `G1`/`CLT-D10` (and a check that the
   C17 packet still carries it at `CELESTIAL_LIGHT_TRANSPORT_PLAN_2026-08-07.md:433`); `C12-11` with
   its Batch-1109 instrument of record for a post-C12 certification; `C11-79` (stays in C11);
   `C12-26` (defers to C17); `probe-stars-catalog.mjs`; `C12-12-KTX2-SKYBOX-NOT-BUNDLED`; and **the
   live DR-01 revisit**, now a clean single-variable question because the 2026-08-29 G3 stamp
   eliminated the asset variable. State also that §5 close condition 1 (`C12-03`/`C11-175` adapter
   pairing) is **COMPLETE 2026-07-28** and condition 5 is a constraint, not a deliverable — so a
   reader cannot conclude they were overlooked.
5. **Leave the machine-readable ledger alone.** `FINDING_DISPOSITIONS_2026-08-13.json`
   `owners["C13-41"].state` stays `reopened`; `C12-29-S4` stays as it is; the three S5 lanes with no
   owner stay ownerless **and are recorded as such in `S5-ROSTER`**, so "closing" S5 by relabelling
   cannot leave three lanes with no disposition at all. Say so in the ruling (R6). Preserve the exact
   strings `"S4 COMPLETE / EDGE VERIFIED 2026-08-12"` (C12 queue) and `"R-2026-08-14-1"` (C13 queue).
6. **FEATURE_INVENTORY:** no §C→§B promotion — Option C ships no feature. Update the `C12-29 S3` /
   `C13-41` §C row (`:1068`) onto the new ruling and the new home; `C12-29 S5` (`:1283`) stays in §C
   unless Q3 says otherwise. Separately fix the EXIT-3 drift: `:1281` still carries `C12-14` as
   *"Scaffolding with no consumer; acceptance owed"* while the queue row `:2465` records its Edge
   acceptance EXECUTED 2026-08-28, "Row complete."
7. **Verifiers, all of them, before the push:** `node Tools/verify-no-doc-shred.mjs` (by hand — no npm
   script; this is a large scripted multi-document markdown batch, the exact shred risk profile);
   `npm run verify-readme-index` (exit 0 today); `npm run verify-tracked-references` (exit 0 today);
   `npm run verify-doc-citations` — **which exits 1 today with 51 pre-existing dead citations, none in
   the C12/C13 queues; the bar is therefore "no NEW dead citation", with the 51 enumerated in the
   packet** — re-run it after **every** `DEFERRED_WORK` / `CAMPAIGN_STATE` edit, because line anchors
   move and `DEFERRED_WORK.md:2464` is *already* stale for `RR-2026-09-13-E`, whose live text is at
   `:2549`; `npm run test-landing-rules` + `npm run verify-landing`;
   `node --test Tools/visual-regression/finding-ownership-audit.spec.mjs` by hand (9/9 today).
8. **Proof bar:** docs class (`R-2026-08-29-1`) — independent Opus station-3 review, **no spec, no
   Edge leg owed by the batch itself**.
9. **Then the remainder,** per Q3(a): S5, `C12-31`, `C12-12`, `C12-13` into the Edge queue as named
   rows **behind the jobs already ordered in §2b**; `C12-33` ×2, `C12-28`, the licence determination
   **and the unbuilt fetch path** onto the maintainer's list; `C12-36`, `C12-38`/`C12-38b` per
   Q10/Q11. **C12 is closed; C14 is unblocked and not launched; the R4 aurora hold is lifted per Q4.**

**ACCEPTANCE for ARM RED:** `CAMPAIGN_STATE.md`'s C12 block reads CLOSED with a dated ruling id **and
carries R10's list in full**; its C14 block reads UNBLOCKED / NOT LAUNCHED; no `HELD (R4)` cell
survives in the C15 queue except any the Q4 answer deliberately keeps; `git grep -n "sole remaining
bar is"` returns nothing pointing at C12; `verify-readme-index`, `verify-tracked-references`,
`verify-no-doc-shred`, `test-landing-rules`, `verify-landing` and `finding-ownership-audit` all pass,
and `verify-doc-citations` reports **no dead citation that was live at `245cdc7e9d`**.

### 6b. ARM GREEN — S3 continues

1. Bank the receipt and append to `RR-2026-09-13-E` exactly as in 6a step 1.
2. Record that the green arm fired, with the measured `shadowContrastRatioAtDeepest` and the fact that
   the deck-free lane scored — **and note whether it scored because of the step-1 repair**, since a
   green trigger 2 obtained by repairing the instrument is a different fact from one obtained without.
3. **Then S3 still owes four things, and this is the honest part:**
   - `refreshCostMeasured` TRUE — blocked by `S3-N2-REFRESHCOST`, a **separate, independent** defect
     whose owner is now named: `WebGPUTimestampProfiler.ts`'s direct `mapAsync` readback (`:641`),
     unmigrated onto Batch 1506's `WebGPUBufferMapper` helper. Repairing the deck-free lane does not
     touch it.
   - The mechanism investigation of the contrast reading — `R-2026-08-14-1`'s other restored exit
     condition. The close-out sprint's Findings 3 and 6 were **both partially corrected in the same
     document** (*"the INSTANCE named in Finding 3 is wrong for this fixture"*, because lane B pins
     `{ groundAtmosphere:false, fog:false, sky:false }`), so the residue term actually present in lane
     B's fixture is **not established**.
   - Band tightening against the observed margins, flipping `status` off `DERIVED` — with the row's own
     warning attached: *widening a band to make the first run pass is the failure mode every `why`
     string in the gate module exists to make visible.*
   - Independent review of the reading: this row's numbers are the campaign's most-cited and have been
     misread twice already.
4. Only then may `owners["C13-41"].state` move `reopened → closed` **with the new `closureRunId`**
   (legal under the `closed` shape), the `C12-29` slice state update, and the `FEATURE_INVENTORY` §C
   entries.
5. **And C12 is still not closed** — every item in §2 Phase B except S3 survives ARM GREEN untouched,
   and so does every item in R10's list.

**ACCEPTANCE for ARM GREEN:** a banked run in which `verdicts.shadowContrastInvariant` is true,
`deckFreeControlStateIsolated` is scored true, and `unscoredPredicates` is empty **or** contains only
predicates named in a recorded disposition — after which the four items above are each an open row with
an owner, not a sentence in a summary.

## 7. Non-claims

- I did not run the probe, open a browser, build anything, or write outside this folder. No git
  writes, no Python. In this v2 pass I **did** run, at HEAD `245cdc7e9d` on 2026-09-19:
  `npm run test-cloud-c13` (641/0, exit 0), `npm run verify-doc-citations` (exit 1, 51 dead),
  `node --test` on `c12-29-s5-replacement-device-gate.spec.mjs` (36/1),
  `c12-29-s5-custom-ellipsoid-gate.spec.mjs` (204/1) and
  `celestial-gate-class-audit.spec.mjs` (6/0 in 4.15 s).
- I make **no** prediction about what a re-run would measure for `shadowContrastRatioAtDeepest`. R1
  states the derived mechanism and the 0.0041 margin; it does not forecast the number. My claim about
  trigger 2 is about the predicate only, and is decidable from source.
- The deck-free root cause is Nina's finding; I re-derived it independently end to end (probe source,
  both gate-lib predicates, two independent bundles, the banked JSON read-back, and the
  `ea651de6d8..245cdc7e9d` instrument diff) and it holds.
- **`S3-N1b-RESCORE` is my own proposal, not a re-derivation of anyone's finding.** What I verified is
  that its input exists: `webgpuCloudLanes.deckFreeControl.sessions` is a 4-element array in the
  banked report and `foldDeckFreeControlSessions` (`:431`) is an exported pure function over
  `{sessions, ladder, certifiedRungs, factorTolerance, scheduleObscurationTolerance, captureDelta,
  diagnosticSite}`. I did **not** write or run the re-score harness, so whether the repaired predicate
  actually flips `stateIsolated` on that input is the lane's job to establish, not a claim of mine.
- Receipt directories were **listed**, then individual JSON/TXT files read by name. Nothing under
  `Tools/visual-regression/output` was searched recursively.
- Nora reads the S5 matrix as seven lanes with `probe-eclipse-globe-shadow.mjs` as the seventh;
  Angelica and Noakes read it as six. I verified the tree carries **six** S5 probes and six S5 gate
  libs (plus a capture helper) and take no position on the seventh — that is `S5-ROSTER`'s job.
- I did not re-run `finding-ownership-audit.spec.mjs` (9/9 per Angelica 2026-09-18 and Noakes
  2026-09-19), nor the two long S5 specs (`svs-footprint`, `dense-cost-gate`) that this plan
  quarantines.

*Lily, 2026-09-19 (v2).*

---

## 8. Changes after critique — every finding in `CRITIQUE_NOAKES.md`, with its disposition

Written by **Lily**, 2026-09-19, after reading `CRITIQUE_NOAKES.md` in full. **Principle 10 binds a
critique exactly as it binds a queue row**, so I re-ran or re-read the cited `file:line` for all
fourteen findings before accepting any of them. **Fourteen accepted (one with a material correction);
none rejected.** Two findings of my own were added.

| # | finding | disposition | what I measured, and where the edit landed |
|---|---|---|---|
| **N-01** | The discriminator cannot return green; its arm is pre-determined; the repair that would let it answer is no longer blocked | **ACCEPTED — the largest single change in v2** | Re-derived: `lib/c13-41-deckfree-control.mjs:348` is `side?.constructorName === kind`; `grep -c "function DirectionalLight2("` over `Build/CesiumUnminified/Cesium.js` = **1**, `function SunLight2(` = **0**; `git diff ea651de6d8..245cdc7e9d` over the probe + five consumed libs is **empty**. Both claimed blockers gone: `npm run test-cloud-c13` **641/0 exit 0**, `overrides.eslint = "$eslint"`. **Edits:** deck-free repair moved to **step 1** with `dependsOn: none`; Edge run moved to **step 10** gated on `MAINT-Q0`; `CI-EVAL-FIX` struck from the plan entirely; §5's CI subsection rewritten; §1, §3, R2 rewritten |
| **N-02** | Steps 5/6/11 rest on a misread receipt: dense-cost's verdict artifact, lock release and prerequisite refusal all exist | **ACCEPTED** | Read the artifacts myself: `8123136e….json` = `status "STRUCTURAL"`, `exitCode 3`, `incomplete false`, `legs []`, seven named structural reasons; `j1-dense-cost.log` ends `lockReleasedByOwnedReceipt: true` with the eight-step `publicationOrder`; `j1-replacement-device/8a1f6a67….json` = ERROR/2 from `page.evaluate`; `edge-tranche3d` J5 files begin `TAP version 13`. Also read the full `pendingError`, which names the three-step publication chain literally. **Edits:** v1 step 6 **deleted**; v1 steps 10 and 11 **merged** into step 12 `S5-EDGE-SESSION` with the publication order written into the row; §1 and R3 rewritten |
| **N-03** | Two S5 gate specs are RED at HEAD; the count is ten not eleven; `test-s5` is already ratified | **ACCEPTED** | Ran both: custom-ellipsoid **204/1** (test 154, sourcemap-vs-build), replacement-device **36/1** (`ENOENT … package-lock.json` at `:1376-1378`). `git ls-files "Tools/visual-regression/c12-29-s5-*.spec.mjs" \| wc -l` = **10**. `R-2026-09-02-16` (`MAINTAINER_RULINGS_2026-09-02.md:26`) names `test-s5` in the ratified seven. Confirmed `grep -c` = 0 in `package.json` for all six extra specs Noakes listed plus `verify-no-doc-shred`. **Edits:** step 5 rewritten — ratified name, corrected count, two spec repairs in scope, extra specs added; estimate 2-3 h → 3-4 h |
| **N-04** | `verify-doc-citations` already exits 1, so every acceptance requiring exit 0 is unreachable | **ACCEPTED** | Ran it: exit **1**, *"FAIL: 51 dead citation(s), 241 advisory(ies)"*; `verify-readme-index` and `verify-tracked-references` both exit **0**. **Edits:** step 3's acceptance and §6a step 7 now read "no NEW dead citation, with the 51 enumerated as the pinned baseline", and the archive re-point is owed its own repair row |
| **N-05** | Six C12 items never named; four cannot be omitted from the closing statement | **ACCEPTED** | Read the queue's own §0 and ASKS: G1 RED → C17/`CLT-D10` on `R-2026-08-21-14` with **C17 unlaunched** (`:20`, `:50`); `C12-11` RETURNED TO HELD, closes out of gate (`:42`, `:51`); `C11-79` stays in C11 and `C12-26` defers to C17 (`:51`); `probe-stars-catalog.mjs` (`:21`, `:42`); KTX2 half (`:44`); DR-01 **not decided**, and the 2026-08-29 stamp eliminates the asset variable (`:22`, `:56`). **Edits:** all six named in §1, in §6a step 4's edit table, and in R10's truthfulness list; §5 close conditions 1 and 5 stated explicitly |
| **N-06** | The brief forbids running leg (e) in the position v1 puts it, and forbids the overlay; Q13 contradicts §3 | **ACCEPTED** | Read the brief: ORDER line 3 = *"after job 13c's legs (a), (b) both renderers, (c) and (b3) are banked"*; line 35 = *"Never edit the probe or the gate module"*. `CAMPAIGN_STATE.md:480-487` still carries the P0-2-first sequencing. **Edits:** step 10 says the brief must be **re-issued**, not reused; the contradiction is resolved **against** §3 — the Edge run left `canStartTonight`; `MAINT-Q0` added for the overlay; Q13 restated |
| **N-07** | The Bandobras clone is not clean; the gate lib's mechanism citations have moved | **ACCEPTED** | `git status --porcelain` in the clone returns ` M migration_doc/MAINTAINER_RULINGS_2026-08-17.md`; `git diff` on it prints only the LF→CRLF warning with an empty patch; HEAD `ea651de6d8…` and build md5 `ea4d26a1f266d76da0cbfc7d4d0617d9` both confirmed. **Edits:** step 10 carries a preflight whitelist naming that file and the two empty-porcelain assertion sites; "clean" struck from §3; the `:2643→:2833` citation drift filed as a repair row inside `REC-7-RECORD` and restated in R4 |
| **N-08** | The multiview hypothesis is contradicted by the artifact it explains — both backends failed | **ACCEPTED** | Read `5323314a….json`: *"multiview self-validation failed: webgl: offscreen ray pick is invalid; webgpu: offscreen ray pick is invalid"*, `stage "node"`, exit 2. **Edits:** step 6 split into (a) retain session objects, (b) diagnose the shared cause, (c) file the `hit === false` clash as a separate latent defect; v1's "4-6 h, genuinely uncertain" replaced with a per-part estimate and an explicit "unsized until (a)"; R3 rewritten |
| **N-09** | The ledger closes one of the five lanes step 10 would re-run and does not know three of the six | **ACCEPTED — with one material correction** | Parsed the ledger: exactly three S5 owners — terrain-selection `closed` with `closureRunId "83aea7d0-…"`, custom-ellipsoid `active`, NASA-SVS `active`. **My correction:** Noakes offers "leave it and spend the slot on the four that are owed" as an option. It is not available — dense-cost's `pendingError` **requires** a fresh terrain publication, so the terrain re-run is a prerequisite, not a freshness whim. **Edits:** the deliberate-brief half is adopted (step 12 `dependsOn: MAINT-Q14`); the leave-it half is declined with that evidence; `MAINT-Q14` added; `S5-ROSTER` records the three unowned lanes; R6 points the hazard both ways |
| **N-10** | Three estimates without a basis | **ACCEPTED, all three** | (1) `celestial-gate-class-audit.spec.mjs` = **6/0 in 4.15 s** on the seat's **dirty** tree, and the queue's intake row 7 (`:86`) already reads **DISCHARGED** → step 7 re-sized 30 min → 10 min, with an explicit "do not stash the held 4096 tier" clause. (2) The `C12-31` findings are verbatim at `lib/c12-31-aureole-gate.mjs:17-43` — I read all 27 lines → step 8 now states both findings and their negative controls; "uncertain" struck. (3) `git grep -l undrained -- packages/engine/Source` returns **only** `WebGPUTimestampProfiler.ts`; it calls `mapAsync` at `:641`, is unchanged since `ea651de6d8` (Batch 1165 `c27ca59021`), and Batch **1506** (`54907f3815`) landed `WebGPUBufferMapper.ts` without migrating it → step 9 re-scoped from "may reach the IBL pipeline" to a named file with a landed pattern to adopt; R5 rewritten |
| **N-11** | §5's CI section is stale and its conclusion inverts | **ACCEPTED and extended** | Noakes's base was `58c5147763`; **HEAD is `245cdc7e9d` (Batch 1514, 23:53:02)**, one further commit, which is the batch that finished the evaluator repair. Measured `test-cloud-c13` **641/0 exit 0** at that tip myself. **Edits:** base commit restated in the header; §5's CI subsection rewritten end to end; `CI-EVAL-FIX` struck; "the install fix should land tonight" struck as already executed |
| **N-12** | What "closed" has to mean, and the two places v1 closes by relabelling | **ACCEPTED, both parts** | (a) `R-2026-09-02-7` (`MAINTAINER_RULINGS_2026-09-02.md:17`) makes G3's red *by construction* and holds the tier until **fetch path AND licence**; the fetch path is NOT BUILT and the twelve JPEGs + `SkyBoxResolutionPolicy.ts` are still untracked/modified in the seat tree → step 3 now **repoints** §5's clause at that ruling instead of "repairing" it by citing the run; Q9 restated to name the unbuilt fetch path. (b) `MAINTAINER_RULINGS_2026-08-10.md:41-46` reads Option C as *"the ledger-cleanest variant of A"*, and A narrows to S1/S2/S4/S6 → **Q3 restated as a confirmation, not an undefined term**, with its cost stated. (c) R10 added: the explicit list that ARM RED's acceptance sentence must carry to be truthful |
| **N-13** | One more untracked basis document than R7 names | **ACCEPTED** | `git ls-files migration_doc/` returns neither checkpoint; `git status` shows `?? migration_doc/branches/SUNDISC_RECONCILIATION_2026-09-02.md`, cited at `QUEUE_2026-07-19_CAMPAIGN12.md:2505` as the `C12-38b` basis. **Edits:** R7 and step 3 now name **all three**; step 17 depends on step 3 for that reason |
| **N-14** | The Edge queue is not empty and the plan never sequences against it | **ACCEPTED** | Read `PROBE_KIT_PLAN_2026-09-17.md:518-542` (kit wave B's single Edge job; *"one Edge job at a time"* at `:539`) and `CAMPAIGN_STATE.md`'s C13 and C15 blocks. **Edits:** new **§2b Edge-slot schedule** naming all five jobs and the ruling that orders each; R9 added; §3 no longer calls the slot "free for the taking" |

### Two findings of my own, added in v2

| id | finding | where it landed |
|---|---|---|
| **L-A** | **The deck-free question does not need the Edge slot at all.** The 2026-09-03 sweep's raw evidence is banked: `output/eclipse-cloud-response-2026-09-02b/probe-output/eclipse-cloud-response-report.json` carries `webgpuCloudLanes.deckFreeControl.sessions` as a **4-element array** — the exact `sessions` input of `foldDeckFreeControlSessions` (`lib/c13-41-deckfree-control.mjs:431`, an exported pure function) — together with that block's `factorTolerance`, `scheduleObscurationTolerance`, `rungs`, 16 `structuralReasons`, `nonVacuityReasons: []` and 40 occurrences of `DirectionalLight2` **[Lily-reverified 2026-09-19]**. So the repaired predicate can be re-scored **offline, tonight**, against evidence captured at the ruling's own tree, with the original predicate as negative control 1 and a wrong-light fixture as negative control 2 | New **step 2 `S3-N1b-RESCORE`**; the header's "single most consequential change"; `MAINT-Q1` restated around it; §6's "which arm the evidence already on disk points at"; flagged as a proposal, not a re-derivation, in §7 |
| **L-B** | **The queue's own S5 honest table is stale.** `QUEUE_2026-07-19_CAMPAIGN12.md:383-387` records dense-cost, multiview and replacement-device at **0 banked runs / "never executed in a browser"** and totals **15 banked**, while three 2026-08-29 artifacts exist — one of them (replacement-device) thrown from `page.evaluate`, i.e. unambiguously in a browser **[Lily-reverified 2026-09-19]**. The corrected total is **18 banked / 1 PASS** | Added to **step 3 `REC-7-RECORD`**'s scope and acceptance; carried into §1, §6a step 4 and R10 |

### What v1 got right and v2 keeps unchanged

The deck-free root cause and its two-bundle confirmation; Q2's adjudication in favour of `ea651de6d8`
(strengthened by N-07's citation drift); R1's derived-mechanism argument for the contrast red being a
real defect; R6's ledger-state hazard; the `C12-33` banking-route and countersign analysis (Noakes
re-parsed the certification independently and confirms the key set has no `runId`); the dense-cost
ceiling arithmetic; the observation that five of six S5 gate libs hash gitignored build output; the
`C12-38b` sun-disc discriminator being a *different* discriminator from C13-41's; and the unrecorded
fork on resuming job 13c in-clone versus on the tip.

---

## Leg (e) result, 2026-09-19 — §6a does not run; on §6's own mechanical reading, §6b ARM GREEN applies

_Appended by the batch that carries this line. **Nothing above is rewritten by this section** except
the two dated strike-and-restate corrections already marked in place. This section records a
measurement and says which of this plan's own steps it overtakes; it takes no decision._

**The run.** Leg (e) of job 13c — this plan's §6 discriminator — was taken on **2026-09-19**, Edge
executor **Filibert**, on a fresh clone at **`ea651de6d8`** per `R-2026-09-19-3`, carrying **only**
the Batch 1518 (`3e6feaae24`) deck-free control repair as an **instrument** overlay per
`R-2026-09-19-1`, with served-bundle byte-identity asserted before and after the apply
(`Build/CesiumUnminified/Cesium.js` md5 `3873edb82e25a724e00800ecfb99c811`, disk == served). It ran
the banked sweep's command, **port aside** — `PROBE_BASE` `:8094` banked against `:8098` fresh; the
rest of the invocation is character-for-character the same. Wall **3 m 53 s**, against the banked
sweep's **4 m 51 s** (22:42:57 → 22:47:48 EDT). Receipt (gitignored, seat tree):
`Tools/visual-regression/output/eclipse-cloud-response-2026-09-19/`.

**Two provenance facts the receipt records, repeated here rather than summarised away.** The clone's
`git status --porcelain` after the apply had **two** lines, not one: the repair, and
`migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md` (105 / 0), which the provisioner itself
reports as modified and which the receipt names as "not part of the instrument" — which is why the
overlay is called an *instrument* overlay above. And `npx gulp prepare` was **not** run, so
`ThirdParty/draco_decoder.wasm` was missing in the clone; the receipt records that "as a provenance
fact". **Whether either bears on the figures read below has not been measured**, and neither is
offered as an explanation of them; they are stated so no reader is told the run carried one overlay
when its own receipt records two.

**Read against §6's own mechanical definition.**

| §6 trigger | Definition | Measured 2026-09-19 |
|---|---|---|
| Red 1 | `verdicts.shadowContrastInvariant === false` | `true` — `shadowContrastRatioAtDeepest` **0.9893862265081094**, inside [0.97, 1.03]. **Did not fire.** |
| Red 2 | the deck-free structural reason, or `deckFreeControlStateIsolated` in `unscoredPredicates` | `deckFreeControlStateIsolated` **true**; no deck-free structural reason; no deck-free blind lane. **Did not fire.** |

§6's green condition is *"trigger 1 false **and** trigger 2 absent"*. **Both hold, so this is ARM
GREEN.** §6a — ARM RED, Option C fires — **does not run**, and everything whose execution this plan
routes through "the Option C close batch" is not reached: `R-2026-09-19-2`, `-4`, `-5`, `-6`, `-11`
and `-12` stay NOT EXECUTED, and the STATUS block's closing clause, *"§6a's arm has not fired"*, is
**still true**.

**And the outcome shape the maintainer has already ruled on.** `R-2026-09-19-2`, as adopted, answers
a *"third outcome"* in the same breath: *"a run with `shadowContrastInvariant` in band, the control
lane scored, and the WebGPU refresh-cost drain failing again calls `markBlind("refresh-cost")` and
exits **3 STRUCTURAL** — neither red trigger, not a PASS … **Recommend: neither** — bank it, re-run
once after `S3-N2-REFRESHCOST` lands; a second structural result fires Option C on the ground that
the instrument cannot answer at honest cost."* **This run matches all three of that sentence's named
characteristics** — contrast in band, the control lane scored, and the same readback-drain reason
blinding `refreshCostMeasured`. It differs only in **exiting 1 rather than the 3** the clause
predicts, because `deckPureRatioInBand` went red instead and the gate's exit fold
(`eclipseCloudExitCode` in
[`Tools/visual-regression/lib/eclipse-cloud-response-gate.mjs`](../Tools/visual-regression/lib/eclipse-cloud-response-gate.mjs))
ranks a non-empty `failedPredicates` above a non-empty `structuralReasons` — absent that one red the
run would have exited exactly the **3 STRUCTURAL** the clause describes. The clause's own
disposition is therefore scoped to exit 2 or 3 and **does not bind on its own terms**; but whether
this run is the §6 **GREEN** arm (*"S3 continues"*) or the adopted **"neither"** outcome (*"bank it,
re-run once after `S3-N2-REFRESHCOST` lands"*) is **not a lane's reading to take**, and the
difference is real work: the "neither" reading owes a re-run this section does not schedule. **Both
readings go to the maintainer.** What this batch records is the §6 mechanical reading, labelled as
that reading everywhere it appears; it decides nothing between them.

**Against the reading pre-registered before the run.** The seat's dispatch brief for leg (e) — the
seat's untracked scratchpad, quoted here for what it fixed *in advance*, not cited as authority —
named four cases: `shadowContrastInvariant` false → **ARM RED** whatever the exit code; **exit 0 →
ARM GREEN**, "S3 continues"; the contrast predicate true or unscored **with exit 3** → **neither**
arm; exit 2 twice → harness defect. The actual outcome — contrast **true**, **exit 1** on a third
predicate — is **not one of the four**, and the pre-registered green arm was keyed to **exit 0**,
which this run is not. The GREEN reading recorded here is therefore taken from §6's mechanical
definition **after** the result, not from the list written before it. That is said plainly rather
than left for a reader to notice.

**The run is GATE FAIL, exit 1** — stated here every time the contrast predicate is called green.
`failedPredicates` is `["deckPureRatioInBand"]`: `deckPureRatio` **0.6457892095024083** against the
band **0.625–0.645**, over the upper edge by **0.0008**. `unscoredPredicates` is
`["refreshCostMeasured"]`, with exactly one structural reason — *"fresh refresh-cost measurement is
ineligible: webgpu: pair 0 eclipse: the pre-segment GPU readback drain did not close
(timedOut=true, undrained=1)"* — which is this plan's row **`S3-N2-REFRESHCOST`**.
`parityFailed` is `[]`. `exposureSweepRisesWithExposure` reads `false`, but it is a **reported-only**
predicate and gates nothing — read from the gate library's own reported-only set, not inferred.

**One thing about the sweep leg that is recorded rather than explained.** All four sweep rungs
(0.5, 1.0, 2.0, 4.0) returned a **bit-identical** `exposureSweepMeasured` —
`[0.9893862265081094 × 4]` — and that value **is** `shadowContrastRatioAtDeepest`, against a
`exposureSweepPredicted` series `[0.5651, 0.6341, 0.7222, 0.8124]` that does rise. `offNoShadowSeries`
is likewise four copies of `0.7843137254896411`, at `offNoShadowSpread` **0**. The banked sweep was
neither degenerate nor equal to its own ratio: `[1.0706, 1.0997, 1.1212, 1.1348]` against ratio
`1.0341102079879674`, `offNoShadowSpread` `0.0182`. The predicate gates nothing, but the gate
library's own comment calls it *"The CORRECTED deciding measurement"* for this row's mechanism
question, and a leg that returns one number four times is not evidence about exposure. **Nobody has
measured why. It is named here so it is not read as a passing leg**, and because it sits beside the
contrast reading this section calls green.

**§6b step by step — what it required, and what this batch has and has not done.**

1. *Bank the receipt and append to `RR-2026-09-13-E`.* **DONE** by this batch: the receipt is banked
   at the path above — `…-2026-09-19/`, **not** the `…-2026-09-13/` path this step named, because
   the run is Filibert's of 2026-09-19 and not the job-13c leg the step anticipated — and both
   sweeps are tabulated side by side in the `RR-2026-09-13-E` append in
   [`RULING_REQUESTS_2026-09-08.md`](RULING_REQUESTS_2026-09-08.md).
2. *Record that the green arm fired, with the measured ratio, and whether trigger 2 scored **because
   of** the step-1 repair.* **DONE, and the qualification is the honest half.** The deck-free lane
   scored **with the Batch 1518 repair applied**; the run never exercised the unrepaired predicate,
   so this is a green trigger 2 **obtained by repairing the instrument**, which §6b step 2 says is a
   different fact from one obtained without — recorded as such here. Trigger 1's green, by contrast,
   is not attributable to the repair: the repair is confined to the Node-side deck-free scoring
   module and leaves the served bundle byte-identical.
3. *S3 still owes four things.* **All four stay open and none is taken here:**
   `refreshCostMeasured` TRUE (blocked by `S3-N2-REFRESHCOST`, unchanged by this run and re-measured
   blind by it); the mechanism investigation of the contrast reading (`R-2026-08-14-1`'s other
   restored exit condition); band tightening against observed margins, flipping `status` off
   `DERIVED` — **with that row's own warning attached, that widening a band to make a run pass is
   the failure mode every `why` string in the gate module exists to make visible**; and independent
   review of the reading. **A fifth item now sits beside them, which §6b did not anticipate:** the
   `deckPureRatioInBand` red at 0.6457892095024083.
4. *Only then may `owners["C13-41"].state` move `reopened` → `closed`.* **NOT DONE and not
   permitted yet.** `FINDING_DISPOSITIONS_2026-08-13.json` is untouched by this batch; `C13-41`
   stays `reopened`.
5. *And C12 is still not closed.* **Correct, and it is not closed.** Every item in §2 Phase B except
   S3 survives ARM GREEN untouched, and so does every item in R10's list.

**Against §6b's stated ACCEPTANCE.** Its three clauses read: `shadowContrastInvariant` true — **met**;
`deckFreeControlStateIsolated` scored true — **met**; `unscoredPredicates` empty **or** containing
only predicates named in a recorded disposition — **met on the second limb only**, since the single
entry `refreshCostMeasured` is the predicate §6b step 3 itself names and homes on
`S3-N2-REFRESHCOST`. **The acceptance does not mention the gate's overall verdict, and the gate's
overall verdict is FAIL.** That is recorded plainly rather than folded into the acceptance's
silence. Its closing requirement — that the owed items each become an open row with an owner rather
than a sentence in a summary — is **not discharged by this batch**.

**Two things this section deliberately does not do.** It does not explain **why** either the contrast
ratio or the deck ratio moved between `fbea2028cc` and `ea651de6d8`; nobody has measured that, and a
separate investigation owns it. And it makes **no claim about what the tip would read** —
`R-2026-09-19-3` keeps a tip reading a later, separate job with its own `C13-N20` deck
pre-registration.

**And the decision that is not a lane's to take.** `R-2026-09-19-2` was adopted on a basis this
document supplied and that was found false before execution (the two dated corrections above).
**Whether to exercise Option C anyway is the maintainer's call**, and it is put back to them in the
dated annotation on `R-2026-09-19-2` in
[`MAINTAINER_RULINGS_2026-09-19.md`](MAINTAINER_RULINGS_2026-09-19.md).
