/**
 * Immutable CPU metadata extraction/codegen cache for the WebGPU model path.
 *
 * The renderer visits every runtime primitive every frame. Structural metadata
 * packing and WGSL generation are source-generation work, not frame work, so
 * this module memoizes their combined result by model, primitive, and runtime
 * node. Weak keys keep model scene graphs collectible and also prevent mutable
 * renderer annotations from leaking across models or node instances.
 *
 * @private
 * @module WebGPUModelMetadataCache
 */
import defined from "../../Core/defined.js";
import { generateMetadataWGSL } from "../../Scene/Model/MetadataWGSLPipelineStage.js";
import {
  resolveMetadataAttributeData,
  resolvePropertyTableLayout,
  resolvePropertyTextureLayout,
} from "./WebGPUModelMetadata.js";

let modelMetadataCache = new WeakMap();

const diagnostics = {
  hitCount: 0,
  missCount: 0,
  invalidationCount: 0,
  descriptorBuildCount: 0,
  attributePackBuildCount: 0,
  propertyTextureLayoutBuildCount: 0,
  propertyTableLayoutBuildCount: 0,
  codegenBuildCount: 0,
};

function isWeakKey(value) {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  );
}

function getMetadataRevision(value) {
  if (!defined(value)) {
    return undefined;
  }
  return (
    value._webgpuMetadataRevision ??
    value._metadataRevision ??
    value.metadataRevision ??
    value._webgpuGeometryRevision ??
    value._geometryRevision ??
    value.geometryRevision ??
    value._webgpuGeneration ??
    value._generation ??
    value.generation
  );
}

function sameValue(left, right) {
  return Object.is(left, right);
}

/**
 * Capture small numeric/string transform values (offset, scale, Matrix3) by
 * value. These are the only source objects whose in-place edits are baked into
 * WGSL. Vertex/table payload arrays are intentionally tracked by identity plus
 * revision instead of scanning their potentially large contents every frame.
 */
function captureSmallValue(value) {
  if (!isWeakKey(value)) {
    return { value };
  }

  if (ArrayBuffer.isView(value)) {
    const values = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      values[i] = value[i];
    }
    return {
      value,
      revision: getMetadataRevision(value),
      length: value.length,
      values,
    };
  }

  const keys = Object.keys(value);
  const values = new Array(keys.length);
  for (let i = 0; i < keys.length; i++) {
    values[i] = captureSmallValue(value[keys[i]]);
  }
  return {
    value,
    revision: getMetadataRevision(value),
    keys,
    values,
  };
}

function smallValueMatches(signature, value) {
  if (!sameValue(signature.value, value)) {
    return false;
  }
  if (!isWeakKey(value)) {
    return sameValue(signature.value, value);
  }
  if (signature.revision !== getMetadataRevision(value)) {
    return false;
  }

  if (defined(signature.length)) {
    if (value.length !== signature.length) {
      return false;
    }
    for (let i = 0; i < signature.length; i++) {
      if (!sameValue(signature.values[i], value[i])) {
        return false;
      }
    }
    return true;
  }

  let keyIndex = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) {
      continue;
    }
    if (signature.keys[keyIndex] !== key) {
      return false;
    }
    keyIndex++;
  }
  if (keyIndex !== signature.keys.length) {
    return false;
  }
  for (let i = 0; i < signature.keys.length; i++) {
    const key = signature.keys[i];
    if (!smallValueMatches(signature.values[i], value[key])) {
      return false;
    }
  }
  return true;
}

function captureClassProperty(classProperty) {
  if (!defined(classProperty)) {
    return { classProperty };
  }
  return {
    classProperty,
    revision: getMetadataRevision(classProperty),
    type: classProperty.type,
    componentType: classProperty.componentType,
    valueType: classProperty.valueType,
    normalized: classProperty.normalized,
    isArray: classProperty.isArray,
    isVariableLengthArray: classProperty.isVariableLengthArray,
    arrayLength: classProperty.arrayLength,
    hasValueTransform: classProperty.hasValueTransform,
    offset: captureSmallValue(classProperty.offset),
    scale: captureSmallValue(classProperty.scale),
    isGpuCompatible: classProperty.isGpuCompatible,
  };
}

