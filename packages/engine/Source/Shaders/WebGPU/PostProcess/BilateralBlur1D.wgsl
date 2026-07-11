// BilateralBlur1D — separable depth-aware blur for screen-space GI/AO.
//
// Fork-added Campaign-6 (C6-SSGI-DIFFUSE). Denoises the half/full-res SSGI
// target (rgba16float: GI.rgb + AO.a) without leaking across depth
// discontinuities — a plain Gaussian would smear indirect light across
// silhouette edges. Runs twice (H then V) between SSGIGenerate and
// SSGIComposite. Reusable by future screen-space denoise users.
//
// Edge-stopping: Gaussian spatial weight × depth-similarity weight
// exp(-|z_s - z_c| / (depthTol * z_c)) — the 1% relative eye-depth tolerance
// is scale-invariant, so it behaves identically from street level to orbit.
// Depth is reconstructed with the same readDepth/log-depth path the generate
// pass uses (frustum.z). Off-gate: only compiled when algorithm == "ssgi".

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct BlurUniforms {
  // x = dirX, y = dirY, z = sigma, w = radiusTaps
  params: vec4<f32>,
  // x = 1/width, y = 1/height, z = depthTol, w = unused
  texel: vec4<f32>,
  // x = near, y = far, z = logActive, w = unused
  frustum: vec4<f32>,
};

@group(0) @binding(0) var giaoTexture: texture_2d<f32>;
@group(0) @binding(1) var depthTexture: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;
@group(0) @binding(3) var<uniform> uniforms: BlurUniforms;

fn logDepthReverse(logZ: f32, near: f32, far: f32) -> f32 {
  if (far <= near) { return logZ; }
  let log2FarDepthFromNearPlusOne = log2((far - near) + 1.0);
  let depthFromNear = exp2(logZ * log2FarDepthFromNearPlusOne) - 1.0;
  let depthFromCamera = depthFromNear + near;
  return far * (1.0 - near / depthFromCamera) / (far - near);
}

fn readDepth(uv: vec2<f32>) -> f32 {
  let raw = textureSampleLevel(depthTexture, texSampler, uv, 0.0).r;
  let near = uniforms.frustum.x;
  let far = uniforms.frustum.y;
  var d = raw;
  if (uniforms.frustum.z > 0.5) {
    d = logDepthReverse(raw, near, far);
  }
  let z = near * far / (far - d * (far - near));
  // Sanitize — at planet scale an extreme/degenerate frustum can drive this to
  // Inf/NaN; a NaN weight would corrupt the blurred AO/GI. select() returns the
  // fallback for NaN (all comparisons false) and for out-of-range values.
  return select(far, z, z > 0.0 && z < 1e20);
}

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
  let dir = vec2<f32>(uniforms.params.x, uniforms.params.y);
  let sigma = max(uniforms.params.z, 1e-3);
  let texel = vec2<f32>(uniforms.texel.x, uniforms.texel.y);
  let depthTol = max(uniforms.texel.z, 1e-4);

  let step = dir * texel;
  let zc = readDepth(in.uv);

  var sum = textureSampleLevel(giaoTexture, texSampler, in.uv, 0.0);
  var wsum = 1.0;

  // 5-tap separable (offsets ±1, ±2).
  for (var i = 1; i <= 2; i = i + 1) {
    let fi = f32(i);
    let gw = exp(-(fi * fi) / (2.0 * sigma * sigma));
    for (var s = 0; s < 2; s = s + 1) {
      let sign = select(1.0, -1.0, s == 0);
      let uv = in.uv + step * (sign * fi);
      let zs = readDepth(uv);
      // Clamp the exponent argument so an extreme depth delta yields ~0 (never
      // Inf/NaN); combined with the sanitized depths this keeps the weight sum
      // finite everywhere.
      let ratio = min(abs(zs - zc) / (depthTol * max(zc, 1.0)), 40.0);
      let dw = exp(-ratio);
      let w = gw * dw;
      sum += textureSampleLevel(giaoTexture, texSampler, uv, 0.0) * w;
      wsum += w;
    }
  }

  return sum / max(wsum, 1e-4);
}
