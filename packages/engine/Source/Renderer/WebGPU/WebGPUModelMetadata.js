/**
 * DP-H46a — WebGPU structural-metadata GPU upload + binding scaffolding
 * (first increment of the DP-H46 metadata epic).
 *
 * This module mirrors {@link WebGPUModelFeatureId} for the
 * `EXT_structural_metadata` property-ATTRIBUTE path: it reads
 * `model.structuralMetadata` + the primitive's property-attributes,
 * resolves each property's backing glTF vertex attribute (via the
 * backend-agnostic `MetadataPipelineStage.getPropertyAttributesInfo`
 * name-resolution convention — `property.attribute` is the glTF
 * attribute name, e.g. `_TEMPERATURES`), and uploads a per-vertex vec4
 * value (METADATA-MULTICOMPONENT — up to four components of the first
 * GPU-compatible property attribute; scalars zero-pad) into a dedicated
 * vertex buffer (slot 9 in the model layout) so `ModelPBRComplete.wgsl`'s
 * `@location(9) metadataValue: vec4<f32>` input is fed.
 *
 * What ships in DP-H46a:
 *   - Property-ATTRIBUTE → GPU vertex buffer for ONE scalar value (the
 *     `.x` component of the first GPU-compatible property attribute),
 *     proving the property-ATTRIBUTE → GPU → shader path end-to-end.
 *   - `MODEL_HAS_METADATA` presence detection so the renderer can flip
 *     the ShaderDefine bit + bind the extra vertex slot only when the
 *     primitive actually carries a property attribute.
 *
 * What is deferred (NOT in DP-H46a — see DP-H46_METADATA_DESIGN.md):
 *   - DP-H46b: a generated WGSL `Metadata` struct (one field per
 *     property) + the real `initializeMetadata` (replaces the stub in
 *     ModelPBRComplete.wgsl); multi-component / vec property attributes.
 *   - DP-H46c (NOW LANDED below): property-TEXTURE sampler+texture bind slots.
 *   - DP-H46d (NOW LANDED below): property-TABLE tightly-packed RGBA texture
 *     (`resolvePropertyTableLayout` + `ensurePropertyTableResources` —
 *     re-uploads the loader's retained packed bytes into one rgba8unorm
 *     GPUTexture, indexed by `(featureId, propertyInfoIndex)` via textureLoad).
 *
 * DP-H46c additions (property TEXTURES):
 *   - `resolvePropertyTextureLayout(model, primitive, maxTextures)` — the
 *     SHARED layout both the binding side (this module + the renderer) and
 *     the codegen (`MetadataWGSLPipelineStage`) consume. It iterates the
 *     SAME property-textures `MetadataPipelineStage.getPropertyTexturesInfo`
 *     does (GPU-compatible only), de-duplicates the PHYSICAL textures (many
 *     properties share one image), assigns each unique physical texture a
 *     contiguous (texture, sampler) binding slot starting at
 *     `PROPERTY_TEXTURE_BINDING_BASE`, and returns per-property accessor
 *     info (binding index, channel swizzle, texCoord set, optional
 *     KHR_texture_transform, offset/scale). The two sides MUST agree on
 *     this ordering — that's why it lives in one function.
 *   - `ensurePropertyTextureResources(...)` — uploads each unique physical
 *     texture to the GPU + creates a sampler, mirroring how the model's PBR
 *     textures are created. Idempotent per primitive cache.
 *
 * The single scalar this batch uploads is enough to satisfy the
 * de-risking proof: a scalar property-attribute value reaches the WGSL
 * fragment shader (verified via the metadata-debug fragment-color
 * override gated by `globalThis.CesiumWebGPUMetadataDebug`).
 *
 * @private
 * @module WebGPUModelMetadata
 */
import defined from "../../Core/defined.js";
import Matrix3 from "../../Core/Matrix3.js";
import AttributeType from "../../Scene/AttributeType.js";
import ModelComponents from "../../Scene/ModelComponents.js";
import ModelUtility from "../../Scene/Model/ModelUtility.js";
import { ensureFloat32 } from "../../Scene/Model/ModelPrimitiveGeometry.js";

