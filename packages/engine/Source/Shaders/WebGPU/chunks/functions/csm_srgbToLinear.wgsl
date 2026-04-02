/**
 * Convert an sRGB color to linear RGB.
 *
 * @chunk functions/csm_srgbToLinear
 */
fn csm_srgbToLinear(srgb: vec3<f32>) -> vec3<f32> {
    return pow(srgb, vec3<f32>(2.2));
}

fn csm_srgbToLinear_v4(srgba: vec4<f32>) -> vec4<f32> {
    return vec4<f32>(pow(srgba.rgb, vec3<f32>(2.2)), srgba.a);
}
