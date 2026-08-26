// GodRayGenerate — Screen-space light shafts ("god rays").
//
// Radial blur from a caller-provided sun screen-UV. For each output pixel
// we step toward the sun, sample scene color along the way, and attenuate
// samples whose scene depth is closer than the far plane (i.e. occluded
// by geometry). The result is additively composited onto the scene color
// in a separate `GodRayCompositeEffect` step.
//
// References:
//   - Mitchell, "Volumetric Light Scattering as a Post-Process" (GPU Gems 3)
//   - Orillusion's `GodRayPost.ts` for the depth-gated variant
//   - Shota Matsuda, Takram — `@takram/three-clouds` in three-geospatial
//     (MIT), https://github.com/takram-design-engineering/three-geospatial —
//     for resolving cloud occlusion of the shaft from the cloud march's own
//     transmittance rather than from scene depth, which a cloud pass that
//     writes no depth cannot supply. Technique only; no source was copied.
//
// Design choices:
//   - Takes a screen-space sun UV rather than computing from world-space
//     sun direction + view/projection. Cesium already has `sunPositionWC`
//     + viewProjection available on `UniformState`; the effect class
//     converts once per frame on the CPU.
//   - Depth-occlusion gating uses the linearized depth of each sample.
//     Pixels where linear-depth > `occlusionFarCutoff * far` are treated
//     as "sky" and contribute their color directly; closer pixels
//     occlude the ray (contribute zero).
//   - No HDR / bright-pass — the caller is expected to feed in the
//     post-tonemap scene color (or the bloom bright-pass output) as the
//     source. Keeping the effect unopinionated lets it sit either before
//     or after bloom in the chain.

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct GodRayUniforms {
  // .xy = sun screen UV (0..1, with y DOWN matching WebGPU convention).
  //       Values outside [0,1] are allowed — the shader clips via the
  //       bright-pass exposure so off-screen suns still produce a
  //       directional glow across the visible region.
  // .z  = density      — step size multiplier (default 0.96)
  // .w  = decay        — per-sample falloff (default 0.95)
  params0: vec4<f32>,
  // .x = weight        — per-sample brightness (default 0.5)
  // .y = exposure      — final output gain (default 0.15)
  // .z = sampleCount   — integer (cast), default 64, max 128
  // .w = occlusionFarCutoff (0.99 default) — depths above far*this are
  //                    treated as sky (transparent to the ray)
  params1: vec4<f32>,
  // frustum: x = near, y = far (for depth linearization),
  //          z = logActive, w = unused
  frustum: vec4<f32>,
};

@group(0) @binding(0) var sceneColorTex: texture_2d<f32>;
@group(0) @binding(1) var sceneDepthTex: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;
@group(0) @binding(3) var<uniform> uniforms: GodRayUniforms;
// Cloud-aware god rays — per-pixel cloud TRANSMITTANCE
// (1 = clear sky, 0 = fully opaque cloud) produced by the procedural cloud
// renderer's mask pass. Default binding is a 1×1 white (r8unorm 255 → exactly
// 1.0) fallback, so multiplying by it is byte-identical to the depth-only
// path. When cloud-aware is active the effect binds the real screen-space
// transmittance so dense clouds attenuate the shaft (crepuscular rays that
// stream through cloud gaps instead of leaking bright cloud color as "sky").
@group(0) @binding(4) var cloudTransTex: texture_2d<f32>;

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var out: VertexOutput;
  let x = f32(i32(vertexIndex & 1u) * 4 - 1);
  let y = f32(i32(vertexIndex >> 1u) * 4 - 1);
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return out;
}

// Reverse a logarithmic depth sample to hyperbolic
// window depth [0,1]. Byte-compatible with WebGL czm_reverseLogDepth.
fn logDepthReverse(logZ: f32, near: f32, far: f32) -> f32 {
  if (far <= near) { return logZ; }
  let log2FarDepthFromNearPlusOne = log2((far - near) + 1.0);
  let depthFromNear = exp2(logZ * log2FarDepthFromNearPlusOne) - 1.0;
  let depthFromCamera = depthFromNear + near;
  return far * (1.0 - near / depthFromCamera) / (far - near);
}

fn linearizeDepth(raw: f32) -> f32 {
  let near = uniforms.frustum.x;
  let far = uniforms.frustum.y;
  // Reverse log depth before linearizing when active.
  var d = raw;
  if (uniforms.frustum.z > 0.5) {
    d = logDepthReverse(raw, near, far);
  }
  return near * far / (far - d * (far - near));
}

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
  let sunUV = uniforms.params0.xy;
  let density = uniforms.params0.z;
  let decay = uniforms.params0.w;
  let weight = uniforms.params1.x;
  let exposure = uniforms.params1.y;
  // Clamp sample count to 128 so a misconfigured uniform can't produce
  // a pathological loop on the GPU.
  let sampleCount = i32(clamp(uniforms.params1.z, 1.0, 128.0));
  let occlusionCutoff = uniforms.params1.w;
  let far = uniforms.frustum.y;

  // Vector from the pixel toward the sun, scaled so `sampleCount` steps
  // cover `density`×(pixel-to-sun) distance. Values of density < 1 don't
  // reach the sun; that's desired — it keeps the trailing decay tail
  // bright at the source end instead of pegging at zero when the pixel
  // is near the sun.
  let deltaUV = (sunUV - in.uv) * (density / f32(sampleCount));

  var stepUV = in.uv;
  var illumination: vec3<f32> = vec3<f32>(0.0);
  var illumDecay: f32 = 1.0;

  // March toward the sun. For each sample:
  //   - read color
  //   - read depth; if closer than the sky cutoff, the pixel is blocking
  //     the ray → contribute zero (geometry obscures the shaft).
  //   - else the pixel is sky → its color leaks through proportional to
  //     `weight * illumDecay`.
  // The decay accumulates per step so samples far from the destination
  // contribute less, producing the characteristic radial tail.
  for (var i = 0; i < sampleCount; i = i + 1) {
    stepUV = stepUV + deltaUV;
    let rawDepth = textureSampleLevel(
      sceneDepthTex, texSampler, stepUV, 0.0,
    ).r;
    let linearDepth = linearizeDepth(rawDepth);
    let isSky = step(far * occlusionCutoff, linearDepth);
    // Cloud transmittance gate — 1.0 (white fallback) leaves the shaft
    // untouched; a dense cloud (transmittance → 0) blocks the sky sample.
    let cloudTrans = textureSampleLevel(
      cloudTransTex, texSampler, stepUV, 0.0,
    ).r;
    let sample = textureSampleLevel(
      sceneColorTex, texSampler, stepUV, 0.0,
    ).rgb * isSky * cloudTrans;
    illumination = illumination + sample * (weight * illumDecay);
    illumDecay = illumDecay * decay;
  }

  return vec4<f32>(illumination * exposure, 1.0);
}
