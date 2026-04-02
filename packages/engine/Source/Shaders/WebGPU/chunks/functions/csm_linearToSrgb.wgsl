/**
 * Convert a linear RGB color to sRGB.
 *
 * @chunk functions/csm_linearToSrgb
 */
fn csm_linearToSrgb(linear: vec3<f32>) -> vec3<f32> {
    return pow(linear, vec3<f32>(1.0 / 2.2));
}

fn csm_linearToSrgb_v4(linear: vec4<f32>) -> vec4<f32> {
    return vec4<f32>(pow(linear.rgb, vec3<f32>(1.0 / 2.2)), linear.a);
}
