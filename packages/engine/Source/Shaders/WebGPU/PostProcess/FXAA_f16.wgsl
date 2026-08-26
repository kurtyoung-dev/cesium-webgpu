// FXAA post-process shader for WebGPU — f16 variant.
// Hand-tuned half-precision version of
// `FXAA.wgsl` (FXAA 3.11, Timothy Lottes). Selected when
// `context.useShaderF16` is true. Keep in sync with the f32 reference.
//
// f16 policy: the edge-direction search and all UV offset math stay in
// F32 — `dir`, `rcpDirMin`, and the texel-scaled step are precision-
// sensitive (sub-pixel sample placement; an f16 UV would snap samples to
// the wrong texels and shift the AA pattern). The per-sample luminance
// comparison and the final color blends are done in F16: inputs are SDR
// [0, 1] so every intermediate is inside the f16 normal range.
//
// HDR (tonemap-bypass) mode, mirrored from the f32
// reference: when `params.hdrMode > 0.5` the edge-detection luminance is
// computed on a Reinhard-compressed value (c / (1 + c)). The compression
// runs in F32 — an f16 `1 + c` overflows to inf at the rgba16float peak
// (65504) — and the compressed [0, 1) result converts back to f16 for
// the luma dot. Color blends stay on the raw HDR samples. hdrMode == 0
// (default) is bit-for-bit the historical SDR path.

enable f16;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct FXAAUniforms {
  texelSize: vec2<f32>,
  // 0 = SDR luma (historical, default), 1 = HDR tonemap-bypass mode.
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

// Edge-detection luminance in f16. In HDR mode the color is Reinhard-
// compressed first (in F32 — see the header) so the SDR-tuned FXAA
// thresholds see a bounded [0, 1) signal.
fn luminance16(color: vec3<f16>) -> f16 {
  var c = color;
  if (params.hdrMode > 0.5) {
    let cf = max(vec3<f32>(color), vec3<f32>(0.0));
    c = vec3<f16>(cf / (1.0 + cf));
  }
  return dot(c, vec3<f16>(0.299h, 0.587h, 0.114h));
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let uv = input.uv;
  let ts = params.texelSize;

  // Neighbor fetches. Colors are converted to f16 for the luminance +
  // blend math; the SAMPLE UVs stay f32.
  let rgbNW = vec3<f16>(textureSample(inputTexture, inputSampler, uv + vec2<f32>(-ts.x, -ts.y)).rgb);
  let rgbNE = vec3<f16>(textureSample(inputTexture, inputSampler, uv + vec2<f32>( ts.x, -ts.y)).rgb);
  let rgbSW = vec3<f16>(textureSample(inputTexture, inputSampler, uv + vec2<f32>(-ts.x,  ts.y)).rgb);
  let rgbSE = vec3<f16>(textureSample(inputTexture, inputSampler, uv + vec2<f32>( ts.x,  ts.y)).rgb);
  let rgbM  = vec3<f16>(textureSample(inputTexture, inputSampler, uv).rgb);

  let lumNW = luminance16(rgbNW);
  let lumNE = luminance16(rgbNE);
  let lumSW = luminance16(rgbSW);
  let lumSE = luminance16(rgbSE);
  let lumM  = luminance16(rgbM);

  let lumMin = min(lumM, min(min(lumNW, lumNE), min(lumSW, lumSE)));
  let lumMax = max(lumM, max(max(lumNW, lumNE), max(lumSW, lumSE)));

  // Edge-direction + step: computed in F32 for sub-texel precision. The
  // luminances promote back to f32 here (they came from f16 but the
  // range is small so no precision is lost across the boundary).
  let lNW = f32(lumNW);
  let lNE = f32(lumNE);
  let lSW = f32(lumSW);
  let lSE = f32(lumSE);

  var dir: vec2<f32>;
  dir.x = -((lNW + lNE) - (lSW + lSE));
  dir.y =  ((lNW + lSW) - (lNE + lSE));

  let dirReduce = max(
    (lNW + lNE + lSW + lSE) * 0.25 * FXAA_REDUCE_MUL,
    FXAA_REDUCE_MIN
  );
  let rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
  dir = clamp(dir * rcpDirMin, vec2<f32>(-FXAA_SPAN_MAX), vec2<f32>(FXAA_SPAN_MAX)) * ts;

  // Edge samples (f16 color) at f32 UVs.
  let rgbA = 0.5h * (
    vec3<f16>(textureSample(inputTexture, inputSampler, uv + dir * (1.0 / 3.0 - 0.5)).rgb) +
    vec3<f16>(textureSample(inputTexture, inputSampler, uv + dir * (2.0 / 3.0 - 0.5)).rgb)
  );
  let rgbB = rgbA * 0.5h + 0.25h * (
    vec3<f16>(textureSample(inputTexture, inputSampler, uv + dir * -0.5).rgb) +
    vec3<f16>(textureSample(inputTexture, inputSampler, uv + dir *  0.5).rgb)
  );

  let lumB = luminance16(rgbB);

  var finalColor: vec3<f16>;
  if (lumB < lumMin || lumB > lumMax) {
    finalColor = rgbA;
  } else {
    finalColor = rgbB;
  }

  return vec4<f32>(vec3<f32>(finalColor), 1.0);
}
