# WebGPU Migration — Session 6: Material, Texture & PBR Plan

**Date:** February 16, 2026  
**Previous Session:** Session 5 (Feb 14-15, 2026)  
**Goal:** Full support for texturing, materials, and PBR in the Primitive pipeline

---

## ✅ Completed in This Session (Feb 16, 2026)

### Phase A: Shader File Restructuring
All WGSL shader source code has been extracted from `WebGPUPrimitiveShaders.js` into individual `.wgsl` files.

**20 new .wgsl files created in `Source/Shaders/WebGPU/Primitive/`:**

| # | File | Category | Description |
|---|---|---|---|
| 1 | `PrimitiveBasicColor.wgsl` | Per-instance | Flat color (pos+color) |
| 2 | `PrimitivePhongColor.wgsl` | Per-instance | Phong lit (pos+normal+color) |
| 3 | `PrimitiveBasicTexturedColor.wgsl` | Per-instance | Textured (pos+uv+color) |
| 4 | `PrimitivePhongTexturedColor.wgsl` | Per-instance | Phong+textured (pos+normal+uv+color) |
| 5 | `PrimitivePickBasic.wgsl` | Pick | Pick for basic layout |
| 6 | `PrimitivePickPhong.wgsl` | Pick | Pick for phong layout |
| 7 | `PrimitivePickBasicTextured.wgsl` | Pick | Pick for basicTextured layout |
| 8 | `PrimitivePickPhongTextured.wgsl` | Pick | Pick for phongTextured layout |
| 9 | `PrimitiveMatColorFlat.wgsl` | Material | Uniform color, flat |
| 10 | `PrimitiveMatColorLit.wgsl` | Material | Uniform color, Phong |
| 11 | `PrimitiveMatImageFlat.wgsl` | Material | Image/DiffuseMap, flat |
| 12 | `PrimitiveMatImageLit.wgsl` | Material | Image/DiffuseMap, Phong |
| 13 | `PrimitiveMatCheckerFlat.wgsl` | Material | Checkerboard, flat |
| 14 | `PrimitiveMatCheckerLit.wgsl` | Material | Checkerboard, Phong |
| 15 | `PrimitiveMatGridFlat.wgsl` | Material | Grid lines, flat |
| 16 | `PrimitiveMatStripeFlat.wgsl` | Material | Stripes, flat |
| 17 | `PrimitivePickMatFlat.wgsl` | Pick | Pick for material flat layout (pos+st) |
| 18 | `PrimitivePickMatLit.wgsl` | Pick | Pick for material lit layout (pos+normal+st) |
| 19 | `PrimitivePBRSimple.wgsl` | PBR | Metallic-roughness, no textures |
| 20 | `PrimitivePBRTextured.wgsl` | PBR | Metallic-roughness + base color texture |

**`WebGPUPrimitiveShaders.js` rewritten as thin orchestrator (~470 lines):**
- No inline WGSL shader strings (down from ~1,700 lines)
- `initPrimitiveShaders(basePath)` — async function that fetches all .wgsl files via `fetch()`
- `getShaderSource(key)` — returns cached WGSL source by key
- All existing selection/layout/sizing functions preserved
- New exports: `initPrimitiveShaders`, `areShadersLoaded`, `getShaderSource`, `getMaterialPickShaderForType`, `selectPBRShader`, `isPBRShader`, `isPBRTexturedShader`

### Phase B: Wiring (Tasks 1-2)

| Task | Status | Description |
|------|--------|-------------|
| Task 1 | ✅ Done | Updated imports in `WebGPUPrimitiveCommands.js` — added 10 new import names for material/PBR functions |
| Task 2 | ✅ Done | Wired `initPrimitiveShaders()` into `Scene.createAsync()` — added import + `await initPrimitiveShaders()` call in WebGPU path with progress reporting |

---

## ❌ Remaining Tasks — Broken Into Small Sub-Tasks

> **Rule:** Each sub-task adds ≤50 lines of new code per `replace_in_file` call.  
> For larger additions, use `write_to_file` for the complete file instead.

---

### Task 3a: Add `packMaterialUniforms()` helper function (~40 lines)

**File:** `packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js`  
**Strategy:** Small `replace_in_file` — insert before the export block  
**Description:** Packs material-specific uniform data into a Float32Array based on shader type.

