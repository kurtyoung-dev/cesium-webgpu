# QUEUE 2026-07-03 — CAMPAIGN-NEXT (25 batches)

> **BANNER: This document is the input queue for the next 25-batch campaign.**
> Assembled 2026-07-03 from the Batch-507 canonical docs (`ROADMAP_AND_DEFERRED_WORK.md` §4/§5.2/§6, `ISSUES_AND_FIXED_BUGS.md` §3.3, `RESEARCH_AND_PENDING_TOPICS.md` R-8, `FORK_OVERVIEW.md` §8) + the Batches-482-506 campaign audit digest. **HEAD at assembly: `67fb4f9362` (Batch 507).**
> Every candidate premise was re-verified against live code before slotting (several legacy-tracker "gaps" are stale — the legacy trackers were NOT mined). Work the batches in execution order, respecting the dependency spine. One land per batch.

- **Prior campaign:** Batches 482-506 closed the `WEBGPU_PARITY_REPORT_2026-07-01` §6 list; its audit left 4 open issues + a residual tail.
- **This campaign:** the 4 audit issues first (voxel pick-compose absolutely first), then the below-surface-darkening/limb epic, then the residual tail by value, with quality/spec/demo breathers interleaved and one upstream-sync batch placed where it least disrupts (before the voxel ellipsoid arc, defusing `NEW-VOXELELLIPSOIDSHAPE-UPSTREAM-COLLISION`).
- **How to execute:** run each batch through the `parity-to-100` workflow engine (`.claude/workflows/`): implement (worktree-isolated) → build → acceptance probe → off-gate byte-identity → adversarial parity audit → land as `kurtyoung-dev`. The `parity-100-campaign` skill drives the sequential loop with premise-verification, honest-partial handling, dependency skipping, and clean-tree contracts.

---

## Exclusions (honest ledger — mined but NOT slotted)

| Candidate | Why excluded |
| --- | --- |
| `QPD-PP-F16-DEVICE-VERIFY` (on-device shader-f16 pixel verify of B478 f16 PP variants) | Device-blocked: needs a shader-f16-capable adapter; SwiftShader CI cannot run it and local-adapter f16 support is unconfirmed. No workaround exists today. Stays OPEN in ROADMAP §4.7 — run opportunistically when an f16-capable adapter is confirmed. |
| `NEW-METADATA-VS-STAGE-TABLE-READ` (property-TABLE metadata read in the vertex stage) | Premise unverified — the binding-44 BGL visibility + VS codegen path was not confirmed FS-only. Pre-verify (grep the BGL entry + VS codegen) before it earns a slot; if confirmed, insert as a mid-campaign swap-in. |
| `QPD-RENDERBUNDLE-AGING-DECOUPLE` | Speculative micro-opt; full LRU + age eviction already exists (`WebGPURenderBundleManager.ts` L36/L111/L206-208/L466/L476). ROADMAP §6.1 gates it on a measured `cpuPassCost` win — no measurement, no slot. |
| `QPD-RESOURCEMANAGER-KEY-EVICTION` | Low value: descriptor-keyed caches have a small key space; no observed unbounded growth. Act only if `getCacheStats()` shows growth on a long-running scene. |

**Dedupe:** `NEW-ENV-MOON-CRESCENT-PROBE` and `QPD-MOON-CRESCENT-PROBE` were the same item (two miners) — slotted once as B10. `NEW-GLOBE-BELOW-SURFACE-DARKENING` appears as a 3-increment epic (B2/B5/B6), not three duplicate items. `QPD-WEBGPU-ONLY-BUNDLE-STRIP` was too big for one batch — slotted as its own scoping-spike increment (B25) per the split-epics rule.

---

## Execution order (the 25 batches)

