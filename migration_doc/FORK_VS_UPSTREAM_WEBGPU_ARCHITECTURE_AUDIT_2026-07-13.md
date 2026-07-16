# Fork vs Upstream WebGPU/WebGL Architecture Audit

Date: 2026-07-13

Implementation plan: [Fork Architecture Remediation Plan](FORK_ARCHITECTURE_REMEDIATION_PLAN_2026-07-13.md)

Fork HEAD: a54cc06b2aad89a00e8ecb0887b953a36f061954

Current upstream/main: 4a7c4d4485ea5679214475f45cf92ca487af5096

Merge base: 7984bb31d89a97c76e818418714777b1fb44c163

## Executive verdict

The fork has built a broad and technically ambitious WebGPU renderer. It has real implementations for globe, models, collections, 3D Tiles-adjacent paths, post processing, atmosphere, clouds, compute, picking, precision handling, device pooling, optional features, and a large diagnostic surface. This is far beyond a proof of concept.

The allocation follow-up confirms the suspected WebGPU double tax in substance, but not through a native WebGL context. A WebGPU Scene requests only `canvas.getContext("webgpu")`; it also installs a WebGL-shaped compatibility object whose `createBuffer` and texture operations allocate real WebGPU resources. Generic and ground primitives, terrain, and glTF/model-backed 3D Tiles then create a second native WebGPU geometry realization. Image-backed Material uniforms, terrain water masks, the ocean normal map, and some feature-table textures also have duplicate upload paths. This is avoidable GPU residency, upload bandwidth, JavaScript object construction, and lifetime complexity on WebGPU-only applications.

It is not yet safe to treat the high-density path as a production GPU-driven renderer. The review found confirmed correctness blockers in renderer selection, multi-context global state, ViewportQuad dispatch, lazy feature-renderer readiness, OIT/MSAA, and the cull/HiZ/sort/indirect scheduling paths. Several of the advertised GPU optimizations currently add GPU-to-CPU feedback loops after Cesium has already performed CPU culling, and shared buffers are reused across frustums before the single end-of-frame submission. Those problems can produce validation failures, stale visibility, incorrect draw parameters, missing translucent commands, and device-loss failures.

The strongest architectural decision already present is the GraphicsContext plus FeatureRenderer seam. Keep it, but finish the abstraction. The target should be:

1. one backend-neutral Scene frontend;
2. one explicit frame graph that owns pass, encoder, attachment, and transient-resource lifetime;
3. backend compilers for WebGL2 and WebGPU;
4. context-free source/decoded asset caches plus at most one primary realization per exact descriptor in each WebGL-context or final WebGPU-device domain;
5. a GPU-resident WebGPU visibility and indirect path without normal-frame readback;
6. shared material/shader semantics compiled to GLSL or WGSL;
7. per-context state and per-device generations, with no process-global renderer state.

Until the release blockers are fixed and covered, auto tile-indirect, translucent GPU culling, HiZ consumption, and GPU-sort consumption should be experimental opt-ins rather than automatic thresholds. OIT should be disabled until its depth/stencil attachment contract is corrected; mixed-capability translucent sets must also retain an alpha fallback path.

## Scope and method

This audit read the current project rules and the current migration, debugging, queue, feature-inventory, cloud, Three.js research, vegetation, and deferred-work documents requested for this review. Code was treated as authoritative wherever documents disagreed.

The review:

- fetched current upstream/main on 2026-07-13;
- generated the complete tree diff against current upstream and the fork-only diff from the merge base;
- classified changed files by status, top-level area, engine subsystem, extension, and size;
- traced shared Scene, GraphicsContext, FeatureRenderer, command, framebuffer, pass, cache, culling, sorting, indirect, OIT, shader, precision, and device-loss paths;
- traced buffer, texture, loader, decoded-asset, compatibility-stub, device-pool, and cross-context ownership paths;
- built the project and ran TypeScript, targeted lint, repository guards, targeted Edge unit specs, a Node-served Edge browser smoke benchmark, and a Node/Playwright Edge GPU-allocation probe;
- compared the architecture to primary 2026 WebGPU sources and official Three.js, Babylon.js, and PlayCanvas material.

This is a complete generated diff plus a risk-based architectural and correctness review. A 52 MB patch was not falsely represented as a line-by-line proof of every added feature.

## Complete diff inventory

The complete artifacts are:

- ../tmp/fork-audit-2026-07-13/complete-fork-vs-current-upstream.patch
- ../tmp/fork-audit-2026-07-13/complete-fork-vs-current-upstream.name-status.tsv
- ../tmp/fork-audit-2026-07-13/complete-fork-vs-current-upstream.numstat.tsv
- ../tmp/fork-audit-2026-07-13/fork-only-since-merge-base.patch
- ../tmp/fork-audit-2026-07-13/fork-only-since-merge-base.name-status.tsv
- ../tmp/fork-audit-2026-07-13/upstream-pending.name-status.tsv

| Measure | Result |
| --- | ---: |
| Fork-only commits after merge base | 948 |
| Upstream commits after merge base | 21 |
| Current fork vs current upstream | 2,414 files, +666,138 / -125,723 |
| Fork-only vs merge base | 2,409 files, +666,117 / -125,668 |
| Added files vs current upstream | 1,822 |
| Modified files vs current upstream | 592 |
| Complete patch size | 52,264,160 bytes |

Top-level changed-file counts:

| Area | Files |
| --- | ---: |
| packages | 1,492 |
| Tools | 690 |
| migration_doc | 116 |
| Apps | 66 |
| scripts | 19 |
| Specs | 12 |

Engine Source concentration:

| Subsystem | Changed files |
| --- | ---: |
| Scene | 350 |
| Shaders | 340 |
| Renderer | 276 |
| Core | 107 |
| DataSources | 98 |

The WebGPU renderer directory contains 225 JavaScript/TypeScript files. Forty-one are over 1,000 lines despite the project decomposition rule. The largest are WebGPUModelRenderer.ts at 6,157 lines, WebGPUPrimitiveCommands.ts at 5,101, WebGPUContext.ts at 4,768, WebGPUSceneRenderer.ts at 4,251, and WebGPUModelPipelineCache.ts at 4,067. This is now a correctness and reviewability risk, not just style debt.

## Release blockers

### B1. Renderer selection silently contradicts the public default

RendererType.ts:92-97 declares WebGPU as the global default and AUTO resolves through that preference. Scene.createAsync only uses ContextFactory when contextOptions.renderer is exactly webgpu at Scene.js:1492-1515. Every other value, including omitted renderer, auto, preferWebGPU, and webgpu-compat, falls through to the synchronous constructor, which creates the legacy WebGL Context at Scene.js:173-186.

The same exact-string selection exists in Widget/CesiumWidget.js:544-617 and packages/widgets/Source/Viewer/Viewer.js:1916-1924. ContextFactory itself chooses WebGPU for AUTO from navigator.gpu, but does not catch adapter/device/context initialization failure and retry WebGL.

Impact:

- the documented default and actual default differ;
- AUTO is not an actual fallback policy;
- compatibility mode is bypassed by the primary creation paths;
- tests can believe WebGPU is selected while silently exercising WebGL.

Required change:

- make every asynchronous entry point resolve RendererType through ContextFactory;
- make AUTO attempt WebGPU and explicitly fall back to WebGL on initialization failure;
- keep the synchronous Scene constructor explicitly WebGL-only, or reject a WebGPU request rather than silently changing backend;
- expose the resolved backend and fallback reason in diagnostics.

### B2. Process-global depth and capability state breaks heterogeneous contexts

GraphicsContext advertises simultaneous heterogeneous contexts, but Scene construction mutates Matrix4._depthRangeType globally at Scene.js:190-197. Matrix4 consumes that global in projection builders at Core/Matrix4.js:834, 901, 970, 1033, and 3066-3091. WebGPU reasserts the global per frustum at WebGPUSceneRenderer.ts:1637-1645; WebGL does not symmetrically reset it per frame.

ContextLimits and KTX2 support are also process-global and overwritten by whichever context initializes last:

- Renderer/Context.js:444-501, 570, 586, 704-707
- Renderer/WebGPU/WebGPUContextLimitsInit.ts:54-103
- Renderer/WebGPU/WebGPUContext.ts:2238-2254

Impact: a WebGPU scene can poison projection matrices, limits, or compressed-format decisions for a WebGL scene in split-screen or multi-view use.

PerspectiveOffCenterFrustum.js:461-504 compounds the problem by caching projection inputs without including clip-space convention. OrthographicOffCenterFrustum tracks the convention, but perspective can return a stale matrix after the global changes.

Required change: make depth-range policy, limits, and texture-format support immutable per context. Pass an immutable clip-space convention to projection construction, include it in frustum cache identity, or provide backend-specific projection helpers. Do not store renderer-dependent state on Matrix4 or other process globals.

### B3. Translucent GPU culling opens compute work inside an active render pass

WebGPUSceneRendererTranslucentPass.ts:98-114 invokes translucent culling at the start of the translucent pass. WebGPUSceneRendererFrustumLoop.ts:629-632 can call it after the scene render pass has been resumed. WebGPUSceneRenderer.ts:3569-3617 does not end and resume the render pass around the operation. WebGPUGPUCuller.ts:399-407 then calls beginComputePass on the same encoder.

This violates WebGPU encoder locking and can produce GPUValidationError in dense translucent scenes.

