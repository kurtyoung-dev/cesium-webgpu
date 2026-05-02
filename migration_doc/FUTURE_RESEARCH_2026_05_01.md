# Future Research Inventory — 2026-05-01

Forward-looking explorations beyond the current C-R remediation backlog. Each entry follows the standard format:

- **What** — concrete description
- **Current state** — what the codebase has today
- **Feasibility** — browser/SDK/standards status as of 2026-05
- **What it would take** — sketch of the integration shape + cost
- **Recommended next step**

These are NOT commitments — they're triaged starting points for when capacity opens up. Triage state is one of: `Watch`, `Prototype`, `Plan`, `Ship`.

---

## R-1: NTC — Neural Texture Compression for 3D Tiles glTF Materials

**Triage:** `Watch` for full Inference-on-Sample (browser-gated). **`Prototype` candidates** for two near-term paths: (a) Inference-on-Load as a **download-bandwidth** optimization, and (b) a **latent-resident transcode pool** as a **VRAM-reduction** pattern — both achievable on plain WebGPU compute, both gated only on a real AEC/BIM 3D-Tiles workload showing up.

**What:** NVIDIA's RTX Neural Texture Compression ([RTXNTC](https://github.com/NVIDIA-RTX/RTXNTC)) replaces a *bundle* of correlated material textures (e.g., albedo+normal+MR+AO+emissive) with a small per-material **latent feature grid + 3-4 layer MLP decoder**. The decoder runs at sample-time (Inference on Sample) or as a one-shot transcode at load (Inference on Load). Reported numbers: ~5 bpp on disk for a typical 9-channel PBR set vs ~12 MB BC7 baseline = **~4.8× over BC7/BC5** and ~2-3× over UASTC at comparable PSNR (35-50 dB).

### Where the actual fit is — 3D Tiles glTF material path, NOT photogrammetry, NOT imagery

The earlier draft of this entry assumed photogrammetry was the right target. That's wrong. NTC's win comes from packing **9-16 correlated channels** through a single MLP — the inter-channel correlation is what beats per-texture BCn. The fit shape is:

| Cesium texture workload | Channels per material | NTC fit |
| --- | --- | --- |
| **Imagery tiles** (ImageryProvider → globe surface) | 1 RGB sRGB layer, no correlation across tiles | **Bad** — Basis/UASTC already wins. NTC has nothing to amortize. |
| **3D Tiles photogrammetry** (Reality Tiler / Google Photorealistic) | Albedo only (RGB), no normal/MR | **Bad** — single channel group. Worst case for NTC. |
| **3D Tiles AEC/BIM** + game-quality glTF | Full PBR: baseColor + MR (G+B packed) + normal + AO ± emissive ± clearcoat = 8-12 correlated channels | **Strong** — NTC's design target. |
| **3D Models** (`Cesium3DTileset` of glTF assets, KHR_materials_*) | Same as AEC/BIM | **Strong** — same path. |

So R-1 narrows from "neural codec for Cesium" to **"neural codec for the glTF material textures that flow through `Model3DTileContent` + the Model renderer."** The imagery tile path stays on KTX2/Basis indefinitely.

### Current Cesium-WebGPU texture pipeline (where NTC would plug in)

The cesium-webgpu glTF texture flow already has the exact extension hook NTC would need — `KHR_texture_basisu` is the architectural template:

1. **Extension negotiation**: [GltfLoaderUtil.js:49-55](../packages/engine/Source/Scene/GltfLoaderUtil.js) resolves `texture.extensions.KHR_texture_basisu.source` per-texture. Capability flows from `frameState.context.supportsBasis` ([GltfLoader.js:584-586](../packages/engine/Source/Scene/GltfLoader.js)).
2. **Mime detection + dispatch**: [GltfImageLoader.js:253,292-298](../packages/engine/Source/Scene/GltfImageLoader.js) sniffs `image/ktx2` / `.ktx2` and calls `loadKTX2`.
3. **Transcoder**: [Core/loadKTX2.js](../packages/engine/Source/Core/loadKTX2.js) → `KTX2Transcoder.js` → `Workers/transcodeKTX2.js` (Basis WASM) returns a `CompressedTextureBuffer` with target `internalFormat` + mip levels.
4. **Texture creation**: [GltfTextureLoader.js:316-327](../packages/engine/Source/Scene/GltfTextureLoader.js) calls `Texture.create({ source: { arrayBufferView, mipLevels }, pixelFormat })`.
5. **WebGPU upload**: [WebGPUTexture.ts:448,509](../packages/engine/Source/Renderer/WebGPU/WebGPUTexture.ts) `device.queue.writeTexture` + `getWebGPUCompressionFormat` ([:688-709](../packages/engine/Source/Renderer/WebGPU/WebGPUTexture.ts)) maps to BC1/2/3/7.
6. **Capability advertisement**: [WebGPUContext.ts:2340](../packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts) `get supportsBasis`.

