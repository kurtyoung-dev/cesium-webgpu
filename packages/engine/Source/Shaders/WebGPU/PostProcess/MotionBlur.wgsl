// MotionBlur.wgsl — Velocity-buffer motion blur (C6-VELOCITY-MOTION-BLUR)
//
// Single fullscreen pass. For each pixel it computes a screen-space
// velocity vector and gathers the scene color along that vector, smearing
// fast-moving content in the direction of motion. Opt-in, default-off; a
// byte-identical passthrough when intensity <= 0 (no pass is even recorded
// by the host when the effect is disabled).
//
// Velocity source (two tiers, in priority order):
//   1. Per-pixel model velocity from the MRT velocity texture (rg16float,
//      the SAME buffer TAA consumes — written by the model FS @location(1)
//      as an NDC delta). Non-zero only for velocity-aware geometry
//      (skinned / animated / instanced models). Correctly captures OBJECT
//      motion independent of the camera.
//   2. Camera reprojection from depth. Reuses the exact RTE-safe math from
//      TAA.wgsl: unproject the current depth via inverse(currentVpRte) to
//      an eye-RELATIVE position (sub-km magnitude → FP32 exact at Earth
//      scale), translate by cameraDelta, reproject through previousVpRte.
//      This gives whole-scene CAMERA velocity (globe, tiles, sky) which is
//      what a fast camera pan / fly-to needs.
//
// The final velocity (in UV space) is `currentUV - previousUV`. Color is
// gathered at `uv - velocity * t` for t centered on 0, so the smear
// straddles the pixel's swept path. Velocity length is clamped to
// `maxBlurPx` texels so a teleport / disocclusion can't smear the whole
// frame.
//
// Pipeline position: AFTER TAA (blurs the resolved color) but BEFORE
// tonemap, in the linear/HDR domain — consistent with the depth texture
// (which the main scene wrote with the same current VP) so the unproject
// is self-consistent.
//
// RTE note: world-space reconstruction is deliberately avoided. At 6.37M m
// radius FP32 has ~0.76 m ULP, which would jitter the velocity by multiple
// pixels during orbital motion. All intermediate values here stay within
// view magnitudes (<= km), so FP32 holds full precision.

struct MotionBlurParams {
  texelSize: vec2<f32>,             // 1.0 / screenSize
  intensity: f32,                   // blur strength multiplier (0 => passthrough)
  sampleCount: f32,                 // number of taps along the velocity vector
  velocityValid: u32,              // 0 on the first frame (no valid previous VP)
  maxBlurPx: f32,                  // clamp on velocity length, in texels
  _pad0: vec2<f32>,
  currentVpRte: mat4x4<f32>,        // proj x viewRTE for the current frame
  previousVpRte: mat4x4<f32>,       // proj x viewRTE for the previous frame
  inverseCurrentVpRte: mat4x4<f32>, // CPU-precomputed inverse of currentVpRte
  cameraDelta: vec3<f32>,           // currentCameraWC - previousCameraWC (FP64 on CPU)
  _pad1: f32,
}

@group(0) @binding(0) var sceneColor: texture_2d<f32>;
@group(0) @binding(1) var depthTex: texture_depth_2d;
@group(0) @binding(2) var linearSampler: sampler;
@group(0) @binding(3) var<uniform> params: MotionBlurParams;
// Per-pixel model velocity (the MRT buffer TAA also reads). Bound to a
// 1x1 zero placeholder when no velocity-aware geometry populated it; the
// sample reads (0,0) and the camera-reprojection path takes over.
@group(0) @binding(4) var velocityTex: texture_2d<f32>;
// Dedicated NEAREST sampler for the depth binding. WebGPU forbids pairing
// a TextureSampleType::Depth binding with a Filtering sampler; nearest is
// also the correct depth policy (bilinear across depth edges fabricates
// depths belonging to neither surface). Same rule as TAA.wgsl binding 7.
@group(0) @binding(5) var depthSampler: sampler;

// Sample the model velocity texture. rg16float stores the NDC delta
// (current - previous). Returns the equivalent UV delta, or vec2(0) when
// the sample is the zero placeholder (no per-pixel velocity here).
fn sampleModelVelocityUV(uv: vec2<f32>) -> vec2<f32> {
  let m = textureSampleLevel(velocityTex, linearSampler, uv, 0.0).rg;
  if (abs(m.x) < 1.0e-5 && abs(m.y) < 1.0e-5) {
    return vec2<f32>(0.0);
  }
  // NDC delta -> UV delta. NDC.y down-flips on the way to UV.
  return m * vec2<f32>(0.5, -0.5);
}

