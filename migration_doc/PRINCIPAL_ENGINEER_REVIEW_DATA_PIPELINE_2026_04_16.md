# CesiumJS WebGPU Fork — Data Pipeline Correctness Review

**Date:** 2026-04-16 (fourth review in the 2026-04-16 series)
**Scope:** End-to-end trace of data from Scene API → feature renderer → GPU buffers → WGSL consumption → rasterized pixels. For each rendering feature, verify that every property users set actually reaches the output pixel.
**Companion documents:**
- [PRINCIPAL_ENGINEER_REVIEW_2026_04_16.md](PRINCIPAL_ENGINEER_REVIEW_2026_04_16.md) — build / lifecycle / tests / types
- [PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md](PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md) — renderer + scene dispatch + shader parity
- [PRINCIPAL_ENGINEER_REVIEW_PER_FEATURE_2026_04_16.md](PRINCIPAL_ENGINEER_REVIEW_PER_FEATURE_2026_04_16.md) — per-feature correctness at planetary scale
- **This doc** — data pipeline from Scene API to pixel

**Methodology:** 5 parallel deep-dive agents on disjoint data-flow slices (Appearance+Material / glTF+3DTiles / Globe+Imagery+Terrain / Collections / UniformState+Picking). Each traced a specific Scene-level property from API call through feature renderer code through uniform pack code through WGSL shader consumption. Four high-impact claims reverified via direct grep. ~95% of findings survived.

---

## Executive summary — what data actually flows

The earlier reviews found the architecture correct but execution under-implemented. **This review finds that even within implemented features, large fractions of Scene-level configuration are silently dropped between the API and the GPU buffer.** Users set properties, the WebGPU path either doesn't read them, reads them into the wrong slot, or reads them and then never uploads the result.

Combined with the prior three reviews, this review adds ~70 new findings, of which:
- **11 CRITICAL** — produce visibly wrong rendering on very common configurations
- **~30 HIGH** — silently drop a widely-used Scene property
- **~30 MEDIUM/LOW** — edge cases, performance, inconsistency

The most impactful single discoveries:

1. **3D Tiles styling doesn't work on WebGPU at all.** The `BatchTexture` CPU byte buffer never reaches the WebGPU GPU texture because the upload path at [BatchTexture.js:558](../packages/engine/Source/Scene/BatchTexture.js) uses `arrayBufferView: batchTexture._batchValues` — a format `WebGPUModelFeatureId.createBatchGPUTexture` doesn't handle. `Cesium3DTileStyle.color='red'`, `show=false`, hidden-feature `discard` — all no-ops on WebGPU.

2. **Every Model runs both rendering paths every frame.** [Model.js:3126-3129](../packages/engine/Source/Scene/Model/Model.js) unconditionally calls both `modelFr.update(model, frameState)` AND `model._sceneGraph.pushDrawCommands(frameState)` — so the WebGPU context receives both WebGPU draw commands AND the WebGL-shape `DrawCommand` objects.

3. **Imagery layer function-valued properties NaN-taint the uniforms.** [WebGPUGlobeSurfaceRenderer.ts:1908-1909](../packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts) — `data[baseOffset + 8] = layer.alpha ?? 1.0`. `layer.alpha` can be a function (documented public API); that writes `Function` into a `Float32Array` → NaN → fragment samples a NaN-blended layer → disappears. Applies to alpha / brightness / contrast / saturation / hue / gamma — every CesiumJS imagery layer parameter that accepts a callback.

4. **Quantized terrain (the standard format from Cesium ion and Bing) lights incorrectly on WebGPU.** When `hasWebMercatorT && hasVertexNormals` (the common Bing-on-terrain case), the oct-encoded normal is stored in a separate `compressed1` attribute at shader location 1. The WebGPU pipeline variant never declares it and [GlobeTerrain.wgsl:448-457](../packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl) hardcodes `encodedNormal = 32896.0` — straight-up ECEF normal. Lambert shading is flat, terminator is wrong.

5. **glTF normalized integer attributes cast without dequantize.** Prior review flagged positions; this review reveals it's every quantizable channel: NORMAL (as BYTE-normalized → [-128,127] instead of [-1,1]; lighting blacked out), TEXCOORD_0 (as UNSIGNED_BYTE-normalized → [0,255] instead of [0,1]; textures repeat thousands of times), TANGENT same pattern. Any KHR_mesh_quantization asset on WebGPU — Google Photorealistic, most commercial pipelines — is fundamentally wrong.

6. **Material time-varying uniforms never re-upload.** Animated water, flowing dash, glowing polyline — [WebGPUPrimitiveCommands.js:1636-1664](../packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js) (`updateMaterialCommandUniforms`) only rewrites the camera buffer. Material UBO writes are gated behind command-creation, which only re-runs when the appearance changes. All time-varying effects freeze after frame 1.

7. **Pick framebuffer reads from origin (0,0), not from the user's click position.** [WebGPUPickFramebuffer.ts:278, 347](../packages/engine/Source/Renderer/WebGPU/WebGPUPickFramebuffer.ts) — `copyTextureToBuffer` has no `texture.origin` offset; pick ID sampling happens at top-left of the FBO regardless of cursor. Picking works *only* when the user clicks near (0,0).

The picture this review completes: **the WebGPU fork today renders a subset of static scenes approximately correctly. As soon as you add dynamic content — 3D Tiles styling, user-level imagery tweaks, animated materials, cluster-hidden entities, distance-scaled billboards, picking at non-origin pixels — features silently break.** Combined with the prior reviews, the end-to-end correctness gap is substantial.

The estimate now: **~14-18 weeks of focused engineering to reach a genuine drop-in-replacement state.** That's on top of the 4-6 weeks from the first review. Not a referendum on the architecture — an accounting of the under-implementation.

---

## CRITICAL findings (wrong pixels on typical scenes)

### DP-C1. 3D Tiles styling is a no-op on WebGPU
**Verified.** [BatchTexture.js:558](../packages/engine/Source/Scene/BatchTexture.js) creates `new Texture(context, { source: { arrayBufferView: batchTexture._batchValues } })`. The CesiumJS Texture wrapper stores the bytes but does NOT populate `_source` with an ImageBitmap. [WebGPUModelFeatureId.js:139-175](../packages/engine/Source/Renderer/WebGPU/WebGPUModelFeatureId.js) `createBatchGPUTexture` only knows how to copy from `cesiumTex._source` — for every batched 3D Tile it returns `null`. `ensureFeatureIdResources` hits the `flags === 0` early-out (line 249-251), `FLAG_HAS_BATCH_TABLE` is never set, `ModelPBRComplete.wgsl` falls through the branch at line 509-513 (comment: *"use vertex color as proxy… fall through with featureColor = white"*).

