# Campaign 8 — Correctness Closure and Renderer-Native Architecture

Prepared: 2026-07-15

Status: **FROZEN / SUPERSEDED FOR ACTIVE EXECUTION BY CAMPAIGN 9**

[Campaign 9](QUEUE_2026-07-15_CAMPAIGN9.md) was explicitly launched by the maintainer on 2026-07-15.
This file is frozen as historical evidence. Its open IDs transferred unchanged; completed slices are
maintained as Campaign 9 regression gates.

Launch authority: the maintainer explicitly instructed the agent to run the plan on 2026-07-15.
Campaign gates still control renderer changes, browser evidence, package-state advancement, and
promotion of a new baseline.

This is the next bounded campaign under the active
[Fork Architecture Remediation Plan](FORK_ARCHITECTURE_REMEDIATION_PLAN_2026-07-13.md). Campaign 7 is
frozen historical authority and must not be edited or relaunched from this queue.

## 1. Outcome

Campaign 8 closes the correctness defects exposed by the performance audit, establishes exact-current
evidence, and then moves the fork from shadow architecture into the first production submission and
resource-ownership verticals. It finishes with truthful display-paced and maximum-throughput tooling.

The campaign must improve features in place. No feature may be removed, bypassed, default-disabled,
or visually weakened merely to improve a metric. WebGL2 behavior, public APIs, request-render mode,
scene modes, picking families, TAA, materials, recovery, and mixed WebGL/WebGPU contexts remain part
of the acceptance surface.

## 2. Current-state reconciliation

The queue was checked against current source before preparation. These boundaries prevent stale work
from being implemented twice:

| Area | Current finding | Campaign treatment |
| --- | --- | --- |
| BufferPrimitive integer/normalized positions | Shared datatype/normalization decode is already used by WebGPU BufferPoint, BufferPolyline, and BufferPolygon, and a render probe exists. The results document's blanket “incomplete” statement is stale. | Run the full datatype/mode/mutation/pick certification matrix. Fix only a reproduced residual; otherwise close and reconcile the stale docs. |
| Polyline Image/DiffuseMap | Primitive/PolylineMaterialAppearance already has an Image shader route. PolylineCollection maps only Color/Arrow/Dash/Glow/Outline; DiffuseMap is a distinct layout/material and still falls through. | Scope work specifically to PolylineCollection, with separate Image and DiffuseMap slices. Preserve the primitive path as a regression control. |
| Voxel picking | The lower-level cell-coordinate gate exists. The current public probe fails in its WebGL setup before it can prove the separate public `scene.pickVoxel` tail. | Repair the harness first. Promote a product fix only if the repaired cross-backend probe reproduces a product failure. |
| WebGL Columbus View point | Current evidence is one WebGL-zero/WebGPU-visible observation; camera framing, projected position, culling, and depth have not isolated a product defect. | Proof-only slice first; change shared scene code only after a deterministic product repro. |
| WebGPU picking | Multi-frustum object passes and minimal request-owned staging are bounded corrections, not one query/submission architecture. Multi-frustum packed position depth remains incorrect. | Fix the legacy depth lifetime first, approve the backend-neutral query contract, then migrate to graph-owned query execution after submission authority exists. |
| Continuous hover picking | The old trailing drain could withhold every result while cursor traffic remained continuous. The current tranche replaces it with one active plus one latest-wins queued cycle and the performance lane now requires periodic delivery, bounded work, and a complete drain. | The bounded physical moving-altitude lane passed on both backends. Promote it as a maintained post-fix gate; FAR-107/FAR-409 still own immutable query identity, cancellation, serial publication, and graph-owned execution. |
| Pick-ID ownership | Ground/Classification now reuse the inner GeometryInstance ID, but GroundPolyline and Model still create semantically weaker duplicate IDs. GroundPolyline and Model-feature duplicates have missing destruction paths; Model-feature IDs/textures are also created eagerly on a normal WebGPU render. | Close each owner with exact public-result, allowPicking, mutation, registry-count, eviction, and destruction probes before the contiguous-ID migration. Never trade exact IDs or feature picking for a lower allocation count. |
| Model feature payload ownership | BatchTexture and the native Model feature path consume one shared dirty boolean while maintaining separate physical textures; the compatibility upload runs first and can leave the native WebGPU realization stale after setShow/setColor. | Introduce a monotonic logical payload revision with a per-realization upload cursor, then converge on one backend/device realization through FAR-204/205/206. |
| TAA and natural frusta | TAA currently combines a pre-jitter/full-camera inverse with later per-slice jitter and a final depth texture that cannot describe every depth-cleared frustum contributing to color. This is a source-contract defect; deterministic visible severity is not yet quantified. | Add a moving high-contrast near/far oracle, then adopt exact per-frustum matrix/depth versions or a graph-owned accumulated depth contract. Do not remove TAA or flatten the frustum architecture to improve a metric. |
| Indirect drawing | The tile policy defaults off, but PerformanceManager's default begin-frame path still instantiates the lazy indirect manager (~81,920 recorded bytes). Forced/auto execution remains unsafe until argument ranges are non-overlapping across passes/frusta. | Remove the idle/not-requested allocation without enabling the contained path. FAR-501/T7 own non-overlapping arena offsets and safe automatic selection. |
| Terrain effects | The effects cache bounds GPU buffers/bind groups/uploads, but terrain still rebuilds the global descriptor, LUT/shadow/clipping wrappers, uniform bytes, and resource-identity strings per tile and imagery pass. | Prepare one exact revision-keyed effects handle per frame/view and let terrain tiles consume it; retain distinct per-model effects state. Measure stage CPU/allocation change before promotion. |
| FAR-200 | Shadow types and serial APIs exist, but production allocation/retirement does not use them and 52 direct `queue.submit` sites remain in the recorded audit. | Adopt one physical-queue timeline in three separately gated slices. Centralization is not claimed as physical-submit reduction. |

