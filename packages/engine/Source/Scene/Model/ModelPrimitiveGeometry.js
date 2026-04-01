/**
 * @module ModelPrimitiveGeometry
 *
 * Renderer-agnostic geometry descriptor for glTF model primitives.
 * Extracts vertex attribute metadata and typed arrays from ModelRuntimePrimitive
 * render resources, so both WebGL and WebGPU renderers can consume them.
 *
 * This separates "what geometry data does this primitive have?"
 * (shared logic) from "how do we create GPU buffers for it?"
 * (renderer-specific: WebGL VertexArray vs WebGPU GPUBuffer).
 *
 * @private
 */
import defined from "../../Core/defined.js";

/**
 * Semantic constants for vertex attributes.
 */
const AttributeSemantic = Object.freeze({
  POSITION: "POSITION",
  NORMAL: "NORMAL",
  TANGENT: "TANGENT",
  TEXCOORD_0: "TEXCOORD_0",
  TEXCOORD_1: "TEXCOORD_1",
  COLOR_0: "COLOR_0",
  JOINTS_0: "JOINTS_0",
  WEIGHTS_0: "WEIGHTS_0",
  _FEATURE_ID_0: "_FEATURE_ID_0",
});

/**
 * Extracts geometry info from a ModelRuntimePrimitive's render resources.
 *
 * @param {ModelRuntimePrimitive} runtimePrimitive
 * @returns {ModelPrimitiveGeometry|null} Geometry descriptor, or null if no position data
 */
function extractPrimitiveGeometry(runtimePrimitive) {
  if (!defined(runtimePrimitive)) {
    return null;
  }

  const rr =
    runtimePrimitive.renderResources || runtimePrimitive._renderResources;
  if (!defined(rr)) {
    return null;
  }

  const attrs = rr.attributes || rr._attributes || [];
  const result = {
    // Typed arrays for each attribute (null if not present)
    positionData: null,
    normalData: null,
    tangentData: null,
    texCoord0Data: null,
    texCoord1Data: null,
    color0Data: null,
    joints0Data: null,
    weights0Data: null,

    // Metadata
    vertexCount: 0,
    hasNormals: false,
    hasTangents: false,
    hasTexCoord0: false,
    hasTexCoord1: false,
    hasColor0: false,
    hasJoints: false,

    // Color component type (for proper conversion)
    color0ComponentType: null, // "FLOAT", "UNSIGNED_BYTE", "UNSIGNED_SHORT"
    color0Normalized: false,

    // Index data
    indexData: null,
    indexCount: 0,
    indexType: null, // "UNSIGNED_SHORT" or "UNSIGNED_INT"

    // Attribute count info
    positionComponentCount: 3,
    normalComponentCount: 3,
    tangentComponentCount: 4,
    texCoord0ComponentCount: 2,
    color0ComponentCount: 4,
  };

  // Extract attributes by semantic
  for (let i = 0; i < attrs.length; i++) {
    const attr = attrs[i];
    const semantic = attr.semantic || attr.name || "";
    const data = attr.typedArray || attr.buffer;

    if (!defined(data)) {
      continue;
    }

    switch (semantic) {
      case AttributeSemantic.POSITION:
        result.positionData = ensureFloat32(data);
        result.vertexCount = Math.floor(data.length / 3);
        break;
      case AttributeSemantic.NORMAL:
        result.normalData = ensureFloat32(data);
        result.hasNormals = true;
        break;
      case AttributeSemantic.TANGENT:
        result.tangentData = ensureFloat32(data);
        result.hasTangents = true;
        break;
      case AttributeSemantic.TEXCOORD_0:
      case "TEXCOORD":
        result.texCoord0Data = ensureFloat32(data);
        result.hasTexCoord0 = true;
        break;
      case AttributeSemantic.TEXCOORD_1:
        result.texCoord1Data = ensureFloat32(data);
        result.hasTexCoord1 = true;
        break;
      case AttributeSemantic.COLOR_0:
      case "COLOR":
        result.color0Data = data;
        result.hasColor0 = true;
        result.color0ComponentType = getComponentTypeName(data);
        result.color0Normalized = attr.normalized === true;
        // Determine component count from stride
        if (defined(attr.componentsPerAttribute)) {
          result.color0ComponentCount = attr.componentsPerAttribute;
        }
        break;
      case AttributeSemantic.JOINTS_0:
        result.joints0Data = data;
        result.hasJoints = true;
        break;
      case AttributeSemantic.WEIGHTS_0:
        result.weights0Data = ensureFloat32(data);
        break;
    }
  }

  // Position is required
  if (!defined(result.positionData) || result.vertexCount === 0) {
    return null;
  }

  // Extract morph target data from the glTF primitive
  result.morphTargets = [];
  result.morphTargetCount = 0;
  const prim = runtimePrimitive.primitive || runtimePrimitive._primitive;
  if (defined(prim) && defined(prim.morphTargets)) {
    const targets = prim.morphTargets;
    for (let t = 0; t < targets.length; t++) {
      const target = targets[t];
      const targetAttrs = target.attributes || [];
      const morphTarget = {
        positionData: null,
        normalData: null,
      };
      for (let a = 0; a < targetAttrs.length; a++) {
        const tAttr = targetAttrs[a];
        const tSemantic = tAttr.semantic || tAttr.name || "";
        const tData = tAttr.typedArray || tAttr.buffer;
        if (!defined(tData)) {
          continue;
        }
        if (tSemantic === "POSITION") {
          morphTarget.positionData = ensureFloat32(tData);
        } else if (tSemantic === "NORMAL") {
          morphTarget.normalData = ensureFloat32(tData);
        }
      }
      if (defined(morphTarget.positionData)) {
        result.morphTargets.push(morphTarget);
      }
    }
    result.morphTargetCount = result.morphTargets.length;
  }

  // Extract index data
  const indices = rr.indices;
  if (defined(indices)) {
    const idxData = indices.typedArray || indices.buffer;
    if (defined(idxData)) {
      result.indexData = idxData;
      result.indexCount = idxData.length;
      result.indexType =
        idxData instanceof Uint32Array ? "UNSIGNED_INT" : "UNSIGNED_SHORT";
    }
  }

  return result;
}

