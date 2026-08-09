/**
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
 * @module WebGPUModelFeatureId
 */
import defined from "../../Core/defined.js";
import ModelComponents from "../../Scene/ModelComponents.js";
import ModelUtility from "../../Scene/Model/ModelUtility.js";
import { getWebGPUTextureForDevice } from "./Stubs/WebGLStubTexture.js";

// Feature uniform buffer.
// Layout (12 floats / 48 bytes — matches WGSL `FeatureIdUniforms`):
//   0  : featuresLength (i32)
//   1  : channelCount (i32)
//   2  : texCoordIndex (i32)
//   3  : hasMultilineBatchTex (i32)
//   4-7: textureStep (vec4)
//   8-9: textureDimensions (vec2)
//   10 : featurePickEnabled (f32, 0/1)
//   11 : _pad1
//
// `featurePickEnabled` sits at slot 10 (byte 40), directly after
// textureDimensions, because that is where the WGSL struct declares it. Writing
// it at slot 12 instead leaves slot 10 an unwritten pad, the shader reads 0,
// and the per-feature pick path never activates — picking a batch-table tileset
// then returns material.pickColor, the primitive-granularity pick id, rather
// than the per-feature one.
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
      return classifyFeatureId(instanceFId, true);
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

  return classifyFeatureId(primFId, false);
}

function classifyFeatureId(featureId, isInstance) {
  return {
    featureIds: featureId,
    isTexture: featureId instanceof ModelComponents.FeatureIdTexture,
    isAttribute: featureId instanceof ModelComponents.FeatureIdAttribute,
    isImplicit: featureId instanceof ModelComponents.FeatureIdImplicitRange,
    // PARITY-METADATA-TABLE-INSTANCE-SOURCE — true when the selected set comes
    // from `node.instances.featureIds` (per-instance) rather than the primitive
    // (per-vertex). The per-vertex implicit synthesis MUST NOT fire for it — the
    // instance ID rides the instance-transform pad slot → `featureId0` instead.
    isInstance: isInstance === true,
  };
}

/**
 * Returns the selected primitive-scoped implicit feature-ID source without
 * allocating the classification wrapper used by the general feature path.
 * Instance feature IDs take precedence and intentionally return null because
 * their ID is transported with the instance transform, not synthesized per
 * vertex.
 *
 * @param {Model} model
 * @param {ModelRuntimeNode} runtimeNode
 * @param {ModelComponents.Primitive} primitive
 * @returns {ModelComponents.FeatureIdImplicitRange|null}
 * @private
 */
function getSelectedImplicitFeatureId(model, runtimeNode, primitive) {
  const node = runtimeNode.node || runtimeNode._node;
  if (defined(node) && defined(node.instances)) {
    const instanceFeatureId = ModelUtility.getFeatureIdsByLabel(
      node.instances.featureIds,
      model.instanceFeatureIdLabel,
    );
    if (defined(instanceFeatureId)) {
      return null;
    }
  }

  if (!defined(primitive?.featureIds) || primitive.featureIds.length === 0) {
    return null;
  }
  const primitiveFeatureId = ModelUtility.getFeatureIdsByLabel(
    primitive.featureIds,
    model.featureIdLabel,
  );
  return primitiveFeatureId instanceof ModelComponents.FeatureIdImplicitRange
    ? primitiveFeatureId
    : null;
}

/**
 * Synthesize a per-vertex Float32Array of feature IDs for primitives that select
 * a `FeatureIdImplicitRange`.
 *
 * Such primitives carry no per-vertex `_FEATURE_ID_0` accessor; the feature ID
 * is `offset + floor(vertex_index / repeat)`. Materializing it as an explicit
 * vertex-attribute buffer lets the same shader and JS path that handles
 * `_FEATURE_ID_0` consume it unchanged. Returns `null` when no implicit feature
 * ID is selected, or when the model's featureIdLabel resolves to a texture,
 * attribute or not-found case, which their own branches already handle.
 *
 * @param {Model} model
 * @param {ModelRuntimeNode} runtimeNode
 * @param {ModelComponents.Primitive} primitive
 * @param {number} vertexCount
 * @returns {Float32Array|null}
 * @private
 */
