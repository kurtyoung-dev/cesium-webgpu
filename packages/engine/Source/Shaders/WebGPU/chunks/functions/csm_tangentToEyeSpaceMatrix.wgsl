/**
 * Build a TBN matrix to transform from tangent space to eye space.
 *
 * @chunk functions/csm_tangentToEyeSpaceMatrix
 */
fn csm_tangentToEyeSpaceMatrix(normalEC: vec3<f32>, tangentEC: vec3<f32>, bitangentEC: vec3<f32>) -> mat3x3<f32> {
    return mat3x3<f32>(tangentEC, bitangentEC, normalEC);
}
