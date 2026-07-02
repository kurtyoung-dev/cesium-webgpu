// Depth visualization — WGSL parity twin of
// Shaders/PostProcessStages/DepthView.glsl (WIRE-PP-LIBRARY-BUILTINS).
//
// The GLSL stage emits `vec4(vec3(czm_readDepth(depthTexture, uv)), 1.0)`
// — the depth buffer value as grayscale. On WebGPU the post-process chain
// supplies the sampleable scene-depth copy (`depthSampleableView`) as a
// float texture, so the raw `.r` read is the direct equivalent. Encoding
// note: WebGL's czm_readDepth reverses the log-depth encoding first;
// WebGPU's scene depth is the conventional non-linear device depth, so
// absolute gray levels can differ between backends while the shape of the
// visualization (near = dark, far/sky = white) matches.

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@group(0) @binding(0) var depthTexture: texture_2d<f32>;
@group(0) @binding(1) var depthSampler: sampler;

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
    let depth = textureSample(depthTexture, depthSampler, input.uv).r;
    return vec4<f32>(vec3<f32>(depth), 1.0);
}
