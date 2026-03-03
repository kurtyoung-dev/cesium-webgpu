// PrimitivePickBasic.wgsl
// Pick shader for basic vertex layout: posHigh(3) + posLow(3) + color(4)
// Uses RTE (Relative-To-Eye) for 64-bit precision at planetary scale
// Outputs uniform pick color for GPU-based object identification

struct VertexInput {
    @location(0) positionHigh: vec3<f32>,
    @location(1) positionLow: vec3<f32>,
    @location(2) color: vec4<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
}

struct Uniforms {
    mvpRelativeToEye: mat4x4<f32>,
    encodedCameraHigh: vec3<f32>,
    _pad0: f32,
    encodedCameraLow: vec3<f32>,
    _pad1: f32,
    pickColor: vec4<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

fn translateRelativeToEye(high: vec3<f32>, low: vec3<f32>) -> vec4<f32> {
    var highDiff = high - uniforms.encodedCameraHigh;
    if (length(highDiff) == 0.0) { highDiff = vec3<f32>(0.0); }
    let lowDiff = low - uniforms.encodedCameraLow;
    return vec4<f32>(highDiff + lowDiff, 1.0);
}

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let eyePos = translateRelativeToEye(input.positionHigh, input.positionLow);
    output.position = uniforms.mvpRelativeToEye * eyePos;
    return output;
}

@fragment
fn fragmentMain() -> @location(0) vec4<f32> {
    return uniforms.pickColor;
}
