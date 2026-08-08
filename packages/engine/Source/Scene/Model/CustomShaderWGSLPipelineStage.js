/**
 * PARITY-CUSTOM-SHADER-WGSL — per-model WGSL codegen for a NATIVE-WGSL
 * {@link CustomShader}. This is the WGSL sibling of the GLSL
 * {@link CustomShaderPipelineStage}: it emits a WGSL string declaring
 *
 *   struct CustomShaderUniforms { <field per user uniform> };
 *   `@group(1) @binding(N) var<uniform> czm_customUniforms: CustomShaderUniforms;`
 *   `@group(1) @binding(N+1..) var czm_customTexture0: texture_2d<f32>;` (+sampler)
 *   struct czm_customFragmentInput { positionMC/EC, texCoord0, color0, normalEC };
 *   struct czm_customModelMaterial { diffuse, specular, roughness, alpha, emissive,
 *                                    metalness, occlusion, normalEC };
 *   fn czm_customFragmentMain(...) { <user's wgslFragmentShaderText inlined> }
 *   fn czm_customVertexMain(...)   { <user's wgslVertexShaderText inlined> }  (optional)
 *   const CZM_CUSTOM_SHADER_REPLACE: bool = <mode === REPLACE_MATERIAL>;
 *
 * `CZM_CUSTOM_SHADER_REPLACE` drives the PRE-lighting injection in
 * `ModelPBRComplete.wgsl` (Q31 slice A): the fragment hook runs BEFORE the
 * Cook-Torrance BRDF (matching WebGL ModelFS's customShaderStage → lightingStage
 * order), seeding `czm_customModelMaterial` from the computed PBR material for
 * MODIFY_MATERIAL or from the czm default material (diffuse 0, specular 1,
 * roughness 1, emissive 0, alpha 1) for REPLACE_MATERIAL. The const folds the
 * seam's branch at compile time and, being part of the hashed chunk, splits the
 * module cache so MODIFY and REPLACE variants of the same body never collide.
 *
 * The string is prepended at the SAME single injection point in
 * `WebGPUModelPipelineCache._getOrCreateShaderModule` that
 * `MetadataWGSLPipelineStage` uses (the metadata seam). The call sites in
 * `ModelPBRComplete.wgsl` live behind `//>>ifdef MODEL_HAS_WGSL_CUSTOM_SHADER`
 * so the OFF path (no customShader, or a GLSL-only one) is byte-identical.
 *
 * DESIGN (per PARITY_TO_100 by-design note): this is a NATIVE-WGSL path, NOT a
 * GLSL→WGSL transpile. A `CustomShader` that only supplies `fragmentShaderText`
 * (GLSL) continues to warn + no-op on WebGPU — the transpile stays deferred. A
 * `CustomShader` that supplies `wgslFragmentShaderText` (and optionally
 * `wgslVertexShaderText`) runs through THIS stage.
 *
 * Uniform packing: each user uniform is packed into the UBO at a 16-byte
 * (vec4) aligned slot regardless of its base type (std140-safe over-alignment —
 * simpler + robust for the small uniform counts a CustomShader uses). The
 * generated struct declares each field followed by pad members so the WGSL
 * struct's field offsets match the packed byte layout the renderer uploads.
 * SAMPLER_2D uniforms are bound as (texture, sampler) pairs at the custom
 * texture bindings, NOT packed into the UBO.
 *
 * @private
 * @module CustomShaderWGSLPipelineStage
 */
import defined from "../../Core/defined.js";
import DeveloperError from "../../Core/DeveloperError.js";
import CustomShaderMode from "./CustomShaderMode.js";
import UniformType from "./UniformType.js";
import ModelUtility from "./ModelUtility.js";

/**
 * Group-1 binding of the CustomShader uniforms UBO. Sits well past the
 * property-table block (44-45) so a customShader can coexist with metadata
 * bindings on the same material BGL without collision.
 * @private
 */
const CUSTOM_SHADER_UBO_BINDING = 50;

/**
 * Group-1 binding of the FIRST custom texture. Custom SAMPLER_2D uniforms bind
 * as `texture_2d<f32>` at `CUSTOM_SHADER_TEXTURE_BINDING_BASE + k`; they all
 * share ONE sampler at {@link CUSTOM_SHADER_SAMPLER_BINDING} (one shared sampler
 * keeps the per-stage sampler count under the WebGPU spec floor of 16 — the
 * material stage already uses ~11 samplers, so one shared custom sampler fits
 * where four per-texture samplers would not).
 * @private
 */
