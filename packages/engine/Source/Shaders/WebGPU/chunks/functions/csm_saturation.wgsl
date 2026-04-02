/**
 * Adjusts the saturation of a color.
 * Algorithm from Chapter 16 of OpenGL Shading Language.
 *
 * @chunk functions/csm_saturation
 * @param {vec3<f32>} rgb The color.
 * @param {f32} adjustment The saturation adjustment factor.
 * @returns {vec3<f32>} The color with adjusted saturation.
 */
fn csm_saturation(rgb: vec3<f32>, adjustment: f32) -> vec3<f32> {
    let W = vec3<f32>(0.2125, 0.7154, 0.0721);
    let intensity = vec3<f32>(dot(rgb, W));
    return mix(intensity, rgb, adjustment);
}
