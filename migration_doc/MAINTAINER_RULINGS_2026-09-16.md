# Maintainer rulings — 2026-09-16

Taken 2026-09-16 ~11:05 EDT, prompted by the seat from `ASTRA_WORK_AUDIT_2026-09-16.md` §7
("Decisions for the maintainer", D1–D12); **each entry is the option the maintainer selected**,
quoted from the sitting's own note (`scratchpad/rulings-2026-09-16-maintainer.md`, the seat's
untracked scratchpad, banked with this record round's lane packet). Ruling ids are
`R-2026-09-16-1` … `-12` and map one-to-one onto the audit's `D1` … `D12`. The audit itself lands as
the tracked `migration_doc/ASTRA_WORK_AUDIT_2026-09-16.md` in Batch 1492 (2026-09-16), whose
fix round writes these twelve into that document's own "Rulings taken" section; **this file is their
authority** and the audit's copy is a convenience.

The sitting decides the **landing direction for the cloud work** and eleven consequences of it. Most
of these rulings bind work that had not landed when this file was written; each "Executed" line says
so plainly rather than implying a closure.

## R-2026-09-16-1 — Landing direction (D1): OPTION A — the three frozen lanes land first, Astra rebases onto the result

OPTION A — run the three frozen lanes' owed Edge legs, land L3 Ulmo -> L4 Manwë -> L5 Ossë in their reviewed form, then rebase Astra's cloud stack onto the result in a fresh clone.

Basis: `ASTRA_WORK_AUDIT_2026-09-16.md` §4 (collision and reconciliation) and §7 D1. The measurement
behind the recommendation: the three lane patches stack on seat HEAD with **4 failed hunks, all
`package.json` + `QUEUE`** — both already the seat's union step — against **29 of 111 hunks
rejecting** in the other direction; **5 of 26** union paths are already byte-identical and for
**16 of 26** the resolution is "keep Astra's file"; and six of the lanes' own acceptance specs are
red inside Astra's tree (§4.3).

Executed: **pending.** Phase 2 of the audit's landing plan (§8) is the first act under this ruling —
the three lanes' owed Edge legs. `R-2026-09-13-6` fixes their order.

Authority: charter §1.1.

## R-2026-09-16-2 — `C13-N10` resolver (D2): L3's near-altitude band stays; Astra's `AUTO_TEMPORAL` re-lands on top

the resolver KEEPS L3's near-altitude band (`if (cameraHeightMeters <= enableAltitudeMeters) return 3`); Astra's AUTO_TEMPORAL re-lands on top; Astra's rewritten byte-identity test does not replace L3's.

Basis: `ASTRA_WORK_AUDIT_2026-09-16.md` §4.3 row `C13-N10` — Astra carried the lane's resolver, then
**deleted** that band and **rewrote the lane's own byte-identity acceptance test** to a
`{maxSteps:48, lightSteps:4}` reference; the lane freeze measures 28/28 on that spec and it
**crashes** in Astra's tree.

Executed: **pending** — binds L3's landing and Astra's Phase 3 rebase.

Authority: charter §1.1.

## R-2026-09-16-3 — `C13-N11` uniform slot 175 (D3): stays L4's `_padQ`; `interleavedRefresh` is appended

