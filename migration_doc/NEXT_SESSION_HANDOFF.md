# Next Session Handoff — 2026-08-24 (tiered wave; the 2026-08-24 landing group, Batches 1138+)

## Read these first

**If you are Codex Sol without an orchestrator, read
[`SOL_CONTINUATION_BRIEF_2026-08-24.md`](SOL_CONTINUATION_BRIEF_2026-08-24.md) first.** It carries
the rules that apply when no Fable or Opus session is holding the git writes, the environment
traps observed 2026-08-20 to 2026-08-24 and their mitigations, the bounded work list that can be
executed solo, and the landing runbook shape — all with premises re-derived from the code rather
than relayed. This file stays the record of where the session stopped; that one says how to carry
it forward alone.

[`SESSION_CLOSEOUT_2026-08-21.md`](SESSION_CLOSEOUT_2026-08-21.md) is the resumable record of the
previous session — Batches 1129–1137 landed and pushed, ten worker clones retired, and the machine
lane's owed runs recorded. [`MAINTAINER_RULINGS_2026-08-24.md`](MAINTAINER_RULINGS_2026-08-24.md)
records `R-2026-08-24-1` through `R-2026-08-24-16`, taken across **five** sittings on 2026-08-24
(~15:45, ~16:35-16:40, ~18:20, ~21:00 and ~21:55 ET) — `-12` (evidence-library repair) through
`-15` (the `C11-62` clause-(b) ledger clause) were recorded with Batch 1148, and `-16` (the
`C15-G6` precedence ruling) rides Batch 1157. None of `-12`…`-16` is covered by the one-line
summaries below. Queue
rows and `DEFERRED_WORK.md` remain the status authorities; this file only says where the next
session picks up and what is owed.

## The 2026-08-24 rulings in one line each

1. **R-1 — FAR-107 is amended, not read-as-satisfied.** The identity-plateau predicate is encoded
   into FAR-107's own Work and Rollback bullets. The drafted diff is **not applied**: FAR-107 is a
   public-API-review item and charter §4.6 forbids self-approval, so it waits on a non-author
   reviewer. Picking §8/§9 stay unbuilt until it lands.
2. **R-2 — frozen-build artifact policy.** Certification and acceptance probes certify the gulp
   artifact `Build/CesiumUnminified` served by the server's built-artifact mode, with a fail-closed
   assertion that fetched bytes hash-match the artifact on disk. Eleven of 637 probe entry points
   already comply; C11-13, C11-90 and C18-V2 do not, and wiring them closes
   `NEW-DEVSERVER-SERVES-DEV-BUILD-NOT-GULP-ARTIFACT`.
3. **R-3 — C13 ownership re-partition.** Codex Sol may build bounded, spec-verifiable C13
   instrument and harness work under an Opus lane lead with a separate Opus station-3 review, the
   orchestrator landing; C13 engine-semantic changes stay Opus-authored. Regularizes Batches 1131
   and 1136.
4. **R-4 — lane F is taken in its honest form.** The non-lane-F paths land on their own evidence;
   the C18-P engine package gets its first station-3 review and lands only after its browser gates
   run.
5. **R-5 — C15-G9 is CLOSED as NOT REPRODUCED** on the current bundle after three runs at the
   unchanged mutant-pinned 0.050% bar; the D1–D5 harness stays armed.
6. **R-6/R-7/R-8 — picking §10 items 2, 3 and 4 are ruled** (single-texel sync capture by default
   with a 33×33 opt-in; a tunable frame-age cap defaulting to 2 with `PickDepth` pulled to match;
   declarative prewarm via `contextOptions.prewarmPicking` + `pickReadyEvent`). Items 5 and 6 were ruled in the second sitting
   (`R-2026-08-24-9`: globe pick IDs on both backends behind an explicit `Globe.pickable` opt-in;
   `R-2026-08-24-10`: `drillPick` adopts the readiness predicate).

## Working-tree state

**Updated 2026-08-24 ~22:45 ET, after the group pushed — re-derive the tip before relying on this;
it moved twice while this paragraph was being written.** `main` is at `bb15651f42` (**Batch 1157**,
the `C15-G6` multi-frustum instrument) and is **pushed**; `git log origin/main..main` is empty and
the index is clean. Batch 1150 landed at 21:27, Batches 1151 through 1156
between 22:01 and 22:04 (the C16 clustered-lighting/compute-instance, scene/architecture-tail,
pick-plumbing and post-process/effects shards, C13-41 SOL-4 commissioning, and the `Scene.js`
shard), and Batch 1157 at 22:12. **One batch remains pending:** 1158, the Sol continuation brief
and this file's head edit. Batches 1138 through 1150 had landed since this file's
first draft: the moon-mip
readiness repair, probe hygiene, the C16 clean-list ratchet repair, the doc-dirt slices, the two
split-out lane F fixes, C12 EXIT-3, the governance record, the pre-push commit-timestamp guard,
C16-08a, the C12-33 certification on block `20260824b`, the C11-62 octree revision-domain fix,
and the C11-170 gate. The branch inventory is `main` plus
`remotes/origin/main` and the read-only `upstream/*` refs — no local safety or feature branches.
The working tree is **not** clean and was moving throughout: 68 porcelain entries at 21:42, 71 at
21:51, 34 at 22:04 as the shards committed out of it, and **31 after Batch 1157**. Those 31
enumerate as: lane F's held point-cloud package (25 paths — 23 code/probe, of which five are
untracked engine modules and one an untracked spec, plus the
`QUEUE_2026-08-09_CAMPAIGN18.md` hunk-1 and `WEBGPU_DEBUGGING_LOG.md` doc residue), lane P's held
`verify-landing-compliance.mjs` + `.spec.mjs` pair, this file and
`SOL_CONTINUATION_BRIEF_2026-08-24.md` (both Batch 1158), and two further untracked paths —
`migration_doc/pending/` (the rescued FAR-107 amendment draft) and
`CODEX_FABLE_OPUS_CHANGE_AUDIT_2026-08-17.md`, which
nothing currently cites and which needs a disposition. Anything else is a stray.
Eleven worker clones remain at `F:/Dev/GH/cesium-worker-lane1` through `-lane11`; lane7 is an
empty husk, lane8 and lane10 are held by orphaned codex
`node_repl.exe` sandbox processes, and lane11 is lane F with its 30-path package. Lanes 1, 2, 3,
4, 5, 6 and 9 have landed their batches and are retirable now (lane6 was lane H, landed as 1157).
Retire each only
after its batch is pushed, evidence repatriated, junction first.

The 51 held dirty paths at `daaca4fde8` were classified path-by-path and disentangled. The
non-lane-F work lands in this group; **lane F — the 26-path C18-P point-cloud / EDL / GPU-LOD /
Draco package — stays held**, because its terminal browser gates (C18-P2 per-format colour fixtures
with negative controls, C18-P5 the real compressed-Draco gate) have not run. Its first station-3
review is done and advisory: LAND-WITH-EDITS, with an eslint `eqeqeq` error, two EXIT-2
classification entries owed in the same commit that tracks `WebGPUPointCloudEDLState.js`, four
spec-teeth repairs, and two permanent-diagnostic gaps to fix in the author's next round. Two lane-F
slices were split out and land now: the `_pointCloudEyeDomeLighting.destroy()` leak fix (both
backends) and the register/instrument repair.

Deliberately **not** landed, with reasons: the FAR-107 amendment (awaiting a non-author reviewer);
`Tools/verify-landing-compliance.mjs` and its spec (6,151 lines, no station-3 review yet — and the
spec writes and deletes files, so it must be run from a clone, never the shared tree); the
`CAMPAIGN_STATE.md` root-precedence and §0/§0a pause hunks (superseded by `R-2026-08-17-0` and
`-15` plus charter §0.4 — `CAMPAIGN_STATE.md` mirrors rulings, it is not their source); and the
`WEBGPU_DEBUGGING_LOG.md` hunks, which mix landed lanes H and G with lane F material and assert a
`C13-41` closure that `R-2026-08-14-1` vacated. They belong to lane F's landing, rewritten.

## Owed to the machine lane (Edge — the executor owns all browser use)

1. **Bundle refresh first.** `gulp buildCesiumDual` builds from the working tree, so every run
   record must declare provenance as "tip `<sha>` + `<named dirty set>`". A dirty-tree run may never
   claim source identity = tip.
2. The **C12-33 moon-mip ten-run set** in both control modes, after the readiness-cascade repair
   reaches the worktree and a second refresh. `sign-test-v1` is the design of record
   (`R-2026-08-21-15`).
3. **SOL-4 commissioning** and **C11-62 clause (b)**.
4. Lane F's **C18-P2 / C18-P5** gates — both probes must be *authored*, not merely run — plus the
   re-run of the existing EDL/LOD probes against the rewritten architecture and the Karma
   `WebGPUPointCloudLODProcessorSpec` under `CHROME_BIN`→Edge.
5. First runs for any instrument authored unrun this wave. The precedent stands: instrument lanes
   land unrun and the machine lane earns the verdict.

The C15-G9 re-run that the wave plan listed here is **discharged** by `R-2026-08-24-5`.

## Standing debts recorded this wave

- A **discriminating quiet-hours test for `Tools/pre-push-guard.mjs` is owed.** The 59/59 suite is
  green either way: the sandbox sets no `GIT_AUTHOR_DATE`, so every fixture commit's timestamp
  equals its push instant and no input can distinguish `includeCommitQuietHours: true` from
  `false`. A fixed in-window weekday commit date with an out-of-window push, plus its inertness
  mutation, is the missing test.
- `verify-tracked-references.mjs` is **red at tip** with exactly five violations, all lane F's
  (`pointcloud-voxel-public-correctness.spec.mjs` importing five untracked point-cloud modules). It
  is an invariant to hold at five, not a green precondition, until lane F lands.
- `verify-tooling-catalog --check` is red on four unrelated drifted rows, pre-existing at tip.

## Superseded

The C11-210 handoff that stood at the top of this file until 2026-08-24 described the work as
"local, unlanded, and not complete". That is false: **C11-210 landed at Batch 1071
(`806a7f2ce4`)** — native compute commands borrow the exact frame encoder. Its honest residuals
(replacement-device / device-loss, pooled multi-context, WebVR and other offscreen variants) are
carried by the Campaign 11 row and `DEFERRED_WORK.md`, which are the authorities for them.

---

# (Archived) Next Session Handoff — 2026-05-30 (Batches 179–185 — BufferPolygon fix, log-depth epic kickoff, textured-classifier fix)

**Branch:** `main` only (local + origin in sync at `88b111e49c`). No safety / feature / worktree branches. Working tree carries only pre-existing root `Source/Shaders/WebGPU/Primitive/*.wgsl` build-output drift (regenerated material shaders that match canonical `packages/engine/Source` — NOT in-progress work; left uncommitted intentionally).

**Headline:** This span closed two of the three load-bearing roadblocks the prior handoff (Batches 167–178, archived below) called out, and started the renderer-wide log-depth epic the third roadblock demanded:

