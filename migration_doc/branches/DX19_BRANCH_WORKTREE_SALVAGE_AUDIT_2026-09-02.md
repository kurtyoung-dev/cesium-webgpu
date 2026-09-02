# DX-19 — branch and worktree salvage audit

- Row: `DX-19`, `QUEUE_2026-08-29_RESEARCH_DISPATCH.md:177` (dispatch view). Ruling: `R-2026-09-02-21`,
  `MAINTAINER_RULINGS_2026-09-02.md`.
- Auditor: Celegorm (Tier-2 lead, Opus). Read-only throughout.
- Executed: `2026-09-02` 01:50–02:10 EDT. Machine clock authoritative.
- Repository tip at audit: `main` = `59c1e4f1d5` (Batch 1361), equal to `origin/main`. The root seat
  landed Batch 1362 (`2cc4af2c0b`, Nienor's DX-20 census) at 02:09 EDT, during the write-up. Every
  finding was revalidated against `2cc4af2c0b`: all nine heads unchanged, all ahead-counts
  unchanged, all seven worktrees unchanged. Batch 1362 touches only `migration_doc`, so no
  conclusion below moves.
- Scope: the nine local heads besides `main`, and the six non-`main` registered worktrees.
- Out of scope, and explicitly **not** cleared for retirement by this document: the 22 standalone
  sibling repositories (that is `DX-20` / `R-2026-09-02-22`) and the four non-Git custody
  directories.

## 0. Read-only declaration

No Git write of any kind was performed: no `checkout`, `reset`, `restore`, `stash`, `branch -d`,
`worktree remove`, `add`, `commit`, `fetch`, or `push`. No build, server, browser, or capture ran.
No file was deleted or moved. The only write is this file.

## 1. Method

1. `git rev-list --left-right --count <head>...main` for ahead/behind, then `git log main..<head>`
   for the exact unique commits.
2. Because `main` was reconstructed on 2026-09-01 (old tip `dda8569016` → `847139bb21`, identical
   trees), ancestry alone is not evidence of absence. Every unique commit was compared to `main` by
   `git patch-id --stable`, and squashed pairs by direct tree comparison (`git diff <a> <b>`).
3. Worktree content was classified by SHA-256 against three destinations: `main`'s HEAD blob,
   `main`'s working copy, and the immutable archive's content-addressed object store
   (`cesium-webgpu-visual-evidence/objects/sha256/`, 373 objects).
4. Uncommitted engine deltas were measured with `git diff` **inside the owning worktree** — a raw
   byte diff against `main`'s blobs overstates them by an order of magnitude, because those trees
   are CRLF on disk and the blobs are LF. `git diff` under each worktree's own attributes is the
   only correct measure and is what is quoted below.
5. "Absorbed" below means: of the added lines in a worktree's own uncommitted diff, the fraction
   that appear verbatim (whitespace- and EOL-normalised) somewhere in `main`'s current blob for the
   same path.

## 2. Headline findings

1. **Every unique branch commit is already banked.**
   `cesium-webgpu-worker-archive/pre-reconstruct-backup-2026-09-01/local-history.bundle`
   (262,288 bytes, SHA-256 `7456028a8e456c5d791f0c359f3fbf3e41c7ded66a476e6dd34b102443b7c951`)
   verifies OK and carries `d37b1f3cb6`, `f0121cfd8d`, `233fa5be34`, `806fc36ca4` and `b1ce382375`
   — the tips of all five heads that are ahead of `main`. `refs.txt` beside it records all nine
   head→SHA mappings. The bundle requires `a64954b945`, which is on `origin/main`, so it stays
   restorable. **No head needs a fresh Git bank before retirement.**
2. **Four of the nine heads carry nothing at all** — they sit exactly on the dispatch base
   `a64954b945`, an ancestor of `main`. The ledger already calls these "empty pointers"
   (`FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md:143`).
3. **Retiring a head in the main repo does not destroy its lane.** All seven lane branches are
   duplicated in **standalone clones** (a `.git` *directory*, not a worktree link file), each
   holding its own copy of the ref. Verified for Tuor, Maedhros ×2, Faramir, Théoden, Beren and
   Turgon. Retiring the main-repo ref is therefore reversible from two independent places.
4. **The only unbanked material anywhere in scope is in the two detached evidence worktrees**:
   48 probe artefacts (3.25 MB) plus two uncommitted diffs (177,104 and 40,198 bytes). Nothing
   else across the six worktrees is unique.
5. **`Appendix A` of `CODEX_HANDOFF_2026-09-01.md` has drifted and should not be pasted forward.**
   Three of its rows disagree with both the live refs and the frozen `refs.txt` (§6.1).
6. **The pre-reconstruction main tip `dda8569016` is now unreferenced** — no branch, no tag
   (`safety-pre-reconstruct-2026-09-01` is absent), held only by `main`'s reflog and the bundle.
   Its custody is now the archive bundle alone (§6.2).

## 3. Local heads (9)

Dispatch base for the whole table: `a64954b945` (Batch 1329), an ancestor of `main`.

| Head | Tip | Ahead | Unique content vs main | Original intention | Banked where | Recommendation |
|---|---|---:|---|---|---|---|
| `sol/dx-handoff-doc-drift-ba64954b945-2026-08-29` | `a64954b945` | 0 | none | Théoden lane — repair worker-handoff procedure drift in `WORKER_ISOLATION_AND_BRANCH_HANDOFF.md`; FROZEN / LANDING HELD (`branches/theoden--dx-handoff-procedure-drift.md`) | `refs.txt`; lane lives in clone `cesium-lane-theoden-handoff-doc-20260829` | **RETIRE NOW** — empty pointer |
| `sol/q-152-wave-end-gate-repair-ba64954b945-2026-08-29` | `a64954b945` | 0 | none | Tuor lane — Q-152 wave-end gate fail-closed repair. Its deliverable **landed** as Batch 1332 (`1dc3f9c360`, on main); the branch never moved (`branches/tuor--q-152-wave-end-gate-repair.md`) | landed on main; `refs.txt`; clone `cesium-lane-tuor-q152-20260829` | **RETIRE NOW** — empty pointer |
| `sol/q152-child-result-contract-ba64954b945-2026-08-29` | `a64954b945` | 0 | none | Maedhros H0 lane — typed child-result contract; FROZEN / INDEPENDENT GO / LANDING HELD pending a first consumer (`branches/maedhros--q152-child-result-contract.md`) | archive `q152-side-lanes-2026-09-01/h0-pure/`; clone `cesium-lane-maedhros-child-contract-20260829` | **RETIRE NOW** — empty pointer |
| `sol/verify-handoff-explicit-lease-ba64954b945-2026-08-29` | `a64954b945` | 0 | none | Faramir lane — explicit-lease repair to `Tools/verify-worker-handoff.mjs`; FROZEN / bookkeeping review owed (`branches/faramir--handoff-verifier-explicit-lease.md`) | `refs.txt`; clone `cesium-lane-faramir-handoff-verifier-20260829` | **RETIRE NOW** — empty pointer |
| `sol/q152-h1-variant-consumer-b806fc36ca4-2026-08-30` | `806fc36ca4` | 6 | **none** — all six commits patch-id-identical to `main`'s Batches 1330–1335 | Maedhros H1 lane — first real consumer of the H0 contract inside `Tools/variant-smoke-test.mjs`; accepted visible red 38 total / 35 pass / 3 fail | archive `q152-side-lanes-2026-09-01/h1/` (6 files, 471 KB); clone `cesium-lane-maedhros-q152-h1-20260830` | **RETIRE NOW** — bookmark only |
| `sol/q152-aggregate-receipt-233fa5be340-2026-08-30` | `233fa5be34` | 7 | **none** — Batches 1330–1336 all patch-id-identical to main | Turgon lane — Q-152 aggregate landing-rules runner receipt. The work lives in the clone, never on this ref | bundle; clone `cesium-lane-turgon-q152-receipt-20260830` (2 tracked + 2 untracked dirty — **DX-20 scope**) | **RETIRE NOW** — bookmark only; the *clone* is DX-20's problem, not this ref's |
| `sol/session-gc-boundary-b1ce-2026-08-30` | `b1ce382375` | 10 | **none** — its two doc commits `5f30649757` + `b1ce382375` are the unsquashed form of `main`'s Batch 1339 `b429c5b518`; `git diff b1ce382375 b429c5b518` is **empty** (identical trees) | Elrond lane — fail-closed boundary safety for `Tools/codex-session-gc.mjs`; V9 candidate frozen, unexecuted, unreviewed; Session-GC V18/V19 HOLD | bundle; archive `codex-session-gc-2026-09-01/` | **RETIRE AFTER BANKING** — the ref carries nothing, but its **worktree** does (§4) |
| `sol/q12-prettier-reachability-233fa-2026-08-30` | `d37b1f3cb6` | 8 | **`d37b1f3cb6` (Batch 1337)** — one line added to `.prettierignore`: `!migration_doc/**/` | Gandalf Q-12 lane — make `prettier --check` non-vacuous over `migration_doc` (ledger `Q-12`, line 90). **DROPPED by `R-2026-09-02-11`**: migration_doc stays out of Prettier's reach, formatting stays by convention | bundle (commit); the whole change is the one line quoted in this row | **RETIRE NOW** — dropped by ruling; content preserved twice over |
| `sol/q152-landing-receipt-233fa-2026-08-30` | `f0121cfd8d` | 8 | **`f0121cfd8d` (Thorin's "Batch 1339")** — 6 files, 5,396 insertions: `Tools/lib/landing-rules-receipt.mjs` (2,494 L), `Tools/run-landing-rules-with-receipt.mjs` (49 L), its spec (1,352 L), a preregistration (1,311 L), `branches/thorin--q152-landing-rules-receipt.md` (189 L), `package.json` | Thorin lane — bind landing-rules results to a verified receipt. **PARKED**: it wraps `npm run test-landing-rules`, not the gate, and its stated frozen tuple does not match the committed blobs (ledger line 143) | archive `q152-side-lanes-2026-09-01/thorin-receipt/0001-Batch-1339-bind-landing-rules-results-to-a-verified-.patch` — **verified byte-identical** to `git format-patch -1 f0121cfd8d` (217,604 B, SHA-256 `8ca2ccc4fa5be2fc1901153aed0f6c340360fd034d4a4521b43041a3fd30ad7b`) | **RETIRE NOW** — fully banked as a re-appliable patch |

### 3.1 Batch-number collision to preserve

`f0121cfd8d` claims **Batch 1339**, and so does `main`'s `b429c5b518`. `d37b1f3cb6` claims
**Batch 1337**, a number `main` never used. Both are already recorded as branch-only lineages that
would be renumbered if ever landed (`FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md:168`). Retiring the refs
does not lose that record — the ledger line and the archived patch both carry it. `R-2026-09-02-12`
(serialized landings plus a post-push CI duplicate check) is the durable guard.

## 4. Non-`main` worktrees (6)

| Worktree | HEAD | Tracked dirty | Untracked | Evidence under `output/` | Unique material | Recommendation |
|---|---|---:|---:|---|---|---|
| `F:/Dev/GH/cesium-lane-elrond-session-gc-20260830` (269 MB) | `b1ce382375` on `sol/session-gc-boundary-…` | 2 (`Tools/codex-session-gc.mjs`, `package.json`) | 2 (`Tools/codex-session-gc.spec.mjs`, `migration_doc/branches/elrond--codex-session-gc-boundary-safety.md`) | none (directory absent) | **none** — all four verified byte-identical to the bank (§4.1) | **RETIRE AFTER BANKING** → already banked; re-confirm §4.1 at sweep time, then retire |
| `F:/Dev/GH/cesium-lane-gandalf-q12-prettier-20260830` (268 MB) | `d37b1f3cb6`, clean | 0 | 0 | none | none | **RETIRE NOW** — lane dropped by `R-2026-09-02-11`; tree fully clean |
| `F:/Dev/GH/cesium-lane-thorin-q152-receipt-20260830` (268 MB) | `f0121cfd8d`, clean | 0 | 0 | none | none | **RETIRE NOW** — commit banked as a verified patch |
| `F:/Dev/GH/cesium-webgpu-cert-s5-3cbb82885fc7` (1.8 GB) | `034c7f74d0` detached — **ancestor of `main`** | 0 | 0 | 6 run dirs / 50 files / 95 MB | **none** — all 50 files byte-identical to `main`'s `Tools/visual-regression/output/cert-s5-runs/` (50/50 SHA-256 match, both directions) | **RETIRE NOW** — already repatriated |
| `F:/Dev/GH/cesium-webgpu-evidence` (1.8 GB) | `f38acf65f6` detached — **ancestor of `main`** | 29 files; `git diff` = 2,426 insertions / 201 deletions | 0 | 360 files | **48 files / 3,403,455 B** absent from both the immutable archive and `main` (§5.1); plus the 29-file uncommitted diff, **93.9 % absorbed** into `main` (1,829 of 1,947 added lines) | **RETIRE AFTER BANKING** — bank §5.1 and §5.2 |
| `F:/Dev/GH/cesium-webgpu-evidence-v9` (1.7 GB) | `99abefdc26` detached — **ancestor of `main`** | 6 files; `git diff` = 1,010 lines | 0 | 24 files | evidence: **none** — 24/24 present in the immutable archive by content. Diff: **95.9 % absorbed** (491 of 512 added lines) | **RETIRE AFTER BANKING** — bank §5.3 only |

Retiring all six reclaims roughly **6.1 GB**.

### 4.1 Elrond bank fidelity (verified this audit)

| Worktree path | Bytes | SHA-256 | Archive counterpart |
|---|---:|---|---|
| `Tools/codex-session-gc.mjs` | 13,084 | `684caa57…d95353ed` | `codex-session-gc-2026-09-01/codex-session-gc.mjs` — match |
| `Tools/codex-session-gc.spec.mjs` | 52,694 | `0bb0dc20…f80eb694` | `…/codex-session-gc.spec.mjs` — match |
| `migration_doc/branches/elrond--codex-session-gc-boundary-safety.md` | 232,934 | `6e1a2f89…f10c65e` | `…/elrond--codex-session-gc-boundary-safety.md` — match |
| `package.json` (modified, 10,661 B) | — | — | `…/package.json.diff` (1,759 B) — `git diff -- package.json` reproduces it exactly |

### 4.2 Detached-HEAD reachability

`034c7f74d0`, `f38acf65f6` and `99abefdc26` are each an ancestor of `main`
(`git merge-base --is-ancestor` returns 0 for all three). **None carries unique history.** Their
entire value was the working tree, and that value is settled by §4 and §5.

## 5. Bank these paths

Three items, in this order. Nothing else in scope requires banking.

### 5.1 — 48 unique probe artefacts (3,403,455 bytes)

- Source: `F:/Dev/GH/cesium-webgpu-evidence/Tools/visual-regression/output/`
- Destination: **`F:/Dev/GH/cesium-webgpu/Tools/visual-regression/output/evidence-wt-20260812/`**
  (gitignored, per the evidence-repatriation rule), preserving the relative layout below.

> **Do not copy these to the root of `output/`.** 41 of the 48 collide by name with newer
> 2026-08-21 regenerations that `main` already holds; a flat copy would silently replace current
> evidence with a superseded 2026-08-12 generation. The `evidence-wt-20260812/` prefix is
> load-bearing. Write a companion `README.txt` in that directory recording the source worktree, its
> HEAD `f38acf65f6`, and the supersession fact.

The eight JSON records are the higher-value half: two `first-red` baselines and four probe-run
records whose run ids (`b70ff28f`, `1218fc8f`, `7b218796`, `97906362`) appear in **neither** the
immutable archive nor `main`, plus the `41264078` receipt/running lifecycle pair.

| Relative path | Bytes | Collision |
|---|---:|---|
| `c12-29-s5-svs-footprint/campaign12-c12-29-s5-svs-5073-footprint.41264078-e94c-49cd-b607-e3834fd7f178.receipt.json` | 523 | — |
| `c12-29-s5-svs-footprint/campaign12-c12-29-s5-svs-5073-footprint.41264078-e94c-49cd-b607-e3834fd7f178.running.json` | 251 | — |
| `eclipse-cloud-response-report.first-red.json` | 234,984 | name collision in main |
| `eclipse-cloud-response-report.run-b70ff28f-b241-4ea2-9609-11b9d14c198d.json` | 234,984 | — |
| `performance/c11-13-voxel-inside-camera.first-red.json` | 5,604 | — |
| `performance/c11-13-voxel-inside-camera.run-1218fc8f-c2f0-4b95-b98c-1ef72aaadf7b.json` | 297,294 | — |
| `performance/c11-13-voxel-inside-camera.run-7b218796-2a02-4cf6-a9b8-2d2d711745dd.json` | 5,604 | — |
| `performance/c11-13-voxel-inside-camera.run-97906362-0aff-43b7-acba-d7249316f919.json` | 5,584 | — |
| `probe-voxel-cell-pick-A-webgl.png` | 63,870 | name collision in main |
| `probe-voxel-cell-pick-A-webgpu.png` | 66,050 | name collision in main |
| `probe-voxel-cell-pick-B-webgl.png` | 63,814 | name collision in main |
| `probe-voxel-cell-pick-B-webgpu.png` | 63,866 | name collision in main |
| `probe-voxel-cell-pick-C-webgl.png` | 62,946 | name collision in main |
| `probe-voxel-cell-pick-C-webgpu.png` | 66,681 | name collision in main |
| `probe-voxel-cell-pick-D-webgl.png` | 62,771 | name collision in main |
| `probe-voxel-cell-pick-D-webgpu.png` | 64,885 | name collision in main |
| `probe-voxel-cells-webgl-front.png` | 61,966 | name collision in main |
| `probe-voxel-cells-webgl-top.png` | 62,014 | name collision in main |
| `probe-voxel-cells-webgpu-front.png` | 64,383 | name collision in main |
| `probe-voxel-cells-webgpu-top.png` | 65,315 | name collision in main |
| `probe-voxel-cylinder-webgl.png` | 72,709 | name collision in main |
| `probe-voxel-cylinder-webgpu.png` | 79,338 | name collision in main |
| `probe-voxel-ellipsoid-webgl.png` | 69,004 | name collision in main |
| `probe-voxel-ellipsoid-webgpu.png` | 91,014 | name collision in main |
| `probe-voxel-evict-cornerA1.png` | 82,258 | name collision in main |
| `probe-voxel-evict-cornerA2.png` | 82,258 | name collision in main |
| `probe-voxel-megatexture-streaming.png` | 60,844 | name collision in main |
| `probe-voxel-megatexture.png` | 64,080 | name collision in main |
| `probe-voxel-octree-l3plus-webgl-close.png` | 61,326 | name collision in main |
| `probe-voxel-octree-l3plus-webgl-close2.png` | 63,297 | name collision in main |
| `probe-voxel-octree-l3plus-webgl-far.png` | 60,249 | name collision in main |
| `probe-voxel-octree-l3plus-webgpu-close.png` | 61,487 | name collision in main |
| `probe-voxel-octree-l3plus-webgpu-close2.png` | 65,194 | name collision in main |
| `probe-voxel-octree-l3plus-webgpu-far.png` | 60,194 | name collision in main |
| `probe-voxel-octree-webgl-close.png` | 60,806 | name collision in main |
| `probe-voxel-octree-webgl-close2.png` | 61,677 | name collision in main |
| `probe-voxel-octree-webgl-far.png` | 60,227 | name collision in main |
| `probe-voxel-octree-webgpu-close.png` | 60,779 | name collision in main |
| `probe-voxel-octree-webgpu-close2.png` | 62,090 | name collision in main |
| `probe-voxel-octree-webgpu-far.png` | 60,220 | name collision in main |
| `probe-voxel-parity-webgl.png` | 63,253 | name collision in main |
| `probe-voxel-parity-webgpu.png` | 64,642 | name collision in main |
| `probe-voxel-pick-webgl.png` | 63,629 | name collision in main |
| `probe-voxel-pick-webgpu.png` | 65,754 | name collision in main |
| `probe-voxel-refined-pick-webgl.png` | 63,777 | name collision in main |
| `probe-voxel-refined-pick-webgpu.png` | 63,326 | name collision in main |
| `probe-voxel-user-customshader-webgl.png` | 62,754 | name collision in main |
| `probe-voxel-user-customshader-webgpu.png` | 63,880 | name collision in main |

### 5.2 — the `cesium-webgpu-evidence` uncommitted diff

- Command (run **inside** the worktree so its own EOL attributes apply):
  `git -C F:/Dev/GH/cesium-webgpu-evidence diff`
- Size: 177,104 bytes / 4,063 lines / 29 files / 2,426 insertions / 201 deletions.
- Destination: `F:/Dev/GH/cesium-webgpu-worker-archive/evidence-worktree-2026-09-02/cesium-webgpu-evidence.diff`,
  with a `README.txt` recording HEAD `f38acf65f6` and the 93.9 % absorption figure.
- Why bank a 94 %-absorbed diff: `git worktree remove` discards uncommitted changes irrecoverably,
  and the residual ~6 % (118 added lines, concentrated in `Scene.js` 24, `WebGPUSceneRenderer.ts` 2,
  `eclipse-cloud-response-gate.spec.mjs` 39, `lib/eclipse-cloud-response-gate.mjs` 27) has never
  been read against `main`. The diff is 173 KB. Bank first, then decide.
- Files touched: 8 under `Tools/visual-regression/`, 20 under `packages/engine/Source/` and
  `Specs/`, plus `scripts/build.js`. `packages/engine/Source/Scene/OcclusionCulling.js` is already
  byte-identical to `main`'s HEAD blob and carries nothing.

### 5.3 — the `cesium-webgpu-evidence-v9` uncommitted diff

- Command: `git -C F:/Dev/GH/cesium-webgpu-evidence-v9 diff`
- Size: 40,198 bytes / 1,010 lines / 6 files, all under `Tools/visual-regression/`
  (`c12-29-s5-custom-ellipsoid-gate` and `c12-29-s5-terrain-selection-gate` probe/lib/spec trios).
- Destination: `F:/Dev/GH/cesium-webgpu-worker-archive/evidence-worktree-2026-09-02/cesium-webgpu-evidence-v9.diff`.
- 95.9 % absorbed; `main`'s versions of these six files are strictly larger and later (e.g.
  `lib/c12-29-s5-custom-ellipsoid-gate.mjs` is 148,541 B on main vs 102,451 B here). Nothing here is
  worth re-applying; the bank exists so the retirement is not a deletion of unread bytes.

### 5.4 — nothing else

Explicitly **not** to be banked, because it is provably already durable:

- All nine head refs and every unique commit → `pre-reconstruct-backup-2026-09-01/local-history.bundle`
  + `refs.txt` (bundle verified OK this audit).
- Elrond's four worktree paths → `codex-session-gc-2026-09-01/` (four-way SHA-256 match, §4.1).
- Thorin's Batch 1339 → `q152-side-lanes-2026-09-01/thorin-receipt/` (byte-identical patch).
- Maedhros H0 and H1 → `q152-side-lanes-2026-09-01/h0-pure/` and `h1/`.
- cert-s5's 95 MB of certification captures → `main`'s `output/cert-s5-runs/` (50/50 match).
- evidence-v9's 24 output files → the immutable archive object store (24/24 by content).

## 6. Cross-cutting findings

### 6.1 `CODEX_HANDOFF_2026-09-01.md` Appendix A has three wrong rows

The brief named Appendix A as the accurate inventory. It is not, and the root seat should not paste
it into the refreshed snapshot. Live refs and the frozen `refs.txt` (written 2026-09-01 20:05, before
the reconstruction) agree with each other and disagree with the appendix:

| Subject | Appendix A says | Live refs **and** `refs.txt` say |
|---|---|---|
| `sol/q152-aggregate-receipt-…` | name `-1f9f245ce43-`, tip `1f9f245ce4` | name `-233fa5be340-`, tip `233fa5be34` |
| `sol/q152-h1-variant-consumer-b806fc36ca4-2026-08-30` | tip `ca0de6918a` | tip `806fc36ca4` |
| `sol/session-gc-boundary-b1ce-2026-08-30` (and its worktree row) | tip `b429c5b518` | tip `b1ce382375` |

In each case the appendix quotes the **post-reconstruction `main`-lineage equivalent** of the
branch's real tip (`1f9f245ce4` ≡ `233fa5be34` by patch-id; `ca0de6918a` ≡ `806fc36ca4`;
`b429c5b518` ≡ `b1ce382375` by tree). The reflog for each of these branches shows exactly one
`branch: Created from …` entry at its live SHA — the refs did not move. The appendix appears to have
been written by resolving branch names against `main` rather than by reading the refs. Content
equivalence means nothing was lost; the defect is inventory accuracy, and it matters because a sweep
driven by those SHAs would have been reasoning about the wrong objects.

