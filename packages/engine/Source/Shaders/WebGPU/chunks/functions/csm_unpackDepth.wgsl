/**
 * Unpack a depth value from an RGBA color.
 *
 * @chunk functions/csm_unpackDepth
 */
fn csm_unpackDepth(packedDepth: vec4<f32>) -> f32 {
    return dot(packedDepth, vec4<f32>(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0));
}
