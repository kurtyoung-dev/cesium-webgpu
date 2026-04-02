/**
 * Computes ground atmosphere scattering. Port of czm_computeGroundAtmosphereScattering.
 * @chunk functions/csm_computeGroundAtmosphereScattering
 */
fn csm_computeGroundAtmosphereScattering(
    positionWC: vec3<f32>,
    lightDir: vec3<f32>,
    cameraPositionWC: vec3<f32>,
    rayleighColor: vec3<f32>,
    mieColor: vec3<f32>
) -> vec3<f32> {
    let viewDir: vec3<f32> = normalize(positionWC - cameraPositionWC);
    let cosAngle: f32 = dot(viewDir, lightDir);

    // Rayleigh phase
    let rayleighPhase: f32 = 0.75 * (1.0 + cosAngle * cosAngle);

    // Mie phase (Henyey-Greenstein)
    let g: f32 = 0.8;
    let g2: f32 = g * g;
    let miePhase: f32 = (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * cosAngle, 1.5) * (0.25 / 3.14159265359);

    return rayleighColor * rayleighPhase + mieColor * miePhase;
}
