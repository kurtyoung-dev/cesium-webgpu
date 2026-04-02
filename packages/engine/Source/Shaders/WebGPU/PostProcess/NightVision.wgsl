// Night Vision post-processing effect — WGSL equivalent of NightVision.glsl

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@group(0) @binding(0) var colorTexture: texture_2d<f32>;
@group(0) @binding(1) var colorSampler: sampler;

fn luminance(rgb: vec3<f32>) -> f32 {
    return dot(rgb, vec3<f32>(0.2125, 0.7154, 0.0721));
}

// Simple hash-based noise
fn noise(uv: vec2<f32>) -> f32 {
    return fract(sin(dot(uv, vec2<f32>(12.9898, 78.233))) * 43758.5453);
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
    let rgb = textureSample(colorTexture, colorSampler, input.uv).rgb;
    let lum = luminance(rgb);

    // Night-vision green tint
    let greenTint = vec3<f32>(0.1, 0.95, 0.2);

    // Add noise for film grain effect
    let n = noise(input.uv * 500.0) * 0.15;

    let nightVisionColor = greenTint * (lum + n);
    return vec4<f32>(nightVisionColor, 1.0);
}
