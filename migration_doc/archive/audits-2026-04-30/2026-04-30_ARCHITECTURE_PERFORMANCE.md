# Architecture & Performance Audit

**Date:** 2026-04-30  **Branch:** main @ 92e9a5d5c2 (Batch 116)
**Method:** code-verified — claims grounded in file paths + line numbers and Grep counts; agent-report claims cross-checked against actual source.

---

## Executive summary

The fork's architectural shape is sound: `GraphicsContext` abstract base + `Context`/`WebGPUContext` siblings + a 45-key `FeatureRenderer` registry that lets Scene code stay backend-agnostic. The scaffolding has held up across 116 batches of work. The central caches that were missing in the April-2026 deep review (render pipeline cache, compute pipeline cache, shader module cache, bind-group cache, storage-buffer pool, device-loss invalidation) are now wired. The remaining problems are **execution problems, not architecture problems**: 4 files over 2000 lines, 18 over 1000; the `RenderCommand` abstraction stalled at 3-of-27 Scene-file adoption; 15 transitional `Scene/` branches the FR pattern was designed to eliminate; render pipeline cache has no eviction policy; HDR-toggle pipeline-format generation is a manual contract that 23 files must implement correctly. None are blockers; a focused 2-3 week cleanup tier would close the most damaging memory-growth and frame-budget gaps.

---

## Doc inaccuracies surfaced during verification

These ground-truth corrections came up while running counts. Each one matters because the inaccuracy is being repeated in handoffs / past audits:

1. **Prior agent / docs claim "RenderCommand adopted in only 3 scene files vs. 24 still constructing DrawCommand directly":** **VERIFIED CORRECT.** `Grep RenderCommand` in `Source/Scene/`: 3 files (`ClassificationPrimitive.js`, `GroundPrimitive.js`, `QuadtreePrimitive.js`). `Grep "new DrawCommand"` in `Source/Scene/`: 24 files. The architectural debt is real.
2. **Prior agent claim "17 boundary violations in 8 files":** approximation. Actual: **15 real branches across 11 files** when filtering out comment-only mentions, debug helpers, and the legitimate getter at `Scene.js:2066`.
3. **Prior agent claim "RenderCommand.js at packages/engine/Source/Renderer/":** wrong path. Actual: `packages/engine/Source/Renderer/WebGPU/RenderCommand.js` — it lives *inside* the WebGPU directory and is on the `WEBGPU_COMPAT_EXEMPTIONS` list.
4. **Prior agent claim "_scenePipelineFormatGeneration observed by 23 renderers":** **VERIFIED CORRECT** by `Grep` — exactly 23 files in `Source/Renderer/WebGPU/` reference the symbol.
5. **Prior agent claim "WEBGPU_COMPAT_EXEMPTIONS = 4 entries":** **VERIFIED CORRECT.** Listed in `scripts/bundleVariantPlugin.js:114–119`.
6. **Prior agent claim "ShaderDefine has 4 active bits, 24 max; ShaderSourceId has 22 entries":** **VERIFIED CORRECT** by reading `WebGPUShaderDefines.ts:37–154`. 4 active bits (`GEODETIC_NORMAL`, `DISABLE_DEPTH_DISTANCE`, `SPLIT_ENABLED`, `COMPRESSED_VERTICES`); 22 source IDs (1–22; ID 0 reserved).
7. **Prior agent claim "WebGPURenderPipelineCache has no LRU eviction":** **VERIFIED CORRECT.** Reading `WebGPURenderPipelineCache.ts:597–628`: only `clear()` (wholesale) and `remove(descriptor, variant)` (single-key). No size cap, no LRU.
8. **`FeatureRendererKey` had a "DEFERRED_GBUFFER" slot at 33 that was removed — violating the documented add-only rule.** Verified: comment at `FeatureRendererKey.js:152–157` owns this. Subsequent slots were renumbered down. The discipline was formalized after this happened.

---

## 1. Architecture health

### 1a. Layering & abstractions

