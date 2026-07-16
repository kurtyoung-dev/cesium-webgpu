// Tonemapping post-process shader for WebGPU — f16 variant (Phase 5 WGF-3).
//
// Hand-tuned half-precision version of `Tonemapping.wgsl`. Used by the
// post-process pipeline when `context.useShaderF16` is true (auto-set when
// the device grants the `shader-f16` feature).
//
// Why a separate file: WGSL doesn't support conditional `enable` directives,
// so the f16 path needs its own translation unit. The f32 reference at
// `Tonemapping.wgsl` is the spec — keep both files in sync if you change
// any of the operator implementations.
//
// HDR clamp policy: pre-tonemap input can exceed the f16 max (~65504) when
// emissive surfaces, sun reflections, or other very-bright sources land in
// the framebuffer. We clamp to `F16_MAX_HDR` immediately after the texture
// fetch so every f16 multiply downstream is overflow-safe. The clamp loses
// dynamic range on extreme highlights but is invisible after tonemapping
// because every operator below already saturates to [0, 1] anyway. Anyone
// running a scene with truly cinematic >65k luminance can disable the f16
// variant via `context.useShaderF16 = false`.

enable f16;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

// Uniforms stay f32 — they're scalar runtime params and the conversion
// cost is negligible. Keeping the layout binary-compatible with the f32
// shader means the same TonemapUniforms packer in
// WebGPUPostProcessPipeline.ts works for both variants.
struct TonemapUniforms {
  exposure: f32,
  gamma: f32,
  mode: f32,        // 0=Reinhard, 1=ACES, 2=Filmic, 3=ModifiedReinhard, 4=PBRNeutral
  whitePoint: f32,  // Used by Modified Reinhard (default 4.0)
  // C6-TPDF-DITHER-FINAL — see Tonemapping.wgsl. Kept binary-compatible with
  // the f32 layout so the same packer feeds both. 0.0 == OFF == byte-identical.
  ditherStrength: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> params: TonemapUniforms;

const F16_MAX_HDR: f16 = 65000.0h; // a hair below 65504 to leave headroom for adds

// Fullscreen triangle — no vertex buffer needed. Vertex stage stays f32
// (clip-space precision is non-negotiable).
@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var output: VertexOutput;
  let x = f32(i32(vertexIndex & 1u) * 4 - 1);
  let y = f32(i32(vertexIndex >> 1u) * 4 - 1);
  output.position = vec4<f32>(x, y, 0.0, 1.0);
  output.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return output;
}

// ----- Tonemapping operators (f16) -----

fn reinhardTonemap(color: vec3<f16>) -> vec3<f16> {
  return color / (color + vec3<f16>(1.0h));
}

// ACES Filmic — EXACT port of WebGL's czm_acesTonemapping (the Narkowicz
// fit variant Cesium ships). The constants are tiny and easily representable
// in f16. Output is clamped to [0,1] which is well inside the f16 normal
// range. C4-PLAIN-HDR-GAMMA-TAILS (b): matched to the f32 / GLSL reference.
fn acesTonemap(color: vec3<f16>) -> vec3<f16> {
  let g: f16 = 0.985h;
  let a: f16 = 0.065h;
  let b: f16 = 0.0001h;
  let c: f16 = 0.433h;
  let d: f16 = 0.238h;
  let mapped = (color * (color + a) - b) / (color * (g * color + c) + d);
  return clamp(mapped, vec3<f16>(0.0h), vec3<f16>(1.0h));
}

// Uncharted 2 Filmic (John Hable) — constants matched to WebGL's
// FilmicTonemapping.glsl. C4-PLAIN-HDR-GAMMA-TAILS (b).
fn uc2Curve(x: vec3<f16>) -> vec3<f16> {
  let A: f16 = 0.22h;
  let B: f16 = 0.30h;
  let C: f16 = 0.10h;
  let D: f16 = 0.20h;
  let E: f16 = 0.01h;
  let F: f16 = 0.30h;
  return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
}

// Uncharted 2 Filmic (John Hable). The white-scale denominator
// `uc2Curve(11.2)` evaluates to ~0.84 — well inside f16 range. The
// linear-white constant W=11.2 is unchanged from the f32 path because
// the input is already clamped to F16_MAX_HDR.
fn filmicTonemap(color: vec3<f16>) -> vec3<f16> {
  let W: f16 = 11.2h;
  let mapped = uc2Curve(color);
  let whiteScale = vec3<f16>(1.0h) / uc2Curve(vec3<f16>(W));
  return mapped * whiteScale;
}

