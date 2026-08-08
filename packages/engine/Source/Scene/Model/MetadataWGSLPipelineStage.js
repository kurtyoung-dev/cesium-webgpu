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
 * Scope: property-ATTRIBUTES (DP-H46b) + property TEXTURES (DP-H46c) +
 * property TABLES (DP-H46d, keyed by attribute / texture / implicit
 * feature-ID sources — METADATA-TABLE-SOURCES; INSTANCE-sourced feature IDs —
 * EXT_mesh_gpu_instancing + EXT_instance_features — via
 * PARITY-METADATA-TABLE-INSTANCE-SOURCE, threaded through the optional
 * `runtimeNode` param).
 *
 * Property ATTRIBUTES (DP-H46b + METADATA-MULTICOMPONENT): transport is the
 * vec4 vertex path (`@location(9) metadataValue: vec4<f32>`): up to FOUR
 * components of the first GPU-compatible property attribute reach the shader
 * (SCALAR pads, VEC2/3/4 and MAT2 transport fully; MAT3/MAT4 still carry only
 * their first four elements). The generated struct names its field after the
 * REAL resolved property and applies the property's offset/scale via baked
 * WGSL constants component-wise (mirroring `czm_valueTransform`).
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
import MetadataComponentType from "../MetadataComponentType.js";
import MetadataType from "../MetadataType.js";
import {
  resolvePropertyTextureLayout,
  resolvePropertyTableLayout,
  resolveMetadataAttributeData,
} from "../../Renderer/WebGPU/WebGPUModelMetadata.js";
import {
  getWgslType,
  isWgslCompatible,
  applyValueTransform,
  hashStringFNV1a,
  buildTexCoordExpr,
  buildPropertyTextureUnpack,
  buildPropertyTableUnpack,
  buildPickSourceComponent,
  getComponentCount,
} from "./MetadataWGSLHelpers.js";

/**
 * One row of the generated `struct Metadata`: the source property plus the
 * disambiguated WGSL field name and type the codegen declares for it.
 *
 * @typedef {object} MetadataStructField
 * @property {string} propertyId
 * @property {string} fieldName
 * @property {MetadataClassProperty} classProperty
 * @property {string} wgslType
 * @private
 */

/**
 * Resolve the ordered list of GPU-compatible property-ATTRIBUTE infos for a
 * primitive, mirroring `MetadataPipelineStage.getPropertyAttributesInfo`
 * (MetadataPipelineStage.js:149) — same `property.attribute` →
 * `ModelUtility.getAttributeByName` name resolution + class-property type
 * info. Only properties whose backing glTF attribute is present on the
 * primitive AND whose class type maps to a WGSL type are included (so the
 * generated struct only declares fields the shader can populate).
 *
 * The FIRST element of the returned array is the property the vec4 vertex
 * transport actually carries (up to four components —
 * METADATA-MULTICOMPONENT), so the codegen and the GPU upload agree on which
 * property the `@location(9)` slot feeds.
 *
 * @param {Model} model
 * @param {ModelComponents.Primitive} primitive
 * @returns {MetadataStructField[]}
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
 * METADATA-MULTICOMPONENT — index a possibly-array offset/scale by scalar
 * component. Class-property offset/scale are stored as flat `number[]` (or a
 * plain number for scalars); component `i` is `value[i]`. Mirrors
 * `transformComponentAt` in MetadataWGSLHelpers (kept local — that one is
 * private to the pick builder).
 *
 * @param {number|number[]|undefined} value
 * @param {number} componentIndex
 * @returns {number}
 * @private
 */
function componentAt(value, componentIndex) {
  if (Array.isArray(value)) {
    if (value.length === 1) {
      return value[0];
    }
    return componentIndex < value.length ? value[componentIndex] : 0;
  }
  return defined(value) ? value : 0;
}

