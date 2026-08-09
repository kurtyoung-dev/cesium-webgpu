/**
 * WebGPU structural-metadata GPU upload and binding.
 *
 * The counterpart of {@link WebGPUModelFeatureId} for `EXT_structural_metadata`.
 * Three metadata sources are carried to the GPU, each with its own binding
 * shape:
 *
 *   - **Property attributes.** `model.structuralMetadata` and the primitive's
 *     property-attributes are read, each property's backing glTF vertex
 *     attribute is resolved through
 *     `MetadataPipelineStage.getPropertyAttributesInfo` (where
 *     `property.attribute` is the glTF attribute name, such as
 *     `_TEMPERATURES`), and a per-vertex vec4 — up to four components of the
 *     first GPU-compatible property attribute, zero-padded for scalars — is
 *     uploaded into vertex slot 9, feeding `ModelPBRComplete.wgsl`'s
 *     `@location(9) metadataValue: vec4<f32>`. `MODEL_HAS_METADATA` presence
 *     detection lets the renderer set the ShaderDefine bit and bind the extra
 *     vertex slot only for primitives that actually carry one.
 *   - **Property textures.** `resolvePropertyTextureLayout` is the shared
 *     layout that both the binding side — this module and the renderer — and
 *     the codegen in `MetadataWGSLPipelineStage` consume. It iterates the same
 *     GPU-compatible property textures `MetadataPipelineStage.getPropertyTexturesInfo`
 *     does, de-duplicates the physical textures (many properties share one
 *     image), assigns each unique physical texture a contiguous
 *     texture-and-sampler slot from `PROPERTY_TEXTURE_BINDING_BASE`, and
 *     returns per-property accessor info: binding index, channel swizzle,
 *     texCoord set, optional KHR_texture_transform, and offset/scale. Both
 *     sides must agree on that ordering, which is why it lives in one
 *     function. `ensurePropertyTextureResources` then uploads each unique
 *     physical texture and creates a sampler, mirroring how the model's PBR
 *     textures are created, and is idempotent per primitive cache.
 *   - **Property tables.** `resolvePropertyTableLayout` and
 *     `ensurePropertyTableResources` re-upload the loader's retained packed
 *     bytes into one rgba8unorm GPUTexture, indexed by
 *     `(featureId, propertyInfoIndex)` through `textureLoad`.
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
 * One UNIQUE physical property texture and the contiguous (texture, sampler)
 * binding slot pair it was assigned.
 *
 * @typedef {object} PropertyTextureBinding
 * @property {object} reader The glTF `textureReader` the slot samples.
 * @property {number} textureBinding
 * @property {number} samplerBinding
 * @private
 */

/**
 * Per-property accessor info: which physical slot to sample and how to read a
 * value out of it.
 *
 * @typedef {object} PropertyTextureAccessor
 * @property {string} propertyId
 * @property {MetadataClassProperty} classProperty
 * @property {number} textureBinding
 * @property {number} samplerBinding
 * @property {string} channels Channel swizzle, e.g. `"rg"`.
 * @property {number} texCoord Which texCoord set the property samples at.
 * @property {Matrix3|undefined} transform Baked KHR_texture_transform matrix.
 * @property {boolean} hasTransform False when the transform is identity.
 * @private
 */

/**
 * The SHARED property-TEXTURE layout the binding side and the codegen both
 * consume. See {@link resolvePropertyTextureLayout}.
 *
 * @typedef {object} PropertyTextureLayout
 * @property {PropertyTextureBinding[]} textures
 * @property {PropertyTextureAccessor[]} properties
 * @property {number} overflowCount Properties dropped by the texture cap.
 * @private
 */

/**
 * The tightly-packed property-table image: rows = properties, columns =
 * features.
 *
 * @typedef {object} PropertyTableTextureData
 * @property {number} width
 * @property {number} height
 * @property {Uint8Array} data
 * @private
 */

/**
 * Per-property accessor info for the property TABLE: the texture ROW the
 * property's packed bytes live on.
 *
 * @typedef {object} PropertyTableAccessor
 * @property {string} propertyId
 * @property {MetadataClassProperty} classProperty
 * @property {number} propertyInfoIndex
 * @private
 */

