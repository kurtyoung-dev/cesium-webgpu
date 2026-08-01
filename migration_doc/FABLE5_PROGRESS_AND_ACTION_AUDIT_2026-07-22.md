# Fable 5 Progress and Recommended-Action Audit — 2026-07-22

Status: **COMPLETE — FINDINGS DOCUMENTED AND ACTIONS RE-AUDITED**

Source range: `a54cc06b2aad89a00e8ecb0887b953a36f061954..851ce643891eb835adfabc78c3543b8f55275cfb`

Current source: clean `main` at `851ce64389` (`Batch 731`)

Purpose: preserve the July 15–22 fork review as a durable record, then challenge every proposed
follow-up before it becomes implementation work. A confirmed defect is not automatically the right
next performance task. This document separates those decisions.

Feature-preservation rule:

> No feature may be removed, disabled, visually degraded, or bypassed merely to improve a metric.
> Performance work must improve the implementation while preserving the explicit feature path.

---

## 1. Scope and bottom line

The audited range contains 78 commits and changes 455 files (+95,075 / -7,098 lines). It spans the
Campaign 9 close, all of Campaign 10, the landed portion of Campaign 11, and the initial Campaign 12
draft/API work.

Fable 5 made substantial, legitimate progress. The fork no longer creates a live WebGL context or
duplicate compatibility GPU buffers for an explicit WebGPU scene; major upload, bind-group, pass,
frustum, resolve, pipeline, TAA, and picking costs were reduced without deleting features. The
Campaign 9 exact-bundle result credibly closed the measured CPU gap at that checkpoint.

Current HEAD is not formally at CPU parity, however. The full six-repetition, fresh-process,
counterbalanced moving-camera lane on the current clean bundle reports:

| Metric (median across six runs) | WebGL | WebGPU | WebGPU / WebGL |
| --- | ---: | ---: | ---: |
| `Scene.render` CPU p50 | 3.45 ms | 4.20 ms | 1.217 |
| `Scene.render` CPU p95 | 8.235 ms | 9.30 ms | 1.129 |
| `Scene.render` CPU average | 5.204 ms | 4.818 ms | 0.926 |
| Presented FPS (diagnostic, display-paced) | 52.77 | 55.46 | 1.051 |
| Wall p99 | 22.557 ms | 21.184 ms | 0.939 |

Every matched repetition has higher WebGPU p50 and p95. WebGL's worse average/wall/FPS values come
from exactly seven recurring 100–205 ms long tasks per run (5.2–6.5% of each measurement window);
WebGPU records zero. These are two distinct optimization problems:

1. WebGPU has a higher steady-state CPU floor.
2. WebGL has deterministic long stalls that dominate presented cadence and tail latency.

Do not collapse them into a single “which renderer is slower?” conclusion.

Current six-run artifact:
[`audit-2026-07-22-moving-clean-r6-action-review.json`](../Tools/visual-regression/output/performance/audit-2026-07-22-moving-clean-r6-action-review.json).

---

## 2. Verified progress since July 15

### 2.1 Campaign 9 — real default-path CPU and allocation work

- Explicit WebGPU initialization disables compatibility GPU-buffer allocation; the WebGL stub
  retains only logical CPU metadata/payload needed by shared scene code.
- Shared core conventions moved toward context-owned state: graphics capabilities, clip-space
  convention, resource identity, full shader-define identity, and device/effect cache discipline.
- Default-path material-ID maintenance, canvas pass opening, celestial work, tonemap writes,
  texture realization, imagery sharing, model/material bind groups, and terrain command closures
  became demand-driven or retained.
- The exact Campaign 9 close artifact moved WebGPU/WebGL CPU-p95 ratio from 1.37 to 0.98. This is a
  credible claim for that exact bundle and environment, not a permanent claim for later HEADs.

### 2.2 Campaign 10 — structural, bandwidth, boot, and pick correctness

- Default 3D frustum count collapsed from two to one.
- Scene-color MSAA resolve frequency fell from nine segment resolves to one demand resolve.
- Previous-frame/velocity data uses GPU copies where applicable instead of CPU re-upload.
- Texture mip chains and first-use/prewarm work improved; model color-pipeline compilation gained an
  asynchronous path.
- Pick shaders, depth plane, and log-depth encoding were brought onto a coherent contract.
- Campaign 10 correctly avoided a wall-clock performance banner when both backends slowed under an
  environment-confounded checkpoint; deterministic pass-count evidence remained useful.

### 2.3 Campaign 11 — major ocean fix plus partial optional-feature work

