/**
 * Determines if the fragment is back facing. Port of czm_backFacing.
 *
 * @chunk functions/csm_backFacing
 */
fn csm_backFacing(normalEC: vec3<f32>) -> bool {
    // In eye coordinates, back faces have normals pointing away from the camera.
    return dot(normalEC, vec3<f32>(0.0, 0.0, 1.0)) < 0.0;
}