/**
 * The SHARED property-TABLE layout the binding side and the codegen both
 * consume. See {@link resolvePropertyTableLayout}.
 *
 * @typedef {object} PropertyTableLayout
 * @property {PropertyTable} propertyTable
 * @property {PropertyTableTextureData} textureData
 * @property {string} featureIdSource
 * @property {string} featureIdWgslVariable
 * @property {number} featureIdTexCoord
 * @property {number} featureIdChannelCount
 * @property {number} textureBinding
 * @property {number} samplerBinding
 * @property {PropertyTableAccessor[]} properties
 * @private
 */

/**
 * One bind-group entry the metadata block contributes to the material BGL.
 *
 * @typedef {object} MetadataBindGroupEntry
 * @property {number} binding
 * @property {GPUTextureView|GPUSampler} resource
 * @private
 */

/**
 * The bind-group entries a metadata block splices into the material bind
 * group.
 *
 * @typedef {object} MetadataBindGroupEntries
 * @property {MetadataBindGroupEntry[]} entries
 * @private
 */

/**
 * A GPU texture plus explicit ownership reporting, so the caller knows whether
 * it must release the texture.
 *
 * @typedef {object} OwnedGpuTexture
 * @property {GPUTexture|null} texture
 * @property {boolean} owned
 * @property {Function} [release]
 * @private
 */

/**
 * Builds a GPU texture from a glTF texture reader. Passed in by the renderer
 * to avoid a circular import. May report ownership explicitly, or return the
 * bare texture when the caller does not own it.
 *
 * @callback CreateGpuTextureCallback
 * @param {object} reader
 * @returns {OwnedGpuTexture|GPUTexture|null}
 * @private
 */

/**
 * The first group-1 binding of the property-texture block.
 *
 * The model material bind-group layout occupies bindings 0-38 — uniform
 * buffers, PBR, KHR, featureId, IBL and the BRDF LUT — so property textures
 * begin past them and never collide. `MetadataWGSLPipelineStage` declares
 * `@group(1) @binding(39 + k)` for the k-th unique physical property texture,
 * plus a single shared sampler at `@binding(39 + MAX_PROPERTY_TEXTURES)`. Both
 * sides derive their slots from this base and
 * {@link PROPERTY_TEXTURE_SAMPLER_BINDING}, so they stay in sync.
 *
 * The sampler is shared rather than one per texture to keep the fragment
 * stage under the WebGPU spec floor of `maxSamplersPerShaderStage = 16`: the
 * model fragment shader already uses 10 to 11 samplers across its bind groups,
 * and metadata sampling uses the same nearest/clamp state for every property
 * texture regardless.
 *
 * @private
 */
const PROPERTY_TEXTURE_BINDING_BASE = 39;

/**
 * Cap on the number of unique physical property textures a single primitive's
 * material bind-group layout will bind.
 *
 * The WebGPU spec floor for `maxSampledTexturesPerShaderStage` is 16, and the
 * model fragment shader already uses about 12 sampled textures in the full-KHR
 * variant (5 PBR, 7 KHR and refraction, plus featureId, IBL and the BRDF LUT),
 * leaving four to six. Four keeps the property-texture variant inside the floor
 * even combined with the basic non-KHR material variant: 10 sampled plus 4 is
 * 14. The `buildMaterialBGL` capability check is the hard backstop and throws
 * if a variant ever exceeds the device limit.
 *
 * Most assets use one physical property texture — SimplePropertyTexture packs
 * three properties into channels of a single image — so the cap rarely binds.
 * Overflow properties are dropped from the codegen, logged once, rather than
 * failing the model.
 *
 * @private
 */
const MAX_PROPERTY_TEXTURES = 4;

/**
 * Binding of the single shared property-texture sampler, which sits just past
 * the {@link MAX_PROPERTY_TEXTURES} texture bindings.
 *
 * @private
 */
const PROPERTY_TEXTURE_SAMPLER_BINDING =
  PROPERTY_TEXTURE_BINDING_BASE + MAX_PROPERTY_TEXTURES;

