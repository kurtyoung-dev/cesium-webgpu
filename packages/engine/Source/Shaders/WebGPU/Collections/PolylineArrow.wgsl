// PolylineArrow.wgsl — Arrow-head polyline material for CesiumJS WebGPU
// Draws a narrow line body with a triangular arrow head at the end (s=1).
//
// Material uniforms (at offset 112 in uniform buffer):
//   color: vec4<f32> — arrow color
//
// Instance data is identical to PolylineCollection.wgsl (112 bytes, 7 x
// vec4 — Batch 137) except padding slots carry texture coordinates:
//   startPosLow.w → sStart (normalized distance along polyline)
//   endPosLow.w   → sEnd
//   @location(5) perInstanceFlags — DP-H42 / DP-H40 / A.14 DDC
//   @location(6) translucencyByDistance — Batch 137 (Audit A.14 finish)

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
}

struct MaterialUniforms {
    color: vec4<f32>,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> material: MaterialUniforms;

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

// AUDIT_2026_05_02 A.14 (Batch 137) — czm_nearFarScalar mirroring the
// base PolylineCollection.wgsl. Applies to all polyline material
// variants so material-styled polylines respect the same distance
// gates the user expects from the upstream WebGL flow.
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
  @location(0) v_st: vec2<f32>,
  @location(1) v_distFromCenter: f32,
  // AUDIT_2026_05_02 A.14 (Batch 137) — per-vertex alpha multiplier
  // computed from translucencyByDistance. Always present in the
  // varying layout so all (DDC × split) ifdef variants share one
  // VertexOutput shape; FS multiplies the final material color alpha
  // by it. When EYE_DISTANCE_TRANSLUCENCY is off the value stays 1.0.
  @location(2) v_alphaScale: f32,
  //>>ifdef SPLIT_ENABLED
  @location(3) splitDirection: f32,
  //>>endif
};

fn translateRelativeToEye(posHigh: vec3<f32>, posLow: vec3<f32>,
                          camHigh: vec3<f32>, camLow: vec3<f32>) -> vec3<f32> {
  return (posHigh - camHigh) + (posLow - camLow);
}

fn toScreenSpace(clipPos: vec4<f32>, viewportSize: vec2<f32>) -> vec2<f32> {
  let ndc = clipPos.xy / clipPos.w;
  return (ndc * 0.5 + 0.5) * viewportSize;
}

fn fromScreenSpace(screen: vec2<f32>, depth: f32, w: f32,
                   viewportSize: vec2<f32>) -> vec4<f32> {
  let ndc = (screen / viewportSize) * 2.0 - 1.0;
  return vec4<f32>(ndc * w, depth, w);
}

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;

  let lineWidth = input.startPosHighAndWidth.w;
  let halfWidth = lineWidth * 0.5 + 0.5;

  let sStart = input.startPosLow.w;
  let sEnd = input.endPosLow.w;

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

  let screenStart = toScreenSpace(clipStart, camera.viewportSize);
  let screenEnd = toScreenSpace(clipEnd, camera.viewportSize);

  let lineDir = normalize(screenEnd - screenStart);
  let lineNormal = vec2<f32>(-lineDir.y, lineDir.x);

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

  let baseClip = mix(clipStart, clipEnd, isEnd);
  let baseScreen = mix(screenStart, screenEnd, isEnd);
  let offsetScreen = baseScreen + lineNormal * side * halfWidth;

  var finalPos = fromScreenSpace(offsetScreen, baseClip.z, baseClip.w, camera.viewportSize);

  // AUDIT_2026_05_02 A.14 (Batch 137) — squared eye distance hoisted
  // for the three distance-aware gates below.
  let baseRTE = mix(startRTE, endRTE, isEnd);
  let camDistSq = dot(baseRTE, baseRTE);

  //>>ifdef DISTANCE_DISPLAY_CONDITION
  // AUDIT_2026_05_02 A.14 (Batch 137) — DDC for arrow polylines.
  let nearSqDDC = input.perInstanceFlags.z;
  let farSqDDC = input.perInstanceFlags.w;
  if (camDistSq < nearSqDDC || camDistSq > farSqDDC) {
    finalPos = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }
  //>>endif

  //>>ifdef DISABLE_DEPTH_DISTANCE
  // DP-H42 — depth override; same contract as PolylineCollection.wgsl.
  // Batch 140 — raw-sentinel pattern.
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

  // AUDIT_2026_05_02 A.14 (Batch 137) — translucencyByDistance ramp
  // forwarded to the FS via `v_alphaScale`. Material variants can't
  // multiply `input.color.a` directly because color comes from the
  // material uniform (not a per-instance attribute), so the scaling
  // happens in the FS where we have the final material color.
  // translucency=0 → clip the segment so the FS doesn't run at all.
  var alphaScale: f32 = 1.0;
  //>>ifdef EYE_DISTANCE_TRANSLUCENCY
  let translucency = czm_nearFarScalar(input.translucencyByDistance, camDistSq);
  alphaScale = translucency;
  if (translucency == 0.0) {
    finalPos = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }
  //>>endif
  output.v_alphaScale = alphaScale;

  output.position = finalPos;

  // Texture coordinates: s along polyline [0,1], t across line [0,1]
  let s = mix(sStart, sEnd, isEnd);
  let t = side * 0.5 + 0.5;
  output.v_st = vec2<f32>(s, t);
  output.v_distFromCenter = side;

  //>>ifdef SPLIT_ENABLED
  output.splitDirection = input.perInstanceFlags.y;
  //>>endif

  return output;
}

