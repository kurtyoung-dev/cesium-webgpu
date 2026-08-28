/**
 * Packs instance transforms into a GPU storage buffer for WebGPU model
 * rendering via EXT_mesh_gpu_instancing or i3dm.
 *
 * Instance transforms and selected feature IDs are cached while their semantic
 * provenance is stable. Runtime identity or opt-in revision changes rebuild a
 * complete candidate transactionally and retire the replaced GPU buffer only
 * after its exact encoder segment and queue work settle.
 *
 * Storage buffer layout: array&lt;InstanceTransform&gt;.
 *   Each instance is 24 floats / 96 bytes:
 *     linear:          mat4x4<f32>  floats  0..15  (rotation+scale, col3 zeroed)
 *     translationHigh: vec4<f32>    floats 16..19  (.xyz used, .w pad)
 *     translationLow:  vec4<f32>    floats 20..23  (.xyz used, .w pad)
 *
 * Relative-to-eye precision: the per-instance translation places each instance
 * at its tile-relative ECEF offset, which at Earth scale (~6.4e6 m) exceeds
 * f32's ~2^23 mantissa and loses sub-metre precision. The translation is split
 * into high and low halves (EncodedCartesian3) so the vertex shader can
 * subtract the encoded camera before summing, instead of adding a raw f32
 * column — which produces i3dm jitter under a stationary camera. The linear
 * rotation-and-scale part stays single-precision; its magnitude is small enough
 * to carry no precision risk.
 *
 * The WebGL InstancingPipelineStage caches packed transforms as a 12-float
 * per-instance format (3 rows of vec4, column-major). Column 3 carries the
 * translation that is split here.
 *
 * @private
 * @module WebGPUModelInstancing
 */
import defined from "../../Core/defined.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import ModelComponents from "../../Scene/ModelComponents.js";
import InstanceAttributeSemantic from "../../Scene/InstanceAttributeSemantic.js";

// Per-instance storage stride. Must stay byte-consistent with the WGSL
// `InstanceTransform` struct in ModelPBRComplete.wgsl and with the
// default-buffer size in WebGPUModelPipelineCache.
const FLOATS_PER_INSTANCE = 24;
const INSTANCE_FEATURE_ID_NONE = 0;
const INSTANCE_FEATURE_ID_ATTRIBUTE = 1;
const INSTANCE_FEATURE_ID_IMPLICIT = 2;
const INSTANCING_RETRY = Symbol("instancingRetry");
const MAX_INSTANCING_CONVERGENCE_ATTEMPTS = 4;

const INSTANCING_PROVENANCE_KEYS = Object.freeze([
  "node",
  "instances",
  "instancesRevision",
  "instanceCount",
  "packedTransforms",
  "packedTransformsRevision",
  "packedTransformsLength",
  "translationAttribute",
  "translationAttributeRevision",
  "translationData",
  "translationDataRevision",
  "translationDataLength",
  "rotationAttribute",
  "rotationAttributeRevision",
  "rotationData",
  "rotationDataRevision",
  "rotationDataLength",
  "scaleAttribute",
  "scaleAttributeRevision",
  "scaleData",
  "scaleDataRevision",
  "scaleDataLength",
  "featureKind",
  "featureSource",
  "featureSourceRevision",
  "propertyTableId",
  "propertyTable",
  "propertyTableRevision",
  "propertyTableCount",
  "featureAttribute",
  "featureAttributeRevision",
  "featureBuffer",
  "featureData",
  "featureDataRevision",
  "featureDataLength",
  "implicitOffset",
  "implicitRepeat",
]);

const INSTANCING_REVISION_KEYS = Object.freeze([
  "_webgpuMetadataRevision",
  "_metadataRevision",
  "metadataRevision",
  "_webgpuGeometryRevision",
  "_geometryRevision",
  "geometryRevision",
  "_webgpuGeneration",
  "_generation",
  "generation",
]);

const hasOwnProperty = Object.prototype.hasOwnProperty;
const INSTANCING_ANCHOR_RESOLVED_PROPERTY = 0;
const INSTANCING_ANCHOR_OWN_DESCRIPTOR = 1;
const MAX_INSTANCING_PROTOTYPE_DEPTH = 64;
const FEATURE_ID_ATTRIBUTE_PROTOTYPE =
  ModelComponents.FeatureIdAttribute.prototype;
const FEATURE_ID_IMPLICIT_RANGE_PROTOTYPE =
  ModelComponents.FeatureIdImplicitRange.prototype;

const scratchEncodeX = { high: 0.0, low: 0.0 };
const scratchEncodeY = { high: 0.0, low: 0.0 };
const scratchEncodeZ = { high: 0.0, low: 0.0 };

/**
 * Begin one tracked semantic observation. The retained arrays grow only when a
 * new path shape is first seen; stable calls reuse their slots.
 *
 * @param {object} scratch
 * @private
 */
function beginTrackedInstancingObservation(scratch) {
  scratch.instancingAnchorSourceOwners ??= [];
  scratch.instancingAnchorSourceKeys ??= [];
  scratch.instancingAnchorDescriptorOwners ??= [];
  scratch.instancingAnchorDescriptorKinds ??= [];
  scratch.instancingAnchorSearchModes ??= [];
  scratch.instancingAnchorGetters ??= [];
  scratch.instancingAnchorSetters ??= [];
  scratch.instancingAnchorValues ??= [];
  scratch.instancingPrototypeAnchorOwners ??= [];
  scratch.instancingPrototypeAnchorValues ??= [];

  const previousAnchorCount = scratch.instancingAnchorCount ?? 0;
  for (let i = 0; i < previousAnchorCount; i++) {
    scratch.instancingAnchorSourceOwners[i] = undefined;
    scratch.instancingAnchorSourceKeys[i] = undefined;
    scratch.instancingAnchorDescriptorOwners[i] = undefined;
    scratch.instancingAnchorGetters[i] = undefined;
    scratch.instancingAnchorSetters[i] = undefined;
    scratch.instancingAnchorValues[i] = undefined;
  }

  const previousPrototypeAnchorCount =
    scratch.instancingPrototypeAnchorCount ?? 0;
  for (let i = 0; i < previousPrototypeAnchorCount; i++) {
    scratch.instancingPrototypeAnchorOwners[i] = undefined;
    scratch.instancingPrototypeAnchorValues[i] = undefined;
  }

  scratch.instancingAnchorCount = 0;
  scratch.instancingPrototypeAnchorCount = 0;
  scratch.instancingAnchorsValid = true;
}

