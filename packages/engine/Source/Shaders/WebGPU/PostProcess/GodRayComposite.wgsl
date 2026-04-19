// GodRayComposite — Additive composite of scene color + godray buffer.
//
// Shares the UV convention (y=DOWN, post-vertex flip) used by the other
// post-process shaders in this directory (BrightPass, BloomComposite, etc.)
// so the effect chain doesn't have to special-case orientation. See
// GodRayGenerate.wgsl for the producing pass.

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@group(0) @binding(0) var sceneTex: texture_2d<f32>;
@group(0) @binding(1) var godrayTex: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var out: VertexOutput;
  let x = f32(i32(vertexIndex & 1u) * 4 - 1);
  let y = f32(i32(vertexIndex >> 1u) * 4 - 1);
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return out;
}

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
  let scene = textureSample(sceneTex, texSampler, in.uv);
  let rays = textureSample(godrayTex, texSampler, in.uv);
  // Additive composite — the generate pass already applied exposure +
  // per-sample decay, so we just sum. Alpha passes the scene alpha
  // through unchanged (godrays don't affect scene transparency).
  return vec4<f32>(scene.rgb + rays.rgb, scene.a);
}
