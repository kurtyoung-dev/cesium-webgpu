# Vegetation System Design & Gap Report

**Status:** Design / Survey (no code shipped yet)
**Scope:** Ultra-performant planetary vegetation (trees, grass, rocks/sparse-arid) on the globe + draped on 3D Tiles, dual-backend (WebGL2 + WebGPU).
**Date:** 2026-06-05
**Author:** Rendering architect (consolidating 8 research strands)

This document is the single source of truth for the vegetation epic. It consolidates a GPU-driven-geometry survey, a 3D-Tiles authoring survey, a foliage-materials survey, a placement/scatter survey, a LOD/culling/compute survey, a state-of-the-art vegetation-LOD literature review, a vegetation-PBR/wind review, and a planet-scale-ecosystem survey. Every code claim below was spot-checked against the fork tree on 2026-06-05.

Cross-references:
- [FEATURE_INVENTORY.md](FEATURE_INVENTORY.md) §C (WIP) / §D (FUTURE) — `FEAT-GAP-07` (impostors), `FEAT-SURVEY-43` (grass/foliage material + vegetation instancing), `BACKLOG-§9` (subsurface scattering). All three are confirmed present in the inventory at `migration_doc/FEATURE_INVENTORY.md:893,950,955`.
- [DEFERRED_WORK.md](DEFERRED_WORK.md) — Phase 8 §9.C "per-tile impostor baking, compute instance selection" (`FEATURE_INVENTORY.md:901`).
- CLAUDE.md Principle 5 (WebGL/WebGPU parity), Principle 6 (feature inventory), Principle 8 (Playwright verification).

---

## 1. Executive Summary — Feasibility Verdict

**Verdict: Ultra-performant planetary vegetation is FEASIBLE on this fork, WebGPU-first, with a degraded-but-correct WebGL2 fallback.** The fork already ships ~80% of the hard infrastructure (GPU compute culling, indirect draw, point-cloud LOD, render bundles, bitonic sort, RTE precision, I3DM/PNTS instancing, a full PBR shader pair, stochastic alpha-test dither). What's missing is *vegetation-specific glue*: a scatter/placement primitive, a 4-stage mesh-LOD chain (the fork has tile-LOD and point-LOD but **no mesh-LOD chain** for Models — confirmed: `Scene/Model/Model.js` has only `distanceDisplayCondition`, a binary cull, no LOD swap), an octahedral impostor pipeline, and a dedicated foliage material variant.

The single biggest architectural asymmetry: **WebGL2 has no compute shaders and no GPU-driven indirect-draw argument generation** (`Renderer/Context.js:544` probes `WEBGL_compute` but `Context.js:1107` documents the capability overrides return false/0 — "no WebGL compute extension exists yet"). Every GPU-driven stage therefore needs a CPU fallback on WebGL2. This is the same dual-path discipline the fork already enforces; it is not a blocker, it is a cost.

**Top 5 build steps (detail in §8):**
1. **Slice V1 — VegetationScatterCollection + compute placement (WebGPU) / CPU placement (WebGL2).** Poisson/blue-noise scatter on globe terrain + draped on 3D Tiles, RTE-encoded instance buffer, behind a `FeatureRendererKey.VEGETATION_SCATTER`.
2. **Slice V2 — 4-stage mesh-LOD chain + GPU-driven LOD selection.** Reuse `WebGPUGPUCuller` + `WebGPUIndirectDrawManager`; CPU per-instance LOD on WebGL2.
3. **Slice V3 — Octahedral impostor bake + sample** (the missing `FEAT-GAP-07`). Offline/lazy bake to atlas; fragment-shader octahedral sampling (portable, no compute).
4. **Slice V4 — `VegetationPBR` shader pair** (WGSL + GLSL): two-sided leaf translucency, wind vertex animation, alpha-to-coverage, canopy AO, impostor sampling — extending `ModelPBRComplete.wgsl` with new `ShaderDefine` bits.
5. **Slice V5 — GPU-instanced grass + density-imposter + terrain detail-albedo** (separate path from trees), plus rocks/sparse-arid as a third tuning profile.

Each slice is independently shippable and Playwright-probe-verifiable per CLAUDE.md Principle 8.

---

## 2. What the Fork ALREADY Has

Legend: ✅ shipped both backends · 🟦 WebGPU-only · 🟨 WebGL2-only · ⚠️ partial.

### 2.1 Instancing

| Capability | File:symbol | WebGL2 | WebGPU |
|---|---|---|---|
| I3DM / `EXT_mesh_gpu_instancing` load | `Scene/Model/I3dmLoader.js`, `Scene/Model/InstancingPipelineStage.js:process()` | ✅ (vertex attrs `a_instancingTransformRow0/1/2`, `a_instanceTranslation/Scale`) | ✅ |
| WebGPU native instancing (storage buffer → `@builtin(instance_index)`) | `Renderer/WebGPU/WebGPUModelInstancing.js` | — | 🟦 (mat4x4 storage buffer, 64 B/instance, `queue.writeBuffer` upload) |
| Legacy world-space (i3dm RTC) instancing | `Shaders/Model/LegacyInstancingStageVS.js` | ✅ | ✅ (via Model pipeline) |
| Collection instancing (billboard/point/polyline) | `Scene/BillboardCollection.js`, `Scene/PointPrimitiveCollection.js` | ✅ | ✅ |
| ArrayBuffer-backed flyweight collections | `Scene/BufferPrimitive.js` (layout `FEATURE_ID_U32@0, SHOW_U8@4, DIRTY_U8@5, PICK_ID_U32@8`), `BufferPointCollection.js`, `BufferPolygonCollection.js`, `BufferPolylineCollection.js` | ✅ | 🟦 storage-buffer-backed |

**WebGL2 instance ceiling:** practical ~1–10K/mesh (vertex-attribute budget + JS transform construction cost; no batched SIMD). **WebGPU:** 65K+/cull batch, millions for points; transforms uploaded once, no per-frame CPU cost.

### 2.2 3D Tiles (vegetation authoring substrate)

| Tile type | File:symbol | Parity |
|---|---|---|
| PNTS (point clouds — grass/understorey) | `Scene/Model/PntsLoader.js` (Draco via `DracoLoader.decodePointCloud`, EDL via `Scene/PointCloudEyeDomeLighting.js`) | ✅ |
| I3DM (instanced trees) | `Scene/Model/I3dmLoader.js` | ✅ |
| B3DM (batched canopy/meadow patches) | `Scene/Model/Model3DTileContent.js` `fromB3dm()` | ✅ |
| CMPT (mixed-type LOD tiles) | `Scene/Composite3DTileContent.js` | ✅ |
| Implicit tiling (quadtree/octree HLOD) | `Scene/Implicit3DTileContent.js` | ✅ (experimental) |
| SSE traversal (ADD/REPLACE) | `Scene/Cesium3DTile.js:getScreenSpaceError()` (line ~547), `Scene/Cesium3DTilesetTraversal.js`, `Scene/Cesium3DTileRefine.js` | ✅ (same JS both backends) |
| EXT_structural_metadata (per-instance attrs) | `Scene/StructuralMetadata.js`, `Scene/PropertyTable.js`, `Scene/MetadataSchema.js` | ✅ PropertyTable; ⚠️ PropertyTexture sampling not fully wired; PropertyAttribute scaffolded |
| LRU cache + foveation | `Scene/Cesium3DTilesetCache.js` (default `cacheBytes` 512 MB) | ✅ |

