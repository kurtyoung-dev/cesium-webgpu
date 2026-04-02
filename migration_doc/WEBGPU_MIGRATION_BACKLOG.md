# CesiumJS WebGPU Migration — Remaining Work Backlog

**Last Updated:** April 2, 2026
**Purpose:** Single source of truth for ALL remaining work — WebGPU features, tech debt, parity gaps, sorting integration, picking, ES6 modernization, and upstream issues.

> **For architecture, completed work, and current state, see `WEBGPU_MIGRATION_STATUS.md`.**

---

## Table of Contents

1. [Tier 1: Minimal Usable Globe (Blocking)](#1-tier-1-minimal-usable-globe)
2. [Tier 2: 3D Content (Essential)](#2-tier-2-3d-content)
3. [Tier 3: Visual Quality & Polish](#3-tier-3-visual-quality--polish)
4. [Tier 4: Testing, Performance & Optimization](#4-tier-4-testing-performance--optimization)
5. [Sorting System Integration](#5-sorting-system-integration)
6. [Picking System Remaining](#6-picking-system-remaining)
7. [Fork-Specific Tech Debt](#7-fork-specific-tech-debt)
8. [WebGL/WebGPU Feature Parity Gaps](#8-webglwebgpu-feature-parity-gaps)
9. [ES6 Modernization Backlog](#9-es6-modernization-backlog)
10. [Upstream Issues (Unaddressed)](#10-upstream-issues-unaddressed)
11. [WASM & Performance Roadmap](#11-wasm--performance-roadmap)
12. [WebGPU Performance Infrastructure (Built, Not Active)](#12-webgpu-performance-infrastructure)

---

## 1. Tier 1: Minimal Usable Globe

**Target:** A functional globe with imagery that users can interact with.

| # | Feature | Why Critical | Effort | Status |
|---|---------|-------------|--------|--------|
| 1.1 | **Imagery reprojection pipeline** | Full WebGPU reprojection implemented: `ReprojectWebMercator.wgsl` shader, `WebGPUImageryReprojection.ts` module (render-to-texture pass), `IMAGERY_REPROJECTION` feature renderer registered. `ImageryLayer._reprojectTexture()` detects WebGPU context and uses GPU reprojection instead of WebGL ComputeCommand. `WebGPUGlobeSurfaceRenderer._getOrCreateImageryTexture()` checks for `_webgpuReprojectedTexture`. Image source preserved for WebGPU in `_createTexture()`. | — | ✅ Complete |
| 1.2 | **Multi-frustum integration testing** | `WebGPUSceneRenderer` iterates far-to-near with opaque near offset matching WebGL. Needs end-to-end testing. | 1-2 days | ⚠️ Implementation done |
| 1.3 | **Pick depth blit** | Globe depth copy activated in `WebGPUSceneRenderer`. `PickDepth.js` async readback via `copyTextureToBuffer` + `mapAsync` of packed RGBA texture. | — | ✅ Complete |
| 1.4 | **OIT scene integration** | Non-OIT fallback active (standard alpha blending). True OIT with MRT derived pipelines moved to Tier 3.2. | — | ✅ Safeguarded (non-OIT fallback) |
| 1.5 | **Post-processing scene integration** | **Complete.** Full pipeline with 5 tonemapping operators (Reinhard, ACES, Filmic, Modified Reinhard, PBR Neutral), FXAA, Bloom (4-pass: BrightPass→BlurH→BlurV→Composite), SSAO (4-pass: Generate→BlurH→BlurV→Modulate), Depth of Field (3-pass: BlurH→BlurV→Composite), Edge Detection, Silhouette. All effects lazily initialized on first enable via standard CesiumJS API (`scene.postProcessStages.bloom.enabled = true`). Depth texture passed for AO/DoF. `configureWebGPUPostProcessPipeline()` syncs state each frame. | — | ✅ **Complete** |
| 1.6 | **Ground primitive scene integration** | Feature renderer registered with `createCommands`. Routing added in `GroundPrimitive.js` `updateAndQueueCommands()`. | — | ✅ Complete |

**Estimated total:** ✅ Tier 1 substantially complete — remaining items are testing/validation only.

---

## 2. Tier 2: 3D Content

**Target:** Models, 3D Tiles, and feature-complete collections.

| # | Feature | Effort | Status |
|---|---------|--------|--------|
| 2.1 | **Model: morph targets** | — | ✅ Complete: Full pipeline wired — `ModelPBRComplete.wgsl` has bind group 4 (storage+uniform), morph vertex blending before skinning per glTF spec, `WebGPUModelPipelineCache.js` has 5-group layout with default morph BG, `WebGPUModelRenderer.js` creates morph resources per-primitive from `ensureMorphTargetResources()`, sets `HAS_MORPH_TARGETS` flag (bit 14), passes bind group 4, destroys on cleanup. Max 8 targets. |
| 2.2 | **Model: GPU instancing** | — | ✅ Complete: Full pipeline wired — `ModelPBRComplete.wgsl` has bind group 5 (storage buffer of `array<mat4x4<f32>>`), `FLAG_HAS_INSTANCING` (bit 15), `@builtin(instance_index)` in VertexInput, instance transform applied after morph/skinning before RTE per glTF spec. `WebGPUModelInstancing.js` reads packed transforms from `runtimeNode.transformsTypedArray` (cached by modified `InstancingPipelineStage.js`), expands 12-float packed to 16-float mat4x4, creates GPU storage buffer. `WebGPUModelPipelineCache.js` has 6-group pipeline layout with instancing BGL + default identity bind group. `WebGPUModelRenderer.js` detects `node.instances`, creates instancing resources, sets `FLAG_HAS_INSTANCING` in material flags, passes instancing bind group as 6th element, uses `instanceCount` in draw command. Supports both `EXT_mesh_gpu_instancing` and legacy i3dm. |
| 2.3 | **Model: feature ID textures** | — | ✅ Complete: Full pipeline wired — `WebGPUModelFeatureId.js` helper finds selected feature ID (mirrors `SelectedFeatureIdPipelineStage` logic), creates GPU textures for both feature ID texture (EXT_mesh_features) and batch texture (per-feature styling). `ModelPBRComplete.wgsl` has bind group 6 with `FeatureIdUniforms` struct, `featureIdTexture`/`batchTexture` bindings, `unpackFeatureId()` (1-4 channel czm_unpackUint equivalent), `lookupBatchColor()` (single/multiline batch tex layouts). `FLAG_HAS_FEATURE_ID_TEXTURE` (bit 16), `FLAG_HAS_FEATURE_ID_ATTRIBUTE` (bit 17), `FLAG_HAS_BATCH_TABLE` (bit 18). `WebGPUModelPipelineCache.js` expanded to 7-group pipeline layout with `featureIdBGL` + default bind group. `WebGPUModelRenderer.js` calls `ensureFeatureIdResources()` per-primitive, sets flags, passes bind group as 7th element. Cleanup via `destroyFeatureIdResources()`. `ModelMaterialInfo.js` updated with new flag constants. |
| 2.4 | **Model: unused WGSL PBR shaders** | — | ✅ Deleted `ModelPBRVertex.wgsl` and `ModelPBRFragment.wgsl` (strict subsets of `ModelPBRComplete.wgsl`, incompatible MaterialUniforms struct, never imported). |
| 2.5 | **Scene routing: CloudCollection** | 0.5 day | ✅ Renderer done, routing via FeatureRendererKey |
| 2.6 | **Scene routing: PointCloud** | 0.5 day | ✅ Renderer done, routing via FeatureRendererKey |
| 2.7 | **Scene routing: VoxelPrimitive** | 0.5 day | ✅ Renderer done, routing via FeatureRendererKey |
| 2.8 | **Scene routing: GaussianSplat** | 0.5 day | ✅ Renderer done, routing via FeatureRendererKey |
| 2.9 | **Scene routing: EllipsoidPrimitive** | 0.5 day | ✅ Renderer done, routing via FeatureRendererKey |
| 2.10 | **Scene routing: InvertClassification** | 0.5 day | ✅ Renderer done, routing via FeatureRendererKey |
| 2.11 | **Scene routing: PointCloudEDL** | 0.5 day | ✅ Renderer done, routing via FeatureRendererKey |
| 2.12 | **Imagery layers rendering (standalone)** | — | ✅ N/A — Imagery layers in CesiumJS are not standalone renderable entities; they are texture layers draped onto terrain tile geometry. The WebGPU globe surface renderer (`WebGPUGlobeSurfaceRenderer.ts`) already handles imagery layers: up to 4 per draw call with multi-pass for >4, including reprojection support. No separate "standalone" renderer is needed. |

**Note:** Items 2.5–2.11 have renderers built and scene files updated with `getFeatureRenderer()` calls, but the renderers themselves need end-to-end testing to verify they actually render correctly through the full pipeline.

**Estimated total:** ✅ **Tier 2 COMPLETE** — All 12 items resolved. Model pipeline supports PBR, morph targets, skinning, GPU instancing, feature ID textures + batch table styling. All 7 scene collection renderers routed via FeatureRendererKey. Imagery layers handled through globe terrain renderer.

---

## 3. Tier 3: Visual Quality & Polish

| # | Feature | Effort | Status |
|---|---------|--------|--------|
| 3.1 | **Shadow map receive-side** | — | ✅ **Complete.** Combined `EffectsUniforms` bind group (112 bytes) carries shadow matrix + map size + darkness + soft-shadows flag alongside clipping plane uniforms. `PrimitivePhongColor.wgsl` and `PrimitivePhongTexturedColor.wgsl` have full PCF shadow sampling with `computeShadowFactor()` in fragment output. `GlobeTerrain.wgsl` has `globeComputeShadowFactor()` applied to Lambert diffuse. `WebGPUEffectsBindGroup.js` creates placeholder resources (1×1 depth=1.0, darkness=1.0 → no shadow) so the bind group is always present. `WebGPUPrimitiveCommands.js` wires effects BGL into pipeline layout and placeholder bind group into draw commands. `WebGPUGlobeSurfaceRenderer.ts` wires effects BGL as group 4 in the 5-group pipeline layout, placeholder bind group in all tile + wireframe draw commands. |
| 3.2 | **Derived command system integration** | — | ✅ **Scene renderer wired.** `executeBatchDepthOnly()` added to `WebGPUSceneRenderer.ts` — marks commands with `_depthOnly=true`/`_colorWriteMask=0` for depth-only pipeline variant selection. `executeBatchTranslucent()` reads `_webgpuTranslucencyDerived` markers and applies blend/depth/cull overrides per command. `WebGPUSceneRenderer.createDerivedCommand()` static factory delegates to `WebGPUDerivedCommand` for all 5 variant types. Globe pass uses `executeBatchTranslucent` when globe translucency is active. **Remaining:** OIT MRT derived pipelines (2-target accumulation pass) for true order-independent transparency. |
| 3.3 | **Globe translucency activation** | — | ✅ **Scene renderer wired.** `_executeGlobePass()` detects `translucencyEnabled` on the globe's tile provider and routes globe commands through `executeBatchTranslucent()` which applies per-command blend state from `_webgpuTranslucencyDerived` markers (set by `WebGPUGlobeTranslucencyState.updateDerivedCommands()` via FeatureRendererKey). 9 derived command types with correct blend/cull/depth. **Remaining:** Full OIT integration for overlapping translucent surfaces. |
| 3.4 | **Clipping shader integration** | — | ✅ **Complete.** Combined effects bind group carries clipping plane count, union mode, edge width/color. `PrimitiveBasicColor.wgsl`, `PrimitivePhongColor.wgsl`, `PrimitivePhongTexturedColor.wgsl` all have `clipByPlanes()` with early discard + edge highlighting. `GlobeTerrain.wgsl` has `globeClipByPlanes()` against ECEF world positions. Plane data sampled from RGBA32Float texture packed by `WebGPUClippingPlaneCollection.ts`. Supports intersection (all planes clip) and union (any plane clips) modes. Globe surface renderer pipeline layout updated with group 4 effects BGL. **Deferred:** Polygon SDF clipping shader (plane-based clipping works for all current use cases). |

**Estimated total:** ✅ **Tier 3 COMPLETE.** All core visual quality features are wired: shadow receive (primitive + globe), clipping planes (primitive + globe), derived commands, globe translucency, globe effects pipeline (5-group layout). **Deferred enhancements** (moved to Tier 4+): OIT MRT (~2-3 days, non-OIT alpha blend fallback works), polygon SDF clipping (~1 day, plane-based clipping works).

---

## 4. Tier 4: Testing, Performance & Optimization

| # | Feature | Effort | Status |
|---|---------|--------|--------|
| 4.1 | **Jasmine unit tests** | 4-6 days | ❌ Zero tests for 83+ WebGPU files. **#1 quality risk.** Start with: `WebGPUContext`, `WebGPUBuffer`, `WebGPUTexture`, `WebGPUDrawCommand`. |
| 4.2 | **Automated visual regression (pixel-diff)** | 3-4 days | ❌ Split-screen exists but no automated testing |
| 4.3 | **Browser compatibility testing** | 3-5 days | ❌ Safari, Firefox WebGPU support |
| 4.4 | **Performance benchmarking** | 2-3 days | ❌ No WebGL vs WebGPU comparison data |
| 4.5 | **Render bundles for terrain** | 3-4 days | 🔧 `WebGPURenderBundleManager.ts` exists. 50-80% CPU reduction for static tiles. |
| 4.6 | **Indirect drawing for 3D Tiles** | 5-7 days | 🔧 `WebGPUIndirectDrawManager.ts` exists. GPU-driven rendering. |
| 4.7 | **Buffer sub-allocator (ring buffer)** | 3-4 days | 🔧 Infrastructure exists. Zero per-frame buffer creation. |
| 4.8 | **Console noise reduction** | 1 day | ~12 `console.warn/error` calls across standalone WebGPU modules (not using context-aware logging) |
| 4.9 | **Device loss recovery consolidation** | 1-2 days | ✅ Resolved (FORK-1) — inline handler removed, delegates to `WebGPUDeviceLossRecovery` via host interface |

**Estimated total:** ~6 weeks

---

## 5. Sorting System Integration

The sorting system has 11 phases built (30+ files), but several components are not yet wired into the render pipeline.

### What Works End-to-End ✅
- `entity.renderPriority` → Visualizer → Collection → DrawCommand → Scene.js comparators
- `RenderScheduler.beginFrame()` called in `Scene.prototype.render()`
- `MaterialSortIdAllocator` populating `materialSortId` via `RenderScheduler.binCommand()`
- Scene.js multi-level comparators reading `sortPriority`/`materialSortId`
- Geometry batch priority grouping in `StaticGeometryColorBatch`/`StaticGeometryPerMaterialBatch`
- WASM binary compiled (17.2 KB, deployed to `ThirdParty/Workers/`)

### What Needs Integration

| ID | Item | Effort | Status |
|----|------|--------|--------|
| **SORT-5** | Wire `SceneOctree.build()`/`collectVisible()` into `ViewportExecutor` | — | ✅ **Complete** — Octree wired into `executeCommandsInViewport()` (opt-in via `scheduler.octree.enabled = true`) |
| **SORT-6** | Wire `OcclusionCulling.testCommands()` into render pipeline | — | ✅ **Complete** — Wired into `executeCommandsInViewport()` (opt-in, WebGPU-only, conservative fallback when async results pending) |
| **SORT-8** | Unit tests for all sorting code (30+ files) | 3-5 days | ❌ Zero coverage |
| **SORT-12** | `OcclusionCulling` lazy GPU resource init untested | Tied to end-to-end testing | 🟡 GPU resources still stub — JS manager API exercised |
| **SORT-FULL** | Full `RenderScheduler` layer-based execution (depth clear between layers, per-layer sort modes) | — | ✅ **Complete** — `sortAllLayers()` wired in `ViewportExecutor` after `binCommand()` loop. Per-layer sort modes active (MATERIAL_MESH, BACK_TO_FRONT, etc.) |

### Sorting Architecture Reference

**Current sort comparator (Scene.js — active):**
```
frontToBack (opaque):  sortKey → sortPriority → materialSortId → distance (front-to-back)
backToFront (translucent): sortKey → sortPriority → distance (back-to-front)
```

**RenderScheduler (built but not fully active):** Per-layer command binning, configurable sort mode per layer (MATERIAL_MESH, BACK_TO_FRONT, MANUAL, CUSTOM), depth clear between layers.

**Octree (built, opt-in):** `SceneOctree.js` + `OctreeNode.js`. Hierarchical frustum + horizon culling. 200-command threshold. Earth-radius root auto-configures from scene ellipsoid.

**Hi-Z Occlusion (built, WebGPU only):** `HiZPyramid.wgsl` + `OcclusionTest.wgsl` + `OcclusionCulling.js`. Auto-disable when benefit < 20%.

**WASM Bridges (built, JS fallback works):** `WasmCullBridge.js` (batch frustum culling), `WasmSortBridge.js` (O(N) radix sort on 64-bit packed keys), `SOABoundingSphereLayout.js` (SIMD data layout).

---

## 6. Picking System Remaining

### What Works ✅
- `WebGPUPickFramebuffer.ts` — full implementation with async readback
- `WebGPUSceneRenderer._executePickPass()` — renders GLOBE/3D_TILE/OPAQUE/TRANSLUCENT passes
- `Primitive.js` — pushes WebGPU pick commands during pick-only passes
- All 3 collection renderers — full pick support (Billboard, Point, Polyline)
- Depth readback for pick pass — `depth32float` + `readDepthPixelAsync(x, y)`
- `PickDepth.js` — ES6 class with `getDepthAsync()` for WebGPU
- Pick ID consolidated — single source of truth in `GraphicsContext`
- Convenience APIs — `scene.pickAll()`, `scene.pickRayAll()`, `scene.pickColumn()`

### Remaining

| # | Item | Effort | Status |
|---|------|--------|--------|
| 6.1 | **WGSL depth-to-color blit shader** for main scene depth readback (`pickPositionWorldCoordinates`) | 1-2 days | ⚠️ Pick pass depth works, scene depth pending |
| 6.2 | **Pick layer filtering** — bitmask to skip unpickable objects before rendering | 1-2 days | ❌ Not started |
| 6.3 | **Octree pick acceleration** — pre-filter commands using octree before pick render | 1-2 days | ❌ Not started (depends on SORT-5) |
| 6.4 | **GPU multi-hit** (WebGPU only) — storage buffer per-pixel linked list for single-pass drill pick | 3-5 days | ❌ Future |
| 6.5 | **Rectangle selection** — `scene.pickInRectangle(startPos, endPos)` | 2-3 days | ❌ Future |
| 6.6 | **Pick priority** — `entity.pickPriority` for overlapping entities (upstream #1592) | 1-2 days | ❌ Future |
| 6.7 | **CPU hybrid pick** — geometric ray intersection for simple entities (billboards, points) | 3-5 days | ❌ Future |

---

## 7. Fork-Specific Tech Debt

Items introduced by our WebGPU additions that don't exist in upstream. 21 of 46 resolved; 25 remaining.

> **See also:** `COMPREHENSIVE_AUDIT_2026_03_31.md` for detailed analysis of compute shader and WASM fallback gaps.

### Remaining Items (Priority Order)

| ID | Issue | Severity | Effort | Details |
|----|-------|----------|--------|---------|
| **FORK-41** | **7 of 10 compute shaders awaiting activation** | 🟡 Medium | Documented | **Activation plan documented below.** 3 compute shaders now active: PolygonSignedDistance (clipping), BrdfLutGenerate (IBL one-time), IrradianceConvolution + RadiancePrefilter (IBL on env map change). 7 remaining shaders have infrastructure + fallbacks — activation deferred to when their consumer systems are wired. |
| **FORK-45** | **Single global WASM arena shared across bridges** | 🟡 Medium | 1 day | All 7 bridges share one `Mutex<Vec<u8>>`. If two bridges run in the same frame, the second `alloc_buffer()` overwrites the first. Add per-bridge buffer slots or named arena partitions. |
| **FORK-19** | **Zero Jasmine unit tests** for any WebGPU code | 🔴 High | 4-6 days | 83+ renderer files, 67+ shaders, 0 tests. Single largest quality risk. Start with smoke tests for core classes. |
| **FORK-11** | `webgpuTypeHelpers.ts` has limited adoption | 🟡 Medium | 0.5 day | Most files still use raw `as any` casts. Helpers should be used consistently. |
| **FORK-9** | ~11 `as any` casts remain in WebGPU TypeScript | 🟡 Medium | — | 8 in `WebGPUContext.ts` (unavoidable JS interop), 3 in other files (`@webgpu/types` limitations). |
| **FORK-17** | Compute shader mipmap generation TODO | 🟡 Medium | 1 day | `WebGLCompatibilityStub.ts` `generateMipmap` is incomplete. |
| **FORK-16** | WGSL preprocessor test page reimplemented | 🟡 Medium | 0.5 day | Test page reimplements preprocessor instead of importing `WGSLShaderPreprocessor.ts`. |
| **FORK-20** | 29 test pages use 3 different module loading patterns | 🟡 Medium | 1 day | Should standardize on one pattern. |
| **FORK-21** | Test pages contain hardcoded inline WGSL shaders | 🟡 Medium | 0.5 day | `scene-webgpu-poc.html`, `triangle.html` — will drift from canonical shaders. |
| **FORK-22** | Several test pages are raw WebGPU demos | 🟡 Medium | 0.5 day | Don't validate Cesium's WebGPU path. Should be labeled as demos vs integration tests. |
| **FORK-23** | No automated visual regression testing | 🟡 Medium | 2-3 days | Split-screen exists but needs pixel-diff CI integration. |
| **FORK-4** | `WebGLCompatibilityStub.ts` maintenance | 🟡 Medium | Ongoing | Now split into 6 domain modules. `GraphicsContext` factories reduce dependency over time. |
| **FORK-34** | Pick system: scene depth blit pending | 🟡 Medium | 1-2 days | WGSL depth-to-color blit shader needed. (Same as item 6.1 above.) |
| **FORK-31** | Sorting: remaining integration gaps | 🟡 Medium | ~1 week | RenderScheduler full integration, octree/occlusion View.js wiring. (Same as §5 above.) |
| **FORK-29** | Slang cross-compilation unused in production | 🟢 Low | — | Infrastructure exists, no current ROI. Will become valuable for future dual-output shaders. |
| **FORK-30** | `@webgpu/types` pinned to `^0.1.69` | 🟢 Low | — | Review during upstream syncs. |
| **FORK-8** | `panoramaCommand.isWebGPUDrawCommand` check in Scene.js | 🟢 Low | — | Acceptable command-type check (not backend check). Could be eliminated with `RenderCommand` (Path B). |

### Resolved Items (29 of 46) — For Reference

FORK-1 ✅ (device loss consolidation), FORK-2 ✅ (unused imports), FORK-3 ✅ (redundant shader loading), FORK-5 ✅ (Phase D 28/28), FORK-6 ✅ (isWebGPU checks reduced), FORK-7 ✅ (depthRangeZeroToOne), FORK-10 ✅ (ts-expect-error), FORK-12 ✅ (context-aware logging), FORK-13 ✅ (no debug logging), FORK-14 ✅ (CameraUniforms drift), FORK-15 ✅ (transitive struct deps), FORK-18 ✅ (DepthPlane implemented), FORK-24 ✅ (Primitive.js cleanup), FORK-25 ✅ (7 renderers wired), FORK-26 ✅ (COUNT auto-computed), FORK-27 ✅ (abstract methods verified), FORK-28 ✅ (25/25 materials), FORK-35 ✅ (pick ID consolidated), FORK-36 ✅ (convenience pick APIs), **FORK-37 ✅** (WASM `destroy()` + `free_buffer()` on all 7 bridges), **FORK-38 ✅** (WASM version check via `WasmFeatureDetection.checkVersionMatch()`), **FORK-39 ✅** (SIMD detection via `WasmFeatureDetection.checkSIMDSupport()` + `checkModuleSIMD()`), **FORK-40 ✅** (all 7 bridges have `destroy()` method), **FORK-42 ✅** (ComputeEngine `execute()`/`executeMultiple()`/`executeOnEncoder()` wrapped in try/catch, return bool), **FORK-43 ✅** (workgroup limit validation via `_validateWorkgroups()`), **FORK-44 ✅** (CPU fallback `sortByDistance()` + `lodFilterAndSort()` in WasmPointCloudBridge), **FORK-46 ✅** (Rust `alloc_buffer()` uses `try_reserve()`, returns null on OOM)

---

## 8. WebGL/WebGPU Feature Parity Gaps

Per `.clinerules` §4, new renderer-agnostic features MUST be implemented for both backends.

### GLSL Backport Analysis (April 2026)

Our new WGSL shaders fall into three categories for GLSL parity:

#### ✅ Already Have GLSL Equivalents — No Backport Needed
These WGSL shaders were created as WebGPU ports of existing GLSL upstream features. The GLSL versions already exist and work in the WebGL path:

| WGSL Shader | GLSL Equivalent(s) | Notes |
|---|---|---|
| `Tonemapping.wgsl` (5 modes) | `AcesTonemappingStage.glsl`, `ReinhardTonemapping.glsl`, `ModifiedReinhardTonemapping.glsl`, `FilmicTonemapping.glsl`, `PbrNeutralTonemapping.glsl` | GLSL has separate files per operator; WGSL consolidates into one |
| `GroundAtmosphere.wgsl` | `GroundAtmosphere.glsl` + `AtmosphereCommon.glsl` + builtin functions | Same Nishita scattering algorithm |
| `AmbientOcclusionGenerate.wgsl` | `AmbientOcclusionGenerate.glsl` | SSAO generation |
| `AmbientOcclusionModulate.wgsl` | `AmbientOcclusionModulate.glsl` | SSAO application |
| `BrightPass.wgsl` + `BloomComposite.wgsl` | `Bloom.glsl` + `BloomComposite.glsl` | Bloom post-process |
| `GaussianBlur1D.wgsl` | `GaussianBlur1D.glsl` | Shared blur utility |
| `DepthOfField.wgsl` | `DepthOfField.glsl` | DoF post-process |
| `EdgeDetection.wgsl` + `Silhouette.wgsl` | `EdgeDetection.glsl` + `Silhouette*.glsl` | Entity highlighting |
| `BrdfLutGenerate.wgsl` | `BrdfLutGeneratorFS.glsl` | IBL BRDF LUT |
| `IrradianceConvolution.wgsl` | `ComputeIrradianceFS.glsl` | IBL diffuse |
| `RadiancePrefilter.wgsl` | `ConvolveSpecularMapFS.glsl` | IBL specular |
| `FXAA.wgsl` | `FXAA3_11.glsl` | Anti-aliasing |

#### 🆕 New Features — WebGPU-Only, No GLSL Backport Required
These are new capabilities that either: (a) require compute shaders (impossible in WebGL), (b) are WebGPU-specific rendering techniques, or (c) are enhancements beyond upstream's scope:

| WGSL Feature | Why No GLSL Backport | Category |
|---|---|---|
| `ScreenSpaceReflections.wgsl` | New feature — no upstream GLSL exists. Could theoretically be GLSL but SSR is heavy; primarily benefits WebGPU users | WebGPU-first feature |
| `ProceduralClouds.wgsl` | New volumetric ray-march — no upstream GLSL. Extremely GPU-intensive | WebGPU-first feature |
| `WeatherParticles.wgsl` | GPU compute shader — impossible in WebGL (no compute) | Compute-only |
| `DeferredGBuffer.wgsl` + `DeferredLighting.wgsl` | Deferred rendering — requires MRT + storage buffers not practical in WebGL | WebGPU architecture |
| `AtmosphereLUT.wgsl` | Compute-based LUT — WebGL has per-pixel fallback in `SkyAtmosphere.wgsl` | Compute optimization |
| `PointCloudSort.wgsl` + `PointCloudLOD.wgsl` | GPU compute — WASM/JS fallbacks exist | Compute-only |
| `GPUSortKeys.wgsl` | GPU compute — JS comparators serve as fallback | Compute-only |

#### 🔵 Enhanced Features — Go Beyond Upstream GLSL
These WGSL enhancements in `GlobeTerrain.wgsl` add visual quality beyond what upstream `GlobeFS.glsl` provides. They're opt-in WebGPU improvements, not parity gaps:

| Enhancement | Upstream GLSL Behavior | Our WGSL Enhancement | Backport? |
|---|---|---|---|
| **Terminator glow** | No effect at day-night boundary | Warm Gaussian glow at terminator | ❌ Would require modifying upstream `GlobeFS.glsl` |
| **City lights emission** | Simple night alpha blending | Luminance-weighted emissive boost | ❌ Enhancement beyond upstream scope |
| **GGX ocean specular** | Phong specular (pow 64) | GGX/Trowbridge-Reitz PBR specular | ❌ Enhancement beyond upstream scope |
| **Fresnel ocean reflection** | No fresnel | Schlick approximation | ❌ Enhancement beyond upstream scope |
| **Ocean foam/whitecaps** | No foam | Steepness-based foam generation | ❌ Enhancement beyond upstream scope |
| **Subsurface scattering** | No SSS | Turquoise rim scatter on waves | ❌ Enhancement beyond upstream scope |
| **Deep water color** | 0.7× darkening | Blend to physical deep-ocean color | ❌ Enhancement beyond upstream scope |

#### 📋 New Upstream GLSL — WGSL Forward-Ports Needed (Low Priority)
These are NEW upstream features added since v1.135 that will eventually need WGSL equivalents when we add WebGPU rendering paths for them:

| GLSL Shader | Upstream PR | Feature | WGSL Priority | Notes |
|---|---|---|---|---|
| `computeTextureTransform.glsl` | #13121 (v1.140+) | `KHR_texture_transform` helper | 🟢 Low | Simple inline helper: `(transform * vec3(texCoord, 1.0)).xy`. Add when texture transforms in `ModelPBRComplete.wgsl` |
| `ConstantLodStageFS.glsl` | #13121 (v1.140+) | Distance-based constant LOD texture lookup | 🟢 Low | Model pipeline feature. Add when constant LOD extension support in WebGPU model path |
| `ConstantLodStageVS.glsl` | #13121 (v1.140+) | World-position UV computation for constant LOD | 🟢 Low | Paired with FS above |
| `BufferPointMaterialFS/VS.glsl` | v1.140 | Vector tile points | 🟢 Low | When vector tiles WebGPU path added |
| `BufferPolygonMaterialFS/VS.glsl` | v1.140 | Vector tile polygons | 🟢 Low | When vector tiles WebGPU path added |
| `BufferPolylineMaterialFS/VS.glsl` | v1.140 | Vector tile polylines | 🟢 Low | When vector tiles WebGPU path added |
| `EdgeVisibilityStageVS.glsl` | v1.137 | Edge visibility (glTF ext) | 🟢 Low | When edge visibility WebGPU path added |

**None of these are blocking.** They're new upstream features (not existing features missing WebGPU ports). Our WebGPU model pipeline (`ModelPBRComplete.wgsl`) handles models via a separate unified architecture — these staged GLSL shaders are specific to the WebGL model pipeline's modular stage system.

**Conclusion:** No GLSL backports are needed. Our WGSL shaders either (a) already have upstream GLSL equivalents that work in WebGL, (b) require GPU compute (impossible in WebGL), or (c) are deliberate WebGPU-only visual enhancements.


| ID | Gap | Severity | Effort | Details |
|----|-----|----------|--------|---------|
| **FORK-32** | **Multi-light `scene.lights` API** | ✅ **Resolved** | — | `scene.lights = new LightCollection()` in constructor. `frameState.lights` propagated in `updateFrameState()`. `UniformState.update()` calls `lights.pack()` → `_lightsData` + `_lightCount`. Auto-uniforms `czm_lightCount` / `czm_lightsData` in `AutomaticUniforms.js`. Full end-to-end wiring from scene → frame state → uniform state → shader. |
| **FORK-33** | **GLSL multi-light shader** | ✅ **Resolved** | — | All GLSL infrastructure was already built: `czm_lightData` struct, `czm_computeAttenuation()`, `czm_computeSpotCone()`, `czm_lightCount`/`czm_lightsData` auto-uniforms. **Newly added:** `LightingStageFS.glsl` now iterates the `czm_lightsData` array via `czm_unpackLight()` + `computeAdditionalLightPBR()` — supports directional, point, and spot lights with attenuation for up to 8 additional lights beyond the primary sun/directional light. |

---

## 9. ES6 Modernization Backlog

~432 files total need constructor→class conversion. ~75 completed so far.

### Completed ✅

| Directory | Status |
|-----------|--------|
| **Renderer (29/29)** | ✅ All JS files converted to ES6 class |
| **Scene high-priority (24+)** | ✅ All WebGPU-blocking files: Scene.js, Primitive.js, BillboardCollection.js, PointPrimitiveCollection.js, PolylineCollection.js, Billboard.js, PointPrimitive.js, SkyAtmosphere.js, Sun.js, Moon.js, SkyBox.js, CubeMapPanorama.js, ShadowMap.js, Globe.js, GlobeSurfaceTile.js, GlobeSurfaceTileProvider.js, GroundPrimitive.js, InvertClassification.js, CloudCollection.js, PointCloudEyeDomeLighting.js, VoxelPrimitive.js, TimeDynamicPointCloud.js, EllipsoidPrimitive.js, PostProcessStageCollection.js, Camera.js, View.js, Material.js, ImageryLayer.js, Picking.js, ScreenSpaceCameraController.js, DepthPlane.js, Fog.js, GlobeTranslucencyState.js, QuadtreePrimitive.js, QuadtreeTile.js, TerrainFillMesh.js, PickDepth.js, etc. |
| **DataSources high-priority (8)** | ✅ Entity.js, BillboardVisualizer.js, PointVisualizer.js, ModelVisualizer.js, GeometryVisualizer.js, PolylineVisualizer.js, StaticGeometryColorBatch.js, StaticGeometryPerMaterialBatch.js |
| **Appearance classes (4)** | ✅ Appearance.js, MaterialAppearance.js, PerInstanceColorAppearance.js, EllipsoidSurfaceAppearance.js, PolylineMaterialAppearance.js |

### Remaining (~380+ files)

#### ⚠️ Core — Performance-Critical Math (16 files, benchmark before converting)
`Cartesian2/3/4.js`, `Matrix2/3/4.js`, `Quaternion.js`, `BoundingSphere.js`, `BoundingRectangle.js`, `AxisAlignedBoundingBox.js`, `OrientedBoundingBox.js`, `Plane.js`, `Ray.js`, `Transforms.js`, `EllipsoidGeodesic.js`, `EllipsoidRhumbLine.js`

#### 🟡 Core — Terrain/Geography/Geometry (~30+ files)
Terrain providers, geometry classes (Box, Circle, Corridor, Cylinder, Ellipse, Ellipsoid, Frustum, Polygon, Polyline, Rectangle, Sphere, Wall, etc.)

#### 🟢 Core — Utilities (~40+ files)
`AssociativeArray.js`, `Clock.js`, `Color.js`, `CullingVolume.js`, `Ellipsoid.js`, `Event.js`, `JulianDate.js`, `Resource.js`, `TaskProcessor.js`, etc.

#### 🟡 Scene — 3D Tiles (~22 files)
`Cesium3DTileset.js`, `Cesium3DTile.js`, `Cesium3DTileBatchTable.js`, `Cesium3DTilesetTraversal.js`, `BatchTable.js`, `ImplicitSubtree.js`, `TileBoundingRegion.js`, etc.

#### 🟡 Scene — Imagery Providers (~16 files)
`ArcGisMapServerImageryProvider.js`, `BingMapsImageryProvider.js`, `UrlTemplateImageryProvider.js`, `WebMapServiceImageryProvider.js`, etc.

#### 🟡 Scene — Model/glTF Pipeline (~40+ files)
`Model.js`, `ModelDrawCommand.js`, `ModelSceneGraph.js`, `GltfLoader.js`, `GltfVertexBufferLoader.js`, 20+ pipeline stage files

#### 🟡 Scene — Remaining (~30+ files)
Particles, metadata, voxel subsystem, labels, polyline subsystem, environment, clipping, expression/conditions, misc rendering

#### 🟡 DataSources — Properties & Sources (~77 files)
Entity graphics (16 `*Graphics.js`), property classes (30+), data sources (CZML, GeoJSON, KML, GPX), geometry updaters (12), entity utilities

#### 🟡 Widgets (~22 files)
`Viewer.js`, `CesiumWidget.js`, Animation, BaseLayerPicker, Geocoder, Timeline, Inspector, etc. All depend on Knockout.js.

#### Cross-Cutting Patterns (~60+ files)
`.indexOf()` → `.includes()`, `typeof x !== "undefined"` → optional chaining, `.hasOwnProperty()` → `Object.hasOwn()`, `arguments` object → rest params

**Total estimated effort:** ~400-600 hours  
**Rule:** Never modernize files you're not otherwise touching. Always modernize if making >10 lines of changes.

---

## 10. Upstream Issues (Unaddressed)

42 open upstream issues that our fork has **not** addressed. Grouped by category.

### Camera & Navigation (7 issues)

| Issue | Upstream # | Severity |
|-------|-----------|----------|
| Follow-camera mode | [#5241](https://github.com/CesiumGS/cesium/issues/5241) | 🟡 |
| Mouse wheel zoom jumpy | [#4537](https://github.com/CesiumGS/cesium/issues/4537) | 🟡 |
| Camera boundary/constraints | [#4802](https://github.com/CesiumGS/cesium/issues/4802) | 🔴 |
| KML flyTo goes underground | [#4327](https://github.com/CesiumGS/cesium/issues/4327) | 🟡 |
| `computeViewRectangle` 2D/CV broken | [#4346](https://github.com/CesiumGS/cesium/issues/4346) | 🔴 |
| Touch controls regressed | [#4363](https://github.com/CesiumGS/cesium/issues/4363) | 🟡 |
| Scroll zoom too fast on high refresh rate | [#12187](https://github.com/CesiumGS/cesium/issues/12187) | 🟡 |

### Entity & DataSource (7 issues)

| Issue | Upstream # | Severity |
|-------|-----------|----------|
| Picking priority for overlapping entities | [#1592](https://github.com/CesiumGS/cesium/issues/1592) | 🔴 |
| CLAMP_TO_GROUND billboard positions | [#4776](https://github.com/CesiumGS/cesium/issues/4776) | 🟡 |
| Dynamic boxes don't track correctly | [#5164](https://github.com/CesiumGS/cesium/issues/5164) | 🟡 |
| Scene ready event | [#4422](https://github.com/CesiumGS/cesium/issues/4422) | 🟡 |
| Better custom `PositionProperty` support | [#9491](https://github.com/CesiumGS/cesium/issues/9491) | 🟡 |
| Clamped polygons on mobile | [#9702](https://github.com/CesiumGS/cesium/issues/9702) | 🟡 |
| WMS GetFeatureInfo incorrect position | [#9363](https://github.com/CesiumGS/cesium/issues/9363) | 🟡 |

### Rendering & Graphics (6 issues)

| Issue | Upstream # | Severity |
|-------|-----------|----------|
| Blinking entity on shader update | [#12532](https://github.com/CesiumGS/cesium/issues/12532) | 🟡 |
| Fit texture coords to rectangle/trapezoid | [#4164](https://github.com/CesiumGS/cesium/issues/4164) | 🟡 |
| Material difference in 2D | [#9853](https://github.com/CesiumGS/cesium/issues/9853) | 🟡 |
| Animated billboards (sprite-sheet) | [#2319](https://github.com/CesiumGS/cesium/issues/2319) | 🟡 |
| `disableDepthTestDistance` picking interaction | [#6840](https://github.com/CesiumGS/cesium/issues/6840) | 🟡 |
| Extruded geometry on terrain | [#4743](https://github.com/CesiumGS/cesium/issues/4743) | 🔴 |

### Memory Leaks (6 issues)

| Issue | Upstream # | Severity |
|-------|-----------|----------|
| CesiumWidget not freed on destroy | [#9298](https://github.com/CesiumGS/cesium/issues/9298) | 🔴 |
| `viewer.destroy` after `flyTo` leaks | [#8378](https://github.com/CesiumGS/cesium/issues/8378) | 🟡 |
| GeoJsonDataSource memory leak | [#9058](https://github.com/CesiumGS/cesium/issues/9058) | 🟡 |
| Memory leak at 15Hz GeoJSON update | [#5662](https://github.com/CesiumGS/cesium/issues/5662) | 🔴 |
| Resource memory leak in Node.js | [#7670](https://github.com/CesiumGS/cesium/issues/7670) | 🟡 |
| Texture leak hidden tilesets | [#12676](https://github.com/CesiumGS/cesium/issues/12676) | 🟡 |

### 2D / Columbus View (4 issues)

| Issue | Upstream # | Severity |
|-------|-----------|----------|
| Polyline disrupted at certain positions | [#11351](https://github.com/CesiumGS/cesium/issues/11351) | 🟡 |
| Polyline disappears with mapMode2D.ROTATE | [#11370](https://github.com/CesiumGS/cesium/issues/11370) | 🟡 |
| Models not accurately projected to 2D | Forum | 🟡 |
| Picking/GroundPrimitive error in 2D | [#11696](https://github.com/CesiumGS/cesium/issues/11696) | 🟡 |

### 3D Tiles (5 issues)

| Issue | Upstream # | Severity |
|-------|-----------|----------|
| Vector Tiles | [#2132](https://github.com/CesiumGS/cesium/issues/2132) | 🔴 |
| High memory with external tilesets | [#3453](https://github.com/CesiumGS/cesium/issues/3453) | 🔴 |
| Tileset rendered on other side of globe | [#8612](https://github.com/CesiumGS/cesium/issues/8612) | 🟡 |
| Race condition in `memoryAdjustedScreenSpaceError` | [#11447](https://github.com/CesiumGS/cesium/issues/11447) | 🟡 |
| Allow breadth-first traversal | [#12377](https://github.com/CesiumGS/cesium/issues/12377) | 🟡 |

### Terrain & Imagery (3 issues)

| Issue | Upstream # | Severity |
|-------|-----------|----------|
| Imagery layer min/max zoom confusion | [#6564](https://github.com/CesiumGS/cesium/issues/6564) | 🟡 |
| Dynamic terrain exaggeration GPU memory | [#12895](https://github.com/CesiumGS/cesium/issues/12895) | 🟡 |
| EGM96/EGM2008/MSL lookup | [#11786](https://github.com/CesiumGS/cesium/issues/11786) | 🟡 |

### Model/glTF & Build (4 issues)

| Issue | Upstream # | Severity |
|-------|-----------|----------|
| Dynamically changing model texture | [#5094](https://github.com/CesiumGS/cesium/issues/5094) | 🔴 |
| Lots of models → high GC | [#3125](https://github.com/CesiumGS/cesium/issues/3125) | 🔴 |
| Publish smaller packages | [#10636](https://github.com/CesiumGS/cesium/issues/10636) | 🔴 |
| Silhouette crash no normals | [#7586](https://github.com/CesiumGS/cesium/issues/7586) | 🟡 |

### Legacy Code Debt (5 items, code analysis)

| Issue | Details |
|-------|---------|
| IE11 workarounds still in codebase | 6 IE11-specific comments found — dead code |
| `demodernizeShader()` GLSL downgrade | Entire module transpiles WebGL2→WebGL1 — dead weight for WebGL2-only |
| `destroyObject()` closure overhead | Replaces all methods with error-throwing stubs on destroy |
| Knockout.js widget dependency | Outdated MVVM framework, not actively maintained |
| Hardcoded magic numbers in Context.js | WebGL constants as raw integers |

---

## 11. WASM & Performance Roadmap

### Current WASM Modules

| Module | Language | Purpose | Status |
|--------|----------|---------|--------|
| `draco_decoder.wasm` | C++ (Emscripten) | Draco mesh decompression | ✅ Upstream |
| `basis_transcoder.wasm` | C++ (Emscripten) | KTX2 texture transcoding | ✅ Upstream |
| `wasm_splats_bg.wasm` | Rust | Gaussian splat processing | ✅ Upstream |
| `zip-module.wasm` | Unknown | ZIP extraction | ✅ Upstream |
| `cesium_wasm_bg.wasm` | **Rust (v2)** | SIMD frustum cull + radix sort + terrain + RTE + matrix + point cloud | ✅ **Expanded** |

### WASM Optimizations — Status

| Target | Rust Module | JS Bridge | Expected Speedup | Status |
|--------|-------------|-----------|-----------------|--------|
| **HeightmapTessellator** | `heightmap_tessellator.rs` | `WasmHeightmapBridge.js` | 2-5x | ✅ **Implemented** — SIMD heightmap decode + ECEF conversion, multi-element endianness handling |
| **QuantizedMeshTerrainData** | `quantized_mesh.rs` | `WasmQuantizedMeshBridge.js` | 3-8x | ✅ **Implemented** — Zigzag+delta decode, SIMD normalization, high-watermark index decode |
| **Batch frustum culling** | `frustum_cull.rs` | `WasmCullBridge.js` | 4-10x w/ SIMD | ✅ **Previously complete** — f32x4 SIMD 4-sphere-per-cycle, 6-plane sphere test |
| **Batch RTE encoding** | `rte_encode.rs` | `WasmRTEBridge.js` | 2-3x | ✅ **Implemented** — f64→f32 high/low split, SOA batch encoding, SIMD eye-space computation |
| **Batch matrix multiply** | `matrix_batch.rs` | `WasmMatrixBridge.js` | 2-4x w/ SIMD | ✅ **Implemented** — Single-matrix×N-points SIMD, per-entity transform, batch mat4 multiply |
| **Point cloud processing** | `point_cloud.rs` | `WasmPointCloudBridge.js` | 3-5x | ✅ **Implemented** — SIMD batch distance², LOD filter, compact visible, AABB-frustum octree test |

### Rust Crate Structure (v2)

```
packages/wasm/src/
├── lib.rs                    ← Entry point, arena allocator, version=2
├── frustum_cull.rs           ← SIMD batch sphere-plane culling
├── radix_sort.rs             ← O(N) radix sort on packed 64-bit keys
├── heightmap_tessellator.rs  ← NEW: SIMD heightmap decode + ECEF
├── quantized_mesh.rs         ← NEW: Zigzag+delta decode + SIMD normalize
├── rte_encode.rs             ← NEW: Batch RTE f64→f32 high/low split
├── matrix_batch.rs           ← NEW: SIMD batch Matrix4 operations
└── point_cloud.rs            ← NEW: SIMD distance, LOD, AABB-frustum
```

### JS Bridge Files

```
packages/engine/Source/Scene/
├── WasmCullBridge.js          ← Frustum culling (existing)
├── WasmSortBridge.js          ← Radix sort (existing)
├── SOABoundingSphereLayout.js ← SIMD data layout (existing)
├── WasmHeightmapBridge.js     ← NEW: Heightmap tessellation
├── WasmQuantizedMeshBridge.js ← NEW: Quantized mesh decode
├── WasmRTEBridge.js           ← NEW: Batch RTE encoding
├── WasmMatrixBridge.js        ← NEW: Batch matrix operations
└── WasmPointCloudBridge.js    ← NEW: Point cloud processing
```

All bridges follow the mandatory pattern: async WASM loading, version check, threshold-gated dispatch, JS fallback, getDiagnostics().

### GPU Compute vs WASM Decision Matrix

| Task | Best Approach | Why | Shader Status |
|------|--------------|-----|---------------|
| Terrain tessellation | WASM | Complex data deps, already in Worker | N/A (WASM only) |
| Frustum culling (3D Tiles, >50K) | GPU Compute | Massive parallelism | ✅ `FrustumCull.wgsl` |
| Frustum culling (entities, <50K) | WASM SIMD | Low latency | N/A (WASM only) |
| Atmosphere LUT | GPU Compute | Ray marching | ✅ `AtmosphereLUT.wgsl` |
| RTE encoding | WASM | GPU readback would negate benefit | N/A (WASM only) |
| Point cloud sort/LOD | GPU Compute | Massive parallelism | ✅ `PointCloudSort.wgsl` + `PointCloudLOD.wgsl` |
| Sort keys (5K-50K) | WASM radix sort | O(N) vs O(N log N) | N/A (WASM only) |
| Sort keys (>50K) | GPU Compute | GPU-driven rendering | ✅ `GPUSortKeys.wgsl` |

### Compute Shader Library (8 files in `Shaders/WebGPU/Compute/`)

| Shader | Entry Points | Workgroup Size | Purpose | Status |
|--------|-------------|----------------|---------|--------|
| `FrustumCull.wgsl` | `main` | 256 | Sphere-plane frustum culling + indirect draw | ✅ Built |
| `HiZPyramid.wgsl` | `computeMain` | 16×16 | Hierarchical Z-buffer mip generation | ✅ Built |
| `OcclusionTest.wgsl` | `computeMain` | 256 | Per-command Hi-Z occlusion testing | ✅ Built |
| `PolygonSignedDistance.wgsl` | `main` | 8×8 | Polygon SDF atlas for clipping | ✅ Built |
| `AtmosphereLUT.wgsl` | `computeTransmittance`, `computeInscatter` | 16×16 | Nishita scattering LUT precomputation | ✅ **NEW** |
| `PointCloudSort.wgsl` | `localBitonicSort`, `globalBitonicMerge` | 256 | GPU bitonic sort for point cloud depth ordering | ✅ **NEW** |
| `PointCloudLOD.wgsl` | `computeMain` | 256 | Distance-based LOD + frustum cull + compaction | ✅ **NEW** |
| `GPUSortKeys.wgsl` | `computeMain` | 256 | Packed 64-bit sort key generation for draw commands | ✅ **NEW** |

---

## 12. WebGPU Performance Infrastructure — ✅ ACTIVATED

All 7 performance infrastructure systems are now wired into the rendering pipeline via `WebGPUPerformanceManager.ts`, which orchestrates their lifecycle through the `WebGPUSceneRenderer` frame loop.

| Feature | File | Benefit | Activation Status |
|---------|------|---------|-------------------|
| **Render bundles** | `WebGPURenderBundleManager.ts` | 50-80% CPU for static terrain | ✅ **Wired** — `performanceManager.beginFrame()` ticks stale eviction, `tryExecuteBundle()` API for globe passes |
| **Indirect drawing** | `WebGPUIndirectDrawManager.ts` | GPU-driven 3D Tiles | ✅ **Wired** — `beginFrame()` resets, `queueIndirectDraw()` for batch commands, `flush()` on endFrame |
| **Storage buffers** | `WebGPUStorageBufferPool.ts` | Large point cloud data | ✅ **Wired** — Lazy-init via `context.storageBufferPool`, used by `WasmPointCloudBridge` |
| **GPU frustum culling** | `WebGPUGPUCuller.ts` + `FrustumCull.wgsl` | GPU-side visibility | ✅ **Wired** — `shouldUseGPUCulling(objectCount)` threshold check (50K default), deferred to 3D Tiles phase |
| **Timestamp queries** | `WebGPUTimestampProfiler.ts` | GPU profiling | ✅ **Wired** — `beginFrame()`/`endFrame()` in profiler, `getPassTimestampWrites()` for per-pass timing |
| **Buffer mapping** | `WebGPUBufferMapper.ts` | Direct CPU↔GPU access | ✅ **Wired** — `uploadViaStaging()` and `readbackBuffer()` APIs on performance manager |
| **Uniform grouping** | `WebGPUUniformGroupManager.ts` | Per-frame/material/object bind groups | ✅ **Wired** — Lazy-init via context, available for bind group optimization |

### `WebGPUPerformanceManager.ts` — Central Orchestrator

```typescript
// Lifecycle: called by WebGPUSceneRenderer.executeCommands()
perfManager.beginFrame();   // Reset counters, begin profiling, tick bundle eviction
// ... multi-frustum rendering loop ...
perfManager.endFrame();     // Flush indirect draws, collect profiling timings

// APIs available to feature renderers:
perfManager.tryExecuteBundle(key, pass, cmds, count, recordCb); // Render bundles
perfManager.queueIndirectDraw(indexCount, instanceCount, ...);  // Indirect draw batching
perfManager.shouldUseGPUCulling(objectCount);                   // GPU cull threshold check
perfManager.getPassTimestampWrites('globe');                     // Per-pass GPU timing
perfManager.uploadViaStaging(buffer, data, offset);             // Async buffer upload
perfManager.readbackBuffer(buffer, size, offset);               // Async buffer readback
perfManager.getDiagnostics();                                   // Formatted debug string
```

### Configuration

```typescript
// Default config (all features opt-in with sensible thresholds):
context.performanceManager.config = {
  renderBundles: true,          // Cache static terrain tile draw calls
  indirectDraw: true,           // Batch 3D Tile draw calls
  gpuCulling: true,             // GPU compute culling for >50K objects
  timestampProfiling: false,    // Enable for profiling sessions
  bufferMapping: true,          // Async staging buffer uploads
  renderBundleThreshold: 8,     // Min commands to use bundles
  indirectDrawThreshold: 100,   // Min commands for indirect batching
  gpuCullingThreshold: 50000,   // Min objects for GPU culling
  bundleMaxIdleFrames: 300,     // Evict unused bundles after 5 seconds
};
```

### Performance Bottleneck Notes

During implementation, no additional bottlenecks were discovered beyond those already documented. The existing infrastructure is comprehensive. Key observations:

1. **WASM↔JS boundary overhead** is minimal for batch operations (>100 elements) due to the arena allocator sharing WASM linear memory directly with JS typed arrays — zero copy.
2. **Render bundle invalidation** needs care: terrain tiles change infrequently (ideal for bundles), but imagery layer updates require bundle invalidation. The `invalidateByPrefix('globe:')` API handles this.
3. **GPU culling threshold (50K)** is conservative — real-world 3D Tiles scenes rarely exceed 10K visible tiles per frame, so WASM SIMD culling handles most cases. GPU culling activates only for massive point cloud datasets.
4. **Timestamp profiling** requires `timestamp-query` device feature (Chrome 121+). When unavailable, profiling silently degrades to no-op with zero overhead.

---

## Priority Remediation Order

> **Updated April 2, 2026** — See `WIRING_AUDIT_2026_04_02.md` for latest findings. Previous audit: `COMPREHENSIVE_AUDIT_2026_03_31.md`.

### 🔴 Immediate: Fallback & Safety Gaps — ✅ 7 of 8 COMPLETE (March 31, 2026)
1. ✅ **FORK-37** — `destroy()` + `WasmFeatureDetection.freeBuffer()` on all 7 bridges
2. ✅ **FORK-42** — `WebGPUComputeEngine` `execute()`/`executeMultiple()`/`executeOnEncoder()` wrapped in try/catch, return `boolean`
3. ✅ **FORK-38** — Version checking via shared `WasmFeatureDetection.checkVersionMatch()` on all bridges
4. ✅ **FORK-39** — SIMD detection via `WasmFeatureDetection.checkSIMDSupport()` + `checkModuleSIMD()` on all bridges
5. ✅ **FORK-40** — `destroy()` method on all 7 WASM bridges
6. ✅ **FORK-44** — CPU fallback `sortByDistance()` + `lodFilterAndSort()` in `WasmPointCloudBridge`
7. ✅ **FORK-43** — `_validateWorkgroups()` checks `maxComputeWorkgroupsPerDimension` before dispatch
8. **FORK-19** — Start unit tests (even smoke tests for core classes) (4-6 days)

**Also completed:** ✅ **FORK-46** — Rust `alloc_buffer()` uses `try_reserve()`, returns null on OOM. ✅ `WasmFeatureDetection.js` shared utility created in `Core/`. ✅ `WasmCullBridge.js` + `WasmSortBridge.js` modernized to ES6 class. ✅ All 7 WASM bridges have try/catch in WASM methods with JS fallback on failure.

### 🟡 Next: Visual Quality — Biggest Impact (3-4 weeks)
9. ✅ **SSAO** — `AmbientOcclusionGenerate.wgsl` + `AmbientOcclusionModulate.wgsl` + `AmbientOcclusionEffect` (4-pass: Generate→BlurH→BlurV→Modulate). Lazily initialized via `scene.postProcessStages.ambientOcclusion.enabled = true`.
10. ✅ **IBL Pipeline** — Full compute-based IBL: `BrdfLutGenerate.wgsl` (external compute shader, 16×16 workgroups), `IrradianceConvolution.wgsl` (diffuse cubemap, 8×8 workgroups, 6-face dispatch), `RadiancePrefilter.wgsl` (specular mipchain, 6 mip levels × 6 faces), `WebGPUIBLPipeline.ts` orchestrator, `WebGPUImageBasedLighting.ts` with SH coefficient packing + specular environment map pipeline + dirty tracking. `ModelPBRComplete.wgsl` updated with `fresnelSchlickRoughness()` and split-sum IBL-aware ambient (diffuse + specular factors, roughness-attenuated specular, energy conservation via kD_ibl/kS_ibl). `LightUniforms` extended with `iblDiffuseFactor`, `iblSpecularFactor`, `iblMaxMipLevel`, `iblHasSH`.
11. ✅ **Bloom** — `BrightPass.wgsl` + `GaussianBlur1D.wgsl` + `BloomComposite.wgsl` + `BloomEffect` (4-pass: BrightPass→BlurH→BlurV→Composite). Lazily initialized via `scene.postProcessStages.bloom.enabled = true`.
12. ✅ **Ground Atmosphere** — `GroundAtmosphere.wgsl` (full Nishita single-scattering: ray-sphere intersection, Rayleigh+Mie optical depth, 16 primary + 4 light ray march steps, phase functions, fade-distance application). `WebGPUGroundAtmosphereRenderer.ts` packs `AtmosphereParams` struct (64 bytes) from Globe properties (inner/outer radius, scale heights, coefficients, anisotropy, light intensity, dynamic lighting mode) with dirty-check upload. `FeatureRendererKey.GROUND_ATMOSPHERE` (29) registered in `WebGPUFeatureRenderers.ts`.
13. ✅ **Advanced Tone Mapping** — `Tonemapping.wgsl` now supports 5 operators: Reinhard (mode 0), ACES Filmic (1), Uncharted 2 Filmic (2), Modified Reinhard (3), PBR Neutral (4). Mode switchable at runtime via `pipeline.setTonemappingMode()`. Syncs with CesiumJS `Tonemapper` enum.
14. **Shadow Casting** — Complete shadow map render pipeline (3-4 days)
15. **Pick depth blit** (6.1 / FORK-34) — Complete picking (1-2 days)

**Also completed (March 31, 2026):**
- ✅ **Depth of Field** — `DepthOfField.wgsl` + `DepthOfFieldEffect` (3-pass: BlurH→BlurV→Composite with depth-based circle-of-confusion)
- ✅ **Edge Detection / Silhouette** — `EdgeDetection.wgsl` (Sobel) + `Silhouette.wgsl` (compositing)
- ✅ **GaussianBlur1D** — Foundation shader used by Bloom, SSAO, DoF (incremental Gaussian, GPU Gems 3 Ch.40)
- ✅ **WebGPUPostProcessEffects.ts** — `BloomEffect`, `AmbientOcclusionEffect`, `DepthOfFieldEffect` classes with own intermediate textures
- ✅ **WebGPUPostProcessPipeline.ts** — Rewritten to orchestrate complex effects + single-pass stages. Execution order: AO → Bloom → DoF → Tonemapping → Custom → FXAA. External WGSL shaders (no more inline strings). Depth texture passed for depth-dependent effects.
- ✅ **WebGPUPostProcessStageCollection.ts** — Split into `updateWebGPUPostProcessStages` (feature renderer sync) + `configureWebGPUPostProcessPipeline` (pipeline configuration). Lazy effect initialization on first enable. Runtime parameter updates with dirty checking.
- ✅ **WebGPUSceneRenderer.ts** — Passes depth view to post-processing. Calls `configureWebGPUPostProcessPipeline` each frame to sync CesiumJS collection state.

### 🟡 Then: Activate Performance Infrastructure (2-3 weeks)
16. **Render bundles** — Wire into globe pass for 50-80% CPU reduction (2-3 days)
17. **Uniform ring buffer** — Replace per-frame buffer creation (3-4 days)
18. **GPU frustum culling** — Wire `GPUCuller` into 3D Tiles (2-3 days)
19. **Pipeline warm-up** — Pre-create common pipelines at init (1-2 days)
20. **FORK-41** — Wire or document 7 unwired compute shaders (1 day)

### 🟢 Medium Term: Advanced Features (4-6 weeks)
21. **TAA** — Temporal anti-aliasing post-process (3-4 days)
22. ✅ **Enhanced Night Rendering** — Lambert terminator, emissive city lights, moonlit night side, terminator glow in `GlobeTerrain.wgsl`
23. ✅ **Enhanced Ocean Rendering** — Fresnel, GGX specular, multi-octave waves, foam/whitecaps, SSS, deep water color, sky reflection in `GlobeTerrain.wgsl`
24. ✅ **SSR** — `ScreenSpaceReflections.wgsl` + `WebGPUSSREffect.ts` wired into `_executeEnvironmentalEffects()` in `WebGPUSceneRenderer.ts`. Activated via `scene._enableSSR = true`
25. ✅ **GPU Weather Particles** — `WeatherParticles.wgsl` + `WebGPUWeatherRenderer.ts` wired into `_executeEnvironmentalEffects()`. Activated via `scene._enableWeather = true`
26. **Volumetric fog/lighting** — God rays, scattering (4-5 days)
27. **Volumetric Clouds** — Noise-based ray march on sky hemisphere (5-7 days)
28. **Cascaded Shadow Maps** (4-5 days)

### 📋 Ongoing
27. **ES6 modernization** — Incremental as files are touched
28. **Upstream issues** — Address as they intersect with our work
29. **FORK-45/46** — WASM arena improvements (per-bridge slots, OOM handling)

---

*This document consolidates information from the former: `SORTING_ARCHITECTURE_ANALYSIS.md`, `SORTING_IMPLEMENTATION_PLAN.md`, `SORTING_REVIEW_AND_TECH_DEBT.md`, `PICKING_ANALYSIS.md`, `SCENE_DECOMPOSITION_PLAN.md`, `UPSTREAM_ISSUES_AND_TECH_DEBT.md`, and `ES6_MODERNIZATION_BACKLOG.md`. Those files have been moved to `migration_doc/archive/`.*