const CUSTOM_SHADER_TEXTURE_BINDING_BASE = 51;

/**
 * Cap on the number of custom SAMPLER_2D uniforms bound. Keeps the sampled-
 * texture count under the WebGPU spec floor when combined with the basic
 * material variant. Overflow textures are dropped (logged once).
 * @private
 */
const MAX_CUSTOM_TEXTURES = 4;

/**
 * Group-1 binding of the SINGLE shared custom-texture sampler. Sits just past
 * the {@link MAX_CUSTOM_TEXTURES} texture bindings.
 * @private
 */
const CUSTOM_SHADER_SAMPLER_BINDING =
  CUSTOM_SHADER_TEXTURE_BINDING_BASE + MAX_CUSTOM_TEXTURES;

/**
 * Per-uniform WGSL field type + byte size (unpadded) for the non-sampler
 * uniform types. Matrices are packed column-major into the vec4-aligned slots.
 * @private
 */
const UNIFORM_WGSL_INFO = Object.freeze({
  [UniformType.FLOAT]: { wgsl: "f32", slots: 1 },
  [UniformType.VEC2]: { wgsl: "vec2<f32>", slots: 1 },
  [UniformType.VEC3]: { wgsl: "vec3<f32>", slots: 1 },
  [UniformType.VEC4]: { wgsl: "vec4<f32>", slots: 1 },
  [UniformType.INT]: { wgsl: "i32", slots: 1 },
  [UniformType.INT_VEC2]: { wgsl: "vec2<i32>", slots: 1 },
  [UniformType.INT_VEC3]: { wgsl: "vec3<i32>", slots: 1 },
  [UniformType.INT_VEC4]: { wgsl: "vec4<i32>", slots: 1 },
  [UniformType.BOOL]: { wgsl: "i32", slots: 1 },
  [UniformType.BOOL_VEC2]: { wgsl: "vec2<i32>", slots: 1 },
  [UniformType.BOOL_VEC3]: { wgsl: "vec3<i32>", slots: 1 },
  [UniformType.BOOL_VEC4]: { wgsl: "vec4<i32>", slots: 1 },
  // Matrices packed as N columns, each column a vec4-aligned slot.
  [UniformType.MAT2]: { wgsl: "mat2x2<f32>", slots: 2 },
  [UniformType.MAT3]: { wgsl: "mat3x3<f32>", slots: 3 },
  [UniformType.MAT4]: { wgsl: "mat4x4<f32>", slots: 4 },
});

/**
 * FNV-1a 32-bit hash of a string. Used for the module cache key so distinct
 * customShaders get distinct compiled modules. Local copy (mirrors
 * `MetadataWGSLHelpers.hashStringFNV1a`) to keep this stage self-contained.
 * @param {string} str
 * @returns {number}
 * @private
 */
function hashStringFNV1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/**
 * Resolve the ordered, sanitized list of NON-sampler uniform fields (packed
 * into the UBO) and SAMPLER_2D uniform fields (bound as textures) for a
 * customShader. Field names are the user-declared uniform names sanitized to
 * valid WGSL identifiers.
 *
 * @param {CustomShader} customShader
 * @returns {{ uboFields: object[], textureFields: object[] }}
 * @private
 */
function resolveUniformFields(customShader) {
  const uboFields = [];
  const textureFields = [];
  const uniforms = customShader.uniforms;
  const seen = new Set();
  for (const uniformName in uniforms) {
    if (!uniforms.hasOwnProperty(uniformName)) {
      continue;
    }
    const uniform = uniforms[uniformName];
    const type = uniform.type;
    let fieldName = ModelUtility.sanitizeGlslIdentifier(uniformName);
    if (seen.has(fieldName)) {
      fieldName = `${fieldName}_${uboFields.length + textureFields.length}`;
    }
    seen.add(fieldName);

    if (type === UniformType.SAMPLER_2D) {
      if (textureFields.length >= MAX_CUSTOM_TEXTURES) {
        //>>includeStart('debug', pragmas.debug);
        console.warn(
          `[WebGPU:Model:CustomShader] custom texture uniform "${uniformName}" ` +
            `dropped — exceeds MAX_CUSTOM_TEXTURES (${MAX_CUSTOM_TEXTURES}).`,
        );
        //>>includeEnd('debug');
        continue;
      }
      textureFields.push({ uniformName, fieldName });
      continue;
    }

    const info = UNIFORM_WGSL_INFO[type];
    if (!defined(info)) {
      //>>includeStart('debug', pragmas.debug);
      console.warn(
        `[WebGPU:Model:CustomShader] unsupported uniform type "${type}" for ` +
          `"${uniformName}" — skipped.`,
      );
      //>>includeEnd('debug');
      continue;
    }
    uboFields.push({
      uniformName,
      fieldName,
      type,
      wgslType: info.wgsl,
      slots: info.slots,
    });
  }
  return { uboFields, textureFields };
}

