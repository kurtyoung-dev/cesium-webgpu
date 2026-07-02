# PARITY TO 100% — WebGL → WebGPU Definitive Task List

> **BANNER: This document is the input to the `parity-to-100` execution workflow.**
> Work the tasks in tier order, respecting the dependency spine in the Critical Path section.
> Every row is actionable: real file paths + a named acceptance probe + an off-gate.

- **Current parity:** ~91% weighted / ~86% full-feature (per `WEBGPU_PARITY_REPORT_2026-06-30`, Batch 458 baseline).
- **Target:** 100% WebGL↔WebGPU feature parity.
- **Source of truth:** the 2026-06-30 parity report (Batch 459, commit `aaa4cd0b79`), **reconciled to Batch 463 HEAD** (`8c10431cbc`). Batches 459–463 closed the DP-H46 structural-metadata epic; three report items were already resolved earlier (Batches 298/317/318) and are moved to "Closed since the report" below.
- **How this was assembled:** eight code-grounded cluster analyses were deduplicated (voxel data path, model CustomShader WGSL, Point Cloud EDL, clipping planes, 2D/CV scene-mode, metadata remainder, Hi-Z/ellipsoid RTE, HDR/f16 post-process), reconciled against `git log` + live stubs, then ordered into effort/dependency tiers.

Remaining gap to 100% = **~7–9%**, dominated by the voxel data path (XL) and the scene-mode-morph pillar (M×5). The rest is a long tail of M/S ports plus f16 variants.

---

## Verification sweep (post-Batch-470) — the ACTUAL remaining fire-list

A read-only classification of every remaining item against live code (after several task-list premises turned out **stale** — actual parity is higher than the Batch-458 report). **Trust this over the tier tables below.**

**Confirmed-real gaps worth an implementation run (in value order):**

| ID | Effort | Why real | Testable? |
| --- | --- | --- | --- |
| `PARITY-HIZ-TILE-BOUNDING` | M | `SOABoundingSphereLayout.populate()` reads `.radius` off ANY boundingVolume, but OrientedBoundingBox has no `.radius` → NaN → occlusion test fails silently | Yes (dense tileset) |
| `PARITY-RTE-ELLIPSOID-AWARE` (FEAT-3DT2-03) | M | `WebGPUCSMRenderer.ts` L74-79 hardcodes WGS84 radii; `tileset._ellipsoid` never threaded → non-Earth tilesets wrong | Unit-testable; pixel-verify blocked on a Mars/Moon asset (ship WGS84-safe) |
| `PARITY-CUSTOM-SHADER-WGSL` | M/L | `WebGPUModelRenderer.js` L2539-2546 warns "customShader not supported"; GLSL is silently ignored (native-WGSL path unbuilt) | Yes |
| `VOXEL-DATA-PATH` | XL | `WebGPUVoxelRenderer.ts` L468-499 ray-marches a hardcoded 4×4×4 gradient; no megatexture/octree. Ship megatexture+octree first (no CustomShader/cell-pick dep) | Yes (local VoxelBox3DTiles) |
| `PARITY-POINT-SPRITE-SHAPE` | S | WebGPU round points (`PointPrimitiveColor.wgsl` soft-circle) vs WebGL square `gl_PointCoord` — but **target is ambiguous** (round arguably superior); decide match-vs-document before running | Yes |

**Deferred — NOT worth an implementation run:**

- ~~`PARITY-HDR-COLORGRADING-MATH` / `PARITY-HDR-FXAA-THRESHOLDS`~~ — **SHIPPED as `PARITY-HDR-PP-MATH`** (2026-07-01): the "untestable" premise was stale — `scene.useHDRCanvasOutput` + `highDynamicRange` DOES engage headless on Edge (canvas configures rgba16float + extended toneMapping). ColorGrading + FXAA now RUN under HDR with a Reinhard-compressed working space (`hdrMode` uniform; SDR path byte-identical, proved by `probe-hdr-pp-math.mjs` baseline pixel-compare). The old full-skip (`_skipSDRStagesForHDR`, now `_hdrOutputMode`) is gone; tonemap remains bypassed.
- `PARITY-BUFFERPOLYGON-OUTLINE` — **parity-neutral**: polygon outline is unimplemented on BOTH backends → a feature gap, not a WebGL↔WebGPU divergence.
- ~~`PARITY-EDGE-AUTHORED-SILHOUETTE-NORMALS`~~ — **SHIPPED as `EDGE-AUTHORED-SILHOUETTE-NORMALS`** (2026-07-02): `extractEdgeGeometry` now consumes the authored signed-byte accessor (WebGL-identical decode + sequential dedupe-order pair indexing; zero normals for out-of-range pairs); adjacency-derived normals remain the fallback only when the accessor is absent (byte-identical off-gate, proven old-vs-new). Probe: `probe-edge-authored-silhouette.mjs` (numeric + visual, PASS). The `probe-edge-degenerate.mjs` leaf was repaired in the same run (exit-2 sibling demand + stale 15-float stride) and is GREEN.
- **f16 post-process variants** (ColorGrading/FXAA/Bloom/AO/DoF/GodRays/SSR) — perf micro-opt; f32 is **already at visual parity**. ~2 weeks of hand-tuning for <1% delta. The feature-gate infra is done (Tonemapping f16 shipped). Defer post-100%.

**Already-done (stale premises — reconciled, no work needed):** ClassificationPrimitive standalone (B130, verified B469), standalone `Model.fromGltfAsync` pick (B470 probe), generic-`Primitive` clipping (not a Cesium feature).

*(The DP-H46 metadata follow-ups — multicomponent attrs / UINT16-32 packing / TEXTURE-sourced tables — were not reached by the sweep; classify before running.)*

---

## Closed since the report (do NOT re-open)

These were flagged in the 2026-06-30 report but are resolved at Batch 463 HEAD. Verify-only; no port work.

