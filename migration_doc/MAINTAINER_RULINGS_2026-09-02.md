# Maintainer rulings — 2026-09-02 sitting

Ruled by the maintainer through the root seat (Gandalf, Fable 5.1) in one sitting after the
2026-09-01 audit of the Codex range. Each ruling below supersedes the earlier row or gate it names.
The decision sheet that framed them (options, pros and cons) is banked beside the audit at
`cesium-webgpu-worker-archive/audit-2026-09-01/`; the status authority for every `Q-` id remains
`FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md`.

| Ruling | Subject | Decision |
| --- | --- | --- |
| R-2026-09-02-1 | Edge (browser) scope | The Edge HOLD is narrowed to Q-152 certification only. Éowyn is the standing Edge executor: one job at a time, governed ports 8094/8095, served-md5 preflight on every run. The browser backlog is sequenced once: C15-G7 → C12-38 instrument → 3e-F → A → rebuild barrier → B → C → wave-end. |
| R-2026-09-02-2 | Q-141 and Batch 1338 | Batch 1338 is kept (correct, counters-consistent, never exercised in the AEC scene). Q-141 re-tiers to the pick pass / readback (`WebGPUSceneRendererPickPass`); the metadata-leg requirement is dropped (the demo's "metadata picking" is `scene.pick` + `getProperty` on both backends). The readback investigation runs in parallel with the residency stall (Q-143 / DM-09); readback measurements taken before residency lands are re-measured after it. |
| R-2026-09-02-3 | Wave-1 closure | The manual three-step is permitted: variant smoke test, Sandcastle2 sweep on both renderers, capture-and-diff, banked under `Tools/visual-regression/output/wave-end/wave1/`; the three C18-V2 baselines are refreshed as their own reviewed commit. Batch 1357's cascaded-shadow and voxel byte-identity legs run inside this tranche. |
| R-2026-09-02-4 | The three-way file hold | The quiescence reading: the three renderers are released to C16-10 now. Same-batch cleanlist repointing becomes a binding DX gate for every decomposition. |
| R-2026-09-02-5 | C12-29 S3 (reopened C13-41) | Fund the exit-condition-2 exposure-sweep discriminator first (Sonnet instrument + Opus review, then Edge); re-decide after one measured sweep. Option C of R-2026-08-10-1 (re-file S3/S4 as C13 rows, close C12, unblock C14, release the R4 aurora hold) remains the fallback if the sweep stays red. |
| R-2026-09-02-6 | DX-14 | Released to an Opus lead under a bounded lease; DX-03/04 follow it. |
| R-2026-09-02-7 | The night-sky sitting | The 4096 skybox tier is served externally through the existing resolution-policy seam as an opt-in fetched asset; the 12 JPEGs and the policy file stay uncommitted until the fetch path and a licence determination for the Tycho-2-derived imagery exist. The blurred default (DR-01) stays until EAN-01's star map + HDR is certified on tranche A. Q-77 is answered: G3's chroma and dust criteria are unreachable by any bundled variant, so its red is by construction. Gates M-06..M-10 close under this ruling. |
| R-2026-09-02-8 | M-03 residual | `WEBGPU_AO_FULL_SAMPLE_PATTERN = true` stays. DM-08 (runtime config propagation, plus the `updateConfig` two-of-four-buffers leak) is dispatched to make the cost recoverable. |
| R-2026-09-02-9 | Wave-end gate tool | One bounded repair row: run the runnable legs and record the third as STRUCTURAL; derive `--source-identity` in the gate and refuse on mismatch with a supplied value; retire the receipt validation reachable only through the spec seam. The catalog row is annotated "refuses STRUCTURAL/3 today" until it lands. |
| R-2026-09-02-10 | Guard drafts | Two small Sonnet rows. Fëanor: accept `HEAD` and 40/64-hex local refs, restore the deletion's old tip in `requireInspectableObjects`, format, reach 49/49, then land the shallow-history hardening. Idril: add the four missing fail-closed assertions, then land (low priority). |
| R-2026-09-02-11 | Side-branch Batch 1337 | Dropped. `migration_doc` stays out of Prettier's reach; formatting stays by convention. |
| R-2026-09-02-12 | Batch-number uniqueness | Serialized landings by one root seat, plus a CI check that reports duplicates after push. No server-side enforcement. |
| R-2026-09-02-13 | Rust process supervisor | Relocated out of the tree to a sibling directory, then audited, reviewed and improved **without shrinking**: the Unix backend, the general CLI and the framed protocol stay. No Q-152 integration until certification. Its name is **chelate**, applied as one prefix across directory, crates and binaries in a single pass; `windows_crash_driver` normalises to kebab-case. The pinned toolchain is 1.94.0 (doc fix); trust root and Q-152 runner names are decided when certification is funded. |
| R-2026-09-02-14 | Where campaign status lives | CLAUDE.md's campaign section reduces to a pointer; a tracked `CAMPAIGN_STATE.md` becomes the sole authority and joins the doc-truth sweep. |
| R-2026-09-02-15 | The Q-ledger's form (M-DX-2) | Rotate: a consolidated OPEN table at the head, dated addenda archived monthly, citations by anchor rather than line. The six merges named by the audit land with it. |
| R-2026-09-02-16 | Runner homes (M-DX-1) | The seven runner names are ratified as the family set: `test-visual-regression-node`, `test-engine-node`, `test-s5`, `typecheck-tooling`, `test-visual-probe-contracts`, `typecheck-visual-probe-contracts`, `test-webgpu-error-gate`. The 246 orphan specs are assigned family by family, one Sonnet row per family. |
| R-2026-09-02-17 | Shared helpers | `Tools/lib/` is the home for cross-directory helpers, each with its own fast spec home. The PNG/CRC32 helper and `attachPageDiagnostics` pilots are authorized, two consumers each before any rollout. |
| R-2026-09-02-18 | Tolkien naming | Names are a short-term tracking aid. A name may be reused once a majority of the pool has been used; cycling every week or few weeks is acceptable. Seat practice within a cycle: a name does not review the lane it led. |
| R-2026-09-02-19 | Batch 1340 | Its "Éomer unconditional GO" is unbacked; the watcher-race audit is treated as unreviewed and is reviewed together with the watcher implementation when that row is funded. |
| R-2026-09-02-20 | Provisional record repairs | Ratified as landed (Batch 1358): the nine landed rows that read QUEUED, MS-04 re-opened into Phase M1, DM-08 released, Q-141 recorded as refuted by measurement. |
| R-2026-09-02-21 | Branches and worktrees | Before any sweep: a closer audit of every `sol/*` head and non-main worktree — original intention, anything worth salvaging, visual evidence and scripts — documented, then `branches/ACTIVE_WORKFLOW_WAVE_2026-08-29.md` refreshed, then only what is truly unneeded is retired. |
| R-2026-09-02-22 | The 22 sibling repositories | A census row, then two-phase retirement of the closed lanes (evidence repatriated first). `cesium-worker-g6frame` is banked before anything else happens to it; `cesium-lane-sundisc2` stays frozen. |
| R-2026-09-02-23 | Deletions | Done tonight: the `.agents` ownership backup (deny ACE confirmed on `.agents`), and `.codex-tmp` after its two evidence packets were banked. Approved for when Codex is closed: narrow Codex's trust from all of `f:\dev\gh` to the Cesium directories and prune its 1.7 GB log store — **with the constraint that Codex keeps the ability to create local branches and clones to work on several things at once** (explicit trust entries for every Cesium clone, written by the provisioning tool). |
| R-2026-09-02-24 | Seat operating terms | Tiering: Fable 5.1 root, Opus 5 leads, Opus 5 + Sonnet 5 workers; no token ceiling per wave (the seat reports spend). Standing permission for builds and the 8094/8095 server whenever no Edge job is in flight. Quiet hours unchanged: weekdays 07:00–19:00 ET. |
| R-2026-09-02-25 | First browser jobs | C15-G7 is the first Edge job of the wave. `probe-aec-perf`'s first-run refusal gets a Sonnet diagnosis row before tranche B runs. |

## Dispatch order these rulings produce

1. Branch and worktree salvage audit, then the inventory refresh, then the sweep (R-21); the sibling-repo census (R-22).
2. C15-G7 run — Éowyn, first Edge job (R-25, R-1); rebuild first.
3. Q-143 / DM-09 residency stall — Opus lead; the Q-141 readback investigation in parallel (R-2).
4. `probe-aec-perf` diagnosis — Sonnet + Opus review (R-25).
5. C13-41 exit-condition-2 discriminator — Sonnet instrument + Opus review, then Edge (R-5).
6. Ledger rotation and the six merges — Sonnet (R-15); runner-home assignment by family (R-16).
7. Merged Q-20 + Q-48 + Q-50 — Sonnet engine + Opus review + Edge.
8. C16-10 point-cloud/compute shard, eight clean files (R-4).
9. DM-08 (R-8); DX-14 (R-6); the two guard repair rows (R-10); the wave-end gate repair row (R-9).
10. Wave-1 manual closure with the Q130 legs inside it (R-3).
11. Rust relocation, audit and rename to chelate — Opus lead with Rust (R-13).
12. `CAMPAIGN_STATE.md` and the CLAUDE.md pointer (R-14); the two helper pilots (R-17).
