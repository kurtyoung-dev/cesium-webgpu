# Campaign Portfolio Queue — Feature-Priority Dispatch

**Status:** LIVE dispatch view, refreshed 2026-08-12 at committed `main`
`5b3045d42b`. The current shared workspace also contains independently owned
local campaign packets; this board labels those `LOCAL` rather than treating
them as landed.

This document answers one question: **which bounded campaign slice should the
orchestrator dispatch next?** It is deliberately not a status ledger. The
campaign queue rows remain the sole authorities for status, dependencies,
acceptance, and completion. If this board disagrees with a queue row, the queue
row wins and this board must be refreshed.

The prior [`CLOSEOUT_PLAN_2026-08-07.md`](CLOSEOUT_PLAN_2026-08-07.md) is a
historical grouping snapshot. This file supersedes it only as the current
cross-campaign dispatch order; it does not supersede any campaign queue.

## 0. Portfolio shape and current integration barrier

There are **eight reserved campaign identities, C11 through C18**, and **nine
practical workstreams** because Campaign 15 contains two independently governed
lanes:

1. C11 parity, correctness, architecture, and performance;
2. C12 celestial appearance;
3. C13 planetary clouds and weather;
4. C14 dynamic ocean and wind;
5. C15 Aurora and Space Weather;
6. C15 Gaussian splats;
7. C16 comment remediation and attribution;
8. C17 Celestial Light Transport; and
9. C18 voxel, point-cloud, and splat modernization.

Six streams are executable now: C11, C12, C13, C15-GSPLAT, C16, and C18. C14
is held until C12 completes, C15 Aurora is held until C12 completes and still
needs launch authority, and C17 is proposed but not launched. The exploratory
3D Tiles Patch and Invalidation design does **not** implicitly create C19.

The board is derived from these status authorities:

| Stream | Canonical authority |
|---|---|
| C11 | [`QUEUE_2026-07-18_CAMPAIGN11.md`](QUEUE_2026-07-18_CAMPAIGN11.md) |
| C12 | [`QUEUE_2026-07-19_CAMPAIGN12.md`](QUEUE_2026-07-19_CAMPAIGN12.md) |
| C13 | [`QUEUE_2026-07-23_CAMPAIGN13.md`](QUEUE_2026-07-23_CAMPAIGN13.md) |
| C14 | [`OCEAN_DYNAMICS_PLAN_2026-07-24.md`](OCEAN_DYNAMICS_PLAN_2026-07-24.md) |
| C15 Aurora and GSPLAT | [`QUEUE_2026-08-02_CAMPAIGN15.md`](QUEUE_2026-08-02_CAMPAIGN15.md) |
| C16 | [`QUEUE_2026-08-10_CAMPAIGN16.md`](QUEUE_2026-08-10_CAMPAIGN16.md) |
| C17 | [`CELESTIAL_LIGHT_TRANSPORT_PLAN_2026-08-07.md`](CELESTIAL_LIGHT_TRANSPORT_PLAN_2026-08-07.md) |
| C18 | [`QUEUE_2026-08-09_CAMPAIGN18.md`](QUEUE_2026-08-09_CAMPAIGN18.md) |
| Frozen local evidence | [`HANDOFF_2026-08-10_CODEX_USAGE_STOP.md`](HANDOFF_2026-08-10_CODEX_USAGE_STOP.md) |

### T0 integration and acceptance frontier — active now

The shared workspace is still a multi-lane workspace. Its porcelain count is
deliberately omitted: it changes whenever an owned packet freezes or lands and
is not a scheduling invariant. Path ownership, the complete landing-unit diff,
canonical queue state, and source/build/probe identity are the gates.

The immediate frontier is closure work, not a new broad source wave:

1. preserve the landed C11-169 resident-owner attribution evidence and advance
   only its pre-registered uninstrumented C11-168 causal discriminator;
2. on one frozen clean build, retire the current physical-acceptance packets in
   the pre-registered order recorded in §5: C11-13, C11-90, C18-V2, then
   C11-146;
3. keep C11-134's successful offline evidence distinct from its external
   online-control red, and retry the online leg only in a valid live-service and
   token environment;
4. preserve unrelated edits and every immutable first-red artifact; and
5. rerun a green gate only when its source, build, probe, provider, or acceptance
   contract changed.

C11-205 no longer owns an interrupted-run recovery slot: its lifecycle,
exact-work, API-attribution, and six-pair uninstrumented causal gates are green.
C11-169's corrected resident-owner diagnostic and shared Tools packet landed in
Batch 1032 (`be0683c60d`); it selects the next discriminator but makes no causal,
GPU, FPS, or remediation claim. Implement the smallest uninstrumented C11-168
discriminator instead of rerunning the unchanged green attribution route.