function classPropertyMatches(signature, classProperty) {
  if (signature.classProperty !== classProperty) {
    return false;
  }
  if (!defined(classProperty)) {
    return true;
  }
  return (
    signature.revision === getMetadataRevision(classProperty) &&
    signature.type === classProperty.type &&
    signature.componentType === classProperty.componentType &&
    signature.valueType === classProperty.valueType &&
    signature.normalized === classProperty.normalized &&
    signature.isArray === classProperty.isArray &&
    signature.isVariableLengthArray === classProperty.isVariableLengthArray &&
    signature.arrayLength === classProperty.arrayLength &&
    signature.hasValueTransform === classProperty.hasValueTransform &&
    signature.isGpuCompatible === classProperty.isGpuCompatible &&
    smallValueMatches(signature.offset, classProperty.offset) &&
    smallValueMatches(signature.scale, classProperty.scale)
  );
}

function captureTransformProperty(property) {
  if (!defined(property)) {
    return { property };
  }
  return {
    property,
    revision: getMetadataRevision(property),
    hasValueTransform: property.hasValueTransform,
    offset: captureSmallValue(property.offset),
    scale: captureSmallValue(property.scale),
  };
}

function transformPropertyMatches(signature, property) {
  if (signature.property !== property) {
    return false;
  }
  if (!defined(property)) {
    return true;
  }
  return (
    signature.revision === getMetadataRevision(property) &&
    signature.hasValueTransform === property.hasValueTransform &&
    smallValueMatches(signature.offset, property.offset) &&
    smallValueMatches(signature.scale, property.scale)
  );
}

function captureOrderedMap(map, captureEntry) {
  if (!defined(map)) {
    return { map };
  }
  const keys = Object.keys(map);
  const entries = new Array(keys.length);
  for (let i = 0; i < keys.length; i++) {
    entries[i] = captureEntry(map[keys[i]]);
  }
  return {
    map,
    revision: getMetadataRevision(map),
    keys,
    entries,
  };
}

function orderedMapMatches(signature, map, entryMatches) {
  if (signature.map !== map) {
    return false;
  }
  if (!defined(map)) {
    return true;
  }
  if (signature.revision !== getMetadataRevision(map)) {
    return false;
  }

  let index = 0;
  for (const key in map) {
    if (!Object.hasOwn(map, key)) {
      continue;
    }
    if (signature.keys[index] !== key) {
      return false;
    }
    index++;
  }
  if (index !== signature.keys.length) {
    return false;
  }
  for (let i = 0; i < signature.keys.length; i++) {
    if (!entryMatches(signature.entries[i], map[signature.keys[i]])) {
      return false;
    }
  }
  return true;
}

function captureArray(array, captureEntry) {
  if (!defined(array)) {
    return { array };
  }
  const entries = new Array(array.length);
  for (let i = 0; i < array.length; i++) {
    entries[i] = captureEntry(array[i]);
  }
  return {
    array,
    revision: getMetadataRevision(array),
    length: array.length,
    entries,
  };
}

function arrayMatches(signature, array, entryMatches) {
  if (signature.array !== array) {
    return false;
  }
  if (!defined(array)) {
    return true;
  }
  if (
    signature.revision !== getMetadataRevision(array) ||
    signature.length !== array.length
  ) {
    return false;
  }
  for (let i = 0; i < array.length; i++) {
    if (!entryMatches(signature.entries[i], array[i])) {
      return false;
    }
  }
  return true;
}

function captureAttribute(attribute) {
  if (!defined(attribute)) {
    return { attribute };
  }
  const data = attribute.typedArray || attribute.buffer;
  const quantization = attribute.quantization;
  return {
    attribute,
    revision: getMetadataRevision(attribute),
    name: attribute.name,
    type: attribute.type,
    normalized: attribute.normalized,
    data,
    dataRevision: getMetadataRevision(data),
    quantization,
    quantizationRevision: getMetadataRevision(quantization),
    quantizationOffset: captureSmallValue(quantization?.quantizedVolumeOffset),
    quantizationStep: captureSmallValue(quantization?.quantizedVolumeStepSize),
  };
}

function attributeMatches(signature, attribute) {
  if (signature.attribute !== attribute) {
    return false;
  }
  if (!defined(attribute)) {
    return true;
  }
  const data = attribute.typedArray || attribute.buffer;
  const quantization = attribute.quantization;
  return (
    signature.revision === getMetadataRevision(attribute) &&
    signature.name === attribute.name &&
    signature.type === attribute.type &&
    signature.normalized === attribute.normalized &&
    signature.data === data &&
    signature.dataRevision === getMetadataRevision(data) &&
    signature.quantization === quantization &&
    signature.quantizationRevision === getMetadataRevision(quantization) &&
    smallValueMatches(
      signature.quantizationOffset,
      quantization?.quantizedVolumeOffset,
    ) &&
    smallValueMatches(
      signature.quantizationStep,
      quantization?.quantizedVolumeStepSize,
    )
  );
}

