# WebGPU ↔ WebGL Feature-Parity Report — 2026-07-01

> **POINT-IN-TIME, CODE-GROUNDED SNAPSHOT — SUPERSEDES
> `WEBGPU_PARITY_REPORT_2026-06-30.md`.** This report is a synthesis of seven
> per-subsystem surveys taken against `main` at **HEAD = Batch 480**
> (`c807fd6095`, "FEAT-BUFFERPOLYGON-OUTLINE"), immediately after the parity
> sprint (Batches 459–480). Every status below is anchored to a specific
> file/line, a shipped batch, or an explicit `DEFERRED_WORK.md` /
> `FEATURE_INVENTORY.md` / `PARITY_TO_100.md` entry. Status labels drift as
> batches land; re-run the surveys before quoting these numbers in a later
> session.
>
> **Read §2 and §4 together.** The headline percentage went *down* versus the
> 2026-06-30 report while the codebase got materially *better*. That is a
> granularity effect (255 → 310 features, ~25 newly surfaced residual rows),
> not a regression — the like-for-like re-score of the old surface is ≈96 %
> weighted. Do not quote the raw delta without that context.

---

## 1. Methodology

Seven subsystem surveys were performed, each enumerating concrete features and
assigning one of five WebGPU statuses against the WebGL baseline:

| Status | Meaning |
| --- | --- |
| **full** | Real implementation at WebGL parity; verified by probe, shipped-batch reference, or code inspection. |
| **webgpu-exceeds** | A capability WebGL Cesium does not have at all (TAA, SSR, dynamic env capture, GPU cull, …) or where WebGPU renders *more correctly* than WebGL (Buffer\* in Columbus View). **Counted as `full` for all parity math**; tallied separately so the bonus tier is visible. |
| **partial** | Works for the common case but has a documented gap (a missing variant, a scene-mode hole, an HDR/precision edge, a convention offset, or verification-only debt). |
| **stub** | Intentional no-op / placeholder scaffold; the consumer half exists but the producer half (or the wiring) is unimplemented. |
| **missing** | No WebGPU implementation; deferred, gated, or research-stage. |

Backend-agnostic CPU-side code (terrain providers, imagery providers,
DataSource loaders, property evaluators, tile traversal) is counted **full**
because it is shared by both backends — same convention as the prior report.

### Parity definitions (identical formulas to 2026-06-30)

- **Strict** = `(full + exceeds) / total`. Only fully-shipped features.
- **Weighted** = `(full + exceeds + 0.5 × partial) / total`. **Headline.**
- **Generous** = `(full + exceeds + partial) / total`. Optimistic upper bound.
- **Adjusted** = the same three, excluding the **6 `missing` rows that are
  deferred-by-design** (BufferPrimitive non-DOUBLE datatypes ×2 subsystem rows,
  VSM/ESM, linear-depth cast, tile-per-cascade WSM, GLSL→WGSL CustomShader
  transpile) from the denominator. By-design *partials* keep their half-credit
  inside the tally, exactly as before.

### Granularity warning (the biggest change vs 2026-06-30)

This audit enumerates **310 features vs 255**. The deeper pass decomposed
coarse rows (voxels went from one "stub" row to six rows; post-process went
from 37 to 30 but now itemizes 7 orphaned library stages) and surfaced ~25
residuals the prior report never counted (model runtime-styling stubs, model
scene-mode hole, billboard anchoring, globe translucency alpha,
undergroundColor, ColorGrading reachability, …). Percentages are therefore
**not directly comparable** to the prior report; §4 provides the
apples-to-apples view. As the prior report said: the full/partial/stub/missing
*ratio* is the durable signal, not the absolute point value.

---

## 2. The Parity Number

| Definition | Formula | Result |
| --- | --- | --- |
| **Strict** | 249 / 310 | **80.3 %** |
| **Weighted (headline)** | (249 + 0.5·37) / 310 | **86.3 %** |
| **Generous** | (249 + 37) / 310 | **92.3 %** |
| Adjusted strict (excl. 6 by-design `missing`) | 249 / 304 | 81.9 % |
| Adjusted weighted (excl. 6 by-design `missing`) | 267.5 / 304 | **88.0 %** |
| Adjusted generous (excl. 6 by-design `missing`) | 286 / 304 | 94.1 % |

