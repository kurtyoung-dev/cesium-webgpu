/**
 * Basic Textured Shader - WebGPU (WGSL)
 * 
 * Vertex and fragment shader for rendering textured geometry.
 * Supports UV coordinates and texture sampling.
 * 
 * Phase 4.2: Shader Translation & Management
 */

// Vertex shader input structure
struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) texCoord: vec2<f32>,
}

// Vertex shader output / Fragment shader input
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) texCoord: vec2<f32>,
}

// Uniform buffer for transformation matrices
struct Uniforms {
    modelViewProjection: mat4x4<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var textureSampler: sampler;
@group(0) @binding(2) var colorTexture: texture_2d<f32>;

// Vertex shader
@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = uniforms.modelViewProjection * vec4<f32>(input.position, 1.0);
    output.texCoord = input.texCoord;
    return output;
}

// Fragment shader
@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    return textureSample(colorTexture, textureSampler, input.texCoord);
}
