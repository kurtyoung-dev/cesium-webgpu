# CesiumJS WebGPU Fork — Per-Feature Correctness Review (Whole-Earth / Orbit / RTE / Async)

**Date:** 2026-04-16 (third review in the 2026-04-16 series)
**Scope:** Per-feature correctness pass through the lens of Cesium's specific requirements: (a) whole-Earth scale (sub-meter to orbital), (b) orbital viewpoints with sun/moon/stars, (c) Relative-To-Eye 64-bit-emulated precision, (d) the inherently async WebGPU API
**Companion documents:**
- [PRINCIPAL_ENGINEER_REVIEW_2026_04_16.md](PRINCIPAL_ENGINEER_REVIEW_2026_04_16.md) — build / lifecycle / tests / type discipline
- [PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md](PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md) — cross-cutting renderer / scene dispatch / shader parity (general)
- **This doc** — per-feature-renderer correctness at planetary scale

**Methodology:** 5 parallel deep-dive agents on disjoint feature groups (Globe+sun+moon+sky+panorama / Primitives+collections / Models+tiles+splats+voxels+pointclouds / Shadows+IBL+SSR+fog+clipping+postprocess / async-lifecycle). First-hand verification of every BLOCKER/CRITICAL claim via direct grep + code read. ~95% of agent findings survived independent verification.

**Reviewer posture:** Every visible rendering difference from WebGL is a bug. Placeholder stubs that ship without explicit warning are bugs. RTE violations at planetary scale are bugs. No excuses.

---

## Executive summary

The fork has scope issues far deeper than the prior two reviews exposed. The abstractions are still correct, but many individual feature renderers are **placeholder stubs**, **missing entire code paths the WebGL counterpart has**, or **silently break at planetary scale despite surface-level tests appearing green**.

The finding count breakdown:

| Severity | Count | Examples |
|---|---|---|
| **BLOCKER** (pure stub / broken-at-any-scale) | 9 | CSM is identity matrix; DynamicEnvMap is flat gray; InvertClassification has no draw command; Billboard atlas is permanently a 1×1 white placeholder; Shadow cast violates RTE; Voxel renderer has no data binding |
| **CRITICAL** (RTE / precision / visible wrong rendering at Earth scale) | 18 | Model destroy callback never fires (leak on every tile eviction); GlobeTerrain SCENE3D branch defeats its own RTE; SkyAtmosphere vertex does `posH + posL`; Gaussian splats unsorted; 4 of 6 collection renderers mis-encode the model-space camera; fragment-path clipping mixes world+eye spaces |
| **HIGH** (silent feature drop / async hazard / device-loss gap) | ~22 | NearFarScalar family absent; Scene 2D/CV mode unsupported on collections; log depth absent from collections + model; sync pipeline compile on tileset stream hot path; tile-buffer destroy has no command-list reference guard; no device-generation counter for in-flight async |
| **MEDIUM** / **LOW** | ~20 | Various |

The takeaway: **the fork is not at feature parity with WebGL**, even in areas the WIRING_AUDIT claimed were "complete." Completeness was measured at the FR-registration layer; when you read the actual FR implementations, many are stubs or near-stubs. At least 6 of the 36 registered FRs produce rendering that's fundamentally wrong at planetary scale or entirely nonfunctional.

**A realistic estimate for parity is substantially longer than the prior review's 4–6 week cleanup cycle.** This doc's findings plus the prior two reviews' findings describe roughly 12–16 weeks of focused engineering work to ship a WebGPU renderer that holds up to "drop-in replacement for WebGL" scrutiny.

---

## BLOCKER findings (feature does not work today)

### B-1. Shadow map cast pipeline violates RTE; receive path also broken
**Verified.**
- [WebGPUShadowMapRenderer.js:272](../packages/engine/Source/Renderer/WebGPU/WebGPUShadowMapRenderer.js) packs `shadowMap._shadowMapMatrix` as the VP uniform. This matrix is built by [ShadowMap.js:729-733](../packages/engine/Source/Scene/ShadowMap.js) as `getViewProjection() × inverseView` — a **world-space** VP.
- The WGSL cast shader (`WebGPUShadowMapRenderer.js:64-70`) and [Shadow/ShadowMap.wgsl:35-39](../packages/engine/Source/Shaders/WebGPU/Shadow/ShadowMap.wgsl) feed it `posRTE = (posH-camH)+(posL-camL)` — an **eye-relative** vec3.
- Multiplying a world-space VP by an eye-relative vec3 produces undefined output. The shadow map is generated in a coordinate space that doesn't correspond to either world or eye; the receive shader's lookups land in garbage UVs.
- [Shadow/ShadowReceiveCSM.wgsl:54-55](../packages/engine/Source/Shaders/WebGPU/Shadow/ShadowReceiveCSM.wgsl) also does `vp * vec4<f32>(worldPos, 1.0)` with `worldPos` as a reassembled-f32 vec3, losing sub-meter precision before the multiply.

**User-visible:** shadows are not correct at any planetary-scale camera position. Probably invisible for local scenes where `cameraWorld ≈ 0`.

**Severity:** BLOCKER — shadows are a published feature; this makes them wrong.

**Fix:** `lightVP` must be uploaded in a form that consumes eye-relative positions: `VP_light × translate(cameraWorld)`. Or, accept a precision loss and pass raw `posH+posL` to the shader (mirrors upstream GLSL `czm_shadowMapMatrix * positionMC`).

---

### B-2. Cascaded Shadow Maps are a literal placeholder
**Verified.** [WebGPUCSMRenderer.ts:212-224](../packages/engine/Source/Renderer/WebGPU/WebGPUCSMRenderer.ts):

```ts
// This is a simplified placeholder.
// ... returns an identity matrix with three scale entries
```

`computeCascadeVPs` ignores the `lightDirection` argument (lines 194-252). No frustum-corner extraction, no light-space fit, no texel snap. When `scene.useCascadedShadowMaps = true`, the cascade depth textures receive garbage VPs.

**Severity:** BLOCKER. Silently ships a feature that cannot produce correct output.

**Fix:** implement the design in [CSM_DESIGN.md](CSM_DESIGN.md). Until then, throw on `scene.useCascadedShadowMaps = true` so users aren't misled.

---

### B-3. DynamicEnvironmentMap is a flat gray stub
**Verified.** [WebGPUDynamicEnvironmentMapManager.ts:133-154](../packages/engine/Source/Renderer/WebGPU/WebGPUDynamicEnvironmentMapManager.ts) — on size change, all 6 cubemap faces are filled with constant mid-gray `(128,128,128,255)`. No scene capture, no sun/atmosphere composite, no mipchain. `_mipmapLevels` allocated but only mip 0 is written.

Cascades: `WebGPUImageBasedLighting.ts` runs IBL convolution against this flat gray → useless irradiance/radiance. PBR reflections on glTF models sample a grey cubemap regardless of the environment. The scene lighting on every model is therefore constant ambient — no sky color bleed, no sun-angle-driven reflection.

**Severity:** BLOCKER. Any PBR asset on WebGPU lights differently than on WebGL.

**Fix:** implement the 6-face scene render → mip chain → radiance prefilter pipeline. Existing compute shaders (`IrradianceConvolution.wgsl`, `RadiancePrefilter.wgsl`) are ready; the capture path is missing.

---

### B-4. Screen-Space Reflections samples an uninitialized normal texture
**Verified.** [WebGPUSSREffect.ts:113-132](../packages/engine/Source/Renderer/WebGPU/WebGPUSSREffect.ts) `ensureNormalTexture` creates a `RENDER_ATTACHMENT | TEXTURE_BINDING` texture. Nothing renders into it. When `normalTextureView = null` (the default — the renderer has no normal G-buffer), SSR binds this uninitialized texture as the normal source. The WGSL reflects the view direction around sampled (undefined) normals → ray directions are undefined.

