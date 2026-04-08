// BufferPolylineMaterial.wgsl — WebGPU port of BufferPolylineMaterialVS/FS.glsl
// Renders buffer-backed polylines as screen-space thick quads with RTE precision.
// Each line segment is expanded into a quad using prev/next positions for
// miter-join direction computation. Matches upstream GLSL miter logic.
//
// Attributes: current/prev/next positions as high/low RTE pairs, packed
// show/color/width/texCoord, and pick color.

#import CameraUniforms;
#import csm_translateRelativeToEye;
#import csm_vertexLogDepth;
#import csm_writeLogDepth;
#import csm_decodeRGB8;

// ── Uniform buffer ──────────────────────────────────────────────────────────
struct BufferPolylineUniforms {
  pixelRatio : f32,
  padding0   : f32,
  padding1   : f32,
  padding2   : f32,
  viewport   : vec4<f32>, // x,y,width,height in pixels
};

@group(0) @binding(0) var<uniform> camera : CameraUniforms;
@group(1) @binding(0) var<uniform> params : BufferPolylineUniforms;

// ── Vertex input ────────────────────────────────────────────────────────────
struct VertexInput {
  @location(0) positionHigh     : vec3<f32>,
  @location(1) positionLow      : vec3<f32>,
  @location(2) prevPositionHigh : vec3<f32>,
  @location(3) prevPositionLow  : vec3<f32>,
  @location(4) nextPositionHigh : vec3<f32>,
  @location(5) nextPositionLow  : vec3<f32>,
  @location(6) pickColor        : vec4<f32>,
  @location(7) showColorWidthAndTexCoord : vec4<f32>,
  // x=show, y=encodedRGB8(color), z=width, w=texCoord(packed s + direction)
};

// ── Vertex → Fragment ───────────────────────────────────────────────────────
struct VertexOutput {
  @builtin(position) position     : vec4<f32>,
  @location(0) v_pickColor        : vec4<f32>,
  @location(1) v_color            : vec4<f32>,
  @location(2) v_st               : vec2<f32>,
  @location(3) v_logDepthOrDepth  : f32,
};

// ── Vertex shader ───────────────────────────────────────────────────────────
@vertex
fn vertexMain(input : VertexInput) -> VertexOutput {
  var output : VertexOutput;

  // Unpack attributes
  let show = input.showColorWidthAndTexCoord.x;
  let color = csm_decodeRGB8(input.showColorWidthAndTexCoord.y);
  let width = input.showColorWidthAndTexCoord.z * params.pixelRatio;
  let texCoordPacked = input.showColorWidthAndTexCoord.w;

  // Unpack texCoord: integer part = s coordinate, fractional part encodes direction
  let s = floor(texCoordPacked);
  let direction = sign(fract(texCoordPacked) - 0.5); // -1 or +1

  // RTE positioning for current, previous, and next vertices
  let pCurr = csm_translateRelativeToEye(
    input.positionHigh, input.positionLow,
    camera.encodedCameraPositionMCHigh, camera.encodedCameraPositionMCLow
  );
  let pPrev = csm_translateRelativeToEye(
    input.prevPositionHigh, input.prevPositionLow,
    camera.encodedCameraPositionMCHigh, camera.encodedCameraPositionMCLow
  );
  let pNext = csm_translateRelativeToEye(
    input.nextPositionHigh, input.nextPositionLow,
    camera.encodedCameraPositionMCHigh, camera.encodedCameraPositionMCLow
  );

  let posEC = (camera.modelViewRelativeToEye * pCurr).xyz;
  let prevEC = (camera.modelViewRelativeToEye * pPrev).xyz;
  let nextEC = (camera.modelViewRelativeToEye * pNext).xyz;

  // Project to clip space
  let clipPos = camera.projectionMatrix * vec4<f32>(posEC, 1.0);
  let prevClip = camera.projectionMatrix * vec4<f32>(prevEC, 1.0);
  let nextClip = camera.projectionMatrix * vec4<f32>(nextEC, 1.0);

  // Convert to screen space for miter computation
  let viewport = params.viewport;
  let screenCurr = (clipPos.xy / clipPos.w) * 0.5 * viewport.zw;
  let screenPrev = (prevClip.xy / prevClip.w) * 0.5 * viewport.zw;
  let screenNext = (nextClip.xy / nextClip.w) * 0.5 * viewport.zw;

  // Compute miter direction
  let dirPrev = normalize(screenCurr - screenPrev);
  let dirNext = normalize(screenNext - screenCurr);
  let tangent = normalize(dirPrev + dirNext);
  let miterDir = vec2<f32>(-tangent.y, tangent.x);

  // Miter length (clamped to avoid spikes)
  let cosHalfAngle = max(dot(miterDir, vec2<f32>(-dirPrev.y, dirPrev.x)), 0.1);
  let miterLen = (width * 0.5) / cosHalfAngle;
  let clampedMiterLen = min(miterLen, width * 2.0);

  // Extrude in screen space
  let extrusion = miterDir * direction * clampedMiterLen;
  let screenOffset = extrusion / (0.5 * viewport.zw);

  output.position = vec4<f32>(
    clipPos.xy + screenOffset * clipPos.w,
    clipPos.z,
    clipPos.w,
  );

  // Hide if not shown
  if (show == 0.0) {
    output.position = vec4<f32>(0.0, 0.0, -2.0, 1.0);
  }

  output.v_logDepthOrDepth = csm_vertexLogDepth(clipPos);
  output.v_pickColor = input.pickColor;
  output.v_color = color;
  output.v_st = vec2<f32>(s, (direction + 1.0) * 0.5);

  return output;
}

// ── Fragment shader ─────────────────────────────────────────────────────────
@fragment
fn fragmentMain(input : VertexOutput) -> @location(0) vec4<f32> {
  var outColor = input.v_color;

  if (outColor.a < 0.005) {
    discard;
  }

  csm_writeLogDepth(input.v_logDepthOrDepth);

  return outColor;
}
