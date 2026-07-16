# Fork Performance, RTE, Visibility, and Campaign 8 Remediation Plan

Prepared: 2026-07-15

Status: **ACTIVE / CAMPAIGN 9 EXECUTION SOURCE**

This plan converts the exact-current performance review, the RTE/temporal-precision review, the
visibility/octree review, and every unfinished Campaign 8 item into one dependency-ordered program.
Its executable companion is
[Campaign 9 — Terrain Hot Path, Visibility, Precision, and Campaign 8 Closure](QUEUE_2026-07-15_CAMPAIGN9.md).

Campaign 9 was explicitly launched by the maintainer on 2026-07-15. Campaign 8 is now a frozen
checkpoint: its open IDs transfer unchanged, while its four closed slices remain regression gates
rather than work to repeat.

## 1. Outcome

Recover and then materially improve WebGPU moving-camera performance without removing, hiding,
default-disabling, or visually weakening any feature. At the same time:

- preserve current WebGL2 behavior and shared scene semantics;
- eliminate avoidable work after visibility selection;
- keep all planetary-scale current- and previous-frame math camera-relative;
- make attachment, resource, and effect work consumer-driven;
- move conversion and persistent resource creation out of draw emission;
- bound GPU residency with one physical-queue completion timeline; and
- finish Campaign 8's correctness, parity, ownership, test, and certification work.

## 2. Current architectural verdict

The globe is not missing a general-purpose octree. Cesium's WebGL globe path uses
`QuadtreePrimitive` with `GlobeSurfaceTileProvider`, and WebGPU must consume that same backend-neutral
selected-tile result. 3D Tiles and voxels have their own spatial structures; the optional general
`SceneOctree` currently owns only its declared primitive cohorts. Moving terrain into `SceneOctree`
would duplicate traversal, diverge from WebGL selection, and is not a fix. The dominant issue is work
performed *after* the shared globe quadtree/PVS has selected visible content.

The highest-impact findings are:

1. **Visible-terrain command churn.** WebGPU rebuilds per-tile/per-imagery-pass arrays, slices,
   descriptors, command wrappers, and execute closures on moving frames. CPU time correlates much
   more strongly with command count on WebGPU than WebGL. Stable tile/material/pass state must be
   retained and revision-invalidated; dynamic view data belongs in rings/dynamic offsets.
2. **Duplicated imagery realization and mip submission.** An imagery source reused across terrain
   tiles is currently materialized once per tile. The deterministic GridImagery route created 513
   identical full-mip textures, 4,104 mip bind groups/passes, and 513 private mip encoders/submits in
   1,197 frames, retaining roughly 171 MiB in the measured window. Exact immutable source/revision
   identity must own one backend realization with per-tile references; mutable/unknown sources stay
   distinct, and mip preparation belongs before draw emission on the frame-owned queue timeline.
3. **Consumerless MRT/G-buffer cost.** The scene target defaults to MRT and attaches/resolves an
   `rgba16float` companion even when no enabled consumer needs it. At 1920x1080 with 4x MSAA the
   resolved plus multisampled companion is roughly 80 MiB before repeated resolve/bandwidth cost.
   Attachment topology must be demand-derived, with conservative MRT fallback for unknown consumers.
4. **Unbounded terrain GPU residency.** A terrain eviction helper exists without a production owner.
   Altitude flight can grow retained GPU buffers. Active/leased tiles must stay pinned; inactive
   realizations need a byte-budgeted grace LRU and completion-serial-safe retirement.
5. **Duplicate ground-atmosphere integration.** The default terrain shader can perform a vertex
   atmosphere march and recompute the atmosphere in the fragment path while the vertex result is not
   consumed. One exact quality variant must own the work at a time.
6. **Temporal RTE gaps.** Several velocity shaders reconstruct absolute ECEF in `f32`; Hi-Z/LOD
   structures store absolute ECEF `Float32`; natural-frustum TAA does not yet carry exact depth,
   projection, and jitter identity. These are correctness constraints, not optional optimizations.
7. **Effects outside ordinary PVS ownership.** Fullscreen and compute effects do not automatically
   inherit terrain/primitive culling. FFT ocean, flow fields, and dynamic environment capture need
   conservative feature-owned visibility and simulation-continuity contracts.