- A stable ocean-normal source no longer performs `copyExternalImageToTexture`, mip generation,
  view creation, and bind-group churn every tile/frame. This was a genuine high-impact defect.
- OIT became reachable from additional primitive/model/collection paths, but remains default-off and
  is not covered by current parity evidence.
- Upload diagnostics, star-map modulation work, and explicit reversed-Z investigation landed.
- The real moving+dense re-measure (`C11-168`) and measurement-hardening follow-ups remain open.

### 2.4 Campaign 12 — draft only

- T3/T5 skybox selection API landed, but T5 faces are not in the repository. T3 remains the safe
  default. Selecting T5 currently requests missing files; this is an opt-in incomplete feature, not
  a default renderer regression.

---

## 3. Current evidence and claim boundaries

### 3.1 Performance and API evidence

- Six-run current clean CPU lane: artifact linked in §1; all 12 runs passed route/quality checks and
  covered all eight continuous segments.
- WebGPU timestamp characterization: GPU p95 7.194 ms at 1280×720; WebGL has no comparable GPU timer,
  so this is not GPU-parity evidence.
- API lane (observer-inflated timing; counters only): approximately 10.40 render passes, 1.001
  submissions/command buffers, 1.013 bind groups, and 9.93 writes per WebGPU frame. Only one texture
  and one external-image copy occurred across the route. The C9 allocation/submission wins persist.
- The API route also created 700 terrain buffer triplets, retired 187 rebuilds, and retained 513 live
  tile entries (about 5.84 MB) after one flight.
- Across 1,194 API-observed WebGPU frames, 6,286 scene-framebuffer opens (5.265/frame) all carried the
  second `rgba16float` normal/roughness attachment and its resolve target. Of those, 3,819
  (3.198/frame) recorded no draw calls, although load/store/resolve work means they are not
  necessarily free GPU passes. At 1280×720/MSAA4, slot 1 reserves about 36.86 MB between its
  multisample and resolved textures.
- The same route recorded one MSAA depth-resolve pass per frame and 2,546 globe-depth pack passes
  (2.132/frame). This proves topology frequency, not that every pack/clear is redundant.

Artifacts:

- [`audit-2026-07-22-moving-api-r1.json`](../Tools/visual-regression/output/performance/audit-2026-07-22-moving-api-r1.json)
- [`audit-2026-07-22-moving-gpu-timestamps-r1.json`](../Tools/visual-regression/output/performance/audit-2026-07-22-moving-gpu-timestamps-r1.json)
- [`audit-2026-07-22-allocation-tax.json`](../Tools/visual-regression/output/performance/audit-2026-07-22-allocation-tax.json)
- [`backend-isolation-report.json`](../Tools/visual-regression/output/backend-isolation-report.json)

### 3.2 Visual and feature-preservation evidence

The established nine-waypoint Node/Playwright camera track completed from 18,000 km orbit to literal
ground level and back to orbit on both renderers. All nine captures settled; mean cross-backend pixel
difference was 0.018%, maximum 0.074%, concentrated on globe-edge rasterization.

This validates the offline ellipsoid + repository-local NaturalEarthII path. It does not validate
real terrain elevation, water masks/ocean normals, dense 3D Tiles, optional OIT, or every post-process
consumer.

### 3.3 Allocation-tax result

The strict-native probe passed:

- one WebGPU canvas context;
- zero WebGL/WebGL2 canvas contexts;
- zero compatibility GPU buffers;
- compatibility-shaped textures reported separately without evidence of duplicate physical upload.

The earlier WebGL-object-then-WebGPU-object physical double tax is therefore not the current default
problem. Small logical CPU payloads remain by design until shared scene code is fully backend-neutral.

### 3.4 Build and test evidence

- `npx tsc --noEmit`: pass.
- `npx gulp build --workspace engine`: pass.
- ESLint over every changed engine/app/spec/probe/script file in the audited range: pass.
- WebGPU-focused Karma: 1,578 / 1,579 pass. The one red is a contradictory sync-pick cache spec
  introduced in the same commit as the widened moving-cursor contract.
- `GlobeSurfaceTileProvider`: 57 / 57 pass.
- `Scene/Pick`: 268 / 268 pass.
- `RenderScheduler`: 2 / 2 pass.
- Full engine suite stopped at 4,627 / 17,199 after six upstream Ion/world-terrain tests attempted
  blocked external requests; it is not a complete green or red fork result.
- The global lint command remains red on 776 unchanged `.claude/workflows` template errors outside
  the audited source range.

Test growth is meaningful (34 new engine Spec files, 191 direct `it(...)` cases), but integration
coverage did not keep pace: Batches 714–728 changed 12 engine source files with no engine Spec change.

