# Fork Performance Audit and Fix Results

Date: 2026-07-14

Last reconciled: 2026-07-15

Status: **FIRST MEASURED HOT-PATH TRANCHE RECORDED; SECOND BOUNDED TRANCHE ACTIVE; EXACT-CURRENT RELEASE GATES OPEN**

Authority: [Fork Architecture Remediation Plan](FORK_ARCHITECTURE_REMEDIATION_PLAN_2026-07-13.md)

## 1. Bottom line

The earlier fork work materially improved correctness, backend ownership, recovery, and observability, but it had not demonstrated a broad frame-time win. Some of it also introduced avoidable hot-path work: comparator normalization inside every comparison, per-tile terrain uniform queue writes, repeated depth bind groups, disabled clustered-lighting orchestration, short-lived polyline material resources, and a GPU-sort producer whose result could be configured never to be consumed.

This tranche fixed those implementation costs without removing a renderer feature, material type, scene pass, public API, default visual effect, or enabled/disabled transition. At the recorded first-tranche bundle, the moving-camera run improved WebGPU CPU p95 by **17.0%** and GPU p95 by **27.2%** against the pre-fix bundle. Instrumentation attributes the change to substantially fewer WebGPU calls and passes, not to a reduced scene. Later pick, model, and staging fixes have focused correctness/allocation evidence but do not yet have a replacement exact-current moving-flight result.

This is not the end of the architecture campaign. The fork still lacks one authoritative frame/submission graph, still contains 52 direct queue-submit sites, and still has several correctness and feature-completeness defects listed in §8.

## 2. Feature-preservation rule

Performance work in this campaign follows this invariant:

> Do not remove, default-disable, visually degrade, or bypass an existing feature merely to win a performance metric. Improve the implementation. If a feature is already unsafe or broken, keep the capability reachable, prove its explicit path, and route the defect to the post-performance correctness queue.

Consequences for this tranche:

- Exact Cesium material identity and per-instance uniforms remain intact.
- Solid, dash, glow, arrow, and outline polyline routing remains intact.
- Clustered lighting still dispatches when enabled and publishes one zero-light transition when disabled.
- Model, voxel, clear-depth, and tile depth writers retain their required depth publication.
- GPU sort remains explicitly operable; a 6,400-command forced run produced a full exact comparator permutation with output inside the measured noise floor.
- The prior FAR-003 change from automatic to opt-in GPU culling/Hi-Z/sort is a correctness containment decision, not a performance win. Safe automatic operation must be restored after identity/readback hazards are removed.
- No result in this document counts the already-contained experimental paths as saved work.

## 3. Measurement protocol

Idle soak FPS is invalid for this repository because request-render mode legitimately stops rendering when a scene is unchanged. The benchmark therefore uses the shared continuous camera route:

1. 18,000 km Pacific orbit
2. 6,000 km Americas orbit
3. 900 km Sierra descent
4. 300 km San Francisco coast
5. 60 km low oblique
6. 12 km city
7. 2.5 km near ground
8. 300 m ground
9. 2,500 km Himalaya rotation

The clean lane uses two counterbalanced repetitions: WebGL→WebGPU, then WebGPU→WebGL. It records full `Scene.render` CPU timing, WebGPU timestamp timing, FPS, 1%-low FPS, dropped/display-paced frames, long tasks, and exact route/altitude proof. The instrumented lane adds WebGL/WebGPU API counters and is kept separate because monkey-patching APIs changes timing. The recorded pre/final instrumented artifacts each use one WebGL→WebGPU repetition; they are directional call-count attribution, not timing-promotion evidence.

Environment:

- Microsoft Edge 150.0.4078.65
- Node 22.23.1
- Windows 10.0.19045
- Intel i7-3770K, 8 logical CPUs
- 1280×720, device scale 1
- fixed clock; local grid/ellipsoid content; default globe feature profile

Artifacts:

- Pre-fix clean: `Tools/visual-regression/output/performance/altitude-track-before-clean.json`
- Pre-fix instrumented: `Tools/visual-regression/output/performance/altitude-track-before-instrumented.json`
- Recorded first-tranche final clean: `Tools/visual-regression/output/performance/altitude-track-final-clean.json`
- Recorded first-tranche final instrumented: `Tools/visual-regression/output/performance/altitude-track-final-instrumented.json`
- Earlier strict allocation-tax characterization: `Tools/visual-regression/output/allocation-tax-final.json`
- Earlier moving visual characterization: `Tools/visual-regression/output/track-wp01-*.png` through `track-wp09-*.png`

