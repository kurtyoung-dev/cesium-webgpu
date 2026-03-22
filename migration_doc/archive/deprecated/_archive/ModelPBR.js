//This file is automatically rebuilt by the Cesium build process.
export default "// ModelPBR.wgsl — PBR glTF model rendering for CesiumJS WebGPU\n\
// This is a base shader that WGSLShaderBuilder can extend with pipeline stages.\n\
// Supports: positions (RTE), normals, texcoords, vertex colors, PBR metallic-roughness\n\
\n\
struct CameraUniforms {\n\
  mvpRelativeToEye: mat4x4<f32>,\n\
  modelViewRelativeToEye: mat4x4<f32>,\n\
  normalMatrix: mat4x4<f32>,\n\
  encodedCameraHigh: vec3<f32>,\n\
  _pad0: f32,\n\
  encodedCameraLow: vec3<f32>,\n\
  _pad1: f32,\n\
  cameraPositionWC: vec3<f32>,\n\
  _pad2: f32,\n\
};\n\
\n\
struct ModelUniforms {\n\
  modelMatrix: mat4x4<f32>,\n\
  baseColorFactor: vec4<f32>,\n\
  emissiveFactor: vec3<f32>,\n\
  metallicFactor: f32,\n\
  roughnessFactor: f32,\n\
  alphaCutoff: f32,\n\
  normalScale: f32,\n\
  occlusionStrength: f32,\n\
};\n\
\n\
struct LightUniforms {\n\
  sunDirectionEC: vec3<f32>,\n\
  _pad0: f32,\n\
  sunColor: vec3<f32>,\n\
  sunIntensity: f32,\n\
  ambientColor: vec3<f32>,\n\
  _pad1: f32,\n\
};\n\
\n\
@group(0) @binding(0) var<uniform> camera: CameraUniforms;\n\
@group(1) @binding(0) var<uniform> model: ModelUniforms;\n\
@group(1) @binding(1) var<uniform> light: LightUniforms;\n\
@group(2) @binding(0) var baseColorTexture: texture_2d<f32>;\n\
@group(2) @binding(1) var baseColorSampler: sampler;\n\
@group(2) @binding(2) var normalTexture: texture_2d<f32>;\n\
@group(2) @binding(3) var normalSampler: sampler;\n\
@group(2) @binding(4) var metallicRoughnessTexture: texture_2d<f32>;\n\
@group(2) @binding(5) var metallicRoughnessSampler: sampler;\n\
@group(2) @binding(6) var emissiveTexture: texture_2d<f32>;\n\
@group(2) @binding(7) var emissiveSampler: sampler;\n\
@group(2) @binding(8) var occlusionTexture: texture_2d<f32>;\n\
@group(2) @binding(9) var occlusionSampler: sampler;\n\
\n\
struct VertexInput {\n\
  @location(0) positionHigh: vec3<f32>,\n\
  @location(1) positionLow: vec3<f32>,\n\
  @location(2) normal: vec3<f32>,\n\
  @location(3) texCoord0: vec2<f32>,\n\
  @location(4) tangent: vec4<f32>,\n\
  @location(5) vertexColor: vec4<f32>,\n\
};\n\
\n\
struct VertexOutput {\n\
  @builtin(position) position: vec4<f32>,\n\
  @location(0) texCoord0: vec2<f32>,\n\
  @location(1) normalEC: vec3<f32>,\n\
  @location(2) positionEC: vec3<f32>,\n\
  @location(3) tangentEC: vec3<f32>,\n\
  @location(4) bitangentEC: vec3<f32>,\n\
  @location(5) vertexColor: vec4<f32>,\n\
};\n\
\n\
const PI: f32 = 3.14159265358979323846;\n\
\n\
fn translateRelativeToEye(posHigh: vec3<f32>, posLow: vec3<f32>, camHigh: vec3<f32>, camLow: vec3<f32>) -> vec3<f32> {\n\
  return (posHigh - camHigh) + (posLow - camLow);\n\
}\n\
\n\
@vertex\n\
fn vertexMain(input: VertexInput) -> VertexOutput {\n\
  var output: VertexOutput;\n\
  let posRTE = translateRelativeToEye(\n\
    input.positionHigh, input.positionLow,\n\
    camera.encodedCameraHigh, camera.encodedCameraLow\n\
  );\n\
  output.position = camera.mvpRelativeToEye * vec4<f32>(posRTE, 1.0);\n\
  output.positionEC = (camera.modelViewRelativeToEye * vec4<f32>(posRTE, 1.0)).xyz;\n\
  output.normalEC = normalize((camera.normalMatrix * vec4<f32>(input.normal, 0.0)).xyz);\n\
  output.texCoord0 = input.texCoord0;\n\
  output.tangentEC = normalize((camera.normalMatrix * vec4<f32>(input.tangent.xyz, 0.0)).xyz);\n\
  output.bitangentEC = cross(output.normalEC, output.tangentEC) * input.tangent.w;\n\
  output.vertexColor = input.vertexColor;\n\
  return output;\n\
}\n\
\n\
// PBR functions\n\
fn distributionGGX(N: vec3<f32>, H: vec3<f32>, roughness: f32) -> f32 {\n\
  let a = roughness * roughness;\n\
  let a2 = a * a;\n\
  let NdotH = max(dot(N, H), 0.0);\n\
  let NdotH2 = NdotH * NdotH;\n\
  let denom = NdotH2 * (a2 - 1.0) + 1.0;\n\
  return a2 / (PI * denom * denom);\n\
}\n\
\n\
fn geometrySchlickGGX(NdotV: f32, roughness: f32) -> f32 {\n\
  let r = roughness + 1.0;\n\
  let k = (r * r) / 8.0;\n\
  return NdotV / (NdotV * (1.0 - k) + k);\n\
}\n\
\n\
fn geometrySmith(N: vec3<f32>, V: vec3<f32>, L: vec3<f32>, roughness: f32) -> f32 {\n\
  let NdotV = max(dot(N, V), 0.0);\n\
  let NdotL = max(dot(N, L), 0.0);\n\
  return geometrySchlickGGX(NdotV, roughness) * geometrySchlickGGX(NdotL, roughness);\n\
}\n\
\n\
fn fresnelSchlick(cosTheta: f32, F0: vec3<f32>) -> vec3<f32> {\n\
  return F0 + (vec3<f32>(1.0) - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);\n\
}\n\
\n\
fn getNormalFromMap(normalEC: vec3<f32>, tangentEC: vec3<f32>, bitangentEC: vec3<f32>, texCoord: vec2<f32>) -> vec3<f32> {\n\
  let tangentNormal = textureSample(normalTexture, normalSampler, texCoord).xyz * 2.0 - 1.0;\n\
  let scaledNormal = tangentNormal * vec3<f32>(model.normalScale, model.normalScale, 1.0);\n\
  let TBN = mat3x3<f32>(tangentEC, bitangentEC, normalEC);\n\
  return normalize(TBN * scaledNormal);\n\
}\n\
\n\
@fragment\n\
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {\n\
  // Base color\n\
  var baseColor = textureSample(baseColorTexture, baseColorSampler, input.texCoord0);\n\
  baseColor *= model.baseColorFactor;\n\
  baseColor *= input.vertexColor;\n\
\n\
  // Alpha test\n\
  if (baseColor.a < model.alphaCutoff) {\n\
    discard;\n\
  }\n\
\n\
  // Normal mapping\n\
  var N = normalize(input.normalEC);\n\
  N = getNormalFromMap(N, input.tangentEC, input.bitangentEC, input.texCoord0);\n\
\n\
  // Metallic-roughness\n\
  let mrSample = textureSample(metallicRoughnessTexture, metallicRoughnessSampler, input.texCoord0);\n\
  let metallic = mrSample.b * model.metallicFactor;\n\
  let roughness = clamp(mrSample.g * model.roughnessFactor, 0.04, 1.0);\n\
\n\
  // View direction\n\
  let V = normalize(-input.positionEC);\n\
  let L = normalize(light.sunDirectionEC);\n\
  let H = normalize(V + L);\n\
\n\
  // F0 for dielectrics is 0.04, for metals it's the base color\n\
  let F0 = mix(vec3<f32>(0.04), baseColor.rgb, metallic);\n\
\n\
  // Cook-Torrance BRDF\n\
  let NDF = distributionGGX(N, H, roughness);\n\
  let G = geometrySmith(N, V, L, roughness);\n\
  let F = fresnelSchlick(max(dot(H, V), 0.0), F0);\n\
\n\
  let numerator = NDF * G * F;\n\
  let denominator = 4.0 * max(dot(N, V), 0.0) * max(dot(N, L), 0.0) + 0.0001;\n\
  let specular = numerator / denominator;\n\
\n\
  let kS = F;\n\
  let kD = (vec3<f32>(1.0) - kS) * (1.0 - metallic);\n\
\n\
  let NdotL = max(dot(N, L), 0.0);\n\
  var Lo = (kD * baseColor.rgb / PI + specular) * light.sunColor * light.sunIntensity * NdotL;\n\
\n\
  // Ambient\n\
  let ao = textureSample(occlusionTexture, occlusionSampler, input.texCoord0).r;\n\
  let ambient = light.ambientColor * baseColor.rgb * mix(1.0, ao, model.occlusionStrength);\n\
\n\
  // Emissive\n\
  let emissive = textureSample(emissiveTexture, emissiveSampler, input.texCoord0).rgb * model.emissiveFactor;\n\
\n\
  var color = ambient + Lo + emissive;\n\
\n\
  // Tonemap (Reinhard)\n\
  color = color / (color + vec3<f32>(1.0));\n\
  // Gamma correction\n\
  color = pow(color, vec3<f32>(1.0 / 2.2));\n\
\n\
  return vec4<f32>(color, baseColor.a);\n\
}\n\
";
