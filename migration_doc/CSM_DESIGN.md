# Cascaded Shadow Maps (CSM) — Design Document

**Status:** Phase 4 visual quality closure — design only, implementation deferred to a focused 4-5 day session.
**Created:** 2026-04-09
**Owner:** WebGPU migration

---

## Why CSM

The fork's current shadow path uses a single `ShadowMap` (depth-only render target, default 2048×2048) covering the camera frustum's full far-plane extent. For a Cesium scene this is the worst case:

- **Tiny shadow texels at far range**: a 2k shadow map covering a 100km terrain frustum gives ~50m per shadow texel. Far buildings cast no shadow; near buildings cast jagged 50m-quantized shadows.
- **Wasted resolution at near range**: the same 2k map's near-camera region has way more resolution than needed (centimeters per texel), so the budget is misallocated.
- **No view-dependent splits**: zoom out and the shadow map suddenly covers a larger region without any dynamic split adjustment.

CSM splits the camera frustum into N depth ranges (typically 3 or 4), renders each range into its own shadow map at full resolution, and the fragment shader picks the appropriate cascade per pixel based on view-space depth. This gives high-resolution shadows where the eye actually looks (near range) without paying for unnecessary detail at the horizon.

## Architecture

### New files

- `Source/Shaders/WebGPU/Shadow/ShadowCastCSM.wgsl` — replacement for the current `WebGPUShadowMapRenderer` cast shader, parameterized over cascade index. Reuses the existing per-vertex-layout cache (rte24 + p12 variants from S25 + 2026-04-09 work).
- `Source/Shaders/WebGPU/Shadow/ShadowReceiveCSM.wgsl` — fragment-side cascade selection helper (chunk, included by terrain + primitive shaders).
- `Source/Renderer/WebGPU/WebGPUCSMRenderer.ts` — the cascade-aware shadow renderer. Owns:
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
- **EffectsUniforms struct size (added 2026-04-11)**: the shared EffectsUniforms UBO was extended to 240 bytes (from 112) by Phase 5 WGF-1, adding `clipPlaneEqHW: array<vec4<f32>, 8>` (128 bytes). The CSM receive shader's `ShadowReceiveCSM.wgsl` chunk must include the full 240-byte struct (including the WGF-1 tail) so the bind group layout matches the shared effects BGL. The cascade-specific fields (4 VP matrices, 4 split distances) should go in a **separate UBO** (new binding in group 3) rather than further extending EffectsUniforms, to keep the shared struct stable.

## Acceptance criteria

- A scene with a building near the camera (50m away) and another at 5km shows full-resolution shadows on both, with the cascade transition not visible to the eye
- Slow orbit over the same scene shows no texel shimmer
- Snapshot mode + CSM composes: frozen frame's cascade textures stay valid, no per-frame cast pass
- `Scene.getDebugSnapshot().renderer.csmStats` reports per-cascade `{ splitDistance, sphereRadius, snappedCenter, dispatched }`

## Spec coverage delta

- `Specs/Renderer/WebGPU/WebGPUCSMRendererSpec.js` — split computation (uniform vs logarithmic vs blend), per-cascade frustum corner extraction, bounding sphere fit, texel snap round-trip, snapshot freezable contract.

## Stretch: variance shadow maps (VSM)

Once the cascade infrastructure lands, the next quality bump would be replacing the per-cascade depth32float textures with rg32float (depth + depth²) and a 2-pass Gaussian blur, enabling soft shadows without PCF kernel sampling. Estimated +1 day on top of CSM. Tracked as a separate follow-up.
