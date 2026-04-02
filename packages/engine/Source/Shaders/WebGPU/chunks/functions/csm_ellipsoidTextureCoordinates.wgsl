/**
 * Computes texture coordinates for a position on an ellipsoid.
 * Port of czm_ellipsoidTextureCoordinates.
 * @chunk functions/csm_ellipsoidTextureCoordinates
 */
fn csm_ellipsoidTextureCoordinates(normal: vec3<f32>) -> vec2<f32> {
    return vec2<f32>(
        atan2(normal.y, normal.x) * (0.5 / 3.14159265359) + 0.5,
        asin(normal.z) * (1.0 / 3.14159265359) + 0.5
    );
}