---

## 4. Findings register

| ID | Finding | Default-path exposure | Current assessment |
| --- | --- | --- | --- |
| `F5-01` | Current HEAD is not CPU-parity certified; WebGPU p50/p95 are consistently higher while WebGL has deterministic long stalls | Yes | Confirmed by r6 |
| `F5-02` | WebGPU terrain-buffer lifetime is disconnected from Cesium's quadtree LRU/free lifecycle | Yes, moving globe | Confirmed |
| `F5-03` | One mutable globe renderer is shared per `GPUDevice`; tile keys omit context/provider identity | Multi-view/split/provider churn | Confirmed architectural risk |
| `F5-04` | Attachment demand is observe-only; default scene still allocates/opens/stores/resolves MRT slot 1 | Yes | Confirmed waste; payoff not isolated |
| `F5-05` | SceneOctree plane-mask results are compared with `Intersect` enum values | No; opt-in | Confirmed broken optional path |
| `F5-06` | Enabled RenderScheduler bins/sorts private layers that neither renderer consumes | No; opt-in | Confirmed duplicate optional work |
| `F5-07` | Async model color-pipeline completion can republish stale variants after non-format invalidations | Toggle/first-use | Confirmed correctness race |
| `F5-08` | Device-loss walker and model-feature-pick teardown miss active cache/resource families | Loss/churn | Confirmed lifecycle gaps |
| `F5-09` | `reuploadWatch` is an unbounded global map; source replacement can orphan textures; one bound function is allocated per visible model/frame | Partly yes | Confirmed small-to-growing debts |
| `F5-10` | OIT composite bind group is rebuilt and its derived-pipeline key is insufficiently specific | No; OIT default-off | Confirmed before enablement |
| `F5-11` | `Renderer/ResourceOwnership` is a non-integrated scaffold and `DecodedPayload` copies bytes | No | Confirmed; not a current fix |
| `F5-12` | Critical integration tests are missing; one WebGPU spec contradicts its implementation contract | CI/maintenance | Confirmed |
| `F5-13` | Live document index/queue statuses contradict landed commits and campaign closure | Process | Confirmed |
| `F5-14` | Split-screen comparison does not initialize both viewers; T5 API names missing assets | Optional tools/features | Confirmed |
| `F5-15` | The harness records six `counterbalancedPairs` for six repetitions, although that schedule contains three pairs; the field is copied but not enforced | Measurement provenance | Confirmed |
| `F5-16` | Model feature picking eagerly allocates per-feature IDs during ordinary rendering, while model-level pick IDs/texture lack teardown | Dense models/3D Tiles | Confirmed; quantify before demand rewrite |
| `F5-17` | WebGL's seven route-position stalls align with seven program/fourteen shader creation events and synchronous link-status checks | Yes, first-use variants | Leading hypothesis; trace before fixing |
| `F5-18` | Default WebGPU resolves MSAA depth once per frame even though the audited route has no active depth consumer | Yes | Confirmed pass; consumer inventory required before gating |
| `F5-19` | Eager scene-pass reopening produces many no-draw pass boundaries; globe-depth packing also runs more than twice per frame | Yes | Confirmed topology cost; redundancy not yet fully classified |

### 4.1 Important impact classifications

- `F5-02` is a default-path unbounded residency defect, but it is primarily a long-flight memory and
  revisit-stability problem. It is not yet evidence for the short-route WebGPU CPU-p95 gap.
- `F5-03` is a serious multi-view correctness/scalability defect. It does not explain the current
  single-view benchmark.
- `F5-04` is the strongest identified candidate for fixed per-frame GPU/bandwidth waste, but no
  controlled one-target/MRT measurement yet proves it is the dominant gap.
- `F5-18` is a smaller, better-bounded default-path candidate than the MRT rewrite. Its reader list
  must include TAA, motion blur, atmospheric/volumetric effects, depth effects, picking, and unknown
  consumers conservatively; an incomplete gate would trade performance for broken features.
- `F5-19` proves excess boundaries, not that all depth packs or clears are removable. Cesium's
  per-frustum depth semantics remain load-bearing.
- `F5-09`'s upload sentinel is diagnostic heap debt, not a headline frame-time lever. The residual
  ocean issue is source-swap/multi-view lifecycle; the static single-view upload storm is fixed.
- `F5-17` is not a newly introduced Fable regression: the same seven WebGL stalls are present in the
  Campaign 9 evidence. Synchronous shader compilation is the leading explanation, not a conclusion.

### 4.2 Code/evidence chain behind the corrected recommendations

