/**
 * WebGPU Voxel USER CustomShader codegen — VOXEL-USER-CUSTOMSHADER.
 *
 * Per-primitive WGSL codegen for a USER-supplied native-WGSL voxel
 * {@link CustomShader}. This is the voxel sibling of the model path's
 * `CustomShaderWGSLPipelineStage` (PARITY-CUSTOM-SHADER-WGSL, Batch 473): a
 * `CustomShader` that supplies `wgslFragmentShaderText` runs through THIS
 * codegen; a GLSL-only voxel customShader keeps the warn + default-gray
 * behavior on WebGPU (GLSL→WGSL transpile stays deferred by design).
 *
 * The generated chunk declares the bridge structs the user WGSL reads/writes
 * and inlines the user's fragment body. It is PREPENDED to the renderer's
 * inline `VOXEL_WGSL` source before preprocessing; the call site lives behind
 * `//>>ifdef VOXEL_USER_CUSTOM_SHADER` nested inside the
 * `VOXEL_CUSTOM_SHADER_COLOR` parity march, so every non-user variant is
 * byte-identical to the Batch 476 output.
 *
 * User contract (native WGSL — NOT the GLSL `fragmentMain` signature):
 *
 *   fn czm_voxelCustomFragmentMain(
 *     fsInput: czm_voxelCustomFragmentInput,
 *     material: ptr<function, czm_voxelCustomMaterial>)
 *
 *   - `fsInput.metadata.<propertyName>` — the sampled value of the provider's
 *     FIRST metadata property (the only one the WebGPU data path uploads —
 *     see WebGPUVoxelDataUpload), typed per the property's MetadataType
 *     (SCALAR → f32, VEC2/3/4 → vecN<f32>).
 *   - `fsInput.attributes.normalLocal` — the ray's entry-face normal in the
 *     box-LOCAL frame. `dot(normalLocal, lightDirectionLocal)` equals WebGL's
 *     `dot(fsInput.attributes.normalEC, czm_lightDirectionEC)` (the
 *     PARITY-VOXEL-COLOR-PARITY model-frame lighting identity).
 *   - `fsInput.attributes.lightDirectionLocal` — the sun light direction in
 *     the same box-local frame.
 *   - `fsInput.attributes.shapeUv` — the sample's shape-UV coordinate
 *     (WebGL's tileUv at the root tile).
 *   - `material` starts as diffuse = (0,0,0), alpha = 0 each sample; the
 *     ray-march accumulates whatever the body writes with WebGL VoxelFS.glsl's
 *     premultiplied front-to-back integral (alpha 0 contributes nothing).
 *
 * What is NOT supported in this increment (warn + default-gray fallback,
 * enforced by the renderer via {@link voxelUserShaderHasUniforms}):
 *   - customShader `uniforms` (incl. SAMPLER_2D color-map textures) — needs a
 *     voxel BGL/pipeline-layout variant; tracked in DEFERRED_WORK
 *     (VOXEL-USER-CUSTOMSHADER follow-up).
 *   - metadata properties beyond the first (the data path uploads only
 *     property 0 — the same limitation as the megatexture upload increment).
 *
 * @private
 * @module WebGPUVoxelCustomShaderCodegen
 */

import { ShaderDefine } from "./WebGPUShaderDefines.js";

/**
 * Structural view of the {@link CustomShader} fields this codegen consumes.
 */
export interface VoxelUserCustomShaderLike {
  wgslFragmentShaderText?: string;
  fragmentShaderText?: string;
  uniforms?: Record<string, unknown>;
}

/**
 * Structural view of the voxel provider's metadata description (the fields
 * needed to type + name the first uploaded property).
 */
export interface VoxelProviderMetadataLike {
  names?: readonly string[];
  types?: readonly string[];
}

/**
 * Result of {@link generateVoxelUserShaderChunk}: the generated WGSL chunk to
 * prepend to `VOXEL_WGSL`, plus a non-zero content fingerprint used as both
 * the shader-module cache `keySalt` and the pipeline-cache name discriminator.
 */
export interface VoxelUserShaderInfo {
  chunk: string;
  hash: number;
}

/**
 * FNV-1a 32-bit string hash (mirrors `CustomShaderWGSLPipelineStage`'s local
 * copy — kept local so this module stays dependency-free). Exported for
 * spec coverage (NEW-SPEC-VOXEL-CUSTOMSHADER-CODEGEN); not a public API.
 */
export function hashStringFNV1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/**
 * Sanitize a metadata property name to a valid WGSL identifier: leading
 * non-alpha characters get a `_` prefix, every other invalid character maps
 * to `_`. Mirrors the intent of `ModelUtility.sanitizeGlslIdentifier` without
 * pulling in the model-loader dependency graph. Exported for spec coverage
 * (NEW-SPEC-VOXEL-CUSTOMSHADER-CODEGEN); not a public API.
 */
