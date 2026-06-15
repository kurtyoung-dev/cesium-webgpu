# Cascaded Shadow Maps (CSM) — Design Document

**Status:** Slice 1 SHIPPED (Sessions 32-33). Slices 2-4 pending.
**Created:** 2026-04-09
**Last updated:** 2026-04-18 — Slice 1 shipped with RTE precision fix + per-cascade slope-scaled depth bias (both beyond the original Slice 1 plan — see "Slice 1 shipped additions" below).
**Owner:** WebGPU migration

## Implementation slices

Full CSM integration with every Cesium feature (RTE, globe, 3D Tiles, models, orbital/space, moon dual-light, WebGL parity) is a 3–5 week effort. To deliver visible progress each session without half-finished code, the work is split into four vertical slices. Each slice ships a working CSM that can be visually verified; later slices add capabilities without breaking earlier ones.

| Slice | Scope | Duration | Status |
|---|---|---|---|
| **Slice 1** | 4 cascades, sun-directional only, RTE stride-24 cast only, **globe terrain + phong primitive receivers**, ground-level viewing (no altitude-adaptive splits, no orbital regime). Scene toggle off by default. **SHIPPED** with two material upgrades over the original plan: **(a) RTE-aware cascade VPs** (cast + receive math both consume camera-relative position — no FP32 world-space reconstruction at Earth scale), **(b) per-cascade slope-scaled depth bias** (replaces hardcoded 0.005 with `max(minBias[i], maxSlopeBias[i] * (1 - dot(N, L)))` that scales with cascade sphere radius). | 2 sessions (32+33) | **SHIPPED 2026-04-18** |
| **Slice 2** | Texel-snap stabilization, blend bands (already present from Slice 1), **all per-vertex-layout cast pipelines** (p12, quantized12, modelP12, modelInstancedSB, modelSkinned), **primitive lit receiver** (ModelPBRComplete.wgsl + lit-primitive shaders). | 1 session | 🟡 Mostly shipped — 2a (cast variants), 2b (texel-snap + PhongColor), 2c (ModelPBRComplete receive) all SHIPPED 2026-04-18; 2d (PBR simple/textured + 20 Mat-Lit variants) remains |
| **Slice 3** | **Altitude-adaptive splits** (derive from camera altitude above ellipsoid; orbital regime collapses to a single large cascade when altitude > ~500 km), **moon dual-light cascades** (reuses existing moon LUT infrastructure), VSM-style soft shadows via rg32float variance texture. | 1 session | Pending |
| **Slice 4** | **3D Tiles integration** (per-tile cascade culling, frustum-intersection gating), snapshot-mode freezable contract, **WebGL parity path**, full visual verification pass, spec coverage completion. | 1 session | Pending |

## Slice 1 shipped additions (beyond original design)

Two precision/correctness fixes were folded into Slice 1 once audit work surfaced them. Both are required for CSM to function correctly at Earth scale, not just stretch goals:

### RTE-aware cascade VPs

The original plan assumed feeding world-space fragment positions into world-space cascade VPs on the receive side. At Earth radius (6.37M m) FP32 has ~0.76m ULP, so `worldPos = positionHigh + positionLow` quantizes to sub-meter acne on cascade 0 (10m extent). The cast side had a matching but distinct bug: `ShadowMap.wgsl:35-39` multiplies its `lightViewProjection` UBO field by an **RTE-relative** vector, but our `WebGPUCSMRenderer.renderCastPass` was writing a world-space VP into that slot — producing empty cascade textures (masked in Slice 1 only by the `rte24`-only filter; Slice 2 cast-variant unlock would have surfaced this loudly).

**Fix (Session 33, shipped):**

- New `applyCameraTranslationToVP(vpWorld, cameraWC) → VP_RTE` helper in [WebGPUCSMRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUCSMRenderer.ts) composes `VP_RTE = VP_world * T(+cameraWC)` in FP64. The camera translation cancels into VP's translation column cleanly before any FP32 storage.
- Every cascade now carries both `viewProjection` (world-space, for diagnostics) and `viewProjectionRTE` (what gets uploaded to both cast + receive UBOs).
- Receive shaders feed the RTE-precise camera-relative position directly. [PrimitivePhongTexturedColor.wgsl](../packages/engine/Source/Shaders/WebGPU/Primitive/PrimitivePhongTexturedColor.wgsl) uses the existing `eyePosition` varying; [GlobeTerrain.wgsl](../packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl) adds a new `v_positionRTE` varying populated in SCENE3D (zeroed elsewhere — CSM is SCENE3D-gated anyway).

**Result:** precision drops from ~1m FP32 reconstruction error to sub-micrometer. Sanity-checked via Node script: `VP_RTE * eyePos ≡ VP_world * worldPos` bit-exact at camera position (6378137, 0, 0).

### Per-cascade slope-scaled depth bias

Original design deferred bias tuning to "Slice 2" with a hardcoded `0.005` placeholder. That constant only works at one cascade scale — cascade 3 (kilometer extent) peters-pan, cascade 0 (tens of meters) acnes. Slope-scaled + per-cascade bias is the principled formulation and it costs nothing to add at Slice 1 scope.

**Fix (Session 33, shipped):**

