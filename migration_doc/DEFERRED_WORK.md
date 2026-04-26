# Deferred Work Inventory - CesiumJS WebGPU Migration

**Last Updated:** 2026-04-25 (Batch 64 doc rollup)

This is the canonical list of named C-R follow-ups deferred during the principal-engineer review remediation (Batches 1-64). Each entry has a stable identifier (`C-R<n>-<NAME>`) that survives renumbering when slots are filled. Grouped by parent C-R finding from `PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md`.

Each entry: **What** / **Why deferred** / **Prerequisites** / **Estimated effort** (1 session ~ 1-3 hours) / **Impact** / **Trace**.

This inventory is add-only; ship items mark `(SHIPPED in Batch N)` next to the heading rather than removing the row.

---

## C-R1 - command.renderState adoption tail

**Parent finding (PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md:30):** `RenderStateToPipelineVariant.ts` foundation + 7 consumer renderers landed in Batches 30/35-37/39. Four named gaps remain.

### C-R1-CLASSIFICATION

**What:** Classification primitives (ClassificationPrimitive, GroundPolylinePrimitive) need their multi-pass renderState (stencil-depth pass, color pass, pick pass) routed through pipeline variants. Each pass uses distinct stencil/colorMask/depthFunc so WebGPU has to materialize three pipelines and dispatch in order.

**Why deferred:** WebGPU classification dispatch is a single-pipeline path; splitting into the WebGL-style 3-pass walk requires per-pass pipeline variant work plus renderer-level ordering change. Touches `WebGPUGroundPrimitiveRenderer.js` plus a new `WebGPUClassificationPrimitiveRenderer` that doesn't exist yet.

**Prerequisites:** None - foundation in place since Batch 30. `selectCommandVariant` (Batch 29) is the dispatch hook.

**Estimated effort:** 1 dedicated session.

**Impact:** 3D Tiles classification on WebGPU may bleed through tile boundaries when the stencil-depth pass doesn't run. Single-pass mode currently approximates the visible surface only.

**Trace:** PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md:30.

### C-R1-COLLECTIONS-PER-ENCODER

**What:** Five collection renderers (Billboard, Cloud, PointPrimitive, Polyline, Label) don't call `applyPerEncoderState(passEncoder, renderState)` before draw - they rely on default-baked state. Adding the per-encoder call enables custom `setStencilReference` / `setBlendConstant` / `setScissorRect` overrides without rebuilding the pipeline.

**Why deferred:** Collection draws are batched per-collection rather than per-command, so renderState has to be hoisted from a representative member or the collection's owner.

**Prerequisites:** None.

**Estimated effort:** 1 session.

**Impact:** Custom blend constants / stencil refs set on individual entities in a collection are silently ignored. Default-baked state is correct for ~99% of uses.

**Trace:** Batch 39 scope cut in REVIEW_FIX_PROGRESS.md; no explicit marker yet, adding via this entry.

### C-R1-GLOBE-RENDERSTATE

**What:** `WebGPUGlobeSurfaceRenderer.ts` builds pipeline variants from local hard-coded state instead of consuming upstream `command.renderState`. The provider sets per-tile depthMask / cullFace based on tile elevation/back-facing geometry; the WebGPU path overrides with a fixed front-face cull.

**Why deferred:** Globe surface renderer has its own custom pipeline-variant builder predating `RenderStateToPipelineVariant.ts`; routing the upstream renderState through requires reconciling two distinct variant key shapes.

**Prerequisites:** Bundles naturally with C-R7-RENDERER-MIGRATION (route GlobeSurface through central pipeline cache).

**Estimated effort:** 1-2 sessions.

**Impact:** Underground / inverted tiles may render with wrong cull mode at the rim of the globe (e.g., transitioning across a steep cliff). Minor artifacting.

**Trace:** PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md:30.

### C-R1-PRIMITIVE-DERIVED

**What:** `WebGPUPrimitiveCommands.js` doesn't yet build pipeline variants for the derived `colorCommand` / `depthOnlyCommand` / `pickCommand` / `pickDepthCommand` paths - only the primary color command's renderState propagates.

**Why deferred:** Each derived command needs its own variant-key contribution. The dispatcher already routes; the variant-build path needs per-derived-command branches.

**Prerequisites:** None.

**Estimated effort:** 1 session.

