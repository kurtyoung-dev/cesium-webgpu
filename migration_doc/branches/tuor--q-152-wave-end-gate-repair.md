# Tuor — Q-152 wave-end gate repair lease

- Status: ACTIVE / UNFROZEN
- Lane identity: Tuor — unchanged for dispatch, review, landing, and retirement.
- Tier-2 owner: Beren
- Active writer: Celebrimbor
- Live agent path: `/root/beren_q152_implementation_lead/celebrimbor_q152_incremental_writer`
- Prior writer: Tuor — `PARTIAL`, no authored bytes; the bounded incremental resume changes personnel, not the lane identity.
- Base: `a64954b94507fa29762964f3d410517ddd765e9e`
- Branch: `sol/q-152-wave-end-gate-repair-ba64954b945-2026-08-29`
- Clone: `F:/Dev/GH/cesium-lane-tuor-q152-20260829`
- Reap when: the repair is independently reviewed, landed or declined, and all evidence and handoffs have been repatriated; target 2026-09-05.
- Disk budget: 2 GiB.

## Declared path set

- `Tools/wave-end-gate.mjs`
- `Tools/wave-end-gate.spec.mjs`

The declared set was clean in the main checkout at dispatch and does not overlap another open lease. Celebrimbor may write only these two paths. The orchestrator owns every Git operation, including branch creation, commits, landing, and retirement.

At this snapshot, before the root bookkeeping commit, the worker branch ref and main ref were both at the dispatch base while the clone carried moving, unreviewed working-tree bytes. The bookkeeping commit may advance main without touching either leased path; every later assembly must audit the then-current main tip separately. Main's two leased paths are Git-clean but their raw checkout bytes differ from the untouched same-base clone, so they are foreign target material rather than worker output: gate 20,192 bytes / SHA-256 `505D68F9826047E0FB3F492FDA6B4054979A7EFDE1676577635C37DDAC00895F`; spec 5,045 bytes / SHA-256 `09CFD0A12826872BB0BB4B63E2B05BD1B7462F9B6A56267E5CA4DABC4FFC2E41`. Treat the difference as an unresolved checkout/line-ending collision until root proves its cause and target convention. No raw clone-file copy, transfer, assembly, or landing is allowed before that audit. No current clone tuple is frozen or approved for transfer. The parent-gate candidate is also held for assembly with provenance-bound typed child results; the separate Maedhros contract lane does not yet release that hold.

## Resume record

- Tuor's single full-file patch transport failed before process creation with Windows error 206; the clone remained unchanged and no validation ran.
- Unchanged clone tuple at that handoff: `Tools/wave-end-gate.mjs` — 21,021 bytes, SHA-256 `F00844A01862B191875FAE0BCF7C838488B310597A4AD99FA9CF96138C8C41BC`; `Tools/wave-end-gate.spec.mjs` — 5,213 bytes, SHA-256 `47FC378BB6C8CBD6A7D77E065DDF3AA5669F98670645AEB66744A4A4CE6AB8D0`.
- Beren resumed the same lease with Celebrimbor as sole writer using bounded incremental patch-engine calls. The lease paths, base, branch, clone, and prohibitions are unchanged.
- Current work is mid-migration. The last root observation is a diagnostic checkpoint only, not a freeze: gate 45,588 bytes, SHA-256 `E7403DC25170ED440AFCE10185BC4EF2B1D1C4851A7A43576756E6BC70EBEDAF`; spec still 5,213 bytes, SHA-256 `47FC378BB6C8CBD6A7D77E065DDF3AA5669F98670645AEB66744A4A4CE6AB8D0`.
- Do not dispatch review, reset, restore, retire, delete, or reuse this clone until Beren records a structured checkpoint or freeze and root verifies all lane agents and processes are quiescent.

## Dispatch constraints

- One deliverable: repair the Q-152 gate and its behavioral spec from current source and canonical verdict contracts.
- No Git writes, dependency installation, build, browser, server, or external-state changes by workers.
- Stop early enough to return a structured handoff even if incomplete.
- A completed implementation is frozen before independent review; any later byte change invalidates that review.
