/**
 * Computes distance attenuation for point/spot lights. Port of czm_computeAttenuation.
 * @chunk functions/csm_computeAttenuation
 */
fn csm_computeAttenuation(lightRange: f32, distance: f32) -> f32 {
    if (lightRange <= 0.0) {
        // Unlimited range, inverse-square falloff
        return 1.0 / max(distance * distance, 0.01 * 0.01);
    }
    // Smooth attenuation within range
    let distOverRange: f32 = distance / lightRange;
    let distOverRange4: f32 = distOverRange * distOverRange * distOverRange * distOverRange;
    let attenuation: f32 = max(min(1.0 - distOverRange4, 1.0), 0.0);
    return attenuation * attenuation / max(distance * distance, 0.01 * 0.01);
}
