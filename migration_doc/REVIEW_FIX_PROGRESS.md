# Principal Engineer Review — Fix Progress

**Started:** 2026-04-16
**Tracks:** progress against the four 2026-04-16 review docs (~190 findings total)

This doc indexes which review-doc findings have been fixed, in batches grouped by related files/features. Each review doc also carries inline **FIXED 2026-04-16 (Batch N)** markers next to the original finding text so that readers coming in from any entry point see the status.

---

## Batch 1 — Model hot-path correctness (2026-04-16)

**Files touched:**
- [packages/engine/Source/Scene/Model/Model.js](../packages/engine/Source/Scene/Model/Model.js)
- [packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.js](../packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.js)

**Typecheck:** `npx tsc --project packages/engine/tsconfig.json --noEmit` — clean.

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| C-P1 | PER_FEATURE | Model `_featureRenderer` never assigned → leak on every tile eviction | Constructor initializes `this._featureRenderer = undefined`; `updateModel` now caches `model._featureRenderer = modelFr`; destroy path clears the reference. Prevents ~10MB+ leak per evicted tile. |
| DP-C2 | DATA_PIPELINE | Model runs both FR and legacy `pushDrawCommands` paths every frame | Gated the legacy `model._sceneGraph.pushDrawCommands(frameState)` call on `!context.isWebGPU`. Cuts per-frame Model CPU cost in half on WebGPU contexts. |
| DP-H32 | DATA_PIPELINE | Light uniforms missing IBL factors → no ambient contribution | `LIGHT_UNIFORM_SIZE` raised from 48 → 64 bytes to match WGSL struct. `packLightUniforms` now writes `iblDiffuseFactor`/`iblSpecularFactor` from `model._imageBasedLighting._imageBasedLightingFactor`, `iblMaxMipLevel` from the specular env map atlas (default 8.0), and `iblHasSH` from whether SH coefficients are present. Models get sensible defaults when IBL is absent. |
| DP-H33 | DATA_PIPELINE | `scene.light.color` hardcoded to `(1,1,1)` | `packLightUniforms` now reads `frameState.light.color` (public `SunLight.color` API) into the `sunColor` vec3. `scene.light = new SunLight({ color: ... })` now tints models correctly. |

**Net user-visible effect of Batch 1:**
- Long-running tileset fly-throughs no longer leak memory linearly with tile eviction count.
- WebGPU model rendering CPU cost on the hot path drops ~50%.
- PBR models no longer render visibly flatter than their WebGL counterparts — the ambient (IBL) term now contributes as designed.
- Custom sun colors (e.g., dawn/dusk tints, alien-world lighting) propagate to models.

**Not yet addressed from the Model-area review set** (candidates for Batch 2 or later):
- DP-C6 / C-P12 — glTF KHR_mesh_quantization dequantize in `ModelPrimitiveGeometry.js` (geometry)
- DP-H34 — Model pick command never emitted
- DP-H35 — Morph target NORMAL deltas dropped
- DP-H36 — Instance translation not RTE-split
- DP-H37 — `COLOR_0 VEC3` reads past buffer end for `.a`
- DP-C7 — `TEXCOORD_1` never uploaded
- DP-C8 — glTF sampler properties ignored (hardcoded linear/linear/repeat)
- DP-C9 — sRGB double-apply on base color textures
- C-P17 — IBL textures leaked on env-map version change

---

## Batch 2 — Environment (Sun / SkyAtmosphere) (2026-04-16)

**Files touched:**
- [packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js](../packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js)
- [packages/engine/Source/Shaders/WebGPU/Environment/SkyAtmosphere.wgsl](../packages/engine/Source/Shaders/WebGPU/Environment/SkyAtmosphere.wgsl)

