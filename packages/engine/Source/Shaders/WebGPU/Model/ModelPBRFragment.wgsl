// ModelPBRFragment.wgsl — Comprehensive PBR fragment shader for glTF models
// Supports: metallic-roughness, specular-glossiness, unlit, all texture types,
// alpha modes (OPAQUE, MASK, BLEND), normal mapping, IBL ambient.
//
// Material features controlled by materialFlags bitfield uniform:
//   bit 0: HAS_BASE_COLOR_TEXTURE
//   bit 1: HAS_NORMAL_TEXTURE
//   bit 2: HAS_METALLIC_ROUGHNESS_TEXTURE
//   bit 3: HAS_EMISSIVE_TEXTURE
//   bit 4: HAS_OCCLUSION_TEXTURE
//   bit 5: HAS_VERTEX_COLORS
//   bit 6: ALPHA_MODE_MASK
//   bit 7: ALPHA_MODE_BLEND
//   bit 8: IS_DOUBLE_SIDED
//   bit 9: IS_UNLIT
//   bit 10: USE_SPECULAR_GLOSSINESS (else metallic-roughness)
//   bit 11: HAS_SPECULAR_GLOSSINESS_TEXTURE
//   bit 12: HAS_DIFFUSE_TEXTURE

const FLAG_HAS_BASE_COLOR_TEXTURE: u32         = 1u;
const FLAG_HAS_NORMAL_TEXTURE: u32             = 2u;
const FLAG_HAS_METALLIC_ROUGHNESS_TEXTURE: u32 = 4u;
const FLAG_HAS_EMISSIVE_TEXTURE: u32           = 8u;
const FLAG_HAS_OCCLUSION_TEXTURE: u32          = 16u;
const FLAG_HAS_VERTEX_COLORS: u32              = 32u;
const FLAG_ALPHA_MODE_MASK: u32                = 64u;
const FLAG_ALPHA_MODE_BLEND: u32               = 128u;
const FLAG_IS_DOUBLE_SIDED: u32                = 256u;
const FLAG_IS_UNLIT: u32                       = 512u;
const FLAG_USE_SPECULAR_GLOSSINESS: u32        = 1024u;
const FLAG_HAS_SPECGLOSS_TEXTURE: u32          = 2048u;
const FLAG_HAS_DIFFUSE_TEXTURE: u32            = 4096u;

struct MaterialUniforms {
  modelMatrix: mat4x4<f32>,
  baseColorFactor: vec4<f32>,
  emissiveFactor: vec3<f32>,
  metallicFactor: f32,
  roughnessFactor: f32,
  alphaCutoff: f32,
  normalScale: f32,
  occlusionStrength: f32,
  materialFlags: u32,
  // SpecGloss fallback values (packed after flags)
  specularFactor_r: f32,
  specularFactor_g: f32,
  specularFactor_b: f32,
  glossinessFactor: f32,
  diffuseFactor_r: f32,
  diffuseFactor_g: f32,
  diffuseFactor_b: f32,
  diffuseFactor_a: f32,
};

struct LightUniforms {
  sunDirectionEC: vec3<f32>,
  _pad0: f32,
  sunColor: vec3<f32>,
  sunIntensity: f32,
  ambientColor: vec3<f32>,
  _pad1: f32,
};

@group(1) @binding(0) var<uniform> material: MaterialUniforms;
@group(1) @binding(1) var<uniform> light: LightUniforms;

// Texture bindings — when a texture is not available, bind a 1x1 white/default texture
@group(2) @binding(0) var baseColorTexture: texture_2d<f32>;
@group(2) @binding(1) var baseColorSampler: sampler;
@group(2) @binding(2) var normalTexture: texture_2d<f32>;
@group(2) @binding(3) var normalSampler: sampler;
@group(2) @binding(4) var metallicRoughnessTexture: texture_2d<f32>;
@group(2) @binding(5) var metallicRoughnessSampler: sampler;
@group(2) @binding(6) var emissiveTexture: texture_2d<f32>;
@group(2) @binding(7) var emissiveSampler: sampler;
@group(2) @binding(8) var occlusionTexture: texture_2d<f32>;
@group(2) @binding(9) var occlusionSampler: sampler;

struct FragmentInput {
  @location(0) positionEC: vec3<f32>,
  @location(1) normalEC: vec3<f32>,
  @location(2) texCoord0: vec2<f32>,
  @location(3) color0: vec4<f32>,
  @location(4) tangentEC: vec3<f32>,
  @location(5) bitangentEC: vec3<f32>,
  @builtin(front_facing) frontFacing: bool,
};

// ─── PBR Helper Functions ────────────────────────────────────────────────────

const PI: f32 = 3.14159265358979323846;

// Normal Distribution Function (GGX/Trowbridge-Reitz)
fn distributionGGX(NdotH: f32, roughness: f32) -> f32 {
  let a = roughness * roughness;
  let a2 = a * a;
  let d = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d + 0.0001);
}

