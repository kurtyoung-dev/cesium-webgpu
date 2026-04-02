# CesiumJS WebGPU Migration — Consolidated Status

**Last Updated:** April 2, 2026 (post upstream sync #2)
**Repository:** Fork of [CesiumGS/cesium](https://github.com/CesiumGS/cesium) → [kurtyoung-dev/cesium-webgpu](https://github.com/kurtyoung-dev/cesium-webgpu)  
**Overall Progress:** ~60% of full WebGL feature parity

---

## Table of Contents

1. [Architecture](#1-architecture)
2. [Completed Work](#2-completed-work)
3. [Remaining Work Summary](#3-remaining-work-summary)
4. [Key Technical Decisions](#4-key-technical-decisions)
5. [Industry Comparison](#5-industry-comparison)
6. [Relationship with Upstream CesiumJS](#6-relationship-with-upstream-cesiumjs)
7. [Known Issues & Risks](#7-known-issues--risks)
8. [Reference](#8-reference)

> **For the full detailed backlog of remaining work, see `WEBGPU_MIGRATION_BACKLOG.md`.**

---

## 1. Architecture

### High-Level Flow

```
User Code: new Cesium.Viewer('container', { contextOptions: { renderer: 'webgpu' } })
  └─ Viewer.createAsync() → shows LoadingOverlay
      └─ CesiumWidget.createAsync() → Scene.createAsync()
          ├─ ContextFactory.createContext() → WebGPUContext.create() (async GPU adapter/device)
          ├─ Shader init in WebGPUContext._initialize() → fetches .wgsl files
          └─ Matrix4.setDepthRangeType('webgpu') → 0-1 NDC depth range

Rendering: Scene.render() → uniformState.update() → per-View context update → Primitive.update()
  ├─ WebGL path (existing, untouched)
  └─ WebGPU path:
      ├─ Feature renderer via context.getFeatureRenderer(FeatureRendererKey.XXX)
      ├─ createWebGPUCommands() → builds GPU pipelines/buffers
      ├─ updateWebGPUCommandUniforms() → per-frame RTE camera matrices
      └─ executeCommand() → WebGPUDrawCommand.execute(renderPass)
```

### Core Design Principles

1. **Preserve WebGL functionality** — WebGL rendering must continue to work. We modify upstream files when it improves architecture (e.g., `Context.js` → ES6 class + `extends GraphicsContext`), but never break existing behavior.
2. **Backend agnosticism** — `GraphicsContext` is an abstract base class. Scene code accesses renderers via `context.getFeatureRenderer(FeatureRendererKey.XXX)`, not direct imports. Target: zero `if (isWebGPU)` checks in scene code.
3. **Configuration-based** — `renderer: 'webgpu'` opt-in, WebGL default. Feature detection falls back to WebGL.
4. **RTE everywhere** — All WebGPU rendering uses Relative-To-Eye 64-bit emulated precision for planetary-scale accuracy.
5. **Multi-context support** — `ContextRegistry` tracks all active contexts. Each `View` can target a different `GraphicsContext`. `FrameState.context` updated per-view before each render pass.
6. **WebGL2 only** — Our fork targets WebGL2 + WebGPU (2 paths), not WebGL1 + WebGL2 + WebGPU (3 paths).

### Backend-Agnostic Architecture (Phases A–G Complete)

```
GraphicsContext (abstract base class)
  ├─ id, rendererType, isWebGPU/isWebGL (per-instance)
  ├─ log(level, message) → [CesiumJS:type:shortId] prefix
  ├─ registerFeatureRenderer() / getFeatureRenderer()  (O(1) array indexed by FeatureRendererKey enum)
  ├─ ContextRegistry (static) — tracks all active contexts
  ├─ 5 concrete command dispatch methods (WebGL defaults, WebGPU overrides)
  ├─ Abstract compute capability API (supportsComputeShaders, supportsStorageBuffers, etc.)
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
import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";
const fr = context.getFeatureRenderer(FeatureRendererKey.POINT_PRIMITIVE_COLLECTION);
if (fr) { fr.update(this, frameState); return; }
// WebGL code follows as default fallback
```

**Scene.js Backend Agnosticism** (✅ Complete): 5 concrete methods on `GraphicsContext` with WebGL-default behavior. `WebGPUContext` overrides each. Zero `isWebGPU` checks remain in Scene.js command dispatch.

### File Organization

```
packages/engine/Source/Renderer/
├── GraphicsContext.ts          ← Abstract base class
├── ContextRegistry.ts          ← Multi-context tracking
├── ContextFactory.ts           ← Async factory with fallback
├── Context.js                  ← WebGL (extends GraphicsContext)
└── WebGPU/                     ← 83+ files
    ├── WebGPUContext.ts         (core, ~1800 lines)
    ├── WebGPUFeatureRenderers.ts (central registration of 28 renderers)
    ├── WebGPUSceneRenderer.ts   (multi-frustum, all 12 passes)
    ├── Feature renderers, caching, resources, commands, etc.

packages/engine/Source/Shaders/WebGPU/    ← 67+ .wgsl files
packages/engine/Source/Scene/             ← Modified scene files + decomposed modules
Apps/WebGPUTest/                           ← 29 test/demo pages
migration_doc/                             ← This documentation
```

---

## 2. Completed Work

### Architectural Improvements to Upstream Files ✅

| File Modified | Change | Why |
|--------------|--------|-----|
| `Context.js` | ES6 class + `extends GraphicsContext` | Enables shared abstract base |
| `View.js` | Optional `graphicsContext` param, `effectiveContext` getter | Per-view backend selection |
| `Scene.js` | `graphicsContext`/`contextRegistry` getters, `createView()`, per-view context updating, **decomposed into 8 modules** (CommandSorter, SceneUtilities, SceneDebug, EnvironmentRenderer, FramebufferOrchestrator, SceneRenderer, ViewportExecutor) | Backend-agnostic facade |
| `FrameState.js` | `graphicsContext` alias for `context` | Backend-agnostic access |
| `Matrix4.js` | `setDepthRangeType('webgpu')` | 0-1 NDC depth |

### Infrastructure Layer ✅ (83+ files)

| Category | Key Components |
|----------|----------------|
| **Core Context** (6) | `WebGPUContext.ts`, `GraphicsContext.ts`, `ContextRegistry.ts`, `ContextFactory.ts`, `SharedResourcePool.ts`, `OffscreenContextSupport.ts` |
| **Resources** (12) | Buffer, Texture, Texture3D, CubeMap, CubeMapFace, TextureAtlas, Sampler, RenderTarget, MipmapGenerator, TextureArray, TextureUtilities, ResourceManager |
| **Pipeline & Shaders** (8) | RenderPipelineCache, ShaderModule, ShaderCache, PipelineDescriptorBuilder, WGSLShaderPreprocessor (with transitive struct resolution), WGSLBuiltins (17 chunks), WGSLShaderBuilder, AutoUniforms |
| **Commands & Rendering** (8) | DrawCommand, ComputeCommand, ComputeEngine, SceneRenderer, PassState, DerivedCommand, RenderBundleManager, IndirectDrawManager |
| **Framebuffers** (5) | FramebufferManager, SceneFramebuffer, MultisampleFramebuffer, GlobeDepth, DepthPlane |
| **Features** (6) | OIT, PostProcessPipeline, PickManager, Sync, DeviceLossRecovery, BufferMapper |
| **Stubs/Compat** (9) | WebGLCompatibilityStub (nexus → 5 domain modules under `Stubs/`), WebGLStateConverters, VertexArrayFacade |
| **Multi-Context** (2) | WebGPUDevicePool, StorageBufferPool, GPUCuller |

### WGSL Shader Library ✅ (75+ files)

| Category | Count | Details |
|----------|-------|---------|
| Primitive shaders | 28 | PerInstanceColor (flat/lit/pick/ID), Material (flat/lit/pick/ID/PBR), PBR MetallicRoughness, RimLighting, AlphaMap, EmissionMap, SpecularMap |
| Collection shaders | 7 | Point (color/pick), Billboard (color/pick), Polyline (color/pick), Cloud |
| Environment | 3 | SkyAtmosphere, Sun, Moon |
| Struct/Function chunks | 17 | CameraUniforms, ModelUniforms, LightUniforms, csm_translateRelativeToEye, csm_writeLogDepth, etc. |
| PostProcess | 5 | Tonemapping, FXAA, OITComposite, DepthPlane, GlobeDepthCopy |
| Advanced | 5 | PointCloud, VoxelPrimitive, GaussianSplat, InvertClassification, PointCloudEDL |
| Compute | 8 | FrustumCull, HiZPyramid, OcclusionTest, PolygonSignedDistance, **AtmosphereLUT**, **PointCloudSort**, **PointCloudLOD**, **GPUSortKeys** |
| Other | 10+ | BasicColor, BasicTextured, CubeMapPanorama, GlobeTerrain, ShadowMap, GroundPrimitive, ModelPBR, EllipsoidPrimitive, MipmapBlit |

### Scene Features — What Renders ✅

| Feature | Status | Key Details |
|---------|--------|-------------|
| **Primitive** (flat/lit/pick) | ✅ | 20 shader variants, RTE, geometry data preservation |
| **PointPrimitive** | ✅ | Instanced quads, RTE |
| **Billboard** | ✅ | Instanced quads, atlas textures, RTE |
| **Label** | ✅ | Auto-supported via BillboardCollection |
| **Polyline** | ✅ | Screen-space thick lines, per-segment quads, AA |
| **SkyBox/CubeMapPanorama** | ✅ | Cubemap panorama rendering |
| **SkyAtmosphere** | ✅ | Nishita scattering, ellipsoid geometry, HSB correction |
| **Sun** | ✅ | Procedural texture, billboard quad |
| **Moon** | ✅ | UV sphere mesh, textured diffuse lighting, full RTE |
| **Fog** | ✅ | Parameters extracted for globe shader |
| **Particles** | ✅ | Auto-supported (delegates to BillboardCollection) |
| **Globe/Terrain** | ✅ | Uncompressed + quantized terrain (BITS12), unlimited imagery layers (multi-pass for >4), fog, atmosphere, water mask + ocean waves, day/night, vertical exaggeration, fill meshes, wireframe debug. 8 tri-list + 4 wireframe pipeline variants. |
| **Model/glTF** | ✅ Feature-complete | PBR pipeline (metallic-roughness, spec-gloss, unlit, 5 textures, alpha modes, vertex colors, normal mapping, skeletal animation/skinning, morph targets, GPU instancing, feature ID textures + batch table styling). Shared extractors (`ModelMaterialInfo.js`, `ModelPrimitiveGeometry.js`, `ModelSkinData.js`, `WebGPUModelFeatureId.js`). 7 bind groups: camera, material+light, textures, skinning, morph targets, instancing, feature ID+batch. 19 material flag bits (0-18). |
| **3D Tiles** | ✅ | Works automatically via Model chain. Zero 3D Tiles code changes. |
| **Materials System** | ✅ | All 25 built-in materials mapped. 48 Primitive + 4 Polyline WGSL shaders. |
| **Pick System** | ⚠️ Near-complete | Pick pass wired, all collection renderers have pick support, depth readback for pick pass works. Missing: scene depth blit shader. |

### Sorting System ✅ (11 phases, 30+ files)

| Component | Status |
|-----------|--------|
| Foundation types (SortMode, RenderLayer, RenderLayerCollection) | ✅ Complete |
| Structured sort properties on DrawCommand/WebGPUDrawCommand | ✅ Complete |
| MaterialSortIdAllocator | ✅ Complete |
| Scene.js multi-level comparators | ✅ Complete |
| RenderScheduler orchestrator | ✅ Complete |
| Entity `renderPriority` → Visualizer → Collection → DrawCommand wiring | ✅ Complete |
| Geometry batch priority grouping | ✅ Complete |
| SceneOctree + OctreeNode (spatial acceleration) | ✅ Built (opt-in, not yet wired into View.js) |
| WASM culling/sorting bridges (JS fallback + Rust crate) | ✅ Built + compiled (17.2 KB binary) |
| Hi-Z occlusion culling shaders + manager | ✅ Built (WebGPU only, not yet wired) |

### Scene.js Decomposition ✅ (All 6 phases complete)

Scene.js reduced from 4,921 → 3,684 lines. 7 modules extracted:
`CommandSorter.js`, `SceneUtilities.js`, `SceneDebug.js`, `EnvironmentRenderer.js`, `FramebufferOrchestrator.js`, `SceneRenderer.js`, `ViewportExecutor.js`

### ES6 Modernization Progress

| Directory | Status |
|-----------|--------|
| **Renderer** | ✅ **29 of 29 JS files converted** |
| **Scene (high priority)** | ✅ All WebGPU-blocking files converted (24+ files) |
| **DataSources (high priority)** | ✅ All sorting-related files converted (8 files) |
| **Scene (medium)** | Partially done (Camera, View, Material, ImageryLayer, Picking, SSCC, etc.) |
| **Core, DataSources, Widgets** | Mostly untouched (~380+ files remaining) |

### Build & Tooling ✅

| Component | Status |
|-----------|--------|
| WGSL build integration | ✅ `wgslToJavaScript()` in build.js, gulpfile watches .wgsl |
| Slang cross-compilation | ✅ `scripts/compileSlang.js` — optional, pre-compiled fallback |
| WASM build pipeline | ✅ `npm run build-wasm` (+ debug/check/clean variants) |
| Split-screen comparison | ✅ `Apps/WebGPUTest/split-screen-comparison.html` |
| WebGPU feature auto-detection | ✅ `_buildFeatureList()` probes adapter |
| Context-aware logging | ✅ `[CesiumJS:type:shortId]` prefix on all renderer messages |

---

## 3. Remaining Work Summary

> **Full details in `WEBGPU_MIGRATION_BACKLOG.md`.**

| Tier | Scope | Effort | Key Items |
|------|-------|--------|-----------|
| ✅ **Tier 1** | Minimal Usable Globe | **COMPLETE** | Imagery reprojection implemented (WebGPU render-to-texture pass), multi-frustum integration done, pick depth blit done, OIT/PostProcess safeguarded. |
| ✅ **Tier 2** | 3D Content | **COMPLETE** | Model PBR + morph targets + skinning + GPU instancing + feature ID textures + batch table styling. All 7 scene collection renderers routed. Imagery layers via globe surface renderer. |
| ✅ **Tier 3** | Visual Quality | **COMPLETE** | Derived commands ✅, globe translucency ✅, shadow receive ✅ (PCF shadow sampling in lit primitive + globe shaders via combined EffectsUniforms bind group), clipping planes ✅ (intersection/union discard + edge highlighting in primitive + globe shaders), globe effects pipeline wiring ✅ (group 4 effects BGL in globe terrain pipeline layout + placeholder bind group). Deferred enhancements: OIT MRT (non-OIT alpha blend fallback works), polygon SDF clipping (plane-based clipping works). |
| ⚪ **Tier 4** | Testing & Performance | ~6 weeks | Unit tests (0 currently), visual regression, browser compat, render bundles, WASM optimizations |
| 📋 **Tech Debt** | Fork cleanup | ~2 weeks | WebGLCompatibilityStub reduction, type helpers adoption, test page standardization |
| 📋 **ES6 Modernization** | Incremental | ~400-600 hrs total | ~380+ files across Core, DataSources, Widgets, remaining Scene |
| 📋 **Sorting Integration** | Sorting system activation | ~1 week | RenderScheduler full integration, octree/occlusion View.js wiring |
| **Total to full WebGL parity** | | **~20-26 weeks** | |

---

## 4. Key Technical Decisions

### RTE (Relative-To-Eye) Precision
All WebGPU rendering uses emulated 64-bit precision. Mandatory for planetary-scale rendering.
- **Vertex buffers**: `positionHigh(3) + positionLow(3)` = 6 floats per position
- **Uniforms**: `mvpRelativeToEye` (translation zeroed) + `encodedCameraHigh/Low`
- **Shaders**: `csm_translateRelativeToEye(posHigh, posLow, camHigh, camLow)`
- **Globe terrain**: Tile-center-relative positions with center high/low in uniforms
- **RTE audit**: All 20 primitive, 4 collection, 3 environment shaders — ✅ correct

### Depth Range
WebGPU: 0-1 NDC. WebGL: -1..1. `Matrix4.setDepthRangeType('webgpu')` at Scene init.

### Async Initialization
`Viewer.createAsync → CesiumWidget.createAsync → Scene.createAsync` with `LoadingOverlay`.

### Shader Approach
Hand-written WGSL (not transpiled from GLSL). Higher quality, RTE-aware. Slang pipeline available for future dual-output shaders.

### Sorting Architecture
Multi-level comparators (Layer → Priority → Material → Distance) chosen over packed 64-bit keys for JS. WASM radix sort uses packed 64-bit keys (Phase 10). Both coexist. See sorting section in backlog for remaining integration work.

### Picking Architecture
GPU color-buffer picking (industry standard). Unique GIS features: height sampling, terrain-aware picking, voxel/metadata picking, diameter-based ray picking. WebGPU pick pass wired. Convenience APIs added (`pickAll`, `pickRayAll`, `pickColumn`).

---

## 5. Industry Comparison

| Engine | Architecture | Shader Strategy | Our Comparison |
|--------|-------------|----------------|----------------|
| **Babylon.js** | `ThinEngine` abstract → `Engine`/`WebGPUEngine`. Zero `if(isWebGPU)` in scene code. | GLSL → SPIRV → WGSL transpilation | We have `GraphicsContext` abstract + Feature Renderer pattern. Phase D migration complete (28/28). |
| **Three.js** | `WebGPURenderer` drop-in for `WebGLRenderer`. Node-based TSL generates both GLSL/WGSL. | TSL node graph → both backends | We use hand-written WGSL (higher quality) + optional Slang. |
| **PlayCanvas** | `GraphicsDevice` base. GPU-driven rendering with indirect draws. Ring-buffer uniforms. | GLSL + WGSL | Similar abstract base. GPU-driven infrastructure exists but unused. |

### Our Unique Strengths
1. **RTE 64-bit emulated precision** — No other WebGPU engine handles planetary scale
2. **Multi-frustum rendering** — Depth precision at all zoom levels
3. **Terrain tiling** — Tile-center RTE encoding (correct approach)
4. **GIS picking** — Height sampling, terrain-aware, voxel/metadata picking
5. **Material system** — All 25 built-in CesiumJS materials mapped to WGSL

### CesiumGS Hackathon Status
Three branches (8-14 commits each, 565 behind `main`). All small prototypes. Our implementation is 10-20x more comprehensive (83+ files vs ~20 combined).

---

## 6. Relationship with Upstream CesiumJS

### What We Modify in Upstream (28 scene files)
- **Scene files** — WebGPU routing via `getFeatureRenderer()` pattern (~1 line per file)
- **Build system** — WGSL shader compilation
- **Package config** — `@webgpu/types` dependency
- **Widget files** — `createAsync()` + `LoadingOverlay`
- **Context.js** — ES6 class + extends `GraphicsContext`

### What We Add (never conflicts)
- `packages/engine/Source/Renderer/WebGPU/` — 83+ files
- `packages/engine/Source/Shaders/WebGPU/` — 75+ WGSL shaders (incl. 8 compute)
- `Apps/WebGPUTest/` — 29 test pages

### Upstream Sync Procedure
See `.clinerules` for full merge procedure. Key: `git checkout --theirs` then re-add WebGPU routing code. Commit with `--no-verify`. Verify two-parent merge.

---

## 7. Known Issues & Risks

### Technical Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| **28 upstream merge conflict points** | 🟡 Medium | Phase D complete — each file has ~1 line of WebGPU routing |
| **WebGLCompatibilityStub** | 🟡 Medium | Split into 6 domain modules. `GraphicsContext` factories reduce dependency. |
| **Model/glTF complexity** | 🟡 Medium | Basic PBR + skinning done. Full pipeline (morph, instancing) is largest remaining task. |
| **Zero test coverage** | 🔴 High | Any change can break WebGPU undetected. Split-screen tool is manual only. |
| **Browser compatibility** | 🟡 Medium | WebGPU stable in Chrome. Safari/Firefox evolving. |

### Open Issues Summary

| Category | Count |
|----------|-------|
| Upstream issues tracked | 91 (42 open, 16 fixed, 14 improved, 15 planned, 4 mitigated) |
| Fork-specific tech debt | 36 (21 resolved, 15 remaining) |
| Sorting system gaps | 5 remaining (3 deferred opt-in features, 1 unit tests, 1 lazy init) |

---

## 8. Reference

### Summary Statistics

| Metric | Count |
|--------|-------|
| WebGL shader files (GLSL) | 319 |
| WebGPU shader files (WGSL) | 235 |
| Compute shaders | 12 |
| Shader coverage (file count) | ~74% (235 WGSL files vs 319 GLSL files — 10 new upstream GLSL: 7 BufferPrimitive/EdgeVisibility + 3 ConstantLod/TextureTransform) |
| Shader coverage (functional) | ~95% (remaining GLSL either consolidated or architecturally handled differently) |
| Builtin function chunks | 91 WGSL (of 90 GLSL — 101% coverage) |
| CsmBuiltins.js entries | 97 (91 functions + 6 structs) |
| WebGL renderer files | 44 |
| WebGPU renderer files | 103 |
| Scene features with WebGPU | 22+ of 30+ (~55%) |
| Rendering passes functional | 9 of 12 (~75%) |
| Test pages | 29 |
| Jasmine unit tests | 0 |
| ES6 modernized files | ~75 (of ~454 total) |

### WebGPU Spec Features Enabled
Auto-detected: `float32-filterable`, `clip-distances`, `dual-source-blending`, `rg11b10ufloat-renderable`, `timestamp-query`, `shader-f16`, texture compression (BC/ETC2/ASTC).

### GLSL → WGSL Quick Reference

| GLSL | WGSL |
|------|------|
| `attribute`/`in` | `@location(N)` in struct |
| `uniform` | `@group(G) @binding(B) var<uniform>` |
| `gl_Position` | `@builtin(position)` |
| `vec3` / `mat4` | `vec3<f32>` / `mat4x4<f32>` |
| `texture2D(s, uv)` | `textureSample(tex, sampler, uv)` |
| `czm_` prefix | `csm_` prefix |
| `#include` | `#import` via preprocessor |

### Uniform Buffer Layouts (RTE)

**Per-Instance-Color Flat:** mvpRTE(mat4) + camHigh(vec3+pad) + camLow(vec3+pad) = 96 bytes  
**Per-Instance-Color Lit:** + modelViewRTE(mat4) + normalMatrix(mat4) + lightDir(vec3+pad) = 240 bytes  
**Pick:** mvpRTE + camHigh + camLow + pickColor(vec4) = 112 bytes  
**Globe Terrain:** CameraUniforms 68 floats + TileUniforms 80 floats, 5 bind groups (uniforms, imagery, water mask, ocean normal, effects)

### Development Workflow

1. **Before starting:** Review `.clinerules`, verify backward compatibility
2. **File placement:** Always `packages/engine/Source/`, never root `Source/` (build output)
3. **New WebGPU features:** Use `RenderCommand` (Path B) + `getFeatureRenderer()` pattern
4. **Shared scene logic:** Must run BEFORE `if (context.isWebGPU)` branch
5. **RTE:** Always positionHigh/positionLow, never single position for world-space geometry
6. **ES6:** When touching a file, modernize it if making >10 lines of changes
7. **Feature parity:** Check both backends when adding/fixing features

---

*For the full backlog of remaining work items, see `WEBGPU_MIGRATION_BACKLOG.md`.*