function capturePropertyAttributeProperty(property) {
  if (!defined(property)) {
    return { property };
  }
  return {
    property,
    revision: getMetadataRevision(property),
    attribute: property.attribute,
    classProperty: captureClassProperty(property.classProperty),
    transform: captureTransformProperty(property),
  };
}

function propertyAttributePropertyMatches(signature, property) {
  return (
    signature.property === property &&
    (!defined(property) ||
      (signature.revision === getMetadataRevision(property) &&
        signature.attribute === property.attribute &&
        classPropertyMatches(signature.classProperty, property.classProperty) &&
        transformPropertyMatches(signature.transform, property)))
  );
}

function capturePropertyAttribute(propertyAttribute) {
  if (!defined(propertyAttribute)) {
    return { propertyAttribute };
  }
  return {
    propertyAttribute,
    revision: getMetadataRevision(propertyAttribute),
    properties: captureOrderedMap(
      propertyAttribute.properties,
      capturePropertyAttributeProperty,
    ),
  };
}

function propertyAttributeMatches(signature, propertyAttribute) {
  return (
    signature.propertyAttribute === propertyAttribute &&
    (!defined(propertyAttribute) ||
      (signature.revision === getMetadataRevision(propertyAttribute) &&
        orderedMapMatches(
          signature.properties,
          propertyAttribute.properties,
          propertyAttributePropertyMatches,
        )))
  );
}

function captureTextureReader(reader) {
  if (!defined(reader)) {
    return { reader };
  }
  return {
    reader,
    revision: getMetadataRevision(reader),
    channels: reader.channels,
    texCoord: reader.texCoord,
    texture: reader.texture,
    textureRevision: getMetadataRevision(reader.texture),
    transform: captureSmallValue(reader.transform),
  };
}

function textureReaderMatches(signature, reader) {
  return (
    signature.reader === reader &&
    (!defined(reader) ||
      (signature.revision === getMetadataRevision(reader) &&
        signature.channels === reader.channels &&
        signature.texCoord === reader.texCoord &&
        signature.texture === reader.texture &&
        signature.textureRevision === getMetadataRevision(reader.texture) &&
        smallValueMatches(signature.transform, reader.transform)))
  );
}

function capturePropertyTextureProperty(property) {
  if (!defined(property)) {
    return { property };
  }
  return {
    property,
    revision: getMetadataRevision(property),
    classProperty: captureClassProperty(property.classProperty),
    textureReader: captureTextureReader(property.textureReader),
    transform: captureTransformProperty(property),
  };
}

function propertyTexturePropertyMatches(signature, property) {
  return (
    signature.property === property &&
    (!defined(property) ||
      (signature.revision === getMetadataRevision(property) &&
        classPropertyMatches(signature.classProperty, property.classProperty) &&
        textureReaderMatches(signature.textureReader, property.textureReader) &&
        transformPropertyMatches(signature.transform, property)))
  );
}

function capturePropertyTexture(propertyTexture) {
  if (!defined(propertyTexture)) {
    return { propertyTexture };
  }
  return {
    propertyTexture,
    revision: getMetadataRevision(propertyTexture),
    properties: captureOrderedMap(
      propertyTexture.properties,
      capturePropertyTextureProperty,
    ),
  };
}

function propertyTextureMatches(signature, propertyTexture) {
  return (
    signature.propertyTexture === propertyTexture &&
    (!defined(propertyTexture) ||
      (signature.revision === getMetadataRevision(propertyTexture) &&
        orderedMapMatches(
          signature.properties,
          propertyTexture.properties,
          propertyTexturePropertyMatches,
        )))
  );
}

function captureClassDefinition(classDefinition) {
  if (!defined(classDefinition)) {
    return { classDefinition };
  }
  return {
    classDefinition,
    revision: getMetadataRevision(classDefinition),
    properties: captureOrderedMap(
      classDefinition.properties,
      captureClassProperty,
    ),
  };
}

function classDefinitionMatches(signature, classDefinition) {
  return (
    signature.classDefinition === classDefinition &&
    (!defined(classDefinition) ||
      (signature.revision === getMetadataRevision(classDefinition) &&
        orderedMapMatches(
          signature.properties,
          classDefinition.properties,
          classPropertyMatches,
        )))
  );
}

