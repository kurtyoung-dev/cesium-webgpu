// BrightPass — bloom bright pass, the WebGL-parity port of ContrastBias.glsl,
// the `czm_bloom_contrast_bias` stage inside
// `PostProcessStageLibrary.createBloomStage`.
//
// Cesium's WebGL bloom does not use a luminance threshold. Its bright region
// comes from an HSB brightness shift followed by a contrast curve over the
// scene colour:
//
//   hsb = czm_RGBToHSB(scene); hsb.z += brightness; scene = czm_HSBToRGB(hsb);
//   factor = (259 * (contrast + 255)) / (255 * (259 - contrast));
//   out = factor * (scene - 0.5) + 0.5;
//
// At the WebGL defaults, contrast 128 and brightness -0.3, the factor is
// about 2.97 and only pixels whose HSB value exceeds roughly 0.67 survive
// above black — a selective bright region. Substituting
// `max(color - threshold * avgLum, 0)` with `threshold` fed from WebGL's
// brightness uniform gives a negative threshold, which passes every pixel and
// blooms the whole scene.

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct BrightPassUniforms {
  // x = contrast ((-255, 259) exclusive; WebGL default 128),
  // y = brightness (HSB value offset; WebGL default -0.3),
  // z, w = unused
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

// czm_epsilon7 — guards the divisions in the HSB round-trip.
const EPSILON7: f32 = 0.0000001;

// Port of czm_RGBToHSB (Shaders/Builtin/Functions/RGBToHSB.glsl).
// Minimal-branching RGB -> HSV from http://lolengine.net/blog/2013/07/27.
fn rgbToHsb(rgb: vec3<f32>) -> vec3<f32> {
  let K = vec4<f32>(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  let p = mix(vec4<f32>(rgb.bg, K.wz), vec4<f32>(rgb.gb, K.xy), step(rgb.b, rgb.g));
  let q = mix(vec4<f32>(p.xyw, rgb.r), vec4<f32>(rgb.r, p.yzx), step(p.x, rgb.r));
  let d = q.x - min(q.w, q.y);
  return vec3<f32>(
    abs(q.z + (q.w - q.y) / (6.0 * d + EPSILON7)),
    d / (q.x + EPSILON7),
    q.x,
  );
}

// Port of czm_HSBToRGB (Shaders/Builtin/Functions/HSBToRGB.glsl).
fn hsbToRgb(hsb: vec3<f32>) -> vec3<f32> {
  let K = vec4<f32>(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  let p = abs(fract(hsb.xxx + K.xyz) * 6.0 - K.www);
  return hsb.z * mix(K.xxx, clamp(p - K.xxx, vec3<f32>(0.0), vec3<f32>(1.0)), hsb.y);
}

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
  var sceneColor = textureSample(inputTexture, inputSampler, in.uv).rgb;
  let contrast = uniforms.params.x;
  let brightness = uniforms.params.y;

  // HSB brightness shift (czm_RGBToHSB / czm_HSBToRGB round-trip).
  var hsb = rgbToHsb(sceneColor);
  hsb.z = hsb.z + brightness;
  sceneColor = hsbToRgb(hsb);

  // Contrast curve around mid-gray.
  let factor = (259.0 * (contrast + 255.0)) / (255.0 * (259.0 - contrast));
  sceneColor = factor * (sceneColor - vec3<f32>(0.5)) + vec3<f32>(0.5);

  // WebGL writes this stage to an RGBA8 (UNSIGNED_BYTE) target, which
  // clamps implicitly. Clamp explicitly here so rgba16float HDR
  // intermediates match (negatives would otherwise DARKEN the scene in
  // the additive composite).
  sceneColor = clamp(sceneColor, vec3<f32>(0.0), vec3<f32>(1.0));

  return vec4<f32>(sceneColor, 1.0);
}