Every slice begins with a short premise check. A stale premise closes as documentation and test work;
it must not trigger speculative renderer churn.

## 3. Campaign gates

| Gate | Required before crossing | Stop condition |
| --- | --- | --- |
| A — launch seal | One exact-current build hash; current source/worktree identity; complete moving-altitude clean and instrumented route; strict allocation-tax artifact; known-error ledger. | Any incomplete route, idle-soak substitution, mixed clean/instrumented metrics, device error, or unknown source hash. |
| B — correctness closure | Packed-depth, Color velocity, atlas orientation, voxel-inside, and any promoted conditional product fix are green; WebGL/WebGPU semantic and visual gates pass. | A feature is lost, a public result becomes less exact, or a fix relies on hiding/disabling the affected path. |
| C — authority change | Gate B exact-current rerun is recorded; allocation churn is owner-attributed; FAR-200 serial/loss/retirement tests pass for the next adoption cohort. | A private submit or resource publication cannot be tied to one physical queue, device generation, and completion serial. |
| D — ownership expansion | Two ownership verticals pass NATIVE_CONTEXT isolation, mutation, recovery, retirement, and plateau tests. | A complete native token creates a compatibility GPU realization, or WebGL/WebGPU GPU handles are shared. |
| E — final certification | One final build/hash runs the complete correctness, moving-altitude, allocation, lifetime, pacing, and affected visual matrices. | Unsupported no-vsync flags are reported as uncapped, historical baselines are overwritten, or any required lane is missing. |

## 4. Core queue

The core queue is prepared in execution order. Conditional items may close without engine changes when
their proof shows the recorded symptom was a harness or stale-document issue.

