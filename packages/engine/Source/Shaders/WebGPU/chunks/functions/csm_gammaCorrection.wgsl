/**
 * Gamma correction and color space conversion utilities
 * 
 * @chunk functions/csm_gammaCorrection
 */

// Convert from linear to sRGB (gamma encode)
fn csm_linearToSrgb(color: vec3<f32>) -> vec3<f32> {
    return pow(color, vec3<f32>(1.0 / 2.2));
}

// Convert from sRGB to linear (gamma decode)
fn csm_srgbToLinear(color: vec3<f32>) -> vec3<f32> {
    return pow(color, vec3<f32>(2.2));
}

// More accurate sRGB encode (per-channel)
fn csm_linearToSrgbAccurate(color: vec3<f32>) -> vec3<f32> {
    let cutoff = vec3<f32>(0.0031308);
    let low = color * 12.92;
    let high = 1.055 * pow(color, vec3<f32>(1.0 / 2.4)) - 0.055;
    return select(high, low, color <= cutoff);
}

// More accurate sRGB decode (per-channel)
fn csm_srgbToLinearAccurate(color: vec3<f32>) -> vec3<f32> {
    let cutoff = vec3<f32>(0.04045);
    let low = color / 12.92;
    let high = pow((color + 0.055) / 1.055, vec3<f32>(2.4));
    return select(high, low, color <= cutoff);
}
