// GaussianBlur1D — f16 variant (PARITY-F16-POSTPROCESS). Hand-tuned
// half-precision version of `GaussianBlur1D.wgsl`. Selected when
// `context.useShaderF16` is true. Keep in sync with the f32 reference.
//
// f16 policy: the incremental-Gaussian weight recurrence
// (g = weight, decay, decay^2 — GPU Gems 3 ch.40) stays in F32. The
// recurrence multiplies decay factors across 8 samples; doing it in f16
// would accumulate rounding error that shifts the blur weights and
// changes the kernel shape. `sqrt`/`exp` are also more accurate in f32.
// The UV offset math stays F32 (sub-texel sample placement precision).
// Only the weighted COLOR accumulation is done in F16 — colors are
// bounded (bloom-bright input is clamped to [0,1] upstream; SSAO/DoF
// blur inputs are grayscale/SDR), and per-sample `color * weight` with
// weights summing to ~1 keeps the accumulator inside the f16 range.

enable f16;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct BlurUniforms {
  params: vec4<f32>,
  texelSize: vec4<f32>,
};

const SAMPLES: i32 = 8;
const TWO_PI: f32 = 6.283185307;
const F16_MAX_HDR: f32 = 65000.0;

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> blur: BlurUniforms;

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var output: VertexOutput;
  let x = f32(i32(vertexIndex & 1u) * 4 - 1);
  let y = f32(i32(vertexIndex >> 1u) * 4 - 1);
  output.position = vec4<f32>(x, y, 0.0, 1.0);
  output.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return output;
}

fn sampleF16(uv: vec2<f32>) -> vec4<f16> {
  let c = textureSample(inputTexture, inputSampler, uv);
  return vec4<f16>(clamp(c, vec4<f32>(0.0), vec4<f32>(F16_MAX_HDR)));
}

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
  let delta = blur.params.x;
  let sigma = blur.params.y;
  let direction = blur.params.z;
  let stepSize = blur.params.w;

  let dir = vec2<f32>(1.0 - direction, direction);
  let step = vec2<f32>(stepSize * blur.texelSize.z) * blur.texelSize.xy;

  // Weight recurrence in F32 (precision-sensitive).
  var g: vec3<f32>;
  g.x = 1.0 / (sqrt(TWO_PI) * sigma);
  g.y = exp((-0.5 * delta * delta) / (sigma * sigma));
  g.z = g.y * g.y;

  // Color accumulation in F16.
  var result = sampleF16(in.uv) * f16(g.x);

  for (var i: i32 = 1; i < SAMPLES; i = i + 1) {
    g = vec3<f32>(g.x * g.y, g.y * g.z, g.z);

    let offset = f32(i) * dir * step;
    let w = f16(g.x);
    result += sampleF16(in.uv - offset) * w;
    result += sampleF16(in.uv + offset) * w;
  }

  return vec4<f32>(result);
}
