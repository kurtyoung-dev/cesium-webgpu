# WebGPU Parity Audit — Post-Merge v1.141–1.143 (2026-06)

## Summary

This audit covers the WebGPU-parity surface affected by the upstream v1.141–1.143 merge,
spanning four areas: the **vector-tile / glTF-vector buffer-primitive family**
(`BufferPoint/Polyline/PolygonCollection`, `VectorGltf3DTileContent`, `GeoJsonPrimitive`),
**glTF model edges** (`EdgeDisplayMode` tri-mode + `EXT_mesh_primitive_edge_visibility`
data paths), the **voxel default-shader** path (PR#13517), and a handful of
backend-agnostic CPU-side fixes (`pickModel`/`ModelReader`, `Scene.updateHeight`,
ground-primitive batch bookkeeping, `ScreenSpaceEventHandler`, glTF sampler-wrap fallback).

Of the 30 findings, **15 are real WebGPU gaps** (the rest are `supported` /
`webgl-only-na` — backend-agnostic CPU code that needs no renderer work). The headline
items are: **(P1)** the `BufferPrimitiveMaterial` family ignores three brand-new
PR#13384 knobs on **all three** WebGPU renderers — `color.alpha` translucency,
`blendOption` (OPAQUE vs TRANSLUCENT pass selection), and the world-space
`boundingVolume` / `debugShowBoundingVolume` wiring (PR#13477) — so buffer
primitives render opaque, mis-sorted, and **uncullable** under WebGPU; **(P1)** the new
`GeoJsonPrimitive` (PR#13505) has **zero** Playwright verification and is untracked in
the inventory; **(P2)** `EdgeDisplayMode` is only *partially* realized on WebGPU
(`EDGES_ONLY` direct pass entirely missing, `SURFACES_ONLY` default-suppression missing —
so edge-bearing CAD/BIM assets render edges by default that WebGL hides), plus three
missing edge **data paths** (lineStrings, authored silhouetteNormals, per-edge color);
and **(P2/XL)** the voxel default shader (PR#13517) is unreachable because the entire
WebGPU voxel data path is a placeholder scaffold. Several gaps are **untracked** in
`FEATURE_INVENTORY.md` / `DEFERRED_WORK.md` and are flagged below for reconciliation.

## Prioritized Gap Table

Sorted P0→P3, then by effort (S→XL). Only rows with a genuine WebGPU gap
(`missing` / `partial`) plus the two doc-only tracking rows are listed; pure
`supported` / `webgl-only-na` rows are in the "Already tracked / no-op" section.

| Feature | WebGPU status | Gap | Files | Effort | Priority |
|---|---|---|---|---|---|
| World-space boundingVolume + debugShowBoundingVolume on buffer draw commands (PR#13477) | missing | All three buffer renderers build `WebGPUDrawCommand` without `boundingVolume`/`debugShowBoundingVolume`; `WebGPUDrawCommand` supports them — so no per-frustum culling (every collection drawn every frame) and the debug overlay is a silent no-op. | `WebGPUBufferPointRenderer.ts`, `WebGPUBufferPolygonRenderer.ts`, `WebGPUBufferPolylineRenderer.ts` | S | P1 |
| GeoJsonPrimitive WebGPU visual-regression probe + Sandcastle demo | missing | No Playwright probe exercises `GeoJsonPrimitive.fromGeoJson`; loader count-allocation math (vertex/hole/triangle counts → collection capacities) never pixel-verified on WebGPU vs WebGL. Wrong capacity trips `ERR_CAPACITY` or silently truncates. | `Tools/visual-regression/probe-geojson-primitive.mjs`, `Apps/Sandcastle/gallery/WebGPU GeoJsonPrimitive.html`, `Apps/Sandcastle/gallery/gallery-index.js` | M | P1 |
| BufferPrimitiveMaterial color.alpha translucency (Point/Polyline/Polygon) (PR#13384) | missing | All three renderers truncate color to RGB via `encodeRGB8` and force alpha=1.0; the WGSL `if (outColor.a < 0.005) discard` is dead. Translucent buffer primitives render fully opaque. Needs a widened packed lane + `csm_decodeRGBA8` (or separate float lane) in all three paths + the GPU arrayStride/format change. | `WebGPUBufferPointRenderer.ts`, `WebGPUBufferPolygonRenderer.ts`, `WebGPUBufferPolylineRenderer.ts`, `Collections/BufferPointMaterial.wgsl`, `Collections/BufferPolygonMaterial.wgsl`, `Collections/BufferPolylineMaterial.wgsl` | M | P1 |
| blendOption (OPAQUE vs TRANSLUCENT) param (PR#13384) | missing | None of the three renderers read `collection._blendOption`; they hardcode a translucent blend state and always push `Pass.TRANSLUCENT` with `depthWriteEnabled=false`. OPAQUE collections render in the translucent pass → wrong sort/occlusion vs WebGL. Needs an OPAQUE pipeline variant (blend off, depthWrite on) routed to `Pass.OPAQUE`. | `WebGPUBufferPrimitiveRenderer.ts`, `WebGPUBufferPointRenderer.ts`, `WebGPUBufferPolygonRenderer.ts`, `WebGPUBufferPolylineRenderer.ts` | M | P1 |
| EdgeDisplayMode.SURFACES_ONLY suppression on WebGPU (v1.142) | missing | SURFACES_ONLY is the DEFAULT and must HIDE all extension edges. WebGPU edge emitter gates only on `defined(edgeGltfPrimitive?.edgeVisibility)` and never reads `model.edgeDisplayMode`, so any glTF shipping edge data emits edges even in the default mode — visible divergence on the most common config for edge-bearing assets. One-line guard. | `WebGPUModelRenderer.js` | S | P2 |
| BufferPoint outlineColor.alpha + outlineWidth=0 bleed fix (PR#13384/#13543) | missing | Point renderer packs `outlineWidthAndOutlineColor` as vec2 (no alpha; always uses `outlineColor` regardless of width). At `outlineWidth=0` the stale outline color bleeds through the AA edge (#13543 artifact) and translucent outlines never blend. Pack `outlineColor.alpha` + substitute fill color/alpha when `outlineWidth===0`. | `WebGPUBufferPointRenderer.ts`, `Collections/BufferPointMaterial.wgsl` | S | P2 |
| EdgeDisplayMode.EDGES_ONLY (CAD wireframe) — Model + Cesium3DTileset (v1.142) | missing | Three coupled gaps: no `CESIUM_3D_TILE_EDGES_DIRECT` pass (slot 12) in the WebGPU frustum loop (commands binned there silently never execute); the WebGPU model edge emitter hardcodes `Pass.CESIUM_3D_TILE_EDGES`; and the surface command is emitted unconditionally with no EDGES_ONLY suppression. Net: EDGES_ONLY renders surfaces normally with NO edges — the inverse of intent. | `WebGPUSceneRendererFrustumLoop.ts`, `WebGPUSceneRenderer3DTilePasses.ts`, `WebGPUModelRenderer.js`, `WebGPUSceneRenderer.ts` | M | P2 |
| EquirectangularPanorama cull-override (renderState.cull.enabled:false) (#13369) | partial | `flat:true` lighting fix IS honored on WebGPU, but the material pipeline bakes `cullMode` solely from `appearance.closed` and ignores the appearance's `renderState.cull.enabled:false`. A panorama viewed from inside the sphere shows back faces; `closed:true` forces `cullMode:'back'` → panorama invisible on WebGPU while WebGL shows it. Untracked (C-R1-PRIMITIVE-DERIVED excludes pipeline-cull derivation). | `WebGPUPrimitiveCommands.js`, `FEATURE_INVENTORY.md`, `DEFERRED_WORK.md` | M | P2 |
| Vector-tile buffer collections in 2D / Columbus View | partial | Buffer renderers encode RTE world-space ECEF positions and project via `modelViewRelativeToEye * projection` with no 2D/CV reprojected attribute buffer (unlike the Vector3DTile classifiers' CPU-reprojected ENU buffer). Batch 180 verified SCENE3D only; 2D/CV likely renders at wandering points. Untracked for the BufferPolygon family. | `WebGPUBufferPolygonRenderer.ts`, `WebGPUBufferPolylineRenderer.ts`, `WebGPUBufferPointRenderer.ts`, `Collections/BufferPolygonMaterial.js`, `DEFERRED_WORK.md` | L | P2 |
| WebGPU edge data parity — lineStrings, silhouetteNormals accessor, per-edge materialColor | partial | The WebGPU extractor consumes only the per-triangle 2-bit `edgeVis.visibility` encoding and early-returns otherwise. Missing: (1) explicit `lineStrings` edges (BENTLEY/styled-gltf-lines assets yield zero WebGPU edges); (2) authored `silhouetteNormals` signed-byte accessor (WebGPU re-derives face normals from adjacency → silhouette classification can diverge); (3) per-edge/per-lineString `materialColor` overrides (WebGPU applies one primitive-level color, no `a_edgeColor` equivalent). | `WebGPUEdgeVisibilityEmitter.ts`, `WebGPUModelRenderer.js` | L | P2 |
| positionNormalized + integer position datatypes (GPU-normalized positions) | missing | All three renderers assume DOUBLE positions (always Float32 high/low bound as float32x3); no integer/normalized path. A collection with non-DOUBLE `positionDatatype` or `positionNormalized:true` is silently mis-encoded (integer store read as f64 cartesians). Needs a second pipeline/vertex-layout variant keyed on datatype+normalized using snorm/unorm formats + a non-RTE upload path. | `WebGPUBufferPointRenderer.ts`, `WebGPUBufferPolygonRenderer.ts`, `WebGPUBufferPolylineRenderer.ts`, `Collections/BufferPointMaterial.wgsl`, `Collections/BufferPolygonMaterial.wgsl`, `Collections/BufferPolylineMaterial.wgsl` | L | P2 |
| Voxel default shader for common metadata types (PR#13517) | missing | Far larger than the default shader: `VoxelPrimitive.update()` short-circuits when the VOXEL_PRIMITIVE FR is registered (never reaches CustomShader/processVoxelProperties/buildVoxelDrawCommands), `WebGPUVoxelRenderer.ts` is a hardcoded RGB-density ray-marcher on a 4×4×4 gradient placeholder texture, and there is no WGSL transpilation of CustomShader GLSL. The PR#13517 default shader is one piece of a feature whose entire data path is unimplemented. | `WebGPUVoxelRenderer.ts`, `VoxelPrimitive.js`, `processVoxelProperties.js`, `buildVoxelDrawCommands.js`, `buildVoxelCustomShader.js`, `Voxels/VoxelRayMarch.wgsl`, `WebGPUFeatureRenderers.ts` | XL | P2 |
| GeoJsonPrimitive opaque polygon fills forced through TRANSLUCENT pass | partial | `GeoJsonPrimitive` builds collections without specifying `blendOption` (defaults TRANSLUCENT). The polygon renderer hard-codes `depthWriteEnabled=false` for color + `Pass.TRANSLUCENT`, so opaque GeoJSON fills don't write depth and are order-dependently composited → stacked/adjacent opaque polygons can show sort artifacts. Subsumed by the blendOption fix above; affects polyline path identically. | `WebGPUBufferPolygonRenderer.ts`, `WebGPUBufferPolylineRenderer.ts`, `WebGPUBufferPointRenderer.ts` | M | P2 |
| Degenerate-triangle edge fix (PR#13421) parity on WebGPU | partial | WebGPU tolerates degenerate tris without NaN (magnitude guard + bounds skip), but because it SYNTHESIZES face normals from positions rather than reading authored `silhouetteNormals`, a zero-area triangle biases the silhouette dot-product differently than WebGL's authored-normal path. No edge-degenerate probe matching the PR#13421 repro exists — can't confirm clean. | `WebGPUEdgeVisibilityEmitter.ts` | S | P3 |
| FEATURE_INVENTORY accuracy for EdgeDisplayMode (doc drift) | missing (doc) | Inventory marks WebGPU edge support fully SHIPPED (lines 608/609/657) with no §C/§D entry for the EdgeDisplayMode tri-mode + data-path gaps. Add a §C WIP entry (e.g. `NEW-EDGE-DISPLAY-MODE-WEBGPU`). | `FEATURE_INVENTORY.md`, `DEFERRED_WORK.md` | S | P3 |
| EXT_structural_metadata property-table encoding for vector tilesets | supported (P3 note) | No renderer gap — property tables are decoded CPU-side at model load; the vector buffer path carries only per-vertex featureId→pickColor. Listed for completeness; no WebGPU work. | `VectorGltf3DTileContent.js`, `Cesium3DTileVectorFeature.js` | S | P3 |
| GeoJsonPrimitive entry in migration feature inventory / tracking | missing (doc) | Grep for `GeoJsonPrimitive` across `migration_doc/` returns zero hits. New public exported Scene class funneling into three WebGPU renderers should be cataloged in §A with a note that its parity rides on the Buffer*Collection FeatureRenderers. | `FEATURE_INVENTORY.md`, `UPSTREAM_MERGE_2026-06_CHANGELOG.md` | S | P3 |
| debugShowBoundingVolume on GeoJsonPrimitive buffer collections (WebGPU) | missing | None of the three buffer renderers reference `debugShowBoundingVolume`; toggling it on a GeoJsonPrimitive collection draws nothing on WebGPU while WebGL draws the bounding-sphere debug primitive. Debug-only, low impact. Folds into the boundingVolume-wiring P1 work. | `WebGPUBufferPolygonRenderer.ts`, `WebGPUBufferPolylineRenderer.ts`, `WebGPUBufferPointRenderer.ts` | S | P3 |
| Vector-tile polygon outline (polygonOutlineColor/Width) | webgl-only-na | Not a WebGPU gap — polygon outline is unimplemented on BOTH backends (the fill shader has no outline; upstream outlines come from a separate LINE_LOOP collection). If upstream later wires it, both WGSL + GLSL need the edge pass added in lockstep (§5). | `Collections/BufferPolygonMaterial.js`, `renderBufferPolygonCollection.js` | M | P3 |

## Integration Plans (P0 / P1)

There are no P0 gaps. The four P1 items below should land first; three of them share
the same three buffer renderers, so plan them as one coordinated buffer-primitive
parity batch.

### P1 — World-space boundingVolume + debugShowBoundingVolume wiring (Effort S)

Lowest-risk, highest-value of the set, and the same omission pattern already fixed for
`ComputeInstance` (Batch 235) and GroundPrimitive. First steps: in each of
`WebGPUBufferPointRenderer.ts` (~L588–615), `WebGPUBufferPolygonRenderer.ts` (~L454–481),
and `WebGPUBufferPolylineRenderer.ts` (~L562–589), pass `collection.boundingVolume` and
`collection.debugShowBoundingVolume` to the `WebGPUDrawCommand` constructor — the command
already supports both (`WebGPUDrawCommand.ts:84,250,388,592`). Because the Scene-side
`_boundingVolume` auto-updates (world-space, `BoundingSphere.fromVertices` +
`BoundingSphere.transform(modelMatrix)`), refresh it onto the command **every frame**
rather than once at creation. This restores per-frustum culling and makes the debug
overlay functional in one pass; it also discharges the standalone P3
"debugShowBoundingVolume on GeoJsonPrimitive collections" row.

### P1 — BufferPrimitiveMaterial color.alpha translucency (Effort M)

The blocker is the packed-lane width. Today: point packs `showSizeAndColor` as vec3,
polygon `showAndColor` as vec2, polyline `showColorWidthAndTexCoord` as vec4 (all four
lanes already used), each decoding via `csm_decodeRGB8` (alpha hardcoded 1.0). First
steps: add a `csm_decodeRGBA8` helper (or carry alpha as a dedicated float lane where the
vec is full — polyline needs a new lane since its vec4 is saturated); widen the JS pack in
each `repack*Dirty` to emit alpha from `material.color.alpha`; update the matching WGSL
struct field and the GPU vertex-buffer `arrayStride`/`format` so CPU pack and GPU layout
stay in lockstep (a stride mismatch is a silent corruption per the Material-UBO-alignment
risk in §C.8). The dead `if (outColor.a < 0.005) discard` in each shader becomes live once
alpha actually varies. Verify with a translucent-fill probe (extend
`probe-bufferpolygon-vector-tile.mjs` with a 0.5-alpha fill) on both backends.

### P1 — blendOption (OPAQUE vs TRANSLUCENT) param (Effort M)

Best done in the same batch as the alpha work since both touch pipeline/pass selection.
First steps: surface `_blendOption` on the shared `WebGPUBufferPrimitiveRenderer.ts`
interface (read `collection._blendOption`, default `BlendOption.TRANSLUCENT`). Build and
**cache-key** a second OPAQUE pipeline variant (blend disabled, `depthWriteEnabled=true`)
alongside the existing translucent one in each renderer's pipeline builder
(`WebGPUBufferPointRenderer.ts:208–214`, `Polygon:117–128`, `Polyline:147–153`). Route the
command to `Pass.OPAQUE` (not the hardcoded `Pass.TRANSLUCENT` at `Point:594`/`Polygon:461`/
`Polyline:569`) when `_blendOption===BlendOption.OPAQUE`. This simultaneously fixes the P2
"GeoJsonPrimitive opaque polygon fills forced through TRANSLUCENT" row (GeoJSON fills are
commonly opaque and currently mis-sorted). Mirror WebGL's branch logic in
`renderBufferPointCollection.js:352–385` / `renderBufferPolygonCollection.js:284,313–316`.

### P1 — GeoJsonPrimitive WebGPU probe + Sandcastle demo (Effort M)

Per CLAUDE.md Principle 8, the new `GeoJsonPrimitive` render path must be Playwright-
verified before it can be claimed working. First steps: author
`Tools/visual-regression/probe-geojson-primitive.mjs` using `probe-saved-view.mjs` as the
template (Playwright + canvas-decode diff, no Node PNG dep). Load a mixed
`FeatureCollection` containing Point, LineString, and Polygon geometries **including a
polygon with a hole and a MultiPolygon** (these exercise the `parseGeoJson`
polygonVertexCount/holeCount/triangleCount allocation math at `GeoJsonPrimitive.js:454–467`
feeding collection capacities at L108–118) via `GeoJsonPrimitive.fromGeoJson` on both
backends, and record the WebGL↔WebGPU mismatch %. Add a gallery entry
`Apps/Sandcastle/gallery/WebGPU GeoJsonPrimitive.html` + index it in
`gallery-index.js`. Run this probe AFTER the three buffer-renderer fixes above land so it
also validates the alpha/blendOption/BV changes end-to-end through the loader.

## Already Tracked / No-op

### Renderer-agnostic — no WebGPU work (`supported` / `webgl-only-na`)

These findings were verified to need **no** WebGPU renderer changes; the relevant fix
lives in shared CPU / Scene / DataSources / Core code that both backends consume, or the
path is already shipped and probe-verified.

- **Vector-tile glTF polygon fill (EXT_mesh_polygon TRIANGLES + LINE_LOOP)** — `supported`; `WebGPUBufferPolygonRenderer.ts` fully implemented, repaired + probe-verified in Batch 180 (`probe-bufferpolygon-vector-tile.mjs`). Both topologies collapse to the same fill collection.
- **Vector-tile polyline + point glTF content** — `supported`; `WebGPUBufferPolyline/PointRenderer.ts` implement miter-extruded width + instanced-quad points; WASM batch-RTE encode wired (NEW-BUFFERCOLL-WASM-ENCODE-WIRE, SHIPPED).
- **Per-feature Cesium3DTileStyle styling** — `supported`; applied at the Scene layer via the backend-agnostic `_dirty`-driven repack; no WebGPU-specific code.
- **Feature-ID picking + getProperty metadata** — `supported`; WebGPU pick IDs + pick pipeline + `WebGPUPickFramebuffer` resolution wired; `getProperty` is CPU-side.
- **EXT_structural_metadata property-table encoding (vector tilesets)** — `supported`; decoded CPU-side at model load, no GPU metadata texture in the vector buffer path.
- **BufferPointCollection update-after-position-change (PR#13465)** — `supported`; **already tracked** as NEW-UPSTREAM-13465-BUFFERPOINT-STALENESS, SHIPPED Batch 270 (`DEFERRED_WORK.md:175`), probe-verified on both backends.
- **GeoJsonPrimitive core render chain** — `supported`; builds entirely on the three Buffer*Collections that already dispatch through the FeatureRenderer pattern (default DOUBLE positions, no normalized path exercised).
- **glTF invalid sampler wrap-mode fallback to REPEAT (PR#13562)** — `supported`; normalized in shared `GltfLoaderUtil.createSampler` before the Sampler ctor; WebGPU `_mapGLWrap` also defaults to `'repeat'`.
- **pickModel shared ModelReader + instance-transform + octDecode (PR#13433)** — `supported`; shared CPU pick path (`Model.pick` → `pickModel` → `ModelReader`); WebGPU retains typed arrays via `requiresVertexTypedArrayRetention`.
- **Scene.updateHeight position cache (#12602)** — `supported`; CPU-side `QuadtreePrimitive`/`QuadtreeTile` logic, runs before renderer dispatch; fork already carries the cache.
- **Stale showsUpdated on ground-primitive batches (#13366)** — `supported`; fix is in DataSources entity-batch bookkeeping (Batch 299, `e2ae29b7eb`), upstream of the renderer.
- **EquirectangularPanorama lighting fix `flat:true` (#13369)** — the *lighting* fix is `supported` on WebGPU (`matImageFlat` selected); the *cull-override* is a separate **partial** gap (P2 above).
- **Multiple key modifiers in ScreenSpaceEventHandler (#13307)** — `webgl-only-na`; pure DOM input bookkeeping in `Core/`, never touches the GPU pipeline.
- **Vector-tile polygon outline** — `webgl-only-na`; unimplemented on BOTH backends (outlines come from a separate LINE_LOOP collection, not the fill shader).

### Already tracked in FEATURE_INVENTORY §C/§D (verified against the file)

- **WebGPUVoxelRenderer placeholder** — tracked SCAFFOLDED at `FEATURE_INVENTORY.md:522` ("PLACEHOLDER gradient ray-marcher … `VoxelPrimitive.update` returns early"); per-cell pick tracked as **C-R9-VOXEL-CELL-PICK** (`:808`). The PR#13517 default-shader gap is a *new* facet of this known scaffold — the §C entry should be expanded to note the unreachable CustomShader / metadata-typed-default-shader path.
- **Vector3DTile classifier 2D/CV** — tracked as **NEW-CLASSIFIER-2D-CV-MORPH** (`:517–518`), but that entry covers the `.vctr` `Vector3DTile*` classifiers, **NOT** the `BufferPolygon` family. The buffer-collection 2D/CV gap (P2 above) is therefore **untracked** and needs its own entry.

### Untracked gaps to add (flagged by this audit)

The following real gaps are **not** currently in `FEATURE_INVENTORY.md` §C/§D or
`DEFERRED_WORK.md` and should be added during reconciliation:

- BufferPrimitive `color.alpha` translucency (P1), `blendOption` pass selection (P1), and world-space `boundingVolume`/`debugShowBoundingVolume` wiring (P1) — all untracked (the only tracked Buffer* item is the resolved PR#13465 staleness fix).
- `EdgeDisplayMode` tri-mode on WebGPU (SURFACES_ONLY suppression, EDGES_ONLY direct pass) + the lineStrings / silhouetteNormals / per-edge-color data paths — suggested key **NEW-EDGE-DISPLAY-MODE-WEBGPU** (`DEFERRED_WORK.md:175` flags only the silhouette-normal scheme change).
- EquirectangularPanorama cull-override (C-R1-PRIMITIVE-DERIVED explicitly excludes pipeline-cull derivation).
- BufferPolygon-family 2D/CV reprojection (distinct from NEW-CLASSIFIER-2D-CV-MORPH).
- `GeoJsonPrimitive` itself — add to §A (existing/upstream) noting its WebGPU parity rides on the Buffer*Collection FeatureRenderers.

---

*This audit was generated post-merge (upstream v1.141–1.143) on 2026-06-17 and reflects a
point-in-time code read. Its findings — especially the **untracked** gaps and doc-drift
rows above — should be reconciled into `FEATURE_INVENTORY.md` §C (WIP) / §D (FUTURE) and
`DEFERRED_WORK.md` so the inventory stays load-bearing for impact analysis (CLAUDE.md
Principle 6). When the P1 buffer-primitive work lands, promote the corresponding rows to
§B (SHIPPED) and link the verifying probe.*