`refs.txt` in `pre-reconstruct-backup-2026-09-01/` is the accurate frozen record. Use it.

### 6.2 `dda8569016` is unreferenced; the bundle is its only durable custody

The ledger (`FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md:168`) records the reconstruction keeping the old
tip as tag `safety-pre-reconstruct-2026-09-01`, "deleted only after the range is pushed and
verified". The range **is** pushed (`origin/main` = `59c1e4f1d5`) and the tag **is** gone:
`git rev-parse safety-pre-reconstruct-2026-09-01` fails, and `git for-each-ref --contains dda8569016`
returns nothing. The object still exists, held by `main`'s reflog (default 90-day expiry) and by
`local-history.bundle`. That is the intended end state, but it makes
`pre-reconstruct-backup-2026-09-01/` load-bearing: it must not be swept as "an old backup" by DX-20
or any later cleanup. Recommend marking that directory no-delete in the archive itself.

### 6.3 A head is not a lane

The seven lane branches exist twice: once as a ref in `F:/Dev/GH/cesium-webgpu/.git`, and once
inside a **standalone clone** with its own object database. Confirmed by inspecting each clone's
`.git` (a directory, not a `gitdir:` link file) and its local branch list:

| Head | Owning clone | Clone HEAD | Clone dirt |
|---|---|---|---|
| `sol/q-152-wave-end-gate-repair-…` | `cesium-lane-tuor-q152-20260829` | `a64954b945` | 2 tracked |
| `sol/q152-child-result-contract-…` | `cesium-lane-maedhros-child-contract-20260829` | `a64954b945` | 2 untracked |
| `sol/verify-handoff-explicit-lease-…` | `cesium-lane-faramir-handoff-verifier-20260829` | `a64954b945` | 2 tracked, 1 untracked |
| `sol/dx-handoff-doc-drift-…` | `cesium-lane-theoden-handoff-doc-20260829` | `a64954b945` | 1 tracked |
| `sol/q152-h1-variant-consumer-…` | `cesium-lane-maedhros-q152-h1-20260830` | `806fc36ca4` | 5 tracked, 4 untracked |
| `sol/q152-aggregate-receipt-…` | `cesium-lane-turgon-q152-receipt-20260830` | `233fa5be34` | 2 tracked, 2 untracked |
| *(sibling, no main-repo head)* | `cesium-lane-beren-q152-mutant-eol-20260830` | `806fc36ca4` on `sol/q152-wave-end-mutant-eol-806fc36ca4-2026-08-30` | 3 tracked, 2 untracked |

