# ES6+ / ES2022 Modernization Backlog

**Last Updated:** March 29, 2026 (TerrainFillMesh.js ES6 class conversion (1100 lines, 3 class methods, 1 static method `updateFillTiles`). WebGPU-aware: `updateFillTiles` BFS checks both `vertexArray` and `mesh`, `visitRenderedTiles` likewise, `createFillMesh` skips WebGL VA when `context.isWebGPU`. Previous: QuadtreePrimitive.js, QuadtreeTile.js, PickDepth.js, ImageryLayer.js, Material.js conversions)
**Purpose:** Comprehensive audit of all JavaScript files needing ES6/ES2022 modernization across the CesiumJS codebase.  
**Scope:** `packages/engine/Source/` (canonical) and `packages/widgets/Source/`  
**Excludes:** TypeScript files (`.ts` — already ES2022+), ThirdParty files (generated/vendor code), WGSL shader strings in JS files

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Pattern Definitions](#pattern-definitions)
3. [Priority Legend](#priority-legend)
4. [Renderer Directory](#1-renderer--29-files)
5. [Scene Directory](#2-scene--213-files)
6. [Core Directory](#3-core--83-files)
7. [DataSources Directory](#4-datasources--85-files)
8. [Widgets Directory](#5-widgets--22-files)
9. [Pre-ES2022 Patterns (Cross-Cutting)](#6-pre-es2022-patterns-cross-cutting)
10. [Completed Modernizations](#completed-modernizations)
11. [Modernization Rules](#modernization-rules)

---

## Executive Summary

| Directory | Files Needing Class Conversion | Files with `Object.defineProperties` | Est. Total Effort |
|-----------|-------------------------------|--------------------------------------|-------------------|
| **Renderer** | 29 (of ~44 JS) | 22 | 30-50 hrs |
| **Scene** | 213 (of ~300 JS) | 160+ | 200-350 hrs |
| **Core** | 83 (of ~200 JS) | 82 | 80-130 hrs |
| **DataSources** | 85 (of ~90 JS) | 75+ | 80-120 hrs |
| **Widgets** | 22 (of ~30 JS) | 20+ | 20-30 hrs |
| **Total** | **~432 files** | **~360 files** | **~410-680 hrs** |

### Pre-ES6 Patterns Found (Must Fix)

| Pattern | Files Affected | Severity |
|---------|---------------|----------|
| Constructor functions (not ES6 `class`) | ~432 | 🔴 High |
| `Object.defineProperties()` for getters/setters | ~360 | 🔴 High |
| `.prototype.method = function()` | ~400 | 🔴 High |
| `var` declarations | ~2 first-party (ThirdParty excluded) | 🟢 Low |

### Pre-ES2022 Patterns Found (Should Fix When Convenient)

| Pattern | Files Affected | Severity |
|---------|---------------|----------|
| `.indexOf()` instead of `.includes()` | ~60 | 🟡 Medium |
| `typeof x !== "undefined"` instead of optional chaining | ~40 | 🟡 Medium |
| `.hasOwnProperty()` instead of `Object.hasOwn()` | ~25 | 🟢 Low |
| `arguments` object instead of rest params | ~10 | 🟡 Medium |
| `.apply(this, arguments)` instead of spread | ~8 | 🟡 Medium |
| `.call(this, ...)` patterns | ~38 | 🟢 Low |
| `Foo.CONSTANT = ...` after class (not `static` field) | ~200+ | 🟢 Low |

---

## Pattern Definitions

### Pre-ES6 (Must Fix)

| ID | Pattern | Replacement | Example |
|----|---------|-------------|---------|
| **P1** | `function Foo() {}` constructor | `class Foo {}` | Upstream [#8359](https://github.com/CesiumGS/cesium/issues/8359) |
| **P2** | `Foo.prototype.bar = function()` | `bar() {}` in class body | Method definitions |
| **P3** | `Object.defineProperties(Foo.prototype, { get x() })` | `get x() {}` in class body | Property getters/setters |
| **P4** | `var x = ...` | `const x = ...` or `let x = ...` | Block-scoped declarations |
| **P5** | `"string " + variable` | `` `string ${variable}` `` | Template literals |
| **P6** | `arguments` object | `...args` rest parameters | Rest/spread |
| **P7** | `fn.apply(this, arguments)` | `fn(...args)` or `fn.call(this, ...args)` | Spread syntax |

### Pre-ES2022 (Should Fix When Convenient)

| ID | Pattern | Replacement | Example |
|----|---------|-------------|---------|
| **E1** | `.indexOf(x) !== -1` | `.includes(x)` | Array/string search |
| **E2** | `typeof x !== "undefined"` | `x?.prop` or `x ?? default` | Optional chaining/nullish coalescing |
| **E3** | `.hasOwnProperty(key)` | `Object.hasOwn(obj, key)` | Own property check |
| **E4** | `Foo.CONSTANT = Object.freeze(...)` after class | `static CONSTANT = Object.freeze(...)` in class | Static class fields |
| **E5** | `.indexOf(x) >= 0` / `< 0` | `.includes(x)` / `!.includes(x)` | Inclusive search |
| **E6** | `arr[arr.length - 1]` | `arr.at(-1)` | Last element access |

---

## Priority Legend

| Priority | Meaning | Action |
|----------|---------|--------|
| 🔴 High | Blocks WebGPU work or is frequently modified by our fork | Modernize when next touched |
| 🟡 Medium | Would benefit from modernization, touched occasionally | Modernize if making >10 lines of changes |
| 🟢 Low | Rarely touched, modernization is nice-to-have | Add to backlog, modernize opportunistically |
| ⚠️ Caution | Performance-critical math class — benchmark before/after | Special handling required |

---

## 1. Renderer — 29 files

**Already converted:** `Context.js` (ES6 class + extends GraphicsContext), `PickId.js` (ES6 class)  
**All WebGPU `.ts` files are already ES2022+** — only `.js` files listed here.

### 🔴 High Priority (Blocks WebGPU / Frequently Modified)

| File | Patterns | Effort | Blocks WebGPU? | Notes |
|------|----------|--------|----------------|-------|
| ~~`Renderer/DrawCommand.js`~~ | ~~P1, P2, P3~~ | ~~2-3 hrs~~ | ~~Yes~~ | ✅ Completed March 2026 |
| ~~`Renderer/ShaderProgram.js`~~ | ~~P1, P2, P3~~ | ~~2-3 hrs~~ | ~~Yes~~ | ✅ Completed March 2026 |
| ~~`Renderer/ShaderSource.js`~~ | ~~P1, P2, P3~~ | ~~2-3 hrs~~ | ~~Yes~~ | ✅ Completed March 2026. Also: `.hasOwnProperty`→`Object.hasOwn` (E3), `.indexOf`→`.includes` (E1) |
| ~~`Renderer/ShaderCache.js`~~ | ~~P1, P2, P3~~ | ~~1-2 hrs~~ | ~~Yes~~ | ✅ Completed March 2026. Also: `.hasOwnProperty`→`Object.hasOwn` (E3) |
| ~~`Renderer/Buffer.js`~~ | ~~P1, P2, P3~~ | ~~1-2 hrs~~ | ~~Yes~~ | ✅ Completed March 2026. Instance-level `Object.defineProperties` in `createIndexBuffer` preserved (deliberate per-instance augmentation). |
| ~~`Renderer/Texture.js`~~ | ~~P1, P2, P3~~ | ~~2-3 hrs~~ | ~~Yes~~ | ✅ Completed March 2026. 11 getters + 1 setter, 2 static methods, file-scoped helpers preserved. |
| ~~`Renderer/ClearCommand.js`~~ | ~~P1, P2, P3~~ | ~~1 hr~~ | ~~Yes~~ | ✅ Completed March 2026 |
| ~~`Renderer/ComputeCommand.js`~~ | ~~P1, P2, P3~~ | ~~1 hr~~ | ~~Yes~~ | ✅ Completed March 2026 |
| ~~`Renderer/PassState.js`~~ | ~~P1, P2, P3~~ | ~~1 hr~~ | ~~Yes~~ | ✅ Completed March 2026 |
| ~~`Renderer/RenderState.js`~~ | ~~P1, P2, P3~~ | ~~2-3 hrs~~ | ~~Yes~~ | ✅ Completed March 2026 |
| ~~`Renderer/Framebuffer.js`~~ | ~~P1, P2, P3~~ | ~~1-2 hrs~~ | ~~Yes~~ | ✅ Completed March 2026. 8 getters including computed `hasDepthAttachment`. |
| ~~`Renderer/FramebufferManager.js`~~ | ~~P1, P2, P3~~ | ~~1-2 hrs~~ | ~~Yes~~ | ✅ Completed March 2026. 3 getters, 18 methods. |

### 🟡 Medium Priority

| File | Patterns | Effort | Notes |
|------|----------|--------|-------|
| ~~`Renderer/ComputeEngine.js`~~ | ~~P1, P2, P3~~ | ~~1 hr~~ | ✅ Completed March 2026. 3 methods. |
| ~~`Renderer/CubeMap.js`~~ | ~~P1, P2, P3~~ | ~~1-2 hrs~~ | ✅ Completed March 2026. 15 getters + 1 setter, 5 class methods, 4 static methods, file-scoped helpers preserved. |
| ~~`Renderer/CubeMapFace.js`~~ | ~~P1, P2, P3~~ | ~~1 hr~~ | ✅ Completed March 2026. 3 getters, 3 class methods. |
| ~~`Renderer/MultisampleFramebuffer.js`~~ | ~~P1, P2, P3~~ | ~~1 hr~~ | ✅ Completed March 2026. 4 class methods. |
| ~~`Renderer/Renderbuffer.js`~~ | ~~P1, P2, P3~~ | ~~1 hr~~ | ✅ Completed March 2026. 3 getters, 3 class methods. |
| ~~`Renderer/Sampler.js`~~ | ~~P1, P2, P3~~ | ~~0.5 hr~~ | ✅ Completed March 2026. 6 getters, static equals + NEAREST. |
| ~~`Renderer/ShaderBuilder.js`~~ | ~~P1, P2, P3~~ | ~~1-2 hrs~~ | ✅ Completed March 2026. 1 getter, 12 class methods, 3 file-scoped helpers. |
| ~~`Renderer/ShaderFunction.js`~~ | ~~P1, P2, P3~~ | ~~0.5 hr~~ | ✅ Completed March 2026. 2 class methods. |
| ~~`Renderer/ShaderStruct.js`~~ | ~~P1, P2, P3~~ | ~~0.5 hr~~ | ✅ Completed March 2026. 2 class methods. |
| ~~`Renderer/SharedContext.js`~~ | ~~P1, P2, P3~~ | ~~1 hr~~ | ✅ Completed March 2026. 3 class methods, no getters. |
| ~~`Renderer/Texture3D.js`~~ | ~~P1, P2, P3~~ | ~~1-2 hrs~~ | ✅ Completed March 2026. 12 getters + 1 setter, 4 class methods, 1 static method, file-scoped helpers preserved. |
| ~~`Renderer/TextureCache.js`~~ | ~~P1, P2, P3~~ | ~~1 hr~~ | ✅ Completed March 2026. 1 getter, 5 class methods, `.hasOwnProperty`→`Object.hasOwn` (E3×2). |
| ~~`Renderer/UniformState.js`~~ | ~~P1, P2, P3~~ | ~~3-4 hrs~~ | ✅ Completed March 2026. ES6 class + decomposition into 2 files: `UniformState.js` (~870 lines), `UniformStateComputations.js` (~480 lines). ~60 class getters, 2 class setters (`viewport`, `model`), 4 class methods (`updateCamera`, `updateFrustum`, `updatePass`, `update`). |
| ~~`Renderer/VertexArray.js`~~ | ~~P1, P2, P3~~ | ~~1-2 hrs~~ | ✅ Completed March 2026. 3 getters, 5 class methods, 1 static method, `.hasOwnProperty`→`Object.hasOwn` (E3×3), string concat→template literal (E5). |
| ~~`Renderer/VertexArrayFacade.js`~~ | ~~P1, P2, P3~~ | ~~1-2 hrs~~ | ✅ Completed March 2026. 6 class methods, 6 static methods, `.hasOwnProperty`→`Object.hasOwn` (E3). |
| ~~`Renderer/TextureAtlas.js`~~ | ~~P1, P2, P3~~ | ~~1 hr~~ | ✅ Completed March 2026. 8 getters, 13 class methods, file-scoped helper `AddImageRequest` preserved. |

### 🟢 Low Priority

| File | Patterns | Effort | Notes |
|------|----------|--------|-------|
| `Renderer/AutomaticUniforms.js` | P1 (AutomaticUniform constructor) | 2-3 hrs | Large, complex, low change frequency |

---

## 2. Scene — 213 files

The Scene directory has the most files needing modernization and is the most actively modified by our WebGPU work.

### 🔴 High Priority (Modified by WebGPU Fork)

| File | Patterns | Effort | Blocks WebGPU? | Notes |
|------|----------|--------|----------------|-------|
| ~~`Scene/Scene.js`~~ | ~~P1, P2, P3~~ | ~~4-6 hrs~~ | ~~Yes~~ | ✅ Completed March 2026. ES6 class + SORT-3 integration. ~4,900 lines. See `SCENE_DECOMPOSITION_PLAN.md` for further decomposition into 8 focused modules. |
| ~~`Scene/Primitive.js`~~ | ~~P1, P2, P3~~ | ~~3-4 hrs~~ | ~~Yes~~ | ✅ Completed March 2026. ES6 class + decomposition into 4 files: `Primitive.js` (~770 lines), `PrimitiveShaderHelpers.js` (~340 lines), `PrimitiveCommandHelpers.js` (~340 lines), `PrimitiveGeometryHelpers.js` (~600 lines). 8 class getters, 4 class methods, 7 static method aliases for backward compat. `.hasOwnProperty`→`Object.hasOwn` (E3×4). |
| ~~`Scene/BillboardCollection.js`~~ | ~~P1, P2, P3~~ | ~~3-4 hrs~~ | ~~Yes~~ | ✅ Completed March 2026. 8 class getters/setters, 10 class methods. ~1,330 lines. |
| ~~`Scene/PointPrimitiveCollection.js`~~ | ~~P1, P2, P3~~ | ~~2-3 hrs~~ | ~~Yes~~ | ✅ Completed March 2026. 1 class getter, 9 class methods. ~724 lines. |
| ~~`Scene/PolylineCollection.js`~~ | ~~P1, P2, P3~~ | ~~2-3 hrs~~ | ~~Yes~~ | ✅ Completed March 2026. 1 class getter, 10 class methods, `.hasOwnProperty`→`Object.hasOwn` (E3×2). ~1,297 lines. |
| ~~`Scene/Billboard.js`~~ | ~~P1, P2, P3~~ | ~~2-3 hrs~~ | ~~Yes~~ | ✅ Completed March 2026. 31 class getters/setters, 13 class methods, 4 static methods, file-scoped helpers preserved. ~1,031 lines. |
| ~~`Scene/PointPrimitive.js`~~ | ~~P1, P2, P3~~ | ~~1-2 hrs~~ | ~~Yes~~ | ✅ Completed March 2026. 14 class getters/setters, 6 class methods, 3 static methods, file-scoped helpers preserved. ~557 lines. |
| ~~`Scene/SkyAtmosphere.js`~~ | ~~P1, P2, P3~~ | ~~1-2 hrs~~ | ~~Yes~~ | ✅ Completed March 2026 |
| ~~`Scene/Sun.js`~~ | ~~P1, P2, P3~~ | ~~1-2 hrs~~ | ~~Yes~~ | ✅ Completed March 2026 |
| ~~`Scene/Moon.js`~~ | ~~P1, P2, P3~~ | ~~1-2 hrs~~ | ~~Yes~~ | ✅ Completed March 2026 |
| ~~`Scene/SkyBox.js`~~ | ~~P1, P2, P3~~ | ~~1-2 hrs~~ | ~~Yes~~ | ✅ Completed March 2026 |
| ~~`Scene/CubeMapPanorama.js`~~ | ~~P1, P2, P3~~ | ~~1-2 hrs~~ | ~~Yes~~ | ✅ Completed March 2026 |
| ~~`Scene/ShadowMap.js`~~ | ~~P1, P2, P3~~ | ~~2-3 hrs~~ | ~~Yes~~ | ✅ Completed March 2026. ES6 class + decomposition into 2 files: `ShadowMap.js` (~934 lines), `ShadowMapComputations.js` (~977 lines). Inner `ShadowMapCamera` and `ShadowPass` also converted to ES6 class. 9 class getters/setters, 5 class methods, 2 `static` methods. Inline GLSL debug shaders converted to template literals (P5). |
| ~~`Scene/GlobeSurfaceTileProvider.js`~~ | ~~P1, P2, P3~~ | ~~3-4 hrs~~ | ~~Yes~~ | ✅ Completed March 2026. ES6 class + decomposition into 2 files: `GlobeSurfaceTileProvider.js` (~1,154 lines, ES6 class + QuadtreeTileProvider interface methods + layer handlers), `GlobeSurfaceTileProviderRendering.js` (~1,724 lines, draw commands, uniform maps, wireframe, debug viz, bounding region, WebGPU path). 9 class getters/setters, 17 class methods, 4 layer event handlers. |
| ~~`Scene/Globe.js`~~ | ~~P1, P2, P3~~ | ~~2-3 hrs~~ | ~~Yes~~ | ✅ Completed March 2026. 20 class getters/setters, 9 class methods. ~730 lines. |
| ~~`Scene/GlobeSurfaceTile.js`~~ | ~~P1, P2, P3~~ | ~~2-3 hrs~~ | ~~Yes~~ | ✅ Completed March 2026. 2 class getters, 12 class methods, 4 `static` methods. `.hasOwnProperty`→`Object.hasOwn` (E3). ~620 lines. |
| ~~`Scene/GroundPrimitive.js`~~ | ~~P1, P2, P3~~ | ~~2-3 hrs~~ | ~~Yes~~ | ✅ Completed March 2026. 7 class getters, 5 class methods, 4 `static` methods, `.hasOwnProperty`→`Object.hasOwn` (E3). ~920 lines. |
| ~~`Scene/InvertClassification.js`~~ | ~~P1, P2, P3~~ | ~~1-2 hrs~~ | ~~Yes~~ | ✅ Completed March 2026 |
| ~~`Scene/CloudCollection.js`~~ | ~~P1, P2, P3~~ | ~~2-3 hrs~~ | ~~Yes~~ | ✅ Completed March 2026 |
| ~~`Scene/PointCloudEyeDomeLighting.js`~~ | ~~P1, P2, P3~~ | ~~1-2 hrs~~ | ~~Yes~~ | ✅ Completed March 2026 |
| ~~`Scene/VoxelPrimitive.js`~~ | ~~P1, P2, P3~~ | ~~2-3 hrs~~ | ~~Yes~~ | ✅ Completed March 2026. ES6 class + decomposition into 2 files: `VoxelPrimitive.js` (~630 lines), `VoxelPrimitiveHelpers.js` (~600 lines). 28 class getters/setters, 3 class methods. `.hasOwnProperty`→`Object.hasOwn` (E3×3). |
| ~~`Scene/TimeDynamicPointCloud.js`~~ | ~~P1, P2, P3~~ | ~~2-3 hrs~~ | ~~Yes~~ | ✅ Completed March 2026 |
| ~~`Scene/EllipsoidPrimitive.js`~~ | ~~P1, P2, P3~~ | ~~1-2 hrs~~ | ~~Yes~~ | ✅ Completed March 2026 |
| ~~`Scene/PostProcessStageCollection.js`~~ | ~~P1, P2, P3~~ | ~~2-3 hrs~~ | ~~Yes~~ | ✅ Completed March 2026. 10 class getters/setters, 13 class methods. Renamed file-scoped helpers to avoid shadowing class methods. ~740 lines. |

### 🟡 Medium Priority (Scene Infrastructure)

| File | Patterns | Effort | Notes |
|------|----------|--------|-------|
| ~~`Scene/Camera.js`~~ | ~~P1, P2, P3~~ | ~~4-6 hrs~~ | ✅ Completed March 2026. ES6 class + decomposition into 3 files. See completed table. |
| ~~`Scene/View.js`~~ | ~~P1, P2, P3~~ | ~~2-3 hrs~~ | ✅ Completed March 2026. 3 class getters/setters, 3 class methods. ~430 lines. |
| `Scene/FrameState.js` | P1, P2, P3 | 1-2 hrs | ✅ Already ES6 class (pure data container). |
| ~~`Scene/Appearance.js`~~ | ~~P1, P2, P3~~ | ~~1-2 hrs~~ | ✅ Completed March 2026 |
| ~~`Scene/Material.js`~~ | ~~P1, P2, P3~~ | ~~3-4 hrs~~ | ✅ Completed March 2026. ES6 class + decomposition. See completed table. |
| ~~`Scene/ImageryLayer.js`~~ | ~~P1, P2, P3~~ | ~~3-4 hrs~~ | ✅ Completed March 2026. ES6 class + decomposition. See completed table. |
| ~~`Scene/ImageryLayerCollection.js`~~ | ~~P1, P2, P3~~ | ~~2-3 hrs~~ | ✅ Completed March 2026 |
| ~~`Scene/Fog.js`~~ | ~~P1, P2, P3~~ | ~~1 hr~~ | ✅ Completed March 2026 |
| ~~`Scene/GlobeTranslucencyState.js`~~ | ~~P1, P2, P3~~ | ~~2-3 hrs~~ | ✅ Completed March 2026 |
| ~~`Scene/DepthPlane.js`~~ | ~~P1, P2, P3~~ | ~~1-2 hrs~~ | ✅ Completed March 2026 |
| ~~`Scene/ScreenSpaceCameraController.js`~~ | ~~P1, P2, P3~~ | ~~3-4 hrs~~ | ✅ Completed March 2026. ES6 class + decomposition into 3 files. See completed table. |
| ~~`Scene/Picking.js`~~ | ~~P1, P2, P3~~ | ~~2-3 hrs~~ | ✅ Completed March 2026. ES6 class + decomposition into 2 files: `Picking.js` (~824 lines), `PickingRayHelpers.js` (~551 lines). 20 class methods, `.hasOwnProperty`→`Object.hasOwn` (E3), `.indexOf`→`.includes` (E1). |
| `Scene/ParticleSystem.js` | P1, P2, P3 | 2-3 hrs | |
| `Scene/Particle.js` | P1, P2, P3 | 1 hr | |
| `Scene/ParticleEmitter.js` | P1, P2, P3 | 1 hr | |
| ~~`Scene/OrderedGroundPrimitiveCollection.js`~~ | ~~P1, P2, P3~~ | ~~1-2 hrs~~ | ✅ Completed March 2026 |
| ~~`Scene/PostProcessStage.js`~~ | ~~P1, P2, P3~~ | ~~2-3 hrs~~ | ✅ Completed March 2026 |
| ~~`Scene/PostProcessStageComposite.js`~~ | ~~P1, P2, P3~~ | ~~1-2 hrs~~ | ✅ Completed March 2026 |
| `Scene/PostProcessStageLibrary.js` | P1, P2, P3 | 2-3 hrs | |

### 🟡 Medium Priority (3D Tiles — 30+ files)

| File | Patterns | Effort | Notes |
|------|----------|--------|-------|
| `Scene/Cesium3DTileset.js` | P1, P2, P3 | 4-6 hrs | Core tileset, very large |
| `Scene/Cesium3DTile.js` | P1, P2, P3 | 3-4 hrs | Tile class |
| `Scene/Cesium3DTileBatchTable.js` | P1, P2, P3 | 2-3 hrs | |
| `Scene/Cesium3DTileContent.js` | P1, P2, P3 | 1-2 hrs | |
| `Scene/Cesium3DContentGroup.js` | P1, P2, P3 | 1-2 hrs | |
| `Scene/Cesium3DTilesetTraversal.js` | P1, P2, P3 | 2-3 hrs | |
| `Scene/Cesium3DTilesetStatistics.js` | P1, P2, P3 | 1-2 hrs | |
| `Scene/Cesium3DTilesetVisualizer.js` | P1, P2, P3 | 1-2 hrs | |
| `Scene/Cesium3DTileFeature.js` | P1, P2, P3 | 1-2 hrs | |
| `Scene/Cesium3DTilePointFeature.js` | P1, P2, P3 | 1-2 hrs | |
| `Scene/Cesium3DTileStyle.js` | P1, P2, P3 | 2-3 hrs | |
| `Scene/Cesium3DTileStyleEngine.js` | P1, P2, P3 | 1-2 hrs | |
| `Scene/BatchTable.js` | P1, P2, P3 | 1-2 hrs | |
| `Scene/BatchTableHierarchy.js` | P1, P2, P3 | 1-2 hrs | |
| `Scene/BatchTexture.js` | P1, P2, P3 | 1-2 hrs | |
| `Scene/Multiple3DTileContent.js` | P1, P2, P3 | 1-2 hrs | |
| `Scene/Implicit3DTileContent.js` | P1, P2, P3 | 2-3 hrs | |
| `Scene/ImplicitSubtree.js` | P1, P2, P3 | 2-3 hrs | |
| `Scene/ImplicitTileset.js` | P1, P2, P3 | 1-2 hrs | |
| `Scene/TileBoundingRegion.js` | P1, P2, P3 | 1-2 hrs | |
| `Scene/TileBoundingSphere.js` | P1, P2, P3 | 1 hr | |
| `Scene/TileOrientedBoundingBox.js` | P1, P2, P3 | 1 hr | |

### 🟡 Medium Priority (Imagery Providers — 15+ files)

| File | Patterns | Effort | Notes |
|------|----------|--------|-------|
| `Scene/ArcGisMapServerImageryProvider.js` | P1, P2, P3 | 1-2 hrs | |
| `Scene/Azure2DImageryProvider.js` | P1, P2, P3 | 1-2 hrs | |
| `Scene/BingMapsImageryProvider.js` | P1, P2, P3 | 1-2 hrs | |
| `Scene/GoogleEarthEnterpriseImageryProvider.js` | P1, P2, P3 | 1-2 hrs | |
| `Scene/GoogleEarthEnterpriseMapsProvider.js` | P1, P2, P3 | 1-2 hrs | |
| `Scene/GridImageryProvider.js` | P1, P2, P3 | 1 hr | |
| `Scene/IonImageryProvider.js` | P1, P2, P3 | 1-2 hrs | |
| `Scene/MapboxImageryProvider.js` | P1, P2, P3 | 1 hr | |
| `Scene/MapboxStyleImageryProvider.js` | P1, P2, P3 | 1 hr | |
| `Scene/OpenStreetMapImageryProvider.js` | P1, P2, P3 | 1 hr | |
| `Scene/SingleTileImageryProvider.js` | P1, P2, P3 | 1 hr | |
| `Scene/TileCoordinatesImageryProvider.js` | P1, P2, P3 | 1 hr | |
| `Scene/TileMapServiceImageryProvider.js` | P1, P2, P3 | 1-2 hrs | |
| `Scene/UrlTemplateImageryProvider.js` | P1, P2, P3 | 2-3 hrs | Most used provider |
| `Scene/WebMapServiceImageryProvider.js` | P1, P2, P3 | 1-2 hrs | |
| `Scene/WebMapTileServiceImageryProvider.js` | P1, P2, P3 | 1-2 hrs | |

### 🟡 Medium Priority (Model/glTF Pipeline — 40+ files)

The Model pipeline is the largest subsystem. Most files are in `Scene/Model/`.

| File | Patterns | Effort | Notes |
|------|----------|--------|-------|
| `Scene/Model/Model.js` | P1, P2, P3 | 4-6 hrs | Core model class, very large |
| `Scene/Model/ModelDrawCommand.js` | P1, P2, P3 | 2-3 hrs | |
| `Scene/Model/ModelFeature.js` | P1, P2, P3 | 1-2 hrs | |
| `Scene/Model/ModelFeatureTable.js` | P1, P2, P3 | 1-2 hrs | |
| `Scene/Model/ModelSceneGraph.js` | P1, P2, P3 | 3-4 hrs | Complex scene graph |
| `Scene/Model/ModelRuntimeNode.js` | P1, P2, P3 | 1-2 hrs | |
| `Scene/Model/ModelRuntimePrimitive.js` | P1, P2, P3 | 1-2 hrs | |
| `Scene/Model/ModelSkin.js` | P1, P2, P3 | 1-2 hrs | |
| `Scene/Model/ModelArticulation.js` | P1, P2, P3 | 1-2 hrs | |
| `Scene/Model/ModelStatistics.js` | P1, P2, P3 | 1 hr | |
| `Scene/Model/GltfLoader.js` | P1, P2, P3 | 3-4 hrs | Complex loader |
| `Scene/Model/GltfJsonLoader.js` | P1, P2, P3 | 1-2 hrs | |
| `Scene/Model/GltfBufferViewLoader.js` | P1, P2, P3 | 1-2 hrs | |
| `Scene/Model/GltfDracoLoader.js` | P1, P2, P3 | 1-2 hrs | |
| `Scene/Model/GltfImageLoader.js` | P1, P2, P3 | 1-2 hrs | |
| `Scene/Model/GltfIndexBufferLoader.js` | P1, P2, P3 | 1-2 hrs | |
| `Scene/Model/GltfTextureLoader.js` | P1, P2, P3 | 1-2 hrs | |
| `Scene/Model/GltfVertexBufferLoader.js` | P1, P2, P3 | 1-2 hrs | |
| `Scene/Model/GltfStructuralMetadataLoader.js` | P1, P2, P3 | 1-2 hrs | |
| (20+ more Model pipeline stages) | P1, P2, P3 | 1-2 hrs each | `*PipelineStage.js` files |

### 🟢 Low Priority (Remaining Scene Files — 80+ files)

| Category | Files | Patterns | Notes |
|----------|-------|----------|-------|
| Emitters (Box, Circle, Cone, Sphere) | 4 | P1, P2, P3 | Small particle emitter classes |
| Metadata (PropertyAttribute, etc.) | 15+ | P1, P2, P3 | 3D Tiles metadata |
| GaussianSplatPrimitive | 1 | P1, P2, P3 | Newer addition |
| Voxel subsystem | 5+ | P1, P2, P3 | VoxelCell, VoxelShape, etc. |
| Terrain classification | 5+ | P1, P2, P3 | Classification types |
| Label/Text | 3+ | P1, P2, P3 | Label, LabelCollection, LabelStyle |
| Polyline subsystem | 3+ | P1, P2, P3 | Polyline, PolylineMaterialAppearance |
| Globe subsystem | 5+ | P1, P2, P3 | GlobeSurface*, QuadtreePrimitive |
| Expression/Conditions | 5+ | P1, P2, P3 | StyleExpression, ConditionsExpression |
| Environment | 3+ | P1, P2, P3 | DynamicEnvironmentMapManager, Atmosphere |
| Clipping | 3+ | P1, P2, P3 | ClippingPlaneCollection, ClippingPolygonCollection |
| Misc rendering | 10+ | P1, P2, P3 | Various |

---

## 3. Core — 83 files

### ⚠️ Caution: Performance-Critical Math Classes

These files require **benchmarking before and after** class conversion. They use `result` parameters and scratch variables extensively where ES6 patterns may add overhead.

| File | Patterns | Effort | Notes |
|------|----------|--------|-------|
| `Core/Cartesian2.js` | P1, P2, P3 | 2-3 hrs | ⚠️ Performance-critical |
| `Core/Cartesian3.js` | P1, P2, P3 | 3-4 hrs | ⚠️ Performance-critical, very large |
| `Core/Cartesian4.js` | P1, P2, P3 | 2-3 hrs | ⚠️ Performance-critical |
| `Core/Matrix2.js` | P1, P2, P3 | 2-3 hrs | ⚠️ Performance-critical |
| `Core/Matrix3.js` | P1, P2, P3 | 3-4 hrs | ⚠️ Performance-critical |
| `Core/Matrix4.js` | P1, P2, P3 | 4-6 hrs | ⚠️ Performance-critical, very large |
| `Core/Quaternion.js` | P1, P2, P3 | 2-3 hrs | ⚠️ Performance-critical |
| `Core/BoundingSphere.js` | P1, P2, P3 | 3-4 hrs | ⚠️ Performance-critical, large |
| `Core/BoundingRectangle.js` | P1, P2, P3 | 1-2 hrs | ⚠️ Performance-critical |
| `Core/AxisAlignedBoundingBox.js` | P1, P2, P3 | 1-2 hrs | ⚠️ Performance-critical |
| `Core/OrientedBoundingBox.js` | P1, P2, P3 | 2-3 hrs | ⚠️ Performance-critical |
| `Core/Plane.js` | P1, P2, P3 | 1-2 hrs | ⚠️ Performance-critical |
| `Core/Ray.js` | P1, P2, P3 | 1-2 hrs | ⚠️ Performance-critical |
| `Core/Transforms.js` | P1, P2, P3 | 3-4 hrs | ⚠️ Performance-critical |
| `Core/EllipsoidGeodesic.js` | P1, P2, P3 | 2-3 hrs | ⚠️ Performance-critical |
| `Core/EllipsoidRhumbLine.js` | P1, P2, P3 | 2-3 hrs | ⚠️ Performance-critical |

### 🟡 Medium Priority (Terrain/Geography)

| File | Patterns | Effort | Notes |
|------|----------|--------|-------|
| `Core/ArcGISTiledElevationTerrainProvider.js` | P1, P2, P3 | 2-3 hrs | |
| `Core/CesiumTerrainProvider.js` | P1, P2, P3 | 2-3 hrs | |
| `Core/Cesium3DTilesTerrainProvider.js` | P1, P2, P3 | 2-3 hrs | |
| `Core/Cesium3DTilesTerrainData.js` | P1, P2, P3 | 2-3 hrs | |
| `Core/CustomHeightmapTerrainProvider.js` | P1, P2, P3 | 1-2 hrs | |
| `Core/EllipseGeometry.js` | P1, P2, P3 | 2-3 hrs | |
| `Core/Ellipsoid.js` | P1, P2, P3 | 2-3 hrs | ⚠️ Used everywhere |
| `Core/GeographicProjection.js` | P1, P2, P3 | 1-2 hrs | |
| `Core/GeographicTilingScheme.js` | P1, P2, P3 | 1-2 hrs | |
| `Core/WebMercatorProjection.js` | P1, P2, P3 | 1-2 hrs | |
| `Core/WebMercatorTilingScheme.js` | P1, P2, P3 | 1-2 hrs | |
| `Core/HeightmapTerrainData.js` | P1, P2, P3 | 2-3 hrs | WASM target |
| `Core/QuantizedMeshTerrainData.js` | P1, P2, P3 | 2-3 hrs | WASM target |

### 🟡 Medium Priority (Geometry)

| File | Patterns | Effort | Notes |
|------|----------|--------|-------|
| `Core/BoxGeometry.js` | P1, P2, P3 | 1-2 hrs | |
| `Core/BoxOutlineGeometry.js` | P1, P2, P3 | 1-2 hrs | |
| `Core/CircleGeometry.js` | P1, P2, P3 | 1 hr | |
| `Core/CircleOutlineGeometry.js` | P1, P2, P3 | 1 hr | |
| `Core/CoplanarPolygonGeometry.js` | P1, P2, P3 | 1-2 hrs | |
| `Core/CorridorGeometry.js` | P1, P2, P3 | 2-3 hrs | |
| `Core/CylinderGeometry.js` | P1, P2, P3 | 1-2 hrs | |
| `Core/EllipseOutlineGeometry.js` | P1, P2, P3 | 1-2 hrs | |
| `Core/EllipsoidGeometry.js` | P1, P2, P3 | 1-2 hrs | |
| `Core/FrustumGeometry.js` | P1, P2, P3 | 1-2 hrs | |
| `Core/GroundPolylineGeometry.js` | P1, P2, P3 | 2-3 hrs | |
| `Core/PlaneGeometry.js` | P1, P2, P3 | 1 hr | |
| `Core/PolygonGeometry.js` | P1, P2, P3 | 3-4 hrs | Complex |
| `Core/PolylineGeometry.js` | P1, P2, P3 | 1-2 hrs | |
| `Core/PolylineVolumeGeometry.js` | P1, P2, P3 | 1-2 hrs | |
| `Core/RectangleGeometry.js` | P1, P2, P3 | 2-3 hrs | |
| `Core/SimplePolylineGeometry.js` | P1, P2, P3 | 1-2 hrs | |
| `Core/SphereGeometry.js` | P1, P2, P3 | 1 hr | |
| `Core/WallGeometry.js` | P1, P2, P3 | 1-2 hrs | |

### 🟢 Low Priority (Utilities & Infrastructure)

| File | Patterns | Effort | Notes |
|------|----------|--------|-------|
| `Core/AssociativeArray.js` | P1, P2, P3 | 0.5 hr | Simple container |
| `Core/Cartographic.js` | P1, P2, P3 | 1-2 hrs | |
| `Core/CatmullRomSpline.js` | P1, P2, P3 | 1-2 hrs | |
| `Core/Clock.js` | P1, P2, P3 | 1-2 hrs | |
| `Core/Color.js` | P1, P2, P3 | 2-3 hrs | Large, many static methods |
| `Core/CompressedTextureBuffer.js` | P1, P2, P3 | 0.5 hr | |
| `Core/ConstantSpline.js` | P1, P2, P3 | 0.5 hr | |
| `Core/Credit.js` | P1, P2, P3 | 1 hr | |
| `Core/CullingVolume.js` | P1, P2, P3 | 1-2 hrs | ⚠️ Used in culling pipeline |
| `Core/DefaultProxy.js` | P1, P2, P3 | 0.5 hr | |
| `Core/DistanceDisplayCondition.js` | P1, P2, P3 | 0.5 hr | |
| `Core/DoubleEndedPriorityQueue.js` | P1, P2, P3 | 1 hr | |
| `Core/EarthOrientationParameters.js` | P1, P2, P3 | 1-2 hrs | |
| `Core/Ellipsoid.js` | P1, P2, P3 | 2-3 hrs | |
| `Core/Event.js` | P1, P2, P3, P6 (arguments) | 1-2 hrs | Uses `arguments` object |
| `Core/EventHelper.js` | P1, P2, P3 | 0.5 hr | |
| `Core/Fullscreen.js` | P1, P2, P3 | 0.5 hr | |
| `Core/GeometryAttribute.js` | P1, P2, P3 | 0.5 hr | |
| `Core/GeometryInstance.js` | P1, P2, P3 | 0.5 hr | |
| `Core/GoogleEarthEnterpriseMetadata.js` | P1, P2, P3 | 2-3 hrs | |
| `Core/GoogleEarthEnterpriseTerrainData.js` | P1, P2, P3 | 2-3 hrs | |
| `Core/GoogleEarthEnterpriseTerrainProvider.js` | P1, P2, P3 | 2-3 hrs | |
| `Core/Heap.js` | P1, P2, P3 | 1 hr | |
| `Core/Iau2006XysData.js` | P1, P2, P3 | 1-2 hrs | |
| `Core/Ion.js` | P1, P2, P3 | 0.5 hr | |
| `Core/IonGeocoderService.js` | P1, P2, P3 | 0.5 hr | |
| `Core/IonResource.js` | P1, P2, P3 | 1-2 hrs | |
| `Core/JulianDate.js` | P1, P2, P3 | 2-3 hrs | ⚠️ Date math |
| `Core/NearFarScalar.js` | P1, P2, P3 | 0.5 hr | |
| `Core/PeliasGeocoderService.js` | P1, P2, P3 | 0.5 hr | |
| `Core/PerspectiveFrustum.js` | P1, P2, P3 | 1-2 hrs | |
| `Core/PerspectiveOffCenterFrustum.js` | P1, P2, P3 | 1-2 hrs | |
| `Core/OrthographicFrustum.js` | P1, P2, P3 | 1-2 hrs | |
| `Core/OrthographicOffCenterFrustum.js` | P1, P2, P3 | 1-2 hrs | |
| `Core/Queue.js` | P1, P2, P3 | 0.5 hr | |
| `Core/Rectangle.js` | P1, P2, P3 | 2-3 hrs | |
| `Core/Request.js` | P1, P2, P3 | 1 hr | |
| `Core/RequestScheduler.js` | P1, P2, P3 | 1-2 hrs | |
| `Core/Resource.js` | P1, P2, P3 | 3-4 hrs | Very large |
| `Core/TaskProcessor.js` | P1, P2, P3 | 1-2 hrs | |
| `Core/TimeInterval.js` | P1, P2, P3 | 1-2 hrs | |
| `Core/TimeIntervalCollection.js` | P1, P2, P3 | 2-3 hrs | |
| `Core/TrustedServers.js` | P1, P2, P3 | 0.5 hr | |
| `Core/VRTheWorldTerrainProvider.js` | P1, P2, P3 | 1-2 hrs | |
| `Core/wrapFunction.js` | P6 (arguments), P7 (.apply) | 0.5 hr | Uses `arguments` + `.apply` |

---

## 4. DataSources — 85 files

Nearly every file in DataSources uses pre-ES6 patterns.

### 🔴 High Priority (Modified by Sorting System)

| File | Patterns | Effort | Blocks WebGPU? | Notes |
|------|----------|--------|----------------|-------|
| ~~`DataSources/Entity.js`~~ | ~~P1, P2, P3, E1~~ | ~~3-4 hrs~~ | ~~Yes~~ | ✅ Completed March 2026. Hybrid ES6 class: 7 class getters/setters (`id`, `definitionChanged`, `show`, `isShowing`, `parent`, `propertyNames`, `renderPriority`), 6 class methods, 3 `static` methods. 21 dynamic property descriptors retained via `Object.defineProperties` (use `createPropertyDescriptor`/`createRawPropertyDescriptor` factories). ~550 lines. |
| ~~`DataSources/BillboardVisualizer.js`~~ | ~~P1, P2, P3~~ | ~~1-2 hrs~~ | ~~Yes~~ | ✅ Completed March 2026. 5 class methods, file-scoped helpers preserved. |
| ~~`DataSources/PointVisualizer.js`~~ | ~~P1, P2, P3~~ | ~~1-2 hrs~~ | ~~Yes~~ | ✅ Completed March 2026. 5 class methods, file-scoped helpers preserved. |
| ~~`DataSources/ModelVisualizer.js`~~ | ~~P1, P2, P3~~ | ~~1-2 hrs~~ | ~~Yes~~ | ✅ Completed March 2026. 5 class methods, file-scoped helpers preserved. |
| ~~`DataSources/GeometryVisualizer.js`~~ | ~~P1, P2, P3~~ | ~~2-3 hrs~~ | ~~Yes~~ | ✅ Completed March 2026. 7 class methods, 3 static methods, file-scoped helpers preserved. |
| ~~`DataSources/PolylineVisualizer.js`~~ | ~~P1, P2, P3~~ | ~~2-3 hrs~~ | ~~Yes~~ | ✅ Completed March 2026. 5 class methods, 1 static method, file-scoped helpers preserved. |
| ~~`DataSources/StaticGeometryColorBatch.js`~~ | ~~P1, P2, P3~~ | ~~1-2 hrs~~ | ~~Yes~~ | ✅ Completed March 2026. 2 classes (Batch + StaticGeometryColorBatch), 14 total class methods, file-scoped helpers preserved. |
| ~~`DataSources/StaticGeometryPerMaterialBatch.js`~~ | ~~P1, P2, P3~~ | ~~1-2 hrs~~ | ~~Yes~~ | ✅ Completed March 2026. 2 classes (Batch + StaticGeometryPerMaterialBatch), 15 total class methods, file-scoped helpers preserved. |

### 🟡 Medium Priority (Entity Properties — 30+ files)

| File | Patterns | Effort | Notes |
|------|----------|--------|-------|
| `DataSources/BillboardGraphics.js` | P1, P2, P3 | 1-2 hrs | |
| `DataSources/BoxGraphics.js` | P1, P2, P3 | 1-2 hrs | |
| `DataSources/CorridorGraphics.js` | P1, P2, P3 | 1-2 hrs | |
| `DataSources/CylinderGraphics.js` | P1, P2, P3 | 1-2 hrs | |
| `DataSources/EllipseGraphics.js` | P1, P2, P3 | 1-2 hrs | |
| `DataSources/EllipsoidGraphics.js` | P1, P2, P3 | 1-2 hrs | |
| `DataSources/LabelGraphics.js` | P1, P2, P3 | 1-2 hrs | |
| `DataSources/ModelGraphics.js` | P1, P2, P3 | 1-2 hrs | |
| `DataSources/PathGraphics.js` | P1, P2, P3 | 1-2 hrs | |
| `DataSources/PlaneGraphics.js` | P1, P2, P3 | 1-2 hrs | |
| `DataSources/PointGraphics.js` | P1, P2, P3 | 1-2 hrs | |
| `DataSources/PolygonGraphics.js` | P1, P2, P3 | 1-2 hrs | |
| `DataSources/PolylineGraphics.js` | P1, P2, P3 | 1-2 hrs | |
| `DataSources/PolylineVolumeGraphics.js` | P1, P2, P3 | 1-2 hrs | |
| `DataSources/RectangleGraphics.js` | P1, P2, P3 | 1-2 hrs | |
| `DataSources/WallGraphics.js` | P1, P2, P3 | 1-2 hrs | |
| `DataSources/Cesium3DTilesetGraphics.js` | P1, P2, P3 | 1-2 hrs | |

### 🟡 Medium Priority (Properties & Data Sources)

| File | Patterns | Effort | Notes |
|------|----------|--------|-------|
| `DataSources/ConstantProperty.js` | P1, P2, P3 | 1 hr | |
| `DataSources/ConstantPositionProperty.js` | P1, P2, P3 | 1 hr | |
| `DataSources/CallbackProperty.js` | P1, P2, P3 | 1 hr | |
| `DataSources/CallbackPositionProperty.js` | P1, P2, P3 | 1 hr | |
| `DataSources/CompositeProperty.js` | P1, P2, P3, E1 | 1-2 hrs | Uses .indexOf |
| `DataSources/CompositeMaterialProperty.js` | P1, P2, P3 | 1 hr | |
| `DataSources/CompositePositionProperty.js` | P1, P2, P3 | 1 hr | |
| `DataSources/CompositeEntityCollection.js` | P1, P2, P3, E1 | 2-3 hrs | Uses .indexOf |
| `DataSources/ColorMaterialProperty.js` | P1, P2, P3 | 1 hr | |
| `DataSources/CheckerboardMaterialProperty.js` | P1, P2, P3 | 1 hr | |
| `DataSources/GridMaterialProperty.js` | P1, P2, P3 | 1 hr | |
| `DataSources/ImageMaterialProperty.js` | P1, P2, P3 | 1 hr | |
| `DataSources/StripeMaterialProperty.js` | P1, P2, P3 | 1 hr | |
| `DataSources/PolylineArrowMaterialProperty.js` | P1, P2, P3 | 1 hr | |
| `DataSources/PolylineDashMaterialProperty.js` | P1, P2, P3 | 1 hr | |
| `DataSources/PolylineGlowMaterialProperty.js` | P1, P2, P3 | 1 hr | |
| `DataSources/PolylineOutlineMaterialProperty.js` | P1, P2, P3 | 1 hr | |
| `DataSources/SampledProperty.js` | P1, P2, P3 | 1-2 hrs | |
| `DataSources/SampledPositionProperty.js` | P1, P2, P3 | 1-2 hrs | |
| `DataSources/TimeIntervalCollectionProperty.js` | P1, P2, P3 | 1-2 hrs | |
| `DataSources/TimeIntervalCollectionPositionProperty.js` | P1, P2, P3 | 1 hr | |
| `DataSources/NodeTransformationProperty.js` | P1, P2, P3 | 1 hr | |
| `DataSources/PropertyBag.js` | P1, P2, P3, E1 | 1-2 hrs | Uses .indexOf |
| `DataSources/VelocityOrientationProperty.js` | P1, P2, P3 | 1 hr | |
| `DataSources/VelocityVectorProperty.js` | P1, P2, P3 | 1 hr | |
| `DataSources/ReferenceProperty.js` | P1, P2, P3 | 1-2 hrs | |
| `DataSources/CzmlDataSource.js` | P1, P2, P3, E1, E2 | 4-6 hrs | Very large, complex |
| `DataSources/GeoJsonDataSource.js` | P1, P2, P3 | 2-3 hrs | |
| `DataSources/KmlDataSource.js` | P1, P2, P3 | 3-4 hrs | Large, complex |
| `DataSources/GpxDataSource.js` | P1, P2, P3 | 2-3 hrs | |
| `DataSources/CustomDataSource.js` | P1, P2, P3 | 1 hr | |
| `DataSources/DataSourceCollection.js` | P1, P2, P3, E1 | 1-2 hrs | Uses .indexOf |
| `DataSources/DataSourceDisplay.js` | P1, P2, P3, E1 | 2-3 hrs | Uses .indexOf |
| `DataSources/EntityCluster.js` | P1, P2, P3 | 2-3 hrs | |
| `DataSources/EntityCollection.js` | P1, P2, P3, E1 | 2-3 hrs | Uses .indexOf |
| `DataSources/EntityView.js` | P1, P2, P3 | 1-2 hrs | |

### 🟡 Medium Priority (Geometry Updaters — 15+ files)

| File | Patterns | Effort | Notes |
|------|----------|--------|-------|
| `DataSources/BoxGeometryUpdater.js` | P1, P2, P3 | 1-2 hrs | |
| `DataSources/CorridorGeometryUpdater.js` | P1, P2, P3 | 1-2 hrs | |
| `DataSources/CylinderGeometryUpdater.js` | P1, P2, P3 | 1-2 hrs | |
| `DataSources/EllipseGeometryUpdater.js` | P1, P2, P3 | 1-2 hrs | |
| `DataSources/EllipsoidGeometryUpdater.js` | P1, P2, P3 | 1-2 hrs | |
| `DataSources/GroundGeometryUpdater.js` | P1, P2, P3 | 1-2 hrs | |
| `DataSources/PlaneGeometryUpdater.js` | P1, P2, P3 | 1-2 hrs | |
| `DataSources/PolygonGeometryUpdater.js` | P1, P2, P3 | 2-3 hrs | |
| `DataSources/PolylineGeometryUpdater.js` | P1, P2, P3 | 1-2 hrs | |
| `DataSources/PolylineVolumeGeometryUpdater.js` | P1, P2, P3 | 1-2 hrs | |
| `DataSources/RectangleGeometryUpdater.js` | P1, P2, P3 | 1-2 hrs | |
| `DataSources/WallGeometryUpdater.js` | P1, P2, P3 | 1-2 hrs | |

---

## 5. Widgets — 22 files

All widget files use pre-ES6 patterns and depend on Knockout.js (a separate tech debt issue).

### 🟡 Medium Priority

| File | Patterns | Effort | Notes |
|------|----------|--------|-------|
| `Viewer/Viewer.js` | P1, P2, P3, P4 (var) | 4-6 hrs | Very large, modified for WebGPU createAsync |
| `CesiumWidget/CesiumWidget.js` | P1, P2, P3, P4 | 3-4 hrs | Modified for WebGPU createAsync |
| `ClockViewModel.js` | P1, P2, P3 | 1 hr | |
| `Command.js` | P1, P2, P3 | 0.5 hr | |
| `Animation/Animation.js` | P1, P2, P3, P4 | 2-3 hrs | Has `var` declarations |
| `Animation/AnimationViewModel.js` | P1, P2, P3, P4 | 2-3 hrs | Has `var` declarations |
| `BaseLayerPicker/BaseLayerPicker.js` | P1, P2, P3, P4 | 1-2 hrs | |
| `BaseLayerPicker/BaseLayerPickerViewModel.js` | P1, P2, P3, P4 | 1-2 hrs | |
| `BaseLayerPicker/ProviderViewModel.js` | P1, P2, P3 | 1 hr | |
| `Cesium3DTilesInspector/Cesium3DTilesInspector.js` | P1, P2, P3, P4 | 1-2 hrs | |
| `Cesium3DTilesInspector/Cesium3DTilesInspectorViewModel.js` | P1, P2, P3, P4 | 2-3 hrs | |
| `CesiumInspector/CesiumInspector.js` | P1, P2, P3, P4 | 1-2 hrs | |
| `CesiumInspector/CesiumInspectorViewModel.js` | P1, P2, P3, P4 | 2-3 hrs | |
| `FullscreenButton/FullscreenButton.js` | P1, P2, P3, P4 | 1 hr | |
| `FullscreenButton/FullscreenButtonViewModel.js` | P1, P2, P3 | 1 hr | |
| `Geocoder/Geocoder.js` | P1, P2, P3, P4 | 1-2 hrs | |
| `Geocoder/GeocoderViewModel.js` | P1, P2, P3, P4 | 2-3 hrs | |
| `HomeButton/HomeButton.js` | P1, P2, P3, P4 | 1 hr | |
| `HomeButton/HomeButtonViewModel.js` | P1, P2, P3 | 1 hr | |
| `I3SInspector/I3SBuildingSceneLayerExplorerViewModel.js` | P1, P2, P3 | 1-2 hrs | |
| `InfoBox/InfoBox.js` | P1, P2, P3, P4 | 1-2 hrs | |
| `InfoBox/InfoBoxViewModel.js` | P1, P2, P3, P4 | 1 hr | |
| `NavigationHelpButton/NavigationHelpButton.js` | P1, P2, P3, P4 | 1 hr | |
| `NavigationHelpButton/NavigationHelpButtonViewModel.js` | P1, P2, P3 | 1 hr | |
| `PerformanceWatchdog/PerformanceWatchdog.js` | P1, P2, P3, P4 | 1 hr | |
| `PerformanceWatchdog/PerformanceWatchdogViewModel.js` | P1, P2, P3 | 1 hr | |
| `ProjectionPicker/ProjectionPicker.js` | P1, P2, P3, P4 | 1 hr | |
| `ProjectionPicker/ProjectionPickerViewModel.js` | P1, P2, P3 | 1 hr | |
| `SceneModePicker/SceneModePicker.js` | P1, P2, P3, P4 | 1 hr | |
| `SceneModePicker/SceneModePickerViewModel.js` | P1, P2, P3 | 1 hr | |
| `SelectionIndicator/SelectionIndicator.js` | P1, P2, P3, P4 | 1 hr | |
| `SelectionIndicator/SelectionIndicatorViewModel.js` | P1, P2, P3, P4 | 1 hr | |
| `Timeline/Timeline.js` | P1, P2, P3, P4 | 2-3 hrs | Complex, has `var` decls |
| `Timeline/TimelineHighlightRange.js` | P1, P2, P3, P4 | 0.5 hr | |
| `Timeline/TimelineTrack.js` | P1, P2, P3, P4 | 0.5 hr | |
| `VRButton/VRButton.js` | P1, P2, P3, P4 | 1 hr | |
| `VRButton/VRButtonViewModel.js` | P1, P2, P3 | 1 hr | |

---

## 6. Pre-ES2022 Patterns (Cross-Cutting)

These patterns span multiple directories. Files are listed if they contain the pattern **and** are not already listed above.

### `.indexOf()` → `.includes()` (~60 files)

| Directory | Files |
|-----------|-------|
| **Core** | `ArcGISTiledElevationTerrainProvider.js`, `AssociativeArray.js`, `Cesium3DTilesTerrainGeometryProcessor.js`, `CesiumTerrainProvider.js`, `Credit.js`, `DefaultProxy.js`, `EarthOrientationParameters.js`, `EventHelper.js`, `Queue.js`, `Resource.js`, `TimeIntervalCollection.js`, `TrustedServers.js`, `parseResponseHeaders.js` |
| **DataSources** | `CompositeEntityCollection.js`, `CompositeProperty.js`, `CzmlDataSource.js`, `DataSourceCollection.js`, `DataSourceDisplay.js`, `Entity.js`, `EntityCollection.js`, `GeoJsonDataSource.js`, `GpxDataSource.js`, `KmlDataSource.js`, `PropertyBag.js`, `ReferenceProperty.js` |
| **Scene** | `BillboardCollection.js`, `Camera.js`, `Cesium3DTileBatchTable.js`, `Cesium3DTileStyle.js`, `Cesium3DTilesetTraversal.js`, `ClippingPlaneCollection.js`, `GlobeSurfaceTileProvider.js`, `ImageryLayer.js`, `Material.js`, `Model/CustomShaderTranslucencyMode.js`, `Model/GltfLoader.js`, `Model/Model.js`, `Model/ModelSceneGraph.js`, `Picking.js`, `PostProcessStageCollection.js`, `Scene.js`, `UrlTemplateImageryProvider.js` |
| **Renderer** | `AutomaticUniforms.js`, `ShaderCache.js`, `ShaderSource.js` |

### `typeof x !== "undefined"` → optional chaining / nullish coalescing (~40 files)

| Directory | Files |
|-----------|-------|
| **Core** | `ArcGISTiledElevationTerrainProvider.js`, `CesiumTerrainProvider.js`, `Credit.js`, `FeatureDetection.js`, `Fullscreen.js`, `GeographicProjection.js`, `GoogleEarthEnterpriseMetadata.js`, `Ion.js`, `Resource.js`, `RuntimeError.js`, `TaskProcessor.js`, `TrustedServers.js`, `buildModuleUrl.js`, `defined.js` |
| **DataSources** | `CzmlDataSource.js`, `GeoJsonDataSource.js`, `KmlDataSource.js` |
| **Scene** | `ArcGisMapServerImageryProvider.js`, `BingMapsImageryProvider.js`, `GlobeSurfaceTileProvider.js`, `GoogleEarthEnterprise*.js`, `ImageryLayerCollection.js`, `Material.js`, `Model/Model.js`, `Scene.js`, `ScreenSpaceCameraController.js`, `TileMapServiceImageryProvider.js` |
| **Renderer** | `Context.js` (remaining instances), `ShaderProgram.js` |

### `.hasOwnProperty()` → `Object.hasOwn()` (~25 files)

| Directory | Files |
|-----------|-------|
| **Core** | `CesiumTerrainProvider.js`, `Cesium3DTilesTerrainGeometryProcessor.js`, `Credit.js`, `FeatureDetection.js`, `GeocodeType.js`, `GoogleEarthEnterpriseMetadata.js`, `HeadingPitchRange.js`, `Resource.js`, `TrustedServers.js`, `isBlobUri.js` |
| **DataSources** | `CzmlDataSource.js`, `GeoJsonDataSource.js`, `GpxDataSource.js`, `KmlDataSource.js` |
| **Scene** | `Cesium3DTileBatchTable.js`, `Cesium3DTileStyle.js`, `Expression.js`, `GlobeSurfaceTileProvider.js`, `Material.js`, `Model/GltfLoader.js`, `Model/Model.js` |
| **Renderer** | `AutomaticUniforms.js`, `ShaderSource.js` |

### `arguments` Object → Rest Parameters (~10 files)

| File | Pattern | Notes |
|------|---------|-------|
| `Core/Event.js` | `listener.apply(scope, arguments)` | Core event system — high impact |
| `Core/wrapFunction.js` | `fn.apply(obj, arguments)` (2 instances) | Utility |
| `Renderer/Context.js` | `property.apply(gl, arguments)` | Already partially modernized |

### `.call(this, ...)` Patterns (~38 files)

Most `.call(this, ...)` uses are in DataSources geometry updaters calling parent class methods — these will be naturally resolved when converting to ES6 `class` with `super.method()`.

---

## Completed Modernizations

| File | What Changed | Date | Notes |
|------|-------------|------|-------|
| `Renderer/Context.js` | Prototype → ES6 class, `extends GraphicsContext` | 2025 | Initial WebGPU work |
| `Renderer/PickId.js` | Created as ES6 class | March 2026 | Pick ID abstraction (FORK-35) |
| `Renderer/WebGPU/WebGPUModelPipelineCache.js` | Created as ES6 class | 2025 | WebGPU model pipeline |
| All `Renderer/WebGPU/*.ts` files (83+) | Already ES2022+ TypeScript | 2025-2026 | All new WebGPU code |
| All `Scene/SortMode.js`, `RenderLayer.js`, etc. | Created as ES6 (Object.freeze enums) | March 2026 | Sorting system |
| `Scene/RenderScheduler.js` | Created as ES6 class | March 2026 | Sorting orchestrator |
| `Scene/MaterialSortIdAllocator.js` | Created as ES6 class | March 2026 | Material batching |
| `Scene/SceneOctree.js`, `Scene/OctreeNode.js` | Created as ES6 class | March 2026 | Spatial acceleration |
| `Scene/OcclusionCulling.js` | Created as ES6 class | March 2026 | Hi-Z occlusion |
| `Scene/SOABoundingSphereLayout.js` | Created as ES6 class | March 2026 | WASM data layout |
| `Scene/WasmCullBridge.js`, `Scene/WasmSortBridge.js` | Created as ES6 class | March 2026 | WASM bridges |
| `Renderer/DrawCommand.js` | Constructor→class, `Object.defineProperties`→class `get/set`, `prototype.execute`→class method, `shallowClone`→static method | March 2026 | 🔴 WebGPU-blocking. Performance: NEUTRAL (V8 hidden class shape identical). ~540 lines. |
| `Renderer/ClearCommand.js` | Constructor→class, `prototype.execute`→class method, `ClearCommand.ALL`→static class field | March 2026 | 🔴 WebGPU-blocking. Performance: NEUTRAL. ~100 lines. |
| `Scene/FrameState.js` | Constructor→class (pure data container, no prototype methods) | March 2026 | 🟡 Infrastructure. Performance: NEUTRAL (created once per frame). ~467 lines. |
| `Renderer/ShaderProgram.js` | Constructor→class, `Object.defineProperties`→class `get`, prototype methods→class methods, static methods→`static`, `.hasOwnProperty`→`Object.hasOwn` (E3) | March 2026 | 🔴 WebGPU-blocking. Performance: NEUTRAL + micro-improvement from `Object.hasOwn`. ~445 lines. |
| `Renderer/RenderState.js` | Constructor→class, all static methods→`static` keyword | March 2026 | 🔴 WebGPU-blocking. Performance: NEUTRAL (`partialApply` hot-path bytecode unchanged). ~588 lines. |
| `Renderer/PassState.js` | Constructor→class (pure data container, no methods) | March 2026 | 🔴 WebGPU-blocking. Simplest file (~55 lines). |
| `Renderer/ComputeCommand.js` | Constructor→class, `prototype.execute`→class method | March 2026 | 🔴 WebGPU-blocking. ~105 lines. |
| `Renderer/ShaderCache.js` | Constructor→class, `Object.defineProperties`→class `get`, prototype methods→class methods, `.hasOwnProperty`→`Object.hasOwn` (E3×2) | March 2026 | 🔴 WebGPU-blocking. ~200 lines. |
| `Renderer/Buffer.js` | Constructor→class, `Object.defineProperties`→class `get`, prototype→class methods, static factory methods→`static`. Instance-level `defineProperties` in `createIndexBuffer` preserved (per-instance augmentation). | March 2026 | 🔴 WebGPU-blocking. ~310 lines. |
| `Renderer/Framebuffer.js` | Constructor→class, `Object.defineProperties`→8 class getters (incl. computed `hasDepthAttachment`), prototype→class methods | March 2026 | 🔴 WebGPU-blocking. ~340 lines. |
| `Renderer/ShaderSource.js` | Constructor→class, prototype→class methods, static methods→`static`, `.hasOwnProperty`→`Object.hasOwn` (E3×3), `.indexOf`→`.includes` (E1) | March 2026 | 🔴 WebGPU-blocking. ~380 lines. |
| `Renderer/Texture.js` | Constructor→class, `Object.defineProperties`→11 class getters + 1 setter, prototype→class methods, static methods→`static`, file-scoped helpers preserved below class | March 2026 | 🔴 WebGPU-blocking. Largest Renderer file (~720 lines). |
| `Renderer/Sampler.js` | Constructor→class, `Object.defineProperties`→6 getters, `Sampler.equals`→`static equals`, `Sampler.NEAREST`→`static` field | March 2026 | 🟡 Medium. ~100 lines. |
| `Renderer/Renderbuffer.js` | Constructor→class, `Object.defineProperties`→3 getters, prototype→class methods | March 2026 | 🟡 Medium. ~100 lines. |
| `Renderer/CubeMapFace.js` | Constructor→class, `Object.defineProperties`→3 getters, prototype→3 class methods | March 2026 | 🟡 Medium. ~320 lines. |
| `Renderer/MultisampleFramebuffer.js` | Constructor→class, prototype→4 class methods | March 2026 | 🟡 Medium. ~130 lines. |
| `Renderer/CubeMap.js` | Constructor→class, `Object.defineProperties`→15 getters + 1 setter, prototype→5 class methods, 4 `static` methods, file-scoped helpers preserved | March 2026 | 🟡 Medium. ~400 lines. |
| `Scene/Scene.js` | Constructor→class, `Object.defineProperties`→~50 class getters/setters, 35+ prototype methods→class methods, `Scene.createAsync`→`static async`, `Scene.defaultLogDepthBuffer`→`static` field. SORT-3 integration: `RenderScheduler.binCommand()` wired into `executeCommandsInViewport()` for material sort ID population. **Decomposition Phases 1-6 COMPLETE:** 7 modules extracted (CommandSorter.js, SceneUtilities.js, SceneDebug.js, EnvironmentRenderer.js, FramebufferOrchestrator.js, SceneRenderer.js, ViewportExecutor.js) — 1,237 lines removed from Scene.js. 5 unused imports removed (`mergeSort`, `PerspectiveFrustum`, `PerspectiveOffCenterFrustum`, `Transforms`, `SunPostProcess`). `resolveFramebuffers` class method delegates to imported impl. No rendering pipeline functions remain in Scene.js. | March 2026 | 🔴 WebGPU-blocking. THE most-touched file (~3,684 lines, down from ~5,310). All 8 decomposed files pass syntax check. See `SCENE_DECOMPOSITION_PLAN.md`. |
| `Renderer/ShaderFunction.js` | Constructor→class, 2 class methods | March 2026 | 🟡 Medium. ~65 lines. |
| `Renderer/ShaderStruct.js` | Constructor→class, 2 class methods | March 2026 | 🟡 Medium. ~55 lines. |
| `Renderer/TextureCache.js` | Constructor→class, 1 getter, 5 class methods, `.hasOwnProperty`→`Object.hasOwn` (E3×2) | March 2026 | 🟡 Medium. ~80 lines. |
| `Renderer/ShaderBuilder.js` | Constructor→class, 1 getter, 12 class methods, 3 file-scoped helpers preserved | March 2026 | 🟡 Medium. ~420 lines. |
| `DataSources/BillboardVisualizer.js` | Constructor→class, 5 class methods (`update`, `getBoundingSphere`, `isDestroyed`, `destroy`, `_onCollectionChanged`), file-scoped helpers preserved | March 2026 | 🔴 Sort priority wiring. ~280 lines. |
| `DataSources/PointVisualizer.js` | Constructor→class, 5 class methods, file-scoped helpers preserved | March 2026 | 🔴 Sort priority wiring. ~330 lines. |
| `DataSources/ModelVisualizer.js` | Constructor→class, 5 class methods (`update`, `isDestroyed`, `destroy`, `getBoundingSphere`, `_onCollectionChanged`), file-scoped async helper + 2 helpers preserved | March 2026 | 🔴 Sort priority wiring. ~400 lines. |
| `Renderer/SharedContext.js` | Constructor→class, 3 class methods (`createSceneContext`, `destroy`, `isDestroyed`), no getters | March 2026 | 🟡 Medium. ~173 lines. |
| `Renderer/Texture3D.js` | Constructor→class, `Object.defineProperties`→12 getters + 1 setter, 4 class methods, 1 `static` method, file-scoped helpers preserved | March 2026 | 🟡 Medium. ~558 lines. |
| `Renderer/VertexArray.js` | Constructor→class, `Object.defineProperties`→3 getters, 5 class methods, 1 `static` method, `.hasOwnProperty`→`Object.hasOwn` (E3×3), string concat→template literal | March 2026 | 🟡 Medium. ~570 lines. |
| `Renderer/VertexArrayFacade.js` | Constructor→class, 6 class methods, 6 `static` methods, `.hasOwnProperty`→`Object.hasOwn` (E3), file-scoped helpers preserved | March 2026 | 🟡 Medium. ~560 lines. |
| `DataSources/StaticGeometryColorBatch.js` | Constructor→class (2 classes: Batch + StaticGeometryColorBatch), 14 total class methods, file-scoped helpers preserved | March 2026 | 🔴 Sort priority batching. ~395 lines. |
| `DataSources/StaticGeometryPerMaterialBatch.js` | Constructor→class (2 classes: Batch + StaticGeometryPerMaterialBatch), 15 total class methods, file-scoped helpers preserved | March 2026 | 🔴 Sort priority batching. ~430 lines. |
| `DataSources/GeometryVisualizer.js` | Constructor→class, 7 class methods, 3 `static` methods, file-scoped helpers preserved | March 2026 | 🔴 Geometry batching. ~355 lines. |
| `DataSources/PolylineVisualizer.js` | Constructor→class, 5 class methods, 1 `static` method, file-scoped helpers preserved | March 2026 | 🔴 Polyline priority. ~310 lines. |
| `Scene/PointPrimitive.js` | Constructor→class, `Object.defineProperties`→14 class getters/setters, 6 class methods, 3 `static` methods. Static index constants preserved as post-class assignments with file-scoped aliases. | March 2026 | 🔴 WebGPU collection item. ~557 lines. |
| `Renderer/TextureAtlas.js` | Constructor→class, `Object.defineProperties`→8 class getters, 13 class methods. File-scoped `AddImageRequest` helper and `resolveImage` async function preserved. | March 2026 | 🟡 Renderer remainder. ~571 lines. |
| `DataSources/Entity.js` | Hybrid ES6 class: 7 class getters/setters, 6 class methods, 3 `static` methods. 21 dynamic property descriptors retained via `Object.defineProperties` (factory-generated). | March 2026 | 🔴 Sorting/renderPriority. ~550 lines. |
| `Scene/Billboard.js` | Constructor→class, `Object.defineProperties`→31 class getters/setters, 13 class methods, 4 `static` methods. 19 static index constants as post-class assignments. | March 2026 | 🔴 WebGPU collection item. ~1,031 lines. |
| `Scene/PointPrimitiveCollection.js` | Constructor→class, `Object.defineProperties`→1 class getter (`length`), 9 class methods (`add`, `remove`, `removeAll`, `_updatePointPrimitive`, `contains`, `get`, `computeNewBuffersUsage`, `update`, `isDestroyed`, `destroy`). File-scoped helpers preserved. | March 2026 | 🔴 WebGPU collection. ~724 lines. |
| `Scene/PolylineCollection.js` | Constructor→class, `Object.defineProperties`→1 class getter (`length`), 10 class methods (`add`, `remove`, `removeAll`, `contains`, `get`, `update`, `_updatePolyline`, `isDestroyed`, `destroy`). `.hasOwnProperty`→`Object.hasOwn` (E3×2). Internal `PolylineBucket`/`VertexArrayBucketLocator` kept as file-scoped constructors. | March 2026 | 🔴 WebGPU collection. ~1,297 lines. |
| `Scene/BillboardCollection.js` | Constructor→class, `Object.defineProperties`→8 class getters/setters (`length`, `textureAtlas`, `destroyTextureAtlas`, `sizeInBytes`, `ready`, `billboardTextureCache`, `coarseDepthTestDistance`, `threePointDepthTestDistance`), 10 class methods (`add`, `remove`, `removeAll`, `_updateBillboard`, `contains`, `get`, `computeNewBuffersUsage`, `update`, `isDestroyed`, `destroy`). File-scoped helpers preserved. | March 2026 | 🔴 WebGPU collection. ~1,330 lines. |
| `Scene/Primitive.js` | Constructor→class, `Object.defineProperties`→8 class getters, 4 class methods (`update`, `getGeometryInstanceAttributes`, `isDestroyed`, `destroy`), 7 static method aliases for backward compat. **Decomposed:** ~2,170 lines split into 4 files all under 1000 lines: `Primitive.js` (~770 lines, ES6 class), `PrimitiveShaderHelpers.js` (~340 lines, shader mod functions), `PrimitiveCommandHelpers.js` (~340 lines, command/render/uniform helpers), `PrimitiveGeometryHelpers.js` (~600 lines, geometry loading/batch table). `.hasOwnProperty`→`Object.hasOwn` (E3×4). | March 2026 | 🔴 WebGPU-blocking. Last Group 6 collection file. |
| `Renderer/UniformState.js` | Constructor→class, `Object.defineProperties`→~60 class getters + 2 setters, 4 class methods. **Decomposed:** ~1,370 lines split into 2 files: `UniformState.js` (~870 lines, ES6 class + getters + methods), `UniformStateComputations.js` (~480 lines, lazy clean functions + setters + view2Dto3D). | March 2026 | 🔴 WebGPU-blocking. Last significant Renderer file. **Renderer: 29 of 29 JS files now ES6 class ✅ GROUP 2 COMPLETE.** |
| `Scene/SkyBox.js` | Constructor→class, 1 getter/setter (`sources`), 3 class methods, 1 `static` method (`createEarthSkyBox`). File-scoped helper `getDefaultSkyBoxUrl` preserved. | March 2026 | 🔴 WebGPU environment. ~138 lines. |
| `Scene/Moon.js` | Constructor→class, 1 getter (`ellipsoid`), 3 class methods. File-scoped scratch variables preserved. | March 2026 | 🔴 WebGPU environment. ~175 lines. |
| `Scene/Fog.js` | Constructor→class, 1 getter/setter (`heightFalloff`), 1 class method (`update`). File-scoped scratch variable preserved. | March 2026 | 🟡 Scene infrastructure. ~200 lines. |
| `Scene/CubeMapPanorama.js` | Constructor→class, 2 getters (`transform`, `credit`), 3 class methods. File-scoped helpers removed (none needed). | March 2026 | 🔴 WebGPU environment. ~270 lines. |
| `Scene/Sun.js` | Constructor→class, 1 getter/setter (`glowFactor`), 3 class methods. File-scoped scratch variables preserved. | March 2026 | 🔴 WebGPU environment. ~279 lines. |
| `Scene/SkyAtmosphere.js` | Constructor→class, 1 getter (`ellipsoid`), 4 class methods (`setDynamicLighting`, `update`, `isDestroyed`, `destroy`). File-scoped `hasColorCorrection` helper preserved. | March 2026 | 🔴 WebGPU environment. ~310 lines. |
| `Scene/DepthPlane.js` | Constructor→class, 4 class methods (`update`, `execute`, `isDestroyed`, `destroy`). No getters. File-scoped `computeDepthQuad` helper preserved. | March 2026 | 🟡 Scene infrastructure. ~197 lines. |
| `Scene/InvertClassification.js` | Constructor→class, 1 getter (`unclassifiedCommand`), 7 class methods, 1 `static` method (`isTranslucencySupported`). File-scoped render state objects + GLSL strings preserved. | March 2026 | 🔴 WebGPU feature renderer. ~303 lines. |
| `Scene/EllipsoidPrimitive.js` | Constructor→class, 3 class methods (`update`, `isDestroyed`, `destroy`). No getters. File-scoped `getVertexArray` helper preserved. | March 2026 | 🔴 WebGPU feature renderer. ~340 lines. |
| `Scene/PointCloudEyeDomeLighting.js` | Constructor→class, 3 getters (`framebuffer`, `colorGBuffer`, `depthGBuffer`), 3 class methods, 1 `static` method (`isSupported`). File-scoped helpers preserved. | March 2026 | 🔴 WebGPU feature renderer. ~232 lines. |
| `Scene/CloudCollection.js` | Constructor→class, 1 getter (`length`), 9 class methods (`add`, `remove`, `removeAll`, `_updateCloud`, `contains`, `get`, `update`, `isDestroyed`, `destroy`). Many file-scoped vertex/buffer helpers preserved. | March 2026 | 🔴 WebGPU feature renderer. ~680 lines. |
| `Scene/TimeDynamicPointCloud.js` | Constructor→class, 3 getters/setters (`clippingPlanes`, `totalMemoryUsageInBytes`, `boundingSphere`), 5 class methods (`makeStyleDirty`, `_getAverageLoadTime`, `update`, `isDestroyed`, `destroy`). Many file-scoped frame management helpers preserved. | March 2026 | 🔴 WebGPU feature renderer. ~600 lines. |
| `Scene/Globe.js` | Constructor→class, `Object.defineProperties`→20 class getters/setters, 9 class methods (`pickWorldCoordinates`, `pick`, `getHeight`, `update`, `beginFrame`, `render`, `endFrame`, `isDestroyed`, `destroy`). File-scoped helpers preserved. | March 2026 | 🔴 WebGPU globe entry. ~730 lines. |
| `Scene/GroundPrimitive.js` | Constructor→class, `Object.defineProperties`→7 class getters, 5 class methods, 4 `static` methods (`isSupported`, `initializeTerrainHeights`, `_supportsMaterials`, `supportsMaterials`). `.hasOwnProperty`→`Object.hasOwn` (E3). File-scoped helpers preserved. | March 2026 | 🔴 WebGPU ground primitive. ~920 lines. |
| `Scene/PostProcessStageCollection.js` | Constructor→class, `Object.defineProperties`→10 class getters/setters (`ready`, `fxaa`, `ambientOcclusion`, `bloom`, `length`, `outputTexture`, `hasSelected`, `tonemapper`, `exposure`), 13 class methods. Renamed file-scoped `getOutputTexture`→`getOutputTextureFromStage` and `execute`→`executeStage` to avoid shadowing class methods. | March 2026 | 🔴 WebGPU post-process. ~740 lines. |
| `Scene/ShadowMap.js` | Constructor→class, `Object.defineProperties`→9 class getters/setters, 5 class methods, 2 `static` methods. Inner `ShadowMapCamera` and `ShadowPass` also converted to ES6 class. **Decomposed:** ~1,120 lines split into 2 files: `ShadowMap.js` (~934 lines), `ShadowMapComputations.js` (~977 lines). Inline GLSL debug shaders converted to template literals (P5). | March 2026 | 🔴 WebGPU shadows. |
| `Scene/Picking.js` | Constructor→class, 20 class methods (pick, pickAsync, drillPick, pickFromRay, sampleHeight, clampToHeight, etc.). **Decomposed:** ~920 lines split into 2 files: `Picking.js` (~824 lines, ES6 class + screen-space helpers), `PickingRayHelpers.js` (~551 lines, ray picking, height sampling, drill-from-ray). `.hasOwnProperty`→`Object.hasOwn` (E3), `.indexOf`→`.includes` (E1×3). | March 2026 | 🟡 Pick system + WebGPU pick infra. |
| `Scene/View.js` | Constructor→class, `Object.defineProperties`→3 class getters/setters (`graphicsContext`, `effectiveContext`, `scene`), 3 class methods (`checkForCameraUpdates`, `createPotentiallyVisibleSet`, `destroy`). File-scoped helpers preserved (`CommandExtent`, `cameraEqual`, `updateFrustums`, `insertIntoBin`). | March 2026 | 🟡 Multi-context infrastructure. ~430 lines. |
| `Scene/GlobeSurfaceTile.js` | Constructor→class, `Object.defineProperties`→2 class getters (`eligibleForUnloading`, `renderedMesh`), 12 class methods, 4 `static` methods (`initialize`, `processStateMachine`, `_createVertexArrayForMesh`, `_freeVertexArray`). `.hasOwnProperty`→`Object.hasOwn` (E3). File-scoped terrain state machine helpers preserved. | March 2026 | 🔴 WebGPU globe tiles. ~620 lines. |
| `Scene/VoxelPrimitive.js` | Constructor→class, `Object.defineProperties`→28 class getters/setters, 3 class methods (`update`, `isDestroyed`, `destroy`). **Decomposed:** ~1,384 lines split into 2 files: `VoxelPrimitive.js` (~630 lines, ES6 class), `VoxelPrimitiveHelpers.js` (~600 lines, shape/transform/traversal/debug helpers + `DefaultVoxelProvider` class). `.hasOwnProperty`→`Object.hasOwn` (E3×3). | March 2026 | 🔴 WebGPU voxel renderer. |
| `Scene/GlobeSurfaceTileProvider.js` | Constructor→class, `Object.defineProperties`→9 class getters/setters (`baseColor`, `quadtree`, `tilingScheme`, `errorEvent`, `imageryLayersUpdatedEvent`, `terrainProvider`, `clippingPlanes`, `clippingPolygons`), 17 class methods, 4 layer event handlers (`_onLayerAdded`, `_onLayerRemoved`, `_onLayerMoved`, `_onLayerShownOrHidden`). **Decomposed:** ~2,097 lines split into 2 files: `GlobeSurfaceTileProvider.js` (~1,154 lines, ES6 class + QuadtreeTileProvider interface), `GlobeSurfaceTileProviderRendering.js` (~1,724 lines, draw commands, uniform maps, wireframe, debug visualization, bounding region, WebGPU terrain path). | March 2026 | 🔴 WebGPU globe terrain. |
| `Scene/Camera.js` | Constructor→class, `Object.defineProperties`→15 class getters (`transform`, `inverseTransform`, `viewMatrix`, `inverseViewMatrix`, `positionCartographic`, `positionWC`, `directionWC`, `upWC`, `rightWC`, `heading`, `pitch`, `roll`, `moveStart`, `moveEnd`, `changed`), ~35 class methods, 1 `static` method (`clone`). **Decomposed:** ~2,490 lines split into 3 files: `Camera.js` (~1,050 lines, ES6 class with all public methods), `CameraHelpers.js` (~750 lines, setView/rectangle/pick/flight file-scoped helpers), `CameraInternals.js` (~480 lines, core update/transform/math helpers). Static constants preserved as post-class assignments. | March 2026 | 🟡 Scene infrastructure. Fundamental camera class. |
| `Scene/ScreenSpaceCameraController.js` | Constructor→class, 4 class methods (`onMap`, `update`, `isDestroyed`, `destroy`), 2 private class methods (`_reactToInput`, `_adjustHeightForTerrain`). No `Object.defineProperties` (pure data properties in constructor). **Decomposed:** ~2,030 lines split into 3 files: `ScreenSpaceCameraController.js` (~380 lines, ES6 class + input framework), `SSCCInputHelpers.js` (~700 lines, shared helpers: handleZoom, pickPosition, strafe, look3D, rotate3D, pan3D), `SSCCModeHandlers.js` (~750 lines, mode-specific: update2D/CV/3D + translate/rotate/zoom/tilt/spin per mode). | March 2026 | 🟡 Scene infrastructure. Input handler. |
| `Scene/Appearance.js` | Constructor→class, `Object.defineProperties`→4 class getters (`vertexShaderSource`, `fragmentShaderSource`, `renderState`, `closed`), 3 class methods (`getFragmentShaderSource`, `isTranslucent`, `getRenderState`), 1 `static` method (`getDefaultRenderState`). | March 2026 | 🟡 Material system base (Tier 3 #11). ~196 lines. |
| `Scene/OrderedGroundPrimitiveCollection.js` | Constructor→class, `Object.defineProperties`→1 class getter (`length`), 7 class methods (`add`, `set`, `remove`, `removeAll`, `contains`, `update`, `isDestroyed`, `destroy`). | March 2026 | 🟡 Ground sorting (Tier 1 #5). ~213 lines. |
| `Scene/PostProcessStageComposite.js` | Constructor→class, `Object.defineProperties`→8 class getters/setters (`ready`, `name`, `enabled`, `uniforms`, `inputPreviousStageTexture`, `length`, `selected`, `parentSelected`), 5 class methods (`_isSupported`, `get`, `update`, `isDestroyed`, `destroy`). File-scoped `isSelectedTextureDirty` helper preserved. | March 2026 | 🟡 Post-process pipeline (Tier 1 #5). ~303 lines. |
| `Scene/GlobeTranslucencyState.js` | Constructor→class, `Object.defineProperties`→8 class getters (`frontFaceAlphaByDistance`, `backFaceAlphaByDistance`, `translucent`, `sunVisibleThroughGlobe`, `environmentVisible`, `useDepthPlane`, `numberOfTextureUniforms`, `rectangle`), 5 class methods (`update`, `updateDerivedCommands`, `pushDerivedCommands`, `executeGlobeCommands`, `executeGlobeClassificationCommands`). Inner `DerivedCommandPack` also converted to ES6 class. `.indexOf`→`.includes` (E1) in `hasDefine` and `executeCommandsMatchingType`. ~30 file-scoped helpers preserved. | March 2026 | 🟡 Globe translucency (Tier 3 #13). ~639 lines. |
| `Scene/PostProcessStage.js` | Constructor→class, `Object.defineProperties`→14 class getters/setters (`ready`, `name`, `fragmentShader`, `uniforms`, `textureScale`, `forcePowerOfTwo`, `sampleMode`, `pixelFormat`, `pixelDatatype`, `clearColor`, `scissorRectangle`, `outputTexture`, `selected`, `parentSelected`), 5 class methods (`_isSupported`, `update`, `execute`, `isDestroyed`, `destroy`). `.hasOwnProperty`→`Object.hasOwn` (E3×2). ~15 file-scoped helpers preserved. | March 2026 | 🟡 Post-process pipeline (Tier 1 #5). ~710 lines. |
| `Scene/ImageryLayerCollection.js` | Constructor→class, `Object.defineProperties`→1 class getter (`length`), 17 class methods (`add`, `addImageryProvider`, `remove`, `removeAll`, `contains`, `indexOf`, `get`, `raise`, `lower`, `raiseToTop`, `lowerToBottom`, `pickImageryLayers`, `pickImageryLayerFeatures`, `queueReprojectionCommands`, `cancelReprojections`, `isDestroyed`, `destroy`), 1 private class method (`_update`). File-scoped helpers preserved (`getLayerIndex`, `swapLayers`, `pickImageryHelper`). | March 2026 | 🟡 Imagery pipeline (Tier 1 #2). ~470 lines. |
| `Scene/MaterialAppearance.js` | Constructor→class, `Object.defineProperties`→9 class getters (`vertexShaderSource`, `fragmentShaderSource`, `renderState`, `closed`, `materialSupport`, `vertexFormat`, `flat`, `faceForward`), 3 class methods (`getFragmentShaderSource`, `isTranslucent`, `getRenderState`) delegating to `Appearance.prototype`. `MaterialAppearance.MaterialSupport` static property preserved. | March 2026 | 🟡 Material system (Tier 3 #11). ~290 lines. |
| `Scene/PerInstanceColorAppearance.js` | Constructor→class, `Object.defineProperties`→7 class getters (`vertexShaderSource`, `fragmentShaderSource`, `renderState`, `closed`, `vertexFormat`, `flat`, `faceForward`), 3 class methods delegating to `Appearance.prototype`. `VERTEX_FORMAT` and `FLAT_VERTEX_FORMAT` static properties preserved. | March 2026 | 🟡 Material system (Tier 3 #11). ~270 lines. |
| `Scene/EllipsoidSurfaceAppearance.js` | Constructor→class, `Object.defineProperties`→8 class getters (`vertexShaderSource`, `fragmentShaderSource`, `renderState`, `closed`, `vertexFormat`, `flat`, `faceForward`, `aboveGround`), 3 class methods delegating to `Appearance.prototype`. `VERTEX_FORMAT` static property preserved. | March 2026 | 🟡 Material system (Tier 3 #11). ~250 lines. |
| `Scene/PolylineMaterialAppearance.js` | Constructor→class, `Object.defineProperties`→5 class getters (`vertexShaderSource` with polyline dash detection, `fragmentShaderSource`, `renderState`, `closed`, `vertexFormat`), 3 class methods delegating to `Appearance.prototype`. `VERTEX_FORMAT` static property preserved. | March 2026 | 🟡 Material system (Tier 3 #11). ~230 lines. |
| `Scene/Material.js` | Constructor→class, `Object.defineProperties`→2 class getters/setters (`minificationFilter`, `magnificationFilter`), `type` frozen via `Object.defineProperty` after init, 4 class methods (`isTranslucent`, `update`, `isDestroyed`, `destroy`), 2 `static` methods (`fromType`, `fromTypeAsync`). **Decomposed:** ~1,530 lines split into 2 files: `Material.js` (~940 lines, ES6 class + 25 material type registrations), `MaterialHelpers.js` (~630 lines, 15+ file-scoped helpers: `initializeMaterial`, template validation, uniform creation, texture loading, shader source generation, token replacement, sub-material construction). Circular dependency avoided by passing `Material` constructor to helpers. Constants `DEFAULT_IMAGE_ID`/`DEFAULT_CUBE_MAP_ID` and `materialCache` defined in helpers, re-exported on `Material` class as static properties. `_imageSources` property (MAT-1 fix) preserved. | March 2026 | 🟡 Material system (Tier 3 #11). |
| `Scene/PickDepth.js` | Constructor→class, `Object.defineProperties`→1 class getter (`framebuffer`), 4 class methods (`update`, `getDepth`, `executeCopyDepth`, `isDestroyed`, `destroy`). Added `getDepthAsync()` for WebGPU async depth readback. WebGPU path stores depth texture reference and returns cached values via `_lastDepthValue`. | March 2026 | 🟡 Pick system + WebGPU depth readback. ~160 lines. |
| `Scene/ImageryLayer.js` | Constructor→class, `Object.defineProperties`→5 class getters (`imageryProvider`, `ready`, `errorEvent`, `readyEvent`, `rectangle`), 14 class methods, 2 `static` methods (`fromProviderAsync`, `fromWorldImagery`), 10 static constants. **Decomposed:** ~1,731 lines split into 2 files: `ImageryLayer.js` (~600 lines, ES6 class + public API + static constants), `ImageryLayerHelpers.js` (~650 lines, `createTileImagerySkeletons`, `requestImagery`, `reprojectToGeographic`, `getLevelWithMaximumTexelSpacing`, `getSamplerKey`, `getImageryCacheKey`, `handleError`, `handlePromise`). | March 2026 | 🟡 Imagery pipeline (Tier 1 #2). |
| `Scene/QuadtreePrimitive.js` | Constructor→class, `Object.defineProperties`→3 class getters (`tileProvider`, `tileLoadProgressEvent`, `occluders`), 10 class methods (`invalidateAllTiles`, `forEachLoadedTile`, `forEachRenderedTile`, `updateHeight`, `update`, `beginFrame`, `render`, `endFrame`, `isDestroyed`, `destroy`). File-scoped `TraversalDetails` and `TraversalQuadDetails` kept as constructor functions (internal, not part of public API). ~25 file-scoped helpers preserved. | March 2026 | 🔴 WebGPU globe quadtree. ~910 lines. |
| `Scene/QuadtreeTile.js` | Constructor→class, `Object.defineProperties`→14 class getters (`tilingScheme`, `x`, `y`, `level`, `parent`, `rectangle`, `children`, `southwestChild`, `southeastChild`, `northwestChild`, `northeastChild`, `customData`, `needsLoading`, `eligibleForUnloading`), 12 class methods, 1 `static` method (`createLevelZeroTiles`). Lazy child tile creation preserved in getters. File-scoped `LRUCache` class already ES6. `createSpatialHashKey`, `childTileAtPosition`, `freeTile` helpers preserved. | March 2026 | 🔴 WebGPU globe tiles. ~530 lines. |
| `Scene/TerrainFillMesh.js` | Constructor→class, 3 class methods (`update`, `destroy`, `_destroyVertexArray`), 1 `static` method (`updateFillTiles`). WebGPU-aware: `updateFillTiles` BFS checks both `vertexArray` and `mesh` for loaded tile detection, `visitRenderedTiles` likewise, `createFillMesh` skips WebGL VA creation when `context.isWebGPU`. ~20 file-scoped geometry construction helpers preserved. | March 2026 | 🔴 WebGPU globe fill tiles. ~1,100 lines. |

---

## Modernization Rules (from `.clinerules`)

1. **NEVER modernize a file you're not otherwise touching** — avoid drive-by refactors that bloat PRs
2. **ALWAYS modernize a file if you're making >10 lines of changes** to it — leave it better than you found it
3. **Prototype → class conversions** should follow upstream [#8359](https://github.com/CesiumGS/cesium/issues/8359) patterns and preserve all existing tests
4. **Performance-critical math classes** (`Cartesian3`, `Matrix4`, `Quaternion`, etc.) — benchmark before and after
5. **TypeScript files (.ts) are already ES2022+** — this backlog is primarily for `.js` files
6. When adding to this backlog, include: file path, patterns to update, estimated effort, and WebGPU blocking status

---

## Recommended Modernization Order

### Phase A: WebGPU-Critical Files (Modernize as they're touched)

1. **Renderer files** that interact with WebGPU: `DrawCommand.js`, `ShaderProgram.js`, `Buffer.js`, `Texture.js`, `ClearCommand.js`, `ComputeCommand.js`, `PassState.js`, `RenderState.js`, `Framebuffer.js`, `FramebufferManager.js`
2. **Scene files** modified by WebGPU: `Scene.js`, `Primitive.js`, `BillboardCollection.js`, `PointPrimitiveCollection.js`, `PolylineCollection.js`, `Billboard.js`, `PointPrimitive.js`
3. **DataSources** modified by sorting: `Entity.js`, `BillboardVisualizer.js`, `PointVisualizer.js`, `ModelVisualizer.js`

### Phase B: Upstream-Aligned Conversions

Convert files that upstream CesiumJS is also targeting for class conversion (per [#8359](https://github.com/CesiumGS/cesium/issues/8359)). This ensures our conversions merge cleanly when upstream does theirs.

### Phase C: Bulk Modernization (When Resources Allow)

Mass-convert remaining files directory by directory. DataSources and Widgets are the most uniform and easiest to batch-convert.

---

## Notes

- **Total unique files needing modernization:** ~432 (constructor function → class) + ~22 widgets = **~454 files**
- **Total unique files with `Object.defineProperties`:** ~360
- **Total estimated effort for complete modernization:** ~410-680 hours (varies by file complexity)
- **ThirdParty files excluded:** `basis_transcoder.js`, `google-earth-dbroot-parser.js` (generated/vendor code)
- **WGSL `var` in JS strings:** Not a modernization target — these are WGSL shader language, not JavaScript `var`
- **`var` in first-party code:** Essentially eliminated except in Widget files (which also use `var`)
- All Widget files also use `var` declarations (P4) in addition to prototype patterns