1. **NEW-WEBGPU-BUFFERPOLYGON-WGSL-IMPORT — RESOLVED (Batch 180, `3667945dae`).** Modern glTF-vector tilesets now render: the WGSL preprocessor resolves the bare `#import` (e.g. `#import CameraUniforms;`) from `BUFFER_WGSL_CHUNKS` before the source reaches the compiler, so the pipeline is valid. This was the prior handoff's RECOMMENDED-NEXT #1 / roadblock #3.
2. **Renderer-wide log-depth epic — IN PROGRESS** (the foundational fix the prior handoff's roadblock #1 demanded for textured-classifier depth precision). Slices 0/1/2a are SHIPPED (Batches 181/182/183), all flag-gated and currently **inert**: the master switch `_logDepthWriteEnabled` defaults **FALSE** (`WebGPUContext.ts:399`), so behavior is byte-identical to pre-epic until the switch flips. Slice 0 reconciled the `csm_*LogDepth` chunk family to one canonical WebGL-parity contract; Slice 1 added the shared inert infrastructure (define bit + master switch + lane helper); Slice 2a made the globe producer write `@builtin(frag_depth)` log depth under the flag.
3. **Flat textured-material GroundPrimitive classification (Color/Stripe/Checkerboard/Grid) — SHIPPED (Batch 185, `88b111e49c`).** Stripe/Checkerboard/Grid now render their material instead of solid flat color. **The root cause was NOT depth precision** (as the prior handoff's roadblock #1 assumed) — it was a 1-hop-too-deep inner-`_primitive` lookup in `packExtents` (`WebGPUGroundPrimitiveRenderer.js:313`) that, for the 1-level per-frame `ClassificationPrimitive` call, walked past the object owning `_batchTable`, returned `false`, and let `packUniforms` write `materialMeta.x = 0` LAST into the shared uniform buffer — flipping `dsColorFS` to the flat-color fast path. The fix walks the variable-depth wrapper chain until it finds `_batchTable`.

> **Batch-number caveat:** git history is **non-monotonic**. These commits are labeled Batches 179–185 and are the *newest* work (HEAD = `88b111e49c`), but earlier-in-history commits used higher labels (up to ~230). When cross-referencing docs that cite "Batch 205/225/230", those are OLDER ancestors. Trust commit hashes/dates over batch numbers.

## What landed (Batches 179–185, all committed + pushed)

| Batch | Commit | Summary |
|---|---|---|
| 180 | `3667945dae` | **NEW-WEBGPU-BUFFERPOLYGON-WGSL-IMPORT RESOLVED** — fix WebGPU BufferPolygon vector-tile render; preprocessor resolves bare `#import` from `BUFFER_WGSL_CHUNKS` so the pipeline compiles |
| 181 | `4063cc7fbc` | Log-depth epic **Slice 0** — reconcile `csm_*LogDepth` chunk family to one canonical WebGL-parity contract |
| 182 | `f3849b7587` | Log-depth epic **Slice 1** — shared inert infrastructure (define bit + master switch `_logDepthWriteEnabled` defaulting FALSE + lane helper) |
| 183 | `92fec34c16` | Log-depth epic **Slice 2a** — globe producer writes `@builtin(frag_depth)` log depth (flag-gated, inert until the switch flips) |
| 184 | `a5b737df6c` | Fix Dawn/Tint uniform `vec4 .zw` past-byte-512 aliasing (classifier U-struct reorder) + log-depth epic Links 1–4a (inert). Docs commits `fdd5b8f1a8` (EXECUTION_ROADMAP baseline) + `f3c962a109` (recorded the VERIFIED textured-classifier root cause) followed |
| 185 | `88b111e49c` | **Flat textured-material GroundPrimitive classification (Color/Stripe/Checkerboard/Grid) SHIPPED** — `packExtents` wrapper-chain walk (`WebGPUGroundPrimitiveRenderer.js:313`); root cause was the inner-`_primitive` lookup depth, NOT depth precision |

## Roadblocks / residuals (the load-bearing findings — read before picking up this domain)

1. **NEW-GROUNDPRIM-CLASSIFIER-RECON-PRECISION — the genuine open residual that survives Batch 185.** With the `packExtents` fix in place, flat textured materials now render, but the **far-corner reconstruction precision** degrades: Checkerboard visibly degrades toward the far corner of a large polygon while Stripe stays clean. This is the legitimately **log-depth-gated** remainder — it needs the renderer-wide log-depth epic's producer+consumer wiring to finish (the globe currently writes hyperbolic NDC depth into an RGBA8 target, so a ~350 km surface in a `[0.1, 1e8]` slice sits where one 24-bit quantization step ≈ ±50–90 km of reconstructed eye-z; the far corner is where this bites). Currently tracked only in `WEBGPU_DEBUGGING_LOG.md` — needs propagating into `DEFERRED_WORK.md` / `FEATURE_INVENTORY.md` §C.4 / `WEBGPU_MIGRATION_BACKLOG.md` / `WEBGPU_EXECUTION_ROADMAP.md`.

2. **Renderer-wide log-depth epic — Slices 0/1/2a shipped but inert; remaining slices are the frontier.** `_logDepthWriteEnabled` defaults FALSE, so the producer/consumer halves are not yet active end-to-end. The remaining work (consumer-reverse across every pipeline that shares the depth attachment, then the master-switch flip + validation) is the path that also unblocks roadblock #1 above and pick/distance precision everywhere. Plan + slice breakdown live in `WEBGPU_EXECUTION_ROADMAP.md`.

3. **Vector3DTile 2D/CV → implemented but still pixel-UNVERIFIED here (carried from Batch 178).** The BufferPolygon fix (Batch 180) now gives a renderable modern glTF-vector scene, so the retroactive e2e verification the prior handoff deferred is now possible — but had not been run as of this handoff. Slice 1 remains a line-for-line port of the verified Batch 170 path (builds, 0 device errors 3D/2D/CV), not yet claimed pixel-correct.

4. **GPU-sort Phase-3 consumer → deferred (perf, correctness trap).** `_lastSortedIndices` is written but never read. The consumer must map compacted-SOA indices back to raw command indices (trap: naive `commands[indices[i]]` corrupts the opaque set), handle 1-frame latency, and — because opaque early-Z makes the reorder pixel-identical when correct — needs a **counter probe** (a pixel-diff can't catch a reorder bug). Its own probe-first session.

5. **C-R9-MODEL-FEATURE-PICK → re-scoped, not closed (carried).** The 3 documented blockers ARE resolved (30 pick IDs + texture allocated, primitive cache populated) but the b3dm `BatchTableHierarchy` tileset doesn't visibly render in the probe — residual b3dm content-render/pick gap needing focused investigation.

6. **BUG-WEBGPU-CANVAS-BLACK appears already resolved (carried)** — every probe across recent spans rendered globes/imagery/polygons fine, never black (likely fixed by Session 61's AsyncResourceMonitor). Owes a formal re-verify but not a lurking showstopper.

## Recommended next steps

The authoritative, slice-by-slice frontier lives in **[WEBGPU_EXECUTION_ROADMAP.md](WEBGPU_EXECUTION_ROADMAP.md)** (committed `fdd5b8f1a8`) — treat it as the live planning artifact rather than re-enumerating here. The two highest-leverage items it drives:

1. **Finish the renderer-wide log-depth epic** (consumer-reverse + master-switch flip + validation). This is what closes **NEW-GROUNDPRIM-CLASSIFIER-RECON-PRECISION** (residual #1) and improves pick + distance precision everywhere.
2. **Retroactively verify + extend Batch 178** now that the BufferPolygon fix gives a renderable modern-vector scene; then Vector3DTilePolylines + ClampedPolylines 2D/CV slices, then MORPHING.

(Lower-priority carries: GPU-sort Phase-3 consumer — own probe-first session; C-R9 b3dm render gap; formal BUG-WEBGPU-CANVAS-BLACK re-verify.)

## Doc state (synced this handoff, Batch 185)

`DEFERRED_WORK.md` and `WEBGPU_DEBUGGING_LOG.md` carry the Batch 179–185 narrative; `WEBGPU_EXECUTION_ROADMAP.md` is the committed live planning artifact. **Propagation still owed:** `NEW-GROUNDPRIM-CLASSIFIER-RECON-PRECISION` (residual #1) currently lives only in `WEBGPU_DEBUGGING_LOG.md` and must be lifted into `DEFERRED_WORK.md`, `FEATURE_INVENTORY.md` §C.4, `WEBGPU_MIGRATION_BACKLOG.md`, and `WEBGPU_EXECUTION_ROADMAP.md`. The prior 2026-05-28 handoff (Batches 167–178) follows below, archived.

---

# (Archived) Next Session Handoff — 2026-05-28 (Batches 167–178 — classification arc: 2D/CV + textured materials + triage)

**Branch:** `main` only (local + origin in sync at `3802e45d3b`). No safety / feature / worktree branches. Working tree carries only pre-existing root `Source/Shaders/WebGPU/Primitive/*.wgsl` build-output drift (regenerated material shaders that match canonical `packages/engine/Source` — NOT in-progress work; left uncommitted intentionally).

> **Note (2026-05-30):** Roadblocks #1 (textured-classifier "blocked on globe depth precision") and #3 (BufferPolygon `#import` compile bug) below were resolved in Batches 180/185 — see the current top section. Roadblock #1's *depth-precision* framing was superseded: the flat textured materials shipped via the `packExtents` fix (Batch 185), and only the far-corner reconstruction-precision residual (NEW-GROUNDPRIM-CLASSIFIER-RECON-PRECISION) remains log-depth-gated. The text below is preserved as the point-in-time record.

**Headline:** A ~3-day push (2026-05-26 → 05-28) on the **classification / ground-primitive arc** plus a 27-agent **triage workflow** over the whole deferred backlog. Flat-color ground classification now renders in **all scene modes**; a large slice of the backlog turned out to be stale doc-drift and was retired/corrected; and the remaining textured-material + vector-classification work was driven until it hit two genuine, now-precisely-documented architectural roadblocks.

> **Batch-number caveat:** git history is **non-monotonic**. These commits are labeled Batches 167–178 and are the *newest* work (HEAD), but earlier-in-history commits used higher labels (up to ~230). When cross-referencing docs that cite "Batch 205/225/230", those are OLDER ancestors. Trust commit hashes/dates over batch numbers.

## What landed (Batches 167–178, all committed + pushed)

| Batch | Commit | Summary |
|---|---|---|
| 167 | `af72357cf0` | Fix WebGPU globe blank at regional 2D zoom (NEW-WEBGPU-GLOBE-2D-REGIONAL-ZOOM) — dropped the 3D-ECEF bounding-volume cull in non-3D modes |
| 168 | `acc471c2e9` | Docs: probes → DEBUGGING_GUIDE |
| 169 | `c9626d31ca` | Remove GroundPrimitive `_needs2DShader` 2D skip; localize the last 2D blocker |
| 170 | `310d365a39` | **GroundPrimitive flat-color classification renders in SCENE2D + Columbus View** (NEW-CLASSIFIER-GROUNDPRIM-2D-RTE) — mode-conditional `.zxy` swizzle in `colorVS`/`vsVelocity` matching WebGL's ENU convention. Probe-verified (SCENE2D 20781 px, CV 14574 px, 0 errors) |
| 171 | `8f44f9f1ff` | GroundPrimitive textured-material **dispatch infrastructure** (UBO 384→640, `applyMaterial` Color/Stripe/Checkerboard/Grid, `surfaceUV` planar+spherical). Color works; textured blocked (see roadblocks) |
| 172 | `2b730cc7cb` | **Triage workflow** (27 agents) + doc-synced **8 stale backlog entries**; re-scoped C-R9-MODEL-FEATURE-PICK after a probe-first catch |
| 173 | `fdf1ab9fd0` | Per-slice frustum-state UBO (resolves NEW-GROUNDPRIM-CLASSIFIER-PER-FRUSTUM-UBO) + corrected `windowToEye` (Batch 171 wrongly used `reverseLogDepth` on linear NDC) |
| 174 | `415067cd38` | GroundPrimitive classification **frustum-slice distribution** via mode-aware bounding volume (resolves NEW-GROUNDPRIM-CLASSIFIER-FRUSTUM-DISTRIBUTION) |
| 175 | `3a4755f5be` | Split-screen **clock sync** (VR3-SPLIT-SCREEN-CLOCK-SYNC, Playwright-verified) + closed outlines-on-terrain warning as upstream parity |
| 176 | `a1fad7b8d2` | Docs: NEW-GBUFFER-MRT-INTEGRATION — producer side shipped (176 shaders emit `@location(1)`); residual is consumer integration |
| 177 | `b7103d1be6` | Docs: NEW-WEBGPU-GLOBE-CLASSIFY-DEPTH-PRECISION — recorded that the proper fix is **renderer-wide log depth**, not globe-local |
| 178 | `3802e45d3b` | Vector3DTilePrimitive **2D/CV classification** (NEW-CLASSIFIER-2D-CV-MORPH slice 1) — implemented, builds, 0 device errors across modes, **e2e-visual UNVERIFIED** (no `.vctr` test data); found active BufferPolygon compile bug |

**Triage finding (Batch 172):** the backlog was dominated by **documentation drift** — 6 of 19 open entries were already fully implemented (verify pass confirmed each producer→consumer chain) and just needed striking. Probe-first earned its keep on C-R9-MODEL-FEATURE-PICK: the code-level verify said "resolved," but running the probe showed the b3dm tileset doesn't visibly render, so it was re-scoped (infra resolved, residual b3dm content-render gap) instead of falsely closed.

## Roadblocks hit (the load-bearing findings — read before picking up this domain)

1. **Textured-material ground classification → blocked on globe DEPTH PRECISION (NEW-WEBGPU-GLOBE-CLASSIFY-DEPTH-PRECISION).** The arc went dispatch-infra (171) → per-slice invProj (173) → frustum distribution (174) → then hit the floor: the WebGPU globe writes **hyperbolic NDC depth** into an RGBA8 texture, so a 350 km surface in a [0.1, 1e8] frustum slice sits at depth ≈ 0.99999971 where one 24-bit quantization step ≈ ±50–90 **km** of reconstructed eye-z — far bigger than the polygon, so the UV can't be reconstructed. Flat-color is unaffected (it only tests depth≠0). **The proper fix is RENDERER-WIDE log depth** (every pipeline emits `frag_depth` log + every consumer reverses it, since all geometry shares one depth attachment and depth-tests against each other — WebGL injects `czm_writeLogDepth` everywhere). Foundational, all-or-nothing, multi-week epic. Contained alternative: a dedicated R32F globe-pass linear-eye-z target sampled only by classifiers (multi-day, diverges from WebGL).

2. **Vector3DTile 2D/CV → implemented but UNVERIFIABLE here (Batch 178).** The repo has **no classic `.vctr` sample tileset** (the only producer of `Vector3DTilePrimitive` content), and its internal classes aren't bundle-exported, so no synthetic probe scene is possible. The modern sample vector tilesets use the **glTF-vector `CESIUM_mesh_vector`** format → route through `BufferPolygon`, a DIFFERENT renderer. Slice 1 is a line-for-line port of the verified Batch 170 path (builds, 0 device errors 3D/2D/CV) but is explicitly **not claimed pixel-correct** pending test data.

3. **Active BufferPolygon compile bug (NEW-WEBGPU-BUFFERPOLYGON-WGSL-IMPORT) — RECOMMENDED NEXT.** Loading any modern glTF-vector tileset fails: `BufferPolygonMaterial.wgsl` line 6 (`#import CameraUniforms;`) reaches the WGSL compiler **unresolved** → `#` is an invalid token → the pipeline is invalid, tileset never renders. Active, on the path real vector tilesets use, and **Playwright-verifiable** (the sample tileset reproduces it). Fixing it would also unblock a modern test scene to retroactively verify Batch 178. Likely cause: `#import` resolution not applied to this shader; fix may be small or expose a larger unfinished-BufferPolygon gap.

4. **GPU-sort Phase-3 consumer → deferred (perf, correctness trap).** `_lastSortedIndices` is written but never read. The consumer must map compacted-SOA indices back to raw command indices (trap: naive `commands[indices[i]]` corrupts the opaque set), handle 1-frame latency, and — because opaque early-Z makes the reorder pixel-identical when correct — needs a **counter probe** (a pixel-diff can't catch a reorder bug). Its own probe-first session.

5. **C-R9-MODEL-FEATURE-PICK → re-scoped, not closed.** The 3 documented blockers ARE resolved (30 pick IDs + texture allocated, primitive cache populated) but the b3dm `BatchTableHierarchy` tileset doesn't visibly render in the probe — residual b3dm content-render/pick gap needing focused investigation.

6. **BUG-WEBGPU-CANVAS-BLACK appears already resolved** — every probe this 3-day span rendered globes/imagery/polygons fine, never black (likely fixed by Session 61's AsyncResourceMonitor). Owes a formal re-verify but not a lurking showstopper.

## Recommended next steps (priority order)

1. **NEW-WEBGPU-BUFFERPOLYGON-WGSL-IMPORT** — active, verifiable, modern-vector path. Start by checking why `#import` isn't resolved for `BufferPolygonMaterial` vs the working `Collections/BillboardCollection.wgsl`.
2. **Verify + extend Batch 178** once a vector test scene exists (BufferPolygon fix gives one); then Vector3DTilePolylines + ClampedPolylines 2D/CV slices, then MORPHING.
3. **NEW-WEBGPU-GLOBE-CLASSIFY-DEPTH-PRECISION** — schedule renderer-wide log depth as a deliberate foundational epic (also fixes pick + distance precision everywhere), OR the contained R32F-classifier-depth workaround if textured ground materials are the priority.
4. GPU-sort Phase-3 consumer (own probe-first session); C-R9 b3dm render gap; formal BUG-WEBGPU-CANVAS-BLACK re-verify.

## Doc state (synced this handoff, Batch 178)

`DEFERRED_WORK.md` kept current throughout 167–178 (entries struck/re-scoped/added inline). `WEBGPU_DEBUGGING_LOG.md` has Bug entries 167.1/170.1/171.1/173.1/174.1 + the BufferPolygon finding. `FEATURE_INVENTORY.md` + `DEBUGGING_GUIDE.md` classification/probe sections synced. The archived 2026-04-27 handoff (Batches 72–74) follows below.

---

# (Archived) Next Session Handoff — 2026-04-27 (Batches 72 + 73 + 74 — C-R7 paired sweep, slices 1 + 2 + 3)

**Branch:** `main` is the only branch (local + origin). Working tree dirty with Batch 74 changes pending commit. No safety branches, no worktree branches, no feature branches.

**Headline:** Three slices of the paired **C-R7-SHADER-MODULE-DEDUP** + **C-R7-RENDERER-MIGRATION-REMAINING** items shipped today. Cloud + Voxel + Weather (Batch 72), Label + Billboard (Batch 73), and Environment + PointCloud + VolumetricFog (Batch 74) all route through the central pipeline cache + shader module cache. Sandcastle baseline holds at **7/7 PASS** across all three batches. Only `WebGPUGlobeSurfaceRenderer` remains for C-R7-RENDERER-MIGRATION-REMAINING (own session due to 3697 LOC scope).

## What today's session landed (Batch 74)

### Batch 74 — C-R7 paired sweep, slice 3 (Environment + PointCloud + VolumetricFog)

Closes the third slice. Pattern: per-device `WeakMap<GPUDevice, WebGPUShaderModuleCache>` for shader dedup; descriptor-only construction + `tryResolveXxxPipeline` async resolution mirroring Batch 56's Ellipsoid template.

**ShaderSourceId additions** (six entries, IDs 17-22):

- `ENVIRONMENT_SUN`, `ENVIRONMENT_MOON`
- `VOLUMETRIC_FOG_COMPUTE` (compute pipeline still direct), `VOLUMETRIC_FOG_COMPOSITE`
- `POINT_CLOUD`, `POINT_CLOUD_LOD`

**Environment** ([`WebGPUEnvironmentRenderer.js`](../packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js)) — Sun WGSL hoisted to top-level const. Both Sun + Moon migrated through shared `tryResolveEnvPipeline()`. Moon's `pushErrorScope`/`_pipelineFailed` removed — central cache's async catch subsumes the error path.

**PointCloud** ([`WebGPUPointCloudRenderer.ts`](../packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudRenderer.ts)) — default + LOD pipelines, both via `tryResolvePointCloudPipeline()`. LOD path skip-returns when not yet ready (matches existing `lodStorageBindGroup` not-ready behavior).

**VolumetricFog** ([`WebGPUVolumetricFogRenderer.ts`](../packages/engine/Source/Renderer/WebGPU/WebGPUVolumetricFogRenderer.ts)) — composite render pipeline via central cache; compute pipelines stay direct. `composite()` early-exits if pipeline isn't ready (Phase 5a no-op clears mean a missed composite frame is invisible). Type field changed from `compositePipeline: GPURenderPipeline` to `... | null`.

**Verification:** tsc clean, gulp build clean, Sandcastle 7/7 PASS. All baseline demos exercise the Sun + Moon environment rendering path.

**Adopter counts after Batch 74:**

- Pipeline cache: 14 renderers (was 11).
- Shader module cache: 12 renderers (was 8).

## Pre-Batch-74 history

### Batch 73 — C-R7 paired sweep, slice 2 (Label + Billboard)

Both renderers already had `WebGPUShaderModuleCache` adoption (since Batch 22-era work) but were still building `GPURenderPipeline` objects directly via `device.createRenderPipeline()` keyed by a local `Map<defines, pipeline>`. Batch 73 routes both through the central `webgpuPipelineCache`.

**Label** ([`WebGPULabelRenderer.js`](../packages/engine/Source/Renderer/WebGPU/WebGPULabelRenderer.js)) — single SDF pipeline per defines combination. `createSDFPipeline()` → `buildSDFDescriptor()` + `tryResolveLabelSDFPipeline()`. `cache.sdfPipelines` Map → `cache.sdfPipelineEntries` Map of `{ descriptor, pipeline, pending }` slots.

**Billboard** ([`WebGPUBillboardRenderer.js`](../packages/engine/Source/Renderer/WebGPU/WebGPUBillboardRenderer.js)) — color + pick pipelines, both per-defines. `createBillboardPipeline()` / `createBillboardPickPipeline()` → `buildBillboardDescriptor()` / `buildBillboardPickDescriptor()` + shared `tryResolveBillboardPipeline()`. Both `cache.pipelines` and `cache.pickPipelines` Maps converted to entry-based caching.

**Verification:** tsc clean, gulp build clean, Sandcastle 7/7 PASS. Edge Visibility / Edge Feature ID exercise the Billboard pipeline directly.

**Adopter counts after Batch 73:**

- Pipeline cache: 11 renderers (was 9).
- Shader module cache: 8 renderers (unchanged — Label + Billboard already had it).

## Pre-Batch-73 history

### Batch 72 — C-R7 paired sweep, slice 1 (Cloud + Voxel + Weather)

Closes the first three of the paired C-R7 items from `DEFERRED_WORK.md`. Pattern: per-device `WeakMap<GPUDevice, WebGPUShaderModuleCache>` for shader dedup; descriptor-only construction + `tryResolveXxxPipeline` async resolution mirroring Batch 56's Ellipsoid template.

**ShaderSourceId additions** ([`WebGPUShaderDefines.ts`](../packages/engine/Source/Renderer/WebGPU/WebGPUShaderDefines.ts)):

- `CLOUD_COLLECTION = 13`
- `VOXEL_PRIMITIVE = 14`
- `WEATHER_PARTICLE_RENDER = 15`
- `WEATHER_PARTICLES_COMPUTE = 16` (compute pipeline still goes direct; module is deduped)

**Cloud renderer** ([`WebGPUCloudRenderer.ts`](../packages/engine/Source/Renderer/WebGPU/WebGPUCloudRenderer.ts)) — single render pipeline; `tryResolveCloudPipeline` with sync-first / async-kickoff / fallback to direct `device.createRenderPipeline()` when no central cache.

**Voxel renderer** ([`WebGPUVoxelRenderer.ts`](../packages/engine/Source/Renderer/WebGPU/WebGPUVoxelRenderer.ts)) — color + pick pipelines sharing one shader module; `tryResolveVoxelPipelines` with `Promise.all` parallel async kickoff.

**Weather renderer** ([`WebGPUWeatherRenderer.ts`](../packages/engine/Source/Renderer/WebGPU/WebGPUWeatherRenderer.ts)) — render pipeline migrated; compute (3 pipelines) deferred until `WebGPUComputePipelineCache` lands. Both compute + render shaders are deduped at the module level.

**Verification:**

- `npx tsc --noEmit` clean.
- `npx gulp build` clean.
- Sandcastle baseline: PASS=7, FAIL=0, SKIP=0. Voxel Pick is the direct in-baseline coverage of the migrated voxel renderer; Cloud + Weather lack WebGPU baseline demos (only WebGL Sandcastle demos exist for `CloudCollection` + `scene.weather`), so their migration verification is by tsc + build success and pattern parity with Ellipsoid / Polyline.

**Adopter counts after Batch 72:**

- **Pipeline cache:** 9 renderers — Polyline, PointPrimitive, GroundPrimitive, GaussianSplat, EllipsoidPrimitive, BufferPrimitive, DepthPlane, **Cloud** (new), **Voxel** (new), **Weather render** (new).
- **Shader module cache:** 8 renderers — Polyline, PointPrimitive, Billboard, Label, GlobeSurface, **Cloud** (new), **Voxel** (new), **Weather** (new).

## Remaining C-R7 work (1-2 sessions)

| Renderer | LOC | Module cache | Pipeline cache | Notes |
| --- | --- | --- | --- | --- |
| WebGPULabelRenderer.js | 645 | ✅ | ❌ | Add pipeline cache only |
| WebGPUBillboardRenderer.js | 916 | ✅ | ❌ | Add pipeline cache only |
| WebGPUEnvironmentRenderer.js | 1047 | ❌ | ❌ | Both gaps |
| WebGPUVolumetricFogRenderer.ts | 1185 | ❌ | ❌ | Both gaps |
| WebGPUPointCloudRenderer.ts | 892 | ❌ | ❌ | Both gaps |
| WebGPUGlobeSurfaceRenderer.ts | 3697 | ✅ | ❌ | Add pipeline cache; largest single migration, may be its own session |
| WebGPUModelRenderer.js | — | partial | ❌ | Blocked on full ShaderModuleCache adoption + KHR-extension shader-family work (C-R4-GLTF-KHR) |
| WebGPUAutoExposure | — | — | n/a | Compute pipeline; out of scope until `WebGPUComputePipelineCache` exists |

**Suggested next slice:** Pair Label + Billboard (both already have module cache, just need pipeline cache adoption — small mechanical pass). Then Environment + VolumetricFog + PointCloud as one batch (all three need both gaps closed; mid-sized files). Save GlobeSurface for its own session because of the 3697 LOC scope.

---

## Pre-Batch-72 history (previously top-of-doc)

### Handoff — 2026-04-27 (Batches 69 + 70 + 71 — NEW-4-G/H/I closures, Sandcastle 5/7 → 7/7)

**Branch:** `main` is the only branch (local + origin). HEAD will be the Batch 71 commit once landed (current HEAD = `cb86a5b944` "Batch 70"). Working tree dirty with the Batch 71 changes (NEW-4-I + this doc update). No safety branches, no worktree branches, no feature branches. The trunk-only workflow is now codified in `CLAUDE.md` § "Branch Transparency — CRITICAL" (local-only file, gitignored).

**Headline:** All 7 WebGPU Sandcastle demos pass on real WebGPU for the first time. The NEW-4-A through NEW-4-I sweep that started in Batch 66 is fully closed.

## What today's session landed (Batches 69 + 70 + 71)

### Batch 69 — `c3e8446f5d` — NEW-4-G Voxel WGSL `textureSample` non-uniform-control-flow

**Problem (captured live, port 8082):**

```text
[CesiumJS:webgpu:<ctx-uuid>] Shader "unlabeled" compilation ERROR at line 73:13: 'textureSample' must only be called from uniform control flow
```

**Root cause:** WGSL spec requires `textureSample` to be called from uniform control flow (the call auto-computes derivatives across a 2x2 fragment quad). The two call sites in `WebGPUVoxelRenderer.ts`'s embedded WGSL (`fragmentMain` line 120, `fragmentPickMain` line 159) sit inside a `for` loop with a data-dependent `break` on `accumA`. naga rejected the call.

**Fix:** Replaced both `textureSample(voxelTex, voxelSamp, uvw)` with `textureSampleLevel(voxelTex, voxelSamp, uvw, 0.0)`. `textureSampleLevel` takes an explicit LOD argument and never computes derivatives, so it has no uniform-control-flow constraint. Volumetric voxel textures are single-mip so forcing LOD 0 matches existing intent.

**Files touched:** [packages/engine/Source/Renderer/WebGPU/WebGPUVoxelRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUVoxelRenderer.ts).

**Sandcastle delta:** WGSL error gone. Demo still FAIL because resolving NEW-4-G immediately surfaced NEW-4-H as the next predicted blocker (`Matrix4.multiplyByPoint` cartesian-undefined in `updateWebGPUVoxelPrimitive`). Tracked + closed by Batch 70.

### Batch 70 — `cb86a5b944` — NEW-4-H two coupled root causes (Voxel + Translucent _cachedShader unblock)

**Problem 1 (Voxel Pick):**

```text
DeveloperError: Expected cartesian to be typeof object, actual typeof was undefined
    at Matrix4.multiplyByPoint (index.js:4591:28)
    at Object.updateWebGPUVoxelPrimitive [as update] (index.js:79617:36)
```

**Root cause 1:** `UniformState` in JS only had the private `_cameraPosition` field. The TS `.d.ts` companion declared `readonly cameraPosition: Cartesian3` and **13 WebGPU renderer call sites** consumed it (`WebGPUVoxelRenderer`, `WebGPUCloudRenderer`, `WebGPUEllipsoidPrimitiveRenderer`, `WebGPUGaussianSplatRenderer`, `WebGPUPointCloudRenderer` (×2), `WebGPUBufferPrimitiveRenderer`, `WebGPUGlobeSurfaceRenderer` (×3), `WebGPUUniformGroupManager` (×2), `WebGPUModelRenderer`). Every read returned `undefined`. Production builds masked this entirely because the `Check.typeOf.object` debug pragmas are stripped — the unminified Sandcastle build was the first place the missing property surfaced as a hard crash, and Voxel Pick was the first demo to dereference it before any callers could have guarded.

**Fix 1:** Added a one-line `get cameraPosition() { return this._cameraPosition; }` to [UniformState.js](../packages/engine/Source/Renderer/UniformState.js) next to `previousCameraPosition`, with a JSDoc block referencing NEW-4-H so future maintainers don't re-remove it. All 13 call sites are now correct without any per-site changes.

**Problem 2 (Voxel + Translucent both, after Fix 1):**

```text
TypeError: Cannot read properties of undefined (reading '_cachedShader')
    at ShaderCache.getDerivedShaderProgram (index.js:25790:44)
    at getDepthOnlyShaderProgram (index.js:295577:44)
    at DerivedCommand.createDepthOnlyDerivedCommand (index.js:295654:45)
    at updateDerivedCommands (...)
```

**Root cause 2:** `DerivedCommand.createDepthOnlyDerivedCommand` is upstream WebGL-only logic that derives a depth-only shader by manipulating GLSL `fragmentShaderSource` and caching via `shaderProgram._cachedShader`. WebGPU draw commands carry a `GPUShaderModule`-backed pipeline, not a WebGL `ShaderProgram`, so `command.shaderProgram` is either undefined or an object without `id` / `_cachedShader`. The sibling `createLogDepthCommand` already had a NEW-5-A WebGPU guard from Batch 66 — this batch closes the symmetric defect.

**Fix 2:** Added the symmetric `if (!defined(cmdShader?.id))` guard at the top of [DerivedCommand.createDepthOnlyDerivedCommand](../packages/engine/Source/Scene/DerivedCommand.js). Copies the WebGPU shader/renderState through unchanged; the WebGPU dispatcher (`selectCommandVariant` from Batch 29) already routes depth-only via its own `derivedCommands.depth.command` slot with a pre-built WGSL pipeline.

**Files touched:** [packages/engine/Source/Renderer/UniformState.js](../packages/engine/Source/Renderer/UniformState.js), [packages/engine/Source/Scene/DerivedCommand.js](../packages/engine/Source/Scene/DerivedCommand.js).

**Sandcastle delta:** PASS=5 → PASS=6. Voxel Pick green; Translucent Classification's `_cachedShader` co-failure resolved by the same DerivedCommand.js fix; the lone remaining Translucent Classification failure is NEW-4-I (a different root cause — depth texture format mismatch in `copyTextureToTexture`).

### Batch 71 — NEW-4-I Translucent Classification depth-format-copy-compat → Sandcastle 7/7 PASS

**Problem (captured live, port 8082):**

```text
[WebGPU:GlobePass] GPU VALIDATION ERROR: Source [Texture "SceneFramebuffer-Color_depth"] format (TextureFormat::Depth24PlusStencil8) and destination [Texture "TranslucentTileClass_TranslucentDepth_1x"] format (TextureFormat::Depth24Plus) are not copy compatible.
 - While [Failed to format error message: "encoding %s.CopyTextureToTexture(%s, %s, %s)."].
 - While finishing [CommandEncoder "Scene Frame Command Encoder"].
```

**Root cause:** `WebGPUTranslucentTileClassification.update` allocated `_translucentDepthTexture` as `depth24plus` (depth-only). The scene FB depth attachment (`SceneFramebuffer-Color_depth`) is allocated as `depth24plus-stencil8` because InvertClassification needs the stencil aspect. WebGPU `copyTextureToTexture` requires identical source/dest formats — the spec doesn't allow copying depth+stencil → depth-only even when both endpoints specify `aspect: "depth-only"`. The asymmetric allocation predated the InvertClassification stencil-path landing and was never reconciled.

**Fix:** Single-line format change at [WebGPUTranslucentTileClassification.ts:322](../packages/engine/Source/Renderer/WebGPU/WebGPUTranslucentTileClassification.ts) from `"depth24plus"` to `"depth24plus-stencil8"`. The sampleable view at line 331 already pins `aspect: "depth-only"` so the pack pipeline still binds only the depth channel — the stencil aspect is allocated but never sampled. Cost: one stencil byte per pixel (~negligible at any practical viewport size).

**Files touched:** [packages/engine/Source/Renderer/WebGPU/WebGPUTranslucentTileClassification.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUTranslucentTileClassification.ts).

**Sandcastle delta:** PASS=6 → **PASS=7** (FAIL=0). End of the NEW-4 sweep — all nine NEW-4-prefixed entries from the Batch 66 Sandcastle rollout are closed.

### Process / rule changes

- **CLAUDE.md gained "Branch Transparency — CRITICAL" section** (local-only file, gitignored — won't push to origin). Five triggers: starting a work package, creating a branch/worktree, sub-agent spawning a worktree, finishing a work package, opening a new conversation when non-main branches exist. The user explicitly asked for this rule and it's now load-bearing for every future session.
- **No safety branches taken this session.** Both batches were small enough (single-file or two-file scoped) that the cost-benefit favored direct commits with verification at each step over the multi-layer backup ritual the prior session used.

## Sandcastle baseline now (PASS=7 / FAIL=0 of 7) — first time green

Source of truth: [Tools/visual-regression/screenshots/sandcastle-batch-66-final/report.json](../Tools/visual-regression/screenshots/sandcastle-batch-66-final/report.json) (re-captured this session).

| Demo                              | Status | Note                                                                                                            |
| --------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------- |
| WebGPU Edge Feature ID            | PASS   | Closed in Batch 67 via NEW-4-A.                                                                                 |
| WebGPU Edge Visibility            | PASS   | Closed in Batch 67 via NEW-4-A.                                                                                 |
| WebGPU Many Imagery Layers        | PASS   | Steady-state since Batch 66.                                                                                    |
| WebGPU Model Pick                 | PASS   | Renders correctly; pick returns null at canvas center because the model is off-center. Latent UX, not a bug.    |
| WebGPU Point Light Shadows        | PASS   | Steady-state since Batch 63 (5-tap PCF).                                                                        |
| WebGPU Translucent Classification | PASS   | Closed in Batch 71 via NEW-4-I. The `_cachedShader` co-failure was closed in Batch 70 via NEW-4-H.              |
| WebGPU Voxel Pick                 | PASS   | Closed in Batch 70 via NEW-4-G + NEW-4-H combo. Was FAIL since Batch 66.                                        |

The 7/7 baseline is now the floor. Future regressions that drop below 7/7 should be treated as actual regressions rather than known-failing demos.

## What's next (next session pick-list)

The whole NEW-4 sweep is closed. Next priorities pivot from "unblock the Sandcastle baseline" to deeper correctness / mechanical work.

### Tier 1 — highest-impact correctness work (pulled from the cross-cutting priority guide in [DEFERRED_WORK.md](DEFERRED_WORK.md))

> **Note (2026-04-27 reconciliation):** the prior version of this list led with `C-R5-IMAGERY-16`, citing the oversight audit. That work was actually closed in **Batch 58 (2026-04-25)** — see [PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md § C-R5](archive/principal-review-2026-04-16/PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md) (archived 2026-09-03; id table at `ARCHITECTURE_REVIEW_2026-09-02.md` §5.1). The audit's recommendation #2 was acted on; the doc trail just never reconciled the closure into the priority guide. C-R5 is no longer the lead item; `C-R8-TRANSLUCENT-MULTI-FRUSTUM` is the highest-impact correctness item still open.

1. **`C-R8-TRANSLUCENT-MULTI-FRUSTUM`** — multi-frustum scenes misclassify primitives at frustum splits. `executePackDepth` runs once per frame and captures only the last-rendered frustum's depth; primitives spanning frustum boundaries get the wrong classification mask. Hits whenever camera height crosses a logarithmic split (default 4-frustum scenes). Architectural — needs per-frustum pack-depth + multi-layer texture, or per-frustum array + slice indexing at composite. 2 sessions per [DEFERRED_WORK.md C-R8-TRANSLUCENT-MULTI-FRUSTUM](DEFERRED_WORK.md).

### Tier 2 — mechanical / architectural sweeps (3-4 sessions each)

1. **`C-R7-RENDERER-MIGRATION-REMAINING`** + **`C-R7-SHADER-MODULE-DEDUP`** — 9 renderers + ModelRenderer routing through `context.webgpuPipelineCache`. Mechanical; no design risk. Bundles naturally.
2. **`C-R4-GLTF-KHR`** — its own multi-week workstream. `KHR_texture_transform` is the highest-impact single extension to start with.

### Operational follow-ups (recurring papercuts)

- **`gh auth switch --user kurtyoung-dev` is needed at the start of every session** to push to origin (the keyring keeps `KurtTrottr` as the default active account between sessions). Worth investigating: either set kurtyoung-dev as the default via `gh auth setup-git` or document the dance in the handoff so it's not a fresh discovery each time.
- **CLAUDE.md is gitignored**, so the new "Branch Transparency" rule lives only on this workstation. If multiple developers work on this fork, they'll each need to add the rule to their own local CLAUDE.md.

## Quick state-of-migration

- **~95% WebGL feature parity.** Full per-batch detail in [REVIEW_FIX_PROGRESS.md](REVIEW_FIX_PROGRESS.md); per-issue status in the principal review.
- **Critical-tier review work (C-R prefix):** all 13 originally-OPEN parent findings now have at least first-cut implementations shipping. Remaining work is named-follow-up scope, all enumerated in [DEFERRED_WORK.md](DEFERRED_WORK.md).
- **NEW-4 status (Sandcastle WebGPU baseline) — FULLY CLOSED:**
  - NEW-4-A FIXED (Batch 67) — eager typed-array retention in `GltfLoader.loadVertexAttribute`.
  - NEW-4-D FIXED (Batch 67) — `Texture3D` constructor short-circuits to `WebGPUTexture3D` via JS constructor return-value semantics.
  - NEW-4-E FIXED (Batch 68) — paired each `discard;` with `return vec4<f32>(0.0);` in Voxel WGSL fragment functions.
  - NEW-4-G FIXED (Batch 69) — `textureSample` → `textureSampleLevel(..., 0.0)` in Voxel WGSL ray-march loop.
  - NEW-4-H FIXED (Batch 70) — added missing `UniformState.cameraPosition` getter + `DerivedCommand.createDepthOnlyDerivedCommand` WebGPU guard.
  - **NEW-4-I FIXED (Batch 71)** — `_translucentDepthTexture` allocator flipped from `depth24plus` to `depth24plus-stencil8` to match scene FB depth attachment.
- **Sandcastle baseline:** **7/7 PASS on real WebGPU after Batch 71** (was 6/7 after Batch 70; 5/7 after Batch 67-69; 3/7 before NEW-4-A). First time all WebGPU demos green.
- **TSC status:** root `npx tsc --noEmit` clean. Engine-package `tsconfig.json` was fixed in Batch 68 (Tier 0 — `FrameTimings extends DebugStatsObject` and GPUTextureView narrowing); `npx gulp build` runs to completion in this session.

---

## Pre-Batch-69 handoff (preserved below for traceability — was the canonical doc through 2026-04-25)

### Original title: Next Session Handoff — 2026-04-25 (Batch 67 — NEW-4-A + NEW-4-D closures)

**Branch:** `main`. Batches 28-64 already in this branch; Batch 67 (NEW-4-A + NEW-4-D) added on top this session. Batches 65-66 were the prior session's Sandcastle demo rollout + 12 inline engine fixes (see Sandcastle batch reports). The full Batch 28-62 progression is documented in [REVIEW_FIX_PROGRESS.md](REVIEW_FIX_PROGRESS.md); per-issue status in [PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md](archive/principal-review-2026-04-16/PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md) (archived 2026-09-03). The full inventory of items still deferred from this work has been consolidated into [DEFERRED_WORK.md](DEFERRED_WORK.md) — that's the canonical pick-list for the next sessions.

## ⚠️ Build is broken on `packages/engine/tsconfig.json`

`npx gulp build` fails at the engine TS pass with TWO pre-existing errors (carry-over from the WIP checkpoint commit `c7a502de6e`, NOT introduced by Batch 67):

1. **`packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts:3780`** — `stats.performance = this._performanceManager.frameTimings;` fails TS2322. The `FrameTimings` type lacks an index signature so it doesn't satisfy `DebugStatsObject`. Fix is one of: (a) add `[key: string]: number | Record<string, number>` to the `FrameTimings` interface, or (b) widen the assignment via cast / type guard. (a) is the right fix — `frameTimings` is genuinely a record by design.
2. **`packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts:2643`** — `executeInvertClassificationComposite(..., sceneAttachmentView, ...)` fails TS2345 because `sceneAttachmentView` is typed `GPUTexture | GPUTextureView` (the `view` field on the color attachment can be either) and the callee accepts only `GPUTextureView`. Fix is to narrow at the call site (`'createView' in v ? v.createView() : v`) or tighten the upstream `view` typing.

`npx tsc --noEmit` from the repo root **passes clean** (different tsconfig); the engine-package tsconfig is stricter. Until these two are fixed, `Build/CesiumUnminified/` will stay stale and any Sandcastle / Playwright run hits the pre-Batch-67 bundle. **First-priority next-session work** — both fixes are ~5 minutes each. (Resolved in Batch 68.)

## Quick state-of-migration (as of Batch 67)

- **~95% WebGL feature parity.** Full per-batch detail in REVIEW_FIX_PROGRESS.md; per-issue status in the principal review.
- **Critical-tier review work (C-R prefix):** all 13 originally-OPEN parent findings now have at least first-cut implementations shipping. Remaining work is named-follow-up scope, all enumerated in DEFERRED_WORK.md.
- **NEW-4 status (Sandcastle WebGPU baseline):** NEW-4-A FIXED (Batch 67, eager typed-array retention in `GltfLoader.loadVertexAttribute`). NEW-4-D FIXED (Batch 67, `Texture3D` constructor short-circuits to `WebGPUTexture3D` via JS constructor return-value semantics). NEW-4-E unblocked but **live diagnostic still pending** — the engine build break above prevented the fresh Voxel-demo Playwright capture this session. Predicted root cause + candidate fixes are documented inline in DEFERRED_WORK.md.
- **Sandcastle baseline:** 5/7 PASS on real WebGPU after Batch 67 (was 3/7 before NEW-4-A). The two remaining failures are NEW-4-E (Voxel) and Translucent Classification.
- **Active background agents this rollup (5):** soft point-light shadows (Batch 62) + doc rollup (Batch 63) ran as one focused session; the parallel agent fleet from earlier in 2026-04-25 had already shipped C-R8-EDGE-INLINE/FEATURE-ID (Batch 48), C-R8-EDGE-ID-FORMAT (Batch 49), C-R8-EDGE-COMPOSITE-PRUNE (Batch 50), C-R8-EDGE-INLINE-PRIMITIVES resolved-not-needed (Batch 51), C-R7 audit + correction (Batch 52), C-R9-VOXEL-PICK (Batch 53), C-R9-MODEL-PICK (Batch 54), C-R11-EFFECTS-BGL-COLLECTION-CACHE (Batch 55), C-R7-RENDERER-MIGRATION first cut (Batch 56), C-R10-POINT-LIGHT-RECEIVE (Batch 57), the migration oversight audit (b842a0dfbf), and C-R8-TRANSLUCENT-DEPTH-MSAA (Batch 61). Batch 67 ran two parallel worktree agents (NEW-4-A, NEW-4-D); both landed.
- **Last commit before this rollup:** `eee6679f8f Batch 57 — C-R10-POINT-LIGHT-RECEIVE: cube depth sampling for point-light shadows`. Working tree had ~70 modified files from prior batches awaiting their own rollup commits when the doc rollup started; those carry forward.
- **TSC status:** root `npx tsc --noEmit` clean (0 errors). Engine-package `tsconfig.json` (used by gulp build) has 2 pre-existing failures — see "Build is broken" above.

## What Batch 67 landed (this session)

### Engine fixes (both shipped, both tsc-clean at root tsconfig)

- **NEW-4-A — EdgeVisibilityPipelineStage WebGPU readback** ([packages/engine/Source/Scene/GltfLoader.js](../packages/engine/Source/Scene/GltfLoader.js), [packages/engine/Source/Scene/Model/EdgeVisibilityPipelineStage.js](../packages/engine/Source/Scene/Model/EdgeVisibilityPipelineStage.js))
  - Architecture choice **(b)** — eager retention at upload — over (a) async pipeline-stage refactor. (a) would have cascaded async return through `ModelSceneGraph.buildRenderResources` → `buildDrawCommands` → `Model.update` → render loop (multi-session work). (b) reuses the pre-existing `loadIndices` retention pattern with two narrow edits.
  - `loadVertexAttribute` adds a fourth `loadTypedArray` reason: `loadTypedArrayForEdgeVisibilityWebGPU = hasEdgeVisibility && frameState.context.isWebGPU === true`. Per-primitive scope; primitives without `EXT_mesh_primitive_edge_visibility` keep paying zero CPU-memory cost.
  - `EdgeVisibilityPipelineStage.process` gained a defensive guard: if running on WebGPU and `positionAttribute.typedArray` is undefined, log a permanent `console.error` and bail cleanly. Safety net for future loader regressions.
  - **Sandcastle:** Edge Visibility + Edge Feature ID demos flipped FAIL → PASS, runner total 3/7 → 5/7.

- **NEW-4-D — Texture3D constructor on WebGPU contexts** ([packages/engine/Source/Renderer/Texture3D.js](../packages/engine/Source/Renderer/Texture3D.js))
  - 12-line WebGPU dispatch at top of constructor: `if (context.isWebGPU) { return new WebGPUTexture3D(options); }`. JS constructor return-value semantics replace `this` with the returned WebGPU instance, so every caller (`Megatexture.js`, future volumetric features) gets the right backend with zero call-site changes.
  - Webgl-only build variant remains correct: `WebGPUTexture3D` import resolves to `emptyModule.js` (Proxy that throws on instantiation), and the dispatch is gated on `isWebGPU` which is false in those builds. **Not added to `WEBGPU_COMPAT_EXEMPTIONS`** — it stays on the Proxy side.
  - **Verification:** `npx tsc --noEmit` clean. Live Sandcastle Voxel-demo run **deferred** because the engine build break above prevented the fresh bundle. NEW-4-E live diagnostic capture is therefore also deferred.

### NEW-4-E status (deferred to next session)

NEW-4-D unblocks the path — the Voxel demo now reaches `WebGPUVoxelRenderer.update()` and the WGSL pipeline-build step. Predicted root cause from worktree analysis: WGSL `discard` does NOT terminate function control flow (unlike GLSL), so the two `if (...) { discard; }` early-outs in `fragmentMain` (lines 91 and 110) leave naga unable to prove the function returns on every path. **Predicted fix:** pair each `discard;` with `return vec4<f32>(0.0);`. Full analysis and the second candidate fix are inline in [DEFERRED_WORK.md](DEFERRED_WORK.md) NEW-4-E entry.

**Why not landed this session:** the engine build break (FrameTimings + GPUTextureView) prevented producing a fresh `Build/CesiumUnminified/` that includes the NEW-4-D dispatch. Without that, the Voxel demo still trips the old `WebGL1 does not support texture3D` throw before reaching the WGSL pipeline. Live capture requires those two engine-tsconfig errors fixed first.

### Doc updates

- [WEBGPU_DEBUGGING_LOG.md](WEBGPU_DEBUGGING_LOG.md) — new "Session 39 — Batch 67" entry covering both NEW-4-A and NEW-4-D with full root-cause / fix / files-touched narrative.
- [DEFERRED_WORK.md](DEFERRED_WORK.md) — NEW-4-A + NEW-4-D struck through and marked FIXED (Batch 67); NEW-4-E updated with predicted-root-cause analysis labeled "predicted, not live-captured."
- This file (NEXT_SESSION_HANDOFF.md) — header refreshed, build-break flag prepended, Batch 67 narrative inserted above the prior Batch 63 + Batch 64 content.

## What Batch 63 + Batch 64 landed (prior rollup)

### Batch 63 — Soft point-light shadows via 5-tap PCF

Closes the soft-shadow follow-up that Batch 57 explicitly reserved (`pointLightPositionWC.w` slot). 5-tap cross-pattern PCF kernel in `samplePointShadow` of `ModelPBRComplete.wgsl` — center sample plus four perturbed taps along the two minor cube-face axes (the axes that AREN'T the dominant face axis). Keeps all 5 samples on the same cube face's depth texels so face seams don't band the shadow edge. UBO size unchanged (336 bytes — `pointLightPositionWC.w` was reserved-for-soft-radius from Batch 57). `radius=0` falls through to the single-tap hard path bit-exact to Batch 57; `shadowMap.softShadows = true` auto-resolves to a 1.5-texel radius via `WebGPUEffectsBindGroup.js`'s auto-detect path. Cube-face edge length now flows through `effects.shadowMapSize.x` so the kernel can scale `radius_texels` by `1.0 / shadowMapSize.x` → unit-direction perturbation magnitude. Files: `Shaders/WebGPU/Model/ModelPBRComplete.wgsl` (+ regenerated `.js` wrapper), `Renderer/WebGPU/WebGPUEffectsBindGroup.js`. TSC clean.

### Batch 64 — Doc rollup + DEFERRED_WORK.md inventory

- **New canonical inventory at [DEFERRED_WORK.md](DEFERRED_WORK.md)** — 14 named C-R follow-ups grouped by parent finding, each with What / Why / Prerequisites / Effort / Impact / Trace fields. This is the stable pick-list for next sessions; each entry's identifier survives renumbering as items ship.
- **`WEBGPU_MIGRATION_BACKLOG.md`** "Last Updated" header refreshed to 2026-04-25; new "Recent activity Batches 28-63" section summarizes the 36-batch burst.
- **This file (`NEXT_SESSION_HANDOFF.md`)** — header refreshed; old 2026-04-20 content preserved below as historical context.

## Recommended next session pick-list

**Tier 0 — unblockers for Batch 67 verification (do these first, ~10 min combined):**

1. **Fix `WebGPUContext.ts:3780` FrameTimings index signature** — add `[key: string]: number | Record<string, number>` to the `FrameTimings` interface so it satisfies `DebugStatsObject`.
2. **Fix `WebGPUSceneRenderer.ts:2643` GPUTextureView narrowing** — narrow `sceneAttachmentView` at the call site (`'createView' in v ? v.createView() : v`) or tighten the upstream `view` typing on the color attachment.
3. **Rebuild and capture NEW-4-E naga error** — `npx gulp build`, then `node Tools/visual-regression/sandcastle-batch-66-final-runner.mjs` — capture the Voxel demo's actual naga error from the console output. Compare against the predicted root cause in DEFERRED_WORK.md NEW-4-E.
4. **Land NEW-4-E fix** — apply candidate (a) `discard; return vec4<f32>(0.0);` (preferred — preserves existing semantics) or (b) replace `discard;` with the return outright. ~5 minutes once the diagnostic is confirmed. Sandcastle baseline should flip 5/7 → 6/7 PASS (Translucent Classification is the remaining failure).

**Tier 1 — highest-impact deferred work** (pulled from [DEFERRED_WORK.md](DEFERRED_WORK.md) § Cross-cutting priority guide):

1. **`C-R5-IMAGERY-16` (parent finding, not yet carved into named follow-up)** — biggest single visual-correctness gap remaining. Multi-point change but bounded; per the oversight audit (`OVERSIGHT_AUDIT_2026_04_25.md` §2) this is the highest-impact unfixed correctness bug.
2. **`C-R8-TRANSLUCENT-MULTI-FRUSTUM`** — multi-frustum scenes misclassify primitives at frustum splits. Common in production scenes whenever camera height crosses a logarithmic frustum boundary. 2 sessions.
3. **`C-R7-RENDERER-MIGRATION-REMAINING`** + **`C-R7-SHADER-MODULE-DEDUP`** — mechanical pass; 12 renderers + ModelRenderer routing through `context.webgpuPipelineCache`. ~3-4 sessions, no design risk.
4. **`C-R4-GLTF-KHR`** — its own multi-week workstream. `KHR_texture_transform` is the highest-impact single extension to start with.

(Pre-rollup scratch state below this point — kept for traceability.)

---

## Pre-rollup handoff (2026-04-20 — Sessions 35 + 36)

**Session 36 uncommitted changes (rollup through 2026-04-20):**

- `packages/engine/Source/Core/Resource.js`, `packages/engine/Source/Renderer/*.js` — not touched this session (carry-over)
- `packages/engine/Source/Renderer/WebGPU/WebGPUCSMRenderer.ts` — **BUG-36.1 fix** (split/bias offset)
- `packages/engine/Source/Renderer/WebGPU/WebGPUGaussianSplatRenderer.ts` — **C-P15** modelView covariance rotation
- `packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js` — **Water time hookup**: new `getFrameTime()` helper; `writeRTEUniformsFlat`/`writeRTEUniformsLit` now pack `frameState.frameNumber` into the float-23 (Flat) / float-55 (Lit) pad slots of the camera UBO
- `packages/engine/Source/Scene/MaterialUniformBuffer.js` — **BUG-36.2 Option B**: `channel`/`channels` string classification, `_channelCharToIndex`/`_channelIndexToChar` helpers, fixed vec3-trailing-pad over-pad bug in `_buildLayout`, read-facade round-trip for channel shorthand
- `packages/engine/Source/Scene/OpenStreetMapImageryProvider.js`, `packages/engine/Source/Scene/TileMapServiceImageryProvider.js` — **ES6 class migration** (extends `UrlTemplateImageryProvider` via `super()` instead of legacy `.call(this, …)`)
- `packages/engine/Source/Shaders/WebGPU/Advanced/GaussianSplat.wgsl` — **C-P15** matching source-of-truth update
- `packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveMat*Lit.{wgsl,js}` × 17 files — **CSM Slice 2d** Material Lit receivers (+ regenerated `.js` wrappers via `wgslToJavaScript`)
- `packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveMat{AlphaMap,BumpMap,SpecularMap,NormalMap,EmissionMap,Image,ElevContour,Fade,Stripe,Water}{Flat,Lit}.{wgsl,js}` × 20 files — **BUG-36.2** fabric-order struct rewrites + channel-packing wiring; Water additionally reads `camera.time` for animated wave phase
- `packages/engine/Specs/Core/IonResourceSpec.js` — legacy `spyOn(Resource, "call")` replaced with direct property checks
- `packages/engine/Specs/Renderer/WebGPU/WebGPUCSMRendererSpec.js` — new regression spec for the CSMParams offset packing
- `packages/engine/Specs/Renderer/WebGPU/WebGPUEffectsBindGroupCSMLayoutSpec.js` — spec comment updated to the correct offsets
- `packages/engine/Specs/Scene/MaterialUniformBufferSpec.js` — **new spec** covering channel-string packing, vec3+f32 tail-slot layout, and fabric orderings for AlphaMap / BumpMap / Image / Checkerboard / Fade / EmissionMap / NormalMap (13 tests; all pass via Node smoke run)
- `migration_doc/WEBGPU_DEBUGGING_LOG.md` — appended BUG-36.1 writeup + BUG-36.2 catalog/resolution
- `migration_doc/WEBGPU_MIGRATION_BACKLOG.md` — Material UBO Option B section rewritten (was stale)
- `migration_doc/_regen_wgsl_js.py`, `migration_doc/_verify_wrappers.py` — helper scripts for regenerating/verifying WGSL `.js` wrappers outside a full `gulp build`; left in-tree for future session reuse
- `C:\Users\Kurt\.claude\projects\f--Dev-GH-cesium-webgpu\memory\session_handoff_csm_taa.md` — Slice 2d marked complete

**Session 35 commits (already on `origin/main`):**

- `332a8efac2` — Resource URL fix + variant smoke-test reliability + DecoupledScan wiring
- `852b4affd7` — Docs: stale-spec findings (IonResource + ImageryProvider specs)
- `c7a502de6e` — WIP checkpoint bundling months of prior-session carry-over (CSM + TAA + aerial LUT + build variants + naga-wasm + WebGPU stubs overhaul + DecoupledScan consumer wiring)

**Build:** `npx gulp buildAllVariants` produces three side-by-side bundles (dual 7.1 MB / webgl-only 5.6 MB / webgpu-only 6.4 MB minified IIFE). Dual still writes to the historical `Build/Cesium{Unminified}` paths.
**`tsc --noEmit`:** clean (0 errors) as of the latest change.
**Variant smoke test:** all 3 variants PASS (`node Tools/variant-smoke-test.mjs`) per Session 35.
**BUG-36.2 regression:** [MaterialUniformBufferSpec.js](../packages/engine/Specs/Scene/MaterialUniformBufferSpec.js) covers channel-string packing, vec3+f32 tail-slot layout, and fabric orderings for AlphaMap / BumpMap / Image / Checkerboard / Fade / EmissionMap / NormalMap. Browser (Karma) spec run is still needed in CI; an in-session Node smoke test of 56 layout assertions across the same surface passed 56/56.
**.js ↔ .wgsl wrapper sync:** `python migration_doc/_verify_wrappers.py` — **38/38 in sync**.

This doc supersedes the prior 2026-04-16 handoff but **preserves it in full below** — this is a delta on top of it. Read the principal-engineer review at [PRINCIPAL_ENGINEER_REVIEW_2026_04_16.md](PRINCIPAL_ENGINEER_REVIEW_2026_04_16.md) first if you need arch context on lifecycle fixes; the entries below are session-34+ work that builds on that foundation.

---

## Session 36 (2026-04-19) — what landed

### BUG-36.1 — CSM UBO packer offset mismatch (CRITICAL pre-existing bug)

Discovered during a re-audit of the CSM Slice 2d Lit receivers: [WebGPUCSMRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUCSMRenderer.ts) was writing `cascadeSplits / blendBands / cascadeMinBias / cascadeMaxSlopeBias` into `_cascadeParamsData` at float offsets **256 / 260 / 264 / 268**, but the WGSL `CSMParams` struct's natural std140-style layout places them at **64 / 68 / 72 / 76**. A 192-float (768-byte) gap sat between where the JS wrote and where the shader read.

**Consequence (shipping since Session 32/33, 2026-04-13):** every CSM consumer has been reading `(0, 0, 0, 0)` for splits and biases.

- `selectCascade(viewDepth, (0,0,0,0))` always returned `3u` (fallthrough — `viewDepth < 0` is false for all valid depths). Cascade 3 (farthest, lowest-resolution) was used for every pixel.
- `cascadeMinBias[3] = 0`, `cascadeMaxSlopeBias[3] = 0` — no depth bias, so shadow acne at grazing angles was unmitigated.
- CSM silently degraded to single-cascade-at-farthest mode with no bias. This is exactly why Tier-1 item 3 "Visual smoke test" in the prior handoff stayed `STILL PENDING` — nobody had looked closely enough to see near-camera shadows were coarse.

**Fix:** single-file change to the writer offsets in `WebGPUCSMRenderer.ts` (256/260/264/268 → 64/68/72/76). Shader struct, placeholder buffer, bind-group layout, and allocation all stay unchanged — only the JS writer moves. Buffer size stays 1088 bytes (256-aligned); bytes beyond the 320-byte shader-visible struct are unwritten zeros the shader never reads.

**Stale spec comment also fixed.** [WebGPUEffectsBindGroupCSMLayoutSpec.js](../packages/engine/Specs/Renderer/WebGPU/WebGPUEffectsBindGroupCSMLayoutSpec.js) had re-encoded the wrong offsets (that's why specs passed under the bug). The comment now documents the correct WGSL-natural layout.

**New regression spec.** [WebGPUCSMRendererSpec.js](../packages/engine/Specs/Renderer/WebGPU/WebGPUCSMRendererSpec.js) gained a `describe("CSMParams UBO pack — WGSL float offsets")` block that drives `computeCascadeVPs` end-to-end and asserts:

- floats 64..67 (splits), 68..71 (blendBands), 72..75 (minBias), 76..79 (maxSlopeBias) are all populated
- floats 256..271 (old buggy positions) stay zero

This will catch any drift back to the old layout.

**Scope:** the fix transparently unblocks every CSM consumer without per-shader edits:

- `GlobeTerrain.wgsl`
- `PrimitivePhongColor.wgsl`, `PrimitivePhongTexturedColor.wgsl`
- `PrimitivePBRSimple.wgsl`, `PrimitivePBRTextured.wgsl`
- `ModelPBRComplete.wgsl`
- All 19 `PrimitiveMat*Lit.wgsl` variants (including the 17 added in this session)

Full writeup in [WEBGPU_DEBUGGING_LOG.md § BUG-36.1](WEBGPU_DEBUGGING_LOG.md).

### CSM Slice 2d Material Lit receivers — all 19 variants complete

The 17 `PrimitiveMat*Lit.wgsl` variants that previously lacked CSM now carry the full receiver pattern. Pre-existing references were `PrimitiveMatColorLit.wgsl` (no-texture, effects at `@group(2)`) and `PrimitiveMatImageLit.wgsl` (textured, effects at `@group(3)`).

- **No-texture (effects at `@group(2)`, 7 total):** ColorLit (pre-existing reference), Checker, Dot, Fade, Grid, Stripe, RimLighting, ElevContour
- **Textured (effects at `@group(3)`, 12 total):** ImageLit (pre-existing reference), AlphaMap, EmissionMap, SpecularMap, BumpMap, NormalMap, Water, ElevRamp, SlopeRamp, AspectRamp, ElevBand

All gate CSM on `effects.csmControl.x > 0.5`. Ambient stays unshadowed in every variant so fill light is preserved in shadowed regions. `Bump/Normal/Water` route the perturbed normal into `computeShadowFactorCSM` so the bias matches the lit normal. `RimLighting` keeps the rim term unshadowed (non-physical artistic effect). `ElevContour` shadows before the contour alpha is applied, so shadowed contour lines still render. 20th variant (`PrimitivePickMatLit`) intentionally excluded — pick shaders don't consume shadow data.

`.js` wrappers regenerated for all 17 via a direct `wgslToJavaScript(false, 'Build/minifyShaders.state', 'engine')` call (no full `gulp build` needed). `tsc --noEmit` clean.

### C-P15 — Gaussian splat modelMatrix rotation

Fixed the long-deferred splat bug where `modelMatrix` rotation/scale was ignored. Implemented `R * Σ * R^T` view-rotation of the 3D covariance before the screen-space Jacobian in both [GaussianSplat.wgsl](../packages/engine/Source/Shaders/WebGPU/Advanced/GaussianSplat.wgsl) and the inline `SPLAT_WGSL` in [WebGPUGaussianSplatRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUGaussianSplatRenderer.ts). Splats now correctly follow `modelMatrix` rotation, scale, and shear.

No new uniform needed — the existing `modelViewRelativeToEye` has its translation column zeroed CPU-side, so its 3x3 block IS the rotation×scale we want. This deviates from the principal-engineer review's suggestion to add a `modelRotation` uniform, but is strictly equivalent math and avoids a uniform-layout bump.

**Also repaired a pre-existing `c01` typo** where `c` and `e` were swapped between the `J11` / `J12` coefficient slots. Subtle error only visible on highly anisotropic splats (the common case — most splat datasets have near-isotropic covariance). Re-derived `(J Σ J^T)_01 = J00·J11·b + J02·J11·e + J00·J12·c + J02·J12·f` from first principles; the existing code had `J00·J12·e + J02·J11·c` in those two positions.

### IonResourceSpec fix (legacy `spyOn` pattern)

Replaced `spyOn(Resource, "call").and.callThrough()` + `expect(Resource.call).toHaveBeenCalledWith(...)` with direct property assertions (`resource.url`, `resource.retryCallback`, `resource.retryAttempts`). The old assertion relied on pre-ES6-class behavior where `Resource.call(this, options)` was invoked from a constructor-function subclass; after the ES6-class migration, `IonResource extends Resource` calls `super(options)` instead and the spy never triggers.

26/26 IonResource tests now pass. No runtime behavior change.

### Material UBO Option B backlog doc — stale section rewritten

[WEBGPU_MIGRATION_BACKLOG.md § Material UBO Architecture (Option B)](WEBGPU_MIGRATION_BACKLOG.md) was marked "IN PROGRESS" with items like "WebGPUPolylineRenderer refactor: Not started" — but Session 28 (2026-04-13) actually shipped the split layout, Polyline refactor, and texture-group shift. Rewrote the section to reflect current reality: the layout is live in production, the only remaining work is a `~1 day` material-by-material field-name audit (verify each `MaterialUniforms` struct against its `Material.js` fabric definition) and a `~1 day` visual verification pass across 25 material types.

### Item 6 partial — OSM + TileMapService imagery providers modernized to ES6 classes

`OpenStreetMapImageryProvider` and `TileMapServiceImageryProvider` were pre-ES6 constructor-functions calling `UrlTemplateImageryProvider.call(this, options)` — an ES6 class. That call throws `Class constructor X cannot be invoked without 'new'` at runtime, which is why their specs fail.

Both rewritten as `class X extends UrlTemplateImageryProvider { constructor(options) { super(...); } }`. Removed the `Object.create(prototype)` chains and the unused `defined` import. Static methods (`fromUrl`, `_metadataSuccess`, `_metadataFailure`, `_requestMetadata`) left as-is — they still work as class-level property assignments, and tossing them into the class body would expand the diff without gain.

`npx tsc --noEmit` is clean. Spec runtime verification still requires a browser (Karma) session.

**Correction to the Session 35 finding:** ArcGisMapServerImageryProvider source is **already** an ES6 class with no `.call(this, ...)` invocations. Its spec may still fail for a different reason — needs a browser-run diagnosis, not a mechanical constructor fix. Updated Item 6 below accordingly.

### BUG-36.2 (Material UBO packer vs WGSL struct drift) — DONE (Option B)

Cross-checked [Material.js](../packages/engine/Source/Scene/Material.js) fabric `uniforms` declaration order against the WGSL `struct MaterialUniforms` order for every distinct material type. [MaterialUniformBuffer.js](../packages/engine/Source/Scene/MaterialUniformBuffer.js) `._buildLayout` packs numeric fields in fabric declaration order, so fabric order ↔ WGSL struct order is what governs whether the shader reads the right bytes at runtime. 10 material types × 2 (Flat+Lit) = 20 shaders had silent layout mismatches.

**Option B implementation landed in this session** — detail in [WEBGPU_DEBUGGING_LOG.md § BUG-36.2](WEBGPU_DEBUGGING_LOG.md):

- `MaterialUniformBuffer` extended to pack fabric `channel` / `channels` shorthand strings as numeric indices (r=0, g=1, b=2, a=3). Read-path round-trips back to the shorthand string.
- Separate latent packer bug fixed: `offset += 1` after vec3 over-padded. WGSL places an f32 into the vec3's 4-byte tail, so removing the pad makes `{ vec3, f32, … }` layouts line up. Safe for all existing vec3-followed-by-larger-type cases.
- All 20 shaders rewritten to match fabric declaration order:
  - **AlphaMap/BumpMap/SpecularMap** — runtime `channel: f32` + `extractChannel` helper.
  - **NormalMap/EmissionMap** — runtime `channels: vec3<f32>` + `swizzleChannel` helper.
  - **Image** — `{ repeat: vec2, color: vec4 }`.
  - **ElevationContour** — `{ spacing: f32, color: vec4, width: f32 }`.
  - **Stripe** — `{ horizontal: f32, evenColor: vec4, oddColor: vec4, offset: f32, repeat: f32 }`, shader logic brought in line with upstream `StripeMaterial.glsl`.
  - **Fade** — `{ fadeInColor, fadeOutColor, maximumDistance, fadeRepeat, fadeDirection: vec2, time: vec2 }`, mirrors `FadeMaterial.glsl` (per-axis animated time, optional repeat wrap).
  - **Water** — dropped the unused `time: f32` from `MaterialUniforms` (fabric never wrote it). Wave animation was subsequently wired through the camera UBO — see "Water time animation" below.
  - **NormalMap Flat** — fixed dangling reference to undeclared `normalTexture` (→ `normalMapTexture`).
- New spec: [MaterialUniformBufferSpec.js](../packages/engine/Specs/Scene/MaterialUniformBufferSpec.js). Locks in channel-string packing, vec3+f32 tail-slot layout, and fabric orderings for AlphaMap / BumpMap / Image / Checkerboard / Fade / EmissionMap. Any future drift fails the spec.

Clean-from-the-start types (unchanged): Color, Checker, Dot, Grid, RimLighting, ElevationRamp, ElevationBand (placeholder), SlopeRamp, AspectRamp.

**Water time animation (landed same session, additive):** The BUG-36.2 cleanup originally left Water rendering a static wave pattern because `material.time` was never plumbed through the UBO path. Rather than add a new per-material `time` field (wrong abstraction — `time` is per-frame, not per-material), the fix repurposes the existing `_pad1: f32` pad slot in the shared camera UBO as a per-frame `time` field.

- [WebGPUPrimitiveCommands.js](../packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js) — new `getFrameTime(uniformState)` returns `uniformState.frameState.frameNumber` (0.0 fallback). `writeRTEUniformsFlat` packs it at `ud[23]`; `writeRTEUniformsLit` at `ud[55]` (both previously wrote `0.0`).
- [PrimitiveMatWaterFlat.wgsl](../packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveMatWaterFlat.wgsl) / [PrimitiveMatWaterLit.wgsl](../packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveMatWaterLit.wgsl) — renamed `_pad1: f32` → `time: f32` in their local `CameraUniforms` struct. Fragment reads `let t = camera.time * material.animationSpeed;` (matches upstream `Water.glsl`'s `czm_frameNumber * animationSpeed`).
- **Zero blast radius.** No UBO size change. All other Flat/Lit shaders still declare `_pad1: f32` at the same byte slot and ignore the written value — grepped `Source/Shaders/WebGPU/**` for `camera._pad0/_pad1/_pad2/_pad3` reads and found **zero** hits. The writer's value change from `0.0` to `frameNumber` is invisible to them.
- Node smoke-test across the full Session 36 work (56 layout assertions) passes 56/56; `npx tsc --noEmit` clean; all 38 `PrimitiveMat*.js` wrappers in sync with their `.wgsl`.

---

## Next session — priorities after Session 36

### Item 1 — Visual smoke test for CSM (HIGHEST PRIORITY, unblocked by BUG-36.1)

Now that the UBO packing bug is fixed, cascaded shadow maps should ACTUALLY cascade for the first time since Session 32. Before more CSM work lands on top, capture before/after evidence:

1. Start dev viewer, enable `scene.useCascadedShadowMaps = true`
2. Standard test scene: a few buildings + terrain + midday sun
3. Verify:
    - Cascade 0 (nearest) shows sharp shadow edges on building faces a few meters from camera
    - Cascade 3 (farthest) covers the horizon terrain at reasonable quality
    - No visible banding at the cascade blend bands (`smoothstep(blendStart, splitDist, viewDepth)` blend is now actually fed non-zero `splitDist` + `blendBand`)
    - No shadow acne at grazing angles (per-cascade `cascadeMinBias` + `cascadeMaxSlopeBias` are now actually non-zero)
4. Run the regression spec: `npm test -- --filter WebGPUCSMRendererSpec` — the new `CSMParams UBO pack — WGSL float offsets` block should pass, and it will catch any future drift.

If shadows look wrong, the most likely causes (in order): cascade sphere radii → VP matrix construction, cascade splits distribution (`computeSplits`), receive-side shader cascade selection.

### Item 2 — Lit CSM receiver visual verification (follow-on from Item 1)

The 17 new Lit receivers all compile, type-check, and route bind groups correctly — but none have been seen rendering CSM'd shadows. Build a minimal visual regression scene in [Tools/visual-regression/scenes.json](../Tools/visual-regression/scenes.json) that instances each material type (or at least one per lighting-decomposition pattern) on a shadowed surface. Verify:

- Ambient term remains at its baseline even inside shadowed regions
- Direct diffuse + specular drop by `shadowDarkness` where cascade sampling says occluded
- RimLighting: rim stays bright in shadow (correct — it's non-physical)
- ElevContour: contour lines still draw in shadow (alpha preserved across shadowing)
- Bump/Normal/Water: shadow bias uses the perturbed normal so grazing-angle acne stays low

### Item 3 — Aerial-LUT visual verification (carried over from prior handoff)

Still pending. The aerial-perspective LUT rollout touched 6 shaders (`PrimitivePhongColor`, `PrimitiveMatColorLit`, `PrimitiveMatImageLit`, `PrimitivePBRSimple`, `PrimitivePBRTextured`, `ModelPBRComplete`) and compiles clean, but no visual regression has been run. Order of likelihood to surface issues: PBR variants first (tonemap+gamma ordering is the most delicate), then `ModelPBRComplete` (different input geometry — `rteMC` + `modelMatrix` instead of `eyePosition`), then the simpler Phong/Lit shaders.

Pair with Item 2's scene setup so the fog + CSM interaction is seen together.

### Item 4 — TAA Slice 2b — per-model MRT motion vectors

Ghosting on animated glTF (skinned/morphed/instanced) is real but narrow. Requires a second color attachment on every model pipeline + a previous-frame joint/morph/instance UBO layout. Multi-session effort; defer until visual verification of Items 1-3 is complete.

### Item 5 — Visual verification of Session 36 material fixes

**BUG-36.2 Option B + vec3-pad fix + Water time animation all landed this session** (see Session 36 rollup above and [WEBGPU_DEBUGGING_LOG § BUG-36.2](WEBGPU_DEBUGGING_LOG.md)). The new [MaterialUniformBufferSpec.js](../packages/engine/Specs/Scene/MaterialUniformBufferSpec.js) covers the JS packer side (56 assertions, Node smoke test green), but no pixel-level visual test has run on any of the 20 fixed shaders. Candidates for a Sandcastle demo (pair with Item 1's CSM scene):

- **AlphaMap, BumpMap, SpecularMap** — should now read the fabric-specified `channel` string dynamically (not silently grayscale from `.r`).
- **NormalMap, EmissionMap** — should now swizzle per-texel using the fabric-specified `channels` string (not silently `(r, r, r)`).
- **Image** — no more `color.rg` leakage from the reordered `{ repeat, color }` struct — base-color tint should be white when default, not tinted by `repeat.xy`.
- **ElevationContour, Stripe** — fabric fields now land in the correctly-named WGSL slots (spacing no longer bleeds into `color.r`; stripes actually alternate `evenColor`/`oddColor`).
- **Fade** — per-axis `fadeDirection.xy` + `time.xy` now reach the shader; gradient should animate correctly.
- **Water** — wave phase should animate frame-to-frame via `camera.time * animationSpeed` (was frozen before this session).

### Item 6 — ArcGisMapServerImageryProvider spec (OSM + TMS now DONE)

**Updated** — OSM + TileMapService were fixed in Session 36 (source-level, not spec-level: they were pre-ES6 constructor-functions that called an ES6 superclass via `.call(this, ...)`). ArcGis source was already ES6. Remaining work: run the ArcGis spec in a browser and capture the real failure — it's not the same root cause. Budget: 30-60 min to identify + mechanically fix.

### Item 7 — `@private` → `@internal` JSDoc sweep (per principal-engineer review §6d)

Low-risk, mechanical. WebGPU directory is already clean (Session 35 finding); the sweep outside `Renderer/WebGPU/` hasn't been assessed. ~2-3 hours.

### What NOT to do next

- **Do not pursue TAA Slice 2b** until Items 1-3 visual verification is done. Building per-model motion on top of an unverified rendering pipeline multiplies the surface area of unknowns.
- **Do not start full GLSL→WGSL runtime translation** via naga-wasm yet. Scaffolding is in place but pipeline materialization for translated programs is a multi-session effort. Park until a consumer needs it.
- **Do not modernize upstream-pristine files** (ES6 Phase D). Merge-friction cost exceeds benefit until a feature touches them.

### Stale / superseded items from the prior "Next session — recommended order" (below in this doc)

- **Prior Item 1 (Run the variant smoke test)** — **DONE** already; all 3 variants PASS per Session 35 evidence.
- **Prior Item 3 (Wire DecoupledScan into point cloud LOD)** — **DONE in Session 35**; see the "FEAT-SURVEY-06 first consumer wired" section below.
- **Prior backlog item (IonResourceSpec stale)** — **DONE this session** (see Session 36 rollup above).

---

## Session 35 (2026-04-19) — what landed

### Resource URL regression repair

`packages/engine/Source/Core/Resource.js` — fixed two bugs introduced by the earlier ES6 modernization of `parseUrl`:

- Relative URLs against a baseUrl were resolving to root-relative paths, which then DISCARDED the base's path during later URL resolution. `buildModuleUrl("Assets/foo")` against `CESIUM_BASE_URL = "/Build/Cesium/"` was returning `/Assets/foo` (wrong) instead of `/Build/Cesium/Assets/foo`. This broke every app with a subpath base URL.
- `data:` and `blob:` URIs were being reconstructed from `origin + pathname`. `URL().origin` is `"null"` for data URIs, producing garbage like `nullimage/png;base64,...`. Both schemes now stored verbatim.

**Coverage:** Core/Resource spec — 119/119 pass.

### Variant smoke test finally reliable

`Tools/variant-smoke-test.mjs` rewritten to be runnable end-to-end:

- Uses `Viewer.createAsync()` for the webgpu path (the sync `new Viewer()` always returns a WebGL context — CesiumWidget architectural constraint).
- Enables `--enable-unsafe-webgpu` in headless Chromium so the webgpu variant actually gets a WebGPU device.
- Re-binds `CESIUM_BASE_URL` via `buildModuleUrl.setBaseUrl()` after bundle load so absolute-URL base is deterministic.
- Logs failed request URLs so 404s diagnose themselves.

**Result:** all 3 variants PASS with zero console errors across 5 render frames.

### FEAT-SURVEY-06 first consumer wired

DecoupledScan now has a real consumer in the codebase:

- New WGSL shader `Shaders/WebGPU/Compute/PointCloudLODScanCompact.wgsl` — `tagVisible` + `compactScanned` entry points sharing `LODParams` with `PointCloudLOD.wgsl`.
- `WebGPUPointCloudLODProcessor` gained an opt-in `useDecoupledScan: true` path: tag → scan → compact → `copyBufferToBuffer(prefix[N-1] → visibleCount[0])`. Produces deterministic output ordering (`visibleIndices` sorted by original point index). Atomic-add stays the default.
- `WebGPUContextOptions.useDeterministicPointCloudLOD` plumbed through to the lazy `context.pointCloudLOD` getter so apps opt in at context construction.
- New spec `WebGPUPointCloudLODProcessorSpec.js` — 7 tests covering both paths (mock-device harness, pattern-match with `WebGPUDecoupledScanSpec`).

### Backlog: stale-spec findings

`migration_doc/WEBGPU_MIGRATION_BACKLOG.md` — new "Session 35 findings" section. Two items:

- **IonResourceSpec** test `"constructs with expected values"` is stale after ES6 class migration — spies on `Resource.call(this, ...)` which no longer happens under `extends Resource`. Spec-only fix. 25/26 IonResource tests pass; this one fails.
- **3 ImageryProvider specs** (ArcGis / OSM / TileMapService) fail with `Class constructor X cannot be invoked without 'new'` — same root cause. Pre-existing, unrelated to this session.

### Item 4 assessment — "pick a deferred item"

After examining the deferred list, none of the four suggested items fit a clean session tail:

- **TAA Slice 2b** (per-model MRT motion for skinned/morphed/instanced) — multi-file, not a tail-sized deliverable.
- **BUG-3 2D/Columbus View WebGPU collections (C-P10)** — 6 collection shaders + primitive shaders need the morph/CV branch; substantial shader-family change.
- **§6d `@private` → `@internal` sweep** — already clean in the WebGPU directory. Grepped all 79 TS/JS files; only 3 JSDoc `@private` tags sit on non-`private`-declared methods (`WebGPUModelPipelineCache._createDefaultTexture`, `._createDefaultVertexBuffer`, `WebGPUDevicePool._resetInstance`). Verified: none are called cross-class. The review's "5 methods in WGSLShaderPreprocessor" must have been cleaned up in an earlier pass. **No action needed for the WebGPU directory; sweep outside the directory not yet assessed.**
- **ES6 modernization — WGSLShaderBuilder.js** — 696 lines, 3 pre-ES6 constructor-function classes (`WGSLStruct`, `WGSLFunction`, `WGSLShaderBuilder`) + 25 prototype assignments + `Object.defineProperties`. No spec exists. Modernizing without a safety net violates CLAUDE.md's "never modernize a file you're not otherwise touching" rule and risks silent shader-emission regressions. **Recommended flow: write a `WGSLShaderBuilderSpec` first (separate session), then modernize.**

### Commit landscape after Session 35 push

All prior-session carry-over (~100 files) was bundled into `c7a502de6e` during this session and pushed to `origin/main`. The working tree is clean apart from any post-push edits. Lint errors surfaced during the bulk commit were fixed in-place:

- `UniformStateComputations.js`: added curly braces on a single-line `for` loop (ESLint `curly` rule).
- `scripts/build.js`: removed dead `emptyStubPath` variable — the real stub path lives in `scripts/bundleVariantPlugin.js` as `STUB_SHADER`, which is where the actual redirect logic consumes it.
- `scripts/compileSlang.js`: `// eslint-disable-next-line no-unused-vars` on an intentionally-unused `_event` watcher arg.
- `packages/wasm-naga/test-*.mjs` (5 files): dropped unused shebangs — scripts are invoked via `node path.mjs`, not as installable bins.
- `eslint.config.js`: added `packages/wasm-naga/*.mjs` to the node-script scope so its test harnesses lint with Node globals.
- `lint-staged.config.js`: switched to functional-config form that filters out vendored paths (`**/ThirdParty/**`, `Tools/shader-pipeline/naga-wasm-tools/`, `packages/wasm-naga/pkg*/`) before running eslint/prettier/markdownlint.
- `.gitignore`: exclude `/tmp/` (ad-hoc debug scratch).

### Stash hygiene note

Six stashes exist on this machine. **Today's three** (`stash@{0}` 910218ee87, `stash@{1}` 7977c8f5b9, `stash@{2}` 63a2b61ffd) are lint-staged automatic backups from the failed-commit cycles that preceded `c7a502de6e`. All three are strict subsets of HEAD's content (verified — the differences are prettier/eslint-fix formatting only, no unique logic). They're safe to drop but left intact per user policy. **The three older stashes** (testing regression, WIP from 3/9, lint-staged backup from 3/8) pre-date Session 35 and haven't been audited.

---

## Post-Session-31 rollup — what landed since

The handoff below captures Session 31's principal-engineer-review fixes. A lot has landed on top in sessions 32-34 and the three immediately-following sessions. The important bits for continuity:

### TAA (shipped to Slice 2a)

- **Slice 1** (Session 34) — jitter + RTE motion vectors + depth reprojection + history blend + neighborhood AABB clamp. Works for static terrain + static primitives.
- **Slice 2a** — sky reprojection + teleport invalidation.
- Remaining: Slice 2b (per-model MRT motion for skinned / morphed / instanced), Slice 3 (YCoCg variance clipping + particles), Slice 4 (3D Tiles pop-in + picking un-jitter + CSM+TAA + WebGL parity). Each is independently deliverable. See [TAA_DESIGN.md](TAA_DESIGN.md).

### Aerial-perspective LUT rollout

- Reference pattern from [PrimitivePhongTexturedColor.wgsl](../packages/engine/Source/Shaders/WebGPU/Primitive/PrimitivePhongTexturedColor.wgsl) now replicated on: `PrimitivePhongColor`, `PrimitiveMatColorLit`, `PrimitiveMatImageLit`, `PrimitivePBRSimple`, `PrimitivePBRTextured`, and `ModelPBRComplete`. Each declares bindings 7/8/9 on its effects bind group (shared [WebGPUEffectsBindGroup.js](../packages/engine/Source/Renderer/WebGPU/WebGPUEffectsBindGroup.js) layout already had slots) and applies the `effects.atmosphereLutControl.x > 0.5` gate in `fragmentMain`.
- PBR variants apply the fog blend AFTER tonemap+gamma (display-space composite) to match the reference.
- ModelPBRComplete uses `camera.cameraPositionWC` + `material.modelMatrix * vec4(rteMC, 0.0)` instead of the primitive shaders' `encodedCameraHigh/Low` + `eyePosition`.
- **Status:** all 6 shader `.js` modules carry the gate; type-check + WGSL compile both clean. **Visual verification pending** — this is one of the three items recommended below.

### Build variants infrastructure

- Three variants produced by `npx gulp buildAllVariants`:
  - `Build/Cesium{Unminified}` — dual (WebGPU-first default). Historical path preserved.
  - `Build/CesiumWebGL{Unminified}` — WebGL-only (aliases `Source/Renderer/WebGPU/**` + `Source/Shaders/WebGPU/**` to empty stubs).
  - `Build/CesiumWebGPU{Unminified}` — WebGPU-only (aliases `Source/Shaders/*.js` GLSL strings to empty shader stub).
- Implementation:
  - [scripts/bundleVariantPlugin.js](../scripts/bundleVariantPlugin.js) — esbuild `onResolve` plugin with decision cache + synthetic path resolution. Exemption list (`WEBGPU_COMPAT_EXEMPTIONS`) keeps backend-neutral compat files (`WebGLCompatibilityStub`, `WebGPUShaderTranslator`, `WebGLStubPipelineExtractor`, `WebGPUNagaTranspiler`) resolvable in webgl-only builds.
  - [scripts/stubs/emptyShader.js](../scripts/stubs/emptyShader.js) — `export default ""` for GLSL string imports.
  - [scripts/stubs/emptyModule.js](../scripts/stubs/emptyModule.js) — Proxy that throws on access, explicit error pointing callers at contextOptions.renderer.
  - [Renderer/RendererType.ts](../packages/engine/Source/Renderer/RendererType.ts) — new `setGlobalDefaultRenderer()` / `getGlobalDefaultRenderer()`; entry barrels call it at module init.
  - Root [package.json](../package.json) `sideEffects` includes `"./Source/Cesium*.js"` so downstream bundlers don't tree-shake the default-renderer hint.
- ESM bundle gets `splitting: true` so `await import("./WebGPU/WebGPUContext.js")` in ContextFactory actually produces separate chunks (`Build/Cesium/chunks/WebGPUContext-*.js`). IIFE + CJS still inline because those formats don't support code splitting.
- **Performance:** `buildAllVariants` hoists `buildEngine` + `buildWidgets` so they run once, then uses a `buildCesiumVariantFast` path that skips worker / CSS / specs rebuild on variants 2-3 and copies shared assets from the dual output. Full `buildAllVariants` ≈ 1:20 on this machine.

### WebGL compatibility stub (Proton-style translation)

The stub under [Renderer/WebGPU/Stubs/](../packages/engine/Source/Renderer/WebGPU/Stubs/) went from "log no-op with a warning" to real WebGL→WebGPU translation for every layer except GLSL compilation:

- **Texture stub**: `createTexture` returns a pending wrapper; `texParameteri` + `pixelStorei` accumulate sampler/pixel-store state; `texImage2D` actually creates the `GPUTexture` (format picked from `internalformat`+`type`, mip chain sized from w/h, RENDER_ATTACHMENT usage set for later mipmap generation), uploads via `queue.writeTexture` (raw bytes, with manual row-flip for UNPACK_FLIP_Y_WEBGL) or `copyExternalImageToTexture` (ImageBitmap / HTMLImage / Canvas / Video / OffscreenCanvas); `generateMipmap` lazily instantiates `WebGPUMipmapGenerator` and dispatches real blit-down render passes on the active command encoder.
- **Shader stub**: `getParameter` answers 25+ WebGL constants from `device.limits` (MAX_TEXTURE_SIZE, MAX_VERTEX_ATTRIBS, MAX_COLOR_ATTACHMENTS, etc.) with plausible VENDOR/RENDERER/VERSION strings; `getExtension` returns non-null tag objects for 15 extensions whose features are in WebGPU core (OES_texture_float, OES_element_index_uint, ANGLE_instanced_arrays with the right method names, EXT_texture_filter_anisotropic with the anisotropy constants, etc.); GLSL compile path still a placeholder but a pluggable `WebGPUShaderTranslator` registry + lazy naga-wasm path landed for future runtime GLSL→WGSL.
- **Pipeline-state stub**: full stencil tracking added — `stencilFunc`/`stencilFuncSeparate` / `stencilOp`/`stencilOpSeparate` / `stencilMask`/`stencilMaskSeparate` with the WebGL→WebGPU op mapping (`GL_KEEP` → `"keep"`, `GL_INCR` → `"increment-clamp"`, etc.). Pairs with the new stencil state fields on `WebGLStubState`.

### DecoupledLookbackScan runtime wrapper (FEAT-SURVEY-06)

[WebGPUDecoupledScan.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUDecoupledScan.ts) wraps [DecoupledLookbackScan.wgsl](../packages/engine/Source/Shaders/WebGPU/Compute/DecoupledLookbackScan.wgsl) with the same lifecycle shape as `WebGPUGPUCuller`: `initialize(shaderCode)` → `ensureCapacity(n)` → `dispatch(encoder, input, output, count)` → `destroy()`. Lazy partitions buffer, power-of-two growth, zeros-the-partitions on every dispatch (decoupled-lookback requires `FLAG_EMPTY = 0` initial state).

- 6-test spec at [WebGPUDecoupledScanSpec.js](../packages/engine/Specs/Renderer/WebGPU/WebGPUDecoupledScanSpec.js) using the mock-device pattern from `WebGPURingBufferAllocatorSpec`. Covers: no-alloc-before-init, init creates pipeline + params (not partitions — lazy), `ensureCapacity` grows with destroy of previous buffer, dispatch writes params + zeros + encodes compute pass with 4 bind-group entries, zero-length no-op, post-destroy returns false.
- **No consumer swapped yet.** The library is live; the "one consumer at a time" plan starts with point-cloud LOD (swap atomic-add compaction → scan-based deterministic compaction) — tracked below as item 3 of the next-session priorities.

### ParityManager (FEAT-SURVEY-07)

[WebGPUParityManager.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUParityManager.ts) landed in an earlier session; [WebGPUTAAEffect.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUTAAEffect.ts) **now delegates to it**:

- Removed `_historyIndex` and `_frameCounter` fields.
- TAA owns a `WebGPUParityManager`, registers the history-view pair on `_allocateHistoryTextures`, rebinds on resize.
- `execute()` calls `advanceFrame()` exactly once at entry, then `parity.read<GPUTextureView>(slotId)` / `parity.write<GPUTextureView>(slotId)`.
- `_skipNextBlend` preserves the "first frame / post-resize passthrough" behavior that `_frameCounter === 0` used to give us.
- `getStatistics()` derives `frameCounter` + `historyIndex` from `_parityManager.frameIndex` — stats value and UB value are now consistent with each other (the old inline pair wasn't always).
- Behavioral note: `u32View[3]` (params-UB frameIndex) is shipped to the shader shifted +1 vs. pre-refactor, BUT `TAA.wgsl` never reads `params.frameIndex` (declared with comment "for debug / Halton cycle", never referenced). Off-by-one is cosmetic.
- A future session can hoist the manager to the scene renderer so Hi-Z reprojection + auto-exposure histograms share a single monotonic frame counter.

### Review fixes + documentation

- Root `package.json` `sideEffects` now covers `Source/Cesium*.js`.
- [bundleVariantPlugin.js](../scripts/bundleVariantPlugin.js) exemption-list comment now documents "how to add a new compat-surface file" + the IIFE code-splitting trade-off.
- [CLAUDE.md](../CLAUDE.md) Build Variants section updated with measured sizes, tree-shaking limits, compat-exemption protocol, side-effects requirement, smoke-test reference.
- New [Tools/variant-smoke-test.mjs](../Tools/variant-smoke-test.mjs) — Playwright runner, three variants, `CESIUM_BASE_URL` set from bundle path, default imagery + terrain disabled to avoid false-positive console.error on network failures. **Not yet run end-to-end.**

### Net delta since 2026-04-16 handoff

- Build variants infra: **shipped, measured, documented**. Not yet smoke-tested.
- TAA Slices 1 + 2a + ParityManager delegation: **shipped**. Slice 2b+ pending.
- Aerial-perspective LUT: 1 shader → 7 shaders. Visual verification pending.
- WebGL stub: Proton-style real translation for textures / parameters / extensions / stencil. GLSL translator scaffolded but naga-wasm not yet wired as first real consumer.
- DecoupledScan: runtime wrapper + spec; zero real consumers.

---

## Next session — recommended order

**Don't start TAA Slice 2b yet.** Slices 1 + 2a are shipped and cover the static-geometry case (~95% of what a globe renders). The remaining slices are refinements. Closing the loop on work we just shipped is higher value.

### Item 1 — Run the variant smoke test (highest risk, lowest cost, ~30 min)

The smoke-test script exists and I fixed its two latent issues (no CESIUM_BASE_URL → Cesium asset lookups break; default Bing imagery → network failures trip `console.error` and false-FAIL the test). It has never been executed end-to-end.

Given the number of moving pieces landed this cycle (6 shader edits, stub rewrite, build-variants plugin, sideEffects change, ParityManager refactor), there's real risk one of them breaks a variant at *runtime* while type-checking clean. Catching that now is 10× cheaper than catching it after more work lands on top.

```bash
# terminal 1
npm run restart
# terminal 2
node Tools/variant-smoke-test.mjs
```

Passes if all three variants report PASS with 0 console errors. Fixes are fast when the failure surface is isolated — if a variant breaks, the build-variants plugin or exemption list is the most likely culprit.

### Item 2 — Visual verification of the 6 aerial-LUT shaders (~1-2 hours)

The aerial-LUT rollout compiles and type-checks clean, but no one has seen the fog render on these shaders. [Tools/visual-regression/](../Tools/visual-regression/) has the scaffolding; add scenes to [scenes.json](../Tools/visual-regression/scenes.json) that place each affected material at near / mid / far / horizon distances and run the diff:

```bash
node Tools/visual-regression/capture-and-diff.mjs --update    # save baselines
node Tools/visual-regression/capture-and-diff.mjs             # check
```

Order of likelihood to surface issues: PBR variants first (tonemap+gamma ordering is the most delicate), then ModelPBRComplete (different input geometry — `rteMC` + `modelMatrix` instead of `eyePosition`), then the simpler Phong/MatColorLit/MatImageLit.

### Item 3 — Wire DecoupledScan into point-cloud LOD (1 session)

First real consumer of the library. Target [WebGPUPointCloudLODProcessor.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudLODProcessor.ts):

- **Current behavior**: atomic-add compaction → order-unstable `visibleIndices` buffer. Side effect: picking consistency is worse than it could be (same point may sort differently frame-to-frame).
- **Swap**: run the per-point 0/1 visibility flag through `WebGPUDecoupledScan.dispatch()`; the resulting inclusive prefix is the compact-index lookup. Second small compute pass converts flag + prefix → compact visible-indices buffer.
- **Verification**: existing point-cloud tests + new micro-benchmark (~100k point cloud) comparing scan vs atomic wall-clock and picking stability.

The "one consumer at a time, measure impact, iterate" framing you set applies here. Getting the pattern right on this swap makes indirect-draw compaction and particle cull mechanical afterwards.

### Deferred (in the order I'd pick if pressed)

- **TAA Slice 2b — per-model MRT motion** (effort: 1-2 sessions).
  Ghosting on animated glTF is real but narrow (affects only
  skinned/morphed/instanced, which is a small fraction of Cesium scenes
  today). Requires a second color attachment on every model pipeline +
  previous-frame joint/morph/instance UBO layout.
- **BUG-3 — 2D/Columbus View projection in WebGPU globe renderer**
  (effort: 3-5 days). Opens new rendering surface area. Better to
  stabilize 3D path first. Tracked in backlog.
- **Principal-engineer-review tail** (§5a/§5b/§5c specs,
  §6d `@private` → `@internal`, etc.). Each is a bounded PR; schedule
  opportunistically. §6d is the smallest unblock (~2-3h).
- **ES6 modernization Phase A — `WGSLShaderBuilder.js`** (25 markers,
  effort: 1-2 hours). Still the right target when the modernization
  track is picked up. Pilot for Phase A; pattern establishes the rest.

### What NOT to do next

- Don't pursue TAA Slice 2b until visual verification of what's shipped is done. Building per-model motion on top of an unverified Slice 1 pipeline multiplies the surface area of unknowns.
- Don't start full GLSL→WGSL runtime translation via naga-wasm yet. Scaffolding is in place ([WebGPUNagaTranspiler.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUNagaTranspiler.ts) + the shader translator registry) but pipeline materialization for translated programs is a multi-session effort. Park until a consumer needs it.
- Don't modernize upstream-pristine files (Phase D). Merge-friction cost exceeds benefit.

---

## Session 31 — Principal-engineer review fixes (2026-04-16)

The review surfaced 17 actionable findings across CRITICAL / HIGH / MEDIUM tiers. After verification, **5 had already been fixed** by other work (§2 build outputs, §3f double-beginRenderPass, §4a Scene.js leaks, §4d VOLUMETRIC_FOG consumer, §6b panorama logs). The remaining **11 valid findings were fixed in this session**:

| Tier | Finding | Fix | File(s) |
| --- | --- | --- | --- |
| CRITICAL §1 | esbuild parse-error race on second build | Explicit `loader: { ".ts": "ts", … }` map in `defaultESBuildOptions()` | [scripts/build.js](../scripts/build.js) |
| CRITICAL §3a | Ring allocator overflow grew unbounded (no auto-trim) | Auto-trim every N frames (default 60) + `maxPageCount` circuit breaker (default 32) + first-overflow warning + actionable error message | [WebGPURingBufferAllocator.ts](../packages/engine/Source/Renderer/WebGPU/WebGPURingBufferAllocator.ts) |
| CRITICAL §3b | `mapAsync` callback accessed `_stagingBuffer` after destroy | Captured staging buffer reference + `_isDestroyed` + identity guard in all three async paths (sync `_startReadback`, `endAsync`, `readDepthPixelAsync`); `isDestroyed()` now reports the real flag | [WebGPUPickFramebuffer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUPickFramebuffer.ts) |
| CRITICAL §3c | Per-frame `createView()` and `createBindGroup()` leaked | Cached `_colorView` / `_depthView` (recreated only on resize); `WeakMap<GPUTexture, GPUBindGroup[]>` cache in mipmap generator (auto-releases when textures are GC'd) | [WebGPUPickFramebuffer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUPickFramebuffer.ts), [WebGPUMipmapGenerator.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUMipmapGenerator.ts) |
| CRITICAL §3d | Device-loss recovery promise was detached | Promise stored on the recovery manager; `dispose()` method awaits it; `WebGPUContext.destroy()` calls `dispose()` and trips an abort flag so a recovered device isn't promoted into a torn-down context | [WebGPUDeviceLossRecovery.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUDeviceLossRecovery.ts), [WebGPUContext.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts) |
| CRITICAL §3e | Shader cache errors lost the WGSL source | Truncated source (800 chars) appended to console output; full source attached to the wrapped Error as `wgslSource` for programmatic access; shader name attached as `shaderName` | [WebGPUShaderCache.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUShaderCache.ts) |
| HIGH §4b | `WebGPUDrawCommand` missing `occlude` + `pickOnly` | Added to options interface, fields, defaults (`occlude` defaults true mirroring WebGL, `pickOnly` defaults false), and `clone()` | [WebGPUDrawCommand.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUDrawCommand.ts) |
| HIGH §4c | Lazy feature-renderer race + half-flicker | Replaced boolean flag with discriminated-union `FeatureRendererLoadStatus` (registered / loading / loaded / failed); added `getFeatureRendererAsync(key)`, `getFeatureRendererStatus(key)`, `isFeatureRendererLoading(key)`, `hasFeatureRendererFailed(key)`. Failed loads can be retried on next call. RxJS BehaviorSubject was considered but rejected — consumers don't subscribe to changes (they call `getFeatureRenderer(key)` per frame), so the typed-state slot is more performant and avoids pulling RxJS into the engine | [GraphicsContext.ts](../packages/engine/Source/Renderer/GraphicsContext.ts) |
| MEDIUM §6a | Cache errors missing `context.id` prefix | Constructors accept optional `contextId`; errors now log `[CesiumJS:webgpu:<id>:shader-cache]` / `[CesiumJS:webgpu:<id>:pipeline-cache]`. Both caches are dormant infrastructure (not yet instantiated by `WebGPUContext`) but the principled gap is closed | [WebGPUShaderCache.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUShaderCache.ts), [WebGPURenderPipelineCache.ts](../packages/engine/Source/Renderer/WebGPU/WebGPURenderPipelineCache.ts) |
| MEDIUM §6c | `@webgpu/types` on caret range | Tight-pinned `0.1.69` with rationale documented in the PR | [package.json](../package.json) |

### Net delta

- Build determinism: **fixed** — two consecutive `gulp build` runs from a clean tree both succeed.
- Resource lifecycle: **5 of 6 confirmed leaks/races closed**. The remaining one (HIGH §5a — specs not in CI) is an infra change requiring a CI workflow edit; left as an open task because the test suite + spec-runner config need a separate review pass.
- Backwards compatibility: **zero behavior changes for existing callers**. The `getFeatureRenderer(key)` sync path returns the same values; the new async/status methods are additive.

### What's NOT yet addressed from the review

| Tier | Finding | Why deferred |
| --- | --- | --- |
| CRITICAL §1 | Move generated `Source/Cesium*.js` entry files to `Build/generated/` | Cosmetic + risky — touches the entire build pipeline, several test pages reference root `Source/Cesium.js`. Leave for a focused build-system PR |
| CRITICAL §2 | `gulp prepare` destroys `Build/Cesium*` siblings | **DISPROVED on re-verification** — the `prepare` task is non-destructive |
| HIGH §4d | `auditFeatureRenderers` gulp task | The discriminated-union status above (§4c) gives us the data structure to audit; the gulp task itself is ~50 LOC in a separate PR |
| HIGH §5a | Specs not in CI | The dev workflow already runs `npm test` via `release-tests` job (with `--release --webgl-stub`), but WebGPU-specific specs need a non-stub run in a fresh job. Needs a workflow PR |
| HIGH §5b | `bundleVariantPlugin` spec | New file; fits naturally with the next batch of test work |
| HIGH §5c | 20+ untested WebGPU modules (~8,850 LOC) | Backfill campaign; one module per PR is the realistic cadence |
| MEDIUM §6d | `@private` → `@internal` sweep | ~2-3 hour grunt task, no risk; queue for a low-context session |
| MEDIUM §6e | Pragma stripping post-build lint | Build-system tooling; pairs with §1 generated-entry move |
| MEDIUM §6f | Inconsistent error prefixes | 86 `console.*` call sites in `Renderer/WebGPU/`; mechanical sweep |
| MEDIUM §6g | Documentation drift CI check | Quarterly process change; not single-PR work |
| MEDIUM §6h | `FEATURE_RENDERER_ONBOARDING.md` | ~300 LOC doc; can be authored alongside the next FR addition |

---

## Next chunk — full ES6/ES2022 modernization

The user has explicitly requested this as the next milestone. The Session 30 handoff captured the raw count (`~433 modernization markers` across the engine + widgets) and recommended a two-track approach. Here's the plan that operationalizes it.

### Total surface area (re-counted at Session 30 close)

| Marker | Count |
| --- | --- |
| `var` declarations | ~0 (all gone) |
| IIFE wrappers `(function(){})()` | 0 |
| `var self = this` / `var that = this` | 0 |
| `X.prototype.method = function()` | **293** |
| `Object.defineProperties(X.prototype, {...})` | **105** |
| `.apply(null, args)` / `.apply(this, args)` | 10 |
| `arguments` object reads | 25 |

### The hidden cost

CesiumGS upstream has **not** modernized the bulk of these files. Every upstream-pristine `.js` we modernize creates a structural merge conflict on every upstream sync. The principled split:

- **Modernize now**: fork-owned files. Modernizing them is nearly free because we resolve conflicts during every sync anyway.
- **Modernize opportunistically**: files we touch for unrelated work (CLAUDE.md's existing 10-line rule already enforces this).
- **Defer indefinitely**: upstream-pristine files. Modernizing them adds merge friction with little benefit.

### Phase A — fork-owned files (~1-2 hours)

These are the highest-priority targets because they're either WebGPU-specific or actively-edited fork additions:

| File | Markers | Notes |
| --- | --- | --- |
| [Renderer/WebGPU/WGSLShaderBuilder.js](../packages/engine/Source/Renderer/WebGPU/WGSLShaderBuilder.js) | 25 | Touched on every WGSL feature; modernize before it grows further |
| [Renderer/WebGPU/RenderCommand.js](../packages/engine/Source/Renderer/WebGPU/RenderCommand.js) | 8 | Backend-agnostic abstraction |
| Any other fork-specific `Renderer/WebGPU/*.js` outliers | small | Sweep in same pass |

**Acceptance:** every `prototype.method = function()` becomes a class method; every `Object.defineProperties` becomes ES6 `get`/`set`; existing JSDoc preserved (CLAUDE.md rule); no JSDoc added that wasn't there.

### Phase B — fork-modified Scene + Renderer files (~3-5 days)

Files where we have meaningful WebGPU additions on top of upstream code. Modernizing here costs less than modernizing pristine files because we already resolve the conflicts during sync. Candidates surfaced from session-30 audit:

| File | Markers | Reason |
| --- | --- | --- |
| Scene/Primitive.js, Scene/PointPrimitiveCollection.js, Scene/PolylineCollection.js, etc. | varies | We've added WebGPU routing; merge cost is already paid each sync |
| Renderer/Context.js | varies | Already ES6 class via our extends GraphicsContext refactor — verify no remaining `prototype.method` patterns |
| Renderer/createUniformArray.js + createUniform.js | 26 combined | Frequently touched in WebGPU uniform work |

### Phase C — opportunistic (CLAUDE.md rule already covers this)

Every file touched for >10 lines of unrelated work picks up its modernization for free. Over 6-12 months of active development this naturally covers the fork-specific + frequently-edited files without paying the merge cost.

### Phase D — deliberate upstream-pristine deferral

The ~300 markers in `KmlDataSource.js`, `CesiumWidget.js`, `AtmosphericConditions.js`, `PolylineCollection.js`, etc. are explicitly **not** scheduled. They modernize when upstream modernizes them, or when feature work happens to touch them.

### What "modernization" concretely means

Per the CLAUDE.md ES6+ rules + the upstream Coding Guide:

1. `var` → `const` / `let`
2. Prototype-based inheritance → ES6 `class` syntax (preserving all JSDoc, removing `@constructor` and `@memberof X.prototype` that are now redundant)
3. `Object.defineProperties()` getters/setters → ES6 `get` / `set` in class body
4. String concatenation → template literals (only where readability improves)
5. `Function.prototype.apply(null, args)` → spread (`fn(...args)`)
6. `arguments` reads → rest parameters (`...args`)
7. `for (var i = 0; ...)` over arrays → `for...of` or `.forEach()` *only* where perf is not critical
8. `typeof x !== "undefined"` → optional chaining / nullish coalescing
9. `Object.assign({}, defaults, options)` → `{ ...defaults, ...options }`
10. `.indexOf(x) !== -1` → `.includes(x)`
11. `obj.hasOwnProperty(key)` → `Object.hasOwn(obj, key)`

**Performance-critical math classes** (`Cartesian3`, `Matrix4`, `Quaternion`, `JulianDate`) are intentionally left alone — they use `result` parameters and scratch variables where ES6 patterns can introduce overhead. Benchmark before any change here.

### Recommended starting point next session

1. **Read this handoff + the principal-engineer review.**
2. **Pick `WGSLShaderBuilder.js` as the Phase A pilot** — biggest single fork-owned target (25 markers), establishes the pattern for the rest.
3. **Run `npx tsc --project packages/engine/tsconfig.json --noEmit`** as the gate after every file conversion.
4. **Update [migration_doc/ES6_MODERNIZATION_STATUS.md](ES6_MODERNIZATION_STATUS.md)** with the converted-file list as you go — `ES6_MODERNIZATION_BACKLOG.md` was archived to [`archive/ES6_MODERNIZATION_BACKLOG.md`](archive/ES6_MODERNIZATION_BACKLOG.md) and superseded by the STATUS doc (`README.md`'s archive table).
5. **Hold the line:** never modernize a file you're not otherwise touching unless it's on the explicit Phase A/B list.

---

## What's at the principled floor in Renderer/WebGPU

(Carrying forward from Session 30 — unchanged.)

Every remaining `any`/`unknown`/`object`/`Record<string, unknown>` in the WebGPU renderer is one of:

- `catch (e: unknown)` — TS's required catch binding (8 sites)
- Open index signatures on explicitly-permissive interfaces (SceneGlobalCache fallback, CesiumComputeCommand, CesiumObjectWithWebGPUCache) — by-design
- `jsModule<T>(mod: object)` — intentional type-eraser helper in `webgpuTypeHelpers.ts`
- `_gl` / `cache` on `WebGPUContext` — WebGL-compat JS surfaces consumed by ~20 upstream JS files
- `_performanceManager as unknown as {...}` — WIP per `feedback_interface_pruning.md` memory
- `PickTarget` index signature value — principled opaque for "value in heterogeneous external registry"

Further tightening requires (a) porting WebGL resource JS to TS, or (b) completing WIP modules — both are feature work, not typing work.

---

## Quick recipe — starting the next session

```text
1. Read this file (NEXT_SESSION_HANDOFF.md) — full picture.
2. Read PRINCIPAL_ENGINEER_REVIEW_2026_04_16.md if you need context on
   why specific lifecycle bugs / arch decisions exist as they are.
3. If continuing the modernization push:
   - Start with `WGSLShaderBuilder.js` (Phase A).
   - One file per commit; tsc --noEmit between each.
   - Preserve existing JSDoc; do NOT add new JSDoc.
4. If continuing the review-fix tail (§5a/§5b/§5c/§6d/§6e/§6f/§6g/§6h):
   - The "What's NOT yet addressed" table above ranks them.
   - The smallest unblock is §6d (`@private` → `@internal` sweep, ~2-3h).
5. After every meaningful change: `npx tsc --noEmit`.
```

## Files referenced by this handoff

**Review:**

- [PRINCIPAL_ENGINEER_REVIEW_2026_04_16.md](PRINCIPAL_ENGINEER_REVIEW_2026_04_16.md) — the source of the fix list

**Status docs:**

- [WEBGPU_MIGRATION_STATUS.md](WEBGPU_MIGRATION_STATUS.md) — full session-by-session history
- [WEBGPU_MIGRATION_BACKLOG.md](WEBGPU_MIGRATION_BACKLOG.md) — remaining work
- [ES6_MODERNIZATION_STATUS.md](ES6_MODERNIZATION_STATUS.md) — modernization tracker (supersedes the archived [`archive/ES6_MODERNIZATION_BACKLOG.md`](archive/ES6_MODERNIZATION_BACKLOG.md))

**Project rules:**

- [../CLAUDE.md](../CLAUDE.md) — backend agnosticism, RTE precision, file placement, ES6 modernization, `any` ban, co-located `.d.ts` pattern

**Key code surfaces touched this session:**

- [scripts/build.js](../scripts/build.js)
- [packages/engine/Source/Renderer/WebGPU/WebGPURingBufferAllocator.ts](../packages/engine/Source/Renderer/WebGPU/WebGPURingBufferAllocator.ts)
- [packages/engine/Source/Renderer/WebGPU/WebGPUPickFramebuffer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUPickFramebuffer.ts)
- [packages/engine/Source/Renderer/WebGPU/WebGPUMipmapGenerator.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUMipmapGenerator.ts)
- [packages/engine/Source/Renderer/WebGPU/WebGPUDeviceLossRecovery.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUDeviceLossRecovery.ts)
- [packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts) (destroy() teardown order)
- [packages/engine/Source/Renderer/WebGPU/WebGPUShaderCache.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUShaderCache.ts)
- [packages/engine/Source/Renderer/WebGPU/WebGPURenderPipelineCache.ts](../packages/engine/Source/Renderer/WebGPU/WebGPURenderPipelineCache.ts)
- [packages/engine/Source/Renderer/WebGPU/WebGPUDrawCommand.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUDrawCommand.ts)
- [packages/engine/Source/Renderer/GraphicsContext.ts](../packages/engine/Source/Renderer/GraphicsContext.ts) (lazy FR state machine + status introspection)
- [package.json](../package.json) (`@webgpu/types` pin)
