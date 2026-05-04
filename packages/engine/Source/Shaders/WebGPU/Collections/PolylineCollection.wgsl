// PolylineCollection.wgsl — Polyline rendering for CesiumJS WebGPU
// Renders screen-space thick lines using instanced quads per segment.
//
// Each segment is two triangles forming a screen-space quad along the line.
// Instance data per segment (112 bytes, 7 x vec4):
//   @location(0) startPosHighAndWidth:    vec4<f32> — start.high.xyz, lineWidth
//   @location(1) startPosLow:             vec4<f32> — start.low.xyz, _pad
//   @location(2) endPosHighAndMiter:      vec4<f32> — end.high.xyz, miterLimit
//   @location(3) endPosLow:               vec4<f32> — end.low.xyz, _pad
//   @location(4) color:                   vec4<f32> — rgba
//   @location(5) perInstanceFlags:        vec4<f32> — disableDepthTestDistance,
//                                          splitDirection,
//                                          distanceDisplayConditionNearSq,
//                                          distanceDisplayConditionFarSq
//   @location(6) translucencyByDistance:  vec4<f32> — near, nearAlpha, far, farAlpha
//                                          (AUDIT_2026_05_02 A.14, Batch 136)
//
// Polyline has no pixelOffset or quad-scale, so EYE_DISTANCE_PIXEL_OFFSET
// and EYE_DISTANCE_SCALING gates are not consumed here. The remaining
// two gates (DISTANCE_DISPLAY_CONDITION + EYE_DISTANCE_TRANSLUCENCY)
// match the WebGL `PolylineVS.glsl` ifdef set.

struct CameraUniforms {
  mvpRelativeToEye: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>,
  _pad0: f32,
  encodedCameraLow: vec3<f32>,
  _pad1: f32,
  viewportSize: vec2<f32>,
  _pad2: vec2<f32>,
  // DP-H42 — frame-wide fallback threshold (meters). Squared in the shader.
  minimumDisableDepthTestDistance: f32,
  // DP-H40 — split cutoff in framebuffer pixels
  // (`frameState.splitPosition * drawingBufferWidth`).
  splitPosition: f32,
  _pad3: vec2<f32>,
    // DP-H41 (Batch 27) — previous frame's viewProjection for
    // TAA / motion-vector reprojection. Sourced from
    // `UniformState._previousViewProjection` (f32 mat4).
    previousViewProjection: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

struct VertexInput {
  @builtin(vertex_index) vertexIndex: u32,
  @location(0) startPosHighAndWidth: vec4<f32>,
  @location(1) startPosLow: vec4<f32>,
  @location(2) endPosHighAndMiter: vec4<f32>,
  @location(3) endPosLow: vec4<f32>,
  @location(4) color: vec4<f32>,
  @location(5) perInstanceFlags: vec4<f32>,
  @location(6) translucencyByDistance: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) distFromCenter: f32,
  //>>ifdef SPLIT_ENABLED
  @location(2) splitDirection: f32,
  //>>endif
};

fn translateRelativeToEye(posHigh: vec3<f32>, posLow: vec3<f32>, camHigh: vec3<f32>, camLow: vec3<f32>) -> vec3<f32> {
  return (posHigh - camHigh) + (posLow - camLow);
}

fn toScreenSpace(clipPos: vec4<f32>, viewportSize: vec2<f32>) -> vec2<f32> {
  let ndc = clipPos.xy / clipPos.w;
  return (ndc * 0.5 + 0.5) * viewportSize;
}

fn fromScreenSpace(screen: vec2<f32>, depth: f32, w: f32, viewportSize: vec2<f32>) -> vec4<f32> {
  let ndc = (screen / viewportSize) * 2.0 - 1.0;
  return vec4<f32>(ndc * w, depth, w);
}

