/**
 * Adjusts the hue of an RGB color. Port of czm_hue.
 * @chunk functions/csm_hue
 */
fn csm_hue(rgb: vec3<f32>, adjustment: f32) -> vec3<f32> {
    let toYIQ: mat3x3<f32> = mat3x3<f32>(
        vec3<f32>(0.299, 0.587, 0.114),
        vec3<f32>(0.595716, -0.274453, -0.321263),
        vec3<f32>(0.211456, -0.522591, 0.311135)
    );
    let toRGB: mat3x3<f32> = mat3x3<f32>(
        vec3<f32>(1.0, 0.9563, 0.6210),
        vec3<f32>(1.0, -0.2721, -0.6474),
        vec3<f32>(1.0, -1.107, 1.7046)
    );
    let yiq: vec3<f32> = toYIQ * rgb;
    let h: f32 = atan2(yiq.z, yiq.y) + adjustment;
    let chroma: f32 = sqrt(yiq.z * yiq.z + yiq.y * yiq.y);
    return toRGB * vec3<f32>(yiq.x, chroma * cos(h), chroma * sin(h));
}
