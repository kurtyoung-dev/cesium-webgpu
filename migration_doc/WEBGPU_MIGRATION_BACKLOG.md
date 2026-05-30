# CesiumJS WebGPU Migration -- Remaining Work Backlog

**Last Updated:** May 30, 2026 (HEAD = `88b111e49c`, Batch 185 — flat textured-material GroundPrimitive classification fix). The body below stops at Session 37 / Batch 64; **roughly 120 subsequent feature batches (65–185) are not yet folded into this file.** For the current work frontier see [`WEBGPU_EXECUTION_ROADMAP.md`](WEBGPU_EXECUTION_ROADMAP.md); the "Recent progress" section directly below carries the load-bearing Batch 179–185 deltas.
**Purpose:** Single source of truth for ALL remaining work — active bugs, fork tech debt, parity gaps, sorting/picking enhancements, ES6 modernization, upstream issues, dormant compute shaders, and modern WebGPU feature integrations. Items resolved through April 2026 have been moved to `WEBGPU_MIGRATION_STATUS.md`. **For the canonical list of named C-R follow-ups deferred during review remediation, see [`DEFERRED_WORK.md`](DEFERRED_WORK.md) — this backlog covers everything ELSE.**

## Recent progress — Batches 179–185 (HEAD `88b111e49c`)

The body of this backlog stops at Batch 64; these are the load-bearing deltas at HEAD. The live work frontier is tracked in [`WEBGPU_EXECUTION_ROADMAP.md`](WEBGPU_EXECUTION_ROADMAP.md).

- **NEW-WEBGPU-BUFFERPOLYGON-WGSL-IMPORT — RESOLVED (Batch 180, `3667945dae`).** The WGSL preprocessor now resolves bare `#import` directives from `BUFFER_WGSL_CHUNKS`, so the BufferPolygon vector-tile path compiles. No longer an active compile bug.
- **Flat textured-material GroundPrimitive classification (Color/Stripe/Checkerboard/Grid) — SHIPPED (Batch 185, `88b111e49c`).** All four modes now render with their texture instead of flat color. Root cause was a 1-hop-too-deep inner-`_primitive` lookup that wrote `materialMeta.x = 0` (flipping the fragment shader to the flat-color fast path), **not** depth precision. Fix is the wrapper-chain walk in `packExtents` at `WebGPUGroundPrimitiveRenderer.js:313` (walks the wrapper chain until it finds the object that owns `_batchTable`). Bug pinned via the `[GPDIAG]` packUniforms trace in Batch 184.
- **`NEW-GROUNDPRIM-CLASSIFIER-RECON-PRECISION` — OPEN (the genuine residual after Batch 185).** A far-corner reconstruction-precision artifact that is legitimately log-depth-gated: the Checkerboard material degrades toward the far corner while Stripe stays clean. This is distinct from the flat-color bug above (which was a uniform-pack ordering issue) and tracks the precision residual that the renderer-wide log-depth epic addresses. Canonical detail in `WEBGPU_DEBUGGING_LOG.md`; recorded here so it is not lost between trackers.
- **Renderer-wide log-depth epic — IN PROGRESS.** Slices 0/1/2a shipped (Batches 181/182/183): the canonical `csm_*LogDepth` chunk family was reconciled to one WebGL-parity contract (Batch 181); shared inert infrastructure landed — the `ShaderDefine` bit, the `_logDepthWriteEnabled` master switch (defaults **FALSE**), and the lane helper (Batch 182); and the globe producer now writes log depth via `@builtin(frag_depth)` behind that flag (Batch 183). Consumer-reverse + classifier wiring + the master-switch flip remain — see `WEBGPU_EXECUTION_ROADMAP.md`.

## Recent activity — Batches 28-64 (2026-04-23 → 2026-04-25)

A 36-batch, 3-day burst of principal-engineer-review remediation. Full per-batch detail in [REVIEW_FIX_PROGRESS.md](REVIEW_FIX_PROGRESS.md); per-issue status in [PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md](PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md). Highlights below; the full inventory of items still deferred from this work has been consolidated into [DEFERRED_WORK.md](DEFERRED_WORK.md) so future sessions have a stable pick-list.

### Critical-tier wins (C-R prefix)

- **C-R2 derived-command dispatcher** (Batch 29) — `selectCommandVariant` polymorphic routing across logDepth / hdr / picking / pickingMetadata / shadows.receiveCommand / depth. Wired in both `executeWebGPUCommand` and `_executePickBatch`.
- **C-R3 translucent back-to-front sort** (Batch 28) — `CommandSorter` integration for non-OIT TRANSLUCENT, VOXELS, GAUSSIAN_SPLATS pass loops. OIT path stays unsorted (order-independent).
- **C-R7 pipeline cache infrastructure** (Batches 33-34) — instantiation, key correctness, device-loss invalidation. First-cut renderer migration in Batch 56 (Ellipsoid, GaussianSplat, DepthPlane). 12 renderers + ModelRenderer remain — see `C-R7-RENDERER-MIGRATION-REMAINING` + `C-R7-SHADER-MODULE-DEDUP` in DEFERRED_WORK.md.
- **C-R8 scene passes** — globe depth update (Batches 35/42/43), 2D frustum jitter (Batch 36), InvertClassification full stack (Batches 38-41), Edge FBO + emitter + feature parity (Batches 44-46), Edge inline + feature ID + ID format + composite prune (Batches 48-51), Translucent tile classification first cut + MSAA gate (Batches 47, 61). Three classification follow-ups deferred: see `C-R8-TRANSLUCENT-DEPTH-ONLY`, `C-R8-TRANSLUCENT-MULTI-FRUSTUM`, `C-R8-TRANSLUCENT-CLASSIFICATION-DISPATCH` in DEFERRED_WORK.md.
- **C-R9 pick path** — Ellipsoid (Batch 30), Ground+Splat (Batch 31), Voxel (Batch 53), Model (Batch 54). All five missing pick targets now ship at primitive granularity. Three follow-ups deferred for per-feature, per-cell, and OIT-translucent variants.
- **C-R10 point-light shadows** — Cast (Batch 34), Model FS receive (Batch 57), 5-tap PCF soft shadows (Batch 63, this rollup). Globe terrain receive deferred as `C-R10-GLOBE-POINT-LIGHT`.
- **C-R11 bind-group cache** — post-process consumers (Batches 31-32), per-tile EffectsBindGroup collection cache (Batch 55). Per-tile clipping bind-group hot path went from ~12k allocations/sec to 0 steady-state.
- **C-R12 device-loss invalidation event** (Batch 33) — subscriber registry on `WebGPUContext`, six subsystem getters wired, scene-renderer-level `_ensureResources` rebuild on next frame. Per-object cache extension deferred as `C-R12-PER-OBJECT-CACHES`.

### Doc rollup (Batch 64, this work)

- New canonical follow-up inventory at [DEFERRED_WORK.md](DEFERRED_WORK.md). 14 named follow-ups grouped by parent C-R finding with What / Why / Prerequisites / Effort / Impact / Trace fields per entry.
- This file's "Last Updated" header refreshed; recent activity section added.
- [NEXT_SESSION_HANDOFF.md](NEXT_SESSION_HANDOFF.md) refreshed to 2026-04-25.

### Soft point-light shadows (Batch 63, this work)

5-tap cross PCF kernel in `samplePointShadow` of `ModelPBRComplete.wgsl`. Activated via the previously-reserved `pointLightPositionWC.w` slot — `radius=0` keeps Batch 57's hard sampling bit-exact (back-compat); `radius>0` runs cross taps along the two minor cube-face axes (the axes that aren't the dominant face axis), keeping all 5 samples on the same face's depth texels and avoiding seam artifacts. UBO size unchanged (336 bytes). `shadowMap.softShadows = true` auto-resolves to a 1.5-texel radius via `WebGPUEffectsBindGroup.js`'s auto-detect path. Cube-face edge length now flows through `effects.shadowMapSize.x` so the kernel converts texels → unit-direction offsets correctly.

## 2026-04-20 — Session 37 findings (FR audit + review-doc sweep)

- **`FeatureRendererKey.FOG` was a dead registration — now removed.**
  Surfaced by the new `Tools/audit-feature-renderers.mjs` script
  (landed this session to address review §4d). Deep trace: classic
  distance-based fog is already driven by `frameState.fog.*` → packed
  into the per-tile UB by `WebGPUGlobeSurfaceRenderer.ts:2539` (with
  humidity modulation + enabled-gating) → read as `tile.fogDensity` /
  `tile.fogVisualDensityScalar` / `tile.fogMinimumBrightness` in
  `GlobeTerrain.wgsl:1447`. That's the only consumer. The FR wrapper
  `getWebGPUFogParameters(fog, frameState)` returned a strict subset
  (`{ density, minimumBrightness }`) missing `offset`,
  `visualDensityScalar`, and humidity — wiring it in would have
  regressed consumers. Removed this session: the registration in
  `WebGPUFeatureRenderers.ts`, the `getWebGPUFogParameters` export
  from `WebGPUEnvironmentRenderer.js`, and the cross-module import.
  **Key itself retained** in `FeatureRendererKey.js` (add-only
  discipline — reordering would renumber every later slot) with an
  explanatory comment at the registration site so future contributors
  know the slot is reserved but deliberately unbound.
- **No interaction with `VOLUMETRIC_FOG`.** Verified via grep:
  `WebGPUVolumetricFogRenderer.ts` never reads `frameState.fog.*`. The
  two systems are orthogonal — classic fog is a per-fragment
  exponential inside globe terrain; volumetric fog is a Phase 5
  froxel-grid compute-pass producing a 3D LUT that composites after
  the scene. They can coexist trivially (transmittance naturally
  multiplies) and neither currently consumes the other's state.
- **Retained forward-looking auto-uniforms** (`csm_fogDensity`,
  `csm_fogMinimumBrightness`, `csm_fogVisualDensityScalar`) in
  `WebGPUAutoUniforms.js`. These are registered in the SCENE + GLOBE
  groupings but no WGSL shader currently references their names, so
  they allocate zero bytes today. Keeping them preserves the OPEN-5
  rationale comment and the design-contract shape — if a future custom
  WGSL shader needs distance fog via auto-UB (instead of the globe's
  tile-UB path), the plumbing is ready. Matches the CLAUDE.md "never
  trim WIP-module interfaces" discipline.
- **Reviewed principal-engineer review 2026-04-16 lifecycle items.**
  §3a (ring allocator), §3c (view/bindgroup caching), §3d (device-lost
  recovery dispose), §3e (shader-cache WGSL source attach), §4b
  (DrawCommand `occlude`/`pickOnly` parity), and §4c (lazy FR promise
  caching) all verified FIXED in working-tree. §5d (ShadowMap spec
  registry pollution) and §6b (last orphan panorama `console.log`)
  fixed this session. §6a fixed on the orphan
  `WebGPU{Shader,Pipeline}Cache` modules (they accept `contextId` and
  prefix logs) — still follows `C-R7-CENTRAL-PIPELINE-CACHE` for when
  those caches actually get instantiated.
- **Reviewed principal-engineer review 2026-04-16 lifecycle items.**
  §3a (ring allocator), §3c (view/bindgroup caching), §3d (device-lost
  recovery dispose), §3e (shader-cache WGSL source attach), §4b
  (DrawCommand `occlude`/`pickOnly` parity), and §4c (lazy FR promise
  caching) all verified FIXED in working-tree. §5d (ShadowMap spec
  registry pollution) and §6b (last orphan panorama `console.log`)
  fixed this session. §6a fixed on the orphan
  `WebGPU{Shader,Pipeline}Cache` modules (they accept `contextId` and
  prefix logs) — still follows `C-R7-CENTRAL-PIPELINE-CACHE` for when
  those caches actually get instantiated.

## 2026-04-19 — Session 35 findings (stale specs + carry-overs)

Captured during Session 35's variant smoke-test landing + Resource.js
parseUrl regression repair. Each is small and isolated — take one
opportunistically when touching the adjacent area.