**Terrain lifetime.** Cesium already has the right high-level owner. `TileReplacementQueue.trimTiles`
calls `QuadtreeTile.freeResources`, which reaches `GlobeSurfaceTile.freeResources`; WebGL vertex
arrays follow that lifetime. WebGPU terrain entries instead live in
`WebGPUGlobeSurfaceTileBuffers.ts` under coordinate-only keys, retain CPU vertex arrays, and are not
released from that path. The API lane shows the consequence: WebGL created 1,001 buffers and deleted
996 (net +5), while WebGPU created 2,102 and destroyed 561 (net +1,541); terrain cache entries grew
53→566, consistent with 700 misses − 187 rebuild retirements = 513 retained entries. The final frame
had only 26 commands. The defect is therefore proven even though its short-run FPS effect is not.

**Submission safety.** `Scene.render` calls `globe.endFrame`—where quadtree trimming may free a tile—
before `context.endFrame` submits the WebGPU command encoder. Immediate buffer destruction from the
quadtree path can invalidate commands recorded earlier in that frame. The existing
`scheduleTextureDestroy`/post-submit batch is the right local precedent for a generic resource queue.

**Ownership domains.** `WebGPUDevicePool` intentionally shares a device, while
`GlobeSurfaceTileProviderRendering.js` stores one mutable globe renderer per device. That renderer
captures the first context's central pipeline cache/readiness monitor, compares context-local format
generation integers, ages bind groups using unrelated scene frame numbers, and shares provider
terrain/ocean state. The correction is a three-way split—device-immutable resources, context/view
state, and globe/provider residency—not disabling device sharing or cloning everything per viewer.

**Topology.** `forceSceneMRT` remains true and `WebGPUSceneFBTargetHelpers.ts` keeps module-global MRT
mode. More subtly, the proposed late switch in `updateAndClearFramebuffers` occurs after
`Scene.updateEnvironment` has already looked up scene pipelines. The requested context topology must
be published during `prepareFrame`, then prewarmed and committed atomically at a frame boundary.

**WebGL stalls.** Every r6 WebGL run records exactly seven long tasks at the same route positions; the
API lane also creates exactly seven programs and fourteen shaders. `ShaderProgram.js` synchronously
compiles, links, and queries `LINK_STATUS`. A trace/timed diagnostic should prove this attribution
before selecting `KHR_parallel_shader_compile`, prewarming, or another ready-gated implementation.

**Feature picking.** `WebGPUModelFeatureId.js` accepts `pickPassActive` but eagerly creates per-feature
IDs on the ordinary model path. Its model-level pick-ID map and GPU texture are omitted from teardown.
This is a real dense-content allocation/lifetime issue, but demand realization must rebuild retained
bind groups atomically; an isolated boolean guard is not a safe fix.

### 4.3 F5-17 superseding result — 2026-07-28

F5-17 is no longer only a leading hypothesis. API chronology proved that the seven route-position
long tasks are blocking first-use `LINK_STATUS` waits. The static-variant baseline created seven
programs/fourteen shaders, paid seven waits totaling 753.9 ms, and recorded seven long tasks.

The first attempted remedy—automatically scheduling every cache-created base and derived
program—was a measured regression in architecture and work volume. It created 28 programs/56
shaders, retained the same seven required waits, and completed 21 programs that were never used.
That eager policy was removed. Cache creation remains lazy; asynchronous preparation is explicit
opt-in only.

The accepted implementation gives `ShaderProgram` a pending lifecycle around
`KHR_parallel_shader_compile`, with `COMPLETION_STATUS_KHR` polling and deferred link
validation/reflection. An unexpected first bind/getter, missing extension, or lack of idle time
synchronously completes, preserving every draw. `ShaderCache` separates required compilation from
an idle preparation queue, and the scheduler selects the exact camera-visible final executable in
normal derivation order: log depth, HDR, then shadow receive.

For the globe, speculation is bounded to one opposite-FOG companion for the zero- and
one-imagery-texture cohorts. Persistent `fog.configuredEnabled` carries the user's configuration
while per-frame `fog.enabled` says whether the current camera may render fog; using the former for
the companion allows orbit idle time to prepare the fog-on descent variant without changing the
current draw. Shadow-active, translucent/OIT, debug/pick/depth, and greater-than-one-texture
variants are excluded. Acquire-before-release replacement and wrapper poisoning prevent stale
culled tiles from reusing a released program.

The final measured policy creates eight programs/sixteen shaders. Seven reach a real draw and one
companion is unused; four complete asynchronously, while four still block for 435.1 ms total and
produce four long tasks. `firstDrawProgram` now distinguishes real draws from `useProgram`, and
`globeShaderRequests` records camera height, configured versus renderable fog, texture cohort,
exact FOG/log-depth/HDR/shadow selection, companion eligibility, and preparation/pending counts.