// Line between two 2D points evaluated at x
fn getPointOnLine(p0: vec2<f32>, p1: vec2<f32>, x: f32) -> f32 {
  let slope = (p0.y - p1.y) / (p0.x - p1.x);
  return slope * (x - p0.x) + p0.y;
}

// Soft edge anti-aliasing between two colors based on distance
fn antialias(color1: vec4<f32>, color2: vec4<f32>, current: vec4<f32>,
             dist: f32) -> vec4<f32> {
  let fuzz = max(fwidth(dist), 0.001);
  let val1 = clamp(dist / fuzz, 0.0, 1.0);
  let val2 = clamp(-dist / fuzz, 0.0, 1.0);
  let val = pow(val1 * val2, 0.5);
  return mix(color1, color2, val);
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  //>>ifdef SPLIT_ENABLED
  // DP-H40 — split discard before any material math.
  if (input.splitDirection < 0.0 && input.position.x > camera.splitPosition) {
    discard;
  }
  if (input.splitDirection > 0.0 && input.position.x < camera.splitPosition) {
    discard;
  }
  //>>endif

  let st = input.v_st;
  let color = material.color;
  let outsideColor = vec4<f32>(0.0, 0.0, 0.0, 0.0);

  // Arrow base position — use fwidth to scale with screen-space line length
  let base = 1.0 - abs(fwidth(st.s)) * 10.0;

  let center = vec2<f32>(1.0, 0.5);

  // Upper and lower arrow edges
  let ptOnUpperLine = getPointOnLine(vec2<f32>(base, 1.0), center, st.s);
  let ptOnLowerLine = getPointOnLine(vec2<f32>(base, 0.0), center, st.s);

  // Narrow body of the arrow (before the head)
  let halfWidth = 0.15;
  var s = step(0.5 - halfWidth, st.t);
  s *= 1.0 - step(0.5 + halfWidth, st.t);
  s *= 1.0 - step(base, st.s);

  // Arrow head triangle (after the base)
  var t = step(base, st.s);
  t *= 1.0 - step(ptOnUpperLine, st.t);
  t *= step(ptOnLowerLine, st.t);

  // Distance from closest separator for anti-aliasing
  var dist: f32;
  if (st.s < base) {
    let d1 = abs(st.t - (0.5 - halfWidth));
    let d2 = abs(st.t - (0.5 + halfWidth));
    dist = min(d1, d2);
  } else {
    var d1 = 1e10;
    if (st.t < 0.5 - halfWidth || st.t > 0.5 + halfWidth) {
      d1 = abs(st.s - base);
    }
    let d2 = abs(st.t - ptOnUpperLine);
    let d3 = abs(st.t - ptOnLowerLine);
    dist = min(min(d1, d2), d3);
  }

  let currentColor = mix(outsideColor, color, clamp(s + t, 0.0, 1.0));
  var outColor = antialias(outsideColor, color, currentColor, dist);

  // AUDIT_2026_05_02 A.14 (Batch 137) — apply translucencyByDistance.
  // `v_alphaScale` is 1.0 when EYE_DISTANCE_TRANSLUCENCY is inactive.
  outColor = vec4<f32>(outColor.rgb, outColor.a * input.v_alphaScale);

  if (outColor.a < 0.005) {
    discard;
  }
  return outColor;
}