/**
 * Emit the `struct CustomShaderUniforms { ... }` WGSL. Every field is followed
 * by explicit vec4-alignment padding so the WGSL struct layout matches the
 * renderer's packed upload (one vec4 slot per scalar/vector; N vec4 slots per
 * matN). Emits at least one field so the struct is never empty (empty structs
 * are invalid WGSL); when there are no UBO uniforms a single `_pad` vec4 is
 * emitted and the UBO is still bound (a 16-byte zero buffer).
 *
 * @param {object[]} uboFields
 * @returns {string}
 * @private
 */
function emitUniformStruct(uboFields) {
  const lines = ["struct CustomShaderUniforms {"];
  if (uboFields.length === 0) {
    lines.push("  _czm_customPad: vec4<f32>,");
    lines.push("};");
    return lines.join("\n");
  }
  let padIndex = 0;
  for (let i = 0; i < uboFields.length; i++) {
    const f = uboFields[i];
    lines.push(`  ${f.fieldName}: ${f.wgslType},`);
    // Pad scalar/vec fields (1 slot) up to a full vec4 so the next field
    // starts on a 16-byte boundary. Vectors already ≤16 bytes; matrices'
    // columns are vec-aligned in WGSL, so only single-slot fields need the
    // explicit trailing pad.
    if (
      f.slots === 1 &&
      f.wgslType !== "vec4<f32>" &&
      f.wgslType !== "vec4<i32>"
    ) {
      lines.push(`  _czm_pad${padIndex}: vec4<f32>,`);
      padIndex++;
    }
  }
  lines.push("};");
  return lines.join("\n");
}

/**
 * Generate the full WGSL customShader chunk for a model whose `customShader`
 * carries native WGSL text, or `undefined` when the customShader has no WGSL
 * fragment text (GLSL-only → the renderer keeps the warn+no-op path).
 *
 * @param {CustomShader} customShader
 * @returns {{ wgsl: string, classHash: number, uboFields: object[],
 *   textureFields: object[], hasVertex: boolean, hasFragment: boolean }|undefined}
 * @private
 */
