// PrimitiveMatColorFlat.wgsl
// Material uniform color, no lighting (flat shading)
// Vertex: position(3) + st(2) = 5 floats = 20 bytes
// Uniform: MVP(64) + materialColor(16) = 80 bytes, padded to 256

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
    materialColor: vec4<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = uniforms.modelViewProjection * vec4<f32>(input.position, 1.0);
    output.texCoord = input.texCoord;
    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    return uniforms.materialColor;
}
