# CesiumJS 1.145 → WebGPU parity census

**Provenance.** Measured tip `dcf7c9c069` (below, §Scope) is the **pre-re-land** hash of Batch 1429; that same batch is `556f06484e` on origin as of this banking, and no content below is altered by the re-land.
Banked verbatim from `_lane-out/SYNC_1145_WEBGPU_PARITY_CENSUS.md` (lane Malach), workflow `wf_27cc7481-694`, synthesised 2026-09-05.

**Scope.** Upstream change = `git diff 6d5d8b1f07 488b114e16 -- packages/engine/Source` (68 files).
Twin surface = `packages/engine/Source/Renderer/WebGPU/` + `packages/engine/Source/Shaders/WebGPU/`
at `main` = **Batch 1429 `dcf7c9c069`**. Read-only. 11 reader groups (duplicated subjects merged:
globe+imagery read three times, "G7 remainder" three times), 209 findings, refuter adjudicated.
Synthesised 2026-09-05 after the workflow's own synthesis step was cut mid-write.

---

## 1. Answer

**No — with one exception, the fork did not add 1.145's new renderer functionality to WebGPU.**
The merge (Batch 1408, `ffb8161c08`) landed 1.145's shared JS and its GLSL faithfully, and Batch 1410
ported one WGSL leg (draped-polyline half-width / AA / nearest-edge, Edge-verified gate B countRatio
1.000 in Éowyn job 6). Everything else 1.145 added on the renderer surface is **WebGL-only at HEAD**:
the draped-vector feature's polygon-fill, pick-colour and metres-width legs; its extension onto models
and 3D Tiles (`ModelVectorLookupPipelineStage.js`, +205, a whole new stage); and the clipping-polygon
rewrite, where the WebGPU globe still runs the signed-distance algorithm **upstream deleted**
(`grep vectorClip packages/engine/Source/Shaders/WebGPU/` = 0 hits; `GlobeTerrain.wgsl:3797-3888`
`globeClipByPolygon` survives). Several 1.145 JS additions run on both backends and produce data
WebGPU cannot consume, so the fork pays their cost without their behaviour.

**Counts after refutation (209 findings):** PRESENT **25** · PARTIAL **35** · ABSENT **48** ·
NA **77** · UNADJUDICATED **23** · did-not-survive **1**. The 83 PARTIAL/ABSENT findings merge to
**22 distinct subjects** (§3).

**Four largest gaps**, by user-visible severity:

1. **Draped vector POLYGON fills** — no WGSL implementation on either surface; a polygons-only bake is
   *claimed* by WebGPU (`VectorPipeline.js:676-679` → `:768-780` returns true) and then dropped
   (`WebGPUVectorTileResources.ts:172-177` returns null). Clamped GeoJSON/MVT areas paint on WebGL,
   nothing on WebGPU.
2. **Draped vectors on models / 3D Tiles** — the entire new stage (geometry, colour, pick) has no
   WGSL twin; `CLAMP_TO_3D_TILE` / `CLAMP_TO_GROUND` content is baked, uploaded and never read.
3. **Clipping-polygon algorithm divergence** — WebGL now ray-casts exact edge tables; WebGPU samples
   an SDF atlas. Consequences are live today: 1.145 `holes` are clipped solid on WebGPU
   (`ClippingPolygonSdfPack.js:49-58`), more than 8 merged extents are silently unclipped
   (`GlobeTerrain.wgsl:3830` `min(extentsCount, 8u)`, `:679` `array<vec4<f32>, 8>`), and model clip
   boundaries drift because WebGPU reconstructs an absolute f32 world position where 1.145 rewrote the
   stage to use a camera-relative geodetic delta.
4. **Draped-vector picking** — no pick-colour run in the WebGPU word layout, no `vectorPickColorOver`
   twin, no per-fragment nearest-primitive record. `scene.pick` over a draped line/area returns the
   primitive on WebGL and the globe (or nothing) on WebGPU.

Runner-up, and the easiest to see: **metres-width polylines render as pixel widths on WebGPU** on
*both* the draped path and the non-draped `BufferPolylineCollection` path — an 8 m road is drawn 8 px
wide at every altitude.

---

## 2. Completeness check

`git diff --name-only 6d5d8b1f07 488b114e16 -- packages/engine/Source` = **68 files**. The union of the
11 groups' claimed-file lists = **65 files** (after stripping annotations). **Eight changed files were
claimed by no group** (`Shaders/PolygonSignedDistanceFS.glsl` *was* claimed, by the clipping group):

| Unclaimed file | Upstream delta | Why it matters |
| --- | --- | --- |
| `Scene/Cesium3DTileset.js` | +95/-9 | New `vectorBlendOption` public accessor (default `BlendOption.TRANSLUCENT`) and the clipping-polygon `polygonAdded`/`polygonRemoved` listeners → `_clippingPolygonsNeedRebake` |
| `Scene/Cesium3DTile.js` | +12 | `tile.clippingPolygonsNeedRebake` — the flag the rebake broadcast sets |
| `Scene/Cesium3DTilesetCache.js` | +15 | New `forEachLoadedTile` — the walk that broadcasts the rebake |
| `Scene/Cesium3DTilesetBaseTraversal.js` | +18/-1 | Traversal side of the same |
| `Scene/GeoJsonPrimitive.js` | +138/-26 | `options.heightReference` + `options.scene` — the public entry point to model/3D-Tiles draping |
| `Scene/VectorGltf3DTileContent.js` | +13/-4 | `markSelected` → `markForFrame(collection, frame, heightReference)`, `collection.blendOption = tileset._vectorBlendOption`, new `VectorProvider.isSupported` gate |
| `Scene/MVTDataProvider.js` | +9 | `heightReference` documentation for the same feature |
| `Scene/GltfLoader.js` | +62/-9 | New `overrideSamplerFilters` + min/mag filter override parameters on `loadTexture` — **unexamined for a WebGPU twin**; the only unclaimed hunk outside the drape/clip clusters |

