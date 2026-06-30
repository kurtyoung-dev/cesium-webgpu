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
import Matrix3 from "../../Core/Matrix3.js";
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
 * DP-H46c — build a WGSL `vec2<f32>` texture-coordinate expression for a
 * property TEXTURE, applying an optional KHR_texture_transform 3×3 matrix as a
 * baked compile-time constant (NOT an injected identity matrix — callers skip
 * this entirely when the transform is identity). Mirrors the GLSL
 * `vec2(transform * vec3(texCoord, 1.0))` path in
 * `MetadataPipelineStage.addPropertyTexturePropertyMetadata` (:673).
 *
 * The 3×3 transform is a `Core/Matrix3` stored COLUMN-major (`m[col*3+row]`).
 * WGSL `mat3x3<f32>` constructors also take columns, so the 9 values map
 * directly column-by-column.
 *
 * @param {string} texCoordExpr a WGSL `vec2<f32>` expression (the raw uv)
 * @param {Matrix3|undefined} transform the KHR_texture_transform matrix, or
 *   undefined / identity to skip
 * @returns {string} a WGSL `vec2<f32>` expression
 * @private
 */
function buildTexCoordExpr(texCoordExpr, transform) {
  if (!defined(transform) || Matrix3.equals(transform, Matrix3.IDENTITY)) {
    return texCoordExpr;
  }
  // Matrix3 is column-major: index = column*3 + row.
  const c = [];
  for (let i = 0; i < 9; i++) {
    c.push(wgslFloat(transform[i]));
  }
  const matLiteral = `mat3x3<f32>(${c[0]}, ${c[1]}, ${c[2]}, ${c[3]}, ${c[4]}, ${c[5]}, ${c[6]}, ${c[7]}, ${c[8]})`;
  return `(${matLiteral} * vec3<f32>(${texCoordExpr}, 1.0)).xy`;
}

/**
 * DP-H46c — build a WGSL expression that unpacks a sampled property-TEXTURE
 * value into the property's WGSL type. WGSL texture sampling of an
 * `rgba8unorm` texture returns normalized `[0,1]` floats, exactly like GLSL
 * `texture()`. This is the WGSL sibling of
 * `MetadataClassProperty.unpackTextureInShader` / `unpackTextureInShaderWebGL2`:
 *
 *   - normalized integer / float component types → the sampled normalized
 *     channels ARE the value (`[0,1]`); just swizzle + construct the vecN.
 *   - unnormalized integer component types → rescale each channel to its raw
 *     byte (`u32(channel * 255.0 + 0.5)`) and cast to the WGSL int/uint type.
 *
 * The property's component count drives how many channels feed each component
 * (mirrors `channelsPerComponent` in the GLSL unpacker). DP-H46c supports the
 * common single-byte-per-component case (1 channel per scalar component),
 * which covers every UINT8 property texture in the test corpus; multi-byte
 * components (UINT16/UINT32 packed across channels) are not yet emitted (the
 * `isGpuCompatible` predicate already permits them, but the GLSL-style
 * little-endian channel packing is follow-up — see the open issue in
 * DP-H46_METADATA_DESIGN.md). For those the value falls back to the
 * first-channel scalar so the model still renders.
 *
 * @param {string} sampleExpr a WGSL `vec4<f32>` expression (the texture sample)
 * @param {string} channels the channel swizzle string, e.g. "r", "rg", "rgb"
 * @param {MetadataClassProperty} classProperty supplies type + normalized flag
 * @param {string} wgslType the resolved WGSL type for the property
 * @returns {string} a WGSL expression of type `wgslType`
 * @private
 */
function buildPropertyTextureUnpack(
  sampleExpr,
  channels,
  classProperty,
  wgslType,
) {
  const numChannels = channels.length;
  const componentCount = getComponentCount(classProperty);
  const isFloatFamily = wgslType.indexOf("f32") !== -1;

  // Per-component channel slice (matches GLSL channelsPerComponent). When
  // there's exactly one channel per component (the common UINT8 case) each
  // component reads a single swizzled channel.
  const channelsPerComponent = Math.floor(numChannels / componentCount) || 1;

  // The sampled, swizzled channels as a float scalar / vecN.
  const swizzle = `${sampleExpr}.${channels}`;

  if (isFloatFamily) {
    // Normalized or float property: the normalized [0,1] sample IS the value.
    if (wgslType === "f32") {
      return `${swizzle}`;
    }
    // vecN<f32> — construct from the swizzle (already a vecN<f32>).
    return `${wgslType}(${swizzle})`;
  }

  // Integer family (unnormalized int/uint). Rescale each channel back to its
  // raw byte value, then cast. Single channel-per-component fast path.
  if (channelsPerComponent <= 1) {
    if (componentCount === 1) {
      // Scalar: u32/i32(channel * 255.0 + 0.5)
      return `${wgslType}(${swizzle} * 255.0 + 0.5)`;
    }
    // vecN<int>: round each channel then construct. Build the vecN<f32> of
    // raw bytes, then cast component-wise via the WGSL vector constructor.
    return `${wgslType}(${swizzle} * 255.0 + ${vecSplat(componentCount, "0.5")})`;
  }

  // Multi-byte component (follow-up). Fall back to the first channel's byte
  // so the model renders; flagged as an open issue in the design doc.
  const first = `${sampleExpr}.${channels.charAt(0)}`;
  if (componentCount === 1) {
    return `${wgslType}(${first} * 255.0 + 0.5)`;
  }
  return `${wgslType}()`;
}

/**
 * WGSL `vecN<f32>` splat literal of a single scalar (e.g.
 * `vec3<f32>(0.5, 0.5, 0.5)`), used to add a per-component rounding bias.
 *
 * @param {number} n component count (2..4)
 * @param {string} scalar a WGSL f32 literal
 * @returns {string}
 * @private
 */
function vecSplat(n, scalar) {
  return `vec${n}<f32>(${Array(n).fill(scalar).join(", ")})`;
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
  // DP-H46c — property-texture WGSL builders.
  buildTexCoordExpr,
  buildPropertyTextureUnpack,
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
  buildTexCoordExpr,
  buildPropertyTextureUnpack,
};
