# CesiumJS WebGPU — Wiring & Fallback Audit

**Date:** April 2, 2026 (updated: post build & test verification)  
**Scope:** WASM bridge compliance, compute shader fallbacks, render pass wiring, GLSL backport analysis, upstream status, v1.140 feature audit, build verification  

---

## Executive Summary

After a thorough codebase audit, the project is in **much better shape than the March 31 audit suggested**. Most of the identified issues have been resolved. Here are the key findings:

| Area | Status | Details |
|------|--------|---------|
| **WASM Bridges (7)** | ✅ **ALL COMPLETE** | destroy(), free_buffer(), version check, SIMD detection, error handling, JS fallback |
| **Compute Engine** | ✅ **COMPLETE** | try/catch, workgroup validation, bool return for fallback |
| **Compute Shaders (11)** | ⚠️ **4 active, 7 dormant** | Dormant shaders are performance optimizations with working fallbacks — not blocking |
| **Render Passes (13)** | ✅ **ALL HANDLED** | ENVIRONMENT runs before WebGPU branch; all other passes in WebGPUSceneRenderer |
| **Feature Renderers (36)** | ✅ **ALL WIRED** | getFeatureRenderer() pattern in 33 scene files, 36 of 37 renderers registered (3 new BufferPrimitive stubs added) |
| **Post-Processing** | ✅ **COMPLETE** | 5 tonemapping, FXAA, Bloom(4-pass), SSAO(4-pass), DoF(3-pass), Edge, Silhouette |
| **IBL Pipeline** | ✅ **COMPLETE** | BRDF LUT, irradiance, radiance prefilter — all compute-based |
| **Shader Coverage** | ✅ **~95% functional** | 238 WGSL vs 319 GLSL, 91/90 builtin functions |
| **GLSL Backport** | ✅ **NONE NEEDED** | All WGSL either ports existing GLSL, compute-only, or WebGPU enhancements |
| **Viewer Init Bug** | 🔴→✅ **FIXED** | `_preInitializedScene` was not forwarded to CesiumWidget — now fixed |
| **Pick ID Validation** | 🔴→✅ **FIXED** | `createPickId`/`getObjectByPickColor` missing DeveloperError checks in GraphicsContext.ts — added `Check.defined()` guards |
| **Build** | ✅ **PASSES** | `npx gulp build` (23s), TypeScript `tsc --noEmit` (0 errors), WGSL wrappers (97 CsmBuiltins) |
| **Existing Tests** | ✅ **PASS** | Context: 58/58 (0 failures after fix). Full suite: ~15K green, ~30 pre-existing failures (not from our changes) |
| **WebGPU Init** | ✅ **VERIFIED** | scene-webgpu-init-test.html: adapter, device, canvas, beginFrame/endFrame all green |
| **Upstream** | ✅ **SYNCED** | 0 behind, 27 ahead — v1.140 + PR #13121 (constant LOD) merged, v1.140 feature audit complete |

### What's Needed to Run the App

| Priority | Item | Status |
|----------|------|--------|
| 🔴 **BLOCKING** | Viewer `_preInitializedScene` forwarding | ✅ **FIXED** (April 2, 2026) |
| 🟡 **Important** | End-to-end integration testing | ❌ Not started |
| 🟡 **Important** | Jasmine unit tests (0 currently for 83+ files) | ❌ Not started |
| 🟢 **Performance** | Activate 7 dormant compute shaders | ⏳ Deferred (all have fallbacks) |
| 🟢 **Robustness** | Per-bridge WASM arena slots (FORK-45) | ⏳ Deferred |
| 🟢 **Maintenance** | Upstream sync | ✅ **COMPLETE** — 0 behind, 25 ahead |

---

## 1. WASM Bridge Audit — ✅ ALL 7 BRIDGES COMPLETE

All 7 bridges now comply with every `.clinerules` mandate:

| Bridge | destroy() | free_buffer() | Version Check | SIMD Detection | JS Fallback | Error Handling |
|--------|-----------|---------------|---------------|----------------|-------------|----------------|
| WasmCullBridge | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| WasmSortBridge | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| WasmHeightmapBridge | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| WasmQuantizedMeshBridge | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| WasmRTEBridge | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| WasmMatrixBridge | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| WasmPointCloudBridge | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