function captureTableProperty(property) {
  return captureTransformProperty(property);
}

function tablePropertyMatches(signature, property) {
  return transformPropertyMatches(signature, property);
}

function capturePropertyTable(propertyTable) {
  if (!defined(propertyTable)) {
    return { propertyTable };
  }
  const texture = propertyTable.texture;
  const textureData = texture?._propertyTableTextureData;
  const data = textureData?.data;
  return {
    propertyTable,
    revision: getMetadataRevision(propertyTable),
    id: propertyTable.id,
    classDefinition: captureClassDefinition(propertyTable.class),
    properties: captureOrderedMap(
      propertyTable.properties,
      captureTableProperty,
    ),
    texture,
    textureRevision: getMetadataRevision(texture),
    textureData,
    textureDataRevision: getMetadataRevision(textureData),
    textureWidth: textureData?.width,
    textureHeight: textureData?.height,
    data,
    dataRevision: getMetadataRevision(data),
  };
}

function propertyTableMatches(signature, propertyTable) {
  if (signature.propertyTable !== propertyTable) {
    return false;
  }
  if (!defined(propertyTable)) {
    return true;
  }
  const texture = propertyTable.texture;
  const textureData = texture?._propertyTableTextureData;
  const data = textureData?.data;
  return (
    signature.revision === getMetadataRevision(propertyTable) &&
    signature.id === propertyTable.id &&
    classDefinitionMatches(signature.classDefinition, propertyTable.class) &&
    orderedMapMatches(
      signature.properties,
      propertyTable.properties,
      tablePropertyMatches,
    ) &&
    signature.texture === texture &&
    signature.textureRevision === getMetadataRevision(texture) &&
    signature.textureData === textureData &&
    signature.textureDataRevision === getMetadataRevision(textureData) &&
    signature.textureWidth === textureData?.width &&
    signature.textureHeight === textureData?.height &&
    signature.data === data &&
    signature.dataRevision === getMetadataRevision(data)
  );
}

function captureFeatureId(featureId) {
  if (!defined(featureId)) {
    return { featureId };
  }
  return {
    featureId,
    revision: getMetadataRevision(featureId),
    constructor: featureId.constructor,
    label: featureId.label,
    positionalLabel: featureId.positionalLabel,
    propertyTableId: featureId.propertyTableId,
    setIndex: featureId.setIndex,
    offset: featureId.offset,
    repeat: featureId.repeat,
    textureReader: captureTextureReader(featureId.textureReader),
  };
}

function featureIdMatches(signature, featureId) {
  return (
    signature.featureId === featureId &&
    (!defined(featureId) ||
      (signature.revision === getMetadataRevision(featureId) &&
        signature.constructor === featureId.constructor &&
        signature.label === featureId.label &&
        signature.positionalLabel === featureId.positionalLabel &&
        signature.propertyTableId === featureId.propertyTableId &&
        signature.setIndex === featureId.setIndex &&
        signature.offset === featureId.offset &&
        signature.repeat === featureId.repeat &&
        textureReaderMatches(signature.textureReader, featureId.textureReader)))
  );
}

function captureFeatureTable(featureTable) {
  if (!defined(featureTable)) {
    return { featureTable };
  }
  return {
    featureTable,
    revision: getMetadataRevision(featureTable),
    featuresLength: featureTable.featuresLength,
  };
}

function featureTableMatches(signature, featureTable) {
  return (
    signature.featureTable === featureTable &&
    (!defined(featureTable) ||
      (signature.revision === getMetadataRevision(featureTable) &&
        signature.featuresLength === featureTable.featuresLength))
  );
}

function captureMetadataSignature(model, primitive, runtimeNode) {
  const structuralMetadata = model.structuralMetadata;
  const node = runtimeNode?.node || runtimeNode?._node;
  const instances = node?.instances;
  return {
    modelRevision: getMetadataRevision(model),
    primitiveRevision: getMetadataRevision(primitive),
    runtimeNodeRevision: getMetadataRevision(runtimeNode),
    structuralMetadata,
    structuralMetadataRevision: getMetadataRevision(structuralMetadata),
    propertyAttributes: captureArray(
      structuralMetadata?.propertyAttributes,
      capturePropertyAttribute,
    ),
    propertyTextures: captureArray(
      structuralMetadata?.propertyTextures,
      capturePropertyTexture,
    ),
    propertyTables: captureArray(
      structuralMetadata?.propertyTables,
      capturePropertyTable,
    ),
    primitiveAttributes: captureArray(primitive?.attributes, captureAttribute),
    primitiveFeatureIds: captureArray(primitive?.featureIds, captureFeatureId),
    node,
    nodeRevision: getMetadataRevision(node),
    instances,
    instancesRevision: getMetadataRevision(instances),
    instanceFeatureIds: captureArray(instances?.featureIds, captureFeatureId),
    featureIdLabel: model.featureIdLabel,
    instanceFeatureIdLabel: model.instanceFeatureIdLabel,
    featureTableId: model.featureTableId,
    featureTables: captureArray(model.featureTables, captureFeatureTable),
  };
}

