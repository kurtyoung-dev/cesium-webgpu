# DX-20 — sibling-repository census (2026-09-02)

**Author:** Nienor (Tier-3 worker, Sonnet), read-only throughout — no git writes, no build, no
browser, no delete/move anywhere.
**Ruling:** R-2026-09-02-22 (`MAINTAINER_RULINGS_2026-09-02.md`).
**Subjects:** the 22 standalone sibling repositories in Appendix A.4 of
`CODEX_HANDOFF_2026-09-01.md`, plus the standalone landing repository
`cesium-webgpu-landing-sol-20260826`. All paths below are `F:/Dev/GH/<name>` unless stated
otherwise.
**Main tip at census time:** `59c1e4f1d5018fde22b3fc667b885d64c81d5561` (Batch 1361), 2026-09-02
~02:05 EDT.
**Method note (content, not ancestry):** main was reconstructed 2026-09-01, so branch-commit
ancestry is not meaningful. Every "already in main" claim below is a direct content diff —
`diff --strip-trailing-cr <(git -C cesium-webgpu show HEAD:<path>) <clone-path>` — never
`git merge-base`/`log --oneline` reachability. Plain `diff`/`git diff` without `--strip-trailing-cr`
inflates line counts on these Windows clones (CRLF checkout vs LF blobs can turn a 0-line real
diff into a whole-file replacement); every number in this census is the CR-normalized figure
unless marked "raw".

## 0. Standing facts verified

- **`cesium-lane-sundisc2` is FROZEN and is never retired.** Confirmed alive, real uncommitted
  solar-disc content (below). No retirement path proposed for it in this census — KEEP, no
  exceptions.
- **`cesium-worker-g6frame` carries ~2,396 uncommitted lines.** Confirmed exactly:
  `git diff --stat` = `2 files changed, 2396 insertions(+), 66 deletions(-)`
  (`Tools/visual-regression/gsplat-campaign15-instruments.spec.mjs` +1686,
  `Tools/visual-regression/probe-gsplat-multifrustum.mjs` +776/−66). Nothing in
  `cesium-webgpu-worker-archive/` or main currently holds this diff — it must bank first, before
  any other retirement in this batch.
- **Q-152 family bank at `cesium-webgpu-worker-archive/q152-side-lanes-2026-09-01/`** — checked
  directly, README + hash-verified:
  - `h0-pure/` (2 files) = byte-identical (SHA-256 match) to `cesium-lane-maedhros-child-contract-20260829`'s two dirty files. Fully banked.
  - `h1/` (5 files) = byte-identical (SHA-256 match) to `cesium-lane-maedhros-q152-h1-20260830`'s five H1 files. Fully banked.
  - `thorin-receipt/` is Batch 1339 from the **separate worktree** `cesium-lane-thorin-q152-receipt-20260830` (not a sibling repo in this census's subject list — it is one of the seven worktrees in CODEX_HANDOFF Appendix A.1). It is **not** `cesium-lane-turgon-q152-receipt-20260830`'s content — the names are easy to confuse but the two are different clones with different work. Turgon's own `aggregate-run-receipt` work is confirmed **absent** from this bank (see Turgon's row) — the parenthetical in the task brief that "turgon...is already banked" is only **half** right: two of the five named clones (maedhros x2) are banked; **beren and tuor are effectively banked by content-identity to main** (see their rows); **turgon is not banked anywhere**.
- **Treebeard and Quickbeam evidence repatriation** — checked directly:
  - `Tools/visual-regression/output/lane-treebeard-2026-08-29/` holds 6 files, byte-for-byte the
    same 6 as `cesium-lane-treebeard/_lane-out/` (RESEARCH doc, REVIEW doc, 4 perf JSONs). Confirmed.
  - `Tools/visual-regression/output/lane-quickbeam-2026-08-29/` holds all 67 files (8.1 MB),
    including `REVIEW_EARTH_AT_NIGHT_CELEBORN.md` — confirmed byte-identical in size and name to
    `cesium-lane-quickbeam/_lane-out/`. Confirmed.
  - **Not covered by that repatriation:** both clones also carry `_research-scratch-<name>/` and
    `_review-scratch-<name>/` directories (raw probes, upstream-diff scratch, logs) that are
    smaller, separate from `_lane-out/`, and were never repatriated. These still need a banking
    decision (see rows below).

## 1. Summary table

