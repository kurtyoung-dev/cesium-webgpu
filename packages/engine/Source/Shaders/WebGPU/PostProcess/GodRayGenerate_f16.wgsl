// GodRayGenerate — f16 variant. Hand-tuned
// half-precision version of `GodRayGenerate.wgsl`. Selected when
// `context.useShaderF16` is true. Keep in sync with the f32 reference, which
// carries the law, its derivation and its references.
//
// f16 policy under the energy law. The march no longer accumulates COLOUR at
// all: it accumulates two scalars, a visibility-weighted sum and the
// attenuation sum it is normalised by, and their ratio is the chord's clear
// fraction. Both stay in F32, as do the marched `stepUV` and the depth
// linearization, for the same reason the predecessor kept its running decay in
// F32 — these are running products and sums over up to 128 steps where f16
// rounding compounds, and here the rounding would land directly on a ratio
// that is supposed to read exactly 1 for a clear chord. Only the final colour
// combine is f16, where the operand is a single product, not a sum.
//
// WHAT THIS DOES NOT CLAIM. The predecessor clamped each source sample to
// 65000 but accumulated the sum in f16, and a per-sample bound does not bound
// a sum. That was recorded as an open lead, never as an observed overflow:
// `context.useShaderF16` reachability is not established, and no capture on
// this path exists. The law's accumulators are bounded by the sample count by
// construction, so the unbounded-sum shape is gone — but that is a property of
// the new arithmetic, not evidence about the old one, and the controlled ray
// fixture's explicit refusal to model f16 amplitude still stands.

enable f16;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct GodRayUniforms {
  params0: vec4<f32>,
  params1: vec4<f32>,
  frustum: vec4<f32>,
  // .xyz = sunRadiance (the isolated emitter), .w = glowRadius
  params2: vec4<f32>,
  // .x = aspect, .y = sunUnusable (>= 0.5 disables), .zw unused
  params3: vec4<f32>,
};

@group(0) @binding(0) var sceneColorTex: texture_2d<f32>;
@group(0) @binding(1) var sceneDepthTex: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;
@group(0) @binding(3) var<uniform> uniforms: GodRayUniforms;
// Cloud-aware god rays — see GodRayGenerate.wgsl, which carries the technique
// reference for the cloud-transmittance mask. 1x1 white
// (r8unorm) fallback -> exactly 1.0 -> the depth-only path untouched.
@group(0) @binding(4) var cloudTransTex: texture_2d<f32>;

const F16_MAX_HDR: f32 = 65000.0;
const GODRAY_REFERENCE_SAMPLES: f32 = 64.0;
// Kept in step with GodRayGenerate.wgsl, which carries the derivation: the
// floor is what keeps the first quadrature node a NORMAL f32 at sampleCount 1.
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

// Reverse log depth (kept f32; log2/exp2 overflow f16).
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

// The four law functions below are byte-identical to the f32 reference on
// purpose: they are the law, and a half-precision twin that quietly evaluated
// a different law would be the hardest kind of drift to see.
fn godRayPathAttenuation(t: f32, decay: f32) -> f32 {
  let d = clamp(decay, GODRAY_MIN_DECAY, GODRAY_MAX_DECAY);
  return pow(d, GODRAY_REFERENCE_SAMPLES * t);
}

fn godRayGain(weight: f32, exposure: f32, decay: f32) -> f32 {
  let d = clamp(decay, GODRAY_MIN_DECAY, GODRAY_MAX_DECAY);
  return weight * exposure / (1.0 - d);
}

fn godRaySunGlow(distanceUV: f32, glowRadius: f32) -> f32 {
  let r = max(glowRadius, GODRAY_MIN_GLOW_RADIUS);
  let s = distanceUV / r;
  return 1.0 / (1.0 + s * s);
}

fn godRayAccumulate(sum: f32, visibility: f32, attenuation: f32) -> f32 {
  return sum + visibility * attenuation;
}

fn godRayTransmittance(visibleSum: f32, weightSum: f32) -> f32 {
  if (weightSum <= 0.0) { return 0.0; }
  return clamp(visibleSum / weightSum, 0.0, 1.0);
}

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
  let sampleCount = i32(clamp(uniforms.params1.z, 1.0, 128.0));
  let occlusionCutoff = uniforms.params1.w;
  let far = uniforms.frustum.y;
  let sunRadiance = uniforms.params2.xyz;
  let glowRadius = uniforms.params2.w;
  let aspect = uniforms.params3.x;

  if (uniforms.params3.y >= 0.5) {
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }

  let n = f32(sampleCount);
  let invN = 1.0 / n;
  let deltaUV = (sunUV - in.uv) * (density * invN);

  // UV march, attenuation weights and both accumulators in F32 — see the f16
  // policy note at the top of this file.
  var stepUV = in.uv + deltaUV * 0.5;
  var atten = godRayPathAttenuation(0.5 * invN, decay);
  let attenStep = godRayPathAttenuation(invN, decay);

  var visibleSum: f32 = 0.0;
  var weightSum: f32 = 0.0;

  for (var i = 0; i < sampleCount; i = i + 1) {
    let rawDepth = textureSampleLevel(
      sceneDepthTex, texSampler, stepUV, 0.0,
    ).r;
    let linearDepth = linearizeDepth(rawDepth);
    let isSky = step(far * occlusionCutoff, linearDepth);
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
  // The one f16 step: a single product per channel, no accumulation. The
  // clamp is at the narrowing boundary, and here it genuinely bounds the
  // result — there is no later sum for an unbounded term to hide in.
  let radiance = clamp(
    sunRadiance * amplitude, vec3<f32>(0.0), vec3<f32>(F16_MAX_HDR),
  );
  return vec4<f32>(vec3<f32>(vec3<f16>(radiance)), 1.0);
}