/**
 * Group-1 binding of the single property-table texture.
 *
 * It sits just past the property-texture block — textures 39 to 42 and their
 * shared sampler at 43 — so the fixed material bindings, the property-texture
 * block and the property-table block never collide. A primitive maps to at most
 * one property table, since the EXT_mesh_features mapping is 1:1 within a
 * primitive, and all of that table's GPU-compatible properties are packed into
 * rows of this one RGBA8 texture, so a single binding suffices.
 *
 * `MetadataWGSLPipelineStage` declares
 * `@group(1) @binding(44) var metadataPropertyTableTexture: texture_2d<f32>;`
 * and reads it with
 * `textureLoad(..., vec2<i32>(featureId, propertyInfoIndex), 0)`. No sampler is
 * needed, because texel fetch ignores filtering, but the layout still binds a
 * non-filtering sampler placeholder at the next slot to keep the declaration
 * shape uniform with the property-texture block.
 *
 * @private
 */
const PROPERTY_TABLE_BINDING = PROPERTY_TEXTURE_SAMPLER_BINDING + 1;

/**
 * Group-1 binding of the property-table's sampler, which the shader never
 * reads: `textureLoad` does not sample. It exists so the bind-group layout, the
 * bind group and the codegen all agree on a stable two-binding table block,
 * mirroring the property-texture block's texture-and-sampler shape.
 *
 * @private
 */
const PROPERTY_TABLE_SAMPLER_BINDING = PROPERTY_TABLE_BINDING + 1;