| # | ID | Tier | Priority | Effort | Deps | Title (short) |
| --- | --- | --- | --- | --- | --- | --- |
| B1 | `NEW-VOXEL-PICK-OCTREE-COMPOSE` | A | P1 | M | — | Voxel pick march: L1 octree traversal + child megatextureId + user-customShader alpha gate |
| B2 | `NEW-GLOBE-BELOWSURFACE-DECOMP` | A | P1 | M | — | Below-surface darkening epic 1/3: instrumented A/B term decomposition |
| B3 | `NEW-MODEL-SCENE2D-SHADING` | A | P2 | M | — | Model per-pixel lighting/IBL orientation under SceneMode.SCENE2D |
| B4 | `NEW-PP-LIBRARY-TONEMAP-ORDER` | A | P2 | M | — | Post-tonemap placement (or HDR compensation) for library/user PP stages |
| B5 | `NEW-GLOBE-BELOWSURFACE-FIX` | B | P1 | M | B2 | Darkening epic 2/3: root-cause fix for the dominant term |
| B6 | `NEW-GLOBE-DRAPE-LIMB-CLOSEOUT` | B | P2 | M | B5 | Darkening epic 3/3: ground-atmosphere drape limb-width + translucency symmetry close-out |
| B7 | `NEW-SPEC-VOXEL-CUSTOMSHADER-CODEGEN` | E | P2 | S | — | Jasmine spec for WebGPUVoxelCustomShaderCodegen pure functions |
| B8 | `NEW-VECTOR3DTILE-VCTR-E2E` | C | P2 | M | — | Vector3DTile e2e probe from existing .vctr fixtures (3D + 2D/CV skip-gate) |
| B9 | `NEW-BUFFERPOLYLINE-2D-EXTRUSION` | C | P2 | M | — | BufferPolyline width extrusion in SCENE2D (2D camera-axis convention) |
| B10 | `NEW-ENV-MOON-CRESCENT-PROBE` | E | P3 | S | — | Crescent-phase assertion added to probe-env-moon |
| B11 | `NEW-MODEL-PROJECT2D-BV-MORPH` | C | P2 | M | B3 | Model projectTo2D 1/2: 2D-clipped ortho bounding-volume morph + probe |
| B12 | `NEW-MODEL-SCENE2D-IDL-DUPLICATE` | C | P2 | M | B11 | Model projectTo2D 2/2: SCENE2D IDL-crossing duplicate command + per-primitive 2D BVs |
| B13 | `NEW-UPSTREAM-SYNC-1143` | E | P2 | M | — | Upstream sync to v1.143 (14 commits, incl. KHR_meshopt_compression) |
| B14 | `NEW-MODEL-METADATA-MAT3-MAT4` | C | P2 | M | — | MAT3/MAT4 property-attribute metadata transport (full 9/16 components) |
| B15 | `NEW-COLORGRADING-BASELINE-REFRESH` | E | P3 | S | — | Refresh stale probe-colorgrading-wired baseline PNG (post-B506) |
| B16 | `NEW-VOXEL-OCTREE-L2-ASSET-PROBE` | D | P2 | M | — | Voxel deep-octree 1/2: 3-level provider asset + L2 probe discriminators |
| B17 | `NEW-VOXEL-OCTREE-DEEP-TRAVERSAL` | D | P2 | M | B1, B16 | Voxel deep-octree 2/2: WGSL iterative traversal (levels >= 2) in color + pick march |
| B18 | `NEW-WEBGPU-MODEL-APPEARANCE-DEMO` | E | P3 | M | — | Sandcastle showcase: model color blend + silhouette + splitter (B483-485) |
| B19 | `NEW-VOXEL-STREAMING-UPLOAD` | D | P2 | M | B17 | Voxel streaming 1/2: demand-driven tile upload keyed to camera refinement |
| B20 | `NEW-VOXEL-ATLAS-LRU-EVICT` | D | P2 | M | B19 | Voxel streaming 2/2: megatexture/atlas LRU slot eviction |
| B21 | `NEW-WEBGPU-PP-LIBRARY-DEMO` | E | P3 | S | B4 | Sandcastle demo: 7 PP library builtins (SDR, parity-clean) |
| B22 | `NEW-VOXEL-ELLIPSOID-INTERSECT` | D | P2 | M | B13 | Voxel ellipsoid 1/2: ray-ellipsoid shell intersection replacing box AABB |
| B23 | `NEW-VOXEL-ELLIPSOID-SHAPEUV` | D | P2 | M | B22 | Voxel ellipsoid 2/2: radial/lon/lat shapeUv mapping + parity gate |
| B24 | `NEW-VOXEL-CYLINDER-SHAPEUV` | D | P3 | M | B23 | Cylinder voxel shape: intersection + shapeUv on the non-box infra |
| B25 | `NEW-WEBGPUONLY-BUNDLE-SPIKE` | F | P3 | M | — | Scoping spike: webgpu-only bundle strip of Scene's static WebGL Context.js import |

---

## Tier A — Audit fire-list (Batches 482-506 campaign audit: the 4 open issues)

