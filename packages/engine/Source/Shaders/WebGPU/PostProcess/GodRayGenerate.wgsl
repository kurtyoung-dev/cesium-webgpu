// GodRayGenerate — Screen-space light shafts ("god rays").
//
// The pass answers one question per output pixel: how much of the chord from
// this pixel toward the sun is unobstructed? That fraction modulates an
// ISOLATED sun emitter. The scene colour along the chord is NOT the emitter
// and is not read here at all, so a bright sky cannot leak into the shaft.
//
// References:
//   - Mitchell, "Volumetric Light Scattering as a Post-Process" (GPU Gems 3)
//     — the radial march. Its weight/decay controls are artistic, not a
//     physical volumetric model, and its formulation assumes the source
//     buffer is a bright-pass in which only the light is non-black.
//   - Orillusion's `GodRayPost.ts` for the depth-gated variant
//   - Shota Matsuda, Takram — `@takram/three-clouds` in three-geospatial
//     (MIT), https://github.com/takram-design-engineering/three-geospatial —
//     for resolving cloud occlusion of the shaft from the cloud march's own
//     transmittance rather than from scene depth, which a cloud pass that
//     writes no depth cannot supply. Technique only; no source was copied.
//
// THE LAW.
//
//   ray = sunRadiance * gain(weight, exposure, decay)
//                     * glow(|pixel - sun|, glowRadius)
//                     * transmittance(chord)
//
//   transmittance = sum(visibility_i * A(t_i)) / sum(A(t_i))
//   A(t)          = decay ^ (GODRAY_REFERENCE_SAMPLES * t),   t in (0, 1)
//   gain          = weight * exposure / (1 - decay)
//   glow(d, r)    = 1 / (1 + (d / r)^2)
//
// WHY IT IS SHAPED THAT WAY.
//
//   * transmittance is a RATIO of two quadratures of the same attenuation
//     profile, so it lies in [0, 1] by construction and a fully clear chord
//     gives exactly 1 at every sample count. Sample count is therefore a
//     quality control: it changes how finely the occlusion profile is
//     resolved, not how bright the result is. The predecessor accumulated
//     sum(decay^i) unnormalised, which made the same uniform input 0.8398x
//     brighter at 16 samples and 1.4979x at 128 — a 1.784x spread driven
//     purely by the loop trip count.
//
//   * A(t) is indexed by PATH FRACTION, not by sample index. The predecessor
//     decay^i meant the chord falloff SHAPE also moved with the sample count:
//     0.95^16 = 0.44 of the weight survived the full chord at 16 samples and
//     0.95^128 = 0.0014 at 128. Pinning the exponent to
//     GODRAY_REFERENCE_SAMPLES — the shipped default sample count — keeps the
//     shape the shipped defaults produced and takes the sample count out of it.
//
//   * gain reproduces the predecessor's own supremum. Its unnormalised sum
//     converged to weight * exposure / (1 - decay) = 1.5 at the shipped
//     defaults, so a unit-radiance sun at the centre of the glow with a clear
//     chord still adds 1.5. What changed is that the 1.5 no longer multiplies
//     the SKY colour, and no longer moves with the sample count.
//
//   * glow supplies the radial falloff the predecessor obtained only by
//     accident. With a bright-pass source, the Mitchell march reaches the sun's
//     screen footprint only for pixels closer than r_sun / (1 - density); with
//     the shipped density 0.96 and a 0.53-degree sun under a 60-degree
//     vertical field of view that cutoff is about 0.10 in UV, which is the
//     shipped glowRadius default. Feeding the FULL scene colour instead of a
//     bright-pass removed the falloff entirely and brightened every sky pixel
//     on screen by the same multiplier, which is the washout this law removes.
//     The Lorentzian is an artistic profile, not a measured aureole; a
//     calibration capture is what sets its value for a given scene.
//
// COLOUR SPACE AND PASS ORDER — a stated dependency, not a claim.
//   This pass runs at step 2.5 of WebGPUPostProcessPipeline.execute, after
//   Bloom and before Tonemapping, so the buffer the composite adds into is the
//   pre-tonemap (HDR, when HDR is on) scene colour and sunRadiance is a
//   radiance in that buffer's units. Nothing here reorders those passes; the
//   reviewed ordering and colour-space contract is a separate row.

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct GodRayUniforms {
  // .xy = sun screen UV (0..1, with y DOWN matching WebGPU convention).
  //       Values outside [0,1] are allowed — an off-screen sun still pulls a
  //       directional glow across the visible region.
  // .z  = density      — fraction of the pixel-to-sun chord marched (0.96)
  // .w  = decay        — chord falloff control (default 0.95); see A(t)
  params0: vec4<f32>,
  // .x = weight        — scattering strength (default 0.5)
  // .y = exposure      — final output gain (default 0.15)
  // .z = sampleCount   — integer (cast), default 64, max 128. QUALITY ONLY.
  // .w = occlusionFarCutoff (0.99 default) — depths above far*this are
  //                    treated as sky (transparent to the ray)
  params1: vec4<f32>,
  // frustum: x = near, y = far (for depth linearization),
  //          z = logActive, w = unused
  frustum: vec4<f32>,
  // .xyz = sunRadiance — the ISOLATED emitter, in the scene colour buffer's
  //        own units. Default (1,1,1). This is the only place the shaft's
  //        colour comes from; the scene colour texture is never read.
  // .w  = glowRadius   — screen-space glow radius in UV (default 0.1)
  params2: vec4<f32>,
  // .x = aspect        — width/height, so the glow is round on screen
  // .y = sunUnusable   — >= 0.5 disables the effect for this frame (sun
  //                      behind the camera, or a non-finite projection).
  //                      0 is the default and leaves the effect on.
  // .zw = unused
  params3: vec4<f32>,
};