The same path has a map-before-submit hazard. prepareReadback at WebGPUGPUCuller.ts:417-448 pumps and maps a pending slot. The shared translucent culler is reused per frustum, so a later frustum can map a staging buffer whose copy was just recorded by an earlier frustum into the still-unsubmitted frame encoder.

Required change: schedule all high-density compute before raster passes in a frame graph. Pump prior-frame readbacks once at frame start, never during another slice that may have just recorded a copy.

### B4. HiZ visibility is global while depth and command lists are per frustum

The frustum loop clears depth for every slice at WebGPUSceneRendererFrustumLoop.ts:311-326. HiZ dispatch is invoked after every opaque slice at WebGPUSceneRenderer.ts:2130-2169, but one global in-flight flag and one global result are used. The result is accepted for another command list based only on equal count at WebGPUSceneRenderer.ts:3741-3769.

Equal command counts do not prove equal command identity, camera generation, frustum, or depth image. A visibility bitset from the far slice can therefore suppress unrelated geometry in another slice.

Required change: either build one unified camera-depth prepass or store HiZ/result state per frustum. Tag all results with frame generation, frustum index, command-list generation, and camera generation. Never accept count-only identity.

### B5. Tile indirect parameters are overwritten before recorded draws execute

The 3D-tile indirect path auto-enables at 32 commands in WebGPUSceneRenderer3DTilePasses.ts:31-37, 75-82, and 148-169. executeBatchIndirect calls manager.beginFrame for every pass/frustum at WebGPUSceneRenderer.ts:473-475, resetting offsets to zero. WebGPUIndirectDrawManager.ts:222-237 uploads the shared indirect buffer from offset zero.

All of those drawIndexedIndirect calls remain merely encoded until the single end-of-frame submit at WebGPUContext.ts:2022-2024. A later pass/frustum queue.writeBuffer therefore overwrites parameters that earlier encoded draws will read.

The fast path also bypasses normal WebGPUDrawCommand semantics at WebGPUSceneRenderer.ts:509-577, including resolved classification-depth pipelines, dynamic bind groups, and complete render state.

Required change: use one monotonic per-frame indirect arena with non-overlapping offsets and one upload before submission. Preserve the fully resolved pipeline, state, vertex/index layout, and bind-group signature in the batch key.

### B6. GPU sort reuses and may reallocate shared buffers before submission

One context-wide WebGPUGPUSortKeysDispatcher is called per active opaque frustum at WebGPUSceneRenderer.ts:2153-2169. Each dispatch writes the same SOA buffers and parameter offsets at WebGPUGPUSortKeysDispatcher.ts:571-607 and 760-813. Earlier compute commands therefore observe later uploads when the frame finally submits.

A later frustum can also grow and replace resources already referenced by earlier encoded commands. prepareIndicesReadback at lines 643-669 can map the previous slot even when that slot was just populated by an unsubmitted copy in an earlier frustum.

Required change: per-frustum resources or a suballocated frame arena, with no mapping until the producing submission completes.

### B7. OIT uses an invalid depth/stencil attachment contract

WebGPUSceneRendererEnsureResources.ts:211-223 publishes depthSampleableView as _depthStencilView. At sample count 1, that is a depth-only-aspect view, but WebGPUOIT.ts:123-153 installs it as a depth-stencil attachment and always supplies stencil load/store operations. Under MSAA, WebGPURenderTarget.ts:248-276 and 452-465 instead make depthSampleableView a single-sample r16float color resolve view, which adds format and sample-count incompatibilities.

OIT tracks scene sample count at WebGPUOIT.ts:157-193, but its accumulation and reveal textures are single-sample at lines 198-216, and it creates MSAA pipelines at lines 336-343 and 559-575. This produces incompatible sample counts and an r16float color view used as depth/stencil.

Mixed translucent sets also lose draws. Once any command has an OIT pipeline, WebGPUSceneRendererTranslucentPass.ts:126-168 enters the OIT path, lines 226-231 draw only commands with _oitPipeline, and lines 257-264 return without rendering the remaining translucent commands through alpha fallback.

The manual OIT draw loop at WebGPUSceneRendererTranslucentPass.ts:181-223 also omits parts of the normal command contract, including dynamic offsets, viewport/scissor/stencil/blend constants, indirect drawing, and some draw offsets.

Required change:

- expose distinct sceneColorAttachmentView, sceneColorResolvedView, depthAttachmentView, and depthResolvedSampleView contracts;
- choose either a true multisampled OIT path with compatible attachments and resolves, or a completely single-sample OIT path after resolve;
- partition OIT-capable and fallback commands and render both;
- use exact pipeline/sample/attachment validation tests.

### B8. WebGPU ViewportQuad is broken and cannot represent Cesium materials

Scene/ViewportQuad.js:144-169 creates a fixed materialUniforms map for a simple WGSL color shader. Line 187 immediately overwrites it with the WebGL Material uniform map. The fixed shader does not represent Image, Stripe, or custom Fabric materials.

WebGPUViewportQuad.ts:500-576 returns a command marked only as _isViewportQuadCommand, without the normal WebGPU command markers/pipeline shape. OVERLAY commands normally go through the shared loop at SceneRenderer.js:769-776, which calls execute(context, passState). The command interprets its first argument as GPURenderPassEncoder, so it treats WebGPUContext as an encoder. A bind-group mismatch at WebGPUViewportQuad.ts:551-563 is caught locally, but the later setPipeline TypeError is not; it can escape to Scene's outer render-error handler. This route therefore cannot reliably issue the draw.

Additional correctness and performance problems:

- the pipeline key at WebGPUViewportQuad.ts:271-274 omits actual blend factors/operations, depth-write, stencil state, masks, and other descriptor identity;
- pipeline compilation is synchronous at line 311;
- bind groups are rebuilt per execute at lines 540-560;
- binding order depends on JavaScript object key order at lines 345-378;
- one reused uniform-buffer variable can bind multiple logical uniforms to the same buffer;
- number/vector/color conversions allocate typed arrays and upload during execute;
- rectangle, framebuffer, and render-state semantics are not fully applied;
- no WebGPUViewportQuad-specific unit spec was found.

Required change: route ViewportQuad through the same typed render-packet and material compiler as other draws. A Material must provide backend-neutral semantics, a generated binding layout, and GLSL/WGSL implementations or a clearly declared backend-specific escape hatch.

### B9. Lazy FeatureRenderer readiness can fall into the wrong backend

GraphicsContext.ts:1810-1930 defines a lazy renderer lookup where undefined can mean loading, unsupported, or failed. PointCloud.js:217-225 contains a special WebGPU check solely to avoid falling into WebGL resource creation while the import settles. GaussianSplatPrimitive.js:1183-1204 and VoxelPrimitive.js:460-483 lack the equivalent guard and can execute legacy resource paths on initial WebGPU frames.

Loader completion does not reliably request a frame, so requestRenderMode can remain blank. A loader that resolves without registering can be marked loaded permanently; a rejecting loader can be retried every lookup; destroy does not fully clear loader/status/in-flight state.

Required change: make lookup return a stateful handle with unsupported, loading Promise, ready renderer, and failed states. Never use absence to select the other backend. Completion must request a frame and be tied to a context/device generation.

### B10. MaterialUniformBuffer breaks public in-place uniform mutation on both backends

MaterialHelpers.js:959-974 replaces every Material's public uniforms object with a MaterialUniformBuffer facade, regardless of backend. MaterialUniformBuffer.js:399-457 returns detached scratch Color/Cartesian objects and a fresh Array for matrices. Mutating the returned object does not write back to the packed buffer; the implementation acknowledges this at lines 564-569.

That is not backward compatible with Cesium. Existing production code calls Color.clone(Color.WHITE, material.uniforms.color) at DataSources/MaterialProperty.js:104-108, and existing specs/callers assign fields such as material.uniforms.color.alpha = 0 or material.uniforms.value.x = 1. A vec4 is also reconstructed as Color even when its public semantic type was Cartesian4.

A direct Node semantic probe on the current tree produced:

- before alpha: 0.5;
- assign material.uniforms.color.alpha = 0;
- reread alpha: 0.5;
- mutationPersisted: false.

The 65 selected Edge Material tests still passed because they render or check construction without asserting that the in-place mutation reached packed storage.

Impact: material properties, translucency, picking tests, custom Fabric uniforms, and application code can silently retain stale values in WebGL and WebGPU.

Required change: preserve stable mutable public uniform objects. Pack/mirror them into WebGPU storage at visible-material update time, or use tracked mutable value types whose component setters write through without changing object/type identity. Do not impose a WebGPU storage facade globally on WebGL. Add component-mutation, clone-into-destination, Cartesian4, matrix identity/allocation, submaterial, and both-backend rendering tests.

### B11. Native WebGPU features first allocate compatibility resources, then allocate native replacements

The browser does not create a hidden WebGL rendering context. WebGPUContext requests `canvas.getContext("webgpu")` at WebGPUContext.ts:978. However, construction installs a WebGL compatibility object at WebGPUContext.ts:833-835 and 2313-2319. Legacy `Buffer`, `Texture`, `VertexArray`, and command-building code therefore still runs against a WebGL-shaped API. Its buffer and texture calls are translations to real GPUBuffer/GPUTexture allocations, not inert bookkeeping.

Confirmed duplicate GPU realizations include:

