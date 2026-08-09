// ErrorPipeline.wgsl
//
// Flat-magenta fallback for a model PBR pipeline that failed validation.
//
// WebGPU's synchronous `createRenderPipeline` does not throw on a bad shader or
// layout. It returns an invalid pipeline whose draws are silently dropped,
// which reads as a hole in the render with no missing asset and no console
// hint. WebGPUModelPipelineCache therefore wraps pipeline creation in a
// validation error scope and, on failure, substitutes a pipeline built from
// this shader, so the model renders solid magenta rather than nothing.
//
// It is a drop-in for the failed command: the same pipeline layout, so the bind
// groups the command already bound stay valid (only the @group(0) camera is
// read), and only vertex slot 0 — positionMC, the always-present model position
// buffer — is consumed. The relative-to-eye transform mirrors
// ModelPBRComplete's: subtract the encoded camera position in model coordinates
// first, then apply mvpRelativeToEye.

// Byte-locked to ModelPBRComplete.wgsl's CameraUniforms (group 0, binding 0) so
// the uniform buffer the failed command already bound reads correctly here.
struct CameraUniforms {
  mvpRelativeToEye: mat4x4<f32>,
  modelViewRelativeToEye: mat4x4<f32>,
  normalMatrix: mat4x4<f32>,
  encodedCameraPositionMCHigh: vec3<f32>,
  logDepthFactor: f32,
  encodedCameraPositionMCLow: vec3<f32>,
  logDepthNear: f32,
  cameraPositionWC: vec3<f32>,
  logDepthFar: f32,
  previousViewProjection: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
};

@vertex
fn vertexMain(@location(0) positionMC: vec3<f32>) -> VertexOutput {
  var output: VertexOutput;
  // RTE: subtract the encoded camera (model coords) FIRST, never posHigh+posLow.
  let rte = positionMC
          - camera.encodedCameraPositionMCHigh
          - camera.encodedCameraPositionMCLow;
  output.position = camera.mvpRelativeToEye * vec4<f32>(rte, 1.0);
  return output;
}

// Two MRT targets matching makeSceneFBTargets(emitsGBuffer:true): scene color +
// the eye-normal/roughness G-buffer (a flat placeholder here).
struct FragOutput {
  @location(0) color: vec4<f32>,
  @location(1) normalRoughness: vec4<f32>,
};

@fragment
fn fragmentMain() -> FragOutput {
  var out: FragOutput;
  out.color = vec4<f32>(1.0, 0.0, 1.0, 1.0);          // magenta
  out.normalRoughness = vec4<f32>(0.0, 0.0, 1.0, 0.5); // up-normal + mid roughness
  return out;
}