**Implementation details:**
- `WasmFeatureDetection.js` in `Core/` provides shared utility: `checkSIMDSupport()`, `checkModuleSIMD()`, `checkVersionMatch()`, `freeBuffer()`
- All bridges have `_isDestroyed` guard preventing use after destroy
- All bridges have try/catch in WASM dispatch methods with automatic JS fallback on failure
- Rust `lib.rs` uses `try_reserve()` for OOM-safe allocation, returns null pointer (0) on OOM
- `version()` returns 2, `has_simd()` is a compile-time check
- `free_buffer()` clears and shrinks the arena to zero

**Remaining improvement (FORK-45):** All 7 bridges share one `Mutex<Vec<u8>>` arena. If two bridges run in the same frame, the second `alloc_buffer()` call overwrites the first's data. This works today because bridges run sequentially, but should be fixed for future parallelism with per-bridge buffer slots.

---

## 2. Compute Shader Audit — 4 Active, 7 Dormant (All Have Fallbacks)

### Compute Engine Safety ✅
- `execute()`, `executeMultiple()`, `executeOnEncoder()` — all wrapped in try/catch, return `false` on failure
- `_validateWorkgroups()` checks `device.limits.maxComputeWorkgroupsPerDimension` before dispatch
- Pipeline caching by shader source key

### Active Compute Shaders (4)

| Shader | Dispatched By | Purpose |
|--------|---------------|---------|
| `PolygonSignedDistance.wgsl` | `WebGPUClippingPolygonCollection.ts` | Polygon SDF atlas for clipping |
| `BrdfLutGenerate.wgsl` | `WebGPUIBLPipeline.ts` | One-time BRDF integration LUT |
| `IrradianceConvolution.wgsl` | `WebGPUIBLPipeline.ts` | Diffuse cubemap convolution |
| `RadiancePrefilter.wgsl` | `WebGPUIBLPipeline.ts` | Specular mipchain generation |

### Dormant Compute Shaders (7) — Performance Optimizations With Fallbacks

| Shader | Fallback | Why Dormant | Activation Trigger |
|--------|----------|-------------|-------------------|
| `FrustumCull.wgsl` | ✅ `WasmCullBridge.js` (SIMD) + JS | `WebGPUGPUCuller.ts` exists, nobody calls it | Wire into 3D Tiles when >50K objects |
| `HiZPyramid.wgsl` | ⚠️ Conservative "assume visible" | `OcclusionCulling.js` has stubs | Wire into ViewportExecutor with Hi-Z |
| `OcclusionTest.wgsl` | ⚠️ Conservative "assume visible" | Same as HiZPyramid | Same |
| `AtmosphereLUT.wgsl` | ✅ Per-pixel ray march in `SkyAtmosphere.wgsl` | Performance optimization only | Dispatch on scene init, bake LUT |
| `PointCloudSort.wgsl` | ✅ `WasmPointCloudBridge.sortByDistance()` | Unsorted rendering works | Wire when point cloud visible |
| `PointCloudLOD.wgsl` | ✅ `WasmPointCloudBridge.lodFilterAndSort()` | All points rendered (no LOD) | Wire when point cloud visible |
| `GPUSortKeys.wgsl` | ✅ JS multi-level comparators in Scene.js | JS sorting always active | Wire when >50K commands |

**All 7 dormant compute shaders have working fallbacks.** They are performance optimizations that should be activated when their consumer systems (3D Tiles massive datasets, point clouds, etc.) need them. Not blocking for basic app functionality.

---

## 3. Render Pass Coverage — ✅ ALL 13 PASSES HANDLED

The WebGL SceneRenderer.js calls `renderEnvironment()` at line 298-300 **before** the WebGPU branch at line 302. This means environment commands (sky, sun, moon, atmosphere, panorama) execute correctly for both backends.