- generic Primitive geometry: PrimitiveGeometryHelpers.js:776-817 retains raw geometry for WebGPU, then lines 819-832 still call VertexArray.fromGeometry; WebGPUPrimitiveCommands.ts:2685-2702, 3530-3544, 4580-4588, and 5055-5078 upload native vertex/index data again;
- ground/classification/ground-polyline paths, which consume the same retained geometry and allocate native buffers in WebGPUGroundPrimitiveRenderer.js:2230-2255 and 2390-2423 and WebGPUGroundPolylineRenderer.js:1800-1817, 2827-2831, and 3002-3006;
- main terrain: GlobeSurfaceTile.js:434-465 creates legacy buffers/VA and createResources calls it unconditionally at lines 868-883; WebGPUGlobeSurfaceTileBuffers.ts:176-203 creates native terrain buffers again;
- glTF/models/model-backed 3D Tiles: GltfLoader.js:1414-1452 and 1588-1615 request both a legacy Buffer and retained typed arrays, while WebGPUModelRenderer.ts:1972-1983, 2403-2519, and 2625-2657 creates native buffers from those arrays;
- image-backed Material uniforms: Material.js:474-507 creates a compatibility Texture while retaining `_imageSources`; WebGPUPrimitiveCommands.ts:3933-3940 and 4035-4073 uploads the same image to another GPUTexture;
- terrain water masks and the ocean normal map: GlobeSurfaceTile.js:886-913 and 936-1017 and Globe.js:1117-1131 create compatibility textures specifically while retaining sources for the native uploads at WebGPUGlobeSurfaceTextures.ts:366-475 and WebGPUGlobeSurfaceRenderer.ts:1801-1824.

Models also build the legacy render-resource graph before native takeover. Model.js:2501-2505 calls ModelSceneGraph build stages; ModelDrawCommands.js:73-115 and 173-191 constructs ShaderProgram, VertexArray, and DrawCommand objects. Model.js:2822-2843 suppresses only their later submission. GLSL compilation appears lazy, so this is confirmed CPU/JS command construction plus duplicate geometry allocation, not a proven second compiled GPU pipeline.

Required change: select the backend owner before any GPU realization. A fully native-owned feature consumes an immutable decoded payload and creates at most one primary realization per exact backend domain/descriptor; incomplete mode/pass/variant coverage retains compatibility ownership. WebGPU model loaders request typed payloads only; Primitive and Globe skip legacy VA construction when fully owned; image/material/water paths choose one owner before upload. The compatibility layer remains only for features/tokens that have not migrated completely.

### B12. Compatibility buffer growth loses ownership of the live GPUBuffer

WebGLStubBuffer.ts:51-66 eagerly allocates 4 KiB for every `createBuffer`. When `bufferData` exceeds that size, lines 108-125 create a replacement and destroy the original, but update only `state.boundVertexBuffer` or `state.boundIndexBuffer`. The returned handle's `_webgpuBuffer`, `_size`, and destroy closure still reference the destroyed original. `Buffer.js:62-65` then unbinds, losing the stable owner of the replacement; WebGLStubBuffer.deleteBuffer at lines 77-83 later destroys the stale object rather than the live replacement. Numeric `bufferData(size)` also returns without allocating at line 95.

This is a correctness and resource-lifetime defect independent of the double-tax design. Rebinding can target a destroyed buffer and grown allocations become GC-reliant/orphaned. The eager 4 KiB allocation also dominates small meshes: the runtime Rectangle probe created seven 4 KiB compatibility buffers for only 516 bytes of native primitive vertex/index data.

Required change: bound state must store the stable StubBufferHandle. Allocate lazily once `bufferData` supplies the required size; resize by atomically replacing `handle._webgpuBuffer` and `handle._size`; destroy exactly the handle's current resource once; implement numeric-size and safe bufferSubData growth. Add live-byte counters plus create/bind/upload/regrow/rebind/delete tests above and below 4 KiB.

## High-severity architectural and performance findings

### H1. The high-density path is not yet GPU-driven

Cesium CPU culling runs first. The GPU culler then produces visibility flags, maps them to JavaScript, filters command arrays, and still issues individual draws. GPU sort similarly maps indices to the CPU and reorders JavaScript references. No production Scene callsite uses the culler's indirect mode or external indirect buffer. The principal 3D Tiles path uses a CPU-authored indirect manager instead.

This architecture pays uploads, compute passes, copies, map latency, allocations, and synchronization without removing the CPU scheduler. It also discards sorted results when cull/HiZ removed anything.

The current auto thresholds are not supported by the fork's own performance policy:

- Scene GPU culling: 384/192 commands;
- Scene GPU sort: 6,000/4,000 commands;
- WebGPUPerformanceManager policy: GPU at about 50,000;
- the sort dispatcher documentation also says JavaScript is faster below 50,000.

At 6,000 items, bitonic sort pads to 8,192 and records dozens of compute stages plus uploads, copies, mapping, and CPU reconstruction.

Target architecture: persistent GPU object/mesh/material tables, GPU cull plus LOD plus occlusion, GPU compaction and sort into indirect arguments, and no normal-frame mapAsync. WebGL2 keeps the CPU scheduler as the compatibility backend.

### H2. Visibility inputs and readbacks lack identity and bounds safety

Opaque, translucent, and CSM paths accept stale results based on count. Missing or non-sphere bounding volumes are represented as zero-radius origin spheres, so a mixed list can false-cull commands that should be forced visible. Callers do not consistently enforce the culler's 65,536-object maximum.

Required change: compact only valid cullable entries with a compact-to-original index map, force non-cullable entries visible, derive conservative spheres for other bounds, tag results by list/camera/frustum generation, and chunk or fall back above capacity.

### H3. Main Scene submission is coherent, but feature paths fragment it

The normal Scene path has one end-of-frame queue.submit, which is desirable. Some feature renderers still create and submit private encoders, including opt-in point-cloud LOD per cloud, compute-instance rendering, flow, and ocean paths. These submissions prevent global dependency planning, pass merging, transient aliasing, and consistent profiling.

Required change: the frame graph owns a normal frame's encoder and submission. Features declare compute/render nodes and resources. Private submit is limited to asynchronous initialization, readback completion, or an explicitly justified external workflow.

The alternate renderer also opens passes that it immediately closes. WebGPUContext.beginFrame allocates default depth and opens a canvas pass at WebGPUContext.ts:1629-1693; WebGPUSceneRendererPassRedirect.ts:127-140 closes it to redirect into the scene framebuffer. Post processing can resume another default pass that reaches end-frame without a draw. Environmental effects repeatedly end/resume around private passes.

The main scene pass is similarly split for clears, globe depth packing, copies, culling, HiZ/sort, transmission, and classification. Each resume reloads main color, depth, and G-buffer at WebGPUSceneRenderer.ts:1690-1768. MSAA sources are stored even when they already have resolve targets. On tile GPUs, this defeats on-chip attachment lifetime and makes transient attachments impossible.

Required graph-level acceptance: no empty default pass, no alternate-mode default depth allocation, every opened pass contains useful work, compatible scene work is merged, and the final use of a resolved MSAA source discards rather than stores it.

### H4. Per-command uploads leave substantial CPU and Dawn-wire overhead

WebGPUPrimitiveCommands.ts:1550-1707 and 5346-5409 write camera/RTE/material buffers per command, often 160-320 bytes at a time. The WebGPU renderer source contains 323 queue.writeBuffer call occurrences and 185 createBindGroup call occurrences. These are source counts, not runtime counts, but the command paths confirm per-draw use.

Required hierarchy:

1. frame/view uniform buffer written once per frame or view;
2. persistent material buffer updated only when dirty;
3. persistent object/instance storage table or a monotonic ring/dynamic-offset allocation;
4. immediates only for tiny, frequently changing IDs/scalars where supported;
5. stable bind groups keyed by resource generation.

WebGPUBuffer.ts:285-318 and WebGPUContext.ts:3822-3853 also round tiny standalone uniform allocations to 256 bytes. That alignment is required for dynamic uniform-buffer offsets, not every independent uniform buffer. Allocate standalone blocks to their actual binding alignment; use device.limits.minUniformBufferOffsetAlignment only for dynamic rings.

### H5. Pipeline cache identities are incomplete

WebGPURenderPipelineCache.ts:664-755 begins with descriptor.name. It includes some variant state, formats, sample count, and vertex layout, but omits shader-module identity, entry points, specialization constants, layout identity, complete descriptor primitive/depth-stencil state, full target blend equations, multisample mask, and alpha-to-coverage in important descriptor-side cases. Target blend identity is only presence/absence at lines 721-731.

The compute cache omits shader-module identity; auto layout is assigned a fresh identity and cannot deduplicate. OIT uses only shader length, entry point, and label at WebGPUOIT.ts:534-549, allowing same-length shader collisions.

Both render and compute caches can also accept a late asynchronous compilation result after clear or destroy and repopulate stale state. Cache generation must be captured when compilation starts and rechecked before insertion or monitor completion.

Required change: a device-scoped canonical descriptor fingerprint containing module IDs, entry points, constants, layout/BGL IDs, complete primitive/depth/stencil/blend/multisample state, target formats, vertex layouts, and device generation. Add development collision assertions.

### H6. Synchronous first-use pipeline compilation is widespread

Direct source occurrences include 132 literal createRenderPipeline calls and 54 createComputePipeline calls. By contrast, there is one executable device.createRenderPipelineAsync call and two executable createComputePipelineAsync call sites; higher raw text counts include comments and documentation. Examples of synchronous first-use creation include G-buffer, ocean, dynamic environment map, and ViewportQuad pipelines.

Caching removes duplicate compilation but not first-use stalls. Required change: asynchronous creation and prewarming for predictable variants, with a readiness state and fallback policy. Keep synchronous creation only for tiny development tools or explicitly measured cases.

