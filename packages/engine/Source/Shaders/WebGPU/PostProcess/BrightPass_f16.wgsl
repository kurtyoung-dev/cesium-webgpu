// BrightPass — bloom bright-pass, f16 variant.
// Hand-tuned half-precision version of `BrightPass.wgsl`. Selected when
// `context.useShaderF16` is true. Keep in sync with the f32 reference.
//
// f16 policy: the contrast `factor` is computed in F32. With the WebGL
// default contrast=128 the numerator `259 * (contrast + 255)` = 99197,
// which OVERFLOWS f16 (max ~65504); computing the factor in f16 would
// saturate it to +inf and blow out the whole bloom source. The factor is
// a scalar, so keeping it in f32 costs nothing. The per-pixel HSB
// round-trip + the `factor * (scene - 0.5) + 0.5` curve run in F16 — the
// scene color is in [0, 1] and the intermediate stays bounded.

enable f16;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct BrightPassUniforms {
  params: vec4<f32>,
};

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> uniforms: BrightPassUniforms;

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var output: VertexOutput;
  let x = f32(i32(vertexIndex & 1u) * 4 - 1);
  let y = f32(i32(vertexIndex >> 1u) * 4 - 1);
  output.position = vec4<f32>(x, y, 0.0, 1.0);
  output.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return output;
}

// Divide-by-zero guard for the HSB conversion. The f32 reference uses
// czm_epsilon7 (1e-7), but 1e-7 is SUBNORMAL in f16 (min normal ~6.1e-5)
// and WGSL permits flushing subnormals to zero — which would erase the
// guard and yield 0/0 NaN hue on gray pixels on FTZ hardware. 1e-4 is a
// normal f16 value and still far below any visible hue/saturation step.
const EPSILON_HSB: f16 = 0.0001h;

fn rgbToHsb(rgb: vec3<f16>) -> vec3<f16> {
  let K = vec4<f16>(0.0h, -1.0h / 3.0h, 2.0h / 3.0h, -1.0h);
  let p = mix(vec4<f16>(rgb.bg, K.wz), vec4<f16>(rgb.gb, K.xy), step(rgb.b, rgb.g));
  let q = mix(vec4<f16>(p.xyw, rgb.r), vec4<f16>(rgb.r, p.yzx), step(p.x, rgb.r));
  let d = q.x - min(q.w, q.y);
  return vec3<f16>(
    abs(q.z + (q.w - q.y) / (6.0h * d + EPSILON_HSB)),
    d / (q.x + EPSILON_HSB),
    q.x,
  );
}

fn hsbToRgb(hsb: vec3<f16>) -> vec3<f16> {
  let K = vec4<f16>(1.0h, 2.0h / 3.0h, 1.0h / 3.0h, 3.0h);
  let p = abs(fract(hsb.xxx + K.xyz) * 6.0h - K.www);
  return hsb.z * mix(K.xxx, clamp(p - K.xxx, vec3<f16>(0.0h), vec3<f16>(1.0h)), hsb.y);
}

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
  var sceneColor = vec3<f16>(textureSample(inputTexture, inputSampler, in.uv).rgb);
  let contrast = uniforms.params.x;
  let brightness = f16(uniforms.params.y);

  // HSB brightness shift.
  var hsb = rgbToHsb(sceneColor);
  hsb.z = hsb.z + brightness;
  sceneColor = hsbToRgb(hsb);

  // Contrast curve. `factor` computed in F32 (overflow-safe), then
  // narrowed to f16 for the bounded per-pixel curve (factor ~2.97 with
  // the default contrast, well inside f16 range).
  let factor32 = (259.0 * (contrast + 255.0)) / (255.0 * (259.0 - contrast));
  let factor = f16(factor32);
  sceneColor = factor * (sceneColor - vec3<f16>(0.5h)) + vec3<f16>(0.5h);

  sceneColor = clamp(sceneColor, vec3<f16>(0.0h), vec3<f16>(1.0h));

  return vec4<f32>(vec3<f32>(sceneColor), 1.0);
}
