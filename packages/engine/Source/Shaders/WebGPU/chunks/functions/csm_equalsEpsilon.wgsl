/**
 * Compares two floats with an epsilon tolerance. Port of czm_equalsEpsilon.
 * @chunk functions/csm_equalsEpsilon
 */
fn csm_equalsEpsilon(left: f32, right: f32, epsilon: f32) -> bool {
    return abs(left - right) <= epsilon;
}

fn csm_equalsEpsilonVec2(left: vec2<f32>, right: vec2<f32>, epsilon: f32) -> bool {
    return csm_equalsEpsilon(left.x, right.x, epsilon) &&
           csm_equalsEpsilon(left.y, right.y, epsilon);
}

fn csm_equalsEpsilonVec3(left: vec3<f32>, right: vec3<f32>, epsilon: f32) -> bool {
    return csm_equalsEpsilon(left.x, right.x, epsilon) &&
           csm_equalsEpsilon(left.y, right.y, epsilon) &&
           csm_equalsEpsilon(left.z, right.z, epsilon);
}

fn csm_equalsEpsilonVec4(left: vec4<f32>, right: vec4<f32>, epsilon: f32) -> bool {
    return csm_equalsEpsilon(left.x, right.x, epsilon) &&
           csm_equalsEpsilon(left.y, right.y, epsilon) &&
           csm_equalsEpsilon(left.z, right.z, epsilon) &&
           csm_equalsEpsilon(left.w, right.w, epsilon);
}
