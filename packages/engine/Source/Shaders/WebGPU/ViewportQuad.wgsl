/**
 * Simple viewport quad shader for material rendering on screen-space quads.
 * Port of ViewportQuadFS.glsl + ViewportQuadVS.glsl.
 */

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) texCoords: vec2<f32>,
};

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    // Full-screen triangle (3 vertices cover the screen)
    var pos: array<vec2<f32>, 3> = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0)
    );
    var uv: array<vec2<f32>, 3> = array<vec2<f32>, 3>(
        vec2<f32>(0.0, 1.0),
        vec2<f32>(2.0, 1.0),
        vec2<f32>(0.0, -1.0)
    );

    var output: VertexOutput;
    output.position = vec4<f32>(pos[vertexIndex], 0.0, 1.0);
    output.texCoords = uv[vertexIndex];
    return output;
}

struct ViewportQuadUniforms {
    materialDiffuse: vec3<f32>,
    materialAlpha: f32,
};

@group(0) @binding(0) var<uniform> uniforms: ViewportQuadUniforms;

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    return vec4<f32>(uniforms.materialDiffuse, uniforms.materialAlpha);
}
