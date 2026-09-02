# Active workflow wave — reset-safety snapshot

- Recorded by: root orchestrator
- Recorded at: `2026-08-29T22:25:32-04:00`
- Tuor-only superseding update: `2026-08-30T01:03:42-04:00`; every other lane remains at the original snapshot time.
- Common dispatch base: `a64954b94507fa29762964f3d410517ddd765e9e`
- Certification claim: none
- Push authority: none; every branch below is local-only.

This snapshot points to live leases and prevents a restart, cleanup, or clone-retirement sweep from treating moving or incompletely banked work as disposable. Each lane file remains the detailed source for its own state. Moving checkpoint hashes are diagnostic only and never substitute for a freeze.

## Live and frozen lanes

| Stable lane | State | Active or last actors | Clone | Reset-safe boundary |
|---|---|---|---|---|
| Tuor | LOCAL FAIL-CLOSED SAFETY LANDED / PROCESS VIOLATION RECORDED / NOT CERTIFIED / Q-152 OPEN | Beren lead; Celebrimbor writer; Idril test authority; Turgon and Nimrodel reviewers | `F:/Dev/GH/cesium-lane-tuor-q152-20260829` | Batch 1332 `1dc3f9c360d3d020380cb63fbf7029dc76202b43`; exact main tuple and landing record are in `tuor--q-152-wave-end-gate-repair.md#local-fail-closed-safety-landing-stamp`; required result remains STRUCTURAL / exit 3 / zero spawns; no wave-end receipt; missing-trailer process red retained; clone and branch remain protected pending tracked disposition and root quiescence |
| Maedhros | ACTIVE / UNFROZEN | Maedhros lead; Maglor writer; Caranthir tester; Curufin reviewer | `F:/Dev/GH/cesium-lane-maedhros-child-contract-20260829` | both deliverables were absent at the last root checkpoint; no tuple or review exists |
| Faramir | ACTIVE / UNFROZEN | Faramir lead; Samwise writer; Meriadoc test designer; Aragorn reviewer | `F:/Dev/GH/cesium-lane-faramir-handoff-verifier-20260829` | draft is moving; root validation and frozen review remain owed |
| Théoden | FROZEN / LANDING HELD | Théoden lead; Éomer writer; Beregond and Haleth reviewers | `F:/Dev/GH/cesium-lane-theoden-handoff-doc-20260829` | candidate is 47,773 bytes / SHA-256 `ED02F2906D1FACA0C79311352DF7A1A2E7FB5CD31F5764D6B7D6560B85BF3F07`; literal review artifacts and a repaired verifier run remain owed |

Faramir's first direct spec run wrote only test-owned temporary Git fixtures but violated the worker no-Git-write boundary under a now-withdrawn root dispatch. Its 7/7 result is not bankable. A broader landing-rules run was terminated and is ABORTED. Root confirmed all four disclosed process IDs absent; root alone must rerun the frozen fixture spec.

## Holds and missing durable evidence

- No clone or branch above may be reset, restored, retired, deleted, renamed, reused, or reaped.
- No active lane may enter review until its writer stops, its exact tuple is frozen, and root confirms all lane processes are quiescent.
- No frozen lane may land until required reviewer reports are stored as immutable artifacts and terminal hashes match.
- Tuor's fail-closed source safety repair is locally landed, but Q-152 and Wave 1 remain held on source provenance, typed current-run children, complete served-subject binding, descendant quiescence, capture/baseline approval, immutable receipt lifecycle, operational runbook repair, and a real gate/evidence run. No wave-end receipt exists, and Batch 1332's missing-trailer process red remains immutable.
- Maedhros is only the shared-contract slice; consumer integration and runner wiring remain separate held work.
- Théoden remains held on Faramir's explicit-lease verifier repair and durable Beregond/Haleth report banking.
- Fingolfin, Thingol, Beren's first partial, and Maedhros's earlier scoping reports currently exist only in the session transcript. Do not claim them as tracked evidence or reconstruct them from summaries; literal packet bytes must be recovered or their absence recorded.
- The cache-resident `feedback_tolkien_worker_names.md` registry is missing. Treat all names observed in current leases and packets as used, do not allocate another name, and recover a tracked registry before opening a new lane.
- The designated Edge lane remains closed. No browser, server, build, capture, evidence publication, baseline update, push, or deletion is authorized by this snapshot.

## Root checkout and branches

The main checkout contains pre-existing user work plus Git-clean raw worktree materializations that can overlap a lease even when porcelain is empty. For Tuor, the collision and line-ending hold was discharged only for the exact post-assembly main tuple recorded in its handoff; that record grants no authority to copy, reset, retire, delete, or reuse any other bytes or clone. The Faramir boundary in this paragraph remains the original snapshot and is not refreshed by the Tuor-only update. Never assume all root work lies outside the leases, and never clean, restore, reset, stage, or move foreign root bytes as part of workflow landing. Active root-created local branches:

- `sol/q-152-wave-end-gate-repair-ba64954b945-2026-08-29`
- `sol/q152-child-result-contract-ba64954b945-2026-08-29`
- `sol/verify-handoff-explicit-lease-ba64954b945-2026-08-29`
- `sol/dx-handoff-doc-drift-ba64954b945-2026-08-29`

Three pre-existing detached evidence/certification worktrees also remain untouched: `cesium-webgpu-cert-s5-3cbb82885fc7`, `cesium-webgpu-evidence`, and `cesium-webgpu-evidence-v9`.

## Restart protocol

1. Read `AGENTS.md`, the campaign-lane skill, current rulings, charter, isolation procedure, and `CODEX_HANDOFF_2026-08-29.md`.
2. Read this snapshot and every sibling lane file.
3. Inspect each clone's `HEAD`, verbatim porcelain, leased paths, byte counts, and SHA-256 without changing it.
4. Reconcile live agent/process state before trusting a moving checkpoint or declaring quiescence.
5. Resume the existing stable lane identity; do not invent a replacement name, clone, or branch.
6. Preserve every measured red, partial, aborted run, and review hold. Only root performs Git writes or fixture tests that perform Git writes.
