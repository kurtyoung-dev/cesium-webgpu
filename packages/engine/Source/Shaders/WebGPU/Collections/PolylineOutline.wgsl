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
    outlineColor: vec4<f32>,
    outlineWidth: f32,
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

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) v_st: vec2<f32>,
  @location(1) v_width: f32,
  @location(2) v_distFromCenter: f32,
  // Per-vertex translucency-by-distance factor; always present so all
  // distance-display and split variants share the same output layout.
  @location(3) v_alphaScale: f32,
  //>>ifdef SPLIT_ENABLED
  @location(4) splitDirection: f32,
  //>>endif
  //>>ifdef LOG_DEPTH
  // Interpolated linear depthFromNearPlusOne; FS converts to frag_depth.
  @location(5) v_logDepth: f32,
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

  // Squared eye distance shared by the distance-aware gates below.
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
  // Test the raw value before squaring so the negative "always disable"
  // sentinel remains distinguishable.
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

  // Compute the translucency-by-distance factor and collapse fully transparent
  // segments before rasterization.
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

// Port of `czm_antialias` (Shaders/Builtin/Functions/antialias.glsl) at the
// default fuzzFactor of 0.1 — the four-argument overload both WebGL polyline
// materials call. Every caller here derives `dist` from `abs()`/`min()`, so it
// is never negative; the previous `clamp(-dist / fuzz, ...)` term was therefore
// pinned at zero, which pinned the blend factor at zero and made this function
// return `color1` for every fragment.
fn antialias(color1: vec4<f32>, color2: vec4<f32>, current: vec4<f32>,
             dist: f32) -> vec4<f32> {
  let fuzzFactor = 0.1;
  var val1 = clamp(dist / fuzzFactor, 0.0, 1.0);
  let val2 = clamp((dist - 0.5) / fuzzFactor, 0.0, 1.0);
  val1 = val1 * (1.0 - val2);
  val1 = val1 * val1 * (3.0 - (2.0 * val1));
  val1 = pow(val1, 0.5);
  let midColor = (color1 + color2) * 0.5;
  return mix(midColor, current, val1);
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
  var b = step(0.5 - halfInteriorWidth, st.y);
  b *= 1.0 - step(0.5 + halfInteriorWidth, st.y);

  // Distance from closest interior/outline boundary for anti-aliasing
  let d1 = abs(st.y - (0.5 - halfInteriorWidth));
  let d2 = abs(st.y - (0.5 + halfInteriorWidth));
  let dist = min(d1, d2);

  let currentColor = mix(outColor, color, b);
  var finalColor = antialias(outColor, color, currentColor, dist);

  // Edge anti-aliasing for the outer boundary of the line
  let edgeDist = abs(input.v_distFromCenter);
  let edgeAlpha = 1.0 - smoothstep(0.8, 1.0, edgeDist);
  finalColor.a *= edgeAlpha;

  // Apply the translucency-by-distance factor to the material alpha.
  finalColor.a *= input.v_alphaScale;

  if (finalColor.a < 0.005) {
    discard;
  }
  var fragOut: FragOutput;
  fragOut.color = finalColor;
  //>>ifdef LOG_DEPTH
  fragOut.depth = csm_writeLogDepth(input.v_logDepth, camera.logDepthFactor);
  //>>endif
  return fragOut;
}
