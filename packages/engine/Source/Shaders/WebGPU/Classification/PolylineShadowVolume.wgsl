/**
 * Polyline shadow volume for ground-clamped polylines classification.
 * Port of PolylineShadowVolumeFS.glsl + PolylineShadowVolumeVS.glsl.
 */

struct PSVVertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) startEC: vec3<f32>,
    @location(1) endEC: vec3<f32>,
    @location(2) forwardDirEC: vec3<f32>,
    @location(3) texCoordT: f32,
};

@fragment
fn fragmentMain(input: PSVVertexOutput) -> @location(0) vec4<f32> {
    // Shadow volume polylines write to stencil in the classification pass.
    // Fragment color is a fallback visualization.
    let dist: f32 = abs(input.texCoordT - 0.5) * 2.0;
    let alpha: f32 = 1.0 - smoothstep(0.8, 1.0, dist);
    return vec4<f32>(1.0, 1.0, 1.0, alpha);
}