### 2.3 Model PBR (foliage material substrate)

All in `Shaders/WebGPU/Model/ModelPBRComplete.wgsl` (~3100 LOC) with GLSL twins under `Shaders/Model/MaterialStageFS.glsl` / `LightingStageFS.glsl`. **Confirmed flag bits** (WGSL constants, verified 2026-06-05):

| Feature | WGSL flag | bit | parity |
|---|---|---|---|
| Alpha-test cutout | `FLAG_ALPHA_MODE_MASK` = 64u | 6 | ✅ (`discard` at `ModelPBRComplete.wgsl:2009`) |
| Alpha blend | `FLAG_ALPHA_MODE_BLEND` | 7 | ✅ |
| Two-sided lighting | `FLAG_IS_DOUBLE_SIDED` = 256u | 8 | ✅ (`N = -N` on backface, `:2040`) |
| Unlit (cheap distant billboards) | `FLAG_IS_UNLIT` = 512u | 9 | ✅ (early-out `:2015`) |
| Sheen (Charlie BRDF — leaf sheen reuse) | `FLAG_HAS_SHEEN` = 8388608u | 23 | ✅ (`:2371`) |
| Volume (Beer-Lambert thickness) | `FLAG_HAS_VOLUME` = 16777216u | 24 | ⚠️ WGSL only; thickness sampled `:2432` |
| Transmission (thin-leaf refraction) | `FLAG_HAS_TRANSMISSION` = 33554432u | 25 | ⚠️ WGSL only; **no refraction-MRT capture yet** (`:356` notes placeholder content) |
| Stochastic alpha-test dither | `chunks/functions/csm_stochasticDither.wgsl` (IGN noise, TAA-converging) | — | 🟦 shipped Batch 192; its own docstring lists "Future: foliage / particle alpha-test rendering" |
| CustomShader vertex hook (wind) | `Scene/Model/CustomShader.js` `vertexMain(...)` | ✅ | ✅ |

**WebGL2 PBR gap:** `MaterialStageFS.glsl` has **no transmission/volume blocks** — KHR_materials_transmission/volume are WebGPU-only today.

### 2.4 Placement / scatter / height-clamp

| Capability | File:symbol | parity |
|---|---|---|
| Per-position terrain sampling | `Core/sampleTerrain.js`, `Core/sampleTerrainMostDetailed.js` | ✅ |
| Ray-cast height / clamp | `Scene/PickingRayHelpers.js:sampleHeightMostDetailed/clampToHeightMostDetailed`, `Scene/Scene.js:clampToHeight()` | ✅ |
| HeightReference (6 modes) | `Scene/HeightReference.js` (`CLAMP_TO_GROUND` … `RELATIVE_TO_3D_TILE`) | ✅ |
| Approx terrain heights cache | `Core/ApproximateTerrainHeights.js` | ✅ |
| RTE 64-bit precision | `Core/EncodedCartesian3` (`high/low` split; shader `posRTE=(posHigh-camHigh)+(posLow-camLow)`) | ✅ (uniform across all shaders) |
| Ground draping / classification | `Scene/GroundPrimitive.js`, `Scene/ClassificationPrimitive.js`, `Renderer/WebGPU/WebGPUGroundPrimitiveRenderer.js` (depth-sample migration, Batch 111) | ✅ |

### 2.5 LOD / culling / compute (the GPU-driven engine)

**All WebGPU-only.** Confirmed defaults 2026-06-05:

| System | File:symbol | key facts |
|---|---|---|
| GPU frustum cull | `Renderer/WebGPU/WebGPUGPUCuller.ts` (`maxObjects ?? 65536` :113, `workgroupSize ?? 256` :114), `Shaders/WebGPU/Compute/FrustumCull.wgsl` | scalar `main` + `mainSubgroups` (2–4× faster); modes VISIBILITY/INDIRECT/COUNT |
| Indirect draw | `Renderer/WebGPU/WebGPUIndirectDrawManager.ts` (`maxDrawCalls ?? 4096` :115, `_strideInUint32s = indexed?5:4` :120) | single `drawIndexedIndirect` per batch |
| Occlusion (Hi-Z) | `Scene/OcclusionCulling.js` (default off), `Renderer/WebGPU/WebGPUHiZOcclusionDispatcher.ts`, `Shaders/WebGPU/Compute/{HiZPyramid,OcclusionTest}.wgsl` | "WebGPU only — no WebGL equivalent" |
| Point-cloud per-point LOD | `Renderer/WebGPU/WebGPUPointCloudLODProcessor.ts`, `Shaders/WebGPU/Compute/{PointCloudLOD,PointCloudLODScanCompact}.wgsl` | 4-band distance² LOD + frustum + screen-space density; ~12 MB/M points |
| GPU sort | `Renderer/WebGPU/WebGPUGPUSortKeysDispatcher.ts`, `Shaders/WebGPU/Compute/{GPUSortKeys,BitonicSortU64}.wgsl` | u64 bitonic; JS comparator faster <50K (consumer integration still pending) |
| Render bundles | `Renderer/WebGPU/WebGPURenderBundleManager.ts` | 50–80% CPU reduction on static geometry; idle-evict |
| Decoupled-lookback scan | `Shaders/WebGPU/Compute/DecoupledLookbackScan.wgsl` | deterministic compaction primitive |

**Tile/billboard LOD that IS cross-backend (CPU-driven):** `Cesium3DTile.getScreenSpaceError()`, `Billboard.scaleByDistance/translucencyByDistance`, `PointPrimitive` same, `Model.distanceDisplayCondition` (binary cull only).

### 2.6 The one thing absent in BOTH backends

**No per-Model mesh-LOD chain.** `Scene/Model/Model.js` exposes `distanceDisplayCondition` (cull) and uniform `scale` only — no array of geometric representations, no impostor fallback, no mesh decimation. This is the central gap the vegetation epic must fill (§5).

---

## 3. Gap Analysis (per capability, WebGL2 vs WebGPU)