@group(0) @binding(0) var sceneColorTex: texture_2d<f32>;
@group(0) @binding(1) var sceneDepthTex: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;
@group(0) @binding(3) var<uniform> uniforms: GodRayUniforms;
// Cloud-aware god rays — per-pixel cloud TRANSMITTANCE
// (1 = clear sky, 0 = fully opaque cloud) produced by the procedural cloud
// renderer's mask pass. Default binding is a 1x1 white (r8unorm 255 -> exactly
// 1.0) fallback, so multiplying by it leaves the depth-only path untouched.
// When cloud-aware is active the effect binds the real screen-space
// transmittance so dense clouds attenuate the shaft (crepuscular rays that
// stream through cloud gaps instead of leaking bright cloud colour as "sky").
@group(0) @binding(4) var cloudTransTex: texture_2d<f32>;

// The sample count whose chord shape the law is pinned to. It is the shipped
// GodRayConfig.sampleCount default, so the default configuration's falloff is
// the one the predecessor produced; every other sample count now resolves that
// same shape more or less finely instead of changing it.
const GODRAY_REFERENCE_SAMPLES: f32 = 64.0;
// gain divides by (1 - decay); the upper clamp keeps that finite and the lower
// one keeps the quadrature alive.
//
// The lower clamp is DERIVED, not chosen. The first quadrature node sits at
// path fraction t = 0.5 / sampleCount, so its weight is
// decay ^ (GODRAY_REFERENCE_SAMPLES * 0.5 / sampleCount) — largest exponent at
// the smallest sample count the shader permits, sampleCount = 1, which gives
// decay ^ 32. For that to stay a NORMAL f32 (subnormals are flush-to-zero on
// much hardware, so "non-zero in f64" is not enough) it must be at least
// 2^-126, i.e. decay >= 2^(-126/32) = 0.06527. Below that floor EVERY weight
// underflows, weightSum is 0, godRayTransmittance returns 0 and the shaft is
// black — the opposite of what a lower clamp is for. 0.07 clears the bound
// with margin (0.07^32 = 1.10e-37, about 9.4x the smallest normal).
const GODRAY_MIN_DECAY: f32 = 0.07;
const GODRAY_MAX_DECAY: f32 = 0.999;
const GODRAY_MIN_GLOW_RADIUS: f32 = 0.0001;

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

// Attenuation along the chord at path fraction t in (0, 1). Expressed in decay
// so the control keeps its shipped meaning, with the exponent pinned to the
// reference sample count so the profile does not move with the loop trip
// count.
fn godRayPathAttenuation(t: f32, decay: f32) -> f32 {
  let d = clamp(decay, GODRAY_MIN_DECAY, GODRAY_MAX_DECAY);
  return pow(d, GODRAY_REFERENCE_SAMPLES * t);
}

// Peak additive radiance for a unit-radiance sun at the centre of the glow
// with a fully clear chord — the predecessor's own large-N limit.
fn godRayGain(weight: f32, exposure: f32, decay: f32) -> f32 {
  let d = clamp(decay, GODRAY_MIN_DECAY, GODRAY_MAX_DECAY);
  return weight * exposure / (1.0 - d);
}

// Screen-space sun glow: 1 at the sun, monotonically decreasing, integrable
// tails. distanceUV is already aspect-corrected by the caller.
fn godRaySunGlow(distanceUV: f32, glowRadius: f32) -> f32 {
  let r = max(glowRadius, GODRAY_MIN_GLOW_RADIUS);
  let s = distanceUV / r;
  return 1.0 / (1.0 + s * s);
}

