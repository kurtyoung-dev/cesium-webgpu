/**
 * Transforms a position from eye to window coordinates.
 * Port of czm_eyeToWindowCoordinates.
 * Requires csm_projection and csm_viewportTransformation uniforms.
 *
 * `viewportTransformation` is what `Matrix4.computeViewportTransformation`
 * builds: it maps NDC x,y in [-1,1] straight to pixels
 * (`halfWidth * ndc.x + x + halfWidth`), so the NDC handed to it must NOT be
 * pre-biased to [0,1] first — that halves the scale and shifts the origin.
 *
 * WebGPU NDC z is already in [0,1], which IS the window depth for the depth
 * range that matrix assumes (near 0, far 1), so z bypasses the matrix rather
 * than taking its [-1,1] -> [0,1] remap a second time.
 *
 * The returned w is the CLIP w, as in the GLSL twin, which assigns only
 * `q.xyz` and leaves `q.w` untouched for callers that perspective-correct.
 * @chunk functions/csm_eyeToWindowCoordinates
 */
fn csm_eyeToWindowCoordinates(
    positionEC: vec4<f32>,
    projection: mat4x4<f32>,
    viewportTransformation: mat4x4<f32>
) -> vec4<f32> {
    let clip: vec4<f32> = projection * positionEC;
    let ndc: vec3<f32> = clip.xyz / clip.w;
    let window: vec4<f32> = viewportTransformation * vec4<f32>(ndc, 1.0);
    return vec4<f32>(window.x, window.y, ndc.z, clip.w);
}