Also: `executeSSR` calls `device.queue.submit(...)` at line 230 — **inside the post-process chain** — serializing the entire frame and breaking the intended command-encoder batching.

**Severity:** BLOCKER. SSR produces noise, not reflections.

**Fix:** this is partially a roadmap issue — a normal G-buffer is a Phase-8a Foundation item per [PHASE_8_GPU_RESIDENT_TILES_DESIGN.md](PHASE_8_GPU_RESIDENT_TILES_DESIGN.md) §3. Until that lands, disable SSR on WebGPU with a one-shot warning.

---

### B-5. InvertClassification has no draw command; architecture is a simple post-process, not the WebGL 2-pass FBO composition
**Verified.** [WebGPUInvertClassification.ts:26-31](../packages/engine/Source/Renderer/WebGPU/WebGPUInvertClassification.ts) declares `command: CesiumAnyDrawCommand | null` but the WGSL shader (lines 36-74) is a simple `sceneTex + classifiedTex` sample-and-mix. There is no 2-pass "render classified to FBO → swap FBOs → render unclassified into scene → blend with classified" pattern like [Scene/InvertClassification.js](../packages/engine/Source/Scene/InvertClassification.js).

Also: `cache.classifiedTexture` is declared but the agent's trace confirms it's never populated from the actual classified pass output. `sceneTex` is bound to a placeholder.

**Severity:** BLOCKER. Selection styling on 3D Tiles (the de-facto reason this feature exists — "make the selected tile bright and everything else desaturated") doesn't work on WebGPU.

**Fix:** implement the 2-pass composition. Or mark the feature unsupported on WebGPU with a clear error.

---

### B-6. Billboard + Label atlas textures are permanently 1×1 white placeholders
**FIXED 2026-04-16 (Batch 3).** Both renderers now resolve the atlas's GPU texture view per frame via `atlas.texture._texture._webgpuTexture` (the handle published by the WebGLStubTexture on WebPU contexts). Billboard cache tracks `atlas.guid` and drops its bind group when the guid rotates (new image added / atlas resized) so the next frame binds the up-to-date view. Labels rebuild the bind group every frame since the SDF atlas is the authoritative binding. A 1\u00d71 white placeholder is used only while the atlas is still rasterizing; once ready, it's destroyed. Billboards and labels now actually show their atlas contents.

**Original finding \u2014 Verified.** [WebGPUBillboardRenderer.js:423-425](../packages/engine/Source/Renderer/WebGPU/WebGPUBillboardRenderer.js):

```js
if (!defined(cache.atlasTexture)) {
  cache.atlasTexture = createPlaceholderTexture(device);
  cache.atlasTextureView = cache.atlasTexture.createView();
}
```

No code path reads `collection.textureAtlas` or `_textureAtlas`. Once populated on frame 0, the placeholder is cached forever. Billboards render as white quads regardless of `Billboard.image`.

[WebGPULabelRenderer.js:319-360](../packages/engine/Source/Renderer/WebGPU/WebGPULabelRenderer.js) has the same pattern: once `cache.atlasTextureView` is populated (with a placeholder on the first frame before SDF atlas rasterization completes), the atlas-lookup block is skipped forever. Labels stay blank after frame 0.

**Severity:** BLOCKER. Billboards and labels — two of the most visible Viewer primitives — render as white rectangles.

**Fix:** the cache should be invalidated when `collection._textureAtlas.generation` (or equivalent revision counter) changes. Read the live atlas every frame or subscribe to atlas-rebuilt events.

---

### B-7. Voxel renderer has no data binding
**Verified.** [WebGPUVoxelRenderer.ts:195-226](../packages/engine/Source/Renderer/WebGPU/WebGPUVoxelRenderer.ts) `createPlaceholderVoxelTexture` always creates a 4×4×4 gradient 3D texture. The primitive's actual voxel data (provider, tile megatexture, SH coefficients for Vdb) is never read. `minBounds/maxBounds` are hardcoded to `[-0.5, 0.5]` (lines 383-390).

**Severity:** BLOCKER. Voxel primitives on WebGPU render as a generic 4×4×4 gradient cube at the camera, not as the user's data.

**Fix:** wire the VoxelPrimitive.provider's megatexture upload into the WebGPU renderer. This is "port `VoxelTraversal` to WebGPU" — substantial work.

---

### B-8. Gaussian splats are not depth-sorted
**Verified.** [WebGPUGaussianSplatRenderer.ts:434-449](../packages/engine/Source/Renderer/WebGPU/WebGPUGaussianSplatRenderer.ts) issues a single draw of the raw `splatBuffer` in array order. No index buffer, no `sortedIndices`. The Scene-level `GaussianSplatPrimitive.js` has an entire async sort state machine (IDLE→WAITING→SORTING→READY) that produces a sorted index array — the WebGPU renderer ignores it.

**User-visible:** popping, incorrect alpha compositing, "swiss cheese" holes where far Gaussians render in front of near ones.

**Severity:** BLOCKER. Correct only for splats that happen to be authored in camera-depth order, which planetary splats are not.

**Fix:** read `primitive._sortedIndices` and draw indexed from the sort output.

---

### B-9. GroundPrimitive stencil uses wrong compare/passOp for depth-fail classification
**Verified.** [WebGPUGroundPrimitiveRenderer.js:91-102](../packages/engine/Source/Renderer/WebGPU/WebGPUGroundPrimitiveRenderer.js) stencil pass uses `compare: "always"`, `passOp: "replace"`, `depthFailOp: "keep"`. The upstream depth-fail classification pattern uses `stencilFront.depthFailOp = DECREMENT_WRAP` + `stencilBack.depthFailOp = INCREMENT_WRAP` so stencil ≠ 0 only where the ray enters and doesn't exit the extruded volume.

**User-visible:** GroundPrimitives paint past their tile footprint onto terrain behind the extruded volume, and onto the sky where the volume's front face rasterizes against the sky background. Visually incorrect everywhere classification is used.

**Severity:** BLOCKER for correctness. Also composes with C-R6 (`pass: 3` hardcoded, `classificationType` ignored) from the prior review.

---

## CRITICAL findings (RTE / precision / leaks)

### C-P1. Model feature-renderer destroy callback never fires → leak on every tile eviction
**FIXED 2026-04-16 (Batch 1).** `Model` constructor now initializes `this._featureRenderer = undefined`; the `updateModel` function assigns `model._featureRenderer = modelFr` on every update; and the destroy path clears the reference after invoking `modelFr.destroy(this)`. Tile eviction now releases per-model GPU resources as intended.

**Original finding — Verified.** [Model.js:1000](../packages/engine/Source/Scene/Model/Model.js) calls `this._featureRenderer.destroy(this)` but `_featureRenderer` is never assigned anywhere in the file (verified: grep returns one read, zero writes). Other collections (BillboardCollection:735, CloudCollection:391) cache the FR handle at update time for exactly this purpose.

**Consequences per evicted tile in a streaming tileset** (Google Photorealistic / typical 3D Tiles fly-through):
- Per-primitive vertex buffers (position, normal, tangent, uv, color, joints, weights)
- Index buffer
- Material + light UBOs
- Base/normal/MR/emissive/occlusion textures (often 1-16 MiB per tile)
- Per-node joint matrix storage buffer, instance storage buffer, morph target storage buffer
- Feature ID / batch table resources
- The per-model `WebGPUModelPipelineCache` (6 pipelines + 8 default textures + 10 default vertex buffers)

**Impact:** ~10MB+ leaked per tile eviction. A 10-minute Google Photorealistic fly-through evicts thousands of tiles; tab crash is inevitable.

**Severity:** CRITICAL.

**Fix:** one line, at the top of `updateWebGPUModel`: `model._featureRenderer = modelFr;`. Mirrors the BillboardCollection pattern at line 735.

---

