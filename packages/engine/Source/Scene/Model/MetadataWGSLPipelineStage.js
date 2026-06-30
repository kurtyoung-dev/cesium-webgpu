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
 * Scope: property-ATTRIBUTES (DP-H46b) + property TEXTURES (DP-H46c).
 * Property TABLES (DP-H46d) are not yet generated.
 *
 * Property ATTRIBUTES (DP-H46b): transport is the DP-H46a single-scalar
 * vertex path (`@location(9) metadataValue: f32`): the `.x` (first) component
 * of the first GPU-compatible property attribute reaches the shader. The
 * generated struct names its field after the REAL resolved property and
 * applies the property's offset/scale via baked WGSL constants (mirroring
 * `czm_valueTransform`). Multi-component / full-vector transport over
 * additional vertex slots is later work (see DP-H46_METADATA_DESIGN.md).
 *
 * Property TEXTURES (DP-H46c): sampled in the FRAGMENT stage at the property's
 * interpolated `texCoord`. The chunk declares one (texture, sampler) binding
 * pair per UNIQUE physical property texture — binding numbers from the SHARED
 * `WebGPUModelMetadata.resolvePropertyTextureLayout`, so they match the BGL
 * manifest the renderer allocates — and `initializeMetadata` does
 * `textureSample(...)` at the property's texCoord (optional baked
 * KHR_texture_transform 3×3 multiply, skipped for identity), channel swizzle,
 * `unpackTextureInShader`-equivalent unpacking, then offset/scale. Mirrors
 * `MetadataPipelineStage.addPropertyTexturePropertyMetadata` (:622).
 *
 * Parity: this module runs ONLY when the primitive maps to ≥1 property
 * attribute with readable per-vertex data OR ≥1 GPU-compatible property
 * texture (the same predicates DP-H46a/c use to flip `MODEL_HAS_METADATA` /
 * `MODEL_HAS_PROPERTY_TEXTURES`). For non-metadata models (and attribute-only
 * models w.r.t. the property-texture path) it returns `undefined` / emits no
 * property-texture bindings, no chunk is prepended where unneeded, the bit
 * stays clear, and the preprocessed WGSL is byte-identical to the pre-metadata
 * path.
 *
 * @private
 * @module MetadataWGSLPipelineStage
 */
