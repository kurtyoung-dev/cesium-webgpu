# Fork Performance Weekly Change Defense

Date: 2026-07-15

Status: **EXACT-CURRENT PERFORMANCE/CORRECTNESS CHECKPOINT COMPLETE; FULL UNIT CERTIFICATION OPEN**

Scope: work performed from the post-Campaign-7 anchor `a54cc06b2aad89a00e8ecb0887b953a36f061954` through the current Campaign-8 performance/correctness tranche.

Primary authorities:

- [Fork vs Upstream WebGPU/WebGL Architecture Audit](FORK_VS_UPSTREAM_WEBGPU_ARCHITECTURE_AUDIT_2026-07-13.md)
- [Fork Architecture Remediation Plan](FORK_ARCHITECTURE_REMEDIATION_PLAN_2026-07-13.md)
- [Fork Performance Audit and Fix Results](FORK_PERFORMANCE_AUDIT_AND_FIX_RESULTS_2026-07-14.md)
- [Campaign 8 Queue](QUEUE_2026-07-15_CAMPAIGN8.md)
- [Current Rendering Functionality Baseline](CURRENT_RENDERING_FUNCTIONALITY_BASELINE_2026-07-13.md)
- [Fork Extension Test Coverage Matrix](FORK_EXTENSION_TEST_COVERAGE_MATRIX_2026-07-15.json)

This document is the requested defense of the total performance work. It records what changed, why the change is architecturally appropriate, which feature contracts it preserves, what evidence exists, what cost remains, and which claims are deliberately not made. Section 12 reconciles the exact-current physical and performance evidence from one frozen bundle. The full upstream-compatibility unit gate remains open and is reported as such; no partial pass is treated as certification.

## 1. Executive verdict

The work made real architectural and hot-path progress, but it did not complete the renderer architecture campaign.

The first measured tranche removed substantial repeated work from the moving WebGPU path. On bundle `D2A475A12AD60113B792C8DB8A94D02A52F7A2B635A5C2EDDCE2C7AAD637B623`, the recorded moving-altitude comparison reported 17.0% lower WebGPU CPU p95, 58.0% fewer bind-group creations per rendered frame, 37.9% fewer render passes, and 87.3% fewer `queue.writeBuffer` calls. The work did not obtain those reductions by shrinking the scene or deleting a feature.

That result is historical evidence for the first tranche, not certification of the exact current worktree. Later changes repaired multi-frustum picking, classification picking, asynchronous hover delivery, pick staging, default indirect-manager allocation, and full shader-define cache identity.

The exact-current bundle `B8015811ACC0567663C6898386DC74AD94424363B22DA2A1759DF54AC666C11E` retains the structural API-call reductions: 5.02 bind groups, 14.56 render passes, 9.94 `writeBuffer` calls, 111.75 kB uploaded, and 1.445 submits per measured WebGPU route frame. However, its two clean timestamp-off moving-route runs recorded WebGPU CPU p95 of 8.50 and 9.83 ms (median 9.165 ms). That is 25.5% above the historical first-tranche 7.30 ms and 4.1% above the historical pre-fix 8.80 ms. Because the later bundle and timestamp protocol differ, this is not a strict same-binary A/B regression percentage, but it decisively does **not** support a current net CPU-speedup claim. It agrees with the maintainer's observation that the latest tree does not yet feel materially faster.

Continuous picking is now bounded and starvation-free, but remains expensive: WebGPU render-plus-pick CPU p95 is 15.50–16.06 ms and physical pick execution alone is 7.70–8.30 ms p95. The result is a clearer architecture and correct delivery contract, not a completed pick-performance win. The graph-owned mini-frame, one submission authority, packed depth lifetime, and serial-owned readback pool remain required.

The architecture is better because the changes move ownership in the intended direction:

- shared Scene behavior remains backend-neutral;
- decoded data is separated conceptually from backend/device realizations;
- WebGPU-native features no longer need a physical compatibility `GPUBuffer` pre-pass for migrated buffer families;
- repeated per-tile/per-command work is being replaced by frame/view, material, object, and device-generation state;
- query work is explicit and bounded instead of masquerading as a normal frame;
- caches use exact descriptor/resource identity and explicit invalidation;
- recovery, teardown, and asynchronous publication are tied to an owner and generation;
- benchmarks measure active rendering rather than request-render idle time.

The architecture is not yet complete because one frame/submission graph does not own all work, 52 direct `queue.submit` sites remained at the recorded audit, texture and pick-resource double taxes remain, the FAR-200 authority is still shadow infrastructure, and several correctness/lifetime defects are queued in §10.

## 2. Claim classes and evidence boundaries

Every statement in this document belongs to one of four classes.

| Claim class | Meaning | Allowed conclusion |
| --- | --- | --- |
| Historically measured | Repeated on the recorded first-tranche bundle and protocol | Directional evidence for that exact bundle only |
| Exact-current focused | A focused unit, Node oracle, or bounded browser probe passed on then-current source | The named invariant is supported; whole-renderer performance is not certified |
| Architecture preparation | The change establishes ownership, identity, or instrumentation needed for later work | No frame-time win is claimed without a benchmark |
| Planned / queued | The issue and acceptance contract are known, but the implementation or final gate is open | No implementation or benefit is claimed |

The following boundaries are especially important:

- “Final” in the July 14 artifact filenames means final for the measured first tranche, not final for the July 15 worktree.
- GPU timestamp values from the historical run are characterization. The profiler reports delayed rolling results, and the runner did not yet assign a unique completed timestamp sample to exactly one Scene trace row. Duplicating a delayed value across rows can distort percentile statistics.
- Cross-backend visual agreement cannot prove that shared code did not regress both backends in the same direction. The tracked certifying historical manifest currently has zero entries.
- Focused mock-device specs cannot compile WGSL on a physical adapter, validate real attachment load/store behavior, prove pixels, measure driver cost, or exercise physical device loss.
- Safety containment is correctness work. Keeping an unsafe GPU-culling, HiZ, sort, OIT, or indirect path out of automatic selection is not counted as a performance improvement.
- FAR-200 types and self-tests are shadow architecture. They do not yet own production allocation, submission, completion, or retirement.

## 3. Feature-preservation contract

The governing rule for this pass was:

> Improve the implementation of an expensive feature. Do not remove, default-disable, visually weaken, or bypass that feature merely to improve a metric.

This means all performance changes must preserve:

- WebGL2 behavior and existing public APIs;
- explicit WebGPU selection and graceful fallback behavior;
- simultaneous WebGL/WebGPU and multiple-context use;
- default globe, imagery, terrain, atmosphere, fog, skybox, sun, moon, HDR, and post-process composition;
- Primitive, GroundPrimitive, ClassificationPrimitive, GroundPolyline, Model, 3D Tiles, voxel, splat, and collection rendering;
- exact Cesium material identity and public in-place uniform mutation;
- solid, dash, glow, arrow, outline, Image, and other supported material semantics on their existing surfaces;
- picking families, exact object/feature IDs, drill/position/ray/metadata/voxel results, and WebGL synchronous behavior;
- multi-frustum rendering, 3D/2D/Columbus View/Morph, TAA, OIT, classification, shadows, and recovery;
- enabled, disabled, and disabled-after-enabled transitions for opt-in features.

