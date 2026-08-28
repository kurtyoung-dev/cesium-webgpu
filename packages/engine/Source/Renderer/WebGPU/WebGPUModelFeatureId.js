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
const FEATURE_PICK_ENABLED_OFFSET = 40;
const FEATURE_PICK_ENABLED_DATA = new Float32Array([1.0]);
const MAX_FEATURE_RESOURCE_CONVERGENCE_ATTEMPTS = 4;
const MAX_FEATURE_RESOURCE_SELECTOR_LENGTH = 64;
const MAX_FEATURE_RESOURCE_PROTOTYPE_DEPTH = 64;

const FEATURE_SOURCE_NONE = 0;
const FEATURE_SOURCE_TEXTURE = 1;
const FEATURE_SOURCE_ATTRIBUTE = 2;
const FEATURE_SOURCE_IMPLICIT = 3;
const FEATURE_SOURCE_UNKNOWN = 4;
const FEATURE_ID_BUFFER_PRESENT_BIT = 1;
const FEATURE_ID_BUFFER_SYNTHESIZED_BIT = 2;

const FEATURE_ID_TEXTURE_PROTOTYPE = ModelComponents.FeatureIdTexture.prototype;
const FEATURE_ID_ATTRIBUTE_PROTOTYPE =
  ModelComponents.FeatureIdAttribute.prototype;
const FEATURE_ID_IMPLICIT_PROTOTYPE =
  ModelComponents.FeatureIdImplicitRange.prototype;

const FEATURE_RESOURCE_REVISION_KEYS = Object.freeze([
  "_featureResourceRevision",
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

const FEATURE_RESOURCE_PROVENANCE_KEYS = Object.freeze([
  "device",
  "queue",
  "resourceGeneration",
  "compatibilityToken",
  "pipelineCache",
  "defaultTexture",
  "defaultSampler",
  "featureSampler",
  "runtimeNode",
  "node",
  "nodeRevision",
  "instances",
  "instancesRevision",
  "instanceFeatureIds",
  "instanceFeatureIdsRevision",
  "primitive",
  "primitiveRevision",
  "primitiveFeatureIds",
  "primitiveFeatureIdsRevision",
  "selectedDomain",
  "selectedSource",
  "selectedKind",
  "selectedRevision",
  "selectedFeatureCount",
  "selectedNullFeatureId",
  "selectedPropertyTableId",
  "selectedSetIndex",
  "selectedOffset",
  "selectedRepeat",
  "textureReader",
  "textureReaderRevision",
  "textureChannels",
  "textureTexCoord",
  "textureTransform",
  "textureTransformRevision",
  "cesiumTexture",
  "cesiumTextureRevision",
  "stubWrapper",
  "stubNative",
  "stubNativeTexture",
  "textureSource",
  "textureSourceRevision",
  "textureWidth",
  "textureHeight",
  "featureTables",
  "featureTablesRevision",
  "featureTableId",
  "featureTable",
  "featureTableRevision",
  "featuresLength",
  "batchTexture",
  "batchTextureRevision",
  "batchOwner",
  "batchDimensions",
  "batchWidth",
  "batchHeight",
  "batchStep",
  "batchStepX",
  "batchStepY",
  "batchStepZ",
  "batchStepW",
  "batchValues",
  "batchValuesRevision",
  "batchValuesByteLength",
  "batchContentRevision",
  "batchImageTexture",
  "batchImageSource",
  "batchImageSourceRevision",
  "batchImageWidth",
  "batchImageHeight",
  "hasFeatureTable",
  "hasSelectedSource",
]);

const FEATURE_RESOURCE_CONTENT_KEYS = Object.freeze([
  "batchValues",
  "batchValuesRevision",
  "batchValuesByteLength",
  "batchContentRevision",
]);

function isFeatureResourceObject(value) {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  );
}

function beginFeatureResourceObservation(scratch) {
  scratch.sourceOwners ??= [];
  scratch.sourceKeys ??= [];
  scratch.descriptorOwners ??= [];
  scratch.descriptorKinds ??= [];
  scratch.getters ??= [];
  scratch.setters ??= [];
  scratch.values ??= [];
  scratch.prototypeOwners ??= [];
  scratch.prototypeValues ??= [];
  scratch.record ??= {};

  const previousAnchorCount = scratch.anchorCount ?? 0;
  for (let i = 0; i < previousAnchorCount; i++) {
    scratch.sourceOwners[i] = undefined;
    scratch.sourceKeys[i] = undefined;
    scratch.descriptorOwners[i] = undefined;
    scratch.getters[i] = undefined;
    scratch.setters[i] = undefined;
    scratch.values[i] = undefined;
  }
  const previousPrototypeCount = scratch.prototypeCount ?? 0;
  for (let i = 0; i < previousPrototypeCount; i++) {
    scratch.prototypeOwners[i] = undefined;
    scratch.prototypeValues[i] = undefined;
  }

  scratch.anchorCount = 0;
  scratch.prototypeCount = 0;
  scratch.valid = true;
}

function readTrackedFeatureResourceProperty(scratch, owner, key) {
  if (!isFeatureResourceObject(owner)) {
    return undefined;
  }

  let descriptorOwner = owner;
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(descriptorOwner, key);
    while (!defined(descriptor)) {
      descriptorOwner = Object.getPrototypeOf(descriptorOwner);
      if (!defined(descriptorOwner)) {
        break;
      }
      descriptor = Object.getOwnPropertyDescriptor(descriptorOwner, key);
    }
  } catch {
    scratch.valid = false;
    return undefined;
  }

  const index = scratch.anchorCount++;
  scratch.sourceOwners[index] = owner;
  scratch.sourceKeys[index] = key;
  scratch.descriptorOwners[index] = descriptorOwner;
  if (!defined(descriptor)) {
    scratch.descriptorKinds[index] = 0;
    scratch.getters[index] = undefined;
    scratch.setters[index] = undefined;
    scratch.values[index] = undefined;
    return undefined;
  }

  if (Object.prototype.hasOwnProperty.call(descriptor, "value")) {
    scratch.descriptorKinds[index] = 1;
    scratch.getters[index] = undefined;
    scratch.setters[index] = undefined;
    scratch.values[index] = descriptor.value;
    return descriptor.value;
  }

  scratch.descriptorKinds[index] = 2;
  scratch.getters[index] = descriptor.get;
  scratch.setters[index] = descriptor.set;
  scratch.values[index] = undefined;
  if (typeof descriptor.get !== "function") {
    return undefined;
  }
  try {
    return descriptor.get.call(owner);
  } catch {
    scratch.valid = false;
    return undefined;
  }
}

