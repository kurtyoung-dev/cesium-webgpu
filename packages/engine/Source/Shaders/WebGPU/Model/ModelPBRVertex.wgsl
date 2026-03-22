// ModelPBRVertex.wgsl — Comprehensive PBR vertex shader for glTF models
// Uses model-space positions with model-space RTE camera encoding.
// Model positions remain in model coordinates (3 floats, NOT high/low split).
// Camera position is encoded in model space via inverse(modelMatrix) * cameraPositionWC.

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

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

struct VertexInput {
  @location(0) positionMC: vec3<f32>,
  @location(1) normalMC: vec3<f32>,
  @location(2) tangentMC: vec4<f32>,
  @location(3) texCoord0: vec2<f32>,
  @location(4) color0: vec4<f32>,
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

  // RTE in model space: subtract encoded camera (in model coords) from vertex position
  // This gives sub-meter precision for planetary-scale rendering.
  // positionMC is model-local (small values), camera is far in ECEF but encoded high/low.
  let rte = (input.positionMC - camera.encodedCameraPositionMCHigh)
          + (vec3<f32>(0.0) - camera.encodedCameraPositionMCLow);

  output.position = camera.mvpRelativeToEye * vec4<f32>(rte, 1.0);
  output.positionEC = (camera.modelViewRelativeToEye * vec4<f32>(rte, 1.0)).xyz;

  // Transform normal to eye coordinates
  output.normalEC = normalize((camera.normalMatrix * vec4<f32>(input.normalMC, 0.0)).xyz);

  // Pass through texture coordinates and vertex color
  output.texCoord0 = input.texCoord0;
  output.color0 = input.color0;

  // Tangent/Bitangent for normal mapping (tangent.w = handedness sign)
  let tangentEC3 = normalize((camera.normalMatrix * vec4<f32>(input.tangentMC.xyz, 0.0)).xyz);
  output.tangentEC = tangentEC3;
  output.bitangentEC = cross(output.normalEC, tangentEC3) * input.tangentMC.w;

  return output;
}
