# Deferred Work Inventory - CesiumJS WebGPU Migration

**Last Updated:** 2026-04-28 (Batch 79 — C-R8-TRANSLUCENT-DEPTH-ONLY closed; classification architecture pivot)

This is the canonical list of named C-R follow-ups deferred during the principal-engineer review remediation (Batches 1-64). Each entry has a stable identifier (`C-R<n>-<NAME>`) that survives renumbering when slots are filled. Grouped by parent C-R finding from `PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md`.

Each entry: **What** / **Why deferred** / **Prerequisites** / **Estimated effort** (1 session ~ 1-3 hours) / **Impact** / **Trace**.

This inventory is add-only; ship items mark `(SHIPPED in Batch N)` next to the heading rather than removing the row.

---

## ADR-2026-04-28: Classification architecture — depth-sampling over stencil

**Decision:** Migrate `WebGPUGroundPrimitiveRenderer` from its current 2-pass stencil approach to WebGL's depth-texture sampling architecture. Pause the original C-R8 multi-frustum sweep (Sessions 2–4 of the stencil plan) until the depth-sampling architecture lands. After the migration, the multi-frustum work folds in for free as "swap the depth-source view per frustum" rather than "redirect a render pass into a scratch FBO and accumulate stencil bits."

**Why:**

- **Feature coverage.** Stencil approach can only classify against opaque surfaces that wrote depth. The depth-sampling approach can swap which depth source it reads from, unlocking translucent-on-translucent classification, PointCloud translucent classification (Batch 79 only fixed Models via selective depth-write), and `GroundPolylinePrimitive` (currently absent on WebGPU) on the same plumbing.
- **Architectural coherence with WebGL.** WebGL's classifier (`ShadowVolumeAppearanceFS.glsl`, `PolylineShadowVolumeFS.glsl`) samples `czm_globeDepthTexture`. Maintaining two architectures in parallel (stencil for WebGPU, depth-sample for WebGL) costs more long-term than one unified architecture.
- **Calendar.** Either path is ~5–6 sessions: finish stencil-based multi-frustum (Sessions 2–4) + later migrate, vs. migrate first + multi-frustum falls out for free. Same calendar, different end state.

**Trade-offs accepted:**

- Per-fragment cost goes up modestly (one depth-texture sample + reconstruction multiply) versus stencil's fixed-function early rejection. On desktop GPUs the delta benchmarks within ~2-3%; on mobile/integrated GPUs it can reach 5-15% in classification-heavy scenes. Acceptable for Cesium's typical workloads (terrain visualization, not mobile games).
- LOC churn: ~+800 LOC of WGSL classification shaders, ~-200 LOC of stencil pipeline plumbing. Net code growth, but a single conceptual surface.
- Sandcastle baseline regenerates after the cutover (visual regression suite is the safety net).

**Stays unchanged:**

- `depth24plus-stencil8` attachment format. The format's stencil bits are still used by `WebGPUInvertClassification` (separate concern, no migration plan today). Switching to `depth24plus` saves zero bytes per pixel on most drivers.
- Edge / shadow / OIT / picking pipelines — none of these use stencil today.
- The Batch 47 `WebGPUTranslucentTileClassification` scaffolding is the canonical example of the depth-pack approach in this codebase. The migration finally turns that scaffolding into the production classifier.

**Re-sequenced plan (replaces the earlier 6-session C-R8 sweep):**