// Modified Reinhard with white point — matches WebGL's
// ModifiedReinhardTonemapping.glsl `(color*(1+color/white))/(1+color)` with
// the raw white-point (default (1,1,1) → identity before gamma).
// C4-PLAIN-HDR-GAMMA-TAILS (b): divide by `white`, not `white*white`.
fn modifiedReinhardTonemap(color: vec3<f16>, white: f16) -> vec3<f16> {
  return (color * (vec3<f16>(1.0h) + color / white)) / (vec3<f16>(1.0h) + color);
}

// PBR Neutral tonemapping (Khronos reference). Identical structure to
// the f32 version with f16 types swapped in — EXACT port of
// czm_pbrNeutralTonemapping (NEW-PP-LIBRARY-TONEMAP-ORDER; the old
// per-channel soft-clamp approximation over-brightened highlights vs
// WebGL: 1.0 -> ~0.9535 instead of the reference ~0.869).
fn pbrNeutralTonemap(colorIn: vec3<f16>) -> vec3<f16> {
  let startCompression: f16 = 0.8h - 0.04h;
  let desaturation: f16 = 0.15h;

  var color = colorIn;
  let x = min(color.r, min(color.g, color.b));
  let offset = select(0.04h, x - 6.25h * x * x, x < 0.08h);
  color = color - vec3<f16>(offset);

  let peak = max(color.r, max(color.g, color.b));
  if (peak < startCompression) {
    return color;
  }

  let d: f16 = 1.0h - startCompression;
  let newPeak = 1.0h - d * d / (peak + d - startCompression);
  color = color * (newPeak / peak);

  let g = 1.0h - 1.0h / (desaturation * (peak - newPeak) + 1.0h);
  return mix(color, vec3<f16>(newPeak), g);
}

// Gamma correction. `pow` on f16 is supported and the input/output range
// is [0,1] so there's no overflow risk.
fn inverseGamma(color: vec3<f16>, gamma: f16) -> vec3<f16> {
  return pow(max(color, vec3<f16>(0.0h)), vec3<f16>(1.0h / gamma));
}

// C6-TPDF-DITHER-FINAL — dither computed in f32 (the display value is in
// [0,1] and the dither is sub-LSB, so f16 precision would swamp it). See
// Tonemapping.wgsl for the technique rationale.
fn ditherHash12(p: vec2<f32>) -> f32 {
  var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + vec3<f32>(33.33));
  return fract((p3.x + p3.y) * p3.z);
}

fn tpdfDither(fragCoord: vec2<f32>, strength: f32) -> vec3<f32> {
  let r1 = ditherHash12(fragCoord);
  let r2 = ditherHash12(fragCoord + vec2<f32>(11.13, 47.79));
  let tri = r1 - r2;
  return vec3<f32>(tri * (strength / 255.0));
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  // Sample at f32 (textureSample always returns f32). The exposure
  // multiply is done IN F32 — doing it in f16 first would overflow
  // intermediates when the user sets a high exposure (e.g. 1000 ×
  // 100 = 1e5, which exceeds f16's ~6.5e4 max and silently saturates
  // every bright pixel to white before tonemapping). The clamp
  // happens at the f32→f16 conversion boundary so no f16 multiply
  // ever sees a value above F16_MAX_HDR.
  let hdrF32 = textureSample(inputTexture, inputSampler, input.uv).rgb;
  let exposed32 = clamp(
    max(hdrF32, vec3<f32>(0.0)) * params.exposure,
    vec3<f32>(0.0),
    vec3<f32>(f32(F16_MAX_HDR)),
  );
  let exposed = vec3<f16>(exposed32);

  let mode = i32(params.mode);

  // Apply selected tonemapping operator
  var mapped: vec3<f16>;
  if (mode == 1) {
    mapped = acesTonemap(exposed);
  } else if (mode == 2) {
    mapped = filmicTonemap(exposed);
  } else if (mode == 3) {
    mapped = modifiedReinhardTonemap(exposed, f16(params.whitePoint));
  } else if (mode == 4) {
    mapped = pbrNeutralTonemap(exposed);
  } else {
    mapped = reinhardTonemap(exposed);
  }

  // Apply gamma correction
  let corrected = inverseGamma(mapped, f16(params.gamma));

  // Convert back to f32 for the fragment output. The render target is
  // a standard `@location(0) vec4<f32>` so the upcast is mandatory.
  // C6-TPDF-DITHER-FINAL / C9-05 — the zero-strength branch keeps both
  // hashes off the default path; enabled math remains the same f32 addition.
  var dithered = vec3<f32>(corrected);
  if (params.ditherStrength != 0.0) {
    dithered += tpdfDither(input.position.xy, params.ditherStrength);
  }

  return vec4<f32>(dithered, 1.0);
}