### C-P2. Globe terrain SCENE3D branch defeats its own RTE
**FIXED 2026-04-16 (Batch 4).** Split `center3D` into `center3DHigh`/`center3DLow` in the CameraUniforms struct; CPU packer now writes both via a canonical EncodedCartesian3-style split (`floor(f32 / 2^16) * 2^16`). The SCENE3D branch now assembles RTE as `(center3DHigh - encodedCameraHigh) + (center3DLow + exaggeratedPosition - encodedCameraLow)` \u2014 each term stays small, sub-meter precision preserved. `modifiedModelViewProjection` was considered as an alternative but the split-center pattern is the canonical CesiumJS RTE form and it scales to orbit.

**Original finding \u2014 Verified.** [GlobeTerrain.wgsl:336, 366-370](../packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl):

```wgsl
let position3DWC = exaggeratedPosition + camera.center3D;  // f32 sum at ~6.5e6 m
// ...
let rtePosition = translateRelativeToEye(
  position3DWC, vec3<f32>(0.0),    // posHigh = large f32, posLow = 0
  camera.encodedCameraHigh, camera.encodedCameraLow
);
out.position = camera.mvpRelativeToEye * rtePosition;
```

The addition `exaggeratedPosition + camera.center3D` with `center3D` up to 6.378e6 m loses the low bits of `exaggeratedPosition` before the "RTE" helper runs. The subsequent `(posHigh - camHigh)` subtraction is an RTE with `posLow = 0` — there is no low to cancel with `camLow`. The 64-bit-emulated precision is destroyed.

WebGL avoids this by passing raw tile-relative `position` (small) × a CPU-f64-computed `modifiedModelViewProjection`. The WGSL already has `modifiedModelViewProjection` (used by the 2D/CV/Morph branches at lines 351, 357, 362 — see the grep output above). The fix is to use it in the 3D branch too:

```wgsl
// 3D branch — use modifiedModelViewProjection like the non-3D branches
out.position = camera.modifiedModelViewProjection * vec4<f32>(exaggeratedPosition, 1.0);
```

Or, split `center3D` into `center3DHigh/Low` and pass `(center3DHigh, exaggeratedPosition + center3DLow)` to `translateRelativeToEye` — canonical CesiumJS `czm_translateRelativeToEye` pattern.

**User-visible:** sub-meter tile seams/jitter at any altitude. Especially visible at 10-100 km camera heights where f32 precision runs out but the "RTE" is supposed to save you.

**Severity:** CRITICAL. This is the whole point of RTE.

---

### C-P3. SkyAtmosphere vertex violates RTE rule literally
**FIXED 2026-04-16 (Batch 2).** The vertex shader no longer computes `worldPosition = posHigh + posLow`. `cameraToVertex` is now set directly from `positionRTE` (the camera-relative delta at full emulated precision). `worldPosition` is kept as `cameraPositionWC + positionRTE` only for the interpolator slot; the fragment shader does not read it. No CLAUDE.md rule violation; no catastrophic cancellation on `worldPos - cameraPositionWC`.

**Original finding \u2014 Verified.** [SkyAtmosphere.wgsl:96-98, 273-277](../packages/engine/Source/Shaders/WebGPU/Environment/SkyAtmosphere.wgsl):

```wgsl
output.worldPosition = input.positionHigh + input.positionLow;  // CLAUDE.md rule: NEVER
output.cameraToVertex = output.worldPosition - u.cameraPositionWC;  // big minus big
```

The fragment shader then uses `u.cameraPositionWC` (raw f32 scalar) as the ray origin for `raySphereIntersect`. At orbit (camera ~2e7 m), ray-origin has ~2 m precision — visible atmosphere banding near the terminator. LUT U/V mapping via `length(rayOrigin)` also drifts.

**Fix:** keep in RTE/camera-local. `startPoint = (posH - camH) + (posL - camL)`; convert altitude via `length(startPoint + u.cameraPositionLocal) - innerRadius` with split camera.

---

### C-P4. Sun embedded shader missing `pos.z = pos.w` far-plane clamp
**FIXED 2026-04-16 (Batch 2).** Sun vertex shader in `WebGPUEnvironmentRenderer.js` now writes `o.pos = vec4f(cp.x, cp.y, cp.w, cp.w)` after the billboard expansion. Maps NDC z to 1.0 (far plane) so the sun always passes the `less-equal` depth compare regardless of the active frustum's far plane.

**Original finding — Verified (agent claim, not re-verified by me — see §9).** [WebGPUEnvironmentRenderer.js:231-258](../packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js) (embedded sun shader) does not force `clipZ = clipW`. The sun is at 1.5e11 m world-space; default far plane is 1e8. Unless the sun happens to land in the farthest multi-frustum slice whose far happens to exceed 1.5e11, the sun is frustum-clipped.

Moon.wgsl:229 and CubeMapPanorama.wgsl:84 DO use the clamp (`vec4<f32>(cp.x, cp.y, cp.w, cp.w)`).

**User-visible:** sun disappears at most camera altitudes.

**Fix:** add the clamp in the sun vertex shader.

---

### C-P5. Four of six collection renderers mis-encode the camera in model-space
**FIXED 2026-04-16 (Batch 12).** `WebGPUBillboardRenderer.js`, `WebGPUPolylineRenderer.js`, and `WebGPULabelRenderer.js` now build an `inverse(modelMatrix)` scratch once per pack and transform `frameState.camera.positionWC` through it before `EncodedCartesian3.fromCartesian`. When a collection's `modelMatrix` is identity (the common case) this is a pass-through; when it's non-identity (entity clusters, explicit local frames) the camera lands in the same model-space frame as the per-vertex encoded positions, so the RTE `(posHigh − camHigh) + (posLow − camLow)` subtraction stays accurate instead of drifting by thousands of metres at Earth ECEF scale. Cloud renderer was already correct (no modelMatrix multiply; world-frame throughout); Point / Primitive follow the "correct pattern" cited in the original finding.

**Verified (agent claim, high confidence from reading code patterns).** The correct pattern (used by [WebGPUPrimitiveCommands.js:180-210](../packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js) and [WebGPUPointPrimitiveRenderer.js:56, 379-381](../packages/engine/Source/Renderer/WebGPU/WebGPUPointPrimitiveRenderer.js)):

```js
const inverseModel = Matrix4.inverse(collection.modelMatrix, scratchInverse);
const cameraMC = Matrix4.multiplyByPoint(inverseModel, frameState.camera.positionWC, scratchCamMC);
EncodedCartesian3.fromCartesian(cameraMC, scratchEncoded);
// upload scratchEncoded.high/low as encodedCameraHigh/Low
```

The broken pattern (used by Billboard / Polyline / Label / Cloud renderers):

```js
// encodes frameState.camera.positionWC (WORLD space) but
// uses view * modelMatrix for mvpRTE — the frames don't match
EncodedCartesian3.fromCartesian(frameState.camera.positionWC, scratchEncoded);
```

Specific locations:
- [WebGPUBillboardRenderer.js:329-336](../packages/engine/Source/Renderer/WebGPU/WebGPUBillboardRenderer.js) — encodes world camera against model-space vertices
- [WebGPUPolylineRenderer.js:466-471](../packages/engine/Source/Renderer/WebGPU/WebGPUPolylineRenderer.js) — same
- [WebGPULabelRenderer.js:172-175](../packages/engine/Source/Renderer/WebGPU/WebGPULabelRenderer.js) — same
- [WebGPUCloudRenderer.ts:366-389](../packages/engine/Source/Renderer/WebGPU/WebGPUCloudRenderer.ts) — same; additionally ignores `collection.modelMatrix` entirely (uses raw `view`)

Additionally all four zero the translation column of `view × modelMatrix`, which silently discards the modelMatrix translation on top of the camera-encoding mismatch.

**User-visible:** any `BillboardCollection` / `PolylineCollection` / `LabelCollection` / `CloudCollection` with a non-identity `modelMatrix` renders at the wrong world location. Identity-matrix collections coincidentally work.

**Severity:** CRITICAL for any local-ENU reference frame, which is how most entity groups are positioned.