The baseline includes the Campaign-7 features present at the launch anchor, including textured classification, lake water classification, silhouette arrays, TPDF dither, sun/star extinction, cloud STBN/far-ray LOD, Gaussian-splat depth composition, LTC lights, motion blur, flow-field particles, logarithmic-depth post effects, SSGI, cascaded cloud shadows, and FFT ocean. A performance change is not acceptable if it wins by omitting one of these paths from the applicable regression surface.

## 4. Benchmark and validation methodology

### 4.1 Node and browser policy

All browser automation in this work uses Node and Playwright with installed Microsoft Edge. Python is not used to serve the repository, launch the browser, execute the benchmark, or process its artifacts. The normal Cesium Node server is started separately.

The clean and instrumented lanes are separate because wrapping WebGL/WebGPU API methods changes the timing being measured. GPU timestamps are now also off by default so a cross-backend CPU comparison does not instrument only the WebGPU leg. `--gpu-timestamps` is an explicit WebGPU-only characterization lane.

### 4.2 Continuous moving-altitude route

An idle soak is invalid in this project. Request-render mode correctly stops rendering when the scene has not changed, so an idle FPS counter measures the absence of work. The benchmark continuously flies one time-parametrized route:

| Waypoint | Camera height / intent |
| --- | --- |
| Pacific orbit | 18,000 km |
| Americas orbit | 6,000 km |
| Sierra descent | 900 km |
| San Francisco coast | 300 km |
| Low oblique | 60 km |
| City | 12 km |
| Near ground | 2.5 km |
| Ground | 300 m |
| Himalaya rotation | 2,500 km |

The route proves that the camera moved, every segment executed, and the full altitude range was reached. WebGL/WebGPU order is counterbalanced: WebGL→WebGPU, then WebGPU→WebGL. The exact-current clean campaign used a fresh browser process per run; browser reuse remains a separate stress mode, not the clean promotion protocol.

The clean lane records full `Scene.render()` CPU samples, p50/p95/p99/MAD, requestAnimationFrame wall time, 1%-low diagnostics, long tasks, route coverage, feature state, errors, and exact bundle identity. The API lane separately records buffer/texture/bind-group/pass/encoder/submit/write/copy activity. The renderer's default feature profile remains active; benchmark code does not silently disable effects to manufacture a better result.

### 4.3 Continuous picking lane

The moving-pick workload uses public `Scene.pickHoverAsync` with a deterministic moving 3×3 cursor. It does not use synchronous `Scene.pick`, because the WebGPU synchronous compatibility cache is exact-query-rectangle-specific and a continuously moving cursor cannot warm it.

Pick mini-frames can execute outside the normal `Scene.render` trace. The runner therefore records:

- public hover-call CPU;
- physical pick-execution CPU;
- any physical execution that trails the public call;
- completion latency;
- calls, completions, rejections, hits, pending count, and maximum pending count;
- combined render-plus-pick CPU without double-counting execution nested in the public call.

The lane is invalid if results are withheld until cursor traffic stops, pending work grows without bound, any request rejects, the chain does not fully drain, CPU accounting does not balance, or cursor/route proof is incomplete.

### 4.4 Display-paced versus maximum-throughput work

Current requestAnimationFrame FPS is a display-paced responsiveness signal. It is not the renderer's unconstrained maximum throughput, and JavaScript cannot directly promise control of the OS/compositor swap interval.

The queued end-of-campaign design therefore uses `renderPacingMode` with `DISPLAY_PACED` and `MAXIMUM_THROUGHPUT`, plus a convenience display-pacing boolean and Viewer control. The Node launcher must prove that its no-frame-limit/no-vsync flags were honored before accepting the maximum-throughput lane. The display-paced lane remains authoritative for responsiveness, 1%-low, dropped frames, and long tasks. The throughput lane reports CPU renders/s, completed GPU throughput, CPU/GPU distributions, queue/pass/write rates, in-flight limits, and thermal/stability metadata. Results from the two modes must never be mixed.

## 5. Historically measured first-tranche result

These numbers belong only to the first-tranche bundle `D2A475A...`, compared with pre-fix bundle `FA5276A...`. They are retained because they demonstrate that the work removed actual renderer work rather than only reorganizing code.

### 5.1 Clean moving flight

| Renderer / metric | Pre-fix | First-tranche result | Change |
| --- | ---: | ---: | ---: |
| WebGPU CPU p95 | 8.80 ms | 7.30 ms | **17.0% lower** |
| WebGPU GPU p95 | 10.02 ms | 7.30 ms | **27.2% lower, diagnostic timestamp evidence** |
| WebGPU GPU average | 7.71 ms | 5.42 ms | **29.6% lower, diagnostic timestamp evidence** |
| WebGPU wall p99 | 21.85 ms | 22.15 ms | 1.4% higher; display-paced noise |
| WebGL CPU p95 | 6.73 ms | 5.10 ms | 24.2% lower in this sample |
| WebGL wall p99 | 21.70 ms | 21.41 ms | 1.4% lower |

All four first-tranche runs completed the route and reported no page/device errors. The sample is only two counterbalanced repetitions per renderer on one machine, so it is evidence, not a universal adapter claim.

The recorded timestamp span covered work between the first and last timed pass, not the complete submitted GPU frame. Mean named-pass coverage was approximately 51.4% before and 58.3% after. In addition, the unique-sample accounting defect described in §2 means those GPU percentiles must remain directional characterization.

### 5.2 Instrumented call attribution

| WebGPU API metric per rendered frame | Pre-fix | First-tranche result | Change |
| --- | ---: | ---: | ---: |
| Bind groups created | 11.76 | 4.94 | **58.0% fewer** |
| Render passes begun | 23.34 | 14.49 | **37.9% fewer** |
| `queue.writeBuffer` calls | 79.02 | 10.06 | **87.3% fewer** |
| `writeBuffer` bytes | 105.7 KB | 112.6 KB | 6.6% higher |
| Queue submits | 1.417 | 1.437 | effectively unchanged |

The byte increase is an intentional trade: one contiguous aligned ring-page write includes alignment gaps but removes dozens of browser/driver calls. The result defends coalescing; it does not eliminate the later opportunity to split static and dynamic terrain uniform data.

The instrumented moving route still recorded 2,091 buffer creations, 567 explicit buffer destroys, 487 texture creations, and 487 external-image copies across 1,115 WebGPU frames. Streaming makes some of that legitimate, but the counts are why ownership/stage/lifetime attribution remains a P0 task.

## 6. Measurement, test, and observability changes

### 6.1 Full `Scene.render` CPU timing

The performance trace now measures the complete `Scene.render()` wall interval and publishes the sample after render completion. Earlier placement omitted meaningful Scene preparation and post-render work. The disabled path remains guarded, and detailed tracing stays opt-in.

Why this is correct: optimization order must be based on the caller-visible frame cost, not only a convenient renderer subsection. This change improves measurement truth; it is not itself a performance win.

### 6.2 Modern WebGPU timestamp profiling

The timestamp profiler uses render/compute-pass `timestampWrites`, not removed/deprecated command-encoder timestamp calls. It has bounded query capacity, triple-buffered asynchronous readback, reset generations, duplicate-label aggregation, and explicit attempt/sample/drop/skip/failure counters. Pass descriptors are returned unchanged when profiling is inactive; cloning occurs only when timestamp writes are actually attached.

