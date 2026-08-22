# Maintainer rulings — 2026-08-21 (PROVISIONAL BATCH)

**Authority and character.** On 2026-08-21 the maintainer ruled, verbatim in substance:
*"document all of the dirty lanes, then let's go with the recommendations for now. Don't
consider them final judgements but let's give the recommendations an honest shot and see
if they land."* Every ruling below is therefore **PROVISIONAL**: adopted for execution in
good faith, explicitly reversible, and to be re-presented to the maintainer with landing
evidence rather than treated as settled law. Nothing here may be cited later as a final
ruling without this caveat. The dirty-lane documentation the same directive ordered is
[DIRTY_LANES_2026-08-21.md](DIRTY_LANES_2026-08-21.md).

**Reversal path.** Each ruling names what executing it changes; reversing one means
reverting that change and restoring the pre-ruling state recorded in its owning queue.
Executions must not destroy the evidence that would inform a reversal (first-red law
continues to apply).

---

## R-2026-08-21-1 — The eleven 2026-08-18 amendments: adopt each packet recommendation

`DECISION_PACKET_2026-08-18.md`'s eleven undispositioned amendments (R-15, R-19 residual,
R-7, R-13 residual, R-21, R-22, R-3, R-16, R-11, R-23, R-24, R-14, R-17 — as the packet
enumerates them) are each **provisionally ruled as their packet Recommendation section
recommends, as written**. The packet is simultaneously blessed as the durable record for
the four already-ruled dispositions (`R-2026-08-18-26..29`), curing the dangling-ID
hygiene gap (no separate `MAINTAINER_RULINGS_2026-08-18.md` exists; the packet is the
record). Execution order follows the packet's own dependency section. Each executed
disposition lands as its own verified batch naming this ruling.

## R-2026-08-21-2 — Picking §10: the six architecture answers

Per `PICKING_ARCHITECTURE_STATE_2026-08-17.md` §10, provisionally:

1. **FAR-107** — the identity-plateau predicate SATISFIES FAR-107's intent: it keeps
   "identity must match" by proving identity invariance over the reprojection
   uncertainty rather than by pose comparison. FAR-107 is read as satisfied, not amended.
2. **Aperture** — the wide synchronous capture aperture is an **opt-in scene option**;
   the small default stands.
3. **Frame-age cap** — **fixed at 2** for pick identity; `PickDepth`'s 4 is left alone
   until evidence demands alignment.
4. **Prewarm** — the declarative upstream idiom: `contextOptions.prewarmPicking: true`
   plus a ready event; no new public imperative method.
5. **Globe pick parity** — **parity**: mint globe pick IDs on WebGL as well, per the
   fork's parity principle; the S5 gate's divergence encoding becomes temporary.
6. **drillPick** — adopts the predicate (uniform readiness union), retiring the
   `isWebGPU` branch per P-7.

## R-2026-08-21-3 — Weather capture doctrine: adopt

The async immutable-capture doctrine (lane N) is adopted. Cost accepted knowingly:
figures banked from the retired live-canvas reader are not comparable across the change;
every consuming probe owes a fresh machine-lane baseline, tracked at the lane's landing.

## R-2026-08-21-4 — C16-R1: one code-edit lane over all three literal classes

Option (b), widened: a single code-touching lane rewrites marker text inside string and
template literals, rewords the shipped user-facing warning strings, and cleans the
runtime-generated shader-comment emitters — with per-file re-verification by the existing
probes/specs. Mass extraction of embedded WGSL to files (option a) is declined for now
because two of the three classes are unreachable by it.

## R-2026-08-21-5 — Dev-server artifact policy

Certification and acceptance probe runs attest the **gulp bundle** (`--serve-built` /
`--production` serving `Build/CesiumUnminified`); iteration and debugging runs may use the
development build. Closes `NEW-DEVSERVER-SERVES-DEV-BUILD-NOT-GULP-ARTIFACT`
provisionally. The T0 frozen-build program of 2026-08-21 already runs under this policy.

## R-2026-08-21-6 — Dual-light atmosphere default (pre-ruling)

When the sky inscatter LUT path (or the `dualLightInline` opt-in) is re-enabled, the
dual-light contribution defaults to **parity-OFF with the toggle kept**, unless a
separate ratification then says otherwise. The landed celestial-gate class audit's
tripwire reds are the enforcement; this pre-ruling exists so that red never stalls a
session. No engine change now — the term is dormant.

## R-2026-08-21-7 — Branch cleanup

The five empty `sol/*` dispatch branches and the two landed `worktree-agent-*` branches
(and their worktrees) are deleted. All work they carried is landed on `main` or banked in
verified bundles.

---

*Executions in flight at ruling time: T0 frozen-build acceptance program (C11-13 green
through its physical probe and focused Karma; battery running), five Sol packages
(C16 shard, Karma launcher, capture harness, marker grammar, voxel spec anchors).*

## Evening rulings — 2026-08-21 (the RULING_REQUESTS_2026-08-21.md packet, items 1-12)

Ruled by the maintainer in session on 2026-08-21 evening; each item below names its
packet number. These are operative, not provisional, unless stated.