function metadataSignatureMatches(signature, model, primitive, runtimeNode) {
  const structuralMetadata = model.structuralMetadata;
  const node = runtimeNode?.node || runtimeNode?._node;
  const instances = node?.instances;
  return (
    signature.modelRevision === getMetadataRevision(model) &&
    signature.primitiveRevision === getMetadataRevision(primitive) &&
    signature.runtimeNodeRevision === getMetadataRevision(runtimeNode) &&
    signature.structuralMetadata === structuralMetadata &&
    signature.structuralMetadataRevision ===
      getMetadataRevision(structuralMetadata) &&
    arrayMatches(
      signature.propertyAttributes,
      structuralMetadata?.propertyAttributes,
      propertyAttributeMatches,
    ) &&
    arrayMatches(
      signature.propertyTextures,
      structuralMetadata?.propertyTextures,
      propertyTextureMatches,
    ) &&
    arrayMatches(
      signature.propertyTables,
      structuralMetadata?.propertyTables,
      propertyTableMatches,
    ) &&
    arrayMatches(
      signature.primitiveAttributes,
      primitive?.attributes,
      attributeMatches,
    ) &&
    arrayMatches(
      signature.primitiveFeatureIds,
      primitive?.featureIds,
      featureIdMatches,
    ) &&
    signature.node === node &&
    signature.nodeRevision === getMetadataRevision(node) &&
    signature.instances === instances &&
    signature.instancesRevision === getMetadataRevision(instances) &&
    arrayMatches(
      signature.instanceFeatureIds,
      instances?.featureIds,
      featureIdMatches,
    ) &&
    signature.featureIdLabel === model.featureIdLabel &&
    signature.instanceFeatureIdLabel === model.instanceFeatureIdLabel &&
    signature.featureTableId === model.featureTableId &&
    arrayMatches(
      signature.featureTables,
      model.featureTables,
      featureTableMatches,
    )
  );
}

function freezeObjectArray(array) {
  if (!defined(array)) {
    return;
  }
  for (let i = 0; i < array.length; i++) {
    Object.freeze(array[i]);
  }
  Object.freeze(array);
}

function freezePropertyTextureLayout(layout) {
  if (!defined(layout)) {
    return;
  }
  freezeObjectArray(layout.textures);
  freezeObjectArray(layout.properties);
  Object.freeze(layout);
}

function freezePropertyTableLayout(layout) {
  if (!defined(layout)) {
    return;
  }
  freezeObjectArray(layout.properties);
  Object.freeze(layout);
}

function freezeCodegen(codegen) {
  if (!defined(codegen)) {
    return;
  }
  freezeObjectArray(codegen.fields);
  Object.freeze(codegen);
}

function buildMetadataDescriptor(model, primitive, runtimeNode) {
  diagnostics.descriptorBuildCount++;

  diagnostics.attributePackBuildCount++;
  const metadataAttributeData = resolveMetadataAttributeData(model, primitive);

  diagnostics.propertyTextureLayoutBuildCount++;
  const propertyTextureLayout = resolvePropertyTextureLayout(model, primitive);

  diagnostics.propertyTableLayoutBuildCount++;
  const propertyTableLayout = resolvePropertyTableLayout(
    model,
    primitive,
    runtimeNode,
  );

  let metadataCodegen;
  if (
    defined(metadataAttributeData) ||
    defined(propertyTextureLayout) ||
    defined(propertyTableLayout)
  ) {
    diagnostics.codegenBuildCount++;
    metadataCodegen = generateMetadataWGSL(model, primitive, runtimeNode, {
      metadataAttributeData,
      propertyTextureLayout,
      propertyTableLayout,
    });
  }

  if (defined(metadataAttributeData)) {
    Object.freeze(metadataAttributeData);
  }
  freezePropertyTextureLayout(propertyTextureLayout);
  freezePropertyTableLayout(propertyTableLayout);
  freezeCodegen(metadataCodegen);

  return Object.freeze({
    metadataAttributeData,
    metadataData: metadataAttributeData?.data,
    propertyTextureLayout,
    propertyTableLayout,
    metadataCodegen,
    metadataWGSL: metadataCodegen?.wgsl,
    metadataClassHash: metadataCodegen?.classHash ?? 0,
    metadataMatTransport: metadataCodegen?.matTransport === true,
    hasMetadata: defined(metadataAttributeData),
    hasPropertyTextures: defined(propertyTextureLayout),
    hasPropertyTables: defined(propertyTableLayout),
  });
}

