/**
 * Compute the signed distance from a point to a plane.
 * Plane is defined as (normal.xyz, distance).
 *
 * @chunk functions/csm_planeDistance
 */
fn csm_planeDistance_vec4(plane: vec4<f32>, point: vec3<f32>) -> f32 {
    return dot(plane.xyz, point) + plane.w;
}

fn csm_planeDistance_nd(normal: vec3<f32>, d: f32, point: vec3<f32>) -> f32 {
    return dot(normal, point) + d;
}