| # | Repository | Lane served | Porcelain count | Last commit | Content already in main/archive? | Disk | Classification |
|---|---|---|---|---|---|---|---|
| 1 | `cesium-audit-docs` | Governance/claim audit (Batch 1169 base) | 41 | `aa9409432d` (B1169) | Common wave banked (2026-08-27); doc edits mostly 0-diff; `_claim_audit/` unbanked | 269M | RETIRE AFTER BANKING |
| 2 | `cesium-audit-fleet` | Renderer divergence audit ("fleet2" finding) | 13 | `aa9409432d` (B1169) | 5/9 touched engine files 0-diff; 4 differ substantially; 4 new specs unbanked | 264M | RETIRE AFTER BANKING |
| 3 | `cesium-audit-model` | Lane A1 — `M-1`…`M-8` model-wave repair | 39 | `aa9409432d` (B1169) | Common wave banked; `ModelPrimitiveGeometry.js` 0-diff; `audit-out/` + `package.json` delta unbanked | 266M | RETIRE AFTER BANKING |
| 4 | `cesium-audit-policy` | Lane B3 — `O-8`/`O-9` grammar rules | 35 | `aa9409432d` (B1169) | 100% subset of the banked 2026-08-27 common wave; zero unique delta | 266M | RETIRE NOW |
| 5 | `cesium-audit-probe` | Fleet-audit worker (unclear specific row) | 36 | `aa9409432d` (B1169) | Common wave banked; sole delta `.sol-audit-report.md` is explicitly disposable | 266M | RETIRE AFTER BANKING (discard, no bank needed) |
| 6 | `cesium-audit-proto` | Lane D1 — patch-extension R9 (canonical home) | 39 | `aa9409432d` (B1169) | ACTIVE — "R9 GO...implementation phase UNLOCKED...next work window" | 314M | **KEEP** |
| 7 | `cesium-lane-beren-q152-mutant-eol-20260830` | Q-152 wave-end mutant EOL repair | 5 | `806fc36ca4` (B1335) | Spec + both docs are 0-diff vs main (Batch 1336 landed) | 1.6G | RETIRE NOW |
| 8 | `cesium-lane-celebrimbor-rust-supervisor-20260830` | Rust supervisor coordination (interrupted) | 2 | `233fa5be34` (B1336) | No unique content; both "modified" files are pure CRLF noise (0-diff) | 1.6G | RETIRE NOW |
| 9 | `cesium-lane-faramir-handoff-verifier-20260829` | Worker-handoff verifier lane | 3 | `a64954b945` (B1329) | `verify-worker-handoff.mjs` 0-diff; spec already in main; `package.json` delta is stale/reverse | 1.6G | RETIRE NOW |
| 10 | `cesium-lane-fredegar` | Wave-1 research dispatch (EAN-01 etc.) | 1 | `2fc55daf56` (B1301) | Only dirty file is CRLF noise; evidence already repatriated per own commit message | 1.6G | RETIRE NOW |
| 11 | `cesium-lane-frodo` | DM-01 / Q-91 review-and-fix lane | 2 | `e4fdfb6f28` (B1318) | `_lane-out/Q91_REVIEW_PASS1.md` + `_review-scratch-erestor/` mutant fixtures unbanked | 1.6G | RETIRE AFTER BANKING |
| 12 | `cesium-lane-maedhros-child-contract-20260829` | Q-152 H0 pure child-result contract | 2 | `a64954b945` (B1329) | 100% SHA-256 match to `q152-side-lanes-2026-09-01/h0-pure/` | 1.6G | RETIRE NOW |
| 13 | `cesium-lane-maedhros-q152-h1-20260830` | Q-152 H1 variant-consumer | 9 | `806fc36ca4` (B1335) | 100% SHA-256 match to `.../h1/`; remaining deltas (spec/docs) 0-diff, `package.json` 8-line stale drift | 1.6G | RETIRE NOW |
| 14 | `cesium-lane-quickbeam` | Earth-at-Night audit + Celeborn review | 4 | `3abe28cdf1` (B1295) | `_lane-out/` (8.1M) fully repatriated; `_research-scratch-quickbeam/` (277K) + `_review-scratch-celeborn/` (4.9M) unbanked | 1.7G | RETIRE AFTER BANKING |
| 15 | `cesium-lane-sundisc2` | C12-38 sun-disc/dawn probe work | 11 | `41aad98761` (B1172) | FROZEN — maintainer-held; real uncommitted engine diff, never retire | 264M | **KEEP (FROZEN)** |
| 16 | `cesium-lane-theoden-handoff-doc-20260829` | DX handoff-doc drift repair | 1 | `a64954b945` (B1329) | Real 63-line diff on `WORKER_ISOLATION_AND_BRANCH_HANDOFF.md`, but confirmed content-identical to main's current text (already landed) | 1.6G | RETIRE NOW |
| 17 | `cesium-lane-treebeard` | Design-model perf research + Cirdan review | 4 | `ef27363f6b` (B1294) | `_lane-out/` (552K) fully repatriated; `_research-scratch-treebeard/` (53K) + `_review-scratch-cirdan/` (8K) unbanked | 1.6G | RETIRE AFTER BANKING |
| 18 | `cesium-lane-tuor-q152-20260829` | Q-152 fail-closed wave-end-gate safety | 2 | `a64954b945` (B1329) | `wave-end-gate.mjs`/`.spec.mjs` carry real 121+147-line CR-normalized deltas vs main — not fully landed | 1.6G | RETIRE AFTER BANKING |
| 19 | `cesium-lane-turgon-q152-receipt-20260830` | Q-152 aggregate-run-receipt harness (HOLD) | 4 | `233fa5be34` (B1336) | Confirmed absent from main and from the Q-152 bank; genuinely unbanked | 1.6G | RETIRE AFTER BANKING |
| 20 | `cesium-lane-verify` | S3 163-family prototype census (C1) | 1 | `41aad98761` (B1172) | `_c1_verify/` (329K) — ledger itself calls this "editorial carry-in owed", still unbanked | 265M | RETIRE AFTER BANKING |
| 21 | `cesium-worker-g6frame` | C15 gsplat lane — corner-reference + multifrustum probe | 2 | `34fb32c71a` (B1159) | Confirmed 2,396-line diff, absent from archive and main — **PRIORITY** | 1.6G | RETIRE AFTER BANKING (do first) |
| 22 | `cesium-worker-sundisc` | C12-38 `solarDiscTransmittanceSplit` (fleet2 CONFIRMED) | 14 | `34fb32c71a` (B1159) | 82-line `SolarDiscModel.js` delta (+ 4 other files) confirmed absent from main; diverges from sundisc2's own solar-disc work (114/69/49-line pairwise diffs) — needs maintainer reconciliation, not just banking | 1.6G | RETIRE AFTER BANKING |
| 23 | `cesium-webgpu-landing-sol-20260826` | Patch-extension P0a/P0b landing vehicle | 34 | `aa9409432d` (B1169) | Entirely staged (`A`), and every staged path already exists byte-for-byte in main's `Tools/patch-prototype/` + `migration_doc/3D_TILES_PATCH_EXTENSION_*` | 1.6G | RETIRE NOW |

**Totals:** 9 RETIRE NOW, 12 RETIRE AFTER BANKING, 2 KEEP.
**Disk:** ~12.8 GB immediately reclaimable (RETIRE NOW) + ~12.3 GB reclaimable once banked
(RETIRE AFTER BANKING) = **~25 GB total reclaimable**; ~578 MB stays live in the two KEEP repos.

---

## 2. Per-repository detail

### 1. `cesium-audit-docs` (269M) — RETIRE AFTER BANKING

- **Lane:** part of the six-clone 2026-08-27 audit fleet (Batch 1169 base); no `_lane-out/` doc
  names it specifically, but its untracked `_claim_audit/` (claim-verification: `Q1_claim_table.md`
  … `SUMMARY.md`, 3.5M) is unique to this clone.
