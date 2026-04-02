/**
 * Computes the luminance of a color.
 * Algorithm from Chapter 10 of Graphics Shaders.
 *
 * @chunk functions/csm_luminance
 * @param {vec3<f32>} rgb The color.
 * @returns {f32} The luminance.
 */
fn csm_luminance(rgb: vec3<f32>) -> f32 {
    let W = vec3<f32>(0.2125, 0.7154, 0.0721);
    return dot(rgb, W);
}
