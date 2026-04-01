// BrightPass — Extracts pixels above a luminance threshold for bloom.
// Also applies contrast/bias adjustment to control bloom intensity.

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct BrightPassUniforms {
  // x = threshold, y = contrast, z = bias, w = averageLuminance
  params: vec4<f32>,
};

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> uniforms: BrightPassUniforms;

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var output: VertexOutput;
  let x = f32(i32(vertexIndex & 1u) * 4 - 1);
  let y = f32(i32(vertexIndex >> 1u) * 4 - 1);
  output.position = vec4<f32>(x, y, 0.0, 1.0);
  output.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return output;
}

fn luminance(color: vec3<f32>) -> f32 {
  return dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
}

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
  let color = textureSample(inputTexture, inputSampler, in.uv);
  let threshold = uniforms.params.x;
  let contrast = uniforms.params.y;
  let bias = uniforms.params.z;
  let avgLum = uniforms.params.w;

  let lum = luminance(color.rgb);

  // Bright pass: keep only pixels above threshold relative to average luminance
  let brightColor = max(color.rgb - vec3<f32>(threshold * avgLum), vec3<f32>(0.0));

  // Apply contrast and bias: out = contrast * (in - 0.5) + 0.5 + bias
  let adjusted = clamp(contrast * (brightColor - vec3<f32>(0.5)) + vec3<f32>(0.5 + bias), vec3<f32>(0.0), vec3<f32>(1.0));

  return vec4<f32>(adjusted, 1.0);
}
