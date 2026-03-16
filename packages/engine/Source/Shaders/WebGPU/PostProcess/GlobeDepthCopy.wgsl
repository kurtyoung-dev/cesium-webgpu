// Globe Depth Copy shader for WebGPU
// Copies depth from the globe framebuffer to a shader-readable depth texture.
// This is needed for terrain clamping and picking operations.

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@group(0) @binding(0) var depthTexture: texture_2d<f32>;
@group(0) @binding(1) var depthSampler: sampler;

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var output: VertexOutput;
  let x = f32(i32(vertexIndex & 1u) * 4 - 1);
  let y = f32(i32(vertexIndex >> 1u) * 4 - 1);
  output.position = vec4<f32>(x, y, 0.0, 1.0);
  output.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let depth = textureSample(depthTexture, depthSampler, input.uv).r;
  // Pack depth into all 4 channels for readback compatibility
  return vec4<f32>(depth, depth, depth, 1.0);
}
