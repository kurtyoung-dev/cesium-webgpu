/**
 * DP-H46b — per-model WGSL codegen for `EXT_structural_metadata`
 * property-ATTRIBUTES. This is the WGSL sibling of the GLSL
 * {@link MetadataPipelineStage}: it iterates the SAME property-attributes a
 * primitive maps to and emits a WGSL string declaring
 *
 *   struct Metadata { <field per GPU-compatible property> };
 *   fn initializeMetadata(metadataValue: f32) -> Metadata { ... }
 *   fn metadataDebugScalar(metadata: Metadata) -> f32 { ... }
 *
 * The string is prepended at the single injection point in
 * `WebGPUModelPipelineCache._getOrCreateShaderModule`, REPLACING the
 * DP-H46a stub that lived behind `//>>ifdef MODEL_HAS_METADATA` in
 * `ModelPBRComplete.wgsl`. The ifdef call site (the debug fragment-color
 * override) is retained and now uses `metadataDebugScalar(metadata)` —
 * an asset-independent accessor the codegen emits — so the proof exercises
 * the GENERATED struct/initializer, not a hand-written stub.
 *
 * Scope (DP-H46b): property-ATTRIBUTES only. Property TEXTURES (DP-H46c)
 * and property TABLES (DP-H46d) are not yet generated. Transport is the
 * DP-H46a single-scalar vertex path (`@location(9) metadataValue: f32`):
 * the `.x` (first) component of the first GPU-compatible property attribute
 * reaches the shader. The generated struct names its field after the REAL
 * resolved property and applies the property's offset/scale via baked WGSL
 * constants (mirroring `czm_valueTransform`). Multi-component / full-vector
 * transport over additional vertex slots is later work (see the open issue
 * in DP-H46_METADATA_DESIGN.md — the single-scalar slot is a DP-H46a
 * limitation, not a DP-H46b regression).
 *
 * Parity: this module runs ONLY when the primitive maps to ≥1 property
 * attribute with readable per-vertex data (the same predicate DP-H46a uses
 * to flip `MODEL_HAS_METADATA`). For non-metadata models it returns
 * `undefined`, no chunk is prepended, the bit stays clear, and the
 * preprocessed WGSL is byte-identical to the pre-metadata path.
 *
 * @private
 * @module MetadataWGSLPipelineStage
 */
import defined from "../../Core/defined.js";
import ModelUtility from "./ModelUtility.js";
import {
  getWgslType,
  isWgslCompatible,
  applyValueTransform,
  hashStringFNV1a,
} from "./MetadataWGSLHelpers.js";

/**
 * Resolve the ordered list of GPU-compatible property-ATTRIBUTE infos for a
 * primitive, mirroring `MetadataPipelineStage.getPropertyAttributesInfo`
 * (MetadataPipelineStage.js:149) — same `property.attribute` →
 * `ModelUtility.getAttributeByName` name resolution + class-property type
 * info. Only properties whose backing glTF attribute is present on the
 * primitive AND whose class type maps to a WGSL type are included (so the
 * generated struct only declares fields the shader can populate).
 *
 * The FIRST element of the returned array is the property DP-H46a's
 * single-scalar transport actually carries (its `.x`), so the codegen and
 * the GPU upload agree on which property the `@location(9)` slot feeds.
 *
 * @param {Model} model
 * @param {ModelComponents.Primitive} primitive
 * @returns {{ propertyId: string, fieldName: string, classProperty: MetadataClassProperty, wgslType: string }[]}
 * @private
 */
function getPropertyAttributeFields(model, primitive) {
  const fields = [];
  const structuralMetadata = model.structuralMetadata;
  if (!defined(structuralMetadata)) {
    return fields;
  }
  const propertyAttributes = structuralMetadata.propertyAttributes;
  if (!defined(propertyAttributes) || propertyAttributes.length === 0) {
    return fields;
  }
  if (!defined(primitive) || !defined(primitive.attributes)) {
    return fields;
  }

  const seenFieldNames = new Set();
  for (let i = 0; i < propertyAttributes.length; i++) {
    const propertyAttribute = propertyAttributes[i];
    const properties = propertyAttribute.properties;
    if (!defined(properties)) {
      continue;
    }
    const entries = Object.entries(properties);
    for (let p = 0; p < entries.length; p++) {
      const [propertyId, property] = entries[p];
      const attributeName = property.attribute;
      if (!defined(attributeName)) {
        continue;
      }
      const modelAttribute = ModelUtility.getAttributeByName(
        primitive,
        attributeName,
      );
      if (!defined(modelAttribute)) {
        continue;
      }
      const classProperty = property.classProperty;
      if (!defined(classProperty) || !isWgslCompatible(classProperty)) {
        continue;
      }
      const wgslType = getWgslType(classProperty);
      // Sanitize the propertyId into a valid WGSL identifier (same intent
      // as ModelUtility.sanitizeGlslIdentifier — WGSL shares the C-style
      // identifier grammar, so the GLSL sanitizer is byte-compatible).
      let fieldName = ModelUtility.sanitizeGlslIdentifier(propertyId);
      // Guard against collisions after sanitization (rare).
      if (seenFieldNames.has(fieldName)) {
        fieldName = `${fieldName}_${i}_${p}`;
      }
      seenFieldNames.add(fieldName);
      fields.push({
        propertyId,
        fieldName,
        classProperty,
        wgslType,
      });
    }
  }
  return fields;
}