`CLT-B3` remains a locally complete, already-authorized bug-fix unit with
landing and terminator-specific browser acceptance owed. It belongs in the T0
integration inventory even though the full C17 epic remains unlaunched.

## 1. Eligibility and priority law

A card is dispatchable only when all of these are true:

- its campaign or independent lane is launched or explicitly authorized;
- every hard dependency and hold is clear;
- the premise has been rechecked against the current source and local diff;
- acceptance, negative controls, honest remainder, and rollback boundary are
  named before implementation;
- no active slice owns the same files, schemas, registries, or browser state;
  and
- the live machine-debt policy in §5 permits another acceptance obligation.

Eligible cards are selected by class before campaign number:

| Class | Meaning |
|---|---|
| T0 | Dirty-tree rescue, active first red, data-loss/crash risk, or P0 regression |
| T1 | Cross-campaign critical path or already-green landing |
| T2 | Shipped correctness defect or measured performance deficit |
| T3 | Additive feature/parity advancement |
| T4 | Maintenance, documentation, and research |

Within one class, compare bounded severity, cross-campaign unlock, user-visible
impact, evidence risk, age, effort, and collision risk. A useful deterministic
score is:

`6 × severity + 5 × unlock + 4 × user impact + 2 × evidence risk + age − 2 × effort − 2 × collision risk`

Age gains one point per five landed batches and is capped at three. Ties resolve
by active red, larger unblock count, landing readiness, smaller effort, then
older batch. Campaign number never supplies priority.

## 2. Current feature-priority board

### Priority 1 — close C12's critical chain

This is the highest-leverage cluster because C12 completion is the sole
remaining C14 launch bar and also holds C15 Aurora. `C13-41` is explicitly on
that critical path through C12-29 S3.

Execute in this order where dependencies permit:

1. **C12-37 — RESOLVED / LANDED / EDGE VERIFIED:** the 15-path product/tool
   packet landed as `6d4a2376fc`; independently audited run
   `1f437ee9-37e5-4d17-94a1-a269e81679ab` is PASS / exit 0 on both backends.
   Its report and 72 verified PNGs are preserved under shared-library manifest
   `33CEE1FB9E1304234DA8743D952D34204FCFE2621885C0383FBAABA6E9113F17`.
2. **C13-41 / C12-29 S3 — REOPENED:** `R-2026-08-14-1` reopened
   the row, and `R-2026-08-17-7` vacated its machine state `closed` →
   `reopened`; S3 remains on the C14 critical path through C12. The historical
   landing-equivalent redesigned-control run was a genuine PASS / 30/30 (run
   `b5e3f63c-94c6-4204-8706-dd30eabd2eaf`), and its exact selective packet landed as
   `9c043987a5`; that superseded result does not close S3. CLT-B3's
   terminator-specific both-backend acceptance remains a separate open gate.
3. **C12-29 S4 — COMPLETE / EDGE VERIFIED; S5 remains open:** S4 browser
   acceptance is green and archived (PASS/0, run
   `6a3eac44-f4b8-477d-b21b-6062de6aaf19`), and its exact independently
   reviewed three-file evidence tool packet is included in the same landing
   unit. S5's first terrain-selection shard is preserved as STRUCTURAL / exit 3
   (run `858fa49d-5c0f-47ca-9e42-55716b626261`) and certifies no matrix cell.
   Independent forensics confines the result to harness identity, held-tile,
   first-`beginFrame`, and pick-snapshot timing defects; the fixture, build,
   renderers, GPU, and environment are healthy. Repair and review the tools-only
   probe before one recovery run. The exact four-record NASA SVS fixture is green
   offline; its geographic browser comparison and the rest of the seven-lane
   matrix remain open.
4. **C12 G3 / C12-12:** prepare the ordered 4096-per-face star-cubemap bake and
   G3 rerun as one maintainer machine session. The manual asset/HDR work is not
   a worker task.
5. **C12 decisions:** resolve CLT-D10/G1 canonicity, C11-79 gate membership, **[RULED 2026-08-21 evening: `R-2026-08-21-14` accept-red carried to C17; `R-2026-08-21-16` all four OUT]**
   and C12-31 follow-up membership. CLT-D10 is an out-of-band ruling now; it
   does not launch all of C17.
6. Burn down C12-33, C12-11, C12-31, C12-G1F2, C12-12 identity, EXIT-2, and
   EXIT-3 under their recorded acceptance order.

### Priority 2 — finish C18 correctness checkpoints and close C15-GSPLAT

