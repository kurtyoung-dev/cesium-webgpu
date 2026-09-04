# Fork Feature Inventory & Completeness Audit

**Date:** 2026-04-30  **Branch:** main @ 92e9a5d5c2 (Batch 116)
**Method:** code-verified — every claim grounded in a file path + line number, doc claims cross-checked against actual source.

---

## Reading guide

| Status | Definition |
|---|---|
| **Started** | Scaffolding only — does not render correctly even on the golden path |
| **Alpha** | Golden path renders, multiple known bugs / missing features documented |
| **Beta** | Golden path + edge cases mostly work, 1-3 known issues remain |
| **Feature-Complete** | Parity with WebGL or explicitly superior; no DEFERRED_WORK entries open |

**Codebase scale (verified by `wc -l` / `find`):**

- `packages/engine/Source/Renderer/WebGPU/`: **143** .js+.ts files (138 entries inc. dir entries; 143 source files)
- `packages/engine/Source/Shaders/WebGPU/`: **259** `.wgsl` files
- `packages/engine/Source/Renderer/FeatureRendererKey.js`: **45 enum slots** (`COUNT: 45`, slots 0–44)
- Top-tier file sizes (verified): `WebGPUContext.ts` 4363, `WebGPUGlobeSurfaceRenderer.ts` 3933, `WebGPUSceneRenderer.ts` 3626, `WebGPUGroundPolylineRenderer.js` 2752, `WebGPUPrimitiveCommands.js` 2456, `WebGPUModelRenderer.js` 2296, `GraphicsContext.ts` 1783, `WebGPUBufferPrimitiveRenderer.ts` 1657, `WebGPUPostProcessEffects.ts` 1487, `WebGPUEffectsBindGroup.js` 1471, `WebGPUShadowMapRenderer.js` 1463, `WebGPUCSMRenderer.ts` 1375, `WebGPUVolumetricFogRenderer.ts` 1352, `WebGPUPolylineRenderer.js` 1308, `WebGPUPostProcessPipeline.ts` 1200, `WebGPUEnvironmentRenderer.js` 1199, `WebGPUModelPipelineCache.js` 1138, `WebGPUPointCloudRenderer.ts` 1111, `WebGPUBillboardRenderer.js` 1044, `WebGPUPointPrimitiveRenderer.js` 1040.

---

## Doc inaccuracies discovered during verification (read this first)

These are places where documentation in this repo materially misrepresents the code:

1. **`WebGPUVolumetricFogRenderer.ts:11–18` docstring is STALE.** It claims:
   > *"Phase 5a contract — no visual change. The compute kernels in `VolumetricFog.wgsl` are placeholders that clear their output textures to zero (or `(0, 0, 0, 1)` for the integrated volume so transmittance = 1). The composite pass samples the cleared volume and applies `out = sceneColor * 1 + 0 = sceneColor`."*
   
   The actual `packages/engine/Source/Shaders/WebGPU/Compute/VolumetricFog.wgsl` (485 lines) opens with `// Phase 5b real kernels (height fog + sun/moon scattering + front-to-back integration)` and contains:
   - real density-injection with `density × exp(-h × falloff)` height fog (`VolumetricFog.wgsl:285–319`)
   - Henyey-Greenstein sun + moon in-scattering (the lightScattering pass)
   - sun shadow-map sampling for occlusion in scattering (`VolumetricFog.wgsl:235–260`)
   - 3-octave value-noise FBM for varying density (`VolumetricFog.wgsl:200–223`)
   - C-P7-RTE altitude reconstruction via 2nd-order Taylor expansion (`VolumetricFog.wgsl:296–317`)
   
   So volumetric fog is no longer a "no visual change" placeholder — it is a real Phase 5b/5c implementation with shadow occlusion, height fog, and varying density already wired. The renderer-side docstring needs to be rewritten.

2. **The `Model*Stage.wgsl` "orphaned files" claim is wrong.** A common framing in handoff docs is that six `KHR_materials_*` extension shaders ship as separate `Model<Extension>Stage.wgsl` files imported by nothing. Verified by listing `packages/engine/Source/Shaders/WebGPU/Model/`:
   ```
   ModelAtmosphereStage.{js,wgsl}    ModelCPUStylingStage.{js,wgsl}
   ModelColorStage.{js,wgsl}          ModelPBRComplete.{js,wgsl}
   ModelPointCloudStylingStage.{js,wgsl}  ModelSilhouetteStage.{js,wgsl}
   ModelSplitterStage.{js,wgsl}
   ```
   No `ModelClearcoatStage`, `ModelAnisotropyStage`, `ModelSpecularStage`, `ModelIridescenceStage`, `ModelSheenStage`, or `ModelVolumeStage` files exist. The KHR_materials_* support is integrated *directly* into `ModelPBRComplete.wgsl` via material-flag bits (`FLAG_HAS_CLEARCOAT = 524288u // bit 19`, `FLAG_HAS_SPECULAR_EXT bit 20`, `FLAG_HAS_ANISOTROPY bit 21`, `FLAG_HAS_IRIDESCENCE bit 22`, `FLAG_HAS_SHEEN bit 23`, `FLAG_HAS_VOLUME bit 24`, `FLAG_HAS_TRANSMISSION bit 25`). The `*Stage.wgsl` pattern that exists for `Atmosphere`/`Color`/`Silhouette`/`Splitter`/`CPUStyling`/`PointCloudStyling` is a *different* mechanism (post-processing model material modifiers) and was never extended to KHR.

3. **Cross-referenced batch lineage is correct.** `git log --oneline -50` (Batches 71–116) exactly matches what `migration_doc/DEFERRED_WORK.md` and the prior session summary describe. Batches 90, 95, 102, 103, 105, 107 = the C-R4-GLTF-KHR slices; Batch 110 = HDR full implementation; Batch 116 = the most recent commit (GroundPolyline depth-test + color decoding).