| ID | Title | Priority | Effort | Deps | Files | Acceptance probe | Off-gate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `NEW-VOXEL-PICK-OCTREE-COMPOSE` | Pick march gains the color march's L1 child-octant traversal (`u.atlasInfo.y >= 1.0` branch: childCoord/childSlots0/1 → tileSlot/tileUv rescale + z-offset), derives `megatextureId` from the child tile instead of the hardcoded `packVoxelIntToVec2(0.0)`, and adds a `VOXEL_USER_CUSTOM_SHADER` pick branch so the winner gate matches the displayed surface (ungated `voxelMaterial.alpha` accumulation, not `s.a > densityThreshold`). Premise CONFIRMED by direct read: `fragmentPickVoxelMain` (L664-716) normalizes z into the ROOT slab (comment L686-689 acknowledges the gap); all needed data already lives in the shared uniform struct (L252-254). | P1 | M | — | `packages/engine/Source/Renderer/WebGPU/WebGPUVoxelRenderer.ts` (pick march ~664-716; color-march reference 416-486); `Tools/visual-regression/probe-voxel-cell-pick.mjs` | Extend `probe-voxel-cell-pick.mjs`: force refinement (`atlasInfo.y >= 1`) and assert per-cell pick bytes byte-equal WebGL for a level-1 leaf; add a user-customShader frame remapping alpha and assert the picked cell matches the visually-opaque sample on both backends | Color march untouched (rendered pixels byte-identical); non-refined (`atlasInfo.y < 1`) pick path byte-identical to current; default density gate unchanged when no user customShader |
| `NEW-GLOBE-BELOWSURFACE-DECOMP` | Below-surface darkening epic increment 1/3: a diag probe that A/B-toggles each candidate shading term (underground tint, translucency back-face alpha, ground-atmosphere drape limb-width, B506 GlobeFS/GlobeTerrain seam + glint deltas) and reports signed-dRGB attribution per term. Gap CONFIRMED, reproduced 3x at clean HEAD: probe-globe-underground 12.28% (red) / 22.85% (default) vs 8% limit, probe-globe-translucency 25.49% vs 10.5%, WebGPU uniformly darker dRGB −5.8..−8.0 (ROADMAP §4.1). Do NOT loosen existing probe limits. | P1 | M | — | `Tools/visual-regression/diag-globe-belowsurface-decomp.mjs` (new); reads `probe-globe-underground.mjs` (limit logic L213-238) + `probe-globe-translucency.mjs`; toggles in `packages/engine/Source/Shaders/WebGPU/GlobeFS.wgsl`, `GlobeTerrain.wgsl`, atmosphere-drape path | Diag probe runs both scenes with each term individually bypassed and emits a per-term signed-dRGB attribution table naming the dominant contributor for B5 | Instrumentation only: toggles behind CesiumDebug/pragma-stripped debug paths; production shader output byte-identical; existing probes' limits untouched |
| `NEW-MODEL-SCENE2D-SHADING` | Model per-pixel lighting/IBL orientation under SCENE2D: probe-model-scene-modes 2D interiorDiff 34.27 vs 3D 13.59 / CV 18.41 (both PASS), reproduced 3x; PNGs show olive/khaki WebGPU vs blue-gray WebGL. Geometry/coverage/centroid pass (B499 holds) — residual is the light-direction / IBL environment basis fed to the projected 2D frame. Short in-batch investigation confirms light-dir vs IBL-orientation as driver, then fix. | P2 | M | — | WebGPU model PBR light-direction + IBL orientation assembly under SceneMode.SCENE2D (`WebGPUModelRenderer` lighting-uniform pack); `Tools/visual-regression/probe-model-scene-modes.mjs` | `probe-model-scene-modes.mjs` 2D interiorDiff back in the 3D/CV band (~13-18), olive tint corrected | 3D + CV gates stay PASS (paths byte-identical); fix gated on `frameState.mode === SCENE2D` |
| `NEW-PP-LIBRARY-TONEMAP-ORDER` | Library/user PP stages run pre-tonemap on WebGPU (`WebGPUPostProcessPipeline.ts` user loop L1406, library loop L1425, tonemap pushed L1503) while WebGL runs added stages post-tonemap (`PostProcessStageCollection.js` ~745-758). HDR-only divergence today (SDR probe passed at 9.85%). Batch decides: move stages post-tonemap vs add the B479-style `hdrMode` compensation (as ColorGrading/FXAA, L1504-1517). Also fix the two wrong "matches WebGL's insertion point" comments (L1403/L1421) + the stale header stage-order docstring (~L39-42). | P2 | M | — | `packages/engine/Source/Renderer/WebGPU/WebGPUPostProcessPipeline.ts`; reference `PostProcessStageCollection.js` ~745-758; `Tools/visual-regression/probe-pp-library-builtins.mjs` | Extend `probe-pp-library-builtins.mjs` with an HDR-canvas frame (`useHDRCanvasOutput` engages headless on Edge, per PARITY-HDR-PP-MATH precedent): a library builtin matches WebGL post-tonemap output under HDR | Existing SDR off-gate stays byte-identical; SDR stage output unchanged (or provably WebGL-matching if the reorder path is chosen) |