Seven of the eight feed the two clusters this census already ranks first and second (model/3D-Tiles
draping; clipping rebake) and change nothing in the ranking. **`GltfLoader.js`'s sampler-filter
override is a genuine coverage hole** — no reader asked whether the WebGPU texture path honours a
per-`textureInfo` minification/magnification override. That is the one question this census cannot
answer, and it is cheap to close.

---

## 3. Gap table — PARTIAL and ABSENT only, merged across duplicate groups, ordered by user-visible severity

Tier/size use the queue's vocabulary. "Tracked" cites the row that owns it **today**.

### A. Visible at defaults

| # | Upstream change | Twin evidence at HEAD | Gap | User-visible effect | Tracked | Tier/size | Acceptance |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **C-01** Polygon draping *(VEC-08, MVL-05, G145-03, GI-06/g10)* **ABSENT** | `VectorCommon.glsl` @@ -115,42 +209,22 re-gates `vectorPolygonRender` behind `HAS_VECTOR_POLYGONS` via the shared `vectorCellRange`; `GlobeSurfaceShaderSet.js` key bit 35; `VectorProvider` reports `hasPolygons` on every bake | 0 hits for `vectorPolygonRender`/`polygonEdge`/`HAS_VECTOR_POLYGONS` under `Shaders/WebGPU/` + `Renderer/WebGPU/` (re-verified by me); `WebGPUVectorTileResources.ts:29-37` word layout is polyline-only; `:172-177` returns null unless the three polyline tables are present | No WGSL fill on globe **or** model; a polygons-only bake is claimed then dropped, which also suppresses the WebGL texture path | Clamped GeoJSON/MVT areas fill on WebGL, bare terrain on WebGPU; a mixed collection renders half its content | `DEFERRED_WORK.md:14182`/`:14322` `NEW-WEBGPU-VECTOR-POLYGON-DRAPING`; `-07` item 7 (re-tier) | OPUS · L | Painted-fill pixel count and bbox equal on both backends at nadir and oblique, over globe **and** a model surface; the claim path never returns true for a bake it cannot pack |
| **C-02** Model / 3D-Tiles drape stage *(MVL-01/03/04, VEC-21, SNAP-09, G7-24/g9)* **ABSENT** | New `Scene/Model/ModelVectorLookupPipelineStage.js` (+205) + `ModelVectorLookupStage{VS,FS}.glsl`; `ModelSceneGraph.js:523-524` registers it on `model.hasDrapedVectors()`; `ModelFS.glsl:180-182` composites after clipping and before atmosphere/silhouette/edges | No `HAS_VECTOR_LOOKUP` / `VectorLookup` anywhere under `Shaders/WebGPU` + `Renderer/WebGPU`; `Model.js:2716-2754` `updateVectorLookup` runs on both backends with no WebGPU consumer | No WGSL stage, no model-side binding, no uniform packing, no composite point, and no `csm_eyeToCartographicDelta` for the UV | A line/area with `CLAMP_TO_3D_TILE` (or `CLAMP_TO_GROUND` over a tileset) drapes on buildings/meshes on WebGL and is invisible — and unpickable — on WebGPU | `-07` item 13 (`NEW-WEBGPU-MODEL-VECTOR-LOOKUP`, unassigned); plan §5.3:672-698 | OPUS · L (+ XS bind-group capacity preflight first) | Drape present on WebGPU over a tileset with painted-pixel parity; the composite sits after both clip tests and before atmosphere/silhouette/edges (a clipped-away region paints nothing) |
| **C-03** Metres width, draped path *(VEC-03, G145-05, G145-06, GI-07/g10, SNAP-10, MVL-06)* **ABSENT** | `VectorCommon.glsl` adds `u_vectorMetersPerUv`, `metersFromUv`, `pixelsPerMeter` and the three-way MIXED/METERS/pixels branch; key bits 37/38; the width texture becomes a signed R32F | `GlobeTerrain.wgsl:4180-4188` — the in-shader comment states "Only the pixel branch exists here — the meters branch is still a WebGPU gap"; `abs(lineWidth)` swallows the sign; `grep metersPerUv Renderer/WebGPU Shaders/WebGPU` = 0 (both re-verified) | No ground-metre Jacobian, no `pixelsPerMeter`, no per-tile `metersPerUv` input, no per-primitive unit branch | A `widthUnits:'meters'` draped collection keeps constant *ground* width on WebGL and constant *pixel* width on WebGPU — orders of magnitude off at most altitudes | `FEATURE_INVENTORY.md:1013` `UP144-VECTOR-LAYER-WGSL` (names both defines) | OPUS · M (+ S for mixed units) | Stroke width in px changes with altitude by the same ratio on both backends across ≥3 octaves; a mixed collection shows both families correct in one frame |
| **C-04** Metres width, **non-draped** `BufferPolylineCollection` *(VEC-22 + VEC-23, G7-12/g9)* **ABSENT** | `BufferPolylineCollection.js:81-114` new `widthUnits` option/getter; `renderBufferPolylineCollection.js:174,205-206,313` writes a SIGNED width; `BufferPolylineMaterialVS.glsl` `float width = abs(signedWidth); if (signedWidth < 0.0) width /= max(czm_metersPerPixel(positionEC), czm_epsilon7);` | `grep widthUnits Renderer/WebGPU Shaders/WebGPU` = **0** (re-verified); `WebGPUBufferPolylineRenderer.ts:444` → `:566` writes the width unsigned; `BufferPolylineMaterial.wgsl:70` `let width = input.showColorWidthAndTexCoord.z * params.pixelRatio` with no sign test; the builtin already exists at `chunks/functions/csm_metersPerPixel.wgsl:8` | Neither the sign convention nor the conversion exists; signing the attribute alone would invert every miter | A 50 m unclamped polyline is a 50 m ribbon on WebGL and a fixed 50 px line on WebGPU | **NOT tracked** — `FEATURE_INVENTORY.md:1013`'s sentence covers the *draped* path only | OPUS · S (must land as one pair) | Probe: one metres and one pixels collection at two camera distances one octave apart; the metres stroke halves on both backends, the pixels stroke does not |
| **C-05** Draped-vector picking *(VEC-05 + VEC-06, G145-08, GI-08/g10, SNAP-11, MVL-07)* **ABSENT** | `VectorCommon.glsl` adds `int vectorPickPrimitiveIndex = -1`, `u_vectorPickColorTexture` and `vectorPickColorOver(vec4)`; `VectorPipeline._writePickColor` + a `pickColorTexture` realization; `GlobeSurfaceTileProvider.js` @@ -3068,6 +3271,10 sets `command.pickId = "vectorPickColorOver(vec4(0.0))"`; `PickingPipelineStage.js:97-98` wraps the model pickId | `GlobeTerrain.wgsl:3963-3970` `fragmentPickMain` writes `camera.pickColor` unconditionally; `WebGPUVectorTileResources.ts:29-37` primitives run is 2 words (f32 width, u32 RGBA8) with no pick slot (re-verified); `:64-86`/`:244-245` never read `pickColors` | Three missing pieces: the pick-colour run (stride 2→3), the WGSL composite, and a per-tile pick opt-in; on models there is no fragment-level pick-override mechanism at all | `scene.pick` over a draped line/area returns the primitive on WebGL and the globe or nothing on WebGPU; hover highlight, click select and `drillPick` through draped vectors are WebGL-only | `FEATURE_INVENTORY.md:1013` ("the `vectorPickPrimitiveIndex` pick twin") — understates it as one GLSL global | OPUS · M | A draped primitive with a known pick id is returned by `scene.pick` on both backends, and a pick one stroke-width away returns the globe on both; a layout mutation (shift the pick run by one primitive) turns the layout spec red |
| **C-06** Clipping-polygon **holes** *(CP-01)* **ABSENT** | `ClippingPolygon` gains `options.holes` with per-ring ≥3 validation, a `holes` getter, `length` counting hole vertices; the even-odd test handles them naturally | `ClippingPolygon.js:157`; `ClippingPolygonSdfPack.js:49-60` `outerRingLength` — "the SDF algorithm has no hole support" (read verbatim by me) | The SDF pack walks the outer ring only; an interior ring cannot re-open a clipped region | A `ClippingPolygon` with holes leaves hole interiors visible on WebGL and clips them solid on WebGPU; inverse mode inverts the same disagreement | `RENDERER_LANDSCAPE_AUDIT_2026-09-02.md:301,:338` (C01, PARTIAL/HIGH), `:475` RL-01a — **not** in `FEATURE_INVENTORY.md` | OPUS · L (falls out of C-07) | A two-hole polygon over terrain and over a glTF model: hole interiors unclipped on both backends at the same camera; inverse mode inverts identically |
| **C-07** Clipping algorithm divergence *(CP-04/13/15/16/18, GI-01/02/04 g8+g10, G145-09, VEC-10, UP145-BI-04)* **PARTIAL (feature works; twin ABSENT)** | `Shaders/PolygonSignedDistanceFS.glsl` (131 L), `Builtin/Functions/clipPolygons.glsl` (37 L) and `unpackClippingExtents.glsl` (14 L) all DELETED; `GlobeFS.glsl:1173` and `ModelClippingPolygonsStageFS.glsl:5` now call `vectorClip(uv)`; `GlobeVS.glsl` loses the whole region-selection block; `ModelClippingPolygonsStageVS.glsl` is rewritten onto `czm_eyeToCartographicDelta` | `grep vectorClip Shaders/WebGPU` = **0** (re-verified); `GlobeTerrain.wgsl:3797-3888` `globeClipByPolygon` (SDF atlas + `czm_fastApproximateAtan2`), `:3830` `min(extentsCount, 8u)`, `:679` `array<vec4<f32>, 8>` (both re-verified); `ModelPBRComplete.wgsl:2193-2215` `modelClipByPolygon`, three discard sites; `WebGPUClippingPolygonCollection.ts:305-307` still dispatches `Compute/PolygonSignedDistance.wgsl` | Different algorithm, different input frame (exact tile UV clamped to [0,1] vs f32 ECEF through an approximate atan), different precision law, and a hard 8-extent cap upstream no longer has | 1.145's headline "vastly improves quality across distance scales" is WebGL-only: WebGPU clip edges are atlas-quantised and can shimmer along tile seams; more than 8 merged extent groups are unclipped on WebGPU; model clip boundaries drift with camera motion, worse the further from the origin | `-07` item 2; `RL-01a`; `UPSTREAM-SYNC-1.145-02` | OPUS · XL — **blocked on C-01** (needs the polygon tables), wants C-22 (precision) | One capture per leg: holes (C-06), inverse, more than 8 disjoint regions, a far-from-origin model at close range, and seam stability — all reporting the same clip on both backends; an inertness mutant on any one of `ModelPBRComplete`'s three discard sites turns the model-clip capture red |
| **C-08** Model vertical exaggeration *(VE-01)* **ABSENT** | `VerticalExaggerationStageVS.glsl` renames `vertexNormal` → `vertexEllipsoidNormalEC` and **stops normalizing** the model-space direction (a correctness fix) | `grep exaggerat Shaders/WebGPU/Model/*.wgsl` = **0** (re-verified); the globe's WGSL exaggeration exists and is unaffected | The model exaggeration stage is missing wholesale on WebGPU, so the upstream fix has nothing to apply to | With `scene.verticalExaggeration ≠ 1`, glTF models and tileset content rise with terrain on WebGL and stay pinned on WebGPU — buildings sink into or float above their own terrain | `-07` item 15 (scoping pass only, unassigned) | OPUS · M | At 1.0 byte-identical to today on both backends; at 2.0 a model keeps the same contact with exaggerated terrain on both (silhouette/contact capture) |
| **C-09** PostProcess `selected` masking *(G7-08, g7 + g11)* **ABSENT** | `PostProcessStage.js` @@ -796,6 +798,19 hardens `createSelectedTexture` with a `context.limits.maximumTextureSize` clamp plus a one-time warning | `PostProcessStageCollection.js:531-539` hands `update()` to the feature renderer and returns — the whole selected-id path is unreachable on WebGPU (re-verified) | No selected-id texture, no `czm_selected()` equivalent; a pre-existing gap 1.145's hardening highlights | `stage.selected = [feature]` affects **everything** on WebGPU instead of the selection | `DEFERRED_WORK.md:9971`/`:10024` `WIRE-PP-LIBRARY-BUILTINS-RESIDUALS` item 2 | OPUS · L (extend the existing row, do not re-file) | Both backends restrict a user stage's effect to the selected subset; the WebGPU path carries the same max-texture clamp and one-time warning when built |
| **C-10** `pickTranslucentDepth` inert on WebGPU *(SNAP-16)* **ABSENT** | All three new snapping demos set `scene.pickTranslucentDepth = true` with a comment saying why | `Picking.js:666-671` calls `renderTranslucentDepthForPick` with **no backend test** (re-verified); `PickDepthFramebuffer.js` is a WebGL `FramebufferManager` | The flag costs a full extra pick mini-frame per `pickPosition` on WebGPU and (claim) influences nothing | Clicking a translucent surface returns the opaque geometry behind it on WebGPU and the translucent surface on WebGL — exactly the case the demos enable the flag to avoid | **NOT tracked** | OPUS · M, with an XS measurement first | Two parts: (a) a probe clicking a translucent surface returns a position on it on both backends; (b) **before the fix**, one measurement confirming the inert half — my own read reaches the mini-frame but not its consumer, so do not brief the fix on the unmeasured premise |
| **C-11** 1.145 snapping demos vs async readback *(SNAP-15)* **PARTIAL** | Three new gallery demos (`aec-snapping` +109/+264, `hybrid-snapping-dev` +6/+480, `ion-snapping-dev` +6/+233) drive `scene.snap` / `pickPosition` / `pick` synchronously | `WebGPUSnapFramebuffer.ts:744-781` — a cold or non-overlapping query returns `{hits: []}` and latches a one-shot warn; none of the demos guards a first call | The demos assume a synchronous answer WebGPU cannot give on the first frame | On WebGPU the hover dot needs a second or third mouse-move; the first click logs "no element under cursor" and commits nothing | The underlying contract is tracked (`FEATURE_INVENTORY.md:1057` `UP144-SNAP-WEBGPU`; Q-141/DM-11); **the demos are not** | OPUS · S | A recorded disposition, then a sweep leg: each demo's first interaction on WebGPU either succeeds or is documented as requiring a settled camera — not discovered by the Sandcastle2 sweep |
| **C-12** `surfacePosition` border clip + WebGPU aperture *(SNAP-06)* **PARTIAL** | `Scene.js` typedef + `Snapping.js` implement `surfacePosition` as a **second** pick cycle over a fresh 9-px region centred on the edge hit | The fork takes a different route: `Snapping.js:317-341` is a 4-arg `nearestSurfaceHit` with `halfRegion = floor(regionWidth*0.5)` and an `abs(dx) > halfRegion` clip (read verbatim by me), called at `:498-507` over the single readback. WebGPU-only: `WebGPUSnapFramebuffer.ts:640-643,:693-700` shifts hits and drops those outside the current aperture; `:781` returns `{hits: []}` cold | (a) shared: the fork's region is the *intersection* with the original 25-px query, so a winner at \|offset\| 9-12 returns `undefined` where upstream returns a point; (b) WebGPU: the effective box is up to 2 rows/columns thinner | Edge snaps near the region border yield `undefined` more often on WebGPU; both demos then fall back to `clientPosition` — the degenerate silhouette seed the feature exists to avoid | `-07` items 4 and 5 (both landed as rows, Batch 1417); `AR-030`/`AR-M30` — **`AR-030`'s stated mechanism is wrong**: `MAX_PRIOR_CURSOR_DELTA_PIXELS` bounds successive query *centres*, not a hit's offset, and a stationary hover takes the `_readbackRegionsEqual` early return at `:624-626`; its "0 %" figure predates the feature | OPUS · S | Amend `AR-030`'s mechanism and stale rate, and **run `AR-M30`**; `probe-scene-snap.mjs` grows a leg recording `surfacePosition` defined/undefined on both backends at a model silhouette, the WebGPU leg run twice to separate cold readback from aperture narrowing. Do **not** re-file the §C row items 4/5 already own |

