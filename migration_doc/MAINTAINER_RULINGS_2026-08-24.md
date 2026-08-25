# Maintainer rulings — 2026-08-24

**Authority and character.** Four rulings were taken in session on 2026-08-24 at approximately
15:45 ET, during wave planning against `main` @ `daaca4fde8` (Batch 1137). They are recorded as
**operative**, following the convention the 2026-08-21 evening batch set — *"These are operative,
not provisional, unless stated"* ([MAINTAINER_RULINGS_2026-08-21.md](MAINTAINER_RULINGS_2026-08-21.md):92)
— rather than the explicitly provisional character of that file's morning batch (`:5-9`). Two of
the four carry conditions on their own execution and say so in their sections:
`R-2026-08-24-1` is **ruled but not yet applied** (its amendment is drafted and awaits a non-author
reviewer), and `R-2026-08-24-4` is a sequencing decision whose engine half waits on browser gates.
If a provisional character was intended for any of the four, this header is the line to correct.

**Add-only.** Ruling IDs are never renumbered or reused. Where a ruling below supersedes an earlier
one, the supersession is stated inside that ruling's own section and nowhere else; nothing here
silently overrides a prior ruling.

**Scope note.** This file is the record. Campaign queue docs remain the sole status authorities for
their rows, per the precedence order at
[EXECUTOR_LANE_CHARTER_2026-08-14.md](EXECUTOR_LANE_CHARTER_2026-08-14.md) §0.4.

**Second sitting, ~16:35-16:40 ET.** Seven further rulings — `R-2026-08-24-5` through
`R-2026-08-24-11` — were taken the same afternoon and are recorded in §2 below, under the same
operative character. With `R-2026-08-24-1` and `R-2026-08-24-6` through `R-2026-08-24-10`,
**all six open decisions in [PICKING_ARCHITECTURE_STATE_2026-08-17.md](PICKING_ARCHITECTURE_STATE_2026-08-17.md) §10
are now ruled.** The B1-B5 picking programme brief may be written once `R-2026-08-24-1`'s FAR-107
amendment is actually applied — that is, after a non-author reviewer returns GO on the drafted diff.
Ruling the item is not the same as executing it, and §8/§9 stay unbuilt until the amendment lands.

---

## R-2026-08-24-1 — FAR-107 gains the identity-plateau condition (amendment drafted; review pending)

**The question.** Verbatim from [PICKING_ARCHITECTURE_STATE_2026-08-17.md](PICKING_ARCHITECTURE_STATE_2026-08-17.md):513-520,
§10 item 1:

> 1. **FAR-107 says the opposite of what §7.3 proposes.** Its written contract
>    (`FORK_ARCHITECTURE_REMEDIATION_PLAN_2026-07-13.md:455-464`) states a WebGPU synchronous call
>    "may return only an already-complete result whose entire query/generation identity matches" and
>    orders "Delete stale prior-frame/location/property/pass substitution." It has been
>    BLOCKED-ON-MAINTAINER since the G1-G10 sweep. The identity-plateau predicate is a
>    *reconciliation* — it keeps "identity must match" by proving the identity is **invariant over the
>    reprojection uncertainty** rather than by comparing poses. **Does that satisfy FAR-107, or must
>    FAR-107 be amended?** This is the single ruling that unblocks the architecture.

**The options, as presented.**

- **(a) Read FAR-107 as satisfied, not amended.** This is the answer provisionally adopted on
  2026-08-21 — `R-2026-08-21-2` item 1: *"the identity-plateau predicate SATISFIES FAR-107's intent:
  it keeps 'identity must match' by proving identity invariance over the reprojection uncertainty
  rather than by pose comparison. FAR-107 is read as satisfied, not amended."* Cost: the governing
  sentence continues to read as an absolute prohibition of the thing the predicate permits, and the
  reconciliation lives only in a state document a later reader may not reach.
- **(b) Amend FAR-107** so the condition is encoded in the contract's own text.
  Cost: it edits a ratified release-gate row whose own **Size** line requires public-API review, so
  it cannot be self-approved and cannot land in the same motion as the ruling.

**The choice: (b), amend.** FAR-107's **Work** and **Rollback** bullets are amended to state that a
WebGPU synchronous call may also return a result whose query/generation identity is *proven
invariant* over the reprojection uncertainty separating that result's frame from the call, and that
an unproven plateau serve remains stale substitution. **Stale substitution stays deleted** — the
amendment narrows the wording only where a proof exists; it does not create an exception to the
match requirement, and it does not make stale substitution a rollback mode.

**Supersession.** This supersedes `R-2026-08-21-2` item 1's "satisfied, not amended" reading. That
reading was provisional on its face — `MAINTAINER_RULINGS_2026-08-21.md:5-9` marks the entire
morning batch *"PROVISIONAL … explicitly reversible, and to be re-presented to the maintainer with
landing evidence rather than treated as settled law."* This is that re-presentation for item 1.
Items 2-6 of `R-2026-08-21-2` are untouched and remain provisional.

**The evidence.**

