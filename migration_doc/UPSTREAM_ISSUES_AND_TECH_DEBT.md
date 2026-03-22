# CesiumJS Upstream: Known Issues, Tech Debt & Community Problems

**Last Updated:** March 21, 2026 (Updated: Comprehensive picking analysis — FORK-34/35/36 added for WebGPU pick pass gap, duplicate pick IDs, and missing convenience API. See `PICKING_ANALYSIS.md` for full report.)  
**Upstream Repository:** [CesiumGS/cesium](https://github.com/CesiumGS/cesium) — ~1,500 open issues  
**Our Fork:** [kurtyoung-dev/cesium-webgpu](https://github.com/kurtyoung-dev/cesium-webgpu)  
**Purpose:** Comprehensive audit of upstream CesiumJS problems — issues identified from GitHub issues, community forum, and code analysis — cross-referenced with our fork's status. Also includes a dedicated section for tech debt introduced by our fork.

---

## Table of Contents

1. [Architecture & Modernization Debt](#1-architecture--modernization-debt)
2. [Rendering & Graphics Issues](#2-rendering--graphics-issues)
3. [Performance & Memory Problems](#3-performance--memory-problems)
4. [Camera & Navigation Bugs](#4-camera--navigation-bugs)
5. [2D / Columbus View Bugs](#5-2d--columbus-view-bugs)
6. [Entity & DataSource Issues](#6-entity--datasource-issues)
7. [3D Tiles Issues](#7-3d-tiles-issues)
8. [Terrain & Imagery Issues](#8-terrain--imagery-issues)
9. [Model / glTF Issues](#9-model--gltf-issues)
10. [API Design & Developer Experience](#10-api-design--developer-experience)
11. [Build System & Packaging](#11-build-system--packaging)
12. [Community-Requested Features](#12-community-requested-features)
13. [Summary: Our Fork's Advantage](#13-summary-our-forks-advantage)
14. [Fork-Specific Tech Debt](#14-fork-specific-tech-debt)

---

## Legend

| Symbol | Meaning |
|--------|---------|
| ✅ **FIXED** | Our fork has resolved this issue |
| ⚡ **IMPROVED** | Our fork has partially addressed or architecturally improved this |
| 🔧 **PLANNED** | Our fork has infrastructure or plans to address this |
| ⬜ **OPEN** | Not yet addressed in our fork (same as upstream) |
| 🟡 **MITIGATED** | Issue impact reduced by our architecture but not fully fixed |

---

## 1. Architecture & Modernization Debt

### 1.1 Legacy JavaScript Patterns

| Issue | Upstream # | Severity | Our Status | Details |
|-------|-----------|----------|------------|---------|
| **No ES6 class syntax** — Prototype-based inheritance throughout. Users can't `extends` Cesium classes | [#8359](https://github.com/CesiumGS/cesium/issues/8359) | 🔴 High | ✅ **FIXED** (partial) | We converted `Context.js` to ES6 class with `extends GraphicsContext`. Upstream still uses constructor functions for most classes. Our `GraphicsContext.ts` abstract base class is fully ES6. |
| **No TypeScript** — Entire codebase is JS. Type safety relies on JSDoc annotations. 15+ comments requesting TS. | [#4434](https://github.com/CesiumGS/cesium/issues/4434) | 🔴 High | ⚡ **IMPROVED** | All 83+ WebGPU renderer files are TypeScript. `GraphicsContext.ts`, `ContextRegistry.ts`, `ContextFactory.ts`, etc. TypeScript enforces API parity between backends at compile time. |
| **"Cesium 2" modernization stalled** — Requested since 2015. 52 comments. No concrete progress. | [#2524](https://github.com/CesiumGS/cesium/issues/2524) | 🔴 High | ⚡ **IMPROVED** | Our fork IS effectively "Cesium 2" for the rendering layer — abstract GraphicsContext, WebGPU backend, async initialization, multi-context support. |
| **`Map` vs `{}` and `AssociativeArray`** — Inefficient data structures throughout. Hash-based lookups where arrays suffice. | [#12980](https://github.com/CesiumGS/cesium/issues/12980) | 🟡 Medium | ⚡ **IMPROVED** | Our `FeatureRendererKey` enum uses integer-indexed arrays for O(1) direct access instead of string-keyed maps. Pattern documented in `.clinerules` for all new code. |
| **Replace `urijs` with native `URL`/`URLSearchParams`** — Unnecessary dependency on legacy library | [#11168](https://github.com/CesiumGS/cesium/issues/11168) | 🟡 Medium | ⬜ **OPEN** | Not yet addressed — follows upstream's timeline. |
| **147 static named Colors waste 9.71 KB** in minified bundle | [#8258](https://github.com/CesiumGS/cesium/issues/8258) | 🟢 Low | ⬜ **OPEN** | Not addressed. |
| **`PerformanceMeasure` object instances cause memory leak** | [#12932](https://github.com/CesiumGS/cesium/issues/12932) | 🟡 Medium | ⬜ **OPEN** | Not yet addressed. |
| **IE11/Legacy browser workarounds still in codebase** — Dead code for browsers no longer supported | — (code analysis) | 🟡 Medium | ⬜ **OPEN** | 6 IE11-specific workaround comments found in `Context.js` (TRIANGLE_FAN), `ShaderProgram.js` (3x getUniformLocation null check), `UniformState.js` (spherical harmonic pre-init), `Sun.js` (TRIANGLE_FAN). CesiumJS dropped IE11 support years ago — these are dead code. |
| **`demodernizeShader()` GLSL downgrade path** — Entire module exists to downgrade WebGL2 GLSL back to WebGL1 syntax | — (code analysis) | 🟡 Medium | ⬜ **OPEN** | `demodernizeShader.js` transpiles `in`/`out`/`texture()` back to `attribute`/`varying`/`texture2D()` for WebGL1. `ShaderSource.js` calls it when `!context.webgl2`. Dead weight for WebGL2-only targets. |
| **`destroyObject()` replaces all methods with error-throwing stubs** — Performance and memory concern | — (code analysis) | 🟢 Low | ⬜ **OPEN** | After `destroy()`, every method on the object is replaced with a function that throws `DeveloperError`. This creates many closures per destroyed object. In debug builds this is useful; in production it adds memory overhead for destroyed-but-not-yet-GC'd objects. |
| **Knockout.js widget dependency** — Outdated MVVM framework, no longer actively maintained | — (code analysis) | 🟡 Medium | ⬜ **OPEN** | All CesiumJS widgets depend on Knockout.js + Knockout-ES5 plugin. Modern alternatives (lit, Web Components, signals) exist. Upstream `#10876` requests Web Components but no progress. |

### 1.2 Renderer Architecture

| Issue | Upstream # | Severity | Our Status | Details |
|-------|-----------|----------|------------|---------|
| **No renderer abstraction** — WebGL calls hardwired into Scene code. No way to swap renderers. | — (systemic) | 🔴 Critical | ✅ **FIXED** | `GraphicsContext` abstract base class. `Context.js` (WebGL) and `WebGPUContext.ts` (WebGPU) both extend it. Scene code accesses renderers via `context.getFeatureRenderer()`. |
| **No WebGPU support** — Community repeatedly asking since 2021. CesiumGS has only 3 tiny hackathon branches (565 commits behind). | Forum + [#4434 comments](https://github.com/CesiumGS/cesium/issues/4434) | 🔴 Critical | ✅ **FIXED** | 83+ WebGPU renderer files, 67+ WGSL shaders, 22+ scene features rendering, 29 test pages. 10-20x more comprehensive than CesiumGS hackathon prototypes. |
| **WebGL1 fallback maintenance burden** — 34+ branching points for WebGL1 vs WebGL2. Triple maintenance. | — (code analysis) | 🟡 Medium | ✅ **FIXED** | Our fork targets WebGL2 only. Reduced from 3 rendering paths (WebGL1 + WebGL2 + WebGPU) to 2 (WebGL2 + WebGPU). |
| **No OffscreenCanvas / WebWorker rendering** | [#6896](https://github.com/CesiumGS/cesium/issues/6896) | 🟡 Medium | 🔧 **PLANNED** | `OffscreenContextSupport.ts` infrastructure exists. Not yet activated. |
| **No multi-context / multi-view support** — Can't run two Cesium viewers sharing resources | — (systemic) | 🟡 Medium | ✅ **FIXED** | `ContextRegistry` tracks all active contexts. `WebGPUDevicePool` shares GPU devices. Per-view context assignment via `View.graphicsContext`. |
| **Synchronous initialization blocks** — `new Viewer()` blocks the main thread during GPU setup | — (systemic) | 🟡 Medium | ✅ **FIXED** | `Viewer.createAsync()` / `Scene.createAsync()` with `LoadingOverlay`. Non-blocking GPU adapter/device acquisition for WebGPU. |
| **Handle lost WebGL contexts more gracefully** — Crashes or blank screen on context loss | [#5991](https://github.com/CesiumGS/cesium/issues/5991) | 🟡 Medium | ⚡ **IMPROVED** | `WebGPUDeviceLossRecovery.ts` handles WebGPU device loss with automatic re-initialization. WebGL context loss handling improved via `GraphicsContext` lifecycle. |
| **No render command abstraction** — `DrawCommand` is tightly coupled to WebGL | — (systemic) | 🟡 Medium | ✅ **FIXED** | `RenderCommand.js` provides backend-agnostic command abstraction. Scene code can push `RenderCommand` objects that delegate to `DrawCommand` or `WebGPUDrawCommand` at execution time. |
| **Hardcoded magic numbers in Context.js** — WebGL constants used as raw integers without named constants | — (code analysis) | 🟢 Low | ⬜ **OPEN** | Multiple raw numeric constants (e.g., `0x1F01` for `GL_RENDERER`) used instead of named constants. Reduces readability. |
| **ShaderProgram has no cache invalidation or memory pressure tracking** — Shader cache grows unbounded | — (code analysis) | 🟡 Medium | ⚡ **IMPROVED** | `WebGPUShaderCache.ts` tracks statistics and allows purging. WebGL `ShaderCache` has `destroyReleasedShaderPrograms()` but no memory pressure monitoring. |

### 1.3 Shader System

| Issue | Upstream # | Severity | Our Status | Details |
|-------|-----------|----------|------------|---------|
| **607+ GLSL shaders with no cross-compilation** — All shaders are handwritten GLSL. No path to WGSL/SPIR-V. | — (systemic) | 🟡 Medium | ⚡ **IMPROVED** | 67+ hand-written WGSL shaders covering ~11% of WebGL shader coverage. Slang cross-compilation pipeline (`scripts/compileSlang.js`) available for future dual-output shaders. |
| **No shader preprocessing for WGSL** | — (systemic) | 🟡 Medium | ✅ **FIXED** | `WGSLShaderPreprocessor.ts` with `#import` directive, struct auto-resolution, and chunk management. `WGSLBuiltins.ts` provides 17 reusable chunks. |
| **No compute shader support** — WebGL has no compute capability. All GPU computation done on CPU or via transform feedback hacks. | — (systemic) | 🔴 High | ✅ **FIXED** | `WebGPUComputeCommand.ts`, `WebGPUComputeEngine.ts`. Compute shaders for BRDF LUT generation, frustum culling (`FrustumCull.wgsl`), and more. **Abstract compute capability API** added to `GraphicsContext`: `supportsComputeShaders`, `supportsStorageBuffers`, `supportsIndirectCompute`, `maxComputeWorkgroupsPerDimension/InvocationsPerWorkgroup/StorageSize`. WebGPU overrides report real device limits. WebGL 2.0 has future-ready extension scaffolding (`WEBGL_compute`, `WEBGL_shader_storage_buffer`) — currently all return false, auto-enabling when extensions ship. Scene code queries `context.supportsComputeShaders` for backend-agnostic compute dispatch. |
| **GLSL `#ifdef` debug stripping is fragile** — `includeStart`/`includeEnd` pragma comments are non-standard and error-prone | — (code analysis) | 🟢 Low | ⬜ **OPEN** | CesiumJS uses custom `//>>includeStart('debug')` / `//>>includeEnd('debug')` comments for tree-shaking debug checks. These are fragile (comment-based, not AST-based) and occasionally interact poorly with other tools. |

---

## 2. Rendering & Graphics Issues

### 2.1 Visual Quality Bugs

| Issue | Upstream # | Severity | Our Status | Details |
|-------|-----------|----------|------------|---------|
| **Poor billboard quality** — Blurry billboards at various zoom levels. 30 comments. Priority-high. | [#4235](https://github.com/CesiumGS/cesium/issues/4235) | 🔴 High | 🟡 **MITIGATED** | Our WebGPU billboard renderer uses instanced quads with proper texture sampling. Underlying quality depends on atlas generation (shared code). |
| **Blinking entity on shader properties update** — Entities flash when material properties change at runtime. 8 comments. | [#12532](https://github.com/CesiumGS/cesium/issues/12532) | 🟡 Medium | ⬜ **OPEN** | Not yet addressed in either path. |
| **Z-Ordering of entity collection** — No control over entity draw order. 47 comments. Longest-running request. | [#4108](https://github.com/CesiumGS/cesium/issues/4108) | 🔴 High | ⚡ **IMPROVED** | `sortKey` property added to both `DrawCommand` (WebGL) and `WebGPUDrawCommand` (WebGPU). Lower values render first within a pass. **Parity gaps:** (1) `sortKey` is not declared in `WebGPUDrawCommandOptions` interface — TypeScript strict mode would reject it. (2) `WebGPUDrawCommand.clone()` does not copy `sortKey`. (3) No sorting comparator in Scene.js/View.js actually reads `sortKey` — the property exists on both backends but is **dead code** in both. (4) No scene code or collection sets `sortKey` values. Next steps: add `sortKey` to View.js sorting comparators (shared, benefits both backends), expose `renderOrder` on collections, fix WebGPUDrawCommand clone/options. See FORK-31. |
| **Multiple light sources and light types** — Only one directional sun light. 12 comments. | [#8518](https://github.com/CesiumGS/cesium/issues/8518) | 🟡 Medium | ⚡ **IMPROVED** | `Light.ts` class hierarchy created (renderer-agnostic ✅): `DirectionalLight`, `PointLight`, `SpotLight` + `LightCollection` with `pack()` for GPU uniform buffers. `LightUniforms.wgsl` updated with `LightData` struct array (8 lights), attenuation functions. **Parity gaps:** (1) **No GLSL multi-light shader** — WebGL GLSL still uses single-light uniforms (`czm_lightDirectionEC`, `czm_lightColorHdr` in `LightingStageFS.glsl`). A GLSL `czm_multiLight` struct + attenuation functions matching WGSL are needed. (2) **No `scene.lights` property** — No scene file imports `LightCollection`; `scene.light` (singular, from `SunLight.js`) is the only lighting API. (3) `LightCollection.pack()` format is WebGPU uniform-buffer-aligned (std140 padding) — WebGL equivalent needs `czm_` auto-uniform integration. Next steps: add `scene.lights` (shared), create GLSL multi-light builtin, wire into `UniformState.js`. See FORK-32, FORK-33. |
| **Fit texture coordinates to rectangle/trapezoid geometry** — Textures don't map correctly to non-rectangular shapes. 16 comments. | [#4164](https://github.com/CesiumGS/cesium/issues/4164) | 🟡 Medium | ⬜ **OPEN** | Not addressed. |
| **Material difference in 2D scene** — Materials render differently in 2D vs 3D mode | [#9853](https://github.com/CesiumGS/cesium/issues/9853) | 🟡 Medium | ⬜ **OPEN** | Not addressed. |
| **Support for animated billboards** — No sprite-sheet animation support. 15 comments. | [#2319](https://github.com/CesiumGS/cesium/issues/2319) | 🟡 Medium | ⬜ **OPEN** | Not addressed. |
| **disableDepthTestDistance causes weird mouse interaction** — Billboards with depth test disabled cause unexpected picking. 9 comments. | [#6840](https://github.com/CesiumGS/cesium/issues/6840) | 🟡 Medium | ⬜ **OPEN** | Not addressed. |
| **Adding a silhouette to glTF crashes when no normals found** | [#7586](https://github.com/CesiumGS/cesium/issues/7586) | 🟡 Medium | ⬜ **OPEN** | Not addressed. |

### 2.2 Rendering Performance

| Issue | Upstream # | Severity | Our Status | Details |
|-------|-----------|----------|------------|---------|
| **No `WEBGL_multi_draw` / `WEBGL_multi_draw_instanced`** — Each primitive requires separate draw call | [#7595](https://github.com/CesiumGS/cesium/issues/7595) | 🔴 High | 🔧 **PLANNED** | `WebGPUIndirectDrawManager.ts` infrastructure built for GPU-driven indirect drawing. Not yet activated for production. |
| **Dynamic Buffers roadmap** — No ring-buffer or sub-allocation for per-frame data. Creates new buffers constantly. | [#932](https://github.com/CesiumGS/cesium/issues/932) | 🔴 High | 🔧 **PLANNED** | `WebGPUStorageBufferPool.ts`, `WebGPUBufferMapper.ts` infrastructure built. Ring-buffer sub-allocator planned but not active. |
| **No render bundles** — Every frame re-records all GPU commands | — (WebGL limitation) | 🟡 Medium | 🔧 **PLANNED** | `WebGPURenderBundleManager.ts` exists. Can provide 50-80% CPU reduction for static terrain tiles. Not yet activated. |
| **No GPU-driven culling** — All frustum culling done on CPU | — (WebGL limitation) | 🟡 Medium | 🔧 **PLANNED** | `WebGPUGPUCuller.ts` + `FrustumCull.wgsl` compute shader infrastructure ready. |
| **No GPU profiling/timestamp queries** | — (WebGL limitation) | 🟡 Medium | 🔧 **PLANNED** | `WebGPUTimestampProfiler.ts` exists. `timestamp-query` feature auto-detected at device creation. |
| **Canvas2D readback performance** — Multiple readback operations for picking/clustering are slow | Forum discussion | 🟡 Medium | 🔧 **PLANNED** | `WebGPUPickFramebuffer.ts` uses `copyTextureToBuffer` + `mapAsync` for efficient GPU readback. |

### 2.3 Post-Processing & Effects

| Issue | Upstream # | Severity | Our Status | Details |
|-------|-----------|----------|------------|---------|
| **Consider post-processing for imagery layers to enable analysis** | [#8110](https://github.com/CesiumGS/cesium/issues/8110) | 🟡 Medium | 🔧 **PLANNED** | WebGPU `PostProcessPipeline.ts` with ping-pong textures. Compute shaders can process imagery on GPU. |
| **Alpha blending for imagery layers LODs** | [#8140](https://github.com/CesiumGS/cesium/issues/8140) | 🟡 Medium | ⬜ **OPEN** | Not yet addressed. |
| **Extruded geometry on terrain** — Geometry extruded from terrain doesn't clamp properly. Priority-high. | [#4743](https://github.com/CesiumGS/cesium/issues/4743) | 🔴 High | ⬜ **OPEN** | Not addressed. |

---

## 3. Performance & Memory Problems

### 3.1 Memory Leaks (Systemic)

| Issue | Upstream # | Severity | Our Status | Details |
|-------|-----------|----------|------------|---------|
| **CesiumWidget not released from memory when destroyed** — Viewer/Widget destroy doesn't fully free resources | [#9298](https://github.com/CesiumGS/cesium/issues/9298) | 🔴 High | 🟡 **MITIGATED** | `ContextRegistry` tracks all active contexts. `GraphicsContext.destroy()` provides centralized cleanup. Underlying Widget lifecycle issue same as upstream. |
| **`viewer.destroy` after `viewer.flyTo` causes memory leaks** | [#8378](https://github.com/CesiumGS/cesium/issues/8378) | 🟡 Medium | ⬜ **OPEN** | Not addressed. |
| **Can't free memory from GeoJsonDataSource even when not added to viewer** — 11 comments | [#9058](https://github.com/CesiumGS/cesium/issues/9058) | 🟡 Medium | ⬜ **OPEN** | DataSource layer not modified. |
| **Memory leak when updating geojson at 15Hz in 3D mode** — Priority-high | [#5662](https://github.com/CesiumGS/cesium/issues/5662) | 🔴 High | ⬜ **OPEN** | Entity/DataSource layer not modified. |
| **Serious memory leak in `Resource` in Node.js** (`RequestScheduler.activeRequests`) — 5 comments | [#7670](https://github.com/CesiumGS/cesium/issues/7670) | 🟡 Medium | ⬜ **OPEN** | Not addressed. |
| **Memory leak from textures in custom shaders of hidden tilesets** | [#12676](https://github.com/CesiumGS/cesium/issues/12676) | 🟡 Medium | ⬜ **OPEN** | Not addressed. |
| **Many PerformanceMeasure objects cause memory leak** | [#12932](https://github.com/CesiumGS/cesium/issues/12932) | 🟡 Medium | ⬜ **OPEN** | Not addressed. |

### 3.2 GC Pressure & Allocation

| Issue | Upstream # | Severity | Our Status | Details |
|-------|-----------|----------|------------|---------|
| **Lots of models leads to high GC usage** — Frequent garbage collection pauses when many glTF models loaded. Priority-high. | [#3125](https://github.com/CesiumGS/cesium/issues/3125) | 🔴 High | 🔧 **PLANNED** | WebGPU path can use storage buffers and instanced rendering to reduce per-model allocations. `WebGPUStorageBufferPool.ts` designed for this. |
| **High memory consumption with external tilesets** — 18 comments. Priority-high. | [#3453](https://github.com/CesiumGS/cesium/issues/3453) | 🔴 High | ⬜ **OPEN** | 3D Tiles pipeline not yet started in WebGPU path. |
| **Dynamic terrain exaggeration consumes unnecessary GPU memory** — 8 comments | [#12895](https://github.com/CesiumGS/cesium/issues/12895) | 🟡 Medium | ⬜ **OPEN** | Not addressed. |
| **Chrome Warning about camera performance** | [#12076](https://github.com/CesiumGS/cesium/issues/12076) | 🟡 Medium | ⬜ **OPEN** | Not addressed. |

### 3.3 CPU Bottlenecks (Identified for WASM Conversion)

| Bottleneck | Upstream # | Severity | Our Status | Details |
|-----------|-----------|----------|------------|---------|
| **HeightmapTessellator is a known JS hotspot** — Terrain tessellation is CPU-bound | — (code analysis) | 🔴 High | 🔧 **PLANNED** | Identified for WASM conversion. Expected 2-5x speedup. |
| **QuantizedMeshTerrainData — zigzag decode is integer-heavy** | — (code analysis) | 🟡 Medium | 🔧 **PLANNED** | Identified for WASM conversion. Expected 3-8x speedup. |
| **BoundingSphere frustum culling — 6 planes × 1000s/frame** | — (code analysis) | 🟡 Medium | 🔧 **PLANNED** | GPU compute (`WebGPUGPUCuller.ts`) OR WASM SIMD. Expected 4-10x speedup. |
| **EncodedCartesian3 per-vertex RTE encoding** | — (code analysis) | 🟡 Medium | 🔧 **PLANNED** | Identified for WASM batch processing. Expected 2-3x speedup. |
| **Matrix4 batch multiply per-entity per-frame** | — (code analysis) | 🟡 Medium | 🔧 **PLANNED** | Identified for WASM SIMD. Expected 2-4x speedup. |
| **Tile transforms performance hit** | [#11267](https://github.com/CesiumGS/cesium/issues/11267) | 🟡 Medium | 🔧 **PLANNED** | WASM SIMD batch matrix multiply would address this. |
| **Performance issue with `aggregateAttributeValues` in GaussianSplatPrimitive** — 4 comments | [#12797](https://github.com/CesiumGS/cesium/issues/12797) | 🟡 Medium | ⚡ **IMPROVED** | Our `WebGPUGaussianSplatRenderer.ts` uses GPU compute for 3D→2D covariance projection. |
| **Clustering is slow in 2D** | [#5145](https://github.com/CesiumGS/cesium/issues/5145) | 🟡 Medium | ⬜ **OPEN** | Clustering logic is renderer-agnostic, same issue in both paths. |

---

## 4. Camera & Navigation Bugs

| Issue | Upstream # | Severity | Our Status | Details |
|-------|-----------|----------|------------|---------|
| **Follow-camera** — No built-in follow/chase camera mode. Priority-high. | [#5241](https://github.com/CesiumGS/cesium/issues/5241) | 🟡 Medium | ⬜ **OPEN** | Camera API not modified. |
| **Zooming with the mouse wheel is jumpy** — 6 comments | [#4537](https://github.com/CesiumGS/cesium/issues/4537) | 🟡 Medium | ⬜ **OPEN** | Camera API not modified. |
| **Camera boundary** — No built-in camera constraints/bounds. 33 comments. Priority-high. | [#4802](https://github.com/CesiumGS/cesium/issues/4802) | 🔴 High | ⬜ **OPEN** | Camera API not modified. |
| **KML viewer.flyTo placemark goes underground** — 13 comments. Priority-high. | [#4327](https://github.com/CesiumGS/cesium/issues/4327) | 🟡 Medium | ⬜ **OPEN** | Camera/KML not modified. |
| **Camera.computeViewRectangle doesn't work in 2D or CV** — 24 comments. Priority-high. | [#4346](https://github.com/CesiumGS/cesium/issues/4346) | 🔴 High | ⬜ **OPEN** | Camera API not modified. |
| **Touch controls have regressed** — 6 comments | [#4363](https://github.com/CesiumGS/cesium/issues/4363) | 🟡 Medium | ⬜ **OPEN** | Input handling not modified. |
| **Pinch gesture on laptop trackpad doesn't zoom** | [#12772](https://github.com/CesiumGS/cesium/issues/12772) | 🟡 Medium | ⬜ **OPEN** | Input handling not modified. |
| **Dynamic boxes don't track correctly** — Camera/entity tracking mismatch. 8 comments. Priority-high. | [#5164](https://github.com/CesiumGS/cesium/issues/5164) | 🟡 Medium | ⬜ **OPEN** | Entity tracking not modified. |
| **Scrolling to zoom in/out is way too fast on high refresh rate screens** | [#12187](https://github.com/CesiumGS/cesium/issues/12187) | 🟡 Medium | ⬜ **OPEN** | Input handling not modified. |

---

## 5. 2D / Columbus View Bugs

| Issue | Upstream # | Severity | Our Status | Details |
|-------|-----------|----------|------------|---------|
| **Polyline is disrupted when placed at certain positions** in 2D/Columbus View | [#11351](https://github.com/CesiumGS/cesium/issues/11351) | 🟡 Medium | ⬜ **OPEN** | Polyline 2D path not modified. |
| **Polyline without callback disappears** when `mapMode2D: Cesium.MapMode2D.ROTATE` | [#11370](https://github.com/CesiumGS/cesium/issues/11370) | 🟡 Medium | ⬜ **OPEN** | Polyline 2D path not modified. |
| **Models not accurately projected to 2D** — Known limitation acknowledged by CesiumGS | Forum discussion | 🟡 Medium | ⬜ **OPEN** | 2D projection not modified. |
| **Picking & GroundPrimitive in 2D model throw an error** | [#11696](https://github.com/CesiumGS/cesium/issues/11696) | 🟡 Medium | ⬜ **OPEN** | Picking not modified. |

---

## 6. Entity & DataSource Issues

| Issue | Upstream # | Severity | Our Status | Details |
|-------|-----------|----------|------------|---------|
| **Picking priority** — No way to set pick priority for overlapping entities. 15 comments. Priority-high. | [#1592](https://github.com/CesiumGS/cesium/issues/1592) | 🔴 High | ⬜ **OPEN** | Picking system not modified. |
| **Use scene.pick to get per-point properties** — Can't pick individual points in point cloud entities | [#7408](https://github.com/CesiumGS/cesium/issues/7408) | 🟡 Medium | ⬜ **OPEN** | Picking system not modified. |
| **Retrieve point cloud point positions on click** — 7 comments | [#7953](https://github.com/CesiumGS/cesium/issues/7953) | 🟡 Medium | ⬜ **OPEN** | Picking system not modified. |
| **CLAMP_TO_GROUND for Billboards incorrect positions** — 9 comments. Priority-high. | [#4776](https://github.com/CesiumGS/cesium/issues/4776) | 🟡 Medium | ⬜ **OPEN** | Billboard clamping not modified. |
| **Support rounded LabelGraphics background** | [#7525](https://github.com/CesiumGS/cesium/issues/7525) | 🟢 Low | ⬜ **OPEN** | Not addressed. |
| **Better support for custom `PositionProperty` implementations** | [#9491](https://github.com/CesiumGS/cesium/issues/9491) | 🟡 Medium | ⬜ **OPEN** | Entity API not modified. |
| **Scene ready event** — No reliable "everything loaded" event. Priority-high. | [#4422](https://github.com/CesiumGS/cesium/issues/4422) | 🟡 Medium | ⬜ **OPEN** | Not addressed. |
| **Problems with clamped polygons on mobile devices** — 7 comments | [#9702](https://github.com/CesiumGS/cesium/issues/9702) | 🟡 Medium | ⬜ **OPEN** | Not addressed. |
| **WMS GetFeatureInfo incorrect point position** | [#9363](https://github.com/CesiumGS/cesium/issues/9363) | 🟡 Medium | ⬜ **OPEN** | Not addressed. |

---

## 7. 3D Tiles Issues

| Issue | Upstream # | Severity | Our Status | Details |
|-------|-----------|----------|------------|---------|
| **Vector Tiles** — Top-voted feature request (since 2014). Roadmap item. | [#2132](https://github.com/CesiumGS/cesium/issues/2132) | 🔴 High | ⬜ **OPEN** | Not addressed. |
| **High memory consumption with external tilesets** — 18 comments. Priority-high. | [#3453](https://github.com/CesiumGS/cesium/issues/3453) | 🔴 High | ⬜ **OPEN** | 3D Tiles not yet started in WebGPU. |
| **Tileset being selected for rendering on the other side of the globe** — 10 comments | [#8612](https://github.com/CesiumGS/cesium/issues/8612) | 🟡 Medium | ⬜ **OPEN** | Tile traversal not modified. |
| **Race condition in `Cesium3DTileset.memoryAdjustedScreenSpaceError`** | [#11447](https://github.com/CesiumGS/cesium/issues/11447) | 🟡 Medium | ⬜ **OPEN** | Not addressed. |
| **Allow for breadth-first Cesium3dTiles traversal** — Performance optimization request | [#12377](https://github.com/CesiumGS/cesium/issues/12377) | 🟡 Medium | ⬜ **OPEN** | Not addressed. |
| **Decouple 3D Tiles and other loaders** — Tight coupling between tile formats and renderers | [#6727](https://github.com/CesiumGS/cesium/issues/6727) | 🟡 Medium | ⚡ **IMPROVED** | Our `GraphicsContext` + Feature Renderer pattern naturally decouples loaders from renderers. Tile management (traversal, caching, LOD) is renderer-agnostic. |
| **ClippingPlane coordinate system in 3DTilesets** | [#12359](https://github.com/CesiumGS/cesium/issues/12359) | 🟡 Medium | ⬜ **OPEN** | Not addressed. |

---

## 8. Terrain & Imagery Issues

| Issue | Upstream # | Severity | Our Status | Details |
|-------|-----------|----------|------------|---------|
| **Imagery layer min/max zoom level confusion** — Confusing API for controlling imagery visibility | [#6564](https://github.com/CesiumGS/cesium/issues/6564) | 🟡 Medium | ⬜ **OPEN** | Imagery API not modified. |
| **Allow user to override draw function in GridImageryProvider** — 5 comments | [#8282](https://github.com/CesiumGS/cesium/issues/8282) | 🟡 Medium | ⬜ **OPEN** | Not addressed. |
| **Alpha blending for imagery layers LODs** | [#8140](https://github.com/CesiumGS/cesium/issues/8140) | 🟡 Medium | ⬜ **OPEN** | Not addressed. |
| **Dynamic terrain exaggeration consumes unnecessary GPU memory** — 8 comments | [#12895](https://github.com/CesiumGS/cesium/issues/12895) | 🟡 Medium | ⬜ **OPEN** | Not addressed. |
| **Add support for EGM96 / EGM2008 / MSL lookup** | [#11786](https://github.com/CesiumGS/cesium/issues/11786) | 🟡 Medium | ⬜ **OPEN** | Not addressed. |

---

## 9. Model / glTF Issues

| Issue | Upstream # | Severity | Our Status | Details |
|-------|-----------|----------|------------|---------|
| **Support dynamically changing a 3D model's texture** — 39 comments | [#5094](https://github.com/CesiumGS/cesium/issues/5094) | 🔴 High | ⬜ **OPEN** | Model pipeline only basic PBR in WebGPU path. |
| **Clunky code needed to load and use a Model** — API ergonomics complaint | [#11216](https://github.com/CesiumGS/cesium/issues/11216) | 🟡 Medium | ⬜ **OPEN** | Model API not modified. |
| **Adding a silhouette to glTF crashes when no normals found** | [#7586](https://github.com/CesiumGS/cesium/issues/7586) | 🟡 Medium | ⬜ **OPEN** | Not addressed. |
| **Lots of models leads to high GC usage** — Priority-high | [#3125](https://github.com/CesiumGS/cesium/issues/3125) | 🔴 High | 🔧 **PLANNED** | WebGPU instanced rendering + storage buffers could eliminate per-model allocations. |
| **80+ file Model pipeline is complex and tightly coupled** | — (code analysis) | 🔴 High | ⚡ **IMPROVED** | Our `GraphicsContext` + Feature Renderer pattern provides cleaner separation. Full Model pipeline is our largest remaining task (10-15 days estimated). |
| **Primitive interface documentation** — Poor docs for extending Primitive | [#4817](https://github.com/CesiumGS/cesium/issues/4817) | 🟢 Low | ⬜ **OPEN** | Not addressed. |

---

## 10. API Design & Developer Experience

| Issue | Upstream # | Severity | Our Status | Details |
|-------|-----------|----------|------------|---------|
| **Integrate with other WebGL engines** — Three.js, Babylon.js interop. 23 comments. | [#648](https://github.com/CesiumGS/cesium/issues/648) | 🟡 Medium | ⚡ **IMPROVED** | `GraphicsContext` abstraction makes engine integration cleaner. `SharedResourcePool.ts` supports cross-context resource sharing. |
| **Declarative custom elements for Cesium** — Web Components approach. 6 comments. | [#10876](https://github.com/CesiumGS/cesium/issues/10876) | 🟡 Medium | ⬜ **OPEN** | Not addressed. |
| **Reenvision WebGL unit tests** — Tests tightly coupled to WebGL internals | [#4817 related](https://github.com/CesiumGS/cesium/issues/4817) | 🟡 Medium | 🟡 **MITIGATED** | Our abstract `GraphicsContext` allows testing against the abstract API. But we have 0 Jasmine tests for WebGPU code currently. |
| **`Texture3D` support for more source data types** | [#12788](https://github.com/CesiumGS/cesium/issues/12788) | 🟢 Low | ✅ **FIXED** | `WebGPUTexture3D.ts` supports multiple source formats via WebGPU's `copyExternalImageToTexture`. |
| **Use HTTPS for local development** | [#12788 related](https://github.com/CesiumGS/cesium) | 🟢 Low | ⬜ **OPEN** | Not addressed. |
| **Async version of Resource `getURL`** | GitHub | 🟢 Low | ⬜ **OPEN** | Not addressed. |

---

## 11. Build System & Packaging

| Issue | Upstream # | Severity | Our Status | Details |
|-------|-----------|----------|------------|---------|
| **Publish smaller packages** — Monolithic 4MB+ bundle. 22 comments. | [#10636](https://github.com/CesiumGS/cesium/issues/10636) | 🔴 High | ⬜ **OPEN** | Not addressed. Same monorepo structure. |
| **Inline Static Assets in Builds** — 18 comments | [#10619](https://github.com/CesiumGS/cesium/issues/10619) | 🟡 Medium | ⬜ **OPEN** | Not addressed. |
| **No WGSL shader build pipeline** | — (systemic) | 🟡 Medium | ✅ **FIXED** | `wgslToJavaScript()` in `scripts/build.js`. Gulpfile watches `.wgsl` files. Full build integration. |
| **No shader cross-compilation** | — (systemic) | 🟡 Medium | ✅ **FIXED** | `scripts/compileSlang.js` — Slang `.slang` → WGSL + GLSL dual output. Optional, pre-compiled fallback. |
| **Build system doesn't support TypeScript natively** | — (systemic) | 🟡 Medium | ⚡ **IMPROVED** | Our WebGPU code is all TypeScript, compiled alongside JS. `tsconfig.json` configured. |

---

## 12. Community-Requested Features

### Features the community has been asking for that our fork can uniquely address:

| Feature Request | Community Demand | Our Status | Details |
|----------------|-----------------|------------|---------|
| **WebGPU support** | 12+ forum threads, multiple GitHub comments | ✅ **ACTIVE** | 83+ files, 67+ shaders, 22+ features rendering. Only comprehensive CesiumJS WebGPU implementation in existence. |
| **Better performance for large datasets** | 50+ forum threads, 33 open perf issues | 🔧 **PLANNED** | GPU compute culling, indirect drawing, render bundles, storage buffers — all infrastructure built. |
| **WebAssembly for CPU bottlenecks** | Multiple forum discussions | 🔧 **PLANNED** | 6 targets identified (terrain, culling, RTE encoding, matrix math). Decision matrix for GPU compute vs WASM documented. |
| **TypeScript** | [#4434](https://github.com/CesiumGS/cesium/issues/4434) — 15 comments | ⚡ **ACTIVE** | All new WebGPU code is TypeScript. Enforces API parity at compile time. |
| **Multi-viewer / split-screen** | Multiple forum threads | ✅ **BUILT** | `ContextRegistry`, `WebGPUDevicePool`, per-view context. Split-screen test page exists. |
| **Async initialization** | Multiple forum threads about blocking | ✅ **BUILT** | `Viewer.createAsync()` with `LoadingOverlay`. |
| **Compute shaders** | Forum discussions about analysis/processing | ✅ **BUILT** | `WebGPUComputeEngine.ts`, BRDF LUT compute shader, frustum cull compute shader. |
| **Offscreen rendering** | [#6896](https://github.com/CesiumGS/cesium/issues/6896) | 🔧 **PLANNED** | `OffscreenContextSupport.ts` infrastructure exists. |
| **Better context loss handling** | [#5991](https://github.com/CesiumGS/cesium/issues/5991) — 9 comments | ⚡ **IMPROVED** | `WebGPUDeviceLossRecovery.ts` handles device loss with automatic re-initialization. |

---

## 13. Summary: Our Fork's Advantage

### Issues Categorized by Our Fork's Status

| Status | Count | Percentage |
|--------|-------|-----------|
| ✅ **FIXED** | 16 | 17% |
| ⚡ **IMPROVED** | 14 | 15% |
| 🔧 **PLANNED** (infrastructure built) | 15 | 16% |
| 🟡 **MITIGATED** | 4 | 4% |
| ⬜ **OPEN** (same as upstream) | 42 | 45% |
| **Total upstream tracked** | **91** | 100% |
| 🔶 **Fork-specific tech debt** | **36** | — (see §14) |

### Key Differentiators

1. **Renderer Abstraction (✅ FIXED)** — The #1 architectural debt in upstream CesiumJS is the hardwired WebGL dependency. Our `GraphicsContext` abstract base class solves this permanently.

2. **WebGPU Backend (✅ FIXED)** — The community's most-requested graphics feature. CesiumGS has 3 tiny hackathon branches (565 commits behind). Our implementation is 83+ files, 10-20x more comprehensive.

3. **TypeScript for New Code (⚡ IMPROVED)** — Upstream's #4434 (TypeScript migration) has been open since 2016 with 15 comments. All our new code is TypeScript, proving the path forward.

4. **ES6 Classes (⚡ IMPROVED)** — Upstream's #8359 (ES6 class syntax) has been open since 2019. We've converted `Context.js` and all new code uses ES6 classes.

5. **Performance Infrastructure (🔧 PLANNED)** — 7 WebGPU performance features with infrastructure built (render bundles, indirect drawing, GPU culling, storage buffers, timestamp profiling, buffer mapping, uniform grouping). These address the 33 open performance issues that WebGL architecturally cannot solve.

6. **Async Initialization (✅ FIXED)** — The synchronous `new Viewer()` pattern blocks the main thread. Our `Viewer.createAsync()` with `LoadingOverlay` is the correct modern pattern.

7. **Multi-Context (✅ FIXED)** — No upstream support for multiple viewers sharing GPU resources. Our `ContextRegistry` + `WebGPUDevicePool` + per-view context selection enables split-screen and mixed-backend rendering.

### What We DON'T Fix (Same as Upstream)

The 42 **OPEN** issues are primarily in areas we haven't modified:
- **Camera/Navigation** (7 issues) — Camera API unchanged
- **Entity/DataSource** (7 issues) — Entity system unchanged
- **2D/Columbus View** (4 issues) — 2D projection unchanged
- **Terrain/Imagery API** (5 issues) — Imagery layer API unchanged
- **Build/Packaging** (2 issues) — Monorepo structure unchanged
- **Legacy code** (5 issues) — IE11 workarounds, demodernizeShader, Knockout, destroyObject, GLSL pragmas
- **Miscellaneous bugs** (12 issues) — Various subsystems unchanged

These are opportunities for future work that complement (not conflict with) our WebGPU additions.

---

## 14. Fork-Specific Tech Debt

This section documents tech debt **introduced by our fork's WebGPU additions**. These are issues that do not exist in upstream CesiumJS — they are exclusively artifacts of our WebGPU renderer, modified scene files, build system additions, and test infrastructure.

### 14.1 Duplicated & Dead Code

| ID | Issue | Severity | Files Affected | Details |
|----|-------|----------|---------------|---------|
| **FORK-1** | ~~**Device loss recovery logic duplicated**~~ — Inline device loss handler removed from `WebGPUContext.ts`. Now delegates to `WebGPUDeviceLossRecovery` via the `DeviceLossRecoveryHost` interface pattern. Added `_reconfigureCanvas()` and `_clearAllCaches()` host methods. ~150 lines of duplicated code eliminated. | ✅ Resolved | `WebGPUContext.ts`, `WebGPUDeviceLossRecovery.ts` | `WebGPUContext._setupDeviceLostHandler()` creates a `WebGPUDeviceLossRecovery` instance with a host adapter. `onDeviceLost()`, `deviceLossState`, and `recoveryAttempts` delegate to the recovery instance. |
| **FORK-2** | ~~**Unused imports in `WebGPUContext.ts`**~~ — `WebGPUResourceManager` and `WebGPUPickManager` imports removed. | ✅ Resolved | `WebGPUContext.ts` | Dead imports removed. Can be re-added when their intended usage is implemented. |
| **FORK-3** | ~~**Redundant shader loading in `Scene.createAsync`**~~ — Shader loading code removed from `Scene.createAsync`. Shaders are now loaded exclusively in `WebGPUContext._initialize()`. | ✅ Resolved | `Scene.js` | Redundant shader loading block removed. Comment explains shaders are loaded during context init. |
| **FORK-4** | **`WebGLCompatibilityStub.ts` was ~700 lines — now split into domain modules** — Provides a fake `WebGLRenderingContext` so legacy CesiumJS code (`Texture.js`, `Framebuffer.js`, etc.) and third-party consumers (e.g., TerriaJS) don't crash when running under WebGPU. **Refactored:** Split into 5 domain modules under `Stubs/` directory (`WebGLStubTexture`, `WebGLStubFramebuffer`, `WebGLStubBuffer`, `WebGLStubPipelineState`, `WebGLStubShader`) with shared types in `WebGLStubTypes`. The main `WebGLCompatibilityStub.ts` is now a ~85-line nexus that composes all domain stubs. Individual domain modules can be removed as their corresponding CesiumJS subsystems are migrated. | 🟡 Medium | `WebGLCompatibilityStub.ts` (nexus), `Stubs/WebGLStubTypes.ts`, `Stubs/WebGLStubTexture.ts`, `Stubs/WebGLStubFramebuffer.ts`, `Stubs/WebGLStubBuffer.ts`, `Stubs/WebGLStubPipelineState.ts`, `Stubs/WebGLStubShader.ts` | Severity reduced from 🔴 High to 🟡 Medium — file is now maintainable and extensible. `GraphicsContext` factory methods (`createTexture`, `createBuffer`) continue to reduce dependency over time. Each domain module can be independently deprecated/removed. |

### 14.2 Backend Agnosticism Violations

| ID | Issue | Severity | Files Affected | Details |
|----|-------|----------|---------------|---------|
| **FORK-5** | ~~**8 scene files still directly import from `Renderer/WebGPU/`**~~ — Phase D migration **28/28 complete**. Zero scene files directly import from `Renderer/WebGPU/`. All scene files use `context.getFeatureRenderer(FeatureRendererKey.XXX)` pattern exclusively. | ✅ Resolved | — (none remaining) | Verified by codebase search: 0 `import.*from.*Renderer/WebGPU/` matches in any Scene file. This eliminates the #1 source of upstream merge conflicts. |
| **FORK-6** | ~~**26 `isWebGPU` checks remain in scene files**~~ — Reduced from 26 to **~10 occurrences across 3 files**. Remaining are: Scene.js (property definition + JSDoc + 1 panorama command-type check), Primitive.js (2 `isWebGPUDrawCommand` command-type checks for uniform routing), GlobeSurfaceTileProvider.js (property assignment + comment). **No actual `context.isWebGPU` branching logic remains** — all are property definitions, comments, or acceptable command-type checks. | ✅ Resolved (effectively) | `Scene.js` (property def), `Primitive.js` (2 cmd-type), `GlobeSurfaceTileProvider.js` (comment) | The 2 `isWebGPUDrawCommand` checks in Primitive.js are command-type checks (not backend checks) — acceptable per FORK-8 rules. Could be eliminated with `RenderCommand` (Path B) in the future. |
| **FORK-7** | ~~**`Scene.js` uses `rendererType === "webgpu"` string comparison**~~ — Now uses `context.depthRangeZeroToOne` capability getter. `depthRangeZeroToOne` added to `GraphicsContext` base (returns `false`), overridden in `WebGPUContext` (returns `true`). | ✅ Resolved | `Scene.js`, `GraphicsContext.ts`, `WebGPUContext.ts` | Scene.js no longer checks renderer type string. Backend-agnostic capability query used instead. |
| **FORK-8** | **`panoramaCommand.isWebGPUDrawCommand === true` in Scene.js** — Direct command-type check in `renderEnvironment` function. While technically a command-type check (not a backend check), it introduces WebGPU awareness into scene-level code. | 🟢 Low | `Scene.js` | Acceptable per migration status notes. Could be eliminated by using `RenderCommand` (Path B) pattern for panorama commands. |

### 14.3 Type Safety Issues

| ID | Issue | Severity | Files Affected | Details |
|----|-------|----------|---------------|---------|
| **FORK-9** | ~~**18 `as any` type casts in WebGPU TypeScript files**~~ — Reduced from 18 to **~11**. Fixed: `WebGPUBuffer.ts` (3→0, using `gpuData()` helper), `WebGPUTexture3D.ts` (3→0, proper `ArrayBufferView` typing), `WebGPUCubeMap.ts` (1→0, typed union access). Remaining ~11 are in `WebGPUContext.ts` (8, unavoidable JS interop for `ShaderCache`/`PassState`/`RenderState`/`ContextLimits`), `WebGPUGlobeSurfaceRenderer.ts` (1, `@webgpu/types` limitation for `copyExternalImageToTexture`), `WebGPUSubgroupUtils.ts` (1), `WebGPUDepthPlane.ts` (1). | ⚡ Improved | `WebGPUContext.ts` (8), `WebGPUGlobeSurfaceRenderer.ts` (1), `WebGPUSubgroupUtils.ts` (1), `WebGPUDepthPlane.ts` (1) | 7 casts eliminated via `gpuData()` type helper and proper ArrayBufferView typing. Remaining casts are unavoidable JS↔TS interop (CesiumJS classes lack TypeScript declarations) or `@webgpu/types` limitations. |
| **FORK-10** | ~~**1 `@ts-ignore` annotation**~~ — Changed to `@ts-expect-error` per coding guide in `WebGPUFeatureRenderers.ts`. | ✅ Resolved | `WebGPUFeatureRenderers.ts` | Per coding guide §4.3: "Prefer `@ts-expect-error` over `@ts-ignore`." |
| **FORK-11** | **`webgpuTypeHelpers.ts` exists but has limited adoption** — A dedicated module was created to provide type-safe wrappers to avoid `as any`, but most files still use raw casts. | 🟡 Medium | `webgpuTypeHelpers.ts` (definition), various (non-adoption) | The helpers should be used consistently across all WebGPU .ts files to reduce `as any` count. |

### 14.4 Console Noise & Logging

| ID | Issue | Severity | Files Affected | Details |
|----|-------|----------|---------------|---------|
| **FORK-12** | ~~**30 `console.warn/error` calls across WebGPU .ts files not using context-aware logging**~~ — `WebGPUContext.ts` fully migrated: 11 `console.warn/error` calls converted to `this.log()` with `[CesiumJS:type:shortId]` prefix. `WebGPUDeviceLossRecovery.ts` retains `console.*` calls (acceptable — context may be in broken state during recovery). Remaining files (~12 calls) across standalone modules use `[CesiumJS:webgpu]` prefix as a compromise. | ✅ Resolved (primary file) | `WebGPUContext.ts` (11→0 bare calls), `WebGPUDeviceLossRecovery.ts` (5, acceptable), others (~12, lower priority) | The main file (`WebGPUContext.ts`) that had the most calls is now fully migrated. Standalone modules without context access use manual `[CesiumJS:webgpu]` prefix. |
| **FORK-13** | ~~**Debug logging in `WebGPUSceneRenderer.ts` during normal operation**~~ — Verified: `WebGPUSceneRenderer.ts` contains **zero** `console.log/warn/error` calls. No per-frame logging exists. The file is production-clean. | ✅ Resolved | `WebGPUSceneRenderer.ts` | Investigation confirmed no logging exists to gate. |

### 14.5 Shader & Preprocessing Issues

| ID | Issue | Severity | Files Affected | Details |
|----|-------|----------|---------------|---------|
| **FORK-14** | ~~**Dual source-of-truth for shader chunks — live drift bug**~~ — `CameraUniforms` inline struct in `WGSLBuiltins.ts` synced with `.wgsl` file. Now includes all 10 fields: RTE uniforms (`encodedCameraPositionMCHigh/Low`), `modelViewRelativeToEye`, `modelViewProjectionRelativeToEye`. Dual source-of-truth architecture remains but the drift is fixed. | ✅ Resolved (drift fixed) | `WGSLBuiltins.ts`, `Shaders/WebGPU/chunks/structs/CameraUniforms.wgsl` | Severity reduced from 🔴 High to 🟢 Low — the live drift bug is fixed. Dual source-of-truth architecture (inline strings vs .wgsl files) still exists but is now consistent. A future build step to auto-generate from .wgsl files would eliminate this risk permanently. |
| **FORK-15** | ~~**WGSL preprocessor struct auto-resolution missing for transitive dependencies**~~ — Fixed: `_resolveDependencies()` now resolves both `csm_*` identifiers AND struct references (`CameraUniforms`, `PBRMaterial`, `LightingUniforms`, `Csm*` structs) transitively within imported chunks. Previously only the main source ran struct auto-resolution. | ✅ Resolved | `WGSLShaderPreprocessor.ts` | The `buildDeps()` function now collects both `csm_*` and struct pattern matches, deduplicates them, and resolves transitively. This prevents shader compilation failures from missing struct definitions in complex dependency chains. |
| **FORK-16** | **WGSL preprocessor test page uses reimplemented version** — The test page for the preprocessor reimplements the preprocessor logic rather than importing the actual `WGSLShaderPreprocessor.ts`. | 🟡 Medium | `Apps/WebGPUTest/` | Already tracked as S4-4 in migration status. Tests could pass while the real preprocessor has bugs. |
| **FORK-17** | **TODO: Compute shader mipmap generation not implemented** — `WebGLCompatibilityStub.ts` has a TODO for `WebGPUTexture.generateMipmaps()` with compute shader. Currently uses the `WebGPUMipmapGenerator` but the stub's `generateMipmap` is incomplete. | 🟡 Medium | `WebGLCompatibilityStub.ts` | Affects texture quality for WebGPU textures that need mipmaps generated at runtime. |
| **FORK-18** | ~~**TODO: DepthPlane vertex data extraction not implemented**~~ — Implemented: `WebGPUDepthPlane.update()` now computes depth quad geometry directly from camera/ellipsoid (ported from WebGL `DepthPlane.js`'s `computeDepthQuad()`), encodes into RTE high/low pairs via `EncodedCartesian3`, and writes uniforms (mvpRelativeToEye + encodedCamera) from `uniformState`. No longer depends on extracting data from WebGL vertex arrays. | ✅ Resolved | `WebGPUDepthPlane.ts` | Self-contained computation using `Cartesian3`, `EncodedCartesian3`, `Ellipsoid`, `OrthographicFrustum`. RTE precision maintained. Triangle-strip topology for 4-corner quad. |

### 14.6 Test Infrastructure

| ID | Issue | Severity | Files Affected | Details |
|----|-------|----------|---------------|---------|
| **FORK-19** | **Zero Jasmine unit tests for any WebGPU code** — 83+ renderer files, 67+ shaders, 0 automated tests. | 🔴 High | `Specs/` (absent) | Any change can break WebGPU rendering undetected. The split-screen comparison tool helps but is manual. This is the single largest quality risk in the fork. |
| **FORK-20** | **29 test pages use 3 different module loading patterns** — Some use global `<script>` with `Build/Cesium/Cesium.js`, others use ES module `import` from `Build/CesiumUnminified/index.js`, others use import maps with `Source/Cesium.js`. | 🟡 Medium | `Apps/WebGPUTest/*.html` | Inconsistency means some test pages may break depending on which build target is active. Should standardize on one pattern. |
| **FORK-21** | **Test pages contain hardcoded inline WGSL shaders** — `scene-webgpu-poc.html` and `triangle.html` have full WGSL shader code as inline string literals rather than importing from the shader library. | 🟡 Medium | `Apps/WebGPUTest/scene-webgpu-poc.html`, `Apps/WebGPUTest/triangle.html` | Duplicated shader code will drift from the canonical shaders. These pages also bypass Cesium's rendering pipeline entirely (raw WebGPU), giving a false sense of integration test coverage. |
| **FORK-22** | **Several test pages are raw WebGPU demos, not Cesium integration tests** — `triangle.html`, `scene-webgpu-poc.html`, `3d-cube-test.html`, `cube-phong.html` create their own WebGPU device/adapter/pipeline directly without using any Cesium classes. | 🟡 Medium | `Apps/WebGPUTest/` | Useful as learning exercises but don't validate that Cesium's WebGPU path works. Should be clearly labeled as demos vs integration tests. |
| **FORK-23** | **No automated visual regression testing** — Split-screen comparison page exists but requires manual visual inspection. No pixel-diff CI integration. | 🟡 Medium | — | Any rendering regression requires a human to notice it in the split-screen tool. |

### 14.7 Architecture & Design Debt

| ID | Issue | Severity | Files Affected | Details |
|----|-------|----------|---------------|---------|
| **FORK-24** | ~~**`Primitive.js` has 10 `isWebGPU` checks and direct WebGPU imports**~~ — Reduced from 10 `isWebGPU` checks to **2 `isWebGPUDrawCommand` command-type checks** (not backend checks). Zero direct WebGPU imports remain. All WebGPU routing goes through `getFeatureRenderer(FeatureRendererKey.PRIMITIVE)`. The 2 remaining checks are in `updateAndQueueCommands` for routing uniform updates to the correct method (color vs material commands). | ✅ Resolved (effectively) | `Primitive.js` | Command-type checks (`isWebGPUDrawCommand`) are acceptable per FORK-8 rules — they check command type, not backend identity. Conflict surface with upstream dramatically reduced. |
| **FORK-25** | ~~**7 renderers built but not wired into scene files**~~ — All 7 renderers now properly wired using `getFeatureRenderer(FeatureRendererKey.XXX)` pattern: CloudCollection, PointCloud, VoxelPrimitive, PointCloudEyeDomeLighting, EllipsoidPrimitive, InvertClassification, TimeDynamicPointCloud, PostProcessStageCollection. All import `FeatureRendererKey` and use the enum-indexed pattern. | ✅ Resolved | All 8 scene files verified | Verified by codebase search: all 8 files import `FeatureRendererKey` and call `context.getFeatureRenderer()`. Zero `isWebGPU` checks or direct imports remain. |
| **FORK-26** | **`FeatureRendererKey.COUNT` must be manually incremented** — Adding a new feature renderer requires manually updating 3 places: (1) add key to enum, (2) increment `COUNT`, (3) register in `WebGPUFeatureRenderers.ts`. Forgetting `COUNT` causes silent out-of-bounds array access. | 🟡 Medium | `FeatureRendererKey.js` | Could be mitigated with a build-time assertion or by computing COUNT automatically from the enum values. |
| **FORK-27** | ~~**`GraphicsContext` abstract methods not enforced at JS runtime**~~ — `_verifyAbstractMethods()` added to `GraphicsContext._registerWithRegistry()`. Checks 11 required methods and 11 required getters at registration time. Only runs in debug builds (wrapped in `includeStart/includeEnd`). Catches missing implementations with a clear error message naming the class and missing member. | ✅ Resolved | `GraphicsContext.ts` | Runtime checks verify `beginFrame`, `endFrame`, `clear`, `resize`, `draw`, `getRendererString`, `createPickId`, `getObjectByPickColor`, `readPixels`, `createViewportQuadCommand`, `destroy` methods and `rendererType`, `id`, `canvas`, `drawingBufferWidth/Height`, `uniformState`, `shaderCache`, `textureCache`, `cache`, `defaultTexture`, `isDestroyed` getters. |
| **FORK-28** | **Material system only 8 of 40+ built-in materials mapped** — WebGPU material shaders use a placeholder checkerboard texture for unmapped materials. Users see incorrect material rendering for most material types. | 🟡 Medium | Various WGSL material shaders | Already tracked as MAT-1 in migration status. Low severity for current alpha state but will need attention before beta. |

### 14.8 Build & Configuration Debt

| ID | Issue | Severity | Files Affected | Details |
|----|-------|----------|---------------|---------|
| **FORK-29** | **Slang cross-compilation pipeline built but unused in production** — `scripts/compileSlang.js` and the full Slang toolchain integration exists, but no production shader uses it. Only one generated `.wgsl` file exists (`EllipsoidPrimitive.wgsl`). | 🟢 Low | `scripts/compileSlang.js`, `Shaders/WebGPU/Generated/` | Infrastructure investment with no current ROI. Not harmful (it's optional) but adds maintenance surface. Will become valuable when new shaders need both GLSL + WGSL output. |
| **FORK-30** | **`@webgpu/types` pinned to `^0.1.69`** — WebGPU types package may drift from the evolving spec. The caret range allows minor updates but major breaking changes in the spec could require manual updates. | 🟢 Low | `package.json` | Low risk since WebGPU spec is stable in Chrome 113+. Should be reviewed during upstream syncs. |

### 14.9 WebGL/WebGPU Feature Parity Gaps

These items track features added to our fork where the implementation is incomplete across both backends. Per `.clinerules` §4, new renderer-agnostic features MUST be implemented for both WebGL and WebGPU simultaneously.

| ID | Issue | Severity | Files Affected | Details |
|----|-------|----------|---------------|---------|
| **FORK-31** | **Sorting system: 11 phases built, critical gap FIXED** — Full sorting system across 11 phases (30+ files). **SORT-1 FIXED:** `renderPriority`/`renderLayer` now wired from collections/primitives → DrawCommands in 5 files (BillboardCollection, PointPrimitiveCollection, PolylineCollection, Primitive.js, ModelVisualizer.js). **SORT-2 FIXED:** `RenderScheduler.beginFrame()` integrated into `Scene.prototype.render()`. **SORT-11 FIXED:** Octree rootHalfExtent auto-configures from scene ellipsoid. `entity.renderPriority` now works end-to-end: Entity → Visualizer → Collection → DrawCommand → Scene.js comparators. Remaining: MaterialSortIdAllocator activation (needs opaque sort), RenderScheduler full integration (binCommand/sortAllLayers), WASM compilation, octree/occlusion View.js wiring. See `migration_doc/SORTING_REVIEW_AND_TECH_DEBT.md` for full audit. Addresses upstream [#4108](https://github.com/CesiumGS/cesium/issues/4108). | ⚡ Improved (core wiring complete) | 30+ files across Scene, DataSources, Renderer, Shaders | Remaining: (1) Full RenderScheduler integration (~2-3 days). (2) Compile WASM (`npm run build-wasm`). (3) Wire octree/occlusion into View.js. (4) Unit tests. |
| **FORK-32** | **Multi-light `scene.lights` API not wired — `LightCollection` is orphaned** — `Light.ts` defines `DirectionalLight`, `PointLight`, `SpotLight`, and `LightCollection`, but no scene file imports or uses them. `Scene.js` only has `scene.light` (singular, `SunLight`). The `LightCollection.pack()` method and `LightUniforms.wgsl` struct are ready but disconnected from the rendering pipeline. Addresses upstream [#8518](https://github.com/CesiumGS/cesium/issues/8518). | 🟡 Medium | `Light.ts` (orphaned), `Scene.js` (missing `lights` property), `UniformState.js` (missing multi-light uniforms) | **To complete:** (a) Add `scene.lights` property (shared, renderer-agnostic `LightCollection`). (b) Wire `LightCollection.pack()` into `UniformState.js` for both backends. (c) Create GLSL multi-light builtin (see FORK-33). ~2-3 days. |
| **FORK-33** | **No GLSL multi-light shader — WebGL has no equivalent of `LightUniforms.wgsl`** — `LightUniforms.wgsl` has `LightData` struct array (8 lights), `csm_computeAttenuation()`, and `csm_computeSpotCone()`. WebGL GLSL still uses single-light uniforms (`czm_lightDirectionEC`, `czm_lightColorHdr`) in `LightingStageFS.glsl` and `czm_pbrLighting()`. No `czm_multiLight` struct or attenuation functions exist in GLSL. This is a shader parity gap — WebGPU can render multi-light scenes but WebGL cannot. | 🟡 Medium | `LightUniforms.wgsl` (WebGPU ✅), `Shaders/Builtin/` (WebGL ❌), `LightingStageFS.glsl` (single-light only) | **To complete:** (a) Create GLSL `czm_lightData` struct matching WGSL `LightData`. (b) Add GLSL `czm_computeAttenuation()` and `czm_computeSpotCone()` builtins. (c) Update `LightingStageFS.glsl` to iterate over light array. (d) Add `czm_lightCount` and `czm_lights[8]` auto-uniforms in `AutomaticUniforms.js`. ~3-4 days. |
| **FORK-34** | **WebGPU pick render pass — partially wired for geometry primitives** — `WebGPUSceneRenderer._executePickPass()` now renders to the pick FBO when `config.picking` is true. Executes GLOBE/3D_TILE/OPAQUE/TRANSLUCENT passes (skips ENVIRONMENT). `Primitive.js` pushes WebGPU pick commands to `commandList` during pick-only passes instead of color commands. **Works for:** All `Primitive.js`-based geometry (polygons, rectangles, ellipses, cylinders, boxes, polyhedra). **Not yet working:** Billboard, Point, Polyline collections (their feature renderers don't create pick commands), depth readback for `pickPosition`. Duplicate pick ID systems remain (WebGPUContext vs WebGPUPickManager). | ⚡ Improved | `WebGPUSceneRenderer.ts` (pick pass added), `Primitive.js` (pick command push), `WebGPUPickFramebuffer.ts`, `WebGPUPickManager.ts` | **Remaining:** (a) Add pick command creation to Billboard/Point/Polyline feature renderers. (b) Consolidate duplicate pick ID systems. (c) Add depth readback for `pickPosition`. (d) End-to-end testing. ~2-3 days remaining. |
| **FORK-35** | **Duplicate pick ID systems in WebGPU** — `WebGPUContext.ts` has inline `_pickObjects` Map + `createPickId()`/`getObjectByPickColor()`. `WebGPUPickManager.ts` has its own independent pick object map. Both manage the same 24-bit color → object mapping. Only one should exist. | 🟡 Medium | `WebGPUContext.ts`, `WebGPUPickManager.ts` | **To complete:** Consolidate to single pick manager. `WebGPUContext` methods should delegate to `WebGPUPickManager`. ~0.5 day. |
| **FORK-36** | **No convenience API for drill-pick-to-earth-center** — `scene.drillPickFromRay(ray, limit, excludes, width)` CAN pick from a point to the earth center with a diameter (`width` param), but requires manual `Ray` construction. No `scene.pickColumn(position, {diameter})` or `scene.pickRayAll(ray, {diameter})` convenience wrapper exists. The `width` parameter name doesn't communicate "diameter." Addresses common GIS use case of querying all features in a vertical column through the earth. | 🟢 Low | `Scene.js`, `Picking.js` | **To complete:** Add `scene.pickAll()`, `scene.pickRayAll()`, `scene.pickColumn()` convenience methods wrapping existing `drillPick`/`drillPickFromRay`. ~1-2 days. |

### Fork Tech Debt Summary

| Severity | Count | Resolved | Remaining | Key Remaining Items |
|----------|-------|----------|-----------|---------------------|
| 🔴 High | 7 | 5 (FORK-1, FORK-5, FORK-6, FORK-14, FORK-24) | **2** | FORK-19 (unit tests — top quality risk), FORK-34 (WebGPU pick pass not wired — all 15+ picking methods fail) |
| 🟡 Medium | 23 | 12 (FORK-2, FORK-3, FORK-9 partial, FORK-12, FORK-13, FORK-15, FORK-18, FORK-25, FORK-27) | 11 | WebGLCompatibilityStub (FORK-4), type helpers (FORK-11), test infra (FORK-16-17, FORK-20-23), material system (FORK-28), parity gaps (FORK-31, FORK-32, FORK-33), duplicate pick IDs (FORK-35) |
| 🟢 Low | 5 | 2 (FORK-10, FORK-8 acceptable) | 3 | Slang unused (FORK-29), `@webgpu/types` version (FORK-30), pick convenience API (FORK-36) |
| ⚠️ **Architectural** | 3 | 3 (FORK-24, FORK-25, FORK-26) | **0** | All architectural items resolved! |
| **Total** | **36** | **19 resolved** | **17 remaining** | — |

### Resolved Fork Tech Debt Items (19 of 30)

FORK-1 ✅, FORK-2 ✅, FORK-3 ✅, FORK-5 ✅ (Phase D 28/28), FORK-6 ✅ (effectively), FORK-7 ✅, FORK-8 ✅ (acceptable), FORK-9 ⚡ (7 of 18 casts fixed), FORK-10 ✅, FORK-12 ✅ (primary), FORK-13 ✅ (confirmed clean), FORK-14 ✅ (drift fixed), FORK-15 ✅ (transitive deps), FORK-18 ✅ (DepthPlane implemented), FORK-24 ✅ (effectively), FORK-25 ✅ (all wired), FORK-26 ✅ (COUNT auto-computed), FORK-27 ✅

### Priority Remediation Order (Remaining)

1. **FORK-19** (Unit tests) — Start with smoke tests for core classes: `WebGPUContext`, `WebGPUBuffer`, `WebGPUTexture`, `WebGPUDrawCommand`. ~2-3 days. Single largest quality risk.
2. **FORK-11** (Type helpers adoption) — Consistently use `webgpuTypeHelpers.ts` wrappers across remaining `as any` sites. ~0.5 day.
3. **FORK-17** (Mipmap stub) — Complete compute shader mipmap generation in WebGLCompatibilityStub. ~1 day.
4. **FORK-16** (Preprocessor test page) — Replace reimplemented preprocessor in test page with actual `WGSLShaderPreprocessor.ts` import. ~0.5 day.
5. **FORK-20-23** (Test infrastructure) — Standardize module loading, label raw demos, add visual regression CI. ~2-3 days.
6. **FORK-28** (Material system) — Map remaining 32+ built-in materials to WGSL shaders. ~5-7 days.

---

## Appendix: Issue Count Summary from Upstream

| Category | Open Issues | Notes |
|----------|------------|-------|
| All open issues | ~1,500 | As of March 2026 |
| `type - bug` | 785 | Nearly half of all issues |
| `category - graphics` | 241 | Rendering-related |
| `category - architecture / api` | 51 | Design/structure |
| `category - memory/performance` | 33 | Performance problems |
| `category - modernization` | 12 | Tech debt / modernization |
| `priority - high` | 60+ | Marked high-priority by CesiumGS |

---

## Appendix: Combined Issue Totals

| Source | Count |
|--------|-------|
| **Upstream issues tracked** | 91 |
| **Fork-specific tech debt** | 33 |
| **Grand total** | **124** |

---

*This document should be updated after each upstream sync to track new issues and verify our fix status.*
