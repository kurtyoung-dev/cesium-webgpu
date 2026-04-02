/**
 * Transforms a position from eye to window coordinates.
 * Port of czm_eyeToWindowCoordinates.
 * Requires csm_projection and csm_viewportTransformation uniforms.
 * @chunk functions/csm_eyeToWindowCoordinates
 */
fn csm_eyeToWindowCoordinates(
    positionEC: vec4<f32>,
    projection: mat4x4<f32>,
    viewportTransformation: mat4x4<f32>
) -> vec4<f32> {
    let clip: vec4<f32> = projection * positionEC;
    let ndc: vec3<f32> = clip.xyz / clip.w;
    // WebGPU NDC: x,y in [-1,1], z in [0,1]
    let window: vec4<f32> = viewportTransformation * vec4<f32>(
        ndc.x * 0.5 + 0.5,
        ndc.y * 0.5 + 0.5,
        ndc.z,
        1.0
    );
    return window;
}
