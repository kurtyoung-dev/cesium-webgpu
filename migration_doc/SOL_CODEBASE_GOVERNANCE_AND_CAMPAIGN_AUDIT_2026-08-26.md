# Sol codebase, governance, and campaign audit — 2026-08-26

**Status:** READ-ONLY AUDIT COMPLETE / IMPLEMENTATION FOLLOW-UP IN PROGRESS  
**Cutoff:** 2026-08-20 19:00 America/New_York  
**Repository authority:** live filesystem plus tracked rulings/queues/documents  
**Provenance limitation:** no Git command was run, so branch, tip, commit range, tracked/dirty state,
and exact authorship are intentionally unverified

## 1. Outcome

The post-cutoff work is substantial and generally disciplined, but it is not one homogeneous code
wave. It contains real renderer and campaign changes, broad C16 comment/grammar work, generated
shader-wrapper timestamp churn, evidence instruments, and several held packages whose recorded green
unit legs do not satisfy their terminal browser/hardware gates.

The audit returns:

- **GO** for local-only, collision-free authoring in new paths and for queue-authorized browser-free
  instruments or documentation work.
- **NO-GO** for campaign closure, evidence banking, landing, extension registration, broad engine
  integration, or claims about the current Git revision.
- **GO** for the preregistered renderer-free patch-extension P0a verifier under
  `Tools/patch-prototype/**`.
- **NO-GO** for patch-extension P1 engine/runtime work until its confirmed protocol findings and
  current C11/C12/C18 collision boundaries are resolved.

No existing measured red is demoted by this audit.

## 2. Audit census and timestamp interpretation

A 2026-08-26 filesystem session recorded 13,585 files in its scoped roots and 4,976 post-cutoff
mtimes, with 3,986 under `Tools/`, 933 under `packages/`, 55 under `migration_doc/`, and the three
named moved root files `AGENTS.md`, `CLAUDE.md`, and `.gitignore`; no `.agents` file had a post-cutoff
mtime and `.codex` was absent. The original walker, exclusions, snapshot, and raw output were not
retained, and the stated breakdown sums to 4,977 (3,986 + 933 + 55 + 3), so the historical census
is internally inconsistent and exact backing is owed before any of these counts are used.

Interpretation rules used in this report:

1. Generated shader `.js` wrappers are not counted as independent feature edits; canonical `.wgsl`
   or `.glsl` sources are the review target.
2. The August 21 ~12:01, August 24 ~21:54, and August 25 ~20:52–20:53 synchronized waves include
   broad C16 comment/grammar work and are not each treated as renderer feature batches.
3. Queue, ruling, handoff, and closeout statements are reported as recorded evidence. They were not
   independently reproduced in this no-build/no-browser audit.
4. Filesystem mtime does not establish commit chronology or author identity.

The latest documentation records Batch 1157 plus 31 dirty paths in one handoff and later queues record
Batch 1168. The actual repository tip is unknown under the explicit no-Git instruction.

## 3. Principal code findings

### 3.1 High-severity: clustered-light cache invalidation is incomplete

`packages/engine/Source/Renderer/WebGPU/WebGPUClusterAssignRenderer.ts:258-297` uploads light color,
intensity, range, attenuation, cone, and direction, but the cache checksum covers only position and
type. The early return at `:300-307` precedes uploads at `:309-320`.

A stationary light whose visible properties change can therefore retain stale GPU data. No focused
property-change regression spec was found. This is a real source defect, not a missing certification
artifact. It should receive a bounded finding/dispatch with a negative control before repair.

### 3.2 Lane-F point-cloud/EDL/GPU-LOD work is real but held

The package includes public far-distance handling and compute-shader culling at:

- `WebGPUPointCloudRenderer.ts:134,2397-2412`; and
- `Shaders/WebGPU/Compute/PointCloudLOD.wgsl:115-124,161-165`.

`pointcloud-voxel-public-correctness.spec.mjs:1558-1747` supplies useful pure-Node source
coverage, while `WebGPUPointCloudLODProcessorSpec.js:145-346` supplies useful mocked Jasmine
coverage that is collected into the browser spec bundle and is therefore not a browser-free Node leg.

It remains unreleasable because C18-P2/P5 terminal browser/real-Draco gates are absent and the package
does not discharge C18-P4. The current handoff and C18 queue retain that hold.

### 3.3 WebGPU point-cloud memory is materially undercounted

