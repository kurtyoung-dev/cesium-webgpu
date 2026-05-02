# Deferred Work Inventory - CesiumJS WebGPU Migration

**Last Updated:** 2026-05-02 (AUDIT_2026_05_02.md cross-coupling sweep — 100+ findings across 5 clusters; this doc updated with stale-status corrections + new high-priority entries)

This is the canonical list of named C-R follow-ups deferred during the principal-engineer review remediation (Batches 1-64). Each entry has a stable identifier (`C-R<n>-<NAME>`) that survives renumbering when slots are filled. Grouped by parent C-R finding from `PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md`.

Each entry: **What** / **Why deferred** / **Prerequisites** / **Estimated effort** (1 session ~ 1-3 hours) / **Impact** / **Trace**.

This inventory is add-only; ship items mark `(SHIPPED in Batch N)` next to the heading rather than removing the row.

**Companion docs (cross-reference before scoping):**

- [FEATURE_INVENTORY.md](FEATURE_INVENTORY.md) — exhaustive catalog of existing/new/WIP/future features
- [AUDIT_2026_05_02.md](AUDIT_2026_05_02.md) — most recent cross-coupling audit; 110+ findings prioritized by severity (BREAKING / PARTIAL / LATENT / STALE STATUS)

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

### ~~C-R1-COLLECTIONS-PER-ENCODER~~ — RESOLVED (audit 2026-05-02)

**Audit finding (AUDIT_2026_05_02.md D.2):** All five collection renderers forward `renderState` onto their commands today: `WebGPUBillboardRenderer.js:884`, `WebGPULabelRenderer.js:724`, `WebGPUPointPrimitiveRenderer.js:852/991`, `WebGPUPolylineRenderer.js:1112/1273`, `WebGPUCloudRenderer.ts:596`. `WebGPUDrawCommand.execute()` at `WebGPUDrawCommand.ts:500-504` automatically calls `applyPerEncoderState(passEncoder, this.renderState)` when defined. Custom stencilRef / blendConstant / scissor flow correctly.

**Status:** No code change needed; entry preserved as a marker so future audits don't re-investigate.

### C-R1-GLOBE-RENDERSTATE

**What:** `WebGPUGlobeSurfaceRenderer.ts` builds pipeline variants from local hard-coded state instead of consuming upstream `command.renderState`. The provider sets per-tile depthMask / cullFace based on tile elevation/back-facing geometry; the WebGPU path overrides with a fixed front-face cull.

**Why deferred:** Globe surface renderer has its own custom pipeline-variant builder predating `RenderStateToPipelineVariant.ts`; routing the upstream renderState through requires reconciling two distinct variant key shapes.

**Prerequisites:** Bundles naturally with C-R7-RENDERER-MIGRATION (route GlobeSurface through central pipeline cache).

**Estimated effort:** 1-2 sessions.

**Impact:** Underground / inverted tiles may render with wrong cull mode at the rim of the globe (e.g., transitioning across a steep cliff). Minor artifacting.

**Trace:** PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md:30.

### ~~C-R1-PRIMITIVE-DERIVED~~ EFFECTIVELY RESOLVED (audit 2026-05-02)

**Audit finding:**

- The `pickCommand` paths (both shader-path and material-path) in `WebGPUPrimitiveCommands.js` already forward `appearance.renderState` — Batch 98 landed this. See `pickCommand` construction at `WebGPUPrimitiveCommands.js:1502-1535` (shader path) and `:2326-2354` (material path), both with `renderState: appearance?.renderState` and explanatory comments. So per-encoder dynamic state (stencilRef, scissor, viewport, blendConstant) flows through pick passes.
- `depthOnlyCommand` and `pickDepthCommand` are NOT emitted by the WebGPU primitive flow — and **have no consumer in the WebGPU dispatch path.** WebGPU primitives use a parallel-array shape (`colorCommands[]` + `pickCommands[]`) rather than the WebGL per-command derived-dictionary shape. The dispatcher in `WebGPUSceneRenderer.ts:188` checks `derivedCommands.depth.depthOnlyCommand` as a fallback, but no Pass dispatch in the WebGPU `executeFrustumLoop` invokes primitives in depth-only mode (shadow casting goes through `executeShadowMapCastCommands` + the dedicated CSM cast pass; globeDepth uses `executeUpdateDepth` which copies post-render). Adding `depthOnlyCommand` emission would be scaffolding without a consumer.

