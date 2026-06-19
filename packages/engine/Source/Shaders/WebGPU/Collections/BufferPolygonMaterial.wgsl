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
  // x=show, y=encodedRGB8(color), z=color.alpha [0,1]. The alpha lane widens
  // the historical vec2 → vec3 so translucent fills composite correctly (the
  // `outColor.a < 0.005` discard below is now live). CPU pack + GPU
  // arrayStride/format are in lockstep: showAndColorArr is width-3 per vertex,
  // arrayStride 12, format float32x3.
  @location(3) showAndColor      : vec3<f32>, // x=show, y=encodedRGB8, z=alpha
};

// ── Vertex → Fragment ───────────────────────────────────────────────────────
struct VertexOutput {
  @builtin(position) position     : vec4<f32>,
  @location(0) v_pickColor        : vec4<f32>,
  @location(1) v_color            : vec4<f32>,
  //>>ifdef LOG_DEPTH
  // Interpolated linear depthFromNearPlusOne; FS converts to frag_depth.
  @location(2) v_logDepth         : f32,
  //>>endif
};

// ── Vertex shader ───────────────────────────────────────────────────────────
@vertex
fn vertexMain(input : VertexInput) -> VertexOutput {
  var output : VertexOutput;

  // Unpack attributes
  let show = input.showAndColor.x;
  var color = csm_decodeRGB8(input.showAndColor.y);
  // Fold material color.alpha into the RGB decode (csm_decodeRGB8 returns
  // alpha=1). Matches the WebGL VS `v_color.a *= alpha` (show is applied via
  // the degenerate-position hide below, not an alpha multiply).
  color.a = input.showAndColor.z;

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

  //>>ifdef LOG_DEPTH
  // NEW-BUFFER-LOG-DEPTH (Batch 263) — compute the interpolated linear
  // depthFromNearPlusOne and clamp clip-z so the FS frag_depth write lands in
  // the same log space as the globe. near rides in encodedCameraPositionMCHigh.w.
  output.v_logDepth = csm_vertexLogDepth(output.position, camera.encodedCameraPositionMCHigh.w);
  output.position = csm_updatePositionDepth(output.position);
  //>>endif

  output.v_pickColor = input.pickColor;
  output.v_color = color;

  return output;
}

// ── Fragment shader ─────────────────────────────────────────────────────────
//>>ifdef LOG_DEPTH
struct FragOutput {
  @location(0) color : vec4<f32>,
  // Written for the depth TEST too — the translucent fill tests against the
  // globe's log depth. factor rides in cameraPosition.w.
  @builtin(frag_depth) depth : f32,
};
@fragment
fn fragmentMain(input : VertexOutput) -> FragOutput {
  var outColor = input.v_color;

  if (outColor.a < 0.005) {
    discard;
  }

  var out : FragOutput;
  out.color = outColor;
  out.depth = csm_writeLogDepth(input.v_logDepth, camera.cameraPosition.w);
  return out;
}
//>>else
@fragment
fn fragmentMain(input : VertexOutput) -> @location(0) vec4<f32> {
  var outColor = input.v_color;

  if (outColor.a < 0.005) {
    discard;
  }

  return outColor;
}
//>>endif
