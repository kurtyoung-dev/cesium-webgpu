// DepthOfField — Composites in-focus and blurred scene regions based on depth.
// Uses a circle-of-confusion model with configurable focal distance and range.

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct DoFUniforms {
  // x = focalDistance, y = focalRange (transition zone width), z = near, w = far
  params: vec4<f32>,
};

@group(0) @binding(0) var sceneTexture: texture_2d<f32>;
@group(0) @binding(1) var blurTexture: texture_2d<f32>;
@group(0) @binding(2) var depthTexture: texture_2d<f32>;
@group(0) @binding(3) var texSampler: sampler;
@group(0) @binding(4) var<uniform> uniforms: DoFUniforms;

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var output: VertexOutput;
  let x = f32(i32(vertexIndex & 1u) * 4 - 1);
  let y = f32(i32(vertexIndex >> 1u) * 4 - 1);
  output.position = vec4<f32>(x, y, 0.0, 1.0);
  output.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return output;
}

fn linearizeDepth(rawDepth: f32, near: f32, far: f32) -> f32 {
  return near * far / (far - rawDepth * (far - near));
}

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
  let sharp = textureSample(sceneTexture, texSampler, in.uv);
  let blurred = textureSample(blurTexture, texSampler, in.uv);
  let rawDepth = textureSample(depthTexture, texSampler, in.uv).r;

  let focalDist = uniforms.params.x;
  let focalRange = uniforms.params.y;
  let near = uniforms.params.z;
  let far = uniforms.params.w;

  let depth = linearizeDepth(rawDepth, near, far);

  // Circle of confusion: distance from focal plane normalized by focal range
  let coc = clamp(abs(depth - focalDist) / max(focalRange, 0.001), 0.0, 1.0);

  // Smooth interpolation between sharp and blurred
  let t = smoothstep(0.0, 1.0, coc);
  let result = mix(sharp.rgb, blurred.rgb, t);

  return vec4<f32>(result, sharp.a);
}