function generateCustomShaderWGSL(customShader) {
  if (!defined(customShader)) {
    return undefined;
  }
  const fragmentText = customShader.wgslFragmentShaderText;
  const vertexText = customShader.wgslVertexShaderText;
  // Native-WGSL path requires at least a fragment body (the diffuse override
  // hook). A WGSL vertex-only customShader is unusual; require fragment.
  if (!defined(fragmentText)) {
    return undefined;
  }

  const { uboFields, textureFields } = resolveUniformFields(customShader);

  const lines = [];
  lines.push(
    "// PARITY-CUSTOM-SHADER-WGSL — GENERATED native-WGSL customShader chunk.",
  );

  // 0. CustomShaderMode selector (slice A). REPLACE_MATERIAL seeds the czm
  //    default material before the user body (WebGL's defaultModelMaterial()
  //    when materialStage is skipped); MODIFY_MATERIAL (default) seeds the
  //    computed PBR material. Baked as a module-scope const so the branch in
  //    ModelPBRComplete.wgsl's pre-lighting injection folds at compile time. It
  //    also participates in the classHash below → MODIFY and REPLACE variants of
  //    the same body get distinct compiled modules.
  const isReplaceMode = customShader.mode === CustomShaderMode.REPLACE_MATERIAL;
  lines.push(
    `const CZM_CUSTOM_SHADER_REPLACE: bool = ${isReplaceMode ? "true" : "false"};`,
  );

  // 1. Uniform UBO struct + binding.
  lines.push(emitUniformStruct(uboFields));
  lines.push(
    `@group(1) @binding(${CUSTOM_SHADER_UBO_BINDING}) var<uniform> czm_customUniforms: CustomShaderUniforms;`,
  );

  // 2. Custom textures (one `texture_2d<f32>` each) + ONE shared sampler. The
  //    user reads a custom texture with
  //    `textureSample(<name>, czm_customSampler, uv)`.
  for (let k = 0; k < textureFields.length; k++) {
    const texBinding = CUSTOM_SHADER_TEXTURE_BINDING_BASE + k;
    lines.push(
      `@group(1) @binding(${texBinding}) var ${textureFields[k].fieldName}: texture_2d<f32>;`,
    );
  }
  if (textureFields.length > 0) {
    lines.push(
      `@group(1) @binding(${CUSTOM_SHADER_SAMPLER_BINDING}) var czm_customSampler: sampler;`,
    );
  }
  lines.push("");

  // 3. Bridge structs the user WGSL reads/writes. These mirror the GLSL
  //    FragmentInput + czm_modelMaterial contract in a WGSL-native shape.
  lines.push("struct czm_customAttributes {");
  lines.push("  positionMC: vec3<f32>,");
  lines.push("  positionEC: vec3<f32>,");
  lines.push("  normalEC: vec3<f32>,");
  lines.push("  texCoord_0: vec2<f32>,");
  lines.push("  color_0: vec4<f32>,");
  lines.push("};");
  lines.push("struct czm_customFragmentInput {");
  lines.push("  attributes: czm_customAttributes,");
  lines.push("};");
  lines.push("struct czm_customModelMaterial {");
  lines.push("  diffuse: vec3<f32>,");
  lines.push("  specular: vec3<f32>,");
  lines.push("  roughness: f32,");
  lines.push("  emissive: vec3<f32>,");
  lines.push("  alpha: f32,");
  // Q31 slice B — extra material fields matching WebGL's czm_modelMaterial
  // surface (normalEC, occlusion) plus a WGSL-native metalness convenience.
  // metalness (MODIFY mode) re-splits diffuse/F0 from baseColor; occlusion
  // scales the ambient/IBL term; normalEC re-derives lighting from the
  // perturbed normal. All seeded so an untouched field is byte-identical.
  lines.push("  metalness: f32,");
  lines.push("  occlusion: f32,");
  lines.push("  normalEC: vec3<f32>,");
  lines.push("};");
  lines.push("");

  // 4. Inline the user's fragment WGSL. It must define
  //    `fn czm_customFragmentMain(fsInput: czm_customFragmentInput,
  //       material: ptr<function, czm_customModelMaterial>)`.
  lines.push("// ── user wgslFragmentShaderText ──");
  lines.push(fragmentText);
  lines.push("");

  let hasVertex = false;
  if (defined(vertexText)) {
    hasVertex = true;
    lines.push("struct czm_customVertexInput {");
    lines.push("  attributes: czm_customAttributes,");
    lines.push("};");
    lines.push("struct czm_customVertexOutput {");
    lines.push("  positionMC: vec3<f32>,");
    lines.push("};");
    lines.push("// ── user wgslVertexShaderText ──");
    lines.push(vertexText);
    lines.push("");
  }

  const wgsl = lines.join("\n");
  // Fold the full generated string into the cache key so distinct customShaders
  // (different uniforms / body / textures) get distinct compiled modules.
  const classHash = hashStringFNV1a(wgsl);

  return {
    wgsl,
    classHash,
    uboFields,
    textureFields,
    hasVertex,
    hasFragment: true,
  };
}

/**
 * Pack a customShader's UBO uniform VALUES into a Float32Array/Int32Array-view
 * buffer laid out to match the generated `CustomShaderUniforms` struct: one
 * vec4 (16-byte) slot per scalar/vector field, N vec4 slots per matN. Returns a
 * padded `ArrayBuffer` ready for `device.queue.writeBuffer` (min 16 bytes).
 *
 * @param {object[]} uboFields
 * @param {CustomShader} customShader
 * @returns {ArrayBuffer}
 * @private
 */