**Impact:** Pick passes and depth-only passes for primitives may not honor custom blend / stencil settings. Color pass works correctly.

**Trace:** PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md:30.

### C-R1-TILE-BATCH

**What:** `Cesium3DTileBatchTable.js` per-feature renderState (depthMask flip for `_depthOnlyCommand` derivation, custom color blend for translucent tiles) is not consumed by the WebGPU model command emission path.

**Why deferred:** Routing through the renderState pipe requires teaching `WebGPUModelRenderer.js` to inspect batch-table per-feature state, which has its own representation that's not yet typed.

**Prerequisites:** Pairs with C-R9-MODEL-FEATURE-PICK - both touch batch-table integration.

**Estimated effort:** 1-2 sessions.

**Impact:** Per-feature transparency in 3D Tiles renders without the alpha-driven depthMask flip on WebGPU; visible as z-fighting on overlapping translucent features.

**Trace:** PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md:30.

---

## C-R4 - glTF KHR extensions

### C-R4-GLTF-KHR

**What:** Six glTF KHR extensions silently dropped on the WebGPU model path:

- **KHR_texture_transform** - affine UV transform per texture. ~10 sampling sites in `ModelPBRComplete.wgsl`.
- **KHR_materials_clearcoat** - second specular lobe. Clearcoat normal map + roughness uniform + BRDF branch.
- **KHR_materials_anisotropy** - anisotropic GGX roughness. Direction texture + tangent-space derivation.
- **KHR_materials_specular** - specular factor + color tint. 2 textures + 2 uniforms.
- **KHR_materials_iridescence** - thin-film iridescence. Thickness/IOR uniforms + texture + Fresnel modulation.
- **KHR_materials_sheen** - fabric/cloth velvet term. Sheen color/roughness + Charlie distribution lobe.
- **KHR_materials_volume** - transmission/volumetric attenuation. Thickness texture + IOR + attenuation distance + transmission lobe.

**Why deferred:** Major shader-family work. Each extension is a distinct BRDF branch with its own texture binding + uniform plumbing. Six sibling `Model*Stage.wgsl` files sit on disk imported by nothing.

**Prerequisites:** WGSL include strategy decision - either wire `//>>ifdef` preprocessor multi-file include (WebGL `*Stage.glsl` pattern), or fold all extensions inline behind define gates. Inline balloons file past the 1000-line CLAUDE.md threshold.

**Estimated effort:** 1 session per extension = 6, plus 1 for include-pipeline decision and 1 for orchestration. ~8 sessions / multi-week workstream.

**Impact:** Production glTF models lose visual fidelity proportional to KHR extensions shipped. KHR_texture_transform is in nearly every modern glTF asset (atlased tilesets) - highest-impact single gap.

**Trace:** PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md:101-102; OVERSIGHT_AUDIT_2026_04_25.md s2.

---

## C-R7 - Central pipeline cache adoption tail

**Parent finding:** Pipeline cache (`WebGPURenderPipelineCache`) instantiated + key-correct + device-loss-invalidated in Batches 33-34, audited Batch 52. First-cut consumer migration Batch 56, second cut Batch 62.

### C-R7-RENDERER-MIGRATION-REMAINING

**What:** Nine feature renderers still build pipelines via local Map caches: `WebGPUBillboardRenderer`, `WebGPULabelRenderer`, `WebGPUEnvironmentRenderer`, `WebGPUCloudRenderer`, `WebGPUVolumetricFogRenderer`, `WebGPUWeatherRenderer`, `WebGPUVoxelRenderer`, `WebGPUPointCloudRenderer`, `WebGPUGlobeSurfaceRenderer`. Plus `WebGPUModelRenderer` (special-case, blocked on shader-module dedup) and `WebGPUAutoExposure` (compute pipeline, out of scope until a `WebGPUComputePipelineCache` exists).

**Why deferred:** Mechanical migration; each needs descriptor-build + dispatch reorganized to match Batch 56/62 pattern.

**Prerequisites:** None - 6 renderers migrated total establish the pattern.

**Estimated effort:** 2-3 sessions (3-4 renderers per session).

**Impact:** Identical pipelines may be created multiple times across renderer instances. Memory + first-frame setup cost; no per-frame correctness or steady-state perf impact since each renderer's local cache hits.

**Trace:** REVIEW_FIX_PROGRESS.md (Batches 56/62 lists); PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md:185.

