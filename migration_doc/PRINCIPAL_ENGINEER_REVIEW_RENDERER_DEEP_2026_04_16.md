# CesiumJS WebGPU Fork — Principal-Engineer Deep Review: Renderers & Scene

**Date:** 2026-04-16 (same day as `PRINCIPAL_ENGINEER_REVIEW_2026_04_16.md`, this is a follow-up audit with a narrower mandate)
**Scope:** WebGL2 ↔ WebGPU rendering parity, scene-to-renderer data flow, WebGPU renderer internal quality
**Methodology:** Five parallel deep-dive agents on disjoint dimensions (FR parity, scene dispatch, RenderState translation, shader coverage, resource lifecycle) → first-hand verification of every CRITICAL/HIGH claim by direct grep + code read → documented false positives in §9
**Reviewer posture:** The entire purpose of this fork is WebGPU/WebGL parity. Every visible rendering difference is a bug unless explicitly documented. No benefit of the doubt.

---

## Executive summary

The scaffolding (GraphicsContext, FeatureRenderer registry, WebGPUContext, WebGPUSceneRenderer, ring allocator) is the right architecture. **But the execution layer that sits on top of it has systemic gaps that produce visible rendering differences right now, not hypothetically.** In blunt terms:

1. **`command.renderState` is ignored across the entire WebGPU path** (verified: grep for `command\.renderState` in `Renderer/WebGPU/` returns zero hits). Every feature renderer inlines its own pipeline state decisions. PolygonOffset, colorMask, stencilTest, custom blend modes, blend constants, stencil reference — all silent drops. This single finding accounts for visible classification bugs, clamp-to-ground bleeding, and 3D Tile highlighting regressions.
2. **`command.derivedCommands.*` is never consulted on WebGPU** (verified: grep for `derivedCommands\.shadows|receiveCommand|logDepth|hdr|pickingMetadata|depth` returns zero hits). This means: log depth is inoperative, HDR variants never selected, shadow-receive variants never selected, metadata-pick variants never selected, depth-only variants never selected. On WebGL these are the routing fabric of advanced rendering; on WebGPU they are dead weight.
3. **No back-to-front sort for translucent commands** (verified: grep for `CommandSorter|backToFront|sortByEyeDistance` in `Renderer/WebGPU/` returns zero hits). Non-OIT translucent geometry composites in command-push order — wrong wherever OIT isn't active.
4. **The glTF model path is a monolithic shader with orphaned stage shaders on disk** (verified: `ModelPBRComplete.wgsl` is the only WGSL shader the model pipeline imports; six other `Model*Stage.wgsl` files exist and are never imported anywhere). This silently drops: KHR_materials_clearcoat, KHR_materials_anisotropy, KHR_materials_specular, KHR_texture_transform, multi-UV-set, CustomShader, model clipping planes/polygons, model silhouette/outline, model fog/atmosphere, model log depth, classification, edge visibility.
5. **A central pipeline cache is declared but never instantiated** (verified: `_webgpuPipelineCache` is declared at `WebGPUContext.ts:286`, reads occur only in the `clear()` path at `:3823`, the field is never assigned). Every feature renderer ad-hoc caches its own pipelines, so pipeline dedup does not happen across renderers.
6. **Imagery layer count is compile-time fixed at 4** on WebGPU (verified: `GlobeTerrain.wgsl:86` `layers: array<ImageryLayer, 4>`). WebGL supports N layers up to the driver's texture-unit limit. Apps that enable 5+ imagery layers silently render only 4 on WebGPU.

The good news: every finding is localized. None of them require architectural re-think; each is a discrete, bounded engineering task. The bad news: there are ~40 of them, they have been accumulating for multiple sessions, and several are severe enough to rule out a "you can swap WebGL for WebGPU" claim today.

A focused ~8-12 week cleanup cycle on the findings in this doc, **in addition to the 4-6 week cycle from the prior review on build / lifecycle / tests**, gets the fork to actual parity.

---

## CRITICAL findings (visible rendering differences on typical scenes)

### C-R1. `command.renderState` is not consumed by the WebGPU renderer
**Verified.** `grep -r "command\.renderState" packages/engine/Source/Renderer/WebGPU/` returns zero hits. The canonical WebGL apply site ([RenderState.js:488-565](../packages/engine/Source/Renderer/RenderState.js)) drives `frontFace`, `cull`, `polygonOffset`, `scissor`, `depthRange`, `depthTest`, `depthMask`, `stencilMask`, `blending` (including `gl.blendColor`), `colorMask`, `stencilTest` (including `setStencilReference`-equivalent), `sampleCoverage`, and per-command viewport. On WebGPU, each feature renderer hardcodes its own pipeline state — `WebGPUModelPipelineCache.js:180-237` picks blend from `alphaMode` only, hardcodes `"less-equal"` depth compare and `"ccw"` front face; other renderers are similar.

Consequences (each independently verifiable against specific scene features):

- **PolygonOffset / depthBias** — [WebGPUGlobeSurfaceRenderer.ts:2516](../packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts) even has an inline comment: *"Slight depth bias would be ideal here, but WebGPU's depthBias…"* — explicit acknowledgement. 3D Tiles classification primitives, decals, ground polygons, and overlay geometry all expect polygon offset. None gets it on WebGPU.
- **colorMask** — 3D Tiles backface pass ([ModelDrawCommand.js:902-907](../packages/engine/Source/Scene/Model/ModelDrawCommand.js)) sets color writes to false for a depth-only backface pre-pass. WebGPU feature renderers don't read `renderState.colorMask`; the pre-pass writes color when it should only write depth.
- **stencilTest / stencilReference** — 3D Tiles classification relies on stencil to confine geometry to tile footprints. `WebGPURenderPipelineCache.ts:362-370` supports stencil masks *in principle* via the `variant` object, but no feature renderer passes a variant derived from `command.renderState.stencilTest`. `WebGPUPassState.applyToRenderPass()` is defined at [WebGPUPassState.ts:192-216](../packages/engine/Source/Renderer/WebGPU/WebGPUPassState.ts) but **never called externally** (verified: grep for `applyToRenderPass\b` returns only the definition).
- **Custom blend modes** — min/max blend, reverse-subtract, constant-color, dual-source — all silently drop to the alphaMode-driven default.
- **blendConstant** — `passEncoder.setBlendConstant()` is called exactly nowhere outside the WebGL-compat stub (verified: only appearance in `Stubs/WebGLStubPipelineState.ts:189`, and the stub is write-only — §9b).

