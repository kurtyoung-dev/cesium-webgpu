// BloomComposite — f16 variant. Hand-tuned
// half-precision version of `BloomComposite.wgsl`. Selected when
// `context.useShaderF16` is true. Keep in sync with the f32 reference.
//
// f16 policy: additive composite of scene + (bloom × intensity). The
// bloom source is clamped to [0, 1] upstream (BrightPass) and the blur
// preserves that range, so `bloom.rgb * intensity` stays modest for the
// default intensity (~1.0). In HDR mode the scene input can exceed 1.0;
// it's clamped to the f16 range at the conversion boundary so the add
// can't overflow (visually identical — bloom composite output is
// re-tonemapped/clamped downstream anyway).

enable f16;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct BloomUniforms {
  params: vec4<f32>,
};

@group(0) @binding(0) var sceneTexture: texture_2d<f32>;
@group(0) @binding(1) var bloomTexture: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;
@group(0) @binding(3) var<uniform> uniforms: BloomUniforms;

const F16_MAX_HDR: f32 = 65000.0;

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
  let scene32 = textureSample(sceneTexture, texSampler, in.uv);
  let bloom32 = textureSample(bloomTexture, texSampler, in.uv);
  let glowOnly = f16(uniforms.params.x);
  let intensity = f16(uniforms.params.y);

  let scene = vec3<f16>(clamp(scene32.rgb, vec3<f32>(0.0), vec3<f32>(F16_MAX_HDR)));
  let bloom = vec3<f16>(clamp(bloom32.rgb, vec3<f32>(0.0), vec3<f32>(F16_MAX_HDR)));

  let result = mix(scene, vec3<f16>(0.0h), glowOnly) + bloom * intensity;

  return vec4<f32>(vec3<f32>(result), scene32.a);
}
