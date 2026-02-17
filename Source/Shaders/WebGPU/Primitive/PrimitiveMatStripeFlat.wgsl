// PrimitiveMatStripeFlat.wgsl
// Procedural stripes material, no lighting
// Vertex: position(3) + st(2) = 5 floats = 20 bytes
// Uniform: MVP(64) + evenColor(16) + oddColor(16) + params(16) = 112, padded to 256
// params: x=offset, y=repeat, z=horizontal(0 or 1), w=unused

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
    evenColor: vec4<f32>,
    oddColor: vec4<f32>,
    params: vec4<f32>,
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
    let offset = uniforms.params.x;
    let repeatCount = uniforms.params.y;
    let isHorizontal = uniforms.params.z;

    var coord: f32;
    if (isHorizontal > 0.5) {
        coord = input.texCoord.y;
    } else {
        coord = input.texCoord.x;
    }

    let value = fract((coord - offset) * repeatCount);
    if (value < 0.5) {
        return uniforms.evenColor;
    }
    return uniforms.oddColor;
}
