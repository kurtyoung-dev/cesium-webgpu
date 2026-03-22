// ModelPBRComplete.wgsl — Comprehensive PBR shader for glTF models
// Combined vertex + fragment shader for WebGPU Model rendering.
// Supports: metallic-roughness, specular-glossiness, unlit, all texture types,
// alpha modes (OPAQUE, MASK, BLEND), normal mapping, double-sided, vertex colors.
//
// Model positions remain in model coordinates (3 floats, NOT high/low split).
// Camera position is encoded in model space via inverse(modelMatrix) * cameraPositionWC.
//
// Material features controlled by materialFlags bitfield uniform:
//   bit 0:  HAS_BASE_COLOR_TEXTURE
//   bit 1:  HAS_NORMAL_TEXTURE
//   bit 2:  HAS_METALLIC_ROUGHNESS_TEXTURE
//   bit 3:  HAS_EMISSIVE_TEXTURE
//   bit 4:  HAS_OCCLUSION_TEXTURE
//   bit 5:  HAS_VERTEX_COLORS
//   bit 6:  ALPHA_MODE_MASK
//   bit 7:  ALPHA_MODE_BLEND
//   bit 8:  IS_DOUBLE_SIDED
//   bit 9:  IS_UNLIT
//   bit 10: USE_SPECULAR_GLOSSINESS
//   bit 11: HAS_SPECULAR_GLOSSINESS_TEXTURE
//   bit 12: HAS_DIFFUSE_TEXTURE
//   bit 13: HAS_SKINNING
//
// Skinning pipeline:
//   Joint matrices computed on CPU (ModelSkin.js + ModelRuntimeNode.js — shared)
//   Packed into Float32Array (ModelSkinData.js — shared extractor)
//   Uploaded to storage buffer (WebGPUModelRenderer.js — GPU-specific)
//   Applied per-vertex in this shader (JOINTS_0 + WEIGHTS_0 → weighted blend)
//   Skinning happens IN MODEL SPACE, BEFORE the RTE subtraction — correct order.

// ─── Material Flag Constants ─────────────────────────────────────────────────

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
const FLAG_HAS_SKINNING: u32                   = 8192u;

// ─── Uniform Structures ──────────────────────────────────────────────────────

struct CameraUniforms {
  mvpRelativeToEye: mat4x4<f32>,
  modelViewRelativeToEye: mat4x4<f32>,
  normalMatrix: mat4x4<f32>,
  encodedCameraPositionMCHigh: vec3<f32>,
  _pad0: f32,
  encodedCameraPositionMCLow: vec3<f32>,
  _pad1: f32,
  cameraPositionWC: vec3<f32>,
  _pad2: f32,
};

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
  specularFactor_r: f32,
  specularFactor_g: f32,
  specularFactor_b: f32,
  glossinessFactor: f32,
  diffuseFactor_r: f32,
  diffuseFactor_g: f32,
  diffuseFactor_b: f32,
  diffuseFactor_a: f32,
  _pad_end: f32,
  _pad_end2: f32,
  _pad_end3: f32,
};

struct LightUniforms {
  sunDirectionEC: vec3<f32>,
  _pad0: f32,
  sunColor: vec3<f32>,
  sunIntensity: f32,
  ambientColor: vec3<f32>,
  _pad1: f32,
};

// ─── Bind Groups ─────────────────────────────────────────────────────────────

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> material: MaterialUniforms;
@group(1) @binding(1) var<uniform> light: LightUniforms;

// Textures — bind 1x1 default textures when not available
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

// Joint matrices for skinning (bind group 3, only used when FLAG_HAS_SKINNING is set)
@group(3) @binding(0) var<storage, read> jointMatrices: array<mat4x4<f32>>;

// ─── Vertex Shader ───────────────────────────────────────────────────────────

struct VertexInput {
  @location(0) positionMC: vec3<f32>,
  @location(1) normalMC: vec3<f32>,
  @location(2) tangentMC: vec4<f32>,
  @location(3) texCoord0: vec2<f32>,
  @location(4) color0: vec4<f32>,
  @location(5) joints0: vec4<u32>,
  @location(6) weights0: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) positionEC: vec3<f32>,
  @location(1) normalEC: vec3<f32>,
  @location(2) texCoord0: vec2<f32>,
  @location(3) color0: vec4<f32>,
  @location(4) tangentEC: vec3<f32>,
  @location(5) bitangentEC: vec3<f32>,
};

