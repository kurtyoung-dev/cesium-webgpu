/**
 * Procedural anti-aliasing by blurring two colors at a sharp edge.
 * Port of czm_antialias from GLSL.
 *
 * @chunk functions/csm_antialias
 */
fn csm_antialias(color1: vec4<f32>, color2: vec4<f32>, currentColor: vec4<f32>, dist: f32, fuzzFactor: f32) -> vec4<f32> {
    let val1: f32 = clamp(dist / fuzzFactor, 0.0, 1.0);
    let val2: f32 = clamp((dist - 0.5) / fuzzFactor, 0.0, 1.0);
    let val3: f32 = val1 * (1.0 - val2);
    return mix(currentColor, mix(color1, color2, val2), val3);
}

fn csm_antialiasDefault(color1: vec4<f32>, color2: vec4<f32>, currentColor: vec4<f32>, dist: f32) -> vec4<f32> {
    return csm_antialias(color1, color2, currentColor, dist, 0.1);
}
