/**
 * Basic Color Shader - WebGPU (WGSL)
 *
 * Simple vertex and fragment shader for rendering geometry with vertex colors.
 * This is the simplest shader in the Cesium WebGPU shader library.
 *
 * RTE — position is supplied as high/low split (locations 0/1) per the
 * engine-wide 64-bit emulation rules. Clip-space is computed via
 * `mvpRelativeToEye * translateRelativeToEye(...)` so planetary-scale
 * world coordinates don't lose precision through a naked `mvp * worldPos`.
 */

// Vertex shader input structure
struct VertexInput {
    @location(0) positionHigh: vec3<f32>,
    @location(1) positionLow: vec3<f32>,
    @location(2) color: vec4<f32>,
}

// Vertex shader output / Fragment shader input
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
}

// Uniform buffer with RTE transforms. `mvpRelativeToEye` has its
// translation column zeroed so it can safely consume an eye-relative
// position without losing bits through a large translation add.
struct CameraUniforms {
    mvpRelativeToEye: mat4x4<f32>,
}

struct MaterialUniforms {
    encodedCameraPositionMCHigh: vec3<f32>,
    _padHigh: f32,
    encodedCameraPositionMCLow: vec3<f32>,
    _padLow: f32,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> material: MaterialUniforms;

// Inline RTE helper — matches the signature used across engine shaders.
fn translateRelativeToEye(
    posHigh: vec3<f32>,
    posLow: vec3<f32>,
    camHigh: vec3<f32>,
    camLow: vec3<f32>,
) -> vec3<f32> {
    let highDiff = posHigh - camHigh;
    let lowDiff = posLow - camLow;
    return highDiff + lowDiff;
}

// Vertex shader
@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let rte = translateRelativeToEye(
        input.positionHigh,
        input.positionLow,
        material.encodedCameraPositionMCHigh,
        material.encodedCameraPositionMCLow,
    );
    output.position = camera.mvpRelativeToEye * vec4<f32>(rte, 1.0);
    output.color = input.color;
    return output;
}

// Fragment shader
@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    return input.color;
}