**`webgpu-exceeds` count: 31 of the 249 full-equivalents** (10 % of the entire
surface is *beyond* WebGL: TAA, SSR, GTAO, god-rays, volumetric fog,
procedural clouds, aerial perspective, heat-shimmer, cold-optics, NPR
outlines, contact shadows, HDR canvas, dynamic env capture, star catalog, GPU
cull/Hi-Z/indirect/bundles/cluster-binning/LOD-scan, night-lights, enhanced
ocean, Buffer\* correct-in-CV, ComputeInstanceCollection, …).

**Bottom line: 86.3 % weighted parity on a 310-feature surface (88.0 % once
by-design deferrals are excluded), with 80.3 % fully shipped and a 31-feature
bonus tier WebGL does not have. Like-for-like against the 2026-06-30 surface,
the sprint moved real parity from 90.8 % weighted to ≈96 % weighted.**

---

## 3. Per-Subsystem Tally

`full*` = full + webgpu-exceeds (exceeds shown separately).

| # | Subsystem | full | exceeds | partial | stub | missing | total | strict % | weighted % |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | Globe & Imagery | 25 | 3 | 3 | 0 | 1 | 32 | 87.5 % | 92.2 % |
| 2 | 3D Tiles | 33 | 1 | 10 | 2 | 2 | 48 | 70.8 % | 81.3 % |
| 3 | glTF Models + KHR | 43 | 1 | 7 | 3 | 4 | 58 | 75.9 % | 81.9 % |
| 4 | Geometry & Collections † | 31 | 3 | 6 | 0 | 1 | 41 | 82.9 % | 90.2 % |
| 5 | Picking / Shadows / Lighting | 36 | 3 | 8 | 1 | 3 | 51 | 76.5 % | 84.3 % |
| 6 | Post-process & Effects | 9 | 12 | 2 | 7 | 0 | 30 | 70.0 % | 73.3 % |
| 7 | Entity / DataSource + Perf | 41 | 8 | 1 | 0 | 0 | 50 | 98.0 % | 99.0 % |
| | **TOTAL** | **218** | **31** | **37** | **13** | **11** | **310** | **80.3 %** | **86.3 %** |

† The geometry-collections survey header tallies 41 rows; its itemized list
enumerates 40 (one full-row delta). Header counts are used; the discrepancy is
below rounding noise.

**Reading the weakest-looking rows correctly:**

- **Post-process (73.3 %) is an artifact of the stub cluster**: 7 of its 30
  rows are the orphaned `PostProcessStageLibrary` built-ins (BlackAndWhite,
  Brightness, NightVision, Silhouette, EdgeDetection, LensFlare, DepthView) —
  pre-translated WGSL assets that nothing imports. Every *live* WebGL PP
  feature (Bloom, AO, DoF, FXAA, tonemap ×5, auto-exposure, OIT, EDL, f16
  variants) is full, and 12 rows exceed WebGL outright.
- **3D Tiles (81.3 %) and Models (81.9 %) carry the fine-grained long tail**:
  voxel residuals, the metadata multicomponent/UINT16-32/texture-table trio
  (counted in three subsystems), the three model runtime-styling stubs, and
  the model scene-mode hole. The core render paths (B3DM/I3DM/PNTS/CMPT/glTF/
  splats, full PBR + all 7 KHR materials, skinning, morphs, instancing, IBL,
  shadows, styling, picking) are all full.
- **Entity/DataSource + Perf (99.0 %)** is effectively done; its only partial
  is a WebGPU-only optimization (GPU sort-keys generated but not yet consumed
  for command ordering).

---

## 4. Delta vs 2026-06-30 — the apples-to-apples view

Prior report (Batch 458, 255 features): **strict 86.3 % / weighted 90.8 % /
adjusted-weighted 93.7 %** (220 full / 23 partial / 4 stub / 8 missing).

This report (Batch 480, 310 features): **strict 80.3 % / weighted 86.3 % /
adjusted-weighted 88.0 %**.

### 4.1 The raw −4.5 pp headline is composition, not regression

Two things happened simultaneously:

