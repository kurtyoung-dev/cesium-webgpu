# R-2a — GPU-Side Cross-Source Attribute Join — Scoping Audit (Plan State)

**Status:** OPEN → **audited (plan state)**. Doc-only scoping task (Queue Q27, tier R-2a). No runtime code.
**Date:** 2026-07-05. **Premise re-verified against HEAD** (not stale — no cross-source join exists in shader code today).
**Sources reconciled:** `FUTURE_RESEARCH_2026_05_01.md` §R-2, `RESEARCH_AND_PENDING_TOPICS.md` §R-2, `NEXT_QUEUE_2026-07-04.md` Q27/Q28.

---

## 1. The question

Can a single GPU shader pass read a **vector polygon's** attribute (e.g. `nationCode`) and an
**imagery layer's** per-pixel attribute (e.g. a landcover class ID) at the *same fragment* and
combine them (multiply / mask / recolor)? Today: **no.** This audit inventories why, catalogs the
existing per-source and unified attribute surfaces, and specifies the minimal path to enable the join.

## 2. Premise verification (live code at HEAD)

Grep for `landcover|nationCode|cross-source` across `packages/engine/Source` returns **only** per-model
glTF `featureIdTexture` sites (`Model/FeatureIdPipelineStage.js`, `MetadataWGSLPipelineStage.js`,
`WebGPUModelFeatureId.js`, `ModelPBRComplete.wgsl`). Those are **source-local** per-model feature IDs —
explicitly *not* a cross-source target (see `RESEARCH_AND_PENDING_TOPICS.md` §R-2b note). No shader
samples a vector attribute and an imagery attribute together. **Premise stands: OPEN.**

## 3. Attribute-surface inventory — unified vs per-source-only

| Source | Per-fragment attribute today | GPU-visible? | Namespace / key |
|---|---|---|---|
| **glTF model / 3D Tiles (Model)** | FEATURE_ID attr/texture → `EXT_structural_metadata` property tables | **Yes**, bound per-model (`MetadataWGSLPipelineStage`) | model-local feature ID |
| **Vector 3D Tiles / GeoJSON** | per-feature batch ID → batch texture (`Cesium3DTileBatchTable`) | **Yes**, bound per-content | content-local batch ID |
| **Imagery layer** | none exposed to shader as an *ID*; only the sampled RGBA **color** reaches `GlobeFS`/`GlobeTerrain.wgsl` | **No** (color only) | feature identity is CPU-only via `ImageryProvider.pickFeatures` (async, WMS GetFeatureInfo-style) |
| **Globe surface** | single `Globe._pickId` for the whole primitive (`Globe.js:1411`) | pick-pass only | one ID for the entire globe, not per-imagery-feature |
| **Voxels** | per-cell decode / traversal keyframe table | per-primitive | tile/cell index |

**The only source-agnostic per-fragment quantity that exists** is the **pick color** written by the
WebGPU pick pass (`WebGPUSceneRendererPickPass` → `WebGPUPickFramebuffer`, `rgba8unorm`, 24-bit ID via
`context.createPickId` / `getObjectByPickColor`). But it is (a) an **object-identity** ID, not an
attribute *value*; (b) **LDR rgba8** (~16.7M IDs, no room for multiple parallel channels); and (c)
**consumed on the CPU** (byte readback + registry lookup), never sampled inside a shader. It is therefore
*close in shape* to what a join needs, but not usable as-is.

**Conclusion:** there is **no shared GPU-visible attribute namespace across sources.** Each source binds
its own metadata/batch resources to its own pipeline; `Scene.frameState` unifies *scheduling* (passes,
culling, camera, pick registry) but carries **no cross-source attribute buffer**.

## 4. What a GPU join actually requires

A join `f(vectorAttr(frag), imageryAttr(frag))` needs both operands **resident as GPU-samplable
resources aligned to a common key** at the same fragment. Two gaps:

1. **Imagery has no integer ID channel.** Imagery reaches the globe FS as filtered RGBA color only.
   A landcover *class ID* would need an unfiltered (nearest) single-channel ID texture (`r8uint`/`r16uint`)
   bound alongside the color texture, sampled with `textureLoad` (no bilinear — IDs must not blend).
   This is a real imagery-provider surface gap, not just a shader gap.
2. **No common key space.** Vector `nationCode` lives on per-feature batch IDs (screen-rasterized or
   geo-keyed); imagery IDs live in tile-UV space. Aligning them requires either (a) a **screen-space
   G-buffer** where both sources write their ID at each covered fragment (this is exactly **R-2b**, the
   unified feature-ID texture), or (b) a **geo-cell key** (both sampled at the fragment's cartographic
   position) — simpler to reason about but needs both sources reprojected to a shared grid.