- `CSMParams` UBO gained `cascadeMinBias: vec4<f32>` and `cascadeMaxSlopeBias: vec4<f32>` at float offsets 72/76 (per the layout comment at `WebGPUCSMRenderer.ts:300-305`; packed at `:526-527`). Fits within the existing 1088B placeholder — no BGL churn.
- Per-cascade constants scale linearly with `sphereRadius[i] / sphereRadius[0]`, so NDC bias tracks each cascade's orthographic depth range (`fn = 3*r` in the projection).
- Base values `minBias = 5e-5`, `maxSlopeBias = 5e-4`; cascade 3 (km-scale) scales up proportionally.
- Shader formula (inside `sampleOneCascade` for both primitive + globe paths):

  ```wgsl
  let nDotL = clamp(dot(normalize(N), normalize(L)), 0.0, 1.0);
  let bias = max(cascadeMinBias[i], cascadeMaxSlopeBias[i] * (1.0 - nDotL));
  let biasedDepth = ndc.z - bias;
  ```

- Cast UBO also carries a per-cascade-scaled depth bias (receive-side slope bias is additive on top).

## Slice 2 progress (2026-04-18) — cast-variant unlock

### Cast-variant pipeline unlock — SHIPPED

Before this session, `WebGPUCSMRenderer.renderCastPass` filtered commands to `_shadowCastLayout === "rte24"` and bound only binding 0 (the per-cascade cast UBO). All model, quantized-terrain, and instanced commands were silently dropped. Single-shadow-map path already supported the full variant table (`rte24`, `p12`, `modelP12`, `modelInstanced`, `modelInstancedSB`, `modelSkinned`, `quantized12`); CSM lagged.

**Fix:**

- New `getShadowCastVariant(key)` export in [WebGPUShadowMapRenderer.js](../packages/engine/Source/Renderer/WebGPU/WebGPUShadowMapRenderer.js) returns the variant descriptor. CSM imports it alongside the already-exported `_getOrCreateCastPipeline` and `_inferShadowLayoutKey` — single source of truth for variant metadata (`extraBindings`, `perCommandBindingFields`, `vertexBufferSourceSlots`).
- [WebGPUCSMRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUCSMRenderer.ts) `renderCastPass` generalized:
  - Removed `if (layoutKey !== "rte24") continue` filter.
  - **No-extras path** (rte24, p12, modelInstanced): shared per-cascade bind group cached on the renderer at `_cascadeCastBindGroups[ci].get(layoutKey)` — one bind group per `(cascade, variant)` tuple, reused across all commands that hit that variant.
  - **Extras path** (modelP12, modelInstancedSB, modelSkinned, quantized12): per-command bind group indexed by cascade via `cmd._shadowCastCSMBindGroups[ci]` + parallel `cmd._shadowCastCSMBindGroupKeys[ci]` for layout invalidation. Mirrors the single-shadow-map invalidation pattern but scoped to CSM (separate cache keys — no cross-contamination between the two paths).
  - **Multi-VB variants** (modelSkinned): walks `vertexBufferSourceSlots` to bind slot 0/5/6 of the command's 7-buffer layout into the cast pipeline's compact 0/1/2 layout. Single-VB variants fall through to default slot-0 bind.
  - Draw calls now forward `cmd.instanceCount` to `pass.drawIndexed(count, instanceCount)` so `modelInstancedSB` renders all instances (previously instancing was inherited only by the single-shadow-map path).
- Pipeline compilation is shared through the already-wired `_getOrCreateCastPipeline` factory with a CSM-owned cache (`this._sharedPipelineCache`). Each variant compiles once per cascade-renderer lifetime. Pipeline's bind-group layout is identical to the single-shadow-map variant — the 128-byte cast UBO (Slice 1 [WebGPUCSMCastUBOLayoutSpec.js](../packages/engine/Specs/Renderer/WebGPU/WebGPUCSMCastUBOLayoutSpec.js)) matches `SHADOW_UNIFORM_SIZE`, so the same WGSL `u` struct binds cleanly against either path's UBO.