- **The current words**, quoted exactly from
  `FORK_ARCHITECTURE_REMEDIATION_PLAN_2026-07-13.md:462` (the **Work** bullet):
  > A WebGPU synchronous call may return only an already-complete result whose entire
  > query/generation identity matches; otherwise it reports a documented, feature-detectable
  > unsupported state. Delete stale prior-frame/location/property/pass substitution.

  and `:464` (the **Rollback** bullet):
  > - **Rollback:** retain the WebGL sync implementation and a context-creation-only WebGPU executor
  >   switch during migration; stale substitution is never a rollback mode.

- **The amended words** are in the drafted diff, `far107-amendment.diff`, which keeps every other
  byte of the row identical (verified: `git apply --check` clean at `daaca4fde8`, no file modified).
  The **Work** bullet becomes *"…whose entire query/generation identity either matches or is proven
  invariant over the reprojection uncertainty separating that result's frame from the call — the
  identity-plateau predicate, which establishes the required match by proof rather than by pose
  comparison and holds only under the enumerated conditions it carries; otherwise it reports a
  documented, feature-detectable unsupported state. Delete stale prior-frame/location/property/pass
  substitution: a serve whose plateau conditions are not proven at the call is stale substitution,
  not a plateau."* The **Rollback** bullet gains *", and neither is widening the identity-plateau
  predicate past its proven conditions."* A dated amendment bullet citing this ruling is appended.

- **The independent finding that the text needed stamping** is
  [DECISION_PACKET_2026-08-18.md](DECISION_PACKET_2026-08-18.md):551-554, which re-derived it rather
  than relaying it: *"**VERIFIED — `FAR-107` still reads absolutely.**"* Its B2 rider at `:619`
  ordered the stamp: *"**stamp `FAR-107:463-464` with the amendment** — it currently reads as an
  absolute prohibition of the thing `R-3` permits"*.

- **Line-citation drift, corrected here.** The packet cites the "Delete stale …" sentence at
  `:463`. At `daaca4fde8` that sentence is on **`:462`** (the **Work** bullet); `:463` is the
  **Acceptance** bullet. The second half of the packet's citation (`:464`, the **Rollback** bullet)
  is correct. The drafted diff targets `:462` and `:464`.

- **The proof's real scope is narrower than the prohibition it relaxes**, and the amendment's
  "enumerated conditions" clause exists to carry that. `DECISION_PACKET_2026-08-18.md:541-542`:
  *"Only the rotation term of the reprojection is depth-independent; pan and dolly need per-pixel
  depth, and Cesium's orbit drag translates the camera."* The amendment therefore licenses a
  *conditional* plateau, consistent with that packet's B2 recommendation to restate `R-3` as
  conditional; it does not ratify an unconditional serve.

**On the review obligation, and a correction to the dispatch note.** The wave plan characterised
FAR-107 as a `[HARD]` block. **That is not literally true and should not be repeated**:
`grep -n "HARD" migration_doc/FORK_ARCHITECTURE_REMEDIATION_PLAN_2026-07-13.md` returns nothing —
the file carries no `[HARD]` markers at all. The precedent that does use that phrase,
`DECISION_PACKET_2026-08-18.md:1345` (*"Edits a tracked `[HARD]` block (needs non-author review)"*),
is row **A1 / `R-15`**, the `EXECUTOR_LANE_CHARTER` §0.4 edit — a different target.

The non-author-review obligation is adopted anyway, on two verified grounds that are stronger than
the mistaken one: **FAR-107's own `:457`** reads *"- **Size:** L; public-API review required"*, and
`EXECUTOR_LANE_CHARTER_2026-08-14.md:342` §4.6 is *"**[HARD] Certification authors do not
self-approve.**"* The amendment is therefore **drafted only**. It is applied to the repository after
an independent, read-only reviewer who did not author it returns GO.

**What it discharges / unblocks.**

- `PICKING_ARCHITECTURE_STATE_2026-08-17.md` §10 **item 1 → RULED** (amendment pending review). The
  BLOCKED-ON-MAINTAINER state it has held since the G1-G10 sweep ends.
- It does **not** unblock the picking programme yet. §8/§9 stay unbuilt until the amendment actually
  lands and B1-B5 run, and `R-2026-08-21-21` continues to hold the eleven 2026-08-21 amendments
  provisional *"until the picking programme (B1-B5) has run under them"*.
- §10 items 2-6 remain as `R-2026-08-21-2` left them: provisional, unre-presented.

---

## R-2026-08-24-2 — Frozen-build probes certify the gulp artifact, under a fail-closed hash assertion

**The question.** Verbatim from [DEFERRED_WORK.md](DEFERRED_WORK.md):246-249, inside
`NEW-DEVSERVER-SERVES-DEV-BUILD-NOT-GULP-ARTIFACT`:

> The open design question is therefore not whether to invent that mode. It is whether frozen-build
> probes must standardize on the existing `--production` mode and prove the served hash equals the
> gulp artifact, or whether they certify the `Build/CesiumDev`/in-memory development output as the
> artifact under test and say so. Do not infer one policy from a server invocation; the maintainer
> must choose and the lane must encode it.

