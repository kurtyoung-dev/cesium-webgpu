# Campaign 11 — Execution Guide (composition / index over the 10 cluster guides)

Prepared: 2026-07-18 · Status: **PREPARED / NOT LAUNCHED** (auto-launches on Campaign-10 close per the
standing directive; see `QUEUE_2026-07-18_CAMPAIGN11.md` front matter).

This is a **thin index**, not a re-statement. The per-item walkthroughs — HEAD-verified `file:symbol`
anchors, premise-verify-first steps, traps vs the landed 683–700 work, acceptance/verification
recipes, and per-item model-tier + effort — live in the ten cluster guides under
`campaign11_planning/guides/`. This guide only tells you **which guide + which C11-id owns your task**,
how to translate the guide's register-NAME references into the queue's canonical `C11-xx` numbers, and
where the operating charter lives. **Do not duplicate the guide bodies here — read them.**

## How to use this guide (read before implementing ANY task)

1. **Find your task's C11-id** in `QUEUE_2026-07-18_CAMPAIGN11.md` §1 (the canonical ID table) — it is
   the campaign's backbone; every wave/gate reference points back to it.
2. **Read your task's owning-guide section BEFORE writing code** (the cross-map below). The guide
   carries the premise-verify-first step 0, the anchors, the acceptance oracle, and the traps. A "fix"
   for a defect that no longer reproduces at HEAD is a revert — confirm the premise first.
3. **Cross-reference `FEATURE_INVENTORY.md`** for the affected subsystem coupling before you write code
   (CLAUDE.md Principle 6).
4. **Follow the leave-dirty worker contract** (G10 §B2): implement on a dirty tree, build, run the
   named acceptance probe, READ the output PNGs, prove the OFF-gate, run the standing regression
   battery, and RETURN a verified uncommitted diff. Workers never commit — the orchestrator lands.

## Canonical-ID reconciliation note (load-bearing)

**The cluster guides refer to items by their register NAME** (`NEW-WEBGPU-PICKPOSITION-CONVERGENCE-
REGRESSION`, `S9-2`, `C9-24`, `FAR-107`, …), because they were authored during phase-2 **before** the
canonical `C11-xx` numbers were assigned (phase-3). **`QUEUE_2026-07-18_CAMPAIGN11.md` §1 is the single
authority that maps name → `C11-xx`.** When a guide says "the S9-2 slice," that is `C11-28`; when it
says "C9-24 RTE inventory," that is `C11-52`. No guide was renumbered; no register name was renamed —
the number is an addition, the name is the durable alias. If a guide and the queue ever disagree on a
name, the queue's §1 alias column wins for the number and the register wins for the name.

Two clusters — **`rte-taa`** (`C11-51..57`) and **`clouds-weather`** (`C11-124..130` +
`C11-SEED-10..18`) — have **NO dedicated cluster guide** (the 10 guides cover 165 of the 188 items).
For those, cut against the register row (`CANDIDATE_REGISTER.md` §7 / §17) + the cited source docs
(PERF_ARCH_DEEP_DIVE §4/§8 for TAA; the cloud/weather roadmaps for §17), and commission a guide before
the cluster's first non-trivial slice.

## HEAD hash the guides' anchors were verified at

- **G8 / G9 / G10 anchors:** verified at HEAD **`9204647535` (Batch 701)**, `main`.
- **G1–G7 anchors:** verified at HEAD **`5b98ab9698`** (phase-2 authoring HEAD).
- **Register sweep:** HEAD `aef553d592` (Batch 698).
- **This guide + the queue assembled at:** HEAD `c643516c04` (Batch 703).

**Standing rule: line numbers in every guide are HINTS — the `file:symbol` + shape is the anchor.**
A C10 worker was editing engine files concurrently during authoring and the tree keeps moving;
**re-grep every symbol before acting** and re-anchor against the live tree (`git show HEAD:<path>` for
committed state). Premise magnitudes in the register/guides are stale post-`C10-01`/`C10-03` — verify
mechanisms, not counts.

## Cluster → guide → C11-id cross-map

