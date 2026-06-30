/**
 * DP-H46b — WGSL type maps + value-transform expression builders + a
 * stable class hash for the WebGPU structural-metadata codegen
 * (`MetadataWGSLPipelineStage`).
 *
 * This is the WGSL sibling of the GLSL type maps that
 * {@link MetadataClassProperty#getGlslType} and `MetadataPipelineStage`
 * rely on. The mapping rules are ported 1:1 from
 * `MetadataClassProperty.js:1308/1310/1318` + `getGlslType:462`:
 *
 *   - float-component types  → `f32` / `vec2<f32>` / `vec3<f32>` / `vec4<f32>`
 *   - signed-int types       → `i32` / `vec2<i32>` / `vec3<i32>` / `vec4<i32>`
 *   - unsigned-int types     → `u32` / `vec2<u32>` / `vec3<u32>` / `vec4<u32>`
 *
 * The **normalized-int → f32** rule is preserved: a property whose value
 * type is an integer but which is `normalized` (or a non-integer type)
 * resolves to the float family — exactly as `getGlslType` does — because
 * the normalized integer is decoded to a float on the CPU side (DP-H46a's
 * `ensureFloat32`) before it reaches the shader. So in WGSL such a property
 * is read as `f32`/`vec2<f32>`/... and never as an integer.
 *
 * Matrix property types (MAT2/MAT3/MAT4) map to `mat2x2<f32>` etc. — these
 * are not transported by DP-H46b's single-scalar path (that is later work),
 * but the type map is complete so `MetadataWGSLPipelineStage` can emit a
 * correct struct field for every GPU-compatible property.
 *
 * @private
 * @module MetadataWGSLHelpers
 */
import defined from "../../Core/defined.js";
import MetadataComponentType from "../MetadataComponentType.js";
import MetadataType from "../MetadataType.js";

// Float-component WGSL types indexed by component count (1..4). Index 0 is
// unused (a property always has ≥1 component). Mirrors
// `floatTypesByComponentCount` in MetadataClassProperty.js:1308.
const floatTypesByComponentCount = [
  undefined,
  "f32",
  "vec2<f32>",
  "vec3<f32>",
  "vec4<f32>",
];

// Signed-integer WGSL types. Mirrors `integerTypesByComponentCount`.
const intTypesByComponentCount = [
  undefined,
  "i32",
  "vec2<i32>",
  "vec3<i32>",
  "vec4<i32>",
];

// Unsigned-integer WGSL types. Mirrors `unsignedIntegerTypesByComponentCount`.
const uintTypesByComponentCount = [
  undefined,
  "u32",
  "vec2<u32>",
  "vec3<u32>",
  "vec4<u32>",
];

// Matrix WGSL types keyed by MetadataType. Components are always f32 in the
// shader (glTF matrix metadata is FLOAT32 / decoded). Square matrices only,
// matching the EXT_structural_metadata MATn types.
const matrixTypesByMetadataType = {
  [MetadataType.MAT2]: "mat2x2<f32>",
  [MetadataType.MAT3]: "mat3x3<f32>",
  [MetadataType.MAT4]: "mat4x4<f32>",
};

/**
 * The number of scalar components a `MetadataClassProperty` contributes to
 * its shader value (component count × array length). Mirrors the
 * `componentCount *= arrayLength` step in `getGlslType:466`.
 *
 * @param {MetadataClassProperty} classProperty
 * @returns {number}
 * @private
 */
function getComponentCount(classProperty) {
  const componentCount = MetadataType.getComponentCount(classProperty.type);
  const arrayLength = classProperty.isArray ? classProperty.arrayLength : 1;
  return componentCount * arrayLength;
}

/**
 * Resolve the WGSL type for a `MetadataClassProperty`, applying the SAME
 * rules as `MetadataClassProperty.getGlslType` (with WGSL spellings):
 *
 *   - matrix types               → `mat2x2<f32>` / `mat3x3<f32>` / `mat4x4<f32>`
 *   - normalized or non-integer  → float family (`f32`/`vec2<f32>`/...)
 *   - unsigned integer           → uint family (`u32`/`vec2<u32>`/...)
 *   - signed integer             → int family (`i32`/`vec2<i32>`/...)
 *
 * @param {MetadataClassProperty} classProperty
 * @returns {string|undefined} The WGSL type, or `undefined` if the property
 *   has a component count outside [1, 4] for vectors (e.g., a long fixed
 *   array, which DP-H46b does not transport).
 * @private
 */
function getWgslType(classProperty) {
  const type = classProperty.type;

  // Matrices map by MetadataType directly (always f32 components, never an
  // integer or normalized variant in the shader).
  if (MetadataType.isMatrixType(type)) {
    return matrixTypesByMetadataType[type];
  }

  const componentCount = getComponentCount(classProperty);
  const valueType = classProperty.valueType;

  // Normalized integers + non-integer value types are float in-shader.
  if (
    !MetadataComponentType.isIntegerType(valueType) ||
    classProperty.normalized
  ) {
    return floatTypesByComponentCount[componentCount];
  }

  if (MetadataComponentType.isUnsignedIntegerType(valueType)) {
    return uintTypesByComponentCount[componentCount];
  }

  return intTypesByComponentCount[componentCount];
}

