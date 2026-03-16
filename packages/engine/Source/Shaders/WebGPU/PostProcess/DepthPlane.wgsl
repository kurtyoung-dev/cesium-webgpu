// Depth Plane shader for WebGPU
// Renders a depth-only quad at the ellipsoid surface to prevent
// the camera from seeing through the globe when no terrain is loaded.
// Uses RTE (Relative-To-Eye) positioning for planetary-scale precision.

struct VertexInput {
  @location(0) positionHigh: vec3<f32>,
  @location(1) positionLow: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
};

struct DepthPlaneUniforms {
  mvpRelativeToEye: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>,
  _pad0: f32,
  encodedCameraLow: vec3<f32>,
  _pad1: f32,
};

@group(0) @binding(0) var<uniform> uniforms: DepthPlaneUniforms;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;

  // RTE: (posHigh - camHigh) + (posLow - camLow)
  let posRTE = (input.positionHigh - uniforms.encodedCameraHigh) +
               (input.positionLow - uniforms.encodedCameraLow);

  output.position = uniforms.mvpRelativeToEye * vec4<f32>(posRTE, 1.0);
  return output;
}

// Depth-only: no color output needed.
// The fragment shader writes only to the depth buffer.
@fragment
fn fragmentMain() {
  // No color output — depth-only rendering
}
