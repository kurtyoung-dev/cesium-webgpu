/**
 * Generates 3D noise textures for cloud billboard rendering.
 * Port of CloudNoiseFS.glsl + CloudNoiseVS.glsl.
 */

struct CloudNoiseVertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) v_position: vec2<f32>,
};

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> CloudNoiseVertexOutput {
    var pos: array<vec2<f32>, 3> = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0)
    );
    var output: CloudNoiseVertexOutput;
    output.position = vec4<f32>(pos[vertexIndex], 0.0, 1.0);
    output.v_position = pos[vertexIndex];
    return output;
}

fn csm_cloudNoiseHash(p: vec3<f32>) -> f32 {
    var p2: vec3<f32> = fract(p * vec3<f32>(443.897, 441.423, 437.195));
    p2 = p2 + dot(p2, p2.yzx + 19.19);
    return fract((p2.x + p2.y) * p2.z);
}

fn csm_cloudNoiseNoise(p: vec3<f32>) -> f32 {
    let i: vec3<f32> = floor(p);
    let f: vec3<f32> = fract(p);
    let u: vec3<f32> = f * f * (3.0 - 2.0 * f);

    return mix(
        mix(mix(csm_cloudNoiseHash(i + vec3<f32>(0.0, 0.0, 0.0)),
                csm_cloudNoiseHash(i + vec3<f32>(1.0, 0.0, 0.0)), u.x),
            mix(csm_cloudNoiseHash(i + vec3<f32>(0.0, 1.0, 0.0)),
                csm_cloudNoiseHash(i + vec3<f32>(1.0, 1.0, 0.0)), u.x), u.y),
        mix(mix(csm_cloudNoiseHash(i + vec3<f32>(0.0, 0.0, 1.0)),
                csm_cloudNoiseHash(i + vec3<f32>(1.0, 0.0, 1.0)), u.x),
            mix(csm_cloudNoiseHash(i + vec3<f32>(0.0, 1.0, 1.0)),
                csm_cloudNoiseHash(i + vec3<f32>(1.0, 1.0, 1.0)), u.x), u.y),
        u.z
    );
}

struct CloudNoiseUniforms {
    noiseTextureDimensions: vec3<f32>,
    noiseDetail: f32,
    noiseOffset: vec3<f32>,
    _pad: f32,
};

@group(0) @binding(0) var<uniform> cloudUniforms: CloudNoiseUniforms;

@fragment
fn fragmentMain(input: CloudNoiseVertexOutput) -> @location(0) vec4<f32> {
    let pos: vec2<f32> = input.v_position * 0.5 + 0.5;
    let sliceIndex: f32 = floor(pos.x * cloudUniforms.noiseTextureDimensions.z);
    let localX: f32 = fract(pos.x * cloudUniforms.noiseTextureDimensions.z);
    let p: vec3<f32> = vec3<f32>(localX, pos.y, sliceIndex / cloudUniforms.noiseTextureDimensions.z) + cloudUniforms.noiseOffset;

    var n: f32 = 0.0;
    var amp: f32 = 1.0;
    var freq: f32 = 1.0;
    for (var i: i32 = 0; i < 5; i = i + 1) {
        n += amp * csm_cloudNoiseNoise(p * freq);
        amp *= 0.5;
        freq *= cloudUniforms.noiseDetail;
    }

    return vec4<f32>(n, n, n, 1.0);
}
