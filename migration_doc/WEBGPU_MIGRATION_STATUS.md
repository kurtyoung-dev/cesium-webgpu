# CesiumJS WebGPU Migration — Consolidated Status

**Last Updated:** March 19, 2026 (Updated: Scene.js backend agnosticism — zero isWebGPU in command dispatch)  
**Repository:** Fork of [CesiumGS/cesium](https://github.com/CesiumGS/cesium) → [kurtyoung-dev/cesium-webgpu](https://github.com/kurtyoung-dev/cesium-webgpu)  
**Overall Progress:** ~55% of full WebGL feature parity

---

## Table of Contents

1. [Architecture](#1-architecture)
   - [1a. System Architecture](#1a-system-architecture)
   - [1b. What We've Completed](#1b-what-weve-completed)
   - [1c. Relationship with Upstream CesiumJS](#1c-relationship-with-upstream-cesiumjs)
2. [What Remains](#2-what-remains)
   - [2a. Work Remaining (Priority Order)](#2a-work-remaining-priority-order)
   - [2b. Known Issues](#2b-known-issues)
   - [2c. Risks](#2c-risks)
3. [Key Technical Decisions](#3-key-technical-decisions)
4. [Industry Comparison & Research](#4-industry-comparison--research)
5. [WebAssembly & Performance Roadmap](#5-webassembly--performance-roadmap)
6. [Reference](#6-reference)

---

## 1. Architecture

### 1a. System Architecture

#### High-Level Flow

```
User Code: new Cesium.Viewer('container', { contextOptions: { renderer: 'webgpu' } })
  └─ Viewer.createAsync() → shows LoadingOverlay
      └─ CesiumWidget.createAsync() → Scene.createAsync()
          ├─ ContextFactory.createContext() → WebGPUContext.create() (async GPU adapter/device)
          ├─ initPrimitiveShaders() / initCollectionShaders() → fetches .wgsl files
          └─ Matrix4.setDepthRangeType('webgpu') → 0-1 NDC depth range

Rendering: Scene.render() → uniformState.update() → per-View context update → Primitive.update()
  ├─ WebGL path (existing, untouched)
  └─ WebGPU path:
      ├─ Feature renderer via context.getFeatureRenderer('name')
      ├─ createWebGPUCommands() → builds GPU pipelines/buffers
      ├─ updateWebGPUCommandUniforms() → per-frame RTE camera matrices
      └─ executeCommand() → WebGPUDrawCommand.execute(renderPass)
```

#### Core Design Principles

1. **Preserve WebGL functionality** — WebGL rendering must continue to work correctly. We **will** modify upstream WebGL files when it improves the overall architecture (e.g., converting `Context.js` to ES6 class, adding `extends GraphicsContext`, adding `View.js` context support), but we must never break existing WebGL rendering behavior. All existing tests must continue to pass.
2. **Backend agnosticism** — `GraphicsContext` is an abstract base class. Both `Context.js` (WebGL) and `WebGPUContext.ts` (WebGPU) extend it. Scene code accesses renderers via `context.getFeatureRenderer('name')`, not direct imports. The long-term target is zero `if (isWebGPU)` checks in scene code.
3. **Configuration-based** — `renderer: 'webgpu'` opt-in, WebGL is the default. Feature detection falls back to WebGL when WebGPU is unavailable.
4. **RTE everywhere** — All WebGPU rendering uses Relative-To-Eye 64-bit emulated precision for planetary-scale accuracy.
5. **Multi-context support** — `ContextRegistry` tracks all active contexts. Each `View` can target a different `GraphicsContext`. `FrameState.context` is updated per-view before each render pass (Option B).
6. **WebGL2 only** — Our fork targets WebGL2 + WebGPU (2 paths), not WebGL1 + WebGL2 + WebGPU (3 paths).

#### Backend-Agnostic Architecture (Implemented Phases A–G)

```
GraphicsContext (abstract base class)
  ├─ id, rendererType, isWebGPU/isWebGL (per-instance)
  ├─ log(level, message) → [CesiumJS:type:shortId] prefix
  ├─ registerFeatureRenderer() / getFeatureRenderer()
  ├─ ContextRegistry (static) — tracks all active contexts
  ├─ Context.js (WebGL) extends GraphicsContext
  └─ WebGPUContext.ts (WebGPU) extends GraphicsContext

View (per-view context)
  ├─ optional graphicsContext constructor param
  ├─ effectiveContext → per-view override OR Scene's default
  └─ scene.createView(camera, viewport, { graphicsContext })

FrameState
  ├─ context / graphicsContext — updated per-view before render
  └─ Matches how CesiumJS already updates frameState.camera per view
```

**Feature Renderer Pattern** (Phase D — 28 of 28 files migrated ✅):
```javascript
// Scene file (backend-agnostic, using FeatureRendererKey enum):
import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";
const fr = context.getFeatureRenderer(FeatureRendererKey.POINT_PRIMITIVE_COLLECTION);
if (fr) { fr.update(this, frameState); return; }
// WebGL code follows as default fallback
```

**FeatureRendererKey Enum** — All 28 feature renderer keys are numeric constants in
`FeatureRendererKey.js`. `GraphicsContext` uses a pre-allocated array indexed by enum
value for O(1) direct access (no string hashing). All 18 scene files that use
`getFeatureRenderer()` have been migrated from string literals to enum constants.

**RenderCommand Path B** (for new features):
Scene code pushes `RenderCommand` objects to `commandList`. At execution time, `execute(context)` delegates to cached native commands (`DrawCommand` for WebGL, `WebGPUDrawCommand` for WebGPU) with dirty-version tracking.

#### Multi-Context Memory Strategies

| Scenario | Strategy | Overhead |
|----------|----------|----------|
| WebGPU + WebGPU split-screen | `WebGPUDevicePool` — one GPUDevice, multiple canvases | ~10% |
| WebGL + WebGPU split-screen | `SharedResourcePool` — SharedArrayBuffer CPU data sharing | ~40-50% |
| Background/PiP rendering | `OffscreenContextSupport` — WebWorker rendering | Minimal |

#### File Organization

```
packages/engine/Source/Renderer/
├── GraphicsContext.ts          ← Abstract base class
├── ContextRegistry.ts          ← Multi-context tracking
├── ContextFactory.ts           ← Async factory with fallback
├── SharedResourcePool.ts       ← SharedArrayBuffer pool
├── OffscreenContextSupport.ts  ← WebWorker background rendering
├── Context.js                  ← WebGL (extends GraphicsContext)
└── WebGPU/                     ← 83+ files
    ├── WebGPUContext.ts         (core, ~1800 lines)
    ├── WebGPUDevicePool.ts      (device sharing)
    ├── WebGPUFeatureRenderers.ts (central registration of 28 renderers)
    ├── WebGPUSceneRenderer.ts   (multi-frustum, all 12 passes)
    ├── WebGPURenderPipelineCache.ts, WebGPUShaderCache.ts (caching)
    ├── WebGPUDrawCommand.ts, WebGPUComputeCommand.ts (commands)
    ├── WebGPUBuffer.ts, WebGPUTexture.ts, WebGPURenderTarget.ts (resources)
    ├── WGSLShaderPreprocessor.ts, WGSLBuiltins.ts, WGSLShaderBuilder.js
    ├── Feature renderers: Billboard, Polyline, Point, Sky, Sun, Moon, etc.
    └── Infrastructure: OIT, PostProcess, Shadow, GroundPrimitive, etc.

packages/engine/Source/Shaders/WebGPU/    ← 67+ .wgsl files
├── Primitive/ (20), Collections/ (7), chunks/ (17)
├── Environment/ (3), PostProcess/ (5), Advanced/ (5)
└── Generated/ (1, from Slang), Globe, Shadow, Model, etc.

Apps/WebGPUTest/                           ← 29 test/demo pages
```

---

### 1b. What We've Completed

#### Architectural Improvements to Upstream Files — ✅ Complete

These modifications improve CesiumJS's architecture for both backends while preserving all existing WebGL functionality:

| File Modified | Change | Why |
|--------------|--------|-----|
| `Context.js` | Converted from constructor function to ES6 `class`, now `extends GraphicsContext` | Enables shared abstract base. Aligns with upstream #8359. Only 4 direct importers; API shape unchanged. |
| `View.js` | Added optional `graphicsContext` param, `effectiveContext` getter, `graphicsContext` getter/setter | Enables per-view backend selection for multi-context rendering |
| `Scene.js` | Added `graphicsContext` and `contextRegistry` getters, `createView()` factory, per-view context updating in render loop | Exposes abstract context to scene-level systems |
| `FrameState.js` | Added `graphicsContext` alias for `context` property | Backend-agnostic access; backward compatible (both properties point to same instance) |
| `ContextFactory.ts` | Removed `as any as GraphicsContext` cast | Context now directly extends GraphicsContext — no type workaround needed |

#### Infrastructure Layer — ✅ Complete (83+ files)

| Category | Files | Key Components |
|----------|-------|----------------|
| **Core Context** | 6 | `WebGPUContext.ts` (~1800 lines), `GraphicsContext.ts` (abstract), `ContextRegistry.ts`, `ContextFactory.ts`, `SharedResourcePool.ts`, `OffscreenContextSupport.ts` |
| **Resource Management** | 12 | Buffer, Texture, Texture3D, CubeMap, CubeMapFace, TextureAtlas, Sampler, RenderTarget, MipmapGenerator, TextureArray, TextureUtilities, ResourceManager |
| **Pipeline & Shaders** | 8 | RenderPipelineCache, ShaderModule, ShaderCache, PipelineDescriptorBuilder, ShaderPreprocessor, WGSLBuiltins (17 chunks), WGSLShaderBuilder, AutoUniforms |
| **Commands & Rendering** | 8 | DrawCommand, ComputeCommand, ComputeEngine, SceneRenderer, PassState, DerivedCommand, RenderBundleManager, IndirectDrawManager |
| **Framebuffers** | 5 | FramebufferManager, SceneFramebuffer, MultisampleFramebuffer, GlobeDepth, DepthPlane |
| **Features** | 6 | OIT, PostProcessPipeline, PickManager, Sync, DeviceLossRecovery, BufferMapper |
| **Data Layers** | 4 | ClippingPlaneCollection, ClippingPolygonCollection, ImageBasedLighting, BrdfLutGenerator, DynamicEnvironmentMapManager |
| **Stubs/Compat** | 9 | WebGLCompatibilityStub (nexus), WebGLStateConverters, VertexArrayFacade, + `Stubs/` domain modules: WebGLStubTypes, WebGLStubTexture, WebGLStubFramebuffer, WebGLStubBuffer, WebGLStubPipelineState, WebGLStubShader |
| **Multi-Context** | 2 | WebGPUDevicePool, StorageBufferPool, GPUCuller |

#### WGSL Shader Library — 67+ files

| Category | Count | Details |
|----------|-------|---------|
| Primitive shaders | 20 | PerInstanceColor (flat/lit/pick/ID), Material (flat/lit/pick/ID/PBR), PBR MetallicRoughness |
| Collection shaders | 7 | Point (color/pick), Billboard (color/pick), Polyline (color/pick), Cloud |
| Environment | 3 | SkyAtmosphere, Sun, Moon |
| Struct/Function chunks | 17 | CameraUniforms, ModelUniforms, LightUniforms, csm_translateRelativeToEye, csm_writeLogDepth, etc. |
| PostProcess | 5 | Tonemapping, FXAA, OITComposite, DepthPlane, GlobeDepthCopy |
| Advanced | 5 | PointCloud, VoxelPrimitive, GaussianSplat, InvertClassification, PointCloudEDL |
| Other | 10+ | BasicColor, BasicTextured, CubeMapPanorama, GlobeTerrain, ShadowMap, GroundPrimitive, ModelPBR, FrustumCull (compute), EllipsoidPrimitive (generated), MipmapBlit |

#### Scene Features — Rendering Status

| Feature | Status | Details |
|---------|--------|---------|
| **Primitive** (flat/lit/pick) | ✅ Renders | 20 shader variants, RTE, geometry data preservation |
| **PointPrimitive** | ✅ Renders | Instanced quads, RTE |
| **Billboard** | ✅ Renders | Instanced quads, atlas textures, RTE |
| **Label** | ✅ Renders | Auto-supported via BillboardCollection |
| **Polyline** | ✅ Renders | Screen-space thick lines, per-segment quads, AA |
| **SkyBox/CubeMapPanorama** | ✅ Renders | Cubemap panorama rendering |
| **SkyAtmosphere** | ✅ Renders | Nishita scattering, ellipsoid geometry, HSB correction |
| **Sun** | ✅ Renders | Procedural texture, billboard quad |
| **Moon** | ✅ Renders | UV sphere mesh, textured diffuse lighting, full RTE |
| **Fog** | ✅ Parameters | Density/brightness extracted for globe shader |
| **Particles** | ✅ Auto-supported | Delegates to BillboardCollection |
| **EquirectangularPanorama** | ✅ Auto-supported | Delegates to Primitive |
| **GoogleStreetView** | ✅ Auto-supported | Creates CubeMapPanorama instances |
| **Globe/Terrain** | ⚠️ Partial | Uncompressed terrain, 4 imagery layers, RTE. No water/fog/atmosphere/clipping. |
| **Model/glTF** | ⚠️ Partial | Basic PBR pipeline, vertex buffer conversion (posHigh/posLow). No skinning/morph/instancing. |
| **Shadow Map** | ⚠️ Partial | Depth texture, cast pipeline, scene integration. Receive-side pending. |
| **Ground Primitive** | ⚠️ Partial | Two-pass stencil pipeline. Full scene integration pending. |
| **OIT** | ⚠️ Infra done | MRT accumulation + composite. Scene integration pending. |
| **Post-Processing** | ⚠️ Infra done | Ping-pong textures, tonemapping, FXAA. Scene integration pending. |
| **Cloud Collection** | ✅ Renderer done | Instanced billboards, procedural noise, RTE. Scene routing pending. |
| **Point Cloud** | ✅ Renderer done | Instanced quads, attenuation, EDL post-process. Scene routing pending. |
| **Voxel** | ✅ Renderer done | Box proxy, ray-marched 3D texture. Scene routing pending. |
| **Gaussian Splat** | ✅ Renderer done | 3D→2D covariance projection, back-to-front alpha. Scene routing pending. |
| **Ellipsoid Primitive** | ✅ Renderer done | Ray-ellipsoid intersection, Phong lighting. Scene routing pending. |
| **Invert Classification** | ✅ Renderer done | Fullscreen composite. Scene routing pending. |
| **Clipping Planes/Polygons** | ✅ Data layers | Texture packing done. Shader integration awaits `clip-distances`. |
| **IBL / BRDF LUT** | ✅ Done | Compute shader BRDF, fallback cubemaps, dynamic env map. |
| **3D Tiles** | ❌ Not started | — |
| **Imagery Layers** | ❌ Not started | — |
| **Pick Framebuffer** | ❌ Not started | — |

#### Rendering Passes — 12 total

| Pass | Status | Notes |
|------|--------|-------|
| 0 ENVIRONMENT | ✅ | SkyBox, SkyAtmosphere, Sun, Moon |
| 1 COMPUTE | ✅ | WebGPU compute dispatch |
| 2 GLOBE | ⚠️ | Initial path (uncompressed, 4 layers) |
| 3 TERRAIN_CLASSIFICATION | ✅ | Stencil pipeline ready |
| 4–7 3D TILE passes | ⚠️ | Infrastructure slots ready, awaiting 3D Tiles pipeline |
| 8 OPAQUE | ✅ | Primitives, Billboards, Polylines, Points |
| 9 TRANSLUCENT | ✅ | OIT flags passed to SceneRenderer |
| 10 VOXELS | ⚠️ | Slot ready |
| 11 GAUSSIAN_SPLATS | ⚠️ | Slot ready |
| 12 OVERLAY | ✅ | Overlay commands |

#### Build & Tooling

| Component | Status |
|-----------|--------|
| WGSL build integration | ✅ `wgslToJavaScript()` in build.js, gulpfile watches .wgsl |
| Slang cross-compilation | ✅ `scripts/compileSlang.js` — optional, pre-compiled .wgsl fallback |
| Split-screen comparison | ✅ `Apps/WebGPUTest/split-screen-comparison.html` |
| WebGPU feature auto-detection | ✅ `_buildFeatureList()` probes adapter, requests all supported features |
| Context-aware logging | ✅ `[CesiumJS:type:shortId]` prefix on all renderer messages |

#### WebGPU Spec Features Enabled

Auto-detected and requested at device creation: `float32-filterable`, `clip-distances`, `dual-source-blending`, `rg11b10ufloat-renderable`, `timestamp-query`, `shader-f16`, texture compression (BC/ETC2/ASTC). Queryable via `context.hasFeature()`.

---

### 1c. Relationship with Upstream CesiumJS

#### How We Differ from Upstream

This is a **fork** of CesiumJS, not a PR. Our primary constraint is maintaining clean merges with the upstream `CesiumGS/cesium` repository.

**What we modify in upstream files (28 scene files):**
- `Scene.js` — 6 WebGPU routing points (createAsync, executeCommand, executeCommands, executeComputeCommands, executeShadowMapCastCommands, resolveFramebuffers)
- `Primitive.js` — 5 interleaved `isWebGPU` checks for geometry data, commands, uniforms
- `PointPrimitiveCollection.js`, `BillboardCollection.js`, `PolylineCollection.js` — Early-return branch to WebGPU renderer
- `SkyAtmosphere.js`, `Sun.js`, `Moon.js`, `ShadowMap.js`, `GlobeSurfaceTileProvider.js`, `CubeMapPanorama.js`, etc. — WebGPU routing
- `Viewer.js`, `CesiumWidget.js` — `createAsync()` + `LoadingOverlay`
- `Context.js` — Converted to ES6 class, extends `GraphicsContext`
- `Matrix4.js` — `setDepthRangeType('webgpu')` for 0-1 NDC depth
- `scripts/build.js`, `gulpfile.js` — WGSL shader compilation
- `package.json` — `@webgpu/types` dependency

**What we add (never conflicts with upstream):**
- `packages/engine/Source/Renderer/WebGPU/` — 83+ files (entire WebGPU renderer)
- `packages/engine/Source/Shaders/WebGPU/` — 67+ WGSL shaders
- `packages/engine/Source/Renderer/ContextRegistry.ts`, `SharedResourcePool.ts`, etc.
- `Apps/WebGPUTest/` — 29 test pages
- `migration_doc/` — Documentation

**Upstream sync procedure:** See `.clinerules` for the full merge procedure. Key points:
- Typical conflicts: `package.json`, scene files with `if (isWebGPU)` blocks, `scripts/build.js`
- Strategy: `git checkout --theirs` then manually re-add WebGPU routing code
- Commit with `--no-verify` to bypass lint-staged on upstream's files
- Verify two-parent merge commit

#### Where We Improve on Upstream

| Improvement | Details |
|-------------|---------|
| **WebGL2-only targeting** | Upstream maintains WebGL1 fallback (34+ branching points). We drop it, reducing from 3 to 2 rendering paths. |
| **Async initialization** | `Viewer.createAsync()` / `Scene.createAsync()` with `LoadingOverlay` — required for WebGPU, benefits all users. |
| **Abstract GraphicsContext** | `GraphicsContext` abstract base class forces parity. TypeScript enforces both backends implement the same API. |
| **Multi-context/multi-view** | `ContextRegistry`, per-view context assignment, `WebGPUDevicePool` for shared GPU resources. |
| **Context-aware logging** | All renderer messages include `[CesiumJS:type:shortId]` prefix. |
| **ES6 class Context.js** | Upstream uses constructor function pattern. Our conversion aligns with upstream's own #8359 initiative. |
| **RenderCommand abstraction** | Backend-agnostic command type for new features, reducing coupling. |
| **Slang shader pipeline** | Optional cross-compilation for future shader maintenance. |

#### Where We Conflict/Diverge

| Conflict Area | Impact | Mitigation |
|---------------|--------|------------|
| 28 modified scene files | Merge conflicts on every upstream sync | Feature Renderer pattern (Phase D) reduces to ~1 line per file. 6 of 28 migrated. |
| `Context.js` ES6 conversion | Upstream may also convert (#8359) — will merge cleanly | Both going to same target syntax |
| `WebGLCompatibilityStub.ts` (~700 lines) | Growing tech debt | `GraphicsContext` factory methods reduce dependency over time |
| `package.json` | `@webgpu/types` dep | Simple merge: keep both |

---

## 2. What Remains

### 2a. Work Remaining (Priority Order)

#### 🔴 Tier 1: Minimal Usable Globe (Blocking)

| # | Feature | Why Critical | Effort | Status |
|---|---------|-------------|--------|--------|
| 1 | **Complete Globe/Terrain rendering** | Can't see Earth without it. Current: uncompressed terrain, 4 imagery layers, fog blending, atmosphere integration. Missing: water mask, clipping, compressed terrain (quantized mesh). | 5-7 days | ⚠️ Fog+atmosphere done |
| 2 | **Imagery layers + providers** | Globe without imagery = blank sphere. Imagery pipeline is renderer-agnostic; `WebGPUGlobeSurfaceRenderer` already supports up to 4 layers via `copyExternalImageToTexture`. All 15+ providers produce standard image sources. Remaining: dynamic layer count >4, reprojection pipeline testing. | 2-3 days | ⚠️ Basic path works |
| 3 | **Multi-frustum rendering** | WebGL splits into near/far frustums for depth precision. `WebGPUSceneRenderer.ts` now iterates far-to-near with opaque near offset, matching the WebGL path. Needs end-to-end integration testing. | 1-2 days | ✅ Implementation done |
| 4 | **Pick framebuffer + GPU readback** | `scene.pick()` is broken. `WebGPUPickFramebuffer.ts` created with `begin/end/endAsync` API, `copyTextureToBuffer` + `mapAsync` readback, spiral search. Needs wiring into `View.js` and `Picking.js`. | 1-2 days | ⚠️ Infrastructure done |
| 5 | **Scene integration for OIT, Post-Processing, Ground Primitives** | `updateAndClearFramebuffers()` now properly computes OIT/PostProcess/GroundPrimitive/InvertClassification flags for WebGPU. `WebGPUSceneRenderer.executeCommands()` receives these flags and uses them. Needs end-to-end testing. | 1-2 days | ⚠️ Wiring done |

**Recent Tier 1 Progress (March 2026):**
- **Globe fog + atmosphere**: `GlobeTerrain.wgsl` enhanced with exponential fog blending, Rayleigh-approximated atmosphere color, minimum brightness, alpha fade-out at extreme distances. `WebGPUGlobeSurfaceRenderer.ts` passes `fogDensity/fogOffset/fogMinimumBrightness` from `frameState.fog` to the WGSL `TileUniforms`.
- **Multi-frustum fix**: `WebGPUSceneRenderer.executeCommands()` now iterates frustums far-to-near (matching WebGL), applies `opaqueFrustumNearOffset` for tearing prevention, saves/restores camera frustum, resets near for translucent pass, calls `uniformState.updatePass()` per pass.
- **Pick framebuffer**: `WebGPUPickFramebuffer.ts` created — offscreen `rgba8unorm` + `depth24plus-stencil8` render targets, staging buffer with 256-byte row alignment, async `mapAsync` readback with fire-and-forget pattern for sync `end()`.
- **Scene integration wiring**: `updateAndClearFramebuffers()` WebGPU path now computes `clearGlobeDepth`, `useDepthPlane`, `useOIT`, `usePostProcess`, `useInvertClassification`, and `useWebVR` flags (previously all hardcoded to `false`). Config flows to `WebGPUSceneRenderer` via `executeCommands()`.
- **Backend agnosticism**: Scene.js constructor now creates `_alternateSceneRenderer` from `FeatureRendererKey.SCENE_RENDERER` via the feature renderer registry — no direct WebGPU import. `createAsync` loads shaders via `sceneRendererFR.initPrimitiveShaders()`. `executeCommands` delegates to `_alternateSceneRenderer`. Remaining `scene.isWebGPU` checks in command dispatch functions are an open architectural issue (see below).

#### ✅ Resolved: Scene.js Backend Agnosticism (March 19, 2026)

**Previous problem:** Scene.js had ~6 `scene.isWebGPU` / `this.isWebGPU` checks in command dispatch functions (`executeCommand`, `executeComputeCommands`, `executeShadowMapCastCommands`, `updateAndClearFramebuffers`, `resolveFramebuffers`). The old `executeShadowMapCastCommands` WebGPU path called `renderShadowCastPass()` which was **never imported** — a latent runtime error.

**Solution implemented:** Added 5 concrete methods to `GraphicsContext` with WebGL-default behavior. `WebGPUContext` overrides each with the WebGPU-specific implementation. Scene.js delegates to context methods — zero `isWebGPU` checks remain in command dispatch.

| Method on GraphicsContext | WebGL Default | WebGPU Override |
|--------------------------|---------------|-----------------|
| `executeDrawCommand(cmd, scene, passState)` | `command.execute(this, passState)` | Dispatches through `currentRenderPassEncoder` |
| `executeComputeCommands(list, sun, engine)` | Sun compute + all via ComputeEngine | Only `isWebGPUComputeCommand` commands |
| `executeShadowMapCastCommands(scene)` | Returns `false` (Scene.js runs WebGL path) | Delegates to `SHADOW_MAP` feature renderer |
| `updateAndClearFramebuffers(scene, pass, color)` | Returns `false` (Scene.js runs WebGL FBO logic) | Sets env state flags, clears via ClearCommand |
| `resolveFramebuffers(scene, passState)` | Returns `false` (Scene.js runs WebGL resolve) | No-op (OIT/post-process not yet wired) |

**Additional changes:**
- Shader init (`initPrimitiveShaders`/`initCollectionShaders`) moved from `Scene.createAsync` to `WebGPUContext._initialize()` — part of the context's own async lifecycle
- Fixed latent bug: `renderShadowCastPass` was called in old Scene.js WebGPU path without being imported — now routed through `FeatureRendererKey.SHADOW_MAP` feature renderer
- `Scene.createAsync` retains redundant shader loading for backward compatibility (harmless no-op since shaders are already loaded during context init)

**Remaining tech debt:**
- `Scene.createAsync` still has shader loading code that's now redundant (should be removed)
- Unused `const { context: ctx } = scene;` in `executeShadowMapCastCommands` WebGL fallback path
- `Scene.isWebGPU` property getter is retained for external API queries (per `.clinerules` — external code CAN query but should NOT branch)
- `panoramaCommand.isWebGPUDrawCommand === true` check in `renderEnvironment` is a command-type check, not a backend check — acceptable

#### 🟡 Tier 2: 3D Content (Essential for Real Use)

| # | Feature | Why Essential | Effort | Status |
|---|---------|--------------|--------|--------|
| 6 | **Full Model/glTF rendering** | Current: basic PBR pipeline with vertex buffer conversion. Missing: full material system, morph targets, skinning, feature ID textures, GPU instancing, all pipeline stages. The Model pipeline is 80+ files in WebGL. | 10-15 days | ⚠️ Initial path |
| 7 | **3D Tiles rendering** | Can't stream city/terrain/building data. Depends on Model pipeline. Tile management (traversal, caching, LOD) is renderer-agnostic, but content rendering needs WebGPU commands. | 5-7 days | ❌ Not started |
| 8 | **Scene routing for Feature Completion Sprint renderers** | 7 new renderers (Cloud, PointCloud, Voxel, GaussianSplat, Ellipsoid, InvertClassification, PointCloudEDL) have full pipelines but their scene files still do `if (isWebGPU) return;` instead of routing to the renderers. | 3-5 days | ❌ Not wired |
| 9 | **Feature Renderer Migration (Phase D)** | 22 of 28 scene files still import from `Renderer/WebGPU/` directly. Migrating to `getFeatureRenderer()` pattern reduces upstream merge conflicts from ~15 lines to ~1 line per file. | 1-2 days each, ~22 files | 6/28 done |

#### 🟢 Tier 3: Visual Quality & Polish

| # | Feature | Impact | Effort | Status |
|---|---------|--------|--------|--------|
| 10 | **Shadow map receive-side** | Cast pipeline works, receive-side (sampling shadow texture in lit shaders) not integrated. | 2-3 days | ⚠️ Cast done |
| 11 | **Appearances/Materials system** | Only 8 of 40+ built-in materials mapped. Material shaders use placeholder textures. | 5-7 days | ⚠️ Partial |
| 12 | **Derived command system integration** | `WebGPUDerivedCommand.ts` exists (depth-only, log-depth, pick, HDR, shadow variants) but not exercised through the scene pipeline. | 2-3 days | ⚠️ Infra done |
| 13 | **Globe translucency** | Requires OIT integration. `GlobeTranslucencyState.js` has graceful skip. | 2-3 days | ❌ |
| 14 | **Clipping shader integration** | Data layers (plane/polygon textures) done. Shader `clip-distances` usage awaits device feature availability on more browsers. | 1-2 days | ⚠️ Data done |

#### ⚪ Tier 4: Testing, Performance, Future

| # | Feature | Impact | Effort |
|---|---------|--------|--------|
| 15 | **Jasmine unit tests** | Zero test coverage for WebGPU code. No CI/CD validation. | 4-6 days |
| 16 | **Automated visual regression (Overlay Diff)** | Split-screen exists but no automated pixel-diff testing. | 3-4 days |
| 17 | **Browser compatibility** | Safari, Firefox WebGPU support testing. | 3-5 days |
| 18 | **Performance benchmarking** | No WebGL vs WebGPU comparison data. No GPU profiling active. | 2-3 days |
| 19 | **Render bundles for terrain** | 50-80% CPU reduction for static tiles. Infrastructure exists. | 3-4 days |
| 20 | **Indirect drawing for 3D Tiles** | GPU-driven rendering. Infrastructure exists. | 5-7 days |
| 21 | **Buffer sub-allocator (ring buffer)** | Zero per-frame buffer creation. | 3-4 days |
| 22 | **WASM terrain tessellation** | HeightmapTessellator.js hotspot, 2-5x speedup. | 3-5 days |
| 23 | **WASM quantized mesh decoding** | QuantizedMeshTerrainData.js, 3-8x speedup. | 3-5 days |
| 24 | **WASM batch frustum culling** | 4-10x speedup with SIMD. | 3-5 days |
| 25 | **Consolidate device loss recovery** | Duplicated in WebGPUContext.ts and WebGPUDeviceLossRecovery.ts. | 1-2 days |
| 26 | **Reduce console.warn/error noise** | 19 instances in WebGPUContext.ts during normal operation. | 1 day |
| 27 | **Slang adoption for new shaders** | Optional cross-compilation pipeline ready, not used for production shaders yet. | Per-shader |

#### Estimated Timeline

| Phase | Scope | Effort |
|-------|-------|--------|
| Globe + Imagery + Pick (Tier 1) | Minimal usable product | 4-6 weeks |
| Model + 3D Tiles (Tier 2) | 3D content loading | 4-6 weeks |
| Visual Quality (Tier 3) | Shadows, materials, OIT, post-process | 3-4 weeks |
| Testing + Performance (Tier 4) | Quality assurance + optimization | 4-6 weeks |
| **Total to full WebGL parity** | | **~20-26 weeks** |
| Performance exceeding WebGL (optional) | GPU-driven rendering, WASM SIMD, render bundles | +4-6 weeks |

---

### 2b. Known Issues

#### Open Issues

| ID | Description | Severity |
|----|-------------|----------|
| **ARCH-3** | `WebGLCompatibilityStub.ts` was ~700 lines — now split into 6 domain modules under `Stubs/` directory (~85-line nexus + 5 domain files). Individual modules can be removed as subsystems migrate. `GraphicsContext` factory methods continue to reduce dependency. | 🟢 Low |
| **STD-1** | Device loss recovery logic duplicated in `WebGPUContext.ts` and `WebGPUDeviceLossRecovery.ts`. | 🟡 Medium |
| **STD-3** | 19 `console.warn/error` calls in `WebGPUContext.ts` during normal operation. Should gate behind debug flag. | 🟡 Medium |
| **TEST-1** | Zero Jasmine unit tests for any WebGPU code. | 🟡 Medium |
| **MAT-1** | Material shaders use placeholder checkerboard texture. | 🟢 Low |
| **S4-2** | ~~WGSL preprocessor: struct auto-resolution missing in chunk-to-chunk transitive deps.~~ Fixed: `_resolveDependencies()` now resolves struct references transitively. | ✅ Resolved |
| **S4-4** | WGSL preprocessor test page uses reimplemented version (not the real preprocessor). | 🟡 Medium |
| **ROUTING** | ~~7 new renderers built but not wired.~~ All 7+1 renderers now properly wired via `getFeatureRenderer(FeatureRendererKey.XXX)` pattern. | ✅ Resolved |
| **PHASE-D** | ~~9 of 28 scene files still directly import from `Renderer/WebGPU/`.~~ Phase D migration **28/28 complete** ✅. Zero scene files directly import from `Renderer/WebGPU/`. | ✅ Resolved |
| **FR-UPDATE** | `FeatureRenderer.update()` was temporarily made optional (with variadic `...args`) in `GraphicsContext.ts` to pass `tsc` pre-commit checks. Many feature renderers (PRIMITIVE, FOG, SHADOW_MAP, GROUND_PRIMITIVE, GLOBE_SURFACE, GLOBE_TRANSLUCENCY, SCENE_RENDERER) don't have an `update()` method — they use specialized entry points (`createCommands`, `getParameters`, `RendererClass`, `init`, etc.). **This should be reverted:** `update()` should be required, and each renderer registration should either provide a proper `update()` implementation or the `FeatureRenderer` interface should be split into sub-types (e.g., `CollectionRenderer`, `SystemRenderer`, `FactoryRenderer`). | 🟡 Tech Debt |

#### Resolved Issues (for reference)

All 30+ previously-tracked issues have been resolved, including: build system integration, `@ts-nocheck` removal, API mismatches in SceneRenderer/OIT, Moon draw commands, Shadow/Ground Primitive draw commands, Model vertex buffer conversion, collection renderer `uniformState` usage, WGSL byte order, log depth registration, ES6 class conversion, and more. See git history for details.

---

### 2c. Risks

#### Technical Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| **28 upstream merge conflict points** | 🔴 High | Phase D migration reduces to ~1 line per file. 19/28 done. Each migration is independent. |
| **WebGLCompatibilityStub growth** | 🟡 Medium | `GraphicsContext` factory methods (`createTexture`, `createBuffer`) reduce dependency. New features should use context factories. |
| **Model/glTF complexity** | 🟡 Medium | 80+ files in WebGL Model pipeline. We have basic PBR; full pipeline (skinning, morph, instancing) is the single largest remaining task. `WGSLShaderBuilder` and `WebGPUAutoUniforms` prerequisites are done. |
| **Zero test coverage** | 🟡 Medium | Any change could break WebGPU rendering undetected. Split-screen comparison tool helps but is manual. |
| **Browser compatibility** | 🟡 Medium | WebGPU spec is stable in Chrome. Safari and Firefox support is evolving. Features like `clip-distances` may not be available on all browsers. |
| **Performance assumptions** | 🟢 Low | No profiling infrastructure active. WebGPU features (render bundles, indirect draw) assume performance benefits that haven't been measured. `WebGPUTimestampProfiler` exists but unused. |

#### Architectural Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Duplicated scene logic** | 🟡 Medium | Scene Logic Extractor pattern applied to 3 collections. Shared logic runs BEFORE backend branch. Remaining files follow same pattern. |
| **Geometry data deep-clone** | ✅ Fixed | Changed from deep-copy to lightweight references. ~50% geometry memory savings. |
| **2D/Columbus View mode** | ✅ Fixed | All 6 `packUniforms` functions now use `uniformState.view/projection` instead of `camera.viewMatrix`. |
| **Feature renderer indirection overhead** | 🟢 Low | One array[index] (~2ns) + virtual dispatch (~5ns) per feature per frame via `FeatureRendererKey` enum. <0.001% of 60fps frame budget. |

#### Strategic Risks

| Risk | Severity | Notes |
|------|----------|-------|
| **Upstream CesiumJS drops WebGL1** | 🟢 Positive | Our WebGL2-only targeting means clean merge. |
| **Upstream adds their own WebGPU** | 🟡 Unknown | CesiumGS hackathon branches (3 small prototypes, 565 commits behind) suggest interest but no committed effort. Our 83+ file implementation is 10-20x more comprehensive. |
| **WebGPU spec changes** | 🟢 Low | We use stable Chrome 113+ spec. `@webgpu/types` at `^0.1.69`. Optional features auto-detected. |

---

## 3. Key Technical Decisions

### RTE (Relative-To-Eye) Precision

All WebGPU rendering uses emulated 64-bit precision. **Mandatory for planetary-scale rendering.**

- **Vertex buffers**: `positionHigh(3) + positionLow(3)` = 6 floats per position
- **Uniforms**: `mvpRelativeToEye` (translation zeroed) + `encodedCameraHigh/Low`
- **Shaders**: `csm_translateRelativeToEye(posHigh, posLow, camHigh, camLow)` = `(posHigh - camHigh) + (posLow - camLow)`
- **Globe terrain variant**: Tile-center-relative positions with center high/low in uniforms (matches WebGL)
- **Shadow maps**: Use `posHigh + posLow` (acceptable — shadow maps are local scope, matches WebGL)
- **RTE audit result**: All 20 primitive shaders, 4 collection shaders, 3 environment shaders — ✅ correct

### Depth Range
WebGPU: 0-1 NDC. WebGL: -1..1. `Matrix4.setDepthRangeType('webgpu')` modifies all 4 projection functions at Scene init.

### Async Initialization
`Viewer.createAsync → CesiumWidget.createAsync → Scene.createAsync` with `LoadingOverlay`. Synchronous constructor still works for WebGL.

### Shader Approach
Hand-written WGSL (not transpiled from GLSL). Higher quality, RTE-aware, but separate maintenance from 607+ GLSL files. Slang cross-compilation pipeline available for future shaders.

### GLSL → WGSL Quick Reference

| GLSL | WGSL |
|------|------|
| `attribute`/`in` | `@location(N)` in struct |
| `uniform` | `@group(G) @binding(B) var<uniform>` |
| `gl_Position` | `@builtin(position)` |
| `gl_PointSize` | N/A (instanced quads) |
| `vec3` / `mat4` | `vec3<f32>` / `mat4x4<f32>` |
| `texture2D(s, uv)` | `textureSample(tex, sampler, uv)` |
| `texelFetch(s, c, l)` | `textureLoad(tex, c, l)` |
| `czm_` prefix | `csm_` prefix |
| `#include` | `#import` via preprocessor |

---

## 4. Industry Comparison & Research

### How Other Engines Handle WebGL/WebGPU

| Engine | Architecture | Shader Strategy | Our Comparison |
|--------|-------------|----------------|----------------|
| **Babylon.js** | `ThinEngine` abstract → `Engine` (WebGL) / `WebGPUEngine`. Zero `if(isWebGPU)` in scene code. | GLSL → SPIRV → WGSL transpilation. Zero hand-written WGSL. | We have `GraphicsContext` abstract base but 28 scene files still have `isWebGPU` checks. Phase D migration is fixing this. |
| **Three.js** | `WebGPURenderer` drop-in replacement for `WebGLRenderer`. Node-based TSL generates both GLSL/WGSL. | TSL node graph → both backends. | We use hand-written WGSL (higher quality) + optional Slang pipeline. |
| **PlayCanvas** | `GraphicsDevice` base class. GPU-driven rendering with indirect draws. Ring-buffer uniforms. | GLSL + WGSL | We have similar abstract base. GPU-driven rendering infrastructure exists but unused. |

### Our Unique Strengths

1. **RTE 64-bit emulated precision** — No other WebGPU engine handles planetary-scale rendering
2. **Multi-frustum rendering** — Infrastructure for depth precision at all zoom levels
3. **Terrain tiling** — Tile-center RTE encoding (correct approach, matches WebGL)
4. **Clean WebGL/WebGPU separation** — WebGL rendering behavior preserved; architectural improvements (ES6 class, abstract base class) benefit both backends

### CesiumGS Hackathon Branches

Three branches (8-14 commits each, 565 behind `main`). All are small prototypes. Our implementation is 10-20x more comprehensive.

| Branch | Key Idea | Our Status |
|--------|----------|------------|
| `webgpu-hackathon-device` | Basic compute pipeline, buffer readback | ✅ Far surpassed |
| `webgpu-hackathon` | Slang shader cross-compilation, WebGL→WebGPU post-processing bridge | ✅ Slang pipeline implemented; bridge is a tracked future option |
| `daniel/webgpu-hackathon` | Subset of above | ✅ Fully subsumed |

---

## 5. WebAssembly & Performance Roadmap

### Current WASM in CesiumJS
Draco (`draco_decoder.wasm`), KTX2 (`basis_transcoder.wasm`), Gaussian splats (`wasm_splats_bg.wasm`), ZIP (`zip-module.wasm`) — all via `TaskProcessor` → Web Worker.

### Planned WASM Optimizations

| Target | Current | Expected Speedup | Effort | Phase |
|--------|---------|-----------------|--------|-------|
| **HeightmapTessellator** | JS (self-documented hotspot) | 2-5x | 3-5 days | Globe |
| **QuantizedMeshTerrainData** | JS (zigzag decode, integer-heavy) | 3-8x | 3-5 days | Globe |
| **Batch frustum culling** | JS (BoundingSphere × 6 planes × 1000s/frame) | 4-10x w/ SIMD | 3-5 days | Performance |
| **Batch RTE encoding** | JS (EncodedCartesian3, per-vertex) | 2-3x | 1-2 days | Performance |
| **Batch matrix multiply** | JS (Matrix4, per-entity per-frame) | 2-4x w/ SIMD | 2-3 days | Performance |
| **Point cloud processing** | JS (octree, LOD, decompression) | 3-5x | 5-7 days | Advanced |

### GPU Compute vs WASM Decision Matrix

| Task | Best Approach | Why |
|------|--------------|-----|
| Terrain tessellation | **WASM** | Complex data dependencies, already in Web Worker |
| Frustum culling (3D Tiles) | **GPU Compute** | Thousands of tiles, single dispatch |
| Frustum culling (terrain) | **WASM SIMD** | Fewer tiles, simpler |
| Atmosphere LUT | **GPU Compute** | Ray marching, perfect for GPU |
| RTE encoding | **WASM** | GPU readback would negate benefit |
| Point cloud sort/LOD | **GPU Compute** | Massive parallelism needed |
| Matrix batch multiply | **WASM SIMD** | GPU overkill for this |

### WebGPU Performance Features (Infrastructure Built, Not Yet Used)

| Feature | Infrastructure | Benefit | When to Activate |
|---------|---------------|---------|-----------------|
| Render bundles | `WebGPURenderBundleManager.ts` | 50-80% CPU reduction for static terrain | Globe phase |
| Indirect drawing | `WebGPUIndirectDrawManager.ts` | GPU-driven 3D Tiles | 3D Tiles phase |
| Storage buffers | `WebGPUStorageBufferPool.ts` | Large point cloud data | Advanced phase |
| GPU frustum culling | `WebGPUGPUCuller.ts` + `FrustumCull.wgsl` | GPU-side visibility | Performance phase |
| Timestamp queries | `WebGPUTimestampProfiler.ts` | GPU profiling | Testing phase |
| Buffer mapping | `WebGPUBufferMapper.ts` | Direct CPU↔GPU access | Performance phase |
| Uniform grouping | `WebGPUUniformGroupManager.ts` | Per-frame/material/object bind groups | Globe phase |

---

## 6. Reference

### Summary Statistics

| Metric | Count |
|--------|-------|
| WebGL shader files | 607+ |
| WebGPU shader files | 67+ (.wgsl) |
| Shader coverage | ~11% |
| WebGL renderer files | 44 |
| WebGPU renderer files | 83+ |
| Scene features with WebGPU | 22+ of 30+ (~55%) |
| Rendering passes functional | 9 of 12 (~75%) |
| Model pipeline WebGPU | 1 of 80+ files |
| Test pages | 29 |
| Jasmine unit tests | 0 |

### Uniform Buffer Layouts (RTE)

**Per-Instance-Color Flat:** mvpRTE(mat4) + camHigh(vec3+pad) + camLow(vec3+pad) = 96 bytes  
**Per-Instance-Color Lit:** + modelViewRTE(mat4) + normalMatrix(mat4) + lightDir(vec3+pad) = 240 bytes  
**Pick:** mvpRTE + camHigh + camLow + pickColor(vec4) = 112 bytes (256-byte aligned)  
**Point Primitives:** mvpRTE + viewportSize(vec2) + splitPosition(f32) + camHigh + camLow

### Development Workflow

1. **Before starting:** Review `.clinerules`, verify backward compatibility
2. **File placement:** Always `packages/engine/Source/`, never root `Source/` (build output)
3. **New WebGPU features:** Use `RenderCommand` (Path B) + `getFeatureRenderer()` pattern
4. **Shared scene logic:** Must run BEFORE `if (context.isWebGPU)` branch (Scene Logic Extractor)
5. **RTE:** Always positionHigh/positionLow, never single position for world-space geometry
6. **Testing:** Run existing Jasmine tests to verify no regressions
