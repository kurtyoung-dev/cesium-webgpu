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

// ACES Filmic (Stephen Hill's fit)
fn acesTonemap(color: vec3<f32>) -> vec3<f32> {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp(
    (color * (a * color + b)) / (color * (c * color + d) + e),
    vec3<f32>(0.0), vec3<f32>(1.0)
  );
}

// Uncharted 2 Filmic (John Hable)
fn uc2Curve(x: vec3<f32>) -> vec3<f32> {
  let A = 0.15; // Shoulder strength
  let B = 0.50; // Linear strength
  let C = 0.10; // Linear angle
  let D = 0.20; // Toe strength
  let E = 0.02; // Toe numerator
  let F = 0.30; // Toe denominator
  return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
}

fn filmicTonemap(color: vec3<f32>) -> vec3<f32> {
  let W = 11.2; // Linear white point
  let mapped = uc2Curve(color);
  let whiteScale = vec3<f32>(1.0) / uc2Curve(vec3<f32>(W));
  return mapped * whiteScale;
}

// Modified Reinhard with white point (Eq. 4)
fn modifiedReinhardTonemap(color: vec3<f32>, white: f32) -> vec3<f32> {
  let whSq = white * white;
  return (color * (vec3<f32>(1.0) + color / whSq)) / (vec3<f32>(1.0) + color);
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

  return vec4<f32>(corrected, 1.0);
}