1. **The sprint (B459–480) closed 20 of the prior report's ~35 gap rows
   outright and materially improved 5 more** (§4.2).
2. **The re-survey enumerated 55 more features and surfaced ~25 residual rows
   the prior report never counted** (§4.3). Newly-counted debt mechanically
   dilutes the percentage even though no code got worse.

**Like-for-like re-score:** applying today's statuses to the prior 255-feature
surface gives ≈240 full / ≈11 partial / 1 stub / ≈5 missing → **≈96 % weighted
(+5 pp of real progress since 2026-06-30)**. The honest one-liner is:
*"the sprint moved true parity from ~91 % to ~96 % weighted; the finer audit
then re-based the surface to 310 features, on which the same code scores
86.3 % weighted / 88.0 % adjusted."*

### 4.2 Prior gap rows CLOSED by the sprint (20)

| Prior-report row | Closed by |
| --- | --- |
| Clipping planes on glTF models (missing) | B466 — clips `positionEC` eye-space, union + intersection |
| WGF-1 INTERSECTION-mode clipping (missing, by-design) | shipped — globe + model clip support intersection (`clippedCount==count`) |
| Hardware clip-distances expansion (partial) | models done (B466); "primitives clipping" reclassified not-a-Cesium-feature |
| Clipping planes on primitives (stub) | reclassified — generic-primitive clipping does not exist in upstream Cesium |
| Globe point/cube-light shadow receive (missing\*) | reconciled full (B108 + B298 sign fix; the 06-30 report already flagged the conflict) |
| GlobeWater facade (partial) | full + exceeds (B58/B78 additive parity; foam/GGX/3-octave WGSL-only extras) |
| ClassificationPrimitive standalone (partial "marker no-op") | B469 — verified REAL renderer since B130; stale docs reconciled + probe added |
| EXT_structural_metadata epic row (partial) | DP-H46 a–f CLOSED (B454–463); fine-grained residuals now tracked as their own rows |
| Model metadata picking / DP-H46e (partial ×2 rows) | B460 producer + B463 demo/probe |
| Point Cloud EDL (stub) | B465 — full data path (offscreen FBO, depth-writing variant, neighbor blend) + fixed the non-functional standalone point-cloud renderer + TimeDynamicPointCloud |
| Hi-Z tile bounding-volume integration (partial) | B472 — OBB enclosing-radius fix, no more NaN-poisoned radius SOA |
| Vector-tile Buffer\* 2D/CV (partial) | B467 — shared `projectBufferPositionForMode` in all three renderers + 9→8 vertex-buffer INVALID-pipeline fix |
| BufferPointCollection 2D/CV (partial) | B467 — now *exceeds* (correct in CV where WebGL is misplaced) |
| BufferPolygonCollection 2D/CV + outline (partial) | B467 + B480 — outline shipped on BOTH backends |
| PolylineCollection 2D/CV (partial) | probe-verified 3D/2D/CV errs=0 |
| GroundPolylinePrimitive 2D/CV/Morph (partial) | full (B164/B170 lineage, probe-verified) |
| GeoJsonPrimitive verification probe (partial ×3 rows) | B318 probe (`probe-geojson-primitive.mjs`) |
| f16 PP variant expansion (partial) | B478 — f16 variants for ALL effects, double-gated, f32 byte-identical default |
| FXAA-on-HDR math (half of a partial row) | B479 — HDR-aware FXAA reachable at runtime |
| Standalone model pick (implicitly open) | B470 — regression probe confirms parity already held |

### 4.3 Prior gap rows IMPROVED but retaining a narrower residual (5)

| Prior-report row | What improved | What remains |
| --- | --- | --- |
| Voxels (one XL stub) | Real root-tile megatexture upload (B474), shape-OBB world placement (B475, IoU 0.994), WebGL color parity (B476), primitive pick | octree/LOD traversal **missing**, user CustomShader→WGSL **stub**, per-cell pick **stub** (B477 blocker doc), non-box shapes **partial** |
| Custom Shaders WGSL injection (no-op) | B473 — native-WGSL fragment+vertex body injection is REAL, with user UBO uniforms + textures | reduced varying surface (no positionWC/tangent/TEXCOORD_1/featureIds/metadata; VS output positionMC-only); GLSL transpile now by-design-missing |
| BufferPolylineCollection 2D/CV | CV + 3D correct (B467) | blank in SCENE2D only (screen-space extrusion lacks the 2D camera-axis convention) |
| ColorGrading + FXAA on HDR | HDR-aware math implemented for both (B479); FXAA reachable | ColorGrading stage has ZERO runtime call sites — never instantiated, so its HDR path is unreachable |
| EXT_structural_metadata fine grain | display + pick shipped | multicomponent attrs (.x-only), UINT16/32 packing, TEXTURE/instance/implicit-sourced tables |