Why this is correct: timestamp work remains capability- and opt-in-gated, never stalls the normal frame, and exposes its unprofiled remainder. It follows the current WebGPU pass API and preserves unsupported-adapter behavior.

Remaining limitation: completed samples need unique submission/frame serials and one-time consumption by the campaign runner. Until that lands, timestamp p95 is not a promotion metric.

### 6.3 Deterministic performance and visual harnesses

The performance workload registry records renderer order, viewport, route, local content, feature profile, source/bundle identity, timing mode, and error state. Clean timing, API instrumentation, and GPU timestamps are separate lanes. The runner rejects incomplete routes, teardown contamination, page/device errors, missing evidence, and malformed pick drains.

The visual gate now distinguishes current WebGL↔WebGPU parity from historical renderer-specific regression. The baseline schema records provenance instead of treating every recent PNG as golden.

Why this is correct: a faster result is meaningless if it came from a different scene, stopped route, missing feature, reused contaminated process, or untracked binary. Likewise, current/current agreement can hide a shared regression.

Remaining limitation: the certifying historical manifest has zero approved entries. Existing images and probes remain characterization until provenance and semantic gates are populated.

### 6.4 Strict allocation-tax probe

The Node/Edge allocation probe instruments WebGPU API boundaries before Cesium loads, proves that an explicit WebGPU run did not open WebGL/WebGL2, distinguishes compatibility-shaped from native allocations, and can require zero physical compatibility buffers for migrated fixtures.

Why this is correct: it measures JavaScript-visible allocation/upload ownership without pretending to be a driver VRAM profiler. Texture byte totals remain descriptor estimates, and a compatibility-shaped label alone does not prove a second physical texture.

### 6.5 Test-runner false-green prevention

The Gulp/Karma bridge now fails the task when Karma returns a nonzero result and fails an empty suite. A misspelled include name that executes zero specs is therefore red rather than a false pass. The policy has a Node self-test for successful, failing, and explicit diagnostic-opt-out paths.

Why this is correct: performance work changes cross-cutting renderer code; a runner that silently accepts zero or failing tests invalidates every later regression claim.

## 7. Resource ownership, allocation, and lifetime changes

### 7.1 Compatibility-buffer double-tax containment — FAR-100

The WebGPU compatibility stub now retains the GL-shaped metadata/logical CPU store required by legacy Cesium code without allocating a second compatibility `GPUBuffer` for fully migrated production buffer paths. The native feature renderer owns the physical WebGPU buffer. Strict characterization reported zero compatibility live GPU buffers/bytes at globe, Primitive, Model, and post-removal checkpoints while logical compatibility handles remained available.

Why this is correct: WebGPU does not need to create a fake WebGL resource and then create its native resource. The legacy shell preserves API and loader expectations until the shared frontend is migrated. The decision is per resource family/variant; incomplete native coverage must retain compatibility ownership rather than failing later in pick, morph, shadow, or classification.

What this does not solve:

- WebGL-shaped JavaScript object construction still has CPU/maintenance cost;
- texture, vertex-array, framebuffer, shader, command, and pick-resource ownership need separate migrations;
- simultaneous WebGL/WebGPU rendering still requires one GPU realization per API;
- different WebGPU devices or device generations cannot share handles.

### 7.2 Material mutation and per-consumer upload versions — FAR-101

Material public uniform object identity remains stable, including in-place component mutation. GPU consumers track their own upload/version state instead of one consumer clearing a shared dirty flag for every backend/context.

Why this is correct: preserving Cesium's public mutation semantics is mandatory, and a version/cursor model scales to WebGL, WebGPU, multiple contexts, and recovery. Replacing public objects to make cache checks cheap would be an API regression.

Remaining work: `BatchTexture` and the native Model feature realization still share a dirty boolean in one path. Campaign 8 queues a monotonic logical feature-payload revision with independent realization upload cursors.

### 7.3 Effects cache partitioning — FAR-108 preparation

Effects caching separates logical-context volatile state from device-shared immutable placeholders, uses exact identity, retain/release, bounded pruning, and recovery-aware teardown.

Why this is correct: camera, clipping, shadow, and per-view state cannot be shared merely because two canvases use one device; immutable placeholders can. This bounds bind-group/resource creation without cross-view contamination.

Remaining work: terrain still rebuilds global effects descriptors, wrapper objects, uniform bytes, and resource-identity strings in tile/imagery loops. The queued per-view prepared handle must reduce that CPU/allocation work while preserving shadows, clipping, CSM, atmosphere LUTs, multi-view cameras, and mutations.

### 7.4 Default indirect-manager allocation containment

`WebGPUPerformanceManager.beginFrame()` no longer reads the lazy indirect manager when the tile consumer policy is the default `false`/`never`. Explicit `true`/`auto`/`always` requests remain observable and reachable; the master capability flag remains enabled.

Why this is correct: advertising support is different from requesting the contained consumer. Reading the lazy getter in an ordinary scene allocated approximately 81,920 bytes of indirect buffers even though no indirect draw could be consumed. The new guard removes that idle allocation without deleting or auto-enabling the feature.

Remaining work: automatic/forced indirect operation is unsafe until FAR-501 assigns non-overlapping arena slices across frames, frusta, and passes. The containment is not counted as the measured first-tranche speedup.

### 7.5 Transactional context, Scene, Widget, and Viewer lifetime

Renderer selection, asynchronous initialization, feature-renderer readiness, Scene/Widget/Viewer/DataSourceDisplay construction, teardown, and rollback now have explicit ownership. Partial construction releases global listeners, scene resources, context-registry membership, and pooled-device leases. Cleanup continues even if one custom resource throws.

Why this is correct: a renderer that leaks contexts, listeners, or pooled-device leases eventually develops memory growth, duplicate callbacks, and stale resource publication. This is a lifetime/performance prerequisite, not a claimed per-frame win.

### 7.6 Context-owned capabilities, clip space, and KTX2 identity

Clip-space convention, graphics capabilities, limits, and compressed-texture targets are context-owned rather than process-global. KTX2/decode cache identity includes the actual target capability.

Why this is correct: simultaneous heterogeneous contexts cannot safely use a process-global depth range or format decision. A decoded product can be shared only when decoder options and output target match; otherwise one context can poison another's cache.

### 7.7 FAR-200 resource and submission scaffold

Typed backend domains, decoded payloads, realization descriptors, ownership tokens, leases, shadow cache, and submission-serial APIs exist with a Node self-test. The design chooses one owner before realization and supports an incremental `ResourcePlan` / asynchronous preparation graph.

Why this is the target architecture:

```text
source/fetch -> parse -> decode/transcode -> CPU transform
             -> backend/device realization -> ready lease
```

Fetch/decode products may be shared when their complete identity matches. WebGL objects remain context-bound. Immutable WebGPU realizations may later be shared only across contexts using the same `GPUDevice`, device generation, content, and exact descriptor. Camera/view state, attachments, history, picks, rings, and mutable frame data stay local. CPU-heavy conversion can run in workers; WebGL object creation remains on its required context thread but can be budgeted outside draw execution.

Current boundary: production callers do not yet use this authority, and the recorded static audit found 52 direct `queue.submit` sites. Central routing will improve ordering, retirement, recovery, and observability; it must not be described as fewer physical submissions unless measurement proves coalescing.