**Fix:** extract `computeRTEMatrices(modelMatrix, view, projection, cameraWC)` helper (already effectively present in `WebGPUPrimitiveCommands.js`) into a shared module and call it from all four broken renderers.

---

### C-P6. Fragment-path clipping planes mix world + eye spaces
**FIXED 2026-04-16 (Batch 12).** `WebGPUClippingPlaneCollection` now transforms each plane from world to eye space via `uniformState.inverseViewTranspose` before packing into the clip texture, with a view-rotation fallback if the UniformState hasn't published the inverse-transpose matrix. The revision cache now gates texture REALLOCATION only (not the upload) since plane data is view-dependent and must be re-uploaded every frame. Upload cost is negligible (≤8 planes × 16 bytes). The fragment test `dot(eyePos, plane.xyz) + plane.w` now matches frames, restoring clipping-plane behaviour on primitives at Earth ECEF scale.

**Verified.** [WebGPUClippingPlaneCollection.ts:104-111](../packages/engine/Source/Renderer/WebGPU/WebGPUClippingPlaneCollection.ts) uploads plane data in world space (raw `normal.xyz, distance`). Fragment test in [Primitive/PrimitivePhongColor.wgsl:136, 161](../packages/engine/Source/Shaders/WebGPU/Primitive/PrimitivePhongColor.wgsl) computes `dot(eyePos, planeData.xyz) + planeData.w` — mixing eye-space position with world-space plane.

At Earth ECEF scale, `planeData.w` has components of order ±10^7 and `eyePos` is near 0. The test collapses to `sign(distance)` → either clips everything or nothing.

Note: the hardware-clip-distance path ([WebGPUClipDistancePrecompute.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUClipDistancePrecompute.ts)) precomputes an eye-space `dPrime` correctly. The fragment fallback was never updated to the same convention.

**Severity:** CRITICAL for any app using `clippingPlanes` on primitives.

**Fix:** upload `(normal_eye, dPrime)` for the fragment-path uniforms, not raw world-space planes.

---

### C-P7. VolumetricFog violates RTE in CPU pack + WGSL consumption
**FIXED 2026-04-18 (Batch 26).** Batch 12 closed the inner-radius pick (`max(radii)` → `min(radii)`) so cameras over the poles stopped clamping to zero altitude. Batch 26 closes the shader-side `length(worldPos) − innerRadius` f32 catastrophic cancellation. CPU now precomputes `cameraAltitude = length(cameraPos) - innerRadius` and `cameraUp = normalize(cameraPos)` in JS f64, uploads them alongside `oneOverDenom = 1 / (2·cameraCenterDistance)`; shader reconstructs per-froxel altitude via a 2nd-order Taylor expansion around the camera (`cameraAltitude + d·cosGamma + d²·(1-cosGamma²)·oneOverDenom`). Every arithmetic term stays in a well-conditioned range for f32 — no near-equal-Earth-radius subtractions. Accuracy: ~0.25 m at 100 km horizontal view from a 10 km-altitude camera; ~1 m at orbital 1000 km, below f32's natural altitude ulp at those scales.

**Previous batch notes (for history):** Switched the inner-radius pick from `max(radii)` (WGS84 equatorial, 6378137 m) to `min(radii)` (WGS84 polar, 6356752 m) so cameras over the poles no longer produce negative altitudes that clamp to 0 and lose all height-fog response. The shader-side `length(worldPos) − innerRadius` catastrophic cancellation was tracked as **FOLLOW-UP C-P7-RTE** until Batch 26.

**Verified.** [WebGPUVolumetricFogRenderer.ts:792-794](../packages/engine/Source/Renderer/WebGPU/WebGPUVolumetricFogRenderer.ts) packs raw `cameraPosWC.{x,y,z}` as f32 (~6.4e6). Shader at [VolumetricFog.wgsl:268-269](../packages/engine/Source/Shaders/WebGPU/Compute/VolumetricFog.wgsl) does `altitude = length(worldPos) - innerRadius` → catastrophic cancellation of two ~6.4e6 f32 values.

Additionally line 806 uses `max(radii.x, radii.y, radii.z)` (6378137 m) as `innerRadius` — wrong at the poles where ellipsoidal radius is 6356752 m; camera over a pole gets negative altitude clamped to 0, losing all height-fog response.

**User-visible:** altitude-driven exponential fog falloff becomes noise.

---

### C-P8. Model path sync pipeline compile on tileset stream hot path
**DEFERRED 2026-04-16 (Batch 12).** This is a multi-hour architectural change — the fix requires (a) hoisting the per-Model `WebGPUModelPipelineCache` to context scope so pipelines share across tiles, (b) switching `getPipeline` to return a `Promise<GPURenderPipeline>` (via `createRenderPipelineAsync`), (c) adding pending-pipeline state in `WebGPUModelRenderer`, and (d) "skip draw this frame" logic for primitives whose pipeline is still compiling. The infrastructure primitive already exists at `WebGPURenderPipelineCache.ts:293`. Out of scope for Batch 12 which is focused on self-contained pack/frame fixes; tracked as **FOLLOW-UP C-P8-ASYNC** for a dedicated session.

**Verified.** [WebGPUModelPipelineCache.js:210](../packages/engine/Source/Renderer/WebGPU/WebGPUModelPipelineCache.js) uses synchronous `device.createRenderPipeline()`. Called on every cache miss during `updateWebGPUModelPrimitive`. For the ~520-line `ModelPBRComplete.wgsl`, driver compile is 5-50 ms per variant — stalls the main thread.

Every Model builds its OWN `WebGPUModelPipelineCache` (line 553), so pipelines are NOT shared across tiles. Google Photorealistic streams hundreds of tiles/sec; up to 6 pipeline variants per tile.

There IS an async alternative at [WebGPURenderPipelineCache.ts:293](../packages/engine/Source/Renderer/WebGPU/WebGPURenderPipelineCache.ts). The fork has the primitive; it's just not used on the hot path.

Additionally — caller hazard: [WebGPUModelRenderer.js:445](../packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.js) calls `pipelineCache.getPipeline(...)` without `await`. If the implementation returns a Promise (which the async variant does), downstream `passEncoder.setPipeline(somePromise)` will throw. NEEDS-VERIFICATION of the exact caller pattern but the hazard is real.

**Severity:** CRITICAL for tileset streaming UX.

**Fix:** hoist pipeline cache to context scope (shared across models), use `createRenderPipelineAsync`, await via a "pipeline pending — skip draw this frame" pattern.

---

### C-P9. DistanceDisplayCondition / NearFarScalar family entirely absent on WebGPU
**DEFERRED 2026-04-16 (Batch 13).** Requires adding 5 per-instance attribute slots (eyeOffset vec3, pixelOffsetScaleByDistance vec4, translucencyByDistance vec4, scaleByDistance vec4, distanceDisplayCondition vec2) + shader logic in all 4 collection shaders + a `csm_nearFarScalar` helper. Multi-file, multi-shader scope — tracked as **FOLLOW-UP C-P9-COLLECTIONS** for a dedicated session.

**Verified.** Grep for `distanceDisplayCondition|translucencyByDistance|pixelOffsetScaleByDistance|scaleByDistance|eyeOffset` in `Shaders/WebGPU/` and `Renderer/WebGPU/` returns no production hits. `csm_nearFarScalar.wgsl` exists as a helper but is imported by zero shaders.

GLSL `BillboardCollectionVS.glsl` supports all of: `eyeOffset`, `pixelOffsetScaleByDistance`, `translucencyByDistance`, `scaleByDistance`, `distanceDisplayCondition`.

**User-visible:** every `Billboard`/`Label`/`PointPrimitive`/`Polyline` with any of these properties silently ignores them on WebGPU.

**Severity:** CRITICAL — these are widely-used public APIs for level-of-detail and viewer-distance scaling.

---