| Pass | ID | Handler | Status |
|------|----|---------|--------|
| ENVIRONMENT | 0 | `renderEnvironment()` in SceneRenderer.js (before branch) | ✅ |
| COMPUTE | 1 | Handled by individual compute dispatches | ✅ |
| GLOBE | 2 | `_executeGlobePass()` | ✅ |
| TERRAIN_CLASSIFICATION | 3 | `_executePassCommands(Pass.TERRAIN_CLASSIFICATION)` | ✅ |
| CESIUM_3D_TILE_EDGES | 4 | `_execute3DTilePasses()` | ✅ |
| CESIUM_3D_TILE | 5 | `_execute3DTilePasses()` | ✅ |
| CESIUM_3D_TILE_CLASSIFICATION | 6 | `_execute3DTilePasses()` | ✅ |
| CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW | 7 | `_execute3DTilePasses()` | ✅ |
| OPAQUE | 8 | `_executeOpaquePass()` | ✅ |
| TRANSLUCENT | 9 | `_executeTranslucentPass()` | ✅ |
| VOXELS | 10 | `_executePassCommands(Pass.VOXELS)` | ✅ |
| GAUSSIAN_SPLATS | 11 | `_executePassCommands(Pass.GAUSSIAN_SPLATS)` | ✅ |
| OVERLAY | 12 | `_executeOverlayPass()` | ✅ |

Additional WebGPU-specific passes:
- **Pick pass** — `_executePickPass()` (GLOBE, 3D_TILE, OPAQUE, TRANSLUCENT)
- **Environmental effects** — `_executeEnvironmentalEffects()` (SSR, Weather, Clouds)
- **Post-processing** — `_runPostProcessing()` (Tonemapping, FXAA, Bloom, SSAO, DoF, etc.)
- **Performance infrastructure** — `beginFrame()`/`endFrame()` for render bundles, indirect draws, profiling

---

## 4. GLSL Backport Analysis — ✅ NO BACKPORTS NEEDED

All new WGSL shaders fall into three categories:

### Category A: Ports of Existing GLSL (No Backport — GLSL Already Exists)

| WGSL Shader | GLSL Equivalent | Notes |
|---|---|---|
| Tonemapping.wgsl (5 modes) | AcesTonemapping, Reinhard, ModifiedReinhard, FilmicTonemapping, PbrNeutralTonemapping.glsl | WGSL consolidates 5 into 1 |
| GroundAtmosphere.wgsl | GroundAtmosphere.glsl + AtmosphereCommon.glsl | Same Nishita algorithm |
| AmbientOcclusionGenerate/Modulate.wgsl | AmbientOcclusionGenerate/Modulate.glsl | SSAO |
| BrightPass.wgsl + BloomComposite.wgsl | Bloom.glsl + BloomComposite.glsl | Bloom |
| GaussianBlur1D.wgsl | GaussianBlur1D.glsl | Shared blur |
| DepthOfField.wgsl | DepthOfField.glsl | DoF |
| EdgeDetection.wgsl + Silhouette.wgsl | EdgeDetection.glsl + Silhouette*.glsl | Entity highlighting |
| BrdfLutGenerate.wgsl | BrdfLutGeneratorFS.glsl | IBL BRDF LUT |
| IrradianceConvolution.wgsl | ComputeIrradianceFS.glsl | IBL diffuse |
| RadiancePrefilter.wgsl | ConvolveSpecularMapFS.glsl | IBL specular |
| FXAA.wgsl | FXAA3_11.glsl | Anti-aliasing |
| All 90 builtin function chunks | All 89 czm_* builtin functions | 100%+ coverage |

### Category B: Compute-Only (Impossible in WebGL — No Backport Possible)

| WGSL Feature | Why No Backport |
|---|---|
| WeatherParticles.wgsl | GPU compute shader |
| AtmosphereLUT.wgsl | Compute-based LUT precomputation |
| PointCloudSort/PointCloudLOD.wgsl | GPU compute sorting/LOD |
| GPUSortKeys.wgsl | GPU compute key generation |
| FrustumCull.wgsl | GPU compute culling |
| HiZPyramid/OcclusionTest.wgsl | GPU compute occlusion |

### Category C: WebGPU-Only Enhancements (Deliberate, Not Parity Gaps)

| Enhancement | Description |
|---|---|
| ScreenSpaceReflections.wgsl | New feature — no upstream GLSL |
| ProceduralClouds.wgsl | Volumetric ray-march |
| DeferredGBuffer/DeferredLighting.wgsl | Deferred rendering |
| Night: Terminator glow, city lights emission | Enhancements beyond upstream `GlobeFS.glsl` |
| Ocean: GGX specular, Fresnel, foam, SSS | Enhancements beyond upstream `GlobeFS.glsl` |