| Item | Resolved in | Commit | Verify probe |
| --- | --- | --- | --- |
| DP-H46 structural-metadata epic (a–d display read, e `scene.pickMetadata` producer, f Sandcastle demo + consolidated probe) | Batches 454–463 | `8c10431cbc` | `probe-dp46a-metadata.mjs`, `probe-dp46e-pick-metadata.mjs`, `probe-dp46f-metadata-demo.mjs` |
| EquirectangularPanorama cull-override (honors `renderState.cull.enabled:false`) | Batch 317 | `2ee9421571` | `probe-panorama-cull-override.mjs` |
| CSM globe terrain point-light shadow **receive** (cascade light-eye sign fix) | Batch 298 | `509168f10b` | `probe-csm-soft-shadow.mjs` (sub-check A) |
| GeoJsonPrimitive renderer + verification probe (mixed FeatureCollection, ERR_CAPACITY guards, pixel diff) | Batch 318 | `7a39ac9aea` | `probe-geojson-primitive.mjs` |

> Note: CSM globe cascade **resolution** (edge sharpness, `NEW-CSM-CASCADE-GROUND-FIT`) is a *separate* follow-up that is still open — see the by-design bucket (`BYDESIGN-CSM-GLOBE-RESOLUTION`). The projection **receive** bug is closed; the resolution polish is not.

---

## Tier 1 — S quick wins (small, mostly independent)

| ID | Title | Effort | Deps | Files | Acceptance probe | Off-gate |
| --- | --- | --- | --- | --- | --- | --- |
| PARITY-CLIP-PRIMITIVE-THREAD-BG | Thread `ClippingPlaneCollection` through primitive effects bind group | S | — | `WebGPU/WebGPUPrimitiveCommands.js` (L941–944 gap), `WebGPU/WebGPUEffectsBindGroup.js` | Unit test: `clipPlaneCount`+`clipPlaneEqHW` packed correctly when primitive has clippingPlanes | Placeholder (zero count, identity planes) when `clippingPlanes=null`; byte-identical to current no-op |
| PARITY-SCENE-MODE-BUFFER-INFRA | Shared CPU-reprojection helper for `Buffer*` 2D/CV position encoding | S | — | `WebGPU/WebGPUBufferPrimitiveRenderer.ts` (extract `projectPositionForMode` from `WebGPUPolylineRenderer` L176–195) | `probe-collections-2dcv-morph.mjs` extended with Buffer* | SCENE3D path byte-identical (no reprojection); gated by `frameState.mode` |
| ~~PARITY-EDGE-DEGENERATE-TRI-VERIFY~~ | **DONE (2026-07-02, discharged during `EDGE-AUTHORED-SILHOUETTE-NORMALS`)** — the probe was un-runnable at HEAD (exit-2 demanding a compiled `.js` sibling that no build emits since `noEmit`, and a stale pre-Batch-330 15-float stride made the normal scan read past the buffer → NaN). Repaired: esbuild-bundles the `.ts` emitter on the fly + 19-float stride. Exit 0, all 9 checks PASS (no NaN/Inf, unit-or-zero normals, WebGL degenerate-skip classification match, dot parity) | S | PARITY-EDGE-AUTHORED-SILHOUETTE-NORMALS | `Tools/visual-regression/probe-edge-degenerate.mjs` | `probe-edge-degenerate.mjs` exit 0 — PASS | No clipping/edge in default scene; behavior identical to WebGL when off |
| ~~PARITY-HDR-COLORGRADING-MATH~~ | **DONE (merged into `PARITY-HDR-PP-MATH`, 2026-07-01)** — ColorGrading runs under HDR canvas output in a Reinhard-compressed working space (`hdrMode` uniform; float idx 7) instead of being skipped | S | — | `ColorGrading.wgsl` + `ColorGrading_f16.wgsl`, `WebGPUPostProcessPipeline.ts` (`setHDROutputMode`) | `probe-hdr-pp-math.mjs` — PASS (stages run, tonemap bypassed, SDR baseline byte-identical) | SDR path byte-identical (probe-verified) |
| ~~PARITY-HDR-FXAA-THRESHOLDS~~ | **DONE (merged into `PARITY-HDR-PP-MATH`, 2026-07-01)** — FXAA edge-detection luma computed on Reinhard-compressed color under HDR (`hdrMode` uniform; FXAAUniforms float idx 2); color blends stay linear HDR | S | — | `FXAA.wgsl` + `FXAA_f16.wgsl`, `WebGPUPostProcessPipeline.ts` | `probe-hdr-pp-math.mjs` — PASS | SDR path byte-identical (probe-verified) |
| PARITY-F16-COLORGRADING-VARIANT | f16 variant for ColorGrading | S | — | `Shaders/WebGPU/PostProcess/ColorGrading.wgsl` → `ColorGrading_f16.wgsl` | `probe-colorgrading-f16.mjs` (new) — f16 on/off, sub-1% channel diff | f32 byte-identical; gate via `device.features.has('shader-f16')`, default f32 |
| PARITY-F16-FXAA-VARIANT | f16 variant for FXAA | S | — | `Shaders/WebGPU/PostProcess/FXAA.wgsl` → `FXAA_f16.wgsl` | `probe-fxaa-f16.mjs` (new) — aliased scene, edge-smooth parity | f32 byte-identical; device-feature gated |
| PARITY-PC-EDL-OFFSCREEN-FB | EDL: create/manage offscreen color+depth framebuffer | S | — | `WebGPU/WebGPUPointCloudEyeDomeLighting.ts` (no-op L29–46), `WebGPU/WebGPUFramebufferManager.ts` | `probe-pointcloud-edl-offscreen.mjs` (new) — FB allocated/resizes/released, no leaks | Skip allocation when `eyeDomeLighting=false`; OFF renders direct-to-main-FB, byte-identical |
| PARITY-PC-EDL-DEPTH-VARIANT | EDL: dual-output (color+packed-depth) WGSL shader variant | S | PARITY-PC-EDL-OFFSCREEN-FB | `WebGPU/WebGPUPointCloudRenderer.ts`, `Shaders/WebGPU/PointCloud/*.wgsl` | `probe-pointcloud-edl-depth-write.mjs` (new) — verify `@location(1)` packed depth round-trips | Depth variant only compiled when EDL on; cache has 1 entry OFF, 2 ON |
| PARITY-PC-EDL-CLEAR-COMMAND | EDL: clear command for offscreen FBO each frame | S | PARITY-PC-EDL-OFFSCREEN-FB | `WebGPU/WebGPUPointCloudEyeDomeLighting.ts` | `probe-pointcloud-edl-clear.mjs` (new) — no stale-FBO artifacts | Clear issued only when EDL on |
| PARITY-PC-EDL-RESOURCE-LIFECYCLE | EDL: cleanup + cache invalidation on toggle/resize | S | PARITY-PC-EDL-OFFSCREEN-FB | `WebGPU/WebGPUPointCloudEyeDomeLighting.ts` (destroy L48–52 stub), `WebGPU/WebGPUPointCloudRenderer.ts` | `probe-pointcloud-edl-cleanup.mjs` (new) — on/off/on, zero leaks | Cleanup guarded; only runs if EDL was allocated |
| PARITY-PC-EDL-LOG-DEPTH-INTEGRATION | EDL: log-depth encode/decode in depth-write + blend | S | PARITY-PC-EDL-DEPTH-VARIANT, PARITY-PC-EDL-BLEND-PASS | `Shaders/WebGPU/Advanced/PointCloudEDL.wgsl`, `WebGPU/WebGPUPointCloudRenderer.ts` | `probe-pointcloud-edl-logdepth.mjs` (new) — log on/off darkening identical | Transparent when log-depth off (linear path); byte-identical log ON vs OFF |
| PARITY-VOXEL-PROBE-VERIFY | Voxel data-path parity probe (color + cell-pick + metadata) | S | all 4 voxel core tasks | `Tools/visual-regression/probe-voxel-data-path.mjs` (new) | `probe-voxel-data-path.mjs` — 4 assertions pass, zero uncaptured errors | Skips gracefully if demo tileset unavailable; off-case = placeholder gradient |
| PARITY-CUSTOM-SHADER-PROBE | Model CustomShader WGSL probe vs WebGL baseline | S | PARITY-CUSTOM-SHADER-STAGE, -UNIFORMS-TEXTURES, -STRUCT-BRIDGE | `Tools/visual-regression/probe-custom-shader-wgsl-native.mjs` (new) | The probe IS the acceptance criterion — 0-px match at 3 angles | When CustomShader absent, standard PBR path (regression-free) |
| PARITY-CUSTOM-SHADER-DEMO | Sandcastle demo: native WGSL custom shaders on WebGPU models | S | PARITY-CUSTOM-SHADER-STRUCT-BRIDGE | `packages/sandcastle/gallery/webgpu-custom-shader-wgsl/{index.html,main.js,sandcastle.yaml,thumbnail.jpg}` (new-gallery format — NOT `Apps/Sandcastle2` which is build output) | Demo renders sin-wave deform + rim-light, `u_time`/`u_rimColor` update per frame; screenshot read | Uses new `wgsl*ShaderText` props; GLSL demos unaffected |