---

## Tier B — Below-surface darkening / limb epic (increments 2-3; increment 1 is B2 above)

| ID | Title | Priority | Effort | Deps | Files | Acceptance probe | Off-gate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `NEW-GLOBE-BELOWSURFACE-FIX` | Epic increment 2/3: root-cause fix for the dominant darkening term identified by B2's attribution table. ROADMAP §4.1 folds this into the limb-ring/atmosphere-brightness epic; verify B506's seam/glint deltas apply symmetrically on the translucency/underground paths. If B2 shows multiple co-dominant terms, this batch fixes the largest and B6 absorbs the remainder. | P1 | M | B2 | `packages/engine/Source/Shaders/WebGPU/GlobeFS.wgsl`, `GlobeTerrain.wgsl`, ground-atmosphere drape path (exact target set by B2) | `probe-globe-underground.mjs` (red + default) dRGB residual pulled toward 0; measurable drop vs the 12.28%/22.85% baseline under un-loosened limits | Above-surface default view unchanged: `probe-colorgrading-wired` gates A-E + `probe-globe-polar-stretch` stay green |
| `NEW-GLOBE-DRAPE-LIMB-CLOSEOUT` | Epic increment 3/3: close `NEW-GROUND-ATMOSPHERE-DRAPE-LIMB-WIDTH` (limb +10 entry criterion, ROADMAP §4.1:177-179) + any residual terms from B2's table; bring `probe-globe-underground` AND `probe-globe-translucency` back under their existing dynamic limits and retire the epic in the closure ledger. | P2 | M | B5 | Same shader set as B5 + `Tools/visual-regression/probe-globe-underground.mjs`, `probe-globe-translucency.mjs` (assert-only, no limit loosening) | Both probes PASS under existing (un-loosened) limits: underground <= 8%/dynamic, translucency <= 10.5%; limb-width delta closed | Default-view regression sweep green (colorgrading-wired, polar-stretch, env probes); no probe limit edits |

---

## Tier C — Residual-tail parity (by value)

