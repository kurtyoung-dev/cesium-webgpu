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

// Feature uniform buffer.
// Layout (14 floats / 56 bytes):
//   0  : featuresLength (i32)
//   1  : channelCount (i32)
//   2  : texCoordIndex (i32)
//   3  : hasMultilineBatchTex (i32)
//   4-7: textureStep (vec4)
//   8-9: textureDimensions (vec2)
//   10 : _pad0 (carries `featurePickEnabled` from offset 10 onward
//        per Batch 100 — see WebGPU shader's FeatureIdUniforms struct)
//   11 : _pad1
//   12 : featurePickEnabled (f32, 0/1)
//   13 : _pad2
//
// C-R9-MODEL-FEATURE-PICK (Batch 100) extended the layout from 48 B to
// 56 B for the per-feature pick gate. The previous fields keep their
// offsets to preserve compatibility with the WebGL fallback that mirrors
// this layout.
const FEATURE_UNIFORM_SIZE = 56;

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
 *
 * PRIMARY PATH (Cesium3DTileStyle / batched tiles): reads
 * `batchTexture._batchValues` — a Uint8Array of length
 * `featuresLength * 4` laid out as per-feature RGBA. Dimensions come from
 * `batchTexture._textureDimensions` (BatchTexture packs features into a
 * 2D texture so wide feature counts don't blow past MAX_TEXTURE_SIZE).
 * Uploaded via `queue.writeTexture` because the WebGL Texture wrapper
 * never populates `_source` for these array-backed textures.
 *
 * Fallback: if an ImageBitmap / Image is attached (rare — some custom
 * Cesium3DTileFeatureTable paths), use copyExternalImageToTexture.
 *
 * @param {GPUDevice} device
 * @param {BatchTexture} batchTexture
 * @returns {{texture: GPUTexture, width: number, height: number}|null}
 */
function createBatchGPUTexture(device, batchTexture) {
  const cesiumTex = batchTexture.batchTexture || batchTexture.defaultTexture;

  // PRIMARY PATH — per-feature RGBA byte array + declared dimensions.
  // This is what populates on EVERY batched 3D Tile.
  const batchValues = batchTexture._batchValues;
  const dimensions = batchTexture._textureDimensions;
  if (defined(batchValues) && defined(dimensions) && dimensions.x > 0) {
    const width = dimensions.x;
    const height = dimensions.y;
    try {
      const gpuTexture = device.createTexture({
        label: `Batch texture ${width}x${height}`,
        size: [width, height, 1],
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      device.queue.writeTexture(
        { texture: gpuTexture },
        batchValues,
        { bytesPerRow: width * 4, rowsPerImage: height },
        { width, height, depthOrArrayLayers: 1 },
      );
      return { texture: gpuTexture, width, height };
    } catch (_e) {
      return null;
    }
  }

  // FALLBACK — ImageBitmap / Image source.
  if (!defined(cesiumTex)) {
    return null;
  }
  const source = cesiumTex._source || cesiumTex.source || cesiumTex._image;
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
      return { texture: gpuTexture, width, height };
    } catch (_e) {
      return null;
    }
  }

  return null;
}

/**
 * Re-upload the per-feature RGBA bytes to an already-allocated batch
 * GPUTexture. Called from `ensureFeatureIdResources` when
 * `batchTexture._batchValuesDirty` is true — this is what makes runtime
 * `setShow(id, false)` / `setColor(id, newColor)` actually propagate to
 * the GPU on subsequent frames instead of freezing at tile-load state.
 */
function updateBatchGPUTexture(device, gpuTexture, batchTexture) {
  const batchValues = batchTexture._batchValues;
  const dimensions = batchTexture._textureDimensions;
  if (!defined(batchValues) || !defined(dimensions) || dimensions.x <= 0) {
    return;
  }
  const width = dimensions.x;
  const height = dimensions.y;
  try {
    device.queue.writeTexture(
      { texture: gpuTexture },
      batchValues,
      { bytesPerRow: width * 4, rowsPerImage: height },
      { width, height, depthOrArrayLayers: 1 },
    );
  } catch (_e) {
    // Dimensions mismatched or device lost — next frame's ensureFeatureIdResources
    // will rebuild from scratch when the cache is next probed.
  }
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
  context,
  modelCache,
  pickPassActive,
) {
  // Already created — but if the batch texture values changed since last
  // frame (user called setShow / setColor on a Cesium3DTileFeature), the
  // per-feature RGBA has to be re-uploaded. BatchTexture flips
  // `_batchValuesDirty = true` on each such mutation; we mirror the
  // WebGL updateBatchTexture() behaviour by re-uploading and clearing
  // the flag here.
  if (defined(primCache._featureIdBG)) {
    const featureTableId = model.featureTableId;
    const featureTables = model.featureTables;
    if (
      defined(featureTableId) &&
      defined(featureTables) &&
      featureTables.length > featureTableId
    ) {
      const batchTexture = featureTables[featureTableId].batchTexture;
      if (
        defined(batchTexture) &&
        batchTexture._batchValuesDirty &&
        defined(primCache._batchGPUTexture)
      ) {
        updateBatchGPUTexture(device, primCache._batchGPUTexture, batchTexture);
        batchTexture._batchValuesDirty = false;
      }
    }
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

  // Batch texture (for per-feature styling). createBatchGPUTexture now
  // returns { texture, width, height } or null. The first-upload consumes
  // the authoritative `batchTexture._batchValues` bytes via
  // queue.writeTexture — previously this path silently returned null for
  // every Cesium3DTileFeatureTable (which uses arrayBufferView, not
  // ImageBitmap, as its source), which is exactly why
  // Cesium3DTileStyle.color / show was a no-op on WebGPU.
  const batchGPUResult = createBatchGPUTexture(device, batchTexture);
  const batchGPUTex = batchGPUResult ? batchGPUResult.texture : null;
  if (defined(batchGPUTex)) {
    flags |= 0x40000; // FLAG_HAS_BATCH_TABLE (bit 18)
    // Mark the per-feature values as "synced with GPU" so the very next
    // ensureFeatureIdResources() call doesn't re-upload unchanged data.
    batchTexture._batchValuesDirty = false;
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
  // C-R9-MODEL-FEATURE-PICK (Batch 100/101) — `featurePickEnabled` flag
  // at float offset 12. Flipped to 1.0 when a feature-pick texture has
  // been allocated for this model. Allocation is eager when a batch
  // table is present (any of the model's primitives could enter a pick
  // pass at any time; the alternative — allocating on first pick pass —
  // races against the bind group construction below since the BG would
  // bind a placeholder texture that's wrong when pick fires). Cost is
  // bounded: one Uint8Array of W*H*4 bytes (matches batch texture
  // dimensions) + featuresLength pickId allocations, idempotent across
  // re-renders.
  let featurePickTex = null;
  if (
    defined(context) &&
    defined(modelCache) &&
    flags & 0x40000 // FLAG_HAS_BATCH_TABLE
  ) {
    featurePickTex = ensurePerFeaturePickIds(
      device,
      primCache,
      modelCache,
      context,
      model,
      batchTexture,
    );
  }
  uniformData[12] = defined(featurePickTex) ? 1.0 : 0.0;
  // Suppress unused-var for `pickPassActive` — kept in the signature so
  // callers can still gate the allocation if it ever becomes too
  // expensive (e.g., very large batch tables).
  void pickPassActive;

  const featureUniformBuffer = device.createBuffer({
    label: "Feature ID uniforms",
    size: FEATURE_UNIFORM_SIZE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(featureUniformBuffer, 0, uniformData);

  // NEW-BG-CONSOLIDATION (Batch 122) — feature ID resources moved into
  // the merged group 1 bind group at bindings 26-32. The renderer
  // splices the entries returned here into the merged group 1's
  // `entries[]` array; there's no standalone feature ID bind group
  // anymore.
  const fallbackTex = pipelineCache.defaultWhiteTexture;
  const fallbackSampler = pipelineCache.defaultSampler;
  const featureIdEntries = [
    {
      binding: 26,
      resource: (featureIdTex || fallbackTex).createView(),
    },
    { binding: 27, resource: fallbackSampler },
    {
      binding: 28,
      resource: (batchGPUTex || fallbackTex).createView(),
    },
    { binding: 29, resource: fallbackSampler },
    { binding: 30, resource: { buffer: featureUniformBuffer } },
    // C-R9-MODEL-FEATURE-PICK — feature-pick texture + sampler.
    // Allocated lazily by `ensurePerFeaturePickIds` when a batch table
    // is present; otherwise placeholder white texture (the FS gates
    // on `featurePickEnabled` so the placeholder is never sampled).
    {
      binding: 31,
      resource: (featurePickTex || fallbackTex).createView(),
    },
    { binding: 32, resource: fallbackSampler },
  ];

  // Track for cleanup
  primCache._featureIdFlags = flags;
  primCache._featureIdEntries = featureIdEntries;
  primCache._featureIdGPUTexture = featureIdTex;
  primCache._batchGPUTexture = batchGPUTex;
  primCache._featureUniformBuffer = featureUniformBuffer;

  return {
    featureIdEntries,
    flags: flags,
  };
}

/**
 * C-R9-MODEL-FEATURE-PICK (Batch 101) — allocate per-feature pickIds for
 * the model's batch table and upload an RGBA8 GPU texture mapping
 * featureId → pickColor (the same shape as the batch styling texture).
 *
 * Side effects:
 *  - On the per-PRIMITIVE cache: stamps `_featurePickGPUTexture` with the
 *    allocated GPU texture so subsequent `ensureFeatureIdResources()`
 *    calls bind it at @binding(5) of the FeatureId BGL.
 *  - On the per-MODEL cache: stamps `cache._featurePickIds` (Map of
 *    `featureId → CesiumPickId`) so allocated pickIds survive across
 *    re-renders and pick-pass readback resolves through them.
 *  - Flips `featureUniformData[12]` (`featurePickEnabled`) to 1.0 so the
 *    pickFS routes through `lookupFeaturePickColor`.
 *
 * Idempotent: subsequent calls reuse the cached texture + pickIds. The
 * texture only re-uploads when the batch table's featuresLength changes
 * (rare — handled by destroying the cache slot and re-running).
 *
 * Allocation policy: one pickId per feature, eagerly on the FIRST pick
 * pass that reaches a model with a batch table. The pickId target is
 * `{primitive: model, id: featureId}` so `scene.pick()` returns the
 * featureId of the picked feature alongside the model itself.
 *
 * @param {GPUDevice} device
 * @param {object} primCache - per-primitive cache slot
 * @param {object} cache - per-model cache slot
 * @param {object} context - WebGPU context (provides `createPickId`)
 * @param {object} model
 * @param {object} batchTexture - Cesium BatchTexture instance
 * @returns {GPUTexture|null} the cached / freshly-built feature-pick GPU texture
 * @private
 */
function ensurePerFeaturePickIds(
  device,
  primCache,
  cache,
  context,
  model,
  batchTexture,
) {
  if (!defined(batchTexture)) {
    return null;
  }
  const featuresLength = batchTexture.featuresLength;
  if (!defined(featuresLength) || featuresLength === 0) {
    return null;
  }
  const dimensions = batchTexture._textureDimensions;
  if (!defined(dimensions) || dimensions.x === 0 || dimensions.y === 0) {
    return null;
  }

  // Cache hits: reuse the prior allocation. The texture is owned by the
  // per-MODEL cache so multi-primitive models share the same pickId set.
  if (
    defined(cache._featurePickGPUTexture) &&
    cache._featurePickFeaturesLength === featuresLength
  ) {
    primCache._featurePickGPUTexture = cache._featurePickGPUTexture;
    return cache._featurePickGPUTexture;
  }

  // Allocate one pickId per feature. Cesium pickIds are byte-exact RGBA
  // colors that round-trip through the pick FBO; allocating in a
  // contiguous block keeps the texture upload tight.
  if (!defined(cache._featurePickIds)) {
    cache._featurePickIds = new Map();
  }
  const pickIds = cache._featurePickIds;
  const data = new Uint8Array(dimensions.x * dimensions.y * 4);
  for (let fid = 0; fid < featuresLength; fid++) {
    let pid = pickIds.get(fid);
    if (!defined(pid)) {
      pid = context.createPickId({ primitive: model, id: fid }, "feature");
      pickIds.set(fid, pid);
    }
    const off = fid * 4;
    const c = pid.color;
    data[off] = Math.round((c.red ?? 0) * 255);
    data[off + 1] = Math.round((c.green ?? 0) * 255);
    data[off + 2] = Math.round((c.blue ?? 0) * 255);
    data[off + 3] = Math.round((c.alpha ?? 1) * 255);
  }

  const tex = device.createTexture({
    label: `Feature pick texture ${dimensions.x}x${dimensions.y}`,
    size: [dimensions.x, dimensions.y, 1],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: tex },
    data,
    { bytesPerRow: dimensions.x * 4, rowsPerImage: dimensions.y },
    { width: dimensions.x, height: dimensions.y, depthOrArrayLayers: 1 },
  );
  cache._featurePickGPUTexture = tex;
  cache._featurePickFeaturesLength = featuresLength;
  primCache._featurePickGPUTexture = tex;
  return tex;
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
