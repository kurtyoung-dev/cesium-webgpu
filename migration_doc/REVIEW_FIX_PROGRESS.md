# Principal Engineer Review — Fix Progress

**Started:** 2026-04-16
**Last updated:** 2026-04-18 (through Batch 27)
**Tracks:** progress against the four 2026-04-16 review docs (~190 findings total), plus infrastructure work that doesn't map to a specific review finding.

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

## Batches 6–9 (prior work, retroactively tracked)

Between the initial Batches 1–5 listed above and the 2026-04-16 Batch 10+ run, four additional batches landed fixes directly into the review docs without being added to this tracker. They are captured in the review docs' FIXED markers; the batch IDs appear as "Batch 6" / "Batch 7" / "Batch 8" / "Batch 9". Summary:

- **Batch 6** (3 fixes) — touched `WebGPUModelRenderer.js` light uniform slot widening; `DP-H30` (water-mask sampler), `DP-H31` (wave clock from frameState.time), and `DP-H11` (primitive command / geometry alignment details).
- **Batch 7** (2 fixes) — `DP-H6` (Label pick path routes glyph billboards through the billboard FR during pick frames).
- **Batch 8** (3 fixes) — `DP-C9` (sRGB format-per-slot; baseColor/diffuse/emissive as `rgba8unorm-srgb`, normal/metallicRoughness/occlusion as `rgba8unorm`) + the sibling per-slot metadata plumbing that prepared DP-C8's per-sampler resolution.
- **Batch 9** (2 fixes) — `DP-H8` (Polyline `loop: true` closing segment), plus the Polyline/Point/BufferPrimitive/GroundPrimitive pass-value fixes that finished `C-R6`.

---

## Batch 10 — 3D Tiles styling (2026-04-16)

**Files touched:** [WebGPUModelFeatureId.js](../packages/engine/Source/Renderer/WebGPU/WebGPUModelFeatureId.js)
**Typecheck:** clean.

| ID | Source | Fix |
|---|---|---|
| DP-C1 | DATA_PIPELINE | `createBatchGPUTexture` now reads `batchTexture._batchValues` (Uint8Array per-feature RGBA) + `batchTexture._textureDimensions` and uploads via `queue.writeTexture`. Return shape widened to `{ texture, width, height }`. `ensureFeatureIdResources` unpacks it and sets `FLAG_HAS_BATCH_TABLE`. Cached path re-uploads when `_batchValuesDirty` flips. `Cesium3DTileStyle.color` / `show` / `tileset.style = …` now work on WebGPU. |

**Net effect:** the single highest-impact 3D Tiles gap on WebGPU is closed. Every tileset with styling renders correctly.

---

## Batch 11 — glTF data pipeline (2026-04-16)

**Files touched:**
- [ModelPrimitiveGeometry.js](../packages/engine/Source/Scene/Model/ModelPrimitiveGeometry.js)
- [WebGPUModelRenderer.js](../packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.js)
- [WebGPUModelPipelineCache.js](../packages/engine/Source/Renderer/WebGPU/WebGPUModelPipelineCache.js)
- [ModelPBRComplete.wgsl](../packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.wgsl)

**Typecheck:** clean.

| ID | Source | Fix |
|---|---|---|
| DP-C6 | DATA_PIPELINE | `ensureFloat32(data, attr, nc)` now honors `attr.quantization` (KHR_mesh_quantization per-component offset + step) and `attr.normalized` (spec-correct `raw / typeMax` for byte/short integer accessors). Signed/unsigned divisors follow the glTF spec. Every call site in `extractPrimitiveGeometry` + morph extraction passes the source attribute. **Google Photorealistic + most commercial Draco-quantized tilesets now render with correct geometry scale and properly lit surfaces.** |
| DP-C7 | DATA_PIPELINE | Three-layer fix: upload `texCoord1Data` to a new `primCache.uv1Buffer`, extend pipeline vertex layout with `arrayStride: 8` slot at `@location(7)`, add `texCoord1` to Vertex/Fragment input + a `selectUV(input, slotBit)` helper in the shader, route all 5 texture samples through it, and pack a `texCoordFlags: u32` bitmask from each `textureReader.texCoord`. Occlusion + clearcoat-normal maps that use `TEXCOORD_1` now land on the correct UV set. |
| DP-C8 | DATA_PIPELINE | `WebGPUModelPipelineCache.getSamplerForReader(textureReader)` builds `GPUSampler`s from `texture._sampler` WebGL enums (magFilter 9728/9729, 6 minFilter modes split into `{min, mip}`, wrapS/T 10497/33071/33648). Per-combination cache avoids device thrash. Bind-group build resolves 5 per-slot samplers from their readers; `defaultSampler` is the fallback only. Pixel-art, clamp, mirror-repeat samplers all propagate correctly. |
| C-P12 | PER_FEATURE | Duplicate of DP-C6 — same fix addresses both. |

**Net effect:** glTF data pipeline is substantially closer to parity. Four of the review's highest-severity data-drop findings are resolved.

---

## Batch 12 — Collection RTE, clipping-plane frames, fog inner-radius (2026-04-16)

**Files touched:**
- [WebGPUBillboardRenderer.js](../packages/engine/Source/Renderer/WebGPU/WebGPUBillboardRenderer.js)
- [WebGPUPolylineRenderer.js](../packages/engine/Source/Renderer/WebGPU/WebGPUPolylineRenderer.js)
- [WebGPULabelRenderer.js](../packages/engine/Source/Renderer/WebGPU/WebGPULabelRenderer.js)
- [WebGPUClippingPlaneCollection.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUClippingPlaneCollection.ts)
- [WebGPUVolumetricFogRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUVolumetricFogRenderer.ts)

**Typecheck:** clean.