### H7. MRT/G-buffer cost is always paid even when deferred lighting is off

WebGPUSceneFBTargetHelpers.ts:62-71 hardcodes MRT mode on and its setter has no production callsite. WebGPUContext.ts:3468-3510 unconditionally allocates and clears the G-buffer outside picking. The normal target is rgba16float with a 4x MSAA companion, approximately 79 MiB at 1080p by the code's own comment, even when Scene.deferredLighting is false. The buffer is also cleared through a separate pass.

The producer is live, while DeferredLighting WGSL is not the general consumer implied by older documents. This is an always-on bandwidth and memory tax for optional screen-space features.

Consumer validity is inconsistent. Some globe/model/primitive emitters write normal/roughness, but missing-sentinel SSR returns original color and contact shadows skip pixels rather than applying the documented derivative fallback. Terrain and multiple primitive paths use constant roughness, so screen-space reflection behavior does not represent actual material properties.

Required change: make attachment requirements a frame-graph decision. Compile exact one-target/two-target variants, prewarm transitions, use the smallest format that satisfies normal/roughness/validity consumers, and allocate only while a consumer is active.

### H8. Device-loss and teardown generation handling is incomplete

Confirmed examples:

- HiZ and sort module WeakMaps can return old-device dispatchers after recovery;
- Scene high-density allocation/result flags are not all reset;
- a lazy culler can finish asynchronous initialization after loss and install an old-device instance;
- the uniform allocator owns about 12 MiB of ring pages but is not registered for invalidation or destruction;
- WebGPUPerformanceManager owns GPU resources but is not fully invalidated/destroyed;
- WebGPURenderTarget does not destroy _msaaDepthResolveTexture on resize/destroy;
- PointPrimitiveCollection and LabelCollection destroy paths do not call destroyWebGPUPointResources/destroyWebGPULabelResources, leaving collection-local _webgpuCache/_webgpuLabelCache buffers and textures alive;
- a Scene render-bundle closure can retain the manager replaced during device recovery.
- TAA and motion-blur placeholder textures retain only views and never destroy their owning textures;
- Scene renderer teardown omits some depth, G-buffer, and debug-overlay resources.

Required change: every cache and resource captures context deviceGeneration. A central registry destroys and clears all resources on loss and final teardown. Asynchronous creation checks generation again before install.

### H9. Shared frontend abstractions remain incomplete

Examples of backend leakage or dead/incoherent abstraction:

- Scene/Model/MetadataWGSLPipelineStage.js imports Renderer/WebGPU/WebGPUModelMetadata.js;
- OceanSurfacePrimitive.js and PointCloud.js branch directly on isWebGPU;
- Scene.js checks isWebGPUDrawCommand markers;
- ViewportQuad imports a WebGPU shader;
- RenderCommand.js has no production consumer; its GraphicsContext build path throws;
- frameState.graphicsContext is assigned for view overrides but has no effective consumer;
- Scene.createView builds PassState, picking, OIT, and framebuffer helpers against the supplied context, but returns a View that render() never registers or iterates because rendering hard-resets to _defaultView;
- View.graphicsContext's setter only swaps the pointer and does not rebuild those context-bound helpers.

The correct goal is not zero backend-specific code. It is zero backend policy in shared Scene code. Backend-specific implementations belong behind capability, material, command-compilation, and frame-graph interfaces.

### H10. Collection paths still contain O(N) rebuilds and lifecycle gaps

The resident instance buffer is a positive design: it supports structural rebuilds and sparse coalesced dirty writes. Billboard and point paths benefit. Static WebGPU polylines, however, allocate grouping structures, rebuild a full Float32Array, upload all segments, retain a previous array, and create material commands every frame in WebGPUPolylineRenderer.js:271-324 and 1431-1690. PolylineCollection ignores the renderer's async Promise.

Labels force broad rebuilds for glyph dirtiness, and point/label collection-local WebGPU cache teardown gaps were noted above.

Required change: persistent packed geometry and command groups, dirty-range updates, stable material batches, synchronous update contracts unless true async readiness is exposed, and explicit collection-local GPU cache teardown.

### H11. WebGPU collections drop public ordering fields, and GPU sort reads the wrong names

BillboardCollection, PointPrimitiveCollection, and PolylineCollection expose public renderPriority/renderLayer fields. Their WebGPU feature-renderer early returns occur before the legacy code assigns those values to commands:

- BillboardCollection.js:723-750 versus assignments at 1210-1212;
- PointPrimitiveCollection.js:472-499 versus assignments at 829-831;
- PolylineCollection.js:383-401 versus assignments at 797-799 and 893-895.

The WebGPU billboard, point, polyline, and label renderers do not pass sortPriority or sortLayer when constructing WebGPUDrawCommand, so commands retain the defaults from WebGPUDrawCommand.ts:399-404.

The dense GPU-sort serializer then reads cmd.renderLayer and cmd.materialId at WebGPUSceneRenderer.ts:4187-4205, while the command contract names the fields sortLayer and materialSortId at WebGPUDrawCommand.ts:240-248. Layer and material values therefore serialize as zero. When auto sort consumption activates, material grouping is defeated and public ordering semantics can be violated.

Required change: define one backend-neutral ordering contract, propagate it when the semantic render packet is created, and have every CPU/GPU sorter consume the same typed fields. Add cross-backend ordering tests for all collection types.

### H12. The default RenderScheduler sorts a dead duplicate command stream

RenderScheduler is enabled by default at Scene/RenderScheduler.js:20-36 and Scene always constructs it at Scene.js:388-400. After primitive updates, ViewportExecutor.js:360-377 bins every command, allocates material IDs, and merge-sorts every layer's opaque/transmissive/transparent buckets through RenderScheduler.js:111-180 and 503-527.

No render path consumes those buckets: getEnabledLayers has no production caller, scheduler rendering counters are never incremented, and actual execution still uses frameState.commandList through View.createPotentiallyVisibleSet and the pass/frustum arrays. sortAllLayers does not write its order back to commandList. The live side effect is materialSortId assignment.

Impact: every default frame pays another O(N) bin and as much as O(N log N) sorting before the real pass/frustum sorting, while maintaining two divergent scheduling architectures.

Required change: either make the scheduler the authoritative backend-neutral render-packet stream or disable it and retain only a linear stable material-ID assignment. Do not maintain and sort an unconsumed duplicate.

### H13. Synchronous readback APIs return stale or empty WebGPU results

Scene.pick remains a synchronous method, but on WebGPU it can return a previous location/frame or undefined on a cold call at Scene.js:4092-4129. Scene.js:4100-4109 documents this previous-result behavior and recommends pickAsync; Picking.js:767-803 likewise warns for drillPick. GraphicsContext.readPixels is typed unknown-to-unknown, while WebGPUContext.ts:2795-2808 returns null.

Impact: the documentation is transparent, but backend-dependent stale/empty synchronous results remain easy to misuse and prevent one consistent cross-backend readback contract.

Required change: make pickAsync, drillPickAsync, and asynchronous readPixels the authoritative cross-backend contracts. A legacy synchronous API must either remain semantically correct or fail clearly on an async-only backend; it must never substitute stale data.

### H14. Failed WebGPU initialization can leak a context registry entry

WebGPUContext registers itself before asynchronous initialization at WebGPUContext.ts:837-875. The initialization catch at lines 1025-1029 wraps and rethrows without destroy/unregister cleanup. ContextRegistry uses strong Map references at ContextRegistry.ts:37-69.

This combines badly with AUTO's missing fallback: a failed WebGPU attempt can leave registry/device-pool state behind before a caller creates a WebGL context.

Required change: initialization is transactional. Register only after success, or guarantee rollback of registry, device-pool, event, and partially created GPU state on every failure path. Add a registry/resource-count assertion to the renderer-selection failure matrix.

### H16. Globe atmosphere LUT fog double-adds the camera world position

Globe/GlobeTerrain.wgsl:1357 assigns v_positionMC = position3DWC, and the same shader explicitly documents v_positionMC as full ECEF at lines 3988-3990. The LUT fog path reconstructs cameraWC, then computes fragmentWorldPos = input.v_positionMC + cameraWC at lines 4071-4077. This adds the camera to an already absolute ECEF position.

The analytic ground-atmosphere path at lines 4112-4114 correctly uses positionWC = input.v_positionMC and subtracts cameraWC only to form the view direction.

Impact: when the atmosphere LUT is ready, fog sampling uses a world position displaced by the camera ECEF vector, producing camera-dependent color/opacity discontinuity and disagreement with the analytic fallback.

Required change: pass input.v_positionMC directly to sampleAtmosphereFogLut. Add LUT-on/off continuity tests at ground, orbit, antimeridian, poles, and large camera teleports, plus a shader numeric test that the LUT sample position equals the CPU ECEF oracle.

### H17. Globe material data is repacked and uploaded per visible tile

WebGPUGlobeMaterial.ts:393-439 allocates a new ArrayBuffer, Float32Array, and Uint8Array every pack. WebGPUGlobeSurfaceRenderer.ts:461-466 uploads it, and material-pipeline setup is invoked inside the visible-tile loop at lines 970-1002 even though globe.material is global and identical for every tile.

Impact: a material-enabled globe can perform thousands of redundant allocations and queue writes per frame.

Required change: give each material a persistent packed representation and generation. Pack/upload once when the material changes, reuse one GPU buffer and stable bind group across tiles, and record allocation/write counts versus visible-tile count. An unchanged frame should perform zero globe-material uploads.