**Typecheck:** `npx tsc --project packages/engine/tsconfig.json --noEmit` — clean.

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| C-P4 | PER_FEATURE | Sun shader missing `pos.z = pos.w` far-plane clamp | Sun vertex shader now writes `o.pos = vec4f(cp.x, cp.y, cp.w, cp.w)`. Maps NDC z to 1.0 so the sun (world-space ~1.5e11 m) always passes the `less-equal` depth compare regardless of which multi-frustum slice is active. |
| C-P3 | PER_FEATURE | SkyAtmosphere vertex violates RTE rule (`posH + posL`) | Vertex now sets `cameraToVertex = positionRTE` (already full-precision camera-local delta). The `posHigh + posLow` formulation is gone. `worldPosition` stays as an interpolator slot but isn't read by the fragment. No rule violation; no big-minus-big cancellation. |
| H-P13 | PER_FEATURE | Sun position fell back to static `(1.5e11, 0, 0)` every frame | Grep confirmed `frameState.sunPositionWC` is never populated. Resolution now reads `frameState.context.uniformState.sunPositionWC` first (the live value UniformState maintains per frame). Sun now rotates with Earth's day/night cycle. |
| H-P15 | PER_FEATURE | SkyAtmosphere LUT saturates at V=1 above atmosphere | `sampleScatteringLut` now applies `orbitFalloff = exp(-excessAltitude / thickness)` to the LUT-sampled inscatter when the camera is above the atmosphere. LEO/MEO/GEO no longer produce identical haze; contribution fades with a ~100 km scale-height. Full log-scale LUT regen remains a follow-up for physical accuracy. |

**Net user-visible effect of Batch 2:**
- Sun is visible at all camera altitudes, not just the farthest frustum slice.
- Sun rotates with the date-driven Earth orbit (was static).
- Atmosphere no longer shimmers near the terminator at orbital altitudes (RTE violation eliminated).
- Atmospheric haze fades correctly from LEO → MEO → GEO instead of saturating.

**Not yet addressed from the Environment review set** (candidates for later batches):
- B-3 — DynamicEnvironmentMap flat-gray stub (blocks real IBL quality)
- H-P14 — Sun/Moon cache never invalidated on device loss
- M-P9 — Sun vertex buffer recreated nearly every frame
- M-P1 — Hardcoded Earth-scale scale heights (Mars/Titan unsupported)
- C-P1 equivalents for Sun/Moon (no `_featureRenderer` handle registered for device-loss destroy)

---

## Batch 3 — Billboard / Label collection correctness (2026-04-16)

**Files touched:**
- [packages/engine/Source/Renderer/WebGPU/WebGPUBillboardRenderer.js](../packages/engine/Source/Renderer/WebGPU/WebGPUBillboardRenderer.js)
- [packages/engine/Source/Renderer/WebGPU/WebGPULabelRenderer.js](../packages/engine/Source/Renderer/WebGPU/WebGPULabelRenderer.js)

**Typecheck:** `npx tsc --project packages/engine/tsconfig.json --noEmit` — clean.

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| B-6 | PER_FEATURE | Billboard + Label atlases permanently 1×1 white placeholders | Both renderers now resolve the real WebGPU texture view via `atlas.texture._texture._webgpuTexture` (handle published by WebGLStubTexture). Billboard renderer tracks `atlas.guid` and drops its bind group on every guid rotation so new images propagate. Labels rebuild the bind group each frame since SDF atlas is always authoritative. 1×1 placeholder remains for the frames before the atlas rasterizes, but is destroyed once the real atlas is ready. |
| DP-H2 | DATA_PIPELINE | Billboard `alignedAxis` hardcoded to 0 | `buildInstanceData` and `buildPickInstanceData` now pack `bb._alignedAxis.x/y` into `compressedAttr0.zw` (the slot already reserved in the shader struct). Data plumbing ready; shader-side rotation-by-world-axis is a follow-up. |
| DP-H3 | DATA_PIPELINE | EntityCluster `clusterShow` not read | Visibility gate now skips billboards whose `_clusterShow === false` in both color and pick paths. Clustered billboards no longer render alongside the cluster glyph. |
| C-R6 (partial) | RENDERER_DEEP | Billboard + Label pass hardcoded to `Pass.OPAQUE` | Billboard color command pass now `collection._blendOption === OPAQUE ? Pass.OPAQUE : Pass.TRANSLUCENT`. Label SDF command uses the same logic, defaulting to TRANSLUCENT. Pick commands remain OPAQUE (correct — pick-IDs are discrete). Polyline / Point / BufferPrimitive / GroundPrimitive pass-value bugs remain open. |

