/**
 * Renders 3D Tiles vector polylines (not clamped to terrain).
 * Port of Vector3DTilePolylinesVS.glsl.
 */

struct V3DTPolylineInput {
    @location(0) currentPosition: vec3<f32>,
    @location(1) previousPosition: vec3<f32>,
    @location(2) nextPosition: vec3<f32>,
    @location(3) expandAndWidth: vec2<f32>,
};

struct V3DTPolylineOutput {
    @builtin(position) position: vec4<f32>,
};

struct V3DTPipelineUniforms {
    modelViewProjection: mat4x4<f32>,
    resolution: vec2<f32>,
    _pad: vec2<f32>,
};

@group(0) @binding(0) var<uniform> pipeUniforms: V3DTPipelineUniforms;

@vertex
fn vertexMain(input: V3DTPolylineInput) -> V3DTPolylineOutput {
    var output: V3DTPolylineOutput;
    output.position = pipeUniforms.modelViewProjection * vec4<f32>(input.currentPosition, 1.0);
    return output;
}