### H18. Material matrix packing does not implement WGSL host-shareable layout

Material Fabric accepts 4/9/16-element arrays as mat2/mat3/mat4 at MaterialHelpers.js:718-724. MaterialUniformBuffer.js:80-121 aligns every size-three-or-larger value to 16 bytes and stores matrix elements contiguously.

That is not a correct general WGSL layout: mat2x2 aligns to 8 bytes, while mat3x3 uses three 16-byte-strided columns and occupies 12 float slots rather than nine contiguous floats. The separate globe material inference also lacks complete array/matrix handling.

Required change: generate WGSL declarations and CPU offsets from one typed schema/reflection source. Test mixed scalar/vector/mat2/mat3/mat4 structs against a trusted layout oracle and render distinct per-element values to expose column-stride errors.

### H19. Previous-frame model motion vectors abandon the current RTE precision path

ModelPBRComplete.wgsl:974-985 preserves split instance translation and subtracts the encoded camera before downcasting for the current frame. The previous-frame path at lines 1043-1067 recombines split translation into planetary-scale f32 values and multiplies full-magnitude previous matrices.

Current and previous clip positions therefore use different numeric paths. Metre-scale loss is not harmless for TAA: subpixel velocity at Earth scale is precisely where shimmer and ghosting appear.

Required change: carry previous camera and instance high/low data and compute previous clip through the same camera-relative transform as current. Test stationary and 1 mm/1 cm/10 cm/1 m motion at several ECEF locations, camera-only motion, animation, skinning, morphing, and instancing against CPU double math.

### H20. RTE helpers are duplicated and the current assertion cannot validate packing

Approximately 85 WGSL files define translateRelativeToEye variants. Many include a branch that tests length(highDifference) == 0 and writes the same zero value. This does not detect NaN; NaN makes the comparison false, while finite zero is already zero.

WebGPURTEAssertions.ts permits up to six metres and its round-trip assertion receives the original high/low objects rather than reading values back from packed offsets. A destination-offset swap can therefore pass.

Required change: centralize one RTE helper, remove the ineffective branch, use schema-driven typed-array offset tests, and add a GPU oracle shader that reconstructs camera-relative positions for negative coordinates, exact high equality, tile centers, model transforms, every scene mode, and sub-metre deltas.

### H21. Shader preprocessing and module cache identity are fragmented

WebGPUShaderModuleCache.ts packs only eight source-ID bits and 24 define bits. WebGPUShaderDefines.ts notes that higher define bits are silently dropped unless every caller supplies a manual salt. Model pipelines compensate with manual XOR/hash logic. A second shader cache keys only descriptor.name and appears dormant, while buffer primitives maintain another regex import/preprocess cache.

The generic WGSLShaderBuilder is not a production-wide solution, and only a small fraction of 319 WGSL sources carry lockstep markers. Large monoliths such as GlobeTerrain and ModelPBRComplete make variant reasoning and GLSL/WGSL parity difficult.

Required change: one per-device compiler/cache service keyed by content digest, normalized specialization tuple, binding/layout-schema digest, entry points, compiler/preprocessor version, capability tier, and device generation. Unknown imports fail in development/CI. Publish module/pipeline counts, compile milliseconds, and cache hit rates.

### H22. Default fragment-written log depth deserves a reversed-Z benchmark

WebGPUContext.ts:418-435 enables log-depth writes by default, and the common path writes builtin frag_depth. Manual fragment depth can reduce early-Z, HiZ, and depth-compression effectiveness in opaque overdraw-heavy scenes.

This is not a recommendation to remove log depth blindly. Benchmark a WebGPU reversed-Z path with floating-point depth, clear 0, greater/greater-equal, and infinite-far projection against the existing log-depth path. Gate any change on ground-to-orbit stability and full coverage of picking, classification, shadows, SSAO/SSGI/SSR, fog, EDL, translucency, depth reconstruction, MSAA, multi-frustum, and 2D/CV/morph. Keep WebGL on its proven path unless separately validated.

### H23. Model geometry normalization allocates before the cache lookup

WebGPUModelRenderer.ts:4483-4491 extracts/normalizes primitive geometry before `ensurePrimitiveCache` checks whether GPU resources already exist. ModelPrimitiveGeometry.js:36-283 builds new descriptors and morph arrays; quantized attribute conversion allocates full Float32 arrays at lines 383-417, and Uint8 indices are widened at lines 247-275. These allocations can recur every frame after the GPU buffers are already resident.

The native primitive key is only `nodeIdx_primIdx`, so repeated nodes that reference one immutable mesh can also receive separate geometry residency. Per-node transforms and draw state are mutable instance data; mesh attributes/indices are not.

Required change: cache decoded/normalized GeometryPayloads by source primitive/accessor identity plus decode version before scene traversal. Share one immutable GeometryRealization across repeated mesh nodes and keep only DrawInstance state per node. Add retained/transient CPU-byte counters and assert zero full-geometry conversion allocation on settled frames.

### H24. Device pooling does not yet imply safe resource sharing

WebGPUDevicePool is active and contexts acquire pooled devices by default at WebGPUContext.ts:900-920, releasing references at lines 3692-3705. Most resource caches nevertheless remain per Context or per Model. WebGPUModelPipelineCache.ts:83-87 and 135-146 creates layouts, pipelines, default textures/samplers/buffers, IBL resources, and other immutable defaults per Model. `model._webgpuCache` and ImageBasedLighting's `_webgpuCache` are single unkeyed slots, so the same object rendered on distinct devices can reuse resources from the wrong device.

The shared globe renderer is per GPUDevice, which is the right scope, but terrain keys only by `level_x_y` in WebGPUGlobeSurfaceTileBuffers.ts:62-69. Its stale-resource eviction is defined at lines 378-389 but has no production caller, so visited terrain can remain resident for the device lifetime. Different terrain providers can collide at identical coordinates. Imagery's fallback key similarly uses only x/y/level at WebGPUGlobeSurfaceTextures.ts:187-188 and 237-238 when no `imagery.key` is present.

Required change: introduce an explicit BackendDomain identity and generation. Share immutable WebGPU realizations and compiler objects per `{GPUDevice, generation}` with content- and descriptor-complete keys, leases, byte accounting, and budgeted eviction. Keep render targets, depth/history, camera data, command lists, pick state, dynamic rings, and temporal resources context/view-local. WebGL realizations remain per WebGL context.

## Post-audit hot-path follow-up

The initial audit was sufficient to design the remediation architecture, but a final static hot-path gate found the following runtime-attribution gaps. These use a separate `HP-*` namespace so the add-only `H` numbering, including the intentionally absent H15, remains unchanged.

### HP-01. Telemetry integrity and full-frame coverage are incomplete

WebGPUContext constructs the timestamp profiler without its required feature boolean; WebGPUPerformanceManager calls incompatible `endFrame()`/`getStatistics()` APIs; general render passes do not request timestamp writes; repeated names overwrite; and query overflow/readback reuse are silent. CPU profiling begins after `_ensureResources` and excludes Scene update, JobScheduler/resource work, command emission, scheduling/PVS, finish/submit, and GC. Repair and self-test the measurement contract before final optimization ordering.

### HP-02. Effects bind-group identity mixes stable resources with volatile view state

`WebGPUEffectsBindGroup` keys a permanent Map with camera/edge/viewport values, allocates a 480-byte buffer plus bind group on every miss, never evicts until device loss, and still writes the buffer on hits. Globe tile drawing requests this state per visible tile. Split stable resource identity from per-view/frame dynamic data, bound residency, and hoist identical uploads.

### HP-03. Depth packing repeats full-screen work and object creation per frustum

The frustum loop can pack depth after globe, 3D Tiles, and opaque work. Each pack opens a full-screen pass and creates a fresh depth view/bind group. Declare depth versions and downstream demand so only required representations are packed, with cached views/bind groups and timestamped pass counts.

### HP-04. Settled frontend allocation and closure churn remain unmeasured

Globe construction creates ready-layer arrays, command objects, slices, descriptors, and execute closures per tile; Models traverse primitives and create primary/pick commands; static polylines regroup/repack/reupload full arrays and recreate commands. Persist semantic packets/scratch storage and gate settled heap/object plateaus and sparse-mutation scaling.

### HP-05. Persistent resource realization is reachable during draw-command emission

Terrain cache misses widen indices, scan/allocate CPU buffers, and create/upload GPU resources while visible-tile commands are constructed. Globe fallback imagery allocation is also reachable from tile command generation, while Model normalization precedes cache lookup. Move these families behind explicit readiness/resource-plan nodes and assert zero persistent realization during packet emission.

### HP-06. Main-thread preparation budgets can consume most of a frame

JobScheduler's texture/program/buffer budgets total 50 ms and its progress rule can overshoot after exhaustion. Primitive asynchronous creation also builds large Float64 descriptors on the main thread before worker dispatch. Replace aggregate best-effort work with stage deadlines, backpressure, off-thread preparation where beneficial, and preserved explicit synchronous contracts.

### HP-07. Imagery reprojection and mip generation fragment submissions

WebGPU imagery preparation lazily creates pipelines/resources and immediately submits reprojection work during imagery/tile update; mip generation submits separately. These must use one submission-serial authority during preparation and become declared frame-graph nodes for normal-frame work.

### HP-08. Ordinary frames may upload pick state and repeat redundant GPU state calls

Primitive command updates write color-camera state and appear to update pick uniforms for every pickable command even when no pick pass is requested. Draw commands also set pipeline, bind groups, vertex/index buffers, and draw state without runtime redundancy counters. Prove the path, eliminate ordinary-frame pick uploads, and use stable packet/state identities to avoid redundant wire calls where safe.

