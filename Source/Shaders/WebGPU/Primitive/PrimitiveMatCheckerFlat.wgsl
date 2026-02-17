// PrimitiveMatCheckerFlat.wgsl
// Procedural checkerboard material, no lighting
// Vertex: position(3) + st(2) = 5 floats = 20 bytes
// Uniform: MVP(64) + lightColor(16) + darkColor(16) + repeat(16) = 112 bytes, padded to 256

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
    lightColor: vec4<f32>,
    darkColor: vec4<f32>,
    repeat: vec2<f32>,
    _pad0: vec2<f32>,
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
    let uv = input.texCoord * uniforms.repeat;
    let cx = floor(uv.x);
    let cy = floor(uv.y);
    let checker = ((cx + cy) % 2.0);
    if (checker < 0.5) {
        return uniforms.lightColor;
    }
    return uniforms.darkColor;
}
