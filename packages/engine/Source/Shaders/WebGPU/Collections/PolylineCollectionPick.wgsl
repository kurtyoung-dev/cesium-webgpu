// PolylineCollectionPick.wgsl — Pick shader for polyline rendering
// Same vertex logic as PolylineCollection.wgsl but outputs pick color instead of line color.
//
// Instance data per segment (80 bytes, 5 x vec4):
//   @location(0) startPosHighAndWidth:  vec4<f32> — start.high.xyz, lineWidth
//   @location(1) startPosLow:           vec4<f32> — start.low.xyz, _pad
//   @location(2) endPosHighAndMiter:    vec4<f32> — end.high.xyz, miterLimit
//   @location(3) endPosLow:             vec4<f32> — end.low.xyz, _pad
//   @location(4) pickColor:             vec4<f32> — pick ID rgba

struct CameraUniforms {
  mvpRelativeToEye: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>,
  _pad0: f32,
  encodedCameraLow: vec3<f32>,
  _pad1: f32,
  viewportSize: vec2<f32>,
  _pad2: vec2<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

struct VertexInput {
  @builtin(vertex_index) vertexIndex: u32,
  @location(0) startPosHighAndWidth: vec4<f32>,
  @location(1) startPosLow: vec4<f32>,
  @location(2) endPosHighAndMiter: vec4<f32>,
  @location(3) endPosLow: vec4<f32>,
  @location(4) pickColor: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) pickColor: vec4<f32>,
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
  output.position = fromScreenSpace(offsetScreen, baseClip.z, baseClip.w, camera.viewportSize);
  output.pickColor = input.pickColor;

  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  // Output pick color (ID encoded as RGBA)
  return input.pickColor;
}