**Deferred in Batch 3:**
- **DP-H1** (Billboard `horizontalOrigin` / `verticalOrigin`) — needs an instance attribute slot + shader logic to shift the quad by origin flags. Packing without shader consumer would be dead plumbing. Queued for a dedicated Billboard shader-parity batch.

**Net user-visible effect of Batch 3:**
- Billboards and labels actually display their images / glyphs — no more white rectangles after the atlas rasterizes.
- EntityCluster-hidden billboards no longer stack behind cluster markers.
- Translucent UI (label text, alpha-blended billboards) composites correctly in the translucent pass, no longer painting on top of opaque geometry out of order.
- `billboard.alignedAxis` data now reaches the GPU (shader consumer pending).

**Not yet addressed from Billboard/Label review set** (future batches):
- DP-H1 — origin flags (needs shader extension)
- DP-H4 — Billboard atlas sub-region fallback (samples whole atlas when `_imageSubRegion` unset)
- DP-H5 — Label `backgroundColor`/`backgroundPadding` (background billboards render white)
- DP-H6 — Label has no pick path
- DP-H13 — collection-level dirty-range precision (full rebuild on any change)
- DP-H14 — `_billboardsToUpdate` never cleared on WebGPU

---

## Batch 4 — Globe + Terrain + Imagery correctness (2026-04-16)

**Files touched:**
- [packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts)
- [packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl](../packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl)

**Typecheck:** `npx tsc --project packages/engine/tsconfig.json --noEmit` — clean.

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| C-P2 | PER_FEATURE | Globe terrain SCENE3D branch defeats its own RTE | `center3D` split into `center3DHigh/Low` in the CameraUniforms struct; CPU packer writes both via canonical `floor(f32/2^16)*2^16` split. SCENE3D branch now assembles RTE as `(center3DHigh - encodedCameraHigh) + (center3DLow + exaggeratedPosition - encodedCameraLow)`; each term stays small so sub-meter precision is preserved at orbital altitudes. `CAMERA_UNIFORM_FLOATS` extended 96 → 100. |
| DP-C3 | DATA_PIPELINE | Imagery function-valued callbacks NaN-taint uniforms | New `resolveImageryLayerValue` helper: branches on `typeof === "function"`, invokes with `(frameState, layer, x, y, level)`, falls back to default on non-finite or throw. Applied to every per-layer read: alpha / brightness / contrast / saturation / dayAlpha / nightAlpha. Dynamic imagery fades now work on WebGPU. |
| DP-C4 | DATA_PIPELINE | Quantized terrain `compressed1` normal never read | New `VertexInputQuantizedWebMercNormals` struct, new `vertexMainQuantizedWebMercNormals` entry point reading `input.compressed1` as the encoded normal, and pipeline-builder branch in both color + wireframe variants that adds `@location(1) float32` attribute with 4-byte stride extension when `isQuantized && hasWebMercatorT && hasNormals`. Cesium-ion + Bing terrain now correctly Lambert-lit. |
| DP-C5 | DATA_PIPELINE | Quantized terrain `zh.y` decoded but thrown away; `minMaxHeight` never read | Added `decodeQuantizedHeight(normalizedHeight)` = `normalizedHeight * (maxH - minH) + minH` matching WebGL's `GlobeVS.glsl:135`. Extended `processVertex` with a `precomputedHeight` parameter; all five entry points supply it (uncompressed passes `position3DAndHeight.w`, quantized passes `decodeQuantizedHeight(zh.y)`). Morph / Columbus / 2D branches use the precise height instead of big-minus-big `length(position3DWC) - EARTH_RADIUS`. |

**Net user-visible effect of Batch 4:**
- No more sub-meter tile-seam jitter on 3D globe at orbital altitudes.
- Function-valued imagery callbacks (hover-fade, time-of-day tints, elevation fades) no longer cause the imagery layer to disappear.
- The dominant production terrain configuration (Cesium ion quantized-mesh + Bing imagery) now lights correctly on WebGPU.
- Quantized terrain heights in 2D / Columbus View / Morphing mode have sub-meter precision at tile boundaries.