**Per-command UB ownership — safe for multi-cascade iteration.** Models allocate `cache.shadowCastUB` once per Model and write the model matrix once per frame before the cast pass ([WebGPUModelRenderer.js:710-725](../packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.js#L710-L725)). CSM iterates the same command list four times (once per cascade), each reading the same stable UB — no race, no staleness. Bind-group caches stay valid frame-to-frame because the UB object identity never changes.

**What's live:** models cast cascaded shadows on terrain and on each other. Quantized-mesh terrain casts on models. Skinned/instanced models cast. Any future variant registered via `registerShadowCastVariant` (third-party extensions) works automatically — the CSM loop is fully metadata-driven.

## Slice 2b progress (2026-04-18) — texel-snap + PhongColor receive

### Texel-snap stabilization — SHIPPED

Shadow texels were drifting continuously against world-space as the camera moved, making static edges crawl. Fix: quantize the cascade sphere center to the shadow-texel grid in **world-grid-locked light space** so the center only moves in increments of one texel.

- New exported `snapToTexelGrid(center, radius, lightDir, resolution, result)` helper in [WebGPUCSMRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUCSMRenderer.ts). Builds the same light-space basis as `_computeCascadeVPMatrix` (basis depends ONLY on `lightDir` + the world-up fallback, not on camera — this is what makes the grid stable across camera motion). Projects raw center onto the (side, up) axes, rounds each coordinate to the nearest multiple of `texelWorld = 2 * radius / resolution`, then re-expresses in world space.
- Integrated in `computeCascadeVPs` between `_fitBoundingSphere` and `_computeCascadeVPMatrix`. Uses a per-call scratch `Float64Array(3)` so no per-frame allocation.
- New `get cascadeResolution(): number` getter exposes the resolution for specs and diagnostics.
- `WebGPUCSMRendererSpec.js` gained 5 specs: idempotence, displacement bounded by ~half-texel diagonal, zenith-light keeps Z unchanged, bounding coverage preserved (raw point stays inside sphere around snapped center), VP numerical stability (columns 0-2 identical, translation column differs only by a small texel-bounded amount).
- **Earth-scale sanity run:** two raw centers offset by 0.1 and 0.2 texel both snap to the SAME world position (6378000.0) — verifies the shimmer-kill mechanism at planetary radius where it matters.

### PrimitivePhongColor CSM receive — SHIPPED

[PrimitivePhongColor.wgsl](../packages/engine/Source/Shaders/WebGPU/Primitive/PrimitivePhongColor.wgsl) now consumes the CSM bindings at `@group(2) @binding(10)` and `@group(2) @binding(11)` (group 2, not 3, because PhongColor has no texture bind group in between — the primitive pipeline builds `[cameraBGL, materialBGL, effectsBGL]` for non-textured shaders). Struct additions and helper functions copied verbatim from `PrimitivePhongTexturedColor.wgsl` (the reference implementation) — EffectsUniforms now carries the required `atmosphereLutControl` + `csmControl` tail fields so byte offsets line up with the shared effects UBO (272 bytes when this entry was written 2026-04-18; the struct has since grown to **480 bytes** — `WebGPUEffectsBindGroup.js:198 EFFECTS_UNIFORM_SIZE = 480` — with `atmosphereLutControl` at offset 240 / `csmControl` at offset 256). Fragment shader routes through `computeShadowFactorCSM(eyePosition, viewDepth, normal, lightDir)` when `effects.csmControl.x > 0.5`, falls back to the single-map path otherwise. **No pipeline or JS changes needed** — the effects BGL already advertised bindings 10/11 from Slice 1, with placeholder buffers when CSM is off.

## Slice 2c progress (2026-04-18) — ModelPBRComplete receive

### ModelPBRComplete CSM receive — SHIPPED

The glTF PBR shader now receives cascaded shadows. Scope was larger than the primitive receivers because the Model pipeline had 7 bind groups pre-CSM (camera, material, texture, skinning, morph, instancing, featureId); effects had to be added as a new `@group(7)` without disturbing the existing layout.

**Pipeline layout extension** ([WebGPUModelPipelineCache.js:328-351](../packages/engine/Source/Renderer/WebGPU/WebGPUModelPipelineCache.js#L328-L351)):

- Added `this._effectsBGL = getEffectsBindGroupLayout(device)` alongside the other BGLs. Same factory the globe + primitive paths use, so the EffectsUniforms layout stays in lockstep across every consumer (272 bytes at the time of this 2026-04-18 entry; **480 bytes** at HEAD per `WebGPUEffectsBindGroup.js:198`).
- Extended `createPipelineLayout` bindGroupLayouts array from 7 to 8 slots: `[camera, material, texture, skinning, morph, instancing, featureId, effects]`. Existing pipelines don't break — no other model-rendering code binds group 7, so the addition is backward-compatible.

**Per-frame effects bind group** ([WebGPUModelRenderer.js:698-733](../packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.js#L698-L733)):

- Per-model call to `createEffectsBindGroup(device, frameState, { shadowMap, csm, cameraInPlaneSpace })` inside `updateWebGPUModel`. Mirrors the pattern in `WebGPUGlobeSurfaceRenderer.ts:1554`. CSM binding resolved the same way: read `frameState.context.csmRenderer`, gate on `.enabled === true` plus valid `cascadeParamsBuffer` + `cascadeArrayView`.
- Bind group stored on `cache.effectsBG` and pushed into each primitive's `WebGPUDrawCommand.bindGroups[]` at index 7.
- **Scope note:** cost is one effects-UB write (272 bytes at this 2026-04-18 entry; **480 bytes** at HEAD per `WebGPUEffectsBindGroup.js:198`) + one bind-group creation per model per frame. Acceptable for typical scenes (few models); if model count grows to hundreds, consider a scene-wide shared bind group cached on `frameState.context` per frame.

**Shader changes** ([ModelPBRComplete.wgsl](../packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.wgsl)):

- New `@group(7)` bindings: effects UBO + shadow depth texture + comparison sampler + clipping plane texture + clipping plane sampler + CSMParams UBO + cascade depth array.
- New `@location(7) rteMC: vec3<f32>` varying on VertexOutput / FragmentInput. VS populates it from the existing `rte` local (line 270, the model-space RTE vector). FS rotates it to world-space RTE via `(material.modelMatrix * vec4(input.rteMC, 0.0)).xyz` before feeding into cascade VPs.
- **Why model→world rotation works in FP32:** `modelMatrix * vec4(rteMC, 0.0)` applies only the rotation+scale components (w=0 drops translation). Mathematically: `modelMatrix_3x3 * (positionMC − camMC) = pWC − camWC` because `modelMatrix_3x3 * camMC = camWC - modelTranslation` and the `modelTranslation` terms cancel in `pWC - camWC`. Result is the world-space camera-relative vector with FP32 precision preserved (both inputs and output are bounded by model extent + camera distance, not Earth-scale).
- CSM helpers (`selectCascade`, `getCascadeVP`, `cascadeDepthBias`, `sampleOneCascade`, `sampleCascadeShadow`, `computeShadowFactorCSM`) inlined from the primitive receivers — same math, just reading the model's EffectsUniforms / CSMParams at @group(7).
- Fragment integration: `direct = direct * shadowFactor` immediately after the Cook-Torrance BRDF assembly, gated on `effects.csmControl.x > 0.5`. Ambient + emissive remain unshadowed per PBR convention. Unlit materials (`FLAG_IS_UNLIT`) early-exit well before the CSM path, so they're safe.

### Still pending in Slice 2d

- ~~**Material Lit variants (18 remaining)**~~ — **AUDIT 2026-04-29: ALL 19 Mat-Lit shaders are now wired.** Every `PrimitiveMat*Lit.wgsl` under `packages/engine/Source/Shaders/WebGPU/Primitive/` has `csmControl.x > 0.5` and `eyePosition` references. The 18-pending count was stale from the 2026-04-18 entry; subsequent batches landed the remaining variants. This entry is closed; the Mat-Lit CSM recipe below is preserved as documentation for any future Lit shader added to the family.

## Slice 2d progress (2026-04-18) — PBR receivers + primitive effects BG refresh

### Primitive effects bind group per-frame refresh — SHIPPED

Infrastructure gap discovered while shipping 2d: primitive commands were built once with the shared `getPlaceholderEffects` BG and never refreshed per-frame. Effect: `csmControl.x = 0` always reached the fragment shader, so **even the already-wired PhongColor and PhongTexturedColor CSM receivers from Slice 2b were dead code at runtime**. Globe terrain's per-frame `createEffectsBindGroup` call was the only path where CSM actually reached a receive shader.

**Fix** ([WebGPUPrimitiveCommands.js](../packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js)):

- New `_getOrCreateSharedPrimitiveEffectsBG(frameState)` caches one effects BG per frame on `context._primitiveEffectsBG`, keyed by `(frameNumber, toggleHash)` where the hash covers `hasShadow | hasCsm << 1`. Rebuilds when any of those flip.
- New `_refreshPrimitiveEffectsSlot(command, frameState)` swaps `command.bindGroups[last]` to the active BG. Skips pick commands (they don't receive shadows). Falls through to the cached placeholder when no feature is active, so the swap becomes a no-op.
- Called from both `updateWebGPUCommandUniforms` (per-instance + phong path) and `updateWebGPUMaterialCommandUniforms` (material + PBR path) every frame.
- Primitives have identity `modelMatrix` for current appearance primitives, so one shared BG across every primitive per frame is correct. If per-model-matrix primitives show up later, the cache key needs a modelMatrix hash.
- **Cost**: one `createEffectsBindGroup` call + one effects-UB write (272 bytes at this 2026-04-18 entry; **480 bytes** at HEAD per `WebGPUEffectsBindGroup.js:198`) per frame, reused across every primitive command. For N primitives, O(1) instead of O(N) — meaningful difference at scene scale.

### Material + PBR pipeline layout forward-compat — SHIPPED

Pre-2d, the material/PBR pipeline's bind-group layout was `[camera, material, (texture?)]` — no effects slot. PBR shaders declaring `@group(2)` or `@group(3)` for effects would have failed pipeline creation with a validation error.

**Fix** ([WebGPUPrimitiveCommands.js#createMaterialPipelineAndCache](../packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js)): append `getEffectsBindGroupLayout(device)` as the final BGL in every material + PBR pipeline layout. Command creation pushes `getPlaceholderEffects(device).bindGroup` as the matching bind group. Material Lit variants that don't declare `@group(N)` for effects ignore the extra BG — WebGPU allows unused bind groups in a pipeline layout. Pipeline layouts now align with what `_refreshPrimitiveEffectsSlot` expects.

### PrimitivePBRSimple + PrimitivePBRTextured CSM receive — SHIPPED

PBR primitives now receive cascaded shadows. Diffs:

- [PrimitivePBRSimple.wgsl](../packages/engine/Source/Shaders/WebGPU/Primitive/PrimitivePBRSimple.wgsl) — effects at `@group(2)` (no texture group). Adds `eyePosition: vec3<f32>` at `@location(3)` populated from the RTE-translated position in VS. Fragment gate: `if (effects.csmControl.x > 0.5) { direct = direct * computeShadowFactorCSM(...); }`. Ambient stays unshadowed per standard PBR convention (environment irradiance isn't occluded by a single directional light's shadow map).
- [PrimitivePBRTextured.wgsl](../packages/engine/Source/Shaders/WebGPU/Primitive/PrimitivePBRTextured.wgsl) — effects at `@group(3)` (texture group occupies `@group(2)`). Same eyePosition varying + gate as the simple variant.
- Same CSM helper stack (`selectCascade`, `getCascadeVP`, `cascadeDepthBias`, `sampleOneCascade`, `sampleCascadeShadow`, `computeShadowFactorCSM`) inlined from the PhongColor reference.
- **viewDepth sourcing**: uses `abs(input.worldPosition.z)` where `worldPosition` is legacy-named but actually view-space (multiplied by `modelViewRelativeToEye` in VS). Eye-space convention puts in-front points at negative z, so `abs(.z)` is the positive view-depth expected by `selectCascade`. Name is a vestige; kept to minimize diff.

**Spec coverage**: [WebGPUPrimitivePBRCSMSpec.js](../packages/engine/Specs/Renderer/WebGPU/WebGPUPrimitivePBRCSMSpec.js) locks WGSL `@group` / `@binding` / `@location` values, EffectsUniforms + CSMParams struct field parity across all four receivers (PhongColor, PhongTexturedColor, PBRSimple, PBRTextured), shader-module minimum size, and the non-shadowed-ambient invariant.

### Mat-Lit CSM recipe — 2/20 shipped as reference

The 20 Mat-Lit variants share an identical receive pattern. [PrimitiveMatColorLit.wgsl](../packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveMatColorLit.wgsl) is the non-textured reference; [PrimitiveMatImageLit.wgsl](../packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveMatImageLit.wgsl) is the textured reference. Recipe for the remaining 18:

1. **Decide effects group index.** No texture group → `@group(2)`. Texture group occupies `@group(2)` → effects goes at `@group(3)`. Consult the existing `@group(2) @binding(...)` declarations in the target shader — if they bind a sampler/texture, the shader is textured.
2. **Add eyePosition varying** at `@location(3)` (or next free location) on VertexOutput: `@location(3) eyePosition: vec3<f32>`.
3. **Copy the EffectsUniforms + CSMParams struct blocks** and the 5 `@group(N) @binding(...)` declarations from the chosen reference. N = 2 or 3 per step 1.
4. **Copy the CSM helper stack** (selectCascade, getCascadeVP, cascadeDepthBias, sampleOneCascade, sampleCascadeShadow, computeShadowFactorCSM) verbatim. They reference module-scope names (`csmParams`, `cascadeDepthArray`, `shadowCompSampler`, `effects`) so no edits needed.
5. **In VS, populate output.eyePosition** from the existing `eyePos: vec4<f32>` local: `output.eyePosition = eyePos.xyz;`.
6. **In fragment, wrap the direct-lighting accumulation** with the gate:
   ```wgsl
   var direct = diffuse + specular;
   if (effects.csmControl.x > 0.5) {
     let viewDepth = abs(input.viewPosition.z);
     let shadowFactor = computeShadowFactorCSM(
       input.eyePosition, viewDepth, normal, lightDir);
     direct = direct * shadowFactor;
   }
   let lighting = ambient + direct;
   ```
   Ambient must NOT be multiplied by shadowFactor (see PBR convention).
7. **Regen the .js companion** via `node -e "import('./scripts/build.js').then(m => m.wgslToJavaScript(false, 'Build/minifyShaders.state', 'engine'))"` or let `gulp build` do it.

Remaining shaders to port:

- Non-textured (effects at `@group(2)`): `matCheckerLit`, `matGridLit`, `matStripeLit`, `matDotLit`, `matFadeLit`, `matRimLightingLit`, `matElevContourLit` (7)
- Textured (effects at `@group(3)`): `matAlphaMapLit`, `matEmissionMapLit`, `matSpecularMapLit`, `matBumpMapLit`, `matNormalMapLit`, `matWaterLit`, `matElevBandLit`, `matElevRampLit`, `matSlopeRampLit`, `matAspectRampLit` (10)

Flat variants (`matXxxFlat`) are unaffected — they don't have normals and don't compute lit direct radiance, so there's nothing to shadow.

## Soft-shadow PCF (NEW-CSM-SOFT-SHADOW-PCF) — 2026-06-15 (Batch 289)

### 3x3 PCF box kernel on the receive side — CODE SHIPPED

The CSM receive path's `sampleOneCascade` did a single hardware-comparison
tap (`textureSampleCompareLevel`), giving hard aliased cascade edges. WebGL's
`czm_shadowVisibility` softens its single-map shadow with a 9-tap (3x3) box
PCF kernel under `USE_SOFT_SHADOWS`; the WebGPU CSM path lacked the
equivalent.

**Fix:** an `effects.csmControl.y`-gated 3x3 PCF box kernel (averaged ×1/9,
the exact WebGL kernel shape) inside `sampleOneCascade`, applied to ALL 25
inlined receivers (`GlobeTerrain.wgsl`, `ModelPBRComplete.wgsl`, every
`PrimitivePhong*/PBR*/Mat*Lit.wgsl`) plus the canonical
`Shadow/ShadowReceiveCSM.wgsl` reference (which gains a `pcfRadius` param so
it stays a faithful source of truth).

- **Texel size** comes from `textureDimensions(cascadeDepthArray, 0)` — no
  new UBO field, uniform across every receiver. `textureSampleCompareLevel`
  (explicit LOD) is valid even inside the non-uniform cascade-select branch
  (same pattern the pre-existing `globeShadowPCF` uses).
- **`pcfRadius = 0`** keeps the original single tap bit-exact (hard fallback).
- **JS plumbing:** `WebGPUCSMRenderer` config gains `softShadows` (default
  true) + `pcfRadius` (default `DEFAULT_CSM_PCF_RADIUS = 1.5`, matching the
  single-map `shadowMap.softShadows ? 1.5` convention) + getters;
  `WebGPUEffectsBindGroup.js` writes `ud[CSM_CONTROL_OFFSET + 1] =
  csm.pcfRadius`; the three csmBinding sites (globe / model / primitive
  renderers) forward `csmCandidate.pcfRadius`. New Scene option
  `cascadedShadowMapSoftShadows` (default true) → `_initCSMRenderer`.

**Verification status — BLOCKED on a separate cast-side gap.** The kernel is
confirmed compiled into the bundle and the radius reaches the runtime (0 in
the hard cell, 1.5 in the soft cell). But the new `probe-csm-soft-shadow.mjs`
A-vs-B (hard-vs-soft) pixel diff is **0.000%** because the WebGPU CSM **cast
pass dispatches zero commands** in every CesiumViewer scene tried
(`_castDispatches === 0`) — so no cast shadow reaches the receiver for PCF to
soften. Tracked as `NEW-CSM-CAST-NO-DISPATCH-VIEWER` in DEFERRED_WORK; the
probe will go green once that lands, with no probe changes needed.

**Still pending:** the `czm_private_shadowVisibility` normal-shading-smooth
clamp in `computeShadowFactorCSM` (lower value than the kernel, deferred);
VSM/rg32float variance soft shadows (Slice 3 stretch goal).

## Cesium feature integration — how each slice handles it

This matrix tracks how every Cesium feature interacts with CSM as the slices land. Pending items are scope for later slices, not missing functionality.

| Cesium feature | Slice 1 | Slice 2 | Slice 3 | Slice 4 |
|---|---|---|---|---|
| **RTE 64-bit precision** | Cast pass writes RTE positions (reuses existing `rte24` cast shader); receive shader transforms world-space pos back to each cascade's light-space view via light-space VP × world pos (no RTE in light space needed — shadow bias in light-space texels dominates precision). | ✓ all variants | ✓ moon-light VP uses same RTE pattern | — |
| **Whole-earth globe terrain** | Receiver integration in `GlobeTerrain.wgsl` (behind `csmEnabled` gate). | Primitive lit receivers. | Altitude-adaptive splits fix horizon-depth waste. | Per-tile cascade culling. |
| **Space / orbital camera** | No special handling — cascades use the camera's visible near/far. At orbital altitude this wastes cascade budget on empty space. | — | Altitude-adaptive regime switch: above ~500 km collapse to one "planet-scale" cascade covering the visible spherical cap; below resume 4-cascade split. | — |
| **3D Tiles** | Works via existing cast-variant dispatch (3D Tiles use the model cast path once slice 2 lands). | ✓ modelP12 / modelInstancedSB variants render. | — | Per-tile cascade visibility culling: tile is skipped in cascades it doesn't intersect. |
| **Sun / moon dual light** | Sun only. | — | Moon LUT pair already exists; CSM adds moon-cascade array + combined receive path. `shadow = shadowSun * sunWeight + shadowMoon * moonWeight`. | — |
| **Vertex-layout variants (SHADOW-LAYOUT)** | `rte24` only. | `p12`, `quantized12`, `modelP12`, `modelInstancedSB`, `modelSkinned` all wire to per-cascade cast pipelines. Reuses existing per-layout pipeline cache. | — | — |
| **WebGL backend parity** | — | — | — | CSM on WebGL via GL_DEPTH_COMPONENT array texture. Uses the existing `GLSL ES 3.00` receive path. |
| **Snapshot / freeze mode** | Disabled during freeze (cascades derive from live camera). | — | — | `WebGPUCSMRenderer.isFreezable()` contract: returns true when snapshotVersion unchanged; freeze skips per-frame cast dispatch. |
| **Verticals exaggeration** | Cast pass consumes existing `shadow terrain globals` UBO (exaggeration + sceneMode); unchanged. | ✓ | ✓ | ✓ |
| **Clipping planes** | Cast pass doesn't clip; receive shader's existing clipping logic runs after cascade select. | ✓ | ✓ | ✓ |

---

---

## Why CSM

The fork's current shadow path uses a single `ShadowMap` (depth-only render target, default 2048×2048) covering the camera frustum's full far-plane extent. For a Cesium scene this is the worst case:

- **Tiny shadow texels at far range**: a 2k shadow map covering a 100km terrain frustum gives ~50m per shadow texel. Far buildings cast no shadow; near buildings cast jagged 50m-quantized shadows.
- **Wasted resolution at near range**: the same 2k map's near-camera region has way more resolution than needed (centimeters per texel), so the budget is misallocated.
- **No view-dependent splits**: zoom out and the shadow map suddenly covers a larger region without any dynamic split adjustment.

CSM splits the camera frustum into N depth ranges (typically 3 or 4), renders each range into its own shadow map at full resolution, and the fragment shader picks the appropriate cascade per pixel based on view-space depth. This gives high-resolution shadows where the eye actually looks (near range) without paying for unnecessary detail at the horizon.

## Architecture

### New files

- ~~`Source/Shaders/WebGPU/Shadow/ShadowCastCSM.wgsl`~~ — **never created.** As shipped, CSM reuses the existing single-shadow-map cast shader `Source/Shaders/WebGPU/Shadow/ShadowMap.wgsl` directly (parameterized over cascade index via the per-cascade cast UBO); a separate CSM cast shader proved unnecessary because the per-vertex-layout cache (rte24 + p12 + later variants from S25 + 2026-04-09 work) is shared with the single-shadow-map path.
- `Source/Shaders/WebGPU/Shadow/ShadowReceiveCSM.wgsl` — fragment-side cascade selection helper (chunk, included by terrain + primitive shaders). **The only CSM-specific WGSL file that actually exists in `Source/Shaders/WebGPU/Shadow/`** (alongside `ShadowMap.wgsl`).
- `Source/Renderer/WebGPU/WebGPUCSMRenderer.ts` — the cascade-aware shadow renderer. The ~326-LOC `renderCastPass` body was later extracted into `Source/Renderer/WebGPU/WebGPUCSMCastPass.ts` (Batch 159 maintainability sweep); the renderer's `renderCastPass` is now a 1-line delegator. Owns:
  - 4 cascade textures (currently a single 2048×2048 array texture; 4 × 1024² array layers when memory matters)
  - 4 light-space VP matrices
  - 4 cascade split distances (in view space)
  - Per-cascade bounding-sphere VP fitting math

### Frame pipeline order

```
... preRender → updateAndExecuteCommands
  → executeShadowMapCastCommands (existing) → CSM cast pass (new)
  → primary color pass (samples 4 cascades instead of 1)
  → ...
```

The CSM cast pass replaces the existing single-shadow-map cast. The primary color pass needs to switch to a 4-cascade sampler with cascade-selection logic in the receive shader.

### Cascade splits

The standard practical split is a blend of uniform and logarithmic distributions:

```
λ = 0.7  // closer to logarithmic
splitDist[i] = mix(
  cameraNear + (cameraFar - cameraNear) * (i / cascadeCount),     // uniform
  cameraNear * pow(cameraFar / cameraNear, i / cascadeCount),     // logarithmic
  λ,
)
```

For a Cesium scene with `near = 1m`, `far = 1e8m` (orbital), the splits at λ=0.7 are roughly:
- Cascade 0: 1m → 100m (city scale)
- Cascade 1: 100m → 5km (district scale)
- Cascade 2: 5km → 100km (regional scale)
- Cascade 3: 100km → 1e8m (continental scale, mostly atmospheric scattering territory)

The distant cascades have huge bounding spheres but barely any pixels actually sample them — the receive shader picks the smallest cascade that covers the pixel's view-space depth.

### Per-cascade VP fitting

For each cascade, compute the view-space frustum corners → transform to world space → compute the bounding sphere of the corners → fit an orthographic projection that contains the sphere from the light's direction. The bounding *sphere* (not AABB) is the standard CSM trick: it makes the projection rotation-invariant, so a camera rotation doesn't cause the shadow texels to "swim" across surfaces.

```
for (let c = 0; c < cascadeCount; c++) {
  const corners = computeFrustumCornersInWorldSpace(camera, splitDist[c], splitDist[c+1]);
  const center = avg(corners);
  const radius = max(distance(corner, center));
  // Snap center to texel grid to prevent shimmer under camera motion.
  const texelSize = (2 * radius) / shadowMapResolution;
  const lightView = computeLightView(lightDirection, center);
  const snappedCenter = snapToGrid(center, texelSize, lightView);
  cascadeVP[c] = orthographic(-radius, radius, -radius, radius, near, near + 2 * radius)
                * lookAt(snappedCenter - lightDirection * radius * 2, snappedCenter, up);
}
```

The texel snap is critical. Without it, slow camera motion causes the shadow texels to move sub-pixel relative to the shadowed surface, producing the classic "shimmer" artifact.

### Receive-side cascade selection

The fragment shader needs to pick the right cascade for each pixel:

```wgsl
fn selectCascade(viewDepth: f32) -> u32 {
  for (var i = 0u; i < 4u; i++) {
    if (viewDepth < params.cascadeSplits[i]) {
      return i;
    }
  }
  return 3u; // farthest cascade as fallback
}
```

Then sample the matching cascade's depth + light VP. The transition between cascades is the second visual artifact to manage — a hard switch produces a visible seam where two cascades meet. The fix is to **blend** between cascades in a small overlap region:

```wgsl
let cascadeIdx = selectCascade(viewDepth);
let nextIdx = min(cascadeIdx + 1u, 3u);
let blendStart = params.cascadeSplits[cascadeIdx] - params.blendBand;
let blendT = smoothstep(blendStart, params.cascadeSplits[cascadeIdx], viewDepth);
let s0 = sampleCascade(cascadeIdx, worldPos);
let s1 = sampleCascade(nextIdx, worldPos);
let shadow = mix(s0, s1, blendT);
```

`blendBand` is typically 5-10% of the cascade's split width.

## Implementation steps

1. **CSM data structures + Scene API** (~0.5 day)
   - Add `CascadedShadowMap` class mirroring `ShadowMap` but with 4 cascades
   - Add `Scene.useCascadedShadowMaps` toggle (off by default)
   - Cascade split parameters: λ, count, max distance, blendBand

2. **Cast pipeline reuse** (~0.5 day)
   - Existing `WebGPUShadowMapRenderer` per-layout cast pipeline cache stays
   - Replace the single cast pass with a 4-iteration loop over cascade VPs
   - Each iteration uses the same cast pipeline but binds a different VP UBO

3. **Cast pass infrastructure** (~1 day)
   - Allocate the cascade texture array (`depth32float`, 4 layers)
   - Build the per-cascade frustum-fitting math
   - Implement the texel snap stabilization
   - Wire into `executeShadowMapCastCommands` so it loops over cascades

4. **Receive-side cascade selection** (~1.5 days)
   - Build `ShadowReceiveCSM.wgsl` chunk with `selectCascade`, `sampleCascade`, `blendCascade`
   - Update terrain receive shader to use the chunk
   - Update primitive (model) receive shader to use the chunk
   - Verify the existing PCF / softShadows path composes with cascade selection

5. **Spec coverage + status doc** (~0.5 day)
   - Per-cascade VP fitting CPU spec (snapshot test against fixture)
   - Cascade selection logic spec (CPU-side reproduction of the WGSL function)
   - Migration status entry

## Risks + open questions

- **Vertex layout extensibility**: each cast variant (`rte24`, `p12`, future quantized) needs to know how to compute the cascade VP. Currently the variants are decoupled from the VP entirely (the VP comes from the uniform buffer). **Mitigation**: None needed — the existing per-layout pipeline cache already handles this orthogonally.
- **Texel snap precision**: Cesium's RTE 64-bit emulation means the cascade center should be computed in encoded-camera-relative coordinates, not raw world space, to keep the snapping stable. **Mitigation**: do the snap in eye-space, then transform back via the inverse view matrix. Add a spec for the round-trip.
- **Memory cost**: 4 × 2048² × depth32float = 64 MB. Acceptable for desktop, possibly too much for low-end mobile. **Mitigation**: expose `Scene.cascadeShadowMapResolution` as a tunable; default to 1024² (16 MB) when on a constrained adapter.
- **Snapshot mode interaction**: cascade VPs are camera-derived, so they change every frame even under "no animation" conditions. When snapshot mode is frozen, the cascade VPs and the cast pass should both be skipped — the previous frame's cascade textures still produce visually-correct shadows. **Mitigation**: `WebGPUCSMRenderer` registers as a freezable, just like the volumetric fog and bundle manager.
- **Receive shader compilation cost**: every shader that samples shadows now takes a 4-cascade selection function in its hot path. The compiled shader gets ~50 lines longer per variant. **Decision**: acceptable; cascade selection compiles to ~6 ALU + 1 array sample on Vulkan/Metal/D3D.
- **EffectsUniforms struct size (added 2026-04-11; size updated to HEAD)**: the shared EffectsUniforms UBO was first extended to 240 bytes (from 112) by Phase 5 WGF-1, adding `clipPlaneEqHW: array<vec4<f32>, 8>` (128 bytes), and has since grown to **480 bytes** at HEAD (`WebGPUEffectsBindGroup.js:198 EFFECTS_UNIFORM_SIZE = 480`) as later tail fields (atmosphere LUT control, CSM control, edge control/viewport, polygon-clipping atlas control + per-extent remap, etc.) were appended. The CSM receive shader's `ShadowReceiveCSM.wgsl` chunk must include the full struct (matching `EFFECTS_UNIFORM_SIZE`) so the bind group layout matches the shared effects BGL. The cascade-specific fields (4 VP matrices, 4 split distances) should go in a **separate UBO** (new binding in group 3) rather than further extending EffectsUniforms, to keep the shared struct stable.

## Acceptance criteria

- A scene with a building near the camera (50m away) and another at 5km shows full-resolution shadows on both, with the cascade transition not visible to the eye
- Slow orbit over the same scene shows no texel shimmer
- Snapshot mode + CSM composes: frozen frame's cascade textures stay valid, no per-frame cast pass
- `Scene.getDebugSnapshot().renderer.csmStats` reports per-cascade `{ splitDistance, sphereRadius, snappedCenter, dispatched }`

## Spec coverage delta

- `Specs/Renderer/WebGPU/WebGPUCSMRendererSpec.js` — split computation (uniform vs logarithmic vs blend), per-cascade frustum corner extraction, bounding sphere fit, texel snap round-trip, snapshot freezable contract.

## Stretch: variance shadow maps (VSM)

Once the cascade infrastructure lands, the next quality bump would be replacing the per-cascade depth32float textures with rg32float (depth + depth²) and a 2-pass Gaussian blur, enabling soft shadows without PCF kernel sampling. Estimated +1 day on top of CSM. Tracked as a separate follow-up.
