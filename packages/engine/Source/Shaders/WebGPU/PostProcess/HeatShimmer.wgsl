// HeatShimmer — Screen-space animated UV-warp ("heat haze" / mirage).
//
// Single-pass post-process: each output pixel samples the scene color at a
// slightly warped UV. The warp is an animated, hash-based value-noise field
// biased toward the VERTICAL (heat rises) and concentrated in the LOWER
// frame (hot ground), fading to zero near the top (sky). Optionally the warp
// amplitude can fall off with scene depth so distant geometry shimmers less.
//
// Design choices (mirrors GodRayGenerate's structure):
//   - Same fullscreen-triangle vertexMain + y-DOWN UV convention. With this
//     convention larger uv.y = LOWER on screen, so the band weight ramps up
//     as uv.y increases toward the bottom of the visible frame.
//   - No texture dependency for the noise — a small integer hash feeds a
//     2-3 octave value-noise so the effect is self-contained (no extra
//     bindings beyond scene color + depth + sampler + uniforms, matching
//     GodRay generate).
//   - Depth-independent by default: when depthFadeFar <= 0 the depth sample
//     is ignored entirely, so the pass never produces black/garbage even if
//     the depth texture is a placeholder.
//   - intensity <= 0 is a byte-identical passthrough (samples the unwarped
//     UV), so the configure pass can leave the effect enabled but inert.

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct HeatShimmerUniforms {
  // .x = time (ELAPSED SECONDS — small magnitude so f32 keeps precision;
  //            a raw JulianDate would freeze the animation)
  // .y = intensity (0..1 master amount; <=0 → passthrough)
  // .z = frequency (spatial scale of the noise field)
  // .w = speed     (animation speed multiplier)
  params0: vec4<f32>,
  // .x = horizonBandCenterV (UV-space v where the band reaches full strength)
  // .y = horizonBandWidth   (UV-space width of the ramp below the center)
  // .z = depthFadeFar       (linear distance where the warp fully fades; <=0
  //                          disables the depth fade entirely)
  // .w = maxOffsetPx        (max sample offset in PIXELS at full intensity)
  params1: vec4<f32>,
  // .x = near, .y = far (for depth linearization)
  // .z = texelW (1/width), .w = texelH (1/height) — converts px → UV offset
  frustum: vec4<f32>,
};

@group(0) @binding(0) var sceneColorTex: texture_2d<f32>;
@group(0) @binding(1) var sceneDepthTex: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;
@group(0) @binding(3) var<uniform> uniforms: HeatShimmerUniforms;

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var out: VertexOutput;
  let x = f32(i32(vertexIndex & 1u) * 4 - 1);
  let y = f32(i32(vertexIndex >> 1u) * 4 - 1);
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return out;
}

fn linearizeDepth(raw: f32) -> f32 {
  let near = uniforms.frustum.x;
  let far = uniforms.frustum.y;
  return near * far / (far - raw * (far - near));
}

// 2D integer hash → [0,1). Cheap, no texture dependency.
fn hash2(p: vec2<f32>) -> f32 {
  let h = dot(p, vec2<f32>(127.1, 311.7));
  return fract(sin(h) * 43758.5453123);
}

// Value noise: bilinear interpolation of hashed lattice corners with a
// smoothstep fade so the field is C1-continuous (no faceting).
fn valueNoise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let a = hash2(i + vec2<f32>(0.0, 0.0));
  let b = hash2(i + vec2<f32>(1.0, 0.0));
  let c = hash2(i + vec2<f32>(0.0, 1.0));
  let d = hash2(i + vec2<f32>(1.0, 1.0));
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// 3-octave fractal value noise. Octave count is a COMPILE-TIME constant —
// never uniform-driven — so the loop can be unrolled and the pipeline stays
// stable across uniform changes.
fn fbm(p: vec2<f32>) -> f32 {
  var value = 0.0;
  var amplitude = 0.5;
  var freq = p;
  for (var i = 0; i < 3; i = i + 1) {
    value = value + amplitude * valueNoise(freq);
    freq = freq * 2.0;
    amplitude = amplitude * 0.5;
  }
  return value;
}

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
  let time = uniforms.params0.x;
  let intensity = uniforms.params0.y;
  let frequency = uniforms.params0.z;
  let speed = uniforms.params0.w;

  // intensity <= 0 → byte-identical passthrough.
  if (intensity <= 0.0) {
    return textureSampleLevel(sceneColorTex, texSampler, in.uv, 0.0);
  }

  let bandCenterV = uniforms.params1.x;
  let bandWidth = uniforms.params1.y;
  let depthFadeFar = uniforms.params1.z;
  let maxOffsetPx = uniforms.params1.w;
  let texel = uniforms.frustum.zw;

  // Two decorrelated animated noise samples scroll UPWARD (heat rising) at
  // slightly different frequencies/phases so the warp doesn't look uniform.
  let n1 = fbm(in.uv * frequency + vec2<f32>(0.0, time * speed));
  let n2 = fbm(
    in.uv * frequency * 1.3 + vec2<f32>(5.2, time * speed * 0.85 + 11.0),
  );
  var warp = vec2<f32>(n1, n2) * 2.0 - vec2<f32>(1.0);
  // Bias toward VERTICAL displacement — heat shimmer wobbles mostly up/down.
  warp.x = warp.x * 0.5;

  // Band weight: ~0 at the top (sky), ramping to full strength toward the
  // bottom of the visible frame. With the y-DOWN UV convention larger uv.y is
  // LOWER on screen, so smoothstep(center - width, center, uv.y) concentrates
  // the shimmer at the bottom (hot ground) exactly as desired.
  let bandWeight = smoothstep(bandCenterV - bandWidth, bandCenterV, in.uv.y);

  // Optional depth fade. Skip entirely when depthFadeFar <= 0 so the pass is
  // depth-independent (never garbage on a placeholder depth texture).
  var depthWeight = 1.0;
  if (depthFadeFar > 0.0) {
    let rawDepth = textureSampleLevel(sceneDepthTex, texSampler, in.uv, 0.0).r;
    let linearDepth = linearizeDepth(rawDepth);
    depthWeight = 1.0 - smoothstep(0.0, depthFadeFar, linearDepth);
  }

  let offsetUV =
    warp * bandWeight * depthWeight * intensity * (maxOffsetPx * texel);

  // Clamp the sample coord to [0,1] so the warp can never read outside the
  // frame (belt-and-suspenders alongside clamp-to-edge sampling).
  let sampleUV = clamp(in.uv + offsetUV, vec2<f32>(0.0), vec2<f32>(1.0));
  return textureSampleLevel(sceneColorTex, texSampler, sampleUV, 0.0);
}
