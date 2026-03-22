# Sorting & Z-Ordering Architecture: Analysis & "Cadillac" Proposal

**Date:** March 20, 2026  
**Context:** FORK-31 `sortKey` is now wired into Scene.js comparators. This document analyzes the full sorting picture — what we have, what Three.js/Babylon.js/PlayCanvas do, and what a best-in-class system looks like.

---

## Table of Contents

1. [What We Have Today](#1-what-we-have-today)
2. [Why It's Naive](#2-why-its-naive)
3. [How Three.js Handles Sorting](#3-how-threejs-handles-sorting)
4. [How Babylon.js Handles Sorting](#4-how-babylonjs-handles-sorting)
5. [How PlayCanvas Handles Sorting](#5-how-playcanvas-handles-sorting)
6. [Comparative Matrix](#6-comparative-matrix)
7. [The "Cadillac" — What Best-in-Class Looks Like](#7-the-cadillac--what-best-in-class-looks-like)
8. [How an Integrator Would Understand Where Their Entity Lands](#8-how-an-integrator-would-understand-where-their-entity-lands)
9. [Proposed Implementation for CesiumJS](#9-proposed-implementation-for-cesiumjs)
10. [Migration Path](#10-migration-path)

---

## 1. What We Have Today

CesiumJS sorting operates on **four independent layers** that don't compose cleanly:

### Layer 1: Pass Binning (Coarsest)

Commands are assigned to one of 13 passes (`Pass.js`) and executed in strict order:

```
0  ENVIRONMENT          (sky, atmosphere, sun, moon)
1  COMPUTE              (GPU compute dispatches)
2  GLOBE                (terrain tiles)
3  TERRAIN_CLASSIFICATION (stencil for ground primitives)
4  CESIUM_3D_TILE        (3D Tiles opaque)
5  CESIUM_3D_TILE_CLASSIFICATION
6  CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW
7  VOXELS
8  OPAQUE               (user primitives, billboards, polylines, points)
9  TRANSLUCENT           (alpha < 1.0 objects)
10 VOXELS_2             (second voxel pass)
11 GAUSSIAN_SPLATS
12 OVERLAY               (screen-space overlays)
```

**User control:** None. The pass is determined internally by the primitive type and its material properties.

### Layer 2: Distance-Based Sorting (Within Each Pass)

Within a pass, commands are sorted by distance to camera:

| Pass Type | Sort Direction | Purpose |
|-----------|---------------|---------|
| Opaque | Front-to-back | Early-Z rejection — skip fragment work for occluded pixels |
| Translucent | Back-to-front | Correct alpha blending requires rendering far objects first |
| Gaussian Splats | Back-to-front (center-only) | Alpha blending for splats |

The distance is computed via `boundingVolume.distanceSquaredTo(cameraPosition)`, which returns the **squared distance from the camera to the nearest point on the bounding volume**.

**User control:** None. Entirely automatic based on camera position.

### Layer 3: `sortKey` on DrawCommand (FORK-31 — Newly Active)

```javascript
// Scene.js comparators (both backToFront and frontToBack):
function backToFront(a, b, position) {
  const sortKeyA = a.sortKey ?? 0;
  const sortKeyB = b.sortKey ?? 0;
  if (sortKeyA !== sortKeyB) {
    return sortKeyA - sortKeyB;  // Primary: lower renders first
  }
  // Secondary: distance-based (far first for translucent)
  return b.boundingVolume.distanceSquaredTo(position) -
         a.boundingVolume.distanceSquaredTo(position);
}
```

**User control:** Theoretically available via `DrawCommand.sortKey`, but:
- No Entity API exposes it
- No collection class sets it
- No documentation explains it
- Default is 0 for everything → distance sort wins

### Layer 4: `zIndex` on Ground Geometry (Entity API)

Only available on **ground-clamped static geometry**:

```javascript
viewer.entities.add({
  polygon: {
    hierarchy: coords,
    material: Color.RED.withAlpha(0.5),
    zIndex: 5,  // Higher renders on top (opposite of sortKey!)
  },
});
```

**Supported types:** `PolygonGraphics`, `RectangleGraphics`, `EllipseGraphics`, `CorridorGraphics`, `PolylineGraphics` (when `clampToGround: true`)

**NOT supported on:** Billboards, Labels, Points, Models, 3D Tiles, any non-ground entity, any entity with `height` or `extrudedHeight`.

**Implementation:** `OrderedGroundPrimitiveCollection` maintains separate `PrimitiveCollection` buckets keyed by `zIndex`, rendered in ascending order. This is a **separate code path** from the `sortKey` system — they don't interact.

### Layer 5: PrimitiveCollection Array Order

```javascript
scene.primitives.add(primitiveA); // Renders first (behind)
scene.primitives.add(primitiveB); // Renders second (in front, if overlapping)

scene.primitives.raiseToTop(primitiveA); // Now A renders after B
```

**User control:** `raise()`, `raiseToTop()`, `lower()`, `lowerToBottom()`, `add(primitive, index)`.

**Limitation:** Only controls the order commands are **pushed** to the command list. Once in the command list, pass binning and distance sorting override this order. This method only reliably controls order for objects at the same distance in the same pass.

---

## 2. Why It's Naive

### Problem 1: Five Disconnected Systems, No Unified Mental Model

An integrator faces five different ordering mechanisms that don't compose:

| Mechanism | Scope | Direction | Where It Lives |
|-----------|-------|-----------|---------------|
| Pass enum | All commands | Fixed integer 0-12 | `DrawCommand.pass` (internal) |
| Distance sort | Within pass | Auto from camera | `boundingVolume.distanceSquaredTo()` |
| `sortKey` | Within pass | Lower first | `DrawCommand.sortKey` (no API exposure) |
| `zIndex` | Ground geometry only | Higher on top | `PolygonGraphics.zIndex` |
| Array order | Within collection | Later = on top | `PrimitiveCollection` |

A user asking **"how do I make entity A render on top of entity B?"** gets **five different answers** depending on what A and B are. There is no single, universal answer.

### Problem 2: No Material/State-Change Batching

Every major 3D engine sorts opaque objects by **material** to minimize GPU state changes (shader swaps, texture rebinds). CesiumJS does not. Two identically-shaded polylines on opposite sides of the globe will not be batched — they'll be interleaved with unrelated commands based on distance, forcing unnecessary pipeline/shader swaps.

For a scene with N draw calls using M materials, the worst case is N shader swaps. With material batching, it's M shader swaps. For typical CesiumJS scenes (10,000+ billboards, 100+ polylines, dozens of models), this is a significant CPU/GPU overhead.

### Problem 3: `zIndex` Only Works for Ground Geometry

The 47-comment upstream issue [#4108](https://github.com/CesiumGS/cesium/issues/4108) has been open since **2016**. Users want to control the ordering of:
- Billboards (labels on a map that should always render on top of polygons)
- Polylines (route lines that should render above filled areas)
- Models (priority rendering for selected objects)
- Mixed entity types (a billboard should render on top of a polygon)

`zIndex` addresses ~20% of this need (ground polygons only). The remaining 80% has no solution.

### Problem 4: `sortKey` is Internal — No Path from Entity to Command

Even with FORK-31 making `sortKey` active in comparators, there's no wiring from the user-facing Entity API to the internal `DrawCommand.sortKey`:

```
Entity.polygon.zIndex      →  OrderedGroundPrimitiveCollection  →  PrimitiveCollection order
Entity.billboard.???       →  BillboardCollection._billboards   →  DrawCommand (sortKey = 0 always)
Entity.model.???           →  Model                             →  DrawCommand (sortKey = 0 always)
scene.primitives.add(prim) →  Primitive                         →  DrawCommand (sortKey = 0 always)
```

There is no `entity.renderOrder` or `billboard.renderPriority` property.

### Problem 5: No Render Layers / Groups

CesiumJS has no concept of render layers. Every object competes in the same distance-sorted pool within its pass. In Three.js/Babylon.js/PlayCanvas, you can say:

- "All terrain is layer 0, all buildings are layer 1, all labels are layer 2"
- "Clear depth between layers so labels always render on top"
- "Sort buildings by material but labels by distance"

CesiumJS can only approximate this by adding objects to different `PrimitiveCollection`s and hoping the array order survives the sort.

### Problem 6: No Custom Sort Override

Users cannot replace the sort comparator. If the default distance-based sort doesn't work for their use case, they have no escape hatch.

### Problem 7: Conventions Conflict

`zIndex`: higher = on top (web convention, like CSS)  
`sortKey`: lower = renders first (which means "behind" for opaque, "on top" for translucent!)  
`PrimitiveCollection`: later in array = renders later (on top for same depth)  
`Pass` enum: higher = later (TRANSLUCENT after OPAQUE)  

These four conventions pull in different directions.

---

## 3. How Three.js Handles Sorting

Three.js has the most developer-friendly sorting system of the three engines.

### Universal `renderOrder` Property

Every `Object3D` (the base class for all scene objects) has:

```javascript
mesh.renderOrder = 0;      // Default. Lower renders first.
sprite.renderOrder = 10;   // Renders after meshes with renderOrder < 10
line.renderOrder = -1;     // Renders before default objects
```

This is the **single, universal mechanism** for controlling draw order. It works on meshes, sprites, lines, points — everything. No special cases for ground vs. non-ground.

### Automatic Render List Separation

Three.js automatically classifies objects into three render lists based on `material.transparent`:

```
1. opaque[]        — material.transparent === false
2. transmissive[]  — material.transmission > 0
3. transparent[]   — material.transparent === true
```

Each list is sorted independently.

### Multi-Level Sort (Opaque)

```
renderOrder → groupOrder → materialId → z-distance (front-to-back)
```

1. **`renderOrder`** (on Object3D) — coarse user control
2. **`material.groupOrder`** — groups materials into rendering phases (e.g., all "water" after all "terrain")
3. **`material.id`** — same material batched together = fewer state changes
4. **Z distance** — front-to-back within same material

### Multi-Level Sort (Transparent)

```
renderOrder → groupOrder → z-distance (back-to-front) → materialId
```

Note the key difference: for transparent objects, **distance takes priority over material batching** (because correct blending order matters more than state-change optimization).

### Custom Sort Override

```javascript
renderer.setOpaqueSort((a, b) => { /* custom comparator */ });
renderer.setTransparentSort((a, b) => { /* custom comparator */ });
```

Full escape hatch.

### Render Layers (Bitmask)

```javascript
const WORLD = 0, UI = 1, GIZMO = 2;
terrain.layers.set(WORLD);
label.layers.set(UI);
gizmo.layers.set(GIZMO);

camera.layers.enable(WORLD);
camera.layers.enable(UI);
// camera.layers.disable(GIZMO); — gizmos not rendered by this camera
```

32 layers, bitmask-based. Controls visibility, not order — but combined with `renderOrder`, gives full control.

### What Makes It Work

**One property (`renderOrder`) answers the question for any object type.** The user never needs to know about passes, distance sorting, or material batching — those are implementation details that happen automatically within each `renderOrder` group.

---

## 4. How Babylon.js Handles Sorting

Babylon.js has the most *powerful* sorting system — more complex than Three.js, but more capable.

### Rendering Groups (4 Layers with Auto Depth Clear)

```javascript
mesh.renderingGroupId = 0;  // Default — world geometry
labelMesh.renderingGroupId = 1;  // Always renders after group 0
uiMesh.renderingGroupId = 3;     // Highest layer
```

4 groups (0-3), rendered in order. The key feature: **depth buffer can be auto-cleared between groups:**

```javascript
scene.setRenderingAutoClearDepthStencil(1, true);  // Clear depth before group 1
// Now everything in group 1 renders "on top" of group 0, regardless of actual depth
```

This is incredibly powerful for GIS/mapping: terrain is group 0, annotations are group 1 with depth clear, and labels always appear on top of terrain regardless of camera angle.

### `alphaIndex` (Explicit Transparent Ordering)

```javascript
transparentMesh.alphaIndex = 5;   // Explicit order within transparent pass
otherMesh.alphaIndex = 10;         // Renders after alphaIndex 5
```

When `alphaIndex` is set, it **overrides** distance-based sorting for transparent objects. This solves the classic problem of flat transparent objects (like map overlays) that can't be reliably distance-sorted because they're coplanar.

### Sub-Mesh Level Sorting

Babylon.js sorts at the **sub-mesh** level, not just the mesh level. A single mesh with multiple materials has its sub-meshes sorted independently. This matters for multi-material models.

### Full Sort Customization Per Group

```javascript
scene.setRenderingOrder(
  groupId,
  opaqueSortCompareFn,
  alphaTestSortCompareFn,
  transparentSortCompareFn
);
```

Each rendering group can have completely different sort strategies.

### Rendering Group Callbacks

```javascript
scene.onBeforeRenderingGroupObservable.add((groupInfo) => {
  if (groupInfo.renderingGroupId === 1) {
    // Inject custom rendering logic between groups
  }
});
```

### What Makes It Work

**`renderingGroupId` + depth clear** is the killer feature for GIS applications. It solves the "labels on top of terrain" problem definitively. `alphaIndex` solves coplanar transparent sorting. The 4-group limit is rarely restrictive because most apps need exactly: world (0), annotations (1), UI (2), overlay (3).

---

## 5. How PlayCanvas Handles Sorting

PlayCanvas has the most *flexible* sorting — a layer system where each layer can have its own sort mode.

### Named Layers

```javascript
const worldLayer = new pc.Layer({ name: "World" });
const labelsLayer = new pc.Layer({ name: "Labels" });
const uiLayer = new pc.Layer({ name: "UI" });

app.scene.layers.push(worldLayer);
app.scene.layers.push(labelsLayer);  // Renders after world
app.scene.layers.push(uiLayer);      // Renders after labels
```

Layers are ordered explicitly. Objects are assigned to layers.

### Per-Layer Sort Modes

```javascript
worldLayer.opaqueSortMode = pc.SORTMODE_MATERIALMESH;  // Batch by material
worldLayer.transparentSortMode = pc.SORTMODE_BACK2FRONT;

labelsLayer.opaqueSortMode = pc.SORTMODE_MANUAL;  // Use drawOrder
labelsLayer.transparentSortMode = pc.SORTMODE_NONE;  // No sorting

uiLayer.opaqueSortMode = pc.SORTMODE_NONE;  // Render in add order
```

Available sort modes:
| Mode | Behavior |
|------|----------|
| `SORTMODE_NONE` | No sorting (render in add order) |
| `SORTMODE_MANUAL` | Sort by `meshInstance.drawOrder` |
| `SORTMODE_MATERIALMESH` | Group by material, then by mesh (minimizes state changes) |
| `SORTMODE_BACK2FRONT` | Distance-based, back to front |
| `SORTMODE_FRONT2BACK` | Distance-based, front to back |
| `SORTMODE_CUSTOM` | User-provided comparator |

### `drawOrder` (Manual Ordering)

```javascript
meshInstance.drawOrder = 100;  // When SORTMODE_MANUAL, lower renders first
```

### `SORTMODE_MATERIALMESH` (Smart Batching)

This is PlayCanvas's default for opaque geometry and is the biggest performance win. The sort key is:

```
(material.id << 16) | mesh.id
```

This groups all draw calls using the same material together, minimizing shader/texture state changes. Within the same material, meshes are grouped to minimize vertex buffer swaps.

### Custom Sort Callback

```javascript
layer.customSortCallback = (drawCalls, sortMode) => {
  drawCalls.sort((a, b) => { /* anything */ });
};
```

### Multi-Camera Layer Rendering

Each camera specifies which layers it renders:

```javascript
camera.layers = [worldLayer.id, labelsLayer.id];
// This camera doesn't render UI layer
```

### What Makes It Work

**Per-layer sort mode** is the key insight. Different content types need different sort strategies. Terrain should be sorted by material (batching). Labels should be sorted manually (priority). UI should not be sorted at all (DOM order). PlayCanvas lets each layer choose independently.

---

## 6. Comparative Matrix

| Feature | CesiumJS (Current) | Three.js | Babylon.js | PlayCanvas |
|---------|-------------------|----------|------------|------------|
| **Universal render order** | ❌ 5 disconnected systems | ✅ `renderOrder` on all objects | ✅ `renderingGroupId` (4 groups) | ✅ Named layers |
| **Works on all object types** | ❌ `zIndex` ground-only | ✅ All Object3D | ✅ All meshes | ✅ All mesh instances |
| **Material batching** | ❌ None | ✅ materialId sort | ✅ Material sort | ✅ `SORTMODE_MATERIALMESH` |
| **Depth clear between groups** | ❌ None | ❌ Manual only | ✅ Auto per group | ✅ Per layer option |
| **Explicit transparent order** | ❌ Distance only | ✅ Via renderOrder | ✅ `alphaIndex` | ✅ `drawOrder` + manual mode |
| **Custom sort override** | ❌ None | ✅ `setOpaqueSort()` | ✅ `setRenderingOrder()` | ✅ `customSortCallback` |
| **Per-category sort strategy** | ❌ Same sort for all | ❌ Opaque/transparent only | ✅ Per rendering group | ✅ Per layer per mode |
| **Render layers / visibility groups** | ❌ None | ✅ 32-bit bitmask | ⚠️ Via rendering groups | ✅ Named layers per camera |
| **User-facing API** | ⚠️ `zIndex` (ground only) | ✅ `mesh.renderOrder = N` | ✅ `mesh.renderingGroupId = N` | ✅ `layer.addMeshInstances([m])` |
| **Integrator can predict sort position** | ❌ No | ✅ Yes — renderOrder is deterministic | ✅ Yes — groupId + alphaIndex | ✅ Yes — layer + drawOrder |

---

## 7. The "Cadillac" — What Best-in-Class Looks Like

The "Cadillac" sorting system combines the best ideas from all three engines, adapted for CesiumJS's unique constraints (GIS, planetary scale, multi-frustum, RTE precision).

### Design Principles

1. **One property answers the question** — Like Three.js's `renderOrder`, there should be a single, universal property that any integrator can set on any object to control its render order.

2. **Layered sort with configurable strategy** — Like PlayCanvas, different content types should be sortable with different strategies.

3. **Depth clear between groups** — Like Babylon.js, the system should support clearing the depth buffer between rendering groups so annotations always appear on top of terrain.

4. **Material batching for performance** — Like Three.js and PlayCanvas, opaque objects within the same sort group should be batched by material.

5. **Backward compatible** — Everything defaults to current behavior. Existing code works unchanged.

### The Sort Key Structure

Instead of a flat integer `sortKey`, use a **structured sort key** that encodes multiple levels:

```
┌─────────────────────────────────────────────────────────┐
│  64-bit Sort Key (stored as two 32-bit integers)        │
├──────────┬───────────┬───────────┬──────────────────────┤
│ Layer    │ Priority  │ Material  │ Distance             │
│ (4 bits) │ (12 bits) │ (16 bits) │ (32 bits)            │
│ 0-15     │ 0-4095    │ 0-65535   │ float32 distance     │
├──────────┴───────────┴───────────┴──────────────────────┤
│  Sort order: Layer → Priority → Material → Distance     │
└─────────────────────────────────────────────────────────┘
```

**Layer (4 bits, 0-15):** Coarse render group. Depth buffer can optionally clear between layers.
- 0: Environment (sky, atmosphere)
- 1: Globe / terrain
- 2: Ground classification
- 3-4: 3D Tiles
- 5: World geometry (default for user primitives)
- 6-10: User-defined layers
- 11: Annotations / labels
- 12-13: Reserved
- 14: Overlay
- 15: Screen-space UI

**Priority (12 bits, 0-4095):** User-controlled render priority within a layer. Lower renders first. Default: 2048 (midpoint).

**Material (16 bits, 0-65535):** Material/shader ID for batching. Opaque: sorted by material for batching. Transparent: ignored (distance wins).

**Distance (32 bits):** Camera distance. Opaque: front-to-back. Transparent: back-to-front.

### Comparator Logic

```javascript
function opaqueSort(a, b) {
  // Layer comparison (4 bits)
  if (a.sortLayer !== b.sortLayer) return a.sortLayer - b.sortLayer;
  // Priority comparison (12 bits)  
  if (a.sortPriority !== b.sortPriority) return a.sortPriority - b.sortPriority;
  // Material batching (16 bits)
  if (a.materialSortId !== b.materialSortId) return a.materialSortId - b.materialSortId;
  // Distance: front-to-back
  return a.distanceToCamera - b.distanceToCamera;
}

function transparentSort(a, b) {
  // Layer comparison
  if (a.sortLayer !== b.sortLayer) return a.sortLayer - b.sortLayer;
  // Priority comparison
  if (a.sortPriority !== b.sortPriority) return a.sortPriority - b.sortPriority;
  // Distance: back-to-front (NOT material batched — correct blending order is more important)
  return b.distanceToCamera - a.distanceToCamera;
}
```

### User-Facing API

#### Level 1: Simple (Entity API)

```javascript
// Works on ANY entity type — billboards, polygons, models, everything
entity.renderPriority = 100;  // Higher = renders on top (web convention, like zIndex)

// Backward compatible: zIndex still works for ground geometry
entity.polygon.zIndex = 5;  // Still works, internally maps to renderPriority
```

#### Level 2: Intermediate (Primitive API)

```javascript
const primitive = new Cesium.Primitive({ /* ... */ });
primitive.renderLayer = Cesium.RenderLayer.ANNOTATIONS;  // Named layer
primitive.renderPriority = 500;  // Within that layer

scene.primitives.add(primitive);
```

#### Level 3: Advanced (Scene Configuration)

```javascript
// Configure layer behavior
scene.renderLayers.get(Cesium.RenderLayer.ANNOTATIONS).clearDepth = true;
scene.renderLayers.get(Cesium.RenderLayer.ANNOTATIONS).sortMode = Cesium.SortMode.MANUAL;

// Custom sort for a specific layer
scene.renderLayers.get(Cesium.RenderLayer.WORLD).customSort = (a, b) => {
  return a.someProperty - b.someProperty;
};
```

#### Level 4: Expert (Sort Key Debugging)

```javascript
// Inspect the computed sort key for any command
const debugInfo = scene.debugSortInfo(entity);
// Returns: { layer: 5, priority: 2048, materialId: 42, distance: 1234.5,
//            effectiveOrder: "5:2048:42:1234.5",
//            renderPass: "OPAQUE", sortDirection: "front-to-back" }

// Visualize sort order
scene.debugShowRenderOrder = true;  // Overlays sort index on each object
```

---

## 8. How an Integrator Would Understand Where Their Entity Lands

### The Current Problem

Today, an integrator asking "where does my billboard render relative to my polygon?" gets this answer:

> "Well, it depends. If the polygon is ground-clamped, you can use `zIndex`, but that only controls order relative to other ground polygons. If the billboard is in the same pass (OPAQUE), they're sorted by distance to camera, so whichever is closer renders... wait, front-to-back for opaque means closer renders *first* which means *behind*, unless the billboard has depth test disabled, in which case... actually, billboards are in a BillboardCollection which emits its own DrawCommand, so it's the collection's bounding volume distance that matters, not the individual billboard's distance... and if the polygon is translucent it's in the TRANSLUCENT pass which renders *after* OPAQUE, so it renders on top of the billboard regardless of distance... unless OIT is enabled, in which case order doesn't matter for translucent..."

This is unacceptable.

### The Cadillac Answer

With the proposed system, the answer becomes:

> **"Set `renderPriority`. Higher number = renders on top. That's it."**

For the 90% case, this is the only thing they need to know:

```javascript
// "I want my labels to always render on top of my polygons"
labelEntity.renderPriority = 100;
polygonEntity.renderPriority = 50;
// Done. Labels will always render on top. Works for ANY entity type.
```

For the 10% advanced case:

```javascript
// "I want a dedicated layer for my sensor data that clears depth"
const sensorLayer = scene.renderLayers.create("Sensors", {
  order: 6,
  clearDepth: true,        // Always renders on top of world layer
  sortMode: SortMode.NONE, // Render in add-order
});

sensorPrimitive.renderLayer = sensorLayer;
```

### Sort Order Decision Tree (Documentation for Integrators)

```
When are two objects drawn, which renders on top?
│
├─ Different render layers?
│   → Higher layer number renders on top (later)
│   → If the higher layer has clearDepth: true,
│     it ALWAYS renders on top, regardless of actual depth
│
├─ Same layer, different renderPriority?
│   → Higher renderPriority renders on top (later)
│
├─ Same layer, same priority, both opaque?
│   → Sorted by material (batching), then by distance
│   → Object closer to camera renders first (behind due to depth test)
│   → This is an optimization — you don't control this order
│
├─ Same layer, same priority, both translucent?
│   → Farther object renders first, closer renders on top
│   → This is for correct alpha blending
│
├─ One opaque, one translucent?
│   → All opaque objects in a layer render before translucent
│   → Translucent object renders on top (it's drawn later)
│
└─ Using OIT (Order-Independent Transparency)?
    → Translucent objects don't need sorting
    → Result is correct regardless of draw order
```

### Debug Tools for Integrators

```javascript
// "Why is my entity rendering behind that other entity?"
const report = scene.explainRenderOrder(entityA, entityB);
console.log(report);
// Output:
// Entity A: layer=WORLD(5), priority=2048, pass=OPAQUE, material=PBR#42, distance=5234m
// Entity B: layer=WORLD(5), priority=2048, pass=TRANSLUCENT, material=Color#7, distance=3891m
// Result: B renders ON TOP of A because:
//   - Same layer (WORLD)
//   - Same priority (2048)
//   - B is TRANSLUCENT, A is OPAQUE → translucent pass executes after opaque pass
// Suggestion: To make A render on top, set entityA.renderPriority = 2049
//             or entityA.renderLayer = RenderLayer.ANNOTATIONS
```

---

## 9. Proposed Implementation for CesiumJS

### Phase 1: Structured Sort Key (2-3 days)

Replace the flat `sortKey` integer with a structured sort key:

**Files to modify:**
- `DrawCommand.js` — Add `sortLayer` (default 5), `sortPriority` (default 2048), `materialSortId` (default 0)
- `WebGPUDrawCommand.ts` — Same properties
- `Scene.js` — Update `frontToBack` / `backToFront` comparators to use structured keys

**Backward compatibility:** `sortKey` continues to work — if set, it maps to `sortPriority`. New properties are additive.

### Phase 2: Entity API (`renderPriority`) (2-3 days)

**Files to modify:**
- `Entity.js` — Add `renderPriority` property
- `BillboardCollection.js` — Pass entity's `renderPriority` to DrawCommand's `sortPriority`
- `PointPrimitiveCollection.js` — Same
- `PolylineCollection.js` — Same
- `Primitive.js` — Same
- `GroundPrimitive.js` — Map `zIndex` to `sortPriority` for ground geometry
- Each `*Visualizer.js` in DataSources — Wire entity `renderPriority` through to primitives

**Convention:** `renderPriority` uses web convention (higher = on top). Internally it's inverted to `sortPriority` (lower = renders first for opaque, later for transparent).

### Phase 3: Render Layers (3-5 days)

**New files:**
- `RenderLayer.js` — Named layer enum and configuration
- `RenderLayerCollection.js` — Per-scene layer management

**Files to modify:**
- `Scene.js` — Add `renderLayers` property, depth clear between layers
- `View.js` — Per-layer command list separation
- `Primitive.js`, `BillboardCollection.js`, etc. — Add `renderLayer` property

### Phase 4: Material Batching (2-3 days)

**Files to modify:**
- `ShaderProgram.js` — Assign sortable material ID
- `DrawCommand.js` — Auto-populate `materialSortId` from shader/texture combination
- Scene.js comparators — Use material ID for opaque sorting

### Phase 5: Debug Tools (1-2 days)

**New files:**
- `RenderOrderDebug.js` — `scene.explainRenderOrder()`, `scene.debugShowRenderOrder`

### Phase 6: Custom Sort Override (1 day)

**Files to modify:**
- `Scene.js` — `scene.setCustomSort(layer, mode, comparator)`

---

## 10. Migration Path

### Immediate (What FORK-31 Already Gives Us)

`sortKey` works in both `backToFront` and `frontToBack` comparators. Any code that sets `DrawCommand.sortKey` will see its effect. This is Phase 0 — the foundation.

### Short Term: Phase 1 + 2 (Entity API)

The minimum viable improvement: give integrators `entity.renderPriority` that works on everything. This alone solves 80% of [#4108](https://github.com/CesiumGS/cesium/issues/4108).

### Medium Term: Phase 3 (Render Layers)

Render layers with depth clear solve the GIS-specific problem of annotations over terrain. This is the feature that Babylon.js's `renderingGroupId` provides.

### Long Term: Phase 4-6 (Performance + Debug)

Material batching is a performance optimization that compounds with other improvements. Debug tools help adoption.

### What Each Phase Gives the Integrator

| Phase | Integrator Capability | API |
|-------|----------------------|-----|
| 0 (done) | Set sort key on DrawCommand | `command.sortKey = N` (internal only) |
| 1 | Structured sorting with layers | `command.sortLayer/sortPriority/materialSortId` |
| 2 | **Universal render priority on any entity** | **`entity.renderPriority = N`** |
| 3 | Render layers with depth clear | `primitive.renderLayer = RenderLayer.ANNOTATIONS` |
| 4 | Automatic material batching | Automatic — no API change |
| 5 | Debug tools | `scene.explainRenderOrder(a, b)` |
| 6 | Custom sort functions | `scene.setCustomSort(layer, mode, fn)` |

---

## Summary

**Current state:** Naive — five disconnected mechanisms, no universal API, no material batching, no layers, no debug tools. An integrator cannot predict or control where their entity renders.

**Cadillac state:** Structured sort key (layer → priority → material → distance), universal `renderPriority` on all entities, named render layers with depth clear, per-layer sort modes, material batching, custom sort overrides, and debug tools that explain "why is A behind B?"

**The single most impactful change:** Adding `entity.renderPriority` (Phase 2) that works on ALL entity types. This alone answers the 8-year-old, 47-comment upstream issue #4108.
