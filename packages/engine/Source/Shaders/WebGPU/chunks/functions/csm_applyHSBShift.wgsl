/**
 * Attempt to apply an HSB shift to an RGB color. Port of czm_applyHSBShift.
 *
 * @chunk functions/csm_applyHSBShift
 */
fn csm_applyHSBShift(rgb: vec3<f32>, hsb_shift: vec3<f32>) -> vec3<f32> {
    // Skip if no shift
    if (hsb_shift.x == 0.0 && hsb_shift.y == 0.0 && hsb_shift.z == 0.0) {
        return rgb;
    }

    // RGB to HSB
    let cmax: f32 = max(rgb.r, max(rgb.g, rgb.b));
    let cmin: f32 = min(rgb.r, min(rgb.g, rgb.b));
    let delta: f32 = cmax - cmin;

    var hue: f32 = 0.0;
    if (delta != 0.0) {
        if (rgb.r == cmax) {
            hue = (rgb.g - rgb.b) / delta;
        } else if (rgb.g == cmax) {
            hue = 2.0 + (rgb.b - rgb.r) / delta;
        } else {
            hue = 4.0 + (rgb.r - rgb.g) / delta;
        }
        hue = hue / 6.0;
        if (hue < 0.0) { hue = hue + 1.0; }
    }

    var sat: f32 = 0.0;
    if (cmax != 0.0) { sat = delta / cmax; }
    let bright: f32 = cmax;

    // Apply shift
    hue = fract(hue + hsb_shift.x);
    sat = clamp(sat + hsb_shift.y, 0.0, 1.0);
    let b: f32 = clamp(bright + hsb_shift.z, 0.0, 1.0);

    // HSB back to RGB
    let h6: f32 = hue * 6.0;
    let sector: i32 = i32(floor(h6));
    let f: f32 = h6 - f32(sector);
    let p: f32 = b * (1.0 - sat);
    let q: f32 = b * (1.0 - sat * f);
    let t: f32 = b * (1.0 - sat * (1.0 - f));

    switch (sector % 6) {
        case 0: { return vec3<f32>(b, t, p); }
        case 1: { return vec3<f32>(q, b, p); }
        case 2: { return vec3<f32>(p, b, t); }
        case 3: { return vec3<f32>(p, q, b); }
        case 4: { return vec3<f32>(t, p, b); }
        case 5: { return vec3<f32>(b, p, q); }
        default: { return vec3<f32>(b, t, p); }
    }
}
