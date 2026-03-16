// Invert Classification shader for WebGPU
// Applies a highlight/dim effect to unclassified regions of 3D Tiles.
// Reads the classification stencil result and applies color modification
// to areas that were NOT classified (inverted stencil test).

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct InvertClassUniforms {
  highlightColor: vec4<f32>,  // Color applied to unclassified areas
  enableHighlight: f32,       // 1.0 = highlight on, 0.0 = off
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};

@group(0) @binding(0) var sceneTexture: texture_2d<f32>;
@group(0) @binding(1) var classifiedTexture: texture_2d<f32>;
@group(0) @binding(2) var sceneSampler: sampler;
@group(0) @binding(3) var<uniform> params: InvertClassUniforms;

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
  let sceneColor = textureSample(sceneTexture, sceneSampler, input.uv);
  let classifiedColor = textureSample(classifiedTexture, sceneSampler, input.uv);

  // If classified texture alpha > 0, this pixel was classified — keep scene color
  if (classifiedColor.a > 0.0) {
    return sceneColor;
  }

  // Unclassified region — apply highlight effect
  if (params.enableHighlight > 0.5) {
    // Blend highlight color with scene color
    let blended = mix(sceneColor.rgb, params.highlightColor.rgb, params.highlightColor.a);
    return vec4<f32>(blended, sceneColor.a);
  }

  return sceneColor;
}