uniform slot 175 stays L4's `_padQ`; Astra's `interleavedRefresh` is APPENDED as a new slot; the single-source `CLOUD_UNIFORM_FLOATS` constant fix (improvement #5, the `CLOUD_SLOT_*` export) lands in the same batch; slots 214 and 215 fall under the same rule.

Basis: `ASTRA_WORK_AUDIT_2026-09-16.md` §2.3 X6 and §4.3 row `C13-N11`. Measured **in Astra's clone**
`cesium-astra-20260914`, not at seat HEAD: the memory image is right and append-only — JS and WGSL
both compute **260 floats**, vec4-aligned — but **three stale mirrors of one memory image coexist**:
`probe-cloud-density-domain.mjs:1000` asserts **176**, `cloud-tier-lighting-dials.spec.mjs:222`
asserts **216**, the tree computes **260**. The first is an Edge probe and fails on the first leg that
runs it, in either landing direction. *(At seat HEAD `c325f858c3` that probe's pin is a fourth,
older value — `uniformFloatCount === 168` at `probe-cloud-density-domain.mjs:990` — which lane L3's
frozen batch repairs as its sixth mirror; re-derived in this lane 2026-09-16.)*

Executed: **pending** — the append and the single-source constant land in one batch.

Authority: charter §1.1.

## R-2026-09-16-4 — `C13-N20` public default (D4): `cloudAerialMode`'s `?? "heuristic"` becomes `undefined`, before Manwë's leg 3b

`CloudVolumetrics.js:209`'s `cloudAerialMode ?? "heuristic"` default changes to `undefined` (or an explicit `"auto"`) so L3's N20 promotion clause is reachable through the public API — BEFORE Manwë's leg 3b runs.

Basis: `ASTRA_WORK_AUDIT_2026-09-16.md` §4.3 row `C13-N20` — both halves of `C13-N20` are present, but
the `?? "heuristic"` default makes L3's promotion clause unreachable through the public API, so leg
3b would certify a path no caller can reach. Cross-reference `R-2026-09-12-8`'s own record of the
promotion clause in `MAINTAINER_RULINGS_2026-09-12.md` item 8 of the standing list.

Executed: **pending, and it is a prerequisite** — leg 3b must not run before this change.

Authority: charter §1.1.

## R-2026-09-16-5 — Solo proof bar (D5): an independent reviewer AND one named Edge leg per landing batch

solo engine/shader rows need an independent reviewer AND one named Edge leg PER LANDING BATCH (not per unit); the five cluster reviews of 2026-09-16 count as the review leg for what they covered.

Basis: `ASTRA_WORK_AUDIT_2026-09-16.md` §2.3 X3 — across the 43-unit cloud stack **there is no
independent reviewer and no named Edge leg for any unit**; every verdict is a self-review by the
agent that wrote the code, and no capture in the stack is an Edge leg in the two-tree sense, because
the implement scripts revert-and-re-apply **inside one tree**, which `R-2026-09-13-2`'s C leg and the
two-tree protocol forbid. Provenance is fully recorded, so this is an evidence-**class** gap, not a
provenance failure. The five cluster reviews are `R-foundation-lighting`, `R-shape-weather`,
`R-march-perf`, `R-temporal` and `R-pipelines-async` (2026-09-16).

Executed: **in force from this sitting.** Recorded as a dated note in
`SOLO_WORKER_HANDOFF_2026-09-13.md` by this record round; it amends the §7 self-review bar
`R-HANDOFF-12` established rather than replacing it.

Authority: charter §1.1.

## R-2026-09-16-6 — Every RETURN/WIP feature ships DEFAULT-OFF (D6)

every RETURN/WIP feature ships DEFAULT-OFF (units 43 pixelFootprintSamplingEnabled, 39 projectedDetailEnabled, 38 weatherCoverage.enabled today default on); 39 and 43 get real `CloudVolumetrics` dials with JSDoc.

Basis: `ASTRA_WORK_AUDIT_2026-09-16.md` §2.3 X9 — 20 of 43 units change a default inside an opt-in
collection, and three are enabled by default **while carrying a RETURN/WIP verdict or an open FAIL
gate**.

Executed: **pending** — lands with the units concerned in Phase 3.

Authority: charter §1.1.

## R-2026-09-16-7 — The two one-pixel image gates (D7): run the same-build repeat control first

the two one-pixel gates (units 37, 47): run the SAME-BUILD REPEAT CONTROL first (unit 47's repeat on the FROZEN source, its evidence crossed a build boundary); accept GPU nondeterminism only if it reproduces.

Basis: `ASTRA_WORK_AUDIT_2026-09-16.md` §2.3 X11 and §5 improvement #4 — unit 37 at **(1120, 922)**
and unit 47 at **(1296, 782)**, both **1/255 in one channel**, both with identical raw cloud buffers,
both reproduced independently by an auditor who decoded the PNGs. Unit 38 already ran exactly this
control and got identical sha256s, so the harness is proven. One Edge session may unblock ten stacked
units.

Executed: **pending** — it needs the Edge slot and is queued behind Phase 2.

Authority: charter §1.1.

## R-2026-09-16-8 — The C16 cleanlist ratchet (D8): folded into the cloud landing; the guard joins the solo pre-landing checklist now

the C16 cleanlist ratchet (main red at 18, Astra's tree 60) is FOLDED INTO THE CLOUD LANDING (one defect, one owner) using Gemini's Phase 1 text (verified 18/18) with the three banking conditions (items 1, 4, 6 bank their deferred-work pointers in DEFERRED_WORK/DEV_NOTES_clouds first); the C16 guard joins the solo pre-landing checklist now.

Basis: `ASTRA_WORK_AUDIT_2026-09-16.md` §2.3 X4 and §3 — `comment-marker-guard --verify-cleanlist`
goes from **18 REGRESSED / 6 files** at HEAD to **60 / 13 files** in Astra's tree and the census from
**199 to 241 markers**, so the landing-compliance clean-list ratchet and
`.github/workflows/dev.yml:79,83` (`lint-comment-markers`, `test-c16`) reject the batch as it stands.
*(The audit cites the ratchet as `verify-landing-compliance.mjs:483`; re-derived in this lane at seat
HEAD `c325f858c3` the constant is `CLEAN_LIST_PATH` at **`:484`** — the audit read the seat's dirty
working copy of that file, which is one of the four tracked files the seat tree carries modified.)*
All five cloud files are already on `comment-marker-cleanlist.txt`,
and the defect is invisible from inside either lane because the solo self-review bar does not run the
C16 guard.

Executed: **the checklist half is in force now** — recorded as a dated note in
`SOLO_WORKER_HANDOFF_2026-09-13.md` by this record round. The fold itself is **pending** Phase 3.

Authority: charter §1.1.

## R-2026-09-16-9 — The six `new-cap` eslint errors (D9): fix the two fork-side sites, scope an exception for the four upstream ones

the six `new-cap` eslint errors: FIX the two fork-side sites (`PrimitiveGeometryHelpers.js:227,252`), add a scoped eslint exception for the four upstream-authored sites (`PixelFormat.js:479`, `clone.js:17`, `Vector3DTilePrimitive.js:810,830`); CI must not stay red.

Basis: `ASTRA_WORK_AUDIT_2026-09-16.md` §3 (the CI glob is **RED AT HEAD** with six `new-cap` errors)
and §6, which records that Gemini's Phase 3 targets all four upstream-authored sites, contradicting
its own anti-churn principle — only `PrimitiveGeometryHelpers.js:227,252` is fork-side.

Executed: **pending.**

Authority: charter §1.1.

## R-2026-09-16-10 — The assigned-row packets LAND TONIGHT (D10), with three adjudications riding along

the sixteen assigned-row packets + four record-only closures LAND TONIGHT after 19:00 ET (Arien A1-B; Anarion god-ray ranges; Aldarion DX-91->90->95->84->wave-end then 82/89/branch; Anarion schedule after its scope stamp; records), with the three adjudications riding along (Anarion SCHEDULE scope stamp; Arien A3 row correction — acceptance (6) and the prescribed edits are mutually exclusive, the patch is sound; god-ray record line numbers `:2130`, `:1757-1761`). N07a returns to a BLOCKED row (D12).

Basis: `ASTRA_WORK_AUDIT_2026-09-16.md` §1 (per-packet verdicts, gates re-measured by the auditor) and
§8 Phase 1. **17/17 freeze md5s match line 1 of their FREEZE file**; every packet's before/after count
reproduced independently; the whole phase is Node-only and needs no Edge slot.

Executed: Batch 1488 (2026-09-16) — the six `C13-N08b` spec repairs; Batch 1489
(2026-09-16) — the god-ray uniform ranges; Batch 1490 (2026-09-16) — the eight DX rows;
Batch 1491 (2026-09-16) — the C13-42 schedule, after its scope stamp. The four
record-only closures are carried by this record round.

Authority: charter §1.1.

## R-2026-09-16-11 — Gemini's audit doc lands after nine corrections (D11); its `_lane-out/` is archived, not tracked

Gemini's audit doc LANDS AFTER THE NINE CORRECTIONS (README index row; the seven `file:///f:/` links replaced; Phase 2 deleted/restated; the four upstream `new-cap` sites marked; the pre-push snippet given explicit placement + status capture so it cannot mask the no-override quiet-hours guard; the duplicate CI step dropped; `C16-20` criteria corrected; Fleet-2 total 668 not 575; the two false findings withdrawn with dated correction lines); its `_lane-out/` goes to `cesium-webgpu-worker-archive/lanes-2026-09-16/`, not the tree.

Basis: `ASTRA_WORK_AUDIT_2026-09-16.md` §6 — the instrument sweep reproduces 100 % (22/22 quotes
verbatim, 28 true / 2 false / 0 stale on an independent 30-row stratified sample) while the semantic
pass runs at **≈1.2 % defect yield** over 1,213 anchored rows; **Phase 2 is 42/51 stale**; the
per-worker Fleet-2 counts sum to **668, not the 575 claimed**; and two findings are false, one of
them destructive (the GEE-buffer "dead variables" at
`createVerticesFromGoogleEarthEnterpriseBuffer.js:104,111,118`, which **are** read at
`:408,410,421,433,435,446`).

Executed: **pending the nine corrections.** The doc is
`migration_doc/CODEBASE_CODING_AND_COMMENT_STANDARDS_AUDIT_2026-09-14.md`, untracked at the seat
until they land.

Authority: charter §1.1.

## R-2026-09-16-12 — `C13-N07a` (D12): the partial does not land; the seat supplies the promotion route first

C13-N07a's partial does not land; the seat supplies the promotion route (C13-N48) before re-dispatch; keep the freeze and the three banked evidence runs.

Basis: `ASTRA_WORK_AUDIT_2026-09-16.md` §1.3 and §1.4 — with the patch applied,
`cloud-scenes-contract.spec.mjs` measures **8/7/1, exit 1** against **8/8/0** on clean HEAD; the two
accepted WebGPU baselines, the certification runs and the row's step-4 visual bar are all missing, and
the auditor read `cloud-orbital-disc.webgpu.hd.png` and it **is** a flat featureless disc. No worker
can fix it: `capture-and-diff.mjs:801-805` refuses a dirty candidate, inserting the scene entries
necessarily dirties the tree, and a worker may not commit.

Executed: recorded by this record round — `C13-N07a` returns to a **BLOCKED** row, not to a worker.

Authority: charter §1.1.
