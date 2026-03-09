# WebGPU Migration Research Findings

**Date:** March 8, 2026  
**Scope:** CesiumGS hackathon branches, other WebGL→WebGPU engines, WebGPU spec compliance, WASM opportunities

---

## Table of Contents

1. [CesiumGS Hackathon Branches Analysis](#1-cesiumgs-hackathon-branches-analysis)
2. [Other WebGL→WebGPU Migrations Worth Studying](#2-other-webglwebgpu-migrations-worth-studying)
3. [WebGPU Spec Compliance Audit](#3-webgpu-spec-compliance-audit)
4. [Latest WebGPU Features We Should Use](#4-latest-webgpu-features-we-should-use)
5. [WebAssembly Optimization Opportunities](#5-webassembly-optimization-opportunities)
6. [Recommendations & Action Items](#6-recommendations--action-items)

---

## 1. CesiumGS Hackathon Branches Analysis

### Summary

All three branches are from a CesiumGS internal hackathon (likely late 2024/early 2025). They are **small experimental prototypes** — 8-14 commits each, now **565 commits behind** `main`. Our fork is **vastly more comprehensive** than any of them.

### Branch: `webgpu-hackathon-device` (8 commits ahead, 565 behind)

**Files modified:** 7 files
```
Renderer/WebGPU/BindGroup.js
Renderer/WebGPU/BindGroupEntry.js
Renderer/WebGPU/WebGPUBuffer.js
Renderer/WebGPU/WebGPUComputeCommand.js
Renderer/WebGPU/WebGPUContext.js
Scene/FrameState.js
Scene/Scene.js
```

**What it does:**
- Basic WebGPU context wrapper (~115 lines) with `device`, `adapter`, `createCommandEncoder`, `submitEncoder`, `createShaderModule`, `createComputePipeline`, `createBuffer`, `writeBuffer`, `readBuffer`, `runCompute`
- Exposes the WebGPU context via `FrameState` and `Scene`
- Has a simple compute pipeline demo: "adds two buffers together" then "reads back output buffer"
- Very thin wrapper — essentially just `device.create*()` passthroughs

**Useful ideas to copy: ⚠️ Limited**
- The branch validates a simple "compute pipeline → buffer readback" flow, but our `WebGPUComputeCommand.ts` + `WebGPUComputeEngine.ts` already do this with pipeline caching, batch dispatch, and indirect dispatch support
- Their `FrameState.js` integration of `webgpuContext` is worth noting — we could consider exposing the WebGPU context via FrameState for compute tasks that run outside the rendering pipeline (currently it's only accessible via `scene._context`)

**Verdict:** 🟡 **Nothing directly copyable.** Our implementation is 10-20x more comprehensive.

---

### Branch: `webgpu-hackathon` (14 commits ahead, 565 behind)

**Files modified:** 17 files  
**This is the most interesting branch.**

```
Scene/WebGPUPostProcessStage.js            — Simple fullscreen WGSL effect overlay
Scene/WebGPUPostProcessStageAdvance.js      — Advanced: reads WebGL output → WebGPU post-process
Shaders/PostProcessStages/Brightness.slang  — Slang shader for brightness
Shaders/WebGPUTest.slang                    — Test slang shader
scripts/convertSlangToWgsl.js               — Slang → WGSL compiler wrapper
scripts/SLANG_GUIDE.md                      — Slang toolchain documentation
scripts/postprocess-slang-glsl.sh           — Slang → GLSL post-processing
sandcastle/gallery/webgpu-post-processing-dev/     — Basic demo
sandcastle/gallery/webgpu-post-processing-advance-dev/ — Advanced demo
```

**What it does — Three notable concepts:**

#### 1. Slang Shader Compilation Pipeline ✨
Uses [Slang](https://github.com/shader-slang/slang) as a **universal shader language**:
- Write shaders once in `.slang` format
- `slangc` compiles to WGSL (for WebGPU) or SPIRV→GLSL 300 ES (for WebGL)
- `convertSlangToWgsl.js` wraps the `slangc` CLI tool
- `buildGallery.js` auto-converts `.slang` → `.wgsl` during build

**Flow:** `Slang → slangc → SPIRV → spirv-cross → GLSL 300 ES` for WebGL, `Slang → slangc → WGSL` for WebGPU

#### 2. WebGL→WebGPU Post-Processing Bridge ✨
`WebGPUPostProcessStageAdvance.js` implements a creative hybrid approach:
1. Cesium renders normally via WebGL
2. After WebGL render, reads pixels via `gl.readPixels()` from the WebGL canvas
3. Uploads those pixels to a WebGPU texture via `device.queue.writeTexture()`
4. Applies a WGSL post-processing shader on a **separate overlay canvas**
5. Uses alpha blending to composite the WebGPU effect over the WebGL output

This is a pragmatic "bridge" approach for adding WebGPU post-processing to an existing WebGL renderer without touching the core renderer.

#### 3. Overlay Canvas Architecture
Both post-process stages create a **second canvas** positioned absolutely over the Cesium canvas, with `pointer-events: none`. The WebGPU context is attached to this overlay canvas. This avoids the "one canvas, one GPU context" limitation.

**Useful ideas to copy:**

| Idea | Value | Should We Adopt? |
|------|-------|-----------------|
| **Slang as universal shader language** | Could maintain single shader source for both GLSL and WGSL | 🟡 **Maybe later.** Adds external toolchain dependency (`slangc`). Our hand-written WGSL is higher quality but doesn't share code with GLSL. Worth revisiting when we have 100+ WGSL shaders and maintenance becomes a burden. |
| **WebGL→WebGPU pixel bridge for post-processing** | Enables WebGPU post-processing even when main renderer is WebGL | 🟢 **Yes, selectively.** This is clever for the transition period — users on WebGL could still get WebGPU post-processing effects. However, `gl.readPixels()` per frame is very expensive. Better approach: use `gl.readPixels()` only when explicitly compositing, or use SharedArrayBuffer. |
| **Overlay canvas pattern** | Sidesteps context limitation | 🟡 **Maybe.** Our pure WebGPU renderer doesn't need this since we own the canvas. But for hybrid post-processing it's necessary. |

**Verdict:** 🟢 **The Slang pipeline and WebGL→WebGPU bridge are genuinely interesting ideas worth tracking, but not urgent to adopt.**

---

### Branch: `daniel/webgpu-hackathon` (13 files, subset of `webgpu-hackathon`)

This is the pre-merge version of `webgpu-hackathon` — same files minus the Slang-specific additions. It has the `WebGPUPostProcessStage.js`, `WebGPUPostProcessStageAdvance.js`, and sandcastle demos but not the Slang compilation pipeline.

**Verdict:** 🔴 **Fully subsumed by `webgpu-hackathon`. Nothing additional.**

---

### Summary: What's Worth Copying from Hackathon Branches?

| Priority | Item | Effort | Impact |
|----------|------|--------|--------|
| 🟡 Low-Medium | Expose WebGPU context via FrameState for compute tasks | 1 day | Enables compute shaders outside render loop |
| 🟡 Medium | Investigate Slang as cross-compilation pipeline (future) | 3-5 days | Reduces shader maintenance for 607+ GLSL + 45 WGSL |
| 🟡 Low | WebGL→WebGPU post-processing bridge (hybrid mode) | 2-3 days | Post-processing for WebGL users |
| 🔴 None | Core WebGPU context/buffer/compute from `device` branch | — | Already far surpassed |

---

## 2. Other WebGL→WebGPU Migrations Worth Studying

### 2.1 Babylon.js WebGPU (Most Mature)
**Status:** Full production WebGPU support since late 2023  
**Repo:** https://github.com/BabylonJS/Babylon.js (`src/Engines/WebGPU/`)

**Key architectural decisions worth studying:**
- **Abstract Engine Layer:** `ThinEngine` → `WebGPUEngine` and `Engine` (WebGL). All rendering goes through `ThinEngine` interface. We should study their abstraction boundaries.
- **WGSL Generation via SPIRV:** Babylon doesn't hand-write WGSL — they compile GLSL to SPIRV via glslang.js, then SPIRV to WGSL via spirv-cross-wasm. This is the "transpilation" approach (vs our "hand-written" approach).
- **Shader Processing Language (SPL):** They added a node-based shader system (NME - Node Material Editor) that targets both backends.
- **Snapshot Rendering:** Pre-records render bundles for static scenes — huge CPU savings for terrain-like scenarios. Directly applicable to our globe/terrain rendering.
- **Compute Shader Particles:** Full particle system on compute shaders — worth studying for our Phase 4.
- **Buffer Manager:** Sophisticated buffer pooling and sub-allocation — reduces GPU memory fragmentation. Our `WebGPUBuffer.ts` doesn't do sub-allocation.
- **Timestamp Query Integration:** Built-in GPU profiling with timestamp queries — we have no profiling infrastructure.

**Lessons for us:**
1. Their transpilation approach (GLSL→SPIRV→WGSL) means they maintain zero WGSL manually. Our approach (hand-written WGSL) is cleaner but 13x more maintenance.
2. Their `GPUBufferManager` does sub-allocation from large backing buffers — critical for terrain with thousands of tiles.
3. Their render bundle caching for static geometry is exactly what we need for globe terrain.

### 2.2 Three.js WebGPU (TSL Approach)
**Status:** Stable in r160+, default renderer path being considered  
**Repo:** https://github.com/mrdoob/three.js (`src/renderers/webgpu/`)

**Key innovations:**
- **Three Shading Language (TSL):** A node-based shader graph system that generates WGSL and GLSL from the same abstract description. No direct WGSL or GLSL authoring needed for standard materials.
- **WebGPURenderer as drop-in replacement:** `new THREE.WebGPURenderer()` works identically to `WebGLRenderer` from the API perspective.
- **Uniform Groups:** Automatic grouping of uniforms into bind groups by update frequency (per-frame, per-material, per-object). This is exactly what we need for efficient uniform buffer management.
- **Storage Buffer Objects:** First-class support for storage buffers for large datasets (point clouds, instancing data).
- **Compute Integration:** `renderer.computeAsync(computeNode)` for GPU compute that integrates naturally with the render loop.

**Lessons for us:**
1. TSL's "node-based shader abstraction" is the direction the industry is going. Hand-written WGSL/GLSL won't scale to 600+ shaders.
2. Their uniform grouping by update frequency (0=per-frame, 1=per-material, 2=per-object) maps well to WebGPU bind groups and reduces buffer updates. We should adopt this pattern.
3. Their `WebGPURenderer` maintains exact API compatibility with `WebGLRenderer` — reinforcing our approach of keeping the same `Viewer`/`Scene` API.

### 2.3 PlayCanvas WebGPU
**Status:** Full production support  
**Repo:** https://github.com/playcanvas/engine (`src/platform/graphics/webgpu/`)

**Key innovations:**
- **GPU-Driven Rendering:** Uses indirect draw calls with GPU-side culling. Compute shader writes draw call parameters. This is the highest-performance approach for large scenes.
- **Render Bundles for Static Meshes:** Pre-encodes draw commands for meshes that don't change frame-to-frame.
- **Dynamic Buffer Sub-Allocation:** Ring-buffer allocator for per-frame uniform data — zero GPU buffer creation per frame.
- **Texture Compression:** First-class support for ASTC, BC, ETC2 compressed textures via WebGPU's native compressed format support.

**Lessons for us:**
1. GPU-driven rendering with indirect draw calls is the #1 performance feature for 3D Tiles (thousands of draw calls → one draw call).
2. Ring-buffer uniform allocation eliminates per-frame buffer creation overhead.
3. Compressed texture support is critical for satellite imagery tiles.

### 2.4 GEngine (CesiumJS-inspired WebGPU engine)
**Repo:** https://github.com/GEngine-js/GEngine  
Referenced in CesiumGS/cesium#4989 as having "a similar rendering layer package to cesium."

**Key observations:**
- Purpose-built for WebGPU from the ground up (not a migration)
- Uses `DrawCommand` pattern similar to CesiumJS
- May have useful abstractions for CesiumJS-style rendering patterns in WebGPU

### 2.5 mapbox-gl-js → MapLibre GL
**Status:** MapLibre is exploring WebGPU experimentally  
**Relevance:** Similar problem domain (map rendering, terrain, tile streaming)

---

## 3. WebGPU Spec Compliance Audit

### Our Current State

| Category | Status |
|----------|--------|
| **@webgpu/types version** | `^0.1.67` (latest: `0.1.69` — **2 versions behind**) |
| **WebGPU core spec** | Using the stable W3C spec from Chrome 113+ |
| **Features requested at device creation** | **NONE** — `requiredFeatures: []`, `requiredLimits: {}` (all defaults!) |
| **Advanced API features used** | **NONE** — no render bundles, no timestamp queries, no indirect draw, no storage textures, no subgroups, no f16 |

### Features We're Using (Core Only)

✅ Used:
- `requestAdapter()` / `requestDevice()`
- `createBuffer()` / `createTexture()` / `createSampler()`
- `createShaderModule()` (WGSL)
- `createRenderPipeline()` / `createRenderPipelineAsync()`
- `createComputePipeline()` / `createComputePipelineAsync()`
- `createBindGroup()` / `createBindGroupLayout()`
- `createCommandEncoder()` / `beginRenderPass()` / `beginComputePass()`
- `device.queue.writeBuffer()` / `device.queue.writeTexture()`
- `device.queue.submit()`
- `device.lost` promise
- Canvas `configure()` with `alphaMode`

### Features We're NOT Using (Available Since Chrome 113+)

❌ **Not using any optional WebGPU features:**

| Feature | Since | Benefit for CesiumJS | Priority |
|---------|-------|---------------------|----------|
| `timestamp-query` | Chrome 121+ | GPU-side performance profiling | 🟢 Low |
| `float32-filterable` | Chrome 121+ | Linear filtering on float32 textures (terrain height maps, elevation data) | 🟡 Medium |
| `rg11b10ufloat-renderable` | Chrome 121+ | HDR render targets for post-processing | 🟡 Medium |
| `shader-f16` | Chrome 121+ | Half-precision floats in shaders (reduce memory, faster math) | 🟡 Medium |
| `dual-source-blending` | Chrome 128+ | OIT (Order-Independent Transparency) — native dual-source blending | 🔴 High |
| `clip-distances` | Chrome 128+ | User clip planes (clipping planes/polygons feature) | 🔴 High |
| `subgroups` | Chrome 132+ (Origin Trial) | SIMD-like operations within a workgroup (atmosphere scattering, point cloud processing) | 🟡 Medium |
| `chromium-experimental-read-write-storage-texture` | Chrome 124+ | Read-write storage textures for compute (terrain processing) | 🟡 Medium |

### API Surface Not Used

| API | What It Does | Why We Need It |
|-----|-------------|----------------|
| `createRenderBundleEncoder()` | Pre-encode draw commands | Static terrain, buildings — major CPU savings |
| `createQuerySet()` + `timestamp` | GPU timing queries | Performance profiling |
| `drawIndirect()` / `drawIndexedIndirect()` | GPU-driven draw calls | 3D Tiles: GPU controls which tiles to draw |
| `dispatchWorkgroupsIndirect()` | GPU-driven compute dispatch | Dynamic workload sizing |
| `GPUExternalTexture` / `importExternalTexture()` | Video textures without copy | Streaming imagery/video overlays |
| `device.queue.copyExternalImageToTexture()` | Efficient image→texture upload | Satellite imagery tile upload |
| `buffer.mapAsync()` + `getMappedRange()` | Direct CPU↔GPU buffer access | Terrain data upload, pick readback |

---

## 4. Latest WebGPU Features We Should Use

### Immediate Priorities (Should Enable Now)

#### 1. `float32-filterable` Feature
**Why:** Terrain elevation data and heightmaps use float32 textures. Without this feature, we can't linearly filter them — must use nearest-neighbor or manual filtering in the shader. Enabling this gives us hardware-accelerated bilinear filtering of elevation data.

```typescript
// Should request at device creation:
requiredFeatures: ['float32-filterable']
```

#### 2. `clip-distances` Feature
**Why:** CesiumJS's `ClippingPlaneCollection` currently uses stencil-based clipping. With `clip-distances`, we can use GPU-native clip planes — simpler, faster, and more correct.

```wgsl
// In WGSL shader:
enable clip_distances;
@builtin(clip_distances) var<out> clipDistances: array<f32, 4>;
```

#### 3. `dual-source-blending` Feature
**Why:** Our #1 visual quality gap is OIT (Order-Independent Transparency). Dual-source blending enables weighted-average OIT in a single render pass (vs the current WebGL approach using MRT). This is the most efficient OIT approach.

```typescript
requiredFeatures: ['dual-source-blending']
```

#### 4. Render Bundles
**Why:** For globe terrain rendering, we'll have hundreds of terrain tiles that don't change command structure frame-to-frame. Pre-encoding these as render bundles can reduce CPU overhead by 50-80%.

```typescript
const bundleEncoder = device.createRenderBundleEncoder({
  colorFormats: [canvasFormat],
  depthStencilFormat: 'depth24plus-stencil8'
});
// Encode all terrain tile draw commands once
bundleEncoder.setPipeline(terrainPipeline);
for (const tile of staticTiles) {
  bundleEncoder.setVertexBuffer(0, tile.vertexBuffer);
  bundleEncoder.draw(tile.vertexCount);
}
const bundle = bundleEncoder.finish();
// Reuse every frame:
renderPass.executeBundles([bundle]);
```

### Medium-Term (Phase 2-3)

#### 5. Indirect Drawing
**Why:** For 3D Tiles with thousands of models, we can use a compute shader to do frustum/occlusion culling on the GPU, then write draw parameters to an indirect buffer. One `drawIndexedIndirect()` call replaces thousands of CPU-side draw calls.

#### 6. `shader-f16` Feature
**Why:** Normal vectors, texture coordinates, and colors can use f16 precision — halves memory bandwidth and vertex buffer sizes. CesiumJS terrain has millions of vertices where f16 normals would be sufficient.

#### 7. `copyExternalImageToTexture()`
**Why:** Satellite imagery tiles arrive as `ImageBitmap` objects. `copyExternalImageToTexture()` uploads them directly to a GPU texture without intermediate CPU copies. This is critical for imagery layer performance.

### Longer-Term (Phase 4+)

#### 8. Subgroup Operations
**Why:** SIMD-like operations within a workgroup. Useful for:
- Prefix sum in point cloud rendering
- Reduction operations in atmosphere scattering LUT computation
- Efficient histogram computation for HDR tonemapping

#### 9. `GPUExternalTexture` / Video Textures
**Why:** CesiumJS has video imagery providers. `importExternalTexture()` allows zero-copy video frame → texture upload.

---

## 5. WebAssembly Optimization Opportunities

### Current WASM Usage in CesiumJS

CesiumJS already uses WebAssembly via `TaskProcessor.initWebAssemblyModule()`:

| Module | File | Purpose |
|--------|------|---------|
| **Draco** | `ThirdParty/draco_decoder.wasm` | Compressed mesh decoding (3D Tiles, I3S) |
| **Basis/KTX2** | `ThirdParty/basis_transcoder.wasm` | GPU texture format transcoding |
| **Gaussian Splats** | `ThirdParty/wasm_splats_bg.wasm` | Radix sort + texture generation (Rust) |
| **ZIP** | `ThirdParty/zip-module.wasm` (via web worker) | Deflate/inflate for KML |

All use the existing `TaskProcessor` → Web Worker → WASM pipeline.

### High-Value WASM Opportunities (Not Yet Implemented)

#### 🔴 Priority 1: Terrain Tessellation

**File:** `packages/engine/Source/Core/HeightmapTessellator.js`  
**Self-documented as:** *"This function tends to be a performance hotspot for terrain rendering, so it employs a lot of inlining and unrolling as an optimization."*

This function processes heightmap data into terrain mesh vertices/indices. It runs in a Web Worker (`createVerticesFromHeightmap`). Current JS implementation is heavily hand-optimized but still CPU-bound.

**WASM opportunity:**
- Heightmap → vertex generation (nested loops over Float32/Float64 arrays)
- Normal computation (cross products over grid)
- Skirt generation (terrain tile edges)
- **Expected speedup:** 2-5x for terrain processing
- **Effort:** 3-5 days (Rust + wasm-bindgen, integrate with existing TaskProcessor)
- **Already runs in Web Worker** — WASM integration is straightforward

#### 🔴 Priority 2: Quantized Mesh Decoding

**File:** `packages/engine/Source/Core/QuantizedMeshTerrainData.js`  
**Worker:** `createVerticesFromQuantizedTerrainMesh`

Decodes quantized (compressed) terrain mesh data from Cesium ion. Processes uint16 zigzag-encoded arrays, generates vertices, computes normals, creates skirts. Runs in a Web Worker.

**WASM opportunity:**
- Zigzag decode + delta decode of vertex positions
- Edge index generation
- Normal computation via octahedron encoding
- **Expected speedup:** 3-8x (integer-heavy workload benefits most from WASM)
- **Effort:** 3-5 days

#### 🟡 Priority 3: Frustum Culling (BoundingSphere Intersection)

**File:** `packages/engine/Source/Core/BoundingSphere.js` — `intersectPlane()`, `distanceSquaredTo()`  
**Called:** Thousands of times per frame for tile visibility testing

Each tile's bounding sphere is tested against 6 frustum planes per frame. For dense 3D Tiles scenes, this means 10,000+ intersection tests.

**WASM opportunity:**
- Batch frustum culling: pass array of bounding spheres + frustum planes, return visibility bitmask
- SIMD (128-bit SIMD in WASM) for 4x parallel sphere-plane tests
- **Expected speedup:** 4-10x with SIMD
- **Effort:** 3-5 days
- **Alternative:** GPU compute culling (even faster, but more complex)

#### 🟡 Priority 4: Matrix Operations (Batch)

**File:** `packages/engine/Source/Core/Matrix4.js`  
**Called:** Per-entity, per-frame for model-view-projection computation

Individual `Matrix4.multiply()` calls are fast in JS. But batch operations (e.g., computing model matrices for thousands of entities) would benefit from WASM SIMD.

**WASM opportunity:**
- Batch matrix multiply: process array of matrices in one call
- WASM SIMD for 4x parallel f32 operations
- **Expected speedup:** 2-4x for batch operations
- **Effort:** 2-3 days

#### 🟡 Priority 5: EncodedCartesian3 (RTE Encoding)

**File:** `packages/engine/Source/Core/EncodedCartesian3.js`  
**Called:** Per-vertex for all world-space geometry

Splits 64-bit positions into high/low 32-bit pairs. For terrain with millions of vertices, this is significant CPU work.

**WASM opportunity:**
- Batch encode: process array of positions in one call
- WASM f64 operations are natively supported
- **Expected speedup:** 2-3x
- **Effort:** 1-2 days

#### 🟢 Priority 6: Point Cloud Processing

**File:** Various point cloud files in Scene/  
**Use case:** LiDAR data with millions of points

Point cloud attribute decoding, quantization, spatial indexing.

**WASM opportunity:**
- Octree construction
- Level-of-detail computation
- Attribute decompression
- **Expected speedup:** 3-5x
- **Effort:** 5-7 days

### WASM Threading Opportunities

CesiumJS already uses Web Workers for parallelism. WASM SharedArrayBuffer + threads could add:

1. **Parallel terrain tessellation:** Process multiple terrain tiles simultaneously in a single WASM instance with threads
2. **Parallel frustum culling:** Split bounding sphere array across threads
3. **Parallel mesh decoding:** Draco + quantized mesh decoding in parallel

**Prerequisite:** COOP/COEP headers for SharedArrayBuffer. CesiumJS's `server.js` would need to set:
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

### GPU Compute vs WASM: When to Use Which

| Task | WASM (CPU) | GPU Compute | Recommendation |
|------|-----------|-------------|----------------|
| Terrain tessellation | ✅ Good (Web Worker) | ❌ Complex data deps | **WASM** |
| Frustum culling | ✅ Good (SIMD) | ✅ Better (thousands of tiles) | **GPU Compute** for 3D Tiles, **WASM** for terrain |
| Matrix batch multiply | ✅ Good (SIMD) | ⚠️ Overkill | **WASM** |
| Point cloud sort/LOD | ✅ Acceptable | ✅ Much better | **GPU Compute** |
| Atmosphere LUT | ⚠️ Slow | ✅ Perfect (ray marching) | **GPU Compute** |
| RTE encoding | ✅ Good | ⚠️ Requires readback | **WASM** |
| 3D Tiles occlusion culling | ⚠️ Limited | ✅ Perfect (hierarchical Z) | **GPU Compute** |

---

## 6. Recommendations & Action Items

### Immediate (This Sprint)

| # | Action | Effort | Impact |
|---|--------|--------|--------|
| 1 | **Update `@webgpu/types` to 0.1.69** | 10 min | Latest type definitions |
| 2 | **Request `float32-filterable` feature at device creation** | 30 min | Terrain heightmap filtering |
| 3 | **Request `clip-distances` feature** (if available) | 30 min | Clipping plane support |
| 4 | **Request `dual-source-blending` feature** (if available) | 30 min | OIT preparation |
| 5 | **Implement uniform grouping by update frequency** (per-frame / per-material / per-object) | 2-3 days | Reduces buffer updates, matches industry best practice |

### Short-Term (Next 2-4 Weeks)

| # | Action | Effort | Impact |
|---|--------|--------|--------|
| 6 | **Implement render bundle support** for static terrain tiles | 3-4 days | 50-80% CPU reduction for globe |
| 7 | **Use `copyExternalImageToTexture()`** for imagery tile upload | 1-2 days | Faster satellite imagery loading |
| 8 | **WASM terrain tessellation** (HeightmapTessellator) | 3-5 days | 2-5x terrain processing speed |
| 9 | **WASM quantized mesh decoder** | 3-5 days | 3-8x mesh decoding speed |
| 10 | **Add GPU timestamp queries** for profiling | 1-2 days | Enable performance measurement |

### Medium-Term (1-3 Months)

| # | Action | Effort | Impact |
|---|--------|--------|--------|
| 11 | **Implement indirect drawing** for 3D Tiles | 5-7 days | GPU-driven rendering |
| 12 | **GPU compute frustum culling** | 3-5 days | Eliminates CPU bottleneck for large scenes |
| 13 | **Evaluate Slang compiler** for dual GLSL/WGSL maintenance | 3-5 days | Long-term shader maintenance |
| 14 | **Buffer sub-allocator** (ring buffer for per-frame data) | 3-4 days | Zero per-frame buffer creation |
| 15 | **WASM batch frustum culling with SIMD** | 3-5 days | 4-10x culling speed |

### Long-Term (3-6 Months)

| # | Action | Effort | Impact |
|---|--------|--------|--------|
| 16 | **Subgroup operations** for atmosphere/point clouds | 2-3 days | SIMD-like shader performance |
| 17 | **shader-f16** for reduced memory bandwidth | 2-3 days | Halves vertex buffer sizes |
| 18 | **Video texture via `GPUExternalTexture`** | 1-2 days | Zero-copy video imagery |
| 19 | **Full shader abstraction layer** (like TSL or Slang) | 10-15 days | Unify GLSL/WGSL maintenance |
| 20 | **WASM threading** for parallel terrain processing | 5-7 days | Multi-threaded WASM workers |

---

## Key Takeaways

1. **The CesiumGS hackathon branches are small proofs-of-concept.** Our implementation is vastly more comprehensive. The only interesting idea is the Slang shader pipeline from `webgpu-hackathon`, which we should monitor but not adopt yet.

2. **We're using the WebGPU core spec correctly but not taking advantage of ANY optional features.** We should immediately enable `float32-filterable`, `clip-distances`, and `dual-source-blending`, and implement render bundles and indirect drawing.

3. **Other engines (Babylon.js, Three.js, PlayCanvas) are 1-2 years ahead on WebGPU features.** Key patterns we should adopt: render bundles for static geometry, uniform grouping by update frequency, buffer sub-allocation, and GPU-driven rendering.

4. **WASM has immediate high-value opportunities:** HeightmapTessellator and QuantizedMeshTerrainData are self-identified performance hotspots that already run in Web Workers. Converting them to WASM (Rust + wasm-bindgen) is straightforward and would yield 2-8x speedups.

5. **GPU compute should replace CPU culling for large scenes.** For 3D Tiles with thousands of tiles, GPU compute frustum/occlusion culling is the industry-standard approach (used by PlayCanvas and Unreal Engine's Nanite).

6. **Our `@webgpu/types` is 2 minor versions behind** (0.1.67 vs 0.1.69). Should update.