### 4.4 Newly surfaced residuals (never counted on 2026-06-30)

Globe translucency per-fragment alpha; globe undergroundColor (+alpha-by-
distance); clipping-polygon geodetic-vs-geocentric latitude offset (≤0.19°);
globe HDR gamma no-op; Model.color/colorBlendMode, silhouette, and splitter
stubs (orphaned WGSL scaffolds); model 2D/CV/Morph missing; glTF POINTS-mode
missing; metadata→style-expression consumption missing; native CustomShader
varying-surface limits; KHR_volume approximation; billboard eyeOffset/origin
anchoring (untracked until this audit); the 7 orphaned PP library stages;
ColorGrading reachability; pick clip-plane coverage; sync pick/drillPick
staleness (intrinsic); point-sprite round-vs-square (×2); voxel non-box
shapes; GPU sort-keys consumption; CSM cascade-0 resolution. These add ~25
rows of (mostly small, mostly opt-in) debt to the denominator.

---

## 5. Sprint-Shipped List (Batches 459–480)

| Batch | Commit | What shipped |
| --- | --- | --- |
| 459 | `aaa4cd0b79` | 2026-06-30 parity report (the baseline this report supersedes) |
| 460 | `061f6914f0` | DP-H46e — `scene.pickMetadata` WebGPU producer (opt-in; color + regular pick byte-identical) |
| 461 | `78d0936af1` | Doc review round 1 — 84 verified additions to the 7 canonical docs; BUILD_AND_VARIANTS NUL-corruption recovery |
| 462 | `926954ee51` | Doc review round 2 — corrected two stale "blocked" claims |
| 463 | `8c10431cbc` | DP-H46f — metadata-pick Sandcastle demo + consolidated probe; **DP-H46 epic CLOSED** |
| 464 | `13bcf23c96` | `PARITY_TO_100.md` — code-grounded, tiered, dependency-sequenced parity task list |
| 465 | `5fa089eaf3` | PARITY-PC-EDL — Point Cloud EDL stub→full + fixed the non-functional standalone WebGPU point-cloud renderer (+ TimeDynamicPointCloud) |
| 466 | `4bc1ac3edd` | PARITY-CLIP-PLANES — model clipping planes clip the correct (eye) space |
| 467 | `0fad5f5834` | PARITY-BUFFER-2DCV — Buffer\* 2D/CV/Morph reprojection + BufferPolyline 9→8 vertex-buffer INVALID-pipeline fix |
| 468 | `1adcae47e0` | PARITY_TO_100 reconcile — Spines A + B landed, follow-ups surfaced |
| 469 | `f6baadf870` | PARITY-GPRIM-CLASSIFY-STANDALONE — standalone ClassificationPrimitive verified REAL (stale marker-no-op docs reconciled + probe) |
| 470 | `ed53544d74` | Standalone-model-pick regression probe — parity already held (stale-premise reconcile) |
| 471 | `0b4c3a06d4` | Verification-sweep reconcile — the real fire-list |
| 472 | `4219f2b483` | PARITY-HIZ-TILE-BOUNDING — Hi-Z no longer NaN-poisons OBB-bounded 3D-tile bounds |
| 473 | `c69f80a931` | PARITY-CUSTOM-SHADER-WGSL — native-WGSL model CustomShader body injection (was a no-op) |
| 474 | `9139e64234` | Voxel data-path increment 1 — real root-tile megatexture upload |
| 475 | `8f1c3e745a` | PARITY-VOXEL-SHAPE-PARITY — proxy cube at the shape's OBB world transform (IoU 0.994) |
| 476 | `23abf6a720` | PARITY-VOXEL-COLOR-PARITY — default-customShader gray + front-to-back accumulation matches WebGL |
| 477 | `e76f31b9f8` | C-R9-VOXEL-CELL-PICK blocker documented (shape-UV convention gap; prototype reverted) |
| 478 | `66f2807273` | PARITY-F16-POSTPROCESS — f16 variants for all PP effects (opt-in, f32 byte-identical default) |
| 479 | `bda8fb0c8b` | PARITY-HDR-PP-MATH — ColorGrading + FXAA HDR-aware math under HDR canvas output |
| 480 | `c807fd6095` | FEAT-BUFFERPOLYGON-OUTLINE — outlineColor/outlineWidth on BOTH backends (was unimplemented on both) |