**Conclusion: Zero GLSL backports required.** Every WGSL shader either has an existing GLSL equivalent upstream, requires GPU compute (impossible in WebGL), or is a deliberate WebGPU-only enhancement.

---

## 5. Bug Fix: Viewer._preInitializedScene — ✅ FIXED

### Problem
`Viewer.createAsync()` (line 2056-2065) creates a WebGPU Scene asynchronously via `CesiumWidget.createAsync()`, then passes `_preInitializedScene: widget.scene` to the Viewer constructor (line 2071-2074).

However, the Viewer constructor at line 477-515 creates a new `CesiumWidget` with explicitly-listed options that did **NOT include** `_preInitializedScene`. The pre-created WebGPU scene was silently discarded, and a new synchronous WebGL scene was created instead.

### Fix
Added `_preInitializedScene: options._preInitializedScene,` to the CesiumWidget options in the Viewer constructor (line 515).

`CesiumWidget.js` already has the consumer code:
```javascript
if (defined(options._preInitializedScene)) {
  // WebGPU async path — Scene was already created via Scene.createAsync()
  scene = options._preInitializedScene;
} else {
  // ... create scene normally
}
```

This was the **only blocking bug** preventing the WebGPU renderer from initializing through `Viewer.createAsync()`.

---

## 6. Feature Renderer Wiring — ✅ 28 of 28 Scene Files

All scene files have been migrated to the `getFeatureRenderer()` pattern:

| Scene File | FeatureRendererKey | Routing Pattern |
|---|---|---|
| Primitive.js | `PRIMITIVE` | Skip WebGL RS/SP, create commands via FR |
| PointPrimitiveCollection.js | `POINT_PRIMITIVE_COLLECTION` | Early return from update() |
| BillboardCollection.js | `BILLBOARD_COLLECTION` | Early return from update() |
| PolylineCollection.js | `POLYLINE_COLLECTION` | Early return from update() |
| CloudCollection.js | `CLOUD_COLLECTION` | Early return from update() |
| Globe.js | `GLOBE_SURFACE` | Swap globe surface renderer |
| Model.js | `MODEL` | Early return from update() |
| SkyAtmosphere.js | `SKY_ATMOSPHERE` | Early return from update() |
| Sun.js | `SUN` | Early return from update() |
| Moon.js | `MOON` | Early return from update() |
| SkyBox.js | `CUBE_MAP_PANORAMA` | Early return from update() |
| ShadowMap.js | `SHADOW_MAP` | Shadow map init/render |
| GroundPrimitive.js | `GROUND_PRIMITIVE` | Command creation |
| GlobeTranslucencyState.js | `GLOBE_TRANSLUCENCY` | Derived commands |
| EllipsoidPrimitive.js | `ELLIPSOID_PRIMITIVE` | Early return from update() |
| GaussianSplatCollection.js | `GAUSSIAN_SPLAT` | Early return from update() |
| TimeDynamicPointCloud.js | `POINT_CLOUD` | Early return from update() |
| PointCloudEyeDomeLighting.js | `POINT_CLOUD_EDL` | Early return from update() |
| VoxelPrimitive.js | `VOXEL_PRIMITIVE` | Early return from update() |
| InvertClassification.js | `INVERT_CLASSIFICATION` | Early return from update() |
| Scene.js | `SCENE_RENDERER` | Alternate scene renderer |
| + 7 infrastructure FRs | IBL, SSR, WEATHER, POST_PROCESS, GROUND_ATMOSPHERE, IMAGERY_REPROJECTION, CLIPPING_POLYGON | Various |

---

## 7. Upstream Status — ✅ SYNCED (April 2, 2026)