// One march step folded into a running sum. Both accumulators go through this,
// which is what makes the ratio below a normalisation rather than two
// independently drifting sums.
fn godRayAccumulate(sum: f32, visibility: f32, attenuation: f32) -> f32 {
  return sum + visibility * attenuation;
}

// The attenuation-weighted clear fraction of the chord. Dividing by the same
// quadrature that weights the numerator is the whole of the energy law: the
// result is in [0, 1] whatever the sample count, and it is exactly 1 for a
// chord with nothing in it.
fn godRayTransmittance(visibleSum: f32, weightSum: f32) -> f32 {
  if (weightSum <= 0.0) { return 0.0; }
  return clamp(visibleSum / weightSum, 0.0, 1.0);
}

// Everything the fragment stage does after the march, in one place so the
// composition itself is readable — and executable — outside the shader.
fn godRayResolve(
  visibleSum: f32,
  weightSum: f32,
  distanceUV: f32,
  glowRadius: f32,
  weight: f32,
  exposure: f32,
  decay: f32,
) -> f32 {
  let transmittance = godRayTransmittance(visibleSum, weightSum);
  let glow = godRaySunGlow(distanceUV, glowRadius);
  return godRayGain(weight, exposure, decay) * glow * transmittance;
}

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
  let sunUV = uniforms.params0.xy;
  let density = uniforms.params0.z;
  let decay = uniforms.params0.w;
  let weight = uniforms.params1.x;
  let exposure = uniforms.params1.y;
  // Clamp sample count to 128 so a misconfigured uniform cannot produce a
  // pathological loop on the GPU.
  let sampleCount = i32(clamp(uniforms.params1.z, 1.0, 128.0));
  let occlusionCutoff = uniforms.params1.w;
  let far = uniforms.frustum.y;
  let sunRadiance = uniforms.params2.xyz;
  let glowRadius = uniforms.params2.w;
  let aspect = uniforms.params3.x;

  // The caller marks the sun unusable when it is behind the camera or its
  // projection is not finite. Default 0 keeps the effect on.
  if (uniforms.params3.y >= 0.5) {
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }

  let n = f32(sampleCount);
  let invN = 1.0 / n;
  // Vector from the pixel toward the sun, scaled so sampleCount steps cover
  // density x (pixel-to-sun) distance. density < 1 stops the march short of
  // the sun, which keeps the last samples off the sun's own pixels.
  let deltaUV = (sunUV - in.uv) * (density * invN);

  // MIDPOINT sampling: sample i sits at path fraction (i + 0.5) / n, which is
  // the quadrature node its attenuation weight is evaluated at. The
  // predecessor sampled at (i + 1) / n while weighting by index, so the
  // weights and the positions did not line up.
  var stepUV = in.uv + deltaUV * 0.5;
  // A(t) is a pure exponential in t, so the whole weight sequence is generated
  // by two evaluations of the law: the first node and the per-step ratio.
  var atten = godRayPathAttenuation(0.5 * invN, decay);
  let attenStep = godRayPathAttenuation(invN, decay);

  var visibleSum: f32 = 0.0;
  var weightSum: f32 = 0.0;

  // March toward the sun. Each sample contributes its VISIBILITY — 1 when the
  // chord is open there, 0 when geometry blocks it, partial through cloud —
  // never its colour.
  for (var i = 0; i < sampleCount; i = i + 1) {
    let rawDepth = textureSampleLevel(
      sceneDepthTex, texSampler, stepUV, 0.0,
    ).r;
    let linearDepth = linearizeDepth(rawDepth);
    let isSky = step(far * occlusionCutoff, linearDepth);
    // Cloud transmittance gate — 1.0 (white fallback) leaves the shaft
    // untouched; a dense cloud (transmittance -> 0) blocks the sky sample.
    let cloudTrans = textureSampleLevel(
      cloudTransTex, texSampler, stepUV, 0.0,
    ).r;
    let visibility = isSky * cloudTrans;
    visibleSum = godRayAccumulate(visibleSum, visibility, atten);
    weightSum = godRayAccumulate(weightSum, 1.0, atten);
    stepUV = stepUV + deltaUV;
    atten = atten * attenStep;
  }

  let offset = (in.uv - sunUV) * vec2<f32>(aspect, 1.0);
  let amplitude = godRayResolve(
    visibleSum,
    weightSum,
    length(offset),
    glowRadius,
    weight,
    exposure,
    decay,
  );
  return vec4<f32>(sunRadiance * amplitude, 1.0);
}