export function sanitizeWgslIdentifier(name: string): string {
  let sanitized = name.replace(/[^0-9a-zA-Z_]/g, "_");
  if (!/^[a-zA-Z_]/.test(sanitized)) {
    sanitized = `_${sanitized}`;
  }
  return sanitized;
}

/**
 * True when the customShader declares at least one uniform. The voxel user
 * path does not support uniforms yet — the renderer warns + falls back to the
 * default gray path (see the module docstring).
 */
export function voxelUserShaderHasUniforms(
  customShader: VoxelUserCustomShaderLike,
): boolean {
  const uniforms = customShader.uniforms;
  if (!uniforms) {
    return false;
  }
  for (const key in uniforms) {
    if (Object.prototype.hasOwnProperty.call(uniforms, key)) {
      return true;
    }
  }
  return false;
}

/**
 * Generate the WGSL chunk for a user voxel customShader, or `undefined` when
 * the customShader carries no native-WGSL fragment text (GLSL-only → the
 * renderer keeps the warn + default-gray path).
 *
 * The provider's FIRST metadata property (names[0]/types[0]) types the
 * `czm_voxelCustomMetadata` field — the same property the WebGPU voxel data
 * path uploads into the megatexture (WebGPUVoxelDataUpload uploads
 * `content.metadata[0]` expanded to RGBA; SCALAR lands in `.x`, VEC2 in
 * `.xy`, VEC3 in `.xyz`, VEC4 in `.xyzw`).
 */
export function generateVoxelUserShaderChunk(
  customShader: VoxelUserCustomShaderLike,
  provider: VoxelProviderMetadataLike | undefined,
): VoxelUserShaderInfo | undefined {
  const fragmentText = customShader.wgslFragmentShaderText;
  if (typeof fragmentText !== "string" || fragmentText.length === 0) {
    return undefined;
  }

  const rawName = provider?.names?.[0];
  const propertyName = sanitizeWgslIdentifier(
    typeof rawName === "string" && rawName.length > 0 ? rawName : "property",
  );
  const propertyType = provider?.types?.[0];

  // Map the property's MetadataType onto the WGSL field type + the swizzle of
  // the sampled RGBA texel that carries it (expandToRGBA channel order).
  let wgslType = "vec4<f32>";
  let accessor = "s";
  if (propertyType === "SCALAR") {
    wgslType = "f32";
    accessor = "s.x";
  } else if (propertyType === "VEC2") {
    wgslType = "vec2<f32>";
    accessor = "s.xy";
  } else if (propertyType === "VEC3") {
    wgslType = "vec3<f32>";
    accessor = "s.xyz";
  }

  const lines: string[] = [];
  lines.push(
    "// VOXEL-USER-CUSTOMSHADER — GENERATED native-WGSL voxel customShader chunk.",
  );
  lines.push("struct czm_voxelCustomMetadata {");
  lines.push(`  ${propertyName}: ${wgslType},`);
  lines.push("};");
  lines.push("struct czm_voxelCustomAttributes {");
  lines.push("  normalLocal: vec3<f32>,");
  lines.push("  lightDirectionLocal: vec3<f32>,");
  lines.push("  shapeUv: vec3<f32>,");
  lines.push("};");
  lines.push("struct czm_voxelCustomFragmentInput {");
  lines.push("  metadata: czm_voxelCustomMetadata,");
  lines.push("  attributes: czm_voxelCustomAttributes,");
  lines.push("};");
  lines.push("struct czm_voxelCustomMaterial {");
  lines.push("  diffuse: vec3<f32>,");
  lines.push("  alpha: f32,");
  lines.push("};");
  lines.push(
    "fn czm_voxelReadCustomMetadata(s: vec4<f32>) -> czm_voxelCustomMetadata {",
  );
  lines.push("  var m: czm_voxelCustomMetadata;");
  lines.push(`  m.${propertyName} = ${accessor};`);
  lines.push("  return m;");
  lines.push("}");
  lines.push("// ── user wgslFragmentShaderText ──");
  lines.push(fragmentText);
  lines.push("");

  const chunk = lines.join("\n");

  // Non-zero fingerprint for the DP-H46b generated-source identity and the
  // pipeline-cache name. Keep remapping the former Batch 476 reserved value
  // as well so persisted diagnostics retain stable hash behavior across the
  // cache-key widening.
  let hash = hashStringFNV1a(chunk);
  if (hash === 0 || hash === ShaderDefine.VOXEL_CUSTOM_SHADER_COLOR >>> 0) {
    hash = (hash ^ 0x9e3779b9) >>> 0;
  }

  return { chunk, hash };
}