| Capability needed for vegetation | WebGPU status | WebGL2 status | Fallback required |
|---|---|---|---|
| GPU scatter placement (density/biome-map → instances) | **MISSING** — build compute pass (template: `PointCloudLOD.wgsl` SOA + atomic compaction) | **MISSING + no compute** | CPU Poisson-disk on worker thread; results cached per tile |
| Mesh-LOD chain (full→simplified→impostor→albedo) | MISSING (no `Model` support either backend) | MISSING | Shared CPU descriptor; selection on GPU (WebGPU) vs CPU/shader-branch (WebGL2) |
| GPU-driven LOD selection + indirect draw | reuse `WebGPUGPUCuller`+`WebGPUIndirectDrawManager` (present) | **no indirect-arg generation** (`Context.js:1107`) | CPU computes per-LOD instance lists + `multiDrawIndirect` ext (args precomputed CPU-side) or N draw calls |
| Octahedral/billboard impostor bake | MISSING (`FEAT-GAP-07`) but bakeable via render-to-atlas | MISSING; bake possible but no compute for atlas packing | Offline/lazy bake; **sampling is portable** (fragment shader only) |
| Impostor sampling (octahedral UV) | MISSING shader | MISSING shader | Portable — same algorithm GLSL+WGSL, no compute |
| HLOD / forest-mesh merge (clump proxy) | use B3DM/CMPT + `Implicit3DTileContent` (present) | same | Pre-baked offline (no runtime merge) — portable |
| Two-sided leaf translucency | `FLAG_IS_DOUBLE_SIDED` present; transmission ⚠️ WGSL-only, no refraction MRT | double-sided present; **no transmission** | WebGL2 uses cheaper backface-dot SSS approximation (§6 model B), no MRT |
| Alpha-to-coverage | `multisample.alphaToCoverageEnabled` **not wired** | `gl.SAMPLE_ALPHA_TO_COVERAGE` **not wired** | wire both in pipeline/render-state; falls back to stochastic dither when MSAA off |
| Wind vertex animation | portable (vertex shader + time uniform) | portable | none — fully portable |
| Canopy AO | IBL+SH present; G-buffer normal+roughness present (Batch 119) → SSAO possible | IBL+SH present; SSAO weaker | baked vertex-color AO (portable) preferred |
| Per-point grass LOD | `WebGPUPointCloudLODProcessor` (present) | **MISSING** | PNTS tile-LOD only (all-or-nothing per tile) |
| GPU sort by material/depth | `WebGPUGPUSortKeysDispatcher` (present, consumer pending) | JS comparator | JS sort (fine <50K) |
| Subsurface scattering | `FLAG_HAS_VOLUME` Beer-Lambert ⚠️ approximation (WGSL); `BACKLOG-§9` | none | cheap backface-dot glow on both; full SSS deferred |

**The recurring WebGL2 deficit:** no compute, no GPU-driven indirect-arg generation, no storage-buffer append/atomic compaction, no per-point LOD. The portable subset (impostor sampling, HLOD proxies, wind, dither/A2C, terrain-albedo bake, octahedral atlas sampling) is large enough that **WebGL2 still gets a correct, shippable vegetation experience** — just CPU-bounded scatter/cull and tile-granular (not per-instance) LOD.

---

## 4. Proposed Vegetation System Architecture

### 4.1 Backend-agnostic surface (CLAUDE.md Principle 2)

Scene-level code never imports from `Renderer/WebGPU/`. A new `FeatureRendererKey.VEGETATION_SCATTER` (enum, O(1) array access per CLAUDE.md "Enumerated Keys") routes to a WebGPU feature renderer; the WebGL2 path is the default fallback in the same Scene file, after the `if (fr) { fr.update(...); return; }` branch.

```
Scene/VegetationLayer.js          // backend-agnostic public API (add/remove, density map, biome)
  ├─ runs shared "Scene Logic Extractor" BEFORE isWebGPU branch (CLAUDE.md Collections rule)
  ├─ WebGPU:  context.getFeatureRenderer(FeatureRendererKey.VEGETATION_SCATTER)
  │            → Renderer/WebGPU/WebGPUVegetationScatterRenderer.ts  (compute scatter + GPU LOD + indirect)
  └─ WebGL2:  CPU scatter (worker) + per-instance LOD + I3DM-style instanced draw (fallback)
```

### 4.2 Data model — three tiers, picked by use case

1. **Authored / streamed (planetary, sparse-to-medium): 3D Tiles I3DM + EXT_structural_metadata.** Reuse the entire existing pipeline (§2.2). Trees authored as I3DM with per-instance `height`, `species` (enum), `dbh`, `biomass`; grass as PNTS; canopy as B3DM; mixed as CMPT; planetary HLOD via `Implicit3DTileContent`. **This is the zero-new-loader path** and should be the recommended ingest for real datasets (OSM `natural=tree`, Global Forest Watch). Citation pattern from research: `instanceFeatureIdLabel`/`featureIdLabel` route picking; `Cesium3DTileStyle` colors by `${species}`.

2. **Procedural scatter (dense, runtime): new `VegetationScatterCollection`.** A new primitive that scatters instances over a region from a **density/biome control texture** (R8 per-biome spawn probability + slope/altitude rejection). This is the genuinely new artifact. Instance buffer is RTE-encoded (`positionHigh/positionLow` + per-instance rotation quat + scale + LOD-tier + speciesId + featureId). On WebGPU the buffer is filled by a compute pass; on WebGL2 by a pooled CPU worker writing the same layout.

3. **Detail-albedo fallback (horizon): no instances at all.** Far tiles render vegetation baked into terrain detail-albedo (grass) or as a flat green tint (forest polygons), sharing the globe terrain mesh — near-zero cost.

### 4.3 Placement on globe terrain vs draped on 3D Tiles

