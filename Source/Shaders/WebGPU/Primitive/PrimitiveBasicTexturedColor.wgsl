// PrimitiveBasicTexturedColor.wgsl
// Texture sampling modulated by per-instance color, no lighting
// Vertex: position(3) + uv(2) + color(4) = 9 floats = 36 bytes
// Uniform: MVP matrix (64 bytes, padded to 256)
// Group 1: sampler + texture2D

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) texCoord: vec2<f32>,
    @location(2) color: vec4<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) texCoord: vec2<f32>,
}

struct Uniforms {
    modelViewProjection: mat4x4<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(1) @binding(0) var textureSampler: sampler;
@group(1) @binding(1) var colorTexture: texture_2d<f32>;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = uniforms.modelViewProjection * vec4<f32>(input.position, 1.0);
    output.color = input.color;
    output.texCoord = input.texCoord;
    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    let texColor = textureSample(colorTexture, textureSampler, input.texCoord);
    return texColor * input.color;
}