**Uniform layout per shader type (all 256 bytes / 64 floats):**

| Shader Type | Offset 0-15 | Offset 16-19 | Offset 20-23 | Offset 24-27 |
|-------------|-------------|--------------|--------------|--------------|
| matColorFlat | MVP | materialColor(rgba) | — | — |
| matCheckerFlat | MVP | lightColor(rgba) | darkColor(rgba) | repeat(xy)+pad(zw) |
| matGridFlat | MVP | color(rgba) | cellAlpha_lineCount(xyzw) | lineThickness_lineOffset(xyzw) |
| matStripeFlat | MVP | evenColor(rgba) | oddColor(rgba) | params(offset,repeat,horiz,0) |
| matImageFlat | MVP | colorTint(rgba) | repeat(xy)+pad(zw) | — |

For **lit** variants, MVP is at 0-15, ModelView at 16-31, NormalMatrix at 32-47, LightDir at 48-51, then material params start at **offset 52**.

**Function signature:**
```js
function packMaterialUniforms(uniformData, shaderType, material, startOffset)
```

---

### Task 3b: Add `createMaterialPipelineAndCache()` helper function (~50 lines)

**File:** `packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js`  
**Strategy:** Small `replace_in_file` — insert after `packMaterialUniforms`  
**Description:** Creates the GPU pipeline (shader module, bind group layout, render pipeline) for material rendering and caches it on `primitive._webgpuCache`.

**Key logic:**
1. Create shader module from `shaderInfo.code`
2. Create bind group layout (uniforms need VERTEX | FRAGMENT for all material shaders since fragment reads material params)
3. If `needsTexture`: create texture bind group layout (group 1: sampler + texture2d)
4. Create render pipeline with material vertex layout
5. Cache on `primitive._webgpuCache` (reuse if shader type unchanged)

---

### Task 3c: Add `buildMaterialVertexData()` helper function (~40 lines)

**File:** `packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js`  
**Strategy:** Small `replace_in_file` — insert after `createMaterialPipelineAndCache`  
**Description:** Builds interleaved vertex data for material shaders (no per-vertex color).

**Vertex formats:**
- Flat: position(3) + st(2) = 5 floats/vertex
- Lit/PBR: position(3) + normal(3) + st(2) = 8 floats/vertex

---

### Task 3d: Add `createWebGPUMaterialCommands()` main function (~50 lines)

**File:** `packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js`  
**Strategy:** Small `replace_in_file` — insert after `buildMaterialVertexData`  
**Description:** Orchestrates material command creation by calling the helpers from 3a-3c.

**Key logic:**
1. Extract geometry data (same position/normal/st/index extraction as `createWebGPUCommands`)
2. Detect material type and call `selectMaterialShader()`
3. Call `createMaterialPipelineAndCache()` to get/create pipeline
4. For each geometry: call `buildMaterialVertexData()`, create buffers, call `packMaterialUniforms()`, create bind groups, create draw command
5. Create pick commands using `getMaterialPickShaderForType()`

---

### Task 4: Add `updateWebGPUMaterialCommandUniforms()` (~40 lines)

**File:** `packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js`  
**Strategy:** Small `replace_in_file` — insert after `createWebGPUMaterialCommands`  
**Description:** Per-frame uniform update for material commands (same pattern as `updateWebGPUCommandUniforms` but handles lit/flat material shader types).

**Key logic:**
- For lit/PBR shaders: update MVP + ModelView + NormalMatrix + LightDir (material params are constant)
- For flat shaders: update MVP only (material params are constant)
- Uses `isMaterialLitShader()` or `isPBRShader()` to determine which path

---

### Task 5: Export new functions (~5 lines)

**File:** `packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js`  
**Strategy:** Small `replace_in_file` on the export block  
**Description:** Add `createWebGPUMaterialCommands` and `updateWebGPUMaterialCommandUniforms` to exports.

---

### Task 6a: Add imports to `Primitive.js` (~3 lines)

**File:** `packages/engine/Source/Scene/Primitive.js`  
**Strategy:** Small `replace_in_file` on the import block  
**Description:** Add `createWebGPUMaterialCommands` and `updateWebGPUMaterialCommandUniforms` to the import from `WebGPUPrimitiveCommands.js`.

