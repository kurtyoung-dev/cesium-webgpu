// SSGIComposite — combine scene color with the denoised SSGI target.
//
// Fork-added Campaign-6 (C6-SSGI-DIFFUSE). Replaces AmbientOcclusionModulate
// when algorithm == "ssgi". Reads the scene color and the blurred SSGI target
// (rgba16float: GI.rgb + AO.a) and produces:
//
//   result = sceneColor.rgb * mix(1.0, ao, aoWeight) + gi
//
// The GI term already carries the emitter's beauty color and giIntensity
// (applied in the generate pass). There is no albedo G-buffer in this pipeline,
// so the additive model uses the lit emitter color directly — a documented
// limitation (a bright white wall bounces onto a dark receiver slightly too
// brightly). See RESEARCH_R-SSGI §6.
//
// Debug modes via params.x: 0 = composite, 1 = AO only, 2 = GI only,
// 3 = raw scene passthrough. Off-gate: only compiled when algorithm == "ssgi".

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct CompositeUniforms {
  // x = debugMode (0 composite / 1 aoOnly / 2 giOnly), y = aoWeight, z/w unused
  params: vec4<f32>,
};

@group(0) @binding(0) var sceneTexture: texture_2d<f32>;
@group(0) @binding(1) var giaoTexture: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;
@group(0) @binding(3) var<uniform> uniforms: CompositeUniforms;

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
  let giao = textureSample(giaoTexture, texSampler, in.uv);
  let gi = max(giao.rgb, vec3<f32>(0.0));
  let ao = clamp(giao.a, 0.0, 1.0);

  let debugMode = uniforms.params.x;
  let aoWeight = uniforms.params.y;

  if (debugMode > 2.5) {
    // Mode 3 — raw scene passthrough (isolates the composite scene input).
    return scene;
  }
  if (debugMode > 1.5) {
    // GI only
    return vec4<f32>(gi, scene.a);
  }
  if (debugMode > 0.5) {
    // AO only
    return vec4<f32>(vec3<f32>(ao), scene.a);
  }

  let result = scene.rgb * mix(1.0, ao, aoWeight) + gi;
  return vec4<f32>(result, scene.a);
}