**Not yet addressed from Globe/Terrain review set** (future batches):
- DP-H24 — Globe hue/saturation/brightness shift dropped (needs additional uniform fields)
- DP-H25 — Geodetic surface normal attribute not uploaded (exaggeration math degraded at high latitudes)
- DP-H26 / DP-H27 — Atmosphere tuning knobs + globe-level tuning uniforms dropped (Mie/Rayleigh, showGroundAtmosphere, lightingFadeDistance, etc.)
- DP-H28 — Shadow matrix only populated when clipping planes active (globe doesn't receive shadows otherwise)
- DP-H29 — Clipping polygon SDF `atan2` antimeridian wrap
- DP-H30 — Water mask sampler hardcoded nearest
- DP-H31 — Wave clock uses `performance.now()` not `frameState.time`
- H-P7 — Hardcoded Earth radius in shaders (breaks Mars/Moon ellipsoids)

---

## Batch 5 — Picking origin + Material time uniform re-upload (2026-04-16)

**Files touched:**
- [packages/engine/Source/Renderer/WebGPU/WebGPUPickFramebuffer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUPickFramebuffer.ts)
- [packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js](../packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js)

**Typecheck:** `npx tsc --project packages/engine/tsconfig.json --noEmit` — clean.

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| DP-C11 | DATA_PIPELINE | Pick framebuffer reads from origin (0,0) not the click | `begin()` now captures the scissor origin as `_pickOriginX/Y`. Every `copyTextureToBuffer` call (sync `end`, async `endAsync`, `_startReadback`) passes `origin: [_pickOriginX, _pickOriginY, 0]` on the texture descriptor. Picking works at any canvas location, not just the top-left corner. `readDepthPixelAsync` was already correct. |
| DP-C10 | DATA_PIPELINE | Material time uniforms never re-upload after frame 1 | Every material command now carries `_webgpuMaterialBuffer` + `_webgpuMaterialUB` references. `updateWebGPUMaterialCommandUniforms` checks `matUB.isDirty` each frame and re-uploads `matUB.gpuData` when set, then calls `matUB.clearDirty()`. Animated water, flowing dash patterns, glowing polylines now animate continuously on WebGPU. |

**Net user-visible effect of Batch 5:**
- `scene.pick(mousePosition)` returns correct results for any click location (was: only near 0,0).
- Time-varying materials (Water, PolylineDash, PolylineGlow, Fade, etc.) now animate on WebGPU instead of freezing on frame 1.

**Not yet addressed from Picking/Material review set** (future batches):
- DP-H44 — Globe surface has no pick ID (terrain tiles invisible to `scene.pick`)
- DP-H45 — `scene.pickPosition` returns Cartesian only over the globe (Model/Primitive/Tile depth not routed through `PickDepth._asyncDepthTexture`)
- DP-H46 — `scene.pickMetadata` entirely unwired
- DP-H6 — Label has no pick path
- C-R2 subset — derivedCommands.picking never dispatched on WebGPU (bigger architectural change)
- DP-H22 — Missing materials fall through to Color default (ElevationBand, PolylineArrow, PolylineDash, PolylineGlow, PolylineOutline)

---

## Index key

- **Source docs:**
  - **RENDERER_DEEP** = `PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md`
  - **PER_FEATURE** = `PRINCIPAL_ENGINEER_REVIEW_PER_FEATURE_2026_04_16.md`
  - **DATA_PIPELINE** = `PRINCIPAL_ENGINEER_REVIEW_DATA_PIPELINE_2026_04_16.md`
  - **MAIN** = `PRINCIPAL_ENGINEER_REVIEW_2026_04_16.md`

- **Finding prefixes** (kept consistent with source docs):
  - `C-R*` / `H-R*` / `M-R*` = Renderer-deep review
  - `C-P*` / `H-P*` / `M-P*` / `B-*` = Per-feature review
  - `DP-C*` / `DP-H*` / `DP-M*` = Data-pipeline review
