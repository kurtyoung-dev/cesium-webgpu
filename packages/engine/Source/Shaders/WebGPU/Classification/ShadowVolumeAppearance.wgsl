/**
 * Shadow volume appearance shader for classified ground primitives.
 * Port of ShadowVolumeAppearanceFS.glsl + ShadowVolumeAppearanceVS.glsl.
 * Renders the classified geometry with proper material/lighting.
 */

struct SVAVertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) texCoord: vec2<f32>,
};

struct SVAVertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) positionEC: vec3<f32>,
    @location(1) normalEC: vec3<f32>,
    @location(2) texCoords: vec2<f32>,
};

struct SVAUniforms {
    modelViewProjection: mat4x4<f32>,
    modelView: mat4x4<f32>,
    normalMatrix: mat3x3<f32>,
    color: vec4<f32>,
};

@group(0) @binding(0) var<uniform> svaUniforms: SVAUniforms;

@vertex
fn vertexMain(input: SVAVertexInput) -> SVAVertexOutput {
    var output: SVAVertexOutput;
    let posEC: vec4<f32> = svaUniforms.modelView * vec4<f32>(input.position, 1.0);
    output.position = svaUniforms.modelViewProjection * vec4<f32>(input.position, 1.0);
    output.positionEC = posEC.xyz;
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
