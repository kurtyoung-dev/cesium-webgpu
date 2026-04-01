// BloomComposite — Composites blurred bloom glow with the original scene.
// Uses additive blending with configurable intensity.
// The bloom glow comes from: BrightPass → GaussianBlur (H+V) → this composite.

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct BloomUniforms {
  // x = glowOnly (0 or 1), y = intensity, z = unused, w = unused
  params: vec4<f32>,
};

@group(0) @binding(0) var sceneTexture: texture_2d<f32>;
@group(0) @binding(1) var bloomTexture: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;
@group(0) @binding(3) var<uniform> uniforms: BloomUniforms;

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
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
  let scene = textureSample(sceneTexture, texSampler, in.uv);
  let bloom = textureSample(bloomTexture, texSampler, in.uv);
  let glowOnly = uniforms.params.x;
  let intensity = uniforms.params.y;

  // glowOnly=1: show only the bloom glow (debug), glowOnly=0: additive composite
  let result = mix(scene.rgb, vec3<f32>(0.0), glowOnly) + bloom.rgb * intensity;

  return vec4<f32>(result, scene.a);
}