The clean r3 route passes with 1,175 measured frames, CPU p95 7.43 ms, CPU p99 10.152 ms, and four
long tasks (502 ms total, 139 ms maximum). The current nine-waypoint WebGL/WebGPU/diff image set
also passes visual inspection with functionality intact. Those are reported measurements, not a
before/after delta. This is a bounded work-avoidance result — three fewer blocking `LINK_STATUS`
queries issued on the measured route — not a certified frame-time win and not full renderer-wide
elimination: four first-encounter stalls remain across the quantization ×
zero/one-texture cohorts, every excluded family remains future measured work, and the changeset is
still uncommitted (`C11-180` = PARTIAL), so the counterbalanced timing gate stays open.

---

## 5. Second-pass action decisions

Decision vocabulary:

- **DO FIRST** — evidence is sufficient and the action either fixes measurement validity or a live,
  bounded default-path defect.
- **PROVE WITH A/B** — the mechanism is real, but payoff/risk must be isolated before implementation.
- **FIX EARLY** — correctness/lifecycle work that should land soon but is not the first performance lever.
- **FIX LATER** — valid optional-path work that must not displace default-path investigation.
- **DO NOT PURSUE AS PROPOSED** — the original implementation shape is unsafe or premature; a
  replacement direction is specified.

| Order | Action | Decision | Why / required shape |
| ---: | --- | --- | --- |
| 0 | Reconcile live queue/index truth | **DONE IN THIS AUDIT** | Campaigns 9/10 now read closed, C11-167 is complete, C11-168 is partial, and the README points here. The dated coverage matrix remains intentionally frozen and needs a successor |
| 1 | Harden and complete the representative baseline | **DO FIRST** | Correct pair provenance; measure refresh for display claims; independently classify long tasks; add release/minified, real terrain/water, and dense local 3D Tiles/model lanes; keep clean/API/GPU/trace lanes separate |
| 2 | Attribute both measured bottlenecks | **DO FIRST** | Trace one run/backend with route markers. Time WebGL compile/link/status and uploads; profile the WebGPU high-altitude fixed CPU floor. Treat shader compilation only as the leading WebGL hypothesis |
| 3 | Add failing ownership/lifetime tests and generic post-submit retirement | **DO FIRST** | Generalize the context's batched texture-retirement pattern to buffers/resources. A quadtree tile can be freed before `WebGPUContext.endFrame()` submits, so inline destruction is unsafe |
| 4 | Correct globe renderer ownership domains | **FIX EARLY / PREREQUISITE** | Split device-immutable shared resources, context/view format/readiness/frame state, and globe/provider terrain/material residency. Do not duplicate the full renderer per context and lose legitimate sharing |
| 5 | Connect WebGPU terrain realizations to quadtree lifetime | **FIX EARLY** | Key by tile/payload + mesh revision + exact descriptor + context/device generation; release leases from quadtree/free/rebuild/provider paths; retire post-submit; then add a byte-budgeted zero-lease grace LRU and move realization out of command emission |
| 6 | Fix and measure model feature-pick ownership | **FIX EARLY** | First add one-time teardown for shared texture and all pick IDs, then measure eager allocation in the dense lane. A naïve `pickPassActive` guard would leave retained bind groups pointing at placeholders |
| 7 | Repair ocean source ownership; harden the sentinel separately | **FIX EARLY / QUICK LATER** | Source-keyed/revision-aware leased ocean realizations with post-submit retirement fix swap/multi-view behavior. Make `reuploadWatch` scoped, bounded, and count only physical attempts; do not sell the sentinel as FPS work |
| 8 | Demand-gate the unconditional MSAA depth resolve | **FIX EARLY AFTER INVENTORY** | The default route pays exactly one resolve pass/frame with no reader. Build a complete conservative demand record first; unknown readers force resolve and all enabled effects keep exact output |
| 9 | Elide unused MRT/G-buffer topology | **PROVE WITH A/B** | Run the C11-50 normal payoff/quality probe and inventory all scene-pass pipelines; replace global mode with a context-owned immutable topology signature; cache exact one-target/MRT variants; promote only after GPU/API/visual A/B |
| 10 | Instrument pass ownership, then reduce empty boundaries | **PROVE AND FIX INCREMENTALLY** | Add pass-owner/reason counters; gate only provably empty globe packs and lazily reopen a scene pass at first work. Preserve per-frustum clears/order and defer broader depth repacking |
| 11 | Add a generic async invalidation epoch and complete loss-family teardown | **FIX EARLY CORRECTNESS** | Delayed-promise race tests, cache-owner invalidation protocol, destruction idempotence, and device-recovery tests; not a current globe-FPS explanation |
| 12 | Repair SceneOctree and RenderScheduler enabled semantics | **FIX LATER** | Default-off paths do not explain current performance; octree needs eligibility/bounds/shadow/order semantics, not only an enum fix; scheduler layers must actually be consumed by both renderers |
| 13 | Repair OIT cache identity/reuse before default consideration | **FIX LATER** | Keep feature reachable/default-off; add intersecting-translucency, resize, MSAA, format, and device-loss gates |
| 14 | Integrate ResourceOwnership wholesale | **DO NOT PURSUE AS PROPOSED** | It has no live consumer and currently copies bytes. Pilot concrete zero-copy tile/texture leases first; do not introduce a parallel abstract command/resource system |
| 15 | Reconcile remaining tests and incomplete optional APIs | **DO IN PARALLEL** | Fix stale pick expectation, grow focused integration coverage, repair split-screen, and either supply T5 assets or prevent selecting an unavailable variant |

