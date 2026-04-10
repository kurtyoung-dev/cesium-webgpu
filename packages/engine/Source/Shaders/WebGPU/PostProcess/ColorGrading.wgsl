// Color grading post-process shader for WebGPU
//
// Phase 4 visual quality closure. Runs after tonemapping (so input
// is already SDR in [0, 1]) and applies per-channel color
// transformations:
//
//   - Exposure boost (log2 f-stops)
//   - Brightness offset (additive)
//   - Contrast (pivot at mid-gray)
//   - Saturation (desaturate toward luminance)
//   - Temperature (warm ↔ cool on blue/red axis)
//   - Tint (green ↔ magenta on green/magenta axis)
//   - Color balance split-tone (shadows / midtones / highlights)
//   - Output gamma correction
//
// Intentionally excludes a 3D LUT sampler path — that requires a
// `texture_3d` binding and a LUT upload path, which is a separate
// chunk of work. When a 3D LUT is wanted the shader can be extended
// with a `texture_3d` at @binding(3) + a uniform flag to select
// between the procedural path and the LUT lookup.

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct ColorGradingUniforms {
  // pack 0: exposure, brightness, contrast, saturation
  exposure: f32,
  brightness: f32,
  contrast: f32,
  saturation: f32,
  // pack 1: temperature (-1..1), tint (-1..1), gamma, _pad
  temperature: f32,
  tint: f32,
  gamma: f32,
  _pad0: f32,
  // pack 2: shadows tint RGB + strength
  shadowsTint: vec4<f32>,
  // pack 3: midtones tint RGB + strength
  midtonesTint: vec4<f32>,
  // pack 4: highlights tint RGB + strength
  highlightsTint: vec4<f32>,
};

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> params: ColorGradingUniforms;

// Fullscreen triangle — no vertex buffer needed.
@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var output: VertexOutput;
  let x = f32(i32(vertexIndex & 1u) * 4 - 1);
  let y = f32(i32(vertexIndex >> 1u) * 4 - 1);
  output.position = vec4<f32>(x, y, 0.0, 1.0);
  output.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return output;
}

// Luminance of a linear-RGB color — Rec.709 coefficients.
fn luminance(c: vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

// Apply brightness / contrast / saturation around mid-gray.
fn applyBCS(color: vec3<f32>, brightness: f32, contrast: f32, saturation: f32) -> vec3<f32> {
  // Brightness is a simple additive offset.
  var c = color + vec3<f32>(brightness);

  // Contrast pivots around 0.5 (mid-gray) in SDR. Values > 1 expand
  // the dynamic range; < 1 compress toward the pivot.
  let pivot = vec3<f32>(0.5);
  c = mix(pivot, c, vec3<f32>(contrast));

  // Saturation interpolates between the per-pixel luminance and the
  // original color. 0 = grayscale, 1 = passthrough, > 1 = oversaturated.
  let lum = vec3<f32>(luminance(c));
  c = mix(lum, c, vec3<f32>(saturation));

  return c;
}

// Approximate white balance temperature shift. Positive values warm
// (boost red, suppress blue), negative values cool (boost blue,
// suppress red). The coefficient is small so the effect stays subtle
// until the user pushes the slider hard.
fn applyTemperatureTint(color: vec3<f32>, temperature: f32, tint: f32) -> vec3<f32> {
  let tempScale = vec3<f32>(
    1.0 + temperature * 0.15,
    1.0,
    1.0 - temperature * 0.15,
  );
  // Tint shifts the green/magenta axis. Positive = magenta, negative = green.
  let tintScale = vec3<f32>(
    1.0 + tint * 0.05,
    1.0 - tint * 0.10,
    1.0 + tint * 0.05,
  );
  return color * tempScale * tintScale;
}

// Apply per-tonal-range color tinting. Each tint has an RGB color + a
// strength weight in `.w`. The shadow / midtone / highlight weights
// are derived from the pixel luminance via smooth windows.
fn applyColorBalance(
  color: vec3<f32>,
  shadowsTint: vec4<f32>,
  midtonesTint: vec4<f32>,
  highlightsTint: vec4<f32>,
) -> vec3<f32> {
  let lum = luminance(color);
  // Weight windows — overlapping smoothsteps so the sum is ~= 1.
  let shadowW = 1.0 - smoothstep(0.0, 0.5, lum);
  let highlightW = smoothstep(0.5, 1.0, lum);
  let midW = 1.0 - shadowW - highlightW;
  // Linear additive tint scaled by the window weight + each tint's strength.
  let tinted =
    color
    + shadowsTint.rgb * (shadowW * shadowsTint.w)
    + midtonesTint.rgb * (midW * midtonesTint.w)
    + highlightsTint.rgb * (highlightW * highlightsTint.w);
  return tinted;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  var color = textureSample(inputTexture, inputSampler, input.uv).rgb;

  // Exposure in f-stops (2^exposure).
  color = color * exp2(params.exposure);

  // Per-channel brightness / contrast / saturation.
  color = applyBCS(color, params.brightness, params.contrast, params.saturation);

  // White balance temperature + tint shift.
  color = applyTemperatureTint(color, params.temperature, params.tint);

  // Per-tonal-range color balance.
  color = applyColorBalance(
    color,
    params.shadowsTint,
    params.midtonesTint,
    params.highlightsTint,
  );

  // Output gamma correction (gamma = 1 for identity).
  color = pow(max(color, vec3<f32>(0.0)), vec3<f32>(1.0 / max(params.gamma, 0.0001)));

  // Clamp to SDR range — color grading can produce out-of-range values
  // when the contrast/saturation sliders push the pixel past white.
  color = clamp(color, vec3<f32>(0.0), vec3<f32>(1.0));

  return vec4<f32>(color, 1.0);
}