/**
 * DP-H46c — first group-1 binding for the property-TEXTURE block. The model
 * material BGL occupies bindings 0-38 (UBOs + PBR + KHR + featureId + IBL +
 * BRDF LUT); the property textures begin here so they never collide with the
 * fixed material bindings. The codegen (`MetadataWGSLPipelineStage`) declares
 * `@group(1) @binding(39 + k)` for the k-th unique physical property texture
 * and a SINGLE shared sampler at `@binding(39 + MAX_PROPERTY_TEXTURES)` —
 * both sides derive the slots from this base + {@link PROPERTY_TEXTURE_SAMPLER_BINDING},
 * so they stay in sync.
 *
 * One shared sampler (not one per texture) keeps the fragment-stage sampler
 * count well under the WebGPU spec floor `maxSamplersPerShaderStage = 16`
 * (the model FS already uses ~10-11 samplers across its bind groups; N more
 * texture samplers would blow the budget — and metadata sampling uses the
 * same nearest/clamp state for every property texture anyway).
 *
 * @private
 */
const PROPERTY_TEXTURE_BINDING_BASE = 39;

/**
 * DP-H46c — cap on the number of UNIQUE physical property textures a single
 * primitive's material BGL will bind. The WebGPU spec floor for
 * `maxSampledTexturesPerShaderStage` is 16; the model FS already uses ~12
 * sampled textures in the full-KHR variant (5 PBR + 7 KHR/refraction +
 * featureId + IBL + BRDF LUT), so ~4-6 remain. We cap at 4 unique property
 * textures (4 sampled textures) so the property-texture variant fits even on
 * a spec-floor device when combined with the basic (non-KHR) material variant
 * (10 sampled + 4 = 14 ≤ 16). The pipeline cache's `buildMaterialBGL`
 * capability check is the hard backstop — it throws loudly if a variant ever
 * exceeds the device limit. Most assets use ONE physical property texture
 * (e.g. SimplePropertyTexture packs 3 properties into channels of one image),
 * so the cap rarely binds; overflow properties are dropped from the codegen
 * (logged once) rather than failing the model.
 *
 * @private
 */
const MAX_PROPERTY_TEXTURES = 4;

/**
 * DP-H46c — binding of the SINGLE shared property-texture sampler (one for all
 * property textures). Sits just past the {@link MAX_PROPERTY_TEXTURES} texture
 * bindings.
 *
 * @private
 */
const PROPERTY_TEXTURE_SAMPLER_BINDING =
  PROPERTY_TEXTURE_BINDING_BASE + MAX_PROPERTY_TEXTURES;

/**
 * DP-H46d — group-1 binding of the SINGLE property-TABLE texture. It sits just
 * past the property-texture block (the textures 39..42 + their shared sampler
 * 43), so the fixed material bindings, the property-texture block, and the
 * property-table block never collide. A primitive maps to at most ONE property
 * table (the EXT_mesh_features mapping is 1:1 within a primitive), and all of
 * that table's GPU-compatible properties are packed into ROWS of this single
 * RGBA8 texture — so one binding suffices.
 *
 * The codegen (`MetadataWGSLPipelineStage`) declares
 * `@group(1) @binding(44) var metadataPropertyTableTexture: texture_2d<f32>;`
 * and reads it via `textureLoad(..., vec2<i32>(featureId, propertyInfoIndex), 0)`
 * — no sampler is needed (texel fetch ignores filtering), but the BGL still
 * binds a non-filtering sampler placeholder at the NEXT slot to keep the
 * declaration shape uniform with the property-texture block and satisfy any
 * future sampled-read path.
 *
 * @private
 */
const PROPERTY_TABLE_BINDING = PROPERTY_TEXTURE_SAMPLER_BINDING + 1;

/**
 * DP-H46d — group-1 binding of the property-table's (unused) sampler. Present
 * only to round out the table block; `textureLoad` does not sample, so this is
 * never read by the shader. Kept so the BGL/bind-group/codegen all agree on a
 * stable two-binding table block (texture + sampler), mirroring the
 * property-texture block's (texture, sampler) shape.
 *
 * @private
 */
const PROPERTY_TABLE_SAMPLER_BINDING = PROPERTY_TABLE_BINDING + 1;

/**
 * Resolve the first GPU-compatible property ATTRIBUTE on a primitive and
 * return its per-vertex data packed as vec4 (Float32Array of length
 * `vertexCount * 4`, vertex slot 9's `float32x4` layout).
 *
 * METADATA-MULTICOMPONENT — up to FOUR components per vertex are
 * transported (SCALAR pads `.yzw` with zero; VEC2/VEC3 pad the tail; VEC4
 * and MAT2 fill all four). Properties with more than four components
 * (MAT3/MAT4) still transport only their first four — the codegen
 * (`MetadataWGSLPipelineStage.constructFromTransport`) zero-fills the rest.
 * This replaces DP-H46a's single-scalar (`.x`-only) transport so VEC2/3/4
 * property attributes round-trip every component, matching the WebGL
 * `MetadataPipelineStage` attribute path (which reads the full glTF
 * attribute directly).
 *
 * The property's backing glTF attribute must exist on the primitive AND its
 * typed array must survive to render time (it does on WebGPU — `GltfLoader`
 * retains every vertex attribute's typed array when
 * `context.requiresVertexTypedArrayRetention` is true).
 *
 * Normalized-integer attributes are decoded to float per the glTF
 * `accessor.normalized` rule by `ensureFloat32`, matching the WebGL
 * MetadataPipelineStage path (and `MetadataClassProperty.getGlslType`'s
 * normalized-int→float rule).
 *
 * @param {Model} model
 * @param {ModelComponents.Primitive} primitive
 * @returns {{ data: Float32Array, propertyId: string, attributeName: string, componentCount: number }|undefined}
 * @private
 */