Reproduction entry points are `Tools/visual-regression/run-performance-campaign.mjs` with `Tools/visual-regression/performance-workloads.json`, `Tools/visual-regression/probe-camera-track.mjs`, `Tools/visual-regression/probe-clustered-dispatcher.mjs`, `Tools/visual-regression/probe-gpu-sort-consume.mjs`, `Tools/visual-regression/probe-pick-multifrustum.mjs`, and `Tools/visual-regression/probe-model-instance-bg-cache.mjs`. The performance JSON `protocol` objects are the durable record of the resolved schedule and instrumentation mode. With the normal Node server already running, the strict allocation check is:

```text
node Tools/visual-regression/probe-webgpu-allocation-tax.mjs --strict-native --output Tools/visual-regression/output/allocation-tax-final.json
```

Bundle identity:

- Pre-fix `Build/CesiumUnminified/Cesium.js` SHA-256: `FA5276A3131EDEE8EEC3C3A0BDB96EB84EA925B8B466D8720EAAF6A60E3DA802`
- Recorded first-tranche final SHA-256: `D2A475A12AD60113B792C8DB8A94D02A52F7A2B635A5C2EDDCE2C7AAD637B623`
- Source anchor in both reports: `a54cc06b2aad89a00e8ecb0887b953a36f061954`, dirty remediation worktree

## 4. Recorded first-tranche results

### 4.1 Clean moving flight

Median of the two counterbalanced runs:

| Renderer / metric | Pre-fix | Recorded final | Change |
| --- | ---: | ---: | ---: |
| WebGPU CPU p95 | 8.80 ms | 7.30 ms | **17.0% lower** |
| WebGPU GPU p95 | 10.02 ms | 7.30 ms | **27.2% lower** |
| WebGPU GPU average | 7.71 ms | 5.42 ms | **29.6% lower** |
| WebGPU wall p99 | 21.85 ms | 22.15 ms | 1.4% higher; display-paced noise |
| WebGL CPU p95 | 6.73 ms | 5.10 ms | 24.2% lower in this sample |
| WebGL wall p99 | 21.70 ms | 21.41 ms | 1.4% lower |

All four recorded-final runs passed, covered all eight continuous route segments, completed the full altitude range, and reported no device/page errors.

The GPU timestamp comparison uses the same bounded scope in both builds: `between-first-and-last-timed-pass`. Mean recorded pass coverage was approximately **51.4% pre-fix** and **58.3% recorded-final**. The relative p95/average comparison is useful within this protocol, but it is not a claim of complete submitted-GPU-frame coverage; work outside the first/last timed pass remains unmeasured.

Display-paced average FPS varied from approximately 55 to 60 across otherwise faster CPU/GPU runs. The 1%-low remained approximately 45–47 FPS. This is compositor/rAF pacing evidence, not a contradiction of the CPU/GPU measurements; it is the reason §7 adds a separate capped/uncapped benchmark lane.

### 4.2 Instrumented attribution

Per rendered WebGPU frame:

| API metric | Pre-fix | Recorded final | Change |
| --- | ---: | ---: | ---: |
| Bind groups created | 11.76 | 4.94 | **58.0% fewer** |
| Render passes begun | 23.34 | 14.49 | **37.9% fewer** |
| `queue.writeBuffer` calls | 79.02 | 10.06 | **87.3% fewer** |
| `writeBuffer` bytes | 105.7 KB | 112.6 KB | 6.6% higher |
| Queue submits | 1.417 | 1.437 | effectively unchanged |

The small byte increase is the expected cost of coalescing aligned dynamic-uniform destinations: one contiguous page transfer includes alignment gaps. It trades roughly 7 KB/frame of sequential bandwidth for about 69 fewer browser/driver calls per frame. The absolute rate remains small, and the measured CPU/GPU result is favorable. A future static/dynamic terrain-UB split can reduce bytes without restoring per-tile calls.

The recorded-final instrumented run improved WebGPU CPU p95 from 9.20 to 8.70 ms and GPU p95 from 10.45 to 7.36 ms. WebGL instrumented CPU p95 improved from 7.70 to 4.70 ms; no shared-path WebGL regression was found.

