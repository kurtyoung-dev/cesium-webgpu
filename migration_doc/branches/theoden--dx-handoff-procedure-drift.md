# Théoden — worker handoff procedure drift lease

- Status: FROZEN / LANDING HELD
- Lane identity and tier-2 owner: Théoden
- Sole writer: Éomer
- Base: `a64954b94507fa29762964f3d410517ddd765e9e`
- Branch: `sol/dx-handoff-doc-drift-ba64954b945-2026-08-29`
- Clone: `F:/Dev/GH/cesium-lane-theoden-handoff-doc-20260829`
- Reap when: the documentation correction is frozen, independently reviewed, landed or declined, and its handoff is repatriated; target 2026-09-05.
- Disk budget: 2 GiB.

## Declared path set

- `migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md`

The declared path was clean in the main checkout at dispatch and does not overlap another open lease. Éomer may write only this file. The orchestrator owns every Git operation.

## Review history

- The first frozen candidate was 46,987 bytes, SHA-256 `99383D5D7FC59B8527A7CC7F644292742844BD80FA31EC9E0FE80918E83BCC28`, and received `NO-GO`.
- That review found three residual contradictions: operative worker rebase/merge instructions, landing against an unchanged worker-branch diff, and merge/tag steps that could not carry the dirty authored tuple.
- Éomer resumed with the review's exact bounded correction. Editing then stopped at a provisional 47,711-byte tuple, SHA-256 `5759DD7B24EF265F2E61292391C83F9A714B52086DE14400F692EC2B84319D27`; independent exact-tuple review remains required before landing.
- A final authority correction produced 47,773 bytes, SHA-256 `ED02F2906D1FACA0C79311352DF7A1A2E7FB5CD31F5764D6B7D6560B85BF3F07`. Beregond and Haleth independently rehashed and accepted that exact tuple.
- Root's subsequent `verify-worker-handoff.mjs` run exited 1 because the verifier unconditionally removes this explicitly leased provisioned path from its authored set. Landing is held on the separate Faramir verifier-repair lane; the reviewed document bytes remain frozen.
- The Beregond and Haleth review reports currently exist only in the active session transcript. Their literal report bytes, file hashes, terminal rehash statements, and quiescence evidence have not yet been banked as tracked artifacts, so this record does not claim reset-safe review provenance.
- Do not edit, reset, restore, retire, delete, or reuse this clone. Landing requires the Faramir verifier repair, durable review-report banking, a terminal tuple rehash, and root confirmation that Théoden, Éomer, Beregond, and Haleth have no live children or processes.

## Dispatch constraints

- One deliverable: reconcile the obsolete worker-commit/clean-status handoff text with R-2026-08-18-28 and the live verifier, preserving historical explanation and the root-controlled Git boundary.
- No Git writes, dependency installation, build, browser, server, test that starts a server, or external-state change by workers.
- Documentation-class proof: exact authority reconciliation plus independent review; no invented spec.
- Stop early enough to return a structured handoff even if incomplete.
