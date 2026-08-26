/**
 * WGSL type maps, value-transform expression builders, and a stable class hash
 * for the WebGPU structural-metadata codegen in `MetadataWGSLPipelineStage`.
 *
 * This is the WGSL sibling of the GLSL type maps that
 * {@link MetadataClassProperty#getGlslType} and `MetadataPipelineStage` rely
 * on, and the mapping rules match theirs:
 *
 *   - float-component types  → `f32` / `vec2<f32>` / `vec3<f32>` / `vec4<f32>`
 *   - signed-int types       → `i32` / `vec2<i32>` / `vec3<i32>` / `vec4<i32>`
 *   - unsigned-int types     → `u32` / `vec2<u32>` / `vec3<u32>` / `vec4<u32>`
 *
 * A property whose value type is an integer but which is `normalized`, and any
 * non-integer type, resolves to the float family, exactly as `getGlslType`
 * does: the normalized integer is decoded to a float on the CPU side before it
 * reaches the shader, so in WGSL such a property is read as `f32`,
 * `vec2<f32>` and so on, never as an integer.
 *
 * Matrix property types (MAT2/MAT3/MAT4) map to `mat2x2<f32>` and friends.
 * These are not carried by the single-scalar transport path, but the type map
 * is complete so `MetadataWGSLPipelineStage` can emit a correct struct field
 * for every GPU-compatible property.
 *
 * @private
 * @module MetadataWGSLHelpers
 */
