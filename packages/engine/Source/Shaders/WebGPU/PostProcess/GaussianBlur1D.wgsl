// GaussianBlur1D — Separable 1D Gaussian blur for WebGPU
// Foundation shader used by bloom, SSAO blur, and depth-of-field.
// Uses incremental Gaussian computation (GPU Gems 3, Chapter 40).

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct BlurUniforms {
  // x = delta, y = sigma, z = direction (0=horizontal, 1=vertical), w = stepSize
  params: vec4<f32>,
  // x = 1/width, y = 1/height, z = pixelRatio, w = unused
  texelSize: vec4<f32>,
};

const SAMPLES: i32 = 8;
const TWO_PI: f32 = 6.283185307;

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

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
  let delta = blur.params.x;
  let sigma = blur.params.y;
  let direction = blur.params.z;
  let stepSize = blur.params.w;

  let dir = vec2<f32>(1.0 - direction, direction);
  let step = vec2<f32>(stepSize * blur.texelSize.z) * blur.texelSize.xy;

  // Incremental Gaussian: g.x = weight, g.y = decay, g.z = decay^2
  var g: vec3<f32>;
  g.x = 1.0 / (sqrt(TWO_PI) * sigma);
  g.y = exp((-0.5 * delta * delta) / (sigma * sigma));
  g.z = g.y * g.y;

  var result = textureSample(inputTexture, inputSampler, in.uv) * g.x;

  for (var i: i32 = 1; i < SAMPLES; i = i + 1) {
    g = vec3<f32>(g.x * g.y, g.y * g.z, g.z);

    let offset = f32(i) * dir * step;
    result += textureSample(inputTexture, inputSampler, in.uv - offset) * g.x;
    result += textureSample(inputTexture, inputSampler, in.uv + offset) * g.x;
  }

  return result;
}