| # | ID | Pri | Effort | Work | Dependencies / acceptance summary |
| --- | --- | --- | --- | --- | --- |
| 0 | `C8-00-EXACT-CURRENT-LAUNCH-SEAL` | P0 | M | **✅ BOUNDED CHECKPOINT COMPLETE:** bundle `B8015811...11E` has moving-altitude, strict allocation, and correctness evidence. | Gate A's bounded seal is recorded in §8.1. Gate E still requires a new post-fix hash; Node/Edge only, clean/API lanes separate, idle soak invalid. |
| 1 | `NEW-PERF-DETERMINISTIC-VIEWER-BOOT` | P1 harness | S | Add an explicit local/offline Viewer boot used by deterministic probes, while retaining a separate credentialed streaming lane. | No implicit Ion/Bing/terrain request may start in the local lane; normal Viewer defaults and online functionality remain unchanged. |
| 1A | `C8-FORK-EXTENSION-COVERAGE-CLOSURE` | P0 test architecture | L | Inventory every fork-only or materially changed upstream subsystem and map it to the appropriate pure unit, mocked renderer unit, real-browser API probe, visual oracle, device-loss/lifetime test, and performance workload. Fill all P0/P1 holes before final certification; do not pretend mocks can certify cross-pass GPU behavior. | Machine-readable source-to-evidence matrix; every extension has an owner and at least one deterministic guard at the lowest useful level plus a real runtime/visual lane where GPU integration matters. Karma must fail nonzero when zero specs execute, the launcher dies, or `afterAll` throws. Multi-frustum classification, 2D wrap uniform lifetime, recovery, continuous picking, TAA/depth interactions, and WebGL/WebGPU parity receive explicit integration coverage. |
| 2 | `NEW-VOXEL-PICK-PROBE-CONTRACT` | P1 harness | S | Repair the WebGL setup/API contract in the public voxel-pick probe and keep the lower-level coordinate probe as a separate oracle. | Filled voxels return the expected cell/tile/sample/color, off-volume returns undefined, and neither backend throws. |
| 3 | `NEW-WEBGL-CV-POINT-ZERO-PROOF` | P1 proof | S | Capture actual/projected position, command, bounding volume, bin, depth state, globe on/off, and elevated/coplanar cases. | Promotes item 10 only if a valid on-screen point is deterministically lost by WebGL. |
| 4 | `NEW-BUFFERPRIMITIVE-INTEGER-NORMALIZED-CERT` | P1 proof | M | Certify the already-present shared decode across Point, Polyline, and Polygon. | BYTE/UBYTE/SHORT/USHORT normalized, signed extrema, integer raw, DOUBLE control, model matrix, 3D/CV/2D, mutation, and pick. Only reproduced residuals receive code changes. |
| 5 | `NEW-PICK-WEBGPU-MULTIFRUSTUM-PACKED-DEPTH` / `FAR-408-C0` | P0 | M | Register logical pixel requests, copy each requested 1×1 packed sample at its existing frustum depth-version boundary on the main frame encoder, and resolve through a context-owned generation-tagged readback batch after submit. | Natural multi-frustum globe/model/voxel/clear-depth matrix; near-to-far completed-sample resolution; no final empty near slice may overwrite far depth; no-query frames add zero work; active queries add no private submit or full-resolution per-frustum texture. This is the first PickQuery-compatible vertical, not full graph ownership. |
| 5A | `NEW-PICK-CLASSIFICATION-DEPTH-TRANSIENT` | P1 performance/architecture | M | Replace the lazily persistent full-viewport RGBA8 classification-pick depth checkpoint with a query-extent or graph-transient realization once the exact depth/query transform is declared. | Preserve terrain/3D-Tile classification pick IDs at center and every edge; a typical 1×1/3×3 query must not retain another viewport-sized texture (about 33 MiB at 4K); no normal-frame allocation, private submit, TAA/history clear, or feature loss. Until this lands, report the current one-texture memory cost honestly rather than removing classification picking. |
| 5B | `NEW-TAA-MULTIFRUSTUM-DEPTH-REPROJECTION-CONTRACT` | P0 correctness/proof | M | Reproduce and then repair the mismatch between per-frustum jitter/depth clears and TAA's single inverse/depth-history assumptions. | Moving high-contrast geometry spans near/far slices with TAA on/off and camera/object motion; exact current/previous depth identity and matching jittered inverse are recorded. Source-contract evidence is not reported as a visible regression until the oracle discriminates it. |
| 6 | `NEW-POLYLINE-COLOR-VELOCITY-GUARD` | P1 | S | Normalize the Cesium material type through `selectShaderKey` before the velocity eligibility/cache path. | Moving Color PolylineCollection with stationary camera writes nonzero velocity only when TAA is enabled; color output and off/restored output are unchanged. |
| 7 | `NEW-BILLBOARD-ATLAS-VFLIP` | P1 | M | Establish one atlas upload/UV orientation for main billboard, SDF label, and pick variants across 3D/CV/2D. | Asymmetric red-top/blue-bottom image, asymmetric glyph, alpha-sensitive top-hit/bottom-miss pick, and atlas growth/repack match WebGL. No per-mode flip hacks. |
| 8 | `NEW-VOXEL-INSIDE-CAMERA-BLACK` | P1 | M | Repair the proxy-face/cull/ray-interval contract for outside→boundary→inside→center→exit views. | Color, object pick, cell pick, velocity/depth, octree, megatexture, and custom-shader paths remain live; outside result is unchanged. |
| 9 | `NEW-VOXEL-PUBLIC-PICK-TAIL` | P1 conditional | M | If item 2 proves a public `scene.pickVoxel` product failure, repair exact traversal/result construction without weakening the probe. | Cross-backend exact VoxelCell identity and zero throw/device errors. Closes as “not reproduced” if the repaired harness is green. |
| 10 | `NEW-WEBGL-CV-POINT-ZERO` | P2 conditional | S/M | If item 3 proves a WebGL product failure, fix only the isolated cull/depth/position cause. | Yellow point is visible and pickable near its analytic/WebGPU projection; WebGL/WebGPU 2D/3D and all other collections remain unchanged. |
| 11 | `C8-11-CORRECTNESS-CHECKPOINT` | P0 gate | M | Rebuild and rerun the exact-current correctness, allocation, and moving-altitude evidence after items 5–10. | Gate B. A new artifact/hash is added; the earlier `D2A475A...` tranche remains historical and is not overwritten. |
| 12 | `NEW-POLYLINE-MATERIAL-VELOCITY-VARIANTS` | P2 | M | Add Dash, Arrow, Glow, and Outline velocity variants in bounded per-material increments. | Each velocity mask follows the material's discard/alpha silhouette, emits nothing when TAA is off, and passes mixed-material/mutation gates. Dash lands first as the strongest mask discriminator. |
| 13 | `NEW-POLYLINECOLLECTION-IMAGE-MATERIAL-WEBGPU` | P2 | M | Add PolylineCollection Image material without disturbing the existing primitive Image path. | Asymmetric texture, repeat, tint/alpha, mutation, pick, mixed material, and 3D/CV/2D parity. Solid-color fallback is not accepted. |
| 14 | `NEW-POLYLINECOLLECTION-DIFFUSEMAP-MATERIAL-WEBGPU` | P2 | M | Add a distinct DiffuseMap shader/layout/upload path rather than aliasing Image. | Channel swizzle, repeat, alpha, mutation, pick, mixed identity, velocity-mask compatibility, and cross-backend parity. |
| 15 | `FAR-107-PICKQUERY-CONTRACT` | P0 architecture | M | Approve immutable backend-neutral `PickQuery`/`PickResult`, generation, cancellation, output-demand, and honest sync/async semantics. | Public/API oracle covers object, drill, position, ray, height, metadata, voxel, and feature-ID families. This slice changes no execution authority. |
| 15A | `NEW-PICK-HOVER-LATEST-WINS-DELIVERY` | P0 correctness/performance | S | **✅ BOUNDED SLICE COMPLETE:** active-plus-latest scheduling and public object/undefined result contract pass focused and moving physical lanes. | Retain the slow-readback/rejection/drain/no-double-count tests and promote the moving lane after later query fixes. FAR-107/FAR-409 remain open; this slice does not claim cheap physical picking. |
| 15B | `NEW-PICK-ID-OWNERSHIP-GROUNDPOLYLINE` | P0 correctness/lifetime | M | Replace GroundPolyline's outer wrapper ID with the complete canonical inner GeometryInstance ID mapping and wire native-cache destruction. | Two separated instances return IDs A/B in 3D and projected/morph paths; allowPicking=false is unpickable; registry/native-resource counts return to baseline after removal. One uniform wrapper color is not accepted. |
| 15C | `NEW-PICK-ID-OWNERSHIP-MODEL` | P0 correctness/lifetime | L | Remove Model's duplicate primKey and per-feature PickId systems in favor of the canonical model/model-instance/feature ownership contract. | Standalone id and mutation, Entity id, pickObject, node/runtimePrimitive detail, 3D Tiles content/tileset, per-instance instanceId, feature identity, allowPicking=false, eviction, destruction, and device loss remain exact. Ordinary no-pick WebGPU frames do not eagerly create pick-only IDs/textures. |
| 16 | `FAR-006-CHURN` | P0 performance | M | Attribute the recorded buffers, destroys, textures, and external-image copies by owner, stage, payload/version, persistent/transient class, and expected lifetime. | Separate cold/loading/settled/moving/mutation windows; settled budgets and streaming plateaus are explicit; tracing overhead is measured separately. |
| 16A | `NEW-MODEL-FEATURE-PAYLOAD-REVISION` / `FAR-204` | P0 correctness/ownership | M | Replace BatchTexture's shared dirty-consumer race with one logical payload revision and independent realization upload cursors. | A live WebGPU setShow/setColor mutation after first draw updates exactly; WebGL/WebGPU contexts cannot clear each other's pending upload; recovery and eviction recreate only the owning backend/device realization. |
| 16B | `NEW-INDIRECT-IDLE-ALLOCATION-CONTAINMENT` | P1 performance | S | **✅ BOUNDED SLICE COMPLETE:** default/not-requested PerformanceManager frames no longer construct the indirect manager; explicitly requested capability remains intact and contained. | Exact-current strict allocation reports no indirect labels and focused specs pass. No auto/default activation until FAR-501 owns non-overlapping per-frame/frustum/pass slices. |
| 16C | `NEW-GLOBE-EFFECTS-PER-VIEW-PREPARED-HANDLE` / `FAR-300` | P1 performance | M | Hoist terrain-global effects preparation out of the tile/imagery-pass loop behind exact frame/view/resource revisions. | Shadows, clipping planes/polygons, CSM, atmosphere LUT, multi-view cameras, and mutation stay exact; settled terrain performs one descriptor pack/cache lookup per view revision, with measured CPU/allocation improvement. |
| 17 | `FAR-200-S1-PHYSICAL-QUEUE-TIMELINE` | P0 architecture | M | Make one monotonic serial authority own each physical queue/device generation. | Submit, abandon, pooled-context, destruction, loss, and completion tests; no production caller migration yet. |
| 18 | `FAR-200-S2-SUBMIT-SOURCE-ADOPTION` | P0 architecture | L | Route the recorded direct-submit cohorts through FAR-200 and add a static architecture guard. | Direct `queue.submit` count reaches the explicit allowlist/zero target; every submission has source/owner/generation/serial. Routing alone is not reported as fewer submits. |
| 19 | `FAR-200-S3-SERIAL-OWNED-RETIREMENT` | P0 architecture | M | Tie resource/ring/readback retirement to the authoritative completion serial. | No early reuse/destroy across pooled contexts, resize, failure, or device loss; bounded retirement plateaus under soak. |
| 20 | `NEW-PICK-CONTIGUOUS-ID-RANGES-LOGICAL` / `FAR-107` | P0 architecture | M | Add one guarded allocator/decoder for direct IDs and contiguous feature ranges. | Zero and terminal sentinel reserved; overflow rejected; direct IDs decode before binary-searched ranges; high-alpha-byte and retirement tests pass. No renderer migration yet. |
| 21 | `NEW-PICK-CONTIGUOUS-ID-RANGES-NATIVE` / `FAR-205` | P0 performance | L | Move model/BatchTexture WebGPU feature picking to `baseKey + featureId`, avoiding N CPU PickIds/RGBA bytes/legacy pick textures on ordinary WebGPU rendering. | Depends on 15 and 17–20. WebGL may materialize RGBA arithmetically; no-pick WebGPU frames allocate no per-feature pick resources; every public pick feature remains exact. |
| 22 | `FAR-209-RESOURCEPLAN-OBSERVE` | P0 architecture | M | Land the existing incremental ResourcePlan/resource-command-list design in observe mode for one family. | No competing scheduler. Plans carry payload/version/domain/descriptor/dependencies/cancellation; no GPU resource is published from observe mode. |
| 23 | `FAR-209-ACTIVE-PILOT` + `FAR-210-BUDGETS` | P0 performance | L | Activate one off-hot-path preparation family with budgets/backpressure after FAR-200 owns publication serials. | Draw emission performs no fetch/decode/full conversion/persistent creation/private submit; stale generations cannot publish; WebGL synchronous contracts remain intact. |
| 24 | `FAR-203-FIRST-OWNERSHIP-VERTICAL` | P0 architecture | L | Migrate the first correctness-green terrain/mesh ownership vertical to explicit native ownership. | A complete native token creates zero compatibility GPU realization; partial coverage retains the fallback owner; WebGL and mixed-context behavior pass. |
| 25 | `FAR-205-IMMUTABLE-TEXTURE-VERTICAL` | P0 architecture | L | Migrate one deterministic immutable texture family, provisionally water masks, after orientation/identity fixtures pass. | Separate context-bound WebGL/WebGPU objects share only exact-compatible decoded payload; mutation, recovery, retirement, and flyover plateau pass. |
| 26 | `FAR-206-DECODED-REALIZATION-SPLIT-GATE` | P1 architecture | M | After two ownership verticals are green, decide and, if qualified, enable the decoded-product/backend-realization cache split for those families only. | Complete fetch/decode/transcode fingerprint, NATIVE_CONTEXT isolation, and no cross-backend GPU-handle sharing. Otherwise remain planned with the failed gate recorded. |
| 27 | `NEW-COMMANDSORTER-FRONTTOBACK-EPSILON-TIES` | P2 correctness/performance | S | Reconcile `CommandSorter.frontToBack`'s `+ CesiumMath.EPSILON12` tie behavior with the reusable active-range merge sorter and upstream/WebGL ordering semantics. | Prove current and upstream behavior first; exact-distance commands must have a documented deterministic order, the pooled tail must remain untouched, and any comparator change must pass translucent/pick visual parity. Do not claim a stable sort while the comparator returns positive for exact ties. |
| 28 | `FAR-307-POLYLINE-PERSISTENT-MATERIAL-TABLE` | P1 performance | L | Preserve exact same-type/different-uniform material semantics while replacing one resource/geometry/command cohort per object identity with a persistent material table, safe value coalescing, and dirty-range segment updates. | High-cardinality materials scale without reverting to first-material uniforms; mixed Color/Arrow/Dash/Glow/Outline visuals, mutation, pick, and TAA velocity remain exact. |
| 29 | `NEW-GPU-TIMESTAMP-UNIQUE-SAMPLE-ACCOUNTING` | P1 tooling | M | Give every completed timestamp sample a unique submission/frame serial and consume it once in the campaign runner. | Delayed rolling values are never duplicated into multiple Scene trace rows; readback tail drains; covered/uncovered GPU span remains explicit. Until then timestamp p95 is characterization only, never certification. |
| 30 | `NEW-SCENE-BROAD-SUITE-FAILURE-CLOSURE` | P0 correctness/test | L | Close the exact-current Scene run's 47 failures plus `afterAll`. Product clusters are WebGL1 async-pick routing, GLSL100 additional-light generation, VoxelBounds' missed `maximumTextureSize` argument, CubeMapPanorama validation, and the shared ES6 teardown defect. Fixture clusters need renderer-neutral limits/`getFeatureRenderer`/clip-space contracts; environment-map numeric assertions require a semantic oracle before any product math change. | WebGL1 uses Promise-wrapped sync reads without PBO/fence while WebGL2/WebGPU retain native paths; generated GLSL100 compiles for ray/sample/clamp/additional-light variants; voxel render/pick and per-context limit tests pass; panorama validation matches across backends; terrain/globe/camera tests execute their real assertions through shared renderer-neutral fixtures; irradiance checks use finite energy/chromaticity/directional reconstruction; no exclusion or timeout inflation. |
| 31 | `NEW-SHADER-MODULE-CACHE-FULL-DEFINE-IDENTITY` | P0 correctness/performance | S | **✅ COMPLETE:** the 24-bit-truncated WGSL define identity is replaced by one exact, allocation-free 40-bit safe-integer key for source ID plus all 32 define bits. | Signed/unsigned Uint32 masks normalize identically; invalid IDs/masks fail loudly; dynamic-source `keySalt` remains independent; focused shader family 98/98 and broad WebGPU 1,505/1,505 pass. No ordinary-hit string allocation or forced recompilation. |
| 32 | `NEW-DESTROYOBJECT-ES6-LIFECYCLE-PARITY` | P0 correctness/lifetime | M | Make `destroyObject` discover ES6 prototype-chain methods as well as legacy and own instance functions; the current `for...in` leaves converted resource methods live and permits repeated native teardown. | Never invoke getters or touch statics; inheritance and own functions are covered; `isDestroyed()` is true and every former instance method follows the normal destroyed-object contract; a second destroy cannot repeat native deletion; all ten current Renderer lifecycle failures pass; teardown-only logic adds no render-hot-path work. |
| 33 | `NEW-SHADER-GENERATOR-UPSTREAM-CONTRACT-PARITY` | P1 correctness/cache | S | Restore `ShaderFunction.addLines` debug validation and remove conversion-only terminal empty-line sentinels from generated function/struct arrays. | All ShaderBuilder/ShaderFunction/ShaderStruct assertions pass; legal empty functions remain supported for metadata-free models; empty structs retain `float _empty;`; exact shader/cache bytes do not gain a semantically useless trailing line. |
| 34 | `NEW-RESOURCE-URL-SEMANTIC-PARITY` | P1 correctness/API | M | Replace the partial WHATWG reconstruction that canonicalizes host spelling, drops credentials/default ports, and corrupts `file:`/opaque schemes with an explicit upstream-compatible Resource URL contract. | Authority, credentials, protocol-relative and relative inputs, `file:`/opaque/custom/data/blob schemes, case-sensitive paths, query, and fragment pass direct Resource and CZML tests; do not “fix” only the two hostname-case expectations. |
| 35 | `NEW-DATASOURCECOLLECTION-CONTAINS-PARITY` | P0 correctness/API | S | Repair the ES6/codemod regression where `contains` calls nonexistent `this.includes`. | False→true→false add/remove behavior, promised additions, removeAll, index/get/length, and destroyed-collection contracts pass; add a guard against wrapper calls being rewritten to nonexistent class methods. |
| 36 | `NEW-ENTITY-BULK-CLUSTER-TRANSITION-PARITY` | P0 correctness/performance | L | Preserve public default-visualizer callback compatibility and make BulkPoint/BulkBillboard/BulkLabel reclassify when clustering or per-type cluster flags change after setup. | Dedicated unit coverage exercises disabled→enabled→disabled through a real DataSourceDisplay for all three types; every entity moves exactly once with no duplicates, stale primitives, listeners, or settled per-frame O(N) work; picking, bounding spheres, destruction, and WebGL/WebGPU visuals pass. |
| 37 | `NEW-KMZ-ARCHIVE-URI-RESOLUTION-PARITY` | P0 correctness/loader | M | Restore embedded BalloonStyle asset and nested NetworkLink resolution inside KMZ archives after the URI-library replacement. | Root/nested `./`/`../`, slash normalization, encoding, case-sensitive archive keys, embedded data, and download links pass; an existing archive entry never falls through to HTTP; archive-root traversal is rejected; complete KML suite passes. |
| 38 | `NEW-POLYLINE-UPDATER-CONSTANT-API-PARITY` | P1 correctness/API | S | Restore ES6-conversion-dropped read-only `isClosed`, `outlineEnabled`, `hasConstantOutline`, and `outlineColorProperty` descriptors. | All focused PolylineGeometryUpdater plus GeometryVisualizer/static-batch suites pass; the false/true/undefined public values match upstream; WebGL/WebGPU geometry, batching, and visuals do not change. |
| 39 | `C8-SHARED-UPSTREAM-CONTRACT-GATE` | P0 test architecture | L | Treat broad Renderer, DataSources, Scene, and Widgets plus the complete engine run as a required complement to fork-focused WebGPU suites. | Exact bundle/hash summary records pass/fail/unexecuted counts; all product regressions above close; fixture changes represent real renderer-neutral state; no assertion is weakened merely because fork-focused tests pass. |
| 40 | `NEW-FULL-SUITE-OFFLINE-DEPENDENCY-ISOLATION` | P1 test infrastructure | M | Prevent Ion/world-terrain/sampleTerrain network or credential failures from aborting unrelated unit execution. | Deterministic local fixtures or an explicit credentialed online lane own those tests; optional network unavailability can skip only declared cases; `afterAll` cannot terminate the remaining suite; reports distinguish product, fixture, environment, and unexecuted cases. |