---

### Task 6b: Update `createCommands()` router in `Primitive.js` (~15 lines)

**File:** `packages/engine/Source/Scene/Primitive.js`  
**Strategy:** Small `replace_in_file` on the `createCommands` function  
**Description:** Detect `MaterialAppearance` / `EllipsoidSurfaceAppearance` and route to `createWebGPUMaterialCommands()`.

**Logic:**
```js
if (isWebGPU) {
  const hasMaterial = defined(appearance.material);
  if (hasMaterial) {
    createWebGPUMaterialCommands(...);
  } else {
    createWebGPUCommands(...);
  }
}
```

---

### Task 6c: Update `updateAndQueueCommands()` in `Primitive.js` (~10 lines)

**File:** `packages/engine/Source/Scene/Primitive.js`  
**Strategy:** Small `replace_in_file` on the `updateAndQueueCommands` function  
**Description:** Call `updateWebGPUMaterialCommandUniforms()` for material commands (identified by `_webgpuShaderType` starting with "mat" or "pbr").

---

### Task 7: Add PBR support to `packMaterialUniforms()` (~20 lines)

**File:** `packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js`  
**Strategy:** Extend `packMaterialUniforms()` and `createWebGPUMaterialCommands()`  
**Description:** Add PBR material type detection and uniform packing.

**PBR uniform layout (lit layout, params at offset 52):**
- baseColorFactor(4 floats at 52-55)
- pbrParams: metallic, roughness, occlusion, unused (4 floats at 56-59)
- emissiveFactor(4 floats at 60-63)

---

### Task 8: Create test page (`write_to_file` — new file)

**File:** `Apps/WebGPUTest/primitive-material-webgpu.html`  
**Strategy:** `write_to_file` (new file, ~300 lines)  
**Description:** HTML test page exercising all material types.

**Tests:**
1. Color material (flat) — solid color polygon
2. Color material (lit) — lit solid color box
3. Checkerboard material — checkerboard polygon
4. Grid material — grid lines on rectangle
5. Stripe material — striped wall
6. PBR Simple — metallic/roughness geometry

---

### Task 9: Update migration doc status (~10 lines)

**File:** `migration_doc/SESSION5_CONTINUATION_PLAN.md`  
**Strategy:** Small `replace_in_file`  
**Description:** Update Item #4 status to complete, add to completed items log.

---

## 📋 Task Execution Order

```
Task 3a  →  packMaterialUniforms() helper              (~40 lines, replace_in_file)
Task 3b  →  createMaterialPipelineAndCache() helper     (~50 lines, replace_in_file)
Task 3c  →  buildMaterialVertexData() helper            (~40 lines, replace_in_file)
Task 3d  →  createWebGPUMaterialCommands() main         (~50 lines, replace_in_file)
Task 4   →  updateWebGPUMaterialCommandUniforms()       (~40 lines, replace_in_file)
Task 5   →  Export new functions                        (~5 lines, replace_in_file)
Task 6a  →  Add imports to Primitive.js                 (~3 lines, replace_in_file)
Task 6b  →  Update createCommands() router              (~15 lines, replace_in_file)
Task 6c  →  Update updateAndQueueCommands()             (~10 lines, replace_in_file)
Task 7   →  PBR support extensions                      (~20 lines, replace_in_file)
Task 8   →  Test page                                   (~300 lines, write_to_file)
Task 9   →  Update migration doc                        (~10 lines, replace_in_file)
```

**Total estimated time:** ~2 hours for all remaining tasks  
**Max lines per edit:** ≤50 lines (per .clinerules safety rules)

---

## 📁 Files That Need Changes

| File | Tasks | Type of Change |
|---|---|---|
| `WebGPUPrimitiveCommands.js` | 3a, 3b, 3c, 3d, 4, 5, 7 | Add 4 helper functions + 1 main function + update exports |
| `Primitive.js` | 6a, 6b, 6c | Add imports + modify router + modify uniform updates |
| `primitive-material-webgpu.html` | 8 | New test page (write_to_file) |
| `SESSION5_CONTINUATION_PLAN.md` | 9 | Update status |

---

## 🔑 Shader Uniform Layout Reference

### Flat Material Shaders (MVP at offset 0-15, params at 16+)