### B. No pixels — cost, leak, or correctness-of-record

| # | Upstream change | Twin evidence | Gap | Effect | Tracked | Tier/size | Acceptance |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **C-13** `requestRectangleData` allocates unused WebGL textures *(CP-05, VEC-11, GI-03/g8, GI-13/g10, G145-15)* **ABSENT/PARTIAL** | New per-owner bake API packs rings, builds a grid and creates three GPU textures — called per clipped globe tile and per clipped model | `ClippingPolygonCollection.js:473-504` calls `VectorPipeline.packPolygonTextures(context, …)` with **no backend gate** (read by me), unlike `VectorProvider.requestDataForRectangle`'s explicit claim; reached from `GlobeSurfaceTileProvider.js:841` inside the shared `endUpdate` loop | Three stub-backed GPUTextures plus a CPU grid bake per clipped tile **and** per model that no WGSL samples | VRAM, upload and CPU cost scaling with visible clipped tiles; no visual difference | `-07` item 3 — **names only the model path**; the per-tile globe path is this census's correction | SONNET · S | With clipping polygons on a WebGPU viewer, zero `Texture` objects are constructed per clipped tile/model while the CPU tables still reach the future twin; measured multi-metric (allocation count + GPU bytes) |
| **C-14** Model-side bake with no consumer *(MVL-08)* **PARTIAL** | `Model.js:424-426,:834,:1057-1058,:2695-2754` add the whole bake lifecycle, shared across backends | The same code runs on WebGPU; the realized buffer is keyed for the **globe** pipeline | Every content model overlapping a draped collection allocates a storage buffer nothing reads and pays draw-command rebuilds on drape-state change | Memory and CPU only | **NOT tracked** | SONNET · S | With a WebGPU context and a draped collection over a tileset, zero globe-vector buffers are created for content models — or the model consumer exists (C-02) and reads them |
| **C-15** `GlobeSurfaceTileProvider.destroy()` no longer releases WebGPU clipping resources *(GI-19, G145-21)* **ABSENT** | @@ -1161,8 +1209,7 — `destroy()` drops the reference instead of destroying the collection (1.145 deprecates `ClippingPolygonCollection.destroy`) | Verified at HEAD, `GlobeSurfaceTileProvider.js:1391-1396`: `this._clippingPolygons = undefined;`. The fork's own `releaseFeatureRendererResources` (`ClippingPolygonCollection.js:742-756`) is called on the setOwner and deprecated-destroy paths (CP-07, PRESENT) but **not here** | On this fork the collection *does* hold WebGPU resources; this teardown path skips them | Destroying globes/viewers against a surviving device accumulates the SDF atlas plus positions and extents textures | **NOT tracked** | SONNET · XS | `GlobeSurfaceTileProvider.destroy()` routes through `setOwner(undefined, this, "_clippingPolygons")`; a spec asserts the feature-renderer cache is empty after globe teardown with the context still alive |
| **C-16** `BufferPrimitiveCollection.destroy()` leaks WebGPU buffers *(G7-17/g9)* **PARTIAL** | @@ -475,17 +505,123 adds `fromCollection` / `_cloneEmptyBaseArgs` / `_cloneFiltered` — 1.145 now documents grow-by-clone-then-destroy as the idiom | Verified `BufferPrimitiveCollection.js:373-388`: it destroys `_renderContext` (WebGL) and pick ids only, with no feature-renderer release (cf. `BufferPolygonCollection.js:556-566`, which does) | Each destroyed collection retains its WebGPU buffers (≈11 per polyline collection) until context loss | Repeated grow-and-discard climbs GPU memory on WebGPU only | The class is tracked as `ARCH-4` (`ARCHITECTURE_REVIEW_2026-09-02.md:537`); **these collections are not** | SONNET · S | `destroy()` resolves the collection's feature renderer and calls its `destroy` slot before the WebGL teardown; a spec asserts buffer count returns to baseline after grow-then-destroy |
| **C-17** Clipping rebake staleness *(CP-03, plus the unclaimed `Cesium3DTileset` listeners)* **PARTIAL** | `_dirty` set in add/remove/removeAll and `update` early-returns on `!_dirty`; the tileset gains `polygonAdded`/`polygonRemoved` → `clippingPolygonsNeedRebake` | Verified `ClippingPolygonCollection.js:386-397`: the fork **clears `_dirty` inside `update`**, then calls the feature renderer at `:399-402` with no dirty signal; WebGPU still detects change by counting | Equal-count edits do not rebake the SDF | Remove one polygon and add another with the same vertex count: WebGL re-clips, WebGPU keeps clipping against the removed one | **No row** — `ARCHITECTURE_REVIEW_2026-09-02.md:789` (H-P11) says "do not re-file", but on the *pre-merge* premise, now stale | SONNET · S | The CLIPPING_POLYGONS feature renderer rebakes exactly when contents changed (a monotonic revision, or read the dirty state before `update` clears it); a spec drives an equal-count swap and asserts a rebake |
| **C-18** Orphan and stale WGSL provenance *(CP-10, CP-11, CP-14, GI-05/g8, GI-03/g10, UP145-BI-05, G145-12)* **PARTIAL/ABSENT** | Three GLSL files deleted; `GlobeVS.glsl`'s clipping block deleted | `chunks/functions/csm_clipByPolygons.wgsl` (76 L, a knowingly-wrong stub) and `csm_unpackClippingExtents.wgsl` (7 L) have zero callers; live citations of deleted GLSL at `GlobeTerrain.wgsl:1651,:3587-3591,:3851,:3880,:4545` and `WebGPUEffectsBindGroup.js:180,:187` | The WGSL documents itself against sources that no longer exist, and the named "twin" of the deleted builtin is an unreferenced wrong stub | None at runtime. Exactly the drift CLAUDE.md's Principle-7 postscript warns produces inverted dispositions | `-07` item 11 — its grep covers only `PolygonSignedDistanceFS` at four sites | SONNET · XS | Widen item 11's grep to `czm_clipPolygons\|clipPolygons.glsl\|unpackClippingExtents\|PolygonSignedDistanceFS` over `Renderer/WebGPU` + `Shaders/WebGPU` and require every hit to cite a live file or say plainly that the GLSL original is gone; the two orphan chunks get one dated disposition (a caller, or a removal date tied to C-07) |
| **C-19** PostProcess clamp unreachable, and the spec asserts the wrong read *(G7-07/g11)* **PARTIAL** | The same @@ -796,6 +798,19 hunk; upstream reads a process-global `ContextLimits` | The merge did **not** absorb the global: verified `PostProcessStage.js:886` reads `context.limits.maximumTextureSize`. The clamp is unreachable on WebGPU (C-09), and `PostProcessStageSpec.js` still asserts the upstream read | Two divergences, neither the one `UP-10`/`AR-028` predicted | WebGL degrades gracefully on huge selections; WebGPU cannot reach the code at all | `ARCHITECTURE_REVIEW_2026-09-02.md:838` (`UP-10`), `QUEUE_2026-09-03_ARCHITECTURE_REVIEW.md:163` (`AR-028`, P1 "blocker") — **both need correcting at HEAD** | SONNET · XS | Repoint the spec at the read the product performs (spy/fake `context.limits`); amend `AR-028`'s premise and drop its blocker status |