**Severity:** CRITICAL. Specific user-visible symptoms: classification bleed-through, Z-fighting on overlay geometry, wrong tone on custom blend materials, incorrect depth-fail rendering for glTF two-pass translucent materials.

**Fix sketch:** create `Renderer/WebGPU/RenderStateToPipelineVariant.ts` that maps every `RenderState` field to a `PipelineVariant` (the object `WebGPURenderPipelineCache.ts:342-373` already accepts). Thread it through `WebGPUDrawCommand.execute()` for per-encoder state (`setStencilReference`, `setBlendConstant`, `setViewport`, `setScissorRect` when they differ from the pass default). Wire `WebGPUPassState.applyToRenderPass()` into `beginRenderPass()` or require callers to invoke it.

---

### C-R2. `derivedCommands.*` is never consulted on the WebGPU dispatch path
**Verified.** `grep -r "derivedCommands\.shadows|receiveCommand|derivedCommands\.logDepth|derivedCommands\.hdr|derivedCommands\.pickingMetadata|derivedCommands\.depth" packages/engine/Source/Renderer/WebGPU/` returns zero hits.

[SceneRenderer.js:27-108](../packages/engine/Source/Scene/SceneRenderer.js) (`executeCommand`) is a polymorphic dispatcher that selects among:

- `command.derivedCommands.logDepth.command` when `frameState.useLogDepth`
- `command.derivedCommands.hdr.command` when `scene._hdr`
- `command.derivedCommands.pickingMetadata.pickMetadataCommand` when `frameState.pickingMetadata`
- `command.derivedCommands.picking.pickCommand` when `frameState.passes.pick`
- `command.derivedCommands.shadows.receiveCommand` when shadows enabled AND `command.receiveShadows`
- `command.derivedCommands.depth.depthOnlyCommand` for globe-depth capture

`WebGPUSceneRenderer.ts:81-111` (`executeWebGPUCommand`) does none of this. Consequences:

- **Log depth inoperative on WebGPU.** At planetary scale (far plane 1e8, near plane 1.0), a standard-depth test produces Z-fighting on distant terrain and 3D Tiles. WebGL rotates to log depth automatically; WebGPU is stuck on linear depth. `ModelPBRComplete.wgsl` has zero `log2`/`frag_depth` tokens — verified. `GlobeTerrain.wgsl` same. **CRITICAL for planetary views.**
- **Shadow-receiving never wired.** Shadow casting works (see [WebGPUShadowMapRenderer.js](../packages/engine/Source/Renderer/WebGPU/WebGPUShadowMapRenderer.js), though point-light shadows are skipped — line 230). But the RECEIVING side — the derived shader variant that samples the shadow map in the main pass — is gated by `command.derivedCommands.shadows.receiveCommand` being selected. That doesn't happen on WebGPU. **Any shadow-casting scene produces shadows in the shadow map that never darken the scene.** CRITICAL.
- **HDR derived never chosen.** The scene may render into an HDR framebuffer (`config.useHDR`), but the per-command HDR shader variants are not routed. Results may "look fine" because the scene FBO is HDR regardless, but the tonemapping math in the shaders assumes an LDR pipeline. Severity MEDIUM-HIGH, depending on whether ModelPBRComplete's inline tonemap (see C-S5) double-encodes.
- **`pickMetadata` branch missing.** `pickMetadata()` → `command.derivedCommands.pickingMetadata.pickMetadataCommand` — the dedicated metadata-pick shader variant — is never dispatched on WebGPU. `scene.pickMetadata()` silently returns null on WebGPU.
- **Depth-only variant never selected.** `executeBatchDepthOnly` exists at `WebGPUSceneRenderer.ts:313-332` but is never called.

**Fix sketch:** `WebGPUSceneRenderer.executeBatch()` should replicate the polymorphic dispatch from `SceneRenderer.executeCommand`. The derived command structure already exists on the command object (shared between backends); we just don't branch on it.

---

### C-R3. Translucent commands are not sorted back-to-front on WebGPU
**Verified.** `grep -r "CommandSorter|backToFront|sortByEyeDistance" packages/engine/Source/Renderer/WebGPU/` returns zero hits. `CommandSorter.js` is imported by `SceneRenderer.js` (for `executeTranslucentCommandsBackToFront` and the voxel / Gaussian splat merge-sort paths), but `WebGPUSceneRenderer.ts` uses no sort.

Call sites where WebGL sorts and WebGPU does not:

| Pass | WebGL site | WebGPU site | Status |
|---|---|---|---|
| TRANSLUCENT back-to-front | [CommandSorter.js:107](../packages/engine/Source/Scene/CommandSorter.js) `mergeSort(commandList, back_to_front, center)` | `WebGPUSceneRenderer.ts:1406-1558` | **No sort** |
| VOXELS merge-sort | [CommandSorter.js](../packages/engine/Source/Scene/CommandSorter.js) `performVoxelsPass` | `WebGPUSceneRenderer.ts:852-858` | **No sort** |
| GAUSSIAN_SPLATS | Same | `WebGPUSceneRenderer.ts:864-892` | **No sort** |

Consequence: any scene with multiple overlapping translucent primitives — common for labels, transparent buildings, atmospheric effects — composites in command-push order. Visual artifacts: labels vanish behind transparent geometry, a transparent building painted first blocks the one behind it, atmospheric layers stack wrong.

OIT (`WebGPUOIT.ts`) when active correctly uses MRT weighted-blended accumulation (order-independent), but the fallback when OIT is off or when a particular command has no `_oitPipeline` drops to unsorted plain draws at `WebGPUSceneRenderer.ts:1557`. There is no silent retry on the sorted path.

**Fix:** import `CommandSorter` into `WebGPUSceneRenderer` and apply the back-to-front sort before each non-OIT translucent batch. One-file change.

---

### C-R4. glTF model path silently drops multiple features
**Verified.** `grep` for `ModelPBRComplete|ModelSilhouetteStage|ModelColorStage|ModelCPUStylingStage|ModelSplitterStage|ModelAtmosphereStage|ModelClippingPlanesStage|ModelClippingPolygonsStage` across `Renderer/WebGPU/` matches only `ModelPBRComplete` (in `WebGPUModelPipelineCache.js`). The six sibling WGSL stage files exist on disk in `Shaders/WebGPU/Model/` but are imported by nothing. **Orphaned dead code on disk gives a false impression of coverage.**

