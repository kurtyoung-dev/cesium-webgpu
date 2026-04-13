// TAA.wgsl — Temporal Anti-Aliasing resolve pass
//
// Blends the current jittered frame with the previous frame's history
// buffer using motion-vector-based reprojection and neighborhood clamping.
//
// Pipeline order: after ColorGrading, before optional FXAA.
// Input: current frame color (jittered), history buffer, depth.
// Output: resolved anti-aliased color written to the current history slot.

struct TAAParams {
  texelSize: vec2<f32>,        // 1.0 / screenSize
  blendWeight: f32,            // exponential blend (default 0.1 = 10% current)
  frameIndex: u32,             // for debug / Halton cycle
  jitterOffset: vec2<f32>,     // current frame's jitter in UV space
  _pad0: vec2<f32>,
}

@group(0) @binding(0) var currentColor: texture_2d<f32>;
@group(0) @binding(1) var historyColor: texture_2d<f32>;
@group(0) @binding(2) var depthTex: texture_depth_2d;
@group(0) @binding(3) var linearSampler: sampler;
@group(0) @binding(4) var<uniform> params: TAAParams;

// ── Helpers ────────────────────────────────────────────────────────────

fn rgbToLuminance(c: vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

// Tonemap for neighborhood clamping — prevents HDR fireflies from
// dominating the blend. Reinhard on luminance.
fn tonemapWeight(c: vec3<f32>) -> vec3<f32> {
  return c / (1.0 + rgbToLuminance(c));
}

fn inverseTonemapWeight(c: vec3<f32>) -> vec3<f32> {
  return c / (1.0 - rgbToLuminance(c));
}

// ── Neighborhood AABB clamp ────────────────────────────────────────────
//
// Sample a 3×3 neighborhood of the current (jittered) frame and compute
// the min/max AABB in tonemapped color space. Clamp the reprojected
// history sample to this AABB to suppress ghosting from disoccluded
// regions or fast-moving objects.

struct ColorAABB {
  cMin: vec3<f32>,
  cMax: vec3<f32>,
}

fn computeNeighborhoodAABB(uv: vec2<f32>, texSize: vec2<f32>) -> ColorAABB {
  var aabbMin = vec3<f32>(1e10);
  var aabbMax = vec3<f32>(-1e10);

  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let offset = vec2<f32>(f32(dx), f32(dy)) * texSize;
      let s = tonemapWeight(textureSampleLevel(currentColor, linearSampler, uv + offset, 0.0).rgb);
      aabbMin = min(aabbMin, s);
      aabbMax = max(aabbMax, s);
    }
  }

  return ColorAABB(aabbMin, aabbMax);
}

fn clampToAABB(color: vec3<f32>, aabb: ColorAABB) -> vec3<f32> {
  return clamp(color, aabb.cMin, aabb.cMax);
}

// ── Main resolve ───────────────────────────────────────────────────────

@fragment
fn fragmentMain(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
  let texSize = params.texelSize;
  let uv = fragCoord.xy * texSize;

  // Unjitter the UV to sample the current frame at the pixel center.
  let unjitteredUV = uv - params.jitterOffset;

  // Sample current frame color (jittered render, but we unjitter the UV).
  let currentSample = textureSampleLevel(currentColor, linearSampler, unjitteredUV, 0.0).rgb;

  // Reprojection: for now, use a simple UV-based reprojection (no motion
  // vectors). This works for static scenes and slow camera motion.
  // Motion vector support will be added when MRT output is wired.
  let historyUV = unjitteredUV;

  // Sample history buffer.
  let historySample = textureSampleLevel(historyColor, linearSampler, historyUV, 0.0).rgb;

  // Neighborhood clamp: prevent ghosting from disoccluded regions.
  let aabb = computeNeighborhoodAABB(unjitteredUV, texSize);
  let clampedHistory = clampToAABB(tonemapWeight(historySample), aabb);

  // Blend in tonemapped space, then inverse-tonemap.
  let blended = mix(clampedHistory, tonemapWeight(currentSample), params.blendWeight);
  let result = inverseTonemapWeight(blended);

  return vec4<f32>(result, 1.0);
}

// ── Fullscreen vertex shader (shared with other post-process effects) ──

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4<f32> {
  // Fullscreen triangle covering [-1, -1] to [3, 3] (oversize triangle trick).
  let x = f32(i32(vertexIndex) / 2) * 4.0 - 1.0;
  let y = f32(i32(vertexIndex) % 2) * 4.0 - 1.0;
  return vec4<f32>(x, y, 0.0, 1.0);
}
