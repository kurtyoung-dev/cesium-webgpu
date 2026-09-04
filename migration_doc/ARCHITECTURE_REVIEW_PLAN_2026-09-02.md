# Architecture Review 2026-09-02 — plan

**Why now.** The last fork-wide architecture review is
[`FORK_VS_UPSTREAM_WEBGPU_ARCHITECTURE_AUDIT_2026-07-13.md`](FORK_VS_UPSTREAM_WEBGPU_ARCHITECTURE_AUDIT_2026-07-13.md),
which launched the FAR remediation campaign
([`FORK_ARCHITECTURE_REMEDIATION_PLAN_2026-07-13.md`](FORK_ARCHITECTURE_REMEDIATION_PLAN_2026-07-13.md),
ADR-1..ADR-8, 66 packages, 46 findings). Its JSON ledger's last checkpoint is
2026-07-15 and still reads 25 packages active, 33 planned, 8 experimental; 32 findings
active. Since that audit the engine has taken 1,907 commits touching 1,569 files under
`packages/engine/Source` (+479,820 / −116,207 lines), Campaigns 13–18 launched, and the
WebGPU renderer directory reached 271 files and 216,679 lines with twelve files over 2,900
lines (`WebGPUModelRenderer.ts` 9,284; `WebGPUContext.ts` 7,914;
`WebGPUPrimitiveCommands.ts` 5,769; `WebGPUSceneRenderer.ts` 5,140). The 2026-04-30 audit
trio and the 2026-06-11 ultra review predate all of it. No review has measured the
architecture against the ADRs since they were written.

**Goal.** Find REAL architectural issues and gaps — defects against stated invariants,
debt that blocks planned work, capabilities a planet-scale engine needs and lacks, and
drift between the rules and the code — and, in parallel, learn what the major WebGPU
renderers have done in the last year that this fork should emulate or deliberately not.

**What is not in scope.** Style, comment hygiene (Campaign 16 owns it), and re-filing
what a queue row already tracks with a correct premise.

## Phase 1 — internal review (read-only, launched 2026-09-02 ~16:45 ET)

Eighteen read-only lenses run concurrently, each writing findings with `file:line`,
the invariant or ADR violated, the observable consequence, and whether a queue row
already tracks it:

| Lens | Scope |
| --- | --- |
| 11 subsystem readers | the FEATURE_INVENTORY subsystems: globe & imagery; 3D Tiles; glTF models; geometry primitives; collections; entity/datasource; picking; shadows/lighting; post-process; performance & compute; architecture/build |
| ownership-lifetime | who creates and destroys, device loss, context registry, ADR-3 and the §2.3 invariants |
| frame-graph | how a frame is actually encoded today against ADR-4 (one backend-neutral frame graph) and ADR-5 (semantic render packets) |
| shader-composition | WGSL chunks, the ShaderDefine bit budget, preprocessor, module cache, naga, the cost of two shader languages |
| precision-parity | RTE everywhere, the ellipsoid-aware RTE gap, silent WebGL divergences |
| async-and-readiness | async pipeline creation, the ready gate, readiness definitions, the E-1/E-2 off-main-thread waits, ADR-6 |
| testability-observability | what the engine exposes, what is only provable in a browser, brief-certifying specs, instrument gaps |
| planned-work-fit | which architectural pieces Phase 8b tiling, the meshlet track, C14, C15 and C18 need that do not exist |

Every candidate finding is then judged by three independent verifiers (correctness,
consequence, severity); a finding survives with at least one CONFIRMED and fewer than two
REFUTED votes. A synthesis writes
[`audits/2026-09-02_ARCHITECTURE_REVIEW_PHASE1.md`](audits/2026-09-02_ARCHITECTURE_REVIEW_PHASE1.md):
a register by kind (DEFECT / DEBT / GAP / DRIFT) with severities, per-subsystem evidence,
the healthy parts named, proposed rows for the research dispatch queue, and an appendix of
what did not survive. A completeness critic names the lenses that need a second pass.

**Kinds.** DEFECT: violates a stated rule today. DEBT: works, but blocks or taxes planned
work (which work is named). GAP: a capability a globe engine needs and the fork lacks.
DRIFT: the docs or rules and the code disagree.

## Phase 1b — external landscape audit (launched in parallel)

Seven research agents with web access audit the latest released versions, as of
2026-09-02, of Three.js `WebGPURenderer` + TSL, Babylon.js 8 WebGPU, PlayCanvas 2 WebGPU,
Bevy / wgpu / naga, luma.gl 9 / deck.gl 9, the WebGPU platform itself (spec, browsers,
Dawn, wgpu), and CesiumJS upstream plus neighbouring geospatial engines. Each claim
carries a source URL and a quote; adversarial verifiers fetch every source and drop what
they cannot confirm; fork readers map each verified capability to HAS / PARTIAL / MISSING /
NOT-APPLICABLE with `file:line`; a synthesis writes
[`RENDERER_LANDSCAPE_AUDIT_2026-09-02.md`](RENDERER_LANDSCAPE_AUDIT_2026-09-02.md) with a
ranked gap list (value × effort), what not to copy and why, and a proposed next step per
HIGH item. A critic checks for missing renderers and unsourced claims.

## Phase 2 — reconciliation and rulings

The seat merges the two reports into one register: internal findings, external gaps,
and the FAR ledger's still-open packages, deduplicated against the queues. The maintainer
rules on (a) which ADRs stand, change, or retire after seven weeks of evidence; (b) which
HIGH items become rows now; (c) which measurements must precede any engine change
(the review does not license fixes). Output: a rulings block in
`MAINTAINER_RULINGS_2026-09-*.md` and the rows in
[`QUEUE_2026-08-29_RESEARCH_DISPATCH.md`](QUEUE_2026-08-29_RESEARCH_DISPATCH.md).

## Phase 3 — targeted deep dives (only where phase 1 could not decide)

Opus lanes with the full proof bar, one per unresolved HIGH finding, each producing a
measurement or a design, never a fix, landing through the normal station-3 review.

## Phase 4 — ledger refresh

The FAR remediation ledger's checkpoint moves from 2026-07-15 to the review date with every
package's state re-derived from the code, and `ARCHITECTURE.md` §8 (decomposition state)
and §10 (Phase 8b) are re-measured.

## Rules the review runs under

- Read-only: no reviewer edits engine code; findings are leads until a lane re-derives them.
- Every claim cites `file:line` that the reviewer read; older audits are leads, not premises.
- The review names what is healthy, not only what is wrong.
- Nothing in this review de-scores a measured red or reopens a closed row without evidence.
