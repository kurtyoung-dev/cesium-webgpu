# Maintainer rulings — 2026-09-17

Taken 2026-09-17 ~19:10–19:20 EDT, prompted by the seat from the verified result of the external
(Gemini) codebase audit; **each entry is the option the maintainer selected**. Ruling ids are
`R-2026-09-17-1` … `-8` and map onto the decisions `D1`, `D2`, `D6`, `D9`, `D3`, `D5` and `D8` of the
verification report, plus one Edge-order ruling that has no decision number. A second sitting the
same evening, ~22:05 EDT, added `R-2026-09-17-9` ... `-12` on a different subject - the probe kit, the
fleet harvest-and-retire, and the Campaign 15 aurora launch - prompted by the seat from
[`PROBE_KIT_PLAN_2026-09-17.md`](PROBE_KIT_PLAN_2026-09-17.md) section 7 after its station-3 review;
all four were taken as recommended. The report itself lands
as the tracked [`GEMINI_AUDIT_VERIFICATION_2026-09-17.md`](GEMINI_AUDIT_VERIFICATION_2026-09-17.md)
in the same batch as this file; **this file is the authority** for the rulings, and the report's §g is
the argument they were taken on.

The sitting decides what happens to an audit corpus whose shape this fork did not commission: what
lands, what is archived, what must never be executed, and the order the fix waves run in. Most of
these rulings bind work that had not started when this file was written; each "Executed" line says so
plainly rather than implying a closure.

Three of the eight amend or correct a ruling of 2026-09-16; each says which, in its own entry, because
a reader who finds only the older file must not act on it alone.

## R-2026-09-17-1 — Upstream-authored bugs (D1): severity first, divergence as the tiebreak

A reachable P0/P1 on an upstream-authored line is fixed in-fork as ONE minimal hunk AND filed upstream, with the hunk recorded in the sync plan's conflict census (`UPSTREAM_SYNC_PLAN_1.145_2026-09-04.md` §3); P2/P3 on byte-identical upstream files go upstream-only. The authorship/divergence axis is always a measurement (`git diff --numstat upstream/main HEAD -- <path>` plus `git blame -L`), never an assertion.

