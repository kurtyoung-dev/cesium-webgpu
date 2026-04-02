/**
 * Applies fog to a color based on distance.
 *
 * @chunk functions/csm_fog
 * @param {vec3<f32>} lightColor The light/atmosphere color for fog.
 * @param {vec3<f32>} color The original color.
 * @param {f32} distance The distance from the camera.
 * @returns {vec3<f32>} The fogged color.
 */
fn csm_fog(lightColor: vec3<f32>, color: vec3<f32>, distance: f32) -> vec3<f32> {
    let scalar = distance / 80000.0; // ~80km visibility
    let fogAmount = 1.0 - exp(-(scalar * scalar));
    return mix(color, lightColor, fogAmount);
}