The selected call reductions do not imply zero remaining allocation churn. Over the recorded-final instrumented WebGPU run's 1,115 rendered frames, the API boundary recorded 2,091 buffer creations (**1.88/frame**), 567 explicit buffer destroys (**0.51/frame**), 487 texture creations (**0.44/frame**), and 487 external-image copies (**0.44/frame**). The moving route includes streaming activity, so these counts are characterization rather than proof of a leak; HP attribution must still assign them to owners, stages, and expected lifetimes.

### 4.3 Certification boundaries

This is a first measured implementation tranche, not a release certification. The clean comparison is two AB/BA repetitions per renderer on one machine, from two different bundles built from the same dirty source anchor. Its deterministic local grid/ellipsoid route exercises the default moving globe; it does not constitute 3D Tiles, Model, or polyline performance validation. The recorded WebGL/WebGPU waypoint diffs are parity evidence, while the renderer-specific historical baseline remains non-certifying. The unrestricted Edge suite also did not complete: it reached 4,620 of 17,390 cases before restricted Ion/network teardown.

The artifact names containing `final` mean final for the measured 2026-07-14 tranche, not exact current worktree. File chronology shows the waypoint PNGs were captured before the final depth-source edits, and the strict allocation-tax artifact also predates the final source tranche. Both remain useful characterization, but neither certifies exact-current source. The clean and instrumented moving artifacts certify bundle `D2A475A...` only; the subsequently landed multi-frustum pick-pass, model group-2 cache, and pick-staging changes require a fresh build plus the complete moving-altitude visual/performance route and strict allocation probe. An idle soak cannot substitute because request-render mode intentionally pauses unchanged scenes.

## 5. Implemented architecture improvements

### Compatibility allocation tax — FAR-100 bounded fix

- The strict physical-adapter probe reports zero live compatibility `GPUBuffer` objects and zero compatibility GPU-buffer bytes at the globe, Primitive, Model, and post-removal checkpoints.
- Metadata-only compatibility handles and logical CPU stores intentionally remain: 38 handles at globe, 45 after Primitive, 51 after Model, and 38 after removal; the Model checkpoint retains 546,848 logical-store bytes while its physical compatibility-buffer count/bytes stay zero.
- This removes the measured physical compatibility-buffer double allocation without deleting legacy semantics. GL-shaped JavaScript shells still exist, and texture, vertex-array, shader ownership, sharing, and conversion remain open work.

Artifact: `Tools/visual-regression/output/allocation-tax-final.json` (`result: "pass"`, `strictNative: true`).

### Terrain camera uniforms — FAR-303 preparation

- Added CPU staging to the device-local uniform ring allocator.
- Coalesces all dirty allocations on a page into at most one `writeBuffer`.
- Flushes before command-buffer finish/submit; page retirement remains after submit.
- Starts staging at 64 KB and grows geometrically to actual peak rather than reserving a fixed multi-megabyte mirror.
- Preserves dynamic offsets, WGSL layout, binding width, and payload bytes.
- Added typed-array, alignment, repeated-flush, overflow-page, and unwritten-tail tests.

This is not the complete FAR-303 view/material/object hierarchy or static/dynamic UB split.

### Depth boundaries and bindings — FAR-405/FAR-408 preparation

- Skips the post-tile depth update only when the main 3D-tile pass has no commands.
- Skips the post-opaque repack only when no opaque, voxel, or clear-depth writer ran.
- Caches globe source-depth views/bind groups by GPUTexture identity.
- Caches MSAA-resolve bind groups by stable GPUTextureView identity.
- Invalidates caches on target destruction, resize, device change, and recovery.
- Corrected the MSAA resolve contract documentation: the output is `r16float`, not a `depth32float` attachment.
- Added focused cache reuse/invalidation and single-sample/MSAA separation specs.

This is not a demand-derived frame graph or a complete depth-version system.

### Clustered-lighting disabled path

- Initial disabled frames return before dispatcher allocation.
- Enabled frames retain the full light gather, pass split, compute dispatch, and consumer bindings.
- Enabled→disabled performs exactly one zero-count synchronization.
- Stable disabled frames perform no additional dispatch or pass split.
- Live transition probe confirms off→on→off behavior, overlap counts, and zero device errors.

### Ordering and GPU-sort producer — FAR-105/FAR-504 preparation

