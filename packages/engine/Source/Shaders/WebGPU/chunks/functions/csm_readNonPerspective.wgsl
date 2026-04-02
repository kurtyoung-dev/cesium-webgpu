/**
 * Reads a value corrected from non-perspective interpolation.
 * Port of czm_readNonPerspective.
 * @chunk functions/csm_readNonPerspective
 */
fn csm_readNonPerspective(value: f32, oneOverW: f32) -> f32 {
    return value * oneOverW;
}

fn csm_readNonPerspectiveVec2(value: vec2<f32>, oneOverW: f32) -> vec2<f32> {
    return value * oneOverW;
}

fn csm_readNonPerspectiveVec3(value: vec3<f32>, oneOverW: f32) -> vec3<f32> {
    return value * oneOverW;
}

fn csm_readNonPerspectiveVec4(value: vec4<f32>, oneOverW: f32) -> vec4<f32> {
    return value * oneOverW;
}
