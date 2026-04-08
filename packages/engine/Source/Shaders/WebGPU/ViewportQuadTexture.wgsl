// Viewport quad shader for texture sampling on screen-space quads.
// Used for Material.ImageType and similar texture-based materials.
// Binding convention: texture at 0, sampler at 1, optional tint at 2.

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) texCoords: vec2<f32>,
};

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
    output.texCoords = uv[vertexIndex];
    return output;
}

@group(0) @binding(0) var materialTexture: texture_2d<f32>;
@group(0) @binding(1) var materialSampler: sampler;

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    return textureSample(materialTexture, materialSampler, input.texCoords);
}