## Allocation ownership and dual-renderer investigation

### What the WebGPU-only path actually pays

The observed sequence is:

```text
decoded CPU payload
  -> legacy WebGL-shaped Cesium wrapper
  -> compatibility-stub GPUBuffer/GPUTexture
  -> separate native FeatureRenderer GPUBuffer/GPUTexture
```

There is no hidden browser WebGL context or WebGL VRAM allocation in the explicit WebGPU path. The first GPU object is already WebGPU, created by the compatibility translation. That distinction matters for diagnosis but not for the avoidable cost: the same logical asset can still be uploaded twice and retained in two real WebGPU resources, with two ownership graphs.

### Feature-family allocation matrix

| Feature family | Current WebGPU behavior | Classification | Ownership fix |
| --- | --- | --- | --- |
| Generic Primitive, GroundPrimitive, ClassificationPrimitive, GroundPolyline | Retains typed geometry, creates legacy VA/buffers, then creates native interleaved VB/IB; also allocates full-size interleaved CPU staging | Confirmed double GPU geometry | Branch before VertexArray.fromGeometry; native renderer consumes GeometryPayload directly |
| Globe terrain | Creates legacy VA/VB/IB for every mesh, then native Terrain VB/IB | Confirmed double GPU geometry | Apply TerrainFillMesh's existing GLOBE_SURFACE FeatureRenderer guard to main terrain and exaggeration rebuilds |
| glTF Model and model-backed 3D Tiles | Loader emits both legacy Buffer and typed array; legacy command graph is built; native renderer uploads attributes/indices again | Confirmed double GPU geometry plus CPU graph tax | Native MODEL requests typed-array-only payload and skips legacy ModelDrawCommands materialization |
| Image-backed Material uniforms | Compatibility Texture is created while raw source is retained; native primitive/globe material path uploads another texture | Confirmed double GPU texture for normal image/canvas/URL values | Prefer one TextureAsset realization; transitional path may adopt the stub-backed texture instead of re-uploading |
| Terrain water mask | Compatibility Texture plus retained source, then vertically transformed native texture | Confirmed double GPU texture | Choose owner before upload; put flip/transform in the upload descriptor or WGSL so only one realization is created |
| Ocean normal map | Compatibility Texture plus native re-upload | Confirmed, one globe-level texture | Native globe path owns one device-scoped texture keyed by actual source identity |
| Batch styling/picking | BatchTexture can create compatibility textures while WebGPUModelFeatureId creates native feature resources from the same bytes | Confirmed for affected styled/pick paths | One versioned FeatureTablePayload with per-domain realizations |
| Standard globe imagery | ImageryLayer branches to a lightweight source placeholder before legacy Texture creation | No duplicate GPU residency found | Preserve this choose-owner-before-realization pattern |
| glTF PBR/material textures | WebGPUModelRenderer reuses the stub-owned GPUTexture at lines 1909-1922 and avoids double destroy at 3270-3285 | One transitional GPU realization | Keep temporarily; replace private-field adoption with a formal native-resource accessor |
| Billboard/Label atlas | Native renderers reuse the compatibility atlas GPUTexture | One transitional GPU realization | Same formal accessor/owner contract |
| Points, collection polylines, vector-tile primitives/polylines | FeatureRenderer branch occurs before legacy GPU buffer setup | No duplicate GPU residency found | Use as the migration template |

WebGPU Scene construction also instantiates legacy View helper object graphs such as GlobeDepth, OIT, and framebuffer managers. Most of those are CPU objects until their update paths run; the native renderer bypasses the legacy framebuffer orchestrator. This is avoidable JS construction/maintenance, but it is not evidence of a second full render-target set. Split backend-neutral View state from backend resource bundles rather than counting all legacy helper objects as GPU duplication.

### Node/Edge allocation probe

The reproducible probe is `tmp/fork-audit-2026-07-13/probe-webgpu-allocation-tax.mjs`. It is Node-only: Node served the repository and Node/Playwright launched headless Edge with WebGPU. An init script instrumented `HTMLCanvasElement.getContext`, `GPUDevice.createBuffer/createTexture`, and resource destroy calls before Cesium loaded.

| Workload delta | Compatibility allocation observed | Native allocation observed | Key result |
| --- | ---: | ---: | --- |
| Ellipsoid globe, 24 visible tiles | 75 compatibility buffer creations / 487,168 bytes; 38 recorded live / 335,616 bytes | Terrain VB/IB resources for the same meshes | 24 of 24 visible WebGPU tiles still had a legacy `vertexArray`; visible CPU mesh data was 297,120 bytes |
| One synchronous Rectangle Primitive | 7 compatibility buffers / 28,672 bytes | Primitive VB 468 bytes + IB 48 bytes | Fixed 4 KiB compatibility allocation dominates this small mesh |
| CesiumMan glTF Model | 12 compatibility creations / 235,896 bytes; 6 recorded live / 211,320 bytes | Position 39,276; normal 39,276; joints 52,368; weights 52,368; UV 26,184; index 28,032 bytes, total 237,504 | Compatibility and native geometry are approximately two complete realizations |

The context log was `{ webgpu: 1, 2d: 1 }` with zero `webgl` or `webgl2` calls, and the page reported no errors. Descriptor sizes and explicit destroy calls are exact at the JavaScript API boundary. They do not prove driver physical residency, hidden driver allocation, or immediate reclamation; the probe should therefore be used as an allocation/upload ownership guard, not a VRAM profiler.

### Maximum safe sharing boundary

WebGL and WebGPU cannot share GPUBuffer/GPUTexture objects across APIs. Two simultaneous renderers inevitably need one WebGL realization and one WebGPU realization. The avoidable bug is making WebGPU create a compatibility-translated WebGPU realization before its native realization.

| Scope | Share source/decode payload? | Share GPU realization? |
| --- | --- | --- |
| WebGL + WebGPU in one realm | Yes: fetch bytes, decoded geometry/images, terrain meshes, metadata, bounds, material/shader semantics | No; one realization per API ownership domain |
| Two WebGPU canvases on the same pooled GPUDevice/generation | Yes | Yes for immutable resources with identical descriptors |
| Two distinct GPUDevices or generations | Yes | No |
| Two WebGL contexts | Yes | No WebGL object sharing in this architecture |
| Two views/scenes | Share immutable assets | Keep camera/visibility, render targets, history, command lists, pick state, and transient/dynamic allocations local |

The target resource stack is:

1. `SourceAssetCache`, realm-global: canonical request/range/validator/credential key; fetched bytes, parsed containers, and in-flight promises.
2. `DecodedAssetCache`, realm-global: content hash plus decoder/version/options; immutable typed geometry, decoded/transcoded images, terrain mesh, metadata, and semantic material/shader IR. Ordinary ArrayBuffer references already share in one JS realm; SharedArrayBuffer is optional for actual cross-worker ownership.
3. `BackendRealizationCache`: `BackendDomain = WebGLContextIdentity | {GPUDeviceIdentity, generation}`. Key by decoded asset ID plus exact usage, format/color space, mip policy, vertex layout/stride, index format, mutability version, and other descriptor fields. Use leases/refcounts, byte budgets, LRU, and deferred destruction after submitted work completes.
4. `DeviceCompilerCache`: per WebGPU device/generation shader modules, layouts, pipelines, immutable samplers, placeholders, and default buffers keyed by complete semantic/descriptor identity. A WebGL equivalent remains context-scoped.
5. `SceneResourceSet`: context/view-owned render targets, depth/history, frame/view state, dynamic rings, and temporal resources.

`SharedResourcePool.ts` is currently unused outside documentation references. Despite its comments, allocation creates one ArrayBuffer or SharedArrayBuffer per named resource rather than suballocating a true arena. It should not become the default sharing mechanism: same-realm immutable typed-array references already share memory, while SharedArrayBuffer adds value only across workers and imposes isolation requirements.

ResourceCache already shares context-free fetch/decode work while referenced, but ResourceCacheKey.js:385-391 and 476-483 includes context ID when `loadBuffer` is true; texture realizations similarly include context ID at lines 596-601. Because WebGPU currently asks for both Buffer and typed array, even its retained CPU product becomes context-scoped. Split decoded CPU entries from backend realization entries. Sharing a GPUDevice through WebGPUDevicePool alone cannot deduplicate resources until caches use device-domain/content identities.

## Medium-severity design debt

### M1. WebGPU-only feature flags conflate requested and active state

Several experimental WebGPU-only Scene flags accept and report enabled values on WebGL, including SSR, NPR, contact shadows, clustered lighting, weather, and GPU culling at Scene.js:2670-2892. Their documentation identifies them as WebGPU-only or no-effect-on-WebGL, so this is not an undocumented correctness failure. The remaining ambiguity matters most after an unexpected renderer fallback: requested true can still look like active true.

Required change: expose capability, requested state, and active state separately. On unsupported backends, provide an equivalent fallback or return inactive status, while preserving the documented experimental policy.

## 2026 WebGPU adoption matrix

The current WebGPU Candidate Recommendation Draft is dated 23 June 2026, and the current WGSL draft is dated 3 July 2026. Optional implementation features must remain capability-gated rather than assumed.