- **Status:** 41 dirty paths. Last commit `aa9409432d` (Batch 1169).
- **Common-wave check:** its `verify-landing-compliance.mjs`, `WebGPUModelFeatureId.js`,
  `WebGPUModelInstancing.js`, `WebGPUModelRenderer.ts`, `BatchTexture.js`, `BatchTextureSpec.js`
  diffs match the porcelain snapshot already banked at
  `cesium-webgpu-worker-archive/2026-08-27-sol-uncommitted/` (`tracked.patch` + `untracked.tar.gz`,
  base tip `aa9409432d`, hash-matched porcelain listing). All `3D_TILES_PATCH_EXTENSION_*` docs and
  `Tools/patch-prototype/` are already landed in main (`ls migration_doc/` confirms every filename).
- **Delta beyond the banked common wave (unique to this clone):**
  - `_claim_audit/` — 3.5M, untracked, no counterpart found in main or archive.
  - `migration_doc/CAMPAIGN_PORTFOLIO_QUEUE.md` — 6-line CR-normalized diff vs main (stale).
  - `migration_doc/CAMPAIGN_STATE.md` — 0-diff (already in main).
  - `migration_doc/DEBUGGING_GUIDE.md` — 93-line CR-normalized diff vs main (stale WIP notes, main has moved ~200 batches since).
  - `migration_doc/FEATURE_INVENTORY.md` — 6-line CR-normalized diff vs main (stale).
  - `migration_doc/QUEUE_2026-08-02_CAMPAIGN15.md` — 0-diff (already in main).
- **Bank before retiring:**
  - `_claim_audit/` → `cesium-webgpu-worker-archive/cesium-audit-docs-2026-09-02/_claim_audit/`
  - A patch of the 3 non-zero doc diffs (`CAMPAIGN_PORTFOLIO_QUEUE.md`, `DEBUGGING_GUIDE.md`,
    `FEATURE_INVENTORY.md`) → `cesium-webgpu-worker-archive/cesium-audit-docs-2026-09-02/doc-drift.patch`
    (flagged low-value/likely-superseded, kept for reference only).

### 2. `cesium-audit-fleet` (264M) — RETIRE AFTER BANKING

- **Lane:** renderer-divergence audit. Cited directly in the ledger: *"fleet2 | CONFIRMED |
  `F:/Dev/GH/cesium-audit-fleet git diff --numstat 6d5d8b1f07 HEAD -- packages/engine/Source` |
  533 upstream-owned engine files carry ~115k lines of divergence... | QUEUED"* — that finding is
  about the whole-tree upstream-divergence surface, not specifically this clone's 13 dirty paths.
- **Status:** 13 dirty paths. Last commit `aa9409432d` (Batch 1169). Only clone in the six-clone
  fleet whose dirty-file set is NOT the shared model/BatchTexture wave — this one touches globe/
  atmosphere/cluster/perf-manager renderer files instead.
- **Content check (CR-normalized diff vs main HEAD), the 9 touched engine files:**
  - `WebGPUClusterAssignRenderer.ts` — 0-diff (already in main)
  - `WebGPUDynamicEnvironmentMapManager.ts` — 0-diff (already in main)
  - `WebGPUGBufferRenderer.ts` — 0-diff (already in main)
  - `WebGPUPerformanceManager.ts` — 0-diff (already in main)
  - `WebGPUAtmosphereLUT.ts` — 6-line diff (trivial)
  - `WebGPUGlobeSurfacePipelineKey.ts` — 31-line diff (real)
  - `WebGPUGlobeSurfaceRenderer.ts` — 86-line diff (real)
  - `WebGPUGlobeSurfacePipelines.ts` — 128-line diff (real)
  - `WebGPUContext.ts` — 325-line diff (real, largest)
- **4 new untracked specs**, none found in main: `Tools/visual-regression/clustered-light-upload-invalidation.spec.mjs`, `env-map-position-refresh.spec.mjs`, `globe-material-pipeline-format-axis.spec.mjs`, `perf-manager-teardown.spec.mjs`.
- **Assessment:** given main has advanced ~200 batches past this clone's Batch-1169 base, the 4
  files with real residual diff are more likely superseded-by-further-main-evolution than genuinely
  unlanded fixes, but this census cannot prove that without a deeper read — flagged for reviewer
  judgment, not silently discarded.
- **Bank before retiring:** a patch of the 4 non-zero-diff engine files + the 4 new spec files →
  `cesium-webgpu-worker-archive/cesium-audit-fleet-2026-09-02/` (`engine-divergence.patch` +
  `new-specs/`).

### 3. `cesium-audit-model` (266M) — RETIRE AFTER BANKING

- **Lane:** ledger row **A1** — *"`M-1`…`M-8` (model wave repair; M-1 fail-closed guard is the
  verdict driver) | cesium-audit-model"*. Listed under "2. IN FLIGHT" with no later "LANDED, Batch
  NNNN" update found anywhere in the ledger (unlike A2/A3/A4/B2 which all got explicit landed
  markers) — status is genuinely open, not just stale.