First retire already-implemented C18 correctness debt:

1. **C18-V2:** Batch 1028 landed owner-scoped voxel readiness, exact async-pick
   identity, fail-closed readback, ancestor fallback, and root-failure
   propagation. The follow-up harness hardening at `bae6bd0f09` binds setup-file
   identity, refuses dirty-source promotion, and requires public ready plus
   rendered-frame evidence. Rebuild once, run all three Edge scenes, review and
   promote the baselines, then execute every scene's non-vacuity mutation. The
   browser gate remains open.
2. **C18-V3:** run the fresh voxel and point-cloud probe fleet only after V2's
   frozen-build closure.
3. **C18-P1:** close the dedicated-path colour-tint nondeterminism and gate
   de-normalization.
4. **C18-P2:** certify every implemented decode/pass format with its browser
   fixture and negative-control matrix.

The existing local C18-P2 implementation is **preparatory only** until V3 and
P1 clear; it cannot certify or close the row out of dependency order. C18-P5
depends only on V1 and may proceed independently after the V2 machine run.

Then execute the C15-G terminal order exactly as its queue specifies:

1. C15-G7 classification-depth re-verification;
2. C15-G9 tower frame-variance mechanism;
3. C15-G6 real multi-frustum composition gate; and
4. C15-G8 terminal parity and tracker reconciliation.

After G8, resume C18 P/A rows by severity and unlock Wave S. C18 Wave S remains
ineligible before G8.

### Priority 3 — keep C11 moving through focused high-value slices

C11 is too large to wait for whole-campaign closure. Acceptance-locked
C12/C13-41 design, review, and machine preparation may continue concurrently
where paths do not collide. Finish the current C11 closure wave before another
colliding source slice:

1. **C11-13:** the P0 voxel-inside-camera implementation landed in Batch 1031
   (`348063f48b`). It is not complete: the new Edge waypoint probe, outside byte
   identity, focused Karma execution, and ten-probe voxel preservation battery
   remain open.
2. **C11-90:** the fail-closed primitive-restart visual harness landed at
   `c418d01ec3`; the corrected physical both-backend browser recovery remains
   open. Do not promote the triangle strip/fan visual remainder from harness
   evidence alone.
3. **C11-169/C11-205 → C11-168:** the resident-owner attribution packet landed
   in Batch 1032 (`be0683c60d`) and its two distinct harness reds remain
   preserved. Use its direct-model/globe/tileset split to implement the smallest
   uninstrumented causal discriminator. The valid CPU/wall deficit has no
   GPU-timestamp samples, so it is not a GPU-bottleneck verdict.
4. **C11-134/C11-146:** keep the Batch-1029 offline-isolation pass and external
   online red separate; run the online control only in a valid environment.
   The C11-146 fail-closed route assessor landed in Batch 1027, and its one
   moving-altitude route assessment remains open.
5. address C11-202's mutable feature-label source invalidation P1 and run
   C11-193 moving causal/recovery work only when attribution supports it; then
   continue the canonical W1 through W8 order.

C11-137 certification remains held and dead last. No feature removal,
default-disable, bypass, or visual degradation is an optimization.

### Priority 4 — C13 body after the critical row

After C13-41 no longer blocks C12:

1. execute the ready U2 same-build A/B;
2. continue C13-10 → C13-11 Part 2 → C13-12 → C13-13 → Gate C; and
3. continue W3 and Gate D.

Gate B is already closed and must not be reopened. The broad C13 body must not
be allowed to re-block C14 after C13-41 closes. W6 remains deferred.

### Priority 5 — C16 as risk control and disjoint fill capacity

1. Land C16-06a, the checked-in three-class anchor sweep required before the
   next rewrite shard.
2. Obtain the C16-R1 and C16-02c in/out rulings.
3. Run C16-09, C16-11, and C16-12 only where their files are disjoint from
   active feature work.
4. Hold C16-10 until C18's overlapping splat, point, voxel, and compute files
   are landed and frozen.
5. Treat C16-08a as correctness work; it may ride the focused C11 model lane.

C16-20 remains blocked until its enumerated prerequisites close. A cleanup
shard never preempts a T1/T2 feature or correctness slice.

## 3. Held launch queue

Held cards remain visible but consume no implementation WIP.

| Stream | Eligibility trigger | First authorized sequence after trigger |
|---|---|---|
| C14 Dynamic Ocean & Wind | C12 complete, then explicit launch record | W0 baselines/contracts → W1 wind authority plus C12-32 → W2 both-backend water-mask response |
| C15 Aurora + Space Weather | C12 complete and explicit launch | C15-01 state → 02 frame/oval → 03 emission kernel → 04 both renderers → 05/06 ingest → 07 facade → 08 certification |
| C17 Celestial Light Transport | Explicit launch; CLT-D10 may be ruled earlier | A0 → A1 → C0 → C1, then A3/C2 as disjoint slices; B1 is superseded and must not be scheduled |

