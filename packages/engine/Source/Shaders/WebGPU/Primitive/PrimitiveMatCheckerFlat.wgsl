// PrimitiveMatCheckerFlat.wgsl
// Procedural checkerboard material, no lighting
// Uses RTE (Relative-To-Eye) for 64-bit precision at planetary scale
// Vertex: posHigh(3) + posLow(3) + st(2) = 8 floats = 32 bytes
// Uniform: mvpRTE(64) + encodedCameraHigh(16) + encodedCameraLow(16) + lightColor(16) + darkColor(16) + repeat(16) = 144 bytes, padded to 256

struct VertexInput {
    @location(0) positionHigh: vec3<f32>,
    @location(1) positionLow: vec3<f32>,
    @location(2) texCoord: vec2<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) texCoord: vec2<f32>,
}

struct Uniforms {
    mvpRelativeToEye: mat4x4<f32>,
    encodedCameraHigh: vec3<f32>,
    _pad0: f32,
    encodedCameraLow: vec3<f32>,
    _pad1: f32,
    lightColor: vec4<f32>,
    darkColor: vec4<f32>,
    repeat: vec2<f32>,
    _pad2: vec2<f32>,
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
    output.texCoord = input.texCoord;
    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    let uv = input.texCoord * uniforms.repeat;
    let cx = floor(uv.x);
    let cy = floor(uv.y);
    let checker = (cx + cy) % 2.0;
    return select(uniforms.lightColor, uniforms.darkColor, checker > 0.5);
}