`TimeDynamicPointCloud.js:363-366` evicts using `_totalMemoryUsageInBytes`, updated from
`geometryByteLength` at `:579,709`. `PointCloud.js:630-664` counts parsed typed arrays, while
`WebGPUPointCloudRenderer.ts:178-288` owns additional instance, previous-frame, structure-of-arrays,
and LOD buffers.

The recorded estimate is roughly a 3–8x undercount. `maximumMemoryUsage` can therefore fail to bound
actual WebGPU residency. This should be addressed before Lane F is presented for landing.

### 3.4 SceneOctree correctness is stronger than its telemetry

Revision scanning, one-build reuse, invalidation, and stable-sphere logic exist in
`SceneOctree.js:120-170,238-316,485-507` and `ViewportExecutor.js:711-748`, with strong mutation
coverage in `scene-octree-dirty-revision.spec.mjs:392-735,842-958`.

`Scene.js:2141` reports `builtThisFrame: octree.isBuilt`, which stays true on reuse frames and
overstates rebuild work. The associated performance acceptance remains open.

### 3.5 Coherent or well-covered deltas

- Model IBL spherical-harmonics source selection appears internally coherent across
  `WebGPUModelRenderer.ts:2561,4364-4415,4490-4537`, with focused coverage in
  `webgpu-ibl-sh-signal.spec.mjs`.
- Timestamp-profiler configurable ring depth is implemented at
  `WebGPUTimestampProfiler.ts:189-243,410-416,794-849,925-993` and has targeted mutation coverage.
  The recorded depth-8 run removed saturation, but one drain remained invalid and
  `shadowContrastInvariant=1.034110` still exceeds the frozen `1.03` ceiling. That result stays red.
- Cloud reconstruction/U2 has unusually broad positive, negative, lifecycle, renderer, shader-pin,
  and mutation coverage, centered on `WebGPUCloudReconstructionAttachments.ts` and
  `cloud-reconstruction-attachments.spec.mjs`.
- Zero-frustum pick clearing and owner checks are focused, but the active-frustum off-geometry
  all-255 remainder remains open. `PickDepth.js:30` also still carries the legacy hard-coded cap of
  four; the ruled default-two tunable shape is planning, not current code.
- Moon readiness instrumentation now exposes texture dimensions/mip state at `Moon.js:945-991`.

### 3.6 Evidence architecture concern

Several strong-looking campaign specs rely on source extraction, regular expressions, and VM
execution. They provide valuable mutation teeth but are brittle under refactoring and do not replace
engine integration tests or rendered acceptance. The point-cloud and cloud-reconstruction families
should preserve both layers rather than treating source-contract green as runtime certification.

### 3.7 Size and collision pressure

Largest active surfaces include:

| File | Lines |
| --- | ---: |
| `WebGPUModelRenderer.ts` | 9,015 |
| `WebGPUContext.ts` | 7,747 |
| `Scene.js` | 6,710 |
| `WebGPUPrimitiveCommands.ts` | 5,385 |
| `GlobeTerrain.wgsl` | 5,375 |
| `WebGPUSceneRenderer.ts` | 5,009 |
| `WebGPUModelPipelineCache.ts` | 4,575 |
| `WebGPUProceduralCloudRenderer.ts` | 4,430 |
| `WebGPUVoxelRenderer.ts` | 4,354 |
| `Cesium3DTileset.js` | 4,024 |

The patch extension would intersect `Cesium3DTileset.js`, `Scene.js`, and `WebGPUContext.ts`, all of
which are active, oversized, or campaign-adjacent. New additive modules and a narrow later integration
hook are preferable to adding more state machines directly to these files.

## 4. Governance and documentation findings

### 4.1 Binding or operational contradictions

1. `AGENTS.md` calls the August 21 ruling file current although an August 24 ruling exists. The newest
   ruling still wins under charter §0.4.
2. The campaign skill says explicit no-Git includes read-only Git, then separately calls Git
   branch/worktree inspection mandatory. The current user instruction wins: no Git command is allowed.
3. `WORKER_ISOLATION_AND_BRANCH_HANDOFF.md` simultaneously requires workers to commit/rebase/return a
   clean status and forbids worker Git writes. Uncommitted bytes cannot be fetched from a worker
   branch, so the transfer protocol is incomplete.
4. `ORCHESTRATION_HANDBOOK.md` still maps any preregistration disagreement to `STRUCTURAL`; the charter
   and later ruling require `FAIL` for a valid instrument missing its bar.
