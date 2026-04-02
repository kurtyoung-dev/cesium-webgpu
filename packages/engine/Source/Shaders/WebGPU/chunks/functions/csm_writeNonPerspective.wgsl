/**
 * Writes a value prepared for non-perspective interpolation.
 * Port of czm_writeNonPerspective.
 * @chunk functions/csm_writeNonPerspective
 */
fn csm_writeNonPerspective(value: f32, w: f32) -> f32 {
    return value / w;
}

fn csm_writeNonPerspectiveVec2(value: vec2<f32>, w: f32) -> vec2<f32> {
    return value / w;
}

fn csm_writeNonPerspectiveVec3(value: vec3<f32>, w: f32) -> vec3<f32> {
    return value / w;
}

fn csm_writeNonPerspectiveVec4(value: vec4<f32>, w: f32) -> vec4<f32> {
    return value / w;
}
