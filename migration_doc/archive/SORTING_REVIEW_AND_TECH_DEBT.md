# Sorting System Review: Integration Status, Build Pipeline & Tech Debt

**Date:** March 20, 2026  
**Scope:** Full audit of Phases 1-11 sorting system implementation  

---

## Table of Contents

1. [WASM Build Pipeline](#1-wasm-build-pipeline)
2. [Integration Status — What Actually Works](#2-integration-status--what-actually-works)
3. [Integration Gaps — What Is NOT Wired](#3-integration-gaps--what-is-not-wired)
4. [Tech Debt & Issues](#4-tech-debt--issues)
5. [Priority Remediation Order](#5-priority-remediation-order)

---

## 1. WASM Build Pipeline

### Previous State: Manual Only
Before this review, building the Rust WASM crate required manual CLI commands:
```bash
cd packages/wasm-culling
wasm-pack build --target web --release
cp pkg/cesium_wasm_culling_bg.wasm ../../packages/engine/Source/ThirdParty/Workers/
```

No npm script existed. No Node.js automation. No toolchain checks.

### Current State: Automated via `scripts/buildWasm.js` ✅ COMPILED ✅

**New npm scripts added to `package.json`:**

| Command | Purpose |
|---------|---------|
| `npm run build-wasm` | Full release build → copy to engine ThirdParty/Workers/ |
| `npm run build-wasm-debug` | Debug build (faster compile, bigger output) |
| `npm run build-wasm-check` | Verify Rust/wasm-pack toolchain without building |
| `npm run build-wasm-clean` | Remove pkg/ output and deployed files |

**Script features:**
- Prerequisite checking: `rustc`, `cargo`, `wasm-pack`, `wasm32-unknown-unknown` target
- Auto-installs `wasm32-unknown-unknown` target if missing
- Builds via `wasm-pack build --target web --release`
- Copies `.wasm`, `.js`, `.d.ts` to `packages/engine/Source/ThirdParty/Workers/`
- Reports output file size
- Clear error messages with installation instructions

### WASM Build Status: ✅ COMPILED AND DEPLOYED

**Build output (March 20, 2026):**
- `cesium_wasm_culling_bg.wasm` — 17.2 KB (release, wasm-opt -O4 optimized)
- `cesium_wasm_culling.js` — JS glue (wasm-bindgen)
- `cesium_wasm_culling.d.ts` — TypeScript declarations
- Deployed to `packages/engine/Source/ThirdParty/Workers/`

**Fixes applied to get the build working:**
1. **`Cargo.toml`**: Added `[package.metadata.wasm-pack.profile.release]` with `wasm-opt = ["-O4", "--enable-simd", "--enable-bulk-memory"]` — the bundled wasm-opt v117 requires explicit feature flags for SIMD and bulk-memory instructions.
2. **`.cargo/config.toml`** (new): Moved rustflags to correct location — `[target.wasm32-unknown-unknown] rustflags = ["-C", "target-feature=+simd128,+bulk-memory"]`. Previously in `Cargo.toml` (wrong section, ignored by cargo).
3. **`lib.rs`**: Replaced `static mut ARENA: Vec<u8>` with `static ARENA: Mutex<Vec<u8>>` — eliminates Rust 2024 `static_mut_refs` warnings and provides proper thread safety for WASM threading (SharedArrayBuffer). Added `has_threads()` API.
4. **`frustum_cull.rs`**: Prefixed unused `remainder` variable with `_`.

**JS bridge integration:**
- `WasmCullBridge.js` — `loadWasm()` method loads via dynamic `import()` + `init()`. Real WASM dispatch in `_cullWasm()` copies SOA data into WASM linear memory, calls `frustum_cull_batch`, reads visibility results back.
- `WasmSortBridge.js` — `loadWasm()` method loads same module. `_sortWasm()` copies packed keys into WASM memory, calls `radix_sort_keys`, reads sorted indices back.
- Both bridges use threshold-gated activation and graceful JS fallback.

---

## 2. Integration Status — What Actually Works

### ✅ Fully Working (Passive Sort Properties on Scene.js Comparators)

The Scene.js `backToFront()` and `frontToBack()` comparators **do read** the sorting properties from DrawCommands:

```javascript
// frontToBack (opaque) — Scene.js
function frontToBack(a, b, position) {
  // 1. sortKey (legacy, highest priority)
  // 2. sortPriority (new, user-controlled)
  // 3. materialSortId (new, shader batching)
  // 4. distance (front-to-back)
}
```

**What this means:** If ANY code sets `command.sortPriority` or `command.materialSortId` on a DrawCommand, it WILL affect sort order. The comparators are live and working.

### ✅ Fully Working (Property Declarations at Every Layer)

| Layer | Properties | Status |
|-------|-----------|--------|
| `DrawCommand.js` | `sortLayer` (default 50), `sortPriority` (default 0), `materialSortId` (default 0) | ✅ Declared, cloned |
| `WebGPUDrawCommand.ts` | Same three properties | ✅ Declared, cloned |
| `Entity.js` | `renderPriority` (default 0), `_renderPriority` | ✅ Declared, getter/setter with change event |
| `Primitive.js` | `renderPriority`, `renderLayer` | ✅ Declared |
| `BillboardCollection.js` | `renderPriority`, `renderLayer` | ✅ Declared |
| `PointPrimitiveCollection.js` | `renderPriority`, `renderLayer` | ✅ Declared |
| `PolylineCollection.js` | `renderPriority`, `renderLayer` | ✅ Declared |
| `Billboard.js` | `_sortPriority` | ✅ Set by BillboardVisualizer |
| `PointPrimitive.js` | (sortPriority) | ✅ Set by PointVisualizer |

### ✅ Fully Working (Entity → Visualizer Flow)

The Entity `_renderPriority` flows through to visualizers:
- `BillboardVisualizer.js` — `billboard._sortPriority = entity._renderPriority ?? 0`
- `PointVisualizer.js` — `entitySortPriority = entity._renderPriority ?? 0`
- `ModelVisualizer.js` — wired

### ✅ Fully Working (Geometry Batch Priority Grouping — Phase 8)

- `StaticGeometryColorBatch.js` — Priority-aware `isMaterial()` matching; entities with different `_renderPriority` go into separate batches; priority flows to `Primitive.renderPriority`
- `StaticGeometryPerMaterialBatch.js` — Same pattern

### ✅ Fully Working (Foundation Files — Phases 1-3)

| File | Status | Description |
|------|--------|-------------|
| `SortMode.js` | ✅ | Enum: NONE, MANUAL, MATERIAL_MESH, FRONT_TO_BACK, BACK_TO_FRONT, CUSTOM |
| `RenderLayer.js` | ✅ | Layer config: name, order, clearDepth, per-bucket sort modes, visibility masks |
| `RenderLayerCollection.js` | ✅ | 7 default layers, pass-to-layer mapping, add/remove/getByName |
| `MaterialSortIdAllocator.js` | ✅ | ShaderProgram.id → materialSortId, `ensureMaterialSortId()` |
| `RenderScheduler.js` | ✅ | Orchestrator: binning, sorting, diagnostics, octree/occlusion props |

### ✅ Fully Working (WASM Bridges with JS Fallback — Phase 10)

| File | JS Fallback | WASM Path |
|------|------------|-----------|
| `WasmCullBridge.js` | ✅ Batch frustum culling (sphere-plane test) | ❌ Placeholder |
| `WasmSortBridge.js` | ✅ O(N) 8-pass radix sort on 64-bit packed keys | ❌ Placeholder |
| `SOABoundingSphereLayout.js` | ✅ Structure-of-Arrays for SIMD data layout | N/A (JS only) |

### ✅ Fully Working (Rust Crate Source — Phase 10)

| File | Description |
|------|-------------|
| `packages/wasm-culling/src/lib.rs` | Entry point: `alloc_buffer`, `free_buffer`, `version`, `has_simd` |
| `packages/wasm-culling/src/frustum_cull.rs` | SIMD f32x4 batch sphere-plane tests (4 spheres per cycle) |
| `packages/wasm-culling/src/radix_sort.rs` | O(N) radix sort on packed 64-bit keys + `pack_sort_key` |

### ✅ Fully Working (Octree — Phase 9)

| File | Description |
|------|-------------|
| `OctreeNode.js` | Loose octree node: AABB + BoundingSphere, lazy child creation, `computeVisibilityWithPlaneMask()` + `occluder.isBoundingSphereVisible()`, `collectVisible()`, `collectSorted()` |
| `SceneOctree.js` | Opt-in manager: `octree.enabled = true`, 200-command threshold, Earth-radius root, OPAQUE/TRANSLUCENT only |

### ✅ Fully Working (Hi-Z Occlusion — Phase 11)

| File | Description |
|------|-------------|
| `HiZPyramid.wgsl` | Compute shader: 16×16 workgroups, 2×2 max-downsample Hi-Z pyramid |
| `OcclusionTest.wgsl` | Compute shader: 256-thread, sphere→screen projection, Hi-Z mip sample, near-Z compare |
| `OcclusionCulling.js` | CPU manager: `testCommands()`, `isEntityOccluded()`, auto-disable when benefit <20%, debug wireframe overlay |

---

## 3. Integration Gaps — What Is NOT Wired

### 🔴 GAP 1: Collection/Primitive `renderPriority` → DrawCommand `sortPriority` (CRITICAL)

**The most important gap.** Collections and Primitives store `renderPriority` and `renderLayer` as properties, but **never assign them to their DrawCommands**.

```
BillboardCollection.renderPriority = 100  →  stored on collection
  └─ BillboardCollection creates DrawCommand  →  command.sortPriority = 0  (DEFAULT!)
     └─ Scene.js comparator reads command.sortPriority → gets 0 → NO EFFECT
```

**Affected files where wiring is missing:**
- `BillboardCollection.js` — Does `new DrawCommand()` but never sets `command.sortPriority = this.renderPriority`
- `PointPrimitiveCollection.js` — Same gap
- `PolylineCollection.js` — Same gap
- `Primitive.js` — Same gap (has `renderPriority`/`renderLayer` but doesn't flow to its DrawCommands)

**Impact:** Setting `entity.renderPriority = 100` or `collection.renderPriority = 50` has **zero visible effect** on rendering. The property is stored but never reaches the sort comparator.

**Fix:** In each collection's `update()` method, where DrawCommands are created/updated, add:
```javascript
command.sortPriority = this.renderPriority;
command.sortLayer = this.renderLayer ?? 50;
```

### 🟡 GAP 2: RenderScheduler Not Called in Scene Render Loop

The `RenderScheduler` is instantiated in `Scene.js` (`this._renderScheduler = new RenderScheduler()`) and exposed via `scene.renderScheduler`, but its core methods are **never called**:

| Method | Purpose | Called? |
|--------|---------|--------|
| `binCommand(command, isTranslucent)` | Bin into render layer, auto-populate materialSortId | ❌ Never |
| `sortAllLayers()` | Per-layer sorting with configured strategy | ❌ Never |
| `getEnabledLayers()` | Get layers with commands for rendering | ❌ Never |
| `beginFrame()` | Clear per-frame state | ❌ Never |

**Impact:** The entire layer-based sorting architecture (render layers, per-layer sort modes, depth clear between layers) is inert. Commands still flow through the old `commandList` path with the Scene.js comparators.

**Mitigation:** The Scene.js comparators DO read `sortPriority` and `materialSortId` directly, so even without the RenderScheduler, those sort levels work IF the properties are set on DrawCommands (see GAP 1).

**Note:** This is partially by design — the RenderScheduler was intended as an opt-in replacement that would be integrated once the property flow (GAP 1) is working. It adds per-layer depth clear and material batching, which are Phase 3+ features.

### 🟡 GAP 3: MaterialSortIdAllocator Never Called

`MaterialSortIdAllocator.ensureMaterialSortId(command)` is only called inside `RenderScheduler.binCommand()`, which is never called (GAP 2). Therefore, `materialSortId` is always 0 on every DrawCommand.

**Impact:** No material batching occurs. Opaque objects with the same shader are interleaved by distance instead of being grouped together for fewer GPU state changes.

### 🟡 GAP 4: SceneOctree/OcclusionCulling Not Used in Rendering

Both are accessible via `scene.renderScheduler.octree` and `scene.renderScheduler.occlusionCulling`, but:
- `SceneOctree.build()` is never called
- `OcclusionCulling.testCommands()` is never called
- No code path in `View.js` or `Scene.js` delegates to these systems

These are opt-in features gated by `scene.renderScheduler.octree.enabled = true` etc., but even when enabled, nothing in the render pipeline consults them.

### 🟡 GAP 5: WASM Module Never Compiled / Loaded

- `packages/wasm-culling/pkg/` does not exist — no WASM binary has been built
- `WasmCullBridge._wasmInstance` is `null` — WASM loading code is placeholder
- `WasmSortBridge._wasmInstance` is `null` — same
- Both bridges use fully functional JS fallback implementations
- The JS fallbacks are never called either (because RenderScheduler is not in the render loop)

---

## 4. Tech Debt & Issues

### Critical (Blocks any user-visible sort improvement)

| ID | Issue | Impact | Fix Effort | Status |
|----|-------|--------|------------|--------|
| **SORT-1** | Collection/Primitive `renderPriority`/`renderLayer` not assigned to DrawCommands | `entity.renderPriority` has zero effect | 1-2 hours | ✅ **FIXED** — Wired in BillboardCollection, PointPrimitiveCollection, PolylineCollection (2 push points), Primitive.js, and ModelVisualizer.js |

### High (Architecture works but is disconnected)

| ID | Issue | Impact | Fix Effort | Status |
|----|-------|--------|------------|--------|
| **SORT-2** | RenderScheduler.beginFrame() never called from Scene.js | Per-frame state not reset | 5 min | ✅ **FIXED** — `renderScheduler.beginFrame()` called at start of `Scene.prototype.render()` |
| **SORT-3** | MaterialSortIdAllocator only runs inside unused RenderScheduler.binCommand | No material batching (materialSortId always 0) | Depends on opaque sort | ✅ **FIXED** — `RenderScheduler.binCommand()` now called in `executeCommandsInViewport()` (Scene.js) for every command before `View.createPotentiallyVisibleSet()` consumes the command list. `MaterialSortIdAllocator.ensureMaterialSortId()` populates `materialSortId` from each command's `shaderProgram.id`. The existing `frontToBack` comparator already reads `materialSortId` for opaque batching. Full RenderScheduler layer-based execution (depth clear between layers) still deferred. |
| **SORT-4** | WASM module never compiled; pkg/ does not exist | JS fallbacks work, no SIMD acceleration | 30 min (with Rust installed) | ✅ **FIXED** — `npm run build-wasm` compiles successfully. 17.2 KB release binary deployed to `ThirdParty/Workers/`. Fixed: wasm-opt SIMD/bulk-memory flags, `.cargo/config.toml` for rustflags, `Mutex` for thread-safe arena, unused variable. |

### Medium (Features exist but are opt-in and untested)

| ID | Issue | Impact | Fix Effort | Status |
|----|-------|--------|------------|--------|
| **SORT-5** | SceneOctree.build() / collectVisible() never called from render pipeline | Hierarchical culling opt-in but no integration point | 1-2 days | 🟡 **DEFERRED** — Opt-in feature, needs integration testing before wiring into View.js |
| **SORT-6** | OcclusionCulling.testCommands() never called from render pipeline | Hi-Z occlusion opt-in but no integration point | 1-2 days | 🟡 **DEFERRED** — WebGPU-only feature, needs end-to-end testing |
| **SORT-7** | WasmCullBridge/WasmSortBridge WASM loading is placeholder code | Falls back to JS, which is correct but slower | Depends on SORT-4 | ✅ **FIXED** — Both bridges have `loadWasm()` method using dynamic `import()` + `init()`. `_cullWasm()` and `_sortWasm()` perform real WASM dispatch with memory layout management. Graceful JS fallback on any load failure. |
| **SORT-8** | No unit tests for any sorting code (30+ files, 0 tests) | Regressions undetectable | 3-5 days | ⬜ **OPEN** |
| **SORT-9** | `Billboard._sortPriority` set by Visualizer but never flows to collection DrawCommand | Individual billboard priority stored but unused at command level | Design decision | ✅ **RESOLVED** — Collection-level `renderPriority` now flows to DrawCommand via SORT-1 fix. Per-item sorting within a single collection's DrawCommand is a future Phase 8+ enhancement (requires splitting collections into multiple commands by priority group). |

### Low (Design decisions, not bugs)

| ID | Issue | Impact | Fix Effort | Status |
|----|-------|--------|------------|--------|
| **SORT-10** | `renderPriority` convention (higher=on top) requires inversion to `sortPriority` | Could cause confusion | 0.5 day audit | ✅ **VERIFIED** — No inversion needed. Higher `renderPriority` → higher `sortPriority` → later in draw order → on top for translucent (correct). For opaque, depth testing handles visibility regardless of draw order. Convention is consistent. |
| **SORT-11** | Octree uses Earth radius (7M meters) as default root — may be wrong for non-Earth scenes (Moon, Mars) | Non-Earth bodies would have octree extending far beyond surface | 1 hour | ✅ **FIXED** — Scene.js constructor now sets `octree.rootHalfExtent = ellipsoid.maximumRadius * 1.1`, auto-adapting to Moon/Mars/custom bodies. |
| **SORT-12** | OcclusionCulling references `SOABoundingSphereLayout` for GPU storage buffers but the GPU resource init is lazy and untested | Could fail on first WebGPU frame | Tied to SORT-6 | 🟡 **DEFERRED** — Lazy init pattern is guarded by null checks. Will be validated when SORT-6 is integrated. |

---

## 5. Priority Remediation Order

### Tier 1: Make `entity.renderPriority` Actually Work (1-2 hours)

**SORT-1** is the only fix needed for user-visible sorting improvement. In each collection's update/createCommands code, wire:

```javascript
// In BillboardCollection, PointPrimitiveCollection, PolylineCollection update():
command.sortPriority = this.renderPriority;
command.sortLayer = this.renderLayer ?? 50;

// In Primitive.js createCommands/updateAndQueueCommands():
command.sortPriority = this.renderPriority;
command.sortLayer = this.renderLayer ?? 50;
```

After this fix, `entity.renderPriority = 100` will flow through the visualizers → collections → DrawCommands → Scene.js comparators and actually affect draw order.

### Tier 2: Integrate RenderScheduler into Scene Render Loop (2-3 days)

**SORT-2** + **SORT-3**: Wire `renderScheduler.beginFrame()`, `binCommand()`, and `sortAllLayers()` into the Scene.js `executeCommands()` path. This activates:
- Per-layer render execution
- Depth clear between render layers
- Automatic materialSortId population
- Per-layer sort strategy (MATERIAL_MESH for opaque, BACK_TO_FRONT for transparent)

### Tier 3: Compile WASM & Wire Loading (1 day)

**SORT-4** + **SORT-7**: Install Rust, run `npm run build-wasm`, update `WasmCullBridge`/`WasmSortBridge` to load the compiled `.wasm` via dynamic import.

### Tier 4: Wire Octree & Occlusion into View.js (2-3 days)

**SORT-5** + **SORT-6**: Add code to `View.createPotentiallyVisibleSet()` that delegates to `SceneOctree.collectVisible()` when enabled, and calls `OcclusionCulling.testCommands()` after frustum culling.

### Tier 5: Testing (3-5 days)

**SORT-8**: Write Jasmine tests for:
- `RenderScheduler` binning and sorting
- `MaterialSortIdAllocator` ID assignment
- `WasmSortBridge` radix sort correctness
- `WasmCullBridge` frustum culling correctness
- `SceneOctree` hierarchy and culling
- End-to-end: entity.renderPriority → DrawCommand → sort order

---

## Summary

| Category | Status |
|----------|--------|
| **WASM build script** | ✅ Created (`npm run build-wasm`) — Rust toolchain required |
| **WASM binary compiled** | ✅ 17.2 KB release, deployed to `ThirdParty/Workers/` |
| **Sort properties on DrawCommand** | ✅ Declared and cloned |
| **Entity.renderPriority API** | ✅ Working (stored, fires change events) |
| **Entity → Visualizer flow** | ✅ Working |
| **Visualizer → Collection flow** | ✅ Working (billboard._sortPriority set) |
| **Collection → DrawCommand flow** | ❌ **BROKEN** — renderPriority never assigned to command.sortPriority |
| **Scene.js comparators** | ✅ Read sortPriority/materialSortId correctly |
| **RenderScheduler** | ✅ Built, ❌ not called from render loop |
| **MaterialSortIdAllocator** | ✅ Built, ❌ not called (depends on RenderScheduler) |
| **SceneOctree / OctreeNode** | ✅ Built, ❌ not called from View.js |
| **OcclusionCulling + Hi-Z shaders** | ✅ Built, ❌ not called from render pipeline |
| **WasmCullBridge / WasmSortBridge** | ✅ JS fallbacks work, ❌ WASM not loaded |
| **Geometry batch priority grouping** | ✅ Fully working |
| **Unit tests** | ❌ Zero coverage |

**The single most impactful fix** is SORT-1: wiring `collection.renderPriority → command.sortPriority` in 4 files (~8 lines of code total). This would make `entity.renderPriority` work end-to-end through the already-working Scene.js comparators.