A hypothetical `EXT_texture_ntc` slots in identically — new mime, new loader, new worker, new context capability flag.

### NTC inference modes — web feasibility per mode

Three canonical NVIDIA modes plus a fourth software pattern that's specific to web (essentially a software-managed Inference-on-Feedback without sparse residency):

| Mode | What runs at sample time | HW/API gating on web | Realistic 2026 status |
| --- | --- | --- | --- |
| **Inference on Sample** | Per-texel MLP eval; must pair with **Stochastic Texture Filtering** + temporal denoiser (NTC sample output is unfiltered single-texel — without STF+DLSS-style accumulation the image is dithered noise) | WebGPU `subgroup_matrix` (gpuweb [issue #4195](https://github.com/gpuweb/gpuweb/issues/4195)) — **status: "Needs Decision"** as of mid-2026; Dawn has a prototype on Metal/Vulkan ([dawn/docs/dawn/features/subgroup_matrix.md](https://dawn.googlesource.com/dawn/+/refs/heads/main/docs/dawn/features/subgroup_matrix.md)) but **not in Chrome stable**. Even if `subgroup_matrix` lands, we still need a temporal accumulator — Cesium has no DLSS-class denoiser. | **Blocked.** Browser-gated 12-18 mo for Chrome stable, 18-24+ for cross-browser. Our code-side effort is ~10-15 sessions plus 5-8 for TAA. |
| **Inference on Load** | Compute-shader transcode `.ntc → BC7/BC5/BC4` at tile load; rendered as standard BCn texture afterward | **Plain WebGPU compute + storage textures.** No subgroup_matrix needed — INT8 DP4a-equivalent fallback path runs as portable WGSL. | **Achievable today.** Win is **~4-5× download bandwidth** (2.5 MB vs 12 MB on-disk) and ~2-3× over UASTC. VRAM stays at BC7 baseline. |
| **Latent-Resident Transcode Pool** *(software pattern, web-specific)* | Latents resident in VRAM (~5 bpp); fixed-size LRU pool of decoded BC7 working set; compute-dispatch decode latents → BC7 when a tile becomes visible, evict BC7 (keep latents) when it leaves the working set | **Plain WebGPU compute** — same primitives as Inference-on-Load. Reuses Cesium's existing `TileReplacementQueue` / `Cesium3DTileset` cache plumbing for the LRU pool. | **Achievable today.** For a 1000-material scene with 50 visible at a time: 1000 × 2.5 MB latents + 50 × 12 MB working set ≈ **3.1 GB vs 12 GB BC7-only baseline (~75% VRAM reduction)**. Trade: ms-scale decode latency when a tile re-enters the working set. |
| **Inference on Feedback** | Per-frame Sampler Feedback → decode tiles into sparse BCn pages | DX12-only on the desktop side (Vulkan has no equivalent). WebGPU has no Sampler Feedback or sparse residency. | **Not viable** on web for the foreseeable future. |

**Pure-compute Inference-on-Sample WITHOUT `subgroup_matrix`** is a fifth theoretical option — write the per-thread MLP eval in plain WGSL FMAs. NVIDIA explicitly labels this "validation only — significantly slower than DP4a fallback." For Cesium fragment workloads (~1-2K multiplies per texel × anisotropic taps), expect **10-50× slower than a hardware BC7 sample**. Functionally works, not production-viable.

### Two near-term paths — bandwidth (Inference-on-Load) and VRAM (Latent-Resident Pool)

Both paths share the same offline encoder, on-disk format, and loader infrastructure. The difference is purely runtime: Inference-on-Load decodes once at tile-load and discards latents; the Latent-Resident Pool keeps latents resident and re-decodes on visibility transitions.

**Shared infrastructure (both paths):**

- **Encoder (offline)**: `ntc-cli` from RTXNTC SDK, integrated into Cesium Ion / Reality Tiler pipeline next to the existing `--color-texture-compression KTX2` step. Per [Cesium Reality Tiler V2 docs](https://cesium.com/learn/3d-tiling/on-prem/on-prem-reality-tiler/), the slot exists; ETC1S is what they emit today.
- **Loader (web)**: `Source/Core/loadNTC.js` parallel to `loadKTX2.js`. Reads the `.ntc` Bundle Manifest, identifies target BCn formats per channel group, dispatches a WGSL compute pipeline that emits BC7/BC5/BC4 byte buffers, hands those to the existing `Texture.create({ source: { arrayBufferView } })` path.
- **Worker shape**: WebGPU compute can't run in a Worker easily today (one device per main thread is the de facto pattern). The decode is ~ms-scale per tile so doing it on the main thread between frames is acceptable; a future Worker-WebGPU pattern would move it off-thread.
- **Capability flag**: `context.supportsNTC` gated on `WebGPU + supportsBasis (BC7) + WGSL compute`. Hard fallback to KTX2/Basis when absent — every NTC asset would ship as a `.ntc` + a `.ktx2` fallback the same way `KHR_texture_basisu` falls back to JPEG/PNG.

**Path A — Inference on Load (bandwidth optimization):**

Tile streaming is bandwidth-bound on most workloads; a 4-5× reduction in `.ntc`-vs-`.ktx2` payload size meaningfully reduces time-to-textured-tile on slow networks for AEC/BIM datasets. Decoded BC7 lives in VRAM at full size; latents are discarded after decode. **No VRAM win.** Simplest version of the pattern — basically a "different transcoder for KTX2-shaped data."

**Path B — Latent-Resident Transcode Pool (VRAM reduction):**

Same loader, different residency policy. Keep the compact latents (~5 bpp) resident as the source of truth; allocate a fixed-size pool of BC7 working-set textures that are filled on-demand when a tile becomes visible and freed (latents kept) when it leaves visibility.

- **VRAM math (1000-material AEC/BIM scene, 50 visible)**: today 12 GB BC7; with this scheme **3.1 GB total (~75% reduction)**.
- **Cost**: re-decode latency when a tile re-enters the working set (one compute dispatch, ms-scale). Mitigated by predictive prefetch when the camera approaches a tile boundary — Cesium already does this for tile loading.
- **Plumbing**: maps onto `TileReplacementQueue` and `Cesium3DTileset`'s existing LRU cache. The "freeze the tile but keep its source representation" pattern is already there for geometry; adding a parallel for textures is the new piece.
- **Failure mode**: pool sized too small → thrash (constant decode/evict). Pool sized too large → diminishing VRAM returns. Needs a heuristic tuned per-device (probably tied to `device.limits.maxBufferSize` and a config knob).
- **This is NOT an NVIDIA-blessed pattern.** It's specific to web's lack of Sampler Feedback / sparse residency. Conceptually it's a software emulation of Inference-on-Feedback's working-set semantics.

### Tooling status

- **`ntc-cli`** + Python wrapper + `convert_gltf_materials.py` exist (RTXNTC SDK).
- **No KHR glTF extension for NTC.** This would be vendor-extension territory (`EXT_texture_ntc` or `NV_texture_ntc`). Cesium contributing a draft to Khronos is plausible if we go past prototype.
- **Reference encoder** is CUDA-only (Turing+, Ada+ recommended). The web side only needs the runtime decoder, which is portable.
- **arxiv 2506.06040** ("Hardware Accelerated Neural Block Texture Compression with Cooperative Vectors", 2025) is the canonical reference for the on-load → BCn transcoding path.

### Limitations to flag up front

- **Photogrammetry won't benefit** — it's the dominant 3D Tiles workload by data volume but the wrong texture shape. R-1 would need to land alongside a parallel photogrammetry-specific compression effort (or just leave photogrammetry on KTX2 ETC1S forever).
- **Encoder is offline-only and CUDA-bound.** Cesium Ion would need a CUDA encode worker added to the Reality Tiler / 3D-Tiles asset pipeline. Not a runtime concern but a real deployment cost.
- **Per-material training is grouping-sensitive.** AEC/BIM glTFs with one PBR set per mesh map well. Atlas-packed textures (multiple unrelated materials in one image) defeat the codec — the encoder needs material-identity grouping that photogrammetry pipelines don't preserve.
- **No KHR extension yet** = no interop guarantee with other glTF tooling. A `.ktx2` fallback is mandatory.

### Recommended next steps

**Effort decomposition for the full Inference-on-Sample path (the high-VRAM-savings target):**

The "12-24 month horizon" is browser-dominated, not effort-dominated. Decomposing:

| Component | Owner | Effort | Status |
| --- | --- | --- | --- |
| WebGPU `subgroup_matrix` lands in Chrome stable | Chrome / gpuweb | 12-18 months | Browser-gated, outside our control |
| Cross-browser parity (Firefox / Safari) | Mozilla / Apple | 18-24+ months | Browser-gated |
| WGSL port of NTC INT8/FP8 decoder kernels | Us | 2-3 sessions | Can validate against Dawn proto today (Linux/macOS, flag-gated) |
| Loader infrastructure (`loadNTC.js`, mime, fallback) | Us | 1-2 sessions | Achievable today |
| Sample-time integration into the Model renderer | Us | 2-3 sessions | Achievable today |
| Sandcastle demo + benchmarks | Us | 1-2 sessions | Achievable today |
| **TAA / temporal denoiser** (gates sample-time output quality) | Us | 5-8 sessions | Independently useful (also needed for general AA, motion blur, SSR). `previousViewProjection` plumbing from Batch 27 is one ingredient. |

Total code-side effort: **~10-15 sessions for NTC plus ~5-8 for TAA = 15-23 sessions**, spread over a few weeks of focused work. We hit the browser gate well before we hit the code gate.

**Parallel work paths available today (don't need to wait):**

1. Develop the WGSL kernels against Dawn's flag-gated `subgroup_matrix` prototype on Linux/macOS — validates the codec but can't ship to users until it lands in Chrome stable.
2. Build TAA independently — useful for several other features regardless of NTC. Already in the deferred work backlog (CSM/TAA session handoff).
3. Land `loadNTC.js` + the offline encode pipeline targeting Inference-on-Load **first**, so the asset pipeline + extension wiring is ready when sample-time becomes viable.

**Concrete recommendations:**

1. **Watch** the WebGPU `subgroup_matrix` proposal (gpuweb#4195). Re-triage Inference-on-Sample to `Plan` when it lands in Chrome stable.
2. **Optional Prototype A — Inference on Load** (bandwidth optimization). ~4 sessions:
   - 1 session: WGSL port of NTC INT8 DP4a decoder, validate against reference output for a single test material.
   - 2 sessions: end-to-end loader (`loadNTC.js`, mime sniffing, fallback) + Sandcastle demo with one AEC glTF.
   - 1 session: bandwidth/load-time benchmarks vs KTX2 UASTC.
3. **Optional Prototype B — Latent-Resident Transcode Pool** (VRAM reduction, web-specific pattern). ~6-8 sessions, builds on Prototype A:
   - 2-3 sessions: LRU pool manager parallel to `TileReplacementQueue`. Per-device size heuristic. Eviction policy + decode-on-promote.
   - 1 session: predictive prefetch hook (decode latents into BC7 ahead of camera approach to mitigate decode-latency spikes).
   - 1 session: Sandcastle demo with a synthetic 1000-material AEC scene to demonstrate the VRAM curve.
   - 1-2 sessions: pool-size tuning + thrash-detection telemetry.
4. **Both prototypes gate on the same thing**: a real AEC/BIM 3D-Tiles user with the relevant workload. Not justified by photogrammetry or imagery.
5. **Don't pursue** Inference-on-Feedback — DX12-only, no WebGPU equivalent.
6. **Don't pursue** pure-compute Inference-on-Sample without `subgroup_matrix` — 10-50× too slow vs hardware BC7 sample.

### Bottom line

NTC is real, the savings are real, and the integration shape into cesium-webgpu's texture pipeline is well-defined (`KHR_texture_basisu` is the template). The picture across the four modes:

- **Inference on Sample (canonical VRAM win, ~5× over BC7)** — browser-gated 12-18 months for Chrome stable, plus we owe a TAA denoiser (~5-8 sessions, independently useful). Our code piece is small (~10-15 sessions); browser support is the long pole.
- **Inference on Load (bandwidth win, ~4-5× over BC7 on disk)** — achievable today on plain WebGPU compute. ~4 sessions.
- **Latent-Resident Transcode Pool (VRAM win, ~75% reduction for AEC/BIM working sets)** — also achievable today. Web-specific software pattern, not NVIDIA-blessed but maps cleanly onto Cesium's existing tile-cache plumbing. ~6-8 sessions on top of Inference-on-Load.
- **Inference on Feedback** — not viable on web; no Sampler Feedback, no sparse residency.

**The user-facing gate is "an AEC/BIM 3D-Tiles workload with VRAM or bandwidth pressure."** The dominant 3D Tiles workload (photogrammetry) is the wrong texture shape for NTC and won't benefit. Imagery tiles also won't benefit. If/when a user shows up with the right workload, all three viable paths can land in well under a quarter of focused work — and we'd start with Path B (Latent-Resident Pool) if VRAM is the bottleneck, Path A (Inference-on-Load) if bandwidth is, or both since they share the loader.

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

### Profiling infrastructure (landed 2026-05-02)

CPU-side per-pass recording-cost profiler is now wired:

- **Module**: [WebGPUCpuPassProfiler.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUCpuPassProfiler.ts) — rolling-window (60-frame) per-pass timer. Zero overhead when disabled (`time(name, fn)` short-circuits without touching `performance.now()`).
- **Distinction from existing GPU profiler**: [WebGPUTimestampProfiler.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUTimestampProfiler.ts) measures GPU execution time via timestamp queries; this one measures **CPU JS-side recording cost** — the time spent walking the command list and calling `setPipeline` / `setBindGroup` / `draw` before submission. Bundles attack CPU recording cost specifically.
- **Instrumented dispatch points** (in [WebGPUSceneRendererFrustumLoop.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUSceneRendererFrustumLoop.ts)): `environment`, `globe`, `3dTiles`, `voxels`, `opaque`, `translucent`. Plus `shadow`, `pick`, `postFrustumChain` at the SceneRenderer level. Sub-pass timings within a frustum accumulate into per-frame buckets.

**To collect data:**

```js
// In the browser console on http://localhost:8080/Apps/CesiumViewer/index.html?renderer=webgpu
CesiumDebug.cpuPassCost(true);          // enable + reset
// ... navigate to a representative scene, let it run for several seconds ...
CesiumDebug.cpuPassCost();               // dump rolling-window stats (sorted by avgMs desc)
CesiumDebug.cpuPassCost(false);          // disable
```

**Reading the output:**

| avgMs | Interpretation |
| --- | --- |
| < 1 ms | Bundling won't move the needle. Skip. |
| 1–3 ms | Marginal. Bundle if the pass is also stable across frames; skip if commands churn. |
| 3–5 ms | Worth bundling. Expect 50-80% CPU cost reduction on stable command lists. |
| > 5 ms | Strong candidate. Globe terrain hit this range pre-bundling and was the original R-7 win. |

**Suggested test scenes for the first profile pass:**

- **Cesium Viewer default** (Earth + Bing imagery + no 3D Tiles) — baselines `globe` cost.
- **Cesium Viewer + Cesium World Terrain + Cesium OSM Buildings** — stresses `3dTiles` and `opaque`.
- **A photogrammetry tileset** (Google Photorealistic 3D Tiles or a public Reality Tiler asset) — stresses `3dTiles` with high draw-call counts.
- **A scene with translucent geometry + OIT enabled** — stresses `translucent`.
- **Hover-active workload** — measure `pick` separately (only fires on actual pick frames).

After one collection session, this section should be replaced with measured numbers + a triaged shortlist of the 1-2 highest-ROI bundle expansion sites.

---

## Summary Triage Table

| ID | Topic | Triage | Effort to first useful result |
| --- | --- | --- | --- |
| R-1 | NTC — Inference on Sample (canonical VRAM win) | Watch | Browser-gated 12-18 mo; our code ~15-23 sessions including TAA |
| R-1a | NTC — Inference on Load (bandwidth win) | Prototype (workload-gated) | ~4 sessions, achievable today |
| R-1b | NTC — Latent-Resident Transcode Pool (VRAM win, web-specific) | Prototype (workload-gated) | ~6-8 sessions on top of R-1a, achievable today |
| R-2a | Audit cross-source attribute unification | Plan | 1 session |
| R-2b | Unified feature-id texture | Plan | 3 sessions |
| R-2c | GPU-driven cross-source LOD | Plan (research) | 5+ sessions |
| R-3 | WebNN imagery super-resolution | Prototype | 3 sessions, Chrome-only |
| R-4 | Rust/WASM MVT vector basemap | Plan | 6-8 sessions for v1 |
| R-5 | Single-buffer GPU picking | Watch (negative ROI for our workload) | N/A |
| R-6 | MIL-STD-2525 symbology | Watch (demand-gated) | 2-3 sessions |
| R-7 | Expand GPURenderBundle coverage | Plan (profile-gated) | 1–2 sessions per high-ROI site |
