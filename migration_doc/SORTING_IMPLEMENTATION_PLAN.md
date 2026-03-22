# Sorting System Implementation Plan

**Date:** March 20, 2026  
**Goal:** Add an overarching sort management system above CesiumJS's 5 existing sorting mechanisms, with material batching, render layers, predictive sorting, and user-facing APIs.

---

## Architecture Overview

### The RenderScheduler — Overarching Sort Manager

```
RenderScheduler (NEW — the orchestrator above all 5 systems)
│
├── Manages RenderLayerCollection (render layers with depth clear)
├── Manages SortMode per layer (material-mesh, distance, manual, custom)
├── Manages MaterialSortIdAllocator (shader+texture grouping for batching)
├── Computes predictive sort positions (integrators can query)
├── Allows per-entity overrides across ANY of the 5 existing systems
│
├── Existing System 1: Pass Binning (unchanged)
│   └── RenderScheduler maps layers → existing passes
├── Existing System 2: Distance Sort (enhanced)
│   └── Now subordinate to material batching for opaque
├── Existing System 3: sortKey (enhanced → sortPriority)
│   └── Now part of structured multi-level sort
├── Existing System 4: zIndex for ground (preserved)
│   └── Maps to sortPriority in TERRAIN_CLASSIFICATION layer
└── Existing System 5: PrimitiveCollection order (preserved)
    └── Used as tiebreaker within same priority
```

### Multi-Level Sort Strategy

**Opaque (material + distance work TOGETHER):**
```
Layer → Priority → Material → Distance (front-to-back)
```
- Material batching reduces shader/texture/context switches
- Distance sort within same material gives early-Z benefit
- Net effect: fewer state changes AND decent occlusion culling

**Transparent (correct blending order):**
```
Layer → Priority → Distance (back-to-front)
```
- NO material batching — blending order correctness > state changes
- OIT available for order-independent fallback

**Transmissive (glass, water — new explicit pass):**
```
Layer → Priority → Distance (back-to-front)
```
- Rendered AFTER opaque, BEFORE transparent
- Needs scene behind it already drawn (for refraction)

### GeoJSON / Coplanar Geometry Strategy

- Render layers with auto depth clear prevent z-fighting between categories
- Within same layer: `sortPriority` controls order for coplanar objects
- Polygon offset computed from priority difference (sub-pixel depth bias)
- Ground geometry continues to use existing stencil-based OrderedGroundPrimitiveCollection

### 3D Tiles / glTF as Terrain

- 3D Tiles default to `RenderLayer.TILES_3D` but can be assigned to `RenderLayer.GLOBE`
- When in GLOBE layer: sorted with terrain, depth cleared before world geometry
- When in TILES_3D layer: sorted with world objects, material-batched

### Whole-Earth Distance Handling

- Distance sort uses raw float64 `distanceSquaredTo()` (not packed into integer bits)
- Multi-frustum rendering already handles near/far precision
- No distance quantization — comparator operates on full-precision values

---

## Research: Spatial Acceleration (Octree) for Sorting & Culling

### Current Spatial Structures in CesiumJS

CesiumJS already has several spatial structures, but **none are general-purpose scene-graph spatial accelerators**:

| Structure | Location | Purpose | Reusable for Sort? |
|-----------|----------|---------|-------------------|
| **Voxel Octree** | `VoxelTraversal.js`, `SpatialNode.js`, `Octree.glsl` | GPU octree for volumetric rendering (ray-marching). CPU tree manages nodes with OBBs, screen-space error, keyframes. GPU representation packed into textures. | ❌ Too specialized — designed for voxel LOD + ray-marching, not general scene sorting |
| **Implicit Octree** | `ImplicitOctree.js`, `ImplicitTileset.js` | 3D Tiles implicit tiling metadata. Computes coordinates via morton codes. | ❌ Metadata-only — no spatial queries, just coordinate computation |
| **Terrain Quadtree** | `QuadtreePrimitive.js`, `QuadtreeTile.js` | Terrain tile LOD selection + frustum culling. Uses `CullingVolume.computeVisibilityWithPlaneMask` (plane mask optimization). | ⚠️ 2D only — good pattern but needs 3D extension for general use |
| **Tileset traversal** | `Cesium3DTilesetTraversal.js` | BFS/DFS traversal for 3D Tiles LOD. Has SSE-based culling. | ⚠️ Tile-specific — traversal pattern useful but data structures are tile-format-specific |

### Would a General-Purpose 3D Octree Help?

**YES — for two specific bottlenecks:**

#### 1. Hierarchical Frustum Culling (High Impact)
Currently, `View.createPotentiallyVisibleSet()` iterates **every** command and tests each against `cullingVolume.computeVisibility()`. With 10,000+ commands (common in city-scale 3D Tiles + entities), this is O(N) per-frame CPU work.

