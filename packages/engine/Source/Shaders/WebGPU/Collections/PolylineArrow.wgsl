// PolylineArrow.wgsl — Arrow-head polyline material for CesiumJS WebGPU
// Draws a narrow line body with a triangular arrow head at the end (s=1).
//
// Material uniforms (at offset 112 in uniform buffer):
//   color: vec4<f32> — arrow color
//
// Instance data is identical to PolylineCollection.wgsl (112 bytes, 7 x
// vec4) except padding slots carry texture coordinates:
//   startPosLow.w → sStart (normalized distance along polyline)
//   endPosLow.w   → sEnd
//   @location(5) perInstanceFlags — disable-depth distance, split direction, DDC
//   @location(6) translucencyByDistance — near, nearAlpha, far, farAlpha

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
    // alignment. Packed unconditionally so every variant shares one uniform
    // buffer layout, though only LOG_DEPTH variants read them.
    logDepthNearFar: vec2<f32>,
    minimumDisableDepthTestDistance: f32,
    splitPosition: f32,
  logDepthFactor: f32,
  _padLog: f32,
        previousViewProjection: mat4x4<f32>,
}

struct MaterialUniforms {
    color: vec4<f32>,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

//>>ifdef LOG_DEPTH
// Inline copies of the renderer-wide log-depth helpers; keep synchronized with
// chunks/functions/csm_{vertexLogDepth,writeLogDepth}.wgsl.
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

// WGSL equivalent of `czm_nearFarScalar`, shared by all polyline material
// variants so their distance behavior matches the base shader and WebGL path.
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
  // Per-vertex translucency-by-distance factor. It remains present in every
  // varying layout so all distance-display and split variants share one
  // VertexOutput shape. The fragment shader applies it to the material alpha,
  // and it remains 1.0 when disabled.
  @location(2) v_alphaScale: f32,
  //>>ifdef SPLIT_ENABLED
  @location(3) splitDirection: f32,
  //>>endif
  //>>ifdef LOG_DEPTH
  // Interpolated linear depthFromNearPlusOne; FS converts to frag_depth.
  @location(4) v_logDepth: f32,
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

  // Squared eye distance is hoisted
  // for the three distance-aware gates below.
  let baseRTE = mix(startRTE, endRTE, isEnd);
  let camDistSq = dot(baseRTE, baseRTE);

  //>>ifdef DISTANCE_DISPLAY_CONDITION
  // Apply DDC to arrow polylines.
  let nearSqDDC = input.perInstanceFlags.z;
  let farSqDDC = input.perInstanceFlags.w;
  if (camDistSq < nearSqDDC || camDistSq > farSqDDC) {
    finalPos = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }
  //>>endif

  //>>ifdef DISABLE_DEPTH_DISTANCE
  // Apply the same depth override as PolylineCollection.wgsl. Check the raw
  // sentinel before squaring so its negative sign remains detectable.
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

  // Material color comes from a uniform rather than `input.color`, so forward
  // the translucency-by-distance factor for application to the final alpha in
  // the fragment shader. A zero factor collapses the segment before
  // rasterization.
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

  //>>ifdef LOG_DEPTH
  // Renderer-wide log depth — computed AFTER every position override above.
  // The pre-existing DISABLE_DEPTH_DISTANCE path pushes to the far plane
  // (z = w); map it to the log far plane (csm_writeLogDepth returns exactly
  // 1.0 when depthFromNearPlusOne = (far - near) + 1). A forced z == 0
  // (degenerate hide collapse) maps to the near plane.
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

struct FragOutput {
  @location(0) color: vec4<f32>,
  //>>ifdef LOG_DEPTH
  // Written for the depth TEST as well (frag_depth replaces rasterized z),
  // so the translucent polyline pass tests correctly against log depth.
  @builtin(frag_depth) depth: f32,
  //>>endif
};

@fragment
fn fragmentMain(input: VertexOutput) -> FragOutput {
  //>>ifdef SPLIT_ENABLED
  // Discard fragments across the split before any material math.
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
  let base = 1.0 - abs(fwidth(st.x)) * 10.0;

  let center = vec2<f32>(1.0, 0.5);

  // Upper and lower arrow edges
  let ptOnUpperLine = getPointOnLine(vec2<f32>(base, 1.0), center, st.x);
  let ptOnLowerLine = getPointOnLine(vec2<f32>(base, 0.0), center, st.x);

  // Narrow body of the arrow (before the head)
  let halfWidth = 0.15;
  var s = step(0.5 - halfWidth, st.y);
  s *= 1.0 - step(0.5 + halfWidth, st.y);
  s *= 1.0 - step(base, st.x);

  // Arrow head triangle (after the base)
  var t = step(base, st.x);
  t *= 1.0 - step(ptOnUpperLine, st.y);
  t *= step(ptOnLowerLine, st.y);

  // Distance from closest separator for anti-aliasing
  var dist: f32;
  if (st.x < base) {
    let d1 = abs(st.y - (0.5 - halfWidth));
    let d2 = abs(st.y - (0.5 + halfWidth));
    dist = min(d1, d2);
  } else {
    var d1 = 1e10;
    if (st.y < 0.5 - halfWidth || st.y > 0.5 + halfWidth) {
      d1 = abs(st.x - base);
    }
    let d2 = abs(st.y - ptOnUpperLine);
    let d3 = abs(st.y - ptOnLowerLine);
    dist = min(min(d1, d2), d3);
  }

  let currentColor = mix(outsideColor, color, clamp(s + t, 0.0, 1.0));
  var outColor = antialias(outsideColor, color, currentColor, dist);

  // Apply translucencyByDistance.
  // `v_alphaScale` is 1.0 when EYE_DISTANCE_TRANSLUCENCY is inactive.
  outColor = vec4<f32>(outColor.rgb, outColor.a * input.v_alphaScale);

  if (outColor.a < 0.005) {
    discard;
  }
  var fragOut: FragOutput;
  fragOut.color = outColor;
  //>>ifdef LOG_DEPTH
  fragOut.depth = csm_writeLogDepth(input.v_logDepth, camera.logDepthFactor);
  //>>endif
  return fragOut;
}
