// Cloud Reconstruction Attachments — WebGPU (C13-09)
//
// Writes the reconstruction attachment set the temporal chain will read:
// front / transmittance-weighted cloud depth, screen-space motion with its
// validity, and the moment pair a variance clip needs. NOTHING READS THESE
// YET — C13-10 owns the true 1/16-rate current-frame march and C13-12 owns the
// consumers (motion/depth rejection, variance clipping, reactive history,
// wind-aware reprojection, disocclusion).
//
// ★ WHY THIS IS A SEPARATE MODULE. C13-39's negative result established that
//   WGSL register allocation is STATIC: code added to `ProceduralClouds.wgsl`
//   inflates the register footprint of EVERY pipeline compiled from it — the
//   visible march, the shadow map, the cascade atlas, the god-ray mask. None of
//   those want a reconstruction attachment. So this producer is its own module
//   with its own pipeline, and it RE-DERIVES the WGS84 shell intersection
//   rather than importing the march's. The duplication is deliberate and is the
//   cheaper side of the trade.
//
// ★ THE DEPTH HAS TWO PRODUCERS, SELECTED AT COMPILE TIME.
//
//   DEFAULT (`//>>else`, C13-09) — an ESTIMATOR. The march resolved this
//   pixel's alpha; this pass recovers the depth that alpha implies over the
//   geometric shell interval under uniform extinction, which is strictly more
//   than C13-05's midpoint proxy and strictly less than per-sample
//   accumulation. Its CPU twin lives in
//   `WebGPUCloudReconstructionAttachments.ts`
//   (`cloudTransmittanceWeightedDepth`) and is pinned against this expression.
//
//   `CLOUD_MARCH_EMIT_RECONSTRUCTION` (C13-10) — an ACCUMULATION. The march
//   itself sums `Σ wᵢ·tᵢ` over the SAME transmittance weights its radiance
//   uses and writes contract slot 1 directly, so this pass reads the depth at
//   binding 2 instead of estimating it, and its own MRT drops the depth slot
//   (a pass cannot sample what it writes). The estimator stays as the `//>>else`
//   and as the CPU twin — it is still the only depth available to a build that
//   does not compile the emitting march, and it is the reference the emission
//   is checked against. Its CPU twin `cloudMarchWeightedDepth` is pinned
//   against the emitting expression the same way.
//
//   The variant costs the MARCH two FMAs and a compare per contributing sample
//   and SAVES this pass a per-pixel ellipsoid-shell intersection plus nine
//   estimator evaluations. Any occupancy claim about that trade is owed the
//   interleaved-A/B protocol and is not asserted here.
//
// RTE contract, inherited unchanged from C13-04/05: no full-ECEF vec3<f32> is
// ever formed. The planet centre arrives as an encoded high/low split relative
// to the camera, the high part cancels before the low refinement, and the
// previous-frame projection is relative to eye with a CPU-f64 camera delta.

const WGS84_EQUATORIAL_RADIUS: f32 = 6378137.0;
const WGS84_POLAR_RADIUS: f32 = 6356752.314245179;

// Below this alpha both terms of the weighted-depth estimator diverge like
// span/alpha and their difference loses most of its significant digits; the
// interval midpoint is the exact limit there.
const MIN_RESOLVED_ALPHA: f32 = 1.0e-4;
// Transmittance floor. `log(0)` is an INDETERMINATE VALUE in WGSL and `1 - a`
// stops resolving in f32 within ~6e-8 of one, so the floor keeps the logarithm
// finite without a branch — and a branch is exactly what must be avoided here,
// because the estimator approaches the front face only logarithmically and a
// snap-to-t0 would put a tenth-of-a-deck discontinuity at full opacity.
const MIN_RESOLVED_TRANSMITTANCE: f32 = 1.0e-6;

struct AttachmentUniforms {
  // Previous-frame projection x rotation-only view.
  previousViewProjectionRelativeToEye: mat4x4<f32>,
  // Inverse of the current projection x rotation-only view.
  inverseCurrentViewProjectionRelativeToEye: mat4x4<f32>,