5. `CAMPAIGN_STATE.md` is described both as authority and mirror. Newer rulings/queues outrank it in
   either reading.
6. The Option-D direction for patch publication-event vocabulary exists, but the same/later ruling
   prose leaves public vocabulary, title/abstract, and Wave-B scope open. Prototype names remain
   provisional.
7. The patch design was ordered for further work but never assigned a campaign. This work must not
   invent Campaign 19 or claim campaign-row progress.
8. August 24 R4's station-3 and terminal browser disposition is not fully propagated into the C18
   queue. The ruling governs until the queue is reconciled.

### 4.2 Stale coaching and index drift

- `CLAUDE.md` retains a discharged cloud-probe hold and obsolete WebGPU canvas-decode guidance.
- `migration_doc/README.md` omits the August 24 rulings, patch-extension documents, and the current Sol
  continuation brief; its `NEXT_SESSION_HANDOFF` description is stale.
- Portfolio and individual queue banners report older refresh dates than their contents.
- Campaign 15 carries both G9 closure and older G8-blocked-by-G9 wording.
- No post-cutoff skill change repaired the campaign skill's internal no-Git contradiction.

These are routing and coaching defects. They do not override the charter or later rulings, but they
increase the risk of a fully automated executor following stale procedure.

## 5. Campaign-state reconciliation

The queue rows remain the sole status authority. This table is an audit snapshot, not a replacement
queue:

| Campaign | Audited state | Safe browser-free continuation | What remains held |
| --- | --- | --- | --- |
| C11 | Active, with standing reds and open rows | Narrow queue-authorized source/spec work only | C11-168 remains red; C11-170 performance remains red; C11-205 and hardware/evidence work stay open |
| C12 | Active critical path | Archive/countersign preparation that does not alter evidence | Acceptance success alone does not close the campaign |
| C13 | Held for Sol under the recorded Opus lane-lead/reviewer arrangement | None without a replacement independent reviewer and an explicit dispatch | Repair, closure, and evidence claims |
| C15-GSPLAT | Active/held by remaining gates | Preserve the G9 NOT REPRODUCED harness and existing G6 evidence | G6 remains partial/STRUCTURAL; G7 is pending; G8 remains last |
| C16 | Active source-quality campaign | C16-11, one file only: WebGPUSceneRendererFrustumLoop.ts and its 42 recorded markers | C16-12 tail and any overlapping broad cleanup |
| C18 | Active but held at station 3 | Browser-free review or preregistration only where explicitly assigned | Lane-F landing, P2/P5 terminal gates, P4, and far-cull/public-knob closure |

The patch prototype is not a campaign row. It cannot mint C19, consume another campaign's closure
credit, or imply progress on C11, C12, or C18.

After the patch P0a verifier has passed focused tests and independent review, C16-11 is the cleanest
available campaign continuation. Its one-file lease avoids the currently active extension and Lane-F
surfaces. The clustered-light and memory-accounting defects should be routed as findings before any
repair rather than silently folded into an unrelated campaign.

## 6. Patch-extension design audit

The design review covered the frozen documents:

- 3D_TILES_PATCH_EXTENSION_DESIGN_2026-08-11.md — SHA-256
  1618d77c...fdc3 (339,912 bytes)
- 3D_TILES_PATCH_EXTENSION_AUDIT_2026-08-16.md — SHA-256
  d17a162b...085 (53,560 bytes)
- 3D_TILES_PATCH_EXTENSION_REAUDIT_2026-08-16.md — SHA-256
  418276ee...1da7 (88,884 bytes)

The prior audit's central concerns survive review:

| Concern | Disposition | P0a consequence |
| --- | --- | --- |
| Freshness-profile selector and circular entrypoint | Confirmed | P0a accepts a duplicate-aware, bounded bootstrap object but does not call the entrypoint JCS-canonical |
| Revocation withholding/replay | Confirmed with scope qualification | Signed and revocation modes are recognized and rejected; unsigned local protocol only |
| Request-window Dmax versus complete state-control closure | Confirmed | The prototype computes exact closure over base plus descriptor/control bytes, not only requested payloads |
| Signed-head expiry versus HTTP 304 economics | Confirmed | Signed heads and conditional-fetch economics are deferred rather than papered over |
| Per-bin Dmax versus global manifest size P | Confirmed | P0a applies global bounded counts and byte limits |
| Per-target exposure priors | Partly confirmed | No undeclared prior enters the prototype schema or integrity calculation |

