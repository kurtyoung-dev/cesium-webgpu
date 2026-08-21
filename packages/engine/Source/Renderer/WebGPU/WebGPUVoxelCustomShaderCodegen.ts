/**
 * Generates per-primitive WGSL for a native voxel {@link CustomShader}.
 *
 * A custom shader that supplies `wgslFragmentShaderText` runs through this
 * codegen. A GLSL-only voxel custom shader warns and uses the default gray
 * behavior because this path does not transpile GLSL to WGSL.
 *
 * The generated chunk declares the bridge structs read and written by the
 * user WGSL and inlines the user's fragment body. It is prepended to the
 * renderer's inline `VOXEL_WGSL` source before preprocessing. The call site is
 * guarded by `//>>ifdef VOXEL_USER_CUSTOM_SHADER` inside the
 * `VOXEL_CUSTOM_SHADER_COLOR` march, which leaves non-user variants unchanged.
 *
 * Native WGSL contract, distinct from the GLSL `fragmentMain` signature:
 *
 *   fn czm_voxelCustomFragmentMain(
 *     fsInput: czm_voxelCustomFragmentInput,
 *     material: ptr<function, czm_voxelCustomMaterial>)
 *
 *   - `fsInput.metadata.<propertyName>` — the sampled value of the provider's
 *     first metadata property (the only one the WebGPU data path uploads —
 *     see WebGPUVoxelDataUpload), typed per the property's MetadataType
 *     (SCALAR → f32, VEC2/3/4 → vecN<f32>).
 *   - `fsInput.attributes.normalLocal` — the ray's entry-face normal in the
 *     box-local frame. `dot(normalLocal, lightDirectionLocal)` equals WebGL's
 *     `dot(fsInput.attributes.normalEC, czm_lightDirectionEC)` because both
 *     operands use the same model-relative frame.
 *   - `fsInput.attributes.lightDirectionLocal` — the sun light direction in
 *     the same box-local frame.
 *   - `fsInput.attributes.shapeUv` — the sample's shape-UV coordinate
 *     (WebGL's tileUv at the root tile).
 *   - `material` starts as diffuse = (0,0,0), alpha = 0 each sample; the
 *     ray-march accumulates whatever the body writes with WebGL VoxelFS.glsl's
 *     premultiplied front-to-back integral (alpha 0 contributes nothing).
 *
 * Unsupported inputs warn and use the default gray fallback, enforced by the
 * renderer through {@link voxelUserShaderHasUniforms}:
 *   - Custom-shader `uniforms`, including `SAMPLER_2D` color-map textures,
 *     require a voxel bind-group and pipeline-layout variant. The fallback
 *     must remain until that layout exists so generated shaders cannot refer
 *     to resources the pipeline does not bind.
 *   - metadata properties beyond the first, because the megatexture data path
 *     uploads only property 0.
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
 * copy and stays local so this module remains dependency-free). Exported for
 * focused source-level verification; not a public API.
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
 * pulling in the model-loader dependency graph. Exported for focused
 * source-level verification; not a public API.
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
 * path does not support uniforms; the renderer warns and falls back to the
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
 * The provider's first metadata property (names[0]/types[0]) types the
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

  // Zero and the color-define bit are reserved fingerprint values. Remapping
  // both keeps generated-source cache identities nonzero and preserves the
  // stable fingerprint contract consumed by persisted diagnostics.
  let hash = hashStringFNV1a(chunk);
  if (hash === 0 || hash === ShaderDefine.VOXEL_CUSTOM_SHADER_COLOR >>> 0) {
    hash = (hash ^ 0x9e3779b9) >>> 0;
  }

  return { chunk, hash };
}