  // Current ECEF camera high split; w = metres the depth channels are
  // normalized by before they enter the moment pair.
  encodedCameraHighAndFarCap: vec4<f32>,
  // Low split; w = CPU-f64 WGS84 cartographic height.
  encodedCameraLowAndHeight: vec4<f32>,
  // currentCameraWC - previousCameraWC in CPU f64; w = target width.
  cameraDeltaAndWidth: vec4<f32>,
  // Configured primary deck bottom/top; z = target height; w = 1 when the
  // previous transform and camera delta are usable this frame.
  primaryDeckAndResolutionY: vec4<f32>,
  // Low bottom/top + middle bottom/top.
  deckBoundsLowMid: vec4<f32>,
  // High bottom/top; z = multi-deck enabled; w = attachment generation.
  deckBoundsHighAndFlags: vec4<f32>,
};

// The freshly marched half-resolution cloud target. Read with `textureLoad`:
// this pass runs at exactly the source resolution, so a filtered fetch would
// only blur the signal the moments are supposed to measure.
@group(0) @binding(0) var currentTex: texture_2d<f32>;
@group(0) @binding(1) var<uniform> u: AttachmentUniforms;
//>>ifdef CLOUD_MARCH_EMIT_RECONSTRUCTION
// C13-10 — the depth attachment the MARCH wrote this frame (contract slot 1,
// rg32float: front distance, transmittance-weighted mean distance, metres).
// In this variant the estimator below is not evaluated at all: the march
// accumulated the true per-sample weighted depth from the same weights its
// radiance used, and this pass reads it rather than re-deriving it from alpha.
// It is bound READ-ONLY and is NOT in this pass's attachment list — a pass
// cannot sample a target it also writes, which is exactly why ownership of the
// depth slot MOVES to the march instead of being duplicated here.
@group(0) @binding(2) var marchDepthTex: texture_2d<f32>;
//>>endif

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

//>>ifdef CLOUD_MARCH_EMIT_RECONSTRUCTION
// C13-10 — the emitting variant's MRT. `depth` is ABSENT because the march
// wrote contract slot 1 directly; this pass reads it at binding 2. The
// remaining two keep their contract order, so slot 2 -> @location(0) and
// slot 3 -> @location(1).
struct AttachmentOutput {
  // rgba16float — motion UV, validity, normalized previous anchor distance.
  @location(0) velocity: vec4<f32>,
  // rgba16float — mean and mean-square of normalized depth, then of coverage.
  @location(1) moments: vec4<f32>,
};
//>>else
// MRT order matches the owned attachments in
// `CLOUD_RECONSTRUCTION_ATTACHMENTS` (contract slots 1, 2, 3).
struct AttachmentOutput {
  // rg32float — front and transmittance-weighted distance, metres.
  @location(0) depth: vec2<f32>,
  // rgba16float — motion UV, validity, normalized previous anchor distance.
  @location(1) velocity: vec4<f32>,
  // rgba16float — mean and mean-square of normalized depth, then of coverage.
  @location(2) moments: vec4<f32>,
};
//>>endif

@vertex
fn vertexMain(@builtin(vertex_index) vid: u32) -> VertexOutput {
  var out: VertexOutput;
  let x = f32((vid << 1u) & 2u) * 2.0 - 1.0;
  let y = f32(vid & 2u) * 2.0 - 1.0;
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>(x * 0.5 + 0.5, 1.0 - (y * 0.5 + 0.5));
  return out;
}

// Current UV -> current-camera-relative world direction. WebGPU framebuffer UV
// grows downward, so Y is flipped back to NDC before unprojection. Depth 0.9999
// avoids the far-plane w~0 singularity.
fn currentRelativeRay(uv: vec2<f32>) -> vec3<f32> {
  let currentNdc = vec4<f32>(
    uv.x * 2.0 - 1.0,
    1.0 - uv.y * 2.0,
    0.9999,
    1.0
  );
  let currentRelative =
    u.inverseCurrentViewProjectionRelativeToEye * currentNdc;
  return normalize(currentRelative.xyz / currentRelative.w);
}

