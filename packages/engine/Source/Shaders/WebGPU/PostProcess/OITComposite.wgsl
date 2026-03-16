// Order-Independent Transparency (OIT) composite shader for WebGPU
// Implements weighted blended OIT (McGuire & Bavoil 2013)
// Composites the accumulation and revealage textures over the opaque scene.

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@group(0) @binding(0) var accumulationTexture: texture_2d<f32>; // rgba16float: premultiplied color * weight
@group(0) @binding(1) var revealageTexture: texture_2d<f32>;    // r8unorm: product of (1 - alpha * weight)
@group(0) @binding(2) var oitSampler: sampler;

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
  let accum = textureSample(accumulationTexture, oitSampler, input.uv);
  let revealage = textureSample(revealageTexture, oitSampler, input.uv).r;

  // If revealage is 1.0, nothing was drawn translucently — discard
  if (revealage >= 1.0) {
    discard;
  }

  // Prevent divide-by-zero: if accumulation alpha is near zero, discard
  if (accum.a < 0.00001) {
    discard;
  }

  // Reconstruct average color: color = accum.rgb / accum.a
  let averageColor = accum.rgb / accum.a;

  // The final alpha is 1 - revealage (total opacity of all translucent layers)
  let alpha = 1.0 - revealage;

  // Output premultiplied alpha for blending over opaque scene
  // Blend mode should be: src=ONE, dst=ONE_MINUS_SRC_ALPHA
  return vec4<f32>(averageColor * alpha, alpha);
}
