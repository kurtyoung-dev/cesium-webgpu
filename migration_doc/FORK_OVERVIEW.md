# Fork Overview — CesiumJS WebGPU

> **Canonical doc** (consolidation first draft, 2026 consolidation).
> **Supersedes (folds in):** `WEBGPU_MIGRATION_STATUS.md`, `FEATURE_INVENTORY.md` (the 4-bucket catalog), `audits/2026-04-30_FORK_FEATURE_INVENTORY.md`, `LARGE_DYNAMIC_OBJECTS_DESIGN.md`, `PHASE_5_MODERN_WEBGPU_DESIGN.md`, `ATMOSPHERE_CLOUD_IMPROVEMENT_PLAN.md`, `C2-25_SCENE_CAPTURE_DESIGN.md`, `ATMOSPHERIC_EFFECTS_ROADMAP.md`, `VEGETATION_SYSTEM_DESIGN.md`, `WATER_RENDERING_DESIGN.md` (overview/status surfaces only — the design docs remain authoritative for their own deep detail).
> **Review-in-progress.** This is the master capability catalog: what this fork *is*, every improvement beyond upstream, and the **live** ship-status of each.

> [!IMPORTANT]
> **Status accuracy note.** The source docs this consolidates were last refreshed between roughly Batch 56 and Batch 185; `HEAD` is **Batch 460** (`061f6914f0`). Every headline status below was **re-verified against the live code + git log** at consolidation time. Where the source docs carried a stale SHIPPED/WIP tag that the live code contradicts, this doc carries the corrected status and flags it. A handful of items are marked **`status: verify`** where the live state could not be confirmed from a quick grep — treat those as the maintainer's review targets, not assertions.

---

## 1. What This Fork Is