**Status:** Pick variant renderState forwarding is complete. Depth-only variant emission has no consumer to plumb to. Per the dead-code audit rule (CLAUDE.md), not adding scaffolding without a consumer.

**If/when needed:** A future depth-only primitive dispatch (e.g., a real early-z prepass landing for performance) would need both the consumer-side dispatcher hook AND the producer-side `depthOnlyCommand` emission. They should land together.

**Trace:** PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md:30; Batch 98 (pick variant renderState); audit 2026-05-02.

### C-R1-TILE-BATCH

**What:** `Cesium3DTileBatchTable.js` per-feature renderState (depthMask flip for `_depthOnlyCommand` derivation, custom color blend for translucent tiles) is not consumed by the WebGPU model command emission path.

**Why deferred:** Routing through the renderState pipe requires teaching `WebGPUModelRenderer.js` to inspect batch-table per-feature state, which has its own representation that's not yet typed.

**Prerequisites:** Pairs with C-R9-MODEL-FEATURE-PICK - both touch batch-table integration.

**Estimated effort:** 1-2 sessions.

**Impact:** Per-feature transparency in 3D Tiles renders without the alpha-driven depthMask flip on WebGPU; visible as z-fighting on overlapping translucent features.

**Trace:** PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md:30.

---

## C-R4 - glTF KHR extensions

### ~~C-R4-GLTF-KHR~~ MOSTLY RESOLVED 2026-04-30 (audit)

**Resolution:** Audit (2026-04-30, this session) found that **all seven**
listed KHR extensions are wired into `ModelPBRComplete.wgsl` and
`WebGPUModelRenderer.js` already, via Batches 102, 103, 105, and the
"Slice 2-7" series:

| Extension | Status | Shader markers | Notes |
| --- | --- | --- | --- |
| KHR_texture_transform | ✅ Full | `applyTextureTransform()` at lines 1271-1283; called from `baseColorUV`, `normalUV`, `metallicRoughnessUV`, `emissiveUV`, `occlusionUV` | Per-texture 3×3 matrix uploaded as 3 padded vec4 columns; `textureTransformFlags` bitmask gates the matrix multiply per slot. |
| KHR_materials_clearcoat | ✅ Full BRDF | "Slice 2" branch at line 1515 | Second GGX lobe with own normal/roughness textures + base-material attenuation by `(1 - F_clearcoat)`. |
| KHR_materials_specular | ✅ Full | "Slice 3" branch at line 1400 | F0 dielectric component recoloured by specular color factor + texture; metallic surfaces use baseColor for F0 per spec. |
| KHR_materials_anisotropy | ⚠️ Approximated | "Slice 4" branch at line 1482 | GGX D-term stretched along view-relative direction. Full per-tangent BRDF deferred (needs vertex-tangent attribute through FragmentInput; comment at line 1474 calls this out). |
| KHR_materials_iridescence | ⚠️ Approximated | "Slice 5" branch at line 1428 | Hue-shift approximation rather than true thin-film LUT-based interference. Full Khronos reference impl needs precomputed wavelength LUT. |
| KHR_materials_sheen | ✅ Full BRDF | "Slice 6" branch at line 1558 | Charlie distribution + Neubelt/Pettineo visibility approximation. |
| KHR_materials_volume | ✅ Full | "Slice 7" branch at line 1642 | Beer-Lambert attenuation on diffuse. Thickness texture sampled. |
| KHR_materials_transmission | ⚠️ Simplified | "Batch 105" branch at line 1606 | Samples a refraction texture but uses placeholder until the full opaque-only MRT is wired (Batch 107 added the capture pass; FS still reads at simple offset rather than thickness-driven path). |

**Remaining work** (now scoped much more narrowly than the original
multi-week estimate):

- **NEW-KHR-ANISO-TANGENT** — wire glTF tangent attribute through to FS
  for true per-tangent anisotropic GGX. Drops the "view-relative
  approximation" comment at line 1474.
- **NEW-KHR-IRIDESCENCE-LUT** — precomputed thin-film LUT + sample at
  NdotV for true wavelength-dependent Fresnel modulation. Drops the
  hue-shift approximation at line 1428.