8. **Small always-on costs.** Zero-strength TPDF dithering still allocates/uploads and hashes;
   celestial extinction recomputes marches; a default canvas pass may be opened only to be discarded;
   scheduler and diagnostic helpers may do work even when their consumers are disabled.

The one-week performance tranche reduced several local counters, but the exact-current defense did
not prove a net whole-route CPU improvement. Campaign 9 therefore begins with saved-bundle replay and
owner-attributed moving-camera evidence. Idle soak/FPS is invalid because request-render mode can
pause rendering.

## 3. Non-negotiable invariants

1. No feature is removed, bypassed, silently contained, default-disabled, or degraded to improve a
   metric. If a feature is broken, its repair is queued and its supported path remains available.
2. Unknown MRT demand retains the complete topology. Unknown visibility/bounds executes the original
   effect. Unknown completion serial retains the resource. Uncertain Hi-Z/RTE data uses the correct
   CPU/direct fallback.
3. WebGL and WebGPU may share immutable decoded CPU payloads only when descriptor identity is exact.
   They never share backend GPU handles. A native WebGPU token must not first create a WebGL GPU
   realization; partial native coverage retains compatibility ownership from the start.
4. Current and previous planetary positions remain high/low or camera-relative. No shader or GPU
   visibility structure may recombine planetary ECEF into one `f32` before subtracting its matching
   camera origin.
5. Every skipped effect preserves visual state, simulation time, mutation, reveal/resume, and clock
   jumps. A hidden simulation either advances from absolute scene time or performs a bounded,
   specified catch-up.
6. All cache/lifetime work proves resize, device loss, multi-context isolation, destruction, leases,
   last-use serial, recovery epoch, and steady-state plateau.
7. Browser automation remains Node/Playwright with Microsoft Edge. No Python tooling is introduced.
8. Performance comparisons use the same exact camera track with multiple altitudes, assets, flags,
   viewport, adapter, browser, warm-up, and feature state. Clean and instrumented lanes stay separate.

## 4. Architecture to converge on

### 4.1 Visibility ownership

Visibility is specialized, not forced through one tree:

- terrain: one shared `QuadtreePrimitive`/`GlobeSurfaceTileProvider` selection used by WebGL and
  WebGPU, followed by backend-specific command compilation;
- 3D Tiles: tileset traversal and request/selection state;
- voxels: voxel octree;
- ordinary primitives: Scene PVS and optional `SceneOctree` cohorts;
- fullscreen effects: enabled plus declared input/output consumer demand;
- regional compute/simulation: conservative feature-owned bounds plus continuity rules;
- cubemap capture: capture-camera/per-face selection, never blind replay of the main-camera list.

Campaign 9 first records this ownership in a machine-readable execution manifest, then adds counters
at selection, survivor, command, pass, attachment, and effect-execution boundaries.

### 4.2 Retained terrain frontend

Visible tiles emit retained packets keyed by exact revisions: mesh, imagery set/order, material,
scene mode, water, clipping, shadows, HDR/MSAA/log-depth topology, and device generation. Per-frame
camera/frustum values use a view ring and dynamic offsets. The warm moving path must not create full
arrays, `slice()` copies, command wrappers, or execute closures per tile/pass. WebGL retains its
existing cached command behavior and consumes the same backend-neutral logical revisions where safe.

### 4.3 Consumer-driven attachments and passes

One attachment-demand registry describes every enabled consumer. The legacy executor and future
frame graph read the same registry. A bounded bridge may cache exact one-target and MRT pipeline/pass
variants, but it must not become a second topology authority. Canvas and intermediate passes open only
when a producer/consumer requires them; clear, presentation, TAA, classification, pick, depth/stencil,
OIT, and recovery semantics remain explicit.

### 4.4 Resource preparation and lifetime

Backend-neutral `ResourcePlan` records payload/version/domain/descriptor/dependencies/cancellation.
Fetch, decode, conversion, and persistent creation execute before draw emission with budgets and
backpressure. Publication and retirement use one physical queue/device-generation serial authority.
Decoded CPU payloads and backend realizations have separate caches and identities. Imagery tiles hold
references to exact immutable source/revision/descriptor/device-generation realizations instead of
silently owning duplicate textures; mutable or unknown sources never alias. Full mip preparation is
frame-owned or scheduled off the draw hot path, and quadtree release feeds serial-safe refcounted,
byte-budgeted retirement.

