// Tonemapping post-process shader for WebGPU
// Implements multiple tonemapping operators selectable via uniform mode.
// Mode 0 = Reinhard, 1 = ACES Filmic, 2 = Uncharted 2 Filmic,
// Mode 3 = Modified Reinhard (with white point), 4 = PBR Neutral.

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct TonemapUniforms {
  exposure: f32,
  gamma: f32,
  mode: f32,     // 0=Reinhard, 1=ACES, 2=Filmic, 3=ModifiedReinhard, 4=PBRNeutral
  whitePoint: f32, // Used by Modified Reinhard (default 4.0)
  // C6-TPDF-DITHER-FINAL — triangular-PDF dither amplitude applied AFTER
  // gamma, just before the 8-bit quantization at the eventual canvas blit.
  // 0.0 == OFF == byte-identical (the dither term multiplies to exactly 0).
  // Opt-in via `scene.ditherEnabled`. Effective in the HDR post-process
  // pipeline where the intermediate ping-pong textures are rgba16float, so
  // the sub-LSB dither survives in floating point until the final downcast
  // to bgra8unorm breaks up banding across smooth sky/atmosphere/fog
  // gradients. (Add-only UBO growth 16 -> 32 bytes; the three trailing pads
  // keep the struct 16-byte aligned.)
  ditherStrength: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> params: TonemapUniforms;

// Fullscreen triangle — no vertex buffer needed
@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var output: VertexOutput;
  let x = f32(i32(vertexIndex & 1u) * 4 - 1);
  let y = f32(i32(vertexIndex >> 1u) * 4 - 1);
  output.position = vec4<f32>(x, y, 0.0, 1.0);
  output.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return output;
}

// ----- Tonemapping operators -----

// Reinhard (Eq. 3)
fn reinhardTonemap(color: vec3<f32>) -> vec3<f32> {
  return color / (color + vec3<f32>(1.0));
}

// ACES Filmic — EXACT port of WebGL's czm_acesTonemapping
// (Builtin/Functions/acesTonemapping.glsl, the Narkowicz fit variant Cesium
// ships). C4-PLAIN-HDR-GAMMA-TAILS (b): the previous constants were the
// *other* Narkowicz fit (a=2.51,b=0.03,…) which diverged from the WebGL
// reference under `scene.postProcessStages.tonemapper = ACES`.
fn acesTonemap(color: vec3<f32>) -> vec3<f32> {
  let g = 0.985;
  let a = 0.065;
  let b = 0.0001;
  let c = 0.433;
  let d = 0.238;
  let mapped = (color * (color + a) - b) / (color * (g * color + c) + d);
  return clamp(mapped, vec3<f32>(0.0), vec3<f32>(1.0));
}

// Uncharted 2 Filmic (John Hable) — constants matched to WebGL's
// FilmicTonemapping.glsl (A=0.22,B=0.30,C=0.10,D=0.20,E=0.01,F=0.30,W=11.2).
// C4-PLAIN-HDR-GAMMA-TAILS (b): the previous A=0.15/B=0.50/E=0.02 constants
// were a different Hable parameterization and diverged from the reference.
fn uc2Curve(x: vec3<f32>) -> vec3<f32> {
  let A = 0.22; // Shoulder strength
  let B = 0.30; // Linear strength
  let C = 0.10; // Linear angle
  let D = 0.20; // Toe strength
  let E = 0.01; // Toe numerator
  let F = 0.30; // Toe denominator
  return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
}

fn filmicTonemap(color: vec3<f32>) -> vec3<f32> {
  let W = 11.2; // Linear white point
  let mapped = uc2Curve(color);
  let whiteScale = vec3<f32>(1.0) / uc2Curve(vec3<f32>(W));
  return mapped * whiteScale;
}

// Modified Reinhard with white point (Eq. 4) — matches WebGL's
// ModifiedReinhardTonemapping.glsl `(color*(1+color/white))/(1+color)`, where
// `white` is the raw white-point (WebGL's default uniform is Color.WHITE →
// (1,1,1), which makes the operator an identity before gamma). C4-PLAIN-HDR-
// GAMMA-TAILS (b): the previous code divided by `white*white` (and defaulted
// whitePoint to 4.0), squaring the reference denominator.
fn modifiedReinhardTonemap(color: vec3<f32>, white: f32) -> vec3<f32> {
  return (color * (vec3<f32>(1.0) + color / white)) / (vec3<f32>(1.0) + color);
}

