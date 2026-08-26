// Color grading post-process shader for WebGPU — f16 variant.
//
// Hand-tuned half-precision version of `ColorGrading.wgsl`, selected by
// the post-process pipeline when `context.useShaderF16` is true (opt-in;
// auto-gated on the device granting `shader-f16`). Mirrors the f32
// reference operator-for-operator — keep both in sync.
//
// f16 safety: color grading runs AFTER tonemapping so the input is
// already SDR in [0, 1]. Every intermediate here (brightness offset,
// contrast pivot at 0.5, saturation lerp, temperature/tint scales,
// split-tone tints) stays well inside the f16 normal range, so the
// whole color path converts cleanly. Uniforms stay f32 (scalar runtime
// params, binary-compatible with the f32 packer). The `exp2(exposure)`
// gain is computed in f32 (exposure can be several f-stops → 2^4 = 16,
// still fine, but the exp2 itself is cheaper/more accurate in f32) and
// the input is clamped to the f16 range at the conversion boundary so no
// downstream f16 multiply overflows.
//
// HDR (tonemap-bypass) mode, mirrored from the f32
// reference: when `params.hdrMode > 0.5` the exposed color is Reinhard-
// compressed (c / (1 + c), computed in F32) into [0, 1) BEFORE the f16
// grade, and the SDR clamp is replaced by the w / (1 - w) inversion
// (also in F32). The compressed working value is f16-safe by
// construction. f16 precision near w = 1 (spacing 2^-11) caps the
// decompressed HDR peak around ~2e3 — an accepted f16-variant tradeoff
// (the f32 reference resolves to ~2e4). hdrMode == 0 (default) is
// bit-for-bit the historical SDR path.

enable f16;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

// Uniform layout is byte-identical to ColorGrading.wgsl so the same
// packColorGradingUniforms() feeds both variants.
struct ColorGradingUniforms {
  exposure: f32,
  brightness: f32,
  contrast: f32,
  saturation: f32,
  temperature: f32,
  tint: f32,
  gamma: f32,
  // 0 = SDR (historical path, default), 1 = HDR tonemap-bypass mode.
  hdrMode: f32,
  shadowsTint: vec4<f32>,
  midtonesTint: vec4<f32>,
  highlightsTint: vec4<f32>,
};

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> params: ColorGradingUniforms;

const F16_MAX_HDR: f32 = 65000.0; // headroom below 65504
// HDR working-space cap (see the f32 reference): compressed values are
// clamped just below 1 so the w / (1 - w) inversion stays finite.
const HDR_COMPRESS_MAX: f32 = 0.99995;

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var output: VertexOutput;
  let x = f32(i32(vertexIndex & 1u) * 4 - 1);
  let y = f32(i32(vertexIndex >> 1u) * 4 - 1);
  output.position = vec4<f32>(x, y, 0.0, 1.0);
  output.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return output;
}

// Luminance of an RGB color — Rec.709 coefficients.
fn luminance(c: vec3<f16>) -> f16 {
  return dot(c, vec3<f16>(0.2126h, 0.7152h, 0.0722h));
}

fn applyBCS(color: vec3<f16>, brightness: f16, contrast: f16, saturation: f16) -> vec3<f16> {
  var c = color + vec3<f16>(brightness);
  let pivot = vec3<f16>(0.5h);
  c = mix(pivot, c, vec3<f16>(contrast));
  let lum = vec3<f16>(luminance(c));
  c = mix(lum, c, vec3<f16>(saturation));
  return c;
}

fn applyTemperatureTint(color: vec3<f16>, temperature: f16, tint: f16) -> vec3<f16> {
  let tempScale = vec3<f16>(
    1.0h + temperature * 0.15h,
    1.0h,
    1.0h - temperature * 0.15h,
  );
  let tintScale = vec3<f16>(
    1.0h + tint * 0.05h,
    1.0h - tint * 0.10h,
    1.0h + tint * 0.05h,
  );
  return color * tempScale * tintScale;
}

fn applyColorBalance(
  color: vec3<f16>,
  shadowsTint: vec4<f16>,
  midtonesTint: vec4<f16>,
  highlightsTint: vec4<f16>,
) -> vec3<f16> {
  let lum = luminance(color);
  let shadowW = 1.0h - smoothstep(0.0h, 0.5h, lum);
  let highlightW = smoothstep(0.5h, 1.0h, lum);
  let midW = 1.0h - shadowW - highlightW;
  let tinted =
    color
    + shadowsTint.rgb * (shadowW * shadowsTint.w)
    + midtonesTint.rgb * (midW * midtonesTint.w)
    + highlightsTint.rgb * (highlightW * highlightsTint.w);
  return tinted;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  // Sample + exposure gain IN F32 (exp2 of an f-stop offset), then clamp
  // to the f16 range before any f16 multiply. Input is post-tonemap SDR
  // so this clamp is effectively never hit; it's an overflow guard.
  let sampled = textureSample(inputTexture, inputSampler, input.uv).rgb;
  let hdrMode = params.hdrMode > 0.5;
  var exposed32 = clamp(
    max(sampled, vec3<f32>(0.0)) * exp2(params.exposure),
    vec3<f32>(0.0),
    vec3<f32>(F16_MAX_HDR),
  );

  // HDR mode: Reinhard-compress in F32 before the f16 conversion — the
  // compressed working value lives in [0, 1), safely inside f16 range.
  if (hdrMode) {
    exposed32 = exposed32 / (1.0 + exposed32);
  }

  var color = vec3<f16>(exposed32);

  color = applyBCS(
    color, f16(params.brightness), f16(params.contrast), f16(params.saturation),
  );
  color = applyTemperatureTint(
    color, f16(params.temperature), f16(params.tint),
  );
  color = applyColorBalance(
    color,
    vec4<f16>(params.shadowsTint),
    vec4<f16>(params.midtonesTint),
    vec4<f16>(params.highlightsTint),
  );

  // Output gamma correction (gamma = 1 for identity). `pow` on f16 is
  // fine here — the base is clamped to >= 0 and the range is bounded.
  let gamma = f16(max(params.gamma, 0.0001));
  color = pow(max(color, vec3<f16>(0.0h)), vec3<f16>(1.0h / gamma));

  if (hdrMode) {
    // Invert the range compression in F32 (1 - w underflows in f16 as
    // w → 1) instead of clamping to SDR — output stays linear HDR.
    let w = clamp(
      vec3<f32>(color),
      vec3<f32>(0.0),
      vec3<f32>(HDR_COMPRESS_MAX),
    );
    return vec4<f32>(w / (1.0 - w), 1.0);
  }

  color = clamp(color, vec3<f16>(0.0h), vec3<f16>(1.0h));

  return vec4<f32>(vec3<f32>(color), 1.0);
}
