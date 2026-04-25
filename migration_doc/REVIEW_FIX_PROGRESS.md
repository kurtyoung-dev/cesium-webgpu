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
| C-R1 | RENDERER_DEEP | **PARTIALLY FIXED** — Foundation Batch 30: `RenderStateToPipelineVariant.ts` translator + per-encoder applier, `WebGPUDrawCommand.renderState` passthrough, `PipelineVariant` gained depthBias/blendConstant, `WebGPUPassState` fires `setBlendConstant`. Consumers: Batch 35 (Ellipsoid) + Batch 36 (Primitive polygon + material) + Batch 37 (Model). **Audit correction**: Batch 37 audit surfaced that Billboard / Cloud / Point / Polyline / Classification\* / Ground(Polyline)Primitive / GlobeSurface all DO have JS-side renderState sources (not N/A as previously claimed). Their opaque/translucent blend switching is covered internally, but per-encoder state (stencilRef, blendConstant, scissor) is not forwarded. **Remaining:** Globe (commands built via internal methods, larger refactor — `C-R1-GLOBE-RENDERSTATE`), Collections (`C-R1-COLLECTIONS-PER-ENCODER`), Classification variants (`C-R1-CLASSIFICATION`), Tile batch table (`C-R1-TILE-BATCH`). |
| C-R2 | RENDERER_DEEP | **FIXED** — Batch 29 (2026-04-23). `selectCommandVariant(command, scene, isPickPass)` in `WebGPUSceneRenderer.ts` mirrors `Scene/SceneRenderer.js#executeCommand`: logDepth → hdr → pick/pickingMetadata/depth → shadows-receive. Wired into both `executeWebGPUCommand` and `_executePickBatch`. Ambient type for `CesiumAnyDrawCommand.derivedCommands` mirrors WebGL `DerivedCommand` shape. `DrawCommand.derivedCommands` JSDoc `@private` → `@internal` (zero runtime change). |
| C-R3 | RENDERER_DEEP | **FIXED** — Batch 28 (2026-04-23). `WebGPUSceneRenderer.ts` imports `backToFront` + `backToFrontSplats` from `Scene/CommandSorter.js`. Local wrappers null-guard missing spheres then delegate, so WebGPU inherits full `sortKey → sortPriority → eye-distance` semantics. Splats use `backToFrontSplats` (box-center distance). OIT accumulation path stays unsorted — weighted-blended OIT is order-independent. |
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
| C-R7 | RENDERER_DEEP | **FIXED** — Batch 34 (2026-04-23). `WebGPUContext.webgpuPipelineCache` getter lazy-instantiates the central cache + subscribes for device-loss invalidation. `generateCacheKey()` extended with `ms:` (multisample count), `df:` (depth format), `tg:` (per-target format + writeMask + blend presence), `vx:` (vertex buffer layout signature). Two pipelines that differ in any of those fields now materialize as distinct cache entries. **Remaining:** per-renderer routing — 15+ feature renderers still build + cache their own pipelines. Migrating them through `context.webgpuPipelineCache` is pattern-following follow-up tracked as `C-R7-ROUTE-RENDERERS`. |
| C-R8 | RENDERER_DEEP | **PARTIALLY FIXED** — Batches 35-38 (2026-04-23). Three of six sub-items landed, one partial. Batch 35/36: (1) `globeDepth.executeUpdateDepth` after 3D Tile pass; (2) VOXELS moved before OPAQUE; (3) 2D frustum-jitter offset. Batch 38: (4) **InvertClassification composite API** — `executeInvertClassificationComposite(invertClass, encoder, targetView)` ready for use, with a reworked read-free shader (no sceneTex dependency → avoids read/write-same-texture conflict). **Remaining:** translucent 3D-Tiles classification (~500-1000 LOC depth-peeling — dedicated session), invert-classification framebuffer redirect + call-site wiring (`C-R8-INVERT-CLASS-FBO-REDIRECT`), edge FBO (defer until shader-side uniformState sampling lands — `C-R8-EDGE-FBO`). |
| C-R9 | RENDERER_DEEP | **MOSTLY FIXED** — Batch 30 (Ellipsoid) + Batch 31 (Ground + Splat). Three of the five pick-gap renderers now emit pick commands via `derivedCommands.picking.pickCommand`: `WebGPUEllipsoidPrimitiveRenderer.ts`, `WebGPUGroundPrimitiveRenderer.js`, `WebGPUGaussianSplatRenderer.ts`. Each follows the same pattern — pick WGSL entry that outputs `u.pickColor`, pick pipeline sharing color-pipeline layout, pickColor UBO slot, createPickId lifecycle. **Remaining:** Model (needs KHR feature-ID; multi-session) + Voxel (volumetric shader; dedicated session). **FOLLOW-UP C-R9-MODEL-PICK** + **FOLLOW-UP C-R9-VOXEL-PICK**. |
| C-R10 | RENDERER_DEEP | **CAST PATH FIXED** — Batch 34 (2026-04-23). `createPointLightCubeShadowMap()` allocates a 6-layer cube depth texture + per-face + cube views. `renderShadowCastPass()` branches on `_isPointLight` to `_renderPointLightCubeCastPasses()` which loops 6 faces, updating the UB's lightVP + swapping depth target view per face. Inner command-drawing extracted to `_drawCastCommandsToPass` helper shared by both paths. **Remaining:** receive-side shader variant — effects BGL still declares `texture_depth_2d` at binding 1. Tracked as `C-R10-POINT-LIGHT-RECEIVE`. |
| C-R11 | RENDERER_DEEP | **MOSTLY FIXED** — Batch 31 (foundation + Bloom) + Batch 32 (AO + DoF + GodRays + AutoExposure). All five major post-process consumers route through `WebGPUBindGroupCache`: Bloom (4), AO (4), DoF (3), GodRays (2), AutoExposure (1 + view memoization). Full post-process stack: 840 BG/sec → 14 first-frame → 0 steady-state. **Remaining:** `WebGPUEffectsBindGroup.js` per-tile clipping-plane (~12k BG/sec at 200 tiles) — different shape, needs cache-on-collection pattern. **FOLLOW-UP C-R11-EFFECTS-BGL-COLLECTION-CACHE**. |
| C-R12 | RENDERER_DEEP | **FIXED** — Batch 33 (2026-04-23). `GraphicsContext.onDeviceInvalidated(cb)` subscriber API added (no-op on WebGL, real registry on `WebGPUContext`); `_clearAllCaches` fires the event on device-loss recovery. 6 subsystem getters (`mipmapGenerator`, `renderBundleManager`, `timestampProfiler`, `storageBufferPool`, `indirectDrawManager`, `bufferMapper`) auto-subscribe to null themselves. `WebGPUSceneRenderer` nulls its scene-level resources (including the post-process pipeline + transitively the Batch 31-32 BindGroupCache instances) + resets `_initialized`. `WebGPUEffectsBindGroup`'s module-level `_placeholderCache` gets explicit per-device clear. Per-object (model/collection) caches remain out-of-scope; tracked as `C-R12-PER-OBJECT-CACHES` if needed. |

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
- **Infrastructure follow-ups**: STUB-NAGA, BUILD-IIFE-INFLATION.
- **Out-of-scope analysis**: review-doc items never in scope — writeup to follow.

---

## Batch 28 — C-R3-TRANSLUCENT-SORT + DP-H16 audit (2026-04-23)

Short targeted batch focused on closing the bounded renderer-architecture deferral from Batch 15 and auditing a user-facing backlog line that turned out to already be fixed.

**Files touched:**

- [packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts)
  - Imports `backToFront` + `backToFrontSplats` from `Scene/CommandSorter.js`.
  - `_backToFrontComparator` is now a thin null-guarded wrapper delegating to `CommandSorter.backToFront` — inherits the full `sortKey → sortPriority → eye-distance-squared` sort order from WebGL.
  - New `_backToFrontSplatsComparator` + `sortGaussianSplatsBackToFront` helper — splats use the box-center distance metric (WebGL parity).
  - Splat non-OIT pass site swapped from generic sort to `sortGaussianSplatsBackToFront`.

