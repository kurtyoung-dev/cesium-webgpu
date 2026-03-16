// Tonemapping post-process shader for WebGPU
// Implements Reinhard tonemapping with configurable exposure and gamma correction.

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct TonemapUniforms {
  exposure: f32,
  gamma: f32,
  _pad0: f32,
  _pad1: f32,
};

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> params: TonemapUniforms;

// Fullscreen triangle — no vertex buffer needed
@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var output: VertexOutput;
  // Generate a full-screen triangle from vertex index
  let x = f32(i32(vertexIndex & 1u) * 4 - 1);
  let y = f32(i32(vertexIndex >> 1u) * 4 - 1);
  output.position = vec4<f32>(x, y, 0.0, 1.0);
  output.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return output;
}

// Reinhard tonemapping
fn reinhardTonemap(color: vec3<f32>) -> vec3<f32> {
  return color / (color + vec3<f32>(1.0));
}

// ACES Filmic tonemapping (higher quality alternative)
fn acesTonemap(color: vec3<f32>) -> vec3<f32> {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((color * (a * color + b)) / (color * (c * color + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let hdrColor = textureSample(inputTexture, inputSampler, input.uv).rgb;

  // Apply exposure
  let exposed = hdrColor * params.exposure;

  // Apply Reinhard tonemapping
  let mapped = reinhardTonemap(exposed);

  // Apply gamma correction
  let invGamma = 1.0 / params.gamma;
  let corrected = pow(mapped, vec3<f32>(invGamma));

  return vec4<f32>(corrected, 1.0);
}
