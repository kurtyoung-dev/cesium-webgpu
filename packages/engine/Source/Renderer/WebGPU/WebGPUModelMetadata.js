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
 *   - DP-H46c: property-TEXTURE sampler+texture bind slots.
 *   - DP-H46d: property-TABLE tightly-packed RGBA texture.
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
import AttributeType from "../../Scene/AttributeType.js";
import ModelUtility from "../../Scene/Model/ModelUtility.js";
import { ensureFloat32 } from "../../Scene/Model/ModelPrimitiveGeometry.js";

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
}

export {
  ensureMetadataResources,
  destroyMetadataResources,
  primitiveHasPropertyAttribute,
  resolvePropertyAttributeScalar as resolveMetadataAttributeData,
};
export default {
  ensureMetadataResources,
  destroyMetadataResources,
  primitiveHasPropertyAttribute,
  resolveMetadataAttributeData: resolvePropertyAttributeScalar,
};