import defined from "../../Core/defined.js";
import ModelUtility from "./ModelUtility.js";
import MetadataType from "../MetadataType.js";
import {
  resolvePropertyTextureLayout,
  resolvePropertyTableLayout,
} from "../../Renderer/WebGPU/WebGPUModelMetadata.js";
import {
  getWgslType,
  isWgslCompatible,
  applyValueTransform,
  hashStringFNV1a,
  buildTexCoordExpr,
  buildPropertyTextureUnpack,
  buildPropertyTableUnpack,
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
 * DP-H46c — build the per-property-TEXTURE accessor info the codegen needs:
 * the resolved WGSL type, sanitized field name, and the shared layout entry
 * (binding numbers, channels, texCoord, transform). The layout is
 * {@link resolvePropertyTextureLayout}, the SAME structure the binding side
 * consumes, so the generated `@binding` numbers match the BGL exactly.
 *
 * @param {Model} model
 * @param {ModelComponents.Primitive} primitive
 * @param {Set<string>} usedFieldNames field names already taken by property
 *   attributes (so a texture property colliding on its sanitized name is
 *   disambiguated)
 * @returns {{ layout: object, fields: object[] }|undefined}
 * @private
 */
function getPropertyTextureFields(model, primitive, usedFieldNames) {
  const layout = resolvePropertyTextureLayout(model, primitive);
  if (!defined(layout)) {
    return undefined;
  }
  const fields = [];
  for (let i = 0; i < layout.properties.length; i++) {
    const prop = layout.properties[i];
    const wgslType = getWgslType(prop.classProperty);
    if (!defined(wgslType)) {
      continue;
    }
    let fieldName = ModelUtility.sanitizeGlslIdentifier(prop.propertyId);
    if (usedFieldNames.has(fieldName)) {
      fieldName = `${fieldName}_pt_${i}`;
    }
    usedFieldNames.add(fieldName);
    fields.push({
      propertyId: prop.propertyId,
      fieldName,
      classProperty: prop.classProperty,
      wgslType,
      textureBinding: prop.textureBinding,
      samplerBinding: prop.samplerBinding,
      channels: prop.channels,
      texCoord: prop.texCoord,
      transform: prop.transform,
      hasTransform: prop.hasTransform,
    });
  }
  if (fields.length === 0) {
    return undefined;
  }
  return { layout, fields };
}

/**
 * DP-H46d — build the per-property-TABLE accessor info the codegen needs: the
 * resolved WGSL type, sanitized field name, and the shared layout entry
 * (texture binding, per-property `propertyInfoIndex` row, feature-ID variable).
 * The layout is {@link resolvePropertyTableLayout}, the SAME structure the
 * binding side consumes, so the generated `@binding` number + `propertyInfoIndex`
 * rows match the packed texture exactly.
 *
 * @param {Model} model
 * @param {ModelComponents.Primitive} primitive
 * @param {Set<string>} usedFieldNames field names already taken by property
 *   attributes / textures (so a table property colliding on its sanitized name
 *   is disambiguated)
 * @returns {{ layout: object, fields: object[] }|undefined}
 * @private
 */
function getPropertyTableFields(model, primitive, usedFieldNames) {
  const layout = resolvePropertyTableLayout(model, primitive);
  if (!defined(layout)) {
    return undefined;
  }
  const fields = [];
  for (let i = 0; i < layout.properties.length; i++) {
    const prop = layout.properties[i];
    const wgslType = getWgslType(prop.classProperty);
    if (!defined(wgslType)) {
      continue;
    }
    let fieldName = ModelUtility.sanitizeGlslIdentifier(prop.propertyId);
    if (usedFieldNames.has(fieldName)) {
      fieldName = `${fieldName}_tbl_${i}`;
    }
    usedFieldNames.add(fieldName);
    fields.push({
      propertyId: prop.propertyId,
      fieldName,
      classProperty: prop.classProperty,
      // The property whose offset/scale value-transform should apply — the
      // per-table-property instance when present, else the class property
      // (mirrors GLSL `property ?? classProperty`).
      transformProperty: prop.transformProperty ?? prop.classProperty,
      wgslType,
      propertyInfoIndex: prop.propertyInfoIndex,
    });
  }
  if (fields.length === 0) {
    return undefined;
  }
  return { layout, fields };
}

/**
 * Generate the WGSL metadata chunk for a primitive, or `undefined` when the
 * primitive carries no GPU-compatible property attribute OR property texture
 * OR property table.
 *
 * The generated chunk:
 *   1. (DP-H46c) `@group(1) @binding(N) var propTexK: texture_2d<f32>;` +
 *      sampler declarations for each unique physical property TEXTURE; and
 *      (DP-H46d) `@group(1) @binding(44) var metadataPropertyTableTexture:
 *      texture_2d<f32>;` for the single tightly-packed property TABLE — the
 *      binding numbers match the BGL manifest the renderer allocates.
 *   2. `<type>MetadataClass` / `<type>MetadataStatistics` structs (DP-H46d) for
 *      each distinct property type (mirrors `declareMetadataTypeStructs`), then
 *      `struct Metadata { <field per property attribute + texture + table> }`.
 *   3. `fn initializeMetadata(metadataValue: f32, texCoord0: vec2<f32>,
 *      texCoord1: vec2<f32>, metadataFeatureId: f32) -> Metadata` — assigns the
 *      property-ATTRIBUTE transported scalar (offset/scale applied), SAMPLES
 *      each property TEXTURE at its texCoord (DP-H46c), and `textureLoad`s each
 *      property TABLE row at `(featureId, propertyInfoIndex)` then unpacks +
 *      offset/scales (DP-H46d).
 *   4. `fn metadataDebugScalar(metadata: Metadata) -> f32` — returns a scalar
 *      proof value in `[0,1]`: the RAW transported attribute scalar when a
 *      property attribute exists, else the first property-texture/-table
 *      property's first component (so the debug override renders a value that
 *      VARIES with the metadata).
 *
 * @param {Model} model
 * @param {ModelComponents.Primitive} primitive
 * @returns {{ wgsl: string, classHash: number, fields: object[],
 *   propertyTextureLayout: object|undefined,
 *   propertyTableLayout: object|undefined }|undefined}
 * @private
 */
function generateMetadataWGSL(model, primitive) {
  const attributeFields = getPropertyAttributeFields(model, primitive);
  const usedFieldNames = new Set(attributeFields.map((f) => f.fieldName));
  const textureResult = getPropertyTextureFields(
    model,
    primitive,
    usedFieldNames,
  );
  const textureFields = textureResult?.fields ?? [];
  const propertyTextureLayout = textureResult?.layout;
  // DP-H46d — property TABLES. Resolved AFTER attributes + textures so the
  // table field names disambiguate against any earlier collision.
  const tableResult = getPropertyTableFields(model, primitive, usedFieldNames);
  const tableFields = tableResult?.fields ?? [];
  const propertyTableLayout = tableResult?.layout;

  if (
    attributeFields.length === 0 &&
    textureFields.length === 0 &&
    tableFields.length === 0
  ) {
    return undefined;
  }

  // The transported attribute property is the FIRST resolvable attribute field
  // — matches `WebGPUModelMetadata.resolveMetadataAttributeData`, which
  // extracts the `.x` of the first GPU-compatible property attribute into
  // vertex slot 9. May be undefined for texture-/table-only models.
  const transported =
    attributeFields.length > 0 ? attributeFields[0] : undefined;

  const lines = [];
  lines.push(
    "// DP-H46b/c/d — GENERATED structural-metadata chunk (property attributes + textures + tables).",
  );
  lines.push("// Replaces the DP-H46a stub; declared real per metadata class.");

  // 1a. Property-texture binding declarations (DP-H46c). One texture per unique
  //     physical property texture + ONE shared sampler — binding numbers come
  //     from the shared layout so they match the BGL the renderer allocates.
  if (defined(propertyTextureLayout)) {
    for (let i = 0; i < propertyTextureLayout.textures.length; i++) {
      const t = propertyTextureLayout.textures[i];
      lines.push(
        `@group(1) @binding(${t.textureBinding}) var metadataPropertyTexture${i}: texture_2d<f32>;`,
      );
    }
    // Single shared sampler for every property texture (all share the same
    // samplerBinding from the layout).
    const samplerBinding = propertyTextureLayout.textures[0].samplerBinding;
    lines.push(
      `@group(1) @binding(${samplerBinding}) var metadataPropertySampler: sampler;`,
    );
    lines.push("");
  }

  // 1b. Property-TABLE binding declaration (DP-H46d). ONE tightly-packed RGBA8
  //     texture (rows = properties, columns = features). Read via `textureLoad`
  //     (no sampler), but the BGL also binds a sampler placeholder at the next
  //     slot — declare it so the binding shape matches (the FS never samples it).
  if (defined(propertyTableLayout)) {
    lines.push(
      `@group(1) @binding(${propertyTableLayout.textureBinding}) var metadataPropertyTableTexture: texture_2d<f32>;`,
    );
    lines.push(
      `@group(1) @binding(${propertyTableLayout.samplerBinding}) var metadataPropertyTableSampler: sampler;`,
    );
    lines.push("");
  }

  // 2a. <type>MetadataClass / <type>MetadataStatistics structs (DP-H46d).
  //     Scaffolding for the CustomShader / pickMetadata consumers (DP-H46e/f);
  //     declared now so the generated module already carries them. Mirrors
  //     `MetadataPipelineStage.declareMetadataTypeStructs` (field renamings
  //     noData/default→noData/defaultValue, min/max→minValue/maxValue, and the
  //     int→float statistics fields).
  const allClassFields = attributeFields
    .concat(textureFields)
    .concat(tableFields);
  emitMetadataTypeStructs(lines, allClassFields);

  // 2b. struct Metadata — attribute fields, then texture fields, then table.
  lines.push("struct Metadata {");
  for (let i = 0; i < attributeFields.length; i++) {
    lines.push(
      `  ${attributeFields[i].fieldName}: ${attributeFields[i].wgslType},`,
    );
  }
  for (let i = 0; i < textureFields.length; i++) {
    lines.push(
      `  ${textureFields[i].fieldName}: ${textureFields[i].wgslType},`,
    );
  }
  for (let i = 0; i < tableFields.length; i++) {
    lines.push(`  ${tableFields[i].fieldName}: ${tableFields[i].wgslType},`);
  }
  lines.push("};");
  lines.push("");

  // 3. initializeMetadata. Texture sampling needs the interpolated texCoords,
  //    so the signature carries texCoord0 + texCoord1 (texCoord1 falls back to
  //    texCoord0 at the call site when the primitive lacks TEXCOORD_1).
  //    `metadataValue` is the attribute vertex scalar (0.0 for texture-/table-
  //    only). `metadataFeatureId` is the per-vertex feature ID (flat) that
  //    indexes the property-table COLUMN (0.0 when the primitive has no table).
  lines.push(
    "fn initializeMetadata(metadataValue: f32, metadataTexCoord0: vec2<f32>, metadataTexCoord1: vec2<f32>, metadataFeatureId: f32) -> Metadata {",
  );
  lines.push("  var metadata: Metadata;");
  // Attribute fields.
  for (let i = 0; i < attributeFields.length; i++) {
    const f = attributeFields[i];
    if (f === transported) {
      const transformed = applyValueTransform(
        "metadataValue",
        "f32",
        f.classProperty,
      );
      const constructed = constructFromScalar(f.wgslType, `(${transformed})`);
      lines.push(`  metadata.${f.fieldName} = ${constructed};`);
    } else {
      lines.push(`  metadata.${f.fieldName} = ${zeroLiteral(f.wgslType)};`);
    }
  }
  // Texture fields (DP-H46c) — sample → swizzle/unpack → offset/scale.
  for (let i = 0; i < textureFields.length; i++) {
    const f = textureFields[i];
    const slot = textureSlotForBinding(propertyTextureLayout, f.textureBinding);
    const rawTexCoord =
      f.texCoord === 1 ? "metadataTexCoord1" : "metadataTexCoord0";
    const texCoordExpr = buildTexCoordExpr(rawTexCoord, f.transform);
    // `textureSampleLevel(..., 0.0)` (explicit LOD 0, no implicit derivatives)
    // instead of `textureSample`: (1) WGSL forbids `textureSample` outside
    // UNIFORM control flow — the metadata debug call site (and any future
    // styling/CustomShader consumer) samples inside conditional branches, which
    // is non-uniform; (2) metadata is DATA, not color — mipmapping a packed
    // byte texture would corrupt the value, so the base level is the correct
    // (and only sane) sample. Matches WebGL's effective behaviour (property
    // textures use NEAREST + no mip in the GLSL path).
    const sampleExpr = `textureSampleLevel(metadataPropertyTexture${slot}, metadataPropertySampler, ${texCoordExpr}, 0.0)`;
    const unpacked = buildPropertyTextureUnpack(
      `(${sampleExpr})`,
      f.channels,
      f.classProperty,
      f.wgslType,
    );
    const transformed = applyValueTransform(
      unpacked,
      f.wgslType,
      f.classProperty,
    );
    lines.push(`  metadata.${f.fieldName} = ${transformed};`);
  }
  // Table fields (DP-H46d) — textureLoad(table, (featureId, row)) → RGBA→u32
  // little-endian unpack → bit-reinterpret/normalize → offset/scale.
  if (defined(propertyTableLayout) && tableFields.length > 0) {
    // The feature ID indexes the table COLUMN; the row is the per-property
    // `propertyInfoIndex`. `textureLoad` ignores filtering (raw texel fetch),
    // matching the GLSL `texelFetch(table, ivec2(featureId, propertyInfoIndex))`.
    lines.push("  let metadataTableCol = i32(metadataFeatureId);");
    for (let i = 0; i < tableFields.length; i++) {
      const f = tableFields[i];
      const loadExpr = `textureLoad(metadataPropertyTableTexture, vec2<i32>(metadataTableCol, ${f.propertyInfoIndex}), 0)`;
      const unpacked = buildPropertyTableUnpack(
        `(${loadExpr})`,
        f.classProperty,
        f.wgslType,
      );
      // Value transform from the per-table-property instance (overrides the
      // class offset/scale), matching GLSL `property ?? classProperty`.
      const transformed = applyValueTransform(
        unpacked,
        f.wgslType,
        f.transformProperty,
      );
      lines.push(`  metadata.${f.fieldName} = ${transformed};`);
    }
  }
  lines.push("  return metadata;");
  lines.push("}");
  lines.push("");

  // 4. metadataDebugScalar — prefer the attribute scalar (DP-H46a/b parity);
  //    else the first texture property, else the first table property. The
  //    result is mapped to [0,1] so the FS debug override paints a gradient
  //    that VARIES with the resolved metadata value.
  let debugBody;
  if (defined(transported)) {
    const rawScalar = firstComponentExpr(
      `metadata.${transported.fieldName}`,
      transported.wgslType,
    );
    debugBody = invertValueTransform(rawScalar, transported.classProperty);
  } else if (textureFields.length > 0) {
    const proofField = textureFields[0];
    const rawScalar = firstComponentExpr(
      `metadata.${proofField.fieldName}`,
      proofField.wgslType,
    );
    // Property-TEXTURE float values are normalized samples already in [0,1];
    // integer values are the raw byte → rescale to [0,1] for the gradient.
    const inverted = invertValueTransform(rawScalar, proofField.classProperty);
    const isFloat = proofField.wgslType.indexOf("f32") !== -1;
    debugBody = isFloat
      ? inverted
      : `clamp(f32(${inverted}) / 255.0, 0.0, 1.0)`;
  } else {
    // Property-TABLE proof. Unlike property textures, table float values are
    // the RAW property value (e.g. building heights 78..86), not normalized —
    // so map them into a visible [0,1] gradient with `fract(abs(...))` (per-
    // feature distinct values → distinct fractional parts → distinct colors).
    // Integers are taken modulo 256 → [0,1] the same way the texture path does.
    const proofField = tableFields[0];
    const rawScalar = firstComponentExpr(
      `metadata.${proofField.fieldName}`,
      proofField.wgslType,
    );
    const isFloat = proofField.wgslType.indexOf("f32") !== -1;
    debugBody = isFloat
      ? `fract(abs(${rawScalar}))`
      : `clamp(f32(${rawScalar} % 256) / 255.0, 0.0, 1.0)`;
  }
  lines.push("fn metadataDebugScalar(metadata: Metadata) -> f32 {");
  lines.push(`  return ${debugBody};`);
  lines.push("}");
  lines.push("");

  const wgsl = lines.join("\n");

  // The cache-key hash keys the equivalence class of generated modules. The
  // generated WGSL string is the canonical, complete fingerprint (it folds in
  // every field name, type, baked transform, the property-texture binding
  // numbers, AND the property-table rows), so hashing it is both stable and
  // exact: identical WGSL ⇒ identical compiled module.
  const classHash = hashStringFNV1a(wgsl);

  return {
    wgsl,
    classHash,
    fields: attributeFields,
    propertyTextureLayout,
    propertyTableLayout,
  };
}

/**
 * DP-H46d — field renamings + statistics fields for the `<type>MetadataClass` /
 * `<type>MetadataStatistics` structs, mirroring
 * `MetadataPipelineStage.METADATA_CLASS_FIELDS` / `METADATA_STATISTICS_FIELDS`.
 * `floatStat: true` marks a statistics field that is ALWAYS float-component even
 * for integer property types (mean / standardDeviation / variance).
 * @private
 */
const METADATA_CLASS_FIELD_NAMES = [
  "noData",
  "defaultValue",
  "minValue",
  "maxValue",
];
const METADATA_STATISTICS_FIELD_DEFS = [
  { name: "minValue", floatStat: false },
  { name: "maxValue", floatStat: false },
  { name: "mean", floatStat: true },
  { name: "median", floatStat: false },
  { name: "standardDeviation", floatStat: true },
  { name: "variance", floatStat: true },
  { name: "sum", floatStat: false },
];

/**
 * DP-H46d — convert a WGSL type with integer components to the float-component
 * type of the same dimension (mirrors `convertToFloatComponents`), used for the
 * always-float MetadataStatistics fields. f32 / vecN<f32> pass through.
 * @param {string} wgslType
 * @returns {string}
 * @private
 */
function wgslToFloatComponents(wgslType) {
  if (wgslType === "i32" || wgslType === "u32") {
    return "f32";
  }
  const m = /^vec([234])<[iu]32>$/.exec(wgslType);
  if (m) {
    return `vec${m[1]}<f32>`;
  }
  return wgslType;
}

/**
 * DP-H46d — build a WGSL-safe struct-name fragment from a WGSL type (e.g.
 * `f32` → `f32`, `vec3<u32>` → `vec3u32`, `mat2x2<f32>` → `mat2x2f32`). The
 * angle brackets are stripped so the result is a valid identifier prefix for
 * the `<type>MetadataClass` / `<type>MetadataStatistics` struct names.
 * @param {string} wgslType
 * @returns {string}
 * @private
 */
function wgslTypeTag(wgslType) {
  return wgslType.replace(/[<>]/g, "");
}

/**
 * DP-H46d — emit `<type>MetadataClass` + `<type>MetadataStatistics` struct
 * declarations for each DISTINCT property type across all property infos,
 * mirroring `MetadataPipelineStage.declareMetadataTypeStructs`. These are
 * scaffolding for the CustomShader / pickMetadata consumers (DP-H46e/f) — the
 * display proof reads `Metadata` directly — but the generated module declares
 * them now so the consumer half has the struct types available. Statistics
 * structs are emitted only for non-ENUM types (ENUMs carry an unimplemented
 * "occurrences" statistic in the GLSL path too).
 *
 * @param {string[]} lines the WGSL line buffer to append to
 * @param {object[]} propertyInfos all property infos (attribute + texture +
 *   table) — each carries `{ wgslType, classProperty }`
 * @private
 */
function emitMetadataTypeStructs(lines, propertyInfos) {
  const classTypes = new Set();
  const statisticsTypes = new Set();
  for (let i = 0; i < propertyInfos.length; i++) {
    const info = propertyInfos[i];
    const wgslType = info.wgslType;
    classTypes.add(wgslType);
    // ENUM properties don't get a statistics struct (matches the GLSL path).
    if (info.classProperty.type !== MetadataType.ENUM) {
      statisticsTypes.add(wgslType);
    }
  }

  for (const wgslType of classTypes) {
    const structName = `${wgslTypeTag(wgslType)}MetadataClass`;
    lines.push(`struct ${structName} {`);
    for (let i = 0; i < METADATA_CLASS_FIELD_NAMES.length; i++) {
      lines.push(`  ${METADATA_CLASS_FIELD_NAMES[i]}: ${wgslType},`);
    }
    lines.push("};");
    lines.push("");
  }

  for (const wgslType of statisticsTypes) {
    const structName = `${wgslTypeTag(wgslType)}MetadataStatistics`;
    const floatType = wgslToFloatComponents(wgslType);
    lines.push(`struct ${structName} {`);
    for (let i = 0; i < METADATA_STATISTICS_FIELD_DEFS.length; i++) {
      const f = METADATA_STATISTICS_FIELD_DEFS[i];
      const fieldType = f.floatStat ? floatType : wgslType;
      lines.push(`  ${f.name}: ${fieldType},`);
    }
    lines.push("};");
    lines.push("");
  }
}

/**
 * Map a property-texture binding number back to its slot index (0..N-1) in the
 * layout's `textures` array, so the generated sampling code references the
 * matching `metadataPropertyTexture${slot}` / `metadataPropertySampler${slot}`
 * declaration.
 *
 * @param {object} layout the property-texture layout
 * @param {number} textureBinding the property's texture binding number
 * @returns {number}
 * @private
 */
function textureSlotForBinding(layout, textureBinding) {
  for (let i = 0; i < layout.textures.length; i++) {
    if (layout.textures[i].textureBinding === textureBinding) {
      return i;
    }
  }
  return 0;
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
 * attribute OR property texture OR property table (the codegen would produce a
 * chunk). Cheap presence predicate for callers that only need the gate.
 *
 * @param {Model} model
 * @param {ModelComponents.Primitive} primitive
 * @returns {boolean}
 * @private
 */
function primitiveHasMetadataWGSL(model, primitive) {
  if (getPropertyAttributeFields(model, primitive).length > 0) {
    return true;
  }
  if (defined(resolvePropertyTextureLayout(model, primitive))) {
    return true;
  }
  return defined(resolvePropertyTableLayout(model, primitive));
}

export {
  generateMetadataWGSL,
  getPropertyAttributeFields,
  getPropertyTextureFields,
  getPropertyTableFields,
  primitiveHasMetadataWGSL,
};
export default {
  generateMetadataWGSL,
  getPropertyAttributeFields,
  getPropertyTextureFields,
  getPropertyTableFields,
  primitiveHasMetadataWGSL,
};