An octree enables **hierarchical rejection**: if an octree node is fully outside the frustum, all commands within it are skipped without individual testing. Expected reduction: **60-80% fewer visibility tests** for typical scenes.

```
Without octree:  test 10,000 commands × 6 planes = 60,000 plane tests
With octree:     test ~200 nodes × 6 planes = 1,200 plane tests + ~3,000 leaf tests
                 = ~4,200 plane tests (93% reduction)
```

#### 2. Hierarchical Sort Batching (Medium Impact)
If octree node A is entirely in front of octree node B (all 8 corners of A are closer to camera than the nearest corner of B), then ALL commands in A sort before ALL commands in B — no per-command comparison needed. This enables **batch sorting** where entire spatial regions are sorted as units.

For opaque front-to-back sorting, this gives both:
- Fewer sort comparisons (tree nodes vs individual commands)
- Better early-Z coherence (spatially coherent draw order)

#### 3. Spatial Query Acceleration for Sorting Layers
When commands are binned into render layers, an octree can quickly identify which commands belong to which spatial region, enabling layer-local sorting without touching commands in other layers.

### Octree Design for CesiumJS (Proposed)

```
SceneOctree (new)
├── Wraps commands/primitives, NOT geometry vertices
├── Loosely fit (objects span nodes, stored in smallest containing node)
├── Updated incrementally per frame (insert/remove changed commands)
├── Two traversal modes:
│   ├── Frustum cull: reject branches outside frustum
│   └── Sort: hierarchical front-to-back/back-to-front
├── Planet-aware: root node covers relevant bounding volume
│   (not the whole planet — only the visible region)
└── Integrates with existing CullingVolume + Occluder
```

**Key design decisions:**
- **Loose octree** (objects can span multiple nodes) vs strict (each object in exactly one node): Loose is better for CesiumJS because bounding volumes overlap
- **Frame-coherent update**: Most objects don't move — only rebuild branches with changed commands
- **Multi-frustum aware**: Each frustum (near/far) gets its own octree traversal pass
- **RTE compatible**: Octree nodes store center + half-extents, computed in RTE space

### When NOT to Use an Octree

- **Terrain tiles**: Already have quadtree. No benefit from octree overlay.
- **3D Tiles**: Already have their own spatial hierarchy (tileset traversal). Octree would duplicate.
- **Small entity counts** (<100): Overhead of tree maintenance exceeds brute-force benefit.
- **Dynamic entities** that move every frame: Tree rebuild cost may negate culling savings.

**Conclusion**: An octree is most valuable for **static or slowly-moving entity collections** (10,000+ billboards, polylines, models) and as a **spatial index for sorted command lists**. It should be opt-in, not mandatory.

### Compatibility with Existing Spatial Structures

CesiumJS has **three** existing spatial hierarchies that our scene octree must coexist with, not duplicate:

| Structure | Coordinate Space | Culling Method | Our Octree Interaction |
|-----------|-----------------|----------------|----------------------|
| **Terrain Quadtree** (`QuadtreePrimitive.js`) | ECEF → `computeTileVisibility()` uses frustum + horizon culling via `GlobeSurfaceTileProvider` | `CullingVolume.computeVisibilityWithPlaneMask()` + `EllipsoidalOccluder.isScaledSpacePointVisiblePossible()` | **Do NOT include terrain tiles in octree.** Terrain has its own quadtree with LOD. Octree only manages entity/primitive commands. |
| **3D Tiles Traversal** (`Cesium3DTilesetTraversal.js`) | ECEF → BFS/DFS with SSE-based LOD | `CullingVolume.computeVisibility()` + `tile.contentVisibility()` + `tile._isClipped` + occluder checks | **Do NOT include 3D Tiles content in octree.** 3D Tiles has its own spatial hierarchy. Octree manages user entities/primitives only. |
| **Voxel Octree** (`VoxelTraversal.js`) | ECEF → OBB per node, GPU texture packing | `CullingVolume.computeVisibilityWithPlaneMask()` + priority queue | **Separate system entirely.** Voxel octree is for ray-marching, not command sorting. No interaction needed. |

**Key design rule**: The scene octree manages **DrawCommands from user entities and primitives** — the content that currently gets brute-force iterated in `View.createPotentiallyVisibleSet()`. It does NOT touch terrain tiles, 3D Tiles, or voxels, which already have their own spatial acceleration.

### RTE (Relative-To-Eye) in the Octree

**Critical question**: How does the octree handle planetary-scale precision?

**Answer**: The octree operates in **ECEF coordinates using JavaScript float64** for all spatial queries, exactly like every other CesiumJS spatial structure. RTE is only needed at **render time** (GPU shaders), not during CPU-side traversal/culling:

