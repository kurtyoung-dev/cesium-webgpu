/**
 * Compute cascade shadow map weights based on eye-space depth.
 * Each cascade has a near/far distance; the weight selects which cascade to sample.
 *
 * @chunk functions/csm_cascadeWeights
 */
fn csm_cascadeWeights(depthEC: f32, cascadeDistances: vec4<f32>) -> vec4<f32> {
    // cascadeDistances.xyzw = far distance for cascades 0-3
    var weights = vec4<f32>(0.0);
    if (depthEC < cascadeDistances.x) {
        weights.x = 1.0;
    } else if (depthEC < cascadeDistances.y) {
        weights.y = 1.0;
    } else if (depthEC < cascadeDistances.z) {
        weights.z = 1.0;
    } else {
        weights.w = 1.0;
    }
    return weights;
}