| Type | Offset 16 | Offset 20 | Offset 24 |
|------|-----------|-----------|-----------|
| matColorFlat | materialColor(4f) | — | — |
| matCheckerFlat | lightColor(4f) | darkColor(4f) | repeat(2f)+pad(2f) |
| matGridFlat | color(4f) | cellAlpha_lineCount(4f) | lineThickness_lineOffset(4f) |
| matStripeFlat | evenColor(4f) | oddColor(4f) | params(4f) |
| matImageFlat | colorTint(4f) | repeat(2f)+pad(2f) | — |

### Lit Material Shaders (MVP+MV+NM+LD at 0-51, params at 52+)

| Type | Offset 52 | Offset 56 | Offset 60 |
|------|-----------|-----------|-----------|
| matColorLit | materialColor(4f) | — | — |
| matCheckerLit | lightColor(4f) | darkColor(4f) | repeat(2f)+pad(2f) |
| matImageLit | colorTint(4f) | repeat(2f)+pad(2f) | — |

### PBR Shaders (MVP+MV+NM+LD at 0-51, params at 52+)

| Type | Offset 52 | Offset 56 | Offset 60 |
|------|-----------|-----------|-----------|
| pbrSimple | baseColorFactor(4f) | pbrParams(4f) | emissiveFactor(4f) |
| pbrTextured | baseColorFactor(4f) | pbrParams(4f) | emissiveFactor(4f) |

### Pick Shaders (MVP at 0-15, pickColor at 16-19)

All pick shaders (pickMatFlat, pickMatLit) use: MVP(16f) + pickColor(4f) = 20 floats in 256 bytes.

---

## 🔑 Current State Summary

**What's ready:**
- ✅ 20 .wgsl shader files in `Source/Shaders/WebGPU/Primitive/`
- ✅ `WebGPUPrimitiveShaders.js` rewritten as thin orchestrator with fetch-based loading
- ✅ All shader selection, layout, and sizing functions working
- ✅ PBR shader support (pbrSimple + pbrTextured)
- ✅ Material pick shader support (pickMatFlat + pickMatLit)
- ✅ `WebGPUPrimitiveCommands.js` imports updated with all new function names
- ✅ `initPrimitiveShaders()` wired into `Scene.createAsync()` — shaders load at startup

**What was wired in Phase B continuation (Tasks 3-7):**
- ✅ `packMaterialUniforms()` helper — packs all material types + PBR into uniform buffers
- ✅ `createMaterialPipelineAndCache()` helper — creates/caches material GPU pipelines
- ✅ `buildMaterialVertexData()` helper — builds interleaved vertex data (flat/lit)
- ✅ `extractPositionData()` helper — shared position extraction (high/low RTE support)
- ✅ `ensureIndexBuffer()` helper — shared index buffer creation
- ✅ `createWebGPUMaterialCommands()` — main orchestrator for material command creation
- ✅ `updateWebGPUMaterialCommandUniforms()` — per-frame camera matrix updates for material commands
- ✅ All new functions exported from `WebGPUPrimitiveCommands.js`
- ✅ `Primitive.js` detects MaterialAppearance and routes to `createWebGPUMaterialCommands()`
- ✅ `Primitive.js` per-frame update detects "mat"/"pbr" shader types for material uniform updates
- ✅ PBR uniform packing (pbrSimple, pbrTextured) with baseColorFactor, metallic, roughness, emissive

**What was completed in Phase B final (Task 8):**
- ✅ Test page `Apps/WebGPUTest/primitive-material-webgpu.html` — 7 standalone WebGPU tests:
  1. MatColorFlat — solid coral quad
  2. MatColorLit — lit gold quad with Phong shading
  3. MatCheckerFlat — 8×8 procedural checkerboard
  4. MatGridFlat — 10×10 cyan grid lines
  5. MatStripeFlat — 6 red/white vertical stripes
  6. PBRSimple — copper metallic-roughness quad
  7. MatImageFlat — 3×3 tiled checkerboard with warm tint (2 bind groups)

**⚠️ Note:** The existing per-instance-color pipeline is now functional again — `initPrimitiveShaders()` is called from `Scene.createAsync()` so the fetch-loaded shaders are available before any primitives render.

---

**Document Status:** 🟢 COMPLETE  
**Last Updated:** February 16, 2026 10:04 PM ET
