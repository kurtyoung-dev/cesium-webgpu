/**
 * Convert RGB to CIE XYZ color space.
 *
 * @chunk functions/csm_RGBToXYZ
 */
fn csm_RGBToXYZ(rgb: vec3<f32>) -> vec3<f32> {
    let M = mat3x3<f32>(
        0.4124, 0.3576, 0.1805,
        0.2126, 0.7152, 0.0722,
        0.0193, 0.1192, 0.9505
    );
    return M * rgb;
}