- Normalizes ordering fields once at sort entry instead of inside every O(N log N) comparison.
- Comparator hot loop uses normalization-free arithmetic comparisons.
- When the consumer mode is explicitly `never`, the GPU sort producer no longer uploads, dispatches, and maps an unusable result.
- Explicit `auto`/`always` behavior remains.
- A 6,400-command live forced run reported 240 dispatches, 234 consumed permutations, exact CPU-comparator match, and output inside the off/on noise floor.

The authoritative GPU scheduler and normal-frame readback removal remain open.

### Polyline collections — FAR-307 preparation

- Reuses grouping maps/arrays.
- Hoists same-material-type camera upload, pipeline resolution, and frame work out of exact-material groups.
- Retains exact material object grouping and uniforms.
- Uses a 60-frame retirement grace instead of destroying material/segment resources after one inactive frame.
- Mixed solid/dash/glow WebGL/WebGPU probe is green.

Persistent geometry, a material table/dynamic-offset design, and zero-allocation placeholder handling remain open.

### Model metadata — FAR-204 preparation

- The common no-structural-metadata negative cache validates model metadata identity in O(1).
- Models that actually contain metadata retain mutation-sensitive validation.
- `ModelPrimitiveGeometry` still deep-scans attributes/morph targets on cache hits and needs a loader-owned revision token.

### Model settled group-2 bind groups — FAR-309 preparation

- Caches the merged skin/morph/instance bind group by device, layout, and the exact seven resolved current/previous buffer identities.
- Static all-placeholder primitives reuse the pipeline cache's shared default bind group, including their first frame.
- Buffer-content writes do not invalidate an identity-stable group; buffer, layout, device-generation, and current/previous fallback changes do.
- Six focused cases cover stable reuse, shared defaults, custom-to-default transition, all seven buffer replacements, layout/device generations, and previous-buffer fallback coupling.
- A static, instanced, and animated-morph WebGPU/TAA probe held primitive group-2 identity stable and recorded zero settled group-2 creations over 40 frames.

This removes one demonstrated model bind-group allocation family. It does not claim that model binding is allocation-free: the same probe still observed 14 total bind-group creations per settled frame from other groups/owners, which require separate attribution and caching.

### Multi-frustum object-pick passes — FAR-409 preparation

- Object picking now opens one render pass for each independently projected far-to-near frustum slice.
- The object-ID color attachment clears once and then loads the accumulated farther result; depth and stencil clear for every slice so incomparable projected depths never leak between frustums.
- Precise two-pass picking remains inside each frustum slice and command order is unchanged.
- A live WebGPU probe crossed three natural frustums and returned the correct near and far objects; the WebGL leg returned the same IDs. TAA resolve activity continued from 23 to 47 with zero device/page errors.

The added boundaries are query-scoped, not normal color-frame passes. They add real command-encoding/load-store cost only when a multi-frustum object query executes; they do not clear or replace the normal TAA color, velocity, or history attachments. FAR-409 still needs query coalescing, a bounded readback pool, and graph ownership so continuous hover cannot turn independent query work into uncontrolled frame overhead.

### Minimal and request-owned pick staging — FAR-409 preparation

- `begin()` no longer allocates a full-viewport `MAP_READ` buffer. A 3×3 pick now stages one row-padded 768-byte copy rather than approximately 7.9 MiB at 1080p or 31.6 MiB at 4K.
- Synchronous reads lazily reuse one exact-size persistent buffer; each asynchronous request owns its own exact-size buffer, so overlapping sync/async queries cannot map or overwrite the same staging allocation.
- Resize, format, device-generation, delayed completion, failed allocation, failed mapping, unmap, and destruction paths reject stale cache publication and retain a reusable valid buffer where possible.
- Ten focused cases cover no-begin allocation, exact extents, overlapping requests, sync reuse, failure cleanup, and delayed resize/device ownership.

This is a bounded staging correction, not completion of the graph-owned shared readback pool required by FAR-409.

### Correctness repair found during the audit

- Fixed `PointPrimitiveCollection` initialization order so `context` exists before reading `context.limits`.
- The focused suite includes the >64K-point, rendering, distance, depth-test, and pick cases.

## 6. Verification record

