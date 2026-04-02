/**
 * Computes cascade distance for shadow mapping. Port of czm_cascadeDistance.
 * @chunk functions/csm_cascadeDistance
 */
fn csm_cascadeDistance(
    weights: vec4<f32>,
    nearDepthRange: vec4<f32>,
    farDepthRange: vec4<f32>
) -> vec2<f32> {
    let near: f32 = dot(weights, nearDepthRange);
    let far: f32 = dot(weights, farDepthRange);
    return vec2<f32>(near, far);
}
