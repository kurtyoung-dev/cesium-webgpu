# Research & Pending Topics — Forward Register

> **Canonical doc (consolidation first draft, 2026 consolidation).**
> Supersedes: `FUTURE_RESEARCH_2026_05_01.md`, `RESEARCH_TAKRAM_GEOSPATIAL_VISUALS.md`, `CLOUD_RENDERING_STRATEGY.md` (the completed cloud-rendering research portion), `OPTION_B_SCENE_IN_WORKER.md`, and the long-tail research recommendations in `audits/2026-04-30_ARCHITECTURE_PERFORMANCE.md`. Cloud *taxonomy* roadmap (`CLOUD_TAXONOMY_ROADMAP.md`) is cross-referenced, not fully folded.
> **Review-in-progress.** First draft for maintainer review rounds.

---

## Reader's preface — accuracy caveat

This register consolidates ~5 scattered research docs that were last refreshed between Batch 56 and Batch 185. **HEAD is ~Batch 455.** That is up to ~300 batches of drift, and a large fraction of what these source docs filed as "research / open / planned" has since **shipped** — most of the Takram celestial/atmosphere/cloud track landed via Campaign 3 v2 (V0–V16, git Batches 396–408) and the ATMOSPHERE_CLOUD_IMPROVEMENT_PLAN campaign (git Batches 427–452).

Every headline status below was **re-verified against the live code + git log at HEAD ~Batch 455** rather than lifted verbatim. Status tags used:

- **SHIPPED** — confirmed present and wired in code + git log.
- **OPEN** — confirmed *not* implemented (no file, no batch); the source doc's framing still stands.
- **SUPERSEDED** — overtaken by other work (often upstream) that changes the premise.
- **status: verify** — could not confirm with confidence in this pass; treat the claim as provisional and re-check before relying on it.

Where a source doc asserted a stale status, the correction is called out inline. Prefer dates/hashes/code over batch labels — batch numbering in this fork is **non-monotonic** (see `WEBGPU_MIGRATION_STATUS.md`), so a "future-looking" batch number is not proof of pending work.

> **Post-campaign addendum (2026-07-03, HEAD `62c5bab450` = Batch 506).** The 25-item WebGL→WebGPU parity campaign (Batches 482–506) and its full audit updated several entries below: the atmosphere-brightness/limb-ring gap is now **measured** (§3), voxel octree research is reframed around the shipped depth-1 traversal (§2 R-8), and the WGSL-preprocessor-v2 capacity premise is **overtaken** (§5 — 30 define bits live, `keySalt` already in production for bits ≥ 24). Entries carrying a "verified at HEAD ~Batch 506" note were re-checked against code in that pass; everything else still reflects the ~Batch 455 verification.

---

## 1. Triage Model (Watch / Prototype / Plan / Ship)

The register inherits the four-state triage model from `FUTURE_RESEARCH_2026_05_01.md`. These are **not commitments** — they are triaged starting points for when capacity opens.

| State | Meaning | Exit criterion |
| --- | --- | --- |
| **Watch** | Browser/SDK/standards-gated or demand-gated. Nothing to build yet; track the gate. | The gate clears (e.g. a WebGPU feature lands in Chrome stable) OR a real user workload appears. |
| **Prototype** | Buildable today on existing primitives; worth a contained spike to de-risk before committing. | A spike confirms (or kills) the integration shape + measures the win. |
| **Plan** | De-risked enough to schedule; needs a batch sequence + dependency ordering. | Promoted into a campaign queue (`QUEUE_*` / `CAMPAIGN_ROADMAP`). |
| **Ship** | Actively executing or fully landed. | Tracked as batches; moved to `FEATURE_INVENTORY.md` §B when complete. |

### Promotion path to D2 (the active roadmap)

Research entries are promoted **out of this register** and **into the roadmap** when they reach `Plan`:

1. Cross-reference `migration_doc/DEFERRED_WORK.md` and `migration_doc/FEATURE_INVENTORY.md` §C (WIP) / §D (FUTURE). If the item is already tracked there, link it rather than re-describing it.
2. When it earns a batch sequence, it lands in the active campaign queue (currently `CAMPAIGN_ROADMAP_2026-06.md` / the `QUEUE_*` family) and leaves this doc.
3. When it ships, move the inventory entry from §D→§C→§B per CLAUDE.md Principle 6, and mark it **SHIPPED** here with the git batch.

**This register is the pre-roadmap holding area.** Once an item is on the roadmap with batches, the roadmap is the source of truth and this doc keeps only a one-line "promoted → see X" pointer.

---

## 2. Rendering-Technique Research

### R-1 — NTC (Neural Texture Compression) for 3D Tiles glTF materials — **OPEN (Watch / workload-gated Prototype)**

*Verified: no `loadNTC.js`, no `EXT_texture_ntc` wiring, no NTC batch in git. Source-doc framing stands unchanged.*

NVIDIA RTX Neural Texture Compression replaces a *bundle* of correlated PBR textures (albedo + normal + MR + AO + emissive) with a small per-material latent feature grid + 3–4 layer MLP decoder. The win comes from inter-channel correlation, so the fit is **3D Tiles AEC/BIM + game-quality glTF materials (8–12 correlated channels)** — **NOT** imagery tiles (single sRGB layer) and **NOT** photogrammetry (albedo-only). `KHR_texture_basisu` is the architectural template for where it would plug in (`GltfLoaderUtil` → `GltfImageLoader` → `loadKTX2` → `Texture.create` → `WebGPUTexture` upload + `supportsBasis` capability flag).

Four inference modes, web-feasibility-ranked:

