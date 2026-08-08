/**
 * Converts an HSB (Hue, Saturation, Brightness) color to RGB.
 *
 * Port of this project's GLSL builtin czm_HSBToRGB, which credits
 * {@link http://lolengine.net/blog/2013/07/27/rgb-to-hsv-in-glsl} for the
 * branch-free hue reconstruction used here.
 *
 * @chunk functions/csm_HSBToRGB
 * @param {vec3<f32>} hsb Hue in [0,1], Saturation in [0,1], Brightness in [0,1].
 * @returns {vec3<f32>} The RGB color.
 */
fn csm_HSBToRGB(hsb: vec3<f32>) -> vec3<f32> {
    let rgb = clamp(
        abs(((hsb.x * 6.0 + vec3<f32>(0.0, 4.0, 2.0)) % vec3<f32>(6.0)) - vec3<f32>(3.0)) - vec3<f32>(1.0),
        vec3<f32>(0.0),
        vec3<f32>(1.0)
    );
    return hsb.z * mix(vec3<f32>(1.0), rgb, hsb.y);
}