The boundary is enforced via three mechanisms in [`packages/engine/Source/Renderer/GraphicsContext.ts`](../../../packages/engine/Source/Renderer/GraphicsContext.ts):

1. Abstract base class with a runtime `_verifyAbstractMethods()` check at registration time (`:615–668`). Both `Context.js` and `WebGPUContext.ts` must implement `beginFrame`, `endFrame`, `clear`, `resize`, `draw`, `getRendererString`, `readPixels`, `createViewportQuadCommand`, `destroy` plus 11 named getters or registration throws.
2. `FeatureRenderer` registry with sub-typed interfaces (`CollectionRenderer`, `PrimitiveCommandRenderer`, `SystemRenderer`) at `:316–430`.
3. `ContextRegistry` static at [`packages/engine/Source/Renderer/ContextRegistry.ts`](../../../packages/engine/Source/Renderer/ContextRegistry.ts) tracks every live context for split-screen / multi-view scenarios.

The contract is enforced at compile time for `.ts` subclasses (TypeScript parity) and at runtime for `Context.js`. Belt-and-suspenders for a JS+TS hybrid codebase.

**Boundary violations (verified by Grep):**

`Scene/` files branch on backend or import from `Renderer/WebGPU/`:

- `from "../Renderer/WebGPU/"` in `Source/Scene/*.js`: **0 hits**. Module-level import boundary is clean.
- `if (context.isWebGPU)` / `if (context.rendererType === "webgpu")` in `Source/Scene/*.js`: **15 real branches across 11 files** — `Vector3DTilePrimitive.js:534`, `Vector3DTileClampedPolylines.js:476, 741`, `Vector3DTilePolylines.js:429, 639`, `GroundPolylinePrimitive.js:543`, `ClassificationPrimitive.js:828`, `DepthPlane.js:52`, `FramebufferOrchestrator.js:100, 118, 120`, `GltfLoader.js:1378`, `Model/Model.js:3142`, `Model/EdgeVisibilityPipelineStage.js:77, 78`, `ViewportQuad.js:135`. Plus 2 sites in `Scene.js:2608/4397` that check `command.isWebGPUDrawCommand` (a *command* property, not a context branch).

The `Scene/` boundary is "soft" rather than "broken" — most violations are the recent (Batch 84+) Vector3DTile/GroundPolyline classification family where the WebGPU FR is the new path and the existing scene file delegates only when the FR is registered. Architecturally this is a transitional pattern, not a regression.

**Are abstractions justified?** Mostly yes, with two caveats:

- **`RenderCommand` adoption stalled.** Verified: 3 Scene files use it (`ClassificationPrimitive.js`, `GroundPrimitive.js`, `QuadtreePrimitive.js`). 24 Scene files still construct `DrawCommand` directly. As architecture, correct; as deployed, marginal. Either commit to migration sweep or remove and document dual-construction as the official pattern.
- **`FeatureRenderer` sub-types use `unknown[]` variadic args** on `update`/`execute`/`render`/`composite` (`GraphicsContext.ts:331–334`). Honest but defeats compile-time argument checking for cross-renderer parity. The sub-typed `CollectionRenderer.update(collection, frameState, ...args)` is closer to right; the base `FeatureRenderer` could probably drop the `update?` slot now that `CollectionRenderer` exists.

### 1b. Extension points

A new feature plugs in like this (worked example: any of the lazy-loaded entries in [WebGPUFeatureRenderers.ts:515–547](../../../packages/engine/Source/Renderer/WebGPU/WebGPUFeatureRenderers.ts)):

1. Author the renderer file under `packages/engine/Source/Renderer/WebGPU/` exporting an `update` (or `init`+`render` for system-style) function.
2. Add a numeric enum slot to `FeatureRendererKey` (add-only — `FeatureRendererKey.js:1–17` documents the rule) and bump `COUNT`.
3. Either eager-register in `registerWebGPUFeatureRenderers()` or call `context.registerFeatureRendererLoader(KEY, async () => …)` for code-splitting (7 lazy-loader call sites verified).
4. In the consumer scene file, call `context.getFeatureRenderer(KEY)` and conditionally early-return.

