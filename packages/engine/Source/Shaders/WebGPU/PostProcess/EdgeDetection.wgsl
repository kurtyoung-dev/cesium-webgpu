// EdgeDetection — depth-based Sobel edge detection.
// WGSL parity twin of Shaders/PostProcessStages/EdgeDetection.glsl
// (WIRE-PP-LIBRARY-BUILTINS): samples the scene DEPTH buffer with the
// upstream 3/10/3 Sobel kernel and emits
// `vec4(color.rgb, len > length ? color.a : 0.0)` — the exact GLSL math.
// (The pre-parity version of this file ran a luminance Sobel on the color
// buffer; that never matched WebGL, which keys edges off depth
// discontinuities.)
//
// Not ported: the CZM_SELECTED_FEATURE branch (per-feature `selected`
// masking) — the WebGPU backend has no czm_selected equivalent yet, so
// the stage always edges the whole frame (same as WebGL with no
// `selected` array set).

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct EdgeUniforms {
  // x = padx (czm_pixelRatio / viewport width)
  // y = pady (czm_pixelRatio / viewport height)
  // z = length threshold (uniform `length`, default 0.25)
  // w = unused
  params: vec4<f32>,
  // Edge color (uniform `color`, default BLACK with alpha 1)
  edgeColor: vec4<f32>,
};

@group(0) @binding(0) var depthTexture: texture_2d<f32>;
@group(0) @binding(1) var depthSampler: sampler;
@group(0) @binding(2) var<uniform> uniforms: EdgeUniforms;

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var output: VertexOutput;
  let x = f32(i32(vertexIndex & 1u) * 4 - 1);
  let y = f32(i32(vertexIndex >> 1u) * 4 - 1);
  output.position = vec4<f32>(x, y, 0.0, 1.0);
  output.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return output;
}

fn readDepth(uv: vec2<f32>) -> f32 {
  // textureSampleLevel — no derivatives needed, safe inside the loop.
  return textureSampleLevel(depthTexture, depthSampler, uv, 0.0).r;
}

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
  let padx = uniforms.params.x;
  let pady = uniforms.params.y;
  let threshold = uniforms.params.z;

  var horizEdge = 0.0;
  var vertEdge = 0.0;

  // Upstream kernel: directions [-1, 0, 1], scalars [3, 10, 3].
  for (var i = 0; i < 3; i++) {
    let dir = f32(i - 1);
    let scale = select(3.0, 10.0, i == 1);

    horizEdge -= readDepth(in.uv + vec2<f32>(-padx, dir * pady)) * scale;
    horizEdge += readDepth(in.uv + vec2<f32>(padx, dir * pady)) * scale;

    vertEdge -= readDepth(in.uv + vec2<f32>(dir * padx, -pady)) * scale;
    vertEdge += readDepth(in.uv + vec2<f32>(dir * padx, pady)) * scale;
  }

  let len = sqrt(horizEdge * horizEdge + vertEdge * vertEdge);
  let alpha = select(0.0, uniforms.edgeColor.a, len > threshold);
  return vec4<f32>(uniforms.edgeColor.rgb, alpha);
}
