// PolylineOutline.wgsl — Outlined polyline material for CesiumJS WebGPU
// Renders a line with a colored interior and a different-colored outline border.
//
// Material uniforms (at offset 112 in uniform buffer):
//   color: vec4<f32>  — interior fill color
//   outlineColor:  vec4<f32>  — border outline color
//   outlineWidth:  f32        — outline width in pixels on each side

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
    outlineColor: vec4<f32>,
    outlineWidth: f32,
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

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) v_st: vec2<f32>,
  @location(1) v_width: f32,
  @location(2) v_distFromCenter: f32,
  // AUDIT_2026_05_02 A.14 (Batch 137) — see PolylineArrow.wgsl notes.
  @location(3) v_alphaScale: f32,
  //>>ifdef SPLIT_ENABLED
  @location(4) splitDirection: f32,
  //>>endif
};

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

  // AUDIT_2026_05_02 A.14 (Batch 137) — squared eye distance hoisted.
  let baseRTE = mix(startRTE, endRTE, isEnd);
  let camDistSq = dot(baseRTE, baseRTE);

  //>>ifdef DISTANCE_DISPLAY_CONDITION
  let nearSqDDC = input.perInstanceFlags.z;
  let farSqDDC = input.perInstanceFlags.w;
  if (camDistSq < nearSqDDC || camDistSq > farSqDDC) {
    finalPos = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }
  //>>endif

  //>>ifdef DISABLE_DEPTH_DISTANCE
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

  // AUDIT_2026_05_02 A.14 (Batch 137) — translucencyByDistance ramp.
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

  let s = mix(sStart, sEnd, isEnd);
  let t = side * 0.5 + 0.5;
  output.v_st = vec2<f32>(s, t);
  output.v_width = lineWidth;
  output.v_distFromCenter = side;

  //>>ifdef SPLIT_ENABLED
  output.splitDirection = input.perInstanceFlags.y;
  //>>endif

  return output;
}

// Soft edge anti-aliasing between two colors
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
  if (input.splitDirection < 0.0 && input.position.x > camera.splitPosition) {
    discard;
  }
  if (input.splitDirection > 0.0 && input.position.x < camera.splitPosition) {
    discard;
  }
  //>>endif

  let st = input.v_st;
  let lineWidth = input.v_width;
  let color = material.color;
  let outColor = material.outlineColor;
  let outWidth = material.outlineWidth;

  // Interior region: the portion of the line not covered by outline
  // halfInteriorWidth is normalized [0..0.5] — the half-width of the
  // interior relative to the full line width
  let halfInteriorWidth = 0.5 * max(lineWidth - outWidth, 0.0) / max(lineWidth, 0.001);

  // Step function: 1 inside the interior band, 0 in the outline
  var b = step(0.5 - halfInteriorWidth, st.t);
  b *= 1.0 - step(0.5 + halfInteriorWidth, st.t);

  // Distance from closest interior/outline boundary for anti-aliasing
  let d1 = abs(st.t - (0.5 - halfInteriorWidth));
  let d2 = abs(st.t - (0.5 + halfInteriorWidth));
  let dist = min(d1, d2);

  let currentColor = mix(outColor, color, b);
  var finalColor = antialias(outColor, color, currentColor, dist);

  // Edge anti-aliasing for the outer boundary of the line
  let edgeDist = abs(input.v_distFromCenter);
  let edgeAlpha = 1.0 - smoothstep(0.8, 1.0, edgeDist);
  finalColor.a *= edgeAlpha;

  // AUDIT_2026_05_02 A.14 (Batch 137) — apply translucencyByDistance.
  finalColor.a *= input.v_alphaScale;

  if (finalColor.a < 0.005) {
    discard;
  }
  return finalColor;
}