@vertex fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;

  var positionMC = input.positionMC;
  var normalMC = input.normalMC;
  var tangentMC = input.tangentMC;

  // ── Skinning ──────────────────────────────────────────────────────────────
  // When FLAG_HAS_SKINNING is set, apply joint matrix weighted blend to
  // position, normal, and tangent. Matches the GLSL SkinningStageVS.glsl logic:
  //   skinMatrix = w.x * J[j.x] + w.y * J[j.y] + w.z * J[j.z] + w.w * J[j.w]
  if (hasFlag(material.materialFlags, FLAG_HAS_SKINNING)) {
    let j = input.joints0;
    let w = input.weights0;
    let skinMatrix = w.x * jointMatrices[j.x]
                   + w.y * jointMatrices[j.y]
                   + w.z * jointMatrices[j.z]
                   + w.w * jointMatrices[j.w];
    let skinMatrix3 = mat3x3<f32>(skinMatrix[0].xyz, skinMatrix[1].xyz, skinMatrix[2].xyz);
    positionMC = (skinMatrix * vec4<f32>(positionMC, 1.0)).xyz;
    normalMC = skinMatrix3 * normalMC;
    tangentMC = vec4<f32>(skinMatrix3 * tangentMC.xyz, tangentMC.w);
  }

  // RTE in model space: camera is encoded in model coords via inverse(modelMatrix)
  let rte = (positionMC - camera.encodedCameraPositionMCHigh)
          + (vec3<f32>(0.0) - camera.encodedCameraPositionMCLow);

  output.position = camera.mvpRelativeToEye * vec4<f32>(rte, 1.0);
  output.positionEC = (camera.modelViewRelativeToEye * vec4<f32>(rte, 1.0)).xyz;
  output.normalEC = normalize((camera.normalMatrix * vec4<f32>(normalMC, 0.0)).xyz);
  output.texCoord0 = input.texCoord0;
  output.color0 = input.color0;

  // Tangent/Bitangent for normal mapping
  let tangentEC3 = normalize((camera.normalMatrix * vec4<f32>(tangentMC.xyz, 0.0)).xyz);
  output.tangentEC = tangentEC3;
  output.bitangentEC = cross(output.normalEC, tangentEC3) * tangentMC.w;

  return output;
}

// ─── PBR Helper Functions ────────────────────────────────────────────────────

const PI: f32 = 3.14159265358979323846;

fn hasFlag(flags: u32, flag: u32) -> bool {
  return (flags & flag) != 0u;
}

fn distributionGGX(NdotH: f32, roughness: f32) -> f32 {
  let a = roughness * roughness;
  let a2 = a * a;
  let d = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d + 0.0001);
}

fn geometrySchlickGGX(NdotV: f32, roughness: f32) -> f32 {
  let r = roughness + 1.0;
  let k = (r * r) / 8.0;
  return NdotV / (NdotV * (1.0 - k) + k + 0.0001);
}

fn geometrySmith(NdotV: f32, NdotL: f32, roughness: f32) -> f32 {
  return geometrySchlickGGX(NdotV, roughness) * geometrySchlickGGX(NdotL, roughness);
}

fn fresnelSchlick(cosTheta: f32, F0: vec3<f32>) -> vec3<f32> {
  let t = clamp(1.0 - cosTheta, 0.0, 1.0);
  let t2 = t * t;
  return F0 + (vec3<f32>(1.0) - F0) * (t2 * t2 * t);
}

fn srgbToLinear(srgb: vec3<f32>) -> vec3<f32> {
  return pow(srgb, vec3<f32>(2.2));
}

fn tonemapAndGamma(color: vec3<f32>) -> vec3<f32> {
  let mapped = color / (color + vec3<f32>(1.0));
  return pow(mapped, vec3<f32>(1.0 / 2.2));
}

fn perturbNormal(nEC: vec3<f32>, tEC: vec3<f32>, bEC: vec3<f32>,
                 normalMap: vec3<f32>, scale: f32) -> vec3<f32> {
  var tn = normalMap * 2.0 - vec3<f32>(1.0);
  tn = vec3<f32>(tn.xy * scale, tn.z);
  tn = normalize(tn);
  let T = normalize(tEC);
  let B = normalize(bEC);
  let N = normalize(nEC);
  return normalize(T * tn.x + B * tn.y + N * tn.z);
}

// ─── Fragment Shader ─────────────────────────────────────────────────────────

struct FragmentInput {
  @location(0) positionEC: vec3<f32>,
  @location(1) normalEC: vec3<f32>,
  @location(2) texCoord0: vec2<f32>,
  @location(3) color0: vec4<f32>,
  @location(4) tangentEC: vec3<f32>,
  @location(5) bitangentEC: vec3<f32>,
  @builtin(front_facing) frontFacing: bool,
};