- **Status:** 39 dirty paths. Last commit `aa9409432d` (Batch 1169).
- **Common-wave files** match the banked 2026-08-27 snapshot (see repo 1's note).
- **Delta beyond the common wave:**
  - `audit-out/` — 804K, untracked: `batchtexture-differential.mjs` + results JSON,
    `BatchTexture.OLD.js`, `pristine/` (4 pre-change file copies), `FREEZE.md`, `mutation-table.md`,
    `REPORT.md`, `REPORT-T2-T3-T6.md`, `t6-agent/` (5 lint/hash logs). This is the actual audit
    evidence for the A1 lane's M-1..M-8 work.
  - `package.json` — 22-line CR-normalized diff vs main (real, not just noise).
  - `packages/engine/Source/Scene/Model/ModelPrimitiveGeometry.js` — 0-diff (already in main).
  - `migration_doc/DEBUGGING_GUIDE.md` — 126-line CR-normalized diff vs main (stale WIP, different
    from audit-docs' 93-line version of the same file — two uncoordinated partial edits).
- **Bank before retiring:**
  - `audit-out/` → `cesium-webgpu-worker-archive/cesium-audit-model-2026-09-02/audit-out/`
  - `package.json` diff + `DEBUGGING_GUIDE.md` diff → same archive folder as a patch, flagged stale.

### 4. `cesium-audit-policy` (266M) — RETIRE NOW

- **Lane:** ledger row **B3** — *"`O-8` three uncontrolled grammar rules · `O-9` detached-HEAD
  exit | cesium-audit-policy"*.
- **Status:** 35 dirty paths, all of which are a strict subset of the already-banked
  `2026-08-27-sol-uncommitted` porcelain snapshot (`comm -23` between this clone's dirty-path list
  and the bank's snapshot list returned **empty** — zero unique paths).
- **Nothing to bank.** Every dirty byte in this clone is already preserved in
  `cesium-webgpu-worker-archive/2026-08-27-sol-uncommitted/tracked.patch` +`untracked.tar.gz`.
- **Bank list:** none required. Retire directly.

### 5. `cesium-audit-probe` (266M) — RETIRE AFTER BANKING (trivial)

- **Lane:** unclear specific ledger row (its role is not individually cited in `FIX_QUEUE`),
  but the 2026-08-27 audit sweep doc explicitly calls out its one piece of unique content:
  *"`F:/Dev/GH/cesium-audit-probe/.sol-audit-report.md` — worker artifact, must not land."*
- **Status:** 36 dirty paths. Delta beyond the banked common wave (`comm -23`) is exactly one file:
  `.sol-audit-report.md`.
- **Assessment:** the maintainer-sourced sweep doc already ruled this artifact must not land. No
  banking action needed beyond a one-line confirmation; it can be discarded with the clone.
- **Bank list:** none required (explicitly disposable per `AUDIT_2026-08-27_SOL_WAVE_AND_PROJECT_SWEEP.md` §12). Retire directly.

### 6. `cesium-audit-proto` (314M) — **KEEP**

- **Lane:** ledger row **D1** — patch-extension research, R9 round. Explicitly the canonical home:
  *"The audit-proto clone is KEPT (canonical R9 home; round 2b runs there after the fill-in)"*
  and the D1 row's latest status: *"R9 GO (2026-08-28 ~04:30)...Implementation phase UNLOCKED;
  handoff at `_lane-d1-out/HANDOFF.md` | next work window"*.
- **Status:** 39 dirty paths. Last commit `aa9409432d` (Batch 1169).
- **Live content confirming activity:** `_lane-d1-out/` (32M — `HANDOFF.md`, R9A1 through R9A6
  round packets + reviews + probes + sizing scratch, `GITATTRIBUTES_LINE_TO_APPLY.txt`) and
  `_audit-out/` (17M — `AUDIT-FINDINGS.md`, CRLF/JCS/CAS mutation probes, `mut/` fixture families).
  Two migration_doc files not seen in any other audit clone:
  `3D_TILES_PATCH_EXTENSION_P0B_CORE_P2_CENSUS_HEADER_OPTION_MEMO_2026-08-27.md` and
  `...R9_AUDIT_REPAIR_PREREGISTRATION_2026-08-27.md`.
- **Recommendation:** do **not** retire. This is the only live tree holding the D1/R9 implementation
  handoff; the queue's own words are "next work window", i.e. active, not abandoned. No bank list —
  it stays live.

### 7. `cesium-lane-beren-q152-mutant-eol-20260830` (1.6G) — RETIRE NOW

- **Lane:** Q-152 wave-end mutant EOL repair. Ledger: *"Q-152 | PARTIAL — MUTATION HARNESS REPAIR
  LANDED (Batch 1336)... Durable records: `migration_doc/branches/beren--q152-wave-end-mutant-eol.md`
  and `migration_doc/branches/reviews/faramir--q152-wave-end-mutant-eol-review.md`."*
- **Status:** 5 dirty paths. Last commit `806fc36ca4` (Batch 1335).
- **Content check:** `Tools/wave-end-gate.spec.mjs` CR-normalized diff vs main HEAD = **0** (raw
  diff without CR-stripping showed 2,490 lines — that was pure CRLF-checkout noise, confirmed by
  re-running with `--strip-trailing-cr`). Both untracked docs diff at 6 lines against main's already
  -committed copies (`migration_doc/branches/beren--q152-wave-end-mutant-eol.md` and
  `.../reviews/faramir--q152-wave-end-mutant-eol-review.md` both exist in main already, near-identical).
- **Bank list:** none required. Fully landed by content. Retire directly.

### 8. `cesium-lane-celebrimbor-rust-supervisor-20260830` (1.6G) — RETIRE NOW

- **Lane:** Rust process-supervisor coordination. Per `CODEX_HANDOFF_2026-08-30.md`:
  *"Celebrimbor | Rust source coordinator interrupted for slot rotation; no new authority implied."*
- **Status:** 2 dirty paths (`migration_doc/MAINTAINER_RULINGS_2026-08-17.md`,
  `migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md`). Last commit `233fa5be34` (Batch 1336).
- **Content check:** `git diff --stat` on both files produces only the CRLF-checkout warning and
  **zero file-change lines** — pure line-ending noise, no real diff. `Tools/process-supervisor/`
  (the actual Rust work per CODEX_HANDOFF §7) does **not exist in this clone** — it lives untracked
  at repo root (`cesium-webgpu/Tools/process-supervisor/`), not here.
- **Bank list:** none required — clone holds nothing unique. Retire directly.

### 9. `cesium-lane-faramir-handoff-verifier-20260829` (1.6G) — RETIRE NOW

- **Lane:** worker-handoff verifier tooling (`verify-worker-handoff.mjs`).
- **Status:** 3 dirty paths. Last commit `a64954b945` (Batch 1329).
- **Content check:** `Tools/verify-worker-handoff.mjs` diff vs main HEAD = **0** (exact match, no
  CR-stripping even needed). `Tools/verify-worker-handoff.spec.mjs` — main already has this file at
  root (`cesium-webgpu/Tools/verify-worker-handoff.spec.mjs`, 7,447 bytes, present). `package.json`
  diff is one line, and it runs the **opposite direction** — main's script list is a superset of
  this clone's (main added `Tools/visual-regression/q130-wgsl-derivative-uniformity.spec.mjs` to
  `test-build-infra` after this clone forked) — i.e. this clone is simply behind, not ahead.
- **Bank list:** none required. Retire directly.

### 10. `cesium-lane-fredegar` (1.6G) — RETIRE NOW

- **Lane:** Wave-1 research dispatch (four ruling-free lanes). Own last-commit message: *"the
  evidence repatriated, and the engine window still held"* — self-documents that its evidence was
  already moved out before this snapshot.
- **Status:** 1 dirty path (`migration_doc/MAINTAINER_RULINGS_2026-08-17.md`). Last commit
  `2fc55daf56` (Batch 1301), on branch `main` (not a `sol/` lease branch).
- **Content check:** the one dirty file is pure CRLF-checkout noise (`git diff --stat` = no file
  lines). No `_lane-out/`, `_research-scratch*/`, or other untracked directory present.
- **Bank list:** none required. Retire directly.

### 11. `cesium-lane-frodo` (1.6G) — RETIRE AFTER BANKING

- **Lane:** DM-01 probe delivery + Q-91 review lane. Last commit `e4fdfb6f28` (Batch 1318, EAN-01
  Earth-at-Night demo — real feature work, already landed on this clone's own `main` branch).
- **Status:** 2 untracked directories only, no modified tracked files.
- **Content of value:**
  - `_lane-out/Q91_REVIEW_PASS1.md` (16K) — cited directly and durably in the ledger:
    *"Reviews: cesium-lane-instr4/_lane-out/INSTR4_REVIEW_PASS1.md,
    cesium-lane-frodo/_lane-out/Q91_REVIEW_PASS1.md"* — the ledger points at this clone's live path
    as the durable citation, meaning it has **not** been repatriated into main.
  - `_review-scratch-erestor/` (29K) — `control.spec.mjs`, `engine-mutant.spec.mjs`,
    `make-engine-mutant.cjs`, `make-engine-mutant2.cjs`, `mutant.spec.mjs` — Erestor's review
    mutant-fixture scratch, not found in main or any archive folder.
- **Bank before retiring:**
  - `_lane-out/Q91_REVIEW_PASS1.md` → `cesium-webgpu/Tools/visual-regression/output/lane-frodo-2026-09-02/Q91_REVIEW_PASS1.md`
    (evidence repatriation per the standing rule)
  - `_review-scratch-erestor/` → `cesium-webgpu-worker-archive/cesium-lane-frodo-2026-09-02/_review-scratch-erestor/`

### 12. `cesium-lane-maedhros-child-contract-20260829` (1.6G) — RETIRE NOW

- **Lane:** Q-152 H0 pure child-result contract. Ledger/CODEX_HANDOFF: *"Pure H0 exists...was
  independently GO for its original two-file contract, but is landing-held."*
- **Status:** 2 untracked files only. Last commit `a64954b945` (Batch 1329).
- **Bank verification:** both files SHA-256 match **exactly** the copies at
  `cesium-webgpu-worker-archive/q152-side-lanes-2026-09-01/h0-pure/` (hashes reproduced digit-for-digit).
- **Bank list:** none required — already fully and exactly banked. Retire directly.

### 13. `cesium-lane-maedhros-q152-h1-20260830` (1.6G) — RETIRE NOW

- **Lane:** Q-152 H1 variant-consumer.
- **Status:** 9 dirty paths. Last commit `806fc36ca4` (Batch 1335).
- **Bank verification:** the 5 files matching the `h1/` bank folder name
  (`variant-smoke-test.mjs`, `variant-smoke-test.spec.mjs`, `wave-child-result-contract.mjs`,
  `wave-child-result-contract.spec.mjs`, `maedhros--q152-h1-variant-child-result.md`) all SHA-256
  match `cesium-webgpu-worker-archive/q152-side-lanes-2026-09-01/h1/` exactly.
- **Remaining dirty paths, all checked:** `Tools/wave-end-gate.spec.mjs` = 0-diff vs main;
  `migration_doc/MAINTAINER_RULINGS_2026-08-17.md` = 0-diff; `WORKER_ISOLATION_AND_BRANCH_HANDOFF.md`
  = 0-diff; `package.json` = 8-line stale drift (same class as faramir's — a script-list variance,
  not unique functionality).
- **Bank list:** none required. Retire directly.

### 14. `cesium-lane-quickbeam` (1.7G) — RETIRE AFTER BANKING

- **Lane:** Earth-at-Night audit delivery + Celeborn's adversarial review.
- **Status:** 1 CRLF-noise doc + 3 untracked directories. Last commit `3abe28cdf1` (Batch 1295).
- **Repatriation verified:** `_lane-out/` (8.1M, `AUDIT_EARTH_AT_NIGHT_QUICKBEAM.md` +
  `REVIEW_EARTH_AT_NIGHT_CELEBORN.md`) is byte-for-byte the same 67-file/8.1MB set already at
  `Tools/visual-regression/output/lane-quickbeam-2026-08-29/` (full recursive listing matched
  file-for-file, including all PNG evidence and the review doc). Nothing to bank there.
- **Not yet repatriated:**
  - `_research-scratch-quickbeam/` (277K) — `Animation.upstream.js`, `AnimationViewModel.upstream.js`,
    `CesiumWidget.upstream.js`, `avm.diff`, 5 probe scripts, `server8094.log`.
  - `_review-scratch-celeborn/` (4.9M) — upstream/fork comparison slices (`.n`, `.slice` files),
    `cel-abs.mjs`, `cel-mask.mjs`, and more (raw review working files).
- **Bank before retiring:**
  - `_research-scratch-quickbeam/` → `cesium-webgpu-worker-archive/cesium-lane-quickbeam-2026-09-02/_research-scratch-quickbeam/`
  - `_review-scratch-celeborn/` → `cesium-webgpu-worker-archive/cesium-lane-quickbeam-2026-09-02/_review-scratch-celeborn/`

### 15. `cesium-lane-sundisc2` (264M) — **KEEP (FROZEN)**

- **Lane:** C12-38 sun-disc/dawn probe expectation work.
- **Status:** 11 dirty paths. Last commit `41aad98761` (Batch 1172).
- **Standing fact confirmed:** this repository is FROZEN by the maintainer and is never retired,
  regardless of content disposition. No retirement recommendation is made for it in this census.
- **Content for the record (not a retirement question):** modifies
  `Tools/visual-regression/solar-disc-model.spec.mjs`, `sun-orbital-limb-extinction.spec.mjs`,
  `migration_doc/SHADER_PAIRS_LOCKSTEP.md`, `WebGPUEnvironmentRenderer.js`, `cesium-js-types.d.ts`,
  `FrameState.js`, `SolarDiscModel.js` (+32 lines), `Sun.js` (+11), `SunFS.glsl` (+8) — 430
  insertions / 17 deletions across 9 files total. Plus 2 new files:
  `sun-atmosphere-alpha-fragment.spec.mjs` (13,715 B) and
  `migration_doc/C12_38_SUN_DISC_DAWN_PROBE_EXPECTATION_2026-08-27.md` (8,090 B).
- **Cross-reference:** this is a **different, smaller** implementation than
  `cesium-worker-sundisc`'s solar-disc work on the same files (see repo 22) — real pairwise diffs
  exist between the two clones' versions of `SolarDiscModel.js` (114 lines), `Sun.js` (69 lines),
  `SunFS.glsl` (49 lines). The two clones are not duplicates of each other; they hold divergent
  in-progress edits to the same feature area. Flagged for maintainer awareness, no action taken.

### 16. `cesium-lane-theoden-handoff-doc-20260829` (1.6G) — RETIRE NOW

- **Lane:** DX handoff-doc drift repair (its name says the job).
- **Status:** 1 dirty path (`migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md`). Last commit
  `a64954b945` (Batch 1329).
- **Content check:** this is the one clone in the "commonly modified doc" group whose diff is
  **real** — `git diff --stat` reports 40 insertions / 23 deletions (the §4.6/§5 rewrite
  documenting `R-2026-08-18-28`'s no-Git-write worker model). Direct text search on main's current
  copy confirms the distinctive strings (`R-2026-08-18-28`, `Never run a Git write`,
  `status --porcelain -uall`) are **present verbatim** in main's current
  `migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md` — already landed.
- **Bank list:** none required. Retire directly.

### 17. `cesium-lane-treebeard` (1.6G) — RETIRE AFTER BANKING

- **Lane:** AEC design-model performance research + Cirdan's review.
- **Status:** 1 CRLF-noise doc + 3 untracked directories. Last commit `ef27363f6b` (Batch 1294).
- **Repatriation verified:** `_lane-out/` (552K, 6 files: `RESEARCH_DESIGN_MODEL_PERF_TREEBEARD.md`,
  `REVIEW_DESIGN_MODEL_PERF_CIRDAN.md`, and 4 perf JSONs) matches
  `Tools/visual-regression/output/lane-treebeard-2026-08-29/` file-for-file (same 6 files). Nothing
  to bank there.
- **Not yet repatriated:**
  - `_research-scratch-treebeard/` (53K) — `probe-aec-perf.mjs`, `probe-aec-perf2.mjs`, and 3 run
    logs (`run-webgpu.log`, `run2.log`, `server8092.log`).
  - `_review-scratch-cirdan/` (8K) — `cirdan-findings.txt`, `cirdan-notes.txt`.
- **Bank before retiring:**
  - `_research-scratch-treebeard/` → `cesium-webgpu-worker-archive/cesium-lane-treebeard-2026-09-02/_research-scratch-treebeard/`
  - `_review-scratch-cirdan/` → `cesium-webgpu-worker-archive/cesium-lane-treebeard-2026-09-02/_review-scratch-cirdan/`

### 18. `cesium-lane-tuor-q152-20260829` (1.6G) — RETIRE AFTER BANKING

- **Lane:** Q-152 fail-closed wave-end-gate safety. Ledger: *"Q-152 | PARTIAL — FAIL-CLOSED SAFETY
  LANDED (Batch 1332)... NOT CERTIFIED; OPEN."*
- **Status:** 2 modified files only (`Tools/wave-end-gate.mjs`, `Tools/wave-end-gate.spec.mjs`).
  Last commit `a64954b945` (Batch 1329).
- **Content check (CR-normalized, corrected from an earlier raw-diff overestimate):**
  `wave-end-gate.mjs` = **121-line real diff** vs main HEAD; `wave-end-gate.spec.mjs` =
  **147-line real diff**. Unlike beren's spec file (which fully collapsed to 0 after CR-stripping),
  these two retain real content differences — this clone's Batch-1332-era version and main's
  current (Batch-1361-era, further-evolved) version have genuinely diverged, and this census
  cannot determine from a content diff alone whether the residual 268 lines represent lost
  fail-closed-safety work or superseded-by-later-batches drift.
- **Bank before retiring:** a patch of both files' current worktree state →
  `cesium-webgpu-worker-archive/cesium-lane-tuor-q152-20260829-2026-09-02/wave-end-gate.patch`,
  flagged for a maintainer/reviewer content read (not a blind discard) given the OPEN ledger status.

### 19. `cesium-lane-turgon-q152-receipt-20260830` (1.6G) — RETIRE AFTER BANKING

- **Lane:** Q-152 aggregate-run-receipt harness. Own branch doc:
  *"**State:** HOLD — USER SCOPE EXPANSION REQUIRED"* — paused, incomplete, but real.
- **Status:** 4 dirty paths (2 CRLF-noise docs + 2 new files). Last commit `233fa5be34` (Batch 1336).
- **Confirmed NOT banked anywhere:** `Tools/aggregate-run-receipt.mjs`/`.spec.mjs` do not exist in
  main (`ls` came back empty for both), and the Q-152 bank at `q152-side-lanes-2026-09-01/` holds
  only `h0-pure/`, `h1/`, and `thorin-receipt/` (Batch-1339 content from the **separate**
  `cesium-lane-thorin-q152-receipt-20260830` worktree) — turgon's receipt harness is a different
  deliverable, confirmed absent.
- **Content of value:** `Tools/aggregate-run-receipt.spec.mjs` (29,867 B) and
  `migration_doc/branches/turgon--q152-aggregate-run-receipt.md` (23,475 B). The doc's own lease
  list also names `Tools/visual-regression/lib/aggregate-run-receipt.mjs` and
  `Tools/aggregate-run-receipt.mjs` as in-scope paths, but neither is currently dirty in the
  clone — the implementation was not completed before HOLD.
- **Bank before retiring:** both files →
  `cesium-webgpu-worker-archive/cesium-lane-turgon-q152-receipt-20260830-2026-09-02/`.

### 20. `cesium-lane-verify` (265M) — RETIRE AFTER BANKING

- **Lane:** C1 — S3 163-family prototype census + R3 summary. Ledger explicitly: *"cesium-lane-verify
  (`_c1_verify/` S3 163-family prototype census + R3 summary - editorial carry-in owed)"* — the
  ledger itself already flags this as an owed carry-in, i.e. confirmed still unbanked as of the
  most recent status line found.
- **Status:** 1 untracked directory only. Last commit `41aad98761` (Batch 1172).
- **Content:** `_c1_verify/` (329K) — `ast_verify.cjs`, `baselines.mjs`, `BASELINE_HASHES.txt`,
  `census_extract.mjs`, `classification_check.mjs`, `classify_model_specs.mjs`, `classify_v2.mjs`
  through `classify_v6.mjs`, `freeze_subject.mjs`, `probe.diff`, `probe_lines.mjs`,
  `R1_adversarial_review.md`, `R1_summary.txt`, `R2_bounded_review.md`, `R2_summary.txt`,
  `R3_s2_review.md`, and more (directory listing truncated by the census's own read budget — the
  whole directory should be banked, not just the files enumerated here).
- **Bank before retiring:** `_c1_verify/` (entire directory) →
  `cesium-webgpu-worker-archive/cesium-lane-verify-2026-09-02/_c1_verify/`.

### 21. `cesium-worker-g6frame` (1.6G) — RETIRE AFTER BANKING (do this one first)

- **Lane:** C15 gsplat lane — corner-reference class probe + `highAltitudeLabelFraming`, gated
  behind the C15 R4 hold per `CLAUDE.md`.
- **Status:** 2 modified files only, no untracked directories. Last commit `34fb32c71a` (Batch 1159).
- **Content:** confirmed exactly **2,396 insertions / 66 deletions** across
  `Tools/visual-regression/gsplat-campaign15-instruments.spec.mjs` (+1,686) and
  `Tools/visual-regression/probe-gsplat-multifrustum.mjs` (+776/−66) — matches the task brief's
  standing fact exactly. Confirmed absent from `cesium-webgpu-worker-archive/` (no folder for this
  clone anywhere) and absent from main (`ls` for both filenames at repo root returns nothing; the
  files only exist as the gsplat-suffixed clone-local versions).
- **Bank before retiring (highest priority in this census — do before any other retirement):**
  a patch of both files' full current content →
  `cesium-webgpu-worker-archive/cesium-worker-g6frame-2026-09-02/gsplat-instruments.patch`, plus
  copies of the two full files themselves (not just a diff, since neither base is landed) →
  `cesium-webgpu-worker-archive/cesium-worker-g6frame-2026-09-02/gsplat-campaign15-instruments.spec.mjs`
  and `.../probe-gsplat-multifrustum.mjs`.

### 22. `cesium-worker-sundisc` (1.6G) — RETIRE AFTER BANKING

- **Lane:** C12-38 `solarDiscTransmittanceSplit`. Ledger: *"fleet2 | CONFIRMED |
  `F:/Dev/GH/cesium-worker-sundisc/packages/engine/Source/Scene/SolarDiscModel.js:757` |
  cesium-worker-sundisc holds an 82-line `solarDiscTransmittanceSplit` implementation that exists
  in no commit, not in main's tip, and not in main's uncommitted worktree | A2 (in flight)."*
- **Status:** 14 dirty paths. Last commit `34fb32c71a` (Batch 1159).
- **Content:** `SolarDiscModel.js` +82 lines (matches the ledger's own figure exactly), `Sun.js`
  +66/−(net), `SunFS.glsl` +35, `FrameState.js` +26, `WebGPUEnvironmentRenderer.js` and
  `cesium-js-types.d.ts` also touched — 539 insertions / 47 deletions across 11 files total. Plus 3
  new files: `Tools/visual-regression/lib/sun-disc-dawn-gate.mjs` (36,366 B),
  `probe-sun-disc-dawn.mjs` (41,501 B, executable), `sun-disc-dawn-gate.spec.mjs` (47,356 B).
- **Conflict flagged:** this is **not the same implementation** as `cesium-lane-sundisc2`'s solar
  -disc edits (repo 15) — pairwise diffs between the two clones' versions of `SolarDiscModel.js`
  (114 lines), `Sun.js` (69 lines), and `SunFS.glsl` (49 lines) are all real and non-trivial. Two
  divergent in-flight implementations of the same feature area exist across two live clones; a
  maintainer reconciliation decision is owed before either is landed, independent of the banking
  question.
- **Bank before retiring:** a patch of all 11 changed files + the 3 new files →
  `cesium-webgpu-worker-archive/cesium-worker-sundisc-2026-09-02/solar-disc-transmittance-split.patch`
  and `new-files/`, with a note cross-referencing sundisc2's divergent version for the reconciling
  reviewer.

### 23. `cesium-webgpu-landing-sol-20260826` (1.6G) — RETIRE NOW

- **Lane:** the vehicle used to land the P0a/P0b patch-extension prototype work (branch name:
  `sol/p0b-r2-patch-extension-baa9409432-2026-08-26`).
- **Status:** 34 paths, **all staged** (`A`, not `M`/`??`) — the clone's own index already has
  `git add`-ed everything: 23 files under `Tools/patch-prototype/` and 11
  `migration_doc/3D_TILES_PATCH_EXTENSION_*` / audit docs.
- **Content check:** every one of these 34 staged paths already exists at the identical path in
  main's current tree (`ls migration_doc/` and `ls Tools/patch-prototype` both list every filename
  staged here). This clone's entire staged content is the same landing that already happened.
- **Bank list:** none required. Retire directly.

---

## 3. Exact bank lists (grouped by destination)

**To `cesium-webgpu/Tools/visual-regression/output/<lane>/` (evidence):**

- `cesium-lane-frodo/_lane-out/Q91_REVIEW_PASS1.md` → `Tools/visual-regression/output/lane-frodo-2026-09-02/Q91_REVIEW_PASS1.md`

**To `cesium-webgpu-worker-archive/<lane>-2026-09-02/` (everything else):**

| Source clone | Path(s) | Size | Destination folder |
|---|---|---|---|
| `cesium-worker-g6frame` | `Tools/visual-regression/gsplat-campaign15-instruments.spec.mjs`, `probe-gsplat-multifrustum.mjs` (full files + patch) | 2,396 diff lines | `cesium-webgpu-worker-archive/cesium-worker-g6frame-2026-09-02/` |
| `cesium-worker-sundisc` | 11-file patch + 3 new files (`sun-disc-dawn-gate.mjs`, `probe-sun-disc-dawn.mjs`, `sun-disc-dawn-gate.spec.mjs`) | 539 diff lines + 125K new | `cesium-webgpu-worker-archive/cesium-worker-sundisc-2026-09-02/` |
| `cesium-lane-turgon-q152-receipt-20260830` | `Tools/aggregate-run-receipt.spec.mjs`, `migration_doc/branches/turgon--q152-aggregate-run-receipt.md` | 53K | `cesium-webgpu-worker-archive/cesium-lane-turgon-q152-receipt-20260830-2026-09-02/` |
| `cesium-lane-tuor-q152-20260829` | `Tools/wave-end-gate.mjs`, `.spec.mjs` (patch) | 268 diff lines | `cesium-webgpu-worker-archive/cesium-lane-tuor-q152-20260829-2026-09-02/` |
| `cesium-lane-verify` | `_c1_verify/` (whole dir) | 329K | `cesium-webgpu-worker-archive/cesium-lane-verify-2026-09-02/` |
| `cesium-lane-frodo` | `_review-scratch-erestor/` | 29K | `cesium-webgpu-worker-archive/cesium-lane-frodo-2026-09-02/` |
| `cesium-lane-quickbeam` | `_research-scratch-quickbeam/`, `_review-scratch-celeborn/` | 277K + 4.9M | `cesium-webgpu-worker-archive/cesium-lane-quickbeam-2026-09-02/` |
| `cesium-lane-treebeard` | `_research-scratch-treebeard/`, `_review-scratch-cirdan/` | 53K + 8K | `cesium-webgpu-worker-archive/cesium-lane-treebeard-2026-09-02/` |
| `cesium-audit-docs` | `_claim_audit/` + doc-drift patch | 3.5M | `cesium-webgpu-worker-archive/cesium-audit-docs-2026-09-02/` |
| `cesium-audit-model` | `audit-out/` + `package.json`/`DEBUGGING_GUIDE.md` diffs | 804K | `cesium-webgpu-worker-archive/cesium-audit-model-2026-09-02/` |
| `cesium-audit-fleet` | 4-file engine patch + 4 new spec files | — | `cesium-webgpu-worker-archive/cesium-audit-fleet-2026-09-02/` |
| `cesium-audit-probe` | none (disposable, confirmed by `AUDIT_2026-08-27_SOL_WAVE_AND_PROJECT_SWEEP.md` §12) | — | — |

**Nothing to bank (already fully redundant with main or an existing archive):**
`cesium-audit-policy`, `cesium-lane-beren-q152-mutant-eol-20260830`,
`cesium-lane-celebrimbor-rust-supervisor-20260830`, `cesium-lane-faramir-handoff-verifier-20260829`,
`cesium-lane-fredegar`, `cesium-lane-maedhros-child-contract-20260829`,
`cesium-lane-maedhros-q152-h1-20260830`, `cesium-lane-theoden-handoff-doc-20260829`,
`cesium-webgpu-landing-sol-20260826`.

**Never retire (KEEP):** `cesium-audit-proto` (active D1/R9 lane), `cesium-lane-sundisc2` (FROZEN
by maintainer ruling).

---

## 4. Notes for the maintainer

1. This census performed **no writes anywhere** — no delete, no move, no bank copy, no git
   command beyond read-only `status`/`log`/`diff`/`show`/`rev-parse`. Every bank list above is a
   proposal for the next authorized (non-read-only) pass, not a completed action.
2. `cesium-worker-g6frame` should bank first, exactly as flagged in the task brief — it is the only
   clone in this census holding a confirmed, sizeable (2,396-line), completely unbanked diff.
3. `cesium-lane-sundisc2` and `cesium-worker-sundisc` hold **divergent** (not duplicate)
   in-progress solar-disc-transmittance work. Retiring `cesium-worker-sundisc` after banking is
   safe (its content will be preserved), but landing either implementation without reconciling
   against the other risks silently dropping the other's approach.
4. `cesium-lane-tuor-q152-20260829` and `cesium-audit-fleet` both carry real (not CRLF-noise)
   residual diffs against main whose disposition this census could not resolve — genuinely-still-open
   work vs. superseded-by-later-batches drift both remain possible readings. Recommend a content
   read by whoever performs the actual landing/discard decision, not a blind bank-and-delete.
5. The task brief's premise that "the Q-152 family (maedhros x2, tuor, turgon, beren) is already
   banked" is **partially incorrect** — verified true for maedhros x2 (byte-identical, hash-checked)
   and effectively true for beren/tuor's *docs* and *spec.mjs* (content-identical to main), but
   **false for turgon** (`aggregate-run-receipt` work confirmed absent from both main and the
   `q152-side-lanes-2026-09-01` bank) and only partially true for tuor (`wave-end-gate.mjs`/`.spec.mjs`
   carry a real, unbanked 268-line residual per item 4 above).