| ID | Title | Priority | Effort | Deps | Files | Acceptance probe | Off-gate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `NEW-VECTOR3DTILE-VCTR-E2E` | First real WebGL-vs-WebGPU pixel comparison for Vector3DTile classifiers. FORK_OVERVIEW §8's "no .vctr test data" blocker is STALE: 17 tileset.json + dozens of .vctr fixtures exist under `Specs/Data/Cesium3DTiles/Vector/`. Probe-only batch (unless it exposes a rendering gap — then surface per Principle 9 and split the fix out). | P2 | M | — | `Tools/visual-regression/probe-vector3dtile-vctr.mjs` (new); fixtures `Specs/Data/Cesium3DTiles/Vector/**`; reference `Shaders/WebGPU/Classification/Vector3DTilePolylines.wgsl` | New probe loads VectorTilePolygons + VectorTilePolylines tilesets both backends: non-empty classified footprint + IoU gate in 3D; 2D/CV frames document the silent skip-gate (ISSUES A.4) | Probe-only: zero runtime change; skip-gate behaviour documented, not altered |
| `NEW-BUFFERPOLYLINE-2D-EXTRUSION` | BufferPolyline segment-quad width extrusion adapted to the 2D camera-axis convention (extrusion from projected screen axes, not the 3D eye frame). Confirmed expected-absence per `probe-buffer-2dcv-parity` (ROADMAP §4.2, FORK_OVERVIEW §8); reprojection + settled-2D/CV depth already shipped (PARITY-BUFFER-2DCV, renderer L103-243, L377). | P2 | M | — | `packages/engine/Source/Renderer/WebGPU/WebGPUBufferPolylineRenderer.ts`; `Shaders/WebGPU/Collections/BufferPolyline*.wgsl` | Flip `probe-buffer-2dcv-parity.mjs`'s asserted polyline-2D absence into a presence gate: wide polyline visible + width matches WebGL in SCENE2D and CV | SCENE3D + CV paths byte-identical; new extrusion math gated on `frameState.mode === SCENE2D` |
| `NEW-MODEL-PROJECT2D-BV-MORPH` | Model projectTo2D increment 1/2: WGSL/renderer path so a `projectTo2D: true` model morphs its 3D bounding volume into a 2D-clipped ortho box (B499 deferred residual, ROADMAP §4.3 MORPH-MODEL-PROJECT2D). Includes the new probe harness. | P2 | M | B3 | `packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.js`; `Shaders/WebGPU/Model/ModelPBRComplete.wgsl` (2D/morph position path); `Tools/visual-regression/probe-model-project2d.mjs` (new, extends probe-model-scene-modes harness) | `probe-model-project2d.mjs`: projectTo2D model in SCENE2D/morph — bounding volume + rendered footprint match WebGL | `projectTo2D: false` (default) byte-identical; 3D path untouched |
| `NEW-MODEL-SCENE2D-IDL-DUPLICATE` | Model projectTo2D increment 2/2: SCENE2D IDL-crossing duplicate draw command + per-primitive 2D bounding volumes (the remaining B499 residuals named in ROADMAP §4.3). | P2 | M | B11 | `packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.js` (2D command duplication); Scene/Model model-matrix-2D computation | Extend `probe-model-project2d.mjs`: model straddling the IDL in SCENE2D renders on both sides matching WebGL; per-primitive 2D BVs cull correctly | Models not crossing the IDL emit no duplicate command — byte-identical; 3D/CV untouched |
| `NEW-MODEL-METADATA-MAT3-MAT4` | Full MAT3 (9) / MAT4 (16) component transport for glTF property attributes: today only the first 4 components round-trip through vertex slot 9's float32x4 and codegen zero-fills the rest (`WebGPUModelMetadata.js` L152-160 docstring). Add vec4 slots (or packed layout) + `constructFromTransport` codegen to reassemble the matrix. First verify no existing Specs metadata glTF carries MAT3/MAT4 attributes; author a minimal fixture in-batch if absent. | P2 | M | — | `packages/engine/Source/Renderer/WebGPU/WebGPUModelMetadata.js` (~150-260); MetadataWGSLPipelineStage codegen; `Shaders/WebGPU/Model/ModelPBRComplete.wgsl` metadata block; `WebGPUShaderDefines.ts` (add-only bit if gated) | New `probe-metadata-mat.mjs`: glTF with a MAT3/MAT4 EXT_structural_metadata property attribute — all components decode WebGPU==WebGL via custom-shader readout | Properties with <= 4 components keep the existing transport byte-identical; gated on `renderMetadata` (default parity path) |

---

## Tier D — Voxel deep-data arc (deep octree → streaming → non-box shapes)

Continues the B501 arc (data → shape → color → octree-L1 → pick) into depth-N, streaming, and non-box shapes. B22-B24 deliberately run AFTER the upstream sync (B13) because ROADMAP §5 flags `NEW-VOXELELLIPSOIDSHAPE-UPSTREAM-COLLISION` on `VoxelEllipsoidShape.js`.