function retainTrackedInstancingDescriptor(
  scratch,
  owner,
  key,
  descriptorOwner,
  descriptor,
  searchMode,
  observedValue,
  valueWasRead,
) {
  const index = scratch.instancingAnchorCount++;
  scratch.instancingAnchorSourceOwners[index] = owner;
  scratch.instancingAnchorSourceKeys[index] = key;
  scratch.instancingAnchorDescriptorOwners[index] = descriptorOwner;
  scratch.instancingAnchorSearchModes[index] = searchMode;

  if (!defined(descriptor)) {
    scratch.instancingAnchorDescriptorKinds[index] = 0;
    scratch.instancingAnchorGetters[index] = undefined;
    scratch.instancingAnchorSetters[index] = undefined;
    scratch.instancingAnchorValues[index] = undefined;
  } else if (hasOwnProperty.call(descriptor, "value")) {
    scratch.instancingAnchorDescriptorKinds[index] = 1;
    scratch.instancingAnchorGetters[index] = undefined;
    scratch.instancingAnchorSetters[index] = undefined;
    scratch.instancingAnchorValues[index] = descriptor.value;
    if (valueWasRead && !Object.is(observedValue, descriptor.value)) {
      scratch.instancingAnchorsValid = false;
    }
  } else {
    scratch.instancingAnchorDescriptorKinds[index] = 2;
    scratch.instancingAnchorGetters[index] = descriptor.get;
    scratch.instancingAnchorSetters[index] = descriptor.set;
    scratch.instancingAnchorValues[index] = undefined;
  }
}

/**
 * Read one semantic property and retain its exact descriptor shape for the
 * later non-invoking closure pass.
 *
 * Accessor-backed revision fields are intentionally allowed during the fill:
 * their returned values participate in the two complete records, while any
 * side effect on an earlier data-backed input is caught by the closure pass.
 *
 * @param {object} scratch
 * @param {object} owner
 * @param {string|number} key
 * @returns {*}
 * @private
 */
function readTrackedInstancingProperty(scratch, owner, key) {
  if (!defined(owner)) {
    return undefined;
  }

  const value = owner[key];
  let descriptorOwner = owner;
  let descriptor;
  while (defined(descriptorOwner)) {
    descriptor = Object.getOwnPropertyDescriptor(descriptorOwner, key);
    if (defined(descriptor)) {
      break;
    }
    descriptorOwner = Object.getPrototypeOf(descriptorOwner);
  }
  retainTrackedInstancingDescriptor(
    scratch,
    owner,
    key,
    descriptorOwner,
    descriptor,
    INSTANCING_ANCHOR_RESOLVED_PROPERTY,
    value,
    true,
  );
  return value;
}

/**
 * Retain an own-descriptor decision without evaluating the property. Alias
 * selection depends on absence as well as presence, so that decision must stay
 * closed through every later getter in the observation.
 *
 * @param {object} scratch
 * @param {object} owner
 * @param {string} key
 * @returns {boolean}
 * @private
 */
function hasTrackedOwnInstancingProperty(scratch, owner, key) {
  if (!defined(owner)) {
    return false;
  }
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  retainTrackedInstancingDescriptor(
    scratch,
    owner,
    key,
    defined(descriptor) ? owner : undefined,
    descriptor,
    INSTANCING_ANCHOR_OWN_DESCRIPTOR,
    undefined,
    false,
  );
  return defined(descriptor);
}

/**
 * Prefer the data-backed field used by Cesium's public getter, while retaining
 * direct own data properties used by lightweight callers and focused harnesses.
 *
 * @param {object} scratch
 * @param {object} owner
 * @param {string} publicKey
 * @param {string} backingKey
 * @returns {*}
 * @private
 */
function readTrackedInstancingAlias(scratch, owner, publicKey, backingKey) {
  if (!defined(owner)) {
    return undefined;
  }
  const key = hasTrackedOwnInstancingProperty(scratch, owner, backingKey)
    ? backingKey
    : publicKey;
  return readTrackedInstancingProperty(scratch, owner, key);
}

function readTrackedInstancingPrototype(scratch, owner) {
  const prototype = Object.getPrototypeOf(owner);
  const index = scratch.instancingPrototypeAnchorCount++;
  scratch.instancingPrototypeAnchorOwners[index] = owner;
  scratch.instancingPrototypeAnchorValues[index] = prototype;
  return prototype;
}

function trackedInstancingPrototypeChainIncludes(
  scratch,
  value,
  expectedPrototype,
) {
  let owner = value;
  for (
    let depth = 0;
    defined(owner) && depth < MAX_INSTANCING_PROTOTYPE_DEPTH;
    depth++
  ) {
    const prototype = readTrackedInstancingPrototype(scratch, owner);
    if (prototype === expectedPrototype) {
      return true;
    }
    owner = prototype;
  }
  if (defined(owner)) {
    scratch.instancingAnchorsValid = false;
  }
  return false;
}

/**
 * Close an observation without invoking any live getter. Each retained
 * data-property anchor must still hold the value captured during its fill.
 *
 * @param {object} scratch
 * @returns {boolean}
 * @private
 */
