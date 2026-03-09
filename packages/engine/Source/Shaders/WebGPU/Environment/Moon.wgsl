// Moon.wgsl — Moon rendering with texture mapping for CesiumJS WebGPU
// Renders a textured sphere with simple lighting

struct Uniforms {
  mvpRelativeToEye: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>,
  _pad0: f32,
  encodedCameraLow: vec3<f32>,
  _pad1: f32,
  sunDirectionEC: vec3<f32>,   // sun direction in eye coordinates
  _pad2: f32,
  textureOffset: vec2<f32>,    // texture coordinate offset for moon phase
  moonAlpha: f32,              // overall alpha
  _pad3: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var moonTexture: texture_2d<f32>;
@group(0) @binding(2) var moonSampler: sampler;

struct VertexInput {
  @location(0) positionHigh: vec3<f32>,
  @location(1) positionLow: vec3<f32>,
  @location(2) normal: vec3<f32>,
  @location(3) texCoord: vec2<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) texCoord: vec2<f32>,
  @location(1) normalEC: vec3<f32>,
};

fn translateRelativeToEye(posHigh: vec3<f32>, posLow: vec3<f32>, camHigh: vec3<f32>, camLow: vec3<f32>) -> vec3<f32> {
  return (posHigh - camHigh) + (posLow - camLow);
}

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let positionRTE = translateRelativeToEye(
    input.positionHigh, input.positionLow,
    u.encodedCameraHigh, u.encodedCameraLow
  );
  output.position = u.mvpRelativeToEye * vec4<f32>(positionRTE, 1.0);
  output.texCoord = input.texCoord + u.textureOffset;
  output.normalEC = input.normal;
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let texColor = textureSample(moonTexture, moonSampler, input.texCoord);
  let normal = normalize(input.normalEC);

  // Simple diffuse lighting from sun
  let NdotL = max(dot(normal, u.sunDirectionEC), 0.0);
  let ambient = 0.05;
  let lighting = ambient + NdotL;

  let color = texColor.rgb * lighting;
  return vec4<f32>(color, texColor.a * u.moonAlpha);
}
