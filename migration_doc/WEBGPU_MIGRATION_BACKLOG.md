# CesiumJS WebGPU Migration -- Remaining Work Backlog

**Last Updated:** April 8, 2026 (Consolidation pass: pulled forward open items from WIRING_AUDIT_2026_04_02, COMPREHENSIVE_AUDIT_2026_03_31, and WEBGPU_DEBUGGING_LOG; removed all completed work — see `WEBGPU_MIGRATION_STATUS.md`)
**Purpose:** Single source of truth for ALL remaining work — active bugs, fork tech debt, parity gaps, sorting/picking enhancements, ES6 modernization, upstream issues, dormant compute shaders, and modern WebGPU feature integrations. Items resolved through April 2026 have been moved to `WEBGPU_MIGRATION_STATUS.md`.

> **For architecture, completed work, bug fix history (Sessions 1-26), WASM/compute audit results, render pass coverage, and current state, see `WEBGPU_MIGRATION_STATUS.md`.**

---

## Table of Contents

1. [Active Bugs](#1-active-bugs)
2. [Tier 4: Testing, Performance & Quality](#2-tier-4-testing-performance--quality)
3. [Sorting System Remaining](#3-sorting-system-remaining)
4. [Picking System Remaining](#4-picking-system-remaining)
5. [Fork-Specific Tech Debt](#5-fork-specific-tech-debt)
6. [WebGL/WebGPU Feature Parity Gaps](#6-webglwebgpu-feature-parity-gaps)
7. [Dormant Compute Shaders](#7-dormant-compute-shaders)
8. [Modern WebGPU Feature Integrations (WGF)](#8-modern-webgpu-feature-integrations-wgf)
9. [Missing Visual Features (Industry Comparison)](#9-missing-visual-features-industry-comparison)
10. [WASM Expansion Opportunities](#10-wasm-expansion-opportunities)
11. [Performance Roadmap](#11-performance-roadmap)
12. [ES6 Modernization Backlog](#12-es6-modernization-backlog)
13. [Upstream Issues (Unaddressed)](#13-upstream-issues-unaddressed)
14. [Priority Remediation Order](#14-priority-remediation-order)

---

## 1. Active Bugs

| # | Bug | Severity | Status | Notes |
|---|-----|----------|--------|-------|
| **BUG-3** | **2D mode renders as sphere** | MEDIUM | **Likely Resolved (S18) — needs visual verification** | Globe terrain shader scene-mode branching landed in Session 18 (MORPHING/COLUMBUS_VIEW/SCENE2D/SCENE3D + planar position helpers). Camera UBO extended with `tileRectangle`, `southAndNorthLatitude`, `southMercatorYAndOneOverHeight`, `sceneMode`, `morphTime`, `useWebMercator`. **Action**: visual smoke test in 2D and Columbus View modes. |
| **BUG-5** | **"size is zero" at startup** | LOW | Intermittent | `Math.max(size, 4)` guards exist but edge cases remain. Hard to repro. |
| **BUG-6** | **Fill tile edge-case errors** | LOW | Mostly Fixed (S15) | Stride mismatch skip handles most cases; rare residuals. |
| **SHADOW-LAYOUT** | **Per-layout shadow cast pipelines** | MEDIUM | New (S25) | Cast pipeline assumes single fixed vertex layout (stride 24, two `float32x3` for RTE positionHigh/positionLow). Quantized terrain (stride 8/12), instanced meshes, custom model layouts produce garbage shadows or validation errors. S25 added stride filter as safety net (skip non-stride-24 commands). **Real fix**: small pipeline cache keyed on vertex layout so all layouts cast shadows correctly. Estimated 1-2 days. |
| **BUG-11** | **Imagery layer textures bind but don't render** | HIGH | **Needs visual env** | Per-tile diagnostic logs at `WebGPUGlobeSurfaceRenderer.ts:801` show `hasImage=true hasWebGPUTex=true` but no visible imagery. **Code-level audit (S26) ruled out**: bind-group sample-type mismatch, std140 alignment drift, day/night alpha argument swap, stale uniform leakage. **Top runtime suspects**: (A) reprojection clear alpha=0 collapsing `tex.a * effectiveAlpha` to zero — verify by changing clear alpha to 1.0; (B) `tileImagery.textureCoordinateRectangle` initialized to (0,0,0,0) instead of undefined — `texCoordsAlpha` mask returns 0 for every fragment; (C) stale view in `_imageryTextureCache` after underlying GPUTexture recreated. **Probe checklist**: capture existing diag logs for `texCoordsRect`/`transScale`, toggle `tile.debugFields.x=1` (tier-2 LOD overlay) to confirm geometry rasterizes, then narrow to A/B/C. |
| **BUG-1** | **Stars/skybox not visible** | HIGH | **Fixed (S16) — still needs visual confirmation** | `panoramaCommandList` accumulation bug fixed; injection path in `SceneRenderer.js` confirmed sound by code audit. Has not been confirmed visually since the fix landed. |
| **BUG-7** | **Shadow cast pipeline** | MEDIUM | **Fixed + Limitation (see SHADOW-LAYOUT)** | Command collection, point light guard, bias path all fixed in S16. Stride filter added S25. |

### Visual Verification Backlog (in-browser confirmation needed)

These features have been *fixed in code* across Sessions 16-18 but never had a final visual smoke test. Each is one short manual session away from being closed:

1. **Stars/skybox** (BUG-1) — verify `[WebGPU] Frustum X: ENVIRONMENT=N` console messages show env commands present, then confirm starfield renders behind globe.
2. **Shadow casting** — open a model+terrain scene, confirm shadow on terrain.
3. **2D / Columbus View** (BUG-3) — switch scene mode toggle, confirm flat/columbus projections render without artifacts.
4. **Render bundle performance** — frame-time measurement with ≥8 globe tiles to confirm 50-80% CPU drop.
5. **Advanced renderers** — CloudCollection, VoxelPrimitive, GaussianSplat, PointCloud, EllipsoidPrimitive — all built with full shaders, none have been verified rendering end-to-end.

---

## 2. Tier 4: Testing, Performance & Quality

| # | Item | Effort | Status |
|---|------|--------|--------|
| 4.1 | **Expand Jasmine spec coverage** (FORK-19b) | 4-6 days | 10 spec files exist (Buffer, DrawCommand, ImageUpload, PrimitiveIndexUtils, RingBufferAllocator, ShadowMapRenderer, SubgroupUtils, Texture, ContextFactory, GraphicsContext, NagaTranspiler). Coverage is thin — 105+ WebGPU files, only ~50 tests total. Target: at least one spec per FR + per major utility module. |
| 4.2 | **Automated visual regression (pixel-diff CI)** | 3-4 days | `Tools/visual-regression/` scaffolding exists (Playwright + hand-rolled PNG diff, no new deps). Needs: CI integration, baseline corpus capture, tolerance tuning per scene. |
| 4.3 | **Browser compatibility testing** | 3-5 days | Safari, Firefox WebGPU support. Edge tested; need cross-browser smoke + capability fingerprinting for the WGF features. |
| 4.4 | **Performance benchmarking** | 2-3 days | WebGL vs WebGPU vs WebGPU-compat comparison. Need fixed-camera scene + frame-time logging + report generation. Measurable wins to verify: render bundles (50-80% CPU), GPU culler (5-20× for >50K objects), AtmosphereLUT consumer (fragment ray-march elimination), PointCloudLOD subgroups (2-4× on dense scenes). |
| 4.6 | **Indirect drawing for 3D Tiles — production activation** | 2-3 days | Infrastructure built (`WebGPUIndirectDrawManager.ts`); opt-in fast path landed S26 via `executeBatchIndirect()` + `context.useIndirectDrawForTiles` flag. **Remaining**: identify a tile renderer with homogeneous pipeline+bind-group runs of ≥2 commands and flip the flag on for it. Most tile commands have unique per-tile bind groups so the win lives mainly in tightly-instanced point cloud / batched-table tile sets. |
| 4.8 | **Console noise reduction** | 1 day | ~12 `console.warn/error` calls in standalone modules should route through `context.log(level, ...)` for per-context prefixing. |

### Compute Engine Hardening (CS-* items from COMPREHENSIVE_AUDIT_2026_03_31)

| ID | Issue | Severity | Status |
|----|-------|----------|--------|
| **CS-1** | 4 dormant compute shaders need consumer wiring (HiZ, OcclusionTest, PointCloudSort, GPUSortKeys) | 🟡 Medium | Documented in §7. Activation tied to consumer system testing. |
| **CS-6** | `WebGPUPerformanceManager.dispatchCompute()` caches pipelines by task string but doesn't validate bind group compatibility | 🟡 Medium | Add bind group layout validation on dispatch path. |

---

## 3. Sorting System Remaining

| ID | Item | Effort | Status |
|----|------|--------|--------|
| **SORT-8** | Unit tests for sorting (30+ files) | 3-5 days | Not started. Tied to FORK-19b spec expansion. |
| **SORT-12** | OcclusionCulling GPU resources | Tied to testing | GPU resources still stub; conservative "assume visible" fallback active. Wire when Hi-Z compute shader activates (§7). |

---

## 4. Picking System Remaining

| # | Item | Effort | Status |
|---|------|--------|--------|
| 6.1 | **WGSL depth-to-color blit shader** for main scene depth readback | 1-2 days | Globe depth blit done (FORK-34); main scene depth blit still pending. |
| 6.2 | **Pick layer filtering** (bitmask to skip unpickable objects) | 1-2 days | Not started |
| 6.3 | **Octree pick acceleration** (pre-filter via octree) | 1-2 days | Not started; tied to SORT octree opt-in |
| 6.4 | **GPU multi-hit** (WebGPU only — storage buffer linked list) | 3-5 days | Future |
| 6.5 | **Rectangle selection** | 2-3 days | Future |
| 6.6 | **Pick priority** (`entity.pickPriority`) | 1-2 days | Future |
| 6.7 | **CPU hybrid pick** (geometric ray intersection) | 3-5 days | Future |

---

## 5. Fork-Specific Tech Debt

Items introduced by our WebGPU additions. 33 of 46 resolved through April 2026; 13 remaining.

### Remaining Items (Priority Order)

| ID | Issue | Severity | Effort |
|----|-------|----------|--------|
| **FORK-19b** | Expand WebGPU spec coverage (10 files, ~50 tests for 105+ source files) | HIGH | 4-6 days |
| **FORK-41** | 4 of 12 compute shaders awaiting activation (HiZ, OcclusionTest, PointCloudSort, GPUSortKeys) | MEDIUM | Per shader, 2-4 days each |
| **FORK-45** | Single global WASM arena shared across bridges | MEDIUM | 1 day | All 7 bridges share one `Mutex<Vec<u8>>` arena. Works today because bridges run sequentially, but a parallel-frame future would corrupt it. Per-bridge arena slots needed. |
| **FORK-11** | `webgpuTypeHelpers.ts` has limited adoption | MEDIUM | 0.5 day | The helper module exists but most call sites still inline `as any` casts. |
| **FORK-9** | ~11 `as any` casts remain in WebGPU TypeScript | MEDIUM | -- | Replace with proper typed helpers; depends on FORK-11 adoption. |
| **FORK-16** | WGSL preprocessor test page reimplements preprocessor | MEDIUM | 0.5 day | Test page has its own preprocessor; should consume the production `WGSLShaderPreprocessor`. |
| **FORK-20** | 29 test pages use 3 different module loading patterns | MEDIUM | 1 day | Standardize on a single import pattern across `Apps/WebGPUTest/`. |
| **FORK-21** | Test pages contain hardcoded inline WGSL shaders | MEDIUM | 0.5 day | Move to shared `.wgsl` files or import from production locations. |
| **FORK-22** | Several test pages are raw WebGPU demos | MEDIUM | 0.5 day | Refactor to use the production renderer where it exists, so the test page validates the real path. |
| **FORK-23** | No automated visual regression testing | MEDIUM | 2-3 days | See item 4.2 above. |
| **FORK-4** | `WebGLCompatibilityStub.ts` maintenance | MEDIUM | Ongoing | The stub layer is necessary for the imagery layer + a few other places that still call WebGL APIs through the stub. The Naga-wasm spike (S26) is the long-term path to retire it. |
| **FORK-8** | `panoramaCommand.isWebGPUDrawCommand` check in Scene.js | LOW | -- | One residual reference; replace with duck-typing like the other 7 violations resolved in S16. |
| **FORK-29** | Slang cross-compilation unused in production | LOW | -- | Slang infrastructure is still in the tree but no production shaders use it. Decision: remove or commit to it (blocked on naga-wasm spike outcome). |
| **FORK-30** | `@webgpu/types` pinned to `^0.1.69` | LOW | -- | Newer versions renamed `maxInterStageShaderComponents` → `maxInterStageShaderVariables` (handled in S26 with cast). Bump pin once we're confident in the new API surface. |

### Resolved Items (33 of 46) — For Reference

FORK-1 (device loss), FORK-2 (unused imports), FORK-3 (redundant shader loading), FORK-5 (Phase D 28/28), FORK-6 (isWebGPU checks reduced), FORK-7 (depthRangeZeroToOne), FORK-10 (ts-expect-error), FORK-12 (context-aware logging), FORK-13 (no debug logging), FORK-14 (CameraUniforms drift), FORK-15 (transitive struct deps), FORK-17 (mipmap stub now dispatches `WebGPUMipmapGenerator`), FORK-18 (DepthPlane implemented), FORK-19 (10 spec files now exist — rescoped as FORK-19b above), FORK-24 (Primitive.js cleanup), FORK-25 (7 renderers wired), FORK-26 (COUNT auto-computed), FORK-27 (abstract methods verified), FORK-28 (25/25 materials), FORK-31 (sorting integration complete), FORK-32+33 (multi-light scene.lights), FORK-34 (pick scene depth blit complete), FORK-35 (pick ID consolidated), FORK-36 (convenience pick APIs), FORK-37 (WASM destroy+free_buffer), FORK-38 (WASM version check), FORK-39 (SIMD detection), FORK-40 (all bridges destroy), FORK-42 (compute try/catch), FORK-43 (workgroup validation), FORK-44 (CPU fallback sort/LOD), FORK-46 (Rust OOM handling), NEW-1 (DynamicEnvironmentMapManager sync readPixels — non-issue, FR intercepts).

---

## 6. WebGL/WebGPU Feature Parity Gaps

### GLSL Backport Analysis — No Backports Needed

All WGSL shaders fall into three categories:

| Category | Count | Details |
|----------|-------|---------|
| **Ports of existing GLSL** | 12+ | Tonemapping, Atmosphere, SSAO, Bloom, DoF, Edge, Silhouette, IBL (3), FXAA |
| **Compute-only (impossible in WebGL)** | 8 | FrustumCull, HiZ, OcclusionTest, AtmosphereLUT, PointCloudSort/LOD, GPUSortKeys, WeatherParticles |
| **WebGPU-only enhancements** | 7+ | SSR, ProceduralClouds, DeferredGBuffer/Lighting, enhanced ocean, enhanced night, terminator glow |

### New Upstream GLSL — WGSL Forward-Ports Needed (Low Priority)

| GLSL Shader | Feature | WGSL Status |
|---|---|---|
| `computeTextureTransform.glsl` | `KHR_texture_transform` | **Done** (`csm_computeTextureTransform.wgsl`) |
| `ConstantLodStageFS/VS.glsl` | Distance-based constant LOD | Low priority — wire when constant-LOD extension support added to WebGPU model path |
| `EdgeVisibilityStageVS.glsl` | Edge visibility (glTF ext) | Low priority — wire when edge visibility WebGPU path added |

### Phase 2 Feature Completion (medium priority)

| # | Feature | Effort | WebGL? | Notes |
|---|---------|--------|--------|-------|
| 7 | **Built-in shader cache** | 1-2 days | Already works | Marked "not yet implemented" in `WebGPUShaderCache`. The cache infrastructure exists but doesn't pre-populate at init. |
| 8 | **Deferred G-Buffer renderer** | 5-7 days | No | Key registered (`DEFERRED_GBUFFER`) but never implemented. WebGPU-only advanced feature. Decision: implement or remove from `FeatureRendererKey.js`. |
| -- | **General particle system** | 2-3 days | Already works | `ParticleSystem`/`ParticleEmitter` already auto-route through `BillboardCollection` (confirmed S20). No-op closure. |

---

## 7. Dormant Compute Shaders

Per the WIRING_AUDIT analysis, all dormant compute shaders have working fallbacks. They are performance optimizations to be wired when their consumer systems need them.

| Shader | Fallback | Activation Trigger | Effort |
|--------|----------|-------------------|--------|
| `HiZPyramid.wgsl` | Conservative "assume visible" stub in `OcclusionCulling.js` | Wire into `ViewportExecutor` with Hi-Z occlusion (Phase 3) | 3-4 days |
| `OcclusionTest.wgsl` | Same as HiZPyramid | Wire alongside HiZ | (combined with above) |
| `PointCloudSort.wgsl` | Unsorted rendering works; `WasmPointCloudBridge.sortByDistance()` available | Wire when point cloud visible | 2-3 days |
| `GPUSortKeys.wgsl` | JS multi-level comparators in Scene.js (always active) | Wire when >50K commands per frame | 2-3 days |

**Already activated** (see STATUS): PolygonSignedDistance, BrdfLutGenerate, IrradianceConvolution, RadiancePrefilter, FrustumCull (with subgroup variant), AtmosphereLUT (dispatch + consumer wired S26), PointCloudLOD (subgroup dispatcher S26), WeatherParticles (compute + render S18).

---

## 8. Modern WebGPU Feature Integrations (WGF)

| # | Feature | WebGPU API | CesiumJS Impact | Effort | Status |
|---|---------|-----------|-----------------|--------|--------|
| **WGF-3** | **WGSL `texture_and_sampler_let`** | Assign texture/sampler to `let` variables | Cleaner shader code, prepares for future bindless textures | 0.5-1 day | **No work needed** (S21 audit) — sampler-as-let pattern already used in `sampleImagery()`. |
| **WGF-4** | **Uniform Buffer Standard Layout** (`uniform_buffer_standard_layout`) | Removes std140 padding requirements | Smaller uniform buffers (camera, tile, effects). Currently we manually pad with `_pad0`, `_pad1`. Standard layout eliminates ~20% of UBO waste. | 1-2 days | Not started |
| **WGF-7** | **Enhanced Texture Formats** (Tier 1 & 2 storage textures) | Broader storage usage on rgba16float, rg32float; Tier 2 read-write storage | Compute shader outputs (atmosphere LUT, SDF, Hi-Z buffer) can use richer formats; read-write enables single-pass algorithms | 1-2 days | **No immediate work needed** (S21 audit) — current 8 storage-write shaders already use the right format for their kernel output. Wire when a new compute shader needs the richer format. |

**Already landed** (see STATUS Section 2): WGF-1 Subgroups (FrustumCull `mainSubgroups` + PointCloudLOD `computeMainSubgroups` + dispatcher), WGF-2 Transient Attachments (`WebGPUFramebufferManager` reads `TRANSIENT_ATTACHMENT` flag with feature detection + `storeOp: "discard"`), WGF-5 Texture Component Swizzle (S21: dynamic vector subscript replaces if-else chain), WGF-6 Primitive Index (`csm_primitiveIndex.wgsl` chunk + `WebGPUPrimitiveIndexUtils.ts` + production wiring through `Scene.debugShowTriangulation`), WGF-8 EXIF/Orientation Image Upload (S21: `WebGPUImageUpload.ts` + `createTextureFromImageAsync()`).

### WebGPU API Features Detected But Not Used

| Feature | Status | Opportunity |
|---------|--------|-------------|
| `shader-f16` | Detected, unused | Half-precision math in shaders → 2× bandwidth, 2× ALU on supported GPUs |
| `dual-source-blending` | Detected, unused | True OIT without MRT — single-pass weighted blended OIT |
| `indirect-first-instance` | Detected, unused | GPU-driven rendering with per-instance data indexing |
| `bgra8unorm-storage` | Detected, unused | Direct compute write to swap chain format |
| `clip-distances` | Detected, unused | Hardware clipping planes (vs fragment discard) — better perf |
| `timestamp-query` | Wired in profiler | Currently infra-only; enable for automated perf regression tests |
| `float32-filterable` | Used for depth | Could also be used for HDR texture sampling |

### WebGPU Features Not Yet Detected/Requested

| Feature | Status | Opportunity |
|---------|--------|-------------|
| `chromium-experimental-multi-draw-indirect` | Not detected | Single API call for N draw commands — massive CPU reduction. Pairs with `WebGPUIndirectDrawManager`. |
| `chromium-experimental-read-write-storage-texture` | Not detected | Read-write textures in compute (in-place image processing) |
| `chromium-experimental-unorm16-texture-formats` | Not detected | 16-bit normalized textures for compact terrain height data |
| `GPUExternalTexture` | Not used | Zero-copy video texture import (video draping on terrain) |

---

## 9. Missing Visual Features (Industry Comparison)

These features are standard in Babylon.js / Three.js / PlayCanvas / Filament / Bevy and would close visual quality gaps. None are blocking, all are additive.

### Critical Missing — Available in ALL Major WebGPU Engines

| Feature | Industry Status | Our Status | Impact | Effort |
|---------|----------------|------------|--------|--------|
| **Temporal Anti-Aliasing (TAA)** | All engines | ❌ Missing (FXAA only) | Far superior to FXAA for moving scenes | 3-4 days |
| **Cascaded Shadow Maps (CSM)** | All engines | ❌ Missing | Efficient shadow rendering for large outdoor scenes | 4-5 days |
| **Motion Blur** | Babylon, Three.js, PlayCanvas | ❌ Missing | Cinematic quality for camera/object movement | 2-3 days |

### Important Missing — Available in Most WebGPU Engines

| Feature | Industry | Our Status | Impact | Effort |
|---------|----------|------------|--------|--------|
| **Volumetric Lighting/Fog** | Babylon, Three.js, Unreal | ❌ Missing | God rays, volumetric clouds, atmospheric scattering | 4-5 days |
| **Color Grading / LUT** | Babylon, Three.js | ❌ Missing | Film-quality color correction | 1-2 days |
| **Contact Shadows** | Babylon, Three.js | ❌ Missing | Small-scale ground contact shadows | 2-3 days |
| **Subsurface Scattering (SSS)** | Babylon, Filament | ❌ Missing | Realistic skin, foliage, marble rendering | 3-4 days |
| **GPU Particle System (general)** | Babylon, Three.js, PlayCanvas | ⚠️ Weather only | Compute-based particles — fire, smoke beyond weather | 3-5 days |
| **Clustered/Tiled Deferred Lighting** | Standard | ❌ Missing | Efficient many-lights (our multi-light is brute force) | 4-5 days |
| **Light Probes / SH Lighting** | Standard | ❌ Missing | Pre-baked indirect lighting | 3-4 days |
| **Parallax Occlusion Mapping** | Standard | ❌ Missing | Depth on flat surfaces without extra geometry | 2-3 days |

### Nice to Have — Cutting-Edge

| Feature | Status | Notes |
|---------|--------|-------|
| **Ray Tracing** | Not in WebGPU spec yet | Coming in future spec revisions |
| **Mesh Shaders** | Not in WebGPU spec yet | Google has proposals |
| **Variable Rate Shading (VRS)** | Not in WebGPU spec | Available in DirectX 12/Vulkan |
| **Procedural Sky / Dynamic Clouds** | Babylon, Unreal | We have static atmosphere only; volumetric clouds would integrate with `ProceduralClouds.wgsl` |
| **Ocean FFT** | Three.js, Unreal | We have multi-octave wave normals; FFT would be a quality bump |
| **Terrain Tessellation (GPU)** | Native engines via tess shaders | WebGPU has no tessellation stage — use compute + indirect |

### CesiumJS-Specific Missing Features

| Feature | Why Important | Effort | Priority |
|---------|---------------|--------|----------|
| **Procedural textures for globe** | Cloud layers, aurora — future CesiumJS feature | 3-5 days | Low |
| **Terrain blend/splat mapping** | Multi-texture terrain at close range | 3-5 days | Low |
| **Vector tile rendering** | Upstream #2132 — largest open request. Buffer primitives done, full vector tile path remaining | 5-10 days | Low |

### Weather Effects Not Yet Implemented

`WeatherParticles.wgsl` covers rain/snow/fog/hail GPU particle simulation + render pass (S18). Open weather features:

| Effect | Approach | Effort | Priority |
|--------|----------|--------|----------|
| **Volumetric Fog** | Ray-march compute shader | 4-5 days | Medium |
| **Volumetric Clouds** | Noise-based ray march on sky hemisphere | 5-7 days | Medium |
| **God Rays** | Radial blur post-process from sun position | 2-3 days | Medium |
| **Wet Surfaces** | PBR roughness reduction + darkening when raining | 1-2 days | Low |
| **Aurora Borealis** | Procedural shader on sky dome (noise + curtain function) | 2-3 days | Low |
| **Sandstorm/Dust** | GPU particles + distance fog tinting | 2-3 days | Low |
| **Lightning** | Custom ray + bloom | 2-3 days | Low |

#### CesiumJS-Specific Weather Considerations
1. **Planetary scale** — weather must be geographically zoned, not screen-space
2. **Altitude-aware** — snow above freezing, rain below; cumulus ~2000m, cirrus ~8000m
3. **Time-of-day integration** — weather interacts with day/night cycle
4. **Terrain interaction** — particles collide with actual terrain elevation
5. **Performance at globe scale** — fade out at orbital zoom levels
6. **Data-driven** — future integration with weather APIs (OpenWeatherMap, NOAA)

---

## 10. WASM Expansion Opportunities

| Target | Current Approach | WASM Benefit | Estimated Speedup | Effort |
|--------|-----------------|-------------|-------------------|--------|
| **glTF decode** | JS in `GltfLoader.js` | SIMD accessor decode, mesh optimization | 2-4× for large models | 3-5 days |
| **Batch transform update** | JS per-entity `Matrix4.multiply` | SIMD f32x4 batch multiply | 3-5× for >1K entities | 2-3 days (partially done in `matrix_batch.rs`) |
| **Terrain mesh stitching** | JS in `TerrainMesh.js` | SIMD edge matching, skirt generation | 2-3× | 2-3 days |
| **Quadtree traversal** | JS in `QuadtreePrimitive.js` | Batch tile selection with SOA layout | 2-3× for deep quadtrees | 3-4 days |
| **3D Tiles traversal** | JS in `Cesium3DTilesetTraversal.js` | Batch bounding volume tests | 3-5× for large tilesets | 4-5 days |
| **KTX2 super-decompression** | WASM `basis_transcoder` exists | Add ASTC/ETC2 → BC transcode for WebGPU | 1.5-2× memory savings | 2-3 days |

---

## 11. Performance Roadmap

### Architecture-Level Performance (Built or Wired — see STATUS for activation status)

| Opportunity | Current State | Expected Benefit | Effort |
|------------|--------------|------------------|--------|
| **Bind group caching** | Recreated frequently | Cache by content hash → 50% fewer creations | 2-3 days |
| **Texture atlas consolidation** | Separate textures per billboard/point | Single atlas → 30-50% fewer draw calls | 3-4 days |
| **Command buffer reuse** | New encoder per frame | Double-buffer encoders | 1-2 days |
| **Multi-draw indirect** | Individual `drawIndirect()` calls | Single `multiDrawIndirect()` (Chromium experimental) | 1-2 days |

### New Compute Shader Opportunities

| Target | Benefit | Workgroup Pattern | Effort |
|--------|---------|-------------------|--------|
| **Terrain LOD selection** | GPU-side tile visibility + LOD decision | 1D dispatch over tile array | 2-3 days |
| **3D Tile GPU culling** | Bounding volume hierarchy test on GPU | Hierarchical dispatch | 3-4 days |
| **General particle simulation** | Fire, smoke, custom particles via compute | Update + emit + compact pattern | 3-5 days |
| **Ocean FFT** | Realistic water simulation | 2D FFT butterfly dispatches | 4-5 days |
| **Gaussian Splat sort** | Real-time depth sorting for splats | Radix sort on GPU (similar to PointCloudSort) | 2-3 days |

---

## 12. ES6 Modernization Backlog

~432 files total need constructor-class conversion. ~75 completed so far.

### Completed (~75 files)

| Directory | Status |
|-----------|--------|
| **Renderer (29/29)** | All JS files converted |
| **Scene high-priority (24+)** | All WebGPU-blocking files converted |
| **DataSources high-priority (8)** | All sorting-related files converted |
| **Appearance classes (4)** | All appearance files converted |

### Remaining (~380+ files)

- **Core — Performance-Critical Math** (16 files): Cartesian2/3/4, Matrix2/3/4, Quaternion, BoundingSphere, etc. **Note**: Some of these have already been ported upstream in v1.139 (Cartesian2/3/4 now ES6 classes). Audit before re-doing.
- **Core — Terrain/Geography/Geometry** (~30+ files)
- **Core — Utilities** (~40+ files)
- **Scene — 3D Tiles** (~22 files)
- **Scene — Imagery Providers** (~16 files)
- **Scene — Model/glTF Pipeline** (~40+ files)
- **Scene — Remaining** (~30+ files)
- **DataSources** (~77 files)
- **Widgets** (~22 files)
- **Cross-Cutting Patterns** (~60+ files): `.indexOf()` → `.includes()`, `typeof x !== "undefined"` → optional chaining, etc.

**Total estimated effort:** ~400-600 hours
**Rule:** Never modernize files you're not otherwise touching. Always modernize if making >10 lines of changes.

---

## 13. Upstream Issues (Unaddressed)

42 open upstream issues that our fork has NOT addressed. Top priorities:

### Camera & Navigation (7 issues)
Camera boundary/constraints (#4802), Follow-camera (#5241), Mouse wheel zoom jumpy (#4537), Scroll zoom high refresh (#12187), KML flyTo underground (#4327), Touch controls (#4363), computeViewRectangle 2D/CV (#4346)

### Entity & DataSource (7 issues)
Picking priority overlapping entities (#1592), CLAMP_TO_GROUND billboard (#4776), Dynamic boxes tracking (#5164), Scene ready event (#4422), Custom PositionProperty (#9491), Clamped polygons mobile (#9702), WMS GetFeatureInfo position (#9363)

### Rendering & Graphics (6 issues)
Blinking entity shader update (#12532), Fit texture coords (#4164), Material difference 2D (#9853), Animated billboards (#2319), disableDepthTestDistance picking (#6840), Extruded geometry terrain (#4743)

### Other Categories
Memory Leaks (6), 2D/Columbus View (4), 3D Tiles (5), Terrain & Imagery (3), Model/glTF & Build (4), Legacy Code Debt (5)

---

## 14. Priority Remediation Order — Path to WebGL Parity

> **Updated April 8, 2026.** All Tier 1-3 work is complete (see STATUS sections 2-3). Focus now: visual verification, expand testing, activate remaining dormant compute shaders, close visual feature gaps.

### Phase 1: Visual Verification & Bug Closure (1-2 weeks)

1. **Visual smoke test all S16/S17/S18 fixes** — Stars/skybox, shadow casting, render bundle perf, advanced renderers (Cloud/Voxel/GaussianSplat/PointCloud/Ellipsoid), 2D/Columbus View modes
2. **BUG-11 imagery** — Use the probe checklist in §1 (existing diag logs first, then alpha/texCoordsRect/cache hypotheses)
3. **SHADOW-LAYOUT** — Per-vertex-layout shadow cast pipeline cache (1-2 days)
4. **BUG-5/6 edge cases** — Reproduce + close
5. **FORK-8** — Last residual `isWebGPUDrawCommand` check in Scene.js

### Phase 2: Testing & Quality (4-5 weeks)

6. **FORK-19b** — Expand Jasmine spec coverage to 1 spec per FR + per major utility (~50 → ~150 tests)
7. **Visual regression CI** — Activate `Tools/visual-regression/` with baseline corpus + tolerance config
8. **Browser compatibility** — Safari, Firefox WebGPU testing matrix
9. **Performance benchmarking** — Fixed-camera scenes + frame-time logging; verify the perf wins from S16/S17/S26 (render bundles, GPU culler, atmosphere LUT, point cloud subgroups)

### Phase 3: Dormant Compute Shader Activation (2-3 weeks)

10. **HiZ + OcclusionTest** — Wire into ViewportExecutor for occlusion culling
11. **PointCloudSort** — Wire when point cloud collection visible (depth sort for translucent points)
12. **GPUSortKeys** — Wire when scene exceeds 50K commands (replace JS comparators on the hot path)

### Phase 4: Visual Quality Closure (4-6 weeks)

13. **TAA** — Temporal anti-aliasing as WGSL post-process
14. **CSM** — Cascaded shadow maps for outdoor scenes
15. **Volumetric fog/lighting** — God rays, scattering
16. **Color grading** — LUT-based color correction
17. **Subsurface scattering** — Skin/foliage rendering
18. **Clustered lighting** — Efficient many-lights for urban scenes
19. **Vector tile rendering** — Build on top of Buffer Primitive renderers
20. **Deferred G-Buffer** — Implement or remove `DEFERRED_GBUFFER` FR key

### Phase 5: Modern WebGPU Feature Adoption (2-3 weeks)

21. **WGF-4 Standard Layout UBOs** — Remove manual std140 padding, ~20% UBO size reduction
22. **`shader-f16`** — Wire half-precision math in selected fragment shaders for 2× bandwidth/ALU
23. **`dual-source-blending`** — Single-pass weighted blended OIT
24. **`clip-distances`** — Hardware clipping planes (vs fragment discard) for clipping perf
25. **`chromium-experimental-multi-draw-indirect`** — Pair with `WebGPUIndirectDrawManager` for single-call N-draw rendering

### Phase 6: Naga-wasm Spike Productionization (1 week, optional)

26. **Naga-wasm bind-set remapping** — Naga emits raw `@group/@binding` from GLSL `layout(binding=...)`; need a layout reflection step
27. **Vertex attribute location remapping** — Stride/format normalization between source GLSL and consumer pipelines
28. **Specialization-constant injection** — Map GLSL `#define`s to WGSL pipeline-overridable constants
29. **Replace WebGL stub for shaders Naga handles** — Incremental retirement of `WebGLCompatibilityStub.ts`

### Phase 7: Long-Tail Cleanup (Ongoing)

30. **ES6 modernization** — Continue under the "10-line touch rule"
31. **Console noise reduction** (4.8) — Route bare `console.warn/error` through `context.log()`
32. **Test page consolidation** (FORK-20/21/22) — Standardize loading patterns + share shaders
33. **Upstream sync** — Periodic sync with `CesiumGS/cesium` main
34. **Upstream issue triage** — Pick off the 42 open issues most relevant to WebGPU users

---

*This backlog supersedes all previous versions. For per-session bug fix detail, completed work, and architecture, see `WEBGPU_MIGRATION_STATUS.md`. The legacy `WIRING_AUDIT_2026_04_02.md`, `COMPREHENSIVE_AUDIT_2026_03_31.md`, and `WEBGPU_DEBUGGING_LOG.md` documents are preserved for historical reference but their open items have been pulled forward into this file and STATUS.*
