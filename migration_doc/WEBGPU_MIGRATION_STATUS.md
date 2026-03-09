# CesiumJS WebGPU Migration — Consolidated Status & Review

**Last Updated:** March 9, 2026 (Code quality review: Fixed build failures (duplicate `const context` in GlobeSurfaceTileProvider.js, missing default export in WebGPUCubeMapPanoramaRenderer.js). Fixed 50 lint errors across 8 WebGPU .js files (49 missing curly braces, 1 unused import). Comprehensive code review of all WebGPU renderer, scene integration, and infrastructure files. Found 3 API mismatch issues in WebGPUSceneRenderer.ts. 64 WebGPU renderer files, 56 WGSL shaders, 29 test pages.)
**Repository:** Fork of CesiumGS/cesium with WebGPU additions
**Overall Progress:** ~35% of full WebGL feature parity (renderer layer ~100% complete with 64 files, all environment features have WebGPU paths, Billboard/Polyline/Label collections have WebGPU renderers, initial Model/glTF pipeline, Shadow map infrastructure, Ground primitive stencil pipeline, OIT enabled for WebGPU, Globe/Terrain initial path done)

> **Note on progress estimate:** With the Tier 1-3 sprint, we now have 56 WGSL shaders, 64 WebGPU
> renderer files, and WebGPU rendering paths for Primitive, PointPrimitive, Billboard, Polyline, Label
> (via Billboard), SkyBox, SkyAtmosphere, Sun, Moon, Fog, Globe/Terrain (initial), plus infrastructure
> for OIT, Shadow maps, Ground primitives, Post-processing, and initial Model/glTF. The WebGL renderer
> has 609+ shader files and 80+ Model pipeline files — our ~56 WGSL shaders and ~14 scene features
> represents roughly 35% of the total rendering surface area.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Verification of Completed Work](#verification-of-completed-work)
3. [Complete WebGL Feature Inventory](#complete-webgl-feature-inventory)
4. [Gap Analysis: What's NOT Built Yet](#gap-analysis-whats-not-built-yet)
5. [Missing from Original Plan](#missing-from-original-plan)
6. [Comparison with Other WebGPU Renderers](#comparison-with-other-webgpu-renderers)
7. [WebGPU Advanced Features & Spec Compliance](#webgpu-advanced-features--spec-compliance) ← **NEW**
8. [WebAssembly Optimization Roadmap](#webassembly-optimization-roadmap) ← **NEW**
9. [CesiumGS Hackathon Branch Analysis](#cesiumgs-hackathon-branch-analysis) ← **NEW**
10. [Split-Screen / Toggle Testing Requirement](#split-screen--toggle-testing-requirement)
11. [Implementation Architecture Review](#implementation-architecture-review)
12. [Key Technical Decisions](#key-technical-decisions)
13. [File Organization](#file-organization)
14. [Shader Uniform Layouts (RTE)](#shader-uniform-layouts-rte)
15. [Known Issues](#known-issues)
16. [GLSL → WGSL Translation Reference](#glsl--wgsl-translation-quick-reference)
17. [Revised Development Priority Order](#revised-development-priority-order)

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
| `WGSLBuiltins.ts` | ✅ | 16 built-in shader chunks (5 structs + 11 functions incl. csm_translateRelativeToEye, csm_decodeRGB8, csm_unpackTexture) |
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

### ✅ CONFIRMED — WGSL Shader Library (45 files)

| Category | Count | Verified |
|----------|-------|----------|
| Standalone shaders | 7 | ✅ BasicColor, BasicTextured, CubeMapPanorama, PhongLighting, PBRMetallicRoughness, FlexibleGeometry, MipmapBlit (SkyBox.wgsl removed — replaced by CubeMapPanorama.wgsl) |
| Struct chunks | 5 | ✅ CameraUniforms, ModelUniforms, LightUniforms, LightingUniforms, PBRMaterial |
| Function chunks | 11 | ✅ csm_constants, csm_translateRelativeToEye, csm_distributionGGX, csm_geometrySmith, csm_fresnelSchlick, csm_phong, csm_tonemapping, csm_gammaCorrection, csm_getNormalFromMap, csm_decodeRGB8, csm_unpackTexture |
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
| `MultisampleFramebuffer.js` | MSAA FBOs + blitFramebuffer resolve | `WebGPUMultisampleFramebuffer.ts` + `WebGPURenderTarget.ts` | ✅ Done (MSAA via resolveTarget, blitFramebuffers is no-op) |
| `FramebufferManager.js` | Higher-level FBO lifecycle | `WebGPUFramebufferManager.ts` | ✅ Done |
| `DrawCommand.js` | Draw call encapsulation (VA, shader, state, pass) | `WebGPUDrawCommand.ts` | ✅ Done |
| `ClearCommand.js` | Color/depth/stencil clear | `WebGPUContext.ts` (built-in) | ✅ Done |
| `ComputeCommand.js` | GPGPU compute via viewport quad | `WebGPUComputeCommand.ts` | ✅ Done (real compute shaders) |
| `ComputeEngine.js` | Fragment-based GPGPU execution | `WebGPUComputeEngine.ts` | ✅ Done (pipeline cache, batch dispatch) |
| `Buffer.js` | VBO/IBO/UBO management | `WebGPUBuffer.ts` | ✅ Done |
| `Texture.js` | 2D textures (upload, resize, copy, generateMipmap) | `WebGPUTexture.ts` | ✅ Done |
| `Texture3D.js` | 3D textures (voxels) | `WebGPUTexture3D.ts` + `WebGPUTexture.ts` | ✅ Done (3D texture wrapper, writeTexture, copyFrom, mipmap) |
| `CubeMap.js` / `CubeMapFace.js` | Cubemap textures (sky, environment) | `WebGPUCubeMap.ts` + `WebGPUCubeMapFace.ts` | ✅ Done (6-face wrapper, per-face views, ImageBitmap upload) |
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
| `Sync.js` | GPU fence synchronization (WebGL2) | `WebGPUSync.ts` | ✅ Done (device.queue.onSubmittedWorkDone(), same API as Sync.js) |
| `loadCubeMap.js` | Cubemap image loading | `loadCubeMapWebGPU.ts` | ✅ Done (parallel face loading, cross layout, mipmaps) |
| `createUniform.js` / `createUniformArray.js` | Uniform type factories | N/A (manual in WGSL) | ✅ N/A |
| `demodernizeShader.js` | WebGL2→WebGL1 shader downgrade | N/A (WGSL only) | ✅ N/A |

### Scene Rendering Passes (12 passes in `Pass.js`)

| Pass | Name | What It Renders | WebGPU Status |
|------|------|----------------|---------------|
| 0 | `ENVIRONMENT` | SkyBox, SkyAtmosphere, Sun, Moon | ✅ Done — SkyBox + SkyAtmosphere + Sun + Moon (RTE uniforms) via WebGPU renderers + Scene.js `renderEnvironment` routing |
| 1 | `COMPUTE` | GPU compute commands (sun position, etc.) | ✅ Scene routing done — `executeComputeCommands()` skips WebGL sun compute, dispatches WebGPU compute commands via `isWebGPUComputeCommand` flag. WebGPUComputeEngine infrastructure ready. |
| 2 | `GLOBE` | Terrain/globe surface tiles | ⚠️ Initial — `GlobeTerrain.wgsl` + `WebGPUGlobeSurfaceRenderer.ts` + `GlobeSurfaceTileProvider.js` routing. Uncompressed terrain, up to 4 imagery layers, RTE positioning. |
| 3 | `TERRAIN_CLASSIFICATION` | Ground-level classification polygons | ✅ Pass infrastructure ready — `WebGPUSceneRenderer.ts` executes TERRAIN_CLASSIFICATION pass. `WebGPUGroundPrimitiveRenderer.js` provides two-pass stencil pipeline. GroundPrimitive→ClassificationPrimitive→Primitive delegation works through existing WebGPU command path. |
| 4 | `CESIUM_3D_TILE_EDGES` | 3D Tiles edge visibility | ⚠️ Pass infrastructure ready — `WebGPUSceneRenderer.ts` has slot for 3D Tile edge commands. Awaiting 3D Tiles content pipeline. |
| 5 | `CESIUM_3D_TILE` | 3D Tiles rendering | ⚠️ Pass infrastructure ready — `WebGPUSceneRenderer.ts` executes this pass. Awaiting 3D Tiles content pipeline. |
| 6 | `CESIUM_3D_TILE_CLASSIFICATION` | Classification on 3D Tiles | ⚠️ Pass infrastructure ready — stencil operations supported via `WebGPUPipelineDescriptorBuilder`. Awaiting 3D Tiles content pipeline. |
| 7 | `CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW` | Invert classification stencil | ⚠️ Pass infrastructure ready — stencil ops supported. Awaiting 3D Tiles content pipeline + invert classification logic. |
| 8 | `OPAQUE` | Opaque primitives, entities, models | ✅ Done — Primitives, Billboards, Polylines, Points all route to WebGPU commands |
| 9 | `TRANSLUCENT` | Translucent primitives (with OIT) | ✅ Scene routing done — OIT feature flags passed to `WebGPUSceneRenderer`. `WebGPUOIT.ts` provides MRT accumulation + composite. `View.js` enables OIT for WebGPU. |
| 10 | `VOXELS` | Voxel rendering | ⚠️ Pass infrastructure ready — `WebGPUSceneRenderer.ts` executes VOXELS pass with back-to-front sort. Awaiting VoxelPrimitive WebGPU implementation. |
| 11 | `GAUSSIAN_SPLATS` | Gaussian splat rendering | ⚠️ Pass infrastructure ready — `WebGPUSceneRenderer.ts` executes GAUSSIAN_SPLATS pass. Awaiting GaussianSplatPrimitive WebGPU implementation. |
| 12 | `OVERLAY` | 2D overlay commands | ✅ Scene routing done — `WebGPUSceneRenderer.ts` handles OVERLAY pass after frustum loop. `executeOverlayCommands()` in Scene.js executes overlay commands. |

### Scene Visual Features

| Feature | WebGL Files | Complexity | WebGPU Status |
|---------|------------|------------|---------------|
| **Globe/Terrain** | Globe.js, GlobeSurfaceTile.js, GlobeSurfaceTileProvider.js, GlobeSurfaceShaderSet.js, GlobeDepth.js, QuadtreePrimitive.js, GlobeTranslucency*.js (8+ files) | 🔴 Very High | ⚠️ Initial WebGPU path — `GlobeTerrain.wgsl` (RTE + 4 imagery layers + lighting), `WebGPUGlobeSurfaceRenderer.ts` (pipeline, VB/IB upload, imagery texture caching), `GlobeSurfaceTileProvider.js` WebGPU routing. 3D mode, uncompressed terrain format. No water/fog/atmosphere/clipping yet. |
| **Model/glTF** | Model.js + 80+ Model pipeline files (pipeline stages, loaders, render resources) | 🔴 Very High | ⚠️ Initial — `WebGPUModelRenderer.js` (PBR pipeline, camera/model/light uniform groups, per-primitive commands) + `ModelPBR.wgsl` (Cook-Torrance BRDF, normal mapping, metallic-roughness). Vertex buffer conversion pending. |
| **3D Tiles** | Cesium3DTileset.js + 20+ tile management files, traversal, caching | 🔴 Very High | ❌ Not started |
| **Billboard collection** | Billboard.js, BillboardCollection.js, BillboardTexture.js, TextureAtlas | 🟡 High | ✅ Done — `WebGPUBillboardRenderer.js` (instanced quads, atlas textures, RTE), `BillboardCollection.wgsl`, `BillboardCollection.js` WebGPU routing in `update()` |
| **Label collection** | Label.js, LabelCollection.js (uses Billboards internally) | 🟡 High | ✅ Auto-supported — LabelCollection delegates to BillboardCollection which now has WebGPU path |
| **Polyline collection** | Polyline.js, PolylineCollection.js, PolylineColorAppearance.js, PolylineMaterialAppearance.js | 🟡 High | ✅ Done — `WebGPUPolylineRenderer.js` (screen-space thick lines, per-segment quads, AA), `PolylineCollection.wgsl`, `PolylineCollection.js` WebGPU routing |
| **Ground primitives** | GroundPrimitive.js, GroundPolylinePrimitive.js, ClassificationPrimitive.js | 🟡 High | ⚠️ Infrastructure — `WebGPUGroundPrimitiveRenderer.js` (two-pass stencil pipeline), `GroundPrimitive.wgsl`. Scene integration pending. |
| **Shadow mapping** | ShadowMap.js, ShadowMapShader.js, ShadowMode.js, ShadowVolumeAppearance.js | 🟡 High | ⚠️ Infrastructure — `WebGPUShadowMapRenderer.js` (depth texture, cast pipeline, PCF sampling), `ShadowMap.wgsl`. Scene integration pending. |
| **OIT (Order-Independent Transparency)** | OIT.js (MRT or multi-pass weighted average) | 🟡 Medium | ⚠️ Infrastructure done — `WebGPUOIT.ts` (MRT accumulation + composite pipeline, weighted blended OIT) |
| **Post-processing** | PostProcessStage.js, PostProcessStageCollection.js, PostProcessStageLibrary.js, PostProcessStageComposite.js, PostProcessStageTextureCache.js, SunPostProcess.js | 🟡 High | ⚠️ Infrastructure done — `WebGPUPostProcessPipeline.ts` (ping-pong textures, Reinhard tonemapping, FXAA built-in) |
| **SkyBox / CubeMapPanorama** | SkyBox.js → CubeMapPanorama.js (upstream v1.139 refactored SkyBox to delegate to CubeMapPanorama) | 🟢 Low | ✅ Done — `CubeMapPanorama.wgsl` + WebGPU path in `CubeMapPanorama.js`, `WebGPUCubeMapPanoramaRenderer.js`, Scene.js panorama command routing fixed |
| **EquirectangularPanorama** | EquirectangularPanorama.js (upstream v1.139, uses Primitive internally) | 🟢 Low | ✅ Auto-supported — delegates to Primitive which has WebGPU path. Material texture loading is a pre-existing limitation. |
| **GoogleStreetView panorama** | GoogleStreetViewCubeMapPanoramaProvider.js (upstream v1.139, returns CubeMapPanorama) | 🟢 Low | ✅ Auto-supported — creates CubeMapPanorama instances which have WebGPU path |
| **BufferPrimitiveCollection** | BufferPointCollection.js, BufferPolylineCollection.js, BufferPolygonCollection.js (upstream v1.140, experimental) | 🟡 Medium | ⚠️ CPU-only data structures — no GPU rendering code, delegates via _renderResources callback. No WebGPU-specific work needed currently. Future WebGPU optimization opportunity for high-performance rendering. |
| **SkyAtmosphere** | SkyAtmosphere.js (ray-marched atmosphere) | 🟡 Medium | ✅ Done — `WebGPUSkyAtmosphereRenderer.js` (Nishita scattering, ellipsoid geometry, HSB correction), `SkyAtmosphere.wgsl`, `SkyAtmosphere.js` WebGPU routing |
| **Sun** | Sun.js, SunPostProcess.js, SunLight.js | 🟡 Medium | ✅ Done — `WebGPUEnvironmentRenderer.js` (procedural texture, billboard quad), `Sun.wgsl`, `Sun.js` WebGPU routing |
| **Moon** | Moon.js | 🟢 Low | ✅ Done — `Moon.wgsl` (textured sphere, diffuse lighting) + `Moon.js` WebGPU routing in `update()` + `WebGPUEnvironmentRenderer.js` `updateWebGPUMoon()` with full RTE uniform packing (MVP, camera high/low, moon position high/low, sun direction, normal matrix). Destroy cleanup via `destroyWebGPUMoonResources()`. |
| **Fog** | Fog.js | 🟢 Low | ✅ Done — `WebGPUEnvironmentRenderer.js` `getWebGPUFogParameters()` extracts fog density/brightness for globe shader consumption |
| **Particles** | ParticleSystem.js, Particle.js, ParticleBurst.js, ParticleEmitter.js, + emitters | 🟡 Medium | ❌ Not started |
| **Cloud collection** | CloudCollection.js, CumulusCloud.js | 🟡 Medium | ❌ Not started |
| **Point clouds** | PointCloud.js, PointCloudEyeDomeLighting.js, PointCloudShading.js, TimeDynamicPointCloud.js | 🟡 Medium | ❌ Not started |
| **Voxels** | VoxelPrimitive.js + 12 voxel files | 🟡 Medium | ❌ Not started |
| **Gaussian splats** | GaussianSplatPrimitive.js + 4 files | 🟡 Medium | ❌ Not started |
| **Ellipsoid primitive** | EllipsoidPrimitive.js | 🟢 Low | ❌ Not started |
| **Clipping planes/polygons** | ClippingPlaneCollection.js, ClippingPolygonCollection.js | 🟡 Medium | ❌ Not started |
| **Invert classification** | InvertClassification.js | 🟡 Medium | ❌ Not started |
| **Image-based lighting** | ImageBasedLighting.js, DynamicEnvironmentMapManager.js, BrdfLutGenerator.js | 🟡 Medium | ❌ Not started |
| **Depth plane** | DepthPlane.js | 🟢 Low | ⚠️ Infrastructure done — `WebGPUDepthPlane.ts` (RTE depth-only quad, pipeline + bind groups) |
| **Globe depth** | GlobeDepth.js (depth readback for picking, terrain clamping) | 🟡 Medium | ⚠️ Infrastructure done — `WebGPUGlobeDepth.ts` (MSAA output, pick target, depth copy pipeline) |
| **Pick framebuffer** | PickDepth.js, PickDepthFramebuffer.js | 🟡 Medium | ❌ Not started |
| **Imagery layers** | ImageryLayer.js, ImageryLayerCollection.js, 15+ imagery providers | 🟡 High | ❌ Not started |
| **Multi-frustum rendering** | FrustumCommands.js (near/far frustum split for depth precision) | 🟡 Medium | ⚠️ Infrastructure done — `WebGPUSceneRenderer.ts` (multi-frustum loop, per-frustum depth/stencil clear, all 12 pass execution) |

### Scene Infrastructure

| Feature | WebGL Implementation | WebGPU Status |
|---------|---------------------|---------------|
| **Appearances system** | 10+ appearance classes (Material, Ellipsoid, PerInstance, Polyline, etc.) | ⚠️ Partial (8 material types mapped) |
| **Material system** | Material.js + Fabric JSON + 40+ built-in materials | ⚠️ Partial (placeholder textures) |
| **Derived commands** | DerivedCommand.js (shadow/translucent/pick command derivation) | ⚠️ Infrastructure done — `WebGPUDerivedCommand.ts` (depth-only, log-depth, pick, HDR, shadow variants) |
| **Batch table** | BatchTable.js, BatchTableHierarchy.js (per-feature attributes) | ⚠️ Partial (color only) |
| **Feature picking** | Per-feature pick IDs, readPixels GPU readback | ⚠️ Partial (pick commands exist, GPU readback via `readPixelsToPBO` + `readPixelsAsync` now implemented) |
| **Camera** | Camera.js, CameraFlightPath.js, CameraEventAggregator.js | ✅ Reused (renderer-agnostic) |
| **Stencil operations** | StencilConstants.js, StencilFunction.js, StencilOperation.js | ✅ Infrastructure complete — `WebGPUPipelineDescriptorBuilder` has `enableStencilTest()`, `setStencilReadMask/WriteMask()`, `setDepthBias()`. `WebGPURenderTarget` has stencil views. `WebGPUPassState` has stencil reference. StencilConstants/Function/Operation are renderer-agnostic. |
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
| **Render bundles** | ✅ Optional | ❌ | ✅ | ✅ Infrastructure (`WebGPURenderBundleManager.ts`) |
| **Indirect drawing** | ✅ | ❌ | ✅ | ✅ Infrastructure (`WebGPUIndirectDrawManager.ts`) |
| **Storage buffers** | ✅ Full | ✅ Full | ✅ Full | ✅ Pooled (`WebGPUStorageBufferPool.ts`) |
| **Async pipeline compilation** | ✅ Full | ✅ Full | ✅ | ✅ Done |
| **Texture arrays** | ✅ | ✅ | ✅ | ✅ Done (`WebGPUTextureArray.ts`) |
| **Timestamp queries** | ✅ | ⚠️ Partial | ✅ | ✅ Done (`WebGPUTimestampProfiler.ts`) |
| **Buffer mapping** | ✅ Full | ✅ | ✅ | ✅ Done (`WebGPUBufferMapper.ts`) |
| **GPU-driven rendering** | ⚠️ Partial | ❌ | ✅ | ✅ Infrastructure (`WebGPUGPUCuller.ts` + `FrustumCull.wgsl`) |
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

## WebGPU Advanced Features & Spec Compliance

> **Source:** Research analysis of CesiumGS hackathon branches + Babylon.js, Three.js, PlayCanvas WebGPU implementations + W3C WebGPU spec review. Full details in `migration_doc/RESEARCH_FINDINGS.md`.

### Current Spec Status

| Category | Status |
|----------|--------|
| **@webgpu/types version** | ✅ `^0.1.69` (updated from 0.1.67) |
| **Features requested at device creation** | ✅ **AUTO-DETECTED** — `_buildFeatureList()` probes adapter and requests all supported optional features |
| **Optional features auto-requested** | `float32-filterable`, `clip-distances`, `dual-source-blending`, `rg11b10ufloat-renderable`, `timestamp-query`, `shader-f16`, `texture-compression-bc/etc2/astc` |
| **Feature query API** | ✅ `context.hasFeature('clip-distances')`, `context.enabledFeatures` |
| **Render bundle infrastructure** | ✅ `WebGPURenderBundleManager.ts` — keyed cache, LRU eviction, batch recording |
| **Uniform grouping** | ✅ `WebGPUUniformGroupManager.ts` — per-frame/per-material/per-object bind groups (Group 0/1/2) |
| **Optimized texture upload** | ✅ `copyExternalImageToTexture()` used in TextureAtlas + loadCubeMap for zero-copy ImageBitmap→GPU |

### Categorized Technology Roadmap — WebGPU Features

#### 🔴 CRITICAL — Blocks Core Functionality

| # | Feature | Why Critical | Effort | Phase |
|---|---------|-------------|--------|-------|
| C1 | **`float32-filterable` device feature** | Terrain heightmaps use float32 textures; without this, no hardware bilinear filtering of elevation data | 30 min | 2 (Globe) |
| C2 | **`copyExternalImageToTexture()`** | Satellite imagery tiles arrive as `ImageBitmap`; this API uploads directly to GPU without CPU copies — critical for imagery layer performance | 1-2 days | 2 (Globe) |
| C3 | **`clip-distances` device feature** | CesiumJS `ClippingPlaneCollection` uses stencil-based clipping; native clip planes are simpler, faster, and more correct | 1 day | 5 (Visual Quality) |
| C4 | **`dual-source-blending` device feature** | Enables weighted-average OIT in single render pass — our #1 visual quality gap (translucent rendering) | 1 day | 5 (Visual Quality) |
| C5 | **Render bundles (`createRenderBundleEncoder`)** | Globe terrain = hundreds of static tiles. Pre-encoding as render bundles gives 50-80% CPU reduction per frame. Babylon.js & PlayCanvas both use this. | 3-4 days | 2 (Globe) |
| C6 | **Uniform grouping by update frequency** | Three.js groups uniforms: group 0=per-frame, group 1=per-material, group 2=per-object. Reduces buffer updates dramatically. Industry best practice. | 2-3 days | 2 (Globe) |

#### 🟡 IMPORTANT — Significant Performance/Quality Impact

| # | Feature | Why Important | Effort | Phase |
|---|---------|--------------|--------|-------|
| I1 | **Indirect drawing (`drawIndexedIndirect`)** | For 3D Tiles with 1000s of models: GPU compute shader does frustum culling, writes draw params to indirect buffer. One draw call replaces thousands. PlayCanvas uses this. | 5-7 days | 8 (Performance) |
| I2 | **GPU compute frustum culling** | GPU-side tile visibility testing via compute shader. Eliminates CPU bottleneck for dense 3D Tiles scenes (10,000+ intersection tests/frame → single dispatch). | 3-5 days | 8 (Performance) |
| I3 | **Buffer sub-allocator (ring buffer)** | PlayCanvas uses a ring-buffer allocator for per-frame uniform data — zero GPU buffer creation per frame. Our current approach creates buffers per command. | 3-4 days | 8 (Performance) |
| I4 | **`rg11b10ufloat-renderable` feature** | HDR render targets for post-processing pipeline. Required for physically correct bloom, tonemapping. | 30 min | 5 (Visual Quality) |
| I5 | **`shader-f16` feature** | Half-precision normals, texture coords, colors — halves vertex buffer sizes. Terrain has millions of vertices where f16 normals suffice. | 2-3 days | 8 (Performance) |
| I6 | **`timestamp-query` feature** | GPU-side performance profiling. We currently have zero profiling infrastructure. Required to validate any optimization work. | 1-2 days | 7 (Testing) |
| I7 | **Texture arrays** | Single bind group for multiple imagery layers instead of separate textures. Babylon.js, Three.js, PlayCanvas all use texture arrays. | 2-3 days | 2 (Globe) |

#### 🟢 STANDARD — Industry-Standard Features

| # | Feature | Description | Effort | Phase |
|---|---------|------------|--------|-------|
| S1 | **Storage buffer utilization** | Factory exists but unused. Enable for large point datasets, compute inputs/outputs. | 1-2 days | 6 (Advanced) |
| S2 | **`buffer.mapAsync()` + `getMappedRange()`** | Direct CPU↔GPU buffer access for terrain data upload, pick readback. More efficient than `writeBuffer()`. | 2-3 days | 8 (Performance) |
| S3 | **`GPUExternalTexture` / `importExternalTexture()`** | Zero-copy video frame → texture upload for video imagery providers. | 1-2 days | 9 (Polish) |
| S4 | **Subgroup operations** | SIMD-like operations within a workgroup — useful for atmosphere scattering LUT computation, point cloud prefix sum, HDR histogram. Chrome 132+ origin trial. | 2-3 days | 9 (Polish) |
| S5 | **Update `@webgpu/types` to 0.1.69** | Latest type definitions for new features above. | 10 min | Immediate |

#### ⚪ NICE-TO-HAVE — Future Optimization

| # | Feature | Description | Effort | Phase |
|---|---------|------------|--------|-------|
| N1 | **Slang shader cross-compilation** | CesiumGS `webgpu-hackathon` branch explored [Slang](https://github.com/shader-slang/slang) as universal shader language: write once → compile to WGSL and GLSL. Worth evaluating when we have 100+ WGSL shaders. | 3-5 days | 9 (Polish) |
| N2 | **WebGL→WebGPU post-processing bridge** | CesiumGS hackathon: reads WebGL output via `gl.readPixels()`, applies WGSL post-process on overlay canvas. Clever for transition period but `readPixels` per frame is expensive. | 2-3 days | 9 (Polish) |
| N3 | **Parallel command encoding** | Multiple command encoders for multi-threaded submit. Future optimization when scene complexity warrants it. | 3-5 days | 9 (Polish) |
| N4 | **Snapshot rendering** | Babylon.js technique: pre-record full frame as render bundle for static scenes. Useful for "fly-to" animations over static terrain. | 2-3 days | 9 (Polish) |

### Key Lessons from Other Engines

| Engine | Key Pattern We Should Adopt | Priority |
|--------|---------------------------|----------|
| **Babylon.js** | Buffer sub-allocation from large backing buffers (GPUBufferManager). Render bundle caching for static scenes (Snapshot Rendering). | 🔴 Critical for globe |
| **Three.js** | Uniform grouping by update frequency (per-frame/per-material/per-object → bind groups 0/1/2). Node-based shader abstraction (TSL). | 🔴 Critical for architecture |
| **PlayCanvas** | GPU-driven rendering with indirect draw calls. Ring-buffer allocator for per-frame uniforms. Compressed texture support (ASTC, BC, ETC2). | 🟡 Important for 3D Tiles |

---

## WebAssembly Optimization Roadmap

> CesiumJS already uses WASM for Draco (`draco_decoder.wasm`), KTX2 (`basis_transcoder.wasm`), Gaussian splats (`wasm_splats_bg.wasm`), and ZIP (`zip-module.wasm`) via `TaskProcessor.initWebAssemblyModule()`. Feature detection: `FeatureDetection.supportsWebAssembly()`.

### Categorized WASM Opportunities

#### 🔴 CRITICAL — Self-Identified Performance Hotspots

| # | Target | File | Current | WASM Speedup | Effort | Phase |
|---|--------|------|---------|-------------|--------|-------|
| W1 | **Terrain tessellation** | `Core/HeightmapTessellator.js` | JS (self-documented "performance hotspot"), runs in Web Worker | 2-5x (nested loops over Float32/64 arrays, normals, skirts) | 3-5 days | 2 (Globe) |
| W2 | **Quantized mesh decoding** | `Core/QuantizedMeshTerrainData.js` | JS in Web Worker | 3-8x (zigzag decode, delta decode, octahedron normals — integer-heavy) | 3-5 days | 2 (Globe) |

#### 🟡 IMPORTANT — High-Frequency Operations

| # | Target | File | Current | WASM Speedup | Effort | Phase |
|---|--------|------|---------|-------------|--------|-------|
| W3 | **Batch frustum culling** | `Core/BoundingSphere.js` | JS (`intersectPlane()` × 6 planes × 1000s tiles/frame) | 4-10x with WASM SIMD (128-bit, 4× parallel sphere-plane tests) | 3-5 days | 8 (Performance) |
| W4 | **Batch RTE encoding** | `Core/EncodedCartesian3.js` | JS (per-vertex for all world-space geometry) | 2-3x (f64 native in WASM) | 1-2 days | 8 (Performance) |
| W5 | **Batch matrix multiply** | `Core/Matrix4.js` | JS (per-entity, per-frame for model-view-projection) | 2-4x with WASM SIMD | 2-3 days | 8 (Performance) |

#### 🟢 STANDARD — Compute-Heavy Operations

| # | Target | Description | WASM Speedup | Effort | Phase |
|---|--------|------------|-------------|--------|-------|
| W6 | **Point cloud processing** | Octree construction, LOD computation, attribute decompression | 3-5x | 5-7 days | 6 (Advanced) |
| W7 | **WASM threading** | SharedArrayBuffer + threads for parallel terrain tessellation across tiles | 2-3x additional | 5-7 days | 9 (Polish) |

#### GPU Compute vs WASM Decision Matrix

| Task | WASM (CPU) | GPU Compute | Recommendation |
|------|-----------|-------------|----------------|
| Terrain tessellation | ✅ Good (Web Worker) | ❌ Complex data deps | **WASM** |
| Frustum culling | ✅ Good (SIMD) | ✅ Better (1000s tiles) | **GPU Compute** for 3D Tiles, **WASM** for terrain |
| Matrix batch multiply | ✅ Good (SIMD) | ⚠️ Overkill | **WASM** |
| Point cloud sort/LOD | ✅ Acceptable | ✅ Much better | **GPU Compute** |
| Atmosphere LUT | ⚠️ Slow | ✅ Perfect (ray marching) | **GPU Compute** |
| RTE encoding | ✅ Good | ⚠️ Requires readback | **WASM** |
| 3D Tiles occlusion culling | ⚠️ Limited | ✅ Perfect (hierarchical Z) | **GPU Compute** |

### WASM Threading Prerequisites

CesiumJS already uses Web Workers. WASM `SharedArrayBuffer` + threads require COOP/COEP headers:
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```
CesiumJS's `server.js` would need these headers. Consider making them configurable.

---

## CesiumGS Hackathon Branch Analysis

> Three branches in `CesiumGS/cesium`: `webgpu-hackathon-device` (8 commits), `webgpu-hackathon` (14 commits), `daniel/webgpu-hackathon` (13 commits). All 565 commits behind `main`. Our fork is vastly more comprehensive.

### Branch Summary

| Branch | Commits | Key Innovation | Our Status |
|--------|---------|---------------|------------|
| `webgpu-hackathon-device` | 8 | Basic WebGPU context (~115 lines), compute pipeline, buffer readback | ✅ Far surpassed (1,800-line context, 34 renderer files) |
| `webgpu-hackathon` | 14 | **Slang shader cross-compilation** (GLSL+WGSL from one source), **WebGL→WebGPU post-processing bridge** (readPixels → WebGPU texture → overlay canvas) | 🟡 Worth monitoring (see N1, N2 above) |
| `daniel/webgpu-hackathon` | 13 | Subset of `webgpu-hackathon` without Slang | 🔴 Fully subsumed |

### Actionable Ideas from Hackathon

| Priority | Idea | Source | Status |
|----------|------|--------|--------|
| 🟡 Low-Med | Expose WebGPU context via `FrameState` for compute tasks outside render loop | `device` branch | ❌ Not adopted — consider when compute is active |
| 🟡 Medium | Evaluate Slang compiler for dual GLSL/WGSL maintenance at 100+ shaders | `hackathon` branch | ❌ Deferred — tracked as N1 |
| 🟡 Low | WebGL→WebGPU post-processing bridge for hybrid mode | `hackathon` branch | ❌ Deferred — tracked as N2 |

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
└── WebGPU/                       (40 files)
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
    ├── WGSLBuiltins.ts            (16 built-in shader chunks)
    ├── WGSLShaderBuilder.js       (programmatic WGSL for Model pipeline)
    ├── WebGPUMipmapGenerator.ts   (blit-based mipmap generation)
    ├── WebGPUPrimitiveShaders.js  (shader selection, .wgsl loading)
    ├── WebGPUPrimitiveCommands.js (command creation, RTE uniforms)
    ├── WebGPUPointPrimitiveRenderer.js (instanced quad points)
    ├── WebGPUCollectionShaders.js (collection shader loader)
    ├── WebGPUAutoUniforms.js      (~60 csm_* uniforms, profiles)
    ├── WebGPUCubeMapPanoramaRenderer.js (NEW — cubemap panorama pipeline, uniforms, draw commands)
    ├── WebGPUPickManager.ts       (pick ID management)
    ├── WebGPUResourceManager.ts   (resource lifecycle)
    ├── WebGPUDeviceLossRecovery.ts (3 retries, exponential backoff)
    ├── WebGPURenderBundleManager.ts (NEW — keyed cache, LRU eviction, batch recording for static geometry)
    ├── WebGPUUniformGroupManager.ts (NEW — per-frame/per-material/per-object bind group management)
    ├── WebGPUSceneRenderer.ts     (NEW — multi-frustum command execution, all 12 rendering passes)
    ├── WebGPUSceneFramebuffer.ts  (NEW — main scene color+depth+ID render targets, MSAA, HDR)
    ├── WebGPUGlobeDepth.ts        (NEW — globe depth framebuffers, depth copy pipeline)
    ├── WebGPUDerivedCommand.ts    (NEW — depth-only, log-depth, pick, HDR, shadow command variants)
    ├── WebGPUOIT.ts               (NEW — weighted blended OIT, MRT accumulation + composite)
    ├── WebGPUDepthPlane.ts        (NEW — RTE depth-only quad at ellipsoid surface)
    ├── WebGPUPostProcessPipeline.ts (NEW — ping-pong effects, tonemapping, FXAA built-in)
    ├── WebGPUSync.ts              (NEW — GPU fence sync via device.queue.onSubmittedWorkDone)
    ├── WebGPUMultisampleFramebuffer.ts (NEW — MSAA wrapper, blitFramebuffers is no-op)
    ├── WebGPUTexture3D.ts         (NEW — 3D texture wrapper for voxels, copyFrom, mipmap)
    ├── WebGPUCubeMap.ts           (NEW — 6-face cubemap wrapper, face views, ImageBitmap upload)
    ├── WebGPUCubeMapFace.ts       (NEW — single cubemap face, layer views, copyFrom)
    ├── WebGPUTextureUtilities.ts  (texture helpers)
    └── WebGLStateConverters.ts    (state conversion utilities)

Source/Shaders/WebGPU/                    (46 files)
├── BasicColor.wgsl, BasicTextured.wgsl, CubeMapPanorama.wgsl, PhongLighting.wgsl, etc. (7)
├── chunks/structs/ (5 .wgsl)
├── chunks/functions/ (12 .wgsl — includes csm_writeLogDepth)
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
| WGSL-1 | ~~`csm_unpackTexture` used big-endian byte order, GLSL uses little-endian — silent data corruption~~ | ~~🔴 HIGH~~ | ✅ **RESOLVED** — Fixed byte order in both `WGSLBuiltins.ts` inline constant and `.wgsl` reference files to match GLSL little-endian: `bytes.x \| (bytes.y << 8u) \| ...` |
| WGSL-2 | ~~`csm_translateRelativeToEye` existed as .wgsl file but was not registered in `WGSLBuiltins.ts`~~ | ~~🟡 MEDIUM~~ | ✅ **RESOLVED** — Added inline constant and registration in `WGSLBuiltins.ts` + entry in `WGSLBuiltinChunks` (now 16 total: 5 structs + 11 functions) |
| GLSL-1 | ~~`decodeRGB8.glsl` and `unpackTexture.glsl` had no .js wrappers — not available to `ShaderSource.js`~~ | ~~🟡 MEDIUM~~ | ✅ **RESOLVED** — Created `.js` wrappers and registered both in `CzmBuiltins.js` |
| CLEAN-2 | ~~Dead `SkyBox.wgsl` files in both `packages/engine/` and `Source/` — replaced by `CubeMapPanorama.wgsl`~~ | ~~🟢 LOW~~ | ✅ **RESOLVED** — Deleted from both locations |
| COMPAT-1 | ~~BillboardCollection/LabelCollection (v1.140) now require instancing — WebGPU context compatible but no dedicated rendering path~~ | ~~🟡 MEDIUM~~ | ✅ **RESOLVED** — `WebGPUBillboardRenderer.js` created with instanced quad rendering, atlas texture support, RTE positioning. `BillboardCollection.js` now routes to WebGPU renderer when `context.isWebGPU`. LabelCollection auto-supported via Billboard. `WebGPUPolylineRenderer.js` also created for PolylineCollection. |
| FILE-1 | ~~3 WGSL files (csm_writeLogDepth, FrustumCull, GlobeTerrain) created in root Source/ (build output) instead of packages/engine/Source/ (canonical)~~ | ~~🔴 HIGH~~ | ✅ **RESOLVED** — Moved to `packages/engine/Source/Shaders/WebGPU/`. Added `/Source/Shaders/` to `.gitignore`. Root `Source/Shaders/WebGPU/` files removed from git tracking via `git rm --cached`. `.clinerules` updated with "Monorepo Architecture — CRITICAL File Placement Rules" section to prevent recurrence. |
| BUILD-2 | ~~`GlobeSurfaceTileProvider.js` had duplicate `const context` declaration in same scope (WebGPU routing + WebGL code) — esbuild build error~~ | ~~🔴 HIGH~~ | ✅ **RESOLVED** — Removed duplicate `const context = frameState.context;` at line 2526, already declared at line 2267 for WebGPU routing. |
| BUILD-3 | ~~`WebGPUCubeMapPanoramaRenderer.js` had only named exports, no default export — broke auto-generated `index.js` which uses `export { default as ... }`~~ | ~~🔴 HIGH~~ | ✅ **RESOLVED** — Added `export default { ... }` aggregating all named function exports. |
| LINT-1 | ~~50 lint errors across 8 WebGPU .js files (49 missing curly braces after `if`/`for` conditions, 1 unused `WebGPUDrawCommand` import)~~ | ~~🟡 MEDIUM~~ | ✅ **RESOLVED** — Auto-fixed 49 curly brace violations, removed unused import in `WebGPUGroundPrimitiveRenderer.js`. |
| SCENE-1 | `WebGPUSceneRenderer.ts` frustum loop starts at COMPUTE (Pass 1), **missing ENVIRONMENT pass (Pass 0)** — skybox/sun/moon/atmosphere not executed by scene renderer | 🔴 HIGH | ❌ Open — ENVIRONMENT commands are currently rendered via `Scene.js renderEnvironment()` which has its own WebGPU panorama routing, but the scene renderer should handle this for consistency |
| SCENE-2 | `WebGPUSceneRenderer.ts` calls `_sceneFramebuffer.update(device, width, height, numSamples, canvasFormat)` with 5 args, but `WebGPUSceneFramebuffer.update()` expects 6 args (missing `hdr` parameter) | 🟡 MEDIUM | ❌ Open — Will cause incorrect framebuffer setup when HDR is enabled |
| SCENE-3 | `WebGPUSceneRenderer.ts` calls `_oit.initialize()` but `WebGPUOIT.ts` only has `update()` method — method name mismatch | 🟡 MEDIUM | ❌ Open — OIT won't initialize properly until method name is aligned |
| TS-1 | 5 WebGPU `.ts` files have `// @ts-nocheck` suppressing ~30 TypeScript errors (WebGPUSceneRenderer, WebGPUTimestampProfiler, WebGPUGlobeSurfaceRenderer, WebGPUBufferMapper, WebGLCompatibilityStub). Root causes: API mismatches between SceneRenderer and OIT/SceneFramebuffer/DepthPlane, deprecated `writeTimestamp` API, `SharedArrayBuffer` vs `ArrayBuffer` type incompatibility, implicit `any` types in compat stub. **Must fix and remove `@ts-nocheck` before production use.** | 🔴 HIGH | ❌ Open — Tracked for resolution when SCENE-1/2/3 are fixed and WebGPU types are updated |

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
7. ~~**SkyBox**~~ + ~~**SkyAtmosphere**~~ — ✅ Both done. SkyBox via `CubeMapPanorama.wgsl`. SkyAtmosphere via `WebGPUSkyAtmosphereRenderer.js` + `SkyAtmosphere.wgsl` + `SkyAtmosphere.js` routing.
8. ~~**Sun**~~/Moon + ~~**Fog**~~ — ✅ Sun done (`WebGPUEnvironmentRenderer.js` + `Sun.wgsl` + `Sun.js` routing). Moon shader done (`Moon.wgsl`). Fog done (`getWebGPUFogParameters()`).
9. 🔴 **Enable `float32-filterable` device feature** — Terrain heightmap filtering (C1)
10. 🔴 **`copyExternalImageToTexture()` for imagery upload** — Zero-copy ImageBitmap→GPU (C2)
11. 🔴 **Render bundles for terrain tiles** — 50-80% CPU reduction for static tiles (C5)
12. 🔴 **Uniform grouping by update frequency** — Per-frame/per-material/per-object bind groups (C6)
13. 🔴 **WASM terrain tessellation** — HeightmapTessellator.js hotspot, 2-5x speedup (W1)
14. 🔴 **WASM quantized mesh decoding** — QuantizedMeshTerrainData.js, 3-8x speedup (W2)
15. 🟡 **Texture arrays for imagery layers** — Single bind group for multiple layers (I7)

### Phase 3: Content Pipeline ~~(4-6 weeks)~~ — Prerequisites Complete
9. ~~**WGSLShaderBuilder**~~ — ✅ Done. `WGSLShaderBuilder.js` created
10. ~~**WebGPUAutoUniforms**~~ — ✅ Done. `WebGPUAutoUniforms.js` created
11. **Model/glTF rendering** — Full model pipeline port (prerequisites now met)
12. **3D Tiles rendering** — Streaming content

### Phase 4: Collections ~~(2-3 weeks)~~ ✅ COMPLETE
13. ~~**Billboard collection**~~ — ✅ Done. `WebGPUBillboardRenderer.js` + `BillboardCollection.wgsl` + `BillboardCollection.js` routing
14. ~~**Label collection**~~ — ✅ Auto-supported via Billboard WebGPU path
15. ~~**Polyline collection**~~ — ✅ Done. `WebGPUPolylineRenderer.js` + `PolylineCollection.wgsl` + `PolylineCollection.js` routing

### Phase 5: Visual Quality (3-4 weeks) — IN PROGRESS
16. ~~**OIT**~~ — ✅ Infrastructure done (`WebGPUOIT.ts`) + OIT enabled in `View.js` for WebGPU
17. ~~**Shadow mapping**~~ — ⚠️ Infrastructure done (`WebGPUShadowMapRenderer.js` + `ShadowMap.wgsl`). Scene integration pending.
18. **Post-processing** — ⚠️ Infrastructure done (`WebGPUPostProcessPipeline.ts`). Scene integration pending.
19. ~~**Ground primitives**~~ — ⚠️ Infrastructure done (`WebGPUGroundPrimitiveRenderer.js` + `GroundPrimitive.wgsl`). Scene integration pending.
20. **Pick framebuffer** — GPU readback for scene.pick()
21. 🔴 **Enable `dual-source-blending` device feature** — Single-pass OIT (C4)
22. 🔴 **Enable `clip-distances` device feature** — Native clipping planes (C3)
23. 🟡 **Enable `rg11b10ufloat-renderable` feature** — HDR render targets for post-processing (I4)

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
29. 🟡 **GPU timestamp queries** — Required to validate optimization work (I6)

### Phase 8: Performance Optimization (3-4 weeks) — NEW
> GPU-driven rendering + WASM SIMD + buffer management. Items from research analysis.

30. 🟡 **Indirect drawing (`drawIndexedIndirect`)** — GPU-driven 3D Tiles rendering (I1)
31. 🟡 **GPU compute frustum culling** — Eliminates CPU bottleneck for dense scenes (I2)
32. 🟡 **Buffer sub-allocator (ring buffer)** — Zero per-frame buffer creation, per PlayCanvas pattern (I3)
33. 🟡 **`shader-f16` for reduced vertex sizes** — Half-precision normals/texcoords (I5)
34. 🟡 **`buffer.mapAsync()` integration** — Direct CPU↔GPU buffer access (S2)
35. 🟡 **WASM batch frustum culling** — SIMD 4-10x speedup for terrain culling (W3)
36. 🟡 **WASM batch RTE encoding** — 2-3x speedup for position encoding (W4)
37. 🟡 **WASM batch matrix multiply** — 2-4x speedup with SIMD (W5)

### Phase 9: Polish & Future Tech (2-3 weeks) — NEW
> Forward-looking features from industry survey and hackathon analysis.

38. 🟢 **`GPUExternalTexture` for video imagery** — Zero-copy video frames (S3)
39. 🟢 **Subgroup operations** — SIMD-like shader ops for atmosphere/point clouds (S4)
40. 🟢 **WASM threading** — SharedArrayBuffer for parallel terrain processing (W7)
41. ⚪ **Evaluate Slang shader compiler** — Cross-compile GLSL+WGSL from one source (N1)
42. ⚪ **Snapshot rendering** — Babylon.js-style full-frame render bundles (N4)
43. ⚪ **Parallel command encoding** — Multi-encoder for complex scenes (N3)

### Total Estimated Timeline: ~24-32 weeks for full WebGL parity + performance optimization

> **Note:** Phases 8-9 extend the original 20-26 week estimate by 4-6 weeks but deliver performance
> that **exceeds** WebGL capability. GPU-driven rendering, WASM SIMD, and render bundles are features
> WebGL cannot achieve — they represent the core value proposition of the WebGPU migration.

---

## Summary Statistics

| Metric | Count |
|--------|-------|
| WebGL shader files | 607+ (303 .glsl + new CubeMapPanoramaVS, decodeRGB8, unpackTexture) |
| WebGPU shader files | 56 (.wgsl) — 7 standalone + 1 Globe (GlobeTerrain) + 1 Compute (FrustumCull) + 5 struct chunks + 12 function chunks (incl. csm_writeLogDepth) + 20 Primitive + 4 Collection (PointColor, PointPick, BillboardCollection, PolylineCollection) + 3 Environment (SkyAtmosphere, Sun, Moon) + 1 Shadow (ShadowMap) + 1 Classification (GroundPrimitive) + 1 Model (ModelPBR) |
| Shader coverage | ~9.2% |
| WebGL renderer files | 44 |
| WebGPU renderer files | 64 (all in `packages/engine/Source/Renderer/WebGPU/`) + 3 shared (`RendererType.ts`, `GraphicsContext.ts`, `ContextFactory.ts`) |
| Renderer file coverage | ~100% (infrastructure + feature renderers) |
| WebGL Scene features | 30+ major components |
| WebGPU Scene features | 15 (Primitive + PointPrimitive + Billboard + Label (via Billboard) + Polyline + Globe/Terrain (initial) + CubeMapPanorama/SkyBox + EquirectangularPanorama + GoogleStreetView + SkyAtmosphere + Sun + Moon (WebGPU routing + RTE uniforms) + Fog + OIT (scene routing) + Shadow (scene routing)) |
| Scene feature coverage | ~38% |
| WebGL rendering passes | 12 |
| WebGPU rendering passes | 7 active + 5 infrastructure-ready (ENVIRONMENT ✅, COMPUTE ✅, GLOBE ⚠️, TERRAIN_CLASSIFICATION ✅, 3D Tile passes ⚠️×4, OPAQUE ✅, TRANSLUCENT ✅, VOXELS ⚠️, GAUSSIAN_SPLATS ⚠️, OVERLAY ✅) |
| Rendering pass coverage | ~58% (7/12 passes have scene routing, all 12 have WebGPUSceneRenderer infrastructure) |
| Model pipeline files | 80+ |
| Model pipeline WebGPU | 1 (WebGPUModelRenderer.js — initial PBR pipeline) |
| Test pages | 29 (standalone demos + split-screen + skybox test) |
| Jasmine unit tests | 0 |
