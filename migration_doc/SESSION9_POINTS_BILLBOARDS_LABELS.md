# WebGPU Migration — Session 9: Point Primitives, Billboards & Labels

**Date:** February 17, 2026  
**Previous Session:** Session 8 (Feb 16, 2026) — Tier 0 Integration Complete  
**Goal:** WebGPU support for collection-based rendering (PointPrimitive, Billboard, Polyline, Label)

---

## ✅ Completed: Phase 1 — PointPrimitiveCollection WebGPU Support

### Problem
WebGPU has **no equivalent** to `gl_PointSize` or `gl_PointCoord`. Points are always 1 pixel. The existing WebGL PointPrimitiveCollection uses `PrimitiveType.POINTS` with `gl_PointSize` for variable-size rendering and `gl_PointCoord` for circle/outline fragment shading. None of this works in WebGPU.

### Solution: Instanced Screen-Space Quads
Each point is rendered as an **instanced quad** (6 vertices = 2 triangles) expanded in the vertex shader:

1. **Vertex shader** uses `vertex_index` (0-5) to determine quad corner position
2. Transforms the point's world position to clip space via MVP matrix
3. Applies a **screen-space pixel offset** (corner × totalSize / viewportSize × clipPos.w)
4. **Fragment shader** computes distance from UV center for circle shape
5. Uses `smoothstep` for anti-aliased edges and outline/fill color mixing

### Architecture

```
PointPrimitiveCollection.update(frameState)
  ├── isWebGPU? → updateWebGPUPointPrimitives()    [NEW]
  │     ├── buildInstanceData()     — packs point data into Float32Array
  │     ├── createPointPipeline()   — creates GPU pipeline (once, cached)
  │     ├── packUniforms()          — updates MVP + viewport every frame
  │     ├── WebGPUDrawCommand       — instanced: 6 verts × N instances
  │     └── push to commandList
  └── isWebGL? → original WebGL path (unchanged)
```

### Files Created (6 new files)

| File | Type | Description |
|------|------|-------------|
| `Source/Shaders/WebGPU/Collections/PointPrimitiveColor.wgsl` | WGSL | Color shader — instanced quad expansion + circle rendering + outline |
| `Source/Shaders/WebGPU/Collections/PointPrimitivePick.wgsl` | WGSL | Pick shader — same quad expansion, outputs pick color |
| `packages/engine/Source/Renderer/WebGPU/WebGPUCollectionShaders.js` | JS | Shader loader for collection rendering (extensible for Billboard/Polyline) |
| `packages/engine/Source/Renderer/WebGPU/WebGPUPointPrimitiveRenderer.js` | JS | Point rendering module — instance buffer building, pipeline, draw commands |
| `Apps/WebGPUTest/point-primitives-webgpu.html` | HTML | 7-test standalone test page |
| `migration_doc/SESSION9_POINTS_BILLBOARDS_LABELS.md` | MD | This documentation |

### Files Modified (2 files)

| File | Change |
|------|--------|
| `packages/engine/Source/Scene/PointPrimitiveCollection.js` | Added WebGPU import + early return in `update()` for WebGPU path + cleanup in `destroy()` |
| `packages/engine/Source/Scene/Scene.js` | Added `initCollectionShaders` import + call in `Scene.createAsync()` |

### Instance Data Layout (64 bytes per point)

| Location | Content | Format |
|----------|---------|--------|
| @location(0) | positionHigh.xyz, pixelSize | vec4<f32> |
| @location(1) | positionLow.xyz, outlineWidth | vec4<f32> |
| @location(2) | color rgba | vec4<f32> |
| @location(3) | outlineColor.rgb, show (0/1) | vec4<f32> |

### Uniform Layout (256 bytes, aligned)

| Offset | Content | Size |
|--------|---------|------|
| 0-63 | MVP matrix (mat4x4<f32>) | 64 bytes |
| 64-71 | viewport width, height | 8 bytes |
| 72-75 | splitPosition | 4 bytes |
| 76-255 | padding | 180 bytes |

### Test Results (7/7 pass)

| # | Test | Result |
|---|------|--------|
| T1 | Shader Compilation | ✅ WGSL compiled without errors |
| T2 | Basic Points (3 colors) | ✅ Red/green/blue circles rendered as instanced quads |
| T3 | Points with Outlines | ✅ Yellow/black, White/red, Cyan/blue outlines |
| T4 | Show/Hide Toggle | ✅ Hidden point moved off-screen by vertex shader |
| T5 | Many Points (100) | ✅ 100 random points in 0.40ms, 600 vertices, 6400 bytes |
| T6 | Variable Sizes | ✅ 5px → 53px with blue-to-red gradient |
| T7 | Semi-transparent Overlap | ✅ RGB at 50% alpha with correct blending |

### Key Technical Details

- **No index buffer needed** — 6 vertices per quad via `vertex_index` (0-5 → 2 triangles)
- **Instance step mode** — GPU processes one instance buffer entry per point
- **GPU cache** stored on `collection._webgpuCache` (pipeline, buffers, bind group, draw command)
- **Pipeline created once**, uniform buffer updated every frame (camera/viewport changes)
- **Instance buffer rebuilt** only when points are added/removed/modified
- **Alpha blending enabled** for semi-transparent points
- **Depth test** with `less-equal` comparison
- **Anti-aliased circles** via `smoothstep` in fragment shader

---

## 📋 Next Steps: Phase 2 & 3

### Phase 2: BillboardCollection WebGPU Support
- Same instanced quad approach as points
- Additional: texture atlas (sampler/texture bind group), SDF rendering for labels
- Enables LabelCollection for free (Labels delegate to BillboardCollection)
- Need: `BillboardColor.wgsl`, `BillboardPick.wgsl`, `WebGPUBillboardRenderer.js`

### Phase 3: PolylineCollection WebGPU Support
- Most complex — line segments expanded into screen-space quads
- 4 vertices per segment with miter join calculations
- Material support (dashed lines, etc.)
- Need: `PolylineColor.wgsl`, `PolylinePick.wgsl`, `WebGPUPolylineRenderer.js`

---

## 📈 Updated Progress

| Metric | Before | After |
|--------|--------|-------|
| WebGPU JS/TS files | 22 | 24 (+WebGPUCollectionShaders, +WebGPUPointPrimitiveRenderer) |
| WGSL shader files | 27 | 29 (+PointPrimitiveColor, +PointPrimitivePick) |
| Test pages | 26 | 27 (+point-primitives-webgpu.html) |
| Collection WebGPU support | 0/4 | 1/4 (PointPrimitive ✅) |

---

**Document Status:** 🟢 COMPLETE  
**Last Updated:** February 17, 2026 12:30 AM ET