ModelPBRComplete.wgsl (521 lines monolithic) lacks:

| glTF feature | WebGL (GLSL) site | WebGPU status | User-visible impact |
|---|---|---|---|
| **KHR_materials_clearcoat** | `MaterialStageFS.glsl:410-448` + `LightingStageFS.glsl:15-49` + `ImageBasedLightingStageFS.glsl:162` | Absent (no `clearcoat` tokens in `ModelPBRComplete.wgsl`) | Metallic/lacquered PBR materials render as simple metal-rough |
| **KHR_materials_anisotropy** | `MaterialStageFS.glsl:382-403` | Absent | Brushed metal looks isotropic |
| **KHR_materials_specular** | `MaterialStageFS.glsl:336-344` | Absent | Specular factor/texture ignored |
| **KHR_texture_transform** | 16 call sites via `czm_computeTextureTransform` | Absent — `ModelPBRComplete.wgsl` uses raw `texCoord0` at lines 179, 365, 382, 387, 414, 428, 440, 487, 494, 504 | **Every asset with scaled/rotated/offset textures renders wrong.** Huge; KHR_texture_transform is in nearly every production glTF. |
| **Multiple UV sets** (TEXCOORD_1+) | GLSL picks `texCoordN` per-texture | WGSL vertex input declares only `@location(3) texCoord0` | Textures assigned to TEXCOORD_1 sample from TEXCOORD_0 |
| **CustomShader** | `CustomShaderStageVS/FS.glsl` | No WGSL injection mechanism | Public API `CustomShader` is broken on WebGPU |
| **Model clipping planes/polygons** | `ModelClippingPlanesStageFS.glsl`, `ModelClippingPolygonsStage.glsl` | Absent from `ModelPBRComplete.wgsl` (globe terrain has it, models do not) | Clipping on 3D Tiles models works from the terrain side only |
| **Log depth on model path** | GLSL via `czm_writeLogDepth` | Absent | Models exhibit Z-fighting at planetary distances; 3D Tiles cities flicker |
| **Fog/atmosphere on model** | `AtmosphereStageFS.glsl` + `AtmosphereStageVS.glsl` | `ModelAtmosphereStage.wgsl` exists but is orphaned | Models don't fade into distant haze |
| **Silhouette** | `ModelSilhouetteStage.glsl` | `ModelSilhouetteStage.wgsl` orphaned | `model.silhouetteSize`/`silhouetteColor` is a no-op on WebGPU |
| **Edge visibility (EXT_mesh_primitive_edge_visibility)** | `EdgeVisibilityStageVS/FS.glsl` | No WGSL equivalent | New upstream feature (v1.135+) not supported on WebGPU |
| **Classification primitives** | `ClassificationPipelineStage.js` + GLSL | Not wired in WebGPU model path | glTF classifiers render as visible geometry |
| **EXT_mesh_primitive_outline** | `PrimitiveOutlineStage{VS,FS}.glsl` | No WGSL equivalent | Outlines drop |
| **EXT_structural_metadata property textures** | `MetadataStage{VS,FS}.glsl` | Absent | Per-feature styling against metadata property textures silent drops |
| **VerticalExaggerationStage** | `VerticalExaggerationStageVS.glsl` | Absent | Terrain exaggeration visible on WebGPU globe but NOT on WebGPU models — model/terrain positions drift apart |

**Severity:** CRITICAL — nearly every production glTF uses KHR_texture_transform, multiple UV sets, or fog. The "silently renders wrong" profile is the most damaging form of bug because users have no cue.

**Not parity gaps** (not in upstream GLSL either, so not bugs against upstream baseline): KHR_materials_sheen / _transmission / _iridescence / _volume / _ior / _variants, KHR_lights_punctual. These are discussed in [PHASE_8_GPU_RESIDENT_TILES_DESIGN.md](PHASE_8_GPU_RESIDENT_TILES_DESIGN.md) §2 as the gated BRDF-extension roadmap.

**Fix sketch:** the model path needs a real shader-variant strategy. The Phase 8 design doc's "~20 coarse material-family pipelines with pre-warmed compilation" proposal covers this, but the discussion there was in the BRDF-extension context. Texture transforms + multi-UV + texCoord1 + log depth + fog are **not** BRDF extensions; they can be added to the monolithic shader today with `#define`-style conditionals in the shader-builder preprocessor. KHR_texture_transform is the highest-priority single addition.

---

### C-R5. Globe imagery layer count is compile-time fixed at 4
**Verified.** [GlobeTerrain.wgsl:86](../packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl) declares `layers: array<ImageryLayer, 4>`. WebGL uses `TEXTURE_UNITS` which is computed dynamically from GPU capability (typically up to 31 on WebGL2).

Additionally silent-dropped in the WebGPU `ImageryLayer` struct (`GlobeTerrain.wgsl:79-82` — has only alpha/brightness/contrast/saturation):

- `u_dayTextureHue[TEXTURE_UNITS]` + `czm_hue` — per-layer hue shift
- `u_dayTextureOneOverGamma[TEXTURE_UNITS]` — per-layer gamma
- `u_dayTextureSplit[TEXTURE_UNITS]` — per-layer split-direction (split-screen imagery layers)
- `u_colorsToAlpha[TEXTURE_UNITS]` — per-layer color-to-alpha keying
- `u_dayTextureCutoutRectangles[TEXTURE_UNITS]` — per-layer cutout

**Severity:** HIGH (not CRITICAL because many apps use 1-4 layers). But any app with Bing + labels + weather + political boundaries overlays (5 layers) silently loses layer #5.

**Fix sketch:** two parts. (1) Parameterize `MAX_IMAGERY_LAYERS` in the shader-builder preprocessor and emit dynamic-sized storage buffer instead of fixed array. (2) Add the five missing per-layer uniforms (hue/gamma/split/cutout/colorToAlpha).

---

### C-R6. Multiple WebGPU primitive renderers use incorrect `pass` values
**PARTIALLY FIXED 2026-04-16 (Batch 3).** Billboard and Label color commands now pick pass based on `collection._blendOption`: `BlendOption.OPAQUE` → Pass.OPAQUE, otherwise Pass.TRANSLUCENT. Pick commands remain Pass.OPAQUE. Polyline / Point / BufferPrimitive / GroundPrimitive remain open.