### C. Prerequisites — no symptom of their own today

| # | Upstream change | Twin evidence | Gap | Tracked | Tier/size | Acceptance |
| --- | --- | --- | --- | --- | --- | --- |
| **C-20** `czm_eyeCartographic` *(UP145-AU-01, G7-01 ×3)* **ABSENT** | `AutomaticUniforms.js` @@ -1008,6 +1008,27 (FLOAT_VEC3) with the `UniformState` field/getter (`:243`, `:595-596`) | Verified: `WebGPUAutoUniforms.js` carries `csm_eyeHeight` (`:332`) and no cartographic entry; **that file has zero importers outside itself** (`RENDERER_LANDSCAPE_AUDIT_2026-09-02.md:608`), so a registry entry alone would be inert | No WGSL uniform carries the eye's (lon, lat, height) | `-07` item 14 | OPUS · S | A live UB packer writes it and a consuming WGSL shader reads it; numeric equivalence with `UniformState.eyeCartographic` (`_eyeCartographic.z === _eyeHeight` holds exactly) |
| **C-21** `czm_eyeToEnu` *(UP145-AU-02, G7-02 ×3)* **ABSENT** | @@ -1050,10 +1071,31 (FLOAT_MAT3), `UniformState.js:246`, `:614-615` | No `csm_eyeToEnu` anywhere; layout hazard: GLSL `mat3` is 9 tight floats, WGSL `mat3x3<f32>` is 3 × vec4 | No eye→ENU rotation available to any WGSL shader | `-07` item 14 | OPUS · S (same batch as C-20) | Read back from WGSL: orthonormal with det 1 (the JS side was re-derived to 8.9e-16 by Tar-Falassion); the padding is proven by a mutation that packs it tightly and goes red |
| **C-22** `czm_eyeToCartographicDelta` builtin **plus `czm_eyeEllipsoidCurvature`** *(UP145-BI-03, CP-17, MVL-04, G7-03/G7-04)* **ABSENT** | New `Builtin/Functions/eyeToCartographicDelta.glsl` (74 L), registered at `CzmBuiltins.js:82,:230`; consumed by `ModelClippingPolygonsStageVS.glsl:18` and `ModelVectorLookupStageVS.glsl:13` | Verified: no `csm_*cartograph*` chunk under `Shaders/WebGPU/chunks/functions/` | **Correction to `-07` item 14: the twin needs THREE uniforms, not two** — `czm_eyeEllipsoidCurvature` (pre-existing upstream) is the third input | `-07` item 14 (incomplete input list) | OPUS · M | A `csm_eyeToCartographicDelta` chunk matching the GLSL to float32 noise over a spread of altitudes including a grazing near-horizon case, wired into at least one live consumer's UB, with `previousViewProjection` still at the tail of `CameraUniforms` (CLAUDE.md pins it) |