- Canonical build and TypeScript compilation pass.
- First-tranche focused Edge/Jasmine: **103/103 passed** after adding the cache and multipage tests.
- Current pick-pass/model-group-2/pick-staging focused Edge/Jasmine: **17/17 passed**.
- Performance and visual-policy Node tests: **17/17 passed**.
- `git diff --check`: no whitespace errors.
- Earlier nine-waypoint visual flight: all captures settled; WebGPU/WebGL mean pixel difference **0.017%**, worst **0.073%**. Per §4.3, capture chronology makes this characterization rather than exact-current certification.
- Model `pickPosition`: WebGPU converges to the exact WebGL model surface, 0.0 m delta.
- Polyline multimaterial probe: green.
- Collection render/mutation/zero-settled-upload probe: green.
- Point/billboard sync and async picking, including three distinct point IDs: green.
- Clustered dispatcher and per-frame transition probes: green.
- GPU sort forced consumer: green.
- Earlier strict physical allocation-tax probe: green with zero compatibility `GPUBuffer` objects/bytes at all four checkpoints; command and artifact are recorded in §3. It must be rerun on the exact-current bundle.
- Live multi-frustum object-pick probe: correct near/far object IDs on WebGPU and WebGL, TAA continued resolving, and zero renderer/device/page errors.
- Live model settled-group-2 probe: stable group-2 identity and zero settled group-2 creations for static, instanced, and animated-morph fixtures; remaining bind-group churn is explicitly unclaimed.

Several probes previously failed only because Viewer boot attempted online ion resources in a network-denied environment. The moving visual gate now unconditionally installs repository-local NaturalEarthII imagery. Focused probes distinguish known Viewer boot network noise from renderer/device errors. The unrestricted Edge attempt reached only **4,620/17,390** cases before restricted Ion/network teardown, so it is not a full-suite pass. A network-enabled ion lane remains necessary; deterministic CI must not depend on it. Historical visual comparison also remains non-certifying until renderer-specific baselines are curated and approved.

## 7. End-of-queue performance tooling

### `NEW-PERF-CAPPED-UNCAPPED-LANES`

Add both minimum/display-paced and maximum-throughput measurements:

1. A Viewer checkbox and engine setting for display-paced versus uncapped render scheduling. The public name must not imply that JavaScript can directly control the OS/compositor swap interval; prefer a pacing enum plus a convenience boolean over a misleading raw “vsync” claim.
2. A Node/Edge launch mode that verifies the browser's supported no-vsync/no-frame-limit flags before accepting an uncapped result.
3. The capped moving-altitude flight remains the responsiveness/1%-low/dropped-frame lane.
4. The uncapped lane reports CPU renders/second, CPU p50/p95/p99, GPU timestamp throughput, queue/pass/write rates, and thermal/stability metadata. Presented FPS is secondary because compositor presentation may remain throttled.
5. UI and launch modes must be reported in every artifact so capped and uncapped results cannot be mixed.

## 8. Post-performance correctness and completeness queue

The dependency-ordered execution form of this section is now active in
[Campaign 8 — Correctness Closure and Renderer-Native Architecture](QUEUE_2026-07-15_CAMPAIGN8.md).
The maintainer launched that campaign on 2026-07-15. Its premise-check rule supersedes any stale
blanket statement below without erasing the audit trail.

Items discovered or re-confirmed during this pass:

