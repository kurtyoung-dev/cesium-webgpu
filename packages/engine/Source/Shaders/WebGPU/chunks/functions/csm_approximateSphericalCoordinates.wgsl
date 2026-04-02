/**
 * Convert a normal to approximate spherical coordinates.
 *
 * @chunk functions/csm_approximateSphericalCoordinates
 */
fn csm_approximateSphericalCoordinates(normal: vec3<f32>) -> vec2<f32> {
    let latitudeApproximation = acos(normal.z);
    let longitudeApproximation = atan2(normal.y, normal.x);
    return vec2<f32>(latitudeApproximation, longitudeApproximation);
}
