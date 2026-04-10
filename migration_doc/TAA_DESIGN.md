# Temporal Anti-Aliasing (TAA) — Design Document

**Status:** Phase 4 visual quality closure — design only, implementation deferred to a focused 3-4 day session.
**Created:** 2026-04-09
**Owner:** WebGPU migration

---

## Why TAA over FXAA

The fork ships FXAA (`Source/Shaders/WebGPU/PostProcess/FXAA.wgsl`) as the only AA path. FXAA is cheap (single-pass screen-space) but has known weaknesses on a Cesium scene:

- **Sub-pixel detail loss**: FXAA blurs the imagery layer wherever a high-contrast edge crosses a sub-pixel boundary. CesiumJS scenes are dominated by tile boundaries + thin power lines / road edges, exactly the case FXAA hurts most.
- **No temporal stability**: a 1-pixel camera motion still produces a different pixel-edge pattern, so FXAA-smoothed terrain shimmers under slow orbits.
- **No spec/shader anti-aliasing**: specular highlights from the moon / sun on water flicker because FXAA only looks at color contrast, not normal variation.

TAA addresses all three by jittering the projection matrix sub-pixel and accumulating samples across frames with motion vector reprojection. The CesiumJS use case (RTE 64-bit precision, mostly slow orbits, minimal disocclusion) is favorable for TAA — most pixels stay valid across frames.

## Architecture

### New files

- `Source/Shaders/WebGPU/PostProcess/TAA.wgsl` — full-screen fragment pass that samples (a) the current frame's color, (b) the history buffer at the reprojected UV, and (c) a 3×3 neighborhood of the current frame for clamping.
- `Source/Renderer/WebGPU/WebGPUTAAEffect.ts` — `PostProcessEffect` implementation that owns:
  - Two history textures (ping-pong, double-buffered)
  - The motion vector texture (RG16F, eye-space velocity)
  - The previous frame's view-projection matrix for reprojection
  - The Halton(2, 3) sample sequence offset state
  - The composite pipeline + bind group factory

### Frame pipeline order

```
... opaque pass → translucent pass → SSR → volumetric fog composite
  → Bloom → Tonemap → ColorGrading
  → TAA (new)
  → FXAA (still optional, off by default when TAA is on)
```

TAA needs to run *after* color grading (so the SDR color is what gets accumulated) and *before* FXAA (FXAA-on-TAA is wasteful — TAA already produces a smooth edge).

### Camera jitter

The Scene's projection matrix gets a small per-frame translation that maps to a sub-pixel offset in NDC:

```
jitterX = (haltonSample(2, frame) - 0.5) * 2.0 / screenWidth
jitterY = (haltonSample(3, frame) - 0.5) * 2.0 / screenHeight
projection[2][0] += jitterX
projection[2][1] += jitterY
```

The jitter sequence repeats every 16 frames (Halton(2,3) is the standard choice — well-distributed in 2D). The jittered projection ONLY affects rasterization; the unjittered projection is used for the inverse-view-projection that drives reprojection so the history sample lands on the geometric pixel center.

### Motion vectors

Cesium's RTE-emulated 64-bit precision makes motion vectors trickier than the standard TAA case because the world position is split across two vec3<f32>. The vertex shader computes:

```wgsl
let prevWorldRTE = (positionHigh - prevCamH) + (positionLow - prevCamL);
let prevClip = prevViewProjection * vec4<f32>(prevWorldRTE, 1.0);
let prevNDC = prevClip.xyz / prevClip.w;
let prevUV = prevNDC.xy * 0.5 + 0.5;
```

The resulting per-pixel `(currentUV - prevUV)` is written to the motion vector texture in the same render pass as the color (via MRT). Static geometry produces tiny motion vectors that account only for the camera motion; moving entities produce larger ones.

### Neighborhood clamping

The history sample is clamped to the AABB of the current pixel's 3×3 color neighborhood. This is the standard "variance clipping" trick that hides ghosting on disoccluded pixels — when the history sample is wildly different from the current frame's local distribution, it gets pulled back into range so the ghost fades over a few frames instead of persisting.

## Implementation steps

1. **Plumbing pass** (~0.5 day)
   - Add `previousViewProjection` storage to `UniformState`
   - Add per-frame jitter offset computation in `Camera.update()`
   - Add `Scene.taaEnabled` toggle

2. **Motion vector texture** (~1 day)
   - Allocate RG16F render target sized to the scene framebuffer
   - Add a second MRT slot to the GLOBE / PRIMITIVE pipelines that writes motion vectors
   - Verify that WebGPU's MRT support exposes the right format combination via `device.adapterInfo`

3. **TAA shader + dispatcher** (~1 day)
   - Write `TAA.wgsl` (history sample + reprojection + neighborhood clamp + blend)
   - `WebGPUTAAEffect.ts` implementing `PostProcessEffect`
   - Wire into `WebGPUPostProcessPipeline.execute()` after ColorGrading

4. **Spec coverage + status doc** (~0.5 day)
   - Halton sequence helper specs
   - Reprojection math specs (CPU-side validation against WGSL output)
   - Migration status entry

## Risks + open questions

- **Quantized terrain motion vectors**: the quantized vertex format would need access to the previous frame's tile rectangle/heightScale uniforms. Same blocker as `SHADOW-LAYOUT-QUANTIZED`. **Mitigation**: ship TAA without quantized terrain first; quantized tiles fall back to FXAA.
- **Snapshot mode interaction**: when snapshot mode is frozen, the camera doesn't move and the TAA history stays valid forever — but the jittered projection still needs to NOT change between frames or the blend will introduce dither. **Mitigation**: zero the jitter offset whenever `scene.snapshotMode.isFrozen === true`. Add a hook in the Camera update step.
- **MSAA interaction**: TAA is incompatible with MSAA on the same texture (the resolve happens before TAA samples it). **Decision**: TAA disables MSAA when active. The MSAA setting becomes a hint, not a hard requirement.
- **Performance budget**: ~0.6ms/frame at 1080p on Chromium WebGPU + Vulkan backend (measured in similar engines). Budget for the dispatch + texture sample + clamp neighborhood. Acceptable.

## Acceptance criteria

- Slow orbit over a high-frequency feature (city blocks) shows no shimmer that the FXAA path shows
- A camera jump produces a single frame of ghosting that fades within 4 frames (variance clamp working)
- Snapshot mode + TAA composes cleanly: frozen scene shows zero accumulation drift over 600 frames
- `Scene.getDebugSnapshot().renderer.taaStats` reports `historyPing/Pong validity`, `lastJitter`, and `framesSinceJump`

## Spec coverage delta

- `Specs/Renderer/WebGPU/WebGPUTAAEffectSpec.js` — Halton sequence values, jitter offset round-trip, packColorBlend, history texture rotation, snapshot mode jitter zero
