/**
 * Tests if the material intersection interval is full. Port of czm_isFull.
 * @chunk functions/csm_isFull
 */
fn csm_isFull(interval: vec4<f32>) -> bool {
    return interval.x == 0.0 && interval.y == 0.0 && interval.z == 0.0 && interval.w == 0.0;
}
