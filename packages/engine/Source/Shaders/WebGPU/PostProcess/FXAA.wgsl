// FXAA (Fast Approximate Anti-Aliasing) post-process shader for WebGPU
// Based on FXAA 3.11 by Timothy Lottes (NVIDIA)
//
// HDR (tonemap-bypass) mode. The FXAA_REDUCE_* /
// FXAA_SPAN_MAX constants and the luma-keyed edge detection are tuned
// for an SDR [0, 1] signal; on unbounded linear HDR a single bright
// highlight dominates every luminance delta and the filter misfires.
// When `params.hdrMode > 0.5` the luminance used for edge detection is
// computed on a Reinhard-compressed value (c / (1 + c), the standard
// HDR-resolve weighting) so the thresholds see a [0, 1) signal again.
// The COLOR blends still operate on the raw HDR samples — only the
// edge metric is compressed, so the output stays linear HDR. With
// hdrMode == 0 (the default) the math is bit-for-bit the historical
// SDR path.

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct FXAAUniforms {
  texelSize: vec2<f32>, // 1.0 / textureSize
  // 0 = SDR luma (historical, default), 1 = HDR tonemap-bypass mode
  // (edge-detection luma computed on Reinhard-compressed color).
  // Driven by the pipeline's setHDROutputMode().
  hdrMode: f32,
  _pad1: f32,
};

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> params: FXAAUniforms;

const FXAA_REDUCE_MIN: f32 = 1.0 / 128.0;
const FXAA_REDUCE_MUL: f32 = 1.0 / 8.0;
const FXAA_SPAN_MAX: f32 = 8.0;

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var output: VertexOutput;
  let x = f32(i32(vertexIndex & 1u) * 4 - 1);
  let y = f32(i32(vertexIndex >> 1u) * 4 - 1);
  output.position = vec4<f32>(x, y, 0.0, 1.0);
  output.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return output;
}

// Edge-detection luminance. In HDR mode the color is Reinhard-compressed
// first so the SDR-tuned thresholds below see a bounded [0, 1) signal;
// in SDR mode (hdrMode == 0) this is the historical plain luma dot.
fn luminance(color: vec3<f32>) -> f32 {
  var c = color;
  if (params.hdrMode > 0.5) {
    c = max(c, vec3<f32>(0.0));
    c = c / (1.0 + c);
  }
  return dot(c, vec3<f32>(0.299, 0.587, 0.114));
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let uv = input.uv;
  let ts = params.texelSize;

  // Sample neighbors
  let rgbNW = textureSample(inputTexture, inputSampler, uv + vec2<f32>(-ts.x, -ts.y)).rgb;
  let rgbNE = textureSample(inputTexture, inputSampler, uv + vec2<f32>( ts.x, -ts.y)).rgb;
  let rgbSW = textureSample(inputTexture, inputSampler, uv + vec2<f32>(-ts.x,  ts.y)).rgb;
  let rgbSE = textureSample(inputTexture, inputSampler, uv + vec2<f32>( ts.x,  ts.y)).rgb;
  let rgbM  = textureSample(inputTexture, inputSampler, uv).rgb;

  // Compute luminance
  let lumNW = luminance(rgbNW);
  let lumNE = luminance(rgbNE);
  let lumSW = luminance(rgbSW);
  let lumSE = luminance(rgbSE);
  let lumM  = luminance(rgbM);

  let lumMin = min(lumM, min(min(lumNW, lumNE), min(lumSW, lumSE)));
  let lumMax = max(lumM, max(max(lumNW, lumNE), max(lumSW, lumSE)));

  // Compute edge direction
  var dir: vec2<f32>;
  dir.x = -((lumNW + lumNE) - (lumSW + lumSE));
  dir.y =  ((lumNW + lumSW) - (lumNE + lumSE));

  let dirReduce = max(
    (lumNW + lumNE + lumSW + lumSE) * 0.25 * FXAA_REDUCE_MUL,
    FXAA_REDUCE_MIN
  );
  let rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
  dir = clamp(dir * rcpDirMin, vec2<f32>(-FXAA_SPAN_MAX), vec2<f32>(FXAA_SPAN_MAX)) * ts;

  // Sample along edge
  let rgbA = 0.5 * (
    textureSample(inputTexture, inputSampler, uv + dir * (1.0 / 3.0 - 0.5)).rgb +
    textureSample(inputTexture, inputSampler, uv + dir * (2.0 / 3.0 - 0.5)).rgb
  );
  let rgbB = rgbA * 0.5 + 0.25 * (
    textureSample(inputTexture, inputSampler, uv + dir * -0.5).rgb +
    textureSample(inputTexture, inputSampler, uv + dir *  0.5).rgb
  );

  let lumB = luminance(rgbB);

  var finalColor: vec3<f32>;
  if (lumB < lumMin || lumB > lumMax) {
    finalColor = rgbA;
  } else {
    finalColor = rgbB;
  }

  return vec4<f32>(finalColor, 1.0);
}