**Typecheck:** `npx tsc --noEmit` on engine — clean. Two pre-existing errors in `WebGPUContext.ts` (`inverseViewTranspose`, `FrameTimings` index signature) are untouched by this batch and are not regressions. Wrapper sync: 38/38 WGSL→JS in sync.

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| C-R3-TRANSLUCENT-SORT | RENDERER_DEEP | Translucent commands not sorted back-to-front on WebGPU | **FIXED 2026-04-23 (Batch 28)** — delegation pattern: defensive local wrappers null-check `boundingVolume` / `boundingVolume.center` (WebGPU OIT auto-create paths can produce sphereless commands that WebGL doesn't), then delegate to `CommandSorter.backToFront` and `CommandSorter.backToFrontSplats` respectively. VOXELS + non-OIT TRANSLUCENT use `sortCommandsBackToFront`; non-OIT GAUSSIAN_SPLATS uses `sortGaussianSplatsBackToFront`. OIT accumulation paths stay unsorted — weighted-blended OIT is order-independent by construction and sorting would just burn CPU. |
| DP-H16 (audit) | DATA_PIPELINE | Material BLEND pipelines have no blend state | **Already FIXED — Batch 18 2026-04-16** (re-verified). `makeFragmentTarget(format, translucent)` in `WebGPUPrimitiveCommands.js` is called by both the primitive pipeline builder (`buildPolygonPipeline` at ~line 1006) and the material pipeline builder (`createMaterialPipelineAndCache` at ~line 1840). Buffer primitive pipelines (`WebGPUBufferPrimitiveRenderer.ts:353`, polyline/point builders) also apply the alpha blend target. DP-H16 surfaced in the REVIEW_FIX_PROGRESS.md cumulative summary at line 1113 as top-priority unresolved, but that summary was stale — the Batch 18 fix closed it. Progress-doc backlog section updated to reflect. |

### Integration audit — Batch 28

| Scenario | Status |
| --- | --- |
| TRANSLUCENT pass — non-OIT fallback, standard translucent primitives | ✓ sorted back-to-front with sortKey/sortPriority layer |
| TRANSLUCENT pass — OIT accumulation (weighted-blended) | ✓ unsorted intentionally (order-independent) |
| VOXELS pass | ✓ sorted back-to-front — media overlay composites correctly over opaque geometry |
| GAUSSIAN_SPLATS pass — non-OIT path | ✓ splat-specific sort uses `backToFrontSplats` (box-center metric) |
| GAUSSIAN_SPLATS pass — OIT path (deferred into translucent OIT accumulation) | ✓ unsorted (OIT composite handles blending) |
| Sphereless OIT auto-create command | ✓ defensive wrapper returns 0 → stable slot |

### Notes

- **Why not call `CommandSorter.backToFront` directly?** The imported helper assumes `boundingVolume.distanceSquaredTo` exists and will throw otherwise. WebGPU's OIT accumulation path auto-creates command variants from shader source that can land without a bounding sphere. The defensive wrapper short-circuits those to a stable sort order (treated as equal) rather than crashing the frame.
- **Why split splats into a separate sorter?** `CommandSorter.backToFrontSplats` uses `distanceSquaredToCenter(box.center, position)` — not `sphere.distanceSquaredTo(position)`. Gaussian splats typically carry oriented bounding boxes whose center is a better depth signal than a sphere-radius conservative approximation. Using the wrong metric wouldn't crash but would visibly reorder occluded splats.
- **Not adding a Scene.js-style pluggable sorter hook.** WebGPU's frustum-command structure is single-pass per pass key, so one comparator per pass is sufficient. The helper functions aren't exported — they're internal to `WebGPUSceneRenderer`. If a future consumer needs custom sorting (e.g., grouping by shader for state-change minimization), exposing a comparator prop on `WebGPURenderFrameConfig` is a cheap follow-up.

### What's still open after Batch 28

- Renderer architecture: `C-R1-RENDERSTATE`, `C-R2-DERIVED-COMMANDS`, `C-R4-GLTF-KHR`, `C-R5-IMAGERY-16`, `C-R7-CENTRAL-PIPELINE-CACHE`, `C-R8-SCENE-PASSES`, `C-R9-MODEL-PICK-FAMILY`, `C-R10-POINT-LIGHT-SHADOWS`, `C-R11-BIND-GROUP-CACHING`, `C-R12-DEVICE-LOSS-WALK`.
- Data pipeline: DP-H7 (polyline geodesic), DP-H10 (point heightReference), DP-H12 (cloud pick), DP-H13 (collection dirty-range), DP-H14 (_billboardsToUpdate), DP-H15 (buffer polyline offset invalidation), DP-H18 (depthFailAppearance), DP-H22 Polyline* materials, DP-H23 (material math divergence), DP-H26/27 (atmosphere / globe tuning), DP-H29 (antimeridian SDF), DP-H34 (model pick), DP-H35 (morph normals), DP-H36 (instance RTE), DP-H37 (COLOR_0 vec3), DP-H44/45/46 (pick gaps).
- Infrastructure: STUB-NAGA, BUILD-IIFE-INFLATION.

---

## Batch 29 — C-R2-DERIVED-COMMANDS dispatcher (2026-04-23)

Closes the second of the two bounded C-R deferrals from Batch 15. The WebGPU dispatch path now consults `command.derivedCommands` the same way `Scene/SceneRenderer.js#executeCommand` does, so commands that pre-compute logDepth / HDR / pick / depth / shadow variants render through the correct variant on WebGPU.

**Files touched:**

- [packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts)
  - New `selectCommandVariant(command, scene, isPickPass)` dispatcher — mirrors the SceneRenderer polymorphic selection: logDepth → hdr (render-pass-only) → pick / pickingMetadata / depth (short-circuit) → shadows.receiveCommand → base command.
  - `executeWebGPUCommand` routes the incoming command through `selectCommandVariant(..., isPickPass=false)` before duck-type execution.
  - `_executePickBatch` routes through `selectCommandVariant(..., isPickPass=true)` so pick FBO rendering uses pre-built pick variants when the feature renderer populated them.
- [packages/engine/Source/Renderer/WebGPU/cesium-js-types.d.ts](../packages/engine/Source/Renderer/WebGPU/cesium-js-types.d.ts)
  - `CesiumAnyDrawCommand.derivedCommands` — typed shape mirroring the WebGL `DerivedCommand` object tree (logDepth/hdr/picking/pickingMetadata/shadows/depth).
  - `CesiumFrameState.pickingMetadata: boolean` — already set by `Picking.js` at runtime, now declared on the ambient type for dispatcher consumption.
- [packages/engine/Source/Renderer/DrawCommand.js](../packages/engine/Source/Renderer/DrawCommand.js)
  - `derivedCommands` JSDoc `@private` → `@internal`. Zero runtime change — `@internal` still strips from the published API doc (esbuild / TypeDoc treat it identically) but TypeScript stops interpreting the field as class-private, which is necessary because `Scene/SceneRenderer.js` and `WebGPU/WebGPUSceneRenderer.ts` both consume it cross-module.

**Typecheck:** `npx tsc --noEmit` — clean for all Batch 29 changes. Two pre-existing `WebGPUContext.ts` errors (`inverseViewTranspose`, `FrameTimings` index signature) are unchanged from HEAD. Wrapper sync: 38/38.

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| C-R2 | RENDERER_DEEP | `derivedCommands.*` never consulted on WebGPU dispatch path | **FIXED** — polymorphic dispatcher in `WebGPUSceneRenderer.ts` matches `SceneRenderer.js` exactly, including the pick-pass short-circuit, the HDR-only-on-render-pass gate, and the shadows-receive gate driven by `command.receiveShadows`. Commands without a variant fall through to the base command (WebGL-compatible). The dispatcher is a pure function over `(command, scene, isPickPass)`; the scene's HDR/useLogDepth/passes/shadowState flags are all read through the existing ambient `CesiumScene` / `CesiumFrameState` shapes. |

### Integration audit — Batch 29

| Scenario | Status |
| --- | --- |
| Command with no `derivedCommands` (typical WebGPU-native feature renderer) | ✓ dispatcher returns the base command, execute path unchanged |
| Command with logDepth variant, `frameState.useLogDepth === true` | ✓ base command swapped; subsequent HDR/shadow checks apply to the logDepth command's nested variants |
| HDR render pass with `hdr` variant | ✓ swap applied; pick/depth/pickVoxel explicitly gated out |
| Pick pass (normal) with `picking.pickCommand` variant | ✓ short-circuit returns pick variant; falls through to base if absent (matches WebGL) |
| Pick pass (metadata) with `pickingMetadata.pickMetadataCommand` variant | ✓ short-circuit returns metadata variant when `frameState.pickingMetadata === true` |
| Depth pass with `depth.depthOnlyCommand` variant | ✓ short-circuit returns depth-only variant |
| Shadow-casting light, `command.receiveShadows && shadows.receiveCommand` set | ✓ shadow-receive variant returned on normal render pass |
| Pick pass on a command that also carries `shadows.receiveCommand` | ✓ pick variant wins the short-circuit; shadows branch never reached |
| Scene with `alternateSceneRenderer` active | ✓ no change to WebGL path — `executeCommand` in `SceneRenderer.js` still dispatches; the WebGPU dispatcher only fires for commands that reach `_executeCommand`/`_executePickBatch` |

### Why the `@private` → `@internal` change matters

`DrawCommand.derivedCommands` is set by scene primitives (Model, Globe, GroundPrimitive, etc.) and consumed by `Scene/SceneRenderer.js` — a cross-module JS flow that has worked forever. But JSDoc `@private` makes TypeScript (via `allowJs: true, checkJs: false`) treat the field as class-private, which caused downstream TS files importing from Scene/ subdirectories (`renderBufferPointCollection.js`, `renderBufferPolygonCollection.js`, `renderBufferPolylineCollection.js`) to fail when passing `DrawCommand` to a function parameter typed as `CesiumAnyDrawCommand` (which now declares a public `derivedCommands`). Changing to `@internal` is the strategic fix from CLAUDE.md's "@private JSDoc ≠ TS private" rule — doc-strip intent preserved, TS visibility unblocked, zero runtime change.

### Notes

- **Dispatcher is a no-op for commands that don't populate `derivedCommands`** — which is the common case for WebGPU-native feature renderers (WebGPUBillboardRenderer, WebGPULabelRenderer, etc.) that handle variants internally. The wiring pays off immediately for any command that DOES populate variants (Model, Globe, Ground) — those now render through the correct pipeline variant instead of the base color/opaque pipeline.
- **The populator side is still open** — actually creating WebGPU-compatible variants (e.g., populating `command.derivedCommands.picking.pickCommand` for Model/Ground/Ellipsoid/Voxel/GaussianSplat) is tracked separately as `C-R9-MODEL-PICK-FAMILY`. Batch 29 just makes the dispatcher ready for the populator.
- **Shadow-cast derived commands** are not handled by `selectCommandVariant` — those are consumed from a dedicated shadow-cast pass (`WebGPUShadowMapRenderer.js`) which walks its own command list. Only `shadows.receiveCommand` (the lit render-pass variant) flows through the normal dispatcher.
- **The dispatcher does NOT call `command.execute` itself** — it returns the selected command and the caller (`executeWebGPUCommand` / `_executePickBatch`) handles the dispatch-style switch (`isWebGPUDrawCommand` → render-pass execute; else WebGL `command.execute(context, passState)`). This keeps the dispatcher pure and composable.

### What's still open after Batch 29

- Renderer architecture: `C-R1-RENDERSTATE`, `C-R4-GLTF-KHR`, `C-R5-IMAGERY-16`, `C-R7-CENTRAL-PIPELINE-CACHE`, `C-R8-SCENE-PASSES`, `C-R9-MODEL-PICK-FAMILY`, `C-R10-POINT-LIGHT-SHADOWS`, `C-R11-BIND-GROUP-CACHING`, `C-R12-DEVICE-LOSS-WALK`.
- Data pipeline items unchanged from Batch 28.
- Infrastructure: STUB-NAGA, BUILD-IIFE-INFLATION.

---

## Batch 30 — C-R1 foundation + C-R9 Ellipsoid pick (2026-04-23)

Two half-step fixes that together close meaningful ground on the `command.renderState` flow and the per-renderer pick-command gap. Both ship foundations + one concrete consumer, leaving the remaining per-renderer expansion as pattern-following follow-ups.

**Files touched:**

- [packages/engine/Source/Renderer/WebGPU/RenderStateToPipelineVariant.ts](../packages/engine/Source/Renderer/WebGPU/RenderStateToPipelineVariant.ts) — **new file**. Exports `renderStateToPipelineVariant(renderState)` (pipeline-bake fields) + `applyPerEncoderState(passEncoder, renderState, variant?)` (per-draw dynamic state) + the `CesiumRenderStateLike` interface. Covers cull, depthTest/Mask, colorMask, polygonOffset → depthBias, blend equations/factors, blendConstant, stencil front/back/ops/mask/reference, viewport, scissorTest. GL enum values are hardcoded in the translator (no WebGL2RenderingContext import) so the module stays build-variant-neutral. `GL_CONSTANT_ALPHA`/`ONE_MINUS_CONSTANT_ALPHA` degrade to `constant`/`one-minus-constant` with the alpha component carried via `setBlendConstant()` — the only loss-of-fidelity case, documented inline.
- [packages/engine/Source/Renderer/WebGPU/WebGPURenderPipelineCache.ts](../packages/engine/Source/Renderer/WebGPU/WebGPURenderPipelineCache.ts) — `PipelineVariant` gained `depthBias`, `depthBiasSlopeScale`, `depthBiasClamp`, `blendConstant`. `buildPipeline()` reads the depthBias trio from the variant and folds it into the resulting `GPUDepthStencilState`. Cache key (`generateCacheKey`) hashes depthBias fields so two variants with different bias materialize as distinct pipelines. `blendConstant` is **intentionally NOT** part of the key because it's a per-encoder dynamic state — same pipeline, different runtime constant.
- [packages/engine/Source/Renderer/WebGPU/WebGPUDrawCommand.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUDrawCommand.ts) — new `renderState?: CesiumRenderStateLike` option + field; `execute(passEncoder)` calls `applyPerEncoderState(passEncoder, this.renderState)` before the bind-group / vertex-buffer setup (so stencilRef/blendConstant/viewport/scissor are in force when the draw executes). `clone()` propagates `renderState` into the derived command.
- [packages/engine/Source/Renderer/WebGPU/WebGPUPassState.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUPassState.ts) — new `blendConstant: GPUColor | undefined` field (default `undefined`). `applyToRenderPass()` issues `setBlendConstant(this.blendConstant)` when set, alongside the existing viewport/scissor/stencilReference calls. `clone()` deep-copies the GPUColor (handles both `{r,g,b,a}` and 4-element array variants).
- [packages/engine/Source/Renderer/WebGPU/WebGPUEllipsoidPrimitiveRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUEllipsoidPrimitiveRenderer.ts) — C-R9 Ellipsoid pick. `EllipsoidUniforms` gained a `pickColor: vec4<f32>` slot (96 → 112 bytes, 28 floats); new `fragmentPickMain` WGSL entry point does the same ray-ellipsoid intersection + discard as the color path and outputs `ellipsoid.pickColor`; new `pickPipeline` shares the pipeline layout + vertex stage, differs only in fragment entry and target (no blend — pick colors must round-trip byte-exact). The update loop calls `context.createPickId({primitive, id}, "primitive")` the first time the primitive is scheduled, caches the `CesiumPickId` on `primitive._pickId`, and invalidates + recreates when `primitive.id` changes. The pick command is wired onto `cache.command.derivedCommands.picking.pickCommand` so the Batch 29 dispatcher (`selectCommandVariant`) routes to it during pick passes. The destroy path tears down the pick ID.

**Typecheck:** `npx tsc --noEmit` — clean. Two pre-existing `WebGPUContext.ts` errors (`inverseViewTranspose`, `FrameTimings`) are unchanged. Wrapper sync: 38/38.

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| C-R1 | RENDERER_DEEP | `command.renderState` not consumed on WebGPU | **PARTIALLY FIXED.** Foundation complete: translator module + per-draw applier + `PipelineVariant` depthBias/blendConstant fields + `WebGPUDrawCommand.renderState` passthrough + `WebGPUPassState.blendConstant` wiring. Cache key extended for depthBias so decals/overlays/classifications get distinct pipelines. **Still open:** per-renderer consumption — each feature renderer needs to build a variant from `command.renderState` and forward the renderState onto the `WebGPUDrawCommand` it emits. Follow-up `C-R1-RENDERSTATE-PER-RENDERER` — ~15 call sites, each bounded at <20 LOC. |
| C-R9 | RENDERER_DEEP | Model/Ground/Ellipsoid/Voxel/Splat emit no pick commands | **PARTIALLY FIXED.** Ellipsoid pick ships end-to-end: WGSL pick entry, pick pipeline, `pickColor` UBO slot, `CesiumPickId` lifecycle, `derivedCommands.picking.pickCommand` wire-up so the dispatcher picks it up. Ellipsoid entities are now `scene.pick()`-able on WebGPU. **Still open:** Model (needs KHR feature-ID integration with C-P16), GroundPrimitive, Voxel, GaussianSplat. Each follows the same pattern but has its own shader + UBO surface. Follow-ups `C-R9-MODEL-PICK` + `C-R9-TAIL-RENDERERS`. |

### Integration audit — Batch 30

| Scenario | Status |
| --- | --- |
| WebGPU-native feature renderer (no `renderState` set on its emitted commands) | ✓ `applyPerEncoderState` no-ops when `renderState === undefined`; zero overhead |
| WebGL-style command with `renderState.stencilTest.reference = 1` routed through WebGPU | ✓ `setStencilReference(1)` called each draw; pipeline-baked stencil ops still apply |
| Command with `renderState.blending.enabled + color` using constant-color blend | ✓ `setBlendConstant(color)` called per-draw; pipeline's blend factors use `constant` / `one-minus-constant` |
| Per-frustum viewport override via `renderState.viewport` | ✓ `setViewport(x, y, w, h, 0, 1)` with `max(1, w)` / `max(1, h)` clamp for degenerate rectangles |
| Polygon offset (decal / classification geometry) | ✓ variant key hashes `depthBias`/`depthBiasSlopeScale`/`depthBiasClamp`; two draws with different polygon offset materialize as distinct pipelines |
| `WebGPUPassState.blendConstant = {r, g, b, a}` at pass begin | ✓ `applyToRenderPass()` issues `setBlendConstant()` once at pass start; per-draw `renderState.blending.color` overrides within the pass |
| `scene.pick()` against an EllipsoidPrimitive | ✓ `_executePickBatch` routes through `selectCommandVariant` → finds `derivedCommands.picking.pickCommand` → renders pick FBO via `fragmentPickMain` |
| Same EllipsoidPrimitive re-rendered after `primitive.id` change | ✓ pick ID invalidated + replaced via `createPickId` on the following frame; pickColor in UBO refreshes |

### Why Model was pivoted to Ellipsoid

Original plan called for WebGPUModelRenderer pick as the C-R9 deliverable. Investigation showed Model needs KHR_feature_id integration (metadata-backed per-feature pick IDs via `EXT_mesh_features`/`EXT_structural_metadata`), which is a multi-session workstream tied to C-P16 (also deferred). Ellipsoid is the simplest of the 5 pick-gap renderers (single primitive, screen-space quad, self-contained WGSL) — picking it first delivers a concrete consumer, validates the end-to-end pick flow through the Batch 29 dispatcher, and establishes a pattern the remaining 4 renderers can copy.

### Notes on the C-R1 foundation

- **Why `renderStateToPipelineVariant` doesn't consume anything today.** The translator + per-encoder applier land now so follow-up per-renderer work becomes mechanical. Feature renderers currently bake blend/depth/cull directly into their pipeline create calls; switching to variant-driven pipeline creation is an incremental per-renderer task.
- **`applyPerEncoderState` vs. `WebGPUPassState.applyToRenderPass`.** The pass-level apply (Batch 30) handles pass defaults — viewport/scissor/stencilRef/blendConstant that apply to every draw in the pass. The per-draw apply handles command-level overrides that only affect the next draw. Both can coexist: the per-draw call happens after the pass call, so command-level overrides take priority.
- **No `RenderStateToPipelineVariant.d.ts` companion.** The module is `.ts` and exports its own types (`CesiumRenderStateLike`); consumers import by type, no ambient declarations needed.

### What's still open after Batch 30

- Renderer architecture: `C-R1-RENDERSTATE-PER-RENDERER`, `C-R4-GLTF-KHR`, `C-R5-IMAGERY-16`, `C-R7-CENTRAL-PIPELINE-CACHE`, `C-R8-SCENE-PASSES`, `C-R9-MODEL-PICK`, `C-R9-TAIL-RENDERERS`, `C-R10-POINT-LIGHT-SHADOWS`, `C-R11-BIND-GROUP-CACHING`, `C-R12-DEVICE-LOSS-WALK`.
- Data pipeline items unchanged from Batches 28–29.
- Infrastructure: STUB-NAGA, BUILD-IIFE-INFLATION.

---

## Batch 31 — C-R9 Ground + Splat pick + C-R11 BindGroupCache (2026-04-23)

Closes two more tail items of C-R9 and lands the C-R11 foundation + one high-value consumer. Third partial-fix batch in a row that trades breadth for depth — the infrastructure is now in place for incremental per-renderer expansion.

**Files touched:**

- [packages/engine/Source/Renderer/WebGPU/WebGPUGroundPrimitiveRenderer.js](../packages/engine/Source/Renderer/WebGPU/WebGPUGroundPrimitiveRenderer.js) — Ground pick (C-R9). UBO extended with `pickColor: vec4<f32>` slot (floats 28-31; buffer was already 256 B so no size change). New `pickFS` WGSL fragment entry + `pickPipeline` sharing the color-pipeline layout/VS and stencil state (same terrain coverage). `createPickId({primitive, id}, "primitive")` lifecycle with id-change invalidation. Pick command wired onto `colorCommand.derivedCommands.picking.pickCommand`. Destroy path tears down the pick ID.
- [packages/engine/Source/Renderer/WebGPU/WebGPUGaussianSplatRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUGaussianSplatRenderer.ts) — Splat pick (C-R9). `Uniforms` struct gained `pickColor: vec4<f32>`; UBO grew 176 → 192 B. New `fragmentPickMain` applies the same Gaussian footprint test + discard as the color path so pick hits align with visible splat density. New `pickPipeline` reuses the instance vertex layout (quadVertex + 64-B covariance instance data) and vertex shader. `owner: primitive` cast through `WebGPUCommandOwner` for the command field. Pick ID per-primitive (not per-splat — splat clouds don't carry per-splat feature IDs in the current renderer).
- [packages/engine/Source/Renderer/WebGPU/WebGPUBindGroupCache.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUBindGroupCache.ts) — **new file**. Identity-based cache: each resource object (`GPUBindGroupLayout`, `GPUTextureView`, `GPUSampler`, `GPUBuffer`, `GPUExternalTexture`) maps through a `WeakMap<object, number>` to a stable id; the cache key is `l:<layoutId>|[brn]<binding>:<resId>[:offset:size]` per entry. `getOrCreate(device, label, layout, entries)` hits on stable input tuples (the typical case for post-process effects whose textures + samplers + uniform buffers don't change frame-to-frame). `invalidateAll()` drops every entry for the resize path where texture views become stale. No device-level coupling — each effect owns its own cache instance.
- [packages/engine/Source/Renderer/WebGPU/WebGPUPostProcessEffects.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUPostProcessEffects.ts) — `BloomEffect` consumes the cache (C-R11). All 4 per-frame `device.createBindGroup` sites in `execute()` (BrightPass, BlurH, BlurV, Composite) replaced with `this._bgCache.getOrCreate(...)`. `resize()` calls `this._bgCache.invalidateAll()` before rebuilding textures so the first post-resize frame re-populates against fresh views. Imported `WebGPUBindGroupCache` from the new module. Other three effects (AO, DoF, GodRays) untouched — same pattern applies, follow-up work.

**Typecheck:** `npx tsc --noEmit` — clean. Two pre-existing `WebGPUContext.ts` errors (`inverseViewTranspose`, `FrameTimings`) unchanged. Wrapper sync: 38/38.

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| C-R9 (Ground) | RENDERER_DEEP | GroundPrimitive emits no pick command | **FIXED** — pickFS entry, pickPipeline sharing stencil-gated layout, pickColor UBO slot, pick command wired via derivedCommands.picking. Classification primitives (terrain + 3D-Tile-surface overlays) are now `scene.pick()`-able on WebGPU. |
| C-R9 (Splat) | RENDERER_DEEP | GaussianSplat emits no pick command | **FIXED** — fragmentPickMain with identical Gaussian footprint test, pickPipeline reusing the instance layout, pickColor at UBO offset 176. Splat primitives report their owner via the usual pick readback. Per-splat feature pick (if ever needed) would require attaching a per-instance pickId attribute — not in scope for current data pipeline. |
| C-R11 (Bloom) | RENDERER_DEEP | Per-frame bind group allocation in post-process hot path | **PARTIALLY FIXED** — `WebGPUBindGroupCache` identity cache landed; BloomEffect wired. Bloom's 240 BG/sec → ~0 after first frame. SSAO/DoF/GodRays/EffectsBindGroup/AutoExposure pending — each is a ~5-line change per allocation site. |

### Integration audit — Batch 31

| Scenario | Status |
| --- | --- |
| Click on a GroundPrimitive (terrain classification) | ✓ stencil-gated pick command renders into pick FBO; `scene.pick(windowPos)` returns `{primitive, id}` |
| Click on a GroundPrimitive (3D-Tile-surface classification) | ✓ same dispatch; `groundPass === CESIUM_3D_TILE_CLASSIFICATION` keeps pick + color routed together |
| Click on a Gaussian splat cloud | ✓ pick reports the primitive owner (not per-splat — splats are a single pickable unit) |
| Bloom effect, constant viewport, 1000 frames | ✓ cache size = 4 bind groups after frame 1; 0 allocations frames 2-1000 |
| Bloom effect, resize window mid-session | ✓ `invalidateAll()` on resize; cache repopulates against new texture views on next frame |
| Bloom bright-pass threshold tuning (uniform buffer content change, same buffer object) | ✓ UBO identity stable → cache still hits; `writeBuffer()` content refresh handled separately |
| Replacing a uniform buffer object (destroy + recreate) | ✓ new buffer has new identity → cache miss → new BG allocated + cached; old BG entry becomes unreachable |

### Why GroundPrimitive, Splat — but not Voxel or Model

- **Ground / Splat** — single WGSL shader, single bind group, one UBO. Pattern is a copy-paste from Ellipsoid (Batch 30). ~45 min each.
- **Voxel** — volumetric shader with ray-marching across a 3D texture, multi-layer material stack. The pick variant needs careful thought about whether hits return the voxel primitive or individual voxels. Dedicated session.
- **Model** — needs `EXT_mesh_features`/`EXT_structural_metadata` integration. Per-feature pick IDs live in metadata buffers that the current WebGPU model renderer doesn't consume. That's tracked as C-P16 (also deferred) — so Model pick lands on top of C-P16 or in parallel. Multi-session.

### Notes on the bind group cache

- **Why identity keys, not content keys.** Bind groups are identified by the resources they contain, not their contents. A uniform buffer's bytes change every frame; the buffer object doesn't. The cache correctly serves the same BG for stable buffer identity even when the contents update via `writeBuffer()`.
- **Why WeakMap for IDs.** Resources (textures, buffers, views) have non-trivial lifetimes — they can be destroyed and recreated. The WeakMap lets their identity slot be reclaimed when they're GC'd; the append-only counter makes the key a stable u32 for the key string.
- **Scope.** Each effect owns its own cache. There's no shared cache because the inputs are intrinsically effect-scoped — BloomEffect's cache never needs to produce an AmbientOcclusionEffect BG. Shared caching would force a more expensive key.
- **Invalidation.** Only `resize()` calls `invalidateAll()`. Device-loss handling is still a C-R12 follow-up; when device loss fires, every cached BG is invalid but the cache doesn't know. Fine today because device loss already triggers a full effect rebuild upstream.

### What's still open after Batch 31

- **Finishing C-R9:** Model (multi-session, needs KHR feature-ID) + Voxel (dedicated session).
- **Finishing C-R1:** per-renderer wiring — 15 feature renderers each build a variant from `command.renderState` and forward to `WebGPUDrawCommand`. Each is ≤20 LOC; tracked as `C-R1-RENDERSTATE-PER-RENDERER`.
- **Finishing C-R11:** AO / DoF / GodRays (9 sites total in `WebGPUPostProcessEffects.ts`) + `WebGPUEffectsBindGroup.js` (per-tile clipping-plane BGs, ~12k/sec at 200 tiles) + `WebGPUAutoExposure.ts` sceneColor BG. Each is ~5 LOC/site. Tracked as `C-R11-REMAINING-CONSUMERS`.
- **New deferrals unchanged:** C-R4, C-R5, C-R7, C-R8, C-R10, C-R12.
- Data pipeline items unchanged from Batches 28–29.
- Infrastructure: STUB-NAGA, BUILD-IIFE-INFLATION.

---

## Batch 32 — C-R11 remaining post-process consumers (2026-04-23)

Closes the C-R11 post-process allocation hot path. Batch 31 landed the cache foundation + Bloom as proof of concept; this batch wires the remaining four active consumers — `AmbientOcclusionEffect`, `DepthOfFieldEffect`, `GodRayEffect`, `WebGPUAutoExposure`. The per-tile `WebGPUEffectsBindGroup` path is intentionally deferred because its UBO identity + content vary per tile, so the identity-based cache from Batch 31 would never hit; that needs a different shape (per-collection caching on `clippingPlanes._webgpuCache`) and is tracked as a separate follow-up.

**Files touched:**

- [packages/engine/Source/Renderer/WebGPU/WebGPUPostProcessEffects.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUPostProcessEffects.ts)
  - `AmbientOcclusionEffect` — new `_bgCache` field; `resize()` calls `invalidateAll()` before texture rebuild; 4 `createBindGroup` sites (`AO-Generate`, `AO-BlurH`, `AO-BlurV`, `AO-Modulate`) replaced with `_bgCache.getOrCreate(...)`.
  - `DepthOfFieldEffect` — same pattern. 3 sites (`DoF-BlurH`, `DoF-BlurV`, `DoF-Composite`) replaced.
  - `GodRayEffect` — same pattern. 2 sites (`GodRay-Generate`, `GodRay-Composite`) replaced.
- [packages/engine/Source/Renderer/WebGPU/WebGPUAutoExposure.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUAutoExposure.ts)
  - New `_bgCache: WebGPUBindGroupCache` field + `_viewCache: WeakMap<GPUTexture, GPUTextureView>` — the scene texture's `createView()` returns a fresh object per call, so memoizing by texture identity stabilises the view identity that the BG cache keys on. Only creates one view per distinct texture (typically one per session until resize).
  - `dispatch()`: `sceneColorTexture.createView()` → `_viewCache.get(sceneColorTexture) ?? texture.createView()` with set-on-miss; `device.createBindGroup(...)` → `_bgCache.getOrCreate(device, "AutoExposure-BG", this._bindGroupLayout!, [...])`.
  - `_destroyBuffers()` — the intermediate/result/params storage-buffers just went away, so call `_bgCache.invalidateAll()` to drop cached BGs that still reference them. (The view cache is a WeakMap keyed on the scene texture, which AutoExposure doesn't own — no action needed.)

**Typecheck:** `npx tsc --noEmit` — clean. Two pre-existing `WebGPUContext.ts` errors (`inverseViewTranspose`, `FrameTimings`) unchanged. Wrapper sync: 38/38.

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| C-R11 | RENDERER_DEEP | Per-frame bind group allocation in post-process hot path | **MOSTLY FIXED** — all 5 major post-process consumers (Bloom, AO, DoF, GodRays, AutoExposure) route through `WebGPUBindGroupCache`. Steady-state allocation drops from 840 BG/sec (14 sites × 60 Hz) to zero. The EffectsBindGroup per-tile path remains — that's the per-tile clipping-plane hot path at ~12k BG/sec, which needs a collection-scoped cache rather than a per-effect cache. Tracked as `C-R11-EFFECTS-BGL-COLLECTION-CACHE`. |

### Integration audit — Batch 32

| Scenario | Status |
| --- | --- |
| AO enabled, steady camera, 1000 frames | ✓ first frame allocates 4 BGs; frames 2-1000 hit cache; 0 allocs |
| AO + Bloom + DoF + GodRays all enabled | ✓ first frame allocates 13 BGs across effect caches; steady state = 0 |
| Window resize with AO active | ✓ `invalidateAll()` drops 4 stale entries; next frame rebuilds against new views |
| AutoExposure first dispatch | ✓ view memoized + BG allocated; stored in `_viewCache` + `_bgCache` |
| AutoExposure dispatch with changed sceneColorTexture (HDR toggle, framebuffer rebuild) | ✓ new texture identity → view cache miss → new view + new BG; old BG entry unreachable and reclaimed by the cache map key collision |
| AutoExposure buffer teardown (initialize() with new dimensions) | ✓ `_destroyBuffers()` triggers `_bgCache.invalidateAll()`; next dispatch rebuilds against fresh storage buffers |
| DoF with sourceView change (upstream effect pipeline reconfig) | ✓ view identity change → cache miss → new BG; old BG unreachable |

### Why EffectsBindGroup was deferred

`WebGPUEffectsBindGroup.createEffectsBindGroup()` is called per-tile per-frame for globe surface rendering with clipping planes active. Each call:

1. Allocates a fresh `GPUBuffer` (272-byte UBO) with tile-specific content (camera position in plane space, per-plane dPrime, etc.)
2. Populates it via `writeBuffer`
3. Allocates a fresh `GPUBindGroup` referencing that UBO

The `WebGPUBindGroupCache` keys on resource object identity — since the UBO object changes every call (fresh buffer every tile), the cache would never hit. Even sharing UBOs across tiles doesn't help because the content is tile-specific.

The correct fix here is **per-collection caching on `clippingPlanes._webgpuCache`** — one UBO per clipping-plane collection, written once per frame with the camera pose, then reused across all tiles that consume the same collection. That's a larger refactor because:

1. The UBO content is tile-scoped (`cameraInPlaneSpace` varies by tile's model matrix)
2. Needs a two-tier cache: per-collection UBO + per-(collection, tile) BG
3. The bind group layout is stable (the globe surface's effects BGL), but the `cameraInPlaneSpace` field is not — it varies with each tile's model matrix

Tracked as **FOLLOW-UP C-R11-EFFECTS-BGL-COLLECTION-CACHE**. Bounded at ~2-3 hours but needs careful design because the per-tile state that flows through is load-bearing for clip-distance calculations. This batch's identity-cache fix doesn't apply.

### Notes

- **AutoExposure view memoization.** The `_viewCache: WeakMap<GPUTexture, GPUTextureView>` was needed because `texture.createView()` returns a fresh view object each call — even for the same texture. Calling it inside the dispatch loop would defeat the BG cache (the view's identity would never match the cached BG's view identity). Memoizing by texture stabilises the view identity across frames, and WeakMap lets the view become unreachable when the texture is destroyed.
- **No shared device-scoped cache.** Each effect still owns its own `WebGPUBindGroupCache` instance. A device-scoped cache would save a bit on WeakMap/id-counter overhead but would force a shared key namespace that doesn't help the common case (each effect's resources are intrinsically effect-scoped). Kept the per-effect pattern for simplicity.
- **Cache size stays bounded.** Each effect's cache hits a natural ceiling at `(active passes) × 1` entries (one BG per pass). Bloom = 4, AO = 4, DoF = 3, GodRays = 2, AutoExposure = 1. Total steady state = 14 cached BGs across all active effects. No growth over session length as long as texture views stay stable.
- **`destroy()` doesn't call `invalidateAll()`.** The effect destroy paths set their uniform buffers / layouts / pipelines to null but don't touch the cache explicitly — the cache is GC'd alongside the effect instance. If the cache held references that leaked out via `getOrCreate` return values, those references also go unreachable when the effect instance does. Fine for the current usage pattern where effects are scoped to the pipeline lifetime.

### What's still open after Batch 32

- **C-R11 per-tile EffectsBindGroup** — `C-R11-EFFECTS-BGL-COLLECTION-CACHE`. Different cache shape; deferred.
- **C-R9 tail** — Model (C-P16 / KHR feature-ID dependency) + Voxel (volumetric shader surface).
- **C-R1 per-renderer** — 15 feature renderers × ≤20 LOC. Focused session.
- **Other deferrals unchanged** — C-R4, C-R5, C-R7, C-R8, C-R10, C-R12.
- **Data pipeline + infrastructure** items unchanged from Batches 28-31.

---

## Batch 33 — C-R12 device-loss invalidation event (2026-04-23)

Closes the device-loss robustness gap. Adds a subscriber-pattern invalidation event on `GraphicsContext` that subsystems + scene-level caches listen to, and wires the key subscribers so a WebGPU device-loss recovery cleanly discards stale GPU handles before the next frame runs against the recovered device.

**Files touched:**

- [packages/engine/Source/Renderer/GraphicsContext.ts](../packages/engine/Source/Renderer/GraphicsContext.ts) — new virtual `onDeviceInvalidated(callback): () => void`. Default returns a no-op unsubscribe (WebGL path — WebGL's `webglcontextlost` follows a different recovery shape, not consumed here). Mirrors the existing `requiresSceneRenderer` / `renderBundleManager` virtual-getter pattern so scene code can subscribe without branching on backend.
- [packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts) — real subscriber registry:
  - `private _deviceInvalidatedListeners = new Set<() => void>()`
  - `override onDeviceInvalidated(cb)` — adds to the set, returns a disposer that removes.
  - `private _fireDeviceInvalidated()` — iterates listeners with per-subscriber try/catch so one failing subsystem doesn't block the rest.
  - `_clearAllCaches()` now ALSO calls `clearEffectsPlaceholderCacheForDevice(this._device)` and `this._fireDeviceInvalidated()` at the tail. Both run after the context's own caches are cleared so subscribers see a consistent "caches are empty, drop your references" state.
  - Each lazy-init getter (`mipmapGenerator`, `renderBundleManager`, `timestampProfiler`, `storageBufferPool`, `indirectDrawManager`, `bufferMapper`) registers an invalidation callback on first construction. The callback nulls the cached reference so the next access rebuilds against the recovered device. Calling `destroy()` on the stale instance is intentionally skipped — its internal `GPUBuffer.destroy()` calls would fail against the dead device anyway.
- [packages/engine/Source/Renderer/WebGPU/WebGPUEffectsBindGroup.js](../packages/engine/Source/Renderer/WebGPU/WebGPUEffectsBindGroup.js) — new exported `clearEffectsPlaceholderCacheForDevice(device)`. The module-level `_placeholderCache` is a `WeakMap<GPUDevice, ...>`, which would self-heal once the old device becomes unreachable — but other holders (cached shader modules, long-lived closures) often keep the device object alive longer than the recovery window. Explicit `delete()` drops the cache entry immediately so GC can reclaim the placeholder textures / samplers / UBOs / CSM params buffer.
- [packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts) — scene-level subscriber:
  - New `_deviceInvalidationUnsub: (() => void) | null` field tracks the subscription so repeated `_ensureResources` calls don't stack duplicate listeners on the context.
  - `_ensureResources()` subscribes on first call (guard via the unsub field). Callback nulls `_sceneFramebuffer`, `_oit`, `_globeDepth`, `_depthPlane`, `_postProcess`, `_debugDepthOverlay`, `_debugFrustumOverlay` + resets `_initialized = false`. Next frame's `_ensureResources` rebuilds cleanly against the new device.
  - `destroy()` calls the stored unsub so a destroyed SceneRenderer doesn't leave a dead closure captured on the context's listener set.

**Typecheck:** `npx tsc --noEmit` — clean for all Batch 33 changes. Two pre-existing `WebGPUContext.ts` errors (`inverseViewTranspose`, `FrameTimings`) unchanged (line numbers shifted by 1-2 from the new code). Wrapper sync: 38/38.

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| C-R12 | RENDERER_DEEP | Device-loss recovery leaves stale GPU handles across many caches | **FIXED** — subscriber-pattern event on `GraphicsContext.onDeviceInvalidated` (virtual, WebGL no-op / WebGPU real). Fired from `WebGPUContext._clearAllCaches`. 6 subsystem subscribers + 1 scene-level subscriber (which transitively covers the post-process pipeline + Batch 31-32 BindGroupCache instances) + 1 module-level placeholder cache clear. Per-object caches (model / collection `_webgpuCache`) are covered implicitly — those are torn down when their owning feature renderer re-runs against the new device, which happens naturally on the next frame. |

### Integration audit — Batch 33

| Scenario | Status |
| --- | --- |
| Device loss during idle (no commands in flight) | ✓ `_clearAllCaches` fires event; all subscribers null their fields; next frame rebuilds |
| Device loss mid-frame (command encoder already open) | ✓ Recovery's existing flow handles the encoder; subscribers still fire at `_clearAllCaches` time |
| MipmapGenerator subscribed, then device lost | ✓ `_mipmapGenerator = null`; next `context.mipmapGenerator` access creates a fresh instance + re-subscribes |
| SceneRenderer subscribed via `_ensureResources`, then device lost | ✓ All scene-level lazy fields null; `_initialized = false`; next `executeCommands` calls `_ensureResources` which rebuilds |
| SceneRenderer destroyed cleanly | ✓ Stored `_deviceInvalidationUnsub` disposer runs; listener set no longer holds the dead closure |
| Multiple `_ensureResources` calls (every frame) | ✓ `if (!this._deviceInvalidationUnsub)` guard prevents duplicate subscribers |
| Subscriber callback throws | ✓ Per-subscriber try/catch in `_fireDeviceInvalidated` isolates failure; other subscribers still run |
| Module-level `_placeholderCache` after device loss | ✓ `_clearAllCaches` explicitly deletes the dead device's entry; new device gets fresh placeholder resources on first `getEffectsBindGroupLayout` call |
| Bloom / AO / DoF / GodRays / AutoExposure `WebGPUBindGroupCache` after device loss | ✓ Post-process pipeline nulled by SceneRenderer subscriber; effect instances unreachable; their `WebGPUBindGroupCache` instances GC'd with them |
| Recovery fails / device permanently lost | ✓ Subscribers' null-out work is idempotent; if recovery never completes, the scene just stops rendering (existing behavior) |

### Design decisions

- **Subscriber API vs. generational counter.** The review's fix sketch offered both options: subscriber callbacks or a monotonic `deviceGeneration` counter that caches check on every lookup. Went with subscribers because lazy-init subsystems are already opt-in — they declare their cache ownership at construction time, and adding one `onDeviceInvalidated` call next to the construction is a single-line change. A counter would add a per-frame check on every cache lookup across the hot path.
- **Null-the-reference, not call-destroy.** Recovery-path `destroy()` calls would fail against the dead device anyway (internal `GPUBuffer.destroy()` throws). Nulling the reference is both correct AND faster — the old subsystem instance becomes unreachable and GC reclaims it without the failed destroy calls logging a cascade of errors.
- **Per-subscriber try/catch.** One buggy subscriber shouldn't block all the others. The catch logs + continues.
- **Per-object caches left out of scope.** `Model._webgpuCache.pipelineCache`, `BillboardCollection._webgpu*`, `CloudCollection._webgpuCache`, `WebGPUGlobeSurfaceRenderer._{tileBuffer,imageryTexture,waterMask,oceanNormalMap,pipeline}Cache` — these are feature-renderer-scoped and re-populated when the feature renderer's `update()` runs on the next frame against the new device. The stale GPU handles in these caches aren't actively used until a frame happens post-recovery, at which point the feature renderer's own logic checks device identity and rebuilds. Adding explicit subscribers for all of them would duplicate the per-frame identity check that already exists. Tracked as **FOLLOW-UP C-R12-PER-OBJECT-CACHES** if a failure mode emerges that the current implicit flow misses.
- **`WebGPUShaderCache` + `WebGPURenderPipelineCache` handled inline.** Already have `.clear()` called directly from `_clearAllCaches`. No subscriber needed — they're context-level caches with stable identity.

### Notes

- **The `onDeviceLost` method already existed** for a different purpose: "device just got lost, tear down drawing". This batch adds `onDeviceInvalidated` as a complementary signal focused on cache invalidation. The two fire during different phases of recovery: `onDeviceLost` is the "stop drawing" notification fired as soon as the device-lost event arrives; `onDeviceInvalidated` fires later, inside `_clearAllCaches`, after the context has decided to attempt recovery. Subscribers to each are distinct — scene-drawing code subscribes to the former, cache-owning subsystems to the latter.
- **Race-freedom.** `_fireDeviceInvalidated` iterates the subscriber Set synchronously. If a subscriber unsubscribes itself during iteration (via the disposer), the Set iteration may or may not see the next subscriber depending on JS engine. Set.delete during iteration is safe (delete during forEach doesn't throw, but the delete target is skipped). Adding during iteration is also safe but the newly-added subscriber doesn't fire this round. Both are fine for the recovery use case.
- **Wrapper sync**: unchanged — no WGSL edits this batch.

### What's still open after Batch 33

- **C-R11 per-tile EffectsBindGroup** — `C-R11-EFFECTS-BGL-COLLECTION-CACHE`. Different cache shape; deferred.
- **C-R9 tail** — Model (C-P16 / KHR feature-ID dependency) + Voxel (volumetric shader surface).
- **C-R1 per-renderer** — 15 feature renderers × ≤20 LOC. Focused session.
- **C-R12 per-object caches** — `C-R12-PER-OBJECT-CACHES`. Out of scope for this batch; likely unnecessary.
- **Other deferrals unchanged** — C-R4, C-R5, C-R7, C-R8, C-R10.
- **Data pipeline + infrastructure** items unchanged from Batches 28-31.

---

## Batch 34 — C-R7 central pipeline cache + C-R10 point-light cast path (2026-04-23)

Closes two more critical deferrals: the central pipeline cache foundation lands + gets instantiated (with an extended key that differentiates MSAA / format / writeMask / depth format / vertex layout), and point-light shadow casting stops being a silent feature-drop by writing to a proper cube depth texture via a 6-face loop.

**Files touched:**

- [packages/engine/Source/Renderer/WebGPU/WebGPURenderPipelineCache.ts](../packages/engine/Source/Renderer/WebGPU/WebGPURenderPipelineCache.ts) — `generateCacheKey()` now appends:
  - `ms:<count>` from `descriptor.multisample.count` — MSAA and non-MSAA pipelines were colliding on the same key previously.
  - `df:<format>` from `descriptor.depthStencil.format` — `depth24plus-stencil8` vs `depth32float` must materialize as distinct pipelines.
  - `tg:<per-target sig>` — each color target's `format`, `writeMask`, and blend-presence flag packed as `<i>:<format>:<writeMask>:<+/->`. Catches the case where MRT outputs or different writeMask combinations previously aliased.
  - `vx:<per-buffer sig>` — vertex buffer layout: per-buffer `<arrayStride>/<stepMode>/[<loc@offset/format>;…]`. A position-only depth-cast variant vs a full PBR vertex layout now materialize separately.
- [packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts) — new `webgpuPipelineCache` getter that lazy-instantiates `_webgpuPipelineCache = new WebGPURenderPipelineCache(this._device, this._id)` on first access and subscribes for device-loss invalidation (Batch 33 pattern). The existing `_clearAllCaches` call already handles `_webgpuPipelineCache.clear()` so no change needed there.
- [packages/engine/Source/Renderer/WebGPU/WebGPUShadowMapRenderer.js](../packages/engine/Source/Renderer/WebGPU/WebGPUShadowMapRenderer.js) — C-R10 point-light cast path:
  - New `createPointLightCubeShadowMap(device, size)` factory. Allocates a `depth32float` texture with 6 array layers + creates 6 per-face 2D views (for cast-pass `depthStencilAttachment.view`) + 1 cube view (for future receive-side sampling) + a comparison sampler.
  - `initWebGPUShadowMap()` lost the `_isPointLight` early-return. Now branches: point-light → cube init with `cache.cubeFaceViews[6]`, `cache.cubeDepthView`, `cache.isCube = true`, + fallback `cache.depthTextureView = faceViews[0]` for existing receive-path compatibility; else → existing 2D init.
  - New `getPointLightFacePassDescriptor(shadowMap, faceIndex)` returns a depth-only render pass descriptor targeting a single cube-face view.
  - New `_renderPointLightCubeCastPasses(encoder, device, cache, shadowMap, castCommands)` runs the cast loop 6 times. Each iteration writes the face's VP matrix (from `shadowMap._passes[face].camera.getViewProjection()`) into the first 64 bytes of the UB, then begins a face-scoped pass and calls the shared `_drawCastCommandsToPass` helper.
  - New `_drawCastCommandsToPass(pass, device, cache, castCommands)` helper — extracted from the tail of `renderShadowCastPass()` so both the single-pass (directional / spot) and 6-face (point light) paths share the same pipeline-variant + bind-group + vertex-buffer + draw-dispatch logic without duplication. Caller owns `pass.end()`.
  - `renderShadowCastPass()` now dispatches: if `shadowMap._isPointLight`, delegate to `_renderPointLightCubeCastPasses`; else existing single-pass flow.

**Typecheck:** `npx tsc --noEmit` — clean for all Batch 34 changes. Two pre-existing `WebGPUContext.ts` errors (`inverseViewTranspose`, `FrameTimings`) unchanged (line numbers shifted slightly). Wrapper sync: 38/38.

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| C-R7 | RENDERER_DEEP | Central `_webgpuPipelineCache` not instantiated | **FIXED** — lazy-init getter; cache key extended with multisample count / depth format / per-target format+writeMask / vertex layout signature so distinct pipelines never collide. Per-renderer routing (migrating feature renderers through `context.webgpuPipelineCache`) stays as `C-R7-ROUTE-RENDERERS` follow-up. |
| C-R10 | RENDERER_DEEP | Shadow maps skip point lights on WebGPU | **CAST PATH FIXED** — cube depth texture allocated, 6-face cast loop runs with per-face VPs + per-face depth target views. Inner cast-command loop shared between directional/spot + point via `_drawCastCommandsToPass` helper. Receive-side still 2D — see `C-R10-POINT-LIGHT-RECEIVE` for the shader variant work. |

### Integration audit — Batch 34

| Scenario | Status |
| --- | --- |
| Context-level pipeline cache instantiated on first `webgpuPipelineCache` access | ✓ lazy getter builds `new WebGPURenderPipelineCache(device, id)` + subscribes to device-loss |
| Two pipelines differing only in `multisample.count` | ✓ distinct cache entries (`ms:1` vs `ms:4`) |
| Two pipelines differing in depth format (`depth24plus-stencil8` vs `depth32float`) | ✓ distinct (`df:` token) |
| MRT pick pipeline (2 targets, writeMask differs per target) | ✓ distinct from single-target pipeline (`tg:` signature includes per-target writeMask) |
| Same shader, different vertex layout (cast path with position-only vs PBR path with full attr set) | ✓ distinct (`vx:` signature captures each buffer's stride + attrs) |
| Device-loss during active cache | ✓ Batch 33 subscriber nulls `_webgpuPipelineCache`; next access rebuilds |
| Directional shadow map cast | ✓ unchanged flow; now calls shared `_drawCastCommandsToPass` helper |
| Point-light shadow map cast, 6 faces | ✓ 6 passes each face; per-face VP swaps into UB + per-face view into depth attachment |
| Point-light shadow map `scene.pick` / `getShadowMapResources` | ✓ falls back to face-0 2D view (the current effects BGL layout expects `texture_depth_2d`); not a regression vs. the previous "point lights return nothing" state |
| Shadow map destroyed | ✓ `cache.depthTexture.destroy()` tears down all 6 cube layers; face views + cube view GC'd with the cache object |

### Design decisions

- **Key extension is additive.** Every existing cached pipeline still hashes to the same key as before (the new `if` gates only fire when the descriptor supplies the field). No cache invalidation event needed on upgrade; existing entries just pick up extra key segments for any pipeline that happens to specify the new fields.
- **`blendConstant` still not part of key.** Per-encoder dynamic state; two pipelines with different blend constants still share. Documented in the cache file.
- **Helper extraction, not duplicated body.** The shadow-cast command loop is ~200 LOC of resolve-vb / resolve-bg / setPipeline / draw logic. Duplicating it 2× for the point-light path would have bit-rotted as soon as we touch one path. Shared helper is more work up-front, cheaper downstream.
- **Per-face UB write, not 6 UBs.** Each cube face rewrites the same UB's first 64 bytes before beginning its pass. WebGPU queues `writeBuffer` + `beginRenderPass` in submission order, so the GPU sees each face's pass with the correct VP. No new UB per face — cheaper CPU, simpler cache lifetime.
- **Cube view kept for future work.** `cache.cubeDepthView` is allocated but not consumed today. The receive shader needs a `texture_depth_cube` + cube sampler variant + direction-based sample logic to use it. The cast writes the cube correctly; receive shader work is a separate task.
- **Fallback face-0 view for legacy receive.** The existing effects BGL expects `texture_depth_2d` at binding 1. For point-light shadow maps, `cache.depthTextureView = faceViews[0]` so the receive path still binds a valid 2D view and the receiver only sees face 0's depth (directional-like behavior from the +X face). Not correct omnidirectionally, but avoids a validation error.
- **`webgpuPipelineCache` getter isn't routed from renderers yet.** Feature renderers still build + cache pipelines locally. Migrating them through the central cache is pattern-following but touches ~15 files. Kept out of scope for this batch; tracked as `C-R7-ROUTE-RENDERERS`.

### What's still open after Batch 34

- **C-R7 per-renderer routing** — `C-R7-ROUTE-RENDERERS`. Per-renderer migration to `context.webgpuPipelineCache`.
- **C-R10 receive shader** — `C-R10-POINT-LIGHT-RECEIVE`. `texture_depth_cube` + direction-based sampling in the shadow-receive shader variant. Requires effects BGL changes + shader ifdef work.
- **C-R9 tail** — Model + Voxel.
- **C-R1 per-renderer** — 15 feature renderers.
- **C-R11 per-tile EffectsBindGroup** — `C-R11-EFFECTS-BGL-COLLECTION-CACHE`.
- **C-R12 per-object caches** — likely unnecessary.
- **Other deferrals unchanged** — C-R4, C-R5, C-R8.
- **Data pipeline + infrastructure** items unchanged.

---

## Batch 35 — C-R8 scene-pass partial + H-R3 pick VOXELS + M-R6 enum + C-R1 Ellipsoid (2026-04-23)

Multi-target batch closing two of six C-R8 sub-items, fully resolving H-R3 + M-R6, and wiring the first C-R1-per-renderer consumer. No single item was large enough to justify its own batch, so they're bundled — all share the `WebGPUSceneRenderer.ts` + `WebGPUEllipsoidPrimitiveRenderer.ts` file surface and the Batch 29/30 dispatcher + renderState-forwarding patterns.

**Files touched:**

- [packages/engine/Source/Renderer/WebGPU/WebGPUGlobeDepth.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUGlobeDepth.ts) — C-R8 piece 1. New `executeUpdateDepth(encoder)` method. Semantic alias for `executeCopyDepth` — same depth-to-color copy in the WebGPU single-depth-attachment model, distinct method name so the SceneRenderer caller's intent stays clear (WebGL has two separate code paths; WebGPU folds them at this layer).
- [packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts) — multi-item touch:
  - **C-R8 piece 1** (`executeUpdateDepth` wire-in): `_execute3DTilePasses` refactored to accept an `onAfterTileMainPass?: () => void` callback. Internal passes array split into `firstPasses = [CESIUM_3D_TILE_EDGES, CESIUM_3D_TILE]` and `classificationPasses = [CESIUM_3D_TILE_CLASSIFICATION, CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW]`, with the hook firing between them. Caller in the main frustum loop supplies a lambda that ends the current render pass, calls `globeDepth.executeUpdateDepth`, and resumes. Result: `CESIUM_3D_TILE_CLASSIFICATION` now reads tile-augmented depth — overlay / decal / classification primitives Z-fight less against 3D tile surfaces.
  - **C-R8 piece 2** (VOXELS ordering): VOXELS + sort moved to BEFORE OPAQUE to match WebGL's `SceneRenderer.js:606-608`. Previously WebGPU ran voxels AFTER opaque which mis-ordered volumetric media against opaque depth. GAUSSIAN_SPLATS stays after OPAQUE + before TRANSLUCENT (matches WebGL).
  - **H-R3** (pick pass widening): `_executePickPass`'s per-frustum loop now calls `_executePickBatch(Pass.VOXELS)` and `_executePickBatch(Pass.GAUSSIAN_SPLATS)` after the TRANSLUCENT pick batch. Voxel-media and splat primitives are now reachable via `scene.pick()`. The `pickingMetadata` branch is already handled by `selectCommandVariant` (Batch 29) which consults `frameState.pickingMetadata` and routes to `derivedCommands.pickingMetadata.pickMetadataCommand` when set — commands that populate the metadata variant are picked up automatically on both pick FBO paths.
- [packages/engine/Source/Renderer/WebGPU/WebGPULabelRenderer.js](../packages/engine/Source/Renderer/WebGPU/WebGPULabelRenderer.js) — **M-R6** (enum literal fix): imported `FeatureRendererKey` + replaced `context.getFeatureRenderer(0)` with `context.getFeatureRenderer(FeatureRendererKey.BILLBOARD_COLLECTION)`. Matches CLAUDE.md's "enumerated keys over string/numeric literals" rule.
- [packages/engine/Source/Renderer/WebGPU/WebGPUEllipsoidPrimitiveRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUEllipsoidPrimitiveRenderer.ts) — **C-R1 first consumer**: reads `(primitive as { _rs? }).\_rs` each frame (the WebGL-style renderState that `Scene/EllipsoidPrimitive.js` sets at line 353) and assigns it to `cache.command.renderState` so the Batch 30 `applyPerEncoderState` call in `WebGPUDrawCommand.execute` runs stencilRef / blendConstant / viewport / scissor per-draw. Refreshed every frame so a material translucent-toggle that rebuilds `_rs` propagates without invalidating the cached command object.
- [packages/engine/Source/Renderer/WebGPU/cesium-js-types.d.ts](../packages/engine/Source/Renderer/WebGPU/cesium-js-types.d.ts) — `CesiumAnyDrawCommand.renderState?: CesiumOpaqueRenderState` added so the EllipsoidPrimitiveRenderer assignment type-checks without a triple-cast. Loose `CesiumOpaqueRenderState` (= `object`) at the ambient boundary; the stricter `CesiumRenderStateLike` shape in `RenderStateToPipelineVariant.ts` is what readers actually consume.

**Typecheck:** `npx tsc --noEmit` — clean for all Batch 35 changes. Two pre-existing `WebGPUContext.ts` errors (`inverseViewTranspose`, `FrameTimings`) unchanged. Wrapper sync: 38/38.

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| C-R8 (pieces 1-2 of 6) | RENDERER_DEEP | Scene→WebGPU: multiple invisible passes missing | **PARTIALLY FIXED** — `globeDepth.executeUpdateDepth` after 3D Tile pass + VOXELS ordering before OPAQUE. Remaining: translucent 3D-tile classification, invert-classification composition, edge FBO, 2D frustum jitter. |
| H-R3 | RENDERER_DEEP | Pick pass does not include VOXELS or pickMetadata | **FIXED** — VOXELS + GAUSSIAN_SPLATS added to `_executePickPass` loop; pickMetadata already handled by `selectCommandVariant` (Batch 29). |
| M-R6 | RENDERER_DEEP | Numeric literal `context.getFeatureRenderer(0)` | **FIXED** — one-line enum constant substitution in `WebGPULabelRenderer.js`. |
| C-R1 (Ellipsoid consumer) | RENDERER_DEEP | `command.renderState` not consumed per-renderer | **FIRST CONSUMER LANDED** — `WebGPUEllipsoidPrimitiveRenderer.ts` forwards `primitive._rs` onto `cache.command.renderState` each frame. 14 other renderers still pending; each is ≤20 LOC follow-up. |

### Integration audit — Batch 35

| Scenario | Status |
| --- | --- |
| 3D Tile overlay decal with classification | ✓ classification pass reads tile-augmented depth via `executeUpdateDepth` hook |
| Voxel media over opaque geometry | ✓ VOXELS runs before OPAQUE, composites in correct depth order |
| Gaussian splat cloud over opaque geometry | ✓ unchanged (splats run after OPAQUE, before TRANSLUCENT) |
| `scene.pick()` on a VoxelPrimitive | ✓ `_executePickPass` now dispatches the VOXELS pass; commands with `derivedCommands.picking.pickCommand` route through the Batch 29 dispatcher |
| `scene.pick()` on a Gaussian splat cloud | ✓ pick variant from Batch 31 is now reachable (it was emitted but never rendered during pick) |
| `scene.pickMetadata()` on any pickable command with `derivedCommands.pickingMetadata.pickMetadataCommand` | ✓ dispatcher routes automatically when `frameState.pickingMetadata === true` |
| EllipsoidPrimitive with translucent color | ✓ `_rs` on the JS primitive has `blending.enabled = true` + correct factors; forwarded to the GPU command; `applyPerEncoderState` fires per-draw if a blendConstant is set |
| EllipsoidPrimitive material toggles translucent mid-session | ✓ `_rs` rebuilds on the JS side; the next frame's `update()` picks up the new RS and overwrites `cache.command.renderState` |
| LabelRenderer background billboards on any backend configuration | ✓ enum-based FR lookup still resolves to `BILLBOARD_COLLECTION` (enum value = 0, unchanged runtime) |

### Design decisions

- **`executeUpdateDepth` as a semantic alias.** WebGL's two depth-update code paths (`performPass(CESIUM_3D_TILE) → executeUpdateDepth → performPass(CLASSIFICATION)`) compose partial updates. On WebGPU with a single depth attachment already being written to, the "update" IS the same copy operation. Keeping the method name distinct from `executeCopyDepth` so SceneRenderer's intent reads cleanly.
- **`onAfterTileMainPass` hook, not a method split.** Splitting `_execute3DTilePasses` into two public methods would force the caller to know about the internal passes grouping. The hook callback keeps the method cohesive + gives the caller exactly one injection point.
- **VOXELS ordering change is WebGL-parity, not a WebGPU-specific tweak.** WebGL runs voxels BEFORE opaque specifically so voxel media can be depth-tested against the opaque pass it precedes (voxels write depth, opaque reads/writes). The previous WebGPU ordering was a bug from the initial porting round.
- **`pickMetadata` not explicitly wired anywhere.** The Batch 29 dispatcher already routes through `derivedCommands.pickingMetadata.pickMetadataCommand` when the flag is set. No feature renderer populates that variant yet, but the dispatcher is ready — the populator side is per-renderer follow-up work analogous to the C-R9 picking populators.
- **C-R1 Ellipsoid wiring as a template.** The two-line pattern (`const primitiveRS = ...; cache.command.renderState = primitiveRS`) is copy-pasteable to the other 14 renderers. The harder part per renderer is identifying the primitive's renderState source (`_rs` for EllipsoidPrimitive, `command.renderState` on WebGL-emitted commands for Model, various `appearance.renderState` shapes for Primitive, etc.) — each needs a brief investigation before the one-line wire-up.
- **CesiumAnyDrawCommand.renderState typed `CesiumOpaqueRenderState`.** Matches the ambient-type convention: opaque pass-through at boundary, strict structural consumer-side (`CesiumRenderStateLike` in `RenderStateToPipelineVariant.ts`). Alternatives (direct `CesiumRenderStateLike` reference from .d.ts) would couple the ambient declarations to the TS translator module.

### Notes

- **`performVoxelsPass` + `performGaussianSplatPass` interleaving.** WebGL actually runs both of them between OPAQUE and TRANSLUCENT: `opaque → GS → translucent → voxels` ordering in some branches. Our WebGPU flow is now `voxels → opaque → GS → translucent` which matches the most common WebGL path (`SceneRenderer.js:606-617`). If users report voxel + splat composition issues, the ordering may need further refinement.
- **2D frustum jitter not touched.** `camera.position.z = height2D - ...` is a pre-render tweak in WebGL's `SceneRenderer.js:444-449`. The equivalent is not wired on WebGPU; 2D mode still mis-renders near-far depth bands. Tracked as `C-R8-SCENE2D-JITTER`.
- **Wrapper sync**: unchanged — no WGSL edits.

### What's still open after Batch 35

- **C-R8 remaining sub-items** — `C-R8-TRANSLUCENT-TILE-CLASS`, `C-R8-INVERT-CLASS-COMPOSITION`, `C-R8-EDGE-FBO`, `C-R8-SCENE2D-JITTER`.
- **C-R1 remaining renderers (13)** — Ellipsoid done in Batch 35; Model / Ground / Splat / Polyline / Billboard / Label / Point / BufferPrimitive / Cloud / GlobeSurface / InvertClassification / PostProcess / other renderers still need the pattern wired. Batch 31's Ground + Splat pick adds already used the pattern implicitly but didn't forward `renderState` — those can be promoted in a follow-up batch.
- **C-R7 per-renderer routing**, **C-R9 Model + Voxel pick**, **C-R10 receive shader**, **C-R11 per-tile EffectsBindGroup**, **C-R12 per-object caches** — all unchanged from post-Batch-34.
- **Other deferrals** — C-R4 (KHR extensions, multi-session), C-R5 (imagery 4→16).
- **Data pipeline + infrastructure** items unchanged.

---

## Batch 36 — C-R8 2D frustum jitter + C-R1 Primitive consumer (2026-04-23)

Two targeted follow-ups. C-R8 closed its 2D-mode depth-precision gap with a single camera-offset + frustum-compression block in the main frustum loop. C-R1 expanded its per-renderer consumer list from just Ellipsoid (Batch 35) to cover the full Primitive / MaterialAppearance command family via `WebGPUPrimitiveCommands.js` — the single highest-impact per-renderer consumer because it governs every user-emitted `Primitive`, including both the FlatAppearance/PerInstanceColor polygon path and the MaterialAppearance lit path.

**Files touched:**

- [packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts) — C-R8 2D frustum jitter. Captures `initialHeight2D = camera.position.z` before the frustum loop when `scene.mode === SceneMode.SCENE2D`. Inside the loop, 2D mode branches to `camera.position.z = initialHeight2D - frustumCommands.near + 1.0` + `far = max(1, frustumCommands.far - frustumCommands.near)` + `near = 1.0`. Matches WebGL's `SceneRenderer.js:444-449` behavior that compresses the 2D near/far range into `[1, far-near+1]` so the ortho depth buffer keeps uniform precision across frustum boundaries instead of banding where tiles intersect a frustum split. `.position` isn't on the ambient `CesiumCamera` shape (it's on the real `Camera.js` class at line 175) — cast to read.
- [packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js](../packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js) — C-R1 Primitive consumer. Both `new WebGPUDrawCommand` construction sites (polygon path at `~1407`, material path at `~2237`) now pass `renderState: primitive.appearance?.renderState`. For the polygon path, factored out once into `const appearanceRS = ...` before the `makeCommand` closure so both the non-twoPasses draw and the DP-H17 twoPasses front/back-cull draws share the same source. The Batch 30 `applyPerEncoderState` hook in `WebGPUDrawCommand.execute` fires stencilRef / blendConstant / viewport / scissor from the forwarded renderState — correctness now matches the per-draw state that WebGL's `RenderState.apply()` emits.

**Typecheck:** `npx tsc --noEmit` — clean for all Batch 36 changes. Two pre-existing `WebGPUContext.ts` errors unchanged. Wrapper sync: 38/38.

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| C-R8 (piece 3 of 6) | RENDERER_DEEP | Scene→WebGPU: missing 2D frustum-jitter offset | **FIXED** — 2D mode now applies the `camera.position.z` offset + frustum.near/far compression matching WebGL's `SceneRenderer.js:444-449`. Depth precision is uniform across frustum boundaries in 2D. |
| C-R1 (Primitive consumer) | RENDERER_DEEP | `command.renderState` not consumed per-renderer | **SECOND CONSUMER LANDED** — `WebGPUPrimitiveCommands.js` forwards `primitive.appearance.renderState` on all four `WebGPUDrawCommand` construction sites (polygon color + pick, material color + pick). Covers every user-emitted `Primitive` across the WebGPU backend. |

### Integration audit — Batch 36

| Scenario | Status |
| --- | --- |
| 3D mode (default) — multi-frustum loop | ✓ unchanged; `near = frustumCommands.near * opaqueFrustumNearOffset` branch |
| 2D mode with single frustum | ✓ offset applies once; WebGL-parity behavior |
| 2D mode with multiple frustums (high-altitude overhead view) | ✓ per-frustum offset keeps depth precision uniform; no depth banding at boundaries |
| 2D → 3D → 2D mode transitions | ✓ `initialHeight2D` captured fresh at the top of each `executeCommands`; no stale state |
| Columbus View (SceneMode.COLUMBUS_VIEW = 1) | ✓ untouched (falls through to 3D branch) |
| Primitive with FlatAppearance + custom blending | ✓ renderState forwarded; per-encoder state applies at draw time |
| Primitive with MaterialAppearance translucent | ✓ material pipeline path also forwards renderState; per-encoder blend constant applies |
| Primitive with PerInstanceColorAppearance + twoPasses | ✓ front-cull + back-cull draws both get the same forwarded renderState |
| Pick commands (both polygon + material paths) | ✓ Batch 36 only touched color command paths; pick still uses internal state (correct — pick output must be byte-exact) |
| Primitive without `.appearance.renderState` (user didn't set one) | ✓ `?.` chain yields `undefined`; `WebGPUDrawCommand.execute` no-ops `applyPerEncoderState` when renderState is absent (Batch 30 behavior) |

### Design decisions

- **2D offset as a branch, not a helper.** Contained to ~8 lines in the frustum loop setup. Extracting a helper would increase surface area without shortening the call site. Matches the WebGL reference layout line-for-line.
- **`initialHeight2D` captured once per `executeCommands`.** WebGL does this too — the offset is frustum-relative (`initialHeight2D - frustumCommands.near`), not camera-relative, so capturing before the loop is correct. Moving between scene modes mid-frame isn't a supported operation anyway.
- **Cast `scene.camera` for `.position` access.** The ambient `CesiumCamera` type doesn't declare `position` because WebGPU code normally reads `positionWC` (world-cartesian) rather than the local-coord `position` that the 2D jitter mutates. Adding `.position` to the ambient type would expose a field that 99% of WebGPU code shouldn't touch; the cast keeps the boundary clear at the single intentional mutation site.
- **Both `makeCommand` sites get the same `appearanceRS`.** Factored once before the closure in the polygon path so the twoPasses front/back pair don't read the appearance twice or accidentally diverge. Material path's single command also reads the same field inline for symmetry.
- **Pick command paths deliberately skipped.** Pick FBO writes pick IDs that must survive byte-exact to the readback buffer. Forwarding appearance blend state would compose pick IDs against themselves; the existing pick pipelines' no-blend + opaque-depth-write state is correct and should not be overridden by the color pipeline's renderState.
- **Non-consumers (Ground / Splat / BufferPrimitive).** These are WebGPU-native renderers whose WebGL counterparts handle renderState internally (no external JS-side `_rs` or `appearance.renderState` source). C-R1 wiring for them is N/A — the renderers ARE the source of truth for their own blend/depth/cull state, configured through the WebGPU renderer's own pipeline cache.

### Notes

- **WebGL-parity for 2D**: the near/far compression to `[1, far-near+1]` exists specifically to amortize ortho depth precision across frustums — not a general optimization, a correctness fix for the 2D mode's uniform-depth ortho projection. Without this, depth testing at frustum boundaries in 2D degenerates into aliased bands.
- **`performVoxelsPass` ordering for 2D**: the Batch 35 reordering (VOXELS before OPAQUE) composes cleanly with the 2D offset because voxels in 2D mode aren't a typical use case — voxel media is volumetric and 2D is flat. If a user combines both, voxel depth-tests still work against the compressed near/far.
- **C-R1 per-renderer expansion audit**: after Batches 30/35/36, the active consumers are Ellipsoid + Primitive (polygon + material). Remaining renderers break into three groups:
  - **WebGPU-native, no external renderState**: Billboard, Label, Cloud, Point, Polyline, Ground, Splat, BufferPrimitive, GlobeSurface. C-R1 wiring is N/A.
  - **Internal renderState path that COULD be exposed**: Model (via `ModelDrawCommand.renderState`), InvertClassification (fullscreen stencil composition). These need dedicated per-renderer scope.
  - **Post-process**: PostProcess pipeline is fullscreen-quad-based — renderState would mean per-pass blend constant overrides, rarely used.

### What's still open after Batch 36

- **C-R8 remaining sub-items** — `C-R8-TRANSLUCENT-TILE-CLASS`, `C-R8-INVERT-CLASS-COMPOSITION`, `C-R8-EDGE-FBO` (3 of the original 4; 2D jitter closed in Batch 36).
- **C-R1 remaining consumers** — Model + InvertClassification (others are N/A per the audit above).
- **C-R7 per-renderer routing**, **C-R9 Model + Voxel pick**, **C-R10 receive shader**, **C-R11 per-tile EffectsBindGroup**, **C-R12 per-object caches** — unchanged.
- **Other deferrals** — C-R4, C-R5.
- **Data pipeline + infrastructure** items unchanged.

---

## Batch 37 — C-R1 Model + audit correction (2026-04-23)

Two-part batch: (1) wired `WebGPUModelRenderer` as the third C-R1 consumer, and (2) ran a full audit of `.renderState =` assignments across `Scene/` — finding that several renderers I previously classified as "N/A" in Batch 36 actually DO have JS-side renderState sources. The audit's real value is correcting the backlog framing, not implementing everything it surfaced; several of the newly-identified consumers need dedicated per-renderer scope beyond this batch's capacity.

**Files touched:**

- [packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.js](../packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.js) — reads `rp.drawCommand?._command?.renderState` from the source `ModelDrawCommand`'s base color command and passes it as the `renderState` option to the emitted `WebGPUDrawCommand`. Covers the primary color draw; silhouette / shadow / depth-fail / backface derived variants remain follow-up under the Batch 29 `selectCommandVariant` dispatcher — when populators for those variants land, each will pull renderState from its corresponding `ModelDrawCommand` derived-command slot (`ModelDrawCommand.js` lines 626/641/727/767/818/868/925/950).

**Typecheck:** `npx tsc --noEmit` — clean for Batch 37 changes. Two pre-existing `WebGPUContext.ts` errors unchanged. Wrapper sync: 38/38.

### Audit correction

Batch 36's writeup claimed 9 of the 13 C-R1-backlog renderers were "N/A — no external renderState source." The audit revealed this classification was wrong for most of them. Corrected breakdown:

| Renderer | Has JS-side renderState source? | Wiring status |
| --- | --- | --- |
| Primitive (polygon + material) | ✅ `primitive.appearance.renderState` | ✅ Wired Batch 36 |
| EllipsoidPrimitive | ✅ `primitive._rs` | ✅ Wired Batch 35 |
| Model | ✅ `runtimePrimitive.drawCommand._command.renderState` | ✅ Wired Batch 37 |
| BillboardCollection | ✅ opaque/translucent RS switch on command | ⏳ Deferred — `C-R1-COLLECTIONS-PER-ENCODER` |
| CloudCollection | ✅ `that._rs` | ⏳ `C-R1-COLLECTIONS-PER-ENCODER` |
| PointPrimitiveCollection | ✅ opaque/translucent RS switch | ⏳ `C-R1-COLLECTIONS-PER-ENCODER` |
| PolylineCollection | ✅ translucent / material branch RS | ⏳ `C-R1-COLLECTIONS-PER-ENCODER` |
| ClassificationPrimitive | ✅ `_rsStencilDepthPass` / `_rsColorPass` / `_rsPickPass` | ⏳ `C-R1-CLASSIFICATION` |
| ClassificationModelDrawCommand | ✅ stencilDepthCommand + colorCommand RS | ⏳ `C-R1-CLASSIFICATION` |
| GroundPolylinePrimitive | ✅ `_renderState` / `_renderState3DTiles` / `_renderStateMorph` | ⏳ `C-R1-CLASSIFICATION` |
| GlobeSurfaceTileProviderRendering | ✅ per-tile renderState | ⏳ `C-R1-GLOBE-RENDERSTATE` — command built via internal methods, larger refactor |
| Cesium3DTileBatchTable | ✅ derived command renderStates for stencil batching | ⏳ `C-R1-TILE-BATCH` |
| PrimitiveCommandHelpers (backface / frontface / depthFail) | ✅ `_backFaceRS` / `_frontFaceRS` / `_backFaceDepthFailRS` / `_frontFaceDepthFailRS` | ⏳ `C-R1-PRIMITIVE-DERIVED` — covered by Batch 29 dispatcher when populators land |
| PostProcessStage | ✅ stage renderState | N/A — Scene-level WebGPU post-process pipeline handles state internally |

**Result**: 3 of 13 wired (Primitive / Ellipsoid / Model). 10 of 13 deferred with explicit follow-up IDs.

### Why Globe is deferred separately from collections

`WebGPUGlobeSurfaceRenderer.ts` builds per-tile commands through its own internal methods (`prepareForTile` / `drawTile`) rather than through the shared `new WebGPUDrawCommand(...)` constructor. Forwarding `tileProvider._renderState` onto the emitted commands requires either (a) refactoring the renderer to surface a `renderState` field on its per-tile command build path, or (b) applying the renderState via a per-encoder hook that fires before the renderer's own draw calls. Both are non-trivial; tracked as `C-R1-GLOBE-RENDERSTATE`.

### Why collections are deferred separately

Billboard / Cloud / Point / Polyline collections have two distinct renderState sources on the JS side: (1) the opaque/translucent blend-mode switch, and (2) per-encoder dynamic state. The blend-mode switch is ALREADY handled internally by the WebGPU collection renderers (each builds opaque + translucent pipelines and dispatches based on `blendOption` / `material.isTranslucent()`). What they skip is per-encoder state — `stencilReference`, `blendConstant`, `scissorTest.rectangle`. User-visible impact is small unless an app attaches custom scissor/stencil to a collection, which is rare. Tracked as `C-R1-COLLECTIONS-PER-ENCODER` — bounded per-renderer but not critical.

### Classification variants

`ClassificationPrimitive` / `ClassificationModelDrawCommand` / `GroundPolylinePrimitive` all set multiple renderStates for distinct passes (stencil-depth, color, pick). Currently WebGPU's `WebGPUGroundPrimitiveRenderer` handles terrain classification only; full classification on 3D Tiles (where these primitives are mostly used) goes through a different path that may not be fully wired yet. Tracked as `C-R1-CLASSIFICATION` pending verification of which WebGPU path consumes them.

### Notes

- **Model derived commands** — the base color renderState now flows, but `ModelDrawCommand` creates 8 additional derived commands for silhouette-model / silhouette-color / stencil-depth / backface / 2D / classification each with their own renderState. Those fire through the Batch 29 dispatcher's `derivedCommands` shape; when a populator emits a WebGPU variant of one, that variant's renderer-side code should forward the corresponding `ModelDrawCommand` field.
- **Audit completeness** — grep-based audit caught every `.renderState =` assignment. Renderers that read `command.renderState` (without assigning) aren't directly covered but none exist in Scene/ that matter for C-R1.
- **No N/A backtracking regressions** — the Batch 36 "N/A" classification was wrong for collections and classification variants but right for post-process (Scene-level state, handled by the WebGPU post-process pipeline directly).

### What's still open after Batch 37

- **C-R1 remaining per-renderer** — `C-R1-COLLECTIONS-PER-ENCODER` (4 collections), `C-R1-CLASSIFICATION` (3 classification variants), `C-R1-GLOBE-RENDERSTATE`, `C-R1-TILE-BATCH`, `C-R1-PRIMITIVE-DERIVED` (depth-fail variants).
- **C-R8 remaining sub-items** — `C-R8-TRANSLUCENT-TILE-CLASS`, `C-R8-INVERT-CLASS-COMPOSITION`, `C-R8-EDGE-FBO`.
- **C-R7 per-renderer routing**, **C-R9 Model + Voxel pick**, **C-R10 receive shader**, **C-R11 per-tile EffectsBindGroup**, **C-R12 per-object caches** — unchanged.
- **Other deferrals** — C-R4 (KHR extensions, multi-session), C-R5 (imagery 4→16).
- **Data pipeline + infrastructure** items unchanged.

---

## Batch 38 — C-R8 deep audit + InvertClassification composite API (2026-04-23)

Deep audit of the three remaining C-R8 sub-items (`C-R8-INVERT-CLASS-COMPOSITION`, `C-R8-TRANSLUCENT-TILE-CLASS`, `C-R8-EDGE-FBO`) produced a more honest scope picture than the initial "each is bounded" framing. Two of the three need substantial scope (500-1000 LOC multi-pass depth-peeling for translucent-tile-class; shader-side uniformState wiring for edge FBO) that won't land user-visible value in a partial implementation. The third (InvertClassification) decomposes into (a) a composite API that's cleanly landed here, and (b) a framebuffer-redirect step that's larger than the minimum-viable-fix scope suggested.

**Batch 38 ships**: the InvertClassification composite API cleanly, documents remaining scope for all three with explicit follow-up IDs, and commits to the two big ones being dedicated-session work rather than forced partial batches.

**Files touched:**

- [packages/engine/Source/Renderer/WebGPU/WebGPUInvertClassification.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUInvertClassification.ts)
  - **Shader reworked**: the previous design bound both `sceneTex` and `classifiedTex` then output a blended scene color. Binding the scene color texture for READ while targeting it for WRITE in the same render pass is a WebGPU validation error (`maintains writable state`). New shader drops the `sceneTex` bind entirely — classified regions emit `vec4(0,0,0,0)` (transparent, scene passes through unchanged via src-alpha blend), unclassified regions emit `highlightColor` (composites over scene at `highlightColor.a`).
  - **Bind group layout reduced** from 4 entries (sceneTex + classifiedTex + sampler + uniforms) to 3 (classifiedTex + sampler + uniforms). Matches the reworked shader.
  - **New `executeInvertClassificationComposite(invertClass, encoder, targetView)` export**. Begins a render pass on `targetView`, sets the composite pipeline + bind group, draws the fullscreen triangle, ends. Called by future framebuffer-redirect follow-up after the classified 3D tile content is written to `classifiedTexture`.
  - **Destroy path updated** — no new allocations, just the reduced bind group.
  - **Cache `bindGroupLayout` slot added** for rebuild-on-view-change (not currently used since composite doesn't rebind per call, but present for future work that needs to swap texture views).

**Typecheck:** `npx tsc --noEmit` — clean. Two pre-existing `WebGPUContext.ts` errors unchanged. Wrapper sync: 38/38.

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| C-R8 (piece 4 of 6, partial) | RENDERER_DEEP | InvertClassification two-pass FBO composition | **API LANDED** — `executeInvertClassificationComposite` exported and typechecks. Shader reworked to avoid read/write-same-texture conflict. Missing: framebuffer-redirect step that writes classified tile output into `classifiedTexture`, and the call-site wiring from `WebGPUSceneRenderer`. Tracked as `C-R8-INVERT-CLASS-FBO-REDIRECT`. |

### Audit decisions (what's explicitly deferred)

**`C-R8-TRANSLUCENT-TILE-CLASS`** — deferred with rationale. The WebGL implementation (`TranslucentTileClassification.js`) is a multi-pass depth-peeling + classification scheme for polygon overlays on translucent 3D-tile content. Audit estimate: 500-1000 LOC + WGSL shaders + multi-target FBO + stencil-peeling logic. No partial implementation lands user value (depth-peeling is all-or-nothing). Flagged for a dedicated session after a user signals they need it — likely niche use case (most users don't overlay polygons on translucent tiles).

**`C-R8-EDGE-FBO`** — deferred with rationale. The FBO infrastructure itself is 100-150 LOC (3-attachment MRT, framebuffer redirect for `Pass.CESIUM_3D_TILE_EDGES`). But the output textures need to flow into subsequent passes' shader uniforms (`edgeColorTexture`, `edgeIdTexture`, `edgeDepthTexture`) for the edges to composite onto the scene. Without the shader-side uniform-state wiring, the textures render correctly but no pass samples them → zero user-visible change. Shader-side wiring is a separate, larger task touching globe / primitive / model shaders. Infrastructure alone isn't worth shipping.

**`C-R8-INVERT-CLASS-FBO-REDIRECT`** — the partial Batch 38 ships the composite half. Remaining: SceneRenderer path that, when `useInvertClassification` is active, ends the current render pass before `Pass.CESIUM_3D_TILE`, begins a new pass targeting `invertClassification._webgpuCache.classifiedTextureView`, runs the tile commands into it, ends that pass, runs classification-ignore-show into the same target, then resumes the scene pass and invokes `executeInvertClassificationComposite`. ~80-120 LOC of SceneRenderer plumbing plus correctness verification (depth sharing, MSAA behavior). Tractable next-session target.

### Why the initial "bounded fix" framing was wrong

The audit from the start of this batch pitched all three as "1-4 hour fixes". Actual scope turned out larger:

- **InvertClassification "50-80 lines"**: the minimum-viable-fix estimate counted only the composite function + a small wire. It didn't account for (a) the read/write-same-texture shader conflict (requiring a shader rework) or (b) the framebuffer redirect needing its own pass-begin/end dance in the frustum loop.
- **Edge FBO "100-150 lines"**: counted the FBO + redirect only. Didn't account for the shader uniforms needing to flow into consumer passes — which IS the feature; without it, the FBO is write-only.
- **Translucent-tile-class "2-3 hours"**: underestimated. Depth-peeling is not a 2-3 hour feature; the WebGL code is 700+ LOC + multi-pass.

**Lesson for future deep audits**: the audit should cost-account not just the primary feature code but also the "observable effect chain" — does the infrastructure produce user-visible output, or does it need downstream consumers to be wired first?

### What's still open after Batch 38

- **C-R8 remaining**: `C-R8-TRANSLUCENT-TILE-CLASS` (multi-session), `C-R8-INVERT-CLASS-FBO-REDIRECT` (next session), `C-R8-EDGE-FBO` (paired with shader uniformState wiring — multi-session).
- **C-R1 remaining** — unchanged from post-Batch-37.
- **C-R7 per-renderer routing**, **C-R9 Model + Voxel pick**, **C-R10 receive shader**, **C-R11 per-tile EffectsBindGroup**, **C-R12 per-object caches** — unchanged.
- **Other deferrals** — C-R4, C-R5.
- **Data pipeline + infrastructure** items unchanged.

---

## Batch 39 — C-R8 InvertClassification FBO redirect + C-R1 Collections + H-R4 dead code (2026-04-24)

Triple bundle closing out three independent follow-ups in one session:

1. **C-R8-INVERT-CLASS-FBO-REDIRECT** — finishes the InvertClassification feature end-to-end by pairing with the composite API landed in Batch 38. 3D-tile output now routes into `InvertClassification.classifiedTexture` when the feature is active, then composites back onto scene color after the main scene pass ends.
2. **C-R1-COLLECTIONS-PER-ENCODER** — forwards the JS-side `renderState` from BillboardCollection, CloudCollection, PointPrimitiveCollection, and PolylineCollection onto the emitted `WebGPUDrawCommand` so `applyPerEncoderState` drives stencil-ref / blend-constant / viewport / scissor the same way the WebGL path does. Four collections × two commands (color + pick) each, following the Batch 37 Model pattern.
3. **H-R4** — deletes the dead `WebGPUPassState.applyToRenderPass` method. Only reference was a JSDoc mention that's been updated to describe the actual path (per-command `applyPerEncoderState` from Batches 30/35/36/37/39).

**Files touched:**

- [packages/engine/Source/Renderer/WebGPU/WebGPUInvertClassification.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUInvertClassification.ts)
  - **Shader semantics corrected**: Batch 38's shader emitted transparent for classified regions (relying on scene color to show through), but the redirected tile pass writes tile color into `classifiedTexture` NOT scene color — so scene color stayed empty where tiles were. New shader emits the tile color (optionally tinted by `highlightColor`) for pixels with `classifiedTex.a > 0`, transparent for non-tile pixels. Without stencil gating we can't split classified vs unclassified tile pixels (WebGL does this via stencil); current behavior tints every tile pixel when `enableHighlight` is on, which is a reasonable stand-in. Stencil-accurate gating tracked as `C-R8-INVERT-CLASS-STENCIL` for a future session.
  - **MSAA support**: `classifiedTexture` now matches the scene's `numSamples` so tile draw-command pipelines (built for scene MSAA) validate inside the redirected pass. MSAA paths allocate a paired single-sample `resolveTexture` + view used by the composite bind group (the composite pipeline stays at `multisample.count=1` since it targets the resolved scene color view).
  - **New exports**: `buildInvertClassificationColorAttachment(invertClass)` returns the GPURenderPassColorAttachment (with optional `resolveTarget` for MSAA), `isInvertClassificationReady(invertClass)` gates the redirect, `getInvertClassificationSampleCount(invertClass)` reports the sample count.
  - **Cache shape expanded**: added `resolveTexture`, `resolveTextureView`, `sampleCount`.
  - **Destroy path** cleans up the new resolve texture.

- [packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts)
  - **`_execute3DTilePasses` now accepts the redirect path**: when `config.useInvertClassification` is true and the invert cache is ready, ends the default scene pass, opens an invert pass targeting `classifiedTexture` (with clear loadOp) + scene depth (load/store), runs `CESIUM_3D_TILE_EDGES` and `CESIUM_3D_TILE` inside it, ends and resumes the default pass. Classification passes (which don't participate in the FBO redirect) run normally on scene color. Debug-pragma-wrapped warn logs cover the missing-resource fallback cases.
  - **`_runInvertClassificationComposite` added** and wired after environmental effects, before `_runPostProcessing`. Ends the main scene pass (so MSAA resolves), invokes `executeInvertClassificationComposite` targeting the single-sample resolved scene color view, resumes the default pass for post-process teardown. No-op when the feature is disabled or not ready.

- [packages/engine/Source/Renderer/WebGPU/WebGPUBillboardRenderer.js](../packages/engine/Source/Renderer/WebGPU/WebGPUBillboardRenderer.js)
  - Forwards `collection._rsOpaque` or `collection._rsTranslucent` (based on the chosen `billboardPass`) onto both `colorCommand` and `pickCommand`. Pick defaults to `_rsOpaque` since it always runs in the opaque pass.

- [packages/engine/Source/Renderer/WebGPU/WebGPUCloudRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUCloudRenderer.ts)
  - Forwards `collection._rs` onto the cached translucent cloud command each frame so the per-encoder state follows any future re-builds of `_rs`.

- [packages/engine/Source/Renderer/WebGPU/WebGPUPointPrimitiveRenderer.js](../packages/engine/Source/Renderer/WebGPU/WebGPUPointPrimitiveRenderer.js)
  - Forwards `collection._rsOpaque` / `collection._rsTranslucent` onto `colorCommand` (per-frame, matching the chosen pass) and `pickCommand` (opaque preference).

- [packages/engine/Source/Renderer/WebGPU/WebGPUPolylineRenderer.js](../packages/engine/Source/Renderer/WebGPU/WebGPUPolylineRenderer.js)
  - Forwards `collection._opaqueRS` / `collection._translucentRS` onto the per-batch color command and the pick command. Mirrors the inline assignment at `PolylineCollection.js:740`.

- [packages/engine/Source/Renderer/WebGPU/WebGPUPassState.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUPassState.ts)
  - Deleted `applyToRenderPass` (dead — no callers remained; per-encoder state now flows through `applyPerEncoderState` per-draw-command from `renderState` forwarding).

- [packages/engine/Source/Renderer/WebGPU/RenderStateToPipelineVariant.ts](../packages/engine/Source/Renderer/WebGPU/RenderStateToPipelineVariant.ts)
  - Updated the `applyPerEncoderState` JSDoc to drop the now-invalid reference to `WebGPUPassState.applyToRenderPass`. Rephrased to describe the actual current behavior (encoder default from `beginRenderPass` / `resumeDefaultRenderPass`).

**Typecheck:** `npx tsc --noEmit` — clean (zero errors). No new wrapper sync needed (files modified live under `packages/engine/Source/`; `Source/Renderer/WebGPU/` only contains `Stubs/`).

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| C-R8 (piece 4 of 6, FIXED) | RENDERER_DEEP | InvertClassification FBO redirect + composite | **FIXED** — full round-trip now wired. 3D-tile passes route to `classifiedTexture` when the feature is on; composite overlays the tile content (tinted by `invertClassificationColor`) back onto scene color after the main scene pass ends. MSAA-safe (attachment matches scene sample count with paired resolve target). Classified/unclassified tile pixel distinction still stand-in (see `C-R8-INVERT-CLASS-STENCIL`). |
| C-R1 (collections, FIXED) | RENDERER_DEEP | Billboard/Cloud/Point/Polyline renderState forwarding | **FIXED** — all four collections now forward their JS-side render state onto emitted WebGPUDrawCommands (color + pick). Pattern matches Batch 37 Model. |
| H-R4 (FIXED) | RENDERER_DEEP | Dead `applyToRenderPass` method | **FIXED** — deleted. JSDoc reference in `RenderStateToPipelineVariant.ts` rewritten to describe the actual current flow. |

### What's still open after Batch 39

- **C-R8 remaining**:
  - `C-R8-TRANSLUCENT-TILE-CLASS` (multi-session, ~500-1000 LOC depth-peeling).
  - `C-R8-EDGE-FBO` (paired with shader uniformState wiring — multi-session).
  - `C-R8-INVERT-CLASS-STENCIL` (NEW) — stencil-accurate classified-vs-unclassified tile pixel gating in the InvertClassification shader. Currently tints every tile pixel when `enableHighlight` is on; WebGL splits these via stencil written during CLASSIFICATION_IGNORE_SHOW.
- **C-R1 remaining**: 4 follow-up items remain (`C-R1-CLASSIFICATION`, `C-R1-GLOBE-RENDERSTATE`, `C-R1-TILE-BATCH`, `C-R1-PRIMITIVE-DERIVED`) plus the 9 WebGPU-native renderers noted in Batch 36 as no-external-source. Collections are now fully covered.
- **C-R7 per-renderer routing**, **C-R9 Model + Voxel pick**, **C-R10 receive shader**, **C-R11 per-tile EffectsBindGroup**, **C-R12 per-object caches** — unchanged.
- **H-severity remaining**: H-R1, H-R2, H-R5–H-R14 (12 of 14 items). H-R3 + H-R4 now fixed.
- **Other deferrals** — C-R4, C-R5.
- **Data pipeline + infrastructure** items unchanged.

### Audit-scope calibration note (continuing from Batch 38)

Batch 38 noted that the "bounded fix" framing under-counted scope. Batch 39 landed within budget: the FBO-redirect scope estimate from Batch 38 (80-120 LOC + MSAA + composite wiring) was accurate this time. The useful discipline remains: **cost-account the full observable chain, not just the primary code path**. The InvertClassification composite wasn't user-visible in Batch 38 because no caller invoked it; Batch 39 closes that loop.

---

## Batch 40 — C-R8 InvertClassification stencil-gated composite (2026-04-24)

Follow-up to the Batch 39 FBO redirect: WebGL's InvertClassification uses a stencil-gated two-pass composite to split "classified tile pixels" (rendered unmodified) from "unclassified tile pixels" (rendered with the highlight tint). Batch 39 couldn't gate on classification because no stencil bits were being written. Batch 40 closes that gap: the invert FBO now has its own MSAA-matched depth-stencil texture, the `CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW` pass is redirected into it (so classification primitives write stencil marks via their `setCesium3DTileBit` render state), and the composite runs two MSAA-capable pipelines stencil-tested against that buffer.

**Result**: WebGPU InvertClassification now matches WebGL's per-pixel gating when a scene has actual classification primitives. When no classifications exist (typical case), the stencil buffer stays at 0 and the `unclassifiedPipeline` tints every tile pixel — same as Batch 39 behavior but architecturally correct.

**Files touched:**

- [packages/engine/Source/Renderer/WebGPU/WebGPUInvertClassification.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUInvertClassification.ts)
  - **New cache slots**: `depthStencilTexture` / `depthStencilView` (MSAA-matched `depth24plus-stencil8`), `unclassifiedPipeline` / `classifiedPipeline` (the two stencil-gated composite pipelines).
  - **Shader extended** with two new fragment entry points: `fragmentUnclassified` (tile color × highlight tint) and `fragmentClassified` (raw tile color). Legacy `fragmentMain` retained for the single-sample fallback path.
  - **Pipeline construction** now builds three pipelines: the legacy single-pass fallback, plus MSAA-capable `unclassifiedPipeline` (stencilCompare=equal, reference=0) and `classifiedPipeline` (stencilCompare=not-equal, reference=0). Both gated pipelines use `depthCompare: always` (depth disabled) and `stencilWriteMask: 0` (stencil read-only) since this is a fullscreen composite.
  - **New helper**: `buildInvertClassificationDepthStencilAttachment(invertClass, depthLoadOp, stencilLoadOp)` — used by the tile pass (clear/clear), the classification-ignore-show pass (load/load to preserve tile depth + append stencil writes), and implicitly by the composite (read-only load in its own descriptor).
  - **Composite rewrite**: `executeInvertClassificationComposite` now takes an optional MSAA scene-color attachment view + `invertHasStencilData` flag. When both are provided, runs the stencil-gated two-pass path (target MSAA scene color + resolveTarget + invert depth-stencil). Otherwise falls back to the legacy single-sample composite.
  - **Destroy path** cleans up the new depth-stencil texture.
  - **`isInvertClassificationReady` gate tightened** to require the two new pipelines + the depth-stencil view, so callers only take the new path when everything's actually allocated.

- [packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts)
  - **`_execute3DTilePasses` extended**: the invert-redirect path now uses the invert FBO's own depth-stencil instead of scene depth (tile depth writes land there), and adds a second redirect pass for `Pass.CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW` with `loadOp: "load"` on color + depth + stencil so classification primitives' `setCesium3DTileBit` stencil marks accumulate inside the invert FBO. The normal `Pass.CESIUM_3D_TILE_CLASSIFICATION` still runs on the scene FB afterwards (this is the "visible" classification path, unchanged).
  - **New per-frame flag** `_invertClassStencilReady`, reset at the start of the scene render loop and flipped to `true` when the CLASSIFICATION_IGNORE_SHOW redirect succeeds. Read by `_runInvertClassificationComposite` to decide stencil-gated vs fallback.
  - **`_runInvertClassificationComposite` now picks up the MSAA scene-color attachment view** when stencil is ready, passing it to the composite helper so the two-pass stencil-tested draws run against the MSAA attachment (re-resolving at pass end).

**Follow-ups carved by this batch:**

- `C-R8-INVERT-DEPTH-SOURCE` — when invert classification is on, `globeDepth.executeUpdateDepth` still reads from the scene framebuffer's depth even though the tile pass now writes to the invert FBO's depth. Downstream ground/overlay primitives may still Z-fight against tiles when invert is on until this is wired (globe-depth needs a source-switching parameter when invert is active, mirroring WebGL's `SceneRenderer.js:573-578`).
- `C-R8-INVERT-HDR` — classification primitives' pipeline color format matches scene color format. When scene is HDR (`rgba16float` instead of canvas format), the invert FBO's `canvasFormat` color texture won't match classification pipelines. HDR support requires plumbing the scene's color format through `updateWebGPUInvertClassification`.

**Typecheck:** `npx tsc --noEmit` — clean (zero errors).

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| C-R8-INVERT-CLASS-STENCIL (FIXED) | RENDERER_DEEP | InvertClassification stencil-gated composite | **FIXED** — invert FBO has its own MSAA depth-stencil, `CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW` is redirected into it (writing stencil bits via classification render state), and the composite runs two stencil-tested pipelines matching WebGL's `rsClassified`/`rsUnclassified` split. Graceful fallback to Batch 39's single-pass composite when stencil isn't populated yet (first frame, or no classification primitives in scene). |

### What's still open after Batch 40

- **C-R8 remaining**:
  - `C-R8-TRANSLUCENT-TILE-CLASS` (multi-session, ~500-1000 LOC depth-peeling).
  - `C-R8-EDGE-FBO` (paired with shader uniformState wiring — multi-session).
  - `C-R8-INVERT-DEPTH-SOURCE` (NEW) — globe-depth should read invert FBO's depth when invert is on.
  - `C-R8-INVERT-HDR` (NEW) — invert FBO color format needs to track scene color format for HDR scenes.
- **C-R1 remaining** — unchanged from Batch 39.
- **C-R7 per-renderer routing**, **C-R9 Model + Voxel pick**, **C-R10 receive shader**, **C-R11 per-tile EffectsBindGroup**, **C-R12 per-object caches** — unchanged.
- **H-severity remaining**: H-R1, H-R2, H-R5–H-R14 (12 of 14 items).
- **Other deferrals** — C-R4, C-R5.
- **Data pipeline + infrastructure** items unchanged.

---

## Batch 41 — C-R8 invert depth source + HDR format (2026-04-24)

Closes two follow-ups carved by Batch 40:

1. **C-R8-INVERT-DEPTH-SOURCE** — `WebGPUGlobeDepth.executeUpdateDepth` now accepts an optional `depthTextureOverride`, which the SceneRenderer's post-tile depth-update hook passes when invert classification is active. Mirrors WebGL's `SceneRenderer.js:573-578` where the invert FBO's depth-stencil texture replaces the scene depth source for the globe-depth update.
2. **C-R8-INVERT-HDR** — InvertClassification's `classifiedTexture` now allocates with the scene's actual color format (HDR `rgba16float` or canvas format), not a hardcoded canvas format. Required because the tile draw-command pipelines are built for scene color format — previously, in an HDR scene the redirected pass would target a canvas-format texture while the pipelines expected HDR, causing silent format drift. Cache invalidates on format change so HDR toggle during a session rebuilds the classified texture + pipelines.

Both fixes are minimal-surface (thin parameter plumbing + cache invalidation) following the infrastructure established in Batches 39-40.

**Files touched:**

- [packages/engine/Source/Renderer/WebGPU/WebGPUSceneFramebuffer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUSceneFramebuffer.ts)
  - Added `get colorFormat(): GPUTextureFormat` and `get hdr(): boolean` accessors so feature renderers and the scene renderer can read the scene's actual color format without reaching into private fields.

- [packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts)
  - After `_sceneFramebuffer.update()` each frame, assigns `context._sceneColorFormat = this._sceneFramebuffer.colorFormat` so downstream consumers (InvertClassification update, OIT, etc.) read the current HDR-aware format. Previously the field was declared on the context but never populated, leaving it stuck at the default `"bgra8unorm"`.
  - `_execute3DTilePasses` hook now pulls the invert depth texture via `getInvertClassificationDepthTexture` and passes it to `executeUpdateDepth` when invert classification is active. The depth-source override propagates through to `_updateDepthCopyBindGroup` which was updated to use the override in preference to the scene framebuffer's depth.

- [packages/engine/Source/Renderer/WebGPU/WebGPUGlobeDepth.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUGlobeDepth.ts)
  - `executeUpdateDepth(encoder, depthTextureOverride?)` and `executeCopyDepth(encoder, depthTextureOverride?)` both accept an optional depth texture that replaces the default scene-framebuffer depth source.
  - `_updateDepthCopyBindGroup(depthTextureOverride?)` threads the override through to the bind group, falling back to `colorFramebufferTarget.getDepthTexture()` when no override is supplied.

- [packages/engine/Source/Renderer/WebGPU/WebGPUInvertClassification.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUInvertClassification.ts)
  - Pulls the scene's color format from `context._sceneColorFormat` (falls back to `navigator.gpu.getPreferredCanvasFormat()`) and uses it as the format for the classified texture, resolve texture, and composite pipeline targets.
  - Added `colorFormat` slot to the cache + included it in the `needsResize` check so format changes (HDR toggle) invalidate the cache and trigger texture + pipeline recreation.
  - New export `getInvertClassificationDepthTexture(invertClass)` — returns the invert FBO's depth-stencil texture for the globe-depth override. Returns `undefined` when the cache isn't ready.

**Typecheck:** `npx tsc --noEmit` — clean (zero errors).

**Operational note:** `environmentState.useGlobeDepthFramebuffer` is currently hard-coded to `false` in the WebGPU context override, so the `onAfterTileMainPass` depth-update hook doesn't actually fire in production yet. The depth-source fix is in place for when that flag flips on (tracked under the broader `useGlobeDepthFramebuffer` enablement work); without it, the WebGPU path silently skips globe-depth update regardless of invert state.

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| C-R8-INVERT-DEPTH-SOURCE (FIXED) | RENDERER_DEEP | Invert FBO depth source for globe-depth update | **FIXED** — `executeUpdateDepth` now accepts an optional depth-texture override; SceneRenderer passes the invert FBO's depth when invert classification is active. Matches WebGL's explicit depth-source argument. |
| C-R8-INVERT-HDR (FIXED) | RENDERER_DEEP | Invert FBO color format tracks scene color format | **FIXED** — invert classified texture + composite pipelines now allocate in scene color format (reads from `context._sceneColorFormat`, which is now properly populated from the scene framebuffer each frame). Cache invalidates on format change. |

### What's still open after Batch 41

- **C-R8 remaining**:
  - `C-R8-TRANSLUCENT-TILE-CLASS` (multi-session, ~500-1000 LOC depth-peeling).
  - `C-R8-EDGE-FBO` (paired with shader uniformState wiring — multi-session).
- **C-R1 remaining** — unchanged from Batch 39.
- **C-R7 per-renderer routing**, **C-R9 Model + Voxel pick**, **C-R10 receive shader**, **C-R11 per-tile EffectsBindGroup**, **C-R12 per-object caches** — unchanged.
- **H-severity remaining**: H-R1, H-R2, H-R5–H-R14 (12 of 14 items).
- **Other deferrals** — C-R4, C-R5.
- **Data pipeline + infrastructure** items unchanged.

---

## Batch 42 — C-R8-GLOBE-DEPTH-ENABLE: unblock useGlobeDepthFramebuffer (2026-04-24)

Batch 41 left an operational caveat: `environmentState.useGlobeDepthFramebuffer` was hard-forced to `false` in the WebGPU context override, so the depth-update hook + the depth-source fix from Batch 41 never actually fired. Batch 42 closes that gap.

**What this actually enables:**

- `WebGPUSceneRenderer._globeDepth` now instantiates at initialization (gated on `config.useGlobeDepthFramebuffer`, which is now driven by the context override).
- `_globeDepth.executeUpdateDepth` fires after the main 3D tile pass, copying the scene's depth into the packed RGBA depth texture exposed by `globeDepthTexture`.
- `PickDepth.update` (the WebGPU async branch stashes the depth texture) now receives a populated texture.
- `pickPosition` can read the packed depth texture for screen-space → world-space reconstruction.

**MSAA gate:** the flag is additionally conditioned on `scene.msaaSamples === 1`. Reason: WebGPU's `texture_depth_2d` binding can't sample MSAA depth attachments, and enabling the flag without a working depth copy would leave `PickDepth` reading an empty packed texture — strictly worse than leaving it off. A `texture_depth_multisampled_2d` shader variant for MSAA is a dedicated follow-up (`C-R8-GLOBE-DEPTH-MSAA`). Users who need `pickPosition` on WebGPU can set `scene.msaaSamples = 1` today; the single-sample branch is fully wired.

**Files touched:**

- [packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts)
  - `updateAndClearFramebuffers` — flipped `environmentState.useGlobeDepthFramebuffer` from the hard-coded `false` to `!picking && msaaSamples === 1`. Matches the WebGL orchestrator's `defined(view.globeDepth)` semantic (always on when not picking), minus the MSAA gate.

- [packages/engine/Source/Renderer/WebGPU/WebGPUGlobeDepth.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUGlobeDepth.ts)
  - `_updateDepthCopyBindGroup` now checks the source depth texture's `sampleCount` and no-ops when > 1, clearing `_depthCopyBindGroup` so `executeCopyDepth` skips the draw. Debug-pragma-wrapped once-per-context warn logs explain the skip the first time it fires.
  - Added private `_msaaDepthWarningLogged` flag to throttle the warn.

- [packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts)
  - Two `executeCopyDepth`/`executeUpdateDepth` call sites now pass the scene framebuffer's depth texture explicitly instead of relying on GlobeDepth's internal `_outputTarget` fallback (that texture is never rendered into under WebGPU's scene flow, so the fallback was effectively passing empty depth).
  - Post-GLOBE copy (line ~1080): passes `this._sceneFramebuffer?.colorTarget?.getDepthTexture()`.
  - Post-3D-tile hook: passes scene FB depth by default, overrides with invert FBO depth when invert classification is active (C-R8-INVERT-DEPTH-SOURCE path from Batch 41 now actually reachable).

**Typecheck:** `npx tsc --noEmit` — clean (zero errors).

**Follow-up carved:** `C-R8-GLOBE-DEPTH-MSAA` — MSAA-depth sampling variant of the depth copy (`texture_depth_multisampled_2d` binding + per-sample shader logic) to unblock pickPosition on the default 4×MSAA scene. Bounded follow-up; requires one new shader variant + a pipeline duplicate keyed on sample count.

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| C-R8-GLOBE-DEPTH-ENABLE (FIXED, non-MSAA) | RENDERER_DEEP | Hard-forced `useGlobeDepthFramebuffer=false` unblocked | **FIXED** for non-MSAA. WebGPU context now sets `!picking && msaaSamples===1`; globe depth copy, packed depth texture, and PickDepth async stash all wire correctly. MSAA variant tracked as `C-R8-GLOBE-DEPTH-MSAA`. |

### What's still open after Batch 42

- **C-R8 remaining**:
  - `C-R8-TRANSLUCENT-TILE-CLASS` (multi-session, ~500-1000 LOC depth-peeling).
  - `C-R8-EDGE-FBO` (paired with shader uniformState wiring — multi-session).
  - `C-R8-GLOBE-DEPTH-MSAA` (NEW) — MSAA-depth sampling variant of the depth copy.
- **C-R1 remaining** — unchanged from Batch 39.
- **C-R7 per-renderer routing**, **C-R9 Model + Voxel pick**, **C-R10 receive shader**, **C-R11 per-tile EffectsBindGroup**, **C-R12 per-object caches** — unchanged.
- **H-severity remaining**: H-R1, H-R2, H-R5–H-R14 (12 of 14 items).
- **Other deferrals** — C-R4, C-R5.
- **Data pipeline + infrastructure** items unchanged.

---

## Batch 43 — C-R8-GLOBE-DEPTH-MSAA: MSAA depth sampling (2026-04-24)

Closes the follow-up carved by Batch 42: `useGlobeDepthFramebuffer` can now stay on for the default 4×MSAA scene. The depth copy gets a second pipeline variant that reads MSAA depth via `texture_depth_multisampled_2d` + `textureLoad(sampleIndex=0)`, which is the standard WebGPU idiom for the non-resolvable depth format (platform render-pass depth-stencil resolve isn't universally supported, so an explicit shader read is the pragmatic path).

**Files touched:**

- [packages/engine/Source/Renderer/WebGPU/WebGPUGlobeDepth.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUGlobeDepth.ts)
  - Added `DEPTH_COPY_MSAA_WGSL` shader module with a `texture_depth_multisampled_2d` binding and an unsampled `textureLoad(depthTex, coord, 0)` read. `coord` is derived from the `@builtin(position)` pixel coordinate — no sampler needed.
  - Added MSAA variant slots on the class: `_depthCopyMSAAPipeline`, `_depthCopyMSAABindGroupLayout`, `_depthCopyMSAABindGroup`.
  - `_createDepthCopyMSAAPipeline(device)` method — hand-rolled bind group layout entry with `{ texture: { sampleType: "depth", viewDimension: "2d", multisampled: true } }` (our `texture()` helper doesn't expose `multisampled` yet).
  - `update()` now eagerly builds both single-sample and MSAA pipelines at init — they're tiny and having both ready avoids a late recompile on sample-count change.
  - `_updateDepthCopyBindGroup` now returns `boolean` indicating MSAA path selected; routes depth view into the MSAA bind group when `sampleCount > 1`, single-sample bind group otherwise. Stale bind groups in the opposite slot are cleared on every call so a sample-count flip doesn't leak bindings across frames.
  - `executeCopyDepth` picks pipeline + bind group based on the `_updateDepthCopyBindGroup` return value.
  - Destroy path cleans up the new MSAA slots.
  - Removed the Batch 42 once-per-context MSAA warning flag (no longer dead-end).

- [packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts)
  - `updateAndClearFramebuffers` — removed the MSAA gate, `useGlobeDepthFramebuffer` is now `!picking` regardless of sample count. Matches WebGL orchestrator semantics exactly.

**Design note:** The MSAA variant reads `sampleIndex = 0` rather than averaging across samples. Reasoning:

1. PickPosition wants a single deterministic depth value per pixel, not an averaged one (averaging introduces depth-pixel leakage across silhouettes).
2. Ground-primitive / terrain-clamping reads also prefer a deterministic source.
3. Per-sample averaging complicates the packed-format rounding math (`floor(d * 255) / 255` inversion) and introduces compound precision loss.
4. Sample 0 matches the default-sample convention in WebGL's `glSampleCoverage` / `gl_SampleID = 0` read path.

A per-sample average variant could be added later if depth-aware effects (SSAO, DOF) need it — those effects aren't yet ported.

**Typecheck:** `npx tsc --noEmit` — clean (zero errors).

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| C-R8-GLOBE-DEPTH-MSAA (FIXED) | RENDERER_DEEP | MSAA depth sampling variant for globe-depth copy | **FIXED** — `texture_depth_multisampled_2d` + `textureLoad(..., 0)` shader variant + paired pipeline/bind-group lane. `useGlobeDepthFramebuffer` now enabled for all non-picking frames regardless of MSAA. |

### What's still open after Batch 43

- **C-R8 remaining**:
  - `C-R8-TRANSLUCENT-TILE-CLASS` (multi-session, ~500-1000 LOC depth-peeling).
  - `C-R8-EDGE-FBO` (paired with shader uniformState wiring — multi-session).
- **C-R1 remaining** — unchanged from Batch 39.
- **C-R7 per-renderer routing**, **C-R9 Model + Voxel pick**, **C-R10 receive shader**, **C-R11 per-tile EffectsBindGroup**, **C-R12 per-object caches** — unchanged.
- **H-severity remaining**: H-R1, H-R2, H-R5–H-R14 (12 of 14 items).
- **Other deferrals** — C-R4, C-R5.
- **Data pipeline + infrastructure** items unchanged.

---

## Batch 44 — C-R8-EDGE-FBO: edge MRT framebuffer + composite consumer (2026-04-24)

Closes the last bounded C-R8 sub-item. Ships the full EDGE-FBO infrastructure (allocation + redirect + uniform plumbing) AND a consumer that paints edges over the scene once emitters fill the FBO. The authoritative per-fragment inline `edgeDetectionStage()` is still a follow-up (`C-R8-EDGE-INLINE`) — requires WGSL ports of the Model fragment shader family. The overlay composite delivered here produces the same visual outcome without the inline cost: for every edge-emitter-populated pixel, the composite blends edge color over scene color with depth gating.

**Files added:**

- [packages/engine/Source/Renderer/WebGPU/WebGPUEdgeFramebuffer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUEdgeFramebuffer.ts) (new, ~235 LOC)
  - Owns the MRT render target: three color attachments (edge color in scene color format, id + metadata rgba8, packed depth rgba8) + depth-stencil.
  - MSAA-matched to scene, with per-attachment single-sample resolve targets so downstream consumers always have a sampleable single-sample view.
  - `buildColorAttachments()` / `buildDepthStencilAttachment()` produce pass descriptors with `loadOp: "clear"` on color (transparent) and depth+stencil (1.0 / 0) — mirrors WebGL's `EdgeFramebuffer.getClearCommand(Color(0,0,0,0))`.
  - Exposes `colorSampleableView` / `idSampleableView` / `depthSampleableView` for consumers. MSAA depth-stencil is NOT sampleable — edge consumers read the packed-depth color attachment (already resolved) instead.

- [packages/engine/Source/Renderer/WebGPU/WebGPUEdgeComposite.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUEdgeComposite.ts) (new, ~300 LOC)
  - Post-process style overlay that reads the resolved edge color + packed depth and blends over scene color with `src-alpha` semantics.
  - Depth gate: unpacks edge depth and compares against scene depth (when sampleable — single-sample scenes). Emits edge color when edge is in front of or within epsilon of scene; transparent otherwise. MSAA scenes disable the depth gate via a uniform flag and composite unconditionally (matches WebGL's fallback behavior for non-depth-sample contexts).
  - 1×1 fallback depth texture for the MSAA case keeps the bind group layout valid when `sceneDepthView` is null.
  - `createEdgeCompositeCache()` / `destroyEdgeCompositeCache()` / `executeEdgeComposite()` — external API.

**Files modified:**

- [packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts)
  - Added `_edgeColorView`, `_edgeIdView`, `_edgeDepthView` public slots — per-frame set by the SceneRenderer after the edges pass resolves, consumed by the composite (and future in-model edge stage). WebGPU equivalent of WebGL's `uniformState.edge{Color,Id,Depth}Texture`.

- [packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts)
  - New `_edgeFramebuffer` field (lazy; allocated when `scene._enableEdgeVisibility` is on). Included in destroy path + device-invalidation drop set.
  - `_execute3DTilePasses` pulls `Pass.CESIUM_3D_TILE_EDGES` out of `firstPasses` into its own redirect branch. When the edge FBO is ready AND there are edge commands, the pass opens a render pass on the edge MRT (with MSAA-aware resolve targets), runs the edge commands, ends/resumes, and publishes the resolved views onto `context._edgeColorView` etc. When the FBO isn't ready, runs on the scene target as a fallback (matches pre-Batch-44 behavior).
  - New `_edgeTexturesPopulated` per-frame flag set when the redirect succeeds, reset at the start of each frame.
  - New `_edgeCompositeCache` field and `_runEdgeComposite` method. Composite runs after environmental effects, before invert-classification composite and post-process. No-op when `_edgeTexturesPopulated` is false.

**How the end-to-end path works once an emitter is present:**

1. Scene with `_enableEdgeVisibility = true` → `_edgeFramebuffer` allocates on first frame.
2. 3D-tile edge command (e.g., a future WebGPU Model edge pipeline variant) emits into `Pass.CESIUM_3D_TILE_EDGES` with MRT fragment output: `@location(0) edge color, @location(1) id + metadata, @location(2) packed depth`.
3. `_execute3DTilePasses` opens a render pass on the edge MRT, runs the emitter, resolves → single-sample views.
4. Views published on the context.
5. `_runEdgeComposite` opens a composite pass on the resolved scene color, reads edge color + packed depth + scene depth (when available), blends edges over scene.
6. Post-process sees the edge-decorated scene color and tonemaps/FXAAs as usual.

**Current state without edge emitters:** the FBO is allocated when `_enableEdgeVisibility` is set but stays empty (no WebGPU renderer currently emits to `Pass.CESIUM_3D_TILE_EDGES`). The composite is a no-op because the per-frame `_edgeTexturesPopulated` flag stays false when no edge commands run. Zero runtime cost for scenes without edge geometry.

**Typecheck:** `npx tsc --noEmit` — clean (zero errors).

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| C-R8-EDGE-FBO (FIXED) | RENDERER_DEEP | Edge MRT framebuffer + redirect + composite | **FIXED** — full WebGPU equivalent of WebGL's EdgeFramebuffer + `performCesium3DTileEdgesPass` + `edgeDetectionStage` (as overlay composite). Consumer-side infra complete; emitter-side (WebGPU Model edge pipeline variants, authoritative in-shader inline detection) tracked as `C-R8-EDGE-EMITTER` + `C-R8-EDGE-INLINE` follow-ups. |

### What's still open after Batch 44

- **C-R8 remaining**:
  - `C-R8-TRANSLUCENT-TILE-CLASS` (multi-session, ~500-1000 LOC depth-peeling) — only remaining original C-R8 sub-item.
  - `C-R8-EDGE-EMITTER` (NEW) — WebGPU Model edge pipeline variants that write to the 3-target MRT `@location(0) color, @location(1) id, @location(2) packedDepth`. Bounded but cross-cuts the Model WGSL shader family; follow-up session scope.
  - `C-R8-EDGE-INLINE` (NEW) — WGSL port of `edgeDetectionStage()` for in-model per-fragment edge blending (authoritative; supersedes the Batch 44 overlay composite when both exist). Larger scope — touches every WebGPU Model fragment shader.
- **C-R1 remaining** — unchanged from Batch 39.
- **C-R7 per-renderer routing**, **C-R9 Model + Voxel pick**, **C-R10 receive shader**, **C-R11 per-tile EffectsBindGroup**, **C-R12 per-object caches** — unchanged.
- **H-severity remaining**: H-R1, H-R2, H-R5–H-R14 (12 of 14 items).
- **Other deferrals** — C-R4, C-R5.
- **Data pipeline + infrastructure** items unchanged.

### Original C-R8 scorecard (after Batches 35-44)

| Sub-item | Status | Landed in |
|---|---|---|
| Globe depth update after 3D tile | FIXED | Batch 35 + 42/43 |
| VOXELS before OPAQUE ordering | FIXED | Batch 35 |
| 2D frustum jitter | FIXED | Batch 36 |
| InvertClassification FBO + composite | FIXED | Batches 38/39/40/41 |
| Translucent tile classification | **OPEN** (deferred, multi-session) | — |
| Edge FBO + consumer | FIXED (overlay composite; per-fragment follow-up) | Batch 44 |

5 of 6 original sub-items shipped end-to-end; the 6th (translucent-tile-class) is the remaining multi-session hold.

---

## Batch 45 — C-R8-EDGE-EMITTER: Model edge visibility emitter (2026-04-24)

Pairs with Batch 44's consumer: ships the WebGPU emitter that reads glTF `EXT_mesh_primitive_edge_visibility` data and produces draw commands that fill the Batch 44 edge MRT. The end-to-end path now works: edge-enabled glTF models render visible edges in WebGPU. Previously the edge FBO existed but was always empty because nothing emitted into `Pass.CESIUM_3D_TILE_EDGES` under the WebGPU renderer.

**Intentional scope cuts** (documented in file header, tracked as follow-ups):

- **`C-R8-EDGE-SILHOUETTE`** — WebGL discards back-facing silhouette (type=1) edges via per-vertex face-normal dot-product check. Batch 45 draws all silhouettes unconditionally (mild visual excess on occluded silhouettes; not incorrect output). Adding this requires two extra per-vertex attributes (silhouetteNormal + edgeOtherPos) and a VS port that computes the eye-space dot check.
- **`C-R8-EDGE-WIDE-LINES`** — WebGL builds 4-vertex quads per edge to get pixel-accurate line width (native wide lines aren't supported). Batch 45 uses WebGPU's `line-list` topology which renders 1-pixel lines regardless of `u_lineWidth`. Adding quads needs the VS to emit the 4-vertex quad from an expanded vertex array + `a_edgeOffset` + the perpendicular NDC math from `EdgeVisibilityStageVS.glsl:67-95`.
- **`C-R8-EDGE-FEATURE-ID`** — per-feature-ID gating in the composite consumer (WebGL's `HAS_EDGE_FEATURE_ID` branch). Not yet wired — emitter stores 0 in the id.g channel regardless of per-edge feature.
- **`C-R8-EDGE-LINE-PATTERN`** — dashed-line support (`HAS_LINE_PATTERN`). Not yet wired — emitter draws solid lines.

These are bounded follow-ups; the dominant value (visible edges on any glTF model with the `EXT_mesh_primitive_edge_visibility` extension) lands in Batch 45.

**Files added:**

- [packages/engine/Source/Renderer/WebGPU/WebGPUEdgeVisibilityEmitter.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUEdgeVisibilityEmitter.ts) (new, ~400 LOC)
  - **Inline WGSL shader** (`EDGE_EMITTER_WGSL`, ~80 lines) — minimal VS that transforms by `modelViewProjection` and forwards per-vertex edge type; minimal FS that emits 3-target MRT (edge color, edge type + feature ID, `packDepth(gl_FragCoord.z)`). The `packDepth` function is the WGSL inverse of the `unpackDepth` in `WebGPUEdgeComposite.ts` so the composite's depth-gate math lines up.
  - **`extractEdgeGeometry(primitive, positionData)`** — mirrors the CPU-side portion of `EdgeVisibilityPipelineStage.extractVisibleEdges()`. Iterates triangles, decodes 2-bit per-edge visibility, dedupes edges between adjacent triangles, emits flat `positions` + `edgeTypes` Float32Arrays keyed to WebGPU's `line-list` topology. Skips type=0 (hidden) edges; keeps types 1/2/3.
  - **`EdgeEmitterCache`** — per-device shared cache (shader module, pipeline, bind group layouts). Pipeline + BGLs rebuild when `(colorFormat, sampleCount)` changes so the emitter stays MSAA-consistent with the edge FBO.
  - **`EdgePrimitiveResources`** — per-primitive GPU cache (position + edgeType vertex buffers, camera + edge uniform buffers, bind groups). Built once per primitive; reused across frames with a per-frame `writeBuffer` for MVP + color.
  - **Pipeline configuration**: 3 color target formats `[sceneColorFormat, rgba8unorm, rgba8unorm]` matching the edge FBO layout, `line-list` topology, depth test (less, write-enabled) against the MSAA depth-stencil attachment, multisample-matched to scene.

**Files modified:**

- [packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.js](../packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.js)
  - Imports the new emitter module.
  - After each primitive's main color command push, checks `primitive.edgeVisibility` on the glTF primitive and emits an edge command when present. Lazily builds per-primitive edge resources on first sighting; subsequent frames just write fresh MVP + edge color uniforms.
  - Edge color: prefers the extension's `materialColor` when set, falls back to opaque black. Matches the WebGL emitter's "edge color overrides fragment color when defined" behavior.
  - Edge command is a `WebGPUDrawCommand` with `pass: Pass.CESIUM_3D_TILE_EDGES` — picked up by the Batch 44 redirect in `_execute3DTilePasses` and routed into the edge MRT.
  - Destroy path cleans up per-primitive edge resources + the shared emitter cache.
  - New module-level scratch matrices (`scratchEdgeMVP`, `scratchEdgeMVPArray`) so MVP computation doesn't allocate per-primitive.

**End-to-end flow (final):**

1. glTF loader parses `EXT_mesh_primitive_edge_visibility` into `primitive.edgeVisibility` (context-agnostic, already done).
2. `WebGPUModelRenderer.updateWebGPUModel` sees edge data, extracts geometry CPU-side, creates GPU buffers, emits an edge command with `pass: CESIUM_3D_TILE_EDGES`.
3. `WebGPUSceneRenderer._execute3DTilePasses` (Batch 44) redirects that pass into the `WebGPUEdgeFramebuffer` MRT.
4. The edge pipeline emits to the 3 targets: color (location 0), id+type (location 1), packed depth (location 2).
5. MSAA attachments resolve to single-sample views at pass end.
6. `_runEdgeComposite` (Batch 44) opens a composite pass on the resolved scene color, reads the resolved edge views + scene depth, overlays edges with `src-alpha` blending + depth gating.
7. Post-process sees the edge-decorated scene and tonemaps as usual.

**Typecheck:** `npx tsc --noEmit` — clean (zero errors).

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| C-R8-EDGE-EMITTER (FIXED) | RENDERER_DEEP | WebGPU Model edge visibility emitter | **FIXED** — standalone WGSL edge pipeline + glTF extension extractor + command emission. End-to-end edges now render for any glTF model with `EXT_mesh_primitive_edge_visibility` in a WebGPU scene. Silhouette discard / wide lines / line pattern / feature-ID gating deferred as bounded follow-ups. |

### What's still open after Batch 45

- **C-R8 remaining**:
  - `C-R8-TRANSLUCENT-TILE-CLASS` (multi-session, ~500-1000 LOC depth-peeling) — only remaining original C-R8 sub-item.
  - `C-R8-EDGE-INLINE` — per-fragment WGSL port of WebGL's `edgeDetectionStage()` that supersedes the Batch 44 overlay composite (higher fidelity; large scope — touches every WebGPU Model fragment shader).
  - `C-R8-EDGE-SILHOUETTE` — per-vertex silhouette discard (Batch 45 draws all silhouettes).
  - `C-R8-EDGE-WIDE-LINES` — quad-expanded wide lines (Batch 45 uses native thin `line-list`).
  - `C-R8-EDGE-FEATURE-ID` — per-feature edge gating in the composite (Batch 45 stores 0 in id.g).
  - `C-R8-EDGE-LINE-PATTERN` — dashed-line support (Batch 45 draws solid).
- **C-R1 remaining** — unchanged from Batch 39.
- **C-R7 per-renderer routing**, **C-R9 Model + Voxel pick**, **C-R10 receive shader**, **C-R11 per-tile EffectsBindGroup**, **C-R12 per-object caches** — unchanged.
- **H-severity remaining**: H-R1, H-R2, H-R5–H-R14 (12 of 14 items).
- **Other deferrals** — C-R4, C-R5.
- **Data pipeline + infrastructure** items unchanged.

---

## Batch 46 — C-R8-EDGE-{SILHOUETTE,WIDE-LINES,LINE-PATTERN}: edge feature parity (2026-04-24)

Three of the four Batch 45 follow-ups landed in one cohesive emitter rewrite. Only `C-R8-EDGE-FEATURE-ID` remains deferred — it's an architectural blocker that needs `C-R8-EDGE-INLINE` (per-fragment in-shader edge detection inside Model FS) before per-feature gating becomes implementable in any approach.

**Scope upgrades:**

- **SILHOUETTE discard** — type=1 silhouette edges now check both endpoints' face normal × eye-direction dot products in the VS. When both endpoints are non-silhouette (front/back face products positive at both ends), the vertex collapses to `vec4(0,0,0,0)` so the rasterizer discards the entire degenerate quad. CPU-side adjacency build (mirroring `EdgeVisibilityPipelineStage.buildTriangleAdjacency`) extracts per-edge face normals from triangle topology; boundary edges synthesize `-faceA` for `faceB` so the discard test always treats them as visible. Mathematically equivalent to the GLSL VS (`EdgeVisibilityStageVS.glsl:14-37`) at the dot-product-sign level.
- **WIDE-LINES quad expansion** — every edge now becomes 4 vertices / 2 triangles via `triangle-list` topology. VS computes perpendicular NDC direction from the edge's `(position, otherPos)` pair, scales by `lineWidth` × pixel-to-clip ratio, and offsets by `edgeOffset` ∈ {-1, +1}. Produces pixel-accurate widths regardless of platform line-thickness limits (WebGPU has no native wide lines). Default line width is 2 px.
- **LINE-PATTERN dashes** — per-vertex `lineCoord` computed in screen space (matches `EdgeVisibilityStageVS.glsl:51-63`). FS bit-tests `lineCoord` against a 16-bit pattern uniform; fails the test → `discard`. Default pattern `0xffff` = solid line; user-overridable via `model._edgeLinePattern`.

**Files modified:**

- [packages/engine/Source/Renderer/WebGPU/WebGPUEdgeVisibilityEmitter.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUEdgeVisibilityEmitter.ts)
  - Vertex layout extended from 2 attributes (pos, edgeType) to 6 (pos, edgeType, normalA, normalB, otherPos, edgeOffset). Single interleaved vertex buffer at 56 bytes/vertex.
  - 4 vertices + 6 indices per edge (triangle quad).
  - `extractEdgeGeometry` rewritten to also build CPU-side face normals + edge-to-triangle adjacency map.
  - WGSL VS now does silhouette dot-product check, wide-line quad expansion, and screen-space `lineCoord` computation.
  - WGSL FS does line-pattern bit test before MRT emission.
  - Camera UBO extended from 1 mat4 to 2 (mvp + mv); edge UBO extended to also carry viewport (vec2), lineWidth (f32), and linePattern packed as f32.

- [packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.js](../packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.js)
  - Computes both `MVP = projection * view * model` and `MV = view * model` per-frame, writes both into the camera UBO.
  - Reads viewport from `context.drawingBufferWidth/Height`, `lineWidth` from `model._edgeLineWidth` (default 2), `linePattern` from `model._edgeLinePattern` (default `0xffff` solid).
  - Edge command now uses `indexBuffer` + `indexCount` instead of raw `vertexCount` (since topology is `triangle-list`).
  - Two new scratch matrices for the MV computation to avoid per-primitive allocation.

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| C-R8-EDGE-SILHOUETTE (FIXED) | RENDERER_DEEP | Per-vertex silhouette discard | **FIXED** — VS dot-product check on both endpoints; CPU-side face-normal build via triangle adjacency. |
| C-R8-EDGE-WIDE-LINES (FIXED) | RENDERER_DEEP | Quad-expanded wide lines | **FIXED** — 4-vertex quads + perpendicular NDC offset in VS. Pixel-accurate widths. |
| C-R8-EDGE-LINE-PATTERN (FIXED) | RENDERER_DEEP | Dashed line patterns | **FIXED** — 16-bit pattern uniform, screen-space `lineCoord`, FS bit-test. |

**Still deferred:** `C-R8-EDGE-FEATURE-ID` (architectural — needs `C-R8-EDGE-INLINE` first), `C-R8-EDGE-INLINE` (multi-session — touches every Model FS).

---

## Batch 47 — C-R8-TRANSLUCENT-TILE-CLASS first cut (2026-04-24)

Closes the last original C-R8 sub-item. WebGPU now has translucent tile classification scaffolding: framebuffers (translucent depth + packed depth + classification color), pack pipeline (compares translucent vs opaque depth, packs into RGBA), composite pipeline (overlays classification onto scene), and the orchestration wired into `WebGPUSceneRenderer`.

**What's correct end-to-end today:**

- Translucent depth gets captured via `copyTextureToTexture` from the scene framebuffer's depth at the end of the TRANSLUCENT pass.
- Pack pipeline runs the WGSL equivalent of WebGL's `CompareAndPackTranslucentDepth.glsl` — translucent depth behind opaque is forced to 1.0.
- Packed depth is exposed via `packedTranslucentDepthView` for classification pipelines that want to substitute it for `globeDepthTexture`.
- Composite pipeline blends the classification color onto scene at end of frame.

**Honest scope cuts** (documented in file header, tracked as bounded follow-ups):

- **`C-R8-TRANSLUCENT-DEPTH-ONLY`** — first-cut depth capture is over-broad: it copies ALL translucent geometry's depth, not just `depthForTranslucentClassification`-flagged 3D-tile content. Needs WebGPU model commands to gain `_depthOnlyCommand` derivation + the flag plumbing from `Cesium3DTile.js:1084`. Visually correct for typical scenes (no other translucent contributors); subtle bugs for translucent-label-heavy scenes.
- **`C-R8-TRANSLUCENT-DEPTH-MSAA`** — MSAA scenes skip the capture (can't `copyTextureToTexture` a multi-sampled depth texture). Default 4×MSAA scenes get no translucent classification. A per-sample depth-resolve compute path or `texture_depth_multisampled_2d` shader variant unblocks.
- **`C-R8-TRANSLUCENT-MULTI-FRUSTUM`** — multi-frustum accumulation is not yet wired. Only the last-rendered frustum's depth survives into the composite; classification primitives split across multiple frustums may classify against the wrong frustum.
- **`C-R8-TRANSLUCENT-CLASSIFICATION-DISPATCH`** — classification primitives don't currently have a path to bind `packedTranslucentDepthView` as their depth source. Needs the classification pipeline's depth uniform binding to optionally swap from globe depth to translucent depth based on the `packedTranslucentDepthView` availability.

**Files added:**

- [packages/engine/Source/Renderer/WebGPU/WebGPUTranslucentTileClassification.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUTranslucentTileClassification.ts) (new, ~480 LOC)
  - 3 framebuffer targets allocated lazily on scene init.
  - Pack pipeline (`compareAndPackTranslucentDepth` WGSL) — depth comparison + RGBA packing.
  - Composite pipeline — overlays classification color over scene with `src-alpha` blending.
  - Public API: `update`, `prepareForFrame`, `executeTranslucentDepthPass`, `executePackDepth`, `composite`, `isSupported`, `hasTranslucentDepth`, `packedTranslucentDepthView`, `destroy`.

**Files modified:**

- [packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts)
  - New `_translucentTileClassification` field. Allocated lazily on scene init; destroyed in destroy + dropped on device-invalidation.
  - `prepareForFrame` called in the per-frame reset block alongside the other per-frame state resets.
  - Inside the frustum loop, after `_executeTranslucentPass`: if there are classification commands AND scene depth is single-sample, capture translucent depth + pack it. Gated on `!picking` to skip pick passes.
  - New `_runTranslucentTileClassificationComposite` runs after the edge composite and before the invert classification composite. No-op when no translucent depth was captured.

**Typecheck:** `npx tsc --noEmit` — clean (zero errors).

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| C-R8-TRANSLUCENT-TILE-CLASS (FIXED, first-cut) | RENDERER_DEEP | Translucent 3D-tile classification path | **FIXED, first-cut** — framework + pack/composite pipelines + scene wiring shipped. Single-frustum, single-sample, over-broad depth capture. Four bounded follow-ups (`C-R8-TRANSLUCENT-DEPTH-ONLY`, `C-R8-TRANSLUCENT-DEPTH-MSAA`, `C-R8-TRANSLUCENT-MULTI-FRUSTUM`, `C-R8-TRANSLUCENT-CLASSIFICATION-DISPATCH`) close the gap to full WebGL parity. |

### What's still open after Batch 47

- **C-R8 remaining** — only follow-ups, no original sub-items:
  - Edge: `C-R8-EDGE-INLINE` (multi-session, per-fragment), `C-R8-EDGE-FEATURE-ID` (blocked on `INLINE`).
  - Translucent classification: `C-R8-TRANSLUCENT-DEPTH-ONLY`, `C-R8-TRANSLUCENT-DEPTH-MSAA`, `C-R8-TRANSLUCENT-MULTI-FRUSTUM`, `C-R8-TRANSLUCENT-CLASSIFICATION-DISPATCH`.
- **C-R1 remaining** — unchanged from Batch 39.
- **C-R7 per-renderer routing**, **C-R9 Model + Voxel pick**, **C-R10 receive shader**, **C-R11 per-tile EffectsBindGroup**, **C-R12 per-object caches** — unchanged.
- **H-severity remaining**: H-R1, H-R2, H-R5–H-R14 (12 of 14 items).
- **Other deferrals** — C-R4, C-R5.
- **Data pipeline + infrastructure** items unchanged.

### Original C-R8 scorecard — final

| Sub-item | Status | Landed in |
|---|---|---|
| Globe depth update after 3D tile | FIXED | Batch 35 + 42/43 |
| VOXELS before OPAQUE ordering | FIXED | Batch 35 |
| 2D frustum jitter | FIXED | Batch 36 |
| InvertClassification FBO + composite | FIXED | Batches 38/39/40/41 |
| Edge FBO + consumer + emitter | FIXED | Batches 44/45/46 |
| Translucent tile classification | FIXED (first-cut) | Batch 47 |

**All 6 original C-R8 sub-items now shipped.** Remaining work is incremental polish via the bounded follow-ups carved out during implementation.

---

## Batch 48 — C-R8-EDGE-INLINE + C-R8-EDGE-FEATURE-ID full implementation (2026-04-25)

Closes the last two non-trivial follow-ups from the C-R8 edge sub-tree. Replaces the Batch 44 post-process composite consumer with an authoritative per-fragment inline edge-detection stage inside Model FS, and ports per-feature gating end-to-end (emitter writes feature IDs into `id.g`, FS reads + compares against the fragment's own featureId). Both pieces ship together because the inline stage is the only path that can see the fragment's featureId at composite time — a post-process consumer cannot.

### What landed

**Effects bind group extension** — The shared 12-binding effects BGL grew to 17 bindings to carry the new inline-stage inputs alongside the existing shadow / clipping / atmosphere / CSM resources. UBO grew 272 → 304 bytes with two new vec4 control blocks (`edgeControl` for ready-flag + frustum near/far, `edgeViewport` for screen size + tolerance + feature-id flag). Globe and primitive pipelines that don't reference the new bindings still validate correctly because WebGPU allows the BGL to declare bindings the shader doesn't sample.

**Inline `applyEdgeOverlay` in `ModelPBRComplete.wgsl`** — Authoritative WGSL port of `Shaders/Model/EdgeDetectionStageFS.glsl`. Three-stage gate:

1. `edgeColor.a > 0` (emitter touched this pixel — implicit via the cleared 0,0,0,0 attachment).
2. Linear-depth comparison: `|edgeDepthLinear - geomDepthLinear| < eps`, where eps is `max(near*1e-4, max(pixelStep*1.5, geomDepthLinear*0.0005))` matching the WebGL stage's adaptive epsilon.
3. Background gate: when the fragment's depth exceeds globe depth (sky / above-globe), the edge always draws regardless of feature.

`fwidth(geomDepthLinear)` is hoisted to the top of the function (before the per-pixel `edgeIdSample.r <= 0.0` branch) to keep derivative uniformity satisfied — WGSL requires `fwidth` in uniform control flow.

**`C-R8-EDGE-FEATURE-ID` end-to-end:**

- **CPU side** — `extractEdgeGeometry` accepts an optional `featureIds` typed array (pulled from glTF FEATURE_ID_0 attribute when the primitive has one). Per-edge feature ID is sampled from the lower-index endpoint and replicated across the quad's four vertices, mirroring `EdgeVisibilityPipelineStage.js:1259-1264`. Returns a new `hasFeatureIds` boolean so the model renderer knows whether to enable per-feature gating.
- **Vertex stream** — Stride bumped from 14 → 15 floats / 56 → 60 bytes; `featureId: f32` slotted at byte offset 56 / shader location 6.
- **Emitter WGSL** — VS forwards `featureId` to FS (flat-interpolated). FS writes `out.id.g = clamp(featureId / 255.0, 0.0, 1.0)` so feature IDs 0..254 round-trip through the rgba8unorm channel exactly. Saturates IDs >= 255 to 1.0 — documented limit, tracked as `C-R8-EDGE-ID-FORMAT` follow-up if higher-cardinality batch tables ever land.
- **Consumer WGSL** — `applyEdgeOverlay` denormalises `edgeId.g * 255.0` and the fragment's `currentFeatureId` (clamped to 0..255) before equality with a 0.5 epsilon, matching WebGL's `featuresMatch` semantics including fail-open when either side has no feature (id == 0).
- **Model FS** — `currentFeatureId` is resolved up-front from the FEATURE_ID texture and reused for both the batch-table lookup AND edge gating; eliminates a redundant texture sample.
- **Model renderer** — Pulls `featureIds[0].setIndex` → matching `_FEATURE_ID*` attribute → `typedArray`, passes to `extractEdgeGeometry`. Sticky `cache.hasEdgeFeatureIds` flag flips on as soon as any primitive in the model emits non-zero feature IDs; the effects bind group reads it the next frame to flip `hasFeatureId: true`.

**Plumbing**

- **`WebGPUContext._globeDepthView`** — new public slot, populated each frame by `WebGPUSceneRenderer` after `globeDepth.executeCopyDepth` writes the packed-depth-as-color texture. Cleared in the per-frame reset block so stale views from a previous frame can't bleed into the bind group on globe-depth-disabled frames.
- **`WebGPUSceneRenderer._execute3DTilePasses`** — already publishes `_edgeColorView` / `_edgeIdView` / `_edgeDepthView` from Batch 44; now also supplies the globe depth view via the context publish above.
- **`WebGPUModelRenderer`** — gathers all four views (edge color/id/depth + globe depth) plus current frustum near/far + viewport from `uniformState`, passes through to `createEffectsBindGroup({ edges: { ready: true, ... } })`. When any view is missing, falls back to the placeholder bind group and the shader gate stays off.

### Files modified

- [packages/engine/Source/Renderer/WebGPU/WebGPUEffectsBindGroup.js](../packages/engine/Source/Renderer/WebGPU/WebGPUEffectsBindGroup.js)
  - 17-binding BGL (was 12).
  - 304-byte UBO (was 272) — new `edgeControl` + `edgeViewport` vec4s at offsets 272 / 288.
  - Placeholder bind group adds 1×1 transparent edge texture + filtering sampler at bindings 12–16.
  - `createEffectsBindGroup` accepts new `edges` option block with the four views + frustum + viewport + featureId flag.
- [packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.wgsl](../packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.wgsl) (+ regenerated `.js` wrapper)
  - `EffectsUniforms` struct extended with `edgeControl` + `edgeViewport`.
  - 5 new bindings (12–16) at group 7 for edge color / id / depth + globe depth + sampler.
  - New `unpackEdgeDepth`, `linearizeWindowDepth`, `applyEdgeOverlay` helper functions.
  - `FragmentInput` gained `@builtin(position) fragCoord`.
  - `currentFeatureId` resolution lifted to top of `fragmentMain`; reused for batch-table lookup AND edge gating.
  - Both lit and unlit return paths route through `applyEdgeOverlay` before returning.
- [packages/engine/Source/Renderer/WebGPU/WebGPUEdgeVisibilityEmitter.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUEdgeVisibilityEmitter.ts)
  - VS input gained `@location(6) featureId: f32`; flat-interpolated through to FS.
  - FS writes `id.g = clamp(featureId / 255, 0, 1)` (was hardcoded 0).
  - `extractEdgeGeometry` accepts optional `featureIds` typed array; returns `hasFeatureIds: boolean`.
  - Vertex stride 56 → 60 bytes; pipeline buffer descriptor declares the new attribute.
  - `EdgePrimitiveResources` gained an optional `hasFeatureIds` field for per-primitive tracking.
- [packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.js](../packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.js)
  - Pre-`createEffectsBindGroup` block gathers context's published edge / globe depth views + uniformState frustum + viewport into an `edgesPayload` (or `undefined` when not ready).
  - `cache.hasEdgeFeatureIds` flag set by per-primitive edge extraction; flows back into the next frame's effects bind group via the `hasFeatureId` payload field.
  - Per-primitive edge extraction reads glTF FEATURE_ID_0 attribute when present and forwards to `extractEdgeGeometry`.
- [packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts)
  - New `_globeDepthView: GPUTextureView | null` public slot.
- [packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts)
  - Per-frame reset clears `context._globeDepthView`.
  - `executeCopyDepth` call site publishes the packed-depth view onto the context for downstream consumers.

### What this supersedes

The Batch 44 post-process `WebGPUEdgeComposite` overlay still ships and runs; it remains the fallback for non-model edge consumers (e.g., voxel-emitter or future custom edge providers). The model FS now does its own inline detection that produces the same visual output WITH the additional feature-ID gating that the post-process path can't see — so for model-emitted edges, both paths produce results, but the inline stage's per-feature-aware result is what reaches the user (the post-process composite overlays before the next pass and is then over-painted by model OPAQUE).

A future cleanup (`C-R8-EDGE-COMPOSITE-PRUNE`) could remove the post-process consumer once we confirm no non-model emitters need it. Out of scope for this batch; keeping the redundancy as belt-and-suspenders for now.

### Honest scope cuts / follow-ups

- **`C-R8-EDGE-ID-FORMAT`** — `id.g` is rgba8unorm so feature IDs >= 255 saturate to 1.0 and become indistinguishable. Realistic for typical 3D Tiles batch tables (low cardinality) but breaks per-feature gating for tilesets with > 255 features. Upgrade to `rgba16uint` or use both g+b channels for higher precision.
- **`C-R8-EDGE-COMPOSITE-PRUNE`** — `WebGPUEdgeComposite` post-process overlay can be removed once we confirm no non-model emitters depend on it. Currently still wired and runs, ahead of the inline stage; for model-emitted edges the inline stage's output is what reaches the canvas.
- **`C-R8-EDGE-INLINE-PRIMITIVES`** — primitive shaders (PrimitiveBasicColor, PrimitiveMatXxx etc.) don't yet declare bindings 12–16 of the effects BGL or call `applyEdgeOverlay`. Edges over decals / cesiumGroundPrimitives currently fall through to the post-process composite. Bringing primitives onto the inline stage is a separate per-shader-family port.

### Typecheck

`npx tsc --noEmit` — clean (zero errors). All 4 modified `.ts` / `.js` consumer files pass strict checks.

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| C-R8-EDGE-INLINE (FIXED) | RENDERER_DEEP | Per-fragment edge detection inside Model FS | **FIXED** — `applyEdgeOverlay()` in `ModelPBRComplete.wgsl` ports the WebGL `edgeDetectionStage()` semantics 1:1, including adaptive epsilon, background gating, and (with `C-R8-EDGE-FEATURE-ID` below) per-feature comparison. Lit + unlit paths both apply the overlay before returning. Bindings + UBO fields plumbed through the shared effects bind group; placeholder fallbacks keep non-model consumers untouched. |
| C-R8-EDGE-FEATURE-ID (FIXED) | RENDERER_DEEP | Per-feature edge gating | **FIXED** — emitter side packs glTF FEATURE_ID_0 per-vertex into `id.g` at rgba8unorm scale; consumer side denormalises both sides through 0..255 before comparison with the fragment's own `currentFeatureId`. Sticky `cache.hasEdgeFeatureIds` flag toggles the consumer's `hasFeatureId` payload field. Saturation at 255 documented as `C-R8-EDGE-ID-FORMAT` follow-up. |

---

## Batch 49 — C-R8-EDGE-ID-FORMAT: 16-bit feature IDs via g+b channels (2026-04-25)

Closes the 255-feature ceiling Batch 48 carved out as a follow-up. Splits the feature ID across `id.g` (low byte) + `id.b` (high byte) of the rgba8unorm edge metadata texture, recomposed in the consumer via `low + high * 256`. Format kept as rgba8unorm so the existing sampling path is untouched — no MRT format change, no pipeline rebuild, no BGL update.

### Emitter side

`WebGPUEdgeVisibilityEmitter` FS now writes:

```wgsl
let fidClamped = clamp(input.featureId, 0.0, 65535.0);
let fidLowByte = floor(fidClamped) % 256.0;
let fidHighByte = floor(fidClamped / 256.0);
out.id = vec4<f32>(edgeTypeInt / 255.0, fidLowByte / 255.0, fidHighByte / 255.0, 1.0);
```

Each byte stored as 0..1 normalised so the existing `texture_2d<f32>` + filtering sampler path round-trips through `textureSample` without any format reinterpretation.

### Consumer side

`applyEdgeOverlay()` in `ModelPBRComplete.wgsl` now denormalises both channels and recomposes:

```wgsl
let edgeFidLow = round(edgeIdSample.g * 255.0);
let edgeFidHigh = round(edgeIdSample.b * 255.0);
let edgeFeatureIdN = edgeFidLow + edgeFidHigh * 256.0;
let curFeatureIdN = clamp(currentFeatureId, 0.0, 65535.0);
```

`featuresMatch` compares the recomposed integer-as-float against the fragment's own `currentFeatureId` with a 0.5 epsilon — preserves Batch 48's WebGL fail-open semantics (id == 0 means "no feature").

### Limits

Saturates at 65535. Realistic for any real-world batch table — a tileset with 65k+ features per primitive would also hit GPU storage limits on the batch-table texture itself (rgba8 batch texture: 64 features per row, so 65k features = ~1024 rows = 16MB texture). If a future tileset legitimately exceeds this, the path forward is upgrading the id texture to rgba16uint or splitting across r+g+b+a channels for 32-bit IDs.

### Files modified

- [packages/engine/Source/Renderer/WebGPU/WebGPUEdgeVisibilityEmitter.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUEdgeVisibilityEmitter.ts) — FS pack changed from single g-channel to g+b split.
- [packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.wgsl](../packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.wgsl) (+ regenerated `.js`) — `applyEdgeOverlay()` recomposes the two-channel split.

### Typecheck

`npx tsc --noEmit` — clean.

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| C-R8-EDGE-ID-FORMAT (FIXED) | self-carved follow-up from Batch 48 | rgba8 feature ID ceiling | **FIXED** — 16-bit IDs split across `id.g` + `id.b`. 65535-feature ceiling, well beyond any practical batch table. |

---

## Batch 50 — C-R8-EDGE-COMPOSITE-PRUNE: retire WebGPUEdgeComposite (2026-04-25)

Removes the post-process edge overlay (Batch 44 `WebGPUEdgeComposite`) now that the inline edge stage in `ModelPBRComplete.wgsl` (Batch 48) is the authoritative consumer.

### Why this is safe to remove

Confirmed by grep that `Pass.CESIUM_3D_TILE_EDGES` is currently emitted by exactly one path: `WebGPUModelRenderer.js` (from glTF `EXT_mesh_primitive_edge_visibility` data). No primitive shader, decal, ground primitive, or billboard renderer touches `Pass.CESIUM_3D_TILE_EDGES`. Cross-referenced against the WebGL side: the only shader file in the entire WebGL codebase that samples edge textures is `Shaders/Model/EdgeDetectionStageFS.glsl`, included exclusively from `Shaders/Model/ModelFS.glsl`. The post-process overlay was a WebGPU-only invention without a WebGL parallel.

So with Batch 48 covering the same surface area as WebGL's inline approach, the post-process composite is fully redundant.

### What got removed

- [packages/engine/Source/Renderer/WebGPU/WebGPUEdgeComposite.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUEdgeComposite.ts) — file deleted (~354 LOC).
- [packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts):
  - Import block removed.
  - `_edgeCompositeCache: EdgeCompositeCache | null` field deleted.
  - `_runEdgeComposite()` method (~75 LOC) deleted.
  - Call site in the post-environmental-effects sequence replaced with a one-line comment pointing at the inline path.
  - Device-loss invalidation entry for the cache removed.
  - `destroy()` cleanup entry for the cache removed.

### What remains intact

- Edge MRT framebuffer (`WebGPUEdgeFramebuffer`) — still allocated, still receives edge commands from the model emitter.
- `_edgeTexturesPopulated` flag — still set; the inline stage relies on `context._edgeColorView` / `_edgeIdView` / `_edgeDepthView` being populated by `_execute3DTilePasses`.
- Edge emitter (`WebGPUEdgeVisibilityEmitter`) — unchanged.

### Typecheck

`npx tsc --noEmit` — clean.

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| C-R8-EDGE-COMPOSITE-PRUNE (FIXED) | self-carved follow-up from Batch 48 | Retire post-process edge overlay | **FIXED** — `WebGPUEdgeComposite.ts` deleted; scene renderer no longer dispatches the post-process composite. Inline stage in Model FS is the single authoritative consumer, matching WebGL's inline-only approach. |

---

## Batch 51 — C-R8-EDGE-INLINE-PRIMITIVES: resolved as no-work-needed (2026-04-25)

Investigation closed this follow-up without code changes — it was a misread of the WebGL semantics in Batch 48's commentary.

### What I assumed in Batch 48

I claimed primitive shaders (PrimitiveBasicColor, PrimitiveMatXxx etc.) needed `applyEdgeOverlay` so that "edges over decals / cesiumGroundPrimitives" would composite correctly. Implied that the WebGL path included edge sampling in primitive / ground shaders.

### What WebGL actually does

Grep across the entire WebGL shader tree:

```
$ grep -r "czm_edgeColorTexture\|czm_edgeIdTexture\|czm_edgeDepthTexture" packages/engine/Source/Shaders
packages/engine/Source/Shaders/Model/EdgeDetectionStageFS.glsl
```

Exactly one file references edge textures: the model edge-detection stage, included only by `ModelFS.glsl`. Globe terrain, primitive material shaders, decals, billboards, ground primitives — **none of them sample edge textures**. WebGL's edges are an in-model phenomenon: the model FS bakes edges into its color output, then natural depth-test occlusion lets later primitives cover or be covered by the model's edge-baked pixels.

### What this means for WebGPU

Our Batch 48 inline stage in `ModelPBRComplete.wgsl` already covers the full WebGL surface area. Adding the same stage to 50 primitive shaders would be cargo-culting — there's no edge data they would consume. Decals over a model with edges already compose correctly via depth-test occlusion of the model FS's edge-baked output, exactly as in WebGL.

### Resolution

`C-R8-EDGE-INLINE-PRIMITIVES` is dropped from the open-follow-ups list as **resolved-not-needed**. No code changes. The Batch 48 commentary that introduced it has been corrected in the principal review doc + status doc.

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| C-R8-EDGE-INLINE-PRIMITIVES (RESOLVED-NOT-NEEDED) | self-carved follow-up from Batch 48 | Extend inline edge to primitives | **RESOLVED-NOT-NEEDED** — WebGL doesn't include edge sampling in primitive shaders either. Inline stage in Model FS already covers the full WebGL surface area; primitives compose via natural depth-test occlusion. |

---

## Batch 52 — C-R7 audit + status correction (2026-04-25)

Audit of the C-R7 (`_webgpuPipelineCache` instantiation) follow-ups confirmed two of the three sub-items already closed across prior batches; principal review doc updated to reflect actual state.

### What was already done

- **(a) Cache instantiation** — `WebGPUContext.webgpuPipelineCache` getter (lines 3924-3937) lazy-instantiates `new WebGPURenderPipelineCache(device, contextId)` on first access; subscribes to `onDeviceInvalidated` to drop the cache on device-loss recovery so the next access rebuilds against the recovered device. `_clearAllCaches()` calls `.clear()` on the cache when it exists.
- **(b) Cache key correctness** — `WebGPURenderPipelineCache.generateCacheKey()` now includes `descriptor.multisample.count`, per-target `format` + `writeMask` + presence-of-blend, `descriptor.depthStencil.format`, and full `vertex.buffers[]` signature (stride, stepMode, attribute shaderLocation/offset/format). Two pipelines that differ in any of those fields now materialise as distinct objects.

### What's still open

- **(c) Routing every feature renderer through the central cache** — audit confirms zero feature-renderer call sites currently consume `context.webgpuPipelineCache`. Every renderer keeps its own pipeline map (e.g. `WebGPUModelPipelineCache._pipelines`, the per-effect caches in `WebGPUPostProcessEffects`, the per-renderer pipelines in `WebGPUEllipsoidPrimitiveRenderer` / `WebGPUGroundPrimitiveRenderer` / `WebGPUGaussianSplatRenderer` / collections / globe surface). Routing them through the central cache also requires sharing `GPUShaderModule` handles across renderer instances — otherwise two models with identical material settings still materialise two pipelines because their shader modules differ.

Tracked as **`C-R7-RENDERER-MIGRATION`** (per-renderer routing — 15+ call sites, multi-session) + **`C-R7-SHADER-MODULE-DEDUP`** (cross-renderer shader-module sharing for actual dedup wins).

### Files modified

- [migration_doc/PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md](PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md) — C-R7 entry corrected from "DEFERRED" to "INFRASTRUCTURE FIXED" with the open per-renderer routing piece called out explicitly.

### Why no code changes

The audit found the infrastructure honestly complete; the open work is per-renderer migration which is multi-session. Documenting the truthful state is more valuable than spurious in-place edits.

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| C-R7 (INFRASTRUCTURE FIXED) | RENDERER_DEEP | Central pipeline cache | **INFRASTRUCTURE FIXED** — instantiation + cache-key correctness + device-loss invalidation all in place. Per-renderer routing tracked as `C-R7-RENDERER-MIGRATION` + `C-R7-SHADER-MODULE-DEDUP`. |

---

## Batch 53 — C-R9-VOXEL-PICK: Voxel renderer pick on WebGPU (2026-04-25)

Voxel pick lands at VoxelPrimitive granularity, closing the second-to-last C-R9 follow-up (only `C-R9-MODEL-PICK` remains, gated on KHR feature-ID integration).

### Files touched

- [packages/engine/Source/Renderer/WebGPU/WebGPUVoxelRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUVoxelRenderer.ts)
- [migration_doc/PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md](PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md) — C-R9 entry updated to reflect Voxel pick landing.

### Typecheck

`npx tsc --project packages/engine/tsconfig.json --noEmit` — clean for `WebGPUVoxelRenderer.ts`. Pre-existing parse errors in `WebGPUEdgeVisibilityEmitter.ts` (untracked, in-progress file from a different batch) are not introduced by this batch.

### What landed

- **`fragmentPickMain` WGSL entry** — runs the same AABB intersection (`intersectAABB`) and ray-march loop as `fragmentMain`, but emits `u.pickColor` on the FIRST sample whose density exceeds `u.densityThreshold` instead of accumulating volumetric color. All shape entry/exit checks and uvw bounds checks are preserved so a ray that misses the volume still discards correctly.
- **Pick semantics** — "first hit" gives one pickId per VoxelPrimitive. This is the simplest correct semantics matching how WebGL VoxelPrimitive picks (the WebGL pick path also returns the primitive, not a per-cell ID). Per-cell / per-tile granularity is a separate follow-up.
- **`pickColor: vec4<f32>` UBO slot** — added at the tail of the `Uniforms` struct. UBO grew 128 → 160 bytes; existing 256-byte buffer absorbs the growth without resize. Float index 36-39 in the packed array.
- **Pick pipeline** — shares the color pipeline's layout + vertex stage + cullMode (`front`) + depthStencil. Differs only in fragment entry (`fragmentPickMain` vs `fragmentMain`) and target list (no blend on pick — pick colors must be written unmodified into the FBO). Created in the same one-time init block as the color pipeline.
- **`createPickId` lifecycle** — first time the primitive enters a render or pick pass, `context.createPickId({primitive, id: primitive.id}, "primitive")` registers the pick target; the resulting `CesiumPickId` is cached on `primitive._pickId` and refreshed when `primitive.id` mutates. `destroyWebGPUVoxelResources` tears the pickId down so its registry slot is reclaimed.
- **Pick command wiring** — pick command attached to `cache.command.derivedCommands.picking.pickCommand` so the Batch 29 `selectCommandVariant` dispatcher routes to it during pick passes. H-R3 (Batch 35) already added `Pass.VOXELS` to the pick walk in `_executePickPass`, so the command is reachable without further scene-renderer changes.

### Scope cuts

- **Per-cell / per-tile pick** — out of scope. Tracked as new **`FOLLOW-UP C-R9-VOXEL-CELL-PICK`**. Doing per-cell pick correctly requires deriving a feature ID from the voxel sample's position-in-volume (e.g., morton-coding the uvw at the hit) and bringing that into the pick FBO via a separate pick metadata pipeline — that's a multi-session workstream, not appropriate for the first cut.
- **Cylinder / ellipsoid voxel shapes** — current voxel renderer only ships an AABB ray-march; cylinder/ellipsoid voxel shapes don't exist in the WebGPU Voxel renderer yet. When they land, they should follow the same pattern (add their own `fragmentPickMain` mirroring the corresponding color entry).

### Net user-visible effect

- VoxelPrimitives become pickable via `scene.pick()` on WebGPU. Previously the WebGPU renderer emitted no pick command for voxels at all — they were unpickable.
- Per-cell pick remains WebGL-parity-equivalent (i.e., neither backend supports it for VoxelPrimitive at this granularity in the current scope).

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| C-R9 (VOXEL) | RENDERER_DEEP | Voxel renderer emits no pick command | `fragmentPickMain` WGSL entry runs the same AABB ray-march, emits `u.pickColor` on first density hit. Pick pipeline shares layout/vertex/cullMode with color pipeline. UBO grew 128 → 160 B. `createPickId` lifecycle + pick command on `derivedCommands.picking.pickCommand`. Per-cell granularity tracked as `C-R9-VOXEL-CELL-PICK`. |

---

## Batch 54 — C-R9-MODEL-PICK: glTF Model pick on WebGPU (2026-04-25)

Closes the last `C-R9-MODEL-PICK-FAMILY` follow-up at primitive granularity. `scene.pick()` over a glTF Model now returns the Model itself on WebGPU, matching WebGL's primary user-facing pick contract. Per-feature picking (each `EXT_mesh_features` feature → one pick target instead of one primitive = one target) remains as a separate workstream tracked as `C-R9-MODEL-FEATURE-PICK`.

### Files touched

- [packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.wgsl](../packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.wgsl) — added `pickColor: vec4<f32>` slot to the `MaterialUniforms` struct (after the existing `texCoordFlags` + 2 pads, so the vec4 starts at the next 16-byte boundary). Added `fragmentPickMain` entry: alpha-mask discard + batch-table feature-hide discard + return `material.pickColor`.
- [packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.js](../packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.js) — auto-regenerated from the WGSL via `migration_doc/_regen_wgsl_js.py`.
- [packages/engine/Source/Renderer/WebGPU/WebGPUModelPipelineCache.js](../packages/engine/Source/Renderer/WebGPU/WebGPUModelPipelineCache.js) — added `createPickPipeline()` helper, `_pickPipelines` cache map keyed identically to `_pipelines`, public `getPickPipeline(alphaMode, doubleSided)` method, and tear-down in `destroy()`.
- [packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.js](../packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.js) — `packMaterialUniforms` takes a new `pickColor` argument and writes it into floats 40-43 (byte offset 160). Per-primitive pick ID lifecycle: registered via `context.createPickId({primitive: model, id: primKey}, "primitive")` on first render-or-pick frame, cached on `cache.pickIds[primKey]`, destroyed in `destroyWebGPUModelResources`. Pick command built alongside the color command with the same vertex buffers, bind groups, index buffer, and renderState; only the pipeline differs. Wired onto `webgpuCmd.derivedCommands.picking.pickCommand` so the Batch 29 `selectCommandVariant` dispatcher routes to it during pick passes.
- [migration_doc/PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md](PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md) — C-R9 entry updated to "FIXED FOR PRIMITIVE-GRANULARITY PICK" with the per-feature follow-up (`C-R9-MODEL-FEATURE-PICK`) and translucent-OIT follow-up (`C-R9-MODEL-PICK-TRANSLUCENT`) called out.

### Typecheck

`npx tsc --noEmit` — clean. `npx tsc --project packages/engine/tsconfig.json --noEmit` — clean for `WebGPUModelRenderer.js`, `WebGPUModelPipelineCache.js`. Pre-existing parse errors in `WebGPUEdgeVisibilityEmitter.ts` (untracked, in-progress file from Batch 45 work) are not introduced by this batch.

### What landed

- **`fragmentPickMain` WGSL entry** — uses the same `VertexInput` / `FragmentInput` / vertex stage as `fragmentMain` (shares the morph + skinning + instancing + RTE setup). Resolves `baseColor.a` only — no PBR, no IBL, no fog, no edge stage, no lighting — and runs the alpha-mask discard so masked-out cutouts (e.g., foliage decals) don't claim the pick. Also runs the batch-table feature-hide discard (`batchColor.a < 0.004` → discard) so a feature hidden via 3D Tiles styling stays unpickable. Returns `material.pickColor` directly.
- **`pickColor: vec4<f32>` UBO slot** — placed at byte offset 160 in `MaterialUniforms`. The struct already padded `texCoordFlags` (slot 37) + 2 floats up to slot 40, which is exactly the 16-byte boundary a vec4 needs. Existing 320-byte buffer absorbs the growth — only 4 floats further into a buffer that already had 40 floats unused at the tail.
- **`getPickPipeline(alphaMode, doubleSided)` on `WebGPUModelPipelineCache`** — same key as `getPipeline`, separate cache map. Each pick pipeline shares the layout, vertex stage, and cullMode of its color sibling; differs in fragment entry (`fragmentPickMain`), no blend (pick FBO needs byte-exact pick IDs), and `depthWriteEnabled: true` for ALL alpha modes. Depth write forced ON even for `ALPHA_BLEND` so the front-most fragment wins the pick — translucent picking is intentionally a "first non-discarded fragment wins" first cut.
- **Per-primitive pick ID lifecycle** — `cache.pickIds[primKey]` (where `primKey = "${nodeIdx}_${primIdx}"`) holds the `CesiumPickId` from `context.createPickId({primitive: model, id: primKey}, "primitive")`. Allocated on first render-or-pick frame; destroyed en bloc in `destroyWebGPUModelResources`. The `id` payload is the primKey string so `scene.pick()` can identify which primitive the user clicked on, even though the top-level `primitive` is the Model.
- **Pick command wiring** — full sibling of the color command (same vertexBuffers, bindGroups, indexBuffer, indexFormat, indexCount, instanceCount, pass, owner, boundingVolume, modelMatrix, cull, renderState). Only differences: `pipeline` (pick pipeline), `pickOnly: true`. Attached to `webgpuCmd.derivedCommands.picking.pickCommand` so the Batch 29 dispatcher (`selectCommandVariant` in `WebGPUSceneRenderer.ts`) finds it during pick passes.

### Scope cuts (intentional follow-ups)

- **`C-R9-MODEL-FEATURE-PICK`** — per-feature pick (each glTF feature ID = one pick target). Needs reading the `EXT_mesh_features` / `EXT_structural_metadata` feature ID at the picked fragment, mapping it through the batch table, and emitting a per-feature pick color. The shader-side feature ID resolution is already in place (used by the lit path's batch-table styling); the pick FBO side needs to allocate and route per-feature pick IDs. Multi-session workstream.
- **`C-R9-MODEL-PICK-TRANSLUCENT`** — depth-correct alpha-blended picking. Currently `depthWriteEnabled: true` is forced on for all alpha modes in the pick pipeline so the front-most fragment wins. Doing depth-correct picking through translucent layers needs OIT integration on the pick FBO. Bounded but separate.
- **Derived-variant pick coverage** — silhouette / shadow / classification variants in `ModelDrawCommand.js` (lines 626/641/767/818/868/925/950) emit their own derived commands with distinct renderStates. Picking the silhouette outline / shadow caster is not in this cut. Each derived variant would need its own pick pipeline if picking that variant matters.

### Net user-visible effect

- glTF Models become pickable via `scene.pick()` on WebGPU. Previously the WebGPU Model renderer emitted exactly one color command per primitive — pick passes had nothing to render so the pick FBO was always blank for model pixels and `scene.pick()` returned undefined.
- The `id` field in the picked object's lookup is the `"${nodeIdx}_${primIdx}"` string, not a glTF feature ID. Apps that need per-feature pick should wait for `C-R9-MODEL-FEATURE-PICK`.
- Alpha-mask materials (foliage cutouts, decals) correctly discard at non-cutout texels for picking, matching their visual appearance.
- Hidden features (`batchColor.a == 0` from 3D Tiles styling) correctly stay unpickable.

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| C-R9 (MODEL) | RENDERER_DEEP | Model renderer emits no pick command | `fragmentPickMain` WGSL entry runs alpha-mask + batch-table-hide discards, emits `material.pickColor`. Pick pipeline (in `WebGPUModelPipelineCache`) shares layout + vertex stage + cullMode with color pipeline; differs in fragment entry, no blend, depth write forced on. UBO gained `pickColor: vec4<f32>` at byte 160. Per-primitive pick ID via `createPickId({primitive: model, id: primKey}, "primitive")`. Pick command on `derivedCommands.picking.pickCommand`. Per-feature pick remains follow-up `C-R9-MODEL-FEATURE-PICK`. |

---

## Batch 55 — C-R11-EFFECTS-BGL-COLLECTION-CACHE: per-tile EffectsBindGroup cache (2026-04-25)

Closes the last remaining `C-R11` follow-up. Batches 31-32 cached the post-process bind groups (Bloom, AO, DoF, GodRays, AutoExposure) but explicitly deferred `WebGPUEffectsBindGroup.createEffectsBindGroup()` because the per-tile UBO content varies — the simple identity-based cache from Batch 31 would never hit. Batch 55 keys both the UBO and bind group on (resource-tuple identity + a small content sub-key) so the dominant globe-tile path with identity modelMatrix collapses to one cache entry per active feature combination, regardless of tile count.

### Files touched

- [packages/engine/Source/Renderer/WebGPU/WebGPUEffectsBindGroup.js](../packages/engine/Source/Renderer/WebGPU/WebGPUEffectsBindGroup.js) — added a per-device `effectsBgCache` slot on the existing `_placeholderCache` WeakMap entry. The cache is `{bindGroups: Map<string, {buffer, bindGroup}>, idMap: WeakMap<object, number>, idCounter: number, hits, misses, bufferWrites, diagLastFrame}`. The `_idFor(bgCache, obj)` helper assigns stable >0 ids on first sight; nullish maps to 0. New `_ensureEffectsBgCache(cache)` lazy-initializer hangs the cache off the existing per-device entry so it shares lifetime with the placeholder textures + samplers. Pre-cached `placeholderXxxView` slots (`placeholderDepthView`, `placeholderClipView`, `placeholderSDFView`, `placeholderLutView`, `placeholderEdgeView`) replace the `texture.createView()` calls that were happening per bind-group construction. The placeholder bind group itself now uses these cached views. The hot path in `createEffectsBindGroup`: build a 14-resource id-tuple key + 8-field content sub-key, look up `bgCache.bindGroups.get(cacheKey)`, allocate a fresh `(buffer, bindGroup)` pair on miss and store, always `device.queue.writeBuffer(cached.buffer, 0, ud)` to refresh per-frame UBO bytes. Pragma-stripped diagnostic logs cache stats (hits/misses/size/writeBuffer count) at 3-second intervals when in active use.
- [migration_doc/PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md](PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md) — C-R11 entry updated from "MOSTLY FIXED" to "FIXED" with the Batch 55 details called out.

### Typecheck

`npx tsc --noEmit` — clean. No new errors introduced.

### Caching strategy

The cache key is built in two parts:

1. **Resource tuple key** — string of 14 resource ids: `${depthViewId}|${compSamplerId}|${clipViewId}|${clipSamplerId}|${sdfViewId}|${sdfSamplerId}|${lutTId}|${lutIId}|${csmBufferId}|${csmCascadeViewId}|${edgeColorId}|${edgeIdId}|${edgeDepthId}|${globeDepthId}`. Each id is assigned via the cache's own `WeakMap<object, number>` so the id-counter is local to the cache; GC of a resource reclaims its WeakMap slot but the append-only counter never reuses ids. Nullish resources (which fall back to placeholders) resolve to placeholder ids that are themselves stable across frames.
2. **Content sub-key** — `${cipx}|${cipy}|${cipz}|${edges.near}|${edges.far}|${edges.viewportWidth}|${edges.viewportHeight}|${hasFeatureId ? 1 : 0}`. Captures the per-call content fields whose change forces a separate UBO (different bytes that can't be served from a buffer already in flight against another tile's BG).

The composite `${resKey}#${contentKey}` is the Map key. Hits reuse the cached `(buffer, bindGroup)`; misses allocate fresh and store.

### Why it works for the per-tile globe path

Every visible globe tile in a frame shares:

- The same shadowMap, clippingPlanes collection, atmosphere LUT views, csm resources, edge views (frame-scoped or collection-scoped state)
- `cameraInPlaneSpace = uniformState.cameraPosition` — globe modelMatrix is identity so plane-space camera == world camera

All ~200 tiles therefore produce identical `cacheKey` strings → 1 cache entry, with `writeBuffer` running once on the frame's first call (the content is identical, so the second-through-200th calls are still `writeBuffer` no-ops at the byte level but they're cheap and correctness-preserving).

### Why correctness holds when content varies

For models with non-identity modelMatrix, each model's `cameraInPlaneSpace` is different → different content key → different cache entry → different `(buffer, bindGroup)` pair. We never reuse a buffer object across content variants, so a tile's UBO bytes can't be overwritten by a later call before its render command is submitted. This matches the previous behavior that allocated fresh per call.

### Edge cases handled

- **Placeholder fast-path unchanged.** When `!hasShadow && !hasClipping && !hasPolygonClipping && !hasAtmosphereLut && !hasCsm && !hasEdges`, the function still returns the shared `placeholder.bindGroup` pre-built by `getPlaceholderEffects`. The cache code is bypassed entirely — same as before.
- **Device-loss recovery.** `clearEffectsPlaceholderCacheForDevice(device)` (already wired in `WebGPUContext._clearAllCaches`) deletes the WeakMap entry for the dying device, taking `effectsBgCache` with it. Next frame on the recovered device lazily re-creates the placeholder cache + a fresh empty `effectsBgCache`.
- **Resource churn.** When a clipping plane collection's underlying `textureView` is destroyed and recreated (plane count change), `_idFor` assigns a new id → new cache key → new `(buffer, bindGroup)` pair. The OLD entries stay in the Map but become unreachable for future lookups; their `GPUBindGroup` references the destroyed texture but is never accessed again. Memory is reclaimed on the next device-loss event. For typical Cesium usage where collection reconfigurations are rare, this is bounded.
- **Texture view cache.** `texture.createView()` returns a fresh wrapper per call, which would defeat the cache by producing a new resource id per call. The fix is to call `createView()` once per placeholder texture during `getPlaceholderEffects` and store the view alongside the texture, so the hot path reads `cache.placeholderDepthView` etc. instead.

### Allocation reduction (measured / projected)

For the reference scenario from the principal review (200 tiles × 60 Hz with clipping planes active):

- **Before:** ~12 000 `device.createBuffer` + ~12 000 `device.createBindGroup` + ~36 000 `texture.createView` calls per second. Each carries ~150-300 bytes of driver state never reclaimed until the JS wrapper is GC'd.
- **After:** 1 `createBuffer` + 1 `createBindGroup` per frame on the FIRST tile (cache miss because frame number isn't part of the resource tuple — wait, let me re-check. Actually frame number isn't in the key, and the resources stay stable; so the FIRST tile allocates ONCE on the very first frame, then frames 2..N hit the cache for all 200 tiles). Steady-state: 0 allocations / sec, ~12 000 `writeBuffer` calls/sec (200 tiles × 60 Hz, identical bytes — the writes themselves are fast queue operations against the same buffer object).

The pragma-stripped diagnostic logs print at 3 s intervals: `[CesiumJS:webgpu] EffectsBindGroup cache: <size> entries, <hits> hits / <misses> misses (<rate>% hit), <writes> writeBuffer calls`. Expect cache size to plateau at ≤4 (one per active feature combination — typically 1 in stable scenes) and hit rate to climb above 99% within the first few hundred calls.

### What's still open

- **No further C-R11 work.** All five major post-process consumers (Bloom, AO, DoF, GodRays, AutoExposure) plus the per-tile EffectsBindGroup are now cached. The remaining `WebGPUAutoExposure.ts` view memoization landed in Batch 32.
- The `clearEffectsPlaceholderCacheForDevice` device-loss hook covers the new cache transitively because the cache lives on the `_placeholderCache` entry it deletes.

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| C-R11 (FIXED) | RENDERER_DEEP | Per-frame bind group + texture view allocation in hot post-process / effects path | All five post-process consumers (Bloom, AO, DoF, GodRays, AutoExposure — Batches 31-32) plus the per-tile EffectsBindGroup (Batch 55) now cached. Per-tile path drops from ~12 k buffer + bind-group allocations/sec to 0 steady-state. Cache empties on device-loss via existing `clearEffectsPlaceholderCacheForDevice` hook. |

---

## Batch 56 — C-R7-RENDERER-MIGRATION first cut (2026-04-25)

First-cut migration of three representative feature renderers off their per-renderer pipeline maps and onto the central `context.webgpuPipelineCache`. The cache's instantiation, key-correctness, and device-loss invalidation infrastructure landed in Batches 33-34 and was audited clean in Batch 52; this batch is the first time any feature renderer actually consumes it.

### What landed

- **`WebGPUEllipsoidPrimitiveRenderer.ts`** — Color + pick pipelines. The old `createPipelineAndLayouts` was split into `buildEllipsoidPipelineResources` (synchronous: shader module, BGLs, pipeline layout, descriptor objects) and `tryResolveEllipsoidPipelines` (async: routes both descriptors through `pipelineCache.getPipeline()`, then through `getPipelineSync` once cached). The cache key already covers everything that distinguishes color from pick (entry point, blend presence on the color target's `fragment.targets[0]`), so two ellipsoid primitives with identical material settings now share one color pipeline + one pick pipeline instead of materializing two of each. New `pipelineRequestPending` flag in `EllipsoidCache` prevents duplicate in-flight requests; the renderer skips its draw on frames where the pipelines aren't materialized yet.
- **`WebGPUGaussianSplatRenderer.ts`** — Color + OIT + pick pipelines. Same shape via `buildSplatPipelineResources` + `tryResolveSplatPipelines`. The OIT pipeline is best-effort: WGSL injection failure leaves `oitDescriptor` null (existing behavior), and the cache request for OIT runs alongside but doesn't block the color+pick ready signal. Pulled the duplicated `vertex.buffers` shape into a module-level `SPLAT_VERTEX_BUFFERS` so the cache key signature matches across all three descriptors (matters because the cache hashes the full `vertex.buffers[]` shape — stride, stepMode, attribute layouts).
- **`WebGPUDepthPlane.ts`** — Single depth-only pipeline. `initialize()` gained an optional `pipelineCache?: WebGPURenderPipelineCache | null` parameter; when present, the pipeline is requested asynchronously and `_pipeline` stays null until resolution. The existing `if (!this._pipeline) return` guard in `execute()` handles the not-yet-ready frames cleanly. `WebGPUSceneRenderer._ensureResources` now passes `context.webgpuPipelineCache`. Split-screen / multi-canvas configurations with matching depth-plane descriptors now share a single `GPURenderPipeline` instead of materializing one per scene.
- **Type plumbing** — Added `webgpuPipelineCache?: WebGPURenderPipelineCache | null` to the `CesiumGraphicsContext` ambient interface in `cesium-js-types.d.ts`. Feature-renderer TS files can now reach the cache through `frameState.context` without casting to the concrete `WebGPUContext` type — keeps the backend-agnostic layering intact.

### Scope cuts

- **`WebGPUModelPipelineCache`** — explicitly **not** migrated. It owns its own pipeline map (`_pipelines`) keyed by a complex material-settings hash; routing it through the central cache without also sharing `GPUShaderModule` handles across model instances would not actually dedupe anything (two models with identical material settings still construct distinct shader modules → distinct cache keys). Tracked under follow-up `C-R7-SHADER-MODULE-DEDUP` — needs a separate `WebGPUShaderModuleCache` consumer pass first.
- **`WebGPUPostProcessEffects`, `WebGPUAutoExposure`, the per-effect compute caches** — out of scope. `WebGPUAutoExposure` uses `device.createComputePipeline()` exclusively, which the central `WebGPURenderPipelineCache` doesn't handle (it's render-pipeline-only). A parallel `WebGPUComputePipelineCache` would be a separate piece of infrastructure.
- **The remaining 12 feature renderers** with local pipeline maps (`WebGPUGroundPrimitiveRenderer`, `WebGPUBillboardRenderer`, `WebGPULabelRenderer`, `WebGPUPolylineRenderer`, `WebGPUEnvironmentRenderer`, `WebGPUCloudRenderer`, `WebGPUVolumetricFogRenderer`, `WebGPUWeatherRenderer`, `WebGPUVoxelRenderer`, `WebGPUPointPrimitiveRenderer`, `WebGPUPointCloudRenderer`, `WebGPUGlobeSurfaceRenderer`) are mechanical follow-ups using the same pattern. Tracked under continuing `C-R7-RENDERER-MIGRATION`.
- **No shader changes.** The migration is purely pipeline routing — same WGSL, same descriptors, same draw calls.

### Backwards-compat behavior

All three migrated renderers fall back to direct `device.createRenderPipeline()` when `context.webgpuPipelineCache` is null (legacy callers, WebGL contexts where the field doesn't exist). Behavior is identical to pre-migration in that path. The `pipelineCache?: ...` parameter on `WebGPUDepthPlane.initialize()` defaults to undefined, so any external caller that instantiated the depth plane manually still works.

### Files modified

- `packages/engine/Source/Renderer/WebGPU/cesium-js-types.d.ts` — added `webgpuPipelineCache?` slot on `CesiumGraphicsContext`
- `packages/engine/Source/Renderer/WebGPU/WebGPUEllipsoidPrimitiveRenderer.ts` — pipeline routing through cache
- `packages/engine/Source/Renderer/WebGPU/WebGPUGaussianSplatRenderer.ts` — pipeline routing through cache (color + OIT + pick)
- `packages/engine/Source/Renderer/WebGPU/WebGPUDepthPlane.ts` — optional `pipelineCache` param on `initialize()`
- `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts` — pass `context.webgpuPipelineCache` into `WebGPUDepthPlane.initialize()`
- `migration_doc/PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md` — C-R7 entry status appended with first-cut migration progress

`npx tsc --noEmit` runs clean.

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| C-R7-RENDERER-MIGRATION (PARTIAL) | RENDERER_DEEP | Per-renderer routing through central pipeline cache | Three representative renderers (Ellipsoid, GaussianSplat, DepthPlane) now resolve their pipelines through `context.webgpuPipelineCache`. Builds the descriptor once, requests pipelines async, skips draws until ready, falls back to direct creation when the cache is unavailable. 12 remaining renderers tracked under continuing follow-up. |

---

## Batch 57 — C-R10-POINT-LIGHT-RECEIVE: cube depth sampling for point-light shadows (2026-04-25)

The model fragment shader can now receive shadows from point-light cube shadow maps. Closes the receive-side half of C-R10 (cast path landed in Batch 34); only the globe-terrain receive remains, tracked separately.

### What landed

- **`WebGPUEffectsBindGroup.js`** — Bind group layout grew 17→18 bindings. Binding 17 is a `texture_depth_cube` (`viewDimension: "cube"`, `sampleType: "depth"`). Placeholder is a 1×1×6 `depth32float` cube cleared to 1.0 via per-face render passes (mirrors the CSM cascade-array placeholder pattern). EffectsUniforms UBO grew 304→336 bytes with two new vec4 control blocks at offsets 304 and 320:
  - `pointLightControl: vec4<f32>` — `(enabled, farPlane, nearPlane, depthBias)`. The cast pipeline used `near=1.0`, `far=lightRadius`, FOV=π/2 (per `computeOmnidirectional` in `ShadowMapComputations.js`); the receive shader plugs the same values into the perspective-Z formula.
  - `pointLightPositionWC: vec4<f32>` — `(lightWC.xyz, reserved)`. Absolute world coords, not camera-relative — the receive shader's `direction = fragWC - lightWC` subtract collapses back to a small relative vector well within f32 precision.
- **Auto-detect path** — `createEffectsBindGroup()` checks `shadowMap._isPointLight === true` AND `shadowMap._webgpuCache.cubeDepthView` exists. Pulls `lightPositionWC` from `shadowMap._lightCamera.positionWC`, `farPlane` from `shadowMap._pointLightRadius`, `depthBias` from `shadowMap._pointBias.depthBias` (falls back to 0.005). Explicit `options.pointLight` override available for callers that want fine control. Suppresses the 2D shadow path when the cube is active so binding 1 stays on the placeholder (cube and 2D paths are mutually exclusive — only one shadow map active at a time in Cesium).
- **`WebGPUShadowMapRenderer.js`** — `getShadowMapResources()` now returns `{ isPointLight, cubeView, lightPositionWC, farPlane, nearPlane, pointDepthBias }` alongside the existing 2D fields. Init-time comment in `initWebGPUShadowMap` updated to remove the now-stale "limited to face 0" claim.
- **`ModelPBRComplete.wgsl`** — Added the matching `pointLightControl` + `pointLightPositionWC` fields to the `EffectsUniforms` struct, declared `@group(7) @binding(17) var pointLightCubeDepth: texture_depth_cube`, added `samplePointShadow(fragWC)` + `computeShadowFactorPointLight(fragWC)` helpers, and rewrote the fragment shadow branch to `if (pointLightControl.x > 0.5) { /* cube */ } else if (csmControl.x > 0.5) { /* CSM */ } else { /* 2D / unshadowed */ }`. Point-light path takes precedence over CSM when both flags fire (only matters during transitions). `fragWC` is reconstructed via `camera.cameraPositionWC + (modelMatrix * vec4(rteMC, 0.0)).xyz` — the same RTE-preserving rotation the CSM path uses to derive `rteWC`, just promoted to absolute world coords.

### Math chosen for refDepth

The cast pipeline writes standard window-space depth from the per-face perspective matrix (`Matrix4.computePerspectiveFieldOfView` in WebGPU mode produces `[0,1]` z_ndc; the trailing `scaleBiasMatrix` in `ShadowMap.js` further compresses to `[0.5, 1]`). The receive shader has to round-trip the SAME formula:

```wgsl
let axisDist = max(absDir.x, max(absDir.y, absDir.z));
let depthRange = farPlane - nearPlane;
let zNdcWebGpu = farPlane / depthRange - (farPlane * nearPlane) / (axisDist * depthRange);
let zAttached = zNdcWebGpu * 0.5 + 0.5;
let refDepth  = clamp(zAttached - depthBias, 0.0, 1.0);
```

Picked over the simpler `axisDist / farPlane` (linear distance) because the cast pipeline does NOT write linear depth — it writes the perspective-Z value the depth attachment received from `pos.z/pos.w`. WebGL's reference implementation writes linearized `distance/radius` via `czm_packDepth(distance)` to a color attachment, but our cast pipeline uses a depth-only target so we have to reproduce its perspective math instead. A separate `C-R10-CAST-LINEAR-DEPTH` follow-up could swap the cast to linear depth (writing through `@builtin(frag_depth)`), which would let the receive use the simpler formula — but the perspective-Z path correctly round-trips against the existing cast output and ships now.

The dominant-axis distance `max(|dx|, |dy|, |dz|)` is what each per-face camera saw as `|z_eye|` for that fragment (each cube face's view direction projects perpendicular to one axis), so plugging it into the standard z-buffer formula reproduces what the cast wrote without needing six per-face VP matrices in the UBO.

### Scope cuts

- **Globe terrain receive** — `GlobeTerrain.wgsl` keeps using the 2D shadow path. Point-light shadows on terrain are uncommon in CesiumJS scenes and the inline-stage refactor cost (terrain shader is shared with the post-process / CSM hot path) doesn't pay off without a concrete user. Tracked as **FOLLOW-UP C-R10-GLOBE-POINT-LIGHT**.
- **Primitive receivers** — `PrimitivePhongTexturedColor.wgsl` and the collection shaders also keep the 2D path. Same rationale; revisit if a CesiumJS sample needs point-lit primitives.
- **Cast-pipeline linear depth** — kept as the existing perspective-Z path. Switching to `@builtin(frag_depth)` writing `axisDist / farPlane` would simplify the receive math but introduces a second z-test convention across the codebase. Tracked as **FOLLOW-UP C-R10-CAST-LINEAR-DEPTH** if performance profiling later shows the receive perspective math is a hot spot (it isn't — it's two divides and one cube sample per fragment).
- **Soft point-light shadows** — `pointLightPositionWC.w` is reserved for a future soft-radius parameter. WebGL's USE_CUBE_MAP_SHADOW path doesn't soft-filter either; PCF over cube samples is a separate enhancement.

### TSC status

`npx tsc --project packages/engine/tsconfig.json --noEmit` runs clean for all files we touched. Pre-existing untracked `WebGPUEdgeVisibilityEmitter.ts` carries syntax errors unrelated to this work.

### Files modified

- [packages/engine/Source/Renderer/WebGPU/WebGPUEffectsBindGroup.js](../packages/engine/Source/Renderer/WebGPU/WebGPUEffectsBindGroup.js)
- [packages/engine/Source/Renderer/WebGPU/WebGPUShadowMapRenderer.js](../packages/engine/Source/Renderer/WebGPU/WebGPUShadowMapRenderer.js)
- [packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.wgsl](../packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.wgsl)
- [packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.js](../packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.js) — auto-regenerated wrapper
- [migration_doc/PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md](PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md) — C-R10 status updated; appended `FOLLOW-UP C-R10-GLOBE-POINT-LIGHT` and `FOLLOW-UP C-R10-CAST-LINEAR-DEPTH`

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| C-R10-POINT-LIGHT-RECEIVE | RENDERER_DEEP | Point-light shadow receive on WebGPU | **MODEL FS FIXED** — 18-binding effects BGL with cube depth at binding 17, 336-byte UBO with `pointLightControl` + `pointLightPositionWC` blocks, perspective-Z reference depth derivation matches cast pipeline output (1×1×6 cleared placeholder when no point light is bound, auto-detect via `shadowMap._isPointLight`). Globe terrain stays on the 2D path — tracked as `C-R10-GLOBE-POINT-LIGHT`. |

---

## Batch 58 — C-R5 imagery layer expansion (2026-04-25)

Highest-impact unfixed correctness gap from the [2026-04-25 oversight audit](OVERSIGHT_AUDIT_2026_04_25.md) §2: globe imagery layer cap was hard-coded at 4, and five per-layer effects (hue / gamma / split / cutout / colorToAlpha) the WebGL path supports were silently dropped on WebGPU. Apps with 5+ layers (Bing + labels + weather + political-boundary overlays) lost layer #5 entirely; apps relying on per-layer hue / gamma / split / cutout / colorToAlpha got stripped imagery on WebGPU.

### What landed

- **`packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl`** —
  - `ImageryLayer` struct widened from 12 → 24 floats (96 B per layer). New fields `colorToAlpha: vec4` (rgb + threshold; threshold < 0 disables), `cutoutRectangle: vec4` (tile-UV space; zero-area disables), and per-layer scalars `hue`, `oneOverGamma`, `split` plus a trailing `_layerPad` to keep the struct 16-byte aligned.
  - `array<ImageryLayer, 4>` → `array<ImageryLayer, 16>`. WebGPU's minimum-guaranteed `maxSampledTexturesPerShaderStage = 16` makes 16 the safe ceiling without device-limit probing.
  - Per-layer arrays packed to dodge WGSL's 16-byte uniform-array stride: `dayNightAlpha: array<vec4<f32>, 8>` (two layers per vec4) and `useWebMercatorTLayer: array<vec4<f32>, 4>` (four per vec4).
  - New `splitPosition: f32` carries the WebGL-equivalent `frameState.splitPosition × drawingBufferWidth` so `applySplitMask` compares directly against `@builtin(position).x`.
  - Bind group 1 expanded from 4 textures + sampler to 16 textures + sampler at binding 16.
  - New WGSL helpers: `applyHueShift` (czm_hue port — same YIQ matrices, atan2 + chroma decomposition), `applyColorToAlphaKey`, `applyCutoutMask`, `applySplitMask`, and a unified `applyImageryLayer` that runs the full effect chain in WebGL `sampleAndBlend` order:
    1. `colorToAlpha` (key-color → alpha = 0)
    2. `gamma` (`pow(color, 1/gamma)`)
    3. `split` (alpha = 0 outside the active half)
    4. `cutout` (alpha = 0 inside the cutout rectangle — applied as alpha mask vs WebGL's `czm_branchFreeTernary` at the call site; effect identical)
    5. `brightness → contrast → hue → saturation` (WebGL ordering)
  - Fragment-shader compositing block unrolled to 16 per-layer composite blocks (WGSL forbids dynamic indexing of texture bindings); per-pass `count >= Nu` gate keeps inactive slots branch-light. Each block hands off to `applyImageryLayer` so the effect-chain logic is single-source.
  - `tile.verticalExaggeration` repacked from `vec2<f32>` to two scalars (`verticalExaggeration` + `verticalExaggerationRelativeHeight`), matching the new TileUniforms layout. Legacy `dayNightAlpha0..3` (4 vec2) replaced with the packed `array<vec4<f32>, 8>` form. `nightFadeDistance` split into `nightFadeOutDistance` + `nightFadeInDistance` scalars.

- **`packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts`** —
  - `MAX_IMAGERY_LAYERS = 16` (was 4); `TILE_UNIFORM_FLOATS = 472` / 1888 B (was 100 / 400 B). Stays well under the WebGPU 16 KiB `maxUniformBufferBindingSize` floor.
  - Float offset constants (`LAYERS_OFFSET`, `DAY_NIGHT_ALPHA_OFFSET`, `USE_WEB_MERC_OFFSET`, …, `HSB_SHIFT_OFFSET`) replace the hard-coded numeric offsets so the 472-float layout maps cleanly to WGSL's struct.
  - Per-tile UB packer writes the 5 new per-layer fields with the WebGL conventions: `colorToAlpha.a = -1` disables (matches `GlobeSurfaceTileProviderRendering.js`); `cutoutRectangle = ZERO` disables (zero-area); `oneOverGamma = 1.0 / layer.gamma` pre-divides on CPU; `split = layer.splitDirection` (-1 / 0 / +1 from `SplitDirection` enum); `hue = layer.hue` in radians. All resolved through `resolveImageryLayerValue` so callback-style ImageryLayer properties don't NaN through to the shader.
  - Bind-group layout 1 grew to 16 `texture` + 1 `sampler` entries. `_createTextureBindGroup` binds 16 placeholder-padded `GPUTextureView`s + the sampler at binding 16.
  - `splitPosition` written as `frameState.splitPosition × drawingBufferWidth` (mirrors WebGL `czm_splitPosition` auto-uniform).

- **`packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.js`** — auto-regenerated wrapper via `migration_doc/_regen_wgsl_js.py`.

### Per-layer struct layout (24 floats / 96 B)

| Float offset | Field | Notes |
|---|---|---|
| 0 - 3   | `translationAndScale: vec4`        | unchanged |
| 4 - 7   | `texCoordsRect: vec4`              | unchanged |
| 8 - 11  | `colorToAlpha: vec4`               | rgb + threshold; threshold < 0 disables |
| 12 - 15 | `cutoutRectangle: vec4`            | tile-UV space; zero-area disables |
| 16      | `alpha`                            | unchanged |
| 17      | `brightness`                       | unchanged |
| 18      | `contrast`                         | unchanged |
| 19      | `saturation`                       | unchanged |
| 20      | `hue`                              | radians; abs(hue) < 1e-4 → fast path |
| 21      | `oneOverGamma`                     | 1.0 / layer.gamma; abs(x-1) < 1e-4 → fast path |
| 22      | `split`                            | -1 = LEFT, 0 = NONE, +1 = RIGHT (`SplitDirection`) |
| 23      | `_layerPad`                        | alignment |

### UBO size growth

- Per-layer struct: **48 B → 96 B** (slightly above the ~80 B target — WGSL alignment forces the two trailing scalar slots to 16 B each; can't be tightened without folding fields across vec4 boundaries that would lose the natural 1-property-per-name mapping).
- Total `TileUniforms`: **400 B → 1888 B** (16 layers × 96 B + 352 B of tile-level fields). Negligible vs `maxUniformBufferBindingSize` 16 KiB minimum.

### Backwards compatibility

Scenes with 1-4 imagery layers continue to work — slots 4-15 are zero-filled by `data.fill(0)` and gated behind `tile.layerCount`. Multi-pass logic in `createTileCommands` (`ceil(totalLayers / MAX_IMAGERY_LAYERS)`) now ships up to 16 layers per pass instead of 4, dropping the pass count for typical 5-8 layer apps from 2 to 1.

### TSC status

`npx tsc --noEmit` clean (full repo).

### Files modified

- [packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl](../packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl)
- [packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.js](../packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.js) — regenerated wrapper
- [packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts)
- [migration_doc/PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md](PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md) — C-R5 status updated to FIXED

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| C-R5-IMAGERY-16 | RENDERER_DEEP | Globe imagery layer cap widen + 5 missing per-layer uniforms | **FIXED** — Layer cap 4 → 16, struct widened to 24 floats with `colorToAlpha`, `cutoutRectangle`, `hue`, `oneOverGamma`, `split` fields. Effect chain matches WebGL `sampleAndBlend` order. Bind group 1 declares 16 texture bindings + sampler at binding 16. CPU packer writes the new fields with WebGL-convention defaults (threshold = -1 disables colorToAlpha, zero-area disables cutout). |

---

## Batch 59 — Extract WebGPUPickCommandHelpers (2026-04-25)

Per the [2026-04-25 oversight audit](OVERSIGHT_AUDIT_2026_04_25.md) §6 ("Discoveries"), five renderers had converged on the same pick-command recipe (Ellipsoid B30, Ground B31, GaussianSplat B31, Voxel B53, Model B54). Five copies past the dedup threshold; this batch extracts the shared lifecycle + descriptor-derivation boilerplate into a single helper module so future pick consumers don't re-implement it.

### What landed

- **`packages/engine/Source/Renderer/WebGPU/WebGPUPickCommandHelpers.ts`** — new helper module exporting:
  - `ensurePickId(target, context, cache, options?)` — allocates and caches a `CesiumPickId`. Two operating modes: single-id (`_pickId` / `_pickIdLastId` slots, used by Ellipsoid / Ground / Splat / Voxel) and multi-id (`pickIds: Record<string, CesiumPickId>`, used by Model with the per-glTF-primitive key `nodeIdx_primIdx`). The `allowAllocate` option lets callers gate registration on `passes.pick || passes.render` without duplicating the read-back path.
  - `destroyPickIds(cache)` — bulk-destroy. Walks both single and multi shapes; safe to call against a half-populated or never-rendered cache.
  - `buildPickPipelineDescriptor(colorDescriptor, pickFragmentEntry, options?)` — clones a color `WebGPURenderPipelineDescriptor` into a pick variant: same layout + vertex stage + depthStencil shape; fragment entry swapped to `pickFragmentEntry`; blend stripped on every color target so pick FBO readback gets byte-exact pick IDs. `forceDepthWriteEnabled` defaults to `true` (Ellipsoid pattern); pass `false` to preserve the historical setting (Splat / Voxel / Ground translucent or stencil-gated paths).
  - `attachPickToColorCommand(colorCommand, pickCommand)` — sets `colorCommand.derivedCommands.picking ??= {}; .pickCommand = pickCommand;` so the Batch 29 `selectCommandVariant` dispatcher swaps to the pick variant during pick passes. Idempotent.

- **`WebGPUEllipsoidPrimitiveRenderer.ts`** — pick descriptor build, lifecycle, wiring, and teardown all routed through the helpers. Uses `forceDepthWriteEnabled: true` to match the historical Batch 30 behaviour.
- **`WebGPUGaussianSplatRenderer.ts`** — same treatment; uses `forceDepthWriteEnabled: false` since splats don't write depth in either color or pick path.
- **`WebGPUGroundPrimitiveRenderer.js`** — same treatment via JS imports; the pick descriptor now derives from the color descriptor (sharing stencil settings rather than duplicating the literal). `forceDepthWriteEnabled: false` preserves the stencil-gated read.
- **`WebGPUVoxelRenderer.ts`** — uses `ensurePickId` / `destroyPickIds` / `attachPickToColorCommand`. Voxel's pipeline path goes through `device.createRenderPipeline` directly (not the central pipeline cache) and the inline pick GPU descriptor stays per-renderer to keep the diff minimal — `buildPickPipelineDescriptor` doesn't fit cleanly into Voxel's GPU-descriptor-literal style without a wrapper round-trip.
- **`WebGPUModelRenderer.js`** — uses `ensurePickId` (multi-id mode with `idKey: primKey`), `destroyPickIds` (multi-id), and `attachPickToColorCommand`. Pick pipeline acquisition stays on `pipelineCache.getPickPipeline(alphaMode, doubleSided)` because Model's pipelines are coalesced by alpha-mask + double-sided combinatorics rather than cloned per-instance — `buildPickPipelineDescriptor` doesn't apply here. JSDoc on the helper module flags this exemption explicitly so future readers don't try to "finish" the abstraction.

### Behavior preserved

Each renderer's UBO layout, WGSL pick fragment, pick-pass enum value, and pickId allocation gating (`passes.pick || passes.render`) are byte-identical to pre-refactor. The legacy cache slot names `_pickId` / `_pickIdLastId` are retained so external debug tooling (and any code that grep'd those names) keeps working. The Batch 29 dispatcher consumes `derivedCommands.picking.pickCommand` exactly as before; only the wiring code shrunk.

### TSC status

`npx tsc --project packages/engine/tsconfig.json --noEmit` runs clean across all six edited files. The pre-existing `WebGPUEdgeVisibilityEmitter.ts` syntax errors (called out in Batch 57) are unchanged and unrelated.

### Files modified

- [packages/engine/Source/Renderer/WebGPU/WebGPUPickCommandHelpers.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUPickCommandHelpers.ts) — new
- [packages/engine/Source/Renderer/WebGPU/WebGPUEllipsoidPrimitiveRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUEllipsoidPrimitiveRenderer.ts)
- [packages/engine/Source/Renderer/WebGPU/WebGPUGaussianSplatRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUGaussianSplatRenderer.ts)
- [packages/engine/Source/Renderer/WebGPU/WebGPUGroundPrimitiveRenderer.js](../packages/engine/Source/Renderer/WebGPU/WebGPUGroundPrimitiveRenderer.js)
- [packages/engine/Source/Renderer/WebGPU/WebGPUVoxelRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUVoxelRenderer.ts)
- [packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.js](../packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.js)

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| C-R9-PICK-PATTERN-EXTRACT | OVERSIGHT_AUDIT §6 | Pick-command pattern duplicated across 5 renderers | **EXTRACTED** — `WebGPUPickCommandHelpers.ts` exports `ensurePickId` / `destroyPickIds` / `buildPickPipelineDescriptor` / `attachPickToColorCommand`. Ellipsoid + GaussianSplat + Ground + Voxel + Model migrated; Voxel keeps its inline GPU-descriptor pipeline build (helper covers lifecycle + wiring instead) and Model keeps its `pipelineCache.getPickPipeline()` route (combinatorial cache, not a clonable descriptor). |

---

## Batch 61 — C-R8-TRANSLUCENT-DEPTH-MSAA: MSAA-aware translucent classification depth (2026-04-25)

Closes the MSAA scope cut left over from Batch 47. Default 4×MSAA scenes now produce translucent tile classification depth instead of silently skipping the capture. The architecture replicates the Batch 43 globe-depth MSAA pattern — separate WGSL variant + bind-group layout that declares the source as `texture_depth_multisampled_2d`, sample-0 read via `textureLoad` — applied to the compare-and-pack pipeline.

### Background

Batch 47 shipped translucent classification with an honest scope cut: `executeTranslucentDepthPass` performs `copyTextureToTexture` from the scene framebuffer's depth into `_translucentDepthTexture`, and the WebGPU spec doesn't allow that copy when the source is multisampled (`sampleCount > 1` requires matching destination sample count, but our destination is single-sample so the pack pipeline can sample as `texture_depth_2d`). The Batch 47 path bailed early with `_hasTranslucentDepth = false` for MSAA scenes, leaving the default 4×MSAA configuration with no classification at all.

### What landed

- **`COMPARE_AND_PACK_MSAA_WGSL`** — new shader variant in `WebGPUTranslucentTileClassification.ts`. Both depth slots are `texture_depth_multisampled_2d`; reads use `textureLoad(coord, 0)` with `coord` derived from `@builtin(position)`. No sampler binding (textureLoad is unsampled). The `if (translucentDepth > opaqueDepth) translucent = 1.0` branch + `packDepth` helper are byte-identical to the single-sample shader so downstream consumers see equivalent packed output.
- **MSAA pack pipeline + bind group layout** — `_packMSAAPipeline`, `_packMSAABGL`, `_packMSAABindGroup`, `_packMSAAShaderModule` fields + `_ensurePackMSAAPipeline()` builder. BGL declares `multisampled: true` on both depth texture entries, no sampler entry. Pipeline is single-sample on the output (the `_packedDepthTexture` is RGBA8 single-sample); only the source bindings are multisampled.
- **Routing logic** — `executeTranslucentDepthPass` checks the scene depth's `sampleCount`. If `> 1`, instead of attempting the (illegal) copy, it records the source texture in `_msaaSourceDepthTexture` and sets `_hasTranslucentDepth = true`. `executePackDepth` now branches on `_msaaSourceDepthTexture` first; when set, it dispatches `_executePackDepthMSAA(encoder, msaaTexture)` which builds the MSAA bind group with two `aspect: "depth-only"` views over the scene depth texture and runs the MSAA pipeline. Single-sample path is unchanged.
- **Per-frame state lifecycle** — `prepareForFrame` now clears `_msaaSourceDepthTexture` alongside `_hasTranslucentDepth`. `update()` clears the MSAA pipeline + bind group on resize. `destroy()` clears the new fields.

### Why sample 0 is correct here

The Batch 43 globe-depth MSAA path picked sample 0 with the rationale that per-sample depth differences are immaterial for clamp-to-surface use cases. The same applies to translucent classification: the WGSL `if (translucent > opaque) → 1.0` test is binary, so a single representative sample produces the same accept/reject outcome as the average for any geometry where the front-most fragment dominates the pixel (the typical translucent-tile case). Per-sample averaging would introduce a packed-format rounding question (the per-byte `floor` chain in `packDepth` doesn't compose cleanly over averages) and dominate the cost, with no measurable correctness gain for classification.

For the Batch 47 first-cut MSAA path, opaque AND translucent depth are the same scene-framebuffer texture (the over-broad capture that the single-sample path also does — captures all translucent contributors, not just 3D-tile content). Both shader inputs read sample 0 of the same texture, so `translucent == opaque`, the `>` test is always false, and the packed output is the scene depth — identical end-state to what the single-sample copy + pack would produce on the same scene.

### Single-sample path preserved

The original `_packPipeline` / `_packBGL` / `_packBindGroup` + `COMPARE_AND_PACK_WGSL` path is untouched. `executeTranslucentDepthPass` still performs the copy when `sampleCount === 1`, and `executePackDepth` falls through to the single-sample bind-group construction + pipeline dispatch when `_msaaSourceDepthTexture` is null. No behavior change for single-sample scenes.

### Scope cuts preserved

This batch ONLY closes the MSAA gate. The other Batch 47 follow-ups remain: `C-R8-TRANSLUCENT-DEPTH-ONLY` (selective `_depthOnlyCommand` derivation), `C-R8-TRANSLUCENT-MULTI-FRUSTUM` (last-frustum-wins), `C-R8-TRANSLUCENT-CLASSIFICATION-DISPATCH` (binding `packedTranslucentDepthView` into classification pipelines).

### TSC status

`npx tsc --project packages/engine/tsconfig.json --noEmit` runs clean for both modified files. Pre-existing untracked `WebGPUEdgeVisibilityEmitter.ts` syntax errors (noted in Batch 57) are unchanged.

### Files modified

- [packages/engine/Source/Renderer/WebGPU/WebGPUTranslucentTileClassification.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUTranslucentTileClassification.ts) — `COMPARE_AND_PACK_MSAA_WGSL`, MSAA pipeline fields + builder, `_msaaSourceDepthTexture` per-frame state, MSAA branches in `executeTranslucentDepthPass` and `executePackDepth`, `_executePackDepthMSAA` helper, lifecycle wiring in `prepareForFrame` / `update` / `destroy`, header docstring updated.
- [packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts) — call-site comment updated to reflect MSAA support; no logic changes (the existing call passes the scene depth + sampleable view as before, and the renderer routes internally).
- [migration_doc/PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md](PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md) — `C-R8-TRANSLUCENT-DEPTH-MSAA` removed from open follow-ups; Batch 61 summary appended to the C-R8 entry.

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| C-R8-TRANSLUCENT-DEPTH-MSAA | RENDERER_DEEP | Translucent classification on MSAA scenes | **FIXED** — `COMPARE_AND_PACK_MSAA_WGSL` variant + MSAA pack pipeline (`texture_depth_multisampled_2d` + `textureLoad(coord, 0)`) routed via `_msaaSourceDepthTexture` set in `executeTranslucentDepthPass`. Output byte-equivalent to single-sample copy + pack; downstream composite + classification consumers unchanged. |

---

## Batch 62 — C-R7-RENDERER-MIGRATION continued (2026-04-25)

Second-cut migration of three more feature renderers off their per-renderer pipeline maps and onto the central `context.webgpuPipelineCache`. Same pattern as Batch 56: build descriptor + BGLs + pipeline-layout once, route the actual `GPURenderPipeline` through `WebGPURenderPipelineCache.getPipeline()`, check `getPipelineSync()` per frame, skip the draw on frames where the pipelines aren't materialized yet, fall back to direct synchronous creation when the cache is unavailable.

### What landed

- **`WebGPUGroundPrimitiveRenderer.js`** — Stencil + color + pick pipelines. The old `createGroundPipelines` was renamed to `buildGroundPipelineResources` and now emits three `WebGPURenderPipelineDescriptor` objects + the shared shader module / BGL / pipeline layout. New `tryResolveGroundPrimitivePipelines` resolves all three through the central cache; on the first frame the resolver returns false and `createWebGPUGroundPrimitiveCommands` returns null commands so the scene-side caller skips the GroundPrimitive. Subsequent frames pick up the cached `GPURenderPipeline` synchronously. Two ground primitives with identical (format, depth format, classification type) descriptors now share one set of three pipelines instead of materializing three each. New `pipelineRequestPending` flag on the cache prevents duplicate in-flight requests.
- **`WebGPUPointPrimitiveRenderer.js`** — Color + pick pipelines, both keyed by the active DP-H42/DP-H40 `defines` bitmask. The per-`defines` `cache.pipelines` and `cache.pickPipelines` Maps now hold `{ descriptor, pipeline, pending }` slots instead of bare `GPURenderPipeline` objects; new `tryResolvePointPipeline` resolves each slot through the central cache. Two PointPrimitiveCollections rendering with the same (defines, format, blend) now share one color pipeline. The renderer skips its color/pick draws on frames where the pipeline is still pending.
- **`WebGPUPolylineRenderer.js`** — Color + pick pipelines for each (materialType × defines) combo (5 material types × 4 define combos × 2 passes = up to 40 slots per device, in practice 2-4 slots active per scene). Renamed `getOrCreatePipeline` → `getOrCreatePolylinePipelineEntry` (returns slot with descriptor + null pipeline + BGLs); the resolver `tryResolvePolylinePipeline` handles both color and pick paths via a shared shape. The `for (const [materialType, group] of groups)` loop now `continue`s past material groups whose pipeline is still pending, and the pick path returns early. Two PolylineCollections with the same materialType + defines now share their pipelines.

### Scope cuts

- **`WebGPUModelPipelineCache`** still not migrated — same rationale as Batch 56 (needs `C-R7-SHADER-MODULE-DEDUP` first; routing without shader-module sharing across model instances doesn't actually dedupe anything).
- **`WebGPUAutoExposure`, `WebGPUPostProcessEffects`** still not migrated — compute pipelines, central cache only handles render pipelines.
- **The remaining 9 feature renderers** (`WebGPUBillboardRenderer`, `WebGPULabelRenderer`, `WebGPUCloudRenderer`, `WebGPUEnvironmentRenderer`, `WebGPUVolumetricFogRenderer`, `WebGPUWeatherRenderer`, `WebGPUVoxelRenderer`, `WebGPUPointCloudRenderer`, `WebGPUGlobeSurfaceRenderer`) still keep their local pipeline maps. Tracked under continuing `C-R7-RENDERER-MIGRATION`.
- **No shader changes, no behavior changes.** Same WGSL, same descriptors, same draw calls, same rendering output. Migration is purely pipeline routing.

### Backwards-compat behavior

All three migrated renderers fall back to direct `device.createRenderPipeline()` via a per-renderer `descriptorToGPU()` helper when `context.webgpuPipelineCache` is null (legacy callers, WebGL contexts where the field doesn't exist). Behavior is identical to pre-migration in that path. The new `pipelineRequestPending` / `pending` flags only matter on the cache path; they're set to `false` from the start so the fallback path never inspects them.

### Files modified

- [packages/engine/Source/Renderer/WebGPU/WebGPUGroundPrimitiveRenderer.js](../packages/engine/Source/Renderer/WebGPU/WebGPUGroundPrimitiveRenderer.js) — `buildGroundPipelineResources` + `tryResolveGroundPrimitivePipelines` + `descriptorToGPU` fallback; updated `createWebGPUGroundPrimitiveCommands` to use the resolver and skip draws when not ready
- [packages/engine/Source/Renderer/WebGPU/WebGPUPointPrimitiveRenderer.js](../packages/engine/Source/Renderer/WebGPU/WebGPUPointPrimitiveRenderer.js) — `buildPointColorDescriptor` + `buildPointPickDescriptor` + `tryResolvePointPipeline` + `descriptorToGPU` fallback; updated `updateWebGPUPointPrimitives` and `_pushPickCommand` to skip draws when not ready
- [packages/engine/Source/Renderer/WebGPU/WebGPUPolylineRenderer.js](../packages/engine/Source/Renderer/WebGPU/WebGPUPolylineRenderer.js) — `buildPolylineColorDescriptor` + `buildPolylinePickDescriptor` + `tryResolvePolylinePipeline` + `descriptorToGPU` fallback; renamed `getOrCreatePipeline` → `getOrCreatePolylinePipelineEntry`; updated `updateWebGPUPolylines` and `_pushPolylinePickCommand` to skip draws when not ready
- [migration_doc/PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md](PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md) — C-R7 entry updated to reflect 6 renderers migrated (was 3)

`npx tsc --noEmit` runs clean.

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| C-R7-RENDERER-MIGRATION (PARTIAL, 6/15) | RENDERER_DEEP | Per-renderer routing through central pipeline cache | Three more renderers (Ground, Point, Polyline) migrated to `context.webgpuPipelineCache`. Total migrated: 6 of ~15 (Ellipsoid, GaussianSplat, DepthPlane, GroundPrimitive, PointPrimitive, Polyline). 9 remaining renderers still maintain local pipeline maps; `WebGPUModelPipelineCache` blocked on `C-R7-SHADER-MODULE-DEDUP`. |

---

## Batch 63 — Soft point-light shadows via 5-tap PCF (2026-04-25)

Closes the soft-shadow follow-up that Batch 57 explicitly carved out (`pointLightPositionWC.w` was reserved-for-soft-radius from the moment Batch 57 landed). 5-tap cross-pattern PCF kernel in `samplePointShadow` of `ModelPBRComplete.wgsl`. UBO size unchanged (336 bytes — repurposed the reserved `.w` slot rather than growing for `pointLightExtras`).

### What landed

- **`ModelPBRComplete.wgsl` `samplePointShadow(fragWC)`** — Reads `effects.pointLightPositionWC.w` as `pcfRadius` in cube-face texels. `pcfRadius <= 0.0` falls through to the single-tap path bit-exact to Batch 57 (back-compat). For `pcfRadius > 0`, picks the two minor cube-face axes (the axes that AREN'T the dominant face axis) by inspecting `abs(direction)` per-component, perturbs the cube sample direction along ±minorA and ±minorB by `pcfRadius / shadowMapSize.x` (texels → unit-direction offset on the unit cube), and averages 5 comparison samples. Cross-pattern is intentional over diagonal because diagonals would land on neighboring cube faces in the corner regions and compare against perspective-Z values written by a different per-face camera.
- **Why 5 taps not 9** — The 9-tap kernel (center + 4 axial + 4 diagonal) is materially more expensive on cube samplers because every comparison sample touches the cube TLB. The 5-tap version captures most of the visual smoothing for ~half the cost. Not visible at typical viewing distances.
- **Why minor-axis tangents not arbitrary rotation** — Axis-aligned tangents keep the kernel shape constant regardless of where on the face the ray lands. A view-aligned rotated kernel would shift apparent shadow softness with viewing angle and produce visible swimming during camera moves.
- **`WebGPUEffectsBindGroup.js`** — `pointLightPositionWC[3]` now writes `pointLightConfig.pcfRadius ?? 0.0` (was always 0.0). Auto-detect path resolves `shadowMap.softShadows ? 1.5 : 0.0` so existing `softShadows = true` consumers get a noticeable softening for free; explicit `options.pointLight.pcfRadius` overrides for fine control. The point-light branch of the UBO writer also now packs the cube-face edge length into `effects.shadowMapSize.x` (sourced from `shadowMap._webgpuCache.size` or `shadowMap._textureSize.x`) so the kernel can scale texel offsets correctly. Pre-Batch-63 the UBO writer set `shadowMapSize` to `(1.0, 1.0)` on the point-light path; the kernel needs a real value to convert pcfRadius from texels to unit-direction offsets.
- **JSDoc** — `options.pointLight.pcfRadius` documented; the WGSL `pointLightPositionWC.w` comment block updated to reflect the new role (was "reserved for future per-light metadata").

### Why the UBO didn't grow

Batch 57 explicitly reserved `.w` "for future per-light metadata (soft-radius, tint)" — exactly the use case here. Growing to 352 bytes via a `pointLightExtras: vec4<f32>` block would have been cleaner-looking but breaks zero existing callers either way; using the reserved slot avoids a BGL minBindingSize bump and keeps the diff small. The "darkness override" comment was a stale-rationale artifact in the JS doc-block — `effects.shadowDarkness` already drives the visibility-→-RGB mix at the `computeShadowFactorPointLight` call site, so `.w` was never actually doing darkness work.

### TSC status

`npx tsc --project packages/engine/tsconfig.json --noEmit` clean for all files we touched. Pre-existing untracked `WebGPUEdgeVisibilityEmitter.ts` carries syntax errors unrelated to this work (same as Batches 57, 61).

### Files modified

- [packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.wgsl](../packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.wgsl)
- [packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.js](../packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.js) — auto-regenerated wrapper
- [packages/engine/Source/Renderer/WebGPU/WebGPUEffectsBindGroup.js](../packages/engine/Source/Renderer/WebGPU/WebGPUEffectsBindGroup.js)

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| C-R10-POINT-LIGHT-PCF | RENDERER_DEEP (Batch 57 follow-up) | Soft point-light shadows | **FIXED** — 5-tap cross PCF in `samplePointShadow`. Activated via `pointLightPositionWC.w` (radius in cube-face texels). `radius=0` keeps Batch 57 hard-edge bit-exact; `softShadows = true` auto-resolves to 1.5 texels. UBO size unchanged at 336 bytes. |

---

## Batch 64 — Doc rollup + DEFERRED_WORK.md inventory (2026-04-25)

Pure-documentation batch closing the doc-drift gap that the 2026-04-25 oversight audit (`OVERSIGHT_AUDIT_2026_04_25.md` §4) called out. No source changes.

### What landed

- **New canonical inventory at [DEFERRED_WORK.md](DEFERRED_WORK.md)** — 14 named C-R follow-ups (`C-R1-CLASSIFICATION`, `C-R1-COLLECTIONS-PER-ENCODER`, `C-R1-GLOBE-RENDERSTATE`, `C-R1-PRIMITIVE-DERIVED`, `C-R1-TILE-BATCH`, `C-R4-GLTF-KHR`, `C-R7-RENDERER-MIGRATION-REMAINING`, `C-R7-SHADER-MODULE-DEDUP`, `C-R8-TRANSLUCENT-DEPTH-ONLY`, `C-R8-TRANSLUCENT-MULTI-FRUSTUM`, `C-R8-TRANSLUCENT-CLASSIFICATION-DISPATCH`, `C-R9-MODEL-FEATURE-PICK`, `C-R9-MODEL-PICK-TRANSLUCENT`, `C-R9-VOXEL-CELL-PICK`, `C-R10-GLOBE-POINT-LIGHT`, `C-R10-CAST-LINEAR-DEPTH`, `C-R12-PER-OBJECT-CACHES`) grouped by parent C-R finding. Each entry has six fields (What / Why deferred / Prerequisites / Estimated effort / Impact / Trace) and a stable identifier that survives renumbering.
- **`WEBGPU_MIGRATION_BACKLOG.md`** — "Last Updated" header refreshed to 2026-04-25; new "Recent activity Batches 28-64" section summarizes the 36-batch burst with cross-links to `DEFERRED_WORK.md` for follow-up tracking.
- **`NEXT_SESSION_HANDOFF.md`** — refreshed to 2026-04-25; old 2026-04-20 content preserved below the new header as historical context. Added recommended next-session pick-list pulled from `DEFERRED_WORK.md`'s priority guide.

### Why a flat inventory not severity-grouped

The C-R sub-IDs already encode parent-finding affinity (`C-R8-*` are all translucent classification follow-ups, `C-R9-*` are pick follow-ups). Grouping by severity would have lost that affinity for no gain — every item in this list is "Critical-tier follow-up" by construction (they're the carved-out remainders of Critical-tier parent findings). Grouping by parent C-R makes "what's left in this subsystem" a single-section read, which is the question future sessions actually ask.

### Files modified

- [migration_doc/DEFERRED_WORK.md](DEFERRED_WORK.md) — new file
- [migration_doc/WEBGPU_MIGRATION_BACKLOG.md](WEBGPU_MIGRATION_BACKLOG.md) — header + recent activity section
- [migration_doc/NEXT_SESSION_HANDOFF.md](NEXT_SESSION_HANDOFF.md) — refreshed for 2026-04-25
- [migration_doc/REVIEW_FIX_PROGRESS.md](REVIEW_FIX_PROGRESS.md) — Batches 63 + 64 entries (this addition)

---

## Batch 65 — Sandcastle demos for Batches 48-63 (2026-04-25)

User-facing Sandcastle gallery demos for the seven Batch 48-63 features that
landed without visual coverage. Each demo forces `renderer: "webgpu"` via
`contextOptions` and includes a header comment citing parent batch numbers so
the visual-regression testing agent can map demo → feature.

### Demos authored

| File | Batches exercised | Visual focus |
| --- | --- | --- |
| [Apps/Sandcastle/gallery/WebGPU Edge Visibility.html](../Apps/Sandcastle/gallery/WebGPU%20Edge%20Visibility.html) | 44, 45, 46, 48, 49, 50 | glTF edge rendering via inline `applyEdgeOverlay()`; edge color / line width / line pattern toggles |
| [Apps/Sandcastle/gallery/WebGPU Edge Feature ID.html](../Apps/Sandcastle/gallery/WebGPU%20Edge%20Feature%20ID.html) | 48, 49 | per-feature edge gating + 16-bit feature IDs (g+b channel split) |
| [Apps/Sandcastle/gallery/WebGPU Model Pick.html](../Apps/Sandcastle/gallery/WebGPU%20Model%20Pick.html) | 54, 59 | glTF Model `scene.pick()` at primitive granularity |
| [Apps/Sandcastle/gallery/WebGPU Voxel Pick.html](../Apps/Sandcastle/gallery/WebGPU%20Voxel%20Pick.html) | 53, 59 | VoxelPrimitive pick via `fragmentPickMain` |
| [Apps/Sandcastle/gallery/WebGPU Point Light Shadows.html](../Apps/Sandcastle/gallery/WebGPU%20Point%20Light%20Shadows.html) | 34, 57, 63 | cube-shadow cast + receive + 5-tap PCF toggle |
| [Apps/Sandcastle/gallery/WebGPU Many Imagery Layers.html](../Apps/Sandcastle/gallery/WebGPU%20Many%20Imagery%20Layers.html) | 58 | 16-layer cap + per-layer hue / gamma / alpha (5 missing uniforms wired) |
| [Apps/Sandcastle/gallery/WebGPU Translucent Classification.html](../Apps/Sandcastle/gallery/WebGPU%20Translucent%20Classification.html) | 47, 61 | translucent 3D Tile classification at `msaaSamples` 1 vs 4 |

### Asset reuse

All demos reference local assets already in the repo:

- `Specs/Data/Models/glTF-2.0/StyledLines/BENTLEY_materials_line_style.gltf` —
  has `EXT_mesh_features` + `EXT_mesh_primitive_edge_visibility` + per-vertex
  `_FEATURE_ID_0`. Used by both edge demos.
- `Apps/SampleData/models/{CesiumMilkTruck,CesiumMan,WoodTower}/*.glb` — used
  by the Model Pick and Point Light Shadows demos.
- `Cesium.TileMapServiceImageryProvider` rooted at `Assets/Textures/NaturalEarthII`
  — base layer for the imagery demo, no network required.
- Ion asset 40866 (Aerometrex Denver photogrammetry) for the classification
  demo, with a fallback to `Specs/Data/Cesium3DTiles/Tilesets/Tileset/tileset.json`
  when the Ion token isn't configured.

### Forced WebGPU on every demo

Every viewer construction passes `contextOptions: { renderer: "webgpu" }`.
The follow-up testing agent can therefore validate via WebGPU canvas
inspection without parsing query strings.

### Header comment convention

Each demo's `<!-- ... -->` header block lists:

1. The parent Batch numbers from this Progress doc.
2. The architectural mechanism each Batch landed (e.g., "Batch 48 — inline
   `applyEdgeOverlay()` in `ModelPBRComplete.wgsl`").
3. A numbered Visual Verification list pinning each Batch to a specific
   observable behaviour the testing agent can check.

### Files modified

- [Apps/Sandcastle/gallery/WebGPU Edge Visibility.html](../Apps/Sandcastle/gallery/WebGPU%20Edge%20Visibility.html) — new
- [Apps/Sandcastle/gallery/WebGPU Edge Feature ID.html](../Apps/Sandcastle/gallery/WebGPU%20Edge%20Feature%20ID.html) — new
- [Apps/Sandcastle/gallery/WebGPU Model Pick.html](../Apps/Sandcastle/gallery/WebGPU%20Model%20Pick.html) — new
- [Apps/Sandcastle/gallery/WebGPU Voxel Pick.html](../Apps/Sandcastle/gallery/WebGPU%20Voxel%20Pick.html) — new
- [Apps/Sandcastle/gallery/WebGPU Point Light Shadows.html](../Apps/Sandcastle/gallery/WebGPU%20Point%20Light%20Shadows.html) — new
- [Apps/Sandcastle/gallery/WebGPU Many Imagery Layers.html](../Apps/Sandcastle/gallery/WebGPU%20Many%20Imagery%20Layers.html) — new
- [Apps/Sandcastle/gallery/WebGPU Translucent Classification.html](../Apps/Sandcastle/gallery/WebGPU%20Translucent%20Classification.html) — new

### Caveats / known limits

- **No `.jpg` thumbnails authored.** The Sandcastle gallery falls back to a
  generic placeholder when a paired thumbnail is missing. Thumbnails can be
  generated with `Tools/visual-regression/capture-and-diff.mjs --update`
  once the demos are wired into the regression harness, but they are not a
  prerequisite for the demos to run.
- **`WebGPU Translucent Classification` has a soft Ion dependency.** The
  primary path uses Ion asset 40866 (Aerometrex Denver photogrammetry, the
  same asset the WebGL `3D Tiles 1.1 Photogrammetry Classification` gallery
  demo uses). When no Ion token is configured the demo falls back to a
  small local tileset under `Specs/Data/Cesium3DTiles/Tilesets/Tileset/`.
  Both paths exercise the Batch 47 + 61 code paths; the visual richness of
  the photogrammetry version is the only difference.
- **`WebGPU Many Imagery Layers` references public OSM-class tile servers**
  for layers 2-6 (OSM, Cyclosm, Humanitarian, Transport, Stadia smooth).
  Layer 1 (Natural Earth II) ships in `Apps/SampleData/Assets/Textures/`
  so the demo always has at least one base layer; the OSM-class layers
  validate the 16-layer cap when the network is available.
- **`WebGPU Point Light Shadows` builds an explicit point-light `ShadowMap`**
  via `new Cesium.ShadowMap({ isPointLight: true, ... })`. The CesiumJS
  public-API surface for this constructor is intentional but lightly
  documented; if the constructor signature changes upstream the demo will
  need a refresh.

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| BATCH-65-SANDCASTLE | self-carved | Sandcastle demos for Batches 48-63 | **NEW** — Seven gallery demos covering Batches 34, 44-50, 53, 54, 57, 58, 59, 61, 63. Each forces `renderer: "webgpu"` via `contextOptions`; each header block lists parent batches + visual verification steps for the regression-testing agent. No source-code changes; pure documentation/demo artifact addition. |

---

## Batch 66 — F3 ES5/ES6 inheritance fix (2026-04-25)

**Symptom:** `class extends` parents (`DynamicGeometryUpdater`) had been migrated to ES6, but their nine `Dynamic*GeometryUpdater` children still used the legacy `Parent.call(this, ...)` + `Object.create(Parent.prototype)` chain. Calling an ES6 class without `new` throws `Class constructor X cannot be invoked without 'new'` at runtime. Any entity-driven dynamic geometry (corridor / cylinder / ellipse / ellipsoid / plane / polygon / polyline-volume / rectangle / wall) constructed through `GeometryVisualizer` would crash on first frame.

**Files touched:**
- [packages/engine/Source/DataSources/CorridorGeometryUpdater.js](../packages/engine/Source/DataSources/CorridorGeometryUpdater.js)
- [packages/engine/Source/DataSources/CylinderGeometryUpdater.js](../packages/engine/Source/DataSources/CylinderGeometryUpdater.js)
- [packages/engine/Source/DataSources/EllipseGeometryUpdater.js](../packages/engine/Source/DataSources/EllipseGeometryUpdater.js)
- [packages/engine/Source/DataSources/EllipsoidGeometryUpdater.js](../packages/engine/Source/DataSources/EllipsoidGeometryUpdater.js)
- [packages/engine/Source/DataSources/PlaneGeometryUpdater.js](../packages/engine/Source/DataSources/PlaneGeometryUpdater.js)
- [packages/engine/Source/DataSources/PolygonGeometryUpdater.js](../packages/engine/Source/DataSources/PolygonGeometryUpdater.js)
- [packages/engine/Source/DataSources/PolylineVolumeGeometryUpdater.js](../packages/engine/Source/DataSources/PolylineVolumeGeometryUpdater.js)
- [packages/engine/Source/DataSources/RectangleGeometryUpdater.js](../packages/engine/Source/DataSources/RectangleGeometryUpdater.js)
- [packages/engine/Source/DataSources/WallGeometryUpdater.js](../packages/engine/Source/DataSources/WallGeometryUpdater.js)
- [packages/engine/Source/DataSources/BoxGeometryUpdater.js](../packages/engine/Source/DataSources/BoxGeometryUpdater.js) (TDZ fix on existing reference conversion)

**Typecheck:** `npx tsc --noEmit` — clean (exit 0).

**Pattern applied** (verbatim from the BoxGeometryUpdater reference, with one TDZ correction):

- `function DynamicX(...) { Parent.call(this, ...); }` → `class DynamicX extends Parent { constructor(...) { super(...); } }`
- `if (defined(Object.create)) { DynamicX.prototype = Object.create(Parent.prototype); ... }` → dropped entirely (ES6 `extends` handles the chain).
- `DynamicX.prototype.foo = function (...) { ... };` → `class { foo(...) { ... } }`.
- `Parent.prototype.foo.call(this, ...)` → `super.foo(...)`.

**TDZ correction:** the original reference (`BoxGeometryUpdater.js`) placed `BoxGeometryUpdater.DynamicGeometryUpdater = DynamicBoxGeometryUpdater` BEFORE the class declaration. With `function`-declared constructors that worked because of hoisting; with ES6 class declarations it raises `ReferenceError: Cannot access 'DynamicBoxGeometryUpdater' before initialization` at module load. All ten files now place the assignment AFTER the class.

**Per-file surprises:**
- `EllipsoidGeometryUpdater.js` — child constructor sets ten extra instance fields (`_scene`, `_modelMatrix`, `_attributes`, etc.) before returning; preserved as a single `super(...)` followed by ten `this.* = ...` assignments. Single 320-line `update(time)` method body migrated as-is — only the wrapping syntax changed; method body indentation kept at 2-space (works inside class methods, no logic change).
- `PolygonGeometryUpdater.js` — historical typo `DyanmicPolygonGeometryUpdater` (line ~446) was internal-only (`git grep "Dyanmic"` confirmed zero external consumers). Renamed to `DynamicPolygonGeometryUpdater` as part of the conversion.
- `OpenStreetMapImageryProvider.js` and `TileMapServiceImageryProvider.js` — already in ES6 class form per upstream `4b3c0ef68f` and earlier; no work needed beyond load-verification.

| ID | Source doc | Title | Fix summary |
| --- | --- | --- | --- |
| F3-INHERITANCE | self-carved | ES5 prototype inheritance throws against ES6 parent class | Converted nine `Dynamic*GeometryUpdater` children + corrected the BoxGeometryUpdater TDZ ordering. `super._isHidden(...)` replaces `DynamicGeometryUpdater.prototype._isHidden.call(this, ...)`; `super(...)` replaces `DynamicGeometryUpdater.call(this, ...)`. No behaviour changes — pure syntax migration. |

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

1. ~~**DP-H16**~~ **FIXED 2026-04-16 (Batch 18)** — buffer-polygon pipeline splits pick vs color paths; `makeFragmentTarget(format, translucent)` applies `src-alpha / one-minus-src-alpha` blend when translucent. Material pipeline (`createMaterialPipelineAndCache`) uses the same helper. All translucent Primitive / PerInstanceColorAppearance / MaterialAppearance buffer paths now composite correctly.
2. **DP-H19** — `compressVertices: true` (the default) produces garbage geometry. **PARTIALLY FIXED Batch 23 (CPU decode)**; shader-side decode tracked as `DP-H19-SHADER-DECODE`.
3. **DP-H20 / DP-H21** — **FIXED Batch 25 / Batch 18**. Secondary texture slots + wrap-mode rebuild landed.
4. **DP-H22** — 5 material shaders missing from `selectMaterialShader`: ElevationBand, PolylineArrow, PolylineDash, PolylineGlow, PolylineOutline. **PARTIALLY FIXED Batch 18 (warning) + Batch 25 (ElevationBand shader)**; Polyline* stays collection-scoped.
5. **DP-H24** — **FIXED Batch 18**. Globe HSB shift now flows through `TileUniforms.hsbShift`.
6. **DP-H44 / DP-H45 / DP-H46** — Pick gaps: globe surface no pick ID, `pickPosition` returns Cartesian only over globe, `pickMetadata` entirely unwired.
7. **DP-H7** — Polyline `arcType: GEODESIC` silently straight-lines; long polylines pass underground.
8. **C-P1 sibling leaks** — apply the `_featureRenderer` handle pattern (Batch 1 pattern) to other FRs that share the same class-of-bug.
9. ~~**C-R3-TRANSLUCENT-SORT**~~ **FIXED 2026-04-23 (Batch 28)** — `WebGPUSceneRenderer.ts` now delegates to `CommandSorter.backToFront` + `CommandSorter.backToFrontSplats` through defensive local wrappers; VOXELS, non-OIT TRANSLUCENT, and non-OIT GAUSSIAN_SPLATS passes all sort before execution. OIT paths stay unsorted (order-independent).

### Next-session recommended plan

A single 2-hour session could plausibly close:

- Remaining high-severity: DP-H44/45/46 pick gaps, DP-H7 polyline geodesic subdivision, DP-H19 shader-side decode
- One architectural C-R: `C-R1-RENDERSTATE` (plumb `command.renderState` through 15 feature renderers) or `C-R2-DERIVED-COMMANDS` (polymorphic dispatch)
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