/**
 * Resolve the first GPU-compatible property ATTRIBUTE on a primitive and
 * return its per-vertex data packed as vec4 (Float32Array of length
 * `vertexCount * 4`, vertex slot 9's `float32x4` layout).
 *
 * Up to four components per vertex are transported: SCALAR pads `.yzw` with
 * zero, VEC2 and VEC3 pad the tail, and VEC4 and MAT2 fill all four. Every
 * component of a VEC2, VEC3 or VEC4 property attribute therefore round-trips,
 * matching the WebGL `MetadataPipelineStage` attribute path, which reads the
 * full glTF attribute directly.
 *
 * MAT3 (9 elements) and MAT4 (16) property attributes widen the pack to four
 * vec4s per vertex — 16 floats of column-major matrix elements, with MAT3
 * zero-padding elements 9 to 15 — so the full matrix transports. The returned
 * `vec4Count` is 4 in that case and 1 otherwise, and drives both the widened
 * `arrayStride = 64` vertex layout at shader locations 9 to 12 and the
 * `MODEL_METADATA_MAT_TRANSPORT` shader variant. Every other shape keeps the
 * single-vec4 pack.
 *
 * The property's backing glTF attribute must exist on the primitive and its
 * typed array must survive to render time, which `GltfLoader` guarantees by
 * retaining every vertex attribute's typed array when
 * `context.requiresVertexTypedArrayRetention` is true.
 *
 * `ensureFloat32` decodes normalized-integer attributes to float per the glTF
 * `accessor.normalized` rule, matching the WebGL MetadataPipelineStage path and
 * `MetadataClassProperty.getGlslType`'s normalized-integer-to-float rule.
 *
 * @param {Model} model
 * @param {ModelComponents.Primitive} primitive
 * @returns {{ data: Float32Array, propertyId: string, attributeName: string, componentCount: number, vec4Count: number }|undefined}
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
      // Pack up to four components per vertex into the `float32x4` buffer the
      // model vertex layout binds at slot 9. Missing tail components stay zero,
      // since the Float32Array is zero-initialized, so a SCALAR property
      // transports as (x,0,0,0) and a VEC3 as (x,y,z,0).
      //
      // MAT3 and MAT4 attributes widen the pack to four vec4s per vertex — 16
      // column-major floats, with MAT3 zero-padding elements 9 to 15 — so the
      // full matrix transports. The test is the glTF attribute TYPE rather than
      // a generic `componentCount > 4`, so only real matrix attributes take the
      // widened layout; the codegen's `matTransport` predicate mirrors this
      // through the same resolve.
      const isMatTransport =
        modelAttribute.type === AttributeType.MAT3 ||
        modelAttribute.type === AttributeType.MAT4;
      const vec4Count = isMatTransport ? 4 : 1;
      const packWidth = vec4Count * 4;
      const transported = Math.min(componentCount, packWidth);
      const packed = new Float32Array(vertexCount * packWidth);
      for (let v = 0; v < vertexCount; v++) {
        for (let c = 0; c < transported; c++) {
          packed[v * packWidth + c] = decoded[v * componentCount + c];
        }
      }
      return {
        data: packed,
        propertyId: propertyId,
        attributeName: attributeName,
        componentCount: transported,
        vec4Count: vec4Count,
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
  try {
    device.queue.writeBuffer(metadataBuffer, 0, metadataData);
  } catch (error) {
    try {
      metadataBuffer.destroy();
    } catch {
      // Preserve the upload failure; the buffer was never published.
    }
    throw error;
  }

  primCache._metadataBuffer = metadataBuffer;

  return {
    metadataBuffer: metadataBuffer,
    hasMetadata: true,
  };
}

/**
 * Resolve the shared property-texture layout for a primitive.
 *
 * Both the binding side — this module's
 * {@link ensurePropertyTextureResources} and the renderer's bind-group splice —
 * and the codegen in `MetadataWGSLPipelineStage.generateMetadataWGSL` consume
 * this identical structure, so the generated WGSL `@group(1) @binding(N)`
 * numbers match the binding manifest the bind-group layout allocates.
 *
 * Mirrors `MetadataPipelineStage.getPropertyTexturesInfo`: iterates the model's
 * property textures, keeps only GPU-compatible properties per the
 * `classProperty.isGpuCompatible(channels.length)` predicate, and resolves each
 * property's `textureReader` — texCoord set, channels, physical glTF texture,
 * optional KHR_texture_transform, and offset/scale from the class.
 *
 * Physical textures are de-duplicated by glTF texture object reference, since
 * many `PropertyTextureProperty` instances share one object; SimplePropertyTexture's
 * three properties, for instance, all read image index 1. Each unique physical
 * texture gets a contiguous texture-and-sampler binding slot starting at
 * {@link PROPERTY_TEXTURE_BINDING_BASE}, and the per-property accessor records
 * which slot to sample.
 *
 * @param {Model} model
 * @param {ModelComponents.Primitive} primitive
 * @param {number} [maxTextures=MAX_PROPERTY_TEXTURES] cap on unique physical
 *   textures; properties whose physical texture would exceed the cap are
 *   dropped (and the caller may log a one-time overflow warning).
 * @returns {PropertyTextureLayout|undefined} the layout, or `undefined` when
 *   the primitive maps to no GPU-compatible property texture.
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
 * Create, or return cached, GPU resources for a primitive's property-texture
 * block: one GPU texture view and one sampler per unique physical property
 * texture in `layout.textures`. Idempotent, stamping
 * `primCache._propertyTextureResources`.
 *
 * The GPU texture is sourced from the glTF `textureReader.texture` exactly as
 * the model's PBR textures are; that builder arrives as `createGpuTexture`
 * rather than being imported, to avoid a circular import. Property-texture data
 * is `rgba8unorm` and never `-srgb`: metadata channel values are raw bytes, not
 * gamma-encoded, so the sampler must not auto-decode sRGB.
 *
 * @param {GPUDevice} device
 * @param {object} primCache per-primitive cache slot
 * @param {PropertyTextureLayout} layout the layout from {@link resolvePropertyTextureLayout}
 * @param {CreateGpuTextureCallback} createGpuTexture builds a GPU texture from
 *   a glTF texture reader and explicitly reports ownership
 * @param {GPUTexture} fallbackTexture 1×1 placeholder used while a reader's
 *   image hasn't resolved yet
 * @param {GPUSampler} sampler a non-filtering / linear sampler shared by all
 *   property textures (created once on the pipeline cache)
 * @returns {MetadataBindGroupEntries|undefined}
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
  try {
    for (let i = 0; i < layout.textures.length; i++) {
      const t = layout.textures[i];
      const result = createGpuTexture(t.reader);
      const hasOwnershipRecord =
        defined(result) &&
        result !== null &&
        typeof result === "object" &&
        Object.prototype.hasOwnProperty.call(result, "texture");
      const gpuTexture = hasOwnershipRecord ? result.texture : result;
      if (hasOwnershipRecord && result.owned && defined(gpuTexture)) {
        created.push({
          texture: gpuTexture,
          release:
            result.release ??
            function () {
              gpuTexture.destroy();
            },
        });
      }
      const view = defined(gpuTexture)
        ? gpuTexture.createView()
        : fallbackTexture.createView();
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
  } catch (error) {
    for (let i = created.length - 1; i >= 0; --i) {
      try {
        created[i].release();
      } catch {
        // Preserve the construction failure; candidates are unpublished.
      }
    }
    throw error;
  }
}

// Property-table textures are always 4 channels (RGBA8), matching
// `parseStructuralMetadata.NUM_CHANNELS`. `isGpuCompatible` uses this so the
// per-row cursor stays aligned with `collectGpuCompatiblePropertyInfo`.
const PROPERTY_TABLE_NUM_CHANNELS = 4;

/**
 * METADATA-TABLE-SOURCES — true when `featureIds` is the model's SELECTED
 * primitive-level feature ID set (the one `model.featureIdLabel` resolves to,
 * matching `findSelectedFeatureId` in `WebGPUModelFeatureId`). The renderer's
 * feature-ID resources (the `featureIdTexture` GPU upload at group-1 binding
 * 26, and the implicit-range `featureId0` vertex synthesis) are built for the
 * SELECTED set only, so a texture-/implicit-sourced property table can key
 * off that data ONLY when its referencing set is the selected one.
 *
 * @param {Model} model
 * @param {ModelComponents.Primitive} primitive
 * @param {object} featureIds a ModelComponents feature ID set
 * @returns {boolean}
 * @private
 */