---

## 6. THE REMAINING GAP — grouped by blocker type

61 subsystem-level rows are not `full` (37 partial + 13 stub + 11 missing);
after cross-subsystem dedup they collapse to **~45 unique work items**.
Grouped by what blocks each one.

### 6.1 Convention-blocked (a coordinate/axis convention must be plumbed first)

| Item | Status | Subsystem(s) | What's missing |
| --- | --- | --- | --- |
| Voxel per-cell pick (`pickVoxelCoordinate`) | **stub** | 3D Tiles, Picking | Full pipeline was prototyped end-to-end then REVERTED (Y/Z-wrong cells). Blocked on reproducing `convertLocalToShapeUvSpace` (world→shapeUv axis convention) in the WGSL ray-march. C-R9-VOXEL-CELL-PICK, blocker doc B477. |
| Voxel non-box shapes (ellipsoid/cylinder) | partial | 3D Tiles | OBB proxy placement works for any shape, but density sampling is box-uvw only — same shapeUv convention family as cell pick. |
| BufferPolyline in SCENE2D | partial | Geometry, 3D Tiles | Blank in 2D only (3D + CV correct): `computeActualEllipsoidPosition` collapses projected x==0 and the screen-space extrusion lacks the 2D camera-axis convention. NEW-BUFFERPOLYLINE-2D-EXTRUSION. |
| Globe clipping polygons — geodetic lon/lat | partial | Globe | FS derives SDF-lookup lon/lat from *geocentric* atan2 (GlobeTerrain.wgsl:3003-3006) while the SDF is authored geodetic → clip boundary offset ≤ ~0.19° lat on WGS84; polar edge-width is a hand-tuned 0.001. |

### 6.2 Asset-blocked (ships safe; pixel-verify needs a test asset)

| Item | Status | Subsystem(s) | What's missing |
| --- | --- | --- | --- |
| Ellipsoid-aware RTE (non-WGS84) | partial | 3D Tiles, Picking | `WebGPUCSMRenderer.ts:74-79` hardcodes WGS84 radii; `tileset._ellipsoid` never threaded. Mars/Moon tilesets positionally wrong in ground-clamp/RTE. Verify blocked on a Mars/Moon asset. PARITY-RTE-ELLIPSOID-AWARE. |
| Vector3DTile classifiers (.vctr) in 2D/CV | partial | 3D Tiles, Geometry (×3 renderers) | Primitive classifier 2D/CV implemented (B178) but e2e-UNVERIFIED for lack of .vctr test data; Polylines + ClampedPolylines 2D/CV still gated (NEW-CLASSIFIER-2D-CV-MORPH). Morph shipped B207/B208. |

### 6.3 Device-blocked (verification only — code counted full)

| Item | Status | Subsystem(s) | What's missing |
| --- | --- | --- | --- |
| f16 PP variants ON-path pixel-verify | full (verification debt) | Post-process | Dev Pascal GPU lacks `shader-f16`; code complete + double-gated + f32 byte-identical, but the f16-ON path has never been visually diffed. Needs any RTX-class device. |

### 6.4 Dependency-blocked (needs another gap item first)

