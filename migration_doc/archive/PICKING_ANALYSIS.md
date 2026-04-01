# Picking System Analysis: Current State, Gaps & Improvement Plan

**Date:** March 21, 2026  
**Scope:** Full audit of CesiumJS picking across WebGL and WebGPU, comparison with Three.js/Babylon.js/PlayCanvas, gap analysis, and improvement plan.

---

## Table of Contents

1. [Current Picking Capabilities (WebGL)](#1-current-picking-capabilities-webgl)
2. [WebGPU Picking Status](#2-webgpu-picking-status)
3. [Is the Picking Solution Naive?](#3-is-the-picking-solution-naive)
4. [How Other WebGPU Engines Handle Picking](#4-how-other-webgpu-engines-handle-picking)
5. [Drill Pick to Earth Center — What We Have](#5-drill-pick-to-earth-center--what-we-have)
6. [Comparative Matrix](#6-comparative-matrix)
7. [Proposed Improvements](#7-proposed-improvements)
8. [Implementation Plan](#8-implementation-plan)

---

## 1. Current Picking Capabilities (WebGL)

CesiumJS has a mature, GPU-based picking system built around color-buffer rendering. All methods live in `Picking.js` (private) and are exposed through `Scene.js` (public API).

### Complete Method Inventory

#### Screen-Space Picking (at a window coordinate)

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `scene.pick(windowPosition, width?, height?)` | `Cartesian2`, `number` (default 3), `number` (default 3) | `object \| undefined` | Renders scene with pick colors into offscreen FBO. Spiral-searches the pixel region for a pick color. Returns the picked object with a `primitive` property. **Synchronous.** |
| `scene.pickAsync(windowPosition, width?, height?)` | Same | `Promise<object \| undefined>` | Same but uses async GPU readback (`readPixelsAsync` for WebGL2, `mapAsync` for WebGPU). Recommended for WebGPU. |
| `scene.drillPick(windowPosition, limit?, width?, height?)` | `Cartesian2`, `number` (default ∞), `number` (default 3), `number` (default 3) | `object[]` | Iteratively picks, hides the hit object, re-renders, and picks again. Returns array of all stacked objects at the screen point. **N render passes for N objects.** |

#### Ray-Based Picking (world-space ray cast)

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `scene.pickFromRay(ray, objectsToExclude?, width?)` | `Ray`, `object[]`, `number` (default 0.1m) | `{object, position, normal} \| undefined` | Creates an offscreen orthographic camera along the ray direction, renders with `passes.pick = true` + `passes.offscreen = true`, reads the 1×1 pixel result. `width` controls the orthographic frustum width in meters. **3D mode only.** |
| `scene.drillPickFromRay(ray, limit?, objectsToExclude?, width?)` | `Ray`, `number`, `object[]`, `number` | `{object, position, normal}[]` | Iteratively calls `getRayIntersection`, hides each hit, re-renders. Returns all objects along the ray. **N render passes for N objects.** |
| `scene.pickFromRayMostDetailed(ray, objectsToExclude?, width?)` | Same as `pickFromRay` | `Promise<{object, position, normal}>` | Async: waits for the most detailed tile content to load before picking. Uses `MOST_DETAILED_PICK` tileset pass state. |
| `scene.drillPickFromRayMostDetailed(ray, limit?, objectsToExclude?, width?)` | Same | `Promise<{object, position, normal}[]>` | Async drill pick with full-detail terrain loading. |

#### Depth / Position Picking

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `scene.pickPositionWorldCoordinates(windowPosition, result?)` | `Cartesian2`, `Cartesian3` | `Cartesian3 \| undefined` | Reads the depth buffer at the screen point, reconstructs 3D world position. Requires `scene.pickTranslucentDepth` or opaque geometry. |
| `scene.pickPosition(windowPosition, result?)` | Same | `Cartesian3 \| undefined` | Same but handles 2D/Columbus View coordinate transformations. |

#### Height Sampling (GIS utilities built on ray picking)

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `scene.sampleHeight(position, objectsToExclude?, width?)` | `Cartographic`, `object[]`, `number` | `number \| undefined` | Casts a ray downward at the given lon/lat, returns terrain/object height. |
| `scene.clampToHeight(cartesian, objectsToExclude?, width?, result?)` | `Cartesian3`, ... | `Cartesian3 \| undefined` | Clamps a 3D point to the surface beneath it. |
| `scene.sampleHeightMostDetailed(positions, objectsToExclude?, width?)` | `Cartographic[]`, ... | `Promise<SampleHeightResult[]>` | Async batch height sampling with full-detail terrain. |
| `scene.clampToHeightMostDetailed(cartesians, objectsToExclude?, width?)` | `Cartesian3[]`, ... | `Promise<ClampToHeightResult[]>` | Async batch clamping. |

#### Specialized Picking

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `scene.pickVoxelCoordinate(windowPosition, width?, height?)` | `Cartesian2`, ... | `VoxelCell \| undefined` | Picks voxel sample info. Uses `passes.pickVoxel = true` with `readCenterPixel()`. |
| `scene.pickMetadata(windowPosition, pickedMetadataInfo)` | `Cartesian2`, `PickedMetadataInfo` | metadata value | Picks metadata from 3D Tiles features at a screen point. |

### How the GPU Pick Pass Works (WebGL)

```
1. Picking.js method called (e.g., scene.pick())
2. pickFramebuffer.begin() → creates offscreen FBO (rgba8unorm + depth)
3. scene.updateFrameState() with:
   - frameState.passes.pick = true
   - frameState.passes.offscreen = true (for ray picks)
4. scene.updateAndExecuteCommands() → normal update loop
5. Each primitive checks passes.pick and emits pick-colored commands:
   - Derived command: command.derivedCommands.picking.pickCommand
   - Pick shader outputs the object's unique pick color as fragment color
6. pickFramebuffer.end() → readPixels (sync) or readPixelsAsync (async)
7. Spiral search from center pixel outward to find non-black pick color
8. context.getObjectByPickColor(color) → returns the picked object
```

### How Ray Picking Works

```
1. pickFromRay(ray, objectsToExclude, width) called
2. updateOffscreenCameraFromRay() →
   - Creates orthographic camera at ray.origin
   - Camera direction = ray.direction  
   - Ortho frustum width = width parameter (meters)
   - Near = camera.near, Far = very large
3. Renders to _pickOffscreenView (1×1 pixel FBO)
4. Reads back the single pixel → identifies object
5. Reads depth → reconstructs 3D intersection position
6. For drillPickFromRay: hides hit object, repeats from step 2
```

---

## 2. WebGPU Picking Status

### What Exists (Infrastructure) ✅

| Component | File | Status |
|-----------|------|--------|
| **Pick Framebuffer** | `WebGPUPickFramebuffer.ts` | ✅ Full implementation: `rgba8unorm` + `depth24plus-stencil8` offscreen targets, `copyTextureToBuffer` + `mapAsync` readback, spiral search, 256-byte row alignment |
| **Pick Manager** | `WebGPUPickManager.ts` | ✅ Pick ID allocation, 24-bit color encoding, color→object lookup |
| **Context Pick Methods** | `WebGPUContext.ts` | ✅ `createPickId()`, `getObjectByPickColor()`, `readPixels()`, `readPixelsAsync()`, `createPickFramebuffer()` |
| **View Integration** | `View.js` | ✅ `context.createPickFramebuffer() ?? new PickFramebuffer(context)` |
| **Async Path** | `Picking.js` | ✅ `context.webgl2 || context.isWebGPU` enables async readback |
| **GraphicsContext Factory** | `GraphicsContext.ts` | ✅ `createPickFramebuffer()` method (returns null for WebGL) |

### What's MISSING (Remaining Gaps)

| Gap | Severity | Description |
|-----|----------|-------------|
| **~~No pick render pass execution~~** | ✅ Fixed | `WebGPUSceneRenderer._executePickPass()` now renders to pick FBO when `config.picking` is true. Executes GLOBE/3D_TILE/OPAQUE/TRANSLUCENT passes, skips ENVIRONMENT. |
| **~~No pick commands for WebGPU primitives~~** | ✅ Fixed (Primitives) | `Primitive.js` now pushes WebGPU pick commands to `commandList` during pick-only passes (`passes.pick && !passes.render`). Pick commands use pick WGSL shaders (`PerInstanceColorPick.wgsl`, etc.). |
| **No pick commands for Collections** | 🟡 High | Billboard, Point, Polyline feature renderers do NOT create pick commands. Their `update()` methods don't handle `passes.pick`. Pick WGSL shaders exist (`BillboardPick.wgsl`, `PointPrimitivePick.wgsl`) but are not wired. |
| **No depth readback for WebGPU** | 🟡 High | `pickPositionWorldCoordinates()` needs to read the depth buffer. `WebGPUPickFramebuffer.ts` has depth texture but no API to read depth values for position reconstruction. |
| **Duplicate pick ID systems** | 🟡 Medium | `WebGPUContext.ts` has inline `_pickObjects` Map + `createPickId()`/`getObjectByPickColor()`. `WebGPUPickManager.ts` has its own independent pick object map. These are duplicate implementations. |
| **Offscreen pick view for ray picks** | 🟡 Medium | `_pickOffscreenView` uses the scene's rendering pipeline. If Billboard/Point/Polyline can't render pick colors, ray-based picking for those types still fails. Geometry-based picking should work via the new pick pass. |

### Estimated Effort to Make WebGPU Picking Work

| Task | Effort | Dependencies |
|------|--------|-------------|
| Wire pick pass in `WebGPUSceneRenderer` | 1-2 days | Pick shader variants |
| Create unified pick shader approach (pick color output) | 1-2 days | Feature renderer changes |
| Consolidate duplicate pick ID systems | 0.5 day | None |
| Add depth readback for position picking | 1 day | Pick pass working |
| End-to-end testing | 1 day | All above |
| **Total** | **4-6 days** | |

---

## 3. Is the Picking Solution Naive?

### What's Well-Designed ✅

1. **Color-buffer picking** — Industry standard, hardware-accelerated, works with any geometry complexity. No CPU-side mesh intersection needed.

2. **Spiral search** — Instead of checking only the exact pixel, the pick searches outward in a spiral pattern from the click point. Handles sub-pixel precision and anti-aliased edges.

3. **drillPick** — The iterative hide-and-re-render approach correctly handles any geometry type, including terrain, 3D Tiles, and custom shaders. Doesn't require geometric intersection code per primitive type.

4. **Ray picking via offscreen rendering** — Clever: creates an orthographic camera along the ray direction, renders to a 1×1 pixel FBO. Reuses the entire scene rendering pipeline without needing custom ray-intersection code.

5. **Width parameter** — `pickFromRay(ray, excludes, width)` with `width` in meters creates a wider orthographic frustum, effectively a "fat ray" pick. This IS the diameter-based pick the user asked about, though the API name doesn't make it obvious.

6. **MostDetailed variants** — Async methods that wait for the highest-LOD terrain/tileset to load before picking. Critical for GIS accuracy.

7. **Height sampling/clamping** — GIS-specific utilities built on the ray picking foundation.

### What's Naive Compared to Other Engines 🔴

#### Problem 1: Every Pick Requires a Full GPU Render Pass

CesiumJS renders the **entire scene** for every pick operation. For `drillPick` with 10 stacked objects, that's 10 full scene renders.

- **Three.js**: `Raycaster` does CPU-side geometric ray-mesh intersection. Zero GPU work for simple meshes. BVH acceleration optional.
- **Babylon.js**: `scene.pickWithRay()` uses CPU-side BVH. GPU picking is optional.
- **CesiumJS**: No CPU-side ray intersection at all. 100% GPU-dependent.

**Why this is a problem for CesiumJS specifically**: In dense GIS scenes (city-scale 3D Tiles + thousands of entities), a single `drillPick` can trigger 50+ render passes. At 60fps, this means picking causes frame drops.

#### Problem 2: No Multi-Hit in a Single Pass

Babylon.js's `scene.multiPick()` returns ALL objects at a screen point in ONE render pass. CesiumJS's `drillPick` hides each object and re-renders — O(N) passes for N objects.

**Future fix**: WebGPU storage buffers could enable a single-pass multi-hit pick: each fragment writes its pick ID to a per-pixel linked list in a storage buffer. One render pass → all hits.

#### Problem 3: No Spatial Acceleration for Picking

CesiumJS has no BVH, octree, or spatial acceleration structure for picking. Every `pickFromRay` renders the full scene along the ray.

- **Three.js**: Optional BVH via `three-mesh-bvh`
- **Babylon.js**: Built-in sub-mesh BVH
- **PlayCanvas**: AABB tree

**Our octree (Phase 9)** could accelerate pick by pre-filtering commands to only those in the ray's path, but this is not yet wired.

#### Problem 4: No Rectangle/Area Selection

There is no `scene.pickAll(rectangle)` that selects all objects within a user-drawn rectangle. The `width`/`height` parameters on `pick()` control the pick frustum size (small, ~3px default), not a large selection area.

- **Three.js**: `SelectionBox` helper
- **Babylon.js**: No built-in, but easy with `scene.multiPick` + frustum
- **CesiumJS**: Must implement manually with screen-space bounding box checks

#### Problem 5: drillPick is Screen-Space Only

`drillPick(windowPosition)` picks objects stacked at a screen pixel. It does NOT cast a ray toward the earth's center — it picks objects that happen to project to the same screen point.

`drillPickFromRay(ray)` IS world-space and CAN be directed toward the earth's center (see §5), but it's a separate API with a different name and parameters. Users asking for "drill pick to earth center" often try `drillPick` first and are confused.

#### Problem 6: No Pick Priority / Pick Filtering

Upstream issue [#1592](https://github.com/CesiumGS/cesium/issues/1592) (15 comments, priority-high): No way to set pick priority for overlapping entities. If a billboard and a polygon overlap, whichever is closest to the camera wins. No API to say "always prefer billboards over polygons."

- **Babylon.js**: `mesh.isPickable = false` + `actionManager` with priorities
- **Three.js**: `raycaster.layers` — 32-bit layer mask for pick filtering

---

## 4. How Other WebGPU Engines Handle Picking

### Three.js (WebGPURenderer)

| Feature | Implementation |
|---------|---------------|
| **Primary method** | CPU-side `Raycaster` — geometric ray-mesh intersection |
| **GPU picking** | Optional: render pick IDs to texture, readback via `readRenderTargetPixelsAsync()` |
| **Multi-hit** | `raycaster.intersectObjects(objects, recursive)` returns ALL hits sorted by distance in one call |
| **Layer filtering** | `raycaster.layers` — 32-bit bitmask, only intersects objects on matching layers |
| **BVH acceleration** | Optional via `three-mesh-bvh` — 10-100x speedup for complex meshes |
| **Width/diameter** | `raycaster.params.Line.threshold` for line picking tolerance |
| **WebGPU specifics** | Raycaster is CPU-only, works identically on WebGL and WebGPU. No GPU API change needed. |

**Key insight**: Three.js's picking is **renderer-agnostic** because it's CPU-based. Switching to WebGPU changes nothing about picking.

### Babylon.js (WebGPUEngine)

| Feature | Implementation |
|---------|---------------|
| **Primary method** | CPU-side ray-mesh intersection with BVH |
| **`scene.pick(x, y)`** | Creates ray from camera through screen point, CPU intersection |
| **`scene.multiPick(x, y)`** | Returns ALL objects at a point, single CPU traversal |
| **`scene.pickWithRay(ray)`** | Arbitrary ray, CPU intersection, BVH accelerated |
| **`scene.multiPickWithRay(ray)`** | All objects along an arbitrary ray |
| **Sub-mesh picking** | Can pick individual sub-meshes of a multi-material mesh |
| **Thin instance picking** | Can pick individual instances of instanced meshes |
| **Predicate filtering** | `scene.pick(x, y, (mesh) => mesh.name === "clickable")` |
| **Triangle-level** | `trianglePredicate` for per-face picking |
| **Fast check** | `fastCheck: true` skips per-triangle test, uses bounding box only |
| **WebGPU specifics** | Picking is 100% CPU-based. WebGPU engine has zero picking-specific code. |

**Key insight**: Babylon.js's `multiPickWithRay` is exactly the "drill pick from point to center of earth returning all intersections" feature. It works in one traversal, no iterative re-rendering.

### PlayCanvas

| Feature | Implementation |
|---------|---------------|
| **Primary method** | AABB tree + CPU ray intersection |
| **`app.scene.pick(x, y)`** | Ray from camera, intersects AABB tree |
| **Multi-hit** | Not built-in, but AABB tree can return all intersections |
| **GPU picking** | `Picker` class renders pick IDs, not commonly used |
| **WebGPU specifics** | AABB tree is CPU-only, renderer-agnostic |

### Key Takeaway from Industry

**All three engines primarily use CPU-side ray intersection for picking, not GPU rendering.** GPU color-buffer picking is available as a secondary option but is not the default. This means their picking works identically on WebGL and WebGPU with zero additional code.

CesiumJS is the outlier: it uses **GPU rendering as the primary (and only) picking mechanism**. This makes WebGPU picking a significant engineering task because the entire pick render pass must be ported.

**However, CesiumJS has a valid reason**: planetary-scale terrain, 3D Tiles, and LOD-dependent geometry make CPU-side geometric intersection much harder than for typical 3D engines. The terrain mesh changes with LOD, 3D Tiles content streams in dynamically, and custom shaders can deform geometry. GPU picking handles all these cases automatically by rendering what you see.

---

## 5. Drill Pick to Earth Center — What We Have

### The Question: "Can we drill pick from a point to the center of the earth and return all intersections?"

**YES — `scene.drillPickFromRay()` already does this.** The API exists but is not well-known.

```javascript
// Create a ray from camera position toward earth center
const origin = scene.camera.positionWC.clone();
const direction = Cesium.Cartesian3.negate(origin, new Cesium.Cartesian3());
Cesium.Cartesian3.normalize(direction, direction);
const ray = new Cesium.Ray(origin, direction);

// Drill pick along the ray — returns ALL intersected objects
const results = scene.drillPickFromRay(ray, 100, [], 10.0);
// results: [{object, position, normal}, {object, position, normal}, ...]
```

### The `width` Parameter IS the Diameter

The `width` parameter (4th argument, default 0.1 meters) controls the orthographic frustum width. This is effectively the **diameter of the pick cylinder**:

- `width = 0.1` → picks objects within a 10cm wide column along the ray
- `width = 10.0` → picks objects within a 10m wide column along the ray
- `width = 100.0` → picks objects within a 100m wide column along the ray

It's not a perfect geometric cylinder (it's an orthographic frustum, which is a rectangular prism), but for practical purposes it achieves the same result.

### Limitations

| Limitation | Details |
|------------|---------|
| **3D mode only** | Returns empty in 2D/Columbus View. Throws if `scene.mode !== SceneMode.SCENE3D`. |
| **N render passes** | For N objects along the ray, requires N separate GPU render passes (iterative hide-and-re-render). |
| **Requires depthTestAgainstTerrain** | `scene.globe.depthTestAgainstTerrain = true` needed for terrain intersection. |
| **MostDetailed is async** | `drillPickFromRayMostDetailed` loads full-LOD terrain first but is async/returns Promise. |
| **Performance** | For dense scenes (many overlapping objects along ray), can be very slow (50+ ms per pick). |
| **No pick priority** | Objects are returned in intersection order (nearest first), with no priority override. |

### What's Missing: Convenience API

The current API requires constructing a `Ray` manually. A convenience method would be:

```javascript
// PROPOSED: Convenience method on Scene
scene.drillPickToEarthCenter(windowPosition, options);
// OR
scene.drillPickThroughEarth(longitude, latitude, options);
```

This would internally construct the ray from the surface point toward earth center, set appropriate width, and call `drillPickFromRay`.

---

## 6. Comparative Matrix

| Feature | CesiumJS (Current) | Three.js | Babylon.js | PlayCanvas |
|---------|-------------------|----------|------------|------------|
| **Pick method** | GPU render pass (color buffer) | CPU ray-mesh intersection | CPU ray-mesh intersection | CPU ray-AABB |
| **Renderer agnostic** | ❌ Requires full porting to WebGPU | ✅ CPU-only | ✅ CPU-only | ✅ CPU-only |
| **Multi-hit (drill pick)** | ⚠️ N render passes | ✅ Single traversal | ✅ Single traversal | ⚠️ Manual |
| **Width/diameter pick** | ✅ `width` param (frustum) | ⚠️ Line threshold only | ❌ Not built-in | ❌ Not built-in |
| **Ray to earth center** | ✅ `drillPickFromRay` | N/A (no earth) | N/A (no earth) | N/A (no earth) |
| **Spatial acceleration** | ❌ None | ⚠️ Optional BVH | ✅ Built-in BVH | ✅ AABB tree |
| **Async picking** | ✅ `pickAsync`, `*MostDetailed` | ✅ `readRenderTargetPixelsAsync` | ❌ Sync only | ❌ Sync only |
| **Height sampling** | ✅ `sampleHeight`, `clampToHeight` | ❌ Not built-in | ❌ Not built-in | ❌ Not built-in |
| **Predicate filtering** | ❌ `objectsToExclude` only | ✅ Layer bitmask | ✅ Predicate function | ❌ Not built-in |
| **Rectangle selection** | ❌ None | ✅ `SelectionBox` | ⚠️ Manual | ❌ None |
| **Pick priority** | ❌ None (upstream #1592) | ✅ Via layers | ✅ Via `isPickable` | ❌ None |
| **Voxel picking** | ✅ `pickVoxelCoordinate` | ❌ | ❌ | ❌ |
| **Metadata picking** | ✅ `pickMetadata` | ❌ | ❌ | ❌ |
| **Terrain-aware** | ✅ LOD-aware terrain pick | ❌ | ❌ | ❌ |
| **WebGPU working** | ❌ Infrastructure only | ✅ CPU-based | ✅ CPU-based | ✅ CPU-based |

### CesiumJS Unique Strengths

Despite being "naive" in some ways, CesiumJS has picking features NO other engine has:

1. **`sampleHeight` / `clampToHeight`** — GIS-essential height querying
2. **`pickVoxelCoordinate`** — Volumetric data picking
3. **`pickMetadata`** — 3D Tiles metadata per-feature picking
4. **`*MostDetailed` variants** — Wait for max-LOD terrain to load before picking
5. **Terrain-aware** — Picks against LOD terrain that dynamically changes resolution
6. **`width` parameter** — Diameter-based pick along a ray (no other engine has this built-in)

---

## 7. Proposed Improvements

### Tier 1: Make WebGPU Picking Work (Critical — 4-6 days)

| # | Task | Effort | Impact |
|---|------|--------|--------|
| 1 | **Wire pick pass in WebGPUSceneRenderer** — Execute commands when `passes.pick = true` using pick shader variants | 2 days | All pick methods work in WebGPU |
| 2 | **Consolidate pick ID systems** — Remove duplicate `_pickObjects` in WebGPUContext, delegate to WebGPUPickManager exclusively | 0.5 day | Cleaner architecture |
| 3 | **Add depth readback** — `WebGPUPickFramebuffer` read depth values for `pickPosition` | 1 day | Position picking in WebGPU |
| 4 | **End-to-end testing** — Verify all 15+ pick methods work in WebGPU | 1-2 days | Confidence |

### Tier 2: Convenience APIs (Low effort, high discoverability — 1-2 days)

| # | Task | Effort | Impact |
|---|------|--------|--------|
| 5 | **`scene.pickAll(windowPosition, options)`** — Returns all objects at screen point (wraps drillPick) | 0.5 day | Discoverable multi-pick |
| 6 | **`scene.pickRayAll(origin, direction, options)`** — Drill pick along a ray with diameter option | 0.5 day | The "drill to earth center" API |
| 7 | **`scene.pickColumn(position, options)`** — Pick everything in a vertical column at a lat/lon | 0.5 day | GIS-specific convenience |

### Tier 3: Performance (Medium effort — 3-5 days)

| # | Task | Effort | Impact |
|---|------|--------|--------|
| 8 | **Pick-layer filtering** — `scene.pickLayers` bitmask to skip unpickable objects before rendering | 1-2 days | Faster picks in dense scenes |
| 9 | **Octree pick acceleration** — Pre-filter commands using octree before pick render | 1-2 days | Fewer objects rendered per pick |
| 10 | **GPU multi-hit** (WebGPU only) — Storage buffer per-pixel linked list for single-pass multi-pick | 3-5 days | O(1) render passes for drill pick |

### Tier 4: Advanced (Future — 5-10 days)

| # | Task | Effort | Impact |
|---|------|--------|--------|
| 11 | **Rectangle selection** — `scene.pickInRectangle(startPos, endPos)` for drag-select | 2-3 days | New capability |
| 12 | **Pick priority** — `entity.pickPriority` to control which overlapping entity wins | 1-2 days | Upstream #1592 |
| 13 | **CPU hybrid pick** — Geometric ray intersection for simple entities (billboards, points) as fast path | 3-5 days | Performance for simple objects |

---

## 8. Implementation Plan

### Phase 1: WebGPU Pick Pass (Critical Path)

The WebGPU pick pass needs to work for ALL picking methods to function:

**Approach**: When `frameState.passes.pick` is true and the context is WebGPU:
1. `WebGPUSceneRenderer` must recognize the pick pass
2. Each feature renderer must have a pick variant (many already have pick WGSL shaders)
3. The pick render pass writes pick colors to the `WebGPUPickFramebuffer`
4. Readback via `mapAsync` returns pick colors

**Key design decision**: Should the WebGPU pick pass use:
- **(A) Derived commands** (like WebGL) — create pick-specific WebGPU draw commands at derivation time
- **(B) Pick shader variant** — each feature renderer has a `renderPick()` method alongside `render()`
- **(C) Uniform-based** — same pipeline, pass pick color as uniform, fragment shader checks a pick flag

**Recommendation: Option B** — Feature renderers already have pick shaders (e.g., `PerInstanceColorPick.wgsl`, `BillboardPick.wgsl`). Adding a `renderPick()` method to the `FeatureRenderer` interface is the cleanest approach and follows the existing pattern.

### Phase 2: Convenience APIs

```javascript
// Proposed API
/**
 * Pick all objects at a screen position.
 * @param {Cartesian2} windowPosition - Screen coordinates
 * @param {object} [options]
 * @param {number} [options.limit=Number.MAX_VALUE] - Max objects to return
 * @param {number} [options.width=3] - Pick region width in pixels
 * @param {number} [options.height=3] - Pick region height in pixels
 * @returns {object[]} Array of picked objects with primitive property
 */
scene.pickAll = function(windowPosition, options) { ... };

/**
 * Pick all objects along a ray with optional diameter.
 * @param {Ray} ray - The ray to pick along
 * @param {object} [options]
 * @param {number} [options.diameter=0.1] - Pick cylinder diameter in meters
 * @param {number} [options.limit=Number.MAX_VALUE] - Max objects to return
 * @param {object[]} [options.exclude] - Objects to skip
 * @returns {{object, position, normal}[]} All intersected objects
 */
scene.pickRayAll = function(ray, options) { ... };

/**
 * Pick all objects in a vertical column at a geographic position.
 * Equivalent to drillPickFromRay with a ray from above toward earth center.
 * @param {Cartographic} position - Lon/lat/height 
 * @param {object} [options]
 * @param {number} [options.diameter=1.0] - Column diameter in meters
 * @param {number} [options.limit=Number.MAX_VALUE] - Max objects
 * @returns {{object, position, normal}[]}
 */
scene.pickColumn = function(position, options) { ... };
```

### Phase 3: GPU Multi-Hit (WebGPU Compute — Future)

```wgsl
// Single-pass multi-hit via storage buffer
@group(0) @binding(0) var<storage, read_write> hitBuffer: array<HitRecord>;
@group(0) @binding(1) var<storage, read_write> hitCount: array<atomic<u32>>;

struct HitRecord {
  pickId: u32,
  depth: f32,
  pixelX: u32,
  pixelY: u32,
};

@fragment
fn pickFragment(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
  let pickColor = getPickColor(); // From vertex attributes
  let idx = atomicAdd(&hitCount[0], 1u);
  hitBuffer[idx] = HitRecord(packPickColor(pickColor), fragCoord.z, 
                              u32(fragCoord.x), u32(fragCoord.y));
  return pickColor;
}
```

This would enable `drillPick` to find all N objects in a single render pass instead of N passes.

---

## Summary

| Question | Answer |
|----------|--------|
| **Is CesiumJS picking naive?** | Partially. GPU color-buffer picking is standard, but iterative drill-pick (N passes for N objects) and lack of spatial acceleration are below industry state-of-art. However, CesiumJS has unique GIS features (height sampling, terrain-aware picking, voxel/metadata picking) that no other engine offers. |
| **Does it have all picking for both backends?** | **WebGL: Yes** (15+ methods, fully functional). **WebGPU: No** (infrastructure exists but pick render pass is not wired — all picking fails in WebGPU). |
| **Do other engines have better picking?** | For **speed**: Yes (CPU ray-mesh + BVH is faster than GPU re-render). For **GIS features**: No (CesiumJS is unique in terrain/voxel/metadata picking). For **multi-hit**: Yes (Babylon.js `multiPickWithRay` is single-traversal). |
| **Do we have drill pick to earth center?** | **Yes** — `scene.drillPickFromRay(ray, limit, excludes, width)` with a ray toward earth center. The `width` parameter IS the diameter. But: (a) it's N render passes, (b) 3D mode only, (c) the API is not discoverable — needs a convenience wrapper. |
| **Should we add diameter-based pick?** | The `width` parameter already does this. We should: (a) rename/alias to `diameter` in a convenience API, (b) document it better, (c) add `scene.pickColumn(position, {diameter})` for the common GIS use case. |

### Priority Actions

1. 🔴 **Wire WebGPU pick render pass** — Without this, all 15+ pick methods fail in WebGPU
2. 🟡 **Add convenience APIs** — `pickAll`, `pickRayAll`, `pickColumn` with `diameter` option
3. 🟡 **Add pick layer filtering** — Bitmask to skip unpickable objects
4. 🟢 **GPU multi-hit** — Single-pass drill pick via storage buffers (WebGPU only, future)
5. 🟢 **CPU hybrid pick** — Geometric ray intersection for simple entities (future)