## 8. Hot-path and renderer-execution changes

### 8.1 Coalesced device-local ring uploads — FAR-303 preparation

The uniform ring allocator now stages dirty allocations in a CPU mirror per active page and flushes at most one contiguous `queue.writeBuffer` per dirty page before command-buffer finish/submit. Staging starts at 64 KiB and grows geometrically. Dynamic offsets, WGSL layout, binding width, and payload bytes remain unchanged.

Why this is correct: many small browser-to-driver calls cost more CPU than one modest sequential write. Alignment gaps explain the measured 6.6% byte increase while calls fell 87.3%. Multipage, overflow, typed-array, repeated-flush, alignment, and unwritten-tail behavior have focused tests.

Remaining work: split static terrain/material data from per-view/per-frame data so the implementation can reduce bytes without reintroducing per-tile calls.

### 8.2 Empty depth-boundary elimination and stable depth bindings — FAR-405/FAR-408 preparation

The renderer skips post-tile depth work only when the tile pass emitted no commands and skips the post-opaque repack only when no relevant opaque, voxel, or clear-depth writer ran. Globe source-depth and MSAA-resolve bind groups are cached by stable texture/view identity and invalidated on resize, target destruction, device change, and recovery.

Why this is correct: a pass with no producer cannot create useful depth, and stable sampled resources do not require a new bind group every frame. The predicates preserve all real writers and keep single-sample/MSAA identities separate.

Why this is not complete: local predicates are not a substitute for graph-owned depth versions and attachment lifetime. A physical 3D/2D/CV, one/multiple-frustum, MSAA, TAA, OIT, classification, translucency, shadow, and post-process matrix remains required.

### 8.3 Clustered-lighting disabled path

Stable disabled frames return before dispatcher allocation. Enabled frames retain light gathering, pass splitting, compute dispatch, and consumer bindings. Enabled→disabled publishes exactly one zero-light transition; later disabled frames perform no repeated dispatch.

Why this is correct: consumers need one state transition when the feature turns off, not a compute pass every frame to restate zero. The enabled implementation is preserved.

Remaining work: direct unit coverage for the zero-work disabled path and a promoted exact-current physical gate are still missing.

### 8.4 Command ordering and GPU-sort producer containment — FAR-105/FAR-504 preparation

Ordering fields are normalized once before sorting. The O(N log N) comparator hot loop performs only arithmetic comparisons. Reusable active-range scratch avoids sorting a dead pooled tail. When the consumer mode is explicitly `never`, the GPU-sort producer no longer uploads, dispatches, maps, and discards an unusable result. Explicit `auto`/`always` behavior remains.

Why this is correct: normalization is per command, not per comparison, and an explicitly absent consumer cannot benefit from producer work. A forced 6,400-command probe produced a complete permutation matching the CPU comparator and rendered inside the measured off/on noise band.

Remaining work:

- remove normal-frame GPU sort/visibility readback and make the GPU result authoritative;
- harden object/range identity and monotonic arenas;
- reconcile `CommandSorter.frontToBack` epsilon-tie behavior before claiming stable exact-tie ordering;
- restore safe automatic selection only after dense-scene correctness and performance gates.

### 8.5 Polyline grouping and retirement — FAR-307 preparation

Polyline grouping maps/arrays are reused. Camera upload, pipeline resolution, and frame work shared by one material type are hoisted without merging distinct material object identities. Material/segment resources receive a 60-frame retirement grace instead of destruction after one inactive frame.

Why this is correct: Cesium materials of the same type can have different uniforms, so grouping only by type would render the wrong result. Reusing bookkeeping and extending retirement removes churn while preserving exact identity and mixed solid/dash/glow/arrow/outline behavior.

Remaining risk: high-cardinality material object identity can still create many resource/geometry/command cohorts. FAR-307's persistent material table, value-safe coalescing, dynamic offsets, and dirty-range segment updates are required; reverting to first-material uniforms is forbidden.

### 8.6 Model geometry, metadata, and group-2 caching — FAR-204/FAR-309 preparation

Immutable model geometry conversion and metadata layout/descriptor work use bounded caches. The common no-structural-metadata negative path validates identity in O(1). The merged skin/morph/instance group-2 bind group caches by device, layout, and the exact seven current/previous buffer identities. All-placeholder primitives reuse the pipeline cache's shared default group.

Why this is correct: immutable conversions and identity-stable bind groups need not be rebuilt every frame. Buffer content updates do not invalidate a bind group; replacing a bound buffer, layout, device generation, or current/previous fallback does.

Bounded evidence: a static, instanced, and animated-morph probe held group-2 identity stable and recorded zero settled group-2 creations over 40 frames.

Remaining work:

- loader-owned monotonic geometry/metadata revisions for O(1) positive-path validation;
- group-1 material/texture/IBL binding attribution and caching;
- settled draw-command/frontend allocation removal;
- direct tests for allocation-free selected implicit feature-ID lookup;
- removal of duplicate/eager Model pick IDs and pick textures without losing feature semantics.

The same model probe still observed 14 total bind-group creations per settled frame from other groups/owners. No claim of allocation-free Model rendering is made.

### 8.7 Exact shader-module cache identity

The shader-module cache common path now keys `(sourceId, defines)` with the exact safe integer `((defines >>> 0) * 0x100) + sourceId`. The low eight bits identify one of up to 256 sources; all 32 define bits remain in the high portion. JavaScript represents the maximum 40-bit value exactly. Generated-source `keySalt` remains a separate string-key identity only when shader text varies beyond `(sourceId, defines)`.

Why this is correct: the previous 24-bit packing silently dropped define bits 24–31, allowing a high-bit variant to reuse the wrong compiled WGSL module unless every caller remembered a salt. The replacement is collision-free for the declared domain and keeps the allocation-free numeric lookup on ordinary hits. Compiling every variant or allocating a string per normal cache lookup would have fixed correctness by harming performance; this change avoids both.

### 8.8 Pass-scoped dynamic viewport/scissor state

Pick and auxiliary passes publish a pass-scoped dynamic-state override. Draw commands avoid redundant viewport/scissor calls when the pass already owns the correct values while still applying required changes before bundled execution.

Why this is correct: viewport/scissor belong to encoder pass state, but nested query rectangles must override the normal canvas state exactly. The optimization removes redundant state calls without letting stale normal-frame state leak into a pick.

### 8.9 Correctness repairs encountered during performance work

The following changes protect the performance work from measuring broken output; they are not counted as speedups:

- terrain atmosphere LUT fog samples the required absolute ECEF position rather than double-adding camera position;
- `PointPrimitiveCollection` initializes its context before reading context limits;
- TAA jitter uses explicit NDC/UV representations and reusable per-frustum scratch projection state rather than accumulating mutations in the persistent camera projection cache;
- renderer build capabilities no longer advertise a backend stripped from a WebGL-only or WebGPU-only bundle;
- stale browser specs were updated to model real Scene projection state, translated model fixtures, and the current eleven-entry globe group-2 layout instead of weakening production code to satisfy outdated mocks.

## 9. Picking architecture and performance defense

### 9.1 Why picking is a query mini-frame