**The options, as presented.**

- **(a) Standardize on the built artifact** (`Build/CesiumUnminified`) and prove the served bytes
  hash-equal the on-disk artifact. Cost: every frozen-build probe needs a gulp build first and a
  provenance assertion wired in; probes that lack it must be repaired before they can certify.
- **(b) Certify the development output** (`Build/CesiumDev` / the in-memory build) and declare it as
  the artifact under test. Cost: certification then attests a bundle no release ever ships, and the
  gulp artifact stays uncertified.

**The choice: (a).** Frozen-build probes certify the **gulp artifact `Build/CesiumUnminified`**,
served by the server's built-artifact mode, with a **fail-closed assertion binding the fetched bytes
to the on-disk artifact** — a served-vs-disk `sha256` and byte-length compare whose failure is an
error, not a warning. Iteration and debugging runs may continue to use the development build; this
policy binds certification and acceptance runs only.

**Relationship to `R-2026-08-21-5`.** That ruling already chose the same side —
*"Certification and acceptance probe runs attest the **gulp bundle** (`--serve-built` / `--production`
serving `Build/CesiumUnminified`) … Closes `NEW-DEVSERVER-SERVES-DEV-BUILD-NOT-GULP-ARTIFACT`
provisionally."* This ruling **confirms it, moves it from provisional to operative, and adds the
enforcement half** the ledger entry names as the closing condition. `R-2026-08-21-5` is not
superseded; it is completed.

**The evidence.**

- **The ledger's own closing condition**, `DEFERRED_WORK.md:251-254`:
  > **What closes it.** Record the chosen artifact policy and add a fail-closed provenance assertion
  > binding fetched bytes to that declared artifact. Until then, a successful gulp build plus a green
  > default-server probe cannot certify the same bundle.

- **A dedicated serve mode already exists and the ledger entry does not mention it.** `server.js`
  gained `--serve-built` at **Batch 1065 (`e9660aaf18`, 2026-08-20)** — *"dev server - an opt-in mode
  that serves the built artifact, so a probe can certify the bundle gulp actually produced"* — the
  same day the ledger entry was filed. The entry's "Correction to the initially proposed design fork"
  paragraph knows only `--production`.

