> **STATUS: SHIPPED — ARCHIVED 2026-05-30.** This decomposition plan was executed and landed; retained as rationale-of-record, not live work. Index: `migration_doc/README.md`; live roll-up: `WEBGPU_CONTEXT_DECOMPOSITION_PLAN.md`.

# Batch 145 Plan — `WebGPUGlobeSurfaceRenderer.ts` Decomposition

**Status**: ✅ **COMPLETE (2026-05-01)** — All 9 batches (145-153) shipped. Renderer reduced 3933 → 1310 LOC (−67%). Batch 154 evaluated and skipped (diminishing returns; remaining `createTileCommands` body is the public orchestrator and has no natural sub-decomposition). See `WEBGPU_MIGRATION_STATUS.md` § "Recent Progress (2026-05-01)" for the full arc summary.

**File**: `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts`
**Original size**: 3933 LOC (second-largest TS file in `Renderer/WebGPU/`)
**Final size**: 1310 LOC
**Sibling decomposition**: Batches 127–144 split `WebGPUContext.ts` (4427 → 4119) and `WebGPUSceneRenderer.ts` (3626 → 2111) into 17 focused helper modules. This plan opens the next file with the same pattern.

---

## Why this file is risky

`WebGPUGlobeSurfaceRenderer` is the **hottest path in the WebGPU backend** — every visible globe tile flows through `createTileCommands` and the uniform-packing methods every frame. A regression here is more visible than a regression in (say) the pick pass or device-loss recovery. So this batch is intentionally conservative: extract the **lowest-risk slice first**, prove the pattern, then ramp up.

---

## Survey — what's actually in the file

Sectional breakdown by line range:

| Section | Lines | LOC | Risk if extracted |
|---|---|---|---|
| Imports | 1–22 | 22 | n/a |
| `GlobePipelineEntry` interface | 23–38 | 16 | trivial |
| CameraUniforms layout doc + sizes | 39–84 | 46 | trivial (data) |
| TileUniforms layout doc + offsets | 86–154 | 69 | trivial (data) |
| `resolveImageryLayerValue` free fn | 156–200 | 45 | low (pure fn) |
| `multiplyMat4ColumnMajor` free fn | 202–237 | 36 | low (pure fn) |
| `PipelineKey` const enum | 239–250 | 12 | trivial |
| `TileGPUResources` interface | 252–278 | 27 | trivial |
| `ImageryGPUTexture` interface | 280–286 | 7 | trivial |
| `TileDrawDescriptor` interface (exported) | 288–320 | 33 | trivial |
| `DebugFragmentMode` const enum (exported) | 322–334 | 13 | trivial |
| **Class state fields** | 336–459 | 124 | n/a (stays) |
| Constructor | 461–463 | 3 | n/a (stays) |
| `initialize` / `isInitialized` | 465–488 | 24 | low (orchestrator) |
| Shader module factory cluster | 490–816 | 327 | **medium** — reads `_device`, `_canvasFormat`, `_shaderCode`, three module caches |
| Bind group / pipeline layout setup | 818–945 | 128 | **medium** — reads `_device`, writes 7 cache fields |
| Pipeline construction (descriptor + GPU + select) | 947–1395 | 449 | **high** — touches most of the state, big surface |
| `createTileCommands` (public main entry) | 1397–1962 | 566 | **highest** — heart of the renderer |
| `createTileCommand` (variant entry) | 1964–1998 | 35 | n/a (delegator) |
| `_getTileKey` | 2000–2006 | 7 | trivial helper |
| `_getOrCreateTileBuffers` | 2008–2266 | 259 | medium (touches device + cache) |
| `_writeTerrainShadowUB` | 2268–2296 | 29 | low |
| `_createCameraUniformBuffer` | 2298–2581 | 284 | **medium-high** — math-heavy, hot path |
| `_writeUniformSlice`, `_computeModifiedModelView` | 2583–2655 | 73 | low |
| `_createTileUniformBuffer` | 2657–3156 | 500 | **highest** — biggest single method, many imagery branches |
| `_createTextureBindGroup`, `_createWaterOceanBindGroup` | 3158–3275 | 118 | low |
| Texture caching (`_getOrCreateImageryTexture`, water mask, `_uploadImageSource`) | 3277–3437 | 161 | low-medium |
| Wireframe path | 3439–3800 | 362 | medium |
| `evictStaleResources`, `removeImageryTexture`, `destroy`, `isDestroyed` | 3802–3933 | 132 | low |

**Total class body**: 3597 LOC. **Module-level**: 335 LOC.

---

## Roadmap — where this is heading

The roadmap below is a sketch, not a contract. Sizes are pre-extraction estimates; ordering is risk-ascending so we surface problems on cold paths first.