function resolvePropertyAttributeVec4(model, primitive) {
  const structuralMetadata = model.structuralMetadata;
  if (!defined(structuralMetadata)) {
    return undefined;
  }
  const propertyAttributes = structuralMetadata.propertyAttributes;
  if (!defined(propertyAttributes) || propertyAttributes.length === 0) {
    return undefined;
  }
  if (!defined(primitive) || !defined(primitive.attributes)) {
    return undefined;
  }

  for (let i = 0; i < propertyAttributes.length; i++) {
    const propertyAttribute = propertyAttributes[i];
    const properties = propertyAttribute.properties;
    if (!defined(properties)) {
      continue;
    }
    const entries = Object.entries(properties);
    for (let p = 0; p < entries.length; p++) {
      const [propertyId, property] = entries[p];
      // `property.attribute` is the glTF attribute name (e.g.
      // "_TEMPERATURES"). Same name-resolution convention as
      // `MetadataPipelineStage.getPropertyAttributeInfo` (~:178), which
      // calls `ModelUtility.getAttributeByName(primitive, property.attribute)`.
      const attributeName = property.attribute;
      if (!defined(attributeName)) {
        continue;
      }
      const modelAttribute = ModelUtility.getAttributeByName(
        primitive,
        attributeName,
      );
      if (!defined(modelAttribute)) {
        continue;
      }
      const raw = modelAttribute.typedArray || modelAttribute.buffer;
      if (!defined(raw)) {
        // No CPU-side typed array (e.g., WebGL drops them after upload).
        // On WebGPU the loader retains them, so this only skips when the
        // attribute genuinely has no readable data.
        continue;
      }

      const componentCount = AttributeType.getNumberOfComponents(
        modelAttribute.type,
      );
      // Decode honoring `accessor.normalized` + KHR_mesh_quantization so
      // normalized UINT16 (the BoxTexturedWithPropertyAttributes
      // `temperatures` case) lands in [0, 1] exactly as WebGL would.
      const decoded = ensureFloat32(raw, modelAttribute, componentCount);
      const vertexCount = Math.floor(decoded.length / componentCount);
      if (vertexCount <= 0) {
        continue;
      }
      // METADATA-MULTICOMPONENT — pack up to four components per vertex
      // into the vec4 (`float32x4`) buffer the model vertex layout binds
      // at slot 9. Missing tail components stay zero (the Float32Array is
      // zero-initialized), so a SCALAR property transports as (x,0,0,0)
      // and a VEC3 as (x,y,z,0).
      const transported = Math.min(componentCount, 4);
      const packed = new Float32Array(vertexCount * 4);
      for (let v = 0; v < vertexCount; v++) {
        for (let c = 0; c < transported; c++) {
          packed[v * 4 + c] = decoded[v * componentCount + c];
        }
      }
      return {
        data: packed,
        propertyId: propertyId,
        attributeName: attributeName,
        componentCount: transported,
      };
    }
  }
  return undefined;
}

/**
 * Returns true when the primitive maps to ≥1 property ATTRIBUTE whose
 * backing glTF attribute is present with readable per-vertex data. This
 * is the presence predicate the renderer uses to flip
 * `MODEL_HAS_METADATA`. Cheap — short-circuits on the first match — so it
 * can be called from the per-primitive resource path without caching.
 *
 * @param {Model} model
 * @param {ModelComponents.Primitive} primitive
 * @returns {boolean}
 * @private
 */
function primitiveHasPropertyAttribute(model, primitive) {
  return defined(resolvePropertyAttributeVec4(model, primitive));
}

