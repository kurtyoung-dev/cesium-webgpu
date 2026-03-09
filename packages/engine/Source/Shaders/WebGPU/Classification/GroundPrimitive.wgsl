// GroundPrimitive.wgsl — Ground-clamped primitive rendering for CesiumJS WebGPU
// Uses stencil operations for terrain classification.
//
// Two-pass approach:
// Pass 1 (Stencil): Write stencil where ground primitive exists
// Pass 2 (Color):   Render color only where stencil matches

struct Uniforms {
  mvpRelativeToEye: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>,
  _pad0: f32,
  encodedCameraLow: vec3<f32>,
  _pad1: f32,
  color: vec4<f32>,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

struct VertexInput {
  @location(0) positionHigh: vec3<f32>,
  @location(1) positionLow: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
};

fn translateRelativeToEye(posHigh: vec3<f32>, posLow: vec3<f32>, camHigh: vec3<f32>, camLow: vec3<f32>) -> vec3<f32> {
  return (posHigh - camHigh) + (posLow - camLow);
}

// Stencil pass vertex shader — same as color pass
@vertex
fn stencilVertex(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let posRTE = translateRelativeToEye(
    input.positionHigh, input.positionLow,
    u.encodedCameraHigh, u.encodedCameraLow
  );
  output.position = u.mvpRelativeToEye * vec4<f32>(posRTE, 1.0);
  return output;
}

// Stencil pass fragment — no color output, only stencil write
@fragment
fn stencilFragment() -> @location(0) vec4<f32> {
  return vec4<f32>(0.0); // Color write masked off in render state
}

// Color pass vertex shader — renders a full-screen quad reading stencil
struct ColorVertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
};

@vertex
fn colorVertex(input: VertexInput) -> ColorVertexOutput {
  var output: ColorVertexOutput;
  let posRTE = translateRelativeToEye(
    input.positionHigh, input.positionLow,
    u.encodedCameraHigh, u.encodedCameraLow
  );
  output.position = u.mvpRelativeToEye * vec4<f32>(posRTE, 1.0);
  output.color = u.color;
  return output;
}

@fragment
fn colorFragment(input: ColorVertexOutput) -> @location(0) vec4<f32> {
  // Stencil test gates this — only fragments passing stencil are drawn
  return input.color;
}