WebGPU cannot provide WebGL's synchronous framebuffer readback behavior without an asynchronous copy/map boundary. The correct long-term abstraction is an immutable backend-neutral `PickQuery` / `PickResult` compiled as a graph-owned mini-frame requesting only needed outputs. WebGL retains exact synchronous behavior; WebGPU async results are authoritative, and a sync result may only reuse an exact completed query/generation.

The current work makes bounded corrections to the legacy executor that are compatible with that target. It does not claim that one query/submission authority is complete.

### 9.2 Multi-frustum object-pick passes

Object picking now opens one far-to-near render pass for each independently projected frustum slice. The ID color attachment clears once, then loads accumulated farther results. Depth and stencil clear for each slice because depth values encoded with different projections are not comparable. Precise two-pass translucent picking remains inside each slice, and command order is preserved.

Why a new pass is justified: WebGPU has no practical renderer-wide “pass count limit” analogous to a bind-group limit. Each pass boundary does have real CPU encoding, load/store, validation, and possible tile-memory cost, so passes should not be added casually. Here the boundary is required for correctness and exists only while a query runs. Flattening slices into one depth lifetime gives wrong winners.

Why this does not clear TAA: the mini-frame uses pick-local ID/depth/stencil attachments. It does not clear normal TAA color, velocity, or history. TAA continued resolving in the bounded multi-frustum probe. The separate TAA multi-frustum reprojection contract in §10 remains open because normal-frame TAA currently combines per-slice jitter/depth clears with a single inverse/depth-history assumption.

### 9.3 Minimal and request-owned readback staging

Pick framebuffer `begin()` no longer allocates a full-viewport `MAP_READ` buffer. A 3×3 query stages one row-padded 768-byte copy instead of approximately 7.9 MiB at 1080p or 31.6 MiB at 4K. Synchronous reads lazily reuse one exact-size buffer. Each overlapping asynchronous request owns an exact-size buffer, so one request cannot map or overwrite another's staging allocation. Resize, format, generation, failure, unmap, and destruction paths reject stale publication.

Why this is correct: WebGPU's `bytesPerRow` alignment is honored, while allocation scales with requested pixels rather than display resolution. Request ownership is the safe intermediate design until a serial-owned bounded pool is implemented.

Remaining work: a context-owned at-least-three-slot readback pool, cancellation/coalescing generations, and one graph/submission authority.

### 9.4 Classification picking

The pick mini-frame begins before feature renderers allocate ring slices. Terrain contributes depth even when the globe itself is non-pickable; its pick color remains zero. Terrain and 3D-Tile classification checkpoints pack the query-current depth at explicit pass boundaries, then classifier commands sample that packed depth. Ground/Classification wrappers reuse the canonical inner GeometryInstance pick ID instead of allocating a semantically weaker duplicate wrapper ID. Derived globe pick-command objects are created only while rebuilding an actual pick mini-frame, avoiding one normal-frame object per visible tile.

Why this is correct: classification needs the occluding surface depth even when that surface must not return a pick result. Zero-color depth contribution preserves non-pickable globe semantics, and canonical inner IDs preserve `GeometryInstance.id` plus lifecycle ownership.

Bounded physical evidence at the implementation checkpoint:

- WebGL classified pixels: 17,632;
- WebGPU classified pixels: 18,408;
- WebGPU/WebGL ratio: 1.044;
- both returned `classification-box`;
- zero renderer/device/page errors.

The same probe was rerun against the exact-current `B8015811...11E` bundle and retained the values
above. The exact-current run therefore closes the bounded classification coverage/ID oracle; it does
not close the retained-texture cost or the broader historical visual gate.

Known cost: the current implementation lazily retains one full-viewport RGBA8 packed classification-depth texture after a classification query, about 33 MiB at 4K. It is not allocated by ordinary no-query frames, but it is larger and longer-lived than a 1×1/3×3 query warrants. `NEW-PICK-CLASSIFICATION-DEPTH-TRANSIENT` queues a query-extent or graph-transient replacement. Removing classification picking is not an acceptable memory optimization.

### 9.5 Continuous hover delivery

The old hover chain behaved like a trailing debounce: if pointer events arrived faster than readback, every caller could wait until traffic stopped. It also encouraged ambiguous benchmark accounting.

The replacement scheduler has two bounded slots:

- one active physical pick;
- one latest-wins queued cycle shared by callers arriving during the active cycle.

Each completed cycle publishes promptly. The queued cursor and scalar arguments are overwritten in reusable storage, so request rate does not create an unbounded queue or a per-call argument object. Fulfillment and rejection both release/advance the scheduler. The public method resolves its documented object-or-undefined result instead of leaking the internal drill-pick array.

Why this is correct: continuous input requires bounded work and periodic useful results, not one physical query per mouse event and not indefinite starvation. This improves latency architecture and allocation behavior while preserving approximate hover semantics.

The exact-current moving-altitude pick lane confirms the scheduler contract but also exposes the
remaining physical cost. Across two WebGPU repetitions, all 2,375 calls completed with zero rejection
or pending tail, pending public calls/promises peaked at five while physical cycles remained bounded to
one active plus one queued, completion-latency p95 was 21.3/20.3 ms, and physical pick CPU p95 was
8.30/7.71 ms. The comparable WebGL physical-pick p95 was 2.90/2.30 ms. Thus delivery
and boundedness improved, but WebGPU picking remains an expensive mini-frame/readback path. This is
evidence for continuing FAR-107/FAR-409, not for removing hover picking.

### 9.6 Remaining picking double taxes and lifetime defects

The following are discovered/queued, not fixed by the changes above:

- GroundPolyline creates an outer wrapper pick ID, collapses batched instances to one uniform color, bypasses part of `allowPicking`, and does not fully tear down its native pick cache.
- Model creates duplicate primitive IDs that lose canonical model/entity/tiles/node/instance semantics.
- the native Model feature-ID path can eagerly create N CPU pick IDs plus an RGBA texture during ordinary rendering, after which `BatchTexture` may create another canonical set and texture;
- feature ID resources have eviction/destruction gaps;
- the multi-frustum packed `pickPosition` depth lifetime is still not one stable version per contributing slice;
- `readDepthPixelAsync` has a reusable staging path whose overlapping in-flight contract still needs an explicit guard or pool.

The fix direction is one context-local logical ID allocator with direct IDs and safely retired contiguous ranges, plus per-backend realizations only when the requested query needs them. Exact public IDs and feature picking must not be traded for lower allocation counts.

## 10. Known limitations, risks, and queued work

This section is part of the defense: a credible performance report must identify costs introduced or left behind.

### 10.1 Potential costs introduced or retained by this tranche

| Area | Current cost/risk | Required resolution or evidence |
| --- | --- | --- |
| Ring coalescing | Approximately 6.6% more uploaded bytes in the historical lane | Keep the call reduction; split static/dynamic data later |
| Multi-frustum object pick | One query-local pass boundary per slice | Keep for correctness; coalesce queries and move execution under the graph |
| Classification pick depth | One lazily retained viewport RGBA8 texture, about 33 MiB at 4K | Query-extent or graph-transient checkpoint |
| Hover picking | Bounded but still real asynchronous mini-frame work | Promote the completed bounded campaign into a maintained post-fix CPU/latency/allocation gate |
| Polyline grouping | Exact object identity can scale poorly at high cardinality | Persistent material table and dirty ranges |
| Model binding | Group-2 fixed; other groups still create bind groups | Owner attribution and group-1/frontend caching |
| Timestamp instrumentation | Opt-in pass descriptor/query/readback work; delayed values lack unique trace identity | Separate lane and unique sample serials |
| FAR-200 scaffold | Additional types/indirection with no production authority yet | Adopt in gated queue slices; do not claim benefit early |
| Shader key repair | Larger numeric value, but still one allocation-free numeric `Map` lookup | Focused/broad collision and cache-reuse tests |
| Indirect draw | Default idle allocation removed; explicit path still has arena identity hazards | FAR-501 before automatic enablement |

