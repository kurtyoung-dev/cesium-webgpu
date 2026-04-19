# Temporal Anti-Aliasing (TAA) — Design Document

**Status:** Slice 1 SHIPPED (Session 34). Slices 2-4 pending.
**Created:** 2026-04-09
**Last updated:** 2026-04-18 — Slice 1 shipped with depth-reprojection architecture (Option C) instead of the original MRT motion-vector plan. See "Slice 1 shipped architecture change" below.
**Owner:** WebGPU migration

## Implementation slices

Full TAA integration with every Cesium feature (RTE, globe, 3D Tiles, skinned/morphed/instanced models, sun/moon/skybox, particles, orbital content, CSM interaction, picking, WebGL parity) is a 10–14 day effort. To deliver visible progress per session without half-finished code, the work is split into four vertical slices. Each slice is independently verifiable.

| Slice | Scope | Duration | Status |
|---|---|---|---|
| **Slice 1** — camera jitter + RTE motion vectors + history blend | Halton(2,3) 8-sample jitter applied to `frustum.projectionMatrix` per frame (snapshot-freeze zeros it). `UniformState` gained model-independent `viewProjectionRelativeToEye` + `previousViewProjectionRelativeToEye` + `previousCameraPosition` (snapshotted at top of `update()`). **Motion vectors reconstructed in the TAA shader via depth reprojection** (Option C — no MRT output from main-scene shaders needed). History ping-pong + neighborhood AABB clamp retained from Batch 27. Works for static terrain + static phong primitives. Scene toggle `scene.taaEnabled` off by default. | 1 session (34) | **SHIPPED 2026-04-18** |
| **Slice 2** — per-model MRT motion + sky reprojection + ugly cases | Per-object MRT motion vectors for skinned / morphed / instanced primitives (depth reprojection treats these as static; per-model delta fixes it). Sky reprojection path for `depth >= 1.0` fragments (camera-rotation-only). Strengthened disocclusion detection. History invalidation on large `cameraDelta` (teleport / `camera.flyTo` landing). | 1 session | 🟡 2a shipped (sky + teleport); 2b MRT pending |
| **Slice 3** — variance clipping refinements + particles | 3×3 YCoCg neighborhood clipping (upgrade from current tonemap-space AABB). Particle `previousPositionWC`. Labels / billboards compositing verification. | 1 session | Pending |
| **Slice 4** — 3D Tiles + picking + CSM interaction + WebGL parity | 3D Tiles tile pop-in sets NaN motion for disocclusion reject. Picking un-jitters depth readback. Verify CSM + TAA compose (shadow edges need motion-correct reprojection). WebGL backend TAA via MRT + GLSL accumulate. Visual verification pass. | 1 session | Pending |

## Slice 1 shipped architecture change (Option C over Option A)

**Original plan (2026-04-09):** motion vectors emitted as a second MRT color attachment from every primary shader (globe, primitive, model, billboard, polyline). This is the "textbook" TAA architecture — each shader writes its screen-space velocity alongside its color.

**Audit finding (2026-04-18):** three architectural options were surveyed before Slice 1 landed:

- **(A) MRT from main-scene passes** — every primary shader emits motion vectors as a second color attachment. High coverage but every shader + framebuffer format needs changes. Rejected for Slice 1 scope.
- **(B) Separate motion-vector geometry pass** — costs a full geometry re-raster + CPU complexity around variant selection. Rejected.
- **(C) Depth reprojection in the TAA shader** — zero new render targets, depth texture already bound, motion vectors reconstructed per-pixel from `{currentMvpRTE, previousMvpRTE, cameraDelta}`. Works for both static AND animated geometry to a first approximation (per-pixel depth is what drives the reprojection — animated per-object motion is a Slice 2 refinement).

**Chose Option C.** Rationale: depth reprojection gives correct motion vectors for the entire static scene (terrain, static buildings, ground primitives) with zero changes to the main-scene render path. Skinned / morphed / instanced models get treated as static for Slice 1 (the per-object motion fix is a narrow Slice 2 exception — a few additions, not a global MRT refactor).