## 5. Gated tail

The following items are in Campaign 8's prepared tail but do not automatically enter active execution.
Each requires an explicit stop/go review after Gate D; failure or schedule pressure defers the untouched
tail without weakening the completed core.

| # | ID | Pri | Effort | Work | Entry / exit gate |
| --- | --- | --- | --- | --- | --- |
| T1 | `FAR-400/FAR-401-SHADOW-GRAPH` + `FAR-408-S1` | P1 | L | Compile an observe-only frame graph with explicit scene attachments and natural-frustum depth versions. | Requires FAR-200 plus correctness-green depth matrix. Snapshot must reproduce current pass/order/resource identity without owning execution. |
| T2 | `FAR-402-BOUNDED-NODE-MIGRATION` | P1 | L | Move a bounded encoder/submit cohort to graph nodes using FAR-200. | No private submit, undeclared attachment, or order change. One physical submit is not claimed until FAR-406. |
| T3 | `FAR-408-S2-GRAPH-OWNED-DEPTH` | P1 | L | Make exact depth versions and pack/resolve nodes active for the migrated cohort. | Globe/model/voxel/classification/TAA/pick matrix proves exact producer/version/consumer identity. |
| T4 | `FAR-409-GRAPH-OWNED-PICK-MINIFRAME` | P1 | XL | Compile requested pick outputs as a mini-frame with a bounded at-least-three-slot generation-tagged readback pool. | Depends on FAR-107, FAR-200, FAR-300, FAR-400/401/402, and FAR-408. Concurrent cancellation/coalescing/retirement and complete query-family matrix pass. |
| T5 | `FAR-001/FAR-006-TIMESTAMP-COVERAGE` | P1 | M | Extend owner/stage attribution and GPU timestamps to the unprofiled submitted-frame remainder. | Every artifact reports covered and uncovered time; unsupported timestamps remain truthful, never synthesized. |
| T6 | `FAR-007-RENDER-PACING-LANES` | P1 tooling | L | Add `renderPacingMode` (`DISPLAY_PACED`, `MAXIMUM_THROUGHPUT`), a convenience display-pacing boolean, a Viewer control, and Node/Edge launch verification. | Engine maximum-throughput mode depends on FAR-200 bounded in-flight work. Ignored/unsupported flags mark the lane unavailable. Report CPU renders/s, completed GPU throughput, p50/p95/p99, queue/pass/write rates, thermal/stability metadata, and pacing mode. Do not call the checkbox raw “vsync control.” |
| T7 | `FAR-003-SAFE-AUTO-RESTORATION` | P1 conditional | L | Restore automatic GPU culling/Hi-Z/sort/indirect selection only after identity/readback hazards are removed and dense-scene visual/performance promotion passes. | Capability is preserved throughout. Containment is never counted as a performance win; no default flips on evidence from a forced-only path. |
| T8 | `C8-FINAL-CERTIFICATION-AND-REVIEW` | P0 gate | L | Run final exact-current build/hash, complete moving-altitude capped and maximum-throughput lanes, strict allocation/lifetime probes, affected API/visual matrices, and architecture review. | Gate E. Record regressions as fixes/deferred follow-ups; do not paper over them or remove features. |

