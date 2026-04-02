/**
 * Transforms a model position to window coordinates.
 * Port of czm_modelToWindowCoordinates.
 * @chunk functions/csm_modelToWindowCoordinates
 */
fn csm_modelToWindowCoordinates(
    positionMC: vec4<f32>,
    modelView: mat4x4<f32>,
    projection: mat4x4<f32>,
    viewportTransformation: mat4x4<f32>
) -> vec4<f32> {
    let positionEC: vec4<f32> = modelView * positionMC;
    let positionClip: vec4<f32> = projection * positionEC;
    let ndc: vec3<f32> = positionClip.xyz / positionClip.w;
    return viewportTransformation * vec4<f32>(
        ndc.x * 0.5 + 0.5,
        ndc.y * 0.5 + 0.5,
        ndc.z,
        1.0
    );
}