function trackedInstancingObservationClosed(scratch) {
  if (scratch.instancingAnchorsValid !== true) {
    return false;
  }
  const count = scratch.instancingAnchorCount;
  const sourceOwners = scratch.instancingAnchorSourceOwners;
  const sourceKeys = scratch.instancingAnchorSourceKeys;
  const descriptorOwners = scratch.instancingAnchorDescriptorOwners;
  const descriptorKinds = scratch.instancingAnchorDescriptorKinds;
  const searchModes = scratch.instancingAnchorSearchModes;
  const getters = scratch.instancingAnchorGetters;
  const setters = scratch.instancingAnchorSetters;
  const values = scratch.instancingAnchorValues;
  for (let i = 0; i < count; i++) {
    let descriptorOwner = sourceOwners[i];
    let descriptor = Object.getOwnPropertyDescriptor(
      descriptorOwner,
      sourceKeys[i],
    );
    if (searchModes[i] === INSTANCING_ANCHOR_RESOLVED_PROPERTY) {
      while (!defined(descriptor) && defined(descriptorOwner)) {
        descriptorOwner = Object.getPrototypeOf(descriptorOwner);
        if (defined(descriptorOwner)) {
          descriptor = Object.getOwnPropertyDescriptor(
            descriptorOwner,
            sourceKeys[i],
          );
        }
      }
    } else if (!defined(descriptor)) {
      descriptorOwner = undefined;
    }
    if (descriptorOwner !== descriptorOwners[i]) {
      return false;
    }
    const kind = !defined(descriptor)
      ? 0
      : hasOwnProperty.call(descriptor, "value")
        ? 1
        : 2;
    if (kind !== descriptorKinds[i]) {
      return false;
    }
    if (
      (kind === 1 && !Object.is(descriptor.value, values[i])) ||
      (kind === 2 &&
        (descriptor.get !== getters[i] || descriptor.set !== setters[i]))
    ) {
      return false;
    }
  }
  const prototypeCount = scratch.instancingPrototypeAnchorCount;
  const prototypeOwners = scratch.instancingPrototypeAnchorOwners;
  const prototypeValues = scratch.instancingPrototypeAnchorValues;
  for (let i = 0; i < prototypeCount; i++) {
    if (Object.getPrototypeOf(prototypeOwners[i]) !== prototypeValues[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Writes the linear (rotation+scale) 3x3 into the `linear` mat4x4 slot
 * (col3 zeroed) and the high/low split of the translation into the trailing
 * two vec4 slots.
 *
 * @param {Float32Array} out - destination, FLOATS_PER_INSTANCE-strided
 * @param {number} dst - base float offset for this instance
 * @param {number} c0x @param {number} c0y @param {number} c0z - column 0
 * @param {number} c1x @param {number} c1y @param {number} c1z - column 1
 * @param {number} c2x @param {number} c2y @param {number} c2z - column 2
 * @param {number} tx @param {number} ty @param {number} tz - translation
 * @param {number} [featureId=0] - The per-instance feature ID,
 *   transported in the otherwise-pad `translationHigh.w` slot (float 19) so
 *   the vertex shader can forward it to the flat `featureId0` varying that
 *   keys an instance-sourced property table. `0` (the default) is
 *   byte-identical to the pre-existing pad.
 * @private
 */
function writeInstance(
  out,
  dst,
  c0x,
  c0y,
  c0z,
  c1x,
  c1y,
  c1z,
  c2x,
  c2y,
  c2z,
  tx,
  ty,
  tz,
  featureId,
) {
  // linear mat4x4 (column-major); translation column zeroed — RTE handles it
  out[dst + 0] = c0x;
  out[dst + 1] = c0y;
  out[dst + 2] = c0z;
  out[dst + 3] = 0.0;
  out[dst + 4] = c1x;
  out[dst + 5] = c1y;
  out[dst + 6] = c1z;
  out[dst + 7] = 0.0;
  out[dst + 8] = c2x;
  out[dst + 9] = c2y;
  out[dst + 10] = c2z;
  out[dst + 11] = 0.0;
  out[dst + 12] = 0.0;
  out[dst + 13] = 0.0;
  out[dst + 14] = 0.0;
  out[dst + 15] = 1.0;

  // translationHigh.xyz (+ pad), translationLow.xyz (+ pad)
  EncodedCartesian3.encode(tx, scratchEncodeX);
  EncodedCartesian3.encode(ty, scratchEncodeY);
  EncodedCartesian3.encode(tz, scratchEncodeZ);
  out[dst + 16] = scratchEncodeX.high;
  out[dst + 17] = scratchEncodeY.high;
  out[dst + 18] = scratchEncodeZ.high;
  // Store the per-instance feature ID in the translationHigh.w pad. The
  // vertex shader reads translationHigh.xyz only for relative-to-eye
  // translation, so .w is free; using it avoids a new storage binding and
  // bind-group-layout variant. The default 0 keeps the record byte-identical
  // for instanced models without instance feature IDs.
  out[dst + 19] = defined(featureId) ? featureId : 0.0;
  out[dst + 20] = scratchEncodeX.low;
  out[dst + 21] = scratchEncodeY.low;
  out[dst + 22] = scratchEncodeZ.low;
  out[dst + 23] = 0.0;
}

/**
 * Creates or retrieves cached instancing GPU resources for a runtime node.
 *
 * Reads from runtimeNode.transformsTypedArray (set by InstancingPipelineStage
 * when keepTypedArray is true, which includes WebGPU contexts).
 *
 * @param {GPUDevice} device
 * @param {object} nodeCache - Per-node cache from WebGPUModelRenderer
 * @param {object} runtimeNode - The ModelRuntimeNode
 * @param {Model} [model] - The owning model, used to resolve the selected
 *   instance feature ID set. Optional so callers without instance metadata
 *   keep the same packed representation.
 * @param {object} [context] - The active WebGPU context. Its exact command
 *   encoder settlement hook owns submit-safe replacement retirement.
 * @returns {object|null} { storageBuffer, instanceCount } or null
 */
function ensureInstancingResources(
  device,
  nodeCache,
  runtimeNode,
  model,
  context,
) {
  const callerDepth = nodeCache.instancingConvergenceDepth ?? 0;
  if (callerDepth === 0) {
    nodeCache.instancingConvergenceRemaining =
      MAX_INSTANCING_CONVERGENCE_ATTEMPTS;
  }
  nodeCache.instancingConvergenceDepth = callerDepth + 1;

  try {
    while ((nodeCache.instancingConvergenceRemaining ?? 0) > 0) {
      nodeCache.instancingConvergenceRemaining--;
      const result = ensureInstancingResourcesAttempt(
        device,
        nodeCache,
        runtimeNode,
        model,
        context,
      );
      if (result !== INSTANCING_RETRY) {
        return result;
      }
    }

    // Persistent mutation is not a stable generation. Fail closed for this
    // frame without retaining call-stack depth; a later frame may retry.
    return null;
  } finally {
    if (callerDepth === 0) {
      nodeCache.instancingConvergenceDepth = undefined;
      nodeCache.instancingConvergenceRemaining = undefined;
    } else {
      nodeCache.instancingConvergenceDepth = callerDepth;
    }
  }
}

/**
 * Performs one transactional observation/publication attempt.
 *
 * @returns {object|null|symbol}
 * @private
 */
function ensureInstancingResourcesAttempt(
  device,
  nodeCache,
  runtimeNode,
  model,
  context,
) {
  // A node cache is a single ownership lifecycle. Final teardown leaves a
  // terminal tombstone so native destroy wrappers and in-flight candidates
  // cannot resurrect resources into a cache the renderer is about to discard.
  if (nodeCache.instancingResourcesDestroyed === true) {
    return null;
  }

  const liveProvenance = populateInstancingProvenance(
    nodeCache,
    model,
    runtimeNode,
  );
  if (nodeCache.instancingResourcesDestroyed === true) {
    return null;
  }
  if (!defined(liveProvenance)) {
    return INSTANCING_RETRY;
  }
  const count = liveProvenance.instanceCount ?? 0;
  if (!defined(liveProvenance.instances) || count <= 0) {
    return null;
  }
  const currentBuffer = nodeCache.instancingBuffer;
  const currentProvenance = nodeCache.instancingProvenance;
  const publicationEpoch = nodeCache.instancingPublicationEpoch ?? 0;
  if (
    defined(currentBuffer) &&
    instancingProvenanceMatches(currentProvenance, liveProvenance)
  ) {
    const crossedRetirementBoundary = scheduleRetiredInstancingBuffers(
      device,
      nodeCache,
      context,
    );
    if (
      !crossedRetirementBoundary ||
      instancingGenerationMatchesLive(
        nodeCache,
        model,
        runtimeNode,
        currentBuffer,
        currentProvenance,
        publicationEpoch,
      )
    ) {
      return nodeCache.instancingResourcesDestroyed === true
        ? null
        : nodeCache.instancingResources;
    }
    if (nodeCache.instancingResourcesDestroyed === true) {
      return null;
    }
    return INSTANCING_RETRY;
  }

  // Capture the miss before invoking device methods. A test device or wrapper
  // may be re-entrant; the node-local scratch object remains free for that
  // nested resolution without changing the candidate's publication tuple.
  const candidateProvenance = captureInstancingProvenance(liveProvenance);
  const instanceFeatureIds = createInstanceFeatureIds(
    candidateProvenance,
    count,
  );
  if (
    !instancingCardinalityAllows(candidateProvenance, count, instanceFeatureIds)
  ) {
    return null;
  }

  // Try the packed typed array cached by InstancingPipelineStage
  const packedData = candidateProvenance.packedTransforms;
  let instanceData;

  if (defined(packedData)) {
    instanceData = expandPackedTransforms(
      packedData,
      count,
      instanceFeatureIds,
    );
  } else {
    // Fallback: try to read from attribute typed arrays directly
    instanceData = extractTransformsFromProvenance(
      candidateProvenance,
      count,
      instanceFeatureIds,
    );
  }

  if (!defined(instanceData)) {
    return null;
  }
  if (nodeCache.instancingResourcesDestroyed === true) {
    return null;
  }

  // Create GPU storage buffer (FLOATS_PER_INSTANCE-strided InstanceTransform)
  const bufferSize = instanceData.byteLength;
  let storageBuffer;
  try {
    storageBuffer = device.createBuffer({
      label: `Instance transforms (${count} instances)`,
      size: bufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(storageBuffer, 0, instanceData);
  } catch (error) {
    try {
      storageBuffer?.destroy();
    } catch {
      // Preserve the allocation/upload error. This candidate was never visible.
    }
    throw error;
  }

  // Device wrappers may re-enter this ensure path while the candidate is
  // being allocated or uploaded. Publish only if both the observed cache
  // generation and the live semantic inputs are still current; otherwise the
  // nested/newer call wins and this candidate never becomes externally
  // reachable.
  if (nodeCache.instancingResourcesDestroyed === true) {
    try {
      storageBuffer.destroy();
    } catch {
      // Final teardown owns the lifecycle; this candidate was never visible.
    }
    return null;
  }

  // Re-resolve the complete runtime tuple after the foreign device calls.
  // Candidate materialization above consumed only captured provenance; this is
  // the first live read after acceptance and therefore the CAS boundary.
  let latestProvenance;
  try {
    latestProvenance = populateInstancingProvenance(
      nodeCache,
      model,
      runtimeNode,
    );
  } catch (error) {
    try {
      storageBuffer.destroy();
    } catch {
      // Preserve the live-provenance error; the candidate was never visible.
    }
    throw error;
  }
  if (
    nodeCache.instancingResourcesDestroyed === true ||
    (nodeCache.instancingPublicationEpoch ?? 0) !== publicationEpoch ||
    nodeCache.instancingBuffer !== currentBuffer ||
    nodeCache.instancingProvenance !== currentProvenance ||
    !defined(latestProvenance) ||
    !instancingProvenanceMatches(candidateProvenance, latestProvenance)
  ) {
    try {
      storageBuffer.destroy();
    } catch {
      // The unpublished candidate is unreachable; preserve the newer owner.
    }
    if (nodeCache.instancingResourcesDestroyed === true) {
      return null;
    }
    return INSTANCING_RETRY;
  }

  nodeCache.instancingBuffer = storageBuffer;
  nodeCache.instanceCount = count;
  nodeCache.instancingProvenance = candidateProvenance;
  nodeCache.instancingResources = {
    storageBuffer,
    instanceCount: count,
  };
  nodeCache.instancingPublicationEpoch = publicationEpoch + 1;
  if (defined(currentBuffer)) {
    nodeCache.retiredInstancingBuffers ??= new Set();
    nodeCache.retiredInstancingBuffers.add(currentBuffer);
  }
  const crossedRetirementBoundary = scheduleRetiredInstancingBuffers(
    device,
    nodeCache,
    context,
  );
  if (
    !crossedRetirementBoundary ||
    instancingGenerationMatchesLive(
      nodeCache,
      model,
      runtimeNode,
      storageBuffer,
      candidateProvenance,
      publicationEpoch + 1,
    )
  ) {
    return nodeCache.instancingResourcesDestroyed === true
      ? null
      : nodeCache.instancingResources;
  }
  if (nodeCache.instancingResourcesDestroyed === true) {
    return null;
  }
  return INSTANCING_RETRY;
}

function actualArrayCardinalityAllows(array, requiredLength) {
  return (
    defined(array) &&
    Number.isInteger(array.length) &&
    array.length >= requiredLength
  );
}

function optionalActualArrayCardinalityAllows(array, requiredLength) {
  return !defined(array) || actualArrayCardinalityAllows(array, requiredLength);
}

function capturedArrayCardinalityAllows(array, capturedLength, requiredLength) {
  return (
    actualArrayCardinalityAllows(array, requiredLength) &&
    Number.isInteger(capturedLength) &&
    capturedLength >= requiredLength
  );
}

function optionalCapturedArrayCardinalityAllows(
  array,
  capturedLength,
  requiredLength,
) {
  return (
    !defined(array) ||
    capturedArrayCardinalityAllows(array, capturedLength, requiredLength)
  );
}

/**
 * Checks that the accepted arrays can materialize every advertised instance.
 * Captured lengths are the provenance witness; direct checks on those exact
 * arrays keep the materializers safe from inconsistent array-like inputs.
 *
 * @param {object} provenance
 * @param {number} count
 * @param {Float32Array|null|undefined} featureIds
 * @returns {boolean}
 * @private
 */
function instancingCardinalityAllows(provenance, count, featureIds) {
  if (!Number.isInteger(count) || count <= 0) {
    return false;
  }

  const packedTransforms = provenance.packedTransforms;
  if (defined(packedTransforms)) {
    if (
      !capturedArrayCardinalityAllows(
        packedTransforms,
        provenance.packedTransformsLength,
        count * 12,
      )
    ) {
      return false;
    }
  } else if (
    !optionalCapturedArrayCardinalityAllows(
      provenance.translationData,
      provenance.translationDataLength,
      count * 3,
    ) ||
    !optionalCapturedArrayCardinalityAllows(
      provenance.rotationData,
      provenance.rotationDataLength,
      count * 4,
    ) ||
    !optionalCapturedArrayCardinalityAllows(
      provenance.scaleData,
      provenance.scaleDataLength,
      count * 3,
    )
  ) {
    return false;
  }

  if (
    provenance.featureKind === INSTANCE_FEATURE_ID_ATTRIBUTE &&
    ((!defined(provenance.featureData) && !defined(provenance.featureBuffer)) ||
      !optionalCapturedArrayCardinalityAllows(
        provenance.featureData,
        provenance.featureDataLength,
        count,
      ))
  ) {
    return false;
  }

  if (provenance.featureKind === INSTANCE_FEATURE_ID_NONE) {
    return !defined(featureIds);
  }
  if (
    provenance.featureKind !== INSTANCE_FEATURE_ID_ATTRIBUTE &&
    provenance.featureKind !== INSTANCE_FEATURE_ID_IMPLICIT
  ) {
    return false;
  }
  if (
    provenance.featureKind === INSTANCE_FEATURE_ID_ATTRIBUTE &&
    !defined(featureIds)
  ) {
    return (
      !defined(provenance.featureData) && defined(provenance.featureBuffer)
    );
  }
  return (
    defined(featureIds) &&
    Number.isInteger(featureIds.length) &&
    featureIds.length >= count
  );
}

/**
 * Expands the 12-float packed transform format (from InstancingPipelineStage)
 * into the 24-float `InstanceTransform` storage layout.
 *
 * Input format (per instance, 12 floats — transposed 3x4):
 *   [col0.x, col1.x, col2.x, col3.x,  // row 0
 *    col0.y, col1.y, col2.y, col3.y,  // row 1
 *    col0.z, col1.z, col2.z, col3.z]  // row 2
 *
 * Output: see writeInstance — linear mat4x4 (col3 zeroed) + split translation.
 *
 * @param {Float32Array} packed - 12 floats per instance, transposed row format
 * @param {number} count - Number of instances
 * @param {Float32Array|null} [featureIds] - Per-instance feature IDs to
 *   transport in the pad slot, or null.
 * @returns {Float32Array|null} FLOATS_PER_INSTANCE floats per instance, or null
 * @private
 */
function expandPackedTransforms(packed, count, featureIds) {
  const cardinalityAllows =
    actualArrayCardinalityAllows(packed, count * 12) &&
    optionalActualArrayCardinalityAllows(featureIds, count);
  if (!cardinalityAllows) {
    return null;
  }

  const data = new Float32Array(count * FLOATS_PER_INSTANCE);
  for (let i = 0; i < count; i++) {
    const src = i * 12;
    const dst = i * FLOATS_PER_INSTANCE;

    // Row 0: [col0.x, col1.x, col2.x, col3.x]
    // Row 1: [col0.y, col1.y, col2.y, col3.y]
    // Row 2: [col0.z, col1.z, col2.z, col3.z]
    // col3 = translation (tx, ty, tz)
    writeInstance(
      data,
      dst,
      packed[src + 0], // col0.x
      packed[src + 4], // col0.y
      packed[src + 8], // col0.z
      packed[src + 1], // col1.x
      packed[src + 5], // col1.y
      packed[src + 9], // col1.z
      packed[src + 2], // col2.x
      packed[src + 6], // col2.y
      packed[src + 10], // col2.z
      packed[src + 3], // tx (col3.x)
      packed[src + 7], // ty (col3.y)
      packed[src + 11], // tz (col3.z)
      defined(featureIds) ? featureIds[i] : 0.0,
    );
  }
  return data;
}

/**
 * Fallback: expand the translation/rotation/scale arrays captured by the
 * accepted provenance record. No live instance or attribute traversal is
 * allowed here: a getter between acceptance and upload could otherwise mix
 * bytes from one generation with another generation's provenance.
 *
 * @param {object} provenance - accepted instancing provenance
 * @param {number} count
 * @param {Float32Array|null} [featureIds] - Per-instance feature IDs to
 *   transport in the pad slot, or null.
 * @returns {Float32Array|null} FLOATS_PER_INSTANCE floats per instance, or null
 * @private
 */
function extractTransformsFromProvenance(provenance, count, featureIds) {
  const translationData = provenance.translationData;
  const rotationData = provenance.rotationData;
  const scaleData = provenance.scaleData;

  const cardinalityAllows =
    optionalActualArrayCardinalityAllows(translationData, count * 3) &&
    optionalActualArrayCardinalityAllows(rotationData, count * 4) &&
    optionalActualArrayCardinalityAllows(scaleData, count * 3) &&
    optionalActualArrayCardinalityAllows(featureIds, count);
  if (!cardinalityAllows) {
    return null;
  }

  // Need at least translation (or all zero = identity position)
  if (
    !defined(translationData) &&
    !defined(rotationData) &&
    !defined(scaleData)
  ) {
    return null;
  }

  const data = new Float32Array(count * FLOATS_PER_INSTANCE);

  for (let i = 0; i < count; i++) {
    const dst = i * FLOATS_PER_INSTANCE;
    const tx = defined(translationData) ? translationData[i * 3] : 0;
    const ty = defined(translationData) ? translationData[i * 3 + 1] : 0;
    const tz = defined(translationData) ? translationData[i * 3 + 2] : 0;
    const sx = defined(scaleData) ? scaleData[i * 3] : 1;
    const sy = defined(scaleData) ? scaleData[i * 3 + 1] : 1;
    const sz = defined(scaleData) ? scaleData[i * 3 + 2] : 1;

    // Linear (rotation+scale) part as three columns; the translation is split
    // separately inside writeInstance.
    let c0x, c0y, c0z, c1x, c1y, c1z, c2x, c2y, c2z;
    if (defined(rotationData)) {
      // Build rotation*scale columns from quaternion (column-major)
      const qx = rotationData[i * 4];
      const qy = rotationData[i * 4 + 1];
      const qz = rotationData[i * 4 + 2];
      const qw = rotationData[i * 4 + 3];

      const x2 = qx + qx,
        y2 = qy + qy,
        z2 = qz + qz;
      const xx = qx * x2,
        xy = qx * y2,
        xz = qx * z2;
      const yy = qy * y2,
        yz = qy * z2,
        zz = qz * z2;
      const wx = qw * x2,
        wy = qw * y2,
        wz = qw * z2;

      c0x = (1 - (yy + zz)) * sx;
      c0y = (xy + wz) * sx;
      c0z = (xz - wy) * sx;
      c1x = (xy - wz) * sy;
      c1y = (1 - (xx + zz)) * sy;
      c1z = (yz + wx) * sy;
      c2x = (xz + wy) * sz;
      c2y = (yz - wx) * sz;
      c2z = (1 - (xx + yy)) * sz;
    } else {
      // Scale-only (no rotation)
      c0x = sx;
      c0y = 0;
      c0z = 0;
      c1x = 0;
      c1y = sy;
      c1z = 0;
      c2x = 0;
      c2y = 0;
      c2z = sz;
    }

    writeInstance(
      data,
      dst,
      c0x,
      c0y,
      c0z,
      c1x,
      c1y,
      c1z,
      c2x,
      c2y,
      c2z,
      tx,
      ty,
      tz,
      defined(featureIds) ? featureIds[i] : 0.0,
    );
  }

  return data;
}

/**
 * Returns a mutation revision when a loader/runtime source exposes one.
 * Identity remains the primary key; this opt-in revision catches in-place
 * mutations without scanning potentially large typed arrays every frame.
 *
 * @param {*} value
 * @param {object} scratch
 * @returns {*}
 * @private
 */
function getInstancingRevision(value, scratch) {
  if (!defined(value)) {
    return undefined;
  }
  for (let i = 0; i < INSTANCING_REVISION_KEYS.length; i++) {
    const revision = readTrackedInstancingProperty(
      scratch,
      value,
      INSTANCING_REVISION_KEYS[i],
    );
    if (defined(revision)) {
      return revision;
    }
  }
  return undefined;
}

/**
 * Resolve the runtime node through Cesium's data-backed `_node` field when
 * present, or through a caller-owned `node` data property in focused/simple
 * integrations.
 *
 * @param {object} scratch
 * @param {object} runtimeNode
 * @returns {object|undefined}
 * @private
 */
function readTrackedRuntimeNode(scratch, runtimeNode) {
  return readTrackedInstancingAlias(scratch, runtimeNode, "node", "_node");
}

/**
 * Read the selected instance-feature label without invoking Model's public
 * accessor when its canonical backing field is available.
 *
 * @param {object} scratch
 * @param {Model} model
 * @returns {*}
 * @private
 */
function readTrackedInstanceFeatureIdLabel(scratch, model) {
  return readTrackedInstancingAlias(
    scratch,
    model,
    "instanceFeatureIdLabel",
    "_instanceFeatureIdLabel",
  );
}

/**
 * Resolve structural metadata through Model's data-backed scene-graph chain.
 * Lightweight callers may instead expose a direct own `structuralMetadata`.
 *
 * @param {object} scratch
 * @param {Model} model
 * @returns {object|undefined}
 * @private
 */
function readTrackedStructuralMetadata(scratch, model) {
  if (!defined(model)) {
    return undefined;
  }
  if (hasTrackedOwnInstancingProperty(scratch, model, "structuralMetadata")) {
    return readTrackedInstancingProperty(scratch, model, "structuralMetadata");
  }
  if (hasTrackedOwnInstancingProperty(scratch, model, "_sceneGraph")) {
    const sceneGraph = readTrackedInstancingProperty(
      scratch,
      model,
      "_sceneGraph",
    );
    const components = readTrackedInstancingAlias(
      scratch,
      sceneGraph,
      "components",
      "_components",
    );
    return readTrackedInstancingProperty(
      scratch,
      components,
      "structuralMetadata",
    );
  }
  return readTrackedInstancingProperty(scratch, model, "structuralMetadata");
}

/**
 * Tracked equivalent of ModelUtility.getFeatureIdsByLabel. Keeping selection in
 * this one resolver lets the closure anchor every visited array entry and label
 * without a second raw semantic implementation.
 *
 * @param {object} scratch
 * @param {object[]} featureIds
 * @param {*} label
 * @returns {object|undefined}
 * @private
 */
function findTrackedInstanceFeatureIdByLabel(scratch, featureIds, label) {
  const length =
    readTrackedInstancingProperty(scratch, featureIds, "length") ?? 0;
  for (let i = 0; i < length; i++) {
    const featureId = readTrackedInstancingProperty(scratch, featureIds, i);
    if (
      readTrackedInstancingProperty(scratch, featureId, "positionalLabel") ===
        label ||
      readTrackedInstancingProperty(scratch, featureId, "label") === label
    ) {
      return featureId;
    }
  }
  return undefined;
}

/**
 * Resolves the structural property table consumed by the selected instance
 * source. This mirrors the metadata resolver's per-node law; the model-wide
 * styling table may legitimately describe a different node.
 *
 * @param {object} scratch
 * @param {Model} model
 * @param {number|string} propertyTableId
 * @returns {object|undefined}
 * @private
 */
function findInstancePropertyTable(scratch, model, propertyTableId) {
  const structuralMetadata = readTrackedStructuralMetadata(scratch, model);
  const propertyTables = readTrackedInstancingAlias(
    scratch,
    structuralMetadata,
    "propertyTables",
    "_propertyTables",
  );
  if (!defined(propertyTables)) {
    return undefined;
  }
  const length =
    readTrackedInstancingProperty(scratch, propertyTables, "length") ?? 0;
  if (
    Number.isInteger(propertyTableId) &&
    propertyTableId >= 0 &&
    propertyTableId < length
  ) {
    const indexedTable = readTrackedInstancingProperty(
      scratch,
      propertyTables,
      propertyTableId,
    );
    return (readTrackedInstancingAlias(
      scratch,
      indexedTable,
      "count",
      "_count",
    ) ?? 0) > 0
      ? indexedTable
      : undefined;
  }
  for (let i = 0; i < length; i++) {
    const propertyTable = readTrackedInstancingProperty(
      scratch,
      propertyTables,
      i,
    );
    if (
      defined(propertyTable) &&
      (readTrackedInstancingAlias(scratch, propertyTable, "count", "_count") ??
        0) > 0 &&
      String(
        readTrackedInstancingAlias(scratch, propertyTable, "id", "_id"),
      ) === String(propertyTableId)
    ) {
      return propertyTable;
    }
  }
  return undefined;
}

/**
 * Populates one node-owned scratch record with every semantic input baked into
 * the combined transform/feature-ID buffer. Retained scratch containers are
 * reused after warmup; descriptor inspection cost remains measurement-owned.
 *
 * @param {object} nodeCache
 * @param {Model} model
 * @param {object} runtimeNode
 * @returns {object|undefined} A stable snapshot, or undefined when a
 *   synchronous mutation made the observation internally inconsistent.
 * @private
 */
function populateInstancingProvenance(nodeCache, model, runtimeNode) {
  const depth = nodeCache.instancingProvenanceScratchDepth ?? 0;
  const pool =
    nodeCache.instancingProvenanceScratchPool ??
    (nodeCache.instancingProvenanceScratchPool = []);
  const firstScratch = pool[depth] ?? (pool[depth] = {});
  nodeCache.instancingProvenanceScratchDepth = depth + 1;
  try {
    const first = populateInstancingProvenanceRecord(
      firstScratch,
      model,
      runtimeNode,
    );
    if (nodeCache.instancingResourcesDestroyed === true) {
      return undefined;
    }

    // A separately retained complete observation closes its own tracked data
    // anchors before equality. The comparison below therefore performs no live
    // getter, selector, or source traversal.
    const secondDepth = depth + 1;
    const secondScratch = pool[secondDepth] ?? (pool[secondDepth] = {});
    nodeCache.instancingProvenanceScratchDepth = secondDepth + 1;
    const second = populateInstancingProvenanceRecord(
      secondScratch,
      model,
      runtimeNode,
    );
    return nodeCache.instancingResourcesDestroyed !== true &&
      trackedInstancingObservationClosed(first) &&
      trackedInstancingObservationClosed(second) &&
      instancingProvenanceMatches(first, second)
      ? first
      : undefined;
  } finally {
    nodeCache.instancingProvenanceScratchDepth =
      nodeCache.instancingResourcesDestroyed === true ? undefined : depth;
  }
}

/**
 * Fills one depth-isolated provenance record. The wrapper above owns scratch
 * acquisition/release so revision getters may synchronously re-enter ensure
 * without overwriting an outer call's still-live comparison tuple.
 *
 * @param {object} scratch
 * @param {Model} model
 * @param {object} runtimeNode
 * @returns {object}
 * @private
 */
function populateInstancingProvenanceRecord(scratch, model, runtimeNode) {
  beginTrackedInstancingObservation(scratch);
  for (let i = 0; i < INSTANCING_PROVENANCE_KEYS.length; i++) {
    scratch[INSTANCING_PROVENANCE_KEYS[i]] = undefined;
  }
  scratch.featureKind = INSTANCE_FEATURE_ID_NONE;
  scratch.instanceCount = 0;

  const node = readTrackedRuntimeNode(scratch, runtimeNode);
  const instances = readTrackedInstancingProperty(scratch, node, "instances");
  const attributes = readTrackedInstancingProperty(
    scratch,
    instances,
    "attributes",
  );
  const firstAttribute = readTrackedInstancingProperty(scratch, attributes, 0);
  const count =
    readTrackedInstancingProperty(scratch, firstAttribute, "count") ?? 0;
  scratch.node = node;
  scratch.instances = instances;
  scratch.instanceCount = count;
  if (!defined(instances) || count <= 0) {
    return scratch;
  }

  const packedTransforms = readTrackedInstancingProperty(
    scratch,
    runtimeNode,
    "transformsTypedArray",
  );
  let translationAttribute;
  let rotationAttribute;
  let scaleAttribute;
  if (!defined(packedTransforms)) {
    const attributeCount =
      readTrackedInstancingProperty(scratch, attributes, "length") ?? 0;
    for (let i = 0; i < attributeCount; i++) {
      const attribute = readTrackedInstancingProperty(scratch, attributes, i);
      const semantic = readTrackedInstancingProperty(
        scratch,
        attribute,
        "semantic",
      );
      if (semantic === "TRANSLATION") {
        translationAttribute = attribute;
      } else if (semantic === "ROTATION") {
        rotationAttribute = attribute;
      } else if (semantic === "SCALE") {
        scaleAttribute = attribute;
      }
    }
  }

  const translationData = readTrackedInstancingProperty(
    scratch,
    translationAttribute,
    "typedArray",
  );
  const rotationData = readTrackedInstancingProperty(
    scratch,
    rotationAttribute,
    "typedArray",
  );
  const scaleData = readTrackedInstancingProperty(
    scratch,
    scaleAttribute,
    "typedArray",
  );
  scratch.instancesRevision = getInstancingRevision(instances, scratch);
  scratch.packedTransforms = packedTransforms;
  scratch.packedTransformsRevision = getInstancingRevision(
    packedTransforms,
    scratch,
  );
  scratch.packedTransformsLength = readTrackedInstancingProperty(
    scratch,
    packedTransforms,
    "length",
  );
  scratch.translationAttribute = translationAttribute;
  scratch.translationAttributeRevision = getInstancingRevision(
    translationAttribute,
    scratch,
  );
  scratch.translationData = translationData;
  scratch.translationDataRevision = getInstancingRevision(
    translationData,
    scratch,
  );
  scratch.translationDataLength = readTrackedInstancingProperty(
    scratch,
    translationData,
    "length",
  );
  scratch.rotationAttribute = rotationAttribute;
  scratch.rotationAttributeRevision = getInstancingRevision(
    rotationAttribute,
    scratch,
  );
  scratch.rotationData = rotationData;
  scratch.rotationDataRevision = getInstancingRevision(rotationData, scratch);
  scratch.rotationDataLength = readTrackedInstancingProperty(
    scratch,
    rotationData,
    "length",
  );
  scratch.scaleAttribute = scaleAttribute;
  scratch.scaleAttributeRevision = getInstancingRevision(
    scaleAttribute,
    scratch,
  );
  scratch.scaleData = scaleData;
  scratch.scaleDataRevision = getInstancingRevision(scaleData, scratch);
  scratch.scaleDataLength = readTrackedInstancingProperty(
    scratch,
    scaleData,
    "length",
  );

  const featureIds = readTrackedInstancingProperty(
    scratch,
    instances,
    "featureIds",
  );
  if (!defined(model) || !defined(featureIds)) {
    return scratch;
  }
  const selected = findTrackedInstanceFeatureIdByLabel(
    scratch,
    featureIds,
    readTrackedInstanceFeatureIdLabel(scratch, model),
  );
  const propertyTableId = readTrackedInstancingProperty(
    scratch,
    selected,
    "propertyTableId",
  );
  if (!defined(selected) || !defined(propertyTableId)) {
    return scratch;
  }
  const propertyTable = findInstancePropertyTable(
    scratch,
    model,
    propertyTableId,
  );
  if (!defined(propertyTable)) {
    return scratch;
  }

  let featureAttribute;
  let featureData;
  let featureKind;
  let implicitOffset;
  let implicitRepeat;
  if (
    trackedInstancingPrototypeChainIncludes(
      scratch,
      selected,
      FEATURE_ID_ATTRIBUTE_PROTOTYPE,
    )
  ) {
    const setIndex = readTrackedInstancingProperty(
      scratch,
      selected,
      "setIndex",
    );
    featureAttribute = findInstanceFeatureIdAttribute(
      scratch,
      instances,
      setIndex,
    );
    featureData = readTrackedInstancingProperty(
      scratch,
      featureAttribute,
      "typedArray",
    );
    featureKind = INSTANCE_FEATURE_ID_ATTRIBUTE;
  } else if (
    trackedInstancingPrototypeChainIncludes(
      scratch,
      selected,
      FEATURE_ID_IMPLICIT_RANGE_PROTOTYPE,
    )
  ) {
    featureKind = INSTANCE_FEATURE_ID_IMPLICIT;
    const selectedOffset = readTrackedInstancingProperty(
      scratch,
      selected,
      "offset",
    );
    const selectedRepeat = readTrackedInstancingProperty(
      scratch,
      selected,
      "repeat",
    );
    implicitOffset = Number.isFinite(selectedOffset) ? selectedOffset : 0;
    implicitRepeat = Number.isFinite(selectedRepeat)
      ? Math.max(1, selectedRepeat)
      : 1;
  } else {
    return scratch;
  }

  scratch.featureKind = featureKind;
  scratch.featureSource = selected;
  scratch.featureSourceRevision = getInstancingRevision(selected, scratch);
  scratch.propertyTableId = propertyTableId;
  scratch.propertyTable = propertyTable;
  scratch.propertyTableRevision = getInstancingRevision(propertyTable, scratch);
  scratch.propertyTableCount = readTrackedInstancingAlias(
    scratch,
    propertyTable,
    "count",
    "_count",
  );
  scratch.featureAttribute = featureAttribute;
  scratch.featureAttributeRevision = getInstancingRevision(
    featureAttribute,
    scratch,
  );
  scratch.featureBuffer = readTrackedInstancingProperty(
    scratch,
    featureAttribute,
    "buffer",
  );
  scratch.featureData = featureData;
  scratch.featureDataRevision = getInstancingRevision(featureData, scratch);
  scratch.featureDataLength = readTrackedInstancingProperty(
    scratch,
    featureData,
    "length",
  );
  scratch.implicitOffset = implicitOffset;
  scratch.implicitRepeat = implicitRepeat;
  return scratch;
}

function captureInstancingProvenance(live) {
  const captured = {};
  for (let i = 0; i < INSTANCING_PROVENANCE_KEYS.length; i++) {
    const key = INSTANCING_PROVENANCE_KEYS[i];
    captured[key] = live[key];
  }
  return captured;
}

function instancingProvenanceMatches(captured, live) {
  if (!defined(captured)) {
    return false;
  }
  for (let i = 0; i < INSTANCING_PROVENANCE_KEYS.length; i++) {
    const key = INSTANCING_PROVENANCE_KEYS[i];
    if (!Object.is(captured[key], live[key])) {
      return false;
    }
  }
  return true;
}

function instancingGenerationMatchesLive(
  nodeCache,
  model,
  runtimeNode,
  expectedBuffer,
  expectedProvenance,
  expectedEpoch,
) {
  if (nodeCache.instancingResourcesDestroyed === true) {
    return false;
  }
  const liveProvenance = populateInstancingProvenance(
    nodeCache,
    model,
    runtimeNode,
  );
  return (
    nodeCache.instancingResourcesDestroyed !== true &&
    defined(liveProvenance) &&
    defined(liveProvenance.instances) &&
    liveProvenance.instanceCount > 0 &&
    nodeCache.instancingPublicationEpoch === expectedEpoch &&
    nodeCache.instancingBuffer === expectedBuffer &&
    nodeCache.instancingProvenance === expectedProvenance &&
    instancingProvenanceMatches(expectedProvenance, liveProvenance)
  );
}

/**
 * Materializes the selected IDs only on a provenance miss.
 *
 * @param {object} provenance
 * @param {number} count
 * @returns {Float32Array|null|undefined}
 * @private
 */
function createInstanceFeatureIds(provenance, count) {
  if (provenance.featureKind === INSTANCE_FEATURE_ID_NONE) {
    return null;
  }
  const out = new Float32Array(count);
  if (provenance.featureKind === INSTANCE_FEATURE_ID_ATTRIBUTE) {
    const values = provenance.featureData;
    if (!defined(values)) {
      return undefined;
    }
    for (let i = 0; i < count; i++) {
      out[i] = values[i];
    }
    return out;
  }
  const offset = provenance.implicitOffset;
  const repeat = provenance.implicitRepeat;
  for (let i = 0; i < count; i++) {
    out[i] = offset + Math.floor(i / repeat);
  }
  return out;
}

/**
 * Transfers retired buffers to the exact encoder segment that may have encoded
 * their last capture/draw reference, then waits for all prior queue work before
 * destruction. A rejected enlistment remains node-owned for a later retry.
 *
 * @param {GPUDevice} device
 * @param {object} nodeCache
 * @param {object} context
 * @returns {boolean} Whether a pending retirement caused context/device
 *   observation and therefore requires semantic revalidation before return.
 * @private
 */
function scheduleRetiredInstancingBuffers(device, nodeCache, context) {
  const retired = nodeCache.retiredInstancingBuffers;
  if (!defined(retired) || retired.size === 0) {
    return false;
  }
  const encoder = context?.currentCommandEncoder;
  const enqueue = context?.enqueueAfterCommandEncoderSubmit;
  if (!defined(encoder) || typeof enqueue !== "function") {
    return true;
  }
  const queue = device.queue;
  if (nodeCache.instancingResourcesDestroyed === true) {
    return true;
  }

  // Snapshot the candidates because rejected transfers are restored after the
  // foreign call. Iterating the live Set while deleting and re-adding its
  // current element can revisit it indefinitely.
  const pending = Array.from(retired);
  for (let i = 0; i < pending.length; i++) {
    if (nodeCache.instancingResourcesDestroyed === true) {
      return true;
    }
    const buffer = pending[i];
    if (!retired.delete(buffer)) {
      continue;
    }

    // Reserve node ownership before crossing the foreign enqueue boundary.
    // A synchronous teardown can now see either node-owned or scheduler-owned
    // state, never both. A callback fired before enqueue returns is held until
    // the boolean return commits the transfer.
    let transferAccepted = false;
    let callbackInvoked = false;
    let callbackConsumed = false;
    const settleAcceptedTransfer = function () {
      if (!transferAccepted || !callbackInvoked || callbackConsumed) {
        return;
      }
      callbackConsumed = true;
      let settlement;
      try {
        settlement = queue.onSubmittedWorkDone();
      } catch {
        // A lost queue owns native reclamation.
        return;
      }
      settlement.then(
        function () {
          try {
            buffer.destroy();
          } catch {
            // Destruction is best-effort after ownership has settled.
          }
        },
        function () {
          // Device loss owns native reclamation; do not call into it again.
        },
      );
    };

    let accepted = false;
    try {
      accepted =
        enqueue.call(context, encoder, function () {
          callbackInvoked = true;
          settleAcceptedTransfer();
        }) === true;
    } catch {
      // Foreign context wrappers may reject enlistment by throwing.
    }
    if (accepted) {
      transferAccepted = true;
      settleAcceptedTransfer();
      continue;
    }

    // A callback from a wrapper that returned false or threw never acquired
    // ownership. Make any late invocation inert before restoring the node
    // owner, or drain the reservation here if teardown ended that lifecycle.
    callbackConsumed = true;
    if (nodeCache.instancingResourcesDestroyed === true) {
      try {
        buffer.destroy();
      } catch {
        // Terminal cleanup is best-effort after foreign enlistment failure.
      }
    } else {
      nodeCache.retiredInstancingBuffers ??= new Set();
      nodeCache.retiredInstancingBuffers.add(buffer);
    }
  }
  if (nodeCache.retiredInstancingBuffers === retired && retired.size === 0) {
    nodeCache.retiredInstancingBuffers = undefined;
  }
  return true;
}

/**
 * Locates the instance attribute that backs an explicit instance
 * FeatureIdAttribute set (FEATURE_ID semantic and matching setIndex).
 *
 * @param {object} scratch
 * @param {object} instances - node.instances
 * @param {number} setIndex
 * @returns {object|undefined}
 * @private
 */
function findInstanceFeatureIdAttribute(scratch, instances, setIndex) {
  const attrs = readTrackedInstancingProperty(scratch, instances, "attributes");
  const length = readTrackedInstancingProperty(scratch, attrs, "length") ?? 0;
  for (let i = 0; i < length; i++) {
    const attr = readTrackedInstancingProperty(scratch, attrs, i);
    if (
      readTrackedInstancingProperty(scratch, attr, "semantic") ===
        InstanceAttributeSemantic.FEATURE_ID &&
      readTrackedInstancingProperty(scratch, attr, "setIndex") === setIndex
    ) {
      return attr;
    }
  }
  return undefined;
}

/**
 * Destroys instancing GPU resources.
 * @param {object} nodeCache - Per-node cache
 */
function destroyInstancingResources(nodeCache) {
  if (nodeCache.instancingResourcesDestroyed === true) {
    return;
  }

  // Publish the terminal state and advance the generation before invoking any
  // native/foreign destroy method. This blocks both nested ensure calls from a
  // destroy wrapper and stale candidates that were already allocating.
  nodeCache.instancingResourcesDestroyed = true;
  nodeCache.instancingPublicationEpoch =
    (nodeCache.instancingPublicationEpoch ?? 0) + 1;

  const buffers = new Set();
  if (defined(nodeCache.instancingBuffer)) {
    buffers.add(nodeCache.instancingBuffer);
  }
  const retired = nodeCache.retiredInstancingBuffers;
  if (defined(retired)) {
    for (const buffer of retired) {
      buffers.add(buffer);
    }
  }
  nodeCache.instancingBuffer = undefined;
  nodeCache.instanceCount = undefined;
  nodeCache.instancingProvenance = undefined;
  nodeCache.instancingProvenanceScratchPool = undefined;
  nodeCache.instancingProvenanceScratchDepth = undefined;
  nodeCache.instancingResources = undefined;
  nodeCache.retiredInstancingBuffers = undefined;

  let firstDestroyError;
  let hasDestroyError = false;
  for (const buffer of buffers) {
    try {
      buffer.destroy();
    } catch (error) {
      if (!hasDestroyError) {
        firstDestroyError = error;
        hasDestroyError = true;
      }
    }
  }
  if (hasDestroyError) {
    throw firstDestroyError;
  }
}

export { ensureInstancingResources, destroyInstancingResources };
export default {
  ensureInstancingResources,
  destroyInstancingResources,
};