### 10.2 Correctness/completeness queue exposed during the pass

- ES6 lifecycle parity: `destroyObject` currently misses non-enumerable class methods, so destroyed
  resources retain live methods and a second `destroy()` can repeat native teardown;
- Resource URL and archive parity: WHATWG reconstruction changes the public `Resource` contract and
  breaks embedded/nested KMZ asset resolution;
- DataSourceCollection `contains` calls a nonexistent wrapper method;
- bulk point/billboard/label visualizers do not reclassify static entities when clustering is enabled
  after setup, and their private primitive requirement breaks the public visualizer callback contract;
- PolylineGeometryUpdater's ES6 conversion dropped constant public descriptors;
- ShaderFunction input validation and exact generated-source terminal-line parity;
- WebGL1 async-pick routing and GLSL100 additional-light generation, VoxelBounds' missed
  `maximumTextureSize` argument, and backend-independent CubeMapPanorama validation;
- renderer-neutral Scene fixtures for limits, feature-renderer capability, and clip-space convention,
  plus a semantic irradiance oracle before changing dynamic-environment product math;
- multi-frustum packed `pickPosition` depth ownership;
- TAA per-frustum current/previous matrix and depth-reprojection identity;
- GroundPolyline and Model pick-ID ownership, `allowPicking`, eviction, destruction, and device loss;
- monotonic Model feature-payload revision with per-realization cursors;
- billboard/label atlas vertical orientation across color/SDF/pick and 3D/CV/2D;
- voxel camera-inside-volume rendering and all related pick/depth/velocity paths;
- Color polyline velocity eligibility and Dash/Arrow/Glow/Outline velocity variants;
- PolylineCollection Image and distinct DiffuseMap material paths;
- conditional WebGL Columbus View point and public voxel-pick defects, only if repaired probes reproduce product failures;
- terrain per-view prepared effects handle;
- `CommandSorter` exact-distance epsilon ties;
- exact shader-module identity broad-suite closure;
- deterministic local Viewer boot plus a separate credentialed streaming lane.

### 10.3 Remaining architecture queue

1. Route every production submit through one device-generation physical queue timeline and serial-owned retirement.
2. Adopt two production ownership verticals in `NATIVE_CONTEXT` before attempting device-shared immutable realizations.
3. Split source/decoded products from WebGL/WebGPU realizations for geometry, textures, metadata, and materials.
4. Make one backend-neutral frame graph own pass order, attachments, depth versions, load/store, encoders, and normal submission for WebGPU and WebGL2 compilers.
5. Move visibility, HiZ, sort, compaction, and indirect argument generation into graph-owned GPU execution without normal-frame readback.
6. Complete frame/view/material/object uniform and persistent object-table hierarchy.
7. Attribute cold, loading, settled, moving, and mutation allocation/GC/upload work by owner and expected lifetime.
8. Evaluate 2026 WebGPU features only after ownership and attachment contracts exist: transient attachments, immediates, standard uniform layout, selected subgroups/f16, dual-source blend, external video texture, and exact format tiers.

The modern-feature policy is deliberate. A feature is not “left on the floor” merely because the API exposes it. Transient attachments are valuable only after discard-only attachment lifetime is explicit; immediates are valuable for small scalars after the uniform hierarchy exists; bundles help stable cohorts with complete invalidation identity; indirect drawing helps only when the GPU result is consumed without CPU readback. Capability checks, fallback variants, visual correctness, and a named-workload improvement are required before default enablement.

## 11. Unit, integration, and physical coverage verdict

The unit tests are not sufficient to cover all fork extensions or certify upstream compatibility.

The July 15 machine-readable inventory records:

- 227 WebGPU JavaScript/TypeScript source modules;
- 91 WebGPU spec files;
- 1,530 discovered WebGPU Jasmine cases;
- 12 performance-harness Node cases;
- 10 visual-policy Node cases;
- 24 mapped high-risk coverage rows;
- 16 queued P0/P1 coverage closures after exact-current broad-suite classification;
- zero certifying historical visual-manifest entries.

Recent isolated algorithms often have good focused coverage: ring-page staging, material upload state, effects cache identity, model group-2 caching, pick framebuffer staging, pick-pass boundaries, TAA jitter state, renderer readiness, context recovery, command ordering, and shader cache identity. That does not make the whole renderer covered.

The missing layers are material:

- complete fork-source/upstream-diff-to-test traceability;
- physical WGSL compilation and adapter validation;
- attachment/pass/load/store pixel matrices;
- maintained CI/promotion gates and post-fix reruns for the completed exact-current moving-camera and
  continuous-picking protocols;
- renderer-specific historical WebGL and WebGPU baselines;
- physical multi-context teardown and device loss;
- full texture/shader/pipeline/pick-resource double-tax accounting;
- cold/loading/settled/mutation allocation and GC plateaus;
- one final affected and broad engine/widget suite with every exclusion recorded.

The exact-current broad WebGPU suite is green at 1,505/1,505 after correcting stale fixtures and the
real high-bit shader-module cache collision. The broader shared surface is not green: Renderer passed
2,493 with 20 failures, DataSources passed 1,824 with 10 failures, and Scene executed 5,704 with 47
failures plus an `afterAll` error. The full engine run aborted after 4,620/17,455 with seven failures,
including external/network-dependent world-terrain cases. Widgets passed 429/429. These failures
were neither silenced nor reclassified wholesale as stale tests. The test architecture is valuable
because it found real lifecycle, URL/archive, collection, clustering-transition, public-descriptor,
and shader-generation regressions that focused WebGPU tests missed; it is insufficient because the
gate is red, extension traceability is incomplete, several GPU interactions remain mock-only, and the
certifying historical visual manifest is empty.

## 12. Exact-current bounded checkpoint

This checkpoint freezes the completed performance/correctness tranche. It is not Gate E: the shared
unit failures, empty historical manifest, lifetime/loss matrix, and maximum-throughput lane remain
open. No older result is substituted for a lane that did not certify.