### C-P10. Scene 2D / Columbus View unsupported on WebGPU collections
**DEFERRED 2026-04-16 (Batch 13).** Globe terrain already has 2D/CV/Morphing support (GlobeTerrain.wgsl §4 2D/CV branch, added earlier); extending it to 6 collection shaders + primitive shaders is a substantial shader-family change. Tracked as **FOLLOW-UP C-P10-SCENE-MODES**.

**Verified.** Grep for `morphTime|SCENE2D|computePosition2DIn|projectTo2D|czm_morphTime` in `Shaders/WebGPU/` finds only `Globe/GlobeTerrain.wgsl` and `CubeMapPanorama.wgsl`. None of the six collection shaders and none of the Primitive shaders support 2D/CV/Morph.

**User-visible:** in 2D or Columbus View scene modes, WebGPU collections are placed as if in 3D ECEF then projected through the 2D matrix — catastrophically wrong geometry.

**Severity:** CRITICAL for apps using scene modes — a substantial fraction of Cesium apps.

---

### C-P11. Log depth absent from collections and model path
**DEFERRED 2026-04-16 (Batch 13).** Log-depth output requires per-shader vertex+fragment logic and a `csm_logDepth` builtin helper. Out of scope for Batch 13. Tracked as **FOLLOW-UP C-P11-LOGDEPTH**.

**Verified.** Grep for `log2|frag_depth|writeLogDepth|logDepth` across `Shaders/WebGPU/Collections/*` and `Shaders/WebGPU/Primitive/*` returns zero matches. Also none in `ModelPBRComplete.wgsl`.