| Batch | Slice | Est. LOC removed |
|---|---|---|
| **145 (this plan)** | Module-level types/constants/free helpers → `WebGPUGlobeSurfaceTypes.ts` | ~290 |
| 146 | Shader module factory → `WebGPUGlobeSurfaceShaders.ts` | ~327 |
| 147 | Bind group + pipeline layout init → `WebGPUGlobeSurfaceLayouts.ts` | ~128 |
| 148 | Texture caching (imagery + water-mask + upload) → `WebGPUGlobeSurfaceTextures.ts` | ~161 |
| 149 | Wireframe path → `WebGPUGlobeSurfaceWireframe.ts` | ~362 |
| 150 | Pipeline construction (descriptor + select) → `WebGPUGlobeSurfacePipelines.ts` | ~449 |
| 151 | Tile buffer cache (`_getOrCreateTileBuffers`, eviction) → `WebGPUGlobeSurfaceTileBuffers.ts` | ~270 |
| 152 | Camera UB packing → `WebGPUGlobeSurfaceCameraUB.ts` | ~310 |
| 153 | Tile UB packing → `WebGPUGlobeSurfaceTileUB.ts` | ~500 |
| 154 | `createTileCommands` body (after deps move out) → may itself need a sub-decomposition once the above is done | ? |

After Batches 145–151, the class core (state + `initialize` + `createTileCommands` + small helpers) should be ~1500 LOC. After 152–153 it should be ~700 LOC and within the 1000-line CLAUDE.md guideline. Batch 154 may not be needed.

---

## Batch 145 — concrete deliverable

### What to extract

**Move only.** No behavior changes, no signature changes, no logic edits.

**Source range**: lines 23–334 (everything between imports and `export class WebGPUGlobeSurfaceRenderer`), specifically:

1. `GlobePipelineEntry` interface (lines 23–38)
2. CameraUniforms layout doc + `CAMERA_UNIFORM_FLOATS` + `CAMERA_UNIFORM_BYTES` (lines 39–84)
3. TileUniforms layout doc + 21 offset constants + `MAX_IMAGERY_LAYERS` (lines 86–154)
4. `resolveImageryLayerValue` free function (lines 156–200)
5. `multiplyMat4ColumnMajor` free function (lines 202–237)
6. `PipelineKey` const enum (lines 239–250)
7. `TileGPUResources` interface (lines 252–278)
8. `ImageryGPUTexture` interface (lines 280–286)
9. `TileDrawDescriptor` interface — **exported** (lines 288–320)
10. `DebugFragmentMode` const enum — **exported** (lines 322–334)

### Destination

New file: `packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTypes.ts`

Module docstring should:
- Identify this as the Batch 145 lift-off for the GlobeSurface decomposition.
- Note that `TileDrawDescriptor` and `DebugFragmentMode` are re-exported from the renderer for backwards compatibility (see step 4 below).
- Cross-reference the GlobeTerrain WGSL constants (the layout offsets must stay in lock-step with the WGSL struct).

### What stays in `WebGPUGlobeSurfaceRenderer.ts`

- The `WebGPUGlobeSurfaceRenderer` class and all its members.
- The 5 imports at the top of the file (they stay too — `m4Values`, `gpuData`, effects bind-group helpers, RTE assertion, bind-group layout helpers, shader cache, preprocessor, pipeline cache descriptor types).
- New imports from `WebGPUGlobeSurfaceTypes.js` covering everything we moved.

### Structural concerns

1. **Const enum re-exports.** TypeScript erases `const enum` values at compile time. Two const enums are involved:
   - `PipelineKey` is **internal** to this file — no consumers outside. Move freely.
   - `DebugFragmentMode` is **exported and consumed by Scene**. Grep first (see verification step 1) to confirm consumers; the re-export must use `export { DebugFragmentMode } from "./WebGPUGlobeSurfaceTypes.js"` so existing import sites continue working byte-for-byte. Same applies to the `TileDrawDescriptor` interface.

2. **`MAX_IMAGERY_LAYERS` may need export.** It's internal today (the value `16` is hard-coded against a WebGPU spec floor). If only `WebGPUGlobeSurfaceRenderer.ts` references it, leave it module-private inside the new file. Verify with grep step 2.

3. **Layout constants stay non-exported.** The 21 offset constants (`LAYERS_OFFSET`, …, `HSB_SHIFT_OFFSET`) and the `*_FLOATS` / `*_BYTES` totals are all internal. Keep them non-exported in the new file — `WebGPUGlobeSurfaceRenderer` accesses them via the import barrel.