import defined from "../../Core/defined.js";
import Matrix3 from "../../Core/Matrix3.js";
import MetadataComponentType, {
  ScalarCategories,
} from "../MetadataComponentType.js";
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
 * Resolve the WGSL type for a `MetadataClassProperty`, applying the same rules
 * as `MetadataClassProperty.getGlslType` with WGSL spellings:
 *
 *   - matrix types               → `mat2x2<f32>` / `mat3x3<f32>` / `mat4x4<f32>`
 *   - normalized or non-integer  → float family (`f32`/`vec2<f32>`/...)
 *   - unsigned integer           → uint family (`u32`/`vec2<u32>`/...)
 *   - signed integer             → int family (`i32`/`vec2<i32>`/...)
 *
 * @param {MetadataClassProperty} classProperty
 * @returns {string|undefined} The WGSL type, or `undefined` if the property has
 *   a component count outside [1, 4] for vectors, such as a long fixed array,
 *   which is not transported.
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
 * Returns true when {@link getWgslType} can produce a valid WGSL type for the
 * property, i.e. the component count is mappable and the resolved type is
 * defined. Only float-family scalar and vector values are transported, so this
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
 * Build the WGSL literal for an offset or scale vector value of the given WGSL
 * type.
 *
 * The GLSL path passes offset and scale as uniforms; here the transform is
 * folded into the generated source as a compile-time constant, because a
 * property attribute's offset and scale never change at runtime and baking them
 * avoids a metadata uniform buffer. Mirrors `czm_valueTransform`'s
 * `scale * value + offset`.
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
 * Build a WGSL `vec2<f32>` texture-coordinate expression for a property
 * texture, applying an optional KHR_texture_transform 3x3 matrix as a baked
 * compile-time constant. No identity matrix is ever injected — callers skip
 * this entirely when the transform is identity. Mirrors the GLSL
 * `vec2(transform * vec3(texCoord, 1.0))` path in
 * `MetadataPipelineStage.addPropertyTexturePropertyMetadata`.
 *
 * The 3x3 transform is a `Core/Matrix3` stored column-major (`m[col*3+row]`),
 * and WGSL `mat3x3<f32>` constructors also take columns, so the nine values map
 * directly column by column.
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
 * Build a WGSL expression that unpacks a sampled property-texture value into
 * the property's WGSL type.
 *
 * WGSL texture sampling of an `rgba8unorm` texture returns normalized `[0,1]`
 * floats, exactly like GLSL `texture()`, so this is the WGSL sibling of
 * `MetadataClassProperty.unpackTextureInShader` and
 * `unpackTextureInShaderWebGL2`:
 *
 *   - normalized integer and float component types → the sampled normalized
 *     channels are the value in `[0,1]`; swizzle and construct the vecN.
 *   - unnormalized integer component types → rescale each channel to its raw
 *     byte (`u32(channel * 255.0 + 0.5)`) and cast to the WGSL int or uint type.
 *
 * The property's component count drives how many channels feed each component,
 * mirroring `channelsPerComponent` in the GLSL unpacker:
 *
 *   - one channel per component, the common UINT8 case — each component reads a
 *     single swizzled channel.
 *   - multi-byte components (UINT16, UINT32, INT16, INT32 and FLOAT32, packed
 *     across 2 or 4 channels) — each component's channel slice is reassembled
 *     LSB-first into a raw `u32` bit pattern, using the same little-endian
 *     convention as GLSL `czm_unpackTexture`, then bit-reinterpreted to the
 *     scalar category and optionally normalized.
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

  if (channelsPerComponent <= 1) {
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
    // raw byte value, then cast.
    if (componentCount === 1) {
      // Scalar: u32/i32(channel * 255.0 + 0.5)
      return `${wgslType}(${swizzle} * 255.0 + 0.5)`;
    }
    // vecN<int>: round each channel then construct. Build the vecN<f32> of
    // raw bytes, then cast component-wise via the WGSL vector constructor.
    return `${wgslType}(${swizzle} * 255.0 + ${vecSplat(componentCount, "0.5")})`;
  }

  // Reassemble multi-byte components (UINT16/UINT32/INT16/INT32/
  // FLOAT32 packed across 2/4 channels, keyed off the property's
  // componentType via `channelsPerComponent > 1`). Mirrors WebGL's
  // `MetadataClassProperty.unpackTextureInShader`: for each output component,
  // slice its `channelsPerComponent` channels from the property's channel
  // string, reassemble the raw bits LSB-first (`czm_unpackTexture`
  // convention), then bit-reinterpret / normalize per the scalar category.
  const componentExprs = [];
  for (let c = 0; c < componentCount; c++) {
    const slice = channels.slice(
      c * channelsPerComponent,
      (c + 1) * channelsPerComponent,
    );
    // WGSL vectors support the rgba swizzle set, so the channel-string slice
    // is directly a swizzle (scalar for one channel, vecN<f32> for several).
    const channelExpr = `(${sampleExpr}).${slice}`;
    const rawBits = buildUnpackBitsExpr(channelExpr, slice.length);
    componentExprs.push(buildScalarFromRawBits(rawBits, classProperty));
  }

  if (componentCount === 1) {
    return componentExprs[0];
  }
  // vecN<...> — construct from the per-component scalars.
  return `${wgslType}(${componentExprs.join(", ")})`;
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
 * Build a WGSL expression that reassembles `channelCount` normalized `[0,1]`
 * float channels of an `rgba8unorm` sample back into the raw little-endian
 * `u32` bit pattern they encode.
 *
 * The WGSL sibling of `czm_unpackTexture`: `byte_k = round(channel_k * 255)`,
 * with the bytes combined LSB-first (`byte0 | (byte1<<8) | ...`). It is
 * self-contained, with no shader-chunk dependency, so the generated
 * property-table chunk stands alone.
 *
 * @param {string} channelsExpr a WGSL `f32` / `vec2..4<f32>` expression (the
 *   sampled channel slice in [0,1])
 * @param {number} channelCount how many channels `channelsExpr` carries (1..4)
 * @returns {string} a WGSL `u32` expression
 * @private
 */
function buildUnpackBitsExpr(channelsExpr, channelCount) {
  if (channelCount <= 1) {
    // Single channel — `channelsExpr` is already a scalar f32.
    return `u32((${channelsExpr}) * 255.0 + 0.5)`;
  }
  // Multi-channel — `channelsExpr` is a vecN<f32>. Extract each byte LSB-first
  // and OR-shift. WGSL has no expression-scoped `let`, so the byte extraction is
  // repeated per term (the compiler CSEs the duplicate vector evaluation).
  const perTerm = [];
  for (let i = 0; i < channelCount; i++) {
    const comp = "xyzw".charAt(i);
    const byteExpr = `u32((${channelsExpr}).${comp} * 255.0 + 0.5)`;
    perTerm.push(i === 0 ? byteExpr : `(${byteExpr} << ${i * 8}u)`);
  }
  return `(${perTerm.join(" | ")})`;
}

