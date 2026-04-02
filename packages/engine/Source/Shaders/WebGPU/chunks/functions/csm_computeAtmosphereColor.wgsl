/**
 * Computes the atmosphere color from scattering. Port of czm_computeAtmosphereColor.
 * @chunk functions/csm_computeAtmosphereColor
 */
fn csm_henyeyGreenstein(cosAngle: f32, g: f32) -> f32 {
    let g2: f32 = g * g;
    return (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * cosAngle, 1.5) * (0.25 / 3.14159265359);
}

fn csm_computeAtmosphereColor(
    rayOrigin: vec3<f32>,
    rayDir: vec3<f32>,
    lightDir: vec3<f32>,
    rayleighColor: vec3<f32>,
    mieColor: vec3<f32>,
    opacity: f32
) -> vec4<f32> {
    let cosAngle: f32 = dot(rayDir, lightDir);

    // Rayleigh phase function
    let rayleighPhase: f32 = 3.0 / (16.0 * 3.14159265359) * (1.0 + cosAngle * cosAngle);

    // Mie phase function (Henyey-Greenstein)
    let miePhase: f32 = csm_henyeyGreenstein(cosAngle, 0.8);

    let color: vec3<f32> = rayleighColor * rayleighPhase + mieColor * miePhase;
    return vec4<f32>(color, opacity);
}