/**
 * Returns true when {@link getWgslType} can produce a valid WGSL type for
 * the property (component count is mappable and the resolved type is
 * defined). DP-H46b only transports float-family scalar/vector values; this
 * predicate gates which properties get a generated struct field.
 *
 * @param {MetadataClassProperty} classProperty
 * @returns {boolean}
 * @private
 */
function isWgslCompatible(classProperty) {
  return defined(getWgslType(classProperty));
}

/**
 * Build the WGSL literal for an offset/scale vector value of the given WGSL
 * type. The GLSL path passes offset/scale as uniforms; for DP-H46b the
 * transform is folded into the generated source as a compile-time constant
 * (the asset's offset/scale never changes at runtime for a property
 * attribute, and baking it avoids adding a metadata uniform buffer in this
 * increment). Mirrors `czm_valueTransform`'s `scale * value + offset`.
 *
 * @param {string} wgslType e.g. `f32`, `vec2<f32>`, `vec3<f32>`, `vec4<f32>`
 * @param {number|number[]} value scalar or array from the class definition
 * @returns {string} a WGSL constructor literal, e.g. `vec2<f32>(20.0, 10.0)`
 * @private
 */
function wgslVectorLiteral(wgslType, value) {
  if (wgslType === "f32") {
    const scalar = Array.isArray(value) ? value[0] : value;
    return wgslFloat(scalar);
  }
  // vecN<f32> — spread the components (offset/scale arrays are flat).
  const components = Array.isArray(value) ? value : [value];
  const inner = components.map((c) => wgslFloat(c)).join(", ");
  return `${wgslType}(${inner})`;
}

/**
 * Format a JS number as a WGSL float literal (always has a decimal point so
 * WGSL parses it as `f32`, not an `AbstractInt`).
 *
 * @param {number} n
 * @returns {string}
 * @private
 */
function wgslFloat(n) {
  if (!isFinite(n)) {
    // WGSL has no inf/nan literals; clamp to a large finite value. Metadata
    // offset/scale are never inf in practice — this is a defensive fallback.
    return n > 0 ? "3.4e38" : "-3.4e38";
  }
  const s = String(n);
  // Ensure a decimal point / exponent so the literal is a float.
  return /[.eE]/.test(s) ? s : `${s}.0`;
}

/**
 * Wrap a WGSL value expression with the property's offset/scale transform,
 * if any. Mirrors `addValueTransformUniforms` (MetadataPipelineStage.js:951)
 * — `czm_valueTransform(offset, scale, value) = scale * value + offset` —
 * but bakes offset/scale as WGSL literal constants rather than uniforms.
 *
 * @param {string} valueExpression the raw WGSL value (e.g. an attribute read)
 * @param {string} wgslType the WGSL type of the value
 * @param {MetadataClassProperty} classProperty supplies `offset`/`scale`/
 *   `hasValueTransform`
 * @returns {string} the transformed WGSL expression
 * @private
 */
function applyValueTransform(valueExpression, wgslType, classProperty) {
  if (!classProperty.hasValueTransform) {
    return valueExpression;
  }
  const offsetLiteral = wgslVectorLiteral(wgslType, classProperty.offset);
  const scaleLiteral = wgslVectorLiteral(wgslType, classProperty.scale);
  // scale * value + offset — component-wise for both scalar and vecN<f32>.
  return `(${scaleLiteral} * (${valueExpression}) + ${offsetLiteral})`;
}

/**
 * Compute a stable 32-bit hash of a string (FNV-1a). Used to fold the
 * generated-metadata-WGSL (which is class/schema dependent) into the
 * WebGPU shader-module cache key so two models with different metadata
 * classes don't alias one compiled module. A string hash is sufficient
 * because identical generated WGSL ⇒ identical compiled module, so the hash
 * keys exactly the equivalence classes we care about.
 *
 * @param {string} str
 * @returns {number} an unsigned 32-bit hash
 * @private
 */
function hashStringFNV1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    // 32-bit FNV prime multiply (kept in the 32-bit range via Math.imul).
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export {
  getWgslType,
  isWgslCompatible,
  getComponentCount,
  applyValueTransform,
  wgslVectorLiteral,
  wgslFloat,
  hashStringFNV1a,
  floatTypesByComponentCount,
  intTypesByComponentCount,
  uintTypesByComponentCount,
  matrixTypesByMetadataType,
};
export default {
  getWgslType,
  isWgslCompatible,
  getComponentCount,
  applyValueTransform,
  wgslVectorLiteral,
  wgslFloat,
  hashStringFNV1a,
};