// Geometry function (Smith's method with Schlick-GGX)
fn geometrySchlickGGX(NdotV: f32, roughness: f32) -> f32 {
  let r = roughness + 1.0;
  let k = (r * r) / 8.0;
  return NdotV / (NdotV * (1.0 - k) + k + 0.0001);
}

fn geometrySmith(NdotV: f32, NdotL: f32, roughness: f32) -> f32 {
  return geometrySchlickGGX(NdotV, roughness) * geometrySchlickGGX(NdotL, roughness);
}

// Fresnel (Schlick approximation)
fn fresnelSchlick(cosTheta: f32, F0: vec3<f32>) -> vec3<f32> {
  let t = clamp(1.0 - cosTheta, 0.0, 1.0);
  let t2 = t * t;
  return F0 + (vec3<f32>(1.0) - F0) * (t2 * t2 * t);
}

// Convert sRGB to linear
fn srgbToLinear(srgb: vec3<f32>) -> vec3<f32> {
  return pow(srgb, vec3<f32>(2.2));
}

// Reinhard tonemapping + gamma correction
fn tonemapAndGamma(color: vec3<f32>) -> vec3<f32> {
  let mapped = color / (color + vec3<f32>(1.0));
  return pow(mapped, vec3<f32>(1.0 / 2.2));
}

// Perturb normal using normal map (TBN matrix)
fn perturbNormal(normalEC: vec3<f32>, tangentEC: vec3<f32>, bitangentEC: vec3<f32>,
                 normalMap: vec3<f32>, scale: f32) -> vec3<f32> {
  // Normal map is in tangent space [0,1] → [-1,1]
  var tangentNormal = normalMap * 2.0 - vec3<f32>(1.0);
  tangentNormal = vec3<f32>(tangentNormal.xy * scale, tangentNormal.z);
  tangentNormal = normalize(tangentNormal);

  // TBN matrix: tangent-space to eye-space
  let T = normalize(tangentEC);
  let B = normalize(bitangentEC);
  let N = normalize(normalEC);
  return normalize(T * tangentNormal.x + B * tangentNormal.y + N * tangentNormal.z);
}

fn hasFlag(flags: u32, flag: u32) -> bool {
  return (flags & flag) != 0u;
}

// ─── Main Fragment Shader ────────────────────────────────────────────────────