/**
 * Build a WGSL expression that constructs a value of `wgslType` from the
 * vec4 transport (`vecExpr`, the `@location(9)` per-vertex value), applying
 * the property's offset/scale value transform component-wise.
 *
 * METADATA-MULTICOMPONENT — the transport carries up to FOUR components of
 * the property (see `WebGPUModelMetadata.resolvePropertyAttributeVec4`), so:
 *
 *   - `f32`        → `vecExpr.x`
 *   - `vec2<f32>`  → `vecExpr.xy`      (both components real)
 *   - `vec3<f32>`  → `vecExpr.xyz`
 *   - `vec4<f32>`  → `vecExpr`
 *   - `mat2x2<f32>`→ all four components (column-major, matching the glTF
 *                    accessor's column-major element order)
 *   - `mat3x3/mat4x4` → NEW-MODEL-METADATA-MAT3-MAT4: when `matTransport`
 *                    is true, ALL 9/16 elements are reassembled from the
 *                    four-vec4 widened transport (`metadataValue` +
 *                    `metadataValue1..3`, column-major). When false (the
 *                    historical single-vec4 transport), first four
 *                    components, rest zero — kept byte-identical as the
 *                    defensive fallback.
 *   - integer families → converted from the transported f32 numeric values
 *                    (the CPU decode keeps unnormalized ints numeric; the
 *                    EXT_structural_metadata spec forbids offset/scale on
 *                    non-float-interpretable types, so no transform)
 *
 * The value transform (`czm_valueTransform` parity — `scale * value +
 * offset`) is applied per component: for scalar/vecN via
 * {@link applyValueTransform} (WGSL `*`/`+` are component-wise on vectors),
 * and for matrices per element (WGSL `mat * mat` is a matrix product, NOT
 * component-wise, so the transform is baked into each constructor argument).
 *
 * @param {string} wgslType
 * @param {string} vecExpr a WGSL `vec4<f32>` expression (the transport).
 *   When `matTransport` is true this MUST be the literal parameter name
 *   `metadataValue` — the extended element reads derive the sibling
 *   parameter names (`metadataValue1..3`) from it by suffixing.
 * @param {MetadataClassProperty} classProperty
 * @param {boolean} [matTransport=false] NEW-MODEL-METADATA-MAT3-MAT4 —
 *   true when the widened four-vec4 transport carries the full matrix.
 * @returns {string}
 * @private
 */
