/**
 * Renders 3D Tiles vector polylines clamped to terrain.
 * Port of Vector3DTileClampedPolylinesFS.glsl + VS.glsl.
 */

struct V3DTPolylineVertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) startPlaneEC: vec4<f32>,
    @location(1) endPlaneEC: vec4<f32>,
    @location(2) rightPlaneEC: vec4<f32>,
    @location(3) halfWidth: f32,
    @location(4) volumeUpEC: vec3<f32>,
};

struct V3DTPolylineUniforms {
    highlightColor: vec4<f32>,
    modelViewProjection: mat4x4<f32>,
    viewport: vec4<f32>,
};

@group(0) @binding(0) var<uniform> v3dtUniforms: V3DTPolylineUniforms;

@fragment
fn fragmentMain(input: V3DTPolylineVertexOutput) -> @location(0) vec4<f32> {
    // Simplified: render with highlight color
    // Full implementation requires globe depth texture readback
    return v3dtUniforms.highlightColor;
}