### Second Sync: PR #13121 (Constant LOD) — 45 commits, ZERO conflicts
Merged `upstream/main` (45 new commits since first sync — all from PR #13121 `daniel/constant_lod`).
- **0 commits behind** upstream
- **25 commits ahead** (24 WebGPU additions + 1 merge commit)
- **Two-parent merge commit** verified: `cd3f206c39` + `0becdbfc17`
- **ZERO conflicts** — clean auto-merge by `ort` strategy
- Build passes (exit code 0)

**New upstream feature (Constant LOD):**
- `computeTextureTransform.glsl` — new `czm_computeTextureTransform()` builtin function for `KHR_texture_transform`
- `ConstantLodStageFS.glsl` + `ConstantLodStageVS.glsl` — distance-based constant LOD texture lookup for models
- `MaterialPipelineStage.js` — new `processConstantLod()` function, `u_constantLodDistance` uniform
- `MaterialStageFS.glsl` — constant LOD texture lookup integration
- 12 test glTF models + sandcastle demo + unit tests

**Our modifications preserved through merge:**
- ✅ `InstancingPipelineStage.js` line 77: `|| frameState.context.isWebGPU` (keepTypedArray for WebGPU)
- ✅ `SkinningPipelineStage.js` line 5: `extractSkinData` from `ModelSkinData.js` (shared extraction layer)
- ✅ `LightingStageFS.glsl`: Full multi-light system (`czm_unpackLight`, `computeAdditionalLightPBR`, `czm_lightsData`)

**WGSL equivalents needed (low priority — model pipeline handles these differently):**
- `computeTextureTransform.glsl` → inline helper when texture transform support added to `ModelPBRComplete.wgsl`
- `ConstantLodStageFS/VS.glsl` → when constant LOD extension support added to WebGPU model path

### First Sync: v1.135–v1.140 — 507 commits, 12 conflicts
- **12 conflicts resolved** (17 potential, 5 auto-merged)

### Key Upstream Changes Incorporated

| Version | Notable Changes |
|---------|----------------|
| **v1.140** | BufferPrimitive collections (vector tile APIs), Billboards WebGL2 requirement, Gaussian splat perf, ClippingPolygon GPU perf |
| **v1.139** | **Cartesian2/3/4 ES6 classes** (aligned with our modernization), CubeMapPanorama, metadata in custom shaders |
| **v1.138** | Intel Arc GPU jitter fix, Megatexture→Texture3D for voxels, 2D/CV pick fixes |
| **v1.137** | BENTLEY point/line style extensions, edge visibility quad rendering, pickAsync |
| **v1.136** | pickAsync, terrain picking quadtrees |
| **v1.135** | 3D Tiles terrain provider, EXT_mesh_primitive_edge_visibility |

### Conflict Resolution Summary

| File | Strategy | Details |
|------|----------|---------|
| `package.json` (4) | Accept upstream versions, keep our additions | `@webgpu/types`, `lint-staged`, `build-wasm` scripts |
| `Context.js` | Keep ours (ES6 class) | Upstream only had JSDoc change |
| `VertexArray.js` | Keep ours + add new methods | Added `copyAttributeFromRange()`, `copyIndexFromRange()` |
| `SkyBox.js` | Keep ours + apply fix | Applied upstream's `show` delegation to `_panorama.show` |
| `SSCCModeHandlers.js` | Apply upstream zoom fix | Camera zoom guard for tracking/lookAt mode |
| `Material.js`, `RenderState.js` | Keep ours | Upstream only JSDoc changes |
| `CubeMapPanorama.js` | Keep ours | Upstream Matrix4→Matrix3 JSDoc, compatible |
| `StaticGeometry*Batch.js` | Keep ours | Upstream constructor-call refactor, not needed for class |

### New Upstream GLSL Shaders (7 new files)

| GLSL Shader | Feature | WGSL Equivalent? | Priority |
|---|---|---|---|
| `BufferPointMaterialFS/VS.glsl` | Vector tile points | ❌ Not yet needed | 🟢 When vector tiles WebGPU path added |
| `BufferPolygonMaterialFS/VS.glsl` | Vector tile polygons | ❌ Not yet needed | 🟢 When vector tiles WebGPU path added |
| `BufferPolylineMaterialFS/VS.glsl` | Vector tile polylines | ❌ Not yet needed | 🟢 When vector tiles WebGPU path added |
| `EdgeVisibilityStageVS.glsl` | Edge visibility (glTF ext) | ❌ Not yet needed | 🟢 When edge visibility WebGPU path added |

These are NEW upstream features — not backport gaps. They'll need WGSL equivalents when we add WebGPU rendering paths for vector tiles and edge visibility.

---

## 8. Prioritized Action Plan

### Immediate (This Week)
1. ✅ **Viewer._preInitializedScene bug** — Fixed
2. **End-to-end smoke test** — Launch `Apps/WebGPUTest/` pages, verify rendering works
3. **Build verification** — `npm run build` to ensure all new WGSL JS wrappers are generated

### Short Term (1-2 Weeks)
4. **Jasmine smoke tests** — Start with WebGPUContext, WebGPUBuffer, WebGPUTexture, WebGPUDrawCommand
5. **FORK-45** — Per-bridge WASM arena slots (prevents cross-bridge data corruption under parallelism)
6. **Console noise reduction** — ~12 bare console.warn/error → context-aware logging

### Medium Term (2-4 Weeks)  
7. **Activate render bundles for terrain** — Wire into globe pass (50-80% CPU reduction)
8. **Activate GPU frustum culling** — Wire GPUCuller into 3D Tiles for >50K objects
9. **Pipeline warm-up** — Pre-create common pipelines at init to avoid first-frame stutter
10. **Uniform ring buffer** — Replace per-frame buffer creation (60-80% less GPU memory churn)

### Longer Term
11. **Upstream sync** — 481 commits behind
12. **Activate remaining compute shaders** as their consumer systems are tested
13. **Shadow casting** — Complete shadow map render pipeline
14. **TAA** — Temporal anti-aliasing post-process

---

## Appendix: Initialization Chain Verification

```
Viewer.createAsync(container, { contextOptions: { renderer: 'webgpu' } })
  │
  ├─ Creates LoadingOverlay
  ├─ CesiumWidget.createAsync(tempDiv, options, onProgress)
  │   ├─ Scene.createAsync(canvas, options)
  │   │   ├─ ContextFactory.createContext(canvas, { renderer: 'webgpu' })
  │   │   │   ├─ navigator.gpu.requestAdapter()
  │   │   │   ├─ adapter.requestDevice({ requiredFeatures: [...] })
  │   │   │   └─ new WebGPUContext(canvas, device, adapter)
  │   │   │       ├─ _initialize() — creates default texture, sampler, depth format
  │   │   │       ├─ registerWebGPUFeatureRenderers(context) — all 28 FRs
  │   │   │       └─ Matrix4.setDepthRangeType('webgpu') — 0-1 NDC
  │   │   └─ new Scene(options) with _preInitializedContext
  │   └─ new CesiumWidget(container, { _preInitializedScene: scene })
  │       └─ Uses pre-created scene (skips sync Scene creation)
  │
  ├─ new Viewer(container, { ...options, _preInitializedScene: widget.scene })
  │   └─ new CesiumWidget(cesiumWidgetContainer, { ..., _preInitializedScene })  ← FIXED
  │       └─ Uses pre-created scene
  │
  └─ Removes LoadingOverlay

Rendering: Scene.render() → uniformState.update() → SceneRenderer.executeCommands()
  ├─ renderEnvironment() → sky box, atmosphere, sun, moon, panorama (both backends)
  ├─ _alternateSceneRenderer.executeCommands() → WebGPUSceneRenderer
  │   ├─ performanceManager.beginFrame()
  │   ├─ Multi-frustum loop (far→near):
  │   │   ├─ GLOBE → _executeGlobePass()
  │   │   ├─ TERRAIN_CLASSIFICATION → _executePassCommands()
  │   │   ├─ 3D TILES (4 passes) → _execute3DTilePasses()
  │   │   ├─ OPAQUE → _executeOpaquePass()
  │   │   ├─ VOXELS → _executePassCommands()
  │   │   ├─ GAUSSIAN_SPLATS → _executePassCommands()
  │   │   └─ TRANSLUCENT → _executeTranslucentPass()
  │   ├─ OVERLAY → _executeOverlayPass()
  │   ├─ Environmental effects (SSR, Weather)
  │   ├─ Post-processing (AO → Bloom → DoF → Tonemap → FXAA)
  │   └─ performanceManager.endFrame()
  └─ return (WebGL path skipped)
```

---

*This audit supersedes the March 31, 2026 audit's findings on WASM and compute fallback gaps, which have since been resolved.*
