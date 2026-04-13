/**
 * Shadow volume appearance shader for classified ground primitives.
 * Port of ShadowVolumeAppearanceFS.glsl + ShadowVolumeAppearanceVS.glsl.
 * Renders the classified geometry with proper material/lighting.
 *
 * RTE — position is supplied as high/low split (locations 0/1). Both
 * clip-space and view-space positions are derived from the eye-relative
 * vector via `mvpRelativeToEye` / `modelViewRelativeToEye`, so classified
 * ground primitives stay precise against planetary terrain.
 */

struct SVAVertexInput {
    @location(0) positionHigh: vec3<f32>,
    @location(1) positionLow: vec3<f32>,
    @location(2) normal: vec3<f32>,
    @location(3) texCoord: vec2<f32>,
};

struct SVAVertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) positionEC: vec3<f32>,
    @location(1) normalEC: vec3<f32>,
    @location(2) texCoords: vec2<f32>,
};

struct SVAUniforms {
    // RTE matrices — translation column zeroed, safe to multiply against
    // eye-relative vectors.
    mvpRelativeToEye: mat4x4<f32>,
    modelViewRelativeToEye: mat4x4<f32>,
    encodedCameraPositionMCHigh: vec3<f32>,
    _padHigh: f32,
    encodedCameraPositionMCLow: vec3<f32>,
    _padLow: f32,
    normalMatrix: mat3x3<f32>,
    color: vec4<f32>,
};

@group(0) @binding(0) var<uniform> svaUniforms: SVAUniforms;

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
fn vertexMain(input: SVAVertexInput) -> SVAVertexOutput {
    var output: SVAVertexOutput;
    let rte = translateRelativeToEye(
        input.positionHigh,
        input.positionLow,
        svaUniforms.encodedCameraPositionMCHigh,
        svaUniforms.encodedCameraPositionMCLow,
    );
    output.position = svaUniforms.mvpRelativeToEye * vec4<f32>(rte, 1.0);
    output.positionEC = (svaUniforms.modelViewRelativeToEye * vec4<f32>(rte, 1.0)).xyz;
    output.normalEC = normalize(svaUniforms.normalMatrix * input.normal);
    output.texCoords = input.texCoord;
    return output;
}

@fragment
fn fragmentMain(input: SVAVertexOutput) -> @location(0) vec4<f32> {
    let toEye: vec3<f32> = normalize(-input.positionEC);
    let lightDir: vec3<f32> = normalize(vec3<f32>(0.0, 0.0, 1.0));
    let NdotL: f32 = max(dot(input.normalEC, lightDir), 0.0);
    let diffuse: vec3<f32> = svaUniforms.color.rgb * (0.3 + 0.7 * NdotL);
    return vec4<f32>(diffuse, svaUniforms.color.a);
}