- **Globe terrain:** scatter samples height from the terrain provider. WebGPU compute can read a per-tile heightmap texture (the terrain tile's vertex texture / a packed height target) directly; WebGL2 uses `sampleTerrainMostDetailed` batched per tile on a worker. Slope from finite-difference of the heightmap → reject >~30°.
- **Draped on 3D Tiles:** reuse the depth-sample mechanism the ground-primitive renderer already uses (`WebGPUGlobeDepth.globeDepthTexture`, Batch 111) — scatter against the composited depth so instances clamp to building roofs / tile surfaces. WebGL2 falls back to per-position `clampToHeightMostDetailed`.

### 4.4 Integration with tile traversal + RTE

- Scatter is **tile-scoped**: a `VegetationScatterCollection` allocates a per-tile GPU storage buffer when a globe/3D-Tiles tile becomes visible, dispatches scatter on first visibility, and frees on tile unload — hooking the same visibility lifecycle `Cesium3DTilesetTraversal`/globe `QuadtreePrimitive` already drives. This keeps the working set bounded by the visible tile set, not the planet.
- **RTE everywhere:** instance positions stored as `EncodedCartesian3` high/low; vertex shader uses `mvpRelativeToEye * translateRelativeToEye(posHigh, posLow, camHigh, camLow)` exactly like `GlobeTerrain.wgsl` / `GroundPrimitive.wgsl`. No raw `vec3<f32>` positions, no `posHigh+posLow` addition (CLAUDE.md 64-bit rule). `CameraUniforms` already carries `encodedCameraHigh/Low`, `mvpRelativeToEye`, and the `previousViewProjection` tail needed for TAA-converging dither and motion-vector LOD crossfade.

---

## 5. The 4-Stage LOD Design

The literature (SpeedTree, UE5 Nanite+HLOD+impostor, Codrops "False Earth" WebGPU grass, Cyanilux GPU grass, NVIDIA GPU Gems 3 "True Impostors", Shaderbits octahedral impostors) converges on a chain. We map it to three distinct asset classes because they LOD differently.

### 5.1 Trees — 4 stages

| Stage | Range (default, hysteresis) | Representation | Cost | Backend |
|---|---|---|---|---|
| L0 full mesh | 0–100 m (exit 90 m) | full glTF Model, PBR + wind | high | both |
| L1 octahedral impostor | 100–500 m (exit 450 m) | single quad, hemi-octahedral atlas (diffuse+normal+depth), 4 hemi views | very low (1 quad, 2 tex samples) | both (sampling portable) |
| L2 merged clump / forest mesh (HLOD) | 500 m–3 km | pre-baked B3DM/CMPT proxy per cluster (mesh-merge offline), simplified silhouette | low | both (offline bake) |
| L3 terrain albedo / forest tint | 3 km+ | no instances; baked into globe detail-albedo or translucent forest polygon | ~0 | both |

- **Transition criteria:** distance² thresholds (cheap), with **hysteresis** (separate enter/exit) to stop thrashing at boundaries. SpeedTree-style LOD blend state in `[-1,1]` carried per instance.
- **Cross-fade:** **stochastic dither** (`csm_stochasticDither.wgsl`, already shipped, TAA-converging) for L0↔L1 and L1↔L2 — the fork's preferred path because it needs no double-blend pass and converges under the existing TAA (`previousViewProjection` is present). Alpha-to-coverage when MSAA is on. Temporal interpolation for impostor re-bake to avoid view-snap pop.
- **Impostor bake (`FEAT-GAP-07`):** render the L0 mesh from 4 (hemi-octahedron — trees seen from side/above) views into a packed atlas (greedy packing). Bake offline at asset-prep time *or* lazily at runtime (render-to-texture, async; WebGPU can pack via compute, WebGL2 via repeated FBO draws). **Sampling is fully portable** — octahedral direction→UV needs no trig, no compute.
- **GPU-driven cull/indirect (WebGPU):** per-frame `WebGPUGPUCuller` (frustum, mode INDIRECT) writes `instanceCount=0` for culled trees; a small LOD-classify compute pass bins survivors into per-LOD-tier sub-ranges; `WebGPUIndirectDrawManager` issues one `drawIndexedIndirect` per (LOD-tier × species-material). Hi-Z occlusion (`WebGPUHiZOcclusionDispatcher`) optional for dense canopy.
- **WebGL2 fallback:** CPU frustum pre-filter (visible set), per-instance LOD tier computed CPU-side, instances re-bucketed into per-tier instanced draws via the existing `InstancingPipelineStage` attribute path. No occlusion cull. Tile-granular, not per-instance, when instance counts are high.

### 5.2 Grass — different chain (blades → density imposter → detail-albedo)

| Stage | Range | Representation | Backend |
|---|---|---|---|
| G0 GPU-instanced blades | 0–40 m | per-blade cubic-Bézier blades, 3 segment tiers (15/5/2 segs, Codrops "False Earth"), wind | 🟦 WebGPU compute selects view-ray + segment count; 🟨 WebGL2: CPU-culled instanced quads, fixed segments |
| G1 density imposter | 40–150 m | textured ground patches (grass billboard cards or projected density) | both |
| G2 terrain detail-albedo | 150 m+ | grass color baked into terrain detail-albedo (no geometry) | both |

Grass is the heaviest case for WebGL2 (no per-point LOD); on WebGL2 grass degrades to G1/G2 earlier (blades only within ~20 m).

### 5.3 Rocks / sparse-arid — third profile

Rocks don't sway and are opaque/sparse, so they tune differently: **no wind**, **no two-sided/translucency**, **alpha-test off** (solid geometry), **longer L0 range** (rocks read as silhouettes far out), **impostor at L1 from full octahedron** (rocks seen from any angle, unlike hemi for trees), and they benefit most from **Hi-Z occlusion** (boulders occlude each other). Sparse-arid scatter uses very low density + high slope tolerance + clustering noise. This is a parameter profile over the same primitive + LOD machinery, not new code.

---

## 6. Vegetation PBR Shaders

**Recommendation: extend, don't replace.** Add foliage features to the existing PBR pair behind new `ShaderDefine` bits rather than forking a standalone shader (Option A from the materials survey) — keeps the shared Cook-Torrance/IBL core, avoids duplicating ~80% of `ModelPBRComplete.wgsl`, and respects CLAUDE.md shader-pair lockstep (every WGSL change gets a GLSL twin). A `VEGETATION` define gates the new branches so non-foliage models pay zero cost.

### 6.1 New ShaderDefine bits (add-only, never reorder — CLAUDE.md ShaderDefine rule)

Register in `WebGPUShaderDefines.ts` (next free bits) and consume via `//>>ifdef` blocks with `//>>else` historical fallthrough:

| Define | Gates |
|---|---|
| `VEGETATION_WIND` | wind vertex animation block |
| `VEGETATION_TRANSLUCENCY` | two-sided leaf SSS / transmission glow |
| `VEGETATION_AO` | canopy/gradient AO from vertex color |
| `VEGETATION_IMPOSTOR` | octahedral impostor sampling in FS (replaces mesh PBR) |
| `VEGETATION_A2C` | alpha-to-coverage path (pairs with pipeline `alphaToCoverageEnabled`) |

Corresponding WGSL material-flag bits continue the existing sequence in `ModelPBRComplete.wgsl` (currently used through bit 25 `FLAG_HAS_TRANSMISSION`) — next foliage flags at bits 26–30, add-only.

### 6.2 Proposed uniform block

```wgsl
struct VegetationUniforms {
  windVector:          vec4<f32>,  // xyz dir, w strength
  windFrequency:       vec4<f32>,  // up to 4 oscillator bands (hierarchical wind)
  time:                f32,
  transmissionFactor:  f32,        // 0 opaque .. 1 full backlight
  transmissionColor:   vec3<f32>,  // tint of transmitted light (yellow-green)
  transmissionThickness:f32,       // thickness-texture modulation
  leafSpecularF0:      f32,        // ~0.04 (dielectric); ~0.05 waxy
  leafRoughness:       f32,        // 0.5..0.7 typical
  aoStrength:          f32,        // 0.2..0.5 canopy darkening
  branchOscillators:   array<vec4<f32>,8>, // optional hierarchical wind phases
};
```

### 6.3 Technique placement (matches ModelPBRComplete insertion points)

- **Wind:** vertex stage, AFTER morph/skin/instance, BEFORE RTE encode. Gust = low-freq sine at root dissipating up (`heightFraction`); turbulence = high-freq detail. Optional branch-ID-driven hierarchical oscillators (SpeedTree-style) packed in a vertex attribute.
- **Two-sided translucency:** FS, AFTER direct sun, BEFORE IBL (around `:2259`). Backface term `pow(clamp(dot(-N,L),0,1), k) * transmissionFactor * transmissionColor`. WGSL can additionally use `FLAG_HAS_VOLUME` Beer-Lambert + thickness (`:2432`). **WebGL2 uses only the cheap backface-dot model** (model B from survey) — no MRT, no volume.
- **Alpha-to-coverage:** wire `multisample.alphaToCoverageEnabled` in `WebGPUModelPipelineCache` when `FLAG_ALPHA_MODE_MASK` && MSAA; `gl.SAMPLE_ALPHA_TO_COVERAGE` in the WebGL2 render state. When MSAA is off, fall back to `csm_stochasticDither` (already shipped).
- **Canopy AO:** baked AO in vertex color `.a`, `ambient *= mix(1-aoStrength, 1, vertexAO)` (portable). Optional SSAO from the G-buffer normal+roughness target (Batch 119) on WebGPU only.
- **Impostor sampling:** octahedral direction→UV, sample diffuse+normal(+depth) from atlas; portable GLSL/WGSL.

### 6.4 Files to touch (lockstep)

`Shaders/WebGPU/Model/ModelPBRComplete.wgsl` (+ branches), `Shaders/Model/MaterialStageFS.glsl` + `LightingStageFS.glsl` (twins), `Scene/Model/ModelMaterialInfo.js` (flag bits 26–30), `Renderer/WebGPU/WebGPUShaderDefines.ts` (define bits), `Renderer/WebGPU/WebGPUModelPipelineCache.js` (A2C + conditional VegetationUniforms bind), and the GLSL define plumbing for WebGL2.

---

## 7. Performance Plan

**Goal: vegetation ≤ ~12–25% of a 16.7 ms frame at planetary scale.** Research-derived budget (WebGPU vs WebGL2) for 50K instances/tile @ ~10 m height:

| Pass | WebGL2 | WebGPU |
|---|---|---|
| Compute scatter (per tile, amortized) | N/A (CPU worker, off-frame) | 0.2–0.5 ms |
| Instanced draw (≈50 material variants) | 1.5–2.5 ms | 0.8–1.2 ms |
| CSM cast (per cascade, shared instances) | — | 0.3–0.6 ms |
| Total opaque tree pass | 2.5–4.0 ms | 1.2–2.0 ms |

Scaling: 10K → ÷5; 200K dense forest → 8–15 ms (WebGL2) / 4–8 ms (WebGPU).

**Levers (mostly already in the fork):**
- **GPU frustum cull** (`WebGPUGPUCuller`, 65K/batch) drops ~80% of instances before raster when the camera sees a fraction of a tile.
- **Indirect draw consolidation** — one `GPUBuffer` for all draw args (Toji.dev WebGPU best-practices: 412 draws 3 ms→10 µs validation on Chrome/D3D12). `WebGPUIndirectDrawManager` already uses a single buffer.
- **Hi-Z occlusion** (`WebGPUHiZOcclusionDispatcher`) for dense canopy / boulder fields.
- **GPU sort** (`WebGPUGPUSortKeysDispatcher`) to batch by material/LOD and minimize state changes (consumer wiring still pending — opportunistic).
- **Render bundles** (`WebGPURenderBundleManager`, 50–80% CPU cut) for static L2/L3 forest-mesh tiles whose command structure is frame-stable.
- **Streaming/working set:** tile-scoped allocation/free (§4.4) bounds memory to the visible set. Instance buffer ~16–64 B/instance; 1 M instances = 16–64 MB. Octahedral atlas ~16 KB/asset (512² RGBA + normal). Terrain-albedo fallback shares the globe mesh (0 extra geometry).
- **Readback caveat:** GPU cull visible-count readback is 1-frame-latent — fine for culling (hidden by submission), rules out per-frame CPU steering. Use indirect-draw so the count never round-trips.

WebGL2 stays performant by: CPU frustum pre-filter (1000s→100s visible) on a worker, earlier LOD transitions (impostor sooner, blades within ~20 m), tile-granular LOD, and aggressive terrain-albedo fallback.

---

## 8. Phased Implementation Roadmap

Each slice is independently shippable, WebGPU-first with WebGL2 parity, and **must ship a Playwright probe** (`Tools/visual-regression/probe-veg-*.mjs`) before being called done (CLAUDE.md Principle 8). Update `FEATURE_INVENTORY.md` as entries move §D→§C→§B.

- **V1 — Scatter foundation.** `Scene/VegetationLayer.js` + `VegetationScatterCollection` + `FeatureRendererKey.VEGETATION_SCATTER` + `WebGPUVegetationScatterRenderer.ts` + new compute shader `Shaders/WebGPU/Compute/VegetationScatter.wgsl` (density/biome map → RTE instance buffer, slope/altitude reject). WebGL2 CPU-worker scatter writing the identical buffer layout. Probe: scatter N trees over SF terrain, WebGL vs WebGPU diff. *(Resolves part of `FEAT-SURVEY-43`.)*
- **V2 — Mesh-LOD chain + GPU LOD select.** Add LOD-chain descriptor to the scatter primitive; LOD-classify compute pass → `WebGPUGPUCuller`(INDIRECT) → `WebGPUIndirectDrawManager` per (tier×material). WebGL2: CPU per-instance tier + bucketed instanced draws. Probe: verify tier switching with hysteresis, no thrash.
- **V3 — Octahedral impostor bake+sample.** Bake pipeline (offline + lazy RTT) → packed atlas; portable octahedral FS sampling; stochastic-dither cross-fade L0↔L1. *(Resolves `FEAT-GAP-07`.)* Probe: impostor vs full-mesh silhouette match across azimuth.
- **V4 — VegetationPBR shader pair.** New `ShaderDefine` bits + flag bits 26–30; wind, two-sided translucency, A2C, canopy AO, impostor sampling in WGSL + GLSL lockstep; pipeline-cache A2C wiring. Probe: leaf backlight + wind sway, WebGL/WebGPU parity.
- **V5 — Grass + rocks profiles.** Grass path (G0 blades via point-LOD reuse / WebGL2 quad fallback → G1 density imposter → G2 detail-albedo). Rocks/sparse-arid parameter profile (no wind, full-octahedron impostor, Hi-Z occlusion). Probe: 500K-blade grass field perf + horizon fallback.
- **V6 (optional, profile-driven) — optimization.** GPU-sort consumer wiring, render-bundle caching for L2/L3, per-instance picking + `Cesium3DTileStyle` species coloring, seasonal/wind metadata, contact shadows. Only if real workloads (>50K/tile) show frame pressure.

Recommended ingest companion (no engine code): document the **I3DM + EXT_structural_metadata** authoring path (§2.2/§4.2) so real datasets (OSM `natural=tree`, Global Forest Watch) flow through the existing 3D-Tiles pipeline immediately, in parallel with procedural scatter.

---

## 9. Open Questions / Risks / Required Upstream or Data-Pipeline Work

1. **WebGL2 compute absence is permanent for now.** `Context.js:1107` documents capability overrides return false until `WEBGL_compute` ships (it won't, broadly). Every GPU-driven stage needs a maintained CPU twin — ongoing cost, not one-time. Risk: WebGL2 vegetation perceptibly thinner/earlier-LOD than WebGPU. Acceptable per the fork's "WebGPU-first, WebGL2 correct" stance, but must be stated to users.
2. **Refraction MRT for physically-correct leaf transmission is unbuilt** (`ModelPBRComplete.wgsl:356` placeholder). True KHR_materials_transmission needs an opaque-only scene-color capture before transmissive draws. Decision: ship the cheap backface-dot SSS for V4; defer MRT (ties to `BACKLOG-§9` subsurface scattering). Surface as next work per CLAUDE.md Principle 9, not papered over.
3. **No runtime mesh-merge / proxy-geometry tool** — L2 HLOD clumps must be **baked offline** (asset-prep), like UE5 Proxy Geometry / InstaLOD. Need a data-pipeline doc or tool; runtime merge is out of scope.
4. **Impostor bake budget at runtime.** Lazy RTT bake competes for frame time; offline bake needs an asset-prep step. Decide per-deployment; temporal interpolation required either way to hide re-bake pop.
5. **PropertyTexture / PropertyAttribute partial** (`Scene/PropertyTexture.js` sampling not fully wired) — fine for per-instance (PropertyTable works), blocks per-texel leaf-density maps. Workaround: PropertyTable or baked vertex data.
6. **GPU-sort consumer integration still pending** (`WebGPUGPUSortKeysDispatcher` notes JS faster <50K) — don't gate V1–V5 on it.
7. **Density/biome map provenance.** Procedural scatter needs control textures (biome, density, slope-mask). Source: derive from existing imagery/landcover layers, OSM forest polygons, or author per-region. Data-pipeline work, not engine work.
8. **Vegetation interaction with classification & shadows.** Confirm trees cast CSM correctly (CSM cast pass present) and respect `ClassificationType` (city-boundary outlines). Translucent foliage in split-screen hits the known `WebGPUTranslucentTileClassification` multi-frustum gap (Batch 47) — use opaque canopy LODs there.
9. **Picking at scale.** Per-instance feature IDs exist (`BufferPrimitive` `FEATURE_ID_U32`, I3DM feature IDs); confirm GPU pick pass reads scatter-buffer feature IDs without a per-instance stall.

---

### Source URLs (vegetation-LOD literature)

Octahedral/billboard impostors: Shaderbits "Octahedral Impostors"; NVIDIA GPU Gems 3 ch.21 "True Impostors"; InstaLOD / Simplygon impostor docs; Amplify Impostors (80.lv). HLOD/mesh-merge: UE5 Proxy Geometry Tool + HLOD Mesh Merge Modifier; Nanite Foliage (UE 5.7 docs). GPU-driven grass: Codrops "False Earth: From WebGL Limits to a WebGPU-Driven World" (tympanus.net/codrops/2026/04/21); Cyanilux "GPU Instanced Grass Breakdown"; Toji.dev "WebGPU Indirect Draw Best Practices"; webgpufundamentals.org optimization. LOD transitions: SpeedTree LOD docs; alpha-to-coverage (Grokipedia); Cinevva "Landscape Generation … Browser Open Worlds". Data: OSM `natural=tree`/`forest`; Google Photorealistic 3D Tiles; 3D Tiles I3DM spec (CesiumGS).

---

## 3D Tiles integration + spec-extension analysis

**Status:** Spec-level survey (3D Tiles 1.1 / OGC 22-025r4, 3D-Tiles-Next, Khronos glTF registry, CesiumGS repos + community forum). **Date:** 2026-06-05. **Scope:** what the standard *can* express for vegetation today, what it is *missing*, what is on the roadmap, and whether a new extension is warranted. This complements §4.2 (data model) and §2.2 (what the fork already consumes) — it does not change the build plan in §8; it scopes the *authoring/interchange* layer the plan sits on.

### A. The explicit-instances model — fully viable today

The end-to-end "every tree is a real instance with per-instance metadata" path is **production-ready and rides entirely on ratified or in-flight standards** the fork already loads (§2.1, §2.2). There is **no new loader required** — this confirms §4.2 tier 1.

- **Geometry / transforms — `EXT_mesh_gpu_instancing`** (Khronos, *ratified* multi-vendor; https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Vendor/EXT_mesh_gpu_instancing/README.md). Per-instance `TRANSLATION` (VEC3), `ROTATION` (VEC4 quat), `SCALE` (VEC3), plus underscore-prefixed custom attributes (`_SPECIES`, `_HEIGHT`, `_DBH`, `_FEATURE_ID_0`). All instances share one fixed buffer layout — **no variable-length per-instance arrays, no runtime add/remove** (count is baked at load). Fork: `Scene/Model/InstancingPipelineStage.js` → WebGL2 vertex attrs; `Renderer/WebGPU/WebGPUModelInstancing.js` → 64 B/instance storage buffer → `@builtin(instance_index)`.
- **Container — `3DTILES_content_gltf` + I3DM.** glTF can be referenced directly as tile content (core in 1.1), or wrapped as I3DM (deprecated in 1.1 but still valid and still the most widely-tooled path: `CesiumGS/3d-tiles-tools`, `i3dm.export` PostGIS→i3dm). Fork loads both (`I3dmLoader.js`, `Model3DTileContent.js`).
- **Per-instance identity / picking — `EXT_mesh_features` + `EXT_instance_features`.** `EXT_mesh_features` is the *recommended* glTF extension in the 1.1 CHANGES.md (assigns feature IDs to vertices/texels via attribute, texture, or implicit index). `EXT_instance_features` (CesiumGS 3d-tiles-next, https://github.com/CesiumGS/glTF/tree/3d-tiles-next/extensions/2.0/Vendor/EXT_instance_features) is the *instance-level* sibling — feature IDs per GPU instance, linking each tree to a property-table row. Fork: `Scene/Model/ModelFeatureTable.js` routes `instanceFeatureIdLabel`/`featureIdLabel`; GPU pick path exists.
- **Per-instance attributes — `EXT_structural_metadata`** (CesiumGS/Khronos, recommended in 1.1; https://github.com/CesiumGS/glTF/tree/3d-tiles-next/extensions/2.0/Vendor/EXT_structural_metadata). Schema (classes/enums/typed properties) bound to a `PropertyTable` (per-feature, binary), `PropertyAttribute` (per-vertex), or `PropertyTexture` (per-texel). Fork: `Scene/StructuralMetadata.js` + `Scene/PropertyTable.js` are **fully wired for per-instance read** (this is the load-bearing capability for tier 1); `PropertyTexture` sampling is **scaffolded but not shader-wired** (§9 item 5), `PropertyAttribute` is scaffolded.
- **Tile/region-scoped metadata — `3DTILES_metadata`** (core in 1.1, https://github.com/CesiumGS/3d-tiles/tree/main/extensions/3DTILES_metadata). Same schema framework, attached at **tileset / tile / content-group / content** level — the right place for *coarse* "this tile is temperate_broadleaf, 800 stems/ha" hints. **Cannot reach individual instances** (that is EXT_structural_metadata's job).
- **LOD organization — `3DTILES_implicit_tiling`** (core in 1.1) + **REPLACE refinement** + `3DTILES_multiple_contents` (core in 1.1, one tile → trees.glb + grass.pnts + rocks.glb). These *organize* the §5 4-stage chain (mesh→impostor→clump→albedo) into a streamable quadtree/octree but **do not generate** the LOD assets. Fork: `Implicit3DTileContent.js` (experimental), `Composite3DTileContent.js`.
- **Styling — `Cesium3DTileStyle`** expressions (`${species} === 'oak'` → color, `${height}` → scale) work cross-backend once feature IDs + property tables are present.

**Limits of the explicit model (confirms §3 / §7):** fixed instance count (no runtime scatter — adding/removing trees means re-authoring the glTF); bandwidth ~48 B/instance raw → ~2.4 MB per 50K-tree tile uncompressed, ~100–300 KB with Draco+meshopt+zstd; per-instance metadata genuinely needs the glTF-level extensions (3DTILES_metadata alone is tile-scoped); and the legacy I3DM `BatchTable` is **not schema-standardized** (every author invents property names).

### B. What the spec is MISSING for vegetation — precise coverage map

The gap is **semantic + procedural**, not geometric. Geometry/instancing/metadata *plumbing* exists; what is absent is any standardized way to say "this is vegetation, here is the region, scatter it like this." Precise breakdown:

| Vegetation concept | Spec expression today | Verdict |
|---|---|---|
| Flag content as "vegetation" | `EXT_structural_metadata`/`3DTILES_metadata` **author-defined** class/enum (e.g. a `class:"vegetation"`) | **Partial / ad-hoc** — works but no standard semantic; tilesets won't interoperate |
| Define a vegetation **AREA / region** | none — only the tile bounding volume (a box/region/sphere), which is the *tile* extent, not a vegetation boundary; implicit tiling uses *regular grids* so irregular patches need explicit tiles | **No expression** for an arbitrary vegetated polygon inside a tile |
| **Scatter / placement rules** (density, spacing, Poisson, seed) | none at any level | **No expression at all** |
| **Biome / ecosystem** definition | author-defined enum only; **no standard vocabulary** (NLCD/CORINE/FAO/ASPRS classes live entirely outside the spec) | **No standard** — every dataset differs |
| **Density / landcover raster** | `PropertyTexture` *could* carry per-texel density in theory, but it is rarely implemented in viewers (and **not shader-wired in this fork**, §9 item 5) | **No practical expression**; workaround = custom control texture sampled in viewer code |
| Species **palette / catalog** | author-defined `3DTILES_metadata` class is expressive enough to *list* species; no standard schema | **Partial** — expressible, not standardized |
| Per-instance species/height/DBH | `EXT_structural_metadata` PropertyTable (or custom instance attrs) | **Covered** (see A) |
| LOD-tier transition criteria | implicit tiling geometric error (SSE) only; no vegetation-specific enter/exit/hysteresis | **Partial** — generic SSE, not the §5.1 hysteresis model (which is correctly viewer-driven) |
| Render hints (alpha-to-coverage, translucency, wind freq/amp) | none | **No expression** — these stay fork `ShaderDefine` bits (§6.1), viewer-side |

**Net:** the spec has **no built-in semantic types for species / biome / canopyDensity / ageClass**, **no region-of-vegetation primitive**, and **no scatter-rule schema**. Everything author-defined means zero cross-tileset interoperability on vegetation properties. This is the single concrete gap that a new extension (D) would close.

### C. Roadmap / repo status — what is proposed or shipped

Searched CesiumGS/3d-tiles, the 3d-tiles-next branch, KhronosGroup/glTF registry, Cesium blog/roadmap, and the community forum.

**Shipped / ratified (usable now):**

- `EXT_mesh_gpu_instancing` — ratified (Khronos). Forum migration thread: https://community.cesium.com/t/from-i3dm-to-ext-mesh-gpu-instancing/19731
- `3DTILES_implicit_tiling`, `3DTILES_multiple_contents`, `3DTILES_content_gltf`, `3DTILES_metadata` — core in **3D Tiles 1.1 / OGC 22-025r4** (approved **Dec 2022**).
- glTF point clouds (POINTS mode + `EXT_mesh_features` + `EXT_structural_metadata`) replaced native PNTS in 1.1 — LiDAR per-point classification (ASPRS ground/low-veg/high-veg) flows through here.
- **`KHR_gaussian_splatting` + `KHR_gaussian_splatting_compression_spz`** — release candidate (**Feb 2026**), Cesium platform support landing **June 2026** (https://cesium.com/blog/2026/04/27/3d-gaussian-splats-lod/). Cesium explicitly cites splats "excel at preserving visual fidelity for vegetation" where mesh reconstruction fails — relevant as a *5th representation* alongside §5's mesh/impostor/clump/albedo, but it is generic splatting, **not a vegetation extension**.

**Proposed / in-flight:**

- `EXT_instance_features`, `EXT_structural_metadata`, `EXT_mesh_features` — 3d-tiles-next, *recommended* in 1.1 CHANGES.md; metadata blog https://cesium.com/blog/2022/05/31/fine-grained-metadata-in-3d-tiles-next/ (**May 2022**).
- **`CesiumGS/cesium-unreal#558`** "Add land cover data or create splatmaps to empower procedural worlds" (https://github.com/CesiumGS/cesium-unreal/issues/558, filed **2023**, **open/unresolved** — Cesium undecided between exposing land-classification vs generating splatmaps). This is the *closest* thing to a vegetation/landcover request and it is **engine-level, not spec-level**.

**Explicitly nothing found:**

- **No `3DTILES_vegetation`, `3DTILES_scatter`, biome, or density-map extension** exists, is drafted, or is on the public 3D Tiles 2.0 roadmap. June-2026 roadmap items (https://cesium.com/blog/2026/06/01/cesium-releases-in-june-2026/) are vector tiles (`3DTILES_content_gltf_vector`), Gaussian-splat LOD, voxel tiling preview, and CAD/IFC design formats — **vegetation/biome features are absent**.
- **No point-instancing extension** distinct from mesh instancing (grass-blade/rock primitives) — none proposed.
- Community demand is real but **all application-level**: "Foliage 3D Tileset" (Aug 2024, https://community.cesium.com/t/foliage-3d-tileset/34414), "optimal representation of large forest areas" (May 2023, https://community.cesium.com/t/discussion-optimal-and-most-efficient-representation-of-large-forest-areas/24269 — consensus answer is "use EXT_mesh_gpu_instancing", not a spec change), "Best practices for tree/foliage coverage" (Aug 2023), "WMS as basis for vegetation" (Nov 2021). Cesium's own foliage tutorials (cesium.com/learn/unreal/unreal-foliage, .../unreal-procedural-foliage) use **Unreal's native foliage/Niagara systems, not 3D Tiles**.

**Industry pattern (why the gap persists):** UE5 (Foliage component → baked instances in the .umap; offline procedural paint/spawn), Unity (TerrainTools density `Texture2D` → editor/runtime spawner → serialized prefab instances), and Godot (MultiMesh) all treat scatter as an **offline content-creation step that emits explicit instances**, not a runtime data format. The web/3D-Tiles consensus mirrors this: scatter is a **client-side rendering/optimization problem**, which is exactly why §4.2 tier 2 (`VegetationScatterCollection`) is viewer-side and correct.

### D. Does a new extension make sense? — verdict + sketch

**Verdict: YES, but as a fork-local convention FIRST, not an upstream proposal yet — and only for the *procedural* model (B). The explicit model (A) needs zero new spec.** The value of an extension is **interoperability + bandwidth** for planetary-scale procedural fill (encode a density raster + rules in ~100–300 KB/tile instead of baking millions of explicit instances). The risk is **cross-client non-determinism** (a scattered tree must land in the *same* place in every viewer or picking/styling breaks across clients). Because determinism is the hard part and is viewer-implementation-coupled, **prove it locally before standardizing.**

**Recommended sequencing:**

1. **Fork-local first (V1–V2, §8):** ship `VegetationScatterCollection` driving placement from a control texture + a small JSON rules block, using a **documented private namespace** (e.g. `_CESIUMWEBGPU_vegetation_scatter` on tile/tileset `3DTILES_metadata`, since underscore/vendor-prefixed unknown extensions are ignored by other viewers per the spec's forward-compat rule). Define a versioned external schema (`vegetation-1.0.json`) for the species palette + per-instance properties so authored (model A) tilesets interoperate immediately.
2. **Propose upstream only after** the fork demonstrates a deterministic seeded scatter (mandate xorshift128/PCG, ideally in WASM, *not* JS `Math.random()`) and a real workload proves the bandwidth win. Then take it to CesiumGS as a 3d-tiles-next draft, ideally co-designed with the open `cesium-unreal#558` landcover thread (shared density/biome raster definition serves both).

**Candidate sketch — `3DTILES_vegetation_scatter`** (rides on existing metadata + semantics; nothing here needs a new binary tile format):

- **Region geometry:** reuse the tile's bounding volume as the scatter extent; optionally an inner clip polygon as a `PropertyTexture` mask (R8 in-region). No new geometry primitive — keeps it metadata-only.
- **Control rasters (KTX2, ~50–80 KB each):** `densityMapUri` (R8 spawn probability), `biomeMapUri` (RGBA8 = biomeId / slopeMask / altitudeZone / reserved). These are ordinary glTF/KTX2 textures referenced by URI — already streamable.
- **Species palette (tileset-level `3DTILES_metadata` class):** array of `{ id, name, glbUri, impostorUri, heightRange, dbhRange, biomeWeights }` — directly expressible *today* in 3DTILES_metadata; the extension only standardizes the property *names*.
- **Placement rules (tile-level JSON):** `{ mode: poisson_disk, minDistance, noiseOctaves/lacunarity/persistence, globalDensityScale, slopeRejectAngle, seedBase, heightSamplingMode }` + a `lodLevels[]` array mapping distance ranges → mesh-LOD index + density falloff (maps 1:1 onto §5.1).
- **Semantics:** define `VEG_DENSITY`, `VEG_BIOME`, `VEG_SPECIES` semantic strings so the rasters/enums are machine-discoverable (the spec's semantics framework is the right hook; today it only ships spatial/structural semantics — this is the additive piece).
- **Client contract:** fetch metadata → fetch rasters → seeded scatter (Poisson-disk rejection sampling, biome-weighted species pick, terrain/depth height sample, RTE-encode) → indirect draw. **Determinism is mandated** (fixed PRNG) so picking/feature-IDs are stable across clients.
- **Explicit-vs-procedural tradeoff (carry both):** explicit (model A, I3DM + metadata) for high-value precise regions (OSM/survey trees — exact positions, perfect determinism, larger payload); procedural (this extension) for global low-detail fill (Global Forest Watch canopy density — tiny payload, approximate positions). Mark which tiles are which via a `3DTILES_metadata` group flag.

**Why our client is well-positioned to consume it (strand 4):** the consumer half already exists. Control-raster sampling reuses the same KTX2/texture path; height sampling reuses `Core/sampleTerrainMostDetailed.js` + the depth-drape mechanism (§4.3); per-instance identity flows through `Scene/Model/ModelFeatureTable.js`; metadata schema parsing is live in `Scene/StructuralMetadata.js` + `Scene/PropertyTable.js`; instancing lands in `Scene/Model/InstancingPipelineStage.js` (WebGL2) and `Renderer/WebGPU/WebGPUModelInstancing.js` (WebGPU). The **only genuinely new artifact** is the scatter compute pass / CPU-worker twin (`VegetationScatter.wgsl`, V1 in §8) — which the plan already builds regardless of whether an extension is ever standardized. The remaining consumer gap is `Scene/PropertyTexture.js` shader wiring (§9 item 5), needed only if density maps are sourced from PropertyTexture rather than a plain control texture.

**Spec sources cited:** 3D Tiles 1.1 / OGC 22-025r4 (https://github.com/CesiumGS/3d-tiles, CHANGES.md, /extensions/3DTILES_metadata, /extensions/3DTILES_implicit_tiling, /specification/Metadata/README.adoc); `EXT_mesh_gpu_instancing` (KhronosGroup/glTF); `EXT_structural_metadata` / `EXT_instance_features` / `EXT_mesh_features` (CesiumGS/glTF 3d-tiles-next); cesium-unreal#558; Cesium blogs (fine-grained metadata 2022-05-31, gaussian-splat LOD 2026-04-27, June-2026 releases 2026-06-01); community.cesium.com forum threads above.
