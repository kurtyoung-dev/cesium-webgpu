/**
 * Select the appropriate shadow matrix for a given cascade weight.
 *
 * @chunk functions/csm_cascadeMatrix
 */
fn csm_cascadeMatrix(
    weights: vec4<f32>,
    shadowMapMatrix0: mat4x4<f32>,
    shadowMapMatrix1: mat4x4<f32>,
    shadowMapMatrix2: mat4x4<f32>,
    shadowMapMatrix3: mat4x4<f32>
) -> mat4x4<f32> {
    return shadowMapMatrix0 * weights.x +
           shadowMapMatrix1 * weights.y +
           shadowMapMatrix2 * weights.z +
           shadowMapMatrix3 * weights.w;
}