---

## Tier 2 — M (moderate ports; the bulk of the remaining gap)

| ID | Title | Effort | Deps | Files | Acceptance probe | Off-gate |
| --- | --- | --- | --- | --- | --- | --- |
| PARITY-GPRIM-CLASSIFY-STANDALONE | ClassificationPrimitive standalone WebGPU renderer path | M | — | `Scene/ClassificationPrimitive.js` (early-return L858–866; chain L480–507), `WebGPU/WebGPUFeatureRenderers.ts` (marker L172–174), `WebGPU/WebGPUGroundPrimitiveRenderer.js` | `probe-classification-primitive-webgpu.mjs` (new) — box+ellipsoid on tileset, pixel diff < threshold; Vector3DTile classifiers byte-identical | Opt-in; blank on WebGPU when off, matching WebGL no-op |
| PARITY-CLIP-PRIMITIVE-VS-PRODUCER | Wire clip-distance uniforms into primitive vertex shaders | M | PARITY-CLIP-PRIMITIVE-THREAD-BG | 8× `Shaders/WebGPU/Primitive/Primitive{BasicColor,PhongColor,BasicTexturedColor,PhongTexturedColor,PBRSimple,PBRTextured,MatColorFlat,MatColorLit}.wgsl` | `probe-clipping-planes-primitive.mjs` (new) — box + clippingPlanes vs WebGL | `clippingPlanes=null` default; no `clip_distances` written, byte-identical; verify per mode 2D/CV/3D |
| PARITY-CLIP-PICK-SHADER-COVERAGE | Add clip-distance support to pick shaders | S→M | PARITY-CLIP-PRIMITIVE-VS-PRODUCER, PARITY-CLIP-MODEL-VS-PRODUCER | 6× `Shaders/WebGPU/Primitive/PrimitivePick*.wgsl`, `Shaders/WebGPU/Model/ModelPBRComplete.wgsl` (`fragmentPickMain`) | Pick probe: click clipped geometry → `scene.pick()` undefined; non-clipped → succeeds | No clipping in default scene; pick identical to WebGL when `clippingPlanes=null` |
| PARITY-CLIP-MODEL-RENDERER-WIRING | Wire clipping-plane support into `WebGPUModelRenderer` | M | PARITY-CLIP-MODEL-VS-PRODUCER | `WebGPU/WebGPUModelRenderer.js` (zero clippingPlanes refs), `Shaders/WebGPU/Model/ModelPBRComplete.wgsl` (new `WebGPUModelClippingPlanesPipelineStage.js`) | `probe-clipping-planes-model.mjs` (new) — glTF + clippingPlanes vs WebGL | `Model.clippingPlanes=null` default; byte-identical when unset |
| PARITY-CLIP-MODEL-VS-PRODUCER | Implement clip-distance output in model vertex shader | M | PARITY-CLIP-MODEL-RENDERER-WIRING | `Shaders/WebGPU/Model/ModelPBRComplete.wgsl` (add `array<f32,8> clip_distances` to VertexOutput; `computeModelClipDistances`) | Visual probe from renderer-wiring task; HW clip rejects verts pre-raster | Empty clip_distances when disabled; byte-identical |
| PARITY-BUFFERPOINT-2DCV | BufferPointCollection 2D/CV/Morph | M | PARITY-SCENE-MODE-BUFFER-INFRA | `WebGPU/WebGPUBufferPointRenderer.ts`, `Shaders/WebGPU/Collections/BufferPointMaterial.wgsl` | `probe-buffer-point-2dcv.mjs` (new) — flip 2D→CV, ≤5px overlap, cyan ratio ±10% vs WebGL | SCENE3D byte-identical (2D attrs zero-filled); opt-in via `frameState.mode` |
| PARITY-BUFFERPOLYLINE-2DCV | BufferPolylineCollection 2D/CV/Morph | M | PARITY-SCENE-MODE-BUFFER-INFRA | `WebGPU/WebGPUBufferPolylineRenderer.ts`, `Shaders/WebGPU/Collections/BufferPolylineMaterial.wgsl` | `probe-buffer-polyline-2dcv.mjs` (new) — segment align ≤5px, cyan ±10% | SCENE3D byte-identical; gated by `frameState.mode` |
| PARITY-BUFFERPOLYGON-2DCV | BufferPolygonCollection 2D/CV/Morph | M | PARITY-SCENE-MODE-BUFFER-INFRA | `WebGPU/WebGPUBufferPolygonRenderer.ts`, `Shaders/WebGPU/Collections/BufferPolygonMaterial.wgsl` | `probe-bufferpolygon-2dcv.mjs` (exists) — CV/2D diffs drop to SCENE3D parity | SCENE3D byte-identical; gated by `frameState.mode` |
| PARITY-BUFFERPOLYGON-OUTLINE | BufferPolygonCollection outline rendering (missing both backends) | M | — | `WebGPU/WebGPUBufferPolygonRenderer.ts`, `Shaders/WebGPU/Collections/BufferPolygonMaterial.wgsl`, `Scene/BufferPolygon.js` | `probe-bufferpolygon-outline.mjs` (new) — outlineColor/Width vs WebGL (once WebGL ships) or document parity-neutral | Non-outline path byte-identical when outline undefined |
| PARITY-CUSTOM-SHADER-STAGE | Add `WebGPUCustomShaderWGSLPipelineStage` to model pipeline + cache | M | PARITY-CUSTOM-SHADER-TRANSPILE (design decision) | `Scene/Model/CustomShaderWGSLPipelineStage.js` (new), `WebGPU/WebGPUModelPipelineCache.js` (`_getOrCreateShaderModule`), `WebGPU/WebGPUModelRenderer.js` (warning L2539–2546), `Scene/Model/{Model,ModelRuntimePrimitive}.js` | `probe-custom-shader-wgsl-native.mjs` — native WGSL modifies material, 3+ angles | `wgsl*ShaderText=undefined` default (parity); byte-identical modules when absent (ifdef-gated) |
| PARITY-CUSTOM-SHADER-UNIFORMS-TEXTURES | Bind custom-shader uniforms + samplers into material BGL / separate group | M | PARITY-CUSTOM-SHADER-STAGE | `WebGPU/WebGPUModelPipelineCache.js` (KHR manifest L128–143), `WebGPU/WebGPUModelRenderer.js`, `WebGPU/WebGPUBindGroupLayoutHelpers.js` | `probe-custom-shader-wgsl-native.mjs` extended — `u_colorShift` VEC3 + `u_patternTexture` SAMPLER_2D | Custom BG null when absent; no extra material-BGL bindings; drawcommand array unaffected |
| PARITY-METADATA-MULTICOMPONENT-ATTRS | DP-H46b post-epic: multi-component ATTRIBUTE transport + audit | M | — | `WebGPU/WebGPUModelMetadata.js` (scalar-only L49–52), `WebGPU/WebGPUVertexArrayFacade.ts`, `Scene/Model/MetadataWGSLPipelineStage.js`, `Shaders/WebGPU/Model/ModelPBRComplete.wgsl`, `WebGPU/WebGPUModelPipelineCache.js` | `probe-dp46b-metadata.mjs` (new/extend) — vec3 property, all components byte-identical to WebGL | Gated on `model.renderMetadata` (default false, parity path) |
| PARITY-METADATA-UINT16-UINT32-PACKING | UINT16/UINT32 component channel-packing for property textures | M | — | `WebGPU/WebGPUModelMetadata.js`, `Scene/Model/MetadataWGSLPipelineStage.js`, `Scene/parseStructuralMetadata.js` | `probe-metadata-uint16-uint32.mjs` (new/extend dp46c) — round-trip, WebGL/WebGPU same quantized color | Gated on `model.renderMetadata`; no change to 8-bit path |
| PARITY-METADATA-TABLE-TEXTURE-SOURCES | TEXTURE-sourced + instance/implicit feature-ID property TABLES | M | — | `WebGPU/WebGPUModelMetadata.js`, `Scene/Model/MetadataWGSLPipelineStage.js`, `WebGPU/WebGPUModelRenderer.js` | New/extend probe — property-table w/ TEXTURE feature IDs, decoded color match | ATTRIBUTE feature-ID path unaffected; gated on `renderMetadata` |
| ~~PARITY-EDGE-AUTHORED-SILHOUETTE-NORMALS~~ | **DONE (`EDGE-AUTHORED-SILHOUETTE-NORMALS`, 2026-07-02)** — `extractEdgeGeometry` decodes the authored signed-byte accessor exactly like WebGL `generateEdgeFaceNormals` (map `2*((v+128)/255)-1`, normalize, (0,0,1) fallback) and indexes pairs by sequential dedupe-order silhouette numbering (WebGL `extractVisibleEdges` parity); out-of-range pairs → zero normals; adjacency derivation skipped when the accessor is present (WebGL never derives) and unchanged when absent. (NB the row's `WebGPUEdgeVisibilityBatch.ts` file ref was stale — no such file; the emitter is the only extraction path.) | M | — | `WebGPU/WebGPUEdgeVisibilityEmitter.ts` | `probe-edge-authored-silhouette.mjs` — PASS (numeric decode/indexing vs WebGL mirror + off-gate byte-identity old-vs-new + visual EDGES_ONLY parity on `EdgeVisibility.glb`, 0.00% orphan pixels both headings) | Falls back to derived normals when accessor absent (byte-identical, proven); edge display opt-in |
| PARITY-PC-EDL-HIJACK-COMMANDS | EDL: hijack point-cloud draw commands into offscreen FB w/ depth variant | M | PARITY-PC-EDL-OFFSCREEN-FB, PARITY-PC-EDL-DEPTH-VARIANT | `WebGPU/WebGPUPointCloudEyeDomeLighting.ts`, `WebGPU/WebGPUPointCloudRenderer.ts` | `probe-pointcloud-edl-depth-write.mjs` — each point's depth in attachment 1 | Hijacking skipped when EDL off; OFF renders to main FB |
| PARITY-PC-EDL-BLEND-PASS | EDL: wire blend post-process pass (`PointCloudEDL.wgsl` → main FB) | M | PARITY-PC-EDL-HIJACK-COMMANDS | `WebGPU/WebGPUPointCloudEyeDomeLighting.ts`, `Shaders/WebGPU/Advanced/PointCloudEDL.wgsl` (exists, disconnected) | `probe-pointcloud-edl-blend.mjs` (new) — darkened edges visible, no validation errors | Blend skipped when EDL off; OFF outputs unmodified scene |
| PARITY-PC-EDL-VISUAL-REGRESSION-PROBE | Comprehensive EDL parity probe (WebGL vs WebGPU) | M | PARITY-PC-EDL-BLEND-PASS | `Tools/visual-regression/probe-pointcloud-edl-parity.mjs` (new) | The probe IS the criterion — <0.5% pixel divergence, no warnings/errors, cleanup verified | Verifies OFF outputs identical (no EDL when disabled) |
| PARITY-F16-BLOOM-VARIANT | f16 variant for Bloom (BrightPass + Blur + Composite) | M | — | `Shaders/WebGPU/PostProcess/{BrightPass,BloomComposite,GaussianBlur1D}.wgsl` (+`_f16`), `WebGPU/WebGPUBloomEffect.ts` | `probe-bloom-f16.mjs` (new) — high-luminance scene, f16 on/off parity | f32 byte-identical; gate `device.features.has('shader-f16')` |
| PARITY-F16-AO-VARIANT | f16 variant for Ambient Occlusion (Generate + Blur + Modulate) | M | — | `Shaders/WebGPU/PostProcess/{AmbientOcclusionGenerate,AmbientOcclusionModulate,GaussianBlur1D}.wgsl` (+`_f16`), `WebGPU/WebGPUAmbientOcclusionEffect.ts` | `probe-ao-f16.mjs` (new) — occlusion parity f16 vs f32 | f32 byte-identical; device-feature gated |
| PARITY-F16-DOF-VARIANT | f16 variant for Depth-of-Field | M | — | `Shaders/WebGPU/PostProcess/{DepthOfField,GaussianBlur1D}.wgsl` (+`_f16`), `WebGPU/WebGPUDepthOfFieldEffect.ts` | `probe-dof-f16.mjs` (new) — blur quality parity | f32 byte-identical |
| PARITY-F16-GODRAYS-VARIANT | f16 variant for God Rays (radial blur + composite) | M | — | `Shaders/WebGPU/PostProcess/{GodRayGenerate,GodRayComposite}.wgsl` (+`_f16`), `WebGPU/WebGPUGodRayEffect.ts` | `probe-godrays-f16.mjs` (new) — ray coherence parity | f32 byte-identical |
| PARITY-F16-PIPELINE-WIRING | Wire f16 selection through post-process pipeline + effect classes | M | all PARITY-F16-*-VARIANT | `WebGPU/WebGPUPostProcessPipeline.ts` (template L57–61, 641–652), `WebGPU/WebGPUPostProcessStageCollection.ts`, `WebGPU/WebGPU{Bloom,AmbientOcclusion,DepthOfField,SSR,GodRay}Effect.ts` | Integration test — all effects f16 on/off, no SDR regression | Default f32 unless `shader-f16`; `scene.enablePostProcessF16` (default false) |
| PARITY-VOXEL-CUSTOM-SHADER-WGSL | CustomShader → WGSL injection for voxel metadata properties | M | PARITY-VOXEL-OCTREE-TRAVERSAL | `Scene/buildVoxelCustomShader.js`, `WebGPU/WebGPUVoxelRenderer.ts`, `Scene/VoxelRenderResources.js` | `probe-voxel-data-path.mjs` extended — scalar ramp + vec4 color match WebGL | CustomShader off by default → gray density placeholder (deterministic) |
| PARITY-VOXEL-CELL-PICK | Per-cell picking (3× u32 cell coords → out-of-band resolve buffer) | M | PARITY-VOXEL-OCTREE-TRAVERSAL | `WebGPU/WebGPUVoxelRenderer.ts` (`fragmentPickMain` L284–326), `Picking.js` (`pickVoxelCoordinate`), `Scene/VoxelPrimitive.js`, `WebGPU/WebGPUPickFramebuffer.ts` | `probe-voxel-cell-pick.mjs` (new) — `pickVoxelCoordinate` returns `{x,y,z}` matching WebGL across levels | Cell-pick off by default (primitive-level 4-byte pickColor); resolve buffer never written |
| PARITY-HIZ-TILE-BOUNDING | Hi-Z pyramid: plumb tile bounding volumes into occlusion dispatch (Phase-8a) | M | — | `WebGPU/WebGPUHiZOcclusionDispatcher.ts` (`dispatchOcclusionTest` L753–881), `Scene/OcclusionCulling.js` (L250–259), `WebGPU/WebGPUFeatureRenderers.ts` | `probe-hiz-tileset-occlusion.mjs` (new) — dense tileset, culled tiles invisible, >20% rate at distance, matches WebGL | `OcclusionCulling.enabled=false` → all tiles render; toggling on/off = identical pixel coverage |
| PARITY-RTE-ELLIPSOID-AWARE | Ellipsoid-aware RTE: replace hardcoded WGS84 radii with per-tileset ellipsoid | M | PARITY-RTE-ELLIPSOID-BLOCKER (for pixel-verify only) | `WebGPU/WebGPUCSMRenderer.ts` (WGS84 consts L74–79; `rayEllipsoidEntryDistance` L92–133), `Scene/Cesium3DTileset.js` (`_ellipsoid` L396), `Core/TerrainEncoding.js` | `probe-ellipsoid-aware-rte.mjs` (new) OR unit-test `_rayEllipsoidEntryDistance` w/ hand radii | Fallback to WGS84 when no ellipsoid → Earth tilesets unaffected; CSM defaults off |

---

## Tier 3 — L (large; new subsystems / shader-heavy)

| ID | Title | Effort | Deps | Files | Acceptance probe | Off-gate |
| --- | --- | --- | --- | --- | --- | --- |
| PARITY-VOXEL-MEGATEXTURE-UPLOAD | Megatexture data upload & binding (voxel tiles → 3D texture) | L | — | `Scene/Megatexture.js`, `Scene/VoxelRenderResources.js` (uniforms L125–126), `WebGPU/WebGPUVoxelRenderer.ts` (placeholder L468–499) | `probe-voxel-data-path.mjs` (new) — metatexture-backed pixel ≠ hardcoded gradient, zero validation errors | Placeholder gradient stays on-path when `show=false`/no provider; byte-identical off-case |
| PARITY-VOXEL-OCTREE-TRAVERSAL | Octree traversal shader port (GLSL `Octree.glsl` → WGSL) | L | PARITY-VOXEL-MEGATEXTURE-UPLOAD | `Shaders/Voxels/Octree.glsl` (169L reference), `WebGPU/WebGPUVoxelRenderer.ts` (ray-march L215–235) | `probe-voxel-data-path.mjs` extended — ray through octree L2/L3 boundary reflects leaf index, 5+ rays match WebGL | Disable → raw uvw fallback (placeholder); byte-identical off-case |
| PARITY-F16-SSR-VARIANT | f16 variant for Screen-Space Reflections (ray-march + binary refine) | L | — | `Shaders/WebGPU/PostProcess/ScreenSpaceReflections.wgsl` (+`_f16`), `WebGPU/WebGPUSSREffect.ts` | `probe-ssr-f16.mjs` (new) — reflective scene, f16 on/off parity (small edge tolerance) | f32 byte-identical; device-feature gated |

---

## Tier 4 — XL (voxel data-path epic; the single biggest gap)

The voxel data path is one epic decomposed into the L/M sub-tasks above (`PARITY-VOXEL-MEGATEXTURE-UPLOAD` → `PARITY-VOXEL-OCTREE-TRAVERSAL` → `PARITY-VOXEL-CUSTOM-SHADER-WGSL` + `PARITY-VOXEL-CELL-PICK` → `PARITY-VOXEL-PROBE-VERIFY`). The row below is the umbrella tracking item; **do the sub-tasks, not this row directly.**

| ID | Title | Effort | Deps | Files | Acceptance probe | Off-gate |
| --- | --- | --- | --- | --- | --- | --- |
| PARITY-VOXEL-DATA-PATH-FULL (umbrella) | Voxel full data path: CustomShader→WGSL + megatexture/octree + per-cell pick | XL | decomposed into the 5 voxel sub-tasks | `WebGPU/WebGPUVoxelRenderer.ts`, `Scene/{buildVoxelCustomShader,buildVoxelDrawCommands,Cesium3DTilesVoxelProvider,processVoxelProperties}.js` | `probe-voxel-data-path.mjs` — non-placeholder voxels, colors match WebGL, cell-pick coords correct, no errors, >30 FPS | `scene.voxelsEnabled` (default false) OR placeholder gradient stays on-path when off |

**Voxel sub-task order (build in this sequence):**
1. `PARITY-VOXEL-MEGATEXTURE-UPLOAD` (L) — upload infra, no deps.
2. `PARITY-VOXEL-OCTREE-TRAVERSAL` (L) — depends on #1.
3. `PARITY-VOXEL-CUSTOM-SHADER-WGSL` (M) and `PARITY-VOXEL-CELL-PICK` (M) — both depend on #2, parallelizable.
4. `PARITY-VOXEL-PROBE-VERIFY` (S) — depends on all above.

---

## Deferred by-design (NOT near-term — research/future/low-ROI)

These are intentionally parked. Each is behind a feature flag with a byte-identical default. Do not schedule into the parity-to-100 sprint unless the "why-deferred" gate clears.

| ID | Title | Effort | Why deferred | Off-gate / flag |
| --- | --- | --- | --- | --- |
| PARITY-CUSTOM-SHADER-TRANSPILE | GLSL→WGSL transpile vs native-WGSL-only API for custom shaders | XL | **Design decision, not a port.** Upstream only ever had GLSL (WebGL-only), so there's no "correct" behavior to match. Recommend native-WGSL-only (`wgsl*ShaderText`) first; full GLSL→WGSL transpile via naga is a heavy lift with low near-term ROI. Blocks `PARITY-CUSTOM-SHADER-STAGE`'s scope choice — resolve the *decision* cheaply, defer the *transpiler*. | `wgsl*ShaderText=undefined` default; GLSL on WebGPU warns (non-fatal) |
| PARITY-HDR-CANVAS-CONFIGURE | HDR / display-p3 / HDR10 canvas-format config (WGF-3-EXPAND) | L | Research gate — display-p3/HDR10 canvas support is immature across ANGLE/Metal/DX12. Ship the research note; defer implementation pending browser/driver maturity. | Research-only this batch; no code changes |
| BYDESIGN-CSM-GLOBE-RESOLUTION | CSM globe cascade resolution / ground-fit (`NEW-CSM-CASCADE-GROUND-FIT`) | M | Batch 298 fixed the projection **receive** bug; the residual is edge **sharpness** (cascade-0 1024² ≈ 12 m/texel sawtooth vs WebGL 2048 single map). Parity-neutral as long as shadows cast+receive correctly; a resolution/VRAM trade-off, post-parity profiling item. | Parity-neutral; `probe-csm-soft-shadow.mjs` sub-check 6 documented as accepted delta |
| BYDESIGN-VSM-ESM-SHADOWS | VSM / ESM shadow maps — alternative to perspective-Z PCF | XL | 5-tap PCF is production-ready and cheap; VSM/ESM are future optimizations with light-bleed/precision trade-offs. Research stage. | `scene.shadowMappingMode='pcf'\|'vsm'\|'esm'` (default `pcf`) |
| BYDESIGN-LINEAR-DEPTH-CAST | Linear-depth shadow cast | S | Perspective-Z round-trips correctly; linear-depth is a coordinate-space micro-optimization (no user-visible quality gain) needing lockstep cast+receive swap. Low ROI. | `scene.shadowCastMode='perspectiveZ'\|'linearDepth'` (default `perspectiveZ`) |
| BYDESIGN-INTERSECTION-CLIPPING | INTERSECTION-mode clipping (`WGF-1-INTERSECTION`) | M | Union semantics cover the common masking case; INTERSECTION (all-planes-must-clip) is an advanced-volume enhancement. | `ClippingPlaneCollection.clippingUnionMode` (default union) |
| BYDESIGN-VIRTUAL-TEXTURE-TERRAIN | Virtual-texture terrain (sparse textures + indirection) | XL | Research-stage; needs terrain-provider + GPU-feedback-loop redesign and sparse-binding HW support. Quadtree LOD is the current path. | `scene.terrainMode='quadtree'\|'virtualTexture'` (default `quadtree`) |
| BYDESIGN-WEBNN-SUPER-RES | WebNN super-resolution upsampling | L | WebNN API is early-standardization; requires browser support + model distribution. | `scene.superResolutionEnabled` (default false, only if `navigator.webnn`) |
| BYDESIGN-WATER-CLASSIFICATION | Water classification / flow maps / caustics / refraction | L | Facade + enhanced ocean shipped (Batch 291); classification/flow/caustics/refraction are future WATER_RENDERING_DESIGN §5 phases. | Per-phase flags; current facade always on |
| BYDESIGN-BUFFER-PRIMITIVE-NORMALIZED-DATATYPES | BufferPrimitive positionNormalized / integer datatypes | M | Buffer* renderers assume DOUBLE positions; non-DOUBLE (FLOAT/HALF/BYTE-norm/UINT) is a rare edge case. Batch 318 added detection guards. | Opt-in by geometry author; DOUBLE path unaffected |
| BYDESIGN-TILE-PER-CASCADE-WSM | Tile-per-cascade shadow assignment (WSM Slices 3–4) | M | Uniform cascade fit is current; per-tile cascade selection improves distant-tile resolution but adds dispatch complexity. | `scene.csmTilePerCascade` (default false) |

---

## Critical path to 100% (the dependency spine)

The gap closes fastest by unblocking the shared-infrastructure roots first, then fanning out to adopters. Four independent spines run in parallel; the longest (voxel) sets the schedule.

**Spine A — Clipping planes (models):** ✅ **SHIPPED (Batch 466)** — with a **scope correction**: (1) "clipping planes on **primitives**" is a NON-issue — Cesium's generic geometry `Primitive`/`Appearance` have no `clippingPlanes` API (upstream WebGL doesn't clip generic primitives either; clipping applies to Globe/3DTiles/Model/PointCloud/Voxels only), so `PARITY-CLIP-PRIMITIVE-*` are dropped. (2) The real defect was **model** clipping: it was ineffective on WebGPU not for a missing hardware `clip_distances` path (the discard path already existed) but a **wrong-eye-space-transform bug** — `WebGPUClippingPlaneCollection.ts` baked the eye-space plane with `inverseViewTranspose` only, ignoring the model→world transform. Fixed by folding the model world reference matrix + collection.modelMatrix into the CPU plane transform (`isIdentityMat4`-gated so globe stays byte-identical). Probe `probe-clipping-planes-parity.mjs` 16.4%→2.4% mismatch, PNGs read, off-gate proven. Pick-shader clip discards added (Principle 7 scaffolding left in place).