/**
 * Converts vertex color data to Float32Array [0..1] range.
 * Handles UNSIGNED_BYTE (0-255), UNSIGNED_SHORT (0-65535), and FLOAT formats.
 *
 * @param {TypedArray} data - Raw color data
 * @param {string} componentType - "FLOAT", "UNSIGNED_BYTE", or "UNSIGNED_SHORT"
 * @param {boolean} normalized
 * @returns {Float32Array}
 */
function normalizeColorData(data, componentType, normalized) {
  if (data instanceof Float32Array) {
    return data;
  }
  if (!normalized) {
    return new Float32Array(data);
  }
  const result = new Float32Array(data.length);
  if (data instanceof Uint8Array || data instanceof Uint8ClampedArray) {
    const scale = 1.0 / 255.0;
    for (let i = 0; i < data.length; i++) {
      result[i] = data[i] * scale;
    }
  } else if (data instanceof Uint16Array) {
    const scale = 1.0 / 65535.0;
    for (let i = 0; i < data.length; i++) {
      result[i] = data[i] * scale;
    }
  } else {
    for (let i = 0; i < data.length; i++) {
      result[i] = data[i];
    }
  }
  return result;
}

/**
 * Ensures data is Float32Array.
 * @private
 */
function ensureFloat32(data) {
  if (data instanceof Float32Array) {
    return data;
  }
  return new Float32Array(data);
}

/**
 * Gets component type name from typed array.
 * @private
 */
function getComponentTypeName(data) {
  if (data instanceof Float32Array) {
    return "FLOAT";
  }
  if (data instanceof Uint8Array || data instanceof Uint8ClampedArray) {
    return "UNSIGNED_BYTE";
  }
  if (data instanceof Uint16Array) {
    return "UNSIGNED_SHORT";
  }
  if (data instanceof Int16Array) {
    return "SHORT";
  }
  return "FLOAT";
}

export { extractPrimitiveGeometry, normalizeColorData, AttributeSemantic };
export default {
  extractPrimitiveGeometry,
  normalizeColorData,
  AttributeSemantic,
};
