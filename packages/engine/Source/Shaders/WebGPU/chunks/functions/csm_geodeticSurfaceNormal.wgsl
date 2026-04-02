/**
 * Computes the geodetic surface normal for a position on an ellipsoid.
 * Port of czm_geodeticSurfaceNormal.
 * @chunk functions/csm_geodeticSurfaceNormal
 */
fn csm_geodeticSurfaceNormal(positionWC: vec3<f32>, oneOverRadiiSquared: vec3<f32>) -> vec3<f32> {
    return normalize(positionWC * oneOverRadiiSquared);
}