| ID | Priority | Finding | Required direction |
| --- | --- | --- | --- |
| `NEW-PICK-WEBGPU-QUERY-ARCHITECTURE` / FAR-107 + FAR-409 | P0 correctness/architecture | The bounded object-pick executor now uses correct per-frustum depth lifetimes, and pick staging is minimal/request-owned. WebGPU picking nevertheless remains a WebGL-shaped set of special passes and caches. Open hazards include ray helpers reading before their offscreen render is submitted, incomplete object/metadata/voxel cache identity, no shared serial-owned readback pool, and eager creation of a texture plus one CPU pick ID per model feature during ordinary rendering. Existing convergence probes do not certify exact query ownership. | Define backend-neutral immutable `PickQuery`/`PickResult` semantics, then compile queries as graph-owned mini-frames with explicit output attachments/depth versions, one submission authority, a bounded at-least-three-slot generation-tagged readback pool, and only requested outputs. Preserve exact WebGL sync behavior and every pick/metadata/voxel/ray/height/drill feature; WebGPU async APIs are authoritative and sync may return only an exact completed query. |
| `NEW-PICK-CONTIGUOUS-ID-RANGES` / FAR-107 + FAR-205 + FAR-409 | P0 allocation/architecture | Model color rendering still eagerly creates N CPU `PickId` objects, RGBA bytes, and a native feature-pick texture; the shared `BatchTexture` path can later create another N IDs and a legacy texture/native realization. This is a real WebGPU allocation double tax even though compatibility vertex/index buffers were repaired. | Make `BatchTexture` own one backend-neutral contiguous pick-key range for the object-ID channel. One guarded allocator must serve direct IDs and ranges, reserve zero and the terminal sentinel, detect overflow, decode direct IDs before binary-searched ranges, and retire ranges safely. WebGL may materialize RGBA bytes arithmetically; WebGPU passes `baseKey + featureId` to the shader without N CPU objects or a WebGL texture. Keep ranges context/view-local, recovery-stable at the logical layer, and make RGBA hit/decode tests include the high alpha byte. |
| `NEW-PICK-WEBGPU-MULTIFRUSTUM-PACKED-DEPTH` | P1 | Globe-only `pickPosition` returns undefined in a two-frustum WebGPU view. All PickDepth instances reference one packed texture; the final empty near frustum overwrites far-frustum globe depth before async readback. The failure reproduces with the new depth gates removed and depth bind-group caching disabled. | Give each frustum a stable depth version/texture until readback, or make the frame graph produce an explicitly accumulated full-frustum depth resource. Add globe/model/voxel/clear-depth tests. |
| `NEW-POLYLINE-COLOR-VELOCITY-GUARD` | P1 | The velocity helper accepts `"polylineColor"`, but its caller passes Cesium material type `"Color"`; base Color polyline velocity is therefore skipped. | Normalize through `selectShaderKey`, add a TAA motion probe, then add Arrow/Dash/Glow/Outline velocity entry points. |
| `NEW-POLYLINE-MATERIAL-VELOCITY-VARIANTS` | P2 | Arrow/Dash/Glow/Outline explicitly lack velocity entry points. | Implement per-variant velocity entry points without changing color/material output. |
| `NEW-POLYLINECOLLECTION-IMAGE-MATERIAL-WEBGPU` / `NEW-POLYLINECOLLECTION-DIFFUSEMAP-MATERIAL-WEBGPU` | P2 | PolylineCollection maps only Color/Arrow/Dash/Glow/Outline. Primitive/PolylineMaterialAppearance already has an Image shader route, so the earlier blanket statement was too broad; collection Image and the distinct DiffuseMap layout remain real gaps. | Implement separate collection Image and DiffuseMap slices rather than removing public types or aliasing their layouts; retain the existing primitive Image path as a regression control and convert the diagnostic probe into asserting per-surface/per-fabric gates. |
| `NEW-BILLBOARD-ATLAS-VFLIP` | P1 | Existing billboard/label atlas vertical flip remains open. | Preserve atlas features and establish one main/SDF/pick orientation across 3D, Columbus View, and 2D. |
| `NEW-VOXEL-INSIDE-CAMERA-BLACK` | P1 | Camera-inside-volume WebGPU voxel rendering remains black. | Repair ray/volume entry handling; do not disable inside views. |
| `NEW-VOXEL-PICK-PROBE-CONTRACT` / conditional `NEW-VOXEL-PUBLIC-PICK-TAIL` | P2 harness / conditional P1 product | Current public voxel-pick probe throws in its WebGL setup before producing a useful parity result; the lower-level coordinate gate is separate. The current evidence therefore does not prove or disprove the inventory's distinct public `scene.pickVoxel` tail. | Repair the probe/API setup first, retain the raw coordinate gate, then promote a product fix only if the repaired cross-backend public probe reproduces an exact traversal/result failure. |
| `NEW-BUFFERPRIMITIVE-INTEGER-NORMALIZED-CERT` | P2 verification | Current source already routes datatype/normalization decode through WebGPU BufferPoint, BufferPolyline, and BufferPolygon, and has a focused normalized-SHORT render probe. The earlier blanket “incomplete” premise is stale; the full datatype/mode/mutation/pick matrix is not yet certified. | Run the complete matrix and fix only a reproduced residual. Otherwise reconcile the old warning-only probe and inventory/deferred entries as shipped implementation plus remaining certification. |
| `NEW-WEBGL-CV-POINT-ZERO` | P2 | Existing WebGL Columbus View point issue remains open. | Fix shared positioning without weakening WebGPU modes. |
| `NEW-PERF-DETERMINISTIC-VIEWER-BOOT` | P2 harness | Viewer starts online ion requests before deterministic probes replace content, causing noisy `ERR_NETWORK_ACCESS_DENIED` reports. | Add an offline/local boot option and a separate credentialed network lane. |
| FAR-003 safe-auto restoration | P1 performance/correctness | Experimental GPU culling/Hi-Z/sort/indirect paths are reachable and forced GPU sort passes, but automatic defaults were contained because CPU-command identity and async-readback hazards remain. | Remove the hazards, prove dense-scene output and performance, then restore safe automatic selection. Do not delete the capability. |