Deleting the nine main-repo heads therefore reaches none of that clone dirt. **It is also the
reason DX-19 cannot clear DX-20**: retiring the refs is safe precisely because the clones still
hold the lanes, so the clones must be censused and drained on their own terms first.

Nienor's DX-20 census (`branches/DX20_SIBLING_REPOSITORY_CENSUS_2026-09-02.md`, landed as Batch 1362
while this audit was being written) independently confirms the consequence: the **Turgon
aggregate-run-receipt work** and a **268-line Tuor wave-end-gate residual** are absent from both
`main` and the worker archive. Both live only in the clones behind heads this audit marks
RETIRE NOW — `cesium-lane-turgon-q152-receipt-20260830` and `cesium-lane-tuor-q152-20260829`. That
is not a contradiction: the *refs* carry nothing (verified by patch-id above), the *clones* carry
real unbanked content, and DX-20 owns the banking. Retiring the two heads before DX-20 drains those
clones is safe; **deleting the clones is not**, and nothing in this document authorizes it.

Note that
Beren's branch name is `-806fc36ca4-`, not the `-ca0de6918a-` recorded in
`branches/beren--q152-wave-end-mutant-eol.md`; the same appendix-style drift as §6.1.

### 6.4 CRLF makes raw diffs lie

A byte-level `diff` of the evidence worktrees against `main`'s blobs reports ~2,400 changed lines in
a single 277 KB WGSL file — pure line-ending noise, because those trees are CRLF on disk under
`text=auto` while `git cat-file blob` emits LF. The real delta for that file is 47 lines. Any future
sweep that estimates "how much is uncommitted here" from a raw diff will conclude these worktrees
hold thousands of lines of unique work. They do not. Always measure with `git diff` inside the
owning worktree.

## 7. Proposed refreshed inventory block

Paste-ready replacement for the `## Root checkout and branches` section of
`branches/ACTIVE_WORKFLOW_WAVE_2026-08-29.md`. It supersedes that section's four-branch list and its
one-line worktree sentence; the file's lane table, holds, and restart protocol are untouched by
DX-19 and stay as they are.

```markdown
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
```

## 8. Recommended sweep order

1. Bank §5.1 → `main`'s `Tools/visual-regression/output/evidence-wt-20260812/` with its README.
2. Bank §5.2 and §5.3 → `worker-archive/evidence-worktree-2026-09-02/` with a README.
3. Re-confirm the four Elrond hashes in §4.1 (they can drift if anything wakes that clone).
4. Paste §7 into `branches/ACTIVE_WORKFLOW_WAVE_2026-08-29.md`.
5. Only then retire, in this order: the three clean lane worktrees, the three detached worktrees,
   then the nine heads. Each is independently reversible from the bundle or a clone.
6. Do **not** touch any standalone sibling repository — that is DX-20.

— Celegorm
