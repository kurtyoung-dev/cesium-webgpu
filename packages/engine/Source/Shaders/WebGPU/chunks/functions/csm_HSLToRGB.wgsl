/**
 * Converts HSL to RGB color space. Port of czm_HSLToRGB.
 * @chunk functions/csm_HSLToRGB
 */
fn csm_hslHue2rgb(p: f32, q: f32, t_in: f32) -> f32 {
    var t: f32 = t_in;
    if (t < 0.0) { t = t + 1.0; }
    if (t > 1.0) { t = t - 1.0; }
    if (t < 1.0 / 6.0) { return p + (q - p) * 6.0 * t; }
    if (t < 1.0 / 2.0) { return q; }
    if (t < 2.0 / 3.0) { return p + (q - p) * (2.0 / 3.0 - t) * 6.0; }
    return p;
}

fn csm_HSLToRGB(hsl: vec3<f32>) -> vec3<f32> {
    if (hsl.y == 0.0) {
        return vec3<f32>(hsl.z);
    }
    var q: f32;
    if (hsl.z < 0.5) { q = hsl.z * (1.0 + hsl.y); }
    else { q = hsl.z + hsl.y - hsl.z * hsl.y; }
    let p: f32 = 2.0 * hsl.z - q;
    return vec3<f32>(
        csm_hslHue2rgb(p, q, hsl.x + 1.0 / 3.0),
        csm_hslHue2rgb(p, q, hsl.x),
        csm_hslHue2rgb(p, q, hsl.x - 1.0 / 3.0)
    );
}
