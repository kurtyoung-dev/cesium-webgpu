# CesiumJS WebGPU Migration — Consolidated Status & Review

**Last Updated:** March 2, 2026 (Renderer Layer Completion — Sampler, PassState, Compute, TextureAtlas, VertexArrayFacade, CubeMap loading, Texture cubemap views)
**Repository:** Fork of CesiumGS/cesium with WebGPU additions
**Overall Progress:** ~20% of full WebGL feature parity (renderer layer ~82% complete, SkyBox + ENVIRONMENT pass started, ClearCommand + GPU readback + stencil pipeline + multi-frustum prerequisites done, most rendering features pending)

> **Note on progress estimate:** The previous 45% estimate was overly optimistic. While infrastructure
> is solid, the WebGL renderer has 607 shader files, 44+ renderer abstractions, 80+ Model pipeline
> files, 12 rendering passes, and dozens of visual features (globe, 3D tiles, models, atmosphere,
> shadows, OIT, post-processing, etc.). Our 42 WGSL shaders and Primitive+PointPrimitive support
> represents roughly 15% of the total rendering surface area.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Verification of Completed Work](#verification-of-completed-work)
3. [Complete WebGL Feature Inventory](#complete-webgl-feature-inventory)
4. [Gap Analysis: What's NOT Built Yet](#gap-analysis-whats-not-built-yet)
5. [Missing from Original Plan](#missing-from-original-plan)
6. [Comparison with Other WebGPU Renderers](#comparison-with-other-webgpu-renderers)
7. [Split-Screen / Toggle Testing Requirement](#split-screen--toggle-testing-requirement)
8. [Implementation Architecture Review](#implementation-architecture-review)
9. [Key Technical Decisions](#key-technical-decisions)
10. [File Organization](#file-organization)
11. [Shader Uniform Layouts (RTE)](#shader-uniform-layouts-rte)
12. [Known Issues](#known-issues)
13. [GLSL → WGSL Translation Reference](#glsl--wgsl-translation-quick-reference)
14. [Revised Development Priority Order](#revised-development-priority-order)

---

## Architecture Overview

```
User Code: new Cesium.Viewer('container', { contextOptions: { renderer: 'webgpu' } })
  └─ Viewer.createAsync() → shows LoadingOverlay
      └─ CesiumWidget.createAsync() → Scene.createAsync()
          ├─ ContextFactory.createContext() → WebGPUContext.create() (async GPU adapter/device)
          ├─ initPrimitiveShaders() → fetches .wgsl shader files
          ├─ initCollectionShaders() → fetches collection shader files
          └─ Matrix4.setDepthRangeType('webgpu') → 0-1 depth range

Rendering: Scene.render() → uniformState.update() → Primitive.update()
  ├─ WebGL path (existing, untouched)
  └─ WebGPU path:
      ├─ createWebGPUCommands() / createWebGPUMaterialCommands() → builds GPU pipelines/buffers
      ├─ updateWebGPUCommandUniforms() → per-frame RTE camera matrices
      └─ executeCommand() → WebGPUDrawCommand.execute(renderPass)
```

### Core Design Principles
1. **Zero WebGL breakage** — All WebGL code untouched, WebGPU is purely additive
2. **Pure WebGPU** — No WebGL/WebGPU code mixing in renderer
3. **Configuration-based** — `renderer: 'webgpu'` opt-in, WebGL default
4. **RTE everywhere** — All rendering uses Relative-To-Eye 64-bit emulated precision

---

## Verification of Completed Work

> All items below have been **independently verified** by examining actual source files on March 1, 2026.

### ✅ CONFIRMED — Infrastructure Layer (23 files in `Renderer/WebGPU/`)

| File | Verified | Notes |
|------|----------|-------|
| `WebGPUContext.ts` | ✅ ~1,800 lines | Device, canvas, frame management, multi-pass, device loss recovery |
| `WebGPUBuffer.ts` | ✅ | Vertex, index, uniform, storage buffers |
| `WebGPUTexture.ts` | ✅ | 2D, 3D, cubemap textures |
| `WebGPUShaderModule.ts` | ✅ | WGSL shader compilation |
| `WebGPUShaderCache.ts` | ✅ | Async compilation, statistics, preloading |
| `WebGPURenderPipelineCache.ts` | ✅ | Pipeline caching, async creation |
| `WebGPURenderTarget.ts` | ✅ | MSAA, MRT, dynamic resize |
| `WebGPUPipelineDescriptorBuilder.ts` | ✅ | Fluent builder API |
| `WebGPUDrawCommand.ts` | ✅ | Multi-buffer, multi-bind-group draw commands |
| `WebGLCompatibilityStub.ts` | ✅ | ~700-line extracted WebGL shim for legacy paths |
| `WGSLShaderPreprocessor.ts` | ✅ | `#import`, `#ifdef`, topological sort |
| `WGSLBuiltins.ts` | ✅ | 13 built-in shader chunks |
| `WebGPUMipmapGenerator.ts` | ✅ | Blit-based mipmap generation |
| `WebGPUPrimitiveShaders.js` | ✅ | Shader selection, fetch-based .wgsl loading |
| `WebGPUPrimitiveCommands.js` | ✅ | Command creation, RTE uniform updates |
| `WebGPUPointPrimitiveRenderer.js` | ✅ | Instanced quad points |
| `WebGPUCollectionShaders.js` | ✅ | Shader loader for collection rendering |
| `WebGPUPickManager.ts` | ✅ | Pick ID management |
| `WebGPUResourceManager.ts` | ✅ | Resource lifecycle |
| `WebGPUDeviceLossRecovery.ts` | ✅ | 3 retries, exponential backoff |
| `WebGPUTextureUtilities.ts` | ✅ | Texture helpers |
| `WebGLStateConverters.ts` | ✅ | State conversion utilities |

Also verified in `Renderer/`:
- `RendererType.ts` ✅ — WebGL/WebGPU/Auto enum + feature detection
- `GraphicsContext.ts` ✅ — Abstract interface
- `ContextFactory.ts` ✅ — Async factory with fallback logic

### ✅ CONFIRMED — WGSL Shader Library (42 files)

| Category | Count | Verified |
|----------|-------|----------|
| Standalone shaders | 6 | ✅ BasicColor, BasicTextured, PhongLighting, PBRMetallicRoughness, FlexibleGeometry, MipmapBlit |
| Struct chunks | 5 | ✅ CameraUniforms, ModelUniforms, LightUniforms, LightingUniforms, PBRMaterial |
| Function chunks | 9 | ✅ csm_constants, csm_translateRelativeToEye, csm_distributionGGX, csm_geometrySmith, csm_fresnelSchlick, csm_phong, csm_tonemapping, csm_gammaCorrection, csm_getNormalFromMap |
| Primitive shaders | 20 | ✅ 4 per-instance + 6 pick + 8 material + 2 PBR |
| Collection shaders | 2 | ✅ PointPrimitiveColor, PointPrimitivePick |

**Note:** The build system only copies 5 top-level .wgsl files to `Build/` and `packages/engine/`. The `Primitive/`, `Collections/`, and `chunks/` subdirectories are only present in `Source/Shaders/WebGPU/` and loaded at runtime via fetch. This may need build system integration for production.

### ✅ CONFIRMED — Scene Integration

| Feature | Verified | Details |
|---------|----------|---------|
| `Scene.createAsync()` | ✅ | Async WebGPU context + shader preload |
| `scene.isWebGPU` property | ✅ | Renderer detection via `context.rendererType` |
| `executeCommand()` WebGPU routing | ✅ | Checks `command.isWebGPUDrawCommand` |
| `Matrix4.setDepthRangeType('webgpu')` | ✅ | Modifies all 4 projection functions for 0-1 depth |
| `initPrimitiveShaders()` at startup | ✅ | Imported from `WebGPUPrimitiveShaders.js` |
| `initCollectionShaders()` at startup | ✅ | Imported from `WebGPUCollectionShaders.js` |
| `Viewer.createAsync()` | ✅ | Shows LoadingOverlay, delegates to CesiumWidget.createAsync |
| `CesiumWidget.createAsync()` | ✅ | Creates Scene.createAsync with `_preInitializedScene` |
| `LoadingOverlay.js` | ✅ | Full UI component with progress bar |

### ✅ CONFIRMED — Primitive.js Integration

| Feature | Verified |
|---------|----------|
| WebGPU geometry data preservation | ✅ `primitive._webgpuGeometryData` deep clone before WebGL consumes buffers |
| `createWebGPUCommands()` routing | ✅ When `isWebGPU && !hasMaterial` |
| `createWebGPUMaterialCommands()` routing | ✅ When `isWebGPU && hasMaterial` |
| Per-frame `updateWebGPUCommandUniforms()` | ✅ Called for color commands each frame |
| Per-frame `updateWebGPUPickCommandUniforms()` | ✅ Called for pick commands each frame |
| WebGL shader/RS creation skipped | ✅ `createRS && !isWebGPU`, `createSP && !isWebGPU` |

### ✅ CONFIRMED — PointPrimitiveCollection.js Integration

| Feature | Verified |
|---------|----------|
| WebGPU rendering path | ✅ `if (context.isWebGPU)` early return |
| `updateWebGPUPointPrimitives()` | ✅ Called with frameState and commandList |
| `destroyWebGPUPointResources()` | ✅ Called on destroy |

### ✅ CONFIRMED — Test Pages

27+ HTML test pages in `Apps/WebGPUTest/` verified.

---

## Complete WebGL Feature Inventory

This is a comprehensive catalog of **every rendering feature** in the WebGL renderer, with WebGPU status.

### Renderer Layer (44 files in `packages/engine/Source/Renderer/`)

| WebGL Component | Purpose | WebGPU Equivalent | Status |
|----------------|---------|-------------------|--------|
| `Context.js` | WebGL context, state, draw calls, readPixels | `WebGPUContext.ts` | ✅ Done |
| `ShaderProgram.js` | GLSL compilation, linking, uniform discovery | `WebGPUShaderModule.ts` | ✅ Done |
| `ShaderSource.js` | Shader preprocessing, `#define`, built-in deps | `WGSLShaderPreprocessor.ts` | ✅ Done |
| `ShaderCache.js` | Compiled shader caching | `WebGPUShaderCache.ts` | ✅ Done |
| `ShaderBuilder.js` | Programmatic shader construction | `WGSLShaderBuilder.js` | ✅ Done |
| `Framebuffer.js` | FBO: color/depth/stencil attachments | `WebGPURenderTarget.ts` | ✅ Done |
| `MultisampleFramebuffer.js` | MSAA FBOs + blitFramebuffer resolve | `WebGPURenderTarget.ts` (partial) | ⚠️ Partial |
| `FramebufferManager.js` | Higher-level FBO lifecycle | `WebGPUFramebufferManager.ts` | ✅ Done |
| `DrawCommand.js` | Draw call encapsulation (VA, shader, state, pass) | `WebGPUDrawCommand.ts` | ✅ Done |
| `ClearCommand.js` | Color/depth/stencil clear | `WebGPUContext.ts` (built-in) | ✅ Done |
| `ComputeCommand.js` | GPGPU compute via viewport quad | `WebGPUComputeCommand.ts` | ✅ Done (real compute shaders) |
| `ComputeEngine.js` | Fragment-based GPGPU execution | `WebGPUComputeEngine.ts` | ✅ Done (pipeline cache, batch dispatch) |
| `Buffer.js` | VBO/IBO/UBO management | `WebGPUBuffer.ts` | ✅ Done |
| `Texture.js` | 2D textures (upload, resize, copy, generateMipmap) | `WebGPUTexture.ts` | ✅ Done |
| `Texture3D.js` | 3D textures (voxels) | `WebGPUTexture.ts` (partial) | ⚠️ Partial |
| `CubeMap.js` / `CubeMapFace.js` | Cubemap textures (sky, environment) | `WebGPUTexture.ts` (partial) | ⚠️ Partial |
| `TextureAtlas.js` | Dynamic texture atlas (billboards, labels) | `WebGPUTextureAtlas.ts` | ✅ Done (bin-packing, GPU-side resize) |
| `TextureCache.js` | Texture caching | Reused directly in `WebGPUContext.ts` | ✅ Done (context creates TextureCache) |
| `Sampler.js` | Texture samplers | `WebGPUSampler.ts` | ✅ Done (CesiumJS→WebGPU mapping, cache, presets) |
| `RenderState.js` | Blend, depth, stencil, cull state objects | Pipeline state in `WebGPURenderPipelineCache.ts` | ✅ Done |
| `UniformState.js` | Per-frame uniform auto-binding (200+ uniforms) | Reused directly (renderer-agnostic) | ✅ Done |
| `AutomaticUniforms.js` | `czm_*` automatic uniform resolution | `WebGPUAutoUniforms.js` | ✅ Done |
| `VertexArray.js` | VAO management | N/A (WebGPU uses buffer layouts) | ✅ Done |
| `VertexArrayFacade.js` | Multi-buffer vertex array for collections | `WebGPUVertexArrayFacade.ts` | ✅ Done (writer pattern, buffer layouts) |
| `Pass.js` | Rendering pass enum (12 passes) | Reused directly (renderer-agnostic) | ✅ Reused |
| `PassState.js` | Per-pass state (viewport, scissor, framebuffer) | `WebGPUPassState.ts` | ✅ Done (viewport, scissor, stencil, render target) |
| `Renderbuffer.js` | Depth/stencil renderbuffers | `WebGPURenderTarget.ts` | ✅ Done |
| `Sync.js` | GPU fence synchronization (WebGL2) | — | ❌ Not started |
| `loadCubeMap.js` | Cubemap image loading | `loadCubeMapWebGPU.ts` | ✅ Done (parallel face loading, cross layout, mipmaps) |
| `createUniform.js` / `createUniformArray.js` | Uniform type factories | N/A (manual in WGSL) | ✅ N/A |
| `demodernizeShader.js` | WebGL2→WebGL1 shader downgrade | N/A (WGSL only) | ✅ N/A |

### Scene Rendering Passes (12 passes in `Pass.js`)

| Pass | Name | What It Renders | WebGPU Status |
|------|------|----------------|---------------|
| 0 | `ENVIRONMENT` | SkyBox, SkyAtmosphere, Sun, Moon | ⚠️ SkyBox done |
| 1 | `COMPUTE` | GPU compute commands (sun position, etc.) | ❌ Not started |
| 2 | `GLOBE` | Terrain/globe surface tiles | ❌ Not started |
| 3 | `TERRAIN_CLASSIFICATION` | Ground-level classification polygons | ❌ Not started |
| 4 | `CESIUM_3D_TILE_EDGES` | 3D Tiles edge visibility | ❌ Not started |
| 5 | `CESIUM_3D_TILE` | 3D Tiles rendering | ❌ Not started |
| 6 | `CESIUM_3D_TILE_CLASSIFICATION` | Classification on 3D Tiles | ❌ Not started |
| 7 | `CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW` | Invert classification stencil | ❌ Not started |
| 8 | `OPAQUE` | Opaque primitives, entities, models | ✅ Primitives only |
| 9 | `TRANSLUCENT` | Translucent primitives (with OIT) | ⚠️ Basic (no OIT) |
| 10 | `VOXELS` | Voxel rendering | ❌ Not started |
| 11 | `GAUSSIAN_SPLATS` | Gaussian splat rendering | ❌ Not started |
| 12 | `OVERLAY` | 2D overlay commands | ❌ Not started |

### Scene Visual Features

| Feature | WebGL Files | Complexity | WebGPU Status |
|---------|------------|------------|---------------|
| **Globe/Terrain** | Globe.js, GlobeSurfaceTile.js, GlobeSurfaceTileProvider.js, GlobeSurfaceShaderSet.js, GlobeDepth.js, QuadtreePrimitive.js, GlobeTranslucency*.js (8+ files) | 🔴 Very High | ❌ Not started |
| **Model/glTF** | Model.js + 80+ Model pipeline files (pipeline stages, loaders, render resources) | 🔴 Very High | ❌ Not started |
| **3D Tiles** | Cesium3DTileset.js + 20+ tile management files, traversal, caching | 🔴 Very High | ❌ Not started |
| **Billboard collection** | Billboard.js, BillboardCollection.js, BillboardTexture.js, TextureAtlas | 🟡 High | ❌ Not started |
| **Label collection** | Label.js, LabelCollection.js (uses Billboards internally) | 🟡 High | ❌ Not started |
| **Polyline collection** | Polyline.js, PolylineCollection.js, PolylineColorAppearance.js, PolylineMaterialAppearance.js | 🟡 High | ❌ Not started |
| **Ground primitives** | GroundPrimitive.js, GroundPolylinePrimitive.js, ClassificationPrimitive.js | 🟡 High | ❌ Not started |
| **Shadow mapping** | ShadowMap.js, ShadowMapShader.js, ShadowMode.js, ShadowVolumeAppearance.js | 🟡 High | ❌ Not started |
| **OIT (Order-Independent Transparency)** | OIT.js (MRT or multi-pass weighted average) | 🟡 Medium | ❌ Not started |
| **Post-processing** | PostProcessStage.js, PostProcessStageCollection.js, PostProcessStageLibrary.js, PostProcessStageComposite.js, PostProcessStageTextureCache.js, SunPostProcess.js | 🟡 High | ❌ Not started |
| **SkyBox** | SkyBox.js (cubemap) | 🟢 Low | ✅ Done — `SkyBox.wgsl` + WebGPU path in `SkyBox.js` |
| **SkyAtmosphere** | SkyAtmosphere.js (ray-marched atmosphere) | 🟡 Medium | ❌ Not started |
| **Sun** | Sun.js, SunPostProcess.js, SunLight.js | 🟡 Medium | ❌ Not started |
| **Moon** | Moon.js | 🟢 Low | ❌ Not started |
| **Fog** | Fog.js | 🟢 Low | ❌ Not started |
| **Particles** | ParticleSystem.js, Particle.js, ParticleBurst.js, ParticleEmitter.js, + emitters | 🟡 Medium | ❌ Not started |
| **Cloud collection** | CloudCollection.js, CumulusCloud.js | 🟡 Medium | ❌ Not started |
| **Point clouds** | PointCloud.js, PointCloudEyeDomeLighting.js, PointCloudShading.js, TimeDynamicPointCloud.js | 🟡 Medium | ❌ Not started |
| **Voxels** | VoxelPrimitive.js + 12 voxel files | 🟡 Medium | ❌ Not started |
| **Gaussian splats** | GaussianSplatPrimitive.js + 4 files | 🟡 Medium | ❌ Not started |
| **Ellipsoid primitive** | EllipsoidPrimitive.js | 🟢 Low | ❌ Not started |
| **Clipping planes/polygons** | ClippingPlaneCollection.js, ClippingPolygonCollection.js | 🟡 Medium | ❌ Not started |
| **Invert classification** | InvertClassification.js | 🟡 Medium | ❌ Not started |
| **Image-based lighting** | ImageBasedLighting.js, DynamicEnvironmentMapManager.js, BrdfLutGenerator.js | 🟡 Medium | ❌ Not started |
| **Depth plane** | DepthPlane.js | 🟢 Low | ❌ Not started |
| **Globe depth** | GlobeDepth.js (depth readback for picking, terrain clamping) | 🟡 Medium | ❌ Not started |
| **Pick framebuffer** | PickDepth.js, PickDepthFramebuffer.js | 🟡 Medium | ❌ Not started |
| **Imagery layers** | ImageryLayer.js, ImageryLayerCollection.js, 15+ imagery providers | 🟡 High | ❌ Not started |
| **Multi-frustum rendering** | FrustumCommands.js (near/far frustum split for depth precision) | 🟡 Medium | ❌ Not started |

### Scene Infrastructure

| Feature | WebGL Implementation | WebGPU Status |
|---------|---------------------|---------------|
| **Appearances system** | 10+ appearance classes (Material, Ellipsoid, PerInstance, Polyline, etc.) | ⚠️ Partial (8 material types mapped) |
| **Material system** | Material.js + Fabric JSON + 40+ built-in materials | ⚠️ Partial (placeholder textures) |
| **Derived commands** | DerivedCommand.js (shadow/translucent/pick command derivation) | ❌ Not started |
| **Batch table** | BatchTable.js, BatchTableHierarchy.js (per-feature attributes) | ⚠️ Partial (color only) |
| **Feature picking** | Per-feature pick IDs, readPixels GPU readback | ⚠️ Partial (pick commands exist, GPU readback via `readPixelsToPBO` + `readPixelsAsync` now implemented) |
| **Camera** | Camera.js, CameraFlightPath.js, CameraEventAggregator.js | ✅ Reused (renderer-agnostic) |
| **Stencil operations** | StencilConstants.js, StencilFunction.js, StencilOperation.js | ❌ Not started for WebGPU |
| **Credit display** | CreditDisplay.js | ✅ Reused (DOM-based) |
| **Frame state** | FrameState.js | ✅ Reused (renderer-agnostic) |
| **Job scheduler** | JobScheduler.js | ✅ Reused |

---

## Gap Analysis: What's NOT Built Yet

### Tier 1 — Required for Minimal Usable Globe (Must Have)

| # | Feature | Impact | Effort | Dependencies |
|---|---------|--------|--------|-------------|
| 1 | **Globe/Terrain rendering** | Can't see Earth | 7-10 days | Terrain tile shaders, quadtree, imagery |
| 2 | **Imagery layers** | No satellite imagery on globe | 3-5 days | Globe |
| 3 | **Multi-frustum rendering** | Depth precision issues at all zoom levels | 3-4 days | Core rendering loop |
| 4 | **Pick framebuffer + GPU readback** | `scene.pick()` broken | 2-3 days | WebGPU readback API |
| 5 | **Stencil operations** | Classification, ground primitives broken | 2-3 days | Pipeline state |

### Tier 2 — Required for 3D Content (Essential)

| # | Feature | Impact | Effort | Dependencies |
|---|---------|--------|--------|-------------|
| 6 | **Model/glTF rendering** | Can't load 3D models | 10-15 days | ShaderBuilder, pipeline stages |
| 7 | **3D Tiles rendering** | Can't stream city/terrain data | 5-7 days | Model pipeline |
| 8 | **Billboard collection** | No image markers | 4-5 days | TextureAtlas |
| 9 | **Label collection** | No text labels | 3-4 days | Billboard |
| 10 | **Polyline collection** | No lines on map | 4-5 days | VertexArrayFacade |

### Tier 3 — Required for Visual Quality (Important)

| # | Feature | Impact | Effort | Dependencies |
|---|---------|--------|--------|-------------|
| 11 | **OIT** | Translucent rendering artifacts | 3-4 days | MRT framebuffers |
| 12 | **Shadow mapping** | No shadows | 4-5 days | Shadow framebuffer, derived commands |
| 13 | **Post-processing** | No bloom, FXAA, SSAO, HDR | 5-7 days | Framebuffer chain |
| 14 | **SkyBox** | No sky background | 1-2 days | Cubemap loading |
| 15 | **SkyAtmosphere** | No atmospheric scattering | 2-3 days | Ray-march shader |
| 16 | **Sun/Moon** | No celestial bodies | 2-3 days | Billboard + compute |
| 17 | **Fog** | No distance fog | 1 day | Fragment shader |
| 18 | **Ground primitives / classification** | No ground-clamped geometry | 3-4 days | Stencil, depth |

### Tier 4 — Advanced Features (Nice to Have)

| # | Feature | Impact | Effort | Dependencies |
|---|---------|--------|--------|-------------|
| 19 | **Particles** | No particle effects | 3-4 days | — |
| 20 | **Clouds** | No volumetric clouds | 2-3 days | — |
| 21 | **Point clouds** | No LiDAR data | 3-4 days | — |
| 22 | **Voxels** | No volumetric data | 3-4 days | — |
| 23 | **Gaussian splats** | No splat rendering | 2-3 days | — |
| 24 | **Clipping planes/polygons** | No geometry clipping | 2-3 days | — |
| 25 | **Image-based lighting** | No IBL/environment maps | 2-3 days | — |
| 26 | **Globe translucency** | No translucent globe | 2-3 days | OIT |
| 27 | **Invert classification** | No inverted stencil | 1-2 days | Stencil |

### Tier 5 — Quality & Performance

| # | Feature | Impact | Effort |
|---|---------|--------|--------|
| 28 | **Jasmine unit tests** | No CI/CD testing | 4-6 days |
| 29 | **Compute shaders** | No GPU culling/LOD/particles | 5-7 days |
| 30 | **GPURenderBundle** | Performance optimization | 2-3 days |
| 31 | **Indirect rendering** | GPU-driven draw calls | 3-5 days |
| 32 | **Timestamp/occlusion queries** | No GPU profiling | 1-2 days |
| 33 | **RxJS integration** | .clinerules preference | 2-3 days |
| 34 | **WebAssembly optimization** | Performance-critical paths | 5-10 days |
| 35 | **Browser compat testing** | Safari, Firefox support | 3-5 days |
| 36 | **Build system integration** | WGSL not in production builds | 2-3 days |

---

## Missing from Original Plan

These features were **NOT listed** in the previous migration doc but are required for WebGL parity:

| Feature | Why It's Needed | Severity |
|---------|----------------|----------|
| **Multi-frustum rendering** | WebGL splits rendering into near/far frustums for depth precision. Without this, z-fighting at all zoom levels. | 🔴 Critical |
| **Imagery layers + providers** | Globe without imagery = blank sphere. 15+ imagery providers need to feed textures to terrain. | 🔴 Critical |
| ~~**ShaderBuilder equivalent**~~ | ~~Model/glTF pipeline builds shaders programmatically via `ShaderBuilder.js`. Need WGSL equivalent.~~ | ✅ Resolved → `WGSLShaderBuilder.js` |
| ~~**AutomaticUniforms**~~ | ~~WebGL resolves 200+ `czm_*` uniforms automatically. WebGPU needs equivalent `csm_*` system or manual binding.~~ | ✅ Resolved → `WebGPUAutoUniforms.js` |
| ~~**VertexArrayFacade**~~ | ~~BillboardCollection, PolylineCollection use multi-buffer interleaved vertex management. Need WebGPU approach.~~ | ✅ Resolved → `WebGPUVertexArrayFacade.ts` |
| ~~**TextureAtlas**~~ | ~~Billboards/Labels pack textures into atlases. Need WebGPU texture atlas or texture array approach.~~ | ✅ Resolved → `WebGPUTextureAtlas.ts` |
| **Derived command system** | Shadows, picking, OIT, classification all derive modified commands from originals. Need WebGPU strategy. | 🟡 High |
| ~~**FramebufferManager equivalent**~~ | ~~Higher-level FBO management for OIT, globe depth, post-processing chains.~~ | ✅ Resolved → `WebGPUFramebufferManager.ts` |
| **Stencil buffer operations** | Ground primitives, classification, invert classification all use stencil extensively. | 🟡 High |
| ~~**ComputeCommand / ComputeEngine**~~ | ~~Sun position, BRDF LUT, terrain processing use compute. Should use real compute shaders in WebGPU.~~ | ✅ Resolved → `WebGPUComputeCommand.ts` + `WebGPUComputeEngine.ts` |
| **Particles system** | ParticleSystem was not listed; it's a complete rendering subsystem. | 🟢 Low |
| **Gaussian splats** | New feature in CesiumJS, not listed in original plan. | 🟢 Low |
| **Voxels** | VoxelPrimitive was not listed; it's a complete rendering subsystem. | 🟢 Low |
| **Cloud collection** | CloudCollection was not listed. | 🟢 Low |
| **Ellipsoid primitive** | EllipsoidPrimitive was not listed. | 🟢 Low |
| ~~**Split-screen / toggle testing**~~ | ~~Required by project goals but no implementation exists.~~ | ✅ Resolved → `split-screen-comparison.html` |
| ~~**Build system integration**~~ | ~~Only 5 of 42 WGSL files are copied to Build/ directories. Production builds won't include shaders.~~ | ✅ Resolved → build.js + gulpfile updated |

---

## Comparison with Other WebGPU Renderers

### Feature Matrix vs Babylon.js, Three.js, PlayCanvas WebGPU

| Feature | Babylon.js WebGPU | Three.js WebGPU | PlayCanvas WebGPU | **CesiumJS WebGPU (Ours)** |
|---------|------------------|-----------------|-------------------|---------------------------|
| **Basic rendering** | ✅ Full | ✅ Full | ✅ Full | ✅ Primitives + Points |
| **Compute shaders** | ✅ Full (particle, fluid, post) | ✅ via TSL | ✅ Full | ✅ Infrastructure done (command + engine) |
| **Render bundles** | ✅ Optional | ❌ | ✅ | ❌ Not started |
| **Indirect drawing** | ✅ | ❌ | ✅ | ❌ Not started |
| **Storage buffers** | ✅ Full | ✅ Full | ✅ Full | ⚠️ Factory exists, unused |
| **Async pipeline compilation** | ✅ Full | ✅ Full | ✅ | ✅ Done |
| **Texture arrays** | ✅ | ✅ | ✅ | ❌ Not started |
| **Timestamp queries** | ✅ | ⚠️ Partial | ✅ | ❌ Not started |
| **Buffer mapping** | ✅ Full | ✅ | ✅ | ❌ Not started |
| **GPU-driven rendering** | ⚠️ Partial | ❌ | ✅ | ❌ Not started |
| **Shadow mapping** | ✅ Full | ✅ Full | ✅ Full | ❌ Not started |
| **PBR materials** | ✅ Full | ✅ Full | ✅ Full | ⚠️ Basic (2 shaders) |
| **Post-processing** | ✅ Full | ✅ Full | ✅ Full | ❌ Not started |
| **OIT** | ✅ | ⚠️ Partial | ❌ | ❌ Not started |
| **glTF loading** | ✅ Full | ✅ Full | ✅ Full | ❌ Not started |
| **Device loss recovery** | ✅ | ⚠️ | ⚠️ | ✅ Done |
| **MSAA** | ✅ Full | ✅ Full | ✅ Full | ✅ Done |
| **Mipmap generation** | ✅ | ✅ | ✅ | ✅ Done |
| **Multi-pass rendering** | ✅ Full | ✅ Full | ✅ Full | ✅ Done |

### WebGPU-Specific Advantages We Should Leverage

These are features where WebGPU can **outperform** WebGL that other engines are already using:

| Opportunity | Benefit for CesiumJS | Priority |
|------------|---------------------|----------|
| **Compute shaders for terrain processing** | Terrain mesh generation, normal computation on GPU instead of CPU/workers | 🔴 High |
| **GPU-driven 3D Tiles culling** | Frustum + occlusion culling of thousands of tiles on GPU via compute | 🔴 High |
| **Render bundles for static geometry** | Pre-encode draw commands for terrain, buildings — huge CPU savings | 🟡 Medium |
| **Indirect drawing** | Single draw call for many instances, GPU controls count | 🟡 Medium |
| **Compute-based atmosphere scattering** | Real-time LUT computation for sky rendering | 🟡 Medium |
| **Storage buffers for point clouds** | Direct GPU access to large point datasets | 🟡 Medium |
| **Texture arrays for imagery** | Single bind group for multiple imagery layers | 🟡 Medium |
| **Timestamp queries** | GPU-side profiling for optimization | 🟢 Low |
| **Parallel command encoding** | Multiple command encoders for multi-threaded submit | 🟢 Low (future) |

### Common Pitfalls in WebGL→WebGPU Migration (Awareness)

| Pitfall | Our Status | Mitigation |
|---------|-----------|------------|
| **Global state vs pipeline state objects** | ✅ Handled | `WebGPURenderPipelineCache.ts` manages pipeline state |
| **Synchronous vs async GPU creation** | ✅ Handled | `Scene.createAsync()` / `Viewer.createAsync()` |
| **Depth range -1..1 vs 0..1** | ✅ Handled | `Matrix4.setDepthRangeType('webgpu')` |
| **No `gl_PointSize`** | ✅ Handled | Instanced quads in `WebGPUPointPrimitiveRenderer.js` |
| **No `readPixels` equivalent** | ✅ Handled | `readPixelsToPBO()` + `readPixelsAsync()` + `getBufferData()` in WebGPUContext |
| **No GLSL, must use WGSL** | ✅ Handled | Dedicated WGSL shaders (not transpiled) |
| **No global uniforms** | ✅ Handled | Explicit bind groups with uniform buffers |
| **Buffer alignment (256-byte UBO, 4-byte vertex)** | ✅ Handled | Alignment in `WebGPUPrimitiveCommands.js` |
| **No implicit format conversion** | ⚠️ Partial | Need explicit format handling for all texture paths |

---

## Split-Screen / Toggle Testing Requirement

### Current State: ✅ IMPLEMENTED (Option A — Dual-Viewer)

**File:** `Apps/WebGPUTest/split-screen-comparison.html`

The split-screen comparison tool implements **Option A (Dual-Viewer)** with:
- Two `Viewer` instances side-by-side (WebGL left, WebGPU right via `Viewer.createAsync`)
- Bidirectional camera sync with infinite-loop guard
- Test geometry buttons: colored boxes, spheres, polylines, 50-point cloud
- Entity sync (identical entities added to both viewers)
- Activity log panel with timestamped entries
- Graceful handling when one viewer fails (e.g., no WebGPU support)
- Destroy/recreate capability

**Still needed:** Option C (Overlay Diff) for automated pixel-difference regression testing.

### Design Options (for reference)

#### Option A: Dual-Viewer Split Screen (Recommended)
```
┌──────────────────────┬──────────────────────┐
│                      │                      │
│   WebGL Viewer       │   WebGPU Viewer      │
│   (left half)        │   (right half)       │
│                      │                      │
│   Synced camera      │   Synced camera      │
│   Synced entities    │   Synced entities    │
│                      │                      │
└──────────────────────┴──────────────────────┘
```
- Two `Viewer` instances side-by-side
- Camera sync: when one camera moves, update the other
- Synced entity/primitive creation
- Pixel-diff overlay mode
- Effort: 2-3 days

#### Option B: Toggle Mode
- Single viewer with a button to switch `renderer: 'webgl'` ↔ `renderer: 'webgpu'`
- Requires scene destruction and recreation (renderer can't be changed at runtime)
- Screenshot before/after comparison
- Effort: 1-2 days

#### Option C: Overlay Diff
- Render both to offscreen canvases
- Compute pixel difference and display heatmap
- Most rigorous for automated testing
- Effort: 3-4 days

#### Recommended Approach
Implement **Option A (Dual-Viewer)** first as it provides real-time visual comparison during development, then **Option C (Overlay Diff)** for automated regression testing.

#### Implementation Sketch for Option A
```javascript
// Apps/WebGPUTest/split-screen-comparison.html
const leftContainer = document.getElementById('left');
const rightContainer = document.getElementById('right');

const webglViewer = new Cesium.Viewer(leftContainer); // default WebGL
const webgpuViewer = await Cesium.Viewer.createAsync(rightContainer, {
  contextOptions: { renderer: 'webgpu' }
});

// Camera sync
webglViewer.camera.changed.addEventListener(() => {
  webgpuViewer.camera.setView({
    destination: webglViewer.camera.positionWC,
    orientation: { heading, pitch, roll }
  });
});
```

---

## Implementation Architecture Review

### Does Our Implementation Make Sense? ✅ Yes, with caveats

**What's well-designed:**

1. **Separation of concerns** — WebGPU code is completely isolated in `Renderer/WebGPU/` with no contamination of WebGL paths. This is excellent.

2. **RTE precision handling** — Consistent use of `positionHigh/positionLow` + `translateRelativeToEye` across all 42 WGSL shaders. This is correct and essential for planetary-scale rendering.

3. **Async initialization chain** — `Viewer.createAsync() → CesiumWidget.createAsync() → Scene.createAsync()` with `LoadingOverlay` is clean and user-friendly.

4. **Pipeline/shader caching** — `WebGPURenderPipelineCache.ts` and `WebGPUShaderCache.ts` with async compilation support align with WebGPU best practices.

5. **Configuration-based switching** — `renderer: 'webgpu'` opt-in with WebGL default is the right approach.

6. **Geometry data preservation** — `primitive._webgpuGeometryData` deep-cloning before WebGL consumes buffers is a smart solution to the dual-renderer problem.

**What needs improvement:**

1. ~~**🔴 Build system gap**~~ — ✅ **RESOLVED.** `wgslToJavaScript()` added to build.js; gulpfile watches `.wgsl` changes. All 42 WGSL files now bundled into `packages/engine/`.

2. ~~**🔴 No automatic uniform system**~~ — ✅ **RESOLVED.** `WebGPUAutoUniforms.js` created with ~60 `csm_*` uniforms, profiles (FLAT/LIT/SCENE/GLOBE), buffer layout computation, and WGSL struct generation.

3. **🟡 WebGL compatibility stub dependency** — The ~700-line `WebGLCompatibilityStub.ts` intercepts `gl.*` calls for legacy code paths. This is a pragmatic but fragile approach. As more features are added, this stub will grow unmanageably. Consider a cleaner abstraction.

4. ~~**🟡 Hardcoded shader selection**~~ — ✅ **RESOLVED.** `WGSLShaderBuilder.js` created with programmatic WGSL construction (vertex inputs, outputs, uniform blocks, textures, samplers, custom structs/functions). Model pipeline can now dynamically compose shaders.

5. ~~**🟡 No compute shader infrastructure**~~ — ✅ **RESOLVED.** `WebGPUComputeCommand.ts` and `WebGPUComputeEngine.ts` created with real compute shader dispatch, pipeline caching, batch execution, and indirect dispatch support.

6. ~~**🟢 Backup file cleanup**~~ — ✅ **RESOLVED.** `WebGPUContext_backup.ts` deleted.

### Architectural Recommendations (Updated)

1. ~~**Create `WGSLShaderBuilder`**~~ — ✅ **Done.** `WGSLShaderBuilder.js` created.

2. ~~**Create `WebGPUAutoUniforms`**~~ — ✅ **Done.** `WebGPUAutoUniforms.js` created.

3. ~~**Create `WebGPUFramebufferManager`**~~ — ✅ **Done.** `WebGPUFramebufferManager.ts` created with MSAA support, MRT, dirty tracking, GPURenderPassDescriptor generation, and color/depth texture access.

4. ~~**Create `WebGPUComputePipeline`**~~ — ✅ **Done.** `WebGPUComputeCommand.ts` + `WebGPUComputeEngine.ts` created with pipeline caching, batch dispatch, indirect dispatch, and async pipeline compilation.

5. ~~**Integrate WGSL into build system**~~ — ✅ **Done.** Gulp task and build.js updated.

---

## Key Technical Decisions

### RTE (Relative-To-Eye) Precision
All WebGPU rendering uses emulated 64-bit precision via position high/low split. This is mandatory for planetary-scale rendering. See `.clinerules` for rules.

- **Vertex buffers**: `positionHigh(3) + positionLow(3)` = 6 floats per position
- **Uniforms**: `mvpRelativeToEye` (translation zeroed) + `encodedCameraHigh/Low`
- **Shaders**: `translateRelativeToEye(posHigh, posLow, camHigh, camLow)`
- **Never**: `posHigh + posLow` (defeats the split), single `position` for world geometry

### Matrix4 Depth Range
WebGPU uses 0-1 NDC depth (vs WebGL -1..1). `Matrix4.setDepthRangeType('webgpu')` modifies all 4 projection functions. Set once at Scene initialization.

### Async Initialization
WebGPU requires async GPU device creation. `Scene.createAsync()` / `Viewer.createAsync()` handle this with loading overlay. Synchronous constructor still works for WebGL.

### Multi-Pass Rendering
`WebGPUContext` supports multiple render passes per frame: `beginRenderPass()`, `endCurrentRenderPass()`, `resumeDefaultRenderPass()`. Default pass uses stored clear color.

### WebGL Compatibility Stub
~700-line extracted stub provides real WebGPU buffer/texture operations for legacy code paths that call `gl.*` functions. Tracks state and applies operations.

---

## File Organization

```
packages/engine/Source/Renderer/
├── RendererType.ts
├── GraphicsContext.ts
├── ContextFactory.ts
├── Context.js                    (existing WebGL — UNTOUCHED)
└── WebGPU/                       (32 files)
    ├── WebGPUContext.ts           (core context, ~1800 lines)
    ├── WebGPUBuffer.ts            (vertex, index, uniform, storage buffers)
    ├── WebGPUTexture.ts           (2D, 3D, cubemap — cubemap views fixed)
    ├── WebGPUShaderModule.ts      (WGSL compilation + compute pipeline)
    ├── WebGPUShaderCache.ts       (async compilation, statistics)
    ├── WebGPURenderPipelineCache.ts (pipeline caching, async creation)
    ├── WebGPURenderTarget.ts      (MSAA, MRT, stencil views)
    ├── WebGPUPipelineDescriptorBuilder.ts (fluent builder API)
    ├── WebGPUDrawCommand.ts       (multi-buffer, multi-bind-group draw)
    ├── WebGPUComputeCommand.ts    (NEW — real compute shader dispatch)
    ├── WebGPUComputeEngine.ts     (NEW — pipeline cache, batch dispatch)
    ├── WebGPUFramebufferManager.ts (MSAA, MRT, dirty tracking)
    ├── WebGPUSampler.ts           (NEW — CesiumJS→WebGPU sampler mapping)
    ├── WebGPUPassState.ts         (NEW — per-pass viewport/scissor/stencil)
    ├── WebGPUTextureAtlas.ts      (NEW — bin-packing, GPU-side resize)
    ├── WebGPUVertexArrayFacade.ts (NEW — writer pattern, buffer layouts)
    ├── loadCubeMapWebGPU.ts       (NEW — parallel face loading, cross layout)
    ├── WebGLCompatibilityStub.ts  (~700-line WebGL shim)
    ├── WGSLShaderPreprocessor.ts  (#import, #ifdef, topological sort)
    ├── WGSLBuiltins.ts            (13 built-in shader chunks)
    ├── WGSLShaderBuilder.js       (programmatic WGSL for Model pipeline)
    ├── WebGPUMipmapGenerator.ts   (blit-based mipmap generation)
    ├── WebGPUPrimitiveShaders.js  (shader selection, .wgsl loading)
    ├── WebGPUPrimitiveCommands.js (command creation, RTE uniforms)
    ├── WebGPUPointPrimitiveRenderer.js (instanced quad points)
    ├── WebGPUCollectionShaders.js (collection shader loader)
    ├── WebGPUAutoUniforms.js      (~60 csm_* uniforms, profiles)
    ├── WebGPUPickManager.ts       (pick ID management)
    ├── WebGPUResourceManager.ts   (resource lifecycle)
    ├── WebGPUDeviceLossRecovery.ts (3 retries, exponential backoff)
    ├── WebGPUTextureUtilities.ts  (texture helpers)
    └── WebGLStateConverters.ts    (state conversion utilities)

Source/Shaders/WebGPU/                    (42 files)
├── BasicColor.wgsl, BasicTextured.wgsl, PhongLighting.wgsl, etc. (6)
├── chunks/structs/ (5 .wgsl)
├── chunks/functions/ (9 .wgsl)
├── Primitive/ (20 .wgsl)
└── Collections/ (2 .wgsl)

packages/engine/Source/Scene/
├── Scene.js          (modified — createAsync, isWebGPU, executeCommand routing)
├── Primitive.js      (modified — WebGPU command routing, geometry data preservation)
└── PointPrimitiveCollection.js (modified — WebGPU instanced quad rendering)

packages/engine/Source/Core/
└── Matrix4.js        (modified — setDepthRangeType for 0-1 depth)

packages/widgets/Source/Viewer/
├── Viewer.js         (modified — createAsync with LoadingOverlay)
├── LoadingOverlay.js (new)
└── ../CesiumWidget/CesiumWidget.js (modified — createAsync)

packages/engine/Source/Widget/
└── CesiumWidget.js   (modified — createAsync, _preInitializedScene)

Apps/WebGPUTest/      (28+ test HTML pages)
├── split-screen-comparison.html  (NEW — dual-viewer WebGL vs WebGPU comparison)
└── ... (27 existing standalone demos)
```

---

## Shader Uniform Layouts (RTE)

### Per-Instance-Color (Flat / Basic)
```
Offset 0-15:  mvpRelativeToEye (mat4x4)
Offset 16-19: encodedCameraHigh (vec3 + pad)
Offset 20-23: encodedCameraLow (vec3 + pad)
Total: 24 floats = 96 bytes
```

### Per-Instance-Color (Lit / Phong)
```
Offset 0-15:  mvpRelativeToEye (mat4x4)
Offset 16-31: modelViewRelativeToEye (mat4x4)
Offset 32-47: normalMatrix (mat4x4)
Offset 48-51: encodedCameraHigh (vec3 + pad)
Offset 52-55: encodedCameraLow (vec3 + pad)
Offset 56-59: lightDirection (vec3 + pad)
Total: 60 floats = 240 bytes
```

### Material (Flat)
```
[Same as flat above] + material params starting at offset 24
```

### Material (Lit)
```
[Same as lit above] + material params starting at offset 60
```

### Pick
```
Offset 0-15:  mvpRelativeToEye (mat4x4)
Offset 16-19: encodedCameraHigh (vec3 + pad)
Offset 20-23: encodedCameraLow (vec3 + pad)
Offset 24-27: pickColor (vec4)
Total: 28 floats = 112 bytes (buffer is 256-byte aligned)
```

### Point Primitives
```
Offset 0-15:  mvpRelativeToEye (mat4x4)
Offset 16-17: viewportSize (vec2)
Offset 18:    splitPosition (f32)
Offset 19:    _pad
Offset 20-22: encodedCameraHigh (vec3)
Offset 23:    _pad
Offset 24-26: encodedCameraLow (vec3)
Offset 27:    _pad
```

---

## Known Issues (Open)

| ID | Description | Severity | Status |
|----|-------------|----------|--------|
| BUILD-1 | ~~Only 5 of 42 WGSL files copied to Build/ directories~~ | ~~🔴 HIGH~~ | ✅ **RESOLVED** — `wgslToJavaScript()` added to build.js, all 42 WGSL files now in packages/engine, gulpfile watches .wgsl changes |
| ARCH-1 | ~~No AutomaticUniforms equivalent for WGSL~~ | ~~🔴 HIGH~~ | ✅ **RESOLVED** — `WebGPUAutoUniforms.js` created with ~60 csm_* uniforms, profiles (FLAT/LIT/SCENE/GLOBE), buffer layout computation, and WGSL struct generation |
| ARCH-2 | ~~No ShaderBuilder equivalent for WGSL — blocks Model/glTF pipeline~~ | ~~🔴 HIGH~~ | ✅ **RESOLVED** — `WGSLShaderBuilder.js` created with vertex inputs, outputs, uniform blocks, textures, samplers, storage buffers, custom structs/functions, and `build()` method generating complete WGSL source |
| ARCH-3 | WebGLCompatibilityStub will grow unmanageably as features are added | 🟡 MEDIUM | ❌ Open |
| S4-2 | Struct auto-resolution missing in chunk-to-chunk transitive deps | 🟢 LOW | ❌ Open |
| S4-4 | WGSL preprocessor test page uses reimplemented version | 🟡 MEDIUM | ❌ Open |
| TEST-1 | No Jasmine unit tests for any WebGPU code | 🟡 MEDIUM | ❌ Open |
| MAT-1 | Material shaders use placeholder checkerboard texture | 🟢 LOW | ❌ Open |
| CLEAN-1 | ~~`WebGPUContext_backup.ts` should be deleted~~ | ~~🟢 LOW~~ | ✅ **RESOLVED** — File deleted |
| SPLIT-1 | ~~No split-screen/toggle comparison tool for visual QA~~ | ~~🟡 MEDIUM~~ | ✅ **RESOLVED** — `Apps/WebGPUTest/split-screen-comparison.html` created with dual-viewer (WebGL left, WebGPU right), bidirectional camera sync, test geometry buttons (boxes, spheres, polylines, points), and activity log |
| CLEAR-1 | ~~ClearCommand.execute() was a no-op in WebGPU — broke multi-frustum depth/stencil clears~~ | ~~🔴 HIGH~~ | ✅ **RESOLVED** — `WebGPUContext.clear()` now ends the active render pass and begins a new one with `loadOp:"clear"` for requested channels and `loadOp:"load"` for others, enabling per-frustum depth/stencil clears |
| PICK-1 | ~~`readPixelsToPBO()` only read from canvas texture, ignoring framebuffer parameter — broke `scene.pick()`~~ | ~~🔴 HIGH~~ | ✅ **RESOLVED** — `readPixelsToPBO()` now resolves source texture from `readState.framebuffer` (WebGPU RenderTarget, FramebufferManager, or legacy WebGL framebuffer). Added `getBufferData(dst)` for `PickFramebuffer.endAsync` compatibility, plus `readPixelsAsync()` convenience method |
| STENCIL-1 | ~~Pipeline builder had no stencil API — blocked ground primitives, classification~~ | ~~🟡 HIGH~~ | ✅ **RESOLVED** — `WebGPUPipelineDescriptorBuilder` now has `enableStencilTest()`, `setStencilReadMask()`, `setStencilWriteMask()`, `setDepthBias()`. `PipelineVariant` and cache key include stencil overrides. `WebGPURenderTarget` has `getStencilTextureView()`, `getDepthOnlyTextureView()`, `getDepthStencilTextureView()`, `hasStencil()` |

---

## GLSL → WGSL Translation Quick Reference

| GLSL | WGSL |
|------|------|
| `attribute` / `in` | `@location(N)` in struct |
| `varying` / `out` | `@location(N)` in struct |
| `uniform` | `@group(G) @binding(B) var<uniform>` |
| `gl_Position` | `@builtin(position)` |
| `gl_PointSize` | N/A (use instanced quads) |
| `gl_FragCoord` | `@builtin(position)` in fragment |
| `gl_FrontFacing` | `@builtin(front_facing)` |
| `vec3` | `vec3<f32>` |
| `ivec3` | `vec3<i32>` |
| `mat4` | `mat4x4<f32>` |
| `texture2D(s, uv)` | `textureSample(tex, sampler, uv)` |
| `texelFetch(s, coord, lod)` | `textureLoad(tex, coord, lod)` |
| `void main()` | `@vertex fn vertexMain()` / `@fragment fn fragmentMain()` |
| `discard` | `discard` |
| `mix(a, b, t)` | `mix(a, b, t)` |
| `clamp(x, lo, hi)` | `clamp(x, lo, hi)` |
| `mod(x, y)` | `x % y` or `x - y * floor(x/y)` |
| `fract(x)` | `fract(x)` |
| `dFdx(x)` / `dFdy(x)` | `dpdx(x)` / `dpdy(x)` |
| `czm_` prefix | `csm_` prefix |
| `#define` | `const` or `#ifdef` via preprocessor |
| `#include` | `#import` via `WGSLShaderPreprocessor` |

---

## Revised Development Priority Order

Based on this comprehensive review, here's the recommended implementation order:

### Phase 1: Foundation Fixes ~~(1-2 weeks)~~ ✅ COMPLETE
1. ~~**Build system integration**~~ — ✅ Done. All 42 WGSL files in production builds
2. ~~**Split-screen comparison tool**~~ — ✅ Done. `split-screen-comparison.html` with dual-viewer
3. ~~**Delete `WebGPUContext_backup.ts`**~~ — ✅ Done
4. **Multi-frustum rendering** — ❌ Still needed. Required for any real scene rendering

### Phase 2: Globe (3-4 weeks) — NEXT PRIORITY
5. **Globe/Terrain rendering** — Most impactful visual feature
6. **Imagery layers** — Satellite imagery on globe
7. ~~**SkyBox**~~ + **SkyAtmosphere** — ✅ SkyBox done (`SkyBox.wgsl` + WebGPU path in `SkyBox.js`). SkyAtmosphere pending.
8. **Sun/Moon + Fog** — Complete environment

### Phase 3: Content Pipeline ~~(4-6 weeks)~~ — Prerequisites Complete
9. ~~**WGSLShaderBuilder**~~ — ✅ Done. `WGSLShaderBuilder.js` created
10. ~~**WebGPUAutoUniforms**~~ — ✅ Done. `WebGPUAutoUniforms.js` created
11. **Model/glTF rendering** — Full model pipeline port (prerequisites now met)
12. **3D Tiles rendering** — Streaming content

### Phase 4: Collections (2-3 weeks)
13. **Billboard collection** — Image markers
14. **Label collection** — Text labels
15. **Polyline collection** — Lines on map

### Phase 5: Visual Quality (3-4 weeks)
16. **OIT** — Translucent rendering
17. **Shadow mapping** — Shadows
18. **Post-processing** — Bloom, FXAA, SSAO
19. **Ground primitives** — Ground-clamped geometry
20. **Pick framebuffer** — GPU readback for scene.pick()

### Phase 6: Advanced Features (3-4 weeks)
21. **Compute shaders** — GPU culling, terrain processing
22. **Render bundles** — Performance optimization
23. **Particles, Clouds, Point clouds** — Additional visual features
24. **Voxels, Gaussian splats** — Volumetric rendering

### Phase 7: Quality & Testing (2-3 weeks)
25. **Jasmine unit tests** — Full test coverage
26. **Automated visual regression tests** — Overlay diff tool
27. **Browser compatibility testing** — Safari, Firefox
28. **Performance benchmarking** — WebGL vs WebGPU comparison

### Total Estimated Timeline: ~20-26 weeks for full WebGL parity

---

## Summary Statistics

| Metric | Count |
|--------|-------|
| WebGL shader files | 607 (303 .glsl) |
| WebGPU shader files | 43 (.wgsl) — includes SkyBox.wgsl |
| Shader coverage | ~7% |
| WebGL renderer files | 44 |
| WebGPU renderer files | 32 + 3 shared (was 25, +7 new: Sampler, PassState, ComputeCommand, ComputeEngine, TextureAtlas, VertexArrayFacade, loadCubeMap) |
| Renderer file coverage | ~82% |
| WebGL Scene features | 30+ major components |
| WebGPU Scene features | 3 (Primitive + PointPrimitive + SkyBox) |
| Scene feature coverage | ~10% |
| WebGL rendering passes | 12 |
| WebGPU rendering passes | 2 (ENVIRONMENT/SkyBox + OPAQUE, partial TRANSLUCENT) |
| Rendering pass coverage | ~15% |
| Model pipeline files | 80+ |
| Model pipeline WebGPU | 0 |
| Test pages | 29+ (standalone demos + split-screen + skybox test) |
| Jasmine unit tests | 0 |
