// Cloud Temporal Reprojection + Accumulation — WebGPU (V10, Batch 433)
//
// Third pass of the cloud reconstruction stack, sitting BETWEEN the half-res
// raymarch (CLOUD-HALFRES, Batch 432) and the bilateral upscale (CloudUpscale).
// Temporal upsampling (Schneider/Bauer; "The Real-Time Volumetric Cloudscapes of
// Horizon Zero Dawn", SIGGRAPH 2015) amortises the expensive 96-step march across
// frames: each frame the half-res target holds the FRESHLY-MARCHED cloud (jittered
// per-frame by the Bayer/frameCounter index from Batch 432), and this pass blends
// it with the REPROJECTED accumulated history of the previous frame, so the
// effective sample budget is N× the per-frame march at ~1/N the cost.
//
//   currentHalfTex  = this frame's freshly-marched premultiplied cloud RGBA (half-res)
//   historyTex      = last frame's ACCUMULATED premultiplied cloud RGBA (half-res)
//   → writes the new accumulated history (which the upscale pass then reads).
//
// Reprojection: the history was rendered from the PREVIOUS camera. For each output
// texel we reconstruct a world-space anchor on the cloud SHELL MID-SPHERE along the
// current view ray (a stable per-pixel proxy for where the cloud sits — the exact
// volumetric depth varies, but the neighborhood clamp below absorbs the residual),
// project it with `cloud.previousViewProjection` to last frame's clip→UV, and sample
// the history there.
//
// NEIGHBORHOOD CLAMP (MANDATORY — the #1 failure mode): a naive history blend smears
// comet-tails behind moving cloud edges (stale history bleeding into newly-revealed
// pixels). We clamp the reprojected history to the min/max AABB of the 3×3 current
// freshly-marched neighborhood (Karis, "High Quality Temporal Supersampling", SIGGRAPH
// 2014). Reprojected history outside that box is rejected (clamped onto it), so a
// trailing edge can't keep showing last frame's cloud — it snaps to the current
// neighborhood, killing ghosting at the cost of a little extra per-frame noise (which
// the accumulation re-converges within a few frames once the camera settles).
//
// FIRST FRAME / DISOCCLUSION: when the reprojected UV falls outside [0,1] (off-screen
// last frame — a disocclusion) we fall back to the current freshly-marched sample with
// NO history (identity), so newly-revealed regions show the live march immediately, not
// a hole. The JS side seeds the very first history frame with the freshly-marched result
// (TAA/CSM first-frame convention) so there is no startup flash.

struct TemporalUniforms {
  // Previous-frame world→clip matrix (UniformState.previousViewProjection, packed
  // column-major to match WGSL mat4x4 column-vector construction). Reprojects the
  // current world anchor to last frame's clip space.
  previousViewProjection: mat4x4<f32>,
  // Inverse projection + inverse view of the CURRENT frame (same as the cloud
  // shader) so we can reconstruct the current view ray per output texel.
  inverseProjection: mat4x4<f32>,
  inverseView: mat4x4<f32>,
  // Current camera world position (xyz) + the per-frame history blend weight (w):
  // the fraction of the NEW (freshly-marched) sample folded in each frame ==
  // temporalUpdateFraction (1/8..1/16). History keeps (1 - w).
  cameraPositionAndBlend: vec4<f32>,
  // Cloud shell radii (planetRadius + layerBottom/Top) for the mid-sphere anchor,
  // + the half-res target size (zw) for the 3×3 neighborhood texel step.
  shellRadiiAndRes: vec4<f32>,
  // x = 1 on the FIRST temporal frame (history is invalid → emit current only),
  // y/z/w reserved.
  firstFrameFlags: vec4<f32>,
};

@group(0) @binding(0) var currentHalfTex: texture_2d<f32>; // this frame, freshly marched (premult)
@group(0) @binding(1) var historyTex: texture_2d<f32>;     // last frame, accumulated (premult)
@group(0) @binding(2) var linearSampler: sampler;          // clamp, linear
@group(0) @binding(3) var<uniform> u: TemporalUniforms;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

// Full-screen oversized triangle (matches ProceduralClouds.wgsl / CloudUpscale.wgsl
// so the v-flipped UV convention is identical across the stack).
@vertex
fn vertexMain(@builtin(vertex_index) vid: u32) -> VertexOutput {
  var out: VertexOutput;
  let x = f32((vid << 1u) & 2u) * 2.0 - 1.0;
  let y = f32(vid & 2u) * 2.0 - 1.0;
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>(x * 0.5 + 0.5, 1.0 - (y * 0.5 + 0.5));
  return out;
}