- **IonResourceSpec is stale after the ES6 modernization** — the
  `"constructs with expected values"` test spies on `Resource.call` and
  expects the prototype-style `Resource.call(this, {...})` invocation
  which ES6 class inheritance doesn't produce. `IonResource` is
  `class IonResource extends Resource` since commit `39f5341e64`
  (Option B material UBO split / ES6 modernization sweep) but the spec
  wasn't updated. Fix is a spec-only edit: replace the `spyOn(Resource,
  "call")` assertion with a state assertion against the constructed
  resource's `_url` / `_retryCallback` / `_retryAttempts`. No source
  change needed. 25/26 IonResource tests already pass; only this one is
  affected. Core/Resource: 119/119 pass — the parseUrl fix this session
  doesn't regress anything. File:
  `packages/engine/Specs/Core/IonResourceSpec.js:18-30`.
- **ImageryProvider specs fail with "Class constructor X cannot be
  invoked without 'new'"** — same root cause as IonResourceSpec. 5
  specs flagged during this session's Resource.js verification run
  (ArcGisMapServerImageryProvider, OpenStreetMapImageryProvider,
  TileMapServiceImageryProvider — all extend `UrlTemplateImageryProvider`
  via ES6 class). These are pre-existing failures from the earlier
  modernization sweep; none are caused by Resource.parseUrl changes.
  Fix pattern: either update the specs to use `new Subclass(...)` or
  check if the upstream `UrlTemplateImageryProvider` modernization left
  an in-use `XyzImageryProvider.call(this, ...)` pattern that needs a
  `super(options)` rewrite. Triage before fixing — the production code
  paths all route through `new`, so this is purely spec debt.

## What landed in Sessions 33 + 34 (2026-04-18)

- **CSM Slice 1 — cascaded shadow maps, RTE-precise.** Globe terrain + `PrimitivePhongTexturedColor` now sample a 4-cascade depth32float array. Cast + receive paths both carry RTE-aware cascade VPs (`VP_RTE = VP_world * T(+cameraWC)` composed in FP64 on CPU). Per-cascade slope-scaled depth bias (`bias = max(minBias[i], maxSlopeBias[i] * (1 - dot(N, L)))`) replaces the hardcoded 0.005 bias — scales with cascade extent so cascade 0 (10m) and cascade 3 (10km) both stay shimmer/peter-panning-free. Scene toggle `scene.useCascadedShadowMaps` (default off). `WebGPUCSMRendererSpec.js` covers the math + the new `applyCameraTranslationToVP` helper. See [WEBGPU_DEBUGGING_LOG.md](WEBGPU_DEBUGGING_LOG.md) § Session 33 and [CSM_DESIGN.md](CSM_DESIGN.md) for detail.
- **TAA Slice 1 — temporal AA with RTE motion vectors.** `WebGPUTAAEffect` now reprojects history via depth-based motion vectors reconstructed in **eye-relative space** — no world-space reconstruction at Earth scale, so FP32 stays exact at orbital altitudes. `UniformState` gained a model-independent `viewProjectionRelativeToEye` field plus `previousViewProjectionRelativeToEye` / `previousCameraPosition` snapshots. TAA params UBO grew 32 → 256 bytes to carry the 3 mat4 + vec3 delta + historyValid flag. Scene toggle `scene.taaEnabled` (default off). `TAA.wgsl` falls back to UV-identity on first frame / sky / behind-camera / disoccluded pixels. See [WEBGPU_DEBUGGING_LOG.md](WEBGPU_DEBUGGING_LOG.md) § Session 34 and [TAA_DESIGN.md](TAA_DESIGN.md) for detail.

## What landed as Slice 1 follow-ons + CSM Slice 2a (2026-04-18, post-Session 34)

- **Cast-output verification contract (CPU).** New exported `computeCastClipPosition(pHigh, pLow, camHigh, camLow, lightVpRte, depthBias, result)` helper in `WebGPUCSMRenderer.ts` — the CPU reference for the `rte24` cast VS math; the contract every Slice 2 variant must preserve. New `WebGPUCSMCastUBOLayoutSpec.js` locks the 128-byte cast UBO byte layout (lightVP_RTE @ float 0, camHigh @ 16, camLow @ 20, depthBias @ 24, normalBias @ 25) + `BASE_MIN_BIAS`/`BASE_MAX_SLOPE_BIAS` tuning constants. Extended `WebGPUCSMRendererSpec.js` with 4 Earth-scale identity specs: identity-at-origin, Earth-scale RTE subtract, `VP_RTE · rte ≡ VP_world · worldPos`, bias-only-touches-z. GPU-readback infrastructure not built — CPU contract specs catch the same class of regression.
- **`worldPosition` varying removed from `PrimitivePhongTexturedColor.wgsl`.** Zero-filled after Session 33; no fragment code read it. VertexOutput struct shrunk from 6 to 5 varyings. Removal eliminates the attractive-nuisance of a varying named like a world-space position that had silently become bad-precision after Session 33.
- **CSM Slice 2a — all cast variants unlocked.** `WebGPUCSMRenderer.renderCastPass` generalized to handle every `SHADOW_CAST_VARIANTS` entry: `rte24`, `p12`, `modelP12`, `modelInstanced`, `modelInstancedSB`, `modelSkinned`, `quantized12`. Models, skinned models, instanced models, and quantized-mesh terrain all now cast cascaded shadows. Pattern-matches the single-shadow-map loop (no-extras path → shared per-cascade bind group; extras path → per-command bind group indexed by cascade; multi-VB variants walk `vertexBufferSourceSlots`). New `getShadowCastVariant(key)` export in `WebGPUShadowMapRenderer.js` — single metadata source across both paths. See [CSM_DESIGN.md](CSM_DESIGN.md) § "Slice 2 progress" for detail.
- **CSM Slice 2b — texel-snap stabilization + PrimitivePhongColor receive.** New exported `snapToTexelGrid(center, radius, lightDir, resolution, result)` helper in `WebGPUCSMRenderer.ts` quantizes the cascade sphere center to the shadow-texel grid in world-grid-locked light space (basis depends only on `lightDir`, not the camera — that's what makes it stable). Integrated in `computeCascadeVPs` so cascade 0 (tight) doesn't crawl as the camera moves. 5 new specs cover idempotence, bounded displacement, zenith-Z invariance, bounding coverage preservation, and VP numerical stability. `PrimitivePhongColor.wgsl` extended with the same CSM receive branch as `PrimitivePhongTexturedColor.wgsl` (gated on `effects.csmControl.x > 0.5`). CSM bindings land at `@group(2) @binding(10/11)` for PhongColor (no texture group in between) vs. `@group(3)` for the textured variant — no JS pipeline changes needed; the effects BGL already advertises bindings 10/11 with placeholders when CSM is off.
- **CSM Slice 2c — ModelPBRComplete CSM receive.** glTF PBR models now receive cascaded shadows. Model pipeline layout extended from 7 to 8 bind groups — effects (shadow + clipping + atmosphere + CSM) added as `@group(7)` alongside the existing camera/material/texture/skinning/morph/instancing/featureId groups. Per-frame `createEffectsBindGroup` call in `WebGPUModelRenderer.updateWebGPUModel` mirrors the globe pattern. New `@location(7) rteMC` varying carries the existing model-space RTE vector (already computed in VS as `positionMC - encodedCameraPositionMC`); the fragment shader rotates it to world-space RTE via `(material.modelMatrix * vec4(rteMC, 0.0)).xyz` — w=0 drops translation so the rotation+scale part yields exactly `pWC − camWC` without FP32 reconstruction at Earth scale. CSM helpers inlined from the primitive receivers; fragment gate `effects.csmControl.x > 0.5` multiplies `direct` Cook-Torrance lighting by `shadowFactor`. Ambient + emissive remain unshadowed per PBR convention. Unlit materials (`FLAG_IS_UNLIT`) early-exit before the CSM path so they're naturally safe.

## What landed in Batches 6-27 (2026-04-16 → 2026-04-18)

- **TAA / motion-vector plumbing** (DP-H41 "ALL-RENDERERS"): `previousViewProjection: mat4x4<f32>` now in every renderer's `CameraUniforms`. TAA / CSM work no longer needs renderer-specific bind-group adjustments — read it via `camera.previousViewProjection` from any pipeline. Session 34 built directly on top of this slot.
- **WebGPU shader variant infrastructure**: `ShaderDefine` bitmask registry, `ShaderSourceId` registry, `//>>ifdef` preprocessor, per-device `GPUShaderModule` dedupe cache with prewarm API. See `CLAUDE.md` → "WGSL Shader Pipeline" for the usage contract.
- **DP-H19 CPU compressed-vertex decode**: `normal` + `st` + `tangent` + `bitangent` all reconstructed from `compressedAttributes`. Scaffold for GPU-side decode in place behind a feature flag (runtime swap is the remaining work — see DP-H19-SHADER-DECODE-RUNTIME below).
- **Principal-engineer review**: ~95% of the 2026-04-16 findings addressed (H-P5 mapAsync hazards, C-P7-RTE VolumetricFog altitude cancellation, DP-H40 split, DP-H42 depth-test distance, DP-H25 geodetic normal, and 80+ others). Full per-batch list in `REVIEW_FIX_PROGRESS.md`.

### Remaining from the review set

- **DP-H19-SHADER-DECODE-RUNTIME** — runtime flip of the vertex-buffer packer to emit `compressedAttributes` directly + skip `ensureUncompressedAttributes` when the feature flag is on. Expansion of `_SHADERS_WITH_GPU_DECODE` beyond `phong` is additive (one `//>>ifdef` block + one registry entry per shader). Effort: S-M per shader; scaffold is in place.
- **STUB-NAGA** — lazy-load `naga-wasm` for GLSL→WGSL translation path. Infrastructure follow-up.
- **BUILD-IIFE-INFLATION** — IIFE bundle size optimization (code-split support limited by format). Infrastructure follow-up.
- **WeatherParticleRender + Generated/EllipsoidPrimitive** `previousViewProjection` buffer writes already landed in Batch 27; no further TAA plumbing pending.

> **⚠️ READ FIRST — Current architectural frame:** The direction of travel is captured in **[PHASE_8_GPU_RESIDENT_TILES_DESIGN.md](PHASE_8_GPU_RESIDENT_TILES_DESIGN.md)**. It synthesizes Phase 7 (external engine features) + 3D Tiles implementation audit + 3D Tiles 2.0 spec research into a single architectural frame. **Do not start any rendering or 3D Tiles work without reading it** — it identifies the gating architectural decision (shader variant strategy), the central insight ("GPU-resident octree tile cache"), the full dependency DAG, and the recommended phased roadmap. All Phase 8 items in this backlog are shorthand pointers into that design.
>
> For architecture, completed work, bug fix history, current state, and the Phase 0 / Phase 1 / Renderer Threading / Phase 5 progress sections, see `WEBGPU_MIGRATION_STATUS.md`.

---

## Phase 8 — GPU-Resident Tiles (2026-04-14) — **CURRENT DIRECTION**

> **📐 Design doc: [PHASE_8_GPU_RESIDENT_TILES_DESIGN.md](PHASE_8_GPU_RESIDENT_TILES_DESIGN.md)** — 512 lines, the architectural source of truth. Read that first; this backlog section is the stable-ID index.

### The headline

**Central insight:** 3D Tiles content is mostly static across frames; the camera moves. The destination is a GPU-resident octree of tiles where per-frame CPU cost is O(camera-delta), not O(visible-tiles) — Unreal Nanite / Unity Resident Drawer paradigm adapted for planetary scale.

Three independent Session 29 investigations (feature inventory, 3D Tiles implementation audit, 3D Tiles 2.0 spec) converged on this pattern. Detailed in design-doc §1.

### The gating decision

**TILE-ARCH-SHADER-STRATEGY** — `WebGPUModelPipelineCache` today keys pipelines on 3 bits (`alphaMode | doubleSided<<2`) → 6 pipelines for ALL glTF content in ALL tiles. This "monolithic `ModelPBRComplete.wgsl`" trade-off **silently drops** `KHR_materials_{clearcoat, sheen, anisotropy, iridescence, transmission, volume, variants, IOR}` + `KHR_lights_punctual`.

**~30% of Phase 7 items cannot land cheaply until this is resolved.** Recommended: coarse ~20-pipeline variant strategy (material-family × alphaMode × doubleSided) with pre-warmed compile. See design-doc §2 for the trade-off matrix. **Effort: M** for design + prototype.

### Recommended phased roadmap (from design-doc §5)

| Phase | Theme | Duration | Gates |
| --- | --- | --- | --- |
| **8a Foundation** | Normal G-buffer, ParityManager, shader variant strategy, ellipsoid-aware RTE, tile↔Hi-Z wiring | 1-2 weeks | Unblocks ~60% of everything else |
| **8b GPU-Resident Stack** (aka DOD Storage Layer) | MegaBuffer + Resident Drawer + sharedSourceBuffer + dynamic-offset UBO + WGSL styling compiler + property-texture audit + WBOIT — **assembled, this is one coherent data-oriented storage layer with Cesium API facades, not six independent features.** See design-doc §3.5. | ~5 weeks (revised from 3-4; original estimate undersized shared plumbing) | Collapses 1k-10k draw calls/frame to O(10); per-frame CPU becomes O(camera-delta) |
| **8c Visual Quality** | KHR_lights_punctual → clearcoat/sheen/anisotropy/iridescence → GTAO → env probes → aerial-perspective LUT → decals → clustered lighting | 3-4 weeks | Depends on 8a shader strategy |
| **8d Advanced** | TAA → CSM → ESM/VSM/PCSS → STP → planar reflections → FFT ocean → motion blur → impostors | 4-6 weeks | Some items dormant design-doc-ready |
| **8e Differentiators** | NGA_GPM uncertainty, DDGI-per-tile, grass/foliage, refraction | Opportunistic | Bounded use cases |

### Foundation items — FEAT-GAP-* (missing infra, not in engine AND not in Phase 7)

### Foundation items (FEAT-GAP-* — missing infra, not in engine AND not in Phase 7)

- **FEAT-GAP-01** — Normal G-buffer + depth prepass. Single highest-leverage infra gap. Unblocks GTAO, SSR quality, contact shadows, planar reflections, bent-normal AO, motion blur, SSGI. Effort: M.
- **FEAT-GAP-02** — Motion blur (camera + per-object). Reuses TAA motion vectors. Effort: M (post-TAA).
- **FEAT-GAP-03** — Planar reflections. Water, wet tarmac, lakes near horizon. Effort: M.
- **FEAT-GAP-04** — Refraction / caustics. Water + glass buildings. Effort: M.
- **FEAT-GAP-05** — Terrain contact shadows / screen-space contact shadows. Mid-day urban improvement. Effort: S-M.
- **FEAT-GAP-06** — Bent-normal ambient for terrain. Pre-baked or screen-space. Effort: M.
- **FEAT-GAP-07** — Impostors for far-LOD 3D Tiles + vegetation. Fights distant popping. Effort: L.
- **FEAT-GAP-08** — Decals projected onto terrain + 3D Tiles. Road markings, AOI overlays. Existing `GROUND_PRIMITIVE` is flat-plane. Effort: M-L.
- **FEAT-GAP-09** — Aerial-perspective LUT consumer in all passes. `AtmosphereLUT.wgsl` exists; ground atmosphere samples it; sky atmosphere samples it (separate binding group); **primitive PhongTexturedColor now samples it (2026-04-19)** — proof-of-concept landed as a reference pattern. Remaining shader extensions (same pattern, ~20 lines each): `PrimitivePhongColor.wgsl`, `PrimitiveMatColorLit.wgsl`, `PrimitiveMatImageLit.wgsl`, `PrimitivePBRSimple.wgsl`, `PrimitivePBRTextured.wgsl`, `ModelPBRComplete.wgsl`. Each already has `atmosphereLutControl: vec4<f32>` in its effects UBO and the bind group already exposes the LUT textures at bindings 7/8/9 — just need to add the shader-side sampler/texture declarations + the fog blend at fragment output (mirror the PhongTexturedColor diff from Session 34 follow-on). Effort: S per shader, ~6 shader edits. **Sneaky high-value visual win.**

### 3D Tiles 2.0 WebGPU-specific gaps (FEAT-3DT2-*)

Upstream Cesium parses all 8 canonical extensions; the rendering-side WebGPU gaps:

- **FEAT-3DT2-01** — **Styling expression → WGSL compiler** (restricted subset first). Single biggest 3D Tiles performance lever. Effort: M (subset) → L-XL (full).
- **FEAT-3DT2-02** — Property-texture + feature-ID WGSL sampling audit. Effort: M.
- **FEAT-3DT2-03** — Ellipsoid-aware RTE (non-WGS84 tilesets). Correctness fix. Effort: M.
- **FEAT-3DT2-04** — NGA_GPM point-cloud uncertainty visualization. Differentiating. Effort: L.
- **FEAT-3DT2-05** — Draco / KTX2 / meshopt WebGPU end-to-end audit. Effort: M.

### Tech debt / perf / WASM / arch items (TILE-DEBT-*, TILE-PERF-*, TILE-GPU-*, TILE-WASM-*, TILE-ARCH-*)

See `PHASE_8_GPU_RESIDENT_TILES_DESIGN.md` § 9 for the full list (40+ items across A-G categories). Top 8 by payoff-per-effort for 3D Tiles:

- **TILE-DEBT-01** — Buffer pool / recycler (§9.A). Biggest cause of first-frame stutter. Effort: M.
- **TILE-PERF-01** — Pipeline pre-warm on tileset load (§9.B). Eliminates compile stutter. Effort: S (after shader variant strategy).
- **TILE-ARCH-01** — Cross-tile mesh dedup (§9.A + §9.G). Pairs with MegaBuffer FEAT-SURVEY-20. Effort: M.
- **TILE-PERF-02** — KTX2 transcode on worker (§9.B). Eliminates frame stalls. Effort: M.
- **TILE-WASM-01** — WASM SIMD tile traversal (§9.D). 3-4× traversal speedup on dense scenes. Effort: M.
- **TILE-ARCH-02** — Tile-level render bundle cache (§9.G). Massive savings on static tile content. Effort: L.
- **TILE-PERF-03** — Shared UBO for tile-invariant data (§9.E). Reduces BW + GC. Effort: S-M.
- **TILE-PERF-04** — Early-out on static camera (§9.B). Enormous idle-frame win. Effort: S-M.

### Architectural decision (Phase 8a gating)

- **TILE-ARCH-SHADER-STRATEGY** — Decide between keep-monolithic / fine-grained variants / coarse-variants-with-prewarm for `ModelPBRComplete.wgsl`. Gates ~30% of Phase 7 items (all KHR BRDFs + clustered lighting). Recommended: coarse ~20-pipeline strategy with pre-warmed compile. See `PHASE_8_GPU_RESIDENT_TILES_DESIGN.md` § 2. Effort: M design + prototype.

---

## Phase 7 — External Engine Feature Survey (2026-04-14)

