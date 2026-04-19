// TAA.wgsl — Temporal Anti-Aliasing resolve pass
//
// Blends the current jittered frame with the previous frame's history
// buffer using depth-based motion-vector reprojection + neighborhood
// clamping.
//
// Pipeline order: after ColorGrading, before optional FXAA.
// Input: current frame color (jittered), history buffer, depth.
// Output: resolved anti-aliased color written to the current history slot.
//
// Motion-vector math (RTE-safe at Earth scale):
//   1. Sample depth at current pixel → build NDC.
//   2. Unproject via inverse(currentVpRte) → camera-relative eye-space
//      position for the CURRENT frame. Stays sub-km magnitude so FP32
//      holds full precision (no 1m planetary quantization).
//   3. Translate to previous frame's eye-space: add `cameraDelta`
//      (currentCameraWC - previousCameraWC, FP64 on CPU).
//   4. Reproject via previousVpRte → previous NDC → previous UV.
//   5. motion = currentUV - previousUV.
//
// World-space reconstruction is deliberately avoided — at 6.37M m radius
// FP32 has ~0.76m ULP, which would jitter motion vectors by multiple
// pixels during orbital fly-to.

struct TAAParams {
  texelSize: vec2<f32>,            // 1.0 / screenSize
  blendWeight: f32,                // exponential blend (default 0.1 = 10% current)
  frameIndex: u32,                 // for debug / Halton cycle
  jitterOffset: vec2<f32>,         // current frame's jitter in UV space
  historyValid: u32,               // 0 on first frame (no valid previous snapshot)
  _pad0: u32,
  currentVpRte: mat4x4<f32>,       // proj × viewRTE for the current frame
  previousVpRte: mat4x4<f32>,      // proj × viewRTE for the previous frame
  inverseCurrentVpRte: mat4x4<f32>, // CPU-precomputed inverse of currentVpRte
  cameraDelta: vec3<f32>,          // currentCameraWC - previousCameraWC (FP64 on CPU)
  _pad1: f32,
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

// ── RTE depth reprojection ─────────────────────────────────────────────
//
// Given a current-frame UV + depth, reproject into the previous frame's
// UV via eye-relative space. The key RTE property: we never reconstruct
// world-space position. At Earth scale that reconstruction quantizes to
// ~1m and produces motion vectors that drift by multiple pixels during
// orbital fly-to. Here all intermediate values stay within cascade/view
// magnitudes (≤ km), so FP32 is exact.
//
// Returns previousUV. Falls back to `uv` (motion = 0) when reprojection
// fails: history invalid, point behind previous camera, or NDC out of
// [-1,1] which indicates the pixel wasn't visible last frame (disocclusion).
fn reprojectUV(uv: vec2<f32>) -> vec2<f32> {
  if (params.historyValid == 0u) {
    return uv;
  }

  // Fetch depth at the pixel center. We sample from the depth texture
  // that the main scene wrote with the JITTERED projection — the inverse
  // matrix matches, so the unproject is self-consistent.
  let rawDepth = textureSampleLevel(depthTex, linearSampler, uv, 0.0);

  // Slice 2 — sky reprojection (rotation-dominated).
  //
  // Before: `depth >= 1.0 → return uv` gave the skybox zero motion, so
  // rotating the camera produced a smeared copy of the stars against
  // the new frame's sky. The fix is to unproject the sky pixel at a
  // point *just* inside the far plane, reproject through
  // `previousVpRte`, and let the translation term (cameraDelta) stay
  // in the math. Sky points behave like points at very large finite
  // distance — adding a camera translation perturbs their NDC by
  // O(|cameraDelta| / farPlane), which is sub-pixel for any sane
  // camera motion and is therefore negligible. The dominant term is
  // camera rotation, which is exactly what the full VP reprojection
  // already captures.
  //
  // We CANNOT unproject at depth=1.0 directly: WebGPU NDC has z=1 at
  // the far plane and `inverse(proj) · (x, y, 1, 1)` gives a clip
  // point with w near zero, and dividing through produces Inf/NaN.
  // Clamping to 0.9999 keeps the math finite. The error this
  // introduces vs. true infinity is bounded by `(1 - 0.9999) * far`,
  // which at Cesium's far-plane (~10^8 m) is ~10^4 m — sub-pixel in
  // screen space.
  let depth = min(rawDepth, 0.9999);
  let isSky = rawDepth >= 1.0;

  // Build current-frame NDC. WebGPU NDC: xy in [-1,1], z in [0,1].
  let ndcCurr = vec3<f32>(uv * 2.0 - 1.0, depth);
  // Y-flip: WebGPU's framebuffer Y=0 is the top, so UV.y increasing
  // downward maps to NDC.y decreasing. Matches the CSM sampling convention.
  let ndcCurrWebGPU = vec3<f32>(ndcCurr.x, -ndcCurr.y, ndcCurr.z);

  // Unproject: current NDC → current-frame eye-relative position.
  let clipCurr = params.inverseCurrentVpRte * vec4<f32>(ndcCurrWebGPU, 1.0);
  let eyePosCurr = clipCurr.xyz / clipCurr.w;

  // Translate from current-camera-relative to previous-camera-relative.
  // cameraDelta = currentCameraWC - previousCameraWC, so:
  //   worldPos = eyePosCurr + currentCameraWC
  //            = (eyePosCurr + cameraDelta) + previousCameraWC
  //   eyePosPrev = worldPos - previousCameraWC = eyePosCurr + cameraDelta
  //
  // Sky exception: the `eyePosCurr` magnitude grows with far-plane
  // (10^7–10^8 m) while cameraDelta is bounded by per-frame camera
  // motion (≤ 10^4 m for sane paths). Adding the two in FP32 loses
  // the delta to catastrophic cancellation. For sky pixels we
  // explicitly zero the delta — the translation contribution at
  // infinity IS zero mathematically, and suppressing it keeps the
  // reprojection numerically stable.
  let delta = select(params.cameraDelta, vec3<f32>(0.0), isSky);
  let eyePosPrev = eyePosCurr + delta;

  // Reproject into previous-frame clip space.
  let clipPrev = params.previousVpRte * vec4<f32>(eyePosPrev, 1.0);
  if (clipPrev.w <= 0.0) {
    // Behind the previous camera — no valid history.
    return uv;
  }
  let ndcPrevWebGPU = clipPrev.xyz / clipPrev.w;
  // Flip Y back for UV, matching the forward transform.
  let ndcPrev = vec3<f32>(ndcPrevWebGPU.x, -ndcPrevWebGPU.y, ndcPrevWebGPU.z);
  let prevUV = ndcPrev.xy * 0.5 + 0.5;

  // Disocclusion / offscreen guard: if the pixel wasn't visible last
  // frame, the history sample would be garbage. Fall back to zero motion
  // so the neighborhood clamp can catch the mismatch.
  if (prevUV.x < 0.0 || prevUV.x > 1.0 || prevUV.y < 0.0 || prevUV.y > 1.0) {
    return uv;
  }

  return prevUV;
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

  // Depth-based reprojection via RTE math. Falls back to identity UV on
  // invalid/disoccluded/sky pixels.
  let historyUV = reprojectUV(unjitteredUV);

  // Sample history buffer at the reprojected UV.
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