- **NEW-KHR-TRANSMISSION-THICKNESS** — couple transmission's refracted
  UV offset to the volume thickness texture so glass-thickness varies
  correctly. Today the offset is a fixed 0.05 step (line 1626).

These are individual session-sized follow-ups, not the original
multi-week workstream. Filed below.

**Trace:** PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md:101-102;
OVERSIGHT_AUDIT_2026_04_25.md s2; reconciled in Batch 128 (2026-04-30).

---

### NEW-KHR-ANISO-TANGENT

**What:** KHR_materials_anisotropy currently approximates the
anisotropic GGX lobe by stretching the GGX D-term along a view-relative
direction (`viewRight = cross(N, V)`). The spec defines the streak
along the per-fragment tangent direction, which requires the glTF
TANGENT attribute to flow through to the FS.

**Why deferred:** TANGENT is already declared as a vertex attribute on
the model pipeline layout but the FS-side `tangentEC` field has gaps
in coverage (some pipelines elide it). Plumbing it to the anisotropy
branch is one session; the visual delta is brushed-metal materials
correctly streaking along the asset's authored tangent.

**Trace:** `ModelPBRComplete.wgsl` line 1474 ("...full per-tangent BRDF
lands in a follow-up").

---

### NEW-KHR-IRIDESCENCE-LUT

**What:** KHR_materials_iridescence currently uses a hue-shift
approximation (`0.5 + 0.5 * cos(phase * 2π + offset)` per RGB
component) rather than a precomputed wavelength-LUT. The Khronos
reference impl samples a 64×1 LUT keyed on
`(NdotV, thickness, IOR)` for spectrally-correct Fresnel modulation.

**Why deferred:** Bulkier than the other slices because it ships the
LUT as a resource — needs a one-time texture upload at module init
plus an extra sampler binding.

**Trace:** `ModelPBRComplete.wgsl` line 1424 ("Full thin-film
interference requires per-wavelength optical-path-difference math
that's prohibitive without a precomputed LUT").

---

### NEW-KHR-TRANSMISSION-THICKNESS

**What:** KHR_materials_transmission currently uses a fixed UV-offset
step (0.05) when sampling the refraction scene texture. The spec
couples the offset to KHR_materials_volume's thickness so
glass-thickness varies correctly with the underlying asset's
geometry. Today both extensions activate independently.

**Why deferred:** Slice 7 (volume) and Batch 105 (transmission) shipped
in different iterations without sharing the thickness sample. Full fix
is local to the transmission branch in `ModelPBRComplete.wgsl`.

**Trace:** `ModelPBRComplete.wgsl` line 1620 ("Without a thickness
sample we use a fixed step...").

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

**What:** Cross-renderer `GPUShaderModule` sharing. Wiring `WebGPUShaderModuleCache` into all renderers lets identical sources actually dedupe.

**Progress:**

- Batch 72 (2026-04-27) added Cloud + Voxel + Weather (render + compute shaders).
- Batch 74 (2026-04-27) added Environment (Sun + Moon), VolumetricFog (compute + composite), PointCloud (default + LOD).
- **Batch 162 (2026-05-02) — Model PBR adoption.** `WebGPUModelPipelineCache._shaderModule` now resolves through a per-device `WebGPUShaderModuleCache` (`MODEL_PBR_COMPLETE` source ID 23). One `WebGPUModelPipelineCache` is created per `Model` instance, so a 100-glTF tileset previously compiled the same WGSL 100 times — now shares one `GPUShaderModule` across all instances on a device. Pipelines themselves stay per-cache (per-Model formats / alphaMode / doubleSided).
- **Batch 163 (2026-05-02) — Vector 3D Tile family adoption.** All three Vector 3D Tile renderers route through per-device caches with new source IDs 24/25/26 (`VECTOR_3DTILE_PRIMITIVE`, `VECTOR_3DTILE_POLYLINES`, `VECTOR_3DTILE_CLAMPED_POLYLINES`). WGSL is built per-`buildResources` call but is constant per build, so dense vector overlays with N visible tiles now share one module instead of compiling N times.
- **Batch 164 (2026-05-02) — BufferPrimitive family adoption.** BufferPoint/Polyline/Polygon renderers route through a single shared per-device cache (helper exported from `WebGPUBufferPrimitiveRenderer.ts` since the 3 renderers share the parent module). New source IDs 27/28/29 (`BUFFER_POINT_MATERIAL`, `BUFFER_POLYLINE_MATERIAL`, `BUFFER_POLYGON_MATERIAL`). Each `BufferPrimitiveCollection` previously compiled its own module; now one module per `(device, materialKind)` regardless of collection count.

Existing adopters from earlier batches: Polyline, PointPrimitive, Billboard, Label, GlobeSurface.

**Remaining renderers (still bypass the cache, audited 2026-05-02):**

| Renderer | File | Estimated impact |
| --- | --- | --- |
| Ground Primitive + Ground Polyline | `WebGPUGround*.js` | Typically few-per-scene. Low dedup win. |
| SkyAtmosphere | `WebGPUSkyAtmosphereRenderer.js` | Singleton per scene. Negligible win. |
| Ellipsoid Primitive | `WebGPUEllipsoidPrimitiveRenderer.ts` | Few-per-scene. Low win. |

**Prerequisites:** None - `WebGPUShaderModuleCache.ts` exists since Batch 22.

**Estimated remaining effort:** All high-dedup-win renderers covered as of Batch 164. The 3 low-win remainders can ride along when next touched for other reasons (per "incremental upgrade" rule in CLAUDE.md). Mark this entry CLOSED if/when the low-win three are mopped up; the dedup architecture itself is fully wired.

**Impact:** Memory pressure on shader-heavy scenes — Model (Batch 162), Vector 3D Tiles (Batch 163), and BufferPrimitive (Batch 164) cover the highest instance-count cases.

**Trace:** REVIEW_FIX_PROGRESS.md:2399 (Batch 52 audit), Batches 72/74/162/163/164 lists; OVERSIGHT_AUDIT_2026_04_25.md s3.

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

### ~~C-R8-CLASSIFICATION-DEPTH-SAMPLING~~ — RESOLVED (Migration Sessions 1-5, Batches 80-85)

**Resolution (verified 2026-04-30 by Batch 117 / 118 audit):** The depth-sampling architectural rewrite shipped across Migration Sessions 1-5:

- **Session 1 (Batch 80):** depth-sample classifier infrastructure — `dsColorFS` / `dsPickFS` entry points sample globe-depth and discard where the surface wrote no depth.
- **Session 2 (Batch 82):** runtime depth-source swap (globe-depth ↔ packed-translucent-depth) via `_packedTranslucentDepthView` plumbed through `WebGPUDrawCommand.bindGroupResolvers`.
- **Session 3 (Batch 83):** per-frustum depth-source bind groups.
- **Session 4 (Batch 84):** `WebGPUGroundPolylineRenderer` skeleton.
- **Session 4b (Batches 86, 88, 97, 116, 117):** full WGSL port of `PolylineShadowVolumeVS/FS` + materials + per-instance color decoding + depth-test + viewport-source fixes.
- **Session 5 (Batch 85):** retire the legacy stencil classifier path. Depth-sampling is now the only classification path.

**Selective depth-write side (Batch 79):** Models force depth-write ON for BLEND-mode primitives via `WebGPUModelPipelineCache.depthWritePipeline` + `WebGPUDrawCommand.classificationDepthPipeline` + `Cesium3DTile.js:1084` flag plumbing.

**Verified content-type coverage:**

- **Model (b3dm/i3dm/glb):** Selective depth-write variant shipped Batch 79.
- **PointCloud:** Already writes depth unconditionally (`WebGPUPointCloudRenderer.ts:386` `depthWriteEnabled: true`). No variant needed.
- **Vector3DTile* family:** These ARE classifiers (depth-sample consumers), not classified-against content.
- **Gaussian Splat:** Pipelines have `depthWriteEnabled: false` for translucent rendering — when a translucent splat tile is the source content for ground classification, the depth buffer is empty at those pixels. Tracked as a separate small item below: **NEW-GS-CLASSIFICATION-DEPTH** (~1 session, follow-up to Batch 79's Model pattern).

**Trace:** Replaces C-R8-TRANSLUCENT-CLASSIFICATION-DISPATCH per audit 2026-04-28; full closure documented 2026-04-30.

### NEW-GS-CLASSIFICATION-DEPTH

**What:** Gaussian Splat 3D-tile content (`.spz`/`.splat`) currently has `depthWriteEnabled: false` on its translucent pipelines. When a ground primitive classifies against a region containing a translucent splat tile, the classifier samples globe-depth instead of splat-tile depth — classification "leaks through" the splat to whatever lies behind it on the globe surface.

**Why deferred:** Edge case. Most production 3D Tiles content is Models / PointClouds; splat-as-classification-source is rare.

**Prerequisites:** None. Mirrors the Batch 79 Model fix — sibling pipeline with `depthWriteEnabled: true`, swap via `WebGPUDrawCommand.classificationDepthPipeline` when the per-tile `depthForTranslucentClassification` flag is set.

**Estimated effort:** 1 session.

**Impact:** Without it: translucent splat tiles mis-classify when used as classification sources. With it: full content-type coverage for translucent-tile classification.

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

### ~~NEW-BG-CONSOLIDATION~~ — RESOLVED Batch 122 (audit 2026-05-02)

**Audit finding (AUDIT_2026_05_02.md D.1):** `WebGPUModelPipelineCache.js:545-553` (current line) declares 4 BGLs (camera, material, instance, effects). `ModelPBRComplete.wgsl` only uses `@group(0..3)`. The 8→4 consolidation shipped in Batch 122. The "ALL Model rendering broken on Edge/Vulkan" warning below was true pre-Batch 122 and has been moot for ~10 batches.

**Status:** Resolved. C-R9-MODEL-FEATURE-PICK is no longer blocked by this — it's blocked by the per-vertex-attribute feature-ID path (see new entry NEW-FEATURE-ID-VERTEX-ATTR below).

**Historical record (preserved for archaeology):**

`WebGPUModelPipelineCache.js:51-156` (pre-Batch 122) declared 8 bind group layouts (camera, material+light, textures, skinning, morphTarget, instancing, featureId, effects → groups 0-7). The WebGPU spec default `maxBindGroups = 4`. On adapters with the default limit (Edge/Vulkan, all backends without an explicit higher tier), pipeline creation fails with `bindGroupLayoutCount (8) is larger than the maximum allowed (4)` — silently, because the failure surfaces async via `popErrorScope` while the synchronous `setPipeline()` call gets an "Invalid RenderPipeline" handle that the validation layer rejects without throwing.

**Discovered (2026-04-30) during the C-R9 investigation chain:**

1. b3dm-Model rendering gap was NOT b3dm-specific — it affected ALL Model rendering on WebGPU.
2. Three real bugs along the chain were fixed and shipped this session (see Batch 120):
   - `Scene/GltfLoader.js`: typed-array retention broadened to all WebGPU contexts (mirrors NEW-4-A pattern).
   - `Scene/Model/ModelPrimitiveGeometry.js:extractPrimitiveGeometry`: fall back to `runtimePrimitive.primitive.attributes` because `runtimePrimitive.renderResources` is never assigned anywhere.
   - `Scene/DerivedCommand.js` + `Scene/OIT.js`: WebGPU short-circuit guards added to `createPickDerivedCommand`, `createPickMetadataDerivedCommand`, `createHdrCommand`, `OIT.createDerivedCommands` (sibling pattern to the existing guards in `createDepthOnlyDerivedCommand` + `createLogDepthCommand`).
3. After all three fixes, `model._webgpuCache.primitives` populates correctly (5 primitives on the CesiumAir test glb), but pipeline creation fails on the bind-group-count limit.

**Why deferred:** Bind-group consolidation requires:

- Restructuring 8 logical groups into ≤4 physical groups in `WebGPUModelPipelineCache.js` (~60 lines of BGL construction + ~20 lines of bind group construction).
- Updating ALL `@group(N) @binding(M)` declarations in `ModelPBRComplete.wgsl` (~200 sites).
- Updating JS bind group factory functions (e.g., `createEffectsBindGroup` in `WebGPUEffectsBindGroup.js`).
- Likely combination scheme:
  - Group 0: camera + effects (read-only frame uniforms)
  - Group 1: material + light + textures (per-material)
  - Group 2: skinning + morphTarget + instancing (per-instance vertex data)
  - Group 3: featureId (per-feature)

**Estimated effort:** 2-3 sessions. Mechanical but extensive.

**Impact:** Without it: ALL b3dm/i3dm/glb Model rendering on WebGPU is broken on adapters with the spec-default `maxBindGroups: 4` (Edge/Vulkan, most current production paths). With it: 3D Tiles vector content renders, Model demos work, C-R9-MODEL-FEATURE-PICK fires (the prerequisite chain it was blocked on).

**Trace:** Discovered 2026-04-30 during the b3dm-Model rendering investigation. `Tools/visual-regression/verify-glb-renders.mjs` is the repro — load CesiumAir.glb → see "bindGroupLayoutCount (8) is larger than the maximum allowed (4)" warning.

### C-R9-MODEL-FEATURE-PICK — CODE WIRED, BLOCKED ON UPSTREAM b3dm RENDERING GAP

**Status (verified 2026-04-30 via `Tools/visual-regression/verify-model-feature-pick.mjs`):** All four code-paths for per-feature pick are wired and look correct:

1. **Shader pickFS routes through `lookupFeaturePickColor`** (`ModelPBRComplete.wgsl:1862–1929`) when `featureId.featurePickEnabled > 0.5` and the batch table is bound.
2. **Per-feature pick texture allocation + upload** in `WebGPUModelFeatureId.js:512–580` (`ensurePerFeaturePickIds`) — eager allocation when batch table is present, one Cesium pickId per feature, target = `{primitive: model, id: featureId}`.
3. **Bind group binds feature-pick texture** at `@group(6) @binding(5)` (`WebGPUModelFeatureId.js:459–462`).
4. **Uniform flag flip** — `featureUniformData[12] = featurePickTex ? 1.0 : 0.0` (`WebGPUModelFeatureId.js:423`).

**Blocking gap (discovered during verification):** The verify script loads `BatchTableHierarchy/tileset.json` (b3dm content with 30-feature batch table, `batchTextureExists: true`, `batchTextureDimensions: [30, 1]` — all the upstream metadata is correct) and confirms:

- `tilesetFeaturesLoaded: 30` — Cesium loads the features.
- `model._webgpuCache.primitives === {}` — **the WebGPU model renderer never builds primitive caches for the b3dm-tileset model.**
- Consequently `ensureFeatureIdResources` is never invoked, `ensurePerFeaturePickIds` never runs, and no per-feature pickIds are allocated.

**SECONDARY blocking gap (discovered audit 2026-05-02):** Even when b3dm rendering lands, only the texture-based feature ID path will fire. `ModelPBRComplete.wgsl:1915-1929` gates per-feature pick on `FLAG_HAS_FEATURE_ID_TEXTURE`. B3DM tilesets predominantly carry `_BATCHID` vertex attributes, NOT textures. There's no `unpackFeatureIdFromAttribute` path in the shader and no `featureIdAttributeBuffer` binding in the pipeline cache. See new entry **NEW-FEATURE-ID-VERTEX-ATTR** below.

So the C-R9 work is functionally **un-testable** until BOTH the upstream b3dm-Model rendering path AND the vertex-attribute feature-ID path land.

**Trace:** PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md:220 (Batch 54 "Still open"); 2026-04-30 reverification confirms shader + JS code wired Batches 100/101; AUDIT_2026_05_02.md B.2 surfaces the secondary blocker.

### NEW-FEATURE-ID-VERTEX-ATTR

**What:** Per-feature pick on B3DM tilesets requires reading `_BATCHID` vertex attribute (and EXT_mesh_features ID0/ID1/ID2). The texture-based path is wired; the vertex-attribute path is missing.

**Why deferred:** Surfaced by AUDIT_2026_05_02.md after the NEW-BG-CONSOLIDATION reconciliation. Most existing 3D Tiles content uses vertex-attribute feature IDs.

**Prerequisites:** None on the WebGPU side; can land independently. (NEW-BG-CONSOLIDATION blocker for the broader pick chain is already lifted.)

**Estimated effort:** 1 session.

**Implementation:** Wire `_BATCHID` (and EXT_mesh_features ID0/ID1/ID2) vertex attribute as a vertex input slot, plumb through to FS via `@interpolate(flat) @location(N) batchId: u32` (use `flat` interpolation since per-vertex IDs are integer constants per-triangle), and route through `lookupFeaturePickColor`/`lookupBatchColor` from there as the alternative to the texture sample.

**Impact:** B3DM tilesets — the most common 3D Tiles content type — get per-feature pick.

**Trace:** AUDIT_2026_05_02.md B.2.

**Estimated remaining effort:** 0 sessions if the b3dm-Model render path lands separately; the verify script will then pass automatically.

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
