// GodRayComposite — f16 variant (PARITY-F16-POSTPROCESS). Hand-tuned
// half-precision version of `GodRayComposite.wgsl`. Selected when
// `context.useShaderF16` is true. Keep in sync with the f32 reference.
//
// f16 policy: additive composite of scene + godray buffer. Both inputs
// are bounded scene colors (the generate pass already applied exposure +
// decay), clamped to the f16 range at the conversion boundary so the add
// can't overflow.

enable f16;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@group(0) @binding(0) var sceneTex: texture_2d<f32>;
@group(0) @binding(1) var godrayTex: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;

const F16_MAX_HDR: f32 = 65000.0;

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
  let scene32 = textureSample(sceneTex, texSampler, in.uv);
  let rays32 = textureSample(godrayTex, texSampler, in.uv);
  let scene = vec3<f16>(clamp(scene32.rgb, vec3<f32>(0.0), vec3<f32>(F16_MAX_HDR)));
  let rays = vec3<f16>(clamp(rays32.rgb, vec3<f32>(0.0), vec3<f32>(F16_MAX_HDR)));
  return vec4<f32>(vec3<f32>(scene + rays), scene32.a);
}
