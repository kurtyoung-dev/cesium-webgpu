// DepthOfField — f16 variant (PARITY-F16-POSTPROCESS). Hand-tuned
// half-precision version of `DepthOfField.wgsl`. Selected when
// `context.useShaderF16` is true. Keep in sync with the f32 reference.
//
// f16 policy: the depth linearization + circle-of-confusion computation
// stay in F32 — `linearizeDepth` uses near*far/(...) with far up to
// ~1e7 (way past f16 max), and the CoC/smoothstep gate depends on that
// eye-space depth. Only the final sharp↔blurred COLOR mix runs in f16;
// both inputs are bounded scene colors, clamped to the f16 range at the
// conversion boundary.

enable f16;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct DoFUniforms {
  params: vec4<f32>,
};

@group(0) @binding(0) var sceneTexture: texture_2d<f32>;
@group(0) @binding(1) var blurTexture: texture_2d<f32>;
@group(0) @binding(2) var depthTexture: texture_2d<f32>;
@group(0) @binding(3) var texSampler: sampler;
@group(0) @binding(4) var<uniform> uniforms: DoFUniforms;

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

fn linearizeDepth(rawDepth: f32, near: f32, far: f32) -> f32 {
  return near * far / (far - rawDepth * (far - near));
}

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
  let sharp32 = textureSample(sceneTexture, texSampler, in.uv);
  let blurred32 = textureSample(blurTexture, texSampler, in.uv);
  let rawDepth = textureSample(depthTexture, texSampler, in.uv).r;

  let focalDist = uniforms.params.x;
  let focalRange = uniforms.params.y;
  let near = uniforms.params.z;
  let far = uniforms.params.w;

  // Depth + CoC in F32.
  let depth = linearizeDepth(rawDepth, near, far);
  let coc = clamp(abs(depth - focalDist) / max(focalRange, 0.001), 0.0, 1.0);
  let t = f16(smoothstep(0.0, 1.0, coc));

  // Color mix in F16.
  let sharp = vec3<f16>(clamp(sharp32.rgb, vec3<f32>(0.0), vec3<f32>(F16_MAX_HDR)));
  let blurred = vec3<f16>(clamp(blurred32.rgb, vec3<f32>(0.0), vec3<f32>(F16_MAX_HDR)));
  let result = mix(sharp, blurred, t);

  return vec4<f32>(vec3<f32>(result), sharp32.a);
}
