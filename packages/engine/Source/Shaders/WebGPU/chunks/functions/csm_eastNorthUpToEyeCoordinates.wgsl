/**
 * Computes an ENU rotation matrix from position in eye coords + normal.
 * Port of czm_eastNorthUpToEyeCoordinates.
 * @chunk functions/csm_eastNorthUpToEyeCoordinates
 */
fn csm_eastNorthUpToEyeCoordinates(positionEC: vec3<f32>, normalEC: vec3<f32>) -> mat3x3<f32> {
    var tangentEC: vec3<f32> = normalize(vec3<f32>(-positionEC.y, positionEC.x, 0.0));
    let t: f32 = abs(normalEC.x) + abs(normalEC.y);
    if (t < 0.0001) {
        tangentEC = vec3<f32>(1.0, 0.0, 0.0);
    }
    let bitangentEC: vec3<f32> = normalize(cross(normalEC, tangentEC));
    tangentEC = normalize(cross(bitangentEC, normalEC));
    return mat3x3<f32>(tangentEC, bitangentEC, normalEC);
}