### Did not survive refutation (1)

- **`CP-12-POLYGONSIGNEDDISTANCEFS-DELETED`** (reader PARTIAL) — REFUTED on **scope, not fact**: the
  refuter records that every technical observation verifies (the WGSL compute pass has lost its
  upstream oracle, and `probe-globe-clippoly-geodetic.mjs`, catalogued at `DEBUGGING_GUIDE.md:348`, is
  now a cross-algorithm comparison whose PASS proves neither parity nor regression) but that it is not
  a parity row. Carry the observation as one clause inside **C-07**'s acceptance — the probe's PASS
  criteria and `DEBUGGING_GUIDE.md:348` must name which algorithm each backend runs and what a delta
  now means — not as a row of its own.

Also downgraded out of the gap table by the refuter, recorded so they are not re-derived: `CP-06`
PARTIAL→**PRESENT** (the quality/debug deprecations are honoured); `GI-09` ABSENT→**NA** and `GI-10`
ABSENT→**NA** (the deleted WebGL1 shims and the `maxTextures -= 3` day-texture budget are WebGL-only —
`GI-10` survives only as spec item `-07` #6); `G7-11` PARTIAL→**NA** twice (CreditDisplay keyboard
accessibility is backend-neutral).

### Unadjudicated (23) — MISSING refuter verdict, never silently promoted

