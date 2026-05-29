// BufferPolygonMaterial.wgsl — WebGPU port of BufferPolygonMaterialVS/FS.glsl
// Renders buffer-backed polygon fill geometry with RTE precision.
// Triangulated polygon vertices are provided by the CPU (e.g., earcut).
// Color is packed via czm_decodeRGB8 for bandwidth efficiency.

#import CameraUniforms;
#import csm_translateRelativeToEye;
#import csm_vertexLogDepth;
#import csm_writeLogDepth;
#import csm_decodeRGB8;

// ── Uniforms ────────────────────────────────────────────────────────────────
@group(0) @binding(0) var<uniform> camera : CameraUniforms;

// ── Vertex input ────────────────────────────────────────────────────────────
struct VertexInput {
  @location(0) positionHigh      : vec3<f32>,
  @location(1) positionLow       : vec3<f32>,
  @location(2) pickColor         : vec4<f32>,
  @location(3) showAndColor      : vec2<f32>, // x=show, y=encodedRGB8(color)
};

// ── Vertex → Fragment ───────────────────────────────────────────────────────
struct VertexOutput {
  @builtin(position) position     : vec4<f32>,
  @location(0) v_pickColor        : vec4<f32>,
  @location(1) v_color            : vec4<f32>,
  @location(2) v_logDepthOrDepth  : f32,
};

// ── Vertex shader ───────────────────────────────────────────────────────────
@vertex
fn vertexMain(input : VertexInput) -> VertexOutput {
  var output : VertexOutput;

  // Unpack attributes
  let show = input.showAndColor.x;
  let color = csm_decodeRGB8(input.showAndColor.y);

  // RTE positioning
  let p = csm_translateRelativeToEye(
    input.positionHigh, input.positionLow,
    camera.encodedCameraPositionMCHigh.xyz, camera.encodedCameraPositionMCLow.xyz
  );
  let positionEC = camera.modelViewRelativeToEye * p;
  let clipPos = camera.projectionMatrix * positionEC;

  output.position = clipPos;

  // Hide if show == 0
  if (show == 0.0) {
    output.position = vec4<f32>(0.0, 0.0, -2.0, 1.0);
  }

  output.v_logDepthOrDepth = csm_vertexLogDepth(clipPos);
  output.v_pickColor = input.pickColor;
  output.v_color = color;

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
