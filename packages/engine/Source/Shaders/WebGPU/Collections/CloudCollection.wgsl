// Cloud Collection shader for WebGPU
// Renders cumulus clouds as instanced billboard quads with procedural noise.
// Uses RTE (Relative-To-Eye) positioning for planetary-scale precision.

struct VertexInput {
  // Per-vertex quad corner
  @location(0) quadVertex: vec2<f32>,
  // Per-instance data
  @location(1) positionHigh: vec3<f32>,
  @location(2) positionLow: vec3<f32>,
  @location(3) scaleAndBrightness: vec4<f32>, // xy=scale, z=brightness, w=cloudSlice
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) brightness: f32,
  @location(2) cloudSlice: f32,
};

struct CloudUniforms {
  mvpRelativeToEye: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>,
  _pad0: f32,
  encodedCameraLow: vec3<f32>,
  _pad1: f32,
  viewportSize: vec2<f32>,
  _pad2: vec2<f32>,
};

@group(0) @binding(0) var<uniform> camera: CloudUniforms;
@group(0) @binding(1) var noiseTexture: texture_2d<f32>;
@group(0) @binding(2) var noiseSampler: sampler;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;

  // RTE positioning
  let posRTE = (input.positionHigh - camera.encodedCameraHigh) +
               (input.positionLow - camera.encodedCameraLow);
  let clipPos = camera.mvpRelativeToEye * vec4<f32>(posRTE, 1.0);

  // Billboard offset in clip space
  let scale = input.scaleAndBrightness.xy;
  let aspectX = scale.x / camera.viewportSize.x * clipPos.w;
  let aspectY = scale.y / camera.viewportSize.y * clipPos.w;

  var offset = clipPos;
  offset.x = offset.x + input.quadVertex.x * aspectX;
  offset.y = offset.y + input.quadVertex.y * aspectY;

  output.position = offset;
  output.uv = input.quadVertex * 0.5 + 0.5;
  output.brightness = input.scaleAndBrightness.z;
  output.cloudSlice = input.scaleAndBrightness.w;

  return output;
}

// Simple FBM-like noise sampling for cloud shape
fn cloudNoise(uv: vec2<f32>, slice: f32) -> f32 {
  let baseUV = uv + vec2<f32>(slice * 0.1, 0.0);
  let n1 = textureSample(noiseTexture, noiseSampler, baseUV).r;
  let n2 = textureSample(noiseTexture, noiseSampler, baseUV * 2.0 + 0.5).r;
  let n3 = textureSample(noiseTexture, noiseSampler, baseUV * 4.0 + 0.25).r;
  return n1 * 0.5 + n2 * 0.3 + n3 * 0.2;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  // Radial falloff from center
  let dist = length(input.uv - vec2<f32>(0.5));
  if (dist > 0.5) {
    discard;
  }

  let noise = cloudNoise(input.uv, input.cloudSlice);
  let radialFade = 1.0 - smoothstep(0.2, 0.5, dist);
  let alpha = noise * radialFade;

  if (alpha < 0.05) {
    discard;
  }

  let brightness = input.brightness;
  let cloudColor = vec3<f32>(brightness, brightness, brightness);

  return vec4<f32>(cloudColor, alpha);
}