Twenty-one carry reader status **NA** with no gap: `G145-12`…`G145-20`, `G145-22`, `G145-23` (globe
clipping/vector bookkeeping, the verified-zero coverage result for imagery/atmosphere/terrain, the
day-texture budget, the `updateForPick` `command.dirty` hunk) and `G7-18` ×2, `G7-19`…`G7-23`, `G7-25`,
`G7-26`, `G7-27` (BlendOption docs, CreditDisplay a11y, Ion/ArcGIS token rotations, the new
`SnapService`/`IonSnap*` REST surface, WMS/WMTS, JSDoc generics). Two carry reader status **PARTIAL**
and are adjudicated elsewhere by a confirmed twin, so they need no separate ruling: **`G145-21`** =
C-15 (destroy/release) and **`G7-24`** = C-02 (`UrlTemplate3DTilesDataProvider` `heightReference`
drape). Recommendation: adjudicate the 21 NA rows in one bounded pass rather than promoting any of
them; none is renderer-facing on its face.

---

## 4. Proposed rewrite of `UPSTREAM-SYNC-1.145-07`'s item list

Card format: `N. **title** — owner tier · size · acceptance · source`. Existing numbers are kept so
prior packets still resolve. **Disposition** states what this census does to each of the 15.

**Existing 1-15**

