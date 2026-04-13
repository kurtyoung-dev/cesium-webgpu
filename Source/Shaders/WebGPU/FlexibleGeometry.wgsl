/**
 * Flexible Geometry Shader - WebGPU (WGSL)
 *
 * Comprehensive shader that supports multiple vertex attributes for rendering
 * complex geometry with positions, colors, normals, texture coordinates,
 * tangents, and bitangents.
 *
 * This shader can be used for:
 * - Simple colored geometry (position + color)
 * - Textured geometry (position + UV)
 * - Lit geometry (position + normal)
 * - PBR materials (position + normal + UV + tangent + bitangent)
 *
 * Note: Attributes that are not present in the geometry will use default values.
 *
 * RTE — position is supplied as high/low split (locations 0/1) per the
 * engine-wide 64-bit emulation rules. Clip space is computed via
 * `mvpRelativeToEye * translateRelativeToEye(...)` so planetary-scale
 * world coordinates don't lose precision through a naked `mvp * worldPos`.
 */

// Vertex shader input structure with all possible attributes.
// Non-position locations shifted by 1 to make room for positionLow.
struct VertexInput {
    @location(0) positionHigh: vec3<f32>,
    @location(1) positionLow: vec3<f32>,
    @location(2) color: vec4<f32>,
    @location(3) normal: vec3<f32>,
    @location(4) uv: vec2<f32>,
    @location(5) tangent: vec3<f32>,
    @location(6) bitangent: vec3<f32>,
}

// Vertex shader output / Fragment shader input
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) tangent: vec3<f32>,
    @location(4) bitangent: vec3<f32>,
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
    output.normal = input.normal;
    output.uv = input.uv;
    output.tangent = input.tangent;
    output.bitangent = input.bitangent;
    return output;
}

// Fragment shader - Simple color output (can be extended for lighting)
@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    // For now, just return the vertex color
    // In the future, this can be extended to use normals for lighting,
    // UVs for texturing, and tangent space for normal mapping
    return input.color;
}