// Reconstruct the current-frame world-space view ray (matches
// ProceduralClouds.wgsl::getWorldRay so the anchor uses the same convention).
fn worldRay(uv: vec2<f32>) -> vec3<f32> {
  let ndc = vec4<f32>(uv * 2.0 - 1.0, 1.0, 1.0);
  var viewDir = u.inverseProjection * ndc;
  viewDir.w = 0.0;
  let worldDir = u.inverseView * viewDir;
  return normalize(worldDir.xyz);
}

// Stable ray/sphere near-hit (sphere centred at the planet origin). Same precise
// closest-approach form as the cloud shader's raySphereIntersect. Returns the
// nearest non-negative root, or -1 if the ray misses / the shell is behind us.
fn shellHitDistance(ro: vec3<f32>, rd: vec3<f32>, radius: f32) -> f32 {
  let tClosest = -dot(ro, rd);
  let cp = ro + rd * tClosest;
  let halfChordSq = radius * radius - dot(cp, cp);
  if (halfChordSq < 0.0) {
    return -1.0;
  }
  let halfChord = sqrt(halfChordSq);
  let tNear = tClosest - halfChord;
  let tFar = tClosest + halfChord;
  if (tNear > 0.0) { return tNear; }
  if (tFar > 0.0) { return tFar; }
  return -1.0;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let uv = input.uv;

  // Current freshly-marched sample at this texel (premultiplied cloud RGBA).
  let current = textureSampleLevel(currentHalfTex, linearSampler, uv, 0.0);

  // FIRST FRAME — history is invalid; write the current sample as the identity
  // history (no startup flash). The JS side also seeds this, but guard here too.
  if (u.firstFrameFlags.x > 0.5) {
    return current;
  }

  // ── 3×3 neighborhood AABB of the CURRENT (freshly-marched) frame ──
  // The reprojected history will be clamped into this box to reject ghosting.
  let res = max(u.shellRadiiAndRes.zw, vec2<f32>(1.0, 1.0));
  let texel = vec2<f32>(1.0, 1.0) / res;
  var nMin = current;
  var nMax = current;
  for (var dy: i32 = -1; dy <= 1; dy = dy + 1) {
    for (var dx: i32 = -1; dx <= 1; dx = dx + 1) {
      if (dx == 0 && dy == 0) { continue; }
      let o = vec2<f32>(f32(dx), f32(dy)) * texel;
      let s = textureSampleLevel(currentHalfTex, linearSampler, uv + o, 0.0);
      nMin = min(nMin, s);
      nMax = max(nMax, s);
    }
  }

  // ── Reproject this pixel's world anchor into last frame ──
  // Anchor = ray ∩ cloud-shell MID-sphere (between inner and outer radius). A
  // single representative depth per pixel; the clamp absorbs the volumetric slack.
  let camPos = u.cameraPositionAndBlend.xyz;
  let rd = worldRay(uv);
  let midRadius = 0.5 * (u.shellRadiiAndRes.x + u.shellRadiiAndRes.y);
  let tHit = shellHitDistance(camPos, rd, midRadius);

  // If the ray misses the shell there is no meaningful reprojection anchor (the
  // pixel is sky/space) — keep the current sample (it will be vec4(0) there anyway).
  if (tHit < 0.0) {
    return current;
  }

  let worldAnchor = camPos + rd * tHit;
  let prevClip = u.previousViewProjection * vec4<f32>(worldAnchor, 1.0);
  // Behind the previous camera (w <= 0) → no valid reprojection; use current only.
  if (prevClip.w <= 0.0) {
    return current;
  }
  let prevNdc = prevClip.xy / prevClip.w;
  // NDC → UV with the SAME v-flip as the forward path (uv.y = 1 - (ndc.y*0.5+0.5)).
  var prevUV = vec2<f32>(prevNdc.x * 0.5 + 0.5, 1.0 - (prevNdc.y * 0.5 + 0.5));

  // DISOCCLUSION — reprojected off-screen last frame → no history to blend; the
  // current freshly-marched sample shows immediately (no trailing hole).
  if (prevUV.x < 0.0 || prevUV.x > 1.0 || prevUV.y < 0.0 || prevUV.y > 1.0) {
    return current;
  }

  // Sample + NEIGHBORHOOD-CLAMP the reprojected history into the current 3×3 AABB.
  // This is what rejects ghost trails: stale history that disagrees with the
  // current neighborhood (a freshly-revealed or freshly-occluded edge) is snapped
  // onto the box, so it cannot smear last frame's cloud across the new frame.
  let historyRaw = textureSampleLevel(historyTex, linearSampler, prevUV, 0.0);
  let history = clamp(historyRaw, nMin, nMax);

  // Exponential accumulation: blend the clamped history with the new sample by the
  // per-frame fraction (history keeps 1-w). Holding the camera still, repeated
  // jittered marches converge to a clean image; under motion the clamp keeps it crisp.
  let blend = clamp(u.cameraPositionAndBlend.w, 0.0, 1.0);
  let result = mix(history, current, blend);
  return result;
}
