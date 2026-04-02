/**
 * Debug visualization for cascade shadow maps.
 * Maps cascade weights to RGBM debug colors.
 *
 * @chunk functions/csm_cascadeColor
 */
fn csm_cascadeColor(weights: vec4<f32>) -> vec4<f32> {
    return vec4<f32>(1.0, 0.0, 0.0, 1.0) * weights.x +
           vec4<f32>(0.0, 1.0, 0.0, 1.0) * weights.y +
           vec4<f32>(0.0, 0.0, 1.0, 1.0) * weights.z +
           vec4<f32>(1.0, 0.0, 1.0, 1.0) * weights.w;
}
