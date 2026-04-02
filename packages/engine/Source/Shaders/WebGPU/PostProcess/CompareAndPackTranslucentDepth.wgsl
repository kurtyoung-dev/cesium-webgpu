// Compare And Pack Translucent Depth — WGSL equivalent of CompareAndPackTranslucentDepth.glsl
// Packs the closest translucent depth for later compositing.

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@group(0) @binding(0) var depthTexture: texture_depth_2d;
@group(0) @binding(1) var depthSampler: sampler;

fn packDepth(depth: f32) -> vec4<f32> {
    let r = depth;
    let g = fract(depth * 255.0);
    let b = fract(depth * 65025.0);
    let a = fract(depth * 16581375.0);
    return vec4<f32>(r, g, b, a) - vec4<f32>(g, b, a, 0.0) * (1.0 / 255.0);
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
    let depth = textureSample(depthTexture, depthSampler, input.uv);
    return packDepth(depth);
}