// Camera-motion velocity via depth reprojection. Mirrors TAA.wgsl's
// reprojectUV: returns the current-pixel screen-space velocity
// `currentUV - previousUV`. Returns vec2(0) when reprojection is invalid
// (no previous VP, behind previous camera, or offscreen last frame).
fn cameraVelocityUV(uv: vec2<f32>) -> vec2<f32> {
  if (params.velocityValid == 0u) {
    return vec2<f32>(0.0);
  }

  // texture_depth_2d's textureSampleLevel overload takes an INTEGER mip
  // level; the non-filtering depthSampler is required (see binding 5).
  let rawDepth = textureSampleLevel(depthTex, depthSampler, uv, 0u);

  // Clamp just inside the far plane so the sky unprojects finitely
  // (inverse(proj) at z=1 gives w~0 -> Inf/NaN). Sky = rotation-dominated;
  // the translation term is negligible at far-plane distance.
  let depth = min(rawDepth, 0.9999);
  let isSky = rawDepth >= 1.0;

  // Current-frame NDC. WebGPU NDC: xy in [-1,1], z in [0,1]. Y-flip to
  // match the framebuffer-top convention (same as TAA / CSM sampling).
  let ndcCurr = vec3<f32>(uv * 2.0 - 1.0, depth);
  let ndcCurrWebGPU = vec3<f32>(ndcCurr.x, -ndcCurr.y, ndcCurr.z);

  // Unproject: current NDC -> current-frame eye-relative position.
  let clipCurr = params.inverseCurrentVpRte * vec4<f32>(ndcCurrWebGPU, 1.0);
  let eyePosCurr = clipCurr.xyz / clipCurr.w;

  // Translate current-camera-relative -> previous-camera-relative:
  //   eyePosPrev = eyePosCurr + (currentCameraWC - previousCameraWC).
  // Sky pixels: eyePosCurr magnitude (~far plane) swamps cameraDelta in
  // FP32, so zero the delta (translation at infinity is mathematically 0).
  let delta = select(params.cameraDelta, vec3<f32>(0.0), isSky);
  let eyePosPrev = eyePosCurr + delta;

  let clipPrev = params.previousVpRte * vec4<f32>(eyePosPrev, 1.0);
  if (clipPrev.w <= 0.0) {
    return vec2<f32>(0.0);
  }
  let ndcPrevWebGPU = clipPrev.xyz / clipPrev.w;
  let ndcPrev = vec3<f32>(ndcPrevWebGPU.x, -ndcPrevWebGPU.y, ndcPrevWebGPU.z);
  let prevUV = ndcPrev.xy * 0.5 + 0.5;

  // Offscreen last frame -> no meaningful velocity.
  if (prevUV.x < 0.0 || prevUV.x > 1.0 || prevUV.y < 0.0 || prevUV.y > 1.0) {
    return vec2<f32>(0.0);
  }

  // Velocity = how far this pixel moved on screen since last frame.
  return uv - prevUV;
}

@fragment
fn fragmentMain(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
  let texSize = params.texelSize;
  let uv = fragCoord.xy * texSize;

  let center = textureSampleLevel(sceneColor, linearSampler, uv, 0.0);

  // Passthrough when disabled/inert — byte-identical to no effect.
  if (params.intensity <= 0.0) {
    return center;
  }

  // Prefer per-pixel model velocity (captures object motion); fall back to
  // camera reprojection for the rest of the scene.
  var vel = sampleModelVelocityUV(uv);
  if (abs(vel.x) < 1.0e-6 && abs(vel.y) < 1.0e-6) {
    vel = cameraVelocityUV(uv);
  }

  vel = vel * params.intensity;

  // Clamp the smear length to maxBlurPx texels so a teleport / disocclusion
  // can't streak across the whole frame.
  let maxLenUV = params.maxBlurPx * length(texSize);
  let velLen = length(vel);
  if (velLen > maxLenUV && velLen > 0.0) {
    vel = vel * (maxLenUV / velLen);
  }

  // Below ~half a texel of motion there's nothing to blur — return crisp.
  if (length(vel) < 0.5 * length(texSize)) {
    return center;
  }

  // Gather along the velocity vector, centered on the pixel. The taps
  // straddle [-0.5, +0.5] of the swept path.
  let n = max(2, i32(params.sampleCount));
  var accum = center.rgb;
  var wsum = 1.0;
  for (var i = 1; i < n; i = i + 1) {
    let t = (f32(i) / f32(n - 1)) - 0.5; // -0.5 .. +0.5
    let sampleUV = uv - vel * t;
    // Weight the center more than the tails for a smoother falloff.
    let w = 1.0 - abs(t) * 0.5;
    accum = accum + textureSampleLevel(sceneColor, linearSampler, sampleUV, 0.0).rgb * w;
    wsum = wsum + w;
  }

  return vec4<f32>(accum / wsum, center.a);
}

// Fullscreen-triangle vertex shader (shared convention with the other
// post-process effects).
@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4<f32> {
  let x = f32(i32(vertexIndex) / 2) * 4.0 - 1.0;
  let y = f32(i32(vertexIndex) % 2) * 4.0 - 1.0;
  return vec4<f32>(x, y, 0.0, 1.0);
}
