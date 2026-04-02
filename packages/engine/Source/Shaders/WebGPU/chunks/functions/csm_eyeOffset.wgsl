/**
 * Computes an eye-space offset for billboards/labels. Port of czm_eyeOffset.
 * @chunk functions/csm_eyeOffset
 */
fn csm_eyeOffset(positionEC: vec4<f32>, eyeOff: vec3<f32>) -> vec4<f32> {
    var p: vec4<f32> = positionEC;
    let zEyeOffset: vec4<f32> = normalize(p) * eyeOff.z;
    p.x = p.x + eyeOff.x + zEyeOffset.x;
    p.y = p.y + eyeOff.y + zEyeOffset.y;
    p.z = p.z + zEyeOffset.z;
    return p;
}