1. **`vectorPolylineRender` half-width/AA/nearest-edge** — CLOSED (Penlod, Batch 1410, reviewer Gundor; Éowyn job 6 gate B countRatio 1.000). *Unchanged.*
2. **Clipping-algorithm divergence** — OPUS · **XL (was unpriced)** · acceptance = C-07's five-leg capture (holes, inverse, >8 regions, far-from-origin model, seam stability) plus the CP-12 clause that the probe states which algorithm each backend runs · source: Eradan f2, Herion §c.3, census C-06/C-07. **EXTENDED** — holes, the 8-extent cap (`GlobeTerrain.wgsl:3830`, `:679`), the tile-UV input frame and the model precision law are now named, and the row is explicitly **blocked on item 7**.
3. **Unused WebGL-compat clipping textures** — SONNET · S · acceptance unchanged · source: Eradan f3, Tar-Anducal F-1. **EXTENDED** — it happens **per clipped globe tile** as well as per model (`GlobeSurfaceTileProvider.js:841` → `ClippingPolygonCollection.js:473-504`); the row names only the model path today.
4. **The 4-arg clip detector gap** — Tar-Falassion F1 · unchanged. **CONFIRMED.**
5. **The border-clip shortfall** — Tar-Falassion F2. **CONFIRMED + EXTENDED**: add the WebGPU-only aperture-narrowing mechanism and the correction that `AR-030`'s stated mechanism and its "0 %" figure are both wrong (C-12).
6. **The `maxTextures -= 3` detector** — Eradan f1 · unchanged. **CONFIRMED** (WebGL-only; `GI-10` corrected to NA).
7. **`NEW-WEBGPU-VECTOR-POLYGON-DRAPING` re-tier** — Herion §c.1. **CONFIRMED and PROMOTED**: no longer a ledger-text edit but the campaign's top build item (C-01), OPUS · L, and the hard prerequisite of items 2 and 13.
8. **`probe-vector-draping.mjs` re-vehicle** — SONNET · P1. **CONFIRMED, still OPEN**: Brodda's working probe (md5 `776dc6f329132e3e46a2286270e66cc1`) is **not yet on the tracked tree** (tree copy `076cff2634087f18f6b4c6209f07c457`).
9. **Cluster (c)'s Karma specs never executed** — OPUS-EDGE-EXECUTOR · unchanged. **CONFIRMED.**
10. **Two spec gaps in `GlobeSurfaceTileProviderSpec.js`** — SONNET · unchanged. **CONFIRMED** — `GI-13`/`GI-15` establish that the inverse-clip tile skip and the pooled-pick decision are both present and reachable, so the specs would assert live behaviour.
11. **Stale provenance comments** — SONNET · XS. **EXTENDED** — widen the grep and add the two orphan chunks (C-18); four sites is an undercount.
12. **Packet §10 "Also opened" (a)/(b)/(c)** — unchanged. **CONFIRMED.**
13. **`NEW-WEBGPU-MODEL-VECTOR-LOOKUP`** — OPUS · **L**, with an **XS bind-group capacity preflight first**. **CONFIRMED + EXTENDED** into three named legs: the stage and its composite point (C-02), the model pick override (`PickingPipelineStage.js:97-98`, C-05), and the model-side bake that today realizes a globe-keyed buffer with no consumer (C-14). Depends on items 14 and 7.
14. **`czm_eyeCartographic`/`czm_eyeToEnu`/`eyeToCartographicDelta` in WGSL** — OPUS · M. **EXTENDED** with three corrections: (a) the builtin needs a **third** uniform, `czm_eyeEllipsoidCurvature`; (b) `WebGPUAutoUniforms.js` has zero importers, so a registry entry there is inert — the acceptance must name a live UB packer; (c) `mat3x3<f32>` is 3 × vec4, not 9 floats.
15. **WGSL model vertical-exaggeration stage** — OPUS · scoping. **CONFIRMED and priced**: the stage is missing wholesale (0 `exaggerat` hits under `Shaders/WebGPU/Model/`), M not XS, with a user-visible symptom at any `verticalExaggeration ≠ 1` (C-08).

**New 16-24** — each carries a user-visible effect no existing item covers