| Evidence | Final exact-current result |
| --- | --- |
| Source anchor / dirty-state declaration | `a54cc06b2aad89a00e8ecb0887b953a36f061954` on `main`; dirty working tree explicitly retained |
| `Build/CesiumUnminified/Cesium.js` SHA-256 | `B8015811ACC0567663C6898386DC74AD94424363B22DA2A1759DF54AC666C11E` (25,090,507 bytes) |
| Edge / Node / OS / adapter / viewport | Edge 150.0.4078.65; Node 22.23.1; Windows 10.0.19045 x64; NVIDIA Pascal, subgroup 32–128; performance 1280×720@1; visual 1000×1000 |
| Canonical production build | **PASS**; repeated Karma rebuilds retained the same bundle hash |
| TypeScript `--noEmit` | **PASS** |
| Performance/visual-policy Node suites | **PASS**: workload 12/12; visual policy 10/10; Karma wrapper policy 1/1 |
| Focused Picking / WebGPU Pick / PerformanceManager / shader-cache suites | **PASS**: Picking 92/92; WebGPUPick 62/62; PerformanceManager 12/12; shader family 98/98, including cache 22/22, defines 20/20, pipeline 23/23, voxel codegen 20/20 |
| Broad WebGPU suite | **PASS: 1,505/1,505** |
| Affected WebGL/shared-core suite | **OPEN**: Renderer 2,493 pass/20 fail; DataSources 1,824 pass/10 fail; Scene 5,704 executed/47 fail plus `afterAll` error |
| Full engine/widget suite and exclusions | **OPEN**: engine aborted at 4,620/17,455 with seven failures and an external-world-terrain `afterAll`; Widgets **PASS 429/429** |
| Strict native allocation-tax artifact | **PASS bounded oracle**: zero physical compatibility buffers and no indirect labels; logical compatibility CPU stores remain; two compatibility-shaped texture labels require deeper ownership attribution |
| Classification physical parity probe | **PASS**: 17,632 WebGL vs 18,408 WebGPU pixels, ratio 1.044, both `classification-box`, zero errors |
| Multi-frustum object/position pick probes | **PASS bounded semantic oracle**: near/far IDs correct on both backends; WebGPU three and WebGL two natural frustums; TAA active/resolving; zero errors |
| Nine-waypoint moving visual route | **PASS bounded current cross-backend oracle**: 9/9 settled; mean difference 0.025%, maximum 0.122%; all 18 images manually inspected; no holes, black frames, or backend-only artifact |
| Clean timestamp-off moving-altitude WebGL/WebGPU campaign | **PASS protocol; no net WebGPU CPU win proven**: WebGPU CPU p95 9.83/8.50 ms, median 9.165; WebGL 8.22/5.30 ms, median 6.76; full route and error gates passed |
| Separate API-instrumented moving-altitude lane | **PASS protocol; churn remains P0**: 5.019 bind groups, 14.562 passes, 9.942 writes/111.75 kB, 1.445 submits, 1.772 buffers created per frame |
| Continuous moving-pick WebGL/WebGPU campaign | **PASS scheduler contract; physical cost open**: zero rejection/pending tail; WebGPU physical-pick p95 8.30/7.71 ms vs WebGL 2.90/2.30 ms |
| Optional WebGPU timestamp characterization | **NON-CERTIFYING**: GPU p95 11.693 ms with 56.198% span coverage; unique sample/frame accounting remains open |
| Display-paced / maximum-throughput lanes | **QUEUED END-OF-CAMPAIGN WORK; NOT YET IMPLEMENTED** |

Exact-current machine-readable artifacts: [clean moving altitude](../Tools/visual-regression/output/performance/altitude-track-exact-current-clean-2026-07-15.json),
[API-instrumented moving altitude](../Tools/visual-regression/output/performance/altitude-track-exact-current-api-2026-07-15.json),
[continuous moving pick](../Tools/visual-regression/output/performance/moving-pick-exact-current-clean-2026-07-15.json),
[timestamp characterization](../Tools/visual-regression/output/performance/altitude-track-exact-current-timestamps-2026-07-15.json),
and [strict allocation](../Tools/visual-regression/output/allocation-tax-exact-current-2026-07-15.json).

The exact-current normal lane does not support a claim of net CPU improvement. Its 9.165 ms WebGPU
median-of-repetitions p95 is 25.5% above the historical first-tranche 7.3 ms and 4.1% above the
historical pre-fix 8.8 ms. That is not a strict A/B because the protocol and bundle differ, but it
agrees with the maintainer's observed lack of a large performance gain. The API lane shows that the
historical structural reductions were retained—roughly five bind groups, 14.6 passes, ten writes, and
1.45 submits per frame—but they have not yet translated into a demonstrated exact-current CPU win.
Buffer/texture creation and copy churn, terrain per-tile preparation, model/feature ownership, and the
pick mini-frame are therefore still active performance work rather than completed victories.

## 13. Final defense

The changes are defensible because they remove demonstrably redundant work at the correct ownership layer:

- coalesce uploads instead of omitting uniforms;
- reuse bind groups by exact resource identity instead of weakening descriptors;
- skip passes only when no producer wrote the data;
- avoid dispatch only when the consumer is explicitly absent;
- reuse exact materials instead of merging semantically different ones;
- preserve compatibility metadata while removing a redundant physical WebGPU buffer;
- schedule hover queries with bounded latest-wins delivery instead of dropping the feature;
- add query-local pass boundaries where projection-depth correctness requires them;
- repair cache identity without adding hot-path string allocation;
- expose unsafe experimental paths explicitly instead of deleting them or pretending they are safe defaults.

The measured historical first tranche supports the conclusion that the approach can remove structural
work. The exact-current campaign does **not** yet prove that those reductions improved total CPU
performance, and continuous WebGPU picking remains materially more expensive than WebGL. The correct
response is to attribute and remove the remaining churn at its ownership/pass boundary while retaining
every feature. Shared-suite regressions must be repaired and the missing integration gates populated
before this fork can claim upstream-compatible correctness or a completed performance campaign.

## 14. Continuation through 2026-07-28

This section extends the July 15 defense across the later Fable 5, Opus 5.0,
and Claude-model work and the current Campaign 11 WebGL shader slice. It does
not rewrite the historical measurements above. The detailed change-by-change
audits remain:

- [`FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md`](FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md)
  for the 78-commit, 455-file Campaign 9–12 interval;
- [`CLAUDE_PROGRESS_AUDIT_2026-07-26.md`](CLAUDE_PROGRESS_AUDIT_2026-07-26.md)
  for the following 24 landed commits and the eclipse/ocean/tide/cloud review;
- the live Campaign 11–13 queues for ownership and completion status.

Those ranges made substantial changes, but their timings are not
interchangeable. Each performance claim below is therefore tied to its exact
artifact rather than presented as a single continuous before/after benchmark.

### 14.1 Structural work retained after July 15

The later audit confirmed that the main architectural reductions survived:

- explicit WebGPU startup creates neither a live WebGL context nor duplicate
  compatibility GPU buffers; shared scene objects retain only the CPU metadata
  needed by backend-neutral code;
- the default 3D scene uses one frustum, scene-color MSAA resolution is
  demand-driven, and previous-frame/velocity transfers use GPU copies where
  applicable;
- stable ocean-normal input no longer performs image copy, mip generation,
  view creation, and bind-group construction per tile/frame;
- terrain, model/material, imagery, effects, tonemap, and celestial resources
  have progressively moved toward context/device ownership and retained exact
  identities rather than per-command recreation;
- WebGPU submission and bind-group counts remain close to one per ordinary
  measured frame even though CPU upload and terrain-lifetime work remains.

