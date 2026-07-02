// Silhouette — Composites edge detection overlay onto the scene.
// Matches CesiumJS GLSL Silhouette.glsl behavior.

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@group(0) @binding(0) var sceneTexture: texture_2d<f32>;
@group(0) @binding(1) var silhouetteTexture: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;

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
  let silhouette = textureSample(silhouetteTexture, texSampler, in.uv);

  // GLSL parity (WIRE-PP-LIBRARY-BUILTINS): Silhouette.glsl mixes the FULL
  // vec4 (`mix(color, silhouetteColor, silhouetteColor.a)`), not just rgb.
  return mix(scene, silhouette, silhouette.a);
}
