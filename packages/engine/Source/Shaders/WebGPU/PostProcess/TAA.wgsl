// TAA.wgsl — Temporal Anti-Aliasing resolve pass
//
// Blends the current jittered frame with the previous frame's history
// buffer using depth-based motion-vector reprojection + neighborhood
// clamping.
//
// Pipeline order: BEFORE Tonemap (linear/HDR domain), before optional
// FXAA. NEW-TAA-PIPELINE-ORDER-RECONCILE (Batch 290) confirmed this is
// the correct placement: the resolve below operates in `tonemapWeight`
// space (c/(1+luma)), whose inverse c/(1-luma) is only well-defined for
// linear/HDR input — already-tonemapped SDR highlights (luma→1) would
// divide by ~0 and produce Inf/NaN. So this stage MUST stay upstream of
// the display tonemapper. See WebGPUPostProcessPipeline.ts pipeline-order
// header for the full decision record. Do not move post-tonemap.
// Input: current frame color (jittered, linear/HDR), history buffer, depth.
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
// TAA Slice 2d (Batch 104) — per-pixel motion-vector texture written by
// the model FS @location(1). Bound to a 1×1 zero placeholder when the
// model velocity pass is inactive; the FS branch in `reprojectUV` reads
// the sample and falls back to depth-reprojection when it's zero
// (placeholder content) or when |motion| is below a threshold.
//
// rg16float layout: (R, G) = NDC delta (current - previous), in [-1, 1]
// per axis. The model FS computes this via
// `computeMotionVectorScreenSpace` and writes it raw; the TAA shader
// converts to UV delta via `(curNdc - prevNdc) * vec2(0.5, -0.5)` in
// `sampleMotionTexture` below.
@group(0) @binding(5) var motionTex: texture_2d<f32>;
// Slice 5c-B Batch 126 — G-buffer normal-roughness (slot 1 of the
// MRT pipeline, Batches 117-121). When the host passes a real
// G-buffer view, the disocclusion check below adds a 3rd rejection
// criterion: if the eye-space normal at `prevUV` diverges from the
// normal at `uv` by more than `normalRejectThreshold`, treat the
// history as disoccluded. Catches silhouette pixels where the
// reprojected screen position points at a different surface (e.g. a
// foreground object moved off a background; the AABB + depth checks
// can miss this when the depth gap is small but the surface
// orientation differs). When the host binds the 1×1 sentinel
// placeholder, the check skips and the prior depth+motion gates run
// unchanged.
@group(0) @binding(6) var gBufferNormalTex: texture_2d<f32>;
// Batch 244 (NEW-TAA-EFFECT-NEVER-ADDED first activation) — dedicated
// NEAREST sampler for the depth texture. WebGPU forbids pairing a
// TextureSampleType::Depth binding with a Filtering sampler (the
// TAA_Pipeline failed creation silently for the shader's whole dormant
// life). Nearest is also the CORRECT depth policy: bilinear blends
// across depth edges fabricate depths belonging to neither surface.
// Same NEW-4-B (Batch 66) rule as WebGPUGlobeDepth / DebugDepthOverlay.
@group(0) @binding(7) var depthSampler: sampler;

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

