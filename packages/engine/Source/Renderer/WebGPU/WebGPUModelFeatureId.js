/**
 * @module WebGPUModelFeatureId
 *
 * Helper for feature ID texture and batch texture (per-feature styling)
 * resources in the WebGPU model rendering pipeline.
 *
 * Feature ID textures are defined by the EXT_mesh_features glTF extension.
 * Each texel stores an integer identifying the feature (building, wall, etc.)
 * that fragment belongs to. The batch texture then maps feature ID → RGBA color
 * for per-feature styling (e.g., 3D Tiles style expressions).
 *
 * Also handles feature ID vertex attributes (the common b3dm/i3dm case),
 * packed into a storage buffer indexed by vertex_index.
 *
 * @private
 */
import defined from "../../Core/defined.js";
import ModelComponents from "../../Scene/ModelComponents.js";
import ModelUtility from "../../Scene/Model/ModelUtility.js";

// Feature uniform buffer: 48 bytes (12 floats)
const FEATURE_UNIFORM_SIZE = 48;

/**
 * Finds the selected feature ID set for a given model primitive.
 * Mirrors SelectedFeatureIdPipelineStage.getSelectedFeatureIds() logic.
 *
 * @param {Model} model
 * @param {ModelRuntimeNode} runtimeNode
 * @param {ModelComponents.Primitive} primitive
 * @returns {object|undefined} { featureIds, isTexture, isAttribute, isImplicit }
 * @private
 */
function findSelectedFeatureId(model, runtimeNode, primitive) {
  const node = runtimeNode.node || runtimeNode._node;

  // Check instance feature IDs first
  if (defined(node) && defined(node.instances)) {
    const instanceFId = ModelUtility.getFeatureIdsByLabel(
      node.instances.featureIds,
      model.instanceFeatureIdLabel,
    );
    if (defined(instanceFId)) {
      return classifyFeatureId(instanceFId);
    }
  }

  // Then check primitive feature IDs
  if (!defined(primitive.featureIds) || primitive.featureIds.length === 0) {
    return undefined;
  }

  const primFId = ModelUtility.getFeatureIdsByLabel(
    primitive.featureIds,
    model.featureIdLabel,
  );
  if (!defined(primFId)) {
    return undefined;
  }

  return classifyFeatureId(primFId);
}

function classifyFeatureId(featureId) {
  return {
    featureIds: featureId,
    isTexture: featureId instanceof ModelComponents.FeatureIdTexture,
    isAttribute: featureId instanceof ModelComponents.FeatureIdAttribute,
    isImplicit: featureId instanceof ModelComponents.FeatureIdImplicitRange,
  };
}

/**
 * Computes the number of channels used by a feature ID texture.
 * Channels string is like "r", "rg", "rgb", "rgba".
 * @param {string} channels
 * @returns {number} 1-4
 */
function getChannelCount(channels) {
  if (!defined(channels) || channels.length === 0) {
    return 1;
  }
  return channels.length;
}

/**
 * Creates a GPU texture from a CesiumJS Texture's image source.
 * @param {GPUDevice} device
 * @param {object} textureReader - glTF textureReader with .texture property
 * @returns {GPUTexture|null}
 */