function constructFromTransport(
  wgslType,
  vecExpr,
  classProperty,
  matTransport,
) {
  if (wgslType === "f32") {
    return applyValueTransform(`${vecExpr}.x`, "f32", classProperty);
  }
  // vecN<f32> — swizzle the transported components, transform component-wise.
  const vecMatch = /^vec([234])<f32>$/.exec(wgslType);
  if (vecMatch) {
    const n = parseInt(vecMatch[1], 10);
    const raw = n === 4 ? vecExpr : `${vecExpr}.${"xyzw".slice(0, n)}`;
    return applyValueTransform(raw, wgslType, classProperty);
  }
  // Integer families — construct from the transported numeric floats. No
  // value transform (spec forbids offset/scale on integer-valued types).
  if (wgslType === "i32" || wgslType === "u32") {
    return `${wgslType}(${vecExpr}.x)`;
  }
  const intVecMatch = /^vec([234])<[iu]32>$/.exec(wgslType);
  if (intVecMatch) {
    const n = parseInt(intVecMatch[1], 10);
    const raw = n === 4 ? vecExpr : `${vecExpr}.${"xyzw".slice(0, n)}`;
    return `${wgslType}(${raw})`;
  }
  // matNxN<f32> — fill the elements from the transport (column-major),
  // baking the per-element transform. NEW-MODEL-METADATA-MAT3-MAT4: with
  // the widened transport every element is real (element k reads component
  // k%4 of the (k/4)-th transport vec4); with the historical single-vec4
  // transport only the first up-to-4 elements are real and the rest zero
  // (byte-identical to the pre-MAT-transport codegen — MAT2's only path).
  const matMatch = /^mat([234])x\1<f32>$/.exec(wgslType);
  if (matMatch) {
    const n = parseInt(matMatch[1], 10);
    const total = n * n;
    const hasTransform = classProperty.hasValueTransform === true;
    const carried = matTransport === true ? Math.min(total, 16) : 4;
    const comps = [];
    for (let k = 0; k < total; k++) {
      if (k < carried) {
        const slot = k >> 2;
        const vecName = slot === 0 ? vecExpr : `${vecExpr}${slot}`;
        const raw = `${vecName}.${"xyzw".charAt(k & 3)}`;
        if (hasTransform) {
          const offset = componentAt(classProperty.offset, k);
          const scale = componentAt(classProperty.scale, k);
          comps.push(`(${floatLit(scale)} * ${raw} + ${floatLit(offset)})`);
        } else {
          comps.push(raw);
        }
      } else {
        comps.push("0.0");
      }
    }
    return `${wgslType}(${comps.join(", ")})`;
  }
  // Unknown type — zero-construct (keeps the codegen total).
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
function getPropertyTextureFields(
  model,
  primitive,
  usedFieldNames,
  resolvedLayout,
) {
  const layout =
    arguments.length >= 4
      ? resolvedLayout
      : resolvePropertyTextureLayout(model, primitive);
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
 * @param {ModelRuntimeNode} [runtimeNode] PARITY-METADATA-TABLE-INSTANCE-SOURCE
 * @returns {{ layout: object, fields: object[] }|undefined}
 * @private
 */
function getPropertyTableFields(
  model,
  primitive,
  usedFieldNames,
  runtimeNode,
  resolvedLayout,
) {
  const layout =
    arguments.length >= 5
      ? resolvedLayout
      : resolvePropertyTableLayout(model, primitive, runtimeNode);
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
 *   3. `fn initializeMetadata(metadataValue: vec4<f32>, texCoord0: vec2<f32>,
 *      texCoord1: vec2<f32>, metadataFeatureId: f32) -> Metadata` — assigns the
 *      property-ATTRIBUTE vec4 transport into the property's real WGSL type
 *      (all carried components, offset/scale applied component-wise —
 *      METADATA-MULTICOMPONENT), SAMPLES each property TEXTURE at its texCoord
 *      (DP-H46c), and `textureLoad`s each property TABLE row at
 *      `(featureId, propertyInfoIndex)` then unpacks + offset/scales (DP-H46d).
 *   4. `fn metadataDebugScalar(metadata: Metadata) -> f32` — returns a scalar
 *      proof value in `[0,1]`: the RAW transported attribute scalar when a
 *      property attribute exists, else the first property-texture/-table
 *      property's first component (so the debug override renders a value that
 *      VARIES with the metadata).
 *   5. `fn metadataDebugColor(metadata: Metadata) -> vec4<f32>` — the FS debug
 *      paint (METADATA-MULTICOMPONENT): raw per-component RGB for a VEC2/3/4
 *      transported property; the historical `vec4(s, 0, 1-s, 1)` gradient
 *      around `metadataDebugScalar` for every other shape.
 *
 * @param {Model} model
 * @param {ModelComponents.Primitive} primitive
 * @param {ModelRuntimeNode} [runtimeNode] PARITY-METADATA-TABLE-INSTANCE-SOURCE
 *   — enables the instance-sourced property-table feature-ID path.
 * @param {object} [resolved] Optional pre-resolved CPU metadata inputs. The
 *   renderer hot path supplies these so layouts and attribute packing are
 *   built once per source generation rather than again inside codegen.
 * @returns {{ wgsl: string, classHash: number, fields: object[],
 *   propertyTextureLayout: object|undefined,
 *   propertyTableLayout: object|undefined,
 *   matTransport: boolean }|undefined}
 * @private
 */
function generateMetadataWGSL(model, primitive, runtimeNode, resolved) {
  const attributeFields = getPropertyAttributeFields(model, primitive);
  const usedFieldNames = new Set(attributeFields.map((f) => f.fieldName));
  const textureResult = defined(resolved)
    ? getPropertyTextureFields(
        model,
        primitive,
        usedFieldNames,
        resolved.propertyTextureLayout,
      )
    : getPropertyTextureFields(model, primitive, usedFieldNames);
  const textureFields = textureResult?.fields ?? [];
  const propertyTextureLayout = textureResult?.layout;
  // DP-H46d — property TABLES. Resolved AFTER attributes + textures so the
  // table field names disambiguate against any earlier collision.
  const tableResult = defined(resolved)
    ? getPropertyTableFields(
        model,
        primitive,
        usedFieldNames,
        runtimeNode,
        resolved.propertyTableLayout,
      )
    : getPropertyTableFields(model, primitive, usedFieldNames, runtimeNode);
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
  // — matches `WebGPUModelMetadata.resolveMetadataAttributeData`, which packs
  // up to four components of the first GPU-compatible property attribute into
  // vertex slot 9 (vec4). May be undefined for texture-/table-only models.
  const transported =
    attributeFields.length > 0 ? attributeFields[0] : undefined;

  // NEW-MODEL-METADATA-MAT3-MAT4 — the widened four-vec4 transport engages
  // only when the transported property is a MAT3/MAT4 AND the CPU pack
  // (`resolveMetadataAttributeData`) widened to 16 floats for the SAME
  // property. Deriving both sides from the same resolve keeps the vertex
  // layout (`arrayStride = 64`, locations 9-12) and this generated signature
  // in lockstep — they can never disagree on a well-formed or malformed
  // asset. Scalar/VEC/MAT2 (and texture-/table-only) models keep
  // `matTransport === false` and a byte-identical chunk.
  let matTransport = false;
  if (
    defined(transported) &&
    /^mat[34]x[34]<f32>$/.test(transported.wgslType)
  ) {
    const resolvedPack = defined(resolved)
      ? resolved.metadataAttributeData
      : resolveMetadataAttributeData(model, primitive);
    matTransport =
      defined(resolvedPack) &&
      resolvedPack.vec4Count === 4 &&
      resolvedPack.propertyId === transported.propertyId;
  }

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
  //    `metadataValue` is the vec4 attribute transport — up to four components
  //    of the first GPU-compatible property attribute (zero vec4 for texture-/
  //    table-only). `metadataFeatureId` is the per-vertex feature ID (flat)
  //    that indexes the property-table COLUMN (0.0 when the primitive has no
  //    table).
  // NEW-MODEL-METADATA-MAT3-MAT4 — the MAT-transport variant takes three
  // extra vec4 params (`metadataValue1..3`, the widened locations 10-12) so
  // the full 9/16-element matrix reassembles. The historical 4-arg signature
  // is byte-identical for every non-MAT-transport chunk, and the call sites
  // in ModelPBRComplete.wgsl switch on `//>>ifdef MODEL_METADATA_MAT_TRANSPORT`.
  const matParams = matTransport
    ? "metadataValue1: vec4<f32>, metadataValue2: vec4<f32>, metadataValue3: vec4<f32>, "
    : "";
  lines.push(
    `fn initializeMetadata(metadataValue: vec4<f32>, ${matParams}metadataTexCoord0: vec2<f32>, metadataTexCoord1: vec2<f32>, metadataFeatureId: f32) -> Metadata {`,
  );
  lines.push("  var metadata: Metadata;");
  // Attribute fields. METADATA-MULTICOMPONENT — the transported property is
  // constructed from the vec4 transport with every carried component real
  // (offset/scale applied component-wise).
  for (let i = 0; i < attributeFields.length; i++) {
    const f = attributeFields[i];
    if (f === transported) {
      const constructed = constructFromTransport(
        f.wgslType,
        "metadataValue",
        f.classProperty,
        matTransport,
      );
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
    if (propertyTableLayout.featureIdSource === "texture") {
      // METADATA-TABLE-SOURCES — TEXTURE-sourced feature IDs. Sample the
      // model's feature-ID texture (the SAME group-1 binding-26 resource
      // `ensureFeatureIdResources` uploads — declared at module scope in
      // ModelPBRComplete.wgsl; WGSL module-scope declarations are
      // order-independent, so this prepended chunk may reference it) at the
      // reader's texCoord and unpack the little-endian channel ID with the
      // module-scope `unpackFeatureId` — the same sample+unpack the FS batch
      // path performs, keeping the two feature-ID resolutions identical.
      // `textureSampleLevel(..., 0.0)` because initializeMetadata is called
      // from non-uniform control flow (same rationale as property textures).
      const tc =
        propertyTableLayout.featureIdTexCoord === 1
          ? "metadataTexCoord1"
          : "metadataTexCoord0";
      const channelCount = propertyTableLayout.featureIdChannelCount | 0;
      lines.push(
        `  let metadataTableFidSample = textureSampleLevel(featureIdTexture, featureIdSampler, ${tc}, 0.0);`,
      );
      lines.push(
        `  let metadataTableCol = unpackFeatureId(metadataTableFidSample, ${channelCount});`,
      );
    } else {
      // ATTRIBUTE / IMPLICIT — the per-vertex feature ID arrives as the
      // flat-interpolated `metadataFeatureId` parameter (`input.featureId0`;
      // implicit ranges are synthesized into the same vertex slot).
      lines.push("  let metadataTableCol = i32(metadataFeatureId);");
    }
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
    // integer values are the raw decoded value → rescale to [0,1] by the
    // component type's max (METADATA-UINT16-32: 255 for UINT8 — byte-identical
    // to the historical `/ 255.0` — 65535 for UINT16, etc.) for the gradient.
    const inverted = invertValueTransform(rawScalar, proofField.classProperty);
    const isFloat = proofField.wgslType.indexOf("f32") !== -1;
    const debugMax = Number(
      MetadataComponentType.getMaximum(
        MetadataComponentType.gpuComponentType(
          proofField.classProperty.valueType,
        ),
      ),
    );
    debugBody = isFloat
      ? inverted
      : `clamp(f32(${inverted}) / ${floatLit(debugMax)}, 0.0, 1.0)`;
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

  // 5. metadataDebugColor — the debug-paint accessor the FS call site uses
  //    (METADATA-MULTICOMPONENT). For a VEC2/3/4 transported property it
  //    paints the RAW per-component values as RGB (offset/scale inverted per
  //    component) so all transported components are visually verifiable; for
  //    every other shape it wraps `metadataDebugScalar` in the historical
  //    red/blue gradient `vec4(s, 0, 1-s, 1)` — byte-identical paint to the
  //    pre-multicomponent path for scalar/matrix/texture/table proofs.
  lines.push("fn metadataDebugColor(metadata: Metadata) -> vec4<f32> {");
  const vecMatch = defined(transported)
    ? /^vec([234])<f32>$/.exec(transported.wgslType)
    : null;
  const matDebugMatch =
    matTransport && defined(transported)
      ? /^mat([34])x\1<f32>$/.exec(transported.wgslType)
      : null;
  if (matDebugMatch) {
    // NEW-MODEL-METADATA-MAT3-MAT4 — column-sum paint over the FULL matrix
    // (post-value-transform field, matching what WebGL's CustomShader
    // `fsInput.metadata.<field>` exposes, so a WebGL custom shader computing
    // the same column sums paints the identical color — the cross-backend
    // probe readout). MAT3: rgb = fract(abs(colSum0..2)). MAT4 folds column
    // 3 into every channel so a zero-filled tail shifts all three channels
    // visibly. `fract(abs(...))` matches the table-proof convention for
    // unbounded raw values.
    const n = parseInt(matDebugMatch[1], 10);
    const fieldExpr = `metadata.${transported.fieldName}`;
    const colSum = (c) => {
      const terms = [];
      for (let r = 0; r < n; r++) {
        terms.push(`${fieldExpr}[${c}][${r}]`);
      }
      return terms.join(" + ");
    };
    const tail = n === 4 ? ` + (${colSum(3)})` : "";
    lines.push(
      `  return vec4<f32>(fract(abs((${colSum(0)})${tail})), fract(abs((${colSum(1)})${tail})), fract(abs((${colSum(2)})${tail})), 1.0);`,
    );
  } else if (vecMatch) {
    const n = parseInt(vecMatch[1], 10);
    const comps = [];
    for (let c = 0; c < 3; c++) {
      if (c < n) {
        const compExpr = `metadata.${transported.fieldName}.${"xyz".charAt(c)}`;
        comps.push(
          invertValueTransformComponent(compExpr, transported.classProperty, c),
        );
      } else {
        comps.push("0.0");
      }
    }
    lines.push(`  return vec4<f32>(${comps.join(", ")}, 1.0);`);
  } else {
    lines.push("  let s = metadataDebugScalar(metadata);");
    lines.push("  return vec4<f32>(s, 0.0, 1.0 - s, 1.0);");
  }
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
    // NEW-MODEL-METADATA-MAT3-MAT4 — true when the chunk was generated with
    // the widened four-vec4 matrix transport. The renderer forwards this to
    // the pipeline cache's sticky `metadataMatTransport` state (vertex layout
    // + `MODEL_METADATA_MAT_TRANSPORT` preprocess bit + `:m34` pipeline keys).
    matTransport,
  };
}

/**
 * DP-H46e — resolve the combined ordered field list a primitive's generated
 * `struct Metadata` declares (property ATTRIBUTES, then TEXTURES, then TABLE),
 * with the SAME field-name disambiguation {@link generateMetadataWGSL} uses, so
 * the metadata-pick stage references the exact field names the display chunk
 * emitted. Returns `[]` for non-metadata primitives.
 *
 * @param {Model} model
 * @param {ModelComponents.Primitive} primitive
 * @returns {MetadataStructField[]}
 * @private
 */
function getAllMetadataFields(model, primitive, runtimeNode) {
  const attributeFields = getPropertyAttributeFields(model, primitive);
  const usedFieldNames = new Set(attributeFields.map((f) => f.fieldName));
  const textureResult = getPropertyTextureFields(
    model,
    primitive,
    usedFieldNames,
  );
  const tableResult = getPropertyTableFields(
    model,
    primitive,
    usedFieldNames,
    runtimeNode,
  );
  return attributeFields
    .concat(textureResult?.fields ?? [])
    .concat(tableResult?.fields ?? []);
}

/**
 * DP-H46e — generate the WGSL metadata chunk for `scene.pickMetadata` on
 * WebGPU. This is the GENERATED-codegen sibling of the GLSL
 * `MetadataPickingPipelineStage` + `DerivedCommand.getPickMetadataShaderProgram`
 * (`DerivedCommand.js:561/664`).
 *
 * It produces the SAME display chunk as {@link generateMetadataWGSL} (so the
 * pick variant declares the identical `struct Metadata` + `initializeMetadata`,
 * meaning the pick command reuses the populated metadata exactly) and APPENDS a
 *
 *   fn metadataPickingStage(metadata: Metadata) -> vec4<f32>
 *
 * that reads the picked property's field, un-applies its offset/scale +
 * normalization per component (mirroring `getSourceValueStringComponent`/
 * `getSourceValueStringScalar` — see {@link buildPickSourceComponent}), and
 * packs the [0,1] component values into the RGBA channels the pick FBO encodes
 * as bytes. `MetadataPicking.decodeMetadataValues` re-applies the transform on
 * readback, so the round-trip matches the WebGL byte path exactly.
 *
 * The picked property is resolved by name against the SAME combined field list
 * the display chunk emits. When the property is absent (e.g. a non-GPU-compatible
 * STRING property, or a class with no GPU-readable property of that name) the
 * stage writes `vec4<f32>(0.0)` so the pick decodes to a benign zero rather than
 * failing — matching the GLSL default (`metadataValues = vec4(0.0)`).
 *
 * The returned `classHash` folds in the picked property name so the pick module
 * is cached PER (base-module-class, picked-property) — a single compiled module
 * serves every pick of that property regardless of pick coordinate, with no
 * per-component pipeline explosion (the design's runtime-UBO goal is met by
 * baking the property-specific packing into one per-property module, which the
 * WGSL module cache keys distinctly via this hash).
 *
 * @param {Model} model
 * @param {ModelComponents.Primitive} primitive
 * @param {string} propertyName the picked metadata property name (class property id)
 * @param {ModelRuntimeNode} [runtimeNode] PARITY-METADATA-TABLE-INSTANCE-SOURCE
 * @returns {{ wgsl: string, classHash: number, found: boolean }|undefined}
 *   `undefined` when the primitive carries no GPU-readable metadata at all.
 * @private
 */
function generateMetadataPickWGSL(model, primitive, propertyName, runtimeNode) {
  const display = generateMetadataWGSL(model, primitive, runtimeNode);
  if (!defined(display)) {
    return undefined;
  }

  // Resolve the picked property to its generated struct field.
  const allFields = getAllMetadataFields(model, primitive, runtimeNode);
  let picked;
  for (let i = 0; i < allFields.length; i++) {
    if (allFields[i].propertyId === propertyName) {
      picked = allFields[i];
      break;
    }
  }

  const lines = [];
  lines.push("");
  lines.push(
    "// DP-H46e — GENERATED metadata-pick stage (scene.pickMetadata producer).",
  );
  lines.push(
    `// Picked property: ${propertyName}${defined(picked) ? "" : " (NOT GPU-readable — writes 0)"}`,
  );
  lines.push("fn metadataPickingStage(metadata: Metadata) -> vec4<f32> {");
  lines.push("  var metadataValues = vec4<f32>(0.0, 0.0, 0.0, 0.0);");

  if (defined(picked)) {
    const fieldExpr = `metadata.${picked.fieldName}`;
    const wgslType = picked.wgslType;
    const componentCount = getComponentCount(picked.classProperty);
    const channelNames = ["x", "y", "z", "w"];
    if (componentCount <= 1) {
      // Scalar — pack into channel x (mirrors getSourceValueStringScalar +
      // `metadataValues.x = ...`). The field value's first scalar drives it.
      const scalarExpr = firstComponentExpr(fieldExpr, wgslType);
      const packed = buildPickSourceComponent(
        picked.classProperty,
        0,
        scalarExpr,
      );
      lines.push(`  metadataValues.x = ${packed};`);
    } else {
      // Vector/matrix — pack up to 4 components into x/y/z/w (mirrors the
      // componentNames loop in getPickMetadataShaderProgram). WGSL vec/mat
      // index syntax: vecN uses `.x/.y/...`; matrices are flattened column-major
      // into the [0..componentCount) components the readback DataView expects.
      const n = Math.min(componentCount, 4);
      for (let c = 0; c < n; c++) {
        const compExpr = componentAccessExpr(fieldExpr, wgslType, c);
        const packed = buildPickSourceComponent(
          picked.classProperty,
          c,
          compExpr,
        );
        lines.push(`  metadataValues.${channelNames[c]} = ${packed};`);
      }
    }
  }

  lines.push("  return metadataValues;");
  lines.push("}");
  lines.push("");

  const wgsl = display.wgsl + lines.join("\n");
  // Fold the picked property into the cache key so the pick module is distinct
  // from the display module AND from a different picked property's module.
  const classHash = hashStringFNV1a(`${wgsl}::pick::${propertyName}`);

  return { wgsl, classHash, found: defined(picked) };
}

/**
 * DP-H46e — WGSL expression reading the `componentIndex`-th scalar component of
 * a value of `wgslType` as an `f32`. Vectors index by `.x/.y/.z/.w`; matrices
 * are read column-major (component k → `[k/rows][k%rows]`), matching the
 * array-based component order `MetadataPicking.decodeRawMetadataValues` expects.
 * Integer fields are cast to `f32` (the pick packing operates in float space).
 *
 * @param {string} fieldExpr e.g. `metadata.color`
 * @param {string} wgslType
 * @param {number} componentIndex 0-based
 * @returns {string} a WGSL `f32` expression
 * @private
 */
function componentAccessExpr(fieldExpr, wgslType, componentIndex) {
  const vecMatch = /^vec([234])<([fiu]32)>$/.exec(wgslType);
  if (vecMatch) {
    const comp = ["x", "y", "z", "w"][componentIndex];
    return `f32(${fieldExpr}.${comp})`;
  }
  const matMatch = /^mat([234])x\1<f32>$/.exec(wgslType);
  if (matMatch) {
    const dim = parseInt(matMatch[1], 10);
    const col = Math.floor(componentIndex / dim);
    const row = componentIndex % dim;
    return `f32(${fieldExpr}[${col}][${row}])`;
  }
  // Scalar fallback.
  return `f32(${fieldExpr})`;
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

/**
 * METADATA-MULTICOMPONENT — per-component sibling of
 * {@link invertValueTransform}: recover the RAW transported component in
 * `[0,1]` from a (possibly offset/scaled) field component, by inverting
 * `czm_valueTransform` at `componentIndex` — `raw_i = (transformed_i -
 * offset_i) / scale_i`. Used by the generated `metadataDebugColor` so a
 * VEC2/3/4 property paints its raw per-component values as RGB.
 *
 * @param {string} valueExpr a WGSL `f32` (the field's `componentIndex`-th component)
 * @param {MetadataClassProperty} classProperty
 * @param {number} componentIndex 0..3
 * @returns {string}
 * @private
 */
function invertValueTransformComponent(
  valueExpr,
  classProperty,
  componentIndex,
) {
  if (!classProperty.hasValueTransform) {
    return valueExpr;
  }
  const offset = componentAt(classProperty.offset, componentIndex);
  const scale = componentAt(classProperty.scale, componentIndex);
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
function primitiveHasMetadataWGSL(model, primitive, runtimeNode) {
  if (getPropertyAttributeFields(model, primitive).length > 0) {
    return true;
  }
  if (defined(resolvePropertyTextureLayout(model, primitive))) {
    return true;
  }
  return defined(resolvePropertyTableLayout(model, primitive, runtimeNode));
}

export {
  generateMetadataWGSL,
  generateMetadataPickWGSL,
  getPropertyAttributeFields,
  getPropertyTextureFields,
  getPropertyTableFields,
  primitiveHasMetadataWGSL,
};
export default {
  generateMetadataWGSL,
  generateMetadataPickWGSL,
  getPropertyAttributeFields,
  getPropertyTextureFields,
  getPropertyTableFields,
  primitiveHasMetadataWGSL,
};