### 5.1 Rejected implementation shortcuts

1. **Do not call `evictStaleResources(visibleTileKeys)` every frame or wire it directly to
   `freeResources()`.** Non-visible quadtree tiles are intentionally retained by Cesium's LRU; the
   helper scans the renderer cache, destroys inline before current-frame submission, omits the
   wireframe cache, and keys by coordinates. Replace it with lease release plus batched post-submit
   retirement, then retain a bounded zero-lease grace set.
2. **Do not flip the module-global MRT flag per frame.** Multiple contexts sharing one JavaScript
   realm can require different topology; cached pipelines would become cross-context incompatible.
   Topology must also be selected during `prepareFrame` (before environment pipeline lookup), not
   later in `updateAndClearFramebuffers`.
3. **Do not route globe terrain through SceneOctree.** Globe terrain remains owned by the established
   `QuadtreePrimitive`; SceneOctree is for eligible general commands.
4. **Do not use a feature toggle as a benchmark-only removal.** Disabled/OFF measurements are A/B
   attribution controls; the shipped fix must preserve the enabled feature.
5. **Do not treat an in-Viewer checkbox as proof that browser compositor vsync is disabled.** Keep a
   display-paced lane and add an explicit max-throughput driver/browser protocol whose behavior is
   verified and recorded.
6. **Do not integrate the ownership scaffold across the renderer until it has a zero-copy payload
   contract and one concrete, measured consumer.**
7. **Do not remove/reorder per-frustum depth or stencil clears as a pass-count shortcut.** They are
   coupled to multi-frustum depth-plane, translucency, classification, picking, and post-process
   semantics. Fold or gate only a boundary whose owner/reason and successor are proven equivalent.
8. **Do not add only the SceneOctree mask-enum one-line fix.** The opt-in path also lacks complete
   `cull`/`occlude`, root-bounds, translucent 3D Tiles, ordering, and off-camera shadow-caster
   semantics; changing the enum alone activates broken culling.
9. **Do not demand-gate feature picking only at ID creation.** Existing retained bind groups would
   continue referencing placeholders. Fix teardown first, measure dense content, then introduce an
   atomic realization/bind-group revision contract.

---

## 6. Revised execution queue and acceptance gates

### Gate 0 — trustworthy evidence before another performance claim

1. Measure effective display refresh with a no-op rAF calibration and pass it into frame-pacing
   summaries.
2. Make long-task occupancy an independent warning/failure dimension; timestamp backpressure must
   not be required for a CPU long-task warning.
3. Reject odd two-renderer repetition counts in certification mode, derive the real pair count from
   repetitions, and report the resolved schedule rather than copying unvalidated manifest intent.
4. Add a max-throughput lane without claiming a normal web page can toggle compositor vsync.
5. Add at least one local real-terrain/water-mask route and one dense 3D Tiles/model route with exact
   content identity. If a fully local terrain fixture is not available, build one before claiming
   terrain/water performance.
6. Add CDP tracing around one WebGL and one WebGPU route to attribute the WebGL stalls and WebGPU
   steady-state CPU floor.
7. Record maintainer-representative canvas size, DPR, resolution scale, adapter/power state, and run
   both unminified diagnostic and release/minified lanes.

Acceptance: six even counterbalanced fresh-process runs, exact source+bundle+browser+adapter identity,
full route, no external requests, measured refresh for display-paced claims, independently classified
long tasks, and separate clean/API/GPU/trace artifacts. Measured refresh is not a blocker for
CPU/GPU optimization; it is a blocker for honest dropped-frame/presented-FPS certification.