function isSelectedPrimitiveFeatureIdSet(model, primitive, featureIds) {
  const selected = ModelUtility.getFeatureIdsByLabel(
    primitive.featureIds,
    model.featureIdLabel,
  );
  return defined(selected) && selected === featureIds;
}

/**
 * METADATA-TABLE-SOURCES — mirrors `ensureFeatureIdResources`' feature-table
 * presence gate. The feature-ID GPU texture at binding 26 is only uploaded
 * when the model carries a live feature table, so a texture-sourced table
 * key requires it (otherwise binding 26 holds the fallback white placeholder
 * and the unpacked ID would be garbage).
 *
 * @param {Model} model
 * @returns {boolean}
 * @private
 */
function modelHasFeatureTable(model) {
  const featureTableId = model.featureTableId;
  const featureTables = model.featureTables;
  return (
    defined(featureTableId) &&
    defined(featureTables) &&
    featureTables.length > featureTableId &&
    featureTables[featureTableId].featuresLength > 0
  );
}

/**
 * PARITY-METADATA-TABLE-INSTANCE-SOURCE — resolve the property TABLE keyed by
 * the model's SELECTED instance feature ID set (EXT_mesh_gpu_instancing +
 * EXT_instance_features), if the given node carries one. The renderer packs the
 * per-instance ID into the instance transform pad slot and the VS forwards it to
 * `featureId0`, so the codegen keys the table via the same
 * `i32(metadataFeatureId)` path the ATTRIBUTE/IMPLICIT sources use.
 *
 * Gated on the node's SELECTED instance set (`model.instanceFeatureIdLabel`) —
 * only that set's IDs are transported into the pad slot
 * (`WebGPUModelInstancing.resolveInstanceFeatureIds`). Supported instance
 * sources are ATTRIBUTE + IMPLICIT (a per-instance feature ID TEXTURE is not a
 * thing in EXT_instance_features).
 *
 * @param {Model} model
 * @param {ModelRuntimeNode} runtimeNode
 * @param {PropertyTable[]} propertyTables
 * @returns {object|undefined} the same shape `findPropertyTableForPrimitive`
 *   returns, with `featureIdSource: "instance"`.
 * @private
 */