> **Newly-surfaced follow-up (Principle 9):** WebGPU `scene.pick` returns **undefined for standalone `Model.fromGltfAsync` models** (0 hits even with clipping off) — masks the model clip-pick leg. Add `PARITY-STANDALONE-MODEL-PICK` (S/M, M-tail) — standalone models don't register a pick id like entity/3D-Tiles models do.

**Spine B — Scene-mode 2D/CV pillar (Buffer\* collections):** ✅ **SHIPPED (Batch 467)** — shared `projectBufferPositionForMode` helper wired into all three Buffer\* renderers; points+polyline+polygon reproject correctly in 3D + Columbus View, points+polygon in 2D. **Bonus bug fix:** BufferPolyline declared 9 vertex buffers (> WebGPU's max 8) → INVALID pipeline (blank + validation error) → fixed by interleaving alpha into loc7 (8 buffers). Off-gate proven (3D byte-identical, WebGL untouched, regression probes pass). NOTE: WebGL BufferPrimitive itself renders **misplaced** in CV (no correct WebGL reference), so WebGPU now **exceeds** WebGL here; probe asserts via signature-color counts.

> **Residual (tracked `NEW-BUFFERPOLYLINE-2D-EXTRUSION` in DEFERRED_WORK):** BufferPolyline is blank in **SCENE2D only** — screen-space extrusion collapses when all reprojected verts are coplanar at projected x=0 (the polyline VS lacks the 2D camera-axis convention). Same root class as the deferred Polyline-2D planar-shader gap. S follow-up.

**Spine C — Point Cloud EDL:** ✅ **SHIPPED (Batch 465)** — all 8 sub-tasks landed as one composite implementation via the `parity-to-100` workflow (verify→landed): full EDL data path (offscreen FBO + dual-output depth-writing point variant behind add-only `POINT_CLOUD_EDL_DEPTH` 1<<22 + neighbor-depth blend matching WebGL), off-gate proven, probe `probe-pointcloud-edl-parity.mjs` PASS. **Bonus:** the run also fixed the WebGPU **standalone point-cloud renderer**, which was entirely non-functional (attribute-wrapper unwrap + POSITION_QUANTIZED dequantize + `_ready`/boundingSphere + MSAA sample-count + effective point size + `TimeDynamicPointCloud` mis-delegation) — this unblocked point clouds on WebGPU generally, not just EDL.
```
PARITY-PC-EDL-OFFSCREEN-FB (S) ─► PARITY-PC-EDL-DEPTH-VARIANT (S) ─► PARITY-PC-EDL-HIJACK-COMMANDS (M)
        ├─► PARITY-PC-EDL-CLEAR-COMMAND (S)                                     └─► PARITY-PC-EDL-BLEND-PASS (M)
        └─► PARITY-PC-EDL-RESOURCE-LIFECYCLE (S)                                        ├─► PARITY-PC-EDL-LOG-DEPTH-INTEGRATION (S)
                                                                                        └─► PARITY-PC-EDL-VISUAL-REGRESSION-PROBE (M)
```
Offscreen FB is the root; blend pass is the payoff; probe is the leaf.

> **Newly-surfaced parity item (from the EDL probe):** WebGPU renders **round** points where WebGL renders **square** 8px points (`probe-pc-edl` residual ~44% pixel diff is dominated by this, NOT an EDL gap). Add `PARITY-POINT-SPRITE-SHAPE` (S) — match the WebGL point-sprite shape/size convention in the WebGPU point + point-cloud shaders. Independent M-tail item.

**Spine D — f16 post-process expansion:**
```
{ COLORGRADING, FXAA, BLOOM, AO, DOF, GODRAYS, SSR }-VARIANT (S/M/L, all independent)
        └─► PARITY-F16-PIPELINE-WIRING (M, fan-in)
```
All seven shader variants are independent; the pipeline-wiring task fans them in.

**Spine E — Voxel data path (the schedule-driving XL epic):**
```
PARITY-VOXEL-MEGATEXTURE-UPLOAD (L)
        └─► PARITY-VOXEL-OCTREE-TRAVERSAL (L)
                ├─► PARITY-VOXEL-CUSTOM-SHADER-WGSL (M)
                └─► PARITY-VOXEL-CELL-PICK (M)
                        └─► PARITY-VOXEL-PROBE-VERIFY (S, fan-in)
```
Upload infra → traversal is a strict serial chain (traversal needs real texture data). Custom-shader and cell-pick are parallel once traversal lands. This is the longest chain (L→L→M→S) and gates the "100%" call.

**Independent M-tail (no cross-deps, schedule anywhere):**
`PARITY-GPRIM-CLASSIFY-STANDALONE`, `PARITY-METADATA-MULTICOMPONENT-ATTRS`, `PARITY-METADATA-UINT16-UINT32-PACKING`, `PARITY-METADATA-TABLE-TEXTURE-SOURCES`, ~~`PARITY-EDGE-AUTHORED-SILHOUETTE-NORMALS` (→ `PARITY-EDGE-DEGENERATE-TRI-VERIFY` S leaf)~~ (both DONE 2026-07-02), `PARITY-HIZ-TILE-BOUNDING`, `PARITY-RTE-ELLIPSOID-AWARE` (pixel-verify blocked on Mars/Moon test asset — see `PARITY-RTE-ELLIPSOID-BLOCKER`, ship WGS84-safe default regardless), `PARITY-HDR-COLORGRADING-MATH`, `PARITY-HDR-FXAA-THRESHOLDS`.

**Recommended execution order:** Run Spines A–D and the M-tail in parallel to burn down the ~4–5% long tail quickly (all S/M, low risk, high count). Start Spine E (voxel) immediately in parallel since it is the critical path to the final 100% — it will still be in flight when the other spines finish. The last task to land is `PARITY-VOXEL-PROBE-VERIFY`, at which point weighted parity reaches 100%.

**Known blocker:** `PARITY-RTE-ELLIPSOID-BLOCKER` (S) — no Mars/Moon 3D Tileset test asset exists. The `PARITY-RTE-ELLIPSOID-AWARE` implementation MUST ship WGS84-default-safe even if the asset blocker is unresolved; pixel cross-backend verification is deferred until an asset is sourced or synthesized.