| ID | Title | Priority | Effort | Deps | Files | Acceptance probe | Off-gate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `NEW-VOXEL-OCTREE-L2-ASSET-PROBE` | Deep-octree increment 1/2: author/source a voxel provider test asset advertising `availableLevels >= 3` (current box asset is 2-level) + extend `probe-voxel-octree.mjs` with L2 child discriminators (currently 8/8 L1 only). Probe/asset-only land; defines the acceptance gate B17 must hit. | P2 | M | — | Voxel test asset (new, under the existing probe fixture location); `Tools/visual-regression/probe-voxel-octree.mjs` | Extended probe runs at HEAD and documents the CURRENT depth-1 clamp (L2 discriminators expected-fail annotated), proving the asset + discriminators work | Asset + probe only: zero runtime change; existing 2-level probe gates stay green |
| `NEW-VOXEL-OCTREE-DEEP-TRAVERSAL` | Deep-octree increment 2/2: replace the single `u.atlasInfo.y >= 1.0` child-octant select (`WebGPUVoxelRenderer.ts` L416-433, fixed 9-slot atlas) with a real WGSL iterative octree walk (Octree.glsl-style descend with per-level slot indirection, RESEARCH R-8(1)) in BOTH the color march and the B1-composed pick march; lift `WebGPUVoxelDataUpload.ts` slotCount=9 (L382) to the level-2 tile budget. | P2 | M | B1, B16 | `packages/engine/Source/Renderer/WebGPU/WebGPUVoxelRenderer.ts` (color L416-455 + pick L664-716); `WebGPUVoxelDataUpload.ts` (L372-382) | B16's extended `probe-voxel-octree.mjs`: L2 discriminators pass 8/8, L1 gates still 8/8; pick probe still byte-equal at L1+L2 | Providers with `availableLevels < 3` traverse identically to the shipped depth-1 path (byte-identical); non-box shapes stay root-only as today |
| `NEW-VOXEL-STREAMING-UPLOAD` | Streaming increment 1/2: demand-driven child-tile upload keyed to camera refinement instead of the up-front `tryUploadChildVoxelTiles` all-at-once upload (RESEARCH R-8(2), mirroring upstream VoxelTraversal megatexture add). No eviction yet — atlas still bounded by budget. | P2 | M | B17 | `packages/engine/Source/Renderer/WebGPU/WebGPUVoxelDataUpload.ts` (atlas alloc + tryUploadChildVoxelTiles); `WebGPUVoxelRenderer.ts` (childSlots uniforms) | Extend `probe-voxel-megatexture.mjs`: camera far → only root uploaded; camera near → children stream in (`usingRealData` true, phase transitions asserted) | Scenes whose full tree fits the atlas end in the same uploaded state (pixel-identical steady state); depth-1 probes green |
| `NEW-VOXEL-ATLAS-LRU-EVICT` | Streaming increment 2/2: LRU eviction over atlas tile slots when refinement demand exceeds capacity (upstream VoxelTraversal megatexture remove analogue). | P2 | M | B19 | `packages/engine/Source/Renderer/WebGPU/WebGPUVoxelDataUpload.ts`; `WebGPUVoxelRenderer.ts` | Extend the B19 probe: drive refinement across more tiles than slots — eviction reuses slots, no overflow, correct cell values after re-upload of an evicted tile | Eviction only triggers when demand > capacity; under-capacity scenes byte-identical to B19 behaviour |
| `NEW-VOXEL-ELLIPSOID-INTERSECT` | Ellipsoid shape increment 1/2: replace the box `intersectAABB(u.minBounds, u.maxBounds)` (`WebGPUVoxelRenderer.ts` L294/325/369/578) with a ray-ellipsoid-shell intersection for ELLIPSOID-shape providers (WebGL `VoxelEllipsoidShape` reference math), + author/source an ellipsoid voxel provider asset + new probe. UV mapping stays box-affine this increment (documented residual → B23). | P2 | M | B13 | `packages/engine/Source/Renderer/WebGPU/WebGPUVoxelRenderer.ts` (intersect path); `Scene/VoxelEllipsoidShape.js` reference (read-only); `Tools/visual-regression/probe-voxel-ellipsoid.mjs` (new) | New probe: ellipsoid voxel footprint/silhouette IoU vs WebGL passes (shell geometry correct); interior sampling gate deferred to B23 | BOX providers keep `intersectAABB` byte-identical (branch on shape type); cylinder unchanged |
| `NEW-VOXEL-ELLIPSOID-SHAPEUV` | Ellipsoid shape increment 2/2: radial/longitude/latitude shapeUv mapping replacing the box-only `proxyToShapeUv` affine (renderer L215-227/396-402; `WebGPUVoxelDataUpload.ts` L344 isBox-only convention) so cell contents sample correctly; enable the data-upload sampling convention for ELLIPSOID. | P2 | M | B22 | `packages/engine/Source/Renderer/WebGPU/WebGPUVoxelRenderer.ts` (proxyToShapeUv); `WebGPUVoxelDataUpload.ts` (L344); `Tools/visual-regression/probe-voxel-ellipsoid.mjs` | B22 probe extended with per-cell sample gates: interior cell colors WebGPU==WebGL | BOX path byte-identical (shape-typed branch); B22's shell gate stays green |
| `NEW-VOXEL-CYLINDER-SHAPEUV` | Cylinder voxel shape on the non-box infrastructure from B22/B23: ray-cylinder intersection + radial/angular/height shapeUv (WebGL `VoxelCylinderShape` reference). Needs a cylinder provider asset (author in-batch). | P3 | M | B23 | `packages/engine/Source/Renderer/WebGPU/WebGPUVoxelRenderer.ts`; `WebGPUVoxelDataUpload.ts`; `Tools/visual-regression/probe-voxel-cylinder.mjs` (new) | New probe: cylinder voxel footprint IoU + per-cell samples WebGPU==WebGL | BOX + ELLIPSOID paths byte-identical; shape-typed branch only |