An eight-project survey of other WebGPU rendering / compute projects to identify transferable features. Each item below has been filtered for (a) genuine novelty vs our existing 36 feature renderers + 7 compute dispatchers, (b) compatibility with RTE 64-bit precision at planetary scale, (c) fit with the `FeatureRendererKey` backend-agnosticism contract.

**Sources surveyed:** NullGraph Engine, ChartGPU, Hypercube-Compute, Taichi.js, Vello, Zephyr3D, RedGPU, Unity's WebGPU Export, Orillusion.

**Rejected wholesale** (not listed below): ChartGPU (2D `f32`-only charting, domain mismatch), Taichi.js DSL (competes with our dispatcher stack), Vello renderer itself (2D vector, non-RTE), Orillusion "ray tracing" (is actually SSR), Zephyr3D shader builder (would replace ShaderBuilder wholesale).

**Partially adopted via Phase 8b** (correction from initial Phase 7 survey): NullGraph's "zero scene graph" DOD was originally flagged as "incompatible with Scene/Primitive contract." That rejection was **too broad** — it was right about the *public API* (we keep `Cesium3DTileset` / `Primitive` / `Entity` intact) but wrong about the *storage layer*. Phase 8b's assembled stack (MegaBuffer + Resident Drawer + sharedSourceBuffer + dynamic-offset UBO + WGSL styling compiler + property-texture audit) **is** a DOD storage layer with Cesium API facades on top, equivalent in architecture to Unity's Resident Drawer pattern. See [PHASE_8_GPU_RESIDENT_TILES_DESIGN.md](PHASE_8_GPU_RESIDENT_TILES_DESIGN.md) § 3.5 for the full analysis and architectural mapping of NullGraph patterns → Phase 8b items.

**Deferred-but-tracked items** (listed in Tier 3 with explicit gating conditions): Unity STP upscaler (requires TAA motion vectors first), Unity Adaptive Probe Volumes (requires camera-anchored streaming redesign).

**Convergent signals to weight most heavily:**

- **Clustered Forward Lighting** appears in Zephyr3D + Orillusion + Unity URP (3 independent sources converged).
- **Persistent GPU instance tables** appear in Unity (Resident Drawer) + NullGraph (MegaBuffer) + Hypercube (MasterBuffer).
- **Decoupled-lookback prefix sums** in Vello + implied by Hypercube's parity+indirect orchestration.

### Tier 1: High ROI, S effort (quick-win bundle)

- ~~**FEAT-SURVEY-01**~~ — **GTAO post** — **LANDED 2026-04-19**. New `GTAOGenerate.wgsl` shader implementing the Jimenez 2016 analytic cos-weighted horizon integral. `AmbientOcclusionConfig.algorithm: "hbao" | "gtao"` toggles between the legacy HBAO path and GTAO — both share the same bind group layout, uniform buffer, and output shape, so downstream blur + modulate passes don't need any changes. Default stays "hbao" for backwards compatibility; opt into GTAO via `new AmbientOcclusionEffect({ algorithm: "gtao" })`.
- **FEAT-SURVEY-02** — **KHR_materials_clearcoat BRDF**. Source: Orillusion `LitMaterial.ts`. 3D Tiles with KHR extensions currently render as plain PBR in our fork — we silently drop clearcoat/IOR. Add 3 uniform fields + WGSL BRDF term. Must respect Option B material UBO split. **Effort: S**.
- **FEAT-SURVEY-03** — **KHR_materials_sheen BRDF**. Same pattern as clearcoat. **Effort: S**.
- **FEAT-SURVEY-04** — **KHR_materials_anisotropy BRDF**. Same pattern. **Effort: S**.
- ~~**FEAT-SURVEY-05**~~ — **GodRay screen-space light shafts** — **LANDED 2026-04-19**. Two-pass effect: `GodRayGenerate.wgsl` radial-blurs from a caller-provided sun screen UV (depth-gated so geometry cleanly blocks the shaft) at half-res; `GodRayComposite.wgsl` additively blends the ray buffer onto the scene color at full-res. New `GodRayEffect` class with `setSunScreenUV(u, v)` + `setFrustum(near, far)` for per-frame updates. Config: density/decay/weight/exposure/sampleCount/occlusionFarCutoff. Pure screen-space → RTE-safe by construction. Insertion point is caller's choice (before/after bloom).
- ~~**FEAT-SURVEY-06**~~ — **Decoupled-lookback prefix-sum WGSL** — **LANDED 2026-04-19**. New `Compute/DecoupledLookbackScan.wgsl` implementing the Merrill & Garland single-pass parallel prefix-sum with per-workgroup aggregate publishing + lane-0 lookback loop. u32 inclusive scan; Brent-Kung sweep inside each 256-wide workgroup. Output + partition-state buffers; host zeros partitions before dispatch. **Consumer wiring pending**: culling compaction + indirect-draw compaction still use the legacy two-pass reduce+downsweep pattern — swap them over one at a time to minimize blast radius. Estimated S per consumer swap.
- ~~**FEAT-SURVEY-07**~~ — **ParityManager centralized ping-pong slot resolver** — **LANDED 2026-04-19**. New `WebGPUParityManager.ts` — pure JS/TS, no GPU resources of its own. Consumers `register(name, [resourceA, resourceB])` to get a stable `HistorySlotId`, then call `parity.advanceFrame()` once per frame and `parity.read(id)` / `parity.write(id)` to resolve the correct slot. Supports per-slot `phaseOffset` for future multi-phase history. `rebind(id, [newA, newB])` preserves phase across resizes. 8-test spec coverage (`WebGPUParityManagerSpec.js`). **Remaining**: refactor `WebGPUTAAEffect._historyIndex` to delegate to the manager — mechanical change, one session. Future consumers (Hi-Z reprojection, auto-exposure histogram) start here instead of growing another inline parity field.
- **FEAT-SURVEY-08** — **ESM soft shadow filter**. Source: Zephyr3D `shadow/esm.ts`. Exponential shadow map, stacks onto dormant CSM when landed. **Effort: S** (after CSM lands).
- **FEAT-SURVEY-09** — **VSM soft shadow filter with light-bleed clamping**. Source: Zephyr3D `shadow/vsm.ts`. Variance shadow maps for vegetation/foliage shadows. Planet-scale light-bleed needs the clamping trick. **Effort: S** (after CSM lands).
- **FEAT-SURVEY-10** — **PCSS soft shadow filter**. Source: Zephyr3D `shadow/pcf_pd.ts`. Percentage-closer soft shadows for architecture. **Effort: S** (after CSM lands).
- **FEAT-SURVEY-11** — **Draw Debugger** (per-draw visualization of bounding volumes, normals, tangents). Source: RedGPU `display/drawDebugger`. Augments `CesiumDebug` console. **Effort: S**.

**Suggested first-pass micro-batch (1-2 days):** FEAT-SURVEY-01, -05, -02, -06, -07 — five unrelated quality / infra wins with zero RTE or architectural friction.

### Tier 2: Valuable, M effort

> **Note on FEAT-SURVEY-20 / -23 / -24 / -25 (+ FEAT-3DT2-01 / -02 in Phase 8):** These five items are **not independent features**. Assembled together with TILE-ARCH-01 (mesh dedup) and TILE-PERF-03 (shared UBO), they form the **DOD storage layer** that is Phase 8b in the design doc. Scoped in isolation each is M effort; landed together as one architecture they share plumbing and have compounding payoff. See [PHASE_8_GPU_RESIDENT_TILES_DESIGN.md](PHASE_8_GPU_RESIDENT_TILES_DESIGN.md) § 3.5 for the full architectural mapping.

- **FEAT-SURVEY-20** — **MegaBuffer + `firstIndex`/`baseVertex` mesh atlas** for 3D Tiles heterogeneous glTF content. Source: NullGraph `MegabufferBuilder`. One vertex/index buffer for many meshes, compute shader emits `meshID` per visible instance, single indirect draw renders thousands of distinct shapes. **RTE caveat:** canonical stride must include `positionHigh`/`Low` (doubles per-vertex size). **Effort: M** for prototype `MegaMeshAtlasFeatureRenderer` keyed via new `FeatureRendererKey.MEGA_MESH_ATLAS`. Full glTF integration is L.
- **FEAT-SURVEY-21** — **WBOIT (weighted-blended order-independent transparency)**. Source: Zephyr3D `render/weightedblended_oit.ts`. Fixes stacked polyline/billboard/glTF alpha sorting at horizon where depth-sort fails. Compute-cheap. A-buffer variant is L (memory-heavy, conflicts with Hi-Z + TAA budget). **Effort: M** (WBOIT) / L (A-buffer).
- **FEAT-SURVEY-22** — **GPU Particle Emitter with ease curves + atlas sprites**. Source: RedGPU `display/paticle/ParticleEmitter.ts`. First-class GPU particles for smoke/fire/dust over terrain. Fills real gap — current clouds are volumetric-only. **RTE caveat:** particle positions as Low-delta around emitter High anchor. **Effort: M**.
- **FEAT-SURVEY-23** — **Dynamic-offset uniform + indirect dispatch orchestration**. Source: Hypercube-Compute `GpuDispatcher` + manifest. Single uniform buffer with per-draw 256B-aligned offsets; exactly the pattern needed for upcoming multi-draw-indirect. Refactor one existing dispatcher (e.g., frustum cull) as template. **Effort: M**.
- **FEAT-SURVEY-24** — **GPU Resident Drawer / persistent instance table**. Source: Unity 6 SRP batcher + BatchRendererGroup. Amortizes per-instance uniform upload across frames; pairs with our compute culler. **RTE caveat:** stride doubles (64B vs 32B per instance) for `positionHigh`/`Low`. **Effort: M**.
- **FEAT-SURVEY-25** — **`sharedSourceBuffer` compute-cull fanout**. Source: NullGraph `BatchManager`. Multiple indirect batches read one producer storage buffer (one entity stream, many rendering variants: CSM cascades + TAA history + Hi-Z re-cull). Clean fit for dormant CSM 4-cascade design. **Effort: S-M**.
- **FEAT-SURVEY-26** — **Box/Sphere environment probes with parallax correction**. Source: Orillusion `components/renderer/Reflection.ts`. Localized reflections for building interiors in 3D Tiles. Complements existing sky-only IBL. **RTE caveat:** capture camera must be RTE-aware. **Effort: M**.
- **FEAT-SURVEY-27** — **RedGPU post-effect suite** (convolution, chromatic aberration, film grain, sharpen, lens distortion, hue/saturation/vibrance adjustments). Source: RedGPU `postEffect/effects/*`. Cinematic polish layer composed after tonemap. **Effort: S per filter, M as suite**.
- **FEAT-SURVEY-28** — **Kawase dual-filter bloom** (lower-quality, lower-cost alternative to current mip-chain bloom). Source: RedGPU `postEffect/effects/oldBloom`. Mobile/low-power profile toggle. **Effort: S**.
- **FEAT-SURVEY-29** — **Sprite3D / TextField batched sprite renderer** for HUD markers + debug overlays. Source: RedGPU `display/sprites`, `textFileds`. **Effort: M**. **Risk:** overlaps with Cesium's Label collection; scope carefully.
- **FEAT-SURVEY-30** — **Raycaster3D GPU color-ID readback picking**. Source: RedGPU `picking/Raycaster3D.ts`. Faster than CPU BVH for thousands of entities. **Effort: M**. **Risk:** we already have pick framebuffer path; marginal win unless entity count >>>.
- **FEAT-SURVEY-31** — **Jump-Flooding SDF in O(log N) passes**. Source: Hypercube-Compute `NeoSDFKernel.ts`. We already ship polygon SDF — worth a code diff to check propagation efficiency. **Effort: S** (code review only).

### Tier 3: High effort, scene-dependent

- **FEAT-SURVEY-40** — **Clustered Forward Lighting** (froxel light culling, 16×16×32 grid). Sources: Zephyr3D `render/cluster_light.ts` + Orillusion `passRenderer/cluster/`. Thousands of dynamic lights at city-scale (streetlights, vehicles, drones, signage). **Strong convergent signal — 3 sources use same pattern.** **RTE caveat:** cluster AABB math must use RTE deltas (cluster bounds relative to eye), not world-space. Log-Z slicing required for planetary far-planes (10⁷ m). **Effort: L**.
- **FEAT-SURVEY-41** — **FFT + Gerstner + FBM ocean water**. Source: Zephyr3D `render/fft_wavegenerator.ts`, `gerstner_*`, `fbm_*`, `material/water.ts`. Three wave spectra cohabiting one material + compute FFT ocean. Planetary ocean fidelity upgrade beyond current water support. **Caveat:** FFT tile is flat-plane — needs patching to our spherical water primitive + RTE tangent frame. **Effort: L**.
- **FEAT-SURVEY-42** — **Ghost-cell halo synchronizer pattern** for volumetric fog froxel borders. Source: Hypercube-Compute `GpuBoundarySynchronizer`. Their impl assumes flat Cartesian grid; our tile topology is cubed-sphere with LOD transitions — neighbor resolution differs. **Effort: L** (worth studying, not directly copying). Applies when dormant volumetric fog is wired.
- **FEAT-SURVEY-43** — **Grass / foliage material** (wind animation + subsurface-scattering-lite). Source: Zephyr3D `material/grassmaterial.ts` + `mixins/foliage.ts`. Pairs with GPU instancing for planetary vegetation cover. **Effort: M** (material) + L (vegetation scattering system on top).
- **FEAT-SURVEY-44** — **Virtual-Texture Clipmap Terrain research**. Source: Zephyr3D `render/clipmap.ts`, `scene/terrain-cm/`. Clipmaps outperform quadtrees at grazing angles. Research-only — conceptually collides with Cesium's authoritative quadtree terrain. **Effort: L (study only, do not integrate).**
- **FEAT-SURVEY-45** — **Octree + CPU raycast visitor** inside tiles. Source: Zephyr3D `scene/octree.ts` + `raycast_visitor.ts`. Complements our GPU frustum cull for CPU picking / physics queries on dense scene entities inside a single tile. **Effort: M**. **Risk:** Cesium already does BVH at tile level — only useful for dense glTF interiors.
- **FEAT-SURVEY-46** — **DDGI (Dynamic Diffuse Global Illumination, probe-based)**. Source: Orillusion `passRenderer/ddgi/`. Diffuse bounce for urban canyons / 3D Tiles interiors. Complements IBL+SH (sky-only today). **Caveat:** probe placement doesn't translate to planetary scale without per-tile-group cages. GPU readback conflicts with no-stall policy. **Effort: L**. Defer until bounded use case emerges.
- **FEAT-SURVEY-47** — **Adaptive Probe Volumes (APV) streaming SH probe grid**. Source: Unity 6 URP/HDRP. Camera-anchored probe streaming. **Gating:** streaming cadence must be driven by camera anchor (not world origin) — needs RTE-aware probe index. Memory non-trivial at global scale (~100 MB+ for continent-scale coverage). **Blockers:** (1) design a per-tile-group probe cage that follows the eye rather than the globe origin; (2) solve probe-cache eviction across quadtree LOD transitions. **Revisit when:** a use case emerges that needs diffuse bounce GI beyond IBL+SH (e.g., 3D Tiles urban interior content where current sky-only IBL produces flat shading). **Effort: L**. Deferred.
- **FEAT-SURVEY-48** — **STP (Spatial-Temporal Post-processing) upscaler**. Source: Unity 6 (DLSS-style web upscaler, reuses motion vectors + history, tied to their TAA). Massive win at 4K globe rendering — lets us render at 1080p/1440p and upscale. **Gating:** requires robust motion vectors we don't currently export from all feature renderers. RTE-specific issue: jitter must be reproducible frame-to-frame (deterministic Halton sequence in RTE eye-space, not world-space). **Blocker:** dormant TAA must land first — STP reuses TAA's motion-vector + history infrastructure. Once motion vectors ship, STP becomes a natural follow-on. **Revisit when:** TAA implementation completes (see `TAA_DESIGN.md`). **Effort: L**. Deferred — post-TAA.