function findInstancePropertyTable(model, runtimeNode, propertyTables) {
  if (!defined(runtimeNode)) {
    return undefined;
  }
  const node = runtimeNode.node || runtimeNode._node;
  if (!defined(node) || !defined(node.instances)) {
    return undefined;
  }
  const instanceFeatureIds = node.instances.featureIds;
  if (!defined(instanceFeatureIds) || instanceFeatureIds.length === 0) {
    return undefined;
  }
  const selected = ModelUtility.getFeatureIdsByLabel(
    instanceFeatureIds,
    model.instanceFeatureIdLabel,
  );
  if (!defined(selected)) {
    return undefined;
  }
  const propertyTableId = selected.propertyTableId;
  if (!defined(propertyTableId)) {
    return undefined;
  }
  // Only ATTRIBUTE / IMPLICIT instance sources reach `featureId0` (the renderer
  // transports exactly those). A texture-sourced instance feature ID is not a
  // valid EXT_instance_features construct, so guard defensively.
  if (
    !(selected instanceof ModelComponents.FeatureIdAttribute) &&
    !(selected instanceof ModelComponents.FeatureIdImplicitRange)
  ) {
    return undefined;
  }

  for (let t = 0; t < propertyTables.length; t++) {
    const propertyTable = propertyTables[t];
    if (
      defined(propertyTable.class) &&
      String(propertyTable.id) === String(propertyTableId)
    ) {
      return {
        propertyTable,
        featureIdSource: "instance",
        // The VS forwards the per-instance ID to `input.featureId0` (flat), so
        // the codegen's `i32(metadataFeatureId)` column index applies.
        featureIdWgslVariable: "featureId0",
        featureIdTexCoord: 0,
        featureIdChannelCount: 1,
      };
    }
  }
  return undefined;
}

/**
 * Resolve which property table, if any, the primitive's selected feature ID
 * references, and how the WGSL fragment shader resolves the indexing feature ID.
 *
 * Mirrors `MetadataPipelineStage.mapPropertyTablesToFeatureIdSets` for the
 * single-primitive case: a primitive's feature ID set carries a
 * `propertyTableId`, and the table whose `id` matches is the one this primitive
 * reads. Four feature-ID sources are supported:
 *
 *   - Attribute (`FeatureIdAttribute`), the dominant b3dm and
 *     BuildingsMetadata case. The fragment shader carries the
 *     flat-interpolated `_FEATURE_ID_0` attribute as `input.featureId0`, which
 *     is the index variable.
 *   - Texture (`FeatureIdTexture`). The generated `initializeMetadata` samples
 *     the model's feature-ID texture at group-1 binding 26 — the same resource
 *     `ensureFeatureIdResources` uploads for batch styling and picking — at the
 *     reader's texCoord, and unpacks the ID with the module-scope
 *     `unpackFeatureId`. Gated on the referencing set being the model's
 *     selected feature ID set with a live feature table, which are the
 *     conditions under which the binding-26 texture carries this set's data.
 *   - Implicit (`FeatureIdImplicitRange`). The renderer synthesizes the
 *     per-vertex IDs as `offset + floor(vertex / repeat)` into the same
 *     `featureId0` vertex slot, so the attribute path's WGSL variable applies.
 *     Gated on the set being selected, because the synthesis runs only for the
 *     selected set.
 *   - Instance-sourced. When a `runtimeNode` is supplied and its node carries
 *     the model's selected instance feature ID set (EXT_mesh_gpu_instancing
 *     with EXT_instance_features), the renderer packs the per-instance ID into
 *     the instance transform's pad slot and the vertex shader forwards it to
 *     the same flat `featureId0` varying — see
 *     `WebGPUModelInstancing.resolveInstanceFeatureIds`. Instance IDs take
 *     priority over primitive IDs, matching `model.instanceFeatureIdLabel`
 *     precedence, so they are resolved first; the codegen then keys the table
 *     exactly as the attribute and implicit paths do, with
 *     `i32(metadataFeatureId)`.
 *
 * @param {Model} model
 * @param {ModelComponents.Primitive} primitive
 * @param {ModelRuntimeNode} [runtimeNode] - the node this primitive renders
 *   under; enables the instance-sourced path when it carries instance feature
 *   IDs. Optional, so non-instanced callers need not supply it.
 * @returns {{ propertyTable: PropertyTable, featureIdSource: string,
 *   featureIdWgslVariable: string, featureIdTexCoord: number,
 *   featureIdChannelCount: number }|undefined}
 * @private
 */
