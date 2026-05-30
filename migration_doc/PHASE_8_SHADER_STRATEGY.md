# Phase 8 Shader Strategy — Coarse Variants + Pre-Warm

**Status:** Decided Batch 80 (2026-05-20) · Implementation diverged — shipped a basic/full split (Batch 174+), not the ~20-family table · Resolves `TILE-ARCH-SHADER-STRATEGY` (Tier 4 #13 in the parity audit)

---

## What actually shipped (reconciliation — read this first)

The decision below proposed a **~20-variant table keyed on `{material family} × alphaMode × doubleSided`** with per-family `ShaderDefine` bits and a tileset-manifest pre-warm. The implementation that landed (Batches 162/174+) **diverged from that table** in two ways:

1. **Binary basic/full split, not a per-family table.** Rather than one variant per BRDF model, the shipped split is a single `ShaderDefine` bit — `MODEL_HAS_KHR_TEXTURES (1<<9)` — selected per-primitive by `computeMaterialDefines()` in `WebGPUModelRenderer.js` (the `FLAG_HAS_KHR_MASK` OR at `WebGPUModelRenderer.js:178-212`):
   - **basic** (`materialDefines = 0`) — no KHR-extension textures; the WGSL strips bindings 12–25, dropping the sampled-texture count under the WebGPU spec floor (`maxSampledTexturesPerShaderStage = 16`) so models render on mobile/compatibility devices.
   - **full** (`MODEL_HAS_KHR_TEXTURES` set) — all 14 KHR texture/sampler slots declared; pairs with the full 37-binding `materialBGL`.
   The intra-family flags (`hasBaseColorTexture`, etc.) and the alphaMode/doubleSided axes stay runtime flags / GPU-state cache keys, as the decision anticipated — but the *family* axis collapsed to a single basic/full bit.
2. **The KHR BRDFs are no longer "silently dropped."** `ModelPBRComplete.wgsl` wires clearcoat, sheen, anisotropy, iridescence, transmission, volume, and KHR_materials_specular (search `FLAG_HAS_*` in that file; 14 sites). They are all gated inside the single `MODEL_HAS_KHR_TEXTURES` "full" variant rather than each getting its own family entry.

The per-family table + per-extension `ShaderDefine` bits remain a **documented future split** (`computeMaterialDefines` JSDoc at `WebGPUModelRenderer.js:187-212` explicitly notes the architecture supports a granular per-KHR-extension `materialDefines` without further refactoring). The pre-warm hook on `Cesium3DTileset._initialize` (below) is **not yet wired**.

The original decision narrative below is preserved as the rationale-of-record; treat the ~20-family table, the "3-bit/6-variant family key", and the "silently dropped KHR" framing as superseded by this section.

---

## The decision

For the WebGPU Model PBR shader (and any future fork-PBR variants that grow out of it — clearcoat, sheen, anisotropy, iridescence, transmission, volume), we will use **a coarse-grained pipeline-variant table (~20 variants) compiled lazily during tileset load and pre-warmed before first-tile arrival.**

This resolves the design question that has gated KHR BRDFs, Phase 7 quality items, and Phase 8a (G-buffer + Depth Prepass), and Phase 8b (TileStoreGPU) for the last ~3 months.

---

## What the alternatives looked like

| Strategy | Compile cost | Runtime cost | Extension support | Verdict |
|---|---|---|---|---|
| Monolithic (current) — one 3,102-line shader, all features as uniform flags | ~0 (compile once) | High — every fragment branches on material feature flags, branch divergence kills cache coherence across thousands of tiles, over-fetch from always-bound default textures | Each new KHR BRDF inflates the shader linearly. Design doc flags "wall at 4-5 BRDFs"; clearcoat + sheen + anisotropy + transmission = 4. Fifth (iridescence or volume) forces this decision anyway. | **Hits wall imminently.** Reject. |
| Fine-grained (WebGL-style) — every define-set produces a distinct compiled program (potentially thousands of variants) | High — every new material feature combination triggers a fresh compile on first hit, causing tile-stream stutter | Lowest possible | Free — each extension is its own permutation | **Bad for streaming.** Per-tile stutter is exactly what GPU-resident tiling is trying to eliminate. Reject. |
| **Coarse-grained — ~20 pipelines keyed on `{material family} × alphaMode × doubleSided`, pre-warmed during tileset load** | Low (~20 pipelines × 5-50ms = 250-1000 ms one-time at tileset load, amortized into the asynchronous manifest parse before first tile arrives) | Low — fewer runtime branches than monolithic; only intra-family flags branched | Adding a new KHR BRDF = one new material family + one new variant set, not a referendum on the whole shader | **Accept.** |

The deciding piece of evidence (as of Batch 80) was on KHR support: at the time of this decision, **clearcoat, sheen, anisotropy, iridescence, transmission, volume were all unimplemented on WebGPU.** That was a real bug, not a future enhancement. Monolithic was designed for one BRDF; adding 6 to it costs 6× the same internal-cost-doubling. Fine-grained adds them for free but pays per-tile stutter (which is the exact thing we're trying to eliminate). Coarse-grained pays a fixed up-front cost we can amortize.

> **Status update (Batch 174+):** the KHR BRDFs are no longer dropped. `ModelPBRComplete.wgsl` now wires `FLAG_HAS_CLEARCOAT / _SPECULAR_EXT / _ANISOTROPY / _IRIDESCENCE / _SHEEN / _TRANSMISSION` (KHR_texture_transform also landed; see `PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md` C-R4). The shipped variant strategy diverged from the ~20-family table described below — see "What actually shipped".

## Capacity check — does this fit the existing infrastructure?

- **Pipeline-key bits:** the WGSL preprocessor uses a Uint32 `ShaderDefine` bitmask (the cache key reserves 24 bits for active defines). **16 bits (0–15) are now allocated** — through `LOG_DEPTH (1<<15)` — leaving **8 bits remaining.** Coarse variants need ~3-4 bits for material family + ~1 bit for skinning/morph-targets + we already have alphaMode/doubleSided in the GPU-state cache key. **Fits without expanding to 64-bit.** (The shipped impl used a single `MODEL_HAS_KHR_TEXTURES (1<<9)` bit — a binary basic/full split — rather than per-family bits; see "What actually shipped".)
- **Compile latency:** 5-50 ms per variant per device. 20 variants × 50 ms = **1 s worst case stutter** if not pre-warmed. With pre-warm (walk the tileset manifest, kick off compiles before the first tile streams in), this lands BEFORE the first frame that needs the pipeline. Tileset manifest parse + IndexedDB cache lookup typically takes 200-500 ms, comfortably masking the compile cost.
- **Pipeline cache infrastructure:** `WebGPUShaderModuleCache` (per-device, keyed by `(sourceId & 0xff) | ((defines & 0xffffff) << 8)`) already exists and handles the dedupe. Adding coarse-variant keys is a one-line addition to `ShaderDefine`.

## Material families (the variant axis)

To bound the table at ~20, the variants are keyed on **material family** — one entry per BRDF model, NOT per per-texture-channel binary flag:

1. `METALLIC_ROUGHNESS` (the glTF 2.0 PBR baseline; default)
2. `SPECULAR_GLOSSINESS` (KHR_materials_pbrSpecularGlossiness — common in older content)
3. `UNLIT` (KHR_materials_unlit)
4. `CLEARCOAT` (KHR_materials_clearcoat)
5. `SHEEN` (KHR_materials_sheen)
6. `ANISOTROPY` (KHR_materials_anisotropy)
7. `IRIDESCENCE` (KHR_materials_iridescence)
8. `TRANSMISSION` (KHR_materials_transmission)
9. `VOLUME` (KHR_materials_volume — usually combined with TRANSMISSION)

That's 9 material families. Cross with alphaMode (OPAQUE/MASK/BLEND — 3) and doubleSided (yes/no — 2) gives **9 × 3 × 2 = 54 theoretical pipelines.** In practice typical scenes hit 2-6 of them. We pre-warm whichever families appear in the loaded tileset's material list.

Within each family, secondary features (hasBaseColorTexture, hasNormalTexture, hasOcclusion, etc.) stay as runtime flags inside the pipeline — they're cheap to branch on because they collapse to "sample identity default vs sample real texture", and the always-bound default textures keep the BGL stable.

This is the "coarse" in coarse-grained: the family is the variant key, not every binary capability.

## Pre-warm mechanism

When a 3D Tileset finishes parsing its manifest:

1. Walk the per-tile material reference list (it's an authored set, even if individual tiles stream in over time).
2. For each unique `{family, alphaMode, doubleSided}` triple seen, kick off `device.createRenderPipelineAsync()` via the existing `WebGPUPipelineCache`.
3. Await all in parallel (the async-pipeline API is genuinely concurrent on Dawn / wgpu).
4. By the time the first tile's mesh data arrives, the pipeline cache is hot.

Asynchronous pipeline compile is already supported by the bind-group / pipeline cache layer. The pre-warm hook plugs into `Cesium3DTileset._initialize` after the manifest fetch completes.

## What this enables

Decision unblocks:

- **Phase 7 KHR BRDFs** — clearcoat, sheen, anisotropy, iridescence, transmission, volume. Each lands as a new family entry + the BRDF math in a new WGSL helper file. No need to grow the monolithic shader.
- **Phase 8a — Normal G-buffer + Depth Prepass.** The depth-prepass needs to know which pipelines to bind; with coarse variants the depth-prepass is one pass per family (or one shared depth-only pipeline if we extract a depth-write-only stripped shader, a separate optimization).
- **Phase 8b — TileStoreGPU.** Resident Drawer batches by pipeline. With coarse variants the batch count is bounded at 20 instead of unbounded (monolithic) or thousands (fine-grained). The MegaBuffer dynamic-offset UBO addressing model fits coarse-variant pipelines naturally.
- **Clustered lighting (FEAT-SURVEY-40)** — clustered passes are written per material family. Coarse variants give a stable target.

## What this defers

- **Depth-write-only stripped pipelines.** A separate optimization (Phase 8a Slice 3?). For now the depth prepass uses the same pipeline as the color pass, with color writes disabled. Bandwidth savings are real but not blocking.
- **Per-skinning / per-morph-target variants.** Currently runtime-branched inside the shader; could be coarse-extracted later if profiling shows it's worth a separate pipeline.
- **Hash table for arbitrary fine-grained variants.** Reserved for "hot-spot tuning" — if a specific shape of material recurs at high frequency and benefits from a specialized pipeline, we can promote it without redesigning the whole strategy.

## Open questions (deferred to Phase 8 implementation)

- Exact bit layout for the new family bits in `ShaderDefine`. To be decided in Phase 8a Slice 2 when the depth-prepass pipeline cache key needs the family.
- Whether to extract the BRDF helpers into a `Source/Shaders/WebGPU/Model/BRDFs/` directory or keep them inline in `ModelPBRComplete.wgsl` and use `//>>ifdef` to gate. Probably extract — keeps individual BRDF readable.
- How to surface pipeline-pre-warm progress to the application (progress callback? new `tileset.pipelinesPrewarmed` event?). Minor API decision; defer.

## References

- `migration_doc/PHASE_8_GPU_RESIDENT_TILES_DESIGN.md` § 2 — the original recommendation that this doc formalizes
- `packages/engine/Source/Renderer/WebGPU/WebGPUShaderDefines.ts` — the bitmask registry
- `packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.wgsl` — the model PBR shader (3,102 lines; now split into basic/full variants via `MODEL_HAS_KHR_TEXTURES` — see "What actually shipped" below)
- `migration_doc/WEBGPU_DEBUGGING_LOG.md` Batch 80 — implementation kickoff