## 6. Work deliberately outside Campaign 8

- Full NATIVE_DEVICE immutable WebGPU sharing (FAR-207) until every affected family first passes
  NATIVE_CONTEXT ownership, exact identity, recovery, and retirement.
- Full Model ownership (FAR-204) until geometry, texture, decoded-product, and submission foundations
  are green. Existing bounded model caches remain in place.
- Full uniform hierarchy (FAR-300/302/303), persistent tables, and complete FAR-309 frontend cleanup;
  Campaign 8 may only use bounded work needed by an approved dependency.
- FAR-405 pass merging/transient aliasing until active FAR-408 depth identities and all graph consumers
  are declared. Empty-boundary reductions already present remain subject to exact-current gates.
- FAR-403/404 MRT/OIT topology, FAR-406 sole graph authority, FAR-407 WebGL graph adoption, and the
  FAR-500 visibility/indirect scheduler series beyond the conditional safe-auto restoration.
- Experimental WebGPU feature promotion and large net-new rendering features. They resume only through
  the active architecture plan's later gates; Campaign 8 does not remove or silently abandon them.

## 7. Evidence and landing rules

1. Use Node/Playwright with Microsoft Edge for browser automation; do not introduce Python tooling.
2. The canonical performance route is the continuous track-camera flight across all configured
   altitudes. Request-render idle FPS is not evidence.
