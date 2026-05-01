# Future Research Inventory — 2026-05-01

Forward-looking explorations beyond the current C-R remediation backlog. Each entry follows the standard format:

- **What** — concrete description
- **Current state** — what the codebase has today
- **Feasibility** — browser/SDK/standards status as of 2026-05
- **What it would take** — sketch of the integration shape + cost
- **Recommended next step**

These are NOT commitments — they're triaged starting points for when capacity opens up. Triage state is one of: `Watch`, `Prototype`, `Plan`, `Ship`.

---

## R-1: NTC — Neural Texture Compression

**Triage:** `Watch`

**What:** NVIDIA's RTX Neural Texture Compression replaces block-compressed textures (BC1–BC7, ASTC) with a tiny MLP that decompresses on-sample. Demonstrated at GTC 2026 reducing texture VRAM by up to 85% (e.g., 6.5 GB → 970 MB for a typical AAA scene).

**Current state:** We support standard codecs already — KTX2/Basis (via `KhronosTextureContainer`-style loaders touched in 10+ files including `WebGPUMipmapGenerator.ts`, `WebGPUFeatureFlags.ts`), plus the underlying BC/ASTC/ETC2 GPU formats when the device exposes them. No neural decode path. Cesium's typical workload is heavily imagery-tile-bound, so VRAM pressure shows up as imagery tile thrash on long flights, not as material textures the way games experience it.

