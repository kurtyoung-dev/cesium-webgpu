/**
 * Unpack a float value from a packed vec4 representation.
 * Matches czm_unpackFloat encoding: value = (r*256 + g + b/256 + a/65536 - 128) * 0.01
 *
 * @chunk functions/csm_unpackFloat
 */
fn csm_unpackFloat(packedFloat: vec4<f32>) -> f32 {
    let v = packedFloat * 255.0;
    return (v.x * 256.0 + v.y + v.z / 256.0 + v.w / 65536.0 - 32768.0) * 0.01;
}
