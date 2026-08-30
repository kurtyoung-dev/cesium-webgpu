# Active workflow wave — reset-safety snapshot

- Recorded by: root orchestrator
- Recorded at: `2026-08-29T22:25:32-04:00`
- Common dispatch base: `a64954b94507fa29762964f3d410517ddd765e9e`
- Certification claim: none
- Push authority: none; every branch below is local-only.

This snapshot points to live leases and prevents a restart, cleanup, or clone-retirement sweep from treating moving or incompletely banked work as disposable. Each lane file remains the detailed source for its own state. Moving checkpoint hashes are diagnostic only and never substitute for a freeze.

## Live and frozen lanes

| Stable lane | State | Active or last actors | Clone | Reset-safe boundary |
|---|---|---|---|---|
| Tuor | ACTIVE / UNFROZEN | Beren lead; Celebrimbor writer; Idril test authority; Lúthien contract authority | `F:/Dev/GH/cesium-lane-tuor-q152-20260829` | source and spec are moving; structured checkpoint, freeze, review, and quiescence remain owed |
| Maedhros | ACTIVE / UNFROZEN | Maedhros lead; Maglor writer; Caranthir tester; Curufin reviewer | `F:/Dev/GH/cesium-lane-maedhros-child-contract-20260829` | both deliverables were absent at the last root checkpoint; no tuple or review exists |
| Faramir | ACTIVE / UNFROZEN | Faramir lead; Samwise writer; Meriadoc test designer; Aragorn reviewer | `F:/Dev/GH/cesium-lane-faramir-handoff-verifier-20260829` | draft is moving; root validation and frozen review remain owed |
| Théoden | FROZEN / LANDING HELD | Théoden lead; Éomer writer; Beregond and Haleth reviewers | `F:/Dev/GH/cesium-lane-theoden-handoff-doc-20260829` | candidate is 47,773 bytes / SHA-256 `ED02F2906D1FACA0C79311352DF7A1A2E7FB5CD31F5764D6B7D6560B85BF3F07`; literal review artifacts and a repaired verifier run remain owed |

Faramir's first direct spec run wrote only test-owned temporary Git fixtures but violated the worker no-Git-write boundary under a now-withdrawn root dispatch. Its 7/7 result is not bankable. A broader landing-rules run was terminated and is ABORTED. Root confirmed all four disclosed process IDs absent; root alone must rerun the frozen fixture spec.

## Holds and missing durable evidence

- No clone or branch above may be reset, restored, retired, deleted, renamed, reused, or reaped.
- No active lane may enter review until its writer stops, its exact tuple is frozen, and root confirms all lane processes are quiescent.
- No frozen lane may land until required reviewer reports are stored as immutable artifacts and terminal hashes match.
- Tuor remains held on provenance-bound typed results from the variant, Sandcastle, and capture children. Maedhros is only the shared-contract slice; consumer integration and runner wiring remain separate held work.
- Théoden remains held on Faramir's explicit-lease verifier repair and durable Beregond/Haleth report banking.
- Fingolfin, Thingol, Beren's first partial, and Maedhros's earlier scoping reports currently exist only in the session transcript. Do not claim them as tracked evidence or reconstruct them from summaries; literal packet bytes must be recovered or their absence recorded.
- The cache-resident `feedback_tolkien_worker_names.md` registry is missing. Treat all names observed in current leases and packets as used, do not allocate another name, and recover a tracked registry before opening a new lane.
- The designated Edge lane remains closed. No browser, server, build, capture, evidence publication, baseline update, push, or deletion is authorized by this snapshot.

## Root checkout and branches

The main checkout contains pre-existing user work plus Git-clean raw worktree materializations that can overlap a lease even when porcelain is empty. In particular, the Tuor gate/spec and Faramir verifier paths have different raw bytes from their untouched same-base clone counterparts, consistent with but not yet proven to be checkout line-ending conversion. Those root bytes are foreign target input, not worker output. Before transfer or assembly, root must compare the HEAD blob, both worktree byte tuples, line-ending convention, and semantic patch; raw file copying is held. Never assume all root work lies outside the leases, and never clean, restore, reset, stage, or move foreign root bytes as part of workflow landing. Active root-created local branches:

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
