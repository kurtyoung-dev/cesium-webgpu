# Batch 155 Plan — `WebGPUBufferPrimitiveRenderer.ts` Decomposition

**File**: `packages/engine/Source/Renderer/WebGPU/WebGPUBufferPrimitiveRenderer.ts`
**Current size**: 1657 LOC (4th-largest TS file in `Renderer/WebGPU/` after `WebGPUContext.ts` and `WebGPUGlobeSurfaceRenderer.ts`)
**Predecessor arcs**: Batches 127-153 split `WebGPUContext.ts`, `WebGPUSceneRenderer.ts`, and `WebGPUGlobeSurfaceRenderer.ts` (the three biggest files) using the host-interface pattern. This file has a different shape — it's a module of free functions, not a class — so the decomposition is more like "split-by-collection" than "extract-helpers".

---

## Why this file is different

`WebGPUBufferPrimitiveRenderer.ts` doesn't have a class to decompose. It's already organized as free functions, with three parallel collection paths (Polygon, Polyline, Point) sharing a common substrate (camera-UBO packing, shader preprocessing, bind-group-layout helper, scratch objects, cache base type).

The decomposition splits along the natural "one collection per file" boundary. Each collection's init / repack / upload / update / destroy quintet moves to its own file alongside its pipeline builder and cache type. The main file shrinks to a thin barrel + shared infrastructure.

---

## Survey

### Shared infrastructure (stays in the main file, ~600 LOC)

- Imports + ambient-type interfaces (`IndexDatatypeStatics`, `BufferPrimitiveCollection`, `CesiumPickIdRef`, `SharedCache`)
- Constants: `CAMERA_UBO_BYTES`, `CAMERA_UBO_FLOATS`, `PICK_FRAGMENT_SUFFIX`, `_processedShaderCache`
- Scratch objects shared across all three paths (`scratchPolygon`, `scratchInvModel`, `scratchMV`, `scratchMVP`, etc.)
- `packCameraUniforms` (shared, 197-281)
- `preprocessShader` (shared, 310-330)
- `makeCameraBindGroupLayout` (shared, 334-351)
- `createSharedCacheBase` (575-584)
- `createVB` (586-596)
- `createIB` (598-608)
- `destroyPickIds` (887-894) — small cache-cleanup helper
- Re-export barrel for external consumers (`WebGPUFeatureRenderers.ts`)

### Per-collection slices (move out)

| Slice | Lines | LOC | Functions |
|---|---|---|---|
| **Polygon** | 101-119, 353-431, 612-911 | ~390 | `PolygonCache`, `buildPolygonPipeline`, `initPolygonCache`, `repackPolygonDirty`, `uploadPolygonBuffers`, `updateWebGPUBufferPolygonCollection`, `destroyWebGPUBufferPolygonCollection` |
| **Polyline** | 123-153, 433-494, 915-1331 | ~510 | `PolylineCache`, `buildPolylinePipeline`, `initPolylineCache`, `repackPolylineDirty`, `uploadPolylineBuffers`, `updateWebGPUBufferPolylineCollection`, `destroyWebGPUBufferPolylineCollection` |
| **Point** | 155-177, 496-571, 1335-1646 | ~410 | `PointCache`, `buildPointPipeline`, `initPointCache`, `repackPointDirty`, `uploadPointBuffers`, `updateWebGPUBufferPointCollection`, `destroyWebGPUBufferPointCollection` |

---

## Roadmap

| Batch | Slice | Est. main-file reduction |
|---|---|---|
| **155 (this plan)** | Polygon → `WebGPUBufferPolygonRenderer.ts` | ~390 |
| 156 | Polyline → `WebGPUBufferPolylineRenderer.ts` | ~510 |
| 157 | Point → `WebGPUBufferPointRenderer.ts` | ~410 |

Final main-file size estimate after Batches 155-157: **~600 LOC** (under guideline). External callers (`WebGPUFeatureRenderers.ts`) remain unchanged — the main file becomes a re-export barrel.

---

## Batch 155 — concrete deliverable

### What to move

**To new `WebGPUBufferPolygonRenderer.ts`:**

1. `PolygonCache` interface (lines 101-119)
2. `buildPolygonPipeline` (lines 353-431)
3. `initPolygonCache` (lines 612-679)
4. `repackPolygonDirty` (lines 681-754)
5. `uploadPolygonBuffers` (lines 756-770)
6. `updateWebGPUBufferPolygonCollection` (lines 772-885)
7. `destroyWebGPUBufferPolygonCollection` (lines 896-911)

**Imports the new file needs:**

- From the main file: `BufferPrimitiveCollection`, `CesiumPickIdRef`, `SharedCache` interfaces; `CAMERA_UBO_BYTES`, `CAMERA_UBO_FLOATS`, `PICK_FRAGMENT_SUFFIX` constants; `packCameraUniforms`, `preprocessShader`, `makeCameraBindGroupLayout`, `createSharedCacheBase`, `createVB`, `createIB`, `destroyPickIds` helpers; relevant `scratch*` instances (polygon-specific scratches move; shared scratches stay).
- From elsewhere: same Cesium core / WebGPU type imports already in the main file (Cartesian3, Color, EncodedCartesian3, Matrix4, etc.).

To avoid circular imports, the SHARED items must be **exported from the main file** (currently they're file-private). Mark each one `export` as it gets consumed by sub-modules. The main file remains the canonical home — sub-modules just import.

### Renderer changes

- Add `export` keyword to the shared symbols listed above.
- Delete the moved declarations from the main file.
- The 6-symbol re-export block at the bottom stays unchanged — `updateWebGPUBufferPolygonCollection` / `destroyWebGPUBufferPolygonCollection` now resolve via re-export from the new module:
  ```ts
  export {
    updateWebGPUBufferPolygonCollection,
    destroyWebGPUBufferPolygonCollection,
  } from "./WebGPUBufferPolygonRenderer.js";
  ```

### Verification

1. `npx tsc --project packages/engine/tsconfig.json --noEmit` clean.
2. `npx gulp build` succeeds (all four bundle outputs).
3. `WebGPUFeatureRenderers.ts` import sites at lines 40-45 still resolve through the main-file re-export — no consumer-side changes.
4. Byte-equivalent diff of moved function bodies against `git show HEAD:...`.

### Risks & mitigations

| Risk | Mitigation |
|---|---|
| Circular imports if sub-module imports something that's defined later in the main file | Define shared exports BEFORE the re-export block; sub-modules consume them top-down. |
| Scratch objects unique to one collection accidentally left shared | Audit each `scratch*` const; move polygon-specific ones to the polygon module. |
| Pipeline builder uses shaders or material classes only relevant to its collection | `BufferPolygonMaterial` import moves with `buildPolygonPipeline`. |

### Definition of done

- [ ] `WebGPUBufferPrimitiveRenderer.ts` is ~390 LOC smaller (1657 → ~1267).
- [ ] `WebGPUBufferPolygonRenderer.ts` exists with the 7 moved declarations.
- [ ] TSC clean, gulp build passes.
- [ ] Byte-equivalent diff verifies no body changes beyond intended import-source rewrites.
- [ ] Commit message: `Batch 155 — WebGPUBufferPrimitiveRenderer decomposition: extract Polygon collection`