### 4.5 RTE and temporal state

One reviewed helper and producer/consumer inventory covers current and previous transforms, camera
origins, scene modes, frusta, depth versions, jitter, and history. Velocity, point-cloud/vector-tile
LOD, Hi-Z bounds, clouds/fog, picking, and TAA use matching view/frustum identities. Collection camera
uniforms use a dynamic-offset view ring instead of fallback upload-per-slice behavior.

## 5. Workstreams

### WS0 — exact evidence and regression attribution

- Seal exact source/build/dirty state and replay the saved week-old and current bundles on the same
  moving-altitude route.
- Record selected terrain tiles, PVS survivors, commands per frustum/pass, effect executions, MRT
  attachment/resolve bytes, terrain objects/closures/upload bytes, cache live/high-water/retired bytes,
  and covered/uncovered CPU/GPU time.
- Repair unique timestamp-sample accounting and deterministic offline Viewer boot.
- Populate a certifying visual manifest from manually accepted, current-producer evidence.
- Close the fork-extension coverage matrix and physical adapter/load-store/multi-context/loss/double-
  tax/lifetime matrix.

### WS1 — correctness closure before authority changes

Finish the Campaign 8 Gate-B lane: voxel and CV proofs, integer-normalized certification, immutable
PickQuery contract review, multi-frustum packed depth, classification depth lifetime, TAA depth/jitter
identity, polyline velocity, billboard orientation, voxel-inside camera, and conditional product fixes.
Then rebuild a new exact-current correctness checkpoint. Broad upstream contract failures run in
parallel and must all be green by final certification.

### WS2 — default-path performance recovery

- Make zero-strength dither and zero-consumer celestial work truly zero-work.
- Lazily open the canvas render pass.
- Demand-gate scheduler/SceneOctree maintenance and debug profiler closures.
- Make MRT topology consumer-driven.
- Retain terrain command/descriptors and scratch storage, prepare one effects handle per view, and
  split static tile/material uploads from dynamic view data.
- Deduplicate exact immutable imagery-source realizations, release them with quadtree tile lifetime,
  and move full mip preparation from private draw-path submits into frame-owned/off-hot-path work.
- Make ground-atmosphere integration one-stage-per-variant.
- Add direct zero-work-disabled clustered-light coverage and complete settled Model frontend/group-1
  revision caches.

Each promoted automatic optimization must show at least a 5% improvement in its named unsaturated
p95 stage or exceed three times measured noise, while preserving every on/off/restored oracle.

### WS3 — serial-safe residency and off-hot-path preparation

Land FAR-200's physical queue timeline, submit-source adoption, and serial-owned retirement. Then
activate terrain byte-budgeted residency, ResourcePlan observe/active pilots, terrain/mesh and
immutable-texture ownership verticals, and the decoded-product/realization split gate.

### WS4 — effect visibility without lost functionality

Define the feature execution contract, then add conservative FFT-ocean patch/horizon gating,
flow-field draw/compute continuity, cubemap per-face candidate culling, a capture-view selection
vertical, and a complete fullscreen/compute/shadow/cloud/weather audit. A feature with unknown bounds
continues to execute.

### WS5 — precision and temporal closure

Inventory and convert previous-frame velocity paths, GPU visibility data, point cloud/vector tile
paths, cloud/fog history, collection view uniforms, Hi-Z, and natural-frustum TAA to exact
camera-relative/view-versioned contracts. Test ground/orbit, poles, antimeridian, negative coordinates,
teleports, 3D/2D/CV/morph, and millimeter-to-meter motion.

### WS6 — ownership, graph, picking, pacing, and final certification

Complete contiguous pick-ID ownership, native feature ranges, material tables, the shadow frame graph,
bounded node migration, graph-owned depth, graph-owned pick mini-frames, timestamp coverage, truthful
display-paced/maximum-throughput tooling, and only then safe automatic GPU cull/Hi-Z/sort/indirect
restoration. Finish with shared upstream suites and one new exact-current final evidence bundle.

## 6. Dependency and gate model