| Capability | Fork status | Recommendation |
| --- | --- | --- |
| Immediates / immediate address space | Not found | High-value experiment for tiny per-draw IDs/scalars after frame/view/object-buffer refactor. Chrome 149-150 describes it specifically as bypassing small uniform-buffer/bind-group overhead. Do not use it for large arrays or wholesale matrices. |
| Transient attachments | Unreachable scaffold with nonexistent feature-name checks and fallback bit 0x10 instead of standardized 0x20 | High value for discard-only MSAA color/depth after attachment ownership is explicit. Detect presence of GPUTextureUsage.TRANSIENT_ATTACHMENT, not device.features names. |
| uniform_buffer_standard_layout | Not found | Medium value for sharing host layouts between storage and uniform paths and reducing padding. Compile a portable default variant plus an optional required-extension variant. |
| subgroup_id / num_subgroups and linear indexing | Base subgroup paths exist; newer language helpers not found | Medium/low. Use where profiling shows atomics/index reconstruction are material; keep portable kernels. |
| f16 | Used in selected post-process variants | Good selective adoption. Keep capability-specific shader variants and numeric-quality tests. |
| Texture format tiers | Not explicitly negotiated | Medium only where a concrete format reduces memory/bandwidth or unlocks a feature. Do not request tiers speculatively. |
| Dual-source blending | Feature detected; no true dual-source OIT path | Medium. A supported weighted-OIT variant could reduce MRT pressure, with the existing MRT or alpha fallback retained. |
| GPUExternalTexture/video | WebGPUVideoTextureManager declares itself orphaned; material video uploads a normal texture every frame | Medium for video imagery. Prefer importExternalTexture for playing HTMLVideoElement/VideoFrame, retain the current texture path for static/mipmapped/copy-required cases, and keep paused-frame display valid. |
| Timestamp queries | Used | Continue, but centralize pass labels and publish CPU encode, GPU pass, upload, and map-latency metrics. |
| Occlusion queries | No production calls | Not automatically a miss. For Cesium-scale visibility, GPU HiZ/indirect is likely the better target than thousands of query/readback decisions. |
| Render bundles | Essentially Moon-only; terrain measured worse | Keep selective. Bundle only stable high-reuse cohorts with complete attachment/sample/resource-generation keys. |
| Compatibility mode | featureLevel support exists | Preserve as a reach path, but fix entry-point selection and test restricted limits explicitly. |

Primary implementation sources:

