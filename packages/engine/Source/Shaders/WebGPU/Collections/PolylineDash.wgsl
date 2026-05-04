// PolylineDash.wgsl — Dashed polyline material for CesiumJS WebGPU
// Renders dashed lines using a 16-bit bitmask pattern.
//
// Material uniforms (at offset 112 in uniform buffer):
//   color: vec4<f32> — dash color
//   gapColor:      vec4<f32> — gap color (transparent for invisible gaps)
//   dashLength:    f32       — length of one full dash+gap cycle in pixels
//   dashPattern:   f32       — 16-bit bitmask as float (e.g., 255.0 = 0xFF)
//
// Uses screen-space fragment position and polyline angle to orient the
// dash pattern along the line direction regardless of screen orientation.

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
    gapColor: vec4<f32>,
    dashLength: f32,
    dashPattern: f32,
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
  @location(0) v_polylineAngle: f32,
  @location(1) v_distFromCenter: f32,
  // AUDIT_2026_05_02 A.14 (Batch 137) — see PolylineArrow.wgsl notes.
  @location(2) v_alphaScale: f32,
  //>>ifdef SPLIT_ENABLED
  @location(3) splitDirection: f32,
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

  // Polyline angle in screen space — used to rotate fragment coords
  // so the dash pattern follows the line direction
  output.v_polylineAngle = atan2(lineDir.y, lineDir.x);

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
  // Batch 140 — raw-sentinel pattern (see PolylineCollection.wgsl).
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
  output.v_distFromCenter = side;

  //>>ifdef SPLIT_ENABLED
  output.splitDirection = input.perInstanceFlags.y;
  //>>endif

  return output;
}

const MASK_LENGTH: f32 = 16.0;

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

  // Rotate fragment position by the polyline angle so the dash pattern
  // aligns with the line direction in screen space
  let angle = input.v_polylineAngle;
  let cosA = cos(angle);
  let sinA = sin(angle);
  let fragPos = input.position.xy;
  let rotatedPos = vec2<f32>(
    cosA * fragPos.x + sinA * fragPos.y,
    -sinA * fragPos.x + cosA * fragPos.y
  );

  // Compute position within the repeating dash cycle
  let dashLen = max(material.dashLength, 1.0);
  let dashPosition = fract(rotatedPos.x / dashLen);

  // Look up the 16-bit bitmask pattern
  let maskIndex = floor(dashPosition * MASK_LENGTH);
  let maskTest = floor(material.dashPattern / pow(2.0, maskIndex));
  let isDash = select(false, true, (maskTest % 2.0) >= 1.0);

  let fragColor = select(material.gapColor, material.color, isDash);

  if (fragColor.a < 0.005) {
    discard;
  }

  // Edge anti-aliasing
  let dist = abs(input.v_distFromCenter);
  let alpha = 1.0 - smoothstep(0.8, 1.0, dist);
  var outColor = fragColor;
  outColor.a *= alpha;

  // AUDIT_2026_05_02 A.14 (Batch 137) — apply translucencyByDistance.
  outColor.a *= input.v_alphaScale;

  if (outColor.a < 0.005) {
    discard;
  }
  return outColor;
}
