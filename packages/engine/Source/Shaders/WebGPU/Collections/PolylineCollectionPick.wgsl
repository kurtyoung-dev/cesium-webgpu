// PolylineCollectionPick.wgsl — Pick shader for polyline rendering
// Same vertex logic as PolylineCollection.wgsl but outputs pick color
// instead of line color.
//
// Instance data per segment (112 bytes, 7 x vec4) — Batch 137 finishes
// audit A.14 by matching the color path's distance-attribute layout.
//   @location(0) startPosHighAndWidth:    vec4<f32>
//   @location(1) startPosLow:             vec4<f32>
//   @location(2) endPosHighAndMiter:      vec4<f32>
//   @location(3) endPosLow:               vec4<f32>
//   @location(4) pickColor:               vec4<f32>
//   @location(5) perInstanceFlags:        vec4<f32> — DP-H42 / DP-H40 (Batch 22)
//                                          + DDC nearSq / farSq (Batch 137)
//   @location(6) translucencyByDistance:  vec4<f32> — Batch 137
//
// Pick parity: a polyline that's invisible due to DDC or
// translucency=0 must NOT pick. Pre-Batch-137 it would still pick
// because pick didn't read these slots. Polyline has no pixelOffset
// or quad-scale, so EYE_DISTANCE_PIXEL_OFFSET / EYE_DISTANCE_SCALING
// don't apply.

struct CameraUniforms {
  mvpRelativeToEye: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>,
  _pad0: f32,
  encodedCameraLow: vec3<f32>,
  _pad1: f32,
  viewportSize: vec2<f32>,
  _pad2: vec2<f32>,
  minimumDisableDepthTestDistance: f32,
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
  @location(4) pickColor: vec4<f32>,
  @location(5) perInstanceFlags: vec4<f32>,
  @location(6) translucencyByDistance: vec4<f32>,
};

// AUDIT_2026_05_02 A.14 (Batch 137) — czm_nearFarScalar for the
// polyline pick path. translucency=0 must collapse the pick quad to
// a degenerate clip-pos so the user can't pick an invisible polyline.
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

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) pickColor: vec4<f32>,
  //>>ifdef SPLIT_ENABLED
  @location(1) splitDirection: f32,
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

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;

  let lineWidth = input.startPosHighAndWidth.w;
  let halfWidth = lineWidth * 0.5 + 1.0; // +1.0 for wider pick area

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

  // AUDIT_2026_05_02 A.14 (Batch 137) — squared eye distance, used
  // by DDC + DISABLE_DEPTH + translucency below.
  let baseRTE = mix(startRTE, endRTE, isEnd);
  let camDistSq = dot(baseRTE, baseRTE);

  //>>ifdef DISTANCE_DISPLAY_CONDITION
  // AUDIT_2026_05_02 A.14 (Batch 137) — pick parity for DDC.
  let nearSqDDC = input.perInstanceFlags.z;
  let farSqDDC = input.perInstanceFlags.w;
  if (camDistSq < nearSqDDC || camDistSq > farSqDDC) {
    finalPos = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }
  //>>endif

  //>>ifdef DISABLE_DEPTH_DISTANCE
  // DP-H42 — pick pipeline obeys the same depth override as the color
  // pipeline so the picked region matches what the user sees.
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

  // AUDIT_2026_05_02 A.14 (Batch 137) — translucency=0 → unpickable.
  //>>ifdef EYE_DISTANCE_TRANSLUCENCY
  let translucency = czm_nearFarScalar(input.translucencyByDistance, camDistSq);
  if (translucency == 0.0) {
    finalPos = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }
  //>>endif

  output.position = finalPos;
  output.pickColor = input.pickColor;

  //>>ifdef SPLIT_ENABLED
  output.splitDirection = input.perInstanceFlags.y;
  //>>endif

  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  //>>ifdef SPLIT_ENABLED
  if (input.splitDirection < 0.0 && input.position.x > camera.splitPosition) {
    discard;
  }
  if (input.splitDirection > 0.0 && input.position.x < camera.splitPosition) {
    discard;
  }
  //>>endif

  // Output pick color (ID encoded as RGBA)
  return input.pickColor;
}
