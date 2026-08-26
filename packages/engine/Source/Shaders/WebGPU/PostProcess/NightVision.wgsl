// Night Vision post-processing effect — WGSL parity twin of
// Shaders/PostProcessStages/NightVision.glsl.
// Matches the GLSL math exactly: animated hash noise seeded by the frame
// number, added to the scene color, multiplied by pure green.

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

struct Uniforms {
    // x = czm_frameNumber equivalent (frameState.frameNumber)
    frameNumber: f32,
    _pad0: f32,
    _pad1: f32,
    _pad2: f32,
}

@group(0) @binding(0) var colorTexture: texture_2d<f32>;
@group(0) @binding(1) var colorSampler: sampler;
@group(0) @binding(2) var<uniform> uniforms: Uniforms;

// GLSL rand() twin (same constants as the upstream shader).
fn rand(co: vec2<f32>) -> f32 {
    return fract(sin(dot(co, vec2<f32>(12.9898, 78.233))) * 43758.5453);
}

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var pos = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0)
    );
    var uv = array<vec2<f32>, 3>(
        vec2<f32>(0.0, 1.0),
        vec2<f32>(2.0, 1.0),
        vec2<f32>(0.0, -1.0)
    );
    var output: VertexOutput;
    output.position = vec4<f32>(pos[vertexIndex], 0.0, 1.0);
    output.uv = uv[vertexIndex];
    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    let noiseValue = rand(input.uv + vec2<f32>(sin(uniforms.frameNumber))) * 0.1;
    let rgb = textureSample(colorTexture, colorSampler, input.uv).rgb;
    let green = vec3<f32>(0.0, 1.0, 0.0);
    return vec4<f32>((noiseValue + rgb) * green, 1.0);
}
