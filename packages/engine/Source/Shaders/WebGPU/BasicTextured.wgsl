/**
 * Basic Textured Shader - WebGPU (WGSL)
 *
 * Vertex and fragment shader for rendering textured geometry.
 * Supports UV coordinates and texture sampling.
 *
 * Phase 4.2: Shader Translation & Management
 *
 * RTE — position is supplied as high/low split (locations 0/1). Clip
 * space is computed via `mvpRelativeToEye * translateRelativeToEye(...)`
 * so planetary-scale world coordinates keep precision.
 */

// Vertex shader input structure
struct VertexInput {
    @location(0) positionHigh: vec3<f32>,
    @location(1) positionLow: vec3<f32>,
    @location(2) texCoord: vec2<f32>,
}

// Vertex shader output / Fragment shader input
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) texCoord: vec2<f32>,
}

// Uniform buffer with RTE transforms.
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
@group(0) @binding(1) var textureSampler: sampler;
@group(0) @binding(2) var colorTexture: texture_2d<f32>;

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
    output.texCoord = input.texCoord;
    return output;
}

// Fragment shader
@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    return textureSample(colorTexture, textureSampler, input.texCoord);
}