### Gate 1 — bounded resource lifetime without churn

1. Add failing lifecycle/multi-context tests before changing ownership.
2. Generalize `WebGPUContext`'s batched, post-submit texture destruction into a resource-retirement
   queue for buffers and textures. Do not create one `onSubmittedWorkDone()` promise per tile.
3. Split the globe's ownership domains:
   - immutable shader/layout/sampler/source resources may be refcounted per device;
   - HDR/MSAA/log-depth/pick/readiness/frame state belongs to the context/view;
   - terrain, wireframe, imagery, water/ocean, and material leases belong to the globe/provider.
4. Key terrain realizations by tile/payload identity, mesh/content revision, exact layout/descriptor,
   context domain, and device generation—not coordinate string alone.
5. Release from `GlobeSurfaceTile.freeResources()`, mesh/fill replacement, invalidation, provider
   replacement, context destruction, and device loss. Queue last-lease destruction after submission.
6. After correctness, add a byte-budgeted grace LRU for zero-lease entries and move native terrain
   realization into tile preparation/readiness rather than command emission.
7. Convert ocean normals to source/revision-keyed leased realizations; separately scope and bound
   `reuploadWatch`, recording only validated physical realization attempts.

Acceptance: resource creates/destroys/live bytes plateau; no destroyed-resource reuse; out-and-back
second leg has materially more hits than cold; WebGL ownership remains unchanged; device loss and
two-context same-device cases pass. Include fill→real mesh, exaggeration rebuild, wireframe,
shadow/pick/capture use, two providers with identical coordinates, destroying one shared-device
context while the other continues, ocean swap/removal, stable animated waves, and request-render
wakeups.

### Gate 2 — isolate and, only if worthwhile, consume attachment demand

1. Inventory every MSAA-depth reader and demand-gate the currently unconditional resolve. Include
   TAA (which samples depth despite a stale source comment), motion blur, aerial perspective, god
   rays, DoF/AO, SSR/NPR/contact shadows, clouds/fog/ground fog, picking, and conservative unknowns.
2. Run C11-50's normal payoff/quality probe and inventory every scene-pass pipeline before changing
   color topology.
3. Replace module-global topology state with a context-owned immutable signature containing target
   count/formats, depth format, and sample count. Include it in shader, pipeline, render-target, and
   pass-descriptor identity; retain exact one-target and MRT variants. Every `emitsGBuffer` producer
   needs a real one-target shader with no `@location(1)` output—not merely a shorter target array.
4. Compute/publish demand during `prepareFrame`, before `Scene.updateEnvironment()` builds or fetches
   sky/atmosphere/sun/moon pipelines. `updateAndClearFramebuffers()` is too late to select topology;
   it may only consume/reconfirm the already-published signature.
5. Treat topology changes as a two-phase frame-boundary transition: publish the requested signature,
   asynchronously prewarm the required visible/deterministic variants while rendering the old
   topology, then atomically commit only when ready. Unknown or not-ready remains on MRT; keep both
   exact variants warm so later toggles are immediate.
6. Keep forced MRT while wiring the contract. Then build a conservative one-target default only when
   the canonical demand record has no G-buffer consumer; unknown consumers force MRT.
7. Run at least three exact-bundle Node-driven moving-route clean/API repetitions with GPU timestamps
   for forced-MRT, one-target, and restored-MRT states before promoting. Re-gate deferred lighting,
   SSR, SSGI/AO, NPR, contact shadows, debug overlay, TAA, MSAA, OIT, picking, resize, 2D-wrap,
   capture, and device loss.
8. Add pass-owner/reason counters. Lazily open/reopen a scene pass at first work and gate only a
   post-globe pack whose frustum has zero globe commands. Preserve pass order and depth/stencil
   semantics; descriptor caching alone is allocation hygiene, not the main lever.

Acceptance: default no-consumer frames allocate/open/resolve no slot 1; each consumer independently
restores MRT; enabled output is preserved; measured gain exceeds noise; multi-context topology does
not cross-contaminate. Default no-depth-consumer frames also skip the MSAA depth resolve, while every
reader restores it. Pass-count reductions must name the removed owner/reason and prove identical
clear/load/store ordering. Mid-session topology changes must show no missing-draw frames while
asynchronous variants compile, not merely an error-free restored final image. Two interleaved WebGPU
viewers with different topology must pass. Require stage-level GPU-time improvement beyond noise,
unchanged CPU percentiles, zero validation errors, and no new pipeline, bind-group, or transient-
allocation churn; presented FPS is supporting evidence only.

