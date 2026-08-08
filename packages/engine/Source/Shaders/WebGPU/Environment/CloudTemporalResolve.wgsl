// Cloud Temporal Reprojection + Accumulation — WebGPU
//
// Third pass of the cloud reconstruction stack, between the half-resolution
// raymarch and bilateral upscale.
//
// TWO VARIANTS, SELECTED AT COMPILE TIME:
//
//   DEFAULT (`//>>else`) — the history is a half-resolution, COLOR-ONLY proxy
//     and the anchor is the shell-interval midpoint. Byte-for-byte the
//     pre-C13-10 shader.
//   `CLOUD_RECONSTRUCTION_CONSUME` (C13-10) — the first consumer the C13-09
//     attachment set has ever had. The anchor becomes the march's TRUE
//     transmittance-weighted depth, the previous UV comes from the producer's
//     motion vector rather than being re-derived, and history reuse is gated on
//     the producer's own validity flag and on the moment record's internal
//     consistency.
//
// STILL OPEN AFTER C13-10's FIRST SLICE: the history remains HALF-RESOLUTION
// (the row's full-resolution reconstruction and true 1/16 current work are its
// follow-up), and every THRESHOLDED rejection — motion/depth bounds, variance
// clipping, reactive history, wind advection, disocclusion proper — is C13-12.
//
// C13-05 makes this existing proxy planet-correct:
//   1. reconstruct the current anchor in current-camera-relative coordinates;
//   2. intersect expanded WGS84 shells from an encoded high/low planet center;
//   3. add CPU-f64 `currentCameraWC - previousCameraWC`;
//   4. project through the previous relative-to-eye view-projection matrix.
//
// No full-ECEF vec3<f32> is ever formed. The current-only path remains the safe
// fallback for first use, discontinuities, missing transforms, shell misses,
// behind-camera reprojection, and off-screen history.

const WGS84_EQUATORIAL_RADIUS: f32 = 6378137.0;
const WGS84_POLAR_RADIUS: f32 = 6356752.314245179;

//>>ifdef CLOUD_RECONSTRUCTION_CONSUME
// C13-10 — rgba16float's relative quantum near 1 (`2^-10`). The moment
// attachment stores four half-floats independently, so `E[x²]` and `E[x]²` can
// disagree by about this much from rounding alone. It is a STORAGE tolerance,
// not a quality threshold: nothing about the cloud changes if it moves, only
// what counts as a self-consistent record.
const CLOUD_MOMENT_F16_QUANTUM: f32 = 0.0009765625;
//>>endif

struct TemporalUniforms {
  // Previous-frame projection × rotation-only view.
  previousViewProjectionRelativeToEye: mat4x4<f32>,
  // Inverse of the current projection × rotation-only view.
  inverseCurrentViewProjectionRelativeToEye: mat4x4<f32>,

  // Current ECEF camera split (same values as the primary march) + history blend.
  encodedCameraHighAndBlend: vec4<f32>,
  // Low split + CPU-f64 WGS84 cartographic height.
  encodedCameraLowAndHeight: vec4<f32>,
  // currentCameraWC - previousCameraWC, computed on CPU in f64; w = half width.
  cameraDeltaAndWidth: vec4<f32>,
  // Configured primary deck bottom/top; z = half height.
  primaryDeckAndResolutionY: vec4<f32>,
  // Low bottom/top + middle bottom/top.
  deckBoundsLowMid: vec4<f32>,
  // High bottom/top; z = multi-deck enabled; w = current-only/history-invalid.
  deckBoundsHighAndFlags: vec4<f32>,
  // Generation, reset reasons, Scene frame, reserved. Probe-visible only.
  historyDiagnostics: vec4<f32>,
};

