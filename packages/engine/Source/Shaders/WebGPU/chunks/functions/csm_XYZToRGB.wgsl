/**
 * Convert CIE XYZ to RGB color space.
 *
 * @chunk functions/csm_XYZToRGB
 */
fn csm_XYZToRGB(xyz: vec3<f32>) -> vec3<f32> {
    let M = mat3x3<f32>(
         3.2406, -1.5372, -0.4986,
        -0.9689,  1.8758,  0.0415,
         0.0557, -0.2040,  1.0570
    );
    return M * xyz;
}