/**
 * Build the WGSL scalar expression that bit-reinterprets
 * (and optionally normalizes) a reassembled raw `u32` bit pattern into the
 * property's scalar category. Shared by the property-TEXTURE multi-byte
 * unpacker ({@link buildPropertyTextureUnpack}) and the property-TABLE
 * unpacker ({@link buildPropertyTableUnpack}) so both emit the identical
 * convention (the WGSL sibling of GLSL's `uintBitsToScalarType` cast +
 * normalize in `MetadataClassProperty.unpackTextureInShader`):
 *
 *   - FLOAT component types            → `bitcast<f32>(rawBits)`
 *   - signed-integer component types   → `bitcast<i32>(rawBits)`
 *   - unsigned-integer component types → `rawBits` (already u32)
 *   - normalized integer               → `f32(value) * 1/maxValue` (→ float family)
 *
 * The value type is GPU-downcast first (`gpuComponentType`: INT64→INT32, etc.)
 * so the reinterpretation + normalization max match the bytes actually packed.
 *
 * @param {string} rawBitsExpr a WGSL `u32` expression (the reassembled bits)
 * @param {MetadataClassProperty} classProperty supplies valueType + normalized
 * @returns {string} a WGSL scalar expression (`f32`, `i32`, or `u32`)
 * @private
 */
function buildScalarFromRawBits(rawBitsExpr, classProperty) {
  const isNormalized = classProperty.normalized === true;
  const gpuValueType = MetadataComponentType.gpuComponentType(
    classProperty.valueType,
  );
  const category = MetadataComponentType.category(gpuValueType);

  if (isNormalized) {
    // Normalized integer → float in [0,1] (unsigned) / [-1,1] (signed).
    const maxValue = Number(MetadataComponentType.getMaximum(gpuValueType));
    const inv = maxValue !== 0 ? 1.0 / maxValue : 0.0;
    if (category === ScalarCategories.UNSIGNED_INTEGER) {
      return `(f32(${rawBitsExpr}) * ${wgslFloat(inv)})`;
    }
    // Signed: reinterpret then normalize.
    return `(f32(bitcast<i32>(${rawBitsExpr})) * ${wgslFloat(inv)})`;
  }
  if (category === ScalarCategories.FLOAT) {
    return `bitcast<f32>(${rawBitsExpr})`;
  }
  if (category === ScalarCategories.UNSIGNED_INTEGER) {
    return `${rawBitsExpr}`;
  }
  // Signed integer — bit-reinterpret the u32 pattern as i32.
  return `bitcast<i32>(${rawBitsExpr})`;
}

/**
 * Build a WGSL expression that unpacks a property-table `textureLoad` sample —
 * a `vec4<f32>` of normalized rgba8 channels — into the property's WGSL type.
 *
 * The WGSL sibling of `MetadataClassProperty.unpackTextureInShader`: the packed
 * bytes are reassembled into a `u32` per component, little-endian, then
 * bit-reinterpreted to the scalar category and optionally normalized.
 *
 *   - FLOAT component types            → `bitcast<f32>(rawBits)`
 *   - signed-integer component types   → `bitcast<i32>(rawBits)`
 *   - unsigned-integer component types → `rawBits` (already u32)
 *   - normalized integer               → `f32(value) / maxValue` (→ float family)
 *
 * Per-component channel slicing matches the GLSL unpacker
 * (`channelsPerComponent = floor(4 / componentCount)`): a scalar reads all 4
 * channels (a 32-bit value), a vec3 reads one channel per component (three
 * 8-bit values), etc.
 *
 * @param {string} sampleExpr a WGSL `vec4<f32>` expression (the table texel,
 *   `textureLoad(...)`)
 * @param {MetadataClassProperty} classProperty supplies type + normalized flag
 * @param {string} wgslType the resolved WGSL type for the property
 * @returns {string} a WGSL expression of type `wgslType`
 * @private
 */
