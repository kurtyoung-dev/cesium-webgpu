/**
 * Basic vector tile vertex shader. Port of VectorTileVS.glsl.
 * Used for batched 3D Tiles vector features.
 *
 * RTE — position is supplied as high/low split (locations 0/1) per the
 * engine-wide 64-bit emulation rules. Clip-space is computed via
 * `mvpRelativeToEye * translateRelativeToEye(...)` so 3D Tiles features
 * anchored at planetary scale don't lose precision.
 */

struct VectorTileInput {
    @location(0) positionHigh: vec3<f32>,
    @location(1) positionLow: vec3<f32>,
    @location(2) batchId: f32,
};

struct VectorTileOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) batchId: f32,
};

struct VectorTileUniforms {
    mvpRelativeToEye: mat4x4<f32>,
    encodedCameraPositionMCHigh: vec3<f32>,
    _padHigh: f32,
    encodedCameraPositionMCLow: vec3<f32>,
    _padLow: f32,
    highlightColor: vec4<f32>,
};

@group(0) @binding(0) var<uniform> vtUniforms: VectorTileUniforms;

fn translateRelativeToEye(
    posHigh: vec3<f32>,
    posLow: vec3<f32>,
    camHigh: vec3<f32>,
    camLow: vec3<f32>,
) -> vec3<f32> {
    let highDiff = posHigh - camHigh;
    let lowDiff = posLow - camLow;
    return highDiff + lowDiff;
}

@vertex
fn vertexMain(input: VectorTileInput) -> VectorTileOutput {
    var output: VectorTileOutput;
    let rte = translateRelativeToEye(
        input.positionHigh,
        input.positionLow,
        vtUniforms.encodedCameraPositionMCHigh,
        vtUniforms.encodedCameraPositionMCLow,
    );
    output.position = vtUniforms.mvpRelativeToEye * vec4<f32>(rte, 1.0);
    output.batchId = input.batchId;
    return output;
}

@fragment
fn fragmentMain(input: VectorTileOutput) -> @location(0) vec4<f32> {
    return vtUniforms.highlightColor;
}
