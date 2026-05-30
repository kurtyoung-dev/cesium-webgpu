# Phase 8 — GPU-Resident Tiles Design

**Created:** 2026-04-14 (Session 29)
**Status:** Design — Phase 8a foundation largely SHIPPED; Phase 8b (TileStoreGPU / DOD storage layer) genuinely unbuilt. See "What actually shipped" reconciliation below.
**Supersedes portions of:** Phase 7 backlog prioritization (`WEBGPU_MIGRATION_BACKLOG.md`)
**Purpose:** Architectural synthesis of three parallel investigations (existing feature inventory, 3D Tiles current implementation audit, 3D Tiles 2.0 spec research). Identifies the central insight, the gating architectural decision, the dependency layering, and a recommended phased roadmap that unifies rendering-quality and planet-scale-performance goals.

> **Read this if:** you're starting a new session after 2026-04-14 and need the architectural frame, not just a feature list. The per-item detail is in the Phase 7 section of `WEBGPU_MIGRATION_BACKLOG.md`; this doc says how to think about it.

---

## 0. What Actually Shipped (reconciliation, 2026-05-30 · HEAD `88b111e49c` Batch 185)

> This doc was written 2026-04-14 as forward-looking design. Several premises in §2, §3, and §4.A have since been **overtaken by shipped work** and must be read with these corrections. The architectural synthesis (the GPU-resident-tile-cache framing, the DAG, the §3.5 TileStoreGPU layout) is still durable; the specific "today's state" claims below are not.
>
> **Phase 8a foundation — largely SHIPPED.** The shader-variant strategy (the gating decision in §2) landed: glTF model pipelines are now keyed on a wider variant space, not a 3-bit key, and the KHR BRDFs ride real per-extension shader blocks.
>
> **Phase 8b GPU-resident stack — genuinely UNBUILT.** No `TileStoreGPU`, MegaBuffer mesh atlas, Resident Drawer, sharedSourceBuffer fanout, or WGSL styling compiler exists yet. §3.5 remains the live design for that work and has no successor doc — this section does NOT supersede it.
>
> ### Corrections to specific "today's state" claims
>
> - **§2 / §40 "KHR extensions silently dropped on the WebGPU path" — STALE.** `ModelPBRComplete.wgsl` now ships real BRDF blocks for `KHR_texture_transform`, `KHR_materials_clearcoat`, `_specular`, `_anisotropy`, `_iridescence`, `_sheen`, `_volume`, and `_transmission`, each gated by a `FLAG_HAS_*` material flag (`ModelPBRComplete.wgsl:63-72`, sampling sites `:2086,2119,2270,2325,2371,2437,2444`; texture transform `:1613`). These are no longer dropped on WebGPU — they were wired across the C-R4-GLTF-KHR slices.
> - **§2 "3-bit key / at most 6 pipeline variants" — STALE.** `WebGPUModelPipelineCache.computeKey` is now `alphaMode | (doubleSided ? 4 : 0) | (materialDefines << 3)` (`WebGPUModelPipelineCache.js:181-183`), where `materialDefines` carries `MODEL_HAS_KHR_TEXTURES` (`ShaderDefine` bit 9), `MODEL_HAS_TEXCOORD_1` (bit 12), and `MODEL_HAS_FEATURE_ID_0` (bit 13), plus separate pick variants (`STOCHASTIC_DITHER_ALPHA` bit 10, `STENCIL_PICK_WINNER` bit 11). The variant axis the §2 strategy called for exists; the basic/full KHR split (`MODEL_HAS_KHR_TEXTURES`) is the coarse pipeline-family gate, with the per-extension granular split tracked as a follow-up in the `KHR_BINDING_MANIFEST` docstring (`WebGPUModelPipelineCache.js:81-116`).
> - **§2 point 2 "`KHR_lights_punctual` isn't wired … hardcodes 1 sun + ambient" — STALE.** The model FS now carries `punctualLights: array<PunctualLight, 8>` with a `punctualLightCount`-bounded loop (`ModelPBRComplete.wgsl:290-301,2555-2587`) plus the Slice 5d Forward+ clustered-lighting path (Batches 153-158). Clustered lighting has something to cluster.
> - **§4.A "cheap BRDFs aren't cheap until shader strategy is settled" — RESOLVED.** The strategy is settled and the BRDFs landed on it; the misleading-effort-estimate warning is now historical.
>
> ### Corrected bit-budget (was the basis for the §2 variant math)
>
> The `ShaderDefine` registry in `WebGPUShaderDefines.ts` currently has **16 allocated bits, 0-15** (`GEODETIC_NORMAL` 1<<0 … `LOG_DEPTH` 1<<15). The shader-module-cache key reserves 24 bits for the active-defines mask, so **8 define bits remain** (16-23). (Earlier drafts of the Phase-8 shader strategy quoted a different budget; this is the verified count at HEAD.)
>
> ### Still accurate
>
> The Phase 8b draw-path collapse (§3.5), the three hidden gotchas §4.B (DDGI-per-tile) and §4.C (WGSL styling compiler), the §9 tech-debt / perf / WASM inventory, and the dependency DAG in §3 are all still live. The normal G-buffer + depth-prepass foundation item (§3 Foundation, §7 missing-feature #1/#10) remains the highest-leverage unblocker.

---

## 1. The Central Insight

Three independent investigations — "what features are we missing," "how does 3D Tiles flow through our renderer," "what does 3D Tiles 2.0 add" — each converged on the same pattern from different angles. Compressed to one sentence:

> **The destination is a GPU-resident octree of tiles where the per-frame CPU cost is O(camera-delta), not O(visible-tiles).**

3D Tiles' primary data property is that **tile content is mostly static across frames; the camera moves.** The correct abstraction is therefore a persistent GPU-side tile cache where the CPU's only per-frame job is updating "which tiles, which LOD" — everything else (culling, styling, draw-command building, per-feature coloring, occlusion) runs on the GPU against durable buffers.

This is **Unreal's Nanite / Unity's GPU Resident Drawer paradigm adapted for planetary scale.** No other engine does this at globe scale because no other engine targets globe scale. It's also the architecture Cesium's own 3D Tiles design has been implicitly heading toward for years — implicit tiling, subtree availability bitstreams, S2 cells, the metadata framework are all CPU-side manifestations of GPU-residency-ready data structures.

Three reports, three angles, same conclusion:

- **Agent 1** (existing features vs Phase 7 backlog) flagged **normal G-buffer** as the single highest-leverage infra gap — unblocks 6+ downstream items.
- **Agent 2** (3D Tiles implementation audit) flagged **MegaBuffer + Resident Drawer + tile-level Hi-Z** as the top bottleneck stack — today's path allocates per-tile and produces 1k-10k draw calls/frame with no cross-frame persistence.
- **Agent 3** (3D Tiles 2.0 spec research) flagged **WGSL styling expression compiler + property-texture sampling + ellipsoid-aware RTE** as the spec-level gaps — tile metadata is evaluated CPU-side every frame and re-uploaded on each style change.

All three are facets of the same "persistent GPU tile cache" architecture.

---

## 2. The One Architectural Decision That Gates ~30% of the Backlog

> **STALE as of Batch 185 — see §0 reconciliation.** The 3-bit-key / 6-variant premise and the "silently dropped KHR extensions" bullet below describe the 2026-04-14 state. The variant strategy this section argues for has since SHIPPED (wider pipeline key + per-extension KHR BRDF blocks). The architectural argument is preserved here as the rationale-of-record; the "today" claims are not current.

`WebGPUModelPipelineCache` caches pipelines on a **3-bit key** (`alphaMode | doubleSided<<2`) — **at most 6 pipeline variants for ALL glTF content in ALL tiles combined**. The WebGL path uses ShaderBuilder to generate per-permutation shaders (dozens of variants).

This was a deliberate trade-off: **zero pipeline-compile stutter** in exchange for:

- Runtime branch divergence (monolithic `ModelPBRComplete.wgsl` branches at runtime for every feature).
- Over-fetch from always-bound default textures (5 textures always sampled, even when unused).
- **Silent dropping of KHR extensions on the WebGPU path** (`clearcoat`, `sheen`, `anisotropy`, `iridescence`, `transmission`, `volume`, `variants`, `IOR`, `lights_punctual` — all work in WebGL, all dropped in WebGPU).

### Cascading consequences

1. **Phase 7 items FEAT-SURVEY-02/03/04** (clearcoat/sheen/anisotropy, marked "S effort") **are NOT actually cheap.** You cannot just bolt a BRDF term onto `ModelPBRComplete.wgsl` without either (a) growing the monolithic shader past maintainability, or (b) introducing the pipeline-variant strategy we explicitly avoided.

2. **FEAT-SURVEY-40** (Clustered Forward Lighting, L effort) has a hidden prerequisite: `KHR_lights_punctual` isn't wired in the WebGPU model path at all — the shader hardcodes 1 sun + ambient in `packLightUniforms`. Without punctual lights there's nothing to cluster.

3. **The 5 default textures always bound** pay fetch cost on every fragment even when unused. This accumulates across thousands of 3D Tiles draw calls per frame.

### The strategy decision

| Strategy | Compile cost | Runtime cost | Extension support | Fit |
| --- | --- | --- | --- | --- |
| **Keep monolithic** (today) | ~0 | High | Must add flag bits per BRDF; shader grows linearly | Hits a wall at 4-5 BRDFs |
| **Fine-grained variants** (WebGL-style) | High (stutter on tile stream) | Low | Free | Bad for 3D Tiles streaming |
| **Coarse variants + pre-warm** (recommended) | Low (~20 pipelines) | Low | Moderate | Best fit |

The third option — ~20 pipelines keyed on "material family" (`{MR, SG, Clearcoat, Sheen, Anisotropy, Transmission}` × `alphaMode` × `doubleSided`) combined with **pre-warmed pipeline compilation during tileset load** — is the sweet spot. Unity URP reached the same conclusion per Agent 1's Unity notes: "keyword-light material UBO split."

**This decision should land BEFORE any BRDF item.** Otherwise each BRDF addition becomes a mini-referendum on shader architecture.

---

## 3. Dependency Layering (DAG)

Reading all Phase 7 items + Agent 1's 10 missing features + Agent 3's spec items as a single dependency graph.

### Foundation layer (unblocks everything else)

Changes here cascade into multiple downstream items. These are the "do first" candidates even when they feel like plumbing:

- **Normal G-buffer + depth prepass** (Agent 1 gap #10). Unblocks: GTAO, SSR quality, contact shadows, planar reflections, bent-normal AO, motion blur, SSGI. Arguably the single highest-leverage infra item in the combined backlog.
- **ParityManager** (FEAT-SURVEY-07). Unblocks clean impl of: TAA, STP, auto-exposure history, Hi-Z previous frame, reflection probe invalidation. Eliminates a bug class.
- **Shader variant strategy for glTF** (§2 above). Unblocks: all KHR BRDFs, `KHR_lights_punctual`, clustered lighting pipeline.
- **Ellipsoid-aware RTE audit** (Agent 3 item #3). Correctness fix for non-WGS84 tilesets (Mars/Moon). Audit `encodedCameraHigh/Low` + `mvpRelativeToEye` producers to accept the tileset ellipsoid instead of hardcoding WGS84.
- **3D Tiles ↔ Hi-Z wiring**. `WebGPUHiZOcclusionDispatcher.ts` exists but consumes `ViewportExecutor` command lists, not tile bounding volumes. Direct tile-selection integration culls 20-40% of tiles in dense cityscapes.

### 3D Tiles GPU-resident stack (performance goal)

These interlock. Doing any one alone gives <half the win; doing them together transforms the draw path:

- **MegaBuffer + `firstIndex`/`baseVertex` mesh atlas** (FEAT-SURVEY-20). One VB/IB for many meshes; compute shader emits `meshID` per visible instance; single indirect draw renders many shapes. **RTE caveat:** canonical stride includes `positionHigh`/`Low` (doubles per-vertex size).
- **Resident Drawer / persistent instance table** (FEAT-SURVEY-24). Per-tile data lives across frames; per-instance uniform upload amortized.
- **sharedSourceBuffer compute-cull fanout** (FEAT-SURVEY-25). One entity stream feeds many indirect-draw variants (color pass, CSM cascades, TAA history, depth prepass, shadow caster).
- **Dynamic-offset UBO + indirect dispatch** (FEAT-SURVEY-23). Orchestration pattern for all of the above.
- **Styling expression → WGSL compiler** (Agent 3 #1). GPU-side `show`/`color`/numeric-expression evaluation against the persistent instance table. See §4.C below — this is the single biggest 3D Tiles performance lever.
- **Property-texture + feature-ID path audit in WGSL** (Agent 3 #2). The WGSL side of GPU styling; must sample per-feature properties, not just feature IDs.
- **WBOIT** (FEAT-SURVEY-21). Alpha-sort pressure at horizon doesn't disappear just because you moved to indirect draws.
- **Impostors for far-LOD 3D Tiles** (Agent 1 gap #7). Billboard substitutes for distant tiles. Natural fit for persistent tile cache (bake once on tile load).

### 3D Tiles visual-quality stack (looks goal)

Depends on shader-variant strategy being decided:

- **`KHR_lights_punctual` wiring.** Gates clustered lighting; fixes current hardcoded "1 sun + ambient."
- **Clearcoat + sheen + anisotropy + iridescence BRDFs** (FEAT-SURVEY-02/03/04 + missing). Batch under one variant-strategy PR.
- **GTAO** (FEAT-SURVEY-01). Needs normal G-buffer from Foundation.
- **Env probes with parallax correction** (FEAT-SURVEY-26). Interior reflections for 3D Tiles buildings; complements sky-only IBL.
- **Planar reflections** (Agent 1 gap #3). Water/wet surfaces; complements SSR.
- **Decals** (Agent 1 gap #8). Road markings, AOI overlays projected onto terrain + 3D Tiles. Existing `GROUND_PRIMITIVE` is flat-plane — real decal system needs depth-buffer projection + oriented-box volumes.
- **Aerial-perspective LUT consumer in all passes** (Agent 1 gap #9). `AtmosphereLUT.wgsl` exists; ground atmosphere samples it. Making models, point clouds, Gaussian splats, Buffer primitives all sample it fixes "distant content looks over-saturated against haze." Sneaky low-effort win.
- **Clustered Forward Lighting** (FEAT-SURVEY-40). Real nighttime cityscapes with thousands of streetlights. Depends on KHR_lights_punctual.

### Advanced / deferred

- TAA (dormant `TAA_DESIGN.md`) → STP upscaler (gated on TAA motion vectors) → upscaling chain.
- CSM (dormant `CSM_DESIGN.md`) + ESM/VSM/PCSS filter variants stack.
- FFT/Gerstner/FBM ocean (FEAT-SURVEY-41) → refraction/caustics (water quality substack).
- DDGI (FEAT-SURVEY-46) → APV (FEAT-SURVEY-47) — interior GI. See §4.B below for the "DDGI is more tractable for us than you think" argument.
- NGA_GPM point-cloud uncertainty visualization (differentiating for defense/survey).
- Grass/foliage material + vegetation instancing (stacks atop Resident Drawer).

---

## 3.5 The DOD Storage Layer — what Phase 8b actually is

The six items listed in Phase 8b's "GPU-resident stack" (MegaBuffer, Resident Drawer, sharedSourceBuffer, dynamic-offset UBO, WGSL styling compiler, property-texture audit) are not independent features. **Assembled, they are a single data-oriented storage layer for 3D Tiles with Cesium API facades on top.** Treating them as six isolated items under-counts the compounding benefit and over-counts the per-item effort (much of the plumbing is shared).

This section clarifies the architecture and explains why the earlier Phase 7 rejection of NullGraph's "zero scene graph" DOD was at the wrong layer.

### 3.5.A Why 3D Tiles is unusually favorable to DOD

Most game engines that adopt DOD (Unity Resident Drawer, Unreal Nanite) pay a complexity cost because game entities mutate arbitrarily per frame. 3D Tiles doesn't. Five properties make 3D Tiles *structurally* more favorable to DOD than most scenes:

1. **Stable spatial keys.** Every tile has a deterministic octree ID (`level/x/y/z`). Natural SoA index; siblings in memory are siblings in space.
2. **Rare mutation.** Geometry doesn't change per frame once loaded. The scene-graph walk is pure read.
3. **Fixed schema per tile.** Bounding sphere, LOD error, transform, material ref, content ref. Columnar storage is natural.
4. **Hot/cold property split.** SSE distance changes per frame; geometric error doesn't. Textbook layout opportunity.
5. **Explicit streaming lifecycle.** Load / evict events are known write points. No mid-frame mutation.

Games get none of these five reliably. 3D Tiles gets all five.

### 3.5.B The three levels of "zero copy"

"Zero-copy" is often used loosely. Three distinct levels:

| Level | Where copies happen today | Cut by |
| --- | --- | --- |
| **CPU→CPU marshalling on load** | Network bytes → JS object tree → typed arrays | Already partly zero-copy via WASM decoders; TILE-PERF-02 (KTX2 on worker) + TILE-ARCH-01 (mesh dedup) close remaining gaps |
| **CPU→GPU round-trip per frame** | Style evaluation walks features CPU-side, writes batch texture, uploads every style change | FEAT-3DT2-01 (WGSL styling compiler): compute shader evaluates against persistent feature-properties buffer; zero CPU round-trip per frame |
| **Per-frame CPU hot-path work** | DrawCommand object allocation per-tile, per-tile uniform writes, CPU tree walk, `Array.prototype.sort` on command list | The DOD storage layer below collapses this entirely — per-frame CPU cost becomes O(camera-delta), not O(visible-tiles) |

Level 3 is where DOD pays the largest dividend. It is also the level the Phase 8b items collectively address.

### 3.5.C The TileStoreGPU layout

The storage layer that falls out of assembling Phase 8b:

```text
TileStoreGPU:

  # Hot per-frame (read-only during rendering)
  tileTransforms:       GPUBuffer<mat4x4>[N]     # model matrix per tile
  tileBoundingSpheres:  GPUBuffer<vec4>[N]       # BS per tile (for GPU cull)
  tileLODErrors:        GPUBuffer<f32>[N]        # geometric error per tile
  tileMaterialRefs:     GPUBuffer<u32>[N]        # index into material table
  tileMeshRefs:         GPUBuffer<u32>[N]        # index into mesh atlas
  tileFlagsLOD:         GPUBuffer<u32>[N]        # visible/culled/LOD bits

  # Megabuffers (shared across tiles, content-addressable)
  vertexMegaBuffer:     GPUBuffer                # all tile vertex data
  indexMegaBuffer:      GPUBuffer                # all tile index data
  textureAtlas:         GPUTexture (2D array)    # shared albedo/normal/MR
  materialTable:        GPUBuffer<Material>[M]   # deduped by material hash

  # Feature-level (style targets)
  featureProperties:    GPUBuffer<Props>[F]      # per-feature data across all tiles
  featureStyleOutput:   GPUBuffer<vec4>[F]       # color+show after style eval

  # Lifecycle (CPU-side, not uploaded per frame)
  freeTileSlots:        Uint32Array              # recycled IDs for evicted tiles
  dirtyTileSlots:       Uint32Array              # slots to batch-upload next frame
```

Each Phase 8b item is one component of this store:

| Phase 8b item | Role in TileStoreGPU |
| --- | --- |
| FEAT-SURVEY-20 MegaBuffer | `vertexMegaBuffer` + `indexMegaBuffer` + `tileMeshRefs` |
| FEAT-SURVEY-24 Resident Drawer | The per-tile SoA arrays themselves (`tileTransforms`, etc.) |
| FEAT-SURVEY-25 sharedSourceBuffer fanout | `tileFlagsLOD` as the shared visibility stream; compute passes fan out to color / shadow / depth-prepass from it |
| FEAT-SURVEY-23 dynamic-offset UBO | Per-material-family UBO binding via one uniform buffer + offset |
| FEAT-3DT2-01 WGSL styling compiler | Compute shader writing `featureStyleOutput` from compiled style expression against `featureProperties` |
| FEAT-3DT2-02 Property-texture audit | Confirm WGSL model shader samples `featureProperties` / `featureStyleOutput` on the draw path |
| TILE-ARCH-01 Cross-tile mesh dedup | `materialTable` + shared-mesh hashing feeds the mega-buffers |
| TILE-PERF-03 Shared UBO | Per-frame camera/atmosphere/light UBO bound once per pass (not per tile) |

### 3.5.D Per-frame CPU work after the collapse

For rendering 10,000 tiles in a typical planetary view:

**Today (Pre-Phase-8b):**

- Walk the tile tree (O(visible-tiles) traversal).
- For each visible tile: compute SSE, frustum test, fog test.
- For each passing tile × each primitive: allocate `DrawCommand` object.
- For each DrawCommand: write model matrix, material uniforms, per-instance data to a UBO slot.
- Collect command list, `Array.prototype.sort` by eye distance.
- Issue ~1k-10k draw calls.
- On style change: walk every feature on CPU, evaluate JS expression, re-upload batch texture.

**After Phase 8b (TileStoreGPU in place):**

1. Camera update (one small UBO write).
2. Traversal decides which slot IDs are at the right LOD for this camera → emit one `Uint32Array visibleTileIDs`.
3. Dispatch compute pass: cull + build indirect draws for those IDs.
4. Submit indirect draws.

That's it. **No per-tile DrawCommand objects. No per-tile uniform writes per frame. No CPU sort on the command list. No CPU style re-evaluation.** Per-frame CPU cost is O(camera-delta), not O(visible-tiles).

### 3.5.E Cesium API compatibility — the facade pattern

The public API (`Cesium3DTileset`, `Cesium3DTile`, `tile.boundingSphere`, `tile.content`, `scene.pick()`) stays unchanged. Under the hood:

```javascript
// Today
class Cesium3DTile {
  constructor() {
    this._boundingSphere = new BoundingSphere();   // heap object per tile
    this._computedTransform = new Matrix4();       // heap object per tile
    // ... ~20 more heap-allocated sub-objects
  }
  get boundingSphere() { return this._boundingSphere; }
}

// After Phase 8b (DOD backing, same API)
class Cesium3DTile {
  constructor(slotId) {
    this._slotId = slotId;                         // just a uint32
    this._bsScratch = new BoundingSphere();        // lazy scratch, reused
  }
  get boundingSphere() {
    return TileStoreCPU.readBoundingSphere(this._slotId, this._bsScratch);
  }
}
```

Writes go through setters that mark slots dirty; a per-frame uploader flushes dirty slots as one batched `queue.writeBuffer`. This is precisely Unity's Resident Drawer pattern: public types (`GameObject`, `MeshRenderer`) don't change; the SRP batcher underneath stores per-instance data in a contiguous buffer.

### 3.5.F The correction on NullGraph DOD

Phase 7's "rejected wholesale" language about NullGraph's "zero scene graph" DOD was **too broad**. The correct framing:

- **Rejected (correctly):** NullGraph's wholesale replacement of the scene-graph *public API*. We keep `Cesium3DTileset` / `Primitive` / `Entity` intact.
- **Adopted (partially, via Phase 8b):** NullGraph's DOD *storage layer pattern*. MegaBuffer + per-material BatchManager + sharedSourceBuffer fanout + contiguous SoA storage. This is effectively what Phase 8b assembles for 3D Tiles.

The overlap is significant — Phase 8b, when landed, *is* the DOD architecture, re-derived for 3D Tiles with Cesium API facades on top. The name was misleading (it's not zero-scene-graph, it's facade-over-DOD-storage), which is why the convergence wasn't obvious during the initial Phase 7 survey.

### 3.5.G Gotchas specific to the DOD storage layer

Six things that need explicit design work if/when Phase 8b is scoped:

1. **Picking.** `scene.pick()` currently walks the tile tree CPU-side. DOD moves this to a GPU pick-framebuffer or compute pass over `TileStoreGPU`. Different code path but well-understood.
2. **Morph targets / skinning.** Per-frame-mutating. DOD story: a small per-tile "dynamic slot" region (morph weights + joint matrices); vertex shader reads both the static mesh buffer and the dynamic slot. Zero-copy per frame after initial setup.
3. **User-driven feature highlights.** Style changes dispatch a compute pass; per-feature highlights become one-word writes to `featureStyleOutput[featureId]`. Cheap.
4. **Debugging / inspection.** `CesiumDebug.snapshot()` and per-tile visualization need to read state. DOD: one-time GPU→CPU readback on demand. Debugging isn't a hot path — acceptable cost.
5. **Dynamic tileset.modelMatrix.** Animated root transform. DOD: one buffer write for the root per frame, not per-tile. Trivial.
6. **Entity / DataSource paths.** These don't go through 3D Tiles directly. Cesium has multiple paths (Primitive, Entity, DataSource, 3DTileset). DOD is scoped to the 3D Tiles path specifically; the others stay object-oriented.

### 3.5.H Effort-estimate correction

The original Phase 8b duration estimate (3-4 weeks for six items) undersized the shared plumbing. A more honest split:

- **Foundation plumbing** (TileStoreGPU schema + CPU mirror + slot lifecycle + upload batcher) — 1 week. Required for every Phase 8b item.
- **MegaBuffer + Resident Drawer + material dedup** on that foundation — 1 week.
- **sharedSourceBuffer + dynamic-offset UBO orchestration** — 0.5 week.
- **WGSL styling compiler (restricted subset)** + property-texture audit — 1.5 weeks.
- **Picking + API facade conversion** — 1 week.

Revised: **~5 weeks for Phase 8b fully assembled**, with the foundation plumbing also serving as a prerequisite for Phase 8e items (DDGI per-tile probes, NGA_GPM uncertainty, grass/foliage instancing all consume TileStoreGPU slots).

### 3.5.I What this section does NOT say

- **It does NOT recommend doing all of Phase 8b as one giant PR.** Each step above is independently testable; the foundation plumbing alone delivers value (shared UBO, slot lifecycle) without the full draw-path collapse.
- **It does NOT eliminate Cesium's object model.** `Cesium3DTile` and friends remain as lightweight handles; the API contract doesn't break.
- **It does NOT apply to non-3D-Tiles paths** (Primitive, Entity, DataSource). Those stay object-oriented; the cost model is different (low tile count, mutable entity data).
- **It does NOT commit to a specific slot-count cap.** `N`, `M`, `F` in the schema above are tunable; starting point would be something like N=65536 tiles, M=4096 materials, F=16M features — easy to grow.

---

## 4. Three Hidden Gotchas Cutting Across Items

### A. "Cheap" BRDFs aren't cheap until shader strategy is settled

Covered in §2. The biggest misleading-effort-estimate in the Phase 7 backlog. The BRDF additions themselves are a day each in WGSL; integrating them without the shader-variant strategy is not.

### B. DDGI for 3D Tiles is tractable in a way Unity's APV isn't

Agent 1 rightly deferred DDGI (FEAT-SURVEY-46) and APV (FEAT-SURVEY-47). The reason APV doesn't work in general engines at planet scale — streaming cadence can't be camera-anchored when world spans 10⁷ m — is actually *solved for us by 3D Tiles itself*. The octree already provides:

- Spatial chunks with known extents.
- Loading lifecycle with explicit load/unload events.
- LOD transitions we already manage.

A probe per tile × cascade level is a natural fit: probes live with their tile, evict with their tile, refresh when the tile refreshes. This makes a per-tile-group probe cage a **smaller design problem for us than for a general engine.** Revisit DDGI after Resident Drawer lands — the two compose naturally.

### C. The styling WGSL compiler is the most underestimated item

Agent 3 sized it L-XL because Cesium's full style expression language is rich (conditionals, functions, regex). But: even a restricted subset (conditionals + numeric comparisons + color literals) covers 80% of production style sheets in practice.

A **progressive implementation** — parse → AST → restricted-subset WGSL with fallback to CPU → grow the subset over time — is **M effort for the first delivery** and lands the core performance win before the long-tail features.

Today, every style change on a million-feature tileset:

1. Walks every feature on the CPU.
2. Evaluates the expression in JS.
3. Re-uploads per-feature color + show buffers to the GPU.

A restricted WGSL subset would replace this with:

1. Compile the expression once on style-change (CPU).
2. Dispatch a compute shader that writes per-feature color + show to a persistent buffer (GPU).
3. Subsequent frames read directly — zero re-upload.

For a million features, that's the difference between ~50ms/style-change (today) and ~0.2ms/style-change.

**This is the single biggest "3D Tiles performance at planetary scale" lever in the entire backlog** and deserves a design doc of its own once this phase lands.

---

## 5. Recommended Phased Roadmap

Not a commitment — a proposal for how each phase enables the next without rework. Effort estimates are rough and will need per-item refinement.

### Phase 8a — Foundation (1-2 weeks)

Theme: *unblock the rest.*

| Item | Effort | Unblocks |
| --- | --- | --- |
| Shader variant strategy decision + prototype pipeline cache | M | All KHR BRDFs, clustered lighting |
| Normal G-buffer + depth prepass | M | GTAO, SSR-GI, contact shadows, planar reflections, motion blur |
| ParityManager infra | S | TAA, STP, auto-exposure history, Hi-Z previous |
| Ellipsoid-aware RTE audit + fix | M | Correctness for Mars/Moon tilesets |
| Tile ↔ Hi-Z wiring | S-M | 20-40% culling gain on dense cityscapes |

### Phase 8b — 3D Tiles GPU-Resident (3-4 weeks)

Theme: *collapse 1k-10k draw calls/frame to O(10); move styling to GPU.*

| Item | Effort |
| --- | --- |
| MegaBuffer + `firstIndex`/`baseVertex` mesh atlas | L |
| Resident Drawer / persistent instance table | M |
| sharedSourceBuffer compute-cull fanout | S-M |
| Dynamic-offset UBO + indirect dispatch orchestration | M |
| Styling expression → WGSL compiler (restricted subset) | M |
| Property-texture + feature-ID WGSL audit | M |
| WBOIT for horizon alpha-sort | M |

### Phase 8c — 3D Tiles Visual Quality (3-4 weeks)

Theme: *make tiles look as good as possible, now that shader variants are solved.*

| Item | Effort | Depends on |
| --- | --- | --- |
| `KHR_lights_punctual` wiring | S | 8a shader strategy |
| Clearcoat BRDF | S | 8a shader strategy |
| Sheen BRDF | S | 8a shader strategy |
| Anisotropy BRDF | S | 8a shader strategy |
| Iridescence BRDF | S | 8a shader strategy |
| GTAO | S | 8a normal G-buffer |
| Env probes with parallax | M | 8a shader strategy |
| Aerial-perspective LUT consumer in all passes | S-M | — |
| Decals system | M-L | 8a normal G-buffer |
| Clustered Forward Lighting | L | KHR_lights_punctual above |

### Phase 8d — Advanced (4-6 weeks)

Theme: *dormant designs + cinematic features.*

| Item | Effort |
| --- | --- |
| TAA implementation | L (3 days per `TAA_DESIGN.md`) |
| CSM implementation | L (4 days per `CSM_DESIGN.md`) |
| ESM / VSM / PCSS shadow filters | S each (after CSM) |
| STP upscaler | L (after TAA) |
| Planar reflections | M |
| FFT ocean | L |
| Motion blur (camera + per-object) | M (after TAA motion vectors) |
| Impostors for far-LOD | M |

### Phase 8e — Differentiators (opportunistic)

Theme: *unique-to-us features and bounded-use-case items.*

| Item | Effort |
| --- | --- |
| NGA_GPM point-cloud uncertainty in WGSL | L |
| DDGI with per-tile probe cages | L (easier for us than general engines — see §4.B) |
| Grass/foliage material + vegetation instancing | M-L |
| Refraction/caustics | M |

**What's explicitly NOT on the critical path:** TAA and CSM are old dormant design docs, but they don't unblock the 3D Tiles performance story. They ride alongside Phase 8d, slotting into whatever bandwidth exists.

---

## 6. The One-Paragraph Version

The WebGPU fork chose a monolithic glTF shader over per-permutation compilation, which trades pipeline stutter for runtime divergence and silently-dropped KHR extensions. That decision needs to be revisited coarsely (~20 material-family pipelines) before the cheap-looking BRDF items in Phase 7 can actually land cheaply. Meanwhile, the WebGL-compatible 3D Tiles draw path hits the WebGPU renderer with 1k-10k per-frame draw commands and no persistent GPU state between frames — which is the real performance story, and which maps cleanly onto the convergent "GPU-resident tile cache" pattern that three independent signals (Unity Resident Drawer, NullGraph MegaBuffer, Hypercube MasterBuffer) pointed at. The highest-leverage work is therefore **not any single feature** but the foundation layer (normal G-buffer, ParityManager, shader variant strategy, ellipsoid-aware RTE, tile-level Hi-Z) followed by the GPU-resident tile stack (MegaBuffer + Resident Drawer + WGSL styling compiler). Everything else — the BRDFs, the post-effects, the clustered lighting, even TAA/CSM — rides better on that foundation than on today's architecture.

---

## 7. Cross-References

### Source investigations (Session 29, 2026-04-14)

Full per-project reports generated by three parallel agents; the critical signals were distilled into this doc.

### Related design docs

- [TAA_DESIGN.md](TAA_DESIGN.md) — dormant, rides on 8a foundation (normal G-buffer + ParityManager)
- [CSM_DESIGN.md](CSM_DESIGN.md) — dormant, rides on 8b sharedSourceBuffer
- [PHASE_5_MODERN_WEBGPU_DESIGN.md](PHASE_5_MODERN_WEBGPU_DESIGN.md) — already-landed modern WebGPU features (WGF-1/3/4)
- [WEBGPU_MIGRATION_BACKLOG.md](WEBGPU_MIGRATION_BACKLOG.md) § "Phase 7 — External Engine Feature Survey" — detailed per-item inventory referenced throughout this doc
- [WEBGPU_MIGRATION_STATUS.md](WEBGPU_MIGRATION_STATUS.md) — session-by-session history

### Key code surfaces to audit before executing Phase 8a

- [WebGPUModelPipelineCache.js](../packages/engine/Source/Renderer/WebGPU/WebGPUModelPipelineCache.js) — the 3-bit pipeline cache key (§2)
- [WebGPUModelRenderer.js](../packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.js) — draw command submission path; lazy resource allocation
- [Shaders/WebGPU/Model/ModelPBRComplete.wgsl](../packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.wgsl) — the monolithic shader
- [Scene/Model/MaterialPipelineStage.js](../packages/engine/Source/Scene/Model/MaterialPipelineStage.js) — where KHR extension flags are detected (upstream) but not propagated to WebGPU
- [Renderer/WebGPU/WebGPUHiZOcclusionDispatcher.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUHiZOcclusionDispatcher.ts) — exists; not wired to tile selection
- [Scene/Cesium3DTilesetBaseTraversal.js](../packages/engine/Source/Scene/Cesium3DTilesetBaseTraversal.js) — tile traversal; Hi-Z integration site
- [Scene/Cesium3DTileStyleEngine.js](../packages/engine/Source/Scene/Cesium3DTileStyleEngine.js) — CPU-side style expression evaluator; the target of the WGSL compiler (§4.C)
- [Core/Ellipsoid.js](../packages/engine/Source/Core/Ellipsoid.js) + RTE camera encoding — ellipsoid-aware RTE audit (§3 Foundation)

### Missing features not yet in backlog (Agent 1 findings)

Not in engine AND not in Phase 7; to be added to the backlog as FEAT-GAP-* items alongside this doc:

1. **Normal G-buffer + depth prepass** — foundational infra
2. **Motion blur (camera + per-object)** — rides on TAA motion vectors
3. **Planar reflections** — water/wet surfaces
4. **Refraction / caustics** — water + glass buildings
5. **Terrain contact shadows / screen-space contact shadows** — mid-day urban improvement
6. **Bent-normal ambient for terrain** — pre-baked or screen-space
7. **Impostors for far-LOD 3D Tiles and vegetation** — fights distant popping
8. **Decals (projected onto terrain + 3D Tiles)** — road markings, AOI overlays
9. **Aerial-perspective LUT consumer in all passes** — existing LUT, unused by most pipelines
10. **Oct-encoded normal G-buffer + depth-prepass normal reconstruction** — highest-leverage infra gap (same as #1, explicit about encoding)

### 3D Tiles 2.0 WebGPU-specific gaps (Agent 3 findings)

Upstream Cesium parses all 8 canonical 3D Tiles extensions. The WebGPU-specific rendering gaps to add to backlog as FEAT-3DT2-* items:

1. **Styling expression → WGSL compiler** — top lever (§4.C above)
2. **Property-texture sampling WGSL audit** — verify `EXT_structural_metadata` property textures are sampled in WGSL model shaders
3. **Ellipsoid-aware RTE** — correctness for non-WGS84 tilesets
4. **NGA_GPM point-cloud uncertainty visualization** — differentiating feature
5. **Draco / KTX2 / meshopt WebGPU end-to-end audit** — verify WASM decoders feed directly into `GPUBuffer`s without CPU round-trip

### Deprioritized / skip (Agent 3 findings)

Listed here so future sessions don't waste cycles re-investigating:

- `MAXAR_content_geojson` as a tile content type — proposal-stage, redundant with existing GeoJSON primitives
- `MAXAR_extents` — discovery/catalog metadata, zero rendering impact
- `3DTILES_bounding_volume_cylinder` — not in canonical extensions dir; OBB fallback acceptable

---

## 8. Quick Recipe — Starting Phase 8a

```text
1. Read this doc (PHASE_8_GPU_RESIDENT_TILES_DESIGN.md) — full picture.
2. Pick ONE foundation item from §3 "Foundation layer":
   - Shader variant strategy (highest unblock count, biggest design effort)
   - Normal G-buffer (highest unblock count for rendering features)
   - ParityManager (smallest, infra)
   - Ellipsoid-aware RTE audit (correctness, well-scoped)
   - Tile ↔ Hi-Z wiring (fastest perf win)
3. For whichever item: read the referenced code surfaces in §7, scan
   the relevant Phase 7 backlog entries for context, use TodoWrite to
   break the item into sub-steps.
4. After landing the foundation item, re-evaluate 8b item sizing — some
   may shrink (e.g., if shader variants land first, the BRDF items
   genuinely become the S effort Phase 7 claimed).
5. Update this doc's "Status" field and add a "Phase 8a landed" entry
   if a foundation item ships.
```

---

## 9. Tech Debt, Performance, and Architectural Improvements for 3D Tiles

Beyond the Phase 7 features and 3D Tiles 2.0 spec items, there's a layer of **improvements that don't show up in any external feature survey** but directly affect how well 3D Tiles runs. These are pain points surfaced by Agent 2's implementation audit plus architectural inference from reading the draw path.

Organized by category. Each item carries an effort estimate and a pointer to the underlying evidence.

### 9.A Tech debt on the 3D Tiles draw path

| Item | Evidence | Effort | Notes |
| --- | --- | --- | --- |
| **No buffer pool / recycler** | `WebGPUModelRenderer.js` lazy `ensure*Resources` allocates `WebGPUBuffer` per primitive on first-frame submit tick. No pool; no reuse across tile eviction. | M | Key by `(sizeClass, usageFlags)`; recycle on tile unload. Biggest single cause of first-frame stutter under fast camera motion. |
| **No cross-tile mesh dedup** | `GltfLoader.js` parses each tile's glTF independently. Identical glTF meshes (repeated building models in Google Photorealistic, street-furniture templates in B3DM) upload twice. | M-L | Content-addressable mesh cache keyed on glTF asset hash + accessor layout. Pairs with MegaBuffer (FEAT-SURVEY-20). |
| **Pipeline stages machinery runs per primitive per frame** | `packages/engine/Source/Scene/Model/*PipelineStage.js` (30+ stages). Many stages do per-frame work that is invariant across frames (material setup, attribute layout decisions, shader string assembly for the WebGL path). | L | Memoize stage outputs on the `renderResources` object; invalidate only on tile reload. Mirrors the "GPU-resident tile cache" insight on the CPU side. |
| **Always-5-textures binding** | `WebGPUModelPipelineCache.js:71-90` binds 5 default textures + samplers in bind group even when unused. | S-M | Partly absorbed by the shader variant strategy decision (§2) — coarse variants let each family bind only what it uses. |
| **`Array.prototype.sort` on command list per frame** | `CommandList.js` / `Scene.js` sort by eye distance per frame. With thousands of glTF primitives + indirect draws this is real CPU overhead. | M | Replace with GPU sort (FEAT-SURVEY-06 decoupled-lookback prefix-sum handles this) OR radix-sort via existing `WebGPUGPUSortKeysDispatcher` once it's consumer-integrated. |
| **Per-tile batch texture = RGBA8 round-trip** | `BatchTexturePipelineStage.js` allocates one RGBA8 texture per tile for feature-id→style mapping. Under heavy styling this is churn. | S | Pool + reuse; alternative: atlas into a shared large feature texture. |
| **Draw command object allocation every frame** | `DrawCommand` / `WebGPUDrawCommand` instances created per-primitive per-frame-resubmit. JS GC pressure at 1k-10k draws/frame. | S | Object pool keyed on `(pass, shaderProgram, vertexArray)` reset-and-reuse. Pairs with Resident Drawer (FEAT-SURVEY-24). |
| **Default texture atlas not deduplicated across contexts** | Each `WebGPUContext` builds its own `_defaultTexture`, `_defaultEmissiveTexture`, etc. on first use. Multi-context scenes (split-screen comparison page) pay cost twice. | S | Share defaults via a module-level lazy factory keyed on device. |
| **Uniform buffer ring allocator exists but not uniform-adopted** | `WebGPURingBufferAllocator.ts` exists. Grep shows partial adoption across renderers. | S-M | Audit per-dispatcher: every per-frame UBO write should go through ring, not standalone buffer per primitive. |
| **No WebGPU regression tests for implicit + multiple-contents** | Agent 3 flagged. Parse path is tested upstream; render path isn't. | M | Add `Specs/Scene/Cesium3DTilesetImplicit*WebGPUSpec.js` + `Multiple3DTileContentWebGPUSpec.js`. |

### 9.B Performance fixes that don't need new infrastructure

Low-effort wins. Each addresses a specific bottleneck without adding a subsystem.

| Item | Payoff | Effort |
| --- | --- | --- |
| **Batch SSE computation** — loop hoist `Cesium3DTile.getScreenSpaceError` per frame; compute bulk via typed-array of `(distance, geometricError)` pairs then apply division in one pass. | 5-15% tile-traversal CPU at >10k visible tiles | S |
| **Cached frustum plane-masks** — `CullingVolume.computeVisibilityWithPlaneMask` already reuses parent masks; verify cache hit rate and extend to horizon/fog planes. | 2-5% traversal | S |
| **Early-out on static camera** — if camera matrix + tileset transform unchanged, skip full traversal and reuse previous frame's visible set. | Massive idle-frame win; pairs with snapshot mode | S-M |
| **Batch bounding-sphere tests** — `BoundingSphere.intersectPlane` is scalar; a WASM SIMD bulk test on 4-wide lanes against all frustum planes is 3-4× faster. | 10-20% traversal in dense scenes | M (needs WASM module) |
| **Skip matrix recompute when tile stationary** — many `Cesium3DTile.computedTransform` updates cascade from root; gate on dirty flag. | 2-5% | S |
| **Tile priority heap instead of sort** — tile request queue is sorted each tick; a binary heap on priority score amortizes to O(log n) insertion. | 5-10% under tile-request storms | S |
| **Draco / meshopt decoder on worker** — confirm decoders run off-main-thread. Worker-offloaded decode is already standard for Draco; meshopt may still run on main. | Smoother stutter-free tile landing | S-M (audit) |
| **KTX2 transcoding to worker** — `WebGPUImageUpload.ts` audit: is basis-transcoding on main thread? If yes, move to worker. | Eliminates frame stalls on KTX2-heavy tilesets | M |
| **Skip occluded tile texture upload** — if a tile is allocated but Hi-Z occlusion says invisible, defer its texture upload until it becomes visible. | Bandwidth saving in urban occlusion-heavy scenes | M (depends on tile-Hi-Z wiring) |
| **Pipeline pre-warm on tileset load** — walk the tileset manifest, pre-compile pipelines for all material variants encountered, *before* the first tile streams in. | Eliminates pipeline-compile stutter | S (after shader variant strategy lands) |

### 9.C GPU compute opportunities

Expanding the "move work to GPU" theme. Each item moves per-frame CPU cost to amortized GPU cost, subject to the readback-avoidance constraint.

| Item | What moves to GPU | Effort | Dependency |
| --- | --- | --- | --- |
| **GPU-side SSE computation + LOD selection** | Per-tile depth + geometric error → LOD decision in a compute shader; feeds back into the CPU traversal only as "which tile IDs should be rendered this frame." | L | Tile Hi-Z wiring (Phase 8a) |
| **GPU-side bounding-volume hierarchy test** | Full traversal on GPU once the tile tree is mirrored as a GPU buffer. Essentially what Nanite does. | XL | Resident Drawer (Phase 8b) |
| **GPU-side feature picking** | Compute shader reads the pick framebuffer + batch table + feature ID map and writes the result to a small readback buffer — avoids stall by using `mapAsync` with one-frame latency. | M | — |
| **Compute skinning** | Currently mixed. Confirm `WebGPUModelRenderer` skinning path is GPU; if CPU-side, move to compute. | M | — |
| **Compute morph targets** | Morph target blending on GPU; currently evaluated per-frame CPU-side in `GltfLoader`. | M | — |
| **Per-tile impostor baking** | When a tile becomes "distant," dispatch a compute shader that renders the tile's primitives into a texture atlas + emits an oriented-quad draw command for subsequent frames. Replaces high-poly distant content with a single textured quad. | L | Resident Drawer + FEAT-SURVEY-20 MegaBuffer |
| **GPU-side batch table texture update** | When a style change happens, currently the CPU walks every feature. A compute shader evaluating the (compiled) WGSL expression against the feature-properties buffer writes directly to the batch texture. | L | WGSL styling compiler (§4.C) |
| **Compute-based instance selection** | For `EXT_mesh_gpu_instancing` content, currently the CPU filters instances per frame. A compute cull on the instance buffer + indirect draw replaces this. | M | — |
| **GPU-side tile LOD morph** | Screen-space-error morph between LOD levels on GPU per-vertex, smoothing the pop at LOD boundaries. | M | Normal G-buffer helpful |

### 9.D WASM opportunities

Shifting CPU work to WASM where SIMD + lower-allocation overhead helps. Every WASM bridge must have a JS fallback (CLAUDE.md rule).

| Item | WASM payoff | Effort | Notes |
| --- | --- | --- | --- |
| **Tile traversal bulk math** — `BoundingSphere.intersectFrustum` + `distanceSquaredTo` for thousands of tiles/frame. SIMD128 + typed-array packed layout. | 3-4× on dense scenes | M | Fits the existing `packages/engine/Source/ThirdParty/Workers/cesium_wasm` pattern. |
| **glTF accessor decoding** — quantization dequant, zigzag decode, varint parse. | 2-3× on quantized tilesets | M | Already partly via Draco/meshopt WASM; non-compressed quantized accessors may still be JS. |
| **Style expression evaluator (WASM)** — interim before full WGSL compilation. Compile expression to WASM bytecode; evaluate per-feature in hot loop. | 5-10× vs JS evaluator | M | Stepping stone to the WGSL compiler in §4.C. |
| **Feature BVH construction** — per-tile BVH for picking + ray queries. WASM-built, GPU-consumable. | Enables fast per-tile picking + physics | L | — |
| **Tile content dedup hashing** — compute fast hash (xxHash via WASM) over mesh content for cross-tile mesh dedup (§9.A item). | 10-20× vs JS hashing | S | — |
| **RTE encoding hot path** — `EncodedCartesian3.fromCartesian` is called in tight loops during primitive building. Pure math, SIMD-friendly. | 2-3× on RTE-heavy paths | S-M | Needs to stay bit-exact with the JS reference — test-first. |
| **Transform cascade** — `Cesium3DTile.computedTransform` cascades through tile tree each frame. Bulk WASM matrix-multiply pipeline. | 3-4× on deep trees | M | — |

### 9.E Memory and bandwidth improvements

3D Tiles at planetary scale is bandwidth-bound, then memory-bound. Anything that reduces bytes moved is a win.

| Item | Win | Effort |
| --- | --- | --- |
| **Texture compression audit** — ensure KTX2 + Basis / ASTC / BC7 transcoded to device-native format per backend. Today's WebGPU fork may round-trip through RGBA8 in places. | 4-8× texture memory | M |
| **Vertex buffer quantization** — use `KHR_mesh_quantization` (i8/i16 normalized attributes) where source content supports it. Verify WebGPU path preserves quantized attributes rather than CPU-dequantizing to f32 (Agent 2 flagged this as uncertain). | 2-4× vertex memory | M |
| **Texture deduplication across tiles** — content-addressable texture cache keyed on texture hash. Google Photorealistic has shared materials. | 10-30% memory on urban tilesets | M |
| **Selective LOD texture reduction** — distant tiles don't need full-resolution textures. Reduce mip level binding on distant LODs. | Bandwidth + VRAM | S-M |
| **Half-precision materials** — `rgba16float` storage for HDR content; `rgb9e5ufloat` for LDR albedo; reduces material texture bandwidth. | ~30% texture BW | M |
| **Shared sampler pool** — `WebGPUContext.getOrCreateSampler` exists; audit its hit rate. Samplers should be heavily deduplicated. | Minor | S |
| **Shared UBO for tile-invariant data** — per-frame camera + atmosphere + light data is shared across all tile draws. Today each primitive gets its own copy or ring slot. One shared UBO bound once per pass. | Reduces BW + GC | S-M |
| **Async tile eviction** — when evicting a tile, defer `GPUBuffer.destroy()` to an idle callback instead of blocking the frame. | Smoother eviction | S |
| **Tile streaming prioritization by frustum distance** — fetch near-to-camera tiles first; deprioritize off-screen preloads. Verify Cesium's existing priority heuristic does this. | Perceived load time | S (audit) |

### 9.F Threading and parallelism

Main-thread stalls are the user-visible enemy. 3D Tiles streaming is particularly prone to them.

| Item | Win | Effort |
| --- | --- | --- |
| **Tile decode on dedicated worker** — confirm glTF parse + Draco + meshopt + KTX2 transcoding all run off main thread. Gaps here produce stutter. | Stutter elimination | M (audit) |
| **Tile traversal on worker** — moves the CPU SSE + frustum loop off the main thread into a worker; main thread only consumes the `{tileIDs, drawOrder}` result. Massively reduces frame jank at the cost of one-frame latency. | 5-20ms main-thread savings on dense scenes | L |
| **Pipeline compile on worker** — WebGPU's `createRenderPipelineAsync` is already async but may still block on driver compilation in some implementations. Worker-offloaded async compile is safer. | No compile stutter | S (probably already) |
| **Parallel tile LOD evaluation for multi-viewpoint** — snapshot mode + split-screen + multiple cameras all re-walk the tree. A worker-based LOD selector shares traversal across views. | Multi-viewpoint speedup | M |
| **Main-thread budget instrumentation** — `PerformanceTracker.js` exists but may not be tagging specifically "time spent in 3D Tiles update." Explicit per-subsystem budget tagging → visible in `Scene.getDebugSnapshot()`. | Observability | S |
| **Cooperative tile loading** — respect the 16ms frame budget. If tile processing would overrun, defer the remainder to next frame. Cesium has a partial `tileCacheSize` budget but not a time budget. | Smoother streaming | M |

### 9.G Architectural improvements — structural changes

These are bigger re-shapes that would pay off structurally. Each deserves its own design doc if picked up.

| Item | Why | Effort |
| --- | --- | --- |
| **Tile-level render bundle cache** | Cache the encoded draw-command list per tile as a WebGPU render bundle. On subsequent frames, executeBundle replaces re-encoding. Natural fit for static tiles; tiles that change (style, animation) invalidate. Not yet applied to the 3D Tiles draw path. | L |
| **Tileset-level hierarchical GPU state** | The octree structure itself mirrored as a GPU buffer. Enables GPU-side traversal (§9.C). Prerequisite for full Nanite-style rendering. | XL |
| **Separate LOD-independent vs LOD-specific data** | Material defs + feature IDs are LOD-invariant; geometry is LOD-specific. Today both evict together. Keep material cache across LOD transitions. | M |
| **Per-tile frame budget with graceful degradation** | Don't just count tiles; count ms. If a tile would push the frame over budget, defer its submission. Today's system stops when frame time overruns but doesn't plan for it. | M |
| **Tileset "ready state" contract** | Today a tileset's initial load is best-effort; no formal "all initial LOD loaded" event. A proper readiness promise enables snapshot mode + CI visual diffs + deterministic tests. | M |
| **Materialized `3DTILES_metadata` schema in WGSL** | The metadata framework schema is known at tileset load. Generate WGSL types + bind group layouts matching the declared schema. Enables typed property-texture access in shaders. | L (pairs with Agent 3 item #2) |
| **Unified tile content lifecycle** | Today `b3dm`, `i3dm`, `pnts`, `cmpt`, `gltf` each have slightly different lifecycle paths. Unify under a single `TileContent` interface, remove legacy branching. | L (mostly refactor) |
| **Feature-level undo/invalidation** | Style changes today re-evaluate every feature. An invalidation log ("these feature IDs changed") would make incremental updates possible. | M |
| **GPU-driven command list generation** | The full path: GPU culling → GPU compaction → GPU indirect draw → GPU style eval. No CPU command list at all. Only per-frame CPU work is camera + tileset root selection. End state of Phase 8b. | XL (end state) |

### 9.H Prioritization across 9.A-G

If I had to pick the highest-impact items across all categories by payoff-per-effort for 3D Tiles specifically:

1. **Buffer pool / recycler** (9.A) — S-M effort, single biggest cause of first-frame stutter.
2. **Pipeline pre-warm on tileset load** (9.B) — S effort after shader variant strategy lands.
3. **Cross-tile mesh dedup** (9.A) — pairs naturally with MegaBuffer (FEAT-SURVEY-20); M effort.
4. **KTX2 transcode on worker** (9.B) — M effort, eliminates a class of frame stalls.
5. **WASM SIMD tile traversal** (9.D) — M effort, 3-4× traversal speedup on dense scenes.
6. **Tile-level render bundle cache** (9.G) — L effort, but enormous savings on static tile content which is 90%+ of a typical scene.
7. **Shared UBO for tile-invariant data** (9.E) — S-M effort, reduces BW + GC.
8. **Early-out on static camera** (9.B) — S-M effort, enormous idle-frame win.

These eight sit alongside the Phase 8a/b/c items above and should be scheduled into whichever phase they naturally pair with:

- Buffer pool + shared UBO + pipeline pre-warm → Phase 8a foundation
- Mesh dedup + WASM traversal + render bundle cache → Phase 8b GPU-resident stack
- KTX2 worker + static-camera early-out → opportunistic (unblocked today)

---

## 10. What This Doc Is NOT

- **Not a commitment** — sizing is rough; the architecture synthesis is the durable value.
- **Not a complete spec** — each Phase 8a/b/c item needs its own design doc or scoped RFC when picked up.
- **Not a replacement for Phase 7 backlog detail** — the per-item file-path references, RTE caveats, and S/M/L effort estimates live in `WEBGPU_MIGRATION_BACKLOG.md`.
- **Not a prescription for order** — if a customer-driven priority demands a Phase 8d item first (e.g., CSM for a specific deliverable), the dependency DAG in §3 tells you what foundation items must land alongside, but the sequencing is negotiable.
- **Not definitive on the shader variant strategy** — §2 argues for ~20 coarse material-family pipelines with pre-warmed compilation, but this deserves its own design doc + benchmark before committing. A 1-day spike on the three options (keep monolithic, fine-grained, coarse) would de-risk.
