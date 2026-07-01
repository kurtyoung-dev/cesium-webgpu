// Point Cloud Eye-Dome Lighting — depth-writing draw variant (PARITY-PC-EDL).
//
// This is the WGSL sibling of the WebGL "EC" derived shader built by
// Scene/PointCloudEyeDomeLighting.js::getECShaderProgram. It rasterizes the
// same instanced point quads as the default PointCloud draw shader
// (WebGPUPointCloudRenderer POINT_CLOUD_WGSL) using identical RTE 64-bit
// precision math (positionHigh/Low, mvpRelativeToEye), but emits a SECOND
// color output at @location(1) that packs the point's linear eye-space depth
// into RGBA8. The EDL off-screen framebuffer has two color attachments:
//   slot 0 — point color (same as the on-screen draw)
//   slot 1 — packed linear eye depth (sampled by the blend pass)
//
// The @location(1) output + the pack write are gated behind the
// POINT_CLOUD_EDL_DEPTH define. When the define is clear the shader is
// byte-identical to a single-target color shader — the //>>else branch strips
// the second output entirely. Only WebGPUPointCloudEyeDomeLighting compiles
// this shader (with the define set) into the off-screen depth pipeline.

struct VertexInput {
  @location(0) quadVertex: vec2<f32>,
  @location(1) positionHigh: vec3<f32>,
  @location(2) positionLow: vec3<f32>,
  @location(3) colorAndSize: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec3<f32>,
  @location(1) pointUV: vec2<f32>,
  // Linear eye-space depth (positive metres) of the point CENTER, carried to
  // the fragment stage for the packed-depth attachment.
  @location(2) eyeDepth: f32,
};

// Layout is byte-identical to WebGPUPointCloudRenderer's POINT_CLOUD_WGSL
// `Uniforms` (256 bytes) so this depth variant BINDS THE SAME uniform buffer
// the color draw already populated — no separate pack. We read the frustum
// far plane from `logDepth.y` (floats 60..63 in that layout) to normalise the
// packed eye-space depth into [0,1].
struct Uniforms {
  mvpRelativeToEye: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>,
  _pad0: f32,
  encodedCameraLow: vec3<f32>,
  _pad1: f32,
  viewportSize: vec2<f32>,
  pointSizeMultiplier: f32,
  _pad2: f32,
  prevViewProjection: mat4x4<f32>,
  modelMatrix: mat4x4<f32>,
  // x = frustum near, y = frustum far, z = log factor, w = useLogDepth flag.
  logDepth: vec4<f32>,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let posRTE = (input.positionHigh - u.encodedCameraHigh)
             + (input.positionLow - u.encodedCameraLow);
  let clipPos = u.mvpRelativeToEye * vec4<f32>(posRTE, 1.0);
  let pointSize = input.colorAndSize.a * u.pointSizeMultiplier;
  let px = pointSize / u.viewportSize.x * clipPos.w;
  let py = pointSize / u.viewportSize.y * clipPos.w;
  var fp = clipPos;
  fp.x = fp.x + input.quadVertex.x * px;
  fp.y = fp.y + input.quadVertex.y * py;
  output.position = fp;
  output.color = input.colorAndSize.rgb;
  output.pointUV = input.quadVertex;
  // clipPos.w is the positive eye-space distance to the point center for a
  // standard perspective projection (matching the on-screen draw path).
  output.eyeDepth = clipPos.w;
  return output;
}

//>>ifdef POINT_CLOUD_EDL_DEPTH
struct FragOut {
  @location(0) color: vec4<f32>,
  // Raw positive eye-space depth (metres) into an r32float attachment. Using a
  // float target instead of RGBA8 preserves near-field precision — normalising
  // a ~10 m eye depth by a ~10^7 m far plane and packing into 8 bits destroys
  // the depth deltas EDL relies on, crushing every point to black. The blend
  // pass reads `.r` directly; 0.0 is the clear/background sentinel.
  @location(1) eyeDepth: f32,
}

@fragment
fn fragmentMain(input: VertexOutput) -> FragOut {
  let dist = length(input.pointUV);
  if (dist > 1.0) { discard; }
  let alpha = 1.0 - smoothstep(0.8, 1.0, dist);
  return FragOut(
    vec4<f32>(input.color, alpha),
    max(input.eyeDepth, 1.0e-4),
  );
}
//>>else
@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let dist = length(input.pointUV);
  if (dist > 1.0) { discard; }
  let alpha = 1.0 - smoothstep(0.8, 1.0, dist);
  return vec4<f32>(input.color, alpha);
}
//>>endif