function packUniformBuffer(uboFields, customShader) {
  // Compute total vec4 slots.
  let totalSlots = 0;
  for (let i = 0; i < uboFields.length; i++) {
    totalSlots += uboFields[i].slots;
  }
  if (totalSlots === 0) {
    totalSlots = 1; // the `_czm_customPad` field
  }
  const floatCount = totalSlots * 4;
  const buffer = new ArrayBuffer(floatCount * 4);
  const f32 = new Float32Array(buffer);
  const i32 = new Int32Array(buffer);

  let slot = 0;
  for (let i = 0; i < uboFields.length; i++) {
    const f = uboFields[i];
    const value = customShader.uniforms[f.uniformName].value;
    const base = slot * 4;
    writeUniformValue(f.type, value, f32, i32, base);
    slot += f.slots;
  }
  return buffer;
}

/**
 * Write a single uniform value into the packed buffer at float offset `base`.
 * @private
 */
function writeUniformValue(type, value, f32, i32, base) {
  switch (type) {
    case UniformType.FLOAT:
      f32[base] = value;
      break;
    case UniformType.VEC2:
      f32[base] = value.x;
      f32[base + 1] = value.y;
      break;
    case UniformType.VEC3:
      f32[base] = value.x;
      f32[base + 1] = value.y;
      f32[base + 2] = value.z;
      break;
    case UniformType.VEC4:
      f32[base] = value.x;
      f32[base + 1] = value.y;
      f32[base + 2] = value.z;
      f32[base + 3] = value.w;
      break;
    case UniformType.INT:
      i32[base] = value;
      break;
    case UniformType.BOOL:
      i32[base] = value ? 1 : 0;
      break;
    case UniformType.INT_VEC2:
      i32[base] = value.x;
      i32[base + 1] = value.y;
      break;
    case UniformType.INT_VEC3:
      i32[base] = value.x;
      i32[base + 1] = value.y;
      i32[base + 2] = value.z;
      break;
    case UniformType.INT_VEC4:
      i32[base] = value.x;
      i32[base + 1] = value.y;
      i32[base + 2] = value.z;
      i32[base + 3] = value.w;
      break;
    case UniformType.BOOL_VEC2:
      i32[base] = value.x ? 1 : 0;
      i32[base + 1] = value.y ? 1 : 0;
      break;
    case UniformType.BOOL_VEC3:
      i32[base] = value.x ? 1 : 0;
      i32[base + 1] = value.y ? 1 : 0;
      i32[base + 2] = value.z ? 1 : 0;
      break;
    case UniformType.BOOL_VEC4:
      i32[base] = value.x ? 1 : 0;
      i32[base + 1] = value.y ? 1 : 0;
      i32[base + 2] = value.z ? 1 : 0;
      i32[base + 3] = value.w ? 1 : 0;
      break;
    case UniformType.MAT2:
      // Matrix2 is column-major length-4. WGSL mat2x2 columns are vec4-aligned
      // (2 columns → 2 vec4 slots, .xy of each used).
      f32[base] = value[0];
      f32[base + 1] = value[1];
      f32[base + 4] = value[2];
      f32[base + 5] = value[3];
      break;
    case UniformType.MAT3:
      // Matrix3 column-major length-9 → 3 vec4 slots (.xyz of each).
      for (let c = 0; c < 3; c++) {
        f32[base + c * 4] = value[c * 3];
        f32[base + c * 4 + 1] = value[c * 3 + 1];
        f32[base + c * 4 + 2] = value[c * 3 + 2];
      }
      break;
    case UniformType.MAT4:
      // Matrix4 column-major length-16 → 4 vec4 slots.
      for (let m = 0; m < 16; m++) {
        f32[base + m] = value[m];
      }
      break;
    default:
      //>>includeStart('debug', pragmas.debug);
      throw new DeveloperError(
        `CustomShaderWGSLPipelineStage: cannot pack uniform type ${type}`,
      );
    //>>includeEnd('debug');
  }
}

export {
  generateCustomShaderWGSL,
  packUniformBuffer,
  CUSTOM_SHADER_UBO_BINDING,
  CUSTOM_SHADER_TEXTURE_BINDING_BASE,
  CUSTOM_SHADER_SAMPLER_BINDING,
  MAX_CUSTOM_TEXTURES,
};
export default {
  generateCustomShaderWGSL,
  packUniformBuffer,
  CUSTOM_SHADER_UBO_BINDING,
  CUSTOM_SHADER_TEXTURE_BINDING_BASE,
  CUSTOM_SHADER_SAMPLER_BINDING,
  MAX_CUSTOM_TEXTURES,
};