- **`--serve-built` is the better mode of the two, and the policy names it first.** It fail-closes on
  a missing artifact (`server.js:37-49`, which throws *"Cannot serve the built artifact: directory …
  does not exist. Run …"* and again on a missing `Cesium.js`), whereas `--production`
  (`server.js:58-64`) returns the built directory with **no existence check at all** — a stale or
  absent `Build/CesiumUnminified` under `--production` surfaces as 404s mid-run instead of refusing
  to start.

- **The ledger entry's line citations have drifted** and should be refreshed when it is stamped. It
  cites `server.js:62` for `Build/CesiumDev` (now `:25`), `server.js:45-48` for `--production` (now
  `:98-101`), and `scripts/build.js:1944-1950` for the output-directory resolution (that range is
  now `buildWorkspaceSpecBundle`, an unrelated function). Its `gulpfile.js:131-134` citation for
  `buildCesium` still resolves.

**Which probes already comply.** Eleven probe entry points of 637
(`ls Tools/visual-regression/probe-*.mjs | wc -l` = 637) already perform a served-vs-disk provenance
compare:

- Via the shared helper `validateServedEntryIdentities`
  (`Tools/visual-regression/lib/build-source-identity.mjs:193`, which pushes
  *"served runtime entry differs from the local start entry"* on mismatch) — seven probes:
  `probe-c12-29-s4-orbital-sunrise.mjs:1315`, `probe-c12-29-s5-custom-ellipsoid.mjs:5674,:5690`,
  `probe-c12-29-s5-multiview.mjs:1646`, `probe-c12-29-s5-svs-footprint.mjs:2229`,
  `probe-c12-29-s5-terrain-selection.mjs:2462`, `probe-eclipse-cloud-response.mjs:3334`,
  `probe-moon-globe-depth-occlusion.mjs`.
- Via bespoke equivalents — four more: `probe-c12-29-s5-replacement-device.mjs:3149`
  (fail-closed in `lib/c12-29-s5-replacement-device-gate.mjs:1497`,
  `materialized.servedMatchesLocal !== true`); `probe-moon-mip-motion-edge.mjs:1627`
  (*"did not retain its exact label/path/URL and matching served/local byte identity"*);
  `probe-cloud-u2-perf.mjs:1200-1208` (throws *"C13_U2_BUNDLE_PATH is not the exact Cesium.js served
  by PROBE_BASE"*); and `assess-c11-146-route.mjs` via `lib/c11-146-route-evidence.mjs:304-308`
  (*"served index.js bytes differ from the local runtime entry"*).

**Which frozen-build probes do not.** Of the four rows in the pre-registered order recorded by
[T0_FROZEN_BUILD_PROGRAM_2026-08-21.md](T0_FROZEN_BUILD_PROGRAM_2026-08-21.md) — *"C11-13 → C11-90 →
C18-V2 → C11-146"* — only **C11-146** carries the assertion. The other three do not, and each is a
false-comfort case because each *does* hash things, just not the served bundle:

- **C11-13** — `Tools/visual-regression/lib/c11-13-voxel-inside-camera-probe.mjs` hashes local
  evidence-file snapshots for start/end tamper detection (`:328`, `:362`); no served response is compared.
- **C11-90** — `Tools/visual-regression/lib/c11-90-primitive-restart-probe.mjs` has the same shape
  (`:174`, `:191`). Its `servedDemo` constant (`:110`) resolves a **local** path, not a served response.
- **C18-V2** — `Tools/visual-regression/capture-and-diff.mjs` hashes captured PNGs (`:232`, `:305`)
  and the setup source (`:569`); its only `fetch` is a `data:` URL used to decode a PNG (`:357`).

That the T0 program ran *"served as the built artifact (`--production`, per ruling R-2026-08-21-5)"*
(program doc, opening paragraph) is an **operator claim about an invocation** — precisely what the
ledger entry warns against with *"Do not infer one policy from a server invocation"*. Three of its
four rows could not have detected a violation of it.

**What it discharges / unblocks.** `NEW-DEVSERVER-SERVES-DEV-BUILD-NOT-GULP-ARTIFACT` moves from
*"Maintainer decision required"* to **policy RULED, enforcement owed**, with a named and bounded
remainder: it closes when the C11-13, C11-90 and C18-V2 probes carry the fail-closed assertion — the
shared `validateServedEntryIdentities` helper already exists, so this is wiring, not design. Until
then the entry stays OPEN, and no certification run may claim the gulp artifact on those three rows.

---

## R-2026-08-24-3 — Campaign 13 ownership re-partitioned by work shape

**The question.** May Codex Sol build Campaign 13 work, given the 2026-07-24 Option B ruling that
assigned all C13 execution to the orchestrator — and what is the standing of Batches 1131 and 1136,
which were built by Sol?

The ruling in force, verbatim from [QUEUE_2026-07-23_CAMPAIGN13.md](QUEUE_2026-07-23_CAMPAIGN13.md):31-36:

> **EXECUTOR RULING (maintainer, 2026-07-24, recorded Batch 758): the orchestrator (Claude Fable/Opus
> workers) owns ALL Campaign 13 execution — Option B.** Sol 5.6's dispatch lane is closed; the
> maintainer will handle any future re-partitioning. If Sol returns and leaves uncommitted work in the
> tree, it is taken over, independently verified, and landed under orchestrator review (the Batch
> 743/754 takeover protocol). The C13 dispatch freeze is LIFTED.

**The options, as presented.**

- **(a) Keep Option B absolute.** Sol never touches C13; Batches 1131 and 1136 are treated as
  violations and their deliverables re-authored under Opus. Cost: discards two reviewed, landed,
  spec-pinned instrument batches and re-spends the same Opus capacity on work whose correctness is
  already evidenced.
- **(b) Re-partition by work shape.** Sol may build **bounded, spec-verifiable C13 instrument and
  harness work** under an Opus lane lead with a **separate Opus station-3 review**, the orchestrator
  landing; **C13 engine-semantic changes stay Opus-authored**. Cost: a second reviewer per package,
  and a shape boundary that has to be judged at dispatch rather than read off a row ID.

**The choice: (b).** Note that the original ruling **reserved re-partitioning to the maintainer**
(*"the maintainer will handle any future re-partitioning"*), so this is the reserved act being
exercised, not a workaround of it. The Option B assignment stands for everything outside the named
carve-out.

**The evidence.**

- **SOL-4 is C13 territory, not a side lane.** `QUEUE_2026-07-23_CAMPAIGN13.md:704` records the
  `C13-41` row's reopened exit condition as *"exit = SOL-4 banked refresh cost + the 1.0496
  shadowContrastInvariant mechanism"* — and `C13-41` is that queue's *"★ **C14 CRITICAL PATH**"* row.
- **Both batches were Sol-built, and both disclosed it at the time.** Batch 1131 (`1c2161c8de`,
  *"SOL-4 refresh-cost lane re-instrumented on GPU timestamp queries"*) states in its own message
  that *"a Sol self-review caught that the first cut accepted an empty sample array as a 0 ms refresh
  and the fill binding was added before handoff"*, and discloses that *"the doctrine comment … was
  dropped by the worker and is owed back"*. Batch 1136 (`e2615ef8e2`) is its round 2.
- **Both were reviewed at the tier this ruling requires.** Each message records *"Station-3 review
  (cross-family)"*, and in both cases that review found substantive defects rather than rubber-stamping:
  1131's review *"found two severity-1 honesty gaps closed at landing"* (the lane timed *"one of
  forty-four compute passes"*, and an all-zero sample set had certified *"valid: true, 0 ms/refresh"*);
  1136's review re-derived the pass set from the engine and its six mutants were all caught.
- **The shape split is the one the recorded doctrine already recommends.** The Sol orchestration
  memory records: split *"by SHAPE not quality (Sol = bounded single-deliverable; Opus = judgement/
  cross-file)"*, that *"cross-family review is the tier that finds real defects"*, and that *"the
  surviving failure mode is the orchestrator unverified brief, not the worker"* — the last of which is
  why this ruling puts an Opus **lane lead** in front of the worker, not merely a reviewer behind it.
  `CLAUDE.md` Principle 10 governs that brief.

**What it regularizes.** Batches 1131 and 1136 were a **disclosed deviation** from the 2026-07-24
Option B partition: disclosed in their commit messages, but never reconciled against the queue's own
executor-ruling block, which still read as an absolute prohibition. That reconciliation gap — not the
work — is the defect this ruling closes. Both batches stand as landed.

**What it discharges / unblocks.** SOL-4 round 3 and comparable bounded C13 instrument/harness work
may be Sol-dispatched under the stated conditions. C13 engine-semantic rows remain Opus-authored, and
the Batch 743/754 takeover protocol continues to govern any uncommitted Sol work found in the tree.

---

## R-2026-08-24-4 — Lane F is taken this wave in its honest form

**The question.** Lane F — the C18-P point-cloud / EDL / GPU-LOD / Draco package, ~4,500 lines across
26 of main's 51 held dirty paths — has **never had a station-3 review** and owes terminal browser
gates. Does the whole 51-path dirty set stay held until those gates run?

**The options, as presented.**

- **(a) Hold everything** until lane F's gates run. Cost: the 25 non-lane-F paths stay hostage to an
  unrelated package, and two instruments stay disabled (below).
- **(b) Land the package now** on the author's word, gates unrun and review never done. Cost: it
  would be the largest unreviewed landing of the campaign, on a package with two explicit landing
  guards and a known unclassified convention hit.
- **(c) The honest form:** disentangle the set and take each part at the confidence it has actually
  earned.

**The choice: (c).** Concretely, this wave: **Lane A** disentangles the 51 paths and lands the
non-lane-F slices tonight; **Lane B** runs the package's **first station-3 review, read-only**, with a
verdict that is **advisory until the browser gates run**; the **engine package lands when its browser
gates run** (C18-P2 per-format colour fixtures and negative controls, C18-P5 real compressed-Draco
gate) after the executor frees Edge.

**The evidence.**

- **The package's own status**, [DIRTY_LANES_2026-08-21.md](DIRTY_LANES_2026-08-21.md):61-66:
  > **Status:** implementation locally complete per the queue's own stamps; **terminal browser gates
  > owed** (per-format colour fixtures + negative controls for C18-P2; a real compressed Draco
  > ready/render gate for C18-P5). **Gate:** machine lane, not a ruling. **Known cross-lane debt:**
  > one unclassified `enabled !== false` convention hit in `WebGPUPointCloudEyeDomeLighting.ts` that
  > the landed celestial-gate class audit names — classify it at this lane's landing.

  *"Gate: machine lane, not a ruling"* is why option (b) is unavailable: no ruling can substitute for
  the measurement.
- **Two landing guards already constrain what the package may claim.** On the `C18-P4` row,
  [QUEUE_2026-08-09_CAMPAIGN18.md](QUEUE_2026-08-09_CAMPAIGN18.md):386:
  > **LANDING GUARD (2026-08-21): the lane-F dedicated-path renderer package does NOT discharge this
  > row — P4 is the MODEL-path EDL routing, and no model-path EDL producer exists in that package; its
  > landing must not claim P4.**

  And on the `C18-A1` row, `:388`:
  > **RECIPE REFRESH OWED (2026-08-21): the acceptance recipe cites the pre-lane-F 4-band
  > `PointCloudLOD.wgsl` shape; lane F rewrites the LOD processor, so re-derive the former-band-radii
  > dolly probe against the landed shader before dispatch.**

  `C18-P5` (`:387`) additionally carries a gate precondition that
  *"`Source/ThirdParty/draco_decoder.wasm` is a gitignored generated artifact — the browser gate must
  verify the served build actually provisions it before scoring, or a missing decoder reads as the
  very hang the row fixes."*
- **The cost of holding is measured, not asserted.** `node --test
  Tools/visual-regression/celestial-gate-class-audit.spec.mjs` at `daaca4fde8` is **RED, 5 pass / 1
  fail** — re-run for this record: `not ok 2 - the masked !== false discovery has no unclassified
  leak`, on `packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudEyeDomeLighting.ts:780 enabled
  !== false`. That is the C12 EXIT-2 instrument, red solely on a lane-F file. Separately,
  `capture-and-diff.mjs:683-689` refuses baseline promotion while `git.sourceDirty`
  (*"baseline promotion denied: candidate Git worktree is dirty"*, `process.exit(2)`), so the whole
  visual-regression promotion path is blocked by the held set regardless of which lane owns a path.
- **A register gap the review must resolve, stated precisely.** Lane F claims a
  `FEATURE_INVENTORY.md` PNTS-retention entry. The ledger ID
  **`NEW-PNTS-TYPEDARRAY-RETENTION-RECORD` exists** — `DEFERRED_WORK.md:14175` — but there is **no
  occurrence of it in `FEATURE_INVENTORY.md`**, which is the half the row
  (`QUEUE_2026-07-15_CAMPAIGN9.md:308`: *"Record the PNTS typedArray retention cost … in
  FEATURE_INVENTORY/DEFERRED_WORK"*) also requires. Lane M's held-out
  `finding-ownership-audit.spec.mjs` waits on this.

**What it discharges / unblocks.** The 25 non-lane-F paths become landable this wave on their own
evidence. Lane F's package gets the review it has never had, at a cost of zero browser time, so that
when Edge frees up the only thing owed is the measurement. The `enabled !== false` classification is
assigned to Lane B rather than left to the landing. No verdict on the package is claimed by this
ruling; `R-2026-08-24-4` decides sequencing, not correctness.

---

*Executions in flight at ruling time: the executor's serialized Edge queue (bundle refresh → C15-G9
re-run → SOL-4 commissioning → C11-62 clause (b), then the C12-33 ten-run set after Batch 1138
reaches the worktree); Lanes A-L of the 2026-08-24 wave. Batch 1138 (moon-mip readiness cascade) was
in station-3 review when these rulings were taken.*

---

# §2 — Second sitting, 2026-08-24 ~16:35-16:40 ET

These seven were taken after the wave's lanes reported. They are operative on the same terms as
`R-2026-08-24-1..4` above, and add-only: nothing here renumbers or reuses an earlier ID.

---

## R-2026-08-24-5 — `C15-G9` is CLOSED as NOT REPRODUCED on the current bundle

**The question.** The tower frame-variance mechanism (`C15-GSPLAT-TOWER-FRAME-VARIANCE`) has owned a
structural line since Batch 916, where capture-determinism measured 0.055% against a mutant-pinned
0.050% bar. `R-2026-08-21-17` authorized the D1-D5 discriminator harness rather than a design
ruling. Three runs have now executed. Does the row close, stay open, or widen its bar?

**The choice: CLOSED as NOT REPRODUCED.** Across runs `dfbb1070`, `4812501f` and `c241a577` the
subject variance did not reproduce at the unchanged bar. Run 3 (2026-08-24, 15:34-15:39 ET) ran on a
fresh bundle with all four harness defects of the earlier runs absent, the WebGPU control asset
rendering, D1 and D2 PASS on both backends, and D3/D4/D5 reporting `subject-not-reproduced` at
0.012-0.025% — every cell well under 0.050%.

**Three things this ruling explicitly does NOT do.**

1. **It does not widen the bar.** The 0.050% mutant pin stands exactly as written. The row's own text
   says a widening is a failure of the row, not a pass, and that clause is honoured.
2. **It does not claim a mechanism.** NOT REPRODUCED is not "explained". The honest reading is that
   the 0.055% measured at Batch 916 was either environmental or has been incidentally repaired by
   the landings since — and the harness cannot distinguish those two on a bundle that no longer
   exhibits it.
3. **It does not retire the instrument.** The D1-D5 harness stays **armed**. If the line returns, the
   discriminators are the answer already built, and the row reopens on evidence rather than on
   memory.

**What it unblocks.** The tower leg of `C15-G8`, which `C15-G9` was blocking. `C15-G8` may now arm
its per-asset thresholds on both assets subject to its own conditions; nothing in this ruling
discharges any other `C15-G8` clause.

---

## R-2026-08-24-6 — Picking §10 item 2: single-texel capture by default, 33x33 opt-in

**The question, verbatim.** *"How wide should the synchronous capture aperture be, and who pays?
33x33 costs ~4 KB per sync pick instead of 36 bytes. Acceptable on a continuous-hover path, or
opt-in via a scene option?"*

**The choice.** **Single-texel synchronous capture is the default; the 33x33 aperture is opt-in
through a scene option.** A continuous-hover path is the common case and it should not pay ~4 KB per
pick — a ~114x readback increase — for an aperture most callers never read. Applications that want
the wider aperture ask for it, and pay for it knowingly.

**Consequence for the build.** The wide aperture is a declared capability, not an implicit one, so
the option's default must be `false` and its cost documented at the option rather than in a design
note. Both backends expose the same option; a backend that cannot honour it says so through the
readiness union rather than silently narrowing.

---

## R-2026-08-24-7 — Picking §10 item 3: a tunable frame-age cap, default 2, with `PickDepth` pulled to match

**The question, verbatim.** *"What is the hard frame-age cap? Proposed 2 — tighter than
`PickDepth`'s 4 and Snap's 8, because pick returns an identity rather than an interpolable scalar.
Fixed or tunable? Should S6 pull `PickDepth` down to match?"*

**The choice.** **Tunable, defaulting to 2 — and yes, pull `PickDepth` down to match.** The
reasoning in the question is accepted as stated: an identity does not interpolate, so a stale
identity is wrong in a way a stale depth is merely imprecise. Two is the default because that is the
number the analysis derived; tunable because the right cap is a function of the application's motion
profile, which the engine cannot know.

**On `PickDepth`.** Its window of 4 predates this analysis and is not defended by it. Bringing it to
the same cap removes a divergence that would otherwise have to be explained every time the two
readbacks disagree. This is S6's work and it is ordered here, not merely permitted.

---

## R-2026-08-24-8 — Picking §10 item 4: declarative prewarm

**The question, verbatim.** *"Imperative or declarative prewarm? Upstream's idiom is a boolean option
(`preloadWhenHidden`) plus an Event. Should `Scene.preparePickAsync()` be public, or should the
public surface be `contextOptions.prewarmPicking: true` + `pickReadyEvent`?"*

**The choice.** **Declarative: `contextOptions.prewarmPicking` plus `pickReadyEvent`.** It matches
the upstream idiom the question itself names, which is the fork's standing tie-breaker on public
API shape. A declarative option also states an intent the engine can satisfy however it likes,
whereas a public `preparePickAsync()` freezes a scheduling decision into the API surface and invites
callers to sequence work the engine is better placed to sequence.

**Not ruled here.** Whether an internal `preparePickAsync` exists is an implementation matter; this
ruling governs only what is **public**.

---

## R-2026-08-24-9 — Picking §10 item 5: globe pick IDs behind an explicit `Globe.pickable` opt-in on BOTH backends

**The question, verbatim.** *"Globe pick parity. `Globe.pickable` is honored by WebGPU only
(`Globe.js:114-117`), and the S5 gate encodes the divergence:
`expectedPickKind = renderer === "webgpu" ? "globe" : "undefined"` (gate `lib:3526`). Should this
work also mint globe pick IDs on WebGL so the backends agree, or is the divergence deliberate and
permanent?"*

**The choice.** **Both backends mint globe pick IDs only behind an explicit `Globe.pickable`
opt-in, and upstream's default behaviour is preserved on both** — `scene.pick` on a bare globe
returns `undefined` unless the application opts in. The divergence is retired by making WebGL honour
the flag, not by making WebGPU stop honouring it, and not by turning globe picking on by default on
either backend.

**Why the default is preserved.** Minting globe pick IDs unconditionally is an observable behaviour
change to every existing application that picks through a globe expecting to hit what is behind it.
Core Principle 1 governs: preserve existing functionality. The opt-in is the additive half; the
default is the compatibility half, and both are required.

**What retires with it.** The S5 gate's
`expectedPickKind = renderer === "webgpu" ? "globe" : "undefined"` divergence is to be retired when
this lands — the gate then expects the same kind on both backends for the same opt-in state. Until
it lands the gate stays as written; a gate that encodes a divergence must not be edited ahead of the
behaviour it encodes.

---

## R-2026-08-24-10 — Picking §10 item 6: `drillPick` adopts the same readiness predicate as `pick`

**The question, verbatim.** *"Does the predicate govern `drillPick`? Retiring the `isWebGPU` branch
at `Picking.js:919` (P-7) means drillPick must either adopt the predicate or declare `unsupported`
through the readiness union."*

**The choice.** **`drillPick` adopts the predicate.** When the `isWebGPU` branch is retired,
`drillPick` uses the same readiness predicate as `pick`; it does **not** declare `unsupported`
through the readiness union. Two picking entry points with two readiness contracts is a seam that
would have to be explained forever, and `unsupported` is a claim about capability that is not true
here — the capability exists, it is the readiness that has to be waited on.

**Sequencing.** This rides P-7. It is not a licence to retire the branch ahead of the predicate's
own landing.

---

## R-2026-08-24-11 — The sixteen-cell moon-mip design waits for `sign-test-v1`'s ten-run set

**The question.** `R-2026-08-21-15` blessed BOTH moon-mip acceptance designs: `sign-test-v1`
(four-cell, custody-hashed at Batch 1100) as the design of record now, and a sixteen-cell ratio
design as a later build that may run **only** after the maintainer pre-registers its correlation
`r` — never post hoc. Should that `r` be pre-registered now?

**The choice.** **Deferred. The `r` is not pre-registered this wave, and the sixteen-cell build is
not dispatched.** `sign-test-v1`'s ten-run set reports first; its numbers inform what a defensible
`r` would be. Pre-registering a correlation before seeing the instrument's own dispersion would be
pre-registration in form only.

**What is unchanged.** `R-2026-08-21-15` stands in full — both designs remain blessed, `sign-test-v1`
remains the design of record, and the never-post-hoc rule on `r` is reaffirmed, not relaxed. This
ruling sets the ordering, nothing else.

---

## R-2026-08-24-12 — Evidence library repair: RELOCATE, then re-admit through `import-legacy`

**Question.** The publication tool refused every producer because three C13-16 U2 evidence
directories (`c13-16-u2-b1108`, `-b1108b`, `-b1108c`) had been copied by hand into the root of
`cesium-webgpu-visual-evidence` on 2026-08-21, and `archiveVisualEvidence` verifies the whole
library before any first-time publication. This blocked the C12-33 certification lane.

**Ruled (third sitting, ~18:20 ET).** Rename-move the three directories out of the library root
into a sibling staging folder (`cesium-webgpu-visual-evidence-staging/`, left in place), then
re-admit their bytes through the supported `import-legacy` path. Nothing is deleted. The
alternative — leave the library untouched for a later manual repair — was rejected because it
held the C12 critical path on a defect of process, not of evidence. Executed the same evening:
185 files inventoried by sha256, moved with inodes preserved, verifier green, re-admitted as
`legacy/c13-16-u2/…`, verifier green again (33 publications, 145/145 objects). One forced
deviation recorded: the tool stamps Git provenance from `--source-root`, so the import ran from
a byte-verified scaffold inside the worktree because the staging folder has no `.git`.

**Lesson recorded with it.** `archive` captures repository provenance per run and the finalizer
demands one identity across a ten-run block; a landing that moves `HEAD` mid-publication spends
the block irrecoverably in an append-only library. Publications and landings are serialized
from now on — the lane is granted an explicit quiescent window.

---

## R-2026-08-24-13 — Lane F: the far distance cull and `lodFarDistance` are RESTORED as a kept toggle before landing

**Question.** The GPU point-cloud LOD rewrite to projected geometric error dropped the fourth
"culled" tier, so points beyond the former far radius now render at 1/64 instead of not at all,
and the public `lodFarDistance` knob that tuned that cull was deleted (zero consumers). No A/B
was measured. The package is otherwise a correctness fix (colour formats, Draco, EDL).

**Ruled (fourth sitting, ~21:00 ET).** Restore the cull as a culled tier gated on
`lodFarDistance` in projected-error space with the prior default, and restore the knob; then
land. This is the fork's own governing principle — never remove additive behaviour as a side
effect, keep the toggle — and it keeps the `C18-A1` acceptance recipe valid. The alternative
(accept the removal as declared with an interleaved A/B owed) was rejected: a behaviour change
and a removed public knob would have shipped unmeasured inside a bug-fix batch.

---

## R-2026-08-24-14 — `C15-G6`: an asymmetric one-backend zero-splat result is FAIL, not STRUCTURAL

**Question.** In the authored, unrun multi-frustum probe, the case where WebGL composes
splat-coloured pixels and WebGPU composes none — both backends holding at least one splat draw
command — exited 3 STRUCTURAL ("could not see its subject"), although it is the row's headline
defect. The tier had to be pre-registered before the first machine run.

**Ruled.** Asymmetric → tier 1 FAIL (exit 1): the subject was seen and failed. The symmetric
zero/zero case stays tier 3 STRUCTURAL. This matches `lib/verdict-exit-gate.mjs`'s own
definitions; keeping STRUCTURAL and relying on the artifact's reason string was rejected because
exit-code consumers would read the headline defect as instrument blindness.

---

## R-2026-08-24-15 — `C11-62` clause (b): the ledger clause STANDS; the row stays open until a timed comparison runs

**Question.** The queue row narrows clause (b) to "run case E" (skip counters + pixel identity,
now green on both backends after the domain fix), while `DEFERRED_WORK.md` demands a measured
comparison proving the enabled octree beats ordinary Scene PVS on the moving multi-altitude
route with more than 200 commands — which case E does not perform.

**Ruled.** Keep the ledger clause. `C11-62` clause (b) cannot close on case E; the timed
octree-versus-PVS instrument over the canonical moving-altitude route must be built and run
first. The recommended alternative (amend the ledger to match the row and file the timing as its
own row) was declined: the performance claim is the point of the row. The fix lands on its own
merits with the row explicitly OPEN.

---

## R-2026-08-24-16 — `C15-G6` precedence: the asymmetric FAIL outranks that backend's own anti-vacuity structurals

**Question.** Under `R-2026-08-24-14` the probe routed an all-background WebGPU frame (WebGL composing
splats and globe, both backends holding at least one splat and one globe command, frames valid) to
exit 3, because the same-backend `labels:zero-globe` and `labels:single-label-frame` anti-vacuity
reasons outranked the asymmetric FAIL — the severest shape of the headline defect read as
instrument blindness, the misread `R-2026-08-24-14` rejected.

**Ruled (fifth sitting, ~21:55 ET).** When one backend composed zero splat pixels while the other
backend's partition is valid and composed splat pixels, and the zero backend's settled frame proved
its splat and globe draw commands exist, that backend's own zero-globe and single-label reasons are
consequences of the same compose failure and do not demote the verdict: the run is FAIL (exit 1)
with the asymmetric reason in the top-level failure list, and those reasons are published as
diagnostics. Unrelated structurals — frame-dimension mismatch, an invalid partition, a corner
precondition mismatch, an unproven settled frame on either backend, capture-contract or
framing-agreement failures — still outrank both. The alternative (keep any-structural-wins and
disclose it) was rejected for the reason `R-2026-08-24-14` already gave. A tooth pins the new
precedence and an inertness mutant restoring the old one must be caught.
