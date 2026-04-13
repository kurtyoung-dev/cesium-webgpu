import ComponentDatatype from "../Core/ComponentDatatype.js";
import defined from "../Core/defined.js";

/**
 * @private
 */
class Cesium3DTileFeatureTable {
  constructor(featureTableJson, featureTableBinary) {
    this.json = featureTableJson;
    this.buffer = featureTableBinary;
    this._cachedTypedArrays = {};
    this.featuresLength = 0;
  }

  getGlobalProperty(semantic, componentType, componentLength) {
    const jsonValue = this.json[semantic];
    if (!defined(jsonValue)) {
      return undefined;
    }

    if (defined(jsonValue.byteOffset)) {
      componentType = componentType ?? ComponentDatatype.UNSIGNED_INT;
      componentLength = componentLength ?? 1;
      return getTypedArrayFromBinary(
        this,
        semantic,
        componentType,
        componentLength,
        1,
        jsonValue.byteOffset,
      );
    }

    return jsonValue;
  }

  hasProperty(semantic) {
    return defined(this.json[semantic]);
  }

  getPropertyArray(semantic, componentType, componentLength) {
    const jsonValue = this.json[semantic];
    if (!defined(jsonValue)) {
      return undefined;
    }

    if (defined(jsonValue.byteOffset)) {
      if (defined(jsonValue.componentType)) {
        componentType = ComponentDatatype.fromName(jsonValue.componentType);
      }
      return getTypedArrayFromBinary(
        this,
        semantic,
        componentType,
        componentLength,
        this.featuresLength,
        jsonValue.byteOffset,
      );
    }

    return getTypedArrayFromArray(this, semantic, componentType, jsonValue);
  }

  getProperty(semantic, componentType, componentLength, featureId, result) {
    const jsonValue = this.json[semantic];
    if (!defined(jsonValue)) {
      return undefined;
    }

    const typedArray = this.getPropertyArray(
      semantic,
      componentType,
      componentLength,
    );

    if (componentLength === 1) {
      return typedArray[featureId];
    }

    for (let i = 0; i < componentLength; ++i) {
      result[i] = typedArray[componentLength * featureId + i];
    }

    return result;
  }
}

function getTypedArrayFromBinary(
  featureTable,
  semantic,
  componentType,
  componentLength,
  count,
  byteOffset,
) {
  const cachedTypedArrays = featureTable._cachedTypedArrays;
  let typedArray = cachedTypedArrays[semantic];
  if (!defined(typedArray)) {
    typedArray = ComponentDatatype.createArrayBufferView(
      componentType,
      featureTable.buffer.buffer,
      featureTable.buffer.byteOffset + byteOffset,
      count * componentLength,
    );
    cachedTypedArrays[semantic] = typedArray;
  }
  return typedArray;
}

function getTypedArrayFromArray(featureTable, semantic, componentType, array) {
  const cachedTypedArrays = featureTable._cachedTypedArrays;
  let typedArray = cachedTypedArrays[semantic];
  if (!defined(typedArray)) {
    typedArray = ComponentDatatype.createTypedArray(componentType, array);
    cachedTypedArrays[semantic] = typedArray;
  }
  return typedArray;
}

export default Cesium3DTileFeatureTable;