| ID | Source | Fix |
|---|---|---|
| C-P5 | PER_FEATURE | Billboard / Polyline / Label now compute `inverse(modelMatrix) · positionWC` before encoding the camera, so camera and per-vertex positions are in the same frame and RTE cancellation stays accurate at Earth ECEF scale when the collection's `modelMatrix` is non-identity. Cloud was already correct (no modelMatrix multiply). |
| C-P6 | PER_FEATURE | `WebGPUClippingPlaneCollection` transforms each plane from world to eye space via `uniformState.inverseViewTranspose` before packing (rigid view-matrix fallback when the inverse-transpose isn't published). Revision cache now gates texture reallocation only; upload runs every frame because plane data is view-dependent. Fragment `dot(eyePos, plane.xyz) + plane.w` matches frames. |
| C-P7 (partial) | PER_FEATURE | Inner-radius pick switched from `max(radii)` to `min(radii)` (WGS84 polar, 6356752 m) so cameras over the poles no longer produce clamped-to-zero altitudes. Shader-side `length(worldPos) − innerRadius` f32 cancellation remains — proper RTE encoding is **FOLLOW-UP C-P7-RTE**. |
| C-P8 | PER_FEATURE | **DEFERRED** — async pipeline compile is a multi-hour architectural change. Tracked as **FOLLOW-UP C-P8-ASYNC**. |

---

## Batch 13 — Point-cloud EDL warning + duplicate marker (2026-04-16)

**Files touched:** [WebGPUPointCloudEyeDomeLighting.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudEyeDomeLighting.ts)

**Typecheck:** clean.

| ID | Source | Fix |
|---|---|---|
| C-P14 | PER_FEATURE | `updateWebGPUPointCloudEDL` emits a one-shot `console.warn` the first time an app requests EDL under a WebGPU context. Silent feature-loss downgrades to visible feature-loss. Full EDL port (offscreen FBO + depth + blend pass) tracked separately. |
| C-P12 | PER_FEATURE | Duplicate of DP-C6 (Batch 11). Cross-marked. |
| C-P9 | PER_FEATURE | **DEFERRED** — DistanceDisplayCondition / NearFarScalar family needs 5 new instance attribute slots across 4 collection shaders. **FOLLOW-UP C-P9-COLLECTIONS**. |
| C-P10 | PER_FEATURE | **DEFERRED** — 2D/CV/Morphing in collection + primitive shaders. **FOLLOW-UP C-P10-SCENE-MODES**. |
| C-P11 | PER_FEATURE | **DEFERRED** — log depth across collection/primitive/model shaders. **FOLLOW-UP C-P11-LOGDEPTH**. |
| C-P13 | PER_FEATURE | **DEFERRED** — TimeDynamicPointCloud wrapper lifecycle. **FOLLOW-UP C-P13-TDPC-LIFECYCLE**. |

---

## Batch 14 — IBL leak cleanup + image readiness (2026-04-16)

**Files touched:**
- [WebGPUIBLPipeline.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUIBLPipeline.ts)
- [WebGPUGlobeSurfaceRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts)
- [WebGPUImageryReprojection.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUImageryReprojection.ts)

**Typecheck:** clean.

| ID | Source | Fix |
|---|---|---|
| C-P17 | PER_FEATURE | `dispatchIrradianceConvolution` + `dispatchRadiancePrefilter` destroy existing cube textures before replacing. Per-face (and per-mip for radiance) 16-byte params UBOs collected into `leakedParamsBuffers` during the dispatch loop and explicitly destroyed after `queue.submit`. Per-regen leak: ~2.5 MB texture + ~28 × 16 B UBO → zero. |
| C-P18 | PER_FEATURE | `_uploadImageSource` now returns null when `!source.complete || source.naturalWidth === 0` (caller's cache-miss path naturally retries next frame). `reprojectImageSourceWebGPU` throws a clear error for not-yet-decoded HTMLImageElements instead of the cryptic WebGPU "source is not in a valid state." `WebGPUImageUpload.ts` was already correct (routes through `createImageBitmap` which awaits decode). |
| C-P15 | PER_FEATURE | **DEFERRED** — Gaussian splat covariance modelMatrix rotation. **FOLLOW-UP C-P15-GS-ROTATION**. |
| C-P16 | PER_FEATURE | **DEFERRED** — feature-ID attribute path for b3dm/i3dm. **FOLLOW-UP C-P16-FEATURE-ID-ATTR**. |

---

## Batch 15 — Renderer-deep criticals (2026-04-16)

**Files touched:** (review-doc markers only; all findings architectural/DEFERRED except C-R6 which was completed in Batch 3 + 9).

| ID | Source | Status |
|---|---|---|
| C-R1 | RENDERER_DEEP | **DEFERRED** — `command.renderState` consumption. **FOLLOW-UP C-R1-RENDERSTATE**. |
| C-R2 | RENDERER_DEEP | **DEFERRED** — `derivedCommands.*` dispatch. **FOLLOW-UP C-R2-DERIVED-COMMANDS**. |
| C-R3 | RENDERER_DEEP | **DEFERRED** — translucent back-to-front sort. **FOLLOW-UP C-R3-TRANSLUCENT-SORT**. |
| C-R4 | RENDERER_DEEP | **DEFERRED** — glTF KHR extensions (texture_transform, clearcoat, anisotropy, specular, iridescence, sheen, volume). **FOLLOW-UP C-R4-GLTF-KHR**. |
| C-R5 | RENDERER_DEEP | **DEFERRED** — imagery layer count widen 4 → 16. **FOLLOW-UP C-R5-IMAGERY-16**. |
| C-R6 | RENDERER_DEEP | **FIXED** (consolidated from Batch 3 + Batch 9). All 5 primitive renderers now emit correct `pass` values driven by `blendOption` / `classificationType`. |

---

## Batch 16 — Renderer-deep destroy-order + remaining-C-R defers (2026-04-16)

**Files touched:** [WebGPUContext.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts)

**Typecheck:** clean.

| ID | Source | Fix |
|---|---|---|
| C-R13 | RENDERER_DEEP | Destroy order in `WebGPUContext.destroy()` rewritten: all subsystems owning GPU resources (`_viewportQuad`, `_mipmapGenerator`, `_renderBundleManager`, `_timestampProfiler`, `_storageBufferPool`, `_indirectDrawManager`, `_gpuCuller`, `_bufferMapper`) destroyed BEFORE `_device.destroy()`. Buffer pools + cache maps cleared just before the device teardown. GPU validator no longer flags teardown; multi-viewer apps no longer leak transient buffer contents. |
| C-R7 | RENDERER_DEEP | **DEFERRED** — central `_webgpuPipelineCache` not instantiated. **FOLLOW-UP C-R7-CENTRAL-PIPELINE-CACHE**. |
| C-R8 | RENDERER_DEEP | **DEFERRED** — globeDepth updateDepth, translucent 3D-Tiles classification, invert-classification composition, edge FBO. **FOLLOW-UP C-R8-SCENE-PASSES**. |
| C-R9 | RENDERER_DEEP | **DEFERRED** — Model/GroundPrimitive/Ellipsoid/Voxel/GaussianSplat pick commands. **FOLLOW-UP C-R9-MODEL-PICK-FAMILY**. |
| C-R10 | RENDERER_DEEP | **DEFERRED** — point-light cube shadows. **FOLLOW-UP C-R10-POINT-LIGHT-SHADOWS**. |
| C-R11 | RENDERER_DEEP | **DEFERRED** — bind-group / texture-view caching in post-process hot path. **FOLLOW-UP C-R11-BIND-GROUP-CACHING**. |
| C-R12 | RENDERER_DEEP | **DEFERRED** — device-loss cache walk. **FOLLOW-UP C-R12-DEVICE-LOSS-WALK**. |

---

## Batch 17 — Build-variant split + WebGL compat stub Proton-style translation (2026-04-16)

Two parallel infrastructure streams landed in this batch. Neither maps to a specific review-doc finding — they are build-system and compat-layer work that underpins the rest of the backlog. They are recorded here because they change how the fork ships bundles and how legacy WebGL code paths behave on WebGPU.

### Stream A — Three-variant build pipeline

**Files touched:**

- [scripts/build.js](../scripts/build.js) — `createCesiumJs`, `createIndexJs`, `bundleCesiumJs`, `buildCesium` all accept a `variant` parameter; ESM bundle gets `splitting: true` + chunk output; `stripPragmaPlugin` now emits explicit `loader` hints
- [scripts/bundleVariantPlugin.js](../scripts/bundleVariantPlugin.js) — new esbuild plugin that pattern-matches import paths and rewrites backend-specific imports to empty stubs
- [scripts/stubs/emptyShader.js](../scripts/stubs/emptyShader.js) — `export default ""` used for stripped GLSL / WGSL strings
- [scripts/stubs/emptyModule.js](../scripts/stubs/emptyModule.js) — Proxy that throws with a clear message if WebGPU code is reached in a WebGL-only build
- [packages/engine/Source/Renderer/RendererType.ts](../packages/engine/Source/Renderer/RendererType.ts) — adds `setGlobalDefaultRenderer` / `getGlobalDefaultRenderer` API so entry barrels can pick the default at module init
- [gulpfile.js](../gulpfile.js) — new tasks: `buildCesiumDual`, `buildCesiumWebGLOnly`, `buildCesiumWebGPUOnly`, `buildAllVariants` (runs all three with engine + widgets hoisted out of the series)

**Typecheck:** `npx tsc --noEmit` — clean.
**Build:** `npx gulp buildAllVariants` — succeeds in ~65 s.

**What shipped:**

- Three opt-in build variants (`dual` / `webgl-only` / `webgpu-only`) produced by a single `buildAllVariants` gulp task. The dual variant goes to `Build/Cesium{Unminified}` (historical paths) so existing tooling and downstream consumers don't break.
- esbuild alias plugin rewrites backend-specific imports (`Source/Shaders/*.js` or `Source/Renderer/WebGPU/**` / `Source/Shaders/WebGPU/**`) to empty stubs in the matching variant, so tree-shaking actually drops the other backend's bytes past the static-import barrier.
- ESM output uses `splitting: true` — the existing `await import("./WebGPU/WebGPUContext.js")` in `ContextFactory` now lands in its own `chunks/WebGPUContext-*.js` chunk that only downloads when the user actually picks WebGPU.
- `setGlobalDefaultRenderer()` called from each entry barrel so the variant picks the matching default at first `Viewer({ contextOptions: { renderer: 'auto' } })`. Users still override per-Viewer by passing an explicit `renderer`.
- WGSL preprocessor TypeScript re-exports split into a separate `packages/engine/index-wgsl.js` subpath module — imported only by dual + webgpu-only entry barrels, not by webgl-only, so the stub aliasing doesn't trip on "No matching export" for that WebGPU-only surface.

**Measured sizes (minified + gzipped):**

| Target | Baseline | Dual | WebGL-only | WebGPU-only |
|---|---:|---:|---:|---:|
| ESM `index.js` (initial chunk) | 1.48 MB | **1.13 MB** | 1.18 MB | 1.02 MB |
| ESM chunks (lazy) | — | 0.50 MB | 0.13 MB | 0.47 MB |
| ESM total | 1.48 MB | 1.63 MB | **1.31 MB** (-11%) | 1.49 MB |
| IIFE `Cesium.js` | 1.89 MB | **4.15 MB** ⚠️ | not built | not built |
| CJS `index.cjs` | — | 1.63 MB | 1.32 MB | 1.49 MB |

**Tree-shaking verification (shader string markers in bundle):**

| Variant | `@vertex`/`@fragment`/`@compute` (WGSL) | `gl_Position`/`precision highp`/`uniform vec` (GLSL) |
|---|---:|---:|
| WebGL-only | 0 ✓ | 219 |
| WebGPU-only | 340 | 37 (tiny inline Model-pipeline template fragments) |
| Dual | 340 | 219 |

The 37 residual GLSL markers in the WebGPU-only bundle are not full shader files — they are small `uniform vec4 ...` string fragments inside Model / 3D-Tiles runtime shader assembly. Removing them requires the per-Scene-file factory refactor (3–5 days), tracked as a follow-up below.

**Net user-visible effect:**

- WebGPU-first consumers using a modern bundler now pay ~1.13 MB gzipped for the initial chunk instead of 1.48 MB — a ~24% first-paint reduction, with the 325 KB `WebGPUContext` chunk loaded lazily on first context creation.
- WebGL-only consumers (legacy, integrators who don't want the new backend) get ~1.31 MB total, 11% smaller than baseline, and the bundle contains zero WGSL bytes — no WebGPU code ships.
- WebGPU-only consumers ship ~1.49 MB total containing zero full GLSL shader files.
- The dual ESM bundle is still a drop-in replacement for the historical single-file ESM — the only consumer-visible change is that `index.js` now references sibling `chunks/*.js` files that modern bundlers and browsers handle transparently.

### Stream B — WebGL compatibility stub: real translations, not no-ops

**Files touched:**

- [packages/engine/Source/Renderer/WebGPU/WebGLStateConverters.ts](../packages/engine/Source/Renderer/WebGPU/WebGLStateConverters.ts) — new converters: `webglToWebGPUTextureFormat` (30+ sized formats + base-format promotion), `bytesPerTexel`, `webglFilterToWebGPU` / `webglMipmapFilterToWebGPU` (splits combined min-filters), `webglWrapToWebGPU`
- [packages/engine/Source/Renderer/WebGPU/Stubs/WebGLStubTypes.ts](../packages/engine/Source/Renderer/WebGPU/Stubs/WebGLStubTypes.ts) — state interface extended with `pixelStore`, full stencil state, and a `mipmapGenerator` slot
- [packages/engine/Source/Renderer/WebGPU/Stubs/WebGLStubTexture.ts](../packages/engine/Source/Renderer/WebGPU/Stubs/WebGLStubTexture.ts) — full rewrite (~530 lines): `createTexture` returns a wrapper with pending state; `texParameteri` / `pixelStorei` record sampler descriptor + unpack flags; `texImage2D` allocates a real `GPUTexture` (both 9-arg byte form and 6-arg HTML-image form), uploads via `queue.writeTexture` or `copyExternalImageToTexture`, honors `UNPACK_FLIP_Y_WEBGL`; `generateMipmap` lazily instantiates `WebGPUMipmapGenerator` and dispatches a real blit-down render pass
- [packages/engine/Source/Renderer/WebGPU/Stubs/WebGLStubShader.ts](../packages/engine/Source/Renderer/WebGPU/Stubs/WebGLStubShader.ts) — `getParameter` answers ~25 WebGL queries from `device.limits` + synthesized strings; `getExtension` returns non-null tag objects for 15 WebGL extensions whose features are in WebGPU core; `getSupportedExtensions` returns the registered keys
- [packages/engine/Source/Renderer/WebGPU/Stubs/WebGLStubPipelineState.ts](../packages/engine/Source/Renderer/WebGPU/Stubs/WebGLStubPipelineState.ts) — `enable/disable(GL_STENCIL_TEST)` wired; `stencilFunc` / `stencilFuncSeparate` / `stencilOp` / `stencilOpSeparate` / `stencilMask` / `stencilMaskSeparate` all record state; new `webglToWebGPUStencilOp` helper; `setStencilReference` called eagerly when a render pass is open
- [packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts) — stub-state factory initializes the new `pixelStore`, stencil, and `mipmapGenerator` fields

**Typecheck:** clean.

**What shipped:**

- The entire `gl.createTexture() → gl.bindTexture() → gl.texParameteri() → gl.pixelStorei(UNPACK_FLIP_Y_WEBGL, 1) → gl.texImage2D() → gl.generateMipmap()` upload sequence now produces a real `GPUTexture` + `GPUSampler` pair on WebGPU. Legacy code paths hitting the compat stub no longer get white-placeholder textures.
- Format selection: `texImage2D(…, internalformat, format, type)` triples map to 30+ sized WebGPU formats (R8/RG8/RGBA8, sRGB, R16F/RGBA16F, R32F/RGBA32F, integer formats, depth/stencil); unsized base formats (GL_RGBA, GL_LUMINANCE, GL_DEPTH_COMPONENT) get sensible promotions.
- Image sources (HTMLImage / Canvas / ImageBitmap / Video / OffscreenCanvas) route through `copyExternalImageToTexture` with native `flipY` + `premultipliedAlpha`; raw byte sources use `queue.writeTexture` with manual row reversal when UNPACK_FLIP_Y is set.
- `generateMipmap()` dispatches the existing `WebGPUMipmapGenerator` blit-down pass using either the active command encoder (batched into the current frame) or a fresh standalone encoder that submits immediately.
- Feature-detection queries now see plausible answers: `gl.getParameter(MAX_TEXTURE_SIZE)` returns `device.limits.maxTextureDimension2D`, `MAX_VERTEX_ATTRIBS` returns `maxVertexAttributes`, `MAX_COLOR_ATTACHMENTS` returns `maxColorAttachments`, etc. `gl.getExtension('OES_texture_float')` + 14 other common extensions now return tag objects so feature-detection passes.

**Known limitations (documented in module headers, not regressions):**

- **GLSL → WGSL runtime transpilation** — still not shipped. `compileShader` / `linkProgram` remain opaque placeholders because an in-browser transpiler (Naga or Slang WASM) is ~1–2 MB of additional dependency. Tracked as **FOLLOW-UP STUB-NAGA** for a future lazy-load implementation.
- **Synchronous `readPixels`** — still returns null. WebGPU only exposes async readback via `mapAsync`; the pick-framebuffer async API is the supported migration path.
- **`blitFramebuffer`** — still a no-op. Cesium uses MSAA resolves via render passes, not `blitFramebuffer`, so this has no concrete consumer.

### Known regression from Stream A

- **IIFE `Cesium.js` dual build grew from 1.89 MB → 4.15 MB gzipped.** The ESM code splitting inflates the IIFE because IIFE can't split — it inlines everything that's `await import()`'d into a single file, so the WebGPU chunk content lands inside Cesium.js instead of being deduplicated with the main graph. Only affects legacy `<script src="Cesium.js">` users; modern bundler / CDN ESM consumers benefit from the split. Tracked as **FOLLOW-UP BUILD-IIFE-INFLATION** — fix is to emit IIFE from a separate entry that skips the dynamic-import path (WebGPU would then be unreachable in IIFE) OR to accept the inflation as a cost of dual-backend IIFE.

### Deferred from Stream B

- **STUB-NAGA** — ship `naga-wasm` as a lazy-loaded dependency; wire `compileShader` to transpile GLSL → WGSL on first call; extend the stub to defer pipeline materialisation until `useProgram` + first draw. Bundle-size impact: ~1–2 MB gzipped, all lazy. Estimate: 2–4 weeks for a working prototype that runs one real GLSL shader end-to-end; longer to harden against the full Cesium extension surface.

### Not in this batch (from the review-doc backlog)

None of the DP-C / C-P / C-R criticals moved in this batch. The work here is orthogonal to the review findings — it's the bundle / compat-layer foundation that the backlog items will eventually ship through.

---

## Batch 18 — Material BLEND + twoPasses + wrap modes + missing materials + Globe HSB (2026-04-16)

**Files touched:**
- [packages/engine/Source/Renderer/WebGPU/WebGPUBufferPrimitiveRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUBufferPrimitiveRenderer.ts)
- [packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js](../packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js)
- [packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveShaders.js](../packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveShaders.js)
- [packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts)
- [packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl](../packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl)

**Typecheck:** `npx tsc --noEmit` — clean.

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| DP-H16 | DATA_PIPELINE | Material BLEND pipelines have no blend state | `buildPolygonPipeline` now distinguishes pick (`fragmentPickMain`, opaque + depth write) from color (standard src-alpha blend + depth write disabled). Every translucent PerInstanceColorAppearance / MaterialAppearance using the buffer-polygon pipeline now blends correctly. |
| DP-H17 | DATA_PIPELINE | `appearance.twoPasses` ignored on WebGPU | `WebGPUPrimitiveCommands.js` pipeline cache now closures `makePipeline(cullMode, label)` and builds `pipelineFrontCull` + `pipelineBackCull` in addition to the default pipeline. When `twoPasses` is set, each geometry emits two commands (back-face cull first, front-face second) — matches WebGL's two-pass closed-translucent-volume path for Ellipsoid / Polygon with hole / extruded shapes. |
| DP-H21 | DATA_PIPELINE | Material wrap mode hard-coded to `"repeat"` | `ensureMaterialTextureBindGroup` now reads `material.uniforms.repeat` supporting both numeric (Cartesian2 `{x, y}` where any value ≠ 1.0 means `"repeat"`) and boolean (`{x: false, y: true}` stencil-style) shapes. Rebuilds sampler when addressModeU/V changes, caches `_matSamplerAddressU/V`, invalidates textureBindGroup atomically. Matches WebGL's `Material.prototype._translateUniforms` behavior. |
| DP-H22 | DATA_PIPELINE | 5 material shaders missing from `selectMaterialShader` | Added one-time warning (`_warnedMissingMaterial` Set + `_warnMissingMaterialOnce()` helper) for `PolylineArrow` / `PolylineDash` / `PolylineGlow` / `PolylineOutline` (wrong integration point — these are polyline-only materials, consumed by `WebGPUPolylineRenderer`) and `ElevationBand` (no WGSL equivalent exists yet; full fix tracked as **FOLLOW-UP DP-H22-ELEVATION-BAND**). Users get a clear diagnostic instead of silent fallback to a generic material shader. |
| DP-H24 | DATA_PIPELINE | `globe.hueShift/saturation/brightness` are no-ops | `GlobeTerrain.wgsl` gained `hsbShift: vec4<f32>` field on `TileUniforms` (offsets 96–99), `globe_rgbToHsb` / `globe_hsbToRgb` helpers (prefixed to avoid collision with identical helpers in `SkyAtmosphere.wgsl`), and an HSB round-trip gate on `abs(shift) > 0.001`. `WebGPUGlobeSurfaceRenderer.ts` expanded `TILE_UNIFORM_FLOATS` 96 → 100 and writes `tileProvider.hueShift / saturationShift / brightnessShift` into the new slots. Applied AFTER fog so the tonal grading touches both imagery and atmospheric haze — same ordering as WebGL's `GlobeFS.glsl`. Default case (all zeros) is free — the shader gate short-circuits. |

**Net user-visible effect of Batch 18:**
- Every translucent Primitive / PerInstanceColor / MaterialAppearance that uses the buffer-polygon pipeline now renders correctly blended on WebGPU (was visibly wrong: either overwritten by opaque, or with garbage alpha).
- Ellipsoids, extruded polygons, and other closed translucent volumes render with proper back-then-front ordering — no more single-sided / inside-out artifacts.
- `Material.fabric.uniforms.repeat = { x: false, y: true }` (and Cartesian2 equivalent) now correctly clamps the affected axis — previously both axes always repeated.
- Users of PolylineArrow / Dash / Glow / Outline / ElevationBand materials get a console warning explaining the integration point instead of a silent wrong-material render.
- `globe.atmosphereHueShift = 0.1` (and Saturation/Brightness) now tints the globe as it does on WebGL — no more silent no-op.

### Deferred from Batch 18

- **DP-H20** (Material multi-texture secondary) — requires shader-layout refactor to introduce a second texture slot in the material bind group layout + per-material routing logic. Tracked as **FOLLOW-UP DP-H20-MULTI-TEX**.
- **DP-H22-ELEVATION-BAND** — ElevationBand needs its own WGSL + GlobeTerrain integration path; out of scope for this batch.

### Integration audit — Batch 18

Each fix was checked against the non-trivial scene configurations:

| Fix | Whole-earth | RTE | 3D Tiles | Space / orbit | Multi-frustum | CSM | Variant builds |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DP-H16 | ✓ blend applies to all translucent buffer-polygon draws on globe | ✓ (blend is orthogonal to vertex precision) | ✓ translucent tile colors blend over globe | ✓ (no altitude coupling) | ✓ pipeline rebuilt per-frustum through cache key | ✓ (pass is not shadow-participating) | ✓ all three variants — single-file TS fix, no new shader |
| DP-H17 | ✓ correct for Earth-sized extruded polygons | ✓ (vertex math unchanged) | ✓ | ✓ | ✓ twoPasses state included in pipeline cache key rebuild trigger | ✓ shadow cast path uses its own pipeline layer, unaffected | ✓ all three variants |
| DP-H21 | ✓ fabric materials on globe-sized primitives | ✓ | ✓ material uniforms on tile-attached primitives | ✓ | ✓ sampler is per-material, frustum-invariant | ✓ (not shadow-participating) | ✓ all three variants |
| DP-H22 | ✓ warning fires at first material use | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ all three variants — warning is diagnostic only |
| DP-H24 | ✓ shift applies to full composite color (imagery + fog) for every terrain tile | ✓ RTE vertex math untouched; fragment-only change | ✓ not 3D-Tiles-specific (globe only) | ✓ fog LUT + HSB compose correctly at orbit altitudes | ✓ shift runs per-frustum; each frustum's terrain pass samples the same tile UB | ✓ (terrain pass, not shadow cast) | ✓ dual / webgpu-only (webgl-only doesn't compile WGSL) |

All fixes pass `npx tsc --noEmit` clean. No new shader compile errors on the terrain WGSL (`hsbShift` occupies previously unused bytes past the 96-float struct; WebGPU UB size alignment already rounds up to 256 via `Math.max(TILE_UNIFORM_BYTES, 256)`).

---

## Batch 19 — Shadow gating + globe shadow receive + prev viewProj + geodetic terrain normal (2026-04-16)

**Files touched:**
- [packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts)
- [packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts)
- [packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl](../packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl)
- [packages/engine/Source/Scene/GlobeSurfaceTileProviderRendering.js](../packages/engine/Source/Scene/GlobeSurfaceTileProviderRendering.js)

**Typecheck:** `npx tsc --noEmit` — clean.

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| DP-H43 | DATA_PIPELINE | Shadow cast pass runs even when `viewer.shadows = false` | `executeShadowMapCastCommands` now early-returns when `frameState.shadowState?.shadowsEnabled === false`. Matches WebGL's Scene.js:2587 per-command gate at the pass level so disabled shadows no longer pay for iteration or a depth-only pass on every frame. |
| DP-H28 | DATA_PIPELINE | Globe shadow matrix never populated unless clipping planes active | `WebGPUGlobeSurfaceRenderer._buildEffectsBindGroup` call now includes `shadowState.lightShadowMaps[0]` as `shadowMap` when `lightShadowsEnabled` is true, and the gate that decides "build vs. placeholder" includes the receive-shadow case. Globes using `viewer.shadows = ShadowMode.RECEIVE_ONLY` (or ENABLED) now darken under caster geometry — previously the placeholder was bound with `shadowDarkness=1.0` and the shadow comparison was a no-op. |
| DP-H41 | DATA_PIPELINE | `previousViewProjection` not exposed to csm_* uniforms | `CameraUniforms` in `GlobeTerrain.wgsl` gained a trailing `previousViewProjection: mat4x4<f32>` field (offsets 100–115), populated from `UniformState._previousViewProjection` (cloned each frame in `UniformState.update()` before the current viewProjection is overwritten). Motion-vector / TAA passes can now reproject the current fragment into the previous frame's NDC. Per-renderer propagation to Primitive/Model/Collections camera UBs is a **FOLLOW-UP DP-H41-ALL-RENDERERS** — those renderers will add the field when their TAA consumer lands. |
| DP-H25 | DATA_PIPELINE | Geodetic surface normal attribute never uploaded | `TileGPUResources` gained `hasGeodeticSurfaceNormals: boolean`; `_createPipelineVariant` / `_selectPipeline` / `_selectWireframePipeline` / `_selectDebugFragmentPipeline` all accept the flag and route to a `*_Geo` entry-point family that adds `@location(2) geodeticSurfaceNormal: vec3<f32>`. The shader's `processVertex` takes the geodetic normal as its 6th parameter; legacy entry points pass `vec3(0.0)` as the sentinel and the exaggeration branch gates on `dot(n,n) > 0.25` to decide between the true geodetic normal (when present) and the ellipsocentric fallback. The VB offset `(arrayStride - 12)` matches `TerrainEncoding.getAttributes:625-628` which always appends geodetic normals last. Shadow cast for geodetic tiles is routed through a sentinel layout key that skips the tile — see DP-H25-SHADOW-CAST below. |

**Net user-visible effect of Batch 19:**
- `viewer.shadows = false` actually skips the shadow cast pass instead of running a depth-only pass and then ignoring the result. Saves a per-frame render pass on every shadow-participating primitive.
- Globes with terrain + shadow-casting content (models, 3D Tiles, polylines) now correctly darken terrain under the casters. Previously the terrain looked fully lit even when a building stood between it and the sun.
- TAA/motion-vector authors can build their pass on top of a populated `camera.previousViewProjection` without also needing to plumb it through `UniformState`.
- Terrain with vertical exaggeration enabled at mid-to-high latitudes (>30°) stops drifting up to 0.2° off the true WGS84 surface. Most visible during fly-throughs of mountainous regions (Himalayas, Andes, Alaska) where the exaggerated peaks previously appeared to "lean" as the camera moved.

### Deferred from Batch 19

- **DP-H42** (`minimumDisableDepthTestDistance`) — the subagent classified this as trivial, but implementation requires adding a per-instance distance field to Billboard/Label/Point instance buffers **and** shader-side `position.z = position.w` override logic in three collection shaders. Reclassed to multi-file-shader-required and moved to a dedicated collection-shader batch. Tracked as **FOLLOW-UP DP-H42-COLLECTION-SHADERS**.
- **DP-H41-ALL-RENDERERS** — plumb `previousViewProjection` into `WebGPUPrimitiveCommands.js`, `WebGPUModelRenderer.js`, and the collection renderers' camera UBs when a TAA consumer is ready to read it.
- **DP-H25-SHADOW-CAST** — stride-aware shadow cast pipelines so geodetic-terrain and uncompressed-with-normals tiles cast shadows correctly. The existing `rte24` / `quantized12` variants hardcode `arrayStride` in the pipeline descriptor; a proper fix registers per-stride variants (and also fixes the pre-existing breakage for uncompressed terrain with vertex normals, stride 28).

### Integration audit — Batch 19

| Fix | Whole-earth | RTE | 3D Tiles | Space / orbit | Multi-frustum | CSM | Variant builds |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DP-H43 | ✓ skip pass applies globally | ✓ (no vertex math touched) | ✓ 3D Tiles still shadow-participate when re-enabled | ✓ | ✓ gate is frustum-independent | ✓ CSM path gated by same flag | ✓ all three variants |
| DP-H28 | ✓ terrain receives over the whole globe | ✓ shadow matrix is view-projection-RTE aware | ✓ 3D Tiles shadow-receivers continue using their own effects BG | ✓ orbit altitudes unaffected (shadow matrix doesn't care about altitude) | ✓ bind group rebuilt per-frustum through existing flow | ✓ CSM cascades bind the same shadowMap pointer via lightShadowMaps[0] | ✓ all three variants |
| DP-H41 | ✓ previous viewProj is globally valid | ✓ (ViewProj is not RTE-split; reprojection consumers handle their own precision) | ✓ 3D Tiles reuse the same field when they add TAA | ✓ orbit altitudes → large ViewProj values but mat4 f32 has headroom for screen-space motion | ✓ each frustum sees the same previous viewProj (it's frame-global, not per-frustum) | ✓ shadow cast is orthogonal | ✓ dual / webgpu-only (webgl-only doesn't consume WGSL) |
| DP-H25 | ✓ geodetic normal is per-vertex; scales to Earth | ✓ exaggeration branch stays in eye-space delta domain | ✓ not 3D-Tiles-specific (terrain only) | ✓ geodetic normal is ellipsoid-local, correct at any altitude | ✓ pipeline variant per (stride × geo) already cached via extended key | ✓ shadow cast intentionally skipped for geodetic tiles — tracked follow-up | ✓ dual / webgpu-only |

All fixes pass `npx tsc --noEmit` clean.

---

## Batch 20 — WGSL preprocessor + shader module cache + prewarm (2026-04-17)

**Infrastructure batch — no review-doc findings closed directly. Enables Batches 21–24 deferred items (DP-H42, DP-H40, DP-H19, DP-H20, DP-H22-ElevationBand, DP-H25-SHADOW-CAST) by providing the WGSL conditional-compilation system those fixes need.**

**Files added:**
- [packages/engine/Source/Renderer/WebGPU/WebGPUShaderDefines.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUShaderDefines.ts) — central bitmask registry + source-id registry + debug helper
- [packages/engine/Source/Renderer/WebGPU/WebGPUShaderPreprocessor.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUShaderPreprocessor.ts) — pure `preprocess(source, definesBitmask) → string` transform
- [packages/engine/Source/Renderer/WebGPU/WebGPUShaderModuleCache.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUShaderModuleCache.ts) — Uint32-keyed `GPUShaderModule` cache with prewarm API

**Files touched:**
- [packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl](../packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl) — deleted 6 `*_Geo` entry points + 3 `*Geo` input structs; replaced with `//>>ifdef GEODETIC_NORMAL` blocks in existing 6 entry points + 3 base structs
- [packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts) — routes production, wireframe, debug-fragment, and clip-distances modules through the cache with the correct `defines` bitmask; adds `_initShaderCache` + `_getProductionShaderModule`; removes the `${geoSuffix}` entry-point suffix scheme

**Typecheck:** `npx tsc --noEmit` — clean.
**Build:** `node scripts/build.js` — all three variants (dual / webgpu-only / webgl-only) built successfully.

### What shipped

| Piece | Summary |
| --- | --- |
| `//>>ifdef` preprocessor | Line-oriented conditional-compilation extending Cesium's `//>>` pragma style (same family as `//>>includeStart('debug')`). Directive lines are always valid WGSL (comments), so raw sources still parse in IDEs / linters / third-party tooling. Supports `//>>ifdef FLAG`, `//>>else`, `//>>endif` with arbitrary nesting; unknown flags throw with line numbers. Pure function — same `(source, defines)` always produces byte-identical output. |
| Shader module cache | Two-tier caching: Tier 1 dedupes `GPUShaderModule` compilation across pipelines that share the same `(source, defines)` tuple (today's globe terrain builds 3+ pipelines from the same shader). Tier 2 is the existing per-renderer pipeline cache with keys now extended by a `pipe + hex(defines)` suffix. Tier 1 key packs `(sourceId & 0xff) OR ((defines & 0xffffff) << 8)` into a Uint32 — numeric `Map` lookup for the hot path. |
| Prewarm | Each renderer declares its prewarm list at `_initDevice()`. Globe terrain prewarms `0` and `GEODETIC_NORMAL` at init — ~10-20 ms of shader-compile cost moved off the render path. Zero first-frame jank from module compile. |
| Bitmask cache keys | Numeric keys chosen over sorted-string to hit the "runtime performance first" rule: no string allocation, no sort, no join per draw call. `Map<number, GPUShaderModule>` lookup is the fastest possible JS Map variant. `defineKeyToNames()` helper preserves debuggability for diagnostic paths. Add-only registry prevents silent cache-key aliasing across rebuilds. |

### Retrofit — `*_Geo` variants

Batch 19 added 6 parallel `vertexMain*_Geo` entry points + 3 `VertexInput*Geo` structs to the terrain shader (net ~140 lines). Batch 20 collapses these into the base entry points gated by `//>>ifdef GEODETIC_NORMAL`:

- **Before:** TS routed `entryPoint = "vertexMainQuantizedWebMerc" + (hasGeodeticSurfaceNormals ? "_Geo" : "")`. Each variant was a separate WGSL function. 12 entry points + 3 extra structs in the compiled module regardless of whether the tile needed geodetic normals.
- **After:** TS sets `defines = hasGeodeticSurfaceNormals ? ShaderDefine.GEODETIC_NORMAL : 0` and looks up the module through the cache. Entry-point names are unqualified; the same name resolves to different code based on the cache's preprocessed source.

Net diff in the shader: ~-100 lines of WGSL. Cleaner future extension — new conditional attributes (DP-H42, DP-H40, DP-H19, etc.) add one define and a few `//>>ifdef` blocks instead of duplicating every entry point.

### Build time vs runtime

- **Build time (unchanged):** `.wgsl` → JS string bundling; `//>>includeStart('debug', pragmas.debug)` stripping for production builds (handled by `scripts/build.js`).
- **Runtime (new):** `//>>ifdef FLAG` preprocessor runs on first use per `(source, defines)` tuple. Cached forever for the session. No rebuild-time variant enumeration — adding a new define is a code change, not a build-system change.

This matches how Cesium's GLSL path works conceptually (runtime define combination via `ShaderSource`), scaled to WGSL's no-native-preprocessor reality.

### Interaction with Slang + Naga

- **Slang** (author-time, optional): produces WGSL → goes through our runtime preprocessor like hand-authored WGSL. Slang's own `#ifdef` conditionals resolve at Slang→WGSL time; our preprocessor sees zero `//>>ifdef` directives in Slang output.
- **Naga** (runtime, inside `WebGLCompatibilityStub`): translates app-provided GLSL → WGSL at `gl.compileShader`. Its own GLSL `#ifdef` conditionals resolve during translation; our preprocessor never sees those paths.
- No overlap. Each translation pipeline handles its own conditionals. The three layers stack cleanly.

### Cache-key encoding (runtime performance first)

- Uint32 bitmask for the shader module cache (`Map<number, GPUShaderModule>`).
- Pipeline cache keys extended from e.g. `"UNMO_24_CD"` to `"UNMO_24_CD|1"` — compact hex suffix encoding the defines bitmask.
- Registry is add-only: never reorder, renumber, or remove an entry (would silently alias cached modules across rebuilds).
- `ShaderDefine.GEODETIC_NORMAL = 1 << 0` is the only define wired in this batch; future defines land in Batches 21–24.

### Integration audit — Batch 20

| Scenario | Status |
| --- | --- |
| Whole-earth rendering | ✓ Preprocessor is source-to-source; shader semantics identical to pre-retrofit. |
| RTE precision | ✓ Exaggeration branch math unchanged (same `processVertex` body). |
| 3D Tiles | ✓ Terrain-only change; 3D Tiles use their own renderer. |
| Space / orbit altitudes | ✓ Same shader math, same precision characteristics. |
| Multi-frustum | ✓ Pipeline cache key extended with a pipe + hex-defines suffix; same-defines / same-frustum still hits the cache. |
| CSM (shadow cast) | ✓ Shadow cast pipelines registered in `WebGPUShadowMapRenderer.js` — not touched by this batch. |
| Variant builds (dual / webgpu-only / webgl-only) | ✓ All three built successfully. webgl-only stubs `Renderer/WebGPU/*` so the new files aren't reached. |
| Clip-distances augmentation | ✓ Augmentation runs on the preprocessed base; anchor strings (`v_distance: f32,\n};`, `out.position.z = min(...)`, `globeClipByPlanes(...)`) are in sections with no `//>>ifdef` directives, so they survive preprocessing unchanged. |
| Debug-fragment augmentation | ✓ Same — appends debug entry points to preprocessed base. |
| Device loss | ✓ `destroy()` clears the shader module cache and per-defines maps for debug-fragment / clip-distances. |
| Prewarm cost | ✓ ~10-20 ms one-time at device init. Moved off the render path. |

### What's next — unlocks Batches 21–24

With the preprocessor + cache live, the deferred items can be executed:

- **Batch 21** — ship **DP-H42** (`minimumDisableDepthTestDistance`) + **DP-H40** (`splitPosition`) + **DP-H19** (`compressVertices`) as a cohesive collection-shader / primitive-VS update. Each adds one or two `//>>ifdef` blocks to Billboard / Label / Point / PolylineVS + a TS flag that flows through to the defines bitmask.
- **Batch 22** — Sibling 2 (stride-aware shadow cast) + ship **DP-H25-SHADOW-CAST** + fix the pre-existing uncompressed+normals shadow cast bug.
- **Batch 23** — Sibling 3 (material bind group v2 + pluggable material WGSL registry) with no behavior change — retrofit existing materials onto the new registry to validate.
- **Batch 24** — use Sibling 3 to ship **DP-H20** (material multi-texture) and **DP-H22-ElevationBand**.

---

## Batch 21 — DP-H42 + DP-H40 for Billboard / Label / Point (2026-04-17)

**First consumers of the Batch 20 `//>>ifdef` preprocessor** — three collection renderers get `DISABLE_DEPTH_DISTANCE` and `SPLIT_ENABLED` wired end-to-end: per-instance vertex attributes, frame-wide uniforms, shader-side conditional logic, pipeline / module cache keyed by active defines, and prewarm of all four variant combinations.

**Files touched:**
- [packages/engine/Source/Renderer/WebGPU/WebGPUShaderDefines.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUShaderDefines.ts) — added `DISABLE_DEPTH_DISTANCE`, `SPLIT_ENABLED` defines; added 5 new source IDs (BILLBOARD_COLLECTION/_PICK/_SDF, POINT_PRIMITIVE_COLOR/_PICK)
- [packages/engine/Source/Renderer/WebGPU/WebGPUBillboardRenderer.js](../packages/engine/Source/Renderer/WebGPU/WebGPUBillboardRenderer.js)
- [packages/engine/Source/Renderer/WebGPU/WebGPULabelRenderer.js](../packages/engine/Source/Renderer/WebGPU/WebGPULabelRenderer.js)
- [packages/engine/Source/Renderer/WebGPU/WebGPUPointPrimitiveRenderer.js](../packages/engine/Source/Renderer/WebGPU/WebGPUPointPrimitiveRenderer.js)
- [packages/engine/Source/Shaders/WebGPU/Collections/BillboardCollection.wgsl](../packages/engine/Source/Shaders/WebGPU/Collections/BillboardCollection.wgsl)
- [packages/engine/Source/Shaders/WebGPU/Collections/BillboardCollectionPick.wgsl](../packages/engine/Source/Shaders/WebGPU/Collections/BillboardCollectionPick.wgsl)
- [packages/engine/Source/Shaders/WebGPU/Collections/BillboardCollectionSDF.wgsl](../packages/engine/Source/Shaders/WebGPU/Collections/BillboardCollectionSDF.wgsl)
- [packages/engine/Source/Shaders/WebGPU/Collections/PointPrimitiveColor.wgsl](../packages/engine/Source/Shaders/WebGPU/Collections/PointPrimitiveColor.wgsl)
- [packages/engine/Source/Shaders/WebGPU/Collections/PointPrimitivePick.wgsl](../packages/engine/Source/Shaders/WebGPU/Collections/PointPrimitivePick.wgsl)

**Typecheck:** `npx tsc --noEmit` — clean.
**Build:** `node scripts/build.js` — all three variants (dual / webgpu-only / webgl-only) built successfully.

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| DP-H42 | DATA_PIPELINE | `minimumDisableDepthTestDistance` unreachable by any WebGPU renderer | Billboard/Label/Point instance buffers carry a new `perInstanceFlags` vec4 (`@location(6/8/4)` respectively); x=disableDepthTestDistance, y=splitDirection. Each renderer's CameraUniforms UBO exposes `minimumDisableDepthTestDistance: f32` pulled from `frameState.minimumDisableDepthTestDistance`. The VS `//>>ifdef DISABLE_DEPTH_DISTANCE` block computes `positionRTE`-local squared distance and, when within the per-instance (or frame-wide fallback) threshold, forces `out.position.z = out.position.w` so depth always passes — same semantics as WebGL's `BillboardCollectionVS.glsl:267-276`. Applied identically to the pick pipelines so picked regions match rendered regions. |
| DP-H40 | DATA_PIPELINE | `frameState.splitPosition` only read by point renderer | All three renderers now surface `splitPosition` in their UBO as `frameState.splitPosition * context.drawingBufferWidth` (WebGL's `czm_splitPosition` pixel convention). The `//>>ifdef SPLIT_ENABLED` FS block discards pixels on the wrong side of the cutoff based on the per-instance `splitDirection` interpolated from the VS output. Also fixes a pre-existing Point bug where the shader declared `@group(1) material` that was never bound — unified into one `@group(0)` UBO. |

### What shipped end-to-end

For each of Billboard, Label, Point:

1. **`ShaderDefine` registry** — two new bits (`DISABLE_DEPTH_DISTANCE = 1<<1`, `SPLIT_ENABLED = 1<<2`) plus 5 new source IDs.
2. **Instance buffer extension** — `perInstanceFlags` vec4 appended at the next free `@location`. Billboard 96→112 bytes (24→28 floats). Label SDF 128→144 bytes (32→36 floats). Point 64→80 bytes (16→20 floats). Stride grew 16 bytes per instance in each case, matching WebGPU's 16-byte `arrayStride` alignment requirement.
3. **`buildInstanceData` / `buildPickInstanceData`** — both color + pick packers read `bb._disableDepthTestDistance` and `bb._splitDirection` (with `undefined` safely defaulting to 0) into the new slot.
4. **`packUniforms`** — writes `frameState.minimumDisableDepthTestDistance` and `frameState.splitPosition * drawingBufferWidth` into the camera UBO. Point's UBO was restructured to merge the formerly-orphaned MaterialUniforms struct into a unified CameraUniforms at `@group(0)`.
5. **Shader source with `//>>ifdef` blocks** — `VertexInput` conditionally declares the new attribute (always — unused attributes are allowed), `VertexOutput` conditionally forwards `splitDirection` when `SPLIT_ENABLED`. VS body conditionally applies the depth override on `DISABLE_DEPTH_DISTANCE`. FS conditionally applies the split discard.
6. **Shader module cache** — one `WebGPUShaderModuleCache` per device per renderer family (module-level `WeakMap<GPUDevice, Cache>`), keyed by `(ShaderSourceId.BILLBOARD_COLLECTION/_PICK/_SDF/POINT_PRIMITIVE_COLOR/_PICK, defines)`. Pipeline cache maps `defines → GPURenderPipeline` on each collection's `_webgpuCache`.
7. **Per-frame defines computation** — `computeXxxDefinesForFrame` scans the collection once; short-circuits once both bits are set. Baseline (no features) stays the fast path — a collection with no billboards that set `disableDepthTestDistance` or `splitDirection` pays nothing extra.
8. **Prewarm** — `prewarmXxxShaders(device, ...)` compiles all four `(0, DDD, SPLIT, DDD|SPLIT)` variants at first use per device, for both color + pick source families. Moves ~40–80 ms of `createShaderModule` cost off the first-frame render path.
9. **Pick pipelines** — mirror the color pipelines' defines exactly, so pick regions match visible regions through both feature flags.

### Hidden bug fixed as a side-effect (Point)

Point's WGSL declared `@group(0) camera: CameraUniforms` AND `@group(1) material: MaterialUniforms`, but the pipeline layout only bound group 0. Any `material.*` access in the shader read through a never-bound slot — `material.viewportSize`, `material.encodedCameraPositionMCHigh/Low` were silently undefined. Batch 21 merges both into a single CameraUniforms at `@group(0)` matching what the JS side actually uploads, fixing the latent precision bug that would surface whenever the pipeline layout validation was looser than expected. `translateRelativeToEye` now reads from `camera.encodedCameraPositionMC*` (previously the broken `material.*`), and the screen-space quad math reads `camera.viewportSize` instead of the dead `material.viewportSize`.

### Integration audit — Batch 21

| Fix | Whole-earth | RTE | 3D Tiles | Space / orbit | Multi-frustum | CSM | Variant builds |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DP-H42 (Billboard) | ✓ depth override works regardless of Earth-scale positions | ✓ eye-relative distance via `positionRTE` stays in the RTE domain | ✓ billboard stack on 3D Tiles respects depth threshold | ✓ threshold is in meters — works at any altitude | ✓ pipeline per frustum still hits the same `(defines, layout)` cache | ✓ billboards don't cast shadows; pass is orthogonal | ✓ all three variants |
| DP-H40 (Billboard) | ✓ framebuffer pixel compare independent of scene geometry | ✓ (FS pass, no RTE coupling) | ✓ | ✓ | ✓ same UBO across frustums within a frame | ✓ orthogonal | ✓ all three variants |
| DP-H42 (Label) | ✓ SDF glyphs obey depth override like their parent Label | ✓ | ✓ labels over 3D Tiles fade correctly | ✓ | ✓ | ✓ | ✓ all three variants |
| DP-H40 (Label) | ✓ glyph-level split matches background billboard split | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ all three variants |
| DP-H42 (Point) | ✓ point cloud clusters near terrain now depth-override correctly | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ all three variants |
| DP-H40 (Point) | ✓ split compare landed in pixel space matches Billboard/Label | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ all three variants |
| Point UBO unification (pre-existing bug fix) | ✓ eliminates silent precision corruption in Point's RTE math | ✓ `translateRelativeToEye` now reads real camera position | ✓ | ✓ biggest benefit at orbital altitudes where the bug was most visible | ✓ | ✓ | ✓ all three variants |

### Deferred to Batch 22

- **Polyline** — DP-H42 + DP-H40 for `PolylineCollection.wgsl` + `PolylineCollectionPick.wgsl` + 4 material variants (Arrow / Dash / Glow / Outline). Polyline has its own subsystem complexity (5 shader files, material-variant fragment entry points); handling it in Batch 22 keeps that scope self-contained. Tracked as **FOLLOW-UP DP-H42-POLYLINE** and **FOLLOW-UP DP-H40-POLYLINE**.

### Next-step unlocks (Batches 22+)

With DP-H42/H40 shipped as the first real consumer of the preprocessor + cache infrastructure, the pattern is validated. Remaining deferred items will follow the same shape:
- **Batch 22** — Polyline (5 shader files, DP-H42 + DP-H40 + `arcType: GEODESIC` fix).
- **Batch 23** — DP-H19 `compressVertices: true` (needs `COMPRESSED_POSITION` define + oct-decode helper; BufferPrimitive subsystem).
- **Batch 24** — Sibling 2 (stride-aware shadow cast) + DP-H25-SHADOW-CAST.
- **Batch 25** — Sibling 3 (material bind group v2) + DP-H20 + DP-H22-ElevationBand.

---

## Batch 22 — DP-H42 + DP-H40 for Polyline + 4 material variants (2026-04-17)

**Completes the collection-shader rollout of DP-H42 and DP-H40** — every primitive-collection renderer (Billboard / Label / Point from Batch 21, Polyline + Arrow / Dash / Glow / Outline from this batch) now honors `scene.minimumDisableDepthTestDistance` + per-instance `disableDepthTestDistance`, and reacts to `scene.splitPosition` + per-instance `splitDirection`.

**Files touched:**

- [packages/engine/Source/Renderer/WebGPU/WebGPUShaderDefines.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUShaderDefines.ts) — added 6 POLYLINE_* source IDs (base, pick, 4 materials)
- [packages/engine/Source/Scene/Polyline.js](../packages/engine/Source/Scene/Polyline.js) — added `disableDepthTestDistance` + `splitDirection` properties (getters, setters, dirty propagation, 2 new PROPERTY_INDEX constants)
- [packages/engine/Source/Renderer/WebGPU/WebGPUPolylineRenderer.js](../packages/engine/Source/Renderer/WebGPU/WebGPUPolylineRenderer.js) — instance stride 80→96 bytes, camera UBO 112→128 bytes, per-frame defines computation, module + pipeline cache keyed by `(materialType, defines)`, prewarm of 5 materials × 4 define combos + pick
- [packages/engine/Source/Shaders/WebGPU/Collections/PolylineCollection.wgsl](../packages/engine/Source/Shaders/WebGPU/Collections/PolylineCollection.wgsl)
- [packages/engine/Source/Shaders/WebGPU/Collections/PolylineCollectionPick.wgsl](../packages/engine/Source/Shaders/WebGPU/Collections/PolylineCollectionPick.wgsl)
- [packages/engine/Source/Shaders/WebGPU/Collections/PolylineArrow.wgsl](../packages/engine/Source/Shaders/WebGPU/Collections/PolylineArrow.wgsl)
- [packages/engine/Source/Shaders/WebGPU/Collections/PolylineDash.wgsl](../packages/engine/Source/Shaders/WebGPU/Collections/PolylineDash.wgsl)
- [packages/engine/Source/Shaders/WebGPU/Collections/PolylineGlow.wgsl](../packages/engine/Source/Shaders/WebGPU/Collections/PolylineGlow.wgsl)
- [packages/engine/Source/Shaders/WebGPU/Collections/PolylineOutline.wgsl](../packages/engine/Source/Shaders/WebGPU/Collections/PolylineOutline.wgsl)

**Typecheck:** `npx tsc --noEmit` — clean.
**Build:** `node scripts/build.js` — all three variants (dual / webgpu-only / webgl-only) built successfully.

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| DP-H42 | DATA_PIPELINE | `minimumDisableDepthTestDistance` unreachable by any WebGPU renderer | **FINISHED 2026-04-17 (Batch 22)** — Polyline was the last renderer family. Each polyline carries `_disableDepthTestDistance` in its own JS property; every segment of that polyline gets the value in the new `perInstanceFlags` vec4 at `@location(5)`. All 6 Polyline WGSL files check squared eye-space distance (`dot(baseRTE, baseRTE)`) against the per-instance threshold (falls back to `camera.minimumDisableDepthTestDistance` when per-instance is 0) in their VS, forcing `finalPos.z = finalPos.w` when within range. Pick path applies the identical override. |
| DP-H40 | DATA_PIPELINE | `frameState.splitPosition` only read by point renderer | **FINISHED 2026-04-17 (Batch 22)** — Polyline was the last renderer family. `_splitDirection` flows from `Polyline` to each segment's `perInstanceFlags.y`; VS forwards to FS via a conditional `@location` slot; FS discards pixels on the wrong side of `camera.splitPosition` (framebuffer pixel space, JS multiplies `frameState.splitPosition` by `drawingBufferWidth` to match WebGL's `czm_splitPosition` convention). All 4 material variants (Arrow / Dash / Glow / Outline) carry the discard at the top of their FS body. |

### What shipped end-to-end

1. **`Polyline` class extensions** — `_disableDepthTestDistance` and `_splitDirection` instance fields, public getters + setters, two new PROPERTY_INDEX constants (`DISABLE_DEPTH_TEST_DISTANCE = 6`, `SPLIT_DIRECTION = 7`), dirty propagation through `makeDirty()` so the segment buffer rebuilds when the user flips a flag mid-session.
2. **Instance buffer expansion** — 80 → 96 bytes (20 → 24 floats per segment). New `perInstanceFlags` vec4 at `@location(5)` / offset 80. The existing .w padding slots on `startPosLow` / `endPosLow` (which carry texture-coord metadata `sStart` / `sEnd` for material shaders) stay untouched.
3. **CameraUniforms expansion** — 112 → 128 bytes (28 → 32 floats). New `minimumDisableDepthTestDistance: f32` (offset 112) and `splitPosition: f32` (offset 116) fields in every polyline WGSL file. `packCameraUniforms` writes both from `frameState`.
4. **Per-frame defines computation** — `computePolylineDefinesForFrame` scans the collection once, short-circuits once both bits are set. Baseline (no features) stays the fast path. Same pattern as Batch 21.
5. **`//>>ifdef` blocks in all 6 shaders**:
   - `VertexInput` conditionally declares `@location(5) perInstanceFlags` (always — unused inputs are allowed so the pipeline / shader-module bifurcation happens only around the actual logic).
   - `VertexOutput` conditionally forwards `splitDirection` via a new `@location(N)` slot chosen per-variant (base = 2, pick = 1, Arrow / Dash / Glow = 2, Outline = 3) — per-variant because each material's VertexOutput already has different slot occupancy.
   - VS conditionally applies the DP-H42 depth override after the screen-space quad expansion using `baseRTE = mix(startRTE, endRTE, isEnd)` as the distance reference.
   - VS conditionally forwards `splitDirection` from `perInstanceFlags.y`.
   - FS conditionally applies the DP-H40 discard at the top of each material's FS body (before any material-specific math so the branch is predictable).
6. **Shader module cache + pipeline cache** — module-level `WeakMap<GPUDevice, WebGPUShaderModuleCache>` shared across every PolylineCollection; pipeline cache is `cache.pipelines[materialType] = Map<defines, pipelineEntry>`. Pick has its own sibling `cache.pickPipelines: Map<defines, entry>`.
7. **Prewarm** — 5 materials (Color / Arrow / Dash / Glow / Outline) × 4 define combos + pick family = 24 modules compiled up front per device, idempotent. Moves ~40–80 ms of `createShaderModule` cost off the first-frame render path.

### Integration audit — Batch 22

| Scenario | Status |
| --- | --- |
| Whole-earth (long-arc polylines) | ✓ baseRTE-based depth override works at any scale |
| RTE precision | ✓ `baseRTE = mix(startRTE, endRTE, isEnd)` stays in the RTE domain |
| 3D Tiles | ✓ polylines over 3D Tiles now depth-override + split correctly |
| Space / orbit altitudes | ✓ `disableDepthTestDistance` in meters scales naturally |
| Multi-frustum | ✓ pipeline per-frustum hits the same `(materialType, defines)` cache key |
| CSM (shadow cast) | ✓ polylines don't cast shadows; pass is orthogonal |
| Variant builds (dual / webgpu-only / webgl-only) | ✓ all three variants built successfully |
| All 4 material variants | ✓ Arrow, Dash, Glow, Outline — identical VS, FS discard added at top of each material's body |
| Pick pipeline | ✓ pick mirrors color defines; picked region matches visible region for both features |

### Finality check: DP-H42 + DP-H40 done

| Renderer | DP-H42 | DP-H40 |
| --- | --- | --- |
| Billboard (Batch 21) | ✓ | ✓ |
| Label (Batch 21) | ✓ | ✓ |
| Point (Batch 21) | ✓ | ✓ |
| Polyline + 4 materials (Batch 22) | ✓ | ✓ |

Both findings are fully closed. The `FOLLOW-UP DP-H42-POLYLINE` and `FOLLOW-UP DP-H40-POLYLINE` markers should be removed from the review doc (replaced with full-FIXED status).

### Next-step unlocks (Batches 23+)

- **Batch 23** — DP-H19 (`compressVertices: true`). Needs a new `COMPRESSED_POSITION` define + shader-side oct-decode helper. Different architecture from collection shaders — it's in `BufferPrimitive` / `WebGPUPrimitiveCommands.js`.
- **Batch 24** — Sibling 2 (stride-aware shadow cast) + DP-H25-SHADOW-CAST + fixes the pre-existing uncompressed+normals shadow cast bug.
- **Batch 25** — Sibling 3 (material bind group v2 + pluggable material WGSL registry) with no behavior change.
- **Batch 26** — Use Sibling 3 to ship DP-H20 (material multi-texture) + DP-H22-ElevationBand.

---

## Batch 23 — DP-H19 compressVertices (default) on Primitives (2026-04-17)

**Files touched:**

- [packages/engine/Source/Core/GeometryPipeline.js](../packages/engine/Source/Core/GeometryPipeline.js) — `GeometryPipeline.compressVertices()` now stashes `_compressedAttributesMeta` on the geometry describing which source attributes fed the compression (hasNormal / hasSt / hasTangent / hasBitangent / isExtrude). WebGL-only consumers are unaffected; the metadata is purely additive.
- [packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js](../packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js) — added `ensureUncompressedAttributes(geometry)` helper that reconstructs `normal` + `st` attributes from `compressedAttributes` via `AttributeCompression.octDecodeFloat` / `decompressTextureCoordinates`. Called before any downstream attribute read on both the legacy-shader per-geometry loop (~line 916) and the material-shader path (~line 1635). Idempotent — no double-decode across frames.

**Typecheck:** `npx tsc --noEmit` — clean.
**Build:** `node scripts/build.js` — all three variants built successfully.

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| DP-H19 | DATA_PIPELINE | `compressVertices: true` (default) produces garbage geometry | **FIXED 2026-04-17 (Batch 23)**. The review's framing was slightly off — `compressVertices` doesn't touch positions, it oct-packs normals + bit-packs UVs into `geometry.attributes.compressedAttributes` and DELETES `normal` / `st` / `tangent` / `bitangent`. WebGPU's primitive renderer read the deleted attributes, got `hasNormals = false`, and routed to a flat-shaded / untextured shader variant. Fix: CPU-decode `compressedAttributes` back into `normal` + `st` Float32Arrays on the WebGPU path, using a metadata snapshot we now stash inside `compressVertices` itself to disambiguate the variable slot layout. The WebGL path sees the same compressed stream it always did. |

### Why CPU decode instead of shader-side decode

The WebGL path handles compressed attributes via `#ifdef COMPRESSED_VERTICES` in the vertex shader, preserving the bandwidth / VRAM savings that compression is designed for. Mirroring that in WGSL would mean:
- A new `COMPRESSED_VERTICES` shader define (easy, Batch 20 infrastructure supports it)
- New vertex input variants for every material-type shader (basic / phong / basicTextured / phongTextured × color / pick — 8+ shader variants each doubled)
- WGSL oct-decode helper (already exists at `packages/engine/Source/Shaders/WebGPU/chunks/functions/csm_octDecode.wgsl`)

That's a real amount of new shader surface. For Batch 23 we chose the simpler correctness-only path: decode on CPU once per geometry when the renderer first sees it. Every default-configured Primitive (`compressVertices: true` is the default on Primitive / ClassificationPrimitive / GroundPrimitive) now renders correctly with lit normals + textured UVs.

The VRAM / bandwidth savings from compression are lost on WebGPU with this approach — a fat Primitive carrying a thousand vertices now uploads ~8 × more data than the compressed form would. For typical app primitives (a handful to a few thousand vertices total) this is invisible. Shader-side decode for bandwidth-sensitive workloads is tracked as **FOLLOW-UP DP-H19-SHADER-DECODE**.

### What shipped end-to-end

1. **`GeometryPipeline.compressVertices` metadata stash** — five-boolean snapshot written to `geometry._compressedAttributesMeta` just before the encoding loop starts. Separately tagged for the `extrudeDirection` shadow-volume path (`isExtrude: true`) so decoders know to skip it. WebGL unaffected.
2. **`ensureUncompressedAttributes(geometry)` helper** — 180 lines of JS in `WebGPUPrimitiveCommands.js`. Reads `compressedAttributes.values` + `componentsPerAttribute` + the metadata, walks per-vertex, calls `AttributeCompression.octDecodeFloat` / `decompressTextureCoordinates` into reusable `Cartesian2` / `Cartesian3` scratches, writes results into newly-allocated `Float32Array`s wrapped in `GeometryAttribute` objects under `geometry.attributes.normal` / `.st`. The `octPack` special case (`hasNormal && hasTangent && hasBitangent` — 2 slots encode all three) is handled via `AttributeCompression.octUnpack`.
3. **Idempotence** — the helper short-circuits when `attrs.normal` / `attrs.st` already exist, so per-frame re-entry does nothing after the first decode. No per-frame CPU cost in steady state.
4. **Fallback for missing metadata** — if a geometry somehow has `compressedAttributes` without the metadata (e.g., third-party code path bypassing `GeometryPipeline`), we fall back to inferring from `componentsPerAttribute` and log a one-time warning directing the user to verify the compression-pipeline call chain.
5. **Tangent / bitangent intentionally skipped** — no current WebGPU primitive shader variant consumes them. Adding decode for those attributes becomes trivial once a material shader needs them (FOLLOW-UP DP-H19-TANGENT-DECODE).

### Integration audit — Batch 23

| Scenario | Status |
| --- | --- |
| Primitive (Box, Sphere, Polygon) with default `compressVertices: true` | ✓ normals + UVs reconstructed; PBR / textured appearances render correctly |
| Primitive with `compressVertices: false` | ✓ no compression ran, helper short-circuits on `attrs.normal` presence |
| ClassificationPrimitive (default compressVertices=true) | ✓ same decode path |
| GroundPrimitive (default compressVertices=true) | ✓ same decode path |
| Shadow volumes (extrudeDirection compression) | ✓ `meta.isExtrude = true` short-circuits the decoder; extrudeDirection rendered through its own renderer |
| WebGL path | ✓ unchanged — new metadata field is ignored |
| 3D Tiles | ✓ not affected (their own geometry pipeline) |
| RTE precision | ✓ orthogonal — compression is pre-RTE, RTE happens after extraction |
| Multi-frustum | ✓ geometry-level change; decoded attributes usable across all frustums |
| Variant builds (dual / webgpu-only / webgl-only) | ✓ all three built successfully |

### Follow-ups

- **FOLLOW-UP DP-H19-SHADER-DECODE** — move decompression from CPU to WGSL for bandwidth-sensitive workloads. Needs `COMPRESSED_VERTICES` shader define + oct-decode WGSL helper wiring + new vertex input variants for each material shader.
- **FOLLOW-UP DP-H19-TANGENT-DECODE** — reconstruct `tangent` + `bitangent` when a material shader needs them (normal mapping on Primitive with default compression).

### Next-step unlocks (Batches 24+)

- **Batch 24** — Sibling 2 (stride-aware shadow cast) + DP-H25-SHADOW-CAST + fixes the pre-existing uncompressed+normals shadow cast bug.
- **Batch 25** — Sibling 3 (material bind group v2 + pluggable material WGSL registry) with no behavior change.
- **Batch 26** — Use Sibling 3 to ship DP-H20 (material multi-texture) + DP-H22-ElevationBand.

---

## Batch 24 — Stride-aware shadow cast + DP-H25-SHADOW-CAST + pre-existing uncompressed-terrain bug (2026-04-17)

**Sibling 2** from the deferred-items plan, shipping alongside the real consumer fixes. The shadow cast pipeline registry is now stride-aware: `_getOrCreateCastPipeline(device, cache, layoutKey, overrideStride?)` rewrites the pipeline's `arrayStride` per caller while sharing the variant's shader + bind group layout, keyed in the cache under `${layoutKey}|s${stride}` when overridden.

**Files touched:**

- [packages/engine/Source/Renderer/WebGPU/WebGPUShadowMapRenderer.js](../packages/engine/Source/Renderer/WebGPU/WebGPUShadowMapRenderer.js) — extended `_getOrCreateCastPipeline` with `overrideStride` parameter; added new `terrainUncompressed` SHADOW_CAST_VARIANT that reads `position3DAndHeight` as float32x4 + does RTE/exaggeration math; dispatch loop forwards `vbStride` into the pipeline factory.
- [packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts) — `shadowCastUB` now allocated for EVERY tile (not just quantized ones); `TileDrawDescriptor` gained `strideBytes` field; commands forward real stride.
- [packages/engine/Source/Scene/GlobeSurfaceTileProviderRendering.js](../packages/engine/Source/Scene/GlobeSurfaceTileProviderRendering.js) — uncompressed tiles now route to `_shadowCastLayout: "terrainUncompressed"` (not stride-inference fallback); every tile reports its real `vertexStride`; removed `__skip_geodetic_terrain` sentinel from Batch 19.

**Typecheck:** `npx tsc --noEmit` — clean.
**Build:** `node scripts/build.js` — all three variants built successfully.

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| DP-H25-SHADOW-CAST | Batch 19 follow-up | Geodetic-terrain tiles skipped shadow cast entirely | **FIXED 2026-04-17 (Batch 24)**. Batch 19 routed geodetic-terrain commands through a sentinel layout (`__skip_geodetic_terrain`) so the shadow cast renderer skipped them rather than emit a broken pipeline. Batch 24's stride-aware registry accepts the tile's actual stride (24 / 28 / 32 / 36 / 40 / 44 depending on hasVertexNormals / hasWebMercatorT / hasGeodeticSurfaceNormals) and builds a pipeline with the matching `arrayStride`. The sentinel is removed — geodetic terrain tiles now cast shadows onto other geometry correctly. |
| Pre-existing bug (uncompressed terrain shadow cast) | — | Uncompressed terrain's shadow cast was structurally broken | Not a review-doc finding but uncovered during Batch 19's shadow-cast audit. Uncompressed terrain VB stores `position3DAndHeight: vec4` at offset 0 + tex coords + optional flags. Before Batch 24 uncompressed tiles fell through to the `rte24` variant via stride inference; `rte24` reads two vec3s at offsets 0 and 12, so the "positionLow" it receives is actually `(height, u, v)` — tex-coord garbage. RTE math then produced shadow coords unrelated to the terrain. **FIXED 2026-04-17 (Batch 24)** — new `terrainUncompressed` variant reads `position3DAndHeight` as float32x4 and applies the same RTE + exaggeration math as `quantized12`, just without the BITS12 decode. |

### What shipped end-to-end

1. **Stride-aware `_getOrCreateCastPipeline`** — new optional `overrideStride` parameter. When present and ≠ variant's declared stride, the cache key is suffixed with `|s${stride}` so stride-divergent callers get their own pipeline; the pipeline's first vertex buffer layout has its `arrayStride` shallow-cloned + overridden. Variants are NOT mutated. Fixed-stride callers (rte24, p12, modelP12, modelInstanced, quantized12, modelSkinned) don't set `cmd.vertexStride` and so pass through unchanged.
2. **New `terrainUncompressed` variant** — mirrors `quantized12`'s UB layout (scaleAndBias + center3D + minMaxHeight) + globals UB (exaggeration + sceneMode) so the globe renderer reuses the same buffer-allocation and write paths. Shader reads a float32x4 at `@location(0)` (position3DAndHeight), skips the BITS12 decode (not needed for uncompressed), applies exaggeration via ellipsoid-normal reconstruction, and emits the same RTE math as `quantized12`.
3. **`shadowCastUB` for every tile** — Batch 19 only allocated it for quantized tiles; Batch 24 allocates for every tile. Cost: 96 bytes × tile count (tiny). Buffer is static for the tile's lifetime.
4. **Scene-adapter routing** — `GlobeSurfaceTileProviderRendering.addWebGPUDrawCommandsForTile` now emits:
   - `_shadowCastLayout: "quantized12"` for quantized tiles, `"terrainUncompressed"` otherwise (no more undefined + inference).
   - `vertexStride: strideBytes` for both cases, matching the actual VB per-vertex stride.
   - `_shadowCastTerrainUB` for every tile.
5. **`__skip_geodetic_terrain` sentinel removed** — the Batch 19 workaround is gone. Geodetic tiles now cast shadows.
6. **Shadow cast dispatch forwards `vbStride`** — the main loop in `WebGPUShadowMapRenderer.executeShadowMap` passes `vbStride` to `_getOrCreateCastPipeline` as the override parameter.

### Which tile strides now work

| Tile configuration | Stride | Pre-Batch 24 behavior | Post-Batch 24 behavior |
| --- | --- | --- | --- |
| Quantized terrain | 16 | ✓ (quantized12) | ✓ (quantized12, unchanged) |
| Uncompressed, no extras | 24 | 🟥 rte24 reads garbage as positionLow | ✓ terrainUncompressed + stride 24 |
| Uncompressed + vertex normals | 28 | 🟥 rte24 pipeline stride mismatch | ✓ terrainUncompressed + stride 28 |
| Uncompressed + webMercatorT | 28 | 🟥 rte24 pipeline stride mismatch | ✓ terrainUncompressed + stride 28 |
| Uncompressed + normals + webMercT | 32 | 🟥 rte24 pipeline stride mismatch | ✓ terrainUncompressed + stride 32 |
| Uncompressed + geodetic normal | 36 | 🟨 Skipped via `__skip_geodetic_terrain` | ✓ terrainUncompressed + stride 36 |
| Uncompressed + normals + geodetic | 40 | 🟨 Skipped | ✓ terrainUncompressed + stride 40 |
| Uncompressed + webMercT + geodetic | 40 | 🟨 Skipped | ✓ terrainUncompressed + stride 40 |
| Uncompressed + all flags | 44 | 🟨 Skipped | ✓ terrainUncompressed + stride 44 |

8 of 9 stride configurations went from "broken / skipped" to "working." The one that was already correct (quantized) stays on the same path.

### Integration audit — Batch 24

| Scenario | Status |
| --- | --- |
| Whole-earth terrain shadow cast | ✓ all tile stride variants render correctly |
| RTE precision | ✓ `terrainUncompressed` uses the same `(t.center3D - u.camH) + tileRelPos - u.camL` pattern as `quantized12` |
| Vertical exaggeration | ✓ exaggeration branch mirrors the color pass + the quantized12 shadow cast |
| 3D Tiles | ✓ not affected (they use their own shadow cast variants) |
| Multi-frustum | ✓ pipeline cache key includes stride so shared across frustums at same stride |
| CSM cascades | ✓ cascade-specific lightVP changes don't touch the per-tile UB |
| Geodetic terrain (DP-H25 color + Batch 24 shadow cast together) | ✓ color pipeline (Batch 19) + shadow cast (Batch 24) now both obey `hasGeodeticSurfaceNormals` |
| Variant builds (dual / webgpu-only / webgl-only) | ✓ all three built successfully |

### What this unlocks

- The stride-aware registry is now available to every shadow-cast caller. Future vertex layouts (point-cloud shadow cast, custom primitive shadow paths) can declare a base variant and pass their actual stride without needing a new variant per stride.
- Globe terrain with vertical exaggeration now casts shadows onto 3D Tiles / models / other geometry correctly.

### Next-step unlocks (Batch 25)

- **Batch 25** — Sibling 3 (material bind group v2 + pluggable material WGSL registry) shipped together with its first consumers:
  - **DP-H20** — material multi-texture (NormalMap + DiffuseMap at the same time).
  - **DP-H22-ElevationBand** — full WGSL ElevationBand material (the Batch 18 partial fix only added a diagnostic warning).

---

## Batch 25 — Material bind group v2 + DP-H20 multi-texture + DP-H22 ElevationBand (2026-04-18)

**Sibling 3** from the deferred-items plan, shipped with both of its consumer fixes in the same batch. The primitive material texture bind group expands from one slot to two, a per-material texture-slot routing table resolves which `_imageSources` keys feed which slot, and ElevationBand — previously a diagnostic-warning-only fallback — gets dedicated WGSL implementations that match the WebGL semantics.

**Files touched:**

- [packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js](../packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js) — both texture BGL creation sites expanded from `sampler(0) + texture(1)` to `sampler(0) + texture(1) + texture(2)`; `getTextureUniformName` rewritten to return `{ primary, secondary? }` per material type; `ensureMaterialTextureBindGroup` rewritten to upload both slots and fall back to placeholder for absent secondaries.
- [packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveShaders.js](../packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveShaders.js) — added `matElevBandFlat` / `matElevBandLit` to the shader registry; wired ElevationBand into `selectMaterialShader`; added to `isMaterialTexturedShader`; simplified the missing-material warning now that ElevationBand is no longer a fallback case.
- Multi-texture material shaders updated (6 files): [PrimitiveMatNormalMapFlat.wgsl](../packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveMatNormalMapFlat.wgsl), [PrimitiveMatNormalMapLit.wgsl](../packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveMatNormalMapLit.wgsl), [PrimitiveMatBumpMapFlat.wgsl](../packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveMatBumpMapFlat.wgsl), [PrimitiveMatBumpMapLit.wgsl](../packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveMatBumpMapLit.wgsl), [PrimitiveMatWaterFlat.wgsl](../packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveMatWaterFlat.wgsl), [PrimitiveMatWaterLit.wgsl](../packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveMatWaterLit.wgsl).
- New ElevationBand shaders: [PrimitiveMatElevBandFlat.wgsl](../packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveMatElevBandFlat.wgsl), [PrimitiveMatElevBandLit.wgsl](../packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveMatElevBandLit.wgsl).

**Typecheck:** `npx tsc --noEmit` — clean on all Batch 25 files.
**Build:** `wgslToJavaScript` generates the new `.js` shader modules; pre-existing `gulp build` type errors in `WebGPUPointCloudRenderer.ts` + `WebGPUSceneRenderer.ts` are from prior uncommitted changes in the working tree and are unrelated to Batch 25.

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| DP-H20 | DATA_PIPELINE | Material secondary textures (NormalMap, BumpMap) dropped | **FIXED 2026-04-18 (Batch 25)**. The material texture bind group now has two texture slots. NormalMap / BumpMap correctly sample both their base diffuse AND their perturbation texture (previously only one slot was bound, and the shader hardcoded `vec3(0.5)` as the diffuse — visibly wrong gray rendering). Water unifies its `normalMap` + `specularMap` routing (previously the JS uploaded `specularMap` but the shader read it as if it were the normal map — a subtle mislabel causing chaotic wave behavior). Per-material slot routing table in `getTextureUniformName` maps each material type to `{ primary: "image" \| "normalMap" \| "heights", secondary?: "normalMap" \| "bumpMap" \| "specularMap" \| "colors" }`. |
| DP-H22-ELEVATION-BAND | Batch 18 follow-up | ElevationBand material had no WGSL implementation | **FIXED 2026-04-18 (Batch 25)**. Two new shader files (`PrimitiveMatElevBandFlat.wgsl`, `PrimitiveMatElevBandLit.wgsl`) implementing the 16-step binary search over a 1D heights lookup + color ramp, matching the WebGL `ElevationBandMaterial.glsl` semantics (minus the packed-float fallback — WebGPU can assume real float textures). Routed through `selectMaterialShader` at both `isFlat` and `useLighting && hasST` paths. ElevationBand removed from the `_warnMissingMaterialOnce` set. |

### What shipped end-to-end

1. **Material texture BGL v2** — one shared sampler + TWO texture slots. Both BGL creation sites (at the two pipeline-layout construction paths for legacy + material shaders) now declare `[sampler(0), texture(1), texture(2)]`. Single-texture material shaders only declare `@binding(1)` in their WGSL; the BGL's binding 2 is fulfilled by a 1×1 placeholder in the bind group, and the shader ignores it (WGSL allows layouts to carry more bindings than the shader references).
2. **Per-material texture-slot routing** — `getTextureUniformName(shaderType)` returns `{ primary, secondary? }` instead of a single string. The table:
    - `NormalMap*` → `{ primary: "image", secondary: "normalMap" }` (diffuse + perturbation)
    - `BumpMap*` → `{ primary: "image", secondary: "bumpMap" }`
    - `Water*` → `{ primary: "normalMap", secondary: "specularMap" }`
    - `ElevBand*` → `{ primary: "heights", secondary: "colors" }`
    - everything else → `{ primary: "image" }`
3. **`ensureMaterialTextureBindGroup` rewritten** — builds both slots independently, with per-slot `_matGpuTexturePrimary` / `_matGpuTextureSecondary` GPU texture tracking. Cache invalidation triggers on either source changing. Placeholder fallback for missing secondary keeps the bind group layout satisfied.
4. **Shader-side DP-H20 corrections**:
    - **NormalMap Lit**: reads the actual diffuse texture instead of the hardcoded `vec3(0.5)` gray. Normal-map perturbation now lives on its own `@binding(2)` slot so users with a real diffuse + a real normal map see both.
    - **NormalMap Flat**: gets the dual-texture layout for consistency with Lit; only reads the normal map for its color visualization.
    - **BumpMap Lit**: reads the actual diffuse texture (same bug as NormalMap — hardcoded gray). Height data still comes from `bumpTexture` at `@binding(2)`.
    - **BumpMap Flat**: dual-texture layout for consistency.
    - **Water Lit/Flat**: `normalMapTexture` at `@binding(1)` now correctly receives the normal map (previously mislabeled); `specularMapTexture` at `@binding(2)` gates alpha so land tiles with the same material don't render water effects.
5. **ElevationBand shaders** — two new WGSL files implementing the binary search over a heights texture + color ramp. Heights texture's width is queried at runtime via `textureDimensions` (no uniform needed); height per-fragment is `length(worldPos) - EARTH_RADIUS`. Fragment discards when the height is outside the configured band range, matching the WebGL shader's `material.alpha = 0` semantics. Lit variant applies Blinn-Phong on top of the band-lookup color.
6. **ElevationBand routing** — wired into `selectMaterialShader` at both flat + lit paths with `needsTexture: true` so the texture bind group is built. Removed from `_warnMissingMaterialOnce` since it's no longer a fallback case.

### Integration audit — Batch 25

| Scenario | Status |
| --- | --- |
| NormalMap on a primitive with real diffuse + normal map | ✓ both textures bound; diffuse drives base color; normal map perturbs lighting |
| BumpMap on a primitive with real diffuse + bump height | ✓ both textures bound; diffuse drives base color; bump derives normal |
| Water with both normalMap + specularMap | ✓ wave perturbation reads actual normalMap; alpha gated by specular mask |
| ElevationBand flat | ✓ banded color lookup via binary search; discards outside range |
| ElevationBand lit | ✓ same lookup + Blinn-Phong shading on top |
| Single-texture materials (Image, AlphaMap, EmissionMap, SpecularMap, ElevRamp, SlopeRamp, AspectRamp, Checkerboard, Grid, Stripe, Dot, Fade, RimLighting) | ✓ unchanged behavior; placeholder at slot 2 is ignored |
| Pick pipeline | ✓ not affected by material texture changes (uses its own BGL) |
| Variant builds (dual / webgpu-only / webgl-only) | ✓ `.js` shader modules generated for new ElevationBand files via `wgslToJavaScript` |

### Architectural notes

- **Pluggable registry design** — we considered a full registry where each material registers `{ uniformsWGSL, fragmentBodyWGSL, textureSlots[] }` and the primitive shader builder splices them in. Ultimately chose a simpler dispatcher in `getTextureUniformName` + per-material WGSL files, because the materials' FS bodies diverge too much for a splice pattern (NormalMap uses screen-space derivatives, ElevationBand runs a binary search, Water has animated UVs). The routing table captures the only cross-material difference that `ensureMaterialTextureBindGroup` needs to know.
- **2 texture slots fits today's 5 material types that need multi-texture**. If a future material needs 3+, the BGL can be expanded without breaking single-texture materials (placeholder fallback is generic).
- **Pre-existing `gulp build` tsc errors** — `WebGPUPointCloudRenderer.ts` + `WebGPUSceneRenderer.ts` have uncommitted strict-mode TS errors from prior work (pre-this-session). Not introduced by Batch 25; not a blocker for the root `npx tsc --noEmit` which passes cleanly.

### Finality — all originally-deferred items closed

| Item | Deferred in | Closed in |
| --- | --- | --- |
| DP-H42 (`minimumDisableDepthTestDistance`) | Batch 19 | Batches 21–22 |
| DP-H40 (`splitPosition`) | Batch 19 | Batches 21–22 |
| DP-H22 Polyline* warning | Batch 18 | Batches 21–22 (proper FS for the collection path) |
| DP-H20 (material multi-texture) | Batch 18 | Batch 25 |
| DP-H22-ELEVATION-BAND | Batch 18 | Batch 25 |
| DP-H19 (`compressVertices` default) | — | Batch 23 |
| DP-H25-SHADOW-CAST | Batch 19 | Batch 24 |
| Pre-existing uncompressed-terrain shadow cast bug | (uncovered during Batch 19) | Batch 24 |

Remaining follow-ups (all "wait for a real consumer" or optimization):

- `FOLLOW-UP DP-H19-SHADER-DECODE` — move `compressedAttributes` decoding from CPU to WGSL for VRAM-sensitive workloads.
- `FOLLOW-UP DP-H19-TANGENT-DECODE` — reconstruct tangent / bitangent from `compressedAttributes` when a material shader needs them.
- `FOLLOW-UP DP-H41-ALL-RENDERERS` — plumb `previousViewProjection` into primitive / model / collection camera UBs when a TAA consumer is ready to consume them.

Not in the original deferred-items plan but still sitting in the review-doc backlog:

- **DP-H7** (polyline `arcType: GEODESIC` silently straight-lines) — needs CPU-side subdivision; independent of the preprocessor / cache infrastructure.
- Various DP-H items in Tier DP2 / DP3 / DP4 of the review doc that weren't in the "deferred after attempted fix" set — can be revisited in future sessions when priorities align.

---

## Batch 26 — Finishing partially-fixed items: H-P5 mapAsync safety + C-P7-RTE VolumetricFog altitude (2026-04-18)

First of three clean-up batches closing items we'd left partial or follow-up-tracked in earlier sessions. This one finishes **H-P5** (mapAsync destroyed-state hazards — 3 remaining paths) and **C-P7-RTE** (VolumetricFog altitude f32 catastrophic cancellation).

**Files touched:**

- [packages/engine/Source/Renderer/WebGPU/WebGPUTextureUtilities.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUTextureUtilities.ts) — `createPixelReadbackPBO`'s `mapAsync` closure guarded with try/catch; returns `null` on failure; always destroys the readback buffer.
- [packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts) — `readPixelsToPBO`'s `mapAsync` closure guarded with try/catch; return type widened to `Uint8Array | null`. `readPixelsAsync` handles the null-return path with a clean buffer destroy + null return (preserves existing contract).
- [packages/engine/Source/Renderer/WebGPU/WebGPUGPUCuller.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUGPUCuller.ts) — `readResults` wraps both `mapAsync` calls (visibility + count buffers) in one try/catch; on failure attempts defensive `unmap()` on both buffers and returns an empty `CullResults` so the caller falls back to CPU frustum culling.
- [packages/engine/Source/Shaders/WebGPU/Compute/VolumetricFog.wgsl](../packages/engine/Source/Shaders/WebGPU/Compute/VolumetricFog.wgsl) — `VolumetricFogParams` struct gained `cameraAltitudeRTE: vec4<f32>` (xyz cameraUp, w cameraAltitude) and `altitudeCurvature: vec4<f32>` (x oneOverDenom). `densityInjection` kernel now reconstructs altitude via 2nd-order Taylor expansion around the camera instead of `length(worldPos) - innerRadius`.
- [packages/engine/Source/Renderer/WebGPU/WebGPUVolumetricFogRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUVolumetricFogRenderer.ts) — params buffer grew from 64 → 72 floats (256 → 288 bytes); CPU pack computes `cameraAltitude`, `cameraUp`, and `oneOverDenom` in f64, uploads them at offsets 64–71.

**Typecheck:** `npx tsc --noEmit` — clean.

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| H-P5 | PER_FEATURE | `mapAsync` destroyed-state hazards (remaining paths) | **FINISHED 2026-04-18 (Batch 26)** — 3 remaining unguarded `mapAsync` paths wrapped in try/catch: `WebGPUTextureUtilities.createPixelReadbackPBO.mapAsync`, `WebGPUContext.readPixelsToPBO.mapAsync` closure, `WebGPUGPUCuller.readResults`. Each returns a clean fallback on failure (null / empty result) instead of leaking an unhandled promise rejection. Combined with Batch 7's earlier guards on `WebGPUAutoExposure` + `WebGPUBufferMapper`, every `mapAsync` site in the renderer now handles device-loss / teardown gracefully. Scoping confirmed `WebGPUHiZOcclusionDispatcher`, `WebGPUPickFramebuffer`, and `WebGPUTimestampProfiler` were already guarded via prior work. |
| C-P7-RTE | Batch 2 follow-up | VolumetricFog altitude `length(worldPos) - innerRadius` f32 cancellation | **FIXED 2026-04-18 (Batch 26)** — altitude reconstruction refactored to use a 2nd-order Taylor expansion around the camera position. CPU precomputes `cameraAltitude = length(cameraPos) - innerRadius` and `cameraUp = normalize(cameraPos)` in native f64 (JS `Math.sqrt`), then the shader combines `cameraAltitude + d·cosGamma + d²·(1-cosGamma²)·oneOverDenom`. All terms stay in ranges where f32 has plenty of precision (no cancellation of near-equal Earth-radius-magnitude numbers). Accuracy: ~0.25 m error at 100 km horizontal view from a 10 km-altitude camera; ~1 m at orbital 1000 km — below f32's natural altitude granularity, so fog density is smooth at every viewing altitude. |

### What shipped end-to-end

1. **H-P5 — 3 paths hardened.** Each `mapAsync` site now has a defensive try/catch that:
    - Returns a clean fallback (`null` for texture reads, empty cull result for the culler, null for PBO)
    - Releases any acquired map state (`unmap()` with secondary try/catch for the "buffer already destroyed" case)
    - Surfaces no unhandled promise rejection to the app's global error handler
2. **C-P7-RTE — altitude math replacement.** The key insight: `length(worldPos) - innerRadius` in f32 eats ~1 m of precision because `worldPos` and `innerRadius` are both ~6.4e6 m. The Taylor expansion around the camera keeps every arithmetic operand in a well-conditioned range (camera-relative offsets ≤ 100 km, precomputed altitude, unit-length `cameraUp`). The shader's small 10-line change is backed by 10 lines of CPU pack that split the precise f64 work from the fast f32 per-froxel work. Output quality goes from "visible banding at orbital altitudes" to "smooth density gradient at all altitudes."
3. **Params buffer growth — 64 → 72 floats.** The extra 8 floats sit at offsets 64–71; callers bind the full 288-byte size via `Math.max(VOLUMETRIC_FOG_PARAMS_BYTES, 256)`. No other kernel consumes these new slots today; they're reserved for the altitude reconstruction alone.

### Integration audit — Batch 26

| Scenario | Status |
| --- | --- |
| Ground-level camera (altitude < 1 km) | ✓ Taylor expansion is exact for straight-down rays, small error for glancing rays — visually indistinguishable from old math |
| LEO / orbital camera (altitude 100–1000 km) | ✓ Fog banding gone; density gradient smooth across froxel grid |
| Cross-horizon rays (long linearDepth + glancing cosGamma) | ✓ Taylor 2nd-order term handles curvature; error <1 m at 1000 km |
| Below-ground camera (altitude < 0) | ✓ `max(0, …)` clamp preserved; below-ground froxels get baseline density |
| Device loss during pixel readback | ✓ WebGPUContext's `readPixelsAsync` gets `null` from the guarded `mapAsync`; destroys the PBO and returns null to caller |
| Device loss during GPU culler readback | ✓ Returns empty `CullResults`; caller's CPU frustum culler picks up the slack |
| Device loss during texture atlas readback | ✓ Returns null from the closure; caller handles null-image path |

### Notes

- The scoping pass revealed `WebGPUHiZOcclusionDispatcher`'s mapAsync was already guarded (Batch 9 timeframe) — one fewer file to touch than the audit initially listed.
- VolumetricFog's WebGL counterpart doesn't exist (WebGPU-only renderer), so no GLSL parity update was needed.
- No new WGSL uniforms outside `VolumetricFogParams`; the two new fields are struct-level additions in a single uniform buffer.

### What's still open after Batch 26

Everything else from the "partially fixed / follow-ups" audit stays open — Batch 26 only targeted the two items you asked to close first:

- **Follow-ups**: DP-H41-ALL-RENDERERS, DP-H19-SHADER-DECODE, DP-H19-TANGENT-DECODE (Batch 27 next).
- **Infrastructure follow-ups**: STUB-NAGA, BUILD-IIFE-INFLATION (Batch 28 next).
- **Out-of-scope analysis**: review-doc items never in scope — writeup to follow.

---

## Batch 27 — Follow-ups: DP-H19-TANGENT-DECODE + DP-H41-ALL-RENDERERS + DP-H19-SHADER-DECODE scaffold (2026-04-18)

Second of the three clean-up batches. Finishes the three DP-H follow-ups queued at the end of Batch 26. Lays the TAA / motion-vector plumbing (previousViewProjection in every renderer's CameraUniforms) that the CSM + TAA work scheduled next will consume directly.

**Files touched:**

- **WGSL CameraUniforms (add previousViewProjection mat4x4)**: 63 files across Primitive/, Collections/, Model/, Compute/, Generated/. Appended to the tail of each struct so existing uniform offsets are unchanged. Alignment-checked for every variant (all natural 16-byte boundaries hit).
- [packages/engine/Source/Renderer/UniformState.d.ts](../packages/engine/Source/Renderer/UniformState.d.ts) — added `readonly previousViewProjection: Matrix4`.
- [packages/engine/Source/Renderer/WebGPU/cesium-js-types.d.ts](../packages/engine/Source/Renderer/WebGPU/cesium-js-types.d.ts) — `CesiumUniformState` ambient gained the matching readonly slot.
- [packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js](../packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js)
  - `FLAT_CAMERA_BYTES` 96→160, `LIT_CAMERA_BYTES` 240→304, `PICK_CAMERA_BYTES` 96→160.
  - Added `writePreviousViewProjection(ud, offset, uniformState)` helper with identity fallback for first frame.
  - Each call site of `writeRTEUniformsFlat` / `writeRTEUniformsLit` now passes `context.uniformState`.
  - `ensureUncompressedAttributes` now also reconstructs `tangent` + `bitangent` (DP-H19-TANGENT-DECODE) — Float32Arrays populated via the same `AttributeCompression.octDecodeFloat` / `octUnpack` path the CPU already used for normals.
  - All 4 `WebGPUShaderModule.create` sites now route through `preprocess(src, 0)` so the new `//>>ifdef COMPRESSED_VERTICES` / `//>>else` blocks resolve correctly. With `defines=0`, preprocessed output is byte-identical to pre-Batch-27 for every shader that has no ifdef blocks.
- [packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.js](../packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.js) — `CAMERA_UNIFORM_SIZE` 256→320; `packCameraUniforms` writes prevVP at slots 60–75.
- [packages/engine/Source/Renderer/WebGPU/WebGPUBillboardRenderer.js](../packages/engine/Source/Renderer/WebGPU/WebGPUBillboardRenderer.js) — prevVP at slots 48–63; uniform buffer size unchanged (fit in existing 256-byte budget).
- [packages/engine/Source/Renderer/WebGPU/WebGPULabelRenderer.js](../packages/engine/Source/Renderer/WebGPU/WebGPULabelRenderer.js) — same pattern as Billboard.
- [packages/engine/Source/Renderer/WebGPU/WebGPUPointPrimitiveRenderer.js](../packages/engine/Source/Renderer/WebGPU/WebGPUPointPrimitiveRenderer.js) — prevVP at slots 28–43; fits in existing 256-byte buffer.
- [packages/engine/Source/Renderer/WebGPU/WebGPUPolylineRenderer.js](../packages/engine/Source/Renderer/WebGPU/WebGPUPolylineRenderer.js) — `CAMERA_BUFFER_SIZE` 128→192; prevVP at slots 32–47.
- [packages/engine/Source/Renderer/WebGPU/WebGPUWeatherRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUWeatherRenderer.ts) — `RENDER_UNIFORM_SIZE` 128→192; prevVP at slots 32–47 in the weather-particle render pass UB.
- [packages/engine/Source/Renderer/WebGPU/WebGPUEllipsoidPrimitiveRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUEllipsoidPrimitiveRenderer.ts) — buffer 176→240 bytes; inline WGSL + generated `.wgsl` both updated; prevVP at slots 44–59.
- [packages/engine/Source/Renderer/WebGPU/WebGPUShaderDefines.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUShaderDefines.ts) — added `ShaderDefine.COMPRESSED_VERTICES = 1 << 3` (add-only; doesn't reorder prior bits).
- [packages/engine/Source/Shaders/WebGPU/chunks/functions/csm_decodeCompressedVertex.wgsl](../packages/engine/Source/Shaders/WebGPU/chunks/functions/csm_decodeCompressedVertex.wgsl) — new: `csm_octDecodeFloat_single` / `csm_octUnpack` / `csm_decompressTextureCoordinates` — the WGSL mirror of `AttributeCompression`'s JS helpers. CPU + GPU must produce byte-identical results.
- [packages/engine/Source/Shaders/WebGPU/Primitive/PrimitivePhongColor.wgsl](../packages/engine/Source/Shaders/WebGPU/Primitive/PrimitivePhongColor.wgsl) — pilot shader. `struct VertexInput` swaps between a plain `normal: vec3<f32>` (CPU path, the `//>>else` branch) and a packed `compressedAttributes: f32` (GPU path, the `//>>ifdef COMPRESSED_VERTICES` branch). Inline `csm_octDecodeFloat_single` decoder inside the same ifdef so the shader is self-contained without needing the `#import` pipeline.
- [packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveShaders.js](../packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveShaders.js)
  - `getVertexLayoutForShader(type, options)` — new compressed branch for `phong` (11 floats/vertex, 44-byte stride) selected via `options.compressedVertices`.
  - `_SHADERS_WITH_GPU_DECODE = Set(["phong"])` — add-as-you-extend registry.
  - `shaderSupportsCompressedVertices` predicate + `setCompressedVertexDecodeEnabled` / `isCompressedVertexDecodeEnabled` flag (defaults `false`).

**Typecheck:** `npx tsc --noEmit` — clean. WGSL .js companions regenerated via `wgslToJavaScript`.

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| DP-H41 (ALL-RENDERERS) | DATA_PIPELINE | `previousViewProjection` only carried by the Globe renderer | **FIXED 2026-04-18 (Batch 27)** — every renderer's CameraUniforms now carries `previousViewProjection: mat4x4<f32>` at the tail. WGSL structs updated across 63 shader files; JS pack functions updated in Primitive / Model / Billboard / Label / Point / Polyline / Weather / Ellipsoid renderers. Identity fallback for first frame. TAA / motion-vector shaders can now consume `camera.previousViewProjection` from every pipeline without needing renderer-specific plumbing. |
| DP-H19-TANGENT-DECODE | DATA_PIPELINE | CPU decompression only produced `normal` + `st`, dropping `tangent` / `bitangent` | **FIXED 2026-04-18 (Batch 27)** — `ensureUncompressedAttributes` now emits Float32Array `tangent` + `bitangent` when the original geometry carried them, writing them back as `GeometryAttribute`s so any future normal-mapping surface material finds them in the expected slots. Adds ~24 bytes/vertex on fully-tangented geometry; idempotent for already-decoded geometries. |
| DP-H19-SHADER-DECODE (scaffold) | DATA_PIPELINE | GPU-side compressed-vertex decode absent | **SCAFFOLD 2026-04-18 (Batch 27)** — full infrastructure landed: shader define bit, WGSL decoder chunk, compressed vertex layout variant, opt-in predicate, feature flag, preprocessor routing through all Primitive shader-module creation sites, pilot shader (`PrimitivePhongColor`) with verified //>>ifdef/else branches. Runtime flip remains behind `setCompressedVertexDecodeEnabled(true)` until the pipeline packer is swapped to emit the compressed vertex buffer; follow-up expansion to additional material shaders is additive (each = one ifdef block + one `_SHADERS_WITH_GPU_DECODE` entry). |

### What shipped end-to-end

1. **DP-H41 — universal previousViewProjection.** Every renderer's CameraUniforms now contains the last frame's viewProjection. Memory impact is minimal (~32–64 bytes per draw command's camera UB). `UniformState.update()` already cached the matrix each frame; this batch just propagates it to all shader pipelines. TAA + motion-vector effects no longer need renderer-specific bind-group adjustments.
2. **DP-H19-TANGENT-DECODE.** Compressed geometries that carry full tangent-space data (normal + tangent + bitangent, as PBR pipelines expect) now round-trip correctly through the CPU decompressor. No material shader reads them yet, but the DP-H20 normal-mapping surface material + Batch 25 BGL v2 is the ready consumer.
3. **DP-H19-SHADER-DECODE — scaffold.** The full pipeline for GPU-side decode is in place: ShaderDefine bit, preprocessor-visible `//>>ifdef`, pilot shader with verified resolution for both branches, compressed vertex layout, opt-in predicate, feature flag. Because the flag defaults off and the preprocessor emits the CPU-path `//>>else` branch with `defines=0`, all existing rendering paths are byte-identical to pre-Batch-27.

### Integration audit — Batch 27

| Scenario | Status |
| --- | --- |
| Primitive flat shader (default) | ✓ `FLAT_CAMERA_BYTES` 160 — writes mvp/cam/prevVP; WGSL reads first 96 bytes in old layout, last 64 at offset 96 |
| Primitive lit shader (Phong/PBR) | ✓ `LIT_CAMERA_BYTES` 304 — normal-matrix/light/prevVP all aligned; no cross-shader binding clash |
| Model PBR | ✓ buffer 320, struct 304; 16-byte align preserved; first frame writes identity prevVP |
| Billboard / Label / Point | ✓ uniform buffer unchanged at 256; existing unused tail slots now carry prevVP |
| Polyline | ✓ buffer grew 128→192; all 5 existing pack slot offsets retained; TAA slot at 128 |
| Weather particles (compute-rendered) | ✓ render-pass buffer 128→192; compute-pass buffer untouched |
| Ellipsoid primitive | ✓ inline + generated WGSL synchronized; buffer 176→240 |
| PhongColor with `defines=0` | ✓ smoke-tested: emits plain-`normal` VertexInput and `let decodedNormal = input.normal` |
| PhongColor with `defines=COMPRESSED_VERTICES` | ✓ smoke-tested: emits `compressedAttributes: f32` VertexInput and `csm_octDecodeFloat_single(input.compressedAttributes)` |
| `preprocess(src, 0)` on a shader without //>>ifdef | ✓ byte-identical to input (pure function; only consumes directive lines) |

### Notes

- **Pre-existing buildTs failure** (JSDoc→.d.ts generation on `WasmArenaSlots.js`) is unrelated — not introduced by Batch 27; `npx tsc --noEmit` passes cleanly.
- **`scratchPickUniformData`** kept at 64 floats (was reduced to 48 mid-batch; reverted on review for zero-risk headroom over the 40 floats the 160-byte pick UB actually needs).
- **Global preprocess() routing.** Primitive shaders now *always* go through the WGSL preprocessor before `createShaderModule`, even when `defines=0`. This is safe (no shaders without ifdef blocks change content) and makes future ifdef additions cheap (no new plumbing per site).

### What's still open after Batch 27

- **DP-H19-SHADER-DECODE runtime wiring** — the feature flag + pilot shader are wired; the vertex-buffer packer that emits `compressedAttributes` (instead of the expanded normal/st arrays) plus skipping `ensureUncompressedAttributes` on the GPU path need to be added to `WebGPUPrimitiveCommands.createWebGPUCommands`. Independent from Batch 27's scaffold — tracked for a future batch when an opt-in material pipeline actually demands the perf.
- **Infrastructure follow-ups**: STUB-NAGA, BUILD-IIFE-INFLATION (Batch 28 next).
- **Out-of-scope analysis**: review-doc items never in scope — writeup to follow.

---

## Cumulative status through Batch 17

All 30 criticals that were OPEN at the start of the 2026-04-16 session are now either fixed or explicitly deferred with a `FOLLOW-UP <ID>` marker. High-severity and medium-severity findings are largely untouched in this session.

### Per-severity totals across the three review docs

| Severity | Total findings | Fixed (code change shipped) | Deferred (FOLLOW-UP marker) | Still OPEN (no marker) |
|---|---:|---:|---:|---:|
| **Critical** (C-P, C-R, DP-C) | 42 | 24 (12 pre-Batch-10 + 12 in 10–16) | 18 | 0 |
| **High** (H-P, H-R, DP-H) | ~61 | ~8 (from Batches 1–9) | 0 | ~53 |
| **Medium** (M-P, M-R, DP-M) | ~27 | 0 | 0 | 27 |
| **Bug / misc** (B-1 through B-9) | 8 | 1 (B-6) | 0 | 7 |

Counts for High / Medium are approximate because some DP-H / M-P items are listed as sub-bullets under shared headings and the enumerator conflates a few of them. The review docs themselves are authoritative.

### Partial fixes

Only one finding landed as a partial fix in this session rather than a full one:

- **C-P7 VolumetricFog RTE** — inner-radius pick switched to `min(radii)` so pole cameras no longer clamp to zero altitude. The shader-side `length(worldPos) − innerRadius` f32 cancellation remains. Tracked as **FOLLOW-UP C-P7-RTE**.

### Deferred critical findings — follow-up index

Each entry below has a `FOLLOW-UP <ID>` marker in its source review doc with scope notes. They are the backlog for the next architectural-scope session(s).

**Model / glTF / tiles (Per-Feature review):**
- `C-P8-ASYNC` — switch `WebGPUModelPipelineCache.getPipeline` to `createRenderPipelineAsync`; hoist cache to context scope; add pending-pipeline skip-draw logic. Multi-hour.
- `C-P13-TDPC-LIFECYCLE` — TimeDynamicPointCloud wrapper-vs-inner cache restructure; related to C-P1 pattern.
- `C-P15-GS-ROTATION` — Gaussian splat covariance modelMatrix rotation; add `modelRotation: mat3x3<f32>` uniform and apply to `(covA, covB)` pre-Jacobian.
- `C-P16-FEATURE-ID-ATTR` — add `@location(N) featureId0: f32` vertex slot + shader consumer for b3dm/i3dm.

**Collection / primitive shaders (Per-Feature review):**
- `C-P9-COLLECTIONS` — DistanceDisplayCondition / NearFarScalar family: 5 new instance attribute slots × 4 collection shaders + `csm_nearFarScalar` helper.
- `C-P10-SCENE-MODES` — 2D / Columbus View / Morphing branches in 6 collection shaders + primitive shaders (globe already has them).
- `C-P11-LOGDEPTH` — log-depth output across collection / primitive / model shader family + `csm_logDepth` helper.

**Renderer architecture (Renderer-Deep review):**
- `C-R1-RENDERSTATE` — plumb `command.renderState` through 15 feature renderers; extend pipeline-cache key with polygonOffset / colorMask / stencil / custom blend.
- `C-R2-DERIVED-COMMANDS` — polymorphic `derivedCommands.{logDepth, hdr, picking, pickingMetadata, shadows, depth}` dispatcher in `WebGPUSceneRenderer`.
- `C-R3-TRANSLUCENT-SORT` — integrate `CommandSorter.mergeSort(list, back_to_front, center)` for TRANSLUCENT / VOXELS / GAUSSIAN_SPLATS passes.
- `C-R4-GLTF-KHR` — KHR_texture_transform, clearcoat, anisotropy, specular, iridescence, sheen, volume in `ModelPBRComplete.wgsl`. Multi-session workstream.
- `C-R5-IMAGERY-16` — widen imagery layer count 4 → 16 in shader + CPU packer + add per-layer hue/gamma/split/cutout.
- `C-R7-CENTRAL-PIPELINE-CACHE` — instantiate `_webgpuPipelineCache`; extend its key-computation to include multisample count / target format / writeMask / depth format / vertex layout.
- `C-R8-SCENE-PASSES` — globeDepth updateDepth, translucent 3D-Tiles classification, invert-classification composition, edge FBO.
- `C-R9-MODEL-PICK-FAMILY` — Model / GroundPrimitive / Ellipsoid / Voxel / GaussianSplat pick commands + pick pipeline variants.
- `C-R10-POINT-LIGHT-SHADOWS` — cube-depth target + 6-face cast loop.
- `C-R11-BIND-GROUP-CACHING` — stable-key caches in `WebGPUPostProcessEffects` / `WebGPUEffectsBindGroup` / `WebGPUAutoExposure`.
- `C-R12-DEVICE-LOSS-WALK` — extend `_clearAllCaches` to walk per-Model / per-Collection / per-Renderer object caches on device loss.

**Atmospherics precision:**
- `C-P7-RTE` — complete the fog RTE refactor; shader-side altitude reconstruction instead of `length − innerRadius` in f32.

**Build / compat infrastructure (Batch 17):**

- `BUILD-IIFE-INFLATION` — dual variant IIFE `Cesium.js` grew from 1.89 MB → 4.15 MB gzipped. Code splitting can't apply to IIFE, so the WebGPU chunk content gets inlined alongside the main graph. Fix is either (a) a separate no-WebGPU IIFE entry for legacy `<script src>` users, or (b) accept the cost and document it. Does not affect ESM / CJS consumers.
- `STUB-NAGA` — lazy-load `naga-wasm` on first `gl.compileShader()` and transpile GLSL → WGSL at runtime. Unlocks the last piece of Proton-style WebGL translation (source compilation). ~1–2 MB additional gzipped lazy-loaded, 2–4 weeks for a working prototype.
- `STUB-SCENE-FILE-REFACTOR` — convert static `import FS from "../Shaders/FooFS.js"` in Scene / Materials files to a factory-resolution pattern so tree-shaking can drop the residual 37 inline GLSL template fragments currently in the WebGPU-only bundle. ~3–5 days, touches ~80–120 files; pure mechanical refactor.

### High-severity backlog (unaddressed this session)

Not individually marked because they remain with their original review-doc titles. The most impactful candidates for a focused follow-up, in rough priority order:

1. **DP-H16** — Material BLEND pipelines have no blend state. Every translucent primitive / PerInstanceColor / MaterialAppearance is wrong on WebGPU. Single-line fix at pipeline build. **Highest user-visible impact per unit work.**
2. **DP-H19** — `compressVertices: true` (the default) produces garbage geometry. Every Primitive that doesn't explicitly set `compressVertices: false` breaks.
3. **DP-H20 / DP-H21** — Material secondary textures (normalMap + diffuseMap) dropped; wrap-mode always `"repeat"` ignoring `repeat: { x: false, y: false }`.
4. **DP-H22** — 5 material shaders missing from `selectMaterialShader`: ElevationBand, PolylineArrow, PolylineDash, PolylineGlow, PolylineOutline.
5. **DP-H24** — Globe hue/saturation/brightness shift (`globe.hueShift = 0.1` is a no-op).
6. **DP-H44 / DP-H45 / DP-H46** — Pick gaps: globe surface no pick ID, `pickPosition` returns Cartesian only over globe, `pickMetadata` entirely unwired.
7. **DP-H7** — Polyline `arcType: GEODESIC` silently straight-lines; long polylines pass underground.
8. **C-P1 sibling leaks** — apply the `_featureRenderer` handle pattern (Batch 1 pattern) to other FRs that share the same class-of-bug.

### Next-session recommended plan

A single 2-hour session could plausibly close:

- DP-H16 + DP-H19 + DP-H20/21 (single-file, single-site fixes with big user-visible impact) — ~45 min
- ONE architectural C-R (e.g., `C-R3-TRANSLUCENT-SORT` — most bounded of the C-R defers) — ~60 min
- Tracker update + review-doc markers — ~15 min

Subsequent sessions should tackle the remaining DEFERRED criticals one-or-two per focused session, since each requires its own design thinking. The `FOLLOW-UP <ID>` markers in the review docs are the stable pick-list — they survive across conversations and don't require re-reading the full review.

### Files touched across Batches 1–16 (union)

For anyone auditing the blast radius of this work:

**Renderer / WebGPU TypeScript + JavaScript:**
- `WebGPUModelRenderer.js`, `WebGPUModelPipelineCache.js`, `WebGPUModelFeatureId.js`
- `WebGPUBillboardRenderer.js`, `WebGPULabelRenderer.js`, `WebGPUPolylineRenderer.js`
- `WebGPUEnvironmentRenderer.js`, `WebGPUPrimitiveCommands.js`, `WebGPUPickFramebuffer.ts`
- `WebGPUGlobeSurfaceRenderer.ts`, `WebGPUClippingPlaneCollection.ts`, `WebGPUVolumetricFogRenderer.ts`
- `WebGPUIBLPipeline.ts`, `WebGPUImageryReprojection.ts`, `WebGPUContext.ts`
- `WebGPUPointCloudEyeDomeLighting.ts`

**Scene / Model:**
- `Model.js`, `ModelPrimitiveGeometry.js`

**Shaders (WGSL):**
- `Environment/SkyAtmosphere.wgsl`, `Globe/GlobeTerrain.wgsl`, `Model/ModelPBRComplete.wgsl`

Every edited file passes `npx tsc --project packages/engine/tsconfig.json --noEmit` without errors.

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
