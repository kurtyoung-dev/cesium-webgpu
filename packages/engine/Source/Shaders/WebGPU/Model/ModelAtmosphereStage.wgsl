/**
 * Applies atmosphere effects (fog, scattering) to model fragments.
 * Port of AtmosphereStageFS.glsl.
 */

fn csm_modelAtmosphereApplyFog(
    baseColor: vec4<f32>,
    positionWC: vec3<f32>,
    lightDir: vec3<f32>,
    cameraPositionWC: vec3<f32>,
    atmosphereRayleighColor: vec3<f32>,
    atmosphereMieColor: vec3<f32>,
    innerRadius: f32,
    fogDensity: f32
) -> vec4<f32> {
    let distance: f32 = length(positionWC - cameraPositionWC);
    let altitude: f32 = length(positionWC) - innerRadius;
    let atmosphereThickness: f32 = 111000.0;

    // Fade atmosphere based on distance from ellipsoid
    let fadeFactor: f32 = clamp(altitude / atmosphereThickness, 0.0, 1.0);

    // Fog based on distance
    let fogAmount: f32 = 1.0 - exp(-distance * fogDensity);

    // Compute in-scatter color from atmosphere
    let viewDir: vec3<f32> = normalize(positionWC - cameraPositionWC);
    let cosAngle: f32 = dot(viewDir, lightDir);
    let rayleighPhase: f32 = 0.75 * (1.0 + cosAngle * cosAngle);
    let g: f32 = 0.8;
    let g2: f32 = g * g;
    let miePhase: f32 = (1.0 - g2) / (4.0 * 3.14159265359 * pow(1.0 + g2 - 2.0 * g * cosAngle, 1.5));

    let atmosphereColor: vec3<f32> = atmosphereRayleighColor * rayleighPhase +
                                      atmosphereMieColor * miePhase;

    // Blend atmosphere with base color
    var result: vec3<f32> = mix(baseColor.rgb, atmosphereColor, fogAmount * (1.0 - fadeFactor));
    return vec4<f32>(result, baseColor.a);
}