### Skipped features (already shipped or architecturally incompatible)

For future session reference, don't waste cycles re-investigating: PBR-MR/SG, IBL+SH, TAA design, CSM 4-cascade design, SSR, SAO/HBAO baseline, Bloom, FXAA, 4-operator tonemap, Hi-Z occlusion, render bundles, indirect draw, shader-f16, hardware clip-distances, timestamp queries, quadtree terrain, point clouds, Gaussian splats, volumetric clouds, voxels, depth prepass, forward rendering, basic shadow maps.

### Source pointer

Full agent-generated survey reports (per-project pros/cons with file paths) are captured in the Session 29 conversation transcript — `C:\Users\Kurt\.claude\projects\f--Dev-GH-cesium-webgpu\a995f8ab-1f5c-4a94-99a4-16a7436c0a98.jsonl` for future reference. The critical signals were lifted into the items above.

---

## 2026-04-16 — Bundle Variants & Size Optimization

Opt-in tree-shaking variants for downstream consumers who only want one backend. Infrastructure is wired end-to-end; size measurement is pending a clean `buildAllVariants` run.

### Completed — build-variant infrastructure

- **BUILD-VAR-1** — `scripts/bundleVariantPlugin.js` added. esbuild `onResolve` plugin that intercepts import resolution and aliases backend-specific paths to empty stubs per variant. Uses a synthetic path-match (no `build.resolve` recursion) + a decision cache for O(1) repeat lookups — the codebase has ~3000 modules and plenty of import overlap.
- **BUILD-VAR-2** — `scripts/stubs/emptyShader.js` + `scripts/stubs/emptyModule.js` added. The shader stub is `export default ""` (satisfies GLSL string consumers, compile failure surfaces only if the WebGL code path actually runs — which it doesn't when the WebGPU feature renderer intercepts). The module stub is a `Proxy` that throws an explicit diagnostic on any non-introspection access.
- **BUILD-VAR-3** — `createCesiumJs(variant)`, `createIndexJs(workspace, variant)`, `bundleCesiumJs({variant, entryPoint, ...})`, `buildCesium({variant, ...})` all accept a variant param. Each variant writes its own entry barrel under `Source/` (`Cesium.js`, `CesiumWebGLOnly.js`, `CesiumWebGPUOnly.js`) and its own output dir under `Build/` (`Cesium{Unminified}`, `CesiumWebGL{Unminified}`, `CesiumWebGPU{Unminified}`).
- **BUILD-VAR-4** — `setGlobalDefaultRenderer` / `getGlobalDefaultRenderer` added to `RendererType.ts`. Each variant's entry barrel calls this at module init so the AUTO renderer path picks the right backend by default.
- **BUILD-VAR-5** — Gulp tasks: `buildCesiumDual`, `buildCesiumWebGLOnly`, `buildCesiumWebGPUOnly`, `buildAllVariants`. The combined task hoists `buildEngine` + `buildWidgets` so they run once across all three variants (~10s saved per extra variant).
- **BUILD-VAR-6** — ESM code splitting enabled (`splitting: true`, `outdir`, `chunkNames: "chunks/[name]-[hash]"`). The existing `await import("./WebGPU/WebGPUContext.js")` in `ContextFactory` now produces a real separate chunk instead of inlining — dual-variant ESM consumers who never pick WebGPU skip the WebGPU chunk download entirely.

### Pending — size measurement + validation

- **BUILD-VAR-MEASURE** — Run `npx gulp buildAllVariants` to completion (the session-29 attempt was interrupted). Capture minified + gzipped sizes for `Cesium.js` (IIFE), `index.js` (ESM entry), and each of the split `chunks/*.js` files across all three variants. Update CLAUDE.md's "Baseline (dual minified)" line with the concrete deltas. **Effort: ~5 min once the build completes (~2 min per variant).**
- **BUILD-VAR-RUNTIME-TEST** — Smoke-test each variant end-to-end in a browser: load `Build/CesiumWebGL/Cesium.js` and confirm a Viewer renders; do the same with `Build/CesiumWebGPU/Cesium.js`. The alias plugin's correctness depends on the feature-renderer pattern intercepting WebGL code paths before they touch the stubbed shader strings; if a missed code path reaches a stub, the failure mode is "empty shader compiles, black render" (webgpu-only) or the stub proxy throws (webgl-only). **Effort: ~30 min.**
- ~~**BUILD-VAR-SCENE-AUDIT**~~ — **COMPLETE 2026-04-19**. Full audit captured in [WEBGPU_DEBUGGING_LOG.md § BUILD-VAR-SCENE-AUDIT](WEBGPU_DEBUGGING_LOG.md). 19 files with `ShaderProgram.fromCache/replaceCache` sites classified: 13 safe (FR intercept gates them), 6 risky. The 6 risky files are tracked below as separate hazard items. **Staying on status quo:** webgpu-only variant remains experimental until either Option B (defensive guards, ~30 min) or Option A (real WebGPU FRs, L effort per family) lands.

### webgpu-only bundle hazards (from scene audit)

- ~~**BUILD-VAR-HAZARD-VECTOR3DTILE**~~ — **GUARDED 2026-04-30** (Batch 111). `if (context.rendererType === "webgpu") return;` early-returns added at the top of `Vector3DTilePrimitive.createShaders`, `Vector3DTilePolylines.createShaders`, and `Vector3DTileClampedPolylines.createShaders`. Webgpu-only bundle no longer crashes on these primitives; they silently no-op until a real WebGPU Vector3DTile feature renderer lands.
- ~~**BUILD-VAR-HAZARD-CLASSIFICATION**~~ — **GUARDED 2026-04-30** (Batch 111). Single early-return at the top of `ClassificationPrimitive.createShaderProgram` covers all 5 internal compile sites since they all live downstream of that one entry point.
- ~~**BUILD-VAR-HAZARD-DEPTH-PLANE**~~ — **GUARDED 2026-04-30** (Batch 111). Early-return added at the top of `DepthPlane.update` after the SCENE3D mode check. WebGPU has its own DepthPlane via `WebGPUDepthPlane`; this WebGL helper is a no-op on WebGPU contexts.
- ~~**BUILD-VAR-HAZARD-GROUND-POLYLINE**~~ — **GUARDED 2026-04-30** (Batch 111). Early-return added at the top of `GroundPolylinePrimitive.createShaderProgram`. WebGPU has its own ground-polyline path via `WebGPUGroundPolylineRenderer`.

All four hazards are now resolved at the **defensive-guard** level (Option B). The webgpu-only bundle no longer crashes when a scene contains these primitives — they silently no-op. Real WebGPU feature renderers for each family (Option A) remain on the backlog as Phase 8 feature work; those would actually render the primitives instead of skipping them.

### Known limitation — WebGPU-only bundle shrinkage is gated on scene-file audit

The webgpu-only variant aliases GLSL shader strings to `""`. In the common case this is fine because scene files early-return to the WebGPU feature renderer before touching those strings. But if any scene file path executes WebGL shader-compile code unconditionally (e.g., in constructor or `initialize`), the webgpu-only build would still crash at runtime. See **BUILD-VAR-SCENE-AUDIT** above. Until that audit is done, treat the webgpu-only bundle as **experimental** and recommend the dual bundle with runtime `renderer: 'webgpu'` for production use.

### Followup — runtime shader compiler (not in this session)

Per the Slang vs Naga discussion, if we ever want third-party WebGL extensions to ship GLSL that translates to WGSL at runtime, the right path is `naga-wasm` loaded on demand. This is a separate ~2-week spike and does NOT belong to the bundle-variant infrastructure. Tracked as **STUB-SHADER-NAGA-SPIKE** in the stub discussion.

---

## 2026-04-14 — Session 29 follow-ups (typing)

Session 29 added 13 co-located `.d.ts` files for JS classes that cross into WebGPU TS code, dropping `as unknown as` in `Renderer/` from 57 to 19 (-67%). The 19 survivors are a mix of legitimate escape hatches and easy remaining targets.

> **For the authoritative typing backlog (categorized by effort × payoff), see `NEXT_SESSION_HANDOFF.md` § "Remaining work toward a fully well-typed codebase".** The items below are the summary entries with stable IDs for cross-referencing.

### Completed (moved to WEBGPU_MIGRATION_STATUS.md)

- ~~TS-DEBT-4 partial resolution~~ — `as unknown as` casts dropped from 57 to 19 (Session 29 typing push)
- ~~Sidecar cache types~~ — `_ssrCache`, `_cloudCache`, `_weatherCache`, `_webgpuCache` now typed via `import()` references
- ~~`CesiumMatrix4` Float64Array lie~~ — replaced with structural interface
- ~~`isDestroyed` getter/method drift~~ — GraphicsContext abstract + WebGPUContext both converted to method form (matches upstream `destroyObject.js`)

### New follow-ups

- **TS-DEBT-5** — **Remaining 10 low-effort `as unknown as` casts**. Narrow `CesiumReadState.framebuffer` union (3 casts in WebGPUContext.ts), add `getFrameTimings?()` to PerformanceManager (1 cast), type `TypedArrayConstructor` union in `SharedResourcePool.ts` (2 casts), use `in` type guard in `loadCubeMapWebGPU.ts` (1 cast), write `ComponentDatatype.d.ts` (1 cast), type the WebGL stub escape hatches (3 casts). Effort: **~2-3 hours**, drops cast count from 19 → ~5.
- **TS-DEBT-6** — **Co-located `.d.ts` for high-value JS classes**: `DrawCommand`, `BoundingSphere`, `Ellipsoid`, `RenderState`, `ShaderProgram`, `VertexArray`, `Buffer`, `ContextLimits`, `ComponentDatatype`, `IndexDatatype`, `Sampler`. Highest payoff is `DrawCommand.d.ts` — unlocks tightening of `CesiumAnyDrawCommand` back to strict `CesiumBoundingSphere` for `boundingVolume`. Effort: **~4-6 hours across all ten**.
- **TS-DEBT-7** — **Tighten ambient opaque types** in `cesium-js-types.d.ts`: `CesiumOpaqueFramebuffer` → `Framebuffer`, `CesiumOpaqueVertexArray` → `VertexArray`, `CesiumOpaqueShaderProgram` → `ShaderProgram`, `CesiumOpaqueShaderSource` → `ShaderSource`, `CesiumOpaqueRenderState` → `RenderState`. Each depends on TS-DEBT-6 landing the underlying `.d.ts`. Effort: **~15 min per tightening once the .d.ts exists**.
- **TS-DEBT-8** — **Upstream `@private` → `@internal` sweep on cross-module JS methods**. CesiumJS uses `@private` to mean "not in the published API" — semantically TS-`@internal`. TypeScript correctly enforces `@private` as class-scoped, which currently requires co-located `.d.ts` overrides (`Context.d.ts` readPixels/readPixelsToPBO is the exemplar). A `@private` → `@internal` sweep makes several new `.d.ts` files redundant. Effort: **~2-3 hours for Renderer/, ~1 day for full engine**. Risk: zero runtime behavior change; purely doc-surface + TS-visibility.
- **TS-DEBT-9** — **`Record<string, unknown>` cleanup (11 remaining)**. Biggest wins: `GraphicsContext.cache` → branded per-subsystem interface; `createTexture/createBuffer` options → concrete types; `getRendererStatistics()` return → typed interface matching what WebGPUContext actually returns. Excludes legitimate cases (worker message payloads, WebGL stub dead-code). Effort: **~2 hours**.
- **TS-DEBT-10** — **`: unknown` parameter/return triage (~100 in Renderer/)**. Case-by-case. Many are genuinely heterogeneous (`DrawCommand.owner: unknown`), others are laziness. Suggested approach: triage per-file during other work (CLAUDE.md 10-line rule).
- **TS-DEBT-11** — **Re-tighten `CesiumAnyDrawCommand.boundingVolume`** to strict `CesiumBoundingSphere` once TS-DEBT-6 lands `DrawCommand.d.ts`. The current optional-fields shape was a workaround for JS-sourced DrawCommand instances inferring `{}`. Effort: **5 min after DrawCommand.d.ts exists**.

### Updates to existing backlog items

- **TS-DEBT-1** (WebGPUContext public underscore fields) — still open; unchanged.
- **TS-DEBT-2** (`getGPUBuffer()` helper) — still open; unchanged.
- **TS-DEBT-3** (`: any` annotations, 268 sites) — still open; Session 29 did not touch `: any`, only `unknown`. Next pass candidate.
- **TS-DEBT-4** (`as any` casts, 33 sites) — still open; Session 29 focused on `as unknown as` rather than `as any`. These are separate but related; same incremental approach applies.

### Session 29 architectural patterns (propagate when writing new TS)

- **Co-located `.d.ts`** — Preferred pattern when a TS file needs to interop with an untyped JS class. TypeScript's `allowJs: true, checkJs: false` means a sibling `.d.ts` overrides JS inference without tsconfig changes.
- **Interface merging for ambient interop** — For classes that match an existing ambient interface (`FrameState` ↔ `CesiumFrameState`), use `declare class X {} interface X extends AmbientShape {}` — single source of truth.
- **`@private` is a lie on cross-module JS methods** — if the method is called from outside the class, declare it `public` in the `.d.ts`. Long-term: convert JSDoc to `@internal`.
- **Sidecar caches typed via `import()` references** — each effect module exports its cache interface; `cesium-js-types.d.ts` references it via `import("./path").TypeName` rather than `unknown`.

---

## 2026-04-13 — Session 28 follow-ups

Session 28 completed the Option B material UBO split and achieved a clean TypeScript build (0 errors from both `tsc --noEmit` and `npx gulp build`). See `NEXT_SESSION_HANDOFF.md` § "What landed in Session 28" for details.

### Completed (moved to WEBGPU_MIGRATION_STATUS.md)

- ~~Option B Material UBO Split~~ — all shaders + WebGPUPolylineRenderer refactored
- ~~TypeScript build errors (202 → 0)~~ — cesium-js-types.d.ts rewrite, WebGPUContext fixes, esbuild async fixes
- ~~CLAUDE.md `any` ban rule~~ — added

### New follow-ups

- **TS-DEBT-1** — **Refactor WebGPUContext public underscore fields to use getters**. 30+ external access sites should call `context.device` not `context._device`. Mechanical search-and-replace. Effort: ~2 hours.
- **TS-DEBT-2** — **Add `getGPUBuffer()` helper** to eliminate `'buffer' in vb` narrowing at every vertexBuffer/indexBuffer access site. Effort: ~30 min.
- **TS-DEBT-3** — **Remaining `: any` annotations** (268 across 40 WebGPU .ts files). Now safe to fix incrementally since build is clean. Effort: ~2-3 hours.
- **TS-DEBT-4** — **Remaining `as any` casts** (33 across 10 WebGPU .ts files). Same incremental approach. Effort: ~1 hour.
- **ES6-VAR** — **`var` → `const`/`let` codemod** (~196 files). Mechanical. Effort: ~2-3 hours.
- **ES6-INDEXOF** — **`.indexOf()` → `.includes()` codemod** (~57 files). Codemod already exists. Effort: ~30 min.
- **ES6-ASYNC-AUDIT** — **Full async method audit** from ES6 class codemod. Fixed 15+ that caused esbuild errors, but more may exist without causing build failures. Effort: ~1 hour.
- **OPTION-B-BILLBOARD** — **WebGPUBillboardRenderer.js bind group split**. Still uses old monolithic pattern. Lower priority. Effort: ~2 hours.
- **OPTION-B-VISUAL** — **Visual smoke test of all 25 material types**. Zero runtime testing on Option B changes. Must verify before shipping. Effort: ~2 hours with Playwright.

---

## 2026-04-12 — Phase 5 + HDR follow-ups

The 2026-04-12 session landed WGF-4 (RTE assertions), WGF-1 (hardware clip-distances), WGF-3 (shader-f16 tonemapping), the HDR pipeline fix, auto-exposure compute, OPEN-5 fog fix, and OPEN-1 sky atmosphere guard. See `WEBGPU_MIGRATION_STATUS.md` § "Recent Progress (2026-04-12)".

### New follow-ups

- **WGF-1-EXPAND** — **Extend clip-distances to remaining shaders**. Today only the globe terrain pipeline has the hardware clip-distances variant. The 3 Primitive shaders (`PrimitiveBasicColor`, `PrimitivePhongColor`, `PrimitivePhongTexturedColor`) have the struct update but no vertex-side clip distance output. Models (`ModelPBRComplete.wgsl`) don't have clipping plane support at all yet. Effort: ~2 days per shader family. Trigger: when clipping planes are used on non-globe geometry.
- **WGF-1-INTERSECTION** — **Intersection-mode clipping with hardware clip distances**. The hardware `@builtin(clip_distances)` builtin is purely union semantics (any slot < 0 clips). Intersection mode (clip only when ALL planes clip) requires a different approach — likely a fragment-side check against all 8 clip distances passed as varyings. Effort: ~1 day. Trigger: a user reports intersection-mode clipping broken with `useHardwareClipDistances = true` (currently gated to union-only).
- **WGF-3-EXPAND** — **Extend shader-f16 to remaining post-process stages**. Today only `Tonemapping_f16.wgsl` exists. Candidates: ColorGrading, FXAA, BrightPass, GaussianBlur1D, BloomComposite. Each needs a hand-tuned f16 variant file + visual-diff validation against the f32 reference. Defer SkyAtmosphere/GroundAtmosphere (too close to f16 denormal range). Effort: ~0.5 day per shader. Trigger: profiler shows post-process as a bottleneck on mobile/laptop.
- **WGF-4-EXPAND** — **RTE assertions in remaining 5 camera packers**. Today assertions are in 3 of 8 packers (BufferPrimitiveRenderer, GlobeSurfaceRenderer, UniformGroupManager). Missing: CloudRenderer, EllipsoidPrimitiveRenderer, GaussianSplatRenderer, PointCloudRenderer, VoxelRenderer. Effort: ~1 hour. Trigger: any time someone touches those files.
- ~~**HDR-DISPLAY**~~ — **CLOSED (Batches 200 + 205 + 206).** `Scene.useHDRCanvasOutput` controls both producer-side (skip Tonemap + ColorGrading + FXAA when HDR is on) and canvas-side (auto-configure with `format: 'rgba16float' + colorSpace: 'display-p3' + toneMapping: { mode: 'extended' }`). WebGPU canvas reconfigures on toggle and survives resize / device-loss recovery. WebGL backend still ignores the flag (no `GPUCanvasContext` equivalent). The B200 audit caught the ColorGrading/FXAA SDR-assumption defect (B200-D1/D2) which the Batch 205 stage-skip gate fixes.
- **AUTO-EXPOSURE-TUNE** — **Auto-exposure adaptation rate tuning**. The default `adaptationRate = 1/(60×1.5) ≈ 0.011` matches WebGL's formula but may feel too slow or too fast depending on the scene. Expose `scene.autoExposureAdaptationRate` as a tunable. Effort: ~1 hour. Trigger: visual testing reveals the adaptation is perceptibly wrong.
- **OPEN-1-DIAGNOSE** — **Sky atmosphere shader/format diagnosis**. The try/catch + latch prevents infinite retry, but the actual compile failure needs browser-based debugging. Connect via Playwright, enable `useWebGPU`, check for shader compile errors in the console. Effort: ~1 hour. Trigger: next visual smoke-test session.

### Updates to existing backlog items

- **WORKER-5** — now also tracks `useHardwareClipDistances` + `useShaderF16` feature flag replication (implemented via `MSG_SET_FEATURE_FLAGS` in this session).
- **TAA design doc** — updated with HDR pipeline interaction note and f16 non-concern note.
- **CSM design doc** — updated with 240-byte EffectsUniforms struct constraint note.
- **FORK-19b (Jasmine spec coverage)** — add specs for `WebGPUAutoExposure` (luminance reduction math, temporal smoothing, readback), `WebGPUClipDistancePrecompute` (dPrime round-trip, finite sentinel), `WebGPURTEAssertions` (tolerance thresholds).

---

## 2026-04-11 — Items added/impacted by the Renderer Threading sweep

The 2026-04-11 sweep landed live FPS measurement, per-renderer worker
scaffolding, the Scene/CreditDisplay headless mode, the maxFps runtime
cap, and the worker-renderers test page. See
`WEBGPU_MIGRATION_STATUS.md` § "Recent Progress (2026-04-11)" for the
full inventory and `OPTION_B_SCENE_IN_WORKER.md` for the design + the
9-13 week roadmap to a fully-worker-hosted Scene. The items below are
**new follow-ups** carved out during the sweep, plus updates to
existing backlog items that this work changes.

### New follow-ups

- **WORKER-1** — **Phase 1 of Option B (worker Scene functional baseline)**. The headless Scene constructor + CreditDisplay worker-safety landed as part of this sweep. The next layer is verifying that `Scene.render()` actually completes a frame against an OffscreenCanvas without hitting another DOM dependency we missed. Likely candidates: the `Camera` constructor reading `canvas.clientWidth/clientHeight`, the `ScreenSpaceCameraController` calling `addEventListener` on the canvas, `loadImage()` paths using `new Image()` (need `createImageBitmap` instead). Effort: ~1 week. **Trigger**: any time someone wants real per-renderer FPS comparison via the worker test page. See `OPTION_B_SCENE_IN_WORKER.md` §§1-2.
- **WORKER-2** — **Soft-reset (Tier 2) host trigger**. The protocol message `MSG_RESET` and the worker-side handler are in place but no host-side method emits the message — Tier 2 of the 3-tier crash recovery is reserved for future use. When a need appears (e.g., a recoverable engine error that doesn't need a full canvas swap), add `host.softReset(reason)` and wire it to a host-detectable error class. Effort: ~half day. **Trigger**: a real soft-reset use case showing up in the bug log.
- **WORKER-3** — **Shadow state expansion**. Today the worker host's shadow state covers `lastView`, `requestRenderMode`, and `maxFps`. To make the worker path useful for actual scenes, the shadow state needs to record entity adds/removes, imagery/terrain providers, post-process stages, and any other host-side commands so a hard restart can replay them into the new worker. The protocol message constants for these (`MSG_ADD_ENTITY`, `MSG_REMOVE_ENTITY`, `MSG_SET_IMAGERY_LAYER`, `MSG_SET_TERRAIN`) already exist; the shadow recording + replay paths are stubs. Effort: ~2-3 weeks for the entity / primitive surface alone (each Cesium type needs a serializer pair — Cartesian3, Color, Property, Material, etc.). See `OPTION_B_SCENE_IN_WORKER.md` §3.2.
- **WORKER-4** — **WorkerScreenSpaceEventHandler**. `ScreenSpaceEventHandler` calls `addEventListener("mousedown", ...)` on its target canvas; OffscreenCanvas has no event interface even on Chromium. Worker camera control today is impossible. The fix is a `WorkerScreenSpaceEventHandler` that exposes the same `setInputAction(callback, type, modifier)` API but receives synthetic events from the host via `MSG_INPUT_EVENT` (already a defined message; today the worker handler logs and discards). Modifier-key tracking and double-click detection logic moves into the host's input forwarder. Effort: ~1-2 days. **Trigger**: WORKER-1 lands and the next obvious use case is "click on an entity in a worker pane".
- **WORKER-5** — **`maxFps` integration with Snapshot Mode**. `SnapshotModeService` already provides freeze/thaw lifecycle hooks. When a freezable subsystem is in the worker, the natural pattern is `host.setMaxFps(-1)` on freeze and `host.setMaxFps(null)` on thaw — pause the worker's render loop instead of just skipping its bundle reuploads. Effort: ~half day. **Trigger**: when a real worker-hosted scene lands and we want it to participate in snapshot mode.
- **WORKER-6** — **Per-frame postMessage cost audit**. The current host↔worker hot path uses `postMessage` for stats (one message every 125 ms, ~600 bytes, transferable Float32Array for the frame-time slice). For animation-heavy use cases (entity updates, hover picking) we might want to batch updates per frame (`MSG_BATCH_UPDATE`) or use object pools on both sides. This is the kind of optimization that should ONLY happen when measurements show it matters — the FPS counter use case is fine as-is. **Effort**: 1-2 days when needed. **Trigger**: animation-heavy scene profiling shows the postMessage cost on a flame graph.
- **WORKER-7** — **Naga-wasm in the worker**. The host application can now run multiple workers with their own engine chunks; the engine chunk includes `WebGPUNagaTranspiler` for runtime GLSL→WGSL transpilation. **Verify** that naga-wasm initialization works inside the worker context (it's just `WebAssembly.instantiateStreaming` against a wasm URL, but the URL resolution needs to be checked). Effort: ~half day spike. **Trigger**: the first user-supplied GLSL shader hits the worker path.
- **WORKER-8** — **Cross-browser worker render loop on Firefox/Safari**. The current `setTimeout(1000/60)` fallback in `RendererWorker.js` runs at ~60 Hz with sub-millisecond jitter on browsers where `requestAnimationFrame` isn't available in DedicatedWorker (Firefox, Safari as of 2026). On a 144 Hz display these workers won't ride the higher refresh rate. The canonical fix is for the main thread to post a `MSG_TICK` message on its own rAF — but that creates a hard coupling that defeats the worker isolation. **Decision**: leave as-is until a real Firefox/Safari user complains. Document in `OPTION_B_SCENE_IN_WORKER.md` §5.
- **WORKER-9** — **Visual regression for the worker test page**. The existing visual regression workflow targets `Apps/WebGPUTest/split-screen-comparison.html`. Once WORKER-1 lands and the worker panes actually render, add `worker-renderers.html` as a second baseline target — gives us cross-browser regression coverage for the worker path AND a way to detect FPS regressions over time (e.g., new shader features that drop the average below 55 fps). Effort: ~1 day. **Trigger**: WORKER-1 landed.

### Updates to existing backlog items

- **FORK-19b (Jasmine spec coverage)** — needs to grow to cover the new Services layer too. Add specs for: `PerformanceTracker.recordFrame` / `getLiveStats` / percentile math, `FpsOverlay` rendering against a mock data source (jsdom Canvas), `WorkerSceneHost` heartbeat + crash recovery + shadow replay (mocking `Worker`), `RendererWorker` headless Scene init path. Estimated +1 day on top of the existing FORK-19b estimate.
- **Performance benchmarking (Tier 4 #4.4)** — the worker hosts + per-renderer FPS overlays unblock real apples-to-apples WebGL-vs-WebGPU comparisons that were previously impossible because both renderers shared the main-thread JS pump. The benchmark task should now be: open `worker-renderers.html`, spawn one WebGL pane and one WebGPU pane, capture the 60s rolling stats from each FPS overlay's `getLiveStats()`, export. Measurable wins to verify: render bundles (50-80% CPU), GPU culler (5-20× for >50K objects), AtmosphereLUT consumer (fragment ray-march elimination), PointCloudLOD subgroups (2-4× on dense scenes).
- **Snapshot Mode Phases A-D** — the `maxFps` cap with mode `-1` (paused) is the natural worker-side hook. Phase A's bundle manager freeze flag remains main-thread, but a worker-hosted Scene's freezable can additionally call `host.setMaxFps(-1)` on freeze for full power saving instead of just skipping bundle reuploads. WORKER-5 above tracks the wiring.
- **OPTION_B_SCENE_IN_WORKER.md** — full design doc with the 9-13 week roadmap. Phase 1 of that doc (the headless Scene constructor + CreditDisplay) is done as part of this sweep. Phases 2-7 are the backlog items above (WORKER-1 through WORKER-9) plus the per-subsystem worker-safe variants the Option B doc inventories.

---

## 2026-04-09 — Items added by Phase 0 / Phase 1.1 / 1.2 work

These follow-ups were carved out during Phase 0 + Phase 1.2 implementation. None are blocking; each is captured here so they don't get lost.

- **NEW-9** — File an upstream PR against [`CesiumGS/quantized-mesh`](https://github.com/CesiumGS/quantized-mesh) to formally reserve **extension ID `0x05`** for the water classification extension. Phase 0.6 verification confirmed the ID is currently unassigned and the wire format is documented in `WATER_RENDERING_DESIGN.md §9.1`. **Must happen before water Phase 1 ships** to avoid racing another extension proposal. Effort: ~2 hours (PR draft + review).
- ~~**EllipsoidPrimitive feature renderer consolidation**~~ — ✅ **Resolved 2026-04-09 (Phase 1.x consolidation).** Extracted the Moon's bounding-cube + base uniform pack into `Renderer/WebGPU/WebGPUEllipsoidRenderer.ts`. Created the `csm_intersectEllipsoid.wgsl` chunk. Refactored `WebGPUEnvironmentRenderer.js` Moon path to use the shared helpers; file shrunk by ~140 lines. New 11-spec `WebGPUEllipsoidRendererSpec.js` covers the base packer end-to-end. See `WEBGPU_MIGRATION_STATUS.md` § "Phase 1.x consolidation". Stretch follow-up: migrate the orphan `WebGPUEllipsoidPrimitiveRenderer.ts` from its current screen-space-quad approach to use the bounding-cube path — ~1-2 days, deferred until that renderer gets a real consumer.
- **Render bundle env-pass executor full integration** — Phase 1.2c v2 wires `WebGPUDrawCommand.bundle` so any individual command can replay a `GPURenderBundle`. Future enhancement: collect bundles from a frustum's command list and submit a single `passEncoder.executeBundles([...])` call per pass, eliminating per-command CPU overhead entirely. Effort: ~1 day. Trigger: when a second renderer registers bundles (sky atmosphere, sun) so the batch path has at least 2 entries to amortize over.
- **Snapshot mode Phases A-D** — Per `SNAPSHOT_MODE_SPIKE_2026-04-09.md`. Phase 1.2c v2 already wires the moon as the first freezable consumer, but the broader work (bundle manager freeze flag, camera-delta auto-thaw, `markSnapshotDirty` event hooks, GPU memory pressure handling) is still pending. Effort: ~3 days. Trigger: after Phase 1.3 lands more bundle-eligible content. **2026-04-11 update**: when a worker-hosted Scene becomes a freezable, `host.setMaxFps(-1)` is the natural full-power-saving hook (pauses the worker render loop entirely instead of just skipping bundle reuploads). Tracked as **WORKER-5** in the 2026-04-11 section above.
- **C4 / C12 wording fixes** in `WATER_RENDERING_DESIGN.md` §4.5 / §10 / DP5 — Phase 0.6 verification found three small refinements: (1) parent encloses child *content* not child *volumes*, (2) `EXT_:_NAME` collision-disambiguation pattern available if ever needed, (3) describe `EXT_mesh_features` + `EXT_structural_metadata` as **paired** (feature IDs + property tables) rather than alternatives. Doc-only edits, ~30 minutes; do during water Phase 1.
- **Producer-format adapter real-data validation** — Phase 0.5 smoke-tested `ProducerListenerAdapter` against the real `listener_invalidations_25.2.txt` fixture (16 sets, 1116 entries, all 8 layers detected correctly). Still needs an end-to-end test with a real `Cesium3DTileset` consuming the feed and validating that the zero-flicker swap fires correctly for each entry. Effort: ~half session. Trigger: when a real producer + consumer pair is available to test against.
- **Volumetric fog spellcheck dictionary entry** — multiple `migration_doc/*.md` files reference "froxel" (frustum-voxel) which the editor's spellcheck flags. Add to project dictionary. Trivial.

---

## Table of Contents

0. [2026-04-11 — Renderer Threading sweep follow-ups (WORKER-1 to WORKER-9)](#2026-04-11--items-addedimpacted-by-the-renderer-threading-sweep)
1. [Active Bugs](#1-active-bugs)
2. [Tier 4: Testing, Performance & Quality](#2-tier-4-testing-performance--quality)
3. [Sorting System Remaining](#3-sorting-system-remaining)
4. [Picking System Remaining](#4-picking-system-remaining)
5. [Fork-Specific Tech Debt](#5-fork-specific-tech-debt)
6. [WebGL/WebGPU Feature Parity Gaps](#6-webglwebgpu-feature-parity-gaps)
7. [Dormant Compute Shaders](#7-dormant-compute-shaders)
8. [Modern WebGPU Feature Integrations (WGF)](#8-modern-webgpu-feature-integrations-wgf)
9. [Missing Visual Features (Industry Comparison)](#9-missing-visual-features-industry-comparison)
10. [WASM Expansion Opportunities](#10-wasm-expansion-opportunities)
11. [Performance Roadmap](#11-performance-roadmap)
12. [ES6 Modernization Backlog](#12-es6-modernization-backlog)
13. [Upstream Issues (Unaddressed)](#13-upstream-issues-unaddressed)
14. [Priority Remediation Order](#14-priority-remediation-order)

---

## 1. Active Bugs

| # | Bug | Severity | Status | Notes |
|---|-----|----------|--------|-------|
| **BUG-3** | **2D mode renders as sphere** | MEDIUM | **Likely Resolved (S18) — needs visual verification** | Globe terrain shader scene-mode branching landed in Session 18 (MORPHING/COLUMBUS_VIEW/SCENE2D/SCENE3D + planar position helpers). Camera UBO extended with `tileRectangle`, `southAndNorthLatitude`, `southMercatorYAndOneOverHeight`, `sceneMode`, `morphTime`, `useWebMercator`. **Action**: visual smoke test in 2D and Columbus View modes. |
| **BUG-5** | **"size is zero" at startup** | LOW | Intermittent | `Math.max(size, 4)` guards exist but edge cases remain. Hard to repro. |
| **BUG-6** | **Fill tile edge-case errors** | LOW | Mostly Fixed (S15) | Stride mismatch skip handles most cases; rare residuals. |
| **SHADOW-LAYOUT** | **Per-layout shadow cast pipelines** | MEDIUM | **Mostly resolved (2026-04-09)** | S25 added the stride safety net; the per-layout pipeline cache (`cache.castPipelines` Map keyed on variant name) and the public `registerShadowCastVariant(key, variant)` API are now in `WebGPUShadowMapRenderer.js`. Two ship variants: `rte24` (canonical RTE primitive, stride 24) and `p12` (single-vec3 stride 12, covers non-RTE models / debug primitives). Spec coverage: variant registry, stride inference, warn-once dedupe, and explicit `_shadowCastLayout` override (`Specs/Renderer/WebGPU/WebGPUShadowMapRendererSpec.js`, 11 specs). **Remaining**: quantized terrain variants (stride 8 + 12 with f16/u16 formats) — these need de-quantization in the cast shader and access to per-tile rectangle/height-scale uniforms, which is a meaningfully larger refactor. Tracked separately under **SHADOW-LAYOUT-QUANTIZED** below. |
| **SHADOW-LAYOUT-QUANTIZED** | Quantized terrain shadow cast variants | MEDIUM | New (carved out 2026-04-09) | Quantized terrain tiles use stride-8 (u16) and stride-12 (f16) vertex formats with per-tile rectangle + height-scale uniforms. Adding shadow cast variants for these requires the cast shader to de-quantize via the same uniform pack the surface shader uses, and the shadow uniform buffer needs to grow to carry tileRectangle / minMaxHeight. Estimated 2-3 days. Trigger: when quantized terrain shadow casting is requested by a real scene. Workaround today: terrain doesn't cast shadows (the safety-net stride filter skips it). |
| **BUG-11** | **Imagery tile gaps (dark patches)** | MEDIUM | **Re-scoped to narrow imagery-gap symptom (per `WEBGPU_DEBUGGING_LOG.md` § "BUG-11: Imagery tile gaps (dark patches)")** | **Narrow symptom:** at medium zoom, some tiles render satellite imagery while others show as dark patches (the base color `vec3(0.04, 0.04, 0.06)` with no imagery composited). The globe **demonstrably rasterizes** — this is a per-tile imagery-compositing gap, not a globe-geometry failure. Likely culprits per the debugging-log investigation steps: `texCoordsRect`/`translationAndScale` UV mapping (a `(0,0,0,0)` rect makes `texCoordsAlpha` return 0 → imagery invisible), missing `tileImagery.textureCoordinateRectangle` on the dark tiles, or `dayAlpha`/`nightAlpha` both 0 killing the composited alpha. See `WEBGPU_DEBUGGING_LOG.md:3982` for the full per-tile probe checklist (per-tile `texCoordsRect`/`translationAndScale` log → `dayNightAlpha` check → UV debug mode → debug imagery return). **SUPERSEDED framing (do not act on):** the earlier 2026-04-29 "globe geometry never rasterizes / canvas BLACK / depth uniformly 1.0 / merged with canvas-black-screen" classification has been re-scoped — the globe rasterizes; the residual is the narrow imagery-tile gap above. |
| **BUG-1** | **Stars/skybox not visible** | HIGH | **Fixed (S16) — still needs visual confirmation** | `panoramaCommandList` accumulation bug fixed; injection path in `SceneRenderer.js` confirmed sound by code audit. Has not been confirmed visually since the fix landed. |
| **BUG-7** | **Shadow cast pipeline** | MEDIUM | **Fixed + Limitation (see SHADOW-LAYOUT)** | Command collection, point light guard, bias path all fixed in S16. Stride filter added S25. |

### Visual Verification Backlog (in-browser confirmation needed)

These features have been *fixed in code* across Sessions 16-18 but never had a final visual smoke test. Each is one short manual session away from being closed:

1. **Stars/skybox** (BUG-1) — verify `[WebGPU] Frustum X: ENVIRONMENT=N` console messages show env commands present, then confirm starfield renders behind globe.
2. **Shadow casting** — open a model+terrain scene, confirm shadow on terrain.
3. **2D / Columbus View** (BUG-3) — switch scene mode toggle, confirm flat/columbus projections render without artifacts.
4. **Render bundle performance** — frame-time measurement with ≥8 globe tiles to confirm 50-80% CPU drop.
5. **Advanced renderers** — CloudCollection, VoxelPrimitive, GaussianSplat, PointCloud, EllipsoidPrimitive — all built with full shaders, none have been verified rendering end-to-end.

---

## 2. Tier 4: Testing, Performance & Quality

| # | Item | Effort | Status |
|---|------|--------|--------|
| 4.1 | **Expand Jasmine spec coverage** (FORK-19b) | 5-7 days | 10 spec files exist (Buffer, DrawCommand, ImageUpload, PrimitiveIndexUtils, RingBufferAllocator, ShadowMapRenderer, SubgroupUtils, Texture, ContextFactory, GraphicsContext, NagaTranspiler). Coverage is thin — 105+ WebGPU files, only ~50 tests total. Target: at least one spec per FR + per major utility module. **2026-04-11 update**: also add specs for the new Services layer — `PerformanceTracker` live histogram + percentile math, `FpsOverlay` rendering against a mock data source (jsdom Canvas), `WorkerSceneHost` heartbeat + crash recovery + shadow replay (mocking `Worker`), `RendererWorker` headless init path. ~+1 day on the original estimate. |
| 4.2 | **Automated visual regression (pixel-diff CI)** | ~~3-4 days~~ **CI workflow landed 2026-04-09** | `Tools/visual-regression/` scaffolding + `.github/workflows/visual-regression.yml` (workflow_dispatch trigger, threshold input, baseline `--update` toggle, artifact upload). Currently manual-trigger only because GitHub-hosted Linux runners don't ship a WebGPU adapter without extra setup; promote to `pull_request` trigger once that lands. **Remaining**: capture the initial baseline corpus + tune per-scene tolerance. **2026-04-11 update**: see WORKER-9 for the follow-up to add `worker-renderers.html` as a second baseline target once the worker Scene actually renders. |
| 4.3 | **Browser compatibility testing** | 3-5 days | Safari, Firefox WebGPU support. Edge tested; need cross-browser smoke + capability fingerprinting for the WGF features. **2026-04-11 update**: also verify the worker render loop fallback (`setTimeout(1000/60)` instead of `requestAnimationFrame`) works correctly on Firefox + Safari workers — see WORKER-8. |
| 4.4 | **Performance benchmarking** | 2-3 days | WebGL vs WebGPU vs WebGPU-compat comparison. Need fixed-camera scene + frame-time logging + report generation. Measurable wins to verify: render bundles (50-80% CPU), GPU culler (5-20× for >50K objects), AtmosphereLUT consumer (fragment ray-march elimination), PointCloudLOD subgroups (2-4× on dense scenes). **2026-04-11 update**: this task is now substantially easier — `worker-renderers.html` provides the side-by-side comparison harness and `WorkerSceneHost.getLiveStats()` returns the rolling 60s avg + 1% lows + 1% highs as a structured object ready for export. The benchmark workflow becomes: open the page, spawn one WebGL + one WebGPU pane, run a fixed camera path, capture each pane's `host.getLiveStats()` snapshot, export to CSV. WORKER-1 (Phase 1 of Option B) is the prerequisite — without it the worker panes don't render. |
| 4.6 | **Indirect drawing for 3D Tiles — production activation** | 2-3 days | Infrastructure built (`WebGPUIndirectDrawManager.ts`); opt-in fast path landed S26 via `executeBatchIndirect()` + `context.useIndirectDrawForTiles` flag. **Remaining**: identify a tile renderer with homogeneous pipeline+bind-group runs of ≥2 commands and flip the flag on for it. Most tile commands have unique per-tile bind groups so the win lives mainly in tightly-instanced point cloud / batched-table tile sets. |
| 4.8 | **Console noise reduction** | 1 day | ~12 `console.warn/error` calls in standalone modules should route through `context.log(level, ...)` for per-context prefixing. |

### Compute Engine Hardening (CS-* items from COMPREHENSIVE_AUDIT_2026_03_31)

| ID | Issue | Severity | Status |
|----|-------|----------|--------|
| **CS-1** | 4 dormant compute shaders need consumer wiring (HiZ, OcclusionTest, PointCloudSort, GPUSortKeys) | 🟡 Medium | Documented in §7. Activation tied to consumer system testing. |
| **CS-6** | `WebGPUPerformanceManager.dispatchCompute()` caches pipelines by task string but doesn't validate bind group compatibility | 🟡 Medium | Add bind group layout validation on dispatch path. |

---

## 3. Sorting System Remaining

| ID | Item | Effort | Status |
|----|------|--------|--------|
| **SORT-8** | Unit tests for sorting (30+ files) | 3-5 days | Not started. Tied to FORK-19b spec expansion. |
| **SORT-12** | OcclusionCulling GPU resources | Tied to testing | GPU resources still stub; conservative "assume visible" fallback active. Wire when Hi-Z compute shader activates (§7). |

---

## 4. Picking System Remaining

| # | Item | Effort | Status |
|---|------|--------|--------|
| 6.1 | **WGSL depth-to-color blit shader** for main scene depth readback | 1-2 days | Globe depth blit done (FORK-34); main scene depth blit still pending. |
| 6.2 | **Pick layer filtering** (bitmask to skip unpickable objects) | 1-2 days | Not started |
| 6.3 | **Octree pick acceleration** (pre-filter via octree) | 1-2 days | Not started; tied to SORT octree opt-in |
| 6.4 | **GPU multi-hit** (WebGPU only — storage buffer linked list) | 3-5 days | Future |
| 6.5 | **Rectangle selection** | 2-3 days | Future |
| 6.6 | **Pick priority** (`entity.pickPriority`) | 1-2 days | Future |
| 6.7 | **CPU hybrid pick** (geometric ray intersection) | 3-5 days | Future |

---

## 5. Fork-Specific Tech Debt

Items introduced by our WebGPU additions. 38 of 51 resolved through April 2026 (Session 27); 13 remaining.

### Remaining Items (Priority Order)

| ID | Issue | Severity | Effort |
|----|-------|----------|--------|
| **FORK-19b** | Expand WebGPU spec coverage (10 files, ~50 tests for 105+ source files) | HIGH | 4-6 days |
| **FORK-41** | 4 of 12 compute shaders awaiting activation (HiZ, OcclusionTest, PointCloudSort, GPUSortKeys) | MEDIUM | Per shader, 2-4 days each |
| **FORK-45** | Single global WASM arena shared across bridges | MEDIUM | 1 day | All 7 bridges share one `Mutex<Vec<u8>>` arena. Works today because bridges run sequentially, but a parallel-frame future would corrupt it. Per-bridge arena slots needed. |
| ~~**FORK-11**~~ | ~~`webgpuTypeHelpers.ts` has limited adoption~~ — **RESOLVED (Session 27)**: `cesium-js-types.d.ts` now provides the broader ambient type coverage that `webgpuTypeHelpers.ts` was trying to fill piecemeal. | ~~MEDIUM~~ | -- |
| **FORK-9** | `: any` casts in WebGPU TypeScript — was ~11 targeted, originally 66; reduced to ~32 via `cesium-js-types.d.ts` ambient type approach. Remaining casts are in complex call sites needing per-file refactoring. | MEDIUM | ~32 remain |
| **FORK-16** | WGSL preprocessor test page reimplements preprocessor | MEDIUM | 0.5 day | Test page has its own preprocessor; should consume the production `WGSLShaderPreprocessor`. |
| **FORK-20** | 29 test pages use 3 different module loading patterns | MEDIUM | 1 day | Standardize on a single import pattern across `Apps/WebGPUTest/`. |
| **FORK-21** | Test pages contain hardcoded inline WGSL shaders | MEDIUM | 0.5 day | Move to shared `.wgsl` files or import from production locations. |
| **FORK-22** | Several test pages are raw WebGPU demos | MEDIUM | 0.5 day | Refactor to use the production renderer where it exists, so the test page validates the real path. |
| **FORK-23** | No automated visual regression testing | MEDIUM | 2-3 days | See item 4.2 above. |
| ~~**FORK-4**~~ | ~~`WebGLCompatibilityStub.ts` maintenance~~ — **RESOLVED / Overhauled (Session 27)**: Proton-style texture, shader, and stencil translation layers added. The stub now handles full texture format mapping, shader compatibility shims, and stencil op translation rather than being a thin pass-through. Naga-wasm (Phase 6) remains the long-term retirement path for shader-related stubs. | ~~MEDIUM~~ | -- |
| **FORK-29** | Slang cross-compilation unused in production | LOW | -- | Slang infrastructure is still in the tree but no production shaders use it. Decision: remove or commit to it (blocked on naga-wasm spike outcome). |
| **FORK-30** | `@webgpu/types` pinned to `^0.1.69` | LOW | -- | Newer versions renamed `maxInterStageShaderComponents` → `maxInterStageShaderVariables` (handled in S26 with cast). Bump pin once we're confident in the new API surface. |

### Resolved Items (38 of 51) — For Reference

FORK-1 (device loss), FORK-2 (unused imports), FORK-3 (redundant shader loading), **FORK-4 (WebGLCompatibilityStub overhauled Session 27 — Proton-style texture/shader/stencil translation)**, FORK-5 (Phase D 28/28), FORK-6 (isWebGPU checks reduced), FORK-7 (depthRangeZeroToOne), **FORK-8 (zero `isWebGPUDrawCommand` references remain in `packages/engine/Source/Scene/` — verified 2026-04-09 audit follow-up; backlog entry was stale and referred to a line removed during S16 cleanup)**, FORK-10 (ts-expect-error), **FORK-11 (webgpuTypeHelpers limited adoption — superseded by `cesium-js-types.d.ts` ambient declarations, Session 27)**, FORK-12 (context-aware logging), FORK-13 (no debug logging), FORK-14 (CameraUniforms drift), FORK-15 (transitive struct deps), FORK-17 (mipmap stub now dispatches `WebGPUMipmapGenerator`; stub logs proper guidance), FORK-18 (DepthPlane implemented), FORK-19 (10+ spec files now exist: WebGPURingBufferAllocatorSpec, WebGPUShadowMapRendererSpec, WebGPUColorGradingSpec, etc. — rescoped as FORK-19b above), FORK-24 (Primitive.js cleanup), FORK-25 (7 renderers wired), FORK-26 (COUNT auto-computed), FORK-27 (abstract methods verified), FORK-28 (25/25 materials), FORK-31 (sorting integration complete), FORK-32+33 (multi-light scene.lights), FORK-34 (pick scene depth blit complete), FORK-35 (pick ID consolidated), FORK-36 (convenience pick APIs), FORK-37 (WASM destroy+free_buffer), FORK-38 (WASM version check), FORK-39 (SIMD detection), FORK-40 (all bridges destroy), FORK-42 (compute try/catch), FORK-43 (workgroup validation), FORK-44 (CPU fallback sort/LOD), FORK-46 (Rust OOM handling), NEW-1 (DynamicEnvironmentMapManager sync readPixels — non-issue, FR intercepts).

---

## 6. WebGL/WebGPU Feature Parity Gaps

### GLSL Backport Analysis — No Backports Needed

All WGSL shaders fall into three categories:

| Category | Count | Details |
|----------|-------|---------|
| **Ports of existing GLSL** | 12+ | Tonemapping, Atmosphere, SSAO, Bloom, DoF, Edge, Silhouette, IBL (3), FXAA |
| **Compute-only (impossible in WebGL)** | 8 | FrustumCull, HiZ, OcclusionTest, AtmosphereLUT, PointCloudSort/LOD, GPUSortKeys, WeatherParticles |
| **WebGPU-only enhancements** | 7+ | SSR, ProceduralClouds, DeferredGBuffer/Lighting, enhanced ocean, enhanced night, terminator glow |

### New Upstream GLSL — WGSL Forward-Ports Needed (Low Priority)

| GLSL Shader | Feature | WGSL Status |
|---|---|---|
| `computeTextureTransform.glsl` | `KHR_texture_transform` | **Done** (`csm_computeTextureTransform.wgsl`) |
| `ConstantLodStageFS/VS.glsl` | Distance-based constant LOD | Low priority — wire when constant-LOD extension support added to WebGPU model path |
| `EdgeVisibilityStageVS.glsl` | Edge visibility (glTF ext) | Low priority — wire when edge visibility WebGPU path added |

### Phase 2 Feature Completion (medium priority)

| # | Feature | Effort | WebGL? | Notes |
|---|---------|--------|--------|-------|
| 7 | **Built-in shader cache** | 1-2 days | Already works | Marked "not yet implemented" in `WebGPUShaderCache`. The cache infrastructure exists but doesn't pre-populate at init. |
| 8 | ~~**Deferred G-Buffer renderer**~~ | ~~5-7 days~~ | **Decision closed 2026-04-09** | The `DEFERRED_GBUFFER` FR key was already removed from `FeatureRendererKey.js` earlier in the session. The `DeferredGBuffer.wgsl` + `DeferredLighting.wgsl` reference shaders stay in the tree as documentation of the intended architecture — if a future "clustered forward" effort outgrows the current multi-light brute force, they can be picked up again. No FR key, no dispatcher, no consumer wire: the decision is "keep the reference shaders, skip the full implementation until a real many-lights scene justifies it". Tracked in STATUS as resolved. |
| -- | **General particle system** | 2-3 days | Already works | `ParticleSystem`/`ParticleEmitter` already auto-route through `BillboardCollection` (confirmed S20). No-op closure. |

---

## 7. Dormant Compute Shaders

Per the WIRING_AUDIT analysis, all dormant compute shaders have working fallbacks. They are performance optimizations to be wired when their consumer systems need them.

| Shader | Fallback | Activation Trigger | Effort | Status |
|--------|----------|-------------------|--------|--------|
| `HiZPyramid.wgsl` | Conservative "assume visible" stub in `OcclusionCulling.js` | Opt-in via `scheduler.occlusionCulling.enabled = true` | — | **ACTIVATED 2026-04-19 (audit fix)** — previous backlog entry was stale. Full end-to-end pipeline already wired: `ViewportExecutor.js` calls `beginFrame → testCommands → dispatchGPU → scheduleReadback` each frame; `OcclusionCulling.initialize(context, w, h)` delegates to the `HI_Z_OCCLUSION` feature renderer which allocates pyramid + SOA + visibility buffer. Remaining is opt-in + visual verification via a Sandcastle demo. |
| `OcclusionTest.wgsl` | Same as HiZPyramid | Activated alongside HiZ | — | **ACTIVATED 2026-04-19** — shares the same dispatcher path; the occlusion-test compute pass runs from `OcclusionCulling.dispatchGPU` after Hi-Z builds. |
| `PointCloudSort.wgsl` | Unsorted rendering works; `WasmPointCloudBridge.sortByDistance()` available | Wire when point cloud visible | ~~2-3 days~~ **Dispatcher landed 2026-04-09** | New `WebGPUPointCloudSortDispatcher` (`Renderer/WebGPU/WebGPUPointCloudSortDispatcher.ts`) self-contained sort wrapper: owns the SortParams UBO + sortKeys + indices buffers, handles power-of-two padding (sentinel keys sort to back), encodes the local phase (`localBitonicSort`) and the (k, j) global merge loop (`globalBitonicMerge`) into a single `sort(encoder, distSq, count)` call. Diagnostic counters via `getStatistics()`. Spec coverage of the pure-JS helpers (`nextPow2`, `floatToSortableUint`, ordering preservation) — 11 specs. **Remaining**: consumer integration in the point cloud collection path (one-line `if (perfMgr.shouldUseGPUPointCloud(N)) sortDispatcher.sort(...) else wasmBridge.sortByDistance(...)`). |
| `GPUSortKeys.wgsl` | JS multi-level comparators in Scene.js (always active) | Wire when >50K commands per frame | 2-3 days | **WGSL complete + dispatcher exists** in `WebGPUPerformanceManager.dispatchGPUSortKeys()`. **Most incomplete**: needs SOA buffers for command metadata (centerX/Y/Z, layer, priority, materialId) allocated in Scene + a bind group factory + integration into RenderScheduler's sort pipeline. ~400-500 LOC. Lowest priority unless a real scene exceeds 50K commands. |

**Already activated** (see STATUS): PolygonSignedDistance, BrdfLutGenerate, IrradianceConvolution, RadiancePrefilter, FrustumCull (with subgroup variant), AtmosphereLUT (dispatch + consumer wired S26), PointCloudLOD (subgroup dispatcher S26), WeatherParticles (compute + render S18).

---

## 8. Modern WebGPU Feature Integrations (WGF)

| # | Feature | WebGPU API | CesiumJS Impact | Effort | Status |
|---|---------|-----------|-----------------|--------|--------|
| **WGF-3** | **WGSL `texture_and_sampler_let`** | Assign texture/sampler to `let` variables | Cleaner shader code, prepares for future bindless textures | 0.5-1 day | **No work needed** (S21 audit) — sampler-as-let pattern already used in `sampleImagery()`. |
| **WGF-4** | **Uniform Buffer Standard Layout** (`uniform_buffer_standard_layout`) | Removes std140 padding requirements | Smaller uniform buffers (camera, tile, effects). Currently we manually pad with `_pad0`, `_pad1`. Standard layout eliminates ~20% of UBO waste. | 1-2 days | Not started |
| **WGF-7** | **Enhanced Texture Formats** (Tier 1 & 2 storage textures) | Broader storage usage on rgba16float, rg32float; Tier 2 read-write storage | Compute shader outputs (atmosphere LUT, SDF, Hi-Z buffer) can use richer formats; read-write enables single-pass algorithms | 1-2 days | **No immediate work needed** (S21 audit) — current 8 storage-write shaders already use the right format for their kernel output. Wire when a new compute shader needs the richer format. |

**Already landed** (see STATUS Section 2): WGF-1 Subgroups (FrustumCull `mainSubgroups` + PointCloudLOD `computeMainSubgroups` + dispatcher), WGF-2 Transient Attachments (`WebGPUFramebufferManager` reads `TRANSIENT_ATTACHMENT` flag with feature detection + `storeOp: "discard"`), WGF-5 Texture Component Swizzle (S21: dynamic vector subscript replaces if-else chain), WGF-6 Primitive Index (`csm_primitiveIndex.wgsl` chunk + `WebGPUPrimitiveIndexUtils.ts` + production wiring through `Scene.debugShowTriangulation`), WGF-8 EXIF/Orientation Image Upload (S21: `WebGPUImageUpload.ts` + `createTextureFromImageAsync()`).

### WebGPU API Features Detected But Not Used

| Feature | Status | Opportunity |
|---------|--------|-------------|
| `shader-f16` | Detected, unused | Half-precision math in shaders → 2× bandwidth, 2× ALU on supported GPUs |
| `dual-source-blending` | Detected, unused | True OIT without MRT — single-pass weighted blended OIT |
| `indirect-first-instance` | Detected, unused | GPU-driven rendering with per-instance data indexing |
| `bgra8unorm-storage` | Detected, unused | Direct compute write to swap chain format |
| `clip-distances` | Detected, unused | Hardware clipping planes (vs fragment discard) — better perf |
| `timestamp-query` | Wired in profiler | Currently infra-only; enable for automated perf regression tests |
| `float32-filterable` | Used for depth | Could also be used for HDR texture sampling |

### WebGPU Features Not Yet Detected/Requested

| Feature | Status | Opportunity |
|---------|--------|-------------|
| `chromium-experimental-multi-draw-indirect` | Not detected | Single API call for N draw commands — massive CPU reduction. Pairs with `WebGPUIndirectDrawManager`. |
| `chromium-experimental-read-write-storage-texture` | Not detected | Read-write textures in compute (in-place image processing) |
| `chromium-experimental-unorm16-texture-formats` | Not detected | 16-bit normalized textures for compact terrain height data |
| `GPUExternalTexture` | Not used | Zero-copy video texture import (video draping on terrain) |

---

## 9. Missing Visual Features (Industry Comparison)

These features are standard in Babylon.js / Three.js / PlayCanvas / Filament / Bevy and would close visual quality gaps. None are blocking, all are additive.

### Critical Missing — Available in ALL Major WebGPU Engines

| Feature | Industry Status | Our Status | Impact | Effort |
|---------|----------------|------------|--------|--------|
| **Temporal Anti-Aliasing (TAA)** | All engines | 🟡 Slice 1 shipped (RTE motion vectors + depth reprojection; static terrain + static primitives). Slices 2-4 pending: per-model MRT motion, sky reprojection, CSM+TAA interaction verification, WebGL parity. | Far superior to FXAA for moving scenes | Slice 1 done; ~2-3 days remaining for 2-4 |
| **Cascaded Shadow Maps (CSM)** | All engines | 🟡 Slices 1 + 2a + 2b + 2c shipped. Slice 1: 4 cascades, RTE-aware cast+receive VPs, per-cascade slope-scaled bias, globe terrain + phong primitive (textured) receivers. Slice 2a (2026-04-18): all cast-variant pipelines unlocked (rte24/p12/modelP12/modelInstanced/modelInstancedSB/modelSkinned/quantized12). Slice 2b (2026-04-18): texel-snap stabilization + PrimitivePhongColor CSM receive. Slice 2c (2026-04-18): **ModelPBRComplete CSM receive** — glTF models now receive cascaded shadows via a new `@group(7)` effects bind group. Remaining: PBR simple/textured receivers, 20 Material Lit receivers (Slice 2d mechanical), altitude-adaptive splits, moon dual-light, 3D Tiles per-tile culling, WebGL parity. | Efficient shadow rendering for large outdoor scenes | Slices 1 + 2a + 2b + 2c done; ~2 days remaining for rest |
| **Motion Blur** | Babylon, Three.js, PlayCanvas | ❌ Missing | Cinematic quality for camera/object movement | 2-3 days |

### Important Missing — Available in Most WebGPU Engines

| Feature | Industry | Our Status | Impact | Effort |
|---------|----------|------------|--------|--------|
| **Volumetric Lighting/Fog** | Babylon, Three.js, Unreal | ❌ Missing | God rays, volumetric clouds, atmospheric scattering | 4-5 days |
| **Color Grading / LUT** | Babylon, Three.js | ❌ Missing | Film-quality color correction | 1-2 days |
| **Contact Shadows** | Babylon, Three.js | ❌ Missing | Small-scale ground contact shadows | 2-3 days |
| **Subsurface Scattering (SSS)** | Babylon, Filament | ❌ Missing | Realistic skin, foliage, marble rendering | 3-4 days |
| **GPU Particle System (general)** | Babylon, Three.js, PlayCanvas | ⚠️ Weather only | Compute-based particles — fire, smoke beyond weather | 3-5 days |
| **Clustered/Tiled Deferred Lighting** | Standard | ❌ Missing | Efficient many-lights (our multi-light is brute force) | 4-5 days |
| **Light Probes / SH Lighting** | Standard | ❌ Missing | Pre-baked indirect lighting | 3-4 days |
| **Parallax Occlusion Mapping** | Standard | ❌ Missing | Depth on flat surfaces without extra geometry | 2-3 days |

### Nice to Have — Cutting-Edge

| Feature | Status | Notes |
|---------|--------|-------|
| **Ray Tracing** | Not in WebGPU spec yet | Coming in future spec revisions |
| **Mesh Shaders** | Not in WebGPU spec yet | Google has proposals |
| **Variable Rate Shading (VRS)** | Not in WebGPU spec | Available in DirectX 12/Vulkan |
| **Procedural Sky / Dynamic Clouds** | Babylon, Unreal | We have static atmosphere only; volumetric clouds would integrate with `ProceduralClouds.wgsl` |
| **Ocean FFT** | Three.js, Unreal | We have multi-octave wave normals; FFT would be a quality bump |
| **Terrain Tessellation (GPU)** | Native engines via tess shaders | WebGPU has no tessellation stage — use compute + indirect |

### CesiumJS-Specific Missing Features

| Feature | Why Important | Effort | Priority |
|---------|---------------|--------|----------|
| **Procedural textures for globe** | Cloud layers, aurora — future CesiumJS feature | 3-5 days | Low |
| **Terrain blend/splat mapping** | Multi-texture terrain at close range | 3-5 days | Low |
| **Vector tile rendering** | Upstream #2132 — largest open request. Buffer primitives done, full vector tile path remaining | 5-10 days | Low |

### Weather Effects Not Yet Implemented

`WeatherParticles.wgsl` covers rain/snow/fog/hail GPU particle simulation + render pass (S18). Open weather features:

| Effect | Approach | Effort | Priority |
|--------|----------|--------|----------|
| **Volumetric Fog** | Ray-march compute shader | 4-5 days | Medium |
| **Volumetric Clouds** | Noise-based ray march on sky hemisphere | 5-7 days | Medium |
| **God Rays** | Radial blur post-process from sun position | 2-3 days | Medium |
| **Wet Surfaces** | PBR roughness reduction + darkening when raining | 1-2 days | Low |
| **Aurora Borealis** | Procedural shader on sky dome (noise + curtain function) | 2-3 days | Low |
| **Sandstorm/Dust** | GPU particles + distance fog tinting | 2-3 days | Low |
| **Lightning** | Custom ray + bloom | 2-3 days | Low |

#### CesiumJS-Specific Weather Considerations
1. **Planetary scale** — weather must be geographically zoned, not screen-space
2. **Altitude-aware** — snow above freezing, rain below; cumulus ~2000m, cirrus ~8000m
3. **Time-of-day integration** — weather interacts with day/night cycle
4. **Terrain interaction** — particles collide with actual terrain elevation
5. **Performance at globe scale** — fade out at orbital zoom levels
6. **Data-driven** — future integration with weather APIs (OpenWeatherMap, NOAA)

---

## 10. WASM Expansion Opportunities

| Target | Current Approach | WASM Benefit | Estimated Speedup | Effort |
|--------|-----------------|-------------|-------------------|--------|
| **glTF decode** | JS in `GltfLoader.js` | SIMD accessor decode, mesh optimization | 2-4× for large models | 3-5 days |
| **Batch transform update** | JS per-entity `Matrix4.multiply` | SIMD f32x4 batch multiply | 3-5× for >1K entities | 2-3 days (partially done in `matrix_batch.rs`) |
| **Terrain mesh stitching** | JS in `TerrainMesh.js` | SIMD edge matching, skirt generation | 2-3× | 2-3 days |
| **Quadtree traversal** | JS in `QuadtreePrimitive.js` | Batch tile selection with SOA layout | 2-3× for deep quadtrees | 3-4 days |
| **3D Tiles traversal** | JS in `Cesium3DTilesetTraversal.js` | Batch bounding volume tests | 3-5× for large tilesets | 4-5 days |
| **KTX2 super-decompression** | WASM `basis_transcoder` exists | Add ASTC/ETC2 → BC transcode for WebGPU | 1.5-2× memory savings | 2-3 days |

---

## 11. Performance Roadmap

### Architecture-Level Performance (Built or Wired — see STATUS for activation status)

| Opportunity | Current State | Expected Benefit | Effort |
|------------|--------------|------------------|--------|
| **Bind group caching** | Recreated frequently | Cache by content hash → 50% fewer creations | 2-3 days |
| **Texture atlas consolidation** | Separate textures per billboard/point | Single atlas → 30-50% fewer draw calls | 3-4 days |
| **Command buffer reuse** | New encoder per frame | Double-buffer encoders | 1-2 days |
| **Multi-draw indirect** | Individual `drawIndirect()` calls | Single `multiDrawIndirect()` (Chromium experimental) | 1-2 days |

### Shipped Infrastructure (Session 27)

| Item | Status | Integration |
| ---- | ------ | ----------- |
| **MaterialUniformBuffer** | Shipped — `MaterialUniformBuffer.js`, Float32Array backing, auto-layout, dirty tracking | Wired into `Material.js` via `MaterialHelpers.js`; WebGPU fast path in `WebGPUPrimitiveCommands.js` |

### Material UBO Architecture (Option B) — Functional, field-audit outstanding

**Status:** Split layout landed in Session 28 (2026-04-13). Shaders use
`group(0)=CameraUniforms`, `group(1)=MaterialUniforms`, `group(2)=Texture`,
`group(3)=Effects`. `WebGPUPrimitiveCommands.js` and `WebGPUPolylineRenderer.js`
both source material data from `MaterialUniformBuffer.gpuData` directly. Billboard
collections retain their monolithic layout by design (they don't consume the
Material fabric).

| Sub-task | Status | Effort |
| --- | --- | --- |
| MaterialUniformBuffer.js (Float32Array + alignment + facade) | **Done** | — |
| WGSL shader struct split (49 shaders) | **Done** | — |
| WebGPUPrimitiveCommands.js renderer refactor | **Done** | — |
| WebGPUPolylineRenderer.js renderer refactor | **Done (Session 28)** | — |
| Texture binding group(2) shift | **Done (Session 28)** | — |
| `.js` shader wrapper regeneration | **Done** (covered by `gulp build`) | — |
| Field name alignment audit (WGSL ↔ JS fabric) | **Partially done** — material-by-material verification still needed | ~1 day |
| Visual verification all 25 material types | Not started | ~1 day |
| **Total remaining** | | **~2 days** |

**Architecture reference:** WebGPUModelRenderer.js uses the same separate-material-UBO pattern (group 1, 320 bytes) that the primitive/polyline refactor converged on.

**Key risk:** Field name mismatches between WGSL `MaterialUniforms` and JS fabric templates cause silent data corruption. Each material type's shader struct must be verified against its `Material.js` fabric definition — this is the remaining audit work.

### New Compute Shader Opportunities

| Target | Benefit | Workgroup Pattern | Effort |
|--------|---------|-------------------|--------|
| **Terrain LOD selection** | GPU-side tile visibility + LOD decision | 1D dispatch over tile array | 2-3 days |
| **3D Tile GPU culling** | Bounding volume hierarchy test on GPU | Hierarchical dispatch | 3-4 days |
| **General particle simulation** | Fire, smoke, custom particles via compute | Update + emit + compact pattern | 3-5 days |
| **Ocean FFT** | Realistic water simulation | 2D FFT butterfly dispatches | 4-5 days |
| **Gaussian Splat sort** | Real-time depth sorting for splats | Radix sort on GPU (similar to PointCloudSort) | 2-3 days |

---

## 12. ES6 Modernization Backlog

~595 files total in scope. ~499 completed (424 via jscodeshift codemod in Session 27 + prior ~75 manual). ~96 files remain.

### Completed (~499 files)

| Directory | Status |
|-----------|--------|
| **Renderer (29/29)** | All JS files converted |
| **Scene high-priority (24+)** | All WebGPU-blocking files converted |
| **DataSources high-priority (8)** | All sorting-related files converted |
| **Appearance classes (4)** | All appearance files converted |
| **Bulk codemod (424 files — Session 27)** | jscodeshift codemod applied: `var`→`const`/`let`, prototype inheritance→ES6 class, `Object.defineProperties`→getters/setters, string concat→template literals |

### Session 27 dependency cleanup (completed)

- **urijs removed** — replaced with native `URL` API across 12 files (0 urijs imports remaining in `packages/engine/Source/`)
- **karma-ie-launcher removed** — IE-specific test runner dependency dropped from devDependencies
- **.indexOf() → .includes()** — complete sweep, 0 remaining instances in engine source
- **InfoBox.js XSS fix** — DOMPurify integration for user-supplied HTML content

### Remaining (~96 files — complex patterns)

These files were skipped by the codemod due to patterns requiring manual judgment:

- **Method alias patterns** (~20 files): `Foo.prototype.bar = Foo.prototype.baz` aliases that become static methods or need refactoring
- **Multi-class files** (~15 files): files exporting more than one constructor — need splitting or restructuring
- **Partial conversions** (~30 files): files where the codemod detected ambiguous inheritance chains (mixins, dynamic prototype assignment)
- **Performance-critical math** (~16 files): Cartesian2/3/4, Matrix2/3/4, Quaternion, BoundingSphere — audit against upstream v1.139 before re-doing; some already ported upstream
- **urijs in Specs** (~8 files in `Specs/`): test files still importing urijs — low priority, does not affect production build

**Rule:** Never modernize files you're not otherwise touching. Always modernize if making >10 lines of changes.

---

## 13. Upstream Issues (Unaddressed)

42 open upstream issues that our fork has NOT addressed. Top priorities:

### Camera & Navigation (7 issues)
Camera boundary/constraints (#4802), Follow-camera (#5241), Mouse wheel zoom jumpy (#4537), Scroll zoom high refresh (#12187), KML flyTo underground (#4327), Touch controls (#4363), computeViewRectangle 2D/CV (#4346)

### Entity & DataSource (7 issues)
Picking priority overlapping entities (#1592), CLAMP_TO_GROUND billboard (#4776), Dynamic boxes tracking (#5164), Scene ready event (#4422), Custom PositionProperty (#9491), Clamped polygons mobile (#9702), WMS GetFeatureInfo position (#9363)

### Rendering & Graphics (6 issues)
Blinking entity shader update (#12532), Fit texture coords (#4164), Material difference 2D (#9853), Animated billboards (#2319), disableDepthTestDistance picking (#6840), Extruded geometry terrain (#4743)

### Other Categories
Memory Leaks (6), 2D/Columbus View (4), 3D Tiles (5), Terrain & Imagery (3), Model/glTF & Build (4), Legacy Code Debt (5)

---

## 14. Priority Remediation Order — Path to WebGL Parity

> **Updated April 8, 2026.** All Tier 1-3 work is complete (see STATUS sections 2-3). Focus now: visual verification, expand testing, activate remaining dormant compute shaders, close visual feature gaps.
>
> **⚠️ STALE FRAMING (HEAD = Batch 185, May 30 2026).** The "all Tier 1-3 complete / focus is just visual verification" framing below is the April-8 snapshot and is now ~120 feature batches out of date — substantial new feature work (CSM, TAA, classification, BufferPolygon, the renderer-wide log-depth epic, and much more) has landed and continues since this phased plan was written. Treat the phase ordering below as historical; the **current** work frontier is tracked in [`WEBGPU_EXECUTION_ROADMAP.md`](WEBGPU_EXECUTION_ROADMAP.md) and the "Recent progress — Batches 179–185" section at the top of this file.

### Phase 1: Visual Verification & Bug Closure (1-2 weeks)

1. **Visual smoke test all S16/S17/S18 fixes** — Stars/skybox, shadow casting, render bundle perf, advanced renderers (Cloud/Voxel/GaussianSplat/PointCloud/Ellipsoid), 2D/Columbus View modes
2. **BUG-11 imagery** — Use the probe checklist in §1 (existing diag logs first, then alpha/texCoordsRect/cache hypotheses)
3. **SHADOW-LAYOUT** — Per-vertex-layout shadow cast pipeline cache (1-2 days)
4. **BUG-5/6 edge cases** — Reproduce + close
5. **FORK-8** — Last residual `isWebGPUDrawCommand` check in Scene.js

### Phase 2: Testing & Quality (4-5 weeks)

6. **FORK-19b** — Expand Jasmine spec coverage to 1 spec per FR + per major utility (~50 → ~150 tests)
7. **Visual regression CI** — Activate `Tools/visual-regression/` with baseline corpus + tolerance config
8. **Browser compatibility** — Safari, Firefox WebGPU testing matrix
9. **Performance benchmarking** — Fixed-camera scenes + frame-time logging; verify the perf wins from S16/S17/S26 (render bundles, GPU culler, atmosphere LUT, point cloud subgroups)

### Phase 3: Dormant Compute Shader Activation (2-3 weeks)

10. **HiZ + OcclusionTest** — Wire into ViewportExecutor for occlusion culling
11. **PointCloudSort** — Wire when point cloud collection visible (depth sort for translucent points)
12. **GPUSortKeys** — Wire when scene exceeds 50K commands (replace JS comparators on the hot path)

### Phase 4: Visual Quality Closure (4-6 weeks)

13. **TAA** — Temporal anti-aliasing as WGSL post-process. 🟡 Slice 1 shipped (Session 34 — RTE depth reprojection). Slices 2-4 remaining.
14. **CSM** — Cascaded shadow maps for outdoor scenes. 🟡 Slice 1 shipped (Session 33 — RTE cascade VPs + per-cascade slope bias). Slices 2-4 remaining.
15. **Volumetric fog/lighting** — God rays, scattering
16. **Color grading** — LUT-based color correction
17. **Subsurface scattering** — Skin/foliage rendering
18. **Clustered lighting** — Efficient many-lights for urban scenes
19. **Vector tile rendering** — Build on top of Buffer Primitive renderers
20. ~~Deferred G-Buffer — closed 2026-04-09 (FR key removed; reference shaders kept)~~

### Phase 5: Modern WebGPU Feature Adoption (2-3 weeks)

21. **WGF-4 Standard Layout UBOs** — Remove manual std140 padding, ~20% UBO size reduction
22. **`shader-f16`** — Wire half-precision math in selected fragment shaders for 2× bandwidth/ALU
23. **`dual-source-blending`** — Single-pass weighted blended OIT
24. **`clip-distances`** — Hardware clipping planes (vs fragment discard) for clipping perf
25. **`chromium-experimental-multi-draw-indirect`** — Pair with `WebGPUIndirectDrawManager` for single-call N-draw rendering

### Phase 6: Naga-wasm Spike Productionization (1 week, optional)

26. **Naga-wasm bind-set remapping** — Naga emits raw `@group/@binding` from GLSL `layout(binding=...)`; need a layout reflection step
27. **Vertex attribute location remapping** — Stride/format normalization between source GLSL and consumer pipelines
28. **Specialization-constant injection** — Map GLSL `#define`s to WGSL pipeline-overridable constants
29. **Replace WebGL stub for shaders Naga handles** — Incremental retirement of `WebGLCompatibilityStub.ts`

### Phase 7: Long-Tail Cleanup (Ongoing)

30. **ES6 modernization** — Continue under the "10-line touch rule"
31. **Console noise reduction** (4.8) — Route bare `console.warn/error` through `context.log()`
32. **Test page consolidation** (FORK-20/21/22) — Standardize loading patterns + share shaders
33. **Upstream sync** — Periodic sync with `CesiumGS/cesium` main
34. **Upstream issue triage** — Pick off the 42 open issues most relevant to WebGPU users

---

*This backlog supersedes all previous versions. For per-session bug fix detail, completed work, and architecture, see `WEBGPU_MIGRATION_STATUS.md`. The legacy `WIRING_AUDIT_2026_04_02.md`, `COMPREHENSIVE_AUDIT_2026_03_31.md`, and `WEBGPU_DEBUGGING_LOG.md` documents are preserved for historical reference but their open items have been pulled forward into this file and STATUS.*