4. **Architecture-doc claim "RenderCommand adopted in only 3 scene files" is correct.** Verified: `Grep RenderCommand` in `Source/Scene/`: 3 files (`ClassificationPrimitive.js`, `GroundPrimitive.js`, `QuadtreePrimitive.js`) vs. **24 files** still constructing `DrawCommand` directly.

5. **Architecture-doc claim "17 Scene/ branches in 8 files" was approximate.** Actual count from `Grep`: **15 real branches across 11 files** (excluding the legitimate getter at `Scene.js:2066`, debug-only sites at `CesiumDebug.js`/`SceneDebug.js`, comments at `Scene.js:2060/4634`, and the `EdgeVisibilityPipelineStage.js:69` comment-only mention). The count is in the same ballpark; the exact list:
   - `Vector3DTilePrimitive.js:534`, `Vector3DTileClampedPolylines.js:476, 741`, `Vector3DTilePolylines.js:429, 639` (5 — newest, depth-sample classifier family)
   - `GroundPolylinePrimitive.js:543`, `ClassificationPrimitive.js:828`, `DepthPlane.js:52` (3 — classification family)
   - `FramebufferOrchestrator.js:100, 118, 120` (3 — backend-specific FB orchestration)
   - `GltfLoader.js:1378`, `Model/Model.js:3142`, `Model/EdgeVisibilityPipelineStage.js:77, 78` (3 model paths; one is a comment)
   - `ViewportQuad.js:135` (1)
   
   Plus `Scene.js:2608` and `:4397` check `command.isWebGPUDrawCommand` (a *command* property, not a context branch — fine).

6. **`FeatureRendererKey` enum — agent claim "45 entries" is correct.** Verified by reading the file end-to-end. Slots 0–44 are populated; slot 8 is `FOG` retained as add-only (registration was removed Session 37 but the slot was preserved per CLAUDE.md "ShaderDefine bitmask registry" add-only rule). Slot 33 was previously `DEFERRED_GBUFFER` and was removed with subsequent slots renumbered down — see the trailing comment at `FeatureRendererKey.js:152–157`. **This is a violation of the documented add-only rule** but the comment acknowledges it explicitly; the renumbering predates the discipline being formalized.

7. **`ShaderDefine` bitmask: 4 bits used, 24 max** (`WebGPUShaderDefines.ts:37–100`). `ShaderSourceId`: 22 entries registered (IDs 1–22; 0 reserved). All matches the docs.

---

## Category: Core renderer infrastructure

| Feature | Status | Major issues / integration concerns | Remaining work |
|---|---|---|---|
| **WebGPUContext** ([WebGPUContext.ts](../../../packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts), 4363 lines) — extends `GraphicsContext`, lazy device acquisition, ContextRegistry membership, lazy pipeline + compute-pipeline + shader module + bind-group + sampler + BGL caches, scene-FB allocation, `_scenePipelineFormatGeneration` HDR-toggle counter (read by **23 files**, verified). | **Beta** | File is past the 1000-line CLAUDE.md threshold by 4×. WebGL-compat stub install + ContextLimits init + default-texture creation paths still live inside instead of being extracted. | Decompose into 3-4 companion files; expand cache-clear walk to include per-object caches (`C-R12-PER-OBJECT-CACHES`). |
| **WebGPURenderPipelineCache** ([WebGPURenderPipelineCache.ts](../../../packages/engine/Source/Renderer/WebGPU/WebGPURenderPipelineCache.ts), 657 lines) | **Beta** | `clear()` exists, `remove(descriptor, variant)` exists, but **no LRU eviction or size cap** (verified by reading `:600–628`). Long sessions accumulate pipelines monotonically. `getStats()` returns hits/misses/created/size — observability is good. | Add bounded-LRU. |
| **WebGPUComputePipelineCache** | Beta | Landed Batch 76, paired with shader-module dedupe sweeps Batches 72–74. AutoExposure not yet routed through it. | Route AutoExposure. |
| **WebGPUShaderModuleCache + WebGPUShaderDefines + WebGPUShaderPreprocessor** ([WebGPUShaderModuleCache.ts](../../../packages/engine/Source/Renderer/WebGPU/WebGPUShaderModuleCache.ts), 132 lines) | **Beta** | Tier-1 dedupe by `(sourceId, defines)` Uint32 key. **6 prewarm callers** (verified): `WebGPUBillboardRenderer`, `WebGPUGlobeSurfaceRenderer`, `WebGPULabelRenderer`, `WebGPUPointPrimitiveRenderer`, `WebGPUPolylineRenderer`, `WebGPUShaderModuleCache` itself. ModelRenderer does not prewarm — first-render-of-glTF stutter remains until KHR variant strategy lands. | Prewarm Cloud / Voxel / VolumetricFog / PointCloud. |
| **WebGPUDeviceLossRecovery** ([WebGPUDeviceLossRecovery.ts](../../../packages/engine/Source/Renderer/WebGPU/WebGPUDeviceLossRecovery.ts), 331 lines) | **Beta** | 3-state machine (`HEALTHY`/`RECOVERING`/`FATAL`), exponential backoff retry, callback registry, `dispose()` race-handling for destroy-during-recovery. Subscriber walk + scene-renderer-level `_ensureResources` rebuild on next frame. | Per-object caches not on the cache-clear walk (`C-R12-PER-OBJECT-CACHES`). |
| **WebGPURingBufferAllocator + WebGPUStorageBufferPool + WebGPUSharedResourcePool + WebGPUResourceManager** | Beta | Triple-buffered ring; power-of-2 buckets; `mapAsync` hazards guarded with try/catch (Batch 26 H-P5). | None blocking. |
| **WebGPUDrawCommand / WebGPUDerivedCommand / WebGPUComputeCommand / RenderCommand.js** ([RenderCommand.js](../../../packages/engine/Source/Renderer/WebGPU/RenderCommand.js)) | Alpha | `RenderCommand` adopted in **3 Scene files** (`ClassificationPrimitive.js`, `GroundPrimitive.js`, `QuadtreePrimitive.js`); **24 Scene files still construct `DrawCommand` directly**. | Either commit to migration sweep or deprecate and document `DrawCommand` as the official API. Carrying both paths is the worst outcome. |
| **WebGPUEffectsBindGroup** ([WebGPUEffectsBindGroup.js](../../../packages/engine/Source/Renderer/WebGPU/WebGPUEffectsBindGroup.js), 1471 lines) — unified shadow + clipping + atmosphere + CSM + point-light + edge-detection BGL | Beta | UBO grew 240 → 272 → 304 → 336 bytes across batches. C-R11-EFFECTS-BGL-COLLECTION-CACHE per-tile cache shipped Batch 55 (was ~24k allocations/sec). | None pending. |
| **WebGPUBindGroupCache + WebGPUBindGroupReflection + WebGPUBindGroupLayoutHelpers** | Beta | 86/88 call sites migrated to typed-entry helpers (Session 30). | None blocking. |
| **WebGPUFramebufferManager + WebGPUSceneFramebuffer + WebGPURenderTarget + WebGPUMultisampleFramebuffer + WebGPUHDRRenderTarget** | Beta | HDR pipeline-cache invalidation + readback ring shipped Batch 110; toggle gate fixed Batch 109. Verified by `Tools/visual-regression/verify-initial-hdr.mjs`. | None pending. |
| **WebGPUOIT** (Weighted Blended OIT, McGuire & Bavoil 2013) | Beta | MRT accumulation + revealage; dual-source-blend single-pass when available. Pick path doesn't write through OIT (`C-R9-MODEL-PICK-TRANSLUCENT`, DEFERRED_WORK). | OIT pick path (2 sessions). |

