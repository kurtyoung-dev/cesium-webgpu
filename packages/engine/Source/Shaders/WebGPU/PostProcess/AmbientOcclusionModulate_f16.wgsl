// AmbientOcclusionModulate — f16 variant.
// Hand-tuned half-precision version of `AmbientOcclusionModulate.wgsl`.
// Selected when `context.useShaderF16` is true. Keep in sync with the
// f32 reference.
//
// f16 policy: multiplies scene color by the grayscale AO factor. Both
// inputs are in [0, 1] (AO is a normalized occlusion factor; scene is
// SDR/HDR clamped at the conversion boundary), so the modulate + debug
// lerp run cleanly in f16.

enable f16;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct AOModulateUniforms {
  params: vec4<f32>,
};

@group(0) @binding(0) var sceneTexture: texture_2d<f32>;
@group(0) @binding(1) var aoTexture: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;
@group(0) @binding(3) var<uniform> uniforms: AOModulateUniforms;

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
  let ao = f16(textureSample(aoTexture, texSampler, in.uv).r);
  let aoOnly = f16(uniforms.params.x);

  let scene = vec3<f16>(clamp(scene32.rgb, vec3<f32>(0.0), vec3<f32>(F16_MAX_HDR)));

  let result = mix(scene * ao, vec3<f16>(ao), aoOnly);

  return vec4<f32>(vec3<f32>(result), scene32.a);
}
