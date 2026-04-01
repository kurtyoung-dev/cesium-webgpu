// AmbientOcclusionModulate — Multiplies scene color by the AO factor.
// The AO texture is a single-channel grayscale from AmbientOcclusionGenerate.

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct AOModulateUniforms {
  // x = ambientOcclusionOnly (0 or 1), y = unused, z = unused, w = unused
  params: vec4<f32>,
};

@group(0) @binding(0) var sceneTexture: texture_2d<f32>;
@group(0) @binding(1) var aoTexture: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;
@group(0) @binding(3) var<uniform> uniforms: AOModulateUniforms;

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
  let ao = textureSample(aoTexture, texSampler, in.uv).r;
  let aoOnly = uniforms.params.x;

  // aoOnly=1: show AO factor (debug), aoOnly=0: modulate scene
  let result = mix(scene.rgb * ao, vec3<f32>(ao), aoOnly);

  return vec4<f32>(result, scene.a);
}
