// BufferPointMaterial.wgsl — WebGPU port of BufferPointMaterialVS/FS.glsl
// Renders buffer-backed point primitives as instanced quads with RTE precision.
// Points are rendered as circles with configurable outline, matching the GLSL
// gl_PointSize + SDF circle approach but using instanced quads (WebGPU has no
// gl_PointSize equivalent).
//
// Attributes are packed for bandwidth: color/outlineColor in czm_decodeRGB8
// format, show/pixelSize/color packed into a vec3.

#import CameraUniforms;
#import csm_translateRelativeToEye;
#import csm_vertexLogDepth;
#import csm_writeLogDepth;
#import csm_decodeRGB8;

// ── Uniform buffer ──────────────────────────────────────────────────────────
struct BufferPointUniforms {
  pixelRatio : f32,
  padding0   : f32,
  padding1   : f32,
  padding2   : f32,
  viewport   : vec4<f32>, // x,y,width,height in pixels
};

@group(0) @binding(0) var<uniform> camera : CameraUniforms;
@group(1) @binding(0) var<uniform> params : BufferPointUniforms;

// ── Vertex input ────────────────────────────────────────────────────────────
struct VertexInput {
  // Per-instance (from buffer collection)
  @location(0) positionHigh             : vec3<f32>,
  @location(1) positionLow              : vec3<f32>,
  @location(2) pickColor                : vec4<f32>,
  @location(3) showPixelSizeAndColor    : vec3<f32>,  // x=show, y=pixelSize, z=encodedRGB8
  @location(4) outlineWidthAndOutlineColor : vec2<f32>, // x=outlineWidth, y=encodedRGB8
  // Per-vertex quad corner (from quad geometry)
  @location(5) quadOffset               : vec2<f32>,  // [-1,1] quad corner
};

// ── Vertex → Fragment ───────────────────────────────────────────────────────
struct VertexOutput {
  @builtin(position) position       : vec4<f32>,
  @location(0) v_pickColor          : vec4<f32>,
  @location(1) v_color              : vec4<f32>,
  @location(2) v_outlineColor       : vec4<f32>,
  @location(3) v_innerRadiusFrac    : f32,
  @location(4) v_quadCoord          : vec2<f32>,
  @location(5) v_logDepthOrDepth    : f32,
};

// ── Vertex shader ───────────────────────────────────────────────────────────
@vertex
fn vertexMain(input : VertexInput) -> VertexOutput {
  var output : VertexOutput;

  // Unpack attributes
  let show = input.showPixelSizeAndColor.x;
  let pixelSize = input.showPixelSizeAndColor.y;
  let color = csm_decodeRGB8(input.showPixelSizeAndColor.z);
  let outlineWidth = input.outlineWidthAndOutlineColor.x;
  let outlineColor = csm_decodeRGB8(input.outlineWidthAndOutlineColor.y);

  let innerRadius = 0.5 * pixelSize * params.pixelRatio;
  let outerRadius = (0.5 * pixelSize + outlineWidth) * params.pixelRatio;

  // RTE positioning
  let p = csm_translateRelativeToEye(
    input.positionHigh, input.positionLow,
    camera.encodedCameraPositionMCHigh, camera.encodedCameraPositionMCLow
  );
  let positionEC = camera.modelViewRelativeToEye * p;

  // Expand quad in screen space
  let clipPos = camera.projectionMatrix * positionEC;
  let ndcSize = outerRadius * 2.0 / params.viewport.zw;
  let offset = input.quadOffset * ndcSize * clipPos.w;

  output.position = vec4<f32>(clipPos.xy + offset, clipPos.z, clipPos.w);

  // Hide if show == 0 or degenerate point
  if (show == 0.0 || outerRadius == 0.0) {
    output.position = vec4<f32>(0.0, 0.0, -2.0, 1.0);
  }

  output.v_logDepthOrDepth = csm_vertexLogDepth(clipPos);
  output.v_pickColor = input.pickColor;
  output.v_color = color;
  output.v_outlineColor = outlineColor;
  output.v_innerRadiusFrac = select(0.0, innerRadius / outerRadius, outerRadius > 0.0);
  output.v_quadCoord = input.quadOffset;

  return output;
}

// ── Fragment shader ─────────────────────────────────────────────────────────
@fragment
fn fragmentMain(input : VertexOutput) -> @location(0) vec4<f32> {
  let dist = length(input.v_quadCoord);

  // Discard outside circle
  if (dist > 1.0) {
    discard;
  }

  // Inner fill vs outline
  var outColor : vec4<f32>;
  if (dist <= input.v_innerRadiusFrac) {
    outColor = input.v_color;
  } else {
    outColor = input.v_outlineColor;
  }

  // Edge anti-aliasing
  let aa = fwidth(dist);
  let outerAlpha = 1.0 - smoothstep(1.0 - aa, 1.0, dist);
  outColor = vec4<f32>(outColor.rgb, outColor.a * outerAlpha);

  if (outColor.a < 0.005) {
    discard;
  }

  csm_writeLogDepth(input.v_logDepthOrDepth);

  return outColor;
}
