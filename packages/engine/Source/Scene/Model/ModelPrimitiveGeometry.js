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

  // 2026-04-30 — `runtimePrimitive.renderResources` is never assigned
  // anywhere in the codebase (a `PrimitiveRenderResources` is built in
  // `ModelSceneGraph.js:256` but stored on the parent's
  // `nodeRenderResources.primitiveRenderResources[j]`, NOT mirrored back
  // onto the runtime primitive). The original WebGPU model code assumed
  // the slot existed, so this function unconditionally returned null —
  // breaking ALL model rendering on WebGPU (silent: no errors, no
  // command list entries, just an empty `cache.primitives`).
  //
  // Fallback path: read directly from `runtimePrimitive.primitive`
  // (the underlying `ModelComponents.Primitive`), whose `.attributes`
  // and `.indices` carry the same shape downstream code expects (each
  // attribute has `.semantic`, `.typedArray`, `.buffer`,
  // `.componentDatatype`, etc.). This pairs with the
  // `loadTypedArrayForWebGPU` retention added to `GltfLoader.js`
  // (2026-04-30) so the typed arrays are still present when this
  // function runs on WebGPU.
  const gltfPrim = runtimePrimitive.primitive || runtimePrimitive._primitive;
  const rr =
    runtimePrimitive.renderResources || runtimePrimitive._renderResources;
  const source = defined(rr) ? rr : gltfPrim;
  if (!defined(source)) {
    return null;
  }

  const attrs = source.attributes || source._attributes || [];
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
        result.positionData = ensureFloat32(data, attr, 3);
        // Vertex count derives from the dequantized length so it stays
        // correct even when the raw source is interleaved/strided.
        result.vertexCount = Math.floor(result.positionData.length / 3);
        break;
      case AttributeSemantic.NORMAL:
        result.normalData = ensureFloat32(data, attr, 3);
        result.hasNormals = true;
        break;
      case AttributeSemantic.TANGENT:
        result.tangentData = ensureFloat32(data, attr, 4);
        result.hasTangents = true;
        break;
      case AttributeSemantic.TEXCOORD_0:
      case "TEXCOORD":
        result.texCoord0Data = ensureFloat32(data, attr, 2);
        result.hasTexCoord0 = true;
        break;
      case AttributeSemantic.TEXCOORD_1:
        result.texCoord1Data = ensureFloat32(data, attr, 2);
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
        result.weights0Data = ensureFloat32(data, attr, 4);
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
        // Morph target deltas also honor KHR_mesh_quantization when the
        // source accessor carries quantization metadata; otherwise the
        // deltas reconstruct exaggerated (scaled-up integer) values.
        if (tSemantic === "POSITION") {
          morphTarget.positionData = ensureFloat32(tData, tAttr, 3);
        } else if (tSemantic === "NORMAL") {
          morphTarget.normalData = ensureFloat32(tData, tAttr, 3);
        }
      }
      if (defined(morphTarget.positionData)) {
        result.morphTargets.push(morphTarget);
      }
    }
    result.morphTargetCount = result.morphTargets.length;
  }

  // Extract index data — same fallback as attributes above.
  const indices = source.indices;
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
 * Divisor for converting normalized integer attribute values back to float.
 * Keyed on the typed-array constructor. glTF's `accessor.normalized = true`
 * means the integer value should be scaled by 1/max so e.g. `UNSIGNED_BYTE
 * 255 → 1.0`. Signed types use 1/(2^N−1) per the glTF spec (so `BYTE -128`
 * clamps to `-1.0` rather than overflowing to `-128/127`).
 * @private
 */
function normalizedDivisor(data) {
  if (data instanceof Uint8Array || data instanceof Uint8ClampedArray) {
    return 255.0;
  }
  if (data instanceof Int8Array) {
    return 127.0;
  }
  if (data instanceof Uint16Array) {
    return 65535.0;
  }
  if (data instanceof Int16Array) {
    return 32767.0;
  }
  return 1.0;
}