Depth demand and actual resolve opens are separate assertions: default MSAA4/no reader = zero opens;
each real reader = exactly one; TAA at MSAA1 may demand depth while opening zero resolve passes;
unknown readers conservatively resolve.

### Gate 3 — lifecycle correctness

1. Complete model-level feature-pick ID/texture destruction first and measure ordinary-render eager
   allocation in the dense-content lane. Design demand realization only with atomic bind-group
   revision/rebuild semantics.
2. Generic pipeline invalidation epoch covering format, log depth, split, color, silhouette,
   topology, destruction, and device generation.
3. Owner protocol for every per-object WebGPU cache family during device loss; current walking of
   `_webgpuCache` misses label and polyline cache families.
4. Complete source-swap ownership and destruction idempotence.

Acceptance: delayed promise resolves after each toggle without stale reinsertion; alternate cache
families recover after device loss; repeated create/destroy leaves pick registry and GPU resources at
baseline.

### Gate 4 — optional-path correctness, then broader architecture

1. Fix SceneOctree plane-mask semantics and shadow-caster preservation.
2. Make RenderScheduler layer enablement/order/clear-depth state affect both renderers.
3. Fix OIT key/reuse and re-run optional-feature gates.
4. Introduce zero-copy `DecodedPayload`/leases and async realization only through a concrete consumer;
   do not create a second abstract command system with no renderer integration.

Every optional-path gate needs a feature-on positive control. Disabling or silently bypassing OIT,
clustered lighting, scheduler, octree, shadows, or post-processing is not an accepted optimization.

Across all gates, compare against the latest `Tools/visual-regression` imagery and add temporal
sequences for TAA, RTE, and altitude transitions. A final still cannot prove history stability or
moving-camera precision. Pass-folding additionally needs numeric `pickPosition`, primitive/billboard
pick, classification, depth-plane/horizon, multi-frustum, off-camera shadow-caster, HDR, 2D/CV,
resize, and recovery checks.

---

## 7. Documentation and test reconciliation

Completed with this audit:

1. Campaign 9 and Campaign 10 headers/ledger rows now agree with their `C9-30`/`C10-30` closures.
2. Campaign 11 now records `C11-167` complete and `C11-168` partial rather than not started.
3. `DEFERRED_WORK.md` no longer presents the completed upload call-site audit as an open P0; it keeps
   the distinct sentinel and ocean-lifecycle follow-ups open.
4. `migration_doc/README.md` indexes this audit as the current non-cloud performance action-review
   authority. Campaign 11 was live at this audit's 2026-07-22 cutoff; the 2026-07-23 Campaign-13
   launch subsequently paused it and transferred its cloud/weather cluster without closing the
   non-cloud remainder. Campaign 12 remains draft.

Still required:

1. Treat `FORK_EXTENSION_TEST_COVERAGE_MATRIX_2026-07-15.json` as a frozen historical checkpoint and
   create a successor snapshot. Current static discovery is 231 WebGPU source modules, 99 WebGPU
   spec files, and 1,592 direct Jasmine `it(...)` cases versus its 227/91/1,530 snapshot; the count
   increase does not prove semantic coverage.
2. Update `DEBUGGING_GUIDE.md` to index the new performance/isolation probes and their claim limits.
3. Reconcile the WebGPU picking staging spec with the documented region-containment behavior.
4. Add production-integration tests for tile eviction, multi-context renderer isolation, attachment
   topology, async invalidation, alternate cache-family device loss, upload replacement, and OIT.
5. Repair split-screen initialization and prevent selecting T5 until its assets exist (or land and
   verify the assets under the project's distribution policy).

---

## 8. Current recommendation

Proceed, but do not start with the largest refactor.

The validated direction is:

1. reconcile ledger truth, complete representative baselines, and attribute both backend
   bottlenecks;
2. add regression tests and a context-batched post-submit resource-retirement primitive;
3. correct device/context/provider ownership boundaries before wiring terrain release;
4. bind terrain and ocean realizations to Cesium's existing quadtree/provider lifetime, retain a
   bounded warm grace set, and move realization off command emission;
5. fix and measure feature-pick ownership;
6. demand-gate the bounded MSAA-depth resolve, then run an isolated MRT topology A/B before committing
   to dynamic attachment topology;
7. instrument pass ownership and remove only provably empty boundaries without changing clears;
8. land async/device-loss correctness, then repair default-off optional architecture;
9. use the resulting concrete leases—not an abstract rewrite—as the first production consumer of the
   future resource ownership/conversion system.

This ordering targets live measured problems, preserves features, and avoids replacing Cesium's
working quadtree/resource semantics with a parallel framework.