3. Build once per comparison, record the bundle hash, and run counterbalanced renderer order. Clean,
   instrumented, display-paced, and maximum-throughput results are separate populations.
4. Every visual change receives current WebGL/current WebGPU comparison plus a renderer-specific
   historical comparison where a certified baseline exists. Read the images; a numeric diff alone is
   insufficient.
5. Every ownership change records logical/native create, upload, destroy, live/high-water bytes,
   device generation, completion serial, and steady-state plateau.
6. Every slice has a focused semantic test and affected regression set. A broad suite cannot replace
   the focused oracle, and a focused probe cannot replace the final integrated run.
7. One bounded behavioral concern per landing slice. Shadow/observe infrastructure does not claim
   production authority, and central submit routing does not claim submit reduction.
8. Any newly exposed broken feature is added to the end-of-performance correctness ledger with a
   reproducer, ownership, priority, and acceptance gate. It is not removed to protect a metric.

## 8. Active execution checkpoint

The maintainer launched Campaign 8 on 2026-07-15. The current bounded tranche completed the
classification/hover-pick correctness work, default indirect-allocation containment, exact-current
compile/focused/broad execution, moving-altitude normal and continuous-pick campaigns, strict
allocation evidence, and the weekly performance-change defense. The shared/full test gate summarized
in §8.1 remains open, and Gate D's prepared tail is not implicitly active.

