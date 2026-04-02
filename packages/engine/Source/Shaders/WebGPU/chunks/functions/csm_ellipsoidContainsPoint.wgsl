/**
 * Check if an ellipsoid contains a given point.
 *
 * @chunk functions/csm_ellipsoidContainsPoint
 */
fn csm_ellipsoidContainsPoint(ellipsoid: vec3<f32>, point: vec3<f32>) -> bool {
    let scaled = point / ellipsoid;
    return dot(scaled, scaled) <= 1.0;
}