@group(0) @binding(0) var currentHalfTex: texture_2d<f32>;
@group(0) @binding(1) var historyTex: texture_2d<f32>;
@group(0) @binding(2) var linearSampler: sampler;
@group(0) @binding(3) var<uniform> u: TemporalUniforms;
//>>ifdef CLOUD_RECONSTRUCTION_CONSUME
// C13-10 — the C13-09 attachment set, produced this frame between the march
// and this pass. All three are read with `textureLoad`: `depth` is rg32float
// and is NOT filterable without the optional `float32-filterable` feature, and
// the other two carry per-texel facts (a validity flag, a moment pair) that a
// linear tap would silently average into nonsense.
@group(0) @binding(4) var reconstructionDepthTex: texture_2d<f32>;
@group(0) @binding(5) var reconstructionVelocityTex: texture_2d<f32>;
@group(0) @binding(6) var reconstructionMomentsTex: texture_2d<f32>;
//>>endif

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vertexMain(@builtin(vertex_index) vid: u32) -> VertexOutput {
  var out: VertexOutput;
  let x = f32((vid << 1u) & 2u) * 2.0 - 1.0;
  let y = f32(vid & 2u) * 2.0 - 1.0;
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>(x * 0.5 + 0.5, 1.0 - (y * 0.5 + 0.5));
  return out;
}

// Current UV → current-camera-relative world direction. WebGPU framebuffer UV
// grows downward, so Y is flipped back to NDC before unprojection. Depth 0.9999
// avoids the far-plane w≈0 singularity used by the shared TAA path.
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

fn cloudShellAxes(height: f32) -> vec3<f32> {
  return vec3<f32>(
    WGS84_EQUATORIAL_RADIUS + height,
    WGS84_EQUATORIAL_RADIUS + height,
    WGS84_POLAR_RADIUS + height
  );
}

// Camera-relative ray / expanded-WGS84 ellipsoid intersection. Scale the
// encoded center parts independently, then cancel the high part before the low
// refinement, matching the primary cloud march's RTE contract.
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

