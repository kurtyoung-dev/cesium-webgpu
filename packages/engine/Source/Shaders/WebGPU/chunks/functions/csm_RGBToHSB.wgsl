/**
 * Converts an RGB color to HSB (Hue, Saturation, Brightness).
 *
 * @chunk functions/csm_RGBToHSB
 * @param {vec3<f32>} rgb The RGB color.
 * @returns {vec3<f32>} The HSB color: hue in [0,1], saturation in [0,1], brightness in [0,1].
 */
fn csm_RGBToHSB(rgb: vec3<f32>) -> vec3<f32> {
    let cmax = max(rgb.r, max(rgb.g, rgb.b));
    let cmin = min(rgb.r, min(rgb.g, rgb.b));
    let V = cmax;
    let delta = cmax - cmin;

    var S: f32 = 0.0;
    var H: f32 = 0.0;

    if (cmax > 0.0) {
        S = delta / cmax;
    }

    if (delta > 0.0) {
        if (rgb.r >= cmax) {
            H = (rgb.g - rgb.b) / delta;
        } else if (rgb.g >= cmax) {
            H = 2.0 + (rgb.b - rgb.r) / delta;
        } else {
            H = 4.0 + (rgb.r - rgb.g) / delta;
        }
        H = H / 6.0;
        if (H < 0.0) {
            H = H + 1.0;
        }
    }

    return vec3<f32>(H, S, V);
}