function createFeatureIdGPUTexture(device, textureReader) {
  if (!defined(textureReader)) {
    return null;
  }
  const cesiumTexture = textureReader.texture;
  if (!defined(cesiumTexture)) {
    return null;
  }
  const source =
    cesiumTexture._source || cesiumTexture.source || cesiumTexture._image;
  if (!defined(source)) {
    return null;
  }
  const width = source.width || source.naturalWidth || 1;
  const height = source.height || source.naturalHeight || 1;
  if (width === 0 || height === 0) {
    return null;
  }

  try {
    const gpuTexture = device.createTexture({
      label: `FeatureId texture ${width}x${height}`,
      size: [width, height, 1],
      format: "rgba8unorm",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.copyExternalImageToTexture(
      { source, flipY: false },
      { texture: gpuTexture },
      { width, height },
    );
    return gpuTexture;
  } catch (_e) {
    return null;
  }
}

/**
 * Creates a GPU texture from the batch texture's CesiumJS Texture.
 * The batch texture maps feature ID → RGBA color for per-feature styling.
 * @param {GPUDevice} device
 * @param {BatchTexture} batchTexture
 * @returns {GPUTexture|null}
 */
function createBatchGPUTexture(device, batchTexture) {
  // BatchTexture uses a CesiumJS Texture internally
  const cesiumTex = batchTexture.batchTexture || batchTexture.defaultTexture;
  if (!defined(cesiumTex)) {
    return null;
  }

  // Access internal pixel data or image source
  const source = cesiumTex._source || cesiumTex.source || cesiumTex._image;

  // If we have an image source, use copyExternalImageToTexture
  if (defined(source) && (source.width > 0 || source.naturalWidth > 0)) {
    const width = source.width || source.naturalWidth;
    const height = source.height || source.naturalHeight;
    try {
      const gpuTexture = device.createTexture({
        label: `Batch texture ${width}x${height}`,
        size: [width, height, 1],
        format: "rgba8unorm",
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });
      device.queue.copyExternalImageToTexture(
        { source, flipY: false },
        { texture: gpuTexture },
        { width, height },
      );
      return gpuTexture;
    } catch (_e) {
      return null;
    }
  }

  return null;
}

/**
 * Creates or updates GPU resources for feature ID rendering on a primitive.
 *
 * @param {GPUDevice} device
 * @param {object} primCache - Per-primitive cache from WebGPUModelRenderer
 * @param {Model} model
 * @param {ModelComponents.Primitive} primitive - The glTF primitive
 * @param {ModelRuntimeNode} runtimeNode
 * @param {object} pipelineCache - WebGPUModelPipelineCache instance
 * @returns {object|undefined} { featureIdBG, flags } or undefined
 */
function ensureFeatureIdResources(
  device,
  primCache,
  model,
  primitive,
  runtimeNode,
  pipelineCache,
) {
  // Already created
  if (defined(primCache._featureIdBG)) {
    return {
      featureIdBG: primCache._featureIdBG,
      flags: primCache._featureIdFlags || 0,
    };
  }

  // Check if model has feature tables with styling
  const featureTableId = model.featureTableId;
  const featureTables = model.featureTables;
  const hasFeatureTable =
    defined(featureTableId) &&
    defined(featureTables) &&
    featureTables.length > featureTableId &&
    featureTables[featureTableId].featuresLength > 0;

  if (!hasFeatureTable) {
    return undefined;
  }

  // Find the selected feature ID
  const selected = findSelectedFeatureId(model, runtimeNode, primitive);
  if (!defined(selected)) {
    return undefined;
  }

  const featureTable = featureTables[featureTableId];
  const batchTexture = featureTable.batchTexture;
  if (!defined(batchTexture)) {
    return undefined;
  }

  let flags = 0;
  let featureIdTex = null;
  let channelCount = 1;

  // Feature ID texture path
  if (selected.isTexture) {
    const textureReader = selected.featureIds.textureReader;
    featureIdTex = createFeatureIdGPUTexture(device, textureReader);
    if (defined(featureIdTex)) {
      flags |= 0x10000; // FLAG_HAS_FEATURE_ID_TEXTURE (bit 16)
      channelCount = getChannelCount(textureReader.channels);
    }
  }

  // Batch texture (for per-feature styling)
  const batchGPUTex = createBatchGPUTexture(device, batchTexture);
  if (defined(batchGPUTex)) {
    flags |= 0x40000; // FLAG_HAS_BATCH_TABLE (bit 18)
  }

  if (flags === 0) {
    return undefined;
  }

  // Feature uniform buffer
  const uniformData = new Float32Array(FEATURE_UNIFORM_SIZE / 4);
  const uniformDataI32 = new Int32Array(uniformData.buffer);

  // featuresLength (i32)
  uniformDataI32[0] = featureTable.featuresLength;
  // channelCount (i32)
  uniformDataI32[1] = channelCount;
  // texCoordIndex (i32) — which UV set for the feature ID texture
  uniformDataI32[2] = selected.isTexture
    ? (selected.featureIds.textureReader?.texCoord ?? 0)
    : 0;
  // hasMultilineBatchTex (i32)
  const batchDims = batchTexture.textureDimensions;
  uniformDataI32[3] = defined(batchDims) && batchDims.y > 1 ? 1 : 0;

  // textureStep (vec4<f32>)
  const step = batchTexture.textureStep;
  if (defined(step)) {
    uniformData[4] = step.x;
    uniformData[5] = step.y;
    uniformData[6] = step.z ?? 0;
    uniformData[7] = step.w ?? 0;
  }

  // textureDimensions (vec2<f32>) + padding
  if (defined(batchDims)) {
    uniformData[8] = batchDims.x;
    uniformData[9] = batchDims.y;
  }

  const featureUniformBuffer = device.createBuffer({
    label: "Feature ID uniforms",
    size: FEATURE_UNIFORM_SIZE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(featureUniformBuffer, 0, uniformData);

  // Create bind group
  const fallbackTex = pipelineCache.defaultWhiteTexture;
  const fallbackSampler = pipelineCache.defaultSampler;

  primCache._featureIdBG = device.createBindGroup({
    layout: pipelineCache.featureIdBGL,
    entries: [
      {
        binding: 0,
        resource: (featureIdTex || fallbackTex).createView(),
      },
      { binding: 1, resource: fallbackSampler },
      {
        binding: 2,
        resource: (batchGPUTex || fallbackTex).createView(),
      },
      { binding: 3, resource: fallbackSampler },
      { binding: 4, resource: { buffer: featureUniformBuffer } },
    ],
  });

  // Track for cleanup
  primCache._featureIdFlags = flags;
  primCache._featureIdGPUTexture = featureIdTex;
  primCache._batchGPUTexture = batchGPUTex;
  primCache._featureUniformBuffer = featureUniformBuffer;

  return {
    featureIdBG: primCache._featureIdBG,
    flags: flags,
  };
}

/**
 * Destroys feature ID GPU resources on a primitive cache.
 * @param {object} primCache
 */
function destroyFeatureIdResources(primCache) {
  if (defined(primCache._featureIdGPUTexture)) {
    primCache._featureIdGPUTexture.destroy();
    primCache._featureIdGPUTexture = undefined;
  }
  if (defined(primCache._batchGPUTexture)) {
    primCache._batchGPUTexture.destroy();
    primCache._batchGPUTexture = undefined;
  }
  if (defined(primCache._featureUniformBuffer)) {
    primCache._featureUniformBuffer.destroy();
    primCache._featureUniformBuffer = undefined;
  }
  primCache._featureIdBG = undefined;
  primCache._featureIdFlags = undefined;
}

export {
  findSelectedFeatureId,
  ensureFeatureIdResources,
  destroyFeatureIdResources,
};
export default {
  findSelectedFeatureId,
  ensureFeatureIdResources,
  destroyFeatureIdResources,
};