function findPropertyTableForPrimitive(model, primitive, runtimeNode) {
  const structuralMetadata = model.structuralMetadata;
  if (!defined(structuralMetadata)) {
    return undefined;
  }
  const propertyTables = structuralMetadata.propertyTables;
  if (!defined(propertyTables) || propertyTables.length === 0) {
    return undefined;
  }

  // PARITY-METADATA-TABLE-INSTANCE-SOURCE — instance-sourced feature IDs take
  // priority (matching WebGL's instanceFeatureIdLabel precedence). Resolve the
  // node's SELECTED instance feature ID set before the primitive sets.
  const instanceMatch = findInstancePropertyTable(
    model,
    runtimeNode,
    propertyTables,
  );
  if (defined(instanceMatch)) {
    return instanceMatch;
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

    let featureIdSource;
    let featureIdTexCoord = 0;
    let featureIdChannelCount = 1;
    if (featureIds instanceof ModelComponents.FeatureIdAttribute) {
      featureIdSource = "attribute";
    } else if (featureIds instanceof ModelComponents.FeatureIdTexture) {
      // METADATA-TABLE-SOURCES — texture-sourced feature IDs. The data
      // reaches the shader only through the binding-26 feature-ID texture,
      // which the renderer uploads for the SELECTED set of a model with a
      // live feature table; gate on exactly those conditions.
      const textureReader = featureIds.textureReader;
      if (!defined(textureReader) || !defined(textureReader.texture)) {
        continue;
      }
      if (
        !isSelectedPrimitiveFeatureIdSet(model, primitive, featureIds) ||
        !modelHasFeatureTable(model)
      ) {
        continue;
      }
      featureIdSource = "texture";
      featureIdTexCoord = defined(textureReader.texCoord)
        ? textureReader.texCoord
        : 0;
      // `channels` is an "rgba"-subset string; `unpackFeatureId` assembles
      // little-endian from channel r upward, matching the batch-styling
      // path's `getChannelCount` convention.
      featureIdChannelCount =
        defined(textureReader.channels) && textureReader.channels.length > 0
          ? textureReader.channels.length
          : 1;
    } else if (featureIds instanceof ModelComponents.FeatureIdImplicitRange) {
      // Implicit-range feature IDs. The renderer synthesizes the per-vertex IDs
      // into the `featureId0` vertex slot only when this set is the model's
      // selected feature ID, so gate on that; the attribute WGSL variable then
      // applies.
      if (!isSelectedPrimitiveFeatureIdSet(model, primitive, featureIds)) {
        continue;
      }
      featureIdSource = "implicit";
    } else {
      // Unknown / instance-sourced set — no shader data path yet.
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
          featureIdSource,
          // The WGSL FS exposes the `_FEATURE_ID_0` attribute (real or
          // implicit-synthesized) as `input.featureId0` (flat-interpolated
          // f32) — the codegen casts it to i32 for the table column index.
          // Ignored by the texture source (the codegen samples instead).
          featureIdWgslVariable: "featureId0",
          featureIdTexCoord,
          featureIdChannelCount,
        };
      }
    }
  }
  return undefined;
}

/**
 * Resolve the shared property-table layout for a primitive.
 *
 * Both the binding side — {@link ensurePropertyTableResources} and the
 * renderer's bind-group splice — and the codegen in
 * `MetadataWGSLPipelineStage.generateMetadataWGSL` consume this identical
 * structure, so the generated `@binding(N)` numbers and per-property
 * `propertyInfoIndex` rows match the texture the loader packed.
 *
 * Mirrors `MetadataPipelineStage.getPropertyTableInfo`: iterates the table's
 * class-definition properties, not the property-table properties, in order,
 * keeps only GPU-compatible ones, and assigns each a `propertyInfoIndex` — its
 * texture row. The cursor increments only for GPU-compatible properties: a
 * STRING, variable-length array, 64-bit vector or BOOLEAN class property
 * consumes no row and is skipped before the increment, exactly as
 * `collectGpuCompatiblePropertyInfo` packs the texture. Unlike the GLSL stage,
 * properties used by other stages are not skipped, so every GPU-compatible row
 * gets a struct field; the cursor stays aligned either way.
 *
 * @param {Model} model
 * @param {ModelComponents.Primitive} primitive
 * @param {ModelRuntimeNode} [runtimeNode] - enables the instance-sourced
 *   feature-ID path. Optional, so non-instanced callers need not supply it.
 * @returns {PropertyTableLayout|undefined}
 * @private
 */