/**
 * Build a WGSL expression that constructs a value of `wgslType` whose FIRST
 * component is `scalarExpr` (an `f32`) and whose remaining components are
 * `0.0`. This bridges DP-H46a's single-scalar transport into the real
 * property field type: a `vec2<f32>` property is populated as
 * `vec2<f32>(scalar, 0.0)`, a `mat2x2<f32>` as `mat2x2<f32>(scalar, 0, 0, 0)`,
 * etc. Full per-component transport (additional vertex slots) is later work.
 *
 * @param {string} wgslType
 * @param {string} scalarExpr a WGSL `f32` expression
 * @returns {string}
 * @private
 */
function constructFromScalar(wgslType, scalarExpr) {
  if (wgslType === "f32") {
    return scalarExpr;
  }
  // vecN<f32>
  const vecMatch = /^vec([234])<f32>$/.exec(wgslType);
  if (vecMatch) {
    const n = parseInt(vecMatch[1], 10);
    const comps = [scalarExpr, ...Array(n - 1).fill("0.0")];
    return `${wgslType}(${comps.join(", ")})`;
  }
  // matNxN<f32>
  const matMatch = /^mat([234])x\1<f32>$/.exec(wgslType);
  if (matMatch) {
    const n = parseInt(matMatch[1], 10);
    const total = n * n;
    const comps = [scalarExpr, ...Array(total - 1).fill("0.0")];
    return `${wgslType}(${comps.join(", ")})`;
  }
  // Integer families (unreachable from the float-only transport path today,
  // but keep the codegen total): construct from a converted scalar.
  return `${wgslType}()`;
}

/**
 * Build a WGSL expression reading the first scalar component out of a value
 * of `wgslType` (the inverse of {@link constructFromScalar}, used by the
 * debug accessor to recover the proven scalar in `[0,1]` regardless of the
 * resolved property's vector/matrix shape).
 *
 * @param {string} fieldExpr e.g. `metadata.temperatures`
 * @param {string} wgslType
 * @returns {string} a WGSL `f32` expression
 * @private
 */
function firstComponentExpr(fieldExpr, wgslType) {
  if (wgslType === "f32") {
    return fieldExpr;
  }
  if (/^vec[234]<f32>$/.test(wgslType)) {
    return `${fieldExpr}.x`;
  }
  if (/^mat[234]x[234]<f32>$/.test(wgslType)) {
    // mat[c][r] — first column, first row.
    return `${fieldExpr}[0][0]`;
  }
  // Integer field — cast to f32 for the debug visualization.
  return `f32(${fieldExpr})`;
}

/**
 * Generate the WGSL metadata chunk for a primitive, or `undefined` when the
 * primitive carries no GPU-compatible property attribute.
 *
 * The generated chunk:
 *   1. `struct Metadata { <field per property> }`
 *   2. `fn initializeMetadata(metadataValue: f32) -> Metadata` — assigns the
 *      transported scalar (offset/scale applied) to the FIRST property's
 *      field; remaining fields are zero-initialized (their per-vertex data is
 *      not transported in DP-H46b).
 *   3. `fn metadataDebugScalar(metadata: Metadata) -> f32` — returns the RAW
 *      transported scalar in `[0,1]` (the same value DP-H46a's stub proved),
 *      so the `MODEL_HAS_METADATA` debug fragment-color override renders the
 *      identical gradient — now sourced through the generated struct.
 *
 * @param {Model} model
 * @param {ModelComponents.Primitive} primitive
 * @returns {{ wgsl: string, classHash: number, fields: object[] }|undefined}
 * @private
 */