function getPrimitiveCache(model, primitive, create) {
  let modelCache = modelMetadataCache.get(model);
  if (!defined(modelCache)) {
    if (!create) {
      return undefined;
    }
    modelCache = new WeakMap();
    modelMetadataCache.set(model, modelCache);
  }

  let primitiveCache = modelCache.get(primitive);
  if (!defined(primitiveCache) && create) {
    primitiveCache = {
      runtimeNodes: new WeakMap(),
      withoutRuntimeNode: undefined,
    };
    modelCache.set(primitive, primitiveCache);
  }
  return primitiveCache;
}

/**
 * Resolve the immutable CPU metadata annotation descriptor for one rendered
 * model primitive. Cache-hit validation performs no array/object/string
 * allocations; source identity, ordered maps, scalar codegen inputs, payload
 * revisions, selected feature-ID state, and runtime-node instance sources are
 * all observed before the descriptor is reused.
 *
 * @param {Model} model
 * @param {ModelComponents.Primitive} primitive
 * @param {ModelRuntimeNode} [runtimeNode]
 * @returns {object}
 * @private
 */
function resolveWebGPUModelMetadata(model, primitive, runtimeNode) {
  if (!isWeakKey(model) || !isWeakKey(primitive)) {
    diagnostics.missCount++;
    return buildMetadataDescriptor(model, primitive, runtimeNode);
  }

  let primitiveCache = getPrimitiveCache(model, primitive, false);
  let cached;
  if (defined(primitiveCache)) {
    cached = isWeakKey(runtimeNode)
      ? primitiveCache.runtimeNodes.get(runtimeNode)
      : primitiveCache.withoutRuntimeNode;
  }

  // The overwhelmingly common glTF path has no EXT_structural_metadata.
  // Every resolver used by buildMetadataDescriptor short-circuits solely on
  // this model-level absence, so primitive attributes, feature IDs, and node
  // instances cannot change the empty result. Keep late materialization
  // correct by checking the structural-metadata identity every frame, but do
  // not deeply walk the primitive and node graph for a descriptor that is
  // provably empty.
  if (
    defined(cached) &&
    !defined(cached.signature.structuralMetadata) &&
    !defined(model.structuralMetadata)
  ) {
    diagnostics.hitCount++;
    return cached.descriptor;
  }

  if (
    defined(cached) &&
    metadataSignatureMatches(cached.signature, model, primitive, runtimeNode)
  ) {
    diagnostics.hitCount++;
    return cached.descriptor;
  }

  if (defined(cached)) {
    diagnostics.invalidationCount++;
  }
  diagnostics.missCount++;

  const signature = captureMetadataSignature(model, primitive, runtimeNode);
  const descriptor = buildMetadataDescriptor(model, primitive, runtimeNode);
  primitiveCache = getPrimitiveCache(model, primitive, true);
  const record = { signature, descriptor };
  if (isWeakKey(runtimeNode)) {
    primitiveCache.runtimeNodes.set(runtimeNode, record);
  } else {
    primitiveCache.withoutRuntimeNode = record;
  }
  return descriptor;
}

function getWebGPUModelMetadataCacheDiagnostics() {
  return Object.freeze({ ...diagnostics });
}

function resetWebGPUModelMetadataCacheForSpecs() {
  modelMetadataCache = new WeakMap();
  for (const key in diagnostics) {
    if (Object.hasOwn(diagnostics, key)) {
      diagnostics[key] = 0;
    }
  }
}

export {
  resolveWebGPUModelMetadata,
  getWebGPUModelMetadataCacheDiagnostics,
  resetWebGPUModelMetadataCacheForSpecs,
};

export default {
  resolveWebGPUModelMetadata,
  getWebGPUModelMetadataCacheDiagnostics,
};