- [W3C WebGPU current draft](https://www.w3.org/TR/webgpu/all/)
- [W3C WGSL current draft](https://www.w3.org/TR/WGSL/)
- [Chrome 149-150: immediates and transient validation](https://developer.chrome.com/blog/new-in-webgpu-149-150?hl=en)
- [Chrome 146: compatibility mode and transient attachments](https://developer.chrome.com/blog/new-in-webgpu-146?hl=en)
- [Chrome 144: subgroup_id, standard uniform layout, and queue-write improvements](https://developer.chrome.com/blog/new-in-webgpu-144?hl=en)

## Comparison with current dual-backend engines

### Three.js

Three.js WebGPURenderer presents one universal renderer with WebGPU and WebGL2 backends. Its TSL node system compiles platform-independent material semantics to WGSL or GLSL, and its post-processing graph supports MRT and automatic pass combination. See the [official WebGPURenderer guide](https://threejs.org/manual/en/webgpurenderer) and [TSL specification](https://threejs.org/docs/TSL.html).

Lesson for this fork: do not duplicate the complete Cesium material system indefinitely in handwritten GLSL and WGSL. Introduce a typed, backend-neutral IR for built-in materials, feature IDs, clipping, log depth, lighting, and post-process composition. Retain native GLSL/WGSL escape hatches for specialized research effects.

### PlayCanvas

PlayCanvas refactored WebGL-specific code into backend classes, introduced explicit render passes and a FrameGraph, made render state standalone/comparable, reorganized uniforms into buffers, and introduced async device creation. Its own account is unusually close to this fork's problem statement: [PlayCanvas WebGPU architecture](https://blog.playcanvas.com/initial-webgpu-support-lands-in-playcanvas-engine-1-62/). Current documentation exposes explicit cross-platform pass chains and requires GLSL/WGSL implementations for custom passes: [custom render passes](https://developer.playcanvas.com/user-manual/graphics/posteffects/cameraframe/custom-passes/).

Lesson for this fork: frame-graph ownership and immutable render-state identity should precede more isolated effects. The graph is what makes attachment allocation, pass ordering, merging, transient usage, and one-submit policy reliable.

### Babylon.js

Babylon maintains WebGL and WebGPU through the same public API, makes WebGPU initialization asynchronous, and rewrote core shaders in native WGSL while retaining dual-backend behavior. See [Babylon.js WebGPU support](https://doc.babylonjs.com/setup/support/webGPU/). Its snapshot/render-bundle optimization is explicitly specialized for stable scenes rather than a universal default.

Lesson for this fork: normalize public async semantics across backends, keep native WGSL where it is valuable, and use bundles only where invalidation is controlled and measured.

## Recommended target architecture

### 1. Backend-neutral Scene frontend

Scene update produces semantic render packets:

- stable object and primitive IDs;
- geometry handles and bounds;
- material graph/feature set;
- immutable raster/depth/stencil/blend state;
- pass intent and resource reads/writes;
- pick/classification/shadow variants;
- transform and precision data.

Scene does not inspect isWebGPU, WebGPU command markers, GPUBuffer, or WGSL. It asks capabilities and feature services.

### 2. Explicit frame graph

Features declare nodes, dependencies, and attachment requirements. The graph:

- orders cull/LOD/HiZ/sort/indirect generation before raster;
- compiles exact attachment and sample-count topology;
- merges compatible passes;
- allocates and aliases transient resources;
- selects load/store/discard operations;
- owns the main encoder and normal submission;
- gives every node stable profiler labels.

This directly removes the current open-pass compute, shared-buffer timing, OIT view ambiguity, and always-on G-buffer problems.

### 3. Backend compilers

WebGL2 compiler:

- emits the existing CPU-visible command ordering;
- binds GLSL programs and legacy resources;
- preserves upstream behavior and broad reach.

WebGPU compiler:

- groups render packets by complete pipeline and binding identity;
- realizes immutable decoded payloads directly, without first invoking WebGL compatibility wrappers;
- uploads persistent scene tables;
- runs GPU visibility/LOD/compaction;
- emits indirect arguments and render passes without readback;
- uses CPU fallback only for unsupported or small cohorts.

### 4. Split decoded assets from backend realizations

Loaders produce immutable GeometryPayload, TexturePayload, TerrainPayload, metadata, and semantic material/shader records without constructing Buffer, Texture, VertexArray, ShaderProgram, or GPU objects. A realization service selects one owner before allocation and permits at most one primary realization per exact descriptor/domain:

- WebGL: one realization per WebGL context;
- WebGPU: one realization per context during NATIVE_CONTEXT validation, then immutable families may promote to one per GPUDevice/device-loss generation;
- compatibility stub: only for a feature that has no native WebGPU owner.

Multiple views on one pooled WebGPU device lease shared immutable buffers, textures, samplers, layouts, and pipelines. Different APIs/devices share only the decoded payload. Descriptor-complete identities, byte budgets, LRU/leases, deferred destruction, and generation invalidation make the sharing safe.

### 5. Shared material and shader IR

Build a typed material/feature graph for common Cesium semantics. Generate GLSL and WGSL plus a binding-layout description from the same IR. Make precision, log depth, feature IDs, clipping, lighting, fog, and post-process inputs explicit nodes. Specialized native shaders remain possible through an interface that declares bindings and backend support.

### 6. Uniform and object-data hierarchy

- one frame/view block per view;
- persistent dirty-updated material blocks;
- persistent object/instance storage tables;
- ring/dynamic offsets for transient small cohorts;
- immediates for a few high-frequency scalars when supported;
- no per-command camera matrix upload;
- stable bind groups invalidated by resource generation.

### 7. Context/device-owned state and recovery

Every GPU object belongs to an explicit backend domain and generation. WebGL GPU resources, context limits, depth range, compressed formats, view state, and feature renderers are per context. Immutable WebGPU assets/compiler objects may belong to a pooled device generation; scene attachments and dynamic state remain per context/view. Recovery invalidates only the lost device generation atomically, retains decoded CPU payloads for one re-realization, and makes asynchronous installs fail closed when their captured generation is stale.

### 8. Explicit parity and support policy

Every public feature declares:

- WebGL2 implementation;
- WebGPU implementation;
- equivalent fallback;
- or explicit unsupported status.

Do not silently no-op WebGPU-only public APIs on WebGL. Do not let lazy absence fall through to the other backend. Normalize async APIs such as readback and picking or give the async form a distinct name.

## Upstream integration

Current upstream is 21 commits ahead of the merge base and changes nine files. Production-relevant items are:

- larger epsilon for S2Cell center checks;
- TerrainPicker ES6/type cleanup;
- Billboard alignedAxis documentation and automatic normalization;
- Sandcastle tool-registry handling.

These should be integrated soon. BillboardCollection is heavily rewritten in the fork, so the alignedAxis change requires a manual semantic port and dual-backend tests rather than a blind merge.

Upstream distance is not itself a defect. The audit evaluates whether fork changes are correct and architecturally justified. The integration risk comes from large rewrites of upstream-owned Scene collections and model/command paths, because small upstream bug fixes can be obscured or structurally inapplicable.

## Validation results

### Passed

- npm run tsc
- npm run build
- targeted ESLint over Renderer/WebGPU, GraphicsContext, and ViewportQuad
- Edge targeted specs for WebGPURenderPipelineCache, WebGPUGPUSortKeysDispatcher, WebGPUHiZOcclusionDispatcher, and WebGPUFramebufferManager
- Node repository server plus Node/Playwright Edge smoke benchmark for both renderers
- Node/Playwright Edge allocation probe confirming one WebGPU canvas context, zero WebGL canvas contexts, and duplicate compatibility/native GPUBuffer creation for terrain, Primitive, and Model workloads

Targeted Edge results were green, but narrow:

- pipeline-cache selection: 23 tests selected;
- GPU sort: 3 tests selected, principally helper/layout coverage;
- HiZ: 10 tests selected, principally helper coverage;
- framebuffer manager: 37 tests selected, although the manager has no production construction call.

No ViewportQuad WebGPU spec or cross-frustum same-count scheduler spec was found.

### Browser smoke benchmark

Node served the repository and Node/Playwright launched Edge:

| Backend | First frame | tilesLoaded | Measured FPS |
| --- | ---: | ---: | ---: |
| WebGL | 119.2 ms | 119.4 ms | 60.0 |
| WebGPU | 623.5 ms | 627.2 ms | 60.0 |

WebGPU startup was about 508 ms slower in this single run. Both steady-state values were capped by the browser's 60 Hz requestAnimationFrame cadence, so the 1.0x ratio is not a GPU performance comparison. A credible performance campaign must collect uncapped workload throughput, CPU encode time, GPU timestamp time, upload bytes/calls, pass count, map latency, GC allocation, and p95/p99 frame time.

### Failed or stale guards

- direct Material uniform semantic probe failed: in-place alpha mutation reread the original 0.5 value instead of 0;
- Tools/lint-debug-pragmas.mjs found two unguarded production warnings:
  - WebGPUGlobeSurfaceRenderer.ts:491
  - WebGPUPickFramebuffer.ts:396
- git diff --check against current upstream found 235 diagnostics, including 67 production diagnostics across 14 Source files. Most production findings are trailing whitespace in PBRMetallicRoughness.wgsl, PhongLighting.wgsl, WGSL chunks, and GoogleStreetViewCubeMapPanoramaProvider.js.
- Tools/upstream-regression-check.mjs reported 24 pass / 2 fail. Both failures are the EdgeVisibility degenerate-triangle source-text guard. Manual comparison shows the expected cross-product loop is no longer present in the current implementation, including current upstream, so this guard is structurally stale rather than evidence of the original bug recurring. Replace it with a behavioral degenerate-input test.

## Required acceptance gates

1. Validation-zero dense scene: 2/4/6 frustums, at least 500 translucent, 6,000 opaque, and 32 tile commands, all dense features forced on for 300 frames. Assert zero GPUValidationError and zero device loss.
2. Cross-frustum identity: equal-count but disjoint command IDs/bounds/depth occluders. Assert executed IDs match a CPU oracle and every result tag matches frame, frustum, camera, and list generations.
3. Indirect overwrite: two passes/frustums with distinguishable indirect tuples. Assert unique offsets, correct tuples, and render-state/classification parity with normal execute.
4. Sort multi-frustum: dispatch 6,001 then 8,191 items in one frame. Assert each result is a unique in-range permutation paired to the correct frustum, with no map-before-submit error.
5. Bounds/capacity: mix cull=false, absent BV, non-sphere BV, and sphere BV at 65,535/65,536/65,537 objects. Assert conservative visibility and safe chunk/fallback.
6. OIT matrix: MSAA 1/4, stencil on/off, all-OIT/mixed/no-OIT commands, resize/HDR/picking. Assert exact sample/format compatibility and no missing fallback draws.
7. Renderer selection: omitted, auto, webgpu, webgpu-compat, webgl, preferWebGPU, adapter failure, and device failure through Scene, Widget, and Viewer entry points. Assert resolved backend and fallback reason.
8. Split context: render WebGL and WebGPU scenes alternately for 1,000 frames with different limits and compressed formats. Assert projection/depth/capability state never crosses contexts.
9. Device loss: allocate HiZ/sort/cullers/uniform ring/OIT/bundles/collections, force loss, recover, and render dense paths. Assert every resource generation matches and memory returns to baseline after destroy.
10. Uniform/upload budget: track queue.writeBuffer calls/bytes, createBindGroup calls, CPU encode time, and allocations. Assert settled frames allocate no command-side typed arrays and camera data is uploaded once per view.
11. Threshold matrix: integrated and discrete adapters at 192, 384, 4K, 6K, 16K, 50K, and 100K commands. Auto-enable only when p95 total frame time improves at least 5 percent without a p99 regression.
12. Shader/material parity: representative built-in and custom materials, log depth, RTE extremes, clipping, feature IDs, picking, classification, morph modes, and HDR across WebGL2/WebGPU with image and numeric tolerances.
13. WebGPU-only allocation ownership: instrument canvas contexts, compatibility entry points, GPU resource creation/destruction, queue uploads, asset IDs, and retained CPU bytes. For fully native-owned Model, Primitive/ground/classification, terrain, image Material, water, ocean, and feature-table tokens, assert zero compatibility GPU allocation and at most one primary native realization per exact logical payload/domain/descriptor.
14. Dual-backend sharing: load the same model, terrain, and imagery into simultaneous WebGL and WebGPU scenes. Assert one fetch/parse product, one decoded CPU payload per exact decode target, one context-local realization per backend before NATIVE_DEVICE promotion, and no compatibility-translated WebGPU duplicate. Destroy either view first and verify the survivor, then destroy both and return to the declared cache/lifetime baseline.
15. Pooled-WebGPU sharing: two canvases on one GPUDevice share immutable buffers/textures/samplers/layouts/pipelines by identity while render targets and view/dynamic state remain distinct. Two devices create two realizations. Device loss invalidates only the lost generation and reuploads each decoded asset once.
16. Residency plateau and collision safety: fly across terrain/imagery for a fixed budget, then assert live bytes plateau after eviction. Render two terrain providers, two imagery layers, and two ocean maps at identical coordinates on one pooled device and assert content-correct, non-colliding cache identities.
17. Compatibility-buffer semantics: create numeric-size, zero-size, below-4-KiB, above-4-KiB, repeated-growth, rebind, bufferSubData, and delete cases. Assert one authoritative handle, no eager allocation when size is unknown, correct copied bytes, exact current-resource destruction, and zero live bytes after teardown.

## Prioritized remediation

### Phase 0: contain release blockers

- turn the unsafe high-density auto paths into experimental opt-ins;
- disable OIT under MSAA/mixed sets until attachment topology is fixed;
- fix renderer selection and explicit fallback;
- remove process-global depth/capability state;
- fix or temporarily disable WebGPU ViewportQuad;
- make lazy feature-renderer readiness explicit;
- fix WebGLStubBuffer's stable-handle, numeric-size, growth, and lazy-allocation behavior;
- select native ownership before legacy realization for Model, Primitive/ground/classification, main terrain, Material images, water masks, ocean normal maps, and styled feature tables;
- request typed-array-only model payloads and skip legacy ModelDrawCommands when MODEL is natively owned;
- cache normalized model geometry before traversal and share immutable meshes across repeated nodes;
- add the corresponding acceptance gates before re-enabling defaults.

### Phase 1: establish ownership and identity

- introduce the frame graph and resource declarations;
- make pipeline/cache keys complete and device-scoped;
- split context-free source/decoded caches from backend realization caches;
- share immutable WebGPU realizations and compiler/default resources per pooled device generation;
- add leases, byte accounting, deferred destruction, and budgeted eviction;
- include provider/content identity in terrain, imagery, and ocean keys;
- replace single-slot model/IBL WebGPU caches with device/generation-keyed realizations;
- centralize encoder/submission ownership;
- make device-generation invalidation exhaustive;
- make G-buffer/MRT conditional;
- fix collection and render-target teardown.

### Phase 2: remove CPU feedback from the WebGPU scheduler

- persistent object/mesh/material tables;
- GPU cull/LOD/HiZ/sort/compact;
- monotonic indirect arenas;
- no normal-frame visibility or sort readback;
- per-adapter measured thresholds and CPU fallback.

### Phase 3: unify data and shaders

- immutable decoded Geometry/Texture/Terrain payload contracts that never create backend objects;
- shared frame/view/material/object data hierarchy;
- backend-neutral material/shader IR;
- exact GLSL/WGSL parity fixtures;
- async pipeline prewarm and variant telemetry.

### Phase 4: adopt modern optional features selectively

- immediates for tiny hot data;
- transient attachments for discard-only graph resources;
- standard uniform layout variants;
- targeted newer subgroup helpers;
- optional dual-source OIT and external video textures;
- bundles only for proven stable cohorts.

## Final assessment

The fork should not retreat to an upstream-shaped WebGL architecture. Cesium's legacy renderer required meaningful refactoring to support WebGPU well. The right next move is also not another wave of isolated visual effects. The fork now needs a consolidation campaign: correct renderer selection and context ownership, choose backend ownership before resource realization, split decoded assets from per-domain GPU realizations, add an explicit frame graph, complete cache identities, build a coherent uniform/object-data model, and make the scheduler genuinely GPU-resident.

Once those foundations are in place, the existing breadth of WGSL, feature renderers, probes, precision work, and advanced effects becomes an asset rather than an integration burden. WebGPU-only workloads should then pay zero compatibility GPU allocation for natively owned features, while simultaneous WebGL/WebGPU views share every safe source/decode product and create only the irreducible one GPU realization per API domain. Without that consolidation, adding more WebGPU features will amplify pass-order, cache, lifetime, allocation, and parity risk.
