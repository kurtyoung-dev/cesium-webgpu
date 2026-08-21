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