function synthesizeImplicitFeatureIdData(
  model,
  runtimeNode,
  primitive,
  vertexCount,
) {
  if (!defined(primitive) || vertexCount <= 0) {
    return null;
  }
  const fid = getSelectedImplicitFeatureId(model, runtimeNode, primitive);
  if (!defined(fid)) {
    return null;
  }
  // FeatureIdImplicitRange exposes offset (default 0) and repeat
  // (default 1). Per the EXT_mesh_features spec the lookup is
  // `id = offset + floor(vertex_index / repeat)`.
  const offset = fid.offset ?? 0;
  const repeat = Math.max(1, fid.repeat ?? 1);
  const data = new Float32Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) {
    data[v] = offset + Math.floor(v / repeat);
  }
  return data;
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
function createFeatureIdGPUTexture(device, resourceGeneration, textureReader) {
  if (!defined(textureReader)) {
    return null;
  }
  const cesiumTexture = textureReader.texture;
  if (!defined(cesiumTexture)) {
    return null;
  }
  // The same stub-reuse path as `createGPUTextureFromReader`: under WebGPU the
  // CesiumJS Texture is backed by WebGLStubTexture, which uploads the image to
  // a real GPUTexture and does not retain `_source`. Without this branch every
  // glTF feature-ID texture falls back to the white placeholder, giving every
  // fragment feature ID 255. The returned texture is owned by the stub, so
  // callers must not destroy it — see destroyFeatureIdResources' ownership
  // guard.
  const stubWrapper = cesiumTexture._texture;
  const stubGPU = getWebGPUTextureForDevice(
    stubWrapper,
    device,
    resourceGeneration,
  );
  if (stubGPU && stubGPU.texture) {
    return stubGPU.texture;
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

  let gpuTexture;
  try {
    gpuTexture = device.createTexture({
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
    try {
      gpuTexture?.destroy();
    } catch {
      // Candidate was never published; preserve the upload failure contract.
    }
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
  // `_batchValues` is allocated lazily by `BatchTexture.setColor` /
  // `setShow` (see BatchTexture.js:466-474, getBatchValues), so a freshly
  // loaded b3dm tileset whose features still carry the default white
  // colour leaves the slot undefined. WebGL's BatchTexture.update path
  // skips `createTexture` in that case (no upload until a colour change),
  // but the WebGPU path needs the GPU texture to exist up front so
  // FLAG_HAS_BATCH_TABLE gates on, the per-feature pick texture is
  // allocated, and the merged material BG carries valid bindings.
  // Mirror getBatchValues' default fill (255 = opaque white / show=true)
  // so the first frame ships valid data.
  let batchValues = batchTexture._batchValues;
  const dimensions = batchTexture._textureDimensions;
  if (
    !defined(batchValues) &&
    defined(dimensions) &&
    dimensions.x > 0 &&
    dimensions.y > 0
  ) {
    batchValues = new Uint8Array(dimensions.x * dimensions.y * 4).fill(255);
    batchTexture._batchValues = batchValues;
  }
  if (defined(batchValues) && defined(dimensions) && dimensions.x > 0) {
    const width = dimensions.x;
    const height = dimensions.y;
    let gpuTexture;
    try {
      gpuTexture = device.createTexture({
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
      try {
        gpuTexture?.destroy();
      } catch {
        // Candidate was never published; preserve the upload failure contract.
      }
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
    let gpuTexture;
    try {
      gpuTexture = device.createTexture({
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
      try {
        gpuTexture?.destroy();
      } catch {
        // Candidate was never published; preserve the upload failure contract.
      }
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
 * @returns {object|undefined} { featureIdEntries, flags } or undefined
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
  // Already created. If the batch texture values changed since the last frame —
  // an application called setShow or setColor on a Cesium3DTileFeature —
  // the per-feature RGBA has to be re-uploaded. BatchTexture flips
  // `_batchValuesDirty` on each such mutation, and this mirrors WebGL's
  // `updateBatchTexture()` by re-uploading and clearing the flag.
  //
  // The previously returned `entries[]` is cached, so this is an early-exit hit
  // that still refreshes the batch texture when the source data is dirty and
  // per-feature styling therefore reaches the GPU.
  if (defined(primCache._featureIdEntries)) {
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
      featureIdEntries: primCache._featureIdEntries,
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
  let featureIdTexOwned = false;
  if (selected.isTexture) {
    const textureReader = selected.featureIds.textureReader;
    const resourceGeneration = context?.resourceGeneration ?? 0;
    featureIdTex = createFeatureIdGPUTexture(
      device,
      resourceGeneration,
      textureReader,
    );
    if (defined(featureIdTex)) {
      flags |= 0x10000; // FLAG_HAS_FEATURE_ID_TEXTURE (bit 16)
      channelCount = getChannelCount(textureReader.channels);
      // METADATA-TABLE-SOURCES — ownership: when the texture is the
      // WebGLStubTexture's already-uploaded GPUTexture (reused by
      // reference), the stub owns it and destroyFeatureIdResources must
      // NOT destroy it; only textures allocated by
      // createFeatureIdGPUTexture itself are ours to free.
      featureIdTexOwned =
        getWebGPUTextureForDevice(
          textureReader?.texture?._texture,
          device,
          resourceGeneration,
        )?.texture !== featureIdTex;
    }
  }

  // Vertex-attribute path. Sets `FLAG_HAS_FEATURE_ID_ATTRIBUTE` (bit 17) so the
  // fragment shader reads the per-vertex featureId varying at slot 8 and
  // indexes the batch and pick textures with it. The renderer wires
  // `geometry.featureId0Data` — the typed array `extractPrimitiveGeometry`
  // pulls from the primitive's `_FEATURE_ID_0` accessor — into vertex slot 8 in
  // `createPrimitiveResources`. b3dm tilesets reach this path because the
  // loader renames `_BATCHID` to `_FEATURE_ID_0`.
  //
  // `FeatureIdImplicitRange` lands in the same bucket. It has no typed array of
  // its own, but `extractPrimitiveGeometry` synthesizes one from
  // `offset + floor(vertex_index / repeat)` when an implicit feature ID is
  // selected, so `geometry.featureId0Data` is populated by the time execution
  // arrives here and the same flag applies. The fragment-shader branch is
  // identical to the explicit-attribute path: a flat-interpolated f32 lookup at
  // slot 8.
  if (selected.isAttribute || selected.isImplicit) {
    flags |= 0x20000; // FLAG_HAS_FEATURE_ID_ATTRIBUTE (bit 17)
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
  // The `featurePickEnabled` flag sits at float offset 10 (byte 40), directly
  // after textureDimensions, matching the WGSL struct. It flips to 1.0 once a
  // feature-pick texture has been allocated for this model.
  //
  // Allocation is eager whenever a batch table is present, because any of the
  // model's primitives could enter a pick pass at any time. Allocating on the
  // first pick pass instead would race the bind-group construction below, which
  // would then bind a placeholder texture that is wrong when pick fires. The
  // cost is bounded and idempotent across re-renders: one Uint8Array of W*H*4
  // bytes, matching the batch texture dimensions, plus featuresLength pickId
  // allocations.
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
  uniformData[10] = defined(featurePickTex) ? 1.0 : 0.0;
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

  // Feature ID resources live in the merged group-1 bind group at bindings
  // 26-32. The renderer splices the entries returned here into that group's
  // `entries[]` array; there is no standalone feature ID bind group.
  const fallbackTex = pipelineCache.defaultWhiteTexture;
  const fallbackSampler = pipelineCache.defaultSampler;
  // METADATA-TABLE-SOURCES — feature-ID textures carry INTEGER ids in their
  // channels and MUST be sampled NEAREST: upstream GltfLoader forces
  // `Sampler.NEAREST` for every EXT_mesh_features feature-ID texture, because
  // linear filtering interpolates neighbouring ids into fabricated values
  // (visible as kaleidoscope banding in the metadata debug paint, and wrong
  // feature resolution near region boundaries in the pick FS). The pipeline
  // cache's nearest/clamp property-texture sampler is the matching state.
  const featureIdNearestSampler =
    pipelineCache.propertyTextureSampler ?? fallbackSampler;
  const featureIdEntries = [
    {
      binding: 26,
      resource: (featureIdTex || fallbackTex).createView(),
    },
    { binding: 27, resource: featureIdNearestSampler },
    {
      binding: 28,
      resource: (batchGPUTex || fallbackTex).createView(),
    },
    { binding: 29, resource: fallbackSampler },
    { binding: 30, resource: { buffer: featureUniformBuffer } },
    // Feature-pick texture and sampler, allocated by `ensurePerFeaturePickIds`
    // when a batch table is present. Otherwise this is the placeholder white
    // texture, which the fragment shader never samples because it gates on
    // `featurePickEnabled`.
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
  primCache._featureIdGPUTextureOwned = featureIdTexOwned;
  primCache._batchGPUTexture = batchGPUTex;
  primCache._featureUniformBuffer = featureUniformBuffer;

  return {
    featureIdEntries,
    flags: flags,
  };
}

/**
 * Allocate per-feature pickIds for the model's batch table and upload an RGBA8
 * GPU texture mapping featureId to pickColor, the same shape as the batch
 * styling texture.
 *
 * Side effects:
 *  - On the per-primitive cache: stamps `_featurePickGPUTexture` with the
 *    allocated GPU texture, so subsequent `ensureFeatureIdResources()` calls
 *    bind it at binding 31 of the merged group-1 layout.
 *  - On the per-model cache: stamps `cache._featurePickIds`, a Map of
 *    `featureId` to `CesiumPickId`, so allocated pickIds survive across
 *    re-renders and pick-pass readback resolves through them.
 *  - Sets the `featurePickEnabled` slot of the feature uniform block to 1.0, so
 *    the pick fragment shader routes through `lookupFeaturePickColor`.
 *
 * Idempotent: subsequent calls reuse the cached texture and pickIds. The texture
 * re-uploads only when the batch table's featuresLength changes, which is
 * handled by destroying the cache slot and re-running.
 *
 * One pickId is allocated per feature, on the first pick pass that reaches a
 * model with a batch table. The pickId target is
 * `{primitive: model, id: featureId}`, so `scene.pick()` returns the featureId
 * of the picked feature alongside the model itself.
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
  // BatchTexture stores the feature count as `_featuresLength` and exposes no
  // public getter. Reading `batchTexture.featuresLength` yields undefined, which
  // early-returns before the per-feature pickIds are allocated and silently
  // disables per-feature picking on every batched 3D Tile.
  const featuresLength = batchTexture._featuresLength;
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

  // Build a complete replacement off-cache. Cesium pickIds are byte-exact
  // RGBA colors that round-trip through the pick FBO. Existing IDs remain
  // authoritative and reusable while any newly-created IDs and the candidate
  // texture are provisional until the upload succeeds.
  const previousPickIds = cache._featurePickIds;
  const previousTexture = cache._featurePickGPUTexture;
  const pickIds = new Map();
  const createdPickIds = [];
  // Register the same object `BatchTexture` registers under WebGL —
  // `context.createPickId(owner.getFeature(i), "tile-feature")` — so
  // `scene.pick` returns a real Cesium3DTileFeature for 3D Tiles, or a
  // ModelFeature for glTF EXT_mesh_features, rather than a bare
  // `{primitive, id}`. `_owner` is the Cesium3DTileContent or
  // ModelFeatureTable that owns this batch table, and both expose
  // `getFeature(batchId)`. An owner that does not falls back to the bare
  // descriptor, which keeps the primitive pickable rather than null.
  const owner = batchTexture._owner;
  const ownerHasGetFeature =
    defined(owner) && typeof owner.getFeature === "function";
  const data = new Uint8Array(dimensions.x * dimensions.y * 4);
  let tex;
  try {
    for (let fid = 0; fid < featuresLength; fid++) {
      let pid = previousPickIds?.get(fid);
      if (!defined(pid)) {
        const target = ownerHasGetFeature
          ? owner.getFeature(fid)
          : { primitive: model, id: fid };
        pid = context.createPickId(target, "tile-feature");
        createdPickIds.push(pid);
      }
      pickIds.set(fid, pid);
      const off = fid * 4;
      const c = pid.color;
      data[off] = Math.round((c.red ?? 0) * 255);
      data[off + 1] = Math.round((c.green ?? 0) * 255);
      data[off + 2] = Math.round((c.blue ?? 0) * 255);
      data[off + 3] = Math.round((c.alpha ?? 1) * 255);
    }

    tex = device.createTexture({
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
  } catch (error) {
    // Roll back only provisional owners. Cleanup errors from a lost device or
    // pick registry must not mask the allocation/upload failure.
    try {
      tex?.destroy();
    } catch {
      // Candidate was never published.
    }
    for (let i = 0; i < createdPickIds.length; i++) {
      try {
        createdPickIds[i].destroy();
      } catch {
        // Continue draining every provisional registry entry.
      }
    }
    throw error;
  }

  // Commit the complete replacement before cleaning up superseded owners.
  // From this point onward the cache always describes one coherent texture,
  // feature count, and pick-ID map.
  cache._featurePickIds = pickIds;
  cache._featurePickGPUTexture = tex;
  cache._featurePickFeaturesLength = featuresLength;
  primCache._featurePickGPUTexture = tex;

  const retiredPickIds = [];
  if (defined(previousPickIds)) {
    for (const [fid, pickId] of previousPickIds) {
      if (pickIds.get(fid) !== pickId) {
        retiredPickIds.push(pickId);
      }
    }
    previousPickIds.clear();
  }
  // Publication is the commit point. Best-effort old-owner cleanup cannot
  // invalidate the replacement, and one throwing destroy must not strand its
  // siblings.
  for (let i = 0; i < retiredPickIds.length; i++) {
    try {
      retiredPickIds[i].destroy();
    } catch {
      // The replacement map no longer references this retired registry entry.
    }
  }
  if (defined(previousTexture) && previousTexture !== tex) {
    try {
      previousTexture.destroy();
    } catch {
      // The uploaded replacement texture is already authoritative.
    }
  }
  return tex;
}

/**
 * Destroys feature ID GPU resources on a primitive cache.
 * @param {object} primCache
 */
function destroyFeatureIdResources(primCache) {
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

  const featureIdTexture = primCache._featureIdGPUTexture;
  const featureIdTextureOwned = primCache._featureIdGPUTextureOwned;
  const batchTexture = primCache._batchGPUTexture;
  const featureUniformBuffer = primCache._featureUniformBuffer;
  primCache._featureIdGPUTexture = undefined;
  primCache._featureIdGPUTextureOwned = undefined;
  primCache._batchGPUTexture = undefined;
  primCache._featureUniformBuffer = undefined;
  // `_featureIdEntries` is the resource entry array spliced into the merged
  // group-1 bind group; there is no standalone feature ID bind group to clear.
  primCache._featureIdEntries = undefined;
  primCache._featureIdFlags = undefined;
  // The per-feature pick texture is shared by every primitive in the model
  // and owned by the model cache. Drop only this primitive's alias here; the
  // model-level disposer releases the texture exactly once.
  primCache._featurePickGPUTexture = undefined;

  // METADATA-TABLE-SOURCES — only destroy textures allocated by
  // createFeatureIdGPUTexture; stub-owned reused textures are freed with the
  // glTF texture itself.
  if (featureIdTextureOwned !== false) {
    destroyBestEffort(featureIdTexture);
  }
  destroyBestEffort(batchTexture);
  destroyBestEffort(featureUniformBuffer);

  if (hasDestroyError) {
    throw firstDestroyError;
  }
}

/**
 * Destroys the model-wide per-feature pick registry entries and lookup
 * texture. These resources are separate from the primitive-level pick IDs
 * handled by WebGPUPickCommandHelpers and are shared by every primitive in a
 * batched model.
 *
 * @param {object} cache per-model WebGPU cache
 * @private
 */
function destroyPerFeaturePickResources(cache) {
  if (!defined(cache)) {
    return;
  }

  // Detach every public identity before invoking foreign/native destruction.
  // A throwing pick-id registry or GPUTexture.destroy implementation must not
  // leave a half-live cache that can be observed or destroyed a second time.
  const pickIdMap = cache._featurePickIds;
  const pickIds = defined(pickIdMap) ? Array.from(pickIdMap.values()) : [];
  const pickTexture = cache._featurePickGPUTexture;
  cache._featurePickIds = undefined;
  cache._featurePickGPUTexture = undefined;
  cache._featurePickFeaturesLength = undefined;
  pickIdMap?.clear();

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

  for (let i = 0; i < pickIds.length; i++) {
    destroyBestEffort(pickIds[i]);
  }
  destroyBestEffort(pickTexture);

  if (hasDestroyError) {
    throw firstDestroyError;
  }
}

export {
  createBatchGPUTexture,
  createFeatureIdGPUTexture,
  findSelectedFeatureId,
  getSelectedImplicitFeatureId,
  synthesizeImplicitFeatureIdData,
  ensurePerFeaturePickIds,
  ensureFeatureIdResources,
  destroyFeatureIdResources,
  destroyPerFeaturePickResources,
};
export default {
  findSelectedFeatureId,
  getSelectedImplicitFeatureId,
  synthesizeImplicitFeatureIdData,
  ensurePerFeaturePickIds,
  ensureFeatureIdResources,
  destroyFeatureIdResources,
  destroyPerFeaturePickResources,
};