// Return the nearest visible interval through one WGS84 cloud shell. This is a
// representative geometric proxy, not physical cloud depth; per-pixel
// front/weighted depth remains C13-09.
fn shellIntervalRTE(
  rd: vec3<f32>,
  deckBottom: f32,
  deckTop: f32,
) -> vec2<f32> {
  let centerHigh = -u.encodedCameraHighAndBlend.xyz;
  let centerLow = -u.encodedCameraLowAndHeight.xyz;
  let innerHit = rayEllipsoidIntersectRTE(
    rd,
    centerHigh,
    centerLow,
    cloudShellAxes(deckBottom)
  );
  let outerHit = rayEllipsoidIntersectRTE(
    rd,
    centerHigh,
    centerLow,
    cloudShellAxes(deckTop)
  );
  if (outerHit.x < 0.0 && outerHit.y < 0.0) {
    return vec2<f32>(-1.0);
  }

  let cameraHeight = u.encodedCameraLowAndHeight.w;
  var tStart: f32;
  var tEnd: f32;
  if (cameraHeight < deckBottom) {
    // Camera is inside the inner ellipsoid: exit inner, then exit outer.
    tStart = max(innerHit.y, 0.0);
    tEnd = outerHit.y;
  } else if (cameraHeight > deckTop) {
    // Camera is outside the outer ellipsoid: enter outer, then either enter
    // inner or leave outer when the ray is tangent to/misses the inner surface.
    tStart = max(outerHit.x, 0.0);
    tEnd = outerHit.y;
    if (innerHit.x > tStart) {
      tEnd = min(tEnd, innerHit.x);
    }
  } else {
    // Camera is already inside the shell. The first positive inner/outer
    // boundary is the end of the currently visible interval.
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

fn representativeShellDistance(rd: vec3<f32>) -> f32 {
  if (u.deckBoundsHighAndFlags.z < 0.5) {
    let interval = shellIntervalRTE(
      rd,
      u.primaryDeckAndResolutionY.x,
      u.primaryDeckAndResolutionY.y
    );
    if (interval.x < 0.0) {
      return -1.0;
    }
    return 0.5 * (interval.x + interval.y);
  }

  // Multi-deck history follows the nearest composited shell interval. This is
  // deterministic below, inside, and above all configured decks.
  let low = shellIntervalRTE(
    rd,
    u.deckBoundsLowMid.x,
    u.deckBoundsLowMid.y
  );
  let middle = shellIntervalRTE(
    rd,
    u.deckBoundsLowMid.z,
    u.deckBoundsLowMid.w
  );
  let high = shellIntervalRTE(
    rd,
    u.deckBoundsHighAndFlags.x,
    u.deckBoundsHighAndFlags.y
  );

  var bestStart = 1e30;
  var bestDistance = -1.0;
  if (low.x >= 0.0 && low.x < bestStart) {
    bestStart = low.x;
    bestDistance = 0.5 * (low.x + low.y);
  }
  if (middle.x >= 0.0 && middle.x < bestStart) {
    bestStart = middle.x;
    bestDistance = 0.5 * (middle.x + middle.y);
  }
  if (high.x >= 0.0 && high.x < bestStart) {
    bestDistance = 0.5 * (high.x + high.y);
  }
  return bestDistance;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let uv = input.uv;
  let current = textureSampleLevel(currentHalfTex, linearSampler, uv, 0.0);

  // First use or any coarse discontinuity seeds identity history.
  if (u.deckBoundsHighAndFlags.w > 0.5) {
    return current;
  }

//>>ifdef CLOUD_RECONSTRUCTION_CONSUME
  // ── C13-10 — ATTACHMENT-DRIVEN HISTORY VALIDATION ──
  //
  // The historical path below re-derives the anchor from a GEOMETRIC PROXY (the
  // shell-interval midpoint) and re-projects it itself. Here the producer
  // already published the facts: a real transmittance-weighted cloud depth, the
  // screen-space motion that depth implies, whether that motion was
  // reprojectable at all, and the moment pair over the current neighbourhood.
  // This pass reads them instead of guessing.
  //
  // ★ WHERE C13-10 STOPS AND C13-12 STARTS. The ledger gives `C13-12`
  //   "attachment-aware motion/depth rejection, variance clipping, reactive
  //   history, wind advection in reprojection, disocclusion". So every
  //   THRESHOLDED test — a depth-delta bound, a variance-clip width, a
  //   reactivity ramp, a wind-advected reprojection — is that row's. What is
  //   implemented here is the READ path and NON-PARAMETRIC validity: a fact the
  //   producer recorded (validity 0, the no-cloud sentinel), an internal
  //   consistency requirement on the moment record, and one early-out that is
  //   EXACTLY output-equivalent to running the full path. No number below is a
  //   quality knob; the only tolerance is the storage format's own quantum.
  let resolutionF = max(
    vec2<f32>(
      u.cameraDeltaAndWidth.w,
      u.primaryDeckAndResolutionY.z
    ),
    vec2<f32>(1.0)
  );
  let center = clamp(
    vec2<i32>(input.position.xy),
    vec2<i32>(0, 0),
    vec2<i32>(resolutionF) - vec2<i32>(1, 1)
  );

  // One fetch carries both moment pairs. `variance = E[x²] - E[x]²` for each.
  let moments = textureLoad(reconstructionMomentsTex, center, 0);
  let depthVariance = moments.g - moments.r * moments.r;
  let coverageVariance = moments.a - moments.b * moments.b;

  // WELL-FORMEDNESS, NOT POLICY. A real distribution always has
  // `E[x²] >= E[x]²`; the attachment stores all four in rgba16float, whose
  // relative quantum near 1 is `2^-10`, so the two moments can disagree by that
  // much purely from rounding. A record that violates the inequality by MORE
  // than the format can explain did not come from a distribution, and nothing
  // downstream (least of all C13-12's clip) can be built on it — so the frame
  // falls back to current-only, the same safe route every other failure takes.
  if (
    depthVariance < -CLOUD_MOMENT_F16_QUANTUM ||
    coverageVariance < -CLOUD_MOMENT_F16_QUANTUM
  ) {
    return current;
  }

  // EXACTLY OUTPUT-EQUIVALENT EARLY-OUT, and the first real work reduction the
  // attachments buy. `moments.b` is the mean alpha over the producer's 3×3
  // neighbourhood — the SAME nine texels, under the same clamp-to-edge, that
  // the neighbourhood clamp below reads. When it is zero every neighbour had
  // alpha 0, and the march emits PREMULTIPLIED radiance, so every neighbour's
  // RGB is 0 too: the clamp bounds collapse to (0,0,0,0), history clamps to
  // zero, and `mix(0, current, blend)` returns `current` regardless of blend.
  // Returning here skips the history fetch and eight texture taps for a
  // provably identical pixel. The variance is required to agree that the
  // neighbourhood is empty — a zero mean beside a non-zero second moment is an
  // inconsistent record, and this early-out must not fire on one.
  if (moments.b <= 0.0 && coverageVariance <= CLOUD_MOMENT_F16_QUANTUM) {
    return current;
  }

  // The producer's own verdict. `B` is 0 when the anchor, the previous
  // transform, or the reprojected position was unusable — the distinction two
  // motion channels cannot express, and the reason the velocity attachment is
  // four channels wide.
  let velocity = textureLoad(reconstructionVelocityTex, center, 0);
  if (velocity.b < 0.5) {
    return current;
  }

  // The no-cloud sentinel must propagate, never read as distance zero. `G` is
  // the transmittance-weighted mean the MARCH accumulated in this variant, so
  // this is a physical cloud depth rather than the shell midpoint.
  let reconstructionDepth = textureLoad(reconstructionDepthTex, center, 0);
  if (reconstructionDepth.g < 0.0) {
    return current;
  }

  // `RG` is current UV minus reprojected previous UV, so the previous sample
  // sits at `uv - motion`. No re-projection here: re-deriving it would be a
  // second implementation of the producer's transform and exactly the drift the
  // C13-03 contract exists to prevent.
  let previousUv = uv - velocity.rg;
  if (
    previousUv.x < 0.0 ||
    previousUv.x > 1.0 ||
    previousUv.y < 0.0 ||
    previousUv.y > 1.0
  ) {
    return current;
  }
  let resolution = resolutionF;
//>>else
  let rayDirection = currentRelativeRay(uv);
  let shellDistance = representativeShellDistance(rayDirection);
  if (shellDistance < 0.0) {
    return current;
  }

  let currentEyeRelative = rayDirection * shellDistance;
  let previousEyeRelative =
    currentEyeRelative + u.cameraDeltaAndWidth.xyz;
  let previousClip =
    u.previousViewProjectionRelativeToEye *
    vec4<f32>(previousEyeRelative, 1.0);
  if (previousClip.w <= 0.0) {
    return current;
  }

  let previousNdc = previousClip.xy / previousClip.w;
  let previousUv = vec2<f32>(
    previousNdc.x * 0.5 + 0.5,
    1.0 - (previousNdc.y * 0.5 + 0.5)
  );
  if (
    previousUv.x < 0.0 ||
    previousUv.x > 1.0 ||
    previousUv.y < 0.0 ||
    previousUv.y > 1.0
  ) {
    return current;
  }

  // Pay the 3×3 clamp neighborhood only for a valid history reprojection.
  // Shell misses, behind-camera anchors, and off-screen history return above.
  let resolution = max(
    vec2<f32>(
      u.cameraDeltaAndWidth.w,
      u.primaryDeckAndResolutionY.z
    ),
    vec2<f32>(1.0)
  );
//>>endif
  let texel = vec2<f32>(1.0) / resolution;
  var neighborhoodMin = current;
  var neighborhoodMax = current;
  for (var dy: i32 = -1; dy <= 1; dy = dy + 1) {
    for (var dx: i32 = -1; dx <= 1; dx = dx + 1) {
      if (dx == 0 && dy == 0) {
        continue;
      }
      let offset = vec2<f32>(f32(dx), f32(dy)) * texel;
      let sample =
        textureSampleLevel(currentHalfTex, linearSampler, uv + offset, 0.0);
      neighborhoodMin = min(neighborhoodMin, sample);
      neighborhoodMax = max(neighborhoodMax, sample);
    }
  }

  let rawHistory =
    textureSampleLevel(historyTex, linearSampler, previousUv, 0.0);
  let history =
    clamp(rawHistory, neighborhoodMin, neighborhoodMax);
  let blend = clamp(u.encodedCameraHighAndBlend.w, 0.0, 1.0);
  return mix(history, current, blend);
}