/**
 * Convert a glTF vertex attribute to Float32Array, honoring:
 *
 *   1. `attribute.quantization` (KHR_mesh_quantization) — applies
 *      per-component `quantizedVolumeOffset + raw * quantizedVolumeStepSize`
 *      to bring positions/normals/tangents back to their authored range.
 *   2. `attribute.normalized` — applies `raw / typeMax` for integer
 *      attributes (bytes/shorts) so the value lands in [-1, 1] or [0, 1]
 *      as the accessor type requires.
 *   3. Raw float data passthrough — returns the Float32Array directly.
 *
 * Without this, casts like `new Float32Array(int16Data)` reinterpret raw
 * integer values as f32, which makes KHR_mesh_quantization assets
 * (near-universal in production tilesets — Google Photorealistic, most
 * commercial pipelines) render fundamentally wrong: positions collapse to
 * the origin, normals light black, texcoords repeat thousands of times.
 *
 * @param {TypedArray} data Raw attribute data
 * @param {object} [attr] The source attribute (optional; carries
 *   `normalized` and `quantization` metadata when available)
 * @param {number} [componentsPerAttribute=1] Element count per vertex
 *   (3 for POSITION/NORMAL, 4 for TANGENT, 2 for TEXCOORD, etc.).
 *   Only used when quantization offsets are per-component vectors.
 * @returns {Float32Array}
 * @private
 */
function ensureFloat32(data, attr, componentsPerAttribute) {
  if (data instanceof Float32Array) {
    return data;
  }

  const quant = attr && attr.quantization;
  const nc = componentsPerAttribute || 1;

  // KHR_mesh_quantization — dequantize with per-component offset + step.
  if (quant) {
    // Quantization fields come through as Cartesian2/3/4 (x/y/z/w) on the
    // Cesium loader path; flatten to a flat Float64 array so the
    // per-component index works uniformly.
    const offset = _flattenVector(quant.quantizedVolumeOffset, nc);
    const step = _flattenVector(quant.quantizedVolumeStepSize, nc);
    if (offset && step) {
      const out = new Float32Array(data.length);
      for (let i = 0; i < data.length; i++) {
        const comp = i % nc;
        out[i] = offset[comp] + data[i] * step[comp];
      }
      return out;
    }
    // Quantization object without the expected fields — fall through to
    // the normalized / cast path.
  }

  // Normalized integer — spec-correct scale to [-1, 1] or [0, 1].
  if (attr && attr.normalized === true) {
    const divisor = normalizedDivisor(data);
    if (divisor !== 1.0) {
      const out = new Float32Array(data.length);
      const invDiv = 1.0 / divisor;
      // Signed normalized types clamp -N to -1 (i.e., the negative extreme
      // equal to the divisor should become -1, not -divisor/divisor = -1
      // — still correct because divisor for signed types is 2^N−1).
      for (let i = 0; i < data.length; i++) {
        out[i] = data[i] * invDiv;
      }
      return out;
    }
  }

  // Raw cast — last resort. Correct for non-normalized integer attributes
  // that the shader is expected to treat as integer-valued floats (rare
  // for POSITION/NORMAL/TEXCOORD but legitimate for some custom semantics).
  return new Float32Array(data);
}

/**
 * Flatten a Cartesian2/3/4 (or plain array) into a length-nc flat array.
 * Returns null if the input is falsy.
 * @private
 */
function _flattenVector(v, nc) {
  if (!defined(v)) {
    return null;
  }
  if (
    Array.isArray(v) ||
    v instanceof Float32Array ||
    v instanceof Float64Array
  ) {
    return v;
  }
  // Cartesian2 / Cartesian3 / Cartesian4 — read x, y, z, w as available
  if (typeof v === "object" && typeof v.x === "number") {
    const out = new Float64Array(nc);
    out[0] = v.x;
    if (nc >= 2) {
      out[1] = v.y ?? 0;
    }
    if (nc >= 3) {
      out[2] = v.z ?? 0;
    }
    if (nc >= 4) {
      out[3] = v.w ?? 0;
    }
    return out;
  }
  return null;
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