**Documented vs. tribal:**

Documented:

- CLAUDE.md "Feature Renderer Pattern (Phase D)" section with canonical code snippet.
- `FeatureRendererKey.js` has 110+ lines of inline JSDoc.
- `GraphicsContext.ts:1474–1672` documents `registerFeatureRenderer`, `registerFeatureRendererLoader`, `getFeatureRenderer`, `getFeatureRendererAsync`, `getFeatureRendererStatus`.

Tribal:

- "Lazy loader returns undefined the first frame, registered FR the second" behavior at `GraphicsContext.ts:1551–1562` is documented in JSDoc but the *visual* implication (one-frame WebGL fallback flicker on first navigation to Voxel/PointCloud/GaussianSplat) isn't surfaced. Production users will hit it.
- Sub-type discrimination is an unwritten convention (the sub-type is implied by the key, not declared on the registry slot).
- `WEBGPU_COMPAT_EXEMPTIONS` requires the new author to know to look. CI doesn't enforce membership.

### 1c. Build-variant architecture

`WEBGPU_COMPAT_EXEMPTIONS` = 4 entries (`WebGLCompatibilityStub`, `WebGPUShaderTranslator`, `WebGLStubPipelineExtractor`, `WebGPUNagaTranspiler`). The doc-comment at `bundleVariantPlugin.js:56–119` is unusually thorough about the trade-offs (IIFE bundles inline these regardless; ESM splits them properly).

**Growth risk.** 4 entries became 4 over a year; even at 10× growth that's 40 entries — manageable. The bigger risk is *missing* an addition: a new file that needs to be exempt but isn't gets the empty-stub Proxy at runtime in webgl-only builds, which throws.

**Recommendation:** add a structural test in `Tools/variant-smoke-test.mjs` (already exists per CLAUDE.md) that asserts every named export from `Source/Cesium*.js` resolves under each variant. The IIFE size measurements (7.1 MB dual / 6.4 MB webgpu-only / 5.6 MB webgl-only) are documented in CLAUDE.md.

---

## 2. Performance

### 2a. Frame-budget hot paths

**Per-frame allocations.** Three nasty hotspots remained as of the April 2026 review; one is now fixed:

1. **`WebGPUEffectsBindGroup.js`** (1471 lines) — was creating per-tile `GPUBuffer` + `GPUBindGroup` + texture views: ~24k driver-side allocations/sec for ~200 globe tiles at 60 Hz. Batch 55 wired a per-tuple cache (`effectsBgCache: Map<string, {buffer, bindGroup}>`) keyed on resource identity via WeakMap IDs. Steady state with identity-modelMatrix workload now plateaus at ≤4 cache entries. **FIXED.**
2. **JSON-keyed sampler / BGL caches in `WebGPUContext.ts`** — sampler cache and BGL cache. Each `JSON.stringify(descriptor)` is O(n) over fields per call. Hit by every pipeline build. Quantitatively a small fraction of a frame, but visible in profiles. **OPEN.**
3. **`writeBuffer` cadence.** 227 occurrences across 66 files. Most correct (one-time + on update). Per-frame hot-path uses concentrated in `WebGPUPolylineRenderer.js` (6 sites), `WebGPUModelRenderer.js` (9 sites), `WebGPUBufferPrimitiveRenderer.ts` (25 sites). Worth profiling under 3D Tiles load.

`WebGPUSceneRenderer.ts` itself: 2 `new Float32Array` calls + 10 `writeBuffer` calls (orchestration role, fine). `WebGPUPrimitiveCommands.js` declares 8 module-level `scratch*` Matrix4/Cartesian3/EncodedCartesian3 (`:61–71`) — pattern correctly applied. `mergeSort(commands.slice(0, count))` per pass per frustum (`WebGPUSceneRenderer.ts:279, 299`) allocates one transient array per sort — small, but per-frame. Could be hoisted into a reusable buffer.

**Per-command translation cost.** `executeWebGPUCommand` (`WebGPUSceneRenderer.ts:187–221`):