| Guide | Clusters owned | Canonical C11-ids | Notes |
|---|---|---|---|
| **G1** `G1-pick-and-reds.md` | `pick` (1) + `standing-reds` (2) | `C11-01..10`, `C11-IC-01`; `C11-11..25` | W1 anchor guide; §0 pick intake-conditional table; A1 (`C11-01`) + B1 (`C11-11`) diagnoses first. `C11-13` voxel-black walkthrough is in **G6 A1**. |
| **G2** `G2-terrain-imagery.md` | `terrain-imagery` (5) + `submit-residency` (10) | `C11-32..42`; `C11-75..78` | C9-11/12 terrain family = dedicated multi-batch arc (W6); submitter-moves before the FAR-200 timeline authority. |
| **G3** `G3-attachment-topology.md` | `attachment-topology` (6) | `C11-43..50` | MRT key-audit prereq before the `C11-43` demand-wire; `C11-50` payoff probe must precede `C11-43`/`C11-49`. |
| **G4** `G4-model-frame-delta.md` | `model-frontend` (4) + `frame-delta` (8) + S1-6 dossier | `C11-27..31`; `C11-58..63`, `C11-SEED-01`; `C11-SEED-23` | S9-2→(gate)Slice D→S9-3 hard-ordered; `C11-27` STOP-gated on checkpoint attribution. |
| **G5** `G5-tiles-model-parity.md` | `tiles-model-parity` (12) + `splat` (3) + Batch-699 trio | `C11-81..99`, `C11-SEED-03/04`; `C11-26`, `C11-IC-02` | Splat producer (`C11-26`) BLOCKED-ON-MAINTAINER; B699 shared-cause diagnosis (feature-ID) before slicing composite/pick-empty. |
| **G6** `G6-classification-voxel-postfx.md` | `classification-voxel` (13) + `postprocess-effects` (16) | `C11-100..108`; `C11-117..123`, `C11-SEED-08/09` | Also carries the `C11-13` (voxel-inside-black) walkthrough (register cluster = standing-reds/G1). `C11-117` effect-audit opens the PP cluster. |
| **G7** `G7-entity-scale.md` | `entity-scale` (9) + `celestial-env` (11) | `C11-64..74`, `C11-SEED-02`; `C11-79..80` | `C11-64` 10k-entity benchmark lane is FIRST in the S10 arc and gates every S10 finding. |
| **G8** `G8-defaults-parity-env.md` | `shadows-lighting` (14) + `atmosphere-sky` (15) + `water` (18) + **defaults-parity** | `C11-109..112`, `C11-SEED-05`; `C11-113..116`, `C11-SEED-06/07`; `C11-131`, `C11-SEED-19` | THE defaults-parity guide; enhanced-ocean = maintainer decision (not a numbered row); cluster-14/15/18 reconciliation slice at wave start. |
| **G9** `G9-test-infra-build.md` | `test-infra` (20) + `build-boot` (21) | `C11-132..147`; `C11-148..156`, `C11-SEED-20/21/22`, `C11-IC-03` | Environment fixes (`C11-132/133/134`) in W1; `C11-149` (C10-08b) HARD prereq for any new define bit; `C11-137` is the EXIT gate (dead last). |
| **G10** `G10-charter-mechanics.md` | `gated-reversed-z` (19) + `arch-seeds` (22) + cross-cluster seeds + **THE OPERATING CHARTER** | `C11-GT-01..03`; `C11-SEED-23..26` | Read PART B before dispatching any brief. §A1–A7 dossiers; §B6 `C11-00B` intake; §B7 engine-script fallback. |
| **—** (no guide) | `rte-taa` (7) + `clouds-weather` (17) | `C11-51..57`; `C11-124..130`, `C11-SEED-10..18` | **No dedicated guide.** Cut against `CANDIDATE_REGISTER.md` §7/§17 + source docs; commission a guide first. |

## The operating charter + takeover manual

**`campaign11_planning/guides/G10-charter-mechanics.md` is authoritative** for how to BE the campaign:

- **PART B — the operating charter (takeover manual).** §B1 operating model (orchestrator = Fable
  main loop; model-matched Opus/Sol workers; Sol = external takeover; workers never commit); §B2
  dispatch→review→land loop + leave-dirty contract + trust-the-GO gate; §B3 machine-safety block
  (verbatim into every brief; ONE Edge at a time; 5-min watchdog; scan generated scripts for unbounded
  loops; 32 GB RAM); §B4 salvage playbook (session-limit kill recovery — plumbing-snapshot pattern,
  scratchpad-copy-before-death); §B5 model-tier decision table; **§B6 the `C11-00B` launch intake
  procedure**; §B7 the ×5-hardened engine-script fallback (if orchestration must go fully autonomous);
  §B8 the cold-start orchestrator checklist (incl. the canonical-ID-table-FIRST rule).
- **PART A — gated-tail + arch-seed dossiers** (§A1 reversed-Z spike, §A2 reversed-Z slice-B, §A3 MSAA
  reserve, §A4 S1-6 tier, §A5 worker-renderer, §A6 S10 arc, §A7 geometry-residency).
- **The consolidated maintainer OPEN QUESTIONS** live in `QUEUE_2026-07-18_CAMPAIGN11.md` §7 (deduped
  across all ten guides) — read them before scheduling any BLOCKED-ON-MAINTAINER item.

## Pointers

- Campaign authority + canonical ID table + gates + waves: **`QUEUE_2026-07-18_CAMPAIGN11.md`**.
- Item universe: `campaign11_planning/CANDIDATE_REGISTER.md`. Planning status:
  `campaign11_planning/_PLANNING_STATUS.md`. Defaults-parity: `DEFAULT_PARITY_MATRIX_2026-07-18.md`.
- C10 exemplars: `QUEUE_2026-07-16_CAMPAIGN10.md` + `CAMPAIGN10_EXECUTION_GUIDE_2026-07-16.md`.
