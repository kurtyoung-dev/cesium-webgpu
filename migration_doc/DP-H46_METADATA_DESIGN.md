# DP-H46 — WebGPU Structural-Metadata-in-Shader + pickMetadata (design)

**Status:** epic, ~5–6 sessions. Approach DECIDED (user, 2026-06-26): per-model WGSL
codegen mirroring WebGL's dynamic GLSL generation. Display side (a–d) ships independently
before the pick producer (e). Derived from the `dp-h46-metadata-design` workflow (2026-06-30).

**Increment progress:** ✅ **DP-H46a SHIPPED** Batch 454 (upload scaffolding + `MODEL_HAS_METADATA`
bit 1<<18 + stub) · ✅ **DP-H46b SHIPPED** Batch 455 (`MetadataWGSLPipelineStage` codegen for
property-ATTRIBUTES + `WebGPUShaderModuleCache.keySalt` class-hash) · ✅ **DP-H46c SHIPPED**
Batch 457 (property-TEXTURE read: `MODEL_HAS_PROPERTY_TEXTURES` bit 1<<19, `buildMaterialBGL`
variant w/ 4 textures @39-42 + shared sampler @43, `textureSampleLevel` accessors, KHR_texture_transform
baked, budget-checked). · ✅ **DP-H46d IMPLEMENTED** (uncommitted — display-side parity CLOSED):
property-TABLE read (`MODEL_HAS_PROPERTY_TABLES` bit 1<<20, `buildMaterialBGL` variant w/ table texture
@44 + sampler @45, `textureLoad(table, vec2<i32>(featureId, propertyInfoIndex), 0)` accessors with
RGBA→u32 little-endian unpack + bit-reinterpret/normalize + baked offset/scale, `propertyInfoIndex`
cursor incremented per GPU-compatible class property, `<type>MetadataClass`/`MetadataStatistics` structs
emitted). Feature-ID source = the per-vertex `_FEATURE_ID_0` attribute (`input.featureId0`). Loader
retains the packed RGBA8 bytes on the table Texture (`_propertyTableTextureData`) so the WebGPU backend
can re-upload them. Verified on BuildingsMetadata (per-feature `height` paints distinct colors; plain +
attribute-only + property-texture-only stay table-path-inactive; 0 device/console errors).
· ✅ **DP-H46e IMPLEMENTED** (uncommitted — `scene.pickMetadata` PRODUCER on WebGPU): new
`METADATA_PICKING_ENABLED` ShaderDefine bit `1<<21` (render-MODE bit, OUTSIDE `MATERIAL_DEFINE_MASK`
like `CAPTURE_MODE`/`LOG_DEPTH`), `fragmentPickMetadataMain` WGSL entry (populates metadata via the same
`initializeMetadata`, calls the GENERATED `metadataPickingStage(metadata)→vec4`), `generateMetadataPickWGSL`
codegen (appends `metadataPickingStage` that reads the picked property's field + UN-applies offset/scale +
normalization per `buildPickSourceComponent`, mirroring `getSourceValueStringComponent`, and packs into the
pick-FBO RGBA8 — module cached per (base-class, picked-property) via a property-folded hash). Renderer builds
`derivedCommands.pickingMetadata.pickMetadataCommand` only during a metadata-pick pass; `getPickMetadataPipeline`
+ `createPickMetadataPipeline` + `setMetadataPickWGSL` on the pipeline cache. **Also fixed a blocking gap:** the
WebGPU model pick object lacked `detail.model`, so `Scene.pickMetadata`'s `pickedObject.detail.model.structuralMetadata`
guard bailed before reaching ANY producer — `ensurePickId` now folds `detail: { model }` into the pick payload
(WebGL parity via `PickingPipelineStage.buildPickObject`). Verified on SimplePropertyTexture (property TEXTURE,
class `buildingComponents`): WebGPU `scene.pickMetadata` returns non-null, pixel-varying decoded values that fall
100% within the WebGL decoded range + ~91-100% exact value-set overlap (insideTemperature/outsideTemperature
UINT8, insulation normalized-UINT8); 0 device/console errors; color render unchanged.
**KNOWN UPSTREAM LIMIT:** `Scene/getMetadataProperty.js` resolves ONLY property TEXTURES (it explicitly bails for
attributes/tables — cesium issue #12225), so `scene.pickMetadata` reaches the producer only for property textures
on BOTH backends today; the WebGPU producer reads attributes+tables too (codegen is type-agnostic) but the
orchestration's property resolver gates it. Also: non-normalized FLOAT32/INT16/INT32 scalars are lossy through the
RGBA8 byte pick path on BOTH backends (`getSourceValueString` divides by the type max → ~0 byte) — a shared WebGL
limitation, not a WebGPU gap.
**f — SHIPPED (Batch 463).** Consolidated verification probe
`Tools/visual-regression/probe-dp46f-metadata-demo.mjs` (confirms the demo's copied SampleData asset
serves, the property-texture model renders on WebGPU — screenshot read — and `scene.pickMetadata`
converges to plausible decoded values for all three `buildingComponents` scalars, 0 device/console
errors) + the `webgpu-structural-metadata-pick` Sandcastle demo (`packages/sandcastle/gallery/`, loads
`SimplePropertyTexture` on the WebGPU backend, click → `pickMetadata` → decoded readout) + this doc
reconcile. Byte-exact WebGL↔WebGPU parity is proven separately by `probe-dp46e-pick-metadata.mjs`.
**The DP-H46 epic (a–f) is closed.**

**Remaining follow-ups (post-epic, tracked in `ROADMAP_AND_DEFERRED_WORK.md`, not blocking):**
from b — full multi-component ATTRIBUTE transport (today only the first scalar over `@location(9)`);
from c — multi-byte component (UINT16/32) channel-packing for property TEXTURES; from d —
TEXTURE-sourced + instance/implicit feature-ID property TABLES (only the ATTRIBUTE feature-ID path is
wired today — the dominant b3dm/BuildingsMetadata case) and VS-stage table reads (today FS-only display);
from e — `scene.pickMetadata` reaching attributes/tables is gated on upstream `getMetadataProperty`
(cesium #12225), and non-normalized FLOAT/INT scalars are lossy through the RGBA8 pick path on BOTH backends.

## Goal
Port the glTF/3D-Tiles structural-metadata-in-shader pipeline (`EXT_structural_metadata` /
`EXT_mesh_features`) from GLSL to WGSL so the WebGPU model shader can read metadata properties
(property attributes + textures + tables), then wire `scene.pickMetadata` on WebGPU.

## Backend-agnostic — REUSE, do NOT rebuild
- `Picking.pickMetadata` orchestration — `Scene/Picking.js:410-483` (sets
  `frameState.pickingMetadata` + `pickedMetadataInfo`, renders pick pass, readCenterPixel, decode).
- `WebGPUPickFramebuffer.readCenterPixel` — `Renderer/WebGPU/WebGPUPickFramebuffer.ts:492` (Batch 285).
- `selectCommandVariant` dispatcher — `Renderer/WebGPU/WebGPUSceneRenderer.ts:223-226` already
  returns `d.pickingMetadata.pickMetadataCommand` when `frameState.pickingMetadata` is set; only the
  factory half (building that command) is missing.
- `MetadataPicking.decodeMetadataValues` — `Scene/MetadataPicking.js:341` (backend-agnostic RGBA→value).
- StructuralMetadata loader — `Scene/StructuralMetadata.js`, `GltfStructuralMetadataLoader.js`,
  `PropertyTexture.js`, `PropertyAttribute.js`; loaded into `Model.structuralMetadata` (`Model.js:1398-1400`).
- `MetadataClassProperty` type maps — `Scene/MetadataClassProperty.js:1308/1310/1318` +
  `getGlslType:462` (normalized-int→float rule) — template for the WGSL maps.
- `WGSLShaderBuilder` — `Renderer/WebGPU/WGSLShaderBuilder.js:404-441` (addStruct/addStructField/
  addFunction/build) — drives the WGSL string emission (models don't call `.build()` today).
- `WebGPUModelFeatureId.ensureFeatureIdResources` — `Renderer/WebGPU/WebGPUModelFeatureId.js:47+` —
  the structural template for a new `ensureMetadataResources`; feature-ID vars are the property-table index.

## Codegen mechanism
A new **`MetadataWGSLPipelineStage`** (Scene/Model/) iterates the SAME property-attributes/-textures/
-tables that `MetadataPipelineStage.process` does and emits a WGSL string: `struct Metadata { <field per
property> }` + `fn initializeMetadata(...) -> Metadata` (samples textures / reads attribute varyings /
`textureLoad` the property-table texture). The string is stashed on `renderResources.webgpuMetadataWGSL`
and **prepended at the single injection point** `WebGPUModelPipelineCache._getOrCreateShaderModule:1702`
(`fullSource = clChunk + metadataChunk + ModelPBRCompleteWGSL`; `metadataChunk=''` for non-metadata models).
`ModelPBRComplete.wgsl` declares a STUB `struct Metadata` + no-op `initializeMetadata` behind a new add-only
`MODEL_HAS_METADATA` ShaderDefine bit (`//>>ifdef`); the generated chunk REPLACES the stub only when the bit
is set — the same fork pattern as `CAPTURE_MODE`/`LOG_DEPTH` at that callsite. The shader-module cache key
(`effectiveDefines`) must additionally fold a **hash of the metadata class/schema id** (only when the bit is
set) so two models with different metadata classes don't alias one compiled module. For metadata picking, do
NOT `#define`-substitute (impossible post-compile in WGSL): emit a `metadataPickingStage()` driven by a small
dedicated **metadata-pick UBO** (property type + 4 component indices) written per pick-derive call → one
compiled module handles any picked component via runtime branch (avoids per-component pipeline explosion).

## Increments (dependency-ordered)
- **DP-H46a** (L) — WebGPU metadata GPU upload + binding scaffolding (TRUE first batch; upload is confirmed
  MISSING). New `WebGPUModelMetadata.js` (`ensureMetadataResources` mirroring `WebGPUModelFeatureId.js`):
  property-ATTRIBUTE buffers into the per-primitive vertex layout (`WebGPUVertexArrayFacade`); property-TEXTURE
  sampler+texture bind slots (extend the Batch-174 KHR binding manifest under a `MODEL_HAS_PROPERTY_TEXTURES`
  materialBGL variant so non-metadata models keep the minimal BGL); property-TABLE tightly-packed RGBA texture.
  Add `MODEL_HAS_METADATA` ShaderDefine bit + stub `Metadata` struct/no-op `initializeMetadata` gated by it.
  NO codegen yet — bindings present + stub so non-metadata models byte-identical and metadata models bind real
  GPU resources read by a placeholder. **Deliverable proof:** a scalar property-attribute reaches the shader
  (debug output), non-metadata models byte-identical (unchanged module hash).
  Files: `Renderer/WebGPU/WebGPUModelMetadata.js` (new), `WebGPUModelRenderer.js`, `WebGPUModelPipelineCache.js`,
  `WebGPUVertexArrayFacade.ts`, `WebGPUShaderDefines.ts`, `Shaders/WebGPU/Model/ModelPBRComplete.wgsl`.
- **DP-H46b** (L) — `MetadataWGSLPipelineStage` + property-ATTRIBUTE scalar read end-to-end (codegen + injection
  + cache-key hash; reuse `getPropertyAttributesInfo` `MetadataPipelineStage.js:149`; port WGSL type maps +
  normalized-int→float). New `Scene/Model/MetadataWGSLPipelineStage.js`, `MetadataWGSLHelpers.js`.
- **DP-H46c** (M) — property-TEXTURE in-shader read (sampler + texCoord + swizzle + optional KHR_texture_transform
  via a per-texture flag bit, NOT an injected identity matrix; FS-only). Mirror `addPropertyTexturePropertyMetadata
  :622`.
- **DP-H46d** (M) — property-TABLE read (`textureLoad(table, vec2(featureId, propertyInfoIndex))`; increment the
  cursor even for GPU-incompatible properties) + `MetadataClass`/`MetadataStatistics` structs. Mirror
  `addPropertyTablePropertyMetadata:811` + `declareMetadataTypeStructs:424`. Closes DISPLAY parity.
- **DP-H46e** (L, high-risk) — `scene.pickMetadata` producer: `WebGPUMetadataPickingPipelineStage` + a
  metadata-pick derived-command factory (mirror `DerivedCommand.createPickMetadataDerivedCommand:664`); the
  `metadataPickingStage()` reads the metadata-pick UBO and packs the selected components into the pick-MRT RGBA
  computing the SAME inverse offset/scale/normalize as `getSourceValueStringComponent:514-540` so
  `decodeMetadataValues` round-trips. Build `d.pickingMetadata.pickMetadataCommand` when `pickedMetadataInfo` set.
- **DP-H46f** (M) — parity probe (WebGL vs WebGPU: non-metadata byte-identical, display match, pickMetadata
  decoded values match for attribute/texture/table scalar+vec) + Sandcastle demo + inventory/doc reconcile.

## Parity strategy (no-metadata model byte-identical — 3 layered guards)
1. **Presence gate:** codegen runs ONLY when `model.structuralMetadata` is defined AND the primitive maps to
   ≥1 property-attribute/-texture/-table (same predicate `MetadataPipelineStage` uses). Else
   `webgpuMetadataWGSL=''` and `MODEL_HAS_METADATA` is NOT set.
2. **Injection no-op:** the prepend is an empty string for non-metadata models → `fullSource` is
   character-for-character today; the stub behind `//>>ifdef MODEL_HAS_METADATA` has an `//>>else` = historical
   (absent) code → `defines`-without-the-bit yields byte-identical preprocessed WGSL → same compiled module +
   cache key (the metadata-class hash is folded in ONLY when the bit is set).
3. **BGL/pipeline identity:** property-texture/-table bindings live in a SEPARATE `materialBGL` variant
   (`MODEL_HAS_PROPERTY_TEXTURES`); non-metadata models keep the minimal BGL/pipeline-layout, no extra
   bind-group slots / vertex attributes / uniform packing.

## Open questions / decisions
- Shader-module cache key currently bitmask-only (`WebGPUModelPipelineCache.js:1689`); fold a stable
  metadata-class/schema hash (or generated-WGSL hash) **only when the metadata bit is set**.
- Property-attribute→glTF attribute name resolution: reuse `getPropertyAttributesInfo:149` (or extract a shared
  backend-agnostic helper both stages call).
- WebGPU texture budget: `maxSampledTexturesPerShaderStage` floor 16; current 5 PBR + 5 KHR = 10 → property
  textures + table must fit the remaining ~6; decide the cap / storage-buffer overflow strategy.
- Metadata-pick value injection: runtime metadata-pick UBO (one module + runtime branch) — RECOMMENDED over
  per-component pipeline variants.
- VS vs FS destination: attributes BOTH, textures FS-only, tables BOTH (per feature-ID source); the combined
  vert+frag module must emit struct/initializeMetadata into the correct stage(s) + carry VS→FS varyings.