Newly exposed defects remain queued above with explicit oracles. A passing focused suite does not
advance Gate B or E by itself. The bounded physical/visual/performance lanes below must be rerun after
the queued fixes, while the loss/lifetime matrix and historical manifest remain incomplete and
non-certifying.

### 8.1 Exact-current bounded checkpoint

The completed bounded checkpoint uses source anchor `a54cc06b2aad89a00e8ecb0887b953a36f061954`
with a declared dirty tree and bundle SHA-256
`B8015811ACC0567663C6898386DC74AD94424363B22DA2A1759DF54AC666C11E`.

- Production build, TypeScript no-emit, Node harness/policy suites, focused picking/performance/shader
  suites, broad WebGPU 1,505/1,505, and Widgets 429/429 pass.
- Classification, natural multi-frustum pick, strict compatibility-buffer allocation, and the full
  nine-waypoint current WebGL/WebGPU visual route pass their bounded physical gates.
- The clean moving-altitude protocol passes, but WebGPU CPU p95 is 9.83/8.50 ms (median 9.165 ms), so
  the exact-current run does not demonstrate a net CPU improvement over the historical tranche.
- Continuous moving pick drains with zero rejection, but WebGPU physical-pick p95 is 8.30/7.71 ms
  versus WebGL 2.90/2.30 ms. Query mini-frame/readback architecture remains active work.
- Renderer is 2,493 pass/20 fail, DataSources 1,824 pass/10 fail, Scene 5,704 executed/47 fail plus an
  `afterAll`, and the full engine run aborts at 4,620/17,455 with seven failures. These are an open
  upstream/shared-contract gate, not waived failures.

The complete rationale and evidence boundary are in
[Fork Performance Weekly Change Defense](FORK_PERFORMANCE_WEEKLY_CHANGE_DEFENSE_2026-07-15.md); the
machine-readable coverage verdict is in
[Fork Extension Test Coverage Matrix](FORK_EXTENSION_TEST_COVERAGE_MATRIX_2026-07-15.json).