---

## Category: Build infrastructure / variants

| Feature | Status | Notes | Remaining work |
|---|---|---|---|
| Three build variants (`dual` / `webgl-only` / `webgpu-only`) via [`scripts/bundleVariantPlugin.js`](../../../scripts/bundleVariantPlugin.js) | Beta | esbuild `onResolve` redirects WebGPU files → `emptyModule.js` Proxy stub or GLSL files → `emptyShader.js` empty-string. ESM code splitting on dual. `WEBGPU_COMPAT_EXEMPTIONS` list = 4 entries (`WebGLCompatibilityStub`, `WebGPUShaderTranslator`, `WebGLStubPipelineExtractor`, `WebGPUNagaTranspiler`) per CLAUDE.md. Sizes documented in CLAUDE.md: dual 7.1 MB, webgl-only 5.6 MB, webgpu-only 6.4 MB. | Webgpu-only delta is small (10%) because Scene static-imports `Context.js` and pulls the WebGL backend. Closing the gap is "BUILD-VAR-MEASURE / SCENE-AUDIT" — multi-day refactor. |
| `Tools/variant-smoke-test.mjs` | Beta | Reliable as of Session 35. Edge channel only. | None. |
| `Tools/visual-regression/capture-and-diff.mjs` + 30+ verify scripts | Feature-Complete | Edge-only (Playwright Firefox lacks WebGPU). | None. |
| `scripts/build.js` `stripPragmaPlugin` (`.js` + `.ts`) | Feature-Complete | Discipline check periodically catches lapses; one was fixed inline during prior audit (`WebGPUGlobeSurfaceRenderer.ts:1265–1310`). | Discipline only. |

---

## Category: Per-feature renderers (the 45-key registry)