function featureResourceObservationClosed(scratch) {
  if (scratch.valid !== true) {
    return false;
  }
  for (let i = 0; i < scratch.anchorCount; i++) {
    let descriptorOwner = scratch.sourceOwners[i];
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(
        descriptorOwner,
        scratch.sourceKeys[i],
      );
      while (!defined(descriptor)) {
        descriptorOwner = Object.getPrototypeOf(descriptorOwner);
        if (!defined(descriptorOwner)) {
          break;
        }
        descriptor = Object.getOwnPropertyDescriptor(
          descriptorOwner,
          scratch.sourceKeys[i],
        );
      }
    } catch {
      return false;
    }
    if (descriptorOwner !== scratch.descriptorOwners[i]) {
      return false;
    }
    const kind = !defined(descriptor)
      ? 0
      : Object.prototype.hasOwnProperty.call(descriptor, "value")
        ? 1
        : 2;
    if (kind !== scratch.descriptorKinds[i]) {
      return false;
    }
    if (
      (kind === 1 && !Object.is(descriptor.value, scratch.values[i])) ||
      (kind === 2 &&
        (descriptor.get !== scratch.getters[i] ||
          descriptor.set !== scratch.setters[i]))
    ) {
      return false;
    }
  }
  for (let i = 0; i < scratch.prototypeCount; i++) {
    try {
      if (
        Object.getPrototypeOf(scratch.prototypeOwners[i]) !==
        scratch.prototypeValues[i]
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

function readTrackedFeatureResourceRevision(scratch, value) {
  let revision;
  for (let i = 0; i < FEATURE_RESOURCE_REVISION_KEYS.length; i++) {
    const candidate = readTrackedFeatureResourceProperty(
      scratch,
      value,
      FEATURE_RESOURCE_REVISION_KEYS[i],
    );
    if (!defined(revision) && defined(candidate)) {
      revision = candidate;
    }
  }
  return revision;
}

function readTrackedFeatureResourceBaseRevision(scratch, value) {
  let revision;
  for (let i = 1; i < FEATURE_RESOURCE_REVISION_KEYS.length; i++) {
    const candidate = readTrackedFeatureResourceProperty(
      scratch,
      value,
      FEATURE_RESOURCE_REVISION_KEYS[i],
    );
    if (!defined(revision) && defined(candidate)) {
      revision = candidate;
    }
  }
  return revision;
}

function classifyTrackedFeatureSource(scratch, source) {
  if (!isFeatureResourceObject(source)) {
    return FEATURE_SOURCE_NONE;
  }
  let owner = source;
  for (let depth = 0; depth < MAX_FEATURE_RESOURCE_PROTOTYPE_DEPTH; depth++) {
    let prototype;
    try {
      prototype = Object.getPrototypeOf(owner);
    } catch {
      scratch.valid = false;
      return FEATURE_SOURCE_UNKNOWN;
    }
    const index = scratch.prototypeCount++;
    scratch.prototypeOwners[index] = owner;
    scratch.prototypeValues[index] = prototype;
    if (prototype === FEATURE_ID_TEXTURE_PROTOTYPE) {
      return FEATURE_SOURCE_TEXTURE;
    }
    if (prototype === FEATURE_ID_ATTRIBUTE_PROTOTYPE) {
      return FEATURE_SOURCE_ATTRIBUTE;
    }
    if (prototype === FEATURE_ID_IMPLICIT_PROTOTYPE) {
      return FEATURE_SOURCE_IMPLICIT;
    }
    if (!defined(prototype)) {
      return FEATURE_SOURCE_UNKNOWN;
    }
    owner = prototype;
  }
  scratch.valid = false;
  return FEATURE_SOURCE_UNKNOWN;
}

function findTrackedFeatureSourceByLabel(scratch, featureIds, label) {
  if (!isFeatureResourceObject(featureIds)) {
    return undefined;
  }
  const length = readTrackedFeatureResourceProperty(
    scratch,
    featureIds,
    "length",
  );
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > MAX_FEATURE_RESOURCE_SELECTOR_LENGTH
  ) {
    scratch.valid = false;
    return undefined;
  }
  for (let i = 0; i < length; i++) {
    const source = readTrackedFeatureResourceProperty(
      scratch,
      featureIds,
      String(i),
    );
    const positionalLabel = readTrackedFeatureResourceProperty(
      scratch,
      source,
      "positionalLabel",
    );
    const semanticLabel = readTrackedFeatureResourceProperty(
      scratch,
      source,
      "label",
    );
    if (positionalLabel === label || semanticLabel === label) {
      return source;
    }
  }
  return undefined;
}

function getFeatureResourceObservationScratch(primCache, depth, slot) {
  primCache._featureResourceObservationPool ??= [];
  const index = depth * 4 + slot;
  let scratch = primCache._featureResourceObservationPool[index];
  if (!defined(scratch)) {
    scratch = {};
    primCache._featureResourceObservationPool[index] = scratch;
  }
  beginFeatureResourceObservation(scratch);
  return scratch;
}

function sameFeatureResourceProvenance(left, right, ignoreContent) {
  for (let i = 0; i < FEATURE_RESOURCE_PROVENANCE_KEYS.length; i++) {
    const key = FEATURE_RESOURCE_PROVENANCE_KEYS[i];
    if (ignoreContent && FEATURE_RESOURCE_CONTENT_KEYS.includes(key)) {
      continue;
    }
    if (!Object.is(left[key], right[key])) {
      return false;
    }
  }
  return true;
}

function copyFeatureResourceProvenance(target, source) {
  for (let i = 0; i < FEATURE_RESOURCE_PROVENANCE_KEYS.length; i++) {
    const key = FEATURE_RESOURCE_PROVENANCE_KEYS[i];
    target[key] = source[key];
  }
  return target;
}

function captureFeatureResourceProvenance(
  device,
  model,
  primitive,
  runtimeNode,
  pipelineCache,
  context,
  compatibilityToken,
  scratch,
) {
  const record = scratch.record;
  record.device = device;
  record.queue = readTrackedFeatureResourceProperty(scratch, device, "queue");
  record.resourceGeneration =
    readTrackedFeatureResourceProperty(
      scratch,
      context,
      "resourceGeneration",
    ) ?? 0;
  record.compatibilityToken = compatibilityToken;
  record.pipelineCache = pipelineCache;
  record.defaultTexture = readTrackedFeatureResourceProperty(
    scratch,
    pipelineCache,
    "defaultWhiteTexture",
  );
  record.defaultSampler = readTrackedFeatureResourceProperty(
    scratch,
    pipelineCache,
    "defaultSampler",
  );
  record.featureSampler =
    readTrackedFeatureResourceProperty(
      scratch,
      pipelineCache,
      "propertyTextureSampler",
    ) ?? record.defaultSampler;

  record.runtimeNode = runtimeNode;
  const publicNode = readTrackedFeatureResourceProperty(
    scratch,
    runtimeNode,
    "node",
  );
  const privateNode = readTrackedFeatureResourceProperty(
    scratch,
    runtimeNode,
    "_node",
  );
  const node = publicNode || privateNode;
  record.node = node;
  record.nodeRevision = readTrackedFeatureResourceRevision(scratch, node);
  const instances = readTrackedFeatureResourceProperty(
    scratch,
    node,
    "instances",
  );
  record.instances = instances;
  record.instancesRevision = readTrackedFeatureResourceRevision(
    scratch,
    instances,
  );
  const instanceFeatureIds = readTrackedFeatureResourceProperty(
    scratch,
    instances,
    "featureIds",
  );
  record.instanceFeatureIds = instanceFeatureIds;
  record.instanceFeatureIdsRevision = readTrackedFeatureResourceRevision(
    scratch,
    instanceFeatureIds,
  );

  record.primitive = primitive;
  record.primitiveRevision = readTrackedFeatureResourceRevision(
    scratch,
    primitive,
  );
  const primitiveFeatureIds = readTrackedFeatureResourceProperty(
    scratch,
    primitive,
    "featureIds",
  );
  record.primitiveFeatureIds = primitiveFeatureIds;
  record.primitiveFeatureIdsRevision = readTrackedFeatureResourceRevision(
    scratch,
    primitiveFeatureIds,
  );

  const instanceLabel = readTrackedFeatureResourceProperty(
    scratch,
    model,
    "instanceFeatureIdLabel",
  );
  const primitiveLabel = readTrackedFeatureResourceProperty(
    scratch,
    model,
    "featureIdLabel",
  );
  let selectedSource = findTrackedFeatureSourceByLabel(
    scratch,
    instanceFeatureIds,
    instanceLabel,
  );
  let selectedDomain = 1;
  if (!defined(selectedSource)) {
    selectedSource = findTrackedFeatureSourceByLabel(
      scratch,
      primitiveFeatureIds,
      primitiveLabel,
    );
    selectedDomain = defined(selectedSource) ? 2 : 0;
  }
  record.selectedDomain = selectedDomain;
  record.selectedSource = selectedSource;
  record.hasSelectedSource = defined(selectedSource);
  const selectedKind = classifyTrackedFeatureSource(scratch, selectedSource);
  record.selectedKind = selectedKind;
  if (defined(selectedSource) && selectedKind === FEATURE_SOURCE_UNKNOWN) {
    scratch.valid = false;
  }
  record.selectedRevision = readTrackedFeatureResourceRevision(
    scratch,
    selectedSource,
  );
  record.selectedFeatureCount = readTrackedFeatureResourceProperty(
    scratch,
    selectedSource,
    "featureCount",
  );
  record.selectedNullFeatureId = readTrackedFeatureResourceProperty(
    scratch,
    selectedSource,
    "nullFeatureId",
  );
  record.selectedPropertyTableId = readTrackedFeatureResourceProperty(
    scratch,
    selectedSource,
    "propertyTableId",
  );
  record.selectedSetIndex = readTrackedFeatureResourceProperty(
    scratch,
    selectedSource,
    "setIndex",
  );
  record.selectedOffset = readTrackedFeatureResourceProperty(
    scratch,
    selectedSource,
    "offset",
  );
  record.selectedRepeat = readTrackedFeatureResourceProperty(
    scratch,
    selectedSource,
    "repeat",
  );

  const textureReader = readTrackedFeatureResourceProperty(
    scratch,
    selectedSource,
    "textureReader",
  );
  record.textureReader = textureReader;
  record.textureReaderRevision = readTrackedFeatureResourceRevision(
    scratch,
    textureReader,
  );
  record.textureChannels = readTrackedFeatureResourceProperty(
    scratch,
    textureReader,
    "channels",
  );
  record.textureTexCoord = readTrackedFeatureResourceProperty(
    scratch,
    textureReader,
    "texCoord",
  );
  const textureTransform = readTrackedFeatureResourceProperty(
    scratch,
    textureReader,
    "transform",
  );
  record.textureTransform = textureTransform;
  record.textureTransformRevision = readTrackedFeatureResourceRevision(
    scratch,
    textureTransform,
  );
  const cesiumTexture = readTrackedFeatureResourceProperty(
    scratch,
    textureReader,
    "texture",
  );
  record.cesiumTexture = cesiumTexture;
  record.cesiumTextureRevision = readTrackedFeatureResourceRevision(
    scratch,
    cesiumTexture,
  );
  const stubWrapper = readTrackedFeatureResourceProperty(
    scratch,
    cesiumTexture,
    "_texture",
  );
  record.stubWrapper = stubWrapper;
  let stubNative;
  if (
    selectedKind === FEATURE_SOURCE_TEXTURE &&
    defined(stubWrapper) &&
    defined(device)
  ) {
    try {
      stubNative = getWebGPUTextureForDevice(
        stubWrapper,
        device,
        record.resourceGeneration,
      );
    } catch {
      scratch.valid = false;
    }
  }
  record.stubNative = stubNative;
  record.stubNativeTexture = readTrackedFeatureResourceProperty(
    scratch,
    stubNative,
    "texture",
  );
  const privateTextureSource = readTrackedFeatureResourceProperty(
    scratch,
    cesiumTexture,
    "_source",
  );
  const publicTextureSource = readTrackedFeatureResourceProperty(
    scratch,
    cesiumTexture,
    "source",
  );
  const imageTextureSource = readTrackedFeatureResourceProperty(
    scratch,
    cesiumTexture,
    "_image",
  );
  const textureSource =
    privateTextureSource || publicTextureSource || imageTextureSource;
  record.textureSource = textureSource;
  record.textureSourceRevision = readTrackedFeatureResourceRevision(
    scratch,
    textureSource,
  );
  const textureSourceWidth = readTrackedFeatureResourceProperty(
    scratch,
    textureSource,
    "width",
  );
  const textureNaturalWidth = readTrackedFeatureResourceProperty(
    scratch,
    textureSource,
    "naturalWidth",
  );
  const textureSourceHeight = readTrackedFeatureResourceProperty(
    scratch,
    textureSource,
    "height",
  );
  const textureNaturalHeight = readTrackedFeatureResourceProperty(
    scratch,
    textureSource,
    "naturalHeight",
  );
  record.textureWidth = textureSourceWidth || textureNaturalWidth;
  record.textureHeight = textureSourceHeight || textureNaturalHeight;

  const selectedPropertyTableId = record.selectedPropertyTableId;
  const featureTableId = defined(selectedPropertyTableId)
    ? selectedPropertyTableId
    : readTrackedFeatureResourceProperty(scratch, model, "featureTableId");
  const featureTables = readTrackedFeatureResourceProperty(
    scratch,
    model,
    "featureTables",
  );
  record.featureTableId = featureTableId;
  record.featureTables = featureTables;
  record.featureTablesRevision = readTrackedFeatureResourceRevision(
    scratch,
    featureTables,
  );
  const featureTablesLength = readTrackedFeatureResourceProperty(
    scratch,
    featureTables,
    "length",
  );
  const validFeatureTableId =
    Number.isSafeInteger(featureTableId) &&
    featureTableId >= 0 &&
    Number.isSafeInteger(featureTablesLength) &&
    featureTableId < featureTablesLength;
  const featureTable = validFeatureTableId
    ? readTrackedFeatureResourceProperty(
        scratch,
        featureTables,
        String(featureTableId),
      )
    : undefined;
  record.featureTable = featureTable;
  record.featureTableRevision = readTrackedFeatureResourceRevision(
    scratch,
    featureTable,
  );
  const featuresLength = readTrackedFeatureResourceProperty(
    scratch,
    featureTable,
    "featuresLength",
  );
  record.featuresLength = featuresLength;
  record.hasFeatureTable =
    validFeatureTableId &&
    Number.isSafeInteger(featuresLength) &&
    featuresLength > 0;
  const batchTexture = readTrackedFeatureResourceProperty(
    scratch,
    featureTable,
    "batchTexture",
  );
  record.batchTexture = batchTexture;
  record.batchTextureRevision = readTrackedFeatureResourceBaseRevision(
    scratch,
    batchTexture,
  );
  record.batchContentRevision = readTrackedFeatureResourceProperty(
    scratch,
    batchTexture,
    "_featureResourceRevision",
  );
  record.batchDirty =
    readTrackedFeatureResourceProperty(
      scratch,
      batchTexture,
      "_batchValuesDirty",
    ) === true;
  record.batchOwner = readTrackedFeatureResourceProperty(
    scratch,
    batchTexture,
    "_owner",
  );
  const privateBatchDimensions = readTrackedFeatureResourceProperty(
    scratch,
    batchTexture,
    "_textureDimensions",
  );
  const publicBatchDimensions = readTrackedFeatureResourceProperty(
    scratch,
    batchTexture,
    "textureDimensions",
  );
  const batchDimensions = privateBatchDimensions || publicBatchDimensions;
  record.batchDimensions = batchDimensions;
  record.batchWidth = readTrackedFeatureResourceProperty(
    scratch,
    batchDimensions,
    "x",
  );
  record.batchHeight = readTrackedFeatureResourceProperty(
    scratch,
    batchDimensions,
    "y",
  );
  const privateBatchStep = readTrackedFeatureResourceProperty(
    scratch,
    batchTexture,
    "_textureStep",
  );
  const publicBatchStep = readTrackedFeatureResourceProperty(
    scratch,
    batchTexture,
    "textureStep",
  );
  const batchStep = privateBatchStep || publicBatchStep;
  record.batchStep = batchStep;
  record.batchStepX = readTrackedFeatureResourceProperty(
    scratch,
    batchStep,
    "x",
  );
  record.batchStepY = readTrackedFeatureResourceProperty(
    scratch,
    batchStep,
    "y",
  );
  record.batchStepZ = readTrackedFeatureResourceProperty(
    scratch,
    batchStep,
    "z",
  );
  record.batchStepW = readTrackedFeatureResourceProperty(
    scratch,
    batchStep,
    "w",
  );
  const batchValues = readTrackedFeatureResourceProperty(
    scratch,
    batchTexture,
    "_batchValues",
  );
  record.batchValues = batchValues;
  record.batchValuesRevision = readTrackedFeatureResourceRevision(
    scratch,
    batchValues,
  );
  record.batchValuesByteLength = readTrackedFeatureResourceProperty(
    scratch,
    batchValues,
    "byteLength",
  );

  const privateBatchImage = readTrackedFeatureResourceProperty(
    scratch,
    batchTexture,
    "batchTexture",
  );
  const defaultBatchImage = readTrackedFeatureResourceProperty(
    scratch,
    batchTexture,
    "defaultTexture",
  );
  const batchImageTexture = privateBatchImage || defaultBatchImage;
  record.batchImageTexture = batchImageTexture;
  const privateBatchImageSource = readTrackedFeatureResourceProperty(
    scratch,
    batchImageTexture,
    "_source",
  );
  const publicBatchImageSource = readTrackedFeatureResourceProperty(
    scratch,
    batchImageTexture,
    "source",
  );
  const fallbackBatchImageSource = readTrackedFeatureResourceProperty(
    scratch,
    batchImageTexture,
    "_image",
  );
  const batchImageSource =
    privateBatchImageSource ||
    publicBatchImageSource ||
    fallbackBatchImageSource;
  record.batchImageSource = batchImageSource;
  record.batchImageSourceRevision = readTrackedFeatureResourceRevision(
    scratch,
    batchImageSource,
  );
  const batchImageWidth = readTrackedFeatureResourceProperty(
    scratch,
    batchImageSource,
    "width",
  );
  const batchImageNaturalWidth = readTrackedFeatureResourceProperty(
    scratch,
    batchImageSource,
    "naturalWidth",
  );
  const batchImageHeight = readTrackedFeatureResourceProperty(
    scratch,
    batchImageSource,
    "height",
  );
  const batchImageNaturalHeight = readTrackedFeatureResourceProperty(
    scratch,
    batchImageSource,
    "naturalHeight",
  );
  record.batchImageWidth = batchImageWidth || batchImageNaturalWidth;
  record.batchImageHeight = batchImageHeight || batchImageNaturalHeight;

  if (record.hasFeatureTable && !defined(batchTexture)) {
    scratch.valid = false;
  }
  return record;
}

function sameCompleteFeatureResourceObservation(leftScratch, rightScratch) {
  return (
    leftScratch.valid === true &&
    rightScratch.valid === true &&
    leftScratch.record.batchDirty === rightScratch.record.batchDirty &&
    sameFeatureResourceProvenance(
      leftScratch.record,
      rightScratch.record,
      false,
    )
  );
}

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
    // This is true when the selected set comes from `node.instances.featureIds`
    // (per-instance) rather than the primitive (per-vertex). Per-vertex implicit
    // synthesis does not apply because the instance ID rides the
    // instance-transform pad slot into `featureId0` instead.
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
function updateBatchGPUTexture(device, gpuTexture, batchValues, width, height) {
  if (
    !defined(batchValues) ||
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    !Number.isSafeInteger(height) ||
    height <= 0
  ) {
    return false;
  }
  try {
    device.queue.writeTexture(
      { texture: gpuTexture },
      batchValues,
      { bytesPerRow: width * 4, rowsPerImage: height },
      { width, height, depthOrArrayLayers: 1 },
    );
    return true;
  } catch (_e) {
    return false;
  }
}

function createCapturedFeatureIdGPUTexture(device, provenance) {
  if (defined(provenance.stubNativeTexture)) {
    return {
      texture: provenance.stubNativeTexture,
      owned: false,
    };
  }
  const source = provenance.textureSource;
  const width = provenance.textureWidth;
  const height = provenance.textureHeight;
  if (
    !defined(source) ||
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    !Number.isSafeInteger(height) ||
    height <= 0
  ) {
    return null;
  }

  let texture;
  try {
    texture = device.createTexture({
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
      { texture },
      { width, height },
    );
    return { texture, owned: true };
  } catch {
    try {
      texture?.destroy();
    } catch {
      // The candidate was never published.
    }
    return null;
  }
}

function copyCapturedBatchValues(provenance) {
  const width = provenance.batchWidth;
  const height = provenance.batchHeight;
  if (
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    !Number.isSafeInteger(height) ||
    height <= 0
  ) {
    return null;
  }
  const requiredByteLength = width * height * 4;
  const source = provenance.batchValues;
  if (!defined(source)) {
    return new Uint8Array(requiredByteLength).fill(255);
  }
  if (!ArrayBuffer.isView(source) || source.byteLength < requiredByteLength) {
    return null;
  }
  const bytes = new Uint8Array(
    source.buffer,
    source.byteOffset,
    requiredByteLength,
  );
  return bytes.slice();
}

function createCapturedBatchGPUTexture(device, provenance) {
  const width = provenance.batchWidth;
  const height = provenance.batchHeight;
  const capturedBytes = copyCapturedBatchValues(provenance);
  if (defined(capturedBytes)) {
    let texture;
    try {
      texture = device.createTexture({
        label: `Batch texture ${width}x${height}`,
        size: [width, height, 1],
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      device.queue.writeTexture(
        { texture },
        capturedBytes,
        { bytesPerRow: width * 4, rowsPerImage: height },
        { width, height, depthOrArrayLayers: 1 },
      );
      return { texture, width, height };
    } catch {
      try {
        texture?.destroy();
      } catch {
        // The candidate was never published.
      }
      return null;
    }
  }

  const imageSource = provenance.batchImageSource;
  const imageWidth = provenance.batchImageWidth;
  const imageHeight = provenance.batchImageHeight;
  if (
    !defined(imageSource) ||
    !Number.isSafeInteger(imageWidth) ||
    imageWidth <= 0 ||
    !Number.isSafeInteger(imageHeight) ||
    imageHeight <= 0
  ) {
    return null;
  }
  let texture;
  try {
    texture = device.createTexture({
      label: `Batch texture ${imageWidth}x${imageHeight}`,
      size: [imageWidth, imageHeight, 1],
      format: "rgba8unorm",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.copyExternalImageToTexture(
      { source: imageSource, flipY: false },
      { texture },
      { width: imageWidth, height: imageHeight },
    );
    return { texture, width: imageWidth, height: imageHeight };
  } catch {
    try {
      texture?.destroy();
    } catch {
      // The candidate was never published.
    }
    return null;
  }
}

function destroyFeatureResourceGeneration(generation) {
  if (!defined(generation) || generation.destroyed === true) {
    return;
  }
  generation.destroyed = true;
  const featureTexture = generation.featureIdTexture;
  const featureTextureOwned = generation.featureIdTextureOwned;
  const batchTexture = generation.batchTexture;
  const uniformBuffer = generation.uniformBuffer;
  generation.featureIdTexture = undefined;
  generation.batchTexture = undefined;
  generation.uniformBuffer = undefined;
  generation.entries = undefined;
  generation.featurePickBoundTexture = undefined;
  generation.featurePickBoundGeneration = undefined;
  generation.uploadedBatchValues = undefined;
  generation.uploadedBatchContentRevision = undefined;

  let firstError;
  let hasError = false;
  const destroyBestEffort = function (resource) {
    if (!defined(resource)) {
      return;
    }
    try {
      resource.destroy();
    } catch (error) {
      if (!hasError) {
        firstError = error;
        hasError = true;
      }
    }
  };
  if (featureTextureOwned === true) {
    destroyBestEffort(featureTexture);
  }
  destroyBestEffort(batchTexture);
  destroyBestEffort(uniformBuffer);
  if (hasError) {
    throw firstError;
  }
}

function createFeatureResourceCandidate(device, provenance) {
  const candidateProvenance = copyFeatureResourceProvenance({}, provenance);
  if (!provenance.hasFeatureTable || !provenance.hasSelectedSource) {
    return {
      device,
      queue: provenance.queue,
      provenance: candidateProvenance,
      entries: undefined,
      flags: 0,
      featureIdTexture: undefined,
      featureIdTextureOwned: false,
      batchTexture: undefined,
      uniformBuffer: undefined,
      featurePickBoundTexture: undefined,
      featurePickBoundGeneration: undefined,
      uploadedBatchValues: undefined,
      uploadedBatchContentRevision: undefined,
      result: undefined,
      destroyed: false,
    };
  }

  let featureResult;
  let batchResult;
  let uniformBuffer;
  try {
    if (provenance.selectedKind === FEATURE_SOURCE_TEXTURE) {
      featureResult = createCapturedFeatureIdGPUTexture(device, provenance);
      if (!defined(featureResult)) {
        return null;
      }
    } else if (
      provenance.selectedKind !== FEATURE_SOURCE_ATTRIBUTE &&
      provenance.selectedKind !== FEATURE_SOURCE_IMPLICIT
    ) {
      return null;
    }

    batchResult = createCapturedBatchGPUTexture(device, provenance);
    if (!defined(batchResult)) {
      if (featureResult?.owned === true) {
        const featureTexture = featureResult.texture;
        featureResult.owned = false;
        featureResult.texture = undefined;
        try {
          featureTexture.destroy();
        } catch {
          // The unpublished owner is detached even when native cleanup fails.
        }
      }
      return null;
    }

    let flags = 0x40000;
    if (provenance.selectedKind === FEATURE_SOURCE_TEXTURE) {
      flags |= 0x10000;
    } else {
      flags |= 0x20000;
    }

    const uniformData = new Float32Array(FEATURE_UNIFORM_SIZE / 4);
    const uniformDataI32 = new Int32Array(uniformData.buffer);
    uniformDataI32[0] = provenance.featuresLength;
    uniformDataI32[1] = getChannelCount(provenance.textureChannels);
    uniformDataI32[2] =
      provenance.selectedKind === FEATURE_SOURCE_TEXTURE
        ? (provenance.textureTexCoord ?? 0)
        : 0;
    uniformDataI32[3] = provenance.batchHeight > 1 ? 1 : 0;
    uniformData[4] = provenance.batchStepX ?? 0;
    uniformData[5] = provenance.batchStepY ?? 0;
    uniformData[6] = provenance.batchStepZ ?? 0;
    uniformData[7] = provenance.batchStepW ?? 0;
    uniformData[8] = provenance.batchWidth ?? batchResult.width;
    uniformData[9] = provenance.batchHeight ?? batchResult.height;
    uniformData[10] = 0.0;

    uniformBuffer = device.createBuffer({
      label: "Feature ID uniforms",
      size: FEATURE_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    const featureTexture = featureResult?.texture;
    const entries = [
      {
        binding: 26,
        resource: (featureTexture || provenance.defaultTexture).createView(),
      },
      { binding: 27, resource: provenance.featureSampler },
      { binding: 28, resource: batchResult.texture.createView() },
      { binding: 29, resource: provenance.defaultSampler },
      { binding: 30, resource: { buffer: uniformBuffer } },
      {
        binding: 31,
        resource: provenance.defaultTexture.createView(),
      },
      { binding: 32, resource: provenance.defaultSampler },
    ];

    return {
      device,
      queue: provenance.queue,
      provenance: candidateProvenance,
      entries,
      flags,
      featureIdTexture: featureTexture,
      featureIdTextureOwned: featureResult?.owned === true,
      batchTexture: batchResult.texture,
      uniformBuffer,
      featurePickBoundTexture: undefined,
      featurePickBoundGeneration: undefined,
      uploadedBatchValues: provenance.batchValues,
      uploadedBatchContentRevision: provenance.batchContentRevision,
      result: { featureIdEntries: entries, flags },
      destroyed: false,
    };
  } catch {
    try {
      if (featureResult?.owned === true) {
        featureResult.texture.destroy();
      }
    } catch {
      // Continue draining the remaining unpublished candidate owners.
    }
    try {
      batchResult?.texture.destroy();
    } catch {
      // Continue draining the remaining unpublished candidate owners.
    }
    try {
      uniformBuffer?.destroy();
    } catch {
      // Candidate rollback is best-effort.
    }
    return null;
  }
}

const FEATURE_RESOURCE_RETRY = Symbol("feature-resource-retry");

function observeFeatureResourcePair(
  device,
  primCache,
  model,
  primitive,
  runtimeNode,
  pipelineCache,
  context,
  compatibilityToken,
  depth,
  slotBase,
) {
  const first = getFeatureResourceObservationScratch(
    primCache,
    depth,
    slotBase,
  );
  captureFeatureResourceProvenance(
    device,
    model,
    primitive,
    runtimeNode,
    pipelineCache,
    context,
    compatibilityToken,
    first,
  );
  const second = getFeatureResourceObservationScratch(
    primCache,
    depth,
    slotBase + 1,
  );
  captureFeatureResourceProvenance(
    device,
    model,
    primitive,
    runtimeNode,
    pipelineCache,
    context,
    compatibilityToken,
    second,
  );

  const firstClosed = featureResourceObservationClosed(first);
  const secondClosed = featureResourceObservationClosed(second);
  if (
    !firstClosed ||
    !secondClosed ||
    !sameCompleteFeatureResourceObservation(first, second)
  ) {
    return null;
  }
  return first.record;
}

function featureResourceContentMatches(left, right) {
  for (let i = 0; i < FEATURE_RESOURCE_CONTENT_KEYS.length; i++) {
    const key = FEATURE_RESOURCE_CONTENT_KEYS[i];
    if (!Object.is(left[key], right[key])) {
      return false;
    }
  }
  return true;
}

function uploadedFeatureResourceContentMatches(generation, provenance) {
  return (
    Object.is(generation.uploadedBatchValues, provenance.batchValues) &&
    Object.is(
      generation.uploadedBatchContentRevision,
      provenance.batchContentRevision,
    )
  );
}

function applyFeatureResourceGeneration(primCache, generation) {
  primCache._featureIdGeneration = generation;
  primCache._featureIdEntries = generation?.entries;
  primCache._featureIdFlags = generation?.flags;
  primCache._featureIdGPUTexture = generation?.featureIdTexture;
  primCache._featureIdGPUTextureOwned = generation?.featureIdTextureOwned;
  primCache._batchGPUTexture = generation?.batchTexture;
  primCache._featureUniformBuffer = generation?.uniformBuffer;
  primCache._featurePickGPUTexture = generation?.featurePickBoundTexture;
  primCache._featurePickBoundGPUTexture = generation?.featurePickBoundTexture;
  primCache._featurePickBoundGeneration =
    generation?.featurePickBoundGeneration;
  if (defined(generation?.result)) {
    generation.result.featureIdEntries = generation.entries;
    generation.result.flags = generation.flags;
  }
}

function featureResourceGenerationNeedsRetirement(generation) {
  return (
    defined(generation) &&
    (generation.featureIdTextureOwned === true ||
      defined(generation.batchTexture) ||
      defined(generation.uniformBuffer) ||
      defined(generation.featurePickBoundTexture))
  );
}

function addRetiredFeatureResourceGeneration(primCache, generation) {
  if (!defined(generation)) {
    return;
  }
  if (!featureResourceGenerationNeedsRetirement(generation)) {
    try {
      destroyFeatureResourceGeneration(generation);
    } catch {
      // Empty or borrowed-only generations have no native owner to strand.
    }
    return;
  }
  primCache._retiredFeatureIdGenerations ??= new Set();
  primCache._retiredFeatureIdGenerations.add(generation);
}

function removeScheduledFeatureGeneration(primCache, generation) {
  const scheduled = primCache._scheduledFeatureIdGenerations;
  scheduled?.delete(generation);
  if (defined(scheduled) && scheduled.size === 0) {
    primCache._scheduledFeatureIdGenerations = undefined;
  }
}

function scheduleRetiredFeatureResourceGenerations(
  primCache,
  context,
  modelCache,
) {
  const retired = primCache._retiredFeatureIdGenerations;
  if (!defined(retired) || retired.size === 0) {
    return false;
  }
  const encoder = context?.currentCommandEncoder;
  const enqueue = context?.enqueueAfterCommandEncoderSubmit;
  if (!defined(encoder) || typeof enqueue !== "function") {
    return true;
  }
  if (primCache._featureResourcesDestroyed === true) {
    return true;
  }

  const pending = Array.from(retired);
  for (let i = 0; i < pending.length; i++) {
    if (primCache._featureResourcesDestroyed === true) {
      return true;
    }
    const generation = pending[i];
    if (!retired.delete(generation)) {
      continue;
    }
    primCache._scheduledFeatureIdGenerations ??= new Set();
    primCache._scheduledFeatureIdGenerations.add(generation);

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
        settlement = generation.queue.onSubmittedWorkDone();
      } catch {
        removeScheduledFeatureGeneration(primCache, generation);
        destroyUnboundRetiredFeaturePickGenerations(
          modelCache,
          primCache,
          context,
        );
        return;
      }
      settlement.then(
        function () {
          removeScheduledFeatureGeneration(primCache, generation);
          try {
            destroyFeatureResourceGeneration(generation);
          } catch {
            // Destruction is best-effort after ownership has settled.
          }
          destroyUnboundRetiredFeaturePickGenerations(
            modelCache,
            primCache,
            context,
          );
        },
        function () {
          removeScheduledFeatureGeneration(primCache, generation);
          generation.destroyed = true;
          generation.featureIdTexture = undefined;
          generation.batchTexture = undefined;
          generation.uniformBuffer = undefined;
          generation.entries = undefined;
          generation.featurePickBoundTexture = undefined;
          destroyUnboundRetiredFeaturePickGenerations(
            modelCache,
            primCache,
            context,
          );
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
      // A foreign wrapper may reject ownership by throwing.
    }
    if (accepted) {
      transferAccepted = true;
      settleAcceptedTransfer();
      continue;
    }

    callbackConsumed = true;
    removeScheduledFeatureGeneration(primCache, generation);
    if (primCache._featureResourcesDestroyed === true) {
      try {
        destroyFeatureResourceGeneration(generation);
      } catch {
        // Terminal cleanup is best-effort after rejected enlistment.
      }
    } else {
      primCache._retiredFeatureIdGenerations ??= new Set();
      primCache._retiredFeatureIdGenerations.add(generation);
    }
  }
  if (
    primCache._retiredFeatureIdGenerations === retired &&
    retired.size === 0
  ) {
    primCache._retiredFeatureIdGenerations = undefined;
  }
  return true;
}

function featureResourceGenerationMatches(
  primCache,
  generation,
  provenance,
  publicationEpoch,
) {
  return (
    primCache._featureResourcesDestroyed !== true &&
    primCache._featureIdGeneration === generation &&
    (primCache._featureIdPublicationEpoch ?? 0) === publicationEpoch &&
    sameFeatureResourceProvenance(generation.provenance, provenance, false)
  );
}

function clearCapturedBatchDirty(provenance) {
  const batchTexture = provenance.batchTexture;
  if (!defined(batchTexture)) {
    return;
  }
  try {
    if (
      batchTexture._featureResourceRevision ===
        provenance.batchContentRevision &&
      batchTexture._batchValues === provenance.batchValues
    ) {
      batchTexture._batchValuesDirty = false;
    }
  } catch {
    // Dirty is an optimization hint. The monotonic revision remains truth.
  }
}

function getFeatureResourceResult(primCache, generation) {
  if (!defined(generation?.result)) {
    return undefined;
  }
  generation.result.featureIdEntries = primCache._featureIdEntries;
  generation.result.flags = primCache._featureIdFlags || 0;
  return generation.result;
}

/**
 * Retire model-wide feature-pick generations only after no retained primitive
 * bind entry can reference their texture. Texture replacement can complete
 * before all primitives promote, and a later view/uniform failure must leave
 * the old binding and its pick-ID registry entries live for retry. A live
 * context defers the actual texture destroy until submitted frame work settles;
 * direct destruction is only the isolated-test/dead-context fallback.
 *
 * @param {object} modelCache
 * @param {object} currentPrimCache
 * @param {object} context
 * @private
 */
function featurePickTextureBoundByPrimitive(primCache, texture) {
  if (!defined(primCache)) {
    return false;
  }
  if (
    primCache._featurePickBoundGPUTexture === texture ||
    primCache._featureIdGeneration?.featurePickBoundTexture === texture
  ) {
    return true;
  }
  const retired = primCache._retiredFeatureIdGenerations;
  if (defined(retired)) {
    for (const generation of retired) {
      if (generation.featurePickBoundTexture === texture) {
        return true;
      }
    }
  }
  const scheduled = primCache._scheduledFeatureIdGenerations;
  if (defined(scheduled)) {
    for (const generation of scheduled) {
      if (generation.featurePickBoundTexture === texture) {
        return true;
      }
    }
  }
  return false;
}

function destroyUnboundRetiredFeaturePickGenerations(
  modelCache,
  currentPrimCache,
  context,
) {
  if (!defined(modelCache)) {
    return;
  }
  const retiredGenerations = modelCache._retiredFeaturePickGenerations;
  if (!defined(retiredGenerations) || retiredGenerations.size === 0) {
    return;
  }

  const primitives = modelCache.primitives;
  const primitiveKeys = defined(primitives) ? Object.keys(primitives) : [];
  for (const [texture, pickIds] of retiredGenerations) {
    let isBound = featurePickTextureBoundByPrimitive(currentPrimCache, texture);
    for (let i = 0; !isBound && i < primitiveKeys.length; i++) {
      isBound = featurePickTextureBoundByPrimitive(
        primitives[primitiveKeys[i]],
        texture,
      );
    }
    if (isBound) {
      continue;
    }
    const scheduleTextureDestroy = context?.scheduleTextureDestroy;
    if (typeof scheduleTextureDestroy === "function") {
      try {
        scheduleTextureDestroy.call(context, texture);
      } catch {
        // Keep the entire generation so a later pick can retry the live-context
        // scheduler. Never destroy its IDs or direct-destroy its texture after
        // a scheduler error: submitted work may still resolve either identity.
        continue;
      }
    } else {
      try {
        texture.destroy();
      } catch {
        // Isolated fake/dead contexts have no frame submit to settle. Cleanup is
        // best-effort and cannot invalidate the promoted replacement.
      }
    }
    // Scheduling is the ownership-transfer point for a live context. Only
    // after it succeeds may the paired registry entries be released.
    retiredGenerations.delete(texture);
    for (const pickId of pickIds) {
      try {
        pickId.destroy();
      } catch {
        // One broken registry entry must not strand its siblings.
      }
    }
    pickIds.clear();
  }
  if (retiredGenerations.size === 0) {
    modelCache._retiredFeaturePickGenerations = undefined;
  }
}

/**
 * Promote one primitive's retained feature resources from the ordinary-color
 * fallback to the model-wide per-feature pick texture. The model-wide IDs and
 * texture are allowed to publish before this function completes; the
 * primitive-local bind state is not. That split makes a failed view or uniform
 * upload retryable without exposing `featurePickEnabled = 1` alongside the
 * fallback texture.
 *
 * Replacing the entries array is the material bind-group cache's revision
 * signal. Every entry except binding 31 retains its exact object identity.
 *
 * @param {GPUDevice} device
 * @param {object} primCache
 * @param {Model} model
 * @param {object} context
 * @param {object} modelCache
 * @param {object} batchTexture
 * @private
 */
function promoteFeaturePickResources(
  device,
  primCache,
  model,
  context,
  modelCache,
  batchTexture,
) {
  const generation = primCache._featureIdGeneration;
  const publicationEpoch = primCache._featureIdPublicationEpoch ?? 0;
  const currentEntries = primCache._featureIdEntries;
  const uniformBuffer = primCache._featureUniformBuffer;
  if (
    !defined(context) ||
    !defined(modelCache) ||
    !defined(batchTexture) ||
    !(primCache._featureIdFlags & 0x40000) ||
    !defined(generation) ||
    !defined(uniformBuffer) ||
    !defined(currentEntries)
  ) {
    return false;
  }

  const featurePickGeneration = ensurePerFeaturePickGeneration(
    device,
    primCache,
    modelCache,
    context,
    model,
    batchTexture,
  );
  if (featurePickGeneration === FEATURE_RESOURCE_RETRY) {
    return FEATURE_RESOURCE_RETRY;
  }
  if (!defined(featurePickGeneration)) {
    return false;
  }
  if (
    !primitiveFeaturePromotionStillCurrent(
      primCache,
      generation,
      publicationEpoch,
      currentEntries,
      uniformBuffer,
      modelCache,
      featurePickGeneration,
    )
  ) {
    return FEATURE_RESOURCE_RETRY;
  }
  if (generation.featurePickBoundGeneration === featurePickGeneration) {
    destroyUnboundRetiredFeaturePickGenerations(modelCache, primCache, context);
    return true;
  }

  let featurePickEntryIndex = -1;
  for (let i = 0; i < currentEntries.length; i++) {
    if (currentEntries[i].binding === 31) {
      featurePickEntryIndex = i;
      break;
    }
  }
  if (featurePickEntryIndex < 0) {
    return false;
  }

  // Construct every potentially-throwing JS/WebGPU input before changing the
  // primitive's published identities. `queue.writeBuffer` is the final native
  // operation; if it throws, the prior entries and flag remain authoritative:
  // either fallback/enabled=0 on a cold promotion, or the still-live old
  // texture/enabled=1 on a size replacement. The next pick retries.
  const featurePickView = featurePickGeneration.texture.createView();
  if (
    !primitiveFeaturePromotionStillCurrent(
      primCache,
      generation,
      publicationEpoch,
      currentEntries,
      uniformBuffer,
      modelCache,
      featurePickGeneration,
    )
  ) {
    return FEATURE_RESOURCE_RETRY;
  }
  const promotedEntries = currentEntries.slice();
  promotedEntries[featurePickEntryIndex] = {
    binding: 31,
    resource: featurePickView,
  };
  device.queue.writeBuffer(
    uniformBuffer,
    FEATURE_PICK_ENABLED_OFFSET,
    FEATURE_PICK_ENABLED_DATA,
  );
  if (
    !primitiveFeaturePromotionStillCurrent(
      primCache,
      generation,
      publicationEpoch,
      currentEntries,
      uniformBuffer,
      modelCache,
      featurePickGeneration,
    )
  ) {
    return FEATURE_RESOURCE_RETRY;
  }

  generation.entries = promotedEntries;
  generation.featurePickBoundTexture = featurePickGeneration.texture;
  generation.featurePickBoundGeneration = featurePickGeneration;
  applyFeatureResourceGeneration(primCache, generation);
  destroyUnboundRetiredFeaturePickGenerations(modelCache, primCache, context);
  return true;
}

function prepareFeaturePickCandidate(
  device,
  primCache,
  candidate,
  model,
  context,
  modelCache,
) {
  const batchTexture = candidate.provenance.batchTexture;
  if (
    !defined(context) ||
    !defined(modelCache) ||
    !defined(batchTexture) ||
    !(candidate.flags & 0x40000) ||
    !defined(candidate.uniformBuffer) ||
    !defined(candidate.entries)
  ) {
    return false;
  }
  const featurePickGeneration = ensurePerFeaturePickGeneration(
    device,
    primCache,
    modelCache,
    context,
    model,
    batchTexture,
  );
  if (featurePickGeneration === FEATURE_RESOURCE_RETRY) {
    return FEATURE_RESOURCE_RETRY;
  }
  if (!defined(featurePickGeneration)) {
    return false;
  }
  let featurePickEntryIndex = -1;
  for (let i = 0; i < candidate.entries.length; i++) {
    if (candidate.entries[i].binding === 31) {
      featurePickEntryIndex = i;
      break;
    }
  }
  if (featurePickEntryIndex < 0) {
    return false;
  }

  const featurePickView = featurePickGeneration.texture.createView();
  if (!featurePickGenerationIsCurrent(modelCache, featurePickGeneration)) {
    return FEATURE_RESOURCE_RETRY;
  }
  const promotedEntries = candidate.entries.slice();
  promotedEntries[featurePickEntryIndex] = {
    binding: 31,
    resource: featurePickView,
  };
  device.queue.writeBuffer(
    candidate.uniformBuffer,
    FEATURE_PICK_ENABLED_OFFSET,
    FEATURE_PICK_ENABLED_DATA,
  );
  if (!featurePickGenerationIsCurrent(modelCache, featurePickGeneration)) {
    return FEATURE_RESOURCE_RETRY;
  }
  candidate.entries = promotedEntries;
  candidate.featurePickBoundTexture = featurePickGeneration.texture;
  candidate.featurePickBoundGeneration = featurePickGeneration;
  candidate.result.featureIdEntries = promotedEntries;
  return true;
}

/**
 * Encodes which feature-ID vertex buffer the renderer bound for a primitive.
 *
 * @param {boolean} hasFeatureIdBuffer Whether a feature-ID vertex buffer is bound
 * @param {boolean} isSynthesizedImplicit Whether that buffer holds synthesized implicit IDs
 * @returns {number} The scalar compatibility token
 * @private
 */
function encodeFeatureIdCompatibilityToken(
  hasFeatureIdBuffer,
  isSynthesizedImplicit,
) {
  let token = hasFeatureIdBuffer ? FEATURE_ID_BUFFER_PRESENT_BIT : 0;
  if (hasFeatureIdBuffer && isSynthesizedImplicit) {
    token |= FEATURE_ID_BUFFER_SYNTHESIZED_BIT;
  }
  return token;
}

/**
 * Decides whether the bound feature-ID vertex buffer can serve the selected
 * feature-ID source. The token records only whether a usable buffer is bound
 * and whether it holds synthesized implicit IDs; it deliberately does not
 * record which attribute set the buffer came from, so an attribute selection
 * is accepted whenever any explicit feature-ID buffer is present. Rejecting a
 * set mismatch here would emit no command at all, which is a worse outcome
 * than the styling drift it would prevent.
 *
 * @param {object} provenance
 * @returns {boolean}
 * @private
 */
function featureResourceCompatibilityAllows(provenance) {
  if (!defined(provenance.compatibilityToken)) {
    return true;
  }

  if (provenance.selectedDomain !== 2) {
    return true;
  }
  if (provenance.selectedKind === FEATURE_SOURCE_TEXTURE) {
    return true;
  }

  const requiresPrimitiveFeatureAttribute =
    provenance.selectedKind === FEATURE_SOURCE_ATTRIBUTE ||
    provenance.selectedKind === FEATURE_SOURCE_IMPLICIT;
  if (!requiresPrimitiveFeatureAttribute) {
    return true;
  }

  const compatibilityToken = provenance.compatibilityToken;
  if ((compatibilityToken & FEATURE_ID_BUFFER_PRESENT_BIT) === 0) {
    return false;
  }
  const isSynthesizedImplicit =
    (compatibilityToken & FEATURE_ID_BUFFER_SYNTHESIZED_BIT) !== 0;
  if (provenance.selectedKind === FEATURE_SOURCE_IMPLICIT) {
    return isSynthesizedImplicit;
  }
  return !isSynthesizedImplicit;
}

function ensureFeatureIdResourcesAttempt(
  device,
  primCache,
  model,
  primitive,
  runtimeNode,
  pipelineCache,
  context,
  modelCache,
  pickPassActive,
  compatibilityToken,
  depth,
) {
  if (primCache._featureResourcesDestroyed === true) {
    return null;
  }
  const accepted = observeFeatureResourcePair(
    device,
    primCache,
    model,
    primitive,
    runtimeNode,
    pipelineCache,
    context,
    compatibilityToken,
    depth,
    0,
  );
  if (!defined(accepted)) {
    return FEATURE_RESOURCE_RETRY;
  }
  if (!featureResourceCompatibilityAllows(accepted)) {
    return null;
  }
  if (
    accepted.hasSelectedSource &&
    defined(accepted.selectedPropertyTableId) &&
    !accepted.hasFeatureTable
  ) {
    return null;
  }

  const incumbent = primCache._featureIdGeneration;
  const publicationEpoch = primCache._featureIdPublicationEpoch ?? 0;
  if (
    defined(incumbent) &&
    sameFeatureResourceProvenance(incumbent.provenance, accepted, true)
  ) {
    const contentChanged = !featureResourceContentMatches(
      incumbent.provenance,
      accepted,
    );
    const uploadedContentChanged = !uploadedFeatureResourceContentMatches(
      incumbent,
      accepted,
    );
    if (
      defined(incumbent.batchTexture) &&
      (contentChanged || uploadedContentChanged || accepted.batchDirty === true)
    ) {
      let capturedValues;
      try {
        capturedValues = copyCapturedBatchValues(accepted);
      } catch {
        return null;
      }
      if (!defined(capturedValues)) {
        return null;
      }
      if (
        !updateBatchGPUTexture(
          device,
          incumbent.batchTexture,
          capturedValues,
          accepted.batchWidth,
          accepted.batchHeight,
        )
      ) {
        return null;
      }
      // Record what the native call actually wrote before re-observing live
      // provenance. A nested newer write may complete first and then be
      // overwritten by this outer call; the next convergence attempt must see
      // that mismatch and restore the newest bytes.
      incumbent.uploadedBatchValues = accepted.batchValues;
      incumbent.uploadedBatchContentRevision = accepted.batchContentRevision;
      const postRefresh = observeFeatureResourcePair(
        device,
        primCache,
        model,
        primitive,
        runtimeNode,
        pipelineCache,
        context,
        compatibilityToken,
        depth,
        2,
      );
      if (
        !defined(postRefresh) ||
        !sameFeatureResourceProvenance(accepted, postRefresh, false) ||
        primCache._featureResourcesDestroyed === true ||
        primCache._featureIdGeneration !== incumbent ||
        (primCache._featureIdPublicationEpoch ?? 0) !== publicationEpoch
      ) {
        return FEATURE_RESOURCE_RETRY;
      }
      copyFeatureResourceProvenance(incumbent.provenance, accepted);
      clearCapturedBatchDirty(accepted);
    }

    const crossedRetirementBoundary = scheduleRetiredFeatureResourceGenerations(
      primCache,
      context,
      modelCache,
    );
    if (pickPassActive === true && defined(incumbent.result)) {
      const promotion = promoteFeaturePickResources(
        device,
        primCache,
        model,
        context,
        modelCache,
        accepted.batchTexture,
      );
      if (promotion === FEATURE_RESOURCE_RETRY) {
        return FEATURE_RESOURCE_RETRY;
      }
      if (promotion !== true) {
        return null;
      }
    }
    if (crossedRetirementBoundary || pickPassActive === true) {
      const postBoundary = observeFeatureResourcePair(
        device,
        primCache,
        model,
        primitive,
        runtimeNode,
        pipelineCache,
        context,
        compatibilityToken,
        depth,
        2,
      );
      if (
        !defined(postBoundary) ||
        !featureResourceGenerationMatches(
          primCache,
          incumbent,
          postBoundary,
          publicationEpoch,
        )
      ) {
        return FEATURE_RESOURCE_RETRY;
      }
    }
    return getFeatureResourceResult(primCache, incumbent);
  }

  const candidate = createFeatureResourceCandidate(device, accepted);
  if (!defined(candidate)) {
    return null;
  }
  if (pickPassActive === true && defined(candidate.result)) {
    try {
      const promotion = prepareFeaturePickCandidate(
        device,
        primCache,
        candidate,
        model,
        context,
        modelCache,
      );
      if (promotion !== true) {
        try {
          destroyFeatureResourceGeneration(candidate);
        } catch {
          // The unpublished candidate cannot become reachable.
        }
        return promotion === FEATURE_RESOURCE_RETRY
          ? FEATURE_RESOURCE_RETRY
          : null;
      }
    } catch (error) {
      try {
        destroyFeatureResourceGeneration(candidate);
      } catch {
        // Preserve the promotion failure after draining provisional owners.
      }
      throw error;
    }
  }
  const postCandidate = observeFeatureResourcePair(
    device,
    primCache,
    model,
    primitive,
    runtimeNode,
    pipelineCache,
    context,
    compatibilityToken,
    depth,
    2,
  );
  if (
    !defined(postCandidate) ||
    !sameFeatureResourceProvenance(
      candidate.provenance,
      postCandidate,
      false,
    ) ||
    primCache._featureResourcesDestroyed === true ||
    primCache._featureIdGeneration !== incumbent ||
    (primCache._featureIdPublicationEpoch ?? 0) !== publicationEpoch
  ) {
    try {
      destroyFeatureResourceGeneration(candidate);
    } catch {
      // The unpublished candidate cannot become reachable.
    }
    return FEATURE_RESOURCE_RETRY;
  }

  applyFeatureResourceGeneration(primCache, candidate);
  primCache._featureIdPublicationEpoch = publicationEpoch + 1;
  addRetiredFeatureResourceGeneration(primCache, incumbent);
  if (defined(candidate.batchTexture)) {
    clearCapturedBatchDirty(candidate.provenance);
  }

  const crossedRetirementBoundary = scheduleRetiredFeatureResourceGenerations(
    primCache,
    context,
    modelCache,
  );
  if (crossedRetirementBoundary || pickPassActive === true) {
    const postBoundary = observeFeatureResourcePair(
      device,
      primCache,
      model,
      primitive,
      runtimeNode,
      pipelineCache,
      context,
      compatibilityToken,
      depth,
      2,
    );
    if (
      !defined(postBoundary) ||
      !featureResourceGenerationMatches(
        primCache,
        candidate,
        postBoundary,
        publicationEpoch + 1,
      )
    ) {
      return FEATURE_RESOURCE_RETRY;
    }
  }
  return getFeatureResourceResult(primCache, candidate);
}

function ensureFeatureIdResourcesGeneration(
  device,
  primCache,
  model,
  primitive,
  runtimeNode,
  pipelineCache,
  context,
  modelCache,
  pickPassActive,
  compatibilityToken,
) {
  if (!defined(primCache._featureResourcesDestroyed)) {
    primCache._featureResourcesDestroyed = false;
  }
  if (primCache._featureResourcesDestroyed === true) {
    return null;
  }
  primCache._featureIdPublicationEpoch ??= 0;

  const callerDepth = primCache._featureResourceConvergenceDepth ?? 0;
  if (callerDepth === 0) {
    primCache._featureResourceConvergenceRemaining =
      MAX_FEATURE_RESOURCE_CONVERGENCE_ATTEMPTS;
  }
  primCache._featureResourceConvergenceDepth = callerDepth + 1;
  try {
    while ((primCache._featureResourceConvergenceRemaining ?? 0) > 0) {
      primCache._featureResourceConvergenceRemaining--;
      const result = ensureFeatureIdResourcesAttempt(
        device,
        primCache,
        model,
        primitive,
        runtimeNode,
        pipelineCache,
        context,
        modelCache,
        pickPassActive,
        compatibilityToken,
        callerDepth,
      );
      if (result !== FEATURE_RESOURCE_RETRY) {
        return result;
      }
    }
    return null;
  } finally {
    primCache._featureResourceConvergenceDepth = callerDepth;
    if (callerDepth === 0) {
      primCache._featureResourceConvergenceRemaining = undefined;
    }
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
 * @param {object} context active WebGPU context and exact-encoder scheduler
 * @param {object} modelCache per-model WebGPU owner
 * @param {boolean} pickPassActive whether dense feature picking is demanded
 * @param {number} [compatibilityToken] bit 0 marks a bound feature-ID vertex
 *   buffer, bit 1 marks synthesized implicit data, and bits 8-15 encode the
 *   bound attribute set index plus one, with zero meaning unknown
 * @returns {object|undefined|null} resources, legitimate no-feature state, or
 *   fail-closed retry/rebuild disposition
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
  compatibilityToken,
) {
  return ensureFeatureIdResourcesGeneration(
    device,
    primCache,
    model,
    primitive,
    runtimeNode,
    pipelineCache,
    context,
    modelCache,
    pickPassActive,
    compatibilityToken,
  );
}

function featurePickGenerationMatchesInputs(
  generation,
  device,
  queue,
  context,
  resourceGeneration,
  batchTexture,
  owner,
  ownerGetFeature,
  createPickId,
  dimensions,
  width,
  height,
  featuresLength,
) {
  return (
    defined(generation) &&
    generation.destroyed !== true &&
    generation.device === device &&
    generation.queue === queue &&
    generation.context === context &&
    Object.is(generation.resourceGeneration, resourceGeneration) &&
    generation.batchTexture === batchTexture &&
    generation.owner === owner &&
    generation.ownerGetFeature === ownerGetFeature &&
    generation.createPickId === createPickId &&
    generation.dimensions === dimensions &&
    generation.featuresLength === featuresLength &&
    generation.width === width &&
    generation.height === height
  );
}

function featurePickInputsRemainCurrent(
  cache,
  incumbent,
  publicationEpoch,
  device,
  queue,
  context,
  createPickId,
  resourceGeneration,
  batchTexture,
  owner,
  ownerGetFeature,
  dimensions,
  width,
  height,
  featuresLength,
) {
  try {
    return (
      cache._featurePickResourcesDestroyed !== true &&
      cache._featurePickGeneration === incumbent &&
      (cache._featurePickPublicationEpoch ?? 0) === publicationEpoch &&
      device.queue === queue &&
      context.createPickId === createPickId &&
      Object.is(context.resourceGeneration, resourceGeneration) &&
      batchTexture._owner === owner &&
      owner?.getFeature === ownerGetFeature &&
      batchTexture._featuresLength === featuresLength &&
      batchTexture._textureDimensions === dimensions &&
      dimensions.x === width &&
      dimensions.y === height
    );
  } catch {
    return false;
  }
}

function applyFeaturePickGeneration(cache, generation) {
  cache._featurePickGeneration = generation;
  cache._featurePickIds = generation?.pickIds;
  cache._featurePickGPUTexture = generation?.texture;
  cache._featurePickBatchTexture = generation?.batchTexture;
  cache._featurePickFeaturesLength = generation?.featuresLength;
  cache._featurePickTextureWidth = generation?.width;
  cache._featurePickTextureHeight = generation?.height;
  cache._featurePickDevice = generation?.device;
  cache._featurePickQueue = generation?.queue;
  cache._featurePickContext = generation?.context;
  cache._featurePickResourceGeneration = generation?.resourceGeneration;
  cache._featurePickOwner = generation?.owner;
  cache._featurePickCreatePickId = generation?.createPickId;
}

function destroyProvisionalFeaturePickGeneration(candidate) {
  if (!defined(candidate) || candidate.destroyed === true) {
    return;
  }
  candidate.destroyed = true;
  const texture = candidate.texture;
  const createdPickIds = candidate.createdPickIds;
  candidate.texture = undefined;
  candidate.pickIds = undefined;
  candidate.createdPickIds = undefined;
  try {
    texture?.destroy();
  } catch {
    // The unpublished native owner is detached even if destruction throws.
  }
  if (defined(createdPickIds)) {
    for (let i = 0; i < createdPickIds.length; i++) {
      try {
        createdPickIds[i].destroy();
      } catch {
        // Continue draining every unpublished registry owner exactly once.
      }
    }
    createdPickIds.length = 0;
  }
}

function featurePickGenerationIsCurrent(cache, generation) {
  return (
    cache?._featurePickResourcesDestroyed !== true &&
    cache?._featurePickGeneration === generation &&
    (cache?._featurePickPublicationEpoch ?? 0) ===
      generation?.publicationEpoch &&
    cache?._featurePickGPUTexture === generation?.texture &&
    cache?._featurePickIds === generation?.pickIds
  );
}

function primitiveFeaturePromotionStillCurrent(
  primCache,
  generation,
  publicationEpoch,
  entries,
  uniformBuffer,
  modelCache,
  featurePickGeneration,
) {
  return (
    primCache._featureResourcesDestroyed !== true &&
    primCache._featureIdGeneration === generation &&
    (primCache._featureIdPublicationEpoch ?? 0) === publicationEpoch &&
    primCache._featureIdEntries === entries &&
    primCache._featureUniformBuffer === uniformBuffer &&
    generation?.entries === entries &&
    generation?.uniformBuffer === uniformBuffer &&
    featurePickGenerationIsCurrent(modelCache, featurePickGeneration)
  );
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
 * Primitive-local bind-group promotion and the `featurePickEnabled` uniform
 * update are committed separately by `promoteFeaturePickResources` after this
 * model-wide allocation succeeds.
 *
 * Idempotent: subsequent calls reuse the cached texture and pickIds. A changed
 * feature count transactionally replaces the model-wide lookup; superseded
 * textures remain submit-safe until all primitive bindings migrate.
 *
 * One pickId is allocated per feature on the first eligible pick pass. When
 * the batch-table owner exposes `getFeature`, the registry target is that exact
 * `Cesium3DTileFeature`/`ModelFeature`; only owners without that API fall back
 * to `{primitive: model, id: featureId}`.
 *
 * @param {GPUDevice} device
 * @param {object} primCache - per-primitive cache slot
 * @param {object} cache - per-model cache slot
 * @param {object} context - WebGPU context (provides `createPickId`)
 * @param {object} model
 * @param {object} batchTexture - Cesium BatchTexture instance
 * @returns {object|symbol|null} the cached or freshly built generation, the
 *   retry sentinel, or an unavailable result
 * @private
 */
function ensurePerFeaturePickGeneration(
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
  let width;
  let height;
  try {
    width = dimensions?.x;
    height = dimensions?.y;
  } catch {
    return null;
  }
  const texelCount = width * height;
  const byteLength = texelCount * 4;
  if (
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    !Number.isSafeInteger(height) ||
    height <= 0 ||
    !Number.isSafeInteger(texelCount) ||
    texelCount < featuresLength ||
    !Number.isSafeInteger(byteLength)
  ) {
    return null;
  }

  if (!defined(cache._featurePickResourcesDestroyed)) {
    cache._featurePickResourcesDestroyed = false;
  }
  if (cache._featurePickResourcesDestroyed === true) {
    return null;
  }
  cache._featurePickPublicationEpoch ??= 0;
  const incumbent = cache._featurePickGeneration;
  const publicationEpoch = cache._featurePickPublicationEpoch;
  const queue = device?.queue;
  const resourceGeneration = context?.resourceGeneration;
  const owner = batchTexture._owner;
  const ownerGetFeature = owner?.getFeature;
  const createPickId = context?.createPickId;
  if (
    !defined(device) ||
    !defined(queue) ||
    !defined(context) ||
    typeof createPickId !== "function"
  ) {
    return null;
  }

  // Cache hits: reuse the prior allocation. The texture is owned by the
  // per-MODEL cache so multi-primitive models share the same pickId set.
  if (
    featurePickGenerationMatchesInputs(
      incumbent,
      device,
      queue,
      context,
      resourceGeneration,
      batchTexture,
      owner,
      ownerGetFeature,
      createPickId,
      dimensions,
      width,
      height,
      featuresLength,
    )
  ) {
    primCache._featurePickGPUTexture = incumbent.texture;
    return incumbent;
  }

  // Build a complete replacement off-cache. Cesium pickIds are byte-exact
  // RGBA colors that round-trip through the pick FBO. Existing IDs remain
  // authoritative and reusable while any newly-created IDs and the candidate
  // texture are provisional until the upload succeeds.
  const previousPickIds = incumbent?.pickIds ?? cache._featurePickIds;
  const previousTexture = incumbent?.texture ?? cache._featurePickGPUTexture;
  const canReusePreviousPickIds =
    incumbent?.batchTexture === batchTexture &&
    incumbent?.owner === owner &&
    incumbent?.context === context &&
    incumbent?.ownerGetFeature === ownerGetFeature &&
    incumbent?.createPickId === createPickId;
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
  const ownerHasGetFeature = typeof ownerGetFeature === "function";
  const data = new Uint8Array(byteLength);
  let tex;
  try {
    for (let fid = 0; fid < featuresLength; fid++) {
      // Feature IDs are target identities, not merely numeric slots. Reuse is
      // valid only while the exact BatchTexture owner is unchanged; a new
      // same-length feature table can map every fid to a different feature.
      let pid = canReusePreviousPickIds ? previousPickIds?.get(fid) : undefined;
      if (!defined(pid)) {
        const target = ownerHasGetFeature
          ? ownerGetFeature.call(owner, fid)
          : { primitive: model, id: fid };
        pid = createPickId.call(context, target, "tile-feature");
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
      label: `Feature pick texture ${width}x${height}`,
      size: [width, height, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: tex },
      data,
      { bytesPerRow: width * 4, rowsPerImage: height },
      { width, height, depthOrArrayLayers: 1 },
    );
  } catch (error) {
    destroyProvisionalFeaturePickGeneration({
      texture: tex,
      pickIds,
      createdPickIds,
      destroyed: false,
    });
    throw error;
  }

  const candidate = {
    device,
    queue,
    context,
    resourceGeneration,
    batchTexture,
    owner,
    ownerGetFeature,
    createPickId,
    dimensions,
    featuresLength,
    width,
    height,
    texture: tex,
    pickIds,
    createdPickIds,
    publicationEpoch: publicationEpoch + 1,
    destroyed: false,
  };
  if (
    !featurePickInputsRemainCurrent(
      cache,
      incumbent,
      publicationEpoch,
      device,
      queue,
      context,
      createPickId,
      resourceGeneration,
      batchTexture,
      owner,
      ownerGetFeature,
      dimensions,
      width,
      height,
      featuresLength,
    )
  ) {
    destroyProvisionalFeaturePickGeneration(candidate);
    return FEATURE_RESOURCE_RETRY;
  }

  // Publish one coherent generation before cleaning up superseded owners.
  // No callback occurs between the epoch change and its compatibility aliases.
  cache._featurePickPublicationEpoch = candidate.publicationEpoch;
  candidate.createdPickIds = undefined;
  applyFeaturePickGeneration(cache, candidate);
  primCache._featurePickGPUTexture = tex;

  const retiredPickIds = new Set();
  if (defined(previousPickIds)) {
    for (const [fid, pickId] of previousPickIds) {
      if (pickIds.get(fid) !== pickId) {
        retiredPickIds.add(pickId);
      }
    }
    previousPickIds.clear();
  }
  if (defined(previousTexture) && previousTexture !== tex) {
    const retiredGenerations =
      cache._retiredFeaturePickGenerations ??
      (cache._retiredFeaturePickGenerations = new Map());
    let generationPickIds = retiredGenerations.get(previousTexture);
    if (!defined(generationPickIds)) {
      generationPickIds = new Set();
      retiredGenerations.set(previousTexture, generationPickIds);
    }
    for (const pickId of retiredPickIds) {
      generationPickIds.add(pickId);
    }
  } else {
    // Defensive fallback for a malformed/fake texture factory. Real WebGPU
    // replacement allocations always produce a distinct texture generation.
    for (const pickId of retiredPickIds) {
      try {
        pickId.destroy();
      } catch {
        // The replacement map no longer references this retired registry entry.
      }
    }
  }
  return candidate;
}

function ensurePerFeaturePickIds(
  device,
  primCache,
  cache,
  context,
  model,
  batchTexture,
) {
  const generation = ensurePerFeaturePickGeneration(
    device,
    primCache,
    cache,
    context,
    model,
    batchTexture,
  );
  return generation === FEATURE_RESOURCE_RETRY ? null : generation?.texture;
}

/**
 * Destroys feature ID GPU resources on a primitive cache.
 * @param {object} primCache
 */
function destroyFeatureIdResources(primCache) {
  if (!defined(primCache) || primCache._featureResourcesDestroyed === true) {
    return;
  }
  primCache._featureResourcesDestroyed = true;
  primCache._featureIdPublicationEpoch =
    (primCache._featureIdPublicationEpoch ?? 0) + 1;

  const current = primCache._featureIdGeneration;
  const retired = primCache._retiredFeatureIdGenerations;
  const hasGenerationOwners =
    defined(current) || (defined(retired) && retired.size > 0);

  const legacyFeatureTexture = primCache._featureIdGPUTexture;
  const legacyFeatureTextureOwned = primCache._featureIdGPUTextureOwned;
  const legacyBatchTexture = primCache._batchGPUTexture;
  const legacyUniformBuffer = primCache._featureUniformBuffer;

  primCache._featureIdGeneration = undefined;
  primCache._retiredFeatureIdGenerations = undefined;
  primCache._featureIdEntries = undefined;
  primCache._featureIdFlags = undefined;
  primCache._featureIdGPUTexture = undefined;
  primCache._featureIdGPUTextureOwned = undefined;
  primCache._batchGPUTexture = undefined;
  primCache._featureUniformBuffer = undefined;
  primCache._featurePickGPUTexture = undefined;
  primCache._featurePickBoundGPUTexture = undefined;
  primCache._featurePickBoundGeneration = undefined;
  primCache._featureResourceObservationPool = undefined;
  primCache._featureResourceConvergenceDepth = 0;
  primCache._featureResourceConvergenceRemaining = undefined;

  let firstError;
  let hasError = false;
  const destroyBestEffort = function (destroy) {
    try {
      destroy();
    } catch (error) {
      if (!hasError) {
        firstError = error;
        hasError = true;
      }
    }
  };

  if (defined(current)) {
    destroyBestEffort(() => destroyFeatureResourceGeneration(current));
  }
  if (defined(retired)) {
    for (const generation of retired) {
      if (generation !== current) {
        destroyBestEffort(() => destroyFeatureResourceGeneration(generation));
      }
    }
    retired.clear();
  }

  // Preserve direct helper/spec callers that constructed the legacy aliases
  // without a coherent generation record. Generation-backed aliases are
  // already drained above and must never be destroyed a second time.
  if (!hasGenerationOwners) {
    if (legacyFeatureTextureOwned !== false && defined(legacyFeatureTexture)) {
      destroyBestEffort(() => legacyFeatureTexture.destroy());
    }
    if (defined(legacyBatchTexture)) {
      destroyBestEffort(() => legacyBatchTexture.destroy());
    }
    if (defined(legacyUniformBuffer)) {
      destroyBestEffort(() => legacyUniformBuffer.destroy());
    }
  }

  if (hasError) {
    throw firstError;
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
  if (!defined(cache) || cache._featurePickResourcesDestroyed === true) {
    return;
  }
  cache._featurePickResourcesDestroyed = true;
  cache._featurePickPublicationEpoch =
    (cache._featurePickPublicationEpoch ?? 0) + 1;

  // Detach every public identity before invoking foreign/native destruction.
  // A throwing pick-id registry or GPUTexture.destroy implementation must not
  // leave a half-live cache that can be observed or destroyed a second time.
  const pickIdMap = cache._featurePickIds;
  const pickIds = new Set(defined(pickIdMap) ? pickIdMap.values() : []);
  const pickTexture = cache._featurePickGPUTexture;
  const retiredGenerations = cache._retiredFeaturePickGenerations;
  const textures = new Set();
  if (defined(pickTexture)) {
    textures.add(pickTexture);
  }
  if (defined(retiredGenerations)) {
    for (const [texture, retiredPickIds] of retiredGenerations) {
      textures.add(texture);
      for (const pickId of retiredPickIds) {
        pickIds.add(pickId);
      }
      retiredPickIds.clear();
    }
  }
  cache._featurePickIds = undefined;
  cache._featurePickGeneration = undefined;
  cache._featurePickGPUTexture = undefined;
  cache._featurePickBatchTexture = undefined;
  cache._featurePickFeaturesLength = undefined;
  cache._featurePickTextureWidth = undefined;
  cache._featurePickTextureHeight = undefined;
  cache._featurePickDevice = undefined;
  cache._featurePickQueue = undefined;
  cache._featurePickContext = undefined;
  cache._featurePickResourceGeneration = undefined;
  cache._featurePickOwner = undefined;
  cache._featurePickCreatePickId = undefined;
  cache._retiredFeaturePickGenerations = undefined;
  pickIdMap?.clear();
  retiredGenerations?.clear();

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

  for (const pickId of pickIds) {
    destroyBestEffort(pickId);
  }
  for (const texture of textures) {
    destroyBestEffort(texture);
  }

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
  encodeFeatureIdCompatibilityToken,
  ensurePerFeaturePickIds,
  ensureFeatureIdResources,
  destroyFeatureIdResources,
  destroyPerFeaturePickResources,
};
export default {
  findSelectedFeatureId,
  getSelectedImplicitFeatureId,
  synthesizeImplicitFeatureIdData,
  encodeFeatureIdCompatibilityToken,
  ensurePerFeaturePickIds,
  ensureFeatureIdResources,
  destroyFeatureIdResources,
  destroyPerFeaturePickResources,
};