fn shellAxes(height: f32) -> vec3<f32> {
  return vec3<f32>(
    WGS84_EQUATORIAL_RADIUS + height,
    WGS84_EQUATORIAL_RADIUS + height,
    WGS84_POLAR_RADIUS + height
  );
}

// Camera-relative ray / expanded-WGS84 ellipsoid intersection. Scale the
// encoded centre parts independently, then cancel the high part before the low
// refinement, matching the primary march's RTE contract.
fn rayEllipsoidIntersectRTE(
  rd: vec3<f32>,
  centerHigh: vec3<f32>,
  centerLow: vec3<f32>,
  axes: vec3<f32>,
) -> vec2<f32> {
  let rdScaled = rd / axes;
  let centerHighScaled = centerHigh / axes;
  let centerLowScaled = centerLow / axes;
  let a = max(dot(rdScaled, rdScaled), 1e-20);
  let tClosest =
    (dot(rdScaled, centerHighScaled) + dot(rdScaled, centerLowScaled)) / a;
  let closest =
    (rdScaled * tClosest - centerHighScaled) - centerLowScaled;
  let halfChordSq = (1.0 - dot(closest, closest)) / a;
  if (halfChordSq < 0.0) {
    return vec2<f32>(-1.0);
  }
  let halfChord = sqrt(halfChordSq);
  return vec2<f32>(tClosest - halfChord, tClosest + halfChord);
}

// Nearest visible interval through one WGS84 shell, or (-1, -1) on a miss.
fn shellIntervalRTE(
  rd: vec3<f32>,
  deckBottom: f32,
  deckTop: f32,
) -> vec2<f32> {
  let centerHigh = -u.encodedCameraHighAndFarCap.xyz;
  let centerLow = -u.encodedCameraLowAndHeight.xyz;
  let innerHit = rayEllipsoidIntersectRTE(
    rd,
    centerHigh,
    centerLow,
    shellAxes(deckBottom)
  );
  let outerHit = rayEllipsoidIntersectRTE(
    rd,
    centerHigh,
    centerLow,
    shellAxes(deckTop)
  );
  if (outerHit.x < 0.0 && outerHit.y < 0.0) {
    return vec2<f32>(-1.0);
  }

  let cameraHeight = u.encodedCameraLowAndHeight.w;
  var tStart: f32;
  var tEnd: f32;
  if (cameraHeight < deckBottom) {
    tStart = max(innerHit.y, 0.0);
    tEnd = outerHit.y;
  } else if (cameraHeight > deckTop) {
    tStart = max(outerHit.x, 0.0);
    tEnd = outerHit.y;
    if (innerHit.x > tStart) {
      tEnd = min(tEnd, innerHit.x);
    }
  } else {
    tStart = 0.0;
    tEnd = outerHit.y;
    if (innerHit.x > 0.0) {
      tEnd = min(tEnd, innerHit.x);
    }
  }

  if (tEnd <= tStart) {
    return vec2<f32>(-1.0);
  }
  return vec2<f32>(tStart, tEnd);
}

// The interval the FRONT-MOST composited deck occupies. Multi-deck output is
// composited front-to-back, so the nearest hit shell is the one that owns the
// front depth; the weighted depth is then that interval under the composited
// alpha. This is exactly the case C13-09 exists for: one mean depth across
// separated overlapping volumes cannot be reconstructed from, so the front and
// the weighted mean are carried as SEPARATE channels rather than averaged.
fn nearestShellInterval(rd: vec3<f32>) -> vec2<f32> {
  if (u.deckBoundsHighAndFlags.z < 0.5) {
    return shellIntervalRTE(
      rd,
      u.primaryDeckAndResolutionY.x,
      u.primaryDeckAndResolutionY.y
    );
  }

  let low = shellIntervalRTE(rd, u.deckBoundsLowMid.x, u.deckBoundsLowMid.y);
  let middle = shellIntervalRTE(rd, u.deckBoundsLowMid.z, u.deckBoundsLowMid.w);
  let high = shellIntervalRTE(
    rd,
    u.deckBoundsHighAndFlags.x,
    u.deckBoundsHighAndFlags.y
  );

  var best = vec2<f32>(-1.0);
  var bestStart = 1e30;
  if (low.x >= 0.0 && low.x < bestStart) {
    bestStart = low.x;
    best = low;
  }
  if (middle.x >= 0.0 && middle.x < bestStart) {
    bestStart = middle.x;
    best = middle;
  }
  if (high.x >= 0.0 && high.x < bestStart) {
    best = high;
  }
  return best;
}

