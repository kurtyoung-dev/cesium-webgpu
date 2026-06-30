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
 * attribute name, e.g. `_TEMPERATURES`), and uploads a per-vertex scalar
 * value into a dedicated vertex buffer (slot 9 in the model layout) so
 * `ModelPBRComplete.wgsl`'s `@location(9) metadataValue` input is fed.
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
 *   - DP-H46d: property-TABLE tightly-packed RGBA texture.
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
 * Resolve the first GPU-compatible scalar-capable property ATTRIBUTE on a
 * primitive and return its per-vertex scalar data (Float32Array of length
 * `vertexCount`).
 *
 * "Scalar-capable" here means: the property's backing glTF attribute
 * exists on the primitive AND its typed array survives to render time
 * (it does on WebGPU — `GltfLoader` retains every vertex attribute's
 * typed array when `context.requiresVertexTypedArrayRetention` is true).
 * The `.x` (first) component is extracted; vec/matrix property attributes
 * still resolve here (their first component is taken) — DP-H46b promotes
 * this to full per-component transport via the generated Metadata struct.
 *
 * Normalized-integer attributes are decoded to float per the glTF
 * `accessor.normalized` rule by `ensureFloat32`, matching the WebGL
 * MetadataPipelineStage path (and `MetadataClassProperty.getGlslType`'s
 * normalized-int→float rule).
 *
 * @param {Model} model
 * @param {ModelComponents.Primitive} primitive
 * @returns {{ data: Float32Array, propertyId: string, attributeName: string }|undefined}
 * @private
 */
function resolvePropertyAttributeScalar(model, primitive) {
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
      // Extract the .x (first) component per vertex into a tight scalar
      // buffer the model vertex layout binds at slot 9.
      const scalar = new Float32Array(vertexCount);
      for (let v = 0; v < vertexCount; v++) {
        scalar[v] = decoded[v * componentCount];
      }
      return {
        data: scalar,
        propertyId: propertyId,
        attributeName: attributeName,
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
  return defined(resolvePropertyAttributeScalar(model, primitive));
}

/**
 * Creates (or returns cached) GPU resources for the property-ATTRIBUTE
 * metadata path on a primitive. Mirrors
 * {@link WebGPUModelFeatureId.ensureFeatureIdResources}: idempotent,
 * stamps a per-primitive cache slot, returns the metadata vertex buffer +
 * a presence flag the renderer folds into the `MODEL_HAS_METADATA`
 * pipeline variant. The per-vertex scalar data is pre-resolved at the
 * `extractPrimitiveGeometry` call site (via
 * {@link resolvePropertyAttributeScalar}) and threaded in as
 * `metadataData` so this function — like the featureId-buffer creation —
 * only owns the GPU upload, keeping the heavy attribute resolution off
 * the per-frame path.
 *
 * @param {GPUDevice} device
 * @param {object} primCache - per-primitive cache slot from WebGPUModelRenderer
 * @param {Float32Array} metadataData - per-vertex scalar metadata values
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
    label: `Model metadata attribute (slot 9)`,
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
}

export {
  ensureMetadataResources,
  destroyMetadataResources,
  primitiveHasPropertyAttribute,
  resolvePropertyAttributeScalar as resolveMetadataAttributeData,
  // DP-H46c — property TEXTURES.
  resolvePropertyTextureLayout,
  primitiveHasPropertyTexture,
  ensurePropertyTextureResources,
  PROPERTY_TEXTURE_BINDING_BASE,
  PROPERTY_TEXTURE_SAMPLER_BINDING,
  MAX_PROPERTY_TEXTURES,
};
export default {
  ensureMetadataResources,
  destroyMetadataResources,
  primitiveHasPropertyAttribute,
  resolveMetadataAttributeData: resolvePropertyAttributeScalar,
  resolvePropertyTextureLayout,
  primitiveHasPropertyTexture,
  ensurePropertyTextureResources,
  PROPERTY_TEXTURE_BINDING_BASE,
  PROPERTY_TEXTURE_SAMPLER_BINDING,
  MAX_PROPERTY_TEXTURES,
};
