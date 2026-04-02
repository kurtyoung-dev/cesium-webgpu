/**
 * Transform a plane by a 4x4 matrix.
 * The plane is encoded as (normal.xyz, distance) in a vec4.
 *
 * @chunk functions/csm_transformPlane
 */
fn csm_transformPlane(plane: vec4<f32>, transform: mat4x4<f32>) -> vec4<f32> {
    let inverseTranspose = transpose(transform);
    return inverseTranspose * plane;
}
