# ES6+ / ES2022 Modernization Backlog

**Last Updated:** March 22, 2026  
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
| `Renderer/DrawCommand.js` | P1, P2, P3 (constructor fn, prototype, defineProperties) | 2-3 hrs | Yes — WebGPU parity | Sorting system adds properties; class conversion would clean up options/clone |
| `Renderer/ShaderProgram.js` | P1, P2, P3 | 2-3 hrs | Yes — shader cache | Material sort ID integration |
| `Renderer/ShaderSource.js` | P1, P2, P3 | 2-3 hrs | Yes — WGSL preprocessor interop | Shader pipeline shared code |
| `Renderer/ShaderCache.js` | P1, P2, P3 | 1-2 hrs | Yes — used by both backends | |
| `Renderer/Buffer.js` | P1, P2, P3 | 1-2 hrs | Yes — WebGPU buffer compat | |
| `Renderer/Texture.js` | P1, P2, P3 | 2-3 hrs | Yes — WebGPU texture compat | Large file |
| `Renderer/ClearCommand.js` | P1, P2, P3 | 1 hr | Yes — used in both paths | |
| `Renderer/ComputeCommand.js` | P1, P2, P3 | 1 hr | Yes — compute pipeline | |
| `Renderer/PassState.js` | P1, P2, P3 | 1 hr | Yes — render pass state | |
| `Renderer/RenderState.js` | P1, P2, P3 | 2-3 hrs | Yes — pipeline state | Complex state management |
| `Renderer/Framebuffer.js` | P1, P2, P3 | 1-2 hrs | Yes — FBO management | |
| `Renderer/FramebufferManager.js` | P1, P2, P3 | 1-2 hrs | Yes — FBO lifecycle | |

### 🟡 Medium Priority

| File | Patterns | Effort | Notes |
|------|----------|--------|-------|
| `Renderer/ComputeEngine.js` | P1, P2, P3 | 1 hr | |
| `Renderer/CubeMap.js` | P1, P2, P3 | 1-2 hrs | |
| `Renderer/CubeMapFace.js` | P1, P2, P3 | 1 hr | |
| `Renderer/MultisampleFramebuffer.js` | P1, P2, P3 | 1 hr | |
| `Renderer/Renderbuffer.js` | P1, P2, P3 | 1 hr | |
| `Renderer/Sampler.js` | P1, P2, P3 | 0.5 hr | Small class |
| `Renderer/ShaderBuilder.js` | P1, P2, P3 | 1-2 hrs | |
| `Renderer/ShaderFunction.js` | P1, P2, P3 | 0.5 hr | Small |
| `Renderer/ShaderStruct.js` | P1, P2, P3 | 0.5 hr | Small |
| `Renderer/SharedContext.js` | P1, P2, P3 | 1 hr | |
| `Renderer/Texture3D.js` | P1, P2, P3 | 1-2 hrs | |
| `Renderer/TextureCache.js` | P1, P2, P3 | 1 hr | |
| `Renderer/UniformState.js` | P1, P2, P3 | 3-4 hrs | Very large file, many uniforms |
| `Renderer/VertexArray.js` | P1, P2, P3 | 1-2 hrs | |
| `Renderer/VertexArrayFacade.js` | P1, P2, P3 | 1-2 hrs | |

### 🟢 Low Priority

| File | Patterns | Effort | Notes |
|------|----------|--------|-------|
| `Renderer/AutomaticUniforms.js` | P1 (AutomaticUniform constructor) | 2-3 hrs | Large, complex, low change frequency |
| `Renderer/TextureAtlas.js` | P1, P2, P3 | 1 hr | |

---

## 2. Scene — 213 files

The Scene directory has the most files needing modernization and is the most actively modified by our WebGPU work.

### 🔴 High Priority (Modified by WebGPU Fork)