- One `selectCommandVariant` call (cheap)
- One `scene.debugCommandFilter` call (production strips this via pragma)
- Duck-typed `pipeline ?? _pipeline` check
- `dispatched.execute(renderPass, context)` — actual `setPipeline`/`setBindGroup`/`draw`

Hot loop in `executeBatch` (`:306–331`) wraps per-command in try/catch with Set-based dedup of warning keys. Per-command JS overhead ~1 µs.

**`executeBatchIndirect`** (`:354–476`) — greedily groups consecutive commands sharing pipeline + bind groups + index buffer into a single `drawIndexedIndirect` batch. Gated on `context.useIndirectDrawForTiles === true`; not auto-flipped today, so the optimization is paid for in code complexity but not yet in frame-time savings.

**Cache miss rates.** `WebGPURenderPipelineCache.getStats()` exists (`:583–595`) — hit/miss/created/size. Renderers calling `prewarm()` cover **6 files** (verified by Grep): Billboard, Globe, Label, PointPrimitive, Polyline, ShaderModuleCache itself. The other ~38 render-pipeline-creating files don't prewarm. First-frame cost paid at first sight of a primitive.

### 2b. Pipeline cache

**Cache key correctness** — `WebGPURenderPipelineCache.ts:466–558`. Key includes pipeline name, variant fields (depth test/write/compare, cull mode, front face, topology, blend JSON-stringified, stencil ops/masks, color write mask, depth bias triple), descriptor-level fields (multisample count, depth/stencil format, per-target color format + writeMask + has-blend, vertex buffer layout signature). **The key is structurally complete** post-Batch-34 fix. Deliberate omission of `blendConstant` is correct (per-encoder dynamic state).

**Risk of cache thrash.** Three scenarios:

1. **HDR toggle.** `_scenePipelineFormatGeneration` (verified: 23 files reference) — incremented in `_ensureResources` and `prepareFrame` when scene color format changes. Renderers that observe the bump rebuild their local pipelines. **Correct architecture**, not a hack — the contract for "scene-FB format changed; consumer-of-scene-FB pipelines are now invalid." Naming is opaque (a generation counter without an interface surface) but the implementation is right.
2. **Resize.** Pipelines NOT recreated on viewport resize (textures, not pipelines). Correct.
3. **Feature-renderer local caches** — Globe migrated to central cache in Batch 75. Model still uses its own `WebGPUModelPipelineCache.js` (1138 lines) because of the KHR-extension blocker.

**Eviction policy.** Verified by reading `WebGPURenderPipelineCache.ts:597–628`: only `clear()` (wholesale) and `remove(descriptor, variant)` (single-key). **No LRU eviction or size cap.** For long sessions with diverse content (3D Tiles), the cache grows monotonically. Each cached pipeline is ~KB-sized state; for a 24-hour session loading thousands of distinct glTF assets, worth bounding.

### 2c. Buffer & texture management

**Pooling strategy.** [`WebGPUStorageBufferPool.ts`](../../../packages/engine/Source/Renderer/WebGPU/WebGPUStorageBufferPool.ts) — power-of-2 size buckets with `maxPerBucket: 8`, `maxTotal: 64` defaults. Stats tracked. Acquire/release pattern correct; cap-based eviction prevents runaway growth.

[`WebGPURingBufferAllocator.ts`](../../../packages/engine/Source/Renderer/WebGPU/WebGPURingBufferAllocator.ts) — hot-path uniform-update allocator, designed for transient per-frame UB writes.

**Per-frame allocations.** Bind-group caching via `WebGPUBindGroupCache` (Batches 31-32 + 55); post-process effects + globe terrain hot paths deduplicated. Auto-exposure given identity-based view memoization in Batch 32.

**Texture lifetime.** Render targets / depth buffers owned by `WebGPUSceneFramebuffer`, `WebGPUEdgeFramebuffer`, `WebGPUOIT`, `WebGPUGlobeDepth`, `WebGPUDepthPlane`, `WebGPUPostProcessPipeline` — all owned by `WebGPUSceneRenderer` and recreated on resize / HDR toggle (`:734–998`). Lazy allocation (e.g., `_edgeFramebuffer` only when `scene._enableEdgeVisibility`) consistent throughout.