Campaign 9's exact close artifact reached a WebGPU/WebGL CPU-p95 ratio of 0.98.
The later July 22 six-run bundle did not preserve that strict p95 parity:
WebGL's median p95 was 8.235 ms and WebGPU's was 9.30 ms. Conversely, WebGL
carried seven deterministic 100–205 ms long tasks per run while WebGPU carried
none. That evidence separated two real problems instead of hiding them in one
FPS number: WebGPU retained a higher steady-state CPU floor, while WebGL had a
shader-first-use tail-latency failure.

This distinction matters to the defense. Resource-retention and submission
changes were not reverted merely because a later whole-tree bundle moved a
summary percentile. Their structural counters and ownership benefits remained
real; the new evidence identified additional work at different boundaries.

### 14.2 Feature work remained performance-conscious

The celestial, ocean, tide, cloud, and eclipse changes did not buy speed by
removing rendering:

- WebGL and WebGPU received the same physically improved solar-disc profile.
- Ocean wave coordinates use CPU-f64 phase construction, bounded fractional
  GPU inputs, antimeridian-continuous repeats, and derivative-driven
  pixel-footprint LOD. The enhanced presentation remains opt-in; the
  WebGL-compatible look remains available and the water effect is not removed
  at altitude.
- Eclipse state remains backend-neutral and is now owned by the logical
  `View`. Scene prepares the shared celestial state, while capture, main globe,
  and pick prepare the exact S5 terrain footprint they own. The active WebGPU
  correction uses one memoized 64-byte View slice rather than one upload per
  terrain command; the inactive path uses a renderer-owned inert slice.
- Dynamic-environment capture distinguishes failed, sky-only, partial, and
  submitted work. It does not allocate an encoder/depth target or advance
  success state for a zero-draw replay, and a content epoch invalidates
  retained terrain/imagery input without per-tile publication objects.
- Cloud temporal/RTE and IBL-relevance work remains intact. A proposed shared
  shader-module hoist was rejected when timing showed no material benefit,
  which avoided adding indirection without a measured payoff.

These changes improve ownership, precision, or bounded optional-path cost.
They are not all whole-scene FPS wins, and the campaign documents label them
accordingly.

### 14.3 WebGL asynchronous shader compilation

The July 22 audit's seven recurring WebGL long tasks were traced to synchronous
`LINK_STATUS` completion queries. The current tree adds a real
`KHR_parallel_shader_compile` lifecycle:

1. a program starts uninitialized;
2. explicit scheduling submits compile/link without querying `LINK_STATUS`;
3. an idle callback polls only `COMPLETION_STATUS_KHR`;
4. link validation and reflection finalize once completion is reported;
5. an unexpected first bind or reflection getter synchronously completes the
   same program, preserving immediate correctness.

`ShaderCache` does not automatically schedule every created program. Callers
must nominate the exact final executable or enqueue an idle preparation
factory. Required compilation and speculative source preparation use separate
queues, and preparation runs only after the active/foreground queue drains.
`View` selects the same camera-visible derivation chain the draw will use:
log depth, then HDR, then shadow receive. Pick, depth-only, debug,
translucent/OIT, alternate-renderer, and extension-unavailable paths keep their
existing synchronous behavior.

That opt-in rule is justified by a rejected experiment:

| Policy | Programs / shaders | Blocking first-use waits | Async result | Long tasks |
| --- | ---: | ---: | ---: | ---: |
| Lazy static-variant baseline | 7 / 14 | 7 / 753.9 ms | 0 | 7 |
| Rejected automatic eager scheduling | 28 / 56 | same 7 required waits | 21 completed but unused | 7 |
| Accepted exact-final + bounded fog companion | 8 / 16 | 4 / 435.1 ms | 4 completions | 4 |

Automatic scheduling multiplied source generation and driver work by four
without removing a required stall. It was removed. The accepted policy adds
only one measured opposite-FOG globe companion for zero- and
one-imagery-texture cohorts. It remains disabled for active shadows,
translucency/OIT, debug/pick/depth, and larger imagery batches.

Fog prediction required separating configuration from current renderability.
`frameState.fog.configuredEnabled` records the public feature choice even above
the maximum fog height; `frameState.fog.enabled` remains the exact per-frame
render/cull decision. An orbital frame may therefore prepare the fog-on
executable before descent without drawing fog early or changing the scene.

The implementation also repairs globe-program ownership before speculative
work is allowed. A replacement program is acquired before the displaced
reference is released. The released wrapper is poisoned and its derived tree
is unscheduled, so a stale culled tile cannot later fast-return a destroyed
program.

This is an attribution (work-avoidance) result, not a certified timing win:
three of seven measured first-use `LINK_STATUS` queries are no longer issued on
the measured route, and the blocking time attributed to the surviving queries in
that single directional artifact is 435.1 ms against the 753.9 ms baseline (a
later principal-review rerun records 403.0 ms for the same four remaining
waits). Counterbalanced repetitions are still required before any before/after
frame-time delta may be claimed; the changeset landed as Batch 773 on
2026-08-01, which changes nothing about that gate. It is not
a claim that every WebGL shader variant is now asynchronous. Four structural
quantization × zero/one-texture first arrivals remain, and broader shadow,
translucent/OIT, debug/pick/depth, HDR, and multi-texture policies require their
own demand/payoff measurements before expansion.

### 14.4 Backend isolation and functionality gates

The WebGL scheduler is reached only from a real WebGL context with the parallel
compile extension. The WebGPU compatibility stub exposes no such extension and
does not enter either shader queue. The optimization therefore does not restore
the old WebGL-object-then-WebGPU-object allocation tax.

The current clean, non-instrumented three-run moving-altitude lane completes all
eight route segments from 18,000 km to about 301 m. Median CPU p95 is 7.43 ms,
median wall p99 is 20.8 ms, and each run records four long tasks. API
instrumentation is used only to attribute shader events; its CPU timings are
not mixed with the clean lane.

The nine-waypoint WebGL/WebGPU orbit-to-ground visual route settles at every
waypoint. Mean cross-backend image difference is 0.016% and the maximum is
0.073%; the orbit and ground captures were manually inspected. Focused
ShaderProgram, ShaderCache, scheduler, globe-shader, Fog, and WebGPU
compatibility suites pass, as do TypeScript and the full production build.
No fog, eclipse, imagery, log-depth, HDR, RTE, picking, or WebGPU feature was
disabled to obtain the result.

### 14.5 Current defense and next order

The continuation remains defensible for the same reason as the July 15 tranche:
it moves work to an exact owner and a safer time instead of deleting output.
It also records negative results when a wider policy increases work.

The next feature-preserving order is:

1. finish measuring the four remaining WebGL structural first-use variants;
   expand preparation only where a bounded cohort removes a demonstrated
   stall;
2. replace the parked caller-name WebGPU pipeline-cache patch with a semantic
   descriptor key covering shader-module/layout identity, entry points,
   constants, targets, depth/stencil, primitive state, and multisampling;
3. measure the synchronous WebGPU Sun texture bake before moving it to a GPU
   pass or reducing its source resolution;
4. move temporal history to each logical `View` and commit it once per
   presented frame, not once per pass-camera update;
5. connect terrain resource residency to the quadtree lifecycle, then build
   the retained-packet revision key and static/dynamic uniform split without
   weakening CPU-f64 RTE reconstruction.

Those items address remaining measured cost or correctness risk. None is
authorized to remove an effect, reduce visual quality silently, skip exact
picking, or sacrifice WebGL/WebGPU parity for a benchmark.