Basis: `GEMINI_AUDIT_VERIFICATION_2026-09-17.md` §c and §g D1 — five of the six genuinely-new P1
defects sit on upstream-authored lines. The rejected alternative ("fix in-fork only where the file
already diverges") has no severity term, and it would route the corpus's only deterministic
user-visible defect (`widgets-10`, a dead inspector panel left in the caller's page on every
extend-then-destroy) and a per-frame CZML `TypeError` (`datasources-02`) to "upstream only, carry the
bug" purely because those two files happen to be byte-identical with upstream. Under this ruling both
are fixed in fork and filed upstream; `core-02`, `globe-terrain-04`, `globe-terrain-05`,
`workers-wasm-01` and `workers-wasm-02` are in-fork anyway because those files already diverge
heavily; all six are filed upstream regardless.

The measurement clause is not decoration. The audit asserted an UPSTREAM/FORK verdict on every one of
its findings and ran **zero git operations** to support any of them; that is the single defect in it
that propagated furthest.

Executed: **pending** — binds every wave-2 and wave-3 lane that touches an upstream file.

Authority: charter §1.1.

## R-2026-09-17-2 — The audit document (D2): it lands after the nine corrections; the corpus goes to the archive

Gemini's audit document LANDS after the nine corrections of `R-2026-09-16-11`, which the maintainer keeps; the `_lane-out/` corpus goes to the worker archive, never the tree.

Basis: `R-2026-09-16-11` set the nine corrections and they stand. Recorded as of 2026-09-17: **none of
the nine has been applied.** The untracked document is
`migration_doc/CODEBASE_CODING_AND_COMMENT_STANDARDS_AUDIT_2026-09-14.md`; it stays untracked until
they are.

This is not an action against the doc-archival hold: both targets — the `_lane-out/` corpus and the
audit document — are untracked, so nothing tracked is being archived.

**The do-not-execute list below binds any reader of the archived corpus.** That is the operative half
of this ruling: a future agent who finds the corpus in the archive must meet the list before acting on
anything in it.

Executed: **pending the nine corrections.**

Authority: charter §1.1.

## R-2026-09-17-3 — Wave 0 tonight (D6): the three red CI gates are one lane

The three red CI gates — eslint `new-cap` per `R-2026-09-16-9`; the 53 clean-list regressions in 8 files; the lint-staged nested-config hole — are one lane, W0-CIGREEN.

**This amends `R-2026-09-16-8`:** the clean-list fold's owner moves from Astra's cloud landing to wave
0. Astra's rebased tree owes only the regressions it adds itself.

Basis: `GEMINI_AUDIT_VERIFICATION_2026-09-17.md` §c P0-1 and P0-2. One correction to the premise the
decision was argued on: **only the eslint gate is red on every push.** `.github/workflows/prod.yml:28`
runs `npm run eslint` and carries no `lint-comment-markers` and no `test-c16` step, so P0-2's blast
radius is `dev.yml` alone (`:79`, `:83`). Re-measured at `91a7a8c9ff`: `prod.yml` contains zero C16
steps. `R-2026-09-16-8` scoped 18 regressions in 6 files; the measurement at `91a7a8c9ff` is **53 in
8**, of which 46 are in three cloud files.

Executed: **pending** — W0-CIGREEN.

Authority: charter §1.1.

## R-2026-09-17-4 — The named leg for non-visual engine changes (D9)

The relevant karma/Jasmine suite run by the Edge executor is the per-lane leg; each fix wave closes with ONE Edge job (variant smoke, Sandcastle2 sweep, capture-and-diff over the wave's patches) under `R-2026-08-29-2`. Engine lanes with no rendered output do not take the Edge slot individually.

Basis: `GEMINI_AUDIT_VERIFICATION_2026-09-17.md` §g D9. Read literally, `R-2026-08-29-1` gives every
engine lane a named Edge leg, which would queue eight of the twenty-four P1s behind a cloud-leg queue
they have no rendered surface to exercise. This ruling states the per-lane bar and the wave's closing
discharge **as one ruling** so lanes do not re-litigate it per batch.

Executed: **in force from this sitting.** Wave 2 may start.

Authority: charter §1.1.

## R-2026-09-17-5 — Edge order: cloud legs first, fix waves in between

The L4/L5 cloud legs resume as soon as `manwe-on-L3.patch` exists; a fix wave's Edge job slots in when a cloud leg ends; wave 0's smoke rides the next job.

Basis: `R-2026-09-13-6` (engine legs first) and `R-2026-09-16-1` (the three frozen lanes land first)
both stand. This ruling says only where the new fix waves' Edge jobs enter that queue; it re-opens
neither.

Executed: **in force from this sitting.**

Authority: charter §1.1.

## R-2026-09-17-6 — The P3 comment mass (D3): fold into the existing C16 rows, plus ONE new row for instrument scope and grammar

The P3 comment mass folds into the existing C16 rows plus ONE new row for instrument scope and grammar: box-drawing dividers; `packages/engine/Specs`, `packages/sandcastle` and `Apps/Sandcastle` as scope roots with their own clean lists; comments inside WGSL template literals; the `Batch Q23` and `(C-15)` grammar gaps; `lint-string-literal-markers` wired into `dev.yml` behind its own ratchet; `SKIPPED (out of scope)` printed instead of silence. Rationales are banked only where a comment carries a *why*.

Basis: `GEMINI_AUDIT_VERIFICATION_2026-09-17.md` §d and §e A1. The existing C16 rows own marker
hygiene; **none owns instrument scope**, which is why a comment-token-driven audit produced 2,250
style rows against files the guards already cover and three trees they cannot see. The "bank the
rationale" clause is narrow on purpose: stripping upstream's `// level 30 tiles are ~2cm wide at the
equator` is what manufactured three later false findings inside this same corpus.

Executed: **pending** — the row is `C16-21`, added to `QUEUE_2026-08-10_CAMPAIGN16.md` by this record
round with its acceptance measured at `91a7a8c9ff`.

Authority: charter §1.1.

## R-2026-09-17-7 — How Gemini is used from here (D5): bounded docs now; audit fleets later, behind a dispatch template

Bounded docs now (tier-3, Opus-reviewed); audit fleets later only behind a dispatch template mandating a per-row verdict, a severity, a blame with the git output inline, an explicit revision for every cited line, and a ledger grep.

Basis: `GEMINI_AUDIT_VERIFICATION_2026-09-17.md` §b.1 and §e A10. The failure was **not** reading: the
quotations are reliable — fifteen of sixteen verifiers found no fabricated quote, and two line-number
errors were found across the whole substantive set — and 198 of 355 verified items are TRUE. Every
failure was structural and preventable by the dispatch: an authorship axis asserted without
measurement, no per-row disposition, and a "100% COMPLETE" claim against a corpus that never names 64%
of the tracked files.

Executed: **in force from this sitting** for the bounded-docs half; the template is owed before any
future fleet.

Authority: charter §1.1.

## R-2026-09-17-8 — The eslint dependency (D8)

Execute `R-2026-09-16-9`, plus a root `package.json` `overrides` pin at the installed version; the upstream issue is filed by the maintainer, its text recorded by W0 in `DEFERRED_WORK.md`.

Basis: `GEMINI_AUDIT_VERIFICATION_2026-09-17.md` §g D8. Upstream carries the identical `^10.9.1`
range, the identical rule and the identical code at the four upstream-verbatim sites, so **editing the
range in `package.json` would be a new divergence**, while an `overrides` entry achieves the same pin
and is trivial to drop at the next sync. Turning `capIsNew` off was rejected: the rule is upstream's,
and it is finding real style violations.

Executed: **pending** — W0-CIGREEN.

Authority: charter §1.1.

---

## R-2026-09-17-9 — The C15 aurora hold: `C15-01` and `C15-02` are released now, as a named narrow override

`C15-01` (neutral state packet + manual driver) and `C15-02` (WMM2025 geomagnetic frame + synthetic oval) are released from the `R4` hold and are dispatchable as pure-Node engine lanes. `C15-03`…`C15-08`, `C15-06P` and `C15-07H` stay held, and are released by a **later one-line ruling once the contact sheet exists** — that is, once `DX-105` has landed and `C15-04` has something to iterate on. **C12's close is neither blocked nor forgotten by this.**

Basis: `PROBE_KIT_PLAN_2026-09-17.md` §7 `R-A`, taken as recommended and confirmed accurate by the
station-3 review (lane Diggle, 2026-09-17). `R4`'s condition is **C12 closure**
(`QUEUE_2026-08-02_CAMPAIGN15.md:14-15`, row table `:378-381`; `CAMPAIGN_STATE.md:241-248`) and **this
ruling does not claim it is met.** C12's exit gate is MAXIMAL (`R-2026-08-10-1`, `CAMPAIGN_STATE.md:55`),
its critical path is `C12-29` S3 via `C13-41`, and `R-2026-09-13-1` makes the S3 re-decision conditional
on a re-run — job 13c leg (e) — that **never ran**, so neither arm has fired and `RR-2026-09-13-E` stays
open (`DEFERRED_WORK.md:2464`). This is therefore a **narrow override of `R4`'s literal text for two named
rows, not an exercise of Option C**, and it pre-empts neither arm of `R-2026-09-13-1`. The two rows carry
pure-Node exit gates by their own written text, take no Edge slot, touch no C12 file and no shader, ship no
visible effect, and produce the deterministic packet and geomagnetic frame every later aurora row consumes.
The two alternatives were argued and declined: holding everything costs the lane its longest-lead rows for
an indefinite wait on an Edge queue with three things in front of it; exercising Option C now would close
C12 on a judgement about noise rather than on the measurement `R-2026-09-02-5` funded.

Executed: **in force from this sitting.** `C15-01` and `C15-02` may be dispatched; every other aurora row stays `HELD (R4)`.

Authority: charter §1.1.

---

## R-2026-09-17-10 — The visual-acceptance protocol: invariants are verified, looks are judged

Adopted as written in `PROBE_KIT_PLAN_2026-09-17.md` §7 `R-B`. Invariants — RTE, byte-identity, parity, exit contracts, lifecycle, determinism — keep specs and the probes that produce their measurements. **Aesthetic questions are judged by the maintainer on a contact sheet**, which carries no verdict, no threshold and no exit code, and which cannot change any gate's status. A look the maintainer accepts is pinned **exactly once**, as a baseline refresh in its own reviewed commit, through the existing `capture-and-diff.mjs --update --confirm-baseline-promotion --update-rationale … --reviewed-by …` path. A probe written to manufacture a number for an aesthetic question is a review finding, not evidence. `CLAUDE.md` Principle 8 and `ORCHESTRATION_HANDBOOK.md` §7 "Acceptance semantics" are amended with the text drafted in the plan's §2.1, verbatim.

Basis: the plan's §2, and the measurement under it — 666 executable probes and 301,541 lines, of which
46 carry a private pixel diff, because a lane asked to answer "does this look right" with a number
writes one. Principle 8's automation requirement is **unchanged** for everything with a right answer;
what this adds is the distinction between a verification and a judgement, which Principle 8 did not
previously draw. The verdict-freedom is mechanical rather than promised: `DX-105`'s acceptance asserts
the generated page contains no pass/fail token and that the tool's exit code is independent of every
mismatch value it renders, with an inertness mutant.

Executed: **in force from this sitting.** The two governance amendments land with the batch that carries this file; `DX-105` is ungated by it.

Authority: charter §1.1.

---

## R-2026-09-17-11 — Probe retirement: archive first, delete later, from a positive list

Adopted as written in `PROBE_KIT_PLAN_2026-09-17.md` §7 `R-C`. `EXECUTOR_LANE_CHARTER_2026-08-14.md` §3.6 remains the retirement authority and is not restated. Two things it leaves open are settled. **(1) ARCHIVE means moved, not deleted:** a retired probe lands in `Tools/visual-regression/archive/` with `@status ARCHIVED-CANDIDATE`, its allowlist row and runbook references removed in the same landing group, after its conclusion is banked in `WEBGPU_DEBUGGING_LOG.md`. **Deletion is a separate, later batch**, taken only from a positive list — read back from the file, reviewed by an Opus reviewer who is not the author — after the archive move has landed and after the probe's evidence is harvested to `cesium-webgpu-worker-archive` and its images repatriated to `Tools/visual-regression/output/`. **(2) The first retirement cohort is the 143 `@status INVESTIGATION` probes**, and `ARCHIVED-CANDIDATE` becomes reachable as part of `DX-107`. A probe's appearance in a batch record is **provenance, not a live runner**, and does not block its retirement; the citation is repointed at the banked conclusion in the same landing.

Basis: the ritual exists and is measurably half-applied. At `1a2baeaa4a`: **143** probes sit in the
"done with it, left it where it was" state the charter itself names as the failure; **16** files were
moved into `archive/` without the status flip and still read `INVESTIGATION`; and `@status
ARCHIVED-CANDIDATE` has **zero users anywhere in the tree** — the sole tree-wide hit is a fixture
string inside `purpose-header-contract.spec.mjs`. Two-phase, positive-list destruction with the
read-back is the standing rule for destructive work here, and every clause of it is carried into the
plan's §4.2 numbered criteria.

Executed: **in force from this sitting.** `DX-108` is ungated by it; no deletion may land in the same batch as its archive move.

Authority: charter §1.1.

---

## R-2026-09-17-12 — The kit rows live in WAVE DX §6a.1; no new file, no new campaign identity

Adopted as written in `PROBE_KIT_PLAN_2026-09-17.md` §7 `R-D`. The probe-kit and harvest rows are `DX-101` … `DX-108` in §6a.1 of [`QUEUE_2026-08-29_RESEARCH_DISPATCH.md`](QUEUE_2026-08-29_RESEARCH_DISPATCH.md), in that document's existing flat `DX-nn` sequence and row-card format. **No new queue file, no new id prefix, and no new campaign identity** — the work is a wave inside Wave DX, not a campaign. Campaign 15 is **not** re-filed: `C15-01`…`C15-08`, `C15-06P` and `C15-07H` keep their ids and their home, and the plan's §5 attaches to them.

Basis: every row the kit depends on or attaches to already lives in §6a — `DX-01` (the runtime),
`DX-02` (anti-re-accretion), `DX-06` (which `DX-108` executes and whose acceptance it inherits),
`DX-94` (the orphan ratchet), `DX-96` and `DX-97`. A separate file would split one programme across two
documents, which is the **exact defect record round 5 filed `DX-96` and `DX-97` for** and which had
already produced the `DX-86`/`DX-87` id collision. A `DX-PK-nn` prefix would add a second id grammar to
a namespace whose add-only rule (SR-16) already works and whose ids are cited flat everywhere.

Executed: **in force from this sitting.** The rows land with the batch that carries this file.

Authority: charter §1.1.

---

## The do-not-execute list — binding on every reader of the archived corpus

Six remediations in the archived corpus must never reach a lane. Each was re-derived at source; the
evidence is in `GEMINI_AUDIT_VERIFICATION_2026-09-17.md` §b.1.

| row | why it must not be executed |
| --- | --- |
| Gemini `BUG-02` | calls `this._terrainProvider.destroy()`, which `TerrainProvider`, `CesiumTerrainProvider` and `EllipsoidTerrainProvider` do not define — a `TypeError` on every `Globe.destroy()`. The site was re-read at `packages/engine/Source/Scene/GlobeSurfaceTileProvider.js:1391-1394` |
| the GEE "dead variables" row | deletes `rectangleWidth` / `rectangleHeight` at `createVerticesFromGoogleEarthEnterpriseBuffer.js:104,111,118`; the variables **are** read at `:408`, `:410`, `:421`, `:433`, `:435`, `:446`, and deleting them breaks skirt geometry. Already recorded by `R-2026-09-16-11` |
| `BUG-03` / `BUG-04` | pad **outside** the WASM arena — an overrun of up to three bytes, because the proposed arithmetic never grows `totalBytes` |
| `BUG-14` | changes a harness exit code 99 → 2, which banks a **crashed** harness as STRUCTURAL and blinds the wave-end gate |
| `core-31` | the proposed `let` → `const` is applied to reassigned scratch variables — a runtime `TypeError` |
| `BUG-34` (urijs) | the corpus's only security-class row and Gemini's Phase-0 head. `^1.19.7` admits **1.19.11, the last version urijs ever published**; the installed version is 1.19.11 and `ThirdParty.json:220` records 1.19.11. **No security action, no Phase-0 gate.** Raising the floor to `^1.19.11` is optional hygiene that may ride the next manifest change and **must never be presented as a CVE fix** |

## Decisions still open, to be prompted by the seat before their waves

- **D7 — `DrawCommand` ↔ `WebGPUDrawCommand` parity.** The recommendation on the record is an exemption
  table naming the WebGPU substitute per property, a guard that **reads that table from source**, and
  an amendment to the upstream-sync post-merge checklist. Partly pre-ruled: `DEFERRED_WORK.md:7590`
  (`NEW-CAPABILITY-GETTER-CODIFY`, residual 2) already rules the `isWebGPUDrawCommand` checks
  non-violations — "a COMMAND property, not a context branch".
- **D10 — AR-090, the WGSL chunk stack.** An existing row to rule, not a new decision
  (`QUEUE_2026-09-03_ARCHITECTURE_REVIEW.md:327`, P2/M/OPUS-JUDGMENT). Constraint on any "delete the
  orphan tree" option: `AR-D12` is DECIDED ("ENFORCE UNIVERSALLY", `R-2026-09-10-1`) and `AR-194`'s
  acceptance presumes the shared `CameraUniforms` chunk file survives. One exception holds either
  way: `shaders-13` has a live consumer and must be fixed regardless of how AR-090 is ruled.
- **D4 — a targeted second pass on the coverage gaps.** Recommended after wave 5, in this order: the
  five unnamed WebGPU renderers (~19K lines); the cloud subsystem, where 46 of the 53 clean-list
  regressions live; and `packages/engine/Source/Core` plus `packages/engine/Specs/Core`, where no
  instrument points and three of the six genuinely-new P1s were found.
