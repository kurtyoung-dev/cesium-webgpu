# CesiumJS WebGPU Migration -- Consolidated Status

**Last Updated:** April 7, 2026 (Sessions 1-26, post-consolidation of WIRING_AUDIT_2026_04_02 + COMPREHENSIVE_AUDIT_2026_03_31 + WEBGPU_DEBUGGING_LOG)
**Repository:** Fork of [CesiumGS/cesium](https://github.com/CesiumGS/cesium) -> [kurtyoung-dev/cesium-webgpu](https://github.com/kurtyoung-dev/cesium-webgpu)
**Overall Progress:** ~88% of full WebGL feature parity. Globe terrain renders in production with imagery, shadows, fog, atmosphere, ocean, day/night, and clipping; all 36 feature renderers registered; 13 of 13 render passes handled; 10 Jasmine spec files; debug visualization stack complete.

---

## Table of Contents

1. [Architecture](#1-architecture)
2. [Completed Work](#2-completed-work)
3. [What Works End-to-End (Verified)](#3-what-works-end-to-end-verified)
4. [Bug Fix History (Sessions 1-26)](#4-bug-fix-history-sessions-1-26)
5. [WASM & Compute Audit Results](#5-wasm--compute-audit-results)
6. [Render Pass Coverage](#6-render-pass-coverage)
7. [Industry Comparison](#7-industry-comparison)
8. [Relationship with Upstream CesiumJS](#8-relationship-with-upstream-cesiumjs)
9. [Reference](#9-reference)

> **For the full detailed backlog of remaining work, see `WEBGPU_MIGRATION_BACKLOG.md`.**

---

## 1. Architecture

### High-Level Flow

```
User Code: new Cesium.Viewer('container', { contextOptions: { renderer: 'webgpu' } })
  +-- Viewer.createAsync() -> shows LoadingOverlay
      +-- CesiumWidget.createAsync() -> Scene.createAsync()
          |-- ContextFactory.createContext() -> WebGPUContext.create() (async GPU adapter/device)
          |-- Shader init in WebGPUContext._initialize() -> imports .wgsl JS wrappers
          +-- Matrix4.setDepthRangeType('webgpu') -> 0-1 NDC depth range

Rendering: Scene.render() -> uniformState.update() -> per-View context update -> Primitive.update()
  |-- WebGL path (existing, untouched)
  +-- WebGPU path:
      |-- Feature renderer via context.getFeatureRenderer(FeatureRendererKey.XXX)
      |-- createWebGPUCommands() -> builds GPU pipelines/buffers
      |-- updateWebGPUCommandUniforms() -> per-frame RTE camera matrices
      +-- executeCommand() -> WebGPUDrawCommand.execute(renderPass)
```

### Core Design Principles

1. **Preserve WebGL functionality** -- WebGL rendering must continue to work. We modify upstream files when it improves architecture (e.g., `Context.js` -> ES6 class + `extends GraphicsContext`), but never break existing behavior.
2. **Backend agnosticism** -- `GraphicsContext` is an abstract base class. Scene code accesses renderers via `context.getFeatureRenderer(FeatureRendererKey.XXX)`, not direct imports. **Zero `isWebGPUDrawCommand` / direct WebGPU imports remain in Scene code** (Session 16 cleanup).
3. **Async-first for WebGPU** -- WebGPU is an async renderer. All GPU readback (depth picking, buffer reads, texture reads) uses async patterns (`mapAsync`, `.then()`, Promises). No sync GPU reads in render loops.
4. **Configuration-based** -- `renderer: 'webgpu'` opt-in, WebGL default. Feature detection falls back to WebGL.
5. **RTE everywhere** -- All WebGPU rendering uses Relative-To-Eye 64-bit emulated precision for planetary-scale accuracy.
6. **Multi-context support** -- `ContextRegistry` tracks all active contexts. Each `View` can target a different `GraphicsContext`. `FrameState.context` updated per-view before each render pass.
7. **WebGL2 only** -- Our fork targets WebGL2 + WebGPU (2 paths), not WebGL1 + WebGL2 + WebGPU (3 paths).

### Backend-Agnostic Architecture (Phases A-G Complete)

```
GraphicsContext (abstract base class)
  |-- id, rendererType, isWebGPU/isWebGL (per-instance)
  |-- log(level, message) -> [CesiumJS:type:shortId] prefix
  |-- registerFeatureRenderer() / getFeatureRenderer()  (O(1) array indexed by FeatureRendererKey enum)
  |-- registerFeatureRendererLoader() (lazy loaders for code-split renderers)
  |-- ContextRegistry (static) -- tracks all active contexts
  |-- 5 concrete command dispatch methods (WebGL defaults, WebGPU overrides)
  |-- Abstract compute capability API (supportsComputeShaders, supportsStorageBuffers, etc.)
  |-- Context.js (WebGL) extends GraphicsContext
  +-- WebGPUContext.ts (WebGPU) extends GraphicsContext

View (per-view context)
  |-- optional graphicsContext constructor param
  |-- effectiveContext -> per-view override OR Scene's default
  +-- scene.createView(camera, viewport, { graphicsContext })

FrameState
  |-- context / graphicsContext -- updated per-view before render
  +-- Matches how CesiumJS already updates frameState.camera per view
```

**Feature Renderer Pattern** (Phase D -- 36 of 36 keys registered):
```javascript
import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";
const fr = context.getFeatureRenderer(FeatureRendererKey.POINT_PRIMITIVE_COLLECTION);
if (fr) { fr.update(this, frameState); return; }
// WebGL code follows as default fallback
```

**Scene.js Backend Agnosticism** (Complete): 5 concrete methods on `GraphicsContext` with WebGL-default behavior. `WebGPUContext` overrides each. Zero `isWebGPUDrawCommand` checks remain in Scene code (Session 16 cleanup replaced all with duck-typing via `defined(command._webgpuShaderType)` / `typeof cmd.execute === "function"` / `defined(cmd.pipeline)`).

### File Organization

```
packages/engine/Source/Renderer/
|-- GraphicsContext.ts          <- Abstract base class
|-- ContextRegistry.ts          <- Multi-context tracking
|-- ContextFactory.ts           <- Async factory with fallback
|-- Context.js                  <- WebGL (extends GraphicsContext)
+-- WebGPU/                     <- 105+ files (~46,000 LOC)
    |-- WebGPUContext.ts         (core, ~3,010 lines)
    |-- WebGPUFeatureRenderers.ts (central registration of 36 renderers + lazy loaders)
    |-- WebGPUSceneRenderer.ts   (multi-frustum, all 13 passes, ~1,400 lines)
    |-- WebGPUGlobeSurfaceRenderer.ts (~2,100 lines)
    |-- WebGPUPerformanceManager.ts (~960 lines, 7 perf systems orchestrator)
    |-- WebGPUNagaTranspiler.ts  (NEW S26: optional GLSL->WGSL via naga-wasm)
    |-- Feature renderers, caching, resources, commands, debug overlays, stubs

packages/engine/Source/Shaders/WebGPU/    <- 238+ .wgsl files
packages/engine/Source/Scene/             <- Modified scene files + decomposed modules
Apps/WebGPUTest/                           <- 29 test/demo pages
migration_doc/                             <- This documentation
```

---

## 2. Completed Work

### Architectural Improvements to Upstream Files

| File Modified | Change | Why |
|--------------|--------|-----|
| `Context.js` | ES6 class + `extends GraphicsContext` | Enables shared abstract base |
| `View.js` | Optional `graphicsContext` param, `effectiveContext` getter | Per-view backend selection |
| `Scene.js` | `graphicsContext`/`contextRegistry` getters, `createView()`, per-view context updating, **decomposed into 8 modules**, debug visualization flags forwarded to frameState | Backend-agnostic facade |
| `FrameState.js` | `graphicsContext` alias for `context` | Backend-agnostic access |
| `Matrix4.js` | `setDepthRangeType('webgpu')` | 0-1 NDC depth |
| `Viewer.js` | `_preInitializedScene` forwarded to CesiumWidget | Async WebGPU init path |
| `CesiumWidget.js` | `_preInitializedScene` consumer | Skip sync Scene creation when async-built |

### Infrastructure Layer (105+ files, ~46,000 LOC)

| Category | Key Components |
|----------|----------------|
| **Core Context** (7) | `WebGPUContext.ts`, `GraphicsContext.ts`, `ContextRegistry.ts`, `ContextFactory.ts`, `SharedResourcePool.ts`, `OffscreenContextSupport.ts`, `WebGPUDevicePool.ts` |
| **Resources** (11) | Buffer, Texture, Texture3D, CubeMap, CubeMapFace, TextureAtlas, Sampler, RenderTarget, MipmapGenerator, TextureArray, TextureUtilities |
| **Pipeline & Shaders** (8) | RenderPipelineCache, ShaderModule, ShaderCache, PipelineDescriptorBuilder, WGSLShaderPreprocessor, WGSLBuiltins, AutoUniforms, **NagaTranspiler** |
| **Commands & Rendering** (5) | DrawCommand, ComputeCommand, ComputeEngine, SceneRenderer, PassState |
| **Framebuffers** (8) | FramebufferManager, SceneFramebuffer, MultisampleFramebuffer, GlobeDepth, DepthPlane, PickFramebuffer, etc. (transient attachments wired via `TRANSIENT_ATTACHMENT` feature detection) |
| **Feature Renderers** (15+) | Globe, Primitive, Billboard, Point, Polyline, Cloud, Model, SkyAtmosphere, Sun, Moon, Label (SDF), BufferPrimitive (polygon/polyline/point), Voxel, GaussianSplat, GroundAtmosphere, etc. |
| **Post-Processing** (7) | PostProcessPipeline, PostProcessEffects (Bloom, SSAO, DoF), Tonemapping, FXAA, Edge, Silhouette |
| **Performance** (7) | PerformanceManager, RenderBundleManager, IndirectDrawManager, GPUCuller, TimestampProfiler, BufferMapper, UniformGroupManager |
| **Stubs/Compat** (6) | WebGLStubBuffer, WebGLStubTexture (real generateMipmap dispatch via `WebGPUMipmapGenerator`), WebGLStubFramebuffer, WebGLStubPipelineState, WebGLStubShader (lazy GLSL capture + naga-wasm hookup), WebGLStubTypes |
| **Model** (4) | ModelRenderer, ModelPipelineCache, ModelInstancing, ModelFeatureId |
| **IBL/Lighting** (4) | IBLPipeline, ImageBasedLighting, GroundAtmosphere, EffectsBindGroup |
| **Debug Overlays** (3) | DebugDepthOverlay, PrimitiveIndexUtils, augmented globe debug fragment pipeline cache |

### WGSL Shader Library (238+ files)

| Category | Count | Details |
|----------|-------|---------|
| Primitive shaders | 28 | PerInstanceColor (flat/lit/pick/ID), Material variants, PBR |
| Collection shaders | 8 | Point, Billboard, Polyline, Cloud, BillboardCollectionSDF (NEW S18), BufferPolygon/Polyline/Point material |
| Environment | 3 | SkyAtmosphere (with `useLut` fast path + `debug` vec4), Sun, Moon |
| Globe/Terrain | 1 | GlobeTerrain.wgsl (full-featured: imagery layers, day/night, ocean, fog, shadows, clipping, 2D/Columbus View, scene-mode branching, debug fields) |
| Struct/Function chunks | 97 | 91 functions + 6 structs (CsmBuiltins.js); includes new `csm_primitiveIndex.wgsl` |
| PostProcess | 12 | Tonemapping (5 modes), FXAA, SSAO, Bloom, DoF, Edge, Silhouette, OIT |
| Compute | 12 | FrustumCull (with `mainSubgroups` variant), HiZ, OcclusionTest, PolygonSDF, AtmosphereLUT (dispatch wired), PointCloudSort/LOD (LOD has `computeMainSubgroups` variant), GPUSortKeys, IBL (3), WeatherParticles, WeatherParticleRender |
| Model | 1 | ModelPBRComplete.wgsl (7 bind groups, 19 material flag bits) |
| Advanced | 10+ | PointCloud, Voxel, GaussianSplat, InvertClassification, GroundAtmosphere, SSR, ProceduralClouds, WeatherParticles, DeferredGBuffer/Lighting, ViewportQuad/ViewportQuadTexture |

### Scene Features -- What Renders

| Feature | Status | Key Details |
|---------|--------|-------------|
| **Globe/Terrain** | **Verified Working** | Uncompressed + quantized terrain (BITS12), unlimited imagery layers, **full shader (Session 17)**: Lambert diffuse lighting, day/night alpha blending with night lights emission, terminator glow, fog with atmosphere-colored blending, shadow receive (PCF), clipping planes with edge highlights, cartographic limit clipping, enhanced ocean (Fresnel, deep water, foam, wave normals, GGX specular, subsurface scattering, sky reflection), water mask. texCoordsRect alpha masking (S15). Multi-LOD rendering (S15). 2D/Columbus View modes (S18). Debug overlays: triangulation, LOD, normals, imagery isolation, depth-as-color, wireframe (S22-24). |
| **Primitive** (flat/lit/pick) | Built | 20 shader variants, RTE, geometry data preservation |
| **PointPrimitive** | Built | Instanced quads, RTE |
| **Billboard** | Built | Instanced quads, atlas textures, RTE |
| **Label** | **Built (S18)** | `WebGPULabelRenderer` registered as `LABEL_COLLECTION` FR (key 36) — SDF text with 5-tap supersampling, outlines, screen-space derivative AA. WebGL fallback preserved. |
| **Polyline** | Built | Screen-space thick lines, per-segment quads, AA |
| **SkyAtmosphere** | **Working + LUT consumer (S26)** | Nishita scattering with Rayleigh + Mie, HSB correction, debug bypass (`debugDisableAtmosphereScattering`). New `useLut` fast path samples precomputed inscatter LUT instead of per-pixel ray march when `WebGPUPerformanceManager.dispatchAtmosphereLUT` has run; falls back to ray march when compute unavailable. |
| **GroundAtmosphere** | Wired (Session 17) | `Globe.js beginFrame()` calls FR; uniform buffer with packed atmosphere parameters |
| **Sun** | Built | Procedural texture, billboard quad |
| **Moon** | Built | UV sphere mesh, textured diffuse lighting, full RTE |
| **Fog** | **Working** | Parameters wired via tile uniform buffer + full shader fog blending (Session 17) |
| **SkyBox/CubeMapPanorama** | Fixed (Session 16) | Cubemap loads and renders. `panoramaCommandList` accumulation bug fixed. Per-face debug isolation (`debugShowCubeMapFace`) added S23. |
| **Model/glTF** | Built | PBR, morph targets, skinning, GPU instancing, feature ID textures, batch table styling |
| **3D Tiles** | Built | Works via Model chain. Zero 3D Tiles code changes needed. Optional indirect-draw fast path added S26 (`context.useIndirectDrawForTiles` flag, `executeBatchIndirect` groups homogeneous runs through `WebGPUIndirectDrawManager.submitBatch`). |
| **Materials System** | Built | All 25 built-in materials mapped to WGSL |
| **Pick System** | **Working** | Async depth readback with staleness validation + distance ratio rejection. Camera jitter significantly reduced (S16). All 3 collection renderers + globe surface support pick. Buffer Primitive picking landed S20 via shader-variant pick pipelines. |
| **Particles (weather)** | **Built (S18)** | GPU compute particle simulation + render pass. 4 weather types (rain/snow/fog/hail). Camera-facing instanced quads. |
| **Particles (general)** | Auto-supported | Delegates to BillboardCollection (confirmed S20) |
| **Viewport Quad** | **Built (S18)** | `WebGPUViewportQuad` utility integrated into `WebGPUContext.createViewportQuadCommand`. Pipeline + bind group caching, 3-vertex fullscreen triangle pattern, blend/depth/stencil configurable. |
| **Buffer Primitives (vector tile)** | **Built (S19)** | `WebGPUBufferPrimitiveRenderer.ts` (~1465 lines) implements polygon (indexed triangle-list), polyline (indexed miter-quad expansion), point (instanced quads). Picking added S20. |
| **2D / Columbus View** | **Built (S18)** | Globe terrain shader branches on `camera.sceneMode` (MORPHING/COLUMBUS_VIEW/SCENE2D/SCENE3D). Camera UBO extended with `tileRectangle`, `southAndNorthLatitude`, `southMercatorYAndOneOverHeight`, `sceneMode`, `morphTime`, `useWebMercator`. Helper functions: `latitudeToWebMercatorFraction`, `get2DYPositionFraction`, `computePlanarPosition`. |
| **WebGPU Compatibility mode** | Built (S17) | `renderer: "webgpu-compat"` with `featureLevel: "compatibility"` |

### Feature Renderer Registration (36 of 37)

| Status | Count | Details |
|--------|-------|---------|
| Registered + Scene-wired (Phase D) | 31 | Fully functional FR pattern |
| Registered + Scene-wired (Session 17) | +5 | FOG (via tile UB), GROUND_ATMOSPHERE (Globe.js beginFrame), SSR/WEATHER_PARTICLES/PROCEDURAL_CLOUDS (WebGPUSceneRenderer._executeEnvironmentalEffects) |
| Registered (Session 18) | LABEL_COLLECTION (key 36) | `WebGPULabelRenderer` with SDF text path |
| Registered (Session 19) | BufferPolygon/Polyline/Point | Replace v1.140 vector tile no-op stubs |
| Lazy-loaded via `registerFeatureRendererLoader` | 7 | GAUSSIAN_SPLAT, POINT_CLOUD, POINT_CLOUD_EDL, VOXEL_PRIMITIVE, SCREEN_SPACE_REFLECTIONS, WEATHER_PARTICLES, PROCEDURAL_CLOUDS — dynamic import on first frame, ~290 KB shaved from default bundle |
| NOT registered | 1 | DEFERRED_GBUFFER (key defined but never implemented) |

### Sorting System (11 phases, 30+ files)

| Component | Status |
|-----------|--------|
| Foundation types (SortMode, RenderLayer, RenderLayerCollection) | Complete |
| Structured sort properties on DrawCommand/WebGPUDrawCommand | Complete |
| MaterialSortIdAllocator | Complete |
| Scene.js multi-level comparators | Complete |
| RenderScheduler orchestrator + full layer execution (SORT-FULL) | Complete |
| Entity `renderPriority` -> Visualizer -> Collection -> DrawCommand wiring | Complete |
| Geometry batch priority grouping | Complete |
| SceneOctree + OctreeNode (spatial acceleration) | Built, opt-in via `scheduler.octree.enabled = true` |
| OcclusionCulling wiring | Built, opt-in (WebGPU-only, conservative fallback) |
| WASM culling/sorting bridges (JS fallback + Rust crate) | Built (17.2 KB binary) |
| Hi-Z occlusion culling shaders + manager | Built (WebGPU only, not yet wired into ViewportExecutor) |

### Picking System

**What works end-to-end:**
- `WebGPUPickFramebuffer.ts` -- full implementation with async readback
- `WebGPUSceneRenderer._executePickPass()` -- renders GLOBE/3D_TILE/OPAQUE/TRANSLUCENT passes
- All 3 collection renderers (Billboard, Point, Polyline) support pick
- `PickDepth.js` -- async readback via staging buffer + `mapAsync`
- Staleness validation -- PlayCanvas-style camera state validation on async resolve
- Pick ID consolidated in `GraphicsContext`
- Globe depth copy pipeline + async readback (FORK-34 — was already complete, never crossed off)
- Buffer Primitive collections pick path (S20)

### WASM Bridges (7 of 7 Complete)

All 7 bridges (`WasmCullBridge`, `WasmSortBridge`, `WasmHeightmapBridge`, `WasmQuantizedMeshBridge`, `WasmRTEBridge`, `WasmMatrixBridge`, `WasmPointCloudBridge`) implement every `.clinerules` mandate:

| Requirement | Status | Implementation |
|---|---|---|
| `destroy()` method | Complete | All bridges expose destroy + `_isDestroyed` guard |
| `free_buffer()` | Complete | Called in destroy |
| Version check | Complete | `WasmFeatureDetection.checkVersionMatch()` (Rust returns `version() = 2`) |
| SIMD detection | Complete | `WasmFeatureDetection.checkSIMDSupport()` + `checkModuleSIMD()` shared utility |
| JS fallback | Complete | Every bridge has full JS implementation; bridges fall back on WASM init failure |
| Error handling | Complete | try/catch in WASM dispatch methods with automatic JS fallback |
| OOM handling | Complete | Rust `lib.rs` uses `try_reserve()` + null pointer (0) on OOM (FORK-46) |

### Compute Shader Engine

`WebGPUComputeEngine.execute()`, `executeMultiple()`, `executeOnEncoder()` all wrapped in try/catch (return `false` on failure), `_validateWorkgroups()` checks `device.limits.maxComputeWorkgroupsPerDimension` before dispatch, pipeline caching by shader source key (FORK-42, FORK-43, FORK-44).

### Performance Infrastructure (All Wired)

| Feature | File | Benefit | Status |
|---------|------|---------|--------|
| Render bundles | `WebGPURenderBundleManager.ts` | 50-80% CPU for static terrain | **Activated** (Session 16) -- Globe pass uses bundle encoder for 8+ tiles |
| Indirect drawing | `WebGPUIndirectDrawManager.ts` | GPU-driven 3D Tiles | **Wired** + `submitBatch`/`executeBatchIndexed` API. Opt-in fast path in scene renderer (S26) via `context.useIndirectDrawForTiles` flag |
| Storage buffers | `WebGPUStorageBufferPool.ts` | Large point cloud data | Wired |
| GPU frustum culling | `WebGPUGPUCuller.ts` + `FrustumCull.wgsl` | GPU-side visibility | **Activated** (Session 17) -- Lazy-init via `context.gpuCuller`, 256-command threshold, async readback. Subgroup variant added S20 (`mainSubgroups` entry point with try/catch fallback). |
| Timestamp queries | `WebGPUTimestampProfiler.ts` | GPU profiling | Wired |
| Buffer mapping | `WebGPUBufferMapper.ts` | Async CPU<->GPU access | Wired |
| Uniform grouping | `WebGPUUniformGroupManager.ts` | Per-frame/material/object bind groups | Wired |
| Ring buffer allocator | `WebGPURingBufferAllocator` | Reduce per-frame buffer creation | **Activated** (Session 16) -- 4MB pages, triple-buffered, 256-byte alignment |
| Pipeline warm-up | `_warmUpPipelines()` in WebGPUContext | No first-frame stutter | **Activated** (Session 17) -- Globe renderer + GPU culler pre-initialized at context creation |

### Compute Shader Activation Status

| Shader | Status | Activation Trigger |
|--------|--------|-------------------|
| PolygonSignedDistance.wgsl | **Active** | ClippingPolygonCollection |
| BrdfLutGenerate.wgsl | **Active** | IBL pipeline init |
| IrradianceConvolution.wgsl | **Active** | Env map change |
| RadiancePrefilter.wgsl | **Active** | Env map change |
| AtmosphereLUT.wgsl | **Dispatch + consumer wired (S26)** | `WebGPUPerformanceManager.dispatchAtmosphereLUT()` runs on transient encoder when sun direction changes (>0.0001 cos delta); SkyAtmosphere fragment shader samples LUT on `useLut > 0.5` |
| FrustumCull.wgsl | **Activated** (S17, subgroup variant S20) | GPU culler 256-command threshold, picks `mainSubgroups` entry point on capable devices |
| PointCloudLOD.wgsl | **Variant + dispatcher ready (S26)** | `computeMainSubgroups` variant wired through `WebGPUPerformanceManager.dispatchPointCloudLOD()` with lazy source preprocessing (prepend `enable subgroups;` or strip sentinel block) and entry-point selection per device capability |
| HiZPyramid.wgsl | Dormant | Wire into ViewportExecutor with Hi-Z (3-4 days) |
| OcclusionTest.wgsl | Dormant | Same as HiZ |
| PointCloudSort.wgsl | Dormant | Wire when point cloud visible |
| GPUSortKeys.wgsl | Dormant | Wire when >50K commands |
| WeatherParticles.wgsl | **Active (S18)** | Compute simulation + render pass via `WEATHER_PARTICLES` FR; activated by `scene._enableWeather = true` |

### Build & Tooling

| Component | Status |
|-----------|--------|
| WGSL build integration | `wgslToJavaScript()` (now `await`-correct, S13) in build.js, gulpfile watches .wgsl |
| WASM build pipeline | `npm run build-wasm` (+ debug/check/clean variants) |
| Split-screen comparison | `Apps/WebGPUTest/split-screen-comparison.html` |
| WebGPU feature auto-detection | `_buildFeatureList()` probes adapter; supports `subgroups`, `timestamp-query`, `shader-f16`, `dual-source-blending`, `clip-distances`, `float32-filterable`, `rg11b10ufloat-renderable`, BC/ETC2/ASTC compression |
| Context-aware logging | `[CesiumJS:type:shortId]` prefix on all renderer messages |
| TypeScript | `tsc --noEmit` -- 0 errors |
| Build | `npx gulp build` -- passes (~38-48s) |
| `npm run restart` | clean -> build -> start (S13) |
| **Build variants** | **Tree-shaken WebGL-only / WebGPU-only / dual builds** via `bundleVariantPlugin.js` (synthetic-path resolve, decision cache, 4x speedup vs build.resolve) |
| **Bundle analyzer** | `scripts/analyzeBuild.js` parses esbuild metafile, reports top-N folders/modules, supports `--treemap` |
| **Lazy-loaded deps** | meshoptimizer (~110 KB), @spz-loader/core (~270 KB) split into separate chunks via dynamic `import()`. Per-feature renderers code-split. Dual ESM index.js shrunk 4.23 MB → 3.9 MB (1.18 MB → 1.05 MB gzipped, -11%). |
| Tests | 10 Jasmine spec files: Buffer, DrawCommand, ImageUpload, PrimitiveIndexUtils, RingBufferAllocator, ShadowMapRenderer, SubgroupUtils, Texture, ContextFactory, GraphicsContext, NagaTranspiler. ~15K green, ~30 pre-existing failures (not from our changes). |

### Debug Visualization Stack (Sessions 22-24)

All toggles read from `frameState` once outside hot loops; production cost is one bool comparison per pass. Fragment debug pipelines use a unified `DebugFragmentMode` enum + augmented shader module (vertex stages reused, fragment entry points appended).

| Toggle | Effect | Implementation |
|--------|--------|----------------|
| `scene.debugShowGlobeWireframe` | Line-list overlay over terrain tiles | `_wireframePipelineCache` keyed by stride, IB swap to wireframe indices, full vertex layout parity |
| `scene.debugShowTriangulation` | Per-triangle rainbow color via primitive_index | `fragmentDebugTri` entry point + `csm_primitiveIndex.wgsl` chunk |
| `scene.debugShowTerrainLOD` | 12-color tile depth overlay | `fragmentDebugLod` reads `tile.debugFields.x` (LOD level) |
| `scene.debugShowTerrainNormals` | Eye-space normal as RGB | `fragmentDebugNormal` reads + remaps `v_normalEC` |
| `scene.debugShowImageryLayer` | Isolate layer 0..3 (or -1 for all) | Multiplicative mask in production fragmentMain, reads `tile.debugFields.y` |
| `scene.debugShowDepthAsColor` | Linearized/raw/combined depth | `WebGPUDebugDepthOverlay.ts` standalone fullscreen pass; sampleable depth opt-in via `WebGPURenderTarget.depthSamplable` (non-MSAA only) |
| `scene.debugDisableAtmosphereScattering` | Flat magenta sky | Early-out in SkyAtmosphere fragment, reads `u.debug.x` |
| `scene.debugShowCubeMapFace` | Per-face cubemap isolation (1=+X..6=-Z) | Fragment-shader face discard via dominant axis test |

---

## 3. What Works End-to-End (Verified)

These features have been verified working in the split-screen WebGPU viewer through manual testing:

| Feature | Verified Date | Notes |
|---------|---------------|-------|
| Globe terrain geometry | April 4, 2026 | Renders sphere with correct shape |
| Bing Maps imagery | April 4, 2026 | Satellite imagery loads and displays |
| Multi-LOD terrain subdivision | April 4, 2026 | Quadtree subdivides as camera zooms |
| texCoordsRect alpha masking | April 4, 2026 | No more vertical stripes between tile imagery |
| Fill tile rendering | April 5, 2026 | Tiles with no UV data correctly skipped (no black lines) |
| WebMercator texture coordinates | April 4, 2026 | Bing Maps imagery correctly projected |
| SkyAtmosphere glow | April 5, 2026 | Atmosphere haze visible at horizon |
| Async init via Viewer.createAsync | April 2, 2026 | WebGPU context initializes through full Viewer path |
| Split-screen WebGL/WebGPU | April 3, 2026 | Both renderers run simultaneously |
| Context+device init (smoke test) | April 2, 2026 | `scene-webgpu-init-test.html`: adapter, device, canvas, beginFrame/endFrame all green |

---

## 4. Bug Fix History (Sessions 1-26)

This is a consolidated index of every bug fix from `WEBGPU_DEBUGGING_LOG.md`. Each entry references the file(s) touched and the root cause; consult the debugging log for full diffs and reproduction steps.

### Session 1 — Initial Launch Errors
- **1.1 Buffer Size NaN**: `createVertexBuffer`/`createIndexBuffer` callers passing `byteLength` where data was expected. Fixed in `WebGPUEnvironmentRenderer.js`, `WebGPUSkyAtmosphereRenderer.js`. `createUniformBuffer` now auto-detects string-as-label.
- **1.2 `passEncoder.setPipeline is not a function`**: Environment commands tried to execute outside any active render pass. Fixed by skipping `renderEnvironment()` in WebGPU mode and adding `Pass.ENVIRONMENT` execution to `WebGPUSceneRenderer.ts` multi-frustum loop.
- **1.3 Splitscreen Camera Sync**: Bidirectional camera sync added in `CesiumViewer.js` with loop-prevention guards.

### Session 2 — Globe Terrain Rendering
- **2.1 Bind Group Limit (5 → 4)**: WebGPU caps at 4 bind groups. Merged water mask + ocean normal map into single group 2.
- **2.2 writeBuffer 4-Byte Alignment**: `Uint16Array` index buffers padded to 4-byte boundaries before upload.
- **2.3 GlobeTerrain.wgsl 404**: Replaced fetch-based shader loading with ES module import.
- **2.4 WebGLStubBuffer Too Small**: Added regrow logic when incoming data exceeds default 4096-byte buffer.

### Session 3 — Pipeline Stride
- **3.1 Index extends beyond limit**: Hard-coded stride assumptions broke when terrain encoding included webMercator + normals. Fixed by switching `_pipelines` to `Map<string, GPURenderPipeline>` keyed by `(isQuantized, hasNormals, isBlend, strideBytes)` with lazy creation.

### Session 4 — Black Screen Root Cause
- **4.1 `clear()` Color Override**: `clearCommand.color !== undefined` was true even when color was `false`. Fixed with explicit `!== false` guards on color/depth/stencil channels.
- **4.2 "size is zero"**: Three buffer creation methods bypassed `WebGPUBuffer.create()`'s size guard. Added `Math.max(size, 4)`.
- **4.3 Depth/Stencil Boolean Clear**: Passed booleans where `1.0`/`0` numerics were expected.

### Session 5 — Feature Renderer Destroy
- **5.1 Destroy Crashes**: `_destroyFeatureRenderers()` called destroy with no args; FRs needed their owning scene object. Removed the destroy() calls — GPU resources freed automatically on device destruction.
- **5.2 WebGLStubBuffer Regrow**: Padded branch wasn't checking regrow. Moved logic before branch.
- **5.3 Index Validation**: Some terrain tiles had indices beyond vertex buffer size. Added clamp-to-valid-triangles.
- **5.4 Splitscreen Initial Sync**: Added explicit initial `copyCamera()` after listeners.

### Session 6 — Pipeline Compilation
- **6.1 Uniform Control Flow**: `textureSample`/`textureSampleCompare` required uniform control flow. Moved shadow check to top of fragment, replaced `textureSample` with `textureSampleLevel(..., 0.0)`.
- **6.2 DepthPlane Format Mismatch**: rgba8unorm vs bgra8unorm. Pass `presentationFormat` as `colorFormat`.
- **6.3 DepthPlane RTE Encoding**: `EncodedCartesian3.fromCartesian` parameter type mismatch. Rewrote with `encode` per-component.
- **6.4 Billboard Buffer NaN**: `Math.max(Number(options.size) || 4, 4)` handles NaN/undefined.
- **6.5 Readback Buffer Zero**: `Math.max(bytesPerRow * height, 4)`.
- **6.6 Expired Ion Token**: Removed from test page.

### Session 7 — Build System
- **7.1 typescript-eslint version**: Bumped to ^8.58.0.
- **7.2 Asset Path**: `buildCesiumViewer` uses `Build/CesiumUnminified/` for dev mode.
- **7.3 JSDoc Errors**: Multiple files (`RenderCommand.js`, `Scene.js`, `WebGPUPointPrimitiveRenderer.js`).
- **7.4 WebGPU Type Stubs**: Added `Tools/jsdoc/webgpu-stubs.d.ts`.
- **7.5 RenderState.releaseCache()**: Added public wrapper for `removeFromCache()`.
- **7.6 Imagery Texture Cache Fields**: Added `sourceWidth`/`sourceHeight`.

### Session 8 — Environment Command Injection
- **8.1 Environment Commands Not Reaching WebGPU**: Commands stored on `environmentState`, not in frustum command list. Added injection into farthest frustum's ENVIRONMENT pass slot.
- **8.2 setVertexBuffer TypeError**: Some env commands had wrapped buffer objects. Added try-catch in `executeBatch()` with one-shot per-error logging.

### Session 9 — Environment Injection Fix (Take 2)
- **9.1 Bypass Discovery**: Session 8 injection lived in `ViewportExecutor` but Scene bypassed it for WebGPU. Moved injection into `Scene._injectEnvironmentCommandsForWebGPU()` before alternate renderer call.

### Session 10 — Imagery & Cubemap
- **10.1 imagery.image Released Too Early**: `_createTexture()` set `imagery.image = undefined` after WebGL upload. Added `if (!context.isWebGPU)` guard.
- **10.2 First Frustum Color Clear**: First frustum now clears color to background color.
- **10.3 SkyAtmosphere Async Fetch**: Switched to direct ES module import.

### Session 11 — Imagery Reprojection Crash + CubeMap Depth-Stencil
- **11.1 _reprojectTexture Crash**: WebGPU FR path didn't return — fell through to WebGL `ComputeCommand` creation. Added early return + backend-agnostic fallback (FR existence check, not isWebGPU).
- **11.2 CubeMapPanorama Depth-Stencil Mismatch**: Pipeline had `depthStencil: undefined` but render pass had `depth24plus-stencil8`. Added depth-stencil with `depthWriteEnabled: false, depthCompare: "always"`.
- **11.3 setVertexBuffer Edge Cases**: Caught by try-catch from S8.

### Session 12 — Build System + Shader Debug
- **12.1 gulp build Missing WGSL/TSC**: `build()` only ran esbuild bundling. Added `wgslToJavaScript()` and `await tsc()` at top.
- **12.2 writeBuffer Floats vs Bytes**: Third arg should be bytes, was passing float count. Fixed to `data.byteLength`.
- **12.3 Diagnostic Property Typo**: `_diagFrameCount` didn't exist; changed to `_diagTileCount`.
- **12.4 Shader Version Mismatch Discovery**: Two GlobeTerrain.wgsl versions existed. Aligned with the 68-float CameraUniforms.
- **12.5 layerCount Always 0 Investigation**: Bind group + writeBuffer + pipeline all verified correct, but `tile.layerCount` read as 0. Resolved in S13 (Bug 13.5).

### Session 13 — Imagery Pipeline + WebGL Stub Logging
- **13.1 Imagery Stuck in TRANSITIONING**: Catch block left state in TRANSITIONING with no retry. Reset to TEXTURE_LOADED on error.
- **13.2 SkyAtmosphere First-Frame Async Miss**: `await getShaderSource()` deferred to microtask. Removed async/await.
- **13.3 ImageryLayer Creating WebGL Textures via Stub**: Added WebGPU early path with placeholder + image preservation.
- **13.4 Placeholder Texture Missing destroy()**: Crash on tile trim. Added no-op destroy().
- **13.5 layerCount u32 Not Readable in WGSL**: Mixed u32/f32 after array<ImageryLayer> caused read-as-zero. Changed to f32 in struct + writer.
- **13.6 wgslToJavaScript Not Awaited**: Async function called sync, broke clean builds. Added `await`.
- **13.7 Texture Y-Flip**: WebGL bottom-left vs WebGPU top-left. Added `flipY: true` to `copyExternalImageToTexture` calls.
- **13.8 Build System Improvements**: `gulp clean` now removes WGSL→JS wrappers + package builds; `npm run restart`.

### Session 14 — webMercatorT Shader Support + UV Stretching
- **14.1 webMercatorT Not Passed Through Shader**: WGSL had no webMercatorT support. Added 5 vertex entry points + per-layer `useWebMercatorTLayer: vec4<f32>` + fragment `select()` for V coordinate.
- **14.2 Quantized Terrain webMercT Decompression**: `compressed0.w` is webMercT (not encodedNormal) for quantized BITS12. New `vertexMainQuantizedWebMerc` entry point.
- **14.3 Back-Face Culling Regression**: `octDecode(0.0)` produced normal `(0,0,-1)`. Sentinel changed to 32896.0 (≈+Z).
- **14.4 Vertex Format Mismatch (webMercT+Normals)**: 4-float layout needed `float32x4` not `float32x3`.
- **14.5 SceneMode.SCENE2D Check**: `scene.mode !== 0` was wrong (0 = MORPHING). Changed to `!== 2`.
- **14.6 Spammy Per-Tile Logs**: Removed dead `_diagLogged` flag.

### Session 15 — LOD Unlock + texCoordsRect Alpha
- **15.1 Vertical Stripes from texCoordsRect Clamping**: WebGL uses texCoordsRect for alpha masking, not UV clamping. Removed clamp, added `texCoordsAlpha()` `step()`-based mask.
- **15.2 Only LOD 0 Tiles Rendered**: `tile.renderable = defined(surfaceTile.vertexArray)` was false for WebGPU. Added `|| (mesh && mesh.vertices && mesh.indices)` OR.
- **15.3 Fill Tile Stride Mismatch**: Added stride inference: `vertices.length / (maxIdx + 1)`.
- **15.4 Diagnostic Counter Never Stopping**: `_diagTileCount++` was inside its own check.

### Session 16 — Architecture Cleanup, Shadow Casting, Performance
- **16.1 panoramaCommandList Never Cleared**: `updateFrameState()` cleared other lists but not panorama. Added clear.
- **16.2 Camera Jitter (Improved)**: Tightened staleness thresholds (100m→50m, 0.999→0.9995), added `ASYNC_PICK_DISTANCE_RATIO = 1.5x` rejection vs ray pick.
- **16.3 Shadow Cast Lists Cleared Before Reading**: Move clear after collection.
- **16.4 Shadow Map Point Light Guard**: `!shadowMap._isPointLight === false` is `(!_isPointLight) === false`. Fixed to `shadowMap._isPointLight`.
- **16.5 Shadow Map Bias Path**: `_bias` undefined. Use `_primitiveBias || _terrainBias`.
- **16.6 isWebGPUDrawCommand Removed from All Scene Code**: 8 violations across 5 files replaced with duck-typing. Result: zero `isWebGPUDrawCommand` checks in Scene.
- **16.7 Render Bundles Activated**: Globe pass uses bundle encoder when 8+ tiles.
- **16.8 Ring Buffer Allocator Wired**: 4MB pages, triple-buffered, 256-byte alignment.
- **16.9 Shadow Cast Pass Added**: `executeShadowMapCastCommands(scene)` before multi-frustum loop.
- **16.10 First WebGPU Unit Tests**: 5 spec files, ~45 tests.

### Session 17 — Feature Wiring + Full Shader + Performance
- **17.1 GROUND_ATMOSPHERE Wired**: `Globe.js beginFrame()` calls FR.
- **17.2 Full GlobeTerrain.wgsl Restored**: Lighting, fog, atmosphere, shadows, ocean, night effects, clipping. Used `selectLayerUV()` per layer.
- **17.3 GPU Frustum Culler Activated**: Lazy-init singleton, async readback.
- **17.4 Pipeline Warm-up**: Globe renderer + GPU culler pre-init at context creation.
- **17.5 Post-Process Pipeline Verified**: Already complete.
- **17.6 FR Audit**: FOG, PROCEDURAL_CLOUDS, SSR, WEATHER_PARTICLES already wired in `_executeEnvironmentalEffects()`. Only GROUND_ATMOSPHERE was truly unwired.

### Session 18 — Parity Closure
- **18.1 Viewport Quad**: `WebGPUViewportQuad.ts` (NEW) — pipeline cache, bind group auto-detect, fullscreen triangle. Integrated into `WebGPUContext.createViewportQuadCommand`.
- **18.2 Labels with SDF**: `WebGPULabelRenderer.js` (NEW) + `BillboardCollectionSDF.wgsl` (NEW). 5-tap supersampling, outlines, screen-space derivative AA. Added `LABEL_COLLECTION = 36`.
- **18.3 Weather Particle Render Pass**: `WeatherParticleRender.wgsl` (NEW) — camera-facing instanced quads, per-type fragments.
- **18.4 2D / Columbus View Mode**: Globe terrain shader scene-mode branching (MORPHING/COLUMBUS_VIEW/SCENE2D/SCENE3D), planar position helpers, extended CameraUniforms.

### Session 19 — Renderer Verification, BufferPrimitives, Mobile Perf, UBO Cleanup
- **19.1 Renderer Bug Audits**: `WebGPUEllipsoidPrimitiveRenderer` viewport size pack (40→44 floats); `WebGPUGaussianSplatRenderer` focal length from projection matrix; `WebGPUPointCloudEyeDomeLighting` reduced to documented no-op stub.
- **19.2 Buffer Primitive Collections**: NEW `WebGPUBufferPrimitiveRenderer.ts` (~1000 lines) handles polygon/polyline/point. Camera UBO matches standard 368-byte struct. Shader fixes: `camera.projection`/`camera.viewport` → `camera.projectionMatrix` + per-shader viewport.
- **19.3 Transient Render Attachments**: `WebGPUFramebufferManager.getRenderPassDescriptor()` forces `storeOp: "discard"` on MSAA color + non-samplable depth so tile-based mobile GPUs keep them on-chip.
- **19.4 UBO Size Cleanup**: Tightened 256-byte UBOs to 96-176 bytes for static bindings.

### Session 20 — ParticleSystem, BufferPrimitive Picking, WGF-1, WGF-6
- **20.1 General ParticleSystem (no-op closure)**: Already routes through `WebGPUBillboardRenderer` via `BillboardCollection`.
- **20.2 Buffer Primitive Picking**: `PICK_FRAGMENT_SUFFIX` appends `fragmentPickMain` to each preprocessed shader. Per-collection pick pipelines + pick ID allocation via `context.createPickId`.
- **20.3 WGF-1 Subgroups Wired Into GPU Culler**: `FrustumCull.wgsl` `mainSubgroups` entry point uses `subgroupBallot` to collapse per-thread atomicAdd into one per subgroup. `WebGPUGPUCuller.initialize()` picks entry point with try/catch fallback.
- **20.4 WGF-6 `@builtin(primitive_index)`**: NEW `csm_primitiveIndex.wgsl` chunk + `WebGPUPrimitiveIndexUtils.ts` (capability probe via pushErrorScope, face color WGSL, primitive pick WGSL, RGBA decoder).

### Session 21 — Tier-2 Cleanup (WGF-3, WGF-5, WGF-6, WGF-7, WGF-8)
- **21.1 WGF-5 Texture Component Swizzle**: `swizzleChannel()` if-else replaced with dynamic vector subscript `texColor[clamp(i32(idx), 0, 3)]`.
- **21.2 WGF-8 EXIF/orientation**: NEW `WebGPUImageUpload.ts` (~210 lines) + `WebGPUContext.createTextureFromImageAsync()`. Uses `createImageBitmap(source, { imageOrientation: "from-image" })`. Sync fast path preserved.
- **21.3 WGF-6 Wiring**: WebGPUContext caches `WebGPUPrimitiveIndexUtils` after device creation; Scene gets `triangulationDebugSupported` getter.
- **WGF-3 audit**: No work needed — sampler-as-let already used.
- **WGF-7 audit**: No work needed — formats already optimal for current compute kernels.

### Session 22 — Unit Tests + debugShowTriangulation Wiring
- **22.1 Unit Test Coverage**: NEW `WebGPUPrimitiveIndexUtilsSpec.js`, `WebGPUSubgroupUtilsSpec.js`, `WebGPUImageUploadSpec.js`. GPU-gated paths use `pending()` fallback.
- **22.2 debugShowTriangulation Production Wiring**: Scene flag forwarded to frameState; `WebGPUGlobeSurfaceRenderer` augmented shader module (vertex stages reused, `fragmentDebugTri` appended), cold-path `_selectDebugTriPipeline()` separate from production cache.

### Session 23 — Tier 1 Render Debug Features
- **23.1 Globe Wireframe**: Refactored orphaned `_wireframePipelines[4]` array into `_wireframePipelineCache: Map<string, GPURenderPipeline>` keyed by stride. Cold-path selector + IB swap to line-list indices.
- **23.2 SkyAtmosphere Scattering Bypass**: NEW `debug: vec4<f32>` uniform field. `debug.x > 0.5` returns flat magenta. Reserved offsets 53-55 for Tier 3.
- **23.3 SkyBox Cubemap Face Isolation**: Per-face fragment discard via dominant axis test. Encoding 0=all, 1=+X..6=-Z.

### Session 24 — Tier 2 Debug Features + Refactor
- **24.1 Unified Debug Fragment Pipeline**: Replaced per-feature `_debugTri*` cluster with `DebugFragmentMode` enum (NONE/TRIANGULATION/LOD/NORMAL), single `_debugFragmentShaderModule`, single `_debugFragmentPipelineCache` + `_selectDebugFragmentPipeline()`. Adding new variants is now one entry point + one enum value.
- **24.2 tile.debugFields vec4**: `.x = tileLevel`, `.y = isolateImageryLayer`, .z/.w reserved. `TILE_UNIFORM_FLOATS` 92→96.
- **24.3 LOD Color Overlay**: `fragmentDebugLod` 12-color palette via WGSL `switch`.
- **24.4 Normal-as-Color**: `fragmentDebugNormal` reads + remaps `v_normalEC`.
- **24.5 Imagery Layer Isolation**: Multiplicative mask in production fragmentMain.
- **24.6 Depth-as-Color Overlay**: NEW `WebGPUDebugDepthOverlay.ts` (~230 lines). Sampleable depth opt-in via `WebGPURenderTarget.depthSamplable`. Cold-path integration in `_runPostProcessing` swaps in overlay for production post-process chain. Non-MSAA only.

### Session 25 — Architecture Audit + Stale Backlog Cleanup
- **BUG-4 Fix**: Split-screen camera sync `syncingCamera` guard reset deferred to next animation frame.
- **BUG-7 / SHADOW-LAYOUT**: Discovered that shadow cast pipeline assumes single fixed vertex layout (stride 24, two `float32x3` for RTE positionHigh/positionLow). Added stride filter as safety net; per-layout cache deferred.
- **NEW-1 Resolved**: `DynamicEnvironmentMapManager` sync `readPixels` was already on a WebGL-only branch — non-issue.

### Session 26 — Backlog Audit, AtmosphereLUT Consumer, PointCloudLOD Subgroup Dispatcher, 3D Tiles Indirect Draw, BUG-11 Audit, Naga-wasm Spike
- **Backlog audit**: Pruned 9 stale entries (FORK-19 specs exist, FORK-17 mipmaps wired, FORK-34 already done, Labels rendering done S18, Viewport quad done S18, Buffer primitives done S19, WGF-1 subgroups done S20, WGF-2 transient attachments done S19, AtmosphereLUT dispatch done S17). Added SUBGROUP-DISPATCH and ATMOS-LUT-CONSUMER (now both also resolved this session).
- **AtmosphereLUT consumer**: `SkyAtmosphere.wgsl` extended with `useLut` flag in Uniforms struct + `@group(1)` LUT bindings (sampler + transmittance + inscatter views) + `sampleScatteringLut()` fast path. `WebGPUSkyAtmosphereRenderer.js` builds the LUT bind group, dispatches compute on a transient encoder when sun direction changes (>0.0001 cos delta), falls back to a 1×1 placeholder + ray march path when compute is unavailable. `useLut` uniform field set based on dispatch success.
- **PointCloudLOD subgroup dispatcher**: New `WebGPUPerformanceManager.dispatchPointCloudLOD()` lazily preprocesses the WGSL source (prepends `enable subgroups;` on capable devices, strips `__SUBGROUP_BLOCK_*__` sentinels otherwise) and selects `computeMainSubgroups`/`computeMain` accordingly. Cached per device. Plus `pointCloudLODUsesSubgroups()` diagnostic.
- **3D Tiles indirect-draw integration**: New `executeBatchIndirect()` in `WebGPUSceneRenderer.ts` scans command lists for runs of ≥2 commands sharing pipeline + bind groups + index buffer, batches them through `WebGPUIndirectDrawManager.submitBatch` + `executeBatchIndexed`. Wired into `_execute3DTilePasses` behind `context.useIndirectDrawForTiles` flag (off by default). Single setPipeline + N drawIndexedIndirect per homogeneous run.
- **BUG-11 imagery audit (no fix, code-level only)**: Static analysis ruled out bind-group sample-type mismatch, std140 alignment drift, day/night alpha argument swap, stale uniform leakage. Two top runtime suspects documented: (A) reprojection clear alpha=0 collapsing `tex.a * effectiveAlpha` to zero, (B) zero `texCoordsRect`. Probe checklist added for next browser session.
- **Naga-wasm spike**: NEW `WebGPUNagaTranspiler.ts` with lazy `import("naga-wasm")`, FNV-1a-keyed transpile cache, graceful unavailable-fallback. Wired into `WebGLStubShader.shaderSource` + `compileShader` so stub shaders carry `_glslSource`/`_wgslReady`/`_wgsl` fields. Activation: `npm install naga-wasm`. Open follow-ups: bind-set remapping, vertex attribute location remapping.
- **WebGLStubShader fix**: `maxInterStageShaderComponents` renamed to `maxInterStageShaderVariables` in newer `@webgpu/types` — read either via cast.

### Bug Pattern Analysis (cumulative across all sessions)
1. **API mismatch** (6+): Callers passing wrong parameter types/order to WebGPU buffer/pipeline creation
2. **Silent failures** (5+): Errors swallowed by missing guards
3. **WebGL→WebGPU assumption gaps** (4+): Boolean vs numeric clear values, texture format mismatches, 4-byte alignment, top-left vs bottom-left UV
4. **Buffer sizing** (4+): Zero-size, NaN-size, undersized buffers
5. **Architecture gaps** (2+): Environment pass routing, pipeline stride assumptions
6. **Async/event ordering** (3+): SkyAtmosphere first-frame microtask, splitscreen guard reset, async depth feedback loops

### Most Frequently Modified Files
1. `WebGPUGlobeSurfaceRenderer.ts` — terrain pipeline is the most complex (Sessions 2, 3, 5, 7, 14, 15, 17, 19, 22, 23, 24)
2. `WebGPUSceneRenderer.ts` — frame orchestration touches many systems (Sessions 1, 3, 4, 6, 16, 17, 18, 24, 26)
3. `WebGPUContext.ts` — core context affects everything (Sessions 4, 6, 16, 17, 18, 19, 21)
4. `GlobeTerrain.wgsl` — fragment shader churn (Sessions 2, 6, 14, 15, 17, 18, 23, 24)

---

## 5. WASM & Compute Audit Results

### WASM Bridge Compliance Matrix (All Complete — April 2026)

| Bridge | destroy() | free_buffer() | Version Check | SIMD Detection | JS Fallback | Error Handling |
|--------|-----------|---------------|---------------|----------------|-------------|----------------|
| WasmCullBridge | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| WasmSortBridge | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| WasmHeightmapBridge | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| WasmQuantizedMeshBridge | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| WasmRTEBridge | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| WasmMatrixBridge | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| WasmPointCloudBridge | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

`WasmFeatureDetection.js` provides shared `checkSIMDSupport`, `checkModuleSIMD`, `checkVersionMatch`, `freeBuffer`. All bridges have `_isDestroyed` guard + try/catch with automatic JS fallback. Rust `lib.rs` uses `try_reserve()` for OOM-safe allocation.

### GPU Compute vs WASM Decision Matrix

| Task | Best Approach | Shader / Bridge |
|------|--------------|------------------|
| Terrain tessellation | WASM | WasmHeightmapBridge / WasmQuantizedMeshBridge |
| Frustum culling (>50K) | GPU Compute | `FrustumCull.wgsl` (active, with subgroup variant) |
| Frustum culling (<50K) | WASM SIMD | `WasmCullBridge.js` |
| Atmosphere LUT | GPU Compute | `AtmosphereLUT.wgsl` (active, with shader consumer) |
| Point cloud sort | GPU Compute (>50K) / WASM | `PointCloudSort.wgsl` (dispatch wired, host integration pending) / `WasmPointCloudBridge.sortByDistance()` |
| Point cloud LOD | GPU Compute (>50K) / WASM | `PointCloudLOD.wgsl` (subgroup variant + dispatcher) / `WasmPointCloudBridge.lodFilterAndSort()` |
| Sort keys (>50K) | GPU Compute | `GPUSortKeys.wgsl` (dormant — JS comparators always active) |
| Sort keys (5K-50K) | WASM radix sort | `WasmSortBridge.js` |
| Hi-Z occlusion | GPU Compute | `HiZPyramid.wgsl` + `OcclusionTest.wgsl` (dormant) |
| Polygon SDF | GPU Compute | `PolygonSignedDistance.wgsl` (active) |
| IBL (BRDF LUT, irradiance, radiance) | GPU Compute | `BrdfLutGenerate.wgsl`, `IrradianceConvolution.wgsl`, `RadiancePrefilter.wgsl` (all active) |

### GLSL Backport Analysis (April 2026) — No Backports Needed

All WGSL shaders fall into three categories:

| Category | Count | Details |
|----------|-------|---------|
| **Ports of existing GLSL** | 12+ | Tonemapping (5 modes), Atmosphere, SSAO, Bloom, DoF, Edge, Silhouette, IBL (3), FXAA, GroundAtmosphere |
| **Compute-only (impossible in WebGL)** | 8 | FrustumCull, HiZ, OcclusionTest, AtmosphereLUT, PointCloudSort/LOD, GPUSortKeys, WeatherParticles |
| **WebGPU-only enhancements** | 7+ | SSR, ProceduralClouds, DeferredGBuffer/Lighting, enhanced ocean (Fresnel/GGX/foam/SSS), enhanced night (terminator glow, city lights emission), terminator glow |

### IBL Pipeline (Complete)

| Shader | Purpose | Dispatch Site |
|--------|---------|---------------|
| BrdfLutGenerate.wgsl | BRDF integration LUT (split-sum IBL) | `WebGPUIBLPipeline.ts` (one-time, init) |
| IrradianceConvolution.wgsl | Diffuse irradiance cubemap convolution | `WebGPUIBLPipeline.ts` (env map change) |
| RadiancePrefilter.wgsl | Specular pre-filtered mipchain | `WebGPUIBLPipeline.ts` (env map change) |
| ImageBasedLighting (TS) | SH coefficients + specular orchestration | `WebGPUImageBasedLighting.ts` |
| ModelPBRComplete.wgsl | IBL-aware ambient (split-sum) | Per-frame model fragments |

### Night & Ocean Rendering Enhancements (April 2026)

**Night side**:
- Terminator: `NdotL * 5.0 + 0.5` sharp boundary (matches GLSL)
- Night-side darkness: 0.025 moonlight ambient + 0.04 base color
- City lights emission: additive boost when `nightAlpha > dayAlpha`, luminance-weighted
- Configurable `nightIntensity` uniform (default 2.5x)
- Terminator glow: warm orange Gaussian at NdotL≈0
- Night-side fog: dimmed to 5% on dark side

**Ocean/Water**:
- 3-octave wave normals (400×, 200×, 800× UV) with weighted blend
- Distance-scaled wave strength: `mix(0.25, 0.05, smoothstep(10K, 500K, dist))`
- GGX/Trowbridge-Reitz specular (roughness 0.08) for sun glints
- Schlick Fresnel (F0=0.04, power 5.0)
- Deep water color blend to `(0.008, 0.045, 0.12)`
- Subsurface scattering: forward-scatter turquoise rim at grazing angles
- Foam/whitecaps: steepness-based threshold 0.35, distance-faded
- Sky reflection via Fresnel at 50%
- Smooth coastline transition `smoothstep(0.3, 0.7, waterMask)`
- Night ocean: `mix(0.08, 1.0, dayFade)` very dark at night
- 8 configurable uniform floats: deep color, Fresnel, reflectivity, foam threshold, darkening, night intensity

---

## 6. Render Pass Coverage

All 13 CesiumJS render passes are handled in the WebGPU path. ENVIRONMENT runs before the WebGPU branch via `renderEnvironment()` in SceneRenderer.js; all other passes are in `WebGPUSceneRenderer.ts`.

| Pass | ID | Handler | Status |
|------|----|---------|--------|
| ENVIRONMENT | 0 | `renderEnvironment()` in SceneRenderer.js (before branch) + injected into farthest frustum (S8/S9) | ✅ |
| COMPUTE | 1 | Handled by individual compute dispatches | ✅ |
| GLOBE | 2 | `_executeGlobePass()` (with render bundle when ≥8 tiles) | ✅ |
| TERRAIN_CLASSIFICATION | 3 | `_executePassCommands(Pass.TERRAIN_CLASSIFICATION)` | ✅ |
| CESIUM_3D_TILE_EDGES | 4 | `_execute3DTilePasses()` (optional indirect-draw fast path S26) | ✅ |
| CESIUM_3D_TILE | 5 | `_execute3DTilePasses()` | ✅ |
| CESIUM_3D_TILE_CLASSIFICATION | 6 | `_execute3DTilePasses()` | ✅ |
| CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW | 7 | `_execute3DTilePasses()` | ✅ |
| OPAQUE | 8 | `_executeOpaquePass()` | ✅ |
| TRANSLUCENT | 9 | `_executeTranslucentPass()` (OIT MRT path with auto-variant creation) | ✅ |
| VOXELS | 10 | `_executePassCommands(Pass.VOXELS)` | ✅ |
| GAUSSIAN_SPLATS | 11 | `_executePassCommands(Pass.GAUSSIAN_SPLATS)` | ✅ |
| OVERLAY | 12 | `_executeOverlayPass()` | ✅ |

Additional WebGPU-specific passes:
- **Pick pass** — `_executePickPass()` (GLOBE, 3D_TILE, OPAQUE, TRANSLUCENT)
- **Shadow cast pass** — `executeShadowMapCastCommands()` before multi-frustum loop (Session 16)
- **Environmental effects** — `_executeEnvironmentalEffects()` (SSR, Weather, Clouds, Weather render)
- **Post-processing** — `_runPostProcessing()` (Tonemapping, FXAA, Bloom, SSAO, DoF, Edge, Silhouette)
- **Debug depth overlay** — `_executeDebugDepthOverlay()` (cold path, swaps in for production post-process)
- **Performance infrastructure** — `beginFrame()`/`endFrame()` for render bundles, indirect draws, profiling, ring buffer

### Init Chain (verified)

```
Viewer.createAsync(container, { contextOptions: { renderer: 'webgpu' } })
  ├─ Creates LoadingOverlay
  ├─ CesiumWidget.createAsync(tempDiv, options, onProgress)
  │   ├─ Scene.createAsync(canvas, options)
  │   │   ├─ ContextFactory.createContext(canvas, { renderer: 'webgpu' })
  │   │   │   ├─ navigator.gpu.requestAdapter()
  │   │   │   ├─ adapter.requestDevice({ requiredFeatures: [...] })
  │   │   │   └─ new WebGPUContext(canvas, device, adapter)
  │   │   │       ├─ _initialize() — creates default texture, sampler, depth format
  │   │   │       ├─ _warmUpPipelines() — pre-compile globe + GPU culler
  │   │   │       ├─ registerWebGPUFeatureRenderers(context) — all 36 FRs (+ 7 lazy)
  │   │   │       └─ Matrix4.setDepthRangeType('webgpu') — 0-1 NDC
  │   │   └─ new Scene(options) with _preInitializedContext
  │   └─ new CesiumWidget(container, { _preInitializedScene: scene })
  ├─ new Viewer(container, { ...options, _preInitializedScene: widget.scene })
  │   └─ new CesiumWidget(cesiumWidgetContainer, { ..., _preInitializedScene })  ← FIXED S0
  └─ Removes LoadingOverlay
```

---

## 7. Industry Comparison

| Engine | Architecture | Shader Strategy | Our Comparison |
|--------|-------------|----------------|----------------|
| **Babylon.js** | `ThinEngine` abstract -> `Engine`/`WebGPUEngine`. Zero `if(isWebGPU)` in scene code. | GLSL -> SPIRV -> WGSL transpilation | We have `GraphicsContext` abstract + Feature Renderer pattern. 36 of 36 keys registered. |
| **Three.js** | `WebGPURenderer` drop-in for `WebGLRenderer`. Node-based TSL generates both GLSL/WGSL. | TSL node graph -> both backends | We use hand-written WGSL (higher quality) + optional Slang + new naga-wasm spike. |
| **PlayCanvas** | `GraphicsDevice` base. GPU-driven rendering with indirect draws. Ring-buffer uniforms. | GLSL + WGSL | Similar abstract base. GPU-driven infrastructure built and selectively activated. |

### Feature Comparison Matrix

| Feature | CesiumJS WebGPU | Babylon.js 7 | Three.js r170 | PlayCanvas 2 | Filament | Bevy 0.15 |
|---------|----------------|--------------|---------------|--------------|----------|-----------|
| **PBR (metallic-roughness)** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **IBL (full pipeline)** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **SSAO** | ✅ | ✅ SSAO2 | ✅ | ✅ | ✅ | ✅ |
| **SSR** | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| **Bloom** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **DoF** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **TAA** | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Motion Blur** | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ |
| **Shadow Casting** | ⚠️ stride-24 only | ✅ | ✅ | ✅ | ✅ | ✅ |
| **CSM** | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **GPU Particles** | ⚠️ Weather only | ✅ | ✅ | ✅ | ❌ | ✅ |
| **Volumetric Fog** | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Render Bundles** | ✅ Activated | ✅ | ⚠️ Partial | ✅ | N/A | ✅ |
| **Indirect Draw** | ✅ Wired (opt-in) | ✅ | ⚠️ Partial | ✅ | ✅ | ✅ |
| **Compute Shaders** | ✅ 6 active / 4 ready / 2 dormant | ✅ | ✅ | ✅ | ✅ | ✅ |
| **f16 Shaders** | ⚠️ Detected unused | ⚠️ Partial | ✅ | ❌ | ✅ | ❌ |
| **Subgroups** | ✅ Wired (FrustumCull, PointCloudLOD) | ❌ | ❌ | ❌ | N/A | ❌ |
| **64-bit Precision (RTE)** | ✅ Unique | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Multi-Frustum** | ✅ Unique | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Globe Terrain** | ✅ Unique | ❌ | ❌ | ❌ | ❌ | ❌ |
| **GIS Picking** | ✅ Unique | ❌ | ❌ | ❌ | ❌ | ❌ |

### Our Unique Strengths

1. **Planetary-scale RTE 64-bit precision** — No other WebGPU engine handles planetary scale
2. **Multi-frustum depth management** — Depth precision at all zoom levels
3. **Globe terrain with quadtree LOD** — Tile-center RTE encoding (correct approach)
4. **GIS picking** — Height sampling, terrain-aware, async depth readback with staleness validation + distance-ratio rejection
5. **Material system** — All 25 built-in CesiumJS materials mapped to WGSL
6. **3D Tiles integration** — Works automatically via Model chain (zero 3D Tiles code changes)
7. **Subgroup operations in production** — Used in `FrustumCull` mode 2 and `PointCloudLOD` for prefix-sum compaction
8. **Compute-precomputed atmosphere LUT** — `AtmosphereLUT.wgsl` produces transmittance + inscatter tables; `SkyAtmosphere.wgsl` samples them via fast path

---

## 8. Relationship with Upstream CesiumJS

### What We Modify in Upstream

- **Scene files** — WebGPU routing via `getFeatureRenderer()` pattern (~1 line per file, 31+ files)
- **Build system** — WGSL shader compilation, multi-variant build (WebGL-only / WebGPU-only / dual)
- **Package config** — `@webgpu/types` dependency
- **Widget files** — `createAsync()` + `LoadingOverlay`
- **Context.js** — ES6 class + extends `GraphicsContext`

### What We Add (never conflicts)

- `packages/engine/Source/Renderer/WebGPU/` — 105+ files
- `packages/engine/Source/Shaders/WebGPU/` — 238+ WGSL shaders
- `Apps/WebGPUTest/` — 29 test pages
- `migration_doc/` — this documentation
- `scripts/build.js` + `bundleVariantPlugin.js` — multi-variant build infrastructure
- `scripts/analyzeBuild.js` — bundle analyzer
- `Tools/visual-regression/` — Playwright + hand-rolled PNG diff (no new deps)

### Upstream Sync Status

#### Second Sync (April 2, 2026): PR #13121 (Constant LOD) — 45 commits, ZERO conflicts
- **0 commits behind** upstream after sync
- **27 commits ahead** (26 WebGPU additions + 1 merge commit)
- Two-parent merge commit verified
- Build passes (exit code 0)

**New upstream feature (Constant LOD):**
- `computeTextureTransform.glsl` — new `czm_computeTextureTransform()` builtin function for `KHR_texture_transform`
- `ConstantLodStageFS.glsl` + `ConstantLodStageVS.glsl` — distance-based constant LOD texture lookup
- `MaterialPipelineStage.js` — new `processConstantLod()` function

**Our modifications preserved through merge:**
- `InstancingPipelineStage.js` line 77: `|| frameState.context.isWebGPU` (keepTypedArray for WebGPU)
- `SkinningPipelineStage.js` line 5: `extractSkinData` from `ModelSkinData.js`
- `LightingStageFS.glsl`: Full multi-light system

**WGSL equivalent now landed:**
- `csm_computeTextureTransform.wgsl` — built

#### First Sync (March 2026): v1.135–v1.140 — 507 commits, 12 conflicts resolved

| Version | Notable Changes |
|---------|----------------|
| **v1.140** | BufferPrimitive collections (vector tile APIs), Billboards WebGL2 requirement, Gaussian splat perf, ClippingPolygon GPU perf |
| **v1.139** | **Cartesian2/3/4 ES6 classes** (aligned with our modernization), CubeMapPanorama, metadata in custom shaders |
| **v1.138** | Intel Arc GPU jitter fix, Megatexture→Texture3D for voxels, 2D/CV pick fixes |
| **v1.137** | BENTLEY point/line style extensions, edge visibility quad rendering, pickAsync |
| **v1.136** | pickAsync, terrain picking quadtrees |
| **v1.135** | 3D Tiles terrain provider, EXT_mesh_primitive_edge_visibility |

**Conflict Resolution Summary**:
| File | Strategy |
|------|----------|
| `package.json` (4) | Accept upstream versions, keep our additions |
| `Context.js` | Keep ours (ES6 class) |
| `VertexArray.js` | Keep ours + add new methods |
| `SkyBox.js` | Keep ours + apply fix |
| `SSCCModeHandlers.js` | Apply upstream zoom fix |
| `Material.js`, `RenderState.js` | Keep ours |
| `CubeMapPanorama.js` | Keep ours |
| `StaticGeometry*Batch.js` | Keep ours |

---

## 9. Reference

### Summary Statistics

| Metric | Count |
|--------|-------|
| WebGL shader files (GLSL) | ~319 |
| WebGPU shader files (WGSL) | 238+ |
| Compute shaders | 12 (6 active, 4 dispatch-ready, 2 dormant) |
| Shader coverage (file count) | ~75% |
| Shader coverage (functional) | ~95% |
| Builtin function chunks | 91+ WGSL (of 90 GLSL — 101% coverage) |
| CsmBuiltins.js entries | 97 (91 functions + 6 structs) |
| WebGPU renderer files | 105+ |
| WebGPU renderer LOC | ~46,000 |
| Feature renderer keys | 38 (36 registered + COUNT + DEFERRED_GBUFFER reserved) |
| Feature renderers scene-wired | 36 of 36 (100%) |
| Lazy-loaded feature renderers | 7 (Gaussian splat, point cloud, point cloud EDL, voxel, SSR, weather particles, procedural clouds) |
| Scene features with WebGPU | 30+ of 33+ (~91%) |
| Rendering passes functional | 13 of 13 (100%) |
| Test pages | 29 |
| Jasmine unit tests | 10 spec files (Buffer, DrawCommand, ImageUpload, PrimitiveIndexUtils, RingBufferAllocator, ShadowMapRenderer, SubgroupUtils, Texture, ContextFactory, GraphicsContext, NagaTranspiler) |
| ES6 modernized files | ~75 (of ~454 total) |
| Verified working features | 10 (see Section 3) |
| Active bugs (rendering) | 4 (BUG-3 partially S18, BUG-5/6 edge cases, BUG-11 imagery audit) |
| Active bugs (architecture) | 0 (Session 16 cleanup) |
| WASM bridges | 7 of 7 fully compliant |
| Compute shader fallbacks | All have JS or WASM fallback |
| Backend-agnostic Scene code | Zero `isWebGPUDrawCommand` checks |
| Build variants | 3 (WebGL-only, WebGPU-only, dual) |
| Bundle size (dual ESM index.js) | 3.9 MB / 1.05 MB gzipped (-11% from pre-lazy-load baseline) |
| Debug visualization toggles | 8 (wireframe, triangulation, terrainLOD, terrainNormals, imageryLayer isolation, depthAsColor, atmosphereScattering bypass, cubemap face) |

### WebGPU Spec Features Enabled

Auto-detected: `float32-filterable`, `clip-distances`, `dual-source-blending`, `rg11b10ufloat-renderable`, `timestamp-query`, `shader-f16`, `subgroups`, `subgroups-f16`, texture compression (BC/ETC2/ASTC).

### Build & Test Commands

```bash
npx gulp build              # Full build (WGSL → JS, then TSC, then esbuild)
npx tsc --noEmit            # TypeScript type-check
npm run build-wasm          # WASM release build
npm run build-wasm-debug    # WASM debug build
npm test                    # Jasmine spec suite
npm run restart             # clean → build → start
npx gulp buildAllVariants   # WebGL-only + WebGPU-only + dual variants
node scripts/analyzeBuild.js --build --treemap  # Bundle analyzer
```

### Development Workflow

1. **Before starting:** Review `.clinerules` / `CLAUDE.md`, verify backward compatibility
2. **File placement:** Always `packages/engine/Source/`, never root `Source/` (build output)
3. **New WebGPU features:** Use `RenderCommand` (Path B) + `getFeatureRenderer()` pattern
4. **Shared scene logic:** Must run BEFORE `if (context.isWebGPU)` branch
5. **RTE:** Always positionHigh/positionLow, never single position for world-space geometry
6. **ES6:** When touching a file, modernize it if making >10 lines of changes
7. **Feature parity:** Check both backends when adding/fixing features
8. **Async:** Never sync `readPixels` in render loop; always use `mapAsync` + `.then()`
9. **Debug visualization:** Add new toggles via the unified `DebugFragmentMode` enum + augmented shader module pattern (S24 architecture)

---

*For the full backlog of remaining work items, see `WEBGPU_MIGRATION_BACKLOG.md`.*
*For per-session bug fix details, see `WEBGPU_DEBUGGING_LOG.md` (preserved for historical reference; new findings should land here in Section 4 going forward).*