/**
 * Creates (or returns cached) GPU resources for the property-ATTRIBUTE
 * metadata path on a primitive. Mirrors
 * {@link WebGPUModelFeatureId.ensureFeatureIdResources}: idempotent,
 * stamps a per-primitive cache slot, returns the metadata vertex buffer +
 * a presence flag the renderer folds into the `MODEL_HAS_METADATA`
 * pipeline variant. The per-vertex vec4-packed data is pre-resolved at the
 * `extractPrimitiveGeometry` call site (via
 * {@link resolvePropertyAttributeVec4}) and threaded in as
 * `metadataData` so this function — like the featureId-buffer creation —
 * only owns the GPU upload, keeping the heavy attribute resolution off
 * the per-frame path.
 *
 * @param {GPUDevice} device
 * @param {object} primCache - per-primitive cache slot from WebGPUModelRenderer
 * @param {Float32Array} metadataData - per-vertex vec4-packed metadata values
 * @returns {{ metadataBuffer: GPUBuffer, hasMetadata: boolean }|undefined}
 * @private
 */
function ensureMetadataResources(device, primCache, metadataData) {
  // Idempotent cache hit — return the previously-built buffer.
  if (defined(primCache._metadataBuffer)) {
    return {
      metadataBuffer: primCache._metadataBuffer,
      hasMetadata: true,
    };
  }
  if (!defined(metadataData) || metadataData.length === 0) {
    return undefined;
  }

  // WebGPU requires `writeBuffer` source byteLength to be a multiple of
  // 4. A Float32Array is always 4-aligned, so no padding is needed; the
  // buffer size matches the typed array's byteLength.
  const metadataBuffer = device.createBuffer({
    label: `Model metadata attribute (slot 9, vec4)`,
    size: Math.max(metadataData.byteLength, 4),
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(metadataBuffer, 0, metadataData);

  primCache._metadataBuffer = metadataBuffer;

  return {
    metadataBuffer: metadataBuffer,
    hasMetadata: true,
  };
}

/**
 * DP-H46c — resolve the SHARED property-TEXTURE layout for a primitive. Both
 * the binding side (this module's {@link ensurePropertyTextureResources} + the
 * renderer's bind-group splice) and the codegen
 * (`MetadataWGSLPipelineStage.generateMetadataWGSL`) consume this identical
 * structure, so the generated WGSL `@group(1) @binding(N)` numbers match the
 * binding manifest the BGL allocates.
 *
 * Mirrors `MetadataPipelineStage.getPropertyTexturesInfo` (:204): iterates the
 * model's property textures, keeps only GPU-compatible properties (the
 * `classProperty.isGpuCompatible(channels.length)` predicate), and resolves
 * each property's `textureReader` (texCoord set, channels, physical glTF
 * texture, optional KHR_texture_transform, offset/scale via the class).
 *
 * Physical textures are de-duplicated by the glTF texture object reference
 * (the SAME object many `PropertyTextureProperty`s share — e.g.
 * SimplePropertyTexture's three properties all read image index 1). Each
 * unique physical texture gets a contiguous (texture, sampler) binding slot
 * starting at {@link PROPERTY_TEXTURE_BINDING_BASE}; the per-property accessor
 * records which slot to sample.
 *
 * @param {Model} model
 * @param {ModelComponents.Primitive} primitive
 * @param {number} [maxTextures=MAX_PROPERTY_TEXTURES] cap on unique physical
 *   textures; properties whose physical texture would exceed the cap are
 *   dropped (and the caller may log a one-time overflow warning).
 * @returns {{
 *   textures: { reader: object, textureBinding: number, samplerBinding: number }[],
 *   properties: {
 *     propertyId: string,
 *     classProperty: MetadataClassProperty,
 *     textureBinding: number,
 *     samplerBinding: number,
 *     channels: string,
 *     texCoord: number,
 *     transform: Matrix3|undefined,
 *     hasTransform: boolean,
 *   }[],
 *   overflowCount: number,
 * }|undefined} the layout, or `undefined` when the primitive maps to no
 *   GPU-compatible property texture.
 * @private
 */
function resolvePropertyTextureLayout(model, primitive, maxTextures) {
  const cap = defined(maxTextures) ? maxTextures : MAX_PROPERTY_TEXTURES;
  const structuralMetadata = model.structuralMetadata;
  if (!defined(structuralMetadata)) {
    return undefined;
  }
  const propertyTextures = structuralMetadata.propertyTextures;
  if (!defined(propertyTextures) || propertyTextures.length === 0) {
    return undefined;
  }
  if (!defined(primitive)) {
    return undefined;
  }

  // Map a unique PHYSICAL glTF texture object → its slot index (0..cap-1).
  const physicalTextures = []; // [{ reader, textureBinding, samplerBinding }]
  const textureSlotByObject = new Map();
  const properties = [];
  const seenPropertyIds = new Set();
  let overflowCount = 0;

  for (let i = 0; i < propertyTextures.length; i++) {
    const propertyTexture = propertyTextures[i];
    const props = propertyTexture.properties;
    if (!defined(props)) {
      continue;
    }
    const entries = Object.entries(props);
    for (let p = 0; p < entries.length; p++) {
      const [propertyId, property] = entries[p];
      const classProperty = property.classProperty;
      const textureReader = property.textureReader;
      if (!defined(classProperty) || !defined(textureReader)) {
        continue;
      }
      const channels = textureReader.channels;
      if (!defined(channels) || channels.length === 0) {
        continue;
      }
      // Same GPU-compatibility predicate as
      // MetadataPipelineStage.getPropertyTextureInfo (:226).
      if (!classProperty.isGpuCompatible(channels.length)) {
        continue;
      }
      // A property id can appear once per primitive (the property texture
      // set is 1:1 with the class). Guard against accidental dupes.
      if (seenPropertyIds.has(propertyId)) {
        continue;
      }

      const physical = textureReader.texture;
      if (!defined(physical)) {
        continue;
      }

      let slot = textureSlotByObject.get(physical);
      if (!defined(slot)) {
        if (physicalTextures.length >= cap) {
          // Out of budget — drop this property (and any later one that
          // would need a new physical texture). Properties sharing an
          // already-bound physical texture still resolve.
          overflowCount++;
          continue;
        }
        slot = physicalTextures.length;
        const textureBinding = PROPERTY_TEXTURE_BINDING_BASE + slot;
        physicalTextures.push({
          reader: textureReader,
          textureBinding,
          // All property textures SHARE one sampler binding.
          samplerBinding: PROPERTY_TEXTURE_SAMPLER_BINDING,
        });
        textureSlotByObject.set(physical, slot);
      }

      const entry = physicalTextures[slot];
      const transform = textureReader.transform;
      const hasTransform =
        defined(transform) && !Matrix3.equals(transform, Matrix3.IDENTITY);
      seenPropertyIds.add(propertyId);
      properties.push({
        propertyId,
        classProperty,
        textureBinding: entry.textureBinding,
        samplerBinding: entry.samplerBinding,
        channels: channels, // already an "rgba"-subset string
        texCoord: defined(textureReader.texCoord) ? textureReader.texCoord : 0,
        transform: hasTransform ? transform : undefined,
        hasTransform,
      });
    }
  }

  if (physicalTextures.length === 0) {
    return undefined;
  }
  return { textures: physicalTextures, properties, overflowCount };
}

/**
 * Returns true when the primitive maps to ≥1 GPU-compatible property TEXTURE.
 * Cheap presence predicate for the renderer's `MODEL_HAS_PROPERTY_TEXTURES`
 * gate.
 *
 * @param {Model} model
 * @param {ModelComponents.Primitive} primitive
 * @returns {boolean}
 * @private
 */
function primitiveHasPropertyTexture(model, primitive) {
  return defined(resolvePropertyTextureLayout(model, primitive));
}

/**
 * DP-H46c — create (or return cached) GPU resources for the property-TEXTURE
 * block on a primitive: one GPU texture view + one sampler per UNIQUE physical
 * property texture in `layout.textures`. Idempotent (stamps
 * `primCache._propertyTextureResources`). The GPU texture is sourced from the
 * glTF `textureReader.texture` exactly like the model's PBR textures
 * (`WebGPUModelRenderer.createGPUTextureFromReader`), which is passed in as
 * `createGpuTexture` to avoid a circular import. Property-texture data is
 * `rgba8unorm` (NOT `-srgb`) — metadata channel values are raw bytes, never
 * gamma-encoded, so the sampler must not auto-decode sRGB.
 *
 * @param {GPUDevice} device
 * @param {object} primCache per-primitive cache slot
 * @param {object} layout the layout from {@link resolvePropertyTextureLayout}
 * @param {(reader: object) => (GPUTexture|null)} createGpuTexture builds a GPU
 *   texture from a glTF texture reader (linear color space)
 * @param {GPUTexture} fallbackTexture 1×1 placeholder used while a reader's
 *   image hasn't resolved yet
 * @param {GPUSampler} sampler a non-filtering / linear sampler shared by all
 *   property textures (created once on the pipeline cache)
 * @returns {{ entries: {binding:number, resource:GPUTextureView|GPUSampler}[] }|undefined}
 * @private
 */
function ensurePropertyTextureResources(
  device,
  primCache,
  layout,
  createGpuTexture,
  fallbackTexture,
  sampler,
) {
  if (!defined(layout) || layout.textures.length === 0) {
    return undefined;
  }
  // Idempotent — return the cached bind-group entries.
  if (defined(primCache._propertyTextureResources)) {
    return primCache._propertyTextureResources;
  }

  const created = [];
  const entries = [];
  for (let i = 0; i < layout.textures.length; i++) {
    const t = layout.textures[i];
    const gpuTexture = createGpuTexture(t.reader);
    let view;
    if (defined(gpuTexture) && gpuTexture !== null) {
      // Track only textures allocated HERE (createGpuTexture returns a
      // stub-owned texture by reference for WebGLStub-backed readers; the
      // renderer's createGPUTextureFromReader already handles that, but it
      // does not signal ownership, so we conservatively do NOT destroy
      // property textures — they are owned by the glTF texture / stub and
      // freed with the model. `created` stays empty by design.).
      view = gpuTexture.createView();
    } else {
      view = fallbackTexture.createView();
    }
    entries.push({ binding: t.textureBinding, resource: view });
  }
  // Single SHARED sampler binding for every property texture.
  entries.push({
    binding: PROPERTY_TEXTURE_SAMPLER_BINDING,
    resource: sampler,
  });

  const resources = { entries, created };
  primCache._propertyTextureResources = resources;
  return resources;
}

// DP-H46d — always 4 channels (RGBA8) for property-table textures, matching
// `parseStructuralMetadata.NUM_CHANNELS`. Used by `isGpuCompatible` so the
// per-row cursor stays aligned with `collectGpuCompatiblePropertyInfo`.
const PROPERTY_TABLE_NUM_CHANNELS = 4;

/**
 * DP-H46d — resolve which property TABLE (if any) the primitive's selected
 * feature ID references, and the WGSL feature-ID variable that indexes it.
 *
 * Mirrors `MetadataPipelineStage.mapPropertyTablesToFeatureIdSets` for the
 * single-primitive case: a primitive's feature ID set carries a
 * `propertyTableId`; the table whose `id` matches is the one this primitive
 * reads. DP-H46d supports the ATTRIBUTE feature-ID path (the dominant b3dm /
 * BuildingsMetadata case) — the WGSL FS carries the `_FEATURE_ID_0` attribute
 * (flat-interpolated) as `input.featureId0`, so that is the index variable.
 * Texture / instance / implicit feature-ID sources are deferred (the codegen
 * needs the matching WGSL feature-ID variable wired through first).
 *
 * @param {Model} model
 * @param {ModelComponents.Primitive} primitive
 * @returns {{ propertyTable: PropertyTable, featureIdWgslVariable: string }|undefined}
 * @private
 */
function findPropertyTableForPrimitive(model, primitive) {
  const structuralMetadata = model.structuralMetadata;
  if (!defined(structuralMetadata)) {
    return undefined;
  }
  const propertyTables = structuralMetadata.propertyTables;
  if (!defined(propertyTables) || propertyTables.length === 0) {
    return undefined;
  }
  if (!defined(primitive) || !defined(primitive.featureIds)) {
    return undefined;
  }

  const primitiveFeatureIds = primitive.featureIds;
  for (let i = 0; i < primitiveFeatureIds.length; i++) {
    const featureIds = primitiveFeatureIds[i];
    if (!defined(featureIds)) {
      continue;
    }
    const propertyTableId = featureIds.propertyTableId;
    if (!defined(propertyTableId)) {
      continue;
    }
    // DP-H46d scope: only the per-vertex ATTRIBUTE feature-ID path is wired to
    // a WGSL variable (`input.featureId0`). A texture-sourced feature ID
    // (`featureIds.textureReader`) needs its own FS resolution (deferred).
    const isAttribute =
      featureIds instanceof ModelComponents.FeatureIdAttribute;
    if (!isAttribute) {
      continue;
    }
    // Locate the matching property table by id.
    for (let t = 0; t < propertyTables.length; t++) {
      const propertyTable = propertyTables[t];
      if (
        defined(propertyTable.class) &&
        String(propertyTable.id) === String(propertyTableId)
      ) {
        return {
          propertyTable,
          // The WGSL FS exposes the `_FEATURE_ID_0` attribute as
          // `input.featureId0` (flat-interpolated f32) — the codegen casts it
          // to i32 for the table column index.
          featureIdWgslVariable: "featureId0",
        };
      }
    }
  }
  return undefined;
}

/**
 * DP-H46d — resolve the SHARED property-TABLE layout for a primitive. Both the
 * binding side ({@link ensurePropertyTableResources} + the renderer's
 * bind-group splice) and the codegen
 * (`MetadataWGSLPipelineStage.generateMetadataWGSL`) consume this identical
 * structure, so the generated `@binding(N)` numbers + per-property
 * `propertyInfoIndex` rows match the texture the loader packed.
 *
 * Mirrors `MetadataPipelineStage.getPropertyTableInfo` (:289): iterates the
 * table's CLASS-DEFINITION properties (NOT the property-table properties) in
 * order, keeping only GPU-compatible ones, and assigns each a `propertyInfoIndex`
 * (its texture ROW). **The cursor increments ONLY for GPU-compatible
 * properties** — a non-GPU-compatible class property (STRING / variable-length
 * array / 64-bit-vec / BOOLEAN) consumes NO row and is skipped before the
 * increment, exactly as `collectGpuCompatiblePropertyInfo` packs the texture.
 * (Unlike the GLSL stage we do NOT skip used-by-other-stages: the WGSL display
 * proof reads every property, so every GPU-compatible row gets a struct field —
 * and the cursor stays aligned regardless.)
 *
 * @param {Model} model
 * @param {ModelComponents.Primitive} primitive
 * @returns {{
 *   propertyTable: PropertyTable,
 *   textureData: { width: number, height: number, data: Uint8Array },
 *   featureIdWgslVariable: string,
 *   textureBinding: number,
 *   samplerBinding: number,
 *   properties: {
 *     propertyId: string,
 *     classProperty: MetadataClassProperty,
 *     propertyInfoIndex: number,
 *   }[],
 * }|undefined}
 * @private
 */
function resolvePropertyTableLayout(model, primitive) {
  const match = findPropertyTableForPrimitive(model, primitive);
  if (!defined(match)) {
    return undefined;
  }
  const { propertyTable, featureIdWgslVariable } = match;

  // The loader packs ONE RGBA8 texture per table (rows = GPU-compatible class
  // properties, columns = features). WebGPU re-uploads its retained bytes.
  const texture = propertyTable.texture;
  if (!defined(texture) || !defined(texture._propertyTableTextureData)) {
    return undefined;
  }
  const textureData = texture._propertyTableTextureData;

  const classDefinition = propertyTable.class;
  const classProperties = classDefinition?.properties;
  if (!defined(classProperties)) {
    return undefined;
  }

  // The per-instance property values (a `MetadataTableProperty` per propertyId),
  // present when this property table actually carries the property. Its
  // offset/scale OVERRIDE the class defaults (the spec allows per-table-property
  // value transforms), matching GLSL's `property ?? classProperty` in
  // `addPropertyTablePropertyMetadata`.
  const tableProperties = propertyTable.properties;

  const properties = [];
  // Per-table index of the property's ROW in the texture (the texelFetch Y).
  let propertyInfoIndex = 0;
  const entries = Object.entries(classProperties);
  for (let i = 0; i < entries.length; i++) {
    const [propertyId, classProperty] = entries[i];
    // Skip BEFORE incrementing the cursor — non-GPU-compatible properties have
    // NO row in the packed texture (matches collectGpuCompatiblePropertyInfo).
    if (!classProperty.isGpuCompatible(PROPERTY_TABLE_NUM_CHANNELS)) {
      continue;
    }
    // The per-instance property (if this table carries it) supplies the
    // value transform that should win; fall back to the class property.
    const tableProperty = defined(tableProperties)
      ? tableProperties[propertyId]
      : undefined;
    properties.push({
      propertyId,
      classProperty,
      // Use the table-property instance for the value transform when present
      // (it overrides the class offset/scale), else the class property.
      transformProperty: defined(tableProperty) ? tableProperty : classProperty,
      propertyInfoIndex,
    });
    propertyInfoIndex++;
  }

  if (properties.length === 0) {
    return undefined;
  }

  return {
    propertyTable,
    textureData,
    featureIdWgslVariable,
    textureBinding: PROPERTY_TABLE_BINDING,
    samplerBinding: PROPERTY_TABLE_SAMPLER_BINDING,
    properties,
  };
}

/**
 * Returns true when the primitive maps to a GPU-compatible property TABLE
 * reachable via an attribute feature-ID set. Cheap presence predicate for the
 * renderer's `MODEL_HAS_PROPERTY_TABLES` gate.
 *
 * @param {Model} model
 * @param {ModelComponents.Primitive} primitive
 * @returns {boolean}
 * @private
 */
function primitiveHasPropertyTable(model, primitive) {
  return defined(resolvePropertyTableLayout(model, primitive));
}

/**
 * DP-H46d — create (or return cached) GPU resources for the property-TABLE
 * block on a primitive: ONE `rgba8unorm` GPUTexture (the tightly-packed table,
 * rows = properties, columns = features) + one non-filtering sampler
 * placeholder. The packed bytes come from the retained
 * `texture._propertyTableTextureData` (stashed by
 * `parseStructuralMetadata.createTextureForPropertyTable` — the source buffer
 * views are freed after load, so this retained copy is the only readable
 * source on WebGPU). Idempotent (stamps `primCache._propertyTableResources`).
 *
 * The table is `rgba8unorm` (NOT `-srgb`) — the packed property bytes are raw
 * little-endian data, never gamma-encoded — so `textureLoad` returns the
 * normalized channels the codegen reassembles into the raw value.
 *
 * @param {GPUDevice} device
 * @param {object} primCache per-primitive cache slot
 * @param {object} layout the layout from {@link resolvePropertyTableLayout}
 * @param {GPUSampler} sampler a non-filtering sampler (shared, unused by
 *   textureLoad but bound to satisfy the BGL)
 * @returns {{ entries: {binding:number, resource:GPUTextureView|GPUSampler}[] }|undefined}
 * @private
 */
function ensurePropertyTableResources(device, primCache, layout, sampler) {
  if (!defined(layout) || !defined(layout.textureData)) {
    return undefined;
  }
  if (defined(primCache._propertyTableResources)) {
    return primCache._propertyTableResources;
  }

  const { width, height, data } = layout.textureData;
  if (!(width > 0) || !(height > 0) || !defined(data)) {
    return undefined;
  }

  const gpuTexture = device.createTexture({
    label: `Property table texture ${width}x${height}`,
    size: [width, height, 1],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: gpuTexture },
    data,
    { bytesPerRow: width * 4, rowsPerImage: height },
    { width, height, depthOrArrayLayers: 1 },
  );

  const entries = [
    { binding: layout.textureBinding, resource: gpuTexture.createView() },
    { binding: layout.samplerBinding, resource: sampler },
  ];

  const resources = { entries, gpuTexture };
  primCache._propertyTableResources = resources;
  return resources;
}

/**
 * Destroys metadata GPU resources on a primitive cache.
 * @param {object} primCache
 * @private
 */
function destroyMetadataResources(primCache) {
  if (defined(primCache._metadataBuffer)) {
    primCache._metadataBuffer.destroy();
    primCache._metadataBuffer = undefined;
  }
  // DP-H46b — drop the cached generated WGSL chunk + class hash (plain
  // references, no GPU resource to destroy).
  primCache._metadataWGSL = undefined;
  primCache._metadataClassHash = 0;
  // DP-H46c — property-texture views/samplers are owned by the glTF
  // textures / stub (not allocated here), so there's nothing to destroy;
  // just drop the cached entries so a rebuild re-resolves them.
  if (defined(primCache._propertyTextureResources)) {
    primCache._propertyTextureResources = undefined;
  }
  // DP-H46d — the property-table GPUTexture IS allocated here (re-uploaded from
  // the loader's retained bytes), so destroy it.
  if (defined(primCache._propertyTableResources)) {
    const gpuTexture = primCache._propertyTableResources.gpuTexture;
    if (defined(gpuTexture)) {
      gpuTexture.destroy();
    }
    primCache._propertyTableResources = undefined;
  }
}

export {
  ensureMetadataResources,
  destroyMetadataResources,
  primitiveHasPropertyAttribute,
  resolvePropertyAttributeVec4 as resolveMetadataAttributeData,
  // DP-H46c — property TEXTURES.
  resolvePropertyTextureLayout,
  primitiveHasPropertyTexture,
  ensurePropertyTextureResources,
  PROPERTY_TEXTURE_BINDING_BASE,
  PROPERTY_TEXTURE_SAMPLER_BINDING,
  MAX_PROPERTY_TEXTURES,
  // DP-H46d — property TABLES.
  resolvePropertyTableLayout,
  primitiveHasPropertyTable,
  ensurePropertyTableResources,
  PROPERTY_TABLE_BINDING,
  PROPERTY_TABLE_SAMPLER_BINDING,
};
export default {
  ensureMetadataResources,
  destroyMetadataResources,
  primitiveHasPropertyAttribute,
  resolveMetadataAttributeData: resolvePropertyAttributeVec4,
  resolvePropertyTextureLayout,
  primitiveHasPropertyTexture,
  ensurePropertyTextureResources,
  PROPERTY_TEXTURE_BINDING_BASE,
  PROPERTY_TEXTURE_SAMPLER_BINDING,
  MAX_PROPERTY_TEXTURES,
  resolvePropertyTableLayout,
  primitiveHasPropertyTable,
  ensurePropertyTableResources,
  PROPERTY_TABLE_BINDING,
  PROPERTY_TABLE_SAMPLER_BINDING,
};