function resolvePropertyTableLayout(model, primitive, runtimeNode) {
  const match = findPropertyTableForPrimitive(model, primitive, runtimeNode);
  if (!defined(match)) {
    return undefined;
  }
  const {
    propertyTable,
    featureIdSource,
    featureIdWgslVariable,
    featureIdTexCoord,
    featureIdChannelCount,
  } = match;

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
    featureIdSource,
    featureIdWgslVariable,
    featureIdTexCoord,
    featureIdChannelCount,
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
 * @param {ModelRuntimeNode} [runtimeNode]
 * @returns {boolean}
 * @private
 */
function primitiveHasPropertyTable(model, primitive, runtimeNode) {
  return defined(resolvePropertyTableLayout(model, primitive, runtimeNode));
}

/**
 * Create, or return cached, GPU resources for a primitive's property-table
 * block: one `rgba8unorm` GPUTexture holding the tightly-packed table, with
 * rows for properties and columns for features, plus one non-filtering sampler
 * placeholder. Idempotent, stamping `primCache._propertyTableResources`.
 *
 * The packed bytes come from the retained `texture._propertyTableTextureData`
 * that `parseStructuralMetadata.createTextureForPropertyTable` stashes; the
 * source buffer views are freed after load, so that retained copy is the only
 * readable source here.
 *
 * The table is `rgba8unorm` and never `-srgb`, because the packed property
 * bytes are raw little-endian data rather than gamma-encoded colour, so
 * `textureLoad` returns the normalized channels the codegen reassembles into
 * the raw value.
 *
 * @param {GPUDevice} device
 * @param {object} primCache per-primitive cache slot
 * @param {PropertyTableLayout} layout the layout from {@link resolvePropertyTableLayout}
 * @param {GPUSampler} sampler a non-filtering sampler (shared, unused by
 *   textureLoad but bound to satisfy the BGL)
 * @returns {MetadataBindGroupEntries|undefined}
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
  try {
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
  } catch (error) {
    try {
      gpuTexture.destroy();
    } catch {
      // Preserve the upload/view failure; the texture was never published.
    }
    throw error;
  }
}

/**
 * Destroys metadata GPU resources on a primitive cache.
 * @param {object} primCache
 * @private
 */
function destroyMetadataResources(primCache) {
  let firstDestroyError;
  let hasDestroyError = false;
  const destroyBestEffort = (resource) => {
    if (!defined(resource)) {
      return;
    }
    try {
      resource.destroy();
    } catch (error) {
      if (!hasDestroyError) {
        firstDestroyError = error;
        hasDestroyError = true;
      }
    }
  };

  const metadataBuffer = primCache._metadataBuffer;
  const propertyTextures = primCache._propertyTextureResources?.created;
  const propertyTableTexture = primCache._propertyTableResources?.gpuTexture;
  primCache._metadataBuffer = undefined;
  // Drop the cached generated WGSL chunk and class hash; these are plain
  // references with no GPU resource to destroy.
  primCache._metadataWGSL = undefined;
  primCache._metadataClassHash = 0;
  // Reset the widened-transport flag so a rebuild re-derives it from the fresh
  // codegen result.
  primCache._metadataMatTransport = false;
  // Views and the shared sampler have no explicit destroy operation.
  // Stub-backed textures remain externally owned, while fallback textures
  // created for this primitive carry an explicit release record and are
  // drained below. Drop the cached entries first so a throwing native release
  // cannot leave dangling resources reachable through the primitive cache.
  primCache._propertyTextureResources = undefined;
  // The property-table GPUTexture is allocated here, re-uploaded from the
  // loader's retained bytes, so it must be destroyed.
  primCache._propertyTableResources = undefined;

  destroyBestEffort(metadataBuffer);
  if (defined(propertyTextures)) {
    for (let i = 0; i < propertyTextures.length; ++i) {
      try {
        propertyTextures[i].release();
      } catch (error) {
        if (!hasDestroyError) {
          firstDestroyError = error;
          hasDestroyError = true;
        }
      }
    }
  }
  destroyBestEffort(propertyTableTexture);

  if (hasDestroyError) {
    throw firstDestroyError;
  }
}

export {
  ensureMetadataResources,
  destroyMetadataResources,
  primitiveHasPropertyAttribute,
  resolvePropertyAttributeVec4 as resolveMetadataAttributeData,
  // Property textures.
  resolvePropertyTextureLayout,
  primitiveHasPropertyTexture,
  ensurePropertyTextureResources,
  PROPERTY_TEXTURE_BINDING_BASE,
  PROPERTY_TEXTURE_SAMPLER_BINDING,
  MAX_PROPERTY_TEXTURES,
  // Property tables.
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
