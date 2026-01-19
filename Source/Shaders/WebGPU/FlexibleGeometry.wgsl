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
 */

// Vertex shader input structure with all possible attributes
struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) color: vec4<f32>,
    @location(2) normal: vec3<f32>,
    @location(3) uv: vec2<f32>,
    @location(4) tangent: vec3<f32>,
    @location(5) bitangent: vec3<f32>,
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

// Uniform buffer for transformation matrices
struct Uniforms {
    modelViewProjection: mat4x4<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

// Vertex shader
@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = uniforms.modelViewProjection * vec4<f32>(input.position, 1.0);
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