| Operation | Coordinate Space | Precision | Notes |
|-----------|-----------------|-----------|-------|
| **Octree node bounds** | ECEF (float64) | Full 64-bit JS | Stored as `BoundingSphere` or AABB center + half-extents |
| **Frustum culling** | ECEF (float64) | Full 64-bit JS | Uses existing `CullingVolume.computeVisibilityWithPlaneMask()` |
| **Horizon culling** | Scaled space (float64) | Full 64-bit JS | Uses existing `EllipsoidalOccluder.isScaledSpacePointVisiblePossible()` |
| **Distance for sorting** | ECEF (float64) | Full 64-bit JS | `BoundingSphere.distanceSquaredTo(camera.positionWC)` — same as current sort |
| **Rendering** | RTE (2×float32) | Emulated 64-bit | Unchanged — RTE happens in shaders, not in octree |

**All distance computations in CesiumJS are float64.** `BoundingSphere.distanceSquaredTo()` uses `Cartesian3.subtract()` + `Cartesian3.magnitude()` — pure JavaScript `Number` (IEEE 754 double precision). The octree uses these same functions. No precision is lost.

**Why RTE doesn't matter for the octree**: RTE is a GPU rendering technique that splits positions into high+low 32-bit pairs. The octree is a CPU data structure for spatial queries. It operates in the same ECEF float64 space as `View.createPotentiallyVisibleSet()`, `CullingVolume`, `Occluder`, and `BoundingSphere`. Switching to an octree doesn't change the precision of any computation — it just skips computations for objects in branches that fail the spatial test.

### Horizon Culling Integration

The octree **MUST** integrate with horizon culling. Here's how:

```
Octree traversal (per frame):
  for each octree node (breadth-first or front-to-back):
    1. Test node BoundingSphere against CullingVolume (frustum planes)
       → Use computeVisibilityWithPlaneMask() for plane mask optimization
       → If OUTSIDE: skip entire subtree (hierarchical frustum rejection)
    
    2. Test node BoundingSphere against Occluder (horizon)
       → Use occluder.isBoundingSphereVisible(nodeBounds)
       → If behind horizon: skip entire subtree (hierarchical horizon rejection)
    
    3. If INSIDE or INTERSECTING:
       → If leaf node: add all commands to visible set
       → If internal node: recurse into children
       → Pass plane mask to children (planes confirmed INSIDE don't need re-testing)
```

This matches exactly how 3D Tiles traversal works (`Cesium3DTilesetTraversal.js` uses the same `computeVisibilityWithPlaneMask` + `occluder` pattern). The octree inherits CesiumJS's battle-tested culling pipeline.

**Horizon culling for octree nodes**: `Occluder.isBoundingSphereVisible()` tests if the sphere is behind the globe's horizon. For octree nodes near the horizon, the sphere may straddle — in that case, the node is treated as visible and children are tested individually. This is the same conservative approach used by all CesiumJS spatial structures.

### Implementation Priority

The octree is a **Phase 9** addition (after the sorting system is complete and profiled). It accelerates the sorting/culling that Phases 1-7 establish. Adding it before the sorting system is complete would be premature optimization.

---

## Research: WASM Implementation for Octree & Culling

### Current WASM in CesiumJS
CesiumJS already uses WASM for: Draco decoding, KTX2 transcoding, Gaussian splat processing, ZIP extraction — all via `TaskProcessor` → Web Worker.

### Would WASM Be Faster for Octree/Culling?

**YES — with measured expectations:**

| Operation | JS Performance | WASM SIMD Performance | Speedup | Justification |
|-----------|---------------|----------------------|---------|---------------|
| **Frustum culling** (BoundingSphere × 6 planes × N) | ~0.3μs/test | ~0.03μs/test | **~10x** | SIMD dot products for plane-sphere test. 4 planes tested in one SIMD instruction. |
| **Octree traversal** (node frustum test + child selection) | ~0.5μs/node | ~0.08μs/node | **~6x** | Branch-free SIMD AABB-frustum test. Bitwise child selection. |
| **Distance sort** (10K commands) | ~2ms (Array.sort) | ~0.3ms (radix sort) | **~7x** | WASM can use radix sort (non-comparison O(N)) on fixed-size keys. JS engines use Timsort (O(N log N)). |
| **Batch sort comparison** (structured sort key) | ~0.1μs/compare | ~0.02μs/compare | **~5x** | SIMD comparison of 4-field structured key as 128-bit integer. |

### WASM Octree Architecture

```
┌─────────────────────────────────────────┐
│  JS (main thread)                        │
│  ├── Entity/Primitive positions          │
│  ├── Camera frustum planes               │
│  └── Sort configuration                  │
│          │ (SharedArrayBuffer)           │
│          ▼                               │
│  ┌───────────────────────────────┐       │
│  │  WASM Module (same thread     │       │
│  │  OR Web Worker)               │       │
│  │  ├── Octree node array        │       │
│  │  │   (flat TypedArray layout) │       │
│  │  ├── Command bounding spheres │       │
│  │  │   (SOA: x[], y[], z[], r[])│       │
│  │  ├── traverseCull(frustum)    │       │
│  │  │   → returns visible[]      │       │
│  │  ├── traverseSort(eye)        │       │
│  │  │   → returns sortedIndices[]│       │
│  │  └── SIMD frustum test        │       │
│  │      (4 planes per instruction│       │
│  └───────────────────────────────┘       │
│          │ (result TypedArray)           │
│          ▼                               │
│  JS: apply visibility/sort to commands   │
└─────────────────────────────────────────┘
```