C14 W3 still depends on the FFT clipmap, and C14 W5 depends on C13-14. Do not
hide those later dependencies merely because the campaign becomes launchable.
Already-authorized bug-fix and landing slices such as CLT-B3 may close without
launching the full C17 epic.

## 4. Four-slot orchestration and logical lanes

The environment has four concurrent agent slots, including the orchestrator.
The slot topology is:

1. **Orchestrator:** owns the shared tree, full-diff review, serialized machine
   lane, landing, and ledger reconciliation.
2. **Primary implementer:** highest eligible bounded source slice.
3. **Next-card designer/instrumenter:** prepares acceptance or, when disjoint
   and debt is low, implements the second source slice.
4. **Independent reviewer/refuter:** audits the actual diff and evidence and
   never certifies its own implementation.

Implementation workers use orchestrator-created isolated
`.claude/worktrees/*` worktrees. Until a worker has both an isolated worktree
and explicit path ownership, that worker is read-only. No subagent mutates the
shared dirty `main`; only the orchestrator integrates reviewed landing units
there.

The logical queues are:

- **Critical:** C12 + C13-41 + required rulings → C14;
- **Core:** frozen integration → focused C11;
- **Content:** C18 checkpoints → C15-G → C18 V/P/A/S; and
- **Cloud/maintenance:** C13 Gate C/D, with C16 as disjoint fill.

Logical queues do not imply four simultaneous mutations. At most two
source-mutating slices may be active, at most one per collision domain, and one
slot remains independent review. No XL implementation runs as one card; split
it first.

## 5. Machine lane, evidence debt, and first-red law

Only the orchestrator launches Edge/Karma/Playwright. Use one immutable build,
one dev server, and one browser job at a time. Compatible probes may share the
frozen build but never execute concurrently.

### Current frozen-build closure packets

This table is a dispatch summary, not a second ledger. The owning queue wins on
scope, order, and completion.

| Packet | Current evidence boundary | Next machine action |
|---|---|---|
| C11-169 / C11-205 → C11-168 | C11-205 lifecycle, exact-work, API-attribution, and six-pair uninstrumented gates are green. C11-169's corrected four-leg resident-owner diagnostic and shared Tools packet landed in Batch 1032 (`be0683c60d`); it remains diagnostic only. | Do **not** rerun the unchanged attribution route. Implement and review the pre-registered uninstrumented direct-model shown/hidden C11-168 discriminator before any production remediation. |
| C11-13 | Implementation landed Batch 1031; offline policy/static fleet is green. | Run the new outside/inside/outside Edge waypoint probe, outside-byte-identity check, focused Karma lane, and ten-probe voxel preservation battery. |
| C11-90 | Offline demo hardening and the fail-closed visual harness are landed. | Run one corrected both-backend primitive-restart recovery on the frozen build and retain any red without weakening topology or pixel gates. |
| C18-V2 | Readiness/pick lifecycle landed Batch 1028; setup/source identity and promotion hardening landed at `bae6bd0f09`. | Run the voxel, point-cloud, and splat Edge scenes; review/promote clean baselines and execute all non-vacuity mutations. |
| C11-146 | The fail-closed route assessor landed Batch 1027; the rule and metric remain binding on boot/TTFF claims. | Run one moving-altitude route through the assessor and record first-complete-frame firing and lag. |
| C11-134 / C11-132 | Batch 1029's targeted offline lane passed 349/349 with five reasoned skips and zero blocked requests. The full offline engine lane retained the same isolation result but had unrelated suite failures, so it does not close C11-132's engine-green round trip. The online control failed at the external terrain-service boundary. | Retry `--no-offline` only with valid live services/token; separately obtain C11-132's engine-green round trip. |

The current local frozen-build order is C11-13 → C11-90 → C18-V2 → C11-146.
That order does not override a more specific pre-registration or dependency in
an owning queue. C11-134's online leg is excluded until its external environment
is valid.

### Live machine-debt policy

Reconstruct the live `OWED`/ready backlog from every canonical queue before a
machine session, including landed debt and reviewed unlanded packets. Record
the merged order and source/build/probe identities in the resulting evidence;
do not use a board-local packet total, a porcelain count, or literal
`MACHINE_READY` grep as an authorization gate. The superseded 2026-08-11 static
census is historical and must not be carried forward as a live requirement.