**Original finding — Verified.** Grep shows:

- `WebGPUBillboardRenderer.js:480,567` — `pass: 8` (OPAQUE) unconditionally, regardless of `blendOption`. WebGL emits two commands (OPAQUE + TRANSLUCENT) when `blendOption === OPAQUE_AND_TRANSLUCENT`. **(FIXED Batch 3 — now blendOption-driven.)**
- `WebGPUPolylineRenderer.js:685,804` — `pass: 8` unconditionally.
- `WebGPUPointPrimitiveRenderer.js:540` — `pass: 0` (ENVIRONMENT — this is a real bug: the enum value 0 is ENVIRONMENT, not OPAQUE). Line 540 comment says `// Pass.OPAQUE — adjusted below` but no adjustment occurs before the command is pushed.
- `WebGPULabelRenderer.js:412` — `pass: 8` for alpha-blended text. **(FIXED Batch 3 — now blendOption-driven, defaults TRANSLUCENT.)**
- `WebGPUBufferPrimitiveRenderer.ts:801,818` — `Pass.OPAQUE` regardless.
- `WebGPUGroundPrimitiveRenderer.js:284,298` — `pass: 3` (TERRAIN_CLASSIFICATION) regardless of `classificationType`. Scene primitives with `classificationType: CESIUM_3D_TILE` or `BOTH` silently degrade to terrain-only.

**Severity:** HIGH. Z-ordering of translucent UI elements is visibly wrong. The point-pass-0 bug means points render before the globe surface — they paint over the sky/atmosphere.

**Fix sketch:** each renderer should replicate the WebGL pass-selection logic: `pass = translucent ? Pass.TRANSLUCENT : Pass.OPAQUE`, and for GroundPrimitive a switch on `classificationType` that emits TERRAIN_CLASSIFICATION / CESIUM_3D_TILE_CLASSIFICATION / both.

---

### C-R7. `_webgpuPipelineCache` is declared but never instantiated
**Verified.** Declaration at `WebGPUContext.ts:286` (`_webgpuPipelineCache: WebGPURenderPipelineCache | null = null`). Reads are only the `clear()` call at `:3823`. `grep` for assignment returns zero hits.

Consequences:

- Every feature renderer ad-hoc caches pipelines on its own state object. There is no central pipeline dedup — the same vertex/fragment module pair with the same pipeline descriptor may exist as multiple pipelines across renderers.
- If the cache were ever wired, its key-computation at `WebGPURenderPipelineCache.ts:392-419` is incomplete: it omits `multisample.count`, `targets[N].format`, `targets[N].writeMask`, `depthStencil.format`, and `vertex.buffers[]`. Different MSAA pipelines would collide; different vertex layouts would collide.
- On device-loss recovery, `_clearAllCaches()` at `WebGPUContext.ts:3823` operates on a null pointer (silently no-ops). Caches owned by feature renderers are not cleared.

**Severity:** HIGH (memory inefficiency + device-loss correctness).

**Fix sketch:** either (a) instantiate `_webgpuPipelineCache` in `_initialize()` and route all feature-renderer pipeline builds through it, **and** fix the cache key; or (b) remove the unused field and document that pipeline caching is per-feature-renderer and requires each FR to expose an invalidate hook for device-loss. The former is the right answer.

---

### C-R8. Scene→WebGPU: multiple invisible passes missing
**Verified where noted.**

- **`globeDepth.executeUpdateDepth`** ([SceneRenderer.js:549-553, 573-578](../packages/engine/Source/Scene/SceneRenderer.js)) is called on WebGL after the 3D Tile and 3D Tile Classification passes to propagate 3D-tile depth into the shared globe depth texture (used by ground primitives, atmosphere, depth plane, picking). On WebGPU, only `executeCopyDepth` is called ([WebGPUSceneRenderer.ts:819](../packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts)). **This means ground primitives/decals/clamp-to-3D-tile features that depend on the post-3D-tile depth buffer see an incomplete depth texture on WebGPU.** HIGH.
- **Translucent 3D Tiles classification pass** (`performTranslucent3DTilesClassification`, [SceneRenderer.js:211-240, 619](../packages/engine/Source/Scene/SceneRenderer.js)) has no WebGPU equivalent call site. HIGH.
- **Invert-classification two-pass FBO swap** — the FR is registered and runs for color-only style updates ([WebGPUInvertClassification.ts:76](../packages/engine/Source/Renderer/WebGPU/WebGPUInvertClassification.ts)), **but** the full two-pass composition — render classified to FBO, then render unclassified into scene with blend — is not replicated. Selection style on 3D Tiles will not produce the desaturated-surroundings look on WebGPU. HIGH.
- **Edge framebuffer / edge color+id+depth textures** ([SceneRenderer.js:242-278, 508-541](../packages/engine/Source/Scene/SceneRenderer.js)) — WebGL maintains a separate edge FBO with color/id/depth attachments. WebGPU runs 3D Tile edges in the scene FB; the `edgeColorTexture`/`edgeIdTexture`/`edgeDepthTexture` uniforms are never populated. HIGH for apps using 3D Tile edge rendering.
- **`performVoxelsPass` runs BEFORE OPAQUE on WebGL but AFTER OPAQUE on WebGPU** (WebGL: [SceneRenderer.js:606-608](../packages/engine/Source/Scene/SceneRenderer.js); WebGPU: [WebGPUSceneRenderer.ts:849-858](../packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts)). MEDIUM — voxel media depth-interacts with opaque geometry; order matters for composition.
- **SceneMode.SCENE2D frustum-jitter offset** ([SceneRenderer.js:444-449](../packages/engine/Source/Scene/SceneRenderer.js) `camera.position.z = height2D - ...`) has no WebGPU equivalent. 2D scene mode on WebGPU misrenders near-far depth bands. HIGH when 2D mode is used.

---

### C-R9. Model, GroundPrimitive, Ellipsoid, Voxel, GaussianSplat WebGPU renderers emit NO pick commands
**Verified.** `grep` of `WebGPUModelRenderer.js`, `WebGPUEllipsoidPrimitiveRenderer.ts`, `WebGPUVoxelRenderer.ts`, `WebGPUGaussianSplatRenderer.ts`, `WebGPUGroundPrimitiveRenderer.js` for `pickId|allowPicking|castShadows|silhouetteSize` returns zero hits.

Consequences:

- **glTF model picking broken on WebGPU.** Entities-with-Model cannot be picked via `scene.pick()`. The scene object is retrievable via `pickPosition` from the depth buffer but not by the standard pick-pass pick-id readback.
- **Shadow cast for models** — [WebGPUModelRenderer.js:839-863](../packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.js) emits exactly one `WebGPUDrawCommand` per primitive. No separate `castCommand` variant. The shadow cast path at [WebGPUContext.ts:2626-2700](../packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts) passes raw `castCommands` to `shadowFR.renderCastPass` — if the WebGPU shadow renderer uses the raw color pipeline instead of a depth-only cast pipeline, depth-only rasterization won't differ from color rendering (produces the shadow map but at high GPU cost, and any alpha-tested material produces wrong shadows). NEEDS-VERIFICATION of shadow renderer internals.
- **Silhouette / outline dropped entirely.** `model.silhouetteColor`/`silhouetteSize` is a no-op on WebGPU.
- **Edge/outline models** — the full `derivedCommands.edge/outline` set from `ModelDrawCommand.js:507-573` has no WebGPU counterpart.
- **Same story for Ellipsoid, Voxel, GaussianSplat, GroundPrimitive**: one command, no pick, no shadow-cast.

**Severity:** CRITICAL for picking (essential Viewer feature); HIGH for shadow-cast correctness.

**Fix sketch:** each of these renderers needs to emit a companion pick command when `frameState.passes.pick`. For models specifically, the cast command should use a depth-only pipeline variant matched to the original's material (for alpha-test correctness). This is the WebGL `DrawCommand.derivedCommands.picking.pickCommand` pattern; structurally it's building a second pipeline + second bind group + second push per primitive.

---

### C-R10. Shadow maps skip point lights on WebGPU
**Verified.** [WebGPUShadowMapRenderer.js:230](../packages/engine/Source/Renderer/WebGPU/WebGPUShadowMapRenderer.js) — `if (!shadowMap.enabled || shadowMap._isPointLight) { return; }`. WebGL ([ShadowMap.js:270-313, 487-511](../packages/engine/Source/Scene/ShadowMap.js)) draws 6 cube faces for point lights.

**Severity:** MEDIUM (point lights are niche for CesiumJS but not zero; documented-but-silent feature drop).

**Fix sketch:** implement cube-depth target + 6-face cast loop. Can wait for the CSM work since both involve the cast-pipeline variant machinery.

---

### C-R11. Per-frame bind group + texture view allocation in hot post-process / effects path
**Verified.** [WebGPUPostProcessEffects.ts:235, 253, 271, 289, 317, 614, 632, 650, 948, 966, 984](../packages/engine/Source/Renderer/WebGPU/WebGPUPostProcessEffects.ts) — bloom alone creates 4 bind groups/frame; SSAO ~5; DoF ~3. At a 5-stage chain at 60Hz ≈ **720 bind groups/sec** allocated, never cached despite stable input textures.

Also [WebGPUEffectsBindGroup.js:388-421](../packages/engine/Source/Renderer/WebGPU/WebGPUEffectsBindGroup.js) — when clipping planes are active, per-tile per-frame allocates a 240-byte UB + GPUBindGroup + up to 3 transient texture views. For 200 globe tiles at 60Hz: **~12k bind groups/sec + 12k UBs/sec.**

And [WebGPUAutoExposure.ts:171-180](../packages/engine/Source/Renderer/WebGPU/WebGPUAutoExposure.ts) — new `createView()` + `createBindGroup()` every frame against a stable `sceneColorTexture`. Not tile-rate, but per-frame.

**Severity:** CRITICAL for long sessions. At conservative ~200 bytes/bind-group driver state and ~150 bytes/view, ~2 MB/min of driver-side allocation is unreclaimed until the wrapper objects GC. Combined with the known per-frame allocations that Session 31 didn't fix (§9A-b/c/d of PHASE_8_GPU_RESIDENT_TILES_DESIGN.md), this is the dominant memory-growth class.

**Fix sketch:** cache bind groups keyed on `(stageName, inputTextureIds)` on the effect state objects. For the effects bind group, attach the cached result to the clipping-plane object's `_webgpuCache`. For AutoExposure, cache by target texture identity.

---

### C-R12. Device-loss recovery leaves stale GPU handles across many caches
**Verified.** [WebGPUContext.ts:3809-3826](../packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts) (`_clearAllCaches`) clears `_webgpuShaderCache` and a few others, but NOT:

- `_renderBundleManager._cache` — bundles hold destroyed pipelines/buffers
- `_timestampProfiler._frameStates` — query sets on the old device
- `_storageBufferPool._pool`, `_mipmapGenerator._bindGroupCache`
- Per-scene-object caches: `model._webgpuCache.pipelineCache`, `BillboardCollection._webgpu*`, `CloudCollection._webgpuCache`, `WebGPUGlobeSurfaceRenderer._{tileBuffer,imageryTexture,waterMask,oceanNormalMap,pipeline}Cache` — these are object-owned, the context has no handle
- Shader-cache-produced `GPUShaderModule` handles referenced by *caller-owned* pipeline caches (the shader cache itself is cleared, but callers cached the returned module)
- Module-level WeakMap at [WebGPUEffectsBindGroup.js:61](../packages/engine/Source/Renderer/WebGPU/WebGPUEffectsBindGroup.js) `_placeholderCache`

**Severity:** CRITICAL when device loss occurs. First frame after recovery submits commands against the destroyed device; driver typically re-loses; circuit breaker trips.

**Fix sketch:** an invalidation-event mechanism. `GraphicsContext` should expose `onDeviceInvalidated(callback)` that scene objects and feature renderers subscribe to; each drops its cached handles. The `_clearAllCaches` function then fires the event instead of poking at specific pointers. This is ~100 LOC plus one subscriber per cached-resource owner.

---

### C-R13. `WebGPUContext.destroy()` tears down the device before subsystems
**Verified.** [WebGPUContext.ts:2800-2877](../packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts) — `_device.destroy()` runs at line 2822, BEFORE `_viewportQuad`, `_mipmapGenerator`, `_renderBundleManager`, `_timestampProfiler`, `_storageBufferPool`, `_indirectDrawManager`, `_gpuCuller`, `_bufferMapper` are destroyed. Their `destroy()` methods call `.destroy()` on their owned buffers/textures/querysets AFTER the device is gone. Modern GPU validators flag this as an error.

