/**
 * Computes the dynamic light direction for atmosphere effects.
 * Matches czm_getDynamicAtmosphereLightDirection.
 * @chunk functions/csm_getDynamicAtmosphereLightDirection
 */
fn csm_getDynamicAtmosphereLightDirection(positionWC: vec3<f32>, lightDirectionWC: vec3<f32>) -> vec3<f32> {
    // Use the sun direction as the light direction for atmosphere calculations.
    // When below horizon, still use sun direction for ground-up scattering.
    let normalizedPos: vec3<f32> = normalize(positionWC);
    let cosAngle: f32 = dot(normalizedPos, lightDirectionWC);
    // Always return the light direction (scene-level uniform handles day/night)
    return lightDirectionWC;
}