function generateMetadataWGSL(model, primitive) {
  const fields = getPropertyAttributeFields(model, primitive);
  if (fields.length === 0) {
    return undefined;
  }

  // The transported property is the FIRST resolvable field — matches
  // `WebGPUModelMetadata.resolveMetadataAttributeData`, which extracts the
  // `.x` of the first GPU-compatible property attribute into vertex slot 9.
  const transported = fields[0];

  const lines = [];
  lines.push(
    "// DP-H46b — GENERATED structural-metadata chunk (property attributes).",
  );
  lines.push("// Replaces the DP-H46a stub; declared real per metadata class.");
  lines.push("struct Metadata {");
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    lines.push(`  ${f.fieldName}: ${f.wgslType},`);
  }
  lines.push("};");
  lines.push("");
  lines.push("fn initializeMetadata(metadataValue: f32) -> Metadata {");
  lines.push("  var metadata: Metadata;");
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f === transported) {
      // Apply the property's offset/scale to the transported scalar, then
      // widen it into the field's vector/matrix shape (first component).
      const transformed = applyValueTransform(
        "metadataValue",
        "f32",
        f.classProperty,
      );
      const constructed = constructFromScalar(f.wgslType, `(${transformed})`);
      lines.push(`  metadata.${f.fieldName} = ${constructed};`);
    } else {
      // Non-transported fields zero-initialize (per-vertex data not carried
      // in DP-H46b's single-scalar path).
      lines.push(`  metadata.${f.fieldName} = ${zeroLiteral(f.wgslType)};`);
    }
  }
  lines.push("  return metadata;");
  lines.push("}");
  lines.push("");
  // Asset-independent proof accessor — returns the RAW transported scalar
  // (pre-transform), matching DP-H46a's stub output so the debug PNG is
  // directly comparable. The body still reads through the generated struct
  // field to prove the codegen wired the value end-to-end.
  const rawScalar = firstComponentExpr(
    `metadata.${transported.fieldName}`,
    transported.wgslType,
  );
  // Recover the raw [0,1] value by inverting the (baked) offset/scale so the
  // debug gradient is identical to DP-H46a regardless of the property's
  // offset/scale. When the property has no transform, this is the value
  // directly.
  const debugBody = invertValueTransform(rawScalar, transported.classProperty);
  lines.push("fn metadataDebugScalar(metadata: Metadata) -> f32 {");
  lines.push(`  return ${debugBody};`);
  lines.push("}");
  lines.push("");

  const wgsl = lines.join("\n");

  // The cache-key hash keys the equivalence class of generated modules. The
  // generated WGSL string is the canonical, complete fingerprint (it folds
  // in every field name, type, and baked transform), so hashing it is both
  // stable and exact: identical WGSL ⇒ identical compiled module.
  const classHash = hashStringFNV1a(wgsl);

  return { wgsl, classHash, fields };
}

/**
 * WGSL zero literal for a field type (used to default non-transported
 * fields).
 *
 * @param {string} wgslType
 * @returns {string}
 * @private
 */
function zeroLiteral(wgslType) {
  if (wgslType === "f32") {
    return "0.0";
  }
  if (
    /^vec[234]<f32>$/.test(wgslType) ||
    /^mat[234]x[234]<f32>$/.test(wgslType)
  ) {
    return `${wgslType}()`;
  }
  if (/^vec[234]<[iu]32>$/.test(wgslType)) {
    return `${wgslType}()`;
  }
  return `${wgslType}()`;
}

/**
 * Build a WGSL `f32` expression that recovers the RAW transported scalar in
 * `[0,1]` from a (possibly offset/scaled) field's first component, by
 * inverting `czm_valueTransform` — `raw = (transformed - offset) / scale`.
 * Mirrors `getSourceValueStringComponent`'s inverse (the value DP-H46a's
 * stub passed through untransformed). When the property has no value
 * transform, the field already holds the raw value.
 *
 * @param {string} valueExpr a WGSL `f32` (the field's first component)
 * @param {MetadataClassProperty} classProperty
 * @returns {string}
 * @private
 */
function invertValueTransform(valueExpr, classProperty) {
  if (!classProperty.hasValueTransform) {
    return valueExpr;
  }
  // offset/scale may be scalar or array; the first component drives the
  // first scalar's inverse.
  const offset = firstScalar(classProperty.offset);
  const scale = firstScalar(classProperty.scale);
  if (scale === 0) {
    return valueExpr;
  }
  return `((${valueExpr} - ${floatLit(offset)}) / ${floatLit(scale)})`;
}

function firstScalar(v) {
  if (Array.isArray(v)) {
    return v.length > 0 ? v[0] : 0;
  }
  return defined(v) ? v : 0;
}

function floatLit(n) {
  const s = String(n);
  return /[.eE]/.test(s) ? s : `${s}.0`;
}

/**
 * Returns `true` when the primitive maps to ≥1 GPU-compatible property
 * attribute (the codegen would produce a chunk). Cheap presence predicate
 * for callers that only need the gate.
 *
 * @param {Model} model
 * @param {ModelComponents.Primitive} primitive
 * @returns {boolean}
 * @private
 */
function primitiveHasMetadataWGSL(model, primitive) {
  return getPropertyAttributeFields(model, primitive).length > 0;
}

export {
  generateMetadataWGSL,
  getPropertyAttributeFields,
  primitiveHasMetadataWGSL,
};
export default {
  generateMetadataWGSL,
  getPropertyAttributeFields,
  primitiveHasMetadataWGSL,
};