| Mode | Web status | Cost |
| --- | --- | --- |
| **Inference on Sample** (canonical ~5× VRAM win) | **Blocked** — needs WGSL `subgroup_matrix` (gpuweb#4195, "Needs Decision" mid-2026; Dawn proto only, not Chrome stable) **plus** a TAA-class temporal denoiser (NTC sample output is single-texel dithered noise). | ~10–15 sessions code + 5–8 for TAA; browser-gated 12–18 mo. |
| **Inference on Load** (bandwidth ~4–5× on disk) | **Achievable today** — plain WebGPU compute transcode `.ntc → BC7/BC5/BC4` at tile load. No VRAM win. | ~4 sessions. |
| **Latent-Resident Transcode Pool** (VRAM ~75% for AEC/BIM working sets) | **Achievable today** — web-specific software pattern (not NVIDIA-blessed); latents resident, fixed BC7 LRU working-set pool keyed on visibility, maps onto `TileReplacementQueue` / `Cesium3DTileset` cache. | ~6–8 sessions on top of Inference-on-Load. |
| **Inference on Feedback** | **Not viable** — DX12-only; WebGPU has no Sampler Feedback / sparse residency. | N/A |

**Triage:** Watch (Inference-on-Sample, browser-gated). Prototype candidates A (bandwidth) + B (VRAM), both **workload-gated**: they only justify themselves when a real AEC/BIM 3D-Tiles user with VRAM or bandwidth pressure shows up. The TAA dependency for Inference-on-Sample is now **partly retired** — TAA itself shipped (Batch 244), so the `previousViewProjection` plumbing + history exist; a denoiser tuned for NTC noise is the remaining gap. **Do not pursue** Inference-on-Feedback or pure-FMA Inference-on-Sample (10–50× too slow vs hardware BC7).

*Source: `FUTURE_RESEARCH_2026_05_01.md` §R-1.*

### R-2 — Multimodal data fusion (renderer/scene-layer) — **PARTIALLY OPEN (Plan)**

Fuse heterogeneous geospatial data (raster imagery, vector polygons, terrain, point clouds, glTF buildings, time-dynamic CZML, IoT feeds) into one scene with consistent lighting/shadow/picking/LOD. Cesium already does this at the data-source level (3D Tiles 1.1 heterogeneous tiles), scene-graph level (unified culling + depth-sort + `Picking.js`), and time level (CZML clock graphs). The **gaps** the source doc named remain real:

- **R-2a — GPU-side cross-source attribute joins** (no shader pass can multiply a vector polygon's `nationCode` against an imagery landcover ID). **OPEN.** Audit task, ~1 session.
- **R-2b — Unified feature-id texture** (source-agnostic per-fragment feature IDs for post-process). **OPEN** in the fork sense; depends on the Batch-133 pick-pass infra. ~3 sessions. *(Note: upstream has feature-ID-texture transform fixes, but that is per-model glTF feature IDs, not a unified cross-source target — different thing.)*
- **R-2c — GPU-driven cross-source LOD** (single compute shader picking LOD across visible tile trees jointly). **OPEN.** Research-grade, 5+ sessions, possibly thesis-shaped.
- **Cross-source shadow casting** (3D Tiles classification footprints into CSM) — tracked separately as a C-R item / ADR in `DEFERRED_WORK.md`; **status: verify** against current CSM state.

**Triage:** Plan (R-2a/R-2b actionable; R-2c research-grade). *Source: `FUTURE_RESEARCH_2026_05_01.md` §R-2.*

### R-3 — WebNN browser-side ML inference (imagery super-resolution) — **OPEN (Watch / Prototype)**

*Verified: no `WebGPUImagerySuperResRenderer`, no WebNN wiring in git.*

W3C WebNN reached Candidate Recommendation Jan 2026; Chrome/Edge experimental behind flags (GPU/NPU preview), Safari/Firefox not implemented (~2027 est.). Three use cases for a globe engine, ranked:

1. **Imagery tile super-resolution** — upscale a 256² tile to 512² on-device when the user zooms past native LOD (avoids fetching the next zoom level). Pre-trained ESPCN (~100 KB ONNX) / satlas-super-resolution. New feature renderer intercepts tile upload → WebNN → cache. ~3 sessions for a Chrome-flagged prototype. **The recommended R-3 spike.**
2. **On-device imagery segmentation** (landcover / cloud / road masks → material layer). ~5 sessions. Defer until cross-browser.
3. **AI-driven LOD selection** — needs training, no ready model. Skip.

**Triage:** Watch (general), Prototype (use case 1, Chrome-only). *Source: `FUTURE_RESEARCH_2026_05_01.md` §R-3.*

### R-5 — Single-buffer GPU picking (MapGPU-style) — **OPEN, recommended DO-NOT-PURSUE (Watch)**

*Verified: no single-buffer pick batch in git; the dedicated pick pass (`WebGPUSceneRendererPickPass.ts`, Batch 133) is still the architecture.*

Write pick IDs as a 2nd color attachment in the same render pass as color, eliminating the dedicated pick re-walk. Technically possible (WebGPU supports 8 color attachments) but a **major architectural commitment**: every pipeline descriptor needs a 2nd fragment output, every WGSL FS needs a `@location(1)` pick output, every render pass must attach pick views, pick FBO must be allocated at full scene-FBO size (memory up), and every pixel pays a guaranteed 2nd write. **ROI is negative for Cesium's workload** — pick is on-demand (hover/click), so paying 100% color-pass cost to save a per-pick re-walk is a bad trade. **Recommendation: don't pursue.** Revisit only if a profile shows pick passes >5% frame time. *Source: `FUTURE_RESEARCH_2026_05_01.md` §R-5.*

### R-8 — Voxel deep-octree traversal + megatexture streaming/eviction — **PARTIALLY SHIPPED (depth-1) / remainder OPEN (Plan)**

*Verified at HEAD ~Batch 506 (`62c5bab450`) by direct source read of `WebGPUVoxelRenderer.ts`.*

**What shipped:** Batch 501 (`82584c0780`, PARITY-VOXEL-OCTREE-LOD) landed **depth-1 octree LOD traversal** — root + 8 level-1 children resolved per-fragment in the WGSL color march (`u.atlasInfo.y >= 1.0` gate → child-octant select → `tileUv = shapeUv * 2 - childCoord` rescale, `WebGPUVoxelRenderer.ts:416-433`), with a 9-slot atlas and packed-leaf-from-parent fallback when a child tile is not uploaded. `probe-voxel-octree` passes 8/8 child discriminators. Batch 503 (`dbee6fa817`) added native-WGSL user customShaders in the same ray-march. That closes the "does octree LOD work at all on WebGPU" question — **the remaining work is research-shaped, not a wiring gap**:

1. **Arbitrary-depth traversal.** The shipped scheme is a fixed root+L1 slot layout (`childSlots0`/`childSlots1` uniforms). Level 2+ needs a real octree walk in WGSL — either Cesium's `Octree.glsl`-style traversal over a GPU octree texture/buffer or an iterative descend with per-level slot indirection. Design question: keep the flat-slot model per level vs. port the upstream megatexture node-index model wholesale.
2. **Streaming + megatexture eviction.** Depth-1 uploads all 9 tiles up front. Deeper trees need demand-driven tile upload keyed to camera refinement plus an eviction policy for the voxel megatexture/atlas (LRU over tile slots, mirroring upstream `VoxelTraversal`'s megatexture add/remove). Couples to the shipped pipeline-cache LRU patterns (§5) but is its own resource-lifetime design.
3. **OPEN composition gaps (audit 2026-07-03, confirmed by source read — record honestly, do not paper over):**
   - **Per-cell pick does not compose with octree LOD** — `fragmentPickVoxelMain` (`WebGPUVoxelRenderer.ts:664-716`) never performs the L1 child-octant traversal the color march does: it normalizes z into slot 0 (the ROOT slab, lines 690-694) and hardcodes `megatextureId = packVoxelIntToVec2(0.0)` (line 708). Whenever the frame refines to level 1, pick returns a root-cell index for a leaf the user sees. Acknowledged in-code (lines 686-689) as a follow-up; **this is the next immediate voxel work item**, and any deeper-traversal design must make the pick march share the traversal with the color march rather than re-diverging.
   - **Per-cell pick does not compose with user customShaders** — pick selects the winning sample via the default-shader gate `s.a > densityThreshold` (line 697), while the VOXEL_USER_CUSTOM_SHADER color march accumulates `voxelMaterial.alpha` ungated (lines 473-478). A user shader that remaps opacity makes the WebGPU pick disagree with both the displayed surface and WebGL. Natural fix rides with the octree-pick work (pick march needs a VOXEL_USER_CUSTOM_SHADER branch).

**Triage:** Plan — the pick/octree composition fix is immediate follow-up work (tracked in `DEFERRED_WORK.md`); the arbitrary-depth + streaming/eviction design is the research spike behind it. *Source: Batch 501/503 commit ledger + campaign audit 2026-07-03.*

---

## 3. Atmosphere / Cloud / Celestial Visual-Fidelity Research — **LARGELY SHIPPED**

This is the **Takram `three-geospatial`** research track (`RESEARCH_TAKRAM_GEOSPATIAL_VISUALS.md`, filed 2026-06-14). It studied Shota Matsuda's Cesium+Three.js renders and proposed a 10-item "Celestial & Atmosphere Visual Fidelity" roadmap. **Most of it has since landed** across two campaigns — the source doc's "NOT yet scheduled" header is stale.

License note (still load-bearing): the repo is **MIT**, the atmosphere model is **Bruneton's Precomputed Atmospheric Scattering** (BSD reference). We implement the *technique*, not GPL code. **Attribute Bruneton + Takram in ported shader headers.**

### Takram roadmap items — verified status at HEAD ~455

| # | Takram item | Status | Evidence (git) |
| --- | --- | --- | --- |
| 1 | NEW-ATMO-BRUNETON-FULL-LUTS (multiple-scattering + irradiance, 4-LUT set) | **SHIPPED** | Batch 306 (`65aeec2c73`) Track V-A1 |
| 2 | NEW-ATMO-AERIAL-PERSPECTIVE-POSTPROCESS (unified depth-based transmittance×color + inscatter over all geometry) | **SHIPPED** | Batch 311 (`cc55f69608`) Track V-A2; LUT also wired to Voxel/Splat/PointCloud (Batches 100–102) |
| 3 | NEW-ATMO-DERIVED-LIGHTING + MIXED-MASK (SunDirectionalLight + sky-irradiance SH + terrain-Lambertian/model-PBR mask) | **SHIPPED** | Batch 312 (`805436397c`) Track V-A3 |
| 4 | NEW-VOLUMETRIC-CLOUD-LAYERS (Perlin-Worley + weather map + Beer-powder + dual-lobe HG + multi-scatter) | **SHIPPED** | Campaign 3 v2 V0–V8 (Batches 396–408) + improvement-plan Phase 3/4; **precomputed 3D-noise core is the keystone** (see §4) |
| 5 | NEW-CLOUD-BSM-TEMPORAL (Beer Shadow Map + temporal filter) | **SHIPPED (opt-in)** | Batch 437 (`f517becc44`) improvement-plan 4.1 CLOUD-SHADOWS (BSM → terrain + aerial + fog) |
| 6 | NEW-CLOUD-TAAU (half-res + temporal upscale) | **SHIPPED (opt-in) — coarser variant confirmed** | Batch 432 (`8e4bd340c8`) CLOUD-HALFRES half-res + bilateral upsample; Batch 433 (`5f2459a82c`) CLOUD-TEMPORAL reprojection + accumulation (`CloudTemporalResolve.wgsl`). **Verified:** what shipped is half-res + bilateral + temporal, **NOT** the full 1/16-over-16 blue-noise Schneider variant — the `Schneider` strings in `ProceduralClouds.wgsl` are technique-attribution comments (Horizon/Nubis cone-light, FBM octaves), not the interleaved-reconstruction path. The simpler variant is the chosen path (ships as V10–V16 tiers); the full Schneider TAAU is deferred/speculative, not a TODO in the code. |
| 7 | NEW-STARS-BRIGHT-CATALOG (Yale Bright Star Catalog point starfield) | **SHIPPED (both backends)** | Batch 313 (`9b562e8ed2`) WebGPU; Batch 324 (`bb58a62571`) WebGL fallback for parity; Batch 352 tune. Skybox star-map mirroring fixed Batch 504 (`af006e9634`, cube-map flipY parity — patternCorr aligned 1.000 vs mirrored 0.122). Residual: HDR-SkyBox faint-star parity tracked deferred (`NEW-WEBGPU-SKYBOX-HDR-FAINT-STAR-PARITY`). |
| 8 | NEW-SUN-MOON-FIDELITY (physical sun disc/limb + atmosphere glow + lens glare; moon phase PBR + earthshine) | **PARTIALLY SHIPPED — headline gap closed, lens-glare OPEN** | Batch 378 (`9880fb7b32`) "sun/moon fidelity — verify-first, claimed gap STALE" (physical sun disc + limb darkening + atmosphere glow) + Batch 438 (`0d8e5d2489`) SKY-MOON + Batch 442 (`7e132e0d06`) COLD-OPTICS-HQ halos/light-pillars. **Verified:** the headline "faint sun/moon" gap is genuinely closed (Batch 378) — that portion is **SHIPPED**. Sun/moon are rendered by `WebGPUEnvironmentRenderer.js` (there is **no** `WebGPUSunRenderer.ts` / `WebGPUMoonRenderer.ts`). **OPEN:** geometry lens-glare (caustic/refraction glow around the disc) — no lens-glare code is present in `WebGPUEnvironmentRenderer.js`; treat as an open backlog item. Moon off-screen-sliver regression fixed Batch 505 (`b26301efee`, model-space RTE — litRatio 1.000, centerDist 0.0px). |
| 9 | NEW-EFFECTS-LIGHTSHAFTS-LENSGLARE (crepuscular rays / god-rays / lens glare) | **PARTIALLY SHIPPED — cloud-aware extension OPEN** | `WebGPUGodRayEffect.ts` exists and is wired (A.11 GodRay, Batch 133 follow-up audit); Batch 442 (`7e132e0d06`) added LIGHT PILLARS (COLD-OPTICS-HQ, a cloud-coupled optical effect). **Verified:** base god-rays + light pillars work. **OPEN:** the cloud-aware god-ray extension (sampling cloud *transmittance*, not just depth) is not present — `WebGPUGodRayEffect.ts` carries no cloud reference; geometry lens-glare is likewise unshipped. These are the open fill-ins. |
| 10 | NEW-MULTIBODY-ATMOSPHERE (parameterize LUT pipeline for Mars / airless bodies) | **OPEN** | No fork batch parameterizing the atmosphere LUT for Mars. (The Mars hits in git are upstream Sandcastle demos, not a multi-body atmosphere config.) Remaining greenfield item from this track. |

### What's left from the Takram track

- **Item 10 (multi-body atmosphere)** is the main un-started item — a `CelestialBodyAtmosphere` parameter set (Mars: thin CO₂/dust Rayleigh/Mie/ozone + ground albedo; airless: skip-atmosphere) on the already-parameterized LUT pipeline. **Triage: Plan.**
- **Items 6, 8, 9** had **status: verify** sub-pieces that are now **resolved** (see the table above): item 6 shipped the *coarser* half-res+temporal variant (not full Schneider 1/16); item 8's headline sun/moon gap is closed but **geometry lens-glare is OPEN**; item 9 ships base god-rays + light pillars but the **cloud-aware god-ray extension is OPEN**.
- The two atmosphere campaigns that absorbed this track are tracked in `ATMOSPHERE_CLOUD_IMPROVEMENT_PLAN.md` (Phases 1–4, Batches 427–452, including A-LUT-REPARAM sun-relative sky-view LUT keystone, SKY-MS/ENV-AERIAL-MS multi-scatter, SKY-OZONE, MIE-PHASE, env-map/IBL reflection capture C2-25 epic) and `CAMPAIGN3_PROGRESS.md` / `QUEUE_2026-06-25_CAMPAIGN3v2_TIERED_CLOUDS.md`. **Those are the live trackers; this section is the research-origin record.**

*Source: `RESEARCH_TAKRAM_GEOSPATIAL_VISUALS.md`. Bruneton 4-LUT, aerial-perspective post, Bright Star Catalog, physical sun/moon, and the Takram "three inputs" (atmosphere LUT lighting / mixed mask / volumetric clouds) are all addressed above.*

### Atmosphere-brightness / limb-ring parity gap (WebGPU vs WebGL) — **below-surface + limb-width RESOLVED; far-zoom limb ring = surviving residual (→ Q23)**

> **⚠️ RECONCILE (2026-07-04): the two "darkening" halves below are STALE — RESOLVED within days of the audit.** **Below-surface / translucency darkening = ✅ RESOLVED (Batches 510/512/513):** the "uniformly darker" framing was partly a sign misread (probes report GL−GPU); B510 decomposition exonerated the named shading terms, B512 fixed the real bug (water masks never uploaded → `computeEnhancedOcean` ocean-shaded whole land tiles), B513 verified BOTH probes PASS under the **un-loosened** limits (underground 1.43/4.28% vs 8; translucency 4.00/0.54% vs 11.9); the Q7 determinism kit (Batch 538) further stabilized them (see ISSUES §3.3 CAMPAIGN-AUDIT-2). **Limb width = ✅ RESOLVED (Batch 513, `NEW-GROUND-ATMOSPHERE-DRAPE-LIMB-WIDTH`):** through-planet march + −150 km sample-height floor, `probe-limb-halo-width` PASS. **SURVIVING residual = the thin far-zoom limb ring** (~+10 GPU-brighter, 7.5% of far-view residual / 0.169% of crop) — routed to `NEXT_QUEUE_2026-07-04.md` **Q23 (FARZOOM-INTERIOR-BLOBS)**; re-measure at clean HEAD with the determinism kit before scheduling. The measured-decomposition text below is retained for lineage only.

*Status updated 2026-07-03 from the Batch 482–506 campaign audit (probe re-runs at clean HEAD `62c5bab450`). This was previously the vague "residual atmosphere/sky brightness parity" note; it now has numbers, which are the **entry criteria** for the investigation.*

**Measured decomposition (B506):**

- **Limb ring:** WebGPU renders the atmosphere limb **+10 GPU-brighter** at far zoom. In the B506 decomposition of the default far-view crop, the ring accounts for **7.5% of the residual mismatch** while covering only **0.169% of the crop** — a thin, bright, localized band, not a diffuse tint.
- **Below-surface / translucency darkening clusters with it:** WebGPU is uniformly *darker* in underground and translucent-terrain views — signed dRGB **−6..−8** (underground-default 22.85% mismatch, dRGB −7.4/−7.5/−8.0; underground-red 12.28%; translucent-terrain 25.49%, dRGB −5.9/−5.8/−6.7). B488 (GLOBE-TRANSLUCENCY-ALPHA) itself landed at 22.9%, so this is **largely a standing pre-existing gap**, possibly nudged ~+2.6pp by B506's `GlobeFS`/`GlobeTerrain.wgsl` shading changes.
- **Why it surfaced now:** the underground/translucency probes use dynamic limits keyed to the standing default-view residual (`max(8, base+2)` / `max(10, base+8)`). The campaign's default-view polish (B502/504/505/506) dropped that shared baseline **~15% → 2.5–2.6%**, tightening the limits onto the standing residual. **Do NOT loosen the probe limits** — they are now correctly exposing the gap; `probe-globe-underground` and `probe-globe-translucency` fail at HEAD and must stay failing until the gap closes.

**Investigation entry criteria / next steps:** (1) reproduce the numbers above via `probe-globe-underground` + `probe-globe-translucency` at clean HEAD; (2) verify B506's seam/glint shading deltas apply symmetrically on the underground/translucency shading paths; (3) target = limb ring gone at far zoom AND below-surface signed dRGB centered near 0, with the default-view residual held at ≤2.6%. Recorded as an **OPEN** audit finding (high) — this is the atmosphere-parity follow-up, not a fresh catastrophic regression.

**Triage:** Plan (measured, probe-gated, ready to schedule).

### Celestial / atmosphere design-doc deferrals (`CELESTIAL_ATMOSPHERE_DESIGN.md`)

Open follow-ups carried forward from the celestial/atmosphere design that are *not* part of the Takram 10-item roadmap above:

- **Higher-resolution moon texture — OPEN (deferred, NEW-6).** Current `moonSmall.jpg` is adequate from Earth-distance views but blurry at close range (lunar-orbit camera). Fix: source a high-resolution lunar-surface texture + alpha-blend between resolutions per altitude. ~0.5–1 session; deferred from Phase 2 (Sun/Moon sync). Tracked as **NEW-6** in `SESSION_2026-04-08_RESEARCH_REPORT.md` §10 and `CELESTIAL_ATMOSPHERE_DESIGN.md` §4.2. **Triage: Watch (low).**
- **Temporal reprojection polish for volumetric fog — Phase 5f (optional, per B11).** Phase 5a–5d deliver the froxel grid *without* temporal-history reprojection; low-resolution grids shimmer during camera motion (density-sampling aliasing). Phase 5b's mitigation is temporal **blue-noise jitter** on density sampling; full **TAA-style history-buffer reprojection (Phase 5f, ~0.5 session)** is a future polish step **only if jitter alone proves insufficient**. The **B11 locked decision** defers it. See `CELESTIAL_ATMOSPHERE_DESIGN.md` §4.8 / §6 Phase 5f. **Triage: Prototype (gated on observing shimmer post-5d).**
- **Per-pixel varying-atmosphere-density fallback — RESEARCH TOPIC (intentionally not implemented, per B21).** Per the **B21 locked decision**, when `enableVolumetricFog = false`, `enableVaryingAtmosphereDensity = true` is a **silent no-op** — the froxel grid is the only supported density-modulation path. The design *explicitly* states the per-pixel sky-atmosphere ray-march fallback (sampling 3D noise at each Nishita ray step) is **NOT implemented**. Open research question if demand warrants it: medium shader complexity. **Document the limitation; do not silently route around it.** See `CELESTIAL_ATMOSPHERE_DESIGN.md` §4.9. **Triage: Watch (demand-gated).**

---

## 4. Cloud-Rendering Architecture Research — **COMPLETED → SHIPPED**

`CLOUD_RENDERING_STRATEGY.md` (research in flight as of 2026-06-25, 3 background agents) owned the cloud-*rendering-technique* axis: quality tiers, noise representation, and the "match-WebGL-by-default, opt-in-better" model. **The research is complete and its headline recommendation has shipped.** This section records the validated conclusions; the live tracker is `QUEUE_2026-06-25_CAMPAIGN3v2_TIERED_CLOUDS.md` + `CAMPAIGN3_PROGRESS.md`.

### Architectural principle (user directive, 2026-06-25)

> Default = match WebGL (cheap baseline). Provide better options that can be enabled. If a better-looking AND better-performing option exists, research and implement it.

Applied: WebGL has only billboard/2D clouds (`CloudCollection`); the WebGPU volumetric raymarcher is **opt-in / default-off** (`globe.showProceduralClouds` / `atmosphericConditions.clouds.enableVolumetric`), so the default already matches WebGL. The research scoped a clean **quality-tier model** for the opt-in path.

### Validated research conclusions (3 agents, convergent — all confirmed in code)

1. **No architectural pivot.** Raymarch-with-3D-textures on a spherical shell is the correct core (2024–2026). Gaussian-splat / NeRF / neural are **not** viable for animated, dynamically-lit participating media (no multiple-scatter model). **Confirmed** — the fork did not pivot.
2. **The one change that wins BOTH perf and quality: precomputed 3D noise textures.** Bake a low-freq **128³ RGBA8** Perlin-Worley + high-freq **32³ RGBA8** Worley once at init (WGSL compute → `texture_storage_3d`), replacing ~30 live FBM+Worley evals/sample with one trilinear fetch + curl offset (~8 MB). **SHIPPED** — `CloudNoise.wgsl` + `WebGPUCloudNoiseResources.ts` exist; Batch 398 (`2ac70f0ffd`) baked the textures inert, Batch 399 (`4e53a7575d`, the **KEYSTONE V3**) flipped the density core to the baked textures.
3. **Lighting wins (per cost):** energy-conserving analytic in-scatter integration; **multiple-scattering octaves** (N≈3, geometric decay); sun-side powder + isotropic floor + ambient sky term. **SHIPPED** — Batch 401 (V5) Frostbite multi-scatter octaves; improvement-plan Phase 3 (Batches 428–436) energy-conserving + cone-light march.
4. **Perf/reconstruction (per cost):** half-res + depth-aware joint-bilateral upscale; animated IGN ray-start jitter; temporal reprojection with motion vectors + wind + neighborhood-clip. Skip froxels; defer 2D impostors to Ultra. **SHIPPED (opt-in)** — Batch 432 CLOUD-HALFRES (half-res march + bilateral upsample), Batch 433 CLOUD-TEMPORAL (`CloudTemporalResolve.wgsl`, reprojection + accumulation). **Verified:** the shipped path is the **coarser half-res + bilateral + temporal** model, **not** the full Schneider 1/16-over-16 blue-noise interleaved-reconstruction variant (deferred/speculative). The `Schneider`/`Nubis` strings in the cloud shaders are technique-attribution comments, not the interleaved path.
5. **Tier model = the directive.** One `quality` enum → preset struct; **Tier 0 = cheap WebGL-parity default**, Tiers 1–3 opt-in volumetric. **SHIPPED** — Batch 397 (V1) `qualityFlags@74` tier-preset scaffold (inert spine), mapped onto `globe.cloudVolumetricQuality`.

### The W5 cautionary lesson (preserved — still load-bearing)

W5's adaptive coarse→fine empty-space skip (Batch 395) achieved 0.00% image mismatch ×1.39 faster — but **only after two rejected attempts**: a full-density skip oracle truncated clouds on erosion pockets (3× density loss, *slower*); an eager snap-back stalled the march (93% empty output). The fix was a **conservative** low-detail skip oracle (`base ≥ full`) + monotonic `tProcessed` back-up. This drove a **review must-fix carried into V3**: the baked erosion must use **literal subtraction, NOT a remap** (a remap raises mid-densities and breaks W5's `base ≥ full` invariant). Recorded here because the lesson generalizes: *incremental patches on a live-noise raymarcher are fragile; the representation itself was the bigger lever.*

### Cloud taxonomy (companion — partly shipped, long tail open)

The 11 WMO genera are **SHIPPED**: `Scene/CloudType.js` + `Scene/CloudTypeProfile.js` (Batch 385), with per-genus vertical density profiles wired (Batch 408 V11) and per-genus optical density / `profileExtinction` activated (Batch 452). The full WMO taxonomy is ~100+ named forms (species/varieties/supplementary-features); the baked-density-field architecture can express most as density-shaping. **Iconic exotic forms (mammatus, lenticular, Kelvin-Helmholtz, asperitas, virga, noctilucent, contrails) are OPEN** — proposed Tiers E1–E3 in `CLOUD_TAXONOMY_ROADMAP.md`, **not yet scheduled**. Mammatus is explicitly feasible (Tier E2: downward density modulation on the cloud underside). *Source: `CLOUD_TAXONOMY_ROADMAP.md` (cross-referenced).*

---

## 5. Compute / WASM / Performance Research

### R-4 — Off-thread Rust/WASM MVT vector-tile path — **SUPERSEDED (upstream landed MVT)**

*Verified: `MVTDataProvider.js`, `decodeMVT.js`, `buildVectorGltfFromMVT.js` are live in `packages/engine/Source/Scene/`; merged from upstream `CesiumGS/cesium` PRs (`DanielZhong/MVT_loader`, `DanielZhong/feat/MVT_load_properties`).*

The source doc (`FUTURE_RESEARCH_2026_05_01.md` §R-4) proposed a fork-built `MapboxVectorTileImageryProvider.ts` + Rust/WASM `mvt-reader` worker + `WebGPUVectorTileRenderer` to close Cesium's "no opinionated vector basemap" gap. **Upstream has since shipped an MVT loader** that decodes MVT/PBF and generates one glTF node per MVT layer (rendered through the existing Model/3D-Tiles path, not a bespoke vector renderer). The fork inherited it via merge.

**Re-triage:** the *raster-basemap-gap* premise is **partially closed** by the upstream MVT loader. What remains genuinely open and fork-relevant:

- **WebGPU render parity of MVT-derived glTF nodes — RESOLVED (2026-07-05, C4-MVT-WEBGPU-PARITY-PROBE).** The MVT loader (`MVTDataProvider.js` → `decodeMVT.js` → `buildVectorGltfFromMVT.js` → `VectorGltf3DTileContent`, which renders through the `BufferPolygon`/`BufferPolyline`/`BufferPoint` collections) emits backend-agnostic geometry with no MVT-specific WebGPU bug filed. Confirmed by `Tools/visual-regression/probe-mvt-datasource-parity.mjs`: it synthesizes a single MVT tile (one large polygon) via the spec's varint encoders, serves it through Playwright request routing to `MVTDataProvider.fromUrl`, and renders it against black (globe/sky off) on both backends. Result: both select 1 feature with identical `geometryByteLength=108`, 0 device/console errors, and a **cropped (UI-free) WebGL↔WebGPU pixel diff of 0.00%**. The premise ("SHOULD route at parity") held — no code change needed.
- **Off-thread decode — UNCONFIRMED, and current evidence says decode is SYNCHRONOUS, not off-thread.** Verified: `MVTDataProvider.js` calls `decodeMVT(arrayBuffer)` **synchronously** in the content-fetch path, and `decodeMVT.js` carries no `Worker` / `TaskProcessor` / `postMessage`. So the original R-4 Rust/WASM off-thread *parse+tessellate* motivation is **not** already satisfied by the upstream loader — it remains an open optimization angle (PBF decode + tessellation on the main thread). Revisit only if a profile shows decode cost on the main thread is material; the upstream loader is otherwise functionally complete.
- A Mapbox-GL-Style paint-property subset (the styling half) is still not first-class.

**Action:** demote R-4 from "Plan (build it)" to "verify upstream MVT covers the use case; only build the fork-specific styling/perf delta if a gap remains."

### R-7 — GPURenderBundles — expansion beyond current sites — **OPEN (Plan, profile-gated); profiler SHIPPED**

`GPURenderBundle` pre-records a draw sequence once and replays via `executeBundles`, saving CPU recording overhead (50–80% measured on static-geometry passes).

**Current wiring (verified by Grep on `Source/Renderer/WebGPU/`):** `WebGPURenderBundleManager.ts` (manager) + `WebGPUContext.renderBundleManager` getter + three functional sites:

1. **Environment** sun/moon/stars (`WebGPUEnvironmentRenderer.js`) — recorded once, replayed every frame.
2. **Volumetric fog** (`WebGPUVolumetricFogRenderer.ts`) — `asFreezable()` pattern.
3. **Globe** path (`WebGPUSceneRendererGlobePass.ts`) — **ARCHITECTURE CHANGED (resolved):** the source doc lists globe opaque terrain as a bundled site, but **Batch 292 (`2ba80374e9`) dropped the inline globe render bundle** in favor of a group-0 dynamic-offset UBO (`NEW-GLOBE-DYNAMIC-OFFSET-UBO` / `NEW-GLOBE-RENDERBUNDLE-CACHE`; the commit rewrites `WebGPUSceneRendererGlobePass.ts`, −89 net lines around the bundle path). The `WebGPURenderBundleManager` hook is still *referenced*, but globe **no longer uses a bundle** — per-tile uniform updates now ride a dynamic-offset UBO, which is cheaper than re-recording a bundle on every camera/animation change (the ROI inverts on a high-churn list). **Update to the source doc's performance assumption:** globe is no longer a bundled site; treat the substitution as the chosen path, not pending work. No functional change implied.

**Untapped expansion candidates** (source-doc ROI order, all still OPEN): R-7a 3D-Tiles opaque models (low risk, likely highest ROI), R-7b translucent/OIT collect (low risk, bundle-friendly today), R-7e Vector 3D Tiles, R-7f buffer primitives. **Don't bundle** R-7c pick (on-demand, not per-frame) or R-7d shadow cast (amortizes only on a still camera) without a profile.

**Profiling infrastructure: SHIPPED.** `WebGPUCpuPassProfiler.ts` (CPU JS-side recording cost, rolling 60-frame window, zero-overhead when disabled) is live alongside `WebGPUTimestampProfiler.ts` (GPU execution time). Console: `CesiumDebug.cpuPassCost(true)` → navigate → `CesiumDebug.cpuPassCost()` → `(false)`. **Bundling decisions are profile-gated:** <1 ms avg → skip; 3–5 ms → worth bundling (50–80% reduction on stable lists); >5 ms → strong candidate (globe terrain hit this pre-bundling). **The data-collection pass the source doc requested has not been recorded into the doc** — the profiler exists but the measured per-pass numbers are not yet captured. **Next concrete step:** run the profiler on the suggested scenes (Viewer default / Viewer+CWT+OSM Buildings / Google Photorealistic / OIT translucent / hover-active) and replace the source doc's placeholder table with measured numbers + a 1–2 site shortlist. *Source: `FUTURE_RESEARCH_2026_05_01.md` §R-7.*

### Subgroups / f16 / long-tail (architecture-audit research) — **OPEN, low-priority**

From `audits/2026-04-30_ARCHITECTURE_PERFORMANCE.md`, the long-tail research / structural items that are research-shaped rather than mechanical:

- **WGSL preprocessor v2 with boolean operators** (`(A && B) || (!A && C)`) — **UNSTARTED, low priority (bit count resolved).** The current `//>>ifdef` is flag-only (verified: `WebGPUShaderPreprocessor.preprocess` accepts a single flag name per directive, no `&&`/`||`/`!`); once many define bits are in play (driven by Model KHR-extension + metadata shaders) the inability to express boolean combinations forces enumerating permutations as separate source IDs or pre-OR'd bits. **Verified bit count (re-verified at HEAD ~Batch 506): 30 define bits are now in use** (`ShaderDefine` bits `0…29`, contiguous, add-only preserved). **The earlier "~92% of a 24-bit cache-key field / migrate the scheme when we approach 24" premise is OVERTAKEN**: six bits ≥ 24 (`MODEL_HAS_WGSL_CUSTOM_VERTEX` 24, `VOXEL_CUSTOM_SHADER_COLOR` 25, `MODEL_SPLIT_ENABLED` 26, `MODEL_HAS_COLOR` 27, `MODEL_SILHOUETTE` 28, `VOXEL_USER_CUSTOM_SHADER` 29) already live **outside** the 24-bit numeric cache-key window and are disambiguated in production via the per-source `keySalt` escape hatch (`WebGPUShaderModuleCache.getOrCreate` builds `` `${numericKey}#${keySalt}` `` when `keySalt !== 0`; consumers XOR-fold their high bits into `keySalt` — `WebGPUModelPipelineCache.js`, `WebGPUVoxelRenderer.ts`). So bit-count capacity is **no longer a v2 trigger** — `keySalt` scales the key space without a scheme migration. **Recommendation: defer the v2 design spike** until the one remaining trigger fires: a single complex boolean condition becomes unmaintainable in a source shader. Cheap to build when triggered since the preprocessor is a pure function. No action needed today.
- **Render pipeline cache eviction (LRU at ~1024 entries)** — **CONFIRMED SHIPPED (Batch 293, `3986f7a89b`, `NEW-BINDGROUPCACHE-EVICTION`).** Both `WebGPUBindGroupCache.ts` (bounded `maxEntries`, default 1024, LRU + optional age eviction, `evictions` stat) and `WebGPURenderPipelineCache.ts` (`evictIfNeeded()` LRU cap, `evicted` stat, configurable `maxSize`) now bound their growth and evict the least-recently-used entry on insertion. This resolves the "unbounded growth in long 3D-Tiles sessions" concern. No further action.
- **Subgroups / cooperative-matrix (`subgroup_matrix`)** — the same browser gate as R-1 Inference-on-Sample. Watch gpuweb#4195. Independently useful for any compute-heavy long-tail (reductions, prefix sums).
- **f16 storage/compute** — narrower-precision compute paths (cloud noise, LUT bake, reductions) where a half-precision variant would halve bandwidth. Workload-gated; **Watch**.

These are deliberately *not* greenfield features — they are performance-research items surfaced by the architecture audit. Most are de-risked enough to schedule when the relevant pressure (Model KHR variant explosion, 24h-session VRAM growth) materializes.

---

## 6. Symbology Research

### R-6 — MIL-STD-2525D/E military symbology — **OPEN (Watch, demand-gated)**

*Verified: no `MilStd2525Collection`, no `milsymbol` dep, no 2525 batch in git (the `2525` git hits are unrelated commit-hash prefixes).*

Render NATO/DoD military symbology glyphs (unit markers, equipment icons, control measures) as billboards. `milsymbol.js` (mature, MIT) generates SVG glyphs from 2525-coded strings; our `BillboardCollection` already handles rasterized icons + GPU-batched draws on both backends. Integration is mostly glue: optional `milsymbol` dep + a thin `Source/Scene/MilStd2525Collection.js` wrapper decoding symbology strings into billboard configs + docs + Sandcastle. **~2–3 sessions.**

**Triage:** Watch — **only ship if a defense/SAR user actually asks.** The implementation is low-risk; the question is demand. *Source: `FUTURE_RESEARCH_2026_05_01.md` §R-6.*

---

## 7. Water-Rendering Research (`WATER_RENDERING_DESIGN.md`)

The water design is a phased plan: **v1 = Phases 1–7** (terrain water mesh + Gerstner waves + screen-space refraction + sky-cubemap reflection + river classification via OSM/HydroRIVERS WASM rasterization + underwater + spatial regions). Everything below is **explicitly-deferred Phase 8+ future work** carried out of that design's phase inventory — none is on the active roadmap yet. All gate on the v1 water foundation (Phases 1–3) landing and being validated first.

### Phase 1 validation gate (the decision driver) — **OPEN (high priority once v1 ships)**

After Phases 1–3 ship, run **Option A water classification on representative datasets** (OSM-sourced rivers, terrain tiles carrying a water mask) and **profile**: (1) CPU cost of WASM rasterization per tile, (2) GPU cost of the water pass vs baseline, (3) visual correctness on rivers (width inference, flow direction). If profiling shows **>10% frame regression** or accuracy issues, revisit the WASM-vs-JS fallback trade-off. **This smoke-test + profiling pass is the prerequisite gate** for every scaling decision below — Option A is deliberately a "try before Option B" phase, and the format-version-bump decision (below) explicitly requires **6–12 months of real-world Option A usage** before it can be made. See `WATER_RENDERING_DESIGN.md` §9.1.

### Phase 8+ — visual-fidelity upgrades (all future, deferred pending Phase 1–3 validation)

- **FFT ocean upgrade (~2–3 sessions).** Replace the Gerstner sum-of-waves model with **Tessendorf FFT-based** ocean-surface generation for higher fidelity at distance. Depends on the Phase 1–3 water foundation. See `WATER_RENDERING_DESIGN.md` §6 Phase 8+ + Tessendorf, *"Simulating Ocean Water."*
- **Wave particles for boat wakes (~2–3 sessions).** Localized wave-disturbance propagation (Frostbite/Sea-of-Thieves-style **Wave Particles**, Jeschke) layered on the base Gerstner field, so boats displace the surface realistically. Needs the base wave field (Phase 2) first; disturbance injection + composite. See the design doc's §2 Prior Art + the Phase 8+ inventory.
- **Planar reflection probes (~1–2 sessions).** Replace the sky-cubemap reflection *approximation* with dynamic **planar reflections** of nearby geometry (buildings, terrain). Risk: the extra render pass may not pay off on mobile. The design doc's §4.6 explicitly defers this to Phase 8, noting screen-space refraction is already available as a cheap approximation.
- **ML-segmented water from imagery (research-grade).** Use satellite-imagery segmentation (Sentinel-2 Water Index / **NDWI**) to detect water pixels offline and bake them into a 3D-Tiles overlay tileset — improves classification accuracy for small water bodies. Deferred pending Option A (OSM-based) validation. See the design doc's §4.1.1.
- **Seasonal / ephemeral water (JRC GSW).** Integrate the **JRC Global Surface Water** dataset to capture seasonal/ephemeral rivers and floods absent from OSM vector data — improves coverage for monsoon regions + inundation modeling. Complements the Option A pipeline; deferred pending Phase 1 validation. See the design doc's §4.1.1.

### Phase 9+ — quantized-mesh format version bump (Option B, long-term direction) — **deferred (ecosystem-coordination-gated)**

Once there's **~6–12 months of real-world Option A usage**, the long-term direction is to promote the water-classification fields from the optional additive extension (**extension ID 0x05**, `waterType` / `flowVector` as optional buffers) to **first-class quantized-mesh format fields** via a coordinated **format version bump**. This is the cleaner wire format (fixed offsets, constant-time parse, room for higher-precision flow magnitudes + multi-band depth/turbidity + per-texel wave amplitude) but requires coordinating with **cesium-native, Cesium for Unreal, and third-party tilers** (Mapbox, Felt, MapTiler, …). **Decision: ship Option A now** (additive, backward-compatible, zero break) and **defer Option B to Phase 9+** pending usage validation. Migration sequence: survey real-world usage → refine the field set → propose the version bump → 18–24-month deprecation window for Option A → ship Option B as canonical with dual-parser support. See `WATER_RENDERING_DESIGN.md` §9.2.

**Triage:** the Phase 1 validation gate is **Plan (high)** once v1 lands; every Phase 8+/9+ item is **Watch/deferred** behind it. *Source: `WATER_RENDERING_DESIGN.md`.*

---

## 8. Vegetation-System Research (`VEGETATION_SYSTEM_DESIGN.md`)

The vegetation design proposes a tiered scatter/LOD system (V1–V5 core: instanced scatter + impostors + HLOD clumps + cheap backface-dot SSS + slope/landcover-driven density). The items below are **explicitly-deferred open questions / risks** from that design's §7–§9 — not part of the V1–V5 core. Do **not** gate the core on any of them.

- **Full subsurface scattering for vegetation — OPEN (deferred from v1, medium).** Current state: a `FLAG_HAS_VOLUME` **Beer–Lambert approximation** (WGSL) + a **backface-dot glow fallback** (WebGL2). Physically-correct SSS needs multi-bounce simulation or a specialized thin-membrane BRDF plus a **post-process MRT scene-color capture** for true KHR_materials_transmission — and that **refraction MRT infrastructure is not yet built** (`ModelPBRComplete.wgsl:356` placeholder). Ship the cheap backface-dot SSS for V4; **defer full SSS to a post-v1 phase** after the core lands. Cost: ~3–4 sessions (BRDF + MRT capture). Tracked as `BACKLOG-§9` in `FEATURE_INVENTORY.md`. See `VEGETATION_SYSTEM_DESIGN.md` §9 item 2. **Triage: Plan (post-v1).**
- **GPU-sort consumer integration — OPEN (profiling-gated, medium).** `WebGPUGPUSortKeysDispatcher` (compute shader) exists but has **no shader consumer anywhere** — the JS comparator is faster below ~50K elements. Wiring a consumer would batch vegetation by material/LOD to minimize pipeline-state changes. **Do not gate V1–V5 on this**; it's opportunistic **V6** work, taken only if a profile shows >50K per-frame vegetation sorts. Cost: ~1–2 sessions once instancing is live. See §7 item ("GPU sort … consumer wiring still pending — opportunistic") + the §8/gap-analysis table (consumer integration pending fork-wide) + §9 item 6. **Triage: Watch (profile-driven).**
- **Hydrological routing for density-map provenance — FUTURE RESEARCH (low).** The design derives density maps from OSM forest polygons + imagery landcover + a simple slope-rejection mask (§9 item 7, *"Density/biome map provenance"* — flagged as a pending **data-pipeline** gap). A richer, real-world-accurate approach would integrate **hydrological routing** to predict vegetation distribution from water availability: (1) build a flow-accumulation grid from terrain, (2) couple vegetation density to flow accumulation + lithology/watershed affinity. This is **beyond v1 scope** (a data-science gap, not engine work) but is a genuine need for forest modeling. Cost: research-grade, ~3–5 sessions for the hydro compute + density-field coupling. See `VEGETATION_SYSTEM_DESIGN.md` §9 item 7. **Triage: Watch (research).**

*Source: `VEGETATION_SYSTEM_DESIGN.md` §7–§9.*

---

## 9. Scene-in-Worker Research (Option B)

`OPTION_B_SCENE_IN_WORKER.md` answers "what would it take to run a full Cesium `Scene` inside a Web Worker?" **Status: design / blocker inventory; implementation deferred to a focused multi-week effort. Still OPEN as a full migration** — but the spike's scaffolding landed and the original hard blocker shifted.

### What landed (the 2026-04-11 spike, verified present)

- Live FPS histogram (`PerformanceTracker.js`, 60s rolling + 1% lows/highs) + Canvas2D HUD (`FpsOverlay.js`).
- Worker host + worker scaffold with 3-tier crash recovery + shadow-state replay (`WorkerSceneHost.js`, `RendererWorker.js`, `WorkerSceneProtocol.js`).
- Multi-pane test page (`Apps/WebGPUTest/worker-renderers.html`, auto-grids 1–16 panes).
- Cross-browser RAF fallback (`setTimeout(tick, 16.6)` on Firefox/Safari workers — rAF is Chrome-only in workers).
- `Scene` constructor + `CreditDisplay` DOM access **fixed** (both detect `typeof document === "undefined"` and skip DOM construction) — §1.1/§1.2 of the source doc, fixed 2026-04-11.

### The blocker shifted (re-verified 2026-05-30, HEAD `88b111e49c` at the time)

The source doc's biggest correction: `RendererWorker.handleInit` **no longer fails fast** at a `typeof document` sentinel throw. It now **attempts real headless `Scene` construction** (`_createWebGLScene` / `_createWebGPUScene` against the OffscreenCanvas), and any missed DOM dependency surfaces as an exception caught by the `try/catch` and posted as `MSG_ERROR` with `phase: "init"` + real stack.

**Open hard blocker:** `ScreenSpaceEventHandler` is DOM-bound (§1.3) — instantiated by the `Scene` constructor, calls `addEventListener` on the canvas; `OffscreenCanvas` has no mouse/keyboard `EventTarget`. Needs a `WorkerScreenSpaceEventHandler` that receives synthetic events via `MSG_INPUT_EVENT`. This is the **most likely actual first failure** post-early-throw-removal, **but the source doc explicitly flags it as not re-confirmed by running the worker** since the throw was removed. **status: verify — do not assert a specific first-failure line without re-running worker init and reading the captured `MSG_ERROR` stack.**

### The structural blockers that keep this OPEN

| Blocker | Difficulty | Why it's hard |
| --- | --- | --- |
| Entity descriptors must be structured-cloneable | **High (~2–3 wk for entity/primitive surface alone)** | Every Entity/Property/Material/visualizer needs a serializer pair across `postMessage`. `CallbackProperty` (a function) → host-side ticker posting result samples. **The biggest implementation cost.** |
| `ScreenSpaceEventHandler` DOM binding | Medium | Mechanical message routing + modifier/double-click logic moves into the host forwarder. |
| Async-vs-sync public API (§3.1) | High (API decision) | Recommendation: hybrid — sync fire-and-forget writes into shadow state + `pickAsync`/`getDebugSnapshotAsync` reads; legacy sync `pick()` returns last-frame-stale value. **Commits to a public API change** past Phase 2. |
| GPU resource ownership across boundary | Hard (no clean mitigation) | A worker `GPUTexture` can't be used main-thread; `captureToCanvas` must post raw RGBA bytes. |
| `SharedArrayBuffer` for high-freq updates | Off the table (general case) | Requires COOP/COEP cross-origin isolation, which breaks third-party-embedded Cesium apps. Fall back to plain `postMessage`. |
| `loadImage`/`Resource` `HTMLImageElement`, video textures, some XHR auth paths | Medium / N-A | ImageBitmap path is worker-safe; `HTMLVideoElement` is not (defer video billboards indefinitely). |

### Effort + recommendation

Full migration estimate: **9–13 weeks** for one full-time engineer (Phase 1 unblock → Phase 2 static scene → Phases 3–7 entity serialization / picking / properties / datasources / polish). **The high-value milestone is Phase 2** (static terrain+imagery in two worker panes with FPS comparison) — that delivers the multi-renderer scaling measurement that motivated the spike. **Decision gate: after Phase 2, measure the scaling win before committing to the §3.1 public-API change.** If worker isolation gives 2× on multi-renderer scenes it's worth it; if 5%, reconsider. The FPS counter + scaffolding are independently valuable regardless.

**Related signal:** Batch 305 (`6d9e62c7a0`) ran a "Phase 13 ECS-worker gating spike" and returned **NO-GO** (closed `NEW-ECS-*`). That is a *different* worker question (ECS in a worker, not Scene-in-worker) but is a data point that worker-offload spikes in this fork have so far not cleared their ROI bar. **Triage: Watch / deferred** — kept design-complete, unblocked only on a focused multi-week branch with a clear scaling motivation.

*Source: `OPTION_B_SCENE_IN_WORKER.md`.*

---

## 10. Research-to-Roadmap Crosswalk

Snapshot of every register entry vs. its live status and where the active tracking lives. **Re-verified against code + git log at HEAD ~Batch 455.**

| ID | Topic | Triage | Status @ ~455 | Active tracker / evidence |
| --- | --- | --- | --- | --- |
| R-1 | NTC Inference-on-Sample (VRAM) | Watch | **OPEN** (browser-gated) | gpuweb#4195; TAA dep now shipped |
| R-1a | NTC Inference-on-Load (bandwidth) | Prototype | **OPEN** (workload-gated) | no `loadNTC.js` |
| R-1b | NTC Latent-Resident Pool (VRAM) | Prototype | **OPEN** (workload-gated) | maps onto `TileReplacementQueue` |
| R-2a | Cross-source attribute-unification audit | Plan | **OPEN** | ~1 session |
| R-2b | Unified feature-id texture | Plan | **OPEN** | depends on Batch-133 pick pass |
| R-2c | GPU-driven cross-source LOD | Plan (research) | **OPEN** | 5+ sessions, thesis-shaped |
| R-3 | WebNN imagery super-resolution | Prototype | **OPEN** (Chrome-only) | no super-res renderer |
| R-4 | Rust/WASM MVT vector basemap | Plan | **SUPERSEDED** (loader); WebGPU parity **CONFIRMED** (probe, 0.00% diff, 2026-07-05); decode is SYNC | upstream `MVTDataProvider.js` merged; parity closed via `probe-mvt-datasource-parity.mjs`; `decodeMVT` synchronous (off-thread decode + Mapbox-GL-Style paint-property delta remain the only open angles) |
| R-5 | Single-buffer GPU picking | Watch | **OPEN (do-not-pursue)** | negative ROI; pick pass stays |
| R-6 | MIL-STD-2525 symbology | Watch | **OPEN** (demand-gated) | no `milsymbol` dep |
| R-8 | Voxel deep-octree traversal + megatexture streaming/eviction | Plan | **PARTIAL** — depth-1 SHIPPED (B501); L2+ traversal + eviction OPEN | `WebGPUVoxelRenderer.ts:416-433`; `probe-voxel-octree` 8/8 |
| R-8a | Voxel pick vs octree-LOD / customShader composition | Plan (immediate) | **OPEN** — pick samples ROOT slab, megatextureId hardcoded 0; ignores user-shader alpha | audit 2026-07-03; `WebGPUVoxelRenderer.ts:664-716` vs `:416-433`, `:697` vs `:473-478` |
| Atmo-parity | Limb-ring / below-surface brightness gap | Q23 | below-surface + limb-width ✅ RESOLVED (B510/512/513; probes now PASS un-loosened); **surviving residual = far-zoom limb ring** (~+10 GPU-brighter, 7.5% of far-view residual) → Q23 FARZOOM-INTERIOR-BLOBS, re-measure w/ determinism kit | §3 entry; ISSUES §3.3 CAMPAIGN-AUDIT-2 |
| R-7 | Expand GPURenderBundle coverage | Plan (profile-gated) | **OPEN**; profiler **SHIPPED** | `WebGPUCpuPassProfiler.ts`; 3 sites (globe site nuance: Batch 292) |
| Takram 1 | Bruneton 4-LUT | Ship | **SHIPPED** | Batch 306 |
| Takram 2 | Aerial-perspective post-process | Ship | **SHIPPED** | Batch 311 |
| Takram 3 | Atmosphere-derived lighting + mask | Ship | **SHIPPED** | Batch 312 |
| Takram 4 | Volumetric cloud layers | Ship | **SHIPPED** | C3v2 V0–V8; improvement-plan Ph3/4 |
| Takram 5 | Cloud BSM + temporal | Ship | **SHIPPED (opt-in)** | Batch 437 |
| Takram 6 | Cloud TAAU / half-res | Ship | **SHIPPED (opt-in)** — coarser variant (NOT full Schneider 1/16) | Batch 432/433; `CloudTemporalResolve.wgsl` |
| Takram 7 | Bright Star Catalog starfield | Ship | **SHIPPED (both backends)** | Batch 313/324; star-map mirroring fixed B504; HDR faint-star parity deferred |
| Takram 8 | Physical sun/moon fidelity | Ship | **SHIPPED** (disc/limb/glow); lens-glare **OPEN** | Batch 378 (gap was stale) + 438/442 + B505 moon full-disc RTE fix; rendered in `WebGPUEnvironmentRenderer.js` |
| Takram 9 | Light shafts / lens glare | Ship | **PARTIAL**; cloud-aware god-ray + lens-glare **OPEN** | `WebGPUGodRayEffect.ts` + Batch 442 pillars; no cloud-transmittance coupling |
| Takram 10 | Multi-body atmosphere (Mars) | Plan | **OPEN** | main un-started Takram item |
| Cloud-arch | Precomputed 3D Perlin-Worley core | Ship | **SHIPPED (KEYSTONE)** | Batch 398/399; `CloudNoise.wgsl` + `WebGPUCloudNoiseResources.ts` |
| Cloud-arch | 4-tier quality preset model | Ship | **SHIPPED** | Batch 397 `qualityFlags@74` |
| Cloud-tax | 11 WMO genera + per-genus profiles | Ship | **SHIPPED** | Batch 385/408/452 |
| Cloud-tax | Exotic forms (mammatus / lenticular / NLC…) | Plan | **OPEN** | `CLOUD_TAXONOMY_ROADMAP.md` Tiers E1–E3 |
| Long-tail | WGSL preprocessor v2 (boolean ops) | Plan | **OPEN / low-pri** — capacity premise overtaken @506: 30 bits live, bits ≥24 via `keySalt` | architecture audit §2d; flag-only preprocessor confirmed; `WebGPUShaderModuleCache.getOrCreate` keySalt |
| Long-tail | Pipeline-cache LRU eviction | — | **SHIPPED** (Batch 293) | `WebGPUBindGroupCache.ts` + `WebGPURenderPipelineCache.ts` LRU |
| Long-tail | subgroups / f16 | Watch | **OPEN** | shares R-1 browser gate |
| Option B | Full Scene-in-Worker | Watch/deferred | **OPEN** (spike landed, blockers remain) | `OPTION_B_SCENE_IN_WORKER.md`; ECS-worker spike was NO-GO (Batch 305) |
| Water | Phase 1 validation smoke-test + profiling | Plan (post-v1) | **OPEN** (gates all scaling decisions) | `WATER_RENDERING_DESIGN.md` §9.1 |
| Water | FFT ocean (Tessendorf) | Watch | **OPEN** (Phase 8+) | §6 Phase 8+ |
| Water | Wave particles (boat wakes) | Watch | **OPEN** (Phase 8+) | §2 Prior Art |
| Water | Planar reflection probes | Watch | **OPEN** (Phase 8+) | §4.6 |
| Water | ML-segmented water (NDWI) | Watch | **OPEN** (Phase 8+) | §4.1.1 |
| Water | Seasonal water (JRC GSW) | Watch | **OPEN** (Phase 8+) | §4.1.1 |
| Water | Quantized-mesh Option B version bump | Watch/deferred | **OPEN** (Phase 9+, ecosystem-gated) | §9.2 |
| Vegetation | Full SSS (refraction MRT) | Plan (post-v1) | **OPEN** | `VEGETATION_SYSTEM_DESIGN.md` §9.2; `ModelPBRComplete.wgsl:356` |
| Vegetation | GPU-sort consumer integration | Watch (profile) | **OPEN** (V6 opportunistic) | §9 item 6; gap-analysis table |
| Vegetation | Hydrological routing (density provenance) | Watch (research) | **OPEN** | §9 item 7 |
| Celestial | High-res moon texture (NEW-6) | Watch | **OPEN** (deferred) | `CELESTIAL_ATMOSPHERE_DESIGN.md` §4.2 |
| Celestial | Volumetric-fog temporal reprojection (Phase 5f) | Prototype | **OPEN** (optional, per B11) | §4.8 / §6 Phase 5f |
| Celestial | Per-pixel varying-density fallback | Watch (research) | **OPEN** (intentionally unimplemented, per B21) | §4.9 |

### Standing rule

When any **OPEN** entry above reaches `Plan` with a batch sequence, **promote it out of this register** into the active campaign queue and leave a one-line "promoted → see X" pointer. When a **status: verify** item is confirmed, replace the tag with SHIPPED/OPEN + the evidence. Keep this crosswalk honest — it is the entry point reviewers will trust over any single source doc's self-description.