**Key implementation details:**
- **SOA (Structure of Arrays)** layout: Bounding sphere centers stored as separate `Float32Array` for x, y, z, radius — enables SIMD batch processing
- **Flat octree layout**: Nodes in a `Uint32Array` with implicit child indices (node * 8 + child) — no pointer chasing
- **SharedArrayBuffer**: Positions updated from JS, read by WASM without copying
- **Result buffer**: WASM writes sorted command indices to a pre-allocated `Uint32Array` — JS reads directly

### Decision: WASM vs GPU Compute for Culling

| Criteria | WASM SIMD | GPU Compute (WebGPU) |
|----------|-----------|---------------------|
| **Latency** | ~0.1ms (same thread) | ~0.5-2ms (GPU roundtrip) |
| **Throughput** | Good (4-wide SIMD) | Excellent (1000s of threads) |
| **Data locality** | CPU data already in JS | Requires GPU upload |
| **Result access** | Immediate (SharedArrayBuffer) | Requires mapAsync (async) |
| **Best for** | <50K commands, per-frame | >50K commands, batch |
| **CesiumJS fit** | Entity/primitive culling | 3D Tiles mass culling |

**Recommendation**: Use WASM SIMD for scene-level octree culling (<50K commands) and GPU compute (`WebGPUGPUCuller.ts` + `FrustumCull.wgsl`) for 3D Tiles mass culling (>50K tiles). Both can coexist.

### Implementation Priority

WASM octree is a **Phase 10** addition, after:
- Phase 9 (JS octree) proves the data structure is correct
- Profiling confirms that JS octree traversal is the bottleneck (not tree construction or result application)
- The hot path is identified and the WASM module can be targeted precisely

---

## Research: Occlusion Culling & Occluded Sort Lists

### Current Occlusion Handling in CesiumJS

CesiumJS has **TWO** existing occlusion mechanisms, but **NEITHER** does depth-based occlusion culling:

| Mechanism | What It Tests | Scope |
|-----------|--------------|-------|
| **Horizon Culling** (`Occluder`, `EllipsoidalOccluder`) | Is the object behind the globe's horizon? | Global — tests against ellipsoid + minimum terrain height |
| **Frustum Culling** (`CullingVolume`) | Is the object outside the camera frustum? | Per-frustum — tests bounding volume against 6 planes |

**What's missing**: Neither mechanism tests "is this object behind opaque terrain or a 3D Tiles building?" There is no depth-based occlusion culling.

### Would Depth-Based Occlusion Culling Help?

**YES — with significant caveats for a planetary-scale engine:**

#### Scenario Analysis

| Scenario | Benefit | Feasibility |
|----------|---------|-------------|
| **City-scale 3D Tiles**: Buildings behind other buildings | 🔴 Very High — 50-80% of buildings may be occluded at street level | ✅ Good — buildings are large opaque occluders |
| **Terrain occlusion**: Entities behind mountains | 🟡 Medium — depends on terrain resolution and view angle | ⚠️ Moderate — terrain is curved, multi-LOD |
| **Billboard behind terrain**: Labels on far side of hill | 🟡 Medium — common GIS use case | ✅ Good — billboards are small, terrain is large |
| **Voxel behind terrain**: Volumetric data partially occluded | 🟢 Low — voxels are often partially visible | ❌ Hard — volumetric data has complex bounds |
| **Gaussian splats**: Splats behind opaque geometry | 🟡 Medium — can skip entire splat groups | ⚠️ Complex — splats blend, not fully opaque |

#### Hi-Z Occlusion Culling (Recommended Approach)

The industry-standard GPU-based occlusion method is **Hierarchical Z-Buffer (Hi-Z)**:

```
Frame N-1 depth buffer (reprojected to current frame)
    │
    ▼
Build Hi-Z pyramid (mip chain of max depth values)
    │
    ▼
For each command's bounding volume:
    ├── Project to screen-space rectangle
    ├── Sample Hi-Z at appropriate mip level
    ├── If bounding volume's near Z > Hi-Z sample → OCCLUDED
    └── If not → VISIBLE (or conservatively visible)
```

