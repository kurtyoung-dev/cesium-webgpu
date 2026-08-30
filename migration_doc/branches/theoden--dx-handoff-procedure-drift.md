# Théoden — worker handoff procedure drift lease

- Status: MAIN-MATERIALIZED / CURRENT-HEAD DUAL-RECLOSED / LOCAL DOCUMENTATION LANDING READY / NO CERTIFICATION CLAIM
- Lane identity and tier-2 owner: Théoden
- Sole writer: Éomer
- Base: `a64954b94507fa29762964f3d410517ddd765e9e`
- Branch: `sol/dx-handoff-doc-drift-ba64954b945-2026-08-29`
- Clone: `F:/Dev/GH/cesium-lane-theoden-handoff-doc-20260829`
- Reap when: the documentation correction is frozen, independently reviewed, landed or declined, and its handoff is repatriated; target 2026-09-05.
- Disk budget: 2 GiB.
- Push authority: none; local landing only.

## Declared path set

- `migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md`

The declared path was clean in the main checkout at dispatch and does not overlap another open lease. Éomer may write only this file. The orchestrator owns every Git operation.

## Review history

- The first frozen candidate was 46,987 bytes, SHA-256 `99383D5D7FC59B8527A7CC7F644292742844BD80FA31EC9E0FE80918E83BCC28`, and received `NO-GO`.
- That review found three residual contradictions: operative worker rebase/merge instructions, landing against an unchanged worker-branch diff, and merge/tag steps that could not carry the dirty authored tuple.
- Éomer resumed with the review's exact bounded correction. Editing then stopped at a provisional 47,711-byte tuple, SHA-256 `5759DD7B24EF265F2E61292391C83F9A714B52086DE14400F692EC2B84319D27`; that tuple is superseded and carries no landing approval.
- A final authority correction produced 47,773 bytes, SHA-256 `ED02F2906D1FACA0C79311352DF7A1A2E7FB5CD31F5764D6B7D6560B85BF3F07`, at the unchanged dispatch base. Beregond and Haleth independently terminally rehashed that exact tuple and returned unconditional GO. This frozen clone tuple remains the immutable review chronology and semantic source for destination materialization; it is not the destination's raw-byte tuple.
- The literal reviews are durably banked: `migration_doc/branches/reviews/beregond--handoff-procedure-review.md` is 5,825 bytes with SHA-256 `6B327FB3311191BEF659B103347F51DE289C33E863A79707B143DBC7FB274851`; `migration_doc/branches/reviews/haleth--handoff-procedure-review.md` is 5,917 bytes with SHA-256 `F51E6385EC48A0EE9E2EDCDB350D0A8DB3993413C48DF49413AF85E69DFB33DF`.
- Root materialized the reviewed semantics in main at HEAD `8406dc80f0875881977e0ec61a75a02e6442a55e`. The destination is 47,735 bytes with SHA-256 `4B0B0665CE5BCDE5BE58F2E9BD7C1A83F593123956427F23658D44D693BD5763`, Git-filtered object `6eeae377fab37bf46de0adf98f21509e13068f1c`, and numstat `+40/-23`. The raw-byte difference from the 47,773-byte clone tuple is line-ending materialization only; both produce the same Git-filtered object.
- The initial destination-materialization addenda were durably banked: `migration_doc/branches/reviews/beregond--handoff-procedure-destination-review.md` was 4,720 bytes with SHA-256 `894E8ECA6E676C88F505F356BBE5B531E64AF3091BDA8B31D8A5EFCA27DF3CCE`; `migration_doc/branches/reviews/haleth--handoff-procedure-destination-review.md` was 5,414 bytes with SHA-256 `768A45BCFDA9DFC6B5A99256DEE44D1E2171071386ADDD7C96C09AC8FD20E4FA`.
- Both destination reviewers read the complete main destination and complete HEAD diff, proved semantic/filter identity to the reviewed clone, carried forward closure of all three prior findings, and returned unconditional GO for root-controlled local landing. Root reports that both banked addenda pass Prettier and `git diff --check`. These reviews grant no certification or push authority.
- Main later advanced to HEAD `ba23975e181661f725a6311d9934765662bca86a`, tree `7f8509f41df26a2e30f46b5636dbe8151ce50637`. Beregond and Haleth independently audited the complete two-commit, ten-path advance from `8406dc80f0875881977e0ec61a75a02e6442a55e` and confirmed it is disjoint from all six Théoden packet paths. The candidate, its HEAD base blob, complete `+40/-23` diff, filtered object, clone tuple, and semantic equivalence remain unchanged. The concurrent Batch 1332/1333 work and its recorded process red remain preserved out-of-scope root activity and are not de-scored.
- The refreshed current-HEAD reports are frozen: `migration_doc/branches/reviews/beregond--handoff-procedure-destination-review.md` is 7,529 bytes with SHA-256 `1CF256DB8786A69784B5D5E7D373154ABCAFB80EBA3F7BB499BC2CBA1687C2D3`; `migration_doc/branches/reviews/haleth--handoff-procedure-destination-review.md` is 8,741 bytes with SHA-256 `A334FE0CC7CCED1E57866B4E2FE7E9211283DD8FF4D23D1AC5B76B687C36E916`. Both return unconditional GO limited to root-controlled local documentation landing.
- The current-HEAD re-close is invalidated by a change to the immutable destination bytes, SHA-256, filtered object, numstat, reviewed-clone semantic-source tuple, clone base facts, semantic equivalence, or governing root-only Git facts. Later bookkeeping-only report or Théoden handoff append/hash updates do not invalidate it while those subject facts and the two original source reviews remain unchanged.
- Root's pre-repair `verify-worker-handoff.mjs` run exited 1 because the verifier removed this explicitly leased provisioned path from its authored set. That failure remains preserved historical evidence and is not de-scored.
- The prerequisite verifier repair locally landed as Batch 1331, commit `8406dc80f0875881977e0ec61a75a02e6442a55e`, with post-commit verification PASS. Root validation recorded 8/8 focused tests, 179/179 landing-rule tests, formatting, whitespace, and documentation-integrity gates, plus positive integration against this exact clone and lease at exit 0 `READY_FOR_REVIEW`. `READY_FOR_REVIEW` is mechanical readiness only, not certification.
- The exact main destination remains materialized and dual-reviewed at current HEAD. Root-controlled local documentation landing is ready subject only to final root bookkeeping and staging. Push authority remains none, and no certification or correctness claim is made. The clone remains frozen: do not edit, reset, restore, retire, delete, or reuse it before the local landing receipt and final quiescence are recorded.

## Dispatch constraints

- One deliverable: reconcile the obsolete worker-commit/clean-status handoff text with R-2026-08-18-28 and the live verifier, preserving historical explanation and the root-controlled Git boundary.
- No Git writes, dependency installation, build, browser, server, test that starts a server, or external-state change by workers.
- Documentation-class proof: exact authority reconciliation plus independent review; no invented spec.
- Stop early enough to return a structured handoff even if incomplete.