function buildPropertyTableUnpack(sampleExpr, classProperty, wgslType) {
  // Always 4 channels for property-table textures (NUM_CHANNELS = 4).
  const numChannels = 4;
  const componentCount = getComponentCount(classProperty);
  const channelsPerComponent = Math.floor(numChannels / componentCount) || 1;

  const channelNames = ["x", "y", "z", "w"];

  // Build the per-component scalar expression (already cast/normalized).
  const componentExprs = [];
  for (let c = 0; c < componentCount; c++) {
    const sliceComps = [];
    for (let k = 0; k < channelsPerComponent; k++) {
      sliceComps.push(channelNames[c * channelsPerComponent + k]);
    }
    // The channel slice as an f32 scalar or vecN<f32>.
    let channelExpr;
    if (sliceComps.length === 1) {
      channelExpr = `(${sampleExpr}).${sliceComps[0]}`;
    } else {
      channelExpr = `vec${sliceComps.length}<f32>(${sliceComps
        .map((s) => `(${sampleExpr}).${s}`)
        .join(", ")})`;
    }
    const rawBits = buildUnpackBitsExpr(channelExpr, sliceComps.length);
    // Shared bit reinterpretation / normalization — same helper as the
    // property-TEXTURE multi-byte unpacker, with byte-identical emission.
    componentExprs.push(buildScalarFromRawBits(rawBits, classProperty));
  }

  if (componentCount === 1) {
    return componentExprs[0];
  }
  // vecN<...> — construct from the per-component scalars.
  return `${wgslType}(${componentExprs.join(", ")})`;
}

/**
 * Index a possibly-array offset or scale by component.
 *
 * A `MetadataClassProperty` stores offset and scale array-based, as a flat
 * `number[]`, so component `i` is `value[i]`; a scalar `number` indexes to
 * itself. `getSourceValueStringComponent` reads the same quantity as
 * `metadataProperty.offset[componentName]`, where the metadata property holds
 * object types; this drives off the class property's array form instead, which
 * is the canonical always-present representation, since
 * `MetadataClassProperty.offset` and `scale` default to per-component arrays.
 *
 * @param {number|number[]|undefined} value
 * @param {number} componentIndex 0..3
 * @returns {number}
 * @private
 */
function transformComponentAt(value, componentIndex) {
  if (Array.isArray(value)) {
    if (value.length === 1) {
      return value[0];
    }
    return componentIndex < value.length ? value[componentIndex] : 0;
  }
  return defined(value) ? value : 0;
}

/**
 * Build the WGSL `f32` expression mirroring the GLSL
 * `getSourceValueStringComponent` and `getSourceValueStringScalar` in
 * `DerivedCommand`.
 *
 * Given a raw in-shader metadata component value `valueExpr`, this un-applies
 * the property's offset/scale value transform and un-normalizes it back into
 * the [0,1] range the pick framebuffer's byte channel encodes — the exact
 * inverse of what `MetadataPicking.decodeMetadataValues` re-applies on
 * readback, so the round trip matches WebGL byte for byte.
 *
 *   inverse offset/scale:  `(value - offset) / scale`     (hasValueTransform)
 *   inverse normalization: `value / max(componentType)`   (!classProperty.normalized)
 *
 * `valueExpr` must already be an `f32`; the caller casts integer fields with
 * `f32(...)`. Returns the component's [0,1] channel expression.
 *
 * @param {MetadataClassProperty} classProperty
 * @param {number} componentIndex 0..3 — the component to read from offset/scale
 * @param {string} valueExpr a WGSL `f32` expression (the raw component value)
 * @returns {string} a WGSL `f32` expression in [0,1]
 * @private
 */
function buildPickSourceComponent(classProperty, componentIndex, valueExpr) {
  let result = `f32(${valueExpr})`;
  if (classProperty.hasValueTransform) {
    const offset = transformComponentAt(classProperty.offset, componentIndex);
    const scale = transformComponentAt(classProperty.scale, componentIndex);
    // Mirror GLSL `unapplyValueTransform`: ((value - offset) / scale).
    result = `((${result} - ${wgslFloat(offset)}) / ${wgslFloat(scale)})`;
  }
  if (!classProperty.normalized) {
    // Mirror GLSL `unnormalize`: value / max(componentType). For FLOAT the max
    // is huge (3.4e38) → the byte path is inherently lossy for large floats,
    // EXACTLY as in WebGL, so parity holds. The classProperty.componentType is
    // the un-gpu-downcast type the readback DataView interprets, matching
    // `getMaximum` in the GLSL `unnormalize`.
    const max = Number(
      MetadataComponentType.getMaximum(classProperty.componentType),
    );
    result = `(${result} / ${wgslFloat(max)})`;
  }
  return result;
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
  // Property-texture WGSL builders.
  buildTexCoordExpr,
  buildPropertyTextureUnpack,
  // Property-table WGSL unpacker.
  buildPropertyTableUnpack,
  // Metadata-pick inverse-transform component builder.
  buildPickSourceComponent,
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
  buildPropertyTableUnpack,
  buildPickSourceComponent,
};