**User impact:** `Cesium3DTileStyle.color = "${height} > 100 ? 'red' : 'blue'"` produces uniform white rendering on WebGPU. Feature hiding (`show: false`), feature highlighting, height-based coloring — **none of it works.** This is the single most important gap for 3D Tiles applications.

**Fix:** teach `WebGPUModelFeatureId.createBatchGPUTexture` (or a new helper) to upload from `batchTexture._batchValues` directly via `device.queue.writeTexture`. The WebGL wrapper's `_batchValues` is the authoritative source.

---

### DP-C2. Model renders via BOTH feature-renderer path AND legacy DrawCommand path every frame
**FIXED 2026-04-16 (Batch 1).** The `pushDrawCommands` call is now gated on `!context.isWebGPU`. On WebGPU contexts the feature-renderer-produced `WebGPUDrawCommand`s are authoritative; the legacy pipeline-stage chain no longer runs to build WebGL-shape draw commands that the WebGPU dispatcher would ignore. Cuts Model CPU cost in half on the hot path.

**Original finding — Verified.** [Model.js:3126, 3129](../packages/engine/Source/Scene/Model/Model.js):
```js
modelFr.update(model, frameState);
// ... then unconditionally:
model._sceneGraph.pushDrawCommands(frameState);
```

On a WebGPU context, `_sceneGraph.pushDrawCommands` still runs through every `*PipelineStage.js` in the Scene model chain, builds `DrawCommand` objects, pushes them to `frameState.commandList`. Most end up no-op in the WebGPU dispatch (they're not `WebGPUDrawCommand` instances), but they still:

- Walk the full pipeline-stage chain each frame (60+ stage invocations)
- Build shader-builder defines / shader sources (GLSL builder output discarded)
- Allocate `DrawCommand` objects + their `derivedCommands` proliferation
- Participate in frustum culling passes (uses BV from derivedCommand)
- Take up command-list slots that get sorted

The CPU cost of rendering a single Model on WebGPU is therefore BOTH the WebGPU-path cost AND the WebGL-path cost — the fork pays double. Also: if any WebGL-shape DrawCommand inadvertently implements `execute()` in a way the WebGPU dispatch picks up (via RenderCommand abstraction), double-rendering occurs.

**Fix:** gate the `pushDrawCommands` call on `!frameState.context.isWebGPU`, OR make the WebGPU MODEL FR short-circuit by marking the model as handled.

---

### DP-C3. Imagery layer function-valued alpha/brightness/etc. produce NaN uniforms
**FIXED 2026-04-16 (Batch 4).** Added `resolveImageryLayerValue(value, default, frameState, layer, tile)` helper that branches on `typeof value === "function"` and invokes the callback with `(frameState, layer, x, y, level)` before writing to the Float32Array. Every per-layer read (alpha / brightness / contrast / saturation / dayAlpha / nightAlpha) now goes through it. Dynamic imagery fades (hover-fade, time-of-day, elevation-based) work on WebGPU identically to WebGL.

**Original finding — Verified.** [WebGPUGlobeSurfaceRenderer.ts:1908-1909](../packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts):
```ts
data[baseOffset + 8] = layer.alpha ?? 1.0;
data[baseOffset + 9] = layer.brightness ?? 1.0;
```
Per `ImageryLayer` JSDoc (constructor options), these properties can be set as either a scalar or a function `function(frameState, layer, x, y, level)`. When set as a function, `layer.alpha` is a `Function` object — truthy, passes `?? 1.0`, gets cast to `Number(function)` = `NaN` when assigned to a `Float32Array`. NaN propagates through blending → entire layer pixel becomes NaN → disappears.

Affected properties (public CesiumJS API): `alpha`, `brightness`, `contrast`, `saturation`, `hue`, `gamma`, `splitDirection`, `dayAlpha`, `nightAlpha`. All documented as function-or-scalar; all cast unconditionally on WebGPU.

This is a very common pattern — hover-fade, time-of-day fade, elevation-based fade. Any app using `layer.alpha = (frameState, layer) => smoothstep(...)` sees the imagery layer vanish on WebGPU.

**Fix:** every reader must be `typeof val === "function" ? val(frameState, layer, x, y, level) : (val ?? default)`.

---

### DP-C4. Quantized terrain oct-encoded normal in `compressed1` is never read
**FIXED 2026-04-16 (Batch 4).** Added `VertexInputQuantizedWebMercNormals` struct with `compressed0: vec4<f32>` + `compressed1: f32`, a new `vertexMainQuantizedWebMercNormals` entry point that passes `input.compressed1` to `processVertex` as the encoded normal, and pipeline-builder logic (in both `_createPipelineVariant` and `_createWireframePipelineVariant`) that detects `isQuantized && hasWebMercatorT && hasNormals` and adds a float32 attribute at location 1 with 4-byte stride extension. Quantized Cesium-ion + Bing terrain now lights correctly on WebGPU.

**Original finding — Verified by agent.** [TerrainEncoding.getAttributes()](../packages/engine/Source/Core/TerrainEncoding.js) splits attributes when `hasWebMercatorT && hasVertexNormals`: `compressed0.w` is consumed by the Mercator texcoord, so the oct-encoded normal must live in a separate single-component `compressed1` at location 1.

[WebGPUGlobeSurfaceRenderer.ts:688-701](../packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts) pipeline variant for this case declares only one attribute (`float32x4` at location 0). [GlobeTerrain.wgsl:448-457](../packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl) hardcodes `encodedNormal = 32896.0` (oct-encoding of (0, 0, 1) in the ECEF frame).

**User impact:** for the standard Cesium ion + Bing + quantized-mesh stack, terrain is lit as if the normal were always straight up in ECEF — flat-shaded, wrong terminator, wrong water mask illumination, wrong atmospheric extinction.

**Severity:** CRITICAL. This is the most common production terrain configuration.

**Fix:** add `compressed1` attribute at location 1 to the pipeline variant for this case; pass `input.compressed1.x` as `encodedNormal` to `processQuantized`.

---

### DP-C5. Quantized terrain height `zh.y` is decoded but thrown away; `minMaxHeight` never read
**FIXED 2026-04-16 (Batch 4).** Added `decodeQuantizedHeight(normalizedHeight) = normalizedHeight * (camera.minMaxHeight.y - camera.minMaxHeight.x) + camera.minMaxHeight.x` matching WebGL `GlobeVS.glsl:135`. Extended `processVertex` with a `precomputedHeight` parameter. All five vertex entry points now supply it: uncompressed paths pass `position3DAndHeight.w`; quantized paths pass `decodeQuantizedHeight(zh.y)`. Morph / Columbus / 2D branches use the precomputed height for `computePlanarPosition` instead of the big-minus-big `length(position3DWC) - EARTH_RADIUS`. Sub-meter tile-boundary drift on quantized terrain resolved.

**Original finding — Verified by agent.** [GlobeTerrain.wgsl:432-457](../packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl) decodes `zh = decompressTextureCoordinates(input.compressed0.y)`, uses `zh.x` for ENU-space Z, but `zh.y` (normalized `[0, 1]` height) is dropped. `CameraUniforms.minMaxHeight` is declared at line 54 but never read.

WebGL's `GlobeVS.glsl:135` does `height = height * (u_minMaxHeight.y - u_minMaxHeight.x) + u_minMaxHeight.x`. WebGPU recomputes height via `length(position3D) - EARTH_RADIUS` — which is hardcoded-Earth-radius-wrong for non-WGS84 AND loses sub-meter precision.

**User impact:** vertical exaggeration value is wrong at tile boundaries; water-mask alignment drifts; anything that consumes `v_height` (fog density, atmosphere depth, etc.) gets a roughly-correct but sub-meter-wrong value.

---

### DP-C6. glTF normalized integer attributes cast without dequantize — cascades beyond positions
**Verified.** [ModelPrimitiveGeometry.js:231-236](../packages/engine/Source/Scene/Model/ModelPrimitiveGeometry.js) `ensureFloat32()` does `new Float32Array(data)` — value cast, not dequantize. Applies to every attribute channel:

| Attribute | Common quantized type | Cast result | User visual |
|---|---|---|---|
| POSITION | INT16 with quantization.offset/stepSize | raw ints as f32, offset/stepsize dropped | geometry collapsed to origin, scale wrong |
| NORMAL | BYTE normalized | [-128, 127] instead of [-1, 1] | lighting blacked out / garbage |
| TANGENT | BYTE normalized | [-128, 127] + handedness as ±127 | normal mapping black |
| TEXCOORD_0 | UNSIGNED_BYTE normalized | [0, 255] instead of [0, 1] | textures repeat thousands of times |
| TEXCOORD_0 | UNSIGNED_SHORT normalized | [0, 65535] instead of [0, 1] | same, even more tiling |
| Morph POSITION/NORMAL | KHR_mesh_quantization applies | deltas scaled wrong | morph targets exaggerated |

KHR_mesh_quantization is near-universal in production tilesets (Google Photorealistic, most commercial pipelines use Draco + quantization). **Every such asset renders fundamentally wrong on WebGPU.**

**Fix:** either (a) honor `attribute.quantization.quantizedVolumeOffset/StepSize` in `extractFloat32`, or (b) preserve the quantized buffer format and match WebGPU `vertexFormat` (`snorm8x4`, `unorm16x2`, etc.). Option (b) is faster; option (a) is more broadly correct.

---

### DP-C7. `TEXCOORD_1` and per-slot `texCoord` index all dropped
**Verified by agent.** `ModelPBRComplete.wgsl` VertexInput declares a single `texCoord0: vec2<f32>`. glTF textureReaders each carry a `texCoord` int (0 or 1) — occlusion textures commonly use `TEXCOORD_1`, clearcoat normal maps frequently too. The WebGPU renderer does read `ensureFloat32(texCoord1Data)` but never uploads it; there's no slot in `primCache`. Every texture slot samples `texCoord0` regardless of the glTF's `texCoord` field.

**User impact:** occlusion blotches in the wrong places on every glTF with separate occlusion UVs (common). Normal maps smeared.

---

### DP-C8. glTF sampler properties (`magFilter`, `wrapS`, etc.) all ignored
**Verified.** [WebGPUModelPipelineCache.js:307-314](../packages/engine/Source/Renderer/WebGPU/WebGPUModelPipelineCache.js) `_defaultSampler` hardcodes `linear/linear/linear` with `repeat`. All 5 texture slots reuse this sampler. glTF per-texture sampler settings (`magFilter=NEAREST`, `wrapS=CLAMP_TO_EDGE`, `wrapS=MIRRORED_REPEAT`, `anisotropy=16`) never propagate.

**User impact:** pixel-art assets look blurry; clamp-sampled textures show seam artifacts at edges (e.g., UI-in-world projected textures); anisotropy missing means ground textures look smeared at grazing angles. Mipmaps never generated.

---

### DP-C9. sRGB decode is double-applied in the model shader
**Verified by agent.** [ModelPBRComplete.wgsl:308, 311](../packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.wgsl) does `srgbToLinear(tc.rgb) = pow(rgb, 2.2)`. Meanwhile [WebGPUModelRenderer.js:250](../packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.js) creates base color textures as `rgba8unorm` (not `rgba8unorm-srgb`). The texture stores sRGB-encoded bytes sampled linearly; the shader's `pow(x, 2.2)` applies the wrong approximation (WebGL uses proper piecewise `czm_srgbToLinear`).

Net effect: WebGPU renderings of the same glTF look slightly dimmer and more saturated-in-dark-mids than WebGL. Worse: if someone "fixes" by switching to `rgba8unorm-srgb`, the same uniform path applies to normal/MR/occlusion textures — those MUST stay linear. Then normals go blackish and MR roughness channel shifts.

**Fix:** select per-slot texture format (`rgba8unorm-srgb` for baseColor + emissive, `rgba8unorm` for normal + MR + occlusion) AND remove the in-shader `srgbToLinear` from the color-slot fetches.

---

### DP-C10. Material time uniforms never re-upload per frame
**FIXED 2026-04-16 (Batch 5).** Every material command now carries `_webgpuMaterialBuffer` and `_webgpuMaterialUB` references, and `updateWebGPUMaterialCommandUniforms` checks `matUB.isDirty` each frame \u2014 when set, it writes `matUB.gpuData` to the material UBO and calls `matUB.clearDirty()`. Animated water, flowing dash, glowing polyline and other time-varying materials now animate instead of freezing on frame 1.

**Original finding \u2014 Verified.** [WebGPUPrimitiveCommands.js:1412-1419](../packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js) uploads `matUB` on `isDirty`, but only inside `createMaterialCommands`. `Primitive.update` only calls that on initial creation or appearance change (`needsCommands` goes false after frame 1). `updateMaterialCommandUniforms` at [line 1636-1664](../packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js) only rewrites the camera buffer — never touches the material UBO.

**User impact:** every animated material freezes after frame 1 on WebGPU. Water shader doesn't flow. Fade doesn't animate. PolylineDash pattern stops scrolling. The feature is visually broken.

**Fix:** move the `matUB.isDirty` check + upload from `createMaterialCommands` into `updateMaterialCommandUniforms`.

---

### DP-C11. Pick framebuffer reads from origin (0, 0), not the user's click
**FIXED 2026-04-16 (Batch 5).** `WebGPUPickFramebuffer` now captures the scissor origin in `begin()` as `_pickOriginX/Y` and every `copyTextureToBuffer` call (sync `end`, async `endAsync`, and `_startReadback`) passes `origin: [_pickOriginX, _pickOriginY, 0]` on the texture descriptor. Picking works at any click location on the canvas, not just near (0, 0). `readDepthPixelAsync` was already correct and stays untouched.

**Original finding \u2014 Verified.** [WebGPUPickFramebuffer.ts:273-278, 342-347, 420-430](../packages/engine/Source/Renderer/WebGPU/WebGPUPickFramebuffer.ts) — three `copyTextureToBuffer` calls, none specifies a `texture.origin` offset. The copy always starts from the top-left of the pick FBO.

If the user clicks at (250, 300) in a 1920×1080 viewport, either (a) the pick FBO was rendered full-size and the copy+map reads pixel (0, 0) which has nothing → pick returns `undefined`, or (b) the pick FBO was rendered only around the click region (viewport+scissor at 250, 300), but the `copyTextureToBuffer` origin is (0, 0) — also reads empty.

**User impact:** `scene.pick(mousePosition)` works *only* when clicking near (0, 0). Every other click returns `undefined`. This is the largest picking regression on WebGPU.

**Fix:** pass `texture: { origin: { x: pickRect.x, y: pickRect.y } }` to `copyTextureToBuffer`, or use the smaller-pick-rect rendering approach.

---

## HIGH findings

### Data drops across feature renderers

**DP-H1. Billboard `horizontalOrigin` / `verticalOrigin` never packed.** **DEFERRED (Batch 3).** Requires adding instance attribute slot + shader logic to shift the quad by origin flags. Packing without a shader consumer would be dead plumbing; tracked for a Billboard shader-parity batch. [WebGPUBillboardRenderer.js:83-117](../packages/engine/Source/Renderer/WebGPU/WebGPUBillboardRenderer.js) packs `(pixelOffset.x, pixelOffset.y, 0, 0)`. WebGL packs origin flags into bit-shifted slots of `compressed0`. Every billboard anchors at the default corner regardless of user setting. Apps placing billboards at map features will see every one offset by ~half-a-quad from where it should be.

**DP-H2. Billboard `alignedAxis` hardcoded to 0.** **FIXED 2026-04-16 (Batch 3).** `buildInstanceData` and `buildPickInstanceData` now pack `bb._alignedAxis.x/y` into `compressedAttr0.zw` (the slot already reserved in the shader struct). Shader-side consumption to apply world-axis rotation is a follow-up; data plumbing is in place. Same file, line 87-88: `instanceData[offset+10] = 0.0; instanceData[offset+11] = 0.0;`. World-axis billboards (flag poles, direction chevrons) are silently forced to screen-aligned.

**DP-H3. EntityCluster `clusterShow` not read.** **FIXED 2026-04-16 (Batch 3).** Both `buildInstanceData` and `buildPickInstanceData` now skip billboards whose `_clusterShow === false`. EntityCluster-folded billboards no longer pile up behind the cluster glyph. [WebGPUBillboardRenderer.js:63](../packages/engine/Source/Renderer/WebGPU/WebGPUBillboardRenderer.js) reads only `bb.show`. WebGL reads `bb.show && bb.clusterShow`. When EntityCluster is active, all member billboards render simultaneously alongside the cluster billboard — a pile of overlapping markers.

**DP-H4. Billboard atlas sub-region fallback samples whole atlas.** [WebGPUBillboardRenderer.js:92-103](../packages/engine/Source/Renderer/WebGPU/WebGPUBillboardRenderer.js) — `_imageSubRegion || _textureCoordinateBoundsOrImageIndex`. When `_imageSubRegion` isn't set (the normal `billboard.image = "foo.png"` path), the fallback branch returns `(0, 0, 1, 1)`. Even once B-6 (atlas placeholder) is fixed, every billboard samples the entire atlas instead of its assigned icon region. Every icon shows every icon.

**DP-H5. Label `backgroundColor`/`backgroundPadding` dropped.** [WebGPULabelRenderer.js:424-429](../packages/engine/Source/Renderer/WebGPU/WebGPULabelRenderer.js) routes `_backgroundBillboardCollection` through the Billboard FR. Billboard FR has no per-billboard solid-color quad mechanism; background billboards render as white rectangles regardless of user `backgroundColor`.

**DP-H6. Label has no pick path.** Entire renderer lacks pick command generation. `scene.pick()` on any label glyph returns `undefined`.

**DP-H7. Polyline `followSurface` / `arcType: GEODESIC` silently straight-lines.** [WebGPUPolylineRenderer.js:159-233](../packages/engine/Source/Renderer/WebGPU/WebGPUPolylineRenderer.js) emits one GPU segment per adjacent position pair. WebGL subdivides geodesics. A polyline from Pittsburgh to Tokyo on WebGPU is a straight chord through the Earth — crosses the surface underground.

**DP-H8. Polyline `loop: true` doesn't close.** Segment loop runs `j < positions.length - 1`. Closing segment missing.

**DP-H9. Point `disableDepthTestDistance` dropped.** [WebGPUPointPrimitiveRenderer.js:190-199](../packages/engine/Source/Renderer/WebGPU/WebGPUPointPrimitiveRenderer.js) instance layout has 64 bytes: `posHighAndSize / posLowAndOutline / color / outColorAndShow`. No slot for `disableDepthTestDistance`. Pipeline always depth-tests. 3D pin stacks sink into terrain.

**DP-H10. Point `heightReference` / clamp-to-ground not honored.** Relies on `_actualPosition` being set by the clamp system; WebGPU never wires this.

**DP-H11. CloudCollection `cloud.show` not read.** [WebGPUCloudRenderer.ts:163-194](../packages/engine/Source/Renderer/WebGPU/WebGPUCloudRenderer.ts) — no per-cloud show gate. Setting `cloud.show = false` has zero effect on WebGPU.

**DP-H12. CloudCollection has no pick path, `cloud.maximumSize` dropped, `slice` packed but unused.** Full audit in agent's matrix.

---

### Dirty-tracking collapses

**DP-H13. No collection-level dirty-range precision.** Billboard / Label / Cloud walk the full `_billboards` array and rewrite the full instance Float32Array every frame where visibility might change. Editing 1 billboard in a 10,000-billboard collection pays 10,000 × 96B = 960 KB/frame CPU + 960 KB/frame upload regardless of what changed. Point has a `needsRebuild` gate but still uploads the whole buffer. BufferPrimitive tracks a dirty range for CPU work but still `writeBuffer`s from offset 0 to full byteLength.

**DP-H14. `_billboardsToUpdate` never cleared on WebGPU.** [BillboardCollection.js](../packages/engine/Source/Scene/BillboardCollection.js) maintains the array but the WebGPU path never reads or clears. In split-screen (WebGL+WebGPU) the array grows unbounded.

**DP-H15. BufferPolyline vertex-offset invalidation missing.** [WebGPUBufferPrimitiveRenderer.ts:1014](../packages/engine/Source/Renderer/WebGPU/WebGPUBufferPrimitiveRenderer.ts) — when polyline #3's vertex count changes, polylines 4..N have stale `vertexOffset` but the repack only visits dirty polylines. Appending a vertex to #3 silently corrupts indices for #4..N.

---

### Primitive / Material

**DP-H16. Material BLEND pipelines have no blend state.** [WebGPUPrimitiveCommands.js:514-524, 1148-1157](../packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js) builds pipelines with no `blend` descriptor regardless of `appearance.translucent`. Translucent primitives get queued into `Pass.TRANSLUCENT` (slot selection works) but the pipeline itself has blend DISABLED. The fragment overwrites the destination. Every translucent Primitive + PerInstanceColor + MaterialAppearance is wrong on WebGPU — alpha is baked into RGB but compositing never happens.

**DP-H17. `twoPasses` back-face-then-front-face collapsed into one.** WebGL's `closed && translucent` appearance emits two commands with opposite cull. WebGPU iterates `geometries.length` once and renders with `cullMode: "none"`. Closed translucent volumes (semi-transparent boxes, ellipsoids) composite in wrong Z order.

**DP-H18. `depthFailAppearance` entirely unimplemented.** WebGL builds a twin shader + pipeline + uniforms. WebGPU has no grep hit for `depthFail`. See-through highlighting primitives broken.

**DP-H19. `compressVertices: true` (default) produces garbage geometry.** [WebGPUPrimitiveCommands.js:94-147](../packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js) `extractPositionData` assumes `Float32Array` but when `compressVertices` is on, the attribute is `UNSIGNED_SHORT normalized`. The encoder interprets raw u16 values as doubles. Default Primitive configuration (compress=true) breaks on WebGPU unless the app explicitly sets `compressVertices: false`.

**DP-H20. Material secondary textures (`normalMap`, `bumpMap`) dropped.** [WebGPUPrimitiveCommands.js:971-976](../packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js) `getTextureUniformName` returns a single name. Bind group group(2) has exactly 1 sampler + 1 texture. Multi-texture materials (NormalMap + DiffuseMap, BumpMap + base) lose the secondary texture entirely — shader samples only `image`.

**DP-H21. Material texture wrap-mode always `"repeat"`.** [WebGPUPrimitiveCommands.js:1015-1021](../packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js) hardcodes `addressModeU/V: "repeat"`. Material fabric can specify `{ repeat: { x: false, y: false } }` — silently overridden to repeat. Single-tile image materials wrap at edges when they should clamp.

**DP-H22. Several materials fall through to Color default.** `selectMaterialShader` handles ~19 materials; missing: `ElevationBand`, `PolylineArrow`, `PolylineDash`, `PolylineGlow`, `PolylineOutline`. Users setting `material: Material.fromType("PolylineGlow", ...)` get a plain colored polyline. Not the claimed "25 materials" from WIRING_AUDIT.

**DP-H23. Fade / Grid / Checkerboard / Stripe / Dot WGSL implementations diverge from GLSL.** Different math produces different visuals. E.g., Fade in WGSL is a radial gradient from texture center; GLSL Fade is UV-anchor-driven with repeat. Grid WGSL uses `step`; GLSL uses `smoothstep` with derivative antialiasing. Visual mismatch.

---

### Globe + Imagery data drops

**DP-H24. Globe hue/saturation/brightness shift dropped.** [GlobeFS.glsl:98-100](../packages/engine/Source/Shaders/GlobeFS.glsl) uses `u_hsbShift`. WebGPU has zero grep hits. `globe.hueShift = 0.1` is a no-op.

**DP-H25. Geodetic surface normal attribute never uploaded.** Stride allocates the 3 floats but the pipeline variant doesn't declare the attribute. Exaggeration math falls back to `normalize(position3D)` which drifts from the true geodetic normal by up to 0.2° at high latitudes on WGS84.

**DP-H26. Atmosphere tuning knobs (Mie / Rayleigh / scaleHeights / intensity / dynamicAtmosphereLighting) all dropped.** [GlobeSurfaceTileProviderRendering.js:1160-1171](../packages/engine/Source/Scene/GlobeSurfaceTileProviderRendering.js) writes all 8 to WebGL uniforms; WebGPU reads none. `computeAtmosphereColor` hardcodes sky-blue, Mie `g = 0.76`.

**DP-H27. `showGroundAtmosphere` / `lightingFadeDistance` / `nightFadeDistance` / `lambertDiffuseMultiplier` / `vertexShadowDarkness` / `initialColor` / `fillHighlightColor` — all dropped.** Long tail of globe-level tuning uniforms silently zeroed.

**DP-H28. Shadow matrix never populated unless clipping planes active.** [WebGPUGlobeSurfaceRenderer.ts:1218-1221](../packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts) — `createEffectsBindGroup` only invoked when `tileProvider.clippingPlanes.length > 0`. Otherwise `placeholderEffectsBG` is bound with `shadowDarkness = 1.0` (fully lit, skip). Globe receives no shadows unless clipping planes happen to be active.

**DP-H29. Clipping polygons on globe sample SDF via `atan2(posMC.y, posMC.x)` mid-triangle.** At antimeridian crossings atan2 jumps −π↔+π mid-triangle, SDF samples wrap-around texels. Clipping polygons straddling 180° render wrong.

**DP-H30. Water mask sampler hardcoded to nearest + clamp.** WebGL uses linear for smooth coastlines. WebGPU `smoothstep(0.3, 0.7, waterMask)` can't smooth a binary sample. Jagged coastlines.

**DP-H31. Wave clock uses `performance.now()`, not `frameState.time`.** [WebGPUGlobeSurfaceRenderer.ts:2093](../packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts) — multi-view renders desync; screenshots non-deterministic.

---

### glTF Model data drops

**DP-H32. Light uniforms hardcoded; IBL factors are zero.** **FIXED 2026-04-16 (Batch 1).** `LIGHT_UNIFORM_SIZE` expanded from 48 to 64 bytes to match the WGSL `LightUniforms` struct. `packLightUniforms` now writes all 16 floats including `iblDiffuseFactor` (from `model._imageBasedLighting._imageBasedLightingFactor.x`), `iblSpecularFactor` (`.y`), `iblMaxMipLevel` (from the specular env map atlas, defaults 8.0), and `iblHasSH` (1.0 when SH coefficients are present). Models without an IBL object still get a sensible `1.0` default so the ambient term isn't silently zeroed.

**Original finding — Verified.** [WebGPUModelRenderer.js:202-217](../packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.js) `packLightUniforms` writes `sunColor = (1,1,1)`, `ambient = (0.2, 0.2, 0.2)`, but leaves `iblDiffuseFactor / iblSpecularFactor / iblMaxMipLevel / iblHasSH` (the last 4 fields of the WGSL struct at lines 106-109) completely unwritten — reads garbage/zero. Shader at lines 475, 481: `diffuseIBL = ambient * diffuseColor * 0`, `specularIBL = ambient * kS * specAttenuation * 0`. **WebGPU model rendering has NO IBL ambient contribution.** Explains why split-screen comparisons show WebGPU models flatter than WebGL.

**DP-H33. `scene.light.color` ignored entirely.** **FIXED 2026-04-16 (Batch 1).** `packLightUniforms` now reads `frameState.light.color` (public Scene API, Color with red/green/blue/alpha) into the `sunColor` vec3. Falls back to white when unset. `scene.light = new SunLight({ color: Color.ORANGE })` now tints models as it does in WebGL.

**Original finding — Verified.** Even though UniformState has the sun color at `sunColor`, model path hardcodes `(1, 1, 1)`.

**DP-H34. Pick command not emitted for Models.** Prior review noted this at command level; confirmed at data level — `WebGPUModelFeatureId.ensureFeatureIdResources` never builds a pick-ID path, `updateWebGPUModel` has no `webgpuCmd.pickCommand` emission. Clicks on 3D Tiles features miss.

**DP-H35. Morph target NORMAL deltas dropped.** [WebGPUModelMorphTargets.ts:109-135](../packages/engine/Source/Renderer/WebGPU/WebGPUModelMorphTargets.ts) packs only `.positionData`; `ModelPrimitiveGeometry.js:167` reads `morphTarget.normalData` but it's never uploaded. Morph-animated characters with per-target normal deltas light incorrectly — normals stay on the rest pose while positions deform.

**DP-H36. Instance translation not split for RTE.** [WebGPUModelInstancing.js:106-147](../packages/engine/Source/Renderer/WebGPU/WebGPUModelInstancing.js) writes the translation column as raw f32. For an instance at ECEF (`(4205000, 171000, 4779000)` — > 2²²), sub-meter precision lost. Instanced 3D Tiles trees visibly jitter when camera stationary.

**DP-H37. `COLOR_0` as `VEC3` reads past buffer end for `.a`.** [WebGPUModelPipelineCache.js:146-150](../packages/engine/Source/Renderer/WebGPU/WebGPUModelPipelineCache.js) pipeline declares `float32x4`; if glTF source is VEC3, the Float32Array output has `vertexCount * 3` elements, shader reads `.a` as the next vertex's `.r` — flickery alpha that tracks vertex shuffling.

---

### UniformState / picking / cross-cutting

**DP-H38. `CAMERA_RTE_LIT` profile omits `csm_lightColor`.** [WebGPUAutoUniforms.js:586](../packages/engine/Source/Renderer/WebGPU/WebGPUAutoUniforms.js) — profile has direction but no color. All lit primitives get direction with intensity-less light.

**DP-H39. `UniformState._lightsData` packed but no WGSL binding consumes it.** Multi-light path (`scene.lights` array) reaches no renderer. Upstream KHR_lights_punctual chain dead at uniform layer too (even beyond the WGSL shader drop).

**DP-H40. `frameState.splitPosition` only read by point renderer.** Split-screen imagery / billboard split / polyline split all ignore the user setting.

**DP-H41. `previousViewProjection` not exposed to `csm_*` uniforms.** TAA motion vector pipeline blocked at the uniform layer before the algorithm begins. Composes with TAA_DESIGN.md being dormant.

**DP-H42. `frameState.minimumDisableDepthTestDistance` unreachable by any WebGPU renderer.** Billboard/label depth override gone.

**DP-H43. `frameState.shadowState.lightShadowsEnabled` ignored.** Shadow cast pass runs even when user disabled shadows (`viewer.shadows = false`).

**DP-H44. Globe surface has no pick ID generation.** Terrain tiles are invisible to `scene.pick`. Only models/primitives/collections (the few with pick paths) return hits.

**DP-H45. `scene.pickPosition` returns Cartesian only over the globe.** [PickDepth.js:100-109](../packages/engine/Source/Scene/PickDepth.js) — `_asyncDepthTexture` is only set by `WebGPUGlobeDepth`; Model/Primitive/Tile depth never routes through it. Depth unprojection silently falls back to terrain-only.

**DP-H46. `scene.pickMetadata` entirely unwired on WebGPU.** `frameState.pickingMetadata` is read nowhere. Public API `pickMetadata()` returns null.

**DP-H47. `czm_atmosphere*` suite entirely absent from `csm_*`.** All atmosphere-tuning auto-uniforms unavailable; atmosphere-sensitive renderers (SkyAtmosphere, GroundAtmosphere, VolumetricFog) each hand-roll their own and pull from `frameState.atmosphericConditions` directly — inconsistent between renderers.

**DP-H48. `temeToPseudoFixed` never reaches a shader.** Star-field / skybox uses equinox-aligned basis instead of the rotating TEME→pseudofixed transform. Stars don't rotate with Earth day-cycle.

---

## MEDIUM findings

- **DP-M1.** WGSL uniform struct alignment is inferred at runtime but WGSL struct declarations are static — silent mismatch if uniform order changes. Need an assert.
- **DP-M2.** Pick color uploaded once at creation; not refreshed on pick-ID rebuild (device loss, entity rebuild).
- **DP-M3.** Index-buffer width probed by O(N) linear scan instead of `indices.BYTES_PER_ELEMENT`.
- **DP-M4.** `primitive.allowPicking` toggled post-frame-1 doesn't rebuild pipeline.
- **DP-M5.** EDL noise texture is deterministic mod-256 garbage, not noise.
- **DP-M6.** `Cesium3DTileStyle show=false` with tiny-alpha style fights the `batchColor.a < 0.004` discard.
- **DP-M7.** AutoUniforms registered but never in any profile: `csm_frameNumber`, `csm_morphTime`, `csm_sceneMode`. Time-varying materials on billboard/polyline/point/model/globe are dead (only flat primitive sees them).
- **DP-M8.** Globe tile center3D offset: `_computeModifiedModelView` uses `surfaceTile.center` but vertex positions are encoded against `encoding.center` — few meters drift at tile boundaries on TerrainFillMesh / upsampled meshes.
- **DP-M9.** Pick FBO full-viewport allocation when most apps only need a ~10×10 region around cursor. Wasteful but not a correctness bug alone.
- **DP-M10.** `scene.pick` sync pick returns 1-frame-stale result under `WebGPUPickFramebuffer._lastReadPixels`.
- **DP-M11.** `_startReadback` re-entry under rapid clicks: mapAsync-already-mapped throws caught silently, returns stale pixels.
- **DP-M12.** Multiple `"bgra8unorm"` literal fallbacks (vs `getPreferredCanvasFormat`) — 7 sites.
- **DP-M13.** WebGPUInvertClassification `frameState.invertClassification` flagged but never dispatched in `executeCommands` (reconfirms B-5 at uniform level).
- **DP-M14.** Polyline miter limit hardcoded to 2.0; WebGL adapts.
- **DP-M15.** AtmosphericConditions scale-heights hardcoded Earth; Mars/Titan break (additional lever beyond H-P7 radii).

---

## Data pipeline coverage matrices

### Collection renderers — per-property coverage

Legend: ✓ honored / ∅ dropped / ~ partial / — N/A

| Property | Billboard | Label (glyph) | Polyline | Point | Cloud | BufferPrim |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| position | ✓ RTE | ✓ RTE | ✓ RTE | ✓ RTE | ✓ RTE | ✓ RTE |
| color | ✓ | ✓ | ✓ | ✓ | ✓ | ~ |
| show | ✓ | ✓ | ✓ | ~ | ∅ | ✓ |
| scale | ✓ | ✓ | — | — | — | — |
| rotation | ✓ | ✓ | — | — | — | — |
| pixelOffset | ✓ | ✓ | — | — | — | — |
| pixelOffsetScaleByDistance | ∅ | ∅ | — | — | — | — |
| scaleByDistance | ∅ | ∅ | — | ∅ | — | — |
| translucencyByDistance | ∅ | ∅ | — | ∅ | — | — |
| distanceDisplayCondition | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ |
| disableDepthTestDistance | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ |
| alignedAxis | ∅ | ∅ | — | — | — | — |
| horizontalOrigin | ∅ | ∅ | — | — | — | — |
| verticalOrigin | ∅ | ∅ | — | — | — | — |
| image subregion | ~ wrong fallback | ~ wrong fallback | — | — | — | — |
| heightReference | ∅ | ∅ | — | ∅ | ∅ | — |
| clusterShow | ∅ | ∅ | — | — | — | — |
| Pick | ✓ | ∅ **no pick** | ✓ | ✓ | ∅ **no pick** | ~ |
| eyeOffset | ∅ | ∅ | — | — | — | — |
| followSurface / arcType | — | — | ∅ | — | — | — |
| loop | — | — | ∅ | — | — | — |
| maximumSize (Cloud) | — | — | — | — | ∅ | — |
| slice (Cloud) | — | — | — | — | ~ | — |
| BackgroundColor (Label) | — | ∅ | — | — | — | — |
| Style enum (Label) | — | ~ | — | — | — | — |
| Time-varying material | — | — | ∅ freezes | — | — | — |

### Imagery layer properties — per-layer coverage

| Property | WebGL | WebGPU |
|---|:---:|:---:|
| alpha (scalar) | ✓ | ✓ |
| alpha (function callback) | ✓ | ✗ **NaN** |
| brightness | ✓ | ✗ NaN if function |
| contrast | ✓ | ✗ NaN if function |
| saturation | ✓ | ✗ NaN if function |
| hue | ✓ | ∅ not packed at all |
| gamma | ✓ | ∅ not packed |
| splitDirection | ✓ | ∅ not packed |
| colorToAlpha | ✓ | ∅ |
| cutoutRectangle | ✓ | ∅ |
| dayAlpha / nightAlpha | ✓ | ~ scalar-only, NaN if function |
| max layer count | ~ 31 | 4 (hardcoded) |

### glTF attribute coverage

| Attribute | WebGPU up-cast | User impact |
|---|---|---|
| POSITION f32 | ✓ | OK |
| POSITION + KHR_mesh_quantization | ✗ offset/stepsize dropped | collapsed geometry |
| NORMAL f32 | ✓ | OK |
| NORMAL BYTE normalized | ✗ [-128,127] not [-1,1] | lighting broken |
| TANGENT f32 | ✓ | OK |
| TANGENT BYTE normalized | ✗ | normal mapping broken |
| TEXCOORD_0 f32 | ✓ | OK |
| TEXCOORD_0 u8 normalized | ✗ [0, 255] not [0, 1] | textures tile 1000× |
| TEXCOORD_1 | ✗ never uploaded | occlusion wrong UVs |
| COLOR_0 VEC3 | ✗ reads past buffer for .a | flickery alpha |
| JOINTS_0 | ✓ | OK |
| WEIGHTS_0 | ✓ | OK |
| Morph POSITION | ✓ | OK |
| Morph NORMAL | ✗ never uploaded | lighting freezes in rest pose |

### 3D Tiles styling end-to-end

| Step | WebGL | WebGPU |
|---|:---:|:---:|
| Style expression parsed | ✓ (shared) | ✓ (shared) |
| Per-feature (color, show) evaluated | ✓ | ✓ |
| `_batchValues` buffer updated | ✓ | ✓ |
| Batch texture GPU upload | ✓ | ✗ **never** (DP-C1) |
| `FLAG_HAS_BATCH_TABLE` set on model | ✓ | ✗ |
| Shader samples batch texture | ✓ | ✗ falls through to white |

---

## Recommended sequencing (composes with prior reviews)

Most fixes are small and localized; the volume is the issue.

### Tier DP0 — Fix the silently broken popular cases (1-2 weeks)

1. **DP-C1** 3D Tiles batch texture upload — unblocks styling entirely.
2. **DP-C2** Gate `_sceneGraph.pushDrawCommands` on `!isWebGPU` — halves Model CPU cost.
3. **DP-C3** Imagery function-callbacks — `typeof === "function"` resolution at pack time.
4. **DP-C4** Quantized terrain `compressed1` normal attribute — unblocks Cesium ion + Bing lighting.
5. **DP-C6** glTF quantized attributes dequantize — unblocks Google Photorealistic + commercial tilesets.
6. **DP-C10** Material time uniform re-upload — unblocks every animated material.
7. **DP-C11** Pick framebuffer texture origin — unblocks picking anywhere outside (0, 0).

### Tier DP1 — Fix the widely-used drop list (2-3 weeks)

8. **DP-H1/H2** Billboard origin flags + alignedAxis packing.
9. **DP-H3** EntityCluster `clusterShow`.
10. **DP-H4** Billboard atlas sub-region fallback fix.
11. **DP-H7/H8** Polyline geodesic subdivision + loop closure.
12. **DP-H9/H10** Point `disableDepthTestDistance` + heightReference.
13. **DP-H11/H12** Cloud show / pick / `maximumSize`.
14. **DP-H13** Dirty-range precision sweep across all collection renderers.
15. **DP-H16** Material blend state wired from `appearance.translucent`.
16. **DP-H18** `depthFailAppearance` twin pipeline.
17. **DP-H19** `compressVertices: true` dequantize (or update the default to `false` with a warning).
18. **DP-H20/H21** Material secondary textures + per-channel wrap mode.

### Tier DP2 — Fix the globe/model/uniform long tail (2-3 weeks)

19. **DP-C5** Quantized terrain `minMaxHeight` remap.
20. **DP-C7** TEXCOORD_1 plus per-slot texCoord index.
21. **DP-C8** glTF samplers + mipmap generation + anisotropy.
22. **DP-C9** Per-slot sRGB texture format (base color / emissive vs normal / MR / occlusion).
23. **DP-H24..H31** Globe tuning uniform sweep (hueShift, atmosphere knobs, initialColor, fillHighlightColor, shadowDarkness, lightingFadeDistance, clipping polygon antimeridian, water-mask filter, wave clock).
24. **DP-H32/H33** Model light uniform pack: write IBL factors, use `scene.light.color`.
25. **DP-H34** Model pick command emission.
26. **DP-H35** Morph normal deltas upload.
27. **DP-H36** Instance translation RTE split.
28. **DP-H37** COLOR_0 vec3 path.

### Tier DP3 — Picking + uniform coverage (2 weeks)

29. **DP-H6** Label pick IDs.
30. **DP-H44** Globe surface pick IDs.
31. **DP-H45** `pickPosition` for non-globe content — route Model/Primitive/Tile depth through `PickDepth._asyncDepthTexture`.
32. **DP-H46** `scene.pickMetadata` — add `pickMetadata` branch to pick dispatch.
33. **DP-H38** `CAMERA_RTE_LIT` profile — add `csm_lightColor`.
34. **DP-H39** Multi-light upload path.
35. **DP-H40** `splitPosition` propagation to all primitive types.
36. **DP-H41** `previousViewProjection` auto-uniform (unblocks TAA Phase 1).
37. **DP-H42/H43** `minimumDisableDepthTestDistance` + `shadowState.lightShadowsEnabled` propagation.
38. **DP-H47** `czm_atmosphere*` → `csm_*` mapping for consistency across renderers.

### Tier DP4 — Polish (multi-session)

39. **DP-H22/H23** Missing materials + WGSL-vs-GLSL material math parity.
40. **DP-H14/H15** Collection-level dirty propagation across context-hot-swaps and BufferPrimitive vertex-offset invalidation.
41. **DP-M1** WGSL struct alignment runtime assertion in debug builds.
42. **DP-H48** TEME→pseudofixed to star-field shader.

---

## Combined total — four reviews 

Aggregated across the four 2026-04-16 reviews:

| Tier | Count |
|---|:---:|
| CRITICAL / BLOCKER | ~38 |
| HIGH | ~80 |
| MEDIUM | ~50 |
| LOW | ~20 |

Roughly **~190 findings total** describing the gap between the WebGPU fork today and a genuine drop-in-replacement state. Many compose (fix one, cascades into resolving 3-5 others). Many are one-line changes. But the volume is what it is.

**Revised estimate:** ~14-18 weeks of focused engineering. Earlier reviews estimated 4-6 weeks (architecture) + 4-6 weeks (per-feature correctness). This review adds another 6-8 weeks (data pipeline). The cumulative total is in that 14-18 week range.

The architecture is still correct. The execution is substantially under-implemented. The fork has shipped the scaffolding and enough of each feature to appear to work; this review shows that "appear to work" is doing a lot of load-bearing work.

---

## Appendix: Verifications

I first-hand verified the four highest-impact DP-C findings via direct grep + code read:

1. `BatchTexture._batchValues` upload path at [BatchTexture.js:558](../packages/engine/Source/Scene/BatchTexture.js) — verified ✓
2. `Model.js:3126+3129` dual-path calls — verified ✓
3. `WebGPUGlobeSurfaceRenderer.ts:1908-1909` function-valued callback NaN — verified ✓
4. `WebGPUPickFramebuffer.ts:273/278, 342/347, 420/430` copyTextureToBuffer without origin — verified ✓

The remaining DP-C / DP-H findings rely on the agents' reads; I sampled several and found the code matched the agents' citations. Confidence on CRITICAL tier is high; HIGH tier sampled at ~20%.

---

*Report prepared 2026-04-16. This is the fourth and final review in the 2026-04-16 series. Combined with the prior three reviews, the overall finding set describes the state of the fork on that date. All line numbers valid at that date. Re-verify before acting on stale references.*