## Slice 2a shipped (2026-04-18) — sky reprojection + teleport invalidation

Two of Slice 2's four scopes landed this session. Both are small, self-contained, and verifiable. The remaining two (per-model MRT motion, strengthened disocclusion detection) require larger infrastructure changes and defer to Slice 2b.

### Sky reprojection — SHIPPED

Slice 1 treated the skybox as static (depth >= 1.0 returned identity UV), so rotating the camera smeared the history sky over the new frame's sky. Correct behavior: sky pixels should reproject via the camera's rotation, ignoring translation (points at infinity don't translate in screen space).

**Fix** ([TAA.wgsl](../packages/engine/Source/Shaders/WebGPU/PostProcess/TAA.wgsl)):

- **Depth clamp to 0.9999.** `inverse(projection) · (x, y, 1, 1)` diverges at the far plane (`w → 0`). Clamping to just inside far keeps the unprojection finite. Screen-space error bound: `(1 - 0.9999) × far ÷ far = 10⁻⁴` NDC — sub-pixel even at 4K.
- **Zero cameraDelta for sky pixels.** At far-plane eye magnitudes (10⁷–10⁸ m), FP32 ULP is ~1 m — a per-frame cameraDelta of 10 m is below ULP, so `eyePosCurr + cameraDelta` loses the delta entirely to catastrophic cancellation. Mathematically, translation contribution at infinity IS zero; explicitly zeroing avoids any accumulated precision artifacts from FP32 rounding.
- **Standard reprojection path used for both sky and scene.** One branch (`isSky = rawDepth >= 1.0`) feeds a `select()` that picks between the full cameraDelta and `vec3<f32>(0.0)`. No divergent code path; the only difference from scene pixels is the zeroed translation.

### Teleport history invalidation — SHIPPED

Slice 1 kept history valid regardless of camera motion magnitude. Teleports (e.g., `camera.flyTo` landing, user-initiated viewer reset, mouse wheel through the planet) jump 10s to 1000s of km in a single frame. Depth reprojection produces garbage for the entire frame when every pixel's NDC motion exceeds the screen — the neighborhood clamp can't recover in time, and the user sees a 2–4 frame smear.

**Fix** ([Scene.js](../packages/engine/Source/Scene/Scene.js)):

- Compute `|cameraDelta|²` on CPU (already doing FP64 subtraction there).
- If `|cameraDelta| > 50 km`, pass `historyValid = false` to `updateMotionVectorParams`. The TAA shader already handles `historyValid == 0 → return uv` which effectively restarts the blend on this single frame. Next frame the history is the teleported-frame's output — valid again.
- Threshold rationale:
  - Typical orbit motion: ≤ 10 m/frame — never triggers
  - Fast mouse-drag pan at 500 km altitude: ~200 m/frame — never triggers
  - `flyTo` arrival snap: ~∞ on landing frame — triggers as expected
- Future: scale threshold by altitude if an animation legitimately crosses 50 km/frame (unusual — most Cesium content falls well under this).

### Spec coverage

[WebGPUTAASkyAndTeleportSpec.js](../packages/engine/Specs/Renderer/WebGPU/WebGPUTAASkyAndTeleportSpec.js) locks:

- WGSL `depth = min(rawDepth, 0.9999)` + `isSky = rawDepth >= 1.0` + `select(cameraDelta, vec3(0.0), isSky)` patterns
- Removed Slice 1 `depth >= 1.0 → return uv` early-out
- Preserved Slice 1 guards (historyValid, behind-camera, offscreen)
- Numerical sanity: depth-clamp screen error sub-pixel, ULP-loss ratio justifying zero-out at far-plane scale

### Still pending in Slice 2

- **Per-model MRT motion vectors** for skinned / morphed / instanced primitives. Depth reprojection treats them as static; animated geometry ghosts across frames. Fix: add a second MRT color attachment to model pipelines, emit per-pixel velocity computed from `(currentClip - previousClip)` with matching prev-frame joint / morph / instance UBOs. Touches every model pipeline + the model UBO layout + TAA shader to prefer MRT samples when available. Meaningful infrastructure — defers to Slice 2b.
- **Strengthened disocclusion detection.** Current AABB clamp is tonemap-space 3×3. Slice 3 candidate: YCoCg 3×3 variance clipping per the original design doc.

## Slice 1 shipped — RTE motion-vector math

At Earth scale (6.37M m radius) FP32 has ~0.76m ULP. The textbook formula `worldPos = inverse(currVP) * ndc; prevNdc = prevVP * worldPos` loses precision at the world-space reconstruction step — motion-vector error becomes multi-pixel during orbital fly-to, exactly when TAA matters most.

**Fix:** reproject in **eye-relative space** with a `cameraDelta` correction. All intermediate values stay within view-frustum scale (km at most); `cameraDelta` is computed in FP64 on CPU so the 6.37M-magnitude camera positions cancel cleanly before down-casting to FP32 for the GPU.

```wgsl
ndcCurr = vec3<f32>(uv*2-1, depth)           // WebGPU NDC, depth in [0,1]
eyePosCurr = inverse(currentVpRte) * ndcCurr // camera-relative to CURRENT frame
eyePosPrev = eyePosCurr + cameraDelta         // cameraDelta = currWC - prevWC (FP64 on CPU)
ndcPrev = previousVpRte * eyePosPrev
prevUV = ndcPrev.xy * 0.5 + 0.5              // with WebGPU Y-flip
```

**CPU-side plumbing (Session 34):**

- [UniformState.js](../packages/engine/Source/Renderer/UniformState.js) — new model-independent `viewProjectionRelativeToEye` lazy field (projection × view-with-translation-zeroed) + getter. New `previousViewProjectionRelativeToEye` and `previousCameraPosition` captured at the top of `update()` BEFORE `updateCamera` runs (so they truly hold last frame's state). Using the model-independent form makes the snapshot safe regardless of what model matrix the last draw command set.
- [UniformStateComputations.js](../packages/engine/Source/Renderer/UniformStateComputations.js) — `cleanViewProjectionRelativeToEye()` helper + dirty flag wired into `setView` / `setProjection`.
- [WebGPUTAAEffect.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUTAAEffect.ts) — TAA params UBO grew 32 → 256 bytes. New fixed offsets: `currentVpRte` (32), `previousVpRte` (96), `inverseCurrentVpRte` (160), `cameraDelta` (224), plus `historyValid` flag at the tail of the prefix block. New `updateMotionVectorParams()` public API. CPU-side `_invertMatrix4` helper (FP64, Cesium Matrix4.inverse equivalent, kept local to avoid Matrix4 import coupling into this TS module).
- [Scene.js](../packages/engine/Source/Scene/Scene.js) — alongside the existing Halton jitter application, pulls the matrices + `cameraDelta` from UniformState and pushes them into the TAA effect every frame. `historyValid` gated on `frameNumber > 1` so the first frame skips reprojection.

**GPU-side (TAA.wgsl):** new `reprojectUV()` helper. Falls back to identity UV in four cases: `historyValid == 0` (first frame), `depth >= 1.0` (sky — Slice 2 fix), `clipPrev.w <= 0` (behind previous camera), `prevUV` out of [0,1] (disocclusion / offscreen). Y-flip matches WebGPU cascade sampling convention. Neighborhood AABB clamp (tonemap-space, 3×3) unchanged from Batch 27.

**Sanity checks.** `tsc --noEmit` clean; `gulp build` clean at 13.1 MB / 23.7 MB sourcemap (up ~100 KB for the TAA matrix fields + shader math); Node matrix-inverse test confirms `_invertMatrix4 · M == I` bit-exact on a perspective-like matrix.

## Cesium feature integration — how each slice handles it

| Cesium feature | Slice 1 | Slice 2 | Slice 3 | Slice 4 |
|---|---|---|---|---|
| **RTE 64-bit precision** | `previousEncodedCameraHigh/Low` cached on `UniformState`; reprojection uses previous-frame RTE encoding so motion vectors don't carry spurious precision drift. | — | — | — |
| **Whole-earth globe terrain** | Static-tile motion vectors wired. | Accumulation integrates them. | Vertical-exaggeration change + 2D/CV morph transitions handled (both frames' positions computed in shader). | — |
| **Space / orbital camera** | Halton jitter stays in pixel-space regardless of altitude — no special handling at jitter injection. | — | Orbital content gets large motion vectors; accumulator caps `motionLength` before rejecting. | Verify with satellite tracking + ISS-altitude fixture. |
| **3D Tiles** | Per-tile model matrix cached prev-frame. | Accumulates. | — | Tile pop-in sets NaN motion (disocclusion reject). Tile LOD transitions fade through motion history. |
| **Sun / Moon / SkyBox** | — | — | Zero-velocity (un-jitter only; these are effectively at infinity). | — |
| **SkyAtmosphere** | — | Indirect via terrain terrain MV reaching the fog blend. | — | — |
| **Animated / skinned models** | Static-mesh path only. | — | Prev-frame skin matrices + morph weights on the model UBO. VS runs twice (once per uniform block) to produce prev + curr clip-space positions. | — |
| **Instanced models** | — | — | Prev + curr instance matrices; instance data buffer doubled (or ping-ponged). | — |
| **Particles / weather** | — | — | `previousPositionWC` added to particle simulation state. | — |
| **CSM interaction** | — | — | — | Shadow transitions need motion-correct reprojection or shadow edges ghost. Verify on scene with moving occluder. |
| **Picking (async depth readback)** | — | — | — | Un-jitter pick depth on resolve: `pickedPos -= inverseJitter[requestFrame]`. |
| **Labels / billboards** | — | — | — | TAA is opaque-pass only; labels composite on the TAA-resolved color (already translucent). Verify no artifacts at sub-pixel label edges. |
| **WebGL backend parity** | — | — | — | MRT motion-vector path + GLSL ES 3.00 TAA accumulate fragment. Shares history-buffer ping-pong logic. |
| **Snapshot / freeze mode** | Pause jitter phase while frozen (snapshotVersion unchanged). | — | — | — |
| **FXAA composition** | — | TAA resolve → FXAA reads the TAA-resolved color. TAA writes `taaResolvedColorTexture`, FXAA's input is rebound to that. | — | — |

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
- **HDR pipeline interaction (added 2026-04-11)**: the post-process ping-pong textures are currently SDR (`bgra8unorm`), so TAA will accumulate **post-tonemap SDR** colors in its history buffer. This is the correct position — TAA after tonemapping means the variance clamp operates on perceptually-uniform values. If the HDR pipeline fix lands (promoting ping-pong to `rgba16float`), TAA must move to **before** tonemapping so it accumulates linear HDR, and the variance clamp thresholds must be retuned for the wider value range.
- **Phase 5 WGF-3 shader-f16 interaction (added 2026-04-11)**: the f16 tonemapping variant runs before TAA. Since tonemapping output is SDR [0,1], f16's 10-bit mantissa (~3 decimal digits) provides more than enough precision for TAA's neighborhood clamp (which compares against 8-bit display precision). No interaction concern.

## Acceptance criteria

- Slow orbit over a high-frequency feature (city blocks) shows no shimmer that the FXAA path shows
- A camera jump produces a single frame of ghosting that fades within 4 frames (variance clamp working)
- Snapshot mode + TAA composes cleanly: frozen scene shows zero accumulation drift over 600 frames
- `Scene.getDebugSnapshot().renderer.taaStats` reports `historyPing/Pong validity`, `lastJitter`, and `framesSinceJump`

## Spec coverage delta

- `Specs/Renderer/WebGPU/WebGPUTAAEffectSpec.js` — Halton sequence values, jitter offset round-trip, packColorBlend, history texture rotation, snapshot mode jitter zero