// Transmittance-weighted mean distance implied by `alpha` over `[t0, t1]`
// under uniform extinction. Mirrors `cloudTransmittanceWeightedDepth` in
// `WebGPUCloudReconstructionAttachments.ts` expression for expression; both
// limits are closed form rather than clamped, so alpha -> 0 gives the interval
// midpoint and alpha -> 1 gives the front face.
fn weightedDepthFromAlpha(t0: f32, t1: f32, alpha: f32) -> f32 {
  let span = t1 - t0;
  if (!(span > 0.0)) {
    return -1.0;
  }
  let a = clamp(alpha, 0.0, 1.0);
  if (a <= MIN_RESOLVED_ALPHA) {
    return t0 + 0.5 * span;
  }
  let oneMinusA = max(1.0 - a, MIN_RESOLVED_TRANSMITTANCE);
  let sigma = -log(oneMinusA) / span;
  return t0 + 1.0 / sigma - (span * oneMinusA) / a;
}

@fragment
fn fragmentMain(input: VertexOutput) -> AttachmentOutput {
  var out: AttachmentOutput;
//>>ifdef CLOUD_MARCH_EMIT_RECONSTRUCTION
//>>else
  out.depth = vec2<f32>(-1.0, -1.0);
//>>endif
  out.velocity = vec4<f32>(0.0);
  out.moments = vec4<f32>(0.0);

  let resolution = vec2<i32>(
    i32(max(u.cameraDeltaAndWidth.w, 1.0)),
    i32(max(u.primaryDeckAndResolutionY.z, 1.0))
  );
  let center = clamp(
    vec2<i32>(input.position.xy),
    vec2<i32>(0, 0),
    resolution - vec2<i32>(1, 1)
  );
//>>ifdef CLOUD_MARCH_EMIT_RECONSTRUCTION
//>>else
  let alpha = clamp(textureLoad(currentTex, center, 0).a, 0.0, 1.0);
//>>endif

  let rayDirection = currentRelativeRay(input.uv);
//>>ifdef CLOUD_MARCH_EMIT_RECONSTRUCTION
//>>else
  let interval = nearestShellInterval(rayDirection);
//>>endif
  let farCap = max(u.encodedCameraHighAndFarCap.w, 1.0);

  // ── Depth ──
//>>ifdef CLOUD_MARCH_EMIT_RECONSTRUCTION
  // C13-10 — the march already wrote contract slot 1. The anchor the velocity
  // channel needs is the MARCH's transmittance-weighted mean, so this pass only
  // reads it back; the shell intersection, the estimator and the centre alpha
  // fetch are not evaluated at all in this variant, which is why the producer
  // gets CHEAPER here even though the march gets slightly more expensive.
  let weighted = textureLoad(marchDepthTex, center, 0).g;
//>>else
  // A shell miss leaves (-1, -1): "this ray carries no cloud", which a consumer
  // must propagate rather than treat as distance zero.
  var weighted = -1.0;
  if (interval.x >= 0.0) {
    weighted = weightedDepthFromAlpha(interval.x, interval.y, alpha);
    out.depth = vec2<f32>(interval.x, weighted);
  }
//>>endif

  // ── Moments ──
//>>ifdef CLOUD_MARCH_EMIT_RECONSTRUCTION
  // C13-10 — with the march emitting, each neighbour has its OWN
  // transmittance-weighted depth, so the depth moment pair stops being an
  // approximation over one shared interval and becomes the real spatial
  // distribution. The no-cloud sentinel contributes 0 (the same value the
  // estimator variant contributes on a shell miss), so an empty neighbourhood
  // still reports a zero mean and a zero variance rather than a negative one.
//>>else
  // Coverage moments are exact over the 3x3 neighbourhood. Depth moments reuse
  // the CENTRE ray's interval with each neighbour's alpha: the shell interval
  // is a smooth geometric function of direction, so across three half-
  // resolution texels it varies far less than the alpha does, and re-deriving
  // nine ray directions plus nine ellipsoid intersections to capture that
  // difference would cost more than the variance it recovers is worth.
//>>endif
  var sumDepth = 0.0;
  var sumDepthSq = 0.0;
  var sumAlpha = 0.0;
  var sumAlphaSq = 0.0;
  var samples = 0.0;
  for (var dy: i32 = -1; dy <= 1; dy = dy + 1) {
    for (var dx: i32 = -1; dx <= 1; dx = dx + 1) {
      let coord = clamp(
        center + vec2<i32>(dx, dy),
        vec2<i32>(0, 0),
        resolution - vec2<i32>(1, 1)
      );
      let neighborAlpha = clamp(textureLoad(currentTex, coord, 0).a, 0.0, 1.0);
      var neighborDepth = 0.0;
//>>ifdef CLOUD_MARCH_EMIT_RECONSTRUCTION
      let neighborWeighted = textureLoad(marchDepthTex, coord, 0).g;
      if (neighborWeighted >= 0.0) {
        neighborDepth = clamp(neighborWeighted / farCap, 0.0, 1.0);
      }
//>>else
      if (interval.x >= 0.0) {
        neighborDepth = clamp(
          weightedDepthFromAlpha(interval.x, interval.y, neighborAlpha) / farCap,
          0.0,
          1.0
        );
      }
//>>endif
      sumDepth = sumDepth + neighborDepth;
      sumDepthSq = sumDepthSq + neighborDepth * neighborDepth;
      sumAlpha = sumAlpha + neighborAlpha;
      sumAlphaSq = sumAlphaSq + neighborAlpha * neighborAlpha;
      samples = samples + 1.0;
    }
  }
  let inverseSamples = 1.0 / max(samples, 1.0);
  out.moments = vec4<f32>(
    sumDepth * inverseSamples,
    sumDepthSq * inverseSamples,
    sumAlpha * inverseSamples,
    sumAlphaSq * inverseSamples
  );

  // ── Velocity ──
  // Anchored on the weighted depth rather than the interval midpoint: the point
  // that actually carries this pixel's radiance is the point whose motion a
  // reprojection has to follow. B stays 0 whenever the anchor, the transform,
  // or the reprojected position is unusable, so a consumer can tell "did not
  // move" from "could not be reprojected" — which two channels cannot express.
  if (u.primaryDeckAndResolutionY.w > 0.5 && weighted >= 0.0) {
    let currentEyeRelative = rayDirection * weighted;
    let previousEyeRelative = currentEyeRelative + u.cameraDeltaAndWidth.xyz;
    let previousClip =
      u.previousViewProjectionRelativeToEye *
      vec4<f32>(previousEyeRelative, 1.0);
    if (previousClip.w > 0.0) {
      let previousNdc = previousClip.xy / previousClip.w;
      let previousUv = vec2<f32>(
        previousNdc.x * 0.5 + 0.5,
        1.0 - (previousNdc.y * 0.5 + 0.5)
      );
      let onScreen =
        previousUv.x >= 0.0 &&
        previousUv.x <= 1.0 &&
        previousUv.y >= 0.0 &&
        previousUv.y <= 1.0;
      if (onScreen) {
        out.velocity = vec4<f32>(
          input.uv - previousUv,
          1.0,
          clamp(length(previousEyeRelative) / farCap, 0.0, 1.0)
        );
      }
    }
  }

  return out;
}