4. **Free helpers go non-exported initially.** `resolveImageryLayerValue` and `multiplyMat4ColumnMajor` are only called from within `WebGPUGlobeSurfaceRenderer.ts` today. Keep them non-exported in the new module (they're imported as a single barrel) until a future batch needs them elsewhere.

### Steps

1. **Survey-grep** (run before any edits):
   ```
   grep -rn "DebugFragmentMode" packages/engine/Source --include="*.ts" --include="*.js"
   grep -rn "TileDrawDescriptor" packages/engine/Source --include="*.ts" --include="*.js"
   grep -rn "MAX_IMAGERY_LAYERS" packages/engine/Source --include="*.ts" --include="*.js"
   grep -rn "GlobePipelineEntry\|TileGPUResources\|ImageryGPUTexture\|PipelineKey" packages/engine/Source --include="*.ts" --include="*.js"
   ```
   Confirms what must stay export-visible and whether any external file would need to switch import paths.
2. Create `WebGPUGlobeSurfaceTypes.ts` with the moved declarations in the same order they appear today. Preserve every JSDoc block byte-for-byte.
3. In `WebGPUGlobeSurfaceRenderer.ts`:
   - Delete lines 23–334 (the entire moved block).
   - Add a single import barrel near the top:
     ```ts
     import {
       CAMERA_UNIFORM_FLOATS,
       CAMERA_UNIFORM_BYTES,
       TILE_UNIFORM_FLOATS,
       TILE_UNIFORM_BYTES,
       LAYER_FLOATS,
       LAYERS_OFFSET,
       DAY_NIGHT_ALPHA_OFFSET,
       USE_WEB_MERC_OFFSET,
       LAYER_COUNT_OFFSET,
       FOG_DENSITY_OFFSET,
       FOG_OFFSET_OFFSET,
       FOG_MIN_BRIGHTNESS_OFFSET,
       WATER_MASK_TS_OFFSET,
       CART_LIMIT_RECT_OFFSET,
       NIGHT_FADE_OUT_OFFSET,
       NIGHT_FADE_IN_OFFSET,
       VERT_EXAG_OFFSET,
       VERT_EXAG_REL_HEIGHT_OFFSET,
       FLAGS_OFFSET,
       OCEAN_PARAMS_OFFSET,
       NIGHT_OCEAN_PARAMS_OFFSET,
       TIME_OFFSET,
       FOG_VIS_DENSITY_OFFSET,
       SPLIT_POSITION_OFFSET,
       DEBUG_FIELDS_OFFSET,
       HSB_SHIFT_OFFSET,
       MAX_IMAGERY_LAYERS,
       PipelineKey,
       resolveImageryLayerValue,
       multiplyMat4ColumnMajor,
     } from "./WebGPUGlobeSurfaceTypes.js";
     import type {
       GlobePipelineEntry,
       TileGPUResources,
       ImageryGPUTexture,
     } from "./WebGPUGlobeSurfaceTypes.js";
     ```
   - Re-export the public interface + enum so existing import sites keep compiling without churn:
     ```ts
     export type { TileDrawDescriptor } from "./WebGPUGlobeSurfaceTypes.js";
     export { DebugFragmentMode } from "./WebGPUGlobeSurfaceTypes.js";
     ```
4. Run `npx tsc --noEmit` from the repo root. **Required**: zero new errors.
5. Run `npx gulp build` (or the user-preferred `npm run restart`) to confirm the bundler still resolves all paths.
6. Run the smoke triad (see verification, below).

### Verification

This is a pure-move batch, so the bar for "byte-equivalent" is high.

1. **Type-check parity**: `npx tsc --noEmit` should produce the same warning count as before the batch (run it on `main` first, save the count, compare).
2. **Compile parity**: `npx gulp build` succeeds; the resulting `Build/Cesium*/Cesium.js` byte size should be within ±200 bytes of the pre-batch build (esbuild const-folds `const enum` references, so the only diff should be from the moved JSDoc block landing in a different chunk).
3. **Smoke triad** (already established for prior batches):
   - `Apps/CesiumViewer/index.html?renderer=webgpu` — globe loads, imagery tiles render, no console errors during 5-second observe window.
   - `Apps/WebGPUTest/split-screen-comparison.html` — both panes render, swap-chain stays alive across camera move.
   - `Tools/visual-regression/capture-and-diff.mjs --scene globe-default` — pixel diff under whatever the established threshold is for this scene.
4. **Branch transparency**: Per CLAUDE.md, this batch lands on `main` directly (trunk-only). No safety branch needed for a pure move.

### Risks & mitigations

| Risk | Mitigation |
|---|---|
| Const-enum erasure changes when re-exported via `export { ... } from` | Verify `TileDrawDescriptor` consumers compile unchanged in step 4. If anyone uses `DebugFragmentMode.NONE` as a value (not a type), confirm esbuild still inlines the literal. |
| JSDoc layout-offset comments drift away from WGSL struct | Preserve all comments verbatim; do not reformat. The new module's docstring should explicitly call out that these constants must stay in lock-step with `GlobeTerrain.wgsl`. |
| Import barrel grows unwieldy on the renderer side | Acceptable — the renderer is being decomposed. Future batches will replace this barrel as their respective slices land. |
| Future batch needs to add a free helper that closes over class state | Out of scope for 145. Helpers that need `_device` or `_shaderModuleCache` stay on the class until those state fields move too. |

### Definition of done

- [ ] `WebGPUGlobeSurfaceRenderer.ts` is ~290 LOC smaller (3933 → ~3645).
- [ ] `WebGPUGlobeSurfaceTypes.ts` exists with all 10 moved declarations + the layout-offset constants.
- [ ] `npx tsc --noEmit` produces no new errors.
- [ ] `npx gulp build` succeeds.
- [ ] Smoke triad passes.
- [ ] Existing imports of `TileDrawDescriptor` / `DebugFragmentMode` from `WebGPUGlobeSurfaceRenderer.js` continue to resolve (re-exports verified by grep).
- [ ] Commit message: `Batch 145 — WebGPUGlobeSurfaceRenderer decomposition: extract module-level types & layout constants`
