> **ARCHIVED 2026-05-30** — historical point-in-time snapshot, superseded. NOT a live tracker. Live successors + index: `migration_doc/README.md`. Still-open items were lifted to `DEFERRED_WORK.md` (see its "Carried-forward on archive" section).

# CesiumJS WebGPU — Comprehensive Codebase Audit

**Date:** March 31, 2026  
**Scope:** Compute shader & WASM fallback verification, missing features & rendering techniques, performance opportunities  

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Compute Shader Fallback Audit](#2-compute-shader-fallback-audit)
3. [WASM Bridge Fallback Audit](#3-wasm-bridge-fallback-audit)
4. [Missing Rendering Features & Visual Improvements](#4-missing-rendering-features--visual-improvements)
5. [Missing GLSL→WGSL Shaders](#5-missing-glslwgsl-shaders)
6. [Performance Improvement Opportunities](#6-performance-improvement-opportunities)
7. [WebGPU API Features Not Yet Leveraged](#7-webgpu-api-features-not-yet-leveraged)
8. [Recommended Priority Roadmap](#8-recommended-priority-roadmap)

---

## 1. Executive Summary

### Critical Findings

| Area | Status | Severity | Resolution |
|------|--------|----------|------------|
| **Compute shader fallbacks** | ✅ **FIXED** | High | `WebGPUComputeEngine` wrapped in try/catch, returns bool, `_validateWorkgroups()` added. CPU fallbacks in `WasmPointCloudBridge` (FORK-42/43/44) |
| **WASM bridge fallbacks** | ✅ **FIXED** | Medium | All 7 bridges: `destroy()`, `free_buffer()`, SIMD detection, version check via `WasmFeatureDetection.js` (FORK-37/38/39/40) |
| **WASM memory management** | ✅ **FIXED** | High | All bridges call `free_buffer()` in `destroy()`. Rust `alloc_buffer()` uses `try_reserve()` + null-on-OOM (FORK-46) |
| **Missing post-processing** | ✅ **FIXED** | High | SSAO (4-pass HBAO), Bloom (4-pass), DoF (3-pass), Edge Detection, Silhouette, 5 tonemapping operators, GaussianBlur1D |
| **Missing IBL pipeline** | ✅ **FIXED** | High | `BrdfLutGenerate.wgsl` (compute), `IrradianceConvolution.wgsl`, `RadiancePrefilter.wgsl`, `WebGPUIBLPipeline.ts` orchestrator, `WebGPUImageBasedLighting.ts` with SH + specular, `ModelPBRComplete.wgsl` IBL-aware ambient |
| **Missing ground atmosphere** | ✅ **FIXED** | Medium | `GroundAtmosphere.wgsl` (Nishita scattering), `WebGPUGroundAtmosphereRenderer.ts`, `FeatureRendererKey.GROUND_ATMOSPHERE` registered |
| **Performance infrastructure** | ✅ **ACTIVATED** | Medium | `WebGPUPerformanceManager.ts` orchestrates all 7 systems via `beginFrame()/endFrame()` in scene renderer |
| **Shader coverage** | ✅ ~76% file coverage (234 WGSL vs 309 GLSL), ~95% functional coverage | Resolved | All 89 GLSL builtin functions ported (90 WGSL chunks). All 26 post-process shaders ported. All Appearances covered by Primitive architecture. Model stages covered by ModelPBRComplete.wgsl + 7 stage shaders. Classification, Voxel, ViewportQuad, CloudNoise all ported. 96 CsmBuiltins.js entries. |
| **Night rendering** | ✅ **ENHANCED** | High | Lambert terminator, emissive city lights, moonlit night side, terminator glow |
| **Ocean/Water rendering** | ✅ **ENHANCED** | High | Fresnel, GGX specular, multi-octave waves, foam/whitecaps, subsurface scattering, deep water color, sky reflection |
| **Screen-Space Reflections** | ✅ **Wired** | Medium | `ScreenSpaceReflections.wgsl` — ray march + binary refinement. Pipeline wired via `_executeEnvironmentalEffects()` in `WebGPUSceneRenderer.ts`. Activated by `scene._enableSSR = true` |
| **Weather Particle System** | ✅ **Wired** | Medium | `WeatherParticles.wgsl` — rain/snow/fog/hail via GPU compute. Pipeline wired via `_executeEnvironmentalEffects()`. Activated by `scene._enableWeather = true` |

### What Works Well
- ✅ All 7 WASM bridges have complete JS fallback implementations
- ✅ `GraphicsContext` defines a 3-tier compute capability hierarchy (GPGPU → Compute → Advanced)
- ✅ `WebGPUPerformanceManager` has `getRecommendedApproach()` for GPU/WASM/JS decision
- ✅ Feature renderer pattern isolates all WebGPU-specific code behind `getFeatureRenderer()`
- ✅ RTE precision implemented correctly across all shaders

---

## 2. Compute Shader Fallback Audit

### Dispatch Status: Only 1 of 8 Shaders Is Actually Called

| # | Shader | Dispatched? | By What? | Has Non-Compute Fallback? |
|---|--------|-------------|----------|--------------------------|
| 1 | `PolygonSignedDistance.wgsl` | ✅ Yes | `WebGPUClippingPolygonCollection.ts` (inline dispatch) | ✅ WebGL SDF texture fallback |
| 2 | `FrustumCull.wgsl` | ❌ No | `WebGPUGPUCuller.ts` exists but nobody calls it | ✅ `WasmCullBridge.js` JS fallback |
| 3 | `HiZPyramid.wgsl` | ❌ No | `OcclusionCulling.js` references it but GPU resources are stubs | ⚠️ Conservative "assume visible" fallback |
| 4 | `OcclusionTest.wgsl` | ❌ No | Same as HiZPyramid — wired into `OcclusionCulling.js` but stubs | ⚠️ Conservative "assume visible" fallback |
| 5 | `AtmosphereLUT.wgsl` | ❌ No | `WebGPUPerformanceManager` imports string, nobody calls dispatch | ✅ Per-pixel ray marching in `SkyAtmosphere.wgsl` (slower but works) |
| 6 | `PointCloudSort.wgsl` | ❌ No | `WebGPUPerformanceManager` imports string, nobody calls dispatch | ⚠️ No explicit fallback — point clouds render unsorted |
| 7 | `PointCloudLOD.wgsl` | ❌ No | `WebGPUPerformanceManager` imports string, nobody calls dispatch | ⚠️ No explicit fallback — all points rendered (no LOD) |
| 8 | `GPUSortKeys.wgsl` | ❌ No | `WebGPUPerformanceManager` imports string, nobody calls dispatch | ✅ JS multi-level comparators in Scene.js (always active) |

### What Happens When Compute Is Unavailable

**Current architecture (`GraphicsContext.ts` 3-tier model):**
```
Tier 2: supportsIndirectCompute = true  → indirect dispatch, shared memory, atomics
Tier 1: supportsComputeShaders = true   → real compute shaders
Tier 0: supportsGPGPU = true            → fragment-shader GPGPU (render-to-texture)
None:   CPU fallback                    → JS or WASM
```

**WebGPU context always reports Tier 1+** when `_device !== null` — this is correct since ALL WebGPU implementations support compute shaders (it's a mandatory part of the WebGPU spec, unlike WebGL).

**The real risk is NOT "WebGPU without compute"** (impossible by spec) **but rather:**
1. A user on WebGL (no compute at all) — handled by `getFeatureRenderer()` returning null
2. A compute pipeline failing to compile — **NO error handling exists** in `WebGPUComputeEngine.execute()`
3. A device with low `maxComputeWorkgroupsPerDimension` — **NO limit checking** before dispatch

### Issues Found

| ID | Issue | Severity | Fix |
|----|-------|----------|-----|
| **CS-1** | 7 compute shaders have infrastructure but zero callers | 🟡 Medium | Wire dispatch into render pipeline or document as "available but not active" |
| **CS-2** | `WebGPUComputeEngine.execute()` has no try/catch for pipeline creation failure | 🔴 High | Add error handling with graceful fallback to CPU path |
| **CS-3** | No workgroup limit validation before `dispatchWorkgroups()` | 🟡 Medium | Check `device.limits.maxComputeWorkgroupsPerDimension` |
| **CS-4** | `AtmosphereLUT` dispatch method in `WebGPUPerformanceManager` creates pipeline but is never called | 🟢 Low | The per-pixel fallback (SkyAtmosphere.wgsl ray marching) works fine — LUT is a perf optimization only |
| **CS-5** | `PointCloudSort`/`PointCloudLOD` have no CPU fallback when GPU compute fails | 🟡 Medium | Need JS-side sort and distance-based LOD fallback in point cloud renderer |
| **CS-6** | `WebGPUPerformanceManager.dispatchCompute()` generic method caches pipelines by task string but never validates bind group compatibility | 🟡 Medium | Add bind group layout validation |

### Recommendations for Compute Shader Fallbacks

1. **Wrap all compute dispatch in try/catch** — if pipeline creation fails, fall back to WASM/JS:
   ```typescript
   try {
     computeEngine.execute(command);
   } catch (e) {
     context.log('warn', `Compute dispatch failed: ${e.message}, falling back to CPU`);
     wasmBridge.process(data); // or JS fallback
   }
   ```

2. **Create `ComputeFallbackDispatcher` utility** that encapsulates the 3-tier decision:
   ```typescript
   dispatcher.dispatch('frustumCull', {
     gpuCompute: () => gpuCuller.dispatch(spheres, planes),
     wasmFallback: () => wasmCullBridge.cull(spheres, planes),
     jsFallback: () => jsFrustumCull(spheres, planes),
   });
   ```

3. **For the 4 new compute shaders** (AtmosphereLUT, PointCloudSort, PointCloudLOD, GPUSortKeys), either:
   - Wire them into the actual render pipeline with callers, OR
   - Remove the dead `dispatchCompute()` infrastructure from `WebGPUPerformanceManager` to avoid confusion

---

## 3. WASM Bridge Fallback Audit

### Bridge Pattern Compliance

| Bridge | JS Fallback | Async Load | Threshold | Version Check | SIMD Detection | getDiagnostics | free_buffer |
|--------|-------------|------------|-----------|---------------|----------------|----------------|-------------|
| `WasmCullBridge` | ✅ Full | ✅ | ✅ 500 | ❌ | ❌ | ✅ | ❌ Never called |
| `WasmSortBridge` | ✅ Full | ✅ | ✅ 5000 | ❌ | ❌ | ✅ | ❌ Never called |
| `WasmHeightmapBridge` | ✅ Full | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ Never called |
| `WasmQuantizedMeshBridge` | ✅ Full | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ Never called |
| `WasmRTEBridge` | ✅ Full | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ Never called |
| `WasmMatrixBridge` | ✅ Full | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ Never called |
| `WasmPointCloudBridge` | ✅ Full | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ Never called |

### Issues Found

| ID | Issue | Severity | Details |
|----|-------|----------|---------|
| **WASM-1** | **Zero bridges call `free_buffer()`** | 🔴 High | The Rust arena allocator `alloc_buffer()` is called per frame but `free_buffer()` is never called. Memory grows to high-water-mark and stays there. WASM linear memory pages (64KB each) are never returned to OS. |
| **WASM-2** | **No version checking** | 🟡 Medium | `.clinerules` mandates `wasm.version()` check on load with warning if mismatch. Zero bridges implement this. The Rust `lib.rs` has `pub fn version() -> u32` returning `2`, but no bridge calls it. |
| **WASM-3** | **No SIMD feature detection** | 🟡 Medium | `.clinerules` mandates `WebAssembly.validate()` with SIMD test bytes before loading SIMD-enabled modules. Zero bridges do this. If SIMD is unavailable, WASM load silently fails and falls back to JS — this works but misses the detection step. |
| **WASM-4** | **Single global arena** | 🟡 Medium | All 7 bridges share one `Mutex<Vec<u8>>` arena. If two bridges run in the same frame, the second `alloc_buffer()` call overwrites the first's data. Works today because bridges run sequentially, but fragile for future parallelism. |
| **WASM-5** | **No OOM handling** | 🟡 Medium | `alloc_buffer()` calls `arena.resize(size, 0)` which can panic on OOM. Should return null/0 and let the bridge fall back to JS. |
| **WASM-6** | **Arena uses `Vec::resize()` not `Vec::reserve()`** | 🟢 Low | `resize()` zero-fills memory unnecessarily. Should use `reserve()` + `set_len()` for the allocation (the JS side will overwrite all bytes anyway). |
| **WASM-7** | **No bridge has `destroy()` method** | 🟡 Medium | When a `Viewer` is destroyed, WASM modules and their memory are never cleaned up. Should at minimum call `free_buffer()` and drop references. |

### Recommendations for WASM Bridges

1. **Add `free_buffer()` calls** — Either call after each operation or on a periodic cleanup timer:
   ```javascript
   cull(spheres, planes) {
     try {
       const ptr = this._wasm.alloc_buffer(size);
       // ... do work ...
       return result;
     } finally {
       this._wasm.free_buffer(); // Always free after use
     }
   }
   ```

2. **Add version checking to `loadWasm()`**:
   ```javascript
   const EXPECTED_VERSION = 2;
   const actual = this._wasm.version();
   if (actual !== EXPECTED_VERSION) {
     console.warn(`[CesiumJS] WASM version mismatch: expected ${EXPECTED_VERSION}, got ${actual}`);
   }
   ```

3. **Add SIMD detection**:
   ```javascript
   static _simdSupported = null;
   static checkSIMD() {
     if (this._simdSupported === null) {
       // SIMD test bytes: (module (func (result v128) v128.const i32x4 0 0 0 0))
       const simdBytes = new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11]);
       this._simdSupported = WebAssembly.validate(simdBytes);
     }
     return this._simdSupported;
   }
   ```

4. **Add `destroy()` method to all bridges** — called from `Viewer.destroy()`:
   ```javascript
   destroy() {
     if (this._wasm) {
       this._wasm.free_buffer();
       this._wasm = null;
       this._wasmReady = false;
     }
   }
   ```

---

## 4. Missing Rendering Features & Visual Improvements

### vs. Other WebGPU Engines (Babylon.js, Three.js, PlayCanvas, Filament, Bevy)

#### 🔴 Critical Missing — Available in ALL Major WebGPU Engines

| Feature | Babylon.js | Three.js | PlayCanvas | Our Status | Impact |
|---------|-----------|----------|------------|------------|--------|
| **Screen-Space Ambient Occlusion (SSAO/HBAO+)** | ✅ SSAO2 | ✅ SSAOPass | ✅ | ❌ Missing | Major visual quality difference — adds depth/realism to all scenes |
| **Screen-Space Reflections (SSR)** | ✅ | ✅ | ✅ | ❌ Missing | Important for water, glass, metallic surfaces |
| **Bloom/Glow** | ✅ | ✅ UnrealBloomPass | ✅ | ❌ Missing | Standard post-process for bright surfaces, lights, sun |
| **Depth of Field (DoF)** | ✅ | ✅ BokehPass | ✅ | ❌ Missing | Cinematic quality for close-up/miniature views |
| **Temporal Anti-Aliasing (TAA)** | ✅ | ✅ | ✅ | ❌ Missing | Far superior to FXAA for moving scenes |
| **Image-Based Lighting (IBL) pipeline** | ✅ Full | ✅ Full | ✅ Full | ❌ No BRDF LUT gen, no irradiance/radiance convolution in WGSL | PBR models look flat without environment lighting |
| **Tone mapping (advanced)** | ✅ 6+ operators | ✅ 5+ operators | ✅ | ⚠️ Basic only | ACES, Khronos PBR Neutral, AgX are standard now |
| **Shadow mapping (cast side)** | ✅ Full | ✅ Full | ✅ Full | ⚠️ Receive only | Objects can receive shadows but not cast them in WebGPU path |

#### 🟡 Important Missing — Available in Most WebGPU Engines

| Feature | Industry Status | Our Status | Impact |
|---------|----------------|------------|--------|
| **Volumetric Lighting/Fog** | Babylon, Three.js, Unreal | ❌ Missing | God rays, volumetric clouds, atmospheric scattering |
| **Motion Blur** | Babylon, Three.js | ❌ Missing | Cinematic quality for camera/object movement |
| **Color Grading / LUT** | Babylon, Three.js | ❌ Missing | Film-quality color correction |
| **Cascaded Shadow Maps (CSM)** | Standard in all engines | ❌ Missing | Efficient shadow rendering for large outdoor scenes |
| **Contact Shadows** | Babylon, Three.js | ❌ Missing | Small-scale ground contact shadows |
| **Subsurface Scattering (SSS)** | Babylon, Filament | ❌ Missing | Realistic skin, foliage, marble rendering |
| **GPU Particle System** | Babylon, Three.js, PlayCanvas | ❌ Missing | Compute-based particles — fire, smoke, rain, snow |
| **Clustered/Tiled Deferred Lighting** | Standard | ❌ Missing | Efficient many-lights rendering (our multi-light is brute force) |
| **Light Probes / SH Lighting** | Standard | ❌ Missing | Pre-baked indirect lighting |
| **Parallax Occlusion Mapping** | Standard | ❌ Missing | Adds depth to flat surfaces without extra geometry |

#### 🟢 Nice to Have — Cutting-Edge Features

| Feature | Who Has It | Our Status | Notes |
|---------|-----------|------------|-------|
| **Ray Tracing (WebGPU extension)** | Babylon (experimental) | ❌ | Not in WebGPU spec yet, but coming |
| **Nanite-Style Virtualized Geometry** | Unreal 5, Bevy experiments | ❌ | Mesh shaders not in WebGPU yet |
| **Global Illumination (Lumen-style)** | Unreal 5 | ❌ | Extremely complex, not practical for web |
| **Variable Rate Shading (VRS)** | DirectX 12, Vulkan | ❌ | Not in WebGPU spec |
| **Mesh Shaders** | DirectX 12, Vulkan | ❌ | Not in WebGPU spec yet — Google has proposals |
| **Neural Rendering (NeRF/3DGS beyond current)** | Emerging | ⚠️ Gaussian Splatting exists | Could expand to NeRF |
| **Procedural Sky / Dynamic Clouds** | Babylon, Unreal | ⚠️ Static atmosphere only | No volumetric clouds |
| **Ocean/Water Rendering (FFT)** | Three.js, Unreal | ⚠️ Simple wave normals | No FFT ocean simulation |
| **Terrain Tessellation (GPU)** | Standard in native engines | ❌ | WebGPU has no tessellation stage — use compute + indirect |

### CesiumJS-Specific Missing Features

| Feature | Why Important for CesiumJS | Effort | Priority |
|---------|---------------------------|--------|----------|
| **Ground atmosphere** | Visual haze near horizon — GLSL shader exists, no WGSL | 1-2 days | 🔴 High |
| **Silhouette/Outline rendering** | Entity highlighting — GLSL exists, no WGSL | 1-2 days | 🟡 Medium |
| **Night lights imagery** | City lights on dark side — GLSL compositing exists | 1 day | 🟡 Medium |
| **OIT (true order-independent transparency)** | Correct translucent rendering — MRT derived pipelines needed | 2-3 days | 🟡 Medium |
| **Per-feature styling (3D Tiles)** | Color by property, show/hide by expression — partially done | 2-3 days | 🟡 Medium |
| **Procedural textures for globe** | Cloud layers, aurora — future CesiumJS feature | 3-5 days | 🟢 Low |
| **Terrain blend/splat mapping** | Multi-texture terrain at close range | 3-5 days | 🟢 Low |
| **Vector tile rendering** | Upstream #2132 — largest open request | 5-10 days | 🟢 Low |

---

## 5. Missing GLSL→WGSL Shaders

### Post-Processing (Highest Visual Impact — 26 missing)

| GLSL Shader | Feature | Visual Impact | WGSL Exists? |
|-------------|---------|---------------|--------------|
| `AmbientOcclusion.glsl` | SSAO | 🔴 High | ❌ |
| `AmbientOcclusionModulate.glsl` | SSAO application | 🔴 High | ❌ |
| `AmbientOcclusionGenerate.glsl` | SSAO generation | 🔴 High | ❌ |
| `Bloom.glsl` / `BloomComposite.glsl` | Bloom/glow | 🔴 High | ❌ |
| `GaussianBlur1D.glsl` | Blur (used by many effects) | 🔴 High | ❌ |
| `DepthOfField.glsl` | Depth of field | 🟡 Medium | ❌ |
| `Silhouette*.glsl` (4 files) | Edge detection / silhouette | 🟡 Medium | ❌ |
| `LensFlare.glsl` | Lens flare | 🟡 Medium | ❌ |
| `NightVision.glsl` | Night vision effect | 🟢 Low | ❌ |
| `BlackAndWhite.glsl` | B&W filter | 🟢 Low | ❌ |
| `Brightness.glsl` | Brightness adjustment | 🟢 Low | ❌ |
| `ContrastBias.glsl` | Contrast adjustment | 🟢 Low | ❌ |
| `EdgeDetection*.glsl` | Edge detection | 🟢 Low | ❌ |
| `FilmicTonemapping.glsl` | Advanced tone mapping | 🟡 Medium | ❌ |
| `ModifiedReinhardTonemapping.glsl` | Reinhard tone mapping | 🟡 Medium | ❌ |
| `AcesTonemapping.glsl` | ACES tone mapping | 🟡 Medium | ❌ |
| `PbrNeutralTonemapping.glsl` | Khronos PBR Neutral TM | 🟡 Medium | ❌ |

### IBL Pipeline (Critical for PBR Quality — 5 missing)

| GLSL Shader | Feature | WGSL? |
|-------------|---------|-------|
| `BrdfLutGeneratorFS.glsl` | BRDF integration LUT for split-sum IBL | ❌ |
| `ComputeIrradianceFS.glsl` | Diffuse irradiance cubemap convolution | ❌ |
| `ComputeRadianceMapFS.glsl` | Specular radiance cubemap | ❌ |
| `ConvolveSpecularMapFS/VS.glsl` | Pre-filtered environment mipchain | ❌ |

### Environment / Atmosphere (3 missing)

| GLSL Shader | Feature | WGSL? |
|-------------|---------|-------|
| `GroundAtmosphereFS/VS.glsl` | Ground-level atmosphere haze | ❌ |
| `AtmosphereCommon.glsl` | Shared atmosphere utilities | ❌ (partially in SkyAtmosphere.wgsl) |

### OIT (2 missing for true OIT)

| GLSL Shader | Feature | WGSL? |
|-------------|---------|-------|
| `AdjustTranslucentFS.glsl` | OIT weighted blended | ❌ |
| `CompareAndPackTranslucentDepth.glsl` | OIT depth packing | ❌ |

### Builtin Functions (56 missing, ~20 important)

| GLSL Function | What It Does | Priority |
|----------------|-------------|----------|
| `czm_luminance` | Perceptual brightness | 🔴 Used by SSAO, bloom, tone mapping |
| `czm_saturation` | Color saturation | 🟡 Color grading |
| `czm_HSBToRGB` / `czm_RGBToHSB` | Color space conversion | 🟡 |
| `czm_phong` | Phong lighting model | ⚠️ Covered by custom impl in shaders |
| `czm_fog` | Fog application | ⚠️ Inline in GlobeTerrain.wgsl |
| `czm_writeDepthClamp` | Depth clamping | 🟡 |
| `czm_antialias` | Edge antialiasing | 🟢 |
| `czm_cascadeWeights` / `czm_cascadeMatrix` | CSM utilities | 🟡 When CSM is added |
| `czm_sampleOctahedralProjection` | Octahedral environment map | 🟡 When IBL pipeline is added |
| `czm_computeScattering` | Atmosphere scattering | ⚠️ Covered in SkyAtmosphere.wgsl |
| ~36 others | Various math/utility | 🟢 On-demand as needed |

---

## 6. Performance Improvement Opportunities

### 6a. Compute Shader Activation (Built But Dormant)

| Feature | Current State | Expected Benefit | Effort to Activate |
|---------|--------------|------------------|--------------------|
| **GPU Frustum Culling** | `WebGPUGPUCuller.ts` fully built, `FrustumCull.wgsl` exists, `PerformanceManager.shouldUseGPUCulling()` exists | 5-20x for >50K objects (3D Tiles) | 2-3 days — wire into `Cesium3DTileset.update()` |
| **Hi-Z Occlusion Culling** | `HiZPyramid.wgsl` + `OcclusionTest.wgsl` + `OcclusionCulling.js` all exist | 30-70% draw call reduction in dense city scenes | 3-4 days — wire into `ViewportExecutor` (partially done) |
| **Render Bundles** | `WebGPURenderBundleManager.ts` fully built with LRU eviction | 50-80% CPU reduction for static terrain | 2-3 days — wire into globe pass in `WebGPUSceneRenderer` |
| **Indirect Drawing** | `WebGPUIndirectDrawManager.ts` fully built | GPU-driven rendering, fewer CPU draw calls | 3-4 days — wire into 3D Tiles pass |
| **Atmosphere LUT** | `AtmosphereLUT.wgsl` compute shader exists | Replace per-pixel ray marching with LUT fetch | 2-3 days — create dispatch pipeline, bake on scene init |

### 6b. WASM Opportunities (New Modules)

| Target | Current Approach | WASM Benefit | Estimated Speedup | Effort |
|--------|-----------------|-------------|-------------------|--------|
| **glTF decode** | JS in `GltfLoader.js` | SIMD accessor decode, mesh optimization | 2-4x for large models | 3-5 days |
| **Batch transform update** | JS per-entity `Matrix4.multiply` | SIMD f32x4 batch multiply | 3-5x for >1K entities | 2-3 days (partially done in `matrix_batch.rs`) |
| **Terrain mesh stitching** | JS in `TerrainMesh.js` | SIMD edge matching, skirt generation | 2-3x | 2-3 days |
| **Quadtree traversal** | JS in `QuadtreePrimitive.js` | Batch tile selection with SOA layout | 2-3x for deep quadtrees | 3-4 days |
| **3D Tiles traversal** | JS in `Cesium3DTilesetTraversal.js` | Batch bounding volume tests | 3-5x for large tilesets | 4-5 days |
| **KTX2 super-decompression** | WASM `basis_transcoder` already exists | Add ASTC/ETC2 → BC transcode for WebGPU | 1.5-2x memory savings | 2-3 days |

### 6c. Compute Shader Opportunities (New Shaders)

| Target | Benefit | Workgroup Pattern | Effort |
|--------|---------|-------------------|--------|
| **BRDF LUT generation** | One-time compute, replaces fragment shader GPGPU | 256×256 dispatch, 16×16 workgroups | 1-2 days |
| **Irradiance convolution** | One-time per environment map change | 6×32×32 dispatches for cubemap faces | 2-3 days |
| **Specular mipchain** | Pre-filtered environment map for PBR | Per-mip dispatch with roughness param | 2-3 days |
| **Terrain LOD selection** | GPU-side tile visibility + LOD decision | 1D dispatch over tile array | 2-3 days |
| **3D Tile GPU culling** | Bounding volume hierarchy test on GPU | Hierarchical dispatch | 3-4 days |
| **Particle simulation** | Fire, smoke, rain, snow via compute | Update + emit + compact pattern | 3-5 days |
| **Ocean FFT** | Realistic water simulation | 2D FFT butterfly dispatches | 4-5 days |
| **Gaussian Splat sort** | Real-time depth sorting for splats | Radix sort on GPU (similar to PointCloudSort) | 2-3 days |

### 6d. Architecture-Level Performance

| Opportunity | Current State | Expected Benefit | Effort |
|------------|--------------|------------------|---------| 
| **Uniform buffer ring allocation** | New `GPUBuffer` per draw command per frame | Zero per-frame buffer creation, 60-80% less GPU memory churn | 3-4 days |
| **Bind group caching** | Recreated frequently | Cache by content hash → 50% fewer bind group creations | 2-3 days |
| **Pipeline warm-up** | Pipelines created on first use (causes stutter) | Pre-create common pipelines at init → no first-frame stutter | 1-2 days |
| **Texture atlas consolidation** | Separate textures per billboard/point | Single atlas → fewer bind group switches → 30-50% fewer draw calls | 3-4 days |
| **Command buffer reuse** | New encoder per frame | Double-buffer command encoders | 1-2 days |
| **Subgroup operations** | Not used (feature detected but unused) | 2-4x for reduction operations (occlusion, histogram) | 2-3 days |
| **Multi-draw indirect** | Individual `drawIndirect()` calls in loop | Single `multiDrawIndirect()` call (if available) | 1-2 days |

---

## 7. WebGPU API Features Not Yet Leveraged

### Already Detected, Not Used

| WebGPU Feature | Detection Status | Usage Status | Opportunity |
|----------------|-----------------|--------------|-------------|
| `shader-f16` | ✅ Requested | ❌ Not used | Half-precision math in shaders → 2x bandwidth, 2x ALU throughput on supported GPUs |
| `subgroups` | ✅ Requested | ❌ Not used | Warp/wave-level operations for reductions, scans, ballot — 2-4x for parallel reductions |
| `dual-source-blending` | ✅ Requested | ❌ Not used | True OIT without MRT — single-pass weighted blended OIT |
| `indirect-first-instance` | ✅ Requested | ❌ Not used | GPU-driven rendering with per-instance data indexing |
| `bgra8unorm-storage` | ✅ Requested | ❌ Not used | Direct compute write to swap chain format |
| `clip-distances` | ✅ Requested | ❌ Not used | Hardware clipping planes (instead of fragment discard) — better performance for clipping |
| `timestamp-query` | ✅ Wired in profiler | ⚠️ Infrastructure only | Enable for automated perf regression tests |
| `float32-filterable` | ✅ Requested | ⚠️ Used for depth | Could use for HDR texture sampling |

### Not Yet Detected/Requested

| WebGPU Feature | Status | Opportunity |
|----------------|--------|-------------|
| `chromium-experimental-multi-draw-indirect` | Not detected | Single API call for N draw commands — massive CPU reduction |
| `chromium-experimental-read-write-storage-texture` | Not detected | Read-write textures in compute (for in-place image processing) |
| `chromium-experimental-unorm16-texture-formats` | Not detected | 16-bit normalized textures for compact terrain height data |
| WebGPU `GPUExternalTexture` | Not used | Zero-copy video texture import (for video draping on terrain) |

---

## 8. Recommended Priority Roadmap

### Phase 1: Fix Fallback Gaps (1-2 weeks)

| Priority | Task | Effort |
|----------|------|--------|
| 🔴 P0 | Add `free_buffer()` calls to all 7 WASM bridges | 0.5 day |
| 🔴 P0 | Add version checking to all WASM bridges | 0.5 day |
| 🔴 P0 | Add SIMD feature detection to WASM load path | 0.5 day |
| 🔴 P0 | Add `destroy()` method to all WASM bridges | 0.5 day |
| 🔴 P0 | Add try/catch to `WebGPUComputeEngine.execute()` with fallback | 1 day |
| 🟡 P1 | Add CPU fallback paths for PointCloudSort/PointCloudLOD | 1-2 days |
| 🟡 P1 | Add workgroup limit validation to compute dispatch | 0.5 day |
| 🟡 P1 | Document 7 unwired compute shaders in backlog with activation plan | 0.5 day |

### Phase 2: Highest-Impact Visual Improvements (3-4 weeks)

| Priority | Task | Impact | Effort |
|----------|------|--------|--------|
| 🔴 P0 | **SSAO** — Port `AmbientOcclusion*.glsl` → WGSL compute | Major visual quality | 3-4 days |
| 🔴 P0 | **IBL Pipeline** — BRDF LUT + irradiance + radiance in WGSL compute | PBR quality | 3-4 days |
| 🔴 P0 | **Bloom** — Port `Bloom*.glsl` + `GaussianBlur1D.glsl` → WGSL | Standard post-FX | 2-3 days |
| 🔴 P0 | **Ground Atmosphere** — Port `GroundAtmosphere*.glsl` → WGSL | Globe realism | 1-2 days |
| 🟡 P1 | **Advanced Tone Mapping** — ACES, Khronos PBR Neutral, AgX → WGSL | HDR quality | 1-2 days |
| 🟡 P1 | **Shadow Casting** — Complete shadow map render pipeline in WebGPU | Full shadow system | 3-4 days |
| 🟡 P1 | **Depth of Field** — Port → WGSL post-process | Cinematic quality | 2-3 days |
| 🟡 P1 | **TAA** — Implement temporal anti-aliasing as WGSL post-process | Superior to FXAA | 3-4 days |

### Phase 3: Activate Performance Infrastructure (2-3 weeks)

| Priority | Task | Expected Benefit | Effort |
|----------|------|-----------------|--------|
| 🔴 P0 | **Render bundles for terrain** — Wire into globe pass | 50-80% CPU for static tiles | 2-3 days |
| 🔴 P0 | **Uniform ring buffer** — Replace per-frame buffer creation | 60-80% less GPU memory churn | 3-4 days |
| 🟡 P1 | **GPU frustum culling** — Wire `GPUCuller` into 3D Tiles | 5-20x for large tilesets | 2-3 days |
| 🟡 P1 | **Hi-Z occlusion** — Wire into ViewportExecutor | 30-70% draw call reduction | 3-4 days |
| 🟡 P1 | **Indirect drawing** — Wire into 3D Tiles pass | GPU-driven rendering | 3-4 days |
| 🟡 P1 | **Pipeline warm-up** — Pre-create common pipelines at init | No first-frame stutter | 1-2 days |

### Phase 4: Advanced Features (4-6 weeks)

| Priority | Task | Impact | Effort |
|----------|------|--------|--------|
| 🟡 P1 | **SSR** — Screen-space reflections post-process | Reflective surfaces | 3-4 days |
| 🟡 P1 | **Volumetric fog/lighting** — God rays, scattering | Atmosphere quality | 4-5 days |
| 🟡 P1 | **GPU Particle System** — Compute-based particles | Fire, smoke, weather | 3-5 days |
| 🟡 P1 | **Cascaded Shadow Maps** — Efficient outdoor shadows | Shadow quality | 4-5 days |
| 🟢 P2 | **Ocean FFT** — Compute-based water simulation | Water quality | 4-5 days |
| 🟢 P2 | **Clustered lighting** — Efficient many-lights | Urban scenes | 4-5 days |
| 🟢 P2 | **Motion blur** — Velocity buffer post-process | Cinematic quality | 2-3 days |
| 🟢 P2 | **Color grading** — LUT-based color correction | Professional output | 1-2 days |

### Phase 5: WASM Expansion (2-3 weeks)

| Priority | Task | Expected Benefit | Effort |
|----------|------|-----------------|--------|
| 🟡 P1 | **glTF SIMD decode** — Accessor unpacking in WASM | 2-4x model load | 3-5 days |
| 🟡 P1 | **3D Tiles traversal** — Batch BV tests in WASM | 3-5x for large tilesets | 4-5 days |
| 🟢 P2 | **Terrain mesh stitching** — SIMD edge matching | 2-3x terrain update | 2-3 days |
| 🟢 P2 | **Quadtree traversal** — SOA batch selection | 2-3x for deep trees | 3-4 days |

---

## Appendix A: Complete Missing Shader Inventory

### Post-Processing Shaders (26 missing WGSL equivalents)

```
AmbientOcclusion.glsl → MISSING
AmbientOcclusionGenerate.glsl → MISSING  
AmbientOcclusionModulate.glsl → MISSING
BlackAndWhite.glsl → MISSING
Bloom.glsl → MISSING (critical)
BloomComposite.glsl → MISSING (critical)
Brightness.glsl → MISSING
BrightPass.glsl → MISSING
ContrastBias.glsl → MISSING
DepthOfField.glsl → MISSING
DepthView.glsl → MISSING
EdgeDetection.glsl → MISSING
FilmicTonemapping.glsl → MISSING (useful)
GaussianBlur1D.glsl → MISSING (critical — used by bloom, DoF, SSAO)
LensFlare.glsl → MISSING
ModifiedReinhardTonemapping.glsl → MISSING
NightVision.glsl → MISSING
Silhouette*.glsl (4 files) → MISSING (useful for entity highlighting)
AcesTonemapping.glsl → MISSING (critical for HDR)
PbrNeutralTonemapping.glsl → MISSING (critical for PBR)
```

### IBL Shaders (5 missing)
```
BrdfLutGeneratorFS.glsl → MISSING (critical for PBR)
ComputeIrradianceFS.glsl → MISSING (critical for PBR)
ComputeRadianceMapFS.glsl → MISSING (critical for PBR)
ConvolveSpecularMapFS.glsl → MISSING (critical for PBR)
ConvolveSpecularMapVS.glsl → MISSING
```

### Environment Shaders (3 missing)
```
GroundAtmosphereFS.glsl → MISSING (critical for globe)
GroundAtmosphereVS.glsl → MISSING (critical for globe)
AtmosphereCommon.glsl → MISSING (partially covered)
```

### OIT Shaders (2 missing)
```
AdjustTranslucentFS.glsl → MISSING
CompareAndPackTranslucentDepth.glsl → MISSING
```

### Model Pipeline Shaders (~15 missing)
```
ModelFS.glsl → MISSING (general model fragment)
ModelVS.glsl → MISSING (general model vertex)
ModelFlattenVS.glsl → MISSING (2D/CV flattening)
ModelClippingPlanesStageFS.glsl → Covered by EffectsUniforms in WGSL
ModelSilhouetteStageFS/VS.glsl → MISSING (silhouette highlighting)
CustomShader*.glsl (3 files) → MISSING (custom shader pipeline)
```

### Globe Shaders (4 missing)
```
GlobeFS.glsl → Covered by GlobeTerrain.wgsl
GlobeVS.glsl → Covered by GlobeTerrain.wgsl  
GroundAtmosphere*.glsl → MISSING (critical)
OctahedralProjection*.glsl → MISSING (IBL support)
```

---

## Appendix B: Industry Feature Comparison Matrix

| Feature | CesiumJS WebGPU | Babylon.js 7 | Three.js r170 | PlayCanvas 2 | Google Filament | Bevy 0.15 |
|---------|----------------|--------------|---------------|--------------|-----------------|-----------|
| **PBR (metallic-roughness)** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **IBL (full pipeline)** | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **SSAO** | ❌ | ✅ SSAO2 | ✅ | ✅ | ✅ | ✅ |
| **SSR** | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ |
| **Bloom** | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **DoF** | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **TAA** | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Motion Blur** | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ |
| **Shadow Casting** | ⚠️ Receive only | ✅ | ✅ | ✅ | ✅ | ✅ |
| **CSM** | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **GPU Particles** | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ |
| **Volumetric Fog** | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Render Bundles** | ⚠️ Built unused | ✅ | ⚠️ Partial | ✅ | N/A | ✅ |
| **Indirect Draw** | ⚠️ Built unused | ✅ | ⚠️ Partial | ✅ | ✅ | ✅ |
| **Compute Shaders** | ⚠️ 1/8 active | ✅ | ✅ | ✅ | ✅ | ✅ |
| **f16 Shaders** | ⚠️ Detected unused | ⚠️ Partial | ✅ | ❌ | ✅ | ❌ |
| **Subgroups** | ⚠️ Detected unused | ❌ | ❌ | ❌ | N/A | ❌ |
| **64-bit Precision (RTE)** | ✅ Unique | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Multi-Frustum** | ✅ Unique | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Globe Terrain** | ✅ Unique | ❌ | ❌ | ❌ | ❌ | ❌ |
| **GIS Picking** | ✅ Unique | ❌ | ❌ | ❌ | ❌ | ❌ |

**Our unique strengths that NO other WebGPU engine has:**
1. Planetary-scale RTE 64-bit precision
2. Multi-frustum depth management
3. Globe terrain with quadtree LOD
4. GIS-aware picking (height, terrain-aware, voxel/metadata)
5. 25 built-in materials mapped to WGSL
6. 3D Tiles integration (works automatically via Model chain)

---

---

## Appendix C: Weather & Environmental Effects — Industry Comparison

### Weather Effects Available in Major Engines

| Effect | Babylon.js | Three.js | Unreal 5 | Unity URP | Our Status | CesiumJS Relevance |
|--------|-----------|----------|----------|-----------|------------|-------------------|
| **Rain (particle)** | ✅ GPU particles | ✅ via GPUComputationRenderer | ✅ Niagara | ✅ VFX Graph | 🟡 `WeatherParticles.wgsl` created | 🔴 High — Flight sim, city visualization, disaster simulation |
| **Snow (particle)** | ✅ GPU particles | ✅ via GPUComputationRenderer | ✅ Niagara | ✅ VFX Graph | 🟡 `WeatherParticles.wgsl` (type=1) | 🔴 High — Polar/mountain visualization, seasonal modeling |
| **Fog (volumetric)** | ✅ VolumetricScattering | ✅ FogExp2 + VolumetricFog | ✅ ExponentialHeightFog | ✅ Volume fog | ⚠️ Basic distance fog only | 🔴 High — Terrain realism, airport visibility |
| **Volumetric Clouds** | ✅ CloudProcedural | ✅ Community addons | ✅ Volumetric Clouds | ✅ URP Clouds | ❌ Missing | 🟡 Medium — Weather visualization, atmosphere |
| **God Rays / Light Shafts** | ✅ VolumetricLightScattering | ✅ GodRaysPass | ✅ Light Shafts | ✅ | ❌ Missing | 🟡 Medium — Dramatic lighting through clouds |
| **Lightning** | ⚠️ Custom | ⚠️ Custom | ✅ | ⚠️ Custom | ❌ Missing | 🟢 Low — Weather event visualization |
| **Wind (vegetation sway)** | ✅ TreeShaking | ✅ WindShader | ✅ World Position Offset | ✅ | ❌ Missing | 🟢 Low — Vegetation rendering not a CesiumJS focus |
| **Wet surfaces (rain)** | ✅ PBR wetness | ✅ Wetness shader | ✅ Weather layer | ✅ | ❌ Missing | 🟡 Medium — Realistic surface appearance after rain |
| **Puddle accumulation** | ⚠️ Custom | ⚠️ Custom | ✅ | ⚠️ Custom | ❌ Missing | 🟢 Low — Close-up terrain realism |
| **Aurora Borealis** | ⚠️ Custom | ⚠️ Custom | ⚠️ Custom | ⚠️ Custom | ❌ Missing | 🟡 Medium — Polar region atmosphere |
| **Sandstorm / Dust** | ⚠️ Custom | ⚠️ Custom | ✅ Niagara | ⚠️ Custom | ❌ Missing | 🟡 Medium — Desert/Mars visualization |
| **Hail** | ❌ | ❌ | ⚠️ Custom | ❌ | 🟡 `WeatherParticles.wgsl` (type=3) | 🟢 Low — Severe weather simulation |

### Weather Implementation Approaches

| Approach | GPU Cost | Quality | Complexity | Best For |
|----------|---------|---------|------------|----------|
| **CPU Billboard Particles** (current CesiumJS) | Low | Low | Simple | Existing particle system — limited by CPU→GPU transfer |
| **GPU Compute Particles** (our `WeatherParticles.wgsl`) | Medium | High | Medium | Rain, snow, hail — millions of particles at 60fps |
| **Screen-Space Effects** | Low | Medium | Medium | Rain streaks, snow flurries — post-process overlay |
| **Volumetric Ray March** | High | Very High | Complex | Fog, clouds, god rays — physically accurate but expensive |
| **Mesh-Based Clouds** | Low | Low-Medium | Simple | Cloud layers as billboard/mesh — fast but limited |
| **Noise-Based Procedural** | Medium | High | Medium | Cloud generation, aurora — procedural textures on sky dome |

### Our Weather Implementation Status

#### ✅ Created: `WeatherParticles.wgsl` (GPU Compute Shader)
- **4 weather types**: Rain (type 0), Snow (type 1), Fog particles (type 2), Hail (type 3)
- **3 compute passes**: `resetCounters` → `updateParticles` → `emitParticles`
- **Features**: PCG random generation, turbulence noise, gravity/wind simulation, ground collision, camera-relative spawn volume, distance fade, type-specific particle behavior
- **Capacity**: Configurable max particles (default 100K), 256-thread workgroups
- **Status**: Shader complete, needs `WebGPUWeatherRenderer.ts` to wire into pipeline

#### ❌ Not Yet Implemented (Prioritized)

| Effect | Approach | Effort | Priority | Prerequisite |
|--------|----------|--------|----------|-------------|
| **Volumetric Fog** | Ray-march compute shader | 4-5 days | 🟡 P1 | Depth buffer access in compute |
| **Volumetric Clouds** | Noise-based ray march on sky hemisphere | 5-7 days | 🟡 P1 | Sky dome geometry, 3D noise texture |
| **God Rays** | Radial blur post-process from sun position | 2-3 days | 🟡 P1 | Sun screen-space position, depth buffer |
| **Wet Surfaces** | PBR roughness reduction + darkening when raining | 1-2 days | 🟢 P2 | Weather state flag in uniforms |
| **Aurora Borealis** | Procedural shader on sky dome (noise + curtain function) | 2-3 days | 🟢 P2 | Sky dome integration |
| **Sandstorm/Dust** | GPU particles + distance fog tinting | 2-3 days | 🟢 P2 | `WeatherParticles.wgsl` renderer |

### CesiumJS-Specific Weather Considerations

1. **Planetary Scale**: Weather effects must work at global scale — rain in New York shouldn't render over London. Need geographic weather zones.
2. **Altitude Awareness**: Snow should appear above freezing altitude, rain below. Cloud layers at correct altitudes (cumulus ~2000m, cirrus ~8000m).
3. **Time-of-Day Integration**: Weather interacts with day/night cycle — rain on the night side should be visible against city lights.
4. **Terrain Interaction**: Rain particles should collide with actual terrain elevation, not a flat plane.
5. **Performance at Globe Scale**: Weather must fade out at orbital zoom levels — waste of GPU at 100km+ altitude.
6. **Data-Driven Weather**: Future integration with weather APIs (OpenWeatherMap, NOAA) for real-time weather visualization.

---

## Appendix D: Night & Ocean Rendering Enhancement Details

### Night Rendering Improvements (April 2026)

**Previous state**: Simple `smoothstep(-0.1, 0.1, sunAngle)` for day/night fade. Night side was just "darker imagery" — no city lights emission, no terminator effects.

**New implementation in `GlobeTerrain.wgsl`**:

| Feature | Before | After | Visual Impact |
|---------|--------|-------|---------------|
| **Terminator shape** | `smoothstep(-0.1, 0.1)` — soft | `NdotL * 5.0 + 0.5` — sharp, matches GLSL | Accurate day-night boundary |
| **Night-side darkness** | 0.15 base + imagery blend | 0.025 moonlight ambient, 0.04 base color | Dramatically darker night side |
| **City lights emission** | None — night imagery just alpha-blended | Emissive additive boost when `nightAlpha > dayAlpha`, luminance-weighted | City cores glow bright, suburbs dim |
| **Night intensity** | N/A | Configurable `nightIntensity` uniform (default 2.5x) | Tunable city light brightness |
| **Terminator glow** | None | Warm orange Gaussian at NdotL≈0 | Sunset/sunrise atmosphere effect |
| **Night-side fog** | Same as day fog | Dimmed to 5% on night side | Dark fog on dark side |

### Ocean/Water Rendering Improvements (April 2026)

**Previous state**: Water mask detection → 0.7× darkening → 2 scrolling UV normal maps → Phong specular. Functional but visually flat.

**New implementation in `GlobeTerrain.wgsl`**:

| Feature | Before | After | Visual Impact |
|---------|--------|-------|---------------|
| **Wave normals** | 2 octaves (500× and 250× UV) | 3 octaves (400×, 200×, 800× UV) with weighted blend | More natural wave patterns |
| **Wave distance scaling** | 0.15 constant strength | `mix(0.25, 0.05, smoothstep(10K, 500K, dist))` | Calmer ocean at distance |
| **Specular model** | Phong (pow 64) | GGX/Trowbridge-Reitz (roughness 0.08) | Physically-based sun glints |
| **Fresnel reflection** | None | Schlick approximation (F0=0.04, power=5.0) | Reflective at grazing angles |
| **Deep water color** | 0.7× base color | Blend to `(0.008, 0.045, 0.12)` at 60% | Rich blue-green ocean |
| **Subsurface scattering** | None | Forward-scatter turquoise rim at grazing angles | Light through wave crests |
| **Foam/whitecaps** | None | Steepness-based foam (threshold 0.35), distance-faded | Breaking waves on crests |
| **Sky reflection** | None | Atmosphere color mixed via Fresnel at 50% | Sky reflected in water surface |
| **Coastline transition** | Binary (>0.5 = water) | `smoothstep(0.3, 0.7, waterMask)` | Smooth land-water boundary |
| **Night ocean** | Same as day × 0.7 | `mix(0.08, 1.0, dayFade)` — very dark at night | Moonlit ocean effect |
| **Configurable params** | Hardcoded | 8 new uniform floats: deep color, Fresnel, reflectivity, foam threshold, darkening, night intensity | Runtime tunable |

---

*This audit should be used to prioritize the next development phases. The most impactful work is (1) fixing WASM/compute fallback gaps, (2) adding IBL + SSAO + bloom for visual quality, (3) activating the already-built performance infrastructure, and (4) wiring the new weather particle and SSR systems.*