// PBR Neutral tonemapping — EXACT port of the Khronos reference used by
// WebGL's czm_pbrNeutralTonemapping (Builtin/Functions/
// pbrNeutralTonemapping.glsl, KhronosGroup/ToneMapping PBR_Neutral).
// NEW-PP-LIBRARY-TONEMAP-ORDER: the previous per-channel soft-clamp
// approximation mapped 1.0 -> ~0.9535 while the reference maps
// 1.0 -> ~0.869 (sRGB-encoded 249 vs 239) — a visible cross-backend
// highlight mismatch under scene.highDynamicRange.
fn pbrNeutralTonemap(colorIn: vec3<f32>) -> vec3<f32> {
  let startCompression = 0.8 - 0.04;
  let desaturation = 0.15;

  var color = colorIn;
  let x = min(color.r, min(color.g, color.b));
  let offset = select(0.04, x - 6.25 * x * x, x < 0.08);
  color = color - vec3<f32>(offset);

  let peak = max(color.r, max(color.g, color.b));
  if (peak < startCompression) {
    return color;
  }

  let d = 1.0 - startCompression;
  let newPeak = 1.0 - d * d / (peak + d - startCompression);
  color = color * (newPeak / peak);

  let g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
  return mix(color, vec3<f32>(newPeak), g);
}

// Gamma correction (sRGB)
fn inverseGamma(color: vec3<f32>, gamma: f32) -> vec3<f32> {
  return pow(max(color, vec3<f32>(0.0)), vec3<f32>(1.0 / gamma));
}

// C6-TPDF-DITHER-FINAL — scalar white-noise hash of the pixel coordinate.
// Hugo Elias / Dave Hoskins style fract-hash (public-domain technique);
// used to seed two independent uniform samples for the triangular PDF.
fn ditherHash12(p: vec2<f32>) -> f32 {
  var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + vec3<f32>(33.33));
  return fract((p3.x + p3.y) * p3.z);
}

// Triangular-PDF dither of one LSB peak amplitude at 8-bit. Subtracting two
// independent uniform[0,1) samples yields a triangular distribution on
// (-1, 1), which whitens quantization error far better than a single
// uniform (rectangular-PDF) sample. Scaled by 1/255 (one 8-bit step) and by
// the opt-in strength (0 == byte-identical no-op).
fn tpdfDither(fragCoord: vec2<f32>, strength: f32) -> vec3<f32> {
  let r1 = ditherHash12(fragCoord);
  let r2 = ditherHash12(fragCoord + vec2<f32>(11.13, 47.79));
  let tri = r1 - r2; // triangular PDF on (-1, 1)
  return vec3<f32>(tri * (strength / 255.0));
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let hdrColor = textureSample(inputTexture, inputSampler, input.uv).rgb;
  let mode = i32(params.mode);

  // Apply exposure
  let exposed = hdrColor * params.exposure;

  // Apply selected tonemapping operator
  var mapped: vec3<f32>;
  if (mode == 1) {
    mapped = acesTonemap(exposed);
  } else if (mode == 2) {
    mapped = filmicTonemap(exposed);
  } else if (mode == 3) {
    mapped = modifiedReinhardTonemap(exposed, params.whitePoint);
  } else if (mode == 4) {
    mapped = pbrNeutralTonemap(exposed);
  } else {
    // mode 0 (default): Reinhard
    mapped = reinhardTonemap(exposed);
  }

  // Apply gamma correction
  let corrected = inverseGamma(mapped, params.gamma);

  // C6-TPDF-DITHER-FINAL / C9-05 — add sub-LSB triangular dither in
  // display-referred space so banding is broken at the final 8-bit
  // quantization. The explicit zero-strength branch prevents both hash
  // evaluations on the default path while returning `corrected` unchanged.
  var dithered = corrected;
  if (params.ditherStrength != 0.0) {
    dithered += tpdfDither(input.position.xy, params.ditherStrength);
  }

  return vec4<f32>(dithered, 1.0);
}