| Gate | Required evidence | Blocks |
| --- | --- | --- |
| A — launch/attribution | Exact source and build identity; saved/current moving-route replay; clean/API lanes; known-error ledger; deterministic local boot | Performance claims |
| B — bounded correctness | Campaign 8 items 2–10 and FAR-107 premise/contract outcomes; FAR-200 S1 shadow timeline with no caller migration; new checkpoint 11; exact WebGL/WebGPU semantic and visual oracles | MRT topology, production submit-source migration, ownership, and depth authority changes unless a documented amendment is approved |
| C — default hot path | R1 no-op gates plus retained terrain, demand-driven MRT, atmosphere, and model/cluster slices; feature on/off/restored evidence | Performance-recovery promotion |
| D — timeline/residency | FAR-200 serial/loss/abandon tests; terrain repeated-altitude plateau; cache lease/retirement/recovery matrix | Active ResourcePlan and native ownership |
| E — visibility/RTE | Numeric precision oracle; temporal/depth identity; hidden/reveal/clock-jump continuity; complete view/mode matrix | Safe automatic GPU visibility restoration |
| F — ownership | Two native ownership verticals pass no-double-tax, mixed-context, recovery, mutation, and retirement tests | Decoded/realization split and graph tail stop/go |
| G — final | Shared upstream suites, full fork matrix, accepted visuals, allocation/lifetime/pass/timestamp evidence, moving display-paced and supported maximum-throughput routes on one new hash | Campaign closure |

Critical ordering:

- voxel probe -> conditional voxel product fix;
- CV point proof -> conditional CV product fix;
- FAR-107 contract and FAR-200 S1 -> context-owned packed-depth/readback publication;
- FAR-200 S1 -> S2 -> S3 -> terrain eviction and active resource preparation;
- logical contiguous pick IDs plus serial publication -> native feature ranges;
- ResourcePlan observe -> active pilot -> terrain and immutable-texture ownership verticals -> split gate;
- exact RTE/Hi-Z/TAA identity -> safe automatic GPU visibility restoration;
- shadow graph -> bounded nodes -> graph depth -> graph-owned pick mini-frame;
- unique timestamp accounting -> timestamp-based performance claims;
- FAR-200 bounded in-flight work -> maximum-throughput pacing lane.

## 7. Performance promotion rule

The campaign target is both:

- at least 10% whole-route and 15% near-ground WebGPU CPU-p95 improvement against the Gate-A median,
  **or** an improvement greater than three times the measured run-to-run noise when those percentages
  are not statistically distinguishable; and
- no route-segment p99 regression beyond measured noise, no WebGL regression beyond the declared
  budget, no feature loss, and no cache/lifetime growth without a proven plateau.

Use at least five order-counterbalanced repetitions per renderer for a blocking claim. Report CPU
frame time, completed GPU time where supported, renders/second, command/pass/attachment/upload/
allocation rates, memory high-water, compilation, GC/long tasks where available, and the unprofiled
remainder. FPS alone is not evidence.

## 8. Rollback and landing discipline

- Land one concern per slice and keep an internal context-creation A/B switch only while stabilizing.
- Roll back a failing optimization slice, never the feature or its public default.
- Instrumentation and regression tests survive rollback.
- A cache slice needs mutation, resize, destroy, device-loss, lease, serial, and plateau tests.
- A topology/shader/RTE slice needs current WebGL and WebGPU semantic/visual evidence plus historical
  renderer inspection where an accepted baseline exists.
- An effect gate needs enabled, disabled, hidden, reveal/resume, mutation, and clock-jump oracles.
- Every completed task records exact source/build identity, before/after metrics, tests, visual
  artifacts, known limitations, and the next dependency it unlocks.

## 9. Deliberately deferred beyond Campaign 9

Full GPU-resident tiles, broad render-bundle conversion, WASM traversal, full GPU LOD, NATIVE_DEVICE
sharing, FSR2, the license-clean STBN/TAAU asset tranche, cloud impostor LOD, ocean cascades/clipmaps,
and other feature-expansion epics remain separate RFC/campaign work. They are not substitutes for
fixing the current default renderer. Campaign 9 retains a small evidence-gated tail for already
measured cache/bounds/motion refinements, but does not automatically activate these larger epics.