---

## Tier E — Quality / verification / demos / sync (breathers, interleaved)

| ID | Title | Priority | Effort | Deps | Files | Acceptance probe | Off-gate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `NEW-SPEC-VOXEL-CUSTOMSHADER-CODEGEN` | Jasmine spec for the B503 codegen pure functions: `generateVoxelUserShaderChunk` (L140), `hashStringFNV1a` (L86), `sanitizeWgslIdentifier` (L101), `voxelUserShaderHasUniforms` (L114). Zero existing spec coverage (grep confirmed); precedent `WebGPUColorGradingSpec.js`. No GPUDevice needed. | P2 | S | — | `packages/engine/Specs/Renderer/WebGPU/WebGPUVoxelCustomShaderCodegenSpec.js` (new); source `WebGPUVoxelCustomShaderCodegen.ts` | Spec: FNV-1a known vectors + stability, identifier sanitization, bridge-struct emission + stable/distinct keySalt, uniform-block detection — green under `gulp test --includeName` (Edge CHROME_BIN) | Test-only: zero runtime change |
| `NEW-ENV-MOON-CRESCENT-PROBE` | Crescent-phase assertion for probe-env-moon (currently full-disc only: litRatio + centerDist, L26/284). Verifies B505's phase-terminator shading cross-backend. If a shading gap surfaces, report honest-partial and split the fix (Principle 9). | P3 | S | — | `Tools/visual-regression/probe-env-moon.mjs`; (only if a gap surfaces) `WebGPUEnvironmentRenderer.js` moon shading | Clock set to a ~half/crescent phase: litRatio in the partial band + terminator position parity WebGL vs WebGPU; existing full-disc gate retained | Probe-only: zero runtime change |
| `NEW-UPSTREAM-SYNC-1143` | Supervised upstream sync: upstream/main `135d31863f` (2026-06-22), 14 commits ahead of merge-base `11f203fb02`, tag 1.143, incl. PR #13553 KHR_meshopt_compression. Follow the CLAUDE.md sync procedure (safety branch, merge, prefer-theirs + re-add WebGPU). Watch ROADMAP §5 fork-diverged files (`NEW-CAMERA-UPDATEVIEWMATRIX-REVERT`, `NEW-FORK-MODERNIZATION-REVERT`, `NEW-CONTEXT-PICKID-MERGE-PRESTAGE`, `NEW-VOXELELLIPSOIDSHAPE-UPSTREAM-COLLISION`). Placed BEFORE the ellipsoid voxel batches to defuse the VoxelEllipsoidShape collision. | P2 | M | — | Whole-tree merge; safety branch `pre-upstream-merge-2026-07` (delete after green, per branch-transparency rule) | `node Tools/variant-smoke-test.mjs` + collections-regression + globe/model probe sweep green; a KHR_meshopt model loads on both backends | Two-parent merge commit; full regression suite green before push (`--force-with-lease`) |
| `NEW-COLORGRADING-BASELINE-REFRESH` | Regenerate the stale `probe-colorgrading-wired` stored baseline PNG: gate F fails (diffBytes 149643) because B506 intentionally changed default-view pixels (glint restore + seam fix); functional gates A-E pass. ROADMAP §5.4 tail lists the stale baseline. First confirm it wasn't already regenerated by the doc-wave. | P3 | S | — | `Tools/visual-regression/` stored baseline PNG for `probe-colorgrading-wired.mjs` | Re-run with `--baseline` at clean HEAD, then a verification run: gates A-F all PASS | Baseline-file-only change: zero code diff |
| `NEW-WEBGPU-MODEL-APPEARANCE-DEMO` | WebGPU-branded Sandcastle showcase for the campaign model features: B483 splitter + B484 color blend modes + B485 silhouette. New-gallery format (`packages/sandcastle/gallery/<kebab>/` + `npm run build-sandcastle`); precedent `webgpu-structural-metadata-pick`. | P3 | M | — | `packages/sandcastle/gallery/webgpu-model-appearance/` (new: index.html, main.js, sandcastle.yaml, thumbnail) | Demo loads on `renderer:'webgpu'`; screenshot shows tinted model + silhouette rim + split view; visually compared against a WebGL capture | Gallery-only: zero engine change |
| `NEW-WEBGPU-PP-LIBRARY-DEMO` | WebGPU-branded Sandcastle demo cycling the 7 B486 library builtins (blackAndWhite, brightness, nightVision, silhouette, edgeDetection, lensFlare, depthView). Keep SDR to stay parity-clean until/unless B4 chose the reorder path. | P3 | S | B4 | `packages/sandcastle/gallery/webgpu-post-process-library/` (new); precedent `packages/sandcastle/gallery/post-processing/` | Demo loads on WebGPU, cycles each builtin with a screenshot each; all-off frame byte-identical to no-PP (audit-verified off-gate) | Gallery-only: zero engine change |