**Feasibility:**
- **NVIDIA SDK** ([RTXNTC](https://github.com/NVIDIA-RTX/RTXNTC)) is open but Tensor-Core-bound. Without Tensor Cores, runtime decode is unviable at real-time speeds.
- **WebGPU**: no public NTC port. The blocker is matrix-multiply primitives — WebGPU's [cooperative-matrix proposal](https://github.com/gpuweb/gpuweb/issues/4195) is still draft. Subgroups are Chrome-flagged in 2026. Without one or both, you're back to per-thread MLP eval which kills performance.
- **Adjacent precedent**: [WebSplatter (Feb 2026)](https://arxiv.org/abs/2602.03207) shows what a fully GPU-driven WebGPU compute pipeline can do for 3DGS — wait-free hierarchical radix sort, opacity-aware culling. Same architectural shape NTC would need.
- **PlayCanvas** comparison was a non-result — they use standard KTX2/Basis like us.

**What it would take:**
1. Wait for cooperative-matrix or production-ready subgroups in Chrome stable.
2. Port the RTXNTC reference WGSL kernels (or wait for someone else to publish).
3. New texture format pseudo-codec under `Source/Renderer/WebGPU/Texture/` — wraps the standard `GPUTexture` factory but registers a sampler-replacement that issues the MLP eval per-sample (or pre-decodes a tile region into a temp BC7 if real-time decode is too costly).
4. Sit behind a feature flag in `WebGPUFeatureFlags` keyed on `cooperative-matrix` device feature. Hard fall-back to KTX2/Basis when absent.

**Recommended next step:** Watch. Quarterly check on (a) WebGPU cooperative-matrix spec progress, (b) any community NTC port. Re-triage to `Prototype` when both land.

**Why this isn't urgent:** Imagery tiles dominate our texture budget, not material textures. A neural codec for imagery is a research problem (the existing NTC is for tiled material textures with mipmap chains; satellite imagery has different statistics). The win for Cesium is much smaller than for a game engine.

---

## R-2: Multimodal Data Fusion — Renderer/Scene-Layer Opportunities

**Triage:** `Plan` (specific sub-items are actionable today)

**What:** "Fuse" multiple geospatial data types (raster imagery, vector polygons, terrain, point clouds, glTF buildings, time-dynamic CZML, IoT live feeds) into one consistent rendered scene with consistent lighting, shadowing, picking, and LOD logic across all sources.

**Current state — where Cesium already does this:**
- **Data-source level**: 3D Tiles 1.1 ([CesiumGS/3d-tiles](https://github.com/CesiumGS/3d-tiles)) is heterogeneous by design — B3DM (buildings), I3DM (instanced), PNTS (points), CMPT (composite of any of the above). Cesium Ion is the off-platform fusion side: imagery mosaicking, terrain meshing, 3D model tiling.
- **Scene-graph level**: `Scene.js` already runs unified frustum culling, command-list dispatch, and depth-sorted rendering across all sources. Picking unifies through `Picking.js` with per-source feature ID decoding (we have `WebGPUSceneRendererPickPass.ts` from Batch 133).
- **Time fusion**: CZML + clock-driven property graphs.

**What we DON'T do today (real gaps):**

1. **GPU-side cross-source attribute joins.** If a vector polygon layer carries a `nationCode` and an imagery layer is keyed on a per-pixel landcover ID, there's no single shader pass that can multiply them. WebGL feature-id systems are a step toward this; WebGPU's storage textures + structured buffers make this much cheaper.

2. **Unified GPU-driven LOD that considers all sources jointly.** Today each provider picks LOD against its own tree (terrain via `QuadtreePrimitive`, 3D Tiles via `Cesium3DTileset` SSE). A camera staring at a single building should be allowed to suppress imagery-tile LOD pressure on that building's footprint, because the building covers the imagery. We don't do this. WebGPU compute makes a single GPU-driven LOD selector across multiple trees feasible.

3. **Cross-source shadow casting.** glTF models cast shadows onto terrain, but 3D Tiles classification primitives (footprints projected onto terrain) don't consistently participate in CSM. Active C-R item, see ADR-2026-04-28 in `DEFERRED_WORK.md`.

4. **Live-feed fusion with raster imagery.** No first-class IoT/streaming layer — users build it manually with `Entity` updates. A WebGPU storage-buffer-backed "dynamic raster" would let live numeric feeds (weather, traffic) modulate imagery in-shader.

**Recommended next steps (sub-tasks):**

- **R-2a**: Audit `Scene.frameState` to identify what cross-source attributes are already unified vs. what's per-source-only. **1 session.**
- **R-2b**: Prototype a "unified feature-id texture" that stores feature IDs from any visible source at each fragment, so post-process effects can read source-agnostic IDs. **3 sessions, depends on Batch 133 pick pass infrastructure.**
- **R-2c**: GPU-driven LOD experiment — single compute shader that picks LOD across the visible tile sources jointly. **Research-grade; 5+ sessions, possibly a thesis-shaped problem.**

---

## R-3: WebNN API — Browser-Side ML Inference

**Triage:** `Watch` for general use, `Prototype` for one specific use case (imagery super-resolution).

**What:** [W3C Web Neural Network API](https://webstatus.dev/features/webnn) — a browser-native ML inference primitive that maps onto NPU/GPU/DirectML/CoreML/etc. Reached Candidate Recommendation in Jan 2026.

**Browser support (2026-05):**
- **Chrome / Edge**: experimental, behind flags. GPU/NPU support is preview.
- **Safari / Firefox**: not implemented. Production-stable is best-estimated at 2027.
- **Best platform**: Windows.

**Three concrete use cases for a globe engine:**

1. **Imagery tile super-resolution.** Upscale a 256×256 satellite tile to 512×512 on-device when the user zooms past the tile's native LOD. Avoids fetching the next zoom level until the user commits.
   - **Pre-trained models**: [ESPCN](https://huggingface.co/onnxmodelzoo/super-resolution-10) (~100KB, ONNX), [allenai/satlas-super-resolution](https://github.com/allenai/satlas-super-resolution) for satellite-specific. Free to use.
   - **Integration shape**: new feature renderer `WebGPUImagerySuperResRenderer` that intercepts tile uploads, runs them through WebNN before the GPU upload, caches the upscaled result.
   - **Cost**: ~3 sessions for a Chrome-only prototype; +1 to feature-flag-gate so non-Chrome falls back.

2. **On-device imagery segmentation.** Land cover / cloud detection / road extraction directly on the visible tile. Output is a mask that feeds a custom material layer.
   - **Pre-trained models**: many on Hugging Face for satellite — DeepLabV3+ variants, Segment-Anything (SAM is too heavy, but smaller variants exist). Most are free.
   - **Integration shape**: post-process pass that samples the segmentation mask and modulates color (e.g., highlight all roads).
   - **Cost**: ~5 sessions including mask-uploading, layer compositing.

3. **AI-driven LOD selection.** Reinforcement-learning model trained to predict perceptual importance of each on-screen region, then bias LOD selection toward important regions.
   - **Pre-trained models**: none ready-made. This requires training. Skip for now.

**Recommended next step:** Prototype R-3 use case (1) — imagery super-resolution — as a Chrome-flagged feature renderer. The pre-trained ESPCN model is small, the integration is contained (one tile-upload interception point), and the visible win on slow networks is real. Defer (2) and (3) until WebNN is in Safari/Firefox.

---

## R-4: Off-thread Rust/WASM MVT Vector Tile Path

**Triage:** `Plan`

**What:** Render Mapbox Vector Tiles (MVT/PBF) as a basemap layer or as overlay vector data. Off-thread parsing + tessellation, dispatched to a new `WebGPUVectorTileRenderer` feature renderer.

**Current state:**
- We have **Vector 3D Tiles** support (`Vector3DTilePrimitive.js`, `Vector3DTilePolygons.js`, `Vector3DTilePoints.js`, `Vector3DTilePolylines.js`, etc.) — that's 3D Tiles' VCT format, NOT MVT.
- No MVT support today. Vector basemaps (the OSM/Mapbox style of "colored polygons + roads + labels") are not a first-class renderer feature.
- WASM is used for terrain math (`packages/engine/Source/WorkersES6/`), not for spatial parsing.

**Feasibility:** High.
- **Rust crate**: [`mvt-reader`](https://lib.rs/crates/mvt-reader) v2.2.0 is production-ready with a `wasm` feature flag. Decodes MVT directly into iterable layers/features.
- **Tessellation**: `earcutr` (Rust port of mapbox/earcut) is also a solid WASM target.
- **Worker pattern**: Cesium already uses Web Workers for tile-decode (terrain, imagery). Adding an MVT-decode worker is a known pattern.

**What it would take:**
1. New WASM module `packages/engine/Source/Workers/mvtDecode.rs` (or co-locate with existing Workers). Rust crate compiled to WASM with `wasm-bindgen`. ~200 LOC of Rust, mostly glue.
2. New TS adapter `packages/engine/Source/Scene/MapboxVectorTileImageryProvider.ts` — fetches PBF tiles, dispatches to the worker, receives parsed feature list back.
3. New feature renderer `packages/engine/Source/Renderer/WebGPU/WebGPUVectorTileRenderer.ts` — takes the worker's tessellated geometry, builds a per-tile vertex buffer, draws with a flat-shaded WGSL.
4. Style system: simple Mapbox GL Style spec subset (paint properties for color/width). Or punt to a per-feature style callback for v1.

**Cost:** ~6-8 sessions for a usable v1. ~12 for parity with deck.gl's vector basemap rendering.

**Recommended next step:** Prototype the WASM worker integration first (1 session) to confirm `mvt-reader` behaves the way we expect. Then decide whether to build the renderer half.

**Why bother:** Cesium's competitive weak point vs. Mapbox/MapLibre is "no opinionated vector basemap." Users glue OSM raster tiles together when they want a basemap. A first-class MVT layer closes that gap.

---

## R-5: Single-Buffer GPU Picking (MapGPU-Style)

**Triage:** `Watch` (architecturally interesting but expensive to chase)

**What:** Write pick IDs as a second render-target attachment alongside color, in the SAME render pass. Eliminates the dedicated pick pass; the pick FBO becomes a 2nd color attachment that the existing color pipelines also write.

**Current state:**
- We have a dedicated pick pass (`WebGPUSceneRendererPickPass.ts`, Batch 133). It re-walks every visible command with `isPickPass=true` and draws a pick variant.
- Pick variant pipelines are derived from each command's color pipeline at registration time (`derivedCommands.picking`).
- 10 renderer files write to pick framebuffers today: globe surface, models, ground primitive, ground polyline, vector 3D tiles (3 variants), buffer primitives, model feature ID, model pipeline cache.

**Feasibility:** Technically possible but a major architectural commitment.
- WebGPU pipelines support up to 8 color attachments; using one for pick IDs is fine.
- Every pipeline descriptor in our renderer set needs to gain a 2nd fragment output slot.
- Every WGSL fragment shader needs a `@location(1) pickId: vec4<u32>` (or similar) output, even if it just writes 0.
- Render-pass color attachments must MATCH the pipeline's expected attachments — so we'd need to attach pick FBO views to EVERY render pass, including ones where pick isn't active (toggle via `loadOp: 'load'` and write nothing? Or accept that pick is always-on).

**Cost analysis:**
- **Pros**: One walk of the command list per frame instead of two. Theoretical ~2x throughput on pick-heavy workloads.
- **Cons**: Every render target must be allocated at scene FBO size (pick FBO usually was scaled down to 1×1 or a small region). Memory cost goes up. Fragment shaders pay a guaranteed 2nd write per pixel even when nothing is reading.
- **Real ROI**: probably negative for typical Cesium workloads. Pick is on-demand (mouse hover/click); paying 100% color-pass cost to save a per-pick re-walk is a bad trade if picks happen 10× per second.

**Recommended next step:** Don't pursue. Document the analysis here as the answer to "should we steal MapGPU's unified pick?" — the answer is no, for our workload shape. If a future profile shows pick passes are >5% frame time, revisit.

---

## R-6: MIL-STD-2525D/E Military Symbology

**Triage:** `Watch` (only ship if a user actually asks)

**What:** Render military symbology glyphs (NATO unit markers, equipment icons, control measures) as billboards on the globe. Defined by US DoD spec MIL-STD-2525D (2014) and 2525E (2022).

**Current state:** Not present.

**Feasibility:** High.
- [`milsymbol.js`](https://github.com/spatialillusions/milsymbol) is a mature MIT-licensed JS library that generates SVG glyphs from 2525-coded strings. Production-ready since ~2017.
- Our `BillboardCollection` already handles rasterized icons + GPU-batched draws on both WebGL and WebGPU paths.

**What it would take:**
1. Optional npm dep on `milsymbol`.
2. New thin layer `Source/Scene/MilStd2525Collection.js` that wraps `BillboardCollection` and decodes symbology strings into billboard configs.
3. Documentation + a Sandcastle demo.

**Cost:** ~2-3 sessions including tests and demo.

**Recommended next step:** Hold. Track whether anyone asks. If a defense/SAR user shows up, build it — the implementation is mostly glue.

---

## R-7: GPURenderBundles — Expansion Beyond Current Three Sites

**Triage:** `Plan` (sub-items are actionable per-renderer).

**What:** WebGPU `GPURenderBundle` lets us pre-record a sequence of draw commands (set pipeline / set bind group / set vertex buffer / drawIndexed) once and replay it via `passEncoder.executeBundles([bundle])` on subsequent frames. Saves CPU recording overhead — anywhere from 50–80% reduction has been measured on static-geometry passes.

**Current state — already supported, three active wiring sites:**

- **Manager**: [WebGPURenderBundleManager.ts](../packages/engine/Source/Renderer/WebGPU/WebGPURenderBundleManager.ts) (495 LOC). Caches by string key, version-based invalidation, frame-age eviction, `asFreezable(target)` decorator pattern.
- **Context hook**: `WebGPUContext.renderBundleManager` overrides the abstract `GraphicsContext` getter so renderers can fetch the manager backend-agnostically.
- **Wired today**:
  1. **Globe opaque terrain** (`WebGPUSceneRendererGlobePass.ts`) — gated on `perfMgr.config.renderBundleThreshold ?? 8`; try/catch fallback for driver bugs.
  2. **Environment** sun/moon/stars (`WebGPUEnvironmentRenderer.js`) — recorded once at init, replayed every frame.
  3. **Volumetric fog** (`WebGPUVolumetricFogRenderer.ts`) — `asFreezable()` registration pattern.

**Untapped expansion candidates** (in rough order of likely ROI):

| Target | Why bundleable | Why it's not bundled today | Risk |
| --- | --- | --- | --- |
| **R-7a — 3D Tiles opaque models** (B3DM/I3DM) | Per-tile pipeline + bind groups stay constant once the tile loads; only the camera UB changes (and UBs can be live-bound across bundle replays). | Per-frame pipeline switching during tile-load animation. Once a tile reaches `READY` state, its draw calls stabilize. | Low — same tile-load shape as globe terrain, which already works. |
| **R-7b — Translucent/OIT collect pass** | OIT has fixed pipeline + 2 color attachments + sort-independent draw order. Per-frame data is in UBs only. | None — bundle-friendly today, just nobody hooked it up. | Low. |
| **R-7c — Pick pass** | Re-walks the whole command list with pick variants. CPU-heaviest pass on hover-active workloads. Bundle the static-tile commands; per-frame pick coords live in a UB. | Pick pass was extracted as `WebGPUSceneRendererPickPass.ts` in Batch 133 without bundle integration. | Medium — pick variants change less often than color, but partial-pick scenarios (mouse near LOD boundary) trigger re-records. |
| **R-7d — Shadow cast pass** | Same draw list as opaque, just different pipeline + depth-only. CSM cascades each get their own render pass. | Cascades change every camera move. Bundle cost amortizes only across frames where the camera is still. | Low value when camera moves continuously, high value when paused — net unclear without profiling. |
| **R-7e — Vector 3D Tiles primitives** | Per-tile commands (polygons, polylines, points) are fixed per tile generation. | Not yet wired. | Low. |
| **R-7f — Buffer primitives** (Box/Sphere/Cylinder) | Geometry is shared across all instances; only per-instance UBs change. | Renderer wasn't bundle-aware when it landed. | Low. |

**Recommended next steps:**

1. **Profile first.** Measure CPU recording cost as % of frame time across these passes on the existing demos (Cesium Viewer, split-screen). A pass at <2% frame time isn't worth bundling. Globe terrain bundle hit was big because it dominated CPU recording.
2. **Pick the 1–2 highest-cost candidates from the profile and prototype.** Likely R-7a (3D Tiles models) and R-7b (translucent), based on draw-call density alone.
3. **Don't bundle R-7c (pick) yet.** Pick is on-demand, not per-frame. Hot-path savings from R-7d (shadows) and R-7e/f are also speculative without numbers.

**Cost:** ~1–2 sessions per renderer-site once a profile points at the highest-ROI target. The plumbing pattern (`asFreezable`, threshold gate, fallback try/catch) is already proven in the three existing sites.

---

## Summary Triage Table

| ID | Topic | Triage | Effort to first useful result |
| --- | --- | --- | --- |
| R-1 | Neural Texture Compression | Watch | Blocked on WebGPU cooperative-matrix |
| R-2a | Audit cross-source attribute unification | Plan | 1 session |
| R-2b | Unified feature-id texture | Plan | 3 sessions |
| R-2c | GPU-driven cross-source LOD | Plan (research) | 5+ sessions |
| R-3 | WebNN imagery super-resolution | Prototype | 3 sessions, Chrome-only |
| R-4 | Rust/WASM MVT vector basemap | Plan | 6-8 sessions for v1 |
| R-5 | Single-buffer GPU picking | Watch (negative ROI for our workload) | N/A |
| R-6 | MIL-STD-2525 symbology | Watch (demand-gated) | 2-3 sessions |
| R-7 | Expand GPURenderBundle coverage | Plan (profile-gated) | 1–2 sessions per high-ROI site |
