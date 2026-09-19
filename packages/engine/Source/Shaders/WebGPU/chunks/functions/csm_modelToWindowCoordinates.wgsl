/**
 * Transforms a model position to window coordinates.
 * Port of czm_modelToWindowCoordinates.
 *
 * Same conventions as `csm_eyeToWindowCoordinates`: raw NDC x,y into the
 * viewport matrix (it already maps [-1,1] to pixels), WebGPU NDC z passed
 * through as the window depth, and the clip w returned unchanged.
 * @chunk functions/csm_modelToWindowCoordinates
 */
fn csm_modelToWindowCoordinates(
    positionMC: vec4<f32>,
    modelView: mat4x4<f32>,
    projection: mat4x4<f32>,
    viewportTransformation: mat4x4<f32>
) -> vec4<f32> {
    let positionEC: vec4<f32> = modelView * positionMC;
    let clip: vec4<f32> = projection * positionEC;
    let ndc: vec3<f32> = clip.xyz / clip.w;
    let window: vec4<f32> = viewportTransformation * vec4<f32>(ndc, 1.0);
    return vec4<f32>(window.x, window.y, ndc.z, clip.w);
}