| File | Patterns | Effort | Blocks WebGPU? | Notes |
|------|----------|--------|----------------|-------|
| `Scene/Scene.js` | P1, P2, P3 | 4-6 hrs | Yes — core rendering loop | Very large (~3000+ lines), 6 WebGPU routing points |
| `Scene/Primitive.js` | P1, P2, P3 | 3-4 hrs | Yes — geometry rendering | 5 WebGPU integration points |
| `Scene/BillboardCollection.js` | P1, P2, P3 | 3-4 hrs | Yes — WebGPU billboard renderer | Large, instanced rendering |
| `Scene/PointPrimitiveCollection.js` | P1, P2, P3 | 2-3 hrs | Yes — WebGPU point renderer | |
| `Scene/PolylineCollection.js` | P1, P2, P3 | 2-3 hrs | Yes — WebGPU polyline renderer | |
| `Scene/Billboard.js` | P1, P2, P3 | 2-3 hrs | Yes — billboard properties | |
| `Scene/PointPrimitive.js` | P1, P2, P3 | 1-2 hrs | Yes — point properties | |
| `Scene/SkyAtmosphere.js` | P1, P2, P3 | 1-2 hrs | Yes — WebGPU atmosphere | |
| `Scene/Sun.js` | P1, P2, P3 | 1-2 hrs | Yes — WebGPU sun | |
| `Scene/Moon.js` | P1, P2, P3 | 1-2 hrs | Yes — WebGPU moon | |
| `Scene/SkyBox.js` | P1, P2, P3 | 1-2 hrs | Yes — WebGPU skybox | |
| `Scene/CubeMapPanorama.js` | P1, P2, P3 | 1-2 hrs | Yes — WebGPU panorama | |
| `Scene/ShadowMap.js` | P1, P2, P3 | 2-3 hrs | Yes — WebGPU shadows | |
| `Scene/GlobeSurfaceTileProvider.js` | P1, P2, P3 | 3-4 hrs | Yes — WebGPU globe | Very large |
| `Scene/Globe.js` | P1, P2, P3 | 2-3 hrs | Yes — globe entry point | |
| `Scene/GlobeSurfaceTile.js` | P1, P2, P3 | 2-3 hrs | Yes — globe tiles | |
| `Scene/GroundPrimitive.js` | P1, P2, P3 | 2-3 hrs | Yes — WebGPU ground | |
| `Scene/InvertClassification.js` | P1, P2, P3 | 1-2 hrs | Yes — WebGPU feature renderer | |
| `Scene/CloudCollection.js` | P1, P2, P3 | 2-3 hrs | Yes — WebGPU cloud renderer | |
| `Scene/PointCloudEyeDomeLighting.js` | P1, P2, P3 | 1-2 hrs | Yes — WebGPU EDL | |
| `Scene/VoxelPrimitive.js` | P1, P2, P3 | 2-3 hrs | Yes — WebGPU voxel | |
| `Scene/TimeDynamicPointCloud.js` | P1, P2, P3 | 2-3 hrs | Yes — WebGPU point cloud | |
| `Scene/EllipsoidPrimitive.js` | P1, P2, P3 | 1-2 hrs | Yes — WebGPU ellipsoid | |
| `Scene/PostProcessStageCollection.js` | P1, P2, P3 | 2-3 hrs | Yes — WebGPU post-process | |

### 🟡 Medium Priority (Scene Infrastructure)

| File | Patterns | Effort | Notes |
|------|----------|--------|-------|
| `Scene/Camera.js` | P1, P2, P3 | 4-6 hrs | Very large, fundamental class |
| `Scene/View.js` | P1, P2, P3 | 2-3 hrs | Modified for multi-context |
| `Scene/FrameState.js` | P1, P2, P3 | 1-2 hrs | Modified for WebGPU |
| `Scene/Appearance.js` | P1, P2, P3 | 1-2 hrs | Material system base |
| `Scene/Material.js` | P1, P2, P3 | 3-4 hrs | Material system, complex |
| `Scene/ImageryLayer.js` | P1, P2, P3 | 3-4 hrs | Imagery pipeline |
| `Scene/ImageryLayerCollection.js` | P1, P2, P3 | 2-3 hrs | |
| `Scene/Fog.js` | P1, P2, P3 | 1 hr | |
| `Scene/GlobeTranslucencyState.js` | P1, P2, P3 | 2-3 hrs | |
| `Scene/DepthPlane.js` | P1, P2, P3 | 1-2 hrs | |
| `Scene/ScreenSpaceCameraController.js` | P1, P2, P3 | 3-4 hrs | Very large input handler |
| `Scene/Picking.js` | P1, P2, P3 | 2-3 hrs | Pick system |
| `Scene/ParticleSystem.js` | P1, P2, P3 | 2-3 hrs | |
| `Scene/Particle.js` | P1, P2, P3 | 1 hr | |
| `Scene/ParticleEmitter.js` | P1, P2, P3 | 1 hr | |
| `Scene/OrderedGroundPrimitiveCollection.js` | P1, P2, P3 | 1-2 hrs | Ground sorting |
| `Scene/PostProcessStage.js` | P1, P2, P3 | 2-3 hrs | |
| `Scene/PostProcessStageComposite.js` | P1, P2, P3 | 1-2 hrs | |
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
| `DataSources/Entity.js` | P1, P2, P3, E1 (.indexOf) | 3-4 hrs | Yes — renderPriority | Modified for sorting system |
| `DataSources/BillboardVisualizer.js` | P1, P2, P3 | 1-2 hrs | Yes — sort priority wiring | |
| `DataSources/PointVisualizer.js` | P1, P2, P3 | 1-2 hrs | Yes — sort priority wiring | |
| `DataSources/ModelVisualizer.js` | P1, P2, P3 | 1-2 hrs | Yes — sort priority wiring | |
| `DataSources/GeometryVisualizer.js` | P1, P2, P3 | 2-3 hrs | Yes — geometry batching | |
| `DataSources/PolylineVisualizer.js` | P1, P2, P3 | 2-3 hrs | Yes — polyline priority | |
| `DataSources/StaticGeometryColorBatch.js` | P1, P2, P3 | 1-2 hrs | Yes — priority batching | Modified for sorting |
| `DataSources/StaticGeometryPerMaterialBatch.js` | P1, P2, P3 | 1-2 hrs | Yes — priority batching | Modified for sorting |

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