| FR (key) | Status | Major issues / integration concerns | Remaining work |
|---|---|---|---|
| **GLOBE_SURFACE** (12) — [WebGPUGlobeSurfaceRenderer.ts](../../../packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts) **3933 lines** | **Beta** | Quantized + uncompressed terrain, multi-pass for >4 imagery layers, water mask, day/night, fog/atmosphere/Lambert, hardware clip distances (Phase 5 WGF-1), Hi-Z occlusion wiring, central pipeline cache routed Batch 75. 16-imagery-layer cap closed Batch 58. C-R10-POINT-LIGHT-RECEIVE-GLOBE shipped Batch 108. C-R1-GLOBE-RENDERSTATE per-tile cull mode partial (Batch 99). Bricky-tile UV-debug threshold fix Batch 94. Canvas-black-screen ROOT CAUSE FIX Batch 93. | Decompose into 3-4 files (highest ROI single refactor); aerial-perspective LUT consumers in primitives (FEAT-GAP-09). |
| **MODEL** (14) — [WebGPUModelRenderer.js](../../packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.js) **2296 lines** | **Alpha** | Full PBR (MR + SG + Unlit), all alpha modes, double-sided, vertex colors, normal mapping, model-space RTE, skinning, GPU instancing, morph targets, IBL factor + SH uploads, scene `light.color` honored, KHR_mesh_quantization, KHR_texture_transform (Batch 90), KHR_materials_* factor-level (Batch 95), bind-group restructure for 6 KHR textures (Batch 102), secondary textures (Batch 103), transmission MRT capture (Batch 107). KHR support lives **inside `ModelPBRComplete.wgsl`** as bit-flagged paths (`FLAG_HAS_CLEARCOAT/SPECULAR_EXT/ANISOTROPY/IRIDESCENCE/SHEEN/VOLUME/TRANSMISSION` bits 19–25). Six full extension shader bodies still incomplete; `KHR_texture_transform` is in nearly every modern glTF asset. | Full per-extension shader bodies (clearcoat/sheen/anisotropy/iridescence/volume); `C-R9-MODEL-FEATURE-PICK` (DEFERRED_WORK); `C-R9-MODEL-PICK-TRANSLUCENT` (OIT pick); ModelRenderer adoption of central pipeline + module caches (gated on KHR variant strategy). |
| **GLOBE_TRANSLUCENCY** (13) | Alpha | Pipeline variants generated; correctness path is shared with GLOBE_SURFACE. | Stencil-based selection paths still local to GlobeSurface; not yet integrated with depth-sample classifier. |
| **PRIMITIVE** (4) — [WebGPUPrimitiveCommands.js](../../packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js) 2456 lines, 50 Primitive WGSL shaders | Beta | PrimitiveBasicColor + PrimitiveBasicTexturedColor + 19 Material × Lit + 19 × Flat variants + PBR Simple/Textured + Phong Color/TexturedColor. CPU compressed-vertex decode for normal/st/tangent/bitangent (DP-H19). C-R1-PRIMITIVE-DERIVED derived commands don't get variant key. | Runtime compressed-vertex flip; primitive-derived renderState fan-out. |
| **SHADOW_MAP** (10) — [WebGPUShadowMapRenderer.js](../../../packages/engine/Source/Renderer/WebGPU/WebGPUShadowMapRenderer.js) 1463 lines | Beta | Single-shadow-map cast + receive. 7 cast variants registered. RTE precision shipped (CSM-33-1 fix). 5-tap PCF soft point-light shadows (Batch 63). | VSM/ESM/PCSS deferred (Phase 8d). |
| **CSM** (no key — owned by SCENE_RENDERER) — [WebGPUCSMRenderer.ts](../../../packages/engine/Source/Renderer/WebGPU/WebGPUCSMRenderer.ts) 1375 lines | Beta | 4-cascade selection, RTE-precise cascade VPs, per-cascade slope-scaled depth bias, texel-snap stabilization. All 7 cast variants unlocked. PrimitivePhong + ModelPBRComplete + globe terrain receive (Slices 1–2c). 19 Mat-Lit shaders wired Batch 92. Toggle defaults off (`scene.useCascadedShadowMaps = false`). | Slices 3 + 4 (altitude-adaptive splits, moon dual-light, VSM, 3D Tiles per-tile cascade). |
| **TAA** — [WebGPUTAAEffect.ts](../../../packages/engine/Source/Renderer/WebGPU/WebGPUTAAEffect.ts) 656 lines (lives in post-process collection, not its own FR slot) | **Alpha** | Halton (2,3) jitter, history ping-pong, depth-based motion-vector reprojection in eye-relative space, neighborhood AABB clamp. Slice 1 RTE motion vectors (Session 34); Slice 2b strengthened disocclusion (Batch 91); Slice 2c per-model previousModelMatrix plumbing (Batch 96, partial); Slice 2d MRT motion-vector infrastructure (Batch 104); Slice 2e model velocity output + dedicated velocity pass (Batch 106). UBO is 256 bytes with `historyValid` flag for first-frame suppression. Toggle defaults off (`scene.taaEnabled = false`). | Large-camera-jump history invalidation; 3D Tiles pop-in NaN motion; picking un-jitter; CSM+TAA verification (Slice 4). |
| **POST_PROCESS_COLLECTION** (26) — [WebGPUPostProcessPipeline.ts](../../../packages/engine/Source/Renderer/WebGPU/WebGPUPostProcessPipeline.ts) 1200 + [WebGPUPostProcessEffects.ts](../../../packages/engine/Source/Renderer/WebGPU/WebGPUPostProcessEffects.ts) 1487 + 35 PostProcess WGSL shaders | Beta | Bloom, AO (SSAO + GTAO), DoF, ColorGrading, 5-operator Tonemapping (Reinhard, ACES, Filmic, ModifiedReinhard, PBRNeutral) + f16 variant (with auto-fallback to f32 — verified at `WebGPUPostProcessPipeline.ts:1069–1094`), FXAA, NightVision, BlackAndWhite, Brightness, ContrastBias, GodRays, LensFlare, Silhouette, ToonEdge, GaussianBlur. HDR pipeline correctness end-to-end (Batch 110). | None pending — feature-complete vs WebGL post-process surface. Per-stage bind-group caching missing (per-frame `createBindGroup` call). |
| **SUN** (5) + **MOON** (6) — [WebGPUEnvironmentRenderer.js](../../../packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js) 1199 lines | Beta | Sun procedural billboard, Moon textured ellipsoid. Routes through central pipeline cache + shader-module dedup (Batch 74). | None blocking. |
| **SKY_ATMOSPHERE** (7) — `WebGPUSkyAtmosphereRenderer.js` | Beta | Nishita scattering on ellipsoid shell. RTE compliance fixed Batch 2. | None pending. |
| **CUBE_MAP_PANORAMA** (9) | Beta | Last orphan `console.log` fixed Session 37. | None pending. |
| **FOG** (8) — slot retained, registration removed Session 37 | N/A | Classic fog ships via globe-terrain UB pipeline; FR wrapper was a strict subset of inputs. | None — superseded. |
| **GROUND_ATMOSPHERE** (29) | Beta | Nishita parameters into globe terrain shader. Aerial-perspective LUT consumer landed in `PrimitivePhongTexturedColor`; 6 more shaders need ~20-line edits each (FEAT-GAP-09). | Per-shader LUT rollout. |
| **PROCEDURAL_CLOUDS** (32) | Beta | Volumetric ray-march via `globe.showProceduralClouds`. Routes through central pipeline cache (Batch 72). | None pending. |
| **WEATHER_PARTICLES** (31) — [WebGPUWeatherRenderer.ts](../../../packages/engine/Source/Renderer/WebGPU/WebGPUWeatherRenderer.ts) | Beta | GPU compute-driven rain/snow/fog/hail. Both compute and render shader sources go through module cache + central pipelines (Batches 72/76). | None blocking. |
| **VOLUMETRIC_FOG** (37) — [WebGPUVolumetricFogRenderer.ts](../../../packages/engine/Source/Renderer/WebGPU/WebGPUVolumetricFogRenderer.ts) 1352 lines | **Beta** *(CORRECTION — DOC IS STALE)* | The TS file's docstring claims "Phase 5a contract — no visual change" but [VolumetricFog.wgsl](../../../packages/engine/Source/Shaders/WebGPU/Compute/VolumetricFog.wgsl) (485 lines) ships real Phase 5b kernels: height fog, HG sun+moon scattering, sun shadow occlusion (Phase 5c), 3-octave FBM noise (Phase 5d), C-P7-RTE altitude reconstruction. The CLAUDE.md "Dead Code Audit" rule cited this file as an example of scaffolding-not-yet-filled-in; the example is now wrong — the kernels ARE filled in. | Update the renderer docstring to match reality. Validate against real volumetric scenes. |
| **CLOUD_COLLECTION** (3) | Beta | Procedural cumulus billboards with noise. | None pending. |
| **BILLBOARD_COLLECTION** (0), **POINT_PRIMITIVE_COLLECTION** (1), **POLYLINE_COLLECTION** (2), **LABEL_COLLECTION** (36) | Beta | Atlas placeholder bug fixed Batch 3 (B-6). All four share the C-R1-COLLECTIONS-PER-ENCODER gap — collection-level renderState not routed; custom blend constants ignored. | Per-encoder state pass (1 session). |
| **GROUND_PRIMITIVE** (11) | Beta | Migration Sessions 1–5 (Batches 80–85): depth-sample classifier per ADR-2026-04-28; runtime depth-source swap; per-frustum bind groups; stencil pipelines retired Batch 85. | Translucent-on-translucent and PointCloud translucent classification require continued depth-source coverage (`C-R8-CLASSIFICATION-DEPTH-SAMPLING`, 3–4 sessions). |
| **GROUND_POLYLINE** (41) — [WebGPUGroundPolylineRenderer.js](../../../packages/engine/Source/Renderer/WebGPU/WebGPUGroundPolylineRenderer.js) **2752 lines** | **Alpha** | Full WGSL VS/FS port of `PolylineShadowVolumeVS/FS.glsl`. Storage-buffer instances + Arrow / Stripe / Image materials Batch 88; Checkerboard + CUSTOM material fallbacks Batch 97; depth-test + color decoding fixes Batch 116. **Polylines on terrain are not visible on WebGPU even though renderer dispatches commands.** No crash, no validation warnings. Reproduces via `Tools/visual-regression/verify-ground-polyline-zoom.mjs`. Bisected: VS extrusion bug — `widthMeters / dot(normalEC0, rightPlaneNormalEC)` blows past far plane at miter joints. | 1-session focused VS bisection (compare against RenderDoc capture of WebGL VS). |
| **VECTOR_3DTILE_PRIMITIVE** (42) | Alpha | Extruded polygon classification (building footprints, admin boundaries) — Batch 112. Per-feature pick wired Batch 115. | Wireframe debug mode; per-fragment normal-from-depth-derivative; textured appearance (DEFERRED_WORK:344–348). |
| **VECTOR_3DTILE_POLYLINE** (43) | Alpha | Non-clamped 3D polylines — Batch 112-113. | Same as above. |
| **VECTOR_3DTILE_CLAMPED_POLYLINE** (44) | Beta | Terrain-clamped polylines, 7-attribute interleaved 96-byte stream — Batch 114. Per-feature pick Batch 115. | Distinct depth source per pass (TERRAIN reads globe-depth-only; 3D-TILE reads packed-translucent) — currently simplified. |
| **INVERT_CLASSIFICATION** (20) | Beta | Stencil-EQ/NEQ pipelines, MSAA-aware classified texture (Batches 38–41). | None pending. |
| **GAUSSIAN_SPLAT** (16) | Alpha | Routes through central pipeline cache (Batch 56). Scene-level sort is the consumer; splats now read `_sortedIndices`. | Confirm sort-output read path stable across all `_indices` shapes. |
| **POINT_CLOUD** (17) — [WebGPUPointCloudRenderer.ts](../../../packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudRenderer.ts) 1111 lines | Beta | Instanced quads, RTE positions, size attenuation, optional normal-based lighting. EDL via WebGPUPointCloudEyeDomeLighting. LOD via WebGPUPointCloudLODProcessor + DecoupledScan optional path. | PointCloud translucent classification still broken pending C-R8-CLASSIFICATION-DEPTH-SAMPLING. |
| **POINT_CLOUD_EDL** (18) | Beta | Eye Dome Lighting via post-process stack. | None pending. |
| **VOXEL_PRIMITIVE** (19) | Alpha | Pick (Batch 53), `discard` + `return` paired for Naga (NEW-4-E Batch 68), `textureSampleLevel` for non-uniform CF (NEW-4-G Batch 69). Texture3D constructor dispatches to WebGPU (NEW-4-D Batch 67). UniformState.cameraPosition getter (NEW-4-H Batch 70). | `C-R9-VOXEL-CELL-PICK` (coords don't fit in 4-byte pickColor). Megatexture upload paths need verification with real provider data. |
| **ELLIPSOID_PRIMITIVE** (15) | Beta | Routes through central pipeline cache (Batch 56). | None pending. |
| **BUFFER_POINT_COLLECTION** (33), **BUFFER_POLYLINE_COLLECTION** (34), **BUFFER_POLYGON_COLLECTION** (35) — [WebGPUBufferPrimitiveRenderer.ts](../../../packages/engine/Source/Renderer/WebGPU/WebGPUBufferPrimitiveRenderer.ts) 1657 lines | Beta | v1.140 vector tile primitives. Routes through central cache. | Minor cleanup. |
| **CLIPPING_PLANES** (24) | Beta | RGBA32Float texture; per-tile cache shipped Batch 55. | None pending. |
| **CLIPPING_POLYGONS** (25) | Beta | `PolygonSignedDistance.wgsl` compute shader for SDF generation. | None pending. |
| **BRDF_LUT** (21) + **IMAGE_BASED_LIGHTING** (22) + **DYNAMIC_ENVIRONMENT_MAP** (23) | Beta | SH L2 + irradiance cubemap + radiance prefilter (`IrradianceConvolution.wgsl`, `RadiancePrefilter.wgsl`). Default specular cubemap fallback (1×1 black). | Validate `shouldUpdate` cadence under camera motion. |
| **SCREEN_SPACE_REFLECTIONS** (30) — [WebGPUSSREffect.ts](../../../packages/engine/Source/Renderer/WebGPU/WebGPUSSREffect.ts) | **Started** | Pipeline + bind-group + uniforms wired. **`WebGPUSceneRenderer.ts:2774` passes `undefined, // normalTextureView — uses placeholder`** — verified. The renderer's `ensureNormalTexture` allocates a placeholder texture that nothing writes to, so SSR samples uninitialized normals → noise. Gated on Phase-8a Foundation (normal G-buffer + depth prepass). | Normal G-buffer + ray-march path (FEAT-GAP-01). |
| **HI_Z_OCCLUSION** (38) — [Scene/OcclusionCulling.js](../../../packages/engine/Source/Scene/OcclusionCulling.js) + WebGPUHiZOcclusionDispatcher.ts 976 lines | **Alpha** | Pyramid build + occlusion test compute pipelines exist; `Scene/OcclusionCulling.js:8–19` documents the per-frame lifecycle (reproject → buildPyramid → testOcclusion → readResults → split commands). Gated by `enabled = false` default; auto-disables when occluded fraction < 0.2. Module is tagged "WebGPU only — requires compute shaders, storage buffers, and texture_storage_2d. No WebGL equivalent exists." | Activate consumer path (Scene depth-texture wire-in into `buildHiZPyramid`); JS fallback authoritative until then. |
| **GPU_SORT_KEYS** (39) | Alpha | `RenderScheduler` still uses JS multi-level comparator for the common <50K case — encoder→submit→readback round trip dominates for small command counts. | Activate in >50K-draw scenes; not on critical path. |
| **POINT_CLOUD_SORT** (40) | Alpha | Bitonic sort. Gated by `WasmPointCloudBridge.useGPUSort` (default false). | Indirect-draw consumer wiring. |
| **IMAGERY_REPROJECTION** (28) | Beta | Web Mercator → Geographic via fragment shader (simpler than WebGL's 64-row vertex grid). | None pending. |
| **SCENE_RENDERER** (27) — [WebGPUSceneRenderer.ts](../../../packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts) **3626 lines** | **Beta** | Multi-frustum command execution, OIT composite, GlobeDepth, DepthPlane, post-process orchestration, `selectCommandVariant` dispatcher, derived-command routing. | Decompose into 5+ companion files (frustum loop, pick pass, refraction capture, velocity pass, edge composite). |

---

## Category: Shadows / lighting

| Feature | Status | Notes | Remaining |
|---|---|---|---|
| Single shadow map cast + receive | Beta | RTE-correct, all 7 cast variants. | None. |
| CSM (cascaded shadow maps) | Beta | Slices 1 + 2 shipped. Toggle off by default. | Slices 3-4 (altitude-adaptive, moon dual-light, VSM, per-tile cascade). |
| Point-light shadows | Beta | Cast (Batch 34); FS receive (Batch 57); 5-tap PCF soft (Batch 63); globe terrain receive (Batch 108). | C-R10-CAST-LINEAR-DEPTH micro-opt (DEFERRED_WORK:421). |

---

## Category: 3D Tiles / vector tiles / classification

| Feature | Status | Notes |
|---|---|---|
| Translucent tile classification | Beta | Selective depth-write fix Batch 79 covers Models. PointCloud translucent still mis-classifies (DEFERRED_WORK:225). Multi-frustum single-frustum only (paused → folded into ADR migration Session 3). |
| Vector 3D Tile family (Batches 112-115) | Alpha→Beta | All three FRs ship; per-feature pick wired Batch 115. |
| Vector tile clamped polylines | Beta | Same as above. |
| 3D Tiles `Cesium3DTileBatchTable` per-feature renderState | Alpha | C-R1-TILE-BATCH plumbing partial (Batches 100-101). |
| Edge visibility (`EXT_mesh_primitive_edge_visibility`) | Beta | Inline `applyEdgeOverlay()` in ModelPBRComplete.wgsl (Batch 48); 16-bit feature ID (Batch 49); 65535-feature ceiling. |

---

## Category: Picking

| Feature | Status | Notes |
|---|---|---|
| Pick infrastructure | Beta | Discriminated `getPickResult(color) → { target, kind }`; 16-member `PickKind` union; 20 internal registrar call sites wired (Session 30). 5 missing pick paths shipped Batches 30/31/53/54: Ellipsoid, Ground, Splat, Voxel, Model. WebGPUPickCommandHelpers extracted Batch 59. |
| Per-feature pick on 3D Tiles models | **Started** | `C-R9-MODEL-FEATURE-PICK` deferred. |
| Per-cell pick on voxels | Started | `C-R9-VOXEL-CELL-PICK` deferred. |
| OIT-translucent pick | Started | `C-R9-MODEL-PICK-TRANSLUCENT` deferred. |
| Vector 3DTile per-feature pick | Beta | Wired Batch 115. |

---

## Category: Multi-context / backend agnosticism

| Feature | Status | Notes |
|---|---|---|
| `GraphicsContext` abstract base + `Context.js`/`WebGPUContext.ts` | Feature-Complete | TS enforces parity; co-located `.d.ts` for JS interop (15 files). Backend agnosticism: zero static imports from `Scene/` → `Renderer/WebGPU/` (verified by Grep — no matches). |
| Multi-context + split-screen | Beta | Split-screen device-mismatch fix; URL `Apps/WebGPUTest/split-screen-comparison.html`. |
| Feature Renderer pattern | Beta | 45 enum slots; add-only discipline (FOG slot retained when registration removed). One add-only violation in history: slot 33 was `DEFERRED_GBUFFER` and was removed with subsequent slots renumbered — see `FeatureRendererKey.js:152–157` — but the comment owns it explicitly. |
| `RenderCommand.js` backend-agnostic command | **Alpha** | Adopted in 3 Scene files vs. 24 still constructing `DrawCommand`. Migration stalled. |
| Scene-logic-extractor pattern | Beta | Used heavily in collection renderers. |

---

## Category: Compute / WASM / dispatchers

| Feature | Status | Notes |
|---|---|---|
| `WebGPUComputeEngine` | Beta | Used by AutoExposure, IBL convolution, occlusion culling, sort. |
| `WebGPUAutoExposure` | Beta | Two-pass compute, temporal smoothing. Not on central compute pipeline cache yet. |
| `WebGPUDecoupledScan` (Merrill & Garland 2016) | Beta | First consumer `WebGPUPointCloudLODProcessor` (Session 35). Opt-in via `useDeterministicPointCloudLOD: true`. Atomic-add stays default. |
| `WebGPUGPUCuller` + `WebGPUHiZOcclusionDispatcher` + WGSL kernels | Alpha | Hi-Z infrastructure exists; consumer side missing. |
| `WebGPUNagaTranspiler` + `packages/wasm-naga/` | **Started** | Lazy-load infrastructure scaffolded; STUB-NAGA follow-up (BACKLOG:143). |
| `WebGPUDevicePool`, `WebGPUSync`, `WebGPUSubgroupUtils`, `WebGPUF16Utils` | Beta | Phase 5 modern features (subgroup, f16, hardware clip distances) wired. |

---

## Category: 64-bit RTE precision discipline

| Feature | Status | Notes |
|---|---|---|
| `WebGPURTEAssertions` (Phase 5 WGF-4) | Beta | Always on in debug builds (pragma-guarded). |
| `previousViewProjection` slot in every renderer's `CameraUniforms` (DP-H41-ALL-RENDERERS, Batch 27) | Feature-Complete | Across 63 WGSL shaders. |
| GlobeTerrain SCENE3D RTE (C-P2 Batch 4 — split center3D high/low) | Feature-Complete | Sub-meter precision verified. |
| SkyAtmosphere RTE (C-P3 Batch 2) | Feature-Complete | No `posHigh + posLow` reconstruction. |
| CSM RTE (Slice 1, Session 33) | Feature-Complete | Earth-scale identity max diff 3.3e-17. |
| TAA motion-vectors RTE (Slice 1, Session 34) | Feature-Complete | Depth reprojection in eye-relative space; FP64 cameraDelta on CPU. |

---

## Category: Debug / tooling

| Feature | Status | Notes |
|---|---|---|
| `CesiumDebug.*` console commands (`snapshot`, `showDepth`, `showWireframe`, `showFrustums`, `showCommands`, `toggleFPS`, `pipelineStatus`, `postProcess`, `canvasPixels`, `logImageryProbe` + direct `scene`/`context`/`device`) | Feature-Complete | Documented in CLAUDE.md. |
| `WebGPUDebugDepthOverlay` + `WebGPUDebugFrustumOverlay` | Beta | Wired through debug commands. |
| `WebGPUTimestampProfiler` + `WebGPUPerformanceManager` | Beta | `ProfilingResults` / `PassTimingResult` extend `DebugStatsObject`. |

---

## Cross-cutting issues (verified)

1. **Central pipeline cache half-adopted** — most renderers route through `webgpuPipelineCache`. ModelRenderer keeps its own `WebGPUModelPipelineCache.js` (1138 lines) until material-family variant strategy lands. AutoExposure not yet on the compute cache.
2. **Shader-module dedup partial** — ModelRenderer doesn't dedupe across two materials with identical settings.
3. **Classification architecture migration in flight** — ADR-2026-04-28 pivots from stencil 2-pass to depth-sampling. Sessions 1–5 shipped (Batches 80–85). Translucent-on-translucent and PointCloud translucent classification gated on `C-R8-CLASSIFICATION-DEPTH-SAMPLING`. The Batch 47 composite scaffolding (`_classificationColorTexture`, `composite()`, `_compositePipeline`) is intentionally retained per CLAUDE.md "Dead Code Audit" — DO NOT remove.
4. **`renderState` fan-out incomplete** — 5 distinct C-R1 sub-items (CLASSIFICATION, COLLECTIONS-PER-ENCODER, GLOBE-RENDERSTATE, PRIMITIVE-DERIVED, TILE-BATCH).
5. **glTF KHR-extension multi-week workstream** — factor-level support shipped (Batch 95); full per-extension shader bodies for clearcoat / sheen / anisotropy / iridescence / volume still incomplete.
6. **TAA Slices 2c–4 partial** — history invalidation on large camera jumps NOT wired; skinned/morphed/instanced still rough; 3D Tiles pop-in NaN motion.
7. **Hi-Z occlusion / GPU sort dormant** — both dispatchers exist; consumer integration absent.
8. **Dead-code audit hazard** — `WebGPUTranslucentTileClassification` Batch 47 scaffolding, `WebGPUSSREffect` uninitialized normal G-buffer, *formerly* `WebGPUVolumetricFogRenderer` (now real Phase 5b kernels — docstring stale).
9. **Spec debt from ES6 modernization** — IonResourceSpec + 5 ImageryProvider specs fail with "Class constructor X cannot be invoked without 'new'" (BACKLOG:108). Production code paths route through `new`.
10. **Pragma-discipline lapses periodic** — discipline rather than enforcement.
11. **Backend-agnosticism near-perfect but not absolute** — 15 real `Scene/` branches remain across 11 files; zero static imports.

---

## Top 10 highest-risk incomplete features

1. **C-R4-GLTF-KHR full-extension shader bodies** — KHR_texture_transform alone hits nearly every modern glTF; factor-level support landed but proper extension shaders (clearcoat / sheen / iridescence / volume) still partial. **Risk: visual fidelity degradation on real-world glTF assets that the Sandcastle baseline doesn't exercise.**
2. **C-R8-CLASSIFICATION-DEPTH-SAMPLING (3–4 sessions)** — without it, PointCloud / batched-primitive translucent tiles still mis-classify (only Model path got Batch 79's selective depth-write fix). **Risk: silent rendering errors in production tilesets.**
3. **GROUND_POLYLINE VS extrusion bug (`C-R8-GROUND-POLYLINE-NATIVE — PARTIAL`)** — polylines on terrain are not visible on WebGPU. No crash, no validation warnings. **Risk: silent missing rendering for a common GIS workflow.**
4. **`C-R9-MODEL-FEATURE-PICK`** — 3D Tiles per-feature interactivity (clicking single building in city tileset) doesn't work. Workaround via client-side feature-table decode is awkward.
5. **TAA history invalidation on large camera jumps** — `camera.flyTo` landings produce ghosting.
6. **WebGPUSSREffect normal G-buffer missing** — currently samples uninitialized placeholder normal texture → noise, not reflections. Verified at `WebGPUSceneRenderer.ts:2774`.
7. **Hi-Z occlusion culling consumer integration** — entire dispatcher + WGSL exists; Scene-side wiring missing. JS fallback authoritative.
8. **CSM Slice 4 (3D Tiles per-tile cascade culling, snapshot-freeze)** — toggle still defaults off.
9. **`C-R12-PER-OBJECT-CACHES`** — per-Model / per-Collection / per-Renderer caches not on the device-loss invalidation walk. Belt-and-suspenders safe today.
10. **`RenderCommand` half-migrated** — 3 Scene files vs. 24 — architectural debt.

---

## What is actually production-ready

Verified by code-reading, file presence, and cross-reference with batch commits:

- Globe surface rendering at planetary scale — RTE-precise, 16-imagery-layer cap, water mask, day/night, fog/atmosphere/Lambert, hardware clip distances, multi-pass for >4 layers, Hi-Z occlusion wiring, central pipeline cache routed (Batch 75).
- glTF Model rendering at primitive granularity — full PBR (MR + SG + Unlit), all alpha modes, double-sided, vertex colors, normal mapping, model-space RTE, skinning, GPU instancing, morph targets, IBL factor + SH uploads, scene `light.color` honored, KHR_mesh_quantization, KHR_texture_transform (Batch 90), KHR_materials_* factor-level (Batch 95).
- Single-shadow-map cast + receive — RTE-correct, all 7 cast variants registered, 5-tap PCF soft point-light shadows.
- CSM Slices 1 + 2 (cast variants + texel-snap + globe + phong + ModelPBRComplete + 19 Mat-Lit shaders) — RTE-precise, per-cascade slope-scaled bias.
- Post-processing pipeline — Bloom, AO, DoF, ColorGrading, 5-operator Tonemapping + f16 variant with auto-fallback, FXAA, NightVision, BlackAndWhite, Brightness, ContrastBias, GodRays, LensFlare, Silhouette, ToonEdge, GaussianBlur. HDR pipeline correctness end-to-end (Batch 110).
- Auto-exposure two-pass compute, temporal smoothing.
- Sky atmosphere + ground atmosphere — Nishita scattering, RTE-correct, pipeline-failure latched.
- Sun + Moon — procedural sun, textured ellipsoid moon.
- OIT (Weighted Blended) — McGuire & Bavoil 2013, dual-source-blend single-pass when available.
- 3D Tiles classification at common cases — Models on globe (Batch 79), terrain classification, vector tile classification family.
- Imagery rendering — Web Mercator → Geographic reprojection via fragment shader, 16-layer cap, water mask, day/night, all 5 missing per-layer uniforms (C-R5-IMAGERY-16 closed Batch 58).
- Clipping planes + clipping polygons (compute-shader SDF generation), invert classification (full 2-pass MSAA-aware, Batches 38–41), edge visibility.
- Cloud / weather / procedural cloud renderers — full GPU-driven simulation.
- **Volumetric fog** *(corrected — was misdocumented as scaffolding)* — real Phase 5b height-fog + HG sun/moon scattering + Phase 5c sun-shadow occlusion + Phase 5d FBM noise modulation, with C-P7-RTE altitude reconstruction.
- Picking infrastructure — discriminated `getPickResult(color) → { target, kind }` with 16-member `PickKind` union; all 5 missing pick paths shipped at primitive granularity.
- Build variants — three-bundle system with smoke test, pragma stripping (`.js` + `.ts`), `WEBGPU_COMPAT_EXEMPTIONS` for backend-neutral files.
- Visual regression testing — split-screen WebGL vs WebGPU pixel diffs, 30+ verification scripts, Edge-only Playwright harness.
- Debug tooling — `CesiumDebug.*` console commands, depth/wireframe/frustum/command overlays, FPS counter, pipeline-status diagnostics.
- Multi-context support — `ContextRegistry` static, per-context ID + rendererType, split-screen device-mismatch handling. Backend-agnosticism near-perfect (zero `Renderer/WebGPU/` imports from Scene/).
- 64-bit RTE precision — `WebGPURTEAssertions` debug-build round-trip checks, `previousViewProjection` slot in 63 WGSL shaders, GlobeTerrain SCENE3D split-center fix, SkyAtmosphere RTE fix, CSM RTE Slice 1, TAA depth-reprojection in eye-relative space.

**Caveat per CLAUDE.md "Dead Code Audit":** the Sandcastle baseline covers a narrow set of demos. Real-world usage will surface gaps in the C-R4 KHR extension surface, the Hi-Z consumer wiring, the SSR normal-G-buffer dependency, the TAA Slice 2-4 work, and the C-R8-CLASSIFICATION-DEPTH-SAMPLING architectural completion.