@fragment fn fragmentMain(input: FragmentInput) -> @location(0) vec4<f32> {
  let flags = material.materialFlags;

  // ── Base color ────────────────────────────────────────────────────────────
  var baseColor = material.baseColorFactor;

  if (hasFlag(flags, FLAG_USE_SPECULAR_GLOSSINESS)) {
    baseColor = vec4<f32>(material.diffuseFactor_r, material.diffuseFactor_g,
                          material.diffuseFactor_b, material.diffuseFactor_a);
    if (hasFlag(flags, FLAG_HAS_DIFFUSE_TEXTURE)) {
      let tc = textureSample(baseColorTexture, baseColorSampler, input.texCoord0);
      baseColor = baseColor * vec4<f32>(srgbToLinear(tc.rgb), tc.a);
    }
  } else {
    if (hasFlag(flags, FLAG_HAS_BASE_COLOR_TEXTURE)) {
      let tc = textureSample(baseColorTexture, baseColorSampler, input.texCoord0);
      baseColor = baseColor * vec4<f32>(srgbToLinear(tc.rgb), tc.a);
    }
  }

  if (hasFlag(flags, FLAG_HAS_VERTEX_COLORS)) {
    baseColor = baseColor * input.color0;
  }

  // ── Alpha test ────────────────────────────────────────────────────────────
  if (hasFlag(flags, FLAG_ALPHA_MODE_MASK)) {
    if (baseColor.a < material.alphaCutoff) { discard; }
    baseColor = vec4<f32>(baseColor.rgb, 1.0);
  }

  // ── Unlit early-out ───────────────────────────────────────────────────────
  if (hasFlag(flags, FLAG_IS_UNLIT)) {
    var c = baseColor.rgb + material.emissiveFactor;
    c = tonemapAndGamma(c);
    let a = select(1.0, baseColor.a, hasFlag(flags, FLAG_ALPHA_MODE_BLEND));
    return vec4<f32>(c, a);
  }

  // ── Normal ────────────────────────────────────────────────────────────────
  var N = normalize(input.normalEC);
  if (hasFlag(flags, FLAG_IS_DOUBLE_SIDED) && !input.frontFacing) { N = -N; }
  if (hasFlag(flags, FLAG_HAS_NORMAL_TEXTURE)) {
    let nm = textureSample(normalTexture, normalSampler, input.texCoord0).rgb;
    N = perturbNormal(N, input.tangentEC, input.bitangentEC, nm, material.normalScale);
  }

  // ── Material properties ───────────────────────────────────────────────────
  var metallic: f32;
  var roughness: f32;
  var F0: vec3<f32>;
  var diffuseColor: vec3<f32>;

  if (hasFlag(flags, FLAG_USE_SPECULAR_GLOSSINESS)) {
    var spec = vec3<f32>(material.specularFactor_r, material.specularFactor_g, material.specularFactor_b);
    var gloss = material.glossinessFactor;
    if (hasFlag(flags, FLAG_HAS_SPECGLOSS_TEXTURE)) {
      let sg = textureSample(metallicRoughnessTexture, metallicRoughnessSampler, input.texCoord0);
      spec = spec * srgbToLinear(sg.rgb);
      gloss = gloss * sg.a;
    }
    F0 = spec;
    roughness = clamp(1.0 - gloss, 0.04, 1.0);
    metallic = max(max(spec.r, spec.g), spec.b);
    diffuseColor = baseColor.rgb * (1.0 - metallic);
  } else {
    metallic = material.metallicFactor;
    roughness = material.roughnessFactor;
    if (hasFlag(flags, FLAG_HAS_METALLIC_ROUGHNESS_TEXTURE)) {
      let mr = textureSample(metallicRoughnessTexture, metallicRoughnessSampler, input.texCoord0);
      roughness = roughness * mr.g;
      metallic = metallic * mr.b;
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

  let D = distributionGGX(NdotH, roughness);
  let G = geometrySmith(NdotV, NdotL, roughness);
  let F = fresnelSchlick(VdotH, F0);
  let specBRDF = D * G * F / (4.0 * NdotV * NdotL + 0.0001);

  let kD = (vec3<f32>(1.0) - F) * (1.0 - metallic);
  let direct = (kD * diffuseColor / PI + specBRDF) * light.sunColor * light.sunIntensity * NdotL;

  // ── Ambient ───────────────────────────────────────────────────────────────
  var ambient = light.ambientColor * diffuseColor + light.ambientColor * F0 * 0.2;

  // ── Occlusion ─────────────────────────────────────────────────────────────
  if (hasFlag(flags, FLAG_HAS_OCCLUSION_TEXTURE)) {
    let ao = textureSample(occlusionTexture, occlusionSampler, input.texCoord0).r;
    ambient = mix(ambient, ambient * ao, material.occlusionStrength);
  }

  // ── Emissive ──────────────────────────────────────────────────────────────
  var emissive = material.emissiveFactor;
  if (hasFlag(flags, FLAG_HAS_EMISSIVE_TEXTURE)) {
    let et = textureSample(emissiveTexture, emissiveSampler, input.texCoord0).rgb;
    emissive = emissive * srgbToLinear(et);
  }

  // ── Final composition ─────────────────────────────────────────────────────
  var color = direct + ambient + emissive;
  color = tonemapAndGamma(color);
  let alpha = select(1.0, baseColor.a, hasFlag(flags, FLAG_ALPHA_MODE_BLEND));
  return vec4<f32>(color, alpha);
}