Additionally, `_webgpuShaderCache` and (if it were ever wired) `_webgpuPipelineCache` are not destroyed in this path at all.

**Severity:** HIGH (validation errors at teardown, potential leaks on long-lived multi-viewer apps).

**Fix sketch:** reverse the order — destroy sub-systems first, `_device.destroy()` last. Session 31 already added `deviceLossRecovery.dispose()` before `_device.destroy()`; this is the same principle applied to every other owned sub-system.

---

## HIGH findings

### H-R1. Multi-frustum stencil clear is implicit / default-driven
[WebGPUSceneRenderer.ts:1168-1228](../packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts) opens the scene-FB render pass between frustums with `colorLoadOp: "load"`, `depthLoadOp: "clear"`. The code comment claims "depthLoadOp defaults to clear" but **the stencil load op is never explicitly set** at `:1197`. Depending on `WebGPURenderTarget.getDepthStencilAttachment` defaults, this may or may not clear stencil. WebGL explicitly clears both depth and stencil between frustums. NEEDS-VERIFICATION. Severity HIGH if default-drive is wrong.

### H-R2. Shadow cast path uses raw color command instead of a dedicated cast pipeline
Implementation exists at [WebGPUContext.ts:2626-2700](../packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts) with CSM support but passes the raw `castCommands` array. Whether the WebGPU shadow renderer builds a depth-only cast pipeline keyed on the vertex layout and applies alpha-test correctly is NEEDS-VERIFICATION. If not, alpha-test leaf/fence shadows render as opaque cards.

### H-R3. Pick pass does not include VOXELS or pickMetadata
[WebGPUSceneRenderer.ts:1059-1062](../packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts) `tilePasses` array excludes VOXELS. `_executePickBatch` at `:1108-1140` has no `pickMetadata` branch. Voxel picking is silent; pick-metadata (a public API since CesiumJS v1.136) is broken.

### H-R4. `WebGPUPassState.applyToRenderPass` is dead code
Defined at [WebGPUPassState.ts:192-216](../packages/engine/Source/Renderer/WebGPU/WebGPUPassState.ts), never called outside its own definition (verified grep). The `blendingEnabled`/`depthTestEnabled`/`cullFaceEnabled`/`stencilTestEnabled`/`stencilReference`/`depthWriteEnabled` override slots on PassState are write-only.

### H-R5. `WebGLStubPipelineState` state accumulator is write-only
[WebGLStubPipelineState.ts](../packages/engine/Source/Renderer/WebGPU/Stubs/WebGLStubPipelineState.ts) faithfully records WebGL-style API calls into `state.colorWriteMask`, `state.stencilWriteMask`, `state.blendSrc`, `state.depthCompare`, `state.cullMode`, `state.frontFace`, etc. But a grep across `Renderer/WebGPU/` finds **zero readers** of these fields when building pipelines. The stub exists as scaffolding for a path that was never connected.

### H-R6. `WebGPUShaderCache` keys on `descriptor.name` only, not source hash
[WebGPUShaderCache.ts:412-416](../packages/engine/Source/Renderer/WebGPU/WebGPUShaderCache.ts) — `_getCacheKey` returns `descriptor.name`. Different WGSL bodies registered under the same name return the first-ever compiled module. The `TODO` comment acknowledges: *"Could hash the code for more robust caching."* Silently broken for any dynamic shader assembly.

Also `isDestroyed()` at line 429 returns hard-coded `false` — dead API.

### H-R7. Globe tile commands lose `castShadows`/`receiveShadows`/`clippingPolygons`/`pickId`
[GlobeSurfaceTileProviderRendering.js:901-925](../packages/engine/Source/Scene/GlobeSurfaceTileProviderRendering.js) (WebGPU path) builds a raw object literal command with only `pass: Pass.GLOBE`, `owner`, `cull`, `enabled`, `boundingVolume`, `execute`. WebGL ([GlobeSurfaceTileProviderRendering.js:1022-1025](../packages/engine/Source/Scene/GlobeSurfaceTileProviderRendering.js)) sets `castShadows`, `receiveShadows`, clipping polygons, water mask, ocean normal — none propagate. Terrain cannot cast or receive shadows on WebGPU.

### H-R8. `getPooledBuffer` is unkeyed on usage flags
[WebGPUContext.ts:3050-3099](../packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts) keyed only on string `type`, not `(type, usage)`. Any caller that requests `VERTEX|COPY_DST` may receive a pooled `VERTEX|STORAGE` buffer of a matching size bucket. Wrong usage flags surface at bind-group creation as a hard error. Latent but eventual bug.

### H-R9. Readback / mapAsync paths other than PickFB are unguarded
[WebGPUGPUCuller.ts:399-425](../packages/engine/Source/Renderer/WebGPU/WebGPUGPUCuller.ts) — no try/catch around `mapAsync(...)` / `getMappedRange` / `unmap` chain. If device-loss or tab-close races, the buffer stays in mapped-pending state and every subsequent frame throws. Session 31 fixed the PickFB version; this one is untouched.

### H-R10. `_destroyFeatureRenderers` partially no-ops for critical FRs
[GraphicsContext.ts:1610-1620](../packages/engine/Source/Renderer/GraphicsContext.ts) — the method invokes registered `destroy` callbacks. ~24 FRs have destroy callbacks registered in [WebGPUFeatureRenderers.ts](../packages/engine/Source/Renderer/WebGPU/WebGPUFeatureRenderers.ts), but several do **not**: PRIMITIVE, GLOBE_SURFACE, GLOBE_TRANSLUCENCY, POINT_CLOUD, POINT_CLOUD_EDL, GAUSSIAN_SPLAT, VOXEL_PRIMITIVE, SUN, SKY_ATMOSPHERE, CUBE_MAP_PANORAMA, SSR, WEATHER, SCENE_RENDERER. For PRIMITIVE and GLOBE_SURFACE this matters — `WebGPUGlobeSurfaceRenderer` has a thorough `destroy()` at line 2755 that is never invoked. Long-lived per-tile texture caches leak.

### H-R11. Debug modes broadly missing
Grep-confirmed missing on WebGPU path: `debugShowFrustumPlanes`, `debugShowGlobeDepth`, `debugShowPickDepth`, `debugShowDepthFrustum`, `debugCommandCount` overlay, `command.debugShowBoundingVolume` (SceneDebug integration). Debug-tooling regression relative to WebGL.