---

## Tier F — Scoping spike (last slot)

| ID | Title | Priority | Effort | Deps | Files | Acceptance probe | Off-gate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `NEW-WEBGPUONLY-BUNDLE-SPIKE` | Scoping spike ONLY (the full refactor is multi-campaign, per FORK_OVERVIEW §8: webgpu-only 6.4 MB vs dual 7.1 MB because Scene static-imports WebGL `Context.js`): trace the static-import graph from `Scene.js` into `Renderer/Context.js`, prototype ONE seam (factory/dynamic-import boundary) on a copy, measure the projected IIFE size win, and write the increment plan (follow-up batch list) into ROADMAP §6. No production code lands. | P3 | M | — | Analysis of `packages/engine/Source/Scene/Scene.js` import graph; `scripts/bundleVariantPlugin.js`; output: ROADMAP §6 increment plan + measured size projection | Spike report committed to ROADMAP with (a) import-graph inventory, (b) measured prototype size delta, (c) batch-sized increment list for the next campaign | Doc + measurement only: zero shipped code change; prototype stays in a scratch worktree |

---

## Dependency spine

Five short chains; everything else is independent. The voxel arc is the longest and sets the campaign tail.

```text
Darkening epic:   B2 DECOMP ──► B5 FIX ──► B6 DRAPE-LIMB-CLOSEOUT
Model 2D:         B3 SCENE2D-SHADING ──► B11 PROJECT2D-BV-MORPH ──► B12 IDL-DUPLICATE
PP order:         B4 TONEMAP-ORDER ──► B21 PP-LIBRARY-DEMO (SDR)
Voxel octree:     B1 PICK-COMPOSE ─┐
                  B16 L2-ASSET ────┴─► B17 DEEP-TRAVERSAL ──► B19 STREAM-UPLOAD ──► B20 LRU-EVICT
Voxel shapes:     B13 UPSTREAM-SYNC-1143 ──► B22 ELLIPSOID-INTERSECT ──► B23 ELLIPSOID-SHAPEUV ──► B24 CYLINDER
```

Scheduling notes:

- **B1 is absolutely first** (audit P1; also a root of the voxel chain).
- **B13 (upstream sync) sits mid-campaign deliberately**: after the audit fixes + darkening epic land (so the merge doesn't churn under an open shader investigation) and before B22 touches `VoxelEllipsoidShape.js` (flagged upstream-collision file).
- Breathers (B7, B10, B15, B18, B21) are swap-in slack: if a fix batch overruns, pull a breather forward without disturbing the spines.
- If `NEW-METADATA-VS-STAGE-TABLE-READ`'s premise verifies mid-campaign (see exclusions), it may swap into a breather slot as a probe-first item.

---

## How to execute

Run this queue through the **`parity-100-campaign` workflow engine** (see `.claude/workflows/` and the `parity-to-100` per-task skill), exactly as the 482-506 campaign ran:

1. **Premise re-verify** at batch start (docs drift — several prior "gaps" were stale; every row above was code-verified at `67fb4f9362`, but re-check anything landed since).
2. **Implement worktree-isolated** → `npx gulp build` → acceptance probe (row above) → **off-gate byte-identity** (row above) → adversarial parity audit → land on main as `kurtyoung-dev`, one land per batch, Batch-numbered commit message.
3. **Honest partials**: if a batch can only partially land (e.g., B10 exposes a moon-shading gap), land the verified part, surface the residual per Principle 9, and append it to ROADMAP §4 — do not silently absorb scope.
4. **Ledger discipline**: on each land, update `ROADMAP_AND_DEFERRED_WORK.md` §5.2 (closure ledger) and this file's row (strike-through + commit hash), keeping the canonical docs load-bearing.