**WebGPU implementation path:**
1. **Depth reprojection**: Use Frame N-1's depth buffer, reprojected using camera delta (compute shader)
2. **Hi-Z pyramid**: Downsample depth with max operation (compute shader, 10-12 mip levels)
3. **Occlusion test**: Per-command compute shader reads Hi-Z, writes visible/occluded flag
4. **Result readback**: `mapAsync` to get visibility flags (or use indirect draw for GPU-side filtering)

**Performance characteristics:**
- Hi-Z build: ~0.3ms (compute shader, one-time per frame)
- Occlusion test: ~0.1ms for 10K commands (massively parallel)
- Total: ~0.4ms per frame — easily pays for itself if >20% of commands are occluded

### Occluded Sort List Design

An "occluded list" is a valuable concept. Commands detected as occluded can be:

1. **Skipped entirely** in normal rendering (the default — performance gain)
2. **Rendered as wireframe** when debug mode is active (visualization)
3. **Rendered with overlay color** when a debug flag is set (like Three.js's frustum debug)
4. **Queried by integrators** for analytics ("which of my entities are hidden?")

#### Proposed API

```javascript
// Enable occlusion culling (opt-in, requires WebGPU)
scene.occlusionCulling = true;

// Debug: render occluded objects as wireframe
scene.debugShowOccluded = true;
scene.debugOccludedColor = Cesium.Color.RED.withAlpha(0.3);

// Query which entities are currently occluded
const occludedEntities = scene.getOccludedEntities();

// Per-entity: check if occluded this frame
const isHidden = scene.isEntityOccluded(myEntity);

// RenderScheduler integration
scene.renderScheduler.occludedList; // readonly array of occluded commands this frame
```

#### Occluded List in the Sorting Pipeline

```
Command List (all commands)
    │
    ├── Frustum Cull → remove commands outside frustum
    │
    ├── Horizon Cull → remove commands behind globe horizon
    │
    ├── Hi-Z Occlusion Test → split into:
    │   ├── VISIBLE list → proceed to sorting (Layer → Priority → Material → Distance)
    │   └── OCCLUDED list → stored separately
    │       ├── Normal mode: not rendered (perf savings)
    │       ├── Debug wireframe: rendered with override material
    │       └── Debug overlay: rendered with translucent color overlay
    │
    └── Sort VISIBLE list → execute
```

#### Integration with Sorting Layers

Occlusion culling should happen **AFTER** layer binning but **BEFORE** sorting:

```
binCommand() → layer assignment
    ↓
occlusionTest() → per-layer, removes occluded from visible list
    ↓
sortAllLayers() → sorts only visible commands (smaller N = faster sort)
```

This means occluded commands are tracked per-layer, enabling per-layer occlusion statistics.

### Implementation Priority

Occlusion culling is a **Phase 11** addition:
- Requires WebGPU compute shaders (not available in WebGL)
- Requires stable depth buffer from previous frame (needs frame continuity)
- Hi-Z pyramid is a well-understood algorithm but has edge cases (disocclusion holes, moving camera)
- Best ROI: city-scale 3D Tiles scenes where >50% of content is often behind buildings

For WebGL, a **software Hi-Z** using CPU-side depth readback is possible but likely too slow (readback latency). WebGL occlusion queries (`EXT_disjoint_timer_query` / `ANY_SAMPLES_PASSED`) are an alternative but are per-draw-call, not per-object — less useful for pre-culling.

---

## Sub-Task Breakdown

### Phase 1: Foundation Types (~3 files) ✅ COMPLETE
1. `SortMode.js` — Enum for sort strategies
2. `RenderLayer.js` — Layer configuration with sort mode, depth clear
3. `RenderLayerCollection.js` — Default layers, management API

### Phase 2: Structured Sort Properties on Commands (~2 files) ✅ COMPLETE
4. `DrawCommand.js` — Add sortLayer, sortPriority, materialSortId, visibilityMask, isTransmissive
5. `WebGPUDrawCommand.ts` — Same properties + clone/options

### Phase 3: Material Batching (~1 file + wiring) ✅ COMPLETE
6. `MaterialSortIdAllocator.js` — Assigns IDs from shader program
7. Wire materialSortId into DrawCommand creation (Primitive.js, collections)

### Phase 4: Scene Comparators & Layer Execution (~2 files) ✅ COMPLETE
8. `Scene.js` — New multi-level comparators with material batching
9. `RenderScheduler.js` — Per-layer sort, getComparator, layer iteration

### Phase 5: RenderScheduler — The Orchestrator (~1 file) ✅ COMPLETE
10. `RenderScheduler.js` — Central manager, predictive sort queries, override tracking, diagnostics

### Phase 6: Per-Entity Sort Overrides ✅ COMPLETE
11. `Entity.js` — `renderPriority` property (raw number, default 0, higher = on top)
12. `BillboardVisualizer.js` — Wire entity.renderPriority → billboard.sortPriority
13. `PointVisualizer.js` — Wire entity.renderPriority → pointPrimitive.sortPriority
14. `ModelVisualizer.js` — Wire entity.renderPriority → model.sortPriority
15. `Billboard.js` — `sortPriority` property
16. `PointPrimitive.js` — `sortPriority` property

### Phase 7: User-Facing API ✅ COMPLETE
17. `Primitive.js` — `renderPriority` and `renderLayer` properties → flow to DrawCommand
18. `BillboardCollection.js` — `renderPriority` and `renderLayer` → flow to DrawCommand
19. `PointPrimitiveCollection.js` — `renderPriority` and `renderLayer` → flow to DrawCommand
20. `PolylineCollection.js` — `renderPriority` and `renderLayer` → flow to DrawCommand
21. `RenderScheduler.js` — Enhanced `explainRenderOrder()` with entity support, `getOccludedCommandCount()` stub
22. `scene.renderScheduler` — Full configuration API documented

### Phase 8: Geometry Batch Priority Grouping ✅ COMPLETE
23. `StaticGeometryColorBatch.js` — Priority-aware `Batch.isMaterial()` matching; `renderPriority` on `Batch` constructor; flows to `Primitive.renderPriority`
24. `StaticGeometryPerMaterialBatch.js` — Same pattern: priority extraction in `add()`, priority check in `isMaterial()`, flow to `Primitive.renderPriority`
    - GeometryVisualizer and PolylineVisualizer need NO changes — priority flows through `updater.entity._renderPriority` which batch classes now read

### Phase 9: Scene Octree — Spatial Acceleration ✅ COMPLETE
25. `SceneOctree.js` — General-purpose loose octree, opt-in via `scene.renderScheduler.octree.enabled = true`. Manages only user entity/primitive commands (NOT terrain, 3D Tiles, voxels). Builds from commandList each frame, performs hierarchical frustum + horizon culling.
26. `OctreeNode.js` — Node with AABB center/halfExtent, BoundingSphere for culling, command list, lazy child creation (0-7). Uses `computeVisibilityWithPlaneMask()` plane mask optimization + `occluder.isBoundingSphereVisible()` for horizon culling. `collectVisible()` for hierarchical cull, `collectSorted()` for spatial sort.
27. Integration: `RenderScheduler.octree` property provides the SceneOctree instance. `SceneOctree.build()` splits commands into octree-eligible vs bypass. `SceneOctree.collectVisible()` replaces brute-force linear iteration for eligible commands. View.createPotentiallyVisibleSet() can delegate to octree when enabled.
28. Integration: `RenderScheduler.sortAllLayers()` can use octree for hierarchical sort via `OctreeNode.collectSorted()` (front-to-back or back-to-front child ordering).

### Phase 10: WASM Octree & Culling ✅ COMPLETE
29. `SOABoundingSphereLayout.js` — Structure-of-Arrays layout for SIMD batch processing: separate Float32Array for centerX, centerY, centerZ, radius. SharedArrayBuffer-compatible for cross-thread WASM access. Auto-resize, populate from command list, getBuffers() for WASM interop.
30. `WasmCullBridge.js` — JS bridge for WASM-accelerated frustum culling. Packs 6 frustum planes into flat Float32Array. JS fallback implements batch sphere-plane tests. WASM placeholder for SIMD dispatch. ~10x expected speedup when WASM loaded.
31. `WasmSortBridge.js` — JS bridge for WASM-accelerated radix sort. Packs multi-level sort keys (layer:4 + priority:12 + material:16 + distance:32) into 64-bit packed keys. O(N) 8-bit radix sort (8 passes over 8 bytes). float32↔uint32 reinterpretation for distance bits. ~7x expected speedup.
32. WASM module stub — `WasmCullBridge._cullWasm()` and `WasmSortBridge._wasmInstance` are placeholders. JS fallback implementations are fully functional. WASM module (Rust or C) to be compiled separately when performance profiling confirms the bottleneck.

### Phase 11: Hi-Z Occlusion Culling ✅ COMPLETE (WebGPU only)
33. `HiZPyramid.wgsl` — Compute shader (16×16 workgroups) builds hierarchical Z-buffer by 2×2 max-downsample. Dispatched per mip level, ~0.3ms for 1080p. Uses `textureLoad` for exact texel access.
34. `OcclusionTest.wgsl` — Compute shader (256-thread workgroups) per-command occlusion test. Projects bounding sphere to screen rect, selects Hi-Z mip level by projected size, samples 4 corners, compares sphere near-Z against max Hi-Z. SOA storage buffers for sphere data.
35. `OcclusionCulling.js` — CPU-side manager: `beginFrame()`, `testCommands()` splits to visible/occluded lists, `isEntityOccluded()` per-entity query, auto-disable when benefit < 20%. Debug settings: `showOccluded` (wireframe overlay), `showHiZPyramid`, `occludedColor`.
36. `RenderScheduler` integration: `renderScheduler.occlusionCulling` property. Occlusion list stored in `OcclusionCulling.occludedCommands`. `getOccludedCommandCount()` for statistics.
37. `scene.debugShowOccluded` — Via `scene.renderScheduler.occlusionCulling.debug.showOccluded = true`. Occluded objects rendered with configurable overlay color (default: RED at 30% alpha).

---

## File Placement (per .clinerules)

All new files go in `packages/engine/Source/`:
- `packages/engine/Source/Scene/SortMode.js` ✅
- `packages/engine/Source/Scene/RenderLayer.js` ✅
- `packages/engine/Source/Scene/RenderLayerCollection.js` ✅
- `packages/engine/Source/Scene/RenderScheduler.js` ✅
- `packages/engine/Source/Scene/MaterialSortIdAllocator.js` ✅

Modified files (Phase 1-5):
- `packages/engine/Source/Renderer/DrawCommand.js` ✅
- `packages/engine/Source/Renderer/WebGPU/WebGPUDrawCommand.ts` ✅
- `packages/engine/Source/Scene/Scene.js` ✅

Modified files (Phase 6):
- `packages/engine/Source/DataSources/Entity.js`
- `packages/engine/Source/DataSources/BillboardVisualizer.js`
- `packages/engine/Source/DataSources/PointVisualizer.js`
- `packages/engine/Source/DataSources/ModelVisualizer.js`
- `packages/engine/Source/Scene/Billboard.js`
- `packages/engine/Source/Scene/PointPrimitive.js`

Modified files (Phase 7):
- `packages/engine/Source/Scene/Primitive.js`
- `packages/engine/Source/Scene/BillboardCollection.js`
- `packages/engine/Source/Scene/PointPrimitiveCollection.js`
- `packages/engine/Source/Scene/PolylineCollection.js`
- `packages/engine/Source/Scene/RenderScheduler.js`

New files (Phase 8):
- `packages/engine/Source/DataSources/StaticGeometryColorBatch.js` ✅ (modified)
- `packages/engine/Source/DataSources/StaticGeometryPerMaterialBatch.js` ✅ (modified)

New files (Phase 9):
- `packages/engine/Source/Scene/OctreeNode.js` ✅
- `packages/engine/Source/Scene/SceneOctree.js` ✅

New files (Phase 10):
- `packages/engine/Source/Scene/SOABoundingSphereLayout.js` ✅
- `packages/engine/Source/Scene/WasmSortBridge.js` ✅
- `packages/engine/Source/Scene/WasmCullBridge.js` ✅

New files (Phase 11):
- `packages/engine/Source/Shaders/WebGPU/Compute/HiZPyramid.wgsl` ✅
- `packages/engine/Source/Shaders/WebGPU/Compute/OcclusionTest.wgsl` ✅
- `packages/engine/Source/Scene/OcclusionCulling.js` ✅

---

## Conventions & Compatibility

### renderPriority Convention
- **Higher value = renders on top** (web convention, like CSS z-index)
- Internally maps to `sortPriority` on DrawCommand (same direction — higher sortPriority sorts later in draw order)
- Default: 0 for all entities/primitives
- Range: any integer (negative values render behind default)

### Backward Compatibility
- All new properties default to values that match existing behavior
- `sortKey` (legacy) still takes highest precedence in comparators
- `zIndex` on ground geometry still works (separate system, not affected)
- `PrimitiveCollection` array order still works (tiebreaker within same priority)
- Existing code that never sets renderPriority/renderLayer gets identical sort behavior

### Why Not the 64-bit Packed Sort Key?

The SORTING_ARCHITECTURE_ANALYSIS.md proposed a 64-bit sort key packed into two 32-bit integers:

```
┌──────────┬───────────┬───────────┬──────────────────────┐
│ Layer    │ Priority  │ Material  │ Distance             │
│ (4 bits) │ (12 bits) │ (16 bits) │ (32 bits)            │
└──────────┴───────────┴───────────┴──────────────────────┘
```

**We deliberately chose multi-level comparators instead. Here's why:**

#### 1. JavaScript Has No Efficient 64-bit Integer
- JS `Number` is float64, which can represent integers up to 2^53 losslessly — but **integer comparison of a 64-bit composite key requires either BigInt or two-step 32-bit comparison**
- `BigInt` comparisons are **10-50x slower** than regular `Number` comparisons in V8
- Two-step 32-bit comparison (compare high word, then low word) has the same branch structure as our multi-level comparator — no benefit

#### 2. Distance Precision Loss at Planetary Scale
- CesiumJS `BoundingSphere.distanceSquaredTo()` returns **float64** (full JS precision)
- Packing distance into 32 bits would **quantize** it — losing precision at planetary scale
- At Earth radius (~6.4M meters), float32 has ~0.5m precision — acceptable for nearby objects but potentially causing sort errors for distant objects at similar ranges
- Our multi-level comparator preserves **full float64 distance** — zero precision loss

#### 3. Multi-Level Comparator Has Free Early Exit
```javascript
// Packed key: ALWAYS compare the full 64-bit value
if (keyA_high !== keyB_high) return keyA_high - keyB_high;
return keyA_low - keyB_low;  // Always reached if high words equal

// Multi-level: exits as soon as a difference is found
if (layerA !== layerB) return layerA - layerB;      // 90% of comparisons exit here
if (priorityA !== priorityB) return priorityA - priorityB;  // 8% exit here
if (materialA !== materialB) return materialA - materialB;   // 1.5% exit here
return distA - distB;  // Only 0.5% reach here
```

In practice, most commands are in different layers or have different priorities. The multi-level comparator exits early for ~98% of comparisons, doing **less work** than a packed key comparison.

#### 4. Bit-Packing Has Per-Frame Overhead
A packed key must be recomputed every frame because distance changes when the camera moves. This means:
- Pack layer (4 bits shift) + priority (12 bits shift) + material (16 bits shift) + distance (float→int conversion) = **~10 operations per command per frame**
- Our approach: comparator reads existing fields directly — **zero per-frame overhead**

#### When Packed Keys ARE Better: WASM Radix Sort (Phase 10)

The packed 64-bit key approach **will** be used in Phase 10 (WASM sort optimization) because:
- WASM has native 64-bit integer operations (`i64.add`, `i64.lt_u`) — no BigInt overhead
- **Radix sort** operates on fixed-width integer keys, not comparison functions — O(N) vs O(N log N)
- WASM SIMD can compare 2 packed keys in parallel using `i64x2` instructions
- The float→fixed-point distance conversion is acceptable inside WASM (done once, amortized over O(N) radix passes)

```
Phase 1-9 (JS):   Multi-level comparator (float64 distance, early exit, zero overhead)
Phase 10 (WASM):  Packed 64-bit key (i64 native ops, radix sort, SIMD parallel compare)
```

Both approaches coexist. The JS comparator is used by default. When WASM is available and the command count exceeds a threshold (e.g., >5000 commands), the system can optionally pack keys and use WASM radix sort for a ~7x speedup.

#### Does the Packed Key Need RTE Distance (High + Low)?

**No — 32-bit distance is sufficient for the packed sort key. RTE-style high/low is overkill.**

A potential 96-bit key layout with RTE distance would be:
```
Layer(4) + Priority(12) + Material(16) + DistanceHigh(32) + DistanceLow(32) = 96 bits
```

Why this is unnecessary:

1. **Sort keys only determine RELATIVE ORDER, not exact positions.** The question "is A closer than B?" doesn't need the same precision as "where exactly is A on the GPU?" A 32-bit distance resolves sort order correctly even at planetary scale:
   - As float32: ~7 decimal digits → at 12.7M meters (Earth diameter), ~1m sort precision
   - As fixed-point uint32 in millimeters: 0–4,294,967km range at 1mm precision
   - Two objects must be <1m apart AND at the same layer/priority/material for a sort error — visually indistinguishable

2. **RTE solves a DIFFERENT problem.** RTE prevents catastrophic cancellation when computing `position - camera` on the GPU (two large ECEF values, nearly equal, subtracted). Sort distance is already the RESULT of that subtraction (`BoundingSphere.distanceSquaredTo(camera)` — a small number). There's no catastrophic cancellation in the sort distance itself.

3. **96-bit keys penalize WASM radix sort.** Radix sort makes O(key_width) passes over the data. 96-bit = 12 byte-passes vs 64-bit = 8 byte-passes — **50% slower**. SIMD `i64x2` can compare two 64-bit keys in one instruction but can't handle 96-bit keys without extra logic.

4. **Industry standard is 64-bit.** Three.js, PlayCanvas, Unreal Engine, Unity — all use 64-bit sort keys for draw call ordering. None use RTE-style split distance. The precision is sufficient for all practical rendering scenarios.

**The correct layout for the WASM packed key (Phase 10) remains 64 bits:**
```
┌──────────┬───────────┬───────────┬──────────────────────┐
│ Layer    │ Priority  │ Material  │ Distance (float32)   │
│ (4 bits) │ (12 bits) │ (16 bits) │ (32 bits)            │
└──────────┴───────────┴───────────┴──────────────────────┘
```

And the JS multi-level comparator (Phases 1-9) continues using **full float64 distance** with zero packing — the best of both worlds.

### Collection-Level vs Individual-Level Priority
- **Collections** (BillboardCollection, PointPrimitiveCollection, PolylineCollection) emit **one DrawCommand per collection**
- `collection.renderPriority` sets the priority for the entire collection's DrawCommand
- Individual items (Billboard, PointPrimitive) have `sortPriority` for future per-item sorting
- Current behavior: collection-level priority wins (all items in collection sort together)
- Future Phase 8: collections split into priority groups for finer control
