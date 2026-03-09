// ModelPBR.wgsl — PBR glTF model rendering for CesiumJS WebGPU
// This is a base shader that WGSLShaderBuilder can extend with pipeline stages.
// Supports: positions (RTE), normals, texcoords, vertex colors, PBR metallic-roughness

struct CameraUniforms {
  mvpRelativeToEye: mat4x4<f32>,
  modelViewRelativeToEye: mat4x4<f32>,
  normalMatrix: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>,
  _pad0: f32,
  encodedCameraLow: vec3<f32>,
  _pad1: f32,
  cameraPositionWC: vec3<f32>,
  _pad2: f32,
};

struct ModelUniforms {
  modelMatrix: mat4x4<f32>,
  baseColorFactor: vec4<f32>,
  emissiveFactor: vec3<f32>,
  metallicFactor: f32,
  roughnessFactor: f32,
  alphaCutoff: f32,
  normalScale: f32,
  occlusionStrength: f32,
};

struct LightUniforms {
  sunDirectionEC: vec3<f32>,
  _pad0: f32,
  sunColor: vec3<f32>,
  sunIntensity: f32,
  ambientColor: vec3<f32>,
  _pad1: f32,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> model: ModelUniforms;
@group(1) @binding(1) var<uniform> light: LightUniforms;
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

struct VertexInput {
  @location(0) positionHigh: vec3<f32>,
  @location(1) positionLow: vec3<f32>,
  @location(2) normal: vec3<f32>,
  @location(3) texCoord0: vec2<f32>,
  @location(4) tangent: vec4<f32>,
  @location(5) vertexColor: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) texCoord0: vec2<f32>,
  @location(1) normalEC: vec3<f32>,
  @location(2) positionEC: vec3<f32>,
  @location(3) tangentEC: vec3<f32>,
  @location(4) bitangentEC: vec3<f32>,
  @location(5) vertexColor: vec4<f32>,
};

const PI: f32 = 3.14159265358979323846;

fn translateRelativeToEye(posHigh: vec3<f32>, posLow: vec3<f32>, camHigh: vec3<f32>, camLow: vec3<f32>) -> vec3<f32> {
  return (posHigh - camHigh) + (posLow - camLow);
}

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let posRTE = translateRelativeToEye(
    input.positionHigh, input.positionLow,
    camera.encodedCameraHigh, camera.encodedCameraLow
  );
  output.position = camera.mvpRelativeToEye * vec4<f32>(posRTE, 1.0);
  output.positionEC = (camera.modelViewRelativeToEye * vec4<f32>(posRTE, 1.0)).xyz;
  output.normalEC = normalize((camera.normalMatrix * vec4<f32>(input.normal, 0.0)).xyz);
  output.texCoord0 = input.texCoord0;
  output.tangentEC = normalize((camera.normalMatrix * vec4<f32>(input.tangent.xyz, 0.0)).xyz);
  output.bitangentEC = cross(output.normalEC, output.tangentEC) * input.tangent.w;
  output.vertexColor = input.vertexColor;
  return output;
}

// PBR functions
fn distributionGGX(N: vec3<f32>, H: vec3<f32>, roughness: f32) -> f32 {
  let a = roughness * roughness;
  let a2 = a * a;
  let NdotH = max(dot(N, H), 0.0);
  let NdotH2 = NdotH * NdotH;
  let denom = NdotH2 * (a2 - 1.0) + 1.0;
  return a2 / (PI * denom * denom);
}

fn geometrySchlickGGX(NdotV: f32, roughness: f32) -> f32 {
  let r = roughness + 1.0;
  let k = (r * r) / 8.0;
  return NdotV / (NdotV * (1.0 - k) + k);
}

fn geometrySmith(N: vec3<f32>, V: vec3<f32>, L: vec3<f32>, roughness: f32) -> f32 {
  let NdotV = max(dot(N, V), 0.0);
  let NdotL = max(dot(N, L), 0.0);
  return geometrySchlickGGX(NdotV, roughness) * geometrySchlickGGX(NdotL, roughness);
}

fn fresnelSchlick(cosTheta: f32, F0: vec3<f32>) -> vec3<f32> {
  return F0 + (vec3<f32>(1.0) - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

fn getNormalFromMap(normalEC: vec3<f32>, tangentEC: vec3<f32>, bitangentEC: vec3<f32>, texCoord: vec2<f32>) -> vec3<f32> {
  let tangentNormal = textureSample(normalTexture, normalSampler, texCoord).xyz * 2.0 - 1.0;
  let scaledNormal = tangentNormal * vec3<f32>(model.normalScale, model.normalScale, 1.0);
  let TBN = mat3x3<f32>(tangentEC, bitangentEC, normalEC);
  return normalize(TBN * scaledNormal);
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  // Base color
  var baseColor = textureSample(baseColorTexture, baseColorSampler, input.texCoord0);
  baseColor *= model.baseColorFactor;
  baseColor *= input.vertexColor;

  // Alpha test
  if (baseColor.a < model.alphaCutoff) {
    discard;
  }

  // Normal mapping
  var N = normalize(input.normalEC);
  N = getNormalFromMap(N, input.tangentEC, input.bitangentEC, input.texCoord0);

  // Metallic-roughness
  let mrSample = textureSample(metallicRoughnessTexture, metallicRoughnessSampler, input.texCoord0);
  let metallic = mrSample.b * model.metallicFactor;
  let roughness = clamp(mrSample.g * model.roughnessFactor, 0.04, 1.0);

  // View direction
  let V = normalize(-input.positionEC);
  let L = normalize(light.sunDirectionEC);
  let H = normalize(V + L);

  // F0 for dielectrics is 0.04, for metals it's the base color
  let F0 = mix(vec3<f32>(0.04), baseColor.rgb, metallic);

  // Cook-Torrance BRDF
  let NDF = distributionGGX(N, H, roughness);
  let G = geometrySmith(N, V, L, roughness);
  let F = fresnelSchlick(max(dot(H, V), 0.0), F0);

  let numerator = NDF * G * F;
  let denominator = 4.0 * max(dot(N, V), 0.0) * max(dot(N, L), 0.0) + 0.0001;
  let specular = numerator / denominator;

  let kS = F;
  let kD = (vec3<f32>(1.0) - kS) * (1.0 - metallic);

  let NdotL = max(dot(N, L), 0.0);
  var Lo = (kD * baseColor.rgb / PI + specular) * light.sunColor * light.sunIntensity * NdotL;

  // Ambient
  let ao = textureSample(occlusionTexture, occlusionSampler, input.texCoord0).r;
  let ambient = light.ambientColor * baseColor.rgb * mix(1.0, ao, model.occlusionStrength);

  // Emissive
  let emissive = textureSample(emissiveTexture, emissiveSampler, input.texCoord0).rgb * model.emissiveFactor;

  var color = ambient + Lo + emissive;

  // Tonemap (Reinhard)
  color = color / (color + vec3<f32>(1.0));
  // Gamma correction
  color = pow(color, vec3<f32>(1.0 / 2.2));

  return vec4<f32>(color, baseColor.a);
}
