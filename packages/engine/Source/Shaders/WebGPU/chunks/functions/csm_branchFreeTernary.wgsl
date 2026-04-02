/**
 * Branch-free ternary for GPU-friendly conditional selection.
 * Avoids divergent execution paths.
 *
 * @chunk functions/csm_branchFreeTernary
 */
fn csm_branchFreeTernary_f32(comparison: bool, a: f32, b: f32) -> f32 {
    let useA = f32(comparison);
    return a * useA + b * (1.0 - useA);
}

fn csm_branchFreeTernary_vec2(comparison: bool, a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
    let useA = f32(comparison);
    return a * useA + b * (1.0 - useA);
}

fn csm_branchFreeTernary_vec3(comparison: bool, a: vec3<f32>, b: vec3<f32>) -> vec3<f32> {
    let useA = f32(comparison);
    return a * useA + b * (1.0 - useA);
}

fn csm_branchFreeTernary_vec4(comparison: bool, a: vec4<f32>, b: vec4<f32>) -> vec4<f32> {
    let useA = f32(comparison);
    return a * useA + b * (1.0 - useA);
}