// ── Per-pixel motion-vector lookup (TAA Slice 2d / Batch 104) ──────────
//
// Sample `motionTex` at `uv` and convert the stored NDC delta into a UV
// delta. The motion texture is rg16float; (R, G) carries the per-pixel
// (currentClipPos - previousClipPos).xy / w computed by the model FS.
// The placeholder content for non-velocity-aware geometry is (0, 0),
// which we treat as "no motion sample available" and fall back to depth
// reprojection. A small magnitude threshold (~1e-5 NDC ≈ 1/65535 of the
// texture range) absorbs precision noise.
//
// Returns vec2(0) when no usable sample is present so the caller can
// detect the fallback case.
fn sampleMotionTexture(uv: vec2<f32>) -> vec2<f32> {
  let m = textureSampleLevel(motionTex, linearSampler, uv, 0.0).rg;
  if (abs(m.x) < 1.0e-5 && abs(m.y) < 1.0e-5) {
    return vec2<f32>(0.0);
  }
  // NDC delta → UV delta. NDC.y down-flips on the way to UV.
  return m * vec2<f32>(0.5, -0.5);
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
//
// TAA Slice 2d (Batch 104) — when the per-pixel motion-vector texture
// has a non-zero sample for this pixel, prefer it over the depth-
// reprojection path. Per-pixel velocity correctly handles skinned /
// morphed / instanced / animated geometry that depth-reprojection
// treats as static (the depth path only reverses CAMERA motion, not
// per-vertex transform deltas).
fn reprojectUV(uv: vec2<f32>) -> vec2<f32> {
  if (params.historyValid == 0u) {
    return uv;
  }

  // Per-pixel motion texture wins when present.
  let motionSample = sampleMotionTexture(uv);
  if (abs(motionSample.x) > 0.0 || abs(motionSample.y) > 0.0) {
    let prevUV = uv - motionSample;
    if (prevUV.x >= 0.0 && prevUV.x <= 1.0 &&
        prevUV.y >= 0.0 && prevUV.y <= 1.0) {
      return prevUV;
    }
    // Out-of-bounds motion → disocclusion; fall through to the depth-
    // reprojection path's own out-of-bounds guard.
  }

  // Fetch depth at the pixel center. We sample from the depth texture
  // that the main scene wrote with the JITTERED projection — the inverse
  // matrix matches, so the unproject is self-consistent.
  // Batch 244 — texture_depth_2d's textureSampleLevel overload takes an
  // INTEGER mip level (u32/i32), unlike texture_2d<f32>'s f32 level.
  // `0.0` here was a compile error that stayed hidden for the shader's
  // whole life because the TAA effect was never instantiated until
  // NEW-TAA-EFFECT-NEVER-ADDED landed. Depth also uses the dedicated
  // non-filtering `depthSampler` (see binding 7).
  let rawDepth = textureSampleLevel(depthTex, depthSampler, uv, 0u);

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

  // Slice 2b — strengthened disocclusion detection. The neighborhood
  // clamp already suppresses MOST ghosting, but it operates in
  // tonemap-color space and can pass occluded fragments whose history
  // colors happen to fall inside the current-frame neighborhood AABB.
  // Two extra checks catch the cases the clamp misses:
  //
  //   (1) Motion magnitude. If the motion vector exceeds a fraction
  //       of the screen, reprojection is treating the pixel as
  //       "barely visible last frame" and the history sample is
  //       almost certainly stale. Threshold matches the Halton
  //       jitter range — anything larger than ~10% of the screen is
  //       indistinguishable from a teleport at the per-pixel level.
  //
  //   (2) Depth-based occlusion test. Sample the depth at prevUV and
  //       reproject that sample back into eye-space. If the
  //       reprojected previous-depth differs from eyePosCurr by more
  //       than `disocclusionThreshold` (in eye-space units), a
  //       different surface occupied that screen pixel last frame
  //       and the history color is wrong. Skipped for sky pixels
  //       since their reprojection is approximate.
  let motion = prevUV - uv;
  let motionLen = length(motion);
  if (motionLen > 0.1) {
    return uv;
  }

  if (!isSky) {
    // Batch 244 — integer mip level + non-filtering depth sampler for
    // texture_depth_2d (see rawDepth).
    let prevDepthRaw = textureSampleLevel(depthTex, depthSampler, prevUV, 0u);
    if (prevDepthRaw < 0.99999) {
      // Only check non-sky neighbors. Sky pixels can be near 1.0 even
      // when the current pixel is non-sky (legitimate occlusion of
      // sky behind near geometry), and the AABB clamp handles those.
      let prevNdc = vec3<f32>(prevUV * 2.0 - 1.0, prevDepthRaw);
      let prevNdcWebGPU = vec3<f32>(prevNdc.x, -prevNdc.y, prevNdc.z);
      let prevClipFromDepth = params.inverseCurrentVpRte * vec4<f32>(prevNdcWebGPU, 1.0);
      let prevEyePosFromDepth = prevClipFromDepth.xyz / prevClipFromDepth.w;
      // Eye-space distance between the geometry that was at prevUV
      // last frame and where we expected it to be (eyePosPrev). When
      // they disagree by more than 0.1% of the eye-space depth, we
      // saw a different surface — disocclude.
      let expectedEyePos = eyePosPrev;
      let depthDelta = abs(length(prevEyePosFromDepth) - length(expectedEyePos));
      let disocclusionThreshold = abs(eyePosCurr.z) * 0.001;
      if (depthDelta > max(disocclusionThreshold, 1.0)) {
        return uv;
      }

      // Slice 5c-B Batch 126 — G-buffer normal divergence check.
      // Final disocclusion gate: compare the eye-space normal at the
      // current pixel against the normal at prevUV. If they diverge
      // by more than ~30° (1 - dot > 0.13), the reprojected sample
      // came from a different surface orientation — disocclude. This
      // catches silhouette pixels where the depth gap is small but
      // the surface tilt differs (e.g. wall-to-floor corners).
      //
      // Sentinel-aware: skip when either normal is the
      // load-op-clear sentinel (length < 0.1) emitted by Phase 1
      // non-emitting pipelines (sky / billboards / labels / lines).
      // The motion + depth gates handle those pixels.
      let nCenter = textureSampleLevel(
        gBufferNormalTex, linearSampler, uv, 0.0,
      ).xyz;
      let nPrev = textureSampleLevel(
        gBufferNormalTex, linearSampler, prevUV, 0.0,
      ).xyz;
      if (length(nCenter) >= 0.1 && length(nPrev) >= 0.1) {
        let div = 1.0 - dot(normalize(nCenter), normalize(nPrev));
        // Threshold ~0.13 corresponds to ~30°. Empirically catches
        // silhouettes without false-positiving on smooth shading
        // gradients (e.g. terrain slopes where normals change
        // continuously but the surface IS continuous).
        if (div > 0.13) {
          return uv;
        }
      }
    }
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
