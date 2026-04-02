/**
 * Basic vector tile vertex shader. Port of VectorTileVS.glsl.
 * Used for batched 3D Tiles vector features.
 */

struct VectorTileInput {
    @location(0) position: vec3<f32>,
    @location(1) batchId: f32,
};

struct VectorTileOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) batchId: f32,
};

struct VectorTileUniforms {
    modelViewProjection: mat4x4<f32>,
    highlightColor: vec4<f32>,
};

@group(0) @binding(0) var<uniform> vtUniforms: VectorTileUniforms;

@vertex
fn vertexMain(input: VectorTileInput) -> VectorTileOutput {
    var output: VectorTileOutput;
    output.position = vtUniforms.modelViewProjection * vec4<f32>(input.position, 1.0);
    output.batchId = input.batchId;
    return output;
}

@fragment
fn fragmentMain(input: VectorTileOutput) -> @location(0) vec4<f32> {
    return vtUniforms.highlightColor;
}