1. **Migration Session 1** — WGSL port of `ShadowVolumeAppearanceVS/FS` + companion uniforms + first-cut single-pipeline `WebGPUGroundPrimitiveRenderer` swap that samples `globeDepthTexture` instead of doing the stencil 2-pass. Keep stencil pipelines compiled but unused as a one-batch fallback.
2. **Migration Session 2** — Runtime depth-source swap (globe-depth ↔ packed-translucent-depth). Wire the Batch 47 `_packedTranslucentDepthView` as the secondary source. Closes C-R8-CLASSIFICATION-DEPTH-SAMPLING and absorbs C-R8-TRANSLUCENT-CLASSIFICATION-DISPATCH.
3. **Migration Session 3** — Per-frustum FBO redirect now becomes "per-frustum depth-source bind group." Closes C-R8-TRANSLUCENT-MULTI-FRUSTUM. Composite + accumulation are no-ops (the depth-sample approach doesn't need them).
4. **Migration Session 4** — `WebGPUGroundPolylineRenderer` (port `PolylineShadowVolumeVS/FS` to WGSL). Reuses the Session 2 depth-source plumbing. Closes C-R8-GROUND-POLYLINE-NATIVE.
5. **Migration Session 5** — Delete unused stencil pipelines from `WebGPUGroundPrimitiveRenderer`. Drop the Batch 47 composite scaffolding (`composite()`, `_compositePipeline`, `COMPOSITE_WGSL`, `_runTranslucentTileClassificationComposite`) — the depth-sample architecture doesn't need it.

**Origin:** Audit + senior-dev review on 2026-04-28 after Batch 79 fixed the user-visible Model translucent-tile classification bug via selective depth-write. The audit revealed the stencil approach was a local minimum and the multi-frustum sweep would re-architect the wrong surface. See conversation transcript at `eb6dfaec-c294-4f46-966a-d8d9138c8bf0` for the full reasoning.

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

### ~~C-R7-RENDERER-MIGRATION-REMAINING~~ DONE 2026-04-29 (audit)

**Resolution:** Audit (2026-04-29, this session) found `WebGPUGlobeSurfaceRenderer` has been routing through the central `webgpuPipelineCache` since **Batch 75** (`_resolveGlobePipelineEntry` calls `pipelineCache.getPipelineSync` / `getPipeline`; the local `_pipelineCache: Map<string, GlobePipelineEntry>` now holds DESCRIPTORS, not pipelines, with the actual `GPURenderPipeline` resolved through the central cache and a sync-fallback `device.createRenderPipeline()` only when no central cache is wired). The `WebGPUShaderModuleCache` is also already adopted (Batch 20).

That leaves only:

- **`WebGPUModelRenderer`** — special-case, blocked on the KHR-extension shader-family work (C-R4-GLTF-KHR). Its pipeline cache adoption pairs with the shader-module dedup work because two models with identical material settings need to share modules to share pipelines.
- **`WebGPUAutoExposure`** — compute pipeline, out of scope until a `WebGPUComputePipelineCache` exists.

Both are tracked under their own work items below; this entry is closed.

**Adopter count:** 15 renderers route through `webgpuPipelineCache` (Polyline, PointPrimitive, GroundPrimitive, GaussianSplat, EllipsoidPrimitive, BufferPrimitive, DepthPlane, Cloud, Voxel, Label, Billboard, Environment Sun, Environment Moon, PointCloud, **GlobeSurface**) + Weather render + VolumetricFog composite.

**Closing batch:** Audit reframe (2026-04-29) confirmed Batch 75 already shipped this for GlobeSurface; the prior wording of this entry was stale.

**Trace:** Verified by grep of `WebGPUGlobeSurfaceRenderer.ts` for `device.createRenderPipeline` (one match — the synchronous-fallback path inside `_resolveGlobePipelineEntry`, used only when the central cache isn't available).

### C-R7-SHADER-MODULE-DEDUP

**What:** Cross-renderer `GPUShaderModule` sharing. Wiring `WebGPUShaderModuleCache` into all renderers (12 of ~17 use it today) lets identical sources actually dedupe.

**Progress:**

- Batch 72 (2026-04-27) added Cloud + Voxel + Weather (render + compute shaders).
- Batch 74 (2026-04-27) added Environment (Sun + Moon), VolumetricFog (compute + composite), PointCloud (default + LOD).

Existing adopters from earlier batches: Polyline, PointPrimitive, Billboard, Label, GlobeSurface.

**Why deferred:** Without dedup, routing `WebGPUModelRenderer` through `webgpuPipelineCache` (Batch 56's deferred case) wouldn't actually share - two models with identical material settings still produce distinct shader modules, distinct pipeline cache keys.

**Prerequisites:** None - `WebGPUShaderModuleCache.ts` exists since Batch 22.

**Estimated effort:** 1 session for ModelRenderer adoption pass.

**Impact:** Memory pressure on shader-heavy scenes (3D Tilesets with many distinct glTF assets sharing material settings).

**Trace:** REVIEW_FIX_PROGRESS.md:2399 (Batch 52 audit), Batches 72/74 lists; OVERSIGHT_AUDIT_2026_04_25.md s3.

---

## C-R8 - Translucent classification follow-ups

**Parent finding:** Six C-R8 sub-items shipped Batches 35-51 (globeDepth, VOXELS-before-OPAQUE, 2D frustum jitter, InvertClassification, Edge FBO+inline, Translucent tile classification first-cut). Three named follow-ups remain on translucent classification leg; MSAA gate closed Batch 61.

### C-R8-TRANSLUCENT-DEPTH-ONLY

**Status: Resolved (different mechanism) — Batches 78–79.**

**What (original framing):** Translucent depth capture was over-broad — `executePackDepth` copies ALL translucent geometry's depth, not just `depthForTranslucentClassification`-flagged 3D-tile content. WebGL's selective behaviour derives a `_depthOnlyCommand` per flagged command per `Cesium3DTile.js:1084`.

**Architectural reframe (audit, 2026-04-28):** WebGPU does NOT consume the packed-depth texture the way the original framing assumed. The active classification renderer (`WebGPUGroundPrimitiveRenderer`) is a stencil-based two-pass approach with no depth-texture sampling — neither `_packedDepthTexture` nor `_globeDepthTexture` is bound to any classification pipeline. Filtering the pack-depth contributors only matters once a depth-sampling classifier exists (tracked separately as **C-R8-CLASSIFICATION-DEPTH-SAMPLING** below).

What the user-visible bug actually is: when a translucent 3D tile overlaps a classification volume, the scene-FB depth at translucent pixels is whatever's behind the tile (globe), so the volume draws on the globe under the tile rather than on the tile surface.

**Batch 78 (gating):**

- `WebGPUDrawCommand` now carries the `depthForTranslucentClassification` flag (Cesium3DTile.js:1084 lands on the WebGPU command instance; previously the assignment hit the field as `undefined` since it didn't exist on the class).
- `WebGPUTranslucentTileClassification.executeTranslucentDepthPass` accepts a `flaggedCommandsPresent` argument and short-circuits the entire pack-depth pipeline (no copy, no MSAA source recording, no pack pass) when no commands in the frustum need translucent classification depth.
- `WebGPUSceneRenderer` scans the frustum's TRANSLUCENT command list before invoking the translucent-depth path.

**Batch 79 (the actual fix — selective depth-write):**

- `WebGPUModelPipelineCache.getDepthWritePipeline(alphaMode, doubleSided)` builds a sibling pipeline of `getPipeline` with `depthWriteEnabled = true` forced on for ALPHA_BLEND. Layout, vertex, fragment, and blend state are identical to the standard variant; only the depth-write bit differs. Cached separately so the standard translucent path (no depth write, alpha-correct compositing) is unchanged for non-tile content.
- `WebGPUModelRenderer` eagerly builds the depth-write variant for every BLEND primitive and stashes it on the `WebGPUDrawCommand` as `classificationDepthPipeline`.
- `WebGPUDrawCommand.execute()` swaps to that variant when `depthForTranslucentClassification === true`. The bind groups, vertex buffers, and draw call are unchanged.

Net effect: translucent 3D tile surfaces populate the scene-FB depth attachment, so the existing stencil-based GroundPrimitive classifier clips its volumes against the tile surface instead of the globe behind it — matching WebGL's user-visible behaviour without porting WebGL's depth-texture sampling architecture.

**Side effect (intended):** translucent labels behind translucent 3D tiles will now be occluded (more physically correct than WebGL's "label sees through everything"). Acceptable.

**Coverage gaps (intentional, deferred to Path A continuation):**

- PointCloud / batched primitive content does not yet have a depth-write variant — only Model (b3dm/i3dm/glb) primitives do. PointCloud translucent tiles will still mis-classify until C-R8-CLASSIFICATION-DEPTH-SAMPLING lands the cleaner architecture.
- Multi-frustum accumulation is still single-frustum (see C-R8-TRANSLUCENT-MULTI-FRUSTUM).
- Depth-only WGSL variants per command (mirroring WebGL's `_depthOnlyCommand`) are still not built — but their value disappears with the new architecture.

**Trace:** REVIEW_FIX_PROGRESS.md:2130; Batch 78 + Batch 79 shipped 2026-04-28.

### C-R8-TRANSLUCENT-MULTI-FRUSTUM

**Status: Paused — folded into Migration Session 3 of the depth-sampling architecture pivot (see ADR-2026-04-28 above).**

**What (original):** Multi-frustum accumulation not wired. `executePackDepth` runs once per frame, capturing only last-rendered frustum's depth.

**Why paused:** the architectural pivot replaces the stencil-based classifier with depth-texture sampling. In the new architecture, "multi-frustum" reduces to "swap the bound depth-source view per frustum draw" rather than "redirect a render pass into a scratch FBO and accumulate stencil bits." Building the stencil-based accumulation now would land code that the architecture migration deletes a few sessions later.

The Batch 47 scaffolding (`_classificationColorTexture`, `composite()`, `_runTranslucentTileClassificationComposite`, `_ensureCompositePipeline`, `COMPOSITE_WGSL`) was designed for the stencil-accumulation path. Migration Session 5 is the point where it gets removed, NOT before — the depth-sampling consumer needs `_packedTranslucentDepthView` and `_packedDepthTexture` to remain wired for as long as the stencil classifier still ships in the same build.

**Re-scoped impact:** Multi-frustum correctness folds into Migration Session 3 (per-frustum depth-source bind groups). No standalone work item remains.

**Trace:** REVIEW_FIX_PROGRESS.md:2132. Audit 2026-04-28.

### C-R8-TRANSLUCENT-CLASSIFICATION-DISPATCH

**What (original framing):** Classification primitive shaders sample `globeDepthTexture`; need option to sample `packedTranslucentDepthView` (Batch 47 pack pipeline) when translucent depth available — that's how WebGL gets translucent-on-translucent classification right.

**Audit reframe (2026-04-28):** WebGPU's only classification primitive renderer (`WebGPUGroundPrimitiveRenderer`) is a stencil-based two-pass approach with NO depth-texture sampling. The original "swap depth source" framing assumed a port of WebGL's `ShadowVolumeAppearanceFS` / `PolylineShadowVolumeFS` depth-sampling architecture. We did not port that.

The framing splits into two distinct items:

1. **C-R8-CLASSIFICATION-DEPTH-SAMPLING** (architectural, future) — replaces the stencil approach with a depth-sampling approach so the renderer can read `_packedDepthTexture` for translucent-on-translucent. Tracked as a separate item below.
2. **DISPATCH proper** — the original WebGL framing isn't directly portable. Closing this item now in favour of the depth-sampling architecture follow-up.

**Why deferred / superseded:** Folded into C-R8-CLASSIFICATION-DEPTH-SAMPLING.

**Status: Superseded — closed by audit; replaced by C-R8-CLASSIFICATION-DEPTH-SAMPLING.**

**Trace:** REVIEW_FIX_PROGRESS.md:2133. Audit 2026-04-28.

### C-R8-CLASSIFICATION-DEPTH-SAMPLING

**What:** WebGPU's `WebGPUGroundPrimitiveRenderer` uses a stencil-based two-pass classifier. WebGL's classifier (`ShadowVolumeAppearanceFS`, `PolylineShadowVolumeFS`) samples `czm_globeDepthTexture` instead. The depth-sampling approach is what enables:

- Translucent-on-translucent classification (sample `_packedTranslucentDepthView` per Batch 47 pack pipeline).
- Single-pass classification (no stencil clear / two-draw cost).
- Cleaner shader extension surface — derived data uniforms (e.g., `czm_globeDepthTexture`-based effects) drop in naturally.

**Why deferred:** Architectural rewrite of the classifier. The stencil approach is correct for opaque-tile classification (the common case) and Batch 79 patches the translucent-tile case via selective depth-write. Depth-sampling is the principled long-term architecture.

**Prerequisites:** Pairs with C-R8-TRANSLUCENT-MULTI-FRUSTUM (the per-frustum FBOs MULTI-FRUSTUM ships are the natural source of `_packedTranslucentDepthView`).

**Estimated effort:** 3-4 sessions. Port WGSL of `ShadowVolumeAppearanceFS` + `PolylineShadowVolumeFS`; rewire `WebGPUGroundPrimitiveRenderer` to bind depth source instead of stencil-clip; add the `(globe-depth, translucent-depth)` runtime swap MULTI-FRUSTUM enables.

**Impact:**

- **Without it:** PointCloud / batched-primitive translucent tiles still mis-classify (only Model path got Batch 79's selective depth-write). Translucent-on-translucent classification doesn't render.
- **With it:** Full WebGL parity for the classification system, single architecture covering all alpha modes and all content types.

**Trace:** Replaces C-R8-TRANSLUCENT-CLASSIFICATION-DISPATCH per audit 2026-04-28.

### ~~C-R8-CLASSIFICATION-PRIMITIVE-GEOM-PLUMBING~~ FIXED 2026-04-28 (Batch 81)

**Resolution:** Two distinct gaps that compounded into a single visible failure:

1. **Renderer was reading the wrong nesting level.** `_webgpuGeometryData` IS populated by `Scene/PrimitiveGeometryHelpers.js:788` on the innermost Cesium `Primitive`, but the wrapping chain for a `GroundPrimitive` is `_GroundPrimitive` → `._primitive` (`ClassificationPrimitive`) → `._primitive` (`Primitive`) → `._webgpuGeometryData`. The renderer was reading the slot off the `_GroundPrimitive` argument directly, where it never lives. **Fix:** walk-the-chain lookup at `WebGPUGroundPrimitiveRenderer.js` — try `primitive._webgpuGeometryData ?? primitive._primitive?._webgpuGeometryData ?? primitive._primitive?._primitive?._webgpuGeometryData`. Direct `Primitive` and `ClassificationPrimitive` callers work through the same lookup with shorter chains.

2. **`createVertexBuffer` was called with the wrong arguments.** The legacy renderer's call site was `WebGPUBuffer.createVertexBuffer(device, vbData.byteLength, false, label)` — but the API is `(device, data, label)`. Passing `byteLength` (a number) as `data` made the inner `data.byteLength` lookup return `undefined`, which the `createBuffer` validation rejected as "Value is not of type 'unsigned long long'". **Fix:** pass the typed array directly; drop the redundant `device.queue.writeBuffer` call (the helper writes data internally).

**Producer side was already correct.** `ClassificationPrimitive.js:417` constructs an internal `Primitive`, and that internal Primitive's `update` → `createVertexArray` flow runs the existing `PrimitiveGeometryHelpers.js:788` populator. No new populator was needed; the chain just needed to be walked on the renderer side.

**Validation:** A programmatically added `RectangleGeometry`-backed `GroundPrimitive` now reaches the renderer with `cache.vertexCount = 384, cache.indexCount = 1716, cache.indexFormat = "uint16"` populated, the depth-sample bind group constructed, and zero console errors during dispatch. Visual output verification is gated on a separate WebGPU canvas-rendering issue (the canvas appears black even on the default CesiumViewer page without any classification primitives — surfaced 2026-04-28, separate investigation).

**Files touched:** `packages/engine/Source/Renderer/WebGPU/WebGPUGroundPrimitiveRenderer.js`. Minor: marked the legacy stencil pipelines now compile and dispatch correctly too — both classifier paths are runtime-functional after Batch 81 modulo the canvas-rendering investigation.

**Closing batch:** Batch 81.

### C-R8-GROUND-POLYLINE-NATIVE — PARTIAL (two unrelated defects fixed; VS extrusion remains)

**Status as of 2026-04-30 (Batch 116):** `WebGPUGroundPolylineRenderer` ships with full color + pick pipelines, depth-sample bind groups, batch-table snapshot, vertex/index buffer upload, and morph-mode pipeline pair. The Scene-side `GroundPolylinePrimitive.update()` delegates to the FR. Two real bugs were found and fixed in Batch 116; one bug remains.

**Fixed in Batch 116:**

- **Pipeline `depthCompare: "less-equal"` → `"always"`** (color, pick, morph color, morph pick). The WebGL `getRenderState` only sets `depthMask: false` and never enables depth test; the WebGPU pipeline was incorrectly culling fragments where the volume's geometric depth lay behind the depth buffer. The classifier samples globe depth in the FS and reconstructs the surface position itself — the volume must rasterize everywhere it covers screen-space.
- **Per-instance color decoding** in `ensureBatchTableSnapshot`. `BatchTable.getBatchedAttribute(i, colorIndex)` returns a `Cartesian4` (`{x, y, z, w}`) for 4-component attributes, not a normalized `Color`. For UNSIGNED_BYTE color attributes (the common case via `ColorGeometryInstanceAttribute.fromColor`), values come back in [0, 255] range and need scaling by `1/255`. The previous code only handled the `{red, green, blue, alpha}` shape and fell through to the white default — every polyline's per-instance color uploaded as `(1, 1, 1, 1)` instead of the user-specified value.

**Remaining bug:** Width extrusion in vsMain pushes vertices off-screen. Bisection confirmed:

1. Replacing `out.pos` with a fullscreen-NDC fan: visible (pipeline sound).
2. Bypassing the entire extrusion (`out.pos = u.proj * (u.mvRTE * positionRTE)`): visible thin polyline outline (RTE + projection sound).
3. Adding a constant width offset (`positionEC + 2240.0 * normalEC`): visible wide red band (normalEC direction sound).
4. Restoring the formula `widthMeters = widthPixels * metersPerPixel(positionEC) / dot(normalEC0, rightPlaneNormalEC)`: not visible.

The per-vertex `widthMeters` produces extreme magnitudes — most likely because `dot(normalEC0, rightPlaneNormalEC)` approaches zero at miter joints, blowing `widthMeters / dot` past the far plane on a subset of vertices and degenerating the triangle fan. The WebGL VS uses the identical formula and works, so something subtle in the WebGPU port is producing a different runtime value (candidate causes: vertex attribute swizzle/encoding mismatch, `czm_normal` matrix layout, `metersPerPixel` returning a different sign/magnitude under WebGPU's [0, 1] NDC z).

**Why still deferred:** Multi-hour focused bisection — not blocking anything outside `GroundPolylinePrimitive`. Apps that need ground polylines on WebGPU today still get blank output (no crash, no validation warnings), but with the depth-test + color fixes in place the renderer should be correct end-to-end once the VS bug is found.

**Prerequisites:** None — bug fix is local to `WebGPUGroundPolylineRenderer.js`'s vsMain.

**Estimated effort:** 1 session, focused VS bisection. Capture vsMain output for a known-good WebGL frame (pull `gl_Position` from a debug RenderDoc capture or instrument the WebGL VS), diff per-vertex against the WebGPU VS to find the divergence.

**Impact:** Polylines on terrain are not visible on WebGPU even though the renderer dispatches commands. No crash, no validation warnings.

**Trace:** Audit 2026-04-28; isolated 2026-04-30 in Batch 111; partially fixed (depth-test + color) 2026-04-30 in Batch 116. `Tools/visual-regression/verify-ground-polyline-zoom.mjs` reproduces.

### C-R8-VECTOR-3DTILE-CLAMPED-POLYLINES — RESOLVED (Batch 114)

**Status:** Shipped in Batch 114 — `WebGPUVector3DTileClampedPolylinesRenderer.js` ports the WebGL VS + FS into a single 7-attribute interleaved WGSL pipeline, with the depth-sample classifier replacing the WebGL stencil-based classifier. `Vector3DTileClampedPolylines.update()` delegates to `FeatureRendererKey.VECTOR_3DTILE_CLAMPED_POLYLINE` on WebGPU; `finishVertexArray` retains the worker-decoded shadow-volume arrays for the FR to upload.

**What landed:**

- WGSL VS port of `Vector3DTileClampedPolylinesVS.glsl` (per-vertex prism extrusion + miter push + manual depth clamp).
- WGSL FS port of `Vector3DTileClampedPolylinesFS.glsl` (depth-sampled classifier with 5-plane test).
- 7-attribute interleaved vertex layout in a 96-byte stream (`startEllipsoidNormal` + `batchId` packed into the same 16-byte slot).
- Per-batch color via storage buffer indexed by `batchId`.
- Pass routing for TERRAIN / 3D-TILE / BOTH classification types.

**Companion FRs from Batches 112-113:**

- `Vector3DTilePrimitive` (extruded polygon classifier) — `WebGPUVector3DTilePrimitiveRenderer.js`.
- `Vector3DTilePolylines` (NON-clamped 3D polylines) — `WebGPUVector3DTilePolylinesRenderer.js`.

**Remaining follow-ups (small):**

- Per-feature pick. Storage-buffer slot already reserved; one extra `vec4[batchId]` write enables it.
- Distinct depth source per pass (TERRAIN reads globe-depth-only; 3D-TILE reads packed-translucent). Current code picks whichever source is bound, matching the simplification used in `WebGPUVector3DTilePrimitiveRenderer`.
- `DEBUG_SHOW_VOLUME` mode visualization.

**Trace:** Batches 112-114 (full Vector3DTile classification family on WebGPU).

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

### ~~NEW-4-E — Voxel color pipeline WGSL parse error at line 113~~ FIXED 2026-04-25 (Batch 68)

**Captured live error (verbatim, port 8090 dev server, ctx UUID redacted):**

```text
[CesiumJS:webgpu:<ctx-uuid>] Shader "unlabeled" compilation ERROR at line 113:1: missing return at end of function
```

This matched the Batch-67 prediction exactly — naga couldn't prove that `fragmentMain` returns on every control-flow path because the `if (tr.x > tr.y) { discard; }` and `if (accumA < 0.01) { discard; }` early-outs in WGSL do NOT count as function terminators. `discard` is a fragment-state mutation, not a control-flow return.
**Resolution:** Took candidate (a) — paired each `discard;` with an explicit `return vec4<f32>(0.0);` in both `fragmentMain` and `fragmentPickMain`. The returned value is dropped by the discard so the colour is irrelevant; the explicit `return` gives naga the terminator it requires. Also added a trailing `return vec4<f32>(0.0);` after the terminal `discard;` at the end of `fragmentPickMain` (the no-hit fallthrough). Verified by re-running `node Tools/visual-regression/sandcastle-batch-66-final-runner.mjs` against a worktree-private dev server on port 8090 — the `missing return at end of function` error is gone from the Voxel Pick demo's console.
**Files touched:** [packages/engine/Source/Renderer/WebGPU/WebGPUVoxelRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUVoxelRenderer.ts) (3 paired `discard; return` edits + 1 trailing fallthrough return + JSDoc-style WGSL comments explaining the naga requirement).
**Closing batch:** Batch 68.

### ~~NEW-4-G — Voxel WGSL `textureSample` not in uniform control flow~~ FIXED 2026-04-26 (Batch 69)

**Resolution:** Took candidate (a) — replaced `textureSample(voxelTex, voxelSamp, uvw)` with `textureSampleLevel(voxelTex, voxelSamp, uvw, 0.0)` in both `fragmentMain` (line 120) and `fragmentPickMain` (line 159) of [WebGPUVoxelRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUVoxelRenderer.ts). `textureSampleLevel` with explicit LOD 0 doesn't compute derivatives, so it has no uniform-control-flow requirement and naga accepts it inside the data-dependent ray-march loop. Volumetric voxel textures are single-mip, so forcing LOD 0 matches existing intent. Verified by re-running `SANDCASTLE_BASE_URL=http://localhost:8082 node Tools/visual-regression/sandcastle-batch-66-final-runner.mjs` — the `'textureSample' must only be called from uniform control flow` error is gone from the Voxel Pick demo's console. NEW-4-H (next predicted blocker) immediately surfaced as expected.
**Files touched:** [packages/engine/Source/Renderer/WebGPU/WebGPUVoxelRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUVoxelRenderer.ts) (2 paired textureSample → textureSampleLevel edits + WGSL comments referencing NEW-4-G).
**Closing batch:** Batch 69.

### ~~NEW-4-H — Voxel `updateWebGPUVoxelPrimitive` calls `Matrix4.multiplyByPoint` with undefined cartesian~~ FIXED 2026-04-26 (Batch 70)

**Resolution:** Two coupled root causes, both fixed in one batch:

1. **`UniformState.cameraPosition` getter was missing.** The TS `.d.ts` companion declared `readonly cameraPosition: Cartesian3` and ~13 WebGPU renderer call sites consumed it (`WebGPUVoxelRenderer`, `WebGPUCloudRenderer`, `WebGPUEllipsoidPrimitiveRenderer`, `WebGPUGaussianSplatRenderer`, `WebGPUPointCloudRenderer`, `WebGPUBufferPrimitiveRenderer`, `WebGPUGlobeSurfaceRenderer`, `WebGPUUniformGroupManager`, `WebGPUModelRenderer`, etc.) — but the JS class only had the private `_cameraPosition` field. Reads always returned `undefined`. Production builds masked this because `Check.typeOf.object` debug pragmas are stripped; the unminified Sandcastle build surfaced the first crash on the Voxel Pick demo. **Fix:** added `get cameraPosition() { return this._cameraPosition; }` to [UniformState.js](../packages/engine/Source/Renderer/UniformState.js) next to `previousCameraPosition`. One line, restores the contract the .d.ts has always promised, fixes all 13 call sites at once.

2. **`DerivedCommand.createDepthOnlyDerivedCommand` lacked the WebGPU shader-program guard** that its sibling `createLogDepthCommand` already had (NEW-5-A, Batch 66). Once Voxel Pick reached the per-frame derived-command sweep, `Scene.updateDerivedCommands → DerivedCommand.createDepthOnlyDerivedCommand` was called for every WebGPU command, and `getDepthOnlyShaderProgram → ShaderCache.getDerivedShaderProgram` dereferenced `shaderProgram._cachedShader` on a WebGPU command (which carries a `GPUShaderModule`-backed pipeline, not a WebGL `ShaderProgram` with `id` / `_cachedShader` fields). Crashed both Voxel Pick AND Translucent Classification with `Cannot read properties of undefined (reading '_cachedShader')`. **Fix:** added the symmetric `if (!defined(cmdShader?.id))` guard at the top of [DerivedCommand.createDepthOnlyDerivedCommand](../packages/engine/Source/Scene/DerivedCommand.js) — copies the WebGPU shader/renderState through unchanged, leaving the WebGPU dispatcher (`selectCommandVariant`) to route depth-only via its own `derivedCommands.depth.command` slot with a pre-built WGSL pipeline.

**Files touched:** [packages/engine/Source/Renderer/UniformState.js](../packages/engine/Source/Renderer/UniformState.js) (added `cameraPosition` getter), [packages/engine/Source/Scene/DerivedCommand.js](../packages/engine/Source/Scene/DerivedCommand.js) (added NEW-4-H WebGPU guard mirroring NEW-5-A).

**Sandcastle verification:** `WebGPU Voxel Pick.html` PASS (was FAIL since Batch 66). Sandcastle baseline jumped from 5/7 to 6/7 PASS in this batch alone; Translucent Classification's `_cachedShader` co-failure is also resolved by the same DerivedCommand.js fix, leaving only its separate depth-format-copy-compat issue (tracked as NEW-4-I).

**Closing batch:** Batch 70.

### ~~NEW-4-I — Translucent Classification copies Depth24PlusStencil8 → Depth24Plus (incompatible formats)~~ FIXED 2026-04-27 (Batch 71)

**Resolution:** Took candidate (a) — flipped the `_translucentDepthTexture` allocation in [WebGPUTranslucentTileClassification.update](../packages/engine/Source/Renderer/WebGPU/WebGPUTranslucentTileClassification.ts) from `format: "depth24plus"` to `format: "depth24plus-stencil8"` so it matches the scene FB depth attachment (`SceneFramebuffer-Color_depth`). The `copyTextureToTexture` call in `executeTranslucentDepthPass` now passes WebGPU spec validation. The sampleable view at `_translucentDepthSampleableView` already pinned `aspect: "depth-only"` so the pack pipeline still reads only the depth channel — the stencil aspect is allocated but never sampled. Cost: one stencil byte per pixel (~negligible at any practical viewport size). The unused `_translucentDepthView` (default-aspect, dead code from a prior refactor) was left in place since it's never consumed and removing it is out of scope. Verified by re-running `SANDCASTLE_BASE_URL=http://localhost:8082 node Tools/visual-regression/sandcastle-batch-66-final-runner.mjs` after `npx gulp build` — Translucent Classification went from FAIL to PASS, taking the Sandcastle baseline from 6/7 to **7/7 PASS** (first time all WebGPU demos green on real WebGPU since the Batch 66 baseline framework was introduced).
**Files touched:** [packages/engine/Source/Renderer/WebGPU/WebGPUTranslucentTileClassification.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUTranslucentTileClassification.ts) (1-line format change + NEW-4-I rationale comment).
**Closing batch:** Batch 71.

---

## ~~BUG-F2 — ShaderBuilder crash on BENTLEY edge asset~~ FIXED (Batch 66)

### ~~F2-SHADERBUILDER-EMPTY-FUNCTION~~ FIXED 2026-04-25 (Batch 66)
**Resolution:** Root cause was NOT property-table mismatch as initially diagnosed. The March 2026 ES6 modernization commit (`febe065f36`) added a debug-only `throw new DeveloperError("The shader function must have at least one line.")` to `ShaderFunction.generateGlslLines()`. `MetadataPipelineStage.declareStructsAndFunctions` legitimately registers `initializeMetadata` / `setMetadataVaryings` unconditionally (so `MetadataStageVS/FS` chunks can call them as no-ops when the model has no metadata), and most glTF assets — Milk Truck, EdgeVisibility test assets, BENTLEY — fall into the empty-body path. **Fix:** removed the empty-body throw in [ShaderFunction.js](packages/engine/Source/Renderer/ShaderFunction.js). GLSL allows empty function bodies (`void foo() {}` is valid); the pre-modernization behaviour silently emitted them. Diagnosis was complicated because the prior verification's "BENTLEY-specific" framing was wrong — the simpler `EdgeVisibilityMaterial.glb` (zero metadata) hit the same path on re-verification, which is what surfaced the actual root cause.
**Closing batch:** Batch 66 ShaderFunction.js empty-body fix.

---

## Cross-cutting priority guide

> **Update 2026-04-27 (Batch 71 reconciliation):** the prior version of this guide led with "C-R5-IMAGERY-16 is the single biggest visual-correctness gap remaining". That citation was lifted from `OVERSIGHT_AUDIT_2026_04_25.md` §2, which was written hours before Batch 58 closed C-R5-IMAGERY-16 (16-layer cap + 5 missing per-layer uniforms shipped — see [PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md § C-R5](PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md)). The audit's recommendation #2 was acted on; the doc trail just never reconciled the closure into this priority guide. C-R5 is no longer the lead item — the highest-impact open correctness work is now C-R8-TRANSLUCENT-MULTI-FRUSTUM.

1. **Highest-impact correctness wins first.** **C-R8-TRANSLUCENT-MULTI-FRUSTUM** produces visible artifacting in nearly every multi-frustum scene (every camera height crossing a logarithmic frustum boundary). 2 sessions, bounded.
2. **Architectural enablers second.** C-R7-RENDERER-MIGRATION-REMAINING + C-R7-SHADER-MODULE-DEDUP together unlock perf wins across the renderer fleet — mechanical pass × 9 renderers.
3. **C-R4-GLTF-KHR is its own multi-week workstream.** Don't pair with anything; consume sessions one extension at a time. KHR_texture_transform is the highest-impact single extension.
4. **C-R9-\* pick follow-ups are nice-to-have.** Per-feature pick / per-cell pick / OIT pick all matter for specific app types; not on critical path for migration parity.
5. **C-R12-PER-OBJECT-CACHES** is a "leave it until something breaks" item.

---

## Appendix - Items NOT in this inventory

- **Bug-tracker items** are tracked in `WEBGPU_DEBUGGING_LOG.md`. Numbered `BUG-NN.M`.
- **High-severity findings** (`H-R*`, `H-P*`, `DP-H*`) are in `WEBGPU_MIGRATION_BACKLOG.md` rather than here. This inventory is C-R-prefixed only.
- **Open parent findings** without named follow-ups (`C-R4`) stay in their parent review docs as deferral entries themselves. (`C-R5` was the other entry here pre-2026-04-27 and is now CLOSED — Batch 58 shipped C-R5-IMAGERY-16; no remaining follow-ups.)