## R-2026-08-21-13 — G3 celestial gate: the 4096 bake + HDR check session (packet item 1)

Schedule the manual maintainer session: bake and bundle the 4096 cube faces and run the
HDR-hardware check in one sitting, discharging G3, the C12-12 tier item and C12-28 together.
The ratified >= 2700 px bar stands; no de-scoring.

## R-2026-08-21-14 — G1 sky-atmosphere shell extent (packet item 2)

Conditional: C12 may close with G1 red ONLY if a future campaign carries a concrete plan to
fix `NEW-WEBGPU-SKYATMOSPHERE-SHELL-EXTENT-ALPHA`; absent such a plan the defect escalates to
the next fix rather than being carried. Disposition of the condition: SATISFIED - Campaign 17 (proposed) carries `CLT-D10`, the shell-extent decision, as a named item of its packet; the maintainer ruled that proposed-C17 with CLT-D10 counts. C12 therefore closes with G1 explicitly red, carried to C17 as CLT-D10; the red stays visible in the C12 queue and the C17 packet.

## R-2026-08-21-15 — C12-33 moon-mip: run both designs (packet item 3)

`sign-test-v1` (four-cell sign test, 1e-9 gate, custody-hashed) is blessed as the design of
record NOW and its scripted 2.5-hour Edge ten-run set runs in the machine lane. The
sixteen-cell ratio design is ALSO ordered as a later build, to be run once a correlation `r`
is pre-registered by the maintainer before that build is dispatched (never supplied post hoc);
it gets its own designId and custody hash.

## R-2026-08-21-16 — C12 exit-gate membership (packet item 4)

All four OUT of the C12 exit gate, tracked where they live: `C11-79` stays in C11; `C12-26`
(earth-limb airglow) defers to C17; `C12-31-FOLLOWUP-A/B/C` are filed follow-ups while the
C12-31 acceptance sweep itself stays IN; `C12-11` closes out of the gate on the shipped
starfield with the rebuilt harness (Batch 1109) as the instrument of record for a post-C12
certification, its HELD state kept visibly recorded.

## R-2026-08-21-17 — C15-G9 escalation disposition (packet item 5)

The `R-2026-08-10-7` escalation is acknowledged; the disposition is to RUN the D1-D5
discriminator harness (landed Batch 1122) in the machine lane. No design decision precedes
the measurement; the 0.050% bar stays mutant-pinned.

## R-2026-08-21-18 — C16-20 gains an empty-grandfather clause (packet item 6)

The C16 exit gate requires the grandfather ledger to be EMPTY: census = 0 with nothing
parked. The ledger remains shrink-only and retires rows as their files' shards land.

## R-2026-08-21-19 — C16-02c is IN Campaign 16 as a late shard (packet item 7)

The build-ts `.d.ts` surface joins the C16 standard as a late shard after the remaining
rewrite shards; declaration files are consumer-facing documentation.

## R-2026-08-21-20 — U2 morphology stays ON (packet item 8)

Re-affirmed: the landed U2 morphology stays enabled with its measured cost disclosed and
`C13-39B` as the named containment; the fork's performance principle (never default-disable
a feature to win a metric) governs.

## R-2026-08-21-21 — the provisional amendment batch stays provisional (packet item 9)

The eleven R-2026-08-21 amendments remain provisional until the picking programme (B1-B5)
has run under them; they are then ratified in one pass with that evidence.

## R-2026-08-21-22 — 3D Tiles extension decisions batched (packet item 10)

Decision 23 (`3DTiles_temporal` vocabulary), the reframed title/abstract, and wave B scoping
are taken together in one sitting when the fork campaigns are quieter.

## R-2026-08-21-23 — license baseline is Apache-2.0 (packet item 11)

Confirmed: the fork's operative license baseline is Apache-2.0 (inherited from upstream
CesiumJS; `LICENSE.md`, the engine LICENSE and `package.json` agree). Every "MIT repo"
statement in plans and queue rows is to be corrected; intake of MIT/BSD/ISC/PD/CC-BY sources
is license-compatible with NOTICE-file attribution under Apache-2.0 section 4(d); copyleft and
NC/SA sources remain disqualified. `LICENSE_VETTING_AURORA_OCEAN_2026-08-21.md` gets its
softening pass against this baseline (with the review's deferred quality edits) before any
C14/C15 intake.

## R-2026-08-21-24 — SOL-4: bank the honest record AND re-instrument (packet item 12)

Both: (a) the runs of 2026-08-21 are banked as the SOL-4 artifact of record - WebGL 3.342 and
2.714 ms per refresh, WebGPU unmeasurable by wall clock at this fixture's frame cost with the
negative-differential record retained - which satisfies the R-2026-08-14-1 prerequisite on
honest evidence; and (b) the refresh-cost lane is re-instrumented on GPU timestamp queries
(the repository's `gpuPassCost` path) under the same pre-registered sweep and
both-backends-valid rule, as the durable instrument. Until (b) runs, the WebGPU cost is a
bound in the ledger, not a figure.
