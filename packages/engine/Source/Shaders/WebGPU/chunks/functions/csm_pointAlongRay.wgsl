/**
 * Compute a point along a ray at a given distance.
 *
 * @chunk functions/csm_pointAlongRay
 */
fn csm_pointAlongRay(origin: vec3<f32>, direction: vec3<f32>, time: f32) -> vec3<f32> {
    return origin + direction * time;
}
