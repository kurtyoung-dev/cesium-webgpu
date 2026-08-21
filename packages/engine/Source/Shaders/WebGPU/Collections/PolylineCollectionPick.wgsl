// PolylineCollectionPick.wgsl — Pick shader for polyline rendering
// Same vertex logic as PolylineCollection.wgsl but outputs pick color
// instead of line color.
//
// Instance data per segment (112 bytes, 7 x vec4), matching the color path's
// distance-attribute layout:
//   @location(0) startPosHighAndWidth:    vec4<f32>
//   @location(1) startPosLow:             vec4<f32>
//   @location(2) endPosHighAndMiter:      vec4<f32>
//   @location(3) endPosLow:               vec4<f32>
//   @location(4) pickColor:               vec4<f32>
//   @location(5) perInstanceFlags:        vec4<f32> — disable-depth distance,
//                                          split direction, DDC nearSq/farSq
//   @location(6) translucencyByDistance:  vec4<f32> — near, nearAlpha, far, farAlpha
//
// A polyline hidden by DDC or zero translucency must not pick, so this path
// reads the same visibility slots as the color path. Polyline has no pixelOffset
// or quad-scale, so EYE_DISTANCE_PIXEL_OFFSET / EYE_DISTANCE_SCALING
// don't apply.

struct CameraUniforms {
  mvpRelativeToEye: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>,
  _pad0: f32,
  encodedCameraLow: vec3<f32>,
  _pad1: f32,
  viewportSize: vec2<f32>,
  // Renderer-wide log-depth parameters. `logDepthNearFar` carries the encode
  // frustum, while `logDepthFactor` occupies the scalar lane after
  // `splitPosition`; `_padLog` preserves `previousViewProjection`'s 16-byte
  // alignment. The pick and color paths use the same `packCameraUniforms`, so
  // every variant shares one populated layout, though only LOG_DEPTH reads it.
  logDepthNearFar: vec2<f32>,
  minimumDisableDepthTestDistance: f32,
  splitPosition: f32,
  logDepthFactor: f32,
  _padLog: f32,
      previousViewProjection: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

//>>ifdef LOG_DEPTH
// Inline copies of the renderer-wide log-depth helpers; keep synchronized with
// PolylineCollection.wgsl. Only LOG_DEPTH variants include these helpers.
fn csm_vertexLogDepth(clipPosition: vec4<f32>, near: f32) -> f32 {
  return (clipPosition.w - near) + 1.0;
}
fn csm_updatePositionDepth(clipPosition: vec4<f32>) -> vec4<f32> {
  var coords = clipPosition;
  coords.z = clamp(coords.z / coords.w, 0.0, 1.0) * coords.w;
  return coords;
}
fn csm_writeLogDepth(depthFromNearPlusOne: f32, oneOverLog2FarDepthFromNearPlusOne: f32) -> f32 {
  return log2(depthFromNearPlusOne) * oneOverLog2FarDepthFromNearPlusOne;
}
//>>endif

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

// `czm_nearFarScalar` for the polyline pick path. Zero translucency must
// collapse the pick quad to a degenerate clip position so an invisible
// polyline cannot be picked.
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
  //>>ifdef LOG_DEPTH
  // Interpolated linear depthFromNearPlusOne;
  // the pick FS converts it to frag_depth (matches the color sibling).
  @location(2) v_logDepth: f32,
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

  // Squared eye distance used by the distance-display, depth-override, and
  // translucency gates below.
  let baseRTE = mix(startRTE, endRTE, isEnd);
  let camDistSq = dot(baseRTE, baseRTE);

  //>>ifdef DISTANCE_DISPLAY_CONDITION
  // Apply the same DDC visibility window as the color path.
  let nearSqDDC = input.perInstanceFlags.z;
  let farSqDDC = input.perInstanceFlags.w;
  if (camDistSq < nearSqDDC || camDistSq > farSqDDC) {
    finalPos = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }
  //>>endif

  //>>ifdef DISABLE_DEPTH_DISTANCE
  // The pick pipeline obeys the same depth override as the color
  // pipeline so the picked region matches what the user sees.
  // Check the raw sentinel before squaring so its negative sign remains
  // detectable; see PolylineCollection.wgsl.
  let disableRawDP = input.perInstanceFlags.x;
  if (disableRawDP < 0.0) {
    finalPos.z = finalPos.w;
  } else if (disableRawDP != 0.0) {
    let disableDepthSqDP = disableRawDP * disableRawDP;
    if (camDistSq < disableDepthSqDP) {
      finalPos.z = finalPos.w;
    }
  } else if (camera.minimumDisableDepthTestDistance != 0.0) {
    let frameMinSqDP =
      camera.minimumDisableDepthTestDistance *
      camera.minimumDisableDepthTestDistance;
    if (camDistSq < frameMinSqDP) {
      finalPos.z = finalPos.w;
    }
  }
  //>>endif

  // Zero translucency makes the polyline unpickable.
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

  //>>ifdef LOG_DEPTH
  // Mirror PolylineCollection.wgsl's color block. Compute this after every position
  // override above. The pick depth-override path pushes to the far plane
  // (z == w); map it to the log far plane. A forced z == 0 maps to the near
  // plane. Every other case takes the general encode.
  if (output.position.z == output.position.w && output.position.w != 0.0) {
    output.v_logDepth =
      (camera.logDepthNearFar.y - camera.logDepthNearFar.x) + 1.0;
  } else if (output.position.z == 0.0) {
    output.v_logDepth = 1.0;
  } else {
    output.v_logDepth =
      csm_vertexLogDepth(output.position, camera.logDepthNearFar.x);
  }
  output.position = csm_updatePositionDepth(output.position);
  //>>endif

  return output;
}

// Shared pick output. Without LOG_DEPTH this single-field struct is
// byte-equivalent to the bare `-> @location(0) vec4<f32>` return. With
// LOG_DEPTH it also carries log-encoded `@builtin(frag_depth)` so depth tests
// remain coherent in the shared pick framebuffer.
struct PickFragOutput {
  @location(0) color: vec4<f32>,
  //>>ifdef LOG_DEPTH
  @builtin(frag_depth) depth: f32,
  //>>endif
};

@fragment
fn fragmentMain(input: VertexOutput) -> PickFragOutput {
  //>>ifdef SPLIT_ENABLED
  if (input.splitDirection < 0.0 && input.position.x > camera.splitPosition) {
    discard;
  }
  if (input.splitDirection > 0.0 && input.position.x < camera.splitPosition) {
    discard;
  }
  //>>endif

  // Output pick color (ID encoded as RGBA)
  var out: PickFragOutput;
  out.color = input.pickColor;
  //>>ifdef LOG_DEPTH
  out.depth = csm_writeLogDepth(input.v_logDepth, camera.logDepthFactor);
  //>>endif
  return out;
}