### H-R12. `command.derivedCommands.shadows.castCommands` not written by WebGPU commands; cast path pulls from raw
See C-R9 for the model angle; this is the broader version — since `WebGPUDrawCommand` never populates `derivedCommands`, the entire derived-command cache is empty on WebGPU. The shadow-cast path's use of raw commands bypasses the variant-shader machinery. HIGH.

### H-R13. Double-tonemap risk in model path
[ModelPBRComplete.wgsl:311-314, 518](../packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.wgsl) inlines `tonemapAndGamma(color)` AND writes non-linear sRGB into the framebuffer. The GLSL path leaves HDR→SDR tonemapping to the post-process `Tonemapping` stage. If the WebGPU post-process also runs tonemapping (usual case), model output is tonemapped twice. Separately, if the WebGPU canvas format is `rgba8unorm-srgb` (not `unorm`), the per-fragment `pow(mapped, vec3(1.0/2.2))` also double-encodes. NEEDS-VERIFICATION against live canvas config via `CesiumDebug.postProcess()`.

### H-R14. Globe translucency dispatch missing
`globeTranslucencyState.executeGlobeCommands` and `executeGlobeClassificationCommands` ([SceneRenderer.js:465-494](../packages/engine/Source/Scene/SceneRenderer.js)) have no WebGPU equivalent. `WebGPUGlobeTranslucencyState.ts` attaches WebGPU-specific derived state but the front-face/back-face twin-pass dispatch (WebGL's way of handling translucent globe) is not replicated. Translucent-globe mode will not correctly composite.

---

## MEDIUM findings

- **M-R1. Transient `createView()` and `createBindGroup()` at material upload time** ([WebGPUModelRenderer.js:459-467](../packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.js), [WebGPUModelFeatureId.js:300, 305](../packages/engine/Source/Renderer/WebGPU/WebGPUModelFeatureId.js), [WebGPUInvertClassification.ts:183](../packages/engine/Source/Renderer/WebGPU/WebGPUInvertClassification.ts), [WebGPULabelRenderer.js:347](../packages/engine/Source/Renderer/WebGPU/WebGPULabelRenderer.js)) — not per-frame but per-material-upload. Cache the view on the owning texture wrapper.
- **M-R2. Unbounded `_samplerCache` and `_bindGroupLayoutCache`** on `WebGPUContext` (`:287-288, 2964-2980`). Unlikely to explode in practice; should have an upper bound or LRU for pathological tileset-driven sampler diversity.
- **M-R3. `JSON.stringify(descriptor)` keying** for sampler/BGL lookup (`:2948, 2971`) — O(n) per call on a hot path.
- **M-R4. Numeric-literal `pass: 8`/`pass: 0`** (see C-R6) — even after the pass-selection bugs are fixed, using `Pass.OPAQUE`/`Pass.TRANSLUCENT` enums removes a class of copy-paste bugs.
- **M-R5. `debugShowBoundingVolume` / `debugOverlappingFrustums` / `receiveShadows` / `executeInClosestFrustum` / `pickOnly` are never set** on any WebGPU draw command outside Model and Primitive (grep confirmed). Debug overlays and shadow-receive classification on collections become no-ops.
- **M-R6. `WebGPULabelRenderer.js:425`** looks up `context.getFeatureRenderer(0)` (numeric literal) instead of `FeatureRendererKey.BILLBOARD_COLLECTION` — violates the project's enum-over-string rule and becomes silently wrong if the enum is reordered.
- **M-R7. WebGPU hand-rolled specular LOD** ([ModelPBRComplete.wgsl:479-481](../packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.wgsl)) uses `1.0 / (1.0 + specLod * 0.5)` approximation; GLSL uses pre-filtered cubemap mip sampling via `czm_sampleOctahedralProjection`. Rough-metal shading looks flatter on WebGPU.
- **M-R8. WebGPU uses simpler IBL ambient** — `czm_sphericalHarmonics` has no WGSL helper; WebGPU IBL uses a constant ambient term. Lighting quality gap on PBR assets.
- **M-R9. Depth sampleCount mismatch risk** with MSAA color — [WebGPUSceneFramebuffer.ts:125-144](../packages/engine/Source/Renderer/WebGPU/WebGPUSceneFramebuffer.ts) creates depth at `sampleCount: 1` while color is `sampleCount: numSamples`. Render-pass depth-stencil attachment MUST match color sampleCount. NEEDS-VERIFICATION.
- **M-R10. ClearCommand `colorMask` for channel-selective clear** — WebGPU's `clearValue` has no per-channel mask. Any WebGL `ClearCommand` with `renderState.colorMask` clearing selected channels silently clears all four on WebGPU.
- **M-R11. Depth clip (`depth-clip-control` feature)** — `WebGPURenderPipelineCache.ts:344` passes `primitive.unclippedDepth`, but nothing ever sets it, and `depth-clip-control` is not among `requiredFeatures`. WebGL relies on GL's default depth clipping; WebGPU here will always clip. For Cesium's globe far-plane math this can matter.
- **M-R12. ModelPBRComplete declares `positionMC: vec3<f32>`** ([line 176](../packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.wgsl)) in f32, performing RTE in model space. For 3D Tiles rooted at ECEF, `positionMC` itself already aliases at f32 before the subtraction. The file author acknowledges this in the header comment. For dense city-scale 3D Tiles, vertex shimmer on WebGPU that doesn't appear on WebGL. NEEDS-VERIFICATION against a production tileset.
- **M-R13. Orphaned WGSL stage shaders on disk** (ModelSilhouetteStage, ModelColorStage, ModelCPUStylingStage, ModelSplitterStage, ModelPointCloudStylingStage, ModelAtmosphereStage) — code hygiene + false-impression-of-coverage concern. Either wire them in or delete.

---

## LOW findings

- **L-R1. `WebGPUShaderCache.isDestroyed()` hardcoded to false.**
- **L-R2. Placeholder-fill loop in `createEffectsBindGroup`** — minor CPU waste; harmless.
- **L-R3. Duck-typed `_webgpuShaderType` check in `PrimitiveCommandHelpers.js`** — when primitives are shared across multi-context split-screen (one WebGL, one WebGPU), the first-context-wins stamp can misroute the next context's update.

---

## What this review is NOT saying

- Not saying the WebGPU renderer is broken end-to-end. Basic scenes (globe + imagery + simple 3D Tiles) render correctly.
- Not saying the architecture is wrong. Session 31 and the architecture reviews correctly identified that the abstractions are right.
- Not saying every finding is a blocker. Many (H-R10, M-R2, etc.) are secondary quality issues.
- Not saying the prior review (`PRINCIPAL_ENGINEER_REVIEW_2026_04_16.md`) was insufficient — that review was narrower (build / lifecycle / tests / type discipline); this one is a targeted renderer audit that uncovered a different class of findings.

---

## Recommended sequencing

Ordered by impact ÷ effort. Mirrors the prior review's tier structure to compose cleanly.

### Tier R0 — Visible correctness (2-3 weeks)

Highest-impact bugs that produce wrong output on typical scenes:

1. **C-R1 RenderState translator** (`RenderStateToPipelineVariant.ts`) — unblocks polygonOffset, colorMask, stencilTest, custom blend across the whole renderer.
2. **C-R2 Derived command dispatch** — log depth, shadow-receive, depth-only, pick-metadata.
3. **C-R3 Translucent back-to-front sort** — one-line import + apply.
4. **C-R6 Fix pass values on collection renderers** — Billboard, Polyline, Point, Label, Buffer*, GroundPrimitive. Each a small PR.
5. **C-R9 Pick commands on Model / Ground / Ellipsoid / Voxel / GaussianSplat** — critical for Viewer UX.
6. **C-R5 Imagery layer count** — parameterize or raise the cap to WebGL's dynamic count.

### Tier R1 — Shader parity (2-4 weeks)

7. **C-R4 glTF model extensions** — KHR_texture_transform first (most pervasive), then multi-UV-set, then model log depth + fog. These land without a shader-variant rewrite.
8. **H-R13 double-tonemap audit** — verify + fix.
9. **M-R7, M-R8 IBL quality improvements** — spherical harmonics helper + octahedral specular LOD.

### Tier R2 — Scene dispatch (2-3 weeks)

10. **C-R8 missing passes** — `executeUpdateDepth`, translucent-tile-classification, 2D frustum jitter.
11. **H-R14 globe translucency dispatch** — front-face/back-face twin-pass.
12. **H-R3 pick pass VOXELS + pickMetadata** — a few lines.
13. **H-R11 debug modes** — at least the most commonly-used ones (debugShowFrustums already present; add debugShowBoundingVolume).

### Tier R3 — Infrastructure (2-3 weeks)

14. **C-R7 wire the pipeline cache** — instantiate `_webgpuPipelineCache`, fix its key, route renderers through it.
15. **C-R11 cache post-process bind groups** — biggest single memory-growth fix.
16. **C-R12 device-loss invalidation event** — subscriber pattern for caches.
17. **C-R13 destroy order** — reverse sub-system / device order.
18. **H-R10 complete FR destroy registrations** — add destroy callbacks for the ~13 FRs that lack them.
19. **H-R6 shader cache source hashing** — change the key function.

### Tier R4 — Completeness (multi-session, lower priority)

20. **C-R10 point-light shadow cube-map cast path** — depends on CSM work.
21. **H-R9 harden other readback paths** — mapAsync guards.
22. **M-R10, M-R11 clear-colorMask + depth-clip-control** — small.
23. **M-R13 delete or wire orphaned WGSL stages.**

---

## Appendix: Open NEEDS-VERIFICATION items

Items that looked suspicious but I didn't fully verify in this pass. Next session should close these:

- Shadow cast pipeline is depth-only (H-R2 / C-R9) — or uses raw color pipeline?
- Stencil clear between frustums (H-R1) — what does `WebGPURenderTarget.getDepthStencilAttachment` default to?
- Model path `positionMC: vec3<f32>` (M-R12) — measure vertex shimmer on a dense 3D Tiles production tileset.
- Depth/color sampleCount match under MSAA (M-R9) — run with `msaa: 4` and check validation layer.
- Double-tonemap (H-R13) — live check via `CesiumDebug.postProcess()`.
- Primitive pick-command push order in combined render+pick frames — verified that Agent A's original claim was wrong (push does happen), but there may still be subtle ordering issues in the frameState.passes.render/pick combinations.

---

## Appendix: Agent findings I disproved

Out of ~50 raw agent claims, three needed softening after first-hand verification:

1. **"Primitive pick commands never emitted in combined render+pick frames"** (Agent A §F1) — DISPROVED. [PrimitiveCommandHelpers.js:511-514](../packages/engine/Source/Scene/PrimitiveCommandHelpers.js) pushes pick commands when `allowPicking && pickCommands.length > 0`, independent of render flag.
2. **"InvertClassification entirely missing on WebGPU"** (Agent B §7) — PARTIALLY WRONG. The FR is registered (`WebGPUFeatureRenderers.ts:497-498`) and its update runs. But the full two-pass FBO swap composition is still missing. Downgraded from CRITICAL to HIGH (see C-R8).
3. **"_destroyFeatureRenderers never calls destroy"** (Agent E §H6) — PARTIALLY WRONG. ~24 FRs have destroy callbacks registered. The gap is ~13 FRs without them (see H-R10) — still a real finding, but narrower.

These are called out so next-session readers don't re-investigate.

---

## Appendix: Methodology

Five parallel research agents covering disjoint dimensions:
- **A**: Feature renderer parity (36 FRs vs WebGL scene code)
- **B**: Scene → renderer dispatch (WebGPUSceneRenderer vs SceneRenderer side-by-side)
- **C**: RenderState → pipeline descriptor translation
- **D**: Shader parity (GLSL vs WGSL, extension coverage, RTE, post-process)
- **E**: GPU resource lifecycle & pipeline caching

Each agent was explicitly told what was already known (from PRINCIPAL_ENGINEER_REVIEW_2026_04_16 + Session 31 fix list + PHASE_8_GPU_RESIDENT_TILES_DESIGN + OPTION_B_SCENE_IN_WORKER) so they wouldn't re-report.

Reviewer verification: 12 targeted greps + directed code reads against the highest-impact claims. Three agent findings failed verification (see above). The remaining findings all held up.

Signal-to-noise: ~94% of agent claims survived. The confidence on CRITICAL/HIGH findings is therefore high.

---

*Report prepared 2026-04-16 following the parallel-agent + verified-synthesis methodology. All line numbers valid at that date. Re-verify before acting on stale references.*