16. **Metres-width branch, draped path** — OPUS · M · acceptance C-03 · source: census C-03. Promotes an inventory sentence (`FEATURE_INVENTORY.md:1013`) to a row that owns an acceptance.
17. **Mixed-units branch** — SONNET · S · depends on 16 · acceptance: one tile carrying both unit kinds draws both correctly · source: census C-03 (`G145-06`).
18. **`BufferPolylineCollection.widthUnits` on WebGPU (non-draped)** — OPUS · S · acceptance C-04 · source: census C-04. **Untracked anywhere today**; must land as a matched pair (packer sign + WGSL branch) or every miter inverts.
19. **Draped-vector pick twin** — OPUS · M · acceptance C-05 · source: census C-05. Promotes `FEATURE_INVENTORY.md:1013`'s one clause; the real work is a stride change (2→3 words), a WGSL composite and a per-tile pick opt-in.
20. **`pickTranslucentDepth` on WebGPU** — OPUS · M, **XS measurement first** · acceptance C-10 · source: census C-10 (SNAP-16). Brief the measurement, not the fix; the inert half is unverified.
21. **1.145 snapping demos vs the async readback contract** — OPUS · S · acceptance C-11 · source: census C-11 (SNAP-15).
22. **`GlobeSurfaceTileProvider.destroy()` releases the clipping feature renderer** — SONNET · XS · acceptance C-15 · source: census C-15 (`GI-19`, `G145-21`).
23. **`BufferPrimitiveCollection.destroy()` releases its feature renderer** — SONNET · S · acceptance C-16 · source: census C-16 (`G7-17`); class `ARCH-4`.
24. **Clipping rebake staleness on WebGPU** — SONNET · S · acceptance C-17 · source: census C-17 (CP-03). Supersedes `H-P11`'s "do not re-file", whose premise was pre-merge.

**Belongs elsewhere, not on `-07`**

- **`DEFERRED_WORK.md:9971`/`:10024` `WIRE-PP-LIBRARY-BUILTINS-RESIDUALS` item 2** — extend in place
  with C-09 (name user WGSL stages explicitly; the future WebGPU selected-id path must carry the same
  max-texture clamp and one-time warning). Do not open a `-07` item.
- **`AR-028` / `UP-10`** — amend the premise and drop the P1 blocker (C-19): the fork reads
  `context.limits`, not the process-global, and the clamp is unreachable on WebGPU.
- **`AR-030`** — amend the mechanism and the stale "0 %", and **run `AR-M30`** (C-12).
- **`FEATURE_INVENTORY.md` §C — exactly two entries**, consistent with the card's own convention
  (line 1717: findings are carried on `-07` rather than duplicated in §C):
  1. **`UP144-VECTOR-LAYER-WGSL`** gains one sentence separating the **non-draped**
     `BufferPolylineCollection` metres gap (new item 18) from the draping sentence it already carries —
     they are different code paths, and today's text reads as one gap.
  2. **A new §C row for the WGSL model vertical-exaggeration stage** — item 15's own acceptance
     requires the scoping note to live there.
  Do **not** add a §C row for `surfacePosition` (items 4/5 own it; `grep -c surfacePosition` there is 0
  by design), and do not restate items 13/16/19 in §C.

---

## 5. What to dispatch first — five lanes, by user-visible severity

Per THE PYRAMID: the seat plans and lands; **Opus** leads every lane and reviews; **Sonnet** takes
bounded single-deliverable work under an Opus reviewer. Model is stated per lane, never inherited.

| # | Lane | Model | Why first | Blocks / blocked by |
| --- | --- | --- | --- | --- |
| **L1** | **Polygon tables + WGSL `vectorPolygonRender`** (item 7 / C-01): extend the storage-buffer word layout with polygon-edge, edge→primitive and polygon-grid runs as a matched pair with the shader, and stop the claim path taking ownership of a bake it cannot pack | **Opus** lead, Opus reviewer | The largest visible gap, and the **hard prerequisite** for items 2 (clipping twin) and 13 (model drape) — nothing in the clipping cluster can start until it lands | Blocks item 2, item 13, and L4's polygon half |
| **L2** | **Metres width, both paths** (items 16+17+18 / C-03, C-04): `metersPerUv` on `TileUniforms` (the `vectorCoverageRadius` precedent at offset 492 is the template) plus the signed-width branch; and the non-draped signed attribute with a `csm_metersPerPixel` decode | **Opus** lead (the two halves are one convention); the non-draped half is a **Sonnet** sub-task under that lead | Independent of L1, the cheapest visible win, and the only gap where a road is drawn orders of magnitude wrong at most altitudes | None |
| **L3** | **Camera uniforms + delta builtin** (item 14 / C-20, C-21, C-22): three uniforms — `eyeCartographic`, `eyeToEnu`, `eyeEllipsoidCurvature` — through a **live** UB packer, plus the `csm_eyeToCartographicDelta` chunk | **Opus** | Prerequisite for the model drape *and* for the model-clipping precision law; small, well bounded, and its acceptance is numeric rather than pixel | Blocks item 13 and the model leg of item 2 |
| **L4** | **Draped-vector pick twin** (item 19 / C-05): pick-colour word (stride 2→3), WGSL composite, per-tile pick opt-in | **Opus** | The second-most-requested behaviour after the drape itself; the polyline half can land ahead of L1, the polygon half rides on it | Polygon half blocked by L1 |
| **L5** | **Cost / leak / record batch** (items 3, 11, 22, 23, 24 / C-13, C-15, C-16, C-17, C-18): the backend claim on `requestRectangleData`, the two destroy-path releases, the dirty-signal rebake, and the widened provenance sweep | **Sonnet** ×2 under one **Opus** lead and reviewer | Five S/XS deliverables with no shader risk; clears the ledger's stale premises (`H-P11`, `AR-028`) before the big lanes write over them | None |

**Held deliberately:** item 2 (clipping XL) until L1 lands; item 13 (model drape, L) until L3 lands and
the XS bind-group capacity preflight answers the plan's `UNCERTAIN`; item 20 (`pickTranslucentDepth`)
until its XS measurement confirms the inert half — briefing the fix on an unmeasured premise is exactly
the Principle-10 failure this census is written to avoid.

**One question this census could not answer:** `GltfLoader.js`'s new sampler min/mag filter override
(+62/-9) was claimed by no reader. Before the next wave closes, someone should establish whether the
WebGPU texture path honours a per-`textureInfo` filter override — it is the only unexamined
renderer-adjacent hunk in the 1.145 diff.