Do not reopen `NEW-CSM-CAST-NO-DISPATCH-VIEWER`: later cast, receive-projection, and cascade-fit repairs are documented green. Reconcile the stale historical entry instead.

### 8.1 Deferred-document reconciliation

Do not revive entries whose core work is already present: the WASM bridge bundle loader, decoupled-scan forward-progress guard, clustered-assignment dirty bounds, entity GPU keyframe kernel, orbital inventory track, and post-process f16 shader tranche are implemented. Their remaining work is only the narrower named residual (for example automatic Entity bridging or physical-device f16 verification), not the original task.

Legitimate performance work retained from the deferred documents is mapped into the active architecture rather than duplicated: collection dirty gating maps to FAR-307/FAR-309; bulk CZML and automatic keyframe preparation to FAR-209/FAR-210/FAR-300; EntityCluster GPU merge to FAR-502/FAR-503; model motion gating to FAR-306; multi-frustum cluster bounds to FAR-108/FAR-400/FAR-405; pipeline-variant splitting/prewarm to FAR-304/FAR-600; and render-bundle/resource-key aging to FAR-208 plus the measured Phase-7 experiments. Model hardware clip-distance use, WGF2/WGF4/WGF5 experiments, conditional WASM wide kernels, G-buffer demand validation, and the longer TileStoreGPU/cloud/TAAU research tracks remain explicitly measured or research work, not assumed wins.

## 9. Remaining performance architecture queue

1. FAR-200 physical submission authority: route the 52 direct `queue.submit` sites through one queue timeline.
2. FAR-205/FAR-206 resource-family realization: separate decoded payloads from exact backend/device realizations, begin with texture ownership verticals, share only identity-compatible immutable work, and schedule beneficial CPU conversion/upload preparation off the draw hot path. Required WebGL object creation remains context-bound.
3. One demand-derived frame graph: own pass order, depth versions, pass merging, encoder lifetime, and submission.
4. Terrain static/dynamic UB split after the proven call-coalescing layer.
5. Loader-owned model geometry/metadata revision tokens for O(1) cache validation.
6. Complete FAR-309 model work: attribute and cache safe group-1 material/texture/IBL bindings, eliminate stable draw-command/frontend allocation, and measure settled plus mutation behavior without hiding feature updates.
7. Persistent polyline material table/dynamic offsets and removal of per-group zero placeholder allocation.
8. Collection camera-UB lifecycle/retirement and dirty-gate audit.
9. FAR-107/FAR-409 contiguous PickId ranges, graph-owned query scheduling, bounded shared readback slots, and continuous-hover coalescing/measurement; ordinary no-pick frames must allocate no per-feature pick resources.
10. Demand-gate production shader `getCompilationInfo()` diagnostics and always-on `PerformanceTracker.recordFrame` work only after their public/debug observability contracts are locked; do not silently remove diagnostics or live tracker semantics.
11. Complete HP-01 through HP-08 cold/loading/settled/moving/mutation attribution, including ownership/lifetime classification of the recorded moving lane's 2,091 buffer creations, 567 buffer destroys, 487 texture creations, and 487 external-image copies.
12. Expand GPU timestamp coverage beyond the current approximately 51–58% bounded span and report the unprofiled remainder until complete submitted-frame coverage exists.
13. Safe automatic GPU culling/Hi-Z/sort/indirect selection after the normal-frame readback and identity problems are removed.
14. Capped/uncapped benchmark lanes from §7.
15. Exact-current certification rerun: rebuild once, run the complete moving-altitude WebGL/WebGPU visual and clean/instrumented lanes, rerun strict native allocation tax, and record new hashes/timestamps. Do not use idle-soak FPS.
