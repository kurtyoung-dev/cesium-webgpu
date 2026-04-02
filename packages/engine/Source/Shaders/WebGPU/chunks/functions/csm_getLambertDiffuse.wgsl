/**
 * Computes Lambert diffuse lighting. Port of czm_getLambertDiffuse.
 * @chunk functions/csm_getLambertDiffuse
 */
fn csm_getLambertDiffuse(lightDirectionEC: vec3<f32>, normalEC: vec3<f32>) -> f32 {
    return max(dot(normalEC, lightDirectionEC), 0.0);
}
