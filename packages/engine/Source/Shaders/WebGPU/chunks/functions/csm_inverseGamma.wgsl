/**
 * Converts linear RGB to sRGB (inverse gamma). Port of czm_inverseGamma.
 * @chunk functions/csm_inverseGamma
 */
fn csm_inverseGamma(linearColor: vec3<f32>) -> vec3<f32> {
    return pow(linearColor, vec3<f32>(1.0 / 2.2));
}