// AUDIT_2026_05_02 A.14 (Batch 136) — WGSL port of `czm_nearFarScalar`.
// See `BillboardCollection.wgsl` for the canonical comment block.
fn czm_nearFarScalar(scalar: vec4<f32>, distSq: f32) -> f32 {
  let nearDistSq = scalar.x * scalar.x;
  let farDistSq = scalar.z * scalar.z;
  let denom = farDistSq - nearDistSq;
  if (denom <= 0.0) {
    return scalar.y;
  }
  let t = clamp((distSq - nearDistSq) / denom, 0.0, 1.0);
  return mix(scalar.y, scalar.w, t);
}

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;

  let lineWidth = input.startPosHighAndWidth.w;
  let halfWidth = lineWidth * 0.5 + 0.5; // +0.5 for AA

  // Compute clip positions for start and end
  let startRTE = translateRelativeToEye(
    input.startPosHighAndWidth.xyz, input.startPosLow.xyz,
    camera.encodedCameraHigh, camera.encodedCameraLow
  );
  let endRTE = translateRelativeToEye(
    input.endPosHighAndMiter.xyz, input.endPosLow.xyz,
    camera.encodedCameraHigh, camera.encodedCameraLow
  );

  let clipStart = camera.mvpRelativeToEye * vec4<f32>(startRTE, 1.0);
  let clipEnd = camera.mvpRelativeToEye * vec4<f32>(endRTE, 1.0);

  // Convert to screen space
  let screenStart = toScreenSpace(clipStart, camera.viewportSize);
  let screenEnd = toScreenSpace(clipEnd, camera.viewportSize);

  // Line direction and normal
  let lineDir = normalize(screenEnd - screenStart);
  let lineNormal = vec2<f32>(-lineDir.y, lineDir.x);

  // 6 vertices per quad segment
  let vertexIdx = input.vertexIndex % 6u;
  // Determine which point (start or end) and which side
  var isEnd: f32;
  var side: f32;
  switch vertexIdx {
    case 0u: { isEnd = 0.0; side = -1.0; }
    case 1u: { isEnd = 1.0; side = -1.0; }
    case 2u: { isEnd = 1.0; side = 1.0; }
    case 3u: { isEnd = 0.0; side = -1.0; }
    case 4u: { isEnd = 1.0; side = 1.0; }
    case 5u: { isEnd = 0.0; side = 1.0; }
    default: { isEnd = 0.0; side = -1.0; }
  }

  // Interpolate between start and end
  let baseClip = mix(clipStart, clipEnd, isEnd);
  let baseScreen = mix(screenStart, screenEnd, isEnd);

  // Offset perpendicular to line direction
  let offsetScreen = baseScreen + lineNormal * side * halfWidth;

  // Convert back to clip space
  var finalPos = fromScreenSpace(offsetScreen, baseClip.z, baseClip.w, camera.viewportSize);

  // AUDIT_2026_05_02 A.14 (Batch 136) — squared eye distance. The
  // segment's logical position is the per-vertex interpolated RTE
  // (start endpoint, end endpoint, or midpoint depending on `isEnd`).
  // Each fragment of the segment then sees the interpolated value,
  // which is what WebGL's PolylineVS does for distance gates.
  let baseRTE = mix(startRTE, endRTE, isEnd);
  let camDistSq = dot(baseRTE, baseRTE);

  //>>ifdef DISTANCE_DISPLAY_CONDITION
  // AUDIT_2026_05_02 A.14 (Batch 136) — gate visibility by squared
  // eye distance against the per-instance `[nearSq, farSq]` window
  // packed into `perInstanceFlags.zw`. Polylines push BOTH endpoints
  // to a degenerate clip position when out of range so the segment
  // never rasterizes. (Pushing only the current vertex would still
  // leave a degenerate sliver visible because the other endpoint
  // could remain on-screen.)
  let nearSqDDC = input.perInstanceFlags.z;
  let farSqDDC = input.perInstanceFlags.w;
  if (camDistSq < nearSqDDC || camDistSq > farSqDDC) {
    finalPos = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }
  //>>endif

  //>>ifdef DISABLE_DEPTH_DISTANCE
  // DP-H42 — override depth when the camera is within the configured
  // per-instance `disableDepthTestDistance` (perInstanceFlags.x) or the
  // frame-wide fallback. Forcing `finalPos.z = finalPos.w` maps to
  // NDC z = 1 so the rasterizer's less-equal depth compare always
  // passes. Mirrors BillboardCollection.wgsl.
  var disableDepthSq = input.perInstanceFlags.x * input.perInstanceFlags.x;
  if (disableDepthSq == 0.0 && camera.minimumDisableDepthTestDistance != 0.0) {
    disableDepthSq =
      camera.minimumDisableDepthTestDistance *
      camera.minimumDisableDepthTestDistance;
  }
  if (disableDepthSq != 0.0) {
    if (disableDepthSq < 0.0 || camDistSq < disableDepthSq) {
      finalPos.z = finalPos.w;
    }
  }
  //>>endif

  output.position = finalPos;

  // AUDIT_2026_05_02 A.14 (Batch 136) — translucencyByDistance ramp.
  // Multiplied into the propagated alpha; clipping to a degenerate
  // position when translucency is exactly 0 matches WebGL's "if
  // (translucency == 0.0) positionEC = vec3(0.0)" pattern.
  var effectiveAlpha: f32 = input.color.a;
  //>>ifdef EYE_DISTANCE_TRANSLUCENCY
  let translucency = czm_nearFarScalar(input.translucencyByDistance, camDistSq);
  effectiveAlpha = effectiveAlpha * translucency;
  if (translucency == 0.0) {
    output.position = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }
  //>>endif
  output.color = vec4<f32>(input.color.rgb, effectiveAlpha);
  output.distFromCenter = side; // For AA

  //>>ifdef SPLIT_ENABLED
  // DP-H40 — forward per-polyline split direction so the FS can discard
  // pixels on the wrong side of `camera.splitPosition`. Both vertices of
  // a segment carry the same splitDirection (per-instance), so the
  // interpolated value on any fragment of that segment is exactly the
  // authored sign.
  output.splitDirection = input.perInstanceFlags.y;
  //>>endif

  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  //>>ifdef SPLIT_ENABLED
  // DP-H40 — discard pixels on the wrong side of the split cutoff.
  // `camera.splitPosition` is in framebuffer pixels (JS pre-multiplies
  // `frameState.splitPosition` by `drawingBufferWidth`), same coord
  // space as `position.x` — so the compare runs in pixel space.
  if (input.splitDirection < 0.0 && input.position.x > camera.splitPosition) {
    discard;
  }
  if (input.splitDirection > 0.0 && input.position.x < camera.splitPosition) {
    discard;
  }
  //>>endif

  // Simple anti-aliasing at edges
  let dist = abs(input.distFromCenter);
  let alpha = 1.0 - smoothstep(0.8, 1.0, dist);
  var color = input.color;
  color.a *= alpha;
  if (color.a < 0.005) {
    discard;
  }
  return color;
}
