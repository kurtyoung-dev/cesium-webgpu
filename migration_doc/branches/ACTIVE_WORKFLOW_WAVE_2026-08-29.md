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

## Root checkout, branches and worktrees

Refreshed 2026-09-02 from the DX-19 salvage audit
(`branches/DX19_BRANCH_WORKTREE_SALVAGE_AUDIT_2026-09-02.md`, ruling R-2026-09-02-21) against
`main` = `59c1e4f1d5`. This block supersedes the four-branch list and the one-line worktree
sentence recorded on 2026-08-29, and it supersedes Appendix A of `CODEX_HANDOFF_2026-09-01.md`,
three of whose rows quote main-lineage equivalents rather than the real branch tips. `refs.txt` in
`cesium-webgpu-worker-archive/pre-reconstruct-backup-2026-09-01/` is the accurate frozen record.

The main checkout still contains pre-existing user work plus Git-clean raw worktree
materializations that can overlap a lease even when porcelain is empty. Never clean, restore,
reset, stage, or move foreign root bytes as part of workflow landing.

### The nine local heads besides `main`

Every unique commit on these refs is banked in
`cesium-webgpu-worker-archive/pre-reconstruct-backup-2026-09-01/local-history.bundle` (verified OK;
it requires `a64954b945`, which is on `origin/main`). Every lane branch is additionally duplicated
in a standalone clone with its own object database, so retiring a ref here does not reach any lane.

| Head | Tip | Unique vs main | DX-19 disposition |
|---|---|---|---|
| `sol/dx-handoff-doc-drift-ba64954b945-2026-08-29` | `a64954b945` | none | RETIRE NOW |
| `sol/q-152-wave-end-gate-repair-ba64954b945-2026-08-29` | `a64954b945` | none (landed as Batch 1332) | RETIRE NOW |
| `sol/q152-child-result-contract-ba64954b945-2026-08-29` | `a64954b945` | none | RETIRE NOW |
| `sol/verify-handoff-explicit-lease-ba64954b945-2026-08-29` | `a64954b945` | none | RETIRE NOW |
| `sol/q152-h1-variant-consumer-b806fc36ca4-2026-08-30` | `806fc36ca4` | none (≡ Batches 1330–1335) | RETIRE NOW |
| `sol/q152-aggregate-receipt-233fa5be340-2026-08-30` | `233fa5be34` | none (≡ Batches 1330–1336) | RETIRE NOW |
| `sol/session-gc-boundary-b1ce-2026-08-30` | `b1ce382375` | none (tree ≡ main's Batch 1339 `b429c5b518`) | RETIRE with its worktree |
| `sol/q12-prettier-reachability-233fa-2026-08-30` | `d37b1f3cb6` | Batch 1337, one `.prettierignore` line — DROPPED by R-2026-09-02-11 | RETIRE NOW |
| `sol/q152-landing-receipt-233fa-2026-08-30` | `f0121cfd8d` | Thorin's "Batch 1339", 5,396 insertions — PARKED | RETIRE NOW (patch banked, byte-verified) |

### The six non-`main` worktrees

| Worktree | HEAD | Unique material | DX-19 disposition |
|---|---|---|---|
| `cesium-lane-elrond-session-gc-20260830` | `b1ce382375` | none — its 2 modified + 2 untracked paths are byte-identical to `worker-archive/codex-session-gc-2026-09-01/` | RETIRE after re-confirming the four hashes |
| `cesium-lane-gandalf-q12-prettier-20260830` | `d37b1f3cb6`, clean | none | RETIRE NOW |
| `cesium-lane-thorin-q152-receipt-20260830` | `f0121cfd8d`, clean | none | RETIRE NOW |
| `cesium-webgpu-cert-s5-3cbb82885fc7` | `034c7f74d0` detached, ancestor of main, clean | none — its 50 files / 95 MB already sit in main's `Tools/visual-regression/output/cert-s5-runs/` (50/50 SHA-256) | RETIRE NOW |
| `cesium-webgpu-evidence` | `f38acf65f6` detached, ancestor of main | 48 probe artefacts (3.25 MB) + a 177 KB uncommitted diff | RETIRE AFTER BANKING (audit §5.1, §5.2) |
| `cesium-webgpu-evidence-v9` | `99abefdc26` detached, ancestor of main | a 40 KB uncommitted diff only; its 24 output files are all in the immutable archive | RETIRE AFTER BANKING (audit §5.3) |

Retiring all six reclaims ~6.1 GB.

### Standing holds this refresh does NOT lift

- The lane table above (Tuor, Maedhros, Faramir, Théoden) and its "Holds and missing durable
  evidence" section stand unchanged. A head being an empty pointer says nothing about its lane's
  review, landing, or certification state.
- No clone may be reset, retired, or deleted under this block. The 22 sibling repositories are
  DX-20 (R-2026-09-02-22, census `branches/DX20_SIBLING_REPOSITORY_CENSUS_2026-09-02.md`);
  `cesium-worker-g6frame` is banked before anything else happens to it and `cesium-lane-sundisc2`
  stays frozen. In particular, retiring the Turgon and Tuor **heads** is safe, but their **clones**
  hold unbanked work (the aggregate-run receipt; a 268-line wave-end-gate residual) and must be
  drained under DX-20 first.
- `cesium-webgpu-worker-archive/pre-reconstruct-backup-2026-09-01/` is NO-DELETE. It is now the only
  durable custody of the pre-reconstruction main tip `dda8569016`, which is unreferenced (the
  `safety-pre-reconstruct-2026-09-01` tag is gone) and survives otherwise only in `main`'s reflog.
- The designated Edge lane, browser, server, build, capture, publication, baseline-update and push
  authorities are unchanged by this refresh.

## Restart protocol

1. Read `AGENTS.md`, the campaign-lane skill, current rulings, charter, isolation procedure, and `CODEX_HANDOFF_2026-08-29.md`.
2. Read this snapshot and every sibling lane file.
3. Inspect each clone's `HEAD`, verbatim porcelain, leased paths, byte counts, and SHA-256 without changing it.
4. Reconcile live agent/process state before trusting a moving checkpoint or declaring quiescence.
5. Resume the existing stable lane identity; do not invent a replacement name, clone, or branch.
6. Preserve every measured red, partial, aborted run, and review hold. Only root performs Git writes or fixture tests that perform Git writes.