@fragment fn fragmentMain(input: FragmentInput) -> @location(0) vec4<f32> {
  let flags = material.materialFlags;

  // ── Determine base color ──────────────────────────────────────────────────
  var baseColor = material.baseColorFactor;

  if (hasFlag(flags, FLAG_USE_SPECULAR_GLOSSINESS)) {
    // SpecGloss: use diffuseFactor as base color
    baseColor = vec4<f32>(
      material.diffuseFactor_r,
      material.diffuseFactor_g,
      material.diffuseFactor_b,
      material.diffuseFactor_a
    );
    if (hasFlag(flags, FLAG_HAS_DIFFUSE_TEXTURE)) {
      let texColor = textureSample(baseColorTexture, baseColorSampler, input.texCoord0);
      baseColor = baseColor * vec4<f32>(srgbToLinear(texColor.rgb), texColor.a);
    }
  } else {
    // MetallicRoughness: use baseColorFactor
    if (hasFlag(flags, FLAG_HAS_BASE_COLOR_TEXTURE)) {
      let texColor = textureSample(baseColorTexture, baseColorSampler, input.texCoord0);
      baseColor = baseColor * vec4<f32>(srgbToLinear(texColor.rgb), texColor.a);
    }
  }

  // Apply vertex colors
  if (hasFlag(flags, FLAG_HAS_VERTEX_COLORS)) {
    baseColor = baseColor * input.color0;
  }

  // ── Alpha handling ────────────────────────────────────────────────────────
  if (hasFlag(flags, FLAG_ALPHA_MODE_MASK)) {
    if (baseColor.a < material.alphaCutoff) {
      discard;
    }
    // For MASK mode, set alpha to 1.0 after test
    baseColor = vec4<f32>(baseColor.rgb, 1.0);
  }

  // ── Unlit path (early out) ────────────────────────────────────────────────
  if (hasFlag(flags, FLAG_IS_UNLIT)) {
    let emissive = material.emissiveFactor;
    var finalColor = baseColor.rgb + emissive;
    finalColor = tonemapAndGamma(finalColor);
    if (hasFlag(flags, FLAG_ALPHA_MODE_BLEND)) {
      return vec4<f32>(finalColor, baseColor.a);
    }
    return vec4<f32>(finalColor, 1.0);
  }

  // ── Normal computation ────────────────────────────────────────────────────
  var N = normalize(input.normalEC);

  // Handle double-sided: flip normal for back faces
  if (hasFlag(flags, FLAG_IS_DOUBLE_SIDED) && !input.frontFacing) {
    N = -N;
  }

  // Apply normal map if available
  if (hasFlag(flags, FLAG_HAS_NORMAL_TEXTURE)) {
    let normalMapValue = textureSample(normalTexture, normalSampler, input.texCoord0).rgb;
    N = perturbNormal(N, input.tangentEC, input.bitangentEC,
                      normalMapValue, material.normalScale);
  }

  // ── Material properties ───────────────────────────────────────────────────
  var metallic: f32;
  var roughness: f32;
  var F0: vec3<f32>;
  var diffuseColor: vec3<f32>;

  if (hasFlag(flags, FLAG_USE_SPECULAR_GLOSSINESS)) {
    // SpecGloss workflow
    var specular = vec3<f32>(
      material.specularFactor_r,
      material.specularFactor_g,
      material.specularFactor_b
    );
    var glossiness = material.glossinessFactor;

    if (hasFlag(flags, FLAG_HAS_SPECGLOSS_TEXTURE)) {
      let sgTex = textureSample(metallicRoughnessTexture, metallicRoughnessSampler, input.texCoord0);
      specular = specular * srgbToLinear(sgTex.rgb);
      glossiness = glossiness * sgTex.a;
    }

    F0 = specular;
    roughness = clamp(1.0 - glossiness, 0.04, 1.0);
    // Approximate metallic from specular for energy conservation
    metallic = max(max(specular.r, specular.g), specular.b);
    diffuseColor = baseColor.rgb * (1.0 - metallic);
  } else {
    // Metallic-Roughness workflow
    metallic = material.metallicFactor;
    roughness = material.roughnessFactor;

    if (hasFlag(flags, FLAG_HAS_METALLIC_ROUGHNESS_TEXTURE)) {
      let mrTex = textureSample(metallicRoughnessTexture, metallicRoughnessSampler, input.texCoord0);
      roughness = roughness * mrTex.g; // Green channel = roughness
      metallic = metallic * mrTex.b;   // Blue channel = metallic
    }

    roughness = clamp(roughness, 0.04, 1.0);
    metallic = clamp(metallic, 0.0, 1.0);
    F0 = mix(vec3<f32>(0.04), baseColor.rgb, metallic);
    diffuseColor = baseColor.rgb * (1.0 - metallic);
  }

  // ── Cook-Torrance BRDF ────────────────────────────────────────────────────
  let V = normalize(-input.positionEC);
  let L = normalize(light.sunDirectionEC);
  let H = normalize(V + L);

  let NdotL = max(dot(N, L), 0.0);
  let NdotV = max(dot(N, V), 0.001);
  let NdotH = max(dot(N, H), 0.0);
  let VdotH = max(dot(V, H), 0.0);

  // Specular BRDF: D * G * F / (4 * NdotV * NdotL)
  let D = distributionGGX(NdotH, roughness);
  let G = geometrySmith(NdotV, NdotL, roughness);
  let F = fresnelSchlick(VdotH, F0);

  let numerator = D * G * F;
  let denominator = 4.0 * NdotV * NdotL + 0.0001;
  let specularBRDF = numerator / denominator;

  // Energy conservation: diffuse + specular ≤ 1
  let kS = F;
  let kD = (vec3<f32>(1.0) - kS) * (1.0 - metallic);

  // Direct lighting
  let directDiffuse = kD * diffuseColor / PI;
  let directLighting = (directDiffuse + specularBRDF) * light.sunColor * light.sunIntensity * NdotL;

  // ── Ambient / IBL approximation ───────────────────────────────────────────
  let ambientDiffuse = light.ambientColor * diffuseColor;
  let ambientSpecular = light.ambientColor * F0 * 0.2; // Very rough IBL approximation
  var ambient = ambientDiffuse + ambientSpecular;

  // ── Occlusion ─────────────────────────────────────────────────────────────
  if (hasFlag(flags, FLAG_HAS_OCCLUSION_TEXTURE)) {
    let ao = textureSample(occlusionTexture, occlusionSampler, input.texCoord0).r;
    ambient = mix(ambient, ambient * ao, material.occlusionStrength);
  }

  // ── Emissive ──────────────────────────────────────────────────────────────
  var emissive = material.emissiveFactor;
  if (hasFlag(flags, FLAG_HAS_EMISSIVE_TEXTURE)) {
    let emTex = textureSample(emissiveTexture, emissiveSampler, input.texCoord0).rgb;
    emissive = emissive * srgbToLinear(emTex);
  }

  // ── Final composition ─────────────────────────────────────────────────────
  var finalColor = directLighting + ambient + emissive;

  // Tonemapping + gamma
  finalColor = tonemapAndGamma(finalColor);

  // Output alpha
  var alpha: f32 = 1.0;
  if (hasFlag(flags, FLAG_ALPHA_MODE_BLEND)) {
    alpha = baseColor.a;
  }

  return vec4<f32>(finalColor, alpha);
}