CesiumJS WebGPU is a fork of [CesiumGS/cesium](https://github.com/CesiumGS/cesium) (`kurtyoung-dev/cesium-webgpu`) that adds a **second, parallel rendering backend (WebGPU)** alongside the existing WebGL2 renderer, behind a single backend-agnostic scene layer. The same `Viewer` / `Scene` / primitive / entity APIs drive **either** backend; the backend is chosen at `Viewer` construction (`contextOptions.renderer: 'webgl' | 'webgpu' | 'auto'`) with feature-detection fallback to WebGL when WebGPU is unavailable.

**Parity figure (re-verified, code-grounded):** the fork tracks **~91% weighted WebGL feature parity** — **86% fully-shipped + 9% partial (work-for-the-common-case with a documented hole)**, per the Batch 459 code-grounded survey (`WEBGPU_PARITY_REPORT_2026-06-30.md`). Excluding 8 deferred-by-design items (VSM/ESM, linear-depth cast, INTERSECTION-mode clipping, virtual-texture terrain, water-classification research, etc.) the weighted figure rises to **~94%**. The **"~93%"** figure cited in archived docs is the *optimistic upper-middle* of the defensible band — it aligns with the **adjusted-weighted** reading (93.7%) when partials get half-credit *and* the 8 by-design items are dropped from the denominator. The honest headline is ~91% on the full surface; readers should not interpret "93%" as "93% feature-complete" (only **86%** are fully shipped).

For precision, the survey enumerates **220 fully-shipped + 23 partial + 4 stub + 8 missing** across **~255** features. This is **feature-coverage**, *not* a single pixel-level visual-parity number: the globe surface + imagery render at visual parity, while some atmosphere/sky-limb and model/primitive shading deltas remain open and are tracked per-feature via `Tools/visual-regression` probes + `DEFERRED_WORK.md`. The code-grounded breakdown in `WEBGPU_PARITY_REPORT_2026-06-30.md` is authoritative for subsystem-level parity; the older "~60%" figure that appears in archived docs is a stale early-session reading, not a competing visual number.

### Design Principles (1–9)

The fork is governed by nine principles (full text in `CLAUDE.md`):

1. **Preserve existing functionality** — WebGL2 must never regress; existing APIs and tests keep working. Upstream files *may* be modified when it improves architecture (e.g. `Context.js` → ES6 class extending `GraphicsContext`); the goal is preserving *functionality*, not freezing *code*.
2. **Backend agnosticism** — scene code must not import from `Renderer/WebGPU/` or branch on `isWebGPU`. All backend-specific code lives in **Feature Renderers** reached through `GraphicsContext`. Both `Context.js` (WebGL) and `WebGPUContext.ts` extend the abstract `GraphicsContext` and implement the same API (TypeScript enforces parity).
3. **Multi-context support** — every context has a unique `context.id` + `rendererType`; a static `ContextRegistry` tracks all live contexts (split-screen, multi-view, mixed backends). Error logs carry the context ID.
4. **WebGL2 targeting** — the fork targets WebGL2 only; WebGL1 fallback paths are not maintained (2 render paths, not 3).
5. **WebGL/WebGPU feature parity** — renderer-agnostic features land on *both* backends; new shader features need both WGSL + GLSL unless architecturally impossible.
6. **Feature-inventory impact scoping** — every change is scoped against the full feature surface (§3 below) to surface cross-subsystem coupling *before* writing code.
7. **"Dead" code audit** — code that looks unused is often deliberate scaffolding for partially-shipped features; cross-reference docstrings + `DEFERRED_WORK.md` before removing.
8. **Verify rendering fixes via Playwright** — visually-verifiable fixes are confirmed with an automated probe (WebGL-vs-WebGPU pixel diff) before being claimed, never by asking the user to reload.
9. **Surface missing/deferred functionality** — when a bug's root cause is unfinished/deferred work, name it and queue it rather than papering over it with an inline hack.

A tenth governing rule, applied across the recent atmosphere/cloud/reflection/metadata work (Batches 426–455): **WebGL parity is the DEFAULT; every quality improvement is OPT-IN behind a flag that defaults OFF and is byte-neutral when off** (`ATMOSPHERE_CLOUD_IMPROVEMENT_PLAN.md`). New GPU resources bind 1×1 placeholders when off; struct growth is add-only; the parity probes must be unchanged with all flags off.

---

## 2. Architecture at a Glance

> Brief — see `ARCHITECTURE.md` and `BUILD_AND_VARIANTS.md` (consolidation siblings) for depth.

- **`GraphicsContext` abstraction** — abstract base unifying WebGL + WebGPU. `Context.js` and `WebGPUContext.ts` both extend it; `ContextFactory.createContext(canvas, opts)` resolves `AUTO` + fallback; `ContextRegistry` tracks every live context for multi-context use.
- **Feature Renderer pattern** — scene files call `context.getFeatureRenderer(FeatureRendererKey.FOO)` instead of `if (context.isWebGPU)`. The `FeatureRendererKey` enum gives O(1) array-index lookup. **Live count: `COUNT: 52` numeric slots (0–51); `WebGPUFeatureRenderers.ts` makes 61 `registerFeatureRenderer()` calls** (verified — the inventory's older "48/49" figures are stale). A few slots are retained add-only after their registration was retired (e.g. `FOG` slot 8, `GROUND_ATMOSPHERE` slot 29).
- **Scene Logic Extractor** — shared scene-level logic (e.g. `_computedModelMatrix`, CPU morph-blend of `_actualPosition`) runs *before* the backend branch so both paths consume identical inputs.
- **64-bit precision / RTE** — all rendering uses Relative-To-Eye emulated f64: vertex buffers carry `positionHigh`+`positionLow`; shaders use `mvpRelativeToEye * translateRelativeToEye(...)`; camera UBOs carry `encodedCameraHigh/Low` + `previousViewProjection` (TAA/CSM/motion). `WebGPURTEAssertions` enforces the contract in debug builds.
- **WGSL shader pipeline** — `WebGPUShaderPreprocessor` (`//>>ifdef`/`//>>else`/`//>>endif`), `WebGPUShaderDefines` (`ShaderDefine` bitmask + `ShaderSourceId` registry, both **add-only**), and `WebGPUShaderModuleCache` (per-device dedupe keyed by `(sourceId, defines)`). WGSL helpers (`csm_*`) are ported from the GLSL `czm_*` builtins. **Live shader count: 293 `.wgsl` files** under `packages/engine/Source/Shaders/WebGPU/` (incl. 32 compute kernels, 97 function chunks, 60 primitive shaders, 41 post-process).
- **Build variants** — three tree-shaken bundles via `scripts/bundleVariantPlugin.js`: `dual` (default, ~7.1 MB), `webgl-only` (~5.6 MB), `webgpu-only` (~6.4 MB). See `BUILD_AND_VARIANTS.md`.

**Scale (verified at HEAD):** `packages/engine/Source/Renderer/WebGPU/` holds **208 entries** (~180 `.ts` + 27 `.js`), **~146K LOC**.

---

## 3. Feature Catalog — the Four Buckets

This is the backbone catalog, preserved from `FEATURE_INVENTORY.md` so its deep-links survive. The four buckets map to the section anchors below:

- **§A = EXISTING** — inherited from upstream CesiumJS (~290 features; WebGPU port may be partial).
- **§B = NEW** — fork-specific additions (~200), each tagged `(SHIPPED)` / `(SCAFFOLDED)` / `(EXPERIMENTAL)`.
- **§C = WIP** — partially shipped, working code with known gaps (~85).
- **§D = FUTURE / DEFERRED** — explicitly punted, gated, or research-stage (~110).

Each bucket spans the **11 subsystems** used for impact scoping: (1) Globe & Imagery, (2) 3D Tiles, (3) glTF Models + KHR, (4) Geometry Primitives, (5) Collections, (6) Entity/DataSource, (7) Picking, (8) Shadows/Lighting, (9) Post-process & Effects, (10) Performance & Compute, (11) Architecture/Build.

> The authoritative, per-line catalog (every feature + its tag) lives in `FEATURE_INVENTORY.md`. This section summarizes; §5 expands the high-traffic subsystems.

<a id="a-existing"></a>
### §A — EXISTING (upstream-inherited)

The fork inherits the full upstream surface. Highlights by subsystem:

- **Globe & Imagery** — all terrain providers (Cesium ion / quantized-mesh, ArcGIS LERC, Google Earth Enterprise, VRTheWorld, custom heightmap, Cesium3DTilesTerrain), `Globe`/`GlobeSurfaceTileProvider`/`GlobeDepth`/`GlobeTranslucency`, water mask, fog, Bruneton sky/ground atmosphere, sun/moon/stars/skybox, runtime IBL (`DynamicEnvironmentMapManager`, `SpecularEnvironmentCubeMap`, `BrdfLutGenerator`), the full imagery-provider stack + projections + tiling schemes.
- **3D Tiles** — `Cesium3DTileset` + traversals, B3DM/I3DM/PNTS/CMPT/composite, implicit tiling + metadata (`3DTILES_metadata`, `EXT_structural_metadata`), vector tiles, Gaussian splats, voxels, classification (`ClassificationType`, `GroundPrimitive`), batch tables + per-feature handles, I3S, iTwin.
- **glTF Models + KHR** — `Model` (3D-Tiles-Next architecture), the full loader + pipeline-stage chain, animation/articulation/skinning/morph, instancing, IBL, CustomShader API, metadata sampling, and the `KHR_materials_*` / `KHR_texture_*` / geometry-compression extension set.
- **Geometry Primitives** — `Primitive`/`GroundPrimitive`/`ClassificationPrimitive`, the full geometry-factory set (Box/Sphere/Ellipsoid/Cylinder/Polygon/Polyline/Wall/Corridor/Frustum/…), per-instance attributes, debug primitives.
- **Collections** — Billboard/Label/Point/Polyline/Cloud, `PrimitiveCollection`, `EntityCluster`, and the `Buffer*Collection` GPU-instanced family.
- **Entity / DataSource** — the declarative entity model, all property types, graphics + visualizers, CZML/GeoJSON/KML/GPX.
- **Particles & Effects, Camera & Navigation, Picking & Selection** — `ParticleSystem`, the full post-process framework + stages, the camera/controller/frustum stack with 2D/Columbus/3D modes + transitions, and the `pick`/`drillPick`/`pickPosition`/`pickFromRay` API.

Full list: `FEATURE_INVENTORY.md` §A.

<a id="b-new"></a>
### §B — NEW (fork-specific additions)

The entire WebGPU renderer + abstractions + tooling. Status tags re-verified at HEAD; highlights:

- **Architecture & abstractions** — `GraphicsContext`, `ContextFactory`, `ContextRegistry`, `RendererType`, `FeatureRendererKey` (52 slots), `getFeatureRenderer`, `RenderCommand`, `WebGPUDrawCommand`/`ComputeCommand`/`DerivedCommand`, co-located `.d.ts` interop, device-loss recovery stack, `BulkPointVisualizer`/`BulkBillboardVisualizer`/`BulkLabelVisualizer` (entity bulk fast-path), `EntityClusterGPU` (GPU bin/count). (SHIPPED)
- **Renderer-wide logarithmic depth** — LIVE since Batch 251 (`_logDepthWriteEnabled` defaults **TRUE**, one-line kill switch). All geometry/opaque producers write to the shared log space (globe, depth plane, lit primitives, all collections, model PBR, the full Mat*/PBR/Basic family, Buffer* collections, ellipsoid primitive, the Vector3DTile classifier family). Residual hyperbolic producers: PointCloud + GaussianSplat (tracked). (SHIPPED — geometry/opaque)
- **WebGPU pipeline infrastructure** — shader-module / render-pipeline / compute-pipeline / bind-group / BGL caches, `WebGPURenderBundleManager`, ring-buffer + storage-buffer pools, HDR render target, F16/subgroup utils, the globe per-tile bind-group + dynamic-offset UBO caches, `WebGPUResidentInstanceBuffer` (O(changed) partial writes), `AsyncResourceMonitor`/`Telemetry`. (SHIPPED)
- **Feature renderers** — globe surface (+9 decomposed helpers), globe depth/translucency/depth-plane, model (PBR + KHR), model instancing/morph/feature-id, all four classic collections + the Buffer* family, ellipsoid primitive, sun/moon/sky-atmosphere/cube-map-panorama/environment, shadow map + CSM cast pass, ground-primitive + ground-polyline + Vector3DTile classifiers, point cloud + EDL + LOD, voxel (**SCAFFOLDED** — placeholder ray-marcher, real voxel data path unimplemented), Gaussian splat. (mostly SHIPPED; see §5)
- **Headline NEW capabilities** — clustered (Forward+) lighting, CSM (cascaded shadow maps), TAA, IBL + spherical-harmonics, **C2-25 dynamic scene-content reflections**, volumetric clouds + weather + atmospheric effects, snapshot mode, compute pipeline. See §4.

Full list: `FEATURE_INVENTORY.md` §B.

<a id="c-wip"></a>
### §C — WIP (working code, known gaps)

The live-verified high-value WIP items (the inventory's stale "STALE/RESOLVED" strikethroughs have been honored):

- **Globe & Imagery** — `C-R1-GLOBE-RENDERSTATE` (variants from hardcoded state, not `command.renderState`); GPU compressed-vertex runtime flip (`DP-H19`). *(BUG-11 globe-black, BUG-3 SCENE2D-blank, morph-splay, and stars/sun were all RESOLVED — see §5/§8.)*
- **3D Tiles** — classification 3-pass renderState routing (`C-R1-CLASSIFICATION`), per-feature batch-table renderState (`C-R1-TILE-BATCH`), ellipsoid-aware RTE for non-WGS84 tilesets (`FEAT-3DT2-03`), Draco/KTX2/meshopt e2e audit, tile↔Hi-Z wiring.
- **glTF + KHR** — `KHR_materials_variants`/IOR/clearcoat-IOR coupling unwired; full per-extension BRDF bodies (clearcoat/sheen/anisotropy live as bit-flagged paths inside `ModelPBRComplete.wgsl`, not full bodies); edge-display residuals (`silhouetteNormals` signed-byte path).
- **Classification** — `NEW-GROUNDPRIM-CLASSIFIER-RECON-PRECISION` (far-corner reconstruction; unblocked by log-depth, re-verify pending), Gaussian-splat classify-against-globe-depth, Vector3DTile clamped-polyline per-feature pick.
- **Shadows/Lighting** — CSM Slices 3–4 (altitude-adaptive splits, moon dual-light, VSM, 3D-Tiles per-tile cascade, WebGL parity path), globe point-light receive (`C-R10-GLOBE-POINT-LIGHT`), quantized-terrain shadow cast variant.
- **Post-process & Effects** — TAA Slices 2b–4 (per-model MRT motion for skinned/morphed/instanced, YCoCg variance clipping, particle prev-position, CSM+TAA verification, WebGL parity path), aerial-perspective LUT rollout to remaining ~32 material shaders (`FEAT-GAP-09`), `clip-distances`/`shader-f16` expansion beyond globe/tonemapping.
- **Performance & Compute** — `WebGPUContext.ts` + `WebGPUSceneRenderer.ts` decomposition, GPU-sort consumer (RenderScheduler reorder, Phase 3), per-object cache device-loss walk (`C-R12`).
- **Architecture/Build** — TS-debt sweeps (`: any`/`as any`/`Record<string,unknown>`), ES6 codemods, spec coverage, worker-Scene Option B.

Full list: `FEATURE_INVENTORY.md` §C.

<a id="d-future"></a>
### §D — FUTURE / DEFERRED

Explicitly punted, externally-gated, or research-stage (~110 items). Highlights: Phase 8 GPU-resident tiles (MegaBuffer / Resident Drawer / WGSL styling compiler / WBOIT), the **vegetation epic** (`NEW-VEGETATION-SYSTEM`), **water** (`WaterClassificationProvider` + Gerstner/FFT), full KHR BRDF bodies (gated on Phase 8a shader strategy), WebNN imagery super-res (research), motion blur / planar reflections / refraction-caustics (gated on TAA motion + G-buffer), NTC neural texture compression (browser-gated), WASM expansion (glTF decode / traversal / KTX2 transcode), and explicit non-goals (ray tracing / mesh shaders / VRS / GPU tessellation — not in the WebGPU spec).

Full list: `FEATURE_INVENTORY.md` §D.

---

## 4. Headline NEW Features (beyond upstream)

Re-verified against git log. These are the marquee capabilities the WebGPU backend adds.

| Feature | Live status | Verification |
|---|---|---|
| **Full WebGPU renderer** | SHIPPED | 208 files / ~146K LOC; 61 feature renderers registered; globe renders in production with imagery/shadows/fog/atmosphere/ocean/day-night/clipping. |
| **Clustered (Forward+) lighting** | SHIPPED | `WebGPUClusterAssign/Bounds/Debug` + `ClusteredLightingDispatcher` + `WebGPUSceneRendererClusteredLighting`; `KHR_lights_punctual` consumer live in `ModelPBRComplete` + 19 Lit Mat shaders (`FEAT-SURVEY-40` closed). Sandcastle: `webgpu-clustered-lighting`. |
| **CSM (cascaded shadow maps)** | SHIPPED (soft-shadows complete) | `WebGPUCSMRenderer` + `WebGPUCSMCastPass`; 4-cascade RTE-precise VPs, slope-scaled bias, texel-snap, 3×3 PCF, ground-clamped cascade fit (Batch 306 → edge parity 50×→1.24×). All 7 cast variants. Toggle `scene.useCascadedShadowMaps` defaults off. Slices 3–4 are WIP (§C.6). |
| **TAA (temporal AA)** | SHIPPED-partial (Slice 1–2e) | `WebGPUTAAEffect`; Halton (2,3) jitter, RTE depth-based motion vectors at orbital altitude, neighborhood clamp, model-velocity pass. Toggle `scene.taaEnabled` defaults off. Slices 2b–4 WIP (§C.7). |
| **IBL + spherical harmonics** | SHIPPED | `WebGPUImageBasedLighting` + `WebGPUSpecularEnvironmentCubeMap` + `WebGPUIBLPipeline`; `ProjectRadianceToSH` compute pass → 9 SH-L2 coeffs into `_webgpuSHBuffer` (model binding 36). GGX prefilter; HDR + roughness-correct prefilter opt-in (Batch 426). |
| **C2-25 dynamic scene-content reflections** | SHIPPED — epic closed (Batch 451) | `WebGPUDynamicEnvironmentMapCapture`; globe + 3D Tiles + glTF render into the reflection env cube via an override-camera pass; temporal env-cube accumulation, clouds folded into the env map, Lagarde parallax-corrected localized reflections. **Opt-in** (`webgpu.sceneCaptureReflections`, default false; byte-identical when off). Sandcastle demo verified (Batch 448). |
| **Volumetric clouds + weather** | SHIPPED | `WebGPUProceduralCloudRenderer` (Schneider/Nubis raymarch, dual-lobe HG + Beer-Powder + 3D FBM + light-march), tiered cloud presets (V0–V16 functionally complete, Batch 453), per-genus types, weather-map seam (C2-16) + real weather ingest (`WebGPUWeatherRenderer`, MetarWeatherSource / WcsCoveragesWeatherSource). Volumetric toggle defaults off (opt-in over parity). |
| **Atmospheric effects (heat/cold/precip)** | SHIPPED | Phases A–E: heat shimmer post-process, cold optics (22° halo, sun-dogs, light pillars), precipitation particles, conditions→effects hierarchy. Plus volumetric fog (`WebGPUVolumetricFogRenderer` — Frostbite 3-pass froxel, HG sun+moon, sun-shadow god-rays, cloud shadows). Improvement-plan Phases 1–4 shipped (Batches 426–445), all opt-in. |
| **Snapshot mode** | SHIPPED | `Services/SnapshotModeService.js`; `scene.snapshotMode` freeze/auto-thaw for deterministic capture. |
| **Compute pipeline** | SHIPPED | 32 compute kernels (frustum cull, Hi-Z occlusion, GPU sort keys / BitonicSortU64, point-cloud sort + LOD, mipmap gen, entity-cluster grid, atmosphere LUTs, volumetric fog, radiance→SH, weather sim). Hi-Z occlusion consumer fully fixed (Batches 212–213). |

Other notable NEW features: structural-metadata GPU upload + per-model WGSL metadata codegen + GPU-side metadata read (property-texture + property-table) + metadata picking (**DP-H46 a/b/c/d/e/f, Batches 454–463, opt-in/parity-default — epic CLOSED**; `webgpu-structural-metadata-pick` gallery demo + `probe-dp46c/d/e/f` verify display + pick), point-light soft shadows, OIT (weighted-blended), heat-shimmer/contact-shadows effects, and a complete debug/visual-regression tooling stack (`CesiumDebug.*`, `Tools/visual-regression`). 28+ fork demos are ported to the Sandcastle2 gallery (324 gallery folders total).

---

## 5. Subsystem Feature Detail

Per-renderer status, re-verified at HEAD (supersedes the maturity grades in `audits/2026-04-30_FORK_FEATURE_INVENTORY.md`, which were captured at Batch 116).

### 5.1 Globe & Imagery
`WebGPUGlobeSurfaceRenderer` (~3900 LOC, decomposed into 9 helpers) — quantized + uncompressed terrain, multi-pass for >4 imagery layers (16-layer single-pass on capable adapters, 1-layer reduced fallback for SwiftShader/low-end), water mask, day/night, fog/atmosphere/Lambert, hardware clip distances (globe path), Hi-Z occlusion. **SHIPPED.** Ground atmosphere is shaded in-`GlobeTerrain.wgsl` (the separate-pass renderer was deleted Batch 239 as a parity misread). The historical "globe never rasterizes / canvas black" framing is **resolved** (Batches 93 + 200).

### 5.2 3D Tiles
B3DM/I3DM/PNTS/CMPT render on WebGPU; per-feature pick returns `Cesium3DTileFeature`/`ModelFeature` at parity (Batch 209). **Voxels (CRITICAL CAP — XL effort):** the entire WebGPU voxel **data path** is unimplemented — `WebGPUVoxelRenderer.ts` is a hardcoded RGB-density ray-marcher on a 4×4×4 gradient placeholder, and `VoxelPrimitive.update()` short-circuits. Missing: `VoxelPrimitive` provider / megatexture / octree traversal, `CustomShader`→WGSL transpilation, and per-cell pick coordinate buffering. Upstream PR#13517's default voxel shader is unreachable. This is the **single largest remaining parity gap** — one of only four `stub` items in the 2026-06-30 survey, and ranked **#1 in effort** (XL) at the top of the "genuine port work" queue (`WEBGPU_PARITY_REPORT_2026-06-30.md` §5.2 / §6). See `ROADMAP_AND_DEFERRED_WORK.md` §4.2 (Voxels epic). Gaussian splats render with back-to-front sort + log frag_depth (multi-frustum compose is a tracked follow-up).

### 5.3 glTF Models + KHR
`WebGPUModelRenderer` (~2300 LOC) — full PBR (metallic-roughness + spec-gloss + unlit), all alpha modes, double-sided, vertex colors, normal mapping, model-space RTE, skinning, GPU instancing, morph targets, IBL factor + SH. `KHR_materials_*` (clearcoat/specular/anisotropy/iridescence/sheen/volume/transmission) ship as **bit-flagged paths inside `ModelPBRComplete.wgsl`** (bits 19–25), not separate full-BRDF shader bodies; `KHR_texture_transform`, `KHR_mesh_quantization`, transmission MRT capture are live. Iridescence uses the Belcour-2017 analytic thin-film integral (already shipped — the "hue-shift approximation" doc was stale). Full per-extension BRDF bodies are gated on the Phase 8a shader strategy (§D.3).

### 5.4 Geometry Primitives
`WebGPUPrimitiveCommands` (50+ primitive WGSL shaders) — basic color/textured, 19 Material×Lit + 19×Flat variants, PBR simple/textured, Phong color/textured. Ellipsoid primitive renders via radii-scaled bounding-box geometry with log frag_depth (translucent double-blend fixed Batch 276). **SHIPPED.**

### 5.5 Collections
Billboard / Label (SDF) / Point / Polyline (arrow/dash/glow/outline) / Cloud — all **SHIPPED in 3D + 2D + Columbus View + Morph** (Phase 3, 2026-06-13). Far-surface depth fixed by renderer-wide log depth (Batches 249–251). Size/layout parity fixed Batch 275. Instance upload routes through `WebGPUResidentInstanceBuffer` (static collections upload 0 B/frame). `Buffer*Collection` (vector-tile) renders WebGL↔WebGPU since Batch 180. Cloud collection FS is a simplified 2D-noise impostor (appearance gap tracked).

### 5.6 Entity / DataSource
Bulk fast-paths for Point/Billboard/Label entities (`BulkPointVisualizer` etc., Batches 300/333) — static entities written once, skipped per-frame; **800×–1400× per-frame speedup** at 20k static entities on both backends, `scene.pick` returns the Entity. `EntityClusterGPU` GPU bin/count with parity-tightened CPU merge. Lazy-alloc + legacy opt-out toggles. CZML/GeoJSON ingest hints + GPU keyframe kernel remain deferred.

### 5.7 Picking
`pick`/`drillPick`/`pickPosition`/`pickFromRay` work; per-feature model/3D-Tiles pick at parity. Translucent pick closed via a dual-path async API (`pickHoverAsync` stochastic-dither + `pickPreciseAsync` stencil-coordinated, Batch 192). Voxel per-cell pick unsupported (data path scaffolded). Main-scene depth-blit shader, pick-layer bitmask, octree acceleration still WIP/future.

### 5.8 Shadows / Lighting
Single shadow map (cast + receive, 7 variants, 5-tap PCF point lights) **SHIPPED**. CSM Slices 1–2 + soft-shadows **complete** (§4). Clustered Forward+ lighting **SHIPPED**. Globe point-light receive, quantized-terrain shadow variant, VSM/ESM/PCSS are WIP/future.

### 5.9 Post-process & Effects
`WebGPUPostProcessPipeline` + `WebGPUPostProcessEffects` (35+ post WGSL) — Bloom, SSAO+GTAO, DoF, ColorGrading, 5-operator tonemapping (+ f16 variant w/ auto-fallback), FXAA, GodRays, LensFlare, Silhouette, ToonEdge, NightVision, etc. HDR end-to-end (Batch 110). **Feature-complete vs the WebGL post-process surface.** TAA + volumetric fog + atmospheric effects layered on top (§4). The WebGPU canvas **requires** the post-process blit (`usePostProcess` always true on WebGPU).

### 5.10 Performance & Compute
Pipeline / bind-group / BGL / shader-module caches, render bundles, ring + storage pools, Hi-Z occlusion + GPU frustum cull (per-frustum + per-cascade), GPU sort (BitonicSortU64), auxiliary-culler idle-decay. Capability detection (`shader-f16`, `subgroups`, `clip-distances`, `timestamp-query`, etc.) auto-requested; consumer wiring is partial (Phase 5, §6).

---

## 6. Large / Future Feature Programs

These are multi-session epics with their own canonical design docs (which remain authoritative).

- **Large Dynamic Objects (LDO)** — `LARGE_DYNAMIC_OBJECTS_DESIGN.md`. Four update regimes, each with a distinct data path that all converge on instanced draw: (1) sparse partial-`writeBuffer`, (2) dense WASM RTE-encode, (3) **orbital GPU compute propagator** (the headline WebGPU-first feature — SGP4 → storage buffer, positions never leave GPU), (4) conditional ECS-in-WASM-on-worker. **Status:** Step 0 dirty-consume shipped (billboards + labels); Phase 10 entity bulk fast-path shipped (§5.6). Phases 1–4 (partial-write manager, WASM encode, SGP4, ECS) are the forward roadmap — much substrate (compute engine, SoA Buffer* collections, WASM bridge, weather-particle compute→draw precedent) already exists.
- **Phase 5 — Modern WebGPU feature adoption** — `PHASE_5_MODERN_WEBGPU_DESIGN.md`. Capability detection landed 2026-04-09; per-feature wiring deferred. `float32-filterable` / texture-compression / `timestamp-query` in production; `subgroups` partial; `clip-distances` (WGF-1) + `shader-f16` (WGF-3) shipped-partial (globe / tonemapping); `dual-source-blending`, `indirect-first-instance`, `bgra8unorm-storage`, std140-padding drop (WGF-4) deferred.
- **Phase 8 — GPU-resident tiles** — `PHASE_8_GPU_RESIDENT_TILES_DESIGN.md`. Normal G-buffer + depth prepass (highest-leverage infra gap), TileStoreGPU DOD storage (MegaBuffer + Resident Drawer + WGSL styling compiler + WBOIT), shader-variant strategy. Largely §D.
- **Water rendering** — `WATER_RENDERING_DESIGN.md`. `WaterClassificationProvider` + Gerstner waves + bathymetry + per-type taxonomy + (future) Tessendorf FFT. **Design only** (§C.1 / §D.7); upstream PR to reserve quantized-mesh extension ID 0x05 pending.
- **Vegetation system** — `VEGETATION_SYSTEM_DESIGN.md`. Planetary trees/grass/rocks across globe + 3D Tiles, dual-backend; V1 scatter → V5 grass/rocks, octahedral impostors, `VegetationPBR` shader pair, biome/landcover data layer (Köppen-Geiger + RESOLVE Ecoregions + ESA WorldCover). **Unbuilt** (`NEW-VEGETATION-SYSTEM`, §D.2).

---

## 7. Reference Statistics

Verified at HEAD (`061f6914f0`, Batch 460) unless noted.

| Metric | Value | Source |
|---|---|---|
| WebGL feature parity | ~91% weighted (86% fully-shipped + 9% partial); ~94% excluding 8 deferred-by-design items. The archived "~93%" = adjusted-weighted (93.7%) upper bound | `WEBGPU_PARITY_REPORT_2026-06-30.md` (Batch 459) |
| Upstream-inherited features (§A) | ~290 | `FEATURE_INVENTORY.md` |
| Fork-added features (§B) | ~200 | `FEATURE_INVENTORY.md` |
| WIP entries (§C) | ~85 | `FEATURE_INVENTORY.md` |
| Future/deferred entries (§D) | ~110 | `FEATURE_INVENTORY.md` |
| Feature-renderer key slots | `COUNT: 52` (slots 0–51) | `FeatureRendererKey.js` (verified) |
| `registerFeatureRenderer()` calls | 61 | `WebGPUFeatureRenderers.ts` (verified) |
| WGSL shader files | 293 (incl. 32 compute, 97 fn chunks) | `find …/Shaders/WebGPU` (verified) |
| WebGPU renderer files | 208 entries (~180 `.ts` + 27 `.js`) | `…/Renderer/WebGPU/` (verified) |
| WebGPU renderer LOC | ~146K | `wc -l` (verified) |
| `ShaderDefine` bits (live) | **22** active bits (`1<<0` … `1<<21`, contiguous, no gaps) | `WebGPUShaderDefines.ts` (verified — `grep ': 1 <<'` = 22) |
| `ShaderSourceId` registrations | 37 (contiguous `1`…`37`, highest `STAR_FIELD_CATALOG:37`) — *a source-file ID, distinct from the 22 define bits* | `WebGPUShaderDefines.ts` (verified) |
| WASM bridges shipped | Draco, Basis/KTX2, naga-wasm, splats, zip | `…/ThirdParty` (verified) |
| Sandcastle gallery folders | 324 (28+ fork WebGPU demos, incl. `webgpu-structural-metadata-pick`) | `packages/sandcastle/gallery` (verified) |
| Build variant sizes (min. IIFE) | dual 7.1 MB / webgl-only 5.6 MB / webgpu-only 6.4 MB | `CLAUDE.md` / `BUILD_AND_VARIANTS.md` |

> Older docs cite "143 renderer files / 259 WGSL / 45 FR slots" (Batch 116 audit) or "48 FR / 49 keys" (Batch 185 status). Those are stale; the verified figures above supersede them.

---

## 8. Production-Readiness & Known-Incomplete

**What renders in production today (WebGPU):** the globe with imagery, terrain, shadows (single + CSM), fog, atmosphere, ocean, day/night, clipping; glTF models with PBR + most KHR extensions; 3D Tiles (B3DM/I3DM/PNTS/CMPT) with per-feature pick + styling; all four classic collections + Buffer* vector tiles in 3D/2D/CV/Morph; geometry primitives; the full post-process suite + HDR; point clouds + EDL; Gaussian splats. Globe surface + imagery are at **visual** parity; 0 GPU validation errors across the regression sweep.

**Resolved historical blockers** (the strikethrough items in the old inventory — do not re-investigate):
- `BUG-WEBGPU-CANVAS-BLACK` / "globe never rasterizes" — RESOLVED (Batches 93 + 200).
- `BUG-3 SCENE2D-blank` — RESOLVED (Batch 215, 2D viewport-split scene-FB accumulate).
- MORPH globe-terrain splay — RESOLVED (Batch 216).
- Stars/skybox/sun-absent — RESOLVED (Batch 214, was a sun-sizing misdiagnosis).
- Hi-Z occlusion consumer black-screen on dense scenes — RESOLVED (Batches 212–213).
- Per-feature model/3D-Tiles pick, instanced-VA divisors crash — RESOLVED (Batches 209 / 245).

**Known-incomplete (the honest gaps):**
- **Voxels** — scaffold only; no real voxel-data path on WebGPU (§5.2).
- **Visual parity residuals** — atmosphere/sky-limb band brightness, cloud-impostor collection appearance, some material/primitive shading deltas (tracked per-feature in `DEFERRED_WORK.md`).
- **TAA + CSM** — production-usable but Slices 3–4 incomplete (skinned-model MRT motion, YCoCg clipping, altitude-adaptive splits, 3D-Tiles per-tile cascade, WebGL parity paths). Both default off.
- **KHR full BRDF bodies** — clearcoat/sheen/anisotropy/iridescence are bit-flagged approximations, not full per-extension shaders (gated on Phase 8a).
- **Vector3DTile 2D/CV** — implemented but e2e-unverified (no `.vctr` test data).
- **Opt-in quality features** — C2-25 reflections, volumetric clouds/fog, atmospheric effects, structural-metadata pick (DP-H46) all default OFF and are byte-neutral when off; they LEAD WebGL when enabled but are not the parity-default path.
- **Decomposition debt** — `WebGPUContext.ts` (~4.3K LOC) + `WebGPUSceneRenderer.ts` exceed the 1000-line guideline; decomposition in progress.
- **Webgpu-only bundle** — only 10% smaller than dual because Scene static-imports the WebGL `Context.js`; closing the gap is a multi-day refactor (§6 / `BUILD_AND_VARIANTS.md`).

---

### Consolidation notes (for the maintainer's review)

- Headline ship-status for C2-25 (Batch 451), clouds/atmosphere improvement plan (Batches 426–445), tiered clouds (Batch 453), DP-H46 a/b/c/d/e/f (Batches 454–463, epic closed), and the resolved historical blockers were all **re-verified against git log**, not lifted from the stale source tags.
- Feature-renderer counts (52 slots / 61 registrations), WGSL count (293), renderer file/LOC counts (208 / ~146K), and the Sandcastle folder count (324) were **re-counted against live code** and supersede the older doc figures.
- The `status: verify` flag on the `ShaderDefine`/`ShaderSourceId` count is **resolved**: the live `WebGPUShaderDefines.ts` carries **22** active `ShaderDefine` bits (`1<<0` … `1<<21`, contiguous) and **37** contiguous `ShaderSourceId` registrations (`1`…`37`, highest `STAR_FIELD_CATALOG:37`, ID `0` reserved) — two separate registries. (An earlier draft cited `ELLIPSOID_PRIMITIVE:33` as the highest source ID; that was stale — `COMPUTE_INSTANCE_*`, `GAUSSIAN_SPLAT:36`, and `STAR_FIELD_CATALOG:37` extend past it.)
- The parity headline is now the **code-grounded** Batch 459 survey (`WEBGPU_PARITY_REPORT_2026-06-30.md`): ~91% weighted (86% fully-shipped + 9% partial), ~94% excluding deferred-by-design items. The archived "~93%" maps to the adjusted-weighted upper bound, not the median.
- The per-line feature catalog (§A/§B/§C/§D) is summarized here; `FEATURE_INVENTORY.md` remains the authoritative line-item source until archival. The §A/§B/§C/§D anchors are preserved so existing `CLAUDE.md` deep-links resolve.