| Item | Status | Subsystem(s) | What's missing |
| --- | --- | --- | --- |
| Voxel user CustomShader → WGSL (metadata color) | **stub** | 3D Tiles | Only the default gray customShader is honored; user scalar-ramp/vec4 metadata color injection depends on octree traversal (§6.5 #1) landing first. PARITY-VOXEL-CUSTOM-SHADER-WGSL. |

### 6.5 Unstarted — genuine parity debt, no external blocker

| # | Item | Status | Subsystem(s) | What's missing |
| --- | --- | --- | --- | --- |
| 1 | Voxel octree / multi-tile LOD traversal | **missing** | 3D Tiles | Only the ROOT tile uploads/renders; no WGSL Octree.glsl port, no multi-tile megatexture atlas. Large/streaming voxel sets show the coarsest tile only. PARITY-VOXEL-OCTREE-TRAVERSAL — **XL, the single biggest remaining hole.** |
| 2 | Model rendering in 2D / Columbus View / Morph | **missing** | glTF Models | `WebGPUModelRenderer.js` has zero SceneMode branches; models only correct in SCENE3D (no WebGL fallback inside a WebGPU scene). Largest remaining scene-mode-pillar hole. |
| 3 | glTF POINTS-mode primitives | **missing** | glTF Models | Every model pipeline is hardcoded `triangle-list`; `ModelPointCloudStylingStage.wgsl` orphaned. POINTS primitives cannot render. |
| 4 | Structural-metadata → Cesium3DTileStyle / CustomShader consumption | **missing** | glTF Models, 3D Tiles | Metadata reaches the shader only for debug display + pick; never feeds runtime style expressions or CustomShader metadata inputs (WebGL's MetadataPipelineStage does). |
| 5 | Globe undergroundColor + undergroundColorAlphaByDistance | **missing** | Globe | No uniform, no FS blend anywhere in the WebGPU path (only a stale comment at GlobeTerrain.wgsl:1368). Camera-underground cull-disable exists; the tint does not. Opt-in feature. |
| 6 | Model.color / colorBlendMode / colorBlendAmount | **stub** | glTF Models | `ModelColorStage.wgsl` orphaned (never imported); setting `model.color` has no effect on the model body (only edge fallback reads it). |
| 7 | Model silhouette (silhouetteColor/Size) | **stub** | glTF Models | `ModelSilhouetteStage.wgsl` orphaned; no silhouette pipeline/renderState variant emitted. |
| 8 | Model splitter (splitDirection) | **stub** | glTF Models | `ModelSplitterStage.wgsl` orphaned; `model.splitDirection` no-ops. Smallest of the three model stubs (FS discard wire-up). |
| 9 | PostProcessStageLibrary built-ins ×7 (BlackAndWhite, Brightness, NightVision, Silhouette, EdgeDetection, LensFlare, DepthView) | **stub ×7** | Post-process | Pre-translated WGSL assets exist but NOTHING imports them; the named GLSL library stages hit the GLSL-drop warning and no-op. Needs one named-stage interception mechanism routing to the WGSL assets. |
| 10 | ColorGrading runtime caller | partial | Post-process | Everything implemented (shader, packer, HDR math, f16 twin) but `addColorGrading` has ZERO call sites — stage never instantiated, so it (and its B479 HDR path) is unreachable. S-effort wire-up. |
| 11 | Globe translucency per-fragment alpha | partial | Globe | All 9 derived-command blend/cull/depth variants wired (`WebGPUGlobeTranslucencyState.ts`) and multi-pass runs, but frontFace/backFace/translucencyByDistance alpha is never threaded into the FS — enabled globe still composites opaque. |
| 12 | Globe HDR gamma-encode | partial | Globe | `czm_gammaCorrect` deliberately no-ops (GlobeTerrain.wgsl:806-812); wrong only under the new B479 HDR canvas path. Narrow. |
| 13 | Metadata multicomponent property attributes (VEC2/3/4) | partial | 3D Tiles, glTF Models, Picking | Only `.x` transported over the single f32 vertex slot; other components zero-filled. PARITY-METADATA-MULTICOMPONENT-ATTRS. |
| 14 | Metadata UINT16/UINT32 channel-packing | partial | 3D Tiles, glTF Models, Picking | RGBA8-only property-texture/table packing; wide integers quantize incorrectly. PARITY-METADATA-UINT16-UINT32-PACKING. |
| 15 | Metadata TEXTURE / instance / implicit-sourced property tables | partial | 3D Tiles, glTF Models, Picking | Only ATTRIBUTE-sourced feature IDs key a property table. PARITY-METADATA-TABLE-TEXTURE-SOURCES. |
| 16 | Native-WGSL CustomShader varying surface (FS + VS) | partial ×2 | glTF Models | FS exposes only positionMC/positionEC/normalEC/texCoord_0/color_0 (no positionWC, tangent, TEXCOORD_1, featureIds, metadata); VS custom output is positionMC-only. |
| 17 | Billboard eyeOffset + horizontalOrigin/verticalOrigin | partial | Geometry & Collections | Main VS renders center-anchored with raw pixelOffset; the origin/eyeOffset helper is used only for the depth-check sample points. Labels unaffected (glyph `_translate` baked into pixelOffset); standalone non-CENTER-origin billboards positionally wrong. **Newly surfaced — was untracked; add to DEFERRED_WORK.** |
| 18 | Pick shaders honor clipping planes | partial | Picking | Color path clips (B466) but pick FS variants don't — clipped-away geometry is still pickable. PARITY-CLIP-PICK-SHADER-COVERAGE. |
| 19 | Edge authored silhouetteNormals accessor | partial | 3D Tiles, glTF Models | Always re-derives from triangle adjacency; authored signed-byte accessor ignored (can diverge from WebGL edge classification). Niche. |
| 20 | GPU sort-keys consumption | partial | Entity/Perf | Bitonic sort runs but sorted order is NOT consumed for command ordering (JS sort authoritative — WebGPUSceneRenderer.ts:3710-3714). WebGPU-only optimization, phase-2 pending. |

### 6.6 Decision-blocked

| Item | Status | Subsystem(s) | What's missing |
| --- | --- | --- | --- |
| Point-sprite shape (round vs square) | partial ×2 | Geometry, 3D Tiles | WebGPU renders anti-aliased round discs; WebGL renders square `gl_PointCoord` sprites (~44 % of the pc-edl probe diff). Round is arguably better; match-vs-document decision unresolved. PARITY-POINT-SPRITE-SHAPE. |

### 6.7 By-design / intrinsic (not near-term parity debt)

The 6 `missing` rows here are excluded from the *adjusted* denominator;
by-design *partials* keep half-credit.

| Item | Status | Why deferred |
| --- | --- | --- |
| GLSL CustomShader → WGSL transpile (models) | missing (by-design) | Native WGSL is the chosen design; GLSL `fragmentShaderText` warns + no-ops. Real gap vs WebGL, deliberate stance. |
| User custom PP stages authored in GLSL | partial (by-design) | Same stance: WGSL custom stages fully supported; GLSL stages dropped with warning (PARITY-CUSTOM-SHADER-TRANSPILE). |
| BufferPrimitive non-DOUBLE datatypes | missing ×2 (by-design) | Needs snorm/unorm pipeline variant; DOUBLE (the authoring path) unaffected; detection guards shipped B318. BYDESIGN-BUFFER-PRIMITIVE-NORMALIZED-DATATYPES. |
| VSM / ESM shadow maps | missing (by-design) | 3×3 PCF is the production path. BYDESIGN-VSM-ESM-SHADOWS. |
| Linear-depth shadow cast | missing (by-design) | Perspective-Z round-trips correctly; parked micro-optimization. |
| Tile-per-cascade WSM (+ per-tile CSM cascade assignment) | missing + partial (by-design) | Uniform cascade fit is the current approach; CSM slices 3-4. BYDESIGN-TILE-PER-CASCADE-WSM. |
| CSM cascade-0 resolution | partial (by-design) | 1024² vs WebGL 2048 single map — edge-sharpness/VRAM trade-off, accepted. |
| CSM altitude-adaptive splits + moon dual-light | partial (by-design) | Fixed λ=0.7; CSM slices 3-4. |
| PCSS blocker-search | partial (by-design) | PCF is production; contact-shadows post effect exists (exceeds). |
| Sync `scene.pick` cold-start / sync `drillPick` | partial ×2 (intrinsic) | WebGPU has no synchronous readback; one-frame-stale with warm-up; `pickAsync`/`drillPickAsync` are the steered paths. |
| KHR_materials_volume full physical path | partial (by-design approximation) | Approximate Beer-Lambert coupled to transmission covers the common glass case; full volumetric transmission not ported. |

---

## 7. Path to 100 %

Closing everything in §6.1–6.6 (the ~30 genuinely-open unique items) lifts
this 310-feature surface to roughly **strict ≈95 %, weighted ≈96–97 %**
(adjusted ≈98–99 %); the rest is the by-design ledger. Suggested sequencing:

1. **Quick wires (S each, days):** model splitter FS discard; `Model.color`/
   colorBlendMode uniform threading; ColorGrading `addColorGrading` call site;
   one named-stage interception routing the 7 orphaned PP library WGSL assets;
   billboard origin/eyeOffset anchoring; pick-shader clip-plane coverage.
   These are cheap because the shaders already exist — only wiring is absent.
2. **Scene-mode pillar (M/L):** model 2D/CV/Morph reprojection (the biggest
   user-visible hole for entity-heavy apps), then the BufferPolyline 2D
   camera-axis convention, then Vector3DTile classifier 2D/CV verification
   (needs a .vctr asset).
3. **The voxel epic (XL):** octree/multi-tile LOD traversal → then the
   dependent user-CustomShader stub → then per-cell pick via the shapeUv
   convention plumb (B477 blocker doc) + non-box shapeUv mapping. This single
   epic clears 4 of the remaining rows and is the largest coherent block.
4. **Metadata long tail (M):** multicomponent attrs → UINT16/32 packing →
   texture/instance/implicit-sourced tables → style-expression/CustomShader
   consumption. Clears 4 unique items across three subsystems (10 rows).
5. **Globe opt-in trio (M):** translucency per-fragment alpha,
   undergroundColor, clipping-polygon geodetic lat (+ the narrow HDR gamma).
   All default-off, byte-identical today when unset.
6. **CustomShader surface expansion (M):** widen FS varyings + VS outputs.
7. **Verification unblocks (external):** an RTX-class device for f16 ON-path
   pixels; a Mars/Moon tileset for ellipsoid-RTE; .vctr test data for the
   classifier scene modes.
8. **Decide-and-document:** point-sprite round-vs-square (either match WebGL
   squares or codify round as the fork's documented divergence).

---

## 8. Caveats & reconciliation notes

- **EquirectangularPanorama cull-override fell out of the enumeration.** The
  06-30 report tracked it (partial — `WebGPUPrimitiveCommands.js` ignores
  `renderState.cull.enabled:false`); the new globe survey excluded it as
  mis-bucketed (it is a shared Primitive derived-command issue) but no other
  survey picked it up. It is NOT counted in the 310-row tally. Re-add it to
  the Geometry/Primitives inventory so it doesn't get lost. (WGF-1 /
  C-R1-PRIMITIVE-DERIVED.)
- **Geometry-collections header/list off-by-one** (§3 footnote): header
  tallies 41 rows, itemized list 40. Header used; impact < 0.1 pp.
- **The sky-atmosphere inscatter-LUT fast path is disabled**
  (`ENABLE_SKY_INSCATTER_LUT=false`, NEW-ATMOSPHERE-LUT-SUN-RELATIVE). Counted
  full because the Nishita ray-march path is at parity — this is a perf
  optimization, not a parity gap.
- **Verification debt ≠ feature gap.** f16 ON-path (device), ellipsoid-RTE
  (asset), and Vector3DTile 2D/CV (asset) are code-complete-or-mostly paths
  waiting on external verification inputs.
- **By-design partials still get half-credit** in weighted/adjusted numbers
  (same as 06-30). If you also excluded the ~10 by-design/intrinsic partial
  rows, adjusted-weighted would rise ~1 pp further.
- **Granularity sensitivity** (unchanged caveat from 06-30): a coarser or
  finer enumeration shifts the percentage by points; the durable signal is the
  ratio — **70 % full / 10 % exceeds / 12 % partial / 4 % stub / 4 % missing**
  of a 310-feature surface, with all default-scene paths at parity and the
  remaining debt concentrated in opt-in features, scene-mode edges, and the
  voxel epic.
- Per the user's 2026-06-30 doc-archival HOLD, the 06-30 report file was not
  edited or moved; this report's banner is the only supersession pointer.
