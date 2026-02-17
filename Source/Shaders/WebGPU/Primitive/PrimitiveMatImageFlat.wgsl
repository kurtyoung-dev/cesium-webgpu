// PrimitiveMatImageFlat.wgsl
// Image/DiffuseMap material, texture sampling with tint + repeat, no lighting
// Vertex: position(3) + st(2) = 5 floats = 20 bytes
// Uniform: MVP(64) + colorTint(16) + repeat(8+8pad=16) = 96 bytes, padded to 256
// Group 1: sampler + texture2D

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) texCoord: vec2<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) texCoord: vec2<f32>,
}

struct Uniforms {
    modelViewProjection: mat4x4<f32>,
    colorTint: vec4<f32>,
    repeat: vec2<f32>,
    _pad0: vec2<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(1) @binding(0) var textureSampler: sampler;
@group(1) @binding(1) var colorTexture: texture_2d<f32>;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = uniforms.modelViewProjection * vec4<f32>(input.position, 1.0);
    output.texCoord = input.texCoord;
    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    let uv = fract(uniforms.repeat * input.texCoord);
    let texColor = textureSample(colorTexture, textureSampler, uv);
    return texColor * uniforms.colorTint;
}