### C-R7-SHADER-MODULE-DEDUP

**What:** Cross-renderer `GPUShaderModule` sharing. Wiring `WebGPUShaderModuleCache` into all renderers (5 of ~17 use it today) lets identical sources actually dedupe.

**Why deferred:** Without dedup, routing `WebGPUModelRenderer` through `webgpuPipelineCache` (Batch 56's deferred case) wouldn't actually share - two models with identical material settings still produce distinct shader modules, distinct pipeline cache keys.

**Prerequisites:** None - `WebGPUShaderModuleCache.ts` exists since Batch 22.

**Estimated effort:** 1-2 sessions for adoption pass + 1 for ModelRenderer migration.

**Impact:** Memory pressure on shader-heavy scenes (3D Tilesets with many distinct glTF assets sharing material settings).

**Trace:** REVIEW_FIX_PROGRESS.md:2399 (Batch 52 audit); OVERSIGHT_AUDIT_2026_04_25.md s3.

---

## C-R8 - Translucent classification follow-ups

**Parent finding:** Six C-R8 sub-items shipped Batches 35-51 (globeDepth, VOXELS-before-OPAQUE, 2D frustum jitter, InvertClassification, Edge FBO+inline, Translucent tile classification first-cut). Three named follow-ups remain on translucent classification leg; MSAA gate closed Batch 61.

### C-R8-TRANSLUCENT-DEPTH-ONLY

**What:** Translucent depth capture is over-broad - copies ALL translucent geometry's depth, not just `depthForTranslucentClassification`-flagged 3D-tile content. WebGL's selective behavior derives a `_depthOnlyCommand` per command per `Cesium3DTile.js:1084`.

**Why deferred:** WebGPU model commands lack `_depthOnlyCommand` derivation; needs `WebGPUModelRenderer.js` + Batch 29 `selectCommandVariant` dispatcher to respect new derived slot.

**Prerequisites:** None.

**Estimated effort:** 1 session.

**Impact:** Visually correct for typical scenes (no other translucent contributors). Subtle bugs for translucent-label-heavy scenes - labels' depth contributes to classification mask when it shouldn't.

**Trace:** REVIEW_FIX_PROGRESS.md:2130.

### C-R8-TRANSLUCENT-MULTI-FRUSTUM

**What:** Multi-frustum accumulation not wired. `executePackDepth` runs once per frame, capturing only last-rendered frustum's depth.

**Why deferred:** Architectural - needs per-frustum pack-depth + multi-layer texture, or per-frustum array + slice indexing at composite.

**Prerequisites:** None.

**Estimated effort:** 2 sessions.

**Impact:** Default 4-frustum scenes misclassify primitives spanning frustum boundaries. Hits whenever camera height crosses a logarithmic split.

**Trace:** REVIEW_FIX_PROGRESS.md:2132.

### C-R8-TRANSLUCENT-CLASSIFICATION-DISPATCH

**What:** Classification primitive shaders sample `globeDepthTexture`; need option to sample `packedTranslucentDepthView` (Batch 47 pack pipeline) when translucent depth available - that's how WebGL gets translucent-on-translucent classification right.

**Why deferred:** Single-texture binding - dynamic-swap requires either two pipeline variants (one per source) or runtime-switchable bind group.

**Prerequisites:** Pairs with C-R1-CLASSIFICATION.

**Estimated effort:** 1 session.

**Impact:** Translucent-on-translucent classification doesn't render. Translucent-on-opaque (common case via globe depth) works.

**Trace:** REVIEW_FIX_PROGRESS.md:2133.

---

## C-R9 - Pick command tail

**Parent finding:** Five WebGPU renderers were missing pick paths. All five shipped at primitive granularity through Batches 30/31/53/54. Three named follow-ups remain.

### C-R9-MODEL-FEATURE-PICK

**What:** Per-feature pick on glTF Models. `scene.pick()` over a Model returns the Model object; per-feature pick (one target per `EXT_mesh_features` / `EXT_structural_metadata` feature) needs the pick FBO to read per-fragment featureId.

**Why deferred:** Requires KHR feature-ID integration on pick FBO side. Color path reads featureId (Batch 48 edge-feature-id work); pick path doesn't emit it yet.

**Prerequisites:** Pairs with C-R1-TILE-BATCH (both touch batch-table integration).

**Estimated effort:** 2-3 sessions.

**Impact:** 3D Tiles per-feature interactivity (clicking single building in city tileset) doesn't work on WebGPU. Workaround: client decode pick result against feature table manually.

**Trace:** PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md:220 (Batch 54 "Still open").

### C-R9-MODEL-PICK-TRANSLUCENT

**What:** Translucent-with-OIT pick - depth-correct alpha-blended picking through OIT framebuffer. Currently pick forces depth-write ON for ALL alpha modes (front-most fragment wins).

**Why deferred:** OIT writes accum + revealage textures, not pickable color. Routing pick through OIT requires parallel pick-OIT pipeline accumulating pickIds with same weights, resolving at composite.

**Prerequisites:** None - OIT path itself is stable.

**Estimated effort:** 2 sessions.

**Impact:** Picking through stacked translucent surfaces (glass building facades) returns whichever closest, not what user visually identifies. Acceptable first-cut.

**Trace:** PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md:220 (Batch 54 "Translucent-with-OIT pick").

### C-R9-VOXEL-CELL-PICK

**What:** Per-cell granularity for voxel pick. `scene.pick()` returns the primitive; per-cell pick needs cell coords (3 x u32) packed into pickColor or out-of-band.

**Why deferred:** Voxel cell coords don't fit in 4-byte pickColor - needs separate buffer/texture + different resolve path.

**Prerequisites:** None.

**Estimated effort:** 1-2 sessions.

**Impact:** Voxel hover/click selection of individual cells doesn't work. Coarse primitive-level pick works.

**Trace:** PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md:222 (Batch 53 "Per-cell / per-tile pick is out of scope").

---

## C-R10 - Point-light shadow tail

**Parent finding:** Cube-shadow cast (Batch 34) + Model FS receive (Batch 57) + soft-shadow PCF (Batch 63). Two named follow-ups remain.

### C-R10-GLOBE-POINT-LIGHT

**What:** Globe terrain receive shader extension for cube depth. `GlobeTerrain.wgsl` keeps using 2D shadow path; point-light shadows on terrain are uncommon.

**Why deferred:** Adding point-light receive to terrain requires copying `samplePointShadow` helper + new BGL binding into `GlobeTerrain.wgsl` AND updating effects bind-group consumer (currently same UBO layout as Model FS, so cube binding is a BGL grow that globe also has to consume). Architectural cost, low payoff.

**Prerequisites:** None - Batch 57's BGL is already set up to grow.

**Estimated effort:** 1 session if requested.

**Impact:** Point lights don't cast shadows on terrain on WebGPU. Models, primitives stay shadowed correctly.

**Trace:** REVIEW_FIX_PROGRESS.md (Batch 57 "Scope cuts"); PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md:247.

### C-R10-CAST-LINEAR-DEPTH

**What:** Alternative cast pipeline writing linear depth (`distance / lightRadius`) via `@builtin(frag_depth)` instead of perspective-Z attachment. Would let receive use simpler `axisDist / farPlane` reference.

**Why deferred:** Perspective-Z path correctly round-trips against existing cast output. Switching to linear depth requires receive AND cast changing in lockstep - coordinated swap, not strict improvement. Tracking only because future profiling could shift the calculus.

**Prerequisites:** None.

**Estimated effort:** 1 session.

**Impact:** None today - current perspective-Z math is correct and cheap (two divides + one cube sample per fragment). Pure micro-optimization.

**Trace:** REVIEW_FIX_PROGRESS.md (Batch 57 "Scope cuts").

---

## C-R12 - Per-object cache walk

### C-R12-PER-OBJECT-CACHES

**What:** Extend `onDeviceInvalidated` event subscriber walk to per-Model / per-Collection / per-Renderer object caches. Subsystem-level caches (Bloom/AO/DoF/GodRays/AutoExposure/scene FB) are wired; per-object caches (`model._webgpuCache`, `clippingPlanes._webgpuCache`) are not.

**Why deferred:** Most per-object caches DO get rebuilt next frame because owning feature renderer's destroy + recreate runs anyway. Belt-and-suspenders correctness.

**Prerequisites:** None.

**Estimated effort:** 1 session.

**Impact:** None observed - device-loss recovery currently works for the test scenes that have hit it. Risk: a future cache that doesn't get reaped on next-frame churn would silently use stale GPU handles.

**Trace:** PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md:283 ("tracked as **FOLLOW-UP C-R12-PER-OBJECT-CACHES** if it becomes necessary").

---

## NEW-4 — Genuine WebGPU bugs surfaced by TRULY FINAL Sandcastle pass (Batch 66)

The first end-to-end Sandcastle WebGPU verification (`SANDCASTLE_BATCH_66_TRULY_FINAL_REPORT.md`) flushed multiple second-layer bugs that only appeared once `Viewer.createAsync` actually initialized the WebGPU backend on the demos. NEW-3-A/B/C closed inline; NEW-4-B/C/F closed inline; NEW-4-A/D/E genuinely multi-session and tracked here.

### ~~NEW-4-A — EdgeVisibilityPipelineStage uses WebGL-only `Buffer.getBufferData`~~ FIXED 2026-04-25 (Batch 67)
**Resolution:** Took architecture option (b) — eager retention at upload — over (a) async pipeline-stage refactor. (a) was multi-session architectural work touching every pipeline stage's contract; (b) is two narrow edits and reuses the existing `loadTypedArray` plumbing. `GltfLoader.loadVertexAttribute` now sets `outputTypedArray = true` on every vertex attribute when `frameState.context.isWebGPU` AND the primitive carries `EXT_mesh_primitive_edge_visibility`, so `EdgeVisibilityPipelineStage`'s existing `defined(attribute.typedArray) ? attribute.typedArray : ModelReader.readAttributeAsTypedArray(...)` branch always takes the fast path on WebGPU and never invokes the WebGL-only sync readback. `EdgeVisibilityPipelineStage.process` also gained a defensive guard that bails cleanly with a `console.error` if the typed array is missing on WebGPU (safety net for any future loader path that skips retention). WebGL keeps prior behaviour — typed arrays still freed after upload, falling back through `Buffer.getBufferData` as before. Mirrors the pre-existing `loadIndices` retention pattern that already special-cased `hasEdgeVisibility` for the index typed array.
**Files touched:** [packages/engine/Source/Scene/GltfLoader.js](../packages/engine/Source/Scene/GltfLoader.js) (loadVertexAttribute retention), [packages/engine/Source/Scene/Model/EdgeVisibilityPipelineStage.js](../packages/engine/Source/Scene/Model/EdgeVisibilityPipelineStage.js) (defensive WebGPU guard).
**Sandcastle verification:** `WebGPU Edge Visibility.html` and `WebGPU Edge Feature ID.html` both PASS in `node Tools/visual-regression/sandcastle-batch-66-final-runner.mjs` (previously hard-FAIL with `DeveloperError: A WebGL 2 context is required.` from `Buffer.getBufferData` thrown in `buildTriangleAdjacency`).
**Closing batch:** Batch 67.

### ~~NEW-4-D — Texture3D constructor has WebGL-only guard~~ FIXED 2026-04-25 (Batch 67)
**Resolution:** `Texture3D` constructor now short-circuits to `new WebGPUTexture3D(options)` when `context.isWebGPU` is true, BEFORE the WebGL2 `webgl2` guard runs. JS constructor return-value semantics replace `this` with the returned WebGPU instance, so every caller (`Megatexture.js`, future volumetric features) gets the right backend with zero call-site changes. The webgl-only build variant remains correct because the `WebGPUTexture3D` import is redirected to `emptyModule.js` (Proxy that throws on instantiation) and the dispatch is gated on `isWebGPU`, which is false in those builds. NEW-4-E is now reachable — Voxel demos reach `WebGPUVoxelRenderer.update()` and the WGSL pipeline-build step.
**Files touched:** [packages/engine/Source/Renderer/Texture3D.js](../packages/engine/Source/Renderer/Texture3D.js) (added import + 12-line WebGPU dispatch in constructor + factory comment).
**Closing batch:** Batch 67. See [WEBGPU_DEBUGGING_LOG.md § Session 39](WEBGPU_DEBUGGING_LOG.md) for full root-cause + fix narrative.

### NEW-4-E — Voxel color pipeline WGSL parse error at line 113
**What:** `WebGPUVoxelRenderer.ts` `fragmentMain` WGSL fails naga parsing with "missing return at line 113". The line in question is `let uvw = (p - u.minBounds) / (u.maxBounds - u.minBounds);` — innocuous on its face. May be a downstream control-flow analysis issue (the loop's `break`/`continue` interplay or the post-loop `discard` path).
**Why deferred:** Reproduction requires the WebGPU pipeline-creation path to actually run. NEW-4-D now FIXED (Batch 67), so the path is reachable. Live capture pending.
**Prerequisites:** None remaining (NEW-4-D closed).
**Estimated effort:** 30 min once live error captured.
**Impact:** Voxel rendering pipeline fails compile. Blocks Voxel demos.
**Predicted root cause (Batch 67 worktree analysis, not live-captured):** WGSL `discard` does NOT terminate function control flow (unlike GLSL — discard is a fragment-state mutation, the function continues until it falls off the end or hits a `return`). The two `if (...) { discard; }` early-outs in `fragmentMain` (line 91 `if (tr.x > tr.y)` and line 110 `if (accumA < 0.01)`) leave naga unable to prove the function returns on every path. The closing backtick at the end of the WGSL template literal is line 113 of the TS file, matching the reported error site.
**Predicted fix candidates:** (a) Pair each `discard;` with `return vec4<f32>(0.0);` so naga sees an explicit terminator (preserves existing semantics most faithfully). (b) Convert the discards to `return vec4<f32>(0.0);` outright and rely on the swapchain blend / alpha to drop the fragment.
**Trace:** [SANDCASTLE_BATCH_66_TRULY_FINAL_REPORT.md](SANDCASTLE_BATCH_66_TRULY_FINAL_REPORT.md) NEW-4-E finding; predicted analysis from Batch 67 NEW-4-D worktree.

---

## ~~BUG-F2 — ShaderBuilder crash on BENTLEY edge asset~~ FIXED (Batch 66)

### ~~F2-SHADERBUILDER-EMPTY-FUNCTION~~ FIXED 2026-04-25 (Batch 66)
**Resolution:** Root cause was NOT property-table mismatch as initially diagnosed. The March 2026 ES6 modernization commit (`febe065f36`) added a debug-only `throw new DeveloperError("The shader function must have at least one line.")` to `ShaderFunction.generateGlslLines()`. `MetadataPipelineStage.declareStructsAndFunctions` legitimately registers `initializeMetadata` / `setMetadataVaryings` unconditionally (so `MetadataStageVS/FS` chunks can call them as no-ops when the model has no metadata), and most glTF assets — Milk Truck, EdgeVisibility test assets, BENTLEY — fall into the empty-body path. **Fix:** removed the empty-body throw in [ShaderFunction.js](packages/engine/Source/Renderer/ShaderFunction.js). GLSL allows empty function bodies (`void foo() {}` is valid); the pre-modernization behaviour silently emitted them. Diagnosis was complicated because the prior verification's "BENTLEY-specific" framing was wrong — the simpler `EdgeVisibilityMaterial.glb` (zero metadata) hit the same path on re-verification, which is what surfaced the actual root cause.
**Closing batch:** Batch 66 ShaderFunction.js empty-body fix.

---

## Cross-cutting priority guide

1. **Highest-impact correctness wins first.** C-R5-IMAGERY-16 (parent finding C-R5, not in this inventory) is the single biggest visual-correctness gap remaining. After that, C-R8-TRANSLUCENT-MULTI-FRUSTUM produces visible artifacting in nearly every multi-frustum scene.
2. **Architectural enablers second.** C-R7-RENDERER-MIGRATION-REMAINING + C-R7-SHADER-MODULE-DEDUP together unlock perf wins across the renderer fleet - mechanical pass x 9.
3. **C-R4-GLTF-KHR is its own multi-week workstream.** Don't pair with anything; consume sessions one extension at a time. KHR_texture_transform is the highest-impact single extension.
4. **C-R9-* pick follow-ups are nice-to-have.** Per-feature pick / per-cell pick / OIT pick all matter for specific app types; not on critical path for migration parity.
5. **C-R12-PER-OBJECT-CACHES** is a "leave it until something breaks" item.

---

## Appendix - Items NOT in this inventory

- **Bug-tracker items** are tracked in `WEBGPU_DEBUGGING_LOG.md`. Numbered `BUG-NN.M`.
- **High-severity findings** (`H-R*`, `H-P*`, `DP-H*`) are in `WEBGPU_MIGRATION_BACKLOG.md` rather than here. This inventory is C-R-prefixed only.
- **Open parent findings** without named follow-ups (`C-R4`, `C-R5`) stay in their parent review docs as deferral entries themselves.
