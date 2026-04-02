/**
 * Tests if the material intersection interval is empty. Port of czm_isEmpty.
 * @chunk functions/csm_isEmpty
 */
fn csm_isEmpty(interval: vec4<f32>) -> bool {
    return interval.z > interval.w;
}