**Risk: post-process ping-pong textures always allocated** (`WebGPUPostProcessPipeline.ts:298–315`), even when the only stage is the identity blit. ~16 MB at 1080p HDR. Not catastrophic; identity-blit-only fallback could use a single texture or skip ping-pong.

### 2d. Shader compile

**Module cache effectiveness.** `WebGPUShaderModuleCache.ts` is Tier-1 dedupe by `(sourceId, defines)` Uint32 key. **22 source IDs registered**. Cache per-`GPUDevice`; cleared on device loss. `getOrCreate` is `Map.get` → `preprocess` → `createShaderModule` → `Map.set` — no allocation on hit.

**Prewarm coverage.** 6 files call `prewarm()`. 16 source IDs are NOT prewarmed (Voxel, Weather, VolumetricFog, Environment, PointCloud — the lazy-loaded family). For lazy-loaded renderers the prewarm should happen during dynamic-import settle, not at first draw — right tradeoff. For eager renderers, prewarm is happening. Coverage good for eager path; missing for **Model** (blocked on KHR-extension shader-family decision).

**Variant explosion risk.** 4 active bits (16 variants) — manageable. 24 bits available. Once Model lands KHR_texture_transform / KHR_materials_clearcoat / etc., each new bit doubles the variant space. Hard cap at 24 bits; growth strategy (per file's own docstring) is to migrate to 32→64 key when approached.

**Preprocessor.** `//>>ifdef FLAG` / `//>>else` / `//>>endif` only — no boolean expressions (`&&`, `||`, `!defined()`). For 4 bits, fine. Once 10+ bits are in play the inability to express `(A && B) || (!A && C)` will force enumerating all combinations as separate sources. **Plan a v2 preprocessor with boolean operators** before Model PBR extensions land — cheap to add since the preprocessor is a pure function.

### 2e. Compute pass costs

- **TAA** (`WebGPUTAAEffect.ts`): one render pass + history copy per frame. New velocity pass (Batch 106) adds a single render pass into `rg16float` before TAA. Cost proportional to draw call count, not pixel count.
- **Auto-exposure** (`WebGPUAutoExposure.ts`): two compute pipelines (luminance reduction + final reduce). Routed through `webgpuComputePipelineCache` since Batch 76. Default workgroup sizing not externally observable (in WGSL).
- **Bloom / AO / DoF** (`WebGPUPostProcessEffects.ts`): multi-pass; each effect manages own ping-pong textures + central pipeline cache as of Batch 32. Bind groups cached via `WebGPUBindGroupCache`.
- **Volumetric fog**: 3 compute passes per frame (density / scattering / integrate). Real implementation per `VolumetricFog.wgsl` Phase 5b kernels (not placeholders, despite the renderer-side docstring suggesting otherwise — see Maintainability audit).
- **Hi-Z occlusion / GPU sort keys / point-cloud sort**: dispatchers exist; consumers absent. `mapAsync` path in `WebGPUGPUCuller.ts:399–425` not guarded against device loss (April review H-R9 — still open).

---

## 3. Top 10 architecture risks

1. **`WebGPUContext.ts` (4363 LOC) past 4× CLAUDE.md threshold.** Doing too many things: device init, frame state, pipeline cache wrap, shadow cast loop, shader cache, sampler cache, BGL cache, pick FBO orchestration, capabilities snapshot, debug surfaces. Every cross-cutting change touches this file.
2. **`WebGPUSceneRenderer.ts` (3626 LOC) over budget.** Frustum loop, pick pass, edge composite, refraction capture, velocity pass, 8 `_executeBatch*` variants in one class.
3. **Lazy FR loading produces one-frame WebGL fallback flicker** on first navigation to Voxel/PointCloud/GaussianSplat scenes (`GraphicsContext.ts:1551–1562`). Documented but visible.
4. **Scene/ boundary leak (15 branches across 11 files)** is small but growing. No automated guard against new instances. ESLint rule or `gulp` audit task would prevent regression.
5. **`Model/Model.js` and `Model/EdgeVisibilityPipelineStage.js` branch on `isWebGPU`** rather than going through an FR, where the most diverse rendering happens. Model FR exists; consolidating these branches behind it is overdue.
6. **`RenderCommand` adoption stalled at 3-of-27 Scene files.** Carrying half-done abstractions is the most dangerous form of architectural debt.
7. **`_scenePipelineFormatGeneration` is a manual contract** between writer and 23 readers. One missed reader = stale pipeline + format-mismatch validation warning. **Add a runtime check in the pipeline cache that compares the cached descriptor's color format to `context._sceneColorFormat` on hit.**
8. **`WEBGPU_COMPAT_EXEMPTIONS` has no compile-time enforcement.** New backend-neutral file that the author forgets to exempt throws at runtime in webgl-only builds. Variant smoke test catches it post-build, not at PR time.
9. **`ContextRegistry` uses a single global registry on `GraphicsContext._registry`.** Two `cesium-engine` modules end up loaded (npm hoisting collision) → split-screen contexts can fail to find each other. Low probability, real.
10. **Add-only enum discipline has one historical violation** (slot 33 was `DEFERRED_GBUFFER`, removed, subsequent slots renumbered). Documented at `FeatureRendererKey.js:152–157`. Discipline now formalized.

---

## 4. Top 10 performance hot spots

1. **`mergeSort(slice = commands.slice(0, count))` per translucent/voxel/splat pass per frustum** (`WebGPUSceneRenderer.ts:279–303`). One transient array per sort. 4 frustums × 3 passes × 60 Hz = 720 transient arrays/sec. Hoist into per-pass scratch buffer.
2. **JSON-keyed sampler / BGL caches in `WebGPUContext.ts`.** `JSON.stringify` allocation per lookup, hot during pipeline builds.
3. **`createBindGroup` calls in `_executeSinglePassStage`** (`WebGPUPostProcessPipeline.ts:995–999`) per-stage per-frame. Each post-process stage rebuilds its bind group every frame even when source/dest views and uniforms are stable. ~5 stages × 60 Hz = 300 bind groups/sec → 0 steady-state if cached.
4. **`WebGPURenderPipelineCache` has no eviction.** Long sessions with diverse 3D Tiles content accumulate pipelines monotonically. LRU cap at 1024 entries plenty.
5. **PostProcess ping-pong textures always allocated** even when only stage is identity blit. ~16 MB at 1080p HDR.
6. **Stage-level `JSON.stringify` of blend descriptors** in pipeline cache key generation per call.
7. **No prewarm for Model PBR pipelines** (blocked on KHR work) — first-render-of-glTF stutter.
8. **Per-frame `console.warn`/`console.log` allocations in unwrapped sites.** Most are pragma-wrapped (compliance verified); the few that aren't are worth a sweep. Run `Grep "console\\.(log|warn)"` outside `//>>includeStart` blocks to enumerate.
9. **`writeBuffer` cadence in collection renderers** (Polyline, Model, BufferPrimitive). Per-frame uploads where one-time-then-dirty would suffice.
10. **`createBindGroup` in `WebGPUSSREffect.executeSSR`** (`:205–214`) — per-frame, even though most of the bound resources are stable. Cache by tuple.

---

## 5. Recommended high-ROI improvements

- **Audit and strip per-frame `console.log`/`console.warn` calls** that aren't pragma-wrapped. One commit, mechanical, drops measurable µs per frame.
- **Cache the post-process per-stage `createBindGroup` calls** — same pattern as Batch 32, applied to `_executeSinglePassStage`.
- **Add LRU eviction to render pipeline cache** at 1024 entries.
- **Pre-fire the lazy FR loader on first relevant scene mutation** (e.g., when `frameState` first sees a Voxel/GaussianSplat/PointCloud primitive). Eliminates one-frame WebGL fallback flicker.
- **Skip ping-pong texture allocation when no post-process effects enabled.** ~16 MB at 1080p HDR.
- **Replace JSON.stringify-based sampler / BGL keys** with a structural hash over the few fields each cache cares about.
- **Hoist `mergeSort` scratch** in `WebGPUSceneRenderer.ts` into per-pass reusable buffer.
- **Run `prewarm` for Cloud / Voxel / VolumetricFog** at renderer init.
- **Add a `gulp` task that fails CI on new `isWebGPU` introductions** in `Source/Scene/`. Documentary; one boundary check per PR.

---

## 6. Recommended structural refactors

- **Decompose `WebGPUContext.ts`** into: `WebGPUContext` (core) + `WebGPUContextDeviceInit` + `WebGPUContextCaches` (sampler/BGL/shader/pipeline/compute pipeline/storage pool getters) + `WebGPUContextShadowDispatch` + `WebGPUContextDebug`. Each <800 lines. Same surface, navigability win is large.
- **Decompose `WebGPUSceneRenderer.ts`** into: `WebGPUSceneRenderer` (orchestrator) + `WebGPUFrustumLoop` + `WebGPUPickPass` + `WebGPURefractionCapture` + `WebGPUVelocityPass` + `WebGPUEdgeOverlayCompositor`. Keep per-method `executeBatch*` family in `WebGPUBatchHelpers`.
- **Resolve the `RenderCommand` decision** — either complete adoption (24 Scene files to migrate) or deprecate and document. Carrying it half-done is worse than either path.
- **Promote the `_scenePipelineFormatGeneration` contract** to a named export with a doc-comment surface. Renderers that own pipelines have to observe it; today enforced only by code review.
- **Move the `Scene/` `isWebGPU` branches in `Vector3DTile*.js` / `GroundPolylinePrimitive.js` / `Model.js` / `EdgeVisibilityPipelineStage.js` behind their respective FRs.** This is the boundary cleanup the FR pattern was designed for; finish the migration.
- **Consider splitting the `FeatureRenderer` interface tree** — sub-typed interfaces already exist; just delete optional slots from the base and force callers to narrow.
- **Plan v2 preprocessor with boolean operators** before Model KHR-extension shaders force per-permutation source IDs.
- **Bind a CI smoke test against variant entry barrel exports.** One pass through each variant's `Source/CesiumWebGL.js` / `Source/CesiumWebGPU.js` confirming no named exports throw at import.

---

## Sources cited (line-anchored)

- `packages/engine/Source/Renderer/GraphicsContext.ts` (1783 LOC)
- `packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts` (4363 LOC)
- `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts` (3626 LOC)
- `packages/engine/Source/Renderer/WebGPU/WebGPUFeatureRenderers.ts` (668 LOC)
- `packages/engine/Source/Renderer/WebGPU/WebGPURenderPipelineCache.ts` (657 LOC)
- `packages/engine/Source/Renderer/WebGPU/WebGPUShaderModuleCache.ts` (132 LOC)
- `packages/engine/Source/Renderer/WebGPU/WebGPUShaderDefines.ts` (176 LOC)
- `packages/engine/Source/Renderer/WebGPU/WebGPUPostProcessPipeline.ts` (1200 LOC)
- `packages/engine/Source/Renderer/ContextRegistry.ts`
- `packages/engine/Source/Renderer/FeatureRendererKey.js` (167 LOC)
- `scripts/bundleVariantPlugin.js`
- `migration_doc/PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md`
- `migration_doc/DEFERRED_WORK.md`
- `migration_doc/PHASE_5_MODERN_WEBGPU_DESIGN.md`
- Boundary-violation files: `Scene/Vector3DTile{Primitive,Polylines,ClampedPolylines}.js`, `Scene/GroundPolylinePrimitive.js`, `Scene/ClassificationPrimitive.js`, `Scene/DepthPlane.js`, `Scene/FramebufferOrchestrator.js`, `Scene/GltfLoader.js`, `Scene/Model/Model.js`, `Scene/Model/EdgeVisibilityPipelineStage.js`, `Scene/ViewportQuad.js`