R-2026-08-17-18 supersedes design Decision 23: publisher transition.reason remains publisher
vocabulary. Any later semantic change reason must be a separate optional field and a separately
reviewed compatibility choice.

The exact temporal-tiles branch re-survey remains owed. It could not be performed without violating
the explicit no-Git instruction. Public extension naming, title/abstract language, Wave-B scope, and
registry compatibility therefore remain provisional.

### 6.1 Existing invalidation feed is not the extension

The current invalidation feed is a useful legacy experiment but does not supply protocol semantics
for this design. It omits multiple-content handling, future-load application, signed heads,
deduplication, gap recovery, atomic activation, bounded garbage collection, and complete state
closure. It also walks loaded private state and lets polling failures escape.

Its advertised FNV-1a-64 implementation is mathematically incorrect: it multiplies by 2^40 + 257
instead of the FNV prime 2^40 + 435. The empty input happens to match, while known vectors do not
(for example, a produces e0b2c568a6456744 instead of af63dc4c8601ec8c). The patch verifier therefore
uses SHA-256 only and does not reuse that hash.

### 6.2 Renderer implications for later WebGL and WebGPU work

Full engine support is intentionally outside P0a, but the later integration plan must cover both
backends through a common semantic state machine:

1. Parse, validate, stage, and atomically activate a generation independently of the renderer.
2. Resolve all targeted tile and content identities, including multiple contents and content loaded
   after activation.
3. Materialize replacement resources with generation pins and double-residency accounting.
4. Apply geometry-affecting regions and style/visibility effects through backend adapters with the
   same public semantics.
5. Exercise color, depth, pick, shadow, classification, query, most-detailed, context-loss, and
   eviction behavior in WebGL and WebGPU.

Current clipping backends cannot yet carry those guarantees. Both WebGL and WebGPU can reuse stale
clipping data after constant-count vertex edits because their update shortcuts key on counts rather
than full geometry revision. WebGPU also has a bounded merged-extent capacity that can produce
partial clipping. A later patch activation must reject unsupported cardinality or provide a scalable
representation; it must never silently apply only a prefix.

## 7. Authorized implementation sequence

The safe sequence is:

1. P0a: build the renderer-free strict-JSON and live-update wire verifier under
   Tools/patch-prototype, with every preregistered positive and negative control.
2. Independently review P0a against the frozen preregistration. A valid mutant accepted by the
   verifier is FAIL; malformed test infrastructure is STRUCTURAL.
3. P0b: separately preregister a minimal producer/CAS/head server and deterministic fixture
   generator. Keep it under new paths and preserve the unsigned/local experimental boundary.
4. Resolve the six design findings and freeze the public vocabulary before any registration claim.
5. P1: only after collision review and an explicit dispatch, add the common runtime state machine
   and narrow Cesium integration hooks, then implement and prove WebGL/WebGPU parity.
6. Resume C16-11 as the next open campaign lane while browser/GPU-dependent lanes remain held.

This order is not a reduction of the requested scope. It is the boundary required to reach
principal-engineer-quality WebGL and WebGPU support without binding the engine to a protocol whose
freshness, revocation, closure, and resource-accounting rules are still unsettled.

## 8. Operating constraints and audit provenance

Quiet hours are 07:00–19:00 America/New_York. During this run, all authorized changes remain local
and unlanded. The maintainer also explicitly prohibited every Git action and deletes, so no branch,
commit, stash, checkout, fetch, rebase, status, diff, or cleanup command is authorized even outside
quiet hours.

The source audit used filesystem timestamps, direct file inspection, and the tracked document
record. It did not run Git, a browser, GPU probes, builds, or tests. Consequently:

- tracked versus untracked and committed versus dirty state are unknown;
- exact author and commit attribution are unknown;
- synchronized mtimes establish batches, not authorship; and
- reported prior PASS, FAIL, ERROR, or STRUCTURAL results remain reported evidence until reproduced.

The implementation follow-up may run only focused browser-free tests for the new prototype. No
result from that prototype changes an existing campaign score or closes a renderer lane.

## 9. Audit verdict

The repository is fit for bounded local continuation, not broad landing or certification. Proceed
with the P0a verifier, independently review it, and then preregister P0b. Keep runtime integration
and public extension registration at NO-GO until the confirmed protocol findings are resolved.
After P0a, continue the campaign through C16-11 unless a newer ruling changes the queue.