At most two new machine-ready units should be created while older executable
debt remains, and no newly created unit should survive more than three later
landings without an explicit queue explanation. This cap governs newly created
debt; it does not discard or silently reorder inherited obligations. Feature
class is only a tie-breaker when no queue, batch, dependency, or pre-registration
already supplies order. Remaining candidates such as C13-41, CLT-B3, C18-P5,
C18-V3 → P1 → P2, C15-G7/G9/G6/G8, and C12/C13/C11 acceptance retain their
own queue contracts.

Green C11-196/202/210 artifacts remain landing evidence, not invitations to
rerun unchanged probes. C12-37 is landed at `6d4a2376fc`; its final PASS artifact
is immutable closure evidence and likewise must not be rerun without an
invalidating change. C11-193A/B/C landed at `b20234a16b`;
its moving causal/recovery continuation remains attribution-gated. C11-209 is
already landed. Blocked or not-yet-instrumented rows do
not become machine-ready merely because they appear on this board.

Every first red is write-once evidence. Preserve its run ID, source and bundle
identity, command, adapter, exit tier, artifact hash, and exact failure set.
Classify it as engine, harness, structural, or external; a harness repair never
erases the original. If the first run is green, record explicitly that no
first-red artifact exists. Never widen a gate after seeing a red without a new
pre-registration or maintainer ruling.

## 6. Bounded-card lifecycle and landing gate

Every card moves through:

`INTAKE → DESIGN_READY → ACCEPTANCE_LOCKED → IMPLEMENTING → REVIEW → MACHINE_READY → LANDING_READY → PARTIAL or COMPLETE`

`BLOCKED` and `HELD` are visible terminal waiting states and consume no WIP.

A bounded card records its base hash, isolated worktree, owned paths, shared
collision keys, and intended landing unit. Global registries,
`scripts/build.js`, campaign ledgers, and shared renderer/model surfaces are
explicit locks, never implicit conventions. The card also owns one canonical
row or named sub-slice, one premise, one primary invariant, one acceptance
packet, one rollback boundary, and one honest remainder. More than roughly
twelve source files, two subsystems, or two working days requires subdivision.

Before landing:

1. reverify the premise against current source and the actual dirty diff;
2. review the entire landing-unit diff and exclude unrelated changes;
3. require independent P0/P1 clearance and mutation-sensitive negative controls;
4. run relevant TypeScript, Prettier, one-file ESLint, Node/Jasmine, naga, C16
   marker, attribution/license, build, and browser gates;
5. update the authoritative queue row, evidence summary, honest remainder,
   deferred/debug entries, and feature inventory where applicable in the same
   landing unit; and
6. obey the global batch sequence, quiet hours, post-hook reruns, clean-tree
   check, and worktree retirement rules.

An item may remain PARTIAL after a successful slice. Green local evidence,
LANDED, and COMPLETE are three different claims.

## 7. Reprioritization and board maintenance

Refresh this board after every landing, new red, blocker/ruling change, or
session boundary. Do not preempt a bounded implementation except for T0; finish
or safely freeze it, record the evidence, then select the new highest eligible
card.

The durable dispatch horizon is:

1. **Campaigns first:** continue the highest-feature-priority eligible card in
   the launched/authorized campaign queues until every such card is complete or
   honestly held/blocked.
2. **Deferred work second:** move to the highest-priority actionable entry in
   [`DEFERRED_WORK.md`](DEFERRED_WORK.md). If that entry already belongs to a
   campaign, reconcile it into the owning queue before implementation; the
   fallback never bypasses canonical authority.
3. **Aurora and space-weather planning third:** after actionable deferred work
   is exhausted, continue the research, architecture, acceptance design, and
   dependency planning in
   [`QUEUE_2026-08-02_CAMPAIGN15.md`](QUEUE_2026-08-02_CAMPAIGN15.md). This
   planning does not waive the C12-completion hold or create implementation
   launch authority for C15-01..08.

Feature class and the scoring law in §1 choose work within each horizon;
campaign number does not.

The next workflow-infrastructure slice is to standardize a compact
`PORTFOLIO FRONTIER` block in each active queue and generate this board from
those blocks. Until that instrument lands, this file is maintained manually and
must cite queue evidence rather than inventing status.

Do not start:

- C11-137 before W2–W8;
- speculative C11 GPU or traversal fixes before attribution;
- C13 W6;
- C14 before C12 closes and launch is recorded;
- C15 Aurora implementation or full C17 before launch;
- C18 Wave S before C15-G8;
- C16-10 while C18 owns overlapping files;
- C16-20 before its prerequisites; or
- a rerun of unchanged green browser evidence.