## 5. Dependency finding — **R-2a is gated on R-2b**

The clean enabling primitive is **R-2b (unified per-fragment feature-ID texture)**. Once a source-agnostic
ID G-buffer exists, the R-2a "join" collapses to: in a post-process pass, `textureLoad` the unified ID
G-buffer, use the source tag + ID to index a **per-source attribute LUT** (storage buffer keyed by feature
ID), and combine. Attempting R-2a *before* R-2b forces a bespoke two-texture bind with ad-hoc alignment
that R-2b would then obsolete. **Recommended sequencing: land R-2b first, then R-2a is ~S effort on top.**

## 6. Proposed design (post-R-2b), default-OFF per Fork Charter

- **Attribute LUT resource.** Per participating source, a storage buffer `array<u32>` (or `array<vec4<f32>>`)
  indexed by feature/batch ID → attribute value(s). Built CPU-side from the batch table / property table /
  an imagery-provided landcover legend. WebGL2 twin: a `R32UI`/`RGBA32F` data texture + `texelFetch`
  (no compute needed; portable).
- **Join pass.** A PP-stage WGSL shader that reads the R-2b unified ID G-buffer (source tag + ID), does two
  LUT lookups, and writes the combined result (recolor / mask / boolean overlay). Off by default; enabled
  only when an app opts into a named join descriptor — byte-identical scene when absent.
- **Imagery ID channel (prerequisite sub-task).** Extend `ImageryLayer` to optionally carry a nearest-sampled
  single-channel ID texture parallel to color, plumbed into `GlobeTerrain.wgsl` / `GlobeFS.glsl` as an
  additional bound texture. Gated behind an imagery-provider capability flag (most providers won't supply it).

## 7. Scoping estimate & risk

- **R-2b (prerequisite):** M, ~3 sessions (builds on Batch-133 pick-pass infra — the pick FBO already proves
  every source can write one ID target; R-2b promotes that from CPU-readback LDR to a shader-samplable
  G-buffer, and adds a source tag).
- **R-2a join primitive (this item, post-R-2b):** S, ~1–1.5 sessions for the LUT + PP join pass.
- **Imagery ID channel:** S–M, provider-dependent; only needed for the imagery half of the canonical
  `nationCode × landcover` example. Vector×vector and model×vector joins need no imagery change.
- **Risk:** low for the join pass itself (additive PP stage, default-off). The real cost centers are (a) the
  imagery ID-channel plumbing (touches the hot globe FS bind group — must stay byte-identical when unused)
  and (b) LUT lifetime/rebuild on batch-table edits. WebGL2 parity is fully achievable (data-texture LUT +
  `texelFetch`); no compute is required for the join.

## 8. Recommendation

Mark **R-2a = plan-complete, BLOCKED-on-R-2b** in the tracking docs. Do **not** implement R-2a standalone;
schedule R-2b (Q28) first, then R-2a lands as a thin PP stage + LUT on top. Imagery ID-channel plumbing is a
separately-schedulable sub-task needed only for imagery-source joins.

**Update (2026-07-05, C4-UNIFIED-FEATURE-ID-TEXTURE):** R-2b's **core primitive shipped** — the unified
per-fragment feature-ID G-buffer is now shader-samplable in a fullscreen PP pass
(`WebGPUPickFramebuffer.resolveFeatureIdRecolorAsync()` → `FeatureIdResolve.wgsl`), verified by
`probe-feature-id-texture.mjs` (billboard + point resolve to distinct in-shader IDs). The R-2a join still
awaits the R-2b **residual** (per-frame wiring of the ID G-buffer into the standing PP pipeline + a source-tag
channel + the imagery per-texel ID channel from §4.1/§6) before the two-LUT join pass from §6 can be built.

**Update (2026-07-05, R-2b residual a — standing-PP-wiring primitive):** the recolor pass can now be recorded
into a **caller-provided per-frame command encoder** (`WebGPUFeatureIdTexture.record()` →
`WebGPUPickFramebuffer.recordFeatureIdResolve()`), leaving the result in a persistent, re-sampled output
texture (`featureIdRecolorView` / `featureIdRecolorTexture`) — no separate submit, no CPU readback stall. This
is exactly the plumbing the §6 join PP stage consumes: it records inside the frame's own command stream and its
output view is immediately sample-able by a downstream same-frame stage. Verified standing==one-shot bit-for-bit
+ persistent-texture reuse + default-OFF (nothing constructed until an explicit call) by
`probe-feature-id-texture.mjs`. Remaining before the join: (a2) an actual per-frame **driver** that invokes the
record inside the standing PP pipeline (needs a per-frame pick render or a debug-overlay driver), (b) the
source-tag channel, and (c) the imagery per-texel ID channel.