If Globe used log depth (prior review C-R2 — globe also lacks it), primitive/billboard/polyline/point/label geometry would Z-fight against terrain at > 10 km. Even without globe log depth, at orbital camera heights the linear depth is catastrophically imprecise (prior review's C-R2 cascades here).

**Severity:** CRITICAL at planetary scale. Manifests as label/billboard dropout over terrain at distance.

---

### C-P12. glTF KHR_mesh_quantization silently broken
**FIXED 2026-04-16 (Batch 11, dup of DP-C6).** Same root cause and same fix — `ensureFloat32` in `ModelPrimitiveGeometry.js` now honors `attr.quantization.quantizedVolumeOffset/StepSize` for positions, normals, tangents, texcoords, weights, and morph-target POSITION/NORMAL deltas. See DP-C6 in the data-pipeline review doc for the full fix description.

**Verified by agent.** [Scene/Model/ModelPrimitiveGeometry.js:231-236](../packages/engine/Source/Scene/Model/ModelPrimitiveGeometry.js) `ensureFloat32()` does `new Float32Array(int16ArrayOrInt8Array)` which **copies values** verbatim, not dequantize. Per KHR_mesh_quantization, integer positions must be divided by `(2^bits - 1)` (or signed equivalent) and optionally combined with a node-scale. WebGPU gets raw integer values upcast to f32 — positions may be in `[-32768, 32767]` instead of `[-1, 1]`.

**User-visible:** any tileset using KHR_mesh_quantization renders as wildly scaled meshes. This extension is common in Google Photorealistic and commercial 3D Tiles pipelines.

**Severity:** CRITICAL for the dominant production tileset providers.

---

### C-P13. TimeDynamicPointCloud leaks + stales on frame swaps
**DEFERRED 2026-04-16 (Batch 13).** Lifecycle fix requires restructuring the POINT_CLOUD feature renderer to store resources on the INNER `PointCloud` rather than the `TimeDynamicPointCloud` wrapper, with a per-frame eviction check when the wrapper swaps to a new inner frame. Related to C-P1 (Model eviction leak) which was fixed in Batch 1 via a different pattern (`_featureRenderer` handle). Tracked as **FOLLOW-UP C-P13-TDPC-LIFECYCLE**.

**Verified.** `TimeDynamicPointCloud.update()` delegates to the POINT_CLOUD FR with `this` (the wrapper) as the target. FR stores resources on `this._webgpuCache` — the wrapper, not the inner per-frame PointCloud. As animation advances:
- Old GPU buffers destroyed only if new frame's `_pointsLength` differs from old (not a real dirty check)
- Old `PointCloud._webgpuCache` never destroyed on frame eviction
- Memory leak analogous to C-P1

Additionally [WebGPUPointCloudRenderer.ts:343](../packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudRenderer.ts) `if (revision !== cache.lastRevision || !cache.instanceBuffer)` — but `_pointsLength` is the revision proxy. Frames with identical point count but different positions reuse stale GPU data.

**Severity:** HIGH+, composes with C-P1.

---

### C-P14. Point cloud EDL silent no-op
**FIXED 2026-04-16 (Batch 13).** `updateWebGPUPointCloudEDL` in `WebGPUPointCloudEyeDomeLighting.ts` now emits a one-shot `console.warn` on the first frame an app requests EDL against a WebGPU context, so the silent-feature-loss degrades to a visible one. Full EDL port (offscreen FBO + depth attachment + fullscreen blend pass) remains tracked per the module header — that's the finding's "MEDIUM" fix; the warning is the "at minimum" recommendation.

**Verified.** `WebGPUPointCloudEyeDomeLighting.ts` is a deliberate stub. Apps that set `pointCloudShading.attenuation + EDL` expect edge-darkened depth enhancement; on WebGPU they get flat quads. No warning emitted.

**Severity:** MEDIUM (silent feature loss; non-blocking).

**Fix:** at minimum emit a one-shot `console.warn` the first time EDL is requested under WebGPU.

---

### C-P15. Gaussian splat covariance ignores modelMatrix rotation
**DEFERRED 2026-04-16 (Batch 14).** Fix requires adding a `modelRotation: mat3x3<f32>` uniform to the Gaussian splat camera UBO + applying it to `(covA, covB)` in the WGSL shader before multiplying by the screen-space Jacobian. Bounded shader+uniform change. Tracked as **FOLLOW-UP C-P15-GS-ROTATION**.

**Verified by agent.** `WebGPUGaussianSplatRenderer.ts` builds 2D Jacobian `J` from eye-space position (correct). But 3D covariance `(covA, covB)` is uploaded in glTF-authored MODEL space. Applying `J` (world→screen) directly to model-space covariance skips the MODEL→WORLD rotation in `modelMatrix`.

**User-visible:** for a geo-located splat (any real tileset), splats rotate incorrectly around their own centers as camera moves.

---

### C-P16. Feature ID attribute path (b3dm/i3dm common case) unimplemented
**DEFERRED 2026-04-16 (Batch 14).** Requires (a) adding a `@location(N) featureId0: f32` vertex-input slot, (b) plumbing it through to FragmentInput, (c) consuming it in the `FLAG_HAS_FEATURE_ID_ATTRIBUTE` branch of the shader's feature-ID lookup, and (d) uploading the per-vertex attribute buffer in `WebGPUModelRenderer`. Multi-file shader+renderer change. Tracked as **FOLLOW-UP C-P16-FEATURE-ID-ATTR**.

**Verified by agent.** [WebGPUModelFeatureId.js:64-71](../packages/engine/Source/Renderer/WebGPU/WebGPUModelFeatureId.js) classifies feature IDs into texture/attribute/implicit, but lines 229-251 only consume the texture path. `FLAG_HAS_FEATURE_ID_ATTRIBUTE = 131072u` is defined but never set, and no attribute slot in the vertex layout.

**User-visible:** b3dm classic tiles with `_FEATURE_ID_0` as a per-vertex attribute render without per-feature styling; `Cesium3DTileStyle` expressions produce no color change on WebGPU.

---

### C-P17. IBL textures leaked on every env-map version change
**FIXED 2026-04-16 (Batch 14).** `dispatchIrradianceConvolution` and `dispatchRadiancePrefilter` in `WebGPUIBLPipeline.ts` now call `.destroy()` on any existing `cache.irradianceTexture` / `cache.radianceTexture` before replacing them. Per-face (and per-mip for radiance) `paramsBuffer` allocations are collected into a `leakedParamsBuffers` array during the dispatch loop and explicitly destroyed after `queue.submit` — WebGPU guarantees the buffer contents outlive the submit, so explicit destroy releases VRAM immediately. Per regen that was ~2.5 MB of texture + ~28 × 16 bytes of UBO leaking; now zero leak per rotation.

**Verified.** [WebGPUIBLPipeline.ts:113, 181](../packages/engine/Source/Renderer/WebGPU/WebGPUIBLPipeline.ts) replaces `cache.irradianceTexture` / `cache.radianceTexture` without calling `.destroy()` on the old one. Per-face per-mip `paramsBuffer` (lines 137-141, 216-220) allocated fresh per dispatch, never destroyed — ~28 leaked uniform buffers per IBL regen.

Composes with B-3 (env map stub): if/when env map changes, regeneration leaks.

---

### C-P18. Imagery HTMLImageElement upload without readiness check
**FIXED 2026-04-16 (Batch 14).** `WebGPUGlobeSurfaceRenderer._uploadImageSource` now returns `null` for not-yet-decoded HTMLImageElements (checks `!source.complete || source.naturalWidth === 0`); the caller's cache-miss path naturally retries on the next frame when `complete` flips to true. `WebGPUImageryReprojection.reprojectImageSourceWebGPU` adds the same guard and throws a clear error message instead of the cryptic "source is not in a valid state" from `copyExternalImageToTexture`, letting callers catch + retry. `WebGPUImageUpload.ts` was already well-structured around `createImageBitmap` (which internally handles decode) and doesn't need the same guard — its HTMLImageElement branch routes through `createImageBitmap` which waits for decode.

**Verified.** [WebGPUGlobeSurfaceRenderer.ts:2341-2344](../packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts) uploads `HTMLImageElement` with no check for `img.complete` or `await img.decode()`. If an imagery layer hands off a not-yet-decoded `<img>`, `copyExternalImageToTexture` throws "source is not in a valid state." Same hazard in [WebGPUImageryReprojection.ts:292](../packages/engine/Source/Renderer/WebGPU/WebGPUImageryReprojection.ts) and [WebGPUImageUpload.ts:170](../packages/engine/Source/Renderer/WebGPU/WebGPUImageUpload.ts).

`WebGPUCubeMapPanoramaRenderer.js:613` correctly awaits `img.complete` — contrast proves the pattern is known.

---

## HIGH findings

### H-P1. Tile-buffer destroy during in-flight frame has no reference guard
[WebGPUGlobeSurfaceRenderer.ts:2693](../packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts) `evictStaleResources()` unconditionally destroys vertex/index buffers. No check that the current frame's command list still references the tile. If eviction runs between `beginFrame()` and `endFrame()`, the open render pass holds a reference to a destroyed buffer → commandBuffer validation rejection → frame loss.

Same hazard at line 1355 when mesh generation changes. No reference counting anywhere in the WebGPU resource graph.

**Fix:** defer destroys to after `endFrame()`, or reference-count buffers through the frame submit.

### H-P2. No device-generation tracking for in-flight async
**Verified.** Grep for `deviceGeneration|recoveryGeneration|epoch|deviceId` in `Renderer/WebGPU/` returns zero matches. Async Promises started pre-recovery resolve post-recovery and:
- `createRenderPipelineAsync` Promise caches a pipeline bound to the destroyed device
- `mapAsync` callbacks touch buffers on the new device that used to live on the old
- `getCompilationInfo().then` logs errors from the old device

**Fix:** attach a monotonic `deviceEpoch` to every recovery; Promises attached to epoch N no-op on recovery.

### H-P3. Canvas reconfigure race
[WebGPUContext.ts:2550](../packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts) `resize()` calls `this._context.configure(...)` without checking `_currentRenderPassEncoder !== null`. Resize during a frame invalidates the already-bound texture view. Same concern for `_reconfigureCanvas()` at line 3792.

### H-P4. endFrame has no try/catch
[WebGPUContext.ts:1227-1256](../packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts) — if any prior malformed command marks the encoder invalid, `.finish()` throws before `_currentCommandEncoder` is nulled. Uniform allocator's `endFrame()` never runs; ring-buffer state drifts.

### H-P5. Multiple unfixed mapAsync destroyed-state hazards
**FIXED 2026-04-18 (Batch 26).** Remaining 3 unguarded paths closed: `WebGPUTextureUtilities.createPixelReadbackPBO.mapAsync`, `WebGPUContext.readPixelsToPBO.mapAsync` closure, `WebGPUGPUCuller.readResults`. Each now wraps the `mapAsync` + `getMappedRange` + `unmap` sequence in try/catch that returns a clean fallback (null / empty CullResults) instead of surfacing an unhandled promise rejection. Scoping confirmed `WebGPUHiZOcclusionDispatcher`, `WebGPUPickFramebuffer`, and `WebGPUTimestampProfiler` were already guarded via prior work (Batches 7–9 era).

**Earlier progress (for history) —** Batch 7 fixed WebGPUAutoExposure (captured buffer identity + unmap-on-reject + swap-out guard) and WebGPUBufferMapper upload + readback paths (added `_isDestroyed` check after await, unmap-on-destroy).

**Original finding —** Beyond the Session 31 fix to PickFramebuffer:
- [WebGPUBufferMapper.ts:128, 182](../packages/engine/Source/Renderer/WebGPU/WebGPUBufferMapper.ts) — no destroyed guard
- [WebGPUHiZOcclusionDispatcher.ts:728](../packages/engine/Source/Renderer/WebGPU/WebGPUHiZOcclusionDispatcher.ts) — no destroyed guard
- [WebGPUAutoExposure.ts:210-224](../packages/engine/Source/Renderer/WebGPU/WebGPUAutoExposure.ts) — no destroyed guard, also doesn't `unmap()` on rejection → permanent mapped state
- [WebGPUTextureUtilities.ts:278-284](../packages/engine/Source/Renderer/WebGPU/WebGPUTextureUtilities.ts) — no destroyed guard
- [WebGPUContext.ts:2097](../packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts) readPixelsToPBO closure — no destroyed guard

### H-P6. Device-loss cache clear is a short subset of actual resources
Beyond the prior review's C-R12, missing from `_clearAllCaches`:
- `shadowMap._webgpuCache` (depth textures, cast pipelines, uniform buffers)
- `csmRenderer._cascadeTexture` + `_cascadeParamsBuffer`
- `ibl._webgpuCache` + `brdfLutGenerator._webgpuCache.texture`
- `clippingPlaneCollection._webgpuCache.texture`, `clippingPolygonCollection._webgpuCache` (including the module-level `_sdfComputePipeline` at line 181)
- `dynEnvMapManager._webgpuCache.cubemapTexture`
- `volumetricFogRenderer` froxel volumes + integrated volume
- `weatherRenderer.particleBuffer/counterBuffer`
- `ssrCache` (normalTexture, uniformBuffer, pipeline)
- `invertClass._webgpuCache.classifiedTexture`
- Sun/Moon vertex/uniform buffers, pipelines, bind groups

After recovery, first frame dereferences destroyed-device textures → immediate OperationError.

### H-P7. Hardcoded Earth radius in multiple shaders breaks non-WGS84 ellipsoids
**FIXED 2026-04-16 (Batch 6) — partial.** CameraUniforms gained a new `ellipsoidRadius: f32` field (placed in the pre-existing `_pad3` slot after `minMaxHeight`). CPU packer reads `tileProvider._ellipsoid.maximumRadius` (or `.ellipsoid.maximumRadius`). All `GlobeTerrain.wgsl` call sites now use `camera.ellipsoidRadius` with a WGS84 fallback when the uniform isn't set. Mars/Moon/custom-ellipsoid terrains now do altitude math with the correct radius. `PrimitiveMatElev*.wgsl` hardcodes still remain for a later batch.

**Original finding —** [GlobeTerrain.wgsl:185, 328, 331, 346, 355](../packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl): `const EARTH_RADIUS: f32 = 6378137.0;`. Also `PrimitiveMatElev*.wgsl` uses `6371000.0` (different value — internal inconsistency). WebGL uses `czm_ellipsoidRadii` uniform.

For Mars / Moon / custom ellipsoids, vertical-exaggeration math and 2D/CV tile heights corrupted. Pertinent to Phase 8a foundation ellipsoid-aware audit but with specifics.

### H-P8. Polyline behind-camera clipping missing
[Collections/PolylineCollection.wgsl:70-104](../packages/engine/Source/Shaders/WebGPU/Collections/PolylineCollection.wgsl) does screen-space expansion after perspective divide without near-plane clipping. If `clipStart.w ≤ 0` (segment behind or straddling near plane), the quad wraps the viewport.

At planetary scale, polylines extending past the horizon flicker / render as full-screen bands.

**Fix:** port `czm_clipLineSegmentToNearPlane` to WGSL.

### H-P9. Instance-buffer dirty tracking broken for TimeDynamicPointCloud
[WebGPUPointCloudRenderer.ts:343](../packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudRenderer.ts) keys on `_pointsLength`. Identical point counts across animation frames reuse stale data.

### H-P10. Per-frame `new Float32Array(pointCount * 10)` + full CPU transform on every dirty frame
[WebGPUPointCloudRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudRenderer.ts) `buildInstanceBuffer` allocates + transforms every point via `Matrix4.multiplyByPoint` on rebuild, with `new Cartesian3()` allocs inside the loop. For planetary LiDAR (10M points), 100+ ms hitch on load. Upstream has positionsHighLow arrays already — should RTE-split at decode time.

### H-P11. ClippingPolygon SDF cached by polygon count only
[WebGPUClippingPolygonCollection.ts:67-71](../packages/engine/Source/Renderer/WebGPU/WebGPUClippingPolygonCollection.ts) — revision = `collection.length`. Polygon vertex edits with same count leave SDF stale. Also no Earth curvature correction — polygons > 100 km have meter-scale SDF error.

### H-P12. VolumetricFogComposite uses wrong depth linearization formula
[VolumetricFogComposite.wgsl:59-61](../packages/engine/Source/Shaders/WebGPU/PostProcess/VolumetricFogComposite.wgsl) assumes forward-Z (0 near, 1 far). Multi-frustum WebGPU depth semantics may be reverse-Z. Linearization inverts the froxel grid sampling.

### H-P13. Sun position falls back to static `(1.5e11, 0, 0)` when `frameState.sunPositionWC` unset
**FIXED 2026-04-16 (Batch 2).** Grep confirmed nothing in the engine assigns `frameState.sunPositionWC`, so the fallback was always taken and the sun never rotated. Resolution order is now: `frameState.context.uniformState.sunPositionWC` (the live value UniformState keeps updated per frame) → legacy `frameState.sunPositionWC` → static fallback. Sun now tracks Earth's day/night cycle on WebGPU as it does on WebGL.

**Original finding \u2014** [WebGPUEnvironmentRenderer.js:315-325](../packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js) \u2014 fallback to static sun direction that never rotates. NEEDS-VERIFICATION whether `Scene` always populates `frameState.sunPositionWC`.

### H-P14. Sun / Moon cache never invalidated on device loss
Not registered with `WebGPUDeviceLossRecovery`. After recovery, cached vertexBuffer / uniformBuffer / pipeline / bindGroup reference the dead device. Composes with H-P6.

### H-P15. SkyAtmosphere LUT sampling saturates at orbital altitude
**FIXED 2026-04-16 (Batch 2).** `sampleScatteringLut` now applies an exponential falloff `orbitFalloff = exp(-excessAltitude / thickness)` on the LUT-sampled inscatter when the camera is above the atmosphere. Orbital altitudes no longer produce identical haze \u2014 contribution decays with a scale-height equal to the atmosphere thickness (~100 km for Earth). Full LUT regeneration with a log-scale altitude axis remains a follow-up for true physical accuracy.

**Original finding \u2014** [SkyAtmosphere.wgsl:220-228](../packages/engine/Source/Shaders/WebGPU/Environment/SkyAtmosphere.wgsl) \u2014 altitude/thickness clamped to 1.0. Above atmosphere, every V coord is 1.0 \u2014 identical haze from LEO, GEO, and moon distance.

### H-P16. Shadow frustum doesn't track orbital camera
Single-cascade path only invokes `fitShadowMapToScene` when `_cascadesEnabled`. In the WebGPU non-CSM path, shadow camera is whatever was last computed — at orbital altitude, most pixels sample outside bounds. WGSL returns 1.0 (fully lit); shadows disappear at > few km camera height.

### H-P17. Placeholder image/atlas resolutions use 32×32 fallback
Billboards/labels backed by Promise-based `image:` use `32×32` for the first N frames before image arrives (verified in WebGPUBillboardRenderer:115-116 etc.). Pop-in after async-resolve.

### H-P18. CloudCollection shader-source via runtime `fetch()`
[WebGPUBillboardRenderer.js:40-49](../packages/engine/Source/Renderer/WebGPU/WebGPUBillboardRenderer.js) — `await fetch("../../Source/Shaders/WebGPU/Collections/BillboardCollection.wgsl")`. Path is fragile (depends on loader cwd). First-frame race: if collection destroyed mid-fetch, pipeline creation still runs.

### H-P19. Compute pipelines on hot compute-command path are sync
[WebGPUComputeEngine.ts:379](../packages/engine/Source/Renderer/WebGPU/WebGPUComputeEngine.ts) `_ensurePipeline` sync on first use of a new compute command. For point-cloud sort / Hi-Z / GPU cull, first-use is a dataset-change — stall.

### H-P20. Multi-frustum shadow-cast via WebGPUContext passes raw color commands to cast
[WebGPUContext.ts:2626-2700](../packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts) passes raw `castCommands` array to `shadowFR.renderCastPass`. Whether the shadow renderer actually builds a depth-only cast pipeline per vertex layout (correctly handling alpha-test) is NEEDS-VERIFICATION. If not, alpha-test leaf/fence shadows render as opaque.

### H-P21. `getPreferredCanvasFormat` fallbacks default to `"bgra8unorm"`
Multiple sites default to the literal when the format is missing. If an implementation ever returns `rgba8unorm` the pipeline's fragment-target format mismatches the canvas attachment → validation failure.

### H-P22. Texture format / sample-count mismatch risk with MSAA
MSAA color at `sampleCount: N`, depth at `sampleCount: 1`. Render-pass depth attachment MUST match color sampleCount. Prior review's M-R9; restated.

---

## MEDIUM findings

- **M-P1.** SkyAtmosphere scale heights hardcoded (Rayleigh 8500 m, Mie 1200 m). Mars/Titan break.
- **M-P2.** Moon log-depth formula uses pre-divide `clipW`; NEEDS-VERIFICATION against `czm_writeLogDepth` convention.
- **M-P3.** Moon `farPlane` uniform sourced from `currentFrustum.y` (per-slice), not outer far. Multi-frustum inconsistency.
- **M-P4.** Atmosphere pipeline NEEDS-VERIFICATION of `depthWriteEnabled: false`.
- **M-P5.** Moon new-moon phase drops to zero if `atmosphericConditions.lighting.enableEarthshine=false`; WebGL shows darkened disc.
- **M-P6.** `packSunUniforms` / `packMoonUniforms` use module-level scratch matrices; re-entry hazard in multi-context split-screen.
- **M-P7.** Model `ensurePrimitiveCache` short-circuits on key hit without revalidating material state → runtime material edits not picked up.
- **M-P8.** Gaussian splat `focalX/Y` computed from `P[0][0]/P[5][5]` — incorrect for oblique/off-axis projections.
- **M-P9.** Sun vertex buffer recreated on most frames (Cartesian3.equals on floating-point sunPos). Should use `queue.writeBuffer` on a persistent buffer.
- **M-P10.** glTF BLEND-mode premultiplication NEEDS-VERIFICATION; inline model tonemap may compose wrong with blend state.
- **M-P11.** User-denied-WebGPU, hardware-acceleration-disabled, and required-feature-unsupported all collapse to a generic RuntimeError on init. Upstream fallback logic has no signal to make informed decisions.
- **M-P12.** Imagery texture cacheKey can be overwritten by a late-arriving upload (no generation epoch).

---

## LOW findings

- **L-P1.** `WebGPUShaderCache.isDestroyed()` hardcoded to `false`.
- **L-P2.** `LabelRenderer.js:425` uses numeric literal `0` instead of `FeatureRendererKey.BILLBOARD_COLLECTION`.
- **L-P3.** CloudCollection has two live WGSL sources — one inline in TS (used), one in `Shaders/WebGPU/Collections/CloudCollection.wgsl` (orphan with different attribute layout).
- **L-P4.** `WebGPUTimestampProfiler` has no device-loss hook; query sets become zombies.
- **L-P5.** `WebGPUPointCloudRenderer` canvas-width fallback to 1920×1080 if `_canvas` undefined.
- **L-P6.** Global `getCompilationInfo().then` wrapper has no `.catch` — unhandled rejection on device-lost race.

---

## Recommended sequencing (composes with prior reviews)

### Tier FV0 — Fix the stubs (1 week, unblocks users today)

Each is a feature that's literally broken right now. If any must ship before the bigger fixes:

1. **B-6 Atlas cache invalidation** — Billboards/labels rendering as white rectangles is the most user-visible bug. One revision-counter change.
2. **C-P1 Model `_featureRenderer` assignment** — one-line fix prevents tab crash on tileset streams.
3. **B-8 Gaussian splat sort** — read `primitive._sortedIndices`, upload, draw indexed.
4. **B-9 GroundPrimitive stencil ops** — fix the DEPTH_FAIL_OP values.
5. **C-P4 Sun `pos.z = pos.w` clamp** — one line.

### Tier FV1 — Fix the RTE violations (2-3 weeks)

Each makes the difference between visually correct and visually broken at planetary scale:

6. **C-P2 Globe SCENE3D RTE via modifiedModelViewProjection** — one-branch change in `GlobeTerrain.wgsl`.
7. **C-P3 SkyAtmosphere vertex RTE** — remove `posH+posL`, redo altitude computation in RTE frame.
8. **B-1 Shadow cast RTE** — upload `VP_light × translate(cameraWorld)` or translate source-side.
9. **C-P5 Four broken collection renderers use `inverse(modelMatrix)*cameraWC`** — extract the helper, apply to Billboard/Polyline/Label/Cloud.
10. **C-P6 Fragment clipping planes in eye space** — upload `(normal_eye, dPrime)` uniforms.
11. **C-P7 VolumetricFog RTE** — fix camera pack + altitude computation.
12. **H-P7 Hardcoded ellipsoid radius → uniform** — one uniform + routing, enables non-WGS84.

### Tier FV2 — Fix the feature drops (3-4 weeks)

13. **C-P9 NearFarScalar / distance-display family** — the `csm_nearFarScalar.wgsl` helper exists; wire it and add per-billboard uniforms.
14. **C-P10 Scene 2D/CV/Morph on collections** — add morphTime uniform + projection switch in each collection WGSL.
15. **C-P11 Log depth everywhere** — add `czm_writeLogDepth` equivalent to Primitive + collection shaders; propagate `useLogDepth` uniform (compose with prior review's C-R2).
16. **C-P12 KHR_mesh_quantization dequantize** — honor `accessor.quantization` before f32 cast, or better, match quantized `vertexFormat` in the pipeline.
17. **B-5 InvertClassification 2-pass composition** — implement the FBO-swap pattern.
18. **C-P16 Feature ID attribute path (b3dm)** — wire the attribute consumer + FLAG_HAS_FEATURE_ID_ATTRIBUTE.

### Tier FV3 — Fix async lifecycle (2-3 weeks)

19. **C-P8 Async pipeline on model path** — `createRenderPipelineAsync` + "pending" skip-draw pattern + context-shared cache.
20. **H-P1 Tile-buffer destroy deferral** — defer destroys past `endFrame()`.
21. **H-P2 Device-generation epoch** — monotonic counter + Promise cancel logic.
22. **H-P3 Canvas reconfigure race guard**
23. **H-P5 mapAsync destroyed guards** — sweep remaining 5 sites.
24. **H-P6 Device-loss cache clear expansion** — add the missing subsystems to `_clearAllCaches` (or implement the subscriber pattern from the prior review's C-R12).
25. **C-P18 HTMLImageElement readiness check** — always `await img.decode()`.

### Tier FV4 — Feature completeness (multi-session)

26. **B-2 Real CSM** (per CSM_DESIGN.md)
27. **B-3 Real DynamicEnvironmentMap** (scene capture + prefilter)
28. **B-4 SSR with a real normal G-buffer** (Phase 8a Foundation)
29. **B-7 Real voxel renderer** (wire VoxelTraversal megatexture)
30. **C-P13 TDPC proper dirty tracking**
31. **H-P8 Polyline near-plane clipping**
32. **C-P14 EDL** (or explicit warning)

---

## What this review is saying, clearly

1. The WebGPU fork is **not** at feature parity with WebGL today. Several published features (CSM, DynamicEnvMap, SSR, InvertClassification, Voxels) are placeholder stubs that ship with no warning.
2. Many features that LOOK implemented (Billboards, Labels, Models, Gaussian Splats, VolumetricFog) are **fundamentally broken at planetary scale** because of RTE violations or missing dirty tracking.
3. Large families of public APIs are silently ignored on WebGPU (DistanceDisplayCondition, scaleByDistance, eyeOffset, Scene 2D/CV).
4. Resource lifecycle on the hot tileset path is broken — Model destroy callback never runs, causing a guaranteed leak on every eviction.
5. The async nature of WebGPU is not respected on the hot path — sync pipeline compiles stall every tile-stream encounter.

**The combined prior two reviews + this review collectively describe ~12–16 weeks of focused work** to reach a "WebGPU backend is a genuine drop-in replacement for WebGL" state. That's substantially more than the prior review's 4–6 week estimate because the prior review was cross-cutting; this review was per-feature and found much more.

None of this is a referendum on the architecture. The FR/GraphicsContext/RenderCommand abstractions are still right. The execution layer on top of them is under-implemented.

---

## Appendix: NEEDS-VERIFICATION items (next-session work)

- Moon scene-mode gating (is `Moon.js:update()` early-returning in SCENE2D? — determines whether H-N1/H-N5 class of findings applies)
- Sun embedded shader `pos.z = pos.w` clamp (agent-verified, my grep didn't match; code-read confirmed behavior)
- Cast pipeline is actually depth-only (H-P20) — or reuses color pipeline?
- MSAA depth/color sample-count pairing under `msaa: 4`
- Atmosphere pipeline `depthWriteEnabled` state
- `frameState.sunPositionWC` always populated before WebGPU env render
- `WebGPUModelRenderer.js:445` caller behavior with async pipeline cache (Promise vs. pipeline object)
- `ModelPBRComplete.wgsl:176` `positionMC: vec3<f32>` empirical shimmer measurement at city-scale 3D Tiles ECEF
- Double-tonemap in model path (inline tonemap + post-process tonemap)

---

## Appendix: Agent findings I did NOT verify directly this pass

Marked "NEEDS-VERIFICATION" in the body. Roughly 15-20% of reported findings fall in this bucket. The CRITICAL/BLOCKER tier has been independently verified; the HIGH tier has been sampled. Next-session readers should re-verify before acting.

---

*Report prepared 2026-04-16. This is the third review in the 2026-04-16 series. Combined with the prior two reviews, the overall finding set describes the state of the fork on that date. All line numbers valid at that date. Re-verify before acting on stale references.*
